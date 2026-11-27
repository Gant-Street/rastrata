/** Posting the Inbox's drafts, and taking decisions back.
 *
 * `inbox.post` is the only thing in the pipeline that touches the ledger, and it does so the way
 * every entry is posted: the saved draft is prepared (which seals the exact command under a durable
 * identity and previews its effects) and then committed with the plan hash that was reviewed. Three
 * things make it safe to run again after any interruption, and beside other writers:
 *
 * - The identity of a posting is derived from its draft (`ingest.post` + draft id + version), never
 *   invented per call, so a retry finds the retained operation and resumes it: a committed posting
 *   is recognised and not repeated, a rejected one stays rejected, an uncertain one is committed
 *   again under the same identity (the ledger answers a repeated command with its first outcome).
 * - The ledger itself refuses a second journal for the same source identity
 *   (`ingest-<provider>-<hash>`), so even a bug here could not post a line twice.
 * - A refusal that says only that the book moved on after the entry was evaluated
 *   (`stale_book_revision`, see `OUTRUN_BY_THE_BOOK`) is not a verdict on the entry. The ledger
 *   keeps it against that posting's identity for good, so the draft is reopened (its version moves,
 *   and with it the identity) and the entry is evaluated again against the book as it is, a few
 *   times in one call.
 *   Refusals about the entry itself stay refusals, with the ledger's words. Postings of one book
 *   take turns to prepare and commit, so the Inbox's own clients do not make each other's plans
 *   stale; a write from anywhere else still can, and is met the same way.
 *
 * A call works for a bounded time and number of items and says how many remain. A selection by
 * filter leaves alone the lines an earlier attempt failed on in a way that will not change until the
 * books do (see `forgetFailuresThatMayHavePassed`), and says so; a selection by ids tries them again. */
import { ApplicationError } from "../../errors.ts";
import type {
  InboxActionReport,
  InboxActionResult,
  InboxPostInput,
  InboxRefreshReport,
  InboxRestoreInput,
} from "../../client-contracts.gen.ts";
import type { SavedDraft } from "../../contracts.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { ensureProposals, invalidateNeighbours, invalidateProposals } from "./proposing.ts";
import { syncCovered } from "./covers.ts";
import {
  MAX_LIMIT,
  type Resolved,
  failed,
  report,
  resolveSelection,
  skipped,
} from "./selection.ts";
import { type IngestRuntime, type ItemRow, ingestRuntime, recordEvent, rowById } from "./store.ts";

const POST_LIMIT = 25;
/** How many times one call evaluates and commits a line whose plan the book outran. */
const POST_ATTEMPTS = 4;
/** What the kernel says of a command made for a book that has since moved. An entry is stamped with
 * the book's revision and the time it was sealed. A write that lands after that is a different
 * revision (`stale_book_revision`), and if it was sealed later than this entry it is also a commit
 * time the entry's own time is before (`temporal_semantics_violation`, which is checked first). The
 * Inbox stamps all three of a command's times with one instant, so for its commands that is the
 * only way to meet the second. */
const OUTRUN_BY_THE_BOOK = new Set(["stale_book_revision", "temporal_semantics_violation"]);

/** Record that the draft's journal exists: every line sharing the draft (a transfer's two sides)
 * becomes posted with the journal and the identity it was posted under. */
function markPosted(
  store: ApplicationStore,
  now: string,
  draftId: string,
  journalId: string,
  operationId: string | null,
  by: string,
): void {
  // The lines that are decided themselves: the line, and the other side of a transfer. Lines a
  // payout books follow it below.
  const rows = store
    .query(
      "SELECT id, kind, amount, posted_on FROM app_ingest_items WHERE draft_id=? AND status='drafted' AND covered_by IS NULL",
    )
    .all(draftId) as { id: string; kind: string; amount: string; posted_on: string }[];
  for (const row of rows) {
    store
      .query(
        "UPDATE app_ingest_items SET status='posted', journal_id=?, post_operation_id=?, post_error=NULL, post_error_code=NULL WHERE id=?",
      )
      .run(journalId, operationId, row.id);
    recordEvent(store, row.id, now, "post", by, { draftId, journalId });
    if (row.kind === "event") {
      const posted = rowById(store, row.id);
      if (posted) syncCovered(store, now, posted);
    }
  }
  invalidateNeighbours(store, rows);
}

/** Remember why a line's last posting failed, for whoever looks at the line. `lasting` is the code of
 * a failure that trying again will not change (a post by filter then leaves the line alone); it is
 * null for one that may pass by itself. */
const noteFailure = (
  store: ApplicationStore,
  id: string,
  message: string,
  lasting: string | null = null,
): void => {
  store
    .query(
      "UPDATE app_ingest_items SET post_error=?, post_error_code=? WHERE id=? AND status='drafted'",
    )
    .run(sanitizeText(message, 500), lasting, id);
};

const problemText = (problems: readonly { code: string; message: string }[], fallback: string) =>
  problems.length > 0 ? problems.map((problem) => problem.message).join("; ") : fallback;

/** Whether a refusal says only that the book moved on after the entry was evaluated. */
const staleOnly = (problems: readonly { code: string }[] | undefined): boolean =>
  problems !== undefined &&
  problems.length > 0 &&
  problems.every((problem) => OUTRUN_BY_THE_BOOK.has(problem.code));

/** Failures of the service that pass when the call is made again: the book or the draft moved under
 * the posting. Every other failure of the service stands until someone does something about it. */
const PASSES_BY_ITSELF = new Set([
  "read_conflict",
  "source_claim_conflict",
  "draft_version_conflict",
]);

/** The identity a draft's posting has: its draft and version, so a retry finds what it left. */
const postingIdentity = (draft: SavedDraft): string =>
  deriveUuid(["ingest.post", draft.id, String(draft.version)]);

type Prior = Awaited<ReturnType<ApplicationService["operation"]>> | null;

/** What the books hold for a posting identity, or null when it was never prepared. */
async function lookup(service: ApplicationService, operationId: string): Promise<Prior> {
  try {
    return await service.operation(operationId);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "operation_not_found") return null;
    throw error;
  }
}

/** Run `work` when the postings ahead of it have prepared and committed, and not before. */
async function alone<T>(runtime: IngestRuntime, work: () => Promise<T>): Promise<T> {
  const before = runtime.postingTurn;
  let done = () => {};
  runtime.postingTurn = new Promise<void>((resolve) => {
    done = resolve;
  });
  await before;
  try {
    return await work();
  } finally {
    done();
  }
}

/** The lines of a draft keep its version in step, for whoever reads the record. */
const noteVersion = (store: ApplicationStore, draft: SavedDraft): void => {
  store
    .query("UPDATE app_ingest_items SET draft_version=? WHERE draft_id=? AND status='drafted'")
    .run(draft.version, draft.id);
};

/** A posting the ledger refused because the book had moved on: open its draft again. The ledger keeps
 * the refusal against the posting's identity, so the draft gets the next version and with it the next
 * identity; the entry is the same. If another caller already did this, the draft as it is now. */
async function reopen(
  service: ApplicationService,
  store: ApplicationStore,
  draft: SavedDraft,
  refusedId: string,
): Promise<SavedDraft | null> {
  try {
    const reopened = await service.recoverDraft(
      draft.id,
      draft.version,
      refusedId,
      deriveUuid(["ingest.repost", draft.id, String(draft.version)]),
    );
    noteVersion(store, reopened);
    return reopened;
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      (error.code === "draft_version_conflict" || error.code === "draft_recovery_unavailable")
    )
      return service.draft(draft.id);
    throw error;
  }
}

/** A plan that was made and never sent, for a book that has moved on since: it can never commit.
 * The draft gets the next version, and with it a posting identity that has no plan yet. */
function remake(
  service: ApplicationService,
  store: ApplicationStore,
  draft: SavedDraft,
): SavedDraft | null {
  try {
    const saved = service.saveDraft(draft.id, draft.version, draft.data);
    noteVersion(store, saved);
    return saved;
  } catch (error) {
    if (error instanceof Error && /^Draft changed/.test(error.message))
      return service.draft(draft.id);
    throw error;
  }
}

/** Post one drafted line. Never throws for a refused posting: the refusal is the result. `operation` is
 * the operation the commit is recorded under, for the book's record of who changed it; a change of
 * account that posts the new entry says so. */
export async function postOne(
  service: ApplicationService,
  store: ApplicationStore,
  now: string,
  stale: ItemRow,
  principal: string,
  operation = "inbox.post",
): Promise<InboxActionResult & { readonly stop?: boolean }> {
  const row = rowById(store, stale.id);
  if (row?.status !== "drafted" || row.draft_id === null)
    return skipped(
      row ?? stale,
      "wrong_status",
      row?.status === "posted"
        ? "This line was posted together with its transfer pair."
        : "This item is not waiting to be posted.",
    );
  const runtime = ingestRuntime(service);
  /** A refusal of this line: kept on the line, and reported. */
  const refuse = (
    code: string,
    message: string,
    lasting: boolean,
    details?: readonly { path: string; message: string }[],
  ) => {
    noteFailure(store, row.id, message, lasting ? code : null);
    return failed(row, code, message, details);
  };
  const applied = (
    draft: SavedDraft,
    journalId: string,
    operationId: string,
    outcomeSequence: string | null | undefined,
  ): InboxActionResult => {
    markPosted(store, now, draft.id, journalId, operationId, principal);
    return {
      itemId: row.id,
      outcome: "applied",
      status: "posted",
      draftId: draft.id,
      journalId,
      operationId,
      ...(outcomeSequence ? { outcomeSequence } : {}),
    };
  };
  let draft = service.draft(row.draft_id);
  try {
    for (let attempt = 1; ; attempt += 1) {
      if (!draft) {
        noteFailure(
          store,
          row.id,
          "The draft was discarded. Restore the item and categorize it again.",
          "draft_missing",
        );
        return failed(
          row,
          "draft_missing",
          "The draft for this line was discarded. Restore the item and categorize it again.",
        );
      }
      const current: SavedDraft = draft;
      if (current.status === "posted" && current.journalId) {
        markPosted(
          store,
          now,
          current.id,
          current.journalId,
          current.postingOperationId ?? null,
          principal,
        );
        return {
          itemId: row.id,
          outcome: "applied",
          status: "posted",
          draftId: current.id,
          journalId: current.journalId,
          ...(current.postingOperationId ? { operationId: current.postingOperationId } : {}),
          ...(current.outcomeSequence ? { outcomeSequence: current.outcomeSequence } : {}),
        };
      }
      // Whether this was the last evaluation of the line this call will make.
      const lastTry = attempt >= POST_ATTEMPTS;
      const busy = () =>
        refuse(
          "posting_conflict",
          "The books kept changing while this line was being posted (other entries were being written at the same moments), so it was not posted. Nothing was lost: post it again.",
          false,
        );
      const operationId = postingIdentity(current);
      const prior = await lookup(service, operationId);
      if (prior?.disposition === "committed") {
        // A posting that went through and whose answer was lost left its draft in posting. Bring the
        // draft in line with the books: the action is already sent and its outcome known, so this
        // sends nothing.
        if (current.status !== "posted" && prior.planHash)
          await service.commitAction(operationId, prior.planHash, {
            by: principal,
            operation,
          });
        return applied(
          current,
          service.draft(current.id)?.journalId ?? current.journalId ?? "",
          operationId,
          prior.outcomeSequence,
        );
      }
      if (prior?.disposition === "rejected") {
        if (!staleOnly(prior.problems)) {
          const message = problemText(prior.problems ?? [], "The ledger refused this entry.");
          return refuse("posting_rejected", `The ledger refused this entry: ${message}`, true);
        }
        // The book moved on after the entry was evaluated: that says nothing about the entry.
        draft = await reopen(service, store, current, operationId);
        if (lastTry) return busy();
        continue;
      }
      // Prepared and committed in turn with the other postings of this book.
      const turn = await alone(runtime, async () => {
        const prepared = await service.prepareDraft(current.id, current.version, operationId, {
          by: principal,
          operation,
        });
        if (!prepared.valid && prior?.disposition !== "unresolved")
          return { prepared, receipt: null };
        return {
          prepared,
          receipt: await service.commitAction(operationId, prepared.planHash, {
            by: principal,
            operation,
          }),
        };
      });
      const { prepared, receipt } = turn;
      if (receipt === null) {
        if (staleOnly(prepared.problems)) {
          // The plan was made for a book that has moved on and was never sent: make a new one.
          draft = remake(service, store, current);
          if (lastTry) return busy();
          continue;
        }
        return refuse(
          "posting_invalid",
          problemText(prepared.problems, "The entry did not pass the ledger's checks."),
          true,
        );
      }
      if (receipt.disposition === "committed")
        return applied(
          current,
          service.draft(current.id)?.journalId ?? current.journalId ?? "",
          operationId,
          receipt.outcomeSequence,
        );
      if (staleOnly(receipt.problems)) {
        draft = await reopen(service, store, current, operationId);
        if (lastTry) return busy();
        continue;
      }
      const message = problemText(receipt.problems, "The ledger refused this entry.");
      return refuse("posting_rejected", `The ledger refused this entry: ${message}`, true);
    }
  } catch (error) {
    if (error instanceof ApplicationError) {
      noteFailure(
        store,
        row.id,
        error.message,
        error.retryable || PASSES_BY_ITSELF.has(error.code) ? null : error.code,
      );
      return failed(row, error.code, error.message, error.details);
    }
    // The ledger did not answer, or answered in a way we cannot read. The command may or may not
    // have committed: say so, and let the same call resume it under the same identity.
    runtime.lastUnexpected = error;
    return {
      ...failed(
        row,
        "posting_uncertain",
        "The ledger did not confirm this posting. Run post again: it resumes the same posting and cannot repeat it.",
      ),
      stop: true,
    };
  }
}

/** The lines a post by filter left alone because an earlier attempt failed on them in a way that
 * does not change: each as a skipped result with its reason, as many as a report may name. */
function refusedEarlier(settled: Resolved["settled"], room: number): InboxActionResult[] {
  const results = settled.rows
    .slice(0, room)
    .map((row) =>
      skipped(
        row,
        "refused_earlier",
        sanitizeText(
          `Left alone because it was refused before: ${row.post_error ?? "no reason was kept"} It is tried again when the calendar, a month or the chart changes; post this line by itself to try it now, or restore it and decide it again.`,
          500,
        ),
      ),
    );
  const unnamed = settled.count - results.length;
  const last = results.at(-1);
  if (unnamed > 0 && last)
    results[results.length - 1] = {
      ...last,
      message: sanitizeText(
        `${unnamed} more lines that were refused before were left alone and are not listed. ${last.message ?? ""}`,
        500,
      ),
    };
  return results;
}

/** A failure that trying again will not change stands only while the books are as they were. What
 * posting an entry asks of the books is that its date is inside the calendar, its month open and its
 * accounts able to take it, and those change when the calendar is extended, a month is closed or
 * reopened, or the chart is changed: the configuration revision and the month closes and reopens.
 * When either has moved since the last post by filter, the lines that were left alone are put back in
 * the queue (behind the lines that have not failed), so that "fix the cause, then post again" works
 * without naming them. The first call on a book only notes where the books stand. */
async function forgetFailuresThatMayHavePassed(
  service: ApplicationService,
  store: ApplicationStore,
): Promise<void> {
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const standing = `${state.configurationRevision}.${state.periodTransitions.length}`;
  const known = store
    .query("SELECT value FROM app_ingest_settings WHERE key='post_standing'")
    .get() as {
    value: string;
  } | null;
  if (known?.value === standing) return;
  store.transaction(() => {
    store
      .query("UPDATE app_ingest_items SET post_error_code=NULL WHERE post_error_code IS NOT NULL")
      .run();
    store
      .query(
        "INSERT INTO app_ingest_settings (key, value) VALUES ('post_standing', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(standing);
  });
}

export async function postItems(
  service: ApplicationService,
  input: InboxPostInput,
  operationId: string,
  principal: string,
): Promise<InboxActionReport> {
  return service.retainAsyncRequest(operationId, "inbox.post", input, async () => {
    const runtime = ingestRuntime(service);
    const store = runtime.store;
    if (input.filter !== undefined) await forgetFailuresThatMayHavePassed(service, store);
    const resolved = resolveSelection(
      store,
      input,
      {
        statuses: ["drafted"],
        sql: "i.draft_id IS NOT NULL",
        // A post by filter works on the lines that have not failed first, then those whose failure
        // may pass, and leaves alone those whose failure will not change (it says so below).
        later: "i.post_error IS NOT NULL",
        settled: "i.post_error IS NOT NULL AND i.post_error_code IS NOT NULL",
      },
      POST_LIMIT,
    );
    const results = [...resolved.results];
    const started = performance.now();
    let reached = 0;
    for (const row of resolved.rows) {
      if (reached > 0 && performance.now() - started > runtime.postBudgetMs) break;
      const result = await postOne(service, store, runtime.now(), row, principal);
      reached += 1;
      const { stop, ...clean } = result;
      results.push(clean);
      if (stop) break;
    }
    const remaining = resolved.remaining + (resolved.rows.length - reached);
    // The lines that were left alone are named once, by the call that has nothing else left to do, so
    // a client that posts until nothing remains hears of them at the end and not at every step.
    if (remaining === 0)
      results.push(...refusedEarlier(resolved.settled, Math.max(0, MAX_LIMIT - results.length)));
    return report(results, remaining);
  });
}

/** Bring items in line with their drafts when a draft was posted from the Journal screen or
 * discarded there. A posted draft makes the line posted; a missing draft is flagged, never guessed. */
export function reconcileDrafts(service: ApplicationService): number {
  const runtime = ingestRuntime(service);
  const store = runtime.store;
  const rows = store
    .query(
      "SELECT DISTINCT draft_id FROM app_ingest_items WHERE status='drafted' AND draft_id IS NOT NULL",
    )
    .all() as { draft_id: string }[];
  let changed = 0;
  for (const { draft_id } of rows) {
    const draft = service.draft(draft_id);
    if (draft?.status === "posted" && draft.journalId) {
      markPosted(
        store,
        runtime.now(),
        draft.id,
        draft.journalId,
        draft.postingOperationId ?? null,
        "owner",
      );
      changed += 1;
    } else if (!draft) {
      const message = "The draft was discarded. Restore the item and categorize it again.";
      store
        .query(
          "UPDATE app_ingest_items SET post_error=?, post_error_code='draft_missing' WHERE draft_id=? AND status='drafted' AND post_error IS NULL",
        )
        .run(message, draft_id);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// restore

export async function restoreItems(
  service: ApplicationService,
  input: InboxRestoreInput,
  operationId: string,
  principal: string,
): Promise<InboxActionReport> {
  const reason = sanitizeText(input.reason, 500);
  if (reason === "")
    throw new ApplicationError(
      "invalid_input",
      "Say why these lines are being returned to review.",
    );
  return service.retainAsyncRequest(operationId, "inbox.restore", input, async () => {
    const runtime = ingestRuntime(service);
    const store = runtime.store;
    const resolved = resolveSelection(store, input, { statuses: ["excluded", "drafted"] }, 500);
    const results = [...resolved.results];
    for (const stale of resolved.rows) {
      const row = rowById(store, stale.id);
      if (!row || (row.status !== "excluded" && row.status !== "drafted")) {
        results.push(skipped(stale, "wrong_status", "This item changed while the action ran."));
        continue;
      }
      if (row.status === "drafted") {
        const problem = await discardDraft(service, row);
        if (problem) {
          results.push(problem);
          continue;
        }
      }
      const now = runtime.now();
      store.transaction(() => {
        const ids = [row.id, ...(row.pair_item_id ? [row.pair_item_id] : [])];
        for (const id of ids)
          store
            .query(
              `UPDATE app_ingest_items SET status='new', exclusion_code=NULL, exclusion_reason=NULL,
                 exclusion_at=NULL, decision=NULL, draft_id=NULL, draft_version=NULL, pair_item_id=NULL,
                 post_error=NULL, post_error_code=NULL, proposed_rev=NULL
               WHERE id=? AND status IN ('excluded', 'drafted')`,
            )
            .run(id);
        for (const id of ids) recordEvent(store, id, now, "restore", principal, { reason });
        // A payout back in review takes the lines it books with it.
        const back = rowById(store, row.id);
        if (back?.kind === "event") syncCovered(store, now, back);
        invalidateNeighbours(store, [row]);
      });
      results.push({ itemId: row.id, outcome: "applied", status: "new" });
    }
    return report(results, resolved.remaining);
  });
}

/** Remove the draft behind a drafted line so the line can be decided again. A draft whose posting
 * was rejected is reopened first (the ledger keeps the rejected attempt); a posting whose outcome
 * is uncertain, or one that went through, is never touched. */
async function discardDraft(
  service: ApplicationService,
  row: ItemRow,
): Promise<InboxActionResult | null> {
  if (row.draft_id === null) return null;
  const draft = service.draft(row.draft_id);
  if (!draft) return null;
  if (draft.status === "posted")
    return failed(
      row,
      "already_posted",
      "This line's entry is already posted. If it was wrong, correct it with a reversal.",
    );
  if (draft.status === "posting")
    return failed(
      row,
      "posting_uncertain",
      "The result of posting this line is uncertain. Run post again to resume it before changing anything.",
    );
  let current = draft;
  if (draft.status === "rejected" && draft.postingOperationId)
    current = await service.recoverDraft(
      draft.id,
      draft.version,
      draft.postingOperationId,
      deriveUuid(["ingest.restore", draft.id, String(draft.version)]),
    );
  try {
    service.discardDraft(current.id, current.version);
  } catch (error) {
    if (error instanceof Error && /^Draft changed/.test(error.message))
      return failed(row, "draft_version_conflict", error.message);
    throw error;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// refresh

export async function refreshInbox(
  service: ApplicationService,
  operationId: string,
): Promise<InboxRefreshReport> {
  return service.retainAsyncRequest(operationId, "inbox.refresh", {}, async () => {
    reconcileDrafts(service);
    invalidateProposals(service);
    return ensureProposals(service);
  });
}

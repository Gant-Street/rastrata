/** `inbox.undo`: take posted Inbox lines back.
 *
 * Undo reverses the line's entry with a linked reversal, the same correction a person makes on the
 * Journal screen, so the original and its reversal both stay in the books and net to zero: nothing is
 * deleted and the trail is kept. The line then goes back to review, where it is proposed, decided and
 * posted like any other.
 *
 * Two rules keep it safe to run again after any interruption:
 *
 * - The reversal is one command with an identity derived from the request's operation identity and
 *   the entry, so a retry resumes the same command, and a committed one is recognised and never
 *   repeated. Before every attempt the ledger is asked whether the entry has been reversed already
 *   (by an earlier attempt, or by hand on the Journal screen); if so no second reversal is made and
 *   the line simply goes back to review. The kernel also refuses to correct an entry twice.
 * - The line moves to the next generation of its ledger source identity in the same step that
 *   returns it to review (see `ledgerSourceId`), because the ledger refuses a second journal for one
 *   source identity and a reversal does not free it. Without that the line could never be posted
 *   again.
 *
 * An entry in a closed month cannot be corrected until the month is reopened: the ledger says so, and
 * the line stays posted with the ledger's own code (`fiscal_period_admission`) and words. A line that
 * was matched to an entry booked by hand has nothing of its own to reverse: only the link is
 * removed. */
import type { MutationReceipt, PreparedOperation } from "../../contracts.ts";
import { lockedPeriodForDate } from "../../calendar/periods.ts";
import type {
  InboxUndoInput,
  InboxUndoReport,
  InboxUndoResult,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { invalidateNeighbours } from "../ingest/proposing.ts";
import { resolveSelection } from "../ingest/selection.ts";
import { type ItemRow, ingestRuntime, recordEvent, rowById } from "../ingest/store.ts";

/** Lines one call works through. Each reversal is a ledger command, so the call also stops after the
 * pipeline's time budget and reports what remains. */
const UNDO_LIMIT = 100;
/** The reason every reversal carries. It reads after the entry's id in Transactions and the General ledger,
 * so it is in the app's words (a transaction, not a line) and names no screen. Reversals made before this
 * wording keep the reason they were written with. */
const REVERSAL_REASON = "Undone: the transaction went back to review";
/** How often one line's reversal is sealed again when the book moved while it was being prepared. */
const ATTEMPTS = 3;
const STALE = "stale_book_revision";

type Outcome = InboxUndoResult & { readonly stop?: boolean };
type Warnings = NonNullable<InboxUndoResult["warnings"]>;

const result = (
  row: Pick<ItemRow, "id" | "status">,
  outcome: InboxUndoResult["outcome"],
  rest: Partial<InboxUndoResult> = {},
): Outcome => ({ itemId: row.id, outcome, status: row.status, ...rest });
/** The wire carries a code of at most 80 characters and a message of at most 500: the books' own words
 * can be longer (a closed month names its dates and how to reopen it), and a reply that broke the
 * contract would turn a refusal into an error. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const skip = (row: Pick<ItemRow, "id" | "status">, code: string, message: string): Outcome =>
  result(row, "skipped", { code: clip(code, 80), message: clip(message, 500) });
const fail = (
  row: Pick<ItemRow, "id" | "status">,
  code: string,
  message: string,
  rest: Partial<InboxUndoResult> = {},
): Outcome => result(row, "failed", { code: clip(code, 80), message: clip(message, 500), ...rest });

const NOT_POSTED: Record<string, string> = {
  new: "This line is waiting for review; there is nothing to undo.",
  proposed: "This line is waiting for review; there is nothing to undo.",
  drafted:
    "This line has a draft but nothing is posted. To take the draft back, return the line to review (inbox restore).",
  excluded: "This line was set aside, not posted. Restore it to review it again.",
};

function report(results: readonly Outcome[], remaining: number): InboxUndoReport {
  const clean = results.map(({ stop: _stop, ...rest }) => rest);
  return {
    results: clean,
    applied: clean.filter((item) => item.outcome === "applied").length,
    skipped: clean.filter((item) => item.outcome === "skipped").length,
    failed: clean.filter((item) => item.outcome === "failed").length,
    remaining,
  };
}

/** The ledger's account of an operation, or null when it has none. */
async function priorOutcome(service: ApplicationService, id: string) {
  try {
    return await service.operation(id);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "operation_not_found") return null;
    throw error;
  }
}

interface Taken {
  readonly id: string;
  readonly kind: "bankLine" | "event";
  readonly provider: string;
  readonly account_key: string;
  readonly provider_id: string | null;
  readonly amount: string;
  readonly posted_on: string;
}

/** Return a line to review. In one transaction: the line, the other side of a transfer (they share
 * the entry), and the lines a payout books (they follow it) go back to `new` with the entry and the
 * draft forgotten; the lines that could be posted again move to the next generation of their ledger
 * source identity (only when an entry of theirs was reversed: a line that was only matched to an entry
 * booked by hand never used an identity of its own); each one records the undo. Returns how many lines
 * it moved (0 when another undo got there first). */
export function returnToReview(
  store: ApplicationStore,
  now: string,
  row: ItemRow,
  details: {
    readonly journalId: string;
    readonly reversalJournalId?: string;
    readonly reason: string;
  },
  principal: string,
): number {
  // A reversed entry used the line's identity; the next posting needs the next one.
  const advance = details.reversalJournalId === undefined ? 0 : 1;
  return store.transaction(() => {
    let moved = 0;
    const own: Taken[] =
      row.draft_id === null
        ? [row]
        : (store
            .query(
              "SELECT id, kind, provider, account_key, provider_id, amount, posted_on FROM app_ingest_items WHERE draft_id=? AND status='posted' AND covered_by IS NULL",
            )
            .all(row.draft_id) as Taken[]);
    for (const item of own) {
      const changed = store
        .query(
          `UPDATE app_ingest_items SET status='new', journal_id=NULL, matched_journal_id=NULL,
             post_operation_id=NULL, draft_id=NULL, draft_version=NULL, decision=NULL,
             pair_item_id=NULL, post_error=NULL, post_error_code=NULL, proposed_rev=NULL,
             source_generation=source_generation+?
           WHERE id=? AND status='posted'`,
        )
        .run(advance, item.id).changes;
      if (changed !== 1) continue;
      moved += 1;
      recordEvent(store, item.id, now, "undo", principal, {
        journalId: details.journalId,
        reversalJournalId: details.reversalJournalId,
        reason: details.reason,
      });
      if (item.kind !== "event" || item.provider_id === null) continue;
      // A payout's lines are evidence that follows the payout: they were posted with it, and go back
      // with it. They never post alone, so they have no identity of their own to advance.
      const members = store
        .query(
          "SELECT id FROM app_ingest_items WHERE provider=? AND account_key=? AND covered_by=? AND status='posted'",
        )
        .all(item.provider, item.account_key, item.provider_id) as { id: string }[];
      for (const member of members) {
        store
          .query(
            `UPDATE app_ingest_items SET status='new', journal_id=NULL, matched_journal_id=NULL,
               post_operation_id=NULL, draft_id=NULL, draft_version=NULL, decision=NULL,
               pair_item_id=NULL, post_error=NULL, post_error_code=NULL, proposed_rev=NULL
             WHERE id=? AND status='posted'`,
          )
          .run(member.id);
        recordEvent(store, member.id, now, "undo", "covered", {
          journalId: details.journalId,
          reversalJournalId: details.reversalJournalId,
          reason: `Back in review with ${item.provider_id}.`,
        });
      }
    }
    invalidateNeighbours(store, own);
    return moved;
  });
}

/** The words a refusal to reverse uses where they name what the caller is doing. */
export interface ReversalWords {
  readonly uncertain: string;
  readonly unconfirmed: string;
  readonly busy: string;
}

const UNDO_WORDS: ReversalWords = {
  uncertain:
    "The books did not confirm this undo. Run it again: if the reversal went through it is recognized, and it is never made twice.",
  unconfirmed:
    "The books confirmed the reversal but it is not there. Nothing was changed in the Inbox; run the undo again.",
  busy: "The books kept changing while this was prepared. Nothing was changed; try again.",
};

/** What reversing an entry is done under. */
export interface ReversalOptions {
  /** What the identity of each attempt is derived from, ahead of the entry and the attempt: the name of
   * the operation and the identity of the request. A retry derives the same identities and so finds
   * what the first try left. */
  readonly identity: readonly string[];
  /** The operation the commit is recorded under, for the book's record of who changed it. */
  readonly operation: string;
  /** The reason the reversal carries in the books. */
  readonly reason: string;
  /** Who is asking (`describePrincipal`). */
  readonly principal: string;
  /** A refusal the books gave no code for is named `<code>_busy`, `<code>_invalid` and so on. */
  readonly code: string;
  readonly words: ReversalWords;
}

/** A reversal that is in the books, and how it came to be. */
export interface Reversal {
  readonly reversalJournalId: string;
  /** The identity of the command that made it; absent when the entry had been reversed already. */
  readonly operationId?: string;
  readonly outcomeSequence?: string;
  readonly warnings: Warnings;
}

/** Why an entry could not be reversed. Nothing was changed, except when `uncertain` is set: then the
 * books did not answer, and the reversal may or may not have happened. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly warnings?: Warnings;
  readonly uncertain?: true;
}

export type Reversed =
  | { readonly ok: true; readonly reversal: Reversal }
  | { readonly ok: false; readonly refusal: Refusal };

/** Reverse an entry with a linked reversal, the correction a person makes on the Journal screen.
 *
 * The reversal is one command with an identity derived from the request's, so a retry resumes the same
 * command and a committed one is recognised and never repeated. Before every attempt the ledger is asked
 * whether the entry has been reversed already (by an earlier attempt, or by hand); if so it is not
 * reversed again and the existing reversal is the answer. An attempt the book moved under (the command
 * was sealed against a revision that is no longer the head) is made again under the next identity, a few
 * times. A refusal is the result, never an exception, except for an error that is not the books' to
 * explain (the ledger did not answer): that is returned as `uncertain`. */
export async function reverseEntry(
  service: ApplicationService,
  journalId: string,
  options: ReversalOptions,
): Promise<Reversed> {
  let warnings: Warnings = [];
  const refuse = (
    code: string,
    message: string,
    withWarnings = false,
    uncertain = false,
  ): Reversed => ({
    ok: false,
    refusal: {
      code,
      message,
      ...(withWarnings ? { warnings: [...warnings] } : {}),
      ...(uncertain ? { uncertain: true as const } : {}),
    },
  });
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { aggregate } = await service.readAggregate();
    const state = aggregate.state;
    const booked = state.journals.find((item) => item.journal.id === journalId);
    if (!booked)
      return refuse(
        "entry_not_found",
        "The entry for this line is not in the books. Nothing was changed.",
      );
    const link = state.corrections.find((item) => item.originalJournalId === journalId);
    if (link) {
      if (link.kind !== "reversal")
        return refuse(
          "already_corrected",
          "This entry was replaced by a corrected entry, so it cannot be undone from here. Find the entry that replaced it.",
        );
      // Reversed already, by an earlier attempt or by hand: nothing more to do.
      return { ok: true, reversal: { reversalJournalId: link.correctionJournalId, warnings } };
    }
    const actionId = deriveUuid([...options.identity, journalId, String(attempt)]);
    const prior = await priorOutcome(service, actionId);
    let prepared: PreparedOperation;
    try {
      prepared = (await service.reverseJournal(
        {
          actionId,
          journalId,
          // The entry is taken back on its own date, so the month it was booked in nets to zero.
          accountingDate: booked.journal.accountingDate as string,
          reason: options.reason,
        },
        true,
      )) as PreparedOperation;
    } catch (error) {
      if (error instanceof ApplicationError) return refuse(error.code, error.message);
      if (error instanceof TypeError) return refuse(`${options.code}_invalid`, error.message);
      throw error;
    }
    warnings = prepared.warnings ?? [];
    if (!prepared.valid && prior?.disposition !== "unresolved") {
      if (prepared.problems.some((problem) => problem.code === STALE)) continue;
      const [first] = prepared.problems;
      return refuse(
        first?.code ?? `${options.code}_invalid`,
        first?.message ?? "The books would not accept the reversal. Nothing was changed.",
        true,
      );
    }
    let receipt: MutationReceipt;
    try {
      receipt = await service.commitAction(actionId, prepared.planHash, {
        by: options.principal,
        operation: options.operation,
      });
    } catch (error) {
      if (error instanceof ApplicationError) return refuse(error.code, error.message, true);
      // The ledger did not answer, or answered in a way we cannot read: the command may or may not
      // have committed. Say so. Running it again asks the books first whether the entry was reversed, and
      // if it was it is recognised and the line goes back; a reversal is never made twice.
      ingestRuntime(service).lastUnexpected = error;
      return refuse(`${options.code}_uncertain`, options.words.uncertain, false, true);
    }
    if (receipt.disposition === "committed") {
      const after = (await service.readAggregate()).aggregate.state;
      const reversalJournalId = after.corrections.find(
        (item) => item.originalJournalId === journalId,
      )?.correctionJournalId;
      if (reversalJournalId === undefined)
        return refuse(`${options.code}_unconfirmed`, options.words.unconfirmed);
      return {
        ok: true,
        reversal: {
          reversalJournalId,
          operationId: actionId,
          ...(receipt.outcomeSequence ? { outcomeSequence: receipt.outcomeSequence } : {}),
          warnings,
        },
      };
    }
    if (receipt.problems.some((problem) => problem.code === STALE)) continue;
    const [first] = receipt.problems;
    return refuse(
      first?.code ?? `${options.code}_rejected`,
      `The books refused the reversal: ${first?.message ?? "no reason was given"}`,
      true,
    );
  }
  return refuse(`${options.code}_busy`, options.words.busy);
}

/** Take back one line. Never throws for a refusal: the refusal is the result. */
async function undoOne(
  service: ApplicationService,
  store: ApplicationStore,
  now: string,
  stale: ItemRow,
  operationId: string,
  principal: string,
  reason: string,
): Promise<Outcome> {
  const row = rowById(store, stale.id);
  if (row?.status !== "posted")
    return skip(row ?? stale, "wrong_status", "This line changed while the action ran.");
  const why = reason || "Undone.";

  if (row.journal_id === null) {
    // Matched to an entry that was booked by hand: the line owns no entry, so nothing is reversed.
    if (row.matched_journal_id === null)
      return fail(row, "no_entry", "This line has no entry to undo. Nothing was changed.");
    const journalId = row.matched_journal_id;
    const { aggregate } = await service.readAggregate();
    const booked = aggregate.state.journals.find((entry) => entry.journal.id === journalId);
    const dates = [row.posted_on, ...(booked ? [booked.journal.accountingDate as string] : [])];
    for (const day of dates) {
      const locked = lockedPeriodForDate(aggregate.state, day);
      if (locked)
        return fail(
          row,
          "fiscal_period_admission",
          `Period ${locked.label} is closed. Reopen it before unlinking a transaction dated ${day}.`,
        );
    }
    returnToReview(store, now, row, { journalId, reason: why }, principal);
    return result(row, "applied", {
      status: "new",
      journalId,
      message:
        "The line is back in review. The entry it matched was left as it was; only the link was removed.",
    });
  }

  const journalId = row.journal_id;
  const reversed = await reverseEntry(service, journalId, {
    identity: ["inbox.undo", operationId],
    operation: "inbox.undo",
    reason: REVERSAL_REASON,
    principal,
    code: "undo",
    words: UNDO_WORDS,
  });
  if (!reversed.ok) {
    const { refusal } = reversed;
    // A reply the ledger did not give leaves it unknown whether the reversal happened: stop here and say so.
    const outcome = fail(
      row,
      refusal.code,
      refusal.message,
      refusal.warnings ? { warnings: [...refusal.warnings] } : {},
    );
    return refusal.uncertain ? { ...outcome, stop: true } : outcome;
  }
  const {
    reversalJournalId,
    outcomeSequence,
    operationId: usedOperation,
    warnings,
  } = reversed.reversal;

  const moved = returnToReview(
    store,
    now,
    row,
    { journalId, reversalJournalId, reason: why },
    principal,
  );
  if (moved === 0) return skip(row, "wrong_status", "This line is already back in review.");
  return result(row, "applied", {
    status: "new",
    journalId,
    reversalJournalId,
    ...(usedOperation ? { operationId: usedOperation } : {}),
    ...(outcomeSequence ? { outcomeSequence } : {}),
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  });
}

export async function undoItems(
  service: ApplicationService,
  input: InboxUndoInput,
  operationId: string,
  principal: string,
): Promise<InboxUndoReport> {
  const reason = sanitizeText(input.reason ?? "", 500);
  return service.retainAsyncRequest(operationId, "inbox.undo", input, async () => {
    const runtime = ingestRuntime(service);
    const store = runtime.store;
    const resolved = resolveSelection(
      store,
      { itemIds: input.itemIds },
      { statuses: ["posted"] },
      UNDO_LIMIT,
    );
    // The selection's words say "correct it with a reversal"; here the reversal is what is asked for.
    const results: Outcome[] = resolved.results.map((item) => {
      const message =
        item.code === "wrong_status" && item.status !== undefined
          ? (NOT_POSTED[item.status] ?? item.message)
          : item.message;
      return {
        itemId: item.itemId,
        outcome: item.outcome,
        ...(item.status ? { status: item.status } : {}),
        ...(item.code ? { code: item.code } : {}),
        ...(message ? { message } : {}),
      };
    });
    const started = performance.now();
    let reached = 0;
    for (const row of resolved.rows) {
      if (reached > 0 && performance.now() - started > runtime.postBudgetMs) break;
      const outcome = await undoOne(
        service,
        store,
        runtime.now(),
        row,
        operationId,
        principal,
        reason,
      );
      reached += 1;
      results.push(outcome);
      if (outcome.stop) break;
    }
    return report(results, resolved.remaining + (resolved.rows.length - reached));
  });
}

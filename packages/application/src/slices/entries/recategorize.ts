/** `inbox.recategorize`: change the account of posted transactions that came from For review.
 *
 * A posted transaction cannot be edited: its entry is reversed with a linked reversal and a new entry is
 * posted, so the books keep the whole story (the original, its reversal and the new entry). For each
 * transaction that is three steps the Inbox already has, in turn:
 *
 * 1. the reversal of the entry (`reverseEntry`, the step `inbox.undo` takes), after which the line is back
 *    in review under the next generation of its ledger source identity;
 * 2. the categorization of the line to the new account (`categorizeOne`), which makes the draft;
 * 3. the posting of that draft (`postOne`).
 *
 * Every step has an identity that follows from the request's, and every step is idempotent, so a request
 * that was cut short at any point and is sent again with the same identity goes on from where it was and
 * repeats nothing. What makes that possible is one row written before the first step of a transaction
 * (`entries_moves`: what it was, where it is going, which time round it was) and the rule that where a
 * transaction has got to is never kept: each turn reads the books (is the entry reversed?) and the
 * Inbox (is the line back in review? is it drafted? is it posted again?) and does the next thing that is
 * missing. Two requests that meet the same transaction cannot book it twice: the ledger refuses a second
 * entry for one source identity.
 *
 * What is not moved, and said so, with the reason: a transaction split across accounts, a transfer, a payout
 * and an entry made by hand (none is a bank transaction booked to one account), an entry that was reversed
 * or replaced already, and anything in a closed month. A transaction that is already on the account is
 * skipped, so asking twice is harmless.
 *
 * If a step after the reversal fails (the draft is refused, the ledger turns the posting down), the
 * transaction is left in For review, where it is seen, and the result says so; nothing is rolled back,
 * because the books are never edited.
 *
 * `dryRun` runs the same assessment and changes nothing, so the plan is exactly what a call without it
 * carries out if nothing has changed in between. */
import type { BookedJournal } from "@rastrata/kernel";
import { describePrincipal, type ApplicationAccess } from "../../agent/principal.ts";
import type {
  InboxRecategorizeInput,
  InboxRecategorizeReport,
  InboxRecategorizeResult,
} from "../../client-contracts.gen.ts";
import { lockedPeriods } from "../../calendar/periods.ts";
import { ApplicationError } from "../../errors.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { type ActionContext, actionContext, categorizeOne, lineOf } from "../ingest/actions.ts";
import {
  type BookState,
  type ChartAccount,
  chartOf,
  postingProblem,
} from "../ingest/ledger-view.ts";
import { postOne } from "../ingest/posting.ts";
import { type Resolved, resolveSelection } from "../ingest/selection.ts";
import { type ItemRow, ingestRuntime, rowById } from "../ingest/store.ts";
import { clearedPostings } from "../reconcile/reconciliations.ts";
import { type MovePlan, entriesStore, plannedMoves, planMove } from "./store.ts";
import { type ReversalWords, clip, returnToReview, reverseEntry } from "./undo.ts";

/** Transactions one call looks at when the request does not say. Each move is two ledger commands, so a
 * call also stops after the pipeline's time budget and reports what remains. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** The operation the book's record of who changed it names for the reversal and for the new entry. */
const OPERATION = "inbox.recategorize";
/** The reason the reversal carries. It reads after the entry's number in Transactions and the General
 * ledger, so it is in the app's words (a transaction) and names no screen, as the reason an undo carries is. */
const REVERSAL_REASON = "Account changed: the transaction was moved to another account";
/** How many times one transaction's state is read and acted on before the call gives up on it. Each turn
 * does one step, and a move has four, so this is only reached when something keeps changing the line. */
const TURNS = 12;

const MOVE_WORDS: ReversalWords = {
  uncertain:
    "The books did not confirm this change. Send the same request again, with the same identity, to carry on: nothing is done twice.",
  unconfirmed:
    "The books confirmed the reversal but it is not there. Send the same request again, with the same identity, to carry on.",
  busy: "The books kept changing while this was prepared. Nothing was changed; try again.",
};

type Result = InboxRecategorizeResult;
type Warning = NonNullable<Result["warnings"]>[number];

/** The steps of one move, for a test to stop a call between two of them (see `onMoveStep`). */
export type MoveStep = "reverse" | "return" | "categorize" | "post";
export type MoveCheckpoint = (
  when: "before" | "after",
  step: MoveStep,
  itemId: string,
) => void | Promise<void>;
const checkpoints = new WeakMap<ApplicationService, MoveCheckpoint>();
/** For tests: have the call stop between two steps, by throwing, as a process that died there would.
 * Nothing in the product sets this. */
export function onMoveStep(service: ApplicationService, checkpoint: MoveCheckpoint | null): void {
  if (checkpoint) checkpoints.set(service, checkpoint);
  else checkpoints.delete(service);
}

// ---------------------------------------------------------------------------------------------
// words

const label = (account: ChartAccount): string =>
  `${account.code} ${sanitizeText(account.name, 60)}`;

const NOT_POSTED: Record<string, string> = {
  new: "This transaction is waiting for review, so there is nothing to move. Categorize it there.",
  proposed:
    "This transaction is waiting for review, so there is nothing to move. Categorize it there.",
  drafted:
    "This transaction has a draft that is not posted yet. Post it, or return it to review, first.",
  excluded: "This transaction was set aside, not posted.",
};

const refused = (code: string, message: string): { code: string; message: string } => ({
  code: clip(code, 80),
  message: clip(message, 500),
});

/** The period an entry dated `date` falls in, as a person names it. */
function periodName(state: BookState, date: string): { id: string; name: string } | null {
  const period = state.periods.find((item) => item.startsOn <= date && date <= item.endsOn);
  if (!period) return null;
  const label = sanitizeText(period.label, 40);
  return {
    id: period.id as string,
    name: /\b\d{4}\b/.test(label) ? label : `${label} ${(period.startsOn as string).slice(0, 4)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// the assessment

/** What the books and the chart say, read once for a call. */
interface Planning {
  readonly state: BookState;
  readonly chart: ReadonlyMap<string, ChartAccount>;
  readonly journals: ReadonlyMap<string, BookedJournal>;
  readonly corrections: ReadonlyMap<string, { readonly kind: string }>;
  readonly locked: ReadonlySet<string>;
  readonly target: ChartAccount;
  /** The account the request wants the transactions to be on now, if it said. */
  readonly expectedFrom: ChartAccount | null;
  /** Journals that are on a finished reconciliation, with the date of its statement. */
  readonly cleared: ReadonlyMap<string, string>;
}

type Verdict =
  | { readonly go: true; readonly plan: Omit<MovePlan, "operationId">; readonly result: Result }
  | { readonly go: false; readonly result: Result };

/** Who the transaction is, as every result says it. Text that came from outside is cut short and has no
 * control or direction-changing characters. */
function describe(row: ItemRow): Pick<
  Result,
  "itemId" | "status" | "date" | "amount" | "description"
> & {
  journalId?: string;
} {
  const journalId = row.journal_id ?? row.matched_journal_id;
  const line = lineOf(row);
  const text = line.kind === "event" ? line.summary : line.description;
  const description = sanitizeText(text, 120);
  return {
    itemId: row.id,
    ...(journalId ? { journalId } : {}),
    status: row.status,
    date: row.posted_on,
    amount: row.amount,
    ...(description ? { description } : {}),
  };
}

/** The note on a transaction whose bank side is on a finished reconciliation. */
const clearedWarning = (statementDate: string): Warning => ({
  code: "cleared_posting_corrected",
  message: `This transaction is on a finished reconciliation (statement ending ${statementDate}). Moving it leaves the balance of the bank account as it was. The reversal and the new entry are two more items to reconcile on the next statement.`,
});

const skipWith = (
  row: ItemRow,
  code: string,
  message: string,
  accounts: Pick<Result, "fromAccountId" | "toAccountId"> = {},
): Verdict => ({
  go: false,
  result: { ...describe(row), ...accounts, outcome: "skipped", ...refused(code, message) },
});

/** Whether a posted transaction can be moved to the account, and from where. Pure: it reads what the
 * call read, so a plan and a move cannot disagree about a transaction. */
function assess(planning: Planning, row: ItemRow): Verdict {
  const { chart, journals, target } = planning;
  if (row.status !== "posted")
    return skipWith(
      row,
      "wrong_status",
      NOT_POSTED[row.status] ?? "This transaction changed while the action ran.",
    );
  if (row.kind !== "bankLine")
    return skipWith(
      row,
      "not_a_bank_line",
      "This came from a payment provider, and a payout is booked to several accounts at once. Undo it and categorize it again by hand.",
    );
  if (row.pair_item_id !== null)
    return skipWith(
      row,
      "transfer",
      "This is one side of a transfer between two of your accounts, which is booked as one entry for both. Undo it and categorize it again by hand.",
    );
  if (row.journal_id === null)
    return row.matched_journal_id === null
      ? {
          go: false,
          result: {
            ...describe(row),
            outcome: "failed",
            ...refused("no_entry", "This transaction has no entry to move. Nothing was changed."),
          },
        }
      : skipWith(
          row,
          "hand_entry",
          "This transaction is matched to an entry that was made by hand. To change it, reverse that entry.",
        );
  const booked = journals.get(row.journal_id);
  if (!booked)
    return {
      go: false,
      result: {
        ...describe(row),
        outcome: "failed",
        ...refused(
          "entry_not_found",
          "The entry for this transaction is not in the books. Nothing was changed.",
        ),
      },
    };
  const link = planning.corrections.get(row.journal_id);
  if (link)
    return link.kind === "reversal"
      ? skipWith(
          row,
          "already_reversed",
          "This entry was already reversed. Undo the transaction to send it back for review, then change its account.",
        )
      : skipWith(
          row,
          "already_corrected",
          "This entry was replaced by a corrected entry, so it cannot be moved from here. Find the entry that replaced it.",
        );

  // The accounts the entry touches, other than the bank account it came from.
  const sums = new Map<string, bigint>();
  for (const posting of booked.journal.postings)
    sums.set(
      posting.accountId as string,
      (sums.get(posting.accountId as string) ?? 0n) + posting.bookValue.amount.coefficient,
    );
  const bankId = row.ledger_account_id;
  const others = [...sums.keys()].filter((accountId) => accountId !== bankId);
  if (bankId === null || !sums.has(bankId) || others.length === 0)
    return skipWith(
      row,
      "unusual_entry",
      "The entry for this transaction is not a bank transaction booked to one other account, so it cannot be moved from here.",
    );
  if (others.length > 1)
    return skipWith(
      row,
      "split",
      `This transaction is split across ${others.length} accounts. Undo it and categorize it again by hand.`,
    );
  const fromId = others[0] as string;
  const from = chart.get(fromId);
  const fromName = from ? label(from) : fromId;
  const accounts = { fromAccountId: fromId, toAccountId: target.id };
  const view = { ...describe(row), ...accounts };

  if (planning.expectedFrom && planning.expectedFrom.id !== fromId)
    return skipWith(
      row,
      "not_on_account",
      `This transaction is on ${fromName}, not on ${label(planning.expectedFrom)}.`,
      accounts,
    );
  if (fromId === target.id)
    return skipWith(
      row,
      "already_there",
      `This transaction is already on ${label(target)}.`,
      accounts,
    );
  if (target.id === bankId)
    return skipWith(
      row,
      "same_account",
      "A transaction cannot be moved to its own bank account. To move money between two of your accounts, record a transfer.",
      accounts,
    );
  const problem = postingProblem(target, row.posted_on);
  if (problem) return skipWith(row, "account_unavailable", sanitizeText(problem, 400), accounts);
  // A closed month refuses the reversal and the new entry alike; say so before anything is tried.
  for (const date of new Set([booked.journal.accountingDate as string, row.posted_on])) {
    const period = periodName(planning.state, date);
    if (period && planning.locked.has(period.id))
      return skipWith(
        row,
        "fiscal_period_admission",
        `${period.name} is closed, so a transaction dated ${date} cannot be changed. Reopen the month first.`,
        accounts,
      );
  }

  const statement = planning.cleared.get(row.journal_id);
  const warnings: Warning[] = statement === undefined ? [] : [clearedWarning(statement)];
  return {
    go: true,
    plan: {
      itemId: row.id,
      journalId: row.journal_id,
      fromAccountId: fromId,
      toAccountId: target.id,
      generation: row.source_generation,
    },
    result: {
      ...view,
      outcome: "would_apply",
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// reading the request

function chosenSelection(input: InboxRecategorizeInput): "itemIds" | "journalIds" | "filter" {
  const given = (["itemIds", "journalIds", "filter"] as const).filter(
    (name) => input[name] !== undefined,
  );
  if (given.length !== 1)
    throw new ApplicationError(
      "invalid_input",
      "Name the transactions in one way: itemIds, journalIds or a filter. Not two of them, and not none.",
    );
  const how = given[0] as "itemIds" | "journalIds" | "filter";
  if (how !== "filter" && input.expectedCount !== undefined)
    throw new ApplicationError("invalid_input", "expectedCount goes with a filter.");
  if (how !== "filter" && input.after !== undefined)
    throw new ApplicationError("invalid_input", "after goes with a filter.");
  return how;
}

/** The permissions a move needs besides `correct`, which the request has already been checked for. The
 * words are `ApplicationHttp.requirePermission`'s. */
function requireMovePermissions(access: ApplicationAccess): void {
  for (const permission of ["draft", "post"] as const) {
    if (access.permissions.includes(permission)) continue;
    throw new ApplicationError(
      "permission_denied",
      access.principal?.kind === "token"
        ? `This operation requires ${permission} permission; this token grants ${access.permissions.join(", ") || "nothing"}`
        : `This operation requires ${permission} permission`,
      403,
    );
  }
}

const CHUNK = 200;

/** The lines that made these entries, by the entries; and the entries that no line made. */
function linesOfJournals(
  store: ApplicationStore,
  journalIds: readonly string[],
): { itemIds: string[]; unknown: string[] } {
  const wanted = [...new Set(journalIds)];
  const byJournal = new Map<string, string[]>();
  for (let from = 0; from < wanted.length; from += CHUNK) {
    const chunk = wanted.slice(from, from + CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    const rows = store
      .query(
        `SELECT id, journal_id, matched_journal_id FROM app_ingest_items
         WHERE journal_id IN (${marks}) OR matched_journal_id IN (${marks}) ORDER BY seq`,
      )
      .all(...chunk, ...chunk) as {
      id: string;
      journal_id: string | null;
      matched_journal_id: string | null;
    }[];
    for (const row of rows) {
      const key = row.journal_id ?? row.matched_journal_id;
      if (key === null) continue;
      byJournal.set(key, [...(byJournal.get(key) ?? []), row.id]);
    }
  }
  return {
    itemIds: wanted.flatMap((journalId) => byJournal.get(journalId) ?? []),
    unknown: wanted.filter((journalId) => !byJournal.has(journalId)),
  };
}

/** What the request selects, as lines to look at and results that are already known. `begun` are the
 * lines this request had taken in hand before (they are carried on, not looked at again). */
function select(
  store: ApplicationStore,
  input: InboxRecategorizeInput,
  how: "itemIds" | "journalIds" | "filter",
  operationId: string,
  begun: ReadonlySet<string>,
  limit: number,
): Resolved & { unknown: Result[] } {
  const posted = { statuses: ["posted" as const] };
  if (how === "filter") {
    const clauses: string[] = [];
    const bindings: (string | number)[] = [];
    if (begun.size > 0) {
      clauses.push("i.id NOT IN (SELECT item_id FROM entries_moves WHERE operation_id = ?)");
      bindings.push(operationId);
    }
    if (input.after !== undefined) {
      const known = store
        .query("SELECT seq FROM app_ingest_items WHERE id = ?")
        .get(input.after) as { seq: number } | null;
      if (!known)
        throw new ApplicationError(
          "invalid_input",
          "after names a transaction that does not exist.",
        );
      clauses.push("i.seq > ?");
      bindings.push(known.seq);
    }
    const resolved = resolveSelection(
      store,
      {
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
        ...(input.expectedCount !== undefined ? { expectedCount: input.expectedCount } : {}),
        limit,
      },
      {
        ...posted,
        ...(clauses.length > 0 ? { sql: clauses.join(" AND "), bindings } : {}),
      },
      limit,
    );
    return { ...resolved, unknown: [] };
  }
  let ids = input.itemIds ?? [];
  const unknown: Result[] = [];
  if (how === "journalIds") {
    const found = linesOfJournals(store, input.journalIds ?? []);
    ids = found.itemIds;
    for (const journalId of found.unknown)
      unknown.push({
        journalId,
        outcome: "skipped",
        ...refused(
          "not_from_review",
          "This entry does not come from a reviewed transaction. It may have been made by hand, reversed, or replaced already; an entry made by hand is changed with a reversal.",
        ),
      });
  }
  const wanted = [...new Set(ids)].filter((id) => !begun.has(id));
  if (wanted.length === 0)
    return { rows: [], results: [], remaining: 0, settled: { count: 0, rows: [] }, unknown };
  const resolved = resolveSelection(store, { itemIds: wanted }, posted, limit);
  // The selection's words say "correct it with a reversal"; here the move is what is asked for.
  const results = resolved.results.map((item) => {
    const message =
      item.code === "wrong_status" && item.status !== undefined
        ? (NOT_POSTED[item.status] ?? item.message)
        : item.message;
    return { ...item, ...(message !== undefined ? { message } : {}) };
  });
  return { ...resolved, results, unknown };
}

// ---------------------------------------------------------------------------------------------
// carrying a move out

interface Run {
  readonly service: ApplicationService;
  readonly store: ApplicationStore;
  readonly ctx: ActionContext;
  readonly principal: string;
  readonly operationId: string;
  readonly reason: string;
  /** Read again when a transaction turns out to have been moved by another request. */
  planning: Planning;
  readonly checkpoint: MoveCheckpoint | undefined;
}

/** Where a transaction that was taken in hand has got to, read from the books and the Inbox. */
type Seen =
  | { readonly at: "reverse" }
  | { readonly at: "return"; readonly reversalJournalId: string }
  | { readonly at: "categorize"; readonly reversalJournalId: string }
  | { readonly at: "post"; readonly reversalJournalId: string }
  | { readonly at: "done"; readonly reversalJournalId: string; readonly newJournalId: string }
  | { readonly at: "lost"; readonly code: string; readonly message: string };

const lost = (code: string, message: string): Seen => ({ at: "lost", code, message });

async function observe(run: Run, plan: MovePlan): Promise<Seen> {
  const row = rowById(run.store, plan.itemId);
  if (!row) return lost("item_not_found", "This transaction does not exist any more.");
  const { aggregate } = await run.service.readAggregate();
  const link = aggregate.state.corrections.find(
    (item) => item.originalJournalId === plan.journalId,
  );
  if (link && link.kind !== "reversal")
    return lost(
      "already_corrected",
      "The entry was replaced by a corrected entry while it was being moved. Nothing more was done.",
    );
  const standing = row.status === "posted" && row.journal_id === plan.journalId;
  if (!link)
    return standing
      ? { at: "reverse" }
      : lost(
          "changed",
          "This transaction changed while it was being moved, by something else. Nothing more was done.",
        );
  const reversalJournalId = link.correctionJournalId;
  if (standing) return { at: "return", reversalJournalId };
  // Back in review once since the move began: the time round this move made. Any later is someone else's.
  if (row.source_generation !== plan.generation + 1)
    return lost(
      "changed",
      "This transaction was undone or moved again while it was being moved, by something else. Nothing more was done.",
    );
  switch (row.status) {
    case "new":
    case "proposed":
      return { at: "categorize", reversalJournalId };
    case "drafted": {
      let toward: unknown;
      try {
        toward = (JSON.parse(row.decision ?? "{}") as { legs?: { accountId?: string }[] }).legs;
      } catch {
        toward = undefined;
      }
      const goesToTarget =
        Array.isArray(toward) &&
        toward.some((leg) => (leg as { accountId?: string }).accountId === plan.toAccountId);
      return goesToTarget
        ? { at: "post", reversalJournalId }
        : lost(
            "changed",
            "This transaction was categorized to another account while it was being moved. Nothing more was done; it is waiting for review.",
          );
    }
    case "posted":
      return row.journal_id !== null && row.journal_id !== plan.journalId
        ? { at: "done", reversalJournalId, newJournalId: row.journal_id }
        : lost(
            "changed",
            "This transaction changed while it was being moved. Nothing more was done.",
          );
    default:
      return lost(
        "changed",
        "This transaction was set aside while it was being moved. Nothing more was done.",
      );
  }
}

/** The call could not learn whether a step happened. It is not an answer: the request stays open under
 * its identity, and sending it again carries on from the books, which have the last word. */
const unresolved = () =>
  new ApplicationError(
    "operation_unresolved",
    "The books did not confirm a step of this change. Send the same request again, with the same identity, to carry on: nothing is done twice.",
    503,
    [],
    true,
  );

async function drive(run: Run, plan: MovePlan): Promise<Result> {
  const { service, store, planning } = run;
  const target = planning.target;
  const from = planning.chart.get(plan.fromAccountId);
  const stop = async (when: "before" | "after", step: MoveStep) => {
    await run.checkpoint?.(when, step, plan.itemId);
  };
  let warnings: Warning[] = [];
  const view = () => {
    const row = rowById(store, plan.itemId);
    return {
      ...(row ? describe(row) : { itemId: plan.itemId }),
      journalId: plan.journalId,
      fromAccountId: plan.fromAccountId,
      toAccountId: plan.toAccountId,
    };
  };
  const leftAs = (code: string, message: string, reversalJournalId?: string): Result => ({
    ...view(),
    outcome: "failed",
    ...refused(code, message),
    ...(reversalJournalId ? { reversalJournalId } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  const cleared = planning.cleared.get(plan.journalId);
  if (cleared !== undefined) warnings = [clearedWarning(cleared)];

  for (let turn = 0; turn < TURNS; turn++) {
    const seen = await observe(run, plan);
    switch (seen.at) {
      case "done":
        return {
          ...view(),
          outcome: "applied",
          status: "posted",
          reversalJournalId: seen.reversalJournalId,
          newJournalId: seen.newJournalId,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      case "lost":
        return leftAs(seen.code, seen.message);
      case "reverse": {
        await stop("before", "reverse");
        const reversed = await reverseEntry(service, plan.journalId, {
          identity: [OPERATION, run.operationId],
          operation: OPERATION,
          reason: REVERSAL_REASON,
          principal: run.principal,
          code: "move",
          words: MOVE_WORDS,
        });
        if (!reversed.ok) {
          if (reversed.refusal.uncertain) throw unresolved();
          // The books may have been refused because another request got there first (two requests for one
          // transaction at once): look again, and carry on if the transaction has moved on.
          if ((await observe(run, plan)).at !== "reverse") continue;
          // Nothing was changed: the old entry stands, and so does the transaction.
          return {
            ...view(),
            outcome: "failed",
            ...refused(reversed.refusal.code, reversed.refusal.message),
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        }
        await stop("after", "reverse");
        continue;
      }
      case "return": {
        await stop("before", "return");
        const row = rowById(store, plan.itemId);
        if (row)
          returnToReview(
            store,
            run.ctx.now,
            row,
            {
              journalId: plan.journalId,
              reversalJournalId: seen.reversalJournalId,
              reason:
                run.reason ||
                `Account changed from ${from ? label(from) : plan.fromAccountId} to ${label(target)}.`,
            },
            run.principal,
          );
        await stop("after", "return");
        continue;
      }
      case "categorize": {
        await stop("before", "categorize");
        const made = categorizeOne(run.ctx, plan.itemId, plan.toAccountId);
        if (made.outcome === "skipped" && made.code === "wrong_status") continue;
        if (made.outcome !== "applied")
          return leftAs(
            made.code ?? "categorize_refused",
            `The old entry was reversed, but the transaction could not be categorized to the new account: ${made.message ?? "no reason was given"} It is waiting for review again.`,
            seen.reversalJournalId,
          );
        await stop("after", "categorize");
        continue;
      }
      case "post": {
        await stop("before", "post");
        const row = rowById(store, plan.itemId);
        if (!row) continue;
        const posted = await postOne(service, store, run.ctx.now, row, run.principal, OPERATION);
        if (posted.stop) throw unresolved();
        if (posted.outcome === "failed") {
          // Another request may have posted it first (two requests for one transaction at once).
          if ((await observe(run, plan)).at !== "post") continue;
          return leftAs(
            posted.code ?? "posting_refused",
            `The old entry was reversed, but the new entry was not posted: ${posted.message ?? "no reason was given"} The transaction is ready to post.`,
            seen.reversalJournalId,
          );
        }
        await stop("after", "post");
        continue;
      }
    }
  }
  return leftAs(
    "move_unfinished",
    "This transaction kept changing while it was being moved. Nothing more was done; review it again.",
  );
}

// ---------------------------------------------------------------------------------------------
// the operation

function build(
  target: ChartAccount,
  dryRun: boolean,
  results: readonly Result[],
  remaining: number,
  next: string | null,
): InboxRecategorizeReport {
  const count = (outcome: Result["outcome"]) =>
    results.filter((item) => item.outcome === outcome).length;
  return {
    dryRun,
    target: { accountId: target.id, code: target.code, name: sanitizeText(target.name, 120) },
    results: [...results],
    would: count("would_apply"),
    applied: count("applied"),
    skipped: count("skipped"),
    failed: count("failed"),
    remaining,
    next,
  };
}

/** What the books and the chart say, read for a call (and again when a transaction turns out to have been
 * moved by another request since). `cleared` carries what was found of reconciliations, which only
 * ever grows. */
function readPlanning(
  service: ApplicationService,
  ctx: ActionContext,
  state: BookState,
  target: ChartAccount,
  expectedFrom: ChartAccount | null,
  journalIds: readonly string[],
  known: ReadonlyMap<string, string> = new Map(),
): Planning {
  const cleared = new Map(known);
  for (const posting of clearedPostings(service, [...new Set(journalIds)]).postings)
    if (!cleared.has(posting.journalId)) cleared.set(posting.journalId, posting.statementDate);
  const corrections = new Map<string, { kind: string }>();
  for (const link of state.corrections)
    if (!corrections.has(link.originalJournalId)) corrections.set(link.originalJournalId, link);
  return {
    state,
    chart: ctx.chart,
    journals: new Map(state.journals.map((booked) => [booked.journal.id as string, booked])),
    corrections,
    locked: lockedPeriods(state),
    target,
    expectedFrom,
    cleared,
  };
}

async function carryOut(
  service: ApplicationService,
  access: ApplicationAccess,
  input: InboxRecategorizeInput,
  operationId: string,
  dryRun: boolean,
): Promise<InboxRecategorizeReport> {
  const how = chosenSelection(input);
  const principal = describePrincipal(access.principal);
  const reason = input.reason === undefined ? "" : sanitizeText(input.reason, 500);
  if (input.reason !== undefined && reason === "")
    throw new ApplicationError("invalid_input", "Say why, or leave the reason out.");
  const runtime = ingestRuntime(service);
  const store = entriesStore(service);
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

  const ctx = await actionContext(service, principal);
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const target = ctx.chart.get(input.accountId);
  if (!target)
    throw new ApplicationError("account_not_found", "That account is not in the chart.", 404);
  let expectedFrom: ChartAccount | null = null;
  if (input.fromAccountId !== undefined) {
    expectedFrom = ctx.chart.get(input.fromAccountId) ?? null;
    if (!expectedFrom)
      throw new ApplicationError("account_not_found", "fromAccountId is not in the chart.", 404);
  }

  // What this request had already taken in hand, if it is being sent again after being cut short.
  const begun = dryRun ? [] : plannedMoves(store, operationId);
  const begunIds = new Set(begun.map((plan) => plan.itemId));
  const room = Math.max(0, limit - begun.length);
  const selected = select(store, input, how, operationId, begunIds, Math.max(1, room));
  const rows = room === 0 ? [] : selected.rows;
  const remainingAtStart = selected.remaining + (room === 0 ? selected.rows.length : 0);

  const journalIds = [
    ...begun.map((plan) => plan.journalId),
    ...rows.flatMap((row) => (row.journal_id !== null ? [row.journal_id] : [])),
  ];
  const planning = readPlanning(service, ctx, state, target, expectedFrom, journalIds);
  const run: Run = {
    service,
    store,
    ctx,
    principal,
    operationId,
    reason,
    planning,
    checkpoint: checkpoints.get(service),
  };

  const results: Result[] = [
    ...selected.unknown,
    ...selected.results.map((item) => {
      const row = item.itemId ? rowById(store, item.itemId) : null;
      return { ...(row ? describe(row) : {}), ...item } as Result;
    }),
  ];
  // Carry on first with what the first try had begun: it is part of this request.
  for (const plan of begun) results.push(await drive(run, plan));

  const started = performance.now();
  let reached = 0;
  let moved = 0;
  for (const selectedRow of rows) {
    if (!dryRun && moved > 0 && performance.now() - started > runtime.postBudgetMs) break;
    reached += 1;
    // The line as it is now: another request may have got to it since it was selected, and what the call
    // read of the books at the start does not know that.
    const row = rowById(store, selectedRow.id) ?? selectedRow;
    if (
      row.status !== selectedRow.status ||
      row.journal_id !== selectedRow.journal_id ||
      row.source_generation !== selectedRow.source_generation
    )
      run.planning = readPlanning(
        service,
        ctx,
        (await service.readAggregate()).aggregate.state,
        target,
        expectedFrom,
        row.journal_id !== null ? [row.journal_id] : [],
        run.planning.cleared,
      );
    const verdict = assess(run.planning, row);
    if (dryRun || !verdict.go) {
      results.push(verdict.result);
      continue;
    }
    const plan: MovePlan = { operationId, ...verdict.plan };
    planMove(store, plan, ctx.now);
    results.push(await drive(run, plan));
    moved += 1;
  }

  const left = rows.length - reached;
  // Where a filter carries on from: after the last line looked at. When what a first try had begun used
  // the whole call, that is the last line it had begun.
  const lastBegun = begun.at(-1)?.itemId;
  const last = reached > 0 ? rows[reached - 1]?.id : room === 0 ? lastBegun : undefined;
  const remaining = remainingAtStart + left;
  return build(
    target,
    dryRun,
    results,
    remaining,
    how === "filter" && remaining > 0 && last !== undefined ? last : null,
  );
}

/** `inbox.recategorize`. A plan (`dryRun`) changes nothing and keeps nothing; a move is retained under
 * the request's identity, so the same request again returns the first answer, and the same identity with
 * other input is a conflict. */
export async function recategorizeItems(
  service: ApplicationService,
  access: ApplicationAccess,
  input: InboxRecategorizeInput,
  operationId: string,
): Promise<InboxRecategorizeReport> {
  // What is wrong with the request itself is said before anything is kept under its identity.
  requireMovePermissions(access);
  chosenSelection(input);
  if (input.reason !== undefined && sanitizeText(input.reason, 500) === "")
    throw new ApplicationError("invalid_input", "Say why, or leave the reason out.");
  const chart = chartOf((await service.readAggregate()).aggregate.state);
  if (!chart.has(input.accountId))
    throw new ApplicationError("account_not_found", "That account is not in the chart.", 404);
  if (input.fromAccountId !== undefined && !chart.has(input.fromAccountId))
    throw new ApplicationError("account_not_found", "fromAccountId is not in the chart.", 404);
  if (
    input.after !== undefined &&
    !ingestRuntime(service)
      .store.query("SELECT 1 FROM app_ingest_items WHERE id = ?")
      .get(input.after)
  )
    throw new ApplicationError("invalid_input", "after names a transaction that does not exist.");
  if (input.dryRun === true) return carryOut(service, access, input, operationId, true);
  return service.retainAsyncRequest(operationId, "inbox.recategorize", input, () =>
    carryOut(service, access, input, operationId, false),
  );
}

import { hashCanonical } from "@rastrata/kernel";
import { readAccountTags } from "../../account-tags.ts";
import { lockedPeriodForDate } from "../../calendar/periods.ts";
import type {
  ReconcileAccountStatus,
  ReconcileCleared,
  ReconcileDiscardResult,
  ReconcileLine,
  ReconcileList,
  ReconcileProgress,
  ReconcileStatus,
  ReconcileVoid,
  ReconcileWarning,
  Reconciliation,
  ReconciliationSummary,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { formatMoney, parseMoney } from "../../money.ts";
import {
  canonicalStatementBalance,
  reconcileFigures,
  statementAmount,
  statementDateProblem,
  type Figures,
  type StatementDateProblem,
} from "../../reconcile/engine.ts";
import type { ApplicationService } from "../../service.ts";
import { statementAccountIds } from "../ingest/statement-accounts.ts";
import {
  clip,
  effect,
  isReconcilable,
  isTaggedBankOrCard,
  type BookAccount,
  type BookPosting,
  type BookView,
} from "./book.ts";
import { clearedFigures } from "./figures.ts";
import { reconcileState, type ReconcileState } from "./state.ts";
import type { LineRow, ListedRow, SessionRow } from "./store.ts";

const fail = (
  code: string,
  message: string,
  status = 409,
  details: readonly { path: string; message: string }[] = [],
) => new ApplicationError(code, message, status, details);

const isUnique = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message);

const byCode = (left: BookAccount, right: BookAccount) =>
  left.code.localeCompare(right.code, "en", { numeric: true });

type Candidate = LineRow & { position: number };

// ---- shared figures -------------------------------------------------------------------------------

/** What earlier reconciliations of the account have already cleared: the statement balance of the
 * newest completed, unvoided one. Each reconciliation ends exactly at its statement balance
 * (that is what completing means), so the next one continues from there. */
function openingOf(rs: ReconcileState, accountId: string) {
  const last = rs.store.lastActive(accountId);
  return { cents: last ? parseMoney(last.statement_balance) : 0n, last };
}

/** The cleared set must add up to the last statement balance. If it ever does not, the product
 * state is damaged and a reconciliation must not be completed on top of it. */
function assertClearedHistory(rs: ReconcileState, accountId: string, opening: bigint): void {
  let total = 0n;
  for (const row of rs.store.activeFor(accountId)) total += parseMoney(row.amount);
  if (total !== opening)
    throw fail(
      "reconcile_integrity",
      "The cleared lines of earlier reconciliations no longer add up to the last statement balance. Do not complete another reconciliation until this is investigated.",
      409,
      [{ path: "accountId", message: accountId }],
    );
}

const selectionHash = (ids: Iterable<string>): string =>
  hashCanonical({ type: "RastrataReconcileSelection", postingIds: [...ids].sort() }).digest;

export const accountOf = (row: SessionRow) =>
  ({
    id: row.account_id,
    code: row.account_code,
    name: row.account_name,
    role: row.account_role,
    normalSide: row.normal_side,
  }) as Reconciliation["account"];

function previousOf(rs: ReconcileState, accountId: string): Reconciliation["previous"] {
  const last = rs.store.lastActive(accountId);
  return last
    ? { id: last.id, statementDate: last.statement_date, statementBalance: last.statement_balance }
    : null;
}

export const voidOut = (row: {
  id: string;
  reason: string;
  voided_at: string;
  void_hash: string;
}): ReconcileVoid => ({
  id: row.id,
  reason: row.reason,
  voidedAt: row.voided_at,
  hash: row.void_hash,
});

const lineOf = (row: LineRow, selected: boolean): ReconcileLine => ({
  postingId: row.posting_id,
  journalId: row.journal_id,
  date: row.line_date,
  narration: row.narration,
  amount: row.amount,
  selected,
});

// ---- views ------------------------------------------------------------------------------------------

/** A draft, from its stored candidates and selection. No ledger read: every figure is exact
 * arithmetic on the stored amounts. `sequenceMoved` says the ledger has new entries since the
 * lines were read. */
function draftView(
  rs: ReconcileState,
  session: SessionRow,
  sequenceMoved: boolean,
): Reconciliation {
  const candidates = rs.store.candidates(session.id, session.statement_date);
  const selection = rs.store.selection(session.id);
  const known = new Set(candidates.map((row) => row.posting_id));
  const missing = [...selection].filter((id) => !known.has(id));
  const { cents: opening, last } = openingOf(rs, session.account_id);
  const chosen = candidates.filter((row) => selection.has(row.posting_id));
  const figures = reconcileFigures({
    opening,
    statement: parseMoney(session.statement_balance),
    selected: chosen.map((row) => parseMoney(row.amount)),
  });
  const baselineMoved = (last?.id ?? "") !== session.baseline;
  const warnings: ReconcileWarning[] = [];
  if (missing.length)
    warnings.push({
      code: "selection_stale",
      message: `${missing.length} selected line${missing.length === 1 ? " is" : "s are"} no longer available and ${missing.length === 1 ? "is" : "are"} not counted. Refresh the lines.`,
    });
  if (baselineMoved)
    warnings.push({
      code: "baseline_changed",
      message:
        "An earlier reconciliation of this account was voided after these lines were read. Refresh the lines before going on.",
    });
  let books = opening;
  for (const row of candidates) books += parseMoney(row.amount);
  return {
    id: session.id,
    status: "draft",
    version: session.version,
    account: accountOf(session),
    currency: session.currency,
    statementDate: session.statement_date,
    statementBalance: session.statement_balance,
    openingBalance: formatMoney(opening),
    selectedCount: figures.selectedCount,
    selectedTotal: figures.selectedTotal,
    clearedBalance: figures.clearedBalance,
    difference: figures.difference,
    canComplete: figures.canComplete && !missing.length && !baselineMoved,
    bookBalance: formatMoney(books),
    selectionHash: selectionHash(chosen.map((row) => row.posting_id)),
    stale: sequenceMoved || baselineMoved,
    snapshotRevision: session.snapshot_revision,
    previous: previousOf(rs, session.account_id),
    lines: candidates.map((row) => lineOf(row, selection.has(row.posting_id))),
    warnings,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    completedAt: null,
    recordHash: null,
    previousHash: null,
    void: null,
  };
}

/** A completed or voided reconciliation, from its frozen rows. */
function recordView(rs: ReconcileState, session: SessionRow): Reconciliation {
  const lines = rs.store.lines(session.id);
  const voided = rs.store.voidOf(session.id);
  const previous = session.previous_id ? rs.store.session(session.previous_id) : null;
  return {
    id: session.id,
    status: voided ? "voided" : "completed",
    version: session.version,
    account: accountOf(session),
    currency: session.currency,
    statementDate: session.statement_date,
    statementBalance: session.statement_balance,
    openingBalance: session.opening_balance ?? "0.00",
    selectedCount: lines.length,
    selectedTotal: session.selected_total ?? "0.00",
    clearedBalance: session.statement_balance,
    difference: "0.00",
    canComplete: false,
    bookBalance: null,
    selectionHash: selectionHash(lines.map((row) => row.posting_id)),
    stale: false,
    snapshotRevision: session.book_revision ?? session.snapshot_revision,
    previous: previous
      ? {
          id: previous.id,
          statementDate: previous.statement_date,
          statementBalance: previous.statement_balance,
        }
      : null,
    lines: lines.map((row) => lineOf(row, true)),
    warnings: [],
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    completedAt: session.completed_at,
    recordHash: session.record_hash,
    previousHash: session.previous_hash,
    void: voided ? voidOut(voided) : null,
  };
}

/** Whether the ledger has moved on since a draft's lines were read: one cheap page read. */
async function sequenceMoved(service: ApplicationService, session: SessionRow): Promise<boolean> {
  const tip = await service.ledgerHead();
  return tip.sequence !== session.snapshot_sequence;
}

async function viewOf(
  service: ApplicationService,
  rs: ReconcileState,
  session: SessionRow,
): Promise<Reconciliation> {
  return session.status === "open"
    ? draftView(rs, session, await sequenceMoved(service, session))
    : recordView(rs, session);
}

function progressOf(rs: ReconcileState, session: SessionRow): ReconcileProgress {
  const chosen = rs.store.selectedCandidates(session.id, session.statement_date);
  const { cents: opening, last } = openingOf(rs, session.account_id);
  const figures: Figures = reconcileFigures({
    opening,
    statement: parseMoney(session.statement_balance),
    selected: chosen.map((row) => parseMoney(row.amount)),
  });
  return {
    id: session.id,
    version: session.version,
    selectedCount: figures.selectedCount,
    selectedTotal: figures.selectedTotal,
    clearedBalance: figures.clearedBalance,
    difference: figures.difference,
    canComplete: figures.canComplete && (last?.id ?? "") === session.baseline,
    selectionHash: selectionHash(chosen.map((row) => row.posting_id)),
  };
}

// ---- reading the book into a draft ----------------------------------------------------------------

/** Every posting of the account on or before `through` that is not on a live reconciliation. */
function candidateRows(
  book: BookView,
  account: BookAccount,
  cleared: ReadonlySet<string>,
  through: string,
): Candidate[] {
  const rows: Candidate[] = [];
  for (const posting of book.postings.get(account.id) ?? []) {
    if (posting.date > through) break;
    if (cleared.has(posting.postingId)) continue;
    rows.push({
      posting_id: posting.postingId,
      journal_id: posting.journalId,
      line_date: posting.date,
      narration: clip(posting.narration),
      amount: formatMoney(effect(posting, account)),
      position: rows.length,
    });
  }
  return rows;
}

function tooMany(count: number, through: string, max: number): ApplicationError {
  return fail(
    "reconcile_too_many_lines",
    `${count} lines dated on or before ${through} are not on a reconciliation, more than the ${max} one reconciliation holds. Reconcile an earlier statement first: choose an earlier statement date.`,
    409,
    [{ path: "input.statementDate", message: through }],
  );
}

function dateError(
  problem: StatementDateProblem,
  date: string,
  last: string | null,
  today: string,
) {
  const path = [{ path: "input.statementDate", message: date }];
  if (problem === "invalid")
    return fail(
      "statement_date_invalid",
      `${date} is not a calendar date. Write the statement date as YYYY-MM-DD.`,
      400,
      path,
    );
  if (problem === "in_future")
    return fail(
      "statement_date_in_future",
      `${date} is after today (${today}). A statement cannot end in the future; check the date.`,
      400,
      path,
    );
  return fail(
    "statement_date_not_after_last",
    `The latest completed reconciliation for this account ends ${last}. A new statement must end after it. To redo an earlier statement, void the later reconciliations first, newest first.`,
    409,
    path,
  );
}

function resolveAccount(book: BookView, accountId: string): BookAccount {
  const account = book.accounts.get(accountId);
  if (!account)
    throw fail(
      "reconcile_account_not_found",
      `There is no account ${accountId} in this book.`,
      404,
    );
  if (!isReconcilable(account))
    throw fail(
      "reconcile_account_not_reconcilable",
      `${account.code} ${account.name} is an ${account.role} account. A statement describes money you have (an asset) or money you owe (a liability).`,
      409,
      [{ path: "input.accountId", message: account.role }],
    );
  return account;
}

const badBalance = () =>
  fail(
    "statement_balance_invalid",
    "Enter the statement balance exactly as printed, with two decimal places (for example 1234.50 or -12.00).",
    400,
    [{ path: "input.statementBalance", message: "Use exactly two decimal places" }],
  );

function assertPeriodOpen(book: BookView, statementDate: string, action: string): void {
  if (!book.state) return;
  const locked = lockedPeriodForDate(book.state, statementDate);
  if (locked)
    throw fail(
      "fiscal_period_admission",
      `Period ${locked.label} (${locked.startsOn} to ${locked.endsOn}) is closed. Reopen the period before ${action} a reconciliation dated ${statementDate}.`,
      409,
      [{ path: "statementDate", message: locked.label }],
    );
}

// ---- operations ------------------------------------------------------------------------------------------

export function startReconciliation(
  service: ApplicationService,
  operationId: string,
  input: { accountId: string; statementDate: string; statementBalance: string },
): Promise<Reconciliation> {
  const rs = reconcileState(service);
  return service.retainAsyncRequest(operationId, "reconcile.start", input, async () => {
    const balance = canonicalStatementBalance(input.statementBalance);
    if (balance === null) throw badBalance();
    // A retry after a crash between the write and the saved reply finds its own work.
    const resumed = rs.store.session(operationId);
    if (resumed) {
      if (
        resumed.account_id !== input.accountId ||
        resumed.statement_date !== input.statementDate ||
        resumed.statement_balance !== balance
      )
        throw fail(
          "operation_identity_conflict",
          "Operation identity was reused for different input",
          409,
        );
      return viewOf(service, rs, resumed);
    }
    const book = await rs.readBook();
    assertPeriodOpen(book, input.statementDate, "starting");
    const account = resolveAccount(book, input.accountId);
    const { last } = openingOf(rs, account.id);
    const problem = statementDateProblem(input.statementDate, {
      today: rs.today(),
      lastStatementDate: last?.statement_date ?? null,
    });
    if (problem)
      throw dateError(problem, input.statementDate, last?.statement_date ?? null, rs.today());
    const open = rs.store.openFor(account.id);
    if (open)
      throw fail(
        "reconcile_draft_exists",
        `${account.code} ${account.name} already has a reconciliation in progress (statement ${open.statement_date}). Finish it or discard it first.`,
        409,
        [{ path: "id", message: open.id }],
      );
    const rows = candidateRows(book, account, rs.store.activeIds(account.id), input.statementDate);
    if (rows.length > rs.maxLines) throw tooMany(rows.length, input.statementDate, rs.maxLines);
    const now = rs.now();
    try {
      rs.store.transaction(() => {
        rs.store.insertDraft({
          id: operationId,
          account_id: account.id,
          account_code: account.code,
          account_name: account.name,
          account_role: account.role,
          normal_side: account.normalSide,
          currency: book.currency,
          status: "open",
          statement_date: input.statementDate,
          statement_balance: balance,
          version: 1,
          last_operation: operationId,
          baseline: last?.id ?? "",
          snapshot_sequence: book.sequence,
          snapshot_revision: book.bookRevision,
          created_at: now,
          updated_at: now,
          seq: null,
          completed_at: null,
          completed_operation: null,
          opening_balance: null,
          selected_total: null,
          line_count: null,
          previous_id: null,
          previous_hash: null,
          record_hash: null,
          book_revision: null,
        });
        rs.store.replaceCandidates(operationId, rows);
      });
    } catch (error) {
      if (!isUnique(error)) throw error;
      const winner = rs.store.openFor(account.id);
      throw fail(
        "reconcile_draft_exists",
        `${account.code} ${account.name} already has a reconciliation in progress. Finish it or discard it first.`,
        409,
        winner ? [{ path: "id", message: winner.id }] : [],
      );
    }
    const session = rs.store.session(operationId);
    if (!session) throw new Error("The reconciliation was not retained");
    return draftView(rs, session, false);
  });
}

export async function getReconciliation(
  service: ApplicationService,
  input: { id: string },
): Promise<Reconciliation> {
  const rs = reconcileState(service);
  const session = rs.store.session(input.id);
  if (!session) throw fail("reconcile_not_found", "No reconciliation has that id.", 404);
  return viewOf(service, rs, session);
}

function requireOpen(rs: ReconcileState, id: string, expectedVersion: number): SessionRow {
  const session = rs.store.session(id);
  if (!session) throw fail("reconcile_not_found", "No reconciliation has that id.", 404);
  if (session.status !== "open")
    throw fail(
      "reconcile_not_open",
      "This reconciliation is already completed. A completed reconciliation can only be voided.",
      409,
    );
  if (session.version !== expectedVersion)
    throw fail(
      "reconcile_version_conflict",
      "This reconciliation changed since you loaded it (another window or agent edited it). Reload it and review before going on.",
      409,
      [{ path: "expectedVersion", message: String(session.version) }],
    );
  return session;
}

export function setCleared(
  service: ApplicationService,
  operationId: string,
  input: {
    id: string;
    expectedVersion: number;
    reset?: "all" | "none";
    select?: readonly string[];
    deselect?: readonly string[];
  },
): ReconcileProgress {
  const rs = reconcileState(service);
  return service.retainRequest(operationId, "reconcile.setCleared", input, () => {
    const session = requireOpen(rs, input.id, input.expectedVersion);
    const select = [...new Set(input.select ?? [])];
    const deselect = [...new Set(input.deselect ?? [])];
    const both = select.filter((id) => deselect.includes(id));
    if (both.length)
      throw fail(
        "reconcile_selection_conflict",
        "The same line is in both select and deselect.",
        400,
        both.slice(0, 5).map((id) => ({ path: "input.select", message: id })),
      );
    const known = rs.store.knownCandidates(session.id, session.statement_date, select);
    const unknown = select.filter((id) => !known.has(id));
    if (unknown.length)
      throw fail(
        "reconcile_line_unavailable",
        `${unknown.length} of the lines you selected ${unknown.length === 1 ? "is" : "are"} not on this reconciliation (already reconciled, dated after the statement, or not on this account). Refresh the lines.`,
        409,
        unknown.slice(0, 5).map((id) => ({ path: "input.select", message: id })),
      );
    if (input.reset === "all") rs.store.selectAllCandidates(session.id, session.statement_date);
    else if (input.reset === "none") rs.store.clearSelection(session.id);
    rs.store.addSelection(session.id, select);
    rs.store.removeSelection(session.id, deselect);
    const changed = rs.store.updateDraft(session.id, input.expectedVersion, {
      updated_at: rs.now(),
      last_operation: operationId,
    });
    if (!changed)
      throw fail("reconcile_version_conflict", "This reconciliation changed; reload it.", 409);
    const fresh = rs.store.session(session.id);
    if (!fresh) throw new Error("The reconciliation disappeared");
    return progressOf(rs, fresh);
  });
}

export function setStatement(
  service: ApplicationService,
  operationId: string,
  input: { id: string; expectedVersion: number; statementDate: string; statementBalance: string },
): Promise<Reconciliation> {
  const rs = reconcileState(service);
  return service.retainAsyncRequest(operationId, "reconcile.setStatement", input, async () => {
    const balance = canonicalStatementBalance(input.statementBalance);
    if (balance === null) throw badBalance();
    const existing = rs.store.session(input.id);
    // A retry after a crash between the write and the saved reply finds its own work.
    if (existing?.status === "open" && existing.last_operation === operationId)
      return draftView(rs, existing, await sequenceMoved(service, existing));
    const session = requireOpen(rs, input.id, input.expectedVersion);
    const book = await rs.readBook();
    assertPeriodOpen(book, input.statementDate, "updating");
    const account = resolveAccount(book, session.account_id);
    const { last } = openingOf(rs, account.id);
    const problem = statementDateProblem(input.statementDate, {
      today: rs.today(),
      lastStatementDate: last?.statement_date ?? null,
    });
    if (problem)
      throw dateError(problem, input.statementDate, last?.statement_date ?? null, rs.today());
    const rows = candidateRows(book, account, rs.store.activeIds(account.id), input.statementDate);
    if (rows.length > rs.maxLines) throw tooMany(rows.length, input.statementDate, rs.maxLines);
    const before = rs.store.candidates(session.id, "9999-12-31");
    const same =
      before.length === rows.length &&
      before.every(
        (row, at) =>
          row.posting_id === rows[at]?.posting_id &&
          row.journal_id === rows[at]?.journal_id &&
          row.amount === rows[at]?.amount,
      );
    const edited =
      input.statementDate !== session.statement_date ||
      balance !== session.statement_balance ||
      !same;
    rs.store.transaction(() => {
      const ok = rs.store.updateDraft(
        session.id,
        input.expectedVersion,
        {
          statement_date: input.statementDate,
          statement_balance: balance,
          snapshot_sequence: book.sequence,
          snapshot_revision: book.bookRevision,
          baseline: last?.id ?? "",
          updated_at: rs.now(),
          last_operation: operationId,
        },
        edited,
      );
      if (!ok)
        throw fail("reconcile_version_conflict", "This reconciliation changed; reload it.", 409);
      if (!same) rs.store.replaceCandidates(session.id, rows);
      rs.store.pruneSelection(session.id, input.statementDate);
    });
    const fresh = rs.store.session(session.id);
    if (!fresh) throw new Error("The reconciliation disappeared");
    return draftView(rs, fresh, false);
  });
}

export function discardReconciliation(
  service: ApplicationService,
  operationId: string,
  input: { id: string; expectedVersion: number },
): ReconcileDiscardResult {
  const rs = reconcileState(service);
  return service.retainRequest(operationId, "reconcile.discard", input, () => {
    requireOpen(rs, input.id, input.expectedVersion);
    if (!rs.store.deleteDraft(input.id, input.expectedVersion))
      throw fail("reconcile_version_conflict", "This reconciliation changed; reload it.", 409);
    return { disposition: "discarded", id: input.id } as const;
  });
}

/** The fingerprint a completed record carries. Also how a report checks the record is what it was: the
 * same fields, hashed the same way, must give the same digest. */
export function recordHash(input: {
  id: string;
  session: SessionRow;
  openingBalance: string;
  previous: SessionRow | null;
  bookRevision: string;
  completedAt: string;
  lines: readonly LineRow[];
}): string {
  return hashCanonical({
    type: "RastrataReconciliationRecord",
    format: 1n,
    id: input.id,
    accountId: input.session.account_id,
    currency: input.session.currency,
    statementDate: input.session.statement_date,
    statementBalance: input.session.statement_balance,
    openingBalance: input.openingBalance,
    previousId: input.previous?.id ?? null,
    previousHash: input.previous?.record_hash ?? null,
    bookRevision: input.bookRevision,
    completedAt: input.completedAt,
    lines: input.lines.map((line) => ({
      postingId: line.posting_id,
      journalId: line.journal_id,
      date: line.line_date,
      amount: line.amount,
      narration: line.narration,
    })),
  }).digest;
}

export function completeReconciliation(
  service: ApplicationService,
  operationId: string,
  input: { id: string; expectedVersion: number },
): Promise<Reconciliation> {
  const rs = reconcileState(service);
  return service.retainAsyncRequest(operationId, "reconcile.complete", input, async () => {
    const existing = rs.store.session(input.id);
    // A retry after a crash between the write and the saved reply finds its own work.
    if (existing?.status === "completed" && existing.completed_operation === operationId)
      return recordView(rs, existing);
    const session = requireOpen(rs, input.id, input.expectedVersion);
    // The one place the draft is checked against the ledger itself, as it is now.
    const book = await rs.readBook();
    assertPeriodOpen(book, session.statement_date, "completing");
    const account = resolveAccount(book, session.account_id);
    const { cents: opening, last } = openingOf(rs, account.id);
    if ((last?.id ?? "") !== session.baseline)
      throw fail(
        "reconcile_stale",
        "An earlier reconciliation of this account was voided or completed after these lines were read. Refresh the lines before completing.",
        409,
      );
    assertClearedHistory(rs, account.id, opening);
    const cleared = rs.store.activeIds(account.id);
    const live = new Map<string, BookPosting>();
    for (const posting of book.postings.get(account.id) ?? []) {
      if (posting.date > session.statement_date) break;
      if (!cleared.has(posting.postingId)) live.set(posting.postingId, posting);
    }
    const candidates = rs.store.candidates(session.id, session.statement_date);
    const selection = rs.store.selection(session.id);
    const candidateIds = new Set(candidates.map((row) => row.posting_id));
    const unavailable: string[] = [...selection].filter((id) => !candidateIds.has(id));
    const lines: (LineRow & { account_id: string })[] = [];
    for (const row of candidates) {
      if (!selection.has(row.posting_id)) continue;
      const posting = live.get(row.posting_id);
      if (
        !posting ||
        posting.journalId !== row.journal_id ||
        posting.date !== row.line_date ||
        formatMoney(effect(posting, account)) !== row.amount
      )
        unavailable.push(row.posting_id);
      else
        lines.push({
          posting_id: row.posting_id,
          journal_id: row.journal_id,
          line_date: row.line_date,
          narration: row.narration,
          amount: row.amount,
          account_id: account.id,
        });
    }
    if (unavailable.length)
      throw fail(
        "reconcile_selection_stale",
        `${unavailable.length} selected line${unavailable.length === 1 ? " is" : "s are"} no longer in the book as selected. Refresh the lines and review the selection.`,
        409,
        unavailable.slice(0, 5).map((id) => ({ path: "selection", message: id })),
      );
    const figures = reconcileFigures({
      opening,
      statement: parseMoney(session.statement_balance),
      selected: lines.map((line) => parseMoney(line.amount)),
    });
    if (!figures.canComplete)
      throw fail(
        "reconcile_difference",
        `The difference is ${figures.difference}. A reconciliation can only be completed at exactly 0.00; select the lines on the statement, or correct the statement balance.`,
        409,
        [{ path: "difference", message: figures.difference }],
      );
    const completedAt = rs.now();
    try {
      rs.store.transaction(() => {
        const fresh = requireOpen(rs, input.id, input.expectedVersion);
        const previous = rs.store.lastActive(account.id);
        if ((previous?.id ?? "") !== fresh.baseline)
          throw fail(
            "reconcile_stale",
            "An earlier reconciliation changed; refresh the lines.",
            409,
          );
        const stored = rs.store.complete({
          id: fresh.id,
          expectedVersion: input.expectedVersion,
          seq: rs.store.nextSequence(account.id),
          completedAt,
          operationId,
          openingBalance: formatMoney(opening),
          selectedTotal: figures.selectedTotal,
          previousId: previous?.id ?? null,
          previousHash: previous?.record_hash ?? null,
          recordHash: recordHash({
            id: fresh.id,
            session: fresh,
            openingBalance: formatMoney(opening),
            previous,
            bookRevision: book.bookRevision,
            completedAt,
            lines,
          }),
          bookRevision: book.bookRevision,
          snapshotSequence: book.sequence,
          lines,
        });
        if (!stored)
          throw fail("reconcile_version_conflict", "This reconciliation changed; reload it.", 409);
      });
    } catch (error) {
      if (!isUnique(error)) throw error;
      throw fail(
        "reconcile_line_conflict",
        "One of these lines was reconciled by another reconciliation while this one was being completed. Refresh the lines.",
        409,
      );
    }
    const done = rs.store.session(input.id);
    if (!done) throw new Error("The reconciliation disappeared");
    return recordView(rs, done);
  });
}

export function voidReconciliation(
  service: ApplicationService,
  operationId: string,
  input: { id: string; reason: string },
): Promise<Reconciliation> {
  const rs = reconcileState(service);
  return service.retainAsyncRequest(operationId, "reconcile.void", input, async () => {
    const session = rs.store.session(input.id);
    if (!session) throw fail("reconcile_not_found", "No reconciliation has that id.", 404);
    if (session.status !== "completed")
      throw fail(
        "reconcile_not_completed",
        "Only a completed reconciliation can be voided. Discard a draft instead.",
        409,
      );
    if (rs.store.voidOf(session.id))
      throw fail("reconcile_already_voided", "This reconciliation is already voided.", 409);
    const book = await rs.readBook();
    assertPeriodOpen(book, session.statement_date, "voiding");
    const last = rs.store.lastActive(session.account_id);
    if (!last || last.id !== session.id)
      throw fail(
        "reconcile_void_out_of_order",
        `A later reconciliation (statement ${last?.statement_date ?? "unknown"}) continues from this one. Void the later one first; reconciliations are voided newest first.`,
        409,
        last ? [{ path: "id", message: last.id }] : [],
      );
    const reason = input.reason.trim();
    const voidedAt = rs.now();
    const voidId = crypto.randomUUID();
    rs.store.appendVoid({
      id: voidId,
      session_id: session.id,
      reason,
      voided_at: voidedAt,
      void_hash: hashCanonical({
        type: "RastrataReconciliationVoid",
        format: 1n,
        id: voidId,
        reconciliationId: session.id,
        recordHash: session.record_hash,
        reason,
        voidedAt,
      }).digest,
      void_operation: operationId,
    });
    return recordView(rs, session);
  });
}

export function listReconciliations(
  service: ApplicationService,
  input: { accountId?: string; status?: "draft" | "completed" | "voided"; page?: number },
): ReconcileList {
  const rs = reconcileState(service);
  const page = input.page ?? 1;
  const pageSize = 25;
  const { count, rows } = rs.store.list({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.status ? { status: input.status } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    count,
    page,
    pageSize,
    items: rows.map((row): ReconciliationSummary => summaryOf(rs, row)),
  };
}

function summaryOf(rs: ReconcileState, row: ListedRow): ReconciliationSummary {
  const voided = row.void_id
    ? voidOut({
        id: row.void_id,
        reason: row.void_reason ?? "",
        voided_at: row.void_at ?? "",
        void_hash: row.void_hash ?? "",
      })
    : null;
  return {
    id: row.id,
    status: row.status === "open" ? "draft" : voided ? "voided" : "completed",
    account: accountOf(row),
    statementDate: row.statement_date,
    statementBalance: row.statement_balance,
    openingBalance:
      row.status === "open"
        ? formatMoney(openingOf(rs, row.account_id).cents)
        : (row.opening_balance ?? "0.00"),
    lineCount: row.status === "open" ? row.selected : (row.line_count ?? 0),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    recordHash: row.record_hash,
    void: voided,
  };
}

export async function reconcileStatus(
  service: ApplicationService,
  input: { accountId?: string; all?: boolean },
): Promise<ReconcileStatus> {
  const rs = reconcileState(service);
  const book = await rs.readBook();
  const tracked = rs.store.trackedAccountIds();
  const imported = statementAccountIds(service);
  const tags = readAccountTags(service.store);
  const today = rs.today();
  const clearedGeneration = rs.store.clearedGeneration();
  const accounts: ReconcileAccountStatus[] = [];
  for (const account of [...book.accounts.values()].filter(isReconcilable).sort(byCode)) {
    if (input.accountId && account.id !== input.accountId) continue;
    const isTracked =
      tracked.has(account.id) ||
      imported.has(account.id) ||
      isTaggedBankOrCard(tags.tagsFor(account.id, today));
    if (!isTracked && !input.all && !input.accountId) continue;
    const listed = book.postings.get(account.id) ?? [];
    const total = book.totals?.get(account.id);
    let uncleared = 0;
    let unclearedTotal = 0n;
    let oldest: string | null = null;
    let books = 0n;
    if (book.state !== undefined && (total !== undefined || listed.length === 0)) {
      // What the account's cleared postings come to is kept beside the book (`figures.ts`) and its balance is the sum
      // the index keeps, so the status is a subtraction and not a pass over the postings.
      const figures = clearedFigures({
        state: book.state,
        book,
        generation: clearedGeneration,
        account,
        cleared: () => rs.store.activeIds(account.id),
      });
      books = statementAmount(total ?? 0n, account.normalSide);
      uncleared = listed.length - figures.cleared;
      unclearedTotal = books - figures.clearedEffect;
      oldest = figures.oldest;
    } else {
      const cleared = rs.store.activeIds(account.id);
      for (const posting of listed) {
        const amount = effect(posting, account);
        books += amount;
        if (cleared.has(posting.postingId)) continue;
        uncleared += 1;
        unclearedTotal += amount;
        oldest ??= posting.date;
      }
    }
    const last = rs.store.lastActive(account.id);
    const open = rs.store.openFor(account.id);
    accounts.push({
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        role: account.role as Reconciliation["account"]["role"],
        normalSide: account.normalSide,
      },
      tracked: isTracked,
      lastReconciledDate: last?.statement_date ?? null,
      lastReconciledBalance: last?.statement_balance ?? null,
      lastReconciliationId: last?.id ?? null,
      openReconciliationId: open?.id ?? null,
      unclearedCount: uncleared,
      unclearedTotal: formatMoney(unclearedTotal),
      oldestUnclearedDate: oldest,
      bookBalance: formatMoney(books),
    });
  }
  return { bookRevision: book.bookRevision, accounts };
}

/** Which postings of these journals are cleared. Reads product state only. */
export function clearedPostings(
  service: ApplicationService,
  journalIds: readonly string[],
): ReconcileCleared {
  const rows = reconcileState(service).store.activeForJournals(journalIds);
  return {
    postings: rows.map((row) => ({
      journalId: row.journal_id,
      postingId: row.posting_id,
      accountId: row.account_id,
      reconciliationId: row.session_id,
      statementDate: row.statement_date,
    })),
  };
}

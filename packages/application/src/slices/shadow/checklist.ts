/** The cutover checklist as an operation: gather what the other lanes report, through their own
 * operations, and hand it to the pure rules in `shadow/checklist.ts`. A section that cannot be read
 * is reported as unavailable and keeps the verdict at "not yet": a check that did not run is never
 * mistaken for one that passed. */
import { MAX_OPEN_PERIODS } from "./schema.ts";
import type {
  BackupStatus,
  ChecklistInput,
  CutoverChecklist,
  InboxPage,
  InboxSummary,
  PayeeTotals,
  PeriodList,
  Reconciliation,
  ReconcileStatus,
  StripeStatus,
} from "../../client-contracts.gen.ts";
import { CATCHALL_EXPENSE, CATCHALL_INCOME } from "../../chart/tags.ts";
import { ApplicationError } from "../../errors.ts";
import {
  type AccountFacts,
  type AccountReason,
  type BackupFacts,
  type CatchAllFacts,
  type InboxFacts,
  type Largest,
  type OtherAccountFacts,
  type PeriodFacts,
  type Section,
  type StripeFacts,
  choosePeriod,
  evaluateChecklist,
  largestOf,
} from "../../shadow/checklist.ts";
import type { SliceContext } from "../types.ts";
import { type Chart, type ChartAccount, readChart, readPeriods } from "./chart.ts";
import type { BookState } from "../ingest/ledger-view.ts";
import { callOperation } from "./operations.ts";
import { findHandMadeOpening, handMadeExisting, openingStatus } from "./opening.ts";
import { shadowStore } from "./store.ts";

const WAITING = ["new", "proposed", "drafted"];
/** The accounts the Stripe lane books through. They have no statement: Stripe's own balance and its
 * payouts are checked in the Stripe section instead. */
const STRIPE_ROLE_KEYS: ReadonlySet<string> = new Set(["stripe.balance", "payouts.in-transit"]);

type Gap = { section: Section; reason: string };

/** Run a read; a failure becomes a note that the section could not be read, never an exception. */
async function section<T>(
  gaps: Gap[],
  name: Section,
  what: string,
  work: () => Promise<T>,
): Promise<T | null> {
  try {
    return await work();
  } catch (cause) {
    const detail =
      cause instanceof ApplicationError ? cause.message : "an unexpected error stopped it";
    gaps.push({ section: name, reason: `Could not read ${what}: ${detail}` });
    return null;
  }
}

/** A period as the checklist's output names it: its dates and status. Whether it is before the books
 * began is what kept it out of the lists, not part of what a list says. */
const withoutFlag = ({ beforeBooks: _kept, ...period }: PeriodFacts) => period;

const periodFacts = (list: PeriodList): PeriodFacts[] =>
  list.periods.map((period) => ({
    id: period.id,
    label: `${period.label} ${period.startsOn.slice(0, 4)}`,
    startsOn: period.startsOn,
    endsOn: period.endsOn,
    status: period.status,
    ended: period.ended,
    beforeBooks: period.beforeBooks,
  }));

/** Stripe's control, when the business uses Stripe. */
function stripeFacts(status: StripeStatus | null): StripeFacts | null {
  if (status === null || !status.configured) return null;
  const { balance, payouts } = status;
  return {
    compared: balance.snapshot !== null,
    ties: balance.ties,
    difference: balance.difference,
    unpaid: balance.unpaid,
    inTransit: balance.inTransit,
    readAt: balance.snapshot?.readAt ?? null,
    stale: balance.stale,
    explanation: balance.explanation,
    payouts: {
      known: payouts.known,
      booked: payouts.booked,
      waiting: payouts.waiting,
      mismatched: payouts.mismatched,
      held: payouts.held,
      unmatched: payouts.unmatched,
      overdue: payouts.overdue,
      oldestOverdueOn: payouts.oldestOverdueOn,
    },
  };
}

function backupFacts(status: BackupStatus | null, reason: string | null): BackupFacts {
  if (status === null)
    return {
      available: false,
      ...(reason ? { reason } : {}),
      verifiedAt: null,
      ageHours: null,
      limitHours: 48,
      drill: null,
    };
  const verification = status.latestVerified?.verification ?? null;
  const verifiedAt = verification?.passed ? verification.verifiedAt : null;
  const age =
    verifiedAt !== null
      ? Math.max(
          0,
          Math.floor((Date.parse(status.generatedAt) - Date.parse(verifiedAt)) / 3_600_000),
        )
      : null;
  return {
    available: true,
    verifiedAt,
    ageHours: age,
    limitHours: status.settings.warnAfterHours,
    drill: status.lastDrill
      ? { ranAt: status.lastDrill.ranAt, passed: status.lastDrill.passed }
      : null,
  };
}

/** Why an account of the chart is one to prove by statement, or null when nothing says it is. */
function reasonFor(
  row: ReconcileStatus["accounts"][number],
  chosen: boolean,
  hasSource: boolean,
): AccountReason | null {
  if (chosen) return "chosen";
  if (row.lastReconciledDate !== null || row.openReconciliationId !== null) return "reconciled";
  if (hasSource) return "imported";
  return row.tracked ? "cash" : null;
}

/** The places the money of a catch-all account went, from the report by payee limited to that account.
 * A place has no count of its own: the report counts an entry that was reversed, and its reversal, as two
 * transactions that add up to nothing, which a count in a sentence must not. */
function catchAllMonth(
  totals: PayeeTotals,
  side: "spent" | "received",
  entries: number,
): CatchAllFacts["month"] {
  const places: Largest[] = [
    ...totals.rows
      .slice(0, 5)
      .map((row) => ({ name: row.name, amount: row[side], kind: "payee" as const })),
    ...totals.unnamed
      .slice(0, 5)
      .map((row) => ({ name: row.text, amount: row[side], kind: "unnamed" as const })),
    ...totals.ambiguous
      .slice(0, 5)
      .map((row) => ({ name: row.text, amount: row[side], kind: "ambiguous" as const })),
    { name: "Entered by hand", amount: totals.noPayee.byHand[side], kind: "by_hand" as const },
    {
      name: "No bank text",
      amount: totals.noPayee.noBankText[side],
      kind: "no_bank_text" as const,
    },
  ];
  return { amount: totals.totals[side], transactions: entries, largest: largestOf(places, 5) };
}

/** How many entries an account has in a period as it stands at the end of it: those that touch the account
 * and are dated in the period, less an entry reversed or replaced by then and the reversal that took it
 * back. (The report by payee counts the reversed entry and its reversal as two transactions; they add up to
 * nothing and are not two transactions to a person.) */
function entriesIn(state: BookState, accountId: string, from: string, to: string): number {
  const dated = new Map(
    state.journals.map((booked) => [
      booked.journal.id as string,
      booked.journal.accountingDate as string,
    ]),
  );
  const gone = new Set<string>();
  for (const link of state.corrections) {
    const correctedOn = dated.get(link.correctionJournalId);
    if (correctedOn === undefined || correctedOn > to) continue;
    gone.add(link.originalJournalId);
    if (link.kind === "reversal") gone.add(link.correctionJournalId);
  }
  let count = 0;
  for (const booked of state.journals) {
    const date = booked.journal.accountingDate as string;
    if (date < from || date > to || gone.has(booked.journal.id as string)) continue;
    if (booked.journal.postings.some((posting) => posting.accountId === accountId)) count += 1;
  }
  return count;
}

/** What each catch-all account the book marks took in the period, from the report by payee limited to
 * that account (read through its operation, like every other fact here) and a count of its entries from
 * the ledger's state. A book that marks none is asked nothing. An account whose figures cannot be read is
 * carried with why, and the rules say that it could not be checked: it is never left out quietly, and it
 * never holds up the verdict, which is a note's place. */
async function catchAllFacts(
  context: SliceContext,
  chart: Chart,
  period: PeriodFacts | null,
): Promise<CatchAllFacts[]> {
  if (period === null) return [];
  const facts: CatchAllFacts[] = [];
  for (const [key, role] of [
    [CATCHALL_EXPENSE, "expense"],
    [CATCHALL_INCOME, "income"],
  ] as const) {
    const account = chart.accounts.find(
      (item) => item.roleKey === key && item.closedOn === null && item.role === role,
    );
    if (!account) continue;
    const shown = { id: account.id, code: account.code, name: account.name, role };
    const side = role === "expense" ? "spent" : "received";
    try {
      const totals = await callOperation<PayeeTotals>(context, "payees.totals", {
        asOf: period.endsOn,
        from: period.startsOn,
        accountIds: [account.id],
        direction: side,
        pageSize: 20,
      });
      const { aggregate } = await context.service.readAggregate();
      const entries = entriesIn(aggregate.state, account.id, period.startsOn, period.endsOn);
      facts.push({ account: shown, month: catchAllMonth(totals, side, entries) });
    } catch (cause) {
      facts.push({
        account: shown,
        month: null,
        reason:
          cause instanceof ApplicationError ? cause.message : "an unexpected error stopped it",
      });
    }
  }
  return facts;
}

export async function cutoverChecklist(
  context: SliceContext,
  input: ChecklistInput,
): Promise<CutoverChecklist> {
  const { service } = context;
  const gaps: Gap[] = [];
  const chart = await readChart(context);
  const recorded = shadowStore(service).cutover();
  const tool = await openingStatus(service);
  const cutover = recorded
    ? { date: recorded.cutoverOn, basis: "recorded" as const }
    : tool.existing.status === "posted" && tool.existing.cutoverDate
      ? { date: tool.existing.cutoverDate, basis: "opening_entry" as const }
      : null;
  // Opening balances entered by hand, as the tutorial says, are the opening entry too: the check is
  // that the books start from the real balances, not which tool wrote the entry.
  const handMade =
    tool.existing.status === "posted"
      ? null
      : await findHandMadeOpening(service, chart, cutover?.date ?? null, tool.ownJournalIds);
  const existing = handMade ? handMadeExisting(handMade) : tool.existing;

  const periodList = await section(gaps, "periods", "the fiscal calendar", () =>
    readPeriods(context),
  );
  const periods = periodList ? periodFacts(periodList) : null;
  if (
    input.periodId !== undefined &&
    periods !== null &&
    !periods.some((item) => item.id === input.periodId)
  )
    throw new ApplicationError(
      "period_not_found",
      "That period is not in the book's calendar.",
      404,
    );
  const period = periods ? choosePeriod(periods, cutover?.date ?? null, input.periodId) : null;
  const through = period?.endsOn;

  const reconcile = await section(gaps, "accounts", "reconciliation status", () =>
    callOperation<ReconcileStatus>(context, "reconcile.status", { all: true }),
  );
  const summary = await section(gaps, "inbox", "the Inbox", () =>
    callOperation<InboxSummary>(context, "inbox.summary"),
  );
  const usesStripe = chart.accounts.some((account) => STRIPE_ROLE_KEYS.has(account.roleKey ?? ""));
  const stripe = usesStripe
    ? stripeFacts(
        await section(gaps, "stripe", "Stripe's balance", () =>
          callOperation<StripeStatus>(context, "stripe.status", {}),
        ),
      )
    : null;
  // The backups report their own availability, so a runtime without them is one line, not two. A runtime that makes exports and no backups is a hosted one, which keeps the history of the books
  // itself: it is not asked, and it is not a fault that there is nothing to read.
  const keptByService = !service.host.safety && service.host.exports !== undefined;
  const backupGaps: Gap[] = [];
  const backupStatus = keptByService
    ? null
    : await section(backupGaps, "backups", "the backups", () =>
        callOperation<BackupStatus>(context, "backup.status"),
      );
  const backups: BackupFacts = keptByService
    ? { ...backupFacts(null, null), keptByService: true }
    : backupFacts(backupStatus, backupGaps[0]?.reason ?? null);

  // The Inbox, counted for each account through the end of the period.
  const waitingFor = async (filter: Record<string, unknown>) => {
    const page = await callOperation<InboxPage>(context, "inbox.list", {
      filter: { status: WAITING, covered: false, ...(through ? { to: through } : {}), ...filter },
      sort: "date_asc",
      pageSize: 1,
    });
    return { count: page.count, oldestOn: page.items[0]?.line.date ?? null };
  };
  let inbox: InboxFacts = { available: false, waiting: 0, oldestOn: null, toReview: 0 };
  if (summary !== null) {
    const all = await section(gaps, "inbox", "the Inbox", () => waitingFor({}));
    if (all)
      inbox = {
        available: true,
        waiting: all.count,
        oldestOn: all.oldestOn,
        toReview: summary.counts.toReview,
      };
  }

  const byId = new Map(chart.accounts.map((account: ChartAccount) => [account.id, account]));
  const chosen = new Set(recorded?.accountIds ?? []);
  const accounts: AccountFacts[] = [];
  const others: OtherAccountFacts[] = [];
  for (const row of reconcile?.accounts ?? []) {
    const account = byId.get(row.account.id);
    if (!account || account.closedOn !== null || STRIPE_ROLE_KEYS.has(account.roleKey ?? ""))
      continue;
    const sources = (summary?.sources ?? []).filter((item) => item.ledgerAccountId === account.id);
    const reason = reasonFor(row, chosen.has(account.id), sources.length > 0);
    if (reason === null) {
      if (row.bookBalance !== "0.00")
        others.push({
          id: account.id,
          code: account.code,
          name: account.name,
          role: account.role,
          balance: row.bookBalance,
        });
      continue;
    }
    let draft: AccountFacts["draft"] = null;
    if (row.openReconciliationId !== null) {
      const id = row.openReconciliationId;
      const open = await section(
        gaps,
        "accounts",
        `the draft reconciliation of ${account.code}`,
        () => callOperation<Reconciliation>(context, "reconcile.get", { id }),
      );
      if (open)
        draft = {
          id: open.id,
          statementDate: open.statementDate,
          statementBalance: open.statementBalance,
          difference: open.difference,
        };
    }
    const waiting = !inbox.available
      ? null
      : sources.length === 0
        ? { count: 0, oldestOn: null }
        : await section(gaps, "inbox", "the Inbox", () =>
            waitingFor({ ledgerAccountId: account.id }),
          );
    accounts.push({
      id: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      kind: account.role === "liability" ? "card" : "bank",
      reason,
      bookBalance: row.bookBalance,
      lastReconciliation:
        row.lastReconciledDate !== null
          ? { date: row.lastReconciledDate, balance: row.lastReconciledBalance ?? "0.00" }
          : null,
      draft,
      uncleared: {
        count: row.unclearedCount,
        total: row.unclearedTotal,
        oldestOn: row.oldestUnclearedDate,
      },
      waiting,
    });
  }

  const unavailable = gaps.filter(
    (gap, index) =>
      gaps.findIndex((other) => other.section === gap.section && other.reason === gap.reason) ===
      index,
  );
  const catchAll = await catchAllFacts(context, chart, period);
  const result = evaluateChecklist({
    today: service.today(),
    cutover,
    opening: existing.status,
    periods,
    period,
    accounts: reconcile ? accounts : null,
    otherAccounts: others,
    inbox,
    stripe,
    backups,
    unavailable,
    catchAll,
  });
  const { aggregate } = await service.readAggregate();
  return {
    asOf: service.today(),
    bookRevision: aggregate.state.bookRevision.toString(),
    // The posting sequence counts the entries, so this is whether there is one without copying the list.
    hasHistory: aggregate.state.latestPostingSequence > 0n,
    historyImported: service.historyImported(),
    currency: chart.currency,
    cutover,
    opening: existing,
    period: result.period ? withoutFlag(result.period) : null,
    verdict: {
      state: result.verdict.state,
      summary: result.verdict.summary,
      blocking: result.verdict.blocking.map((reason) => ({ ...reason })),
      attention: result.verdict.attention.map((reason) => ({ ...reason })),
    },
    accounts: result.accounts.map((item) => ({
      accountId: item.accountId,
      code: item.code,
      name: item.name,
      role: item.role as CutoverChecklist["accounts"][number]["role"],
      kind: item.kind,
      reason: item.reason,
      bookBalance: item.bookBalance,
      hasActivity: item.hasActivity,
      lastReconciliation: item.lastReconciliation,
      throughPeriodEnd: item.throughPeriodEnd,
      draft: item.draft,
      unreconciled: item.unreconciled,
      uncleared: item.uncleared,
      status: item.status,
      reasons: item.reasons.map((reason) => ({ ...reason })),
    })),
    otherAccounts: others.map((item) => ({
      accountId: item.id,
      code: item.code,
      name: item.name,
      role: item.role as CutoverChecklist["otherAccounts"][number]["role"],
      balance: item.balance,
    })),
    stripe: result.stripe
      ? { ...result.stripe, reasons: result.stripe.reasons.map((reason) => ({ ...reason })) }
      : null,
    inbox: {
      available: inbox.available,
      waiting: inbox.waiting,
      oldestOn: inbox.oldestOn,
      toReview: inbox.toReview,
    },
    backups: {
      available: backups.available,
      ...(backups.keptByService ? { keptByService: true } : {}),
      ...(backups.reason ? { reason: backups.reason } : {}),
      verifiedAt: backups.verifiedAt,
      ageHours: backups.ageHours,
      limitHours: backups.limitHours,
      drill: backups.drill,
    },
    openPeriods: result.openPeriods.slice(0, MAX_OPEN_PERIODS).map(withoutFlag),
    shadowRun: result.shadowRun
      ? {
          required: result.shadowRun.required,
          provenCount: result.shadowRun.provenCount,
          provenThrough: result.shadowRun.provenThrough,
          complete: result.shadowRun.complete,
          months: result.shadowRun.months.map((month) => ({ ...month })),
        }
      : null,
    unavailable: unavailable.map((gap) => ({ ...gap })),
    notes: result.notes.map((note) => ({
      code: note.code,
      message: note.message,
      account: { ...note.account },
      ...(note.from !== undefined && note.to !== undefined
        ? {
            from: note.from,
            to: note.to,
            ...(note.amount !== undefined ? { amount: note.amount } : {}),
            ...(note.transactions !== undefined ? { transactions: note.transactions } : {}),
            largest: (note.largest ?? []).map((place) => ({ ...place })),
          }
        : {}),
    })),
  };
}

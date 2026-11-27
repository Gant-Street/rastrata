/** The shadow screens' logic, apart from the screens: what a typed balance means, the entry's
 * figures while the person types, the input the service is sent, and how the service's answers are
 * shown. Pure functions, so every rule is a unit test. Money is exact: integer cents through
 * `money.ts`, never a number, never a float.
 *
 * The arithmetic is the same code the service uses to review and to post (`shadow/opening.ts`), so
 * the figure on the screen while typing is the figure the review will check. */
import type {
  CutoverChecklist,
  CutoverState,
  OpeningReview,
} from "@rastrata/application/client-contracts";
import { formatMoney, normalizeMoney, parseMoney } from "@rastrata/application/money";
import { formatFiguresInText } from "@rastrata/ui/format";
import {
  type OpeningRole,
  debitCents,
  openingTotals,
  resolveOffset,
} from "@rastrata/application/shadow-opening";
import type {
  ChecklistAccountView,
  ChecklistPeriodView,
  ChecklistReasonView,
  ChecklistSection,
  ChecklistView,
  CutoverAccountView,
  CutoverSourceView,
  OpeningBalanceSection,
  OpeningEntryView,
  OpeningIssueView,
  OpeningOffsetView,
  OpeningTotalsView,
  ShadowCardSummary,
} from "@rastrata/ui/shadow/types";

export interface ChartRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: OpeningRole;
  readonly openedOn: string;
  readonly closedOn: string | null;
}

/** What a typed amount reads as, or null when it is not an amount. Exact: more than two decimals is
 * refused, never rounded. An empty box is "nothing entered", not zero. */
export function readAmount(text: string): {
  readonly kind: "empty" | "ok" | "bad";
  readonly cents: bigint;
} {
  if (text.trim() === "") return { kind: "empty", cents: 0n };
  // The shared formatter writes a real minus sign (U+2212), so a figure it showed reads again.
  const normal = normalizeMoney(text.replace(/\u2212/g, "-"));
  return normal === null ? { kind: "bad", cents: 0n } : { kind: "ok", cents: parseMoney(normal) };
}

/** After the person leaves a field, an amount that reads becomes the canonical figure ("12000.00");
 * the screen then shows it through the shared formatter. Text that is not an amount is left exactly
 * as typed so it can be corrected. */
export function tidy(text: string): string {
  const read = readAmount(text);
  return read.kind === "ok" ? formatMoney(read.cents) : text;
}

/** The offset the entry will use: the equity account the person chose, or the one named for opening
 * balances. `none` while it cannot be told. */
export function offsetFor(
  chart: readonly ChartRow[],
  chosen: string,
): { readonly account: ChartRow | null; readonly problem: boolean } {
  const result = resolveOffset(chart, chosen === "" ? undefined : chosen);
  return "account" in result
    ? { account: chart.find((row) => row.id === result.account.id) ?? null, problem: false }
    : { account: null, problem: true };
}

/** The equity accounts that can carry the difference. */
export const offsetChoices = (chart: readonly ChartRow[]) =>
  chart
    .filter((row) => row.role === "equity" && row.closedOn === null)
    .map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }));

export interface EntryFigures {
  readonly entered: OpeningTotalsView;
  readonly totals: OpeningTotalsView;
  readonly offset: OpeningOffsetView | null;
  /** Amounts that cannot be read. */
  readonly problems: number;
  /** At least one amount that is not zero is typed. */
  readonly anyEntered: boolean;
}

/** The totals under the table, from what is typed now. The offset is whatever makes the entry
 * balance: the debits less the credits, on the other side. */
export function entryFigures(
  chart: readonly ChartRow[],
  values: Readonly<Record<string, string>>,
  offsetId: string,
): EntryFigures {
  const offset = offsetFor(chart, offsetId);
  const rows: { role: OpeningRole; balance: string }[] = [];
  let problems = 0;
  let anyEntered = false;
  for (const row of chart) {
    if (offset.account?.id === row.id) continue;
    const read = readAmount(values[row.id] ?? "");
    if (read.kind === "bad") problems++;
    else if (read.kind === "ok") {
      rows.push({ role: row.role, balance: formatMoney(read.cents) });
      if (read.cents !== 0n) anyEntered = true;
    }
  }
  const sums = openingTotals(rows);
  const net = parseMoney(sums.net);
  const side: OpeningOffsetView["side"] = net === 0n ? "none" : net > 0n ? "credit" : "debit";
  const amount = formatMoney(net < 0n ? -net : net);
  // With no account to take the difference the sides are not made to agree: the total shows what
  // was entered, so the screen cannot say "balanced" about an entry that cannot be posted.
  const taken = offset.account === null ? 0n : parseMoney(amount);
  const totals: OpeningTotalsView = {
    debit: formatMoney(parseMoney(sums.debit) + (side === "debit" ? taken : 0n)),
    credit: formatMoney(parseMoney(sums.credit) + (side === "credit" ? taken : 0n)),
  };
  return {
    entered: { debit: sums.debit, credit: sums.credit },
    totals,
    offset: offset.account
      ? { code: offset.account.code, name: offset.account.name, side, amount }
      : null,
    problems,
    anyEntered,
  };
}

/** The table's sections for the open accounts of the chart. The offset account is not a row: it is
 * calculated. Income and expense accounts are optional year-to-date balances, collapsed until asked
 * for (or until one already has an amount in it). */
export interface SectionText {
  readonly assets: string;
  readonly liabilities: string;
  readonly equity: string;
  readonly profitLoss: string;
  readonly profitLossHint: string;
  /** Said beside an amount that is not an amount. */
  readonly amountProblem: string;
}

export function entrySections(
  chart: readonly ChartRow[],
  values: Readonly<Record<string, string>>,
  offsetId: string,
  showProfitLoss: boolean,
  text: SectionText,
): OpeningBalanceSection[] {
  const offset = offsetFor(chart, offsetId).account;
  const rowFor = (row: ChartRow) => {
    const typed = values[row.id] ?? "";
    const read = readAmount(typed);
    const signed = read.kind === "ok" ? debitCents(row.role, read.cents) : 0n;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      role: row.role,
      value: typed,
      debit: read.kind === "ok" && signed > 0n ? formatMoney(signed) : "",
      credit: read.kind === "ok" && signed < 0n ? formatMoney(-signed) : "",
      ...(read.kind === "bad" ? { error: text.amountProblem } : {}),
    };
  };
  // A closed account is not offered, unless an amount has reached it (from a file): then it is
  // shown, so the amount can be cleared and the review's complaint about it can be answered.
  const open = chart.filter(
    (row) =>
      row.id !== offset?.id && (row.closedOn === null || (values[row.id] ?? "").trim() !== ""),
  );
  const pick = (roles: readonly OpeningRole[]) => open.filter((row) => roles.includes(row.role));
  const sections: OpeningBalanceSection[] = [
    { id: "assets", title: text.assets, rows: pick(["asset"]).map(rowFor) },
    { id: "liabilities", title: text.liabilities, rows: pick(["liability"]).map(rowFor) },
    { id: "equity", title: text.equity, rows: pick(["equity"]).map(rowFor) },
  ];
  const profit = pick(["income", "gain", "unrealizedGain", "expense"]).map(rowFor);
  if (profit.length > 0)
    sections.push({
      id: "profit",
      title: text.profitLoss,
      hint: text.profitLossHint,
      rows: profit,
      collapsible: true,
      collapsed: !showProfitLoss && profit.every((row) => row.value.trim() === ""),
    });
  return sections.filter((section) => section.rows.length > 0);
}

/** The input the service is sent: every typed amount that reads as an amount, in the form the wire
 * takes. Amounts at zero are left out, as the entry leaves them out. */
export function balancesInput(
  chart: readonly ChartRow[],
  values: Readonly<Record<string, string>>,
  offsetId: string,
): { accountId: string; balance: string }[] {
  const offset = offsetFor(chart, offsetId).account;
  const input: { accountId: string; balance: string }[] = [];
  for (const row of chart) {
    if (offset?.id === row.id) continue;
    const read = readAmount(values[row.id] ?? "");
    if (read.kind === "ok" && read.cents !== 0n)
      input.push({ accountId: row.id, balance: formatMoney(read.cents) });
  }
  return input;
}

/** The values a reviewed list of lines stands for, as canonical amounts, so a file's balances fill
 * the table (the screen shows them through the shared formatter). */
export function valuesFromReview(review: OpeningReview): Record<string, string> {
  return Object.fromEntries(review.lines.map((line) => [line.accountId, line.balance]));
}

/** An open account of the chart as the logic reads it. */
export function chartRows(
  accounts: readonly {
    id: string;
    code: string;
    name: string;
    role: string;
    openedOn: string;
    closedOn: string | null;
  }[],
): ChartRow[] {
  return accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    role: account.role as OpeningRole,
    openedOn: account.openedOn,
    closedOn: account.closedOn,
  }));
}

export function entryView(
  review: Pick<
    OpeningReview,
    "cutoverDate" | "entryDate" | "currency" | "lines" | "offset" | "totals"
  >,
): OpeningEntryView {
  return {
    // The date the entry is posted on: the day before the cutover date when the calendar allows.
    date: review.entryDate ?? review.cutoverDate,
    currency: review.currency,
    lines: [
      ...review.lines.map((line) => ({
        code: line.code,
        name: line.name,
        debit: line.debit,
        credit: line.credit,
        ...(line.row !== undefined ? { row: line.row } : {}),
      })),
      ...(review.offset
        ? [
            {
              code: review.offset.code,
              name: review.offset.name,
              debit: review.offset.debit,
              credit: review.offset.credit,
              offset: true,
            },
          ]
        : []),
    ],
    debit: review.totals.debit,
    credit: review.totals.credit,
    balanced: review.totals.balanced,
  };
}

/** What a review found, for the screen. An issue is linked to an account's field only when the
 * field is on the screen (`linkable`): a link that goes nowhere is not offered. */
export function issueViews(
  issues: OpeningReview["issues"],
  linkable: ReadonlySet<string>,
): OpeningIssueView[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: formatFiguresInText(issue.message),
    ...(issue.row !== undefined ? { row: issue.row } : {}),
    ...(issue.accountId !== undefined && linkable.has(issue.accountId)
      ? { accountId: issue.accountId }
      : {}),
  }));
}

/** The accounts whose amount can be typed in on the screen now: the rows of the sections that are
 * open. */
export function fieldIds(sections: readonly OpeningBalanceSection[]): Set<string> {
  return new Set(
    sections
      .filter((section) => !section.collapsed)
      .flatMap((section) => section.rows.map((row) => row.id)),
  );
}

export function statementAccounts(state: CutoverState): CutoverAccountView[] {
  return state.accounts.map((account) => ({
    id: account.accountId,
    code: account.code,
    name: account.name,
    kind: account.kind as CutoverAccountView["kind"],
    chosen: account.chosen,
    suggested: account.reason ?? "",
    selectable: account.kind !== "stripe",
  }));
}

export function sourceViews(state: CutoverState): CutoverSourceView[] {
  return state.sources.map((source) => ({
    key: `${source.provider}:${source.accountKey}`,
    provider: source.provider,
    accountKey: source.accountKey,
    account: source.account,
    startOn: source.startOn,
    after: source.after,
    action: source.action as CutoverSourceView["action"],
    excluded: source.excluded,
    wouldExclude: source.wouldExclude,
    wouldRestore: source.wouldRestore,
    ...(source.note ? { note: formatFiguresInText(source.note) } : {}),
  }));
}

/** The set of accounts the date will be given to, as ids in a stable order. */
export const chosenIds = (accounts: readonly CutoverAccountView[]): string[] =>
  accounts
    .filter((account) => account.chosen)
    .map((account) => account.id)
    .sort();

// ---- The checklist -----------------------------------------------------------------------------

const reasonView = (
  reason: CutoverChecklist["verdict"]["blocking"][number],
): ChecklistReasonView => ({
  code: reason.code,
  section: reason.section as ChecklistSection,
  message: formatFiguresInText(reason.message),
  ...(reason.accountId !== undefined ? { accountId: reason.accountId } : {}),
});

const periodView = (period: CutoverChecklist["openPeriods"][number]): ChecklistPeriodView => ({
  id: period.id,
  label: period.label,
  startsOn: period.startsOn,
  endsOn: period.endsOn,
  status: period.status as "open" | "closed",
  ended: period.ended,
});

/** A note of the month checklist (money collecting in an account for what fits nowhere else), as the
 * screen is given it. The words are the screen's own; only the facts are carried. */
const noteView = (
  note: NonNullable<CutoverChecklist["notes"]>[number],
): NonNullable<ChecklistView["notes"]>[number] => ({
  code: note.code,
  account: {
    id: note.account.id,
    code: note.account.code,
    name: note.account.name,
    role: note.account.role,
  },
  ...(note.from !== undefined ? { from: note.from } : {}),
  ...(note.to !== undefined ? { to: note.to } : {}),
  ...(note.amount !== undefined ? { amount: note.amount } : {}),
  ...(note.transactions !== undefined ? { transactions: note.transactions } : {}),
  largest: (note.largest ?? []).map((place) => ({
    name: place.name,
    amount: place.amount,
    kind: place.kind,
  })),
});

export function checklistView(data: CutoverChecklist): ChecklistView {
  return {
    asOf: data.asOf,
    currency: data.currency,
    cutover: data.cutover
      ? { date: data.cutover.date, basis: data.cutover.basis as "recorded" | "opening_entry" }
      : null,
    opening: data.opening.status as ChecklistView["opening"],
    period: data.period ? periodView(data.period) : null,
    verdict: {
      state: data.verdict.state as ChecklistView["verdict"]["state"],
      summary: formatFiguresInText(data.verdict.summary),
      blocking: data.verdict.blocking.map(reasonView),
      attention: data.verdict.attention.map(reasonView),
    },
    accounts: data.accounts.map(
      (account): ChecklistAccountView => ({
        id: account.accountId,
        code: account.code,
        name: account.name,
        kind: account.kind as "bank" | "card",
        status: account.status as ChecklistAccountView["status"],
        bookBalance: account.bookBalance,
        last: account.lastReconciliation
          ? { date: account.lastReconciliation.date, balance: account.lastReconciliation.balance }
          : null,
        throughPeriodEnd: account.throughPeriodEnd,
        draft: account.draft
          ? {
              href: `/reconcile/${encodeURIComponent(account.draft.id)}`,
              statementDate: account.draft.statementDate,
              difference: account.draft.difference,
            }
          : null,
        waiting: account.unreconciled
          ? { count: account.unreconciled.count, oldestOn: account.unreconciled.oldestOn }
          : null,
        uncleared: {
          count: account.uncleared.count,
          total: account.uncleared.total,
          oldestOn: account.uncleared.oldestOn,
        },
        reasons: account.reasons.map(reasonView),
      }),
    ),
    otherAccounts: data.otherAccounts.map((account) => ({
      id: account.accountId,
      code: account.code,
      name: account.name,
      role: account.role === "liability" ? "liability" : "asset",
      balance: account.balance,
    })),
    stripe: data.stripe
      ? {
          status: data.stripe.status as "ready" | "attention" | "blocked",
          compared: data.stripe.compared,
          ties: data.stripe.ties,
          difference: data.stripe.difference,
          unpaid: data.stripe.unpaid,
          inTransit: data.stripe.inTransit,
          readAt: data.stripe.readAt,
          stale: data.stripe.stale,
          explanation: formatFiguresInText(data.stripe.explanation),
          payouts: { ...data.stripe.payouts },
          reasons: data.stripe.reasons.map(reasonView),
        }
      : null,
    inbox: { ...data.inbox },
    backups: {
      available: data.backups.available,
      ...(data.backups.keptByService ? { keptByService: true } : {}),
      reason:
        data.backups.reason === undefined || data.backups.reason === null
          ? null
          : formatFiguresInText(data.backups.reason),
      verifiedAt: data.backups.verifiedAt,
      ageHours: data.backups.ageHours,
      limitHours: data.backups.limitHours,
      drill: data.backups.drill ? { ...data.backups.drill } : null,
    },
    openPeriods: data.openPeriods.map(periodView),
    shadowRun: data.shadowRun
      ? {
          required: data.shadowRun.required,
          provenCount: data.shadowRun.provenCount,
          provenThrough: data.shadowRun.provenThrough,
          complete: data.shadowRun.complete,
          months: data.shadowRun.months.map((month) => ({
            id: month.periodId,
            label: month.label,
            endsOn: month.endsOn,
            closed: month.closed,
            proven: month.proven,
          })),
        }
      : null,
    unavailable: data.unavailable.map((gap) => ({
      section: gap.section as ChecklistSection,
      reason: formatFiguresInText(gap.reason),
    })),
    ...(data.notes !== undefined ? { notes: data.notes.map(noteView) } : {}),
  };
}

/** What the Home card shows: the verdict when there is a book to check, a nudge when a cutover is
 * recorded and its opening entry is not posted, and the offer to move from another system only to a
 * book with nothing in it (no history, no recorded cutover, no opening entry). The offer is a feature
 * prompt, not a status: a book that already has history, or an opening entry however it was made, is
 * shown what stands in the way of closing its month, as every other line on Home is. */
export function cardSummary(data: CutoverChecklist): ShadowCardSummary {
  const run = data.shadowRun
    ? { provenCount: data.shadowRun.provenCount, required: data.shadowRun.required }
    : null;
  if (data.cutover === null && data.opening.status === "none" && !data.hasHistory)
    return { state: "start", summary: "", first: null, attention: 0, shadowRun: null };
  if (data.opening.status !== "posted" && data.cutover?.basis === "recorded")
    return { state: "opening", summary: "", first: null, attention: 0, shadowRun: run };
  return {
    state: data.verdict.state as ShadowCardSummary["state"],
    summary: formatFiguresInText(data.verdict.summary),
    first: formatFiguresInText(data.verdict.blocking[0]?.message ?? "") || null,
    attention: data.verdict.attention.length,
    shadowRun: run,
  };
}

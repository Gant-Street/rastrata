import type {
  BalanceSheet,
  ProfitLoss,
  ReportRow,
  ReportShare,
  ReportWarning,
  StatementRow,
  StatementTotal,
  TrialBalance,
} from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { isProfitLossRole, presented, type AccountRole, type ChartAccount } from "./chart.ts";
import type { Column } from "./columns.ts";

const money = formatMoney;

/** The statements are computed from postings that balance, so a mismatch is a defect, never a
 * rounding difference to forgive. It is reported loudly instead of shown as a figure. */
const doesNotTie = (message: string) => new ApplicationError("report_does_not_tie", message, 500);

/** `amount` as tenths of a percent of `income`: amount / income x 1,000, rounded to a whole number of
 * tenths with a tie going away from zero (0.25% is 0.3%, and -0.25% is -0.3%). It is worked in integers:
 * cents in a bigint, the remainder doubled and compared with the divisor. That is exact at any size,
 * which a float is not (it calls 99.95% 100.0% where a cent short of it is 99.9%). `income` must be
 * greater than zero; with none there is no share to show, and a caller has to say so instead. */
export function shareTenths(amount: bigint, income: bigint): bigint {
  if (income <= 0n) throw new RangeError("A share of income needs income greater than zero");
  const scaled = amount * 1000n;
  const magnitude = scaled < 0n ? -scaled : scaled;
  let tenths = magnitude / income;
  if (2n * (magnitude % income) >= income) tenths += 1n;
  return scaled < 0n ? -tenths : tenths;
}

/** Tenths of a percent as a percentage with one decimal: "30.2", "-29.4", "100.0". Nothing is ever
 * "-0.0": a share that rounds to nothing has no sign. */
export function formatShare(tenths: bigint): string {
  const magnitude = tenths < 0n ? -tenths : tenths;
  return `${tenths < 0n ? "-" : ""}${magnitude / 10n}.${magnitude % 10n}`;
}

/** The total income the shares of a profit and loss are taken of: the period's, and the comparison
 * period's when there is one. A period with no income greater than zero has none, and its lines then
 * carry no share. */
export interface ShareBasis {
  readonly income?: bigint;
  readonly comparativeIncome?: bigint;
}

/** A figure with its comparison, when there is one, and its share of income, when asked for. */
function figure(current: bigint, previous?: bigint, basis?: ShareBasis) {
  return {
    amount: money(current),
    ...(previous === undefined
      ? {}
      : { comparative: money(previous), change: money(current - previous) }),
    ...(basis?.income === undefined
      ? {}
      : { share: formatShare(shareTenths(current, basis.income)) }),
    ...(previous === undefined || basis?.comparativeIncome === undefined
      ? {}
      : { comparativeShare: formatShare(shareTenths(previous, basis.comparativeIncome)) }),
  };
}

const total = (
  key: string,
  label: string,
  current: bigint,
  previous?: bigint,
  basis?: ShareBasis,
): StatementTotal => ({
  key,
  label,
  ...figure(current, previous, basis),
});

/** Trial balance as of the column's end date. Balance-sheet accounts show their cumulative balance;
 * income and expense accounts show the fiscal year to date, and the earnings of earlier fiscal years
 * appear as one calculated retained-earnings line, so the trial balance still balances without any
 * closing entry having been posted. */
export function buildTrialBalance(accounts: readonly ChartAccount[], column: Column): TrialBalance {
  const { cumulative, yearToDate } = column.accumulated;
  const rows: ReportRow[] = [];
  let debit = 0n;
  let credit = 0n;
  let earlier = 0n;
  for (const account of accounts) {
    const profitLoss = isProfitLossRole(account.role);
    const balance = (profitLoss ? yearToDate : cumulative).get(account.id) ?? 0n;
    if (profitLoss)
      earlier += (cumulative.get(account.id) ?? 0n) - (yearToDate.get(account.id) ?? 0n);
    const rowDebit = balance > 0n ? balance : 0n;
    const rowCredit = balance < 0n ? -balance : 0n;
    debit += rowDebit;
    credit += rowCredit;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      signedBalance: money(balance),
      debit: money(rowDebit),
      credit: money(rowCredit),
    });
  }
  let retainedEarnings: TrialBalance["retainedEarnings"] = null;
  if (earlier !== 0n) {
    const rowDebit = earlier > 0n ? earlier : 0n;
    const rowCredit = earlier < 0n ? -earlier : 0n;
    debit += rowDebit;
    credit += rowCredit;
    retainedEarnings = {
      label: "Retained earnings from earlier fiscal years (calculated)",
      signedBalance: money(earlier),
      debit: money(rowDebit),
      credit: money(rowCredit),
    };
  }
  if (debit !== credit) throw doesNotTie("Trial balance does not tie");
  return {
    rows,
    debit: money(debit),
    credit: money(credit),
    balanced: true,
    fiscalYearStart: column.fiscalYear.startsOn,
    retainedEarnings,
  };
}

/** Figures for the profit and loss of one range, in cents, signed so a normal balance is positive. */
export interface ProfitLossFigures {
  readonly rows: ReadonlyMap<string, bigint>;
  readonly roles: ReadonlyMap<AccountRole, bigint>;
  readonly revenue: bigint;
  readonly expenses: bigint;
  readonly netIncome: bigint;
}

export function profitLossFigures(
  accounts: readonly ChartAccount[],
  column: Column,
): ProfitLossFigures {
  const rows = new Map<string, bigint>();
  const roles = new Map<AccountRole, bigint>();
  for (const account of accounts) {
    if (!isProfitLossRole(account.role)) continue;
    const shown = presented(account.role, column.accumulated.range.get(account.id) ?? 0n);
    rows.set(account.id, shown);
    roles.set(account.role, (roles.get(account.role) ?? 0n) + shown);
  }
  const revenue =
    (roles.get("income") ?? 0n) + (roles.get("gain") ?? 0n) + (roles.get("unrealizedGain") ?? 0n);
  const expenses = roles.get("expense") ?? 0n;
  return { rows, roles, revenue, expenses, netIncome: revenue - expenses };
}

const PROFIT_LOSS_GROUPS: readonly (readonly [AccountRole, string])[] = [
  ["income", "Total income"],
  ["gain", "Total gains"],
  ["unrealizedGain", "Total unrealised gains"],
  ["expense", "Total expenses"],
];

/** What a share of income is taken of: the "Total income" line of a profit and loss, which is the accounts
 * of type income (gains are their own lines and are not income here). */
const totalIncome = (figures: ProfitLossFigures): bigint => figures.roles.get("income") ?? 0n;

/** The incomes the shares of one profit and loss are taken of. A period whose income is zero or less
 * has none, so its lines carry no share (see `shareWarnings`). */
export function shareBasis(current: ProfitLossFigures, previous?: ProfitLossFigures): ShareBasis {
  const now = totalIncome(current);
  const before = previous && totalIncome(previous);
  return {
    ...(now > 0n ? { income: now } : {}),
    ...(before !== undefined && before > 0n ? { comparativeIncome: before } : {}),
  };
}

export const SHARE_UNAVAILABLE = "share_unavailable";
export const COMPARISON_SHARE_UNAVAILABLE = "comparison_share_unavailable";

/** What the report says when shares were asked for and a period has no income to take them of. Plain
 * words, because the screen shows them as they are, and a different sentence for none and for less
 * than none, because refunds that outrun sales are not "no income". */
export function shareWarnings(
  current: ProfitLossFigures,
  previous?: ProfitLossFigures,
): ReportWarning[] {
  const warnings: ReportWarning[] = [];
  const now = totalIncome(current);
  if (now <= 0n)
    warnings.push({
      code: SHARE_UNAVAILABLE,
      message:
        now === 0n
          ? "There is no income in these dates to compare with, so nothing is shown as a share of income."
          : "Income in these dates adds up to less than zero, so there is nothing to compare with and nothing is shown as a share of income.",
    });
  const before = previous && totalIncome(previous);
  if (before !== undefined && before <= 0n)
    warnings.push({
      code: COMPARISON_SHARE_UNAVAILABLE,
      message:
        before === 0n
          ? "There was no income in the comparison period to compare with, so its figures are not shown as a share of income."
          : "Income in the comparison period adds up to less than zero, so its figures are not shown as a share of income.",
    });
  return warnings;
}

/** The profit and loss. With `share` set to `income`, every row and total also carries its share of the
 * total income of its own period (`share`), and of the comparison period's (`comparativeShare`),
 * wherever that period has income greater than zero. Otherwise the statement is exactly what it
 * always was. */
export function renderProfitLoss(
  accounts: readonly ChartAccount[],
  current: ProfitLossFigures,
  previous?: ProfitLossFigures,
  share: ReportShare = "none",
): ProfitLoss {
  const basis = share === "income" ? shareBasis(current, previous) : undefined;
  const rows: StatementRow[] = [];
  for (const account of accounts) {
    if (!isProfitLossRole(account.role)) continue;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      ...figure(
        current.rows.get(account.id) ?? 0n,
        previous && (previous.rows.get(account.id) ?? 0n),
        basis,
      ),
    });
  }
  const totals: StatementTotal[] = [];
  for (const [role, label] of PROFIT_LOSS_GROUPS) {
    // Income and expenses always show; gains only when the chart has gain accounts.
    if (role !== "income" && role !== "expense" && !accounts.some((item) => item.role === role))
      continue;
    totals.push(
      total(
        role,
        label,
        current.roles.get(role) ?? 0n,
        previous && (previous.roles.get(role) ?? 0n),
        basis,
      ),
    );
  }
  totals.push(
    total("revenue", "Total income and gains", current.revenue, previous?.revenue, basis),
    total("netIncome", "Net income", current.netIncome, previous?.netIncome, basis),
  );
  return {
    rows,
    revenue: money(current.revenue),
    expenses: money(current.expenses),
    netIncome: money(current.netIncome),
    totals,
  };
}

/** Figures for the balance sheet as of one date, in cents, signed so a normal balance is positive. */
export interface BalanceSheetFigures {
  readonly rows: ReadonlyMap<string, bigint>;
  readonly roles: ReadonlyMap<AccountRole, bigint>;
  readonly assets: bigint;
  readonly liabilities: bigint;
  readonly contributedEquity: bigint;
  /** Earnings of fiscal years before the one the date is in, rolled forward by computation. */
  readonly priorEarnings: bigint;
  /** Earnings of the fiscal year the date is in, up to the date. */
  readonly currentEarnings: bigint;
  readonly equity: bigint;
  readonly difference: bigint;
}

export function balanceSheetFigures(
  accounts: readonly ChartAccount[],
  column: Column,
): BalanceSheetFigures {
  const { cumulative, yearToDate } = column.accumulated;
  const rows = new Map<string, bigint>();
  const roles = new Map<AccountRole, bigint>();
  let earlier = 0n;
  let thisYear = 0n;
  for (const account of accounts) {
    if (isProfitLossRole(account.role)) {
      const year = yearToDate.get(account.id) ?? 0n;
      thisYear += year;
      earlier += (cumulative.get(account.id) ?? 0n) - year;
      continue;
    }
    const shown = presented(account.role, cumulative.get(account.id) ?? 0n);
    rows.set(account.id, shown);
    roles.set(account.role, (roles.get(account.role) ?? 0n) + shown);
  }
  const assets = roles.get("asset") ?? 0n;
  const liabilities = roles.get("liability") ?? 0n;
  const contributedEquity = roles.get("equity") ?? 0n;
  const priorEarnings = -earlier;
  const currentEarnings = -thisYear;
  const equity = contributedEquity + priorEarnings + currentEarnings;
  const difference = assets - (liabilities + equity);
  if (difference !== 0n) throw doesNotTie("Balance sheet equation does not tie");
  return {
    rows,
    roles,
    assets,
    liabilities,
    contributedEquity,
    priorEarnings,
    currentEarnings,
    equity,
    difference,
  };
}

export function renderBalanceSheet(
  accounts: readonly ChartAccount[],
  current: BalanceSheetFigures,
  previous?: BalanceSheetFigures,
): BalanceSheet {
  const rows: StatementRow[] = [];
  for (const account of accounts) {
    if (isProfitLossRole(account.role)) continue;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      ...figure(
        current.rows.get(account.id) ?? 0n,
        previous && (previous.rows.get(account.id) ?? 0n),
      ),
    });
  }
  const totals: StatementTotal[] = [
    total("asset", "Total assets", current.assets, previous?.assets),
    total("liability", "Total liabilities", current.liabilities, previous?.liabilities),
    total("equity", "Contributed equity", current.contributedEquity, previous?.contributedEquity),
    total(
      "priorEarnings",
      "Retained earnings from earlier fiscal years (calculated)",
      current.priorEarnings,
      previous?.priorEarnings,
    ),
    total(
      "currentEarnings",
      "Earnings this fiscal year to date (calculated)",
      current.currentEarnings,
      previous?.currentEarnings,
    ),
    total("totalEquity", "Total equity", current.equity, previous?.equity),
    total(
      "liabilitiesAndEquity",
      "Total liabilities and equity",
      current.liabilities + current.equity,
      previous && previous.liabilities + previous.equity,
    ),
  ];
  return {
    rows,
    assets: money(current.assets),
    liabilities: money(current.liabilities),
    equity: money(current.equity),
    currentEarnings: money(current.currentEarnings),
    balanced: true,
    contributedEquity: money(current.contributedEquity),
    priorEarnings: money(current.priorEarnings),
    difference: money(current.difference),
    totals,
  };
}

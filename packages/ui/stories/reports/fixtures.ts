import type {
  AccountActivityData,
  CashFlowData,
  CoreReportsData,
  GeneralLedgerData,
  MonthlyReports,
  ReportHrefs,
} from "../../src/reports/data";
import { amountCents, centsAmount } from "../../src/reports/format";
import type { FiscalYearSpan } from "../../src/reports/period";

/** Fixture data shaped exactly like the service's report results, for stories and unit tests. It is
 * a small cash-basis design studio with an October fiscal year, reported on March 31, 2026, built by
 * hand so every check (assets = liabilities + equity, debits = credits, the cash tie-out) is exact. */

export const HASH = "3f9a1c52d8e47b60a2f5c91e04d7b38a6c15e9f0827d4b3a95e1c60f7d2b8a41";
export const COMPARISON_HASH = "b81e47d3c9a05f26e7d14b8a30c9f652a1e7d84c3b0f95a62d71c8e4f09b3a57";

export const fiscalYear = { year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" };
export const previousYear = { year: 2024, startsOn: "2024-10-01", endsOn: "2025-09-30" };
export const calendarYears: readonly FiscalYearSpan[] = [previousYear, fiscalYear];

/** Drill-through addresses, as the application builds them. */
export const hrefs: ReportHrefs = {
  account: (accountId, span, column) =>
    `/ledger?accountId=${accountId}&span=${span}&column=${column}`,
  entry: (journalId) => `/journal/${journalId}`,
  tagAccounts: "/accounts",
};

type Role = "asset" | "liability" | "equity" | "income" | "gain" | "expense";
export interface Account {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: Role;
  /** Presented (normal-balance-positive) amounts in cents: this period, and the comparison period. */
  readonly now: bigint;
  readonly earlier: bigint;
}

const c = (value: string) => amountCents(value);

/** The accounts and their presented amounts: profit and loss accounts for the range, balance-sheet
 * accounts as of the end date (a contra account such as accumulated depreciation is negative). */
export const accounts: readonly Account[] = [
  {
    id: "1000",
    code: "1000",
    name: "Operating cash",
    role: "asset",
    now: c("29800.00"),
    earlier: c("18000.00"),
  },
  {
    id: "1010",
    code: "1010",
    name: "Savings",
    role: "asset",
    now: c("5000.00"),
    earlier: c("5000.00"),
  },
  {
    id: "1500",
    code: "1500",
    name: "Equipment",
    role: "asset",
    now: c("6300.00"),
    earlier: c("4800.00"),
  },
  {
    id: "1600",
    code: "1600",
    name: "Accumulated depreciation",
    role: "asset",
    now: c("-1800.00"),
    earlier: c("-1200.00"),
  },
  {
    id: "2000",
    code: "2000",
    name: "Card balance",
    role: "liability",
    now: c("1210.40"),
    earlier: c("350.00"),
  },
  {
    id: "2300",
    code: "2300",
    name: "Sales tax payable",
    role: "liability",
    now: c("0.00"),
    earlier: c("0.00"),
  },
  {
    id: "3000",
    code: "3000",
    name: "Owner capital",
    role: "equity",
    now: c("10000.00"),
    earlier: c("10000.00"),
  },
  {
    id: "3100",
    code: "3100",
    name: "Owner draws",
    role: "equity",
    now: c("-3600.00"),
    earlier: c("-2400.00"),
  },
  {
    id: "4000",
    code: "4000",
    name: "Design fees",
    role: "income",
    now: c("18400.00"),
    earlier: c("15100.00"),
  },
  {
    id: "4100",
    code: "4100",
    name: "Retainers",
    role: "income",
    now: c("6000.00"),
    earlier: c("6000.00"),
  },
  {
    id: "4900",
    code: "4900",
    name: "Gain on sale of equipment",
    role: "gain",
    now: c("200.00"),
    earlier: c("0.00"),
  },
  {
    id: "5000",
    code: "5000",
    name: "Software",
    role: "expense",
    now: c("1260.40"),
    earlier: c("1010.00"),
  },
  {
    id: "5100",
    code: "5100",
    name: "Contractors",
    role: "expense",
    now: c("5200.00"),
    earlier: c("4800.00"),
  },
  {
    id: "5200",
    code: "5200",
    name: "Rent",
    role: "expense",
    now: c("4500.00"),
    earlier: c("4500.00"),
  },
  {
    id: "6100",
    code: "6100",
    name: "Depreciation",
    role: "expense",
    now: c("600.00"),
    earlier: c("600.00"),
  },
  {
    id: "6900",
    code: "6900",
    name: "Bank fees",
    role: "expense",
    now: c("0.00"),
    earlier: c("0.00"),
  },
];

const sum = (values: Iterable<bigint>) => [...values].reduce((all, value) => all + value, 0n);
const sumOf = (
  roles: readonly Role[],
  column: "now" | "earlier",
  source: readonly Account[] = accounts,
) =>
  sum(source.filter((account) => roles.includes(account.role)).map((account) => account[column]));

const scope = (compare: boolean) => ({
  asOf: "2026-03-31",
  periodStart: "2025-10-01",
  currency: "USD",
  basis: "cash" as const,
  fiscalYear,
  bookRevision: "42",
  populationHash: HASH,
  comparison: compare
    ? {
        kind: "previousPeriod" as const,
        periodStart: "2025-04-01",
        asOf: "2025-09-30",
        populationHash: COMPARISON_HASH,
      }
    : null,
  warnings: [] as { code: string; message: string }[],
});

const money = centsAmount;
const figures = (now: bigint, then: bigint, compare: boolean) =>
  compare
    ? { amount: money(now), comparative: money(then), change: money(now - then) }
    : { amount: money(now) };

/** A share of income the way the service writes it: `amount` x 1,000 / `income` as whole tenths of a percent,
 * a tie going away from zero, written with one decimal ("30.2", "-29.4"). Integers only. The fixtures keep
 * their own copy of the rule so a story shows what the service sends and the screen never works one out. */
export function shareOf(amount: bigint, income: bigint): string {
  if (income <= 0n) throw new RangeError("A share needs income greater than zero");
  const scaled = amount * 1000n;
  const magnitude = scaled < 0n ? -scaled : scaled;
  let tenths = magnitude / income;
  if (2n * (magnitude % income) >= income) tenths += 1n;
  const whole = tenths / 10n;
  const sign = scaled < 0n && tenths !== 0n ? "-" : "";
  return `${sign}${whole}.${tenths % 10n}`;
}

/** What the service says when a period has no income to take a share of. */
const NO_INCOME =
  "There is no income in these dates to compare with, so nothing is shown as a share of income.";
const NO_INCOME_BEFORE =
  "There was no income in the comparison period to compare with, so its figures are not shown as a share of income.";

/** The three statements of the studio's book as the service returns them. The totals are the studio's
 * own, whatever `accounts` is given (a story of many accounts is a long list under the same totals),
 * unless `totalsFromAccounts` says they are the sums of the list that was given. */
export function coreReports(
  options: {
    compare?: boolean;
    accounts?: readonly Account[];
    totalsFromAccounts?: boolean;
    /** Ask for each profit and loss figure's share of total income, as `share: "income"` does. */
    share?: boolean;
  } = {},
): CoreReportsData {
  const compare = options.compare ?? false;
  const list = options.accounts ?? accounts;
  const source = options.totalsFromAccounts ? list : accounts;
  const total = (roles: readonly Role[], column: "now" | "earlier") => sumOf(roles, column, source);
  const line = (account: Account) => ({
    accountId: account.id,
    code: account.code,
    name: account.name,
    role: account.role,
    ...figures(account.now, account.earlier, compare),
  });
  const t = (key: string, label: string, now: bigint, then: bigint) => ({
    key,
    label,
    ...figures(now, then, compare),
  });
  const income = total(["income"], "now");
  const incomeThen = total(["income"], "earlier");
  // Asked for shares, each profit and loss figure carries its share of its own period's income, and a period
  // with no income has none and a warning that says why.
  const shares = (now: bigint, then: bigint) =>
    options.share
      ? {
          ...(income > 0n ? { share: shareOf(now, income) } : {}),
          ...(compare && incomeThen > 0n ? { comparativeShare: shareOf(then, incomeThen) } : {}),
        }
      : {};
  const shareWarnings = options.share
    ? [
        ...(income > 0n ? [] : [{ code: "share_unavailable", message: NO_INCOME }]),
        ...(compare && incomeThen <= 0n
          ? [{ code: "comparison_share_unavailable", message: NO_INCOME_BEFORE }]
          : []),
      ]
    : [];
  const withShares = (account: Account) => ({
    ...line(account),
    ...shares(account.now, account.earlier),
  });
  const totalWithShares = (key: string, label: string, now: bigint, then: bigint) => ({
    ...t(key, label, now, then),
    ...shares(now, then),
  });
  const gains = total(["gain"], "now");
  const gainsThen = total(["gain"], "earlier");
  const expenses = total(["expense"], "now");
  const expensesThen = total(["expense"], "earlier");
  const netNow = income + gains - expenses;
  const netThen = incomeThen + gainsThen - expensesThen;
  // The earnings of earlier fiscal years, carried forward, and this year's, as the service computes them.
  const priorNow = c("18650.00");
  const priorThen = c("9650.00");
  const currentThen = c("9000.00");
  const balance = (roles: readonly Role[], column: "now" | "earlier") => total(roles, column);
  const assetsNow = balance(["asset"], "now");
  const assetsThen = balance(["asset"], "earlier");
  const liabilitiesNow = balance(["liability"], "now");
  const liabilitiesThen = balance(["liability"], "earlier");
  const contributedNow = balance(["equity"], "now");
  const contributedThen = balance(["equity"], "earlier");
  const equityNow = contributedNow + priorNow + netNow;
  const equityThen = contributedThen + priorThen + currentThen;
  const debitRows = list.map((account) => {
    const ledgerSigned =
      account.role === "asset" || account.role === "expense" ? account.now : -account.now;
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      signedBalance: money(ledgerSigned),
      debit: money(ledgerSigned > 0n ? ledgerSigned : 0n),
      credit: money(ledgerSigned < 0n ? -ledgerSigned : 0n),
    };
  });
  const debits = sum(debitRows.map((row) => amountCents(row.debit)));
  const credits = sum(debitRows.map((row) => amountCents(row.credit)));
  // The calculated line carries the earnings of earlier fiscal years, so the trial balance balances
  // without any closing entry: it is whatever the rows lack, signed like a ledger balance.
  const earlier = credits - debits;
  return {
    ...scope(compare),
    warnings: shareWarnings,
    trialBalance: {
      rows: debitRows,
      debit: money(debits + (earlier > 0n ? earlier : 0n)),
      credit: money(credits + (earlier < 0n ? -earlier : 0n)),
      balanced: true,
      fiscalYearStart: "2025-10-01",
      retainedEarnings: {
        label: "Retained earnings from earlier fiscal years (calculated)",
        signedBalance: money(earlier),
        debit: money(earlier > 0n ? earlier : 0n),
        credit: money(earlier < 0n ? -earlier : 0n),
      },
    },
    profitAndLoss: {
      rows: list
        .filter((a) => a.role === "income" || a.role === "gain" || a.role === "expense")
        .map(withShares),
      revenue: money(income + gains),
      expenses: money(expenses),
      netIncome: money(netNow),
      totals: [
        totalWithShares("income", "Total income", income, incomeThen),
        totalWithShares("gain", "Total gains", gains, gainsThen),
        totalWithShares("expense", "Total expenses", expenses, expensesThen),
        totalWithShares(
          "revenue",
          "Total income and gains",
          income + gains,
          incomeThen + gainsThen,
        ),
        totalWithShares("netIncome", "Net income", netNow, netThen),
      ],
    },
    balanceSheet: {
      rows: list
        .filter((a) => a.role === "asset" || a.role === "liability" || a.role === "equity")
        .map(line),
      assets: money(assetsNow),
      liabilities: money(liabilitiesNow),
      equity: money(equityNow),
      currentEarnings: money(netNow),
      priorEarnings: money(priorNow),
      contributedEquity: money(contributedNow),
      difference: money(assetsNow - (liabilitiesNow + equityNow)),
      balanced: true,
      totals: [
        t("asset", "Total assets", assetsNow, assetsThen),
        t("liability", "Total liabilities", liabilitiesNow, liabilitiesThen),
        t("equity", "Contributed equity", contributedNow, contributedThen),
        t(
          "priorEarnings",
          "Retained earnings from earlier fiscal years (calculated)",
          priorNow,
          priorThen,
        ),
        t("currentEarnings", "Earnings this fiscal year to date (calculated)", netNow, currentThen),
        t("totalEquity", "Total equity", equityNow, equityThen),
        t(
          "liabilitiesAndEquity",
          "Total liabilities and equity",
          liabilitiesNow + equityNow,
          liabilitiesThen + equityThen,
        ),
      ],
    },
  };
}

type Section = CashFlowData["sections"][number];
const cashLine = (
  key: string,
  group: "netIncome" | "nonCash" | "workingCapital" | "account",
  label: string,
  code: string | null,
  now: string,
  then?: string,
) => ({
  key,
  group,
  label,
  code,
  accountId: code,
  amount: now,
  ...(then === undefined
    ? {}
    : { comparative: then, change: money(amountCents(now) - amountCents(then)) }),
});

/** The cash-flow statement of the same book and range, tied to Operating cash and Savings. */
export function cashFlow(
  options: { compare?: boolean; untagged?: boolean; unavailable?: boolean } = {},
): CashFlowData {
  const compare = options.compare ?? false;
  const base = {
    ...scope(compare),
    warnings: options.untagged
      ? [
          {
            code: "unclassified_accounts",
            message:
              "1 account has activity in this range and no cash-flow tag (2300 Sales tax payable). Its change is shown under Not classified, not in operating, investing or financing, until it is tagged in your chart of accounts.",
          },
        ]
      : [],
    tagsRevision: "3",
    ledgerPopulationHash: COMPARISON_HASH,
    compilerVersion: "rastrata-cash-flow-v1",
  };
  if (options.unavailable)
    return {
      ...base,
      comparison: null,
      available: false,
      reason:
        "No account is tagged as cash, so there is nothing to tie the statement to. Tag your bank and cash accounts (cash-flow tag: cash) and every other balance-sheet account in your chart of accounts.",
      sections: [],
      cashAccounts: [],
      openingCash: null,
      netChange: null,
      closingCash: null,
      totals: [],
    } as CashFlowData;
  const v = (then: string) => (compare ? then : undefined);
  const sections: Section[] = [
    {
      key: "operating",
      label: "Operating activities",
      lines: [
        cashLine("netIncome", "netIncome", "Net income", null, "13039.60", v("10190.00")),
        cashLine("1600", "nonCash", "Accumulated depreciation", "1600", "600.00", v("600.00")),
        cashLine("2000", "workingCapital", "Card balance", "2000", "860.40", v("-150.00")),
      ],
      total: "14500.00",
      ...(compare ? { comparative: "10640.00", change: "3860.00" } : {}),
    },
    {
      key: "investing",
      label: "Investing activities",
      lines: [cashLine("1500", "account", "Equipment", "1500", "-1500.00", v("0.00"))],
      total: "-1500.00",
      ...(compare ? { comparative: "0.00", change: "-1500.00" } : {}),
    },
    {
      key: "financing",
      label: "Financing activities",
      lines: [cashLine("3100", "account", "Owner draws", "3100", "-1200.00", v("-1200.00"))],
      total: "-1200.00",
      ...(compare ? { comparative: "-1200.00", change: "0.00" } : {}),
    },
  ];
  if (options.untagged)
    sections.push({
      key: "unclassified",
      label: "Not classified",
      lines: [cashLine("2300", "account", "Sales tax payable", "2300", "320.00", v("0.00"))],
      total: "320.00",
      ...(compare ? { comparative: "0.00", change: "320.00" } : {}),
    });
  const net = options.untagged ? "12120.00" : "11800.00";
  return {
    ...base,
    available: true,
    reason: null,
    sections,
    cashAccounts: [
      {
        accountId: "1000",
        code: "1000",
        name: "Operating cash",
        opening: "18000.00",
        closing: money(amountCents("18000.00") + amountCents(net)),
        change: net,
      },
      {
        accountId: "1010",
        code: "1010",
        name: "Savings",
        opening: "5000.00",
        closing: "5000.00",
        change: "0.00",
      },
    ],
    openingCash: "23000.00",
    netChange: net,
    closingCash: money(amountCents("23000.00") + amountCents(net)),
    totals: [
      {
        key: "netChange",
        label: "Net change in cash",
        amount: net,
        ...(compare
          ? { comparative: "9440.00", change: money(amountCents(net) - amountCents("9440.00")) }
          : {}),
      },
      { key: "openingCash", label: "Cash at the start of the period", amount: "23000.00" },
      {
        key: "closingCash",
        label: "Cash at the end of the period",
        amount: money(amountCents("23000.00") + amountCents(net)),
      },
    ],
  };
}

/** A page of the general ledger of the same book. */
export function generalLedger(options: { lines?: number; page?: number } = {}): GeneralLedgerData {
  const wanted = options.lines ?? 8;
  const lines: GeneralLedgerData["lines"][number][] = [];
  let running = 0n;
  for (let index = 0; index < wanted; index++) {
    const cents = BigInt(((index * 7919) % 90000) + 1500) * (index % 3 === 2 ? -1n : 1n);
    running += cents;
    lines.push({
      accountId: "1000",
      journalId: `journal-${String(index + 1).padStart(4, "0")}`,
      postingSequence: String(index + 12),
      postingId: `posting-${index}`,
      date: `2025-${String(10 + (index % 3)).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
      narration: ["Design fees, Harbor & Co", "Rent, October", "Contractor invoice 1042"][
        index % 3
      ] as string,
      debit: cents > 0n ? money(cents) : "0.00",
      credit: cents < 0n ? money(-cents) : "0.00",
      runningBalance: money(running),
    });
  }
  return {
    asOf: "2026-03-31",
    periodStart: "2025-10-01",
    currency: "USD",
    basis: "cash",
    fiscalYear,
    bookRevision: "42",
    populationHash: HASH,
    accounts: [
      {
        accountId: "1000",
        code: "1000",
        name: "Operating cash",
        balanceKind: "cumulative",
        openingBalance: "18000.00",
        totalDebit: "26800.00",
        totalCredit: "15000.00",
        closingBalance: "29800.00",
        lineCount: wanted,
      },
      {
        accountId: "4000",
        code: "4000",
        name: "Design fees",
        balanceKind: "fiscalYearToDate",
        openingBalance: "0.00",
        totalDebit: "0.00",
        totalCredit: "18400.00",
        closingBalance: "-18400.00",
        lineCount: 6,
      },
    ],
    count: options.lines === undefined ? wanted : Math.max(wanted, 340),
    page: options.page ?? 1,
    pageSize: 100,
    lines,
  };
}

/** Many accounts, for the long statement: every code and name distinct, amounts spread and signed. */
export function manyAccounts(count: number): readonly Account[] {
  const roles: Role[] = ["income", "expense", "asset", "liability", "equity"];
  return Array.from({ length: count }, (_, index) => {
    const role = roles[index % roles.length] as Role;
    return {
      id: `${1000 + index}`,
      code: `${1000 + index}`,
      name: `${["Consulting", "Subscriptions", "Travel", "Equipment lease", "Insurance", "Training"][index % 6]} ${Math.floor(index / 6) + 1}`,
      role,
      now: BigInt(((index * 104729) % 9_000_000) + 100) * (index % 7 === 3 ? -1n : 1n),
      earlier: BigInt(((index * 7727) % 8_000_000) + 100),
    };
  });
}

/** Names that are hostile or very long, because account names are data and arrive from anywhere. */
export const hostileNames: readonly Account[] = [
  {
    id: "7001",
    code: "7001",
    name: '=HYPERLINK("http://evil.example","Click") and an extremely long account name that goes on and on to prove that long text wraps inside its own cell instead of pushing the figures off the screen',
    role: "expense",
    now: c("1234567.89"),
    earlier: c("1000000.00"),
  },
  {
    id: "7002",
    code: "7002",
    name: "<script>alert(1)</script> & \"quotes\" 'apostrophes'",
    role: "expense",
    now: c("-45.60"),
    earlier: c("0.00"),
  },
  {
    id: "7003",
    code: "7003",
    name: "العملاء والمبيعات (حساب بالعربية)",
    role: "income",
    now: c("99.99"),
    earlier: c("1.00"),
  },
];

/** One account's activity, as `activity.get` returns it. */
export function accountActivity(
  options: { kind?: "cumulative" | "fiscalYearToDate"; lines?: number; count?: number } = {},
): AccountActivityData {
  const wanted = options.lines ?? 6;
  const profitLoss = options.kind === "fiscalYearToDate";
  const rows: AccountActivityData["rows"][number][] = [];
  let running = profitLoss ? 0n : c("18000.00");
  for (let index = 0; index < wanted; index++) {
    const magnitude = BigInt(((index * 4421) % 80000) + 2500);
    const cents = profitLoss ? -magnitude : index % 3 === 2 ? -magnitude : magnitude;
    running += cents;
    rows.push({
      journalId: `journal-${String(index + 1).padStart(4, "0")}`,
      postingId: `posting-${index}`,
      date: `2025-${String(10 + (index % 3)).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
      narration: ["Design fees, Harbor & Co", "Retainer, October", "Workshop deposit"][
        index % 3
      ] as string,
      debit: cents > 0n ? centsAmount(cents) : "0.00",
      credit: cents < 0n ? centsAmount(-cents) : "0.00",
      runningBalance: centsAmount(running),
    });
  }
  const debit = rows.reduce((all, row) => all + amountCents(row.debit), 0n);
  const credit = rows.reduce((all, row) => all + amountCents(row.credit), 0n);
  return {
    account: profitLoss
      ? { id: "4000", code: "4000", name: "Design fees", role: "income", normalSide: "credit" }
      : { id: "1000", code: "1000", name: "Operating cash", role: "asset", normalSide: "debit" },
    currency: "USD",
    basis: "cash",
    asOf: "2026-03-31",
    from: "2025-10-01",
    to: "2026-03-31",
    reportFrom: "2025-10-01",
    revision: "42",
    populationHash: HASH,
    balanceKind: options.kind ?? "cumulative",
    openingBalance: profitLoss ? "0.00" : "18000.00",
    closingBalance: centsAmount(running),
    totalDebit: centsAmount(debit),
    totalCredit: centsAmount(credit),
    netChange: centsAmount(debit - credit),
    count: options.count ?? wanted,
    page: 1,
    pageSize: 25,
    rows,
  };
}

/** The studio's book by month, as a by-month report reads it: the whole range once (October 1, 2025 to
 * March 31, 2026) and each of its six months, every read at book revision 42. Each profit and loss
 * account's amount for the range is split over the months in the proportions 1:2:3:4:5:6 and the last
 * month takes what is left, so the months add up to the total to the cent. Each month's balance sheet
 * is the position at its end: the cash account is what makes the sheet balance, the earnings are the
 * fiscal year's to that month, and everything else is as in the book at the end of March. Built by
 * hand, with integer cents, so every tie is exact. */
export function monthlyReports(
  options: { accounts?: readonly Account[]; months?: number } = {},
): MonthlyReports<CoreReportsData> {
  const list = options.accounts ?? accounts;
  const count = options.months ?? 6;
  const weight = (index: number) => BigInt(index + 1);
  const weights = BigInt((count * (count + 1)) / 2);
  const profitLossRole = (role: Role) => role === "income" || role === "gain" || role === "expense";
  /** What an account does in month `index` of `count`: its share of the whole range's amount. */
  const share = (account: Account, index: number): bigint => {
    if (!profitLossRole(account.role)) return account.now;
    if (index === count - 1) {
      let before = 0n;
      for (let earlier = 0; earlier < index; earlier++)
        before += (account.now * weight(earlier)) / weights;
      return account.now - before;
    }
    return (account.now * weight(index)) / weights;
  };
  const net = (accountsOf: readonly Account[], pick: (account: Account) => bigint): bigint =>
    accountsOf
      .filter((account) => profitLossRole(account.role))
      .reduce((all, account) => {
        const amount = pick(account);
        return account.role === "expense" ? all - amount : all + amount;
      }, 0n);
  const prior = c("18650.00");
  const months = Array.from({ length: count }, (_, index) => {
    const month = 10 + index;
    const year = month > 12 ? 2026 : 2025;
    const number = month > 12 ? month - 12 : month;
    const first = `${year}-${String(number).padStart(2, "0")}-01`;
    const last = `${year}-${String(number).padStart(2, "0")}-${[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][number - 1] ?? 30}`;
    // This month's profit and loss and the fiscal year's to the end of it, which the balance sheet needs.
    const duringMonth = list.map((account) => ({
      ...account,
      now: share(account, index),
      earlier: 0n,
    }));
    const cumulative = (account: Account): bigint => {
      let sum = 0n;
      for (let each = 0; each <= index; each++) sum += share(account, each);
      return sum;
    };
    const toDate = list.map((account) => ({
      ...account,
      now: profitLossRole(account.role) ? cumulative(account) : account.now,
      earlier: 0n,
    }));
    // The cash account makes the sheet balance: liabilities plus equity less every other asset.
    const others = toDate
      .filter((account) => account.role === "asset" && account.id !== "1000")
      .reduce((all, account) => all + account.now, 0n);
    const liabilities = toDate
      .filter((account) => account.role === "liability")
      .reduce((all, account) => all + account.now, 0n);
    const contributed = toDate
      .filter((account) => account.role === "equity")
      .reduce((all, account) => all + account.now, 0n);
    const earnings = net(toDate, (account) => account.now);
    const balanced = toDate.map((account) =>
      account.id === "1000"
        ? { ...account, now: liabilities + contributed + prior + earnings - others }
        : account,
    );
    const profit = coreReports({ accounts: duringMonth, totalsFromAccounts: true });
    const position = coreReports({ accounts: balanced, totalsFromAccounts: true });
    const data: CoreReportsData = {
      ...profit,
      asOf: last,
      periodStart: first,
      populationHash: HASH.replace(/^.{2}/, `${String(index).padStart(2, "0")}`),
      comparison: null,
      balanceSheet: position.balanceSheet,
      trialBalance: position.trialBalance,
    };
    return {
      month: first.slice(0, 7),
      from: first,
      to: last,
      partial: false,
      endsMonth: true,
      data,
    };
  });
  const total = coreReports({ accounts: list, totalsFromAccounts: true });
  return { total: { ...total, comparison: null }, months };
}

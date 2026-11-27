/** Synthetic Xero exports for the tests: made up, in the layouts Xero's documentation and exports
 * show. No real business, name, account number or balance is in this file.
 *
 * The files are generated from one small made-up ledger, so a test that changes a figure changes it
 * everywhere it appears and the trial balance still balances to the cent. Amounts are cents in a
 * `bigint`, debit-positive (a debit less a credit), as the readers hold them. */

export const csv = (rows: readonly (readonly string[])[]): string =>
  rows
    .map((row) =>
      row.map((cell) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","),
    )
    .join("\n");

/** 1234567n is "12,345.67", as Xero writes an amount in a CSV. */
export function group(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${whole}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export type Section = "Revenue" | "Expenses" | "Assets" | "Liabilities" | "Equity";

export interface LedgerRow {
  readonly code: string;
  readonly name: string;
  /** The type as Xero's chart writes it. */
  readonly type: string;
  readonly section: Section;
  /** The month's movement and the balance year to date, debit-positive. */
  readonly month: bigint;
  readonly ytd: bigint;
  readonly bank?: true;
}

/** A small made-up ledger for July 2026, a seven-month year. Retained earnings is the plug, so both
 * columns sum to zero. */
export function ledger(overrides: Readonly<Record<string, Partial<LedgerRow>>> = {}): LedgerRow[] {
  const rows: LedgerRow[] = [
    {
      code: "200",
      name: "Sales",
      type: "Revenue",
      section: "Revenue",
      month: -650000n,
      ytd: -980000n,
    },
    {
      code: "260",
      name: "Other Revenue",
      type: "Other Income",
      section: "Revenue",
      month: 0n,
      ytd: -12000n,
    },
    {
      code: "310",
      name: "Cost of Goods Sold",
      type: "Direct Costs",
      section: "Expenses",
      month: 120000n,
      ytd: 210000n,
    },
    {
      code: "400",
      name: "Advertising",
      type: "Expense",
      section: "Expenses",
      month: 30000n,
      ytd: 65000n,
    },
    {
      code: "404",
      name: "Bank Fees",
      type: "Expense",
      section: "Expenses",
      month: 2500n,
      ytd: 8500n,
    },
    {
      code: "469",
      name: "Rent",
      type: "Expense",
      section: "Expenses",
      month: 120000n,
      ytd: 420000n,
    },
    {
      code: "090",
      name: "Business Bank Account",
      type: "Bank",
      section: "Assets",
      month: 377500n,
      ytd: 1287320n,
      bank: true,
    },
    {
      code: "091",
      name: "Business Savings",
      type: "Bank",
      section: "Assets",
      month: 0n,
      ytd: 500000n,
      bank: true,
    },
    {
      code: "120",
      name: "Accounts Receivable",
      type: "Accounts Receivable",
      section: "Assets",
      month: 50000n,
      ytd: 150000n,
    },
    {
      code: "620",
      name: "Prepaid Expenses",
      type: "Prepayment",
      section: "Assets",
      month: 0n,
      ytd: 40000n,
    },
    {
      code: "710",
      name: "Office Equipment",
      type: "Fixed Asset",
      section: "Assets",
      month: 0n,
      ytd: 320000n,
    },
    {
      code: "711",
      name: "Less Accumulated Depreciation on Office Equipment",
      type: "Fixed Asset",
      section: "Assets",
      month: 0n,
      ytd: -80000n,
    },
    {
      code: "092",
      name: "Business Card",
      type: "Bank",
      section: "Liabilities",
      month: -10000n,
      ytd: -52310n,
      bank: true,
    },
    {
      code: "800",
      name: "Accounts Payable",
      type: "Accounts Payable",
      section: "Liabilities",
      month: 0n,
      ytd: -64000n,
    },
    {
      code: "820",
      name: "Sales Tax",
      type: "Sales Tax",
      section: "Liabilities",
      month: 0n,
      ytd: -9500n,
    },
    {
      code: "900",
      name: "Loan",
      type: "Non-current Liability",
      section: "Liabilities",
      month: 0n,
      ytd: -600000n,
    },
    {
      code: "970",
      name: "Owner Funds Introduced",
      type: "Equity",
      section: "Equity",
      month: 0n,
      ytd: -200000n,
    },
  ].map((row) => ({ ...row, ...(overrides[row.code] ?? {}) })) as LedgerRow[];
  const month = rows.reduce((sum, row) => sum + row.month, 0n);
  const ytd = rows.reduce((sum, row) => sum + row.ytd, 0n);
  rows.push({
    code: "960",
    name: "Retained Earnings",
    type: "Retained Earnings",
    section: "Equity",
    month: -month,
    ytd: -ytd,
  });
  return rows;
}

const TAX = "Tax Exempt (0%)";

/** Xero's chart of accounts import template, with the balance column holding the year to date. */
export function chartCsv(rows: readonly LedgerRow[] = ledger()): string {
  return csv([
    [
      "*Code",
      "*Name",
      "*Type",
      "*Tax Code",
      "Description",
      "Dashboard",
      "Expense Claims",
      "Enable Payments",
      "Balance",
    ],
    ...[...rows]
      .sort((a, b) => (a.code < b.code ? -1 : 1))
      .map((row) => [
        row.code,
        row.name,
        row.type,
        TAX,
        "",
        "No",
        "No",
        row.bank ? "No" : "Yes",
        group(row.ytd),
      ]),
  ]);
}

export const CHART = chartCsv();

const debit = (cents: bigint): string => (cents > 0n ? group(cents) : "");
const credit = (cents: bigint): string => (cents < 0n ? group(-cents) : "");

/** A trial balance as Xero exports it: title lines, a header with a period pair and a year-to-date
 * pair, the accounts under their section titles, and a Total row. */
export function trialBalanceCsv(
  options: { asAt?: string; rows?: readonly LedgerRow[]; title?: boolean } = {},
): string {
  const rows = options.rows ?? ledger();
  const lines: string[][] = [];
  if (options.title !== false)
    lines.push(
      ["Trial Balance"],
      ["Harbor Studio LLC"],
      [`As at ${options.asAt ?? "31 July 2026"}`],
      [""],
    );
  lines.push(["Account", "Debit", "Credit", "YTD Debit", "YTD Credit"]);
  let at: Section | null = null;
  for (const row of rows) {
    if (row.section !== at) {
      lines.push([row.section]);
      at = row.section;
    }
    lines.push([
      `${row.name} (${row.code})`,
      debit(row.month),
      credit(row.month),
      debit(row.ytd),
      credit(row.ytd),
    ]);
  }
  const sums = (pick: (row: LedgerRow) => bigint, positive: boolean): bigint =>
    rows.reduce((sum, row) => {
      const value = pick(row);
      return sum + (positive ? (value > 0n ? value : 0n) : value < 0n ? -value : 0n);
    }, 0n);
  lines.push([
    "Total",
    group(sums((row) => row.month, true)),
    group(sums((row) => row.month, false)),
    group(sums((row) => row.ytd, true)),
    group(sums((row) => row.ytd, false)),
  ]);
  return csv(lines);
}

export const TRIAL_BALANCE = trialBalanceCsv();

export interface Transaction {
  /** As written in the file: "03 Jul 2026", "07/03/2026". */
  readonly date: string;
  readonly source: string;
  readonly description: string;
  readonly reference: string;
  readonly net: bigint;
}

export interface Block {
  readonly heading: string;
  readonly lines: readonly Transaction[];
  /** The Total row, when it is not the sum of the lines (to test a lost row). */
  readonly total?: readonly [bigint, bigint];
}

/** An Account Transactions export: title lines with the period, the header, and a block for each
 * account with its Opening Balance, its transactions, its Total and its Closing Balance. The Running
 * Balance column is written as Xero shows it (debits less credits, a debit bracketed) and is never read. */
export function transactionsCsv(
  blocks: readonly Block[],
  options: { period?: string; opening?: bigint } = {},
): string {
  const lines: string[][] = [
    ["Account Transactions"],
    ["Harbor Studio LLC"],
    [`For the period ${options.period ?? "1 July 2026 to 31 July 2026"}`],
    [""],
    [
      "Date",
      "Source",
      "Description",
      "Reference",
      "Debit",
      "Credit",
      "Running Balance",
      "Gross",
      "GST",
    ],
  ];
  const bracket = (cents: bigint): string => (cents > 0n ? `(${group(cents)})` : group(-cents));
  for (const block of blocks) {
    lines.push([block.heading]);
    let running = options.opening ?? 0n;
    lines.push(["Opening Balance", "", "", "", "", "", bracket(running), "", ""]);
    let debits = 0n;
    let credits = 0n;
    for (const line of block.lines) {
      running += line.net;
      if (line.net > 0n) debits += line.net;
      else credits += -line.net;
      lines.push([
        line.date,
        line.source,
        line.description,
        line.reference,
        debit(line.net),
        credit(line.net),
        bracket(running),
        group(line.net > 0n ? line.net : -line.net),
        "0.00",
      ]);
    }
    const [shownDebit, shownCredit] = block.total ?? [debits, credits];
    lines.push([
      `Total ${block.heading}`,
      "",
      "",
      "",
      group(shownDebit),
      group(shownCredit),
      "",
      "",
      "",
    ]);
    lines.push(["Closing Balance", "", "", "", "", "", bracket(running), "", ""]);
  }
  return csv(lines);
}

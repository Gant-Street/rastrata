/** Reading a Xero chart of accounts.
 *
 * Xero's chart of accounts import template (and an export of the chart) is a CSV with the columns
 * `*Code, *Name, *Type, *Tax Code, Description, Dashboard, Expense Claims, Enable Payments, Balance`
 * (the asterisk marks a required column; a newer template adds `Reporting Name`). A code is up to ten
 * characters and a name up to 150; the code is text, so a leading zero ("090") is kept. `Type` is one of
 * Xero's account types (`xeroType`). `Balance` is a conversion balance in the import template and the
 * balance as shown on the Chart of accounts screen in an export: it is read and reported, and never
 * used as an opening balance (the trial balance is).
 *
 * Columns are found by name, so a file with one more, one fewer or a different order still reads; the
 * header is found within the first lines, so a title above it does not matter. A row that cannot be
 * read is reported on its row and left out; nothing is guessed. */
import type { OpeningRole } from "../opening.ts";
import {
  type XeroIssue,
  Issues,
  amountOf,
  clean,
  isBlank,
  norm,
  quoted,
  readTable,
} from "./report.ts";
import { KNOWN_TYPE_LABELS, xeroType } from "./types.ts";
import { formatMoney } from "../../money.ts";

/** Xero's limits on a chart, from its import rules. A file over them is still read; the account is
 * flagged so the owner knows Xero would refuse it. */
export const XERO_CODE_MAX = 10;
export const XERO_NAME_MAX = 150;
/** Xero allows a chart of 1000 rows including the header; a little more is read, no more than this. */
export const MAX_CHART_ACCOUNTS = 1200;

export interface XeroAccount {
  /** Text, so a leading zero stays. */
  readonly code: string;
  readonly name: string;
  /** The type as the file wrote it, cleaned. */
  readonly type: string;
  /** The type's name on Xero's screens, when the file's type is one this version knows. */
  readonly typeLabel: string | null;
  readonly role: OpeningRole | null;
  /** A bank account: the accounts Xero reconciles to a statement. */
  readonly bank: boolean;
  readonly system: boolean;
  readonly taxCode: string;
  readonly description: string;
  /** The balance column, exact, when the file has one and it reads. */
  readonly balance: string | null;
  readonly archived: boolean;
  /** The row of the file, as a spreadsheet counts. */
  readonly row: number;
}

export interface XeroChart {
  readonly accounts: readonly XeroAccount[];
  readonly issues: readonly XeroIssue[];
  /** The columns found, by what they mean, for showing the owner how the file was read. */
  readonly columns: Readonly<Record<string, string>>;
  readonly rows: number;
}

type Field =
  | "code"
  | "name"
  | "type"
  | "taxCode"
  | "description"
  | "balance"
  | "status"
  | "dashboard"
  | "expenseClaims"
  | "enablePayments"
  | "reportingName";

const NAMES: Readonly<Record<Field, readonly string[]>> = {
  code: ["code", "account code"],
  name: ["name", "account name", "account"],
  type: ["type", "account type"],
  taxCode: ["tax code", "tax rate", "tax type", "default tax", "default tax rate"],
  description: ["description"],
  balance: ["balance", "ytd balance", "conversion balance", "closing balance"],
  status: ["status"],
  dashboard: ["dashboard", "show on dashboard watchlist"],
  expenseClaims: ["expense claims", "show in expense claims"],
  enablePayments: ["enable payments", "enable payments to this account", "payments enabled"],
  reportingName: ["reporting name"],
};

function fieldOf(cell: string): Field | null {
  const key = norm(cell);
  for (const field of Object.keys(NAMES) as Field[]) if (NAMES[field].includes(key)) return field;
  return null;
}

export interface ChartOptions {
  readonly decimal?: "." | ",";
}

export function parseXeroChart(text: string, options: ChartOptions = {}): XeroChart {
  const issues = new Issues();
  const { records } = readTable(text, issues);
  const decimal = options.decimal ?? ".";

  // The header is the first record, within the first twenty, that names a code and a name column.
  let headerAt = -1;
  let columns = new Map<Field, number>();
  for (let at = 0; at < Math.min(records.length, 20); at++) {
    const found = new Map<Field, number>();
    (records[at]?.fields ?? []).forEach((cell, index) => {
      const field = fieldOf(cell);
      if (field && !found.has(field)) found.set(field, index);
    });
    if (found.has("code") && found.has("name")) {
      headerAt = at;
      columns = found;
      break;
    }
  }
  if (headerAt === -1) {
    issues.add({
      severity: "error",
      code: "no_header",
      message:
        "No header row with a Code and a Name column was found in the first 20 rows. A Xero chart of accounts file starts with the columns *Code, *Name, *Type, *Tax Code.",
    });
    return { accounts: [], issues: issues.done(), columns: {}, rows: 0 };
  }
  if (!columns.has("type"))
    issues.add({
      severity: "warning",
      code: "no_type_column",
      message:
        "The file has no Type column, so the kind of each account is not known. Choose each account's role when you map it.",
    });

  const cell = (fields: readonly string[], field: Field): string => {
    const index = columns.get(field);
    return index === undefined ? "" : (fields[index] ?? "");
  };

  const accounts: XeroAccount[] = [];
  const seen = new Map<string, number>();
  let rows = 0;
  for (const record of records.slice(headerAt + 1)) {
    if (isBlank(record)) continue;
    rows++;
    if (accounts.length >= MAX_CHART_ACCOUNTS) {
      issues.add({
        severity: "error",
        code: "too_many_accounts",
        message: `The file has more than ${MAX_CHART_ACCOUNTS} accounts, which is more than Xero allows in a chart.`,
      });
      break;
    }
    const code = clean(cell(record.fields, "code"), 40);
    const name = clean(cell(record.fields, "name"), 300);
    if (code === "" || name === "") {
      issues.add({
        severity: "error",
        code: "missing_code_or_name",
        message: `Row ${record.number}: ${code === "" ? "the code is empty" : "the name is empty"}, so the account was left out.`,
        row: record.number,
      });
      continue;
    }
    const earlier = seen.get(code.toLowerCase());
    if (earlier !== undefined) {
      issues.add({
        severity: "error",
        code: "duplicate_code",
        message: `Row ${record.number}: the code ${quoted(code)} is already used on row ${earlier}, so this account was left out.`,
        row: record.number,
      });
      continue;
    }
    seen.set(code.toLowerCase(), record.number);
    if (code.length > XERO_CODE_MAX)
      issues.add({
        severity: "warning",
        code: "code_too_long",
        message: `Row ${record.number}: the code ${quoted(code)} is longer than the ${XERO_CODE_MAX} characters Xero allows.`,
        row: record.number,
      });
    if (name.length > XERO_NAME_MAX)
      issues.add({
        severity: "warning",
        code: "name_too_long",
        message: `Row ${record.number}: the name is longer than the ${XERO_NAME_MAX} characters Xero allows.`,
        row: record.number,
      });
    const typeText = clean(cell(record.fields, "type"), 60);
    const known = typeText === "" ? null : xeroType(typeText);
    if (typeText !== "" && !known)
      issues.add({
        severity: "warning",
        code: "unknown_type",
        message: `Row ${record.number}: the type ${quoted(typeText)} is not one this version knows (${KNOWN_TYPE_LABELS.slice(0, 10).join(", ")}, and Xero's own accounts), so ${quoted(code)} has no role until you choose one.`,
        row: record.number,
      });
    if (typeText === "" && columns.has("type"))
      issues.add({
        severity: "warning",
        code: "empty_type",
        message: `Row ${record.number}: the type of ${quoted(code)} is empty.`,
        row: record.number,
      });
    let balance: string | null = null;
    const balanceCell = cell(record.fields, "balance");
    if (columns.has("balance")) {
      const amount = amountOf(balanceCell, decimal);
      if (amount.kind === "ok") balance = formatMoney(amount.cents);
      else if (amount.kind === "bad")
        issues.add({
          severity: "warning",
          code: "balance_unreadable",
          message: `Row ${record.number}: the balance ${quoted(balanceCell)} is not an amount (${amount.why}); it was ignored.`,
          row: record.number,
        });
    }
    const status = norm(cell(record.fields, "status"));
    accounts.push({
      code,
      name,
      type: typeText,
      typeLabel: known?.label ?? null,
      role: known?.role ?? null,
      bank: known?.bank ?? false,
      system: known?.system ?? false,
      taxCode: clean(cell(record.fields, "taxCode"), 80),
      description: clean(cell(record.fields, "description"), 300),
      balance,
      archived: status === "archived",
      row: record.number,
    });
  }
  if (accounts.length === 0)
    issues.add({
      severity: "error",
      code: "no_accounts",
      message: "The file has a header and no accounts under it.",
    });
  const named: Record<string, string> = {};
  for (const [field, index] of columns) {
    const header = records[headerAt]?.fields[index];
    named[field] = clean(header, 60);
  }
  return { accounts, issues: issues.done(), columns: named, rows };
}

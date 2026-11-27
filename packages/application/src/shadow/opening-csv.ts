/** Reading opening balances from a CSV a person typed or exported: one row per account, the
 * account named by its code or its name, and a balance or a debit and a credit.
 *
 * Every cell is hostile text. A cell is never interpolated into anything but a message, and then
 * only quoted and bounded (`quoteCell`); nothing here follows an instruction a cell contains. The
 * parser never throws and never rounds: an amount with more than two decimals is an error on its
 * row. The service resolves each row against the chart and hands the result to `buildOpening`,
 * which does the arithmetic. */
import { formatMoney } from "../money.ts";
import { amountProblem, parseAmount } from "../statements/amounts.ts";
import { sniffDelimiter, tokenizeCsv } from "../statements/csv.ts";
import { quoteCell } from "../statements/hostile.ts";
import { type OpeningAccount, type OpeningEntry, type OpeningIssue, sideOf } from "./opening.ts";

/** A file larger than this is refused outright; a chart of accounts is a few hundred rows. */
export const MAX_CSV_ROWS = 2000;

type Column = "code" | "name" | "account" | "debit" | "credit" | "balance";

const HEADERS: Readonly<Record<Column, readonly string[]>> = {
  code: [
    "code",
    "account code",
    "account number",
    "account no",
    "account no.",
    "account #",
    "acct code",
    "acct no",
    "number",
    "no",
    "no.",
    "#",
  ],
  name: ["name", "account name", "account title", "title", "description"],
  account: ["account", "accounts", "acct"],
  debit: ["debit", "debits", "dr", "debit amount"],
  credit: ["credit", "credits", "cr", "credit amount"],
  balance: [
    "balance",
    "amount",
    "opening balance",
    "closing balance",
    "ending balance",
    "starting balance",
    "net",
  ],
};

const headerKey = (cell: string): string =>
  cell
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[:*]+$/, "")
    .replace(/\s+/g, " ");

function columnOf(cell: string): Column | null {
  const key = headerKey(cell);
  for (const column of Object.keys(HEADERS) as Column[])
    if (HEADERS[column].includes(key)) return column;
  return null;
}

const normalizeName = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

const error = (code: string, message: string, row?: number): OpeningIssue => ({
  severity: "error",
  code,
  message,
  ...(row !== undefined ? { row } : {}),
});
const info = (code: string, message: string, row?: number): OpeningIssue => ({
  severity: "info",
  code,
  message,
  ...(row !== undefined ? { row } : {}),
});

export interface OpeningCsvResult {
  readonly entries: readonly OpeningEntry[];
  readonly issues: readonly OpeningIssue[];
  /** The record number of the header row, or null when none was found. */
  readonly headerRow: number | null;
  /** Rows that named an account and gave an amount. */
  readonly rows: number;
}

/** Read the CSV against the chart. Entries are in the account's normal orientation; a file given as
 * debits and credits is converted with the account's side. */
export function parseOpeningCsv(
  text: string,
  accounts: readonly OpeningAccount[],
): OpeningCsvResult {
  const issues: OpeningIssue[] = [];
  const fail = (code: string, message: string): OpeningCsvResult => ({
    entries: [],
    issues: [error(code, message)],
    headerRow: null,
    rows: 0,
  });
  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") return fail("csv_empty", "The file is empty.");
  const table = tokenizeCsv(body, sniffDelimiter(body));
  if (table.records.length > MAX_CSV_ROWS + 50)
    return fail(
      "csv_too_long",
      `The file has more than ${MAX_CSV_ROWS} rows. Opening balances are one row per account.`,
    );

  // The header is the first row that names an account and an amount.
  let header: { index: number; columns: Map<Column, number> } | null = null;
  for (let index = 0; index < Math.min(table.records.length, 40); index++) {
    const record = table.records[index];
    if (!record || record.fields.length < 2) continue;
    const columns = new Map<Column, number>();
    for (const [at, cell] of record.fields.entries()) {
      const column = columnOf(cell);
      if (column !== null && !columns.has(column)) columns.set(column, at);
    }
    const identifies = columns.has("code") || columns.has("name") || columns.has("account");
    const amounts = columns.has("balance") || columns.has("debit") || columns.has("credit");
    if (identifies && amounts) {
      header = { index, columns };
      break;
    }
  }
  if (!header)
    return fail(
      "csv_no_header",
      "The first row must name the columns: an account (Code or Name) and a Balance, or a Debit and a Credit.",
    );
  const { columns } = header;
  const headerRow = (table.records[header.index] as { number: number }).number;
  const useSides = columns.has("debit") || columns.has("credit");
  if (useSides && columns.has("balance"))
    issues.push(
      info(
        "balance_column_ignored",
        "The file has Debit and Credit columns and a Balance column; the Debit and Credit columns are used.",
      ),
    );
  if (header.index > 0)
    issues.push(
      info("rows_before_header", `The ${header.index} rows above the column names were ignored.`),
    );

  const byCode = new Map<string, OpeningAccount>();
  const byName = new Map<string, OpeningAccount[]>();
  for (const account of accounts) {
    byCode.set(account.code.toLowerCase(), account);
    const key = normalizeName(account.name);
    byName.set(key, [...(byName.get(key) ?? []), account]);
  }
  const cell = (fields: readonly string[], column: Column): string => {
    const at = columns.get(column);
    return at === undefined ? "" : (fields[at] ?? "").trim();
  };

  const entries: OpeningEntry[] = [];
  let blankAmounts = 0;
  for (const record of table.records.slice(header.index + 1)) {
    const row = record.number;
    const fields = record.fields;
    if (fields.every((value) => value.trim() === "")) continue;
    const identity = [cell(fields, "code"), cell(fields, "name"), cell(fields, "account")].filter(
      (value) => value !== "",
    );
    const first = identity[0] ?? "";
    if (/^totals?\b/i.test(first) || /^grand total\b/i.test(first)) {
      issues.push(info("total_row_skipped", "A total row was skipped.", row));
      continue;
    }

    // Which account.
    const codeCell = cell(fields, "code");
    const nameCell = cell(fields, "name");
    const accountCell = cell(fields, "account");
    let account: OpeningAccount | undefined;
    const byCodeCell = codeCell !== "" ? byCode.get(codeCell.toLowerCase()) : undefined;
    const names = (value: string): OpeningAccount[] => byName.get(normalizeName(value)) ?? [];
    if (codeCell !== "") {
      account = byCodeCell;
      if (!account) {
        issues.push(
          error(
            "account_unknown",
            `No account has the code ${quoteCell(codeCell)}. Add the account, or fix the code.`,
            row,
          ),
        );
        continue;
      }
      const label = nameCell !== "" ? nameCell : accountCell;
      const labelled = label !== "" ? names(label) : [];
      if (labelled.length > 0 && !labelled.some((item) => item.id === account?.id)) {
        // A code and a name that disagree: do not guess which was meant.
        issues.push(
          error(
            "account_mismatch",
            `The code ${quoteCell(codeCell)} is ${account.code} ${quoteCell(account.name)}, but the name ${quoteCell(label)} is ${labelled[0]?.code}. Fix the row.`,
            row,
          ),
        );
        continue;
      }
      if (
        label !== "" &&
        labelled.length === 0 &&
        normalizeName(label) !== normalizeName(account.name)
      )
        issues.push(
          info(
            "label_differs",
            `Used ${account.code} ${quoteCell(account.name)}, picked by its code. The name ${quoteCell(label)} in the file was not used.`,
            row,
          ),
        );
    } else {
      const named = nameCell !== "" ? nameCell : accountCell;
      if (named === "") {
        issues.push(error("account_missing", "This row does not name an account.", row));
        continue;
      }
      account = byCode.get(named.toLowerCase());
      if (!account) {
        const candidates = names(named);
        if (candidates.length > 1) {
          issues.push(
            error(
              "account_ambiguous",
              `${quoteCell(named)} matches more than one account (${candidates.map((item) => item.code).join(", ")}). Use the code.`,
              row,
            ),
          );
          continue;
        }
        account = candidates[0];
      }
      if (!account) {
        issues.push(
          error(
            "account_unknown",
            `No account is named ${quoteCell(named)}. Add it to your chart, or fix the name.`,
            row,
          ),
        );
        continue;
      }
    }

    // How much.
    let balance: bigint | null = null;
    let broken = false;
    const amount = (column: Column): bigint | null => {
      const raw = cell(fields, column);
      if (raw === "") return null;
      const parsed = parseAmount(raw);
      if (!parsed.ok) {
        if (parsed.error === "empty") return null;
        issues.push(
          error(
            "amount_invalid",
            `The ${column} ${quoteCell(raw)} ${amountProblem(parsed.error)}.`,
            row,
          ),
        );
        broken = true;
        return null;
      }
      return parsed.cents;
    };
    if (useSides) {
      const debit = amount("debit");
      const credit = amount("credit");
      if (broken) continue;
      if ((debit !== null && debit < 0n) || (credit !== null && credit < 0n)) {
        issues.push(
          error(
            "negative_in_side_column",
            "A debit or credit column holds a negative amount. Put the amount in the other column instead.",
            row,
          ),
        );
        continue;
      }
      if (debit !== null && credit !== null && debit !== 0n && credit !== 0n) {
        issues.push(
          error(
            "both_sides",
            "This row has both a debit and a credit. Give an account one balance.",
            row,
          ),
        );
        continue;
      }
      if (debit !== null || credit !== null)
        balance = ((debit ?? 0n) - (credit ?? 0n)) * (sideOf(account.role) === "debit" ? 1n : -1n);
    } else {
      balance = amount("balance");
      if (broken) continue;
    }
    if (balance === null) {
      blankAmounts++;
      continue;
    }
    entries.push({ accountId: account.id, balance: formatMoney(balance), row });
  }
  if (blankAmounts > 0)
    issues.push(
      info(
        "blank_amounts",
        `${blankAmounts} ${blankAmounts === 1 ? "row has" : "rows have"} an account and no amount, and ${blankAmounts === 1 ? "was" : "were"} skipped.`,
      ),
    );
  if (entries.length === 0 && !issues.some((issue) => issue.severity === "error"))
    issues.push(error("csv_no_rows", "The file has no rows with an account and an amount."));
  return { entries, issues, headerRow, rows: entries.length };
}

import { ApplicationError } from "../errors.ts";
import type { ApplicationService } from "../service.ts";
import { ingestFor } from "../slices/statements/ports.ts";
import { parseAmount } from "../statements/amounts.ts";
import { type CsvTable, sniffDelimiter, tokenizeCsv } from "../statements/csv.ts";
import { isZip, sheetTable } from "../statements/xlsx.ts";
import { decodeText } from "../statements/text.ts";
import { accountResolver } from "./plan.ts";
import { MAX_PROBLEMS } from "./parse.ts";
import { planBook } from "./run.ts";

/** Tying the book to the old books: the balance of every account at a date, from the book, against the trial
 * balance the old system gave for that date. History is proved year by year, so this is asked for each year
 * end: a trial balance at the last day of 2016, of 2017, and so on. The file is a CSV with an account (a code, a
 * name or both) and a debit and a credit, or one signed balance (a debit is positive). Reading it changes
 * nothing. */

export interface TieOutInput {
  readonly file: string;
  readonly asOf: string;
  readonly map?: readonly { readonly account: string; readonly to: string }[];
}

export interface TieOutRow {
  readonly account: string;
  readonly name: string;
  readonly file: string;
  readonly book: string;
  readonly difference: string;
}

export interface TieOutResult {
  readonly asOf: string;
  readonly tied: boolean;
  readonly accounts: readonly TieOutRow[];
  readonly differing: number;
  /** Accounts of the file the book has no account for, and the balance the file gives them. */
  readonly unmapped: readonly string[];
  /** What the file's own balances add up to: 0.00 when the old books' trial balance balanced. */
  readonly fileTotal: string;
  readonly problems: readonly {
    readonly row: number;
    readonly code: string;
    readonly message: string;
  }[];
  readonly problemCount: number;
}

const ACCOUNT = ["account", "accountname", "acct", "name"];
const CODE = ["accountcode", "code", "acctcode", "accountnumber", "acctnumber", "accountno"];
const DEBIT = ["debit", "debits", "dr", "debitamount", "ytddebit"];
const CREDIT = ["credit", "credits", "cr", "creditamount", "ytdcredit"];
const BALANCE = ["balance", "amount", "net", "netbalance", "endingbalance"];
const key = (cell: string) => cell.toLowerCase().replace(/[^a-z0-9]/g, "");

const signed = (cents: bigint): string => {
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
};

/** Hundredths of the book's currency from an amount with its own scale. */
const hundredths = (amount: { readonly coefficient: bigint; readonly scale: bigint }): bigint =>
  amount.scale === 2n
    ? amount.coefficient
    : amount.scale < 2n
      ? amount.coefficient * 10n ** (2n - amount.scale)
      : amount.coefficient / 10n ** (amount.scale - 2n);

export async function tieOut(
  service: ApplicationService,
  input: TieOutInput,
): Promise<TieOutResult> {
  const archived = ingestFor(service).readArchive(input.file);
  if (!archived)
    throw new ApplicationError(
      "file_not_found",
      "That file has not been uploaded. Upload it first (POST /v1/uploads, or the command line), then name it by its SHA-256.",
      404,
    );
  let table: CsvTable;
  if (isZip(archived.bytes)) {
    try {
      table = sheetTable(archived.bytes);
    } catch {
      table = { delimiter: ",", records: [], truncated: false, fieldsCut: 0 };
    }
  } else {
    const text = decodeText(archived.bytes).text;
    table = tokenizeCsv(text, sniffDelimiter(text));
  }
  const problems: { row: number; code: string; message: string }[] = [];
  let problemCount = 0;
  const problem = (row: number, code: string, message: string) => {
    problemCount += 1;
    if (problems.length < MAX_PROBLEMS) problems.push({ row, code, message });
  };

  // The header: the first row that names an account and amounts.
  interface Columns {
    account?: number;
    code?: number;
    debit?: number;
    credit?: number;
    balance?: number;
  }
  let at: Columns | null = null;
  let headerAt = -1;
  for (let position = 0; position < Math.min(table.records.length, 30) && !at; position += 1) {
    const fields = table.records[position]?.fields ?? [];
    const found: Columns = {};
    fields.forEach((cell, index) => {
      const name = key(cell);
      if (found.code === undefined && CODE.includes(name)) found.code = index;
      else if (found.account === undefined && ACCOUNT.includes(name)) found.account = index;
      else if (found.debit === undefined && DEBIT.includes(name)) found.debit = index;
      else if (found.credit === undefined && CREDIT.includes(name)) found.credit = index;
      else if (found.balance === undefined && BALANCE.includes(name)) found.balance = index;
    });
    const hasAccount = found.account !== undefined || found.code !== undefined;
    if (
      hasAccount &&
      ((found.debit !== undefined && found.credit !== undefined) || found.balance !== undefined)
    ) {
      at = found;
      headerAt = position;
    }
  }
  if (!at)
    return {
      asOf: input.asOf,
      tied: false,
      accounts: [],
      differing: 0,
      unmapped: [],
      fileTotal: "0.00",
      problems: [
        {
          row: 1,
          code: "no_header",
          message:
            "No row names an account and a debit and credit (or a balance). The file needs columns such as Account, Debit and Credit.",
        },
      ],
      problemCount: 1,
    };
  const columns = at;

  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const book = planBook(service, state);
  const resolve = accountResolver(
    book.accounts,
    Object.fromEntries((input.map ?? []).map((pair) => [pair.account, pair.to])),
  );
  const cell = (fields: readonly string[], position: number | undefined) =>
    position === undefined ? "" : (fields[position] ?? "").trim();
  const money = (row: number, label: string, value: string): bigint => {
    if (value === "") return 0n;
    const parsed = parseAmount(value);
    if (!parsed.ok) {
      problem(row, "amount", `"${value.slice(0, 30)}" in ${label} is not an amount.`);
      return 0n;
    }
    return parsed.cents;
  };

  const expected = new Map<string, bigint>();
  const unmapped = new Map<string, bigint>();
  let fileTotal = 0n;
  for (const record of table.records.slice(headerAt + 1)) {
    const fields = record.fields;
    if (fields.every((field) => field.trim() === "")) continue;
    let code = cell(fields, columns.code);
    let name = cell(fields, columns.account);
    if ((code === "" && name === "") || /^totals?\b/i.test(name || code)) continue;
    // "Sales (4000)" in one column, as Xero's trial balance writes an account, is a name and a code, unless the
    // whole is the name of one of the book's accounts ("Cash (Checking)").
    const bracketed =
      code === "" && resolve("", name) === null
        ? /^(.*\S)\s*\(([A-Z0-9][A-Z0-9._-]{0,19})\)$/.exec(name)
        : null;
    if (bracketed) {
      name = bracketed[1] as string;
      code = bracketed[2] as string;
    }
    const balance =
      columns.debit !== undefined && columns.credit !== undefined
        ? money(record.number, "Debit", cell(fields, columns.debit)) -
          money(record.number, "Credit", cell(fields, columns.credit))
        : money(record.number, "Balance", cell(fields, columns.balance));
    if (balance === 0n) continue;
    fileTotal += balance;
    const account = resolve(code, name);
    if (account) expected.set(account.code, (expected.get(account.code) ?? 0n) + balance);
    else {
      const label = `${code} ${name}`.trim();
      unmapped.set(label, (unmapped.get(label) ?? 0n) + balance);
    }
  }

  // What the book holds, to the end of the day asked for.
  const names = new Map(
    state.admissionSnapshot.accounts.map((account) => [account.id as string, account]),
  );
  const held = new Map<string, bigint>();
  for (const booked of state.journals) {
    if ((booked.journal.accountingDate as string) > input.asOf) continue;
    for (const posting of booked.journal.postings) {
      const account = names.get(posting.accountId as string);
      if (!account) continue;
      held.set(account.code, (held.get(account.code) ?? 0n) + hundredths(posting.bookValue.amount));
    }
  }

  const codes = new Set([...expected.keys(), ...held.keys()]);
  const rows: (TieOutRow & { readonly gap: bigint })[] = [];
  for (const code of codes) {
    const file = expected.get(code) ?? 0n;
    const book = held.get(code) ?? 0n;
    if (file === 0n && book === 0n) continue;
    const gap = book - file;
    const account = state.admissionSnapshot.accounts.find((item) => item.code === code);
    rows.push({
      account: code,
      name: account?.name ?? "",
      file: signed(file),
      book: signed(book),
      difference: signed(gap),
      gap,
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.gap !== 0n) - Number(a.gap !== 0n) ||
      a.account.localeCompare(b.account, "en", { numeric: true }),
  );
  const differing = rows.filter((row) => row.gap !== 0n).length;
  return {
    asOf: input.asOf,
    tied: differing === 0 && unmapped.size === 0 && problemCount === 0,
    accounts: rows.slice(0, 500).map(({ gap: _gap, ...row }) => row),
    differing,
    unmapped: [...unmapped.entries()]
      .slice(0, 100)
      .map(([label, balance]) => `${label}: ${signed(balance)}`),
    fileTotal: signed(fileTotal),
    problems,
    problemCount,
  };
}

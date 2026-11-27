import { parseAmount } from "./amounts.ts";
import type { CsvRecord, CsvTable } from "./csv.ts";
import {
  type AmountMapping,
  type ColumnRef,
  type CsvMapping,
  normalizeHeader,
} from "./csv-mapping.ts";
import { isDateLike } from "./dates.ts";
import { CSV_PRESETS, type CsvPreset } from "./presets.ts";

/** Working out what a CSV is when nobody said: where its header is, and which columns hold the
 * date, the amount, the description and the rest. Everything here is a guess from the file's own
 * content, so it reports what it found and what it could not, and the caller shows both. */

const HEADER_WORDS = new Set([
  "date",
  "amount",
  "description",
  "memo",
  "payee",
  "debit",
  "credit",
  "balance",
  "bal",
  "type",
  "details",
  "status",
  "reference",
  "check",
  "name",
  "category",
  "transaction",
  "withdrawal",
  "withdrawals",
  "deposit",
  "deposits",
  "posted",
  "posting",
  "post",
  "narrative",
  "merchant",
  "debits",
  "credits",
  "ref",
  "number",
  "running",
  "slip",
  "sender",
  "recipient",
  "counterparty",
  "currency",
  "timestamp",
]);

function words(cell: string): string[] {
  return normalizeHeader(cell)
    .split(/[^a-z]+/)
    .filter((word) => word !== "");
}

function isNumeric(cell: string): boolean {
  const text = cell.trim();
  return text !== "" && parseAmount(text).ok;
}

/** How header-like a row is: the number of cells made of header words, and zero if any cell is a
 * date or a number (a data row can mention "Transaction" but it also holds a date and an amount). */
function headerScore(record: CsvRecord): number {
  let score = 0;
  for (const cell of record.fields) {
    const text = cell.trim();
    if (text === "") continue;
    if (isNumeric(text) || isDateLike(text)) return 0;
    if (text.length > 60) continue;
    if (words(text).some((word) => HEADER_WORDS.has(word))) score++;
  }
  return score;
}

const nonBlank = (record: CsvRecord) => record.fields.some((cell) => cell.trim() !== "");

/** The one-based row of the header, or 0 when the file has none. Looks at the first rows only: a
 * statement may begin with an account summary, but not hundreds of lines of it. */
export function findHeaderRow(table: CsvTable): number {
  const records = table.records;
  const limit = Math.min(records.length, 60);
  for (let index = 0; index < limit; index++) {
    const record = records[index] as CsvRecord;
    if (!nonBlank(record)) continue;
    if (headerScore(record) >= 2) return record.number;
  }
  // No row says "Date" and "Amount". A single heading row of plain text above dated rows is still
  // a header; dated rows from the first line mean there is none.
  for (let index = 0; index < limit; index++) {
    const record = records[index] as CsvRecord;
    if (!nonBlank(record)) continue;
    if (record.fields.some((cell) => isDateLike(cell.trim()))) return 0;
    const next = records.slice(index + 1, index + 4).find(nonBlank);
    const filled = record.fields.filter((cell) => cell.trim() !== "").length;
    const textOnly = record.fields.every((cell) => !isNumeric(cell.trim()));
    const datedBelow = next?.fields.some((cell) => isDateLike(cell.trim())) === true;
    return filled >= 2 && textOnly && datedBelow ? record.number : 0;
  }
  return 0;
}

/** A value shown in a column picker: bounded and with control characters made visible. */
export function visibleText(text: string, limit = 60): string {
  let shown = "";
  let count = 0;
  for (const symbol of text.trim()) {
    // Bound the output, escapes included: a hostile cell cannot make this longer than `limit` plus
    // one escape.
    if (count >= limit || shown.length >= limit) {
      shown += "…";
      break;
    }
    const code = symbol.codePointAt(0) ?? 0;
    shown +=
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : symbol;
    count++;
  }
  return shown;
}

export interface ColumnInfo {
  /** One-based position. */
  readonly index: number;
  /** The header text, empty when the file has no header or the cell is empty. */
  readonly header: string;
  /** A few values from the first rows, for recognising the column. */
  readonly samples: readonly string[];
}

/** The columns of a file as a picker would list them. */
export function describeColumns(
  table: CsvTable,
  headerRow: number,
  options: { samples?: number } = {},
): ColumnInfo[] {
  const records = table.records;
  const header = headerRow > 0 ? records[headerRow - 1] : undefined;
  const data: CsvRecord[] = [];
  for (let index = headerRow; index < records.length && data.length < 40; index++) {
    const record = records[index] as CsvRecord;
    if (nonBlank(record)) data.push(record);
  }
  let width = header ? header.fields.length : 0;
  for (const record of data) width = Math.max(width, record.fields.length);
  // A trailing delimiter makes every row one empty column wider; do not offer that column.
  while (
    width > 1 &&
    data.every((record) => (record.fields[width - 1] ?? "").trim() === "") &&
    !(header?.fields[width - 1] ?? "").trim()
  )
    width--;
  const wanted = options.samples ?? 3;
  const columns: ColumnInfo[] = [];
  for (let column = 0; column < Math.min(width, 64); column++) {
    const samples: string[] = [];
    for (const record of data) {
      const value = (record.fields[column] ?? "").trim();
      if (value !== "" && !samples.includes(value)) samples.push(value);
      if (samples.length >= wanted) break;
    }
    columns.push({
      index: column + 1,
      header: visibleText(header?.fields[column] ?? "", 80),
      samples: samples.map((value) => visibleText(value)),
    });
  }
  return columns;
}

const PREFERRED_DATES = [
  "posting date",
  "post date",
  "posted date",
  "date posted",
  "posted",
  "settled date",
  "settlement date",
];
const PLAIN_DATES = [
  "date",
  "transaction date",
  "trans date",
  "trans. date",
  "date (utc)",
  "booking date",
  "processed date",
  "effective date",
  "timestamp",
];
const AMOUNTS = [
  "amount",
  "transaction amount",
  "amt",
  "net amount",
  "value",
  "amount (usd)",
  "usd amount",
];
const DEBITS = [
  "debit",
  "debits",
  "withdrawal",
  "withdrawals",
  "money out",
  "paid out",
  "debit amount",
  "withdrawal amount",
  "amount debit",
];
const CREDITS = [
  "credit",
  "credits",
  "deposit",
  "deposits",
  "money in",
  "paid in",
  "credit amount",
  "deposit amount",
  "amount credit",
];
const DESCRIPTIONS = [
  "description",
  "transaction description",
  "original description",
  "bank description",
  "payee",
  "payee name",
  "name",
  "merchant",
  "narrative",
  "details",
  "transaction details",
  "extended description",
];
const MEMOS = ["memo", "notes", "note", "additional info", "extended details"];
const REFERENCES = [
  "check or slip #",
  "check number",
  "check #",
  "check no",
  "checknumber",
  "reference",
  "reference number",
  "ref",
  "ref #",
  "ref no",
  "transaction id",
  "trace number",
];
const BALANCES = [
  "balance",
  "running bal.",
  "running bal",
  "running balance",
  "runningbalance",
  "ledger balance",
  "balance after",
];
const DIRECTIONS = [
  "type",
  "transaction type",
  "debit/credit",
  "dr/cr",
  "cr/dr",
  "direction",
  "credit debit indicator",
  "debit or credit",
  "credit/debit",
];

const OUT_WORDS = ["debit", "d", "dr", "withdrawal", "out", "db"];
const IN_WORDS = ["credit", "c", "cr", "deposit", "in"];

function firstMatch(headers: readonly string[], names: readonly string[]): number {
  for (const name of names) {
    const found = headers.indexOf(name);
    if (found !== -1) return found;
  }
  return -1;
}

export interface Guess {
  /** The mapping found, or null when the date or the amount could not be found. */
  readonly mapping: CsvMapping | null;
  /** What could not be found, in words, for the person choosing columns by hand. */
  readonly missing: readonly string[];
}

/** Guess a mapping from a header row and the rows below it. Prefers a posting date to a
 * transaction date, one signed amount column to a pair, and tells a debit/credit pair from a
 * "Type" column by looking at the values. */
export function guessMapping(table: CsvTable, headerRow: number): Guess {
  const records = table.records;
  const header = headerRow > 0 ? records[headerRow - 1] : undefined;
  const missing: string[] = [];
  if (!header) {
    return {
      mapping: null,
      missing: ["a header row, so each column has to be chosen by position"],
    };
  }
  const headers = header.fields.map(normalizeHeader);
  const ref = (index: number): ColumnRef => ({
    header: (header.fields[index] as string).trim(),
    index: index + 1,
  });
  let date = firstMatch(headers, PREFERRED_DATES);
  if (date === -1) date = firstMatch(headers, PLAIN_DATES);
  if (date === -1) date = headers.findIndex((name) => name.includes("date"));
  const amountIndex = firstMatch(headers, AMOUNTS);
  const debit = firstMatch(headers, DEBITS);
  const credit = firstMatch(headers, CREDITS);
  const directionIndex = firstMatch(headers, DIRECTIONS);
  const data = records.slice(headerRow).filter(nonBlank).slice(0, 200);
  const values = (column: number) =>
    data.map((record) => (record.fields[column] ?? "").trim()).filter((value) => value !== "");

  let amount: AmountMapping | null = null;
  if (amountIndex !== -1) {
    const direction = directionIndex !== -1 && directionIndex !== amountIndex ? directionIndex : -1;
    const amounts = values(amountIndex);
    const anyNegative = amounts.some((value) => {
      const parsed = parseAmount(value);
      return parsed.ok && parsed.cents < 0n;
    });
    if (direction !== -1 && !anyNegative) {
      const seen = [...new Set(values(direction).map((value) => value.toLowerCase()))];
      const known = seen.filter((value) => OUT_WORDS.includes(value) || IN_WORDS.includes(value));
      if (known.length >= 2 && known.length === seen.length)
        amount = {
          kind: "direction",
          amount: ref(amountIndex),
          direction: ref(direction),
          outValues: seen.filter((value) => OUT_WORDS.includes(value)),
          inValues: seen.filter((value) => IN_WORDS.includes(value)),
        };
    }
    amount ??= { kind: "signed", amount: ref(amountIndex) };
  } else if (debit !== -1 && credit !== -1 && debit !== credit) {
    amount = { kind: "debitCredit", debit: ref(debit), credit: ref(credit) };
  }
  if (date === -1) missing.push("the date column");
  if (!amount) missing.push("the amount column (or a debit column and a credit column)");

  const descriptionIndex = firstMatch(headers, DESCRIPTIONS);
  const memoIndex = firstMatch(headers, MEMOS);
  const description: ColumnRef[] = [];
  if (descriptionIndex !== -1) description.push(ref(descriptionIndex));
  if (memoIndex !== -1 && memoIndex !== descriptionIndex) description.push(ref(memoIndex));
  if (description.length === 0) missing.push("the description column");
  const referenceIndex = firstMatch(headers, REFERENCES);
  const balanceIndex = firstMatch(headers, BALANCES);
  if (date === -1 || !amount) return { mapping: null, missing };
  return {
    mapping: {
      headerRow,
      date: ref(date),
      dateOrder: "auto",
      amount,
      description,
      ...(referenceIndex !== -1 && referenceIndex !== descriptionIndex
        ? { reference: ref(referenceIndex) }
        : {}),
      ...(balanceIndex !== -1 ? { balance: ref(balanceIndex) } : {}),
    },
    missing,
  };
}

/** The preset whose header fits the file best, among the presets distinctive enough to pick
 * unasked. A preset fits when every header it requires is present; the one that requires and finds
 * the most wins, and a tie goes to the earlier one in the list. */
export function matchPreset(table: CsvTable, headerRow: number): CsvPreset | null {
  const records = table.records;
  const header = headerRow > 0 ? records[headerRow - 1] : undefined;
  const names = new Set(header ? header.fields.map(normalizeHeader) : []);
  let best: { preset: CsvPreset; score: number } | null = null;
  for (const preset of CSV_PRESETS) {
    if (!preset.autoDetect && !(preset.detectWith && preset.detectWith.length > 0)) continue;
    let score = 0;
    if (preset.headerless) {
      if (headerRow !== 0) continue;
      const first = records.find(nonBlank);
      if (!first) continue;
      const width = first.fields.length;
      const { columns, dateColumn, amountColumn } = preset.headerless;
      if (
        width !== columns &&
        !(width === columns + 1 && (first.fields[columns] ?? "").trim() === "")
      )
        continue;
      if (!isDateLike((first.fields[dateColumn - 1] ?? "").trim())) continue;
      if (!parseAmount((first.fields[amountColumn - 1] ?? "").trim()).ok) continue;
      score = 100;
    } else {
      if (!header || !preset.requires.every((name) => names.has(name))) continue;
      if (!preset.autoDetect && !(preset.detectWith ?? []).every((name) => names.has(name)))
        continue;
      score =
        preset.requires.length * 2 +
        (preset.detectWith ?? []).length * 2 +
        (preset.optional ?? []).filter((name) => names.has(name)).length;
    }
    if (best === null || score > best.score) best = { preset, score };
  }
  return best ? best.preset : null;
}

import type { BankLine } from "../ingest-types.ts";
import { formatMoney } from "../money.ts";
import { amountProblem, parseAmount } from "./amounts.ts";
import type { CsvRecord, CsvTable, Delimiter } from "./csv.ts";
import {
  analyzeDateOrder,
  formatDate,
  parseDate,
  type DateOrder,
  type DateOrderChoice,
} from "./dates.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { FLAG_MESSAGE, hostileFlags, quoteCell, truncateText } from "./hostile.ts";

/** How the columns of a bank's CSV become lines. A mapping is plain data: the wizard builds one, a
 * profile saves one, a preset ships one, and the same code applies all of them.
 *
 * Columns are named by header, so a bank that reorders its export, or a neobank that lets you pick
 * the columns, still maps; a position is the fallback, and the only way to name a column in a file
 * with no header row. */

export interface ColumnRef {
  /** The header text, compared ignoring case and surrounding or repeated spaces. */
  readonly header?: string;
  /** The one-based position of the column. */
  readonly index?: number;
  /** A column an export may leave out (the user picks the columns at some banks). When it is
   * missing it is skipped instead of failing the mapping. Never honoured for the date and amount. */
  readonly optional?: boolean;
}

export interface AmountMapping {
  /** `signed`: one column, positive money in and negative money out. `debitCredit`: one column for
   * money out and one for money in. `direction`: an amount column plus a column that says which way. */
  readonly kind: "signed" | "debitCredit" | "direction";
  readonly amount?: ColumnRef;
  readonly debit?: ColumnRef;
  readonly credit?: ColumnRef;
  readonly direction?: ColumnRef;
  /** Values of the direction column that mean money out of the account ("DEBIT", "D", "DR"). */
  readonly outValues?: readonly string[];
  /** Values that mean money into the account ("CREDIT", "C", "CR"). */
  readonly inValues?: readonly string[];
  /** The issuer writes charges as positive amounts (American Express): flip every sign. */
  readonly invert?: boolean;
}

/** Import only the rows whose value in a column is one of these (compared ignoring case). The rows
 * skipped are counted by value and reported, never silently dropped. */
export interface RowFilter {
  readonly column: ColumnRef;
  readonly values: readonly string[];
}

export interface CsvMapping {
  readonly delimiter?: Delimiter;
  /** The one-based row of the header; 0 means the file has none. Left out, it is detected. */
  readonly headerRow?: number;
  readonly date: ColumnRef;
  /** `auto` reads the order from the data and refuses to guess when the data cannot say. */
  readonly dateOrder?: DateOrderChoice;
  readonly amount: AmountMapping;
  /** Joined with a single space, in this order, skipping empty cells. */
  readonly description: readonly ColumnRef[];
  readonly counterparty?: ColumnRef;
  readonly reference?: ColumnRef;
  /** The running balance after each line, when the bank exports one. */
  readonly balance?: ColumnRef;
  /** The balance column counts the other way (it shows what is owed). Left out, the file's own
   * arithmetic decides. */
  readonly invertBalance?: boolean;
  /** ISO 4217. Left out, the book's currency. */
  readonly currency?: string;
  /** The character separating cents. Left out, ".". */
  readonly decimal?: "." | ",";
  readonly include?: RowFilter;
}

/** A line with the number of the file row it came from, for messages. */
export interface StatementLine {
  readonly line: BankLine;
  /** The one-based row in the file (a CSV record or an OFX transaction). */
  readonly row: number;
}

export interface ParseStats {
  /** Rows that held data (not blank). */
  readonly rows: number;
  /** Rows skipped because their value in the filter column was not listed, by value. */
  readonly filtered: Readonly<Record<string, number>>;
  /** Rows with no amount (balance markers, headings, totals). */
  readonly noAmount: number;
  /** Rows whose amount is exactly 0.00. */
  readonly zero: number;
  /** Rows dropped because of an error. */
  readonly invalid: number;
}

export interface CsvOutcome {
  readonly lines: readonly StatementLine[];
  readonly stats: ParseStats;
  /** The mapping that was applied, with every column's header and position filled in, so it can be
   * saved as a profile and mean the same thing next time. */
  readonly effective: CsvMapping | null;
  readonly dateOrder: DateOrder | null;
  readonly headers: readonly string[];
}

export interface CsvContext {
  readonly accountKey: string;
  /** The book's currency, used when the mapping does not name one. */
  readonly defaultCurrency: string;
}

const EXCERPT_LIMIT = 4096;
const COUNTERPARTY_LIMIT = 200;
const REFERENCE_LIMIT = 100;

export function normalizeHeader(text: string): string {
  return text.replace(/^﻿/, "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

const ORDER_NAME: Readonly<Record<DateOrder, string>> = {
  mdy: "month/day/year",
  dmy: "day/month/year",
  ymd: "year-month-day",
};

interface Columns {
  date: number;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  direction: number | null;
  description: number[];
  counterparty: number | null;
  reference: number | null;
  balance: number | null;
  include: number | null;
}

function allBlank(fields: readonly string[]): boolean {
  for (const field of fields) if (field.trim() !== "") return false;
  return true;
}

/** Describe a column for a message without echoing text from the file. */
function describeRef(ref: ColumnRef): string {
  if (ref.header !== undefined) return quoteCell(ref.header, 60);
  return `number ${ref.index ?? "?"}`;
}

export function applyCsvMapping(
  text: string,
  table: CsvTable,
  mapping: CsvMapping,
  context: CsvContext,
  diagnostics: Diagnostics,
): CsvOutcome {
  const records = table.records;
  const headerRow = mapping.headerRow ?? 0;
  const headerRecord: CsvRecord | undefined = headerRow > 0 ? records[headerRow - 1] : undefined;
  const headerCells = headerRecord ? headerRecord.fields.map(normalizeHeader) : null;
  const headerDisplay = headerRecord ? headerRecord.fields.map((cell) => cell.trim()) : [];
  const empty = (effective: CsvMapping | null = null): CsvOutcome => ({
    lines: [],
    stats: { rows: 0, filtered: {}, noAmount: 0, zero: 0, invalid: 0 },
    effective,
    dateOrder: null,
    headers: headerDisplay,
  });
  if (headerRow > 0 && !headerRecord) {
    diagnostics.error(
      "header_missing",
      `The file has no row ${headerRow}, where the header should be`,
    );
    return empty();
  }
  let widest = headerRecord ? headerRecord.fields.length : 0;
  if (!headerRecord)
    for (const record of records.slice(0, 200)) widest = Math.max(widest, record.fields.length);

  let failed = false;
  const effectiveRefs = new Map<ColumnRef, ColumnRef>();
  const locate = (ref: ColumnRef, label: string): number | null => {
    let found: number | null = null;
    if (ref.header !== undefined && headerCells) {
      const wanted = normalizeHeader(ref.header);
      const first = headerCells.indexOf(wanted);
      if (first !== -1) {
        found =
          ref.index !== undefined && headerCells[ref.index - 1] === wanted ? ref.index - 1 : first;
      }
    }
    if (found === null && ref.index !== undefined) {
      if (ref.index >= 1 && ref.index <= Math.max(widest, 1)) {
        found = ref.index - 1;
        if (ref.header !== undefined)
          diagnostics.warning(
            "column_by_position",
            `The ${label} column ${describeRef(ref)} is not in this file's header; column ${ref.index} was used instead`,
          );
      }
    }
    if (found === null) {
      if (
        ref.optional &&
        label !== "date" &&
        label !== "amount" &&
        label !== "debit" &&
        label !== "credit"
      )
        return null;
      failed = true;
      diagnostics.error(
        "column_missing",
        `The ${label} column ${describeRef(ref)} was not found in this file`,
      );
      return null;
    }
    effectiveRefs.set(ref, {
      // The header is attacker-controlled text; the copy that travels is bounded.
      ...(headerDisplay[found] !== undefined && headerDisplay[found] !== ""
        ? { header: (headerDisplay[found] as string).slice(0, 200) }
        : {}),
      index: found + 1,
    });
    return found;
  };
  const optional = (ref: ColumnRef | undefined, label: string): number | null =>
    ref ? locate(ref, label) : null;

  const amount = mapping.amount;
  const columns: Columns = {
    date: locate(mapping.date, "date") ?? -1,
    amount: null,
    debit: null,
    credit: null,
    direction: null,
    description: [],
    counterparty: optional(mapping.counterparty, "counterparty"),
    reference: optional(mapping.reference, "reference"),
    balance: optional(mapping.balance, "balance"),
    include: optional(mapping.include?.column, "filter"),
  };
  if (amount.kind === "signed" || amount.kind === "direction") {
    if (!amount.amount) {
      failed = true;
      diagnostics.error("mapping_incomplete", "The mapping needs an amount column");
    } else columns.amount = locate(amount.amount, "amount");
  }
  if (amount.kind === "debitCredit") {
    if (!amount.debit || !amount.credit) {
      failed = true;
      diagnostics.error(
        "mapping_incomplete",
        "The mapping needs a debit column and a credit column",
      );
    } else {
      columns.debit = locate(amount.debit, "debit");
      columns.credit = locate(amount.credit, "credit");
    }
  }
  if (amount.kind === "direction") {
    if (!amount.direction) {
      failed = true;
      diagnostics.error("mapping_incomplete", "The mapping needs a direction column");
    } else columns.direction = locate(amount.direction, "direction");
    if ((amount.outValues ?? []).length === 0 || (amount.inValues ?? []).length === 0) {
      failed = true;
      diagnostics.error(
        "mapping_incomplete",
        "The mapping needs the direction values that mean money out and money in",
      );
    }
  }
  for (const ref of mapping.description) {
    const index = locate(ref, "description");
    if (index !== null) columns.description.push(index);
  }
  if (mapping.description.length === 0) {
    failed = true;
    diagnostics.error("mapping_incomplete", "The mapping needs at least one description column");
  } else if (columns.description.length === 0 && !failed) {
    failed = true;
    diagnostics.error(
      "column_missing",
      "None of the description columns the mapping names is in this file",
    );
  }
  const currency = (mapping.currency ?? context.defaultCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    failed = true;
    diagnostics.error(
      "bad_currency",
      `${quoteCell(currency, 12)} is not a three-letter currency code`,
    );
  }
  if (failed || columns.date < 0) return empty();

  const effective: CsvMapping = {
    ...mapping,
    headerRow,
    date: effectiveRefs.get(mapping.date) as ColumnRef,
    amount: {
      ...amount,
      ...(amount.amount ? { amount: effectiveRefs.get(amount.amount) as ColumnRef } : {}),
      ...(amount.debit ? { debit: effectiveRefs.get(amount.debit) as ColumnRef } : {}),
      ...(amount.credit ? { credit: effectiveRefs.get(amount.credit) as ColumnRef } : {}),
      ...(amount.direction ? { direction: effectiveRefs.get(amount.direction) as ColumnRef } : {}),
    },
    description: mapping.description.flatMap((ref) => {
      const found = effectiveRefs.get(ref);
      return found ? [found] : [];
    }),
    ...(mapping.counterparty && effectiveRefs.has(mapping.counterparty)
      ? { counterparty: effectiveRefs.get(mapping.counterparty) as ColumnRef }
      : {}),
    ...(mapping.reference && effectiveRefs.has(mapping.reference)
      ? { reference: effectiveRefs.get(mapping.reference) as ColumnRef }
      : {}),
    ...(mapping.balance && effectiveRefs.has(mapping.balance)
      ? { balance: effectiveRefs.get(mapping.balance) as ColumnRef }
      : {}),
    ...(mapping.include && effectiveRefs.has(mapping.include.column)
      ? {
          include: {
            column: effectiveRefs.get(mapping.include.column) as ColumnRef,
            values: mapping.include.values,
          },
        }
      : {}),
  };
  if (mapping.include && columns.include === null)
    diagnostics.warning(
      "filter_column_missing",
      `This file has no ${describeRef(mapping.include.column)} column, so rows that are not final (pending or cancelled) cannot be told apart; every row is imported`,
    );

  const decimal = mapping.decimal ?? ".";
  const first = headerRow; // index of the first data record
  const lastNeeded = Math.max(
    columns.date,
    columns.amount ?? -1,
    columns.debit ?? -1,
    columns.credit ?? -1,
    columns.direction ?? -1,
  );

  // The order of the dates is a fact about the whole column, so it is settled before any row.
  let order: DateOrder | null = null;
  const dateCells: string[] = [];
  for (let index = first; index < records.length; index++) {
    const record = records[index] as CsvRecord;
    if (record.fields.length > columns.date) dateCells.push(record.fields[columns.date] as string);
  }
  if (mapping.dateOrder !== undefined && mapping.dateOrder !== "auto") order = mapping.dateOrder;
  else {
    const analysis = analyzeDateOrder(dateCells);
    if (analysis.order) {
      order = analysis.order;
      if (order !== "ymd")
        diagnostics.info(
          "date_order",
          `Dates are read as ${ORDER_NAME[order]} because the dates in this file rule out the other order`,
        );
    } else if (analysis.ambiguous) {
      diagnostics.error(
        "ambiguous_dates",
        "Every date in this file could be month/day/year or day/month/year, and the data cannot say which. Choose the date order.",
      );
    } else if (analysis.conflicting) {
      diagnostics.error(
        "mixed_dates",
        "The dates in this file are written in more than one order. Choose the date order, or fix the file.",
      );
    } else {
      diagnostics.error(
        "no_dates",
        `No value in the date column ${describeRef(effective.date)} reads as a date. Check which column holds the date.`,
      );
    }
  }
  if (order === null) return empty(effective);

  const allowed = mapping.include
    ? new Set(mapping.include.values.map((value) => value.trim().toLowerCase()))
    : null;
  const outValues = new Set((amount.outValues ?? []).map((value) => value.trim().toLowerCase()));
  const inValues = new Set((amount.inValues ?? []).map((value) => value.trim().toLowerCase()));
  const filtered = new Map<string, number>();
  const lines: StatementLine[] = [];
  let rows = 0;
  let noAmount = 0;
  let zero = 0;
  let invalid = 0;
  const textFields: { label: string; index: number | null; limit: number }[] = [
    { label: "counterparty", index: columns.counterparty, limit: COUNTERPARTY_LIMIT },
    { label: "reference", index: columns.reference, limit: REFERENCE_LIMIT },
  ];

  for (let index = first; index < records.length; index++) {
    const record = records[index] as CsvRecord;
    const fields = record.fields;
    if (fields.length === 0 || allBlank(fields)) continue;
    rows++;
    const number = record.number;
    const cell = (column: number | null): string =>
      column === null ? "" : ((fields[column] as string | undefined) ?? "");

    if (allowed && columns.include !== null) {
      const value = cell(columns.include).trim();
      if (!allowed.has(value.toLowerCase())) {
        const key = value === "" ? "(empty)" : value.slice(0, 40);
        filtered.set(key, (filtered.get(key) ?? 0) + 1);
        continue;
      }
    }
    if (record.quoteProblem)
      diagnostics.warning(
        "quote_problem",
        "A quote character in this row was stray or never closed; the row was read as written",
        number,
      );
    if (fields.length <= lastNeeded) {
      // A heading, a total, or a row cut short.
      const rest = fields.filter((value) => value.trim() !== "").length;
      if (rest <= 2) {
        noAmount++;
        diagnostics.info("short_row", "Skipped a row with no transaction in it", number);
      } else {
        invalid++;
        diagnostics.error(
          "short_row",
          `The row has ${fields.length} columns but the mapping needs column ${lastNeeded + 1}`,
          number,
        );
      }
      continue;
    }

    // The amount first: a row with no amount is a heading or a balance marker, not a mistake.
    let cents: bigint | null = null;
    let problem: string | null = null;
    const readCell = (value: string) => parseAmount(value, { decimal });
    if (amount.kind === "signed") {
      const value = cell(columns.amount);
      if (value.trim() !== "") {
        const parsed = readCell(value);
        if (parsed.ok) cents = parsed.cents;
        else problem = `the amount ${quoteCell(value)} ${amountProblem(parsed.error)}`;
      }
    } else if (amount.kind === "debitCredit") {
      const debitText = cell(columns.debit);
      const creditText = cell(columns.credit);
      let debit = 0n;
      let credit = 0n;
      let any = false;
      for (const [value, side] of [
        [debitText, "debit"],
        [creditText, "credit"],
      ] as const) {
        if (value.trim() === "") continue;
        const parsed = readCell(value);
        if (!parsed.ok) {
          problem = `the ${side} ${quoteCell(value)} ${amountProblem(parsed.error)}`;
          break;
        }
        any = true;
        let magnitude = parsed.cents;
        if (magnitude < 0n) {
          diagnostics.warning(
            "debit_credit_sign",
            `The ${side} column holds a negative amount; its sign was ignored and the column decides the direction`,
            number,
          );
          magnitude = -magnitude;
        }
        if (side === "debit") debit = magnitude;
        else credit = magnitude;
      }
      if (problem === null && any) {
        if (debit !== 0n && credit !== 0n) problem = "it has both a debit and a credit amount";
        else cents = credit - debit;
      }
    } else {
      const value = cell(columns.amount);
      if (value.trim() !== "") {
        const parsed = readCell(value);
        if (!parsed.ok) problem = `the amount ${quoteCell(value)} ${amountProblem(parsed.error)}`;
        else {
          const direction = cell(columns.direction).trim().toLowerCase();
          let magnitude = parsed.cents;
          if (magnitude < 0n) {
            diagnostics.warning(
              "direction_sign",
              "The amount is negative and the direction column also says which way; the sign was ignored",
              number,
            );
            magnitude = -magnitude;
          }
          if (outValues.has(direction)) cents = -magnitude;
          else if (inValues.has(direction)) cents = magnitude;
          else
            problem = `the direction ${quoteCell(cell(columns.direction))} is not one of the values you listed`;
        }
      }
    }
    if (problem === null && cents === null) {
      noAmount++;
      const marker = columns.balance !== null && cell(columns.balance).trim() !== "";
      diagnostics.add(
        marker ? "info" : "warning",
        "no_amount",
        marker ? "Skipped a balance line with no amount" : "Skipped a row with no amount",
        number,
      );
      continue;
    }

    const dateText = cell(columns.date);
    let posted: string | null = null;
    if (dateText.trim() !== "") {
      const parts = parseDate(dateText, order);
      if (parts) posted = formatDate(parts);
    }
    if (posted === null && problem === null)
      problem =
        dateText.trim() === ""
          ? "it has no date"
          : `the date ${quoteCell(dateText)} is not a date in ${ORDER_NAME[order]} order`;
    if (problem !== null || cents === null || posted === null) {
      invalid++;
      diagnostics.error("bad_row", `Row skipped: ${problem ?? "it could not be read"}`, number);
      continue;
    }
    if (amount.invert) cents = -cents;
    if (cents === 0n) {
      zero++;
      diagnostics.info("zero_amount", "Skipped a row whose amount is 0.00", number);
      continue;
    }

    // Text fields are stored as received, up to a limit; hostile content is flagged, not changed.
    const pieces: string[] = [];
    for (const column of columns.description) {
      const value = cell(column).trim();
      if (value !== "") pieces.push(value);
    }
    const rawDescription = pieces.join(" ");
    const description = truncateText(rawDescription);
    if (description.cut)
      diagnostics.warning(
        "text_cut",
        "The description is longer than 1000 characters and was cut; the raw file keeps all of it",
        number,
      );
    for (const flag of hostileFlags(rawDescription))
      diagnostics.warning(`hostile_${flag}`, `The description ${FLAG_MESSAGE[flag]}`, number);
    if (rawDescription === "")
      diagnostics.info("no_description", "A row has no description", number);

    const extra: { counterparty?: string; reference?: string } = {};
    for (const field of textFields) {
      if (field.index === null) continue;
      const raw = cell(field.index).trim();
      if (raw === "") continue;
      const cut = truncateText(raw, field.limit);
      if (cut.cut)
        diagnostics.warning(
          "text_cut",
          `The ${field.label} is longer than ${field.limit} characters and was cut`,
          number,
        );
      for (const flag of hostileFlags(raw))
        diagnostics.warning(`hostile_${flag}`, `The ${field.label} ${FLAG_MESSAGE[flag]}`, number);
      if (field.label === "counterparty") extra.counterparty = cut.text;
      else extra.reference = cut.text;
    }
    let runningBalance: string | undefined;
    if (columns.balance !== null) {
      const value = cell(columns.balance);
      if (value.trim() !== "") {
        const parsed = readCell(value);
        if (parsed.ok) runningBalance = formatMoney(parsed.cents);
        else
          diagnostics.warning(
            "bad_balance",
            `The balance ${quoteCell(value)} ${amountProblem(parsed.error)}; the line is kept without it`,
            number,
          );
      }
    }
    const excerpt = text.slice(record.start, Math.min(record.end, record.start + EXCERPT_LIMIT));
    lines.push({
      row: number,
      line: {
        kind: "bankLine",
        provider: "csv",
        accountKey: context.accountKey,
        rawIndex: index - first,
        postedOn: posted,
        amount: formatMoney(cents),
        currency,
        description: description.text,
        ...(extra.counterparty !== undefined ? { counterparty: extra.counterparty } : {}),
        ...(extra.reference !== undefined ? { reference: extra.reference } : {}),
        ...(runningBalance !== undefined ? { runningBalance } : {}),
        ...(excerpt !== "" ? { excerpt } : {}),
      },
    });
  }

  for (const [value, count] of [...filtered].sort((a, b) => b[1] - a[1]).slice(0, 6))
    diagnostics.info(
      "filtered",
      `Skipped ${count} row${count === 1 ? "" : "s"} whose ${mapping.include ? describeRef(mapping.include.column) : "filter"} column is ${quoteCell(value)}; only ${(mapping.include?.values ?? []).map((item) => quoteCell(item, 20)).join(", ")} are imported`,
    );
  return {
    lines,
    stats: {
      rows,
      filtered: Object.fromEntries(filtered),
      noAmount,
      zero,
      invalid,
    },
    effective,
    dateOrder: order,
    headers: headerDisplay,
  };
}

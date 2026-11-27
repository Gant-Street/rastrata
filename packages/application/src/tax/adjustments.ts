/** Adjusting entries from an accountant's CSV: read, checked against the chart and the calendar, and
 * shown as a preview that says exactly what an import would do. An import makes drafts for the owner to
 * review and post; nothing here posts, and nothing here advises on what an entry should be.
 *
 * The file is hostile data. It may be huge, malformed, written for another locale or aimed at a
 * model: it is read with fixed ceilings, every cell is reduced to plain text before it is kept, an
 * account is only ever the chart's own account found by its code, an amount is only ever a decimal with
 * at most two places (never rounded), and a problem in any row is said, with the row, and stops the
 * whole file from being imported: an accountant's entries are a set, and half a set is worse than
 * none.
 *
 * The identity of an entry is the entry id the accountant gave it. Importing the same entry again is
 * recognised and creates nothing; the same id with different figures is refused as a conflict.
 *
 * Pure and portable: a function of the file, a book state and nothing else. */
import type { BookState } from "@rastrata/kernel";

import { sha256Hex, stableStringify } from "../ingest/hash.ts";
import { sanitizeText } from "../ingest/text.ts";
import { formatMoney } from "../money.ts";
import { lockedPeriods } from "../calendar/periods.ts";
import { configurationAt } from "../reports/chart.ts";
import { isDate } from "../reports/dates.ts";
import { sniffDelimiter, tokenizeCsv } from "../statements/csv.ts";

export const ADJUSTMENTS_VERSION = "rastrata-adjusting-entries-v1";

/** The columns of the template, in order. Their names are the contract with an accountant's file. */
export const ADJUSTMENT_COLUMNS = [
  "Entry",
  "Date",
  "Narration",
  "Account",
  "Debit",
  "Credit",
] as const;

export const MAX_CSV_CHARACTERS = 2_000_000;
export const MAX_ROWS = 5_000;
export const MAX_ENTRIES = 1_000;
export const MAX_LINES_PER_ENTRY = 100;
/** The longest cell kept; anything longer is cut and said. */
const MAX_CELL = 1_000;

/** A source event id carries this prefix, so an adjusting entry's identity can never collide with
 * another lane's. */
export const SOURCE_PREFIX = "taxadj-";
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type AdjustmentColumn = "entry" | "date" | "narration" | "account" | "debit" | "credit";

const HEADER_WORDS: Readonly<Record<AdjustmentColumn, readonly string[]>> = {
  entry: [
    "entry",
    "entry id",
    "entry no",
    "entry number",
    "entry #",
    "journal",
    "journal id",
    "journal entry",
    "aje",
    "adjusting entry",
  ],
  date: ["date", "entry date", "accounting date"],
  narration: ["narration", "description", "memo", "explanation"],
  account: ["account", "account code", "account number", "account no", "code"],
  debit: ["debit", "debits", "dr"],
  credit: ["credit", "credits", "cr"],
};

export interface AdjustmentProblem {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly row: number | null;
  readonly entry: string | null;
  readonly column: string | null;
}

export interface AdjustmentLine {
  /** The row of the file this line came from, as a spreadsheet numbers it. */
  readonly row: number;
  /** The account as the file wrote it, reduced to plain text. */
  readonly account: string;
  /** The chart's own account for the code on the entry's date; null when there is none. */
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface AdjustmentEntry {
  readonly id: string;
  readonly firstRow: number;
  readonly date: string | null;
  readonly narration: string;
  readonly lines: readonly AdjustmentLine[];
  readonly problems: readonly AdjustmentProblem[];
  readonly debit: bigint;
  readonly credit: bigint;
  /** The source event id the draft carries, which is what makes an import repeatable. */
  readonly sourceId: string;
  /** What the entry says, independent of the order of its lines, the file it came in and its name. */
  readonly digest: string;
}

export interface ParsedAdjustments {
  readonly rows: number;
  readonly delimiter: string;
  readonly entries: readonly AdjustmentEntry[];
  /** Problems with the file as a whole: nothing in it can be read, or a column is missing. */
  readonly problems: readonly AdjustmentProblem[];
}

/** An account of the chart as it stands on a date. */
export interface ChartEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly openedOn: string;
  readonly closedOn: string | null;
  readonly postingAllowed: boolean;
}

export interface Lookups {
  account(code: string, date: string): ChartEntry | null;
  /** The fiscal period holding a date: open, closed (a closed period takes no new entry until it is
   * reopened) or outside the book's calendar. */
  period(date: string): "open" | "closed" | "outside";
}

/** The chart and calendar of a book, for checking entries without touching the book. */
export function lookupsOf(state: BookState): Lookups {
  const charts = new Map<string, Map<string, ChartEntry>>();
  // A period is locked when the last thing that happened to it was a close, and the kernel refuses a
  // posting into a locked period whether or not its close is still current.
  const locked = lockedPeriods(state);
  return {
    account(code, date) {
      let chart = charts.get(date);
      if (!chart) {
        chart = new Map();
        for (const account of configurationAt(state, date).admissionSnapshot.accounts)
          chart.set(account.code.toUpperCase(), {
            id: account.id as string,
            code: account.code,
            name: account.name,
            openedOn: account.openedOn as string,
            closedOn: (account.closedOn as string | undefined) ?? null,
            postingAllowed: account.postingAllowed,
          });
        charts.set(date, chart);
      }
      return chart.get(code.toUpperCase()) ?? null;
    },
    period(date) {
      const period = state.periods.find(
        (item) => item.kind === "regular" && item.startsOn <= date && date <= item.endsOn,
      );
      if (!period) return "outside";
      return locked.has(period.id) ? "closed" : "open";
    },
  };
}

const headerKey = (value: string): string =>
  sanitizeText(value.normalize("NFKC"), 60).toLowerCase().replace(/\s+/g, " ");

/** A cell's text as it will be kept: plain, one line, cut to a sane length. */
const cell = (value: string | undefined): string => sanitizeText(value ?? "", MAX_CELL);

/** What a person is shown of a cell that is wrong: plain and short. */
const shown = (value: string): string => `"${sanitizeText(value, 40)}"`;

const AMOUNT = /^\$?\s*(0|[1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*|0)(?:\.([0-9]{1,2}))?$/;

/** An amount in cents, or null when the text is not a plain decimal with at most two places. Commas
 * as thousands separators and a leading dollar sign are accepted; a minus sign, brackets, a third
 * decimal place, an exponent or any other character is not: nothing is rounded or guessed. */
export function parseAmount(value: string): bigint | null {
  const match = AMOUNT.exec(value.trim());
  if (!match) return null;
  const whole = (match[1] as string).replaceAll(",", "");
  if (whole.length > 16) return null;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return BigInt(whole) * 100n + BigInt(fraction);
}

const sortedLinesKey = (lines: readonly AdjustmentLine[]): string[] =>
  lines.map((line) => `${line.account.toUpperCase()}|${line.debit}|${line.credit}`).sort();

/** The identity of what an entry says. A different date, narration, account or amount is a different
 * digest; the file's name, the order of the lines and the case of the account codes are not part of
 * it. */
export function entryDigest(date: string, narration: string, lines: readonly AdjustmentLine[]) {
  return sha256Hex(
    stableStringify({ v: "taxadj-1", date, narration, lines: sortedLinesKey(lines) }),
  );
}

export const sourceIdOf = (entryId: string): string => `${SOURCE_PREFIX}${entryId}`;

/** The source event a draft carries. The same entry always makes the same one, whatever file it came
 * in, which is what lets the ledger refuse to post it twice and lets a repeat import see it again. */
export function sourceOf(entry: Pick<AdjustmentEntry, "id" | "narration" | "digest">) {
  return {
    id: sourceIdOf(entry.id),
    description: sanitizeText(
      `Adjusting entry ${entry.id} from an accountant's file: ${entry.narration}`,
      1000,
    ),
    evidenceReference: `tax-adjusting-entry:v1:sha256:${entry.digest}`,
  };
}

const problem = (
  severity: AdjustmentProblem["severity"],
  code: string,
  message: string,
  where: { row?: number | null; entry?: string | null; column?: string | null } = {},
): AdjustmentProblem => ({
  severity,
  code,
  message,
  row: where.row ?? null,
  entry: where.entry ?? null,
  column: where.column ?? null,
});

const COLUMN_WORD: Readonly<Record<AdjustmentColumn, string>> = {
  entry: "Entry",
  date: "Date",
  narration: "Narration",
  account: "Account",
  debit: "Debit",
  credit: "Credit",
};

/** Read an accountant's file. Whatever the text, this returns: it never throws, and a file that cannot
 * be read at all is a problem on the file, not an exception. */
export function parseAdjustments(text: string, lookups: Lookups): ParsedAdjustments {
  const empty = (problems: readonly AdjustmentProblem[], rows = 0): ParsedAdjustments => ({
    rows,
    delimiter: ",",
    entries: [],
    problems,
  });
  if (text.length > MAX_CSV_CHARACTERS)
    return empty([
      problem(
        "error",
        "file_too_large",
        `The file is longer than ${MAX_CSV_CHARACTERS.toLocaleString("en-US")} characters. Split it into several files.`,
      ),
    ]);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") return empty([problem("error", "file_empty", "The file has no rows.")]);
  const delimiter = sniffDelimiter(body);
  const table = tokenizeCsv(body, delimiter);
  const records = table.records.filter((record) => record.fields.length > 0);
  const [header, ...rows] = records;
  const fileProblems: AdjustmentProblem[] = [];
  if (!header || header.fields.every((field) => field.trim() === ""))
    return empty([problem("error", "file_empty", "The file has no header row.")]);

  // Which column is which, by the words in the header row.
  const columns = new Map<AdjustmentColumn, number>();
  const ignored: string[] = [];
  header.fields.forEach((field, index) => {
    const key = headerKey(field);
    const found = (Object.keys(HEADER_WORDS) as AdjustmentColumn[]).find((name) =>
      HEADER_WORDS[name].includes(key),
    );
    if (found && !columns.has(found)) columns.set(found, index);
    else if (key !== "") ignored.push(sanitizeText(field, 40));
  });
  const missing = (Object.keys(HEADER_WORDS) as AdjustmentColumn[]).filter(
    (name) => !columns.has(name),
  );
  if (missing.length > 0)
    return empty(
      [
        problem(
          "error",
          "columns_missing",
          `The header row has no ${missing.map((name) => COLUMN_WORD[name]).join(", ")} column. The columns are ${ADJUSTMENT_COLUMNS.join(", ")}.`,
          { row: header.number },
        ),
      ],
      rows.length,
    );
  if (ignored.length > 0)
    fileProblems.push(
      problem(
        "warning",
        "columns_ignored",
        `Not used, and ignored: ${ignored
          .slice(0, 10)
          .map((name) => shown(name))
          .join(", ")}.`,
        { row: header.number },
      ),
    );
  if (table.truncated || rows.length > MAX_ROWS)
    return empty(
      [
        problem(
          "error",
          "too_many_rows",
          `The file has more than ${MAX_ROWS.toLocaleString("en-US")} rows. Split it into several files.`,
        ),
      ],
      rows.length,
    );
  if (table.fieldsCut > 0)
    fileProblems.push(
      problem(
        "warning",
        "row_too_wide",
        "Some rows have more columns than are read; the rest were dropped.",
      ),
    );

  interface Draft {
    id: string;
    firstRow: number;
    dates: Map<string, number>;
    narrations: Map<string, number>;
    lines: AdjustmentLine[];
    problems: AdjustmentProblem[];
    firstDate: string | null;
    lastDate: string | null;
  }
  const entries = new Map<string, Draft>();
  const order: Draft[] = [];
  let current: Draft | null = null;
  const at = (record: { fields: readonly string[] }, name: AdjustmentColumn): string =>
    cell(record.fields[columns.get(name) as number]);

  for (const record of rows) {
    const idText = at(record, "entry");
    const dateText = at(record, "date");
    const narration = at(record, "narration");
    const account = at(record, "account");
    const debitText = at(record, "debit");
    const creditText = at(record, "credit");
    if (
      [idText, dateText, narration, account, debitText, creditText].every((value) => value === "")
    )
      continue;
    // A row with no entry id continues the entry above it: a spreadsheet often leaves the id, the date
    // and the narration blank on every line but the first.
    let draft: Draft | null;
    if (idText === "") {
      draft = current;
      if (!draft) {
        fileProblems.push(
          problem(
            "error",
            "entry_missing",
            "A row has no entry id and there is no entry above it to continue.",
            {
              row: record.number,
              column: "Entry",
            },
          ),
        );
        continue;
      }
    } else {
      draft = entries.get(idText) ?? null;
      if (!draft) {
        draft = {
          id: idText,
          firstRow: record.number,
          dates: new Map(),
          narrations: new Map(),
          lines: [],
          problems: [],
          firstDate: null,
          lastDate: null,
        };
        entries.set(idText, draft);
        order.push(draft);
        if (!ENTRY_ID.test(idText))
          draft.problems.push(
            problem(
              "error",
              "entry_id_invalid",
              `The entry id ${shown(idText)} may use letters, digits, hyphens and underscores only, up to 64 characters, and must start with a letter or digit.`,
              { row: record.number, entry: idText, column: "Entry" },
            ),
          );
      }
      current = draft;
    }
    if (record.quoteProblem)
      draft.problems.push(
        problem(
          "error",
          "quote_problem",
          "A quote in this row does not close or has stray text after it.",
          {
            row: record.number,
            entry: draft.id,
          },
        ),
      );
    if (dateText !== "") draft.dates.set(dateText, (draft.dates.get(dateText) ?? 0) + 1);
    if (narration !== "")
      draft.narrations.set(narration, (draft.narrations.get(narration) ?? 0) + 1);
    // The date this row is checked against is the entry's date: its own when it has one, else the
    // first the entry gave.
    const date = dateText !== "" ? dateText : (draft.dates.keys().next().value ?? "");
    draft.lastDate = date === "" ? null : date;
    if (draft.firstDate === null && date !== "") draft.firstDate = date;

    let debit = 0n;
    let credit = 0n;
    let amountsOk = true;
    for (const [text, name, set] of [
      [debitText, "Debit", (value: bigint) => (debit = value)],
      [creditText, "Credit", (value: bigint) => (credit = value)],
    ] as const) {
      if (text === "") continue;
      const cents = parseAmount(text);
      if (cents === null) {
        amountsOk = false;
        draft.problems.push(
          problem(
            "error",
            "amount_invalid",
            `${shown(text)} is not an amount. Use digits with at most two decimal places (no minus sign, brackets or currency name); put a credit in the Credit column.`,
            { row: record.number, entry: draft.id, column: name },
          ),
        );
      } else set(cents);
    }
    if (amountsOk) {
      if (debit > 0n && credit > 0n)
        draft.problems.push(
          problem(
            "error",
            "amount_both",
            "A line is a debit or a credit, not both. Use two lines.",
            {
              row: record.number,
              entry: draft.id,
            },
          ),
        );
      else if (debit === 0n && credit === 0n)
        draft.problems.push(
          problem("error", "amount_none", "A line needs a debit or a credit above zero.", {
            row: record.number,
            entry: draft.id,
            column: "Debit",
          }),
        );
    }
    if (account === "")
      draft.problems.push(
        problem("error", "account_missing", "A line needs an account code.", {
          row: record.number,
          entry: draft.id,
          column: "Account",
        }),
      );
    draft.lines.push({
      row: record.number,
      account,
      accountId: null,
      accountName: null,
      debit,
      credit,
    });
  }

  if (order.length > MAX_ENTRIES)
    return empty(
      [
        problem(
          "error",
          "too_many_entries",
          `The file has more than ${MAX_ENTRIES.toLocaleString("en-US")} entries. Split it into several files.`,
        ),
      ],
      rows.length,
    );

  const result: AdjustmentEntry[] = [];
  for (const draft of order) {
    const found = [...draft.problems];
    const where = { entry: draft.id };
    // One date and one narration per entry.
    const dates = [...draft.dates.keys()];
    const narrations = [...draft.narrations.keys()];
    const date = dates[0] ?? null;
    const narrationText = narrations[0] ?? "";
    if (dates.length > 1)
      found.push(
        problem(
          "error",
          "entry_inconsistent_date",
          `Entry ${draft.id} has more than one date (${dates.slice(0, 3).map(shown).join(", ")}). Every line of an entry has the same date.`,
          { ...where, row: draft.firstRow, column: "Date" },
        ),
      );
    if (narrations.length > 1)
      found.push(
        problem(
          "error",
          "entry_inconsistent_narration",
          `Entry ${draft.id} has more than one narration. Every line of an entry has the same one.`,
          { ...where, row: draft.firstRow, column: "Narration" },
        ),
      );
    let validDate: string | null = null;
    // The date accounts are looked up on: none for a date outside the calendar, where a chart has no
    // say and a second complaint about every account would only bury the first.
    let accountDate: string | null = null;
    if (date === null)
      found.push(
        problem("error", "date_missing", `Entry ${draft.id} has no date.`, {
          ...where,
          row: draft.firstRow,
          column: "Date",
        }),
      );
    else if (!isDate(date))
      found.push(
        problem(
          "error",
          "date_invalid",
          `${shown(date)} is not a date. Use YYYY-MM-DD, for example 2026-12-31.`,
          { ...where, row: draft.firstRow, column: "Date" },
        ),
      );
    else {
      validDate = date;
      const period = lookups.period(date);
      if (period !== "outside") accountDate = date;
      if (period === "outside")
        found.push(
          problem(
            "error",
            "date_outside_calendar",
            `${date} is outside the book's fiscal calendar.`,
            { ...where, row: draft.firstRow, column: "Date" },
          ),
        );
      else if (period === "closed")
        found.push(
          problem(
            "warning",
            "date_in_closed_period",
            `${date} is in a closed period. The draft can be made, but it cannot be posted until the period is reopened or the date is changed.`,
            { ...where, row: draft.firstRow, column: "Date" },
          ),
        );
    }
    if (narrationText === "")
      found.push(
        problem(
          "error",
          "narration_missing",
          `Entry ${draft.id} has no narration. Say what the entry is for.`,
          { ...where, row: draft.firstRow, column: "Narration" },
        ),
      );

    // Accounts: only ever the chart's own account, found by its code on the entry's date.
    const lines = draft.lines.map((line): AdjustmentLine => {
      if (line.account === "" || accountDate === null) return line;
      const account = lookups.account(line.account, accountDate);
      if (!account) {
        found.push(
          problem(
            "error",
            "account_unknown",
            `${shown(line.account)} is not an account code in the chart on ${accountDate}. Use a code from chart-of-accounts.csv.`,
            { ...where, row: line.row, column: "Account" },
          ),
        );
        return line;
      }
      if (account.closedOn !== null && account.closedOn <= accountDate)
        found.push(
          problem(
            "error",
            "account_closed",
            `Account ${account.code} was closed on ${account.closedOn}.`,
            { ...where, row: line.row, column: "Account" },
          ),
        );
      else if (account.openedOn > accountDate)
        found.push(
          problem(
            "error",
            "account_not_open",
            `Account ${account.code} opens on ${account.openedOn}, after this entry's date.`,
            { ...where, row: line.row, column: "Account" },
          ),
        );
      else if (!account.postingAllowed)
        found.push(
          problem(
            "error",
            "account_no_posting",
            `Account ${account.code} groups other accounts and takes no entries of its own.`,
            { ...where, row: line.row, column: "Account" },
          ),
        );
      return { ...line, accountId: account.id, accountName: account.name };
    });

    const debit = lines.reduce((sum, line) => sum + line.debit, 0n);
    const credit = lines.reduce((sum, line) => sum + line.credit, 0n);
    if (lines.length < 2)
      found.push(
        problem(
          "error",
          "entry_too_short",
          `Entry ${draft.id} has one line. An entry needs at least two.`,
          { ...where, row: draft.firstRow },
        ),
      );
    if (lines.length > MAX_LINES_PER_ENTRY)
      found.push(
        problem(
          "error",
          "entry_too_long",
          `Entry ${draft.id} has more than ${MAX_LINES_PER_ENTRY} lines.`,
          { ...where, row: draft.firstRow },
        ),
      );
    if (debit !== credit)
      found.push(
        problem(
          "error",
          "entry_unbalanced",
          `Entry ${draft.id} does not balance: debits ${formatMoney(debit)}, credits ${formatMoney(credit)}.`,
          { ...where, row: draft.firstRow },
        ),
      );
    result.push({
      id: draft.id,
      firstRow: draft.firstRow,
      date: validDate,
      narration: narrationText,
      lines,
      problems: found,
      debit,
      credit,
      sourceId: sourceIdOf(draft.id),
      digest: entryDigest(validDate ?? date ?? "", narrationText, lines),
    });
  }
  return { rows: rows.length, delimiter, entries: result, problems: fileProblems };
}

/** The draft an entry becomes. Amounts are exact two-place decimals and the entry's id is its
 * reference. */
export function draftOf(entry: AdjustmentEntry) {
  return {
    date: entry.date as string,
    reference: entry.id,
    narration: sanitizeText(entry.narration, 1000),
    source: sourceOf(entry),
    lines: entry.lines.map((line) => ({
      accountId: line.accountId as string,
      debit: line.debit > 0n ? formatMoney(line.debit) : "",
      credit: line.credit > 0n ? formatMoney(line.credit) : "",
    })),
  };
}

export const hasErrors = (problems: readonly AdjustmentProblem[]): boolean =>
  problems.some((item) => item.severity === "error");

/** The header row of the template an accountant fills in. */
export const ADJUSTMENTS_TEMPLATE = `${ADJUSTMENT_COLUMNS.join(",")}\r\n`;

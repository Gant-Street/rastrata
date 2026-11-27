import { parseAmount } from "../statements/amounts.ts";
import { type CsvRecord, type CsvTable, sniffDelimiter, tokenizeCsv } from "../statements/csv.ts";
import { isZip, sheetTable } from "../statements/xlsx.ts";
import {
  analyzeDateOrder,
  formatDate,
  parseDate,
  type DateOrder,
  type DateOrderChoice,
} from "../statements/dates.ts";
import { decodeText } from "../statements/text.ts";

/** Reading a journal file: the entries of a business's past books, as one row per line of an entry.
 *
 * Any old system can make the shape: the columns are found by what they are called (a Xero journal
 * report, a QuickBooks journal, a general-ledger export, a file an agent made from any of them), a
 * date, an account (a code, a name or both), a debit and a credit (or one signed amount), and
 * optionally an entry number, a reference and a description. A row with no date or number belongs to
 * the entry above it, as QuickBooks writes its splits. Reading changes nothing and never throws: every
 * problem is a line with its row number, and an entry with a problem is left out, never guessed at. */

/** The entry is made of these lines; amounts are cents, never both sides on one line. */
export interface HistoryLine {
  /** The row of the file this line was read from, counting every row as a spreadsheet would. */
  readonly row: number;
  /** The account as the file calls it: its code, its name, or both. */
  readonly code: string;
  readonly name: string;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly memo: string;
}

export interface HistoryEntry {
  /** One-based position among the entries read, in the order of the file. */
  readonly index: number;
  /** What names the entry in the file: its number when the file has one, else its position. */
  readonly key: string;
  readonly date: string;
  readonly reference: string;
  readonly narration: string;
  readonly lines: readonly HistoryLine[];
}

export interface HistoryProblem {
  readonly row: number;
  readonly code: string;
  readonly message: string;
}

export interface ParsedHistory {
  readonly entries: readonly HistoryEntry[];
  /** Every problem found, the first `MAX_PROBLEMS` kept in full. */
  readonly problems: readonly HistoryProblem[];
  readonly problemCount: number;
  /** The rows read as lines of an entry (including those of entries that were left out). */
  readonly linesRead: number;
  readonly dateOrder: DateOrder | null;
  /** Every date read both month-first and day-first, so the first was assumed. */
  readonly dateOrderAssumed: boolean;
  /** The file was not read: no header row with a date, an account and amounts was found. */
  readonly unreadable: boolean;
}

export const MAX_PROBLEMS = 100;
/** A hostile or mistaken file cannot make one entry of unbounded size. */
const MAX_LINES_PER_ENTRY = 500;

type Field =
  | "date"
  | "journal"
  | "reference"
  | "description"
  | "name"
  | "code"
  | "account"
  | "debit"
  | "credit"
  | "amount";

/** What a column may be called, as the header reads with everything but letters and digits removed. */
const ALIASES: Readonly<Record<Field, readonly string[]>> = {
  date: [
    "date",
    "journaldate",
    "transactiondate",
    "txndate",
    "transdate",
    "postingdate",
    "entrydate",
  ],
  journal: [
    "journal",
    "journalno",
    "journalnumber",
    "journalid",
    "transno",
    "trans",
    "transactionno",
    "transactionnumber",
    "transactionid",
    "txnid",
    "entryno",
    "entrynumber",
    "entryid",
  ],
  reference: ["reference", "ref", "num", "docnumber", "documentnumber", "checkno", "refno"],
  description: ["description", "memo", "narration", "details", "particulars", "memodescription"],
  name: ["name", "payee", "contact", "customer", "vendor"],
  code: ["accountcode", "code", "acctcode", "accountnumber", "acctnumber", "accountno", "glcode"],
  account: ["account", "accountname", "acct", "ledgeraccount", "glaccount"],
  debit: ["debit", "debits", "dr", "debitamount"],
  credit: ["credit", "credits", "cr", "creditamount"],
  amount: ["amount", "netamount", "signedamount"],
};

const normalize = (cell: string): string => cell.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Columns {
  readonly index: Partial<Record<Field, number>>;
}

/** The columns of a header row, or null when it is not one: it needs a date, an account (a code or a
 * name) and amounts (a debit and a credit, or one amount). */
function columnsOf(fields: readonly string[]): Columns | null {
  const index: Partial<Record<Field, number>> = {};
  fields.forEach((cell, position) => {
    // "*Code" is Xero's required-column mark; "Debit (USD)" is a currency on the amount, as Xero's reports write it.
    const key = normalize(cell.replace(/^\*/, "").replace(/\s*\([^)]*\)\s*$/, ""));
    if (key === "") return;
    for (const field of Object.keys(ALIASES) as Field[])
      if (index[field] === undefined && ALIASES[field].includes(key)) {
        index[field] = position;
        return;
      }
  });
  const hasAccount = index.code !== undefined || index.account !== undefined;
  const hasAmounts =
    (index.debit !== undefined && index.credit !== undefined) || index.amount !== undefined;
  return index.date !== undefined && hasAccount && hasAmounts ? { index } : null;
}

const cell = (record: CsvRecord, position: number | undefined): string =>
  position === undefined ? "" : (record.fields[position] ?? "").trim();

/** Read the bytes of a journal file. `order` says how dates are written, or "auto" to let the dates say. */
export function parseHistory(bytes: Uint8Array, order: DateOrderChoice = "auto"): ParsedHistory {
  const problems: HistoryProblem[] = [];
  // A workbook (what Xero's reports export) is read as the table of its first sheet; anything else is text.
  let table: CsvTable;
  if (isZip(bytes)) {
    try {
      table = sheetTable(bytes);
    } catch {
      return unreadable(
        "The file is a zip, but not a workbook that can be read. Export the entries as an Excel file (.xlsx) or a CSV.",
      );
    }
  } else {
    const text = decodeText(bytes).text;
    table = tokenizeCsv(text, sniffDelimiter(text));
  }
  let problemCount = 0;
  const problem = (row: number, code: string, message: string) => {
    problemCount += 1;
    if (problems.length < MAX_PROBLEMS) problems.push({ row, code, message });
  };
  if (table.truncated)
    problem(
      0,
      "file_too_long",
      "The file has more rows than can be read at once. Send it in parts, in order of date.",
    );

  // The header is the first row, within the first thirty, that names a date, an account and amounts.
  let columns: Columns | null = null;
  let headerAt = -1;
  for (let position = 0; position < Math.min(table.records.length, 30); position += 1) {
    const record = table.records[position];
    if (!record || record.fields.length < 3) continue;
    columns = columnsOf(record.fields);
    if (columns) {
      headerAt = position;
      break;
    }
  }
  if (!columns)
    return unreadable(
      "No row names a date, an account and amounts. The file needs columns such as Date, Account (or Account Code), Debit and Credit.",
    );
  const at = columns.index;
  const body = table.records.slice(headerAt + 1);

  // How dates are written is a fact about the whole column.
  let dateOrder: DateOrder | null = null;
  let dateOrderAssumed = false;
  if (order !== "auto") dateOrder = order;
  else {
    const values = body.map((record) => cell(record, at.date)).filter((value) => value !== "");
    const analysis = analyzeDateOrder(values);
    dateOrder = analysis.order;
    if (dateOrder === null && analysis.ambiguous) {
      dateOrder = "mdy";
      dateOrderAssumed = true;
    }
    if (analysis.conflicting)
      problem(
        0,
        "date_order",
        "Some dates read month first and others day first. Say how the dates are written.",
      );
  }

  const entries: HistoryEntry[] = [];
  const seenKeys = new Set<string>();
  let linesRead = 0;
  let groupNumber = 0;
  let lastDate = "";
  let lastKey = "";
  let lastReference = "";

  interface Group {
    readonly key: string;
    readonly date: string;
    reference: string;
    narration: string;
    readonly lines: HistoryLine[];
    readonly firstRow: number;
    balance: bigint;
    bad: boolean;
  }
  const state: { open: Group | null } = { open: null };

  const finish = () => {
    const group = state.open;
    state.open = null;
    if (!group || group.bad) return;
    if (group.lines.length < 2) {
      problem(
        group.firstRow,
        "single_line",
        `Entry ${group.key} has one line. An entry needs at least two.`,
      );
      return;
    }
    if (group.balance !== 0n) {
      const difference = group.balance < 0n ? -group.balance : group.balance;
      problem(
        group.firstRow,
        "unbalanced",
        `Entry ${group.key} dated ${group.date} does not balance: debits and credits differ by ${formatCents(difference)}.`,
      );
      return;
    }
    entries.push({
      index: entries.length + 1,
      key: group.key,
      date: group.date,
      reference: group.reference,
      narration: group.narration,
      lines: group.lines,
    });
  };

  // An export laid out by account (a general ledger) lists the lines of one entry in different places. When an
  // entry's number comes back after another's, the lines are brought together by number, in the order each
  // number first appears; the lines keep their row numbers, so a problem still names its row.
  const ordered =
    at.journal === undefined
      ? body
      : bringTogether(body, (record) => cell(record, at.journal as number));
  // Xero's Journal Report writes each journal under a row of its own, "ID 106 Stripe Refunds": the number and
  // the narration, nothing else on the row. The narration goes to the entry when its lines carry none.
  let headed: { key: string; words: string; row: number } | null = null;
  for (const record of ordered) {
    if (record.fields.length === 0 || record.fields.every((field) => field.trim() === "")) continue;
    const alone = record.fields.filter((field) => field.trim() !== "");
    if (alone.length === 1) {
      const heading = /^ID\s+(\S+)\s*(.*)$/i.exec((alone[0] as string).trim());
      if (heading) {
        headed = {
          key: heading[1] as string,
          words: (heading[2] ?? "").trim().slice(0, 200),
          row: record.number,
        };
        continue;
      }
    }
    let code = cell(record, at.code);
    let name = cell(record, at.account);
    const debitText = cell(record, at.debit);
    const creditText = cell(record, at.credit);
    const amountText = cell(record, at.amount);
    const hasAmount = debitText !== "" || creditText !== "" || amountText !== "";
    // A title, a subtotal or a total has no account, or no amount, or says it is a total.
    if ((code === "" && name === "") || !hasAmount || /^totals?\b/i.test(name || code)) continue;
    // "1000 - Checking" or "Checking (1000)" in one column is a code and a name.
    if (at.code === undefined || code === "") {
      const joined = /^([A-Za-z0-9][A-Za-z0-9._]{0,11})\s*[-–:]\s*(.+)$/.exec(name);
      const bracketed = /^(.*\S)\s*\(([A-Z0-9][A-Z0-9._-]{0,19})\)$/.exec(name);
      if (joined && at.code === undefined) {
        code = joined[1] as string;
        name = (joined[2] as string).trim();
      } else if (bracketed && at.code === undefined) {
        name = bracketed[1] as string;
        code = bracketed[2] as string;
      }
    }

    // The amounts of the line.
    let debit = 0n;
    let credit = 0n;
    let lineBad = false;
    const read = (text: string, label: string): bigint => {
      // A report writes a dash where there is no amount.
      if (text === "" || text === "-" || text === "\u2013") return 0n;
      const result = parseAmount(text);
      if (!result.ok) {
        problem(record.number, "amount", `"${text.slice(0, 30)}" in ${label} is not an amount.`);
        lineBad = true;
        return 0n;
      }
      return result.cents;
    };
    if (at.debit !== undefined && at.credit !== undefined) {
      const d = read(debitText, "Debit");
      const c = read(creditText, "Credit");
      // A negative debit is a credit, as some exports write a reversal.
      debit = (d > 0n ? d : 0n) + (c < 0n ? -c : 0n);
      credit = (c > 0n ? c : 0n) + (d < 0n ? -d : 0n);
      if (d > 0n && c > 0n) {
        problem(
          record.number,
          "both_sides",
          "A line has both a debit and a credit. Split it into two lines.",
        );
        lineBad = true;
      }
    } else {
      const signed = read(amountText, "Amount");
      if (signed >= 0n) debit = signed;
      else credit = -signed;
    }
    if (!lineBad && debit === 0n && credit === 0n) continue;
    linesRead += 1;

    // Which entry this line belongs to.
    const journalCell = cell(record, at.journal);
    const dateCell = cell(record, at.date);
    const reference = cell(record, at.reference);
    const memo = cell(record, at.description);
    const counterparty = cell(record, at.name);
    const words = [memo, counterparty].filter(Boolean).join(" ").slice(0, 200);
    const current = state.open;
    let startsNew: boolean;
    if (at.journal !== undefined)
      startsNew = current === null || (journalCell !== "" && journalCell !== lastKey);
    else {
      const balanced = current !== null && current.lines.length >= 2 && current.balance === 0n;
      // Lines of one entry share a date: a different date written out starts the next entry, whether or
      // not this one balanced (an entry that does not is then reported as it is, not carried into the next).
      const otherDate =
        current !== null &&
        dateCell !== "" &&
        dateOrder !== null &&
        formatOrNull(dateCell, dateOrder) !== current.date;
      startsNew =
        current === null ||
        otherDate ||
        (balanced && (dateCell !== "" || (reference !== "" && reference !== lastReference)));
    }
    if (startsNew) {
      finish();
      groupNumber += 1;
      const key =
        at.journal !== undefined && journalCell !== "" ? journalCell : String(groupNumber);
      let date = lastDate;
      let bad = false;
      if (dateCell !== "") {
        const parts = dateOrder ? parseDate(dateCell, dateOrder) : null;
        if (parts) date = formatDate(parts);
        else {
          problem(
            record.number,
            "date",
            `"${dateCell.slice(0, 30)}" is not a date${dateOrder ? "" : ": say how the dates are written"}.`,
          );
          date = "";
          bad = true;
        }
      } else if (date === "") {
        problem(
          record.number,
          "date",
          "The line has no date and no entry above it to take one from.",
        );
        bad = true;
      }
      if (seenKeys.has(key)) {
        problem(
          record.number,
          "duplicate_key",
          `Entry ${key} appears again, apart from its first lines. Keep the lines of an entry together.`,
        );
        bad = true;
      }
      seenKeys.add(key);
      const heading =
        headed !== null && (headed.key === key || headed.row === record.number - 1)
          ? headed.words
          : "";
      state.open = {
        key,
        date,
        reference,
        narration: words !== "" ? words : heading,
        lines: [],
        firstRow: record.number,
        balance: 0n,
        bad,
      };
      lastDate = date;
      lastKey = key;
      lastReference = reference;
    } else if (current) {
      if (dateCell !== "" && current.date !== "") {
        const parts = dateOrder ? parseDate(dateCell, dateOrder) : null;
        if (parts && formatDate(parts) !== current.date) {
          problem(
            record.number,
            "date_changes",
            `Entry ${current.key} changes its date at this line: the lines of one entry share a date.`,
          );
          current.bad = true;
        }
      }
      if (current.narration === "") current.narration = words;
      if (current.reference === "" && reference !== "") current.reference = reference;
    }
    const group = state.open as Group | null;
    if (!group) continue;
    if (lineBad) group.bad = true;
    if (group.lines.length >= MAX_LINES_PER_ENTRY) {
      if (!group.bad)
        problem(
          record.number,
          "too_many_lines",
          `Entry ${group.key} has more than ${MAX_LINES_PER_ENTRY} lines.`,
        );
      group.bad = true;
    } else {
      group.lines.push({ row: record.number, code, name, debit, credit, memo });
      group.balance += debit - credit;
    }
  }
  finish();
  return {
    entries,
    problems,
    problemCount,
    linesRead,
    dateOrder,
    dateOrderAssumed,
    unreadable: false,
  };
}

/** The records with the lines of each entry together, when the file is laid out so that the lines of an entry are
 * in different places (most numbers come back after another's); the records as they are otherwise, so that one
 * number reused by mistake is still named. A blank number belongs to the entry above it. */
function bringTogether<T>(records: readonly T[], keyOf: (record: T) => string): readonly T[] {
  const first = new Map<string, number>();
  const again = new Set<string>();
  let last = "";
  const keys = records.map((record) => {
    const own = keyOf(record);
    const key = own !== "" ? own : last;
    if (key !== "") {
      if (key !== last && first.has(key)) again.add(key);
      if (!first.has(key)) first.set(key, first.size);
      last = key;
    }
    return key;
  });
  if (again.size < 2 || again.size * 2 < first.size) return records;
  return records
    .map((record, index) => ({
      record,
      index,
      group: keys[index] === "" ? -1 : (first.get(keys[index] as string) as number),
    }))
    .sort((a, b) => a.group - b.group || a.index - b.index)
    .map((item) => item.record);
}

/** What a file that cannot be read at all comes back as: one problem, and nothing guessed. */
function unreadable(message: string): ParsedHistory {
  return {
    entries: [],
    problems: [{ row: 1, code: "no_header", message }],
    problemCount: 1,
    linesRead: 0,
    dateOrder: null,
    dateOrderAssumed: false,
    unreadable: true,
  };
}

/** A date cell read in an order, as `YYYY-MM-DD`, or null when it is not one. */
function formatOrNull(text: string, order: DateOrder): string | null {
  const parts = parseDate(text, order);
  return parts ? formatDate(parts) : null;
}

/** Cents as `1234.50`. */
function formatCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

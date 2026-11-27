import { formatMoney, parseMoney } from "../money.ts";
import { parseXeroTrialBalance } from "../shadow/xero/trial-balance.ts";
import { parseAmount } from "../statements/amounts.ts";
import { summarizeLines } from "../statements/balance.ts";
import { type CsvTable, sniffDelimiter, tokenizeCsv } from "../statements/csv.ts";
import { describeColumns, findHeaderRow, matchPreset } from "../statements/csv-detect.ts";
import { normalizeHeader } from "../statements/csv-mapping.ts";
import {
  analyzeDateOrder,
  type DateOrder,
  formatDate,
  isDateLike,
  parseDate,
} from "../statements/dates.ts";
import { hostileFlags } from "../statements/hostile.ts";
import { parseStatement, type SavedMapping, type StatementParse } from "../statements/parse.ts";
import { binaryKind, decodeText, type TextEncoding } from "../statements/text.ts";
import { type Concept, conceptsOf, guessRole, signalsOf } from "./roles.ts";
import {
  type Confidence,
  type FileFlag,
  type FileKind,
  neutral,
  type Need,
  type Role,
  type RoleReason,
  type UnparsedReason,
} from "./sets.ts";

/** Typing a file by its bytes and describing it, without importing anything.
 *
 * `inspectFile` is a pure function of the bytes (and the date "today", which only decides whether a
 * date is in the future). It never throws, never writes, never opens an archive or a PDF, and
 * returns only facts that are counts, codes, dates, amounts, or text from the file in the few
 * fields named for it (a file name and the column headers), bounded and with control and direction
 * characters written out. Nothing in a file is read as an instruction. */

export interface ColumnFact {
  readonly index: number;
  readonly header: string;
  /** Cautions about the header text: instruction, formula, markup, control. */
  readonly flags: readonly string[];
}

export interface RangeFact {
  readonly from: string;
  readonly to: string;
}

export interface BalanceFact {
  readonly asOf: string;
  readonly amount: string;
}

export interface StatementFacts {
  /** How the parser would read the file with no help. */
  readonly reading: "preset" | "detected" | "profile" | "ofx" | "none";
  /** The name of the saved recipe that reads it. */
  readonly recipe?: string;
  readonly presetId?: string;
  readonly presetVerified?: boolean;
  readonly lines: number;
  readonly moneyIn: string;
  readonly moneyOut: string;
  readonly net: string;
  readonly currency: string;
  readonly balance: "running" | "reported" | "none";
  /** The balance before the oldest line, worked out from a running balance. */
  readonly opening?: string;
  /** The balance after the newest line: from the running balance, or the one the file reports. */
  readonly closing?: BalanceFact;
  readonly chain?: {
    readonly order: "oldest-first" | "newest-first";
    readonly flipped: boolean;
    readonly compared: number;
    readonly breakCount: number;
  };
}

export interface OfxAccountFact {
  readonly key: string;
  readonly label: string;
  readonly type: "bank" | "card";
  readonly currency: string;
  readonly lines: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly closing?: BalanceFact;
}

export interface TrialBalanceFacts {
  readonly asOf: string | null;
  readonly layout: string | null;
  readonly rows: number;
  readonly balanced: boolean;
  readonly debit: string;
  readonly credit: string;
  readonly problems: number;
}

export interface SummaryFacts {
  readonly accounts?: number;
  readonly distinct?: number;
  readonly debit?: string;
  readonly credit?: string;
  readonly gross?: string;
  readonly fee?: string;
  readonly net?: string;
  readonly total?: string;
  readonly types?: readonly string[];
}

export interface DetailFacts {
  readonly pdf?: {
    readonly pages: number;
    readonly textLayer: "present" | "absent" | "unknown";
    readonly encrypted: boolean;
  };
  readonly zip?: {
    readonly entries: number;
    readonly names: readonly string[];
    readonly unsafeNames: number;
    readonly workbook: boolean;
  };
  readonly json?: {
    readonly shape: "object" | "array";
    readonly records: number;
    readonly keys: readonly string[];
  };
}

export interface FileFacts {
  readonly kind: FileKind;
  readonly parsed: boolean;
  readonly need: Need;
  readonly why?: UnparsedReason;
  readonly role: Role;
  readonly confidence: Confidence;
  readonly reasons: readonly RoleReason[];
  readonly encoding?: TextEncoding;
  readonly delimiter?: string;
  readonly lineEnding?: "lf" | "crlf" | "cr" | "mixed" | "none";
  readonly headerRow?: number;
  readonly columns?: readonly ColumnFact[];
  readonly rows?: number;
  readonly range?: RangeFact;
  readonly dateOrder?: "mdy" | "dmy" | "ymd" | "ambiguous" | "mixed" | "none";
  readonly currency?: string;
  readonly statement?: StatementFacts;
  readonly accounts?: readonly OfxAccountFact[];
  readonly trialBalance?: TrialBalanceFacts;
  readonly summary?: SummaryFacts;
  readonly details?: DetailFacts;
  readonly flags: readonly FileFlag[];
  readonly problems: {
    readonly errors: number;
    readonly warnings: number;
    readonly messages: readonly string[];
  };
}

export interface InspectOptions {
  /** The file's name as a label, already cleaned of path and control characters. */
  readonly name?: string;
  /** Today, `YYYY-MM-DD`: a date after it is in the future. */
  readonly today: string;
  /** The saved recipes of the account the file is for: a file one of them reads is read by it. */
  readonly profiles?: readonly SavedMapping[];
}

const MAX_COLUMNS = 40;
const MAX_MESSAGES = 5;
const NON_FINAL = new Set([
  "pending",
  "authorized",
  "authorised",
  "processing",
  "in progress",
  "in process",
  "scheduled",
  "hold",
  "held",
  "on hold",
  "awaiting",
  "queued",
  "declined",
  "failed",
  "cancelled",
  "canceled",
  "voided",
  "void",
]);

const nothing = (): FileFacts["problems"] => ({ errors: 0, warnings: 0, messages: [] });

function unparsed(
  kind: FileKind,
  why: UnparsedReason,
  flags: FileFlag[] = [],
  details?: DetailFacts,
): FileFacts {
  return {
    kind,
    parsed: false,
    need: why === "empty_file" || why === "too_large" ? "human" : "agent",
    why,
    role: "other",
    confidence: "low",
    reasons: ["binary_content"],
    flags,
    problems: nothing(),
    ...(details ? { details } : {}),
  };
}

// ---- Binary kinds --------------------------------------------------------------------------

const starts = (bytes: Uint8Array, ...signature: number[]): boolean =>
  signature.every((byte, index) => bytes[index] === byte);

function latin1(bytes: Uint8Array, limit: number): string {
  const slice = bytes.subarray(0, Math.min(bytes.length, limit));
  let out = "";
  const chunk = 8192;
  for (let at = 0; at < slice.length; at += chunk)
    out += String.fromCharCode(...slice.subarray(at, at + chunk));
  return out;
}

/** What a PDF holds, from its own markers and without opening any stream. A PDF whose text objects
 * sit inside compressed streams still says "unknown": the point is whether an agent can read it. */
function inspectPdf(bytes: Uint8Array): FileFacts {
  const text = latin1(bytes, 16 * 1024 * 1024);
  const count = (pattern: RegExp): number => {
    let total = 0;
    for (const _ of text.matchAll(pattern)) {
      total++;
      if (total >= 100000) break;
    }
    return total;
  };
  const pages = count(/\/Type\s*\/Page(?![A-Za-z])/g);
  const fonts = count(/\/Type\s*\/Font(?![A-Za-z])/g);
  const images = count(/\/Subtype\s*\/Image(?![A-Za-z])/g);
  const encrypted = /\/Encrypt\b/.test(text);
  const packed = /\/Type\s*\/ObjStm/.test(text);
  const textLayer: "present" | "absent" | "unknown" = encrypted
    ? "unknown"
    : fonts > 0
      ? "present"
      : images > 0 && !packed
        ? "absent"
        : "unknown";
  return unparsed("pdf", "pdf_needs_agent", encrypted ? ["encrypted"] : [], {
    pdf: { pages: Math.min(pages, 100000), textLayer, encrypted },
  });
}

/** The names in a ZIP's central directory, read without decompressing anything. A name that climbs
 * out of its folder, or is absolute, is counted: nothing here is ever extracted. */
function inspectZip(bytes: Uint8Array): FileFacts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  const floor = Math.max(0, bytes.length - 65557);
  for (let at = bytes.length - 22; at >= floor; at--)
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  const names: string[] = [];
  let entries = 0;
  let unsafeNames = 0;
  let workbook = false;
  if (end >= 0) {
    const total = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    for (let index = 0; index < total && index < 10000; index++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) break;
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      if (at + 46 + nameLength > bytes.length) break;
      const name = new TextDecoder("utf-8").decode(bytes.subarray(at + 46, at + 46 + nameLength));
      entries++;
      if (name === "xl/workbook.xml") workbook = true;
      if (/(^|[\\/])\.\.([\\/]|$)/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name))
        unsafeNames++;
      if (names.length < 20) names.push(neutral(name, 80));
      at += 46 + nameLength + extraLength + commentLength;
    }
  }
  const flags: FileFlag[] = unsafeNames > 0 ? ["unsafe_names"] : [];
  return unparsed(
    workbook ? "xlsx" : "zip",
    workbook ? "workbook_needs_agent" : "archive_not_opened",
    flags,
    {
      zip: { entries, names, unsafeNames, workbook },
    },
  );
}

// ---- Text ----------------------------------------------------------------------------------

function lineEndingOf(text: string): "lf" | "crlf" | "cr" | "mixed" | "none" {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  const limit = Math.min(text.length, 1_000_000);
  for (let at = 0; at < limit; at++) {
    const code = text.charCodeAt(at);
    if (code === 0x0d) {
      if (text.charCodeAt(at + 1) === 0x0a) {
        crlf++;
        at++;
      } else cr++;
    } else if (code === 0x0a) lf++;
  }
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  return crlf > 0 ? "crlf" : lf > 0 ? "lf" : "cr";
}

function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 8192);
  return /<OFX[\s>]/i.test(head) || /^\s*OFXHEADER\s*:/i.test(head) || /<\?OFX/i.test(head);
}

const isNumericCell = (cell: string): boolean => cell !== "" && parseAmount(cell).ok;

/** The one-based number of the header record: the first row of words that names columns. The
 * statement parser's own detector goes first; this one also finds the header of a report. */
function headerOf(table: CsvTable): number {
  const first = findHeaderRow(table);
  if (first > 0) {
    const row = table.records[first - 1];
    if (row && signalsOf(row.fields).recognised >= 2) return first;
  }
  const limit = Math.min(table.records.length, 60);
  for (let index = 0; index < limit; index++) {
    const record = table.records[index];
    if (!record) continue;
    const filled = record.fields.map((field) => field.trim()).filter((field) => field !== "");
    if (filled.length < 2) continue;
    if (filled.some((cell) => isNumericCell(cell) || isDateLike(cell) || cell.length > 60))
      continue;
    if (signalsOf(record.fields).recognised >= 2) return record.number;
  }
  return first;
}

function columnsOf(table: CsvTable, headerRow: number): ColumnFact[] {
  const described = describeColumns(table, headerRow, { samples: 1 });
  return described.slice(0, MAX_COLUMNS).map((column) => {
    const raw = headerRow > 0 ? (table.records[headerRow - 1]?.fields[column.index - 1] ?? "") : "";
    const flags = hostileFlags(raw).map(String);
    return { index: column.index, header: neutral(raw.trim(), 80), flags };
  });
}

interface DateScan {
  readonly order: "mdy" | "dmy" | "ymd" | "ambiguous" | "mixed" | "none";
  readonly range: RangeFact | null;
  readonly dates: string[];
  readonly future: boolean;
}

/** The dates of one column: which order they are written in (or that they cannot say), the range,
 * and whether any is after today. */
function scanDates(values: readonly string[], today: string): DateScan {
  const filled = values.map((value) => value.trim()).filter((value) => value !== "");
  const analysis = analyzeDateOrder(filled);
  if (analysis.readable === 0) return { order: "none", range: null, dates: [], future: false };
  if (analysis.ambiguous) return { order: "ambiguous", range: null, dates: [], future: false };
  if (analysis.order === null) return { order: "mixed", range: null, dates: [], future: false };
  const order: DateOrder = analysis.order;
  const dates: string[] = [];
  for (const value of filled) {
    const parts = parseDate(value, order);
    if (parts) dates.push(formatDate(parts));
  }
  if (dates.length === 0) return { order, range: null, dates, future: false };
  let from = dates[0] as string;
  let to = from;
  for (const date of dates) {
    if (date < from) from = date;
    if (date > to) to = date;
  }
  return { order, range: { from, to }, dates, future: to > today };
}

function dataRecords(table: CsvTable, headerRow: number) {
  return table.records
    .slice(headerRow)
    .filter((record) => record.fields.some((field) => field.trim() !== ""));
}

/** Add up an amount column in cents. Cells that are not amounts are counted apart. */
function sumColumn(
  records: readonly { readonly fields: readonly string[] }[],
  column: number,
  decimal: "." | ",",
): { cents: bigint; bad: number; used: number } {
  let cents = 0n;
  let bad = 0;
  let used = 0;
  for (const record of records) {
    const cell = (record.fields[column] ?? "").trim();
    if (cell === "") continue;
    const result = parseAmount(cell, { decimal });
    if (result.ok) {
      cents += result.cents;
      used++;
    } else bad++;
  }
  return { cents, bad, used };
}

function columnWith(headers: readonly string[], concept: Concept): number {
  return headers.findIndex((header) => conceptsOf(header).includes(concept));
}

function hostileFileFlags(texts: Iterable<string>, into: Set<FileFlag>): void {
  let scanned = 0;
  for (const text of texts) {
    if (++scanned > 20000) break;
    // A negative amount starts with a minus sign and a date has no words: neither is a formula.
    const trimmed = text.trim();
    if (trimmed === "" || isNumericCell(trimmed) || isDateLike(trimmed)) continue;
    for (const flag of hostileFlags(text)) {
      if (flag === "instruction") into.add("instruction_text");
      else if (flag === "formula") into.add("formula_cells");
      else if (flag === "markup" || flag === "link") into.add("markup_text");
      else if (flag === "control" || flag === "direction") into.add("control_characters");
    }
  }
}

/** The date a report says it is as at, when it writes the date year first ("As of 2026-07-31"),
 * which the Xero reader, written for day-first and month-first dates, does not read. */
export function isoTitleDate(titles: readonly string[]): string | null {
  for (const line of titles) {
    if (!/\bas\s+(at|of)\b|\bthrough\b|\bending\b/.test(line)) continue;
    const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(line);
    if (!match) continue;
    const parts = parseDate(match[0], "ymd");
    if (parts) return formatDate(parts);
  }
  return null;
}

/** How strongly a statement reads as a card's. A card statement rarely says so; it has a merchant
 * and a category, a transaction date and a posting date, charges signed the other way, and a
 * payment line that thanks the payer. Three or more points is a card. */
function cardEvidence(
  headers: readonly string[],
  titles: readonly string[],
  records: readonly { readonly fields: readonly string[] }[],
  presetKind: "bank" | "card" | undefined,
): number {
  // A bank's own preset is the best evidence there is that this is not a card's (Mercury's export has
  // a "Name On Card" column for the debit card), and a card issuer's preset that it is.
  if (presetKind === "bank") return 0;
  let score = presetKind === "card" ? 3 : 0;
  const concepts = new Set(headers.flatMap((header) => conceptsOf(header)));
  if (concepts.has("merchant")) score += 2;
  // A column that names a card is as likely a bank's debit card as a card account.
  if (concepts.has("card")) score += 1;
  if (headers.some((header) => /category/i.test(header))) score += 1;
  const datedHeaders = headers.filter((header) => conceptsOf(header).includes("date")).length;
  if (datedHeaders >= 2) score += 2;
  if (titles.some((line) => /\bcard\b|\bvisa\b|\bmastercard\b|\bamex\b/.test(line))) score += 2;
  const description = headers.findIndex((header) => conceptsOf(header).includes("description"));
  const merchant = headers.findIndex((header) => conceptsOf(header).includes("merchant"));
  const wordsAt = description >= 0 ? description : merchant;
  if (wordsAt >= 0) {
    const thanked = records
      .slice(0, 300)
      .some((record) =>
        /payment.{0,12}thank you|auto ?pay|automatic payment|online payment/i.test(
          record.fields[wordsAt] ?? "",
        ),
      );
    if (thanked) score += 2;
  }
  const amountAt = headers.findIndex((header) => conceptsOf(header).includes("amount"));
  if (amountAt >= 0) {
    let positive = 0;
    let negative = 0;
    for (const record of records.slice(0, 300)) {
      const parsed = parseAmount((record.fields[amountAt] ?? "").trim());
      if (!parsed.ok) continue;
      if (parsed.cents > 0n) positive++;
      else if (parsed.cents < 0n) negative++;
    }
    // Charges written as positive amounts, with a few negative payments.
    if (positive >= 4 && negative >= 1 && positive >= negative * 3) score += 1;
  }
  return score;
}

/** A file without a header row whose rows each have a date, an amount and some words. */
function headerlessShape(records: readonly { readonly fields: readonly string[] }[]): boolean {
  const sample = records.slice(0, 40);
  if (sample.length < 2) return false;
  let good = 0;
  for (const record of sample) {
    const cells = record.fields.map((field) => field.trim());
    const dated = cells.some((cell) => isDateLike(cell));
    const amount = cells.some((cell) => cell !== "" && !isDateLike(cell) && isNumericCell(cell));
    const words = cells.some((cell) => cell !== "" && !isDateLike(cell) && !isNumericCell(cell));
    if (dated && amount && words) good++;
  }
  return good * 10 >= sample.length * 8;
}

function statementFactsOf(parsed: StatementParse): StatementFacts {
  const summary = summarizeLines(parsed.lines);
  const chain = parsed.csv?.chain ?? null;
  const reading: StatementFacts["reading"] =
    parsed.format === "ofx"
      ? "ofx"
      : parsed.csv?.source === "preset"
        ? "preset"
        : parsed.csv?.source === "detected"
          ? "detected"
          : parsed.csv?.source === "profile"
            ? "profile"
            : "none";
  const reported = parsed.balances[0];
  return {
    reading,
    ...(parsed.csv?.profile ? { recipe: neutral(parsed.csv.profile.name, 80) } : {}),
    ...(parsed.csv?.preset
      ? { presetId: parsed.csv.preset.id, presetVerified: parsed.csv.preset.verified }
      : {}),
    lines: summary.count,
    moneyIn: summary.moneyIn,
    moneyOut: summary.moneyOut,
    net: summary.net,
    currency: parsed.currency ?? "USD",
    balance: chain ? "running" : reported ? "reported" : "none",
    // A running balance gives the opening balance; a file that reports only its closing balance
    // gives it as the closing balance less the lines, which holds while the file is complete.
    ...(chain
      ? { opening: chain.opening }
      : reported
        ? { opening: formatMoney(parseMoney(reported.balance) - parseMoney(summary.net)) }
        : {}),
    ...(chain
      ? { closing: { asOf: chain.closing.asOf, amount: chain.closing.balance } }
      : reported
        ? { closing: { asOf: reported.asOf, amount: reported.balance } }
        : {}),
    ...(chain
      ? {
          chain: {
            order: chain.order,
            flipped: chain.flipped,
            compared: chain.compared,
            breakCount: chain.breakCount,
          },
        }
      : {}),
  };
}

function problemsOf(parsed: StatementParse): FileFacts["problems"] {
  const counts = parsed.diagnostics.counts;
  const messages = parsed.diagnostics
    .list()
    .filter((item) => item.severity === "error")
    .slice(0, MAX_MESSAGES)
    .map((item) => neutral(item.message, 300));
  return { errors: counts.errors, warnings: counts.warnings, messages };
}

// ---- OFX -----------------------------------------------------------------------------------

function inspectOfx(
  bytes: Uint8Array,
  text: string,
  encoding: TextEncoding,
  bom: boolean,
  options: InspectOptions,
): FileFacts {
  const parsed = parseStatement({ bytes, defaultCurrency: "USD", accountKey: "scan" });
  const flags = new Set<FileFlag>();
  if (bom) flags.add("bom");
  const intuit = /<INTU\.BID>|INTU\.BID/i.test(text.slice(0, 8192));
  const accounts: OfxAccountFact[] = (parsed.ofx?.accounts ?? []).slice(0, 20).map((account) => ({
    key: neutral(account.key, 200),
    label: neutral(account.label, 80),
    type: account.type,
    currency: account.currency,
    lines: account.count,
    from: account.from,
    to: account.to,
    ...(account.balance
      ? { closing: { asOf: account.balance.asOf, amount: account.balance.balance } }
      : {}),
  }));
  const first = accounts[0];
  const card = accounts.length > 0 && accounts.every((account) => account.type === "card");
  const dates = accounts
    .flatMap((account) => [account.from, account.to])
    .filter((d): d is string => d !== null);
  const range =
    dates.length > 0
      ? {
          from: dates.reduce((a, b) => (a < b ? a : b)),
          to: dates.reduce((a, b) => (a > b ? a : b)),
        }
      : undefined;
  if (range && range.to > options.today) flags.add("future_dates");
  const single = accounts.length === 1;
  const statement = single ? statementFactsOf(parsed) : undefined;
  if (statement && statement.balance === "none") flags.add("no_balance");
  const problems = problemsOf(parsed);
  return {
    kind: intuit ? "qfx" : "ofx",
    parsed: true,
    need: problems.errors > 0 && !single ? "human" : "none",
    role: card ? "card_statement" : "bank_statement",
    confidence: accounts.length > 0 ? "high" : "low",
    reasons: [card ? "ofx_card_account" : "ofx_bank_account"],
    encoding,
    lineEnding: lineEndingOf(text),
    rows: parsed.ofx?.transactions ?? 0,
    ...(range ? { range } : {}),
    ...(first ? { currency: first.currency } : {}),
    ...(statement ? { statement } : {}),
    accounts,
    flags: [...flags],
    problems,
  };
}

// ---- JSON ----------------------------------------------------------------------------------

function inspectJson(text: string, encoding: TextEncoding, bom: boolean): FileFacts | null {
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const keys = new Set<string>();
  let records = 1;
  let shape: "object" | "array" = "object";
  if (Array.isArray(value)) {
    shape = "array";
    records = value.length;
    for (const item of value.slice(0, 50))
      if (item && typeof item === "object" && !Array.isArray(item))
        for (const key of Object.keys(item)) {
          if (keys.size >= 20) break;
          keys.add(key);
        }
  } else if (value && typeof value === "object")
    for (const key of Object.keys(value)) {
      if (keys.size >= 20) break;
      keys.add(key);
    }
  const flags: FileFlag[] = bom ? ["bom"] : [];
  return {
    kind: "json",
    parsed: true,
    need: "agent",
    role: "other",
    confidence: "low",
    reasons: ["not_a_table"],
    encoding,
    lineEnding: lineEndingOf(text),
    rows: records,
    details: { json: { shape, records, keys: [...keys].map((key) => neutral(key, 40)) } },
    flags,
    problems: nothing(),
  };
}

// ---- Tables --------------------------------------------------------------------------------

function inspectTable(
  bytes: Uint8Array,
  text: string,
  encoding: TextEncoding,
  bom: boolean,
  options: InspectOptions,
): FileFacts {
  const delimiter = sniffDelimiter(text);
  const table = tokenizeCsv(text, delimiter);
  const filled = table.records.filter((record) =>
    record.fields.some((field) => field.trim() !== ""),
  );
  const widths = new Map<number, number>();
  for (const record of filled.slice(0, 60))
    widths.set(record.fields.length, (widths.get(record.fields.length) ?? 0) + 1);
  let modal = 0;
  for (const [width, count] of widths) if (count > (widths.get(modal) ?? 0)) modal = width;
  const flags = new Set<FileFlag>();
  if (bom) flags.add("bom");
  if (filled.length === 0 || modal < 2) {
    const flat: FileFacts = {
      kind: "text",
      parsed: true,
      need: "agent",
      role: "other",
      confidence: "low",
      reasons: ["not_a_table"],
      encoding,
      lineEnding: lineEndingOf(text),
      rows: filled.length,
      flags: [...flags],
      problems: nothing(),
    };
    return flat;
  }

  const headerRow = headerOf(table);
  const headerRecord = headerRow > 0 ? table.records[headerRow - 1] : undefined;
  const headers = headerRecord ? headerRecord.fields.map((field) => field.trim()) : [];
  const columns = columnsOf(table, headerRow);
  for (const column of columns) {
    if (column.flags.includes("instruction")) flags.add("instruction_text");
    if (column.flags.includes("formula")) flags.add("formula_cells");
    if (column.flags.includes("markup") || column.flags.includes("link")) flags.add("markup_text");
    if (column.flags.includes("control") || column.flags.includes("direction"))
      flags.add("control_characters");
  }
  const records = dataRecords(table, headerRow);
  if (headerRow > 1) flags.add("preamble");
  if (table.records.some((record) => record.fields.some((field) => /[\r\n]/.test(field))))
    flags.add("multiline_cells");

  // The titles above the header (a report's name and date), lower case, bounded.
  const titles: string[] = [];
  for (const record of table.records.slice(0, Math.max(0, headerRow - 1))) {
    const line = record.fields
      .map((field) => field.trim())
      .filter((field) => field !== "")
      .join(" ")
      .toLowerCase();
    if (line !== "") titles.push(line.slice(0, 160));
  }

  const dateColumn = columnWith(headers, "date");
  const accountColumn = (() => {
    const named = columnWith(headers, "accountName");
    return named >= 0 ? named : columnWith(headers, "account");
  })();
  const sample = records.slice(0, 200);
  const datedRows =
    dateColumn >= 0 &&
    sample.length > 0 &&
    sample.filter((record) => isDateLike((record.fields[dateColumn] ?? "").trim())).length * 2 >=
      sample.length;
  const totalRow = records.some((record) => /^\s*(grand\s+)?total\b/i.test(record.fields[0] ?? ""));
  if (totalRow) flags.add("total_row");
  let distinctAccounts: number | null = null;
  if (accountColumn >= 0) {
    const names = new Set<string>();
    for (const record of records.slice(0, 5000)) {
      const value = (record.fields[accountColumn] ?? "").trim();
      if (value !== "") names.add(value);
    }
    distinctAccounts = names.size;
  }
  const preset = headerRow > 0 ? matchPreset(table, headerRow) : null;
  const cardScore = cardEvidence(headers, titles, records, preset?.kind);
  const guess = guessRole({
    headers,
    titles,
    datedRows,
    totalRow,
    distinctAccounts,
    cardScore,
    ...(headerRow === 0 && headerlessShape(records) ? { shape: "dated_amounts" as const } : {}),
  });
  const kind: FileKind = delimiter === "\t" ? "tsv" : "csv";
  const base = {
    kind,
    parsed: true,
    encoding,
    delimiter,
    lineEnding: lineEndingOf(text),
    ...(headerRow > 0 ? { headerRow } : {}),
    columns,
    rows: records.length,
    role: guess.role,
    confidence: guess.confidence,
    reasons: guess.reasons,
  } as const;

  // Dates, wherever a date column is named.
  let range: RangeFact | undefined;
  let dateOrder: FileFacts["dateOrder"];
  if (dateColumn >= 0) {
    const scan = scanDates(
      records.map((record) => record.fields[dateColumn] ?? ""),
      options.today,
    );
    dateOrder = scan.order;
    if (scan.range) range = scan.range;
    if (scan.order === "ambiguous") flags.add("ambiguous_dates");
    if (scan.order === "mixed") flags.add("mixed_dates");
    if (scan.future) flags.add("future_dates");
  }

  // A status column with lines that are not final.
  const statusColumn = columnWith(headers, "status");
  if (statusColumn >= 0) {
    const pending = records.some((record) =>
      NON_FINAL.has(normalizeHeader(record.fields[statusColumn] ?? "")),
    );
    if (pending) flags.add("pending_rows");
  }

  if (guess.role === "bank_statement" || guess.role === "card_statement") {
    const parsed = parseStatement({
      bytes,
      defaultCurrency: "USD",
      accountKey: "scan",
      ...(options.profiles && options.profiles.length > 0 ? { profiles: options.profiles } : {}),
    });
    const problems = problemsOf(parsed);
    const statement = statementFactsOf(parsed);
    hostileFileFlags(
      parsed.lines.flatMap(({ line }) => [line.description, line.counterparty ?? ""]),
      flags,
    );
    if (statement.balance === "none") flags.add("no_balance");
    const errorKinds = [...parsed.diagnostics.errorKinds().keys()];
    if (errorKinds.some((kind) => kind === "bad_row" || kind === "short_row"))
      flags.add("unreadable_rows");
    // A recipe that states the order has settled what the dates mean.
    const settled = parsed.csv?.source === "profile" && parsed.csv.dateOrder !== null;
    const ambiguous =
      errorKinds.includes("ambiguous_date_order") || (dateOrder === "ambiguous" && !settled);
    if (ambiguous) flags.add("ambiguous_dates");
    else if (settled) {
      flags.delete("ambiguous_dates");
      dateOrder = parsed.csv?.dateOrder ?? dateOrder;
    }
    // A balance column that counts the other way from the amounts shows what is owed: a card's.
    const owed = statement.chain?.flipped === true && guess.role === "bank_statement";
    const readable = parsed.lines.length > 0 && problems.errors === 0;
    // Lines that are not final cannot be told apart by a detected reading; only a preset or a
    // recipe says which rows to keep.
    const needsFilter =
      flags.has("pending_rows") &&
      statement.reading !== "preset" &&
      statement.reading !== "profile";
    // Rows that cannot be read are the owner's to set aside; a file nothing reads needs a recipe.
    const rowLevel =
      errorKinds.length > 0 &&
      errorKinds.every(
        (kind) => kind === "bad_row" || kind === "short_row" || kind === "fitid_conflict",
      );
    const need: Need =
      readable && !needsFilter
        ? "none"
        : parsed.lines.length > 0 && rowLevel && !ambiguous && !needsFilter
          ? "human"
          : "recipe";
    const lineRange = statement.lines > 0 ? summarizeLines(parsed.lines) : null;
    return {
      ...base,
      ...(owed
        ? {
            role: "card_statement" as const,
            reasons: [...guess.reasons, "balance_counts_owed" as const],
          }
        : {}),
      need,
      ...(lineRange?.from && lineRange.to
        ? { range: { from: lineRange.from, to: lineRange.to } }
        : range
          ? { range }
          : {}),
      ...(dateOrder ? { dateOrder } : {}),
      ...(statement.lines > 0 ? { currency: statement.currency } : {}),
      statement,
      flags: [...flags],
      problems,
    };
  }

  const common = {
    ...base,
    need: "none" as Need,
    ...(range ? { range } : {}),
    ...(dateOrder ? { dateOrder } : {}),
  };
  hostileFileFlags(
    records.slice(0, 5000).flatMap((record) => record.fields.slice(0, 8)),
    flags,
  );

  if (guess.role === "trial_balance") {
    const tb = parseXeroTrialBalance(text, { decimal: "." });
    const asOf = tb.asOf ?? isoTitleDate(titles);
    const useYtd =
      tb.layout === "ytd" || tb.layout === "period_and_ytd" || tb.layout === "single_balance";
    const debit = useYtd ? tb.sums.ytdDebit : tb.sums.debit;
    const credit = useYtd ? tb.sums.ytdCredit : tb.sums.credit;
    const errors = tb.issues.filter((issue) => issue.severity === "error").length;
    return {
      ...common,
      rows: tb.rows.length,
      trialBalance: {
        asOf,
        layout: tb.layout,
        rows: tb.rows.length,
        balanced: tb.balanced,
        debit: formatMoney(debit),
        credit: formatMoney(credit),
        problems: errors,
      },
      flags: [...flags],
      problems: {
        errors,
        warnings: tb.issues.filter((issue) => issue.severity === "warning").length,
        messages: tb.issues
          .filter((issue) => issue.severity === "error")
          .slice(0, MAX_MESSAGES)
          .map((issue) => neutral(issue.message, 300)),
      },
    };
  }

  if (guess.role === "chart_of_accounts") {
    const typeColumn = columnWith(headers, "type");
    const nameColumn = accountColumn >= 0 ? accountColumn : 0;
    const types = new Set<string>();
    let accounts = 0;
    for (const record of records) {
      if ((record.fields[nameColumn] ?? "").trim() === "") continue;
      accounts++;
      const type = typeColumn >= 0 ? (record.fields[typeColumn] ?? "").trim() : "";
      if (type !== "" && types.size < 12) types.add(neutral(type, 40));
    }
    return {
      ...common,
      summary: { accounts, types: [...types] },
      flags: [...flags],
      problems: nothing(),
    };
  }

  if (guess.role === "general_ledger") {
    const debitColumn = columnWith(headers, "debit");
    const creditColumn = columnWith(headers, "credit");
    const summary: { accounts?: number; debit?: string; credit?: string; total?: string } = {};
    if (distinctAccounts !== null) summary.accounts = distinctAccounts;
    if (debitColumn >= 0 && creditColumn >= 0) {
      const debit = sumColumn(records, debitColumn, ".");
      const credit = sumColumn(records, creditColumn, ".");
      summary.debit = formatMoney(debit.cents);
      summary.credit = formatMoney(credit.cents);
    } else {
      const amountColumn = columnWith(headers, "amount");
      if (amountColumn >= 0)
        summary.total = formatMoney(sumColumn(records, amountColumn, ".").cents);
    }
    return { ...common, summary, flags: [...flags], problems: nothing() };
  }

  if (guess.role === "payout_report") {
    const payoutColumn = columnWith(headers, "payout");
    const distinct = new Set<string>();
    if (payoutColumn >= 0)
      for (const record of records) {
        const id = (record.fields[payoutColumn] ?? "").trim();
        if (id !== "") distinct.add(id);
      }
    const money = (concept: Concept): string | undefined => {
      const column = columnWith(headers, concept);
      return column >= 0 ? formatMoney(sumColumn(records, column, ".").cents) : undefined;
    };
    const gross = money("gross");
    const fee = money("fee");
    const net = money("net");
    return {
      ...common,
      summary: {
        ...(payoutColumn >= 0 ? { distinct: distinct.size } : {}),
        ...(gross ? { gross } : {}),
        ...(fee ? { fee } : {}),
        ...(net ? { net } : {}),
      },
      flags: [...flags],
      problems: nothing(),
    };
  }

  if (guess.role === "invoices") {
    const invoiceColumn = columnWith(headers, "invoice");
    const amountColumn = columnWith(headers, "amount");
    const distinct = new Set<string>();
    if (invoiceColumn >= 0)
      for (const record of records) {
        const id = (record.fields[invoiceColumn] ?? "").trim();
        if (id !== "") distinct.add(id);
      }
    return {
      ...common,
      summary: {
        ...(invoiceColumn >= 0 ? { distinct: distinct.size } : {}),
        ...(amountColumn >= 0
          ? { total: formatMoney(sumColumn(records, amountColumn, ".").cents) }
          : {}),
      },
      flags: [...flags],
      problems: nothing(),
    };
  }

  return { ...common, need: "agent", flags: [...flags], problems: nothing() };
}

// ---- The entry point -----------------------------------------------------------------------

export function inspectFile(bytes: Uint8Array, options: InspectOptions): FileFacts {
  try {
    return inspect(bytes, options);
  } catch {
    // Parsers are written not to throw. If one does, the file is described as unreadable, never
    // guessed at, and the caller is told only that.
    return {
      kind: "binary",
      parsed: false,
      need: "agent",
      why: "binary_unknown",
      role: "other",
      confidence: "low",
      reasons: ["binary_content"],
      flags: [],
      problems: { errors: 1, warnings: 0, messages: ["This file could not be read."] },
    };
  }
}

function inspect(bytes: Uint8Array, options: InspectOptions): FileFacts {
  const nameFlags: FileFlag[] = [];
  if (options.name !== undefined) {
    const found = hostileFlags(options.name);
    if (found.length > 0) nameFlags.push("name_flagged");
  }
  const withName = (facts: FileFacts): FileFacts =>
    nameFlags.length === 0
      ? facts
      : { ...facts, flags: [...new Set([...facts.flags, ...nameFlags])] };

  if (bytes.length === 0) return withName(unparsed("empty", "empty_file"));
  if (starts(bytes, 0x25, 0x50, 0x44, 0x46)) return withName(inspectPdf(bytes));
  if (starts(bytes, 0x50, 0x4b, 0x03, 0x04) || starts(bytes, 0x50, 0x4b, 0x05, 0x06))
    return withName(inspectZip(bytes));
  if (starts(bytes, 0xd0, 0xcf, 0x11, 0xe0))
    return withName(unparsed("xls", "workbook_needs_agent"));
  if (starts(bytes, 0x1f, 0x8b)) return withName(unparsed("gzip", "archive_not_opened"));
  if (
    starts(bytes, 0x89, 0x50, 0x4e, 0x47) ||
    starts(bytes, 0xff, 0xd8, 0xff) ||
    starts(bytes, 0x47, 0x49, 0x46, 0x38) ||
    (starts(bytes, 0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45)
  )
    return withName(unparsed("image", "image_needs_agent"));
  if (binaryKind(bytes) !== null) return withName(unparsed("binary", "binary_unknown"));

  const decoded = decodeText(bytes);
  const text = decoded.text;
  if (looksLikeOfx(text))
    return withName(inspectOfx(bytes, text, decoded.encoding, decoded.bom, options));
  const json = inspectJson(text, decoded.encoding, decoded.bom);
  if (json) return withName(json);
  return withName(inspectTable(bytes, text, decoded.encoding, decoded.bom, options));
}

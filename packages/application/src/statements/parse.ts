import type { BalanceCheck } from "../ingest-types.ts";
import { analyzeBalances, type BalanceAnalysis } from "./balance.ts";
import { type CsvTable, type Delimiter, MAX_RECORDS, sniffDelimiter, tokenizeCsv } from "./csv.ts";
import {
  type ColumnInfo,
  describeColumns,
  findHeaderRow,
  guessMapping,
  matchPreset,
} from "./csv-detect.ts";
import {
  applyCsvMapping,
  type ColumnRef,
  type CsvMapping,
  normalizeHeader,
  type ParseStats,
  type StatementLine,
} from "./csv-mapping.ts";
import type { DateOrder } from "./dates.ts";
import { Diagnostics } from "./diagnostics.ts";
import { quoteCell } from "./hostile.ts";
import { parseOfxText } from "./ofx.ts";
import { type CsvPreset, presetById } from "./presets.ts";
import { binaryKind, decodeText, type TextEncoding } from "./text.ts";

/** Statement bytes in, lines out: the one function the import operations call.
 *
 * It is a pure function of the bytes and the request: it reads nothing but its arguments, writes
 * nothing, and gives the same answer every time. It never throws. Whatever is wrong with a file is
 * a diagnostic, and a file that cannot be read at all returns no lines and at least one error. */

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LINES = 100_000;

export interface SavedMapping {
  readonly id: string;
  readonly name: string;
  readonly mapping: CsvMapping;
}

export interface ParseRequest {
  readonly bytes: Uint8Array;
  /** The book's currency, for files that do not say. */
  readonly defaultCurrency: string;
  /** The source key CSV lines carry: "csv:<chart account id>". */
  readonly accountKey: string;
  /** Use this preset (an id from the preset list). */
  readonly preset?: string;
  /** Use exactly this mapping, as the wizard sends it. Wins over everything else. */
  readonly mapping?: CsvMapping;
  /** Saved profiles for the account, tried in order when nothing was chosen explicitly. */
  readonly profiles?: readonly SavedMapping[];
  /** For an OFX file with several accounts: the key of the one to import. */
  readonly ofxAccount?: string;
  readonly ignoreProviderIds?: boolean;
  /** For OFX: flip the sign of the reported balance. */
  readonly invertBalance?: boolean;
}

export interface CsvDetails {
  readonly delimiter: Delimiter;
  /** The one-based header row; 0 when the file has none. */
  readonly headerRow: number;
  readonly columns: readonly ColumnInfo[];
  /** Where the mapping came from. */
  readonly source: "mapping" | "profile" | "preset" | "detected" | "none";
  readonly preset: CsvPreset | null;
  readonly profile: { readonly id: string; readonly name: string } | null;
  /** The mapping that was applied, with every column named by header and position. */
  readonly effective: CsvMapping | null;
  readonly dateOrder: DateOrder | null;
  /** What could not be found when detection came up empty, in words. */
  readonly missing: readonly string[];
  readonly stats: ParseStats | null;
  /** Rows after the header, blank ones included. */
  readonly rows: number;
  /** What the file's running balance says about itself, when it has one. */
  readonly chain: Omit<BalanceAnalysis, "lines"> | null;
}

export interface OfxAccountInfo {
  readonly key: string;
  readonly label: string;
  readonly type: "bank" | "card";
  readonly accountType: string;
  readonly currency: string;
  readonly count: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly balance: BalanceCheck | null;
}

export interface OfxDetails {
  readonly version: "1" | "2" | "unknown";
  readonly institution: string | null;
  readonly accounts: readonly OfxAccountInfo[];
  readonly selected: string | null;
  /** Transactions in the whole file, readable or not. */
  readonly transactions: number;
}

export interface StatementParse {
  readonly format: "csv" | "ofx" | "unknown";
  readonly provider: "csv" | "ofx" | null;
  readonly size: number;
  readonly encoding: TextEncoding | null;
  readonly lines: readonly StatementLine[];
  readonly balances: readonly BalanceCheck[];
  readonly diagnostics: Diagnostics;
  /** The source key the lines carry; null when no account could be chosen. */
  readonly accountKey: string | null;
  readonly currency: string | null;
  readonly csv: CsvDetails | null;
  readonly ofx: OfxDetails | null;
}

const failed = (
  diagnostics: Diagnostics,
  size: number,
  format: StatementParse["format"] = "unknown",
): StatementParse => ({
  format,
  provider: null,
  size,
  encoding: null,
  lines: [],
  balances: [],
  diagnostics,
  accountKey: null,
  currency: null,
  csv: null,
  ofx: null,
});

/** The column references a mapping cannot do without. */
function requiredRefs(mapping: CsvMapping): ColumnRef[] {
  const refs: (ColumnRef | undefined)[] = [
    mapping.date,
    mapping.amount.amount,
    mapping.amount.debit,
    mapping.amount.credit,
    mapping.amount.direction,
  ];
  return refs.filter((ref): ref is ColumnRef => ref !== undefined && !ref.optional);
}

/** Whether a saved mapping's required columns are all in this file's header. */
function mappingFits(mapping: CsvMapping, headers: readonly string[]): boolean {
  if (headers.length === 0) return requiredRefs(mapping).every((ref) => ref.index !== undefined);
  return requiredRefs(mapping).every(
    (ref) =>
      (ref.header !== undefined && headers.includes(normalizeHeader(ref.header))) ||
      (ref.header === undefined && ref.index !== undefined && ref.index <= headers.length),
  );
}

function sniffFormat(text: string): "ofx" | "csv" {
  const head = text.slice(0, 8192);
  if (/<OFX[\s>]/i.test(head) || /^\s*OFXHEADER\s*:/i.test(head) || /<\?OFX/i.test(head))
    return "ofx";
  return "csv";
}

function declaredCharset(bytes: Uint8Array): TextEncoding | undefined {
  let head = "";
  for (let index = 0; index < Math.min(bytes.length, 1024); index++)
    head += String.fromCharCode(bytes[index] as number);
  const match = /(?:CHARSET|ENCODING)\s*[:=]\s*"?([A-Za-z0-9-]+)/i.exec(head);
  const value = (match?.[1] ?? "").toLowerCase();
  if (value === "utf-8" || value === "utf8") return "utf-8";
  if (value === "1252" || value === "windows-1252" || value === "iso-8859-1" || value === "usascii")
    return "windows-1252";
  return undefined;
}

export function parseStatement(request: ParseRequest): StatementParse {
  const diagnostics = new Diagnostics();
  const { bytes } = request;
  try {
    if (bytes.length === 0) {
      diagnostics.error("empty", "The file is empty");
      return failed(diagnostics, 0);
    }
    if (bytes.length > MAX_FILE_BYTES) {
      diagnostics.error(
        "too_large",
        "The file is larger than 16 MiB. Export a shorter period and import it in parts.",
      );
      return failed(diagnostics, bytes.length);
    }
    const kind = binaryKind(bytes);
    if (kind) {
      diagnostics.error(
        "unsupported_file",
        `This is ${kind}, not a statement file. Export the statement as CSV, OFX, QFX or QBO from your bank instead.`,
      );
      return failed(diagnostics, bytes.length);
    }
    const decoded = decodeText(bytes, declaredCharset(bytes));
    if (decoded.encoding !== "utf-8")
      diagnostics.info(
        "encoding",
        `The file was read as ${decoded.encoding === "windows-1252" ? "Windows-1252" : decoded.encoding.toUpperCase()}`,
      );
    if (decoded.nulReplaced > 0)
      diagnostics.warning(
        "nul",
        `${decoded.nulReplaced} NUL character${decoded.nulReplaced === 1 ? "" : "s"} in the file ${decoded.nulReplaced === 1 ? "was" : "were"} replaced with a placeholder`,
      );
    if (decoded.undecodable > 0)
      diagnostics.warning(
        "undecodable",
        `${decoded.undecodable} character${decoded.undecodable === 1 ? "" : "s"} could not be decoded and ${decoded.undecodable === 1 ? "was" : "were"} replaced with a placeholder; the raw file is kept as it came`,
      );
    return sniffFormat(decoded.text) === "ofx"
      ? parseOfxFile(request, decoded.text, decoded.encoding, diagnostics)
      : parseCsvFile(request, decoded.text, decoded.encoding, diagnostics);
  } catch (error) {
    // Parsers are written not to throw. If one does, that is a bug to report, not a crash to
    // inherit: the file is refused with a message that names no internals.
    void error;
    const refusal = new Diagnostics();
    refusal.error(
      "parser_failed",
      "This file could not be read. It was not imported; please report it.",
    );
    return failed(refusal, bytes.length);
  }
}

function parseOfxFile(
  request: ParseRequest,
  text: string,
  encoding: TextEncoding,
  diagnostics: Diagnostics,
): StatementParse {
  const parsed = parseOfxText(
    text,
    {
      defaultCurrency: request.defaultCurrency,
      ...(request.ignoreProviderIds ? { ignoreProviderIds: true } : {}),
      ...(request.invertBalance ? { invertBalance: true } : {}),
    },
    diagnostics,
  );
  const infos: OfxAccountInfo[] = parsed.accounts.map((account) => ({
    key: account.key,
    label: account.label,
    type: account.type,
    accountType: account.accountType,
    currency: account.currency,
    count: account.lines.length,
    from: account.from,
    to: account.to,
    balance: account.balance,
  }));
  let selected = parsed.accounts.find((account) => account.key === request.ofxAccount);
  if (request.ofxAccount !== undefined && !selected)
    diagnostics.error(
      "unknown_account",
      `The file has no account ${quoteCell(request.ofxAccount, 80)}. It holds: ${parsed.accounts.map((account) => account.label).join(", ") || "none"}.`,
    );
  if (!selected && request.ofxAccount === undefined) {
    if (parsed.accounts.length === 1) selected = parsed.accounts[0];
    else if (parsed.accounts.length > 1)
      diagnostics.error(
        "multiple_accounts",
        `This file holds ${parsed.accounts.length} accounts (${parsed.accounts.map((account) => account.label).join(", ")}). Choose the one to import.`,
      );
  }
  const lines = selected ? selected.lines : [];
  if (lines.length > MAX_LINES)
    diagnostics.error(
      "too_many_lines",
      `The file has more than ${MAX_LINES.toLocaleString("en-US")} lines; import a shorter period`,
    );
  if (selected && lines.length === 0 && diagnostics.counts.errors === 0)
    diagnostics.warning("no_lines", "The statement holds no transactions");
  return {
    format: "ofx",
    provider: "ofx",
    size: text.length,
    encoding,
    lines,
    balances: selected?.balance ? [selected.balance] : [],
    diagnostics,
    accountKey: selected ? selected.key : null,
    currency: selected ? selected.currency : null,
    csv: null,
    ofx: {
      version: parsed.version,
      institution: parsed.institution,
      accounts: infos,
      selected: selected ? selected.key : null,
      transactions: parsed.transactions,
    },
  };
}

function parseCsvFile(
  request: ParseRequest,
  text: string,
  encoding: TextEncoding,
  diagnostics: Diagnostics,
): StatementParse {
  const explicit = request.mapping;
  const preset = request.preset !== undefined ? presetById(request.preset) : undefined;
  if (request.preset !== undefined && !preset) {
    diagnostics.error("unknown_preset", `There is no preset ${quoteCell(request.preset, 40)}`);
    return failed(diagnostics, text.length, "csv");
  }
  const delimiter = explicit?.delimiter ?? preset?.mapping.delimiter ?? sniffDelimiter(text);
  const table: CsvTable = tokenizeCsv(text, delimiter);
  if (table.truncated)
    diagnostics.error(
      "too_many_rows",
      `The file has more than ${MAX_RECORDS.toLocaleString("en-US")} rows; import a shorter period`,
    );
  if (table.fieldsCut > 0)
    diagnostics.warning(
      "too_many_columns",
      `${table.fieldsCut} row${table.fieldsCut === 1 ? " has" : "s have"} more than 512 columns; the extra columns were ignored`,
    );
  const detectedHeader = findHeaderRow(table);
  const headerRow = explicit?.headerRow ?? preset?.mapping.headerRow ?? detectedHeader;
  const headerRecord = headerRow > 0 ? table.records[headerRow - 1] : undefined;
  const headers = headerRecord ? headerRecord.fields.map(normalizeHeader) : [];
  const columns = describeColumns(table, headerRow);

  let chosen: CsvMapping | null = null;
  let source: CsvDetails["source"] = "none";
  let usedPreset: CsvPreset | null = null;
  let usedProfile: { id: string; name: string } | null = null;
  let missing: readonly string[] = [];
  if (explicit) {
    chosen = explicit;
    source = "mapping";
  } else if (preset) {
    chosen = preset.mapping;
    source = "preset";
    usedPreset = preset;
  } else {
    for (const profile of request.profiles ?? []) {
      if (mappingFits(profile.mapping, headers)) {
        chosen = profile.mapping;
        source = "profile";
        usedProfile = { id: profile.id, name: profile.name };
        break;
      }
    }
    if (!chosen) {
      const matched = matchPreset(table, headerRow);
      if (matched) {
        chosen = matched.mapping;
        source = "preset";
        usedPreset = matched;
      }
    }
    if (!chosen) {
      const guess = guessMapping(table, headerRow);
      missing = guess.missing;
      if (guess.mapping) {
        chosen = guess.mapping;
        source = "detected";
      }
    }
  }
  if (!chosen) {
    diagnostics.error(
      "mapping_needed",
      missing.length > 0
        ? `Could not tell which column holds ${missing.join(" or ")}. Choose the columns below.`
        : "Could not tell which columns hold the date, amount and description. Choose the columns below.",
    );
    return {
      ...failed(diagnostics, text.length, "csv"),
      encoding,
      provider: "csv",
      accountKey: request.accountKey,
      csv: {
        delimiter,
        headerRow,
        columns,
        source: "none",
        preset: null,
        profile: null,
        effective: null,
        dateOrder: null,
        missing,
        stats: null,
        rows: Math.max(0, table.records.length - headerRow),
        chain: null,
      },
    };
  }
  const withHeader: CsvMapping = { ...chosen, headerRow: chosen.headerRow ?? headerRow, delimiter };
  const outcome = applyCsvMapping(
    text,
    table,
    withHeader,
    { accountKey: request.accountKey, defaultCurrency: request.defaultCurrency },
    diagnostics,
  );
  let lines = outcome.lines;
  if (lines.length > MAX_LINES) {
    diagnostics.error(
      "too_many_lines",
      `The file has more than ${MAX_LINES.toLocaleString("en-US")} lines; import a shorter period`,
    );
    lines = lines.slice(0, MAX_LINES);
  }
  if (lines.length === 0 && diagnostics.counts.errors === 0)
    diagnostics.error("no_lines", "No transactions were found in this file");

  // What the file's own running balance says: its order, its sign, and whether it adds up.
  const balances: BalanceCheck[] = [];
  let chain: CsvDetails["chain"] = null;
  const analysis = analyzeBalances(lines, withHeader.invertBalance);
  if (analysis) {
    lines = analysis.lines as StatementLine[];
    const { lines: _kept, ...summary } = analysis;
    chain = summary;
    if (analysis.flipped)
      diagnostics.info(
        "balance_flipped",
        "The balance column counts the opposite way from the amounts (it shows what is owed); it was flipped to match",
      );
    if (analysis.breakCount > 0)
      diagnostics.warning(
        "balance_break",
        `The running balance does not follow from the amounts at ${analysis.breakCount} of ${analysis.compared} places, first at row ${analysis.breaks[0]}. A line may be missing from the file or read wrongly.`,
        analysis.breaks[0],
      );
    else if (analysis.compared > 0)
      diagnostics.info(
        "balance_ok",
        `The running balance follows from the amounts on all ${lines.length} lines`,
      );
    balances.push({
      accountKey: request.accountKey,
      asOf: analysis.closing.asOf,
      balance: analysis.closing.balance,
    });
  }
  const currency = lines[0]?.line.currency ?? withHeader.currency ?? request.defaultCurrency;
  return {
    format: "csv",
    provider: "csv",
    size: text.length,
    encoding,
    lines,
    balances,
    diagnostics,
    accountKey: request.accountKey,
    currency,
    csv: {
      delimiter,
      headerRow: outcome.effective?.headerRow ?? headerRow,
      columns,
      source,
      preset: usedPreset,
      profile: usedProfile,
      effective: outcome.effective,
      dateOrder: outcome.dateOrder,
      missing,
      stats: outcome.stats,
      rows: Math.max(0, table.records.length - headerRow),
      chain,
    },
    ofx: null,
  };
}

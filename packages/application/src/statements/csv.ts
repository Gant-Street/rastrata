/** A forgiving CSV tokenizer. Pure, linear, and incapable of throwing: whatever the bytes, it
 * returns records.
 *
 * Quoting follows RFC 4180 (a doubled quote inside a quoted field is one quote, a quoted field may
 * hold the delimiter and line breaks) and then goes further, because bank exports are not careful:
 * stray text after a closing quote is kept, a quote that never closes is read as a literal
 * character instead of swallowing the rest of the file, and a row may have any number of fields.
 * Each record remembers where it started and ended so the exact raw text can be shown as evidence. */

export interface CsvRecord {
  /** One-based number counting every record in the file, blank lines included: the row number a
   * spreadsheet would show. */
  readonly number: number;
  /** The fields, or an empty list for a blank line. */
  readonly fields: readonly string[];
  /** Offsets of the record's raw text in the decoded text (the end excludes the line break). */
  readonly start: number;
  readonly end: number;
  /** A quote in this record was stray or never closed. */
  readonly quoteProblem: boolean;
}

export interface CsvTable {
  readonly delimiter: string;
  readonly records: readonly CsvRecord[];
  /** The file had more records than the ceiling; the rest were not read. */
  readonly truncated: boolean;
  /** Records that held more fields than the ceiling; the extra fields were dropped. */
  readonly fieldsCut: number;
}

/** Ceilings that keep a hostile file from using unbounded memory. A real statement has a few
 * thousand rows and a few dozen columns. */
export const MAX_RECORDS = 250_000;
export const MAX_FIELDS = 512;

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const NO_FIELDS: readonly string[] = Object.freeze([]);

export function tokenizeCsv(text: string, delimiter: string): CsvTable {
  const delimiterCode = delimiter.charCodeAt(0);
  const length = text.length;
  const records: CsvRecord[] = [];
  let truncated = false;
  let fieldsCut = 0;
  let position = 0;
  while (position < length) {
    if (records.length >= MAX_RECORDS) {
      truncated = true;
      break;
    }
    const start = position;
    let fields: string[] = [];
    let problem = false;
    let cut = false;
    let end = position;
    for (;;) {
      let value: string | null = null;
      if (text.charCodeAt(position) === QUOTE) {
        let cursor = position + 1;
        let segment = cursor;
        let assembled = "";
        let closed = false;
        for (;;) {
          const quote = text.indexOf('"', cursor);
          if (quote === -1) break;
          if (text.charCodeAt(quote + 1) === QUOTE) {
            assembled += text.slice(segment, quote + 1);
            cursor = quote + 2;
            segment = cursor;
            continue;
          }
          assembled += text.slice(segment, quote);
          cursor = quote + 1;
          closed = true;
          break;
        }
        if (closed) {
          let stray = cursor;
          while (stray < length) {
            const code = text.charCodeAt(stray);
            if (code === delimiterCode || code === LF || code === CR) break;
            stray++;
          }
          if (stray > cursor) {
            assembled += text.slice(cursor, stray);
            problem = true;
          }
          value = assembled;
          position = stray;
        } else {
          // The quote never closes. Read this field as plain text rather than let it swallow the
          // rest of the file, and say so.
          problem = true;
        }
      }
      if (value === null) {
        let cursor = position;
        while (cursor < length) {
          const code = text.charCodeAt(cursor);
          if (code === delimiterCode || code === LF || code === CR) break;
          cursor++;
        }
        value = text.slice(position, cursor);
        position = cursor;
      }
      if (fields.length < MAX_FIELDS) fields.push(value);
      else cut = true;
      end = position;
      if (position >= length) break;
      const code = text.charCodeAt(position);
      if (code === delimiterCode) {
        position++;
        continue;
      }
      if (code === CR) {
        position++;
        if (text.charCodeAt(position) === LF) position++;
      } else position++;
      break;
    }
    if (cut) fieldsCut++;
    if (fields.length === 1 && fields[0] === "" && end === start) fields = NO_FIELDS as string[];
    records.push({ number: records.length + 1, fields, start, end, quoteProblem: problem });
  }
  return { delimiter, records, truncated, fieldsCut };
}

const CANDIDATES = [",", "\t", ";", "|"] as const;
export type Delimiter = (typeof CANDIDATES)[number];

/** Choose the delimiter a file uses by tokenizing its first rows with each candidate and keeping
 * the one that gives the same number of columns, two or more, on the most rows. Ties go to the
 * comma, then tab, semicolon and pipe. */
export function sniffDelimiter(text: string): Delimiter {
  // A sample cut at a line break, so a quoted field is not cut in half where it matters.
  let sample = text.slice(0, 65536);
  if (text.length > 65536) {
    const cut = Math.max(sample.lastIndexOf("\n"), sample.lastIndexOf("\r"));
    if (cut > 0) sample = sample.slice(0, cut);
  }
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const candidate of CANDIDATES) {
    const rows = tokenizeCsv(sample, candidate).records.filter((row) => row.fields.length > 0);
    const used = rows.slice(0, 60);
    const widths = new Map<number, number>();
    for (const row of used) widths.set(row.fields.length, (widths.get(row.fields.length) ?? 0) + 1);
    let modal = 0;
    let modalRows = 0;
    for (const [width, count] of widths)
      if (count > modalRows || (count === modalRows && width > modal)) {
        modal = width;
        modalRows = count;
      }
    // Trailing delimiters make Chase-style rows one field wider than the header; both widths count.
    const near = (widths.get(modal - 1) ?? 0) + (widths.get(modal + 1) ?? 0);
    const score = modal >= 2 ? (modalRows + near) * modal : 0;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

import { inflateRawSync } from "node:zlib";
import type { CsvRecord, CsvTable } from "./csv.ts";
import { MAX_RECORDS } from "./csv.ts";

/** An Excel workbook (.xlsx) read as the table its first sheet holds, in the records the CSV reader makes, so
 * that every reader of a CSV reads a workbook the same way. Xero's reports export as Excel and never as CSV,
 * and a person saves a spreadsheet as .xlsx without thinking; a reader that refused it would be a wall.
 *
 * A workbook is a zip of XML parts. Only the parts a table needs are read: the first worksheet, the shared
 * strings and the cell styles (to know a number that is a date). Each part is bounded, nothing is executed,
 * and a workbook that is not one of these (a zip of something else, a broken file) reads as no table. */

/** The bytes begin like a zip: what a workbook, and nothing a CSV, begins with. */
export const isZip = (bytes: Uint8Array): boolean =>
  bytes.length > 30 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

/** A part of a workbook may hold this much once unpacked; a sheet of sixty thousand rows is a few megabytes. */
const MAX_PART_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 2000;

const SIGNATURE_END = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;

interface Entry {
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

/** Where each file of the zip is, from the central directory at its end (the record a zip keeps of itself). */
function entries(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at -= 1)
    if (view.getUint32(at, true) === SIGNATURE_END) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("not a zip");
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  const found = new Map<string, Entry>();
  let at = directory;
  const decoder = new TextDecoder();
  for (let index = 0; index < Math.min(count, MAX_ENTRIES); index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIGNATURE_CENTRAL) break;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    found.set(name, { method, compressed, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/** One file of the zip, unpacked. */
function unpack(bytes: Uint8Array, entry: Entry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== SIGNATURE_LOCAL)
    throw new Error("zip entry out of place");
  if (entry.size > MAX_PART_BYTES) throw new Error("zip entry too large");
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  const packed = bytes.subarray(start, start + entry.compressed);
  if (entry.method === 0) return packed;
  if (entry.method === 8)
    return new Uint8Array(inflateRawSync(packed, { maxOutputLength: MAX_PART_BYTES }));
  throw new Error("zip method not supported");
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

/** The text of every `<t>` inside an element: a shared string is one `<t>` or several runs of them. */
function textOf(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
    out += decodeEntities(match[1] ?? "");
  return out;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1] ?? "") : null;
}

/** The strings the sheets share, by index. */
function sharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const out: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))
    out.push(textOf(match[1] ?? ""));
  return out;
}

/** Excel's own date formats, by number; a custom format is a date when it writes days, months or years. */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/** For each cell style, whether a number in it is a date. */
function dateStyles(xml: string | null): boolean[] {
  if (xml === null) return [];
  const custom = new Map<number, boolean>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const tag = match[1] ?? "";
    const id = Number(attribute(tag, "numFmtId"));
    const code = (attribute(tag, "formatCode") ?? "")
      .replace(/"[^"]*"/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\\./g, "");
    custom.set(id, /[dmyh]/i.test(code) && !/General/i.test(code));
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const out: boolean[] = [];
  for (const match of block.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const id = Number(attribute(match[1] ?? "", "numFmtId") ?? "0");
    out.push(BUILTIN_DATE_FORMATS.has(id) || custom.get(id) === true);
  }
  return out;
}

/** A serial day of Excel's calendar as `YYYY-MM-DD`. */
function dateOfSerial(serial: number, from1904: boolean): string {
  const epoch = from1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const day = new Date(epoch + Math.floor(serial) * 86_400_000);
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
}

/** A number as a spreadsheet shows it: whole when it is whole, otherwise without the noise of floating point. */
function numberText(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

/** The column of a cell reference ("BC12" is column 55), zero-based. */
function columnOf(reference: string): number {
  let column = 0;
  for (const letter of reference) {
    if (letter < "A" || letter > "Z") break;
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return column - 1;
}

/** The first worksheet's part name, from the workbook and its relationships, or the usual place. */
function firstSheetName(parts: Map<string, Entry>, read: (name: string) => string | null): string {
  const workbook = read("xl/workbook.xml");
  const relationships = read("xl/_rels/workbook.xml.rels");
  if (workbook && relationships) {
    const first = /<sheet\b([^>]*)\/?>/.exec(workbook)?.[1] ?? "";
    const id = attribute(first, "r:id");
    if (id) {
      for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const tag = match[1] ?? "";
        if (attribute(tag, "Id") === id) {
          const target = (attribute(tag, "Target") ?? "").replace(/^\/?(xl\/)?/, "");
          const name = `xl/${target}`;
          if (parts.has(name)) return name;
        }
      }
    }
  }
  if (parts.has("xl/worksheets/sheet1.xml")) return "xl/worksheets/sheet1.xml";
  const sheets = [...parts.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  sheets.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (sheets[0] === undefined) throw new Error("no worksheet");
  return sheets[0];
}

/** The table of the workbook's first sheet. Throws when the bytes are not a workbook. */
export function sheetTable(bytes: Uint8Array): CsvTable {
  const parts = entries(bytes);
  const decoder = new TextDecoder();
  const read = (name: string): string | null => {
    const entry = parts.get(name);
    return entry ? decoder.decode(unpack(bytes, entry)) : null;
  };
  const sheet = read(firstSheetName(parts, read));
  if (sheet === null) throw new Error("no worksheet");
  const strings = sharedStrings(read("xl/sharedStrings.xml"));
  const dated = dateStyles(read("xl/styles.xml"));
  const from1904 = /<workbookPr\b[^>]*\sdate1904="(1|true)"/.test(read("xl/workbook.xml") ?? "");
  const records: CsvRecord[] = [];
  let truncated = false;
  let number = 0;
  for (const row of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    if (records.length >= MAX_RECORDS) {
      truncated = true;
      break;
    }
    // Rows a sheet leaves out are blank rows: they keep their numbers, as a spreadsheet shows them.
    const at = Number(attribute(row[1] ?? "", "r") ?? number + 1);
    while (number + 1 < at && records.length < MAX_RECORDS) {
      number += 1;
      records.push({ number, fields: [], start: 0, end: 0, quoteProblem: false });
    }
    number = at;
    const fields: string[] = [];
    for (const cell of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cell[1] ?? "";
      const inner = cell[2] ?? "";
      const column = columnOf(attribute(tag, "r") ?? "");
      if (column < 0) continue;
      const type = attribute(tag, "t");
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
      let text: string;
      if (type === "s") text = strings[Number(value)] ?? "";
      else if (type === "inlineStr") text = textOf(inner);
      else if (type === "str" || type === "e" || type === "d") text = decodeEntities(value);
      else if (type === "b") text = value === "1" ? "TRUE" : "FALSE";
      else if (value === "") text = "";
      else {
        const style = Number(attribute(tag, "s") ?? "-1");
        text = dated[style] === true ? dateOfSerial(Number(value), from1904) : numberText(value);
      }
      while (fields.length < column) fields.push("");
      fields[column] = text.trim();
    }
    records.push({ number, fields, start: 0, end: 0, quoteProblem: false });
  }
  return { delimiter: ",", records, truncated, fieldsCut: 0 };
}

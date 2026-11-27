import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { MAX_FIELDS, MAX_RECORDS, sniffDelimiter, tokenizeCsv } from "../../src/statements/csv.ts";
import { sha256Hex } from "../../src/statements/sha256.ts";
import { binaryKind, decodeText } from "../../src/statements/text.ts";
import { bytesOf, random } from "./helpers.ts";

const rows = (text: string, delimiter = ",") =>
  tokenizeCsv(text, delimiter).records.map((record) => [...record.fields]);

test("fields, quotes, escaped quotes and embedded delimiters and line breaks", () => {
  expect(rows("a,b,c\n1,2,3\n")).toEqual([
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
  expect(rows('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  expect(rows('a,"say ""hi""",d')).toEqual([["a", 'say "hi"', "d"]]);
  expect(rows('a,"line one\nline two",d\nx,y,z')).toEqual([
    ["a", "line one\nline two", "d"],
    ["x", "y", "z"],
  ]);
  expect(rows('a,"line one\r\nline two",d\r\nx,y,z\r\n')).toEqual([
    ["a", "line one\r\nline two", "d"],
    ["x", "y", "z"],
  ]);
  expect(rows('"",,"x"')).toEqual([["", "", "x"]]);
});

test("line endings: LF, CRLF and a lone CR all end a row, and a final line break adds no empty row", () => {
  expect(rows("a,b\nc,d")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(rows("a,b\r\nc,d\r\n")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(rows("a,b\rc,d\r")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(rows("")).toEqual([]);
  expect(rows("\n")).toEqual([[]]);
});

test("blank lines keep their place, so row numbers match what a spreadsheet shows", () => {
  const table = tokenizeCsv("a,b\n\nc,d\n\n\ne,f\n", ",");
  expect(table.records.map((record) => record.number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(table.records.map((record) => record.fields.length)).toEqual([2, 0, 2, 0, 0, 2]);
});

test("a trailing delimiter makes a trailing empty field, as Chase writes", () => {
  expect(rows("a,b,\n1,2,\n")).toEqual([
    ["a", "b", ""],
    ["1", "2", ""],
  ]);
  expect(rows("a,b,")).toEqual([["a", "b", ""]]);
});

test("stray text after a closing quote is kept and flagged, not lost", () => {
  const table = tokenizeCsv('a,"b"c,d\n', ",");
  expect(table.records[0]?.fields).toEqual(["a", "bc", "d"]);
  expect(table.records[0]?.quoteProblem).toBe(true);
});

test("a quote that never closes does not swallow the rest of the file", () => {
  const table = tokenizeCsv('a,b\n1,"unfinished\n2,3\n4,5\n', ",");
  expect(table.records.length).toBeGreaterThanOrEqual(3);
  const last = table.records.at(-1);
  expect(last?.fields).toEqual(["4", "5"]);
  expect(table.records.some((record) => record.quoteProblem)).toBe(true);
});

test("a record remembers where its raw text is", () => {
  const text = 'h1,h2\n"a,b",c\n';
  const table = tokenizeCsv(text, ",");
  const second = table.records[1];
  expect(text.slice(second?.start, second?.end)).toBe('"a,b",c');
});

test("other delimiters", () => {
  expect(rows("a;b;c\n1;2;3", ";")).toEqual([
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
  expect(rows("a\tb\n1\t2", "\t")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  expect(rows("a|b\n1|2", "|")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("the delimiter is found from the data, and a quoted delimiter does not fool it", () => {
  expect(sniffDelimiter("a,b,c\n1,2,3\n4,5,6\n")).toBe(",");
  expect(sniffDelimiter("a;b;c\n1;2;3\n4;5;6\n")).toBe(";");
  expect(sniffDelimiter("a\tb\tc\n1\t2\t3\n4\t5\t6\n")).toBe("\t");
  expect(sniffDelimiter("a|b|c\n1|2|3\n")).toBe("|");
  expect(
    sniffDelimiter('Date;Amount;Memo\n01.02.2026;"1,50";"a, b"\n02.02.2026;"2,50";"c, d"\n'),
  ).toBe(";");
  expect(sniffDelimiter("single column\nonly\n")).toBe(",");
  expect(sniffDelimiter("")).toBe(",");
});

test("hostile shapes are bounded: a million delimiters, a huge cell, endless rows", () => {
  const wide = tokenizeCsv(`${",".repeat(1_000_000)}\n`, ",");
  expect(wide.records.length).toBe(1);
  expect(wide.records[0]?.fields.length).toBe(MAX_FIELDS);
  expect(wide.fieldsCut).toBe(1);
  const cell = tokenizeCsv(`a,"${"x".repeat(5_000_000)}",c\n`, ",");
  expect(cell.records[0]?.fields[1]?.length).toBe(5_000_000);
  const many = tokenizeCsv("\n".repeat(MAX_RECORDS + 10), ",");
  expect(many.records.length).toBe(MAX_RECORDS);
  expect(many.truncated).toBe(true);
  const quotes = tokenizeCsv('"'.repeat(1_000_001), ",");
  expect(quotes.records.length).toBeGreaterThan(0);
});

test("any table written in any dialect reads back to the same cells", () => {
  const generator = random(21);
  const alphabet = [
    "a",
    "b",
    " ",
    ",",
    '"',
    ";",
    "\n",
    "\r\n",
    "\t",
    "|",
    "é",
    "日",
    "x",
    "0",
    "-",
    "=",
    "'",
  ];
  for (let iteration = 0; iteration < 600; iteration++) {
    const delimiter = generator.pick([",", ";", "\t", "|"]);
    const width = generator.int(1, 6);
    const height = generator.int(1, 8);
    const table: string[][] = [];
    for (let row = 0; row < height; row++) {
      const cells: string[] = [];
      for (let column = 0; column < width; column++) {
        let cell = "";
        for (let length = generator.int(0, 8); length > 0; length--)
          cell += generator.pick(alphabet);
        cells.push(cell);
      }
      // A row of one empty cell is a blank line, which reads back as no fields; keep rows non-blank.
      if (width === 1 && cells[0] === "") cells[0] = "x";
      table.push(cells);
    }
    const eol = generator.pick(["\n", "\r\n"]);
    const quoteAll = generator.chance(0.3);
    const text = table
      .map((cells) =>
        cells
          .map((cell) =>
            quoteAll ||
            cell.includes(delimiter) ||
            cell.includes('"') ||
            cell.includes("\n") ||
            cell.includes("\r")
              ? `"${cell.replaceAll('"', '""')}"`
              : cell,
          )
          .join(delimiter),
      )
      .join(eol);
    const read = tokenizeCsv(text + (generator.chance(0.5) ? eol : ""), delimiter);
    expect(
      read.records.map((record) => [...record.fields]),
      JSON.stringify(text),
    ).toEqual(table);
    expect(read.records.every((record) => !record.quoteProblem)).toBe(true);
  }
});

test("text: UTF-8 with and without a byte order mark, UTF-16 both ways, and Windows-1252", () => {
  const plain = decodeText(bytesOf("café,€5\n"));
  expect(plain).toMatchObject({ text: "café,€5\n", encoding: "utf-8", bom: false, nulReplaced: 0 });
  const bom = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("a,b")]));
  expect(bom).toMatchObject({ text: "a,b", encoding: "utf-8", bom: true });
  const utf16le = new Uint8Array([
    0xff,
    0xfe,
    ...[..."Date\tAmount\né"].flatMap((symbol) => [
      symbol.charCodeAt(0) & 0xff,
      symbol.charCodeAt(0) >> 8,
    ]),
  ]);
  expect(decodeText(utf16le)).toMatchObject({
    text: "Date\tAmount\né",
    encoding: "utf-16le",
    bom: true,
  });
  const utf16be = new Uint8Array([
    0xfe,
    0xff,
    ...[..."Date\tAmount\né"].flatMap((symbol) => [
      symbol.charCodeAt(0) >> 8,
      symbol.charCodeAt(0) & 0xff,
    ]),
  ]);
  expect(decodeText(utf16be)).toMatchObject({
    text: "Date\tAmount\né",
    encoding: "utf-16be",
    bom: true,
  });
  const cp1252 = decodeText(
    new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x20, 0x93, 0x71, 0x94]),
  );
  expect(cp1252).toMatchObject({ text: "Café €5 “q”", encoding: "windows-1252" });
  const odd = decodeText(new Uint8Array([0xff, 0xfe, 0x41]));
  expect(odd.undecodable).toBeGreaterThan(0);
});

test("text: NUL becomes a placeholder, never reaching storage", () => {
  const result = decodeText(new Uint8Array([0x61, 0x00, 0x62, 0x00]));
  expect(result.text).toBe("a�b�");
  expect(result.nulReplaced).toBe(2);
  expect(result.text.includes("\u0000")).toBe(false);
});

test("text: files that are not text statements are named, not parsed", () => {
  expect(binaryKind(bytesOf("%PDF-1.7\n..."))).toBe("a PDF");
  expect(binaryKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toContain("Excel");
  expect(binaryKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("an image");
  expect(binaryKind(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe("a compressed file");
  expect(binaryKind(bytesOf("Date,Amount\n1,2\n"))).toBeNull();
  expect(binaryKind(new Uint8Array(1000).map((_, index) => (index * 31) % 7))).toBe(
    "a binary file",
  );
  expect(binaryKind(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBeNull();
  expect(binaryKind(new Uint8Array(0))).toBeNull();
});

test("sha256 agrees with the platform on every length around the block boundaries", () => {
  const generator = random(99);
  for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 4097]) {
    const bytes = new Uint8Array(length).map(() => generator.int(0, 255));
    expect(sha256Hex(bytes), `length ${length}`).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

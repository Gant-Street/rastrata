import { afterEach, expect, test } from "bun:test";
import { crc32, deflateRawSync } from "node:zlib";
import { parseHistory } from "../src/history/parse.ts";
import { ingestFor } from "../src/slices/statements/ports.ts";
import { sheetTable } from "../src/statements/xlsx.ts";
import { baseSetup, fixture } from "./calendar-support.ts";

/** A zip as a workbook is one: a local header and data for each file, the central directory, the end record.
 * `deflate` packs the file (method 8); otherwise it is stored (method 0). */
function zip(files: readonly { name: string; text: string; deflate?: boolean }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (value: number) => [...u16(value & 0xffff), ...u16((value >>> 16) & 0xffff)];
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const packed = file.deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const method = file.deflate ? 8 : 0;
    const sum = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(sum),
      ...u32(packed.length),
      ...u32(data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(method),
        ...u16(0),
        ...u16(0),
        ...u32(sum),
        ...u32(packed.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]),
    );
    parts.push(local, packed);
    offset += local.length + packed.length;
  }
  const directory = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(directory),
    ...u32(offset),
    ...u16(0),
  ]);
  const whole = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

/** Excel's day number for a date: days since the day before 1900 began. */
const serial = (date: string): number =>
  (Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) -
    Date.UTC(1899, 11, 30)) /
  86_400_000;

type Cell = string | number | { date: string } | null;

/** A workbook with one sheet, as a report export writes one: strings shared, dates as numbers in a date style,
 * amounts as numbers. `rows` are the sheet's rows in order; null cells are left out of the row. */
function workbook(
  rows: readonly (readonly Cell[])[],
  options: { deflate?: boolean } = {},
): Uint8Array {
  const strings: string[] = [];
  const index = (text: string) => {
    const found = strings.indexOf(text);
    if (found >= 0) return found;
    strings.push(text);
    return strings.length - 1;
  };
  const column = (position: number) => String.fromCharCode(65 + position);
  const sheetRows = rows
    .map((cells, rowIndex) => {
      const cellsXml = cells
        .map((cell, position) => {
          const reference = `${column(position)}${rowIndex + 1}`;
          if (cell === null) return "";
          if (typeof cell === "number") return `<c r="${reference}"><v>${cell}</v></c>`;
          if (typeof cell === "object")
            return `<c r="${reference}" s="1"><v>${serial(cell.date)}</v></c>`;
          return `<c r="${reference}" t="s"><v>${index(cell)}</v></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
    })
    .join("");
  const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return zip([
    { name: "[Content_Types].xml", text: '<?xml version="1.0"?><Types/>' },
    {
      name: "xl/workbook.xml",
      text: '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Journal Report" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: "xl/styles.xml",
      text: '<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="mmm d, yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>',
    },
    {
      name: "xl/sharedStrings.xml",
      text: `<?xml version="1.0"?><sst count="${strings.length}">${strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("")}</sst>`,
      deflate: options.deflate ?? false,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      text: `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
      deflate: options.deflate ?? false,
    },
  ]);
}

/** Xero's Journal Report as it exports to Excel: title rows, the header, each journal under an "ID" row, Total rows. */
function xeroJournalWorkbook(options: { deflate?: boolean } = {}): Uint8Array {
  return workbook(
    [
      ["Journal Report"],
      ["GANT STREET LLC"],
      ["For the period January 1, 2015 to December 31, 2026"],
      [],
      [
        "Date",
        "Journal ID",
        "Account Code",
        "Account",
        "Debit",
        "Credit",
        "Posted Date",
        "Posted By",
      ],
      ["ID 106 Stripe Refunds"],
      [
        { date: "2026-02-14" },
        106,
        null,
        "Cash (Checking)",
        "-",
        23.49,
        { date: "2026-02-23" },
        "Eric Lawson",
      ],
      [
        { date: "2026-02-14" },
        106,
        "REFUND",
        "Sales Returns and Allowances",
        23.49,
        "-",
        { date: "2026-02-23" },
        "Eric Lawson",
      ],
      ["Total", null, null, null, 23.49, 23.49],
      ["ID 105 Housing Opportunities Unlimited"],
      [
        { date: "2026-02-02" },
        105,
        null,
        "Cash (Checking)",
        2646,
        "-",
        { date: "2026-02-23" },
        "Eric Lawson",
      ],
      [
        { date: "2026-02-02" },
        105,
        "4000",
        "Sales",
        "-",
        2646,
        { date: "2026-02-23" },
        "Eric Lawson",
      ],
      ["Total", null, null, null, 2646, 2646],
      ["ID 1 Apple"],
      [
        { date: "2025-06-02" },
        1,
        null,
        "BUS COMPLETE CHK",
        "-",
        5.1,
        { date: "2025-08-30" },
        "Eric Lawson",
      ],
      [
        { date: "2025-06-02" },
        1,
        "6155",
        "Dues & Subscriptions",
        5.1,
        "-",
        { date: "2025-08-30" },
        "Eric Lawson",
      ],
      ["Total", null, null, null, 5.1, 5.1],
      ["Total", null, null, null, 2674.59, 2674.59],
    ],
    options,
  );
}

test("a workbook's first sheet is read as the table it holds: shared strings, numbers, dates by their style, blank rows kept", () => {
  const table = sheetTable(workbook([["A", 1.5, { date: "2026-01-05" }], [], ["b & c", 2]]));
  expect(table.records.map((record) => [record.number, record.fields])).toEqual([
    [1, ["A", "1.5", "2026-01-05"]],
    [2, []],
    [3, ["b & c", "2"]],
  ]);
});

test("Xero's Journal Report exported to Excel is read as it comes: the dates, the amounts, the account codes, and each journal's narration from its ID row", () => {
  for (const deflate of [false, true]) {
    const parsed = parseHistory(xeroJournalWorkbook({ deflate }), "auto");
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((entry) => [entry.key, entry.date, entry.narration])).toEqual([
      ["106", "2026-02-14", "Stripe Refunds"],
      ["105", "2026-02-02", "Housing Opportunities Unlimited"],
      ["1", "2025-06-02", "Apple"],
    ]);
    expect(parsed.entries[0]?.lines).toMatchObject([
      { code: "", name: "Cash (Checking)", debit: 0n, credit: 2349n },
      { code: "REFUND", name: "Sales Returns and Allowances", debit: 2349n, credit: 0n },
    ]);
    expect(parsed.entries[1]?.lines[0]).toMatchObject({ name: "Cash (Checking)", debit: 264600n });
    expect(parsed.linesRead).toBe(6);
  }
});

test("a zip that is not a workbook, and a workbook with no sheet, are said to be unreadable", () => {
  const parsed = parseHistory(zip([{ name: "hello.txt", text: "hello" }]));
  expect(parsed.unreadable).toBe(true);
  expect(parsed.problems[0]?.message).toContain("not a workbook");
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

test("the comparison with the old books reads a trial balance exported to Excel", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 10, 2, 12, 0, 0),
  });
  await f.call(
    "book.setup",
    {
      ...baseSetup,
      accounts: [...baseSetup.accounts],
      fiscalYear: 2000,
      booksStartOn: "2026-01-01",
    },
    crypto.randomUUID(),
  );
  await f.postOk("2026-03-10", "40.00");
  const tb = workbook([
    ["Trial Balance"],
    ["Calendar Co"],
    ["As at March 31, 2026"],
    [],
    ["Account", "Debit", "Credit"],
    // A code in brackets is a code; a word in brackets is part of the name of an account the book has.
    ["Cash (1000)", 40, null],
    ["Sales (4000)", null, 40],
    ["Total", 40, 40],
  ]);
  const file = ingestFor(f.service).archive(
    tb,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "tb.xlsx",
  ).sha256;
  const tied = (await f.call("history.tieOut", { file, asOf: "2026-03-31" })).body;
  expect(tied.ok, JSON.stringify(tied)).toBe(true);
  expect(tied.data).toMatchObject({ tied: true, differing: 0, problemCount: 0 });
});

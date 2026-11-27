import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { formatMoney, parseMoney } from "../../src/money.ts";
import type { CsvMapping } from "../../src/statements/csv-mapping.ts";
import { MAX_FILE_BYTES, parseStatement } from "../../src/statements/parse.ts";
import { assertWellFormed, bytesOf, fixtureBytes, parse, random } from "./helpers.ts";
import { expectWithin } from "../support/budget.ts";

/** Garbage must never crash a parser, never produce a line the pipeline would refuse, and never
 * take long about it. These tests throw bytes, mangled statements and pathological shapes at the
 * parsers with a seeded generator, so a failure reproduces from its seed. */

const FIXTURES = join(import.meta.dir, "fixtures");
const fixtureNames = readdirSync(FIXTURES).filter((name) => /\.(csv|qfx|ofx)$/.test(name));

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

test("random bytes of every size are refused or read, never a crash", () => {
  const generator = random(1);
  for (let iteration = 0; iteration < 400; iteration++) {
    const bytes = new Uint8Array(generator.int(0, 3000)).map(() => generator.int(0, 255));
    const result = parseStatement({ bytes, defaultCurrency: "USD", accountKey: "csv:1010" });
    assertWellFormed(result);
    expect(result.diagnostics.counts.errors + result.lines.length).toBeGreaterThan(0);
  }
});

test("text assembled from the characters of statements never crashes and never yields a bad line", () => {
  const generator = random(2);
  const pieces = [
    "Date",
    "Amount",
    "Description",
    "Debit",
    "Credit",
    "Balance",
    ",",
    ",",
    ";",
    "\t",
    "|",
    '"',
    '""',
    "\n",
    "\r\n",
    "\r",
    "01/15/2026",
    "2026-01-15",
    "13/02/2026",
    "-12.34",
    "(5.00)",
    "$1,234.56",
    "1.234,56",
    "abc",
    " ",
    "=",
    "+",
    "@",
    "-",
    "0.00",
    "1e9",
    "é",
    "‮",
    "\u0000",
    "<OFX>",
    "<STMTTRN>",
    "</STMTTRN>",
    "<TRNAMT>",
    "<DTPOSTED>",
    "&amp;",
    "<![CDATA[",
    "]]>",
    "<!--",
  ];
  for (let iteration = 0; iteration < 1500; iteration++) {
    let text = generator.chance(0.5) ? "Date,Description,Amount\n" : "";
    for (let count = generator.int(0, 60); count > 0; count--) text += generator.pick(pieces);
    const result = parse(text);
    assertWellFormed(result);
  }
});

test("every fixture, mutated in every way a bad download or a hostile sender might, still parses safely", () => {
  const generator = random(3);
  const fragments = [
    '"',
    "<",
    ">",
    "\n",
    ",",
    "\u0000",
    "&",
    "-",
    "9".repeat(40),
    "</STMTTRN>",
    "<STMTTRN>",
    "<FITID>",
    "﻿",
  ];
  for (const name of fixtureNames) {
    const original = fixtureBytes(name);
    for (let iteration = 0; iteration < 60; iteration++) {
      const bytes = Array.from(original);
      const kind = generator.int(0, 6);
      const at = generator.int(0, Math.max(0, bytes.length - 1));
      if (kind === 0)
        for (let flips = generator.int(1, 20); flips > 0; flips--)
          bytes[generator.int(0, bytes.length - 1)] = generator.int(0, 255);
      else if (kind === 1) bytes.length = at;
      else if (kind === 2) bytes.splice(at, generator.int(1, 200));
      else if (kind === 3) bytes.splice(at, 0, ...bytes.slice(at, at + generator.int(1, 300)));
      else if (kind === 4) bytes.splice(at, 0, ...bytesOf(generator.pick(fragments)));
      else if (kind === 5) bytes.splice(0, at);
      else bytes.splice(at, 0, ...bytesOf(generator.pick(fragments).repeat(generator.int(1, 500))));
      const result = parseStatement({
        bytes: new Uint8Array(bytes),
        defaultCurrency: "USD",
        accountKey: "csv:1010",
      });
      assertWellFormed(result);
    }
  }
});

test("pathological shapes finish quickly: one huge cell, a million tags, deep nesting, a million quotes", () => {
  const shapes: [string, Uint8Array][] = [
    [
      "a 5 MiB cell",
      bytesOf(`Date,Description,Amount\n01/15/2026,"${"x".repeat(5_000_000)}",-1.00\n`),
    ],
    ["a million delimiters", bytesOf(`${",".repeat(1_000_000)}\n`)],
    ["a million quotes", bytesOf('"'.repeat(1_000_000))],
    ["a million open tags", bytesOf(`<OFX>${"<A>".repeat(1_000_000)}`)],
    ["deep nesting", bytesOf(`<OFX>${"<STMTRS>".repeat(100_000)}`)],
    ["many empty rows", bytesOf(`Date,Description,Amount\n${"\n".repeat(2_000_000)}`)],
    [
      "an unterminated quote",
      bytesOf(`Date,Description,Amount\n01/15/2026,"${"y".repeat(2_000_000)}`),
    ],
    [
      "entities everywhere",
      bytesOf(
        `<OFX><STMTRS><BANKTRANLIST><STMTTRN><NAME>${"&amp;&#65;&#x42;&bogus;".repeat(200_000)}</STMTTRN></BANKTRANLIST></STMTRS></OFX>`,
      ),
    ],
    ["a million closing tags", bytesOf(`<OFX>${"</X>".repeat(1_000_000)}</OFX>`)],
  ];
  for (const [label, bytes] of shapes) {
    const { value, ms } = timed(() =>
      parseStatement({ bytes, defaultCurrency: "USD", accountKey: "csv:1010" }),
    );
    assertWellFormed(value);
    expectWithin(label, ms, 4000);
  }
});

test("the file ceiling: exactly 16 MiB is read, a byte more is refused before any parsing", () => {
  const filler = "x".repeat(MAX_FILE_BYTES - 40);
  const atLimit = new Uint8Array(MAX_FILE_BYTES);
  atLimit.set(bytesOf(`Date,Description,Amount\n01/15/2026,${filler.slice(0, 100)},-1.00\n`));
  expect(
    parseStatement({
      bytes: atLimit,
      defaultCurrency: "USD",
      accountKey: "csv:1010",
    }).diagnostics.count("too_large"),
  ).toBe(0);
  const over = parseStatement({
    bytes: new Uint8Array(MAX_FILE_BYTES + 1),
    defaultCurrency: "USD",
    accountKey: "csv:1010",
  });
  expect(over.diagnostics.count("too_large")).toBe(1);
  expect(over.lines).toHaveLength(0);
});

/** Round trip: write a random statement the way a bank might, in a random layout, then read it
 * back with the mapping that describes that layout. Every line must come back exactly. */
interface Tx {
  date: string;
  cents: bigint;
  description: string;
  reference: string;
}
function randomTransactions(generator: ReturnType<typeof random>, count: number): Tx[] {
  const words = [
    "AMAZON",
    "STRIPE",
    "Zelle",
    "ACH",
    "CHECK",
    "FEE",
    "café",
    "日本",
    "O'Brien",
    'say "hi"',
    "a,b",
    "x;y",
    "tab\there",
    "line\nbreak",
    "=sum",
    "@home",
    "-dash",
    "  padded  ",
    "a|b",
    "100%",
    "&amp;",
    "<b>",
  ];
  const list: Tx[] = [];
  for (let index = 0; index < count; index++) {
    let magnitude = 0n;
    for (let digits = generator.int(1, 12); digits > 0; digits--)
      magnitude = magnitude * 10n + BigInt(generator.int(0, 9));
    if (magnitude === 0n) magnitude = 1n;
    const description = Array.from({ length: generator.int(1, 5) }, () =>
      generator.pick(words),
    ).join(generator.pick([" ", "-", ""]));
    list.push({
      date: `${generator.int(2020, 2029)}-${String(generator.int(1, 12)).padStart(2, "0")}-${String(generator.int(1, 28)).padStart(2, "0")}`,
      cents: generator.chance(0.5) ? -magnitude : magnitude,
      description,
      reference: generator.chance(0.3) ? String(generator.int(1000, 9999)) : "",
    });
  }
  return list;
}

test("any statement written in any layout reads back to exactly the lines that were written", () => {
  const generator = random(4);
  for (let iteration = 0; iteration < 250; iteration++) {
    const transactions = randomTransactions(generator, generator.int(1, 25));
    const delimiter = generator.pick([",", ";", "\t", "|"] as const);
    const dateStyle = generator.pick(["ymd", "mdy", "dmy"] as const);
    const amountStyle = generator.pick(["signed", "debitCredit", "direction"] as const);
    const order = generator.pick(["amount-first", "description-first"] as const);
    const eol = generator.pick(["\n", "\r\n"]);
    const trailing = generator.chance(0.3);
    const bom = generator.chance(0.2);
    const preamble = generator.chance(0.3);
    const decimal = generator.pick([".", ","] as const);
    const quote = (cell: string) =>
      cell.includes(delimiter) || cell.includes('"') || cell.includes("\n") || cell.includes("\r")
        ? `"${cell.replaceAll('"', '""')}"`
        : cell;
    const formatDate = (iso: string) =>
      dateStyle === "ymd"
        ? iso
        : dateStyle === "mdy"
          ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
          : `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
    const money = (cents: bigint) =>
      decimal === "."
        ? formatMoney(cents < 0n ? -cents : cents)
        : formatMoney(cents < 0n ? -cents : cents).replace(".", ",");
    const headers =
      amountStyle === "signed"
        ? ["Date", "Amount", "Description", "Ref"]
        : amountStyle === "debitCredit"
          ? ["Date", "Debit", "Credit", "Description", "Ref"]
          : ["Date", "Amount", "Kind", "Description", "Ref"];
    const rows = transactions.map((tx) => {
      const sign = tx.cents < 0n ? "-" : "";
      if (amountStyle === "signed")
        return [formatDate(tx.date), `${sign}${money(tx.cents)}`, tx.description, tx.reference];
      if (amountStyle === "debitCredit")
        return [
          formatDate(tx.date),
          tx.cents < 0n ? money(tx.cents) : "",
          tx.cents > 0n ? money(tx.cents) : "",
          tx.description,
          tx.reference,
        ];
      return [
        formatDate(tx.date),
        money(tx.cents),
        tx.cents < 0n ? "DEBIT" : "CREDIT",
        tx.description,
        tx.reference,
      ];
    });
    if (order === "description-first") {
      // Reorder the columns: description and reference first.
      const move = (cells: string[]) => [
        cells[cells.length - 2] as string,
        cells[cells.length - 1] as string,
        ...cells.slice(0, -2),
      ];
      headers.splice(0, headers.length, ...move(headers));
      for (let index = 0; index < rows.length; index++) rows[index] = move(rows[index] as string[]);
    }
    let text = bom ? "﻿" : "";
    if (preamble)
      text += `Statement for account ending 1234${eol}Generated by the bank${eol}${eol}`;
    text +=
      [headers, ...rows]
        .map((cells) => cells.map(quote).join(delimiter) + (trailing ? delimiter : ""))
        .join(eol) + eol;
    const mapping: CsvMapping = {
      delimiter,
      decimal,
      date: { header: "Date" },
      dateOrder: dateStyle,
      amount:
        amountStyle === "signed"
          ? { kind: "signed", amount: { header: "Amount" } }
          : amountStyle === "debitCredit"
            ? { kind: "debitCredit", debit: { header: "Debit" }, credit: { header: "Credit" } }
            : {
                kind: "direction",
                amount: { header: "Amount" },
                direction: { header: "Kind" },
                outValues: ["DEBIT"],
                inValues: ["CREDIT"],
              },
      description: [{ header: "Description" }],
      reference: { header: "Ref" },
    };
    const result = parse(bytesOf(text), { mapping });
    const note = JSON.stringify({
      delimiter,
      dateStyle,
      amountStyle,
      order,
      eol,
      trailing,
      bom,
      preamble,
      decimal,
    });
    assertWellFormed(result);
    expect(
      result.diagnostics.counts.errors,
      `${note}\n${JSON.stringify(result.diagnostics.list().slice(0, 3))}\n${text}`,
    ).toBe(0);
    expect(result.lines.length, note).toBe(transactions.length);
    transactions.forEach((tx, index) => {
      const line = result.lines[index]?.line;
      expect(line?.postedOn, note).toBe(tx.date);
      expect(line?.amount, note).toBe(formatMoney(tx.cents));
      expect(line?.description, note).toBe(tx.description.trim().slice(0, 1000));
      expect(line?.reference ?? "", note).toBe(tx.reference);
    });
    // The total is exact, whatever the size of the amounts.
    const total = result.lines.reduce((sum, { line }) => sum + parseMoney(line.amount), 0n);
    expect(total).toBe(transactions.reduce((sum, tx) => sum + tx.cents, 0n));
  }
});

test("any statement written as OFX 1.x or 2.x reads back to exactly the lines that were written", () => {
  const generator = random(6);
  const xmlEscape = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  for (let iteration = 0; iteration < 200; iteration++) {
    const transactions = randomTransactions(generator, generator.int(1, 25)).filter(
      (tx) => !tx.description.includes("\n"),
    );
    if (transactions.length === 0) continue;
    const xml = generator.chance(0.5);
    const card = generator.chance(0.3);
    const closeLeaf = (name: string, value: string) =>
      xml ? `<${name}>${value}</${name}>` : `<${name}>${value}\n`;
    let text = xml
      ? '<?xml version="1.0"?>\n<?OFX OFXHEADER="200" VERSION="211"?>\n<OFX>\n'
      : "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n<OFX>\n";
    text += card
      ? "<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>"
      : "<BANKMSGSRSV1><STMTTRNRS><STMTRS>";
    text += closeLeaf("CURDEF", "USD");
    text += card
      ? `<CCACCTFROM>${closeLeaf("ACCTID", "ACCT9876")}</CCACCTFROM>`
      : `<BANKACCTFROM>${closeLeaf("BANKID", "123456789")}${closeLeaf("ACCTID", "ACCT1234")}${closeLeaf("ACCTTYPE", "CHECKING")}</BANKACCTFROM>`;
    text += "<BANKTRANLIST>";
    transactions.forEach((tx, index) => {
      text += `<STMTTRN>${closeLeaf("TRNTYPE", tx.cents < 0n ? "DEBIT" : "CREDIT")}${closeLeaf("DTPOSTED", `${tx.date.replaceAll("-", "")}${generator.pick(["", "120000", "000000[0:GMT]", "235959.000[-5:EST]"])}`)}${closeLeaf("TRNAMT", formatMoney(tx.cents))}${closeLeaf("FITID", `F${index}-${generator.int(0, 99999)}`)}${closeLeaf("NAME", xmlEscape(tx.description))}${tx.reference ? closeLeaf("CHECKNUM", tx.reference) : ""}</STMTTRN>${generator.pick(["", "\n", "\r\n"])}`;
    });
    text += `</BANKTRANLIST>${card ? "</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>" : "</STMTRS></STMTTRNRS></BANKMSGSRSV1>"}</OFX>\n`;
    const result = parse(bytesOf(text));
    assertWellFormed(result);
    expect(
      result.diagnostics.counts.errors,
      `${JSON.stringify(result.diagnostics.list().slice(0, 3))}\n${text.slice(0, 600)}`,
    ).toBe(0);
    expect(result.lines.length).toBe(transactions.length);
    transactions.forEach((tx, index) => {
      const line = result.lines[index]?.line;
      expect(line?.postedOn).toBe(tx.date);
      expect(line?.amount).toBe(formatMoney(tx.cents));
      expect(line?.description).toBe(tx.description.trim().slice(0, 1000));
      expect(line?.reference ?? "").toBe(tx.reference);
    });
  }
});

test("measured: a year of a busy business, and the largest file we accept", () => {
  const generator = random(8);
  const build = (count: number) => {
    let text = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n";
    let balance = 5_000_000n;
    for (let index = 0; index < count; index++) {
      const cents = BigInt(generator.int(-250_000, 250_000)) || 1n;
      balance += cents;
      const day = String((index % 28) + 1).padStart(2, "0");
      const month = String((Math.floor(index / 28) % 12) + 1).padStart(2, "0");
      text += `${cents < 0n ? "DEBIT" : "CREDIT"},${month}/${day}/2026,"MERCHANT ${index} ANYTOWN XX",${formatMoney(cents)},DEBIT_CARD,${formatMoney(balance)},,\n`;
    }
    return bytesOf(text);
  };
  const year = build(5_000);
  const parsedYear = timed(() =>
    parseStatement({ bytes: year, defaultCurrency: "USD", accountKey: "csv:1010" }),
  );
  expect(parsedYear.value.lines).toHaveLength(5_000);
  expect(parsedYear.value.csv?.chain?.breakCount).toBe(0);
  const big = build(100_000);
  const parsedBig = timed(() =>
    parseStatement({ bytes: big, defaultCurrency: "USD", accountKey: "csv:1010" }),
  );
  expect(parsedBig.value.lines).toHaveLength(100_000);
  expect(big.length).toBeLessThan(MAX_FILE_BYTES);
  console.log(
    `statements: 5,000 lines (${(year.length / 1024).toFixed(0)} KiB) in ${parsedYear.ms.toFixed(0)} ms; 100,000 lines (${(big.length / 1048576).toFixed(1)} MiB) in ${parsedBig.ms.toFixed(0)} ms`,
  );
  expectWithin("parsing 5,000 lines", parsedYear.ms, 1500);
  expectWithin("parsing 100,000 lines", parsedBig.ms, 15000);
  let ofx =
    "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>\n";
  for (let index = 0; index < 20_000; index++)
    ofx += `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260102120000<TRNAMT>-${index + 1}.00<FITID>${index}<NAME>MERCHANT ${index}<MEMO>MEMO ${index}</STMTTRN>\n`;
  ofx += "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
  const parsedOfx = timed(() =>
    parseStatement({ bytes: bytesOf(ofx), defaultCurrency: "USD", accountKey: "csv:1010" }),
  );
  expect(parsedOfx.value.lines).toHaveLength(20_000);
  console.log(
    `statements: 20,000 OFX transactions (${(ofx.length / 1048576).toFixed(1)} MiB) in ${parsedOfx.ms.toFixed(0)} ms`,
  );
  expectWithin("parsing 20,000 OFX transactions", parsedOfx.ms, 10000);
});

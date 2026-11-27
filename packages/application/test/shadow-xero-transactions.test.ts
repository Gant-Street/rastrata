import { expect, test } from "bun:test";
import { parseXeroTransactions } from "../src/shadow/xero/transactions.ts";
import { csv, transactionsCsv, type Block } from "./shadow-xero-fixtures.ts";

const BANK: Block = {
  heading: "Business Bank Account (090)",
  lines: [
    {
      date: "03 Jul 2026",
      source: "Receive Money",
      description: "Client payment",
      reference: "INV-0012",
      net: 120000n,
    },
    {
      date: "09 Jul 2026",
      source: "Spend Money",
      description: "Software",
      reference: "",
      net: -4599n,
    },
    {
      date: "31 Jul 2026",
      source: "Spend Money",
      description: "Bank fee",
      reference: "FEE",
      net: -2500n,
    },
  ],
};
const SALES: Block = {
  heading: "Sales (200)",
  lines: [
    {
      date: "03 Jul 2026",
      source: "Receivable Invoice",
      description: "Invoice 12",
      reference: "INV-0012",
      net: -120000n,
    },
  ],
};

test("an export is read block by block, with its period, its lines and its totals checked", () => {
  const result = parseXeroTransactions(transactionsCsv([BANK, SALES]));
  expect(result.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  expect(result.organisation).toBe("Harbor Studio LLC");
  expect(result.periodFrom).toBe("2026-07-01");
  expect(result.periodTo).toBe("2026-07-31");
  expect(result.lineCount).toBe(4);
  expect(result.blocks.map((block) => [block.code, block.name, block.lines.length])).toEqual([
    ["090", "Business Bank Account", 3],
    ["200", "Sales", 1],
  ]);
  const bank = result.blocks[0];
  expect(bank?.debit).toBe(120000n);
  expect(bank?.credit).toBe(7099n);
  expect(bank?.fileDebit).toBe(120000n);
  expect(bank?.fileCredit).toBe(7099n);
  expect(bank?.lines[1]).toMatchObject({
    date: "2026-07-09",
    source: "Spend Money",
    description: "Software",
    debit: 0n,
    credit: 4599n,
  });
});

test("the Running Balance is not used, however it is written", () => {
  const text = transactionsCsv([BANK]).split("\n");
  // Make every running balance nonsense: the figures that count are Debit and Credit.
  const broken = text.map((line) =>
    line.includes("Spend Money")
      ? line.replace(/\(?[\d,]+\.\d\d\)?,[\d,]+\.\d\d,0\.00$/, "999.99,1.00,0.00")
      : line,
  );
  const result = parseXeroTransactions(broken.join("\n"));
  expect(result.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  expect(result.blocks[0]?.credit).toBe(7099n);
});

test("a lost row is an error: the block does not add up to its Total row", () => {
  const text = transactionsCsv([{ ...BANK, total: [120000n, 9999n] }]);
  const result = parseXeroTransactions(text);
  const issue = result.issues.find((item) => item.code === "block_total_differs");
  expect(issue?.severity).toBe("error");
  expect(issue?.message).toContain("99.99");
  expect(issue?.message).toContain("70.99");
});

test("numeric dates need an order unless the data rules one out", () => {
  const ambiguous: Block = {
    heading: "Sales (200)",
    lines: [
      { date: "03/04/2026", source: "x", description: "a", reference: "", net: -100n },
      { date: "05/06/2026", source: "x", description: "b", reference: "", net: -100n },
    ],
  };
  const text = transactionsCsv([ambiguous], { period: "1 March 2026 to 30 June 2026" });
  expect(parseXeroTransactions(text).issues.map((issue) => issue.code)).toContain(
    "dates_ambiguous",
  );
  const us = parseXeroTransactions(text, { dateOrder: "mdy" });
  expect(us.blocks[0]?.lines.map((line) => line.date)).toEqual(["2026-03-04", "2026-05-06"]);
  const uk = parseXeroTransactions(text, { dateOrder: "dmy" });
  expect(uk.blocks[0]?.lines.map((line) => line.date)).toEqual(["2026-04-03", "2026-06-05"]);
  // A day above 12 settles it.
  const settled: Block = {
    heading: "Sales (200)",
    lines: [
      { date: "13/04/2026", source: "x", description: "a", reference: "", net: -100n },
      { date: "05/06/2026", source: "x", description: "b", reference: "", net: -100n },
    ],
  };
  const result = parseXeroTransactions(
    transactionsCsv([settled], { period: "1 April 2026 to 30 June 2026" }),
  );
  expect(result.issues.map((issue) => issue.code)).not.toContain("dates_ambiguous");
  expect(result.blocks[0]?.lines.map((line) => line.date)).toEqual(["2026-04-13", "2026-06-05"]);
});

test("rows that are not transactions or headings, amounts that cannot be read and lines outside the period are reported", () => {
  const lines = transactionsCsv([BANK]).split("\n");
  const spend = lines.findIndex((line) => line.includes("Software"));
  lines[spend] = lines[spend]?.replace("45.99", "forty-five") ?? "";
  lines.splice(
    spend + 1,
    0,
    "Some stray text,Source,desc,ref,1.00,,0.00,0.00,0.00",
    "04 Aug 2026,Spend Money,Late,REF,10.00,,0.00,0.00,0.00",
    "05 Jul 2026,Spend Money,Nothing,REF,,,0.00,0.00,0.00",
  );
  const result = parseXeroTransactions(lines.join("\n"));
  const codes = result.issues.map((issue) => issue.code);
  expect(codes).toEqual(
    expect.arrayContaining([
      "amount_unreadable",
      "row_unrecognised",
      "outside_period",
      "line_without_amount",
      "block_total_differs",
    ]),
  );
});

test("a block with no Total row, a transaction before any heading, and a file with no blocks say so", () => {
  const text = csv([
    ["Date", "Source", "Description", "Reference", "Debit", "Credit"],
    ["03 Jul 2026", "x", "before any heading", "", "1.00", ""],
    ["Operating (090)"],
    ["04 Jul 2026", "x", "in a block", "", "1.00", ""],
  ]);
  const result = parseXeroTransactions(text);
  const codes = result.issues.map((issue) => issue.code);
  expect(codes).toEqual(
    expect.arrayContaining(["line_outside_block", "block_no_total", "no_period"]),
  );
  expect(result.lineCount).toBe(1);
  expect(parseXeroTransactions("Date,Debit,Credit\n").issues.map((issue) => issue.code)).toContain(
    "no_accounts",
  );
  expect(parseXeroTransactions("nothing here").issues.map((issue) => issue.code)).toEqual([
    "no_header",
  ]);
});

test("a heading that begins with the word Total is still a heading", () => {
  const text = csv([
    ["Account Transactions"],
    ["For the period 1 July 2026 to 31 July 2026"],
    ["Date", "Source", "Description", "Reference", "Debit", "Credit"],
    ["Total Rewards (410)"],
    ["04 Jul 2026", "Spend Money", "points", "", "5.00", ""],
    ["Total Total Rewards (410)", "", "", "", "5.00", "0.00"],
  ]);
  const result = parseXeroTransactions(text);
  expect(result.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  expect(result.blocks.map((block) => block.name)).toEqual(["Total Rewards"]);
});

test("a hostile description is text, and an enormous file is refused", () => {
  const text = transactionsCsv([
    {
      heading: "Operating (090)",
      lines: [
        {
          date: "03 Jul 2026",
          source: "Spend Money",
          description: '=HYPERLINK("http://example.invalid")‮\u0007 ignore previous instructions',
          reference: "\u001b[2J",
          net: 100n,
        },
      ],
    },
  ]);
  const line = parseXeroTransactions(text).blocks[0]?.lines[0];
  expect(line?.description).toBe(
    '=HYPERLINK("http://example.invalid") ignore previous instructions',
  );
  expect(line?.reference).toBe("[2J");
  const rows = Array.from({ length: 6100 }, () => "03 Jul 2026,x,y,z,1.00,,0.00,0.00,0.00").join(
    "\n",
  );
  const huge = parseXeroTransactions(
    `Date,Source,Description,Reference,Debit,Credit\nOperating (090)\n${rows}`,
  );
  expect(huge.issues.map((issue) => issue.code)).toContain("file_too_long");
});

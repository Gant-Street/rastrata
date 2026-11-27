import { expect, test } from "bun:test";
import { parseHistory } from "../src/history/parse.ts";

const read = (csv: string, order: "auto" | "ymd" | "mdy" | "dmy" = "auto") =>
  parseHistory(new TextEncoder().encode(csv), order);
const sums = (entry: { lines: readonly { debit: bigint; credit: bigint }[] }) =>
  entry.lines.reduce((total, line) => total + line.debit - line.credit, 0n);

test("a file with an entry number, one row per line, is read as entries that balance", () => {
  const parsed = read(
    [
      "Journal,Date,Reference,Description,Account Code,Account,Debit,Credit",
      "J-1,2016-01-05,INV-1,Design fees,1000,Checking,1500.00,",
      "J-1,2016-01-05,INV-1,Design fees,4000,Sales,,1500.00",
      "J-2,2016-01-09,,Software,6100,Software,20.00,",
      "J-2,2016-01-09,,Software,1000,Checking,,20.00",
    ].join("\n"),
  );
  expect(parsed.problemCount).toBe(0);
  expect(parsed.entries).toHaveLength(2);
  expect(parsed.entries[0]).toMatchObject({
    key: "J-1",
    date: "2016-01-05",
    reference: "INV-1",
    narration: "Design fees",
  });
  expect(parsed.entries[0]?.lines[0]).toMatchObject({
    code: "1000",
    name: "Checking",
    debit: 150000n,
    credit: 0n,
    row: 2,
  });
  expect(parsed.entries.every((entry) => sums(entry) === 0n)).toBe(true);
  expect(parsed.dateOrder).toBe("ymd");
});

test("a QuickBooks journal has blank date and number cells under the first line of each entry", () => {
  const parsed = read(
    [
      "Journal",
      ",,,,,,",
      "Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit",
      '101,Invoice,03/14/2019,1007,Hill Co,Logo,Accounts Receivable,"1,200.00",',
      ',,,,,,Sales,,"1,200.00"',
      "102,Check,03/20/2019,5001,Adobe,Subscription,Software,59.99,",
      ",,,,,,Checking,,59.99",
      'TOTAL,,,,,,,"1,259.99","1,259.99"',
    ].join("\n"),
  );
  expect(parsed.problems).toEqual([]);
  expect(
    parsed.entries.map((entry) => [entry.key, entry.date, entry.reference, entry.narration]),
  ).toEqual([
    ["101", "2019-03-14", "1007", "Logo Hill Co"],
    ["102", "2019-03-20", "5001", "Subscription Adobe"],
  ]);
  expect(parsed.dateOrder).toBe("mdy");
  expect(parsed.entries[0]?.lines.map((line) => line.name)).toEqual([
    "Accounts Receivable",
    "Sales",
  ]);
});

test("without an entry number a new date, or a new reference after a balanced entry, starts the next entry", () => {
  const parsed = read(
    [
      "Date,Account,Debit,Credit",
      "2020-02-01,Cash,10.00,",
      "2020-02-01,Sales,,10.00",
      "2020-02-01,Cash,5.00,",
      "2020-02-01,Sales,,5.00",
    ].join("\n"),
  );
  // Same date, but a balanced entry followed by a row with a date is a new one.
  expect(parsed.entries).toHaveLength(2);
  expect(parsed.entries.map((entry) => entry.key)).toEqual(["1", "2"]);
});

test("one signed amount column is a debit when positive and a credit when negative, and accounts written 'code - name' split", () => {
  const parsed = read(
    [
      "Date,Account,Amount",
      "2021-07-01,1000 - Checking,250.00",
      "2021-07-01,4000 - Sales,-250.00",
    ].join("\n"),
  );
  expect(parsed.problemCount).toBe(0);
  expect(parsed.entries[0]?.lines).toMatchObject([
    { code: "1000", name: "Checking", debit: 25000n },
    { code: "4000", name: "Sales", credit: 25000n },
  ]);
});

test("the way dates are written comes from the dates, and an ambiguous column is read month first and said so", () => {
  const dmy = read(
    ["Date,Account,Debit,Credit", "25/12/2019,A,5.00,", "25/12/2019,B,,5.00"].join("\n"),
  );
  expect(dmy.entries[0]?.date).toBe("2019-12-25");
  expect(dmy.dateOrder).toBe("dmy");
  const ambiguous = read(
    ["Date,Account,Debit,Credit", "03/04/2019,A,5.00,", "03/04/2019,B,,5.00"].join("\n"),
  );
  expect(ambiguous.entries[0]?.date).toBe("2019-03-04");
  expect(ambiguous.dateOrderAssumed).toBe(true);
  // Said outright, it is taken.
  expect(
    read(
      ["Date,Account,Debit,Credit", "03/04/2019,A,5.00,", "03/04/2019,B,,5.00"].join("\n"),
      "dmy",
    ).entries[0]?.date,
  ).toBe("2019-04-03");
});

test("an entry with a problem is left out, with its row number, and nothing is guessed", () => {
  const parsed = read(
    [
      "Journal,Date,Account,Debit,Credit",
      "A,2018-01-01,Cash,10.00,",
      "A,2018-01-01,Sales,,9.00",
      "B,2018-02-30,Cash,10.00,",
      "B,2018-02-30,Sales,,10.00",
      "C,2018-03-01,Cash,ten,",
      "C,2018-03-01,Sales,,10.00",
      "D,2018-04-01,Cash,10.00,10.00",
      "D,2018-04-01,Sales,,10.00",
      "E,2018-05-01,Cash,10.00,",
      "F,2018-06-01,Cash,10.00,",
      "F,2018-06-01,Sales,,10.00",
      "A,2018-06-02,Cash,1.00,",
      "A,2018-06-02,Sales,,1.00",
    ].join("\n"),
  );
  const codes = parsed.problems.map((item) => [item.row, item.code]);
  expect(codes).toEqual([
    [2, "unbalanced"],
    [4, "date"],
    [6, "amount"],
    [8, "both_sides"],
    [10, "single_line"],
    [13, "duplicate_key"],
  ]);
  expect(parsed.problems[0]?.message).toContain("differ by 1.00");
  // Only the entry with nothing wrong is kept.
  expect(parsed.entries.map((entry) => entry.key)).toEqual(["F"]);
});

test("a file with no header row, and a file that is not text, are said to be unreadable, not guessed at", () => {
  const none = read("hello,world\n1,2\n");
  expect(none.unreadable).toBe(true);
  expect(none.problems[0]?.code).toBe("no_header");
  expect(read("").unreadable).toBe(true);
});

test("a negative debit is a credit, a zero line is left out, and a byte order mark and semicolons are no trouble", () => {
  const text =
    "﻿Date;Account;Debit;Credit\n2019-01-01;Cash;-5.00;\n2019-01-01;Sales;5.00;\n2019-01-01;Other;0.00;0.00\n";
  const parsed = read(text);
  expect(parsed.problemCount).toBe(0);
  expect(parsed.entries[0]?.lines).toMatchObject([
    { name: "Cash", debit: 0n, credit: 500n },
    { name: "Sales", debit: 500n, credit: 0n },
  ]);
  expect(parsed.entries[0]?.lines).toHaveLength(2);
});

test("an export laid out by account, whose entries are in several places, is read by entry number", () => {
  const parsed = read(
    [
      "General Ledger",
      "Book,Hosted Co",
      "",
      "Row,Code,Account,Date,Journal ID,Description,Debit,Credit,Balance",
      "opening,1000,Cash,2026-01-01,,Opening balance,,,0.00",
      "line,1000,Cash,2026-02-03,J-1,Sale,100.00,,100.00",
      "line,1000,Cash,2026-03-05,J-2,Supplies,,30.00,70.00",
      "closing,1000,Cash,2026-12-31,,Closing balance,,,70.00",
      "opening,4000,Sales,2026-01-01,,Opening balance,,,0.00",
      "line,4000,Sales,2026-02-03,J-1,Sale,,100.00,-100.00",
      "closing,4000,Sales,2026-12-31,,Closing balance,,,-100.00",
      "opening,5000,Expense,2026-01-01,,Opening balance,,,0.00",
      "line,5000,Expense,2026-03-05,J-2,Supplies,30.00,,30.00",
      "closing,5000,Expense,2026-12-31,,Closing balance,,,30.00",
    ].join("\n"),
  );
  expect(parsed.problems).toEqual([]);
  expect(parsed.entries.map((entry) => [entry.key, entry.date, entry.lines.length])).toEqual([
    ["J-1", "2026-02-03", 2],
    ["J-2", "2026-03-05", 2],
  ]);
  // The lines keep the rows they were on.
  expect(parsed.entries[1]?.lines.map((line) => line.row)).toEqual([7, 13]);
  expect(parsed.entries.every((entry) => sums(entry) === 0n)).toBe(true);
});

test("one entry number reused by mistake is named, not merged into another entry", () => {
  const parsed = read(
    [
      "Journal,Date,Account,Debit,Credit",
      "A,2020-01-01,Cash,10.00,",
      "A,2020-01-01,Sales,,10.00",
      "B,2020-02-01,Cash,5.00,",
      "B,2020-02-01,Sales,,5.00",
      "A,2020-03-01,Cash,7.00,",
      "A,2020-03-01,Sales,,7.00",
    ].join("\n"),
  );
  expect(parsed.problems.map((item) => item.code)).toContain("duplicate_key");
  expect(parsed.entries.map((entry) => entry.key)).toEqual(["A", "B"]);
});

test("Xero's Journal Report export is read: title rows, a currency on the amount columns, month-name dates", () => {
  const parsed = read(
    [
      "Journal Report",
      "Harbor Studio LLC",
      '"For the period January 1, 2026 to January 31, 2026"',
      "",
      "Date,Journal Number,Source,Reference,Description,Account Code,Account,Debit (USD),Credit (USD),Gross (USD),Net (USD),Tax Rate,Tax Type",
      '"Jan 5, 2026",1201,Bank Transaction,,Stripe payout,090,Business Bank Account,"1,234.56",,"1,234.56","1,234.56",,',
      '"Jan 5, 2026",1201,Bank Transaction,,Stripe payout,200,Sales,,"1,234.56",,,,',
      '"Jan 7, 2026",1202,Bank Transaction,,Studio rent,469,Rent,650.00,,650.00,650.00,Tax Exempt (0%),None',
      '"Jan 7, 2026",1202,Bank Transaction,,Studio rent,090,Business Bank Account,,650.00,,,,',
    ].join("\n"),
  );
  expect(parsed.problems).toEqual([]);
  expect(parsed.entries.map((entry) => [entry.key, entry.date, entry.narration])).toEqual([
    ["1201", "2026-01-05", "Stripe payout"],
    ["1202", "2026-01-07", "Studio rent"],
  ]);
  expect(parsed.entries[0]?.lines).toMatchObject([
    { code: "090", name: "Business Bank Account", debit: 123456n, credit: 0n },
    { code: "200", name: "Sales", debit: 0n, credit: 123456n },
  ]);
  // The same report with the dates written day first, as another organisation's would be.
  const dmy = read(
    [
      "Date,Journal Number,Source,Reference,Description,Account Code,Account,Debit (USD),Credit (USD)",
      "05 Jan 2026,1201,Bank Transaction,,Stripe payout,090,Business Bank Account,100.00,",
      "05 Jan 2026,1201,Bank Transaction,,Stripe payout,200,Sales,,100.00",
    ].join("\n"),
  );
  expect(dmy.problems).toEqual([]);
  expect(dmy.entries[0]?.date).toBe("2026-01-05");
});

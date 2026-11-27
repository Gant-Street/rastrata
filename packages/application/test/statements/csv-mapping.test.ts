import { expect, test } from "bun:test";
import { parseMoney } from "../../src/money.ts";
import { analyzeBalances } from "../../src/statements/balance.ts";
import type { CsvMapping } from "../../src/statements/csv-mapping.ts";
import { assertWellFormed, parse } from "./helpers.ts";

const messages = (result: ReturnType<typeof parse>, severity?: string) =>
  result.diagnostics
    .list()
    .filter((item) => !severity || item.severity === severity)
    .map((item) => item.message);

test("a summary block above the header, and blank lines, are skipped; row numbers match a spreadsheet", () => {
  const result = parse(
    [
      "Account summary",
      "Prepared 02/28/2026",
      "",
      "Date,Description,Amount",
      "01/15/2026,FIRST,-1.00",
      "",
      "01/16/2026,SECOND,-2.00",
      "01/17/2026,BAD,abc",
    ].join("\n"),
  );
  expect(result.csv?.headerRow).toBe(4);
  expect(result.lines.map(({ line }) => line.description)).toEqual(["FIRST", "SECOND"]);
  // Raw indexes count rows after the header, blank ones included, so they do not move with the mapping.
  expect(result.lines.map(({ line }) => line.rawIndex)).toEqual([0, 2]);
  expect(result.lines.map(({ row }) => row)).toEqual([5, 7]);
  const error = result.diagnostics.list().find((item) => item.severity === "error");
  expect(error?.row).toBe(8);
});

test("a file with no header at all is recognised, and columns are then named by position", () => {
  const text = ["01/15/2026,-1.00,FIRST", "01/16/2026,-2.00,SECOND"].join("\n");
  const without = parse(text);
  expect(without.csv?.headerRow).toBe(0);
  expect(without.diagnostics.count("mapping_needed")).toBe(1);
  expect(without.csv?.columns.map((column) => column.index)).toEqual([1, 2, 3]);
  expect(without.csv?.columns[0]?.samples[0]).toBe("01/15/2026");
  const mapping: CsvMapping = {
    headerRow: 0,
    date: { index: 1 },
    dateOrder: "mdy",
    amount: { kind: "signed", amount: { index: 2 } },
    description: [{ index: 3 }],
  };
  const mapped = parse(text, { mapping });
  expect(
    mapped.lines.map(({ line }) => [line.postedOn, line.amount, line.description, line.rawIndex]),
  ).toEqual([
    ["2026-01-15", "-1.00", "FIRST", 0],
    ["2026-01-16", "-2.00", "SECOND", 1],
  ]);
});

test("dates that cannot be ordered from the data are refused, not guessed", () => {
  const text =
    "Date,Description,Amount\n01/02/2026,A,-1.00\n03/04/2026,B,-2.00\n05/06/2026,C,-3.00\n";
  const result = parse(text);
  expect(result.lines).toHaveLength(0);
  expect(result.diagnostics.count("ambiguous_dates")).toBe(1);
  expect(messages(result, "error")[0]).toContain("Choose the date order");
  // Saying so settles it.
  const mdy = parse(text, {
    mapping: {
      ...(result.csv?.effective ?? ({} as CsvMapping)),
      headerRow: 1,
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
    },
  });
  expect(mdy.lines.map(({ line }) => line.postedOn)).toEqual([
    "2026-01-02",
    "2026-03-04",
    "2026-05-06",
  ]);
  const dmy = parse(text, {
    mapping: {
      headerRow: 1,
      date: { header: "Date" },
      dateOrder: "dmy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
    },
  });
  expect(dmy.lines.map(({ line }) => line.postedOn)).toEqual([
    "2026-02-01",
    "2026-04-03",
    "2026-06-05",
  ]);
  // One date above 12 decides the order for the whole column, and the file says how it decided.
  const decided = parse("Date,Description,Amount\n01/02/2026,A,-1.00\n03/25/2026,B,-2.00\n");
  expect(decided.lines.map(({ line }) => line.postedOn)).toEqual(["2026-01-02", "2026-03-25"]);
  expect(messages(decided, "info").join(" ")).toContain("month/day/year");
  const mixed = parse("Date,Description,Amount\n03/25/2026,A,-1.00\n25/03/2026,B,-2.00\n");
  expect(mixed.diagnostics.count("mixed_dates")).toBe(1);
});

test("a mapping that explicitly orders the dates reports the rows that do not fit it", () => {
  const result = parse("Date,Description,Amount\n01/02/2026,A,-1.00\n13/02/2026,B,-2.00\n", {
    mapping: {
      headerRow: 1,
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
    },
  });
  expect(result.lines).toHaveLength(1);
  const error = result.diagnostics.list().find((item) => item.severity === "error");
  expect(error?.row).toBe(3);
  expect(error?.message).toContain("month/day/year");
});

test("debit and credit columns: each column fixes the direction, a sign in a column is noted and ignored, both filled is an error", () => {
  const text = [
    "Date,Description,Debit,Credit",
    "01/15/2026,PURCHASE,12.34,",
    "01/16/2026,PAYMENT,,100.00",
    "01/17/2026,SIGNED DEBIT,-5.00,",
    "01/18/2026,BOTH,1.00,2.00",
    "01/19/2026,NEITHER,,",
    "01/20/2026,ZERO,0.00,",
  ].join("\n");
  const result = parse(text);
  expect(result.lines.map(({ line }) => [line.description, line.amount])).toEqual([
    ["PURCHASE", "-12.34"],
    ["PAYMENT", "100.00"],
    ["SIGNED DEBIT", "-5.00"],
  ]);
  expect(result.diagnostics.count("debit_credit_sign")).toBe(1);
  expect(messages(result, "error").join(" ")).toContain("both a debit and a credit");
  expect(result.diagnostics.count("no_amount")).toBe(1);
  expect(result.diagnostics.count("zero_amount")).toBe(1);
});

test("an amount with a separate debit-or-credit column", () => {
  const mapping: CsvMapping = {
    headerRow: 1,
    date: { header: "Date" },
    dateOrder: "ymd",
    amount: {
      kind: "direction",
      amount: { header: "Amount" },
      direction: { header: "Type" },
      outValues: ["debit", "D"],
      inValues: ["credit", "C"],
    },
    description: [{ header: "Memo" }],
  };
  const result = parse(
    "Date,Amount,Type,Memo\n2026-01-15,10.00,Debit,A\n2026-01-16,20.00,C,B\n2026-01-17,30.00,Wire,C\n2026-01-18,-4.00,debit,D\n",
    { mapping },
  );
  expect(result.lines.map(({ line }) => line.amount)).toEqual(["-10.00", "20.00", "-4.00"]);
  expect(messages(result, "error").join(" ")).toContain("is not one of the values you listed");
  expect(result.diagnostics.count("direction_sign")).toBe(1);
});

test("a filter imports only the listed rows and counts what it skipped, by value", () => {
  const mapping: CsvMapping = {
    headerRow: 1,
    date: { header: "Date" },
    dateOrder: "ymd",
    amount: { kind: "signed", amount: { header: "Amount" } },
    description: [{ header: "Memo" }],
    include: { column: { header: "Status" }, values: ["Settled"] },
  };
  const text =
    "Date,Amount,Status,Memo\n2026-01-15,-1.00,Settled,A\n2026-01-16,-2.00,Pending,B\n2026-01-17,-3.00,PENDING,C\n2026-01-18,-4.00,settled,D\n2026-01-19,-5.00,,E\n";
  const result = parse(text, { mapping });
  expect(result.lines.map(({ line }) => line.description)).toEqual(["A", "D"]);
  expect(result.csv?.stats?.filtered).toEqual({ Pending: 1, PENDING: 1, "(empty)": 1 });
  expect(messages(result, "info").join("\n")).toContain(
    'Skipped 1 row whose "Status" column is "Pending"',
  );
  const unfiltered = parse("Date,Amount,Memo\n2026-01-15,-1.00,A\n", { mapping });
  expect(unfiltered.diagnostics.count("column_missing")).toBe(1);
});

test("a column the bank may leave out is optional; a required one that is gone is an error that names it", () => {
  const mapping: CsvMapping = {
    headerRow: 1,
    date: { header: "Date" },
    dateOrder: "ymd",
    amount: { kind: "signed", amount: { header: "Amount" } },
    description: [{ header: "Memo" }, { header: "Notes", optional: true }],
    reference: { header: "Ref", optional: true },
  };
  const result = parse("Date,Amount,Memo\n2026-01-15,-1.00,A\n", { mapping });
  expect(result.diagnostics.counts.errors).toBe(0);
  expect(result.lines[0]?.line.reference).toBeUndefined();
  const missing = parse("Date,Total,Memo\n2026-01-15,-1.00,A\n", { mapping });
  expect(missing.lines).toHaveLength(0);
  expect(messages(missing, "error")[0]).toContain('The amount column "Amount" was not found');
});

test("columns are found by header name whatever their order, ignoring case and spacing", () => {
  const mapping: CsvMapping = {
    headerRow: 1,
    date: { header: "posting  date" },
    dateOrder: "mdy",
    amount: { kind: "signed", amount: { header: "AMOUNT" } },
    description: [{ header: " Description " }],
  };
  const result = parse("Description,Amount,Posting Date\nHello,-1.00,01/15/2026\n", { mapping });
  expect(result.lines[0]?.line).toMatchObject({
    postedOn: "2026-01-15",
    amount: "-1.00",
    description: "Hello",
  });
  expect(result.csv?.effective?.date).toEqual({ header: "Posting Date", index: 3 });
});

test("a semicolon file with decimal commas is read when the mapping says so", () => {
  const text =
    "Datum;Betrag;Verwendungszweck\n15.01.2026;-1.234,50;Miete\n16.01.2026;2.000,00;Gehalt\n17.01.2026;12,5;Kaffee\n";
  const mapping: CsvMapping = {
    delimiter: ";",
    headerRow: 1,
    decimal: ",",
    date: { header: "Datum" },
    dateOrder: "dmy",
    amount: { kind: "signed", amount: { header: "Betrag" } },
    description: [{ header: "Verwendungszweck" }],
    currency: "EUR",
  };
  const result = parse(text, { mapping });
  expect(result.lines.map(({ line }) => [line.postedOn, line.amount, line.currency])).toEqual([
    ["2026-01-15", "-1234.50", "EUR"],
    ["2026-01-16", "2000.00", "EUR"],
    ["2026-01-17", "12.50", "EUR"],
  ]);
  // Read as a US file the same amounts are refused rather than misread by a factor of a thousand.
  const refused = parse(text, { mapping: { ...mapping, decimal: "." } });
  expect(refused.lines).toHaveLength(0);
  expect(refused.diagnostics.counts.errors).toBeGreaterThan(0);
});

test("amounts with more than two decimals are an error on that row and nothing is rounded", () => {
  const result = parse("Date,Description,Amount\n01/15/2026,A,-1.005\n01/16/2026,B,-2.00\n");
  expect(result.lines.map(({ line }) => line.amount)).toEqual(["-2.00"]);
  expect(messages(result, "error")[0]).toContain("more than two decimal places");
  expect(result.diagnostics.list()[0]?.row).toBe(2);
});

test("headings, totals and cut-short rows are skipped with a note, not mistaken for transactions", () => {
  const text = [
    "Date,Description,Amount,Balance",
    "01/15/2026,A,-1.00,9.00",
    "Total,,,",
    "01/16/2026,B",
    "01/17/2026,C,-2.00,7.00",
  ].join("\n");
  const result = parse(text);
  expect(result.lines.map(({ line }) => line.description)).toEqual(["A", "C"]);
  expect(result.diagnostics.counts.errors).toBe(0);
  const wide = parse(
    "Date,Description,Amount,Balance\n01/15/2026,A,-1.00,9.00\n01/16/2026,B\nx,y,z\n",
  );
  expect(wide.diagnostics.counts.errors).toBeGreaterThan(0);
});

test("a row's raw text is kept as provenance, exactly as the file had it", () => {
  const result = parse('Date,Description,Amount\n01/15/2026,"A, quoted ""memo""",-1.00\n');
  expect(result.lines[0]?.line.excerpt).toBe('01/15/2026,"A, quoted ""memo""",-1.00');
  expect(result.lines[0]?.line.description).toBe('A, quoted "memo"');
});

test("the currency is the mapping's, or the book's", () => {
  const text = "Date,Description,Amount\n01/15/2026,A,-1.00\n";
  expect(parse(text).lines[0]?.line.currency).toBe("USD");
  expect(parse(text, { defaultCurrency: "GBP" }).lines[0]?.line.currency).toBe("GBP");
  const mapping = {
    headerRow: 1,
    date: { header: "Date" },
    dateOrder: "mdy" as const,
    amount: { kind: "signed" as const, amount: { header: "Amount" } },
    description: [{ header: "Description" }],
  };
  expect(parse(text, { mapping: { ...mapping, currency: "eur" } }).lines[0]?.line.currency).toBe(
    "EUR",
  );
  expect(
    parse(text, { mapping: { ...mapping, currency: "EURO" } }).diagnostics.count("bad_currency"),
  ).toBe(1);
});

test("exact money: amounts at the edge of what a number can hold sum without drift", () => {
  const big = "9999999999999.99";
  const result = parse(
    `Date,Description,Amount\n01/15/2026,A,${big}\n01/16/2026,B,${big}\n01/17/2026,C,-0.01\n`,
  );
  const total = result.lines.reduce((sum, { line }) => sum + parseMoney(line.amount), 0n);
  expect(total).toBe(parseMoney(big) * 2n - 1n);
});

test("a running balance that follows from the amounts proves the file complete; one that does not names the row", () => {
  const good = parse(
    "Date,Description,Amount,Balance\n01/15/2026,A,-10.00,90.00\n01/16/2026,B,5.00,95.00\n01/17/2026,C,-1.00,94.00\n",
  );
  expect(good.csv?.chain).toMatchObject({
    order: "oldest-first",
    flipped: false,
    breakCount: 0,
    opening: "100.00",
    closing: { asOf: "2026-01-17", balance: "94.00" },
  });
  expect(good.balances).toEqual([{ accountKey: "csv:1010", asOf: "2026-01-17", balance: "94.00" }]);
  const missing = parse(
    "Date,Description,Amount,Balance\n01/15/2026,A,-10.00,90.00\n01/17/2026,C,-1.00,84.00\n01/18/2026,D,-1.00,83.00\n",
  );
  expect(missing.csv?.chain?.breakCount).toBe(1);
  expect(messages(missing, "warning")[0]).toContain("row 3");
  // Newest first is recognised from the arithmetic, not assumed.
  const descending = parse(
    "Date,Description,Amount,Balance\n01/17/2026,C,-1.00,94.00\n01/16/2026,B,5.00,95.00\n01/15/2026,A,-10.00,90.00\n",
  );
  expect(descending.csv?.chain).toMatchObject({
    order: "newest-first",
    breakCount: 0,
    opening: "100.00",
    closing: { asOf: "2026-01-17", balance: "94.00" },
  });
});

test("a card statement whose balance shows what is owed as a positive number is flipped, with the evidence", () => {
  const text =
    "Date,Description,Amount,Balance\n01/15/2026,CHARGE,-40.00,40.00\n01/16/2026,CHARGE,-10.00,50.00\n01/17/2026,PAYMENT,20.00,30.00\n";
  const result = parse(text);
  expect(result.csv?.chain?.flipped).toBe(true);
  expect(result.lines.map(({ line }) => line.runningBalance)).toEqual([
    "-40.00",
    "-50.00",
    "-30.00",
  ]);
  expect(result.balances[0]?.balance).toBe("-30.00");
  expect(messages(result, "info").join(" ")).toContain("opposite way");
  // Told explicitly, it is not left to the arithmetic.
  const explicit = parse(text, {
    mapping: {
      headerRow: 1,
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
      balance: { header: "Balance" },
      invertBalance: false,
    },
  });
  expect(explicit.csv?.chain?.flipped).toBe(false);
  expect(explicit.csv?.chain?.breakCount).toBeGreaterThan(0);
});

test("the balance analysis is order-independent where it must be, and null where it cannot say", () => {
  const line = (date: string, amount: string, balance?: string, row = 1) => ({
    row,
    line: {
      kind: "bankLine" as const,
      provider: "csv" as const,
      accountKey: "k",
      rawIndex: row,
      postedOn: date,
      amount,
      currency: "USD",
      description: "x",
      ...(balance ? { runningBalance: balance } : {}),
    },
  });
  expect(analyzeBalances([])).toBeNull();
  expect(analyzeBalances([line("2026-01-01", "-1.00")])).toBeNull();
  const single = analyzeBalances([line("2026-01-01", "-1.00", "9.00")]);
  expect(single?.opening).toBe("10.00");
  expect(single?.closing).toEqual({ asOf: "2026-01-01", balance: "9.00" });
});

test("a large file's lines and balances stay consistent", () => {
  let text = "Date,Description,Amount,Balance\n";
  let balance = 100000n;
  const expected: string[] = [];
  for (let index = 0; index < 5000; index++) {
    const cents = BigInt((index * 7919) % 20001) - 10000n || 1n;
    balance += cents;
    const day = String((index % 28) + 1).padStart(2, "0");
    const month = String((Math.floor(index / 28) % 12) + 1).padStart(2, "0");
    text += `${month}/${day}/2026,Line ${index},${(Number(cents) / 100).toFixed(2)},${(Number(balance) / 100).toFixed(2)}\n`;
    expected.push(`${cents}`);
  }
  const result = parse(text, {
    mapping: {
      headerRow: 1,
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
      balance: { header: "Balance" },
    },
  });
  assertWellFormed(result);
  expect(result.lines).toHaveLength(5000);
  expect(result.csv?.chain?.breakCount).toBe(0);
  expect(result.lines.map(({ line }) => String(parseMoney(line.amount)))).toEqual(expected);
});

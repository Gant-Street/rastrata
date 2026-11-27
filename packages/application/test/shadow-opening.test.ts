import { expect, test } from "bun:test";
import { formatMoney, parseMoney } from "../src/money.ts";
import {
  MAX_JOURNAL_LINES,
  buildOpening,
  isCalendarDate,
  openingTotals,
  resolveOffset,
  sideOf,
  type OpeningAccount,
  type OpeningEntry,
  type OpeningRole,
} from "../src/shadow/opening.ts";
import { parseOpeningCsv } from "../src/shadow/opening-csv.ts";

/** A small deterministic generator so the property tests fail the same way every time. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const account = (
  code: string,
  name: string,
  role: OpeningRole,
  extra: Partial<OpeningAccount> = {},
): OpeningAccount => ({
  id: code,
  code,
  name,
  role,
  openedOn: "2026-01-01",
  closedOn: null,
  ...extra,
});

const CHART: readonly OpeningAccount[] = [
  account("1000", "Business checking", "asset"),
  account("1100", "Stripe balance", "asset"),
  account("1500", "Equipment", "asset"),
  account("2000", "Business credit card", "liability"),
  account("2100", "Sales tax payable", "liability"),
  account("3000", "Owner's investment", "equity"),
  account("3900", "Opening balance equity", "equity"),
  account("4000", "Sales", "income"),
  account("6000", "Software", "expense"),
];

const entry = (accountId: string, balance: string, row?: number): OpeningEntry => ({
  accountId,
  balance,
  ...(row !== undefined ? { row } : {}),
});
const build = (entries: OpeningEntry[], extra: Record<string, unknown> = {}) =>
  buildOpening({ cutoverDate: "2026-11-01", accounts: CHART, entries, ...extra });

test("balances are entered the way they are read, and every line is stated as a debit or a credit", () => {
  const result = build([
    entry("1000", "12000.00"),
    entry("2000", "523.10"),
    entry("1100", "1300.50"),
  ]);
  expect(result.valid).toBe(true);
  expect(result.lines.map((line) => [line.code, line.debit, line.credit])).toEqual([
    ["1000", "12000.00", "0.00"],
    ["1100", "1300.50", "0.00"],
    ["2000", "0.00", "523.10"],
  ]);
  // Debits 13,300.50 less credits 523.10: the offset carries 12,777.40 as a credit.
  expect(result.offset).toMatchObject({
    code: "3900",
    debit: "0.00",
    credit: "12777.40",
    chosen: false,
  });
  expect(result.totals).toEqual({
    enteredDebit: "13300.50",
    enteredCredit: "523.10",
    debit: "13300.50",
    credit: "13300.50",
    balanced: true,
  });
  // The journal is the lines in code order and the offset last, with an empty string for no amount.
  expect(result.journal).toEqual([
    { accountId: "1000", debit: "12000.00", credit: "" },
    { accountId: "1100", debit: "1300.50", credit: "" },
    { accountId: "2000", debit: "", credit: "523.10" },
    { accountId: "3900", debit: "", credit: "12777.40" },
  ]);
});

test("a negative balance is the unusual side: an overdrawn bank account and a card in credit", () => {
  const result = build([entry("1000", "-250.00"), entry("2000", "-40.00"), entry("3000", "10.00")]);
  const by = Object.fromEntries(result.lines.map((line) => [line.code, line]));
  expect(by["1000"]).toMatchObject({ debit: "0.00", credit: "250.00", side: "debit" });
  expect(by["2000"]).toMatchObject({ debit: "40.00", credit: "0.00", side: "credit" });
  expect(by["3000"]).toMatchObject({ debit: "0.00", credit: "10.00" });
  // Debits 40.00, credits 260.00: the offset is a debit of 220.00.
  expect(result.offset).toMatchObject({ debit: "220.00", credit: "0.00" });
  expect(result.totals.balanced).toBe(true);
});

test("balances that balance on their own need no offset, and an equity account may be entered", () => {
  const result = build([
    entry("1000", "1000.00"),
    entry("3000", "600.00"),
    entry("3900", "400.00"),
  ]);
  expect(result.valid).toBe(true);
  expect(result.offset).toBeNull();
  expect(result.totals).toMatchObject({ debit: "1000.00", credit: "1000.00", balanced: true });
  expect(result.issues.some((issue) => issue.code === "offset_carries_difference")).toBe(false);
});

test("the offset is calculated, never typed", () => {
  const result = build([entry("1000", "1000.00"), entry("3900", "100.00")]);
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain("offset_entered");
  // Naming another equity account as the offset makes the same entry valid.
  const fixed = build([entry("1000", "1000.00"), entry("3900", "100.00")], {
    offsetAccountId: "3000",
  });
  expect(fixed.valid).toBe(true);
  expect(fixed.offset).toMatchObject({ code: "3000", credit: "900.00", chosen: true });
});

test("the offset is found by its name, and refused when it cannot be told", () => {
  expect(resolveOffset(CHART, undefined)).toMatchObject({ account: { code: "3900" } });
  const twice = [...CHART, account("3950", "Opening Balances Equity (old)", "equity")];
  expect(resolveOffset(twice, undefined)).toMatchObject({
    problem: { code: "offset_ambiguous" },
  });
  const unnamed = CHART.filter((item) => item.code !== "3900");
  expect(resolveOffset(unnamed, undefined)).toMatchObject({ problem: { code: "offset_required" } });
  expect(
    resolveOffset(
      CHART.filter((item) => item.role !== "equity"),
      undefined,
    ),
  ).toMatchObject({
    problem: { code: "offset_required" },
  });
  expect(resolveOffset(CHART, "4000")).toMatchObject({ problem: { code: "offset_not_equity" } });
  expect(resolveOffset(CHART, "9999")).toMatchObject({ problem: { code: "offset_not_found" } });
  expect(resolveOffset(CHART, "3000")).toMatchObject({ account: { code: "3000" }, chosen: true });
});

test("the arithmetic is exact where a float is not, at any size", () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point.
  const small = build([entry("1000", "0.10"), entry("1100", "0.20"), entry("2000", "0.30")]);
  expect(small.valid).toBe(true);
  expect(small.offset).toBeNull();
  expect(small.totals).toMatchObject({ debit: "0.30", credit: "0.30", balanced: true });
  // Past 2^53 cents, one cent is still a cent.
  const big = build([entry("1000", "9007199254740993.01"), entry("2000", "0.01")]);
  expect(big.valid).toBe(true);
  expect(big.offset).toMatchObject({ credit: "9007199254740993.00" });
  expect(big.totals).toMatchObject({
    debit: "9007199254740993.01",
    credit: "9007199254740993.01",
    balanced: true,
  });
});

test("a line is never larger than a journal line can hold", () => {
  const huge = build([entry("1000", "9999999999999999.99"), entry("1100", "0.01")]);
  expect(huge.valid).toBe(false);
  expect(huge.issues.map((issue) => issue.code)).toContain("amount_too_large");
});

test("every problem names the account or the row and nothing throws", () => {
  const result = build([
    entry("9999", "5.00", 4),
    entry("1000", "10.00", 5),
    entry("1000", "20.00", 6),
    entry("1100", "5.0", 7),
    entry("1500", "0.00", 8),
  ]);
  expect(result.valid).toBe(false);
  const codes = result.issues.map((issue) => [issue.code, issue.row ?? null]);
  expect(codes).toContainEqual(["account_not_found", 4]);
  expect(codes).toContainEqual(["duplicate_account", 6]);
  expect(codes).toContainEqual(["amount_invalid", 7]);
  expect(result.zeroBalances).toBe(1);
  expect(result.journal).toEqual([]);
});

test("an account that is closed or not yet open cannot start with a balance", () => {
  const accounts = [
    ...CHART,
    account("1700", "Old savings", "asset", { closedOn: "2026-06-30" }),
    account("1800", "New savings", "asset", { openedOn: "2026-12-01" }),
  ];
  const result = buildOpening({
    cutoverDate: "2026-11-01",
    accounts,
    entries: [entry("1700", "5.00"), entry("1800", "5.00")],
  });
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["account_closed", "account_not_open"]),
  );
  // Closed after the cutover date is fine.
  const later = buildOpening({
    cutoverDate: "2026-11-01",
    accounts: [account("1700", "Old savings", "asset", { closedOn: "2026-12-31" }), ...CHART],
    entries: [entry("1700", "5.00")],
  });
  expect(later.valid).toBe(true);
});

test("the offset account is held to the same rule", () => {
  const accounts = CHART.map((item) =>
    item.code === "3900" ? { ...item, closedOn: "2026-06-30" } : item,
  );
  const result = buildOpening({
    cutoverDate: "2026-11-01",
    accounts,
    entries: [entry("1000", "5.00")],
  });
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain("account_closed");
});

test("an entry has a size limit, and an empty one is refused", () => {
  const many: OpeningAccount[] = [
    ...CHART,
    ...Array.from({ length: 120 }, (_, index) =>
      account(`7${String(index).padStart(3, "0")}`, `Expense ${index}`, "expense"),
    ),
  ];
  const entries = many
    .filter((item) => item.role === "expense")
    .map((item) => entry(item.id, "1.00"));
  const over = buildOpening({ cutoverDate: "2026-11-01", accounts: many, entries });
  expect(over.valid).toBe(false);
  expect(over.issues.map((issue) => issue.code)).toContain("too_many_lines");
  const within = buildOpening({
    cutoverDate: "2026-11-01",
    accounts: many,
    entries: entries.slice(0, MAX_JOURNAL_LINES - 1),
  });
  expect(within.valid).toBe(true);
  expect(within.journal).toHaveLength(MAX_JOURNAL_LINES);
  const none = build([]);
  expect(none.valid).toBe(false);
  expect(none.issues.map((issue) => issue.code)).toContain("nothing_to_post");
  expect(build([entry("1000", "0.00")]).issues.map((issue) => issue.code)).toContain(
    "nothing_to_post",
  );
});

test("a date that is not a calendar date is refused", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "", "2026-11-31"]) {
    expect(isCalendarDate(bad)).toBe(false);
    expect(
      buildOpening({
        cutoverDate: bad,
        accounts: CHART,
        entries: [entry("1000", "1.00")],
      }).issues.map((issue) => issue.code),
    ).toContain("date_invalid");
  }
  expect(isCalendarDate("2028-02-29")).toBe(true);
  expect(isCalendarDate("2027-02-29")).toBe(false);
});

test("year-to-date profit and loss balances are called out, and which way depends on the date", () => {
  const entries = [entry("1000", "1000.00"), entry("4000", "300.00"), entry("6000", "100.00")];
  const mid = build(entries, { calendar: { fiscalYearStart: false } });
  expect(mid.valid).toBe(true);
  expect(mid.issues.map((issue) => issue.code)).toContain("profit_loss_mid_year");
  const start = build(entries, { calendar: { fiscalYearStart: true } });
  expect(start.issues.map((issue) => issue.code)).toContain("profit_loss_at_year_start");
  expect(build([entry("1000", "10.00")], { calendar: { fiscalYearStart: true } }).issues).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ code: "profit_loss_at_year_start" })]),
  );
});

test("the journal always balances to the cent, for any balances", () => {
  const roll = random(7);
  for (let round = 0; round < 300; round++) {
    const entries: OpeningEntry[] = [];
    for (const item of CHART) {
      if (item.code === "3900" || roll() < 0.4) continue;
      const cents = BigInt(Math.floor(roll() * 10 ** 9)) * (roll() < 0.15 ? -1n : 1n);
      entries.push(entry(item.id, formatMoney(cents)));
    }
    const result = build(entries);
    if (!result.valid) continue;
    let debit = 0n;
    let credit = 0n;
    for (const line of result.journal) {
      debit += line.debit === "" ? 0n : parseMoney(line.debit);
      credit += line.credit === "" ? 0n : parseMoney(line.credit);
      // Each line is one side only.
      expect(line.debit === "" || line.credit === "").toBe(true);
    }
    expect(debit).toBe(credit);
    expect(result.totals.balanced).toBe(true);
    expect(parseMoney(result.totals.debit)).toBe(debit);
  }
});

test("the totals the browser shows come from the same arithmetic", () => {
  expect(
    openingTotals([
      { role: "asset", balance: "1000.00" },
      { role: "liability", balance: "250.50" },
      { role: "asset", balance: "bad" },
    ]),
  ).toEqual({ debit: "1000.00", credit: "250.50", net: "749.50" });
  expect(openingTotals([])).toEqual({ debit: "0.00", credit: "0.00", net: "0.00" });
  expect(sideOf("expense")).toBe("debit");
  expect(sideOf("income")).toBe("credit");
  expect(sideOf("gain")).toBe("credit");
});

// ---------------------------------------------------------------------------------------------
// CSV

const read = (text: string) => parseOpeningCsv(text, CHART);
const codes = (result: ReturnType<typeof read>) => result.issues.map((issue) => issue.code);

test("a CSV of codes and balances is read exactly", () => {
  const result = read('Code,Balance\n1000,"12,000.00"\n2000,(523.10)\n1100,1300.5\n');
  expect(result.entries).toEqual([
    { accountId: "1000", balance: "12000.00", row: 2 },
    { accountId: "2000", balance: "-523.10", row: 3 },
    { accountId: "1100", balance: "1300.50", row: 4 },
  ]);
  expect(result.headerRow).toBe(1);
  expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
});

test("debit and credit columns become balances in each account's orientation", () => {
  const result = read(
    "Account,Debit,Credit\nBusiness checking,1000.00,\nBusiness credit card,,523.10\nSales,,50.00\nSoftware,20.00,\n",
  );
  expect(result.entries.map((item) => [item.accountId, item.balance])).toEqual([
    ["1000", "1000.00"],
    ["2000", "523.10"],
    ["4000", "50.00"],
    ["6000", "20.00"],
  ]);
  // The same figures are a balanced trial balance: debits 1,020.00 and credits 573.10 need an offset
  // of 446.90, and they balance once it is added.
  const built = buildOpening({
    cutoverDate: "2026-11-01",
    accounts: CHART,
    entries: result.entries,
  });
  expect(built.totals.balanced).toBe(true);
});

test("headers are found under other names, after titles, with a byte order mark and other delimiters", () => {
  const text =
    "﻿Opening balances for Example Co;;\r\nAs at 31 October 2026;;\r\n\r\nAccount Code;Account Name;Closing Balance\r\n1000;Business checking;100,00\r\n";
  const result = read(text);
  // 100,00 uses a comma as the decimal, which the amount reader refuses in a US file.
  expect(codes(result)).toContain("amount_invalid");
  const us = read("Title\n\nAccount Number\tName\tAmount\n1000\tBusiness checking\t100.00\n");
  expect(us.entries).toEqual([{ accountId: "1000", balance: "100.00", row: 4 }]);
  expect(us.headerRow).toBe(3);
  expect(us.issues.map((issue) => issue.code)).toContain("rows_before_header");
});

test("an account is found by code or by name, and a code and name that disagree are refused", () => {
  const result = read(
    "Code,Name,Balance\n1000,Business checking,10.00\n1100,whatever I call it,20.00\n2000,Stripe balance,30.00\n,business   CREDIT card,40.00\n9999,,50.00\n",
  );
  expect(result.entries.map((item) => item.accountId)).toEqual(["1000", "1100", "2000"]);
  expect(result.entries.map((item) => item.accountId)).not.toContain("9999");
  expect(codes(result)).toEqual(expect.arrayContaining(["account_mismatch", "account_unknown"]));
});

test("a name that matches two accounts is refused, never guessed", () => {
  const twins = [...CHART, account("1010", "Business checking", "asset")];
  const result = parseOpeningCsv("Name,Balance\nBusiness checking,10.00\n", twins);
  expect(result.entries).toEqual([]);
  expect(result.issues.map((issue) => issue.code)).toContain("account_ambiguous");
  expect(parseOpeningCsv("Code,Balance\n1010,10.00\n", twins).entries).toHaveLength(1);
});

test("rows that cannot be read are errors on their row, and never rounded", () => {
  const result = read(
    "Code,Debit,Credit\n1000,10.005,\n1100,5.00,5.00\n1500,-5.00,\n2000,abc,\n2100,,7.00\n,5.00,\n",
  );
  expect(result.entries.map((item) => item.accountId)).toEqual(["2100"]);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  expect(errors.map((issue) => [issue.code, issue.row])).toEqual([
    ["amount_invalid", 2],
    ["both_sides", 3],
    ["negative_in_side_column", 4],
    ["amount_invalid", 5],
    ["account_missing", 7],
  ]);
  // The message says why, plainly, and quotes the cell.
  expect(errors[0]?.message).toContain("more than two decimal places");
});

test("a total row and blank rows are skipped", () => {
  const result = read("Code,Debit,Credit\n1000,100.00,\n\n,,\nTotal,100.00,\n2000,,\n");
  expect(result.entries).toEqual([{ accountId: "1000", balance: "100.00", row: 2 }]);
  expect(codes(result)).toEqual(expect.arrayContaining(["total_row_skipped", "blank_amounts"]));
});

test("a file that is not opening balances says what it needs", () => {
  expect(codes(read(""))).toEqual(["csv_empty"]);
  expect(codes(read("   \n"))).toEqual(["csv_empty"]);
  expect(codes(read("hello,world\n1,2\n"))).toEqual(["csv_no_header"]);
  expect(codes(read("Code,Balance\n"))).toEqual(["csv_no_rows"]);
});

test("hostile cells are quoted, bounded and never acted on", () => {
  const formula = `=HYPERLINK("http://example.invalid")`;
  const long = "x".repeat(5000);
  const result = read(
    `Code,Name,Balance\n${formula},,5.00\n,"${long}",5.00\n1000,"‮evil\u0007",1.00\n`,
  );
  const messages = result.issues.map((issue) => issue.message).join("\n");
  // The cell appears quoted and cut; the control and direction characters are made visible.
  expect(messages).toContain('"=HYPERLINK(');
  expect(messages).not.toContain(long);
  expect(messages.length).toBeLessThan(2000);
  expect(messages).not.toContain("‮");
  expect(messages).not.toContain("\u0007");
  // The code picks the account; the hostile name is only ever shown quoted.
  expect(result.entries).toEqual([{ accountId: "1000", balance: "1.00", row: 4 }]);
  expect(codes(result)).toContain("label_differs");
});

test("a file with a huge number of rows is refused before it is walked", () => {
  const rows = Array.from({ length: 2100 }, (_, index) => `${1000 + (index % 5)},1.00`).join("\n");
  expect(codes(read(`Code,Balance\n${rows}`))).toEqual(["csv_too_long"]);
});

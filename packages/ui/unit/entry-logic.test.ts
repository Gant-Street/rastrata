import { expect, test } from "bun:test";
import {
  entryAmountProblem,
  blankEntryLine,
  entryIds,
  entryProblems,
  entryTotals,
  normalizeEntryAmount,
  normalizedEntryLines,
} from "../src/accounting/entry-logic";

test("an amount typed any of the usual ways reads as the two-decimal form the service takes", () => {
  expect(normalizeEntryAmount("100")).toBe("100.00");
  expect(normalizeEntryAmount("100.")).toBe("100.00");
  expect(normalizeEntryAmount("100.5")).toBe("100.50");
  expect(normalizeEntryAmount("100.55")).toBe("100.55");
  expect(normalizeEntryAmount("1,000.5")).toBe("1000.50");
  expect(normalizeEntryAmount(" 12 ")).toBe("12.00");
  expect(normalizeEntryAmount(".5")).toBe("0.50");
  expect(normalizeEntryAmount("0")).toBe("0.00");
  expect(normalizeEntryAmount("007.1")).toBe("7.10");
  expect(normalizeEntryAmount("$12")).toBe("12.00");
  expect(normalizeEntryAmount("£1,250.75")).toBe("1250.75");
  expect(normalizeEntryAmount("")).toBe("");
});

test("text that is not an amount is not guessed at, and says what is wrong", () => {
  for (const text of ["abc", "12.345", "1e5", "12..5", "--3", "1 2 3 a", "12345678901234567"])
    expect(normalizeEntryAmount(text)).toBeUndefined();
  expect(entryAmountProblem("12.345")).toBe("Use at most two decimal places.");
  expect(entryAmountProblem("-5")).toBe(
    "Enter a positive amount. Use the other column for money going the other way.",
  );
  expect(entryAmountProblem("abc")).toBe("Enter an amount such as 125.50.");
  // Nothing is wrong with an empty box or one that reads.
  expect(entryAmountProblem("")).toBeUndefined();
  expect(entryAmountProblem("100")).toBeUndefined();
});

test("the lines are sent in the form the service takes, and an unfinished one is left as typed", () => {
  expect(
    normalizedEntryLines([
      { accountId: "a", debit: "100", credit: "" },
      { accountId: "b", debit: "", credit: "1,000.5" },
      { accountId: "c", debit: "12.345", credit: "" },
    ]),
  ).toEqual([
    { accountId: "a", debit: "100.00", credit: "" },
    { accountId: "b", debit: "", credit: "1000.50" },
    { accountId: "c", debit: "12.345", credit: "" },
  ]);
});

test("the bar's totals are exact, the difference is never negative, and a bad amount has no totals", () => {
  expect(
    entryTotals([
      { accountId: "a", debit: "100", credit: "" },
      { accountId: "b", debit: "", credit: "100.00" },
    ]),
  ).toEqual({ debit: "100.00", credit: "100.00", difference: "0.00", balanced: true });
  expect(
    entryTotals([
      { accountId: "a", debit: "0.10", credit: "" },
      { accountId: "b", debit: "0.20", credit: "" },
      { accountId: "c", debit: "", credit: "0.31" },
    ]),
  ).toEqual({ debit: "0.30", credit: "0.31", difference: "0.01", balanced: false });
  expect(
    entryTotals([
      { accountId: "a", debit: "", credit: "50" },
      { accountId: "b", debit: "20", credit: "" },
    ])?.difference,
  ).toBe("30.00");
  expect(entryTotals([{ accountId: "a", debit: "12.345", credit: "" }])).toBeNull();
  expect(entryTotals([blankEntryLine(), blankEntryLine()])?.balanced).toBe(true);
});

const good = [
  { accountId: "cash", debit: "100", credit: "" },
  { accountId: "sales", debit: "", credit: "100.00" },
];

test("a balanced entry with a date and a description has nothing in its way", () => {
  expect(
    entryProblems({ date: "2026-03-20", description: "Sale", lines: good, purpose: "post" }),
  ).toEqual([]);
});

test("a draft needs a date, an account on every line and amounts that read, and nothing more", () => {
  expect(
    entryProblems({
      date: "2026-03-20",
      description: "",
      lines: [
        { accountId: "cash", debit: "100", credit: "" },
        { accountId: "sales", debit: "", credit: "" },
      ],
      purpose: "draft",
    }),
  ).toEqual([]);
  expect(
    entryProblems({
      date: "",
      description: "",
      lines: [
        { accountId: "", debit: "100", credit: "" },
        { accountId: "sales", debit: "x", credit: "" },
      ],
      purpose: "draft",
    }).map((problem) => problem.message),
  ).toEqual([
    "Enter a date.",
    "Line 1: Choose an account.",
    "Line 2: Enter an amount such as 125.50.",
  ]);
});

test("posting names what is wrong, line by line, with the control to go to", () => {
  const problems = entryProblems({
    date: "2026-03-20",
    description: " ",
    lines: [
      { accountId: "", debit: "100", credit: "" },
      { accountId: "sales", debit: "50", credit: "20" },
      { accountId: "sales", debit: "", credit: "" },
      { accountId: "sales", debit: "0.00", credit: "" },
    ],
    purpose: "post",
  });
  expect(problems).toEqual([
    { id: entryIds.description, message: "Enter a description.", short: "Enter a description." },
    { id: entryIds.account(0), message: "Line 1: Choose an account.", short: "Choose an account." },
    {
      id: entryIds.debit(1),
      message: "Line 2: Use a debit or a credit, not both.",
      short: "Use a debit or a credit, not both.",
    },
    {
      id: entryIds.debit(2),
      message: "Line 3: Enter a debit or a credit.",
      short: "Enter a debit or a credit.",
    },
    {
      id: entryIds.debit(3),
      message: "Line 4: Enter an amount above zero.",
      short: "Enter an amount above zero.",
    },
  ]);
});

test("an entry that does not balance says by how much, and one with a single amount needs another", () => {
  expect(
    entryProblems({
      date: "2026-03-20",
      description: "Sale",
      lines: [
        { accountId: "cash", debit: "1250.5", credit: "" },
        { accountId: "sales", debit: "", credit: "1000" },
      ],
      purpose: "post",
    }),
  ).toEqual([
    {
      id: entryIds.debit(0),
      message: "The entry is out of balance by 250.50. Debits and credits must be equal.",
      short: "The entry is out of balance by 250.50. Debits and credits must be equal.",
    },
  ]);
  expect(
    entryProblems({
      date: "2026-03-20",
      description: "Sale",
      lines: [
        { accountId: "cash", debit: "100", credit: "" },
        { accountId: "sales", debit: "0.00", credit: "0.00" },
      ],
      purpose: "post",
    }).map((problem) => problem.message),
  ).toEqual(["Line 2: Enter an amount above zero."]);
});

test("the ids a problem points at follow the lines", () => {
  expect(entryIds.account(0)).toBe("entry-line-1-account");
  expect(entryIds.debit(2)).toBe("entry-line-3-debit");
  expect(entryIds.credit(1)).toBe("entry-line-2-credit");
});

test("a source event that is named must be described", () => {
  const base = { date: "2026-03-20", description: "Sale", lines: good, purpose: "post" } as const;
  expect(entryProblems({ ...base, source: { id: "inv-1", description: " " } })).toEqual([
    {
      id: entryIds.sourceDescription,
      message: "The source of this entry has no description.",
      short: "The source of this entry has no description.",
    },
  ]);
  expect(entryProblems({ ...base, source: { id: "", description: "" } })).toEqual([]);
  expect(entryProblems({ ...base, source: { id: "inv-1", description: "Invoice 1" } })).toEqual([]);
});

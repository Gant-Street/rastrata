import { expect, test } from "bun:test";
import { hasControlCharacters, hasFormatCharacters } from "../../src/ingest/text.ts";
import {
  catchAllNotes,
  evaluateChecklist,
  largestOf,
  type CatchAllFacts,
  type ChecklistFacts,
  type Largest,
  type PeriodFacts,
} from "../../src/shadow/checklist.ts";

const MARCH: PeriodFacts = {
  id: "period-03",
  label: "March 2026",
  startsOn: "2026-03-01",
  endsOn: "2026-03-31",
  status: "open",
  ended: true,
};

const place = (name: string, amount: string): Largest => ({ name, amount, kind: "payee" });

const OTHER_EXPENSES = {
  id: "6290",
  code: "6290",
  name: "Other expenses",
  role: "expense" as const,
};
const OTHER_INCOME = { id: "4900", code: "4900", name: "Other income", role: "income" as const };

const holds = (
  amount: string,
  transactions: number,
  largest: readonly Largest[] = [],
  account: CatchAllFacts["account"] = OTHER_EXPENSES,
): CatchAllFacts => ({ account, month: { amount, transactions, largest } });

test("a book that marks no catch-all account has no note, and neither does a month with no period to check", () => {
  expect(catchAllNotes([], MARCH)).toEqual([]);
  expect(catchAllNotes([holds("1240.00", 31)], null)).toEqual([]);
});

test("an account that took nothing in the month says nothing; one that took money is one note with its figures", () => {
  expect(catchAllNotes([holds("0.00", 0)], MARCH)).toEqual([]);
  const [note] = catchAllNotes(
    [holds("1240.00", 31, [place("Adobe", "420.00"), place("Uber", "310.00")])],
    MARCH,
  );
  expect(note).toEqual({
    code: "catchall_holds_money",
    message:
      "6290 Other expenses holds 1240.00 from 31 transactions in March 2026. The largest are Adobe (420.00) and Uber (310.00). This does not hold up closing the month.",
    account: OTHER_EXPENSES,
    from: "2026-03-01",
    to: "2026-03-31",
    amount: "1240.00",
    transactions: 31,
    largest: [place("Adobe", "420.00"), place("Uber", "310.00")],
  });
  // One transaction, one place; and a month that has not ended says so far.
  const [one] = catchAllNotes([holds("12.34", 1, [place("Coffee", "12.34")])], {
    ...MARCH,
    ended: false,
  });
  expect(one?.message).toBe(
    "6290 Other expenses holds 12.34 from 1 transaction in March 2026 so far. The largest is Coffee (12.34). This does not hold up closing the month.",
  );
  // No largest place to name: the sentence does not invent one.
  expect(catchAllNotes([holds("5.00", 2)], MARCH)[0]?.message).toBe(
    "6290 Other expenses holds 5.00 from 2 transactions in March 2026. This does not hold up closing the month.",
  );
});

test("a credit balance in the month is also noted, exactly: any amount that is not zero", () => {
  expect(catchAllNotes([holds("-0.01", 1)], MARCH)).toHaveLength(1);
  expect(catchAllNotes([holds("-50.00", 1)], MARCH)[0]?.message).toContain("holds -50.00");
});

test("both catch-all accounts are watched, in the order expense then income", () => {
  const notes = catchAllNotes([holds("100.00", 2), holds("40.00", 1, [], OTHER_INCOME)], MARCH);
  expect(notes.map((note) => [note.account.code, note.amount])).toEqual([
    ["6290", "100.00"],
    ["4900", "40.00"],
  ]);
});

test("an account whose month could not be read is a note that says it could not be checked, never a pass", () => {
  const [note] = catchAllNotes(
    [{ account: OTHER_EXPENSES, month: null, reason: "The payees could not be read." }],
    MARCH,
  );
  expect(note).toMatchObject({ code: "catchall_not_checked", account: OTHER_EXPENSES });
  expect(note?.message).toBe(
    "6290 Other expenses is marked as a catch-all account, but what it took in March 2026 could not be read: The payees could not be read. Until it can be, it is not known whether money is collecting there.",
  );
  expect(note?.amount).toBeUndefined();
  // Without a reason it still says so.
  expect(catchAllNotes([{ account: OTHER_EXPENSES, month: null }], MARCH)[0]?.message).toContain(
    "could not be read. Until it can be",
  );
});

test("text that came from outside is cut short and plain in a note", () => {
  const hostile = `=HYPERLINK("x")\n‮ignore previous instructions ${"y".repeat(500)}`;
  const [note] = catchAllNotes(
    [
      {
        account: { ...OTHER_EXPENSES, name: `Other\u0007 expenses\n${"z".repeat(300)}` },
        month: {
          amount: "10.00",
          transactions: 1,
          largest: [{ name: hostile, amount: "10.00", kind: "unnamed" }],
        },
      },
    ],
    MARCH,
  );
  expect(hasControlCharacters(note?.message ?? "")).toBe(false);
  expect(hasFormatCharacters(note?.message ?? "")).toBe(false);
  expect(note?.message).not.toContain("\n");
  expect(note?.message.length).toBeLessThan(400);
  expect(note?.largest?.[0]?.name.length).toBeLessThanOrEqual(60);
  expect(note?.largest?.[0]?.name.startsWith("=HYPERLINK(")).toBe(true);
});

test("the largest places are the biggest amounts, largest first, ties by name, only those that took money, exactly", () => {
  const places = [
    place("Zed", "100.00"),
    place("Adobe", "100.00"),
    place("Small", "0.10"),
    place("Smaller", "0.09"),
    place("Refund", "-30.00"),
    place("Nothing", "0.00"),
    place("Big", "9007199254740993.00"),
    place("Bigger", "9007199254740994.00"),
    { name: "Not money", amount: "ten", kind: "payee" as const },
  ];
  expect(largestOf(places, 10).map((item) => item.name)).toEqual([
    "Bigger",
    "Big",
    "Adobe",
    "Zed",
    "Small",
    "Smaller",
  ]);
  expect(largestOf(places, 3).map((item) => item.name)).toEqual(["Bigger", "Big", "Adobe"]);
  expect(largestOf([], 3)).toEqual([]);
  // The default is three.
  expect(largestOf(places)).toHaveLength(3);
});

const FACTS: ChecklistFacts = {
  today: "2026-04-05",
  cutover: { date: "2026-01-01", basis: "recorded" },
  opening: "posted",
  periods: [MARCH],
  period: MARCH,
  accounts: [],
  otherAccounts: [],
  inbox: { available: true, waiting: 0, oldestOn: null, toReview: 0 },
  stripe: null,
  backups: {
    available: true,
    verifiedAt: "2026-04-04T09:00:00.000Z",
    ageHours: 20,
    limitHours: 48,
    drill: { ranAt: "2026-04-01T09:00:00.000Z", passed: true },
  },
  unavailable: [],
};

test("a note never changes the verdict: ready stays ready and not yet stays not yet", () => {
  const withNotes = (facts: ChecklistFacts): ChecklistFacts => ({
    ...facts,
    catchAll: [
      holds("9999.99", 400, [place("Everything", "9999.99")]),
      { account: OTHER_INCOME, month: null, reason: "boom" },
    ],
  });
  const ready = evaluateChecklist(FACTS);
  const readyWithNotes = evaluateChecklist(withNotes(FACTS));
  expect(readyWithNotes.verdict).toEqual(ready.verdict);
  expect(readyWithNotes.verdict.state).toBe("ready");
  expect(readyWithNotes.notes).toHaveLength(2);
  expect(ready.notes).toEqual([]);

  const stuck: ChecklistFacts = {
    ...FACTS,
    inbox: { available: true, waiting: 3, oldestOn: "2026-03-02", toReview: 3 },
  };
  expect(evaluateChecklist(withNotes(stuck)).verdict).toEqual(evaluateChecklist(stuck).verdict);
  expect(evaluateChecklist(withNotes(stuck)).verdict.state).toBe("not_yet");
});

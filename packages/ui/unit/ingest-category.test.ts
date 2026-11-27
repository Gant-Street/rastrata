import { expect, test } from "bun:test";
import { setShowsAccountNumbers } from "../src/entries/display";
import { categoryOf, effectOf, nameOfAccount } from "../src/ingest/category";
import type { AccountOption, InboxItemView } from "../src/ingest/types";

// The list says where a transaction goes in one phrase, from the suggestion while it waits and from the
// decision once it has moved on; the pane says what an entry does to each account in plain words.

const accounts: AccountOption[] = [
  { value: "1000", label: "Checking", code: "1000", group: "Assets", role: "asset" },
  { value: "1100", label: "Savings", code: "1100", group: "Assets", role: "asset" },
  { value: "4000", label: "Sales", code: "4000", group: "Income", role: "income" },
  { value: "5000", label: "Software", code: "5000", group: "Expenses", role: "expense" },
  { value: "5100", label: "Meals", code: "5100", group: "Expenses", role: "expense" },
  { value: "2000", label: "Card", group: "Liabilities", role: "liability" },
];
const name = (id: string) => nameOfAccount(accounts, id);

const item = (patch: Partial<InboxItemView> & { amount?: string } = {}): InboxItemView => {
  const { amount = "-12.00", ...rest } = patch;
  return {
    id: "it_1",
    status: "proposed",
    ledgerAccountId: "1000",
    batchId: "b",
    flags: [],
    proposalCount: 1,
    ingestedAt: "2026-03-20T00:00:00.000Z",
    line: {
      kind: "bankLine",
      provider: "csv",
      accountKey: "csv:1000",
      rawIndex: 1,
      date: "2026-03-20",
      amount,
      currency: "USD",
      description: "GITHUB",
    },
    ...rest,
  };
};
const suggestion = (
  kind: "categorize" | "transfer" | "match" | "exclude" | "event",
  legs?: { accountId: string; amount: string }[],
) => ({
  proposalId: "p1",
  proposer: "rule:1",
  kind,
  confidence: 100,
  reason: "x",
  ...(legs ? { legs } : {}),
});

test("an account is known by its name, with its number first only when the owner asked for numbers", () => {
  expect(nameOfAccount(accounts, "5000")).toBe("Software");
  setShowsAccountNumbers(true);
  try {
    expect(nameOfAccount(accounts, "5000")).toBe("5000 · Software");
    // An account with no number is just its name.
    expect(nameOfAccount(accounts, "2000")).toBe("Card");
  } finally {
    setShowsAccountNumbers(false);
  }
  // One the chart does not list is shown as what identifies it.
  expect(nameOfAccount(accounts, "9999")).toBe("9999");
});

test("a categorize suggestion names the one account the money goes to, leaving the line's own out", () => {
  const row = item({
    suggestion: suggestion("categorize", [
      { accountId: "1000", amount: "-12.00" },
      { accountId: "5000", amount: "12.00" },
    ]),
  });
  expect(categoryOf(row, name)).toEqual({ kind: "account", names: ["Software"] });
});

test("several accounts are a split, in the order the suggestion gives them", () => {
  const row = item({
    suggestion: suggestion("categorize", [
      { accountId: "1000", amount: "-100.00" },
      { accountId: "5000", amount: "60.01" },
      { accountId: "5100", amount: "39.99" },
    ]),
  });
  expect(categoryOf(row, name)).toEqual({ kind: "split", names: ["Software", "Meals"] });
});

test("a transfer names the other account and which way the money went", () => {
  const out = item({
    amount: "-500.00",
    suggestion: suggestion("transfer", [
      { accountId: "1000", amount: "-500.00" },
      { accountId: "1100", amount: "500.00" },
    ]),
  });
  expect(categoryOf(out, name)).toEqual({ kind: "transfer", names: ["Savings"], direction: "to" });
  const into = item({
    amount: "500.00",
    ledgerAccountId: "1100",
    suggestion: suggestion("transfer", [
      { accountId: "1100", amount: "500.00" },
      { accountId: "1000", amount: "-500.00" },
    ]),
  });
  expect(categoryOf(into, name)).toEqual({
    kind: "transfer",
    names: ["Checking"],
    direction: "from",
  });
});

test("a match, a set-aside and a provider's own entry say what they are, not an account", () => {
  expect(categoryOf(item({ suggestion: suggestion("match") }), name).kind).toBe("match");
  expect(categoryOf(item({ suggestion: suggestion("exclude") }), name).kind).toBe("exclude");
  const payout = item({
    ledgerAccountId: null,
    suggestion: suggestion("event"),
    line: { ...item().line, kind: "event", provider: "stripe" },
  });
  expect(categoryOf(payout, name).kind).toBe("event");
});

test("a transaction with nothing suggested has no category yet", () => {
  expect(categoryOf(item({ status: "new" }), name)).toEqual({ kind: "none", names: [] });
});

test("once it is drafted or posted the category comes from the decision, and a suggestion no longer counts", () => {
  const drafted = item({
    status: "drafted",
    decision: {
      kind: "categorize",
      by: "owner",
      at: "2026-03-20T00:00:00.000Z",
      legs: [
        { accountId: "1000", amount: "-12.00" },
        { accountId: "5100", amount: "12.00" },
      ],
    },
    // A stale suggestion left on the row is not what was decided.
    suggestion: suggestion("categorize", [
      { accountId: "1000", amount: "-12.00" },
      { accountId: "5000", amount: "12.00" },
    ]),
  });
  expect(categoryOf(drafted, name)).toEqual({ kind: "account", names: ["Meals"] });
  const matched = item({
    status: "posted",
    decision: { kind: "match", by: "journal-match", at: "2026-03-20T00:00:00.000Z" },
  });
  expect(categoryOf(matched, name).kind).toBe("match");
});

test("an entry says what it does to each account as its balance moves, whichever side of the books", () => {
  // Money received into checking from a sale: checking up, sales up.
  expect(effectOf("498.75", "asset")).toBe("498.75");
  expect(effectOf("-498.75", "income")).toBe("498.75");
  // Money spent on software: software up (a debit), checking down (a credit).
  expect(effectOf("25.00", "expense")).toBe("25.00");
  expect(effectOf("-25.00", "asset")).toBe("-25.00");
  // A card charge raises what is owed (a credit to a liability), and paying it lowers it.
  expect(effectOf("-50.00", "liability")).toBe("50.00");
  expect(effectOf("50.00", "liability")).toBe("-50.00");
  // An account whose role is not known keeps the ledger's sign.
  expect(effectOf("-7.00", undefined)).toBe("-7.00");
});

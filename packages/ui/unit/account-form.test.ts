import { expect, test } from "bun:test";
import {
  addSentence,
  newAccountRequest,
  newAccountTags,
  editAccountProblems,
  editSentence,
  hasAccountProblems,
  newAccountProblems,
  type NewAccountValues,
} from "../src/chart/account-form";

const accounts = [
  { code: "1000", name: "Business checking" },
  { code: "6200", name: "Software and subscriptions" },
];
const values = (patch: Partial<NewAccountValues> = {}): NewAccountValues => ({
  name: "Software",
  kind: "expense",
  code: "6300",
  parentId: "",
  effectiveOn: "2026-03-21",
  cashFlowClass: "",
  taxLine: "",
  roleKey: "",
  ...patch,
});

test("a complete form has nothing to say, and the footer says what adding will do", () => {
  const problems = newAccountProblems(values(), accounts);
  expect(hasAccountProblems(problems)).toBe(false);
  // The date it starts on is the field under Advanced, never part of the sentence.
  expect(addSentence(values(), problems)).toBe("This adds 6300 Software as an Expense.");
  expect(addSentence(values({ kind: "bank", code: "1020", name: "Savings" }), {})).toBe(
    "This adds 1020 Savings as a Bank account.",
  );
  expect(addSentence(values({ kind: "income", code: "4100", name: "Consulting" }), {})).toBe(
    "This adds 4100 Consulting as Income.",
  );
});

test("what is missing or wrong is said by field, and a taken code names who has it", () => {
  expect(newAccountProblems(values({ name: " ", code: "", effectiveOn: "" }), accounts)).toEqual({
    name: "Enter a name.",
    code: "Enter a code.",
    effectiveOn: "Enter a date.",
  });
  expect(newAccountProblems(values({ code: "6" }), accounts).code).toBe(
    "Use letters, digits, hyphens or underscores, from 2 to 20 characters.",
  );
  expect(newAccountProblems(values({ code: "6200" }), accounts).code).toBe(
    "6200 is already used by Software and subscriptions.",
  );
  expect(newAccountProblems(values({ code: "bank-1000" }), accounts).code).toBeUndefined();
  expect(newAccountProblems(values({ roleKey: "Stripe Balance" }), accounts).roleKey).toBe(
    "Use lower-case words joined by dots, such as stripe.balance.",
  );
  // Until the form is complete the footer asks for what is missing instead of a sentence about nothing.
  expect(
    addSentence(values({ name: "" }), newAccountProblems(values({ name: "" }), accounts)),
  ).toBe("Enter a name and a code to see what this adds.");
});

test("the request is the type, the code, the name, the parent and the date", () => {
  expect(
    newAccountRequest(values({ name: " Software ", code: " 6300 ", parentId: "ops" })),
  ).toEqual({
    code: "6300",
    name: "Software",
    role: "expense",
    parentId: "ops",
    effectiveOn: "2026-03-21",
  });
  expect(newAccountRequest(values({ kind: "card", code: "2010", name: "Visa" })).role).toBe(
    "liability",
  );
  expect(newAccountRequest(values({ kind: "bank", code: "1020", name: "Savings" })).role).toBe(
    "asset",
  );
});

test("the tags follow the kind: cash flow for the balance sheet, a tax line for income and expense", () => {
  // A bank account is cash, a card is operating, unless the person chose another class.
  // The kind itself is kept too, so Home, Reconcile and the statement import know a bank account or a card.
  expect(newAccountTags(values({ kind: "bank" }))).toEqual({ kind: "bank", cashFlowClass: "cash" });
  expect(newAccountTags(values({ kind: "card" }))).toEqual({
    kind: "card",
    cashFlowClass: "operating",
  });
  expect(newAccountTags(values({ kind: "card", cashFlowClass: "financing" }))).toEqual({
    kind: "card",
    cashFlowClass: "financing",
  });
  expect(newAccountTags(values({ kind: "asset" }))).toEqual({});
  expect(newAccountTags(values({ kind: "expense", taxLine: "scheduleC.line18" }))).toEqual({
    taxLine: "scheduleC.line18",
  });
  // A tax line is not kept for a balance sheet account, nor a cash-flow class for an expense.
  expect(newAccountTags(values({ kind: "equity", taxLine: "scheduleC.line18" }))).toEqual({});
  expect(newAccountTags(values({ kind: "expense", cashFlowClass: "cash" }))).toEqual({});
  expect(newAccountTags(values({ roleKey: " stripe.balance " }))).toEqual({
    roleKey: "stripe.balance",
  });
});

test("an edit needs a name and a date, and something to change", () => {
  const current = { name: "Software" };
  expect(
    editAccountProblems({ name: "Software", close: false, effectiveOn: "2026-03-21" }, current),
  ).toEqual({ nothing: "Change the name, or close the account." });
  expect(editAccountProblems({ name: " ", close: false, effectiveOn: "" }, current)).toEqual({
    name: "Enter a name.",
    effectiveOn: "Enter a date.",
  });
  expect(
    editAccountProblems({ name: "Software", close: true, effectiveOn: "2026-03-21" }, current),
  ).toEqual({});
});

test("the edit form says what it will do", () => {
  const current = { name: "Software" };
  const sentence = (name: string, close: boolean) => {
    const edit = { name, close, effectiveOn: "2026-03-21" };
    return editSentence(edit, current, editAccountProblems(edit, current));
  };
  expect(sentence("Software and subscriptions", false)).toBe(
    "This renames Software to Software and subscriptions, starting Mar 21, 2026.",
  );
  expect(sentence("Software", true)).toBe("This closes Software on Mar 21, 2026.");
  expect(sentence("Apps", true)).toBe(
    "This renames Software to Apps and closes it on Mar 21, 2026.",
  );
  expect(sentence("Software", false)).toBe("Change the name, or close the account.");
});

import { expect, test } from "bun:test";
import { kindFacts, kindOfAccount, suggestCode } from "../src/chart/account-kinds";

const chart = [
  { code: "1000", role: "asset" },
  { code: "1010", role: "asset" },
  { code: "1100", role: "asset" },
  { code: "1500", role: "asset" },
  { code: "2000", role: "liability" },
  { code: "3000", role: "equity" },
  { code: "3100", role: "equity" },
  { code: "4000", role: "income" },
  { code: "5000", role: "expense" },
  { code: "6200", role: "expense" },
  { code: "6290", role: "expense" },
];

test("a bank account is an asset the cash flow calls cash, and a card a liability it calls operating", () => {
  expect(kindFacts("bank")).toEqual({ role: "asset", cashFlowClass: "cash", kind: "bank" });
  expect(kindFacts("card")).toEqual({
    role: "liability",
    cashFlowClass: "operating",
    kind: "card",
  });
  expect(kindFacts("income")).toEqual({ role: "income" });
  expect(kindFacts("expense")).toEqual({ role: "expense" });
});

test("a list reads an account by its kind tag, else an asset tagged cash as a bank account, else by its type", () => {
  expect(kindOfAccount({ role: "asset", tags: { cashFlowClass: "cash" } })).toBe("bank");
  expect(kindOfAccount({ role: "asset", tags: { cashFlowClass: "cash", kind: "bank" } })).toBe(
    "bank",
  );
  expect(kindOfAccount({ role: "asset", tags: {} })).toBe("asset");
  expect(kindOfAccount({ role: "liability", tags: { cashFlowClass: "operating" } })).toBe(
    "liability",
  );
  expect(
    kindOfAccount({ role: "liability", tags: { cashFlowClass: "operating", kind: "card" } }),
  ).toBe("card");
  // A tag that does not fit the type is not believed.
  expect(kindOfAccount({ role: "asset", tags: { kind: "card" } })).toBe("asset");
  expect(kindOfAccount({ role: "income", tags: {} })).toBe("income");
});

test("a new account is offered the next free code in its own range", () => {
  // The setup's ranges for banks and cards.
  expect(suggestCode(chart, "bank")).toBe("1020");
  expect(suggestCode(chart, "card")).toBe("2010");
  // Any other kind goes on from the highest code its type has, in tens.
  expect(suggestCode(chart, "expense")).toBe("6300");
  expect(suggestCode(chart, "asset")).toBe("1510");
  expect(suggestCode(chart, "equity")).toBe("3110");
  expect(suggestCode(chart, "income")).toBe("4010");
  expect(suggestCode(chart, "liability")).toBe("2010");
});

test("a type with no accounts yet starts where a chart usually numbers it", () => {
  expect(suggestCode([], "asset")).toBe("1100");
  expect(suggestCode([], "liability")).toBe("2100");
  expect(suggestCode([], "equity")).toBe("3000");
  expect(suggestCode([], "income")).toBe("4000");
  expect(suggestCode([], "expense")).toBe("6000");
  expect(suggestCode([], "bank")).toBe("1000");
});

test("a code that is taken is skipped, and codes that are not numbers are ignored", () => {
  expect(
    suggestCode(
      [
        { code: "6000", role: "expense" },
        { code: "6010", role: "expense" },
        { code: "6010", role: "expense" },
        { code: "TRAVEL", role: "expense" },
      ],
      "expense",
    ),
  ).toBe("6020");
  expect(
    suggestCode(
      [
        { code: "6000", role: "expense" },
        { code: "6010", role: "asset" },
      ],
      "expense",
    ),
  ).toBe("6020");
});

import { expect, test } from "bun:test";
import { ENTRY_ACTIONS } from "../../src/routes/entries/actions";
import { actionHits } from "../../src/search/builtin";

test("+ New lists Transaction, and its three kinds are for Search, each with a dialog of its own id", () => {
  expect(
    ENTRY_ACTIONS.map((action) => [action.id, action.label, action.order, action.searchOnly]),
  ).toEqual([
    ["transaction", "Transaction", 10, undefined],
    ["spend", "Spend money", 20, true],
    ["receive", "Receive money", 25, true],
    ["transfer", "Transfer", 30, true],
  ]);
  for (const action of ENTRY_ACTIONS) expect(action.dialog).toBe(action.id);
});

test("Search finds each by the plain words people use for it, and the owner's two cases by what they say", () => {
  const first = (query: string) => actionHits(ENTRY_ACTIONS, query)[0]?.id;
  expect(first("spend")).toBe("spend");
  expect(first("transaction")).toBe("transaction");
  expect(first("owner took money out")).toBe("spend");
  expect(first("owner's draw")).toBe("spend");
  expect(first("expense")).toBe("spend");
  expect(first("bought")).toBe("spend");
  expect(first("receive")).toBe("receive");
  expect(first("owner put money in")).toBe("receive");
  expect(first("deposit")).toBe("receive");
  expect(first("customer payment")).toBe("receive");
  expect(first("transfer")).toBe("transfer");
  expect(first("move money")).toBe("transfer");
  expect(first("between accounts")).toBe("transfer");
  expect(first("pay credit card")).toBe("transfer");
});

test("a search that is about something else finds none of them", () => {
  expect(actionHits(ENTRY_ACTIONS, "reconcile")).toEqual([]);
  expect(actionHits(ENTRY_ACTIONS, "tax form")).toEqual([]);
});

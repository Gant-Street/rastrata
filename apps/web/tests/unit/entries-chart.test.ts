import { expect, test } from "bun:test";
import type { AccountRow } from "@rastrata/application/client-contracts";
import { quickAccounts } from "../../src/routes/entries/chart";

const row = (
  id: string,
  role: AccountRow["role"],
  extra: Partial<AccountRow> = {},
): AccountRow => ({
  id,
  code: id,
  name: `Account ${id}`,
  role,
  parentId: null,
  openedOn: "2026-01-01",
  closedOn: null,
  balance: "0.00",
  ...extra,
});

test("an account tagged as cash is a bank, and so is one a statement or a feed is mapped to", () => {
  const found = quickAccounts(
    [
      row("1000", "asset", { tags: { cashFlowClass: "cash" } }),
      row("2000", "liability"),
      row("1500", "asset"),
    ],
    new Set(["2000"]),
  );
  expect(found.map((account) => [account.id, account.bank])).toEqual([
    ["1000", true],
    ["2000", true],
    ["1500", false],
  ]);
});

test("an account other accounts sit under is a group, and a closed account is closed", () => {
  const found = quickAccounts(
    [
      row("5000", "expense"),
      row("5010", "expense", { parentId: "5000" }),
      row("5900", "expense", { closedOn: "2026-06-30" }),
    ],
    new Set(),
  );
  expect(found.map((account) => [account.id, account.group, account.closed])).toEqual([
    ["5000", true, false],
    ["5010", false, false],
    ["5900", false, true],
  ]);
});

test("the dialogs get what they need of an account and nothing of its balance", () => {
  const [account] = quickAccounts([row("1000", "asset", { balance: "12.00" })], new Set());
  expect(Object.keys(account ?? {}).sort()).toEqual(
    ["bank", "closed", "code", "group", "id", "name", "role"].sort(),
  );
});

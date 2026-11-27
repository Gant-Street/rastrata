import { expect, test } from "bun:test";
import {
  decodeDurableBook,
  ExactRational,
  bookId,
  accountId,
  commodityId,
  dimensionMemberId,
  type InventoryMoneyScope,
} from "@rastrata/kernel";
import { journalMoneyScopes, moneyScopeKeys, nativeMoney } from "../src/native-money.ts";
import type { NativeLedgerFact, NativeLedgerTransaction } from "../src/sqlite-ledger-repository.ts";

test("money scopes project real owned journals and preserve permanent management at zero balance", async () => {
  const decoded = decodeDurableBook(
    await Bun.file(
      new URL("./data/owned-inventory-preparation-baseline.json", import.meta.url),
    ).text(),
  );
  if (decoded.disposition !== "decoded") throw new Error("Expected pinned owned history");
  const facts = new Map<string, NativeLedgerFact>();
  let reads = 0;
  const view = {
    facts(keys: readonly { collection: string; key: string }[]) {
      reads++;
      return keys.map((key) => facts.get(JSON.stringify([key.collection, key.key])) ?? null);
    },
  } satisfies Pick<NativeLedgerTransaction, "facts">;
  const write = (rows: readonly NativeLedgerFact[]) => {
    for (const row of rows) facts.set(JSON.stringify([row.collection, row.key]), row);
  };
  for (const revision of decoded.aggregate.state.revisions)
    write(nativeMoney(view).project(revision.effects));
  const journals = decoded.aggregate.state.journals.map((booked) => booked.journal);
  const scopes = journalMoneyScopes(journals);
  const money = nativeMoney(view);
  reads = 0;
  money.read(scopes);
  for (const scope of scopes) {
    const expected = journals
      .flatMap((journal) => journal.postings)
      .filter((posting) => posting.accountId === scope.accountId)
      .reduce(
        (total, posting) => total.add(posting.bookValue.amount.toRational()),
        ExactRational.zero(),
      );
    expect(money.balance(scope)).toEqual(expected);
  }
  expect(reads).toBe(1);
  const effect = decoded.aggregate.state.inventoryOwnershipEffects?.[0];
  const movement = effect?.quantityOnlyMovements[0] ?? effect?.journalLinkedMovements[0];
  if (!movement) throw new Error("Expected owned movement fixture");
  const scope: InventoryMoneyScope = movement.coordinate;
  expect(money.managed(scope)).toBe("managed");
  const keys = moneyScopeKeys([scope]);
  const balanceKey = keys.find((key) => key.collection === "moneyScopeBalances");
  if (!balanceKey) throw new Error("Expected balance key");
  const id = JSON.stringify([balanceKey.collection, balanceKey.key]);
  const original = facts.get(id);
  if (!original) throw new Error("Expected balance fact");
  for (const amount of ["01/1", "1/0", "1/2/3", "0/2", "9".repeat(100_000)]) {
    const body = JSON.parse(original.encoded);
    facts.set(id, { ...original, encoded: JSON.stringify([body[0], amount]) });
    expect(() => nativeMoney(view).balance(scope)).toThrow();
  }
  const raw = JSON.parse(original.encoded)[0];
  facts.set(id, { ...original, encoded: JSON.stringify([raw, "0/1"]) });
  const zero = nativeMoney(view);
  expect(zero.balance(scope).toString()).toBe("0/1");
  expect(zero.managed(scope)).toBe("managed");
  facts.delete(id);
  expect(() => nativeMoney(view).managed(scope)).toThrow("native_ledger_money_scope_incomplete");
});

test("money scopes bind book, account, commodity and canonical dimension tuples", () => {
  const scope: InventoryMoneyScope = {
    bookId: bookId("book:a"),
    accountId: accountId("b"),
    functionalCommodityId: commodityId("USD"),
    dimensionMemberIds: [dimensionMemberId("north"), dimensionMemberId("sales")],
  };
  const keys = moneyScopeKeys([scope]);
  const reversed = { ...scope, dimensionMemberIds: [...scope.dimensionMemberIds].reverse() };
  expect(moneyScopeKeys([reversed])).toEqual(keys);
  expect(moneyScopeKeys([scope, reversed])).toHaveLength(3);
  const foreign = [
    { ...scope, bookId: bookId("book"), accountId: accountId("a:b") },
    { ...scope, functionalCommodityId: commodityId("EUR") },
    { ...scope, dimensionMemberIds: [dimensionMemberId("north:sales")] },
  ];
  for (const other of foreign) expect(moneyScopeKeys([other])).not.toEqual(keys);
  const raw = JSON.stringify([
    scope.bookId,
    scope.accountId,
    scope.functionalCommodityId,
    scope.dimensionMemberIds,
  ]);
  const rows = new Map(
    keys.slice(0, 2).map((key) => [
      key.key + key.collection,
      {
        ...key,
        encoded: key.collection === "moneyScopeIdentities" ? raw : JSON.stringify([raw, "5/2"]),
        ...(key.collection === "moneyScopeBalances" ? { mutable: true as const } : {}),
      },
    ]),
  );
  const view = {
    facts: (requested: Parameters<NativeLedgerTransaction["facts"]>[0]) =>
      requested.map((key) => rows.get(key.key + key.collection) ?? null),
  };
  const money = nativeMoney(view);
  expect(money.balance(reversed).toString()).toBe("5/2");
  for (const other of foreign) expect(money.balance(other).toString()).toBe("0/1");
  const counter = keys[1];
  if (!counter) throw new Error("Expected balance key");
  rows.set(counter.key + counter.collection, {
    ...counter,
    mutable: true,
    encoded: JSON.stringify(["foreign scope", "5/2"]),
  });
  expect(() => nativeMoney(view).balance(scope)).toThrow("native_ledger_money_scope_corrupt");
});

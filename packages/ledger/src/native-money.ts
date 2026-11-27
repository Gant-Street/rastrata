import {
  ExactRational,
  MAX_EXACT_INTEGER_BITS,
  compareCanonicalText,
  hashCanonical,
  type BookedJournal,
  type InventoryMoneyScope,
  type BookEffect,
} from "@rastrata/kernel";
import { requireLedger } from "./records.ts";
import type { NativeLedgerFact, NativeLedgerTransaction } from "./native-ledger-repository.ts";

const IDENTITY = "moneyScopeIdentities";
const BALANCE = "moneyScopeBalances";
const MANAGED = "inventoryMoneyScopes";
const tuple = (scope: InventoryMoneyScope) =>
  JSON.stringify([
    scope.bookId,
    scope.accountId,
    scope.functionalCommodityId,
    [...scope.dimensionMemberIds].sort(compareCanonicalText),
  ]);
const identity = (scope: InventoryMoneyScope) => hashCanonical({ moneyScope: tuple(scope) }).digest;

export function journalMoneyScopes(
  journals: readonly BookedJournal["journal"][],
): readonly InventoryMoneyScope[] {
  return journals.flatMap((journal) =>
    journal.postings.map((posting) => ({
      bookId: journal.bookId,
      accountId: posting.accountId,
      functionalCommodityId: journal.functionalCommodityId,
      dimensionMemberIds: posting.dimensionMemberIds,
    })),
  );
}
export function moneyScopeKeys(scopes: readonly InventoryMoneyScope[]) {
  return [...new Set(scopes.map(tuple))]
    .map((raw) => hashCanonical({ moneyScope: raw }).digest)
    .flatMap((key) => [IDENTITY, BALANCE, MANAGED].map((collection) => ({ collection, key })));
}
function rational(value: unknown): ExactRational {
  requireLedger(
    typeof value === "string" &&
      value.length <= Math.ceil(MAX_EXACT_INTEGER_BITS * 0.302) * 2 + 4 &&
      /^-?(0|[1-9][0-9]*)\/[1-9][0-9]*$/.test(value),
    "native_ledger_money_scope_corrupt",
  );
  const separator = value.indexOf("/");
  const amount = ExactRational.of(
    BigInt(value.slice(0, separator)),
    BigInt(value.slice(separator + 1)),
  );
  requireLedger(amount.toString() === value, "native_ledger_money_scope_corrupt");
  return amount;
}
type Observation = {
  readonly raw: string;
  readonly exists: boolean;
  readonly managed: boolean;
  readonly balance: ExactRational;
};

/** One synchronous transaction's exact money projection. Permanent identities
 * distinguish a new scope from a lost counter. These are derived balances, not
 * caller-supplied ownership evidence or a replacement for canonical history audit. */
export function nativeMoney(
  view: Pick<NativeLedgerTransaction, "facts">,
  initial: ReadonlyMap<string, NativeLedgerFact | null> = new Map(),
) {
  const observed = new Map<string, Observation>();
  const identities = new Map<string, string>();
  const identify = (scope: InventoryMoneyScope) => {
    const raw = tuple(scope);
    const key = identities.get(raw) ?? identity(scope);
    identities.set(raw, key);
    return key;
  };
  const read = (scopes: readonly InventoryMoneyScope[]) => {
    const missing = new Map(
      scopes
        .filter((scope) => !observed.has(identify(scope)))
        .map((scope) => [identify(scope), scope]),
    );
    if (missing.size === 0) return;
    const facts = new Map(initial);
    const unread = moneyScopeKeys([...missing.values()]).filter(
      (key) => !facts.has(JSON.stringify([key.collection, key.key])),
    );
    for (let offset = 0; offset < unread.length; offset += 750) {
      const keys = unread.slice(offset, offset + 750),
        values = view.facts(keys);
      for (const [index, key] of keys.entries()) {
        const value = values[index];
        requireLedger(value !== undefined, "native_ledger_required_fact_missing");
        facts.set(JSON.stringify([key.collection, key.key]), value);
      }
    }
    for (const [key, scope] of missing) {
      const raw = tuple(scope);
      const id = facts.get(JSON.stringify([IDENTITY, key]));
      const balance = facts.get(JSON.stringify([BALANCE, key]));
      const managed = facts.get(JSON.stringify([MANAGED, key]));
      requireLedger(
        id !== undefined && balance !== undefined && managed !== undefined,
        "native_ledger_required_fact_missing",
      );
      requireLedger(
        id === null
          ? balance === null && managed === null
          : id.mutable !== true &&
              id.encoded === raw &&
              balance !== null &&
              balance.mutable === true,
        "native_ledger_money_scope_incomplete",
      );
      requireLedger(
        managed === null || (managed.mutable !== true && managed.encoded === raw),
        "native_ledger_money_scope_corrupt",
      );
      let amount = ExactRational.zero();
      if (balance !== null) {
        const body = JSON.parse(balance.encoded);
        requireLedger(
          Array.isArray(body) && body.length === 2 && body[0] === raw,
          "native_ledger_money_scope_corrupt",
        );
        amount = rational(body[1]);
        requireLedger(
          JSON.stringify([raw, amount.toString()]) === balance.encoded,
          "native_ledger_money_scope_corrupt",
        );
      }
      observed.set(key, { raw, exists: id !== null, managed: managed !== null, balance: amount });
    }
  };
  const get = (scope: InventoryMoneyScope) => {
    read([scope]);
    const result = observed.get(identify(scope));
    requireLedger(
      result !== undefined && result.raw === tuple(scope),
      "native_ledger_money_scope_corrupt",
    );
    return result;
  };
  return {
    read,
    balance: (scope: InventoryMoneyScope) => get(scope).balance,
    managed: (scope: InventoryMoneyScope): "managed" | "unmanaged" =>
      get(scope).managed ? "managed" : "unmanaged",
    project(effects: readonly BookEffect[]): readonly NativeLedgerFact[] {
      const journals = effects.flatMap((effect) =>
        effect.type === "journal" ? [effect.booked.journal] : [],
      );
      const claimed = effects.flatMap((effect) =>
        effect.type === "inventoryOwnership"
          ? [...effect.value.journalLinkedMovements, ...effect.value.quantityOnlyMovements].map(
              (movement) => movement.coordinate,
            )
          : [],
      );
      const scopes = [...journalMoneyScopes(journals), ...claimed];
      read(scopes);
      const updated = new Map(scopes.map((scope) => [identify(scope), get(scope).balance]));
      for (const journal of journals)
        for (const posting of journal.postings) {
          const scope = {
            bookId: journal.bookId,
            accountId: posting.accountId,
            functionalCommodityId: journal.functionalCommodityId,
            dimensionMemberIds: posting.dimensionMemberIds,
          };
          const key = identify(scope);
          const balance = updated.get(key);
          requireLedger(balance !== undefined, "native_ledger_money_scope_incomplete");
          updated.set(key, balance.add(posting.bookValue.amount.toRational()));
        }
      const managedKeys = new Set(claimed.map(identify));
      const result: NativeLedgerFact[] = [];
      for (const [key, balance] of updated) {
        const before = observed.get(key);
        requireLedger(before !== undefined, "native_ledger_money_scope_incomplete");
        const raw = before.raw;
        if (!before.exists) result.push({ collection: IDENTITY, key, encoded: raw });
        result.push({
          collection: BALANCE,
          key,
          mutable: true,
          encoded: JSON.stringify([raw, balance.toString()]),
        });
        if (!before.managed && managedKeys.has(key))
          result.push({ collection: MANAGED, key, encoded: raw });
      }
      return result;
    },
  };
}

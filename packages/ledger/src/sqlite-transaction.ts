import { requireLedger } from "./records.ts";
import type { SqliteStorage } from "./sqlite.ts";

declare const transactionBrand: unique symbol;
export interface SqliteTransaction {
  readonly [transactionBrand]: true;
}
const active = new WeakMap<object, SqliteStorage>();
const writing = new WeakSet<SqliteStorage>();

/** Internal owner-only synchronous transaction port. The opaque token is usable
 * only during this callback and only by components sharing this exact storage
 * port. Never retain it, pass it to user code, yield, or nest transactions. */
export function atomicSqlite<T>(
  storage: SqliteStorage,
  write: (transaction: SqliteTransaction) => T,
): T {
  requireLedger(!writing.has(storage), "sqlite_nested_transaction_forbidden");
  return storage.transactionSync(() => {
    const token = Object.freeze({}) as SqliteTransaction;
    writing.add(storage);
    active.set(token, storage);
    try {
      const result = write(token);
      requireLedger(
        result === null ||
          (typeof result !== "object" && typeof result !== "function") ||
          !("then" in result),
        "sqlite_async_transaction_forbidden",
      );
      return result;
    } finally {
      active.delete(token);
      writing.delete(storage);
    }
  });
}

export function requireSqliteTransaction(
  transaction: SqliteTransaction,
  storage: SqliteStorage,
): void {
  requireLedger(active.get(transaction) === storage, "sqlite_transaction_not_active");
}

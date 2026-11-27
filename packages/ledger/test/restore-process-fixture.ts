import { Database } from "bun:sqlite";
import type { SqlBinding, SqliteStorage } from "../src/sqlite.ts";
import { BOOK } from "./fixtures.ts";

export const restoreCrashScope = Object.freeze({
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "restore-crash-book",
  namespaceId: "restore-crash",
  generation: "0",
});
export const restoreCrashPoints = [
  "selection-row",
  "selection-committed",
  "tables-dropped",
  "schema-created",
  "genesis-chunk",
  "rejection-header",
  "first-outcome-chunk",
  "installed-row",
  "install-committed",
  "response-ready",
] as const;

/** File-backed local SQLite, not an emulation of Cloudflare storage.sync(). */
export function restoreCrashSqlite(
  path: string,
  options: {
    readonly?: boolean;
    afterSql?: (sql: string, bindings: readonly SqlBinding[]) => void;
    afterTransaction?: () => void;
  } = {},
) {
  const db = new Database(path, { readonly: options.readonly ?? false, create: !options.readonly });
  if (!options.readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        options.afterSql?.(sql, bindings);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync(fn) {
      const value = db.transaction(fn)();
      options.afterTransaction?.();
      return value;
    },
    async sync() {
      // synchronous=FULL has already confirmed the local WAL commit. No claim
      // about provider replication or Durable Object output gates follows.
    },
  };
  return { db, storage };
}

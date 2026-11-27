// Test-only subprocess. Validate the exact disposable target before opening it.
import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalAccountingValue, canonicalEncode, encodeDurableBook } from "@rastrata/kernel";
import { IndexedLedgerOwner } from "../src/indexed-ledger-owner.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

const args = process.argv.slice(2);
const [path, operation, point, kind] = args;
const hooks = new Map([
  ["root", "UPDATE ledger_index_control"],
  ["pin", "DELETE FROM ledger_index_pins"],
]);
if (
  args.length !== 4 ||
  !path ||
  !isAbsolute(path) ||
  basename(path) !== "book.sqlite" ||
  !basename(dirname(path)).startsWith("rastrata-indexed-owner-crash-") ||
  dirname(dirname(path)) !== resolve(tmpdir()) ||
  !["initialize", "read", "execute"].includes(operation ?? "") ||
  !["commit", "reject"].includes(kind ?? "") ||
  (point !== "none" && point !== "committed" && !hooks.has(point ?? "")) ||
  (operation !== "execute" && point !== "none")
)
  throw new Error("Invalid isolated indexed-owner process arguments");
const db = new Database(path);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = FULL");
let publication = false;
function crash(): never {
  writeSync(2, `REACHED:${point}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL unexpectedly returned");
}
const stmtCache = new Map<string, ReturnType<Database["query"]>>();
const storage: SqliteStorage = {
  sql: {
    exec(sql, ...bindings) {
      if (sql.startsWith("INSERT INTO ledger_indexed_records")) publication = true;
      let stmt = stmtCache.get(sql);
      if (!stmt) {
        stmt = db.query(sql);
        stmtCache.set(sql, stmt);
      }
      const rows = stmt.all(
        ...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
      ) as Record<string, unknown>[];
      if (
        operation === "execute" &&
        publication &&
        point &&
        hooks.has(point) &&
        sql.startsWith(hooks.get(point) ?? "invalid")
      )
        crash();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (const name in row) {
          const val = row[name];
          if (val instanceof Uint8Array) {
            row[name] = val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
          }
        }
      }
      return rows;
    },
  },
  transactionSync(operationBody) {
    try {
      const result = db.transaction(operationBody)();
      if (operation === "execute" && point === "committed" && publication) crash();
      return result;
    } finally {
      publication = false;
    }
  },
  // Local SQLite FULL confirms its WAL commit. This is not a DO sync simulation.
  sync: async () => {},
};
const scope = {
  tenantId: "indexed-owner-crash",
  bookId: BOOK,
  objectId: "indexed-owner-crash",
  namespaceId: "indexed-owner-crash",
  generation: "0",
};
const owner = new IndexedLedgerOwner(
  storage,
  scope,
  scope.objectId,
  () => ({ fence: "0", pending: false }),
  () => 10n,
);
try {
  if (operation === "initialize") {
    await owner.provision(genesis());
    await owner.execute(activation());
  }
  const receipt =
    operation === "execute"
      ? await owner.execute(
          posting(kind === "commit" ? "crash-sale" : "crash-stale", kind === "commit" ? 1n : 0n),
        )
      : null;
  const snapshot = await owner.read();
  writeSync(
    1,
    JSON.stringify({
      snapshot: encodeDurableBook(snapshot.aggregate),
      sequence: snapshot.head.sequence,
      headHash: snapshot.head.contentHash,
      disposition: receipt?.result.disposition ?? null,
      outcomeSequence: receipt?.outcomeSequence?.toString() ?? null,
      original: receipt?.originalResult
        ? new TextDecoder().decode(
            canonicalEncode(canonicalAccountingValue(receipt.originalResult)),
          )
        : null,
    }),
  );
} finally {
  db.close();
}

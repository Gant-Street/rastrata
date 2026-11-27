// Child process used only by native-ledger-process.test.ts. Crash precisely at
// physical publication boundaries; never accept a path from a public request.
import { Database } from "bun:sqlite";
import { NativeLedger } from "../src/native-ledger.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

const [path, mode, crash, kind] = process.argv.slice(2);
if (!path || !["provision", "execute"].includes(mode ?? ""))
  throw new Error("Invalid child invocation");
const db = new Database(path);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=FULL");
db.exec("PRAGMA foreign_keys=ON");
function terminate() {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL returned");
}
const storage: SqliteStorage = {
  sql: {
    exec(sql, ...bindings) {
      const rows = db
        .query(sql)
        .all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
      if (crash && sql.startsWith(crash)) terminate();
      return rows;
    },
  },
  transactionSync(operation) {
    const result = db.transaction(operation).immediate();
    if (crash === "after-commit") terminate();
    return result;
  },
  async sync() {}, // SQLite synchronous=FULL commit is the local durability barrier.
};
const scope = {
  tenantId: "process",
  bookId: BOOK,
  objectId: "process",
  namespaceId: "process",
  generation: "0",
};
const repository = new SqliteLedgerRepository(storage, scope, scope.objectId, () => ({
  fence: "0",
  pending: false,
}));
const ledger = new NativeLedger(repository);
if (mode === "provision") {
  await ledger.provision(genesis(), activation());
  console.log(JSON.stringify({ provisioned: true }));
} else {
  const result = await ledger.execute(posting("crash-command", kind === "reject" ? 0n : 1n));
  const retained = await repository.transact((view) => ({
    write: false,
    value: view.outcome("crash-command")?.encoded,
  }));
  const count = db.query("SELECT count(*) AS count FROM ledger_native_outcomes").get();
  const integrity = db.query("PRAGMA integrity_check").get();
  console.log(
    JSON.stringify({
      disposition: result.value.result.disposition,
      head: result.head,
      outcomeSequence: result.value.outcomeSequence,
      encoded: retained.value,
      count,
      integrity,
    }),
  );
}
db.close();

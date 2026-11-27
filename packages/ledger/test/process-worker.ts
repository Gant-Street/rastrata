import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ProductionLedger,
  SqliteIndexedBookStorage,
  COMPACT_LEDGER_FORMAT,
  type SqliteStorage,
} from "../src/index.ts";
import {
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
  workflowTerminationCommand,
  workflowValue,
} from "./accounting-workflows.ts";
import { BOOK } from "./fixtures.ts";

// Test-only subprocess. Never opens a configured book, environment secret or
// Cloudflare resource. Its parent creates an isolated disposable SQLite file.
const [path, operation, point, catalogMode = "identity"] = process.argv.slice(2);
const hooks = new Map([
  ["derived-page", "INSERT INTO ledger_index_pages"],
  ["outcome", "INSERT INTO ledger_outcomes"],
  ["chunks", "INSERT INTO ledger_chunks"],
  ["head", "UPDATE ledger_metadata SET head"],
  ["root", "UPDATE ledger_index_control"],
  ["pin-retirement", "DELETE FROM ledger_index_pins"],
  ["source-nodes", "INSERT INTO ledger_source_nodes"],
  ["source-origins", "INSERT INTO ledger_source_origins"],
  ["source-root", "UPDATE ledger_source_catalog"],
  ["group-nodes", "INSERT INTO ledger_group_nodes"],
  ["group-descriptors", "INSERT INTO ledger_group_descriptors"],
  ["group-root", "UPDATE ledger_group_catalog"],
]);
if (
  path === undefined ||
  !isAbsolute(path) ||
  basename(path) !== "book.sqlite" ||
  !basename(dirname(path)).startsWith("rastrata-cumulative-crash-") ||
  dirname(dirname(path)) !== resolve(tmpdir()) ||
  (catalogMode !== "identity" && catalogMode !== "sources") ||
  !["initialize", "initialize-groups", "transfer", "terminate", "reject"].includes(
    operation ?? "",
  ) ||
  (point !== "none" && point !== "committed" && !hooks.has(point ?? ""))
) {
  throw new Error("Invalid isolated-process test arguments");
}
const db = new Database(path);
const initializing = operation === "initialize" || operation === "initialize-groups";
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = FULL");
let publishing = false;
function crash() {
  // Synchronous marker distinguishes reaching the intended boundary from a
  // watchdog timeout or unrelated crash. SIGKILL runs no cleanup/finally handler.
  writeSync(2, `REACHED:${point}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL unexpectedly returned");
}
const stmtCache = new Map<string, ReturnType<Database["query"]>>();
const port: SqliteStorage = {
  sql: {
    exec(sql, ...bindings) {
      if (sql.startsWith("INSERT INTO ledger_outcomes")) publishing = true;
      let stmt = stmtCache.get(sql);
      if (!stmt) {
        stmt = db.query(sql);
        stmtCache.set(sql, stmt);
      }
      const rows = stmt.all(
        ...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
      ) as Record<string, unknown>[];
      if (
        !initializing &&
        point !== undefined &&
        hooks.has(point) &&
        sql.startsWith(hooks.get(point) ?? "invalid") &&
        (point === "derived-page" || publishing)
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
  transactionSync(fn) {
    const result = db.transaction(fn)();
    if (!initializing && point === "committed" && publishing) crash();
    publishing = false;
    return result;
  },
  async sync() {
    // Bun SQLite with synchronous=FULL already waits for its local WAL commit.
    // This is not an emulation or proof of Durable Object storage.sync().
  },
};
const scope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "indexed-object",
  namespaceId: "namespace",
  generation: "0",
};
const storage = new SqliteIndexedBookStorage(
  scope.objectId,
  port,
  scope,
  () => ({ fence: "0", pending: false }),
  () => 10n,
  100n,
  { sourceCatalog: catalogMode === "sources" },
);
const ledger = new ProductionLedger(storage, scope, COMPACT_LEDGER_FORMAT);
const scenario = allocationAndTaxWorkflow("1.1.0");
try {
  if (initializing) {
    const selected = operation === "initialize-groups" ? lotIdentityWorkflow() : scenario;
    await ledger.provision(selected.initial);
    for (const command of operation === "initialize-groups"
      ? selected.commands.slice(0, 3)
      : selected.commands) {
      const receipt = await ledger.execute(command);
      if (receipt.result.disposition !== "committed")
        throw new Error(JSON.stringify(receipt.result.diagnostics));
    }
    process.stdout.write(
      JSON.stringify({ status: "initialized", head: (await ledger.read()).head }),
    );
  } else {
    const result = await ledger.execute(
      operation === "transfer"
        ? workflowValue(lotIdentityWorkflow().commands[3])
        : workflowTerminationCommand(scenario, operation === "reject" ? 7n : 8n),
    );
    process.stdout.write(
      JSON.stringify({
        status: result.result.disposition,
        sequence: String(result.outcomeSequence),
      }),
    );
  }
} finally {
  db.close();
}

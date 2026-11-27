import { existsSync, lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SqliteArchiveCatalog } from "../src/archive-catalog.ts";
import { SqliteArchiveSelection } from "../src/archive-selection.ts";
import { R2ArchiveObjectStore } from "../src/r2-archive-store.ts";
import { decodeArchiveAnchor } from "../src/archive-records.ts";
import {
  restoreCrashPoints,
  restoreCrashScope as scope,
  restoreCrashSqlite,
} from "./restore-process-fixture.ts";

// Test-only subprocess. Only its parent's isolated disposable book is writable;
// catalog is read-only and the parent-owned local R2 bridge accepts GET only.
const [directory, point, endpoint, capability] = process.argv.slice(2);
function invalid(): never {
  throw new Error("Invalid isolated restore-process arguments");
}
if (
  directory === undefined ||
  !isAbsolute(directory) ||
  !basename(directory).startsWith("rastrata-restore-crash-") ||
  dirname(directory) !== resolve(tmpdir()) ||
  !existsSync(directory) ||
  lstatSync(directory).isSymbolicLink() ||
  !lstatSync(directory).isDirectory() ||
  realpathSync(directory) !== join(realpathSync(tmpdir()), basename(directory)) ||
  (point !== "none" &&
    !restoreCrashPoints.includes(point as (typeof restoreCrashPoints)[number])) ||
  endpoint === undefined ||
  capability === undefined ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(capability)
)
  invalid();
const url = new URL(endpoint);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/archive" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !url.port ||
  Number(url.port) < 1 ||
  Number(url.port) > 65535
)
  invalid();
for (const name of [
  "book.sqlite",
  "book.sqlite-wal",
  "book.sqlite-shm",
  "book.sqlite-journal",
  "catalog.sqlite",
  "catalog.sqlite-wal",
  "catalog.sqlite-shm",
  "catalog.sqlite-journal",
  "restore-input.json",
]) {
  const path = join(directory, name);
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()))
    invalid();
}
const inputPath = join(directory, "restore-input.json");
if (
  !existsSync(join(directory, "catalog.sqlite")) ||
  !existsSync(inputPath) ||
  lstatSync(inputPath).size > 4096
)
  invalid();
const input = JSON.parse(readFileSync(inputPath, "utf8"));
if (
  input === null ||
  typeof input !== "object" ||
  Object.keys(input).sort().join(",") !== "catalogHash,permitHash" ||
  typeof input.catalogHash !== "string" ||
  typeof input.permitHash !== "string" ||
  !/^[0-9a-f]{64}$/.test(input.catalogHash) ||
  !/^[0-9a-f]{64}$/.test(input.permitHash)
)
  invalid();

function crash() {
  const restoreTable = book.db
    .query("SELECT name FROM sqlite_master WHERE name = 'ledger_archive_restore'")
    .get();
  const tables = book.db
    .query(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_metadata', 'ledger_outcomes', 'ledger_chunks', 'ledger_archive_owner', 'ledger_archive_chunks')",
    )
    .get() as { count: number };
  const checkpoint = {
    point,
    phase: restoreTable
      ? ((
          book.db.query("SELECT phase FROM ledger_archive_restore").get() as {
            phase: string;
          } | null
        )?.phase ?? null)
      : null,
    tables: tables.count,
    outcomes:
      tables.count === 5
        ? (
            book.db.query("SELECT count(*) AS count FROM ledger_outcomes").get() as {
              count: number;
            }
          ).count
        : 0,
    chunks:
      tables.count === 5
        ? (book.db.query("SELECT count(*) AS count FROM ledger_chunks").get() as { count: number })
            .count
        : 0,
  };
  // Observe actual SQL state inside this boundary, including uncommitted rows.
  // Parent checks this separately from the durable state after the hard kill.
  writeSync(2, `REACHED:${JSON.stringify(checkpoint)}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL unexpectedly returned");
}
let transactionKind: "read" | "selection" | "installation" = "read";
const book = restoreCrashSqlite(join(directory, "book.sqlite"), {
  afterSql(sql, bindings) {
    if (
      sql.startsWith("INSERT INTO ledger_archive_restore") ||
      (sql.startsWith("UPDATE ledger_archive_restore SET phase") && bindings[0] === "selected")
    ) {
      transactionKind = "selection";
      if (point === "selection-row") crash();
    }
    if (sql.startsWith("DROP TABLE ledger_") || sql.startsWith("CREATE TABLE ledger_metadata"))
      transactionKind = "installation";
    const atBoundary =
      (point === "tables-dropped" && sql === "DROP TABLE ledger_metadata") ||
      (point === "schema-created" && sql.startsWith("CREATE TABLE ledger_archive_chunks")) ||
      (point === "genesis-chunk" &&
        sql.startsWith("INSERT INTO ledger_chunks") &&
        bindings[0] === "genesis" &&
        bindings[1] === 0) ||
      (point === "rejection-header" &&
        sql.startsWith("INSERT INTO ledger_outcomes") &&
        bindings[0] === "3") ||
      (point === "first-outcome-chunk" &&
        sql.startsWith("INSERT INTO ledger_chunks") &&
        bindings[0] === "2" &&
        bindings[1] === 0) ||
      (point === "installed-row" &&
        sql.startsWith("UPDATE ledger_archive_restore SET phase") &&
        bindings[0] === "installed");
    if (atBoundary) crash();
  },
  afterTransaction() {
    const completed = transactionKind;
    transactionKind = "read";
    if (
      (point === "selection-committed" && completed === "selection") ||
      (point === "install-committed" && completed === "installation")
    )
      crash();
  },
});
const control = restoreCrashSqlite(join(directory, "catalog.sqlite"), { readonly: true });
let writeAttempts = 0;
const store = new R2ArchiveObjectStore(
  {
    async get(key) {
      const target = new URL(url);
      target.searchParams.set("key", key);
      const response = await fetch(target, { headers: { "X-Fixture-Capability": capability } });
      if (response.status === 404) return null;
      if (!response.ok || response.body === null)
        throw new Error(`Archive fixture HTTP ${response.status}`);
      const returnedKey = response.headers.get("X-Archive-Key"),
        etag = response.headers.get("X-Archive-Etag");
      const size = Number(response.headers.get("X-Archive-Size"));
      if (returnedKey === null || etag === null || !Number.isSafeInteger(size))
        throw new Error("Invalid archive bridge metadata");
      return { key: returnedKey, etag, size, body: response.body };
    },
    async put() {
      writeAttempts++;
      throw new Error("Restore must not write the parent archive");
    },
  },
  scope,
  scope.objectId,
);
try {
  const catalog = new SqliteArchiveCatalog("restore-crash-catalog", control.storage, scope);
  const owner = new SqliteArchiveSelection(scope.objectId, book.storage, scope);
  const receipt = await owner.restoreFromArchive(
    store,
    catalog,
    input.catalogHash,
    input.permitHash,
  );
  if (point === "response-ready") crash();
  const archive = await store.readControl();
  if (!archive) throw new Error("Missing fixture archive control");
  const evidence = await owner.verifyArchiveHead(store, decodeArchiveAnchor(archive.body));
  process.stdout.write(
    JSON.stringify({
      receipt,
      evidence,
      writeAttempts,
      catalogHash: (await catalog.read()).contentHash,
      outcomes: book.db
        .query(
          "SELECT command_id, revision FROM ledger_outcomes ORDER BY sequence_length, sequence",
        )
        .all(),
    }),
  );
} finally {
  book.db.close();
  control.db.close();
}

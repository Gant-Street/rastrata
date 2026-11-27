import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { encodeDurableBook, executeBookCommand, type DurableBookAggregate } from "@rastrata/kernel";
import { IndexedLedgerOwner, type IndexedOwnerReceipt } from "../src/indexed-ledger-owner.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { activation, BOOK, genesis, posting } from "../test/fixtures.ts";

// A matched, file-backed comparison. Deliberately not a Cloudflare latency/SLO test.
const baselinePath = process.argv[2];
assert.ok(
  baselinePath && isAbsolute(baselinePath),
  "Supply an absolute preserved baseline owner path",
);
const Baseline = (await import(pathToFileURL(baselinePath).href))
  .IndexedLedgerOwner as typeof IndexedLedgerOwner;
assert.equal(typeof Baseline, "function");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const baselineHash = hash(baselinePath);
const candidatePath = new URL("../src/indexed-ledger-owner.ts", import.meta.url).pathname;
const candidateHash = hash(candidatePath);
assert.equal(
  baselineHash,
  "1b3e34847a70e6d0487479c3cb421e67ba7630757140b0711c49521318b4793b",
  "Unexpected baseline source; do not compare an unidentified implementation",
);
const directory = mkdtempSync(join(tmpdir(), "rastrata-warm-owner-probe-"));
const scope = {
  tenantId: "probe",
  bookId: BOOK,
  objectId: "probe-book",
  namespaceId: "warm-probe",
  generation: "0",
};
const commands = [
  activation(),
  ...Array.from({ length: 8 }, (_, i) => posting(`sale-${i}`, BigInt(i + 1))),
];
let oracle: DurableBookAggregate = genesis();
const oracleResults = commands.map((command) => {
  const next = executeBookCommand(oracle.state, oracle.protocol, command);
  assert.equal(next.result.disposition, "committed");
  oracle = { state: next.state, protocol: next.protocol };
  return next.result;
});
const expectedBook = encodeDurableBook(oracle);
const samples: unknown[] = [];
function open(path: string, Owner: typeof IndexedLedgerOwner) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  let statements = 0;
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        statements++;
        const rows = db
          .query(sql)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
        return rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                : value,
            ]),
          ),
        );
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    // FULL SQLite commits complete before transactionSync returns. This is NOT a
    // substitute for storage.sync in the deployed Workers adapter.
    sync: async () => undefined,
  };
  const reopenOwner = () =>
    new Owner(
      port,
      scope,
      scope.objectId,
      () => ({ fence: "0", pending: false }),
      () => BigInt(Date.now()),
    );
  return { db, owner: reopenOwner(), reopenOwner, count: () => statements };
}
try {
  for (let trial = 0; trial < 3; trial++) {
    const engines = {
      baseline: open(join(directory, `baseline-${trial}.sqlite`), Baseline),
      warm: open(join(directory, `warm-${trial}.sqlite`), IndexedLedgerOwner),
    };
    const receipts: Record<string, IndexedOwnerReceipt[]> = { baseline: [], warm: [] };
    try {
      for (const engine of Object.values(engines)) await engine.owner.provision(genesis());
      for (const [index, command] of commands.entries()) {
        const order =
          (trial + index) % 2 ? (["warm", "baseline"] as const) : (["baseline", "warm"] as const);
        for (const name of order) {
          const engine = engines[name];
          const beforeSql = engine.count(),
            started = performance.now();
          const receipt = await engine.owner.execute(command);
          const elapsedMs = performance.now() - started;
          assert.deepEqual(receipt.result, oracleResults[index]);
          receipts[name]?.push(receipt);
          samples.push({
            trial,
            engine: name,
            posting: index,
            elapsedMs,
            sqlStatements: engine.count() - beforeSql,
          });
        }
      }
      assert.deepEqual(receipts.warm, receipts.baseline);
      for (const [name, engine] of Object.entries(engines)) {
        const started = performance.now();
        const restored = await engine.reopenOwner().read();
        const recoveryMs = performance.now() - started;
        assert.equal(encodeDurableBook(restored.aggregate), expectedBook);
        const last = commands.at(-1);
        assert.ok(last);
        const retry = await engine.owner.execute(last);
        assert.equal(retry.result.disposition, "replayed");
        assert.equal(retry.outcomeSequence, BigInt(commands.length));
        const pages = engine.db.query("PRAGMA page_count").get() as { page_count: number };
        const size = engine.db.query("PRAGMA page_size").get() as { page_size: number };
        samples.push({
          trial,
          engine: name,
          event: "fresh-owner-recovery",
          recoveryMs,
          allocatedDatabaseBytes: pages.page_count * size.page_size,
        });
      }
    } finally {
      for (const engine of Object.values(engines)) engine.db.close();
    }
    console.log(JSON.stringify({ event: "trial-complete", trial }));
  }
  assert.equal(
    hash(candidatePath),
    candidateHash,
    "Candidate changed during measurement; discard run",
  );
  console.log(
    JSON.stringify({
      event: "results",
      scope:
        "three alternating file-backed SQLite WAL/FULL trials; identical receipts and independent full-state oracle; fresh owner is not process/power loss; no Cloudflare SLO claim",
      baselineHash,
      candidateHash,
      samples,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

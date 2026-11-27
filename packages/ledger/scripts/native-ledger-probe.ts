/** Reproducible LOCAL benchmark, not a Cloudflare durability/network SLO.
 * Genuine file-backed SQLite WAL/FULL commits; no seeded fake financial rows.
 * Prints all timed samples and verification evidence to stdout as JSON. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { decodeBookOutcome, decodeBookRow, hashCanonical } from "@rastrata/kernel";
import { NativeLedger } from "../src/native-ledger.ts";
import { verifyNativeLedgerCopy } from "../src/native-ledger-copy.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { decodeStoredNativeOutcome } from "../src/native-outcome-storage.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { BOOK, genesis, activation, posting, closing } from "../test/fixtures.ts";

const count = Number(process.argv[2] ?? "10000");
assert.ok(Number.isSafeInteger(count) && count >= 64 && count <= 1000000);
const directory = mkdtempSync(join(tmpdir(), "rastrata-native-ledger-probe-"));
const path = join(directory, "book.sqlite");
let db = openDatabase();
let statements = 0;
let transactions = 0;
let repository: SqliteLedgerRepository | undefined;
function openDatabase() {
  const connection = new Database(path);
  connection.exec("PRAGMA journal_mode=WAL");
  connection.exec("PRAGMA synchronous=FULL");
  connection.exec("PRAGMA foreign_keys=ON");
  return connection;
}
function open() {
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        statements++;
        const query = db.query(sql);
        const values = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
        // Match the platform cursor for maintenance reads; writes execute eagerly.
        return (
          sql.startsWith("SELECT") ? query.iterate(...values) : query.all(...values)
        ) as Iterable<Record<string, unknown>>;
      },
    },
    transactionSync(operation) {
      transactions++;
      return db.transaction(operation).immediate();
    },
    // SQLite FULL commits synchronously flush the WAL before transaction returns.
    // This is NOT a model of remote replication latency.
    async sync() {},
  };
  const scope = {
    tenantId: "probe",
    bookId: BOOK,
    objectId: "probe",
    namespaceId: "probe",
    generation: "0",
  };
  repository = new SqliteLedgerRepository(storage, scope, scope.objectId, () => ({
    fence: "0",
    pending: false,
  }));
  return new NativeLedger(repository);
}
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const sourcePaths = [
  "../src/native-ledger.ts",
  "../src/native-ledger-copy.ts",
  "../src/sqlite-ledger-repository.ts",
  "../src/native-outcome-storage.ts",
  "../src/serial-ledger-queue.ts",
  "../../kernel/src/current-journal.ts",
  "../../kernel/src/book.ts",
  "../../kernel/src/canonical.ts",
  "../../kernel/src/accounting.ts",
];
const sourceHashes = Object.fromEntries(
  sourcePaths.map((p) => [p, hash(readFileSync(join(import.meta.dir, p)))]),
);
const samples: {
  outcome: number;
  disposition: string;
  wallMs: number;
  cpuMs: number;
  sql: number;
  transactions: number;
  reopened: boolean;
}[] = [];
let ledger = open();
let oracle = genesis();
const activated = evaluateOutcomePayload(oracle, activation());
oracle = { state: activated.transition.state, protocol: activated.transition.protocol };
await ledger.provision(genesis(), activation());
let revision = 1n;
let committed = 0;
let rejected = 0;
for (let i = 0; i < count; i++) {
  const command = posting(`probe-${i}`, i % 10 === 9 ? 0n : revision);
  const reopened = i === 0 || i % 1000 === 0;
  if (reopened) {
    db.close();
    db = openDatabase();
    ledger = open();
  }
  statements = 0;
  transactions = 0;
  const cpu = process.cpuUsage();
  const start = performance.now();
  const result = await ledger.execute(command);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  samples.push({
    outcome: i + 2,
    disposition: result.value.result.disposition,
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    sql: statements,
    transactions,
    reopened,
  });
  assert.equal(transactions, 1);
  assert.ok(statements <= 7);
  assert.equal(result.value.outcomeSequence, String(i + 2));
  if (i % 10 === 9) {
    assert.equal(result.value.result.disposition, "rejected");
    rejected++;
  } else {
    assert.equal(result.value.result.disposition, "committed");
    revision++;
    committed++;
  }
  assert.equal(result.head.bookRevision, revision.toString());
  if (i < 64) {
    const expected = evaluateOutcomePayload(oracle, command);
    assert.deepEqual(result.value.result, expected.transition.result);
    oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
  }
  if ((i + 1) % 10000 === 0)
    console.error(JSON.stringify({ phase: "commands", completed: i + 1, count }));
}
// Independent, exhaustive known-workload checks OUTSIDE the timed path. Verify
// every permanent receipt, exact journal arithmetic, and the complete head chain.
const metadata = db.query("SELECT scope, genesis, head FROM ledger_native_book").get() as {
  scope: string;
  genesis: string;
  head: string;
};
const scopeHash = hash(metadata.scope);
let chain = hash(
  JSON.stringify(["rastrata-native-sql-ledger-v1", scopeHash, hash(metadata.genesis)]),
);
let financialRevision = 0n;
const outcomes = db
  .query(
    "SELECT sequence, command_id, body, previous_hash, head FROM ledger_native_outcomes ORDER BY sequence",
  )
  .iterate() as Iterable<{
  sequence: number;
  command_id: string;
  body: string;
  previous_hash: string;
  head: string;
}>;
let outcomeCount = 0;
let canonicalOutcomeBytes = 0;
let storedOutcomeBytes = 0;
for (const row of outcomes) {
  outcomeCount++;
  assert.equal(row.sequence, outcomeCount);
  assert.equal(row.previous_hash, chain);
  const canonical = decodeStoredNativeOutcome(row.body);
  canonicalOutcomeBytes += Buffer.byteLength(canonical);
  storedOutcomeBytes += Buffer.byteLength(row.body);
  const decoded = decodeBookOutcome(canonical);
  assert.equal(decoded.disposition, "decoded");
  if (decoded.disposition !== "decoded") throw new Error("Invalid retained outcome");
  const payload = decoded.payload;
  assert.equal(payload.command.id, row.command_id);
  if (payload.revision !== null) financialRevision++;
  assert.equal(payload.originalResult.observedBookRevision, financialRevision);
  chain = hash(
    JSON.stringify([
      "rastrata-native-sql-ledger-v1",
      scopeHash,
      String(row.sequence),
      financialRevision.toString(),
      chain,
      hash(canonical),
    ]),
  );
  assert.deepEqual(JSON.parse(row.head), {
    sequence: String(row.sequence),
    bookRevision: financialRevision.toString(),
    chainHash: chain,
  });
}
assert.equal(outcomeCount, count + 1);
assert.deepEqual(JSON.parse(metadata.head), {
  sequence: String(count + 1),
  bookRevision: revision.toString(),
  chainHash: chain,
});
let cents = 0n;
const journals = db
  .query("SELECT body FROM ledger_native_facts WHERE json_extract(identity,'$[0]')='journals'")
  .iterate() as Iterable<{ body: string }>;
let journalCount = 0;
// The optional independent close oracle retains only sequence/hash pairs, not
// full journal bodies or the complete history of command receipts.
const closeHashes: { sequence: bigint; hash: ReturnType<typeof hashCanonical> }[] = [];
for (const row of journals) {
  journalCount++;
  const decoded = decodeBookRow("state.journals", row.body);
  if (decoded.disposition !== "decoded") throw new Error("Invalid booked journal");
  const postings = decoded.row.journal.postings;
  assert.equal(postings.length, 2);
  assert.equal(postings[0]?.bookValue.amount.toRational().toString(), "100/1");
  assert.equal(postings[1]?.bookValue.amount.toRational().toString(), "-100/1");
  if (process.argv.includes("--measure-close"))
    closeHashes.push({ sequence: decoded.row.postingSequence, hash: decoded.row.canonicalHash });
  cents += 10000n;
}
assert.equal(journalCount, committed);
assert.equal(cents, BigInt(committed) * 10000n);
assert.deepEqual(db.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
const retryIndices = new Set<number>();
for (let base = 0; base < count; base += Math.max(10, Math.floor(count / 25))) {
  // Include both dispositions even when the sample stride is divisible by ten.
  const committedIndex = base % 10 === 9 ? base - 1 : base;
  retryIndices.add(committedIndex);
  const lastRejection = Math.floor(count / 10) * 10 - 1;
  retryIndices.add(Math.min(lastRejection, base - (base % 10) + 9));
}
for (const i of retryIndices) {
  // Rev(i) is the activation plus all prior committed commands. Rejections retry
  // with their ORIGINAL stale revision, regardless of today's financial head.
  const originalRevision = i % 10 === 9 ? 0n : 1n + BigInt(i - Math.floor(i / 10));
  const retry = await ledger.execute(posting(`probe-${i}`, originalRevision));
  assert.equal(retry.value.result.disposition, "replayed");
  assert.equal(retry.value.outcomeSequence, String(i + 2));
  assert.equal(retry.value.originalResult?.disposition, i % 10 === 9 ? "rejected" : "committed");
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    max: sorted.at(-1),
  };
}
// Optional full staging verification is separate from interactive save timings.
// It uses genuine file-backed WAL/FULL publication in a distinct physical scope.
let stagingCopy:
  | (Awaited<ReturnType<typeof verifyNativeLedgerCopy>> & {
      readonly wallMs: number;
      readonly cpuMs: number;
      readonly description: string;
    })
  | undefined;
if (process.argv.includes("--verify-copy")) {
  assert.ok(repository);
  const targetDb = new Database(join(directory, "staging.sqlite"));
  targetDb.exec("PRAGMA journal_mode=WAL");
  targetDb.exec("PRAGMA synchronous=FULL");
  targetDb.exec("PRAGMA foreign_keys=ON");
  try {
    const targetScope = { ...repository.scope, objectId: "probe-staging" };
    const target = new SqliteLedgerRepository(
      {
        sql: {
          exec: (sql, ...bindings) =>
            targetDb
              .query(sql)
              .all(
                ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
              ) as Record<string, unknown>[],
        },
        transactionSync: (operation) => targetDb.transaction(operation).immediate(),
        async sync() {},
      },
      targetScope,
      targetScope.objectId,
      () => ({ fence: "0", pending: false }),
    );
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const verified = await verifyNativeLedgerCopy(repository, target, JSON.parse(metadata.head));
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStarted);
    assert.equal(verified.targetHead.sequence, String(count + 1));
    assert.equal(verified.targetHead.bookRevision, String(committed + 1));
    assert.deepEqual(targetDb.query("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
    stagingCopy = {
      ...verified,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      description:
        "Full canonical replay and all-fact comparison into local WAL/FULL staging; not backup delivery or production restore cutover",
    };
  } finally {
    targetDb.close();
  }
}
// Period maintenance is measured separately, after the ordinary workload/copy.
// The expected cutoff uses the original canonical array encoding, not the new
// streaming helper. This is a hash/retention oracle, not a second accounting audit.
let periodClose:
  | { wallMs: number; cpuMs: number; sql: number; journals: number; outcomeSequence: string }
  | undefined;
if (process.argv.includes("--measure-close")) {
  assert.ok(repository);
  const expectedHashes = closeHashes
    .sort((left, right) => (left.sequence < right.sequence ? -1 : 1))
    .map((journal) => ({ ...journal.hash }));
  const expectedHash = hashCanonical({
    type: "LedgerCutoff",
    bookId: BOOK,
    bookRevision: revision + 1n,
    postingSequence: BigInt(committed),
    journalHashes: expectedHashes,
  });
  statements = 0;
  transactions = 0;
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const result = await ledger.execute(closing("probe-period-close", revision));
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const sql = statements;
  assert.equal(transactions, 1);
  assert.equal(result.value.result.disposition, "committed");
  assert.equal(result.value.outcomeSequence, String(count + 2));
  const stored = await repository.transact((view) => ({
    write: false,
    value: view.facts([{ collection: "closePackages", key: "probe-period-close" }])[0],
  }));
  assert.ok(stored.value);
  const decoded = decodeBookRow("state.closePackages", stored.value.encoded);
  assert.equal(decoded.disposition, "decoded");
  if (decoded.disposition !== "decoded") throw new Error("Invalid retained close");
  assert.deepEqual({ ...decoded.row.ledgerHash }, expectedHash);
  periodClose = {
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sql,
    journals: committed,
    outcomeSequence: result.value.outcomeSequence,
  };
}
const sizes = Object.fromEntries(
  ["", "-wal", "-shm"].map((suffix) => {
    try {
      return [suffix || "database", statSync(path + suffix).size];
    } catch {
      return [suffix, 0];
    }
  }),
);
db.close();
for (const source of sourcePaths)
  assert.equal(hash(readFileSync(join(import.meta.dir, source))), sourceHashes[source]);
console.log(
  JSON.stringify(
    {
      schema: "rastrata-native-probe-v1",
      recordedAt: new Date().toISOString(),
      runtime: Bun.version,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      directory,
      sourceHashes,
      count,
      committed,
      rejected,
      timings:
        "execute including snapshot, queue, SQL transaction and local FULL durability; excludes command construction, remote replication and archive work",
      wallMs: summary(samples.map((s) => s.wallMs)),
      freshCommitWallMs: summary(
        samples.filter((s) => s.disposition === "committed").map((s) => s.wallMs),
      ),
      retainedRejectionWallMs: summary(
        samples.filter((s) => s.disposition === "rejected").map((s) => s.wallMs),
      ),
      cpuMs: summary(samples.map((s) => s.cpuMs)),
      first100: summary(samples.slice(0, 100).map((s) => s.wallMs)),
      last100: summary(samples.slice(-100).map((s) => s.wallMs)),
      reopened: summary(samples.filter((s) => s.reopened).map((s) => s.wallMs)),
      over50ms: samples.filter((s) => s.wallMs >= 50).length,
      maxSql: samples.reduce((maximum, sample) => Math.max(maximum, sample.sql), 0),
      sizes,
      outcomeStorage: { canonicalOutcomeBytes, storedOutcomeBytes },
      ...(stagingCopy === undefined ? {} : { stagingCopy }),
      ...(periodClose === undefined ? {} : { periodClose }),
      verified: {
        canonicalOracleFirst: 64,
        allOutcomeChain: true,
        allJournalArithmetic: true,
        sqliteIntegrity: true,
        retries: true,
        committedRetries: [...retryIndices].filter((i) => i % 10 !== 9).length,
        rejectedRetries: [...retryIndices].filter((i) => i % 10 === 9).length,
      },
      samples,
    },
    null,
    2,
  ),
);

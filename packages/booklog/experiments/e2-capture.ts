/** E2: is change capture exact? The real application, driven through its HTTP boundary by a random
 * workload (postings, reversals, drafts, accounts, rules, statement imports and the Inbox, tokens,
 * settings, replays, refused requests), is served from a book in the log while the log is made to
 * fail, the process is stopped and started again (cleanly, by a crash, and from nothing but the log),
 * and the schema is migrated under it. At fixed points, and at the end, a process that follows the
 * log and a process that reads it from nothing must hold exactly what the live book holds, table by
 * table, row by row.
 *
 * Two faults of capture itself are in the mix on purpose, because each was found by accident once:
 * a change that lands between the moment a request's changes are read and the moment they are
 * forgotten (a job writing while the append is in flight), and a table that is made and dropped, or
 * changed and dropped, inside one request.
 *
 *   bun experiments/e2-capture.ts --writes 100000 --books 24 --workers 4 --seed 1 [--json out.json]
 *   bun experiments/e2-capture.ts --writes 3000 --books 4 --workers 2          (a quick one)
 *
 * Pass: zero differences over at least the stated number of write operations, including rollbacks and
 * migrations. Fallback if it fails: ship the write-ahead log's frames instead. */
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catchUp } from "../src/apply.ts";
import { diffDigests, type ChangeCapture, type StateDigest } from "../src/capture.ts";
import type { HostedBook } from "../src/hosted.ts";
import { EntryError } from "../src/entry.ts";
import { importBookFile } from "../src/import.ts";
import { LeaseHeldElsewhereError, LeaseLostError } from "../src/lease.ts";
import { readLog } from "../src/logreader.ts";
import { materialize } from "../src/materialize.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { BookKeys, ObjectStoreUncertain } from "../src/objectstore.ts";
import { Rng } from "../src/rng.ts";
import { CommitConflictError, CommitUncertainError } from "../src/runtime.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { GENESIS_HASH, type LogTier } from "../src/tier.ts";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  openHostedApplication,
  operationRequest,
} from "../test/support/app.ts";
import { Workload } from "./e2-workload.ts";
import { machine, parseArgs, printTable } from "./lib.ts";

/** A closed book file made by the previous release (the schema it is named for), which a legacy book of
 * the run starts from: see e2-legacy-book.ts. */
const LEGACY_FIXTURE = join(import.meta.dir, "../test/fixtures/schema1-book.sqlite.gz");
const LEGACY_SCHEMA = 1;

interface BookSpec {
  readonly index: number;
  readonly seed: number;
  readonly writes: number;
  /** The book starts as one written at the previous schema, and the new release opens it. */
  readonly legacy: boolean;
  readonly faults: boolean;
  readonly sealing: boolean;
  readonly restartEvery: number;
  readonly migrateEvery: number;
  readonly checkEvery: number;
  readonly lateEvery: number;
  readonly burstEvery: number;
}

interface BookResult {
  readonly index: number;
  readonly seed: number;
  readonly legacy: boolean;
  readonly faults: boolean;
  readonly sealing: boolean;
  requests: number;
  writes: number;
  acknowledged: number;
  refused: number;
  retries: number;
  replays: number;
  entries: number;
  bytes: number;
  rollbacks: number;
  conflicts: number;
  uncertain: number;
  resolvedOurs: number;
  rebuilds: number;
  unsentRebuilds: number;
  resets: number;
  readsDeferred: number;
  readsLoggedFirst: number;
  restartsClean: number;
  restartsCrash: number;
  restartsCold: number;
  kills: number;
  migrations: number;
  migrationRollbacks: number;
  lateChanges: number;
  checks: number;
  tablesCompared: number;
  rowsCompared: number;
  coldReads: number;
  differences: string[];
  failures: string[];
  seconds: number;
}

const FAULTS = {
  append: { failBefore: 0.015, failAfter: 0.015, duplicate: 0.01 },
  head: { failBefore: 0.01 },
  read: { failBefore: 0.01 },
} as const;

const has = (db: Database, table: string, column: string): boolean =>
  db.query("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== null;
const exists = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== null;

/** The migrations of "a new release", applied to a live book the way an opening release would: new
 * tables of every shape, a column added to a table with rows, a column renamed, an index, a view, a
 * trigger, tables made and dropped inside one request, a table rebuilt the way SQLite's documented
 * procedure does, and a change to a table the application itself owns. Each step can be applied
 * again after a rollback. */
const MIGRATIONS: readonly ((db: Database) => void)[] = [
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS e2_late (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT);
      CREATE TABLE IF NOT EXISTS e2_a (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE, v BLOB, n REAL, note TEXT DEFAULT 'x');
      CREATE INDEX IF NOT EXISTS e2_a_k ON e2_a (k)`);
    const insert = db.query("INSERT OR IGNORE INTO e2_a (k, v, n, note) VALUES (?, ?, ?, ?)");
    for (let index = 0; index < 40; index += 1)
      insert.run(
        `key-${index}`,
        index % 3 === 0 ? new Uint8Array([index, 0, 255, 7]) : null,
        index % 5 === 0 ? index / 7 : index * 1.5,
        index % 4 === 0 ? null : `note ${index} é中😀`,
      );
  },
  (db) => {
    if (!has(db, "e2_a", "extra"))
      db.exec("ALTER TABLE e2_a ADD COLUMN extra INTEGER NOT NULL DEFAULT 7");
    db.exec("UPDATE e2_a SET extra = id * 3 WHERE id % 2 = 0");
  },
  (db) => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS e2_map (a TEXT, b TEXT, c INTEGER, PRIMARY KEY (a, b)) WITHOUT ROWID",
    );
    const insert = db.query("INSERT OR REPLACE INTO e2_map (a, b, c) VALUES (?, ?, ?)");
    for (let index = 0; index < 30; index += 1)
      insert.run(`a${index % 7}`, `b${index}`, 2 ** 40 + index);
  },
  (db) => {
    db.exec(`CREATE VIEW IF NOT EXISTS e2_view AS SELECT k, n FROM e2_a;
      CREATE TRIGGER IF NOT EXISTS e2_trg AFTER INSERT ON e2_a BEGIN INSERT OR REPLACE INTO e2_map (a, b, c) VALUES ('trg', NEW.k, NEW.id); END`);
    db.run(
      "INSERT OR IGNORE INTO e2_a (k, v, n, note, extra) VALUES ('after-trigger', NULL, 1e-7, 'x', 1)",
    );
  },
  (db) => {
    // A table made, filled and dropped inside one request leaves nothing and must send nothing.
    db.exec("CREATE TABLE e2_scratch (a INTEGER PRIMARY KEY, b TEXT)");
    db.exec("INSERT INTO e2_scratch (a, b) VALUES (1, 'one'), (2, 'two'), (3, 'three')");
    db.exec("UPDATE e2_scratch SET b = b || '!' WHERE a > 1");
    db.exec("DROP TABLE e2_scratch");
  },
  (db) => {
    if (has(db, "e2_a", "note")) db.exec("ALTER TABLE e2_a RENAME COLUMN note TO memo");
    db.exec("UPDATE e2_a SET memo = memo || '!' WHERE id % 5 = 0");
  },
  (db) => {
    if (exists(db, "e2_map")) db.exec("ALTER TABLE e2_map RENAME TO e2_map2");
  },
  (db) => {
    // Rows of a table that already had triggers are changed, and the table is dropped, in one request.
    db.run("INSERT OR REPLACE INTO e2_map2 (a, b, c) VALUES ('late', 'row', 1)");
    db.exec("UPDATE e2_map2 SET c = c + 1 WHERE a = 'a3'");
    db.exec("DELETE FROM e2_a WHERE id % 7 = 0");
    db.exec("DROP VIEW IF EXISTS e2_view; DROP TRIGGER IF EXISTS e2_trg");
    db.exec("DROP TABLE e2_map2");
    db.exec("CREATE TABLE e2_map2 (z TEXT PRIMARY KEY, y TEXT)");
    db.run("INSERT OR REPLACE INTO e2_map2 (z, y) VALUES ('fresh', 'start')");
  },
  (db) => {
    // SQLite's procedure for changing a table's shape: make the new one, copy, drop the old, rename.
    db.exec(`CREATE TABLE e2_a_new (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE, v BLOB, n REAL, memo TEXT DEFAULT 'x', extra INTEGER NOT NULL DEFAULT 7, tag TEXT);
      INSERT INTO e2_a_new (id, k, v, n, memo, extra, tag) SELECT id, k, v, n, memo, extra, 'copied' FROM e2_a;
      DROP TABLE e2_a;
      ALTER TABLE e2_a_new RENAME TO e2_a;
      CREATE INDEX e2_a_k ON e2_a (k)`);
  },
  (db) => {
    // A change to a table the application owns: a column with a default, on a table with rows.
    if (!has(db, "rules_rule", "e2_flag"))
      db.exec("ALTER TABLE rules_rule ADD COLUMN e2_flag INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE rules_rule SET e2_flag = 1 WHERE rowid % 2 = 0");
  },
  (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS e2_vol (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("INSERT OR REPLACE INTO e2_vol (id, v) VALUES (1, 'a'), (2, 'b')");
  },
  (db) => {
    // The same table changed and then made again with another shape in one request.
    db.exec("UPDATE e2_vol SET v = v || v");
    db.exec("DROP TABLE e2_vol");
    db.exec("CREATE TABLE e2_vol (id INTEGER PRIMARY KEY, v TEXT, w INTEGER DEFAULT 5)");
    db.exec("INSERT INTO e2_vol (id, v) VALUES (9, 'nine')");
  },
];

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tail that, when told, writes to the book's database just before it takes the next append: a
 * job that writes while a request's entry is on its way to the tail. */
function withLateWrites(
  inner: LogTier,
  database: () => Database | null,
  arm: { next: boolean; fired: number },
): LogTier {
  return {
    ...inner,
    async append(book, input) {
      if (arm.next) {
        arm.next = false;
        const db = database();
        if (db && exists(db, "e2_late")) {
          db.run("INSERT INTO e2_late (at) VALUES (?)", [`late ${arm.fired}`]);
          arm.fired += 1;
        }
      }
      return inner.append(book, input);
    },
  };
}

async function runBook(spec: BookSpec): Promise<BookResult> {
  const started = performance.now();
  const rng = Rng.derive(spec.seed, `e2-${spec.index}`);
  const directory = mkdtempSync(join(tmpdir(), `e2-book-${spec.index}-`));
  const bookId = `e2-${spec.index}`;
  const prefix = `e2/${spec.index}/`;
  const keys = new BookKeys(prefix, bookId);
  const tier = new MemoryLogTier({
    seed: spec.seed + spec.index,
    timeoutMs: 15,
    ...(spec.faults ? { faults: FAULTS } : {}),
  });
  const bulk = new MemoryObjectStore({ seed: spec.seed + spec.index });
  const cache = join(directory, "cache.sqlite");
  const result: BookResult = {
    index: spec.index,
    seed: spec.seed,
    legacy: spec.legacy,
    faults: spec.faults,
    sealing: spec.sealing,
    requests: 0,
    writes: 0,
    acknowledged: 0,
    refused: 0,
    retries: 0,
    replays: 0,
    entries: 0,
    bytes: 0,
    rollbacks: 0,
    conflicts: 0,
    uncertain: 0,
    resolvedOurs: 0,
    rebuilds: 0,
    unsentRebuilds: 0,
    resets: 0,
    readsDeferred: 0,
    readsLoggedFirst: 0,
    restartsClean: 0,
    restartsCrash: 0,
    restartsCold: 0,
    kills: 0,
    migrations: 0,
    migrationRollbacks: 0,
    lateChanges: 0,
    checks: 0,
    tablesCompared: 0,
    rowsCompared: 0,
    coldReads: 0,
    differences: [],
    failures: [],
    seconds: 0,
  };
  let incarnation = 0;
  let book: HostedBook | null = null;
  const late = { next: false, fired: 0 };

  const faultsOn = () => tier.configure({ faults: spec.faults ? FAULTS : {} });
  const faultsOff = () => {
    tier.configure({ faults: {} });
    // Faults scripted for the next calls would hit the checks too.
    tier.wire.clearScript();
  };

  const open = async (): Promise<HostedBook> => {
    for (let attempt = 1; ; attempt += 1) {
      incarnation += 1;
      const holder = `p${incarnation}`;
      try {
        return await openHostedApplication({
          tier: withLateWrites(tier.client(holder), () => book?.runtime.db ?? null, late),
          bulk,
          bookId,
          prefix,
          holder,
          path: cache,
          lease: { ttlMs: 500, renewEveryMs: 150 },
          sealing: spec.sealing ? { delayMs: 30 } : { delayMs: 0 },
          snapshots: spec.sealing ? { everyEntries: 90 } : { everyEntries: 0 },
          commit: { backoffMs: 2, conflictAttempts: 6, uncertainAttempts: 4 },
          readEffects: { mode: "defer", deferMs: 200 },
        });
      } catch (error) {
        const transient =
          error instanceof LeaseHeldElsewhereError ||
          error instanceof ObjectStoreUncertain ||
          error instanceof CommitUncertainError ||
          error instanceof CommitConflictError ||
          (error instanceof Error && /uncertain|timed out|unavailable/i.test(error.message));
        if (!transient || attempt > 200) throw error;
        await sleep(error instanceof LeaseHeldElsewhereError ? 80 : 5);
      }
    }
  };

  const tally = (target: HostedBook) => {
    const stats = target.runtime.stats;
    result.entries += stats.entriesWritten;
    result.bytes += stats.bytesWritten;
    result.rollbacks += stats.rollbacks;
    result.conflicts += stats.conflicts;
    result.uncertain += stats.uncertain;
    result.resolvedOurs += stats.resolvedOurs;
    result.rebuilds += stats.rebuilds;
    result.unsentRebuilds += stats.unsentRebuilds;
    result.resets += target.resets;
    result.readsDeferred += stats.readsDeferred;
    result.readsLoggedFirst += stats.readFlushes;
  };

  // The follower: a second process that never writes and only follows the log.
  let follower: { db: Database; capture: ChangeCapture } | null = null;
  const follow = async (): Promise<StateDigest> => {
    if (!follower) {
      const materialized = await materialize({
        tier,
        bulk,
        keys,
        schema: APPLICATION_SCHEMA,
        path: join(directory, "follower.sqlite"),
        exclude: APPLICATION_DERIVED,
      });
      follower = { db: materialized.db, capture: materialized.capture };
    } else {
      await catchUp(follower.db, follower.capture, {
        tier,
        bulk,
        keys,
        schema: APPLICATION_SCHEMA,
      });
    }
    return follower.capture.stateDigest();
  };

  const compare = (label: string, live: StateDigest, other: StateDigest) => {
    result.checks += 1;
    result.tablesCompared += Object.keys(live.tables).length;
    result.rowsCompared += Object.values(live.tables).reduce((sum, table) => sum + table.rows, 0);
    const differences = diffDigests(live, other);
    for (const difference of differences) result.differences.push(`${label}: ${difference}`);
    if (live.overall !== other.overall && differences.length === 0)
      result.differences.push(`${label}: the digests differ and no piece says where`);
  };

  /** Make the live cache the log's book exactly (finish a commit nobody was told about, log what reads
   * and late writes left unsent), with the faults off, and say what it holds. */
  const settle = async (
    target: HostedBook,
  ): Promise<{ digest: StateDigest; head: { seq: number; hash: string } }> => {
    faultsOff();
    try {
      await target.runtime.read(() => null);
      await target.runtime.flushDeferred();
      await target.runtime.read(() => null);
      return { digest: target.runtime.capture.stateDigest(), head: { ...target.runtime.head } };
    } finally {
      faultsOn();
    }
  };

  const check = async (label: string) => {
    if (!book) return;
    const { digest, head } = await settle(book);
    faultsOff();
    try {
      const followed = await follow();
      const followerHead = (follower as { capture: ChangeCapture } | null)?.capture.head();
      if (!followerHead || followerHead.seq !== head.seq || followerHead.hash !== head.hash)
        result.differences.push(
          `${label}: the follower is at ${followerHead?.seq ?? "nothing"}, the live book at ${head.seq}`,
        );
      else compare(`${label} (follower)`, digest, followed);
    } finally {
      faultsOn();
    }
  };

  /** A process that has nothing but the log reads the book from nothing. */
  const coldRead = async (
    label: string,
    live: StateDigest,
    head: { seq: number; hash: string },
  ) => {
    faultsOff();
    const path = join(directory, `cold-${result.coldReads}.sqlite`);
    try {
      const cold = await materialize({
        tier,
        bulk,
        keys,
        schema: APPLICATION_SCHEMA,
        path,
        exclude: APPLICATION_DERIVED,
        reuse: false,
      });
      try {
        if (cold.head.seq !== head.seq || cold.head.hash !== head.hash)
          result.differences.push(
            `${label}: a cold read ends at entry ${cold.head.seq}, the live book at ${head.seq}`,
          );
        else
          compare(`${label} (cold, from ${cold.stats.source})`, live, cold.capture.stateDigest());
      } finally {
        cold.db.close();
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      }
      result.coldReads += 1;
    } finally {
      faultsOn();
    }
  };

  const restart = async (kind: "clean" | "crash" | "cold") => {
    if (!book) return;
    const { digest, head } = await settle(book);
    tally(book);
    if (kind === "crash") {
      result.restartsCrash += 1;
      book.runtime.abandon();
      book.runtime.db.close();
    } else {
      if (kind === "clean") result.restartsClean += 1;
      await book.close();
    }
    if (kind === "cold") {
      result.restartsCold += 1;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${cache}${suffix}`, { force: true });
    }
    book = null;
    book = await open();
    const after = await settle(book);
    if (after.head.seq < head.seq)
      result.differences.push(
        `restart (${kind}): the book came back at entry ${after.head.seq}, it was at ${head.seq}`,
      );
    else if (after.head.seq === head.seq) {
      if (after.head.hash !== head.hash)
        result.differences.push(`restart (${kind}): entry ${head.seq} is not the one it was`);
      else compare(`restart (${kind})`, digest, after.digest);
    } else {
      // Something was appended after the book was last looked at and before it stopped (a snapshot's
      // announcement, a deferred flush): the restarted book must hold what a follower of the log holds.
      faultsOff();
      try {
        const followed = await follow();
        const followerHead = (follower as { capture: ChangeCapture } | null)?.capture.head();
        if (followerHead?.seq !== after.head.seq || followerHead.hash !== after.head.hash)
          result.differences.push(
            `restart (${kind}): the follower is at ${followerHead?.seq}, the restarted book at ${after.head.seq}`,
          );
        else compare(`restart (${kind}, ahead of what was last seen)`, after.digest, followed);
      } finally {
        faultsOn();
      }
    }
  };

  /** A release that changes the schema, applied to the live book. Its commit can fail like any other
   * and its transaction is then rolled back, DDL included; it is applied again. */
  const migrate = async (step: number) => {
    if (!book || step >= MIGRATIONS.length) return;
    const migration = MIGRATIONS[step] as (db: Database) => void;
    // Every other migration on a book whose tail fails meets an outage: its commit gives up, the
    // transaction (the schema change with it) is rolled back, and it is applied again.
    if (spec.faults && step % 2 === 0)
      tier.script([
        { op: "append", fault: "failBefore", times: 6 },
        { op: "head", fault: "failBefore", times: 6 },
      ]);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      try {
        const before = book.runtime.stats.rollbacks;
        await book.runtime.write((db) => migration(db), { label: `migration ${step}` });
        result.migrations += 1;
        result.migrationRollbacks += book.runtime.stats.rollbacks - before;
        return;
      } catch (error) {
        if (
          error instanceof CommitUncertainError ||
          error instanceof CommitConflictError ||
          error instanceof ObjectStoreUncertain ||
          error instanceof LeaseLostError ||
          error instanceof LeaseHeldElsewhereError
        ) {
          result.migrationRollbacks += 1;
          await sleep(5);
          continue;
        }
        throw error;
      }
    }
    result.failures.push(`migration ${step} could not be committed`);
  };

  /** The process dies while a write is being committed: its append has landed and it never saw the
   * answer. The client asks the next process again under the same identity. */
  const killDuringCommit = async () => {
    if (!book) return;
    await settle(book);
    const holder = `p${incarnation}`;
    const count = async (): Promise<number> => {
      const listed = await book?.fetch(operationRequest("drafts.list", {}));
      const body = (await listed?.json()) as
        | { ok?: boolean; data?: { count?: number } }
        | undefined;
      return body?.data?.count ?? -1;
    };
    const before = await count();
    const operationId = crypto.randomUUID();
    const draft = operationRequest(
      "drafts.create",
      {
        data: {
          date: "2026-05-05",
          reference: "kill",
          narration: "kill",
          lines: [
            { accountId: "6100", debit: "5.00", credit: "" },
            { accountId: "1010", debit: "", credit: "5.00" },
          ],
        },
      },
      operationId,
    );
    tier.script([{ op: "append", fault: "killAfter", client: holder, nth: 1 }]);
    const first = book.fetch(draft.clone());
    void first.catch(() => {});
    await Promise.race([first.then(() => "answered"), sleep(250).then(() => "silent")]);
    tier.wire.clearScript();
    result.kills += 1;
    tally(book);
    book.runtime.abandon();
    book.runtime.db.close();
    book = null;
    book = await open();
    const reply = await book.fetch(draft);
    const body = (await reply.json()) as { ok?: boolean };
    if (body.ok !== true)
      result.failures.push(
        `the request sent again after a kill was refused: ${JSON.stringify(body).slice(0, 200)}`,
      );
    const after = await count();
    if (before >= 0 && after !== before + 1)
      result.failures.push(
        `after a kill during a commit and a second try the drafts went from ${before} to ${after}`,
      );
  };

  /** A book that began at the previous schema: its migration reached the log as ordinary entries stamped
   * with the new schema, nothing is stamped higher, and a process of the previous release will not open
   * it, since it cannot read what the new one wrote. */
  const legacyChecks = async (): Promise<void> => {
    faultsOff();
    const stamps: number[] = [];
    let migration: { schema: number; changes: number } | null = null;
    const reader = readLog({
      tier,
      bulk,
      keys,
      schema: APPLICATION_SCHEMA,
      after: { seq: 0, hash: GENESIS_HASH },
    });
    for (let step = await reader.next(); !step.done; step = await reader.next()) {
      stamps.push(step.value.header.schema);
      if (step.value.header.seq === 2)
        migration = { schema: step.value.header.schema, changes: step.value.header.changes };
    }
    if (stamps[0] !== LEGACY_SCHEMA)
      result.failures.push(`the legacy book's first entry is at schema ${stamps[0]}`);
    if (!migration || migration.schema !== APPLICATION_SCHEMA || migration.changes === 0)
      result.failures.push(
        `the new release's migration did not reach the log as an ordinary entry (entry 2: ${JSON.stringify(migration)})`,
      );
    if (stamps.some((stamp) => stamp > APPLICATION_SCHEMA))
      result.failures.push("an entry is stamped above the schema of this release");
    if (stamps.some((stamp) => stamp < LEGACY_SCHEMA))
      result.failures.push("an entry is stamped below the legacy schema");
    try {
      const old = await openHostedApplication({
        tier: tier.client("old-release"),
        bulk,
        bookId,
        prefix,
        holder: "old-release",
        path: join(directory, "old-release.sqlite"),
        schema: LEGACY_SCHEMA,
        lease: { ttlMs: 500, renewEveryMs: 150 },
        sealing: { delayMs: 0 },
      });
      await old.close({ seal: false });
      result.failures.push(
        `a process of schema ${LEGACY_SCHEMA} opened a book with entries written at schema ${APPLICATION_SCHEMA}`,
      );
    } catch (error) {
      if (!(error instanceof EntryError && error.code === "schema"))
        result.failures.push(
          `a process of schema ${LEGACY_SCHEMA} was refused for the wrong reason: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  };

  try {
    if (spec.legacy) {
      // A book the previous release wrote, as the beginning of its log; the new release opens it next.
      faultsOff();
      const file = join(directory, "legacy.sqlite");
      writeFileSync(file, Bun.gunzipSync(readFileSync(LEGACY_FIXTURE)));
      await importBookFile({
        tier,
        bulk,
        bookId,
        prefix,
        path: file,
        schema: LEGACY_SCHEMA,
        exclude: APPLICATION_DERIVED,
      });
      faultsOn();
    }
    book = await open();
    const workload = new Workload(
      { fetch: (request) => (book as HostedBook).fetch(request) },
      rng,
      { retryDelayMs: 3, maxRetries: 25, resume: spec.legacy },
    );
    let nextCheck = spec.checkEvery;
    let nextRestart = spec.restartEvery;
    let nextMigration = spec.migrateEvery;
    let nextLate = spec.lateEvery;
    let nextBurst = spec.burstEvery;
    let bursts = 0;
    let nextKill = Math.max(spec.restartEvery * 2, 1);
    let restarts = 0;
    let migrations = 0;
    while (workload.counters.writes < spec.writes) {
      await workload.step();
      const writes = workload.counters.writes;
      if (writes >= nextMigration) {
        nextMigration += spec.migrateEvery;
        await migrate(migrations++);
      }
      if (writes >= nextLate) {
        nextLate += spec.lateEvery;
        late.next = true;
      }
      if (spec.faults && writes >= nextBurst) {
        nextBurst += spec.burstEvery;
        bursts += 1;
        // The tail goes away long enough for a commit to give up: an outage (the append was not
        // applied) or a run of lost answers (it was). The request is refused, the cache rolled back,
        // and the client asks again.
        tier.script(
          bursts % 2 === 1
            ? [
                { op: "append", fault: "failBefore", times: 6 },
                { op: "head", fault: "failBefore", times: 6 },
              ]
            : [
                { op: "append", fault: "failAfter", times: 6 },
                { op: "head", fault: "failBefore", times: 6 },
              ],
        );
      }
      if (writes >= nextCheck) {
        nextCheck += spec.checkEvery;
        await check(`after ${writes} writes`);
      }
      if (writes >= nextKill && spec.faults) {
        nextKill += spec.restartEvery * 3;
        await killDuringCommit();
      }
      if (writes >= nextRestart) {
        nextRestart += spec.restartEvery;
        restarts += 1;
        await restart(restarts % 3 === 1 ? "crash" : restarts % 3 === 2 ? "cold" : "clean");
      }
    }
    const counters = workload.counters;
    result.requests = counters.requests;
    result.writes = counters.writes;
    result.acknowledged = counters.acknowledged;
    result.refused = Object.values(counters.refused).reduce((sum, n) => sum + n, 0);
    result.retries = counters.retries;
    result.replays = counters.replays;
    result.lateChanges = late.fired;

    // The end: what the live book holds, what a follower holds, what a cold read holds, and what a cold
    // process answers to the same questions the live one answers.
    if (!book) throw new Error("The book is not open");
    const { digest, head } = await settle(book);
    await check("final");
    await coldRead("final", digest, head);
    const liveAnswers = await answersOf(book);
    tally(book);
    await book.close();
    book = null;
    book = await open();
    const coldAnswers = await answersOf(book);
    for (const [name, answer] of Object.entries(liveAnswers))
      if (answer !== coldAnswers[name])
        result.differences.push(
          `final: ${name} answered differently on a process that read the log`,
        );
    for (const id of workload.model.journals) {
      const reply = await book.fetch(operationRequest("journal.get", { journalId: id }));
      const body = (await reply.json()) as { ok?: boolean };
      if (body.ok !== true)
        result.failures.push(`journal ${id} was acknowledged and a cold process cannot find it`);
    }
    for (const [id] of workload.model.rules) {
      const reply = await book.fetch(operationRequest("rules.get", { ruleId: id }));
      const body = (await reply.json()) as { ok?: boolean };
      if (body.ok !== true)
        result.failures.push(`rule ${id} was acknowledged and a cold process cannot find it`);
    }
    tally(book);
    await book.close();
    book = null;
    if (spec.legacy) await legacyChecks();
  } catch (error) {
    result.failures.push(
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`.slice(0, 5000)
        : String(error),
    );
    try {
      if (book) {
        (book as HostedBook).runtime.abandon();
        (book as HostedBook).runtime.db.close();
      }
    } catch {
      // already gone
    }
  } finally {
    (follower as { db: Database } | null)?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  result.seconds = (performance.now() - started) / 1000;
  return result;
}

/** Answers to a fixed set of read operations, as text, to compare between two processes. */
async function answersOf(book: HostedBook): Promise<Record<string, string>> {
  const asks: [string, unknown][] = [
    ["accounts.list", {}],
    ["journal.list", { page: 1, status: "Posted" }],
    ["journal.list", { page: 2, status: "Posted" }],
    ["reports.get", { asOf: "2026-12-31" }],
    ["reports.get", { asOf: "2026-06-30" }],
    ["reports.cashFlow", { asOf: "2026-12-31" }],
    ["rules.list", {}],
    ["inbox.summary", {}],
    ["periods.list", {}],
    ["drafts.list", {}],
    ["book.get", {}],
  ];
  const out: Record<string, string> = {};
  for (const [index, [name, input]] of asks.entries()) {
    const reply = await book.fetch(operationRequest(name, input));
    out[`${index}:${name}`] = stable(await reply.text());
  }
  return out;
}

/** Drop what differs between two correct answers: when the answer was made. */
function stable(text: string): string {
  return text.replace(
    /"(?:at|generatedAt|computedAt|readAt|createdAt|updatedAt)":"[^"]*"/g,
    '"t":""',
  );
}

function emptyResult(spec: BookSpec): BookResult {
  return {
    index: spec.index,
    seed: spec.seed,
    legacy: spec.legacy,
    faults: spec.faults,
    sealing: spec.sealing,
    requests: 0,
    writes: 0,
    acknowledged: 0,
    refused: 0,
    retries: 0,
    replays: 0,
    entries: 0,
    bytes: 0,
    rollbacks: 0,
    conflicts: 0,
    uncertain: 0,
    resolvedOurs: 0,
    rebuilds: 0,
    unsentRebuilds: 0,
    resets: 0,
    readsDeferred: 0,
    readsLoggedFirst: 0,
    restartsClean: 0,
    restartsCrash: 0,
    restartsCold: 0,
    kills: 0,
    migrations: 0,
    migrationRollbacks: 0,
    lateChanges: 0,
    checks: 0,
    tablesCompared: 0,
    rowsCompared: 0,
    coldReads: 0,
    differences: [],
    failures: [],
    seconds: 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.has("worker")) {
    const spec = JSON.parse(args.string("worker", "{}")) as BookSpec;
    const result = await runBook(spec);
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  if (args.has("merge")) {
    // Combine the result files of several runs (of ranges of the same books) into one report.
    const merged: BookResult[] = [];
    let seconds = 0;
    for (const file of args.string("merge", "").split(",").filter(Boolean)) {
      const loaded = JSON.parse(readFileSync(file, "utf8")) as {
        results: BookResult[];
        totals: { seconds: number };
      };
      merged.push(...loaded.results);
      seconds += loaded.totals.seconds;
    }
    report(merged, seconds, args.number("require", 0), args.string("json", ""));
    return;
  }
  const totalWrites = args.number("writes", 3000);
  const books = args.number("books", 4);
  const workers = args.number("workers", 2);
  const seed = args.number("seed", 1);
  const perBook = Math.ceil(totalWrites / books);
  const specs: BookSpec[] = Array.from({ length: books }, (_, index) => ({
    index,
    seed,
    writes: perBook,
    // A book in four starts at the previous schema, when this release has a newer one.
    legacy: APPLICATION_SCHEMA > LEGACY_SCHEMA && index % 4 === 3,
    faults: index % 2 === 1,
    sealing: index % 3 !== 2,
    restartEvery: Math.max(40, Math.floor(perBook / 7)),
    migrateEvery: Math.max(30, Math.floor(perBook / (MIGRATIONS.length + 2))),
    checkEvery: Math.max(25, Math.floor(perBook / 12)),
    lateEvery: Math.max(20, Math.floor(perBook / 25)),
    burstEvery: Math.max(15, Math.floor(perBook / 40)),
  }));
  const range = args.string("range", "").split("-").map(Number);
  const first = range[0] ?? 0;
  const last = range[1] ?? books - 1;
  const queue = specs.filter((spec) => spec.index >= first && spec.index <= last);
  const requireWrites = args.has("range") ? args.number("require", 0) : totalWrites;
  const results: BookResult[] = [];
  const started = performance.now();
  const runWorker = async () => {
    for (;;) {
      const spec = queue.shift();
      if (!spec) return;
      const child = Bun.spawn(
        [process.execPath, import.meta.path, "--worker", JSON.stringify(spec)],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const line = out.split("\n").find((item) => item.startsWith("RESULT "));
      if (!line) {
        console.error(`book ${spec.index}: no result\n${err.slice(-1500)}`);
        results.push({
          ...emptyResult(spec),
          failures: [`the worker produced no result: ${err.slice(-400)}`],
        });
        continue;
      }
      const result = JSON.parse(line.slice(7)) as BookResult;
      results.push(result);
      console.error(
        `book ${result.index} done: ${result.writes} writes, ${result.entries} entries, ${result.checks} checks, ${result.differences.length} differences, ${result.failures.length} failures, ${result.seconds.toFixed(0)} s`,
      );
    }
  };
  await Promise.all(Array.from({ length: workers }, runWorker));
  report(results, (performance.now() - started) / 1000, requireWrites, args.string("json", ""));
}

function report(results: BookResult[], seconds: number, requireWrites: number, json: string): void {
  results.sort((a, b) => a.index - b.index);

  const sum = (pick: (result: BookResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const totals = {
    books: results.length,
    legacyBooks: results.filter((result) => result.legacy).length,
    requests: sum((r) => r.requests),
    writes: sum((r) => r.writes),
    acknowledged: sum((r) => r.acknowledged),
    refused: sum((r) => r.refused),
    retries: sum((r) => r.retries),
    replays: sum((r) => r.replays),
    entries: sum((r) => r.entries),
    bytes: sum((r) => r.bytes),
    rollbacks: sum((r) => r.rollbacks),
    conflicts: sum((r) => r.conflicts),
    uncertain: sum((r) => r.uncertain),
    resolvedOurs: sum((r) => r.resolvedOurs),
    rebuilds: sum((r) => r.rebuilds),
    unsentRebuilds: sum((r) => r.unsentRebuilds),
    resets: sum((r) => r.resets),
    readsDeferred: sum((r) => r.readsDeferred),
    readsLoggedFirst: sum((r) => r.readsLoggedFirst),
    restartsClean: sum((r) => r.restartsClean),
    restartsCrash: sum((r) => r.restartsCrash),
    restartsCold: sum((r) => r.restartsCold),
    kills: sum((r) => r.kills),
    migrations: sum((r) => r.migrations),
    migrationRollbacks: sum((r) => r.migrationRollbacks),
    lateChanges: sum((r) => r.lateChanges),
    checks: sum((r) => r.checks),
    tablesCompared: sum((r) => r.tablesCompared),
    rowsCompared: sum((r) => r.rowsCompared),
    coldReads: sum((r) => r.coldReads),
    differences: sum((r) => r.differences.length),
    failures: sum((r) => r.failures.length),
    seconds,
  };
  console.log(`\nE2: change capture on the real application. ${JSON.stringify(machine())}`);
  printTable(
    [
      "book",
      "faults",
      "writes",
      "requests",
      "entries",
      "rollbacks",
      "conflicts",
      "uncertain",
      "restarts c/x/cold",
      "kills",
      "migrations",
      "late changes",
      "checks",
      "tables x checks",
      "differences",
      "failures",
      "s",
    ],
    results.map((r) => [
      r.index,
      r.faults ? "yes" : "no",
      r.writes,
      r.requests,
      r.entries,
      r.rollbacks,
      r.conflicts,
      r.uncertain,
      `${r.restartsClean}/${r.restartsCrash}/${r.restartsCold}`,
      r.kills,
      r.migrations,
      r.lateChanges,
      r.checks,
      r.tablesCompared,
      r.differences.length,
      r.failures.length,
      r.seconds.toFixed(0),
    ]),
  );
  console.log(
    `\nTotal: ${totals.writes} write operations (${totals.requests} requests; ${totals.acknowledged} acknowledged, ${totals.refused} refused, ${totals.replays} replays identical, ${totals.retries} retries), ${totals.entries} entries, ${(totals.bytes / 1e6).toFixed(1)} MB; ${totals.rollbacks} rollbacks, ${totals.conflicts} conflicts, ${totals.uncertain} uncertain commits, ${totals.resolvedOurs} resolved as ours, ${totals.rebuilds} rebuilds (${totals.unsentRebuilds} for unsent changes); ${totals.restartsClean} clean restarts, ${totals.restartsCrash} crashes, ${totals.restartsCold} from nothing, ${totals.kills} kills during a commit; ${totals.migrations} migrations (${totals.migrationRollbacks} rolled back and applied again); ${totals.lateChanges} changes landing between a request's read and its settle; ${totals.readsDeferred} read effects deferred, ${totals.readsLoggedFirst} logged first; ${totals.checks} comparisons of ${totals.tablesCompared} tables and ${totals.rowsCompared} rows; ${totals.coldReads} cold reads${totals.legacyBooks > 0 ? `; ${totals.legacyBooks} books begun at schema ${LEGACY_SCHEMA}, opened and migrated by this release (schema ${APPLICATION_SCHEMA}), and refused by a process at schema ${LEGACY_SCHEMA}` : ""}.`,
  );
  for (const result of results) {
    for (const difference of result.differences.slice(0, 5))
      console.log(`DIFFERENCE book ${result.index}: ${difference}`);
    for (const failure of result.failures.slice(0, 5))
      console.log(`FAILURE book ${result.index}: ${failure}`);
  }
  const pass = totals.differences === 0 && totals.failures === 0 && totals.writes >= requireWrites;
  console.log(
    `\nE2: ${pass ? "PASS" : "FAIL"}: ${totals.differences} differences, ${totals.failures} failures over ${totals.writes} write operations (pass: zero differences over at least ${requireWrites}).`,
  );
  if (json) {
    writeFileSync(
      json,
      `${JSON.stringify({ totals, results, machine: machine(), seed: results[0]?.seed }, null, 2)}\n`,
    );
  }
  process.exit(totals.differences === 0 && totals.failures === 0 ? 0 : 1);
}

await main();

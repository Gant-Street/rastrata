import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeDurableBook, decodeBookOutcome, type BookCommand } from "@rastrata/kernel";
import { SqliteIndexedCanonicalStore } from "../src/indexed-canonical-store.ts";
import { SqliteIndexedSourceCatalog } from "../src/indexed-source-catalog.ts";
import { SqliteSemanticGroupCatalog, INDEXED_GROUP_CATALOG_FORMAT } from "../src/group-catalog.ts";
import { indexBookIdentityCommitment } from "../src/index-view-audit.ts";
import { projectLegacyIndexedBook } from "../src/indexed-book-state.ts";
import { prepareIndexedOutcomeRecord } from "../src/indexed-outcome-record.ts";
import { evaluateOutcomePayload, replayOutcomePayload } from "../src/outcome-payload.ts";
import { atomicSqlite, type SqliteTransaction } from "../src/sqlite-transaction.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { activation, genesis, posting, BOOK } from "./fixtures.ts";

async function fixture(initialize = true, initial = genesis(), path = ":memory:") {
  const db = new Database(path);
  if (path === ":memory:") {
    db.exec(
      "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
    );
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  const faults = {
    afterSql: "",
    killAfterSql: "",
    statements: [] as string[],
    syncs: 0,
    deny: false,
  };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        faults.statements.push(sql);
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
        ) as Record<string, unknown>[];
        if (faults.killAfterSql && sql.startsWith(faults.killAfterSql))
          process.kill(process.pid, "SIGKILL");
        if (faults.afterSql && sql.startsWith(faults.afterSql))
          throw new Error("injected canonical SQL failure");
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const k in row) {
            const v = row[k];
            if (v instanceof Uint8Array) {
              row[k] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    sync: async () => {
      faults.syncs++;
    },
  };
  const scope = {
    tenantId: "indexed-canonical-tenant",
    bookId: BOOK,
    objectId: "indexed-canonical-object",
    namespaceId: "indexed-canonical-namespace",
    generation: "0",
  };
  const canonical = new SqliteIndexedCanonicalStore(port, scope, scope.objectId);
  const source = new SqliteIndexedSourceCatalog(port, scope, scope.objectId, () =>
    canonical.readAnchor(),
  );
  const groupAnchor = () => ({
    identityHash: indexBookIdentityCommitment(scope),
    headHash: canonical.readAnchor().head.contentHash,
    sourceCatalogDigest: (
      db.query("SELECT digest FROM ledger_indexed_source_catalog").get() as { digest: string }
    ).digest,
  });
  const groups = new SqliteSemanticGroupCatalog(
    port,
    indexBookIdentityCommitment(scope),
    groupAnchor,
    INDEXED_GROUP_CATALOG_FORMAT,
  );
  let aggregate = initial;
  const encodedGenesis = encodeDurableBook(aggregate);
  const cp = await canonical.prepareGenesis(encodedGenesis),
    sp = await source.prepareGenesis(encodedGenesis);
  const confirm = async () => {
    if (faults.deny) throw new Error("canonical owner revoked");
  };
  const gp = await groups.prepareIndexed(source, sp, null, {
    confirm,
    readPrevious: async () => {
      throw new Error("unexpected genesis source read");
    },
  });
  const install = () =>
    atomicSqlite(port, (tx) => {
      canonical.publishInTransaction(tx, cp);
      source.publishInTransaction(tx, sp);
      groups.publishInTransaction(tx, gp);
    });
  if (initialize) install();
  let sourceDigest = sp.digest,
    groupDigest = gp.digest;
  const ports = {
    confirm,
    genesis: async (hash: string) => {
      const anchor = canonical.readAnchor();
      expect(hash).toBe(anchor.genesisHash);
      return canonical.readGenesis(anchor);
    },
    outcome: async (sequence: bigint, hash: string) =>
      canonical.readOutcome(canonical.readAnchor(), sequence, hash),
  };
  async function prepare(command: BookCommand) {
    const before = canonical.readAnchor();
    const evaluated = evaluateOutcomePayload(aggregate, command);
    if (!evaluated.encoded) throw new Error("Expected retained outcome");
    const afterAggregate = {
      state: evaluated.transition.state,
      protocol: evaluated.transition.protocol,
    };
    const { state } = await projectLegacyIndexedBook(encodeDurableBook(afterAggregate));
    const record = prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      before.state,
      before.head,
      state,
      evaluated.encoded,
    );
    const encoded = JSON.stringify(record);
    const canonicalPlan = canonical.prepareOutcome(before, encoded);
    const sourcePlan = await source.prepareOutcome(
      encoded,
      sourceDigest,
      evaluated.transition.intent ? (aggregate.state.revisions.at(-1) ?? null) : null,
    );
    const capture = source.capture(sourceDigest);
    let groupPlan: Awaited<ReturnType<SqliteSemanticGroupCatalog["prepareIndexed"]>>;
    try {
      groupPlan = await groups.prepareIndexed(source, sourcePlan, groupDigest, {
        confirm,
        readPrevious: (collection, ordinal) => source.read(capture, collection, ordinal, ports),
      });
    } finally {
      source.release(capture);
    }
    return { record, encoded, canonicalPlan, sourcePlan, groupPlan, afterAggregate };
  }
  type Plan = Awaited<ReturnType<typeof prepare>>;
  function select(plan: Plan, after?: () => void) {
    atomicSqlite(port, (tx) => {
      canonical.publishInTransaction(tx, plan.canonicalPlan);
      source.publishInTransaction(tx, plan.sourcePlan);
      groups.publishInTransaction(tx, plan.groupPlan);
      after?.();
    });
    aggregate = plan.afterAggregate;
    sourceDigest = plan.sourcePlan.digest;
    groupDigest = plan.groupPlan.digest;
  }
  async function publish(command: BookCommand) {
    const plan = await prepare(command);
    select(plan);
    return plan;
  }
  function dump() {
    return (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map(({ name }) => [name, db.query(`SELECT * FROM ${name} ORDER BY 1`).all()]);
  }
  return {
    db,
    port,
    scope,
    canonical,
    source,
    groups,
    faults,
    install,
    prepare,
    select,
    publish,
    dump,
    ports,
    encodedGenesis,
    get aggregate() {
      return aggregate;
    },
    get sourceDigest() {
      return sourceDigest;
    },
    get groupDigest() {
      return groupDigest;
    },
    reopen: () => new SqliteIndexedCanonicalStore(port, scope, scope.objectId),
  };
}

test("canonical SQLite composes with source/group publication and streams exact committed/rejected history", async () => {
  const f = await fixture();
  try {
    const plans = [
      await f.publish(activation()),
      await f.publish(posting("canonical-sale")),
      await f.publish(posting("canonical-stale", 0n)),
    ];
    const anchor = f.canonical.readAnchor(),
      opened = f.reopen();
    expect(opened.readAnchor()).toEqual(anchor);
    expect(opened.readGenesis(anchor)).toBe(f.encodedGenesis);
    let replay = genesis();
    const seen: string[] = [];
    const result = await opened.audit(anchor, {
      confirm: f.ports.confirm,
      outcome: async (record) => {
        seen.push(record.payload);
        const next = replayOutcomePayload(replay, record.payload);
        replay = { state: next.state, protocol: next.protocol };
      },
    });
    expect(result.outcomes).toBe(3n);
    expect(seen).toEqual(plans.map((p) => p.record.payload));
    expect(encodeDurableBook(replay)).toBe(encodeDurableBook(f.aggregate));
    for (const [i, plan] of plans.entries()) {
      const source = await opened.readOutcome(anchor, BigInt(i + 1), plan.record.contentHash);
      expect(source.encoded).toBe(plan.encoded);
      expect(source.authority.beforeHead).toEqual(plan.record.before);
    }
    expect(plans[2]?.record.after.bookRevision).toBe("2");
    await f.groups.verifyIndexed(f.source, anchor, f.sourceDigest, f.groupDigest, f.ports);
    expect(f.faults.syncs).toBe(0); // Transaction selection is not durable acknowledgement.
  } finally {
    f.db.close();
  }
});

test("canonical genesis schemas and every composed publication write roll back and reuse genuine plans", async () => {
  for (const point of [
    "CREATE TABLE ledger_indexed_canonical",
    "CREATE TABLE ledger_indexed_records",
    "CREATE TABLE ledger_indexed_record_chunks",
    "INSERT INTO ledger_indexed_records",
    "INSERT INTO ledger_indexed_record_chunks",
    "INSERT INTO ledger_indexed_canonical",
    "INSERT INTO ledger_indexed_source_catalog",
    "INSERT INTO ledger_indexed_group_catalog",
  ]) {
    const f = await fixture(false);
    try {
      const before = f.dump();
      f.faults.afterSql = point;
      expect(f.install).toThrow("injected canonical SQL failure");
      expect(f.dump()).toEqual(before);
      f.faults.afterSql = "";
      f.install();
      expect(f.reopen().readAnchor().head.sequence).toBe("0");
    } finally {
      f.db.close();
    }
  }
  for (const point of [
    "INSERT INTO ledger_indexed_records",
    "INSERT INTO ledger_indexed_record_chunks",
    "UPDATE ledger_indexed_canonical",
    "INSERT INTO ledger_indexed_source_nodes",
    "UPDATE ledger_indexed_source_catalog",
    "UPDATE ledger_indexed_group_catalog",
  ]) {
    const f = await fixture();
    try {
      const plan = await f.prepare(activation()),
        before = f.dump();
      f.faults.afterSql = point;
      expect(() => f.select(plan)).toThrow("injected canonical SQL failure");
      expect(f.dump()).toEqual(before);
      f.faults.afterSql = "";
      f.select(plan);
      expect(f.reopen().readAnchor().head.sequence).toBe("1");
      expect(() => f.select(plan)).toThrow("indexed_canonical_head_conflict");
    } finally {
      f.db.close();
    }
  }
});

test("canonical publication rejects stale heads, forged plans, foreign stores and expired transactions", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    const a = await f.prepare(activation());
    const b = await f.prepare(posting("stale-owner-plan", 0n));
    let expired: SqliteTransaction | undefined;
    atomicSqlite(f.port, (tx) => {
      expired = tx;
    });
    expect(() =>
      f.canonical.publishInTransaction(expired as SqliteTransaction, a.canonicalPlan),
    ).toThrow("sqlite_transaction_not_active");
    expect(() =>
      atomicSqlite(other.port, (tx) => f.canonical.publishInTransaction(tx, a.canonicalPlan)),
    ).toThrow("sqlite_transaction_not_active");
    expect(() =>
      atomicSqlite(f.port, (tx) => f.canonical.publishInTransaction(tx, { ...a.canonicalPlan })),
    ).toThrow("indexed_canonical_preparation_invalid");
    expect(() =>
      atomicSqlite(other.port, (tx) => other.canonical.publishInTransaction(tx, a.canonicalPlan)),
    ).toThrow("indexed_canonical_preparation_invalid");
    const before = f.dump();
    expect(() =>
      f.select(a, () => {
        throw new Error("later component refused");
      }),
    ).toThrow("later component refused");
    expect(f.dump()).toEqual(before);
    f.select(a);
    expect(() => f.select(b)).toThrow("indexed_canonical_head_conflict");
    expect(() => f.canonical.prepareOutcome(a.record.before as never, a.encoded)).toThrow();
    expect(() => new SqliteIndexedCanonicalStore(f.port, f.scope, "foreign-object")).toThrow(
      "ledger_identity_mismatch",
    );
    expect(() =>
      new SqliteIndexedCanonicalStore(
        f.port,
        { ...f.scope, tenantId: "foreign-tenant" },
        f.scope.objectId,
      ).readAnchor(),
    ).toThrow();
  } finally {
    f.db.close();
    other.db.close();
  }
});

test("streamed canonical audit fails closed on gaps, corrupt chunks, extras, callback failure and revoked authority", async () => {
  for (const damage of [
    "gap",
    "missing-chunk",
    "substitute-chunk",
    "extra-record",
    "extra-chunk",
    "metadata-version",
    "callback",
    "revoked",
    "head-race",
  ] as const) {
    const f = await fixture();
    try {
      await f.publish(activation());
      await f.publish(posting("audit-sale"));
      const anchor = f.canonical.readAnchor();
      const id = "0000000000000001";
      if (damage === "gap")
        f.db.query("DELETE FROM ledger_indexed_records WHERE record_id = ?").run(id);
      if (damage === "missing-chunk")
        f.db.query("DELETE FROM ledger_indexed_record_chunks WHERE record_id = ?").run(id);
      if (damage === "substitute-chunk")
        f.db
          .query(
            "UPDATE ledger_indexed_record_chunks SET bytes = zeroblob(length(bytes)) WHERE record_id = ?",
          )
          .run(id);
      if (damage === "extra-record")
        f.db.exec(
          "INSERT INTO ledger_indexed_records SELECT 'orphan', bytes, chunks, digest FROM ledger_indexed_records WHERE record_id = 'genesis'",
        );
      if (damage === "extra-chunk")
        f.db.exec(
          "INSERT INTO ledger_indexed_record_chunks SELECT 'orphan', ordinal, bytes FROM ledger_indexed_record_chunks WHERE record_id = 'genesis'",
        );
      if (damage === "metadata-version")
        f.db.exec("UPDATE ledger_indexed_canonical SET version = version || char(0)");
      const next =
        damage === "head-race" ? await f.prepare(posting("racing-publication", 2n)) : undefined;
      let calls = 0;
      const before = f.dump();
      await expect(
        f.canonical.audit(anchor, {
          confirm: f.ports.confirm,
          outcome: async () => {
            calls++;
            if (damage === "callback") throw new Error("accounting replay refused");
            if (damage === "revoked") f.faults.deny = true;
            if (next) f.select(next);
          },
        }),
      ).rejects.toThrow();
      if (damage !== "head-race") expect(f.dump()).toEqual(before);
      if (["callback", "revoked", "head-race"].includes(damage)) expect(calls).toBe(1);
    } finally {
      f.db.close();
    }
  }
});

test("targeted canonical sources verify exact authenticated hash, scope, predecessor and live head", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    const plan = await f.publish(posting("targeted-source"));
    const anchor = f.canonical.readAnchor();
    await expect(f.canonical.readOutcome(anchor, 2n, "0".repeat(64))).rejects.toThrow(
      "indexed_canonical_source_invalid",
    );
    for (const seq of [0n, -1n, 3n, 1n << 64n])
      await expect(f.canonical.readOutcome(anchor, seq, plan.record.contentHash)).rejects.toThrow();
    f.faults.statements.length = 0;
    const source = await f.canonical.readOutcome(anchor, 2n, plan.record.contentHash);
    expect(source.encoded).toBe(plan.encoded);
    expect(f.faults.statements.some((sql) => sql.includes("count(*)"))).toBe(false);
    expect(
      f.faults.statements.filter((sql) => sql.includes("FROM ledger_indexed_records")),
    ).toHaveLength(2);
    const payload = decodeBookOutcome(JSON.parse(source.encoded).payload);
    expect(payload.disposition).toBe("decoded");
    await f.publish(posting("later-source", 2n));
    await expect(f.canonical.readOutcome(anchor, 2n, plan.record.contentHash)).rejects.toThrow(
      "indexed_canonical_head_conflict",
    );
    f.db.query("DELETE FROM ledger_indexed_records WHERE record_id = ?").run("0000000000000001");
    await expect(
      f.canonical.readOutcome(f.canonical.readAnchor(), 2n, plan.record.contentHash),
    ).rejects.toThrow("indexed_canonical_record_missing_or_corrupt");
  } finally {
    f.db.close();
  }
});

test("canonical initialization cannot adopt any existing ledger and empty audit still confirms authority", async () => {
  const f = await fixture(false);
  try {
    f.db.exec("CREATE TABLE ledger_metadata (body TEXT)");
    const before = f.dump();
    expect(f.install).toThrow("indexed_canonical_initialization_conflict");
    expect(f.dump()).toEqual(before);
  } finally {
    f.db.close();
  }
  const empty = await fixture();
  try {
    expect(
      await empty.canonical.audit(empty.canonical.readAnchor(), {
        confirm: empty.ports.confirm,
        outcome: async () => {
          throw new Error("empty book has no outcomes");
        },
      }),
    ).toMatchObject({ outcomes: 0n });
    let confirms = 0;
    await expect(
      empty.canonical.audit(empty.canonical.readAnchor(), {
        confirm: async () => {
          if (++confirms === 3) throw new Error("final empty audit revoked");
        },
        outcome: async () => {},
      }),
    ).rejects.toThrow("final empty audit revoked");
  } finally {
    empty.db.close();
  }
});

test("canonical chunks preserve split UTF-8 and refuse oversized, reordered or retyped durable values", async () => {
  const initial = genesis("€".repeat(100000));
  const f = await fixture(true, initial);
  try {
    await f.publish(activation());
    const plan = await f.publish(posting("multichunk", 1n, true, "€".repeat(60000)));
    const anchor = f.canonical.readAnchor();
    const manifest = f.db
      .query("SELECT chunks FROM ledger_indexed_records WHERE record_id = 'genesis'")
      .get() as { chunks: number };
    expect(manifest.chunks).toBeGreaterThan(1);
    const outcomeManifest = f.db
      .query("SELECT chunks FROM ledger_indexed_records WHERE record_id = '0000000000000002'")
      .get() as { chunks: number };
    expect(outcomeManifest.chunks).toBeGreaterThan(1);
    expect(f.reopen().readGenesis(anchor)).toBe(encodeDurableBook(initial));
    expect((await f.reopen().readOutcome(anchor, 2n, plan.record.contentHash)).encoded).toBe(
      plan.encoded,
    );
    let replay = initial;
    await f.canonical.audit(anchor, {
      confirm: f.ports.confirm,
      outcome: async (record) => {
        const next = replayOutcomePayload(replay, record.payload);
        replay = { state: next.state, protocol: next.protocol };
      },
    });
    expect(encodeDurableBook(replay)).toBe(encodeDurableBook(f.aggregate));
    const saved = f.db
      .query(
        "SELECT bytes FROM ledger_indexed_record_chunks WHERE record_id = 'genesis' AND ordinal = 0",
      )
      .get() as { bytes: Uint8Array };
    for (const bad of [new Uint8Array(262145), "text-not-blob", new Uint8Array(0)]) {
      f.db
        .query(
          "UPDATE ledger_indexed_record_chunks SET bytes = ? WHERE record_id = 'genesis' AND ordinal = 0",
        )
        .run(bad);
      expect(() => f.canonical.readGenesis(anchor)).toThrow("indexed_canonical_chunks_corrupt");
    }
    f.db
      .query(
        "UPDATE ledger_indexed_record_chunks SET bytes = ? WHERE record_id = 'genesis' AND ordinal = 0",
      )
      .run(saved.bytes);
    f.db.exec(
      "UPDATE ledger_indexed_record_chunks SET ordinal = 100 WHERE record_id = 'genesis' AND ordinal = 0",
    );
    expect(() => f.canonical.readGenesis(anchor)).toThrow("indexed_canonical_chunks_corrupt");
  } finally {
    f.db.close();
  }
});

test("canonical metadata and manifests reject noncanonical bounds without returning a partial source", async () => {
  for (const sql of [
    "UPDATE ledger_indexed_records SET bytes = 16777217 WHERE record_id = 'genesis'",
    "UPDATE ledger_indexed_records SET bytes = 0 WHERE record_id = 'genesis'",
    "UPDATE ledger_indexed_records SET chunks = chunks + 1 WHERE record_id = 'genesis'",
    "UPDATE ledger_indexed_records SET digest = digest || char(0) WHERE record_id = 'genesis'",
    "UPDATE ledger_indexed_canonical SET body = body || char(0)",
    "UPDATE ledger_indexed_canonical SET body = zeroblob(524289)",
    "DELETE FROM ledger_indexed_canonical",
  ]) {
    const f = await fixture();
    try {
      const expected = f.canonical.readAnchor();
      f.db.exec(sql);
      const before = f.dump();
      expect(() => f.canonical.readGenesis(expected)).toThrow();
      await expect(
        f.canonical.audit(expected, { confirm: f.ports.confirm, outcome: async () => {} }),
      ).rejects.toThrow();
      expect(f.dump()).toEqual(before);
    } finally {
      f.db.close();
    }
  }
});

test.skipIf(!process.env.RASTRATA_CANONICAL_CRASH_PATH)("canonical crash child", async () => {
  const path = process.env.RASTRATA_CANONICAL_CRASH_PATH;
  const point = process.env.RASTRATA_CANONICAL_CRASH_POINT;
  if (
    !path ||
    !point ||
    ![
      "INSERT INTO ledger_indexed_record_chunks",
      "UPDATE ledger_indexed_canonical",
      "UPDATE ledger_indexed_source_catalog",
      "UPDATE ledger_indexed_group_catalog",
      "committed",
    ].includes(point)
  )
    throw new Error("Invalid canonical crash request");
  const f = await fixture(true, genesis(), path);
  await f.publish(activation());
  if (point !== "committed") f.faults.killAfterSql = point;
  await f.publish(posting("crash-sale"));
  process.kill(process.pid, "SIGKILL");
});

test("process termination never selects partial canonical/source/group history", async () => {
  for (const point of [
    "INSERT INTO ledger_indexed_record_chunks",
    "UPDATE ledger_indexed_canonical",
    "UPDATE ledger_indexed_source_catalog",
    "UPDATE ledger_indexed_group_catalog",
    "committed",
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "rastrata-indexed-canonical-crash-"));
    const path = join(directory, "book.sqlite");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout",
          "60000",
          import.meta.path,
          "--test-name-pattern",
          "^canonical crash child$",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            RASTRATA_CANONICAL_CRASH_PATH: path,
            RASTRATA_CANONICAL_CRASH_POINT: point,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timer = setTimeout(() => child.kill(), 20000);
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      clearTimeout(timer);
      expect({ exit, signal: child.signalCode, output: out + err }).toMatchObject({
        signal: "SIGKILL",
      });
      const db = new Database(path);
      try {
        const port: SqliteStorage = {
          sql: {
            exec: (sql, ...bindings) => {
              const rows = db
                .query(sql)
                .all(
                  ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
                ) as Record<string, unknown>[];
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                for (const k in row) {
                  const v = row[k];
                  if (v instanceof Uint8Array) {
                    row[k] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
                  }
                }
              }
              return rows;
            },
          },
          transactionSync: (operation) => db.transaction(operation)(),
          sync: async () => {},
        };
        const scope = {
          tenantId: "indexed-canonical-tenant",
          bookId: BOOK,
          objectId: "indexed-canonical-object",
          namespaceId: "indexed-canonical-namespace",
          generation: "0",
        };
        const canonical = new SqliteIndexedCanonicalStore(port, scope, scope.objectId);
        const anchor = canonical.readAnchor();
        expect(anchor.head.sequence).toBe(point === "committed" ? "2" : "1");
        let replay = genesis();
        const confirm = async () => {
          expect(canonical.readAnchor()).toEqual(anchor);
        };
        await canonical.audit(anchor, {
          confirm,
          outcome: async (record) => {
            const next = replayOutcomePayload(replay, record.payload);
            replay = { state: next.state, protocol: next.protocol };
          },
        });
        let expected = evaluateOutcomePayload(genesis(), activation()).transition;
        if (point === "committed")
          expected = evaluateOutcomePayload(
            { state: expected.state, protocol: expected.protocol },
            posting("crash-sale"),
          ).transition;
        expect(encodeDurableBook(replay)).toBe(
          encodeDurableBook({ state: expected.state, protocol: expected.protocol }),
        );
        const source = new SqliteIndexedSourceCatalog(port, scope, scope.objectId, () =>
          canonical.readAnchor(),
        );
        const sourceDigest = (
          db.query("SELECT digest FROM ledger_indexed_source_catalog").get() as { digest: string }
        ).digest;
        const groupDigest = (
          db.query("SELECT digest FROM ledger_indexed_group_catalog").get() as { digest: string }
        ).digest;
        const groups = new SqliteSemanticGroupCatalog(
          port,
          indexBookIdentityCommitment(scope),
          () => ({
            identityHash: indexBookIdentityCommitment(scope),
            headHash: canonical.readAnchor().head.contentHash,
            sourceCatalogDigest: sourceDigest,
          }),
          INDEXED_GROUP_CATALOG_FORMAT,
        );
        await groups.verifyIndexed(source, anchor, sourceDigest, groupDigest, {
          confirm,
          genesis: async () => canonical.readGenesis(anchor),
          outcome: (seq, hash) => canonical.readOutcome(anchor, seq, hash),
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("caller mutation cannot poison the cached canonical anchor", async () => {
  const f = await fixture();
  try {
    const anchor = f.canonical.readAnchor();
    const originalGenesisHash = anchor.genesisHash;

    // Attempted caller mutations must fail and not affect the frozen anchor
    expect(Reflect.set(anchor, "genesisHash", "0".repeat(64))).toBe(false);
    expect(() => {
      (anchor as unknown as Record<string, unknown>).genesisHash = "0".repeat(64);
    }).toThrow();

    // Warm read must return untainted original data
    const warm = f.canonical.readAnchor();
    expect(warm.genesisHash).toBe(originalGenesisHash);
    expect(warm).toBe(anchor);

    // Reopened read must agree with warm read
    const reopened = f.reopen().readAnchor();
    expect(reopened.genesisHash).toBe(originalGenesisHash);
    expect(warm).toEqual(reopened);
  } finally {
    f.db.close();
  }
});

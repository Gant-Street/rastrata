import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  encodeDurableBook,
  decodeDurableBook,
  executeBookCommand,
  commandId,
  encodeBookRow,
  sealCommand,
  compareCanonicalText,
  inventoryCostLayersMatch,
  instant,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { IndexedLedgerOwner } from "../src/indexed-ledger-owner.ts";
import { SqliteIndexedSourceCatalog } from "../src/indexed-source-catalog.ts";
import { SqliteIndexedCanonicalStore } from "../src/indexed-canonical-store.ts";
import { OutcomeOutbox } from "../src/outcome-outbox.ts";
import { R2ArchiveObjectStore } from "../src/r2-archive-store.ts";
import { replayOutcomePayload } from "../src/outcome-payload.ts";
import { withBucket } from "./r2-fixtures.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { activation, genesis, posting, BOOK } from "./fixtures.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";
import { checkIndexedReader } from "./indexed-reader-conformance.ts";
import {
  lotIdentityWorkflow,
  allocationAndTaxWorkflow,
  admissionFxWorkflow,
  inventoryReadWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";

function fixture(scheduleArchive?: () => Promise<void>) {
  const db = new Database(":memory:");
  db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000;");
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const faults = {
    afterSql: "",
    loseAfterSql: "",
    syncFailures: 0,
    fenceAfterSql: "",
    pendingAfterSql: "",
    expireAfterSql: "",
    now: 10n,
    fence: "0",
    pending: false,
    publication: false,
    fired: 0,
  };
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        if (sql.startsWith("INSERT INTO ledger_indexed_records")) faults.publication = true;
        let stmt = stmtCache.get(sql);
        if (stmt === undefined) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
        ) as Record<string, unknown>[];
        if (faults.afterSql && sql.startsWith(faults.afterSql) && faults.publication) {
          faults.fired++;
          throw new Error("injected indexed owner SQL failure");
        }
        if (faults.loseAfterSql && sql.startsWith(faults.loseAfterSql) && faults.publication) {
          faults.loseAfterSql = "";
          faults.syncFailures++;
          faults.fired++;
        }
        if (faults.fenceAfterSql && sql.startsWith(faults.fenceAfterSql)) {
          faults.fenceAfterSql = "";
          faults.fence = "1";
          faults.fired++;
        }
        if (faults.pendingAfterSql && sql.startsWith(faults.pendingAfterSql)) {
          faults.pendingAfterSql = "";
          faults.pending = true;
          faults.fired++;
        }
        if (faults.expireAfterSql && sql.startsWith(faults.expireAfterSql)) {
          faults.expireAfterSql = "";
          faults.now += 100000n;
          faults.fired++;
        }
        if (rows.length === 0) return rows;
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
    transactionSync: (operation) => {
      try {
        return db.transaction(operation)();
      } finally {
        faults.publication = false;
      }
    },
    sync: async () => {
      if (faults.syncFailures) {
        faults.syncFailures--;
        throw new Error("lost indexed owner durability response");
      }
    },
  };
  const scope = {
    tenantId: "indexed-owner-tenant",
    bookId: BOOK,
    objectId: "indexed-owner-object",
    namespaceId: "indexed-owner-namespace",
    generation: "0",
  };
  const open = () =>
    new IndexedLedgerOwner(
      port,
      scope,
      scope.objectId,
      () => ({ fence: faults.fence, pending: faults.pending }),
      () => faults.now,
      undefined,
      undefined,
      scheduleArchive,
    );
  const canonicalDump = () =>
    [
      "ledger_indexed_canonical",
      "ledger_indexed_records",
      "ledger_indexed_record_chunks",
      "ledger_indexed_source_catalog",
      "ledger_indexed_source_nodes",
      "ledger_indexed_source_origins",
      "ledger_indexed_group_catalog",
      "ledger_indexed_group_nodes",
      "ledger_indexed_group_descriptors",
      "ledger_index_control",
    ].map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  return { db, port, scope, faults, open, owner: open(), canonicalDump };
}

test("warm owner reuses verified transitions; explicit audit, restart and uncertainty require full recovery", async () => {
  const f = fixture();
  const audit = SqliteIndexedCanonicalStore.prototype.audit;
  let audits = 0;
  SqliteIndexedCanonicalStore.prototype.audit = function (...args) {
    audits++;
    return audit.apply(this, args);
  };
  try {
    await f.owner.provision(genesis());
    expect(audits).toBe(1);
    await f.owner.execute(activation());
    let expected: DurableBookAggregate = (() => {
      const result = executeBookCommand(genesis().state, genesis().protocol, activation());
      return { state: result.state, protocol: result.protocol };
    })();
    for (let i = 0; i < 4; i++) {
      const command = posting(`warm-${i}`, expected.state.bookRevision);
      const result = await f.owner.execute(command);
      expect(result.result.disposition).toBe("committed");
      const next = executeBookCommand(expected.state, expected.protocol, command);
      expected = { state: next.state, protocol: next.protocol };
    }
    const snapshot = await f.owner.read();
    expect(Object.isFrozen(snapshot.aggregate)).toBe(true);
    expect(Reflect.set(snapshot.aggregate, "state", genesis().state)).toBe(false);
    expect(encodeDurableBook(snapshot.aggregate)).toBe(encodeDurableBook(expected));
    expect(audits).toBe(1);
    expect((await f.owner.audit()).head).toEqual(snapshot.head);
    expect(audits).toBe(2);
    expect((await f.open().read()).head).toEqual(snapshot.head);
    expect(audits).toBe(3);
    f.faults.syncFailures = 1;
    await expect(f.owner.read()).rejects.toThrow("lost indexed owner durability response");
    expect((await f.owner.read()).head).toEqual(snapshot.head);
    expect(audits).toBe(4);
  } finally {
    SqliteIndexedCanonicalStore.prototype.audit = audit;
    f.db.close();
  }
}, 60000);

test("warm verification defers untouched historical damage but actual retries and full audits fail closed", async () => {
  const f = fixture();
  try {
    await f.owner.provision(genesis());
    await f.owner.execute(activation());
    const first = posting("damaged-history");
    await f.owner.execute(first);
    await f.owner.execute(posting("newer-history", 2n));
    const expected = await f.owner.read();
    f.db
      .query("DELETE FROM ledger_indexed_record_chunks WHERE record_id = '0000000000000002'")
      .run();
    const damaged = f.canonicalDump();
    // A warm cached view is not an assertion that every historical SQL byte was read.
    expect((await f.owner.read()).head).toEqual(expected.head);
    await expect(f.owner.execute(first)).rejects.toThrow();
    await expect(f.owner.audit()).rejects.toThrow();
    await expect(f.open().read()).rejects.toThrow();
    expect(f.canonicalDump()).toEqual(damaged);
  } finally {
    f.db.close();
  }
});

test("warm session checks catalog bodies and invalidates when another owner advances the full head", async () => {
  const f = fixture();
  try {
    await f.owner.provision(genesis());
    await f.owner.execute(activation());
    await f.open().execute(posting("other-owner"));
    const next = await f.owner.execute(posting("following-owner", 2n));
    expect(next.result.disposition).toBe("committed");
    expect(next.head.sequence).toBe("3");
    const before = f.db.query("SELECT body FROM ledger_indexed_source_catalog").get() as {
      body: string;
    };
    f.db.query("UPDATE ledger_indexed_source_catalog SET body = ?").run(`${before.body} `);
    await expect(f.owner.read()).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

test("outcome log is a bounded resumable R2 outbox including rejections; archive reconstructs exact accounting", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    const store = () => new R2ArchiveObjectStore(bucket, f.scope, f.scope.objectId);
    try {
      await f.owner.provision(genesis());
      const commands = [activation(), posting("archived-sale"), posting("archived-rejection", 0n)];
      for (const command of commands) await f.owner.execute(command);
      const before = await f.owner.read();
      expect(await new OutcomeOutbox(f.owner, store()).drain(1)).toEqual({
        disposition: "advanced",
        through: 1n,
        pending: 2n,
      });
      // Recreate BOTH relay and owner; progress is durable, not process-local.
      const restarted = new OutcomeOutbox(f.open(), store());
      expect(await restarted.drain(1)).toEqual({
        disposition: "advanced",
        through: 2n,
        pending: 1n,
      });
      expect(await restarted.drain(1)).toEqual({
        disposition: "advanced",
        through: 3n,
        pending: 0n,
      });
      const offline = new OutcomeOutbox(
        {
          archiveScope: f.owner.archiveScope,
          readArchivePage: async () => {
            throw new Error("Primary ledger unavailable");
          },
        },
        store(),
      );
      const archived = await offline.inspect();
      expect(archived.through).toBe(3n);
      expect(archived.genesis).toBe(encodeDurableBook(genesis()));
      const decoded = decodeDurableBook(archived.genesis);
      if (decoded.disposition !== "decoded") throw new Error("Archived genesis did not decode");
      let restored: DurableBookAggregate = decoded.aggregate;
      for (const encoded of archived.outcomes) {
        const record = JSON.parse(encoded);
        const next = replayOutcomePayload(restored, record.payload);
        restored = { state: next.state, protocol: next.protocol };
      }
      expect(encodeDurableBook(restored)).toBe(encodeDurableBook(before.aggregate));
      for (const command of commands)
        expect((await f.owner.execute(command)).result.disposition).toBe("replayed");
      expect(await restarted.drain()).toEqual({ disposition: "idle", through: 3n, pending: 0n });
      expect((await f.owner.read()).head).toEqual(before.head);
      await expect(f.owner.readArchivePage(4n, "0".repeat(64))).rejects.toThrow(
        "archive_cursor_conflict",
      );
      await expect(f.owner.readArchivePage(2n, "0".repeat(64))).rejects.toThrow(
        "archive_cursor_conflict",
      );
      expect(() => f.owner.readArchivePage(0n, null, 17)).toThrow("archive_cursor_invalid");
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("outbox outages do not affect saves; a lost R2 cursor reply resumes without duplicate history", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    let unavailable = true,
      loseControlReply = false,
      lost = 0;
    const remote = {
      get: (key: string) => {
        if (unavailable) throw new Error("archive offline");
        return bucket.get(key);
      },
      put: async (...args: Parameters<typeof bucket.put>) => {
        if (unavailable) throw new Error("archive offline");
        const result = await bucket.put(...args);
        if (loseControlReply && args[0].endsWith("/control/anchor")) {
          loseControlReply = false;
          lost++;
          throw new Error("lost successful control reply");
        }
        return result;
      },
    };
    const open = () =>
      new OutcomeOutbox(f.owner, new R2ArchiveObjectStore(remote, f.scope, f.scope.objectId));
    try {
      await f.owner.provision(genesis());
      expect((await f.owner.execute(activation())).result.disposition).toBe("committed");
      await expect(open().drain()).rejects.toThrow("archive offline");
      expect((await f.owner.execute(posting("during-archive-outage"))).result.disposition).toBe(
        "committed",
      );
      unavailable = false;
      loseControlReply = true;
      await expect(open().drain()).rejects.toThrow("archive_write_uncertain");
      expect(lost).toBe(1);
      expect(await open().drain()).toEqual({ disposition: "advanced", through: 2n, pending: 0n });
      expect((await open().inspect()).outcomes).toHaveLength(2);
      expect(await open().drain()).toEqual({ disposition: "idle", through: 2n, pending: 0n });
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("outbox concurrent deliveries converge and missing archived evidence is never repaired silently", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    const store = new R2ArchiveObjectStore(bucket, f.scope, f.scope.objectId);
    const relay = new OutcomeOutbox(f.owner, store);
    try {
      await f.owner.provision(genesis());
      await f.owner.execute(activation());
      const attempts = await Promise.all([
        relay.drain(1),
        new OutcomeOutbox(f.owner, store).drain(1),
      ]);
      expect(attempts.some((result) => result.disposition === "advanced")).toBe(true);
      await relay.drain();
      expect((await relay.inspect()).outcomes).toHaveLength(1);
      const control = await store.readControl();
      expect(control).not.toBeNull();
      if (!control) throw new Error("Missing test archive control");
      const ref = JSON.parse(control.body).manifest;
      const archived = JSON.parse(new TextDecoder().decode(await store.readImmutable(ref)));
      await bucket.delete(archived.payload.objectKey);
      await expect(relay.inspect()).rejects.toThrow("archive_payload_missing");
      expect((await store.readControl())?.body).toBe(control.body);
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("outbox rejects cross-book binding and structurally valid forged archive history", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    const store = new R2ArchiveObjectStore(bucket, f.scope, f.scope.objectId);
    try {
      expect(
        () =>
          new OutcomeOutbox(
            f.owner,
            new R2ArchiveObjectStore(
              bucket,
              { ...f.scope, tenantId: "another-tenant" },
              f.scope.objectId,
            ),
          ),
      ).toThrow("archive_identity_mismatch");
      const relay = new OutcomeOutbox(f.owner, store);
      await f.owner.provision(genesis());
      await f.owner.execute(activation());
      await relay.drain();
      const control = await store.readControl();
      if (!control) throw new Error("Missing archive control");
      const pointer = JSON.parse(control.body).manifest;
      const original = JSON.parse(new TextDecoder().decode(await store.readImmutable(pointer)));
      for (const [change, diagnostic] of [
        [{ recordHash: "0".repeat(64) }, "archive_cursor_conflict"],
        [{ sequence: "2" }, "archive_cursor_conflict"],
        [{ format: "unknown" }, "outbox_manifest_invalid"],
        [{ genesisHash: "0".repeat(64) }, "archive_cursor_conflict"],
      ] as const) {
        const forged = await store.putImmutable(
          new TextEncoder().encode(JSON.stringify({ ...original, ...change })),
        );
        await store.compareAndSwapControl(
          await store.readControl(),
          JSON.stringify({ format: original.format, manifest: forged }),
        );
        await expect(relay.inspect()).rejects.toThrow(diagnostic);
      }
      await store.compareAndSwapControl(await store.readControl(), control.body);
      expect((await relay.inspect()).through).toBe(1n);
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("stalled archive upload releases the book queue and a later drain catches concurrent saves", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let hold = true;
    const store = new R2ArchiveObjectStore(
      {
        get: (key) => bucket.get(key),
        async put(key, bytes, options) {
          if (hold) {
            hold = false;
            entered();
            await stalled;
          }
          return bucket.put(key, bytes, options);
        },
      },
      f.scope,
      f.scope.objectId,
    );
    const relay = new OutcomeOutbox(f.owner, store);
    let draining: ReturnType<OutcomeOutbox["drain"]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await f.owner.provision(genesis());
      await f.owner.execute(activation());
      draining = relay.drain();
      await started;
      const saved = await Promise.race([
        f.owner.execute(posting("during-archive")),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Archive held the book queue")), 10000);
        }),
      ]);
      expect(saved.result.disposition).toBe("committed");
      resume();
      expect((await draining).through).toBe(1n);
      expect((await relay.drain()).through).toBe(2n);
      expect((await relay.inspect()).outcomes).toHaveLength(2);
    } finally {
      if (timer) clearTimeout(timer);
      resume();
      await draining?.catch(() => undefined);
      f.db.close();
    }
  });
}, 60000);

test("durable archive scheduling failure prevents new publication but not exact retry", async () => {
  let unavailable = false;
  let arms = 0;
  const f = fixture(async () => {
    arms++;
    if (unavailable) throw new Error("scheduler unavailable");
  });
  try {
    await f.owner.provision(genesis());
    await f.owner.execute(activation());
    const before = f.canonicalDump();
    unavailable = true;
    await expect(f.owner.execute(posting("unscheduled"))).rejects.toThrow("scheduler unavailable");
    expect(f.canonicalDump()).toEqual(before);
    const scheduledAttempts = arms;
    expect((await f.owner.execute(activation())).result.disposition).toBe("replayed");
    expect(arms).toBe(scheduledAttempts);
    unavailable = false;
    expect((await f.owner.execute(posting("unscheduled"))).result.disposition).toBe("committed");
  } finally {
    f.db.close();
  }
}, 60000);

test("indexed owner publishes complete accounting and identities and preserves exact restart retries", async () => {
  const f = fixture();
  const original = SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome;
  const produced: string[] = [];
  SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome = function (...args) {
    const input = args[0];
    produced.push(input.kind === "commit" ? input.intent.command.id : input.retained.commandId);
    return original.apply(this, args);
  };
  try {
    await f.owner.provision(genesis());
    const opened = await f.owner.execute(activation());
    const committed = await f.owner.execute(posting("owner-sale"));
    const rejected = await f.owner.execute(posting("owner-stale", 0n));
    expect(opened.result.disposition).toBe("committed");
    expect(committed.result.disposition).toBe("committed");
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.outcomeSequence).toBe(3n);
    let expected: DurableBookAggregate = genesis();
    for (const command of [activation(), posting("owner-sale"), posting("owner-stale", 0n)]) {
      const next = executeBookCommand(expected.state, expected.protocol, command);
      expected = { state: next.state, protocol: next.protocol };
    }
    const after = await f.open().read();
    expect(encodeDurableBook(after.aggregate)).toBe(encodeDurableBook(expected));
    const view = JSON.parse(
      (f.db.query("SELECT body FROM ledger_index_control").get() as { body: string }).body,
    ).view;
    expect(view.headHash).toBe(after.head.contentHash);
    expect(view.hotCount).toBe("7");
    for (const [command, original] of [
      [posting("owner-sale"), committed],
      [posting("owner-stale", 0n), rejected],
    ] as const) {
      const replay = await f.open().execute(command);
      expect(replay.result.disposition).toBe("replayed");
      expect(replay.originalResult).toEqual(original.originalResult);
      expect(replay.outcomeSequence).toBe(original.outcomeSequence);
    }
    await f.open().provision(genesis());
    expect((await f.open().read()).head.sequence).toBe("3");
    await expect(f.open().provision(genesis("Different cash"))).rejects.toThrow(
      "ledger_genesis_conflict",
    );
    expect(produced).toEqual([activation().id, commandId("owner-sale"), commandId("owner-stale")]);
  } finally {
    SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome = original;
    f.db.close();
  }
}, 30000);

test("indexed owner refuses another valid admitted outcome before any publication", async () => {
  const f = fixture();
  const original = SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome;
  try {
    await f.owner.provision(genesis());
    await f.owner.execute(activation());
    const before = await f.owner.read();
    const other = executeBookCommand(
      before.aggregate.state,
      before.aggregate.protocol,
      posting("different-admitted-command"),
    );
    if (!other.intent) throw new Error("Expected different valid intent");
    const intent = other.intent;
    const unchanged = f.canonicalDump();
    let calls = 0;
    SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome = function (
      _input,
      digest,
      confirm,
    ) {
      calls++;
      return original.call(
        this,
        {
          kind: "commit",
          intent,
          previousRevision: before.aggregate.state.revisions.at(-1) ?? null,
        },
        digest,
        confirm,
      );
    };
    await expect(f.owner.execute(posting("requested-admitted-command"))).rejects.toThrow(
      "indexed_outcome_projection_mismatch",
    );
    expect(calls).toBe(1);
    expect(f.canonicalDump()).toEqual(unchanged);
    SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome = original;
    expect((await f.open().execute(posting("requested-admitted-command"))).result.disposition).toBe(
      "committed",
    );
    expect(
      (await f.open().read()).aggregate.protocol.retainedResults.map((r) => r.commandId),
    ).toEqual([activation().id, commandId("requested-admitted-command")]);
  } finally {
    SqliteIndexedSourceCatalog.prototype.prepareAdmittedOutcome = original;
    f.db.close();
  }
});

for (const [name, build] of [
  ["commercial", commercialWorkflow],
  ["lots", lotIdentityWorkflow],
  ["allocation and tax", () => allocationAndTaxWorkflow("1.1.0")],
  [
    "FX",
    () => {
      const fx = admissionFxWorkflow(false);
      return {
        initial: fx.initial,
        commands: [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)],
      };
    },
  ],
] as const) {
  test(`indexed owner uses actual kernel admission for ${name}`, async () => {
    const scenario = build();
    const f = fixture();
    let expected: DurableBookAggregate = scenario.initial;
    try {
      const owner = f.owner;
      await owner.provision(scenario.initial);
      for (const command of scenario.commands) {
        const transition = executeBookCommand(expected.state, expected.protocol, command);
        const actual = await owner.execute(command);
        expect(actual.result).toEqual(transition.result);
        expected = { state: transition.state, protocol: transition.protocol };
      }
      expect(encodeDurableBook((await owner.read()).aggregate)).toBe(encodeDurableBook(expected));
      const recovered = f.open();
      expect(encodeDurableBook((await recovered.read()).aggregate)).toBe(
        encodeDurableBook(expected),
      );
      await checkIndexedReader(recovered, expected);
    } finally {
      f.db.close();
    }
  }, 180000);
}

test("new-format reader separates original financial chronology from retained outcome order", async () => {
  const f = fixture();
  try {
    await f.owner.provision(genesis());
    let reader = await f.owner.openCurrentRowReader();
    const initial = await reader.readBookBasis();
    expect(initial.header.status).toBe("configuring");
    expect(initial.financialRevision).toBeNull();
    expect(initial.openingBoundary).toBeNull();
    await reader.close();
    const rejected = posting("before-activation", 0n);
    expect((await f.owner.execute(rejected)).result.disposition).toBe("rejected");
    expect((await f.owner.execute(activation())).result.disposition).toBe("committed");
    const sale = posting("reader-sale");
    await f.owner.execute(sale);
    const later = posting("reader-stale", 0n);
    await f.owner.execute(later);
    reader = await f.open().openCurrentRowReader();
    expect(reader.head.sequence).toBe("4");
    expect(reader.head.bookRevision).toBe("2");
    const basis = await reader.readBookBasis();
    expect(basis.financialRevision?.row.command.id).toBe(sale.id);
    expect(basis.configuration.ordinal).toBe(1n);
    for (const [command, ordinal] of [
      [rejected, 1n],
      [activation(), 2n],
      [sale, 3n],
      [later, 4n],
    ] as const) {
      const found = await reader.readCommand(command.id);
      expect(found.disposition).toBe("present");
      expect(found.ordinal).toBe(ordinal);
    }
    const facts = await reader.readAdmissionFacts(posting("next", 2n));
    expect(facts.periods.map((p) => [String(p.periodId), p.closed, p.transitionCount])).toEqual([
      ["january", false, 0n],
    ]);
    expect(facts.overdueRemeasurement).toBeNull();
    const reading = reader.readTyped("state.journals", 1n);
    const closing = reader.close();
    expect((await reading).row).toEqual(
      workflowValue((await f.owner.read()).aggregate.state.journals[0]),
    );
    await closing;
    await reader.close();
    await expect(reader.readCommand(sale.id)).rejects.toThrow("source_catalog_reader_closed");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_index_pins").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("new-format reader retires on stale head, missing evidence and authority loss", async () => {
  for (const failure of [
    "commit",
    "reject",
    "source",
    "identity",
    "group",
    "pending",
    "fence",
    "expiry",
    "late-fence",
    "invalid-collection",
  ] as const) {
    const f = fixture();
    try {
      await f.owner.provision(genesis());
      await f.owner.execute(activation());
      await f.owner.execute(posting("reader-source"));
      const reader = await f.owner.openCurrentRowReader();
      const cursor = await reader.openGroup("holdingsByAccount", ["absent"]);
      if (failure === "commit") await f.open().execute(posting("new-head", 2n));
      if (failure === "reject") await f.open().execute(posting("new-rejection", 0n));
      if (failure === "source")
        f.db
          .query("DELETE FROM ledger_indexed_record_chunks WHERE record_id = '0000000000000002'")
          .run();
      if (failure === "identity") f.db.query("DELETE FROM ledger_index_pages").run();
      if (failure === "group") f.db.query("DELETE FROM ledger_indexed_group_catalog").run();
      if (failure === "pending") f.faults.pending = true;
      if (failure === "fence") f.faults.fence = "1";
      if (failure === "expiry") f.faults.now += 100000n;
      if (failure === "late-fence") f.faults.fenceAfterSql = "SELECT ordinal, typeof(bytes)";
      const before = f.db.query("SELECT * FROM ledger_indexed_records ORDER BY record_id").all();
      await expect(
        failure === "invalid-collection"
          ? reader.read("not-a-collection", 1n)
          : reader.readCommand("reader-source"),
      ).rejects.toThrow();
      if (failure === "late-fence") expect(f.faults.fired).toBe(1);
      await expect(cursor.next()).rejects.toThrow("source_catalog_reader_closed");
      await expect(reader.readCommand("absent")).rejects.toThrow("source_catalog_reader_closed");
      await reader.close();
      expect(f.db.query("SELECT * FROM ledger_indexed_records ORDER BY record_id").all()).toEqual(
        before,
      );
    } finally {
      f.db.close();
    }
  }
}, 60000);

test("new-format inventory facts join exact current holdings and lots, not request-supplied layers", async () => {
  const scenario = inventoryReadWorkflow();
  const f = fixture();
  let expected: DurableBookAggregate = scenario.initial;
  try {
    await f.owner.provision(scenario.initial);
    for (const command of scenario.commands) {
      const next = executeBookCommand(expected.state, expected.protocol, command);
      expect((await f.owner.execute(command)).result).toEqual(next.result);
      expected = { state: next.state, protocol: next.protocol };
    }
    const command = scenario.command(expected.state);
    const layers = expected.state.lotHoldings
      .filter(
        (h) =>
          scenario.policy.pools.some((p) => p.accountId === h.accountId) &&
          h.commodityId === command.inventoryCommodityId &&
          !h.remainingQuantity.isZero(),
      )
      .map((h) => ({
        id: h.id,
        accountId: h.accountId,
        acquiredAt: workflowValue(expected.state.lots.find((l) => l.id === h.lotId)).acquiredAt,
        quantity: h.remainingQuantity,
        totalBasis: h.remainingTotalBasis,
      }))
      .sort((a, b) => compareCanonicalText(a.id, b.id));
    expect(layers.map((l) => [l.id, l.quantity.toString()])).toEqual([
      ["lot-destination", "5/1"],
      ["lot-second", "7/1"],
    ]);
    const reader = await f.open().openCurrentRowReader();
    try {
      const facts = await reader.readInventoryCostFacts(command);
      expect(facts.policy).toEqual(scenario.policy);
      expect(facts.layers).toEqual(layers);
      const omitted = sealCommand({ ...command, request: { ...command.request, layers: [] } });
      const complete = await reader.readInventoryCostFacts(omitted);
      expect(complete.layers).toEqual(layers);
      expect(inventoryCostLayersMatch(complete.layers, omitted.request.layers)).toBeFalse();
      for (const source of facts.sources) {
        const row = await reader.readTyped("state.lotHoldings", source.holdingOrdinal);
        expect(row.rowHash).toBe(source.holdingRowHash);
        expect(row.encoded).toBe(
          encodeBookRow(
            "state.lotHoldings",
            workflowValue(expected.state.lotHoldings[Number(source.holdingOrdinal) - 1]),
          ),
        );
      }
    } finally {
      await reader.close();
    }
  } finally {
    f.db.close();
  }
}, 180000);

test("new-format grouped admission preserves FX date boundaries and original-result reversal exceptions", async () => {
  const scenario = admissionFxWorkflow();
  const f = fixture();
  try {
    await f.owner.provision(scenario.initial);
    for (const command of scenario.commands)
      expect((await f.owner.execute(command)).result.disposition).toBe("committed");
    const reader = await f.open().openCurrentRowReader();
    try {
      const probe = (day: string) =>
        sealCommand({
          ...posting(`fx-read-${day}`, 5n),
          issuedAt: instant(`${day}T18:00:00Z`),
          completedAt: instant(`${day}T18:00:01Z`),
          committedAt: instant(`${day}T18:00:02Z`),
        });
      expect(
        (await reader.readAdmissionFacts(probe("2026-01-16"))).overdueRemeasurement,
      ).toBeNull();
      const next = await reader.readAdmissionFacts(probe("2026-01-17"));
      expect(next.overdueRemeasurement?.row.id).toBe(scenario.firstMeasurement.request.id);
      const exceptFirst = sealCommand({
        ...scenario.reverse(scenario.firstMeasurement, 5n),
        issuedAt: instant("2026-01-17T18:00:00Z"),
        completedAt: instant("2026-01-17T18:00:01Z"),
        committedAt: instant("2026-01-17T18:00:02Z"),
      });
      expect((await reader.readAdmissionFacts(exceptFirst)).overdueRemeasurement).toBeNull();
      expect(next.basis.headHash).toBe(reader.head.contentHash);
    } finally {
      await reader.close();
    }
  } finally {
    f.db.close();
  }
}, 180000);

test("all indexed owner publication participants roll back together on every selected SQL boundary", async () => {
  for (const point of [
    "INSERT INTO ledger_indexed_records",
    "INSERT INTO ledger_indexed_record_chunks",
    "UPDATE ledger_indexed_canonical",
    "INSERT INTO ledger_indexed_source_nodes",
    "UPDATE ledger_indexed_source_catalog",
    "UPDATE ledger_indexed_group_catalog",
    "UPDATE ledger_index_control",
    "DELETE FROM ledger_index_pins",
  ]) {
    const f = fixture();
    try {
      await f.owner.provision(genesis());
      await f.owner.execute(activation());
      const before = f.canonicalDump();
      f.faults.afterSql = point;
      await expect(f.owner.execute(posting("rollback-sale"))).rejects.toThrow(
        "injected indexed owner SQL failure",
      );
      expect(f.faults.fired).toBe(1);
      expect(f.canonicalDump()).toEqual(before);
      f.faults.afterSql = "";
      expect((await f.open().read()).head.sequence).toBe("1");
      expect((await f.open().execute(posting("rollback-sale"))).result.disposition).toBe(
        "committed",
      );
      expect((await f.open().read()).head.sequence).toBe("2");
    } finally {
      f.db.close();
    }
  }
}, 60000);

test("indexed owner lost acknowledgement returns no receipt and reconciles the original retained result", async () => {
  const f = fixture();
  try {
    await f.owner.provision(genesis());
    await f.owner.execute(activation());
    f.faults.loseAfterSql = "UPDATE ledger_index_control";
    await expect(f.owner.execute(posting("lost-owner-reply"))).rejects.toThrow(
      "lost indexed owner durability response",
    );
    expect(f.faults.fired).toBe(1);
    const replay = await f.open().execute(posting("lost-owner-reply"));
    expect(replay.result.disposition).toBe("replayed");
    expect(replay.originalResult?.disposition).toBe("committed");
    expect(replay.outcomeSequence).toBe(2n);
    expect((await f.open().read()).head.sequence).toBe("2");
  } finally {
    f.db.close();
  }
});

test("indexed owner checks maintenance, fence rotation and lease expiry during construction and publication", async () => {
  for (const mode of ["pending", "fence", "expiry"] as const) {
    for (const point of [
      "INSERT INTO ledger_index_construction_locations",
      "UPDATE ledger_indexed_canonical",
    ]) {
      const f = fixture();
      try {
        await f.owner.provision(genesis());
        await f.owner.execute(activation());
        const before = f.canonicalDump();
        if (mode === "pending") f.faults.pendingAfterSql = point;
        if (mode === "fence") f.faults.fenceAfterSql = point;
        if (mode === "expiry") f.faults.expireAfterSql = point;
        await expect(f.owner.execute(posting("fenced-sale"))).rejects.toThrow();
        expect(f.faults.fired).toBe(1);
        expect(f.canonicalDump()).toEqual(before);
      } finally {
        f.db.close();
      }
    }
  }
}, 60000);

test("independent indexed owners converge on duplicate commands and retain the losing financial race", async () => {
  const f = fixture();
  try {
    await f.owner.provision(genesis());
    const duplicates = await Promise.all([
      f.owner.execute(activation()),
      f.open().execute(activation()),
    ]);
    expect(duplicates.map((v) => v.originalResult)).toEqual([
      duplicates[0]?.originalResult,
      duplicates[0]?.originalResult,
    ]);
    expect((await f.open().read()).head.sequence).toBe("1");
    const race = await Promise.all([
      f.owner.execute(posting("racing-a")),
      f.open().execute(posting("racing-b")),
    ]);
    expect(race.map((v) => v.originalResult?.disposition).sort()).toEqual([
      "committed",
      "rejected",
    ]);
    const after = await f.open().read();
    expect(after.head.sequence).toBe("3");
    expect(after.head.bookRevision).toBe("2");
  } finally {
    f.db.close();
  }
});

test("indexed owner initial provisioning is atomic and a lost genesis acknowledgement is idempotent", async () => {
  for (const point of [
    "CREATE TABLE ledger_index_control",
    "CREATE TABLE ledger_index_page_metadata",
    "INSERT INTO ledger_indexed_source_catalog",
    "INSERT INTO ledger_indexed_group_catalog",
  ]) {
    const f = fixture();
    try {
      f.faults.afterSql = point;
      await expect(f.owner.provision(genesis())).rejects.toThrow(
        "injected indexed owner SQL failure",
      );
      expect(f.faults.fired).toBe(1);
      expect(f.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      f.faults.afterSql = "";
      await f.owner.provision(genesis());
      expect((await f.open().read()).head.sequence).toBe("0");
    } finally {
      f.db.close();
    }
  }
  const f = fixture();
  try {
    f.faults.loseAfterSql = "INSERT INTO ledger_indexed_canonical";
    await expect(f.owner.provision(genesis())).rejects.toThrow(
      "lost indexed owner durability response",
    );
    await f.open().provision(genesis());
    expect((await f.open().read()).head.sequence).toBe("0");
  } finally {
    f.db.close();
  }
});

test("indexed owner captures queued input and unretained failures never reserve durable identities", async () => {
  const f = fixture();
  try {
    await f.owner.provision(genesis());
    await f.owner.execute(activation());
    const original = posting("captured-command"),
      mutable = { ...original };
    const pending = f.owner.execute(mutable);
    mutable.id = commandId("caller-changed-id");
    const receipt = await pending;
    expect(receipt.result.disposition).toBe("committed");
    expect((await f.open().execute(original)).originalResult).toEqual(receipt.originalResult);
    const before = f.canonicalDump();
    const invalid = {
      ...posting("unretained-bad-hash", 2n),
      inputHash: { ...original.inputHash, digest: "0".repeat(64) },
    };
    const rejected = await f.owner.execute(invalid);
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.outcomeSequence).toBeNull();
    expect(rejected.originalResult).toBeNull();
    expect(f.canonicalDump()).toEqual(before);
    f.faults.pending = true;
    await expect(f.open().read()).rejects.toThrow("indexed_owner_maintenance");
    expect(f.canonicalDump()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("indexed owner never treats missing permanent identities or historical sources as a new command", async () => {
  for (const sql of [
    "DELETE FROM ledger_index_pages",
    "DELETE FROM ledger_indexed_records WHERE record_id = '0000000000000001'",
    "DELETE FROM ledger_indexed_source_origins",
    "UPDATE ledger_indexed_group_catalog SET digest = substr(digest, 2)",
  ]) {
    const f = fixture();
    try {
      await f.owner.provision(genesis());
      await f.owner.execute(activation());
      f.db.exec(sql);
      const before = f.canonicalDump();
      await expect(f.open().read()).rejects.toThrow();
      await expect(f.owner.execute(activation())).rejects.toThrow();
      expect(f.canonicalDump()).toEqual(before);
    } finally {
      f.db.close();
    }
  }
});

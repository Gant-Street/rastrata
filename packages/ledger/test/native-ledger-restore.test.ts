import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { encodeDurableBook, type BookCommand, type DurableBookAggregate } from "@rastrata/kernel";
import { NativeLedger } from "../src/native-ledger.ts";
import { completeScope } from "../src/compact-records.ts";
import { NativeLedgerRestore } from "../src/native-ledger-restore.ts";
import { NativeLedgerCatalog } from "../src/native-ledger-catalog.ts";
import { NativeOutcomeOutbox, readNativeArchiveBatch } from "../src/native-outcome-outbox.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { R2ArchiveObjectStore } from "../src/r2-archive-store.ts";
import { AuthorizedNativeLedger } from "../src/authorized-native-ledger.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { withBucket, type TestR2Bucket } from "./r2-fixtures.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";
import { nativeInventoryWorkflow, freeInventoryCycle } from "./native-inventory-workflow.ts";
import { allocationAndTaxWorkflow, currencyRecoveryWorkflow } from "./accounting-workflows.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { auditNativeProjection } from "../src/native-projection-audit.ts";

function sqlite() {
  const db = new Database(":memory:");
  db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000;");
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const fault = { query: "", mode: "lost" as "lost" | "rollback", pending: false };
  const storage: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        let stmt = stmtCache.get(query);
        if (stmt === undefined) {
          stmt = db.query(query);
          stmtCache.set(query, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (fault.query && query.startsWith(fault.query)) {
          fault.query = "";
          if (fault.mode === "rollback") throw new Error("injected rollback");
          fault.pending = true;
        }
        return rows;
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    async sync() {
      if (fault.pending) {
        fault.pending = false;
        throw new Error("injected lost reply");
      }
    },
  };
  return { db, storage, fault };
}

async function fixture(
  bucket: TestR2Bucket,
  scenario: {
    initial: DurableBookAggregate;
    commands: readonly BookCommand[];
  } = {
    initial: genesis(),
    commands: [activation(), posting("first"), posting("rejected", 0n), posting("second", 2n)],
  },
  authorizationRevision = "0",
) {
  const auth = await authorizationFixture();
  const source = sqlite(),
    control = sqlite(),
    target = sqlite();
  const scope = completeScope(
    { ...auth.scope, bookId: scenario.initial.state.identity.bookId },
    auth.scope.objectId,
  );
  let fence = "0";
  const repository = new SqliteLedgerRepository(source.storage, scope, scope.objectId, () => ({
    fence,
    pending: false,
  }));
  const ledger = new NativeLedger(repository);
  const authorizedSource = new AuthorizedNativeLedger(
    source.storage,
    scope,
    scope.objectId,
    () => ({ fence, pending: false }),
    auth.authorizer,
  );
  let oracle = scenario.initial;
  for (const [index, command] of scenario.commands.entries()) {
    const expected = evaluateOutcomePayload(oracle, command);
    if (index === 0)
      await authorizedSource.provision(
        await auth.token({ scope, sub: command.actorId }),
        scenario.initial,
        command,
      );
    else await ledger.execute(command);
    const actual = await repository.transact((view) => ({
      write: false,
      value: view.outcome(command.id)?.encoded,
    }));
    expect(actual.value ?? null).toBe(expected.encoded);
    oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
  }
  const head = (await repository.outcomePage()).observedTip;
  for (let revision = 0n; revision < BigInt(authorizationRevision); revision++) {
    await authorizedSource.advanceAuthorization(
      await auth.token({ scope, authorizationRevision: String(revision) }),
      `revocation-${revision}`,
      String(revision),
    );
  }
  const store = new R2ArchiveObjectStore(bucket, scope, scope.objectId);
  const relay = new NativeOutcomeOutbox(repository, store, () => ({ fence, pending: false }));
  await relay.initialize();
  while ((await relay.drain(2)).disposition !== "idle") {
    /* bounded fixture */
  }
  const catalog = new NativeLedgerCatalog(
    control.storage,
    "independent-catalog",
    scope,
    {
      inspectProvisioned: async () => ({
        scope,
        genesis: encodeDurableBook(scenario.initial),
        head,
        writerFence: fence,
      }),
      async retireWriter(_scope, requestId, expectedFence) {
        expect(expectedFence).toBe(fence);
        const stopped = await authorizedSource.retireWriter(
          await auth.token({ scope, sub: "operator", authorizationRevision }),
          requestId,
          expectedFence,
        );
        fence = stopped.fence;
        return stopped;
      },
      async inspectRetiredProjection(_scope, expectedFence) {
        expect(expectedFence).toBe(fence);
        return {
          scope,
          head,
          authorizationRevision,
          ...(await auditNativeProjection(source.storage, repository, head, "source-audit", () => {
            expect(fence).toBe("1");
          })),
        };
      },
      prepareRestoredWriter: (_scope, approvalHash) =>
        new NativeLedgerRestore(target.storage, scope, store, () => catalog.read()).prepareWriter(
          approvalHash,
        ),
    },
    store,
  );
  const reserved = await catalog.reserve(encodeDurableBook(scenario.initial), "reserve");
  const active = await catalog.activate(reserved, "activate");
  const maintenance = await catalog.beginMaintenance(active, "quiesce");
  const retired = await catalog.retireWriter(maintenance, "retire");
  const sealed = await catalog.sealArchive(retired, "seal");
  let approved = sealed;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      approved = await catalog.approveRestore(sealed, "restore", "operator");
      break;
    } catch (error) {
      expect((error as Error).message).toBe("native_catalog_projection_pending");
    }
  }
  expect(approved.restore).not.toBeNull();
  const restore = () => new NativeLedgerRestore(target.storage, scope, store, () => catalog.read());
  const copied = () =>
    new SqliteLedgerRepository(target.storage, scope, scope.objectId, () => ({
      fence,
      pending: false,
    }));
  const finish = async () => {
    for (let steps = 0; steps < scenario.commands.length * 2 + 8; steps++) {
      const progress = await restore().step(); // New owner after every bounded call.
      if (progress.phase === "verified") return progress;
    }
    throw new Error("restore failed to finish bounded fixture");
  };
  const close = () => {
    source.db.close();
    control.db.close();
    target.db.close();
  };
  return {
    auth,
    source,
    control,
    target,
    repository,
    scope,
    store,
    catalog,
    sealed,
    approved,
    restore,
    copied,
    finish,
    head,
    close,
  };
}

function installNativeSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  // Local SQLite image copy; the deployed acceptance drill exercises actual Cloudflare PITR.
  const tables = f.source.db
    .query(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name GLOB 'ledger_native_*' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  for (const table of tables) {
    f.target.db.exec(table.sql);
    for (const row of f.source.db.query(`SELECT * FROM ${table.name}`).all()) {
      const values = Object.values(row as Record<string, string | number | null>);
      f.target.db.run(
        `INSERT INTO ${table.name} VALUES (${values.map(() => "?").join(",")})`,
        values,
      );
    }
  }
}

async function verifySnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  for (let step = 0; step < 100; step++) {
    const progress = await f.restore().step("snapshot");
    if (progress.phase === "verified") return progress;
  }
  throw new Error("Snapshot verification exceeded fixture budget");
}

test("native snapshot handoff preserves outcomes and revocations without replaying or rewriting canonical rows", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket, undefined, "1");
    try {
      installNativeSnapshot(f);
      const canonical = () =>
        JSON.stringify(
          ["ledger_native_book", "ledger_native_outcomes", "ledger_native_facts"].map((table) =>
            f.target.db.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
          ),
        );
      const before = canonical();
      await expect(f.restore().prepareWriter(f.approved.contentHash)).rejects.toThrow(
        "native_restore_not_verified",
      );
      expect((await verifySnapshot(f)).through).toEqual(f.head);
      expect(canonical()).toBe(before);
      await expect(f.restore().step()).rejects.toThrow("native_restore_approval_changed");
      const events = f.target.db.query("SELECT * FROM ledger_native_access_events").all();
      const active = await f.catalog.finishRestore(f.approved, "resume-snapshot");
      expect(active.fence).toBe("1");
      await f.restore().activateWriter();
      await f.restore().activateWriter();
      expect(canonical()).toBe(before);
      expect(f.target.db.query("SELECT * FROM ledger_native_access_events").all()).toEqual(events);
      const owner = new AuthorizedNativeLedger(
        f.target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence: "1", pending: false }),
        f.auth.authorizer,
      );
      for (const claims of [
        { writerFence: "0", authorizationRevision: "1" },
        { writerFence: "1", authorizationRevision: "0" },
      ])
        await expect(owner.execute(await f.auth.token(claims), posting("first"))).rejects.toThrow(
          "ledger_forbidden",
        );
      const token = await f.auth.token({ writerFence: "1", authorizationRevision: "1" });
      for (const command of [posting("first"), posting("rejected", 0n)]) {
        const original = await f.repository.transact((view) => ({
          write: false,
          value: view.outcome(command.id),
        }));
        const replay = await owner.execute(token, command);
        expect(replay.value.result.disposition).toBe("replayed");
        expect(replay.value.originalResult).toEqual(original.value?.payload.originalResult ?? null);
      }
      expect(
        (await owner.execute(token, posting("after-native-restore", 3n))).value.result.disposition,
      ).toBe("committed");
    } finally {
      f.close();
    }
  });
});

test("a second native recovery replaces completed evidence without resetting the financial book", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      installNativeSnapshot(f);
      await verifySnapshot(f);
      const first = await f.catalog.finishRestore(f.approved, "first-resume");
      await f.restore().activateWriter();
      let fence = "1";
      const owner = new AuthorizedNativeLedger(
        f.target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence, pending: false }),
        f.auth.authorizer,
      );
      const repository = new SqliteLedgerRepository(
        f.target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence, pending: false }),
      );
      const catalog = new NativeLedgerCatalog(
        f.control.storage,
        "independent-catalog",
        f.scope,
        {
          inspectProvisioned: async () => {
            throw new Error("Cannot reprovision a restored book");
          },
          retireWriter: async (_scope, requestId, expectedFence) => {
            const receipt = await owner.retireWriter(
              await f.auth.token({ writerFence: fence }),
              requestId,
              expectedFence,
            );
            fence = receipt.fence;
            return receipt;
          },
          inspectRetiredProjection: async () => ({
            scope: f.scope,
            head: f.head,
            authorizationRevision: "0",
            ...(await auditNativeProjection(
              f.target.storage,
              repository,
              f.head,
              "second-source-audit",
              () => {},
            )),
          }),
          prepareRestoredWriter: (_scope, approvalHash) => f.restore().prepareWriter(approvalHash),
        },
        f.store,
      );
      const maintenance = await catalog.beginMaintenance(first, "second-quiesce");
      const retired = await catalog.retireWriter(maintenance, "second-retire");
      const sealed = await catalog.sealArchive(retired, "second-seal");
      let approved = sealed;
      for (let step = 0; step < 100; step++) {
        try {
          approved = await catalog.approveRestore(sealed, "second-restore", "operator");
          break;
        } catch (error) {
          expect((error as Error).message).toBe("native_catalog_projection_pending");
        }
      }
      expect(approved.restore).not.toBeNull();
      expect((await verifySnapshot(f)).through).toEqual(f.head);
      await catalog.finishRestore(approved, "second-resume");
      expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "2" });
      const active = new AuthorizedNativeLedger(
        f.target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence, pending: false }),
        f.auth.authorizer,
      );
      await expect(
        active.execute(await f.auth.token({ writerFence: "1" }), posting("first")),
      ).rejects.toThrow("ledger_forbidden");
      const fresh = await active.execute(
        await f.auth.token({ writerFence: "2" }),
        posting("after-second-restore", 3n),
      );
      expect(fresh.value.result.disposition).toBe("committed");
      expect(fresh.head.sequence).toBe("5");
    } finally {
      f.close();
    }
  });
});

test("snapshot taken before retirement verifies under the independent higher fence", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      installNativeSnapshot(f);
      // The financial cutoff is unchanged; only the retired incarnation's local access differs.
      f.target.db.run(
        "UPDATE ledger_native_access SET writer_status='active',writer_fence='0',retirement=NULL",
      );
      await verifySnapshot(f);
      await f.catalog.finishRestore(f.approved, "resume-before-retirement");
      expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "1" });
    } finally {
      f.close();
    }
  });
});

for (const mode of ["rollback", "lost"] as const) {
  for (const query of [
    "INSERT INTO ledger_native_restore VALUES",
    "UPDATE ledger_native_restore",
  ] as const) {
    test(`snapshot verification resumes ${mode} at ${query}`, async () => {
      await withBucket(async (bucket) => {
        const f = await fixture(bucket);
        try {
          installNativeSnapshot(f);
          f.target.fault.mode = mode;
          f.target.fault.query = query;
          await expect(f.restore().step("snapshot")).rejects.toThrow("injected");
          expect((await verifySnapshot(f)).through).toEqual(f.head);
          await f.catalog.finishRestore(f.approved, "resume-interrupted-snapshot");
          expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "1" });
        } finally {
          f.close();
        }
      });
    });
  }
}

for (const damage of ["outcome", "gap", "projection", "revocation", "fence", "head"] as const) {
  test(`native snapshot refuses ${damage} damage before writer activation`, async () => {
    await withBucket(async (bucket) => {
      const f = await fixture(bucket, undefined, "1");
      try {
        installNativeSnapshot(f);
        if (damage === "outcome")
          f.target.db.run("UPDATE ledger_native_outcomes SET body='corrupt' WHERE sequence=2");
        if (damage === "gap")
          f.target.db.run("DELETE FROM ledger_native_outcomes WHERE sequence=2");
        if (damage === "head") {
          f.target.db.run(
            "UPDATE ledger_native_book SET head=(SELECT head FROM ledger_native_outcomes WHERE sequence=3)",
          );
          f.target.db.run("DELETE FROM ledger_native_outcomes WHERE sequence=4");
        }
        if (damage === "projection")
          f.target.db.run("DELETE FROM ledger_native_facts WHERE source_sequence=2");
        if (damage === "revocation")
          f.target.db.run("UPDATE ledger_native_access SET revision='0'");
        if (damage === "fence")
          f.target.db.run(
            "UPDATE ledger_native_access SET writer_status='active',writer_fence='1',retirement=NULL",
          );
        await expect(verifySnapshot(f)).rejects.toThrow();
        await expect(f.catalog.finishRestore(f.approved, "unsafe-resume")).rejects.toThrow();
        expect((await f.catalog.read()).status).toBe("maintenance");
      } finally {
        f.close();
      }
    });
  });
}

for (const [name, scenario] of [
  ["allocation and tax", async () => allocationAndTaxWorkflow("1.1.0")],
  ["FX and reversal", async () => currencyRecoveryWorkflow()],
  [
    "paid and quantity-only inventory",
    async () => {
      const inventory = await nativeInventoryWorkflow();
      return {
        initial: inventory.initial,
        commands: [
          ...inventory.commands,
          ...freeInventoryCycle(
            inventory.commands,
            "restore-free",
            BigInt(inventory.commands.length),
          ),
        ],
      };
    },
  ],
] as const) {
  test(`archive restore preserves ${name} state and the full-kernel oracle`, async () => {
    await withBucket(async (bucket) => {
      const f = await fixture(bucket, await scenario());
      try {
        expect((await f.finish()).through).toEqual(f.head);
        let cursor: string | null = null;
        for (;;) {
          const source = await f.repository.factPage(cursor, 1);
          expect(await f.copied().factPage(cursor, 1)).toEqual(source);
          if (!source.facts.length) break;
          cursor = source.nextIdentity;
        }
        let after = null;
        for (;;) {
          const source = await f.repository.outcomePage(after, 1);
          expect(await f.copied().outcomePage(after, 1)).toEqual(source);
          if (!source.outcomes.length) break;
          after = source.through;
        }
      } finally {
        f.close();
      }
    });
  }, 60000);
}

test("same-identity archive restore resumes each batch and reproduces every outcome and fact exactly", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      expect(await f.catalog.approveRestore(f.sealed, "restore", "operator")).toEqual(f.approved);
      await expect(f.catalog.approveRestore(f.sealed, "restore", "another-actor")).rejects.toThrow(
        "native_catalog_operation_conflict",
      );
      await expect(
        f.catalog.approveRestore(f.sealed, "another-restore", "operator"),
      ).rejects.toThrow("native_catalog_head_conflict");
      expect(await f.restore().step()).toEqual({
        phase: "scan",
        through: null,
        expectedHead: f.head,
      });
      expect(
        f.target.db.query("SELECT name FROM sqlite_master WHERE name='ledger_native_book'").all(),
      ).toHaveLength(0);
      const ready = await f.finish();
      expect(ready).toEqual({ phase: "verified", through: f.head, expectedHead: f.head });
      expect(await f.restore().step()).toEqual(ready);
      expect(await f.copied().outcomePage()).toEqual(await f.repository.outcomePage());
      let cursor: string | null = null;
      for (;;) {
        const original = await f.repository.factPage(cursor, 1),
          copy = await f.copied().factPage(cursor, 1);
        expect(copy).toEqual(original);
        if (!original.facts.length) break;
        cursor = original.nextIdentity;
      }
      expect(
        (await f.copied().outcomePage()).outcomes.map((x) => x.payload.originalResult.disposition),
      ).toEqual(["committed", "committed", "rejected", "committed"]);
      const owner = new AuthorizedNativeLedger(
        f.target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence: "1", pending: false }),
        f.auth.authorizer,
      );
      await expect(
        owner.provision(await f.auth.token({ writerFence: "1" }), genesis(), activation()),
      ).rejects.toThrow("native_ledger_restore_required");
      expect((await f.catalog.read()).status).toBe("maintenance");
    } finally {
      f.close();
    }
  });
}, 60000);

for (const mode of ["rollback", "lost"] as const) {
  for (const query of [
    "INSERT INTO ledger_native_restore_batches",
    "UPDATE ledger_native_restore",
    "INSERT INTO ledger_native_outcomes",
    "UPDATE ledger_native_projection_audit",
  ]) {
    test(`restore reconciles ${mode} at ${query}`, async () => {
      await withBucket(async (bucket) => {
        const f = await fixture(bucket);
        try {
          f.target.fault.mode = mode;
          f.target.fault.query = query;
          await expect(f.finish()).rejects.toThrow("injected");
          expect((await f.finish()).through).toEqual(f.head);
          expect(await f.copied().outcomePage()).toEqual(await f.repository.outcomePage());
        } finally {
          f.close();
        }
      });
    });
  }
}

test("restore rejects unapproved, substituted, nonempty and corrupt targets without resetting them", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      await expect(
        new NativeLedgerRestore(f.target.storage, f.scope, f.store, async () => f.sealed).step(),
      ).rejects.toThrow("native_restore_not_approved");
      expect(
        f.target.db.query("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ).toHaveLength(0);
      await expect(
        new NativeLedgerRestore(f.source.storage, f.scope, f.store, () => f.catalog.read()).step(),
      ).rejects.toThrow("native_restore_target_not_empty");
      expect((await f.repository.outcomePage()).observedTip).toEqual(f.head);
      await f.restore().step();
      await expect(
        new NativeLedgerRestore(f.target.storage, f.scope, f.store, async () => ({
          ...f.approved,
          contentHash: "f".repeat(64),
        })).step(),
      ).rejects.toThrow("native_restore_approval_changed");
      f.target.db.run("UPDATE ledger_native_restore SET body='{}'");
      await expect(f.restore().step()).rejects.toThrow("native_restore_state_corrupt");
    } finally {
      f.close();
    }
  });
});

test("missing archive history and changed seals keep restoration unavailable", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      const seal = f.approved.sealed;
      if (seal === null) throw new Error("Missing fixture seal");
      const latest = await readNativeArchiveBatch(f.store, seal);
      await f.restore().step();
      if (latest.batch.previous === null) throw new Error("Missing fixture predecessor");
      await bucket.delete(latest.batch.previous.objectKey);
      await expect(f.restore().step()).rejects.toThrow();
      expect(
        f.target.db.query("SELECT name FROM sqlite_master WHERE name='ledger_native_book'").all(),
      ).toHaveLength(0);
      await f.store.compareAndSwapControl(seal.control, seal.control.body);
      await expect(f.restore().step()).rejects.toThrow("native_archive_seal_changed");
      expect((await f.catalog.read()).status).toBe("maintenance");
    } finally {
      f.close();
    }
  });
});

for (const damage of ["missing", "extra", "rehash", "origin"] as const) {
  test(`independent catalog projection rejects ${damage} restored facts with unchanged financial head`, async () => {
    await withBucket(async (bucket) => {
      const f = await fixture(bucket);
      try {
        for (let steps = 0; steps < 20; steps++) {
          if ((await f.restore().step()).phase === "replayed") break;
        }
        const originalHead = (await f.copied().outcomePage()).observedTip;
        expect(originalHead).toEqual(f.head);
        const row = f.target.db
          .query("SELECT identity,body FROM ledger_native_facts WHERE source_sequence=2 LIMIT 1")
          .get() as { identity: string; body: string };
        if (!row) throw new Error("Missing restored test fact");
        if (damage === "missing")
          f.target.db.run("DELETE FROM ledger_native_facts WHERE identity=?", [row.identity]);
        if (damage === "extra")
          f.target.db.run(
            "INSERT INTO ledger_native_facts SELECT ?,body,digest,source_sequence,mutable FROM ledger_native_facts WHERE identity=?",
            [JSON.stringify(["extra", "fabricated"]), row.identity],
          );
        if (damage === "origin")
          f.target.db.run("UPDATE ledger_native_facts SET source_sequence=1 WHERE identity=?", [
            row.identity,
          ]);
        if (damage === "rehash") {
          const changed = `${row.body} `;
          f.target.db.run("UPDATE ledger_native_facts SET body=?,digest=? WHERE identity=?", [
            changed,
            createHash("sha256").update(changed).digest("hex"),
            row.identity,
          ]);
        }
        await expect(f.finish()).rejects.toThrow("native_restore_projection_mismatch");
        expect((await f.copied().outcomePage()).observedTip).toEqual(originalHead);
        expect((await f.catalog.read()).status).toBe("maintenance");
      } finally {
        f.close();
      }
    });
  });
}

test("restored writer stays unavailable until archive/catalog/local activation agree and then preserves original retries", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      await expect(f.restore().prepareWriter(f.approved.contentHash)).rejects.toThrow(
        "native_restore_not_verified",
      );
      await f.finish();
      const token = await f.auth.token({ writerFence: "1" });
      const owner = () =>
        new AuthorizedNativeLedger(
          f.target.storage,
          f.scope,
          f.scope.objectId,
          () => ({ fence: "1", pending: false }),
          f.auth.authorizer,
        );
      const proof = await f.restore().prepareWriter(f.approved.contentHash);
      expect(proof.writerFence).toBe("1");
      expect(await f.restore().prepareWriter(f.approved.contentHash)).toEqual(proof);
      await expect(owner().execute(token, posting("not-yet", 3n))).rejects.toThrow(
        "native_ledger_writer_inactive",
      );
      await expect(owner().outcomes(token)).rejects.toThrow("native_ledger_writer_inactive");
      await expect(owner().advanceAuthorization(token, "not-yet", "0")).rejects.toThrow(
        "native_ledger_writer_inactive",
      );
      await expect(f.restore().activateWriter()).rejects.toThrow(
        "native_restore_catalog_not_active",
      );
      const active = await f.catalog.finishRestore(f.approved, "resume-book");
      expect(active.status).toBe("active");
      expect(active.fence).toBe("1");
      await expect(owner().execute(token, posting("still-not-yet", 3n))).rejects.toThrow(
        "native_ledger_writer_inactive",
      );
      expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "1" });
      expect(await owner().outcomes(token)).toEqual(await f.repository.outcomePage());
      const original = await owner().execute(token, posting("first"));
      expect(original.value.result.disposition).toBe("replayed");
      await expect(owner().outcomes(await f.auth.token())).rejects.toThrow("ledger_forbidden");
      const posted = await owner().execute(token, posting("after-restore", 3n));
      expect(posted.head.sequence).toBe("5");
      expect(posted.value.result.disposition).toBe("committed");
      expect(await f.catalog.finishRestore(f.approved, "resume-book")).toEqual(active);
      expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "1" });
      const relay = new NativeOutcomeOutbox(f.copied(), f.store, () => ({
        fence: "1",
        pending: false,
      }));
      expect((await relay.drain()).through).toEqual(posted.head);
      await expect(
        new NativeOutcomeOutbox(f.repository, f.store, () => ({
          fence: "0",
          pending: false,
        })).drain(),
      ).rejects.toThrow("native_archive_writer_fenced");
      const maintenance = await f.catalog.beginMaintenance(active, "second-maintenance");
      expect(maintenance.fence).toBe("1");
      expect(maintenance.restore).toBeNull();
      expect(maintenance.sealed).toBeNull();
      await expect(f.restore().activateWriter()).rejects.toThrow(
        "native_restore_catalog_not_active",
      );
    } finally {
      f.close();
    }
  });
}, 60000);

test("restoration preserves the approved revocation counter instead of initializing revision zero", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket, undefined, "7");
    try {
      await f.finish();
      expect(f.approved.restore?.authorizationRevision).toBe("7");
      await f.catalog.finishRestore(f.approved, "resume-book");
      await f.restore().activateWriter();
      const owner = new AuthorizedNativeLedger(
        f.target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence: "1", pending: false }),
        f.auth.authorizer,
      );
      await expect(owner.outcomes(await f.auth.token({ writerFence: "1" }))).rejects.toThrow(
        "ledger_forbidden",
      );
      const token = await f.auth.token({ writerFence: "1", authorizationRevision: "7" });
      expect((await owner.outcomes(token)).observedTip).toEqual(f.head);
      expect(
        (await owner.advanceAuthorization(token, "post-restore-revoke", "7")).authorizationRevision,
      ).toBe("8");
      expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "1" });
      await expect(owner.outcomes(token)).rejects.toThrow("ledger_forbidden");
    } finally {
      f.close();
    }
  });
});

for (const nativeSnapshot of [false, true]) {
  for (const stage of ["prepare", "archive", "catalog", "local"] as const) {
    for (const mode of ["rollback", "lost"] as const) {
      test(`${nativeSnapshot ? "snapshot" : "archive"} restore activation reconciles ${mode} at ${stage} without changing accounting history`, async () => {
        await withBucket(async (bucket) => {
          const f = await fixture(bucket);
          try {
            if (nativeSnapshot) {
              installNativeSnapshot(f);
              await verifySnapshot(f);
            } else await f.finish();
            f.target.fault.mode = mode;
            f.control.fault.mode = mode;
            if (stage === "prepare") f.target.fault.query = "UPDATE ledger_native_restore";
            if (stage === "catalog") f.control.fault.query = "UPDATE ledger_native_catalog";
            if (stage === "archive") {
              const write = f.store.compareAndSwapControl.bind(f.store);
              let once = true;
              f.store.compareAndSwapControl = async (...args) => {
                if (once && mode === "rollback") {
                  once = false;
                  throw new Error("injected archive failure before publication");
                }
                const result = await write(...args);
                if (once) {
                  once = false;
                  throw new Error("injected archive lost reply");
                }
                return result;
              };
            }
            if (stage !== "local")
              await expect(f.catalog.finishRestore(f.approved, "resume-book")).rejects.toThrow(
                "injected",
              );
            const active = await f.catalog.finishRestore(f.approved, "resume-book");
            expect(active.status).toBe("active");
            if (stage === "local") {
              f.target.fault.query = "UPDATE ledger_native_restore";
              await expect(f.restore().activateWriter()).rejects.toThrow("injected");
            }
            expect(await f.restore().activateWriter()).toEqual({ head: f.head, writerFence: "1" });
            expect(await f.copied().outcomePage()).toEqual(await f.repository.outcomePage());
          } finally {
            f.close();
          }
        });
      });
    }
  }
}

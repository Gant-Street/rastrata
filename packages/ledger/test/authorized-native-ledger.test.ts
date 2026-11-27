import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { actorId, hashCanonical, sealCommand } from "@rastrata/kernel";
import { AuthorizedNativeLedger } from "../src/authorized-native-ledger.ts";
import { NativeLedger } from "../src/native-ledger.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { R2ArchiveObjectStore } from "../src/r2-archive-store.ts";
import { NativeOutcomeOutbox } from "../src/native-outcome-outbox.ts";
import { withBucket } from "./r2-fixtures.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";
import { genesis, activation, posting } from "./fixtures.ts";

async function fixture() {
  const auth = await authorizationFixture(),
    db = new Database(":memory:");
  const fault = {
    block: null as ReturnType<typeof Promise.withResolvers<void>> | null,
    entered: null as ReturnType<typeof Promise.withResolvers<void>> | null,
    lost: false,
    rollback: false,
    failSync: false,
    retirement: null as "rollback" | "lost" | null,
    sql: [] as string[],
  };
  const storage: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        fault.sql.push(query);
        const rows = db
          .query(query)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
        if (fault.rollback && query.startsWith("INSERT INTO ledger_native_access_events")) {
          fault.rollback = false;
          throw new Error("injected authorization rollback");
        }
        if (fault.lost && query.startsWith("INSERT INTO ledger_native_access_events")) {
          fault.lost = false;
          fault.failSync = true;
        }
        if (fault.retirement && query.startsWith("UPDATE ledger_native_access SET writer_fence")) {
          const mode = fault.retirement;
          fault.retirement = null;
          if (mode === "rollback") throw new Error("injected retirement rollback");
          fault.failSync = true;
        }
        return rows;
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    async sync() {
      if (fault.block) {
        const blocked = fault.block;
        fault.block = null;
        fault.entered?.resolve();
        await blocked.promise;
      }
      if (fault.failSync) {
        fault.failSync = false;
        throw new Error("lost authorization acknowledgement");
      }
    },
  };
  const authority = { fence: "0", pending: false };
  const open = () =>
    new AuthorizedNativeLedger(
      storage,
      auth.scope,
      auth.scope.objectId,
      () => authority,
      auth.authorizer,
    );
  return { ...auth, db, storage, fault, open, authority };
}

test.each(["revocation", "expiry"] as const)(
  "archive telemetry rechecks %s after the last remote read",
  async (fault) => {
    await withBucket(async (bucket) => {
      const f = await fixture();
      const release = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      try {
        const token = await f.token();
        await f.open().provision(token, genesis(), activation());
        const store = new R2ArchiveObjectStore(bucket, f.scope, f.scope.objectId);
        const source = new SqliteLedgerRepository(
          f.storage,
          f.scope,
          f.scope.objectId,
          () => f.authority,
        );
        const outbox = new NativeOutcomeOutbox(source, store, () => f.authority);
        await outbox.initialize();
        await outbox.drain();
        const ledger = new AuthorizedNativeLedger(
          f.storage,
          f.scope,
          f.scope.objectId,
          () => f.authority,
          f.authorizer,
          {
            store,
            alarms: {
              getAlarm: async () => null,
              setAlarm: async () => {
                throw new Error("Observation must not arm an alarm");
              },
            },
          },
        );
        const read = store.readControl.bind(store);
        let reads = 0;
        store.readControl = async () => {
          reads++;
          const result = await read();
          if (reads === 2) {
            entered.resolve();
            await release.promise;
          }
          return result;
        };
        await expect(
          ledger.archiveStatus(await f.token({ permissions: ["read"] })),
        ).rejects.toThrow("ledger_forbidden");
        expect(reads).toBe(0);
        const pending = ledger.archiveStatus(token).catch((error: unknown) => error);
        await entered.promise;
        if (fault === "revocation")
          await ledger.advanceAuthorization(token, "revoke-observer", "0");
        else f.clock.now += 300000;
        release.resolve();
        expect(await pending).toMatchObject({
          code: fault === "revocation" ? "ledger_forbidden" : "ledger_unauthorized",
        });
        reads = 0;
        await expect(ledger.archiveStatus(token)).rejects.toThrow(
          fault === "revocation" ? "ledger_forbidden" : "ledger_unauthorized",
        );
        expect(reads).toBe(0);
        expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
          n: 1,
        });
      } finally {
        release.resolve();
        f.db.close();
      }
    });
  },
);

test("verified request contexts avoid repeat signatures without accepting forged, foreign, wrong-scope or stale authority", async () => {
  const f = await fixture();
  try {
    const ledger = f.open(),
      token = await f.token();
    await ledger.provision(token, genesis(), activation());
    let verifications = 0;
    const verify = f.authorizer.verify.bind(f.authorizer);
    f.authorizer.verify = async (token) => {
      verifications++;
      return verify(token);
    };
    const context = await ledger.checkRequestAuthorization(token, "execute");
    expect((await ledger.execute(context, posting())).value.result.disposition).toBe("committed");
    expect((await ledger.outcomes(context)).observedTip.sequence).toBe("2");
    expect(verifications).toBe(1);
    const other = await authorizationFixture();
    for (const invalid of [{ ...context }, await other.authorizer.verify(await other.token())])
      await expect(ledger.execute(invalid, posting("forged", 2n))).rejects.toThrow(
        "ledger_unauthorized",
      );
    for (const claims of [
      { permissions: ["read"] },
      { writerFence: "1" },
      { authorizationRevision: "1" },
      { scope: { ...f.scope, tenantId: "foreign" } },
    ]) {
      const restricted = await f.authorizer.verify(await f.token(claims));
      await expect(ledger.execute(restricted, posting("restricted", 2n))).rejects.toThrow(
        "ledger_forbidden",
      );
    }
    await expect(
      ledger.execute(
        context,
        sealCommand({ ...posting("actor", 2n), actorId: actorId("another") }),
      ),
    ).rejects.toThrow("ledger_forbidden");
    await ledger.advanceAuthorization(token, "revoke-context", "0");
    await expect(ledger.outcomes(context)).rejects.toThrow("ledger_forbidden");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
  }
});

test("retired projection scans require current maintenance authority on every bounded step", async () => {
  const f = await fixture();
  try {
    const token = await f.token();
    const ledger = f.open();
    await ledger.provision(token, genesis(), activation());
    await expect(ledger.inspectRetiredProjection(token, "1")).rejects.toThrow(
      "native_ledger_retirement_head_changed",
    );
    expect(
      f.db
        .query("SELECT name FROM sqlite_master WHERE name='ledger_native_projection_audit'")
        .all(),
    ).toHaveLength(0);
    for (let index = 0; index < 8; index++)
      await ledger.execute(token, posting(`audit-${index}`, BigInt(index + 1)));
    const retirement = await ledger.retireWriter(token, "audit-retirement", "0");
    await expect(ledger.inspectRetiredProjection(token, "2")).rejects.toThrow(
      "native_ledger_retirement_head_changed",
    );
    const first = await ledger.inspectRetiredProjection(token, "1");
    expect(first.complete).toBe(false);
    expect(first.count).toBe("32");
    expect(first.head).toEqual(retirement.head);
    await ledger.advanceAuthorization(token, "revoke-auditor", "0");
    await expect(ledger.inspectRetiredProjection(token, "1")).rejects.toThrow("ledger_forbidden");
    const fresh = await f.token({ authorizationRevision: "1" });
    let proof = first;
    const auditor = f.open();
    for (let step = 0; step < 10 && !proof.complete; step++)
      proof = await auditor.inspectRetiredProjection(fresh, "1");
    expect(proof.complete).toBe(true);
    expect(proof.authorizationRevision).toBe("1");
    const count = f.db
      .query("SELECT CAST(count(*) AS TEXT) AS count FROM ledger_native_facts")
      .get() as { count: string };
    expect(proof.count).toBe(count.count);
    expect(await f.open().inspectRetiredProjection(fresh, "1")).toEqual(proof);
    await expect(f.open().execute(fresh, posting("retired-cannot-post", 9n))).rejects.toThrow(
      "native_ledger_writer_retired",
    );
  } finally {
    f.db.close();
  }
});

test("authorized native ledger protects provisioning, commits, reads and retained retries", async () => {
  const f = await fixture();
  try {
    const ledger = f.open(),
      token = await f.token();
    await expect(ledger.provision(null, genesis(), activation())).rejects.toThrow(
      "ledger_unauthorized",
    );
    expect(f.fault.sql).toHaveLength(0);
    await ledger.provision(token, genesis(), activation());
    f.fault.sql = [];
    const receipt = await ledger.execute(token, posting("one"));
    expect(receipt.value.result.disposition).toBe("committed");
    expect(f.fault.sql.length).toBe(8); // Seven accounting statements plus one access-revision read.
    const retry = await f.open().execute(token, posting("one"));
    expect(retry.value.originalResult).toEqual(receipt.value.originalResult);
    const readOnly = await f.token({ permissions: ["read"] });
    f.fault.sql = [];
    await expect(ledger.execute(readOnly, posting("one"))).rejects.toThrow("ledger_forbidden");
    await expect(
      ledger.execute(token, sealCommand({ ...posting("two", 2n), actorId: actorId("forged") })),
    ).rejects.toThrow("ledger_forbidden");
    expect(f.fault.sql).toHaveLength(0);
    expect((await ledger.outcomes(readOnly)).outcomes).toHaveLength(2);
    const revoke = await ledger.advanceAuthorization(token, "revoke-0", "0");
    expect(revoke.authorizationRevision).toBe("1");
    f.fault.sql = [];
    await expect(f.open().execute(token, posting("one"))).rejects.toThrow("ledger_forbidden");
    await expect(f.open().outcomes(token)).rejects.toThrow("ledger_forbidden");
    expect(f.fault.sql.every((query) => query.includes("ledger_native_access"))).toBe(true);
    const fresh = await f.token({ authorizationRevision: "1" });
    expect((await f.open().execute(fresh, posting("one"))).value.originalResult).toEqual(
      receipt.value.originalResult,
    );
    expect(await ledger.advanceAuthorization(fresh, "revoke-0", "0")).toEqual(revoke);
    expect((await ledger.outcomes(fresh)).observedTip.sequence).toBe("2");
  } finally {
    f.db.close();
  }
});

for (const reuse of [false, true])
  test(`queued writes and reads recheck revocation after dequeue (verified context: ${reuse})`, async () => {
    const f = await fixture();
    try {
      const ledger = f.open(),
        token = await f.token();
      await ledger.provision(token, genesis(), activation());
      const authorization = reuse
        ? await ledger.checkRequestAuthorization(token, "execute")
        : token;
      const blocker = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      f.fault.block = blocker;
      f.fault.entered = entered;
      const revoke = ledger.advanceAuthorization(token, "revoke-first", "0");
      await entered.promise;
      const write = ledger.execute(authorization, posting("queued")).catch((error) => error);
      const read = ledger.outcomes(authorization).catch((error) => error);
      const control = ledger.checkCurrentAuthorization(token, "maintain").catch((error) => error);
      blocker.resolve();
      expect((await revoke).authorizationRevision).toBe("1");
      expect(await write).toMatchObject({ code: "ledger_forbidden" });
      expect(await read).toMatchObject({ code: "ledger_forbidden" });
      expect(await control).toMatchObject({ code: "ledger_forbidden" });
      expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 1,
      });
    } finally {
      f.db.close();
    }
  });

test("authorization revocation persists after uncertain acknowledgement and owner replacement", async () => {
  const f = await fixture();
  try {
    const ledger = f.open(),
      token = await f.token();
    await ledger.provision(token, genesis(), activation());
    f.fault.lost = true;
    await expect(ledger.advanceAuthorization(token, "lost", "0")).rejects.toThrow(
      "lost authorization acknowledgement",
    );
    await expect(f.open().outcomes(token)).rejects.toThrow("ledger_forbidden");
    const fresh = await f.token({ authorizationRevision: "1" });
    expect((await f.open().advanceAuthorization(fresh, "lost", "0")).authorizationRevision).toBe(
      "1",
    );
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_access_events").get()).toEqual({
      n: 1,
    });
    await expect(ledger.advanceAuthorization(fresh, "lost", "1")).rejects.toThrow(
      "ledger_authorization_identity_conflict",
    );
  } finally {
    f.db.close();
  }
});

test("authorization cannot be silently initialized for an existing raw native book", async () => {
  const f = await fixture();
  try {
    const raw = new NativeLedger(
      new SqliteLedgerRepository(f.storage, f.scope, f.scope.objectId, () => ({
        fence: "0",
        pending: false,
      })),
    );
    await raw.provision(genesis(), activation());
    await expect(f.open().provision(await f.token(), genesis(), activation())).rejects.toThrow(
      "ledger_authorization_migration_required",
    );
    expect(
      f.db.query("SELECT name FROM sqlite_master WHERE name='ledger_native_access'").all(),
    ).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

for (const reuse of [false, true])
  test(`authorization expiry is rechecked after storage wait (verified context: ${reuse})`, async () => {
    const f = await fixture();
    try {
      const ledger = f.open(),
        token = await f.token();
      await ledger.provision(token, genesis(), activation());
      const authorization = reuse
        ? await ledger.checkRequestAuthorization(token, "execute")
        : token;
      const blocker = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      f.fault.block = blocker;
      f.fault.entered = entered;
      f.fault.sql = [];
      const pending = ledger.execute(authorization, posting("expired")).catch((error) => error);
      await entered.promise;
      f.clock.now += 300000;
      blocker.resolve();
      expect(await pending).toMatchObject({ code: "ledger_unauthorized" });
      expect(f.fault.sql).toHaveLength(0);
      expect((await ledger.outcomes(await f.token())).observedTip.sequence).toBe("1");
    } finally {
      f.db.close();
    }
  });

test("authorization is rechecked after durable archive alarm arming before financial reads", async () => {
  const f = await fixture();
  const armed = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    const token = await f.token();
    await f.open().provision(token, genesis(), activation());
    const store = new R2ArchiveObjectStore(
      {
        get: async () => {
          throw new Error("save must not read R2");
        },
        put: async () => {
          throw new Error("save must not write R2");
        },
      },
      f.scope,
      f.scope.objectId,
    );
    const ledger = new AuthorizedNativeLedger(
      f.storage,
      f.scope,
      f.scope.objectId,
      () => ({ fence: "0", pending: false }),
      f.authorizer,
      {
        store,
        alarms: {
          getAlarm: async () => null,
          setAlarm: async () => {
            armed.resolve();
            await release.promise;
          },
        },
      },
    );
    f.fault.sql = [];
    const command = ledger.execute(token, posting("expires-while-arming")).catch((error) => error);
    await armed.promise;
    f.clock.now += 300000;
    release.resolve();
    expect(await command).toMatchObject({ code: "ledger_unauthorized" });
    expect(f.fault.sql).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
  } finally {
    release.resolve();
    f.db.close();
  }
});

test("authorization revision and control audit event roll back together", async () => {
  const f = await fixture();
  try {
    const ledger = f.open(),
      token = await f.token();
    await ledger.provision(token, genesis(), activation());
    f.fault.rollback = true;
    await expect(ledger.advanceAuthorization(token, "rollback", "0")).rejects.toThrow(
      "injected authorization rollback",
    );
    expect(f.db.query("SELECT revision FROM ledger_native_access").get()).toEqual({
      revision: "0",
    });
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_access_events").get()).toEqual({
      n: 0,
    });
    expect((await f.open().outcomes(token)).observedTip.sequence).toBe("1");
    expect(
      (await f.open().advanceAuthorization(token, "rollback", "0")).authorizationRevision,
    ).toBe("1");
  } finally {
    f.db.close();
  }
});

test("missing or malformed access authority never falls back to revision zero", async () => {
  for (const corrupt of [
    "DELETE FROM ledger_native_access",
    "UPDATE ledger_native_access SET revision='00'",
    "UPDATE ledger_native_access SET revision='-1'",
    "UPDATE ledger_native_access SET revision='10000000000000000000000000000000000000000000000000000000000000000'",
    "UPDATE ledger_native_access SET scope='{}'",
  ]) {
    const f = await fixture();
    try {
      const token = await f.token();
      await f.open().provision(token, genesis(), activation());
      f.db.exec(corrupt);
      f.fault.sql = [];
      await expect(f.open().execute(token, posting("denied"))).rejects.toThrow(
        "ledger_authorization_state_corrupt",
      );
      expect(f.fault.sql.every((query) => query.includes("ledger_native_access"))).toBe(true);
      expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 1,
      });
    } finally {
      f.db.close();
    }
  }
});

test("writer retirement durably fences old saves, reads, activation and retained retries without changing accounting", async () => {
  const f = await fixture();
  try {
    const ledger = f.open(),
      token = await f.token();
    await ledger.provision(token, genesis(), activation());
    const saved = await ledger.execute(token, posting("before-retirement"));
    const before = f.db.query("SELECT * FROM ledger_native_outcomes ORDER BY sequence").all();
    const reader = await f.token({ permissions: ["read"] });
    await expect(ledger.retireWriter(reader, "retire", "0")).rejects.toThrow("ledger_forbidden");
    const retired = await ledger.retireWriter(token, "retire", "0");
    expect(retired.head).toEqual(saved.head);
    expect(retired.fence).toBe("1");
    expect(retired.previousFence).toBe("0");
    expect(Object.isFrozen(retired.head)).toBe(true);
    f.fault.sql = [];
    for (const command of [posting("before-retirement"), posting("after-retirement", 2n)])
      await expect(f.open().execute(token, command)).rejects.toThrow(
        "native_ledger_writer_retired",
      );
    await expect(f.open().outcomes(token)).rejects.toThrow("native_ledger_writer_retired");
    expect(f.fault.sql.every((query) => query.includes("ledger_native_access"))).toBe(true);
    await expect(f.open().provision(token, genesis(), activation())).rejects.toThrow(
      "native_ledger_writer_retired",
    );
    expect(await f.open().retireWriter(token, "retire", "0")).toEqual(retired);
    await expect(f.open().retireWriter(token, "another-retirement", "0")).rejects.toThrow(
      "native_ledger_retirement_conflict",
    );
    expect(f.db.query("SELECT * FROM ledger_native_outcomes ORDER BY sequence").all()).toEqual(
      before,
    );
    // Control-plane revocation remains possible; it does not unretire a writer.
    await f.open().advanceAuthorization(token, "revoke-after-retirement", "0");
    const fresh = await f.token({ authorizationRevision: "1" });
    expect(await f.open().retireWriter(fresh, "retire", "0")).toEqual(retired);
    await expect(f.open().execute(fresh, posting("after-retirement", 2n))).rejects.toThrow(
      "native_ledger_writer_retired",
    );
  } finally {
    f.db.close();
  }
});

test("retirement serializes before queued writes and reports only the actual durable head", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  try {
    const ledger = f.open(),
      token = await f.token();
    await ledger.provision(token, genesis(), activation());
    f.fault.block = release;
    f.fault.entered = entered;
    const retirement = ledger.retireWriter(token, "queued-retirement", "0");
    await entered.promise;
    const write = ledger.execute(token, posting("queued-after-retirement")).catch((error) => error);
    release.resolve();
    expect((await retirement).head.sequence).toBe("1");
    expect(await write).toMatchObject({ code: "native_ledger_writer_retired" });
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
  } finally {
    release.resolve();
    f.db.close();
  }
});

test("a higher writer fence rejects old capabilities without changing book identity or original accounting receipts", async () => {
  const f = await fixture();
  try {
    const token = await f.token(),
      original = f.open();
    await original.provision(token, genesis(), activation());
    const saved = await original.execute(token, posting("before-writer-replacement"));
    const rows = f.db.query("SELECT * FROM ledger_native_outcomes ORDER BY sequence").all();
    // Fixture models only the completed control transition, not an implemented
    // restore installer. Keeping revision zero proves the fence check is real.
    f.db.exec("UPDATE ledger_native_access SET writer_fence='1'");
    f.authority.fence = "1";
    const replacement = f.open();
    expect(replacement.scope).toEqual(original.scope);
    for (const stale of [
      () => replacement.execute(token, posting("before-writer-replacement")),
      () => replacement.outcomes(token),
      () => replacement.provision(token, genesis(), activation()),
      () => replacement.advanceAuthorization(token, "old-maintenance", "0"),
      () => replacement.retireWriter(token, "old-retirement", "1"),
    ])
      await expect(stale()).rejects.toThrow("ledger_forbidden");
    const fresh = await f.token({ writerFence: "1" });
    await replacement.provision(fresh, genesis(), activation());
    const replay = await replacement.execute(fresh, posting("before-writer-replacement"));
    expect(replay.value.originalResult).toEqual(saved.value.originalResult);
    expect(replay.head).toEqual(saved.head);
    expect(f.db.query("SELECT * FROM ledger_native_outcomes ORDER BY sequence").all()).toEqual(
      rows,
    );
  } finally {
    f.db.close();
  }
});

test("a rehashed retirement receipt cannot substitute a different stopped accounting head", async () => {
  const f = await fixture();
  try {
    const ledger = f.open(),
      token = await f.token();
    await ledger.provision(token, genesis(), activation());
    const retired = await ledger.retireWriter(token, "retire", "0");
    const { contentHash: _, ...body } = retired;
    const forged = { ...body, head: { ...body.head, chainHash: "f".repeat(64) } };
    f.db.query("UPDATE ledger_native_access SET retirement=?").run(
      JSON.stringify({
        ...forged,
        contentHash: hashCanonical({
          scope: JSON.stringify(ledger.scope),
          retirement: forged,
        }).digest,
      }),
    );
    await expect(f.open().retireWriter(token, "retire", "0")).rejects.toThrow(
      "native_ledger_retirement_head_changed",
    );
    await expect(f.open().execute(token, posting("still-retired"))).rejects.toThrow(
      "native_ledger_writer_retired",
    );
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
  } finally {
    f.db.close();
  }
});

test("old experimental access schema requires explicit migration without rewriting authority", async () => {
  const f = await fixture();
  try {
    f.db.exec(
      "CREATE TABLE ledger_native_access (singleton INTEGER PRIMARY KEY, scope TEXT NOT NULL, revision TEXT NOT NULL)",
    );
    f.db.query("INSERT INTO ledger_native_access VALUES (1, ?, '7')").run(JSON.stringify(f.scope));
    const before = f.db.query("SELECT * FROM ledger_native_access").all();
    await expect(f.open().provision(await f.token(), genesis(), activation())).rejects.toThrow(
      "ledger_authorization_migration_required",
    );
    expect(f.db.query("SELECT * FROM ledger_native_access").all()).toEqual(before);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
      { name: "ledger_native_access" },
    ]);
  } finally {
    f.db.close();
  }
});

test("retirement rollback leaves the old writer active; lost acknowledgement preserves retirement", async () => {
  for (const mode of ["rollback", "lost"] as const) {
    const f = await fixture();
    try {
      const token = await f.token(),
        ledger = f.open();
      await ledger.provision(token, genesis(), activation());
      f.fault.retirement = mode;
      await expect(ledger.retireWriter(token, "uncertain-retirement", "0")).rejects.toThrow(
        mode === "rollback" ? "injected retirement rollback" : "lost authorization acknowledgement",
      );
      if (mode === "rollback") {
        expect(
          f.db
            .query("SELECT writer_status, writer_fence, retirement FROM ledger_native_access")
            .get(),
        ).toEqual({ writer_status: "active", writer_fence: "0", retirement: null });
        expect(
          (await f.open().execute(token, posting("still-active"))).value.result.disposition,
        ).toBe("committed");
      } else
        await expect(f.open().execute(token, posting("must-not-write"))).rejects.toThrow(
          "native_ledger_writer_retired",
        );
      const result = await f.open().retireWriter(token, "uncertain-retirement", "0");
      expect(result.fence).toBe("1");
      expect(result.head.sequence).toBe(mode === "rollback" ? "2" : "1");
    } finally {
      f.db.close();
    }
  }
});

test("writer control corruption, obsolete external fence and blank replacement initialization fail closed", async () => {
  const f = await fixture();
  try {
    const token = await f.token();
    await f.open().provision(token, genesis(), activation());
    f.authority.fence = "1";
    await expect(f.open().execute(token, posting("mismatched-fence"))).rejects.toThrow(
      "native_ledger_writer_fenced",
    );
    f.authority.fence = "0";
    f.db.query("UPDATE ledger_native_access SET retirement=?").run("x".repeat(16385));
    await expect(f.open().outcomes(token)).rejects.toThrow("native_ledger_writer_state_corrupt");
    f.db.exec("UPDATE ledger_native_access SET retirement=NULL");
    await f.open().retireWriter(token, "retired", "0");
    f.db.exec("UPDATE ledger_native_access SET writer_fence='2'");
    await expect(f.open().retireWriter(token, "retired", "0")).rejects.toThrow(
      "native_ledger_writer_state_corrupt",
    );
  } finally {
    f.db.close();
  }
  const next = await fixture();
  try {
    for (const scope of [next.scope, { ...next.scope, generation: "1" }]) {
      const ledger = new AuthorizedNativeLedger(
        next.storage,
        scope,
        scope.objectId,
        () => ({ fence: "1", pending: false }),
        next.authorizer,
      );
      await expect(
        ledger.provision(await next.token({ scope, writerFence: "1" }), genesis(), activation()),
      ).rejects.toThrow("native_ledger_restore_required");
      expect(
        next.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_native_%'").all(),
      ).toHaveLength(0);
    }
  } finally {
    next.db.close();
  }
});

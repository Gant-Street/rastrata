import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { encodeDurableBook, hashCanonical } from "@rastrata/kernel";
import {
  NativeLedgerCatalog,
  type NativeCatalogBook,
  type NativeRecoveryEvidence,
} from "../src/native-ledger-catalog.ts";
import { NativeLedgerRestore } from "../src/native-ledger-restore.ts";
import { AuthorizedNativeLedger } from "../src/authorized-native-ledger.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { NativeOutcomeOutbox } from "../src/native-outcome-outbox.ts";
import { R2ArchiveObjectStore, type ArchiveR2Bucket } from "../src/r2-archive-store.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";
import { withBucket } from "./r2-fixtures.ts";
import { genesis, activation, posting } from "./fixtures.ts";

function sqlite() {
  const db = new Database(":memory:");
  const fault = { mode: null as "rollback" | "lost" | null, sync: false };
  const storage: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
        if (query.startsWith("UPDATE ledger_native_catalog") && fault.mode !== null) {
          const mode = fault.mode;
          fault.mode = null;
          if (mode === "rollback") throw new Error("injected catalog rollback");
          fault.sync = true;
        }
        return rows;
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    async sync() {
      if (fault.sync) {
        fault.sync = false;
        throw new Error("injected catalog lost acknowledgement");
      }
    },
  };
  return { db, storage, fault };
}
async function fixture(bucket: ArchiveR2Bucket, archive = true) {
  const auth = await authorizationFixture(),
    source = sqlite(),
    control = sqlite();
  const token = await auth.token(),
    authority = () => ({ fence: "0", pending: false });
  const store = new R2ArchiveObjectStore(bucket, auth.scope, auth.scope.objectId);
  const alarm = { scheduled: null as number | null, calls: 0 };
  const owner = () =>
    new AuthorizedNativeLedger(
      source.storage,
      auth.scope,
      auth.scope.objectId,
      authority,
      auth.authorizer,
      {
        store,
        alarms: {
          getAlarm: async () => alarm.scheduled,
          setAlarm: async (time) => {
            alarm.scheduled = time;
            alarm.calls++;
          },
        },
      },
    );
  const calls = { inspected: 0, retired: 0, loseRetirement: false };
  const port: NativeCatalogBook = {
    inspectRetiredProjection: (_scope, fence) => owner().inspectRetiredProjection(token, fence),
    async inspectProvisioned(scope) {
      expect(scope).toEqual(owner().scope);
      calls.inspected++;
      return owner().inspectProvisioned(token);
    },
    async retireWriter(scope, request, fence) {
      expect(scope).toEqual(owner().scope);
      calls.retired++;
      const receipt = await owner().retireWriter(token, request, fence);
      if (calls.loseRetirement) {
        calls.loseRetirement = false;
        throw new Error("lost source retirement reply");
      }
      return receipt;
    },
  };
  const catalog = () =>
    new NativeLedgerCatalog(control.storage, "catalog-object", auth.scope, port, store);
  const encoded = encodeDurableBook(genesis());
  const reserved = await catalog().reserve(encoded, "reserve-book");
  await owner().provision(token, genesis(), activation());
  if (archive)
    await new NativeOutcomeOutbox(
      new SqliteLedgerRepository(source.storage, auth.scope, auth.scope.objectId, authority),
      store,
      authority,
    ).initialize();
  return {
    ...auth,
    source,
    control,
    owner,
    catalog,
    calls,
    port,
    encoded,
    reserved,
    token,
    signToken: auth.token,
    store,
    alarm,
    close: () => {
      source.db.close();
      control.db.close();
    },
  };
}

async function disasterFixture(bucket: ArchiveR2Bucket, caughtUp = true) {
  const f = await fixture(bucket);
  const active = await f.catalog().activate(f.reserved, "activate");
  const committed = await f.owner().execute(f.token, posting("acknowledged"));
  const rejected = await f.owner().execute(f.token, posting("retained-rejection", 0n));
  await f.owner().advanceAuthorization(f.token, "revoke", "0");
  const repository = new SqliteLedgerRepository(
    f.source.storage,
    f.scope,
    f.scope.objectId,
    () => ({ fence: "0", pending: false }),
  );
  const source = await repository.outcomePage();
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  let digest = sha(
    JSON.stringify(["rastrata-native-projection-audit-v1", repository.scope, source.observedTip]),
  );
  let count = 0,
    after: string | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const page = await repository.factPage(after);
    for (const fact of page.facts) {
      digest = sha(JSON.stringify(["rastrata-native-projection-audit-v1", digest, fact]));
      count++;
    }
    if (page.facts.length === 0) break;
    after = page.nextIdentity;
    if (attempt === 9) throw new Error("Evidence fixture too large");
  }
  if (caughtUp) await f.owner().handleArchiveAlarm();
  const evidence: NativeRecoveryEvidence = {
    scope: f.scope,
    requestId: "incident",
    expectedCatalogHash: active.contentHash,
    evidenceId: "verified-surviving-source-snapshot",
    approvedBy: "operator",
    genesisHash: active.genesisHash,
    head: source.observedTip,
    projection: { count: String(count), digest },
    authorizationRevision: "1",
  };
  const quarantine = { calls: 0, fail: false };
  f.port.quarantineWriter = async (scope, catalogHash) => {
    quarantine.calls++;
    if (quarantine.fail) throw new Error("quarantine unavailable");
    expect((await f.catalog().read()).status).toBe("maintenance");
    expect((await f.catalog().read()).contentHash).toBe(catalogHash);
    return { scope, catalogHash };
  };
  f.port.retireWriter = async () => {
    throw new Error("Unavailable primary cannot retire");
  };
  f.port.inspectRetiredProjection = async () => {
    throw new Error("Unavailable primary cannot scan");
  };
  return { ...f, active, evidence, quarantine, committed, rejected };
}

test("unplanned recovery approves independently reconciled evidence, restores exact receipts and resumes at a higher fence", async () => {
  await withBucket(async (bucket) => {
    const f = await disasterFixture(bucket),
      target = sqlite();
    try {
      const approve = () =>
        f.catalog().recoverUnavailableSource(f.active, "incident", async () => f.evidence);
      const approved = await approve();
      expect(approved.restore?.recovery).toEqual({
        evidenceId: f.evidence.evidenceId,
        expectedCatalogHash: f.active.contentHash,
      });
      expect(approved.retirement?.head).toEqual(f.rejected.head);
      expect(approved.fence).toBe("1");
      expect(await approve()).toEqual(approved);
      expect(f.quarantine.calls).toBe(1);
      const restore = () =>
        new NativeLedgerRestore(target.storage, f.scope, f.store, () => f.catalog().read());
      let phase = "";
      for (let attempt = 0; attempt < 40 && phase !== "verified"; attempt++)
        phase = (await restore().step()).phase;
      expect(phase).toBe("verified");
      f.port.prepareRestoredWriter = (_, approvalHash) => restore().prepareWriter(approvalHash);
      const active = await f.catalog().finishRestore(approved, "resume");
      await restore().activateWriter();
      expect(active.status).toBe("active");
      const owner = new AuthorizedNativeLedger(
        target.storage,
        f.scope,
        f.scope.objectId,
        () => ({ fence: "1", pending: false }),
        f.authorizer,
      );
      const token = await f.signToken({ writerFence: "1", authorizationRevision: "1" });
      const committed = await owner.execute(token, posting("acknowledged"));
      const rejected = await owner.execute(token, posting("retained-rejection", 0n));
      expect(committed.value.result.disposition).toBe("replayed");
      expect(committed.value.originalResult).toEqual(f.committed.value.originalResult);
      expect(rejected.value.originalResult).toEqual(f.rejected.value.originalResult);
      expect(rejected.value.outcomeSequence).toBe(f.rejected.value.outcomeSequence);
      await expect(
        owner.execute(await f.signToken({ authorizationRevision: "1" }), posting("stale", 2n)),
      ).rejects.toThrow("ledger_forbidden");
      const next = await owner.execute(token, posting("after-loss", 2n));
      expect(next.value.result.disposition).toBe("committed");
      expect(next.value.outcomeSequence).toBe("4");
      await expect(approve()).rejects.toThrow("native_catalog_head_conflict");
    } finally {
      target.db.close();
      f.close();
    }
  });
});

for (const change of [
  "foreign-scope",
  "wrong-catalog",
  "wrong-request",
  "wrong-genesis",
  "zero-head",
  "invalid-revision",
  "empty-projection",
  "extra-field",
])
  test(`unplanned recovery rejects ${change} before quiescing`, async () => {
    await withBucket(async (bucket) => {
      const f = await disasterFixture(bucket);
      try {
        const evidence = structuredClone(f.evidence);
        const invalid = {
          "foreign-scope": { scope: { ...evidence.scope, tenantId: "foreign" } },
          "wrong-catalog": { expectedCatalogHash: "0".repeat(64) },
          "wrong-request": { requestId: "another" },
          "wrong-genesis": { genesisHash: "0".repeat(64) },
          "zero-head": { head: { ...evidence.head, sequence: "0", bookRevision: "0" } },
          "invalid-revision": { authorizationRevision: "-1" },
          "empty-projection": { projection: { ...evidence.projection, count: "0" } },
          "extra-field": { ready: true },
        }[change];
        await expect(
          f.catalog().recoverUnavailableSource(f.active, "incident", async () => ({
            ...evidence,
            ...invalid,
          })),
        ).rejects.toThrow();
        expect(await f.catalog().read()).toEqual(f.active);
        expect(f.quarantine.calls).toBe(0);
      } finally {
        f.close();
      }
    });
  });

test("unplanned recovery refuses an incomplete archive without silently selecting its shorter prefix", async () => {
  await withBucket(async (bucket) => {
    const f = await disasterFixture(bucket, false);
    try {
      const before = await f.store.readControl();
      await expect(
        f.catalog().recoverUnavailableSource(f.active, "incident", async () => f.evidence),
      ).rejects.toThrow("native_archive_cutoff_incomplete");
      const current = await f.catalog().read();
      expect(current.status).toBe("maintenance");
      expect(current.restore).toBeNull();
      expect(current.fence).toBe("0");
      expect(await f.store.readControl()).toEqual(before);
    } finally {
      f.close();
    }
  });
});

test("unplanned recovery requires a configured quarantine port and its exact acknowledgement", async () => {
  await withBucket(async (bucket) => {
    const f = await disasterFixture(bucket);
    try {
      const quarantine = f.port.quarantineWriter;
      if (!quarantine) throw new Error("Missing fixture quarantine port");
      delete f.port.quarantineWriter;
      await expect(
        f.catalog().recoverUnavailableSource(f.active, "incident", async () => f.evidence),
      ).rejects.toThrow("native_catalog_recovery_unconfigured");
      expect(await f.catalog().read()).toEqual(f.active);
      const archive = await f.store.readControl();
      f.port.quarantineWriter = async (scope) => ({ scope, catalogHash: "0".repeat(64) });
      await expect(
        f.catalog().recoverUnavailableSource(f.active, "incident", async () => f.evidence),
      ).rejects.toThrow("native_catalog_recovery_quarantine_mismatch");
      expect((await f.catalog().read()).restore).toBeNull();
      expect(await f.store.readControl()).toEqual(archive);
      f.port.quarantineWriter = quarantine;
      expect(
        (await f.catalog().recoverUnavailableSource(f.active, "incident", async () => f.evidence))
          .restore?.recovery?.evidenceId,
      ).toBe(f.evidence.evidenceId);
    } finally {
      f.close();
    }
  });
});

test("independent disaster approval does not bypass complete target projection verification", async () => {
  await withBucket(async (bucket) => {
    const f = await disasterFixture(bucket),
      target = sqlite();
    try {
      const approval = await f
        .catalog()
        .recoverUnavailableSource(f.active, "incident", async () => ({
          ...f.evidence,
          projection: { ...f.evidence.projection, digest: "0".repeat(64) },
        }));
      const restore = new NativeLedgerRestore(target.storage, f.scope, f.store, () =>
        f.catalog().read(),
      );
      const verify = async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
          if ((await restore.step()).phase === "verified")
            throw new Error("Incorrect projection admitted");
        }
        throw new Error("Verification did not complete in bounded test budget");
      };
      await expect(verify()).rejects.toThrow("native_restore_projection_mismatch");
      await expect(restore.prepareWriter(approval.contentHash)).rejects.toThrow();
      expect((await f.catalog().read()).status).toBe("maintenance");
    } finally {
      target.db.close();
      f.close();
    }
  });
});

for (const failure of [
  "quarantine",
  "quiesce-reply",
  "archive-reply",
  "catalog-reply",
  "catalog-rollback",
  "authorization-revoked",
  "evidence-changed",
])
  test(`unplanned recovery stays unavailable after ${failure} and reconciles an exact retry`, async () => {
    await withBucket(async (bucket) => {
      let loseArchive = false;
      const f = await disasterFixture({
        get: (key) => bucket.get(key),
        async put(key, bytes, options) {
          const result = await bucket.put(key, bytes, options);
          if (loseArchive && key.endsWith("/control/anchor")) {
            loseArchive = false;
            throw new Error("lost archive reply");
          }
          return result;
        },
      });
      try {
        let calls = 0;
        const authorize = async (quarantinedCatalogHash: string | null) => {
          calls++;
          if (calls === 1) expect(quarantinedCatalogHash).toBeNull();
          if (calls === 2) {
            expect(quarantinedCatalogHash).toBe((await f.catalog().read()).contentHash);
            if (failure === "authorization-revoked")
              throw new Error("incident authorization revoked");
            if (failure === "evidence-changed")
              return { ...f.evidence, authorizationRevision: "2" };
            if (failure === "catalog-reply") f.control.fault.mode = "lost";
            if (failure === "catalog-rollback") f.control.fault.mode = "rollback";
          }
          return f.evidence;
        };
        f.quarantine.fail = failure === "quarantine";
        if (failure === "quiesce-reply") f.control.fault.mode = "lost";
        loseArchive = failure === "archive-reply";
        const errors: Record<string, string> = {
          quarantine: "quarantine unavailable",
          "quiesce-reply": "injected catalog lost acknowledgement",
          "archive-reply": "archive_write_uncertain",
          "catalog-reply": "injected catalog lost acknowledgement",
          "catalog-rollback": "injected catalog rollback",
          "authorization-revoked": "incident authorization revoked",
          "evidence-changed": "native_catalog_recovery_evidence_changed",
        };
        await expect(
          f.catalog().recoverUnavailableSource(f.active, "incident", authorize),
        ).rejects.toThrow(errors[failure]);
        expect((await f.catalog().read()).status).toBe("maintenance");
        f.quarantine.fail = false;
        const result = await f
          .catalog()
          .recoverUnavailableSource(f.active, "incident", async () => f.evidence);
        expect(result.restore?.authorizationRevision).toBe("1");
        expect(result.sealed?.head).toEqual(f.evidence.head);
        expect(result.fence).toBe("1");
      } finally {
        f.close();
      }
    });
  });

test("native catalog verifies real activation and durably retires the actual stopped source outside its restore set", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      expect(f.reserved.status).toBe("reserved");
      const active = await f.catalog().activate(f.reserved, "activate-book");
      expect(active.status).toBe("active");
      expect(active.revision).toBe("1");
      expect(await f.catalog().activate(f.reserved, "activate-book")).toEqual(active);
      expect(f.calls.inspected).toBe(1);
      expect(await f.catalog().reserve(f.encoded, "another-reservation")).toEqual(active);
      await f.owner().execute(f.token, posting("before-maintenance"));
      const pending = await f.catalog().beginMaintenance(active, "cutover-request");
      expect(pending.status).toBe("maintenance");
      expect(pending.retirement).toBeNull();
      // In-flight work admitted before routing stopped is included, not guessed
      // from the head observed by the earlier activation or maintenance request.
      const last = await f.owner().execute(f.token, posting("last-inflight", 2n));
      const stopped = await f.catalog().retireWriter(pending, "record-retirement");
      expect(stopped.fence).toBe("1");
      expect(stopped.retirement?.head).toEqual(last.head);
      expect(stopped.retirement?.requestId).toBe("cutover-request");
      expect(await f.catalog().read()).toEqual(stopped);
      expect(await f.catalog().retireWriter(pending, "record-retirement")).toEqual(stopped);
      expect(f.calls.retired).toBe(1);
      await expect(f.catalog().sealArchive(stopped, "seal")).rejects.toThrow(
        "native_archive_cutoff_incomplete",
      );
      expect(await f.catalog().read()).toEqual(stopped);
      await f.owner().handleArchiveAlarm();
      const sealed = await f.catalog().sealArchive(stopped, "seal");
      expect(sealed.status).toBe("maintenance");
      expect(sealed.sealed?.head).toEqual(last.head);
      expect(sealed.sealed?.fence).toBe("1");
      expect(sealed.sealed?.genesisHash).toBe(f.reserved.genesisHash);
      expect(await f.catalog().sealArchive(stopped, "seal")).toEqual(sealed);
      expect(sealed.sealed?.control ?? null).toEqual(await f.store.readControl());
      const schedules = f.alarm.calls;
      await f.owner().handleArchiveAlarm();
      await f.owner().handleArchiveAlarm();
      expect(f.alarm.calls).toBe(schedules);
      await expect(f.owner().execute(f.token, posting("late", 3n))).rejects.toThrow(
        "native_ledger_writer_retired",
      );
      await expect(f.catalog().activate(f.reserved, "activate-book")).rejects.toThrow(
        "native_catalog_head_conflict",
      );
      await expect(f.catalog().activate(sealed, "unretire")).rejects.toThrow(
        "native_catalog_not_reserved",
      );
      expect(f.source.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 3,
      });
      expect(f.control.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(
        [{ name: "ledger_native_catalog" }],
      );
    } finally {
      f.close();
    }
  });
});

test("native catalog reconciles uncertain archive and catalog seal writes without choosing a shorter cutoff", async () => {
  for (const failure of ["archive", "catalog"] as const)
    await withBucket(async (bucket) => {
      let failArchive = false;
      const f = await fixture({
        get: (key) => bucket.get(key),
        async put(key, bytes, options) {
          const result = await bucket.put(key, bytes, options);
          if (failArchive && key.endsWith("/control/anchor")) {
            failArchive = false;
            throw new Error("lost R2 seal reply");
          }
          return result;
        },
      });
      try {
        const active = await f.catalog().activate(f.reserved, "activate");
        const pending = await f.catalog().beginMaintenance(active, "cutover");
        const stopped = await f.catalog().retireWriter(pending, "retire");
        if (failure === "archive") failArchive = true;
        else f.control.fault.mode = "lost";
        await expect(f.catalog().sealArchive(stopped, "seal")).rejects.toThrow(
          failure === "archive"
            ? "archive_write_uncertain"
            : "injected catalog lost acknowledgement",
        );
        const durable = await f.store.readControl();
        expect(JSON.parse(durable?.body ?? "{}")).toMatchObject({ status: "sealed", fence: "1" });
        const result = await f.catalog().sealArchive(stopped, "seal");
        expect(result.status).toBe("maintenance");
        expect(result.sealed?.control ?? null).toEqual(durable);
        expect(result.sealed?.head).toEqual(stopped.retirement?.head);
        expect(f.source.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual(
          { n: 1 },
        );
      } finally {
        f.close();
      }
    });
});

test("native catalog cannot activate missing archives, non-initial books or substituted book evidence", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket, false);
    try {
      await expect(f.catalog().activate(f.reserved, "activate")).rejects.toThrow(
        "native_archive_control_missing",
      );
      expect(await f.store.readControl()).toBeNull();
      expect(await f.catalog().read()).toEqual(f.reserved);
      await f.owner().execute(f.token, posting("unauthorized-before-routing"));
      await expect(f.catalog().activate(f.reserved, "activate")).rejects.toThrow(
        "native_ledger_provisioning_mismatch",
      );
      expect(await f.catalog().read()).toEqual(f.reserved);
      f.port.inspectProvisioned = async () => ({
        scope: f.owner().scope,
        genesis: "forged",
        head: { sequence: "1", bookRevision: "1", chainHash: "f".repeat(64) },
        writerFence: "0",
      });
      await expect(f.catalog().activate(f.reserved, "activate")).rejects.toThrow(
        "native_catalog_provisioning_mismatch",
      );
      expect(await f.catalog().read()).toEqual(f.reserved);
      f.port.inspectProvisioned = async () => ({
        scope: f.owner().scope,
        genesis: f.encoded,
        head: { sequence: "1", bookRevision: "1", chainHash: "f".repeat(64) },
        writerFence: "1",
      });
      await expect(f.catalog().activate(f.reserved, "activate")).rejects.toThrow(
        "native_catalog_provisioning_mismatch",
      );
      expect(await f.catalog().read()).toEqual(f.reserved);
    } finally {
      f.close();
    }
  });
});

test("an unexpectedly fenced active source keeps reporting backup failure rather than claiming retirement completion", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      await f.catalog().activate(f.reserved, "activate");
      const current = await f.store.readControl();
      if (!current) throw new Error("missing archive");
      await f.store.compareAndSwapControl(
        current,
        JSON.stringify({ ...JSON.parse(current.body), status: "sealed", fence: "1" }),
      );
      const before = f.alarm.calls;
      // A real platform alarm is consumed when its handler starts.
      f.alarm.scheduled = null;
      await expect(f.owner().handleArchiveAlarm()).rejects.toThrow("native_archive_writer_fenced");
      expect(f.alarm.calls).toBe(before + 1);
      expect((await f.catalog().read()).status).toBe("active");
    } finally {
      f.close();
    }
  });
});

test("lost source retirement reply leaves maintenance unavailable and retries the same durable retirement identity", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      const active = await f.catalog().activate(f.reserved, "activate");
      const pending = await f.catalog().beginMaintenance(active, "cutover");
      f.calls.loseRetirement = true;
      await expect(f.catalog().retireWriter(pending, "attempt-1")).rejects.toThrow(
        "lost source retirement reply",
      );
      expect(await f.catalog().read()).toEqual(pending);
      await expect(f.owner().execute(f.token, posting("old-writer"))).rejects.toThrow(
        "native_ledger_writer_retired",
      );
      const restoredControl = await f.catalog().retireWriter(pending, "attempt-2");
      expect(restoredControl.retirement?.requestId).toBe("cutover");
      expect(restoredControl.retirement?.head.sequence).toBe("1");
      expect(restoredControl.fence).toBe("1");
      expect(f.calls.retired).toBe(2);
    } finally {
      f.close();
    }
  });
});

test("native catalog rollback and lost durability acknowledgement reconcile without unretiring or advancing accounting", async () => {
  for (const mode of ["rollback", "lost"] as const)
    await withBucket(async (bucket) => {
      const f = await fixture(bucket);
      try {
        const active = await f.catalog().activate(f.reserved, "activate");
        const pending = await f.catalog().beginMaintenance(active, "cutover");
        f.control.fault.mode = mode;
        await expect(f.catalog().retireWriter(pending, "retire")).rejects.toThrow(
          mode === "rollback"
            ? "injected catalog rollback"
            : "injected catalog lost acknowledgement",
        );
        const read = await f.catalog().read();
        expect(read.retirement === null).toBe(mode === "rollback");
        expect(read.status).toBe("maintenance");
        const final = await f.catalog().retireWriter(pending, "retire");
        expect(final.fence).toBe("1");
        expect(final.retirement?.head.sequence).toBe("1");
        expect(f.calls.retired).toBe(mode === "rollback" ? 2 : 1);
        expect(f.source.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual(
          { n: 1 },
        );
      } finally {
        f.close();
      }
    });
});

test("native catalog CAS rejects an activation observation that raced a different activation", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      const inspect = f.port.inspectProvisioned;
      f.port.inspectProvisioned = async (scope) => {
        const evidence = await inspect(scope);
        entered.resolve();
        await release.promise;
        return evidence;
      };
      const late = f
        .catalog()
        .activate(f.reserved, "late")
        .catch((error) => error);
      await entered.promise;
      f.port.inspectProvisioned = inspect;
      const winner = await f.catalog().activate(f.reserved, "winner");
      release.resolve();
      expect(await late).toMatchObject({ code: "native_catalog_head_conflict" });
      expect(await f.catalog().read()).toEqual(winner);
    } finally {
      release.resolve();
      f.close();
    }
  });
});

test("native catalog rejects missing, oversized and rehashed inconsistent records without automatic repair", async () => {
  await withBucket(async (bucket) => {
    const f = await fixture(bucket);
    try {
      const { contentHash: _, ...body } = f.reserved;
      const forged = { ...body, status: "active" as const };
      f.control.db.query("UPDATE ledger_native_catalog SET record=?").run(
        JSON.stringify({
          ...forged,
          contentHash: hashCanonical({
            domain: "rastrata-native-catalog-v1",
            body: JSON.stringify(forged),
          }).digest,
        }),
      );
      await expect(f.catalog().read()).rejects.toThrow("native_catalog_corrupt");
      f.control.db.query("UPDATE ledger_native_catalog SET record=?").run("x".repeat(65537));
      await expect(f.catalog().read()).rejects.toThrow("native_catalog_corrupt");
      f.control.db.exec("DELETE FROM ledger_native_catalog");
      await expect(f.catalog().read()).rejects.toThrow("native_catalog_corrupt");
      await expect(f.catalog().reserve(f.encoded, "repair")).rejects.toThrow(
        "native_catalog_corrupt",
      );
      const colocated = new NativeLedgerCatalog(
        f.source.storage,
        "catalog-object",
        f.scope,
        f.port,
      );
      await expect(colocated.read()).rejects.toThrow("native_catalog_storage_conflict");
      expect(
        () => new NativeLedgerCatalog(f.control.storage, f.scope.objectId, f.scope, f.port),
      ).toThrow("native_catalog_storage_conflict");
      const fresh = sqlite();
      try {
        const next = new NativeLedgerCatalog(
          fresh.storage,
          "next-catalog",
          { ...f.scope, generation: "1" },
          f.port,
        );
        await expect(next.reserve(f.encoded, "blank-replacement")).rejects.toThrow(
          "native_ledger_restore_required",
        );
        await expect(next.read()).rejects.toThrow("native_catalog_missing");
      } finally {
        fresh.db.close();
      }
    } finally {
      f.close();
    }
  });
});

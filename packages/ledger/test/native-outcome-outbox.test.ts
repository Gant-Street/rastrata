import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  decodeBookOutcome,
  decodeDurableBook,
  executeBookCommand,
  canonicalEncode,
  canonicalAccountingValue,
  sealCommand,
} from "@rastrata/kernel";
import { NativeLedger } from "../src/native-ledger.ts";
import {
  NativeOutcomeOutbox,
  sealNativeArchive,
  normalizeNativeArchiveSeal,
  readNativeArchiveOutcomes,
} from "../src/native-outcome-outbox.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { decodeStoredNativeOutcome } from "../src/native-outcome-storage.ts";
import {
  R2ArchiveObjectStore,
  referenceArchivePayload,
  type ArchiveR2Bucket,
} from "../src/r2-archive-store.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { withBucket } from "./r2-fixtures.ts";
import { genesis, activation, posting } from "./fixtures.ts";

function fixture(bucket: ArchiveR2Bucket) {
  const db = new Database(":memory:");
  const storage: SqliteStorage = {
    sql: {
      exec: (query, ...bindings) =>
        db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[],
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {},
  };
  const scope = {
    tenantId: "native-archive",
    bookId: "ledger-test-book",
    objectId: "native-object",
    namespaceId: "native-archive",
    generation: "0",
  };
  const authority = { fence: "0", pending: false };
  const source = () => new SqliteLedgerRepository(storage, scope, scope.objectId, () => authority);
  const repository = source(),
    ledger = new NativeLedger(repository);
  const store = new R2ArchiveObjectStore(bucket, scope, scope.objectId);
  const relay = () => new NativeOutcomeOutbox(source(), store, () => authority);
  return { db, scope, authority, repository, ledger, store, relay };
}

test("archive progress is bounded and read-only, counts retained rejections and survives a new observer", async () => {
  await withBucket(async (bucket) => {
    let writes = 0;
    const f = fixture({
      get: (key) => bucket.get(key),
      put: (...args) => {
        writes++;
        return bucket.put(...args);
      },
    });
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      await f.relay().drain();
      await f.ledger.execute(posting("saved"));
      expect((await f.ledger.execute(posting("rejected", 0n))).value.result.disposition).toBe(
        "rejected",
      );
      const limits: (number | undefined)[] = [];
      const observe = new NativeOutcomeOutbox(
        {
          scope: f.scope,
          outcomePage: (...args) => {
            limits.push(args[1]);
            return f.repository.outcomePage(...args);
          },
        },
        f.store,
        () => f.authority,
      );
      const before = await f.store.readControl(),
        beforeWrites = writes;
      const changes = () => f.db.query("SELECT total_changes() AS total").get();
      const beforeChanges = changes();
      expect(await observe.inspectProgress()).toEqual({
        status: "pending",
        writerFence: "0",
        archivedSequence: "1",
        observedSequence: "3",
        pendingOutcomes: "2",
      });
      expect(limits).toEqual([1]);
      expect(writes).toBe(beforeWrites);
      expect(changes()).toEqual(beforeChanges);
      expect(await f.store.readControl()).toEqual(before);
      await f.relay().drain();
      expect(await f.relay().inspectProgress()).toEqual({
        status: "caughtUp",
        writerFence: "0",
        archivedSequence: "3",
        observedSequence: "3",
        pendingOutcomes: "0",
      });
    } finally {
      f.db.close();
    }
  });
});

test.each([
  "missing",
  "malformed",
  "fenced",
  "manifest",
  "rewritten",
  "revoked",
  "source",
] as const)("archive progress never turns %s evidence into a healthy sample", async (fault) => {
  await withBucket(async (bucket) => {
    const f = fixture(bucket);
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      await f.relay().drain();
      const read = f.store.readControl.bind(f.store);
      const original = await read();
      if (!original) throw new Error("Missing fixture control");
      const selected = JSON.parse(original.body);
      if (fault === "manifest") await bucket.delete(selected.manifest.objectKey);
      if (fault === "source") f.db.exec("DELETE FROM ledger_native_outcomes WHERE sequence=1");
      let reads = 0;
      f.store.readControl = async () => {
        reads++;
        const current = await read();
        if (fault === "missing") return null;
        if (fault === "malformed") return { ...original, body: "{}" };
        if (fault === "fenced")
          return { ...original, body: JSON.stringify({ ...selected, fence: "1" }) };
        if (reads === 2 && fault === "rewritten") {
          await f.store.compareAndSwapControl(current, original.body);
          return read();
        }
        if (reads === 2 && fault === "revoked") f.authority.fence = "1";
        return current;
      };
      const expected = {
        missing: "native_archive_control_missing",
        malformed: "native_archive_invalid",
        fenced: "native_archive_writer_fenced",
        rewritten: "native_archive_observation_changed",
        revoked: "native_archive_writer_fenced",
        source: "native_ledger_head_corrupt",
      };
      if (fault === "manifest") await expect(f.relay().inspectProgress()).rejects.toThrow();
      else await expect(f.relay().inspectProgress()).rejects.toThrow(expected[fault]);
      const after = await read();
      if (fault === "rewritten") {
        expect(after).not.toEqual(original);
        expect(after?.body).toEqual(original.body);
      } else expect(after).toEqual(original);
    } finally {
      f.db.close();
    }
  });
});

test.each([
  ["upload", "success"],
  ["upload", "failure"],
  ["restore", "success"],
  ["restore", "failure"],
] as const)(
  "archive %s overlaps at most four payloads, retains order and settles active I/O: %s",
  async (direction, outcome) => {
    const fail = outcome === "failure";
    await withBucket(async (bucket) => {
      const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const completed = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const ready = Promise.withResolvers<void>();
      const payloadKeys = new Set<string>();
      let enabled = false,
        started = 0,
        active = 0,
        peak = 0;
      const completionOrder: number[] = [];
      const io = async <T>(work: () => Promise<T>) => {
        const ordinal = started++;
        active++;
        peak = Math.max(peak, active);
        if (started === 4) ready.resolve();
        try {
          await gates[ordinal]?.promise;
          if (fail && ordinal === 0) throw new Error("injected_payload_io_failure");
          return await work();
        } finally {
          active--;
          completionOrder.push(ordinal);
          completed[ordinal]?.resolve();
        }
      };
      const f = fixture({
        get: (key) =>
          enabled && direction === "restore" && payloadKeys.has(key)
            ? io(() => bucket.get(key))
            : bucket.get(key),
        put: (key, bytes, options) =>
          enabled && direction === "upload" && payloadKeys.has(key)
            ? io(() => bucket.put(key, bytes, options))
            : bucket.put(key, bytes, options),
      });
      let operation: Promise<unknown> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await f.ledger.provision(genesis(), activation());
        for (let index = 0; index < 8; index++)
          await f.ledger.execute(posting(`parallel-${index}`, BigInt(index + 1)));
        const stored = f.db
          .query("SELECT body FROM ledger_native_outcomes ORDER BY sequence")
          .all() as { body: string }[];
        const originals = stored.map((row) => ({ body: decodeStoredNativeOutcome(row.body) }));
        for (const row of originals)
          payloadKeys.add(
            referenceArchivePayload(f.scope, f.scope.objectId, new TextEncoder().encode(row.body))
              .objectKey,
          );
        await f.relay().initialize();
        const source = await f.repository.outcomePage();
        const readSealed = async () => {
          const seal = await sealNativeArchive(
            f.store,
            f.scope,
            createHash("sha256").update(source.genesis).digest("hex"),
            source.observedTip,
            "0",
            "1",
          );
          return () =>
            readNativeArchiveOutcomes(f.store, seal, JSON.parse(seal.control.body).manifest);
        };
        let read: Awaited<ReturnType<typeof readSealed>> | undefined;
        if (direction === "restore") {
          await f.relay().drain();
          read = await readSealed();
        }
        const before = await f.store.readControl();
        enabled = true;
        let settled = false;
        operation = direction === "upload" ? f.relay().drain() : read?.();
        if (!operation) throw new Error("Missing archive operation");
        void operation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        timer = setTimeout(
          () => ready.reject(new Error("Four payload operations did not start")),
          2000,
        );
        await ready.promise;
        clearTimeout(timer);
        expect(started).toBe(4);
        expect(active).toBe(4);
        gates[0]?.resolve();
        await completed[0]?.promise;
        // Yield one event-loop turn to observe fail-fast promise settlement. This
        // asserts lifecycle, not a latency target: three jobs remain explicitly held.
        await Bun.sleep(0);
        expect(settled).toBe(false);
        expect(started).toBe(4);
        expect(await f.store.readControl()).toEqual(before);
        for (const index of [3, 2, 1]) {
          gates[index]?.resolve();
          await completed[index]?.promise;
        }
        if (fail) {
          await expect(operation).rejects.toThrow(
            direction === "upload" ? "archive_write_uncertain" : "injected_payload_io_failure",
          );
          expect(started).toBe(4); // No later group starts after a failed payload.
          expect(await f.store.readControl()).toEqual(before);
        } else await operation;
        expect(active).toBe(0);
        expect(peak).toBe(4);
        expect(completionOrder.slice(0, 4)).toEqual([0, 3, 2, 1]);
        enabled = false;
        if (direction === "upload") {
          if (fail) await f.relay().drain();
          read = await readSealed();
        }
        const restored = await read?.();
        expect(restored?.outcomes.map((row) => row.head.sequence)).toEqual(
          Array.from({ length: 9 }, (_, index) => String(index + 1)),
        );
        expect(restored?.outcomes.map((row) => row.encoded)).toEqual(
          originals.map((row) => row.body),
        );
      } finally {
        clearTimeout(timer);
        for (const gate of gates) gate.resolve();
        await operation?.catch(() => {});
        f.db.close();
      }
    });
  },
  60000,
);

test("native outcomes deliver in contiguous bounded R2 batches and recover exact accounting without the primary", async () => {
  await withBucket(async (bucket) => {
    let puts = 0;
    const f = fixture({
      get: (key) => bucket.get(key),
      put: (...args) => {
        puts++;
        return bucket.put(...args);
      },
    });
    try {
      const commands = [
        activation(),
        posting("first"),
        posting("reject", 0n),
        posting("last", 2n),
      ] as const;
      await f.ledger.provision(genesis(), commands[0]);
      for (const command of commands.slice(1)) await f.ledger.execute(command);
      expect(puts).toBe(0);
      await expect(f.relay().drain()).rejects.toThrow("native_archive_control_missing");
      await f.relay().initialize();
      puts = 0;
      const first = await f.relay().drain(2);
      expect(first.disposition).toBe("advanced");
      expect(first.through.sequence).toBe("2");
      expect(first.observedTip.sequence).toBe("4");
      expect(puts).toBe(4); // Two payloads + one immutable manifest + one conditional control update.
      const last = await f.relay().drain(2);
      expect(last.through.sequence).toBe("4");
      expect((await f.relay().drain()).disposition).toBe("idle");
      // A new relay resumes from durable R2 state; inspection never reads SQL.
      const offline = new NativeOutcomeOutbox(
        {
          scope: f.scope,
          outcomePage: async () => {
            throw new Error("primary unavailable");
          },
        },
        f.store,
        () => f.authority,
      );
      const batches = [];
      for await (const batch of offline.inspect()) batches.push(batch);
      expect(batches).toHaveLength(3);
      const initial = decodeDurableBook(batches.at(-1)?.genesis ?? "");
      expect(initial.disposition).toBe("decoded");
      if (initial.disposition !== "decoded") throw new Error(initial.message);
      let recovered = initial.aggregate,
        oracle = genesis();
      const archived = batches.reverse().flatMap((batch) => batch.outcomes);
      expect(archived).toHaveLength(commands.length);
      for (const [index, outcome] of archived.entries()) {
        const decoded = decodeBookOutcome(outcome.encoded);
        if (decoded.disposition !== "decoded") throw new Error(decoded.message);
        const result = executeBookCommand(
          recovered.state,
          recovered.protocol,
          decoded.payload.command,
        );
        expect(canonicalEncode(canonicalAccountingValue(result.result))).toEqual(
          canonicalEncode(canonicalAccountingValue(decoded.payload.originalResult)),
        );
        recovered = { state: result.state, protocol: result.protocol };
        const command = commands[index];
        if (!command) throw new Error("missing expected command");
        const next = executeBookCommand(oracle.state, oracle.protocol, command);
        oracle = { state: next.state, protocol: next.protocol };
      }
      expect(recovered.state.contentHash).toEqual(oracle.state.contentHash);
      expect(canonicalEncode(canonicalAccountingValue(recovered.protocol))).toEqual(
        canonicalEncode(canonicalAccountingValue(oracle.protocol)),
      );
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("native archive retry reconciles uncertain pointer publication without repeating outcomes", async () => {
  await withBucket(async (bucket) => {
    let fail = false;
    const f = fixture({
      get: (key) => bucket.get(key),
      async put(key, bytes, options) {
        const result = await bucket.put(key, bytes, options);
        if (fail && key.endsWith("/control/anchor")) {
          fail = false;
          throw new Error("lost R2 reply");
        }
        return result;
      },
    });
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      fail = true;
      await expect(f.relay().drain()).rejects.toThrow("archive_write_uncertain");
      expect((await f.relay().drain()).through.sequence).toBe("1");
      const batches = [];
      for await (const batch of f.relay().inspect()) batches.push(batch);
      expect(batches.flatMap((batch) => batch.outcomes)).toHaveLength(1);
      const count = f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get();
      expect(count).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("native archive batch byte budget resumes without skipping a large valid outcome", async () => {
  await withBucket(async (bucket) => {
    const f = fixture(bucket);
    try {
      await f.ledger.provision(genesis(), activation());
      for (const [id, revision] of [
        ["large-a", 1n],
        ["large-b", 2n],
      ] as const) {
        const original = posting(id, revision);
        if (original.type !== "postJournal") throw new Error("expected posting");
        const command = sealCommand({
          ...original,
          resolved: {
            ...original.resolved,
            journal: { ...original.resolved.journal, narration: "x".repeat(200000) },
          },
        });
        expect((await f.ledger.execute(command)).value.result.disposition).toBe("committed");
      }
      await f.relay().initialize();
      const first = await f.relay().drain();
      expect(first.through.sequence).toBe("2");
      expect(first.observedTip.sequence).toBe("3");
      expect((await f.relay().drain()).through.sequence).toBe("3");
      const ids: string[] = [];
      for await (const batch of f.relay().inspect()) {
        expect(
          batch.outcomes.reduce(
            (sum, row) => sum + new TextEncoder().encode(row.encoded).byteLength,
            0,
          ),
        ).toBeLessThanOrEqual(1048576);
        ids.push(...batch.outcomes.map((row) => row.head.sequence));
      }
      expect(ids.sort()).toEqual(["1", "2", "3"]);
    } finally {
      f.db.close();
    }
  });
}, 60000);

test("competing native archive relays publish one contiguous prefix with conditional CAS", async () => {
  await withBucket(async (bucket) => {
    let hold = false,
      reads = 0;
    const ready = Promise.withResolvers<void>();
    const f = fixture({
      async get(key) {
        const value = await bucket.get(key);
        if (hold && key.endsWith("/control/anchor") && ++reads <= 2) {
          if (reads === 2) ready.resolve();
          await ready.promise;
        }
        return value;
      },
      put: (...args) => bucket.put(...args),
    });
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      hold = true;
      const results = await Promise.all([f.relay().drain(), f.relay().drain()]);
      expect(results.map((result) => result.disposition).sort()).toEqual(["advanced", "conflict"]);
      let outcomes = 0;
      for await (const batch of f.relay().inspect()) outcomes += batch.outcomes.length;
      expect(outcomes).toBe(1);
      expect((await f.relay().drain()).disposition).toBe("idle");
    } finally {
      ready.resolve();
      f.db.close();
    }
  });
}, 60000);

test("native archive publisher loses to a sealed higher fence and cannot resurrect", async () => {
  await withBucket(async (bucket) => {
    const blocked = Promise.withResolvers<void>(),
      reached = Promise.withResolvers<void>();
    let block = false;
    const f = fixture({
      get: (key) => bucket.get(key),
      async put(key, bytes, options) {
        if (block && key.includes("/immutable/")) {
          block = false;
          reached.resolve();
          await blocked.promise;
        }
        return bucket.put(key, bytes, options);
      },
    });
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      block = true;
      const publication = new NativeOutcomeOutbox(f.repository, f.store, () => f.authority).drain();
      await reached.promise;
      expect((await f.ledger.execute(posting("while-r2-blocked"))).value.result.disposition).toBe(
        "committed",
      );
      const current = await f.store.readControl();
      if (!current) throw new Error("missing control");
      expect(
        (
          await f.store.compareAndSwapControl(
            current,
            JSON.stringify({ ...JSON.parse(current.body), status: "sealed", fence: "1" }),
          )
        ).disposition,
      ).toBe("written");
      blocked.resolve();
      expect((await publication).disposition).toBe("conflict");
      await expect(f.relay().drain()).rejects.toThrow("native_archive_writer_fenced");
      expect(JSON.parse((await f.store.readControl())?.body ?? "{}").through.sequence).toBe("0");
    } finally {
      blocked.resolve();
      f.db.close();
    }
  });
}, 60000);

test("native final-head sealing rejects lag, defeats a delayed publisher and binds exact control for offline inspection", async () => {
  await withBucket(async (bucket) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let block = false;
    const f = fixture({
      get: (key) => bucket.get(key),
      async put(key, bytes, options) {
        if (block && key.includes("/immutable/")) {
          block = false;
          entered.resolve();
          await release.promise;
        }
        return bucket.put(key, bytes, options);
      },
    });
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      await f.relay().drain();
      const last = await f.ledger.execute(posting("final"));
      const page = await f.repository.outcomePage(null, 1);
      const genesisHash = createHash("sha256").update(page.genesis).digest("hex");
      await expect(
        sealNativeArchive(f.store, f.scope, genesisHash, last.head, "0", "1"),
      ).rejects.toThrow("native_archive_cutoff_incomplete");
      block = true;
      const delayed = f.relay().drain();
      await entered.promise;
      expect((await f.relay().drain()).through).toEqual(last.head);
      const seal = await sealNativeArchive(f.store, f.scope, genesisHash, last.head, "0", "1");
      expect(seal.head).toEqual(last.head);
      expect(seal.fence).toBe("1");
      release.resolve();
      expect((await delayed).disposition).toBe("conflict");
      await expect(f.relay().drain()).rejects.toThrow("native_archive_writer_fenced");
      expect(await sealNativeArchive(f.store, f.scope, genesisHash, last.head, "0", "1")).toEqual(
        seal,
      );
      const offline = new NativeOutcomeOutbox(
        {
          scope: f.scope,
          outcomePage: async () => {
            throw new Error("primary unavailable");
          },
        },
        f.store,
        () => f.authority,
      );
      const collect = async () => {
        const result = [];
        for await (const batch of offline.inspect(seal)) result.push(...batch.outcomes);
        return result;
      };
      expect((await collect()).map((row) => row.head.sequence).sort()).toEqual(["1", "2"]);
      let getterCalls = 0;
      const getter = Object.defineProperty({ ...seal }, "genesisHash", {
        enumerable: true,
        get() {
          getterCalls++;
          return genesisHash;
        },
      });
      expect(() => normalizeNativeArchiveSeal(getter, f.scope)).toThrow("native_archive_invalid");
      expect(getterCalls).toBe(0);
      const extra = Object.defineProperty({ ...seal }, "extra", {
        value: "hidden",
        enumerable: false,
      });
      expect(() => normalizeNativeArchiveSeal(extra, f.scope)).toThrow("native_archive_invalid");
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await f.store.readImmutable(JSON.parse(seal.control.body).manifest),
        ),
      );
      const payload = manifest.entries[0].payload;
      const original = await f.store.readImmutable(payload);
      await bucket.delete(payload.objectKey);
      await expect(collect()).rejects.toThrow("archive_payload_missing");
      expect(await f.store.putImmutable(original)).toEqual(payload);
      // Even a same-body control rewrite invalidates the approved storage version.
      expect(
        (await f.store.compareAndSwapControl(seal.control, seal.control.body)).disposition,
      ).toBe("written");
      await expect(collect()).rejects.toThrow("native_archive_seal_changed");
      const current = await f.store.readControl();
      if (!current) throw new Error("missing seal");
      await f.store.compareAndSwapControl(
        current,
        JSON.stringify({ ...JSON.parse(current.body), fence: "2" }),
      );
      await expect(
        sealNativeArchive(f.store, f.scope, genesisHash, last.head, "0", "1"),
      ).rejects.toThrow("native_archive_writer_fenced");
    } finally {
      release.resolve();
      f.db.close();
    }
  });
}, 60000);

test("native archive detects deleted control, missing historical payload and false manifest links", async () => {
  await withBucket(async (bucket) => {
    let controlKey = "";
    const f = fixture({
      get: (key) => bucket.get(key),
      put: (key, bytes, options) => {
        if (key.endsWith("/control/anchor")) controlKey = key;
        return bucket.put(key, bytes, options);
      },
    });
    try {
      await f.ledger.provision(genesis(), activation());
      await f.relay().initialize();
      await f.relay().drain();
      const current = await f.store.readControl();
      if (!current) throw new Error("missing control");
      const pointer = JSON.parse(current.body);
      const manifest = JSON.parse(
        new TextDecoder().decode(await f.store.readImmutable(pointer.manifest)),
      );
      const payload = manifest.entries[0].payload;
      await bucket.delete(payload.objectKey);
      // An idle drain is not a full historical backup audit.
      expect((await f.relay().drain()).disposition).toBe("idle");
      const inspect = async () => {
        for await (const _batch of f.relay().inspect()) {
          /* consume full verification */
        }
      };
      await expect(inspect()).rejects.toThrow("archive_payload_missing");
      const falseManifest = await f.store.putImmutable(
        new TextEncoder().encode(JSON.stringify({ ...manifest, from: manifest.through })),
      );
      expect(
        (
          await f.store.compareAndSwapControl(
            current,
            JSON.stringify({ ...pointer, manifest: falseManifest }),
          )
        ).disposition,
      ).toBe("written");
      await expect(f.relay().drain()).rejects.toThrow("recovery_segment_gap_detected");
      await bucket.delete(controlKey);
      await expect(f.relay().drain()).rejects.toThrow("native_archive_control_missing");
    } finally {
      f.db.close();
    }
  });
}, 60000);

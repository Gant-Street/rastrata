import { VirtualClock } from "../../src/clock.ts";
import { compactOnce } from "../../src/compactor.ts";
import { buildEntry, parseEntry, type BuiltEntry } from "../../src/entry.ts";
import { LogGapError, readLog } from "../../src/logreader.ts";
import { MemoryObjectStore } from "../../src/memory.ts";
import { BookKeys, type ObjectStore } from "../../src/objectstore.ts";
import { Rng } from "../../src/rng.ts";
import { Sealer } from "../../src/sealer.ts";
import { decodeSegment, verifySegment } from "../../src/segment.ts";
import { MemoryLogTier } from "../../src/tier-memory.ts";
import { GENESIS_HASH } from "../../src/tier.ts";
import type { FaultRates } from "../../src/wire.ts";

/** Sealing in isolation: entries are appended to the tail at a steady pace while one to three
 * sealers move them to the bulk store, a compactor merges old segments, readers materialize the
 * log at random moments, and the bulk store goes down, loses answers and kills sealers between
 * the write of a segment and the record of it. Entries are real (chained, hashed) but carry no
 * rows: this is about the log, not the application. */

export type SealScenario = "crash-before-trim" | "outage" | "duplicates" | "lost-answers" | "mixed";

export interface SealReport {
  readonly seed: number;
  readonly scenario: SealScenario;
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly entries: number;
  readonly segments: number;
  readonly overlappingSegments: number;
  readonly sealerKills: number;
  readonly deferred: number;
  readonly reused: number;
  readonly maxTailDepth: number;
  readonly finalTailDepth: number;
  /** Virtual milliseconds from the end of the last outage to an empty tail. */
  readonly recoveryMs: number | null;
  readonly readerReads: number;
  readonly readerTransientFailures: number;
  readonly readerGaps: number;
}

export async function runSealScenario(seed: number, scenario: SealScenario): Promise<SealReport> {
  const rng = new Rng(seed * 3 + 1);
  const clock = new VirtualClock();
  const keys = new BookKeys("runs/seal/", "b1");
  const rough = scenario === "mixed" || scenario === "lost-answers";
  const faults: FaultRates =
    scenario === "lost-answers"
      ? { failAfter: 0.15, failBefore: 0.05, duplicate: 0.05 }
      : scenario === "crash-before-trim"
        ? { killAfter: 0.12 }
        : scenario === "mixed"
          ? { failAfter: 0.05, failBefore: 0.05, duplicate: 0.04, killAfter: 0.04 }
          : {};
  const tier = new MemoryLogTier({
    clock,
    seed,
    latency: { medianMs: rng.between(1, 20), sigma: 0.5 },
    faults: rough ? { seal: { failAfter: 0.08, failBefore: 0.05 } } : {},
    timeoutMs: 800,
  });
  const bulk = new MemoryObjectStore({
    clock,
    seed: seed + 5,
    latency: { medianMs: rng.between(10, 100), sigma: 0.5 },
    faults: { put: faults, get: scenario === "lost-answers" ? { failBefore: 0.05 } : {} },
    timeoutMs: 800,
  });

  const violations: string[] = [];
  const built: BuiltEntry[] = [];
  const fail = (message: string) => violations.push(message);
  let maxDepth = 0;
  let kills = 0;
  let deferred = 0;
  let reused = 0;
  let reads = 0;
  let transient = 0;
  let gaps = 0;
  let writing = true;
  let stop = false;
  let outageEndedAt: number | null = null;
  let drainedAt: number | null = null;

  const lease = await clock.drive(tier.acquire("b1", "writer#1", 3_600_000));
  if (!lease.ok) throw new Error("no lease");
  const fence = lease.lease.fence;

  const entries = rng.between(30, 90);
  const writer = (async () => {
    for (let seq = 1; seq <= entries; seq += 1) {
      await clock.sleep(rng.between(5, 60));
      const prev = built[seq - 2]?.header.hash ?? GENESIS_HASH;
      const entry = buildEntry({
        bookId: "b1",
        seq,
        prev,
        writer: "writer#1",
        fence,
        schema: 1,
        kind: "commit",
        at: "2026-10-08T00:00:00.000Z",
        payload: new TextEncoder().encode(`payload ${seq}`),
        changes: 1,
      });
      for (;;) {
        try {
          const result = await tier.append("b1", {
            seq,
            prevHash: prev,
            hash: entry.header.hash,
            fence,
            body: entry.bytes,
          });
          if (result.ok) break;
          fail(`the writer's append ${seq} was refused (${result.reason})`);
          return;
        } catch {
          await clock.sleep(20);
        }
      }
      built.push(entry);
      const head = tier.peek("b1").head;
      maxDepth = Math.max(maxDepth, head.seq - head.sealedThrough);
    }
    writing = false;
  })();

  // Sealers: each loops; one may be killed (a process death), after which a new one is started.
  const sealerCount = scenario === "duplicates" || scenario === "mixed" ? rng.between(2, 3) : 1;
  let sealerNumber = 0;
  const nextProcess = () => {
    sealerNumber += 1;
    return sealerNumber;
  };
  const startSealer = (): Promise<void> => {
    const name = `sealer#${nextProcess()}`;
    const sealer = new Sealer({
      tier: tier.client(name),
      bulk: bulk.client(name),
      keys,
      clock,
      backoffMs: 20,
      attempts: 3,
    });
    return (async () => {
      while (!stop) {
        await clock.sleep(rng.between(30, 250));
        if (stop) return;
        const outcome = await sealer.sealOnce().catch((error: unknown) => {
          fail(
            `a sealer failed with an error that is not a deferral: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { status: "deferred" } as const;
        });
        if (outcome.status === "deferred") deferred += 1;
        if (outcome.status === "sealed" && outcome.reused) reused += 1;
      }
    })();
  };
  bulk.wire.onKill((client) => {
    if (client.startsWith("sealer#")) {
      kills += 1;
      // The process is replaced, as an orchestrator would.
      void startSealer();
    }
  });
  for (let index = 0; index < sealerCount; index += 1) void startSealer();

  // The bulk store goes down for a while.
  const outages = (async () => {
    if (scenario !== "outage" && scenario !== "mixed") return;
    const windows = rng.between(1, 3);
    for (let index = 0; index < windows; index += 1) {
      await clock.sleep(rng.between(100, 800));
      const before = bulk.wire;
      void before;
      bulk.configure({
        faults: { put: { failBefore: 1 }, get: { failBefore: 1 }, list: { failBefore: 1 } },
      });
      await clock.sleep(rng.between(300, 2500));
      bulk.configure({ faults: { put: faults, get: {}, list: {} } });
      outageEndedAt = clock.now();
    }
  })();

  // The compactor.
  const compactor = (async () => {
    if (scenario !== "duplicates" && scenario !== "mixed") return;
    while (!stop) {
      await clock.sleep(rng.between(200, 900));
      if (stop) return;
      await Promise.race([
        compactOnce({
          bulk: bulk.client(`compactor#${nextProcess()}`),
          keys,
          minSegments: 3,
          clock,
          backoffMs: 20,
          attempts: 2,
        }).catch(() => {}),
        clock.sleep(5000),
      ]);
    }
  })();

  // Readers: a fresh process reads the whole log at random moments; it may be told to try again
  // (a lost answer), never that something is missing.
  const reader = (async () => {
    while (!stop) {
      await clock.sleep(rng.between(100, 700));
      if (stop) return;
      reads += 1;
      const seen: string[] = [];
      try {
        const generator = readLog({
          tier,
          bulk: bulk.client(`reader#${reads}`),
          keys,
          schema: 1,
          after: { seq: 0, hash: GENESIS_HASH },
        });
        for (let step = await generator.next(); !step.done; step = await generator.next())
          seen.push(step.value.header.hash);
        for (let index = 0; index < seen.length; index += 1)
          if (seen[index] !== built[index]?.header.hash && built[index] !== undefined)
            fail(`a reader saw entry ${index + 1} differ from the one appended`);
      } catch (error) {
        if (error instanceof LogGapError) {
          gaps += 1;
          fail(`a reader found a gap: ${error.message}`);
        } else transient += 1;
      }
    }
  })();

  // The run ends when the writer is done and the tail has been emptied (or it plainly never will be).
  const monitor = (async () => {
    for (;;) {
      await clock.sleep(100);
      const head = tier.peek("b1").head;
      if (!writing && head.sealedThrough === head.seq) {
        drainedAt = clock.now();
        break;
      }
      if (clock.now() > 900_000) {
        fail("the tail did not empty within fifteen minutes of virtual time");
        break;
      }
    }
    stop = true;
  })();

  await clock.drive(Promise.all([writer, outages, compactor, reader, monitor]), {
    maxSteps: 2_000_000,
  });
  const drainedMs = drainedAt;

  // Faults off; one more look at everything.
  tier.configure({ faults: {}, latency: { medianMs: 0 } });
  tier.wire.clearScript();
  bulk.configure({ faults: {}, latency: { medianMs: 0 } });
  bulk.wire.clearScript();
  await clock.drive(
    (async () => {
      const closer = new Sealer({ tier, bulk, keys, clock });
      await closer.sealOnce();
    })(),
  );

  const head = tier.peek("b1").head;
  if (head.seq !== built.length)
    fail(`the tail's head is ${head.seq}, ${built.length} entries were appended`);
  const finalDepth = head.seq - head.sealedThrough;

  // No gap, no duplicate, no lost entry: the log reads whole and equals what was appended.
  const all: string[] = [];
  try {
    const generator = readLog({
      tier,
      bulk,
      keys,
      schema: 1,
      after: { seq: 0, hash: GENESIS_HASH },
    });
    for (let step = await generator.next(); !step.done; step = await generator.next())
      all.push(step.value.header.hash);
  } catch (error) {
    fail(
      `the finished log does not read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (all.length !== built.length)
    fail(`the finished log has ${all.length} entries, ${built.length} were appended`);
  all.forEach((hash, index) => {
    if (hash !== built[index]?.header.hash)
      fail(`entry ${index + 1} of the finished log is not the one appended`);
  });

  // Every sealed segment is a chain of genuine entries, and overlapping ones agree.
  const byRange: { key: string; from: number; to: number }[] = [];
  const seen = new Map<number, string>();
  let overlapping = 0;
  for (const key of bulk.keys(keys.sealedPrefix)) {
    const range = keys.rangeOfSealed(key);
    if (!range) {
      fail(`a stray object ${key} is among the segments`);
      continue;
    }
    byRange.push({ key, ...range });
    try {
      const verified = verifySegment(bulk.peek(key)?.body as Uint8Array, "b1", null).headers;
      // verifySegment from null only fits segments starting at 1; chain the others by their own links.
      void verified;
    } catch {
      // checked below, entry by entry
    }
    for (const bytes of decodeSegment(bulk.peek(key)?.body as Uint8Array)) {
      const { header } = parseEntry(bytes);
      if (header.seq < range.from || header.seq > range.to)
        fail(`${key} holds entry ${header.seq} outside its range`);
      const known = seen.get(header.seq);
      if (known !== undefined && known !== header.hash)
        fail(`two segments disagree about entry ${header.seq}`);
      if (known !== undefined) overlapping += 1;
      seen.set(header.seq, header.hash);
      if (built[header.seq - 1]?.header.hash !== header.hash)
        fail(`${key} holds an entry that was never appended at ${header.seq}`);
    }
  }
  if (head.sealedThrough > 0 && head.sealedHash !== built[head.sealedThrough - 1]?.header.hash)
    fail("the tail's sealed hash is not the hash of the entry it says is sealed");
  for (const entry of tier.peek("b1").entries)
    if (entry.seq <= head.sealedThrough) fail(`the tail still holds sealed entry ${entry.seq}`);
  if (finalDepth !== 0) fail(`the tail did not empty: ${finalDepth} entries remain`);

  return {
    seed,
    scenario,
    ok: violations.length === 0,
    violations,
    entries: built.length,
    segments: byRange.length,
    overlappingSegments: overlapping,
    sealerKills: kills,
    deferred,
    reused,
    maxTailDepth: maxDepth,
    finalTailDepth: finalDepth,
    recoveryMs:
      outageEndedAt !== null && drainedMs !== null ? Math.max(0, drainedMs - outageEndedAt) : null,
    readerReads: reads,
    readerTransientFailures: transient,
    readerGaps: gaps,
  };
}

export type { ObjectStore };

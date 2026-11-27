import { expect, test } from "bun:test";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { MeteredLogTier } from "../src/metered-tier.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { GENESIS_HASH } from "../src/tier.ts";
import { entryAfter } from "./support/tier-conformance.ts";

const rows = (recorder: ReturnType<typeof recordTelemetry>, kind: string) =>
  recorder.sum("tail.rows.written", { tail_kind: kind });

test("the rows a Durable Object tail writes are counted as it writes them: an entry, a lease call, a trim", async () => {
  const recorder = recordTelemetry();
  try {
    const tail = new MeteredLogTier(new MemoryLogTier({ name: "durable-object" }));
    const lease = await tail.acquire("b", "pod", 5000);
    if (!lease.ok) throw new Error("no lease");
    expect(rows(recorder, "durable_object")).toBe(1);
    await tail.renew("b", { holder: "pod", fence: lease.lease.fence }, 5000);
    expect(rows(recorder, "durable_object")).toBe(2);
    const first = entryAfter(1, GENESIS_HASH, lease.lease.fence);
    await tail.append("b", first);
    expect(rows(recorder, "durable_object")).toBe(3);
    // A repeat and a refusal write nothing.
    await tail.append("b", first);
    await tail.append("b", entryAfter(5, first.hash, lease.lease.fence));
    expect(rows(recorder, "durable_object")).toBe(3);
    const second = entryAfter(2, first.hash, lease.lease.fence);
    await tail.append("b", second);
    expect(rows(recorder, "durable_object")).toBe(4);
    // Sealing two entries deletes two rows and writes the head row.
    await tail.seal("b", {
      upTo: 2,
      manifest: {
        from: 1,
        to: 2,
        key: "k",
        sha256: "0".repeat(64),
        bytes: 1,
        lastHash: second.hash,
      },
    });
    expect(rows(recorder, "durable_object")).toBe(7);
    await tail.release("b", { holder: "pod", fence: lease.lease.fence });
    expect(rows(recorder, "durable_object")).toBe(8);
    expect(recorder.invalid).toEqual([]);
  } finally {
    recorder.stop();
  }
});

test("a Postgres tail is counted as before: two rows for an append, the lease not counted", async () => {
  const recorder = recordTelemetry();
  try {
    const tail = new MeteredLogTier(new MemoryLogTier({ name: "postgres" }));
    const lease = await tail.acquire("b", "pod", 5000);
    if (!lease.ok) throw new Error("no lease");
    await tail.append("b", entryAfter(1, GENESIS_HASH, lease.lease.fence));
    expect(rows(recorder, "postgres")).toBe(2);
  } finally {
    recorder.stop();
  }
});

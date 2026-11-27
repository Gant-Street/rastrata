import { expect, test } from "bun:test";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { VirtualClock } from "../src/clock.ts";
import { ObjectStoreError, ObjectStoreUncertain } from "../src/objectstore.ts";
import { Rng } from "../src/rng.ts";
import { GuardedLogTier, TailUnavailableError } from "../src/tier-guard.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { type LogTier, GENESIS_HASH } from "../src/tier.ts";
import { entryAfter } from "./support/tier-conformance.ts";

/** A tail that fails on demand and counts the calls it was asked to make. */
class Flaky implements LogTier {
  readonly capabilities = { name: "durable-object", leases: true } as const;
  readonly inner = new MemoryLogTier();
  calls = 0;
  failWith: (() => Error) | null = null;
  #call<T>(work: () => Promise<T>): Promise<T> {
    this.calls += 1;
    return this.failWith ? Promise.reject(this.failWith()) : work();
  }
  head = (book: string) => this.#call(() => this.inner.head(book));
  readFrom = (book: string, seq: number, limit?: number) =>
    this.#call(() => this.inner.readFrom(book, seq, limit));
  append = (book: string, input: Parameters<LogTier["append"]>[1]) =>
    this.#call(() => this.inner.append(book, input));
  acquire = (book: string, holder: string, ttl: number) =>
    this.#call(() => this.inner.acquire(book, holder, ttl));
  renew = (book: string, lease: { holder: string; fence: number }, ttl: number) =>
    this.#call(() => this.inner.renew(book, lease, ttl));
  release = (book: string, lease: { holder: string; fence: number }) =>
    this.#call(() => this.inner.release(book, lease));
  seal = (book: string, input: Parameters<LogTier["seal"]>[1]) =>
    this.#call(() => this.inner.seal(book, input));
  adopt = (book: string, state: { seq: number; hash: string; fence: number }) =>
    this.#call(() => this.inner.adopt(book, state));
}

const down = () => new ObjectStoreUncertain("durable object head: HTTP 429", 429);

function guarded(options: { baseMs?: number; maxMs?: number; threshold?: number } = {}) {
  const clock = new VirtualClock(1_000_000);
  const rng = new Rng(7);
  const flaky = new Flaky();
  const guard = new GuardedLogTier(flaky, {
    clock,
    random: () => rng.next(),
    ...(options.baseMs ? { baseMs: options.baseMs } : {}),
    ...(options.maxMs ? { maxMs: options.maxMs } : {}),
    ...(options.threshold ? { failureThreshold: options.threshold } : {}),
  });
  const wait = (ms: number) => clock.drive(clock.sleep(ms));
  return { clock, flaky, guard, wait };
}

const fails = async (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => error,
  );

test("isolated failures do not open it: only failures in a row do", async () => {
  const { flaky, guard } = guarded();
  flaky.failWith = down;
  const first = await fails(guard.head("b"));
  expect(first).toBeInstanceOf(ObjectStoreUncertain);
  expect(first).not.toBeInstanceOf(TailUnavailableError);
  expect(await fails(guard.head("b"))).toBeInstanceOf(ObjectStoreUncertain);
  flaky.failWith = null;
  await guard.head("b");
  expect(guard.status()).toMatchObject({ state: "closed", failures: 0 });
  flaky.failWith = down;
  await fails(guard.head("b"));
  await fails(guard.head("b"));
  expect(guard.status().state).toBe("closed");
  // The failure that opens it is reported as what it has become: the tail is not being called.
  const third = await fails(guard.head("b"));
  expect(third).toBeInstanceOf(TailUnavailableError);
  expect((third as TailUnavailableError).cause).toBeInstanceOf(ObjectStoreUncertain);
  expect(guard.status().state).toBe("open");
});

test("open, it refuses every call at once without making a request, and says when it will try again", async () => {
  const recorder = recordTelemetry();
  try {
    const { flaky, guard } = guarded();
    flaky.failWith = down;
    for (let i = 0; i < 3; i += 1) await fails(guard.head("b"));
    const calls = flaky.calls;
    for (const call of [
      () => guard.head("b"),
      () => guard.readFrom("b", 1),
      () => guard.append("b", entryAfter(1, GENESIS_HASH, 1)),
      () => guard.acquire("b", "pod", 5000),
      () => guard.renew("b", { holder: "pod", fence: 1 }, 5000),
      () => guard.release("b", { holder: "pod", fence: 1 }),
      () =>
        guard.seal("b", {
          upTo: 0,
          manifest: { from: 1, to: 0, key: "k", sha256: "", bytes: 0, lastHash: GENESIS_HASH },
        }),
    ]) {
      const error = await fails(call());
      expect(error).toBeInstanceOf(TailUnavailableError);
      // It is what every caller already copes with for a tail that cannot be reached.
      expect(error).toBeInstanceOf(ObjectStoreUncertain);
      const wait = (error as TailUnavailableError).retryAfterMs;
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(1000);
    }
    expect(flaky.calls).toBe(calls);
    expect(guard.status()).toMatchObject({ state: "open", rejected: 7, opened: 1, closed: 0 });
    expect(recorder.sum("tail.breaker", { breaker_event: "rejected" })).toBe(7);
    expect(recorder.sum("tail.breaker", { breaker_event: "opened" })).toBe(1);
    expect(recorder.invalid).toEqual([]);
  } finally {
    recorder.stop();
  }
});

test("after its wait one call goes through as a probe, the rest are refused meanwhile, and an answer closes it", async () => {
  const recorder = recordTelemetry();
  try {
    const { flaky, guard, wait } = guarded();
    flaky.failWith = down;
    for (let i = 0; i < 3; i += 1) await fails(guard.head("b"));
    await wait(500);
    expect(await fails(guard.head("b"))).toBeInstanceOf(TailUnavailableError); // 500 ms: still within the wait
    await wait(600);
    flaky.failWith = null;
    // The probe, with another call arriving while it is out.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = flaky.inner.head.bind(flaky.inner);
    flaky.inner.head = async (book) => {
      await held;
      return real(book);
    };
    const probe = guard.head("b");
    expect(await fails(guard.head("b"))).toBeInstanceOf(TailUnavailableError);
    expect(guard.status().state).toBe("half-open");
    release();
    await probe;
    expect(guard.status()).toMatchObject({ state: "closed", failures: 0, closed: 1 });
    expect(recorder.sum("tail.breaker", { breaker_event: "closed" })).toBe(1);
    // It counts from the start again.
    flaky.failWith = down;
    await fails(guard.head("b"));
    await fails(guard.head("b"));
    expect(guard.status().state).toBe("closed");
  } finally {
    recorder.stop();
  }
});

test("a probe that fails opens it again for about twice as long, to a cap, each wait drawn between half and all of it", async () => {
  const { flaky, guard, clock, wait } = guarded({ baseMs: 1000, maxMs: 30_000 });
  flaky.failWith = down;
  for (let i = 0; i < 3; i += 1) await fails(guard.head("b"));
  const waits: number[] = [];
  for (let round = 0; round < 9; round += 1) {
    const opened = clock.now();
    const retry = guard.status().retryInMs;
    waits.push(retry);
    await wait(retry - 1);
    expect(await fails(guard.head("b"))).toBeInstanceOf(TailUnavailableError);
    await wait(2);
    // The probe, which fails, and is reported as the others are.
    const probe = await fails(guard.head("b"));
    expect(probe).toBeInstanceOf(TailUnavailableError);
    expect((probe as TailUnavailableError).cause).toBeInstanceOf(ObjectStoreUncertain);
    expect(clock.now()).toBeGreaterThanOrEqual(opened + retry);
  }
  waits.forEach((retry, index) => {
    const full = Math.min(30_000, 1000 * 2 ** index);
    expect(retry, `wait ${index + 1}`).toBeGreaterThanOrEqual(Math.round(full * 0.5));
    expect(retry, `wait ${index + 1}`).toBeLessThanOrEqual(full);
  });
  // They are not all alike: that is the jitter.
  expect(new Set(waits.slice(5)).size).toBeGreaterThan(1);
});

test("during a long outage the tail is asked a handful of times, not at the pace of its callers", async () => {
  const { flaky, guard, clock } = guarded({ baseMs: 1000, maxMs: 60_000 });
  flaky.failWith = down;
  // A caller every 100 ms for half an hour: renewals, requests, reads.
  let refused = 0;
  const calls = 18_000;
  await clock.drive(
    (async () => {
      for (let i = 0; i < calls; i += 1) {
        const error = await fails(guard.head("b"));
        if (error instanceof TailUnavailableError) refused += 1;
        await clock.sleep(100);
      }
    })(),
  );
  // 3 to open, then about one probe per half to full minute at the cap.
  expect(flaky.calls).toBeLessThan(90);
  expect(refused).toBeGreaterThan(calls - 90);
  // It comes back as soon as the tail does, at the next probe.
  flaky.failWith = null;
  await clock.drive(
    (async () => {
      while (guard.status().state !== "closed") {
        await fails(guard.head("b"));
        await clock.sleep(100);
      }
    })(),
  );
  expect(guard.status().state).toBe("closed");
  await guard.head("b");
});

test("an append that was sent keeps the error it failed with, so that it is treated as uncertain, not as refused", async () => {
  const { flaky, guard } = guarded({ threshold: 1 });
  flaky.failWith = down;
  const opening = await fails(guard.append("b", entryAfter(1, GENESIS_HASH, 1)));
  expect(opening).toBeInstanceOf(ObjectStoreUncertain);
  expect(opening).not.toBeInstanceOf(TailUnavailableError);
  expect(guard.status().state).toBe("open");
  // Refused without being sent, it says so.
  expect(await fails(guard.append("b", entryAfter(1, GENESIS_HASH, 1)))).toBeInstanceOf(
    TailUnavailableError,
  );
});

test("what counts as the tail failing: unreachable, limited, or refusing our token; and what does not", async () => {
  for (const [what, failure, opens] of [
    ["a lost answer", () => new ObjectStoreUncertain("timeout"), true],
    ["a 5xx", () => new ObjectStoreUncertain("HTTP 503", 503), true],
    [
      "the daily limit",
      () => new ObjectStoreUncertain("HTTP 429 (Cloudflare error 1027)", 429),
      true,
    ],
    ["our token refused", () => new ObjectStoreError("HTTP 401", 401), true],
    ["forbidden", () => new ObjectStoreError("HTTP 403", 403), true],
    ["a request the tail found wrong", () => new ObjectStoreError("HTTP 400", 400), false],
    ["an entry that is too large", () => new ObjectStoreError("HTTP 413", 413), false],
  ] as const) {
    const { flaky, guard } = guarded();
    flaky.failWith = failure;
    for (let i = 0; i < 5; i += 1) await fails(guard.head("b"));
    expect(guard.status().state === "open", what).toBe(opens);
    expect(flaky.calls, what).toBe(opens ? 3 : 5);
  }
});

test("a refusal by the protocol is an answer: the tail was reached", async () => {
  const { flaky, guard } = guarded();
  const lease = await guard.acquire("b", "pod-a", 5000);
  expect(lease.ok).toBe(true);
  const refused = await guard.acquire("b", "pod-b", 5000);
  expect(refused.ok).toBe(false);
  const stale = await guard.append("b", entryAfter(1, GENESIS_HASH, 99));
  expect(stale.ok).toBe(false);
  expect(guard.status()).toMatchObject({ state: "closed", failed: 0, calls: 3 });
  flaky.failWith = down;
  await fails(guard.head("b"));
  await fails(guard.head("b"));
  // A refusal in between resets the count, as any answer does.
  flaky.failWith = null;
  await guard.acquire("b", "pod-b", 5000);
  flaky.failWith = down;
  await fails(guard.head("b"));
  await fails(guard.head("b"));
  expect(guard.status().state).toBe("closed");
});

test("it never repeats a call, so it never sends an append twice", async () => {
  const { flaky, guard } = guarded();
  const lease = await guard.acquire("b", "pod-a", 5000);
  if (!lease.ok) throw new Error("no lease");
  const before = flaky.calls;
  flaky.failWith = down;
  await fails(guard.append("b", entryAfter(1, GENESIS_HASH, lease.lease.fence)));
  expect(flaky.calls - before).toBe(1);
});

test("restoration is offered only if the tail underneath offers it", () => {
  const { guard } = guarded();
  expect(guard.adopt).toBeDefined();
  const bare: LogTier = {
    capabilities: { name: "x", leases: false },
    head: async () => {
      throw new Error("unused");
    },
    readFrom: async () => {
      throw new Error("unused");
    },
    append: async () => {
      throw new Error("unused");
    },
    acquire: async () => {
      throw new Error("unused");
    },
    renew: async () => {
      throw new Error("unused");
    },
    release: async () => {},
    seal: async () => {
      throw new Error("unused");
    },
  };
  expect(new GuardedLogTier(bare).adopt).toBeUndefined();
});

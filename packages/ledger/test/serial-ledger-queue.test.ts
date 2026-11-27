import { expect, test } from "bun:test";
import { SerialLedgerQueue } from "../src/serial-ledger-queue.ts";

function held<T>() {
  return Promise.withResolvers<T>();
}

test("bounded admission counts active work, preserves FIFO and releases failures", async () => {
  const queue = new SerialLedgerQueue({ capacity: 2, maximumWaitMs: 1000 });
  const blocker = held<number>();
  const calls: string[] = [];
  const first = queue.run(() => {
    calls.push("first");
    return blocker.promise;
  });
  const second = queue.run(async () => {
    calls.push("second");
    throw new Error("write failed");
  });
  // Attach the rejection assertion before releasing the active operation.
  const failed = second.catch((error: unknown) => error);
  await expect(queue.run(async () => calls.push("overflow"))).rejects.toThrow(
    "native_ledger_overloaded",
  );
  expect(calls).toEqual(["first"]);
  blocker.resolve(1);
  expect(await first).toBe(1);
  expect(await failed).toMatchObject({ message: "write failed" });
  expect(await queue.run(async () => 3)).toBe(3);
  expect(calls).toEqual(["first", "second"]);
});

test("queue deadlines remove retained waiters without releasing an uncertain active write", async () => {
  const queue = new SerialLedgerQueue({ capacity: 2, maximumWaitMs: 5 });
  const blocker = held<number>();
  const first = queue.run(() => blocker.promise);
  let ran = false;
  for (let cycle = 0; cycle < 5; cycle++) {
    await expect(
      queue.run(async () => {
        ran = true;
      }),
    ).rejects.toThrow("native_ledger_queue_timeout");
  }
  // All expired slots were reclaimed while the same write still owns the queue.
  expect(ran).toBeFalse();
  blocker.resolve(7);
  expect(await first).toBe(7);
  expect(await queue.run(async () => 8)).toBe(8);
});

test("expired work cannot sneak past delayed timers at dequeue", async () => {
  const queue = new SerialLedgerQueue({ capacity: 2, maximumWaitMs: 5 });
  const blocker = held<void>();
  const first = queue.run(() => blocker.promise);
  let ran = false;
  const waiting = queue.run(async () => {
    ran = true;
  });
  const expired = waiting.catch((error: unknown) => error);
  // Deliberately block timer delivery while advancing monotonic wall time.
  const until = performance.now() + 10;
  while (performance.now() < until) {}
  blocker.resolve();
  await first;
  expect(await expired).toMatchObject({ message: "native_ledger_queue_timeout" });
  expect(ran).toBeFalse();
});

test("capacity-one queues recover after synchronous throws and reject invalid bounds", async () => {
  const queue = new SerialLedgerQueue({ capacity: 1, maximumWaitMs: 100 });
  await expect(
    queue.run(() => {
      throw new Error("synchronous failure");
    }),
  ).rejects.toThrow("synchronous failure");
  expect(await queue.run(async () => "ready")).toBe("ready");
  for (const limits of [
    { capacity: 0, maximumWaitMs: 1 },
    { capacity: 1025, maximumWaitMs: 1 },
    { capacity: 1.5, maximumWaitMs: 1 },
    { capacity: 1, maximumWaitMs: 0 },
    { capacity: 1, maximumWaitMs: 60_001 },
    { capacity: 1, maximumWaitMs: NaN },
  ])
    expect(() => new SerialLedgerQueue(limits)).toThrow("native_ledger_queue_limits_invalid");
});

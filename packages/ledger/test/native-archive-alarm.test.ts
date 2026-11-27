import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeArchiveAlarm, type NativeAlarmStorage } from "../src/native-archive-alarm.ts";
import { NativeLedger } from "../src/native-ledger.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { genesis, activation, posting } from "./fixtures.ts";

const head = { sequence: "1", bookRevision: "1", chainHash: "0".repeat(64) };
const idle = { disposition: "idle" as const, through: head, observedTip: head };
function alarms() {
  const state = { scheduled: null as number | null, gets: 0, sets: 0, fail: false, now: 1000000 };
  const storage: NativeAlarmStorage = {
    async getAlarm() {
      state.gets++;
      return state.scheduled;
    },
    async setAlarm(deadline) {
      state.sets++;
      if (state.fail) throw new Error("alarm storage unavailable");
      state.scheduled = deadline;
    },
  };
  return { state, storage };
}

test("native archive alarm coalesces warm arms and preserves the earliest durable deadline", async () => {
  const f = alarms(),
    relay = { drain: async () => idle };
  const alarm = new NativeArchiveAlarm(f.storage, relay, 60000, () => f.state.now);
  await Promise.all(Array.from({ length: 16 }, () => alarm.arm()));
  expect(f.state).toMatchObject({ gets: 1, sets: 1, scheduled: 1060000 });
  f.state.now += 1000;
  await alarm.arm();
  expect(f.state).toMatchObject({ gets: 1, sets: 1, scheduled: 1060000 });
  const restarted = new NativeArchiveAlarm(f.storage, relay, 60000, () => f.state.now);
  await restarted.arm();
  expect(f.state).toMatchObject({ gets: 2, sets: 1, scheduled: 1060000 });
  f.state.scheduled = null; // Platform delivery consumes the old deadline.
  await restarted.run();
  expect(f.state.scheduled).toBeNull();
  await restarted.arm();
  expect(f.state).toMatchObject({ gets: 3, sets: 2, scheduled: 1061000 });
});

test("native archive alarm reschedules failures and backlog without deleting a concurrent command alarm", async () => {
  const f = alarms();
  let fail = true,
    pending = true;
  let drains = 0;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const alarm = new NativeArchiveAlarm(
    f.storage,
    {
      async drain() {
        drains++;
        if (fail) throw new Error("R2 unavailable");
        if (pending) return { ...idle, observedTip: { ...head, sequence: "2" } };
        entered.resolve();
        await release.promise;
        return idle;
      },
    },
    60000,
    () => f.state.now,
  );
  await expect(alarm.run()).rejects.toThrow("R2 unavailable");
  expect(f.state.scheduled).toBe(1060000);
  fail = false;
  f.state.scheduled = null;
  await alarm.run();
  expect(f.state.sets).toBe(2);
  expect(drains).toBe(9); // One failed attempt, then eight bounded backlog batches.
  expect(await f.storage.getAlarm()).toBe(1001000);
  pending = false;
  f.state.scheduled = null;
  const running = alarm.run();
  await entered.promise;
  await alarm.arm();
  const next = await f.storage.getAlarm();
  release.resolve();
  await running;
  expect(await f.storage.getAlarm()).toBe(next);
  expect(next).toBe(1060000);
});

test("a lost alarm acknowledgement is reconciled from durable storage on retry", async () => {
  const f = alarms();
  let lose = true;
  const alarm = new NativeArchiveAlarm(
    {
      getAlarm: () => f.storage.getAlarm(),
      async setAlarm(deadline) {
        await f.storage.setAlarm(deadline);
        if (lose) {
          lose = false;
          throw new Error("lost alarm acknowledgement");
        }
      },
    },
    { drain: async () => idle },
    60000,
    () => f.state.now,
  );
  await expect(alarm.arm()).rejects.toThrow("lost alarm acknowledgement");
  expect(f.state.scheduled).toBe(1060000);
  await alarm.arm();
  expect(f.state).toMatchObject({ gets: 2, sets: 1, scheduled: 1060000 });
});

test("backlog wake advances a later concurrent command timer without waiting the initial delay", async () => {
  const f = alarms();
  let drains = 0;
  const alarm = new NativeArchiveAlarm(
    f.storage,
    {
      async drain() {
        if (drains++ === 0) await alarm.arm();
        return { ...idle, observedTip: { ...head, sequence: "2" } };
      },
    },
    60000,
    () => f.state.now,
  );
  await alarm.run();
  expect(drains).toBe(8);
  expect(f.state).toMatchObject({ scheduled: 1001000, sets: 2 });
});

test("alarm delivery invalidates an in-flight stale arm observation", async () => {
  const f = alarms(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let first = true;
  const alarm = new NativeArchiveAlarm(
    {
      async getAlarm() {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
          return 999999;
        }
        return f.storage.getAlarm();
      },
      setAlarm: (deadline) => f.storage.setAlarm(deadline),
    },
    {
      drain: async () => {
        throw new Error("R2 unavailable");
      },
    },
    60000,
    () => f.state.now,
  );
  const arm = alarm.arm();
  await entered.promise;
  const delivery = alarm.run().catch((error) => error);
  release.resolve();
  await arm;
  expect(await delivery).toMatchObject({ message: "R2 unavailable" });
  expect(f.state.scheduled).toBe(1060000);
  expect(f.state.sets).toBe(1);
});

function book() {
  const db = new Database(":memory:"),
    queries: string[] = [];
  const storage: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        queries.push(query);
        return db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {},
  };
  const scope = {
    tenantId: "alarm-test",
    bookId: "ledger-test-book",
    namespaceId: "alarm-test",
    objectId: "book-A",
    generation: "0",
  };
  const authority = { fence: "0", pending: false };
  return {
    db,
    queries,
    authority,
    repository: new SqliteLedgerRepository(storage, scope, scope.objectId, () => authority),
  };
}

test("native command queue cannot expose an empty archive backlog between alarm arming and commit", async () => {
  const f = book();
  try {
    await new NativeLedger(f.repository).provision(genesis(), activation());
    const a = alarms(),
      armed = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const alarm = new NativeArchiveAlarm(
      a.storage,
      { drain: async () => idle },
      60000,
      () => a.state.now,
    );
    const ledger = new NativeLedger(f.repository, async () => {
      await alarm.arm();
      armed.resolve();
      await release.promise;
    });
    const commit = ledger.execute(posting("armed-before-commit"));
    await armed.promise;
    expect(a.state.scheduled).not.toBeNull();
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
    const archiveRead = f.repository.outcomePage(null, 16);
    release.resolve();
    expect((await commit).value.result.disposition).toBe("committed");
    expect((await archiveRead).outcomes).toHaveLength(2);
    f.queries.length = 0;
    await new NativeLedger(f.repository, () => alarm.arm()).execute(posting("warm", 2n));
    expect(f.queries).toHaveLength(7);
    expect(a.state).toMatchObject({ gets: 1, sets: 1 });
  } finally {
    f.db.close();
  }
});

test("failed scheduling blocks new commits and rejections, but retained retries stay available", async () => {
  const f = book();
  try {
    await new NativeLedger(f.repository).provision(genesis(), activation());
    const original = await new NativeLedger(f.repository).execute(posting("original"));
    const ledger = new NativeLedger(f.repository, async () => {
      throw new Error("alarm failure");
    });
    const retry = await ledger.execute(posting("original"));
    expect(retry.value.result.disposition).toBe("replayed");
    expect(retry.value.originalResult).toEqual(original.value.originalResult);
    expect((await ledger.provision(genesis(), activation())).outcomeSequence).toBe("1");
    await expect(ledger.execute(posting("new", 2n))).rejects.toThrow("alarm failure");
    await expect(ledger.execute(posting("new-rejection", 0n))).rejects.toThrow("alarm failure");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
    expect(
      (await new NativeLedger(f.repository).execute(posting("new", 2n))).value.result.disposition,
    ).toBe("committed");
  } finally {
    f.db.close();
  }
});

test("a fence change while arming prevents publication and failed genesis arming leaves no ledger", async () => {
  const f = book();
  try {
    await expect(
      new NativeLedger(f.repository, async () => {
        throw new Error("alarm failure");
      }).provision(genesis(), activation()),
    ).rejects.toThrow("alarm failure");
    expect(
      f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_native_%'").all(),
    ).toHaveLength(0);
    await new NativeLedger(f.repository).provision(genesis(), activation());
    await expect(
      new NativeLedger(f.repository, async () => {
        f.authority.fence = "1";
      }).execute(posting("fenced")),
    ).rejects.toThrow("native_ledger_fence_changed");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
  } finally {
    f.db.close();
  }
});

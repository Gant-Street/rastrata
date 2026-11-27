import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../../src/local.ts";
import { BankfeedScheduler } from "../../src/local/bankfeed-scheduler.ts";
import { configureBankfeedRuntime } from "../../src/slices/bankfeed/runtime.ts";
import {
  type Attempt,
  MAX_ATTEMPTS_PER_DAY,
  RETRY_AFTER_MS,
  isDue,
  localMidnight,
  minutesOf,
  runScheduledSync,
} from "../../src/slices/bankfeed/schedule.ts";
import { bankfeedStore } from "../../src/slices/bankfeed/store.ts";
import { HOUR, type World, advance, closeWorlds, linkByCode, uuid, world } from "./support.ts";

// The daily sync is a matter of the owner's local day, so these tests pin the zone they run in (bun test
// uses UTC unless told otherwise; a developer's own TZ must not change what they prove) and the one test
// that cares about a real zone says so.
const ZONE = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  process.env.TZ = ZONE ?? "UTC";
});
function inZone<T>(zone: string, body: () => T): T {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    process.env.TZ = was ?? "UTC";
  }
}

const folders: string[] = [];
afterEach(() => {
  closeWorlds();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// ---- when a sync is due (pure) -------------------------------------------------------------------------

/** A time on the owner's clock, in October 2026. */
const at = (hours: number, minutes = 0, day = 4) => new Date(2026, 9, day, hours, minutes);
const attempt = (
  when: Date,
  disposition: Attempt["disposition"] = "complete",
  errorCode: string | null = null,
): Attempt => ({ startedAt: when.toISOString(), disposition, errorCode });
const due = (
  now: Date,
  today: Attempt[] = [],
  over: { enabled?: boolean; dailyAt?: string } = {},
) => isDue({ enabled: over.enabled ?? true, dailyAt: over.dailyAt ?? "06:17", now, today });

test("a sync is never due until the owner turns it on, and never before the chosen time of day", () => {
  expect(due(at(7), [], { enabled: false })).toBe(false);
  expect(due(at(6, 16))).toBe(false);
  expect(due(at(6, 17))).toBe(true);
  expect(due(at(23, 59))).toBe(true);
  expect(due(at(0, 5))).toBe(false);
  expect(due(at(7), [], { dailyAt: "nonsense" })).toBe(false);
});

test("one attempt a day is enough, unless it failed in a way that may clear and two hours have passed", () => {
  const first = at(6, 20);
  expect(due(at(6, 30), [attempt(first)])).toBe(false);
  expect(due(at(20), [attempt(first)])).toBe(false);
  // Paused (the day's budget is spent) is the day's attempt: asking again would only spend what is left.
  expect(due(at(20), [attempt(first, "paused")])).toBe(false);
  // A temporary failure is retried once, two hours later.
  for (const code of ["bankfeed_unavailable", "bankfeed_interrupted", "bankfeed_sync_failed"]) {
    const failed = [attempt(first, "failed", code)];
    expect(due(new Date(first.getTime() + RETRY_AFTER_MS - 1), failed), code).toBe(false);
    expect(due(new Date(first.getTime() + RETRY_AFTER_MS), failed), code).toBe(true);
  }
  // A refusal needs the owner and is never tried again by itself.
  for (const code of [
    "bankfeed_access_denied",
    "bankfeed_payment_required",
    "bankfeed_not_connected",
    null,
  ])
    expect(due(at(23), [attempt(first, "failed", code)]), String(code)).toBe(false);
  // And never more than the day's attempts.
  expect(MAX_ATTEMPTS_PER_DAY).toBe(2);
  const failedTwice = [
    attempt(first, "failed", "bankfeed_unavailable"),
    attempt(at(9), "failed", "bankfeed_unavailable"),
  ];
  expect(due(at(23), failedTwice)).toBe(false);
});

test("the time is read as HH:MM, and the day is the owner's local day", () => {
  expect(minutesOf("00:00")).toBe(0);
  expect(minutesOf("06:17")).toBe(377);
  expect(minutesOf("23:59")).toBe(1439);
  for (const bad of ["24:00", "6:17", "06:60", "06:7", "", "06-17", "06:17:00", " 06:17"])
    expect(minutesOf(bad), bad).toBeNull();
  expect(localMidnight(at(15, 40, 9)).toISOString()).toBe(new Date(2026, 9, 9).toISOString());
  // 03:00 UTC on the 5th is still the evening of the 4th in Los Angeles (UTC-7 in October).
  inZone("America/Los_Angeles", () => {
    const evening = new Date(Date.UTC(2026, 9, 5, 3, 0));
    expect(evening.getHours()).toBe(20);
    expect(localMidnight(evening).toISOString()).toBe("2026-10-04T07:00:00.000Z");
  });
});

// ---- the sync it runs --------------------------------------------------------------------------------------

/** A connected book with the checking account linked and the daily sync on. The world's clock is
 * 2026-10-04 13:00 UTC; `dailyAt` is local (UTC here), by default 14:17, so the first look is at 14:20. */
async function scheduledWorld(dailyAt = "14:17"): Promise<World> {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await w.ok("bankfeed.settings", { dailySync: true, dailyAt });
  return w;
}

/** Put the world's clock (and the Bridge's) at this time. Time only goes forward. */
function setClock(w: World, when: Date): Date {
  expect(when.getTime()).toBeGreaterThanOrEqual(w.clock.ms);
  advance(w, when.getTime() - w.clock.ms);
  return when;
}

interface RunView {
  id: string;
  trigger: string;
  disposition: string;
  newLines: number;
  errorCode: string | null;
}
const runs = async (w: World): Promise<RunView[]> =>
  (await w.ok("bankfeed.status", {})).history as RunView[];

async function until(check: () => Promise<boolean>, limitMs = 5_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the scheduler");
    await Bun.sleep(10);
  }
}

test("a connection starts with the daily sync off, and nothing is asked of the Bridge until it is on", async () => {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  expect((await w.ok("bankfeed.status", {})).settings).toEqual({
    dailySync: false,
    dailyAt: "06:17",
  });
  const before = w.bridge.log.length;
  const now = setClock(w, at(14, 20));
  expect(await runScheduledSync(w.service, now)).toEqual({ ran: false, reason: "off" });
  expect(w.bridge.log).toHaveLength(before);
  // The time is a local time of day, and the setting refuses anything else.
  const bad = await w.call("bankfeed.settings", { dailyAt: "25:00" }, uuid());
  expect(bad.status).toBe(400);
  expect((await w.ok("bankfeed.status", {})).settings.dailyAt).toBe("06:17");
});

test("when it is due it syncs once as a scheduled run, queues the lines for review and posts nothing", async () => {
  const w = await scheduledWorld();
  expect(await runScheduledSync(w.service, setClock(w, at(14, 10)))).toEqual({
    ran: false,
    reason: "not_due",
  });
  expect(w.bridge.requests("accounts")).toHaveLength(1);
  expect(await runScheduledSync(w.service, setClock(w, at(14, 20)))).toEqual({
    ran: true,
    disposition: "complete",
    newLines: 5,
  });
  expect((await runs(w))[0]).toMatchObject({
    trigger: "scheduled",
    disposition: "complete",
    newLines: 5,
  });
  // The lines wait in the Inbox like any sync's, and nothing is posted.
  expect((await w.ok("inbox.summary", {})).counts).toMatchObject({ toReview: 5, posted: 0 });
  expect((await w.ok("journal.list", { page: 1 })).count).toBe(0);
  // Not again that day, however late it is.
  const asked = w.bridge.log.length;
  expect(await runScheduledSync(w.service, setClock(w, at(14, 30)))).toEqual({
    ran: false,
    reason: "not_due",
  });
  expect(await runScheduledSync(w.service, setClock(w, at(23, 59)))).toEqual({
    ran: false,
    reason: "not_due",
  });
  expect(w.bridge.log).toHaveLength(asked);
  // The next day it is due again, and finds nothing new.
  expect(await runScheduledSync(w.service, setClock(w, at(14, 18, 5)))).toEqual({
    ran: true,
    disposition: "complete",
    newLines: 0,
  });
  expect((await runs(w)).filter((run) => run.trigger === "scheduled")).toHaveLength(2);
});

test("a manual sync does not use up the day's scheduled one", async () => {
  const w = await scheduledWorld();
  setClock(w, at(14, 5));
  expect((await w.call("bankfeed.sync", {}, uuid())).status).toBe(200);
  expect((await runs(w))[0]?.trigger).toBe("manual");
  expect(await runScheduledSync(w.service, setClock(w, at(14, 20)))).toMatchObject({
    ran: true,
    disposition: "complete",
    newLines: 0,
  });
});

test("a failure that may clear is tried once more, two hours later, and then left alone", async () => {
  const w = await scheduledWorld();
  const first = setClock(w, at(14, 20));
  // The Bridge cannot be reached: the first request and the one retry both fail.
  w.bridge.failOnce();
  w.bridge.failOnce();
  expect(await runScheduledSync(w.service, first)).toEqual({
    ran: true,
    disposition: "failed",
    newLines: 0,
  });
  expect((await runs(w))[0]).toMatchObject({
    trigger: "scheduled",
    disposition: "failed",
    errorCode: "bankfeed_unavailable",
  });
  // An hour on: too soon.
  const asked = w.bridge.log.length;
  expect(await runScheduledSync(w.service, setClock(w, at(15, 20)))).toEqual({
    ran: false,
    reason: "not_due",
  });
  expect(w.bridge.log).toHaveLength(asked);
  // Two hours on it tries again, and this time the Bridge answers.
  const second = setClock(w, new Date(first.getTime() + RETRY_AFTER_MS));
  expect(await runScheduledSync(w.service, second)).toEqual({
    ran: true,
    disposition: "complete",
    newLines: 5,
  });
  // Two attempts is the day's limit, whatever the second one did.
  expect(await runScheduledSync(w.service, setClock(w, at(23, 30)))).toEqual({
    ran: false,
    reason: "not_due",
  });
});

test("when the second attempt fails too it waits for the next day", async () => {
  const w = await scheduledWorld();
  const first = setClock(w, at(14, 20));
  for (const when of [first, new Date(first.getTime() + RETRY_AFTER_MS)]) {
    w.bridge.failOnce();
    w.bridge.failOnce();
    expect(await runScheduledSync(w.service, setClock(w, when))).toMatchObject({
      ran: true,
      disposition: "failed",
    });
  }
  const asked = w.bridge.log.length;
  expect(await runScheduledSync(w.service, setClock(w, at(23, 59)))).toEqual({
    ran: false,
    reason: "not_due",
  });
  expect(w.bridge.log).toHaveLength(asked);
  expect((await runScheduledSync(w.service, setClock(w, at(14, 18, 5)))).ran).toBe(true);
});

test("a refused access is not tried again by itself, and the owner is told", async () => {
  const w = await scheduledWorld();
  w.bridge.respondOnce(403, {
    errlist: [{ code: "gen.auth", msg: "Forbidden" }],
    accounts: [],
    connections: [],
  });
  expect(await runScheduledSync(w.service, setClock(w, at(14, 20)))).toMatchObject({
    ran: true,
    disposition: "failed",
  });
  expect((await runs(w))[0]).toMatchObject({ errorCode: "bankfeed_access_denied" });
  const status = await w.ok("bankfeed.status", {});
  expect(status.attention.map((item: { code: string }) => item.code)).toContain("access_denied");
  const asked = w.bridge.log.length;
  expect(await runScheduledSync(w.service, setClock(w, at(22, 0)))).toEqual({
    ran: false,
    reason: "not_due",
  });
  expect(w.bridge.log).toHaveLength(asked);
});

test("it is quiet when nothing is connected or nothing is linked, and asks the Bridge nothing", async () => {
  const none = await world();
  await none.ok("bankfeed.settings", { dailySync: true });
  expect(await runScheduledSync(none.service, setClock(none, at(14, 20)))).toEqual({
    ran: false,
    reason: "nothing_to_do",
  });
  expect(none.bridge.log).toHaveLength(0);

  const unlinked = await world({ connected: true });
  await unlinked.ok("bankfeed.settings", { dailySync: true });
  const asked = unlinked.bridge.log.length;
  expect(await runScheduledSync(unlinked.service, setClock(unlinked, at(14, 20)))).toEqual({
    ran: false,
    reason: "nothing_to_do",
  });
  expect(unlinked.bridge.log).toHaveLength(asked);
});

test("while the Bridge has asked Rastrata to slow down the scheduler leaves it alone, then carries on", async () => {
  const w = await scheduledWorld();
  w.bridge.respondOnce(429, "slow down");
  setClock(w, at(14, 0));
  const manual = (await w.call("bankfeed.sync", {}, uuid())).body.data;
  expect(manual.paused).toMatchObject({ reason: "rate_limited" });
  const asked = w.bridge.log.length;
  expect(await runScheduledSync(w.service, setClock(w, at(15, 0)))).toEqual({
    ran: false,
    reason: "paused",
  });
  expect(await runScheduledSync(w.service, setClock(w, at(23, 0)))).toEqual({
    ran: false,
    reason: "paused",
  });
  expect(w.bridge.log).toHaveLength(asked);
  // A day and a bit later the pause is over.
  expect(await runScheduledSync(w.service, setClock(w, at(14, 30, 5)))).toMatchObject({
    ran: true,
    disposition: "complete",
  });
});

test("a sync already running is not collided with, and does not use up the day's attempt", async () => {
  const w = await scheduledWorld();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  configureBankfeedRuntime(w.service, {
    fetch: async (input, init) => {
      arrive();
      await gate;
      return w.bridge.fetch(input, init);
    },
  });
  setClock(w, at(14, 5));
  const manual = w.call("bankfeed.sync", {}, uuid());
  await arrived;
  expect(await runScheduledSync(w.service, setClock(w, at(14, 20)))).toEqual({
    ran: false,
    reason: "busy",
  });
  release();
  expect((await manual).status).toBe(200);
  // The attempt was not used: with the manual sync done it can run.
  expect(await runScheduledSync(w.service, setClock(w, at(14, 40)))).toMatchObject({
    ran: true,
    disposition: "complete",
  });
});

test("the day's request budget is honoured: a scheduled sync that finds it spent pauses, says so, and asks nothing", async () => {
  const w = await scheduledWorld();
  // Spend the budget with listings half an hour apart, as the limits test does.
  for (let round = 0; round < 40; round++) {
    advance(w, 31 * 60_000);
    if ((await w.call("bankfeed.accounts", {}, uuid())).status === 429) break;
  }
  const asked = w.bridge.log.length;
  const now = setClock(w, new Date(w.clock.ms + 31 * 60_000));
  expect(await runScheduledSync(w.service, now)).toEqual({
    ran: true,
    disposition: "paused",
    newLines: 0,
  });
  expect(w.bridge.log).toHaveLength(asked);
  expect((await runs(w))[0]).toMatchObject({
    trigger: "scheduled",
    disposition: "paused",
    errorCode: null,
  });
  // That was the day's attempt: asking again would only spend what is left.
  expect(
    await runScheduledSync(w.service, setClock(w, new Date(w.clock.ms + 31 * 60_000))),
  ).toEqual({ ran: false, reason: "not_due" });
  expect(w.bridge.log).toHaveLength(asked);
});

test("the day is the owner's local day, not the UTC day", async () => {
  await inZoneAsync("America/Los_Angeles", async () => {
    // The world's clock is 06:00 in Los Angeles; the owner asked for 06:17 local.
    const w = await scheduledWorld("06:17");
    const utc = (day: number, hours: number, minutes = 0) =>
      new Date(Date.UTC(2026, 9, day, hours, minutes));
    expect(await runScheduledSync(w.service, setClock(w, utc(4, 13, 10)))).toEqual({
      ran: false,
      reason: "not_due",
    });
    expect((await runScheduledSync(w.service, setClock(w, utc(4, 13, 30)))).ran).toBe(true);
    // 03:00 UTC on the 5th is 20:00 on the 4th in Los Angeles: the same day, so not due.
    expect(await runScheduledSync(w.service, setClock(w, utc(5, 3)))).toEqual({
      ran: false,
      reason: "not_due",
    });
    // 13:30 UTC on the 5th is 06:30 on the 5th there: a new day.
    expect((await runScheduledSync(w.service, setClock(w, utc(5, 13, 30)))).ran).toBe(true);
  });
});

async function inZoneAsync<T>(zone: string, body: () => Promise<T>): Promise<T> {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await body();
  } finally {
    process.env.TZ = was ?? "UTC";
  }
}

// ---- the timer -------------------------------------------------------------------------------------------------

test("the timer finds the sync due on its own, runs it once, and says it is running until it stops", async () => {
  const w = await scheduledWorld("13:30");
  setClock(w, at(14, 0));
  expect((await w.ok("bankfeed.status", {})).scheduler).toBe(false);
  const scheduler = new BankfeedScheduler(w.service, {
    tickMs: 10,
    startupDelayMs: 5,
    now: () => new Date(w.clock.ms),
  });
  scheduler.start();
  scheduler.start();
  try {
    expect((await w.ok("bankfeed.status", {})).scheduler).toBe(true);
    await until(async () => (await runs(w)).some((run) => run.disposition === "complete"));
    // It looks again and again, and the day's sync has been done.
    await Bun.sleep(100);
    const scheduled = (await runs(w)).filter((run) => run.trigger === "scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ disposition: "complete", newLines: 5 });
  } finally {
    scheduler.stop();
  }
  expect((await w.ok("bankfeed.status", {})).scheduler).toBe(false);
  // After it stops, nothing runs, even when asked.
  advance(w, 24 * HOUR);
  expect(await scheduler.run()).toBeNull();
  await Bun.sleep(50);
  expect((await runs(w)).filter((run) => run.trigger === "scheduled")).toHaveLength(1);
});

test("an error in the timer's own pass never escapes it", async () => {
  const w = await scheduledWorld();
  const scheduler = new BankfeedScheduler(w.service, {
    tickMs: 1_000_000,
    startupDelayMs: 1_000_000,
    now: () => {
      throw new Error("the clock broke");
    },
  });
  scheduler.start();
  try {
    expect(await scheduler.run()).toBeNull();
  } finally {
    scheduler.stop();
  }
});

test("a sync left running by a process that stopped is closed as interrupted when the timer starts", async () => {
  const w = await scheduledWorld();
  bankfeedStore(w.service).startRun("stale-run", "2026-10-04T05:00:00.000Z", "scheduled");
  expect((await runs(w)).find((run) => run.id === "stale-run")?.disposition).toBe("running");
  const scheduler = new BankfeedScheduler(w.service, {
    tickMs: 1_000_000,
    startupDelayMs: 1_000_000,
  });
  scheduler.start();
  scheduler.stop();
  expect((await runs(w)).find((run) => run.id === "stale-run")).toMatchObject({
    disposition: "failed",
    errorCode: "bankfeed_interrupted",
  });
});

test("on a book that is not set up yet the timer starts, does nothing and does not fail", async () => {
  const folder = mkdtempSync(join(tmpdir(), "rastrata-bankfeed-schedule-"));
  folders.push(folder);
  const service = await LocalBookService.open(join(folder, "book.sqlite"));
  const scheduler = new BankfeedScheduler(service, {
    tickMs: 1_000_000,
    startupDelayMs: 1_000_000,
  });
  try {
    scheduler.start();
    expect(await scheduler.run()).toEqual({ ran: false, reason: "off" });
  } finally {
    scheduler.stop();
    service.close();
  }
});

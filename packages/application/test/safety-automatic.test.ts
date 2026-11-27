import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBackupScheduler } from "../src/local.ts";
import { configureSafety } from "../src/safety/jobs.ts";
import { isoWeek, planRetention } from "../src/safety/retention.ts";
import {
  DEFAULT_BACKUP_SETTINGS,
  type BackupReason,
  type BackupSettings,
  type StoredBackup,
} from "../src/safety/types.ts";
import { cleanupSafetyFixtures, safetyFixture } from "./support/safety.ts";

afterEach(cleanupSafetyFixtures);

const HOUR = 3_600_000;
const T0 = Date.parse("2026-03-02T09:00:00.000Z");
const clock = (state: { at: number }) => () => new Date(state.at);

function fake(
  id: string,
  createdAt: string,
  reason: BackupReason,
  passed: boolean | null = null,
): StoredBackup {
  return {
    manifest: {
      format: "rastrata-backup-v1",
      id,
      createdAt,
      reason,
      file: { name: `${id}.sqlite`, bytes: 1, sha256: "0".repeat(64) },
      ledger: {
        formatId: "x",
        head: { sequence: "1", bookRevision: "1", chainHash: "0".repeat(64) },
        genesisSha256: "0".repeat(64),
      },
      application: { release: "0.1.0", stores: {} },
      book: { name: "B", currency: "USD" },
      manifestSha256: "0".repeat(64),
    },
    fileState: "present",
    verification:
      passed === null
        ? null
        : {
            backupId: id,
            verifiedAt: createdAt,
            passed,
            durationMs: 1,
            replayMs: 1,
            outcomes: 1,
            journals: 0,
            head: null,
            checks: [],
          },
  };
}
const day = (n: number, hour = 9) => new Date(Date.UTC(2026, 0, n, hour)).toISOString();
const id = (n: number, hour = 9) =>
  `${day(n, hour)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-00000001-00000000`;

test("retention keeps the newest of each recent day, week and month, and never removes manual, newest or newest-verified backups", () => {
  const settings: BackupSettings = {
    ...DEFAULT_BACKUP_SETTINGS,
    keepDaily: 3,
    keepWeekly: 2,
    keepMonthly: 2,
  };
  // Forty days of daily automatic backups, two on the 20th, plus manual ones.
  const backups: StoredBackup[] = [];
  for (let n = 1; n <= 40; n++) backups.push(fake(id(n), day(n), "scheduled"));
  backups.push(fake(id(20, 18), day(20, 18), "shutdown"));
  backups.push(fake(id(5, 12), day(5, 12), "manual"));
  const plan = planRetention(backups, settings);
  const kept = new Set(plan.keep.keys());
  // The three newest days.
  for (const n of [40, 39, 38]) expect(kept.has(id(n))).toBe(true);
  // Manual backups are never removed, and automatic ones outside every bucket are.
  expect(kept.has(id(5, 12))).toBe(true);
  expect(plan.remove).not.toContain(id(5, 12));
  expect(plan.remove).toContain(id(7));
  expect(plan.remove).not.toContain(id(40));
  // Of two on one day, the newer is the one a bucket keeps.
  expect(plan.remove).toContain(id(20));
  expect(plan.remove.every((removed) => !plan.keep.has(removed))).toBe(true);
  // Oldest first.
  expect([...plan.remove]).toEqual([...plan.remove].sort());
});

test("retention never removes the only verified backup, even when settings would", () => {
  const backups = [
    fake(id(30), day(30), "scheduled", false),
    fake(id(29), day(29), "scheduled", false),
    fake(id(1), day(1), "scheduled", true),
  ];
  const plan = planRetention(backups, {
    ...DEFAULT_BACKUP_SETTINGS,
    keepDaily: 1,
    keepWeekly: 0,
    keepMonthly: 0,
  });
  expect(plan.keep.get(id(1))).toContain("newest-verified");
  expect(plan.keep.get(id(30))).toContain("newest");
  expect(plan.remove).toEqual([id(29)]);
});

test("ISO weeks follow the ISO 8601 rules across year ends", () => {
  expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  expect(isoWeek(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  expect(isoWeek(new Date("2021-01-03T00:00:00Z"))).toBe("2020-W53");
});

test("the automatic cycle backs up, verifies, then leaves an unchanged book alone", async () => {
  const f = await safetyFixture();
  const time = { at: T0 };
  configureSafety(f.service, { now: clock(time), waitMs: 60_000 });
  await f.post(3);
  const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  if (!scheduler) throw new Error("no scheduler");

  const first = await scheduler.run("interval");
  expect(first?.action).toBe("backup");
  expect(first?.reused).toBe(false);
  expect(first?.verificationPassed).toBe(true);
  let status = (await f.call("backup.status")).body.data;
  expect(status.backupCount).toBe(1);
  expect(status.latest.reason).toBe("scheduled");
  expect(status.latestVerified.id).toBe(status.latest.id);
  expect(status.automatic).toMatchObject({ enabled: true, scheduler: "active", lastRunOk: true });
  expect(status.warnings.map((w: { code: string }) => w.code)).not.toContain("never_verified");

  // An hour later nothing is due.
  time.at = T0 + HOUR;
  expect((await scheduler.run("interval"))?.action).toBe("none");

  // A day later with nothing changed: the snapshot is byte-identical, so no second file is kept.
  time.at = T0 + 25 * HOUR;
  const idle = await scheduler.run("interval");
  expect(idle?.createdId).toBe(status.latest.id);
  expect(idle?.reused).toBe(true);
  expect((await f.call("backup.list")).body.data.backups.length).toBe(1);
  // ...and the verification is repeated, because it is older than the interval.
  expect(idle?.verifiedId).toBe(status.latest.id);
  status = (await f.call("backup.status")).body.data;
  expect(status.latestVerified.verification.verifiedAt).toBe(
    new Date(T0 + 25 * HOUR).toISOString(),
  );

  // Two days on, after real changes, a new backup is made.
  await f.post(2, "N");
  time.at = T0 + 50 * HOUR;
  const changed = await scheduler.run("interval");
  expect(changed?.reused).toBe(false);
  expect(changed?.createdId).not.toBe(status.latest.id);
  expect((await f.call("backup.list")).body.data.backups.length).toBe(2);
  await scheduler.stop({ shutdownBackup: false });
});

test("retention runs after a good cycle and removes only automatic backups the settings no longer keep", async () => {
  const f = await safetyFixture();
  const time = { at: T0 };
  configureSafety(f.service, { now: clock(time), waitMs: 60_000 });
  const manual = (await f.finish("backup.create")).backup;
  const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  if (!scheduler) throw new Error("no scheduler");
  const settings = {
    ...DEFAULT_BACKUP_SETTINGS,
    verifyAfterBackup: false,
    keepDaily: 2,
    keepWeekly: 0,
    keepMonthly: 0,
  };
  const configured = await f.call("backup.configure", settings, crypto.randomUUID());
  expect(configured.status).toBe(200);
  const made: string[] = [];
  for (let n = 1; n <= 5; n++) {
    time.at = T0 + n * 25 * HOUR;
    await f.post(1, `D${n}`);
    const report = await scheduler.run("interval");
    expect(report?.action).toBe("backup");
    if (report?.createdId) made.push(report.createdId);
  }
  const listed = (await f.call("backup.list")).body.data.backups.map((b: { id: string }) => b.id);
  // The manual backup and the two newest days remain; the three older automatic ones were removed.
  expect(listed).toContain(manual.id);
  expect(listed).toContain(made[4] as string);
  expect(listed).toContain(made[3] as string);
  for (const old of made.slice(0, 3)) expect(listed).not.toContain(old);
  expect(listed.length).toBe(3);
  // A removed backup leaves nothing behind in the folder.
  expect(readdirSync(f.backups).filter((name) => name.includes(made[0] as string))).toEqual([]);
  await scheduler.stop({ shutdownBackup: false });
});

test("a shutdown backup is taken only if something changed, and a restart does not repeat it", async () => {
  const f = await safetyFixture();
  const time = { at: T0 };
  configureSafety(f.service, { now: clock(time), waitMs: 60_000 });
  await f.post(2);
  const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  if (!scheduler) throw new Error("no scheduler");
  const stopped = await scheduler.stop({ shutdownBackup: true });
  expect(stopped?.action).toBe("backup");
  const [one] = (await f.call("backup.list")).body.data.backups;
  expect(one.reason).toBe("shutdown");
  // Start again, nothing changed, stop again: identical bytes, so nothing new.
  const again = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  const second = await again?.stop({ shutdownBackup: true });
  expect(second?.reused).toBe(true);
  expect((await f.call("backup.list")).body.data.backups.length).toBe(1);
  // Switched off in the settings, shutdown makes none.
  await f.call(
    "backup.configure",
    { ...DEFAULT_BACKUP_SETTINGS, onShutdown: false },
    crypto.randomUUID(),
  );
  await f.post(1, "Z");
  const third = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  expect((await third?.stop({ shutdownBackup: true }))?.action).toBe("disabled");
  expect((await f.call("backup.list")).body.data.backups.length).toBe(1);
});

test("a failed automatic backup is visible on the status, with the reason, even when the folder cannot be written", async () => {
  if (process.getuid?.() === 0) return;
  const f = await safetyFixture();
  const time = { at: T0 };
  configureSafety(f.service, { now: clock(time), waitMs: 60_000 });
  mkdirSync(f.backups, { recursive: true });
  chmodSync(f.backups, 0o500);
  try {
    const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
    const report = await scheduler?.run("interval");
    expect(report?.action).toBe("failed");
    const status = (await f.call("backup.status")).body.data;
    expect(status.automatic.lastRunOk).toBe(false);
    expect(status.automatic.lastError.length).toBeGreaterThan(5);
    const failed = status.warnings.find((w: { code: string }) => w.code === "automatic_failed");
    expect(failed.tone).toBe("error");
    expect(failed.message).toContain("did not finish");
    expect(status.warnings[0].tone).toBe("error");
    await scheduler?.stop({ shutdownBackup: false });
  } finally {
    chmodSync(f.backups, 0o700);
  }
  // Fixed, the next pass succeeds and the failure clears.
  const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  time.at = T0 + HOUR;
  expect((await scheduler?.run("interval"))?.action).toBe("backup");
  const after = (await f.call("backup.status")).body.data;
  expect(after.automatic.lastRunOk).toBe(true);
  await scheduler?.stop({ shutdownBackup: false });
});

test("the cycle yields to a job a person started and tries again later", async () => {
  const f = await safetyFixture();
  await f.post(30);
  await f.finish("backup.create");
  const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  configureSafety(f.service, { waitMs: 0 });
  const first = await f.call("backup.verify", {}, crypto.randomUUID());
  expect(first.body.data.state).toBe("running");
  const during = await scheduler?.run("interval");
  expect(during === null || during?.action === "busy" || during?.action === "none").toBe(true);
  await scheduler?.stop({ shutdownBackup: false });
});

test("start-up removes what a crashed job left behind and nothing else", async () => {
  const f = await safetyFixture();
  const record = (await f.finish("backup.create")).backup;
  mkdirSync(join(f.backups, ".scratch", "abc"), { recursive: true });
  writeFileSync(join(f.backups, ".scratch", "abc", "book.sqlite"), "x");
  writeFileSync(join(f.backups, ".snapshot-123.partial"), "x");
  writeFileSync(join(f.backups, `${record.id}.manifest.json.partial-ab12`), "x");
  expect(readdirSync(f.backups).length).toBeGreaterThan(3);
  const scheduler = await startBackupScheduler(f.service, { tickMs: 1e9, startupDelayMs: 1e9 });
  expect(readdirSync(f.backups).sort()).toEqual([
    `${record.id}.manifest.json`,
    `${record.id}.sqlite`,
  ]);
  expect(existsSync(join(f.backups, ".scratch"))).toBe(false);
  await scheduler?.stop({ shutdownBackup: false });
});

test("settings are validated, retained, owner-only and survive a restart; unreadable settings fall back to safe defaults", async () => {
  const f = await safetyFixture();
  const defaults = (await f.call("backup.status")).body.data.settings;
  expect(defaults).toEqual(DEFAULT_BACKUP_SETTINGS);
  const bad = await f.call(
    "backup.configure",
    { ...DEFAULT_BACKUP_SETTINGS, intervalHours: 48, warnAfterHours: 24 },
    crypto.randomUUID(),
  );
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe("invalid_input");
  const outOfRange = await f.call(
    "backup.configure",
    { ...DEFAULT_BACKUP_SETTINGS, keepDaily: 0 },
    crypto.randomUUID(),
  );
  expect(outOfRange.status).toBe(400);
  const denied = await f.call("backup.configure", DEFAULT_BACKUP_SETTINGS, crypto.randomUUID(), [
    "read",
    "draft",
    "post",
    "configure",
    "correct",
    "close",
  ]);
  expect(denied.status).toBe(403);
  const id = crypto.randomUUID();
  const custom = { ...DEFAULT_BACKUP_SETTINGS, intervalHours: 12, keepDaily: 14, enabled: false };
  const saved = await f.call("backup.configure", custom, id);
  expect(saved.body.data).toEqual(custom);
  expect((await f.call("backup.configure", custom, id)).body.data).toEqual(custom);
  await f.restart();
  expect((await f.call("backup.status")).body.data.settings).toEqual(custom);
  expect(
    (await f.call("backup.status")).body.data.warnings.map((w: { code: string }) => w.code),
  ).toContain("automatic_off");
  f.service.store.query("UPDATE safety_settings SET body='not json' WHERE id=1").run();
  expect((await f.call("backup.status")).body.data.settings).toEqual(DEFAULT_BACKUP_SETTINGS);
});

test("the status says what is wrong in order of seriousness and what to do", async () => {
  const f = await safetyFixture();
  const none = (await f.call("backup.status")).body.data;
  expect(none.backupCount).toBe(0);
  expect(none.warnings.map((w: { code: string }) => w.code).slice(0, 2)).toEqual([
    "never_backed_up",
    "scheduler_not_running",
  ]);
  expect(none.warnings[0].tone).toBe("error");
  expect(none.latest).toBeNull();
  await f.finish("backup.create");
  const unverified = (await f.call("backup.status")).body.data;
  const codes = unverified.warnings.map((w: { code: string }) => w.code);
  expect(codes).toContain("never_verified");
  expect(codes).toContain("drill_never");
  expect(codes).not.toContain("never_backed_up");
  expect(unverified.changesSinceLatest).toBe(0);
  await f.post(2);
  expect((await f.call("backup.status")).body.data.changesSinceLatest).toBe(2);
  // Stale: verified long ago.
  const time = { at: Date.now() };
  configureSafety(f.service, { now: clock(time) });
  await f.finish("backup.verify");
  time.at += 49 * HOUR;
  const stale = (await f.call("backup.status")).body.data.warnings.find(
    (w: { code: string }) => w.code === "stale_verification",
  );
  expect(stale.tone).toBe("review");
  expect(stale.message).toContain("48 hours");
});

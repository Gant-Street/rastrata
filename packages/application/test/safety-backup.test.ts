import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackupFolder } from "../src/local/backup-folder.ts";
import { hashFile } from "../src/local/files.ts";
import { LocalBookService } from "../src/local.ts";
import { restoreBackup } from "../src/local/restore.ts";
import { sealBackupManifest } from "../src/safety/manifest.ts";
import { postBulk } from "./support/bulk-book.ts";
import { cleanupSafetyFixtures, safetyFixture } from "./support/safety.ts";

afterEach(cleanupSafetyFixtures);

const listing = (backups: string) => readdirSync(backups).sort();

test("a backup is a complete, self-describing copy of the whole database with a manifest beside it", async () => {
  const f = await safetyFixture();
  await f.post(3);
  const job = (await f.call("backup.create", {}, crypto.randomUUID())).body.data;
  expect(job.state).toBe("done");
  const record = job.backup;
  expect(record.reason).toBe("manual");
  expect(record.fileState).toBe("present");
  expect(record.head.sequence).toBe("4");
  expect(record.bookName).toBe("Safety Co");
  expect(record.sha256).toBe(hashFile(join(f.backups, record.fileName)).sha256);
  expect(record.bytes).toBe(statSync(join(f.backups, record.fileName)).size);
  // The folder is private and holds exactly the backup and its manifest.
  expect(statSync(f.backups).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.backups, record.fileName)).mode & 0o777).toBe(0o600);
  expect(listing(f.backups)).toEqual([`${record.id}.manifest.json`, `${record.id}.sqlite`]);
  const list = (await f.call("backup.list")).body.data;
  expect(list.backups.map((b: { id: string }) => b.id)).toEqual([record.id]);
  expect(list.unrecorded).toEqual([]);
  // The snapshot contains the ledger and the product state: open it as a book.
  const copy = join(f.directory, "opened.sqlite");
  writeFileSync(copy, readFileSync(join(f.backups, record.fileName)));
  const opened = await LocalBookService.open(copy, { safety: false });
  expect((await opened.readAggregate()).aggregate.state.journals.length).toBe(3);
  expect(opened.setupState()?.name).toBe("Safety Co");
  opened.close();
});

test("verify replays the whole ledger on a copy, records the result next to the backup and never touches the file", async () => {
  const f = await safetyFixture();
  await f.post(4);
  const created = (await f.finish("backup.create")).backup;
  const before = hashFile(join(f.backups, created.fileName)).sha256;
  const verified = (await f.finish("backup.verify")).verification;
  expect(verified.passed).toBe(true);
  expect(verified.checks.map((c: { code: string }) => c.code)).toEqual([
    "file_present",
    "file_sha256",
    "integrity",
    "ledger_stored",
    "ledger_replay",
    "ledger_head",
  ]);
  expect(verified.checks.every((c: { status: string }) => c.status === "passed")).toBe(true);
  expect(verified.outcomes).toBe(5);
  expect(verified.journals).toBe(4);
  expect(verified.head).toEqual(created.head);
  expect(verified.replayMs).toBeGreaterThanOrEqual(0);
  // Read-only: the backup bytes are exactly what they were, and the scratch copy is gone.
  expect(hashFile(join(f.backups, created.fileName)).sha256).toBe(before);
  expect(
    existsSync(join(f.backups, ".scratch")) ? readdirSync(join(f.backups, ".scratch")) : [],
  ).toEqual([]);
  // The result lives beside the backup, so it survives restarting the service.
  const status = (await f.call("backup.status")).body.data;
  expect(status.latestVerified.id).toBe(created.id);
  expect(status.warnings.map((w: { code: string }) => w.code)).not.toContain("never_verified");
  await f.restart();
  const again = (await f.call("backup.list")).body.data.backups[0];
  expect(again.verification.passed).toBe(true);
});

test("a flipped byte anywhere in a backup is detected, and the costly replay is skipped", async () => {
  const f = await safetyFixture();
  await f.post(3);
  const record = (await f.finish("backup.create")).backup;
  const path = join(f.backups, record.fileName);
  const original = readFileSync(path);
  const spots = [
    0,
    60,
    100,
    Math.floor(original.length / 3),
    Math.floor(original.length / 2),
    original.length - 1,
  ];
  for (const spot of spots) {
    const damaged = Buffer.from(original);
    damaged[spot] = (damaged[spot] ?? 0) ^ 0x01;
    writeFileSync(path, damaged);
    const result = (await f.finish("backup.verify", { backupId: record.id })).verification;
    expect(result.passed, `byte ${spot}`).toBe(false);
    const hashCheck = result.checks.find((c) => c.code === "file_sha256");
    expect(hashCheck?.status).toBe("failed");
    expect(hashCheck?.message).toContain("altered or damaged");
    expect(result.checks.find((c) => c.code === "ledger_replay")?.status).toBe("skipped");
  }
  writeFileSync(path, original);
  expect((await f.finish("backup.verify", { backupId: record.id })).verification.passed).toBe(true);
  // A failed newest backup is the first thing the status says.
  const flipped = Buffer.from(original);
  flipped[Math.floor(flipped.length / 2)] = (flipped[Math.floor(flipped.length / 2)] ?? 0) ^ 0xff;
  writeFileSync(path, flipped);
  await f.finish("backup.verify", { backupId: record.id });
  const status = (await f.call("backup.status")).body.data;
  expect(status.warnings[0].code).toBe("verification_failed");
  expect(status.warnings[0].tone).toBe("error");
});

test("a backup whose manifest was rewritten to match damaged ledger contents still fails, at the replay", async () => {
  const f = await safetyFixture();
  await f.post(3);
  const record = (await f.finish("backup.create")).backup;
  const path = join(f.backups, record.fileName);
  const db = new Database(path);
  // The body is compressed and encoded in base64, so which character stands at position 61 differs from run
  // to run: replace it with one that is different (writing 'Z' over a 'Z' damaged nothing, once in 64 runs).
  db.exec(
    "UPDATE ledger_native_outcomes SET body = substr(body, 1, 60) || CASE WHEN substr(body, 61, 1) = 'Z' THEN 'Y' ELSE 'Z' END || substr(body, 62) WHERE sequence = 3",
  );
  db.close();
  const file = hashFile(path);
  const folder = new BackupFolder(f.backups);
  const stored = (await folder.list()).backups[0];
  if (!stored) throw new Error("backup missing");
  const forged = await sealBackupManifest({
    id: stored.manifest.id,
    createdAt: stored.manifest.createdAt,
    reason: stored.manifest.reason,
    file: { name: stored.manifest.file.name, bytes: file.bytes, sha256: file.sha256 },
    ledger: stored.manifest.ledger,
    application: stored.manifest.application,
    book: stored.manifest.book,
  });
  folder.writeManifest(forged);
  const result = (await f.finish("backup.verify")).verification;
  expect(result.passed).toBe(false);
  const by = (code: string) => result.checks.find((c) => c.code === code);
  expect(by("file_sha256")?.status).toBe("passed");
  expect(by("integrity")?.status).toBe("passed");
  expect(by("ledger_replay")?.status).toBe("failed");
  expect(by("ledger_replay")?.message).toContain("altered or damaged");
});

test("a tampered manifest is not trusted: it is listed as unrecorded, never as a backup", async () => {
  const f = await safetyFixture();
  const record = (await f.finish("backup.create")).backup;
  const manifestPath = join(f.backups, `${record.id}.manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.book.name = "Another Business";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const list = (await f.call("backup.list")).body.data;
  expect(list.backups).toEqual([]);
  expect(list.unrecorded).toContain(`${record.id}.manifest.json`);
  expect(list.unrecorded).toContain(`${record.id}.sqlite`);
  expect((await f.call("backup.status")).body.data.warnings[0].code).toBe("never_backed_up");
});

test("restore installs the verified backup byte for byte and the restored book has the same head", async () => {
  const f = await safetyFixture();
  await f.post(5);
  const record = (await f.finish("backup.create")).backup;
  const live = await f.service.readAggregate();
  const target = join(f.directory, "restored", "book.sqlite");
  const stages: string[] = [];
  const result = await restoreBackup({
    backup: record.id,
    to: target,
    backupDirectory: f.backups,
    progress: (update) => {
      if (update.stage) stages.push(update.stage);
    },
  });
  expect(result.head).toEqual(record.head);
  expect(result.sha256).toBe(record.sha256);
  expect(result.replayed).toBe(true);
  expect(result.safetyCopy).toBeNull();
  expect(result.checks.every((c) => c.status === "passed")).toBe(true);
  expect(stages).toContain("Replaying the ledger");
  expect(hashFile(target).sha256).toBe(record.sha256);
  const restored = await LocalBookService.open(target, { safety: false });
  const read = await restored.readAggregate();
  expect(read.head).toEqual(live.head);
  expect(read.aggregate.state.journals.length).toBe(5);
  restored.close();
});

test("restore refuses an existing database unless asked, keeps a safety copy, and never touches a database that is open", async () => {
  const f = await safetyFixture();
  await f.post(2);
  const record = (await f.finish("backup.create")).backup;
  const target = join(f.directory, "target.sqlite");
  await restoreBackup({ backup: record.id, to: target, backupDirectory: f.backups, quick: true });
  await expect(
    restoreBackup({ backup: record.id, to: target, backupDirectory: f.backups, quick: true }),
  ).rejects.toMatchObject({ code: "restore_target_exists" });
  expect(hashFile(target).sha256).toBe(record.sha256);
  // The target in use by a running service is refused outright.
  const inUse = await LocalBookService.open(target, { safety: false });
  await expect(
    restoreBackup({
      backup: record.id,
      to: target,
      replace: true,
      backupDirectory: f.backups,
      quick: true,
    }),
  ).rejects.toMatchObject({ code: "restore_target_in_use" });
  inUse.close();
  // Closed, it can be replaced, and what was there is kept.
  const second = await restoreBackup({
    backup: record.id,
    to: target,
    replace: true,
    backupDirectory: f.backups,
    quick: true,
  });
  expect(second.safetyCopy).not.toBeNull();
  expect(existsSync(join(second.safetyCopy as string, "target.sqlite"))).toBe(true);
  expect(hashFile(target).sha256).toBe(record.sha256);
  // It never restores onto the backup file itself.
  await expect(
    restoreBackup({
      backup: join(f.backups, record.fileName),
      to: join(f.backups, record.fileName),
      replace: true,
      quick: true,
    }),
  ).rejects.toMatchObject({ code: "restore_target_is_backup" });
});

test("restore refuses a damaged backup and installs nothing", async () => {
  const f = await safetyFixture();
  await f.post(2);
  const record = (await f.finish("backup.create")).backup;
  const path = join(f.backups, record.fileName);
  const damaged = Buffer.from(readFileSync(path));
  damaged[damaged.length - 5] = (damaged[damaged.length - 5] ?? 0) ^ 0xff;
  writeFileSync(path, damaged);
  const target = join(f.directory, "never.sqlite");
  await expect(
    restoreBackup({ backup: record.id, to: target, backupDirectory: f.backups }),
  ).rejects.toMatchObject({ code: "restore_verification_failed" });
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(f.directory).filter((name) => name.includes("restor"))).toEqual([]);
});

test("a backup with no manifest cannot be restored unless the person says they know it is good", async () => {
  const f = await safetyFixture();
  const record = (await f.finish("backup.create")).backup;
  const bare = join(f.directory, "bare.sqlite");
  writeFileSync(bare, readFileSync(join(f.backups, record.fileName)));
  await expect(
    restoreBackup({ backup: bare, to: join(f.directory, "a.sqlite") }),
  ).rejects.toMatchObject({
    code: "restore_manifest_missing",
  });
  const result = await restoreBackup({
    backup: bare,
    to: join(f.directory, "b.sqlite"),
    allowNoManifest: true,
  });
  expect(result.backupId).toBeNull();
  expect(result.checks.find((c) => c.code === "file_sha256")?.status).toBe("skipped");
  expect(result.checks.find((c) => c.code === "ledger_replay")?.status).toBe("passed");
});

test("the restore drill restores the newest backup to a temporary directory, replays it and matches the live book", async () => {
  const f = await safetyFixture();
  await f.post(4);
  await f.finish("backup.create");
  await f.post(2, "L");
  const drill = (await f.finish("backup.drill")).drill;
  expect(drill.passed).toBe(true);
  expect(drill.checks.map((c: { code: string }) => c.code)).toEqual([
    "file_present",
    "file_sha256",
    "integrity",
    "ledger_stored",
    "restore_copy",
    "ledger_replay",
    "ledger_head",
    "kernel_chain",
    "trial_balance",
  ]);
  expect(drill.changesSince).toBe(2);
  expect(drill.restoredHead?.sequence).toBe("5");
  expect(drill.liveHead.sequence).toBe("7");
  // The restored copy had 4 journals when the backup was taken: its balances equal the live book's
  // at that revision, even though the live book has moved on.
  expect(drill.accountsCompared).toBe(4);
  expect(drill.mismatches).toEqual([]);
  expect(drill.replayMs).toBeGreaterThanOrEqual(0);
  const status = (await f.call("backup.status")).body.data;
  expect(status.lastDrill.passed).toBe(true);
  expect(status.warnings.map((w: { code: string }) => w.code)).not.toContain("drill_never");
  // The live book is exactly as it was and the scratch directory is gone.
  expect((await f.service.readAggregate()).aggregate.state.journals.length).toBe(6);
  expect(
    existsSync(join(f.backups, ".scratch")) ? readdirSync(join(f.backups, ".scratch")) : [],
  ).toEqual([]);
  // The result is recorded in product state: it is still there after a restart.
  await f.restart();
  expect((await f.call("backup.status")).body.data.lastDrill.passed).toBe(true);
});

test("the drill fails when the backup is not an earlier state of this book", async () => {
  const a = await safetyFixture();
  const b = await safetyFixture();
  await a.post(3, "A");
  await b.post(3, "B");
  const foreign = (await b.finish("backup.create")).backup;
  // Put the other book's backup into this book's backup folder.
  const into = new BackupFolder(a.backups);
  into.ensure();
  for (const name of [`${foreign.id}.sqlite`, `${foreign.id}.manifest.json`])
    writeFileSync(join(a.backups, name), readFileSync(join(b.backups, name)));
  const drill = (await a.finish("backup.drill", { backupId: foreign.id })).drill;
  expect(drill.passed).toBe(false);
  const chain = drill.checks.find((c) => c.code === "kernel_chain");
  expect(chain?.status).toBe("failed");
  expect(chain?.message).toContain("not an earlier state of this book");
  expect(
    (await a.call("backup.status")).body.data.warnings.map((w: { code: string }) => w.code),
  ).toContain("drill_failed");
});

test("a backup taken while the book is being written is consistent, and the writer is never blocked", async () => {
  const f = await safetyFixture();
  await f.post(3);
  const posting = f.post(25, "W");
  const created = await f.finish("backup.create");
  await posting;
  const record = created.backup;
  expect(Number(record.head.sequence)).toBeGreaterThanOrEqual(4);
  expect(Number(record.head.sequence)).toBeLessThanOrEqual(29);
  // Whatever head it caught, it is a whole, replayable state of the book.
  const verified = (await f.finish("backup.verify", { backupId: record.id })).verification;
  expect(verified.passed).toBe(true);
  expect(verified.head).toEqual(record.head);
  // Every journal posted while the snapshot ran was posted.
  expect((await f.service.readAggregate()).aggregate.state.journals.length).toBe(28);
});

test("a long job answers 'running' with its progress, attaches to the same job on a retry and never starts two", async () => {
  const f = await safetyFixture();
  await f.post(40);
  await f.finish("backup.create");
  const { configureSafety } = await import("../src/safety/jobs.ts");
  configureSafety(f.service, { waitMs: 0 });
  const id = crypto.randomUUID();
  const first = await f.call("backup.verify", {}, id);
  expect(first.body.data.state).toBe("running");
  expect(first.body.data.kind).toBe("verify");
  expect(first.body.data.stage.length).toBeGreaterThan(0);
  const status = (await f.call("backup.status")).body.data;
  expect(status.activeJob.kind).toBe("verify");
  // Another job while one is running is refused, never queued behind it silently.
  const other = await f.call("backup.create", {}, crypto.randomUUID());
  expect(other.status).toBe(409);
  expect(other.body.error.code).toBe("backup_busy");
  expect(other.body.error.retryable).toBe(true);
  // Asking again with the same identity attaches to the running job.
  let job = (await f.call("backup.verify", {}, id)).body.data;
  for (let attempt = 0; attempt < 400 && job.state === "running"; attempt++) {
    await Bun.sleep(50);
    job = (await f.call("backup.verify", {}, id)).body.data;
  }
  expect(job.state).toBe("done");
  expect(job.verification.passed).toBe(true);
  // The finished answer is retained: the same identity gives the same answer again, and operations.get sees it.
  expect((await f.call("backup.verify", {}, id)).body.data.verification.verifiedAt).toBe(
    job.verification.verifiedAt,
  );
  const got = (await f.call("operations.get", { operationId: id })).body.data;
  expect(got.disposition).toBe("completed");
  // Same identity, different input: refused.
  const reused = await f.call(
    "backup.verify",
    { backupId: "20260101T000000Z-00000001-00000000" },
    id,
  );
  expect(reused.body.error.code).toBe("operation_identity_conflict");
});

test("a verification of a book with no backup says so, and a full disk stops a backup with the reason", async () => {
  const f = await safetyFixture({ open: { safety: { freeBytes: () => 1000 } } });
  const none = await f.call("backup.verify", {}, crypto.randomUUID());
  expect(none.body.data.state).toBe("failed");
  expect(none.body.data.error.code).toBe("backup_not_found");
  const full = (await f.call("backup.create", {}, crypto.randomUUID())).body.data;
  expect(full.state).toBe("failed");
  expect(full.error.code).toBe("backup_no_space");
  expect(full.error.message).toContain("not enough free space");
  expect(existsSync(f.backups) ? readdirSync(f.backups) : []).toEqual([]);
});

test("a book that has grown replays and restores correctly (300 journals)", async () => {
  const f = await safetyFixture();
  await postBulk(f.service, 300);
  const created = (await f.finish("backup.create")).backup;
  expect(created.head.sequence).toBe("301");
  const verified = (await f.finish("backup.verify")).verification;
  expect(verified.passed).toBe(true);
  expect(verified.journals).toBe(300);
  expect(verified.outcomes).toBe(301);
  expect(verified.replayMs).toBeGreaterThan(0);
  const restored = await restoreBackup({
    backup: created.id,
    to: join(f.directory, "big.sqlite"),
    backupDirectory: f.backups,
  });
  expect(restored.head).toEqual(created.head);
  expect(restored.firstStart.snapshot).not.toBe("");
}, 120_000);

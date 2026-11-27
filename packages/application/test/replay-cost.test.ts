import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeDurableBook, encodeDurableBook } from "@rastrata/kernel";
import {
  importOpenExport,
  LocalBookService,
  readBookCommitment,
  restoreBackup,
} from "../src/local.ts";
import { verifyBackupFile } from "../src/local/verify.ts";
import {
  CHAIN_HEAD_SECONDS_PER_ENTRY,
  commitmentOf,
  commitmentOfGenesis,
  fromStartSeconds,
  LEGACY_SECONDS_AT_A_THOUSAND,
  type ReplayGrowth,
  replayGrowthOf,
  restartSeconds,
  SLOW_RESTART_SECONDS,
  snapshotLoadSeconds,
} from "../src/replay-cost.ts";
import type { ProgressUpdate } from "../src/safety/types.ts";
import { BULK_BOOK } from "./support/bulk-book.ts";
import { setupLegacyBook, withoutTheProfile } from "./support/legacy-book.ts";
import { BOOK, cleanupSafetyFixtures, safetyFixture } from "./support/safety.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanupSafetyFixtures();
  for (const work of cleanup.splice(0).reverse()) work();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "rastrata-replay-cost-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

type Kind = "chain-head" | "legacy";

async function open(path: string, kind: Kind) {
  const service = await LocalBookService.open(path, { safety: false });
  cleanup.push(() => service.close());
  if (kind === "legacy") await setupLegacyBook(service);
  else await service.setup(BULK_BOOK);
  return service;
}

// ---- the model ----------------------------------------------------------------------------------

test("the kind of a book is read from the marker on its configuration, for a state and for a starting record", async () => {
  const modern = await open(join(directory(), "modern.sqlite"), "chain-head");
  const older = await open(join(directory(), "older.sqlite"), "legacy");
  const newer = (await modern.readAggregate()).aggregate;
  const earlier = (await older.readAggregate()).aggregate;
  expect(commitmentOf(newer.state)).toBe("chain-head");
  expect(commitmentOf(earlier.state)).toBe("legacy");
  // The starting record each ledger keeps, which is what a replay begins from.
  expect(commitmentOfGenesis((await modern.outcomePage()).genesis)).toBe("chain-head");
  expect(commitmentOfGenesis((await older.outcomePage()).genesis)).toBe("legacy");
  // The same book made without the marker is legacy, whatever else it holds.
  const genesis = decodeDurableBook((await modern.outcomePage()).genesis);
  if (genesis.disposition !== "decoded") throw new Error("The genesis did not decode");
  expect(commitmentOfGenesis(encodeDurableBook(genesis.aggregate))).toBe("chain-head");
  expect(commitmentOfGenesis(encodeDurableBook(withoutTheProfile(genesis.aggregate)))).toBe(
    "legacy",
  );
  // What is not a starting record has no kind.
  expect(commitmentOfGenesis("not a book")).toBeNull();
  expect(commitmentOfGenesis("")).toBeNull();
  // How each kind grows; a book whose kind is not known is treated as the slow kind.
  expect(replayGrowthOf("chain-head")).toBe("linear");
  expect(replayGrowthOf("legacy")).toBe("quadratic");
  expect(replayGrowthOf(null)).toBe("quadratic");
  expect(replayGrowthOf(undefined)).toBe("quadratic");
});

test("a chain-head book is estimated by the entry and a legacy one by the square, and the two are far apart", () => {
  const at = (journals: number) => ({ journals, entries: journals });
  // A millisecond an entry: 20,000 entries are 20 seconds, and a minute is 60,000.
  expect(fromStartSeconds("linear", at(20_000))).toBeCloseTo(20, 9);
  expect(fromStartSeconds("linear", at(60_000))).toBeCloseTo(SLOW_RESTART_SECONDS, 9);
  expect(CHAIN_HEAD_SECONDS_PER_ENTRY).toBe(0.001);
  // 22 seconds at a thousand journals, 88 at two thousand.
  expect(fromStartSeconds("quadratic", at(1000))).toBeCloseTo(LEGACY_SECONDS_AT_A_THOUSAND, 9);
  expect(fromStartSeconds("quadratic", at(2000))).toBeCloseTo(88, 9);
  // At 5,000 journals the older kind is nine minutes against five seconds: this is the false alarm
  // a chain-head book must never be given.
  expect(fromStartSeconds("quadratic", at(5000))).toBeGreaterThan(500);
  expect(fromStartSeconds("linear", at(5000))).toBeLessThan(6);
  // A start is never faster than a second, and entries that are not journals count for the replay.
  expect(fromStartSeconds("linear", at(10))).toBe(1);
  expect(fromStartSeconds("linear", { journals: 1000, entries: 4000 })).toBeCloseTo(4, 9);
  expect(fromStartSeconds("linear", { journals: 0, entries: 0 })).toBe(1);
});

test("a restart reads the saved snapshot and the entries since it, and never takes longer than the whole book", () => {
  const MiB = 1 << 20;
  const size = { journals: 5000, entries: 5001 };
  // Without a snapshot the whole book is read.
  expect(restartSeconds("linear", size, null)).toBeCloseTo(5.001, 9);
  // With the snapshot the last of 1,500 entries left (14 MiB, 0.45 s to read), the 3,501 since it.
  const stale = { bytes: 14 * MiB, sequence: 1500 };
  expect(restartSeconds("linear", size, stale)).toBeCloseTo(
    snapshotLoadSeconds(stale.bytes) + 3.501,
    9,
  );
  // A snapshot of the book as it is costs only its reading.
  const current = { bytes: 10 * MiB, sequence: 5001 };
  expect(restartSeconds("linear", size, current)).toBeCloseTo(
    snapshotLoadSeconds(current.bytes),
    9,
  );
  expect(snapshotLoadSeconds(10 * MiB)).toBeLessThan(0.5);
  // A snapshot that would cost more to read than the book does is not worth it: never above the start.
  expect(
    restartSeconds("linear", { journals: 20, entries: 21 }, { bytes: 100 * MiB, sequence: 21 }),
  ).toBe(1);
  expect(
    restartSeconds(
      "quadratic",
      { journals: 1600, entries: 2000 },
      { bytes: 8 * MiB, sequence: 1000 },
    ),
  ).toBeCloseTo(70.4, 9);
  // The older kind pays twice the average for an entry at the size the book has now.
  expect(
    restartSeconds(
      "quadratic",
      { journals: 1000, entries: 1100 },
      { bytes: 10 * MiB, sequence: 1000 },
    ),
  ).toBeCloseTo(snapshotLoadSeconds(10 * MiB) + 100 * 2 * (24.2 / 1100), 9);
});

interface Vector {
  readonly name: string;
  readonly growth: ReplayGrowth;
  readonly journals: number;
  readonly entries: number;
  readonly snapshot: { readonly bytes: number; readonly sequence: number } | null;
  readonly fromStartSeconds: number;
  readonly restartSeconds: number;
}

test("the shared vectors: the service and `rastrata doctor` hold the same rule of thumb", () => {
  const vectors = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "replay-estimate-vectors.json"), "utf8"),
  ) as { cases: Vector[] };
  expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
  for (const vector of vectors.cases) {
    const size = { journals: vector.journals, entries: vector.entries };
    expect(fromStartSeconds(vector.growth, size), vector.name).toBeCloseTo(
      vector.fromStartSeconds,
      6,
    );
    expect(restartSeconds(vector.growth, size, vector.snapshot), vector.name).toBeCloseTo(
      vector.restartSeconds,
      6,
    );
  }
  // Both kinds are in it, with and without a snapshot, so a change to one constant cannot slip by.
  expect(new Set(vectors.cases.map((vector) => vector.growth))).toEqual(
    new Set(["linear", "quadratic"]),
  );
  expect(vectors.cases.some((vector) => vector.snapshot === null)).toBe(true);
  expect(vectors.cases.some((vector) => vector.snapshot !== null)).toBe(true);
});

// ---- the kind of a book in a file --------------------------------------------------------------

test("the kind of the book in a database file is read without opening the service", async () => {
  const root = directory();
  const modern = await open(join(root, "modern.sqlite"), "chain-head");
  const older = await open(join(root, "older.sqlite"), "legacy");
  // The file of a service that has it open, as the warm-up and a backup check ask.
  expect(readBookCommitment(join(root, "modern.sqlite"))).toBe("chain-head");
  expect(readBookCommitment(join(root, "older.sqlite"))).toBe("legacy");
  modern.close();
  older.close();
  expect(readBookCommitment(join(root, "modern.sqlite"))).toBe("chain-head");
  // A file that is not there, one that is not a database, and a database with no ledger have no kind.
  expect(readBookCommitment(join(root, "missing.sqlite"))).toBeNull();
  writeFileSync(join(root, "notes.txt"), "not a database");
  expect(readBookCommitment(join(root, "notes.txt"))).toBeNull();
  const empty = await LocalBookService.open(join(root, "empty.sqlite"), { safety: false });
  empty.close();
  expect(readBookCommitment(join(root, "empty.sqlite"))).toBeNull();
});

// ---- the progress of a check, a restore and an import --------------------------------------------

/** The book of the safety tests, of the kind asked for, with a few journals and a backup of it. */
async function backedUp(kind: Kind) {
  const f = await safetyFixture({ setup: false });
  if (kind === "legacy") await setupLegacyBook(f.service, BOOK);
  else await f.service.setup(BOOK);
  await f.post(6);
  const backup = (await f.finish("backup.create")).backup;
  return { f, backup, file: join(f.backups, `${backup.id}.sqlite`) };
}

test("a backup check extrapolates a chain-head replay by the entry and a legacy one by the square", async () => {
  const modelOf = async (kind: Kind) => {
    const { f, file } = await backedUp(kind);
    const updates: ProgressUpdate[] = [];
    const outcome = await verifyBackupFile(
      { file, manifest: null, scratchDir: join(f.directory, "scratch") },
      (update) => updates.push(update),
    );
    expect(outcome.passed).toBe(true);
    const replaying = updates.findIndex((update) => update.stage === "Replaying the ledger");
    expect(replaying).toBeGreaterThanOrEqual(0);
    return updates[replaying]?.model;
  };
  expect(await modelOf("chain-head")).toBe("linear");
  expect(await modelOf("legacy")).toBe("quadratic");
});

test("an import rebuilds a book through the ledger's write path, which is linear for both kinds", async () => {
  for (const kind of ["chain-head", "legacy"] as const) {
    const { f } = await backedUp(kind);
    const exported = (await f.finish("export.create")).export;
    const updates: ProgressUpdate[] = [];
    const result = await importOpenExport({
      directory: exported.location,
      to: join(f.directory, `rebuilt-${kind}.sqlite`),
      progress: (update) => updates.push(update),
    });
    expect(result.outcomes).toBeGreaterThanOrEqual(7);
    expect(updates.find((update) => update.stage === "Rebuilding the ledger")?.model, kind).toBe(
      "linear",
    );
    // The rebuilt book is the same kind as the book it was exported from, and only its first read,
    // which is a replay, depends on that. The service opens a book before anything asks its kind.
    const rebuilt = join(f.directory, `rebuilt-${kind}.sqlite`);
    const reopened = await LocalBookService.open(rebuilt, { safety: false });
    expect(readBookCommitment(rebuilt)).toBe(kind);
    reopened.close();
  }
});

test("a restore says how long the first start takes in the words of the book's kind", async () => {
  const noteOf = async (kind: Kind) => {
    const { f, backup } = await backedUp(kind);
    const restored = await restoreBackup({
      backup: backup.id,
      to: join(f.directory, `restored-${kind}.sqlite`),
      backupDirectory: f.backups,
      quick: true,
    });
    return restored.firstStart;
  };
  const modern = await noteOf("chain-head");
  expect(modern.snapshot).toBe("none");
  expect(modern.estimateSeconds).toBe(1);
  expect(modern.note).toContain("about a second (about a second for every thousand entries;");
  expect(modern.note).not.toContain("square");
  const older = await noteOf("legacy");
  expect(older.snapshot).toBe("none");
  expect(older.note).toContain("it grows with the square of the book");
});

test("a restore of a backup whose snapshot is behind the book counts the entries since it", async () => {
  const f = await safetyFixture();
  // Twelve entries and a restart: the service saves a snapshot when it stops. Then three more.
  await f.post(12);
  await f.restart();
  await f.post(3);
  const backup = (await f.finish("backup.create")).backup;
  const restored = await restoreBackup({
    backup: backup.id,
    to: join(f.directory, "restored.sqlite"),
    backupDirectory: f.backups,
    quick: true,
  });
  expect(restored.firstStart.snapshot).toBe("behind");
  // The snapshot the service saved when it stopped, and how far the book is past it: a few entries.
  const db = new Database(join(f.directory, "restored.sqlite"), { readonly: true });
  const saved = db.query("SELECT sequence FROM app_read_snapshots WHERE id = 1").get() as {
    sequence: string;
  };
  db.close();
  const since = Number(restored.head.sequence) - Number(saved.sequence);
  expect(since).toBeGreaterThanOrEqual(3);
  expect(since).toBeLessThan(10);
  expect(restored.firstStart.note).toContain(`${since} entries were made after it was saved`);
  expect(restored.firstStart.estimateSeconds).toBe(1);
});

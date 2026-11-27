/** A service that replays its ledger carries the kernel's balances through the replay, so that the first
 * report of a book does not have the kernel go back over its whole history (a block of the event loop of
 * 700 to 900 ms at 20,000 journals), and the kernel's full rebuild is what a full verification runs and
 * compares them with. These tests hold that to account through the service: how many times the kernel's
 * rebuild runs, where the balances a report is checked against come from, and what happens when they are
 * wrong or cannot be carried. (The track itself, against the kernel's rebuild on random books, is
 * `projection-track.test.ts`.) */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExactRational, type BookState } from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import { verifyBackupFile } from "../src/local/verify.ts";
import { compileCoreReports } from "../src/reports.ts";
import { ledgerViewCounts } from "../src/reports/ledger.ts";
import {
  ProjectionTrack,
  projectionCounts,
  projectionDisagreement,
  vouchedProjection,
} from "../src/reports/ledger-projection.ts";
import { BULK_BOOK, postBulk, reverseBulk } from "./support/bulk-book.ts";

const ASOF = "2026-12-31";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

/** A book file with this many journals, some reversed, written by a service that is then closed. */
async function writtenBook(journals: number, reversed = 0, snapshots = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rastrata-replay-projection-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "book.sqlite");
  const writer = await LocalBookService.open(path, { snapshots });
  await writer.setup(BULK_BOOK);
  const ids = await postBulk(writer, journals);
  if (reversed > 0)
    await reverseBulk(writer, ids.filter((_, index) => index % 5 === 2).slice(0, reversed));
  // A service saves the state it last read when it closes, so this one reads the book first.
  if (snapshots) await writer.readAggregate();
  writer.close();
  return path;
}

/** A service on that file, which has read nothing: its first read replays the ledger from genesis. */
async function opened(path: string, snapshots = false): Promise<LocalBookService> {
  const service = await LocalBookService.open(path, { snapshots });
  cleanup.push(() => service.close());
  return service;
}

/** What the counters say changed while `work` ran. */
async function measured<T>(work: () => Promise<T>) {
  const views = ledgerViewCounts();
  const tracks = projectionCounts();
  const value = await work();
  const after = ledgerViewCounts();
  const tracked = projectionCounts();
  return {
    value,
    built: after.built - views.built,
    extended: after.extended - views.extended,
    rebuilt: tracked.rebuilt - tracks.rebuilt,
    vouched: after.projectionsVouched - views.projectionsVouched,
    folded: tracked.tracked - tracks.tracked,
  };
}

/** The reports of a state as a view with nothing carried to it says them (a copy of the state is another
 * state, so the kernel rebuilds its balances). */
const reportsFromNothing = (state: BookState) =>
  compileCoreReports({ ...state, identity: { ...state.identity } } as BookState, ASOF);

/** Make every track one cent out at each step it takes, as a bug in the carrying would. */
function aCentOutEverywhere<T>(work: () => Promise<T>): Promise<T> {
  const original = ProjectionTrack.prototype.advance;
  ProjectionTrack.prototype.advance = function (this: ProjectionTrack, revisions, checks) {
    const next = original.call(this, revisions, checks);
    if (next === null || next === this) return next;
    const balances = new Map(next.projection.balances);
    const [account, balance] = [...balances][0] ?? [];
    if (account !== undefined && balance !== undefined)
      balances.set(account, balance.add(ExactRational.of(1n, 100n)));
    return Object.assign(Object.create(ProjectionTrack.prototype), {
      projection: { ...next.projection, balances },
      journals: (next as unknown as { journals: unknown }).journals,
    }) as ProjectionTrack;
  };
  return work().finally(() => {
    ProjectionTrack.prototype.advance = original;
  });
}

/** Make every track end at its first step, as one does when a revision does not hold. */
function endingEverywhere<T>(work: () => Promise<T>): Promise<T> {
  const original = ProjectionTrack.prototype.advance;
  ProjectionTrack.prototype.advance = function (this: ProjectionTrack, revisions) {
    return revisions.length === 0 ? this : null;
  };
  return work().finally(() => {
    ProjectionTrack.prototype.advance = original;
  });
}

describe("a book replayed from genesis", () => {
  test("answers its first report without the kernel's rebuild, with the balances the replay carried", async () => {
    const path = await writtenBook(60, 8);
    const service = await opened(path);
    const first = await measured(() => service.reports(ASOF));
    expect(service.readStats.full).toBe(1);
    // One view, made from nothing, which took the balances the replay carried; the kernel was not asked.
    expect(first).toMatchObject({ built: 1, rebuilt: 0, vouched: 1 });
    const { aggregate } = await service.readAggregate();
    // Every revision of the book went through the track once.
    expect(first.folded).toBe(Number(aggregate.state.bookRevision));
    // And they are the balances the kernel gives, and the report says what a view with nothing carried says.
    const carried = vouchedProjection(aggregate.state);
    expect(carried).toBeDefined();
    expect(projectionDisagreement(aggregate.state, carried ?? null)).toBeNull();
    expect(first.value).toEqual(reportsFromNothing(aggregate.state));
  });

  test("answers the reports after more postings without it either, from the view before", async () => {
    const path = await writtenBook(40, 4);
    const service = await opened(path);
    await service.reports(ASOF);
    await postBulk(service, 3);
    const next = await measured(() => service.reports(ASOF));
    expect(next).toMatchObject({ built: 0, extended: 1, rebuilt: 0, vouched: 1 });
    // Three revisions were read from the ledger and folded in.
    expect(next.folded).toBe(3);
    const { aggregate } = await service.readAggregate();
    expect(next.value).toEqual(reportsFromNothing(aggregate.state));
    await postBulk(service, 1);
    expect(await measured(() => service.reports(ASOF))).toMatchObject({ rebuilt: 0, extended: 1 });
  });

  test("is read at an earlier revision with balances of its own, and the newest state keeps its balances", async () => {
    const path = await writtenBook(50, 5);
    const service = await opened(path);
    const tip = (await service.readAggregate()).aggregate.state.bookRevision;
    const past = await measured(() => service.reports(ASOF, tip - 20n));
    expect(past).toMatchObject({ rebuilt: 0, vouched: 1 });
    const now = await measured(() => service.reports(ASOF));
    expect(now).toMatchObject({ rebuilt: 0 });
    const { aggregate } = await service.readAggregate();
    expect(now.value).toEqual(reportsFromNothing(aggregate.state));
  });
});

describe("a book restored from a snapshot", () => {
  test("has its balances worked out from the snapshot's revisions and carried on", async () => {
    const path = await writtenBook(40, 3, true);
    const service = await opened(path, true);
    const first = await measured(() => service.reports(ASOF));
    expect(service.readStats.snapshot).toBe(1);
    expect(service.readStats.full).toBe(0);
    expect(first).toMatchObject({ built: 1, rebuilt: 0, vouched: 1 });
    const { aggregate } = await service.readAggregate();
    expect(first.value).toEqual(reportsFromNothing(aggregate.state));
    await postBulk(service, 2);
    expect(await measured(() => service.reports(ASOF))).toMatchObject({ rebuilt: 0, extended: 1 });
  });
});

describe("a full verification", () => {
  test("has the kernel rebuild the balances once and finds them the same, and the service goes on from it", async () => {
    const path = await writtenBook(45, 6);
    const service = await opened(path);
    await service.reports(ASOF);
    // An ordinary read does not run the kernel's rebuild.
    expect(await measured(() => service.readAggregate())).toMatchObject({ rebuilt: 0 });
    const full = await measured(() => service.readAggregate(undefined, { verify: "full" }));
    expect(full.rebuilt).toBe(1);
    // It replayed the whole chain again, with a track of its own.
    expect(full.folded).toBe(Number(full.value.aggregate.state.bookRevision));
    // The service continues from the state it verified, with its balances: a report of it takes them
    // from the track (a replay is a book of its own to the views) and the one after a posting extends it.
    expect(await measured(() => service.reports(ASOF))).toMatchObject({
      built: 1,
      rebuilt: 0,
      vouched: 1,
    });
    await postBulk(service, 1);
    expect(await measured(() => service.reports(ASOF))).toMatchObject({
      built: 0,
      extended: 1,
      rebuilt: 0,
    });
  });

  test("fails, naming the kernel's rebuild, when the balances carried through the replay are not the ones it gives", async () => {
    const path = await writtenBook(30, 3);
    await aCentOutEverywhere(async () => {
      const service = await opened(path);
      await expect(service.readAggregate(undefined, { verify: "full" })).rejects.toThrow(
        "Book balances do not match the kernel's rebuild: account",
      );
    });
  });
});

describe("a backup verification", () => {
  const verified = (path: string) =>
    verifyBackupFile({ file: path, manifest: null, scratchDir: join(dirname(path), "scratch") });

  test("replays the book on a working copy, has the kernel rebuild its balances once, and passes", async () => {
    const path = await writtenBook(25, 3);
    const before = projectionCounts().rebuilt;
    const outcome = await verified(path);
    expect(outcome.passed).toBe(true);
    expect(outcome.checks.find((check) => check.code === "ledger_replay")?.status).toBe("passed");
    expect(projectionCounts().rebuilt - before).toBe(1);
  });

  test("fails, in words, when the balances carried through the replay are not the kernel's", async () => {
    const path = await writtenBook(25, 3);
    const outcome = await aCentOutEverywhere(() => verified(path));
    expect(outcome.passed).toBe(false);
    const replay = outcome.checks.find((check) => check.code === "ledger_replay");
    expect(replay?.status).toBe("failed");
    expect(replay?.message).toContain(
      "The balances worked out while replaying differ from the kernel's own rebuild of the book",
    );
  });
});

describe("balances that are wrong, or cannot be carried", () => {
  test("are found by the report, which is checked against them", async () => {
    const path = await writtenBook(30, 3);
    await aCentOutEverywhere(async () => {
      const service = await opened(path);
      await expect(service.reports(ASOF)).rejects.toMatchObject({
        code: "report_integrity_failure",
      });
    });
  });

  test("are rebuilt by the kernel the first time a report needs them, when the replay could not carry them", async () => {
    const path = await writtenBook(30, 3);
    await endingEverywhere(async () => {
      const service = await opened(path);
      const first = await measured(() => service.reports(ASOF));
      // The old way: one rebuild by the kernel, then the view carries them forward.
      expect(first).toMatchObject({ built: 1, rebuilt: 1, vouched: 0 });
      const { aggregate } = await service.readAggregate();
      expect(first.value).toEqual(reportsFromNothing(aggregate.state));
      await postBulk(service, 2);
      expect(await measured(() => service.reports(ASOF))).toMatchObject({
        built: 0,
        extended: 1,
        rebuilt: 0,
      });
      // A full verification says so rather than pass over it.
      await expect(service.readAggregate(undefined, { verify: "full" })).rejects.toThrow(
        "were not carried through the replay",
      );
    });
  });
});

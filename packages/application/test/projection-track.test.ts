/** The kernel's balances, carried through a replay: a track folds a book's revisions into the balances the
 * kernel's own rebuild gives, one batch at a time, and a state it is carried to is checked by reports
 * against them. The kernel's full rebuild is the oracle here, on random books (backdated postings,
 * reversals, superseding corrections, closes, reopens, new accounts and calendar extensions) and on books
 * that branch. */
import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  latestRevisionRecord,
  type BookState,
  type RevisionRecord,
} from "@rastrata/kernel";
import { compileCoreReports, reportingWindow } from "../src/reports.ts";
import {
  ProjectionTrack,
  projectionCounts,
  projectionDisagreement,
  projectionFromHistory,
  vouchProjection,
  vouchedProjection,
  type BalanceProjection,
} from "../src/reports/ledger-projection.ts";
import { ledgerViewCounts } from "../src/reports/ledger.ts";
import { failure } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

/** The projection the kernel's own rebuild gives for these revisions. */
function rebuilt(revisions: readonly RevisionRecord[]): BalanceProjection {
  const projection = projectionFromHistory(revisions);
  if (projection === null) throw new Error("the kernel refused the history");
  return projection;
}

/** The track after all of these revisions (they must hold). */
function folded(revisions: readonly RevisionRecord[]): ProjectionTrack {
  const track = ProjectionTrack.start().advance(revisions);
  if (track === null) throw new Error("the track refused revisions that hold");
  return track;
}

/** The same place in the chain, the same accounts in the same order, the same balance on each. */
function expectSame(carried: BalanceProjection, kernel: BalanceProjection, label: string): void {
  expect(carried.revision, label).toBe(kernel.revision);
  expect(carried.postingSequence, label).toBe(kernel.postingSequence);
  expect(carried.chainHash, label).toEqual(kernel.chainHash);
  expect([...carried.balances.keys()], label).toEqual([...kernel.balances.keys()]);
  for (const [account, balance] of carried.balances) {
    const expected = kernel.balances.get(account) as ExactRational;
    expect(balance.numerator * expected.denominator, `${label} ${account}`).toBe(
      expected.numerator * balance.denominator,
    );
  }
}

/** A projection with one account's balance a cent out. */
function aCentOut(projection: BalanceProjection): BalanceProjection {
  const balances = new Map(projection.balances);
  const [account, balance] = [...balances][0] as [string, ExactRational];
  balances.set(account, balance.add(ExactRational.of(1n, 100n)));
  return { ...projection, balances };
}

const SEEDS = [71, 72, 73, 74];
const CHECKS = ["all", "applied"] as const;

describe("a track of the kernel's balances", () => {
  for (const seed of SEEDS)
    for (const checks of CHECKS)
      test(`folds a random book's revisions, in batches of every size, into what the kernel's rebuild says, seed ${seed}, checks "${checks}"`, () => {
        const book = playRandomBook({ seed, steps: 150 });
        const revisions = book.state.revisions;
        const sizes = [1, 3, 16, 7, 2];
        let track = ProjectionTrack.start();
        expectSame(track.projection, rebuilt([]), `seed ${seed} start`);
        const before = projectionCounts().tracked;
        let at = 0;
        for (let turn = 0; at < revisions.length; turn += 1) {
          const batch = revisions.slice(at, at + (sizes[turn % sizes.length] as number));
          const next = track.advance(batch, checks);
          expect(next, `seed ${seed} revisions ${at + 1} to ${at + batch.length}`).not.toBeNull();
          track = next as ProjectionTrack;
          at += batch.length;
          expectSame(track.projection, rebuilt(revisions.slice(0, at)), `seed ${seed} after ${at}`);
        }
        expect(projectionCounts().tracked - before).toBe(revisions.length);
        // The independent check agrees about the whole book.
        expect(projectionDisagreement(book.state, track.projection)).toBeNull();
      });

  test("is a value: advancing leaves the track as it was, and a failed advance leaves it usable", () => {
    const revisions = playRandomBook({ seed: 75, steps: 60 }).state.revisions;
    const base = folded(revisions.slice(0, 10));
    expectSame(base.projection, rebuilt(revisions.slice(0, 10)), "base");
    const ahead = base.advance(revisions.slice(10, 30)) as ProjectionTrack;
    expectSame(ahead.projection, rebuilt(revisions.slice(0, 30)), "ahead");
    expectSame(base.projection, rebuilt(revisions.slice(0, 10)), "base after advancing");
    // Nothing to fold is the same track.
    expect(base.advance([])).toBe(base);
    // A run that does not hold ends in null, and the track it was tried on goes on as before.
    const first = revisions[10] as RevisionRecord;
    const second = revisions[11] as RevisionRecord;
    for (const checks of CHECKS) {
      expect(base.advance([second], checks), checks).toBeNull();
      expect(base.advance([first, first], checks), checks).toBeNull();
      expect(
        base.advance([{ ...first, previousHash: second.chainHash }], checks),
        checks,
      ).toBeNull();
      expect(base.advance([{ ...first, bookRevision: 99n }], checks), checks).toBeNull();
    }
    // The hashes of a revision are worked out again for revisions nobody has checked ("all"), and not for
    // revisions a replay has just compared with the ledger's record ("applied"), which is the point of it.
    const wrongHashes = [
      { ...first, chainHash: second.chainHash },
      { ...first, effectsHash: second.effectsHash },
    ];
    for (const damaged of wrongHashes) {
      expect(base.advance([damaged])).toBeNull();
      expect(base.advance([damaged], "applied")).not.toBeNull();
    }
    const again = base.advance(revisions.slice(10, 30)) as ProjectionTrack;
    expectSame(again.projection, rebuilt(revisions.slice(0, 30)), "advanced again");
  });

  test("follows each of two books that branch from one point, with a reversal on each of a journal from before it", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    const ids = [1, 2, 3, 4].map((day) =>
      book.post(`2025-03-0${day}`, [
        ["1000", BigInt(day) * 100n],
        ["4000", -BigInt(day) * 100n],
      ]),
    );
    const other = book.fork();
    const fork = book.state.revisions.length;
    book.post("2025-03-10", [
      ["1000", 7n],
      ["4000", -7n],
    ]);
    book.reverse(ids[1] as string, "2025-03-11");
    other.reverse(ids[2] as string, "2025-03-12");
    other.post("2025-03-13", [
      ["6000", 9n],
      ["1000", -9n],
    ]);
    const base = folded(book.state.revisions.slice(0, fork));
    // Both branches are folded from the same track; each reversal finds its original.
    const left = base.advance(book.state.revisions.slice(fork)) as ProjectionTrack;
    const right = base.advance(other.state.revisions.slice(fork)) as ProjectionTrack;
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expectSame(left.projection, rebuilt(book.state.revisions), "left branch");
    expectSame(right.projection, rebuilt(other.state.revisions), "right branch");
    expect(left.projection.chainHash).not.toEqual(right.projection.chainHash);
  });
});

describe("the balances a replay vouches for a state", () => {
  test("are taken for that state and no other, and only when they stand at its place in the chain", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    const states: BookState[] = [];
    for (let day = 1; day <= 6; day += 1) {
      book.post(`2025-02-0${day}`, [
        ["1000", BigInt(day)],
        ["4000", -BigInt(day)],
      ]);
      states.push(book.state);
    }
    const all = (states[5] as BookState).revisions;
    // The revisions of the book, and of the book as it stood after each of its last three journals.
    const total = all.length;
    const [at4, at5, at6] = [total - 2, total - 1, total].map((count) =>
      folded(all.slice(0, count)),
    );
    const [, s5, s6] = [states[3], states[4], states[5]] as [BookState, BookState, BookState];
    const s4 = states[3] as BookState;
    expect(vouchedProjection(s5)).toBeUndefined();
    // One revision behind, one ahead, and the right one.
    expect(vouchProjection(s5, (at4 as ProjectionTrack).projection)).toBe(false);
    expect(vouchProjection(s5, (at6 as ProjectionTrack).projection)).toBe(false);
    expect(vouchedProjection(s5)).toBeUndefined();
    expect(vouchProjection(s5, (at5 as ProjectionTrack).projection)).toBe(true);
    expect(vouchedProjection(s5)).toBe((at5 as ProjectionTrack).projection);
    // Not the state before or after it, and not a copy of it (a spread copy is another state).
    expect(vouchedProjection(s4)).toBeUndefined();
    expect(vouchedProjection(s6)).toBeUndefined();
    expect(vouchedProjection({ ...s5 } as BookState)).toBeUndefined();
    // The same number of revisions on another history is not this state's.
    const stranger = new KernelBook({
      firstYear: 2025,
      years: 1,
      accounts: CHART,
      chainHead: true,
    });
    for (let day = 1; day <= 5; day += 1)
      stranger.post(`2025-02-1${day}`, [
        ["1000", BigInt(day) * 3n],
        ["4000", -BigInt(day) * 3n],
      ]);
    const foreign = folded(stranger.state.revisions);
    expect(foreign.projection.revision).toBe((at5 as ProjectionTrack).projection.revision);
    expect(vouchProjection(s5, foreign.projection)).toBe(false);
    expect(vouchedProjection(s5)).toBe((at5 as ProjectionTrack).projection);
  });

  test("are what the reports of every state of a random book are checked against, and the kernel is not asked", () => {
    for (const seed of [81, 82]) {
      let track = ProjectionTrack.start();
      const before = ledgerViewCounts();
      let compiled = 0;
      playRandomBook({
        seed,
        steps: 120,
        onState: ({ state }) => {
          track = track.advance(
            state.revisions.slice(Number(track.projection.revision)),
          ) as ProjectionTrack;
          expect(vouchProjection(state, track.projection), `seed ${seed}`).toBe(true);
          compileCoreReports(state, reportingWindow(state).lastDate);
          compiled += 1;
        },
      });
      const after = ledgerViewCounts();
      expect(compiled).toBe(120);
      // Not once did a view ask the kernel to rebuild, or carry the balances forward itself.
      expect(after.projectionsFromHistory - before.projectionsFromHistory).toBe(0);
      expect(after.projectionsExtended - before.projectionsExtended).toBe(0);
      expect(after.projectionsVouched - before.projectionsVouched).toBeGreaterThan(100);
    }
  });

  test("are compared with the report's totals: a cent out fails the report, as the kernel's would", () => {
    const post = (book: KernelBook) => {
      book.post("2025-02-01", [
        ["1000", 100n],
        ["4000", -100n],
      ]);
      book.post("2025-02-02", [
        ["1000", 7n],
        ["4000", -7n],
      ]);
      return book.state;
    };
    const wrong = post(new KernelBook({ firstYear: 2025, years: 1, accounts: CHART }));
    expect(vouchProjection(wrong, aCentOut(folded(wrong.revisions).projection))).toBe(true);
    const failed = failure(() => compileCoreReports(wrong, "2025-12-31"));
    expect(failed.code).toBe("report_integrity_failure");
    expect(failed.message).toContain("disagrees");
    // The same book with the right balances vouched reads, and the kernel is not asked.
    const right = post(new KernelBook({ firstYear: 2025, years: 1, accounts: CHART }));
    expect(vouchProjection(right, folded(right.revisions).projection)).toBe(true);
    const before = ledgerViewCounts();
    expect(compileCoreReports(right, "2025-12-31").trialBalance.rows.length).toBeGreaterThan(0);
    const after = ledgerViewCounts();
    expect(after.projectionsFromHistory - before.projectionsFromHistory).toBe(0);
    expect(after.projectionsVouched - before.projectionsVouched).toBe(1);
    // A state nobody vouched for (a copy of it) has the kernel rebuild the balances, as it did.
    const unvouched = { ...right, identity: { ...right.identity } } as BookState;
    const asked = ledgerViewCounts();
    compileCoreReports(unvouched, "2025-12-31");
    expect(ledgerViewCounts().projectionsFromHistory - asked.projectionsFromHistory).toBe(1);
  });
});

describe("the independent check of balances carried through a replay", () => {
  const subject = () => {
    const state = playRandomBook({ seed: 91, steps: 80 }).state;
    return { state, right: folded(state.revisions).projection };
  };

  test("finds nothing to say when the kernel's rebuild gives the same balances, and runs it once", () => {
    const { state, right } = subject();
    const before = projectionCounts().rebuilt;
    expect(projectionDisagreement(state, right)).toBeNull();
    expect(projectionCounts().rebuilt - before).toBe(1);
  });

  test("says what differs: nothing carried, another revision, a cent, an account more or fewer", () => {
    const { state, right } = subject();
    expect(projectionDisagreement(state, null)).toContain("not carried");
    const behind = folded(state.revisions.slice(0, -1)).projection;
    expect(projectionDisagreement(state, behind)).toContain("different revisions");
    expect(projectionDisagreement(state, aCentOut(right))).toContain("different balance");
    const fewer = new Map(right.balances);
    fewer.delete([...fewer.keys()][0] as string);
    expect(projectionDisagreement(state, { ...right, balances: fewer })).toContain("accounts");
    const more = new Map(right.balances).set("not-an-account", ExactRational.of(1n, 100n));
    expect(projectionDisagreement(state, { ...right, balances: more })).toContain("accounts");
    const elsewhere = new Map(right.balances);
    const [name, balance] = [...elsewhere][0] as [string, ExactRational];
    elsewhere.delete(name);
    elsewhere.set("not-an-account", balance);
    expect(projectionDisagreement(state, { ...right, balances: elsewhere })).toContain(
      "different balance",
    );
    const last = latestRevisionRecord(state) as RevisionRecord;
    expect(projectionDisagreement(state, { ...right, chainHash: last.previousHash })).toContain(
      "hashes",
    );
    expect(projectionDisagreement(state, { ...right, postingSequence: 0n })).toContain("journals");
  });
});

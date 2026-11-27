/** The recpack lane's first step: its riskiest assumption, tested before anything is built on it.
 *
 * The assumption: what a reconciliation left outstanding does not have to be stored. It can be worked out
 * later from records that never change: the lines the reconciliation froze, the reconciliations of the account
 * that were in force when it finished (each record keeps the one before it), and the books at the revision it
 * finished at. If that is wrong, a report on an old statement would drift as the books move on.
 *
 * The pass rule, from the charter: for every finished reconciliation of the acceptance book, the outstanding
 * list that is worked out equals what the draft left unselected when it was completed, including after a
 * posting dated inside the period is made later. A completed record has dropped its draft's working rows, so
 * each test takes them just before it completes.
 *
 * The book is the acceptance month's own (the changes lane's cut of it): the Willow Lane Studio chart, the
 * cutover and opening balances, and the Chase file's first two weeks of March, posted through For review.
 * Everything is reached through `ApplicationHttp`, as a client reaches it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cents, dec } from "../acceptance/month.ts";
import {
  type Finished,
  type Json,
  type MonthBook,
  lineFields,
  monthBook,
  postPayment,
  reconcileTo,
  reportOf,
} from "./support.ts";

let m: MonthBook;

beforeAll(async () => {
  m = await monthBook();
}, 120_000);
afterAll(() => m?.close());

/** Money in cents from a list of lines, summed by the test and not by the product. */
const total = (lines: readonly Json[]): bigint =>
  lines.reduce((sum, line) => sum + cents(line.amount), 0n);

/** What the pass rule says about one reconciliation: its report names exactly the lines the draft left
 * unselected and the lines it selected, in the same order, and the books less the outstanding lines are the
 * statement. */
function expectTheDraft(report: Json, done: Finished): void {
  expect(report.outstanding.lines).toEqual(done.unselected.map(lineFields));
  expect(report.cleared.lines).toEqual(done.selected.map(lineFields));
  expect(report.outstanding.count).toBe(done.unselected.length);
  expect(report.cleared.count).toBe(done.selected.length);
  expect(report.outstanding.total).toBe(dec(total(done.unselected)));
  expect(report.cleared.total).toBe(dec(total(done.selected)));
  // The books on the statement date, less what the statement does not show, is the statement.
  expect(cents(report.bookBalance) - cents(report.outstanding.total)).toBe(
    cents(report.statementBalance),
  );
  // The draft said what the books held when it was finished; the report says the same.
  expect(report.bookBalance).toBe(done.draft.bookBalance);
  expect(report).toMatchObject({
    id: done.record.id,
    status: "completed",
    void: null,
    difference: "0.00",
    statementDate: done.record.statementDate,
    statementBalance: done.record.statementBalance,
    openingBalance: done.record.openingBalance,
    recordHash: done.record.recordHash,
    previousHash: done.record.previousHash,
    completedAt: done.record.completedAt,
    bookRevision: done.record.snapshotRevision,
  });
  expect(report.file).toBeUndefined();
}

let first: Finished;
let second: Finished;
let firstReport: Json;
let secondReport: Json;

describe("the outstanding list of every finished reconciliation of the acceptance book", () => {
  test("a reconciliation that leaves a deposit and a payment off the statement lists exactly those", async () => {
    // The statement of 6 March does not show the Northwind deposit of the 5th or the Chipotle payment of the 6th yet.
    first = await reconcileTo(
      m.owner,
      "1000",
      "2026-03-06",
      (line) => line.narration.includes("NORTHWIND") || line.narration.includes("CHIPOTLE"),
    );
    expect(first.unselected.map((line) => line.amount).sort()).toEqual(["-18.45", "1200.00"]);
    expect(first.selected.length).toBeGreaterThan(5);
    firstReport = await reportOf(m.owner, first.record.id);
    expectTheDraft(firstReport, first);
    expect(firstReport.previous).toBeNull();
    expect(firstReport.openingBalance).toBe("0.00");
  });

  test("a posting dated inside the period, made later, is not in it, and the report does not move", async () => {
    m.advance();
    await postPayment(m.owner, {
      date: "2026-03-04",
      amount: "12.34",
      narration: "Late entry for the 4th",
    });
    const again = await reportOf(m.owner, first.record.id);
    // Not a single byte differs, though the books now hold a posting dated inside the period.
    expect(JSON.stringify(again)).toBe(JSON.stringify(firstReport));
    expect(again.outstanding.lines.map((line: Json) => line.narration)).not.toContain(
      "Late entry for the 4th",
    );
    // The posting is real: the next reconciliation of the account is offered it.
    const next = await m.owner.ok("reconcile.start", {
      accountId: "1000",
      statementDate: "2026-03-13",
      statementBalance: "0.00",
    });
    const offered = (next.lines as Json[]).map((line) => line.narration);
    expect(offered).toContain("Late entry for the 4th");
    // The two lines the first statement did not show are offered again, because nothing cleared them.
    expect(offered.filter((text) => /NORTHWIND|CHIPOTLE/.test(text))).toHaveLength(2);
    await m.owner.ok("reconcile.discard", { id: next.id, expectedVersion: next.version });
  });

  test("the next reconciliation continues from the first: what the first left off is cleared, what is still off is listed", async () => {
    m.advance();
    let starbucks = 0;
    // The statement of 13 March shows the deposit and the payment the first one did not; it does not show the late
    // entry or the second of the two coffees bought on the 10th for the same price.
    second = await reconcileTo(m.owner, "1000", "2026-03-13", (line) => {
      if (line.narration === "Late entry for the 4th") return true;
      if (line.narration.includes("STARBUCKS")) {
        starbucks += 1;
        return starbucks === 2;
      }
      return false;
    });
    expect(second.unselected.map((line) => line.amount).sort()).toEqual(["-12.34", "-4.85"]);
    expect(second.record.previous).toMatchObject({ id: first.record.id });
    secondReport = await reportOf(m.owner, second.record.id);
    expectTheDraft(secondReport, second);
    expect(secondReport.previous).toMatchObject({
      id: first.record.id,
      statementDate: "2026-03-06",
    });
    expect(secondReport.openingBalance).toBe(first.record.statementBalance);
    // The deposit and the payment the first statement left off are cleared by this one.
    const cleared = secondReport.cleared.lines.map((line: Json) => line.narration).join("|");
    expect(cleared).toContain("NORTHWIND");
    expect(cleared).toContain("CHIPOTLE");
    // The first report did not change because a second reconciliation cleared its outstanding lines.
    expect(JSON.stringify(await reportOf(m.owner, first.record.id))).toBe(
      JSON.stringify(firstReport),
    );
  });

  test("voiding the newest reconciliation reports it as voided and keeps its lines as they were", async () => {
    m.advance();
    await m.owner.ok("reconcile.void", { id: second.record.id, reason: "The wrong statement" });
    const voided = await reportOf(m.owner, second.record.id);
    expect(voided.status).toBe("voided");
    expect(voided.void).toMatchObject({ reason: "The wrong statement" });
    expect(voided.void.voidedAt).toMatch(/^2026-04-02T/);
    // Everything but the status and the void is what it was.
    const { status: _s, void: _v, ...kept } = voided;
    const { status: _s2, void: _v2, ...was } = secondReport;
    expect(kept).toEqual(was);
    expect(JSON.stringify(await reportOf(m.owner, first.record.id))).toBe(
      JSON.stringify(firstReport),
    );
  });

  test("voiding the earlier one afterwards changes neither report's lines: a void made later does not change what was true then", async () => {
    m.advance();
    await m.owner.ok("reconcile.void", { id: first.record.id, reason: "Both were wrong" });
    const early = await reportOf(m.owner, first.record.id);
    const later = await reportOf(m.owner, second.record.id);
    expect(early.status).toBe("voided");
    expect(later.status).toBe("voided");
    expect(early.outstanding.lines).toEqual(firstReport.outstanding.lines);
    expect(early.cleared.lines).toEqual(firstReport.cleared.lines);
    // The second one still counts the first one's lines as cleared before it, though the first is voided now.
    expect(later.outstanding.lines).toEqual(secondReport.outstanding.lines);
    expect(later.cleared.lines).toEqual(secondReport.cleared.lines);
    expect(later.openingBalance).toBe(secondReport.openingBalance);
    expect(later.bookBalance).toBe(secondReport.bookBalance);
  });

  test("a redone reconciliation is a new record with its own outstanding list, and the old ones stay as they were", async () => {
    m.advance();
    const redone = await reconcileTo(m.owner, "1000", "2026-03-10", (line) =>
      line.narration.includes("Late entry"),
    );
    expect(redone.record.previous ?? null).toBeNull();
    expect(redone.unselected.map((line) => line.narration)).toEqual(["Late entry for the 4th"]);
    const report = await reportOf(m.owner, redone.record.id);
    expectTheDraft(report, redone);
    expect(report.previous).toBeNull();
    // The voided ones did not take on the lines this one cleared.
    expect((await reportOf(m.owner, first.record.id)).outstanding.lines).toEqual(
      firstReport.outstanding.lines,
    );
    expect((await reportOf(m.owner, second.record.id)).outstanding.lines).toEqual(
      secondReport.outstanding.lines,
    );
  });

  test("a draft completed after the books moved lists what the draft had not seen as outstanding, because it was", async () => {
    // The screen holds Finish until the lines are refreshed; the service does not. A draft read at one
    // revision and completed at a later one is the one case where the worked-out list is longer than the
    // draft's unselected rows: by the postings that arrived in between, which the books held when it finished.
    m.advance();
    let draft = await m.owner.ok("reconcile.start", {
      accountId: "1000",
      statementDate: "2026-03-13",
      statementBalance: "0.00",
    });
    const lines = draft.lines as Json[];
    const keep = lines.filter((line) => !line.narration.includes("Late entry"));
    const balance =
      cents(draft.openingBalance) + keep.reduce((sum, line) => sum + cents(line.amount), 0n);
    draft = await m.owner.ok("reconcile.setStatement", {
      id: draft.id,
      expectedVersion: draft.version,
      statementDate: "2026-03-13",
      statementBalance: dec(balance),
    });
    await m.owner.ok("reconcile.setCleared", {
      id: draft.id,
      expectedVersion: draft.version,
      reset: "all",
      deselect: [(lines.find((line) => line.narration.includes("Late entry")) as Json).postingId],
    });
    const before = await m.owner.ok("reconcile.get", { id: draft.id });
    expect(before.stale).toBe(false);
    m.advance();
    await postPayment(m.owner, {
      date: "2026-03-12",
      amount: "3.21",
      narration: "Posted meanwhile",
    });
    const stale = await m.owner.ok("reconcile.get", { id: draft.id });
    expect(stale.stale).toBe(true);
    const record = await m.owner.ok("reconcile.complete", {
      id: stale.id,
      expectedVersion: stale.version,
    });
    const report = await reportOf(m.owner, record.id);
    const unselected = (before.lines as Json[]).filter((line) => !line.selected);
    expect(unselected.map((line) => line.narration)).toEqual(["Late entry for the 4th"]);
    // What the draft had not selected, and the posting it had not seen, in the order the books list them.
    expect(report.outstanding.lines.map((line: Json) => line.narration)).toEqual([
      "Late entry for the 4th",
      "Posted meanwhile",
    ]);
    expect(report.outstanding.lines.map(lineFields)).toEqual(
      expect.arrayContaining(unselected.map(lineFields)),
    );
    expect(report.outstanding.total).toBe("-15.55");
    // Still the statement, to the cent: that is what makes the longer list the true one.
    expect(cents(report.bookBalance) - cents(report.outstanding.total)).toBe(
      cents(report.statementBalance),
    );
  });

  test("every finished reconciliation in the book reports, and every report adds up", async () => {
    const found: Json[] = [];
    for (const status of ["completed", "voided"]) {
      const listed = await m.owner.ok("reconcile.list", { accountId: "1000", status });
      found.push(...listed.items);
    }
    expect(found.length).toBe(4);
    for (const item of found) {
      const report = await reportOf(m.owner, item.id);
      expect(report.status).toBe(item.status);
      expect(cents(report.bookBalance) - cents(report.outstanding.total)).toBe(
        cents(report.statementBalance),
      );
      expect(cents(report.openingBalance) + cents(report.cleared.total)).toBe(
        cents(report.statementBalance),
      );
    }
  });
});

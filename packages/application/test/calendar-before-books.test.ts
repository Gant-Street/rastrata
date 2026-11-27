import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture, type Fixture } from "./calendar-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

/** Books that began on 1 March 2026, looked at on 4 October: January and February end before the
 * books began, April to September have ended and are open, October is under way. */
async function midYearCutover() {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 9, 4, 12, 0, 0),
  });
  await f.setup(baseSetup);
  const set = await f.call(
    "cutover.set",
    { cutoverDate: "2026-03-01", accountIds: ["1000"] },
    crypto.randomUUID(),
  );
  expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
  return f;
}

const idsWhere = (list: { periods: { id: string }[] }, flag: (row: never) => boolean) =>
  list.periods.filter((row) => flag(row as never)).map((row) => row.id);

test("periods that end before the books began say so, and no others do", async () => {
  const f = await midYearCutover();
  const list = await f.periods();
  expect(list.calendar.booksBegan).toBe("2026-03-01");
  expect(idsWhere(list, (row: { beforeBooks: boolean }) => row.beforeBooks)).toEqual([
    "period-01",
    "period-02",
  ]);
  // The fiscal year is judged by the periods that count: ten of twelve, none closed.
  expect(list.calendar.fiscalYears[0]).toMatchObject({
    fiscalYear: 2026,
    periodCount: 10,
    closedCount: 0,
    status: "open",
    beforeBooks: false,
    periodsBeforeBooks: 2,
  });
});

test("a book with no cutover has no period before the books began", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 9, 4, 12, 0, 0),
  });
  await f.setup(baseSetup);
  const list = await f.periods();
  expect(list.calendar.booksBegan).toBeNull();
  expect(idsWhere(list, (row: { beforeBooks: boolean }) => row.beforeBooks)).toEqual([]);
  expect(list.calendar.fiscalYears[0]).toMatchObject({ periodCount: 12, periodsBeforeBooks: 0 });
});

test("the period that holds the cutover date is part of the books", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 9, 4, 12, 0, 0),
  });
  await f.setup(baseSetup);
  await f.call(
    "cutover.set",
    { cutoverDate: "2026-03-15", accountIds: ["1000"] },
    crypto.randomUUID(),
  );
  const list = await f.periods();
  expect(idsWhere(list, (row: { beforeBooks: boolean }) => row.beforeBooks)).toEqual([
    "period-01",
    "period-02",
  ]);
});

test("closing a month does not warn that the months before the books began are open", async () => {
  const f = await midYearCutover();
  const close = async (periodId: string) =>
    (
      await f.call(
        "periods.prepare",
        { periodId, operation: "close", reason: "Reviewed" },
        crypto.randomUUID(),
      )
    ).body.data;
  const march = await close("period-03");
  expect(march.valid).toBe(true);
  expect((march.warnings ?? []).map((w: { code: string }) => w.code)).not.toContain(
    "earlier_period_open",
  );
  // After March is closed, closing April is in order too.
  const done = await f.prepareCommit("periods.prepare", {
    periodId: "period-03",
    operation: "close",
    reason: "Reviewed",
  });
  expect(done.receipt?.body.data.disposition).toBe("committed");
  const april = await close("period-04");
  expect((april.warnings ?? []).map((w: { code: string }) => w.code)).not.toContain(
    "earlier_period_open",
  );
  // Periods after the books began still count: closing May while April is open warns, once.
  const may = await close("period-05");
  const warned = may.warnings.find((w: { code: string }) => w.code === "earlier_period_open");
  expect(warned.message).toContain("1 earlier period is still open");
  expect(warned.message).toContain("April 2026");
});

async function review(f: Fixture, fiscalYear: number) {
  return (await f.call("periods.yearEndReview", { fiscalYear })).body.data;
}

test("the year-end says nothing is wrong with the months before the books began, and closes them", async () => {
  const f = await midYearCutover();
  const year = await review(f, 2026);
  expect(year.periods.map((p: { beforeBooks: boolean }) => p.beforeBooks)).toEqual([
    true,
    true,
    ...Array.from({ length: 10 }, () => false),
  ]);
  const before = year.checks.find((c: { id: string }) => c.id === "before-books");
  expect(before).toMatchObject({ status: "pass" });
  expect(before.detail).toContain(
    "January 2026, February 2026 end before the books began on 2026-03-01",
  );
  expect(before.detail).toContain("not counted as open");
  // Nothing in the checklist is a reason to wait.
  expect(
    year.checks
      .filter((c: { status: string }) => c.status === "attention")
      .map((c: { id: string }) => c.id),
  ).toEqual(
    // The year has not ended: that is the one honest thing to look at.
    ["periods-ended"],
  );
  // The plan closes them with the rest, in order, with no warning about their order.
  const plan = (
    await f.call("periods.yearEnd", { fiscalYear: 2026, reason: "Reviewed" }, crypto.randomUUID())
  ).body.data;
  expect(plan.valid).toBe(true);
  expect(plan.steps.map((s: { label: string }) => s.label).slice(0, 3)).toEqual([
    "January",
    "February",
    "March",
  ]);
  const warned = plan.steps.flatMap((s: { plans: { warnings?: { code: string }[] }[] }) =>
    s.plans.flatMap((p) => (p.warnings ?? []).map((w) => w.code)),
  );
  expect(warned).not.toContain("earlier_period_open");
  const done = await f.call(
    "periods.commitYearEnd",
    { planId: plan.planId, planHash: plan.planHash },
    crypto.randomUUID(),
  );
  expect(done.body.data.disposition).toBe("committed");
  expect((await f.periods()).calendar.fiscalYears[0]).toMatchObject({
    status: "closed",
    closedCount: 10,
    periodsBeforeBooks: 2,
  });
});

test("a fiscal year that ended before the books began has nothing to close and is not an earlier year to worry about", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2027, 1, 10, 12, 0, 0),
  });
  await f.setup(baseSetup);
  await f.extend();
  await f.call(
    "cutover.set",
    { cutoverDate: "2027-01-01", accountIds: ["1000"] },
    crypto.randomUUID(),
  );
  const list = await f.periods();
  expect(list.calendar.fiscalYears[0]).toMatchObject({
    fiscalYear: 2026,
    beforeBooks: true,
    periodsBeforeBooks: 12,
    ended: true,
  });
  expect(list.calendar.fiscalYears[1]).toMatchObject({
    fiscalYear: 2027,
    beforeBooks: false,
    periodsBeforeBooks: 0,
  });
  // The next year's year-end review does not call 2026's open months an earlier year left open.
  const next = await review(f, 2027);
  expect(next.checks.find((c: { id: string }) => c.id === "earlier-years")).toMatchObject({
    status: "pass",
  });
});

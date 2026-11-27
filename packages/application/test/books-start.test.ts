import { afterEach, expect, test } from "bun:test";
import { booksFirstDay, calendarEndYear, calendarThroughFor } from "../src/calendar/setup.ts";
import { baseSetup, fixture } from "./calendar-support.ts";

/** A book's calendar and the day its books begin are two facts. The calendar is built from the first
 * fiscal year through the one the book is created in, so a book that starts early never has to add
 * earlier years (a calendar only grows forward); the books begin on a day the setup names, and every
 * period that ends before it is left out of the counts. */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
const open = () =>
  fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 10, 2, 12, 0, 0),
  });

/** `book.setup` as it is sent, without the fixture's one-year default for the calendar. */
type Fixture = Awaited<ReturnType<typeof fixture>>;
const create = async (f: Fixture, body: Record<string, unknown>) => {
  const reply = await f.call(
    "book.setup",
    { ...baseSetup, accounts: [...baseSetup.accounts], ...body },
    crypto.randomUUID(),
  );
  return reply;
};

test("a book that starts in 2000 has a calendar from 2000 through the year it was made in, in one setup", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" })).body.ok).toBe(true);
  const list = await f.periods();
  expect(list.calendar).toMatchObject({
    firstDate: "2000-01-01",
    lastDate: "2026-12-31",
    booksBegan: "2026-01-01",
    canExtend: true,
    nextFiscalYear: 2027,
  });
  expect(list.periods).toHaveLength(27 * 12);
  expect(list.calendar.fiscalYears).toHaveLength(27);
  // Every year before the books began says so, and none of them needs closing.
  const years = list.calendar.fiscalYears as { fiscalYear: number; beforeBooks: boolean }[];
  expect(years.filter((year) => year.beforeBooks).map((year) => year.fiscalYear)).toEqual(
    Array.from({ length: 26 }, (_, index) => 2000 + index),
  );
  expect(years.find((year) => year.fiscalYear === 2026)?.beforeBooks).toBe(false);
});

test("the calendar's last year can be named, and a book made before the field has its first year only", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2024, calendarThrough: 2025 })).body.ok).toBe(true);
  const list = await f.periods();
  expect(list.calendar).toMatchObject({ firstDate: "2024-01-01", lastDate: "2025-12-31" });
  expect(calendarEndYear({ fiscalYear: 2024 })).toBe(2024);
  expect(calendarEndYear({ fiscalYear: 2024, calendarThrough: 2030 })).toBe(2030);
});

test("a setup that leaves the days and years out is the same request as one that spells them out", async () => {
  const f = await open();
  const first = await create(f, { fiscalYear: 2020 });
  expect(first.body.ok, JSON.stringify(first.body)).toBe(true);
  // The retry omits `calendarThrough`; the book recorded the year it was made in.
  const again = await create(f, { fiscalYear: 2020 });
  expect(again.body.ok, JSON.stringify(again.body)).toBe(true);
  expect(again.body.data.outcomeSequence).toBe(first.body.data.outcomeSequence);
  // A different day the books begin is a different book.
  const other = await create(f, { fiscalYear: 2020, booksStartOn: "2021-01-01" });
  expect(other.body.ok).toBe(false);
});

test("the day the books begin must be a real date inside the calendar", async () => {
  const f = await open();
  for (const booksStartOn of ["2026-02-30", "1999-12-31", "2101-01-01", "last year"]) {
    const refused = await create(f, { fiscalYear: 2000, booksStartOn });
    expect(refused.body.ok, booksStartOn).toBe(false);
  }
  // A calendar cannot end before it starts.
  expect((await create(f, { fiscalYear: 2026, calendarThrough: 2025 })).body.ok).toBe(false);
});

test("a recorded cutover date replaces the day the setup named", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2020, booksStartOn: "2026-01-01" })).body.ok).toBe(true);
  expect((await f.periods()).calendar.booksBegan).toBe("2026-01-01");
  const set = await f.call("cutover.set", { cutoverDate: "2026-03-01" }, crypto.randomUUID());
  expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
  const list = await f.periods();
  expect(list.calendar.booksBegan).toBe("2026-03-01");
  // January and February 2026 now end before the books began.
  const before = (list.periods as { label: string; startsOn: string; beforeBooks: boolean }[])
    .filter((period) => period.startsOn >= "2026-01-01" && period.beforeBooks)
    .map((period) => period.label);
  expect(before).toEqual(["January", "February"]);
});

test("a book that names no day begins on the first day of its first fiscal year", () => {
  expect(booksFirstDay({ fiscalYear: 2026 })).toBe("2026-01-01");
  expect(booksFirstDay({ fiscalYear: 2026, fiscalYearStartMonth: 10 })).toBe("2026-10-01");
  expect(booksFirstDay({ fiscalYear: 2000, booksStartOn: "2026-01-01" })).toBe("2026-01-01");
});

test("a new book's calendar runs through the fiscal year it is created in, and never before its first", () => {
  const january = { fiscalYear: 2000, fiscalYearStartMonth: 1 };
  expect(calendarThroughFor(january, "2026-11-02")).toBe(2026);
  expect(calendarThroughFor(january, "2026-01-01")).toBe(2026);
  // October is the first month of a fiscal year named for the year it starts in.
  const october = { fiscalYear: 2000, fiscalYearStartMonth: 10 };
  expect(calendarThroughFor(october, "2026-09-30")).toBe(2025);
  expect(calendarThroughFor(october, "2026-10-01")).toBe(2026);
  // A book that starts in the future has that year only.
  expect(calendarThroughFor({ fiscalYear: 2030, fiscalYearStartMonth: 1 }, "2026-11-02")).toBe(
    2030,
  );
  // And the calendar stops where the application does.
  expect(calendarThroughFor({ fiscalYear: 2000, fiscalYearStartMonth: 1 }, "2150-01-01")).toBe(
    2100,
  );
});

test("the month checklist works for a book whose calendar starts years before its books, and names only the books' own periods", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" })).body.ok).toBe(true);
  const check = await f.call("cutover.checklist", {});
  expect(check.body.ok, JSON.stringify(check.body)).toBe(true);
  // The first period to check is the books' first, not January 2000.
  expect(check.body.data.period).toEqual({
    id: "period-2026-01",
    label: "January 2026",
    startsOn: "2026-01-01",
    endsOn: "2026-01-31",
    status: "open",
    ended: true,
  });
  const openPeriods = check.body.data.openPeriods as { startsOn: string }[];
  expect(openPeriods).toHaveLength(12);
  expect(openPeriods.every((period) => period.startsOn >= "2026-01-01")).toBe(true);
  // A year from before the books began can still be asked about, and says there is nothing in it.
  const before = await f.call("periods.yearEndReview", { fiscalYear: 2010 });
  expect(before.body.ok, JSON.stringify(before.body)).toBe(true);
});

test("an entry cannot be dated before the day the books began, except the day before, where the opening balances stand", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" })).body.ok).toBe(true);
  // A mistyped year does not land in a year the books do not hold.
  const typo = await f.post("2016-03-04", "10.00");
  expect(typo.plan.ok).toBe(false);
  expect(typo.plan.error.code).toBe("before_books_began");
  expect(typo.plan.error.message).toContain("2026-01-01");
  expect((await f.post("2025-12-30", "10.00")).plan.ok).toBe(false);
  expect((await f.post("2025-12-31", "10.00")).receipt?.data?.disposition).toBe("committed");
  expect((await f.post("2026-01-01", "10.00")).receipt?.data?.disposition).toBe("committed");
});

test("a cutover date earlier than the books began moves the floor with it, which is how earlier years are brought in", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" })).body.ok).toBe(true);
  expect((await f.post("2019-12-31", "10.00")).plan.ok).toBe(false);
  const set = await f.call("cutover.set", { cutoverDate: "2020-01-01" }, crypto.randomUUID());
  expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
  expect((await f.post("2019-12-31", "10.00")).receipt?.data?.disposition).toBe("committed");
  expect((await f.post("2019-12-30", "10.00")).plan.ok).toBe(false);
});

test("a book whose books begin in a later fiscal year than it is made in has a calendar that reaches that year", async () => {
  const f = await open();
  // Made in 2026, for books that begin on the first day of 2027: the opening balances and the first entries
  // are dated in 2027, so the calendar covers it from the start.
  expect((await create(f, { fiscalYear: 2000, booksStartOn: "2027-01-01" })).body.ok).toBe(true);
  const list = await f.periods();
  expect(list.calendar.booksBegan).toBe("2027-01-01");
  expect(list.calendar.lastDate).toBe("2027-12-31");
  expect((await f.post("2027-01-05", "10.00")).receipt?.data?.disposition).toBe("committed");
});

test("a book that names no day is limited by its calendar alone, as every book was before", async () => {
  const f = await open();
  expect((await create(f, { fiscalYear: 2024, calendarThrough: 2026 })).body.ok).toBe(true);
  expect((await f.post("2024-01-05", "10.00")).receipt?.data?.disposition).toBe("committed");
  const before = await f.post("2023-12-31", "10.00");
  expect(before.plan.error.code).toBe("calendar_not_configured");
});

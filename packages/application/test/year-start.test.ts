import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture } from "./calendar-support.ts";

/** The month fiscal years start in can be changed until the book has an entry or a closed period. The
 * whole calendar is drawn again, so nothing refers to a period that goes; after that the periods are
 * history and the way is a new book. The month the ledger's calendar starts its years in is what the
 * book reports, whatever month the stored setup was created with. */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
const open = () =>
  fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 10, 2, 12, 0, 0),
  });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const create = async (f: Fixture, body: Record<string, unknown>) => {
  const reply = await f.call(
    "book.setup",
    { ...baseSetup, accounts: [...baseSetup.accounts], ...body },
    crypto.randomUUID(),
  );
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
};
const change = (f: Fixture, month: number) =>
  f.prepareCommit("periods.changeYearStart", { fiscalYearStartMonth: month });

test("a book with no entry can start its fiscal years in October, and the whole calendar is drawn again", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" });
  const before = await f.periods();
  expect(before.calendar).toMatchObject({
    fiscalYearStartMonth: 1,
    canChangeYearStart: true,
    yearStartNote: "",
    firstDate: "2000-01-01",
    lastDate: "2026-12-31",
  });
  const done = await change(f, 10);
  expect(done.plan.body.data.valid, JSON.stringify(done.plan.body)).toBe(true);
  expect(done.receipt?.body.data.disposition, JSON.stringify(done.receipt?.body)).toBe("committed");
  const after = await f.periods();
  // The first fiscal year that begins on or after the old first day is October 2000; the calendar ends
  // where the fiscal year that held the old last day ends.
  expect(after.calendar).toMatchObject({
    fiscalYearStartMonth: 10,
    firstDate: "2000-10-01",
    lastDate: "2027-09-30",
    booksBegan: "2026-01-01",
    nextFiscalYear: 2027,
    nextStartsOn: "2027-10-01",
  });
  expect(after.periods).toHaveLength(27 * 12);
  const first = after.periods[0];
  // The redrawn calendar has ids of its own: an id remembered from before names no period now.
  expect(first).toMatchObject({
    id: "period-m10-01",
    label: "October",
    fiscalYear: 2000,
    ordinal: 1,
  });
  expect(after.periods.some((period: { id: string }) => period.id === "period-2026-01")).toBe(
    false,
  );
  // January 2026 is the fourth month of the fiscal year that began in October 2025, and the months of
  // that year before the books began are said so.
  const january = after.periods.find(
    (period: { startsOn: string }) => period.startsOn === "2026-01-01",
  );
  expect(january).toMatchObject({ fiscalYear: 2025, ordinal: 4, beforeBooks: false });
  const december = after.periods.find(
    (period: { startsOn: string }) => period.startsOn === "2025-12-01",
  );
  expect(december).toMatchObject({ fiscalYear: 2025, beforeBooks: true });
});

test("the book reports the month its calendar starts years in, and the stored setup keeps the month it was created with", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" });
  await change(f, 7);
  const capabilities = (await f.call("capabilities.get")).body.data;
  expect(capabilities.fiscalYearStartMonth).toBe(7);
  const book = (await f.call("book.get")).body.data;
  expect(book.setup.fiscalYearStartMonth).toBe(7);
  // A retried `book.setup` with the month it was created with is still the same request.
  const again = await f.call(
    "book.setup",
    {
      ...baseSetup,
      accounts: [...baseSetup.accounts],
      fiscalYear: 2000,
      booksStartOn: "2026-01-01",
    },
    crypto.randomUUID(),
  );
  expect(again.body.ok, JSON.stringify(again.body)).toBe(true);
});

test("the calendar goes on from a drawn-again calendar, and an entry can be posted in it", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" });
  await change(f, 10);
  await f.extend();
  const list = await f.periods();
  expect(list.calendar).toMatchObject({ lastDate: "2028-09-30", fiscalYearStartMonth: 10 });
  const ids = list.periods.map((period: { id: string }) => period.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(list.periods.at(-1)).toMatchObject({
    id: "period-m10-2027-12",
    fiscalYear: 2027,
    ordinal: 12,
  });
  await f.postOk("2026-03-15", "10.00");
});

test("after the first entry the fiscal year cannot be changed, and the calendar says why", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" });
  await f.postOk("2026-03-15", "10.00");
  const list = await f.periods();
  expect(list.calendar.canChangeYearStart).toBe(false);
  expect(list.calendar.yearStartNote).toContain("until the first entry is posted");
  const refused = await f.call(
    "periods.changeYearStart",
    { fiscalYearStartMonth: 10 },
    crypto.randomUUID(),
  );
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.code).toBe("year_start_has_entries");
});

test("a closed period also fixes the fiscal year", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" });
  const closed = await f.prepareCommit("periods.prepare", {
    periodId: "period-2026-01",
    operation: "close",
    reason: "January reviewed",
  });
  expect(closed.receipt?.body.data.disposition).toBe("committed");
  const refused = await f.call(
    "periods.changeYearStart",
    { fiscalYearStartMonth: 10 },
    crypto.randomUUID(),
  );
  expect(refused.body.error.code).toBe("year_start_has_closes");
});

test("the month it already has is refused, and so is a month the books began before", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2000-03-01" });
  const same = await f.call(
    "periods.changeYearStart",
    { fiscalYearStartMonth: 1 },
    crypto.randomUUID(),
  );
  expect(same.body.error.code).toBe("year_start_unchanged");
  // The first October year starts in October 2000, after the books began in March.
  const before = await f.call(
    "periods.changeYearStart",
    { fiscalYearStartMonth: 10 },
    crypto.randomUUID(),
  );
  expect(before.body.error.code).toBe("year_start_before_books");
  const bad = await f.call(
    "periods.changeYearStart",
    { fiscalYearStartMonth: 13 },
    crypto.randomUUID(),
  );
  expect(bad.body.ok).toBe(false);
});

test("a book that keeps quarters can start its years in April", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01", periodModel: "quarterly" });
  const done = await change(f, 4);
  expect(done.receipt?.body.data.disposition, JSON.stringify(done.plan.body)).toBe("committed");
  const list = await f.periods();
  expect(list.calendar).toMatchObject({
    fiscalYearStartMonth: 4,
    firstDate: "2000-04-01",
    periodModel: "quarterly",
  });
  expect(list.periods[0]).toMatchObject({ label: "Q1", fiscalYear: 2000, ordinal: 1 });
  expect(list.periods.length % 4).toBe(0);
});

test("the Changes feed says what happened in a sentence", async () => {
  const f = await open();
  await create(f, { fiscalYear: 2000, booksStartOn: "2026-01-01" });
  await change(f, 10);
  const feed = await f.call("changes.list", {});
  expect(feed.body.ok, JSON.stringify(feed.body)).toBe(true);
  const sentences = (feed.body.data.changes as { summary: string }[]).map((item) => item.summary);
  expect(sentences).toContain("Changed the fiscal year to start in October.");
});

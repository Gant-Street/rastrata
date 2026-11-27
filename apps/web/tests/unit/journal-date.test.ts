import { expect, test } from "bun:test";
import { reversalDate, startingDate } from "../../src/routes/journal-date";

// Where a new entry's date starts: today, held inside the book's calendar; the opening entry on the
// calendar's first day.
const october = { firstDate: "2025-10-01", lastDate: "2026-09-30" };

test("an entry starts today when today is inside the calendar", () => {
  expect(
    startingDate({
      opening: false,
      today: "2026-03-14",
      firstFiscalDay: "2025-01-01",
      calendar: october,
    }),
  ).toBe("2026-03-14");
  // The first and the last day are inside it.
  expect(
    startingDate({
      opening: false,
      today: "2025-10-01",
      firstFiscalDay: "2025-01-01",
      calendar: october,
    }),
  ).toBe("2025-10-01");
  expect(
    startingDate({
      opening: false,
      today: "2026-09-30",
      firstFiscalDay: "2025-01-01",
      calendar: october,
    }),
  ).toBe("2026-09-30");
});

test("a calendar that has ended starts an entry on its last day, and one that has not begun on its first", () => {
  expect(
    startingDate({
      opening: false,
      today: "2026-10-04",
      firstFiscalDay: "2025-01-01",
      calendar: october,
    }),
  ).toBe("2026-09-30");
  expect(
    startingDate({
      opening: false,
      today: "2025-06-01",
      firstFiscalDay: "2025-01-01",
      calendar: october,
    }),
  ).toBe("2025-10-01");
});

test("the opening entry starts on the first day of the calendar, whatever today is", () => {
  expect(
    startingDate({
      opening: true,
      today: "2026-03-14",
      firstFiscalDay: "2025-01-01",
      calendar: october,
    }),
  ).toBe("2025-10-01");
});

// Where a reversal's date starts: the entry's own date while its period is open, so the period's
// figures are right; today, inside the calendar, when that period is closed and nothing can go there.
const march = { startsOn: "2026-03-01", endsOn: "2026-03-31" };

test("a reversal starts on the date of the entry it cancels while that period is open", () => {
  expect(
    reversalDate({
      entryDate: "2026-04-02",
      today: "2026-10-04",
      calendar: { firstDate: "2026-01-01", lastDate: "2026-12-31" },
      locked: [march],
    }),
  ).toBe("2026-04-02");
  // No period is locked: the entry's own date.
  expect(reversalDate({ entryDate: "2026-03-20", today: "2026-10-04", locked: [] })).toBe(
    "2026-03-20",
  );
});

test("a reversal of an entry in a closed period starts today, held inside the calendar", () => {
  const calendar = { firstDate: "2026-01-01", lastDate: "2026-12-31" };
  expect(
    reversalDate({ entryDate: "2026-03-20", today: "2026-10-04", calendar, locked: [march] }),
  ).toBe("2026-10-04");
  // The first and the last day of the closed period are inside it.
  expect(
    reversalDate({ entryDate: "2026-03-01", today: "2026-10-04", calendar, locked: [march] }),
  ).toBe("2026-10-04");
  expect(
    reversalDate({ entryDate: "2026-03-31", today: "2026-10-04", calendar, locked: [march] }),
  ).toBe("2026-10-04");
  // A calendar that has ended starts it on its last day, as a new entry does.
  expect(
    reversalDate({
      entryDate: "2026-03-20",
      today: "2027-02-01",
      calendar,
      locked: [march],
    }),
  ).toBe("2026-12-31");
});

test("before the calendar has been read, an entry starts today and the opening entry on the first fiscal day", () => {
  expect(startingDate({ opening: false, today: "2026-03-14", firstFiscalDay: "2026-01-01" })).toBe(
    "2026-03-14",
  );
  expect(startingDate({ opening: true, today: "2026-03-14", firstFiscalDay: "2026-01-01" })).toBe(
    "2026-01-01",
  );
});

test("the opening entry starts on the day the books began, not on the first day of a calendar that starts years earlier", () => {
  const early = { firstDate: "2000-01-01", lastDate: "2026-12-31" };
  expect(
    startingDate({
      opening: true,
      today: "2026-11-02",
      firstFiscalDay: "2000-01-01",
      calendar: { ...early, booksBegan: "2026-01-01" },
    }),
  ).toBe("2026-01-01");
  // A book that names no day, or has none recorded, keeps starting at the calendar's first day.
  expect(
    startingDate({
      opening: true,
      today: "2026-11-02",
      firstFiscalDay: "2000-01-01",
      calendar: { ...early, booksBegan: null },
    }),
  ).toBe("2000-01-01");
  expect(
    startingDate({
      opening: true,
      today: "2026-11-02",
      firstFiscalDay: "2000-01-01",
      calendar: early,
    }),
  ).toBe("2000-01-01");
});

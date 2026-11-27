import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { baseSetup, fixture } from "./calendar-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
const open = () => fixture({ cleanup: (work) => cleanup.push(work) });

test("a setup that omits the new fields is an accrual book with a January fiscal year", async () => {
  const f = await open();
  const reply = await f.setup();
  expect(reply.body.data.setup).toMatchObject({ basis: "accrual", fiscalYearStartMonth: 1 });
  const book = (await f.call("book.get")).body.data;
  expect(book.setup).toMatchObject({ basis: "accrual", fiscalYearStartMonth: 1, fiscalYear: 2026 });
  const state = (await f.service.readAggregate()).aggregate.state;
  expect(state.identity.primaryBasis).toBe("accrual");
  expect(state.periods).toHaveLength(12);
  expect(state.periods[0]).toMatchObject({
    id: "period-01",
    startsOn: "2026-01-01",
    endsOn: "2026-01-31",
    fiscalYear: 2026n,
    sequence: 1n,
  });
  expect(state.periods[11]).toMatchObject({ id: "period-12", endsOn: "2026-12-31" });
  expect(String(state.openingBoundary?.firstAccountingDate)).toBe("2026-01-01");
});

test("a book stored before these fields existed reads with the defaults and is not rewritten", async () => {
  const f = await open();
  await f.setup();
  const raw = new Database(f.path);
  const stored = (raw.query("SELECT setup FROM app_book WHERE id=1").get() as { setup: string })
    .setup;
  raw.close();
  expect(JSON.parse(stored)).not.toHaveProperty("basis");
  expect(JSON.parse(stored)).not.toHaveProperty("fiscalYearStartMonth");
  await f.restart();
  expect(f.service.setupState()).toMatchObject({ basis: "accrual", fiscalYearStartMonth: 1 });
});

test("capabilities report the bases a new book can use and the configured book's own", async () => {
  const f = await open();
  const before = (await f.call("capabilities.get")).body.data;
  expect(before.bases).toEqual(["accrual", "cash"]);
  expect(before).not.toHaveProperty("basis");
  expect(before).not.toHaveProperty("fiscalYearStartMonth");
  await f.setup({ ...baseSetup, basis: "cash", fiscalYearStartMonth: 10 });
  const after = (await f.call("capabilities.get")).body.data;
  expect(after.bases).toEqual(["accrual", "cash"]);
  expect(after).toMatchObject({ basis: "cash", fiscalYearStartMonth: 10 });
});

test("a cash book carries the cash basis into the kernel's book identity and posts normally", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, basis: "cash" });
  const state = (await f.service.readAggregate()).aggregate.state;
  expect(state.identity.primaryBasis).toBe("cash");
  const posted = await f.post("2026-01-15", "100.00");
  expect(posted.receipt.data.disposition).toBe("committed");
  expect((await f.call("book.get")).body.data.setup.basis).toBe("cash");
  // The basis is part of the immutable book identity, so it survives a restart unchanged.
  await f.restart();
  expect((await f.service.readAggregate()).aggregate.state.identity.primaryBasis).toBe("cash");
});

test("an October fiscal year starts in October, labelled and numbered by the year it starts in", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, fiscalYearStartMonth: 10 });
  const periods = (await f.call("periods.list")).body.data.periods;
  expect(periods).toHaveLength(12);
  expect(periods[0]).toMatchObject({
    id: "period-01",
    label: "October",
    startsOn: "2026-10-01",
    endsOn: "2026-10-31",
  });
  expect(periods[3]).toMatchObject({ label: "January", startsOn: "2027-01-01" });
  expect(periods[11]).toMatchObject({
    id: "period-12",
    label: "September",
    endsOn: "2027-09-30",
  });
  const state = (await f.service.readAggregate()).aggregate.state;
  expect(new Set(state.periods.map((p) => p.fiscalYear))).toEqual(new Set([2026n]));
  expect(String(state.openingBoundary?.firstAccountingDate)).toBe("2026-10-01");
  const chart = (await f.call("accounts.list")).body.data;
  expect(chart.suggestedEffectiveOn).toBe("2026-10-01");
  expect(chart.accounts.every((a: { openedOn: string }) => a.openedOn === "2026-10-01")).toBe(true);
});

test("an October book accepts postings on both sides of the new year, refuses one before it began, and grows for one after its first year", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, fiscalYearStartMonth: 10 });
  for (const date of ["2026-10-01", "2026-12-31", "2027-01-01", "2027-09-30"]) {
    const posted = await f.post(date, "10.00");
    expect(posted.receipt?.data.disposition, date).toBe("committed");
  }
  // A date before the book began cannot be posted.
  const refused = await f.post("2026-09-30", "10.00");
  expect(refused.receipt?.data.disposition ?? "not prepared").not.toBe("committed");
  expect(refused.plan.ok ? refused.plan.data.valid : false).toBe(false);
  const report = (await f.call("reports.get", { asOf: "2027-09-30" })).body.data;
  expect(report.balanceSheet.assets).toBe("40.00");
  // The first day of the next fiscal year is past the calendar: the posting grows it by that year.
  const next = await f.post("2027-10-01", "10.00");
  expect(next.receipt?.data.disposition).toBe("committed");
  expect((await f.call("periods.list")).body.data.calendar.lastDate).toBe("2028-09-30");
});

test("quarterly periods follow the fiscal year start month", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, periodModel: "quarterly", fiscalYearStartMonth: 10 });
  const periods = (await f.call("periods.list")).body.data.periods;
  expect(
    periods.map((p: { startsOn: string; endsOn: string; label: string }) => [
      p.startsOn,
      p.endsOn,
      p.label,
    ]),
  ).toEqual([
    ["2026-10-01", "2026-12-31", "Q1"],
    ["2027-01-01", "2027-03-31", "Q2"],
    ["2027-04-01", "2027-06-30", "Q3"],
    ["2027-07-01", "2027-09-30", "Q4"],
  ]);
});

test("a setup with an unsupported basis or start month is refused with a plain reason", async () => {
  const f = await open();
  for (const patch of [
    { basis: "hybrid" },
    { basis: "" },
    { basis: null },
    { basis: 1 },
    { fiscalYearStartMonth: 0 },
    { fiscalYearStartMonth: 13 },
    { fiscalYearStartMonth: -3 },
    { fiscalYearStartMonth: 1.5 },
    { fiscalYearStartMonth: "10" },
    { fiscalYearStartMonth: null },
  ]) {
    const reply = await f.call("book.setup", { ...baseSetup, ...patch }, crypto.randomUUID());
    expect(reply.status, JSON.stringify(patch)).toBe(400);
    expect(reply.body.error.code).toBe("invalid_input");
    expect(reply.body.error.details[0].path).toMatch(/^input\.(basis|fiscalYearStartMonth)$/);
  }
  expect((await f.call("book.get")).body.data.setup).toBeNull();
  // The service refuses the same values when it is called directly, not through the schema.
  await expect(
    f.service.setup({ ...baseSetup, accounts: [...baseSetup.accounts], fiscalYearStartMonth: 13 }),
  ).rejects.toThrow("fiscalYearStartMonth must be a whole number from 1 to 12");
  await expect(
    f.service.setup({
      ...baseSetup,
      accounts: [...baseSetup.accounts],
      basis: "hybrid" as unknown as "cash",
    }),
  ).rejects.toThrow('basis must be "cash" or "accrual"');
});

test("the same setup retried with defaults spelled out is the same book; a different basis is a conflict", async () => {
  const f = await open();
  const id = crypto.randomUUID();
  const first = await f.call("book.setup", baseSetup, id);
  expect(first.body.ok).toBe(true);
  // The same identity and input returns the first response, including after a restart.
  await f.restart();
  expect(await f.call("book.setup", baseSetup, id)).toEqual(first);
  // A fresh identity that spells out the defaults describes the same book.
  const spelled = await f.call(
    "book.setup",
    { ...baseSetup, basis: "accrual", fiscalYearStartMonth: 1 },
    crypto.randomUUID(),
  );
  expect(spelled.body.ok).toBe(true);
  expect(spelled.body.data.outcomeSequence).toBe(first.body.data.outcomeSequence);
  for (const patch of [{ basis: "cash" }, { fiscalYearStartMonth: 7 }]) {
    const conflict = await f.call("book.setup", { ...baseSetup, ...patch }, crypto.randomUUID());
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("book_configuration_conflict");
  }
  // The same identity with different input is an identity conflict, never a second book.
  expect((await f.call("book.setup", { ...baseSetup, basis: "cash" }, id)).body.error.code).toBe(
    "operation_identity_conflict",
  );
});

test("a book that starts in the last month of a leap year still has exact period edges", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, fiscalYear: 2027, fiscalYearStartMonth: 3 });
  const periods = (await f.call("periods.list")).body.data.periods;
  const february = periods.find((p: { label: string }) => p.label === "February");
  expect(february).toMatchObject({ startsOn: "2028-02-01", endsOn: "2028-02-29" });
  expect(periods[0].startsOn).toBe("2027-03-01");
  expect(periods[11].endsOn).toBe("2028-02-29");
});

import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture } from "./calendar-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
const open = () => fixture({ cleanup: (work) => cleanup.push(work) });

test("periods.list says each period's fiscal year, whether it ended, and whether the calendar can extend", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 4, 20, 12, 0, 0),
  });
  await f.setup();
  const list = await f.periods();
  expect(list.calendar).toMatchObject({
    today: "2026-05-20",
    firstDate: "2026-01-01",
    lastDate: "2026-12-31",
    fiscalYearStartMonth: 1,
    periodModel: "monthly",
    canExtend: true,
    nextFiscalYear: 2027,
    nextStartsOn: "2027-01-01",
    nextEndsOn: "2027-12-31",
    extendNote: "",
    booksBegan: null,
  });
  expect(list.calendar.fiscalYears).toEqual([
    {
      fiscalYear: 2026,
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
      periodCount: 12,
      closedCount: 0,
      supersededCount: 0,
      status: "open",
      ended: false,
      beforeBooks: false,
      periodsBeforeBooks: 0,
    },
  ]);
  expect(list.periods).toHaveLength(12);
  expect(list.periods[0]).toMatchObject({
    id: "period-01",
    label: "January",
    fiscalYear: 2026,
    ordinal: 1,
    ended: true,
    status: "open",
    closeSuperseded: false,
    supersedes: [],
    alsoReopens: [],
    beforeBooks: false,
  });
  // A period has ended when its last day is before today: April has, May (today is in it) has not.
  expect(
    list.periods.filter((p: { ended: boolean }) => p.ended).map((p: { id: string }) => p.id),
  ).toEqual(["period-01", "period-02", "period-03", "period-04"]);
});

test("extending adds the next fiscal year after a reviewed plan, and changes nothing that exists", async () => {
  const f = await open();
  await f.setup();
  const before = (await f.service.readAggregate()).aggregate.state;
  const prepared = await f.call("periods.extend", {}, crypto.randomUUID());
  expect(prepared.status).toBe(200);
  const plan = prepared.body.data;
  expect(plan).toMatchObject({ kind: "extendCalendar", valid: true, disposition: "prepared" });
  expect(plan.effects.journals).toEqual([]);
  expect(plan.effects.accounts).toEqual([]);
  expect(plan.effects.periods).toEqual([]);
  expect(plan.effects.calendar).toHaveLength(12);
  expect(plan.effects.calendar[0]).toEqual({
    periodId: "period-2027-01",
    fiscalYear: 2027,
    label: "January",
    startsOn: "2027-01-01",
    endsOn: "2027-01-31",
  });
  expect(plan.effects.calendar[11]).toMatchObject({
    periodId: "period-2027-12",
    endsOn: "2027-12-31",
  });
  // Preparing is not committing: the calendar is unchanged.
  expect((await f.periods()).periods).toHaveLength(12);
  const receipt = await f.call("operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  expect(receipt.body.data.disposition).toBe("committed");
  const list = await f.periods();
  expect(list.periods).toHaveLength(24);
  expect(list.calendar).toMatchObject({
    lastDate: "2027-12-31",
    nextFiscalYear: 2028,
    canExtend: true,
  });
  expect(list.calendar.fiscalYears.map((y: { fiscalYear: number }) => y.fiscalYear)).toEqual([
    2026, 2027,
  ]);
  const after = (await f.service.readAggregate()).aggregate.state;
  // Existing periods are byte-for-byte what they were; sequences count on across the years.
  expect(after.periods.slice(0, 12)).toEqual([...before.periods]);
  expect(after.periods.slice(12).map((p) => Number(p.sequence))).toEqual(
    Array.from({ length: 12 }, (_, i) => 13 + i),
  );
  expect(new Set(after.periods.map((p) => p.id)).size).toBe(24);
  expect(after.configurationRevision).toBe(before.configurationRevision + 1n);
  expect(after.admissionSnapshot).toEqual(before.admissionSnapshot);
  // The chart's accounts are unaffected and the books still tie.
  expect((await f.call("accounts.list")).body.data.accounts).toHaveLength(4);
});

test("extension needs the configure permission to prepare and to commit", async () => {
  const f = await open();
  await f.setup();
  const denied = await f.call("periods.extend", {}, crypto.randomUUID(), ["read", "close", "post"]);
  expect(denied.status).toBe(403);
  const plan = (await f.call("periods.extend", {}, crypto.randomUUID(), ["read", "configure"])).body
    .data;
  const commit = { planId: plan.planId, planHash: plan.planHash };
  expect((await f.call("operations.commit", commit, undefined, ["post", "close"])).status).toBe(
    403,
  );
  expect(
    (await f.call("operations.commit", commit, undefined, ["configure"])).body.data.disposition,
  ).toBe("committed");
});

test("the same request returns the same plan and the same receipt, across a restart", async () => {
  const f = await open();
  await f.setup();
  const id = crypto.randomUUID();
  const first = await f.call("periods.extend", { through: 2028 }, id);
  expect(first.body.data.effects.calendar).toHaveLength(24);
  expect(await f.call("periods.extend", { through: 2028 }, id)).toEqual(first);
  await f.restart();
  expect(await f.call("periods.extend", { through: 2028 }, id)).toEqual(first);
  // A different request under the same identity is a conflict, never a second plan.
  expect((await f.call("periods.extend", { through: 2027 }, id)).body.error.code).toBe(
    "operation_identity_conflict",
  );
  const commit = { planId: first.body.data.planId, planHash: first.body.data.planHash };
  const committed = await f.call("operations.commit", commit);
  expect(committed.body.data.disposition).toBe("committed");
  await f.restart();
  expect(await f.call("operations.commit", commit)).toEqual(committed);
  expect((await f.periods()).periods).toHaveLength(36);
  expect((await f.service.readAggregate()).aggregate.state.configurationRevision).toBe(1n);
});

test("a new request for a year the calendar already covers is refused, not silently empty", async () => {
  const f = await open();
  await f.setup();
  await f.extend();
  for (const through of [2026, 2027]) {
    const again = await f.call("periods.extend", { through }, crypto.randomUUID());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("calendar_already_covers");
    expect(again.body.error.message).toContain("2027-12-31");
  }
  // Omitted means one more year than today's end, so it is the next one.
  const next = await f.call("periods.extend", {}, crypto.randomUUID());
  expect(next.body.data.effects.calendar[0].periodId).toBe("period-2028-01");
});

test("two plans prepared against the same book cannot both commit: the second is rejected, once", async () => {
  const f = await open();
  await f.setup();
  const a = (await f.call("periods.extend", {}, crypto.randomUUID())).body.data;
  const b = (await f.call("periods.extend", {}, crypto.randomUUID())).body.data;
  expect(a.planHash).not.toBe(b.planHash);
  expect(
    (await f.call("operations.commit", { planId: a.planId, planHash: a.planHash })).body.data
      .disposition,
  ).toBe("committed");
  const stale = await f.call("operations.commit", { planId: b.planId, planHash: b.planHash });
  expect(stale.body.data.disposition).toBe("rejected");
  expect(stale.body.data.problems.length).toBeGreaterThan(0);
  expect((await f.periods()).periods).toHaveLength(24);
});

test("a reply lost after the ledger took the extension is recovered from the same identity, once", async () => {
  const f = await open();
  await f.setup();
  const plan = (await f.call("periods.extend", {}, crypto.randomUUID())).body.data;
  const commit = { planId: plan.planId, planHash: plan.planHash };
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async (...args) => {
    await execute(...args);
    throw new Error("Reply lost after ledger admission");
  };
  const lost = await f.call("operations.commit", commit);
  expect(lost.status).toBe(503);
  expect(lost.body.error.code).toBe("operation_unresolved");
  f.service.ledger.execute = execute;
  await f.restart();
  expect((await f.call("operations.get", { operationId: plan.planId })).body.data.disposition).toBe(
    "committed",
  );
  const recovered = await f.call("operations.commit", commit);
  expect(recovered.body.data.disposition).toBe("committed");
  expect((await f.periods()).periods).toHaveLength(24);
  expect((await f.service.readAggregate()).aggregate.state.configurationRevision).toBe(1n);
});

test("through can add several fiscal years at once, up to ten, and never past 2100", async () => {
  const f = await open();
  await f.setup();
  const three = await f.call("periods.extend", { through: 2029 }, crypto.randomUUID());
  expect(three.body.data.effects.calendar).toHaveLength(36);
  expect(three.body.data.effects.calendar.at(-1)).toMatchObject({
    periodId: "period-2029-12",
    endsOn: "2029-12-31",
  });
  const tooMany = await f.call("periods.extend", { through: 2037 }, crypto.randomUUID());
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("invalid_input");
  expect(tooMany.body.error.message).toContain("at most 10");
  const exactlyTen = await f.call("periods.extend", { through: 2036 }, crypto.randomUUID());
  expect(exactlyTen.status).toBe(200);
  for (const through of [2101, 1999, 2026.5, "2027", null]) {
    const bad = await f.call("periods.extend", { through }, crypto.randomUUID());
    expect(bad.status, JSON.stringify(through)).toBe(400);
  }
});

test("a book that reaches fiscal year 2100 cannot extend further, and says so", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, fiscalYear: 2099, accounts: [...baseSetup.accounts] });
  const last = await f.extend();
  expect(last.plan.body.data.effects.calendar[0].periodId).toBe("period-2100-01");
  const list = await f.periods();
  expect(list.calendar).toMatchObject({
    canExtend: false,
    nextFiscalYear: null,
    nextStartsOn: null,
    nextEndsOn: null,
    lastDate: "2100-12-31",
  });
  expect(list.calendar.extendNote).toContain("2100");
  const more = await f.call("periods.extend", {}, crypto.randomUUID());
  expect(more.status).toBe(400);
  expect(more.body.error.code).toBe("invalid_input");
});

test("an October fiscal year extends to October and a quarterly book to four more quarters", async () => {
  const october = await open();
  await october.setup({ ...baseSetup, fiscalYearStartMonth: 10 });
  const plan = (await october.extend()).plan.body.data;
  expect(plan.effects.calendar[0]).toEqual({
    periodId: "period-2027-01",
    fiscalYear: 2027,
    label: "October",
    startsOn: "2027-10-01",
    endsOn: "2027-10-31",
  });
  expect(plan.effects.calendar[11]).toMatchObject({ label: "September", endsOn: "2028-09-30" });
  expect((await october.periods()).calendar).toMatchObject({
    firstDate: "2026-10-01",
    lastDate: "2028-09-30",
    nextFiscalYear: 2028,
    nextStartsOn: "2028-10-01",
  });

  const quarterly = await open();
  await quarterly.setup({ ...baseSetup, periodModel: "quarterly" });
  await quarterly.extend(2027);
  const periods = (await quarterly.periods()).periods;
  expect(periods).toHaveLength(8);
  expect(periods.map((p: { id: string }) => p.id)).toEqual([
    "period-01",
    "period-02",
    "period-03",
    "period-04",
    "period-2027-01",
    "period-2027-02",
    "period-2027-03",
    "period-2027-04",
  ]);
  expect(periods[4]).toMatchObject({ label: "Q1", startsOn: "2027-01-01", endsOn: "2027-03-31" });
  const state = (await quarterly.service.readAggregate()).aggregate.state;
  expect(state.periods.map((p) => Number(p.sequence))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a posting dated after the calendar's end grows the calendar itself and posts, under the poster's name", async () => {
  const f = await open();
  await f.setup();
  await f.postOk("2026-12-31", "10.00");
  // Posting needs no configure permission: an accountant's or a member's posting grows the calendar too.
  const poster = ["read", "draft", "post"] as const;
  const draft = (
    await f.call(
      "drafts.create",
      {
        data: {
          date: "2027-01-01",
          reference: "NY",
          narration: "First entry of the year",
          lines: [
            { accountId: "1000", debit: "10.00", credit: "" },
            { accountId: "4000", debit: "", credit: "10.00" },
          ],
        },
      },
      crypto.randomUUID(),
      poster,
    )
  ).body.data;
  const plan = await f.call(
    "journal.prepare",
    { draftId: draft.id, expectedVersion: draft.version },
    crypto.randomUUID(),
    poster,
  );
  expect(plan.body.ok, JSON.stringify(plan.body)).toBe(true);
  expect(plan.body.data.valid).toBe(true);
  const receipt = await f.call(
    "operations.commit",
    { planId: plan.body.data.planId, planHash: plan.body.data.planHash },
    undefined,
    poster,
  );
  expect(receipt.body.data.disposition).toBe("committed");
  const periods = await f.periods();
  expect(periods.calendar.lastDate).toBe("2027-12-31");
  expect(
    periods.calendar.fiscalYears.map((year: { fiscalYear: number }) => year.fiscalYear),
  ).toEqual([2026, 2027]);
  // Every period the calendar had is as it was.
  expect(
    periods.periods.filter((period: { fiscalYear: number }) => period.fiscalYear === 2026),
  ).toHaveLength(12);
  // The extension is a change of its own on the list, made by whoever posted.
  const feed = (await f.call("changes.list", {})).body.data;
  const extended = feed.changes.find(
    (change: { kind: string }) => change.kind === "calendar.extended",
  );
  const posted = feed.changes.find(
    (change: { kind: string; summary: string }) =>
      change.kind === "entry.posted" && change.summary.includes("First entry of the year"),
  );
  expect(extended?.summary).toContain("Extended the calendar through");
  expect(extended?.summary).toContain("2027");
  expect(posted).toBeDefined();
  expect(extended?.by).toEqual(posted?.by);
  // Asking again with the same draft changes nothing: the calendar covers the date, and the entry is in.
  const again = await f.call(
    "journal.prepare",
    { draftId: draft.id, expectedVersion: draft.version },
    crypto.randomUUID(),
  );
  expect(again.body.ok).toBe(false);
  expect((await f.periods()).calendar.lastDate).toBe("2027-12-31");
});

test("a date before the first period can never be posted; one far past the end grows the calendar in steps; one past 2100 cannot", async () => {
  const f = await open();
  await f.setup();
  const early = await f.post("2025-12-31", "1.00");
  expect(early.plan.error.code).toBe("calendar_not_configured");
  expect(early.plan.error.retryable).toBe(false);
  expect(early.plan.error.message).toContain("before the first day");
  expect(early.plan.error.message).toContain("fixed when the book is created");
  expect(early.plan.error.details.map((d: { path: string }) => d.path)).toEqual([
    "input.data.date",
    "calendar",
  ]);
  // The draft is still a draft: nothing was retained or rejected.
  expect((await f.call("drafts.get", { draftId: early.draft.id })).body.data.status).toBe("draft");
  // Fourteen years out: two extensions of at most ten years each, through the date's own fiscal year.
  const far = await f.post("2040-06-01", "1.00");
  expect(far.plan.ok, JSON.stringify(far.plan)).toBe(true);
  expect(far.receipt?.data?.disposition).toBe("committed");
  const periods = await f.periods();
  expect(periods.calendar.lastDate).toBe("2040-12-31");
  expect(periods.calendar.fiscalYears.at(-1)?.fiscalYear).toBe(2040);
  const feed = (await f.call("changes.list", {})).body.data;
  expect(
    feed.changes.filter((change: { kind: string }) => change.kind === "calendar.extended"),
  ).toHaveLength(2);
  // Past the last fiscal year Rastrata supports, nothing can be done, and the error says so.
  const past = await f.post("2101-06-01", "1.00");
  expect(past.plan.error.code).toBe("calendar_not_configured");
  expect(past.plan.error.message).toContain("past the last fiscal year");
  expect(past.plan.error.details.map((d: { path: string }) => d.path)).toEqual([
    "input.data.date",
    "calendar",
  ]);
  expect((await f.periods()).calendar.lastDate).toBe("2040-12-31");
});

test("an October book names the fiscal year a date belongs to, not its calendar year", async () => {
  const f = await open();
  await f.setup({ ...baseSetup, fiscalYearStartMonth: 10 });
  // 2027-09-15 is still fiscal year 2026; 2027-10-15 is in fiscal year 2027 (2027-10-01 to 2028-09-30),
  // which the posting adds: the October year the date belongs to, not a calendar year.
  const inFirst = await f.post("2027-09-15", "1.00");
  expect(inFirst.plan.ok).toBe(true);
  expect((await f.periods()).calendar.lastDate).toBe("2027-09-30");
  const inNext = await f.post("2027-10-15", "1.00");
  expect(inNext.plan.ok, JSON.stringify(inNext.plan)).toBe(true);
  expect(inNext.receipt?.data?.disposition).toBe("committed");
  const grown = await f.periods();
  expect(grown.calendar.lastDate).toBe("2028-09-30");
  expect(grown.calendar.fiscalYears.map((year: { fiscalYear: number }) => year.fiscalYear)).toEqual(
    [2026, 2027],
  );
  const reversalDate = await f.call(
    "journal.prepareReverse",
    { journalId: "nope", accountingDate: "2028-01-01", reason: "x" },
    crypto.randomUUID(),
  );
  // The original is checked first, so an unknown journal is still an invalid input.
  expect(reversalDate.body.error.code).toBe("invalid_input");
});

test("reversing into a year the calendar does not cover grows the calendar and reverses, in one step", async () => {
  const f = await open();
  await f.setup();
  const journalId = await f.postOk("2026-12-20", "25.00");
  const done = await f.prepareCommit("journal.prepareReverse", {
    journalId,
    accountingDate: "2027-01-05",
    reason: "Entered twice",
  });
  expect(done.plan.body.ok, JSON.stringify(done.plan.body)).toBe(true);
  expect(done.receipt?.body.data.disposition).toBe("committed");
  expect((await f.periods()).calendar.lastDate).toBe("2027-12-31");
  // A reversal before the first day still cannot be helped, and the error names the date's field.
  const early = await f.call(
    "journal.prepareReverse",
    { journalId, accountingDate: "2025-12-31", reason: "Entered twice" },
    crypto.randomUUID(),
  );
  expect(early.status).toBe(409);
  expect(early.body.error.code).toBe("calendar_not_configured");
  expect(early.body.error.details[0].path).toBe("input.accountingDate");
  // The original stays in 2026; the reversal is dated in 2027, so each year's statements show their own.
  const dec = (await f.call("reports.get", { asOf: "2026-12-31" })).body.data;
  expect(dec.balanceSheet.assets).toBe("25.00");
  const jan = (await f.call("reports.get", { asOf: "2027-01-31" })).body.data;
  expect(jan.balanceSheet.assets).toBe("0.00");
  expect(jan.profitAndLoss.netIncome).toBe("-25.00");
});

test("a configuration change made before the extension and one after it both stay in force", async () => {
  const f = await open();
  await f.setup();
  await f.postOk("2026-03-10", "100.00");
  const account = await f.prepareCommit("accounts.prepareCreate", {
    code: "5100",
    name: "Supplies",
    role: "expense",
    effectiveOn: "2026-03-11",
  });
  expect(account.receipt?.body.data.disposition).toBe("committed");
  await f.extend();
  const later = await f.prepareCommit("accounts.prepareCreate", {
    code: "5200",
    name: "Travel",
    role: "expense",
    effectiveOn: "2027-02-01",
  });
  expect(later.receipt?.body.data.disposition).toBe("committed");
  await f.postOk("2027-03-05", "40.00", ["5100", "1000"]);
  await f.postOk("2027-03-06", "15.00", ["5200", "1000"]);
  const report = (await f.call("reports.get", { asOf: "2027-03-31" })).body.data;
  expect(report.profitAndLoss.expenses).toBe("55.00");
  expect(report.profitAndLoss.netIncome).toBe("-55.00");
  // Earnings of 2026 roll forward by computation into 2027's balance sheet.
  expect(report.balanceSheet.priorEarnings).toBe("100.00");
  expect(report.balanceSheet.assets).toBe("45.00");
  expect((await f.service.readAggregate()).aggregate.state.configurationRevision).toBe(3n);
});

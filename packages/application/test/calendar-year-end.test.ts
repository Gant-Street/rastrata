import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { baseSetup, fixture, type Fixture } from "./calendar-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

/** A book with two fiscal years, some activity in each, and a clock in February 2027, so fiscal
 * year 2026 has ended and 2027 has not. */
async function twoYears(setup: Record<string, unknown> = baseSetup) {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2027, 1, 10, 12, 0, 0),
  });
  await f.setup(setup);
  await f.extend();
  await f.postOk("2026-01-15", "1000.00", ["1000", "3000"], "OPEN");
  await f.postOk("2026-03-10", "300.00", ["1000", "4000"], "SALE-1");
  await f.postOk("2026-06-20", "120.00", ["5000", "1000"], "COST-1");
  await f.postOk("2026-11-05", "500.00", ["1000", "4000"], "SALE-2");
  await f.postOk("2027-01-10", "50.00", ["5000", "1000"], "COST-2");
  return f;
}

async function prepareYearEnd(
  f: Fixture,
  fiscalYear: number,
  reason = "Reviewed with the accountant",
  id: string = crypto.randomUUID(),
) {
  const reply = await f.call("periods.yearEnd", { fiscalYear, reason }, id);
  return { id, reply, plan: reply.body.data };
}

const commitInput = (plan: { planId: string; planHash: string }) => ({
  planId: plan.planId,
  planHash: plan.planHash,
});

async function closedIds(f: Fixture) {
  return (await f.periods()).periods
    .filter((p: { status: string }) => p.status === "closed")
    .map((p: { id: string }) => p.id);
}

const allIds = (year: number, first: number) =>
  Array.from(
    { length: 12 },
    (_, i) => `period-${first === year ? "" : `${year}-`}${String(i + 1).padStart(2, "0")}`,
  );

test("the year-end plan seals one close per open period, in order, each with its own plan and hash", async () => {
  const f = await twoYears();
  const { reply, plan } = await prepareYearEnd(f, 2026);
  expect(reply.status).toBe(200);
  expect(plan).toMatchObject({
    disposition: "prepared",
    valid: true,
    fiscalYear: 2026,
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
    openCount: 12,
    closedCount: 0,
    problems: [],
    diagnostics: [],
  });
  expect(plan.planId).toBe(plan.operationId);
  expect(plan.steps.map((s: { periodId: string }) => s.periodId)).toEqual(allIds(2026, 2026));
  const revision = BigInt(plan.bookRevision);
  const hashes = new Set<string>();
  const populations = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    expect(step.order).toBe(index + 1);
    expect(step.status).toBe("open");
    expect(step.closeSuperseded).toBe(false);
    expect(step.plans).toHaveLength(1);
    expect(step.plans[0]).toMatchObject({
      kind: "closePeriod",
      valid: true,
      disposition: "prepared",
    });
    // Each close is sealed against the book as the closes before it leave it.
    expect(BigInt(step.plans[0].bookRevision)).toBe(revision + BigInt(index));
    expect(step.plans[0].effects.periods).toHaveLength(1);
    expect(step.plans[0].effects.periods[0]).toMatchObject({
      periodId: step.periodId,
      kind: "close",
      reason: `Year end FY2026, ${step.label}: Reviewed with the accountant`,
    });
    hashes.add(step.plans[0].planHash);
    populations.add(step.plans[0].effects.periods[0].reportPopulationHash);
    expect(step.plans[0].planId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
  expect(hashes.size).toBe(12);
  expect(populations.size).toBe(12);
  // Nothing has closed: this is a preview.
  expect(await closedIds(f)).toEqual([]);
  // The statements are the book's own, as of the last day of the year.
  const direct = (await f.call("reports.get", { asOf: "2026-12-31" })).body.data;
  expect(plan.statements).toMatchObject({
    asOf: "2026-12-31",
    periodStart: "2026-01-01",
    currency: "USD",
    basis: "accrual",
    populationHash: direct.populationHash,
    debit: direct.trialBalance.debit,
    credit: direct.trialBalance.credit,
    balanced: true,
    revenue: "800.00",
    expenses: "120.00",
    netIncome: "680.00",
    assets: "1680.00",
    liabilities: "0.00",
    equity: "1680.00",
    priorEarnings: "0.00",
    currentEarnings: "680.00",
  });
});

test("the checklist states what the book can say about the year before it is closed", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  const byId = Object.fromEntries(plan.checks.map((c: { id: string }) => [c.id, c]));
  expect(Object.keys(byId)).toEqual([
    "trial-balance",
    "profit-loss",
    "periods-ended",
    "closes-current",
    "earlier-years",
    "drafts",
  ]);
  expect(byId["trial-balance"]).toMatchObject({ status: "pass" });
  expect(byId["trial-balance"].detail).toContain("1800.00");
  expect(byId["profit-loss"].detail).toContain("net income 680.00");
  expect(byId["profit-loss"].detail).toContain("posts no entries");
  expect(byId["periods-ended"]).toMatchObject({ status: "pass" });
  expect(byId["closes-current"]).toMatchObject({ status: "pass" });
  expect(byId["earlier-years"]).toMatchObject({ status: "pass" });
  expect(byId.drafts).toMatchObject({ status: "pass" });

  // An unposted draft dated in the year is flagged: it is not in the books.
  await f.call(
    "drafts.create",
    {
      data: {
        date: "2026-11-03",
        reference: "LATE",
        narration: "Forgotten receipt",
        lines: [
          { accountId: "5000", debit: "9.00", credit: "" },
          { accountId: "1000", debit: "", credit: "9.00" },
        ],
      },
    },
    crypto.randomUUID(),
  );
  // FY2027 has not ended and FY2026 is still open: both show.
  const next = (await prepareYearEnd(f, 2027)).plan;
  const next2 = Object.fromEntries(next.checks.map((c: { id: string }) => [c.id, c]));
  expect(next2["periods-ended"].status).toBe("attention");
  expect(next2["periods-ended"].detail).toContain("2027-12-31");
  expect(next2["periods-ended"].detail).toContain("today is 2027-02-10");
  expect(next2["earlier-years"].status).toBe("attention");
  expect(next2["earlier-years"].detail).toContain(
    "12 periods of earlier fiscal years are still open",
  );
  expect(next2["earlier-years"].detail).toContain("January (2026-01-01 to 2026-01-31)");
  const again = (await prepareYearEnd(f, 2026)).plan;
  const drafts = again.checks.find((c: { id: string }) => c.id === "drafts");
  expect(drafts.status).toBe("attention");
  expect(drafts.detail).toContain("1 unposted draft is dated in fiscal year 2026");
  // None of it blocks the plan.
  expect(again.valid).toBe(true);
});

test("committing the year closes every period in order and records the year-end population on the last", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  const id = crypto.randomUUID();
  const commit = await f.call("periods.commitYearEnd", commitInput(plan), id);
  expect(commit.status).toBe(200);
  expect(commit.body.operationId).toBe(id);
  expect(commit.body.data).toMatchObject({
    disposition: "committed",
    operationId: id,
    planId: plan.planId,
    planHash: plan.planHash,
    fiscalYear: 2026,
    closedCount: 12,
    totalCount: 12,
    problems: [],
    diagnostics: [],
  });
  expect(commit.body.data.steps).toHaveLength(12);
  expect(
    commit.body.data.steps.every((s: { disposition: string }) => s.disposition === "committed"),
  ).toBe(true);
  const sequences = commit.body.data.steps.map((s: { outcomeSequence: string }) =>
    Number(s.outcomeSequence),
  );
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(commit.body.data.outcomeSequence).toBe(String(sequences.at(-1)));
  expect(await closedIds(f)).toEqual(allIds(2026, 2026));
  const list = await f.periods();
  expect(list.calendar.fiscalYears).toMatchObject([
    { fiscalYear: 2026, status: "closed", closedCount: 12 },
    { fiscalYear: 2027, status: "open", closedCount: 0 },
  ]);
  // The history says each close belongs to the year-end, newest first.
  expect(list.history).toHaveLength(12);
  expect(list.history[0]).toMatchObject({
    periodId: "period-12",
    kind: "close",
    reason: "Year end FY2026, December: Reviewed with the accountant",
    supersededCloseIds: [],
    supersededPeriodIds: [],
  });
  // Each close recorded the report population of the book as it stood at that close, so the final one
  // is the year-end population: it reproduces from the pinned revision just before the close.
  const december = list.periods[11];
  const recorded = december.reportPopulationHash;
  const pinned = (
    await f.call("reports.get", {
      asOf: "2026-12-31",
      revision: String(BigInt(december.closingRevision) - 1n),
    })
  ).body.data;
  expect(pinned.populationHash).toBe(recorded);
  expect(pinned.profitAndLoss.netIncome).toBe("680.00");
  expect(pinned.periodStart).toBe("2026-01-01");
  // The recorded hash is the step plan's own: what was reviewed is what was recorded.
  expect(plan.steps[11].plans[0].effects.periods[0].reportPopulationHash).toBe(recorded);
  // The figures did not move: closing posts no entries.
  const after = (await f.call("reports.get", { asOf: "2026-12-31" })).body.data;
  expect(after.balanceSheet.assets).toBe("1680.00");
  expect((await f.call("journal.list")).body.data.count).toBe(5);
});

test("a closed year refuses new postings, and the next year is unaffected", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  const blocked = await f.post("2026-06-10", "5.00");
  expect(blocked.plan.ok).toBe(true);
  expect(blocked.plan.data.valid).toBe(false);
  expect(blocked.plan.data.problems[0].message).toContain("closed");
  const fine = await f.post("2027-02-03", "5.00");
  expect(fine.receipt?.data.disposition).toBe("committed");
});

test("the same year-end request returns the same plan, before and after a restart, and the same receipt", async () => {
  const f = await twoYears();
  const { id, reply, plan } = await prepareYearEnd(f, 2026);
  expect(
    await f.call(
      "periods.yearEnd",
      { fiscalYear: 2026, reason: "Reviewed with the accountant" },
      id,
    ),
  ).toEqual(reply);
  await f.restart();
  expect(
    await f.call(
      "periods.yearEnd",
      { fiscalYear: 2026, reason: "Reviewed with the accountant" },
      id,
    ),
  ).toEqual(reply);
  expect(
    (await f.call("periods.yearEnd", { fiscalYear: 2026, reason: "Another reason" }, id)).body.error
      .code,
  ).toBe("operation_identity_conflict");
  const commitId = crypto.randomUUID();
  const first = await f.call("periods.commitYearEnd", commitInput(plan), commitId);
  await f.restart();
  expect(await f.call("periods.commitYearEnd", commitInput(plan), commitId)).toEqual(first);
  expect((await f.service.readAggregate()).aggregate.state.closePackages).toHaveLength(12);
  // A new identity for the same plan finds nothing left to do: every close is already committed.
  const second = await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  expect(second.body.data).toMatchObject({ disposition: "committed", closedCount: 12 });
  expect((await f.service.readAggregate()).aggregate.state.closePackages).toHaveLength(12);
});

test("an interruption part-way is resumed from the same identity, and no close is made twice", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  const commitId = crypto.randomUUID();
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  let calls = 0;
  f.service.ledger.execute = async (...args) => {
    calls += 1;
    if (calls === 5) throw new Error("Unavailable before admission");
    return execute(...args);
  };
  const interrupted = await f.call("periods.commitYearEnd", commitInput(plan), commitId);
  expect(interrupted.status).toBe(503);
  expect(interrupted.body.error.code).toBe("operation_unresolved");
  expect(interrupted.body.error.retryable).toBe(true);
  expect(await closedIds(f)).toEqual(allIds(2026, 2026).slice(0, 4));
  f.service.ledger.execute = execute;
  await f.restart();
  const resumed = await f.call("periods.commitYearEnd", commitInput(plan), commitId);
  expect(resumed.status).toBe(200);
  expect(resumed.body.data).toMatchObject({
    disposition: "committed",
    closedCount: 12,
    totalCount: 12,
  });
  expect(await closedIds(f)).toEqual(allIds(2026, 2026));
  const state = (await f.service.readAggregate()).aggregate.state;
  expect(state.closePackages).toHaveLength(12);
  expect(new Set(state.closePackages.map((c) => c.periodId)).size).toBe(12);
  expect(state.periodTransitions).toHaveLength(12);
});

test("a reply lost after a close was admitted does not close that period again", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  const commitId = crypto.randomUUID();
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  let calls = 0;
  f.service.ledger.execute = async (...args) => {
    calls += 1;
    const result = await execute(...args);
    if (calls === 6) throw new Error("Reply lost after ledger admission");
    return result;
  };
  const lost = await f.call("periods.commitYearEnd", commitInput(plan), commitId);
  expect(lost.status).toBe(503);
  // The ledger took six closes even though the sixth reply never arrived.
  expect(await closedIds(f)).toEqual(allIds(2026, 2026).slice(0, 6));
  f.service.ledger.execute = execute;
  const resumed = await f.call("periods.commitYearEnd", commitInput(plan), commitId);
  expect(resumed.body.data).toMatchObject({ disposition: "committed", closedCount: 12 });
  expect((await f.service.readAggregate()).aggregate.state.closePackages).toHaveLength(12);
  const sixth = resumed.body.data.steps[5];
  expect(sixth.disposition).toBe("committed");
  expect(
    (await f.call("operations.get", { operationId: plan.steps[5].plans[0].planId })).body.data
      .disposition,
  ).toBe("committed");
});

test("a book that changes after the review rejects the first close: nothing closes and the plan is dead", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  await f.postOk("2027-02-02", "11.00", ["5000", "1000"], "LATE-WRITE");
  const result = await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  expect(result.status).toBe(200);
  expect(result.body.data.disposition).toBe("rejected");
  expect(result.body.data.closedCount).toBe(0);
  expect(result.body.data.steps[0]).toMatchObject({
    periodId: "period-01",
    disposition: "rejected",
  });
  expect(result.body.data.steps[0].problems.length).toBeGreaterThan(0);
  expect(
    result.body.data.steps
      .slice(1)
      .every((s: { disposition: string }) => s.disposition === "skipped"),
  ).toBe(true);
  expect(result.body.data.diagnostics[0]).toContain("Closed 0 of 12 periods");
  expect(await closedIds(f)).toEqual([]);
  // A fresh review of the changed book works and closes the year.
  const fresh = (await prepareYearEnd(f, 2026)).plan;
  expect(fresh.valid).toBe(true);
  const done = await f.call("periods.commitYearEnd", commitInput(fresh), crypto.randomUUID());
  expect(done.body.data.disposition).toBe("committed");
  expect(await closedIds(f)).toEqual(allIds(2026, 2026));
});

test("a write that lands between two closes stops the run there; the closes already made stay", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  let calls = 0;
  f.service.ledger.execute = async (...args) => {
    calls += 1;
    if (calls === 4) {
      // Someone else posts while the year-end is running: the book moves, so the fourth close is stale.
      f.service.ledger.execute = execute;
      await f.postOk("2027-02-04", "2.00", ["5000", "1000"], "RACE");
    }
    return execute(...args);
  };
  const result = await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  f.service.ledger.execute = execute;
  expect(result.body.data).toMatchObject({
    disposition: "rejected",
    closedCount: 3,
    totalCount: 12,
  });
  expect(result.body.data.steps.map((s: { disposition: string }) => s.disposition)).toEqual([
    ...Array(3).fill("committed"),
    "rejected",
    ...Array(8).fill("skipped"),
  ]);
  expect(await closedIds(f)).toEqual(allIds(2026, 2026).slice(0, 3));
  // The next review sees the progress: three periods are already closed and are not closed again.
  const rest = (await prepareYearEnd(f, 2026)).plan;
  expect(rest).toMatchObject({ valid: true, openCount: 9, closedCount: 3 });
  expect(
    rest.steps.slice(0, 3).map((s: { status: string; plans: unknown }) => [s.status, s.plans]),
  ).toEqual([
    ["closed", []],
    ["closed", []],
    ["closed", []],
  ]);
  expect(rest.steps[3].plans[0].effects.periods[0].reason).toBe(
    "Year end FY2026, April: Reviewed with the accountant",
  );
  const finished = await f.call("periods.commitYearEnd", commitInput(rest), crypto.randomUUID());
  expect(finished.body.data).toMatchObject({
    disposition: "committed",
    closedCount: 9,
    totalCount: 9,
  });
  expect(await closedIds(f)).toEqual(allIds(2026, 2026));
});

test("an interruption while preparing leaves the retained closes alone and the retry reuses them", async () => {
  const f = await twoYears();
  const id = crypto.randomUUID();
  const original = f.service.retainAction.bind(f.service);
  let calls = 0;
  f.service.retainAction = async (...args) => {
    calls += 1;
    if (calls === 7) throw new Error("Storage unavailable");
    return original(...args);
  };
  const failed = await f.call("periods.yearEnd", { fiscalYear: 2026, reason: "R" }, id);
  expect(failed.status).toBe(503);
  f.service.retainAction = original;
  const read = () => {
    const db = new Database(f.path);
    try {
      return db
        .query("SELECT id, sealed_command FROM app_actions WHERE kind='closePeriod' ORDER BY id")
        .all() as { id: string; sealed_command: string }[];
    } finally {
      db.close();
    }
  };
  const retained = read();
  expect(retained).toHaveLength(6);
  const retry = await f.call("periods.yearEnd", { fiscalYear: 2026, reason: "R" }, id);
  expect(retry.status).toBe(200);
  expect(retry.body.data.valid).toBe(true);
  const after = read();
  expect(after).toHaveLength(12);
  // The six sealed before the failure are the very same bytes.
  for (const row of retained)
    expect(after.find((r) => r.id === row.id)?.sealed_command).toBe(row.sealed_command);
  const done = await f.call(
    "periods.commitYearEnd",
    commitInput(retry.body.data),
    crypto.randomUUID(),
  );
  expect(done.body.data).toMatchObject({ disposition: "committed", closedCount: 12 });
});

test("a year with some periods already closed plans only the open ones", async () => {
  const f = await twoYears();
  const march = await f.prepareCommit("periods.prepare", {
    periodId: "period-03",
    operation: "close",
    reason: "Quarter reviewed",
  });
  expect(march.receipt?.body.data.disposition).toBe("committed");
  const { plan } = await prepareYearEnd(f, 2026);
  expect(plan).toMatchObject({ valid: true, openCount: 11, closedCount: 1 });
  expect(plan.steps[2]).toMatchObject({ periodId: "period-03", status: "closed", plans: [] });
  expect(plan.steps[0].plans[0].effects.periods[0].reason).toBe(
    "Year end FY2026, January: Reviewed with the accountant",
  );
  expect(plan.steps[3].plans[0].effects.periods[0].reason).toBe(
    "Year end FY2026, April: Reviewed with the accountant",
  );
  const done = await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  expect(done.body.data).toMatchObject({
    closedCount: 11,
    totalCount: 11,
    disposition: "committed",
  });
  expect(done.body.data.steps).toHaveLength(11);
  expect(await closedIds(f)).toEqual(allIds(2026, 2026));
});

test("a year that is already closed, or not in the calendar, is refused with what to do", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  const closed = await f.call(
    "periods.yearEnd",
    { fiscalYear: 2026, reason: "Again" },
    crypto.randomUUID(),
  );
  expect(closed.status).toBe(409);
  expect(closed.body.error.code).toBe("year_already_closed");
  expect(closed.body.error.message).toContain("reopen a period");
  const beyond = await f.call(
    "periods.yearEnd",
    { fiscalYear: 2029, reason: "Soon" },
    crypto.randomUUID(),
  );
  expect(beyond.status).toBe(409);
  expect(beyond.body.error.code).toBe("calendar_not_configured");
  expect(beyond.body.error.message).toContain("Extend the calendar through fiscal year 2029");
  const before = await f.call(
    "periods.yearEnd",
    { fiscalYear: 2025, reason: "Old" },
    crypto.randomUUID(),
  );
  expect(before.body.error.code).toBe("calendar_not_configured");
  expect(before.body.error.message).toContain("before the book's first fiscal year, 2026");
  for (const input of [
    { fiscalYear: 2026, reason: "" },
    { fiscalYear: 2026, reason: "   " },
    { fiscalYear: 2026, reason: "x".repeat(401) },
    { fiscalYear: 1999, reason: "ok" },
    { fiscalYear: "2026", reason: "ok" },
    { reason: "ok" },
  ]) {
    const bad = await f.call("periods.yearEnd", input, crypto.randomUUID());
    expect(bad.status, JSON.stringify(input)).toBe(400);
  }
});

test("year-end plans and commits are authorised by close, and a commit needs the exact plan", async () => {
  const f = await twoYears();
  const denied = await f.call(
    "periods.yearEnd",
    { fiscalYear: 2026, reason: "R" },
    crypto.randomUUID(),
    ["read", "post", "configure"],
  );
  expect(denied.status).toBe(403);
  const { plan } = await prepareYearEnd(f, 2026);
  expect(
    (
      await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID(), [
        "read",
        "post",
      ])
    ).status,
  ).toBe(403);
  const wrongHash = await f.call(
    "periods.commitYearEnd",
    { planId: plan.planId, planHash: "0".repeat(64) },
    crypto.randomUUID(),
  );
  expect(wrongHash.status).toBe(409);
  expect(wrongHash.body.error.code).toBe("plan_hash_conflict");
  const unknown = await f.call(
    "periods.commitYearEnd",
    { planId: crypto.randomUUID(), planHash: plan.planHash },
    crypto.randomUUID(),
  );
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("year_end_plan_not_found");
  // An ordinary prepared close is not a year-end plan, even with a matching shape.
  const single = (
    await f.call(
      "periods.prepare",
      { periodId: "period-01", operation: "close", reason: "One" },
      crypto.randomUUID(),
    )
  ).body.data;
  const notYearEnd = await f.call(
    "periods.commitYearEnd",
    { planId: single.planId, planHash: single.planHash },
    crypto.randomUUID(),
  );
  expect(notYearEnd.body.error.code).toBe("year_end_plan_not_found");
  expect(await closedIds(f)).toEqual([]);
});

test("each step stays individually committable under its own hash through operations.commit", async () => {
  const f = await twoYears();
  const { plan } = await prepareYearEnd(f, 2026);
  const first = plan.steps[0].plans[0];
  const second = plan.steps[1].plans[0];
  // Out of order is allowed to be tried and is refused by the kernel: the second close was sealed
  // against the book after the first.
  const outOfOrder = await f.call("operations.commit", {
    planId: second.planId,
    planHash: second.planHash,
  });
  expect(outOfOrder.body.data.disposition).toBe("rejected");
  const ok = await f.call("operations.commit", { planId: first.planId, planHash: first.planHash });
  expect(ok.body.data.disposition).toBe("committed");
  expect(await closedIds(f)).toEqual(["period-01"]);
  expect(
    (await f.call("operations.commit", { planId: first.planId, planHash: "1".repeat(64) })).body
      .error.code,
  ).toBe("plan_hash_conflict");
});

test("a book with no postings closes its year, and the statements are zero", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2027, 0, 5),
  });
  await f.setup();
  const { plan } = await prepareYearEnd(f, 2026, "Nothing happened");
  expect(plan.valid).toBe(true);
  expect(plan.statements).toMatchObject({
    debit: "0.00",
    credit: "0.00",
    netIncome: "0.00",
    assets: "0.00",
  });
  const done = await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  expect(done.body.data).toMatchObject({ disposition: "committed", closedCount: 12 });
});

test("quarterly and October books close their own years, four and twelve steps", async () => {
  const quarterly = await twoYears({ ...baseSetup, periodModel: "quarterly" });
  const q = (await prepareYearEnd(quarterly, 2026)).plan;
  expect(q.steps.map((s: { periodId: string; label: string }) => [s.periodId, s.label])).toEqual([
    ["period-01", "Q1"],
    ["period-02", "Q2"],
    ["period-03", "Q3"],
    ["period-04", "Q4"],
  ]);
  expect(q.steps[0].plans[0].effects.periods[0].reason).toBe(
    "Year end FY2026, Q1: Reviewed with the accountant",
  );
  await quarterly.call("periods.commitYearEnd", commitInput(q), crypto.randomUUID());
  expect(await closedIds(quarterly)).toEqual(["period-01", "period-02", "period-03", "period-04"]);

  const october = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2027, 10, 15),
  });
  await october.setup({ ...baseSetup, fiscalYearStartMonth: 10 });
  await october.postOk("2026-10-05", "700.00", ["1000", "3000"]);
  await october.postOk("2027-01-20", "90.00", ["1000", "4000"]);
  await october.postOk("2027-09-30", "10.00", ["5000", "1000"]);
  const o = (await prepareYearEnd(october, 2026)).plan;
  expect(o).toMatchObject({ startsOn: "2026-10-01", endsOn: "2027-09-30", openCount: 12 });
  expect(o.statements).toMatchObject({
    periodStart: "2026-10-01",
    asOf: "2027-09-30",
    revenue: "90.00",
    expenses: "10.00",
    netIncome: "80.00",
  });
  expect(o.steps[0]).toMatchObject({ label: "October", startsOn: "2026-10-01" });
  expect(o.steps[3]).toMatchObject({ label: "January", startsOn: "2027-01-01" });
  const done = await october.call("periods.commitYearEnd", commitInput(o), crypto.randomUUID());
  expect(done.body.data.disposition).toBe("committed");
  expect((await october.periods()).calendar.fiscalYears[0]).toMatchObject({
    fiscalYear: 2026,
    status: "closed",
    ended: true,
  });
});

test("closing out of order or before a period ends is allowed and warned about", async () => {
  const f = await twoYears();
  const out = (
    await f.call(
      "periods.prepare",
      { periodId: "period-03", operation: "close", reason: "Skipping ahead" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(out.valid).toBe(true);
  const codes = out.warnings.map((w: { code: string }) => w.code);
  expect(codes).toContain("earlier_period_open");
  expect(
    out.warnings.find((w: { code: string }) => w.code === "earlier_period_open").message,
  ).toContain("2 earlier periods are still open or need closing again, the oldest January 2026");
  expect(codes).not.toContain("period_not_ended");
  // February 2027 is the current month: closing it now stops postings dated in it.
  const future = (
    await f.call(
      "periods.prepare",
      { periodId: "period-2027-02", operation: "close", reason: "Too early" },
      crypto.randomUUID(),
    )
  ).body.data;
  const notEnded = future.warnings.find((w: { code: string }) => w.code === "period_not_ended");
  expect(notEnded.message).toContain("February 2027");
  expect(notEnded.message).toContain("today is 2027-02-10");
  // January 2026 is first and has ended: no warning at all.
  const clean = (
    await f.call(
      "periods.prepare",
      { periodId: "period-01", operation: "close", reason: "On time" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(clean.warnings ?? []).toEqual([]);
});

test("reopening a period supersedes the later closes, keeps those periods locked, and the year-end closes them again", async () => {
  const f = await twoYears();
  // Close fiscal year 2026, then close the period of 2027 that has ended (January) on its own.
  const y26 = (await prepareYearEnd(f, 2026)).plan;
  await f.call("periods.commitYearEnd", commitInput(y26), crypto.randomUUID());
  const january27 = await f.prepareCommit("periods.prepare", {
    periodId: "period-2027-01",
    operation: "close",
    reason: "January 2027 reviewed",
  });
  expect(january27.receipt?.body.data.disposition).toBe("committed");
  const list = await f.periods();
  const byId = Object.fromEntries(list.periods.map((p: { id: string }) => [p.id, p]));
  // Reopening a closed period would supersede the close of every closed period that ends on or after it.
  expect(byId["period-01"].supersedes).toEqual([...allIds(2026, 2026).slice(1), "period-2027-01"]);
  expect(byId["period-12"].supersedes).toEqual(["period-2027-01"]);
  expect(byId["period-2027-01"].supersedes).toEqual([]);
  expect(byId["period-2027-02"].supersedes).toEqual([]);
  // The first release's name for the same list stays, because the contract is frozen.
  expect(byId["period-12"].alsoReopens).toEqual(byId["period-12"].supersedes);

  const plan = (
    await f.call(
      "periods.prepare",
      { periodId: "period-12", operation: "reopen", reason: "Late invoice for December" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(plan.valid).toBe(true);
  expect(plan.effects.periods).toHaveLength(1);
  expect(plan.effects.periods[0]).toMatchObject({
    periodId: "period-12",
    kind: "reopen",
    supersededPeriodIds: ["period-2027-01"],
  });
  const warning = plan.warnings.find(
    (w: { code: string }) => w.code === "reopen_supersedes_closes",
  );
  expect(warning.message).toContain(
    "Reopening December 2026 supersedes the close of 1 later closed period: January 2027",
  );
  expect(warning.message).toContain("It stays locked");
  expect(warning.message).toContain("close it again afterwards");

  const done = await f.call("operations.commit", { planId: plan.planId, planHash: plan.planHash });
  expect(done.body.data.disposition).toBe("committed");
  // December is open. January 2027 is still locked by the kernel, but its close is no longer current.
  const after = await f.periods();
  const status = Object.fromEntries(
    after.periods.map((p: { id: string; status: string; closeSuperseded: boolean }) => [
      p.id,
      [p.status, p.closeSuperseded],
    ]),
  );
  expect(status["period-12"]).toEqual(["open", false]);
  expect(status["period-11"]).toEqual(["closed", false]);
  expect(status["period-2027-01"]).toEqual(["closed", true]);
  const january = after.periods.find((p: { id: string }) => p.id === "period-2027-01");
  expect(january).toMatchObject({
    closePackageId: null,
    reportPopulationHash: null,
    closingRevision: null,
    supersedes: [],
  });
  expect(after.calendar.fiscalYears).toMatchObject([
    { fiscalYear: 2026, status: "partlyClosed", closedCount: 11, supersededCount: 0 },
    { fiscalYear: 2027, status: "partlyClosed", closedCount: 0, supersededCount: 1 },
  ]);
  expect(after.history[0]).toMatchObject({
    periodId: "period-12",
    kind: "reopen",
    reason: "Late invoice for December",
    supersededPeriodIds: ["period-2027-01"],
  });
  expect(after.history[0].supersededCloseIds).toHaveLength(2);
  // The kernel still refuses a posting into the superseded period, and a close of it.
  const locked = await f.post("2027-01-20", "3.00");
  expect(locked.plan.data.valid).toBe(false);
  expect(locked.plan.data.problems[0].message).toContain("is closed");
  const closeAgain = (
    await f.call(
      "periods.prepare",
      { periodId: "period-2027-01", operation: "close", reason: "Again" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(closeAgain.valid).toBe(false);
  expect(
    closeAgain.warnings.find((w: { code: string }) => w.code === "close_superseded_period").message,
  ).toContain("Reopen it, then close it, or run the year-end");

  // December takes its correction, and the year closes again.
  await f.postOk("2026-12-18", "75.00", ["5000", "1000"], "LATE-INV");
  const again = (await prepareYearEnd(f, 2026, "December corrected")).plan;
  expect(again).toMatchObject({ valid: true, openCount: 1, closedCount: 11, supersededCount: 0 });
  const closedAgain = await f.call(
    "periods.commitYearEnd",
    commitInput(again),
    crypto.randomUUID(),
  );
  expect(closedAgain.body.data.disposition).toBe("committed");
  expect(await closedIds(f)).toEqual([...allIds(2026, 2026), "period-2027-01"]);
  expect(
    (await f.call("reports.get", { asOf: "2026-12-31" })).body.data.profitAndLoss.netIncome,
  ).toBe("605.00");

  // Fiscal year 2027 still has the superseded January: its year-end reopens it, then closes every
  // period, in order, as ordinary commands each with its own plan.
  const y27 = (await prepareYearEnd(f, 2027)).plan;
  expect(y27).toMatchObject({ valid: true, openCount: 12, supersededCount: 1, closedCount: 0 });
  expect(y27.checks.find((c: { id: string }) => c.id === "closes-current")).toMatchObject({
    status: "attention",
  });
  expect(y27.steps[0]).toMatchObject({
    periodId: "period-2027-01",
    status: "closed",
    closeSuperseded: true,
  });
  expect(y27.steps[0].plans.map((p: { kind: string }) => p.kind)).toEqual([
    "reopenPeriod",
    "closePeriod",
  ]);
  expect(y27.steps[0].plans[0].effects.periods[0].reason).toBe(
    "Reopened to close again, year end FY2027, January: Reviewed with the accountant",
  );
  expect(y27.steps[1].plans.map((p: { kind: string }) => p.kind)).toEqual(["closePeriod"]);
  // Each command is sealed against the book the one before leaves.
  const revisions = y27.steps
    .flatMap((s: { plans: { bookRevision: string }[] }) => s.plans)
    .map((p: { bookRevision: string }) => Number(p.bookRevision));
  expect(revisions).toEqual(revisions.map((_: number, i: number) => revisions[0] + i));
  const done27 = await f.call("periods.commitYearEnd", commitInput(y27), crypto.randomUUID());
  expect(done27.body.data).toMatchObject({
    disposition: "committed",
    closedCount: 12,
    totalCount: 12,
  });
  expect(done27.body.data.steps).toHaveLength(13);
  expect(done27.body.data.steps[0]).toMatchObject({
    periodId: "period-2027-01",
    kind: "reopenPeriod",
  });
  expect(done27.body.data.steps[1]).toMatchObject({
    periodId: "period-2027-01",
    kind: "closePeriod",
  });
  const final = await f.periods();
  expect(
    final.periods.every(
      (p: { id: string; status: string; closeSuperseded: boolean }) =>
        (p.status === "closed" && !p.closeSuperseded) ||
        !(p.id.startsWith("period-2027") || /^period-\d\d$/.test(p.id)),
    ),
  ).toBe(true);
  expect(final.calendar.fiscalYears.map((y: { status: string }) => y.status)).toEqual([
    "closed",
    "closed",
  ]);
});

test("reopening the first period of a closed two-year book supersedes everything after it; the year-ends close it all again", async () => {
  const f = await twoYears();
  const y26 = (await prepareYearEnd(f, 2026)).plan;
  await f.call("periods.commitYearEnd", commitInput(y26), crypto.randomUUID());
  const y27 = (await prepareYearEnd(f, 2027)).plan;
  expect(y27.checks.find((c: { id: string }) => c.id === "earlier-years").status).toBe("pass");
  await f.call("periods.commitYearEnd", commitInput(y27), crypto.randomUUID());
  expect(await closedIds(f)).toHaveLength(24);
  const reopen = await f.prepareCommit("periods.prepare", {
    periodId: "period-01",
    operation: "reopen",
    reason: "Restated January",
  });
  expect(reopen.plan.body.data.effects.periods[0].supersededPeriodIds).toHaveLength(23);
  expect(reopen.receipt?.body.data.disposition).toBe("committed");
  // Only January is open; the other 23 stay locked with a superseded close.
  const list = await f.periods();
  expect(list.periods.filter((p: { status: string }) => p.status === "open")).toHaveLength(1);
  expect(list.periods.filter((p: { closeSuperseded: boolean }) => p.closeSuperseded)).toHaveLength(
    23,
  );
  expect(list.calendar.fiscalYears).toMatchObject([
    { fiscalYear: 2026, status: "partlyClosed", closedCount: 0, supersededCount: 11 },
    { fiscalYear: 2027, status: "partlyClosed", closedCount: 0, supersededCount: 12 },
  ]);
  // Two years of closes are superseded but still in the history.
  expect(list.history).toHaveLength(25);
  expect((await f.service.readAggregate()).aggregate.state.closePackages).toHaveLength(24);
  const locked = await f.post("2026-02-10", "5.00");
  expect(locked.plan.data.valid).toBe(false);
  // The correction goes into January; then 2026 is brought back to a current close, 2027 after it.
  await f.postOk("2026-01-20", "12.00", ["5000", "1000"], "RESTATE");
  const again26 = (await prepareYearEnd(f, 2026, "Restated January")).plan;
  expect(again26).toMatchObject({ valid: true, openCount: 12, supersededCount: 11 });
  expect(
    again26.steps.map((s: { plans: { kind: string }[] }) => s.plans.map((p) => p.kind).join("+")),
  ).toEqual(["closePeriod", ...Array(11).fill("reopenPeriod+closePeriod")]);
  const done26 = await f.call("periods.commitYearEnd", commitInput(again26), crypto.randomUUID());
  expect(done26.body.data).toMatchObject({
    disposition: "committed",
    closedCount: 12,
    totalCount: 12,
  });
  expect(done26.body.data.steps).toHaveLength(23);
  const again27 = (await prepareYearEnd(f, 2027, "Restated January")).plan;
  expect(again27).toMatchObject({ valid: true, openCount: 12, supersededCount: 12 });
  const done27 = await f.call("periods.commitYearEnd", commitInput(again27), crypto.randomUUID());
  expect(done27.body.data).toMatchObject({ disposition: "committed", closedCount: 12 });
  const final = await f.periods();
  expect(final.calendar.fiscalYears.map((y: { status: string }) => y.status)).toEqual([
    "closed",
    "closed",
  ]);
  expect(final.periods.every((p: { closeSuperseded: boolean }) => !p.closeSuperseded)).toBe(true);
  // Every period closed twice or once more: 24 closes made, 23 superseded closes' worth of reopenings.
  expect((await f.service.readAggregate()).aggregate.state.closePackages).toHaveLength(24 + 24);
});

test("the review reads the year's checklist and statements without preparing or retaining anything", async () => {
  const f = await twoYears();
  const actions = () => {
    const db = new Database(f.path);
    try {
      return (db.query("SELECT COUNT(*) AS n FROM app_actions").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  const before = actions();
  const review = await f.call("periods.yearEndReview", { fiscalYear: 2026 });
  expect(review.status).toBe(200);
  expect(review.body.operationId).toBeUndefined();
  expect(review.body.data).toMatchObject({
    fiscalYear: 2026,
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
    today: "2027-02-10",
    openCount: 12,
    closedCount: 0,
  });
  expect(review.body.data.periods).toHaveLength(12);
  expect(review.body.data.periods[0]).toEqual({
    order: 1,
    periodId: "period-01",
    label: "January",
    startsOn: "2026-01-01",
    endsOn: "2026-01-31",
    status: "open",
    closeSuperseded: false,
    ended: true,
    beforeBooks: false,
  });
  expect(actions()).toBe(before);
  // It is the same checklist and statements the prepared plan carries.
  const { plan } = await prepareYearEnd(f, 2026);
  expect(review.body.data.checks).toEqual(plan.checks);
  expect(review.body.data.statements).toEqual(plan.statements);
  // A repeat answers the same, and a read permission is enough.
  expect(await f.call("periods.yearEndReview", { fiscalYear: 2026 })).toEqual(review);
  expect(
    (await f.call("periods.yearEndReview", { fiscalYear: 2026 }, undefined, ["read"])).status,
  ).toBe(200);
  // A year outside the calendar is a plain, actionable error.
  const beyond = await f.call("periods.yearEndReview", { fiscalYear: 2031 });
  expect(beyond.status).toBe(409);
  expect(beyond.body.error.code).toBe("calendar_not_configured");
  expect((await f.call("periods.yearEndReview", { fiscalYear: 1999 })).status).toBe(400);
  // After the year is closed the review still reads, and says nothing is left to close.
  await f.call("periods.commitYearEnd", commitInput(plan), crypto.randomUUID());
  const closed = await f.call("periods.yearEndReview", { fiscalYear: 2026 });
  expect(closed.body.data).toMatchObject({ openCount: 0, closedCount: 12 });
  expect(closed.body.data.periods.every((p: { status: string }) => p.status === "closed")).toBe(
    true,
  );
});

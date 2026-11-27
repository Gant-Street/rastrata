import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuid, world } from "../stripe/slice-support.ts";
import { closeShadowFixtures, shadowFixture, type Json, type ShadowFixture } from "./support.ts";

afterEach(closeShadowFixtures);

const codes = (list: { code: string }[]) => list.map((item) => item.code);
const row = (checklist: { accounts: { code: string }[] }, code: string): Json =>
  checklist.accounts.find((account) => account.code === code);

/** A book that cut over on 2026-10-01 with a checking account, a card and some equipment, and has
 * an October's worth of entries that are not yet reconciled to anything. */
async function cutOver(f: ShadowFixture) {
  await f.ok("cutover.set", { cutoverDate: "2026-10-01", accountIds: ["1000", "2000"] });
  const plan = await f.ok("opening.plan", {
    cutoverDate: "2026-10-01",
    balances: [
      { accountId: "1000", balance: "10000.00" },
      { accountId: "2000", balance: "500.00" },
      { accountId: "1500", balance: "2000.00" },
    ],
  });
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  await f.post("2026-10-05", "Customer payment", [
    ["1000", "1000.00", ""],
    ["4000", "", "1000.00"],
  ]);
  await f.post("2026-10-12", "Hosting", [
    ["6000", "250.00", ""],
    ["1000", "", "250.00"],
  ]);
  await f.post("2026-10-20", "Domain", [
    ["6000", "49.99", ""],
    ["1000", "", "49.99"],
  ]);
  await f.post("2026-10-10", "Software on the card", [
    ["6000", "80.00", ""],
    ["2000", "", "80.00"],
  ]);
}

test("a month with nothing reconciled and no backup is not ready, and every reason is there", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.asOf).toBe("2026-11-05");
  expect(checklist.cutover).toEqual({ date: "2026-10-01", basis: "recorded" });
  expect(checklist.opening.status).toBe("posted");
  // The periods before the cutover are skipped: the one to close is October.
  expect(checklist.period).toMatchObject({
    label: "October 2026",
    startsOn: "2026-10-01",
    endsOn: "2026-10-31",
    status: "open",
    ended: true,
  });
  expect(checklist.verdict.state).toBe("not_yet");
  expect(codes(checklist.verdict.blocking)).toEqual(
    expect.arrayContaining(["never_reconciled", "no_verified_backup"]),
  );
  expect(checklist.verdict.summary).toMatch(
    /^Not yet: \d+ things stand in the way of closing October 2026\.$/,
  );
  const checking = row(checklist, "1000");
  expect(checking).toMatchObject({
    kind: "bank",
    status: "blocked",
    hasActivity: true,
    lastReconciliation: null,
    throughPeriodEnd: false,
    bookBalance: "10700.01",
  });
  // The card is in statement orientation: what is owed.
  expect(row(checklist, "2000")).toMatchObject({ kind: "card", bookBalance: "580.00" });
  // The oldest is the opening entry, dated the day before the cutover.
  expect(checking.uncleared).toMatchObject({ count: 4, oldestOn: "2026-09-30" });
  // Equipment has a balance and nothing tracks it: it is listed so it is not forgotten.
  expect(checklist.otherAccounts.map((a: { code: string }) => a.code)).toEqual(["1500"]);
  // Savings and Stripe have nothing in them: listed, and they do not block.
  expect(row(checklist, "1010")).toMatchObject({ status: "no_activity", hasActivity: false });
  expect(checklist.backups).toMatchObject({ available: true, verifiedAt: null });
  expect(checklist.unavailable).toEqual([]);
  expect(checklist.shadowRun).toMatchObject({ required: 2, provenCount: 0, complete: false });
});

test("Inbox lines waiting and a draft reconciliation are shown against their account", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  await f.importLines("1000", [
    { date: "2026-09-20", amount: "-5.00", description: "Before the cutover" },
    { date: "2026-10-25", amount: "-12.00", description: "Unmatched one" },
    { date: "2026-10-28", amount: "-13.00", description: "Unmatched two" },
    { date: "2026-11-03", amount: "-14.00", description: "November line" },
  ]);
  const draft = await f.ok("reconcile.start", {
    accountId: "1000",
    statementDate: "2026-10-31",
    statementBalance: "10700.01",
  });
  const checklist = await f.ok("cutover.checklist", {});
  const checking = row(checklist, "1000");
  // Lines dated through October 31 that are waiting; the September one is set aside and the
  // November one is not this month's.
  expect(checking.unreconciled).toEqual({ count: 2, oldestOn: "2026-10-25" });
  expect(checking.draft).toMatchObject({
    id: draft.id,
    statementDate: "2026-10-31",
    statementBalance: "10700.01",
  });
  expect(checking.draft.difference).not.toBe("0.00");
  expect(checklist.inbox).toMatchObject({
    available: true,
    waiting: 2,
    oldestOn: "2026-10-25",
    toReview: 3,
  });
  expect(
    checklist.verdict.blocking.filter((r: { code: string }) => r.code === "inbox_waiting"),
  ).toHaveLength(1);
  const reason = checking.reasons.find((r: { code: string }) => r.code === "never_reconciled");
  expect(reason.message).toContain("A draft for 2026-10-31 is open with a difference of");
});

test("reconciled to the statements, nothing waiting and a verified backup: ready, and the month closes", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  await f.reconcile("1000", "2026-10-31", "10700.01");
  await f.reconcile("2000", "2026-10-31", "580.00");
  await f.backUp();
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.verdict.state).toBe("ready");
  expect(checklist.verdict.summary).toBe("Ready to close October 2026. 1 thing to look at first.");
  expect(codes(checklist.verdict.attention)).toEqual(["drill_never_run"]);
  expect(row(checklist, "1000")).toMatchObject({
    status: "ready",
    throughPeriodEnd: true,
    lastReconciliation: { date: "2026-10-31", balance: "10700.01", closedAtZero: true },
  });
  expect(row(checklist, "2000").lastReconciliation).toMatchObject({
    date: "2026-10-31",
    balance: "580.00",
  });
  expect(checklist.backups.verifiedAt).not.toBeNull();
  expect(checklist.backups.ageHours).toBe(0);
  // Close it and the checklist moves on to November, which has not ended yet.
  const close = await f.ok("periods.prepare", {
    periodId: "period-10",
    operation: "close",
    reason: "Reconciled",
  });
  await f.ok("operations.commit", { planId: close.planId, planHash: close.planHash }, close.planId);
  const next = await f.ok("cutover.checklist", {});
  expect(next.period).toMatchObject({ label: "November 2026", ended: false });
  expect(next.verdict.state).toBe("not_yet");
  expect(codes(next.verdict.blocking)).toEqual(["period_not_ended"]);
  expect(next.shadowRun).toMatchObject({
    provenCount: 1,
    provenThrough: "2026-10-31",
    complete: false,
  });
  expect(
    next.shadowRun.months.map((m: { label: string; closed: boolean; proven: boolean }) => [
      m.label,
      m.closed,
      m.proven,
    ]),
  ).toEqual([["October 2026", true, true]]);
});

test("two month ends closed and reconciled complete the shadow run", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  await f.reconcile("1000", "2026-10-31", "10700.01");
  await f.reconcile("2000", "2026-10-31", "580.00");
  await f.backUp();
  const october = await f.ok("periods.prepare", {
    periodId: "period-10",
    operation: "close",
    reason: "Reconciled",
  });
  await f.ok(
    "operations.commit",
    { planId: october.planId, planHash: october.planHash },
    october.planId,
  );
  // November: one more entry, then the month ends and its statements arrive.
  await f.post("2026-11-09", "Hosting", [
    ["6000", "250.00", ""],
    ["1000", "", "250.00"],
  ]);
  f.today("2026-12-03");
  const before = await f.ok("cutover.checklist", {});
  expect(before.period.label).toBe("November 2026");
  expect(row(before, "1000").reasons[0]).toMatchObject({ code: "not_through_period" });
  expect(row(before, "1000").reasons[0].message).toContain("reconciled through 2026-10-31");
  // The card had no November activity but is still reconciled through its last statement.
  await f.reconcile("1000", "2026-11-30", "10450.01");
  await f.reconcile("2000", "2026-11-30", "580.00");
  await f.backUp();
  const ready = await f.ok("cutover.checklist", {});
  expect(ready.verdict.state).toBe("ready");
  const november = await f.ok("periods.prepare", {
    periodId: "period-11",
    operation: "close",
    reason: "Reconciled",
  });
  await f.ok(
    "operations.commit",
    { planId: november.planId, planHash: november.planHash },
    november.planId,
  );
  const done = await f.ok("cutover.checklist", {});
  expect(done.shadowRun).toMatchObject({
    provenCount: 2,
    provenThrough: "2026-11-30",
    complete: true,
  });
  expect(done.period).toMatchObject({ label: "December 2026" });
});

test("a posting that is not on the statement is shown as a note and does not block", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  // A check written on October 28 that the bank has not cashed: reconcile without it.
  await f.post("2026-10-28", "Check 1042", [
    ["6000", "40.00", ""],
    ["1000", "", "40.00"],
  ]);
  const draft = await f.ok("reconcile.start", {
    accountId: "1000",
    statementDate: "2026-10-31",
    statementBalance: "10700.01",
  });
  const lines = draft.lines
    .filter((l: { narration: string }) => !l.narration.includes("Check 1042"))
    .map((l: { postingId: string }) => l.postingId);
  const selected = await f.ok("reconcile.setCleared", {
    id: draft.id,
    expectedVersion: draft.version,
    reset: "none",
    select: lines,
  });
  await f.ok("reconcile.complete", { id: draft.id, expectedVersion: selected.version });
  await f.reconcile("2000", "2026-10-31", "580.00");
  await f.backUp();
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.verdict.state).toBe("ready");
  expect(codes(checklist.verdict.attention)).toContain("uncleared_before_statement");
  expect(row(checklist, "1000")).toMatchObject({
    status: "attention",
    uncleared: { count: 1, total: "-40.00", oldestOn: "2026-10-28" },
  });
});

test("a book that has not connected Stripe has no Stripe section, and its Stripe accounts are not rows", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.stripe).toBeNull();
  // The Stripe balance and payouts in transit have no statement: Stripe's own balance is the check.
  expect(row(checklist, "1100")).toBeUndefined();
  expect(row(checklist, "1110")).toBeUndefined();
  expect(checklist.otherAccounts.map((a: { code: string }) => a.code)).toEqual(["1500"]);
});

test("Stripe is checked against its own balance, and a difference blocks the month", async () => {
  const w = await world({ realPort: true });
  try {
    await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
    const sync = await w.call("stripe.sync", {}, uuid());
    expect(sync.body.data.more).toBe(false);
    const tied = (await w.call("cutover.checklist")).body.data;
    expect(tied.stripe).toMatchObject({
      compared: true,
      ties: true,
      difference: "0.00",
      unpaid: "19.12",
      stale: false,
    });
    expect(tied.stripe.payouts).toMatchObject({ known: 6, booked: 6, mismatched: 0 });
    expect(tied.stripe.reasons.map((r: { code: string }) => r.code)).not.toContain(
      "stripe_differs",
    );
    // The Stripe accounts are not rows of the account table.
    expect(tied.accounts.map((a: { code: string }) => a.code)).not.toContain("1100");
    // Stripe now holds 5.00 more than Rastrata has imported: that is a block, with the amount.
    w.stripe.intercept((request) =>
      request.path === "/v1/balance"
        ? Response.json({
            object: "balance",
            available: [{ amount: 2412, currency: "usd", source_types: { card: 2412 } }],
            livemode: true,
            pending: [{ amount: 0, currency: "usd", source_types: { card: 0 } }],
          })
        : undefined,
    );
    await w.call("stripe.sync", {}, uuid());
    const differs = (await w.call("cutover.checklist")).body.data;
    expect(differs.stripe).toMatchObject({
      compared: true,
      ties: false,
      difference: "5.00",
      status: "blocked",
    });
    const reason = differs.verdict.blocking.find(
      (r: { code: string }) => r.code === "stripe_differs",
    );
    expect(reason.section).toBe("stripe");
    expect(reason.message).toContain("Stripe holds 5.00 that has not been imported.");
  } finally {
    w.close();
  }
});

test("a business with Stripe connected and never synced is not ready: the control has not run", async () => {
  const w = await world({ realPort: true });
  try {
    await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
    const checklist = (await w.call("cutover.checklist")).body.data;
    expect(checklist.stripe).toMatchObject({ compared: false, ties: false, status: "blocked" });
    expect(checklist.verdict.blocking.map((r: { code: string }) => r.code)).toContain(
      "stripe_not_compared",
    );
  } finally {
    w.close();
  }
});

test("a runtime without backups is reported, and the verdict stays at not yet", async () => {
  const f = await shadowFixture({ today: "2026-11-05", open: { safety: false } });
  await cutOver(f);
  await f.reconcile("1000", "2026-10-31", "10700.01");
  await f.reconcile("2000", "2026-10-31", "580.00");
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.backups.available).toBe(false);
  expect(checklist.backups.reason).toContain("cannot make backups");
  expect(checklist.verdict.state).toBe("not_yet");
  expect(codes(checklist.verdict.blocking)).toEqual(["backups_unavailable"]);
});

test("a service that keeps the history of the books itself has no backup to verify, and that does not hold a month up: the month is ready, and the section says why", async () => {
  // A hosted pod: it can export and has no safety host.
  const exports = join(mkdtempSync(join(tmpdir(), "rastrata-checklist-kept-")), "exports");
  const f = await shadowFixture({
    today: "2026-11-05",
    open: { safety: false, exports: { directory: exports } },
  });
  await cutOver(f);
  await f.reconcile("1000", "2026-10-31", "10700.01");
  await f.reconcile("2000", "2026-10-31", "580.00");
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.backups).toMatchObject({
    available: false,
    keptByService: true,
    verifiedAt: null,
    drill: null,
  });
  expect(checklist.backups.reason).toBeUndefined();
  expect(checklist.verdict.state).toBe("ready");
  expect(codes(checklist.verdict.blocking)).toEqual([]);
  // Nothing about backups is a thing to look at either: there is none to run.
  expect(codes(checklist.verdict.attention)).toEqual([]);
  // A runtime that can neither back up nor export is not that: it is reported, and the verdict stays at not yet.
  const neither = await shadowFixture({ today: "2026-11-05", open: { safety: false } });
  await cutOver(neither);
  await neither.reconcile("1000", "2026-10-31", "10700.01");
  await neither.reconcile("2000", "2026-10-31", "580.00");
  const unread = await neither.ok("cutover.checklist", {});
  expect(unread.backups.keptByService).toBeUndefined();
  expect(codes(unread.verdict.blocking)).toEqual(["backups_unavailable"]);
  // And a runtime that does both makes backups, which a person is asked to verify before a month closes.
  const both = await shadowFixture({
    today: "2026-11-05",
    open: {
      exports: {
        directory: join(mkdtempSync(join(tmpdir(), "rastrata-checklist-both-")), "exports"),
      },
    },
  });
  await cutOver(both);
  await both.reconcile("1000", "2026-10-31", "10700.01");
  await both.reconcile("2000", "2026-10-31", "580.00");
  const asked = await both.ok("cutover.checklist", {});
  expect(asked.backups.keptByService).toBeUndefined();
  expect(asked.backups.available).toBe(true);
  expect(codes(asked.verdict.blocking)).toEqual(["no_verified_backup"]);
});

test("a period can be asked for, and one that is not in the calendar is a 404", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  const asked = await f.ok("cutover.checklist", { periodId: "period-11" });
  expect(asked.period.label).toBe("November 2026");
  const missing = await f.call("cutover.checklist", { periodId: "period-99" });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("period_not_found");
});

test("a new book with no cutover is checked from its first period", async () => {
  const f = await shadowFixture({ today: "2026-03-05" });
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.cutover).toBeNull();
  expect(checklist.shadowRun).toBeNull();
  // Nothing has been posted: the one book that is offered the move from another system.
  expect(checklist.hasHistory).toBe(false);
  expect(checklist.period.label).toBe("January 2026");
  // The accounts a statement would describe are listed; none has anything in it.
  expect(
    checklist.accounts.map((a: { code: string; status: string }) => [a.code, a.status]),
  ).toEqual([
    ["1000", "no_activity"],
    ["1010", "no_activity"],
  ]);
  // Nothing has happened, so the only thing in the way is that the books have not been backed up.
  expect(codes(checklist.verdict.blocking)).toEqual(["no_verified_backup"]);
});

test("a book with a posted journal has history, whether or not a cutover is recorded", async () => {
  const f = await shadowFixture({ today: "2026-03-05" });
  await f.post("2026-02-10", "Customer payment", [
    ["1000", "100.00", ""],
    ["4000", "", "100.00"],
  ]);
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.cutover).toBeNull();
  expect(checklist.opening).toEqual({ status: "none" });
  expect(checklist.hasHistory).toBe(true);
  // A draft is not history: it has not been posted.
  const drafts = await shadowFixture({ today: "2026-03-05" });
  await drafts.ok("drafts.create", {
    data: {
      date: "2026-02-10",
      reference: "DRAFT",
      narration: "Not posted",
      lines: [
        { accountId: "1000", debit: "5.00", credit: "" },
        { accountId: "4000", debit: "", credit: "5.00" },
      ],
    },
  });
  expect((await drafts.ok("cutover.checklist", {})).hasHistory).toBe(false);
});

test("reading the checklist changes nothing in the books", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await cutOver(f);
  const head = (await f.ok("book.get", {})).head;
  const drafts = (await f.ok("drafts.list", {})).count;
  await f.ok("cutover.checklist", {});
  await f.ok("cutover.checklist", { periodId: "period-10" });
  expect((await f.ok("book.get", {})).head).toEqual(head);
  expect((await f.ok("drafts.list", {})).count).toBe(drafts);
  // Read permission is enough.
  const read = await f.call("cutover.checklist", {}, undefined, ["read"]);
  expect(read.status).toBe(200);
  expect((await f.call("cutover.checklist", {}, undefined, [])).status).toBe(403);
});

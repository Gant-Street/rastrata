/** Where the opening entry is dated, and what counts as one: the opening tools date it the day
 * before the cutover when the calendar allows, and opening balances entered by hand (the tutorial's
 * way) count as the opening entry too. */
import { afterEach, expect, test } from "bun:test";
import { closeShadowFixtures, shadowFixture, type ShadowFixture } from "./support.ts";

afterEach(closeShadowFixtures);

const BALANCES = [
  { accountId: "1000", balance: "12000.00" },
  { accountId: "1010", balance: "2500.25" },
  { accountId: "2000", balance: "523.10" },
];
const codes = (review: { issues: { code: string }[] }) => review.issues.map((issue) => issue.code);

/** Prepare an operation and commit it, as the screens do. */
async function prepareAndCommit(f: ShadowFixture, name: string, input: unknown): Promise<void> {
  const id = crypto.randomUUID();
  const prepared = await f.call(name, input, id);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const done = await f.call("operations.commit", {
    planId: id,
    planHash: prepared.body.data.planHash,
  });
  expect(done.body.data.disposition, JSON.stringify(done.body)).toBe("committed");
}

/** The hand-made opening entry of the tutorial: one ordinary journal against the equity account
 * named for opening balances. */
const handMade = (f: ShadowFixture, date: string) =>
  f.post(date, "Opening balances", [
    ["1000", "12000.00", ""],
    ["1010", "2500.25", ""],
    ["2000", "", "523.10"],
    ["3900", "", "13977.15"],
  ]);

test("the entry is dated the day before the cutover, and the first day of the calendar has no day before", async () => {
  const f = await shadowFixture();
  const day = async (cutoverDate: string) =>
    (await f.ok("opening.review", { cutoverDate, balances: BALANCES })).entryDate;
  expect(await day("2026-03-01")).toBe("2026-02-28");
  // A cutover in the middle of a month is the same: the balances are those at the start of the day.
  expect(await day("2026-03-15")).toBe("2026-03-14");
  expect(await day("2026-01-02")).toBe("2026-01-01");
  // The first day of the book's calendar: there is no day before it, so the entry is dated that day.
  expect(await day("2026-01-01")).toBe("2026-01-01");
  // A date that cannot be used has no entry date.
  expect(await day("2025-12-31")).toBeNull();
  expect(await day("2026-02-30")).toBeNull();
  // Nothing about the review changes the books.
  expect((await f.ok("drafts.list", {})).count).toBe(0);
});

test("planning dates the draft the entry date, and posting keeps it and the source's name", async () => {
  const f = await shadowFixture({ today: "2026-04-02" });
  await f.ok("cutover.set", { cutoverDate: "2026-03-01" });
  const plan = await f.ok("opening.plan", { cutoverDate: "2026-03-01", balances: BALANCES });
  expect(plan.review.entryDate).toBe("2026-02-28");
  expect(plan.plan.effects.journals[0].date).toBe("2026-02-28");
  expect(plan.review.sourceId).toBe(`opening-2026-03-01-${plan.review.contentHash.slice(0, 12)}`);
  const draft = await f.ok("drafts.get", { draftId: plan.draft.id });
  expect(draft.data.date).toBe("2026-02-28");
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  const state = await f.ok("cutover.get", {});
  expect(state.opening).toMatchObject({
    status: "posted",
    cutoverDate: "2026-03-01",
    entryDate: "2026-02-28",
  });
  // The balance sheet at the end of the day before is already the opening position.
  const sheet = (await f.ok("reports.get", { asOf: "2026-02-28" })).balanceSheet;
  expect(sheet.balanced).toBe(true);
  expect(sheet.assets).toBe("14500.25");
  expect(sheet.liabilities).toBe("523.10");
  // Posted, the review of the same balances says where the entry is dated.
  const again = await f.ok("opening.review", { cutoverDate: "2026-03-01", balances: BALANCES });
  expect(codes(again)).toContain("opening_exists");
  expect(
    again.issues.find((issue: { code: string }) => issue.code === "opening_exists").message,
  ).toContain("dated 2026-02-28");
  // The entry before the cutover is the opening entry, not "an entry dated before the cutover".
  expect(codes(again)).not.toContain("journals_before_cutover");
});

test("the content hash covers the date, so the same balances on another date are another entry", async () => {
  const f = await shadowFixture();
  await f.ok("cutover.set", { cutoverDate: "2026-03-01" });
  const day = await f.ok("opening.review", { cutoverDate: "2026-03-01", balances: BALANCES });
  await f.ok("cutover.set", { cutoverDate: "2026-01-01" });
  const first = await f.ok("opening.review", { cutoverDate: "2026-01-01", balances: BALANCES });
  expect(day.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(day.contentHash).not.toBe(first.contentHash);
  expect(day.sourceId).not.toBe(first.sourceId);
  // And the same date and balances always give the same entry.
  const again = await f.ok("opening.review", { cutoverDate: "2026-01-01", balances: BALANCES });
  expect(again.contentHash).toBe(first.contentHash);
});

test("the entry is dated on the cutover date when the day before is in a closed period", async () => {
  const f = await shadowFixture({ today: "2026-04-02" });
  await prepareAndCommit(f, "periods.prepare", {
    periodId: "period-02",
    operation: "close",
    reason: "February is done",
  });
  const review = await f.ok("opening.review", { cutoverDate: "2026-03-01", balances: BALANCES });
  expect(review.entryDate).toBe("2026-03-01");
  expect(codes(review)).not.toContain("period_closed");
  await f.ok("cutover.set", { cutoverDate: "2026-03-01" });
  const plan = await f.ok("opening.plan", { cutoverDate: "2026-03-01", balances: BALANCES });
  expect(plan.plan.effects.journals[0].date).toBe("2026-03-01");
  // With the cutover's own period closed as well, nothing can take the entry, and the review says
  // which period to reopen.
  await prepareAndCommit(f, "periods.prepare", {
    periodId: "period-03",
    operation: "close",
    reason: "March is done",
  });
  const closed = await f.ok("opening.review", { cutoverDate: "2026-03-01", balances: BALANCES });
  expect(closed.valid).toBe(false);
  const issue = closed.issues.find((item: { code: string }) => item.code === "period_closed");
  expect(issue.message).toContain("March");
});

test("an account that opens on the cutover date takes the entry on the cutover date", async () => {
  const f = await shadowFixture({ today: "2026-04-02" });
  await prepareAndCommit(f, "accounts.prepareCreate", {
    code: "1900",
    name: "New savings",
    role: "asset",
    effectiveOn: "2026-03-01",
  });
  await f.ok("cutover.set", { cutoverDate: "2026-03-01" });
  // Without a balance in it the account does not matter: the day before.
  const without = await f.ok("opening.review", { cutoverDate: "2026-03-01", balances: BALANCES });
  expect(without.entryDate).toBe("2026-02-28");
  expect(without.valid).toBe(true);
  // With one, the entry moves to the day the account opens, and says so.
  const balances = [...BALANCES, { accountId: "1900", balance: "100.00" }];
  const review = await f.ok("opening.review", { cutoverDate: "2026-03-01", balances });
  expect(review.valid).toBe(true);
  expect(review.entryDate).toBe("2026-03-01");
  expect(codes(review)).toContain("entry_on_cutover_date");
  expect(codes(review)).not.toContain("account_not_open");
  // An account that opens after the cutover is still refused.
  await prepareAndCommit(f, "accounts.prepareCreate", {
    code: "1901",
    name: "Later savings",
    role: "asset",
    effectiveOn: "2026-03-02",
  });
  const later = await f.ok("opening.review", {
    cutoverDate: "2026-03-01",
    balances: [...BALANCES, { accountId: "1901", balance: "5.00" }],
  });
  expect(later.valid).toBe(false);
  expect(codes(later)).toContain("account_not_open");
});

test("opening balances entered by hand count as the opening entry in the checklist", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await f.ok("cutover.set", { cutoverDate: "2026-10-01", accountIds: ["1000"] });
  const before = await f.ok("cutover.checklist", {});
  expect(before.opening).toEqual({ status: "none" });
  expect(before.verdict.blocking.map((item: { code: string }) => item.code)).toContain(
    "opening_not_posted",
  );

  const journalId = await handMade(f, "2026-09-30");
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.opening).toEqual({
    status: "posted",
    journalId,
    entryDate: "2026-09-30",
    byHand: true,
  });
  expect(checklist.verdict.blocking.map((item: { code: string }) => item.code)).not.toContain(
    "opening_not_posted",
  );
});

test("the review warns about a hand-made opening entry instead of offering a second one", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await f.ok("cutover.set", { cutoverDate: "2026-10-01" });
  const journalId = await handMade(f, "2026-09-30");
  const review = await f.ok("opening.review", { cutoverDate: "2026-10-01", balances: BALANCES });
  expect(review.valid).toBe(false);
  expect(review.contentHash).toBeNull();
  expect(review.sourceId).toBeNull();
  expect(review.existing).toMatchObject({ status: "posted", byHand: true, journalId });
  const issue = review.issues.find((item: { code: string }) => item.code === "opening_by_hand");
  expect(issue.severity).toBe("error");
  expect(issue.message).toContain("2026-09-30");
  expect(issue.message).toContain("3900 Opening balance equity");
  expect(issue.message).toContain("twice");
  expect(issue.accountId).toBe("3900");
  // It is the opening entry, not "an entry dated before the cutover" on top of it.
  expect(codes(review)).not.toContain("journals_before_cutover");
  const refused = await f.call(
    "opening.plan",
    { cutoverDate: "2026-10-01", balances: BALANCES },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(422);
  expect(refused.body.error.code).toBe("opening_invalid");
  expect(refused.body.error.message).toContain("by hand");
  expect((await f.ok("drafts.list", {})).count).toBe(0);
  // The cutover shows it, and it does not lock the date: the opening tools did not write it.
  const state = await f.ok("cutover.get", {});
  expect(state.opening).toMatchObject({ status: "posted", byHand: true, journalId });
  expect(state.locked).toBe(false);
  expect(state.notes.join(" ")).toContain("entered by hand");
});

test("other entries before the cutover are still counted next to a hand-made opening", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await f.ok("cutover.set", { cutoverDate: "2026-10-01" });
  await handMade(f, "2026-09-30");
  await f.post("2026-09-15", "Owner puts in cash", [
    ["1000", "50.00", ""],
    ["3000", "", "50.00"],
  ]);
  const review = await f.ok("opening.review", { cutoverDate: "2026-10-01", balances: BALANCES });
  const warning = review.issues.find(
    (issue: { code: string }) => issue.code === "journals_before_cutover",
  );
  // One entry other than the opening entry: the owner's cash, dated earlier.
  expect(warning.message).toContain("1 entry");
  // The earliest entry against the opening-balance account is the one reported.
  expect(review.existing.entryDate).toBe("2026-09-30");
});

test("what is not an opening entry is not taken for one", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await f.ok("cutover.set", { cutoverDate: "2026-10-01" });
  // Before the cutover, but not against the opening-balance account.
  await f.post("2026-09-15", "Owner puts in cash", [
    ["1000", "50.00", ""],
    ["3000", "", "50.00"],
  ]);
  // Against the opening-balance account, but on or after the cutover date.
  await f.post("2026-10-01", "A correction to equity", [
    ["1000", "10.00", ""],
    ["3900", "", "10.00"],
  ]);
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.opening).toEqual({ status: "none" });
  expect(checklist.verdict.blocking.map((item: { code: string }) => item.code)).toContain(
    "opening_not_posted",
  );
  const review = await f.ok("opening.review", { cutoverDate: "2026-10-01", balances: BALANCES });
  expect(review.valid).toBe(true);
  expect(codes(review)).not.toContain("opening_by_hand");
});

test("a hand-made opening entry that was reversed is no longer the opening entry", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await f.ok("cutover.set", { cutoverDate: "2026-10-01" });
  const journalId = await handMade(f, "2026-09-30");
  expect((await f.ok("cutover.checklist", {})).opening.status).toBe("posted");
  await prepareAndCommit(f, "journal.prepareReverse", {
    journalId,
    accountingDate: "2026-09-30",
    reason: "Entered wrongly",
  });
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.opening).toEqual({ status: "none" });
  expect(checklist.verdict.blocking.map((item: { code: string }) => item.code)).toContain(
    "opening_not_posted",
  );
  // The opening tools can be used now.
  const review = await f.ok("opening.review", { cutoverDate: "2026-10-01", balances: BALANCES });
  expect(review.valid).toBe(true);
  expect(codes(review)).not.toContain("opening_by_hand");
  // The reversal does not count as an opening entry either.
  expect(codes(review)).toContain("journals_before_cutover");
});

test("a hand-made entry needs a recorded cutover to be before", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await handMade(f, "2026-09-30");
  const checklist = await f.ok("cutover.checklist", {});
  expect(checklist.cutover).toBeNull();
  expect(checklist.opening).toEqual({ status: "none" });
});

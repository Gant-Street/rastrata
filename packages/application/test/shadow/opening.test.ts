import { afterEach, expect, test } from "bun:test";
import { closeShadowFixtures, shadowFixture, type ShadowFixture } from "./support.ts";

afterEach(closeShadowFixtures);

const BALANCES = [
  { accountId: "1000", balance: "12000.00" },
  { accountId: "1010", balance: "2500.25" },
  { accountId: "1100", balance: "1300.50" },
  { accountId: "2000", balance: "523.10" },
  { accountId: "2500", balance: "75.00" },
];
// Debits 15,800.75, credits 598.10: the offset carries 15,202.65.
const OFFSET = "15202.65";

async function withCutover(f: ShadowFixture, date = "2026-11-01") {
  await f.ok("cutover.set", { cutoverDate: date });
}

const codes = (review: { issues: { code: string }[] }) => review.issues.map((issue) => issue.code);

test("a review shows the whole entry and changes nothing", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const drafts = await f.ok("drafts.list", {});
  const head = (await f.ok("book.get", {})).head;

  const review = await f.ok("opening.review", { cutoverDate: "2026-11-01", balances: BALANCES });
  expect(review.valid).toBe(true);
  expect(review.lines.map((line: { code: string }) => line.code)).toEqual([
    "1000",
    "1010",
    "1100",
    "2000",
    "2500",
  ]);
  expect(review.offset).toMatchObject({
    code: "3900",
    name: "Opening balance equity",
    debit: "0.00",
    credit: OFFSET,
    chosen: false,
  });
  expect(review.totals).toEqual({
    enteredDebit: "15800.75",
    enteredCredit: "598.10",
    debit: "15800.75",
    credit: "15800.75",
    balanced: true,
  });
  expect(review.calendar).toMatchObject({
    periodLabel: "November",
    periodStart: true,
    fiscalYearStart: false,
    periodStatus: "open",
  });
  expect(review.recordedCutover).toBe("2026-11-01");
  // The opening balances are the balances at the start of the cutover date, so the entry is dated
  // the day before: the cutover month's own reports start from them.
  expect(review.entryDate).toBe("2026-10-31");
  expect(review.existing).toEqual({ status: "none" });
  expect(review.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(review.sourceId).toBe(`opening-2026-11-01-${review.contentHash.slice(0, 12)}`);
  // Nothing was created: no draft, no journal, the same head.
  expect((await f.ok("drafts.list", {})).count).toBe(drafts.count);
  expect((await f.ok("book.get", {})).head).toEqual(head);
  expect((await f.ok("journal.list", { status: "Posted" })).count).toBe(0);
  // The same balances always give the same entry, in any order.
  const again = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: [...BALANCES].reverse(),
  });
  expect(again.contentHash).toBe(review.contentHash);
});

test("the cutover date must be recorded first, and must match", async () => {
  const f = await shadowFixture();
  const before = await f.ok("opening.review", { cutoverDate: "2026-11-01", balances: BALANCES });
  expect(before.valid).toBe(false);
  expect(codes(before)).toContain("cutover_not_set");
  expect(before.contentHash).toBeNull();
  const refused = await f.call(
    "opening.plan",
    { cutoverDate: "2026-11-01", balances: BALANCES },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(422);
  expect(refused.body.error.code).toBe("opening_invalid");
  expect(refused.body.error.message).toContain("cutover");
  await withCutover(f, "2026-12-01");
  const differs = await f.ok("opening.review", { cutoverDate: "2026-11-01", balances: BALANCES });
  expect(codes(differs)).toContain("cutover_differs");
  expect(differs.valid).toBe(false);
});

test("planning prepares the one ordinary entry, and committing it posts exactly that", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const plan = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES });
  expect(plan.review.valid).toBe(true);
  expect(plan.plan.valid).toBe(true);
  expect(plan.plan.kind).toBe("postDraft");
  expect(plan.plan.effects.journals).toHaveLength(1);
  const journal = plan.plan.effects.journals[0];
  expect(journal.date).toBe("2026-10-31");
  // The words carry no date: the entry's own date (the day before the cutover) is its date column.
  expect(journal.narration).toBe("Opening balances");
  const sum = (key: "debit" | "credit") =>
    journal.lines.reduce(
      (total: bigint, line: Record<string, string>) =>
        total + BigInt((line[key] ?? "0.00").replace(".", "")),
      0n,
    );
  expect(sum("debit")).toBe(sum("credit"));
  expect(
    journal.lines.find((line: { accountId: string }) => line.accountId === "3900"),
  ).toMatchObject({
    debit: "0.00",
    credit: OFFSET,
  });
  // The draft is an ordinary draft the owner can open on the Journal screen.
  const draft = await f.ok("drafts.get", { draftId: plan.draft.id });
  expect(draft.status).toBe("draft");
  expect(draft.data.source.id).toBe(plan.review.sourceId);
  expect(draft.data.source.evidenceReference).toContain(plan.review.contentHash);
  // Nothing is posted until the plan is committed.
  expect((await f.ok("journal.list", { status: "Posted" })).count).toBe(0);
  const status = await f.ok("cutover.get", {});
  expect(status.opening).toMatchObject({
    status: "planned",
    sourceId: plan.review.sourceId,
    cutoverDate: "2026-11-01",
    entryDate: "2026-10-31",
  });

  const done = await f.call("operations.commit", {
    planId: plan.plan.planId,
    planHash: plan.plan.planHash,
  });
  expect(done.body.data.disposition).toBe("committed");
  const accounts = await f.ok("accounts.list", {});
  const balance = (code: string) =>
    accounts.accounts.find((account: { code: string }) => account.code === code).balance;
  expect(balance("1000")).toBe("12000.00");
  expect(balance("2000")).toBe("-523.10");
  expect(balance("3900")).toBe(`-${OFFSET}`);
  const reports = await f.ok("reports.get", { asOf: "2026-11-30" });
  expect(reports.trialBalance.balanced).toBe(true);
  expect(reports.balanceSheet.balanced).toBe(true);
  expect(reports.balanceSheet.assets).toBe("15800.75");
  expect(reports.balanceSheet.liabilities).toBe("598.10");
  // Posted: the lane says so, and its journal carries the source and the evidence.
  const after = await f.ok("cutover.get", {});
  expect(after.opening).toMatchObject({
    status: "posted",
    cutoverDate: "2026-11-01",
    entryDate: "2026-10-31",
  });
  expect(after.opening.byHand).toBeUndefined();
  expect(after.locked).toBe(true);
  const entry = await f.ok("journal.get", { journalId: after.opening.journalId });
  expect(entry.date).toBe("2026-10-31");
  expect(entry.source.id).toBe(plan.review.sourceId);
});

test("a second opening entry is refused while one is posted, and the ledger refuses a repeat", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const plan = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES });
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  const review = await f.ok("opening.review", { cutoverDate: "2026-11-01", balances: BALANCES });
  expect(review.valid).toBe(false);
  expect(codes(review)).toContain("opening_exists");
  const refused = await f.call(
    "opening.plan",
    { cutoverDate: "2026-11-01", balances: BALANCES },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(422);
  // Even by hand through the ordinary draft path, the same source cannot post twice.
  const review2 = plan.review;
  const hand = await f.call(
    "drafts.create",
    {
      data: {
        date: "2026-10-31",
        reference: "OPENING",
        narration: "again",
        source: {
          id: review2.sourceId,
          description: "Opening balances, entered through Rastrata's cutover tools.",
          evidenceReference: `shadow:opening:v1:sha256=${review2.contentHash}`,
        },
        lines: [
          { accountId: "1000", debit: "1.00", credit: "" },
          { accountId: "3900", debit: "", credit: "1.00" },
        ],
      },
    },
    crypto.randomUUID(),
  );
  // The draft can be saved, but it cannot be prepared: the source already has its journal.
  expect(hand.status).toBe(200);
  const again = await f.call(
    "journal.prepare",
    { draftId: hand.body.data.id, expectedVersion: hand.body.data.version },
    crypto.randomUUID(),
  );
  expect(again.status).toBe(409);
  expect(again.body.error.code).toBe("source_already_posted");
});

test("a retried plan returns the plan it made, and planning again replaces the unposted draft", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const id = crypto.randomUUID();
  const first = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES }, id);
  const retry = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES }, id);
  expect(retry).toEqual(first);
  expect((await f.ok("drafts.list", {})).count).toBe(1);
  // The same identity with other balances is a conflict, never a quiet change.
  const conflict = await f.call(
    "opening.plan",
    { cutoverDate: "2026-11-01", balances: [{ accountId: "1000", balance: "1.00" }] },
    id,
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe("operation_identity_conflict");
  // Other balances under a new identity replace the first plan: one draft is left.
  const second = await f.ok("opening.plan", {
    cutoverDate: "2026-11-01",
    balances: [...BALANCES, { accountId: "1500", balance: "999.99" }],
  });
  expect(second.review.contentHash).not.toBe(first.review.contentHash);
  const drafts = await f.ok("drafts.list", {});
  expect(drafts.count).toBe(1);
  expect(drafts.drafts[0].id).toBe(second.draft.id);
  // The old plan can no longer be committed.
  const stale = await f.call("operations.commit", {
    planId: first.plan.planId,
    planHash: first.plan.planHash,
  });
  expect(stale.status).toBe(409);
  expect((await f.ok("journal.list", { status: "Posted" })).count).toBe(0);
  // The new one posts.
  const done = await f.call("operations.commit", {
    planId: second.plan.planId,
    planHash: second.plan.planHash,
  });
  expect(done.body.data.disposition).toBe("committed");
});

test("a reply lost between the draft and the plan is resumed, not repeated", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const id = crypto.randomUUID();
  const first = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES }, id);
  // The reply was lost and the service restarted: the same identity finds its draft again.
  await f.restart();
  const resumed = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES }, id);
  expect(resumed.plan.planHash).toBe(first.plan.planHash);
  expect(resumed.draft.id).toBe(first.draft.id);
  expect((await f.ok("drafts.list", {})).count).toBe(1);
});

test("problems are reported against the account or row, and nothing is planned", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const review = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: [
      { accountId: "9999", balance: "5.00" },
      { accountId: "1000", balance: "10.00" },
      { accountId: "1000", balance: "20.00" },
      { accountId: "4000", balance: "0.00" },
    ],
  });
  expect(review.valid).toBe(false);
  expect(codes(review)).toEqual(expect.arrayContaining(["account_not_found", "duplicate_account"]));
  expect(review.issues[0].severity).toBe("error");
  const refused = await f.call(
    "opening.plan",
    { cutoverDate: "2026-11-01", balances: [{ accountId: "9999", balance: "5.00" }] },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(422);
  expect(refused.body.error.details.length).toBeGreaterThan(0);
  expect((await f.ok("drafts.list", {})).count).toBe(0);
});

test("balances come in as CSV too, and a bad row stops the plan instead of being dropped", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const csv =
    'Code,Name,Debit,Credit\n1000,Business checking,"12,000.00",\n1010,Business savings,2500.25,\n1100,Stripe balance,1300.50,\n2000,Business credit card,,523.10\n2500,Sales tax payable,,75.00\nTotal,,16000.75,598.10\n';
  const review = await f.ok("opening.review", { cutoverDate: "2026-11-01", csv });
  expect(review.valid).toBe(true);
  expect(review.offset.credit).toBe(OFFSET);
  expect(review.lines[0]).toMatchObject({ code: "1000", row: 2, debit: "12000.00" });
  expect(codes(review)).toContain("total_row_skipped");
  // A row that cannot be read is an error on its row: the entry would otherwise quietly omit it.
  const broken = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    csv: `${csv}9999,Nothing,5.00,\n1500,Equipment,10.005,\n`,
  });
  expect(broken.valid).toBe(false);
  const rows = broken.issues.filter((issue: { severity: string }) => issue.severity === "error");
  expect(rows.map((issue: { row: number }) => issue.row)).toEqual([8, 9]);
  const refused = await f.call(
    "opening.plan",
    { cutoverDate: "2026-11-01", csv: `${csv}9999,Nothing,5.00,\n` },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(422);
  // Balances and csv together are ambiguous.
  const both = await f.call("opening.review", {
    cutoverDate: "2026-11-01",
    csv,
    balances: BALANCES,
  });
  expect(both.status).toBe(400);
});

test("the date must be inside the calendar and in an open period", async () => {
  const f = await shadowFixture();
  const early = await f.ok("opening.review", { cutoverDate: "2025-12-31", balances: BALANCES });
  expect(codes(early)).toContain("date_before_book");
  const late = await f.ok("opening.review", { cutoverDate: "2027-01-01", balances: BALANCES });
  expect(codes(late)).toContain("date_after_calendar");
  const fake = await f.ok("opening.review", { cutoverDate: "2026-02-30", balances: BALANCES });
  expect(codes(fake)).toContain("date_invalid");
  // January is closed: nothing can be posted into it.
  const plan = await f.ok("periods.prepare", {
    periodId: "period-01",
    operation: "close",
    reason: "Closed for the test",
  });
  await f.ok("operations.commit", { planId: plan.planId, planHash: plan.planHash }, plan.planId);
  const closed = await f.ok("opening.review", { cutoverDate: "2026-01-01", balances: BALANCES });
  expect(codes(closed)).toContain("period_closed");
});

test("year-to-date profit and loss balances are called out for the date chosen", async () => {
  const f = await shadowFixture();
  const entries = [
    { accountId: "1000", balance: "1000.00" },
    { accountId: "4000", balance: "300.00" },
    { accountId: "6000", balance: "100.00" },
  ];
  const mid = await f.ok("opening.review", { cutoverDate: "2026-11-01", balances: entries });
  expect(codes(mid)).toContain("profit_loss_mid_year");
  const start = await f.ok("opening.review", { cutoverDate: "2026-01-01", balances: entries });
  expect(codes(start)).toContain("profit_loss_at_year_start");
  expect(start.calendar.fiscalYearStart).toBe(true);
});

test("entries dated before the cutover are flagged, because they would be counted twice", async () => {
  const f = await shadowFixture();
  await f.post("2026-10-15", "Owner puts in cash", [
    ["1000", "50.00", ""],
    ["3000", "", "50.00"],
  ]);
  await withCutover(f);
  const review = await f.ok("opening.review", { cutoverDate: "2026-11-01", balances: BALANCES });
  expect(review.valid).toBe(true);
  const warning = review.issues.find(
    (issue: { code: string }) => issue.code === "journals_before_cutover",
  );
  expect(warning.severity).toBe("warning");
  expect(warning.message).toContain("1 entry");
});

test("the offset is chosen, found by name, or refused when it cannot be told", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const chosen = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: BALANCES,
    offsetAccountId: "3000",
  });
  expect(chosen.offset).toMatchObject({ code: "3000", chosen: true, credit: OFFSET });
  const bad = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: BALANCES,
    offsetAccountId: "4000",
  });
  expect(codes(bad)).toContain("offset_not_equity");
  // Entering the offset account itself is refused: it is calculated.
  const entered = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: [...BALANCES, { accountId: "3900", balance: "5.00" }],
  });
  expect(codes(entered)).toContain("offset_entered");
  // Balances that balance on their own need no offset at all.
  const balanced = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: [
      { accountId: "1000", balance: "100.00" },
      { accountId: "3000", balance: "100.00" },
    ],
  });
  expect(balanced.valid).toBe(true);
  expect(balanced.offset).toBeNull();
});

test("a posted opening entry can be reversed and a new one planned", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const plan = await f.ok("opening.plan", { cutoverDate: "2026-11-01", balances: BALANCES });
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  const state = await f.ok("cutover.get", {});
  const reversal = await f.ok("journal.prepareReverse", {
    journalId: state.opening.journalId,
    accountingDate: "2026-11-02",
    reason: "A balance was entered wrongly",
  });
  await f.ok(
    "operations.commit",
    { planId: reversal.planId, planHash: reversal.planHash },
    reversal.planId,
  );
  expect((await f.ok("cutover.get", {})).opening.status).toBe("reversed");
  // Reversed: a corrected entry may be planned, and the cutover date may be moved.
  const corrected = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: [...BALANCES.slice(0, 4), { accountId: "2500", balance: "80.00" }],
  });
  expect(corrected.valid).toBe(true);
  const second = await f.ok("opening.plan", {
    cutoverDate: "2026-11-01",
    balances: [...BALANCES.slice(0, 4), { accountId: "2500", balance: "80.00" }],
  });
  const done = await f.call("operations.commit", {
    planId: second.plan.planId,
    planHash: second.plan.planHash,
  });
  expect(done.body.data.disposition).toBe("committed");
  expect((await f.ok("cutover.get", {})).opening.status).toBe("posted");
});

test("each operation needs its own permission", async () => {
  const f = await shadowFixture();
  const input = { cutoverDate: "2026-11-01", balances: BALANCES };
  const review = await f.call("opening.review", input, undefined, ["read"]);
  expect(review.status).toBe(200);
  const plan = await f.call("opening.plan", input, crypto.randomUUID(), ["read", "draft"]);
  expect(plan.status).toBe(403);
  const set = await f.call("cutover.set", { cutoverDate: "2026-11-01" }, crypto.randomUUID(), [
    "read",
    "post",
  ]);
  expect(set.status).toBe(403);
  const none = await f.call("opening.review", input, undefined, []);
  expect(none.status).toBe(403);
});

test("amounts past 2^53 cents are exact", async () => {
  const f = await shadowFixture();
  await withCutover(f);
  const review = await f.ok("opening.review", {
    cutoverDate: "2026-11-01",
    balances: [
      { accountId: "1000", balance: "9007199254740993.01" },
      { accountId: "2000", balance: "0.01" },
    ],
  });
  expect(review.valid).toBe(true);
  expect(review.offset.credit).toBe("9007199254740993.00");
  const plan = await f.ok("opening.plan", {
    cutoverDate: "2026-11-01",
    balances: [
      { accountId: "1000", balance: "9007199254740993.01" },
      { accountId: "2000", balance: "0.01" },
    ],
  });
  expect(plan.plan.valid).toBe(true);
});

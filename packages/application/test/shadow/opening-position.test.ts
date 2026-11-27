/** The cash flow reads the opening entry as the position the books start from, not as activity: the
 * entry the opening tools post (a source id that starts `opening-`) and any correction of it are taken
 * out of the range they fall in. Through the real service, so the figures are the ones a person sees. */
import { afterEach, expect, test } from "bun:test";
import { closeShadowFixtures, shadowFixture, type ShadowFixture } from "./support.ts";

afterEach(closeShadowFixtures);

// Cash is 1000, 1010 and 1100: 12,000.00 + 2,500.25 + 1,300.50 = 15,800.75.
const BALANCES = [
  { accountId: "1000", balance: "12000.00" },
  { accountId: "1010", balance: "2500.25" },
  { accountId: "1100", balance: "1300.50" },
  { accountId: "2000", balance: "523.10" },
  { accountId: "2500", balance: "75.00" },
];
const OPENING_CASH = "15800.75";

async function openBook(f: ShadowFixture, cutoverDate: string, balances = BALANCES) {
  await f.ok("cutover.set", { cutoverDate });
  const plan = await f.ok("opening.plan", { cutoverDate, balances });
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  return plan;
}

const section = (flow: { sections: { key: string }[] }, key: string) =>
  flow.sections.find((item) => item.key === key) as {
    key: string;
    total: string;
    lines: { code: string | null; group: string; amount: string }[];
  };
const warningCodes = (flow: { warnings: { code: string }[] }) =>
  flow.warnings.map((warning) => warning.code);

test("a cutover month starts from the opening cash when the entry is dated the day before", async () => {
  const f = await shadowFixture({ today: "2026-04-02" });
  const plan = await openBook(f, "2026-03-01");
  expect(plan.review.entryDate).toBe("2026-02-28");
  await f.post("2026-03-05", "Customer payment", [
    ["1000", "1000.00", ""],
    ["4000", "", "1000.00"],
  ]);
  await f.post("2026-03-12", "Hosting", [
    ["6000", "250.00", ""],
    ["1000", "", "250.00"],
  ]);
  const flow = await f.ok("reports.cashFlow", { from: "2026-03-01", asOf: "2026-03-31" });
  expect(flow.available).toBe(true);
  expect(flow.openingCash).toBe(OPENING_CASH);
  expect(flow.netChange).toBe("750.00");
  expect(flow.closingCash).toBe("16550.75");
  expect(flow.ties).toBe(true);
  // March's own activity is all there is: net income, and no opening balances as financing.
  expect(section(flow, "operating").lines.find((line) => line.group === "netIncome")?.amount).toBe(
    "750.00",
  );
  expect(section(flow, "financing").lines).toEqual([]);
  expect(section(flow, "financing").total).toBe("0.00");
  // The entry is outside the range, so there is nothing to say about it.
  expect(warningCodes(flow)).not.toContain("opening_position");
});

test("a cutover on the first day of the calendar reads the opening entry as the starting position", async () => {
  const f = await shadowFixture({ today: "2026-02-10" });
  // There is no day before the book's first day, so the entry is dated on it, inside January.
  const entries = [
    ...BALANCES,
    // Year-to-date profit and loss balances come with the opening balances too.
    { accountId: "4000", balance: "300.00" },
    { accountId: "6000", balance: "100.00" },
  ];
  const plan = await openBook(f, "2026-01-01", entries);
  expect(plan.review.entryDate).toBe("2026-01-01");
  await f.post("2026-01-10", "Customer payment", [
    ["1000", "50.00", ""],
    ["4000", "", "50.00"],
  ]);
  const flow = await f.ok("reports.cashFlow", { from: "2026-01-01", asOf: "2026-01-31" });
  expect(flow.available).toBe(true);
  // The opening cash is the cash at the start; January's change is its own.
  expect(flow.openingCash).toBe(OPENING_CASH);
  expect(flow.netChange).toBe("50.00");
  expect(flow.closingCash).toBe("15850.75");
  expect(flow.ties).toBe(true);
  // Net income is January's: the opening income and expense do not count as earned in January.
  expect(section(flow, "operating").lines.find((line) => line.group === "netIncome")?.amount).toBe(
    "50.00",
  );
  // No line shows the opening balances: not as financing, and no balance sheet account as a change.
  expect(section(flow, "financing").lines).toEqual([]);
  expect(section(flow, "operating").lines.map((line) => line.group)).toEqual(["netIncome"]);
  expect(section(flow, "investing").lines).toEqual([]);
  // It says so, with the date.
  expect(
    flow.warnings.find((warning: { code: string }) => warning.code === "opening_position"),
  ).toMatchObject({ message: expect.stringContaining("2026-01-01") });
  // The balance sheet and the profit and loss are unchanged by this: the entry is in the books.
  const reports = await f.ok("reports.get", { asOf: "2026-01-31" });
  expect(reports.balanceSheet.balanced).toBe(true);
});

test("a range that starts before the entry holds it in the starting position too", async () => {
  const f = await shadowFixture({ today: "2026-04-02" });
  await openBook(f, "2026-03-01");
  await f.post("2026-03-05", "Customer payment", [
    ["1000", "1000.00", ""],
    ["4000", "", "1000.00"],
  ]);
  // The year to date starts on January 1, before the opening entry (February 28): the entry is still
  // the position, not January-to-March activity, so the cash at the start is the opening cash.
  const flow = await f.ok("reports.cashFlow", { asOf: "2026-03-31" });
  expect(flow.openingCash).toBe(OPENING_CASH);
  expect(flow.netChange).toBe("1000.00");
  expect(flow.ties).toBe(true);
  expect(section(flow, "financing").lines).toEqual([]);
  expect(warningCodes(flow)).toContain("opening_position");
});

test("reversing the opening entry and posting a corrected one leaves the position, not a movement", async () => {
  const f = await shadowFixture({ today: "2026-02-10" });
  const first = await openBook(f, "2026-01-01");
  const state = await f.ok("cutover.get", {});
  const reversal = await f.ok("journal.prepareReverse", {
    journalId: state.opening.journalId,
    accountingDate: "2026-01-05",
    reason: "A balance was entered wrongly",
  });
  await f.ok(
    "operations.commit",
    { planId: reversal.planId, planHash: reversal.planHash },
    reversal.planId,
  );
  const corrected = [...BALANCES.slice(0, 4), { accountId: "2500", balance: "80.00" }];
  const second = await f.ok("opening.plan", { cutoverDate: "2026-01-01", balances: corrected });
  expect(second.review.contentHash).not.toBe(first.review.contentHash);
  await f.ok(
    "operations.commit",
    { planId: second.plan.planId, planHash: second.plan.planHash },
    second.plan.planId,
  );
  await f.post("2026-01-10", "Customer payment", [
    ["1000", "50.00", ""],
    ["4000", "", "50.00"],
  ]);
  const flow = await f.ok("reports.cashFlow", { from: "2026-01-01", asOf: "2026-01-31" });
  // The first entry and its reversal are both taken out; the corrected entry is the position.
  expect(flow.openingCash).toBe(OPENING_CASH);
  expect(flow.netChange).toBe("50.00");
  expect(flow.ties).toBe(true);
  expect(section(flow, "financing").lines).toEqual([]);
  const dates = String(
    flow.warnings.find((warning: { code: string }) => warning.code === "opening_position").message,
  );
  expect(dates).toContain("2026-01-01");
  expect(dates).toContain("2026-01-05");
});

test("a comparison column reads the opening entry the same way", async () => {
  const f = await shadowFixture({ today: "2026-03-10" });
  await openBook(f, "2026-01-01");
  await f.post("2026-01-10", "Customer payment", [
    ["1000", "50.00", ""],
    ["4000", "", "50.00"],
  ]);
  await f.post("2026-02-10", "Customer payment", [
    ["1000", "70.00", ""],
    ["4000", "", "70.00"],
  ]);
  const flow = await f.ok("reports.cashFlow", {
    from: "2026-02-01",
    asOf: "2026-02-28",
    compare: "previousPeriod",
  });
  // February against January: January's column holds the opening entry, and reads it as the position.
  const change = flow.totals.find((item: { key: string }) => item.key === "netChange");
  expect(change).toMatchObject({ amount: "70.00", comparative: "50.00" });
  const opening = flow.totals.find((item: { key: string }) => item.key === "openingCash");
  expect(opening).toMatchObject({ amount: "15850.75", comparative: OPENING_CASH });
  expect(flow.ties).toBe(true);
});

test("a book with no opening entry reads exactly as before", async () => {
  const f = await shadowFixture({ today: "2026-02-10" });
  // An owner's investment is financing, as it always was.
  await f.post("2026-01-05", "Owner puts in cash", [
    ["1000", "500.00", ""],
    ["3000", "", "500.00"],
  ]);
  const flow = await f.ok("reports.cashFlow", { from: "2026-01-01", asOf: "2026-01-31" });
  expect(flow.openingCash).toBe("0.00");
  expect(flow.netChange).toBe("500.00");
  expect(section(flow, "financing").lines.map((line) => [line.code, line.amount])).toEqual([
    ["3000", "500.00"],
  ]);
  expect(warningCodes(flow)).not.toContain("opening_position");
});

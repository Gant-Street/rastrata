import { afterEach, expect, test } from "bun:test";
import { addDays } from "../../src/stripe/dates.ts";
import {
  type Entry,
  type Json,
  type Scenario,
  accountObject,
  balanceTransaction,
  chargeObject,
  payoutObject,
  sessionObject,
  ts,
} from "./fixtures.ts";
import { type World, deposit, importDeposits, itemIdOf, uuid, world } from "./slice-support.ts";

/** The case this lane is for: a small online business whose charges mostly cost the same, so Stripe
 * pays out the same amount again and again. Thirty-two payouts of exactly 19.12, one every other day
 * for sixty-two days, each with a bank deposit on its arrival date but one, which comes a day late.
 * Every deposit must clear its own payout, one to one, and once the deposits are accepted and posted
 * no payout may be left "unmatched". */

const COUNT = 32;
const START = "2026-01-02";
const pad = (n: number): string => String(n).padStart(2, "0");

function equalPayouts(): Scenario {
  const entries: Entry[] = [];
  const payouts: Json[] = [];
  const sessions: Json[] = [];
  const labels: Record<string, string> = {};
  for (let i = 0; i < COUNT; i++) {
    const date = addDays(START, i * 2);
    const chargeId = 5000 + i * 3;
    const created = ts(`${date}T10:00:00Z`);
    const pi = `pi_1Fixture${String(chargeId).padStart(14, "0")}`;
    const charge = chargeObject(chargeId, { amount: 2000, created, paymentIntent: pi });
    sessions.push(sessionObject(chargeId, { paymentIntent: pi, total: 2000, tax: 0, created }));
    const member: Entry = {
      bt: balanceTransaction(chargeId, {
        category: "charge",
        type: "charge",
        amount: 2000,
        fee: 88,
        created,
        source: String(charge.id),
      }),
      source: charge,
      payout: `E${pad(i)}`,
    };
    const payoutId = 5001 + i * 3;
    const po = payoutObject(payoutId, {
      amount: 1912,
      created: ts(`${date}T20:00:00Z`),
      arrival: addDays(date, 1),
      btId: `txn_1Fixture${String(payoutId).padStart(14, "0")}`,
    });
    payouts.push(po);
    labels[`E${pad(i)}`] = String(po.id);
    entries.push(member, {
      bt: balanceTransaction(payoutId, {
        category: "payout",
        type: "payout",
        amount: -1912,
        created: ts(`${date}T20:00:00Z`),
        source: String(po.id),
      }),
      source: po,
      payout: null,
    });
  }
  return {
    account: accountObject(),
    entries,
    payouts,
    sessions,
    invoicePayments: [],
    labels,
    now: ts("2026-03-12T12:00:00Z"),
  };
}

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

interface Proposal {
  proposer: string;
  confidence: number;
  reasons: string[];
  links?: { key: string; value: string }[];
}
/** Every payout, a page of twenty-five at a time. */
async function allPayouts(w: World): Promise<{ id: string; deposit: string }[]> {
  const out: { id: string; deposit: string }[] = [];
  for (let page = 1; page < 20; page++) {
    const data = (await w.call("stripe.payouts", { page })).body.data;
    out.push(...data.payouts);
    if (out.length >= data.count) break;
  }
  return out;
}

const stripeProposal = async (w: World, providerId: string): Promise<Proposal | undefined> => {
  const detail = (await w.call("inbox.get", { itemId: await itemIdOf(w, providerId) })).body.data;
  return (detail.proposals as Proposal[]).find((p) => p.proposer === "stripe");
};

test("thirty-two equal payouts over sixty days, one deposit a day late: each deposit clears its own payout and none is left unmatched", async () => {
  const scenario = equalPayouts();
  const w = await world({ realPort: true, scenario });
  open.push(w);
  w.clock.ms = Date.parse("2026-03-12T13:00:00Z");
  await w.call("stripe.configure", { syncFrom: START }, uuid());
  await w.call("stripe.sync", {}, uuid());
  expect((await w.call("stripe.status")).body.data.payouts).toMatchObject({
    known: COUNT,
    booked: COUNT,
    unmatched: COUNT,
  });

  // The bank: a deposit of 19.12 on each payout's arrival date, the eleventh a day after.
  const arrivals = Object.keys(scenario.labels).map((_, i) => addDays(addDays(START, i * 2), 1));
  importDeposits(
    w,
    arrivals.map((date, i) =>
      deposit(`bank-${pad(i)}`, i === 10 ? addDays(date, 1) : date, "19.12"),
    ),
  );

  // Every deposit names the payout with its own number, to the day; the late one says it is a day away.
  for (let i = 0; i < COUNT; i++) {
    const proposal = await stripeProposal(w, `bank-${pad(i)}`);
    expect(proposal?.links, `deposit ${i}`).toEqual([
      { key: "payout", value: scenario.labels[`E${pad(i)}`] as string },
    ]);
    expect(proposal?.confidence, `deposit ${i}`).toBe(i === 10 ? 90 : 97);
  }
  const late = await stripeProposal(w, "bank-10");
  expect(late?.reasons.join(" ")).toContain("1 day from its arrival date");
  expect(late?.reasons.join(" ")).toContain("paired one to one");

  // The payouts are accepted and posted, then every deposit, and the payouts are matched.
  const stripeLines = { provider: "stripe", covered: false };
  const post = async (filter: Record<string, unknown>): Promise<void> => {
    for (let call = 0; call < 20; call++) {
      const done = await w.call("inbox.post", { filter }, uuid());
      expect(done.body.ok).toBe(true);
      if (done.body.data.remaining === 0) return;
    }
  };
  await w.call(
    "inbox.accept",
    { filter: stripeLines, proposer: "stripe", minConfidence: 100 },
    uuid(),
  );
  await post(stripeLines);
  // No deposit has been accepted yet: every payout is waiting for one.
  expect((await w.call("stripe.payouts", { filter: "unmatched" })).body.data.count).toBe(COUNT);
  const taken = await w.call(
    "inbox.accept",
    { filter: { provider: "csv" }, proposer: "stripe", minConfidence: 90 },
    uuid(),
  );
  expect(taken.body.data).toMatchObject({ applied: COUNT, failed: 0 });
  await post({ provider: "csv" });
  expect((await allPayouts(w)).filter((p) => p.deposit === "matched")).toHaveLength(COUNT);
  expect((await w.call("stripe.payouts", { filter: "unmatched" })).body.data.count).toBe(0);
  expect((await w.call("stripe.status")).body.data.payouts).toMatchObject({
    unmatched: 0,
    overdue: 0,
  });
});

test("a deposit that was categorised to Payouts in transit by hand settles its payout, and an old payout with no deposit is overdue, not normal", async () => {
  const scenario = equalPayouts();
  const w = await world({ realPort: true, scenario });
  open.push(w);
  w.clock.ms = Date.parse("2026-03-12T13:00:00Z");
  await w.call("stripe.configure", { syncFrom: START }, uuid());
  await w.call("stripe.sync", {}, uuid());
  // Only three deposits reached the bank file: the first, the second and the last.
  const arrivals = Object.keys(scenario.labels).map((_, i) => addDays(addDays(START, i * 2), 1));
  importDeposits(
    w,
    [0, 1, COUNT - 1].map((i) => deposit(`bank-${pad(i)}`, arrivals[i] as string, "19.12")),
  );
  const stripeLines = { provider: "stripe", covered: false };
  await w.call(
    "inbox.accept",
    { filter: stripeLines, proposer: "stripe", minConfidence: 100 },
    uuid(),
  );
  await w.call("inbox.post", { filter: stripeLines }, uuid());
  // The first is accepted as Stripe's suggestion; the second is categorised by hand to Payouts in
  // transit, with no payout named; the last is left alone.
  const first = await itemIdOf(w, "bank-00");
  const second = await itemIdOf(w, "bank-01");
  await w.call("inbox.accept", { itemIds: [first], proposer: "stripe" }, uuid());
  await w.call("inbox.categorize", { itemIds: [second], accountId: "1110" }, uuid());
  const matched = (await allPayouts(w)).filter((p) => p.deposit === "matched").map((p) => p.id);
  expect(matched.sort()).toEqual(
    [scenario.labels.E00, scenario.labels.E01].map((id) => id as string).sort(),
  );
  // The other thirty were due days ago: the status counts them overdue, the oldest of them the 5th
  // of January (the third payout's arrival date, the 6th, is the first that has no deposit).
  const status = (await w.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({
    unmatched: COUNT - 2,
    overdue: COUNT - 2,
    oldestOverdueOn: arrivals[2],
  });
});

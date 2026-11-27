import { afterEach, expect, test } from "bun:test";
import { expectWithin } from "../support/budget.ts";
import { type World, journals, uuid, world } from "./slice-support.ts";
import { yearOfActivity } from "./year.ts";

/** The volume the lane is designed for: a year of a small online business, about 2,000 balance
 * transactions and about 250 payouts, first-synced in one go through the real pipeline, then every
 * payout accepted and posted, and the book read again from the start. It asserts correctness at that
 * size, the cost the one-entry-per-payout booking is chosen for, and a generous time bound; the
 * measured figures are recorded in docs/reference/program/stripe.md. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

test("a year of activity (about 2,000 balance transactions, 250 payouts) books 250 entries, ties to the cent, and reads back quickly", async () => {
  const scenario = yearOfActivity();
  const total = scenario.entries.length;
  expect(total).toBeGreaterThan(1900);
  expect(scenario.payouts.length).toBeGreaterThan(240);
  const members = scenario.entries.filter((e) => e.payout !== null).length;
  const w = await world({ realPort: true, scenario, book: undefined });
  open.push(w);
  w.clock.ms = Date.parse("2027-01-02T13:00:00Z");
  await w.call("stripe.configure", { syncFrom: "2026-01-01" }, uuid());

  // 1. The first sync, in as many calls as the time budget needs.
  const syncStarted = performance.now();
  let calls = 0;
  let more = true;
  let requests = 0;
  while (more && calls < 100) {
    const run = await w.call("stripe.sync", { budgetSeconds: 25 }, uuid());
    expect(run.body.ok).toBe(true);
    more = run.body.data.more;
    requests += run.body.data.run.requests;
    calls++;
  }
  const syncSeconds = (performance.now() - syncStarted) / 1000;
  const count = (sql: string): number =>
    Number((w.service.store.query(sql).get() as { n: number }).n);
  expect(more).toBe(false);
  // One entry per payout, and each transaction a payout carries as evidence: the payouts' own debits
  // of the Stripe balance and the transactions not yet paid out are not lines.
  expect(count("SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe'")).toBe(
    members + scenario.payouts.length,
  );
  const status = (await w.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({
    known: scenario.payouts.length,
    booked: scenario.payouts.length,
    mismatched: 0,
    waiting: 0,
  });
  // What Stripe still holds is exactly what is not yet in a payout, to the cent.
  const notPaid = scenario.entries
    .filter((e) => e.payout === null && e.bt.type !== "payout")
    .reduce((sum, e) => sum + BigInt(Number(e.bt.net)), 0n);
  expect(status.balance.snapshot.total).toBe(
    `${notPaid / 100n}.${String(notPaid % 100n).padStart(2, "0")}`,
  );
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });

  // 2. Accept and post every payout: the book gets one entry per payout.
  const filter = { provider: "stripe", covered: false };
  const postStarted = performance.now();
  // Each call works for a bounded time and says how many are left: ask again until none are.
  const all = async (name: string, input: Record<string, unknown>) => {
    let applied = 0;
    const failures: string[] = [];
    for (let call = 0; call < 20; call++) {
      const result = await w.call(name, input, uuid());
      expect(result.body.ok).toBe(true);
      applied += result.body.data.applied;
      for (const r of result.body.data.results as { outcome: string; code?: string }[])
        if (r.outcome === "failed") failures.push(String(r.code));
      if (result.body.data.remaining === 0) break;
    }
    return { applied, failures };
  };
  expect(
    await all("inbox.accept", { filter, proposer: "stripe", minConfidence: 100, limit: 1000 }),
  ).toEqual({ applied: scenario.payouts.length, failures: [] });
  // The last payout of the year arrives on 1 January 2027, after the end of the book's fiscal
  // calendar: the book grows its calendar through 2027 and posts it, dated as it is, never dated into
  // 2026 to make it fit.
  expect(await all("inbox.post", { filter, limit: 1000 })).toEqual({
    applied: scenario.payouts.length,
    failures: [],
  });
  expect((await w.call("periods.list", {})).body.data.calendar.lastDate).toBe("2027-12-31");
  const postSeconds = (performance.now() - postStarted) / 1000;
  const entries = await journals(w);
  expect(entries).toHaveLength(scenario.payouts.length);
  expect(entries.every((e) => e.debitTotal === e.creditTotal)).toBe(true);
  // The transactions went with their payouts: nothing is left to review.
  expect((await w.call("inbox.summary", {})).body.data.counts).toMatchObject({
    posted: members + scenario.payouts.length,
    toReview: 0,
  });
  // Payouts in transit hold exactly what Stripe paid out, to the cent.
  const paidOut = scenario.payouts.reduce((sum, p) => sum + BigInt(Number(p.amount)), 0n);
  const transit = (await w.call("stripe.status")).body.data.balance.inTransit as string;
  expect(transit).toBe(`${paidOut / 100n}.${String(paidOut % 100n).padStart(2, "0")}`);

  // 3. What the one-entry-per-payout booking buys: a book of this size reads back from the first
  // entry in a few seconds. One entry per transaction would be about eight times as many.
  const replayStarted = performance.now();
  await w.service.readAggregate(undefined, { verify: "full" });
  const replaySeconds = (performance.now() - replayStarted) / 1000;
  console.info(
    `stripe volume: ${total} balance transactions, ${scenario.payouts.length} payouts -> ${members + scenario.payouts.length} Inbox lines, ${scenario.payouts.length} book entries; first sync ${calls} call(s), ${requests} Stripe requests, ${syncSeconds.toFixed(1)} s; accept and post ${postSeconds.toFixed(1)} s; full replay of the book ${replaySeconds.toFixed(1)} s`,
  );
  expectWithin("the first Stripe sync", syncSeconds * 1000, 120_000);
  expectWithin("accepting and posting", postSeconds * 1000, 120_000);
  expectWithin("a full replay of the book", replaySeconds * 1000, 60_000);
}, 600_000);

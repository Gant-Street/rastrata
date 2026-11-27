import { afterEach, expect, test } from "bun:test";
import {
  ONLINE_BOOK_WITH_ADJUSTMENTS,
  type World,
  acceptAndPost,
  deposit,
  importDeposits,
  itemIdOf,
  journals,
  linesOf,
  uuid,
  world,
} from "./slice-support.ts";

/** The lane through the real Inbox: the proposer registered with the registry, proposals stored and
 * recomputed when the book's state changes, the payout matched to a bank deposit that was imported
 * from another source, and ambiguity shown with its reasons and never resolved. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});
async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ realPort: true, ...options });
  open.push(w);
  return w;
}

const PAYOUT_OF: Record<string, string> = {
  P1: "po_1Fixture00000000000107",
  P2: "po_1Fixture00000000000117",
  P3: "po_1Fixture00000000000124",
  P4: "po_1Fixture00000000000126",
  P5: "po_1Fixture00000000000128",
  P6: "po_1Fixture00000000000130",
};

interface Proposal {
  proposer: string;
  kind: string;
  confidence: number;
  reasons: string[];
  legs?: { accountId: string; amount: string }[];
  links?: { key: string; value: string }[];
}
const stripeProposals = (detail: { proposals: Proposal[] }): Proposal[] =>
  detail.proposals.filter((p) => p.proposer === "stripe");
const only = (proposals: readonly Proposal[]): Proposal => {
  const [first] = proposals;
  if (!first) throw new Error("expected a Stripe proposal");
  return first;
};
const detailOf = async (w: World, providerId: string) =>
  (await w.call("inbox.get", { itemId: await itemIdOf(w, providerId) })).body.data;

test("a deposit imported before its payout is proposed once Stripe syncs, with the reasons and the payout it cleared", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  importDeposits(w, [deposit("bank-1", "2026-03-09", "93.31")]);
  const id = await itemIdOf(w, "bank-1");
  const before = (await w.call("inbox.get", { itemId: id })).body.data;
  expect(stripeProposals(before)).toEqual([]);
  await w.call("stripe.sync", {}, uuid());
  const after = (await w.call("inbox.get", { itemId: id })).body;
  expect(after.ok).toBe(true);
  const [found, ...rest] = stripeProposals(after.data);
  const proposal = only(found ? [found] : []);
  expect(rest).toEqual([]);
  expect(proposal.kind).toBe("categorize");
  expect(proposal.confidence).toBe(97);
  expect(proposal.legs).toEqual([
    { accountId: "1000", amount: "93.31" },
    { accountId: "1110", amount: "-93.31" },
  ]);
  expect(proposal.reasons.join(" ")).toMatch(/Same amount and date as Stripe payout po_/);
  expect(proposal.reasons.join(" ")).toMatch(
    /Stripe lists 6 transactions in this payout and they add up to the payout amount to the cent/,
  );
  expect(proposal.links).toEqual([{ key: "payout", value: PAYOUT_OF.P1 as string }]);
  expect(after.data.proposalProblems).toEqual([]);
});

test("equal payouts are paired one to one with their deposits in the Inbox, each proposal naming its own payout and saying how", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  importDeposits(w, [
    deposit("bank-a", "2026-03-16", "19.12"),
    deposit("bank-b", "2026-03-17", "19.12"),
  ]);
  await w.call("stripe.sync", {}, uuid());
  const a = await itemIdOf(w, "bank-a");
  const b = await itemIdOf(w, "bank-b");
  const named: string[] = [];
  for (const id of [a, b]) {
    const detail = (await w.call("inbox.get", { itemId: id })).body.data;
    const proposal = only(stripeProposals(detail));
    expect(proposal.confidence).toBe(97);
    expect(proposal.reasons.join(" ")).toContain("2 payouts and 2 deposits of 19.12 USD");
    expect(proposal.reasons.join(" ")).toContain("the earlier payout takes the earlier deposit");
    named.push(String(proposal.links?.[0]?.value));
  }
  // Each deposit has its own payout, by the dates: the 16th is P4's, the 17th is P5's.
  expect(named).toEqual([PAYOUT_OF.P4 as string, PAYOUT_OF.P5 as string]);
  // The window changes nothing for deposits that arrive on their own days.
  await w.call("stripe.configure", { matchWindowDays: 0 }, uuid());
  const again = [await detailOf(w, "bank-a"), await detailOf(w, "bank-b")].map(
    (detail) => stripeProposals(detail)[0]?.links?.[0]?.value,
  );
  expect(again).toEqual(named);
});

test("a payout whose transactions do not add up is proposed for its deposit only with its confidence capped, and says why", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  const target = w.scenario.payouts[0];
  if (!target) throw new Error("fixture has no payout");
  // Stripe says the payout was a dollar more than the transactions it lists add up to.
  target.amount = Number(target.amount) + 100;
  importDeposits(w, [deposit("bank-1", "2026-03-09", "94.31")]);
  await w.call("stripe.sync", {}, uuid());
  const proposal = only(stripeProposals(await detailOf(w, "bank-1")));
  expect(proposal.confidence).toBe(70);
  expect(proposal.reasons.join(" ")).toMatch(/do not add up to its amount/);
  expect(proposal.reasons.join(" ")).toMatch(/Check the payout in Stripe before accepting/);
  // And the payout itself was never queued, nor the six transactions it lists: nothing is forced.
  // What is in the Inbox is the other five payouts, their eighteen transactions, and the deposit.
  expect((await w.call("inbox.summary", {})).body.data.counts.total).toBe(5 + 18 + 1);
});

test("a payout is proposed complete, balanced, with the owner's accounts and the reasons for each figure", async () => {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  await w.call("stripe.configure", { timeZone: "UTC" }, uuid());
  await w.call("stripe.sync", {}, uuid());
  const detail = await detailOf(w, PAYOUT_OF.P1 ?? "");
  const proposal = only(stripeProposals(detail));
  expect(proposal.kind).toBe("event");
  expect(proposal.confidence).toBe(100);
  expect(proposal.legs).toEqual([
    { accountId: "1110", amount: "93.31" },
    { accountId: "4000", amount: "-102.00" },
    { accountId: "2500", amount: "-1.65" },
    { accountId: "4100", amount: "5.00" },
    { accountId: "6025", amount: "5.34" },
  ]);
  const reasons = proposal.reasons.join("\n");
  expect(reasons).toMatch(
    /One entry for Stripe payout po_1Fixture00000000000107: the 6 transactions Stripe says it paid out, added up/,
  );
  expect(reasons).toMatch(/Payouts in transit: debit 93\.31 \(Payout of 93\.31 to the bank\)/);
  expect(reasons).toMatch(/Sales: credit 102\.00 \(4 lines in this payout\)/);
  expect(reasons).toMatch(/Sales tax payable: credit 1\.65 \(1 line in this payout\)/);
  expect(reasons).toMatch(/Refunds: debit 5\.00 \(1 line in this payout\)/);
  expect(reasons).toMatch(/Stripe fees: debit 5\.34 \(5 lines in this payout\)/);
  // The proposal links the payout to what it is made of, so a person can find the transactions.
  expect(proposal.links).toEqual(
    expect.arrayContaining([
      { key: "payout", value: PAYOUT_OF.P1 },
      { key: "members", value: "6" },
    ]),
  );
  expect(detail.coveredCount).toBe(6);
  // Every payout of the book is proposed, and the entry for each balances.
  const list = (
    await w.call("inbox.list", { pageSize: 50, filter: { provider: "stripe", covered: false } })
  ).body.data.items as { suggestion?: { kind: string; confidence: number } }[];
  expect(list).toHaveLength(6);
  for (const item of list)
    expect(item.suggestion).toMatchObject({ kind: "event", confidence: 100 });
});

test("a payout that carries an adjustment is shown without a proposal until an account is named for adjustments, then it is proposed", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const before = await detailOf(w, PAYOUT_OF.P2 ?? "");
  expect(stripeProposals(before)).toEqual([]);
  expect(before.item.proposalCount).toBe(0);
  const others = await detailOf(w, PAYOUT_OF.P1 ?? "");
  expect(stripeProposals(others)).toHaveLength(1);
  // The owner names one of the book's accounts for what Stripe adjusts: tagging it is enough, and
  // the proposals are made again without a new sync.
  const tag = await w.call(
    "accounts.setTags",
    { accountId: "6050", effectiveOn: "2026-01-01", tags: { roleKey: "stripe.adjustments" } },
    uuid(),
  );
  expect(tag.body.ok).toBe(true);
  const after = only(stripeProposals(await detailOf(w, PAYOUT_OF.P2 ?? "")));
  expect(after.legs).toEqual([
    { accountId: "1110", amount: "56.31" },
    { accountId: "4000", amount: "-134.00" },
    { accountId: "6026", amount: "45.00" },
    { accountId: "6025", amount: "35.69" },
    { accountId: "6050", amount: "-3.00" },
  ]);
});

test("a role key that moves on a date decides which account an entry uses: the entry's own date, not today's", async () => {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  // From the 10th of March the sales role key is on 4010 and no longer on 4000.
  for (const input of [
    { accountId: "4000", effectiveOn: "2026-03-10", tags: { roleKey: null } },
    { accountId: "4010", effectiveOn: "2026-03-10", tags: { roleKey: "revenue.sales" } },
  ]) {
    expect((await w.call("accounts.setTags", input, uuid())).body.ok).toBe(true);
  }
  const salesOf = async (label: string): Promise<string | undefined> =>
    stripeProposals(await detailOf(w, PAYOUT_OF[label] ?? ""))[0]?.legs?.find(
      (leg) => Number(leg.amount) < 0 && ["4000", "4010"].includes(leg.accountId),
    )?.accountId;
  // P1 arrives on the 9th, before the move; every other payout arrives on or after the 11th.
  expect(await salesOf("P1")).toBe("4000");
  for (const label of ["P2", "P3", "P4", "P5", "P6"]) expect(await salesOf(label)).toBe("4010");
});

test("every payout is accepted and posted, five bank deposits clear them, and what stays in transit is what Stripe returned", async () => {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  await w.call("stripe.configure", { matchWindowDays: 0 }, uuid());
  await w.call("stripe.sync", {}, uuid());
  importDeposits(w, [
    deposit("bank-p1", "2026-03-09", "93.31"),
    deposit("bank-p2", "2026-03-11", "56.31"),
    deposit("bank-p3", "2026-03-16", "125.94"),
    deposit("bank-p4", "2026-03-16", "19.12"),
    deposit("bank-p5", "2026-03-17", "19.12"),
  ]);
  const { accepted, posted } = await acceptAndPost(w);
  expect(accepted.data).toMatchObject({ applied: 6, failed: 0 });
  expect(posted.data).toMatchObject({ applied: 6, failed: 0 });
  // No deposit has been accepted yet: five payouts wait for one, and the failed one expects none.
  expect((await w.call("stripe.payouts", { filter: "unmatched" })).body.data.count).toBe(5);
  // The deposits, by the same operations: each proposal is 97% sure (same amount, same day).
  const deposits = { provider: "csv" };
  const take = await w.call(
    "inbox.accept",
    { filter: deposits, proposer: "stripe", minConfidence: 90 },
    uuid(),
  );
  expect(take.body.data).toMatchObject({ applied: 5, skipped: 0, failed: 0 });
  const post = await w.call("inbox.post", { filter: deposits }, uuid());
  expect(post.body.data).toMatchObject({ applied: 5, failed: 0 });
  // Every deposit that was accepted is a match: the payouts show it, and none is left waiting.
  const matched = (await w.call("stripe.payouts", {})).body.data.payouts as {
    deposit: string;
    status: string;
  }[];
  expect(matched.filter((p) => p.deposit === "matched")).toHaveLength(5);
  expect(matched.find((p) => p.status === "failed")?.deposit).toBe("reversed");
  expect((await w.call("stripe.payouts", { filter: "unmatched" })).body.data.count).toBe(0);
  expect((await w.call("stripe.status")).body.data.payouts).toMatchObject({
    unmatched: 0,
    reversed: 1,
  });
  // Six entries for the payouts, five for the deposits: eleven in the book, for thirty-five lines.
  const all = await journals(w);
  expect(all).toHaveLength(11);
  const clearing = all.filter((e) => e.reference === "STRIPE TRANSFER ST-0001");
  expect(clearing).toHaveLength(5);
  for (const entry of clearing) {
    expect(entry.debitTotal).toBe(entry.creditTotal);
    expect(linesOf(entry)[0]).toMatch(/^1000 Dr /);
    expect(linesOf(entry)[1]).toMatch(/^1110 Cr /);
  }
  // The one payout with no deposit is the failed one: its money went back to Stripe, and Stripe's
  // own balance says so. Payouts in transit and Stripe's pending balance are the same 19.12.
  const status = (await w.call("stripe.status")).body.data;
  expect(status.balance).toMatchObject({
    unpaid: "19.12",
    difference: "0.00",
    ties: true,
    inTransit: "19.12",
  });
  expect(status.balance.snapshot.total).toBe("19.12");
});

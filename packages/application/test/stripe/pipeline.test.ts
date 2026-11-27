import { afterEach, expect, test } from "bun:test";
import { parseMoney } from "../../src/money.ts";
import {
  ONLINE_BOOK_WITH_ADJUSTMENTS,
  type World,
  acceptAndPost,
  journals,
  linesOf,
  uuid,
  world,
} from "./slice-support.ts";

/** The Stripe lane against the real ingestion pipeline (not a fake port): identity, archive,
 * cutover, mapping, covered evidence, the "same id, different figures" flag, and posting one entry
 * per payout, as the pipeline really behaves. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});
async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ realPort: true, ...options });
  open.push(w);
  return w;
}

const count = (w: World, sql: string, ...bindings: string[]): number =>
  Number((w.service.store.query(sql).get(...bindings) as { n: number }).n);

const PAYOUT_OF: Record<string, string> = {
  P1: "po_1Fixture00000000000107",
  P2: "po_1Fixture00000000000117",
  P3: "po_1Fixture00000000000124",
  P4: "po_1Fixture00000000000126",
  P5: "po_1Fixture00000000000128",
  P6: "po_1Fixture00000000000130",
};

test("a sync through the real pipeline queues one entry per payout with its transactions as covered evidence, archives every page, and posts nothing", async () => {
  const w = await fresh();
  await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
  const sync = await w.call("stripe.sync", {}, uuid());
  expect(sync.body.ok).toBe(true);
  expect(sync.body.data.run.disposition).toBe("complete");
  expect(sync.body.data.run.newLines).toBe(30);
  expect(count(w, "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe'")).toBe(30);
  // Every line is an event: the entry for a payout, or a transaction it covers.
  expect(
    count(w, "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe' AND kind='event'"),
  ).toBe(30);
  const summary = (await w.call("inbox.summary", {})).body.data.counts;
  expect(summary).toMatchObject({ total: 30, covered: 24, posted: 0, drafted: 0 });
  // Only the six payouts are for a person to look at; the transactions are evidence.
  expect(summary.toReview).toBe(6);
  const entries = (
    await w.call("inbox.list", { pageSize: 50, filter: { provider: "stripe", covered: false } })
  ).body.data;
  expect(entries.items).toHaveLength(6);
  const evidence = (
    await w.call("inbox.list", { pageSize: 50, filter: { provider: "stripe", covered: true } })
  ).body.data;
  expect(evidence.items).toHaveLength(24);
  // Five payouts are proposed. The sixth carries an adjustment Rastrata does not book by itself and
  // the book has no account for it, so it is shown without a proposal rather than guessed.
  const proposed = entries.items.filter((i: { suggestion?: unknown }) => i.suggestion);
  expect(proposed).toHaveLength(5);
  const unproposed = entries.items.find((i: { suggestion?: unknown }) => !i.suggestion);
  expect(unproposed.line.providerId).toBe(PAYOUT_OF.P2);
  // The USD source records the Stripe balance account; the euro charge made no source at all.
  const sources = w.service.store
    .query(
      "SELECT account_key, ledger_account_id, start_on FROM app_ingest_sources WHERE provider='stripe' ORDER BY account_key",
    )
    .all();
  expect(sources).toEqual([
    {
      account_key: "stripe:acct_1FixtureAccount0001:usd",
      ledger_account_id: "1100",
      start_on: "2026-01-01",
    },
  ]);
  // Every page Stripe sent is archived under its SHA-256, and the lane keeps its own cursor: it only
  // moves once the pages before it were applied.
  expect(count(w, "SELECT COUNT(*) AS n FROM app_blobs")).toBeGreaterThanOrEqual(15);
  const cursor = w.service.store.query("SELECT cursor FROM stripe_connection").get() as {
    cursor: string;
  };
  expect(JSON.parse(cursor.cursor)).toMatchObject({ v: 1 });
  // Nothing was posted: Stripe's entries wait in the Inbox.
  expect((await w.call("journal.list", {})).body.data.entries).toEqual([]);
});

test("a transaction a payout covers is evidence: it cannot be decided on its own and follows its payout", async () => {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const evidence = (
    await w.call("inbox.list", { pageSize: 50, filter: { provider: "stripe", covered: true } })
  ).body.data.items as {
    id: string;
    status: string;
    coveredBy: { providerId: string; status: string };
  }[];
  const first = evidence[0];
  if (!first) throw new Error("no covered transaction");
  // Not accepted, excluded, categorised or posted by itself, and nothing is proposed for it.
  for (const [name, input] of [
    ["inbox.accept", { itemIds: [first.id], proposer: "stripe" }],
    ["inbox.exclude", { itemIds: [first.id], reason: "no" }],
    ["inbox.categorize", { itemIds: [first.id], accountId: "4000" }],
    ["inbox.post", { itemIds: [first.id] }],
  ] as const) {
    const result = await w.call(name, input, uuid());
    expect(result.body.data.results[0]).toMatchObject({ outcome: "skipped", code: "covered" });
    expect(result.body.data.results[0].message).toContain(first.coveredBy.providerId);
  }
  const detail = (await w.call("inbox.get", { itemId: first.id })).body.data;
  expect(detail.proposals).toEqual([]);
  // Posting the payout takes its transactions with it.
  const { accepted, posted } = await acceptAndPost(w);
  expect(accepted.data).toMatchObject({ applied: 6, failed: 0 });
  expect(posted.data).toMatchObject({ applied: 6, failed: 0 });
  const after = (
    await w.call("inbox.list", { pageSize: 50, filter: { provider: "stripe", covered: true } })
  ).body.data.items as { status: string }[];
  expect(after.every((i) => i.status === "posted")).toBe(true);
  // Nothing is left to review: the transactions went with their payouts.
  expect((await w.call("inbox.summary", {})).body.data.counts).toMatchObject({
    total: 30,
    posted: 30,
    toReview: 0,
    covered: 0,
  });
});

test("each payout posts as one balanced entry dated on its arrival, and together they tie to Stripe to the cent", async () => {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const { posted } = await acceptAndPost(w);
  expect(posted.data).toMatchObject({ applied: 6, skipped: 0, failed: 0 });
  // Thirty lines in the Inbox, six entries in the books: the cost of the book follows the payouts.
  const all = await journals(w);
  expect(all).toHaveLength(6);
  const byReference = new Map(all.map((e) => [e.reference, e]));
  const entryFor = (label: string, transactions: number) => {
    const entry = byReference.get(
      `Stripe payout ${PAYOUT_OF[label]} (${transactions} ${transactions === 1 ? "transaction" : "transactions"})`,
    );
    if (!entry) throw new Error(`no entry for ${label}`);
    return entry;
  };
  // Every entry balances to 0.00 and is dated on the day its payout arrives.
  for (const entry of all) expect(entry.debitTotal).toBe(entry.creditTotal);
  const p1 = entryFor("P1", 6);
  expect(p1.isoDate).toBe("2026-03-09");
  expect(linesOf(p1)).toEqual([
    "1110 Dr 93.31", // the payout, in transit to the bank
    "4000 Cr 102.00", // sales, before the tax Stripe reported on one charge
    "2500 Cr 1.65", // the sales tax on it, from Stripe's own figure
    "4100 Dr 5.00", // the refund
    "6025 Dr 5.34", // Stripe's fees, all five of them and the standalone one
  ]);
  const p2 = entryFor("P2", 9);
  expect(p2.isoDate).toBe("2026-03-11");
  expect(linesOf(p2)).toEqual([
    "1110 Dr 56.31",
    "4000 Cr 134.00",
    "6026 Dr 45.00", // two disputes, 20.00 and 25.00
    "6025 Dr 35.69", // including the two 15.00 dispute fees
    "6040 Cr 3.00", // the adjustment Stripe made in the owner's favour
  ]);
  const p3 = entryFor("P3", 6);
  expect(p3.isoDate).toBe("2026-03-16");
  expect(linesOf(p3)).toEqual([
    "1110 Dr 125.94",
    "4000 Cr 90.00",
    "6026 Cr 25.00", // a dispute won
    "6025 Cr 10.94", // its 15.00 fee returned, less the fees of the sales it was paid out with
  ]);
  for (const [label, date] of [
    ["P4", "2026-03-16"],
    ["P5", "2026-03-17"],
    ["P6", "2026-03-18"],
  ] as const) {
    const entry = entryFor(label, 1);
    expect(entry.isoDate).toBe(date);
    expect(linesOf(entry)).toEqual(["1110 Dr 19.12", "4000 Cr 20.00", "6025 Dr 0.88"]);
  }
  // The payouts in transit are exactly what Stripe paid out, to the cent, and the books balance.
  let transit = 0n;
  let debits = 0n;
  let credits = 0n;
  for (const entry of all) {
    debits += parseMoney(entry.debitTotal);
    credits += parseMoney(entry.creditTotal);
    for (const line of entry.lines)
      if (line.accountId === "1110") transit += parseMoney(line.debit ?? "0.00");
  }
  expect(debits).toBe(credits);
  const paidOut = w.scenario.payouts.reduce((sum, p) => sum + BigInt(Number(p.amount)), 0n);
  expect(transit).toBe(paidOut);
  expect(transit).toBe(33292n);
  // The journal itself says which transactions it stands for, and can be found by its identity.
  const detail = (await w.call("inbox.get", { itemId: await itemOf(w, PAYOUT_OF.P1 ?? "") })).body
    .data;
  expect(detail.item.status).toBe("posted");
  expect(detail.provenance.sourceEventId).toBe(`stripe-payout-${PAYOUT_OF.P1}`);
  expect(detail.provenance.evidenceReference).toMatch(
    new RegExp(
      `^ingest:bt_[0-9a-f]+:0 stripe:payout:${PAYOUT_OF.P1}:members=6:sha256=[0-9a-f]{64}$`,
    ),
  );
  expect(detail.coveredCount).toBe(6);
  // The books and Stripe agree on what is in Stripe: the one transaction not yet paid out.
  const status = (await w.call("stripe.status")).body.data;
  expect(status.balance).toMatchObject({
    unpaid: "19.12",
    difference: "0.00",
    ties: true,
    inTransit: "332.92",
  });
});

async function itemOf(w: World, providerId: string): Promise<string> {
  const page = await w.call("inbox.list", {
    pageSize: 50,
    filter: { provider: "stripe", covered: false },
  });
  const found = (page.body.data.items as { id: string; line: { providerId: string } }[]).find(
    (i) => i.line.providerId === providerId,
  );
  if (!found) throw new Error(`no item ${providerId}`);
  return found.id;
}

test("the runner's own memory can be lost and the pipeline still refuses to duplicate anything", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const items = count(w, "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe'");
  // Forget everything the lane remembers: its cursor, the transactions and the payouts it has seen.
  w.service.store.query("DELETE FROM stripe_transactions").run();
  w.service.store.query("DELETE FROM stripe_payouts").run();
  w.service.store.query("UPDATE stripe_connection SET cursor=NULL").run();
  w.clock.ms += 3600_000;
  const again = await w.call("stripe.sync", {}, uuid());
  expect(again.body.ok).toBe(true);
  expect(again.body.data.run.newLines).toBe(0);
  expect(again.body.data.run.duplicateLines).toBe(items);
  expect(count(w, "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe'")).toBe(
    items,
  );
  expect(count(w, "SELECT COUNT(*) AS n FROM app_ingest_conflicts")).toBe(0);
});

test("if Stripe ever reports different figures under a known id, the original stays and the conflict is flagged", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const items = count(w, "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe'");
  w.service.store.query("DELETE FROM stripe_transactions").run();
  w.service.store.query("DELETE FROM stripe_payouts").run();
  w.service.store.query("UPDATE stripe_connection SET cursor=NULL").run();
  // Two charges of one payout swap 1.00 of fees between them: the payout still adds up to the cent,
  // so only their own lines differ from what was imported (a bug, a hack or a replay of old data).
  const find = (id: string): Record<string, unknown> => {
    const entry = w.scenario.entries.find((e) => e.bt.id === id);
    if (!entry) throw new Error(`no ${id}`);
    return entry.bt as Record<string, unknown>;
  };
  const a = find("txn_1Fixture00000000000101");
  const b = find("txn_1Fixture00000000000105");
  Object.assign(a, { fee: 98, net: 1902 });
  Object.assign(b, { fee: 78, net: 1922 });
  w.clock.ms += 3600_000;
  const again = await w.call("stripe.sync", {}, uuid());
  expect(again.body.ok).toBe(true);
  expect(again.body.data.run.newLines).toBe(0);
  expect(again.body.data.run.duplicateLines).toBe(items - 2);
  expect(again.body.data.run.notes.join(" ")).toMatch(
    /2 lines already in the Inbox were reported by Stripe with different figures/,
  );
  expect(count(w, "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider='stripe'")).toBe(
    items,
  );
  expect(count(w, "SELECT COUNT(*) AS n FROM app_ingest_conflicts")).toBe(2);
  // The original line is the one still in the Inbox.
  const kept = w.service.store
    .query("SELECT amount FROM app_ingest_items WHERE provider_id=?")
    .get("txn_1Fixture00000000000101") as { amount: string };
  expect(kept.amount).toBe("19.12");
});

import { afterEach, expect, test } from "bun:test";
import type {
  BankLine,
  IngestItem,
  LedgerEvent,
  NearbyQuery,
  ProposalContext,
} from "../../src/ingest-types.ts";
import { parseMoney } from "../../src/money.ts";
import { registeredProposers } from "../../src/slices/ingest/proposers.ts";
import { STRIPE_PROPOSER, proposeStripe } from "../../src/slices/stripe/proposer.ts";
import {
  type RoleKeyOf,
  type StripeSettings,
  parseSettings,
} from "../../src/slices/stripe/settings.ts";
import { type PayoutRow, stripeStore } from "../../src/slices/stripe/store.ts";
import { LABELS, summarise, summary } from "./support.ts";
import { buildScenario } from "./fixtures.ts";
import { type World, uuid, world } from "./slice-support.ts";

const MAPPING = [
  { role: "stripe.balance", accountId: "1100" },
  { role: "payouts.in-transit", accountId: "1110" },
  { role: "tax.sales", accountId: "2500" },
  { role: "revenue.sales", accountId: "4000" },
  { role: "refunds", accountId: "4100" },
  { role: "stripe.fees", accountId: "6025" },
  { role: "chargebacks", accountId: "6026" },
  { role: "stripe.adjustments", accountId: "6040" },
] as const;

const settings = (over: Partial<StripeSettings> = {}): StripeSettings => ({
  mapping: MAPPING,
  syncFrom: "2026-01-01",
  timeZone: "UTC",
  salesTax: "stripe",
  overlapDays: 3,
  matchWindowDays: 2,
  accountKey: "stripe:acct_1FixtureAccount0001",
  ...over,
});

/** No chart keys at all: the owner chose every account. */
const noKeys: RoleKeyOf = () => undefined;

const accounts = (closed: Readonly<Record<string, string>> = {}): ProposalContext["accounts"] =>
  ["1000", "1100", "1110", "2500", "4000", "4010", "4100", "6025", "6026", "6040"].map((id) => ({
    id,
    code: id,
    name: `Account ${id}`,
    role: id.startsWith("1")
      ? "asset"
      : id.startsWith("2")
        ? "liability"
        : id.startsWith("4")
          ? "income"
          : "expense",
    closedOn: closed[id] ?? null,
  }));

const payout = (
  id: string,
  amount: number,
  arrivalOn: string,
  over: Partial<PayoutRow> = {},
): PayoutRow => ({
  id,
  amountCents: BigInt(amount),
  currency: "USD",
  createdOn: arrivalOn,
  arrivalOn,
  status: "paid",
  automatic: true,
  reconciliationStatus: "completed",
  reversed: false,
  memberCount: 3,
  memberNetCents: BigInt(amount),
  booking: "summarised",
  bookingReason: null,
  heldKind: null,
  membersSha256: null,
  ...over,
});

const deposit = (
  id: string,
  amount: string,
  postedOn: string,
  over: Partial<IngestItem> = {},
  line: Partial<BankLine> = {},
): IngestItem => ({
  id,
  batchId: "batch-1",
  status: "new",
  ledgerAccountId: "1000",
  line: {
    kind: "bankLine",
    provider: "csv",
    accountKey: "csv:checking",
    providerId: id,
    rawIndex: 0,
    postedOn,
    amount,
    currency: "USD",
    description: "STRIPE TRANSFER",
    ...line,
  },
  ...over,
});

/** A context whose `nearby` answers from a list of items, as the Inbox does. */
const contextWith = (
  items: readonly IngestItem[],
  closed: Readonly<Record<string, string>> = {},
): ProposalContext => ({
  accounts: accounts(closed),
  currency: "USD",
  nearby: (query: NearbyQuery) =>
    items.filter(
      (i) =>
        (query.kind === undefined || i.line.kind === query.kind) &&
        (query.amount === undefined ||
          (i.line.kind === "bankLine" && i.line.amount === query.amount)) &&
        i.line.kind === "bankLine" &&
        i.line.postedOn >= query.from &&
        i.line.postedOn <= query.to,
    ),
});

const asItem = (event: LedgerEvent): IngestItem => ({
  id: `i-${event.providerId}`,
  batchId: "b",
  status: "new",
  ledgerAccountId: "1100",
  line: event,
});

const scenario = buildScenario();
const entry = (label: string, overrides = {}): LedgerEvent =>
  summary(summarise(scenario, label, overrides)).payout;

test("a payout's entry is proposed whole, with the owner's accounts, and balances to the cent", () => {
  for (const label of LABELS) {
    const event = entry(label);
    const [proposal, ...rest] = proposeStripe(
      asItem(event),
      contextWith([]),
      settings(),
      [],
      noKeys,
    );
    expect(rest).toEqual([]);
    expect(proposal?.proposer).toBe(STRIPE_PROPOSER);
    expect(proposal?.kind).toBe("event");
    expect(proposal?.confidence).toBe(1);
    expect(proposal?.reasons.length).toBeGreaterThan(1);
    expect(proposal?.narration).toBe(event.summary);
    expect(proposal?.links).toEqual(event.links ?? {});
    const legs = proposal?.legs ?? [];
    expect(legs.reduce((sum, leg) => sum + parseMoney(leg.amount), 0n)).toBe(0n);
    expect(legs.every((leg) => accounts().some((a) => a.id === leg.accountId))).toBe(true);
    expect(new Set(legs.map((l) => l.accountId)).size).toBe(legs.length);
  }
  expect(
    proposeStripe(asItem(entry("P1")), contextWith([]), settings(), [], noKeys)[0]?.legs,
  ).toEqual([
    { accountId: "1110", amount: "93.31" },
    { accountId: "4000", amount: "-102.00" },
    { accountId: "2500", amount: "-1.65" },
    { accountId: "4100", amount: "5.00" },
    { accountId: "6025", amount: "5.34" },
  ]);
  // The reasons say what each figure is made of, and stay within what the Inbox shows.
  const reasons =
    proposeStripe(asItem(entry("P2")), contextWith([]), settings(), [], noKeys)[0]?.reasons ?? [];
  expect(reasons.length).toBeLessThanOrEqual(8);
  expect(reasons.every((r) => r.length <= 300)).toBe(true);
  expect(reasons[0]).toBe(
    "One entry for Stripe payout po_1Fixture00000000000117: the 9 transactions Stripe says it paid out, added up. Their figures are Stripe's own and nothing is estimated; the transactions are listed with it as evidence.",
  );
});

test("a transaction a payout covers is never proposed on its own: that would book it twice", () => {
  const outcome = summary(summarise(scenario, "P1"));
  expect(outcome.members).toHaveLength(6);
  for (const { event } of outcome.members) {
    expect(event.coveredBy).toBe("po_1Fixture00000000000107");
    expect(proposeStripe(asItem(event), contextWith([]), settings(), [], noKeys)).toEqual([]);
  }
});

test("nothing is proposed when a role has no account, an account is closed on the day, or the item is not Stripe's", () => {
  const p1 = asItem(entry("P1"));
  expect(proposeStripe(p1, contextWith([]), null, [], noKeys)).toEqual([]);
  expect(
    proposeStripe(p1, contextWith([]), settings({ mapping: MAPPING.slice(1) }), [], noKeys),
  ).toEqual([]);
  // The entry is dated 9 March: an account closed on or before then cannot be used for it.
  expect(
    proposeStripe(p1, contextWith([], { "6025": "2026-03-01" }), settings(), [], noKeys),
  ).toEqual([]);
  expect(
    proposeStripe(p1, contextWith([], { "6025": "2026-03-10" }), settings(), [], noKeys).length,
  ).toBe(1);
  const other = asItem({ ...entry("P1"), provider: "csv" });
  expect(proposeStripe(other, contextWith([]), settings(), [], noKeys)).toEqual([]);
  // A payout that carries an adjustment is not proposed while no account is named for adjustments.
  const p2 = asItem(entry("P2"));
  const without = settings({ mapping: MAPPING.filter((m) => m.role !== "stripe.adjustments") });
  expect(proposeStripe(p2, contextWith([]), without, [], noKeys)).toEqual([]);
  expect(proposeStripe(p1, contextWith([]), without, [], noKeys)).toHaveLength(1);
  // Without tax splitting, the sales tax account is not needed, and the entry has no tax leg.
  const untaxed = entry("P1", { taxFor: () => ({ state: "none" }) });
  const noTax = settings({
    salesTax: "none",
    mapping: MAPPING.filter((m) => m.role !== "tax.sales"),
  });
  expect(proposeStripe(asItem(untaxed), contextWith([]), noTax, [], noKeys)[0]?.legs).toEqual([
    { accountId: "1110", amount: "93.31" },
    { accountId: "4000", amount: "-103.65" },
    { accountId: "4100", amount: "5.00" },
    { accountId: "6025", amount: "5.34" },
  ]);
});

test("a role the owner did not choose takes the account the chart's key names on the entry's own date", () => {
  const keysFromChart: RoleKeyOf = (accountId, asOf) => {
    const on = (id: string, key: string, from = "0001-01-01", until = "9999-12-31") =>
      accountId === id && asOf >= from && asOf < until ? key : undefined;
    return (
      on("1100", "stripe.balance") ??
      on("1110", "payouts.in-transit") ??
      on("2500", "tax.sales") ??
      // Sales move from 4000 to 4010 on the 10th of March.
      on("4000", "revenue.sales", "0001-01-01", "2026-03-10") ??
      on("4010", "revenue.sales", "2026-03-10") ??
      on("4100", "refunds") ??
      on("6025", "stripe.fees") ??
      on("6026", "chargebacks") ??
      on("6040", "stripe.adjustments")
    );
  };
  const nothingChosen = settings({ mapping: [] });
  const sales = (label: string): string | undefined =>
    proposeStripe(
      asItem(entry(label)),
      contextWith([]),
      nothingChosen,
      [],
      keysFromChart,
    )[0]?.legs?.find(
      (leg) => parseMoney(leg.amount) < 0n && ["4000", "4010"].includes(leg.accountId),
    )?.accountId;
  expect(sales("P1")).toBe("4000"); // arrives 9 March
  expect(sales("P2")).toBe("4010"); // arrives 11 March
  expect(sales("P6")).toBe("4010");
  // What the owner chose still wins over the key.
  const chosen = settings({ mapping: [{ role: "revenue.sales", accountId: "4000" }] });
  expect(
    proposeStripe(asItem(entry("P2")), contextWith([]), chosen, [], keysFromChart)[0]?.legs?.some(
      (l) => l.accountId === "4000",
    ),
  ).toBe(true);
  // No key and no choice: nothing is proposed, and nothing is guessed.
  expect(proposeStripe(asItem(entry("P1")), contextWith([]), nothingChosen, [], noKeys)).toEqual(
    [],
  );
});

test("a bank deposit of exactly a payout's amount near its arrival date clears payouts in transit", () => {
  const item = deposit("d1", "93.31", "2026-03-09");
  const [proposal, ...rest] = proposeStripe(
    item,
    contextWith([item]),
    settings(),
    [payout("po_1", 9331, "2026-03-09")],
    noKeys,
  );
  expect(rest).toEqual([]);
  expect(proposal).toMatchObject({
    proposer: "stripe",
    kind: "categorize",
    confidence: 0.97,
    links: { payout: "po_1" },
    narration: "Stripe payout po_1 deposited",
  });
  expect(proposal?.legs).toEqual([
    { accountId: "1000", amount: "93.31" },
    { accountId: "1110", amount: "-93.31" },
  ]);
  expect(proposal?.reasons[0]).toContain("Same amount and date as Stripe payout po_1");
  expect(proposal?.reasons[1]).toBe(
    "Stripe lists 3 transactions in this payout and they add up to the payout amount to the cent.",
  );
  const near = deposit("d2", "93.31", "2026-03-10");
  expect(
    proposeStripe(
      near,
      contextWith([near]),
      settings(),
      [payout("po_1", 9331, "2026-03-09")],
      noKeys,
    )[0]?.confidence,
  ).toBe(0.9);
});

test("a payout whose entry cannot be made is matched to its deposit only with a capped confidence, and says to check it", () => {
  const item = deposit("d1", "93.31", "2026-03-09");
  for (const booking of ["mismatch", "invalid", "empty"] as const) {
    const proposal = proposeStripe(
      item,
      contextWith([item]),
      settings(),
      [payout("po_1", 9331, "2026-03-09", { booking })],
      noKeys,
    )[0];
    expect(proposal?.confidence).toBe(0.7);
    expect(proposal?.reasons.join(" ")).toContain("Check the payout in Stripe before accepting");
  }
  // Still being itemised is only a matter of time: the match is as sure as ever.
  const waiting = proposeStripe(
    item,
    contextWith([item]),
    settings(),
    [payout("po_1", 9331, "2026-03-09", { booking: "waiting", memberCount: null })],
    noKeys,
  )[0];
  expect(waiting?.confidence).toBe(0.97);
  expect(waiting?.reasons.join(" ")).toContain("has not finished itemising this payout");
  // A payout held for a person has no entry against payouts in transit, so no deposit clears it
  // here: the Inbox pairs its line with the deposit, whatever the amount and date.
  expect(
    proposeStripe(
      item,
      contextWith([item]),
      settings(),
      [payout("po_1", 9331, "2026-03-09", { booking: "held", heldKind: "manual" })],
      noKeys,
    ),
  ).toEqual([]);
});

test("equal payouts are paired one to one with their deposits, the closest dates first, and the proposal says how", () => {
  const payouts = [payout("po_1", 1912, "2026-03-16"), payout("po_2", 1912, "2026-03-17")];
  const d1 = deposit("d1", "19.12", "2026-03-16");
  const d2 = deposit("d2", "19.12", "2026-03-17");
  const first = proposeStripe(d1, contextWith([d1, d2]), settings(), payouts, noKeys)[0];
  const second = proposeStripe(d2, contextWith([d1, d2]), settings(), payouts, noKeys)[0];
  expect(first).toMatchObject({ confidence: 0.97, links: { payout: "po_1" } });
  expect(second).toMatchObject({ confidence: 0.97, links: { payout: "po_2" } });
  expect(first?.reasons.join(" ")).toContain("2 payouts and 2 deposits of 19.12 USD within 2 days");
  expect(first?.reasons.join(" ")).toContain("the earlier payout takes the earlier deposit");
  expect(first?.legs).toEqual([
    { accountId: "1000", amount: "19.12" },
    { accountId: "1110", amount: "-19.12" },
  ]);
  // A steady lag pairs each deposit with the payout a day before it, at the near confidence.
  const l1 = deposit("l1", "19.12", "2026-03-17");
  const l2 = deposit("l2", "19.12", "2026-03-18");
  const lagged = proposeStripe(l2, contextWith([l1, l2]), settings(), payouts, noKeys)[0];
  expect(lagged).toMatchObject({ confidence: 0.9, links: { payout: "po_2" } });
  // Two payouts and one deposit: the deposit belongs to the one on its own day.
  const alone = proposeStripe(d2, contextWith([d2]), settings(), payouts, noKeys)[0];
  expect(alone).toMatchObject({ confidence: 0.97, links: { payout: "po_2" } });
});

test("a pairing with a doubt is still made, at a lower confidence, and says it is a choice between equals", () => {
  // One payout, two deposits equally close: the earlier deposit is used, the other has no payout.
  const payouts = [payout("po_1", 1912, "2026-03-17")];
  const d1 = deposit("d1", "19.12", "2026-03-16");
  const d2 = deposit("d2", "19.12", "2026-03-18");
  const chosen = proposeStripe(d1, contextWith([d1, d2]), settings(), payouts, noKeys)[0];
  expect(chosen).toMatchObject({ confidence: 0.6, links: { payout: "po_1" } });
  expect(chosen?.reasons.join(" ")).toContain("a choice between equals");
  expect(proposeStripe(d2, contextWith([d1, d2]), settings(), payouts, noKeys)).toEqual([]);
  // A payout that already has a deposit of its own is not offered to a second one.
  const sure = deposit("d3", "19.12", "2026-03-17");
  expect(
    proposeStripe(
      d1,
      contextWith([sure, d1]),
      settings(),
      [payout("po_1", 1912, "2026-03-17")],
      noKeys,
    ),
  ).toEqual([]);
});

test("no proposal when there is no such payout, the payout failed, or the line is not a deposit", () => {
  const item = deposit("d1", "19.13", "2026-03-16");
  const one = [payout("po_1", 1912, "2026-03-16")];
  expect(proposeStripe(item, contextWith([item]), settings(), one, noKeys)).toEqual([]);
  const failed = deposit("d2", "19.12", "2026-03-16");
  expect(
    proposeStripe(
      failed,
      contextWith([failed]),
      settings(),
      [payout("po_1", 1912, "2026-03-16", { reversed: true, status: "failed" })],
      noKeys,
    ),
  ).toEqual([]);
  const withdrawal = deposit("d3", "-19.12", "2026-03-16");
  expect(proposeStripe(withdrawal, contextWith([withdrawal]), settings(), one, noKeys)).toEqual([]);
  const stripeHeld = deposit("d4", "19.12", "2026-03-16", {}, { provider: "stripe" });
  expect(proposeStripe(stripeHeld, contextWith([stripeHeld]), settings(), one, noKeys)).toEqual([]);
  const unmapped = deposit("d5", "19.12", "2026-03-16", { ledgerAccountId: null });
  expect(proposeStripe(unmapped, contextWith([unmapped]), settings(), one, noKeys)).toEqual([]);
  const euro = deposit("d6", "19.12", "2026-03-16", {}, { currency: "EUR" });
  expect(proposeStripe(euro, contextWith([euro]), settings(), one, noKeys)).toEqual([]);
  // Payouts in transit closed before the deposit: nothing to clear.
  const late = deposit("d7", "19.12", "2026-03-16");
  expect(
    proposeStripe(late, contextWith([late], { "1110": "2026-03-01" }), settings(), one, noKeys),
  ).toEqual([]);
});

test("a deposit a person already excluded takes no payout, so it cannot cast doubt on another", () => {
  const live = deposit("d1", "19.12", "2026-03-16");
  const excluded = deposit("d2", "19.12", "2026-03-17", { status: "excluded" });
  const p = proposeStripe(
    live,
    contextWith([live, excluded]),
    settings(),
    [payout("po_1", 1912, "2026-03-16")],
    noKeys,
  )[0];
  expect(p?.confidence).toBe(0.97);
  expect(p?.links).toEqual({ payout: "po_1" });
});

test("the proposer is deterministic: the same item and snapshot give the same proposals", () => {
  const item = deposit("d1", "19.12", "2026-03-17");
  const payouts = [payout("po_2", 1912, "2026-03-17"), payout("po_1", 1912, "2026-03-16")];
  const a = proposeStripe(item, contextWith([item]), settings(), payouts, noKeys);
  const b = proposeStripe(item, contextWith([item]), settings(), [...payouts].reverse(), noKeys);
  expect(b).toEqual(a);
});

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

test("the proposer is registered with the Inbox registry and its revision tracks settings, payouts and the chart's keys", async () => {
  const w = await world();
  open.push(w);
  const registration = registeredProposers().find((r) => r.name === "stripe");
  expect(registration).toBeDefined();
  const before = registration?.revision?.(w.service);
  await w.call("stripe.configure", {}, uuid());
  const configured = registration?.revision?.(w.service);
  expect(configured).not.toBe(before);
  expect(registration?.create(w.service).name).toBe("stripe");
  // Syncing adds payouts, which changes the revision so stored proposals are recomputed.
  await w.call("stripe.sync", {}, uuid());
  const synced = registration?.revision?.(w.service);
  expect(synced).not.toBe(configured);
  expect(registration?.revision?.(w.service)).toBe(synced);
  // So does a change to a role key: the account an entry uses can be a different one now.
  await w.call(
    "accounts.setTags",
    { accountId: "6050", effectiveOn: "2026-01-01", tags: { roleKey: "stripe.adjustments" } },
    uuid(),
  );
  expect(registration?.revision?.(w.service)).not.toBe(synced);
  // The proposer reads the saved settings and the payouts it learned.
  const store = stripeStore(w.service);
  expect(parseSettings(store.settingsBody())?.accountKey).toBe("stripe:acct_1FixtureAccount0001");
  const booked = store.payouts().find((p) => p.amountCents === 9331n);
  expect(booked).toMatchObject({ booking: "summarised", memberCount: 6, memberNetCents: 9331n });
  // A proposer made now sees the payouts the sync learned, and the accounts the chart's keys name.
  const proposer = registration?.create(w.service);
  const bank = deposit(
    "d1",
    (Number(booked?.amountCents ?? 0n) / 100).toFixed(2),
    booked?.arrivalOn ?? "2026-03-09",
  );
  const context = {
    accounts: (await w.service.accounts()).accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      role: a.role,
      closedOn: a.closedOn,
    })),
    currency: "USD",
    nearby: () => [bank],
  };
  const proposals = proposer?.propose(bank, context);
  expect(proposals?.length).toBe(1);
  expect(proposals?.[0]?.links?.payout).toBe(booked?.id);
  expect(proposals?.[0]?.legs).toEqual([
    { accountId: "1000", amount: "93.31" },
    { accountId: "1110", amount: "-93.31" },
  ]);
});

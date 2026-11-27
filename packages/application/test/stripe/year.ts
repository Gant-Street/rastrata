import { addDays } from "../../src/stripe/dates.ts";
import {
  type Entry,
  type Json,
  type Scenario,
  accountObject,
  balanceTransaction,
  chargeObject,
  payoutObject,
  refundObject,
  sessionObject,
  ts,
} from "./fixtures.ts";

/** The volume the lane is designed for: a year of a small online business, about 2,000 balance
 * transactions and about 250 payouts. Shared by the tests that hold the lane to that size. */

const DAYS = 365;

/** `days` shortens it, for a test that must not depend on the day it runs (the days all fall before the clock of the book that reads them). */
export function yearOfActivity(days: number = DAYS): Scenario {
  const entries: Entry[] = [];
  const payouts: Json[] = [];
  const sessions: Json[] = [];
  const labels: Record<string, string> = {};
  let n = 1000;
  const start = "2026-01-01";
  let pending: Entry[] = [];
  const unpaid = (e: Entry): Entry => ({ ...e, payout: null });
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const weekday = (d + 4) % 7; // 2026-01-01 is a Thursday
    const today: Entry[] = [];
    const charges = 3 + (d % 5);
    for (let c = 0; c < charges; c++) {
      const id = ++n;
      const created = ts(`${date}T${String(8 + c).padStart(2, "0")}:15:00Z`);
      const pi = `pi_1Fixture${String(id).padStart(14, "0")}`;
      const charge = chargeObject(id, { amount: 2000, created, paymentIntent: pi });
      sessions.push(sessionObject(id, { paymentIntent: pi, total: 2000, tax: 0, created }));
      today.push({
        bt: balanceTransaction(id, {
          category: "charge",
          type: "charge",
          amount: 2000,
          fee: 88,
          created,
          source: String(charge.id),
        }),
        source: charge,
        payout: null,
      });
    }
    if (d % 17 === 5) {
      const id = ++n;
      const created = ts(`${date}T17:30:00Z`);
      const refund = refundObject(id, {
        amount: 500,
        created,
        charge: String(today[0]?.source?.id),
        paymentIntent: null,
        btId: `txn_1Fixture${String(id).padStart(14, "0")}`,
      });
      today.push({
        bt: balanceTransaction(id, {
          category: "refund",
          type: "refund",
          amount: -500,
          created,
          source: String(refund.id),
        }),
        source: refund,
        payout: null,
      });
    }
    if (d % 30 === 0) {
      today.push({
        bt: balanceTransaction(++n, {
          category: "fee",
          type: "stripe_fee",
          amount: -150,
          created: ts(`${date}T06:00:00Z`),
          source: null,
        }),
        source: null,
        payout: null,
      });
    }
    pending.push(...today);
    if (weekday < 1 || weekday > 5) continue;
    // A payout of everything since the last one, to the cent.
    const label = `D${d}`;
    const amount = pending.reduce((sum, e) => sum + Number(e.bt.net), 0);
    const id = ++n;
    const po = payoutObject(id, {
      amount,
      created: ts(`${date}T20:00:00Z`),
      arrival: addDays(date, 1),
      btId: `txn_1Fixture${String(id).padStart(14, "0")}`,
    });
    payouts.push(po);
    labels[label] = String(po.id);
    entries.push(...pending.map((e) => ({ ...e, payout: label })));
    entries.push({
      bt: balanceTransaction(id, {
        category: "payout",
        type: "payout",
        amount: -amount,
        created: ts(`${date}T20:00:00Z`),
        source: String(po.id),
      }),
      source: po,
      payout: null,
    });
    pending = [];
  }
  entries.push(...pending.map(unpaid));
  return {
    account: accountObject(),
    entries,
    payouts,
    sessions,
    invoicePayments: [],
    labels,
    now: ts("2027-01-02T12:00:00Z"),
  };
}

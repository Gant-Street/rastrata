import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { money } from "@rastrata/plugin-sdk";
import { manifestToInstallPayload } from "@rastrata/plugin-sdk/runner";
import { testPlugin } from "@rastrata/plugin-sdk/testing";
import { stripePlugin } from "../src/index.ts";

const ARRIVAL = Math.floor(Date.parse("2026-10-10T00:00:00Z") / 1000);
const TX_TIME = Math.floor(Date.parse("2026-10-08T14:00:00Z") / 1000);

describe("@rastrata/plugin-stripe", () => {
  test("manifest.json matches manifestToInstallPayload(stripePlugin.manifest)", () => {
    const file = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
    expect(file).toEqual(manifestToInstallPayload(stripePlugin.manifest));
  });
  test("passes all five invariants and balances charges + tax + refund + dispute to exact cent", async () => {
    // Breakdown of payout po_1001:
    // 1. Charge $108.00 gross ($100.00 sales + $8.00 sales tax), $3.43 fee -> $104.57 net
    // 2. Refund -$20.00 gross, $0.00 fee -> -$20.00 net
    // 3. Dispute -$15.00 gross, $15.00 dispute fee -> -$30.00 net
    // Total payout net = $104.57 - $20.00 - $30.00 = $54.57 (5457 cents)
    const report = await testPlugin(stripePlugin, {
      config: { salesTax: "metadata" },
      now: () => "2026-10-15T12:00:00.000Z",
      routes: {
        "GET https://api.stripe.com/v1/account": {
          body: { id: "acct_1TestCo", default_currency: "usd" },
        },
        "GET https://api.stripe.com/v1/payouts?status=paid&limit=100": {
          body: {
            has_more: false,
            data: [
              {
                id: "po_1001",
                amount: 5457,
                currency: "usd",
                arrival_date: ARRIVAL,
                created: TX_TIME,
                status: "paid",
                automatic: true,
              },
            ],
          },
        },
        "GET https://api.stripe.com/v1/balance": {
          body: {
            available: [{ amount: 2500, currency: "usd" }],
            pending: [{ amount: 500, currency: "usd" }],
          },
        },
        "GET https://api.stripe.com/v1/balance_transactions?payout=po_1001&limit=100": {
          body: {
            has_more: false,
            data: [
              {
                id: "txn_po_row",
                amount: -5457,
                fee: 0,
                net: -5457,
                currency: "usd",
                created: ARRIVAL,
                reporting_category: "payout",
              },
              {
                id: "txn_charge_1",
                amount: 10800,
                fee: 343,
                net: 10457,
                currency: "usd",
                created: TX_TIME,
                reporting_category: "charge",
                metadata: { tax_amount: "800" },
              },
              {
                id: "txn_refund_1",
                amount: -2000,
                fee: 0,
                net: -2000,
                currency: "usd",
                created: TX_TIME,
                reporting_category: "refund",
              },
              {
                id: "txn_dispute_1",
                amount: -1500,
                fee: 1500,
                net: -3000,
                currency: "usd",
                created: TX_TIME,
                reporting_category: "dispute",
              },
            ],
          },
        },
      },
    });

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({
      batchCount: 1,
      bankLineCount: 0,
      eventCount: 4, // 1 payout summary + 3 covered evidence lines
      balanceCheckCount: 1,
    });

    const batch = report.batches[0];
    expect(batch?.sourceKey).toBe("stripe:acct_1TestCo:usd");
    const payout = batch?.lines[0];
    expect(payout?.kind).toBe("event");
    if (payout?.kind === "event") {
      expect(payout.providerId).toBe("po_1001");
      expect(payout.eventOn).toBe("2026-10-10");
      expect(payout.coveredBy).toBeUndefined();
      expect(payout.legs).toEqual([
        { role: "payouts.in-transit", amount: "54.57" },
        { role: "revenue.sales", amount: "-100.00" },
        { role: "tax.sales", amount: "-8.00" },
        { role: "refunds", amount: "20.00" },
        { role: "chargebacks", amount: "15.00" },
        { role: "stripe.fees", amount: "18.43" },
      ]);
      // Verify role-by-role sum of covered evidence equals the payout summary to the cent!
      const memberTotals = new Map<string, bigint>();
      for (const line of batch?.lines.slice(1) ?? []) {
        expect(line.kind).toBe("event");
        if (line.kind === "event") {
          expect(line.coveredBy).toBe("po_1001");
          for (const leg of line.legs) {
            memberTotals.set(
              leg.role,
              (memberTotals.get(leg.role) ?? 0n) + money.toCents(leg.amount),
            );
          }
        }
      }
      for (const leg of payout.legs) {
        expect(memberTotals.get(leg.role)).toBe(money.toCents(leg.amount));
      }
    }

    expect(batch?.balances).toEqual([
      { accountKey: "stripe:acct_1TestCo:usd", asOf: "2026-10-15", balance: "30.00" },
    ]);
    expect(report.preview).toContain("Payouts in transit");
    expect(report.preview).toContain("54.57");
    expect(report.preview).toContain("100.00");
  });

  test("holds foreign-currency or mismatched payouts as plain BankLines without guessing", async () => {
    const report = await testPlugin(stripePlugin, {
      now: () => "2026-10-15T12:00:00.000Z",
      routes: {
        "GET https://api.stripe.com/v1/account": { body: { id: "acct_1TestCo" } },
        "GET https://api.stripe.com/v1/balance": { body: { available: [], pending: [] } },
        "GET https://api.stripe.com/v1/payouts?status=paid&limit=100": {
          body: {
            has_more: false,
            data: [
              {
                id: "po_eur",
                amount: 5000,
                currency: "eur",
                arrival_date: ARRIVAL,
                created: TX_TIME,
                status: "paid",
                automatic: true,
              },
            ],
          },
        },
      },
    });

    expect(report.ok).toBe(true);
    expect(report.summary.bankLineCount).toBe(1);
    expect(report.summary.eventCount).toBe(0);
    const held = report.batches[0]?.lines[0];
    expect(held?.kind).toBe("bankLine");
    if (held?.kind === "bankLine") {
      expect(held.currency).toBe("EUR");
      expect(held.amount).toBe("-50.00");
      expect(held.description).toContain("held for review");
    }
  });

  test("works with restricted keys lacking Account/Balance read, splits Stripe Tax (Checkout & Invoices), and waits on in_progress payouts", async () => {
    const ARRIVAL_2 = ARRIVAL + 86_400;
    const report = await testPlugin(stripePlugin, {
      config: { salesTax: "stripe" },
      now: () => "2026-10-15T12:00:00.000Z",
      routes: {
        // Restricted key without Account:Read or Balance:Read -> 403 must degrade gracefully
        "GET https://api.stripe.com/v1/account": {
          status: 403,
          body: { error: { message: "No account read" } },
        },
        "GET https://api.stripe.com/v1/balance": {
          status: 403,
          body: { error: { message: "No balance read" } },
        },
        "GET https://api.stripe.com/v1/payouts?status=paid&limit=100": {
          body: {
            has_more: false,
            data: [
              {
                id: "po_inprog",
                amount: 1000,
                currency: "usd",
                arrival_date: ARRIVAL,
                created: TX_TIME,
                status: "paid",
                automatic: true,
                reconciliation_status: "in_progress",
              },
              {
                id: "po_tax",
                amount: 19300,
                currency: "usd",
                arrival_date: ARRIVAL_2,
                created: TX_TIME,
                status: "paid",
                automatic: true,
                reconciliation_status: "completed",
              },
            ],
          },
        },
        "GET https://api.stripe.com/v1/balance_transactions?payout=po_tax&limit=100&expand%5B%5D=data.source":
          {
            body: {
              has_more: false,
              data: [
                {
                  id: "txn_checkout",
                  amount: 10800,
                  fee: 350,
                  net: 10450,
                  currency: "usd",
                  created: TX_TIME,
                  reporting_category: "charge",
                  source: { id: "ch_1", payment_intent: "pi_checkout" },
                },
                {
                  id: "txn_invoice",
                  amount: 9200,
                  fee: 350,
                  net: 8850,
                  currency: "usd",
                  created: TX_TIME,
                  reporting_category: "charge",
                  source: { id: "ch_2", payment_intent: "pi_invoice" },
                },
              ],
            },
          },
        "GET https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_checkout&limit=5": {
          body: {
            has_more: false,
            data: [
              {
                id: "cs_1",
                payment_intent: "pi_checkout",
                currency: "usd",
                amount_total: 10800,
                total_details: { amount_tax: 800 },
              },
            ],
          },
        },
        "GET https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_invoice&limit=5": {
          body: { has_more: false, data: [] },
        },
        "GET https://api.stripe.com/v1/invoice_payments?payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_invoice&limit=10&expand%5B%5D=data.invoice":
          {
            body: {
              has_more: false,
              data: [
                {
                  id: "inpay_1",
                  status: "paid",
                  amount_paid: 9200,
                  payment: { payment_intent: "pi_invoice" },
                  invoice: {
                    id: "in_1",
                    currency: "usd",
                    total: 9200,
                    amount_paid: 9200,
                    total_taxes: [{ amount: 700 }],
                  },
                },
              ],
            },
          },
      },
    });

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.batches).toHaveLength(1); // po_inprog skipped cleanly
    const batch = report.batches[0];
    expect(batch?.sourceKey).toBe("stripe:default:usd");
    // Cursor must NOT advance past an earlier in_progress payout
    expect(batch?.cursor).toBeUndefined();
    const payout = batch?.lines[0];
    expect(payout?.kind).toBe("event");
    if (payout?.kind === "event") {
      expect(payout.legs).toEqual([
        { role: "payouts.in-transit", amount: "193.00" },
        { role: "revenue.sales", amount: "-185.00" },
        { role: "tax.sales", amount: "-15.00" },
        { role: "stripe.fees", amount: "7.00" },
      ]);
    }
  });
});

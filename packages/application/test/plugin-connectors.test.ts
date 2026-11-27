import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, money } from "@rastrata/plugin-sdk";
import { manifestToInstallPayload, runPluginSync } from "@rastrata/plugin-sdk/runner";
import { mockHttp } from "@rastrata/plugin-sdk/testing";
import { stripePlugin } from "@rastrata/plugin-stripe";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";

/** End-to-end integration test proving `@rastrata/plugin-stripe` and a `BankLine` plugin drive
 * Rastrata's real `ApplicationHttp` through `@rastrata/plugin-sdk/runner` using least-privilege
 * `rsp_` plugin tokens — from raw provider JSON all the way to posted journals with
 * Payouts in Transit clearing to exact 0.00, plus streaming incremental commit on mid-sync error. */

const ARRIVAL = Math.floor(Date.parse("2026-10-10T00:00:00Z") / 1000);
const TX_TIME = Math.floor(Date.parse("2026-10-08T14:00:00Z") / 1000);

const testBankPlugin = definePlugin({
  manifest: {
    id: "demo-bank",
    version: "1.0.0",
    name: "Demo Bank",
    description: "Test BankLine plugin for end-to-end clearing verification.",
    capabilities: ["ingest"],
    domains: ["api.demobank.test"],
    auth: { kind: "api_key", label: "Demo Bank token", envVar: "RASTRATA_PLUGIN_DEMO_BANK_KEY" },
  },
  async *pull(ctx) {
    const start = ctx.cursor ?? "2026-10-01";
    const res = await ctx.http.getJson<{
      balanceCents: number;
      transactions: { id: string; postedOn: string; cents: number; description: string }[];
    }>(`https://api.demobank.test/v1/transactions?start=${encodeURIComponent(start)}`, {
      headers: { authorization: `Bearer ${ctx.auth.apiKey}` },
    });
    const latest = res.data.transactions.at(-1)?.postedOn ?? start;
    yield {
      sourceKey: "demo-bank:checking-01",
      raw: res.raw,
      lines: res.data.transactions.map((tx, idx) =>
        ctx.emit.bankLine({
          accountKey: "demo-bank:checking-01",
          providerId: tx.id,
          rawIndex: idx,
          postedOn: tx.postedOn,
          amount: money.fromCents(tx.cents),
          currency: "USD",
          description: tx.description,
          counterparty: "Stripe",
        }),
      ),
      balances: [
        {
          accountKey: "demo-bank:checking-01",
          asOf: ctx.now().slice(0, 10),
          balance: money.fromCents(res.data.balanceCents),
        },
      ],
      cursor: latest,
    };
  },
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

describe("end-to-end plugin connectors: Stripe + BankLine -> ApplicationHttp -> cleared ledger", () => {
  test("dry-run previews without writes; live rsp_ sync books Stripe payout and auto-clears bank deposit to 0.00", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rastrata-connectors-e2e-"));
    const service = await LocalBookService.open(join(dir, "book.sqlite"));
    const http = new ApplicationHttp(service, {
      bookId: service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    cleanup.push(() => {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const rastrataFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return http.fetch(request);
    }) as typeof fetch;

    async function owner(name: string, input: unknown = {}, operationId?: string) {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: service.bookId,
            input,
            ...(operationId ? { operationId } : {}),
          }),
        }),
      );
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text };
    }

    // 1. Set up a realistic US small business book.
    const setup = await owner(
      "book.setup",
      {
        name: "Gant Demo LLC",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        accounts: [
          { code: "1000", name: "Business Checking", role: "asset" },
          { code: "1050", name: "Payouts in Transit", role: "asset" },
          { code: "2100", name: "Sales Tax Payable", role: "liability" },
          { code: "3000", name: "Owner Capital", role: "equity" },
          { code: "4000", name: "Product Sales", role: "income" },
          { code: "4100", name: "Sales Refunds", role: "income" },
          { code: "5100", name: "Stripe Fees", role: "expense" },
          { code: "5200", name: "Chargebacks", role: "expense" },
        ],
      },
      crypto.randomUUID(),
    );
    expect(setup.body.ok, setup.text).toBe(true);

    const listed = await owner("accounts.list");
    const byCode = new Map<string, string>(
      (listed.body.data.accounts as { id: string; code: string }[]).map((a) => [a.code, a.id]),
    );

    // Tag chart accounts with standard roleKeys so Stripe auto-binds every required role.
    for (const [code, roleKey] of [
      ["1050", "payouts.in-transit"],
      ["2100", "tax.sales"],
      ["4000", "revenue.sales"],
      ["4100", "refunds"],
      ["5100", "stripe.fees"],
      ["5200", "chargebacks"],
    ] as const) {
      const tagged = await owner(
        "accounts.setTags",
        { accountId: byCode.get(code), effectiveOn: "2026-01-01", tags: { roleKey } },
        crypto.randomUUID(),
      );
      expect(tagged.body.ok, tagged.text).toBe(true);
    }

    // 2. Install both plugins straight from their SDK manifests + issue separate rsp_ tokens.
    const stripeInstall = await owner(
      "plugins.install",
      { manifest: manifestToInstallPayload(stripePlugin.manifest) },
      crypto.randomUUID(),
    );
    expect(stripeInstall.body.ok, stripeInstall.text).toBe(true);
    expect(stripeInstall.body.data.ready).toBe(true);

    const bankInstall = await owner(
      "plugins.install",
      {
        manifest: manifestToInstallPayload(testBankPlugin.manifest),
        accountMap: [
          {
            accountKey: "demo-bank:checking-01",
            ledgerAccountId: byCode.get("1000"),
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(bankInstall.body.ok, bankInstall.text).toBe(true);

    const stripeTokenRes = await owner(
      "plugins.createToken",
      { pluginId: "stripe", label: "Stripe CLI runner" },
      crypto.randomUUID(),
    );
    const bankTokenRes = await owner(
      "plugins.createToken",
      { pluginId: "demo-bank", label: "Bank CLI runner" },
      crypto.randomUUID(),
    );
    const stripeToken = stripeTokenRes.body.data.token as string;
    const bankToken = bankTokenRes.body.data.token as string;

    // Mock provider APIs (offline, deterministic, zero network).
    const stripeProviderFetch = mockHttp({
      "GET https://api.stripe.com/v1/account": {
        body: { id: "acct_1DemoCo", default_currency: "usd" },
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
        body: { available: [{ amount: 0, currency: "usd" }], pending: [] },
      },
      "GET https://api.stripe.com/v1/balance_transactions?payout=po_1001&limit=100": {
        body: {
          has_more: false,
          data: [
            {
              id: "txn_po_1001",
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
    });

    const bankProviderFetch = mockHttp({
      "GET https://api.demobank.test/v1/transactions?start=2026-10-01": {
        body: {
          balanceCents: 5457,
          transactions: [
            {
              id: "btx_stripe_dep",
              postedOn: "2026-10-11",
              cents: 5457,
              description: "STRIPE TRANSFER",
            },
          ],
        },
      },
      "GET https://api.demobank.test/v1/transactions?start=2026-10-11": {
        body: {
          balanceCents: 5457,
          transactions: [
            {
              id: "btx_stripe_dep",
              postedOn: "2026-10-11",
              cents: 5457,
              description: "STRIPE TRANSFER",
            },
          ],
        },
      },
    });

    // 3. Dry-run Stripe first: prints preview table and writes NOTHING to the book.
    const dryRun = await runPluginSync(stripePlugin, {
      dryRun: true,
      auth: { apiKey: "mock_stripe_token_123456" },
      config: { salesTax: "metadata" },
      now: () => "2026-10-15T12:00:00.000Z",
      providerFetch: stripeProviderFetch,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.pushed).toHaveLength(0);
    expect(dryRun.preview).toContain("Payouts in transit");
    expect(dryRun.preview).toContain("54.57");

    const inboxBefore = await owner("inbox.list");
    expect(inboxBefore.body.data.items).toHaveLength(0);

    // 4. Live sync Stripe using its least-privilege rsp_ token.
    const stripeSync = await runPluginSync(stripePlugin, {
      endpoint: "http://127.0.0.1:4010",
      bookId: service.bookId,
      token: stripeToken,
      auth: { apiKey: "mock_stripe_token_123456" },
      config: { salesTax: "metadata" },
      now: () => "2026-10-15T12:00:00.000Z",
      providerFetch: stripeProviderFetch,
      rastrataFetch,
    });
    expect(stripeSync.totals.events).toBe(4);
    expect(stripeSync.totals.newCount).toBe(4);

    // 5. Live sync BankLine plugin using its least-privilege rsp_ token.
    const bankSync = await runPluginSync(testBankPlugin, {
      endpoint: "http://127.0.0.1:4010",
      bookId: service.bookId,
      token: bankToken,
      auth: { apiKey: "mock_bank_token_123456" },
      now: () => "2026-10-15T12:00:00.000Z",
      providerFetch: bankProviderFetch,
      rastrataFetch,
    });
    expect(bankSync.totals.bankLines).toBe(1);
    expect(bankSync.totals.newCount).toBe(1);
    expect(bankSync.pushed[0]?.balances[0]).toMatchObject({
      accountKey: "demo-bank:checking-01",
      reported: "54.57",
      waiting: "54.57",
      difference: "0.00",
    });

    // 6. Second bank sync automatically resumes from saved cursor and deduplicates cleanly.
    const bankRepeat = await runPluginSync(testBankPlugin, {
      endpoint: "http://127.0.0.1:4010",
      bookId: service.bookId,
      token: bankToken,
      auth: { apiKey: "mock_bank_token_123456" },
      now: () => "2026-10-15T12:05:00.000Z",
      providerFetch: bankProviderFetch,
      rastrataFetch,
    });
    expect(bankRepeat.totals.newCount).toBe(0);
    expect(bankRepeat.totals.duplicateCount).toBe(1);

    // 7. Inspect Inbox proposals: Stripe payout proposed at 100%, bank deposit
    //    automatically paired to Stripe payout by the generic plugin clearing matcher!
    const inbox = await owner("inbox.list", { filter: { covered: false } });
    expect(inbox.body.ok, inbox.text).toBe(true);
    const items = inbox.body.data.items as {
      id: string;
      line: { provider: string; providerId?: string };
      suggestion: {
        proposer: string;
        kind: string;
        confidence: number;
        legs: { accountId: string; amount: string }[];
      } | null;
    }[];
    expect(items).toHaveLength(2);

    const payoutItem = items.find((i) => i.line.providerId === "po_1001");
    const depositItem = items.find((i) => i.line.providerId === "btx_stripe_dep");
    expect(payoutItem?.suggestion?.proposer).toBe("plugin:stripe");
    expect(payoutItem?.suggestion?.confidence).toBe(100);
    expect(depositItem?.suggestion?.proposer).toBe("plugin:stripe");
    expect(depositItem?.suggestion?.confidence).toBe(90);
    expect(depositItem?.suggestion?.legs).toEqual([
      { accountId: byCode.get("1000") ?? "", amount: "54.57" },
      { accountId: byCode.get("1050") ?? "", amount: "-54.57" },
    ]);

    // 8. Accept & post both -> Payouts in Transit clears to exact 0.00!
    if (!payoutItem || !depositItem) throw new Error("Missing inbox items");
    const accepted = await owner(
      "inbox.accept",
      { itemIds: [payoutItem.id, depositItem.id] },
      crypto.randomUUID(),
    );
    expect(accepted.body.ok, accepted.text).toBe(true);
    const posted = await owner(
      "inbox.post",
      { itemIds: [payoutItem.id, depositItem.id] },
      crypto.randomUUID(),
    );
    expect(posted.body.ok, posted.text).toBe(true);

    const finalAccounts = await owner("accounts.list");
    const bal = new Map<string, string>(
      (finalAccounts.body.data.accounts as { code: string; balance: string }[]).map((a) => [
        a.code,
        a.balance,
      ]),
    );
    expect(bal.get("1000")).toBe("54.57");
    expect(bal.get("1050")).toBe("0.00");
    expect(bal.get("2100")).toBe("-8.00");
    expect(bal.get("4000")).toBe("-100.00");
    expect(bal.get("4100")).toBe("20.00");
    expect(bal.get("5100")).toBe("18.43");
    expect(bal.get("5200")).toBe("15.00");
  });

  test("streams batches incrementally so a mid-backfill provider error keeps already-committed payouts and cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rastrata-stream-commit-"));
    const service = await LocalBookService.open(join(dir, "book.sqlite"));
    const http = new ApplicationHttp(service, {
      bookId: service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    cleanup.push(() => {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const rastrataFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return http.fetch(request);
    }) as typeof fetch;

    async function owner(name: string, input: unknown = {}, operationId?: string) {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: service.bookId,
            input,
            ...(operationId ? { operationId } : {}),
          }),
        }),
      );
      return JSON.parse(await response.text());
    }

    await owner(
      "book.setup",
      {
        name: "Stream Co",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        accounts: [
          { code: "1000", name: "Checking", role: "asset" },
          {
            code: "1050",
            name: "Payouts in Transit",
            role: "asset",
            tags: { roleKey: "payouts.in-transit" },
          },
          { code: "2100", name: "Sales Tax", role: "liability", tags: { roleKey: "tax.sales" } },
          { code: "3000", name: "Equity", role: "equity" },
          { code: "4000", name: "Sales", role: "income", tags: { roleKey: "revenue.sales" } },
          { code: "4100", name: "Refunds", role: "income", tags: { roleKey: "refunds" } },
          { code: "5100", name: "Stripe Fees", role: "expense", tags: { roleKey: "stripe.fees" } },
          { code: "5200", name: "Chargebacks", role: "expense", tags: { roleKey: "chargebacks" } },
        ],
      },
      crypto.randomUUID(),
    );
    await owner(
      "plugins.install",
      { manifest: manifestToInstallPayload(stripePlugin.manifest) },
      crypto.randomUUID(),
    );
    const tok = await owner(
      "plugins.createToken",
      { pluginId: "stripe", label: "Stream runner" },
      crypto.randomUUID(),
    );

    const ARRIVAL_2 = ARRIVAL + 86_400;
    const providerFetch = mockHttp({
      "GET https://api.stripe.com/v1/account": { body: { id: "acct_stream" } },
      "GET https://api.stripe.com/v1/balance": { body: { available: [], pending: [] } },
      "GET https://api.stripe.com/v1/payouts?status=paid&limit=100": {
        body: {
          has_more: false,
          data: [
            {
              id: "po_first",
              amount: 9700,
              currency: "usd",
              arrival_date: ARRIVAL,
              created: TX_TIME,
              status: "paid",
              automatic: true,
            },
            {
              id: "po_second_fails",
              amount: 5000,
              currency: "usd",
              arrival_date: ARRIVAL_2,
              created: TX_TIME,
              status: "paid",
              automatic: true,
            },
          ],
        },
      },
      "GET https://api.stripe.com/v1/balance_transactions?payout=po_first&limit=100": {
        body: {
          has_more: false,
          data: [
            {
              id: "txn_first",
              amount: 10000,
              fee: 300,
              net: 9700,
              currency: "usd",
              created: TX_TIME,
              reporting_category: "charge",
            },
          ],
        },
      },
      "GET https://api.stripe.com/v1/balance_transactions?payout=po_second_fails&limit=100": {
        status: 500,
        body: { error: { message: "Upstream error" } },
      },
    });

    await expect(
      runPluginSync(stripePlugin, {
        endpoint: "http://127.0.0.1:4010",
        bookId: service.bookId,
        token: tok.data.token as string,
        auth: { apiKey: "mock_stripe_token_123456" },
        now: () => "2026-10-15T12:00:00.000Z",
        maxAttempts: 1,
        sleep: async () => {},
        providerFetch,
        rastrataFetch,
      }),
    ).rejects.toThrow();

    // Even though payout #2 threw HTTP 500, payout #1 and its cursor MUST already be committed!
    const status = await owner("plugins.status", { pluginId: "stripe" });
    expect(status.data.cursors).toHaveLength(1);
    expect(status.data.cursors[0].cursor).toBe(String(ARRIVAL));

    const inbox = await owner("inbox.list", { filter: { covered: false } });
    expect(inbox.data.items).toHaveLength(1);
    expect(inbox.data.items[0].line.providerId).toBe("po_first");
  });
});

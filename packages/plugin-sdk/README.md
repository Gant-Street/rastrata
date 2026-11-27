# `@gantstreet/rastrata-plugin-sdk`

MIT-licensed SDK for building Rastrata ingestion plugins. Zero runtime dependencies; runs in Bun, Node 22+, and Cloudflare Workers.

## Quick start (40 lines)

```ts
import { definePlugin, money } from "@gantstreet/rastrata-plugin-sdk";

export default definePlugin({
  manifest: {
    id: "mercury",
    version: "0.1.0",
    name: "Mercury",
    description: "Import checking, savings, and credit card transactions from Mercury.",
    capabilities: ["ingest"],
    domains: ["api.mercury.com"],
    auth: {
      kind: "api_key",
      label: "Mercury read-only API token",
      envVar: "RASTRATA_MERCURY_KEY",
    },
    fields: [
      { key: "syncFrom", label: "Import transactions from", kind: "date", required: true },
    ],
  },
  async *pull({ auth, config, cursor, http, emit }) {
    const start = cursor ?? config.syncFrom;
    const { data, raw } = await http.getJson<{
      transactions: { id: string; postedAt: string; amount: number; counterpartyName: string }[];
    }>(`https://api.mercury.com/api/v1/account/acct_1/transactions?start=${encodeURIComponent(start)}`, {
      headers: { Authorization: `Bearer ${auth.apiKey}` },
      name: `mercury-tx-${start}.json`,
    });

    yield {
      sourceKey: "mercury:acct_1",
      raw,
      lines: data.transactions.map((tx) =>
        emit.bankLine({
          accountKey: "mercury:acct_1",
          providerId: tx.id,
          postedOn: tx.postedAt.slice(0, 10),
          amount: money.fromCents(Math.round(tx.amount * 100)),
          currency: "USD",
          description: tx.counterpartyName,
        }),
      ),
      cursor: data.transactions.at(-1)?.postedAt.slice(0, 10) ?? start,
    };
  },
});
```

## Multi-leg payouts (`LedgerEvent`)

Declare account `roles` in `manifest.roles` — TypeScript automatically infers `emit.event({ legs: [{ role }] })` so a typo in a role key is a compile error, and `emit.event()` verifies every entry balances to `0.00` to the cent.

```ts
emit.event({
  accountKey: "shopify:shop_1:usd",
  providerId: "po_123",
  eventOn: "2026-09-09",
  summary: "Shopify payout po_123",
  currency: "USD",
  amount: "93.31",
  legs: [
    { role: "payouts.in-transit", amount: "93.31" },
    { role: "revenue.sales", amount: "-102.00" },
    { role: "shopify.fees", amount: "5.34" },
    { role: "refunds", amount: "5.00" },
    { role: "tax.sales", amount: "-1.65" },
  ],
});
```

## Test all five invariants in one call

```ts
import { expect, test } from "bun:test";
import { testPlugin } from "@gantstreet/rastrata-plugin-sdk/testing";
import plugin from "./index.ts";

test("passes Rastrata plugin invariants", async () => {
  const report = await testPlugin(plugin, {
    config: { syncFrom: "2026-09-01" },
    routes: {
      "GET https://api.mercury.com/api/v1/account/acct_1/transactions?start=2026-09-01": {
        body: { transactions: [{ id: "tx_1", postedAt: "2026-09-02", amount: -42.5, counterpartyName: "AWS" }] },
      },
    },
  });
  expect(report.ok, JSON.stringify(report.issues, null, 2)).toBe(true);
});
```

`testPlugin()` automatically verifies:
1. Manifest validity (`id`, SemVer, HTTPS `domains`, `roles`, `clearing`, `fields`).
2. Byte-for-byte determinism across repeated runs.
3. Exact cent-level `0.00` balance, valid calendar dates, and declared roles.
4. Zero secret leakage (injects a canary key and scans all batches, cursors, raw payloads, and errors).
5. Strict domain egress containment via `GuardedHttp`.

## Run & preview (`@gantstreet/rastrata-plugin-sdk/runner`)

```ts
import { runPluginSync } from "@gantstreet/rastrata-plugin-sdk/runner";
import plugin from "./index.ts";

// Preview entries locally with zero writes to Rastrata:
const preview = await runPluginSync(plugin, {
  dryRun: true,
  auth: { apiKey: process.env.RASTRATA_PLUGIN_MERCURY_KEY ?? "" },
});
console.log(preview.preview);

// Push live using a least-privilege rsp_ plugin token:
const live = await runPluginSync(plugin, {
  endpoint: process.env.RASTRATA_API_URL ?? "http://127.0.0.1:4010",
  token: process.env.RASTRATA_PLUGIN_TOKEN,
  auth: { apiKey: process.env.RASTRATA_PLUGIN_STRIPE_KEY ?? "" },
});
console.log(live.totals);
```

## Official reference plugin

- [`packages/plugin-stripe`](../plugin-stripe): MIT `LedgerEvent` + clearing plugin (A2X payout summary, Stripe Tax / Checkout / Invoice support, `coveredBy` evidence, 1-to-1 bank deposit clearing).

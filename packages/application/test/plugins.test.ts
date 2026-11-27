import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey } from "../src/agent/token.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS, operationCatalog } from "../src/schema.ts";

const START = new Date("2026-10-15T12:00:00.000Z");

const BOOK_SETUP = {
  name: "Plugin Test Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Mercury Checking", role: "asset" },
    { code: "1050", name: "Payouts in Transit", role: "asset" },
    { code: "2100", name: "Sales Tax Payable", role: "liability" },
    { code: "3000", name: "Owner Capital", role: "equity" },
    { code: "4000", name: "Product Sales", role: "income" },
    { code: "5100", name: "Payment Processing Fees", role: "expense" },
  ],
};

const MERCURY_MANIFEST = {
  id: "mercury",
  version: "1.0.0",
  name: "Mercury",
  description: "Imports Mercury business checking transactions and balances.",
  domains: ["api.mercury.com"],
  authKind: "api_key",
  authLabel: "Mercury API token",
  authEnvVar: "RASTRATA_PLUGIN_MERCURY_KEY",
  roles: [],
};

const SHOPIFY_MANIFEST = {
  id: "shopify",
  version: "1.0.0",
  name: "Shopify",
  description: "Imports Shopify payouts, sales, fees, sales tax, and deposit clearing.",
  domains: ["admin.shopify.com"],
  authKind: "oauth2",
  roles: [
    {
      key: "revenue.sales",
      label: "Shopify Sales",
      kind: "income",
      required: true,
      defaultRoleKey: "revenue.sales",
    },
    {
      key: "shopify.fees",
      label: "Shopify Fees",
      kind: "expense",
      required: true,
    },
    {
      key: "tax.sales",
      label: "Sales Tax",
      kind: "liability",
      required: true,
      defaultRoleKey: "tax.sales",
    },
    {
      key: "payouts.in-transit",
      label: "Payouts in Transit",
      kind: "asset",
      required: true,
      defaultRoleKey: "payouts.in-transit",
    },
  ],
  clearing: {
    role: "payouts.in-transit",
    windowDays: 7,
  },
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture(options: { ownerKey?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rastrata-plugins-"));
  const path = join(dir, "book.sqlite");
  const service = await LocalBookService.open(path);
  let now = START;
  const clock = () => now;
  const http = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    { ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}), clock },
  );
  cleanup.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(
    name: string,
    input: unknown = {},
    opts: { operationId?: string; credential?: string } = {},
  ) {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.credential ? { authorization: `Bearer ${opts.credential}` } : {}),
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: service.bookId,
          input,
          ...(opts.operationId ? { operationId: opts.operationId } : {}),
        }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  }

  async function uploadRaw(
    content: string | Uint8Array,
    opts: {
      credential?: string;
      purpose?: string;
      contentType?: string;
      filename?: string;
    } = {},
  ) {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const response = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/uploads", {
        method: "POST",
        headers: {
          "content-type": opts.contentType ?? "application/json",
          ...(opts.purpose !== undefined ? { "x-upload-for": opts.purpose } : {}),
          ...(opts.filename ? { "x-upload-filename": opts.filename } : {}),
          ...(opts.credential ? { authorization: `Bearer ${opts.credential}` } : {}),
        },
        body: bytes,
      }),
    );
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  }

  const f = {
    service,
    http,
    path,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    owner(name: string, input: unknown = {}, operationId?: string) {
      return call(name, input, {
        ...(operationId ? { operationId } : {}),
        ...(options.ownerKey ? { credential: options.ownerKey } : {}),
      });
    },
    as(credential: string, name: string, input: unknown = {}, operationId?: string) {
      return call(name, input, { credential, ...(operationId ? { operationId } : {}) });
    },
    uploadRaw,
    async setup() {
      const setup = await f.owner("book.setup", BOOK_SETUP, crypto.randomUUID());
      expect(setup.body.ok, setup.text).toBe(true);
      const listed = await f.owner("accounts.list", {});
      expect(listed.body.ok, listed.text).toBe(true);
      const byCode = new Map<string, string>();
      for (const account of listed.body.data.accounts as { id: string; code: string }[]) {
        byCode.set(account.code, account.id);
      }
      return byCode;
    },
  };
  return f;
}

describe("plugins slice: lifecycle and role resolution", () => {
  test("install, auto-bind chart roleKeys, configure overrides, upgrade, and remove", async () => {
    const f = await fixture();
    const accounts = await f.setup();

    // Tag chart accounts with standard roleKeys so Shopify auto-binds them.
    for (const [code, roleKey] of [
      ["4000", "revenue.sales"],
      ["2100", "tax.sales"],
      ["1050", "payouts.in-transit"],
    ] as const) {
      const tagRes = await f.owner(
        "accounts.setTags",
        {
          accountId: accounts.get(code),
          effectiveOn: "2026-01-01",
          tags: { roleKey },
        },
        crypto.randomUUID(),
      );
      expect(tagRes.body.ok, tagRes.text).toBe(true);
    }

    const installed = await f.owner(
      "plugins.install",
      { manifest: SHOPIFY_MANIFEST },
      crypto.randomUUID(),
    );
    expect(installed.status).toBe(200);
    expect(installed.body.ok).toBe(true);
    // 3 roles auto-bound via roleKey, 1 role (`shopify.fees`) still unmapped -> ready: false.
    expect(installed.body.data.ready).toBe(false);
    const rolesByKey = new Map(
      (
        installed.body.data.roles as { role: string; source: string; accountId: string | null }[]
      ).map((r) => [r.role, r]),
    );
    expect(rolesByKey.get("revenue.sales")).toMatchObject({
      source: "roleKey",
      accountId: accounts.get("4000"),
    });
    expect(rolesByKey.get("tax.sales")).toMatchObject({
      source: "roleKey",
      accountId: accounts.get("2100"),
    });
    expect(rolesByKey.get("payouts.in-transit")).toMatchObject({
      source: "roleKey",
      accountId: accounts.get("1050"),
    });
    expect(rolesByKey.get("shopify.fees")).toMatchObject({
      source: "unmapped",
      accountId: null,
    });

    // Listing shows missingRoles clearly.
    const listed = await f.owner("plugins.list");
    expect(listed.body.data.plugins).toHaveLength(1);
    expect(listed.body.data.plugins[0]).toMatchObject({
      pluginId: "shopify",
      ready: false,
      missingRoles: ["shopify.fees"],
    });

    // Map shopify.fees explicitly + add config.
    const configured = await f.owner(
      "plugins.configure",
      {
        pluginId: "shopify",
        config: [{ key: "store", value: "acme.myshopify.com" }],
        roleMap: [{ role: "shopify.fees", accountId: accounts.get("5100") }],
      },
      crypto.randomUUID(),
    );
    expect(configured.status).toBe(200);
    expect(configured.body.data.ready).toBe(true);
    const feeRole = (
      configured.body.data.roles as { role: string; source: string; accountId: string | null }[]
    ).find((r) => r.role === "shopify.fees");
    expect(feeRole).toMatchObject({ source: "override", accountId: accounts.get("5100") });

    // Upgrading the manifest version preserves existing config & roleMap.
    const upgraded = await f.owner(
      "plugins.install",
      { manifest: { ...SHOPIFY_MANIFEST, version: "1.1.0" } },
      crypto.randomUUID(),
    );
    expect(upgraded.body.ok, upgraded.text).toBe(true);
    expect(upgraded.body.data.version).toBe("1.1.0");
    expect(upgraded.body.data.ready).toBe(true);
    expect(upgraded.body.data.config).toEqual([{ key: "store", value: "acme.myshopify.com" }]);

    // Issue a plugin token, then remove the plugin -> token is auto-revoked.
    const tokRes = await f.owner(
      "plugins.createToken",
      { pluginId: "shopify", label: "Shopify runner" },
      crypto.randomUUID(),
    );
    expect(tokRes.body.ok, tokRes.text).toBe(true);
    const pluginBearer = tokRes.body.data.token as string;
    expect(pluginBearer.startsWith("rsp_")).toBe(true);

    const removed = await f.owner("plugins.remove", { pluginId: "shopify" }, crypto.randomUUID());
    expect(removed.body.data).toEqual({ pluginId: "shopify", removed: true });

    const afterRemove = await f.as(pluginBearer, "plugins.status", { pluginId: "shopify" });
    expect(afterRemove.status).toBe(401);
    expect(afterRemove.body.error.code).toBe("token_revoked");
  });

  test("rejects invalid manifests (wildcard domain, IP, missing domain, undeclared clearing role)", async () => {
    const f = await fixture();
    await f.setup();

    for (const badManifest of [
      { ...MERCURY_MANIFEST, domains: ["*.mercury.com"] },
      { ...MERCURY_MANIFEST, domains: ["127.0.0.1"] },
      { ...MERCURY_MANIFEST, domains: ["localhost"] },
      { ...MERCURY_MANIFEST, domains: [] },
      { ...MERCURY_MANIFEST, clearing: { role: "payouts.in-transit", windowDays: 7 } },
    ]) {
      const res = await f.owner("plugins.install", { manifest: badManifest }, crypto.randomUUID());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_manifest");
    }
  });
});

describe("plugins slice: BankLine ingestion, dedup, cursor, cutover, and balance check", () => {
  test("pushes BankLines via rsp_ token, checks balance, deduplicates replays, and honors startOn cutover", async () => {
    const f = await fixture();
    const accounts = await f.setup();
    const checkingId = accounts.get("1000") ?? "";
    expect(checkingId).not.toBe("");

    await f.owner(
      "plugins.install",
      {
        manifest: MERCURY_MANIFEST,
        accountMap: [
          {
            accountKey: "mercury:chk_01",
            ledgerAccountId: checkingId,
            startOn: "2026-10-01",
          },
        ],
      },
      crypto.randomUUID(),
    );

    const tok = await f.owner(
      "plugins.createToken",
      { pluginId: "mercury", label: "Local Mercury CLI" },
      crypto.randomUUID(),
    );
    const bearer = tok.body.data.token as string;

    // 1. Upload raw JSON payload with X-Upload-For: plugin using the rsp_ token.
    const rawJson = JSON.stringify({
      transactions: [
        { id: "mtx_pre", postedAt: "2026-09-29", amount: -10.0 },
        { id: "mtx_1", postedAt: "2026-10-02", amount: 500.0 },
        { id: "mtx_2", postedAt: "2026-10-03", amount: -42.5 },
      ],
    });
    const uploaded = await f.uploadRaw(rawJson, {
      credential: bearer,
      purpose: "plugin",
      filename: "mercury-batch-1.json",
    });
    expect(uploaded.status, uploaded.text).toBe(200);
    const sha256 = uploaded.body.data.sha256 as string;

    // 2. Push normalized BankLines + cursor + balance check using the rsp_ token.
    const pushOpId = crypto.randomUUID();
    const pushInput = {
      pluginId: "mercury",
      sourceKey: "mercury:chk_01",
      rawSha256: sha256,
      cursor: "cur_2026_10_03",
      bankLines: [
        {
          accountKey: "mercury:chk_01",
          providerId: "mtx_pre",
          rawIndex: 0,
          postedOn: "2026-09-29",
          amount: "-10.00",
          currency: "USD",
          description: "Pre-cutover coffee",
        },
        {
          accountKey: "mercury:chk_01",
          providerId: "mtx_1",
          rawIndex: 1,
          postedOn: "2026-10-02",
          amount: "500.00",
          currency: "USD",
          description: "Stripe transfer",
        },
        {
          accountKey: "mercury:chk_01",
          providerId: "mtx_2",
          rawIndex: 2,
          postedOn: "2026-10-03",
          amount: "-42.50",
          currency: "USD",
          description: "Cloudflare invoice",
          counterparty: "Cloudflare",
        },
      ],
      balances: [
        {
          accountKey: "mercury:chk_01",
          asOf: "2026-10-03",
          balance: "457.50",
        },
      ],
    };

    const firstPush = await f.as(bearer, "plugins.push", pushInput, pushOpId);
    expect(firstPush.status, firstPush.text).toBe(200);
    expect(firstPush.body.data).toMatchObject({
      pluginId: "mercury",
      sourceKey: "mercury:chk_01",
      newCount: 2,
      duplicateCount: 0,
      excludedCount: 1,
      cursor: "cur_2026_10_03",
    });
    expect(firstPush.body.data.balances).toHaveLength(1);
    expect(firstPush.body.data.balances[0]).toMatchObject({
      accountKey: "mercury:chk_01",
      reported: "457.50",
      waiting: "457.50",
      difference: "0.00",
    });

    // 3. Network retry with the exact same operationId returns the retained response cleanly.
    const retried = await f.as(bearer, "plugins.push", pushInput, pushOpId);
    expect(retried.status).toBe(200);
    expect(retried.body.data.batchId).toBe(firstPush.body.data.batchId);
    expect(retried.body.data.newCount).toBe(2);

    // 4. Subsequent sync with a new operationId deduplicates all 3 lines cleanly.
    const replay = await f.as(bearer, "plugins.push", pushInput, crypto.randomUUID());
    expect(replay.status).toBe(200);
    expect(replay.body.data.newCount).toBe(0);
    expect(replay.body.data.duplicateCount).toBe(3);

    // 5. Status reports saved cursor.
    const status = await f.as(bearer, "plugins.status", { pluginId: "mercury" });
    expect(status.status).toBe(200);
    expect(status.body.data.cursors).toHaveLength(1);
    expect(status.body.data.cursors[0]).toMatchObject({
      sourceKey: "mercury:chk_01",
      cursor: "cur_2026_10_03",
      lastError: null,
    });
  });
});

describe("plugins slice: LedgerEvent proposals, coveredBy evidence, and generic clearing match", () => {
  test("proposes multi-leg LedgerEvents, hides covered evidence, and pairs bank deposits to payouts", async () => {
    const f = await fixture();
    const accounts = await f.setup();
    const checkingId = accounts.get("1000") ?? "";
    expect(checkingId).not.toBe("");
    const clearingId = accounts.get("1050") ?? "";
    const taxId = accounts.get("2100") ?? "";
    const salesId = accounts.get("4000") ?? "";
    const feesId = accounts.get("5100") ?? "";

    // Tag roles for auto-binding and install both Mercury + Shopify.
    for (const [accountId, roleKey] of [
      [salesId, "revenue.sales"],
      [taxId, "tax.sales"],
      [clearingId, "payouts.in-transit"],
    ] as const) {
      await f.owner(
        "accounts.setTags",
        { accountId, effectiveOn: "2026-01-01", tags: { roleKey } },
        crypto.randomUUID(),
      );
    }

    await f.owner(
      "plugins.install",
      {
        manifest: SHOPIFY_MANIFEST,
        roleMap: [{ role: "shopify.fees", accountId: feesId }],
      },
      crypto.randomUUID(),
    );
    await f.owner(
      "plugins.install",
      {
        manifest: MERCURY_MANIFEST,
        accountMap: [{ accountKey: "mercury:chk_01", ledgerAccountId: checkingId }],
      },
      crypto.randomUUID(),
    );

    // Push Shopify payout LedgerEvent + covered charge evidence.
    const shopifyUpload = await f.uploadRaw(JSON.stringify({ payout: "po_1001" }), {
      purpose: "plugin",
    });
    expect(shopifyUpload.body.ok, shopifyUpload.text).toBe(true);

    const shopifyPush = await f.owner(
      "plugins.push",
      {
        pluginId: "shopify",
        sourceKey: "shopify:acme",
        rawSha256: shopifyUpload.body.data.sha256,
        cursor: "po_1001",
        events: [
          {
            accountKey: "shopify:acme",
            providerId: "po_1001",
            rawIndex: 0,
            eventOn: "2026-10-10",
            summary: "Shopify payout po_1001 (1 order)",
            currency: "USD",
            amount: "104.80",
            legs: [
              { role: "revenue.sales", amount: "-100.00", memo: "Gross sales" },
              { role: "tax.sales", amount: "-8.00", memo: "CA sales tax" },
              { role: "shopify.fees", amount: "3.20", memo: "Card processing" },
              { role: "payouts.in-transit", amount: "104.80", memo: "Net payout" },
            ],
            links: [{ key: "payout", value: "po_1001" }],
          },
          {
            accountKey: "shopify:acme",
            providerId: "ord_9001",
            rawIndex: 1,
            eventOn: "2026-10-09",
            summary: "Order #9001 charge",
            currency: "USD",
            amount: "104.80",
            legs: [
              { role: "revenue.sales", amount: "-100.00" },
              { role: "tax.sales", amount: "-8.00" },
              { role: "shopify.fees", amount: "3.20" },
              { role: "payouts.in-transit", amount: "104.80" },
            ],
            coveredBy: "po_1001",
            evidence: "Included in payout po_1001",
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(shopifyPush.status, shopifyPush.text).toBe(200);
    expect(shopifyPush.body.data.newCount).toBe(2);

    // Push matching Mercury checking deposit 1 day after payout arrival.
    const mercuryUpload = await f.uploadRaw(JSON.stringify({ deposit: "dep_1001" }), {
      purpose: "plugin",
    });
    const mercuryPush = await f.owner(
      "plugins.push",
      {
        pluginId: "mercury",
        sourceKey: "mercury:chk_01",
        rawSha256: mercuryUpload.body.data.sha256,
        bankLines: [
          {
            accountKey: "mercury:chk_01",
            providerId: "dep_1001",
            rawIndex: 0,
            postedOn: "2026-10-11",
            amount: "104.80",
            currency: "USD",
            description: "SHOPIFY TRANSFER",
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(mercuryPush.status, mercuryPush.text).toBe(200);

    // Inspect Inbox: payout event proposed at 100%, covered evidence hidden from open proposals,
    // and Mercury bank deposit paired with Shopify payout clearing payouts.in-transit!
    const inbox = await f.owner("inbox.list", { filter: { covered: false } });
    expect(inbox.status, inbox.text).toBe(200);
    const items = inbox.body.data.items as {
      id: string;
      line: { provider: string; providerId?: string; kind: string };
      suggestion: {
        proposer: string;
        kind: string;
        confidence: number;
        legs: { accountId: string; amount: string }[];
      } | null;
    }[];
    // Covered evidence ord_9001 is excluded by covered: false, leaving only po_1001 + dep_1001.
    expect(items).toHaveLength(2);

    const payoutItem = items.find((i) => i.line.providerId === "po_1001");
    expect(payoutItem?.suggestion).not.toBeNull();
    expect(payoutItem?.suggestion?.proposer).toBe("plugin:shopify");
    expect(payoutItem?.suggestion?.kind).toBe("event");
    expect(payoutItem?.suggestion?.confidence).toBe(100);
    expect(payoutItem?.suggestion?.legs).toEqual(
      expect.arrayContaining([
        { accountId: salesId, amount: "-100.00" },
        { accountId: taxId, amount: "-8.00" },
        { accountId: feesId, amount: "3.20" },
        { accountId: clearingId, amount: "104.80" },
      ]),
    );

    const depositItem = items.find((i) => i.line.providerId === "dep_1001");
    expect(depositItem?.suggestion).not.toBeNull();
    expect(depositItem?.suggestion?.proposer).toBe("plugin:shopify");
    expect(depositItem?.suggestion?.kind).toBe("categorize");
    expect(depositItem?.suggestion?.confidence).toBe(90);
    expect(depositItem?.suggestion?.legs).toEqual([
      { accountId: checkingId, amount: "104.80" },
      { accountId: clearingId, amount: "-104.80" },
    ]);

    // Covered evidence item exists in covered filter and has no independent proposal.
    const covered = await f.owner("inbox.list", { filter: { coveredBy: "po_1001" } });
    expect(covered.body.data.items).toHaveLength(1);
    expect(covered.body.data.items[0].line.providerId).toBe("ord_9001");
    expect(covered.body.data.items[0].suggestion).toBeUndefined();

    // Accept & post both items -> payouts-in-transit clears to exact 0.00, checking is +104.80!
    if (!payoutItem || !depositItem) throw new Error("Expected payout and deposit items");
    const accepted = await f.owner(
      "inbox.accept",
      { itemIds: [payoutItem.id, depositItem.id] },
      crypto.randomUUID(),
    );
    expect(accepted.body.ok, accepted.text).toBe(true);
    const posted = await f.owner(
      "inbox.post",
      { itemIds: [payoutItem.id, depositItem.id] },
      crypto.randomUUID(),
    );
    expect(posted.body.ok, posted.text).toBe(true);

    const afterAccounts = await f.owner("accounts.list", {});
    const balances = new Map(
      (afterAccounts.body.data.accounts as { code: string; balance: string }[]).map((a) => [
        a.code,
        a.balance,
      ]),
    );
    expect(balances.get("1000")).toBe("104.80");
    expect(balances.get("1050")).toBe("0.00");
    expect(balances.get("4000")).toBe("-100.00");
    expect(balances.get("2100")).toBe("-8.00");
    expect(balances.get("5100")).toBe("3.20");
  });

  test("refuses unbalanced events, undeclared roles, missing uploads, and disabled plugins with clear errors", async () => {
    const f = await fixture();
    await f.setup();
    await f.owner("plugins.install", { manifest: SHOPIFY_MANIFEST }, crypto.randomUUID());
    const upload = await f.uploadRaw("{}", { purpose: "plugin" });
    const sha256 = upload.body.data.sha256 as string;

    // 1. Unbalanced event -> 400 unbalanced_event.
    const unbalanced = await f.owner(
      "plugins.push",
      {
        pluginId: "shopify",
        sourceKey: "shopify:acme",
        rawSha256: sha256,
        events: [
          {
            accountKey: "shopify:acme",
            providerId: "po_bad",
            rawIndex: 0,
            eventOn: "2026-10-10",
            summary: "Bad payout",
            currency: "USD",
            legs: [
              { role: "revenue.sales", amount: "-100.00" },
              { role: "payouts.in-transit", amount: "99.00" },
            ],
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.error.code).toBe("unbalanced_event");
    expect(unbalanced.body.error.message).toContain("-1.00");

    // 2. Undeclared role -> 400 undeclared_role.
    const undeclared = await f.owner(
      "plugins.push",
      {
        pluginId: "shopify",
        sourceKey: "shopify:acme",
        rawSha256: sha256,
        events: [
          {
            accountKey: "shopify:acme",
            providerId: "po_bad_role",
            rawIndex: 0,
            eventOn: "2026-10-10",
            summary: "Unknown role",
            currency: "USD",
            legs: [
              { role: "mystery.bucket", amount: "-100.00" },
              { role: "payouts.in-transit", amount: "100.00" },
            ],
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(undeclared.status).toBe(400);
    expect(undeclared.body.error.code).toBe("undeclared_role");

    // 3. Missing upload SHA-256 -> 404 upload_not_found.
    const missingUpload = await f.owner(
      "plugins.push",
      {
        pluginId: "shopify",
        sourceKey: "shopify:acme",
        rawSha256: "f".repeat(64),
        events: [],
      },
      crypto.randomUUID(),
    );
    expect(missingUpload.status).toBe(404);
    expect(missingUpload.body.error.code).toBe("upload_not_found");

    // 4. Disabled plugin -> 409 plugin_disabled.
    await f.owner(
      "plugins.configure",
      { pluginId: "shopify", enabled: false },
      crypto.randomUUID(),
    );
    const disabled = await f.owner(
      "plugins.push",
      {
        pluginId: "shopify",
        sourceKey: "shopify:acme",
        rawSha256: sha256,
        events: [],
      },
      crypto.randomUUID(),
    );
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe("plugin_disabled");
  });
});

describe("plugins slice: strict rsp_ token isolation and security", () => {
  test("rsp_ token is isolated to its own pluginId, blocks every other operation/route, and honors revoke/expiry/read-only", async () => {
    const ownerKey = issueOwnerKey();
    const f = await fixture({ ownerKey });
    await f.setup();

    await f.owner("plugins.install", { manifest: MERCURY_MANIFEST }, crypto.randomUUID());
    await f.owner("plugins.install", { manifest: SHOPIFY_MANIFEST }, crypto.randomUUID());

    const createOpId = crypto.randomUUID();
    const created = await f.owner(
      "plugins.createToken",
      { pluginId: "mercury", label: "Mercury daemon", expiresInDays: 7 },
      createOpId,
    );
    expect(created.status).toBe(200);
    const token = created.body.data.token as string;
    const tokenId = created.body.data.record.id as string;
    const secret = token.slice(`rsp_${tokenId}_`.length);
    expect(secret.length).toBeGreaterThan(20);

    // Replaying the same create operationId never reveals the secret a second time.
    const replayedCreate = await f.owner(
      "plugins.createToken",
      { pluginId: "mercury", label: "Mercury daemon", expiresInDays: 7 },
      createOpId,
    );
    expect(replayedCreate.status).toBe(200);
    expect(replayedCreate.body.data.token).toBeNull();
    expect(replayedCreate.body.data.record.id).toBe(tokenId);

    // Secret is never listed or stored plaintext in SQLite.
    const listedTokens = await f.owner("plugins.listTokens", { pluginId: "mercury" });
    expect(listedTokens.text).not.toContain(secret);
    expect(listedTokens.body.data.tokens).toHaveLength(1);
    const rawDb = readFileSync(f.path, "latin1");
    expect(rawDb).not.toContain(secret);

    // Allowed: own plugins.status.
    const ownStatus = await f.as(token, "plugins.status", { pluginId: "mercury" });
    expect(ownStatus.status).toBe(200);

    // Refused: cross-plugin plugins.status and plugins.push -> 403 plugin_scope_denied.
    const otherStatus = await f.as(token, "plugins.status", { pluginId: "shopify" });
    expect(otherStatus.status).toBe(403);
    expect(otherStatus.body.error.code).toBe("plugin_scope_denied");

    const otherPush = await f.as(
      token,
      "plugins.push",
      { pluginId: "shopify", sourceKey: "shopify:x", rawSha256: "a".repeat(64) },
      crypto.randomUUID(),
    );
    expect(otherPush.status).toBe(403);
    expect(otherPush.body.error.code).toBe("plugin_scope_denied");

    // Exhaustively refused: EVERY other /v1/* operation in the entire catalog -> 403 permission_denied.
    for (const op of operationCatalog) {
      if (op.name === "plugins.status" || op.name === "plugins.push") continue;
      const denied = await f.as(token, op.name, {}, op.writes ? crypto.randomUUID() : undefined);
      expect(denied.status, `${op.name} should be 403`).toBe(403);
      expect(denied.body.error.code, `${op.name} code`).toBe("permission_denied");
    }

    // Refused inside /v1/batch too!
    const batchRes = await f.http.fetch(
      new Request("http://127.0.0.1:4010/v1/batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          requests: [
            {
              name: "book.get",
              body: { version: APPLICATION_API_VERSION, bookId: f.service.bookId, input: {} },
            },
            {
              name: "plugins.status",
              body: {
                version: APPLICATION_API_VERSION,
                bookId: f.service.bookId,
                input: { pluginId: "mercury" },
              },
            },
          ],
        }),
      }),
    );
    const batchJson = (await batchRes.json()) as {
      ok: boolean;
      data: { responses: { status: number; body: { ok: boolean; error?: { code: string } } }[] };
    };
    expect(batchJson.data.responses[0]?.status).toBe(403);
    expect(batchJson.data.responses[0]?.body.error?.code).toBe("permission_denied");
    expect(batchJson.data.responses[1]?.status).toBe(200);

    // Refused: non-plugin upload purpose, legacy /api/*, telemetry.
    const badUpload = await f.uploadRaw("a,b\n1,2\n", {
      credential: token,
      purpose: "statement",
      contentType: "text/csv",
    });
    expect(badUpload.status).toBe(403);
    expect(badUpload.body.error.code).toBe("permission_denied");

    const legacy = await f.http.guardLegacy(
      new Request("http://127.0.0.1:4010/api/book", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(legacy?.status).toBe(403);

    const telemetry = await f.http.credentialed(
      new Request("http://127.0.0.1:4010/telemetry", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(telemetry instanceof Response ? telemetry.status : 200).toBe(403);

    // Read-only workspace: status stays 200, push & plugin upload get 403 workspace_read_only,
    // while disallowed operations still get 403 permission_denied.
    const setRo = await f.http.fetch(
      new Request("http://127.0.0.1:4010/v1/book.access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: f.service.bookId,
          operationId: crypto.randomUUID(),
          input: { readOnly: true },
        }),
      }),
      f.http.serviceAccess("control-plane"),
    );
    expect(setRo.status).toBe(200);

    const roStatus = await f.as(token, "plugins.status", { pluginId: "mercury" });
    expect(roStatus.status).toBe(200);

    const roUpload = await f.uploadRaw("{}", { credential: token, purpose: "plugin" });
    expect(roUpload.status).toBe(403);
    expect(roUpload.body.error.code).toBe("workspace_read_only");

    const roPush = await f.as(
      token,
      "plugins.push",
      { pluginId: "mercury", sourceKey: "mercury:chk_01", rawSha256: "b".repeat(64) },
      crypto.randomUUID(),
    );
    expect(roPush.status).toBe(403);
    expect(roPush.body.error.code).toBe("workspace_read_only");

    const roOther = await f.as(token, "accounts.list", {});
    expect(roOther.status).toBe(403);
    expect(roOther.body.error.code).toBe("permission_denied");

    // Clear read-only, test tampered secret, expiry, and explicit revocation.
    await f.http.fetch(
      new Request("http://127.0.0.1:4010/v1/book.access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: f.service.bookId,
          operationId: crypto.randomUUID(),
          input: { readOnly: false },
        }),
      }),
      f.http.serviceAccess("control-plane"),
    );

    const flipped = token.endsWith("0") ? "1" : "0";
    const tampered = await f.as(`${token.slice(0, -1)}${flipped}`, "plugins.status", {
      pluginId: "mercury",
    });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe("token_invalid");

    // Advance clock past 7-day expiry -> 401 token_expired.
    f.advance(8 * 24 * 60 * 60 * 1000);
    const expired = await f.as(token, "plugins.status", { pluginId: "mercury" });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("token_expired");

    // Explicit revocation -> 401 token_revoked.
    const revoked = await f.owner(
      "plugins.revokeToken",
      { tokenId, reason: "Rotated" },
      crypto.randomUUID(),
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.record.status).toBe("revoked");
    const afterRevoke = await f.as(token, "plugins.status", { pluginId: "mercury" });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error.code).toBe("token_revoked");
  });
});

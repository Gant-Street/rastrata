import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { pick } from "../support/pick";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

const lookFolder = process.env.RASTRATA_LOOK ?? "";

async function api(
  request: import("@playwright/test").APIRequestContext,
  name: string,
  input: unknown,
  operationId?: string,
) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}

async function scan(page: Page, label: string) {
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  );
  expect(violations, label).toEqual([]);
}

async function captureMatrix(page: Page, name: string) {
  if (!lookFolder) return;
  mkdirSync(lookFolder, { recursive: true });
  const prevSize = page.viewportSize();
  const prevTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [360, 780],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(80);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${name} ${width}px ${theme} horizontal overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: join(lookFolder, `${name}-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }

  await page.evaluate((t) => {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }, prevTheme);
  if (prevSize) await page.setViewportSize(prevSize);
}

const BOOK = {
  name: "Plugins UI Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Mercury Checking", role: "asset" },
    {
      code: "1050",
      name: "Payouts in Transit",
      role: "asset",
      tags: { roleKey: "payouts.in-transit" },
    },
    { code: "2100", name: "Sales Tax Payable", role: "liability", tags: { roleKey: "tax.sales" } },
    { code: "3000", name: "Owner Equity", role: "equity" },
    { code: "4000", name: "Product Sales", role: "income", tags: { roleKey: "revenue.sales" } },
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
  authLabel: "Mercury read-only API token",
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
      key: "payouts.in-transit",
      label: "Payouts in transit",
      kind: "asset",
      required: true,
      defaultRoleKey: "payouts.in-transit",
    },
    {
      key: "revenue.sales",
      label: "Shopify Sales",
      kind: "income",
      required: true,
      defaultRoleKey: "revenue.sales",
    },
    {
      key: "tax.sales",
      label: "Sales tax payable",
      kind: "liability",
      required: true,
      defaultRoleKey: "tax.sales",
    },
    {
      key: "shopify.fees",
      label: "Shopify Fees",
      kind: "expense",
      required: true,
    },
  ],
  clearing: { role: "payouts.in-transit", windowDays: 7 },
};

test("Settings -> Plugins: empty state, install dialog, role mapping, tokens, and responsive audit", async ({
  page,
  request,
}) => {
  await api(request, "book.setup", BOOK, crypto.randomUUID());
  const listed = await api(request, "accounts.list", {});
  const byCode = new Map<string, string>(
    (listed.accounts as { id: string; code: string }[]).map((a) => [a.code, a.id]),
  );

  // 1. Empty state
  await page.goto("/settings/plugins");
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install a plugin" })).toBeVisible();
  await scan(page, "plugins empty state");
  await captureMatrix(page, "plugins-empty");

  // 2. Open Install dialog, paste Mercury manifest, inspect preview, and install
  await page.getByRole("button", { name: "Install a plugin" }).click();
  const dialog = page.getByRole("dialog", { name: "Install a plugin" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Manifest JSON").fill(JSON.stringify(MERCURY_MANIFEST, null, 2));
  await expect(dialog.getByText("api.mercury.com")).toBeVisible();
  await scan(page, "plugins install dialog");
  await captureMatrix(page, "plugins-install-dialog");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Mercury" })).toBeVisible();

  // Seed Mercury account binding + synced cursor AND Shopify with 1 unmapped required role
  // so the screenshot showcases BOTH a clean ready plugin (ink rule) and one needing setup (orange rule).
  await api(
    request,
    "plugins.configure",
    {
      pluginId: "mercury",
      accountMap: [{ accountKey: "mercury:acct_chk_01", ledgerAccountId: byCode.get("1000") }],
    },
    crypto.randomUUID(),
  );
  const uploadRes = await request.post("/v1/uploads", {
    headers: {
      "content-type": "application/json",
      "x-upload-for": "plugin",
    },
    data: JSON.stringify({ transactions: [] }),
  });
  const uploadJson = await uploadRes.json();
  await api(
    request,
    "plugins.push",
    {
      pluginId: "mercury",
      sourceKey: "mercury:acct_chk_01",
      rawSha256: uploadJson.data.sha256,
      cursor: "2026-10-15",
      fetchedAt: "2026-10-15T16:30:00.000Z",
      bankLines: [],
    },
    crypto.randomUUID(),
  );
  await api(request, "plugins.install", { manifest: SHOPIFY_MANIFEST }, crypto.randomUUID());

  await page.reload();
  await expect(page.getByRole("heading", { name: "Mercury" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shopify" })).toBeVisible();
  await expect(page.getByText("Choose an account for Shopify Fees.")).toBeVisible();
  await scan(page, "plugins installed and needs setup");
  await captureMatrix(page, "plugins-connected");

  // 3. Map Shopify Fees via Ark SelectField and save -> attention clears
  const shopifySection = page.locator("section.rt-plugin", { hasText: "Shopify" });
  await pick(
    page,
    shopifySection.getByRole("combobox", { name: "Shopify Fees" }),
    "Payment Processing Fees",
  );
  await shopifySection.getByRole("button", { name: "Save" }).click();
  await expect(shopifySection.getByText("Saved")).toBeVisible();
  await expect(page.getByText("Choose an account for Shopify Fees.")).toBeHidden();

  // 4. Open Access tokens dialog for Mercury, issue a one-time rsp_ token, verify reveal, and revoke
  await page.getByRole("button", { name: "Actions for Mercury" }).click();
  await page.getByRole("menuitem", { name: "Access tokens" }).click();
  const tokensDialog = page.getByRole("dialog", { name: "Mercury access tokens" });
  await expect(tokensDialog).toBeVisible();
  await tokensDialog.getByLabel("Label").fill("Laptop cron");
  await tokensDialog.getByRole("button", { name: "Create token" }).click();
  await expect(tokensDialog.getByText("Copy this token now.")).toBeVisible();
  await expect(tokensDialog.locator("code")).toContainText("rsp_");
  await scan(page, "plugins tokens dialog");
  await captureMatrix(page, "plugins-tokens-dialog");
  await tokensDialog.getByRole("button", { name: "Revoke" }).click();
  await expect(tokensDialog.getByText("Revoked")).toBeVisible();
  await tokensDialog.getByRole("button", { name: "Done" }).click();
  await expect(tokensDialog).toBeHidden();
});

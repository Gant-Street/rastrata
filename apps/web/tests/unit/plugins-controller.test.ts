import { describe, expect, test } from "bun:test";
import { pluginAccountOptions, toPluginDetailItem } from "../../src/routes/plugins/controller";

describe("plugins route controller", () => {
  test("sorts chart account options by code and formats label", () => {
    const options = pluginAccountOptions([
      {
        id: "acc_2",
        code: "5100",
        name: "Stripe Fees",
        role: "expense",
        closedOn: null,
        balance: "0.00",
      } as never,
      {
        id: "acc_1",
        code: "1000",
        name: "Mercury Checking",
        role: "asset",
        closedOn: null,
        balance: "0.00",
      } as never,
    ]);
    expect(options).toEqual([
      { value: "acc_1", label: "Mercury Checking", kind: "asset", closed: false },
      { value: "acc_2", label: "Stripe Fees", kind: "expense", closed: false },
    ]);
  });

  test("maps PluginDetailView preserving clearing window default", () => {
    const item = toPluginDetailItem({
      pluginId: "shopify",
      version: "1.0.0",
      name: "Shopify",
      description: "Imports Shopify payouts.",
      enabled: true,
      ready: false,
      domains: ["admin.shopify.com"],
      authKind: "oauth2",
      authLabel: null,
      authEnvVar: null,
      config: [],
      roles: [],
      accountMap: [],
      clearing: { role: "payouts.in-transit" },
      cursors: [],
      installedAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-15T12:00:00.000Z",
    });
    expect(item.clearing).toEqual({ role: "payouts.in-transit", windowDays: 7 });
  });
});

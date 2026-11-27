import type { PluginCatalogEntry } from "@rastrata/ui";

/** Verified built-in plugin catalog rendered immediately (<100 ms) in Settings -> Plugins.
 * Only plugins dogfooded against real provider APIs appear here as official connectors. */
export const OFFICIAL_PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
  {
    id: "stripe",
    version: "1.0.0",
    name: "Stripe",
    description:
      "Imports Stripe payouts as balanced multi-leg entries (sales, tax, refunds, disputes, fees) with automatic bank-deposit clearing.",
    tier: "official",
    manifest: {
      id: "stripe",
      version: "1.0.0",
      name: "Stripe",
      description:
        "Imports Stripe payouts as balanced multi-leg entries (sales, tax, refunds, disputes, fees) with automatic bank-deposit clearing.",
      domains: ["api.stripe.com"],
      authKind: "api_key",
      authLabel: "Stripe restricted read-only key",
      authEnvVar: "RASTRATA_PLUGIN_STRIPE_KEY",
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
          label: "Sales",
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
          key: "refunds",
          label: "Refunds",
          kind: "income",
          required: true,
          defaultRoleKey: "refunds",
        },
        {
          key: "chargebacks",
          label: "Chargebacks and disputes",
          kind: "expense",
          required: true,
          defaultRoleKey: "chargebacks",
        },
        {
          key: "stripe.fees",
          label: "Stripe fees",
          kind: "expense",
          required: true,
          defaultRoleKey: "stripe.fees",
        },
        {
          key: "stripe.adjustments",
          label: "Other Stripe adjustments",
          kind: "expense",
          required: false,
          defaultRoleKey: "stripe.adjustments",
        },
      ],
      clearing: { role: "payouts.in-transit", windowDays: 7 },
    },
  },
];

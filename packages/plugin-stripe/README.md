# `@rastrata/plugin-stripe` (MIT)

Official Rastrata ingestion plugin for **Stripe** payouts, balance transactions, and bank-deposit clearing.

- **License:** MIT
- **Egress allowlist:** `api.stripe.com` only
- **Auth:** Restricted read-only Stripe key (`RASTRATA_PLUGIN_STRIPE_KEY`, kept on your machine). Required read permissions: `Payouts`, `Balance transactions` (plus `Checkout Sessions` / `Invoices` if enabling Stripe Tax split; `Account` and `Balance` are optional).
- **Accounting method (A2X pattern):** One balanced multi-leg `LedgerEvent` per automatic payout (sales, optional Stripe Tax from Checkout/Invoices or metadata, refunds, chargebacks, fees, adjustments, payouts in transit), every underlying balance transaction archived as `coveredBy` evidence, and automatic 1-to-1 clearing match against bank deposits.

## Dogfood with `--dry-run` (zero writes to Rastrata)

```sh
RASTRATA_PLUGIN_STRIPE_KEY="rk_live_..." rastrata plugin sync ./packages/plugin-stripe --dry-run
```

## Local test

```sh
bun run --cwd packages/plugin-stripe test
```

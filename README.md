# Rastrata

**Open-source accounting your own agent runs.**

Rastrata is double-entry small-business accounting built from a formally verified, immutable ledger outward — designed so the AI agent you already use (Claude Code, Codex, opencode, or your own CLI/MCP agent) does the daily bookkeeping while you review, reconcile, and close the month.

- **Free forever on your machine:** run the single-file `rastrata-service` binary locally with a SQLite book you own, the web app, the Go CLI/TUI, and the MCP server.
- **Rastrata Cloud:** managed hosting at [rastrata.com](https://rastrata.com) ($19/month flat for all businesses you own, 30-day free trial) with daily US bank feeds, team and accountant seats, and full export to run locally anytime.
- **No hosted agent, no AI credits:** connect the agent you already pay for over scoped, revocable tokens.
- **Formally proved kernel:** core double-entry, immutability, reversal, and period-close invariants are proved in Lean 4 (`proofs/`).

## Quick start (local development)

Tool versions are pinned in `.bun-version` and `.go-version`.

```sh
bun install --frozen-lockfile
bun run dev:api          # http://127.0.0.1:4010
RASTRATA_API_URL=http://127.0.0.1:4010 bun run dev:web   # http://127.0.0.1:4000
```

Build the Go CLI and TUI:

```sh
bun run --cwd apps/terminal build
apps/terminal/dist/rastrata tui
```

Build the self-contained single-executable local package (`rastrata-service` + `rastrata` + `install.sh`):

```sh
bun run package
```

## Verify

```sh
bun run gate             # fast static checks + unit & screen tests
bun run typecheck
bun run lint
bun run format:check
bun run test
```

## Repository layout

| Path | License | Purpose |
| --- | --- | --- |
| `packages/kernel/` | AGPL-3.0 | Immutable double-entry accounting kernel (100% test coverage) |
| `packages/ledger/` | AGPL-3.0 | Durable append-only book storage and replay |
| `packages/application/` | AGPL-3.0 | Bookkeeping workflows, ingestion, rules, reconciliation, tax, and reports |
| `packages/booklog/` | AGPL-3.0 | Hash-chained book log and snapshotting |
| `packages/plugin-sdk/` | MIT | Zero-dependency SDK, runner, and test harness for Rastrata ingestion plugins |
| `packages/plugin-stripe/` | MIT | Official Stripe payout, evidence, and bank-clearing plugin |
| `packages/telemetry/` | AGPL-3.0 | Static OpenTelemetry metric and span catalog |
| `packages/ui/` | AGPL-3.0 | SolidJS + Ark UI ledger design system |
| `apps/api/` | AGPL-3.0 | Application HTTP server and single-file `rastrata-service` binary |
| `apps/web/` | AGPL-3.0 | Web application (SolidJS) |
| `apps/terminal/` | MIT | Go CLI and TUI (`rastrata`) |
| `apps/mcp/` | MIT | Model Context Protocol (MCP) server for agent integrations |
| `plugins/rastrata/` | MIT | Agent plugin manifest and bookkeeping skills |
| `proofs/` | AGPL-3.0 | Lean 4 formal proofs of the accounting kernel |
| `docs/` | AGPL-3.0 | Tutorials, how-to guides, and architecture explanations |

## Licensing, trademarks, and contributing

- **Core engine, service, web app, and proofs:** [GNU AGPLv3](LICENSE)
- **CLI, MCP server, and plugin definitions:** [MIT](LICENSE-MIT)
- **Trademarks:** [TRADEMARK.md](TRADEMARK.md)
- **Security:** [SECURITY.md](SECURITY.md)
- **Contributing & CLA:** [CONTRIBUTING.md](CONTRIBUTING.md)

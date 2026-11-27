# Rastrata ChatGPT plugin

The initial plugin exposes manual bookkeeping through a Streamable HTTP MCP server
and a bundled bookkeeping skill. It uses the same application API as the CLI,
TUI and web app. The API process owns SQLite, ledger credentials and all accounting
decisions; this process sends versioned HTTP requests.

## Run locally

Start the API, or reuse the already running local API, then start MCP:

```sh
bun run dev:api
# In another terminal:
bun run dev:mcp
```

The MCP endpoint is `http://127.0.0.1:4020/mcp`; health is at `/health`.
Defaults are book `local-book`, API `http://127.0.0.1:4010`, and permissions
`read,draft`. Posting, chart changes, corrections, period transitions and setup
require an explicit operator grant:

```sh
RASTRATA_MCP_PERMISSIONS=read,draft,post,configure,correct,close,provision bun run dev:mcp
```

`RASTRATA_API_URL`, `RASTRATA_BOOK_ID`, `RASTRATA_MCP_PORT`, and
`RASTRATA_MCP_PERMISSIONS` configure the process. Direct launches also require
`RASTRATA_LOCAL_DEV=1`. Both listeners and the upstream API target are loopback;
request arguments cannot choose another book, host, actor, or permission set.

A connection that sends `Authorization: Bearer rst_...` (an agent token) acts as that token: the API
decides what it grants and enforces it on every call, so the tool list is that token's, not the
operator's `RASTRATA_MCP_PERMISSIONS`. Refused credentials are a 401, never a fall back to the
operator's grants. Token management is never a tool. If the API runs with `RASTRATA_OWNER_KEY_FILE`,
connections that bring no token need the same variable set for this process.

`rastrata_recover_draft` reopens the same draft at a new version after a durable
rejection. It requires the `draft` grant; the old posting remains inspectable and
replay returns its original rejection. Prepare and review a new posting after
recovery. An uncertain or committed posting cannot be reopened.

`rastrata_get_source` and `rastrata_list_sources` inspect stable source identities,
original facts, linked drafts, posting receipts and reversals. Supply `source` when
creating a proposal; references alone remain freeform. The API rejects changed
source facts, duplicate postings and replacement attempts while a source's posting
is uncertain. Untagged entries and different source IDs are not deduplicated.

All 24 application operations have focused tools derived from the canonical input
and output schemas. Two additional read tools provide the workflow guide and a new
operation UUID. Discovery shows only operations permitted by the operator. The
commit tool checks the retained plan kind, so posting permission cannot commit a
chart change, reversal, or period transition.

Writes retain their original identities in the API. Previews return immutable
plan IDs and hashes; commits and interrupted requests reuse those values. Reports
keep the API's decimal strings and population scope intact. The plugin performs
no financial calculations and stores no second copy of the book.

## Package and connect

The portable package source is [`plugins/rastrata`](../../plugins/rastrata).
Build a local package into a new, empty directory:

```sh
bun run --cwd apps/mcp package:plugin --out /tmp/rastrata-local-plugin
```

This produces a folder and `rastrata.zip`. The local `mcp.json` targets port 4020
for clients running on the same computer. ChatGPT needs a registered connection
reachable through Secure MCP Tunnel; follow the
[ChatGPT connection guide](../../docs/how-to/connect-chatgpt-plugin.md).
After registration, `--app-id` binds the package to that actual connection instead
of bundling the local URL. Registration IDs and credentials are not committed.

The skill is also available as a read tool, MCP resource, prompt and the
`io.modelcontextprotocol/skills` discovery extension. Tools-only clients can read
the guide without implementing the extension. ChatGPT's imported skills are static
snapshots; refresh discovery after changing the skill.

## Check

```sh
bun run --cwd apps/mcp typecheck
bun run --cwd apps/mcp test
bun run --cwd apps/mcp build
```

Tests use isolated temporary books and an MCP SDK client. They cover journals,
reports, pinned drill-through, corrections, close/reopen, restart and lost-response
recovery, permission limits, HTTP guards, skill discovery and package integrity.
They do not constitute a ChatGPT model evaluation. The
[evaluation inventory](../../docs/reference/chatgpt-plugin-evaluation.md) defines
the conversations to run after connecting an account.

This is a private development integration with the local operator identity.
Production user authentication, hosted MCP deployment, public directory submission
and commercial document workflows remain separate milestones.

## Agent evaluation

Run `bun run eval:agent list` from the repository root to inspect the isolated
bookkeeping scenarios. See the [evaluation guide](../../docs/how-to/evaluate-bookkeeping-agents.md)
for live Codex MCP/CLI runs, supervised ChatGPT trials, traces and independent
grading. Live model runs are opt-in; the harness's deterministic tests are included
in this workspace's normal checks.

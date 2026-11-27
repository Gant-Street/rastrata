# Rastrata terminal

One Go executable for the headless CLI and the explicitly launched Charm TUI.
Both call the shared TypeScript application service. Accounting calculations and
ledger credentials stay in that service; no client opens SQLite.

Install the versions in `.bun-version` and `.go-version`, then from the root:

```sh
bun ci
bun run dev:api
# In another terminal:
bun run --cwd apps/terminal build
apps/terminal/dist/rastrata context
apps/terminal/dist/rastrata help
apps/terminal/dist/rastrata tui
```

**The installed build** (the one in the package, [Install Rastrata](../../docs/how-to/install-rastrata.md))
is the same program built with `-X .../internal/buildinfo.Channel=installed`. Every build has the
commands that look after an installed service: `install`, `start`, `stop`, `status`, `logs`, `open`,
`doctor`, `update --from FILE`, `uninstall` and `backup folder`
(`internal/service`, `internal/cli/commands_install.go`). It defaults to the installed service's
port (7278, or the one in `config.json`) and reads the owner key from the data directory. A build from
the repository, as below, keeps the development defaults.

The independently running Bun API is required. Defaults are
`http://127.0.0.1:4010` and `local-book`; override with `--endpoint` and `--book`
or `RASTRATA_API_URL` and `RASTRATA_BOOK_ID`. The current profile supports explicit
loopback development access, USD/EUR/GBP, accrual, and monthly/quarterly periods
in one fiscal year. It does not issue production user credentials.

Every supported workflow has a headless command and a catalog entry. JSON is the
default output: one versioned envelope on stdout, diagnostics on stderr. No TTY,
prompt, ANSI output or interactive fallback is required. `--input -` reads one
bounded JSON object from stdin; `--input FILE` reads a file. See
`rastrata schema OPERATION` for exact inputs and outputs, and `capabilities` for
the live service profile. `call OPERATION` exposes the entire catalog.

Identify original events with a stable `source: { id, description, evidenceReference? }`
on drafts. `sources list` pages/searches retained sources; `sources get ID` shows
original facts, linked drafts, posting receipts and corrections. Display references
are freeform. The server blocks changed source facts, duplicate posting and new
attempts while an original posting is uncertain. Untagged entries and different
source IDs are not deduplicated. Tagged drafts expose a separate `journalId` for
financial detail/correction commands.

The TUI journal form includes the source ID, description and evidence reference.
`Ctrl+g` reads the current source without writing; `Esc` returns to the editor.
A source remains consumed after a reversal. Evidence references do not upload or
fetch files. See the [application contract](../../packages/application/README.md).

Use `--format text` for plain indented output. Export one report with
`reports trial-balance --as-of 2026-01-31 --format csv`; report CSV includes its
date, basis, currency, revision and population. Amounts and revisions are strings,
including values beyond JavaScript's numeric precision.

Writes save their identity and exact request before dispatch. The request journal
uses private directory/file permissions and durable atomic writes. Its default is
the OS user cache directory under `rastrata/requests`; set `--request-dir` or
`RASTRATA_REQUEST_DIR` to retain it elsewhere. Preserve this directory to resume
operations; it contains financial inputs and replies. `operations requests` lists
retained requests for the selected endpoint/book. `operations status ID` reads the
server's result. `operations resume ID` resends the original bytes, preferring a
retained commit over its preparation. It never builds a new plan from current state.

Draft create/save/recover/discard retries return their retained result, even after edits,
discard or restart. A preparation retains the exact command, plan hash and expected
revision without posting. Review its effects, then use `operations commit ID HASH`.
Commit rechecks authority and draft version; a stale book plan is durably rejected.
Reusing an identity with different input fails. Review changed input under a new
identity. Use `drafts recover --input FILE` with `draftId`, `expectedVersion` and
`postingOperationId` to reopen a durably rejected draft at a new version. The
rejected plan remains immutable; inspect the recovered draft, edit if needed and
prepare a new posting identity for review. Recovery requires the `draft` grant
and cannot reopen a committed or uncertain posting. Cancellation leaves
a submitted write potentially unresolved, rather than claiming a rollback.

Exit codes: `0` success; `2` usage/input; `3` rejection, conflict or denied access;
`4` connection/client failure; `5` unresolved write. A successful API envelope may
still describe an accounting rejection or invalid preparation, which exits `3`.

The TUI supports five numbered areas: accounts, journal/drafts, account activity,
reports and periods. Fresh books open guided setup with the displayed four-account
starting chart. `Tab` changes area, arrows select, and `Enter` opens details/forms.
`F1` shows the complete keyboard guide in any editor; `Esc` returns without losing
the editor. `q` exits outside forms. `NO_COLOR=1` preserves the text status labels.

In Journal, `n` opens a draft, `Ctrl+p` chooses an exact account, and `Ctrl+n` adds
a line. `Ctrl+s` saves only. `Ctrl+Enter` (or Enter on the last field) saves then
reviews the posting. Review shows its immutable identity, hash and exact effects;
Enter commits it. Invalid previews remain editable. `v` switches drafts/register,
`x` prepares a reversal, and rejected draft detail supports `r` to recover the
same draft for editing at a new version. The original rejection remains; review
a new plan before posting. Period close review includes its report population
and close package.

Reports use `t` to cycle statements and `d` to set date/revision. Enter drills into
account activity, then into a journal, retaining the original report population.
`i` shows full context/population metadata. `[` / `]` page registers and activity;
`r` explicitly refreshes. `o` inspects the last operation and `u` resumes it. F2
shows complete field errors. A pending write locks dependent controls; Esc stops
waiting and opens recovery without claiming rollback. Unsaved editor exits and
draft discard require a local confirmation. macOS and Linux are the initial
targets; use at least 40×20 cells, with wider terminals providing denser tables.

Agents. `rastrata connect CODE` connects an agent from the folder it works in, in one step: it exchanges
a code from a hosted workspace's agent settings for the agent's key (with no code, on a computer that
runs the service, it makes a token as the owner: `connect [--preset read-only|draft|bookkeeper]`), keeps
it in `connections.json` in the person's configuration folder (0600, never in the project, never
printed; `RASTRATA_CONFIG_DIR` moves the folder), checks it, and writes the runbook for the agents.
Commands run in that folder, or under it, then use the connection and its address.
`rastrata tokens create|list|revoke|activity` manages scoped tokens (the owner's commands; a
token cannot hold `provision`). The CLI sends `RASTRATA_TOKEN` as a Bearer credential, or the owner key
from the file named by `RASTRATA_OWNER_KEY_FILE`; the token wins when both are set, and either wins over
a folder's connection. A credential is
never written to the request journal, and the reply to `tokens create` is never kept. `rastrata agent
init --agent claude|codex|opencode|all` writes the runbook and guide into a project (never a secret),
`agent guide` prints the guide and `agent status` says who the service thinks you are and whether it is
open. `rastrata schema --check [--live]` compares this build, and a running service, with the frozen
contract ([policy](../../docs/reference/contract-policy.md)). See
[Connect your agent](../../docs/how-to/connect-your-agent.md).

The schema and TypeScript/Go bindings are generated from
`packages/application/src/schema.ts`. Run `bun run generate:contracts` after a
contract change. `bun run check:contracts` and Go/schema validation prevent drift.
The [terminal tutorial](../../docs/tutorials/first-terminal-book.md) provides a
complete synthetic workflow. Agent usability evaluations, plugins and auth remain
separate work; passing accounting tests does not prove autonomous bookkeeping.

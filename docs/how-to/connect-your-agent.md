# Connect your agent to your books

For the owner of a Rastrata book who uses a coding agent such as Claude Code, Codex or opencode and
wants it to do the routine bookkeeping. You choose what the agent may do and run one command in the
folder it works in. You keep the right to approve everything that changes the books, and you can
disconnect the agent at any time.

<!-- help: skip -->
Read [Agent access](../explanation/agent-access.md) first if you want to know what a token does and
does not protect you from.

This page is for books on your own computer. If your books are in a workspace at app.rastrata.com, see
[Connect your agent to a hosted workspace](connect-your-agent-to-a-hosted-workspace.md).
<!-- help: end -->

## Before you start

<!-- help: skip -->
- From the repository: the service is running (`bun run dev:api`) and the `rastrata` command is built
  (`bun run --cwd apps/terminal build`) and on your path.
<!-- help: end -->
- The service has a book. The first agent should work on a book you can afford to look at closely.
- A project folder for the agent to work in. It can be empty; it is where the instructions go.

## 1. Choose what the agent may do

In the web app open **Settings**, then **Agents**. Under **What may it do?** choose one:

- **Prepare, for my approval** (the usual start): the agent reads, brings transactions in and drafts.
  Nothing is posted until you accept it.
- **Read only**: the agent reads and explains.
- **Run the books**: the agent also posts. You reconcile and close.

None of the three lets an agent finish a reconciliation or close a month.

## 2. Run the one command

The page shows the command for your choice. Run it in the folder the agent works in:

```sh
rastrata connect                        # Prepare, for my approval
rastrata connect --preset read-only     # Read only
rastrata connect --preset bookkeeper    # Run the books
```

There is no code to copy: on this computer you are the owner, and the command asks the service as you.
It does four things and says one line (`Connected to your books. This agent can read and draft until
February 15, 2027.`):

1. It makes a token for the agent with what you chose. The token never appears on a screen, in your
   clipboard or in your shell's history.
2. It keeps the token in a file that only you can read, in your own configuration folder
   (`~/Library/Application Support/rastrata/connections.json` on macOS,
   `~/.config/rastrata/connections.json` on Linux), and never in the project.
3. It checks that the service accepts it.
4. It writes the instructions the agent follows into the folder, for Claude Code
   (`.claude/skills/rastrata/SKILL.md` and `guide.md`) and for Codex and opencode (a Rastrata section
   in `AGENTS.md`; the rest of the file is untouched). It never writes a secret, and it leaves any file
   you edited alone. `--agent claude` (or `codex`, `opencode`, `none`) writes for one agent or none.

From then on every `rastrata` command run in that folder, or under it, acts as the agent, with nothing
set. Outside the folder the command is still you, the owner. The agent appears on the Agents page under
**Connected** when you come back to it, named for this computer (`--name "Claude Code on my laptop"`
gives it another name).

`rastrata agent status`, run in the folder, shows who the service thinks the agent is (`principal`),
its permissions, when its token expires, and **whether the service is open**. If it says owner access
is open, any program running as you can use Rastrata without a token; the token limits an agent that
uses it, and nothing more.
<!-- help: skip -->
See [Agent access](../explanation/agent-access.md#what-a-token-does-not-do).
<!-- help: end -->

Do not give the agent your owner key (`RASTRATA_OWNER_KEY_FILE`, or the `owner.key` file in your data
directory). An agent should never need the key.

### When you want to choose exactly, or to hold the token yourself

`rastrata connect` covers the three choices. For anything else, make the token yourself:

```sh
rastrata tokens create --label "Claude Code on my laptop" --permissions read,draft,post,close
```

The presets are `read-only`, `draft` and `bookkeeper`; `--permissions` chooses exactly. A token never
holds `provision`, so an agent can never make another token or widen its own. It expires after 90 days
unless you pick up to a year with `--expires-in-days`. **The token is shown once**, in the command's
output: Rastrata keeps only a hash of it. Set it in the environment the agent runs in, without leaving
it in your shell history (`read -rs RASTRATA_TOKEN; export RASTRATA_TOKEN`), or have your secrets
manager set it; when `RASTRATA_TOKEN` is set the command uses it and ignores what `rastrata connect`
kept. Then write the instructions with `rastrata agent init --agent claude` (or `codex`, `opencode`,
`all`).
<!-- help: skip -->
`--mcp=true` also writes an MCP entry, which needs the MCP server running (`bun run dev:mcp`); for
Codex it prints a snippet to add to `~/.codex/config.toml` yourself.
<!-- help: end -->

**`close` is in no choice, on purpose.** It lets an agent finish or void a reconciliation and close
or reopen an accounting period, and those steps have no review of their own: nothing is shown to you
first unless the agent chooses to. The agent's runbook tells it to ask, and a good agent does, but
the token is what decides. Leave `close` off unless you want the agent to do those steps unreviewed.
Without it an agent can still start a reconciliation, choose its transactions and prepare a close for you
to complete.

## 3. Ask the agent to work

The Agents page says what to ask, for the choice you made. A request that keeps you in control:

> Review this week's transactions and show me what you would post.

The agent imports statements, lets your rules categorize what they can, proposes rules for repeated
exceptions, reconciles, and reports what is waiting for you. An agent that prepares can propose but
not post; you post.

### When nobody is there to approve the agent's commands

An agent that asks you before it runs a command is fine. One that runs on a schedule, with a list of
commands it may run and nobody to ask, can get stuck: in the first measured runs an agent whose shell
command was refused (a loop, a `python3 -c` with a line break) stopped at once, and another could not read
a long list and drafted nothing. Give it what it needs:

- **Claude Code:** its sandbox mode runs commands inside the operating system's sandbox without asking:
  writes are limited to the project and the network to the hosts you allow, and you can deny reads of the
  folders you care about (the evaluation denies the whole home directory). Or approve `Bash(rastrata *)`,
  `Bash(jq *)` and a few read-only tools in the project's settings, and keep `curl`, `git` and your home
  directory out of reach.
  A sandbox that cannot read your configuration folder cannot read what `rastrata connect` kept: give that
  agent its token in `RASTRATA_TOKEN` instead (the section above).
- **Codex and opencode** have no sandbox of that kind: run them only where you would be willing to watch,
  and keep `RASTRATA_TOKEN` the only credential in their environment.
- Whatever the agent is, the token is the limit that holds: `draft` to begin with, and not `close`.

## 4. See what it did, and take access away

- **Settings**, **Changes** (the Agents page links to it) lists what agents changed, by each agent's
  name. `rastrata tokens activity` lists every request made with a token: when, which token, which
  operation, and whether it was allowed or refused. Your own requests are not recorded.
- The Agents page, or `rastrata tokens list`, shows each agent's access and last use. Home tells you
  under **Needs you** two weeks before one stops working.
- **Disconnect** beside the agent on the Agents page, or `rastrata tokens revoke TOKEN_ID`, stops it
  on its next request. Anything it already did stays in the books; corrections are reversals.

## If something goes wrong

| You see | Why | What to do |
| --- | --- | --- |
| `permission_denied` | The agent lacks that permission | Ask yourself whether it should have it; connect it again with a wider choice if so. The agent should stop and say so, not look for another way |
| `token_expired` or `token_revoked` | The agent was disconnected, or its 90 days ran out | Run `rastrata connect` in its folder again |
| `authentication_required` | The service is locked and nothing is connected in this folder | Run `rastrata connect` in the folder the agent works in |
| `the connections file ... must be private to you (chmod 600)` | The file that keeps the agent's token can be read by others on this computer | `chmod 600` the file it names |
| `rastrata schema --check --live` reports a difference | The command and the service are different versions | Update the older one; the report names each difference |
| A transaction in For review tells the agent what to do | A bank memo or invoice contains instructions | The runbook tells the agent to treat it as data and show it to you. If it acted on it, disconnect the agent and tell us |

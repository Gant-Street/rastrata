# Agent access: how an agent works on your books

For anyone deciding whether to let an agent near their books, and for anyone changing how access
works. It explains the design and, because trust depends on it, what the design does not protect
you from. The steps are in [Connect your agent](../how-to/connect-your-agent.md); the promises about
the interface are in the [operation contract policy](../reference/contract-policy.md).

## The idea

You bring your own agent: Claude Code, Codex, opencode or another that can run a command. Rastrata
does not run a model. It offers an agent three things:

1. **A command line and an API an agent can use reliably**: JSON in, JSON out, stable identifiers,
   every write idempotent and recoverable, exact money.
2. **A limited credential**: a token that allows only the permissions you choose.
3. **Review gates that no credential can skip**: an agent drafts and prepares; a person approves the
   exact effects; only then does a commit post. A token that cannot `post` cannot commit a posting
   at all, whatever it asks for.

The ledger underneath cannot be corrupted by a model: entries are immutable, corrections are linked
reversals, and the same source event cannot be booked twice.

## Rules do the daily work

Rastrata follows the position of the hledger maintainers, who ask that software not use a model at
runtime and use one upstream to build deterministic tools. The agent's judgment goes into
*writing and refining rules and importers*; deterministic rules and a classifier trained on your own
history do the daily categorising. The books are cheaper to run, reproducible and auditable, and the
agent spends its attention on the exceptions. The runbook tells the agent to propose a rule when the
same exception repeats instead of judging every line.

## Who can do what

| Caller | How it is recognised | Holds |
| --- | --- | --- |
| **The owner** | A request with no credentials, on a service that is open; or the owner key, on one that is locked | Everything, including `provision` (set up the book, manage tokens) |
| **An agent** | `Authorization: Bearer rst_<id>_<secret>` | Only the permissions on its token, from `read`, `draft`, `post`, `configure`, `correct`, `close`; never `provision` |

Properties that matter:

- **A request cannot enlarge its own access.** Who is calling is decided from the credentials alone.
  A request body that names an actor, a permission or another book is refused.
- **A bad credential is never treated as no credential.** A wrong, malformed, expired or revoked
  token is a 401. It does not fall back to owner access.
- **An agent cannot escalate.** Creating, listing and revoking tokens needs `provision`, which no
  token holds, so a token cannot make another token, widen itself or revoke itself. Token management
  is not offered as an MCP tool either, because a secret in a conversation is a secret leaked.
- **Some permissions have no review of their own.** `post` commits entries, and `close` finishes
  reconciliations and closes periods. The agent's runbook tells it to ask the owner first for each,
  but the token decides, not the runbook. No preset includes `close`: give it only if you want the
  agent to do those steps unreviewed.
- **The secret is shown once and stored as a hash.** A token is `rst_<id>_<secret>` with 256 random
  bits of secret. The service finds the row by the public id, compares the hash of the secret in
  constant time, and never logs, returns or stores the secret. The command line never writes it to
  its request journal, and `agent init` never writes it anywhere.
- **`rastrata connect` keeps the token so that you never handle it.** Connecting an agent with the
  one command (Settings, Agents) makes the token, or exchanges a code from a hosted workspace for
  one, and keeps it in a file only you can read, in your own configuration folder and never in the
  project: it is not shown, copied or typed. Commands run in the folder you connected from use it.
  It is a credential at rest on your computer, as the owner key file is: a program running as you
  can read it, and the agent's runbook tells it never to look. `RASTRATA_TOKEN`, when you set it,
  is used instead, and nothing is then kept on disk by the command.
- **Tokens expire** (90 days by default, a year at most) and can be revoked at once. Home asks for
  you when an agent is about to stop working, so it is not cut off in the middle of its weekly
  routine.
- **Every request made with a token is recorded**: when, which token, which operation, allowed or
  refused. You read it with `rastrata tokens activity`; what agents changed in the books is under
  **Settings**, **Changes**.
- **Every change an agent makes to the books is in one list, under its name.** The entries it
  posted, the rules it made and the keys it was given are on **Changes** (under Settings), newest
  first, with who made each and how; an agent's own account of what it did can be checked against it.
  You say "I have looked at these", and the next time only what is new is shown. An agent cannot say
  it for you. See [See what changed in your books](../how-to/see-what-changed-in-your-books.md).

## What a token does not do

On one computer, a token is a seatbelt, not a vault.

- **If the service is open** (the default for a development service), any program running as you can
  call it with no credentials and act as the owner. A token limits an agent that *uses* it; it
  cannot stop a program that ignores it. `rastrata agent status`, `rastrata agent init` and the
  Agent access screen say whether the service is open.
- **If the service is locked** (the installed service is; a development service is when
  `RASTRATA_OWNER_KEY_FILE` is set), requests without credentials are refused, and the owner key
  opens the owner's door. But the key is a file in your account, and an agent running as you can read
  it. The lock keeps a well-behaved agent that was given a token on its token; it does not defend
  against software that goes looking. The web app also acts for you with the key, so a program that
  can reach the service and pass for the app can too.
- **The real boundary arrives with hosting**, where the agent is not on your computer and cannot
  read your files. The installed service ([Install Rastrata](../how-to/install-rastrata.md)) has the
  lock **on by default**, with the web app let in by the service itself and the command line reading
  the key from your data directory; what that does and does not protect, including other accounts on a
  shared computer, is in [Your data directory and the owner
  lock](data-directory-and-owner-lock.md). Hosting will replace the key file with sign-in.

Until then: give an agent only a token, keep your own owner key out of its environment, start with
`draft` access, and read the activity list and Changes.

## Hostile text

Bank memos, merchant names, Stripe metadata, invoice text, CSV cells and file names are written by
other people, and an agent reads them. The rules for agents are the same everywhere (the runbook, the
guide, the Inbox tool descriptions): such text is *data*. An agent quotes it and never obeys it, and
never puts it into a command, a path or a query. The review gates are the second line: even an agent
that was talked into something cannot post without a person approving the exact entry, and cannot
post at all without the permission. The first line is the agent's behaviour, which is measured, not
guaranteed: see the qualification record for what has and has not been tested.

The Inbox helps by marking the text it has reason to distrust. A line whose text reads like an
instruction, starts as a spreadsheet formula, looks like markup or holds a script link carries the flag
`instruction`, `formula`, `markup` or `link` (and `control_characters` or `format_characters` for hidden
characters), on `inbox.list` and `inbox.get`, and an agent can filter by `flag` to find those lines first.
A flag is a reason for more care, never for less: a line without one is not known to be safe, and nothing
an action does depends on it.

## Graduated autonomy

1. **Read only**: explain and report.
2. **Draft**: bring money in and propose. A person posts.
3. **Post what was approved**: the agent commits plans the owner approved.
4. **Post under standing rules** is not built. Rastrata does not post on its own authority, and the
   runbook tells an agent not to either. When it is built it will be explicit (rules the owner wrote,
   limits in dollars, a report of every use) and every posting will stay reversible.

## What has been measured

The [October 1 qualification](../reference/reviews/agent-bookkeeping-qualification-2026-10-01.md)
ran Codex over MCP and over the command line on synthetic books and manual workflows. It has not yet
been run with Claude Code or opencode, nor on bank or Stripe data, and it did not cover tokens. Those
runs are later work (see [the program notes](../reference/program/agent.md)). Treat this as a
capable assistant that proposes and a person who approves.

# Connect your agent to a hosted workspace

For a person whose books are in a workspace at app.rastrata.com and who uses a coding agent such as Claude Code, Codex or opencode to do the routine bookkeeping. You choose what the agent may do, run one command where the agent works, and the agent works in your books through the `rastrata` command. You keep the right to approve everything that changes the books, and you can disconnect the agent at any time.
<!-- help: skip -->
(For books on your own computer see [Connect your agent to your books](connect-your-agent.md).)

Read [Agent access](../explanation/agent-access.md) first if you want to know what an agent's access does and does not protect you from. The short version:
<!-- help: end -->

An agent acts as **you**, with at most what your role in the workspace allows, and never with the right to connect other agents or to change who is in the workspace.

## 1. Install the command line

The `rastrata` command is a single program. Download the package for your computer from the download page on rastrata.com (`rastrata-cli-VERSION-OS-ARCH.tar.gz`, for macOS or Linux, on ARM or Intel processors; Windows is not supported yet) together with its checksum file, check the download, and install it:

```sh
shasum -a 256 -c rastrata-cli-VERSION-OS-ARCH.tar.gz.sha256     # sha256sum -c on Linux
tar -xzf rastrata-cli-VERSION-OS-ARCH.tar.gz
cd rastrata-cli-VERSION-OS-ARCH
./install.sh
```

`install.sh` checks every file against `SHA256SUMS`, puts `rastrata` in `~/.local/bin` (add that folder to your `PATH` if the installer says to), and changes nothing else: no service, no login item, nothing running in the background. Run `rastrata version` to see that it works.

## 2. Choose what the agent may do

Sign in at app.rastrata.com, open the workspace, then **Settings**, **Agents**. Under **What may it do?** choose one:

- **Prepare, for my approval** (the usual start): the agent reads, brings transactions in and drafts. Nothing is posted until you accept it.
- **Read only**: the agent reads and explains.
- **Run the books**: the agent also posts. You reconcile and close.

None of the three lets an agent finish a reconciliation or close a month. You are offered only what your own role holds: a member is offered the first two.

## 3. Run the one command

Press **Get the command**. The page shows a command with a code in it:

```sh
rastrata connect R7K2-9QDM-4XHT
```

Copy it and run it in the folder the agent works in (your project folder). The code works once, for ten minutes; it is not a credential, and pressing the button again makes a new one and ends the one before. Getting a code asks for a sign-in from the last few minutes, because what it connects outlasts your session; if yours is older the page says so, and brings you back to the command when you have signed in again.

The command does four things and says one line:

```
Connected to Larimer Studio. This agent can read and draft until February 15, 2027.
```

1. It exchanges the code for the agent's access, which is made for you with what you chose. The access never appears on a screen, in your clipboard or in your shell's history.
2. It keeps that access in a file that only you can read, in your own configuration folder (`~/Library/Application Support/rastrata/connections.json` on macOS, `~/.config/rastrata/connections.json` on Linux), and never in the project.
3. It checks that the workspace accepts it.
4. It writes the instructions the agent follows into the folder, for Claude Code (`.claude/skills/rastrata/`) and for Codex and opencode (a section of `AGENTS.md`): the weekly bookkeeping, and the rules that never bend (nothing is posted until you have seen the exact effects and approved them). It never writes a secret, and it never overwrites a file it did not write. `--agent claude` (or `codex`, `opencode`, `none`) writes for one agent or none.

From then on every `rastrata` command run in that folder, or under it, works with nothing set: it knows where your books are and who it is. Back on the Agents page, the agent appears under **Connected** by itself, named for the computer it runs on (`--name "Claude Code on my laptop"` gives it another name).

## 4. Ask the agent

The page says what to ask, for the choice you made. For an agent that prepares:

> Review this week's transactions and show me what you would post.

## What to expect

- The address you signed in with is told by email that an agent was connected, with what it can do and until when.
- An agent's access lasts 90 days. Home tells you two weeks before one stops, and the Agents page says the day; connect it again with a new code.
- Each command the agent runs asks Rastrata for a short-lived token (five minutes) in exchange for the access the command keeps; you do not see this.
- The command talks only to your own computer and to rastrata.com, and sends an agent's access only to the address it was made for.
- A person with the **Owner** role sees what agents changed under **Settings**, **Changes** (the Agents page links to it), by each agent's name.
- If you are taken out of the workspace, or your role is lowered, your agents stop or lose permissions with it.
- A hosted workspace keeps the history of your books itself, so there is no backup for you or the agent to make. To keep a copy of your own, an owner can export the books (**Settings**, **Business**, **Export or delete this workspace**, **Export your books**).
- The first request after a long time can take a few seconds while your books are read.

## Working across more than one business

If you own or work in more than one workspace, connect each one with `rastrata connect <CODE> --alias <short-name>` so one machine can hold separate scoped keys for each business.

```sh
rastrata workspaces                                # list every connected workspace and its alias
rastrata --workspace acme-llc reports pnl          # target one business explicitly
RASTRATA_WORKSPACE=acme-llc rastrata inbox list    # or set it for a shell session
rastrata disconnect acme-llc                       # remove a saved local connection
```

Each connection is bound to one workspace and one set of permissions. When more than one workspace is connected and none is pinned in the current folder, `rastrata` refuses to guess and asks you to pass `--workspace` or set `RASTRATA_WORKSPACE`.

## Disconnect an agent

**Settings**, **Agents**, then **Disconnect** beside the agent. It stops working within a few minutes (new commands at once), and what it did stays in the books. Disconnecting cannot be undone; connect the agent again with a new code if it should work again.

## If you would rather set a variable

A secrets manager, or a job that runs somewhere with no folder of its own, can give the agent its access in the environment instead: `RASTRATA_TOKEN`, with `RASTRATA_API_URL=https://app.rastrata.com`. When `RASTRATA_TOKEN` is set the command uses it and ignores what `rastrata connect` kept. `rastrata agent status` says who the agent is, what it may do, when its access ends and where it came from (`"credential": "connection"` or `"token"`).

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `This code was already used.` | A code works once. | Press **Get the command** again and run the new command. |
| `This code has expired: a code works for ten minutes.` | The code was older than ten minutes. | The same. |
| `The code was not accepted.` | The code was mistyped, or is not from this workspace. | Copy the command from the page with **Copy**. |
| `There are 20 agents connected for you in this workspace.` | A person may hold twenty at once. | Disconnect one on the Agents page first. |
| `the connections file ... must be private to you (chmod 600)` | The file that keeps the agent's access can be read by others on this computer. | `chmod 600` the file it names, then run the command again. The code was not used. |
| A command later says `token_revoked` or `token_expired` | The agent was disconnected, or its 90 days ran out. | Connect it again with a new code. |

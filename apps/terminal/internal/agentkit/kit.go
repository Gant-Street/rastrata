// Package agentkit writes the runbook and the guide into a project for the agents people already
// use (Claude Code, Codex, opencode). Everything it writes comes from two embedded texts that are
// generated from one source in this repository (plugins/rastrata/skills/bookkeeping/SKILL.md,
// by scripts/agent-kit.ts), so the CLI, the MCP server and the files in a project never disagree.
//
// It never writes a secret. Tokens are named by environment variable, never by value.
package agentkit

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"strings"
)

//go:embed kit/runbook.md
var runbook string

//go:embed kit/guide.md
var guide string

// Runbook is the weekly routine and the rules an agent follows, as markdown.
func Runbook() string { return runbook }

// Guide is the full bookkeeping guide for this version of Rastrata, as markdown, including the
// table that pairs every MCP tool with its operation.
func Guide() string { return guide }

// GuideDigest names the guide text exactly as `rastrata agent guide` prints it.
func GuideDigest() string {
	sum := sha256.Sum256([]byte(guide))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// KitDigest is a short name for this version of the kit, written into the files it creates so a
// later run can tell what it is replacing.
func KitDigest() string {
	sum := sha256.Sum256([]byte(runbook + "\x00" + guide))
	return hex.EncodeToString(sum[:])[:12]
}

const (
	// TokenVariable is the environment variable every agent reads its token from.
	TokenVariable = "RASTRATA_TOKEN"
	// DefaultMCPURL is where the local MCP server listens.
	DefaultMCPURL = "http://127.0.0.1:4020/mcp"
	// ServerName is the name of the MCP server entry in every agent's configuration.
	ServerName = "rastrata"
)

// Agent is a coding agent the kit knows how to set up.
type Agent string

const (
	Claude   Agent = "claude"
	Codex    Agent = "codex"
	OpenCode Agent = "opencode"
)

// Agents lists the supported agents in the order they are set up.
var Agents = []Agent{Claude, Codex, OpenCode}

// skillDescription is what Claude Code reads to decide when to use the skill. It is a single
// quoted YAML line.
const skillDescription = "Run a business's books with Rastrata through its command line. Bring in bank and Stripe lines, let rules categorize them, queue exceptions for the owner, reconcile accounts and propose the month-end close, always behind review gates. Use when the user asks about their books, bank or Stripe lines, reconciliation, financial reports or closing a month."

// connection is the part of every file that says how the agent reaches Rastrata, in terms of the
// environment variable only.
func connection() string {
	return strings.Join([]string{
		"### Connection",
		"",
		"- The `rastrata` command has your access already: the owner ran `rastrata connect` in this folder, which keeps your token outside the project, or set it in the environment variable `" + TokenVariable + "`. Do not look for the token, write it into any file in this project, or print it.",
		"- If a command says credentials are required, ask the owner to run `rastrata connect` here with a code from their workspace's agent settings. On a service that is open, commands with no token act as its owner: ask the owner for a token before doing anything beyond reading.",
		"- A hosted workspace is at https://app.rastrata.com. The command exchanges your token for a short-lived one and sends it to that address only.",
		"- `rastrata agent status` shows who you are, what you may do and when your token expires. `rastrata agent guide` prints the full bookkeeping guide for this version of Rastrata.",
		"- The command keeps the exact bytes of every write in a request journal, so an interrupted write can be resumed with the same identity. By default that folder is in your account's cache, which a sandbox may not let you write to: then a write fails with `request_journal_unwritable` and sends nothing. Set `RASTRATA_REQUEST_DIR` to a folder in this project (for example `.rastrata/requests`), run the same command again, and tell the owner you did.",
		"",
	}, "\n")
}

// ClaudeSkill is .claude/skills/rastrata/SKILL.md: frontmatter, then the runbook.
func ClaudeSkill() string {
	return "---\nname: rastrata\ndescription: " + `"` + skillDescription + `"` + "\n---\n\n" +
		runbook + "\n" + connection() +
		"\nThe full guide is in `guide.md` next to this file.\n"
}

// ClaudeGuide is .claude/skills/rastrata/guide.md.
func ClaudeGuide() string { return guide }

// AgentsSection is the text between the markers in AGENTS.md (Codex and opencode).
func AgentsSection() string {
	return runbook + "\n" + connection() + "\nThe full guide: run `rastrata agent guide`.\n"
}

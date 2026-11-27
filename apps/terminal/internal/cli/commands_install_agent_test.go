package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
)

// The installed package has no MCP server, so the installed command line does not point an agent's
// project at one unless asked, and what it tells a person to run is the installed commands.

func TestInstalledAgentInitWritesNoMCPEntryUnlessAsked(t *testing.T) {
	w := newInstallWorld(t)
	entry := func(dir string) bool {
		_, err := os.Stat(filepath.Join(dir, ".mcp.json"))
		return err == nil
	}

	development := t.TempDir()
	if run := runAgent(t, w.server.URL, "agent", "init", "--agent", "claude", "--dir", development); run.exit != 0 || !entry(development) {
		t.Fatalf("a development build writes the MCP entry by default: exit %d, %s", run.exit, run.diagnostics)
	}

	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	installed := t.TempDir()
	if run := runAgent(t, w.server.URL, "agent", "init", "--agent", "claude", "--dir", installed); run.exit != 0 {
		t.Fatalf("exit %d: %s", run.exit, run.diagnostics)
	}
	if entry(installed) {
		t.Fatal("the installed build has no MCP server: it must not write an entry for one")
	}
	if _, err := os.Stat(filepath.Join(installed, ".claude")); err != nil {
		t.Fatalf("the runbook and the skill are still written: %v", err)
	}
	asked := t.TempDir()
	if run := runAgent(t, w.server.URL, "agent", "init", "--agent", "claude", "--dir", asked, "--mcp=true"); run.exit != 0 || !entry(asked) {
		t.Fatalf("--mcp=true writes it: exit %d, %s", run.exit, run.diagnostics)
	}
}

func TestAgentInitNamesTheRightCommandToStartTheService(t *testing.T) {
	w := newInstallWorld(t)
	down := w.server.URL
	w.server.Close()
	dir := t.TempDir()

	run := runAgent(t, down, "agent", "init", "--agent", "claude", "--dir", dir, "--mcp=false")
	if !strings.Contains(run.out, "bun run dev:api") {
		t.Fatalf("a development build names the development service: %s", run.out)
	}
	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	run = runAgent(t, down, "agent", "init", "--agent", "codex", "--dir", dir, "--mcp=false", "--force")
	if !strings.Contains(run.out, "rastrata start") || strings.Contains(run.out, "bun run dev:api") {
		t.Fatalf("the installed build names rastrata start: %s", run.out)
	}
}

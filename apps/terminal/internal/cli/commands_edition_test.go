package cli

import (
	"bytes"
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
)

// The command line on its own is the package for a person whose books are in a hosted workspace: the program that the package script
// stamps with Edition=cli. It has no service, data directory or owner key on the computer, so it goes to the hosted service unless it
// is told otherwise, answers the commands that look after a local service with one plain sentence, and does not list them.

// commandLineOnly makes this process the command line on its own for one test.
func commandLineOnly(t *testing.T) {
	t.Helper()
	unavailable := api.ServiceUnavailable
	buildinfo.Channel, buildinfo.Edition = "installed", "cli"
	configureForBuild()
	t.Cleanup(func() {
		buildinfo.Channel, buildinfo.Edition = "development", "whole"
		api.ServiceUnavailable = unavailable
	})
}

// localCommands are the commands that look after a service, or books, on this computer.
var localCommands = []string{
	"backup folder", "doctor", "export verify", "import-export", "install", "logs", "open", "restore", "start", "status", "stop", "uninstall", "update",
}

func TestTheCommandsForALocalServiceAreTheOnesMarkedLocal(t *testing.T) {
	var marked []string
	for name, command := range commands {
		if command.Local {
			marked = append(marked, name)
		}
	}
	sort.Strings(marked)
	if strings.Join(marked, ",") != strings.Join(localCommands, ",") {
		t.Fatalf("a command that needs a service on this computer must say so (Local: true), and the command line on its own answers each of them:\n  marked %v\n  listed %v", marked, localCommands)
	}
}

func TestTheCommandLineOnlyGoesToTheHostedServiceUnlessToldOtherwise(t *testing.T) {
	commandLineOnly(t)
	t.Setenv("RASTRATA_API_URL", "")
	if got := defaultEndpoint(); got != "https://app.rastrata.com" {
		t.Fatalf("the default is the hosted service: %s", got)
	}
	if got := defaults().Endpoint; got != "https://app.rastrata.com" {
		t.Fatalf("with no RASTRATA_API_URL the endpoint is the hosted service: %s", got)
	}
	t.Setenv("RASTRATA_API_URL", "http://127.0.0.1:4010")
	if got := defaults().Endpoint; got != "http://127.0.0.1:4010" {
		t.Fatalf("RASTRATA_API_URL still wins: %s", got)
	}
	// Its credentials are an agent's token: there is no owner key of a service on this computer to find.
	none := func(string) string { return "" }
	if credential, err := api.CredentialFromEnvironment(none); err != nil || credential != "" {
		t.Fatalf("no owner key is looked for: %q %v", credential, err)
	}
}

func TestTheCommandLineOnlyAnswersTheCommandsOfALocalServiceInOneSentence(t *testing.T) {
	commandLineOnly(t)
	for _, name := range localCommands {
		var out, diagnostics bytes.Buffer
		exit := Runner{Output: &out, Diagnostics: &diagnostics}.Run(context.Background(), strings.Fields(name))
		_, _, code := envelope(t, out.String())
		if exit != 2 || code != "not_in_this_package" {
			t.Errorf("%s: exit %d, code %q: %s", name, exit, code, out.String())
		}
		said := diagnostics.String()
		if !strings.Contains(said, "rastrata "+name+" is not part of the command line on its own") || !strings.Contains(said, "https://app.rastrata.com/") || !strings.Contains(said, "rastrata agent status") {
			t.Errorf("%s does not say what this is, where the books are and what to run instead: %q", name, said)
		}
		for _, wrong := range []string{"Run rastrata", "run rastrata", "bun run", "install.sh", "data directory"} {
			if strings.Contains(said, wrong) {
				t.Errorf("%s sends a person to something this package does not have (%q): %q", name, wrong, said)
			}
		}
	}
}

func TestTheCommandLineOnlyHelpIsAboutAHostedWorkspace(t *testing.T) {
	commandLineOnly(t)
	var out, diagnostics bytes.Buffer
	if exit := (Runner{Output: &out, Diagnostics: &diagnostics}).Run(context.Background(), []string{"help"}); exit != 0 {
		t.Fatalf("help: %d", exit)
	}
	help := out.String()
	for _, name := range localCommands {
		if strings.Contains(help, "\n  "+name+" ") {
			t.Errorf("help lists %q, which this package does not have", name)
		}
	}
	for _, want := range []string{"\n  agent init ", "\n  agent status ", "(default https://app.rastrata.com)", "your books are in your workspace at https://app.rastrata.com/", "run 'connect CODE' in the folder it works in", "\n  connect ", "Connection: https://app.rastrata.com"} {
		if !strings.Contains(help, want) {
			t.Errorf("help does not say %q", want)
		}
	}
	for _, wrong := range []string{"Start the Bun service", "login service", "owner of an open service", "RASTRATA_OWNER_KEY_FILE", "127.0.0.1:4010"} {
		if strings.Contains(help, wrong) {
			t.Errorf("help talks about a local service (%q)", wrong)
		}
	}
}

func TestTheCommandLineOnlyDoesNotSendAPersonToStartAService(t *testing.T) {
	commandLineOnly(t)
	if strings.Contains(api.ServiceUnavailable, "rastrata start") || strings.Contains(api.ServiceUnavailable, "rastrata status") || !strings.Contains(api.ServiceUnavailable, "RASTRATA_API_URL") {
		t.Fatalf("a connection that failed: %q", api.ServiceUnavailable)
	}
	run := runAgent(t, "http://127.0.0.1:1", "agent", "status")
	if run.exit != 4 {
		t.Fatalf("a workspace that does not answer should exit 4: %d %s", run.exit, run.out)
	}
	if !strings.Contains(run.out, "did not answer") || strings.Contains(run.out, "start it with") || strings.Contains(run.out, "bun run") {
		t.Fatalf("the note for a workspace that does not answer: %s", run.out)
	}
}

func TestTheWholePackageStillHasItsServiceCommands(t *testing.T) {
	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	var out, diagnostics bytes.Buffer
	if exit := (Runner{Output: &out, Diagnostics: &diagnostics}).Run(context.Background(), []string{"help"}); exit != 0 {
		t.Fatalf("help: %d", exit)
	}
	for _, name := range localCommands {
		if !strings.Contains(out.String(), "\n  "+name+" ") {
			t.Errorf("the package with the service must list %q", name)
		}
	}
	if strings.Contains(out.String(), "not part of the command line on its own") {
		t.Error("the package with the service is not the command line on its own")
	}
}

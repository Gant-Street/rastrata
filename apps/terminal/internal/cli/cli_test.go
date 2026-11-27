package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestHeadlessMissingInputsFailWithoutPrompt(t *testing.T) {
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	exit := runner.Run(context.Background(), []string{"drafts", "create", "--request-dir", t.TempDir(), "--json"})
	if exit != 2 || !json.Valid(out.Bytes()) || strings.Contains(out.String(), "\x1b") {
		t.Fatalf("bad headless failure: %d %s", exit, out.String())
	}
	if strings.Contains(strings.ToLower(diagnostics.String()), "enter ") {
		t.Fatal("headless command prompted")
	}
}
func TestOfflineSchemaContainsExactTypesAndCatalog(t *testing.T) {
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	if runner.Run(context.Background(), []string{"schema", "journal.prepare"}) != 0 || !json.Valid(out.Bytes()) {
		t.Fatal("schema unavailable offline")
	}
	if !strings.Contains(out.String(), "expectedVersion") || !strings.Contains(out.String(), "PreparedOperation") {
		t.Fatal("schema lacks follow-up information")
	}
}
func TestPipedMalformedInputDoesNotOpenTUI(t *testing.T) {
	called := false
	var out bytes.Buffer
	runner := Runner{Input: strings.NewReader(`{"data":`), Output: &out, Diagnostics: io.Discard, TUI: nil}
	exit := runner.Run(context.Background(), []string{"drafts", "create", "--input", "-"})
	if exit != 2 || called {
		t.Fatal("unexpected interactive fallback")
	}
}

// An agent that asks for one command's options must get that command's, not the manual (which is
// several hundred lines): the first baseline runs spent turns on `inbox list --help` printing it all.
func TestAskingAboutOneCommandPrintsThatCommandAndNotTheManual(t *testing.T) {
	for _, test := range []struct {
		args []string
		want []string
	}{
		{[]string{"inbox", "list", "--help"}, []string{"rastrata inbox list", "[--covered=false]", "--page-size=N"}},
		{[]string{"help", "inbox", "accept"}, []string{"rastrata inbox accept", "--proposer=NAME"}},
		{[]string{"import", "-h"}, []string{"rastrata import", "--dry-run=true"}},
		{[]string{"call", "inbox.list", "--help"}, []string{"rastrata call inbox.list", "rastrata schema inbox.list"}},
		{[]string{"inbox", "summary", "--help"}, []string{"runs the operation inbox.summary", "rastrata schema inbox.summary"}},
	} {
		var out bytes.Buffer
		runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: io.Discard}
		if exit := runner.Run(context.Background(), test.args); exit != 0 {
			t.Fatalf("%v: exit %d", test.args, exit)
		}
		for _, want := range test.want {
			if !strings.Contains(out.String(), want) {
				t.Errorf("%v does not say %q:\n%s", test.args, want, out.String())
			}
		}
		if strings.Contains(out.String(), "Application operations") || strings.Count(out.String(), "\n") > 12 {
			t.Errorf("%v printed the manual:\n%s", test.args, out.String())
		}
	}
	// With nothing named, or something unknown, the manual is what there is to print.
	for _, args := range [][]string{{"--help"}, {"help"}, {"no", "such", "command", "--help"}} {
		var out bytes.Buffer
		runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: io.Discard}
		if exit := runner.Run(context.Background(), args); exit != 0 || !strings.Contains(out.String(), "Application operations") {
			t.Errorf("%v: exit %d, and the manual was not printed", args, exit)
		}
	}
}

func TestAnUnknownCommandInAGroupNamesTheGroupsCommands(t *testing.T) {
	var out bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: io.Discard}
	exit := runner.Run(context.Background(), []string{"inbox", "get", "it_1", "--request-dir", t.TempDir()})
	if exit != 2 || !json.Valid(out.Bytes()) {
		t.Fatalf("exit %d: %s", exit, out.String())
	}
	for _, want := range []string{"Unknown command or missing arguments; run rastrata help", "The inbox commands are:", "show", "accept", "post", "summary", "rastrata inbox "} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the message lacks %q: %s", want, out.String())
		}
	}
	// A word that is no group gets the plain message and no list.
	out.Reset()
	if exit := runner.Run(context.Background(), []string{"frobnicate", "--request-dir", t.TempDir()}); exit != 2 || strings.Contains(out.String(), "commands are:") {
		t.Errorf("exit %d: %s", exit, out.String())
	}
}

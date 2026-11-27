package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/agentkit"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// service answers book.get like the application: for a token, for the owner of an open service, or
// with a refusal. It records the Authorization header it saw.
type service struct {
	principal   string // "owner", "token", or "" for a refusal
	code        string // the refusal's code
	ownerAccess string
	expiresAt   string
	seen        *string
}

func (s service) start(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.seen != nil {
			*s.seen = r.Header.Get("Authorization")
		}
		envelope := map[string]any{"version": api.Version, "bookId": "local-book"}
		if s.principal == "" {
			w.WriteHeader(401)
			envelope["ok"] = false
			envelope["error"] = map[string]any{"code": s.code, "message": "Refused.", "details": []any{}, "retryable": false}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		principal := map[string]any{"kind": s.principal}
		if s.principal == "token" {
			principal = map[string]any{"kind": "token", "tokenId": "0123456789abcdef", "label": "Claude Code", "expiresAt": s.expiresAt}
		}
		envelope["ok"] = true
		envelope["data"] = map[string]any{
			"enabled": true, "bookId": "local-book", "setup": nil, "mode": "local-development",
			"permissions": []string{"read", "draft"}, "head": nil, "principal": principal, "ownerAccess": s.ownerAccess,
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

type agentRun struct {
	exit        int
	out         string
	diagnostics string
}

func runAgent(t *testing.T, endpoint string, args ...string) agentRun {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	full := append(args, "--endpoint", endpoint, "--request-dir", t.TempDir())
	return agentRun{runner.Run(context.Background(), full), out.String(), diagnostics.String()}
}

type initOutput struct {
	Data struct {
		Files []struct {
			Path   string `json:"path"`
			Action string `json:"action"`
		} `json:"files"`
		Snippets []struct {
			Agent string `json:"agent"`
			Text  string `json:"text"`
		} `json:"snippets"`
		Notes   []string `json:"notes"`
		Service struct {
			Reachable     bool     `json:"reachable"`
			Authenticated bool     `json:"authenticated"`
			Credential    string   `json:"credential"`
			Principal     string   `json:"principal"`
			Permissions   []string `json:"permissions"`
			OwnerAccess   string   `json:"ownerAccess"`
			ErrorCode     string   `json:"errorCode"`
			Notes         []string `json:"notes"`
		} `json:"service"`
	} `json:"data"`
}

func decodeInit(t *testing.T, out string) initOutput {
	t.Helper()
	var result initOutput
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("not JSON: %v\n%.300s", err, out)
	}
	return result
}

func joined(notes []string) string { return strings.Join(notes, "\n") }

func TestAgentInitWritesTheKitAndSaysThatAnOpenServiceIsOpen(t *testing.T) {
	endpoint := service{principal: "owner", ownerAccess: "open"}.start(t)
	dir := t.TempDir()
	run := runAgent(t, endpoint, "agent", "init", "--agent", "claude", "--dir", dir)
	result := decodeInit(t, run.out)
	if run.exit != 0 || len(result.Data.Files) != 3 {
		t.Fatalf("exit %d: %s", run.exit, run.out)
	}
	for _, file := range result.Data.Files {
		if file.Action != "created" {
			t.Errorf("%s: %s", file.Path, file.Action)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".claude", "skills", "rastrata", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	service := result.Data.Service
	if !service.Reachable || !service.Authenticated || service.Principal != "owner" || service.OwnerAccess != "open" {
		t.Fatalf("service: %+v", service)
	}
	notes := joined(service.Notes)
	if !strings.Contains(notes, "Owner access is OPEN") || !strings.Contains(notes, "ignores it") || !strings.Contains(notes, "no token is set") {
		t.Fatalf("an open service must be said out loud:\n%s", notes)
	}
	// A second run changes nothing, and still succeeds.
	again := runAgent(t, endpoint, "agent", "init", "--agent", "claude", "--dir", dir)
	for _, file := range decodeInit(t, again.out).Data.Files {
		if file.Action != "unchanged" {
			t.Errorf("a second run changed %s", file.Path)
		}
	}
}

func TestAgentInitWithATokenReportsItsGrantAndNeverWritesIt(t *testing.T) {
	const secret = "rst_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	t.Setenv(api.TokenVariable, secret)
	var header string
	soon := time.Now().Add(5 * 24 * time.Hour).UTC().Format(time.RFC3339)
	endpoint := service{principal: "token", ownerAccess: "key", expiresAt: soon, seen: &header}.start(t)
	dir := t.TempDir()
	run := runAgent(t, endpoint, "agent", "init", "--agent", "all", "--dir", dir)
	result := decodeInit(t, run.out)
	if run.exit != 0 || header != "Bearer "+secret {
		t.Fatalf("exit %d, header %q", run.exit, header)
	}
	if strings.Contains(run.out, secret) || strings.Contains(run.diagnostics, secret) {
		t.Fatal("the token appeared in the output")
	}
	service := result.Data.Service
	if service.Principal != "token" || service.Credential != "token" || strings.Join(service.Permissions, ",") != "read,draft" || service.OwnerAccess != "key" {
		t.Fatalf("service: %+v", service)
	}
	notes := joined(service.Notes)
	if !strings.Contains(notes, "grants: read, draft") || !strings.Contains(notes, "expires within 14 days") || strings.Contains(notes, "OPEN") {
		t.Fatalf("notes:\n%s", notes)
	}
	filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if data, _ := os.ReadFile(path); strings.Contains(string(data), secret) {
				t.Errorf("%s holds the token", path)
			}
		}
		return nil
	})
	if len(result.Data.Snippets) != 1 || result.Data.Snippets[0].Agent != "codex" {
		t.Fatalf("snippets: %+v", result.Data.Snippets)
	}
}

func TestAgentInitSaysWhenTheServiceIsLockedOrNotThere(t *testing.T) {
	locked := runAgent(t, service{code: "authentication_required"}.start(t), "agent", "init", "--agent", "codex", "--dir", t.TempDir())
	result := decodeInit(t, locked.out)
	if locked.exit != 0 || !result.Data.Service.Reachable || result.Data.Service.Authenticated || result.Data.Service.OwnerAccess != "key" || !strings.Contains(joined(result.Data.Service.Notes), "requires credentials") {
		t.Fatalf("locked: exit %d %s", locked.exit, locked.out)
	}
	revoked := runAgent(t, service{code: "token_revoked"}.start(t), "agent", "init", "--agent", "codex", "--dir", t.TempDir())
	if !strings.Contains(joined(decodeInit(t, revoked.out).Data.Service.Notes), "token_revoked") {
		t.Fatalf("revoked: %s", revoked.out)
	}
	down := runAgent(t, "http://127.0.0.1:1", "agent", "init", "--agent", "codex", "--dir", t.TempDir())
	result = decodeInit(t, down.out)
	if down.exit != 0 || result.Data.Service.Reachable || !strings.Contains(joined(result.Data.Service.Notes), "not reachable") {
		t.Fatalf("down: exit %d %s", down.exit, down.out)
	}
}

func TestAgentInitExitsWithConflictWhenAFileHadToBeSkipped(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte("{ // mine\n}"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := runAgent(t, "http://127.0.0.1:1", "agent", "init", "--agent", "opencode", "--dir", dir)
	if run.exit != 3 || !strings.Contains(run.diagnostics, "Skipped opencode.json") {
		t.Fatalf("exit %d diagnostics %s", run.exit, run.diagnostics)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "opencode.json")); string(data) != "{ // mine\n}" {
		t.Fatal("their file changed")
	}
}

func TestAgentInitRefusesBadOptionsBeforeWritingAnything(t *testing.T) {
	dir := t.TempDir()
	secret := "rst_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	for name, args := range map[string][]string{
		"no agent":                {"agent", "init", "--dir", dir},
		"an unknown agent":        {"agent", "init", "--agent", "emacs", "--dir", dir},
		"one bad among several":   {"agent", "init", "--agent", "claude,emacs", "--dir", dir},
		"a missing folder":        {"agent", "init", "--agent", "claude", "--dir", filepath.Join(dir, "missing")},
		"a credential as a value": {"agent", "init", "--agent", "claude", "--dir", dir, "--mcp-url", secret},
		"an outside MCP address":  {"agent", "init", "--agent", "claude", "--dir", dir, "--mcp-url", "https://example.com/mcp"},
		"a bad boolean":           {"agent", "init", "--agent", "claude", "--dir", dir, "--mcp=maybe"},
		"an unknown option":       {"agent", "init", "--agent", "claude", "--dir", dir, "--token", "x"},
		"a stray argument":        {"agent", "init", "claude", "--dir", dir},
	} {
		run := runAgent(t, "http://127.0.0.1:1", args...)
		if run.exit != 2 || !json.Valid([]byte(run.out)) {
			t.Errorf("%s: exit %d out %s", name, run.exit, run.out)
		}
		if strings.Contains(run.out+run.diagnostics, secret) {
			t.Errorf("%s: echoed the credential", name)
		}
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("%d entries were written", len(entries))
	}
}

func TestAgentGuidePrintsMarkdownByDefaultAndAnEnvelopeOnRequest(t *testing.T) {
	run := runAgent(t, "http://127.0.0.1:1", "agent", "guide")
	if run.exit != 0 || !strings.HasPrefix(run.out, "> This guide is shared") || !strings.Contains(run.out, "## Tools and operations") || json.Valid([]byte(run.out)) {
		t.Fatalf("exit %d: %.160s", run.exit, run.out)
	}
	if run.out != agentkit.Guide() {
		t.Fatal("the guide should print exactly as embedded")
	}
	enveloped := runAgent(t, "http://127.0.0.1:1", "agent", "guide", "--format", "json")
	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			URI    string `json:"uri"`
			Digest string `json:"digest"`
			Text   string `json:"text"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(enveloped.out), &envelope); err != nil || !envelope.OK || envelope.Data.Digest != agentkit.GuideDigest() || envelope.Data.Text != agentkit.Guide() {
		t.Fatalf("envelope: %v %.200s", err, enveloped.out)
	}
	if runAgent(t, "http://127.0.0.1:1", "agent", "guide", "extra").exit != 2 {
		t.Fatal("guide takes no arguments")
	}
}

func TestAgentStatusSaysWhoYouAreAndExitsByWhatItFinds(t *testing.T) {
	endpoint := service{principal: "owner", ownerAccess: "open"}.start(t)
	run := runAgent(t, endpoint, "agent", "status")
	var status struct {
		Data struct {
			Principal   string `json:"principal"`
			OwnerAccess string `json:"ownerAccess"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(run.out), &status); err != nil || run.exit != 0 || status.Data.Principal != "owner" || status.Data.OwnerAccess != "open" {
		t.Fatalf("exit %d: %s", run.exit, run.out)
	}
	if run := runAgent(t, service{code: "token_expired"}.start(t), "agent", "status"); run.exit != 3 || !strings.Contains(run.out, "token_expired") {
		t.Fatalf("a refused credential should exit 3: %d %s", run.exit, run.out)
	}
	if run := runAgent(t, "http://127.0.0.1:1", "agent", "status"); run.exit != 4 {
		t.Fatalf("an unreachable service should exit 4: %d %s", run.exit, run.out)
	}
	if run := runAgent(t, endpoint, "agent", "status", "now"); run.exit != 2 {
		t.Fatalf("status takes no arguments: %d", run.exit)
	}
}

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/agentkit"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const (
	agentSecret   = "rst_fedcba9876543210_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"
	agentIdentity = "fedcba9876543210"
)

const tokenJSON = `{"id":"fedcba9876543210","prefix":"rst_fedcba9876543210","label":"Agent","permissions":["read","draft"],"status":"active","createdAt":"2026-10-04T00:00:00.000Z","createdBy":"owner","expiresAt":"2027-01-02T00:00:00.000Z","revokedAt":null,"revokedReason":null,"lastUsedAt":null}`

type tokenRequest struct {
	Path          string
	Authorization string
	OperationID   string
	Input         map[string]any
}

// tokensServer answers the token operations like the service and records what the CLI sent.
func tokensServer(t *testing.T, sent *[]tokenRequest, status int, code string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		var input map[string]any
		_ = json.Unmarshal(request.Input, &input)
		*sent = append(*sent, tokenRequest{Path: r.URL.Path, Authorization: r.Header.Get("Authorization"), OperationID: request.OperationID, Input: input})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book"}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		if status >= 400 {
			w.WriteHeader(status)
			envelope["ok"] = false
			envelope["error"] = map[string]any{"code": code, "message": "Not allowed.", "details": []any{}, "retryable": false}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		envelope["ok"] = true
		switch r.URL.Path {
		case "/v1/tokens.create":
			envelope["data"] = json.RawMessage(`{"token":` + tokenJSON + `,"secret":"` + agentSecret + `"}`)
		case "/v1/tokens.list":
			envelope["data"] = json.RawMessage(`{"tokens":[` + tokenJSON + `],"grantable":["read","draft","post","configure","correct","close"],"defaultExpiryDays":90,"maxExpiryDays":365,"ownerAccess":"open"}`)
		case "/v1/tokens.revoke":
			envelope["data"] = json.RawMessage(strings.Replace(tokenJSON, `"status":"active"`, `"status":"revoked"`, 1))
		case "/v1/tokens.activity":
			envelope["data"] = json.RawMessage(`{"count":0,"page":1,"pageSize":25,"events":[]}`)
		default:
			w.WriteHeader(404)
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runTokens(t *testing.T, endpoint string, args ...string) (int, string, string, string) {
	t.Helper()
	directory := t.TempDir()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	full := append(args, "--endpoint", endpoint, "--request-dir", directory)
	exit := runner.Run(context.Background(), full)
	return exit, out.String(), diagnostics.String(), directory
}

func TestTokensCreateSendsTheChosenAccessAndShowsTheSecretOnceOnlyOnStdout(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 200, "")
	exit, out, diagnostics, journal := runTokens(t, endpoint, "tokens", "create", "--label", "Claude Code", "--preset", "bookkeeper", "--expires-in-days", "30")
	if exit != 0 || len(sent) != 1 {
		t.Fatalf("exit %d, sent %d, out %s, diagnostics %s", exit, len(sent), out, diagnostics)
	}
	if sent[0].Path != "/v1/tokens.create" || sent[0].OperationID == "" {
		t.Fatalf("request: %+v", sent[0])
	}
	permissions, _ := json.Marshal(sent[0].Input["permissions"])
	if sent[0].Input["label"] != "Claude Code" || string(permissions) != `["read","draft","post"]` || sent[0].Input["expiresInDays"] != float64(30) {
		t.Fatalf("input: %+v", sent[0].Input)
	}
	if strings.Count(out, agentSecret) != 1 {
		t.Fatalf("the secret must be on stdout exactly once:\n%s", out)
	}
	if strings.Contains(diagnostics, agentSecret) || !strings.Contains(diagnostics, "shown once") {
		t.Fatalf("diagnostics must explain it and must not repeat it:\n%s", diagnostics)
	}
	entries, _ := os.ReadDir(journal)
	for _, entry := range entries {
		data, _ := os.ReadFile(filepath.Join(journal, entry.Name()))
		if strings.Contains(string(data), agentSecret) {
			t.Fatalf("%s holds the secret", entry.Name())
		}
	}
	if len(entries) != 1 {
		t.Fatalf("only the request should be retained: %d files", len(entries))
	}
}

func TestTokensCreateDefaultsToReadAndDraftAndSaysSo(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 200, "")
	exit, _, diagnostics, _ := runTokens(t, endpoint, "tokens", "create", "--label", "Agent")
	permissions, _ := json.Marshal(sent[0].Input["permissions"])
	if exit != 0 || string(permissions) != `["read","draft"]` || !strings.Contains(diagnostics, "default for an agent") {
		t.Fatalf("exit %d permissions %s diagnostics %s", exit, permissions, diagnostics)
	}
	if _, has := sent[0].Input["expiresInDays"]; has {
		t.Fatal("the service chooses the default expiry")
	}
	exit, _, _, _ = runTokens(t, endpoint, "tokens", "create", "--label", "Agent", "--permissions", "read, draft ,post,close")
	permissions, _ = json.Marshal(sent[1].Input["permissions"])
	if exit != 0 || string(permissions) != `["read","draft","post","close"]` {
		t.Fatalf("permissions %s", permissions)
	}
}

func TestTokensCreateRefusesBadInputBeforeAnyRequest(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 200, "")
	for name, args := range map[string][]string{
		"no label":                     {"tokens", "create"},
		"a bare label":                 {"tokens", "create", "--label"},
		"a credential as the label":    {"tokens", "create", "--label", agentSecret},
		"preset and permissions":       {"tokens", "create", "--label", "A", "--preset", "draft", "--permissions", "read"},
		"an unknown preset":            {"tokens", "create", "--label", "A", "--preset", "admin"},
		"expiry not a number":          {"tokens", "create", "--label", "A", "--expires-in-days", "soon"},
		"expiry beyond a year":         {"tokens", "create", "--label", "A", "--expires-in-days", "366"},
		"expiry of zero":               {"tokens", "create", "--label", "A", "--expires-in-days", "0"},
		"an unknown option":            {"tokens", "create", "--label", "A", "--admin"},
		"a stray argument":             {"tokens", "create", "extra", "--label", "A"},
		"revoke without a token":       {"tokens", "revoke"},
		"revoke with an unknown flag":  {"tokens", "revoke", "abc", "--force"},
		"list with a stray argument":   {"tokens", "list", "now"},
		"list with a bad active value": {"tokens", "list", "--active", "maybe"},
		"activity with a bad page":     {"tokens", "activity", "--page", "0"},
		"activity with a bare token":   {"tokens", "activity", "--token"},
	} {
		exit, out, _, _ := runTokens(t, endpoint, args...)
		if exit != 2 || !json.Valid([]byte(out)) {
			t.Errorf("%s: exit %d, out %s", name, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("%d requests reached the service", len(sent))
	}
}

func TestTheProvisionRefusalsAreDeniedAccessNotUsageErrors(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 403, "permission_denied")
	t.Setenv(api.TokenVariable, agentSecret)
	exit, out, _, _ := runTokens(t, endpoint, "tokens", "list")
	if exit != 3 || !strings.Contains(out, "permission_denied") {
		t.Fatalf("exit %d out %s", exit, out)
	}
	if sent[0].Authorization != "Bearer "+agentSecret {
		t.Fatalf("authorization %q", sent[0].Authorization)
	}
	// The credential never appears in what the CLI prints.
	if strings.Contains(out, agentSecret) {
		t.Fatal("the credential was echoed")
	}
}

func TestTokensRevokeListAndActivityMapTheirOptions(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 200, "")
	for _, args := range [][]string{
		{"tokens", "revoke", "rst_" + agentIdentity, "--reason", "Laptop lost"},
		{"tokens", "list", "--active"},
		{"tokens", "activity", "--token", "rst_" + agentIdentity, "--page", "2"},
	} {
		if exit, out, _, _ := runTokens(t, endpoint, args...); exit != 0 {
			t.Fatalf("%v: exit %d out %s", args, exit, out)
		}
	}
	if sent[0].Path != "/v1/tokens.revoke" || sent[0].Input["tokenId"] != agentIdentity || sent[0].Input["reason"] != "Laptop lost" || sent[0].OperationID == "" {
		t.Fatalf("revoke: %+v", sent[0])
	}
	if sent[1].Path != "/v1/tokens.list" || sent[1].Input["active"] != true || sent[1].OperationID != "" {
		t.Fatalf("list: %+v", sent[1])
	}
	if sent[2].Path != "/v1/tokens.activity" || sent[2].Input["tokenId"] != agentIdentity || sent[2].Input["page"] != float64(2) {
		t.Fatalf("activity: %+v", sent[2])
	}
}

func TestABadCredentialInTheEnvironmentStopsBeforeAnyRequest(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 200, "")
	t.Setenv(api.TokenVariable, "rst_this-is-not-valid")
	exit, out, diagnostics, _ := runTokens(t, endpoint, "tokens", "list")
	if exit != 2 || len(sent) != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("exit %d sent %d out %s", exit, len(sent), out)
	}
	if strings.Contains(out+diagnostics, "rst_this-is-not-valid") {
		t.Fatal("the bad value was echoed")
	}
}

func TestAnUnauthenticatedReplyIsADeniedRequest(t *testing.T) {
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 401, "authentication_required")
	exit, out, _, _ := runTokens(t, endpoint, "tokens", "list")
	if exit != 3 || !strings.Contains(out, "authentication_required") {
		t.Fatalf("exit %d out %s", exit, out)
	}
}

// `close` lets an agent finish reconciliations and close periods with no review of its own, and no
// preset includes it: asking for it is allowed, and the command says plainly what it grants.
func TestTokensCreateSaysWhatCloseGrantsAndNoPresetHoldsIt(t *testing.T) {
	for name, permissions := range agentkit.TokenPresets {
		for _, permission := range permissions {
			if permission == "close" {
				t.Fatalf("the %s preset holds close", name)
			}
		}
	}
	var sent []tokenRequest
	endpoint := tokensServer(t, &sent, 200, "")
	exit, _, diagnostics, _ := runTokens(t, endpoint, "tokens", "create", "--label", "Agent", "--permissions", "read,draft,post,close")
	if exit != 0 || !strings.Contains(diagnostics, "finish reconciliations and close accounting periods with no review") || !strings.Contains(diagnostics, "No preset includes close") {
		t.Fatalf("exit %d diagnostics %s", exit, diagnostics)
	}
	for _, preset := range []string{"read-only", "draft", "bookkeeper"} {
		_, _, diagnostics, _ = runTokens(t, endpoint, "tokens", "create", "--label", "Agent", "--preset", preset)
		if strings.Contains(diagnostics, "holds close") {
			t.Fatalf("the %s preset was warned about close: %s", preset, diagnostics)
		}
	}
	// The help for the command says it too.
	var out bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: io.Discard}
	if exit := runner.Run(context.Background(), []string{"tokens", "create", "--help"}); exit != 0 || !strings.Contains(out.String(), "No preset includes close") {
		t.Fatalf("exit %d help %s", exit, out.String())
	}
}

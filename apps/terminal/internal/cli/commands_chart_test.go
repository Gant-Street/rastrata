package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const accountListJSON = `{"currency":"USD","configurationRevision":"0","suggestedEffectiveOn":"2026-01-01","accounts":[` +
	`{"id":"6000","code":"6000","name":"Advertising","role":"expense","parentId":null,"openedOn":"2026-02-01","closedOn":null,"balance":"0.00","tags":{"taxLine":"scheduleC.line8"}}]}`

// chartServer answers accounts.list and accounts.setTags like the application does and records
// what the CLI sent.
func chartServer(t *testing.T, warnings string, sent *[]api.Request) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, request)
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		switch r.URL.Path {
		case "/v1/accounts.list":
			envelope["data"] = json.RawMessage(accountListJSON)
		case "/v1/accounts.setTags":
			envelope["operationId"] = request.OperationID
			envelope["data"] = json.RawMessage(`{"accountId":"6000","effectiveOn":"2026-07-01","tags":{"taxLine":"scheduleC.line22"},"changed":true,"tagsRevision":"1","tagsHash":"` + strings.Repeat("a", 64) + `","warnings":[` + warnings + `]}`)
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runChart(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append(args, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func TestAccountsTagSendsTheTagsAndReportsTheResult(t *testing.T) {
	var sent []api.Request
	server := chartServer(t, "", &sent)
	id := api.NewOperationID()
	exit, out, _ := runChart(t, server, "accounts", "tag", "6000", "--tax-line", "scheduleC.line22", "--effective-on", "2026-07-01", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("tag failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].OperationID != id {
		t.Fatalf("expected one retained write, got %+v", sent)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	tags := input["tags"].(map[string]any)
	if input["accountId"] != "6000" || input["effectiveOn"] != "2026-07-01" || tags["taxLine"] != "scheduleC.line22" || len(tags) != 1 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	if !strings.Contains(out, `"changed":true`) {
		t.Fatalf("result missing: %s", out)
	}
}

func TestAccountsTagStartsAtTheAccountOpeningWhenNoDateIsGiven(t *testing.T) {
	var sent []api.Request
	server := chartServer(t, "", &sent)
	exit, _, _ := runChart(t, server, "accounts", "tag", "6000", "--cash-flow-class=operating")
	if exit != 0 || len(sent) != 2 {
		t.Fatalf("expected a list then a write: %d %+v", exit, sent)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[1].Input, &input)
	if input["effectiveOn"] != "2026-02-01" {
		t.Fatalf("did not use the opening date: %s", sent[1].Input)
	}
}

func TestAccountsTagNoneClearsATag(t *testing.T) {
	var sent []api.Request
	server := chartServer(t, "", &sent)
	exit, _, _ := runChart(t, server, "accounts", "tag", "6000", "--tax-line", "none", "--role-key", "none", "--effective-on", "2026-07-01")
	if exit != 0 {
		t.Fatalf("clear failed: %d", exit)
	}
	var input map[string]json.RawMessage
	_ = json.Unmarshal(sent[len(sent)-1].Input, &input)
	var tags map[string]json.RawMessage
	_ = json.Unmarshal(input["tags"], &tags)
	if string(tags["taxLine"]) != "null" || string(tags["roleKey"]) != "null" || len(tags) != 2 {
		t.Fatalf("clearing must send null, got %s", input["tags"])
	}
}

func TestAccountsTagPrintsWarningsToDiagnosticsAndKeepsStdoutJSON(t *testing.T) {
	var sent []api.Request
	server := chartServer(t, `"This takes effect in a closed period (January)."`, &sent)
	exit, out, diagnostics := runChart(t, server, "accounts", "tag", "6000", "--tax-line", "scheduleC.line22", "--effective-on", "2026-01-15")
	if exit != 0 || !strings.Contains(diagnostics, "Warning: This takes effect in a closed period") {
		t.Fatalf("warning missing: %d %q", exit, diagnostics)
	}
	if strings.Count(strings.TrimSpace(out), "\n") != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("stdout must be one JSON envelope: %q", out)
	}
}

func TestAccountsTagRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := chartServer(t, "", &sent)
	cases := map[string][]string{
		"no account":      {"accounts", "tag", "--tax-line", "scheduleC.line22"},
		"no tag":          {"accounts", "tag", "6000"},
		"unknown flag":    {"accounts", "tag", "6000", "--taxline", "scheduleC.line22"},
		"flag without it": {"accounts", "tag", "6000", "--tax-line"},
		"two accounts":    {"accounts", "tag", "6000", "6100", "--tax-line", "scheduleC.line22"},
	}
	for name, args := range cases {
		exit, out, _ := runChart(t, server, args...)
		if exit != 2 || !json.Valid([]byte(out)) || !strings.Contains(out, "usage_error") {
			t.Errorf("%s: want a usage error, got %d %s", name, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a usage error reached the service: %+v", sent)
	}
	exit, out, _ := runChart(t, server, "accounts", "tag", "9999", "--tax-line", "scheduleC.line22")
	if exit != 3 || !strings.Contains(out, "account_not_found") {
		t.Fatalf("unknown account: %d %s", exit, out)
	}
}

func TestAccountsListStillWorksNextToAccountsTag(t *testing.T) {
	var sent []api.Request
	server := chartServer(t, "", &sent)
	exit, out, _ := runChart(t, server, "accounts", "list")
	if exit != 0 || !strings.Contains(out, `"scheduleC.line8"`) {
		t.Fatalf("accounts list was shadowed: %d %s", exit, out)
	}
}

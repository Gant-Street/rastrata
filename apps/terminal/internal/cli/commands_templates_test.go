package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const templateDetailJSON = `{"id":"sole-proprietor","name":"Sole proprietor or single-member LLC","description":"x","entity":"soleProprietor","basis":"cash","taxYear":2026,` +
	`"taxForms":[],"addOns":["online-business"],"disclaimer":"Tax lines are suggestions taken from the IRS form. Verify against the current form; not tax advice.","notes":[],` +
	`"accounts":[` +
	`{"code":"1300","name":"Inventory","role":"asset","tags":{"cashFlowClass":"operating"},"note":"Goods held for sale."},` +
	`{"code":"1100","name":"Stripe balance","role":"asset","tags":{"cashFlowClass":"cash","roleKey":"stripe.balance"}},` +
	`{"code":"6000","name":"Advertising and marketing","role":"expense","tags":{"taxLine":"scheduleC.line8"}},` +
	`{"code":"6999","name":"Plain","role":"expense","tags":{}}]}`

func templatesServer(t *testing.T, sent *[]api.Request) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, request)
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		switch r.URL.Path {
		case "/v1/templates.get":
			envelope["data"] = json.RawMessage(templateDetailJSON)
		case "/v1/templates.list":
			envelope["data"] = json.RawMessage(`{"templates":[],"addOns":[],"taxYears":[2025,2026],"latestTaxYear":2026,"disclaimer":"x"}`)
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func TestTemplatesShowSendsTheChoicesAndPrintsTheEnvelope(t *testing.T) {
	var sent []api.Request
	server := templatesServer(t, &sent)
	exit, out, _ := runChart(t, server, "templates", "show", "sole-proprietor", "--basis", "cash", "--tax-year", "2026", "--add-on", "online-business")
	if exit != 0 || !json.Valid([]byte(out)) || !strings.Contains(out, `"stripe.balance"`) {
		t.Fatalf("show failed: %d %s", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	addOns := input["addOns"].([]any)
	if input["templateId"] != "sole-proprietor" || input["basis"] != "cash" || input["taxYear"] != float64(2026) || len(addOns) != 1 || addOns[0] != "online-business" {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTemplatesListIsAnAliasOfTheOperation(t *testing.T) {
	var sent []api.Request
	server := templatesServer(t, &sent)
	exit, out, _ := runChart(t, server, "templates", "list")
	if exit != 0 || !strings.Contains(out, `"latestTaxYear":2026`) {
		t.Fatalf("list failed: %d %s", exit, out)
	}
}

func TestTemplatesShowSetupPrintsOneBookSetupInputWithoutNotes(t *testing.T) {
	var sent []api.Request
	server := templatesServer(t, &sent)
	exit, out, diagnostics := runChart(t, server, "templates", "show", "sole-proprietor", "--setup", "--name", "Acme Studio", "--year", "2026", "--start-month", "10", "--periods", "quarterly")
	if exit != 0 {
		t.Fatalf("setup failed: %d %s", exit, out)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(out), &document); err != nil {
		t.Fatalf("not one JSON document: %v %q", err, out)
	}
	if document["name"] != "Acme Studio" || document["fiscalYear"] != float64(2026) || document["fiscalYearStartMonth"] != float64(10) || document["periodModel"] != "quarterly" || document["basis"] != "cash" || document["currency"] != "USD" {
		t.Fatalf("wrong header: %s", out)
	}
	if _, enveloped := document["ok"]; enveloped {
		t.Fatal("--setup must print the input document, not a response envelope")
	}
	accounts := document["accounts"].([]any)
	if len(accounts) != 4 {
		t.Fatalf("expected four accounts: %s", out)
	}
	first := accounts[0].(map[string]any)
	if _, has := first["note"]; has {
		t.Fatal("notes must not reach book.setup")
	}
	if first["tags"].(map[string]any)["cashFlowClass"] != "operating" {
		t.Fatalf("tags were lost: %s", out)
	}
	if plain := accounts[3].(map[string]any); plain["tags"] != nil {
		t.Fatalf("an untagged account must send no tags: %v", plain)
	}
	if !strings.Contains(diagnostics, "not tax advice") {
		t.Fatalf("the notice belongs on stderr: %q", diagnostics)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["taxYear"] != float64(2026) {
		t.Fatalf("the tax year defaults to the first fiscal year: %s", sent[0].Input)
	}
}

func TestTemplatesShowRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := templatesServer(t, &sent)
	cases := map[string][]string{
		"no id":                   {"templates", "show"},
		"unknown flag":            {"templates", "show", "generic", "--basiss", "cash"},
		"setup without a name":    {"templates", "show", "generic", "--setup", "--year", "2026"},
		"setup without a year":    {"templates", "show", "generic", "--setup", "--name", "Acme"},
		"setup flags without it":  {"templates", "show", "generic", "--name", "Acme"},
		"year that is not a year": {"templates", "show", "generic", "--setup", "--name", "Acme", "--year", "soon"},
		"tax year that is not":    {"templates", "show", "generic", "--tax-year", "later"},
		"bad month":               {"templates", "show", "generic", "--setup", "--name", "Acme", "--year", "2026", "--start-month", "x"},
	}
	for name, args := range cases {
		exit, out, _ := runChart(t, server, args...)
		if exit != 2 || !strings.Contains(out, "usage_error") {
			t.Errorf("%s: want a usage error, got %d %s", name, exit, out)
		}
	}
	if len(sent) > 1 {
		t.Fatalf("a usage error reached the service more than once: %d requests", len(sent))
	}
}

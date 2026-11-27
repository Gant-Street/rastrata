package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const stripeStatusJSON = `{"configured":true,"bookCurrency":"USD","key":{"present":true,"source":"environment","mode":"live","restricted":true,"problem":null,"warning":null},` +
	`"settings":null,"roles":[{"role":"stripe.balance","label":"Stripe balance","required":true,"state":"tagged","accountId":"1100","code":"1100","problem":null},` +
	`{"role":"stripe.adjustments","label":"Other Stripe adjustments","required":false,"state":"missing","accountId":null,"code":null,"problem":"No account is chosen for Other Stripe adjustments, and no open account carries the role key stripe.adjustments."}],` +
	`"account":null,"lastSync":null,"history":[],"through":null,` +
	`"balance":{"snapshot":null,"unpaid":null,"unpaidCount":0,"difference":null,"inTransit":null,"ties":false,"stale":true,"explanation":"Stripe's balance has not been read yet."},` +
	`"payouts":{"known":0,"booked":0,"waiting":0,"mismatched":0,"held":0,"reversed":0,"unmatched":0,"overdue":0,"oldestOverdueOn":null},` +
	`"held":{"lines":0,"otherCurrency":0,"manualPayouts":0,"adjustments":0,"taxNotReported":0,"refundsWithoutTaxSplit":0}}`

func stripeSyncJSON(id string, more bool, newLines int) string {
	return `{"run":{"id":"` + id + `","startedAt":"2026-03-20T12:00:00.000Z","finishedAt":"2026-03-20T12:00:01.000Z","disposition":"` +
		map[bool]string{true: "more", false: "complete"}[more] + `","requests":5,"pages":1,"transactions":` + strconv.Itoa(newLines) + `,"newLines":` + strconv.Itoa(newLines) +
		`,"duplicateLines":0,"heldLines":0,"payouts":1,"through":null,"errorCode":null,"errorMessage":null,"notes":[]},"more":` + strconv.FormatBool(more) + `,"balance":null}`
}

const stripeSettingsJSON = `{"mapping":[{"role":"stripe.balance","accountId":"1100"}],"syncFrom":"2026-01-01","timeZone":"America/Denver","salesTax":"none","overlapDays":3,"matchWindowDays":2,"accountKey":null}`

// stripeServer answers the Stripe operations like the application. moreFor says how many sync
// calls report that more is left; failWith makes sync fail like the service does.
func stripeServer(t *testing.T, moreFor int, failWith string, sent *[]sentRequest) string {
	t.Helper()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, sentRequest{Path: r.URL.Path, Request: request})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/stripe.status":
			envelope["data"] = json.RawMessage(stripeStatusJSON)
		case "/v1/stripe.sync":
			calls++
			if failWith != "" {
				w.WriteHeader(409)
				envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
					"error": map[string]any{"code": failWith, "message": "Rastrata has no Stripe key.", "details": []any{}, "retryable": false}}
			} else {
				envelope["data"] = json.RawMessage(stripeSyncJSON(request.OperationID, calls <= moreFor, calls))
			}
		case "/v1/stripe.payouts":
			envelope["data"] = json.RawMessage(`{"count":0,"page":2,"pageSize":25,"payouts":[]}`)
		case "/v1/stripe.configure":
			envelope["data"] = json.RawMessage(`{"settings":` + stripeSettingsJSON + `,"roles":[],"ready":false,"notes":["Imports begin on 2026-01-01."]}`)
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runStripe(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"stripe"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func TestStripeSyncCatchesUpOneCallAtATimeUnderNewIdentities(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 2, "", &sent)
	exit, out, diagnostics := runStripe(t, server, "sync")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("sync failed: %d %s", exit, out)
	}
	if len(sent) != 3 {
		t.Fatalf("expected three calls until caught up, got %d", len(sent))
	}
	seen := map[string]bool{}
	for _, request := range sent {
		if request.Path != "/v1/stripe.sync" || request.Request.OperationID == "" || seen[request.Request.OperationID] {
			t.Fatalf("each call needs its own identity: %+v", sent)
		}
		seen[request.Request.OperationID] = true
	}
	var envelope struct {
		Data struct {
			More bool `json:"more"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil || envelope.Data.More {
		t.Fatalf("the printed result must be the last one, with nothing left: %s", out)
	}
	if !strings.Contains(diagnostics, "continuing") || strings.Count(out, "\n") > 1 {
		t.Fatalf("progress belongs on stderr and stdout holds one envelope: %q", diagnostics)
	}
}

func TestStripeSyncOnceOrWithAnIdentityMakesExactlyOneCall(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 5, "", &sent)
	if exit, _, _ := runStripe(t, server, "sync", "--once", "--budget-seconds", "7"); exit != 0 {
		t.Fatal("once failed")
	}
	if len(sent) != 1 {
		t.Fatalf("--once makes one call, got %d", len(sent))
	}
	var input map[string]int
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if input["budgetSeconds"] != 7 {
		t.Fatalf("the budget did not arrive: %v", input)
	}
	sent = nil
	id := api.NewOperationID()
	if exit, _, _ := runStripe(t, server, "sync", "--operation-id", id); exit != 0 || len(sent) != 1 || sent[0].Request.OperationID != id {
		t.Fatalf("a given identity is used for one call: %+v", sent)
	}
}

func TestStripeSyncFailureStopsAndExitsWithTheRejectionCode(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 0, "stripe_key_missing", &sent)
	exit, out, _ := runStripe(t, server, "sync")
	if exit != 3 || !strings.Contains(out, "stripe_key_missing") || len(sent) != 1 {
		t.Fatalf("a failed sync must stop with exit 3: %d %s (%d calls)", exit, out, len(sent))
	}
}

func TestStripeStatusAndPayoutsSendOnlyWhatWasAsked(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 0, "", &sent)
	if exit, out, _ := runStripe(t, server, "status", "--books", "false"); exit != 0 || !strings.Contains(out, `"configured":true`) {
		t.Fatalf("status failed: %d %s", exit, out)
	}
	var status map[string]bool
	_ = json.Unmarshal(sent[0].Request.Input, &status)
	if sent[0].Path != "/v1/stripe.status" || status["books"] {
		t.Fatalf("--books false must reach the service: %+v", sent[0])
	}
	for _, filter := range []string{"all", "waiting", "mismatch", "held", "unmatched"} {
		if exit, _, _ := runStripe(t, server, "payouts", "--filter", filter, "--page", "2"); exit != 0 {
			t.Fatalf("payouts --filter %s failed", filter)
		}
		var payouts map[string]any
		_ = json.Unmarshal(sent[len(sent)-1].Request.Input, &payouts)
		if payouts["filter"] != filter || payouts["page"] != float64(2) {
			t.Fatalf("payout filters changed on the way: %v", payouts)
		}
	}
}

func TestStripeConfigureBuildsTheMappingAndNumbersExactly(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 0, "", &sent)
	exit, out, diagnostics := runStripe(t, server, "configure", "--map", "stripe.balance=1100, stripe.fees=6025", "--sync-from", "2026-03-01",
		"--time-zone", "America/Denver", "--sales-tax", "none", "--overlap-days", "5", "--match-window-days", "1")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("configure failed: %d %s", exit, out)
	}
	var input struct {
		Mapping         []map[string]string `json:"mapping"`
		SyncFrom        string              `json:"syncFrom"`
		TimeZone        string              `json:"timeZone"`
		SalesTax        string              `json:"salesTax"`
		OverlapDays     int                 `json:"overlapDays"`
		MatchWindowDays int                 `json:"matchWindowDays"`
	}
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if len(input.Mapping) != 2 || input.Mapping[1]["role"] != "stripe.fees" || input.Mapping[1]["accountId"] != "6025" ||
		input.SyncFrom != "2026-03-01" || input.TimeZone != "America/Denver" || input.SalesTax != "none" || input.OverlapDays != 5 || input.MatchWindowDays != 1 {
		t.Fatalf("settings changed on the way: %+v", input)
	}
	if !strings.Contains(diagnostics, "Retaining") {
		t.Fatal("configure is a write and must announce its retained identity")
	}
}

func TestStripeConfigureNoneClearsTheChosenAccounts(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 0, "", &sent)
	if exit, out, _ := runStripe(t, server, "configure", "--map", "none"); exit != 0 {
		t.Fatalf("configure --map none failed: %d %s", exit, out)
	}
	var input map[string]json.RawMessage
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if string(input["mapping"]) != "[]" {
		t.Fatalf("none must send an empty mapping so each role uses its role key: %s", sent[0].Request.Input)
	}
	if _, present := input["syncFrom"]; present {
		t.Fatalf("only what was named is sent: %s", sent[0].Request.Input)
	}
}

func TestStripeCommandsRefuseWhatTheyDoNotUnderstand(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 0, "", &sent)
	cases := [][]string{
		{"status", "extra"},
		{"status", "--books", "maybe"},
		{"sync", "--budget-seconds"},
		{"sync", "--budget-seconds", "99"},
		{"sync", "--bogus", "1"},
		{"payouts", "--filter", "everything"},
		{"payouts", "--page", "0"},
		{"configure", "--map", "stripe.balance"},
		{"configure", "--sales-tax", "maybe"},
		{"configure", "--overlap-days", "31"},
		{"configure", "--time-zone"},
	}
	for _, args := range cases {
		exit, out, _ := runStripe(t, server, args...)
		if exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v should be a usage error, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing should have been sent: %+v", sent)
	}
}

func TestStripeNeverTakesTheKeyAsAnArgument(t *testing.T) {
	var sent []sentRequest
	server := stripeServer(t, 0, "", &sent)
	exit, _, _ := runStripe(t, server, "configure", "--key", "rk_live_abc")
	if exit != 2 || len(sent) != 0 {
		t.Fatalf("a key must never be accepted on the command line: %d", exit)
	}
}

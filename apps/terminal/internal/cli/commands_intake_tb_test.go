package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

func tbViewJSON(balanced bool) string {
	state := "true"
	if !balanced {
		state = "false"
	}
	return `{"asOf":"2026-04-30","layout":"period","balanced":` + state + `,"debit":"13500.00","credit":"13500.00","rows":[` +
		`{"row":5,"code":"1010","name":"Harbor Checking","debit":"12000.00","credit":"0.00","balance":"12000.00","match":{"accountId":"1010","how":"code","role":"asset"},"suggested":"12000.00"},` +
		`{"row":6,"name":"Juniper Card","debit":"0.00","credit":"1500.00","balance":"-1500.00","match":{"accountId":"2100","how":"name","role":"liability"},"suggested":"1500.00"},` +
		`{"row":7,"name":"Sales","debit":"0.00","credit":"900.00","balance":"-900.00","match":{"accountId":"4000","how":"name","role":"income"},"suggested":"900.00"},` +
		`{"row":8,"name":"Retained Earnings","debit":"1500.00","credit":"0.00","balance":"1500.00"}],` +
		`"issues":[{"severity":"warning","message":"A warning about a row."}]}`
}

func tbServer(t *testing.T, balanced bool) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if r.URL.Path == "/v1/uploads" {
			envelope["data"] = map[string]any{"sha256": recipeSHA, "size": 60, "mediaType": "application/octet-stream"}
		} else if r.URL.Path == "/v1/intake.trialBalance" {
			envelope["data"] = json.RawMessage(tbViewJSON(balanced))
		} else {
			w.WriteHeader(404)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
				"error": map[string]any{"code": "route_not_found", "message": "not found", "details": []any{}, "retryable": false}}
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func writeTBFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tb.csv")
	if err := os.WriteFile(path, []byte("Trial Balance\nAs at 30 April 2026\nAccount,Debit,Credit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestIntakeTrialBalanceBalancesOnlyPrintsTheBankAndCardListForOpeningReview(t *testing.T) {
	exit, out, diagnostics := runIntakeCommand(t, tbServer(t, true), "intake", "trial-balance", writeTBFile(t), "--balances-only=true")
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	// Banks and cards only, in the orientation opening review takes; income and the unmatched row are not offered.
	if strings.TrimSpace(out) != "1010=12000.00,2100=1500.00" {
		t.Fatalf("out = %q", out)
	}
	if !strings.Contains(diagnostics, "statement's balance") {
		t.Errorf("the reminder to use the statements' balances is missing: %q", diagnostics)
	}
}

func TestIntakeTrialBalanceRefusesToOfferBalancesFromOneThatDoesNotBalance(t *testing.T) {
	exit, out, _ := runIntakeCommand(t, tbServer(t, false), "intake", "trial-balance", writeTBFile(t), "--balances-only=true")
	if exit != 3 || strings.Contains(out, "1010=") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if !strings.Contains(out, "trial_balance_unbalanced") {
		t.Fatalf("out = %s", out)
	}
}

func TestIntakeTrialBalanceTextAndJSONAndUsage(t *testing.T) {
	url := tbServer(t, true)
	file := writeTBFile(t)
	exit, out, _ := runIntakeCommand(t, url, "intake", "trial-balance", file, "--format", "text")
	if exit != 0 || !strings.Contains(out, "Trial balance as at 2026-04-30: debits 13500.00, credits 13500.00 (balances)") || !strings.Contains(out, "1010 (code)") || !strings.Contains(out, "warning: A warning about a row.") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	exit, out, _ = runIntakeCommand(t, url, "intake", "trial-balance", file)
	if exit != 0 || !strings.Contains(out, `"balanced":true`) {
		t.Fatalf("exit %d: %s", exit, out)
	}
	for _, args := range [][]string{
		{"intake", "trial-balance"},
		{"intake", "trial-balance", file, "extra"},
		{"intake", "trial-balance", file, "--bogus=1"},
		{"intake", "trial-balance", file, "--balances-only=maybe"},
		{"intake", "trial-balance", filepath.Join(t.TempDir(), "none.csv")},
	} {
		if exit, out, _ := runIntakeCommand(t, url, args...); exit != 2 {
			t.Errorf("%v: exit %d, %s", args, exit, out)
		}
	}
}

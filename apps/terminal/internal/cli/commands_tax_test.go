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

// taxServer answers the tax operations the CLI tests need and records what the CLI sent.
func taxServer(t *testing.T, responses map[string]string, sent *[]api.Request) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, request)
		name := strings.TrimPrefix(r.URL.Path, "/v1/")
		data, known := responses[name]
		if !known {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": api.Version, "bookId": "local-book", "ok": true,
			"operationId": request.OperationID, "data": json.RawMessage(data),
		})
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runTax(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append(args, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

var taxHash = strings.Repeat("a", 64)

// worksheetJSON is the smallest worksheet the contract accepts.
var worksheetJSON = `{"compilerVersion":"rastrata-tax-worksheet-v1","populationHash":"` + taxHash + `","ledgerPopulationHash":"` + taxHash +
	`","tagMapHash":"` + taxHash + `","tagsRevision":"4","bookRevision":"9","postingSequence":"9","currency":"USD","basis":"cash","taxYear":2025,` +
	`"form":{"id":"scheduleC","name":"Schedule C (Form 1040)","subject":"Profit or Loss From Business","taxYear":2025,"status":"final","verifiedOn":"2026-10-03","sources":[]},` +
	`"forms":[],"from":"2025-01-01","to":"2025-12-31","fiscalYear":{"year":2025,"startsOn":"2025-01-01","endsOn":"2025-12-31"},"mealsPercent":50,` +
	`"parts":[],"unmapped":[],"unmappedIncome":"0.00","unmappedExpenses":"0.00",` +
	`"reconciliation":{"rows":[],"netIncomeBooks":"0.00","netProfit":"0.00","ties":true},"notes":[],"warnings":[],"disclaimer":"Not tax advice."}`

const csvFile = `{"filename":"schedule-c-worksheet-2025.csv","mediaType":"text/csv; charset=utf-8","bookRevision":"3","populationHash":"` +
	"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `","content":"Report,Schedule C worksheet\r\nLine,Amount\r\n"}`

func TestTaxWorksheetSendsTheYearAndOptionsAndPrintsTheEnvelope(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxWorksheet.get": worksheetJSON}, &sent)
	exit, out, _ := runTax(t, server, "tax", "worksheet", "--year", "2025", "--form", "scheduleC", "--meals-percent", "80", "--from", "2025-01-01", "--tags-revision", "4", "--revision", "9")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("worksheet failed: %d %s", exit, out)
	}
	if len(sent) != 1 {
		t.Fatalf("expected one read, got %d", len(sent))
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["taxYear"] != float64(2025) || input["form"] != "scheduleC" || input["mealsPercent"] != float64(80) ||
		input["from"] != "2025-01-01" || input["tagsRevision"] != "4" || input["revision"] != "9" || len(input) != 6 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxWorksheetCSVPrintsTheFileExactlyAsTheServiceMadeIt(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxWorksheet.export": csvFile}, &sent)
	exit, out, _ := runTax(t, server, "tax", "worksheet", "--year", "2025", "--format", "csv", "--file", "postings")
	if exit != 0 || out != "Report,Schedule C worksheet\r\nLine,Amount\r\n" {
		t.Fatalf("csv wrong: %d %q", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["file"] != "postings" || input["taxYear"] != float64(2025) {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxWorksheetRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxWorksheet.get": worksheetJSON}, &sent)
	cases := map[string][]string{
		"no year":          {"tax", "worksheet"},
		"year not a year":  {"tax", "worksheet", "--year", "next"},
		"year too small":   {"tax", "worksheet", "--year", "25"},
		"bare form":        {"tax", "worksheet", "--year", "2025", "--form"},
		"percent too high": {"tax", "worksheet", "--year", "2025", "--meals-percent", "101"},
		"percent text":     {"tax", "worksheet", "--year", "2025", "--meals-percent", "half"},
		"unknown option":   {"tax", "worksheet", "--year", "2025", "--quarter", "1"},
		"file without csv": {"tax", "worksheet", "--year", "2025", "--file", "accounts"},
		"extra word":       {"tax", "worksheet", "extra", "--year", "2025"},
	}
	for name, args := range cases {
		exit, out, _ := runTax(t, server, args...)
		if exit != 2 || !strings.Contains(out, "usage_error") {
			t.Errorf("%s: expected a usage error, got %d %s", name, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a refused command must not call the service, sent %d", len(sent))
	}
}

func TestTaxWorksheetFailureKeepsTheServicesOwnCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
			"error": map[string]any{"code": "tax_year_unsupported", "message": "Choose 2025 or 2026.", "details": []any{}, "retryable": false}})
	}))
	defer server.Close()
	exit, out, _ := runTax(t, server.URL, "tax", "worksheet", "--year", "2019")
	if exit != 3 || !strings.Contains(out, "tax_year_unsupported") {
		t.Fatalf("expected the service's refusal: %d %s", exit, out)
	}
}

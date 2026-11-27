package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// salesJSON is the smallest sales-tax summary the contract accepts.
var salesJSON = `{"compilerVersion":"rastrata-sales-tax-v1","populationHash":"` + taxHash + `","ledgerPopulationHash":"` + taxHash +
	`","tagMapHash":"` + taxHash + `","tagsRevision":"0","bookRevision":"9","currency":"USD","basis":"cash","taxYear":2026,` +
	`"from":"2026-01-01","to":"2026-12-31","period":"month","accounts":[],"candidates":[],` +
	`"opening":"0.00","collected":"0.00","remitted":"0.00","closing":"0.00","periods":[],` +
	`"stripe":{"read":true,"payouts":0,"booked":"0.00","reported":"0.00","salesTax":null,"taxNotReported":null,"refundsWithoutTaxSplit":null},` +
	`"statement":"Rastrata does not know your sales tax rates.","notes":[],"warnings":[],"disclaimer":"Not tax advice."}`

func salesExportJSON(content string) string {
	encoded, _ := json.Marshal(content)
	return `{"filename":"sales-tax-2026.csv","mediaType":"text/csv; charset=utf-8","bookRevision":"9","populationHash":"` + taxHash + `","content":` + string(encoded) + `}`
}

func TestTaxSalesSendsTheYearAndOptions(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxSales.get": salesJSON}, &sent)
	exit, out, _ := runTax(t, server, "tax", "sales", "--year", "2026", "--period", "quarter", "--from", "2026-01-01", "--to", "2026-06-30", "--tags-revision", "3", "--revision", "9")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("sales failed: %d %s", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["taxYear"] != float64(2026) || input["period"] != "quarter" || input["from"] != "2026-01-01" || input["to"] != "2026-06-30" ||
		input["tagsRevision"] != "3" || input["revision"] != "9" || len(input) != 6 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	if !strings.Contains(out, "does not know your sales tax rates") {
		t.Fatalf("the statement about rates must reach the person: %s", out)
	}
}

func TestTaxSalesCSVPrintsTheFileAsTheServiceMadeIt(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxSales.export": salesExportJSON("Period,Collected\r\n2026-01,8.00\r\n")}, &sent)
	exit, out, _ := runTax(t, server, "tax", "sales", "--year", "2026", "--format", "csv", "--file", "postings")
	if exit != 0 || out != "Period,Collected\r\n2026-01,8.00\r\n" {
		t.Fatalf("csv wrong: %d %q", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["file"] != "postings" || input["taxYear"] != float64(2026) {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxSalesRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxSales.get": salesJSON, "taxSales.export": salesExportJSON("x")}, &sent)
	cases := map[string][]string{
		"no year":               {"tax", "sales"},
		"year not a number":     {"tax", "sales", "--year", "soon"},
		"unknown option":        {"tax", "sales", "--year", "2026", "--rate", "7"},
		"form is not an option": {"tax", "sales", "--year", "2026", "--form", "scheduleC"},
		"bad period":            {"tax", "sales", "--year", "2026", "--period", "week"},
		"bare period":           {"tax", "sales", "--year", "2026", "--period"},
		"bad file":              {"tax", "sales", "--year", "2026", "--format", "csv", "--file", "everything"},
		"file without csv":      {"tax", "sales", "--year", "2026", "--file", "summary"},
		"extra argument":        {"tax", "sales", "now", "--year", "2026"},
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

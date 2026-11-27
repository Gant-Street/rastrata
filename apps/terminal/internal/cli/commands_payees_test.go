package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const payeeJSON = `{"id":"pay_1","version":1,"name":"Jane Doe Design","words":["jane doe"],"defaultAccountId":null,"note":"",` +
	`"retired":false,"hasTaxDetails":false,"recordedAt":"2026-10-17T12:00:00.000Z","principal":"owner"}`

var payeeListJSON = `{"payees":[` + payeeJSON + `],"count":1,"page":1,"pageSize":100,"payeesRevision":"1","payeesHash":"` + taxHash + `"}`
var payeeSavedJSON = `{"payee":` + payeeJSON + `,"changed":true,"payeesRevision":"1","payeesHash":"` + taxHash + `"}`

const zeroTally = `{"received":"0.00","spent":"0.00","transactions":0}`

var payeeTotalsJSON = `{"from":"2026-03-01","to":"2026-03-31","currency":"USD","basis":"cash","bookRevision":"9","payeesRevision":"1",` +
	`"payeesHash":"` + taxHash + `","ledgerPopulationHash":"` + taxHash + `","populationHash":"` + taxHash + `","direction":"both",` +
	`"rows":[],"rowCount":0,"page":1,"pageSize":100,"unnamed":[],"unnamedCount":0,` +
	`"unnamedRest":{"groups":0,"received":"0.00","spent":"0.00","transactions":0},"ambiguous":[],"ambiguousCount":0,` +
	`"ambiguousRest":{"groups":0,"received":"0.00","spent":"0.00","transactions":0},` +
	`"noPayee":{"byHand":` + zeroTally + `,"noBankText":` + zeroTally + `},"totals":` + zeroTally + `,` +
	`"tieOut":{"profitLossIncome":"0.00","profitLossExpenses":"0.00","income":"0.00","expenses":"0.00",` +
	`"places":{"payees":{"received":"0.00","spent":"0.00","transactions":0},"unnamed":{"received":"0.00","spent":"0.00","transactions":0},` +
	`"ambiguous":{"received":"0.00","spent":"0.00","transactions":0},"noPayee":{"received":"0.00","spent":"0.00","transactions":0}},"matches":true},` +
	`"inboxRead":true,"warnings":[]}`

var payeeDetailJSON = `{"subject":{"kind":"payee","payeeId":"pay_1"},"payee":` + payeeJSON + `,"history":[],"transactions":[],` +
	`"count":0,"page":1,"pageSize":50,"totals":` + zeroTally + `,"from":"2026-03-01","to":"2026-03-31","currency":"USD","basis":"cash",` +
	`"bookRevision":"9","payeesRevision":"1","ledgerPopulationHash":"` + taxHash + `","populationHash":"` + taxHash + `",` +
	`"inboxRead":true,"warnings":[]}`

var payeeTestJSON = `{"keys":["jane doe"],"problems":[],"matches":` + zeroTally + `,"stays":` + zeroTally + `,"fromUnnamed":` + zeroTally +
	`,"fromAmbiguous":` + zeroTally + `,"fromNowhere":` + zeroTally + `,"taken":[],"lost":` + zeroTally +
	`,"tied":{"received":"0.00","spent":"0.00","transactions":0,"payees":[]},"beaten":[],"sample":[],"from":"2026-03-01","to":"2026-03-31",` +
	`"bookRevision":"9","payeesRevision":"1","ledgerPopulationHash":"` + taxHash + `","inboxRead":true}`

func payeeExportJSON(content string) string {
	encoded, _ := json.Marshal(content)
	return `{"filename":"money-by-payee-2026-03-01-to-2026-03-31.csv","mediaType":"text/csv; charset=utf-8","bookRevision":"9",` +
		`"populationHash":"` + taxHash + `","content":` + string(encoded) + `}`
}

func payeesInput(t *testing.T, request api.Request) map[string]any {
	t.Helper()
	var input map[string]any
	if err := json.Unmarshal(request.Input, &input); err != nil {
		t.Fatalf("input is not an object: %s", request.Input)
	}
	return input
}

func TestPayeesListsWithOrWithoutTheVerb(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.list": payeeListJSON}, &sent)
	for _, args := range [][]string{{"payees"}, {"payees", "list"}} {
		if exit, out, _ := runTax(t, server, args...); exit != 0 || !json.Valid([]byte(out)) {
			t.Fatalf("%v failed: %d %s", args, exit, out)
		}
	}
	exit, _, _ := runTax(t, server, "payees", "--text", "jane doe", "--include-retired", "--page", "2", "--page-size", "10", "--payees-revision", "4")
	if exit != 0 {
		t.Fatalf("list with options failed: %d", exit)
	}
	input := payeesInput(t, sent[2])
	if input["text"] != "jane doe" || input["includeRetired"] != true || input["page"] != float64(2) || input["pageSize"] != float64(10) ||
		input["payeesRevision"] != "4" || len(input) != 5 {
		t.Fatalf("wrong input: %s", sent[2].Input)
	}
	if len(payeesInput(t, sent[0])) != 0 {
		t.Fatalf("a bare list sends nothing: %s", sent[0].Input)
	}
}

func TestPayeesTotalsSendsTheRangeAndThePins(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.totals": payeeTotalsJSON}, &sent)
	exit, out, _ := runTax(t, server, "payees", "totals", "--as-of", "2026-03-31", "--from", "2026-03-01", "--direction", "spent", "--by-month",
		"--page", "2", "--revision", "9", "--payees-revision", "1", "--accounts", "6140; 6170")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("totals failed: %d %s", exit, out)
	}
	input := payeesInput(t, sent[0])
	if input["asOf"] != "2026-03-31" || input["from"] != "2026-03-01" || input["direction"] != "spent" || input["byMonth"] != true ||
		input["page"] != float64(2) || input["revision"] != "9" || input["payeesRevision"] != "1" || len(input) != 8 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	accounts, _ := input["accountIds"].([]any)
	if len(accounts) != 2 || accounts[0] != "6140" || accounts[1] != "6170" {
		t.Fatalf("wrong accounts: %s", sent[0].Input)
	}
}

func TestPayeesTotalsCSVPrintsTheFileAsTheServiceMadeIt(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.export": payeeExportJSON("Row,Payee\r\npayee,Jane\r\n")}, &sent)
	exit, out, _ := runTax(t, server, "payees", "totals", "--as-of", "2026-03-31", "--format", "csv", "--file", "transactions", "--id", "pay_1")
	if exit != 0 || out != "Row,Payee\r\npayee,Jane\r\n" {
		t.Fatalf("csv wrong: %d %q", exit, out)
	}
	input := payeesInput(t, sent[0])
	if input["file"] != "transactions" || input["payeeId"] != "pay_1" || input["asOf"] != "2026-03-31" {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestPayeesShowNamesExactlyOneThing(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.get": payeeDetailJSON}, &sent)
	for _, args := range [][]string{
		{"payees", "show", "pay_1", "--as-of", "2026-03-31"},
		{"payees", "show", "--unnamed", "coffee shop #", "--as-of", "2026-03-31"},
		{"payees", "show", "--ambiguous", "adobe creative cloud # ca", "--as-of", "2026-03-31"},
		{"payees", "show", "--no-payee", "by_hand", "--as-of", "2026-03-31", "--from", "2026-01-01", "--page", "2"},
	} {
		if exit, out, _ := runTax(t, server, args...); exit != 0 || !json.Valid([]byte(out)) {
			t.Fatalf("%v failed: %d %s", args, exit, out)
		}
	}
	if input := payeesInput(t, sent[0]); input["payeeId"] != "pay_1" || len(input) != 2 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	if input := payeesInput(t, sent[1]); input["unnamed"] != "coffee shop #" {
		t.Fatalf("wrong input: %s", sent[1].Input)
	}
	if input := payeesInput(t, sent[2]); input["ambiguous"] != "adobe creative cloud # ca" {
		t.Fatalf("wrong input: %s", sent[2].Input)
	}
	if input := payeesInput(t, sent[3]); input["noPayee"] != "by_hand" || input["from"] != "2026-01-01" || input["page"] != float64(2) {
		t.Fatalf("wrong input: %s", sent[3].Input)
	}
}

func TestPayeesTestSplitsTheWordsAtSemicolons(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.test": payeeTestJSON}, &sent)
	exit, out, _ := runTax(t, server, "payees", "test", "--words", "jane doe; jane d ;", "--as-of", "2026-03-31", "--id", "pay_1")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("test failed: %d %s", exit, out)
	}
	input := payeesInput(t, sent[0])
	words, _ := input["words"].([]any)
	if len(words) != 2 || words[0] != "jane doe" || words[1] != "jane d" || input["payeeId"] != "pay_1" || input["asOf"] != "2026-03-31" {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestPayeesSaveBuildsTheInputAndRetainsTheWrite(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.save": payeeSavedJSON}, &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runTax(t, server, "payees", "save", "--name", "Jane Doe Design", "--words", "jane doe; zelle jane",
		"--default-account", "6030", "--note", "Referred by Sam", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("save failed: %d %s", exit, out)
	}
	if sent[0].OperationID != id || !strings.Contains(diagnostics, "Retaining "+id) {
		t.Fatalf("the write was not retained under the identity: %+v %q", sent[0], diagnostics)
	}
	input := payeesInput(t, sent[0])
	words, _ := input["words"].([]any)
	if input["name"] != "Jane Doe Design" || len(words) != 2 || input["defaultAccountId"] != "6030" || input["note"] != "Referred by Sam" {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestPayeesSaveChangesNeedTheVersionReadAndNoneClearsAField(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.save": payeeSavedJSON}, &sent)
	exit, failed, _ := runTax(t, server, "payees", "save", "--id", "pay_1", "--expected-version", "3", "--default-account", "none", "--words", "none", "--retired", "true")
	if exit != 0 {
		t.Fatalf("change failed: %d %s", exit, failed)
	}
	input := payeesInput(t, sent[0])
	words, _ := input["words"].([]any)
	if input["payeeId"] != "pay_1" || input["expectedVersion"] != float64(3) || input["retired"] != true || len(words) != 0 || len(input) != 5 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	if value, present := input["defaultAccountId"]; !present || value != nil {
		t.Fatalf("default-account none must be null: %s", sent[0].Input)
	}
}

func TestPayeesRefuseWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"payees.list": payeeListJSON, "payees.totals": payeeTotalsJSON, "payees.get": payeeDetailJSON,
		"payees.test": payeeTestJSON, "payees.save": payeeSavedJSON, "payees.export": payeeExportJSON("x")}, &sent)
	cases := map[string][]string{
		"list unknown option":       {"payees", "--tin", "1"},
		"list bare text":            {"payees", "--text"},
		"list bad page":             {"payees", "--page", "0"},
		"unknown verb":              {"payees", "delete", "pay_1"},
		"totals no date":            {"payees", "totals"},
		"totals bad direction":      {"payees", "totals", "--as-of", "2026-03-31", "--direction", "sideways"},
		"totals file without csv":   {"payees", "totals", "--as-of", "2026-03-31", "--file", "summary"},
		"totals csv bad file":       {"payees", "totals", "--as-of", "2026-03-31", "--format", "csv", "--file", "everything"},
		"totals csv with direction": {"payees", "totals", "--as-of", "2026-03-31", "--format", "csv", "--direction", "spent"},
		"totals id without file":    {"payees", "totals", "--as-of", "2026-03-31", "--format", "csv", "--id", "pay_1"},
		"totals bad by-month":       {"payees", "totals", "--as-of", "2026-03-31", "--by-month", "maybe"},
		"show nothing":              {"payees", "show", "--as-of", "2026-03-31"},
		"show two things":           {"payees", "show", "pay_1", "--unnamed", "x", "--as-of", "2026-03-31"},
		"show no date":              {"payees", "show", "pay_1"},
		"show bad no-payee":         {"payees", "show", "--no-payee", "everyone", "--as-of", "2026-03-31"},
		"test no words":             {"payees", "test", "--as-of", "2026-03-31"},
		"test empty words":          {"payees", "test", "--words", ";", "--as-of", "2026-03-31"},
		"test no date":              {"payees", "test", "--words", "jane doe"},
		"save no name":              {"payees", "save", "--words", "jane doe"},
		"save id without version":   {"payees", "save", "--id", "pay_1", "--note", "x"},
		"save version without id":   {"payees", "save", "--expected-version", "2", "--name", "X Co"},
		"save version not number":   {"payees", "save", "--id", "pay_1", "--expected-version", "two", "--note", "x"},
		"save nothing to change":    {"payees", "save", "--id", "pay_1", "--expected-version", "1"},
		"save unknown option":       {"payees", "save", "--name", "X Co", "--tin", "123-45-6789"},
		"save bad retired":          {"payees", "save", "--id", "pay_1", "--expected-version", "1", "--retired", "yes"},
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

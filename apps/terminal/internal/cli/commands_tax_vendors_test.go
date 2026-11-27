package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// vendorsJSON is the smallest vendor list the contract accepts.
var vendorsJSON = `{"taxYear":2026,"from":"2026-01-01","to":"2026-12-31","currency":"USD","basis":"cash","bookRevision":"9",` +
	`"ledgerPopulationHash":"` + taxHash + `","vendorsRevision":"0","vendorsHash":"` + taxHash + `","populationHash":"` + taxHash + `",` +
	`"threshold":{"taxYear":2026,"amount":"2000.00","note":"For payments made in 2026 the IRS threshold is $2,000.","sources":[]},` +
	`"accounts":[],"vendors":[],"payees":[],"totals":{"payments":0,"counted":"0.00","card":"0.00","other":"0.00"},` +
	`"overThreshold":0,"needW9":0,"undecided":0,"notes":[],"warnings":[],"disclaimer":"Not tax advice."}`

const vendorJSON = `{"id":"ven_1","version":1,"name":"Jane Doe Design","payeeKeys":["jane doe"],"reporting":"yes","reason":null,` +
	`"w9":"requested","w9On":"2026-02-10","classification":null,"paidBy":"unknown","notes":"","recordedAt":"2026-10-04T12:00:00.000Z","principal":"owner"}`

var savedJSON = `{"vendor":` + vendorJSON + `,"changed":true,"vendorsRevision":"1","vendorsHash":"` + taxHash + `"}`
var accountsSetJSON = `{"reportable":["6030","6080"],"changed":2,"vendorsRevision":"2","vendorsHash":"` + taxHash + `"}`

func vendorExportJSON(content string) string {
	encoded, _ := json.Marshal(content)
	return `{"filename":"1099-vendors-2026.csv","mediaType":"text/csv; charset=utf-8","bookRevision":"9","populationHash":"` + taxHash + `","content":` + string(encoded) + `}`
}

func TestTaxVendorsListsAndPassesTheRevisions(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxVendors.list": vendorsJSON}, &sent)
	exit, out, _ := runTax(t, server, "tax", "vendors", "--year", "2026", "--vendors-revision", "5", "--tags-revision", "3", "--revision", "9")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("list failed: %d %s", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["taxYear"] != float64(2026) || input["vendorsRevision"] != "5" || input["tagsRevision"] != "3" || input["revision"] != "9" || len(input) != 4 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxVendorsCSVPrintsTheFileAsTheServiceMadeIt(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxVendors.export": vendorExportJSON("Row,Vendor\r\nvendor,Jane\r\n")}, &sent)
	exit, out, _ := runTax(t, server, "tax", "vendors", "--year", "2026", "--format", "csv", "--file", "payments")
	if exit != 0 || out != "Row,Vendor\r\nvendor,Jane\r\n" {
		t.Fatalf("csv wrong: %d %q", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["file"] != "payments" {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxVendorShowSendsTheVendorAndYear(t *testing.T) {
	var sent []api.Request
	detail := `{"vendor":{"vendor":` + vendorJSON + `,"payments":0,"counted":"0.00","card":"0.00","other":"0.00","meetsThreshold":false,"attention":[]},` +
		`"history":[` + vendorJSON + `],"payments":[],"truncated":false,"taxYear":2026,"from":"2026-01-01","to":"2026-12-31"}`
	server := taxServer(t, map[string]string{"taxVendors.get": detail}, &sent)
	exit, out, _ := runTax(t, server, "tax", "vendor", "show", "ven_1", "--year", "2026")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("show failed: %d %s", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["vendorId"] != "ven_1" || input["taxYear"] != float64(2026) {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxVendorSaveBuildsTheInputAndRetainsTheWrite(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxVendors.save": savedJSON}, &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runTax(t, server, "tax", "vendor", "save", "--name", "Jane Doe Design", "--payees", "jane doe; jane d ;",
		"--reporting", "yes", "--w9", "requested", "--w9-on", "2026-02-10", "--paid-by", "bank", "--classification", "none", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("save failed: %d %s", exit, out)
	}
	if sent[0].OperationID != id || !strings.Contains(diagnostics, "Retaining "+id) {
		t.Fatalf("the write was not retained under the identity: %+v %q", sent[0], diagnostics)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	keys, _ := input["payeeKeys"].([]any)
	if input["name"] != "Jane Doe Design" || len(keys) != 2 || keys[0] != "jane doe" || keys[1] != "jane d" ||
		input["reporting"] != "yes" || input["w9"] != "requested" || input["w9On"] != "2026-02-10" || input["paidBy"] != "bank" {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	// "none" clears a field that can be cleared: null on the wire, not the word.
	if value, present := input["classification"]; !present || value != nil {
		t.Fatalf("classification none must be null: %s", sent[0].Input)
	}
	for _, forbidden := range []string{"tin", "ssn", "ein"} {
		if _, present := input[forbidden]; present {
			t.Fatalf("a taxpayer identification number is never sent: %s", sent[0].Input)
		}
	}
}

func TestTaxVendorSaveChangesNeedTheVersionRead(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxVendors.save": savedJSON}, &sent)
	exit, _, _ := runTax(t, server, "tax", "vendor", "save", "--id", "ven_1", "--expected-version", "3", "--notes", "Referred by Sam")
	if exit != 0 {
		t.Fatalf("change failed: %d", exit)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["vendorId"] != "ven_1" || input["expectedVersion"] != float64(3) || input["notes"] != "Referred by Sam" || len(input) != 3 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxVendorRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxVendors.save": savedJSON, "taxVendors.list": vendorsJSON, "taxVendors.get": `{}`, "taxVendors.setAccounts": accountsSetJSON}, &sent)
	cases := map[string][]string{
		"list no year":             {"tax", "vendors"},
		"list unknown option":      {"tax", "vendors", "--year", "2026", "--tin", "1"},
		"list file without csv":    {"tax", "vendors", "--year", "2026", "--file", "payments"},
		"show no id":               {"tax", "vendor", "show", "--year", "2026"},
		"show no year":             {"tax", "vendor", "show", "ven_1"},
		"save no name":             {"tax", "vendor", "save", "--reporting", "yes"},
		"save id without version":  {"tax", "vendor", "save", "--id", "ven_1", "--notes", "x"},
		"save version without id":  {"tax", "vendor", "save", "--expected-version", "2", "--name", "X Co"},
		"save version not number":  {"tax", "vendor", "save", "--id", "ven_1", "--expected-version", "two", "--notes", "x"},
		"save nothing to change":   {"tax", "vendor", "save", "--id", "ven_1", "--expected-version", "1"},
		"save unknown option":      {"tax", "vendor", "save", "--name", "X Co", "--tin", "123-45-6789"},
		"save bare reporting":      {"tax", "vendor", "save", "--name", "X Co", "--reporting"},
		"vendor unknown verb":      {"tax", "vendor", "delete", "ven_1"},
		"accounts no verb":         {"tax", "accounts"},
		"accounts mark no account": {"tax", "accounts", "mark"},
		"accounts bad verb":        {"tax", "accounts", "toggle", "6030"},
		"accounts unknown option":  {"tax", "accounts", "mark", "6030", "--all"},
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

func TestTaxAccountsMarkAndUnmark(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxVendors.setAccounts": accountsSetJSON}, &sent)
	if exit, out, _ := runTax(t, server, "tax", "accounts", "mark", "6030", "6080"); exit != 0 {
		t.Fatalf("mark failed: %d %s", exit, out)
	}
	if exit, out, _ := runTax(t, server, "tax", "accounts", "unmark", "6080"); exit != 0 {
		t.Fatalf("unmark failed: %d %s", exit, out)
	}
	var first, second map[string]any
	_ = json.Unmarshal(sent[0].Input, &first)
	_ = json.Unmarshal(sent[1].Input, &second)
	add, _ := first["add"].([]any)
	remove, _ := second["remove"].([]any)
	if len(add) != 2 || add[0] != "6030" || add[1] != "6080" || len(remove) != 1 || remove[0] != "6080" {
		t.Fatalf("wrong inputs: %s %s", sent[0].Input, sent[1].Input)
	}
	if sent[0].OperationID == "" || sent[1].OperationID == "" || sent[0].OperationID == sent[1].OperationID {
		t.Fatalf("each write needs its own identity: %q %q", sent[0].OperationID, sent[1].OperationID)
	}
}

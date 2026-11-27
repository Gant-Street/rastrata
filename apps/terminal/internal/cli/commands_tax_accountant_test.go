package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// accountantPackJSON is an accountant pack as the service returns it: the files, with the manifest last.
func accountantPackJSON(t *testing.T) string {
	t.Helper()
	files := map[string]string{
		"README.md":                      "# Accountant pack\n",
		"chart-of-accounts.csv":          "Code,Name\r\n1000,Checking\r\n",
		"adjusting-entries-template.csv": "Entry,Date,Narration,Account,Debit,Credit\r\n",
		"manifest.json":                  "",
	}
	order := []string{"README.md", "chart-of-accounts.csv", "adjusting-entries-template.csv", "manifest.json"}
	listed := []map[string]any{}
	manifestFiles := []map[string]any{}
	for _, name := range order {
		content := files[name]
		listed = append(listed, map[string]any{
			"path": name, "mediaType": "text/csv; charset=utf-8", "description": "A file.",
			"bytes": len(content), "sha256": sum(content), "content": content,
		})
		if name != "manifest.json" {
			manifestFiles = append(manifestFiles, map[string]any{"path": name, "bytes": len(content), "sha256": sum(content)})
		}
	}
	manifest, _ := json.Marshal(map[string]any{"format": "rastrata-accountant-pack-v1", "files": manifestFiles})
	last := listed[len(listed)-1]
	last["content"] = string(manifest)
	last["bytes"] = len(manifest)
	last["sha256"] = sum(string(manifest))
	pack := map[string]any{
		"format": "rastrata-accountant-pack-v1", "folder": "rastrata-accountant-2026", "taxYear": 2026,
		"from": "2026-01-01", "to": "2026-12-31", "bookRevision": "9",
		"ledgerPopulationHash": taxHash, "tagMapHash": taxHash,
		"close": map[string]any{"state": "closed", "periods": 12, "closed": 12, "superseded": 0, "open": 0,
			"last": map[string]any{"periodId": "period-12", "label": "December 2026", "startsOn": "2026-12-01", "endsOn": "2026-12-31",
				"closingRevision": "120", "reportPopulationHash": taxHash},
			"statement": "Every period in this range is closed with a current close."},
		"files": listed, "manifestSha256": sum(string(manifest)),
		"journals": 3, "accounts": 12, "provenanceRead": true, "disclaimer": "Not tax advice.",
	}
	encoded, err := json.Marshal(pack)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestTaxAccountantWritesAFolderThatVerifies(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxAccountant.build": accountantPackJSON(t)}, &sent)
	destination := filepath.Join(t.TempDir(), "for-the-accountant")
	exit, out, diagnostics := runTax(t, server, "tax", "accountant", "--year", "2026", "--out", destination, "--from", "2026-01-01")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("accountant pack failed: %d %s %s", exit, out, diagnostics)
	}
	data, err := os.ReadFile(filepath.Join(destination, "adjusting-entries-template.csv"))
	if err != nil || string(data) != "Entry,Date,Narration,Account,Debit,Credit\r\n" {
		t.Fatalf("the template was changed on the way to disk: %q %v", data, err)
	}
	if !strings.Contains(out, `"files":4`) || !strings.Contains(diagnostics, "accountant pack is not tax advice") {
		t.Fatalf("summary or notice wrong: %s %q", out, diagnostics)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["taxYear"] != float64(2026) || input["from"] != "2026-01-01" || len(input) != 2 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
	// The same verification the year-end pack has checks this one against its manifest.
	if exit, out, _ := runTax(t, server, "tax", "verify-pack", destination); exit != 0 || !strings.Contains(out, `"ok":true`) {
		t.Fatalf("the accountant pack must verify: %d %s", exit, out)
	}
}

func TestTaxAccountantRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxAccountant.build": accountantPackJSON(t)}, &sent)
	existing := filepath.Join(t.TempDir(), "taken.zip")
	if err := os.WriteFile(existing, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]string{
		"no year":        {"tax", "accountant", "--out", "x"},
		"no destination": {"tax", "accountant", "--year", "2026"},
		"unknown option": {"tax", "accountant", "--year", "2026", "--out", "x", "--form", "scheduleC"},
		"existing zip":   {"tax", "accountant", "--year", "2026", "--out", existing},
		"bare option":    {"tax", "accountant", "--year", "2026", "--out"},
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

// previewJSON is the smallest adjusting-entry preview the contract accepts.
func previewJSON(entries string, counts string, canImport bool, problems string) string {
	can := "false"
	if canImport {
		can = "true"
	}
	return `{"fileName":"adj.csv","rows":4,"columns":["Entry","Date","Narration","Account","Debit","Credit"],"entries":[` + entries + `],` +
		`"counts":` + counts + `,"problems":[` + problems + `],"canImport":` + can + `,"previewHash":"` + taxHash + `","notice":"Importing saves drafts. Nothing is posted."}`
}

const entryNew = `{"entry":"AJE-1","firstRow":2,"date":"2026-12-31","narration":"Accrue","lines":[],"debit":"250.00","credit":"250.00","status":"new","sourceId":"taxadj-AJE-1","draft":null,"problems":[]}`
const countsNew = `{"entries":1,"lines":2,"new":1,"alreadyImported":0,"conflict":0,"invalid":0}`
const entryBad = `{"entry":"B1","firstRow":2,"date":"2026-12-31","narration":"Bad","lines":[],"debit":"0.00","credit":"0.00","status":"invalid","sourceId":"taxadj-B1","draft":null,` +
	`"problems":[{"severity":"error","code":"account_unknown","message":"\"9999\" is not an account code in the chart.","row":2,"entry":"B1","column":"Account"}]}`
const countsBad = `{"entries":1,"lines":2,"new":0,"alreadyImported":0,"conflict":0,"invalid":1}`
const entryOld = `{"entry":"AJE-1","firstRow":2,"date":"2026-12-31","narration":"Accrue","lines":[],"debit":"250.00","credit":"250.00","status":"already_imported","sourceId":"taxadj-AJE-1","draft":{"id":"d1","version":1,"status":"draft"},"problems":[]}`
const countsOld = `{"entries":1,"lines":2,"new":0,"alreadyImported":1,"conflict":0,"invalid":0}`

var importedJSON = `{"fileName":"adj.csv","created":[{"entry":"AJE-1","draftId":"d1","version":1}],"skipped":[],"previewHash":"` + taxHash +
	`","nextStep":"1 draft was saved.","disclaimer":"Not tax advice."}`

func writeCSV(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "adjustments.csv")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const fileText = "Entry,Date,Narration,Account,Debit,Credit\r\nAJE-1,2026-12-31,Accrue,6080,250.00,\r\nAJE-1,2026-12-31,Accrue,1000,,250.00\r\n"

func TestTaxAdjustmentsPreviewSendsTheFileAsTextAndSaysWhatItFound(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxAdjustments.preview": previewJSON(entryBad, countsBad, false, "")}, &sent)
	exit, out, diagnostics := runTax(t, server, "tax", "adjustments", "preview", writeCSV(t, fileText))
	if exit != 3 || !json.Valid([]byte(out)) {
		t.Fatalf("a preview with a problem must exit 3 and print the preview: %d %s", exit, out)
	}
	if !strings.Contains(diagnostics, "row 2, entry B1, Account") || !strings.Contains(diagnostics, "account_unknown") ||
		!strings.Contains(diagnostics, "Nothing would be imported") {
		t.Fatalf("the problem must be said with its place: %q", diagnostics)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["csv"] != fileText || input["fileName"] != "adjustments.csv" || len(input) != 2 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxAdjustmentsPreviewOfAGoodFileExitsZero(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxAdjustments.preview": previewJSON(entryNew, countsNew, true, "")}, &sent)
	exit, out, diagnostics := runTax(t, server, "tax", "adjustments", "preview", writeCSV(t, fileText))
	if exit != 0 || !strings.Contains(out, `"canImport":true`) || !strings.Contains(diagnostics, "1 new") {
		t.Fatalf("preview failed: %d %s %q", exit, out, diagnostics)
	}
	if len(sent) != 1 {
		t.Fatalf("a preview makes one read and writes nothing, sent %d", len(sent))
	}
}

func TestTaxAdjustmentsImportPreviewsFirstAndImportsWhatWasShown(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{
		"taxAdjustments.preview": previewJSON(entryNew, countsNew, true, ""),
		"taxAdjustments.import":  importedJSON,
	}, &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runTax(t, server, "tax", "adjustments", "import", writeCSV(t, fileText), "--operation-id", id)
	if exit != 0 || !strings.Contains(out, `"draftId":"d1"`) {
		t.Fatalf("import failed: %d %s %q", exit, out, diagnostics)
	}
	if len(sent) != 2 || sent[0].OperationID != "" || sent[1].OperationID != id {
		t.Fatalf("a preview, then a retained import under the identity: %+v", sent)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[1].Input, &input)
	if input["previewHash"] != taxHash || input["csv"] != fileText || input["fileName"] != "adjustments.csv" {
		t.Fatalf("the import must carry the preview it was shown: %s", sent[1].Input)
	}
	if !strings.Contains(diagnostics, "Retaining "+id) || !strings.Contains(diagnostics, "Nothing has been posted") {
		t.Fatalf("the identity and the reassurance must be said: %q", diagnostics)
	}
}

func TestTaxAdjustmentsImportStopsAtAProblemAndWhenThereIsNothingNew(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{
		"taxAdjustments.preview": previewJSON(entryBad, countsBad, false, ""),
		"taxAdjustments.import":  importedJSON,
	}, &sent)
	exit, _, diagnostics := runTax(t, server, "tax", "adjustments", "import", writeCSV(t, fileText))
	if exit != 3 || !strings.Contains(diagnostics, "Nothing was imported") {
		t.Fatalf("a file with a problem must not be imported: %d %q", exit, diagnostics)
	}
	if len(sent) != 1 {
		t.Fatalf("only the preview may be called when it found a problem, sent %d", len(sent))
	}
	var again []api.Request
	server = taxServer(t, map[string]string{
		"taxAdjustments.preview": previewJSON(entryOld, countsOld, false, ""),
		"taxAdjustments.import":  importedJSON,
	}, &again)
	exit, _, diagnostics = runTax(t, server, "tax", "adjustments", "import", writeCSV(t, fileText))
	if exit != 0 || !strings.Contains(diagnostics, "imported before") || len(again) != 1 {
		t.Fatalf("nothing new is said, and nothing is written: %d %q %d", exit, diagnostics, len(again))
	}
}

func TestTaxAdjustmentsReadsStandardInputAndRefusesWhatCannotBeRead(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxAdjustments.preview": previewJSON(entryNew, countsNew, true, "")}, &sent)
	cases := map[string][]string{
		"no verb":          {"tax", "adjustments"},
		"unknown verb":     {"tax", "adjustments", "post", "x.csv"},
		"no file":          {"tax", "adjustments", "preview"},
		"two files":        {"tax", "adjustments", "preview", "a.csv", "b.csv"},
		"a folder":         {"tax", "adjustments", "preview", t.TempDir()},
		"unknown option":   {"tax", "adjustments", "preview", "a.csv", "--force"},
		"template removed": {"tax", "adjustments", "template"},
	}
	for name, args := range cases {
		exit, out, _ := runTax(t, server, args...)
		if exit != 2 || !strings.Contains(out, "usage_error") {
			t.Errorf("%s: expected a usage error, got %d %s", name, exit, out)
		}
	}
	if exit, out, _ := runTax(t, server, "tax", "adjustments", "preview", filepath.Join(t.TempDir(), "missing.csv")); exit != 4 || !strings.Contains(out, "file_unreadable") {
		t.Errorf("a missing file is reported as unreadable: %d %s", exit, out)
	}
	if len(sent) != 0 {
		t.Fatalf("a refused command must not call the service, sent %d", len(sent))
	}
}

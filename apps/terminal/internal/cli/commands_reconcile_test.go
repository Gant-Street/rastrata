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

const hash64 = "0000000000000000000000000000000000000000000000000000000000000000"

// reconciliationJSON is a draft that satisfies the Reconciliation contract.
func reconciliationJSON(version int, status string) string {
	return `{"id":"d0d0d0d0-0000-4000-8000-000000000001","status":"` + status + `","version":` + strconv.Itoa(version) + `,` +
		`"account":{"id":"1000","code":"1000","name":"Checking","role":"asset","normalSide":"debit"},"currency":"USD",` +
		`"statementDate":"2026-01-31","statementBalance":"1190.00","openingBalance":"0.00","selectedCount":0,` +
		`"selectedTotal":"0.00","clearedBalance":"0.00","difference":"1190.00","canComplete":false,"bookBalance":"1190.00",` +
		`"selectionHash":"` + hash64 + `","stale":false,"snapshotRevision":"5","previous":null,"lines":[],"warnings":[],` +
		`"createdAt":"2026-10-03T12:00:00.000Z","updatedAt":"2026-10-03T12:00:00.000Z","completedAt":null,"recordHash":null,"previousHash":null,"void":null}`
}

const progressJSON = `{"id":"d0d0d0d0-0000-4000-8000-000000000001","version":4,"selectedCount":4,"selectedTotal":"1190.00","clearedBalance":"1190.00","difference":"0.00","canComplete":true,"selectionHash":"` + hash64 + `"}`

// reportJSON is the report on a finished reconciliation that satisfies the ReconcileReport contract: two
// cleared lines that add up to the statement balance, and one outstanding check whose text carries a
// terminal escape sequence. The books held 1165.00; less the -25.00 not on the statement is 1190.00.
// When file is true the reply carries the spreadsheet too, as it does when asked for csv.
func reportJSON(status string, file bool) string {
	void := `null`
	if status == "voided" {
		void = `{"id":"v1","reason":"Wrong statement\nentered","voidedAt":"2026-02-09T09:00:00.000Z","hash":"` + hash64 + `"}`
	}
	attached := ""
	if file {
		attached = `,"file":{"filename":"reconciliation-1000-2026-01-31.csv","mediaType":"text/csv; charset=utf-8","content":"Report,Reconciliation report\r\nState,Date\r\ncleared,2026-01-05\r\n"}`
	}
	return `{"id":"d0d0d0d0-0000-4000-8000-000000000001","status":"` + status + `",` +
		`"account":{"id":"1000","code":"1000","name":"Checking","role":"asset","normalSide":"debit"},"currency":"USD",` +
		`"statementDate":"2026-01-31","statementBalance":"1190.00","openingBalance":"0.00","previous":null,` +
		`"completedAt":"2026-02-02T10:00:00.000Z","recordHash":"` + hash64 + `","previousHash":null,"bookRevision":"9","void":` + void + `,` +
		`"cleared":{"count":2,"total":"1190.00","lines":[` +
		`{"postingId":"p1","journalId":"j1","date":"2026-01-05","narration":"Deposit","amount":"1200.00"},` +
		`{"postingId":"p2","journalId":"j2","date":"2026-01-20","narration":"Rent","amount":"-10.00"}]},` +
		`"outstanding":{"count":1,"total":"-25.00","lines":[` +
		`{"postingId":"p3","journalId":"j3","date":"2026-01-30","narration":"Check 101 \u001b[31mRED‮","amount":"-25.00"}]},` +
		`"bookBalance":"1165.00","difference":"0.00"` + attached + `}`
}

type sentRequest struct {
	Path    string
	Request api.Request
}

// reconcileServer answers the reconcile operations like the application and records what the CLI
// sent. status is the draft's lifecycle state; refuse makes completion fail like the service does.
func reconcileServer(t *testing.T, status string, refuse bool, sent *[]sentRequest) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, sentRequest{Path: r.URL.Path, Request: request})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/reconcile.get":
			envelope["data"] = json.RawMessage(reconciliationJSON(3, status))
		case "/v1/reconcile.start", "/v1/reconcile.setStatement", "/v1/reconcile.void":
			envelope["data"] = json.RawMessage(reconciliationJSON(1, "draft"))
		case "/v1/reconcile.setCleared":
			envelope["data"] = json.RawMessage(progressJSON)
		case "/v1/reconcile.complete":
			if refuse {
				w.WriteHeader(409)
				envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
					"error": map[string]any{"code": "reconcile_difference", "message": "The difference is -19.90.", "details": []any{}, "retryable": false}}
			} else {
				envelope["data"] = json.RawMessage(reconciliationJSON(4, "completed"))
			}
		case "/v1/reconcile.discard":
			envelope["data"] = json.RawMessage(`{"disposition":"discarded","id":"d0d0d0d0-0000-4000-8000-000000000001"}`)
		case "/v1/reconcile.list":
			envelope["data"] = json.RawMessage(`{"count":0,"page":1,"pageSize":25,"items":[]}`)
		case "/v1/reconcile.status":
			envelope["data"] = json.RawMessage(`{"bookRevision":"5","accounts":[]}`)
		case "/v1/reconcile.cleared":
			envelope["data"] = json.RawMessage(`{"postings":[]}`)
		case "/v1/reconcile.report":
			var asked map[string]any
			_ = json.Unmarshal(request.Input, &asked)
			if status == "draft" {
				w.WriteHeader(409)
				envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
					"error": map[string]any{"code": "reconcile_not_completed", "message": "A draft has no report.", "details": []any{}, "retryable": false}}
			} else {
				envelope["data"] = json.RawMessage(reportJSON(status, asked["file"] == "csv"))
			}
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runReconcile(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"reconcile"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

const draftID = "d0d0d0d0-0000-4000-8000-000000000001"

func TestReconcileStartSendsTheStatementExactlyAndRetainsTheIdentity(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", false, &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runReconcile(t, server, "start", "--account", "1000", "--date", "2026-01-31", "--balance", "-1190.00", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("start failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/reconcile.start" || sent[0].Request.OperationID != id {
		t.Fatalf("unexpected requests: %+v", sent)
	}
	var input map[string]string
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if input["accountId"] != "1000" || input["statementDate"] != "2026-01-31" || input["statementBalance"] != "-1190.00" {
		t.Fatalf("statement changed on the way: %v", input)
	}
	if !strings.Contains(diagnostics, id) {
		t.Fatal("the retained identity was not announced")
	}
}

func TestReconcileStartRefusesInexactAmountsAndMissingOptionsWithoutCallingTheService(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", false, &sent)
	for _, args := range [][]string{
		{"start", "--account", "1000", "--date", "2026-01-31", "--balance", "1190.5"},
		{"start", "--account", "1000", "--date", "2026-01-31", "--balance", "1,190.00"},
		{"start", "--account", "1000", "--date", "2026-01-31"},
		{"start", "--date", "2026-01-31", "--balance", "1.00"},
		{"start", "--account", "1000", "--date", "2026-01-31", "--balance", "1.00", "--tolerance", "0.01"},
		{"start", "--account"},
	} {
		exit, out, _ := runReconcile(t, server, args...)
		if exit != 2 || !json.Valid([]byte(out)) || !strings.Contains(out, "usage_error") && !strings.Contains(out, "invalid_input") {
			t.Fatalf("%v: want a usage error, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestReconcileSelectReadsTheVersionUnlessGivenAndNamesIt(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", false, &sent)
	exit, _, diagnostics := runReconcile(t, server, "select", draftID, "--all")
	if exit != 0 {
		t.Fatalf("select failed: %d", exit)
	}
	if len(sent) != 2 || sent[0].Path != "/v1/reconcile.get" || sent[1].Path != "/v1/reconcile.setCleared" {
		t.Fatalf("expected a read then a write: %+v", sent)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[1].Request.Input, &input)
	if input["reset"] != "all" || input["expectedVersion"] != float64(3) || input["id"] != draftID {
		t.Fatalf("unexpected input: %v", input)
	}
	if !strings.Contains(diagnostics, "current version 3") {
		t.Fatalf("the version used was not announced: %s", diagnostics)
	}
	// An explicit version is trusted as the reviewer's, and nothing is read first.
	sent = nil
	exit, _, _ = runReconcile(t, server, "select", draftID, "--add", "p1, p2,p3", "--remove", "p9", "--version", "7")
	if exit != 0 || len(sent) != 1 || sent[0].Path != "/v1/reconcile.setCleared" {
		t.Fatalf("explicit version still read first: %d %+v", exit, sent)
	}
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if input["expectedVersion"] != float64(7) || len(input["select"].([]any)) != 3 || len(input["deselect"].([]any)) != 1 {
		t.Fatalf("unexpected input: %v", input)
	}
}

func TestReconcileSelectNeedsAChangeAndCannotCombineAllWithNone(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", false, &sent)
	for _, args := range [][]string{
		{"select", draftID},
		{"select", draftID, "--all", "--none"},
		{"select", draftID, "--all", "--version", "zero"},
		{"select", "--all"},
	} {
		if exit, out, _ := runReconcile(t, server, args...); exit != 2 {
			t.Fatalf("%v: want exit 2, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestReconcileCompleteReportsARefusalAsAConflictAndNeverRetriesIt(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", true, &sent)
	exit, out, _ := runReconcile(t, server, "complete", draftID, "--version", "4")
	if exit != 3 || !strings.Contains(out, "reconcile_difference") || !strings.Contains(out, "-19.90") {
		t.Fatalf("a refused completion must exit 3 with the service's words: %d %s", exit, out)
	}
	if len(sent) != 1 {
		t.Fatalf("the refusal was retried: %+v", sent)
	}
	// A reconciliation that is not a draft is not offered for completion at all.
	sent = nil
	done := reconcileServer(t, "completed", false, &sent)
	exit, out, _ = runReconcile(t, done, "complete", draftID)
	if exit != 3 || !strings.Contains(out, "reconcile_not_open") || len(sent) != 1 {
		t.Fatalf("completing a completed record: %d %s %+v", exit, out, sent)
	}
}

func TestReconcileVoidNeedsAReasonAndSendsItVerbatim(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "completed", false, &sent)
	if exit, _, _ := runReconcile(t, server, "void", draftID); exit != 2 {
		t.Fatal("a void without a reason must be a usage error")
	}
	if exit, _, _ := runReconcile(t, server, "void", draftID, "--reason", "   "); exit != 2 {
		t.Fatal("a blank reason must be a usage error")
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
	reason := `Wrong statement; "March" not February & a=b`
	exit, _, _ := runReconcile(t, server, "void", draftID, "--reason", reason)
	if exit != 0 || len(sent) != 1 {
		t.Fatalf("void failed: %d %+v", exit, sent)
	}
	var input map[string]string
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if input["reason"] != reason || input["id"] != draftID {
		t.Fatalf("the reason changed on the way: %v", input)
	}
}

func TestReconcileStatementRefreshesWithTheDraftsOwnFigures(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", false, &sent)
	if exit, _, _ := runReconcile(t, server, "statement", draftID); exit != 0 {
		t.Fatal("refresh failed")
	}
	var input map[string]any
	_ = json.Unmarshal(sent[len(sent)-1].Request.Input, &input)
	if input["statementDate"] != "2026-01-31" || input["statementBalance"] != "1190.00" || input["expectedVersion"] != float64(3) {
		t.Fatalf("a refresh must keep the statement as it is: %v", input)
	}
	if exit, _, _ := runReconcile(t, server, "statement", draftID, "--balance", "1209.90", "--version", "3"); exit != 0 {
		t.Fatal("correction failed")
	}
	_ = json.Unmarshal(sent[len(sent)-1].Request.Input, &input)
	if input["statementBalance"] != "1209.90" || input["statementDate"] != "2026-01-31" {
		t.Fatalf("only the balance should change: %v", input)
	}
}

func TestReconcileReadsAndListsSendOnlyWhatWasAsked(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "draft", false, &sent)
	for _, args := range [][]string{
		{"status", "--account", "1000", "--all"},
		{"list", "--account", "1000", "--state", "voided", "--page", "2"},
		{"show", draftID},
		{"cleared", "j1", "j2"},
	} {
		if exit, out, _ := runReconcile(t, server, args...); exit != 0 || !json.Valid([]byte(out)) {
			t.Fatalf("%v: %d %s", args, exit, out)
		}
	}
	want := []string{"/v1/reconcile.status", "/v1/reconcile.list", "/v1/reconcile.get", "/v1/reconcile.cleared"}
	for i, path := range want {
		if sent[i].Path != path || sent[i].Request.OperationID != "" {
			t.Fatalf("reads must carry no identity: %+v", sent[i])
		}
	}
	var status map[string]any
	_ = json.Unmarshal(sent[0].Request.Input, &status)
	if status["accountId"] != "1000" || status["all"] != true {
		t.Fatalf("status input: %v", status)
	}
	var list map[string]any
	_ = json.Unmarshal(sent[1].Request.Input, &list)
	if list["status"] != "voided" || list["page"] != float64(2) {
		t.Fatalf("list input: %v", list)
	}
}

func TestReconcileCommandsAreListedInHelp(t *testing.T) {
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	runner.Run(context.Background(), []string{"help"})
	for _, name := range []string{"reconcile start", "reconcile status", "reconcile complete", "reconcile void", "reconcile report"} {
		if !strings.Contains(out.String(), name) {
			t.Fatalf("help does not list %q", name)
		}
	}
}

func TestReconcileReportReadsOneRecordAndPrintsTheEnvelope(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "completed", false, &sent)
	exit, out, _ := runReconcile(t, server, "report", draftID)
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("report failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/reconcile.report" || sent[0].Request.OperationID != "" {
		t.Fatalf("a report is one read with no identity: %+v", sent)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if len(input) != 1 || input["id"] != draftID {
		t.Fatalf("a report asks for the record and nothing else: %v", input)
	}
	var envelope struct {
		OK   bool                `json:"ok"`
		Data reconcileReportView `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil || !envelope.OK {
		t.Fatalf("not the service's envelope: %v %s", err, out)
	}
	if envelope.Data.Outstanding.Lines[0].Amount != "-25.00" || envelope.Data.BookBalance != "1165.00" {
		t.Fatalf("the figures changed on the way: %+v", envelope.Data)
	}
}

func TestReconcileReportTextSaysHowTheBooksReachTheStatementAndKeepsOutsideTextOutOfTheTerminal(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "voided", false, &sent)
	exit, out, _ := runReconcile(t, server, "report", draftID, "--format", "text")
	if exit != 0 {
		t.Fatalf("report failed: %d %s", exit, out)
	}
	for _, want := range []string{
		"Reconciliation report: 1000 Checking",
		"Statement ending 2026-01-31, balance 1190.00. Finished 2026-02-02T10:00:00.000Z at book revision 9.",
		"VOIDED 2026-02-09T09:00:00.000Z: Wrong statement entered",
		"The books on 2026-01-31, as they stood at revision 9: 1165.00",
		"Less 1 not yet on the statement (outstanding): -25.00",
		"Is the statement balance:  1190.00",
		"Cleared on this statement: 2, 1190.00 (the opening balance was 0.00; the difference is 0.00)",
		"  2026-01-05      1200.00  Deposit",
		"Outstanding on 2026-01-31: 1, -25.00",
		"  2026-01-30       -25.00  Check 101  [31mRED",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the text report does not say %q:\n%s", want, out)
		}
	}
	// The escape character and the right-to-left override in a bank's text never reach the terminal.
	if strings.ContainsRune(out, 0x1b) || strings.ContainsRune(out, 0x202e) {
		t.Fatalf("text from outside reached the terminal as it was written: %q", out)
	}
	if strings.Contains(out, "{") {
		t.Fatalf("the text form printed JSON: %s", out)
	}
}

func TestReconcileReportCsvAsksForTheFileAndPrintsItAsTheServiceMadeIt(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "completed", false, &sent)
	exit, out, _ := runReconcile(t, server, "report", draftID, "--format", "csv")
	if exit != 0 {
		t.Fatalf("report failed: %d %s", exit, out)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Request.Input, &input)
	if input["file"] != "csv" || input["id"] != draftID {
		t.Fatalf("csv was not asked for: %v", input)
	}
	if out != "Report,Reconciliation report\r\nState,Date\r\ncleared,2026-01-05\r\n" {
		t.Fatalf("the file was changed on the way: %q", out)
	}
}

func TestReconcileReportRefusesWhatItCannotSendAndPassesTheServicesRefusalOn(t *testing.T) {
	var sent []sentRequest
	server := reconcileServer(t, "completed", false, &sent)
	for _, args := range [][]string{
		{"report"},
		{"report", draftID, "extra"},
		{"report", draftID, "--as-of", "2026-01-31"},
		{"report", draftID, "--tolerance", "0.01"},
	} {
		if exit, out, _ := runReconcile(t, server, args...); exit != 2 {
			t.Fatalf("%v: want exit 2, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
	// A draft has no report: the service says so, and that is a conflict, not a failure of the command.
	drafts := reconcileServer(t, "draft", false, &sent)
	exit, out, _ := runReconcile(t, drafts, "report", draftID)
	if exit != 3 || !strings.Contains(out, "reconcile_not_completed") {
		t.Fatalf("a draft's report: %d %s", exit, out)
	}
}

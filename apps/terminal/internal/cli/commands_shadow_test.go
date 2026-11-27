package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const openingHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const planID = "0b4e2f7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b"

func openingReviewJSON(valid bool, name string) string {
	issues := `[]`
	if !valid {
		issues = `[{"severity":"error","code":"account_not_found","message":"That account is not in your chart.","row":3}]`
	}
	hash := `"` + openingHash + `"`
	source := `"opening-2026-11-01-0123456789ab"`
	if !valid {
		hash, source = "null", "null"
	}
	return `{"cutoverDate":"2026-11-01","entryDate":"2026-10-31","currency":"USD","valid":` + map[bool]string{true: "true", false: "false"}[valid] + `,` +
		`"lines":[{"accountId":"1000","code":"1000","name":` + jsonString(name) + `,"role":"asset","side":"debit","balance":"12000.00","debit":"12000.00","credit":"0.00"},` +
		`{"accountId":"2000","code":"2000","name":"Business credit card","role":"liability","side":"credit","balance":"523.10","debit":"0.00","credit":"523.10"}],` +
		`"offset":{"accountId":"3900","code":"3900","name":"Opening balance equity","debit":"0.00","credit":"11476.90","chosen":false},` +
		`"totals":{"enteredDebit":"12000.00","enteredCredit":"523.10","debit":"12000.00","credit":"12000.00","balanced":true},` +
		`"zeroBalances":0,"issues":` + issues + `,"contentHash":` + hash + `,"sourceId":` + source + `,"calendar":null,"recordedCutover":"2026-11-01","existing":{"status":"none"}}`
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func planJSON(valid bool) string {
	return `{"review":` + openingReviewJSON(true, "Business checking") + `,"draft":{"id":"d-1","version":1},"plan":{"disposition":"prepared","operationId":"` + planID + `","outcomeSequence":null,"diagnostics":[],"problems":[],` +
		`"planId":"` + planID + `","planHash":"` + openingHash + `","bookRevision":"3","kind":"postDraft","valid":` + map[bool]string{true: "true", false: "false"}[valid] + `,"effects":{"journals":[],"accounts":[],"periods":[]}}}`
}

const cutoverStateJSON = `{"cutover":{"cutoverDate":"2026-11-01","recordedAt":"2026-11-02T10:00:00.000Z","accountIds":["1000"],"by":"owner"},"forDate":"2026-11-01",` +
	`"opening":{"status":"planned","sourceId":"opening-2026-11-01-0123456789ab","planId":"` + planID + `","cutoverDate":"2026-11-01","entryDate":"2026-10-31","by":"owner"},` +
	`"accounts":[{"accountId":"1000","code":"1000","name":"Business checking","role":"asset","kind":"bank","reason":"cash","chosen":true,"hasSource":true},` +
	`{"accountId":"2000","code":"2000","name":"Business credit card","role":"liability","kind":"card","reason":null,"chosen":false,"hasSource":false}],` +
	`"sources":[{"provider":"csv","accountKey":"csv:1000","ledgerAccountId":"1000","account":"1000 Business checking","startOn":"2026-11-01","after":null,"action":"unchanged","excluded":2,"wouldExclude":0,"wouldRestore":0}],` +
	`"stripe":null,"locked":false,"notes":["No cutover date has been recorded yet."]}`

func checklistJSON(state string, name string) string {
	summary := map[string]string{"ready": "Ready to close October 2026.", "not_yet": "Not yet: 1 thing stands in the way of closing October 2026."}[state]
	blocking := `[]`
	if state != "ready" {
		blocking = `[{"code":"never_reconciled","section":"accounts","message":"1000 has not been reconciled to a statement yet.","accountId":"1000"}]`
	}
	return `{"asOf":"2026-11-05","bookRevision":"18","hasHistory":true,"currency":"USD","cutover":{"date":"2026-10-01","basis":"recorded"},"opening":{"status":"posted","journalId":"j-1","cutoverDate":"2026-10-01"},` +
		`"period":{"id":"period-10","label":"October 2026","startsOn":"2026-10-01","endsOn":"2026-10-31","status":"open","ended":true},` +
		`"verdict":{"state":"` + state + `","summary":"` + summary + `","blocking":` + blocking + `,"attention":[]},` +
		`"accounts":[{"accountId":"1000","code":"1000","name":` + jsonString(name) + `,"role":"asset","kind":"bank","reason":"cash","bookBalance":"10700.01","hasActivity":true,` +
		`"lastReconciliation":null,"throughPeriodEnd":false,"draft":null,"unreconciled":{"count":2,"oldestOn":"2026-10-25"},"uncleared":{"count":4,"total":"10700.01","oldestOn":"2026-10-01"},` +
		`"status":"blocked","reasons":[]}],"otherAccounts":[{"accountId":"1500","code":"1500","name":"Equipment","role":"asset","balance":"2000.00"}],"stripe":null,` +
		`"inbox":{"available":true,"waiting":2,"oldestOn":"2026-10-25","toReview":3},` +
		`"backups":{"available":true,"verifiedAt":"2026-11-04T09:00:00.000Z","ageHours":20,"limitHours":48,"drill":null},` +
		`"openPeriods":[],"shadowRun":{"required":2,"provenCount":1,"provenThrough":"2026-10-31","complete":false,"months":[]},"unavailable":[]}`
}

// shadowServer answers the shadow operations with canned data and records every request.
func shadowServer(t *testing.T, answers map[string]string, sent *[]sentRequest) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, sentRequest{Path: r.URL.Path, Request: request})
		answer, ok := answers[strings.TrimPrefix(r.URL.Path, "/v1/")]
		if !ok {
			w.WriteHeader(404)
			return
		}
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "data": json.RawMessage(answer)}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runShadow(t *testing.T, server string, stdin string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(stdin), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func inputOf(t *testing.T, request sentRequest) map[string]any {
	t.Helper()
	var input map[string]any
	if err := json.Unmarshal(request.Request.Input, &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestOpeningReviewSendsTheBalancesAndTheOffsetAndNoIdentity(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"opening.review": openingReviewJSON(true, "Business checking")}, &sent)
	exit, out, _ := runShadow(t, server, "", "opening", "review", "--date", "2026-11-01", "--balances", "1000=12000.00, 2000=523.10", "--offset", "3000")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("review failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/opening.review" || sent[0].Request.OperationID != "" {
		t.Fatalf("a review is a read: %+v", sent)
	}
	input := inputOf(t, sent[0])
	if input["cutoverDate"] != "2026-11-01" || input["offsetAccountId"] != "3000" {
		t.Fatalf("wrong input: %v", input)
	}
	balances := input["balances"].([]any)
	if len(balances) != 2 || balances[1].(map[string]any)["accountId"] != "2000" || balances[1].(map[string]any)["balance"] != "523.10" {
		t.Fatalf("wrong balances: %v", balances)
	}
}

func TestOpeningReviewReadsACSVFileOrStandardInput(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"opening.review": openingReviewJSON(true, "Business checking")}, &sent)
	file := filepath.Join(t.TempDir(), "balances.csv")
	if err := os.WriteFile(file, []byte("Code,Balance\n1000,100.00\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if exit, out, _ := runShadow(t, server, "", "opening", "review", "--date", "2026-11-01", "--csv", file); exit != 0 {
		t.Fatalf("file failed: %d %s", exit, out)
	}
	if exit, out, _ := runShadow(t, server, "Code,Balance\n2000,5.00\n", "opening", "review", "--date", "2026-11-01", "--csv", "-"); exit != 0 {
		t.Fatalf("stdin failed: %d %s", exit, out)
	}
	if inputOf(t, sent[0])["csv"] != "Code,Balance\n1000,100.00\n" || inputOf(t, sent[1])["csv"] != "Code,Balance\n2000,5.00\n" {
		t.Fatalf("the CSV text must be sent as it is: %v %v", inputOf(t, sent[0]), inputOf(t, sent[1]))
	}
}

func TestOpeningReviewRefusesBadUsageBeforeCallingTheService(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"opening.review": openingReviewJSON(true, "x")}, &sent)
	large := filepath.Join(t.TempDir(), "large.csv")
	if err := os.WriteFile(large, []byte(strings.Repeat("1000,1.00\n", 20000)), 0o600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "binary.csv")
	if err := os.WriteFile(binary, []byte{0xff, 0xfe, 0x00, 0x01}, 0o600); err != nil {
		t.Fatal(err)
	}
	cases := [][]string{
		{"opening", "review", "--balances", "1000=1.00"},
		{"opening", "review", "--date", "2026-11-01"},
		{"opening", "review", "--date", "2026-11-01", "--csv", "a.csv", "--balances", "1000=1.00"},
		{"opening", "review", "--date", "2026-11-01", "--balances", "1000"},
		{"opening", "review", "--date", "2026-11-01", "--balances", "=1.00"},
		{"opening", "review", "--date", "2026-11-01", "--balances", ","},
		{"opening", "review", "--date", "2026-11-01", "--csv", large},
		{"opening", "review", "--date", "2026-11-01", "--csv", binary},
		{"opening", "review", "--date", "2026-11-01", "--csv", filepath.Join(t.TempDir(), "missing.csv")},
		{"opening", "review", "--date", "2026-11-01", "--balances", "1000=1.00", "--typo", "x"},
		{"opening", "review", "extra", "--date", "2026-11-01", "--balances", "1000=1.00"},
	}
	for _, args := range cases {
		if exit, out, _ := runShadow(t, server, "", args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Errorf("%v: expected a usage error, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing may reach the service: %+v", sent)
	}
}

func TestOpeningReviewExitsWithRejectionWhenTheEntryIsNotValid(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"opening.review": openingReviewJSON(false, "x")}, &sent)
	exit, out, _ := runShadow(t, server, "", "opening", "review", "--date", "2026-11-01", "--balances", "9999=1.00")
	if exit != 3 || !strings.Contains(out, `"valid":false`) {
		t.Fatalf("an entry with errors is a rejection: %d %s", exit, out)
	}
	exit, out, _ = runShadow(t, server, "", "opening", "review", "--date", "2026-11-01", "--balances", "9999=1.00", "--format", "text")
	if exit != 3 || !strings.Contains(out, "Valid: no") || !strings.Contains(out, "row 3: That account is not in your chart.") {
		t.Fatalf("text must name the row: %d %s", exit, out)
	}
}

func TestOpeningReviewTextShowsTheEntryAndNeverPrintsControlCharacters(t *testing.T) {
	var sent []sentRequest
	hostile := "Checking\x1b[31m RED ‮\nsecond line"
	server := shadowServer(t, map[string]string{"opening.review": openingReviewJSON(true, hostile)}, &sent)
	exit, out, _ := runShadow(t, server, "", "opening", "review", "--date", "2026-11-01", "--balances", "1000=12000.00", "--format", "text")
	if exit != 0 {
		t.Fatalf("text failed: %d %s", exit, out)
	}
	for _, want := range []string{"Opening balances at the start of 2026-11-01 (USD)", "Entry dated: 2026-10-31", "12,000.00", "523.10", "Opening balance equity (offset)", "11,476.90", "balanced", "The offset line is calculated", "Valid: yes. Source opening-2026-11-01-0123456789ab"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.ContainsRune(out, 0x1b) || strings.ContainsRune(out, 0x202e) || strings.Contains(out, "second line\n") && strings.Contains(out, "\nsecond line") {
		t.Fatalf("an account name must never reach the terminal as control characters:\n%q", out)
	}
}

func TestOpeningPlanRetainsItsIdentityAndSaysHowToCommit(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"opening.plan": planJSON(true)}, &sent)
	exit, out, diagnostics := runShadow(t, server, "", "opening", "plan", "--date", "2026-11-01", "--balances", "1000=12000.00")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("plan failed: %d %s", exit, out)
	}
	if sent[0].Request.OperationID == "" || !strings.Contains(diagnostics, "Retaining "+sent[0].Request.OperationID) {
		t.Fatalf("a plan is a write and keeps its identity: %+v %s", sent, diagnostics)
	}
	if !strings.Contains(diagnostics, "Prepared, not posted") || !strings.Contains(diagnostics, "rastrata operations commit "+planID+" "+openingHash) {
		t.Fatalf("it must say how to commit: %s", diagnostics)
	}
	// An identity given by the caller is the one used, so a retry returns the first plan.
	exit, _, _ = runShadow(t, server, "", "opening", "plan", "--date", "2026-11-01", "--balances", "1000=12000.00", "--operation-id", "5e0c7a52-6a3a-4b8e-9f3d-5b7a1d2c3e4f")
	if exit != 0 || sent[1].Request.OperationID != "5e0c7a52-6a3a-4b8e-9f3d-5b7a1d2c3e4f" {
		t.Fatalf("the given identity must be used: %+v", sent)
	}
	exit, out, _ = runShadow(t, server, "", "opening", "plan", "--date", "2026-11-01", "--balances", "1000=12000.00", "--format", "text")
	if exit != 0 || !strings.Contains(out, "Commit it with: rastrata operations commit "+planID+" "+openingHash) {
		t.Fatalf("text plan: %d %s", exit, out)
	}
}

func TestOpeningPlanThatTheLedgerWouldRefuseExitsWithRejection(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"opening.plan": planJSON(false)}, &sent)
	if exit, _, _ := runShadow(t, server, "", "opening", "plan", "--date", "2026-11-01", "--balances", "1000=12000.00"); exit != 3 {
		t.Fatalf("an invalid plan is a rejection, got %d", exit)
	}
}

func TestCutoverSetNeedsADateAndKeepsItsIdentity(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{
		"cutover.set": `{"state":` + cutoverStateJSON + `,"excluded":2,"restored":0,"sourcesSet":1}`,
		"cutover.get": cutoverStateJSON,
	}, &sent)
	if exit, _, _ := runShadow(t, server, "", "cutover", "set"); exit != 2 {
		t.Fatalf("a date is required, got %d", exit)
	}
	if exit, _, _ := runShadow(t, server, "", "cutover", "set", "--date", "2026-11-01", "--accounts", " , "); exit != 2 {
		t.Fatalf("an empty account list is a usage error, got %d", exit)
	}
	exit, out, diagnostics := runShadow(t, server, "", "cutover", "set", "--date", "2026-11-01", "--accounts", "1000,1010")
	if exit != 0 || !json.Valid([]byte(out)) || sent[0].Request.OperationID == "" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatalf("set failed: %d %s %+v", exit, out, sent)
	}
	input := inputOf(t, sent[0])
	ids := input["accountIds"].([]any)
	if input["cutoverDate"] != "2026-11-01" || len(ids) != 2 || ids[0] != "1000" {
		t.Fatalf("wrong input: %v", input)
	}
	exit, out, _ = runShadow(t, server, "", "cutover", "set", "--date", "2026-11-01", "--format", "text")
	if exit != 0 || !strings.Contains(out, "1 statement sources start on it; 2 queued lines were set aside") {
		t.Fatalf("text set: %d %s", exit, out)
	}
	// The read takes a what-if and no identity, and says which date the sources were worked out for.
	whatIf := shadowServer(t, map[string]string{"cutover.get": strings.Replace(cutoverStateJSON, `"forDate":"2026-11-01"`, `"forDate":"2026-12-01"`, 1)}, &sent)
	exit, out, _ = runShadow(t, whatIf, "", "cutover", "show", "--date", "2026-12-01", "--accounts", "1000", "--format", "text")
	last := sent[len(sent)-1]
	if exit != 0 || last.Path != "/v1/cutover.get" || last.Request.OperationID != "" {
		t.Fatalf("show failed: %d %s %+v", exit, out, last)
	}
	for _, want := range []string{"Cutover date: 2026-11-01", "Worked out for: 2026-12-01 (not recorded)", "Opening entry: planned (dated 2026-10-31)", "[x] 1000", "[ ] 2000", "not suggested", "csv:1000", "Note: No cutover date has been recorded yet."} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestCutoverChecklistPrintsTheVerdictAndCheckMakesNotYetAFailure(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"cutover.checklist": checklistJSON("not_yet", "Business checking")}, &sent)
	exit, out, _ := runShadow(t, server, "", "cutover", "checklist", "--period", "period-10")
	if exit != 0 || !json.Valid([]byte(out)) || inputOf(t, sent[0])["periodId"] != "period-10" || sent[0].Request.OperationID != "" {
		t.Fatalf("checklist failed: %d %s %+v", exit, out, sent)
	}
	if exit, _, _ := runShadow(t, server, "", "cutover", "checklist", "--check"); exit != 3 {
		t.Fatalf("--check must fail when the month is not ready, got %d", exit)
	}
	if exit, _, _ := runShadow(t, server, "", "cutover", "checklist", "--check", "false"); exit != 0 {
		t.Fatalf("--check false is a plain read, got %d", exit)
	}
	if exit, _, _ := runShadow(t, server, "", "cutover", "checklist", "--check", "maybe"); exit != 2 {
		t.Fatalf("a bad --check is a usage error, got %d", exit)
	}
	exit, out, _ = runShadow(t, server, "", "cutover", "checklist", "--format", "text")
	if exit != 0 {
		t.Fatalf("text failed: %d", exit)
	}
	for _, want := range []string{"Not yet: 1 thing stands in the way of closing October 2026.", "In the way:", "1000 has not been reconciled to a statement yet.", "Accounts for October 2026 (2026-10-01 to 2026-10-31)", "never reconciled", "inbox 2, not on a statement 4", "Inbox: 2 lines dated through the period end waiting (3 in all)", "Backups: newest verified 2026-11-04T09:00:00.000Z; restore drill never run", "Shadow run: 1 of 2 month ends closed and reconciled", "Equipment", "2,000.00", "not against the old system"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// A hosted workspace keeps the history of the books itself, and the text says that and not that the backups could not be read.
	kept := strings.Replace(checklistJSON("ready", "Business checking"), `"backups":{"available":true,"verifiedAt":"2026-11-04T09:00:00.000Z","ageHours":20,"limitHours":48,"drill":null}`, `"backups":{"available":false,"keptByService":true,"verifiedAt":null,"ageHours":null,"limitHours":48,"drill":null}`, 1)
	hosted := shadowServer(t, map[string]string{"cutover.checklist": kept}, &sent)
	exit, out, _ = runShadow(t, hosted, "", "cutover", "checklist", "--format", "text")
	if exit != 0 || !strings.Contains(out, "Backups: this service keeps the history of the books itself; there is nothing to verify") || strings.Contains(out, "could not be read") {
		t.Fatalf("a service that keeps the history itself should say so: %d\n%s", exit, out)
	}
	ready := shadowServer(t, map[string]string{"cutover.checklist": checklistJSON("ready", "Business checking")}, &sent)
	if exit, _, _ := runShadow(t, ready, "", "cutover", "checklist", "--check"); exit != 0 {
		t.Fatalf("a ready month passes --check, got %d", exit)
	}
}

func TestShadowTextHelpers(t *testing.T) {
	for in, want := range map[string]string{"0.00": "0.00", "12000.00": "12,000.00", "-1234567.89": "-1,234,567.89", "999.99": "999.99", "1000.00": "1,000.00"} {
		if got := shadowGrouped(in); got != want {
			t.Errorf("grouped(%q) = %q, want %q", in, got, want)
		}
	}
	if got := shadowPlain("a\x1b[31mb\nc"); strings.ContainsAny(got, "\x1b\n") {
		t.Errorf("plain left a control character: %q", got)
	}
	if got := shadowClip("abcdefghij", 5); got != "abcd…" {
		t.Errorf("clip = %q", got)
	}
}

func TestShadowOpeningDetailSaysWhereTheEntryIsDatedAndThatItWasMadeByHand(t *testing.T) {
	date, yes := "2026-10-31", true
	for _, tc := range []struct {
		name    string
		opening api.OpeningExisting
		want    string
	}{
		{"nothing planned says nothing", api.OpeningExisting{Status: "none"}, ""},
		{"a dated entry", api.OpeningExisting{Status: "posted", EntryDate: &date}, " (dated 2026-10-31)"},
		{"an entry made by hand", api.OpeningExisting{Status: "posted", EntryDate: &date, ByHand: &yes}, " (dated 2026-10-31, entered by hand)"},
	} {
		if got := shadowOpeningDetail(tc.opening); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

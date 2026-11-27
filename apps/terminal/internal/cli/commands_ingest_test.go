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

type inboxRequest struct {
	Path        string
	OperationID string
	Input       map[string]any
}

const inboxCounts = `{"total":0,"new":0,"proposed":0,"drafted":0,"posted":0,"excluded":0,"toReview":0,"covered":0,"beforeCutover":0}`

const inboxItem = `{"id":"it_1","status":"new","line":{"kind":"bankLine","provider":"csv","accountKey":"csv:1000","rawIndex":0,"date":"2026-01-02","amount":"-4.50","currency":"USD","description":"COFFEE"},` +
	`"ledgerAccountId":null,"batchId":"bt_1","flags":[],"proposalCount":0,"ingestedAt":"2026-01-03T00:00:00.000Z"}`

// Minimal answers that satisfy each operation's output schema, as the application would send them.
var inboxAnswers = map[string]string{
	"/v1/inbox.list":    `{"items":[` + inboxItem + `],"count":1,"page":1,"pageSize":50,"counts":` + inboxCounts + `}`,
	"/v1/inbox.summary": `{"counts":` + inboxCounts + `,"sources":[],"unmapped":0,"oldestToReviewOn":null,"lastSubmittedAt":null}`,
	"/v1/inbox.sources": `{"sources":[]}`,
	"/v1/inbox.get": `{"item":` + inboxItem + `,"proposals":[],"proposalProblems":[],"coveredCount":0,"provenance":{"batchId":"bt_1","provider":"csv","accountKey":"csv:1000","rawIndex":0,` +
		`"rawSha256":"1111111111111111111111111111111111111111111111111111111111111111","rawMediaType":"text/csv","rawSize":10,"fetchedAt":"2026-01-03T00:00:00.000Z",` +
		`"submittedAt":"2026-01-03T00:00:00.000Z","evidenceReference":"ingest:bt_1:0","sourceEventId":"ingest-csv-abc"},"history":[]}`,
	"/v1/inbox.balanceChecks": `{"checks":[]}`,
	"/v1/inbox.configureSource": `{"source":{"provider":"csv","accountKey":"csv:1000","ledgerAccountId":"1000","startOn":"2026-01-01","counts":` + inboxCounts +
		`,"firstLineOn":null,"lastLineOn":null,"batches":0,"lastSubmittedAt":null},"excludedBeforeCutover":0,"restored":0}`,
}

const inboxReport = `{"results":[],"applied":0,"skipped":0,"failed":0,"remaining":0}`

// inboxServer answers each operation as the application would and records what the CLI sent.
func inboxServer(t *testing.T, sent *[]inboxRequest) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		var input map[string]any
		_ = json.Unmarshal(request.Input, &input)
		*sent = append(*sent, inboxRequest{Path: r.URL.Path, OperationID: request.OperationID, Input: input})
		answer, known := inboxAnswers[r.URL.Path]
		if !known {
			answer = inboxReport
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

func runInboxCLI(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"inbox"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func TestInboxListBuildsTheFilterAndPaging(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, out, _ := runInboxCLI(t, server, "list", "--status=new,proposed", "--text=coffee", "--min=10.00", "--direction=out", "--source=csv:1000", "--has-proposal=true", "--sort=amount_desc", "--page=2", "--page-size=25")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("list failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/inbox.list" || sent[0].OperationID != "" {
		t.Fatalf("unexpected request: %+v", sent)
	}
	filter, _ := sent[0].Input["filter"].(map[string]any)
	statuses, _ := filter["status"].([]any)
	if len(statuses) != 2 || statuses[0] != "new" || filter["text"] != "coffee" || filter["minAmount"] != "10.00" ||
		filter["direction"] != "out" || filter["accountKey"] != "csv:1000" || filter["hasProposal"] != true {
		t.Fatalf("filter changed on the way: %v", filter)
	}
	if sent[0].Input["sort"] != "amount_desc" || sent[0].Input["page"] != float64(2) || sent[0].Input["pageSize"] != float64(25) {
		t.Fatalf("paging changed on the way: %v", sent[0].Input)
	}
	// Amounts are decimal strings end to end, never numbers.
	if _, isString := filter["minAmount"].(string); !isString {
		t.Fatal("amount was not sent as a string")
	}
}

func TestInboxShowAndTheReadAliasesReachTheirOperations(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	for _, args := range [][]string{{"show", "it_1"}, {"summary"}, {"sources"}, {"balances", "--provider=csv"}} {
		if exit, out, _ := runInboxCLI(t, server, args...); exit != 0 {
			t.Fatalf("%v failed: %d %s", args, exit, out)
		}
	}
	paths := []string{}
	for _, request := range sent {
		paths = append(paths, request.Path)
	}
	if strings.Join(paths, " ") != "/v1/inbox.get /v1/inbox.summary /v1/inbox.sources /v1/inbox.balanceChecks" {
		t.Fatalf("wrong operations: %v", paths)
	}
	if sent[0].Input["itemId"] != "it_1" || sent[3].Input["provider"] != "csv" {
		t.Fatalf("inputs: %v %v", sent[0].Input, sent[3].Input)
	}
}

func TestInboxCategorizeByIdsOrFilterRetainsAnIdentity(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, _, diagnostics := runInboxCLI(t, server, "categorize", "it_1", "it_2", "--account=5100", "--narration=Team lunch")
	if exit != 0 {
		t.Fatal("categorize failed")
	}
	if !strings.Contains(diagnostics, "Retaining") || sent[0].OperationID == "" {
		t.Fatalf("a write must retain an identity: %q %+v", diagnostics, sent[0])
	}
	ids, _ := sent[0].Input["itemIds"].([]any)
	if len(ids) != 2 || sent[0].Input["accountId"] != "5100" || sent[0].Input["narration"] != "Team lunch" || sent[0].Input["filter"] != nil {
		t.Fatalf("input: %v", sent[0].Input)
	}
	exit, _, _ = runInboxCLI(t, server, "categorize", "--text=software", "--expect=20", "--limit=8", "--account=5000", "--operation-id", "11111111-1111-4111-8111-111111111111")
	if exit != 0 {
		t.Fatal("filter categorize failed")
	}
	last := sent[len(sent)-1]
	filter, _ := last.Input["filter"].(map[string]any)
	if filter["text"] != "software" || last.Input["expectedCount"] != float64(20) || last.Input["limit"] != float64(8) || last.OperationID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("filter input: %v id %s", last.Input, last.OperationID)
	}
}

func TestInboxCategorizeSplitsAreExactStringsAndNeedOneChoice(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, _, _ := runInboxCLI(t, server, "categorize", "it_1", "--split=5000=60.01,5100=39.99")
	if exit != 0 {
		t.Fatal("split categorize failed")
	}
	splits, _ := sent[0].Input["splits"].([]any)
	first, _ := splits[0].(map[string]any)
	if len(splits) != 2 || first["accountId"] != "5000" || first["amount"] != "60.01" {
		t.Fatalf("splits: %v", sent[0].Input)
	}
	for _, args := range [][]string{
		{"categorize", "it_1"},
		{"categorize", "it_1", "--account=5000", "--split=5000=1.00"},
		{"categorize", "it_1", "--split=nonsense"},
	} {
		if exit, out, _ := runInboxCLI(t, server, args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v should be a usage error: %d %s", args, exit, out)
		}
	}
}

func TestInboxActionsNeedAnExplicitSelectionAndNeverBothKinds(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	for _, args := range [][]string{
		{"post"},
		{"accept"},
		{"exclude", "--reason=x"},
		{"post", "it_1", "--text=coffee"},
		{"post", "--expect=abc", "--all"},
	} {
		if exit, _, _ := runInboxCLI(t, server, args...); exit != 2 {
			t.Fatalf("%v should be refused with a usage error", args)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing should have been sent: %+v", sent)
	}
	// --all is the explicit way to say "everything this action can act on".
	if exit, _, _ := runInboxCLI(t, server, "post", "--all", "--limit=10"); exit != 0 {
		t.Fatal("post --all failed")
	}
	filter, isFilter := sent[0].Input["filter"].(map[string]any)
	if !isFilter || len(filter) != 0 || sent[0].Input["limit"] != float64(10) {
		t.Fatalf("post --all: %v", sent[0].Input)
	}
}

func TestInboxAcceptSendsTheProposerAndThresholdNotAFilterOnIt(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, _, _ := runInboxCLI(t, server, "accept", "--status=proposed", "--proposer=stripe", "--min-confidence=90", "--chart-account=1000")
	if exit != 0 {
		t.Fatal("accept failed")
	}
	input := sent[0].Input
	filter, _ := input["filter"].(map[string]any)
	if input["proposer"] != "stripe" || input["minConfidence"] != float64(90) || filter["proposer"] != nil || filter["ledgerAccountId"] != "1000" {
		t.Fatalf("accept input: %v", input)
	}
	if exit, _, _ := runInboxCLI(t, server, "accept", "it_1", "--proposal=p_abc"); exit != 0 {
		t.Fatal("accept by proposal failed")
	}
	if sent[1].Input["proposalId"] != "p_abc" {
		t.Fatalf("proposal id: %v", sent[1].Input)
	}
}

func TestInboxAllowDuplicateIsABareOptionAndOffByDefault(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, _, _ := runInboxCLI(t, server, "accept", "it_1"); exit != 0 {
		t.Fatal("accept failed")
	}
	if _, set := sent[0].Input["allowDuplicate"]; set {
		t.Fatalf("a line already matched to a booked entry must not be booked again unless asked: %v", sent[0].Input)
	}
	if exit, _, _ := runInboxCLI(t, server, "accept", "it_1", "--allow-duplicate"); exit != 0 {
		t.Fatal("accept --allow-duplicate failed")
	}
	if sent[1].Input["allowDuplicate"] != true {
		t.Fatalf("accept: %v", sent[1].Input)
	}
	if exit, _, _ := runInboxCLI(t, server, "categorize", "it_1", "--account=5100", "--allow-duplicate"); exit != 0 {
		t.Fatal("categorize --allow-duplicate failed")
	}
	if sent[2].Input["allowDuplicate"] != true {
		t.Fatalf("categorize: %v", sent[2].Input)
	}
	// It is a switch, not a setting: a value is a usage error, and no other command takes it.
	for _, args := range [][]string{
		{"accept", "it_1", "--allow-duplicate=maybe"},
		{"categorize", "it_1", "--account=5100", "--allow-duplicate=no"},
		{"post", "it_1", "--allow-duplicate"},
		{"exclude", "it_1", "--reason=x", "--allow-duplicate"},
	} {
		if exit, _, _ := runInboxCLI(t, server, args...); exit != 2 {
			t.Fatalf("%v should be a usage error", args)
		}
	}
	if len(sent) != 3 {
		t.Fatalf("nothing more should have been sent: %d requests", len(sent))
	}
}

func TestInboxExcludeAndRestoreNeedAReason(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, _, _ := runInboxCLI(t, server, "exclude", "it_1"); exit != 2 {
		t.Fatal("exclude without a reason must be refused")
	}
	if exit, _, _ := runInboxCLI(t, server, "restore", "it_1", "--reason"); exit != 2 {
		t.Fatal("a bare --reason must be refused")
	}
	if exit, _, _ := runInboxCLI(t, server, "exclude", "it_1", "--reason=personal expense"); exit != 0 {
		t.Fatal("exclude failed")
	}
	if exit, _, _ := runInboxCLI(t, server, "restore", "it_1", "--reason=business after all"); exit != 0 {
		t.Fatal("restore failed")
	}
	if len(sent) != 2 || sent[0].Path != "/v1/inbox.exclude" || sent[0].Input["reason"] != "personal expense" || sent[1].Path != "/v1/inbox.restore" {
		t.Fatalf("requests: %+v", sent)
	}
}

func TestInboxSourceSetsTheChartAccountAndTheCutoverDate(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, _, _ := runInboxCLI(t, server, "source", "csv", "csv:1000"); exit != 2 {
		t.Fatal("a source change with nothing to change must be refused")
	}
	if exit, _, _ := runInboxCLI(t, server, "source", "csv", "csv:1000", "--account=1000", "--start-on=2026-01-01"); exit != 0 {
		t.Fatal("source failed")
	}
	input := sent[0].Input
	if sent[0].Path != "/v1/inbox.configureSource" || input["provider"] != "csv" || input["accountKey"] != "csv:1000" || input["ledgerAccountId"] != "1000" || input["startOn"] != "2026-01-01" {
		t.Fatalf("source input: %+v", sent[0])
	}
}

func TestInboxUnknownOptionsAreErrorsNotIgnored(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	for _, args := range [][]string{{"list", "--bogus=1"}, {"post", "--all", "--bogus"}, {"show"}, {"show", "a", "b"}} {
		if exit, _, _ := runInboxCLI(t, server, args...); exit != 2 {
			t.Fatalf("%v should be a usage error", args)
		}
	}
}

// The guide says to work with `covered: false`; the command line has to be able to say it, or a
// count of the lines an agent means to post never matches what the filter selects.
func TestInboxCoveredFilterLeavesOutTheLinesAPayoutBooks(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, out, _ := runInboxCLI(t, server, "list", "--status=drafted", "--covered=false"); exit != 0 {
		t.Fatalf("list failed: %d %s", exit, out)
	}
	if exit, out, _ := runInboxCLI(t, server, "post", "--status=drafted", "--covered=false", "--expect=41"); exit != 0 {
		t.Fatalf("post failed: %d %s", exit, out)
	}
	for _, request := range sent {
		filter, _ := request.Input["filter"].(map[string]any)
		if filter["covered"] != false {
			t.Fatalf("%s: the filter was %v", request.Path, filter)
		}
	}
	if sent[1].Input["expectedCount"] != float64(41) {
		t.Fatalf("expectedCount was %v", sent[1].Input["expectedCount"])
	}
	if exit, out, _ := runInboxCLI(t, server, "list", "--covered=maybe"); exit != 2 || !strings.Contains(out, "--covered must be true or false") {
		t.Fatalf("a bad value was accepted: %d %s", exit, out)
	}
	// A bare --covered reads true, as the other yes-or-no filter does.
	sent = nil
	if exit, _, _ := runInboxCLI(t, server, "list", "--covered=true"); exit != 0 {
		t.Fatal("covered=true refused")
	}
	if filter, _ := sent[0].Input["filter"].(map[string]any); filter["covered"] != true {
		t.Fatalf("filter %v", filter)
	}
}

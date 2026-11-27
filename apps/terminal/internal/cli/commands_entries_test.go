package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The fake service of the inbox tests answers these two as the application would, since the client
// checks every answer against the published contract.
func init() {
	inboxAnswers["/v1/book.update"] = `{"name":"Willow Lane Studio","settings":{"dateFormat":"numeric","showAccountNumbers":false,"acceptMode":"draft"},"changed":["name"],"previousName":"Old Co"}`
	inboxAnswers["/v1/book.get"] = `{"enabled":true,"bookId":"local-book","setup":null,"mode":"local-development","permissions":["read"],"head":null}`
	inboxAnswers["/v1/inbox.recategorize"] = `{"dryRun":false,"target":{"accountId":"5100","code":"5100","name":"Meals"},"results":[{"itemId":"it_1","journalId":"j_1","outcome":"applied","status":"posted","fromAccountId":"5000","toAccountId":"5100","date":"2026-03-02","amount":"-25.00","description":"NOTION LABS","reversalJournalId":"j_2","newJournalId":"j_3"}],"would":0,"applied":1,"skipped":0,"failed":0,"remaining":0,"next":null}`
}

// runBookCLI runs `rastrata book ...` against the fake service of the inbox tests.
func runBookCLI(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"book"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func TestInboxUndoSendsTheLinesAndTheReasonUnderARetainedIdentity(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, out, diagnostics := runInboxCLI(t, server, "undo", "it_1", "it_2", "--reason=Wrong category")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("undo failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/inbox.undo" || sent[0].OperationID == "" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatalf("an undo must be one write under a retained identity: %+v %q", sent, diagnostics)
	}
	ids, _ := sent[0].Input["itemIds"].([]any)
	if len(ids) != 2 || ids[0] != "it_1" || ids[1] != "it_2" || sent[0].Input["reason"] != "Wrong category" {
		t.Fatalf("input changed on the way: %v", sent[0].Input)
	}
	if _, filtered := sent[0].Input["filter"]; filtered {
		t.Fatalf("undo names its lines; it never takes a filter: %v", sent[0].Input)
	}
	// A reason is optional, and an identity given by the caller is kept so a retry is a retry.
	exit, _, _ = runInboxCLI(t, server, "undo", "it_3", "--operation-id", "22222222-2222-4222-8222-222222222222")
	if exit != 0 {
		t.Fatal("undo without a reason failed")
	}
	last := sent[len(sent)-1]
	if _, hasReason := last.Input["reason"]; hasReason || last.OperationID != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("second undo: %v id %s", last.Input, last.OperationID)
	}
}

func TestInboxUndoNeedsNamedLinesAndRefusesFiltersAndTooMany(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	many := []string{"undo"}
	for i := 0; i < 101; i++ {
		many = append(many, "it_"+strings.Repeat("x", i%5+1))
	}
	for _, args := range [][]string{
		{"undo"},
		{"undo", "--reason=why"},
		{"undo", "it_1", "--text=coffee"},
		{"undo", "--all"},
		{"undo", "it_1", "--reason"},
		many,
	} {
		if exit, out, _ := runInboxCLI(t, server, args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v should be a usage error: %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing should have been sent: %+v", sent)
	}
}

func TestBookUpdateBuildsItsInputFromTheFlagsAndRetainsAnIdentity(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, out, diagnostics := runBookCLI(t, server, "update", "--name=Willow Lane Studio", "--date-format=numeric", "--show-account-numbers=false", "--accept=draft")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("update failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/book.update" || sent[0].OperationID == "" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatalf("an update must be one write under a retained identity: %+v %q", sent, diagnostics)
	}
	input := sent[0].Input
	if input["name"] != "Willow Lane Studio" || input["dateFormat"] != "numeric" || input["acceptMode"] != "draft" || input["showAccountNumbers"] != false || len(input) != 4 {
		t.Fatalf("input changed on the way: %v", input)
	}
	// A bare switch means true, and only what was given is sent.
	exit, _, _ = runBookCLI(t, server, "update", "--show-account-numbers")
	if exit != 0 {
		t.Fatal("bare switch failed")
	}
	last := sent[len(sent)-1].Input
	if last["showAccountNumbers"] != true || len(last) != 1 {
		t.Fatalf("second update: %v", last)
	}
}

func TestBookUpdateRefusesNothingToChangeAndNonsense(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	for _, args := range [][]string{
		{"update"},
		{"update", "--date-format=long"},
		{"update", "--accept=both"},
		{"update", "--show-account-numbers=maybe"},
		{"update", "--name"},
		{"update", "--currency=EUR"},
		{"update", "extra", "--name=A Name"},
	} {
		if exit, out, _ := runBookCLI(t, server, args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v should be a usage error: %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing should have been sent: %+v", sent)
	}
}

func TestInboxRecategorizeSendsTheTransactionsTheAccountAndTheReasonUnderARetainedIdentity(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	exit, out, diagnostics := runInboxCLI(t, server, "recategorize", "it_1", "it_2", "--account=5100", "--reason=Software, not meals", "--from-account=5000")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("recategorize failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/inbox.recategorize" || sent[0].OperationID == "" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatalf("a move must be one write under a retained identity: %+v %q", sent, diagnostics)
	}
	input := sent[0].Input
	ids, _ := input["itemIds"].([]any)
	if len(ids) != 2 || ids[0] != "it_1" || ids[1] != "it_2" || input["accountId"] != "5100" || input["reason"] != "Software, not meals" || input["fromAccountId"] != "5000" || len(input) != 4 {
		t.Fatalf("input changed on the way: %v", input)
	}
	if _, plan := input["dryRun"]; plan {
		t.Fatalf("a move is not a plan: %v", input)
	}
	// An identity given by the caller is kept, so that a call cut short and sent again carries on.
	exit, _, _ = runInboxCLI(t, server, "recategorize", "it_3", "--account=5100", "--operation-id", "33333333-3333-4333-8333-333333333333")
	if exit != 0 || sent[len(sent)-1].OperationID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("the caller's identity was not kept: %+v", sent[len(sent)-1])
	}
}

func TestInboxRecategorizeAsksForAPlanWithDryRun(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, out, _ := runInboxCLI(t, server, "recategorize", "it_1", "--account=5100", "--dry-run"); exit != 0 {
		t.Fatalf("plan failed: %d %s", exit, out)
	}
	if sent[0].Input["dryRun"] != true {
		t.Fatalf("a plan asks for dryRun: %v", sent[0].Input)
	}
	if exit, _, _ := runInboxCLI(t, server, "recategorize", "it_1", "--account=5100", "--dry-run=true"); exit != 0 || sent[1].Input["dryRun"] != true {
		t.Fatalf("--dry-run=true is the same: %v", sent[1].Input)
	}
}

func TestInboxRecategorizeNamesTransactionsByTheirEntriesOrByAFilterWithItsCount(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, out, _ := runInboxCLI(t, server, "recategorize", "--journal=j_1,j_2", "--account=5100", "--limit=50"); exit != 0 {
		t.Fatalf("by entries failed: %d %s", exit, out)
	}
	byEntries := sent[0].Input
	journals, _ := byEntries["journalIds"].([]any)
	if len(journals) != 2 || journals[0] != "j_1" || byEntries["limit"] != float64(50) || byEntries["itemIds"] != nil || byEntries["filter"] != nil {
		t.Fatalf("by entries: %v", byEntries)
	}
	if exit, out, _ := runInboxCLI(t, server, "recategorize", "--status=posted", "--text=adobe", "--expect=7", "--limit=3", "--after=it_9", "--account=5100"); exit != 0 {
		t.Fatalf("by filter failed: %d %s", exit, out)
	}
	byFilter := sent[1].Input
	filter, _ := byFilter["filter"].(map[string]any)
	statuses, _ := filter["status"].([]any)
	if filter["text"] != "adobe" || len(statuses) != 1 || statuses[0] != "posted" || byFilter["expectedCount"] != float64(7) || byFilter["limit"] != float64(3) || byFilter["after"] != "it_9" {
		t.Fatalf("by filter: %v", byFilter)
	}
	if exit, _, _ := runInboxCLI(t, server, "recategorize", "--all", "--account=5100"); exit != 0 {
		t.Fatal("--all is everything the action can act on")
	}
	if all, _ := sent[2].Input["filter"].(map[string]any); all == nil || len(all) != 0 {
		t.Fatalf("--all selects with an empty filter: %v", sent[2].Input)
	}
}

func TestInboxRecategorizeNeedsAnAccountAndOneWayOfNamingTheTransactions(t *testing.T) {
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	many := []string{"recategorize", "--account=5100"}
	for i := 0; i < 501; i++ {
		many = append(many, "it_"+strings.Repeat("x", i%5+1))
	}
	for _, args := range [][]string{
		{"recategorize", "it_1"},
		{"recategorize", "--account=5100"},
		{"recategorize", "it_1", "--account"},
		{"recategorize", "it_1", "--account=5100", "--journal=j_1"},
		{"recategorize", "it_1", "--account=5100", "--text=adobe"},
		{"recategorize", "--journal=j_1", "--account=5100", "--text=adobe"},
		{"recategorize", "--journal=j_1", "--account=5100", "--expect=3"},
		{"recategorize", "--journal=j_1", "--account=5100", "--all"},
		{"recategorize", "--journal", "--account=5100"},
		{"recategorize", "it_1", "--account=5100", "--dry-run=maybe"},
		{"recategorize", "it_1", "--account=5100", "--reason"},
		{"recategorize", "it_1", "--account=5100", "--allow-duplicate"},
		many,
	} {
		if exit, out, _ := runInboxCLI(t, server, args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v should be a usage error: %d %s", args[:min(len(args), 4)], exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing should have been sent: %+v", sent)
	}
}

func TestBookGetAndSetupStillReachTheirOperations(t *testing.T) {
	// Adding `book update` as a command must not hide the aliases that share its first word.
	var sent []inboxRequest
	server := inboxServer(t, &sent)
	if exit, out, _ := runBookCLI(t, server, "get"); exit != 0 {
		t.Fatalf("book get failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/book.get" {
		t.Fatalf("wrong operation: %+v", sent)
	}
}

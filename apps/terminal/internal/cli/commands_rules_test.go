package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const rulesTestID = "9d9d9d9d-0000-4000-8000-000000000001"
const rulesOtherID = "9d9d9d9d-0000-4000-8000-000000000002"

type rulesSent struct {
	Path    string
	Request api.Request
}

func rulesRecordJSON(id, name string, revision int, status string, enabled bool) string {
	return `{"id":"` + id + `","status":"` + status + `","priority":1,"revision":` + strconv.Itoa(revision) + `,"name":"` + name + `","enabled":` + strconv.FormatBool(enabled) + `,` +
		`"accountIds":[],"match":"all","conditions":[{"field":"description","operator":"contains","value":"github"}],"groups":[],` +
		`"action":{"kind":"categorize","accountId":"6100"},"createdBy":{"kind":"person"},"createdAt":"2026-04-01T09:00:00.000Z",` +
		`"updatedBy":{"kind":"person"},"updatedAt":"2026-04-01T09:00:00.000Z","problems":[]}`
}

func rulesListJSON(revision int, ids ...string) string {
	records := make([]string, 0, len(ids))
	for _, id := range ids {
		records = append(records, rulesRecordJSON(id, "Rule "+id[len(id)-1:], 1, "active", true))
	}
	return `{"rulesRevision":` + strconv.Itoa(revision) + `,"count":` + strconv.Itoa(len(ids)) + `,"enabled":` + strconv.Itoa(len(ids)) +
		`,"orderedBy":null,"orderedAt":null,"window":null,"rules":[` + strings.Join(records, ",") + `]}`
}

const rulesSectionJSON = `{"considered":0,"matched":0,"applies":0,"shadowed":0,"unusable":0,"truncated":false,"samples":[]}`

const rulesStatusJSON = `{"config":{"enabled":true,"minAgreement":90,"minMargin":10,"minExamples":3,"minKnownWords":1},"ready":false,"examples":0,` +
	`"accounts":0,"vocabulary":0,"topAccounts":[],"sources":{"posted":0,"decisions":0},"heldBack":0,"modelVersion":0,"trainedAt":null,` +
	`"trainedThroughRevision":null,"evaluation":null,"notes":[]}`

const rulesRatioJSON = `{"numerator":0,"denominator":0,"basisPoints":null}`

const rulesInboxDetailJSON = `{"item":{"id":"item-1","status":"new","line":{"kind":"bankLine","provider":"csv","accountKey":"csv:1000","rawIndex":0,` +
	`"date":"2026-03-02","amount":"-4.00","currency":"USD","description":"GITHUB, INC. 8F2K3","counterparty":"GitHub"},` +
	`"ledgerAccountId":"1000","batchId":"b1","flags":[],"proposalCount":0,"ingestedAt":"2026-04-01T09:00:00.000Z",` +
	`"decision":{"kind":"categorize","by":"manual","at":"2026-04-02T09:00:00.000Z","legs":[{"accountId":"1000","amount":"-4.00"},{"accountId":"6100","amount":"4.00"}]}},` +
	`"proposals":[],"proposalProblems":[],"history":[],"provenance":{"batchId":"b1","provider":"csv","accountKey":"csv:1000","rawIndex":0,` +
	`"rawSha256":"0000000000000000000000000000000000000000000000000000000000000000","rawMediaType":"text/csv","rawSize":10,` +
	`"fetchedAt":"2026-04-01T00:00:00.000Z","submittedAt":"2026-04-01T00:00:00.000Z","evidenceReference":"ingest:b1:0","sourceEventId":"ingest-csv-x"}}`

// rulesServer answers the rules operations like the application and records what the CLI sent.
// `current` is the revision rules.get reports; `refuse` makes updates fail like a stale revision.
func rulesServer(t *testing.T, current int, refuse bool, sent *[]rulesSent) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, rulesSent{Path: r.URL.Path, Request: request})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/rules.list":
			envelope["data"] = json.RawMessage(rulesListJSON(7, rulesTestID, rulesOtherID))
		case "/v1/rules.get":
			var input map[string]any
			_ = json.Unmarshal(request.Input, &input)
			status := "active"
			if input["ruleId"] == rulesOtherID {
				status = "deleted"
			}
			envelope["data"] = json.RawMessage(`{"rule":` + rulesRecordJSON(rulesTestID, "GitHub", current, status, true) + `,"history":[{"revision":1,"madeBy":{"kind":"person"},"madeAt":"2026-04-01T09:00:00.000Z","changed":["created"]}]}`)
		case "/v1/rules.create", "/v1/rules.update", "/v1/rules.delete":
			if refuse && r.URL.Path != "/v1/rules.create" {
				w.WriteHeader(409)
				envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
					"error": map[string]any{"code": "rule_revision_conflict", "message": "This rule changed since you read it.", "details": []any{}, "retryable": false}}
			} else {
				envelope["data"] = json.RawMessage(rulesRecordJSON(rulesTestID, "GitHub", current+1, "active", true))
			}
		case "/v1/rules.reorder":
			envelope["data"] = json.RawMessage(rulesListJSON(8, rulesOtherID, rulesTestID))
		case "/v1/rules.test":
			envelope["data"] = json.RawMessage(`{"from":"2026-01-11","to":"2026-04-10","days":90,"problems":[],"position":1,"inbox":` + rulesSectionJSON + `,"history":` + rulesSectionJSON +
				`,"agreement":{"agreed":0,"differed":0,"notComparable":0},"lines":[],"notes":[]}`)
		case "/v1/rules.suggest":
			envelope["data"] = json.RawMessage(`{"rule":{"name":"Github","conditions":[{"field":"description","operator":"contains","value":"github"}],"action":{"kind":"categorize"}},"basis":null,"notes":[]}`)
		case "/v1/inbox.get":
			envelope["data"] = json.RawMessage(rulesInboxDetailJSON)
		case "/v1/classifier.status", "/v1/classifier.configure", "/v1/classifier.train":
			envelope["data"] = json.RawMessage(rulesStatusJSON)
		case "/v1/classifier.evaluate":
			envelope["data"] = json.RawMessage(`{"config":{"enabled":true,"minAgreement":90,"minMargin":10,"minExamples":3,"minKnownWords":1},"examples":0,"warmup":0,"scored":0,"proposed":0,"correct":0,` +
				`"precision":` + rulesRatioJSON + `,"recall":` + rulesRatioJSON + `,"coverage":` + rulesRatioJSON + `,"thresholds":[],"accounts":[],"confusions":[],"method":"none","computedAt":"2026-04-01T09:00:00.000Z"}`)
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runRulesCLI(t *testing.T, server string, stdin string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(stdin), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func rulesInput(t *testing.T, request rulesSent) map[string]any {
	t.Helper()
	var input map[string]any
	if err := json.Unmarshal(request.Request.Input, &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestRulesListSendsUsageAndWindowAndNeedsNoIdentity(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 3, false, &sent)
	exit, out, _ := runRulesCLI(t, server, "", "rules", "list", "--usage", "--days", "30")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("list failed: %d %s", exit, out)
	}
	input := rulesInput(t, sent[0])
	if sent[0].Path != "/v1/rules.list" || input["usage"] != true || input["days"] != float64(30) || sent[0].Request.OperationID != "" {
		t.Fatalf("unexpected request: %+v %v", sent[0], input)
	}
	sent = nil
	if exit, _, _ := runRulesCLI(t, server, "", "rules", "list", "--deleted"); exit != 0 || rulesInput(t, sent[0])["status"] != "deleted" {
		t.Fatal("--deleted did not ask for retired rules")
	}
	sent = nil
	for _, args := range [][]string{
		{"rules", "list", "--days", "0"},
		{"rules", "list", "--days", "366"},
		{"rules", "list", "--days"},
		{"rules", "list", "--bogus"},
		{"rules", "list", "extra"},
	} {
		if exit, out, _ := runRulesCLI(t, server, "", args...); exit != 2 || !strings.Contains(out, "usage_error") {
			t.Fatalf("%v: want a usage error, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestRulesCreateBuildsTheRuleFromFlagsAndSaysWhoMadeIt(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runRulesCLI(t, server, "", "rules", "create", "--name", "GitHub", "--contains", "github", "--direction", "out",
		"--min", "1.00", "--max", "99.99", "--category", "6100", "--narration", "Software: {merchant}", "--scope", "1000, 1100", "--agent", "claude-code", "--position", "2", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("create failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/rules.create" || sent[0].Request.OperationID != id || !strings.Contains(diagnostics, id) {
		t.Fatalf("identity not retained: %+v %s", sent, diagnostics)
	}
	input := rulesInput(t, sent[0])
	rule := input["rule"].(map[string]any)
	if rule["name"] != "GitHub" || input["position"] != float64(2) {
		t.Fatalf("unexpected input: %v", input)
	}
	madeBy := input["madeBy"].(map[string]any)
	if madeBy["kind"] != "agent" || madeBy["name"] != "claude-code" {
		t.Fatalf("an agent's rule was not recorded as one: %v", madeBy)
	}
	conditions := rule["conditions"].([]any)
	if len(conditions) != 3 {
		t.Fatalf("want text, direction and range conditions: %v", conditions)
	}
	action := rule["action"].(map[string]any)
	if action["kind"] != "categorize" || action["accountId"] != "6100" || action["narration"] != "Software: {merchant}" {
		t.Fatalf("unexpected action: %v", action)
	}
	if scope := rule["accountIds"].([]any); len(scope) != 2 || scope[1] != "1100" {
		t.Fatalf("scope not split: %v", scope)
	}
}

func TestRulesCreateSendsNoAuthorUnlessToldItIsAnAgentAndReadsTheEnvironment(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	t.Setenv("RASTRATA_AGENT", "")
	runRulesCLI(t, server, "", "rules", "create", "--name", "A", "--contains", "a", "--category", "6100")
	if _, said := rulesInput(t, sent[0])["madeBy"]; said {
		t.Fatalf("a caller that does not claim to be an agent sends no author; the service decides: %v", rulesInput(t, sent[0]))
	}
	sent = nil
	t.Setenv("RASTRATA_AGENT", "codex")
	runRulesCLI(t, server, "", "rules", "create", "--name", "A", "--contains", "a", "--category", "6100")
	if made := rulesInput(t, sent[0])["madeBy"].(map[string]any); made["kind"] != "agent" || made["name"] != "codex" {
		t.Fatalf("environment author not used: %v", made)
	}
}

func TestRulesCreateReadsASuggestionFromStdinSoOneCommandFeedsTheNext(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	suggestion := `{"version":"rastrata-application-v1","bookId":"local-book","ok":true,"data":{"rule":{"name":"Github","conditions":[{"field":"description","operator":"contains","value":"github"}],"action":{"kind":"categorize"}},"basis":null,"notes":[]}}`
	exit, out, _ := runRulesCLI(t, server, suggestion, "rules", "create", "--input", "-", "--category", "6100")
	if exit != 0 {
		t.Fatalf("create from a suggestion failed: %d %s", exit, out)
	}
	rule := rulesInput(t, sent[0])["rule"].(map[string]any)
	action := rule["action"].(map[string]any)
	if rule["name"] != "Github" || action["accountId"] != "6100" || len(rule["conditions"].([]any)) != 1 {
		t.Fatalf("the suggestion was not carried over with the account chosen on top: %v", rule)
	}
	// A bare rule object and a create input are accepted too.
	for _, text := range []string{
		`{"name":"B","conditions":[{"field":"description","operator":"contains","value":"b"}],"action":{"kind":"categorize","accountId":"6100"}}`,
		`{"rule":{"name":"C","conditions":[{"field":"description","operator":"contains","value":"c"}],"action":{"kind":"exclude"}},"madeBy":{"kind":"person"}}`,
	} {
		sent = nil
		if exit, out, _ := runRulesCLI(t, server, text, "rules", "create", "--input", "-"); exit != 0 || len(sent) != 1 {
			t.Fatalf("rule shape refused: %d %s", exit, out)
		}
	}
	for _, text := range []string{`not json`, `[]`, `{"nothing":"here"}`} {
		sent = nil
		if exit, _, _ := runRulesCLI(t, server, text, "rules", "create", "--input", "-"); exit != 2 || len(sent) != 0 {
			t.Fatalf("%q: want exit 2 and nothing sent, got %d %+v", text, exit, sent)
		}
	}
}

func TestRulesCreateRefusesBadFlagsWithoutCallingTheService(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	for _, args := range [][]string{
		{"rules", "create"},
		{"rules", "create", "--name", "A", "--contains"},
		{"rules", "create", "--name", "A", "--contains", "a", "--category", "6100", "--transfer", "1100"},
		{"rules", "create", "--name", "A", "--contains", "a", "--narration", "x"},
		{"rules", "create", "--name", "A", "--contains", "a", "--category", "6100", "--match", "some"},
		{"rules", "create", "--name", "A", "--contains", "a", "--category", "6100", "--position", "0"},
		{"rules", "create", "--name", "A", "--contains", "a", "--category", "6100", "--regex", ".*"},
		{"rules", "create", "--input", filepath.Join(t.TempDir(), "missing.json")},
	} {
		if exit, out, _ := runRulesCLI(t, server, "", args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v: want exit 2, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestRulesUpdateReadsTheRevisionUnlessGivenAndNamesIt(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 3, false, &sent)
	exit, _, diagnostics := runRulesCLI(t, server, "", "rules", "update", rulesTestID, "--name", "Renamed", "--category", "6200")
	if exit != 0 {
		t.Fatalf("update failed: %d", exit)
	}
	if len(sent) != 2 || sent[0].Path != "/v1/rules.get" || sent[1].Path != "/v1/rules.update" {
		t.Fatalf("expected a read then a write: %+v", sent)
	}
	input := rulesInput(t, sent[1])
	rule := input["rule"].(map[string]any)
	if input["expectedRevision"] != float64(3) || rule["name"] != "Renamed" || rule["action"].(map[string]any)["accountId"] != "6200" {
		t.Fatalf("unexpected input: %v", input)
	}
	if len(rule["conditions"].([]any)) != 1 || rule["enabled"] != true {
		t.Fatalf("an edit that names two fields lost the rest of the rule: %v", rule)
	}
	if !strings.Contains(diagnostics, "current revision 3") {
		t.Fatalf("the revision used was not announced: %s", diagnostics)
	}
	// An explicit revision is trusted as the reviewer's.
	sent = nil
	runRulesCLI(t, server, "", "rules", "update", rulesTestID, "--name", "Renamed", "--version", "2")
	if rulesInput(t, sent[len(sent)-1])["expectedRevision"] != float64(2) {
		t.Fatal("--version was not used")
	}
	// A whole new definition from a file replaces the stored one.
	file := filepath.Join(t.TempDir(), "rule.json")
	_ = os.WriteFile(file, []byte(`{"name":"From file","conditions":[{"field":"description","operator":"contains","value":"aws"}],"action":{"kind":"categorize","accountId":"6200"}}`), 0o600)
	sent = nil
	runRulesCLI(t, server, "", "rules", "update", rulesTestID, "--input", file)
	if rule := rulesInput(t, sent[len(sent)-1])["rule"].(map[string]any); rule["name"] != "From file" {
		t.Fatalf("the file did not replace the definition: %v", rule)
	}
}

func TestRulesUpdateReportsAStaleRevisionAsAConflictAndNeverRetriesIt(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 3, true, &sent)
	exit, out, _ := runRulesCLI(t, server, "", "rules", "update", rulesTestID, "--name", "X", "--version", "2")
	if exit != 3 || !strings.Contains(out, "rule_revision_conflict") {
		t.Fatalf("a stale revision must exit 3 with the service's code: %d %s", exit, out)
	}
	updates := 0
	for _, request := range sent {
		if request.Path == "/v1/rules.update" {
			updates++
		}
	}
	if updates != 1 {
		t.Fatalf("the refusal was retried: %+v", sent)
	}
	// A deleted rule is not edited.
	sent = nil
	exit, out, _ = runRulesCLI(t, rulesServer(t, 3, false, &sent), "", "rules", "update", rulesOtherID, "--name", "X")
	if exit != 3 || !strings.Contains(out, "rule_deleted") {
		t.Fatalf("editing a deleted rule: %d %s", exit, out)
	}
}

func TestRulesEnableAndDisableChangeOnlyTheSwitch(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 4, false, &sent)
	if exit, _, _ := runRulesCLI(t, server, "", "rules", "disable", rulesTestID, "--agent", "claude-code"); exit != 0 {
		t.Fatal("disable failed")
	}
	input := rulesInput(t, sent[1])
	rule := input["rule"].(map[string]any)
	if rule["enabled"] != false || rule["name"] != "GitHub" || input["expectedRevision"] != float64(4) || input["madeBy"].(map[string]any)["kind"] != "agent" {
		t.Fatalf("unexpected disable: %v", input)
	}
	sent = nil
	runRulesCLI(t, server, "", "rules", "enable", rulesTestID)
	if rulesInput(t, sent[1])["rule"].(map[string]any)["enabled"] != true {
		t.Fatal("enable did not switch the rule on")
	}
}

func TestRulesDeleteNeedsAReasonAndTheRevision(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 2, false, &sent)
	if exit, out, _ := runRulesCLI(t, server, "", "rules", "delete", rulesTestID); exit != 2 || !strings.Contains(out, "--reason") || len(sent) != 0 {
		t.Fatalf("delete without a reason: %d %s %+v", exit, out, sent)
	}
	exit, _, diagnostics := runRulesCLI(t, server, "", "rules", "delete", rulesTestID, "--reason", "Replaced by the Stripe rule")
	if exit != 0 || len(sent) != 2 || sent[1].Path != "/v1/rules.delete" {
		t.Fatalf("delete failed: %d %+v", exit, sent)
	}
	input := rulesInput(t, sent[1])
	if input["expectedRevision"] != float64(2) || input["reason"] != "Replaced by the Stripe rule" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatalf("unexpected delete: %v", input)
	}
}

func TestRulesMoveAndReorderSendTheWholeOrderWithTheRevisionRead(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	if exit, _, _ := runRulesCLI(t, server, "", "rules", "move", rulesTestID, "--to", "2"); exit != 0 {
		t.Fatal("move failed")
	}
	if len(sent) != 2 || sent[0].Path != "/v1/rules.list" || sent[1].Path != "/v1/rules.reorder" {
		t.Fatalf("expected a read then a write: %+v", sent)
	}
	input := rulesInput(t, sent[1])
	order := input["orderedRuleIds"].([]any)
	if input["expectedRulesRevision"] != float64(7) || len(order) != 2 || order[0] != rulesOtherID || order[1] != rulesTestID {
		t.Fatalf("unexpected order: %v", input)
	}
	// Moving past the end puts it last; moving to 1 puts it first.
	sent = nil
	runRulesCLI(t, server, "", "rules", "move", rulesOtherID, "--to", "9")
	if order := rulesInput(t, sent[1])["orderedRuleIds"].([]any); order[1] != rulesOtherID {
		t.Fatalf("move past the end: %v", order)
	}
	sent = nil
	if exit, out, _ := runRulesCLI(t, server, "", "rules", "move", "nope", "--to", "1"); exit != 3 || !strings.Contains(out, "rule_not_found") || len(sent) != 1 {
		t.Fatalf("moving an unknown rule: %d %s %+v", exit, out, sent)
	}
	sent = nil
	runRulesCLI(t, server, "", "rules", "reorder", rulesOtherID, rulesTestID)
	if order := rulesInput(t, sent[1])["orderedRuleIds"].([]any); len(order) != 2 || order[0] != rulesOtherID {
		t.Fatalf("reorder: %v", order)
	}
	for _, args := range [][]string{{"rules", "move", rulesTestID}, {"rules", "move", rulesTestID, "--to", "zero"}, {"rules", "reorder"}} {
		if exit, _, _ := runRulesCLI(t, server, "", args...); exit != 2 {
			t.Fatalf("%v: want exit 2", args)
		}
	}
}

func TestRulesTestAcceptsAStoredRuleOrAFileAndNamesTheWindow(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	if exit, _, _ := runRulesCLI(t, server, "", "rules", "test", rulesTestID, "--days", "30", "--samples", "3", "--as-of", "2026-04-10"); exit != 0 {
		t.Fatal("test failed")
	}
	input := rulesInput(t, sent[0])
	if sent[0].Path != "/v1/rules.test" || input["ruleId"] != rulesTestID || input["days"] != float64(30) || input["samples"] != float64(3) || input["asOf"] != "2026-04-10" {
		t.Fatalf("unexpected request: %v", input)
	}
	sent = nil
	draft := `{"name":"Draft","conditions":[{"field":"description","operator":"contains","value":"aws"}],"action":{"kind":"categorize","accountId":"6200"}}`
	if exit, _, _ := runRulesCLI(t, server, draft, "rules", "test", "--input", "-", "--position", "1"); exit != 0 {
		t.Fatal("testing a draft failed")
	}
	if input := rulesInput(t, sent[0]); input["rule"] == nil || input["position"] != float64(1) || input["ruleId"] != nil {
		t.Fatalf("unexpected draft test: %v", input)
	}
	if exit, _, _ := runRulesCLI(t, server, "", "rules", "test"); exit != 2 {
		t.Fatal("testing nothing must be a usage error")
	}
	// A line typed on the command line is tried too, and the two flags go together.
	sent = nil
	if exit, out, _ := runRulesCLI(t, server, "", "rules", "test", rulesTestID, "--try-description", "GITHUB, INC.", "--try-amount", "-4.00", "--try-counterparty", "GitHub", "--try-account", "1000", "--try-provider", "csv", "--try-reference", "R-1"); exit != 0 {
		t.Fatalf("try failed: %d %s", exit, out)
	}
	typed := rulesInput(t, sent[0])["lines"].([]any)[0].(map[string]any)
	if typed["description"] != "GITHUB, INC." || typed["amount"] != "-4.00" || typed["counterparty"] != "GitHub" || typed["accountId"] != "1000" || typed["provider"] != "csv" || typed["reference"] != "R-1" {
		t.Fatalf("unexpected typed line: %v", typed)
	}
	sent = nil
	for _, args := range [][]string{
		{"rules", "test", rulesTestID, "--try-description", "x"},
		{"rules", "test", rulesTestID, "--try-amount", "-1.00"},
		{"rules", "test", rulesTestID, "--try-description"},
	} {
		if exit, _, _ := runRulesCLI(t, server, "", args...); exit != 2 {
			t.Fatalf("%v: want exit 2", args)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestRulesSuggestTakesALineOrAnInboxItem(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	if exit, _, _ := runRulesCLI(t, server, "", "rules", "suggest", "--description", "GITHUB, INC.", "--amount", "-4.00", "--counterparty", "GitHub", "--category", "6100"); exit != 0 {
		t.Fatal("suggest failed")
	}
	input := rulesInput(t, sent[0])
	if input["description"] != "GITHUB, INC." || input["amount"] != "-4.00" || input["counterparty"] != "GitHub" || input["categoryAccountId"] != "6100" {
		t.Fatalf("unexpected suggest: %v", input)
	}
	sent = nil
	if exit, out, _ := runRulesCLI(t, server, "", "rules", "suggest", "--item", "item-1"); exit != 0 {
		t.Fatalf("suggest from an item failed: %d %s", exit, out)
	}
	if len(sent) != 2 || sent[0].Path != "/v1/inbox.get" || sent[1].Path != "/v1/rules.suggest" {
		t.Fatalf("expected the item to be read first: %+v", sent)
	}
	input = rulesInput(t, sent[1])
	if input["description"] != "GITHUB, INC. 8F2K3" || input["counterparty"] != "GitHub" || input["accountId"] != "1000" || input["categoryAccountId"] != "6100" {
		t.Fatalf("the item's line and chosen category were not carried over: %v", input)
	}
	sent = nil
	for _, args := range [][]string{{"rules", "suggest"}, {"rules", "suggest", "--description", "x"}, {"rules", "suggest", "--amount", "1.00"}} {
		if exit, _, _ := runRulesCLI(t, server, "", args...); exit != 2 {
			t.Fatalf("%v: want exit 2", args)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestClassifierCommandsSendTheThresholdsGivenAndNothingElse(t *testing.T) {
	var sent []rulesSent
	server := rulesServer(t, 1, false, &sent)
	if exit, _, _ := runRulesCLI(t, server, "", "classifier", "status"); exit != 0 || sent[0].Path != "/v1/classifier.status" {
		t.Fatal("status failed")
	}
	sent = nil
	if exit, _, _ := runRulesCLI(t, server, "", "classifier", "configure", "--min-agreement", "85", "--enabled", "false"); exit != 0 {
		t.Fatal("configure failed")
	}
	input := rulesInput(t, sent[0])
	if sent[0].Path != "/v1/classifier.configure" || input["minAgreement"] != float64(85) || input["enabled"] != false || len(input) != 2 || sent[0].Request.OperationID == "" {
		t.Fatalf("unexpected configure: %v", input)
	}
	sent = nil
	if exit, _, _ := runRulesCLI(t, server, "", "classifier", "evaluate", "--min-margin", "20"); exit != 0 {
		t.Fatal("evaluate failed")
	}
	if config := rulesInput(t, sent[0])["config"].(map[string]any); config["minMargin"] != float64(20) || len(config) != 1 {
		t.Fatalf("unexpected evaluate: %v", config)
	}
	sent = nil
	if exit, _, diagnostics := runRulesCLI(t, server, "", "classifier", "train"); exit != 0 || sent[0].Request.OperationID == "" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatal("train did not retain an identity")
	}
	sent = nil
	for _, args := range [][]string{
		{"classifier", "configure"},
		{"classifier", "configure", "--min-agreement", "high"},
		{"classifier", "configure", "--enabled", "maybe"},
		{"classifier", "configure", "--min-agreement"},
		{"classifier", "status", "extra"},
		{"classifier", "evaluate", "--enabled", "true"},
	} {
		if exit, _, _ := runRulesCLI(t, server, "", args...); exit != 2 {
			t.Fatalf("%v: want exit 2", args)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a malformed request reached the service: %+v", sent)
	}
}

func TestRulesCommandsAreListedInHelp(t *testing.T) {
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	if exit := runner.Run(context.Background(), []string{"help"}); exit != 0 {
		t.Fatalf("help failed: %d", exit)
	}
	for _, name := range []string{"rules list", "rules create", "rules test", "rules suggest", "rules move", "classifier status", "classifier train", "classifier evaluate"} {
		if !strings.Contains(out.String(), name) {
			t.Errorf("help does not list %q", name)
		}
	}
}

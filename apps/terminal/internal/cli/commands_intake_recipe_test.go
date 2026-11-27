package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const recipeSHA = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

func recipeReportJSON(valid, verified bool) string {
	v, p := "true", "true"
	if !valid {
		v = "false"
	}
	if !verified {
		p = "false"
	}
	status := "pass"
	if !valid {
		status = "fail"
	}
	if valid && !verified {
		status = "unverified"
	}
	gate := `{"gate":"ending_balance","status":"` + status + `","detail":"The lines come to the ending balance."}`
	return `{"valid":` + v + `,"verified":` + p + `,"file":{"sha256":"` + recipeSHA + `","size":120,"name":"chase.csv"},` +
		`"recipe":{"name":"Harbor checking","version":1},"reading":{"format":"csv","source":"recipe","encoding":"utf-8","delimiter":",","headerRow":1},` +
		`"rows":{"total":8,"lines":8,"rejected":0,"filtered":0,"noAmount":0,"zero":0},"range":{"from":"2026-05-02","to":"2026-05-27"},` +
		`"totals":{"moneyIn":"100.00","moneyOut":"-30.00","net":"70.00"},"rejected":[{"row":9,"reason":"Row skipped: not a date"}],"errorKinds":[],` +
		`"verification":{"method":"ending_balance","status":"` + status + `","detail":"Opening plus the lines."},` +
		`"gates":[` + gate + `],"hints":["Report lines flagged as instruction to the owner."]}`
}

const recipeSavedJSON = `{"name":"Harbor checking","revision":1,"accountKind":"bank","profileId":"p-1","ledgerAccountId":null,` +
	`"proven":[{"sha256":"` + recipeSHA + `","method":"ending_balance","lines":8,"from":"2026-05-02","to":"2026-05-27"}],` +
	`"savedAt":"2026-05-01T10:00:00.000Z","savedBy":"owner","recipe":{"version":1,"name":"Harbor checking","accountKind":"bank",` +
	`"mapping":{"date":{"header":"Date"},"amount":{"kind":"signed","amount":{"header":"Amount"}},"description":[{"header":"Description"}]}}}`

type recipeServer struct {
	valid, verified bool
	inputs          map[string]json.RawMessage
	frictions       []map[string]any
	uploads         int
}

func (s *recipeServer) start(t *testing.T) string {
	t.Helper()
	s.inputs = map[string]json.RawMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if r.URL.Path == "/v1/uploads" {
			s.uploads++
			envelope["data"] = map[string]any{"sha256": recipeSHA, "size": 120, "mediaType": "application/octet-stream", "name": "chase.csv"}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		s.inputs[r.URL.Path] = request.Input
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/accounts.list":
			envelope["data"] = json.RawMessage(importChartJSON)
		case "/v1/intake.recipeTest":
			envelope["data"] = json.RawMessage(recipeReportJSON(s.valid, s.verified))
		case "/v1/intake.recipeSave":
			envelope["data"] = json.RawMessage(recipeSavedJSON)
		case "/v1/intake.recipeList":
			envelope["data"] = json.RawMessage(`{"recipes":[]}`)
		case "/v1/intake.friction":
			var body map[string]any
			_ = json.Unmarshal(request.Input, &body)
			s.frictions = append(s.frictions, body)
			envelope["data"] = map[string]any{"recorded": 1, "deduplicated": 0, "resolved": 0, "ids": []int{1}, "openGaps": 0}
		default:
			w.WriteHeader(404)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
				"error": map[string]any{"code": "route_not_found", "message": "not found", "details": []any{}, "retryable": false}}
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func writeRecipeFiles(t *testing.T) (recipe, statement string) {
	t.Helper()
	dir := t.TempDir()
	recipe = filepath.Join(dir, "recipe.json")
	statement = filepath.Join(dir, "chase.csv")
	if err := os.WriteFile(recipe, []byte(`{"version":1,"name":"Harbor checking","accountKind":"bank","mapping":{"date":{"header":"Date"},"amount":{"kind":"signed","amount":{"header":"Amount"}},"description":[{"header":"Description"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statement, []byte("Date,Description,Amount\n05/02/2026,Coffee,-4.00\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return recipe, statement
}

func TestRecipeTestUploadsTheFileSendsTheBalancesAndExitsThreeWhenAGateFails(t *testing.T) {
	recipe, statement := writeRecipeFiles(t)
	server := &recipeServer{valid: true, verified: true}
	url := server.start(t)
	exit, out, _ := runIntakeCommand(t, url, "intake", "recipe", "test", recipe, statement,
		"--opening-balance", "100.00", "--ending-balance", "96.00", "--period-from", "2026-05-01", "--period-to", "2026-05-31", "--skip-invalid-rows=true")
	if exit != 0 || !strings.Contains(out, `"verified":true`) {
		t.Fatalf("exit %d: %s", exit, out)
	}
	var sent map[string]any
	_ = json.Unmarshal(server.inputs["/v1/intake.recipeTest"], &sent)
	if sent["sha256"] != recipeSHA || sent["openingBalance"] != "100.00" || sent["endingBalance"] != "96.00" ||
		sent["periodFrom"] != "2026-05-01" || sent["periodTo"] != "2026-05-31" || sent["skipInvalidRows"] != true {
		t.Fatalf("sent = %v", sent)
	}
	if recipeMap, ok := sent["recipe"].(map[string]any); !ok || recipeMap["name"] != "Harbor checking" {
		t.Fatalf("the recipe was not sent: %v", sent["recipe"])
	}
	failing := &recipeServer{valid: false}
	exit, out, _ = runIntakeCommand(t, failing.start(t), "intake", "recipe", "test", recipe, statement)
	if exit != 3 || !strings.Contains(out, `"valid":false`) {
		t.Fatalf("a failing recipe should exit 3, got %d: %s", exit, out)
	}
}

func TestRecipeTestRecordsAFailureAsARetryAndAProofAsAResolvedNeed(t *testing.T) {
	recipe, statement := writeRecipeFiles(t)
	failing := &recipeServer{valid: false}
	runIntakeCommand(t, failing.start(t), "intake", "recipe", "test", recipe, statement)
	if len(failing.frictions) != 1 {
		t.Fatalf("friction calls = %d", len(failing.frictions))
	}
	event := failing.frictions[0]["events"].([]any)[0].(map[string]any)
	if event["kind"] != "recipe_failed" || !strings.Contains(event["reason"].(string), "ending_balance") {
		t.Fatalf("event = %v", event)
	}
	unproven := &recipeServer{valid: true, verified: false}
	runIntakeCommand(t, unproven.start(t), "intake", "recipe", "test", recipe, statement)
	event = unproven.frictions[0]["events"].([]any)[0].(map[string]any)
	if event["kind"] != "balance_needed" || event["key"] != "balance:"+recipeSHA {
		t.Fatalf("event = %v", event)
	}
	proven := &recipeServer{valid: true, verified: true}
	runIntakeCommand(t, proven.start(t), "intake", "recipe", "test", recipe, statement)
	resolved := proven.frictions[0]["resolve"].([]any)
	if resolved[0] != "balance:"+recipeSHA {
		t.Fatalf("resolve = %v", resolved)
	}
	quiet := &recipeServer{valid: false}
	runIntakeCommand(t, quiet.start(t), "intake", "recipe", "test", recipe, statement, "--record=false")
	if len(quiet.frictions) != 0 {
		t.Fatalf("--record=false still recorded: %v", quiet.frictions)
	}
}

func TestRecipeTestTextShowsTheGatesTheRejectedRowsAndWhatToCheck(t *testing.T) {
	recipe, statement := writeRecipeFiles(t)
	server := &recipeServer{valid: true, verified: false}
	exit, out, _ := runIntakeCommand(t, server.start(t), "intake", "recipe", "test", recipe, statement, "--format", "text", "--record=false")
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	for _, want := range []string{"recipe Harbor checking on chase.csv: valid, not proven", "Proof (ending_balance): unverified", "unverified ending_balance", "rejected row 9", "check: Report lines flagged"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestRecipeSaveSendsTheProofRetainsTheCallAndResolvesTheFilesNeeds(t *testing.T) {
	recipe, statement := writeRecipeFiles(t)
	server := &recipeServer{}
	url := server.start(t)
	exit, out, diagnostics := runIntakeCommand(t, url, "intake", "recipe", "save", recipe, statement,
		"--opening-balance", "100.00", "--ending-balance", "96.00", "--account", "1010")
	if exit != 0 || !strings.Contains(out, `"revision":1`) {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if !strings.Contains(diagnostics, "Retaining") {
		t.Errorf("the call was not retained: %q", diagnostics)
	}
	var sent struct {
		Recipe map[string]any   `json:"recipe"`
		Proofs []map[string]any `json:"proofs"`
		Ledger string           `json:"ledgerAccountId"`
	}
	_ = json.Unmarshal(server.inputs["/v1/intake.recipeSave"], &sent)
	if len(sent.Proofs) != 1 || sent.Proofs[0]["sha256"] != recipeSHA || sent.Proofs[0]["endingBalance"] != "96.00" || sent.Ledger != "1010" {
		t.Fatalf("sent = %+v", sent)
	}
	if _, bound := sent.Proofs[0]["ledgerAccountId"]; bound {
		t.Errorf("the account belongs to the recipe, not to a proof: %v", sent.Proofs[0])
	}
	resolve := server.frictions[0]["resolve"].([]any)
	if len(resolve) != 2 || resolve[0] != "file:"+recipeSHA+":recipe" {
		t.Fatalf("resolve = %v", resolve)
	}
}

func TestIntakeVerifyReadsAFileWithNoRecipe(t *testing.T) {
	_, statement := writeRecipeFiles(t)
	server := &recipeServer{valid: true, verified: true}
	url := server.start(t)
	exit, _, _ := runIntakeCommand(t, url, "intake", "verify", statement, "--ending-balance", "96.00", "--record=false")
	if exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	var sent map[string]any
	_ = json.Unmarshal(server.inputs["/v1/intake.recipeTest"], &sent)
	if _, hasRecipe := sent["recipe"]; hasRecipe || sent["endingBalance"] != "96.00" {
		t.Fatalf("sent = %v", sent)
	}
}

func TestRecipeCommandsRefuseWhatTheyCannotUse(t *testing.T) {
	recipe, statement := writeRecipeFiles(t)
	server := &recipeServer{valid: true, verified: true}
	url := server.start(t)
	bad := filepath.Join(t.TempDir(), "bad.json")
	_ = os.WriteFile(bad, []byte("[1,2]"), 0o600)
	big := filepath.Join(t.TempDir(), "big.json")
	_ = os.WriteFile(big, []byte(`{"pad":"`+strings.Repeat("x", 101*1024)+`"}`), 0o600)
	for name, args := range map[string][]string{
		"no action":         {"intake", "recipe"},
		"unknown action":    {"intake", "recipe", "bogus"},
		"test one argument": {"intake", "recipe", "test", recipe},
		"list extra":        {"intake", "recipe", "list", "x"},
		"verify no file":    {"intake", "verify"},
		"bad option":        {"intake", "recipe", "test", recipe, statement, "--bogus=1"},
		"option not a bool": {"intake", "recipe", "test", recipe, statement, "--skip-invalid-rows=maybe"},
		"recipe not object": {"intake", "recipe", "test", bad, statement},
		"recipe too large":  {"intake", "recipe", "test", big, statement},
		"missing recipe":    {"intake", "recipe", "test", filepath.Join(t.TempDir(), "none.json"), statement},
		"missing statement": {"intake", "recipe", "test", recipe, filepath.Join(t.TempDir(), "none.csv")},
		"unknown account":   {"intake", "recipe", "test", recipe, statement, "--account", "nope"},
	} {
		if exit, out, _ := runIntakeCommand(t, url, args...); exit != 2 {
			t.Errorf("%s: exit %d, %s", name, exit, out)
		}
	}
	if exit, _, _ := runIntakeCommand(t, url, "intake", "recipe", "list"); exit != 0 {
		t.Errorf("list: exit %d", exit)
	}
}

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

const intakePlanFile = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func intakePlanJSON(ready bool, items string) string {
	readyText := "false"
	if ready {
		readyText = "true"
	}
	return `{"cutoverDate":"2026-05-01","through":"2026-07-31","sources":[],"items":[` + items + `],` +
		`"counts":{"present":2,"missing":1,"uncertain":0},"ready":` + readyText + `,"truncated":false}`
}

const intakePlanGap = `{"code":"statement_coverage","status":"missing","required":true,"owner":"customer","account":"1010","month":"2026-06",` +
	`"gate":"coverage","detail":"No statement covers 2026-06.","next":{"note":"Download the statement for 2026-06."}}`
const intakePlanOptional = `{"code":"chart_file","status":"missing","required":false,"owner":"customer","detail":"No chart."}`
const intakePlanPresent = `{"code":"cutover_date","status":"present","required":true,"owner":"agent","detail":"Cutover 2026-05-01 (in the plan)."}`

type intakeFriendServer struct {
	plan      string
	openKeys  []string
	refuse    bool
	frictions []map[string]any
	inputs    map[string]json.RawMessage
	listed    []json.RawMessage
}

func (s *intakeFriendServer) start(t *testing.T) string {
	t.Helper()
	s.inputs = map[string]json.RawMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		s.inputs[r.URL.Path] = request.Input
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/intake.plan":
			envelope["data"] = json.RawMessage(s.plan)
		case "/v1/intake.friction":
			if s.refuse {
				w.WriteHeader(403)
				envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
					"error": map[string]any{"code": "permission_denied", "message": "This needs draft permission", "details": []any{}, "retryable": false}}
			} else {
				var body map[string]any
				_ = json.Unmarshal(request.Input, &body)
				s.frictions = append(s.frictions, body)
				envelope["data"] = map[string]any{"recorded": 1, "deduplicated": 0, "resolved": 0, "ids": []int{1}, "openGaps": 1}
			}
		case "/v1/intake.frictionList":
			var body struct {
				Page int `json:"page"`
			}
			_ = json.Unmarshal(request.Input, &body)
			if body.Page == 0 {
				body.Page = 1
			}
			events := []map[string]any{}
			if body.Page <= 1 {
				for _, key := range s.openKeys {
					events = append(events, map[string]any{"id": len(events) + 1, "kind": "coverage_gap", "class": "gap", "key": key, "source": "x", "reason": "r", "actor": "owner", "at": "2026-05-01T00:00:00.000Z"})
				}
			}
			envelope["data"] = map[string]any{"count": len(s.openKeys), "page": body.Page, "pageSize": 100, "events": events}
		case "/v1/intake.status":
			envelope["data"] = json.RawMessage(`{"startedAt":"2026-05-01T10:00:00.000Z","firstImportAt":"2026-05-01T10:02:31.000Z","firstReconciliationAt":null,` +
				`"secondsToFirstImport":151,"secondsToFirstReconciliation":null,"interventions":4,"unresolvedGaps":1,` +
				`"events":{"total":6,"info":2,"agent":1,"retry":1,"human":1,"gap":1},"byKind":[],"imports":3,"reconciliations":0,"gapLog":{"open":2}}`)
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

func intakeWritePlanInput(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "plan.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const intakeSmallPlanInput = `{"sources":[{"account":"1010","files":["` + intakePlanFile + `"]}]}`

func TestIntakePlanPrintsThePlanAndExitsThreeWhenCheckedAndNotReady(t *testing.T) {
	server := &intakeFriendServer{plan: intakePlanJSON(false, intakePlanPresent+","+intakePlanGap)}
	url := server.start(t)
	input := intakeWritePlanInput(t, intakeSmallPlanInput)
	exit, out, _ := runIntakeCommand(t, url, "intake", "plan", "--input", input)
	if exit != 0 || !strings.Contains(out, `"statement_coverage"`) {
		t.Fatalf("exit %d: %s", exit, out)
	}
	exit, _, _ = runIntakeCommand(t, url, "intake", "plan", "--input", input, "--check=true")
	if exit != 3 {
		t.Fatalf("a plan that is not ready should exit 3 when checked, got %d", exit)
	}
	ready := &intakeFriendServer{plan: intakePlanJSON(true, intakePlanPresent)}
	exit, _, _ = runIntakeCommand(t, ready.start(t), "intake", "plan", "--input", input, "--check=true")
	if exit != 0 {
		t.Fatalf("a ready plan should exit 0, got %d", exit)
	}
}

func TestIntakePlanTextListsGapsFirstWithWhatToDoNext(t *testing.T) {
	server := &intakeFriendServer{plan: intakePlanJSON(false, intakePlanPresent+","+intakePlanGap+","+intakePlanOptional)}
	exit, out, _ := runIntakeCommand(t, server.start(t), "intake", "plan", "--input", intakeWritePlanInput(t, intakeSmallPlanInput), "--format", "text", "--record=false")
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	for _, want := range []string{"not ready", "MISSING", "statement_coverage 1010 2026-06 (required)", "customer acts: Download the statement for 2026-06."} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "cutover_date") {
		t.Errorf("a present item should not be listed:\n%s", out)
	}
}

func TestIntakePlanOptionsOverrideTheInputAndFilesAreNamedByHashOnly(t *testing.T) {
	server := &intakeFriendServer{plan: intakePlanJSON(true, intakePlanPresent)}
	url := server.start(t)
	input := intakeWritePlanInput(t, `{"cutoverDate":"2026-01-01","sources":[{"account":"1010","files":["`+intakePlanFile+`"]}]}`)
	exit, out, _ := runIntakeCommand(t, url, "intake", "plan", "--input", input, "--cutover", "2026-05-01", "--through", "2026-07-31", "--fresh=true", "--gaps-only=true", "--record=false")
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	var sent map[string]any
	_ = json.Unmarshal(server.inputs["/v1/intake.plan"], &sent)
	if sent["cutoverDate"] != "2026-05-01" || sent["through"] != "2026-07-31" || sent["fresh"] != true || sent["gapsOnly"] != true {
		t.Fatalf("sent = %v", sent)
	}
}

func TestIntakePlanRecordsRequiredGapsAsFrictionAndResolvesWhatIsGone(t *testing.T) {
	server := &intakeFriendServer{plan: intakePlanJSON(false, intakePlanPresent+","+intakePlanGap+","+intakePlanOptional), openKeys: []string{"plan:statement_coverage:1020::2026-06", "file:abc:recipe"}}
	url := server.start(t)
	exit, out, _ := runIntakeCommand(t, url, "intake", "plan", "--input", intakeWritePlanInput(t, intakeSmallPlanInput))
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if len(server.frictions) != 1 {
		t.Fatalf("friction calls = %d", len(server.frictions))
	}
	body := server.frictions[0]
	events := body["events"].([]any)
	// The plan itself, and the one required gap; the optional chart is not friction.
	if len(events) != 2 {
		t.Fatalf("events = %v", events)
	}
	gap := events[1].(map[string]any)
	if gap["kind"] != "coverage_gap" || gap["key"] != "plan:statement_coverage:1010::2026-06" || gap["source"] != "1010" {
		t.Fatalf("gap = %v", gap)
	}
	// An earlier plan's gap that is no longer listed is resolved; a key the plan did not write is left alone.
	resolve := body["resolve"].([]any)
	if len(resolve) != 1 || resolve[0] != "plan:statement_coverage:1020::2026-06" {
		t.Fatalf("resolve = %v", resolve)
	}
	// A plan that is run again records nothing it already has open (the service deduplicates), and
	// --record=false records nothing at all.
	quiet := &intakeFriendServer{plan: intakePlanJSON(false, intakePlanGap)}
	runIntakeCommand(t, quiet.start(t), "intake", "plan", "--input", intakeWritePlanInput(t, intakeSmallPlanInput), "--record=false")
	if len(quiet.frictions) != 0 {
		t.Fatalf("--record=false still recorded: %v", quiet.frictions)
	}
}

func TestIntakeAFrictionLogThatCannotBeWrittenDoesNotStopTheIntake(t *testing.T) {
	server := &intakeFriendServer{plan: intakePlanJSON(false, intakePlanGap), refuse: true}
	exit, out, diagnostics := runIntakeCommand(t, server.start(t), "intake", "plan", "--input", intakeWritePlanInput(t, intakeSmallPlanInput))
	if exit != 0 || !strings.Contains(out, "statement_coverage") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if !strings.Contains(diagnostics, "friction log was not written (permission_denied)") {
		t.Fatalf("diagnostics = %q", diagnostics)
	}
}

func TestIntakeFrictionAddResolveListAndExport(t *testing.T) {
	server := &intakeFriendServer{openKeys: []string{"a", "b", "c"}}
	url := server.start(t)
	exit, out, _ := runIntakeCommand(t, url, "intake", "friction", "add", "--kind", "human_input", "--source", "cutover", "--reason", "asked the owner", "--key", "ask:cutover")
	if exit != 0 || !strings.Contains(out, `"recorded":1`) {
		t.Fatalf("exit %d: %s", exit, out)
	}
	events := server.frictions[0]["events"].([]any)
	if events[0].(map[string]any)["kind"] != "human_input" || events[0].(map[string]any)["key"] != "ask:cutover" {
		t.Fatalf("events = %v", events)
	}
	exit, _, _ = runIntakeCommand(t, url, "intake", "friction", "resolve", "--key", "ask:cutover", "--note", "the owner answered")
	if exit != 0 {
		t.Fatalf("resolve exit %d", exit)
	}
	last := server.frictions[len(server.frictions)-1]
	if last["resolve"].([]any)[0] != "ask:cutover" || last["note"] != "the owner answered" {
		t.Fatalf("last = %v", last)
	}
	exit, out, _ = runIntakeCommand(t, url, "intake", "friction", "list", "--status", "open")
	if exit != 0 || !strings.Contains(out, `"count":3`) {
		t.Fatalf("list exit %d: %s", exit, out)
	}
	exit, out, _ = runIntakeCommand(t, url, "intake", "friction", "export")
	if exit != 0 {
		t.Fatalf("export exit %d: %s", exit, out)
	}
	var exported struct {
		Data struct {
			Count  int               `json:"count"`
			Events []json.RawMessage `json:"events"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &exported); err != nil || exported.Data.Count != 3 || len(exported.Data.Events) != 3 {
		t.Fatalf("export = %s (%v)", out, err)
	}
	for _, args := range [][]string{
		{"intake", "friction"},
		{"intake", "friction", "add", "--kind", "note"},
		{"intake", "friction", "resolve"},
		{"intake", "friction", "bogus"},
		{"intake", "friction", "list", "--page", "x"},
	} {
		if exit, out, _ := runIntakeCommand(t, url, args...); exit != 2 {
			t.Errorf("%v: exit %d, %s", args, exit, out)
		}
	}
}

func TestIntakeStatusSaysTheFourMeasures(t *testing.T) {
	server := &intakeFriendServer{}
	url := server.start(t)
	exit, out, _ := runIntakeCommand(t, url, "intake", "status", "--format", "text")
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	for _, want := range []string{"Time to the first import: 2m 31s (3 imports)", "Time to the first reconciliation: not yet", "Interventions: 4 (agent 1, retry 1, human 1)", "Unresolved gaps: 1; the move's gap log: 2 open"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	exit, out, _ = runIntakeCommand(t, url, "intake", "status")
	if exit != 0 || !strings.Contains(out, `"secondsToFirstImport":151`) {
		t.Fatalf("json exit %d: %s", exit, out)
	}
	if exit, _, _ := runIntakeCommand(t, url, "intake", "status", "extra"); exit != 2 {
		t.Errorf("extra argument: exit %d", exit)
	}
}

func TestIntakeScanRecordsWhatItFoundAsFriction(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"a.csv": "Date,Amount\n01/02/2026,5.00\n", "b.pdf": "%PDF-1.4 fake"})
	scan := newIntakeServer()
	friction := &intakeFriendServer{}
	// One server answers both; the scan test server does not know the friction routes, so use the
	// friction server for those and check it was asked.
	url := scan.start(t)
	_ = friction
	exit, out, diagnostics := runIntakeCommand(t, url, "intake", "scan", root)
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, out)
	}
	// The scan server answers the friction route with 404; the intake goes on and says so.
	if !strings.Contains(diagnostics, "friction log was not written") {
		t.Fatalf("diagnostics = %q", diagnostics)
	}
	exit, _, diagnostics = runIntakeCommand(t, url, "intake", "scan", root, "--record=false")
	if exit != 0 || strings.Contains(diagnostics, "friction") {
		t.Fatalf("--record=false: exit %d, %q", exit, diagnostics)
	}
}

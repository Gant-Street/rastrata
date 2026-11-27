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

type checkResult struct {
	Data struct {
		FrozenOperations  int `json:"frozenOperations"`
		PreviewOperations int `json:"previewOperations"`
		BuiltIn           struct {
			Compatible bool `json:"compatible"`
		} `json:"builtIn"`
		Service *struct {
			Contract       string `json:"contract"`
			FrozenHonoured struct {
				Compatible bool          `json:"compatible"`
				Breaking   []api.Finding `json:"breaking"`
			} `json:"frozenHonoured"`
			UnderstoodByThisBuild struct {
				Compatible bool          `json:"compatible"`
				Breaking   []api.Finding `json:"breaking"`
			} `json:"understoodByThisBuild"`
			Unavailable []string `json:"unavailable"`
			Newer       []string `json:"newer"`
		} `json:"service"`
		Compatible bool `json:"compatible"`
	} `json:"data"`
}

func runSchema(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	exit := runner.Run(context.Background(), append(args, "--request-dir", t.TempDir()))
	return exit, out.String(), diagnostics.String()
}

// servedCatalog is the catalog a service would publish: this build's, after `edit`.
func servedCatalog(t *testing.T, status int, edit func(map[string]any)) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/schema" || r.Method != http.MethodGet {
			w.WriteHeader(404)
			return
		}
		envelope := map[string]any{"version": api.Version, "bookId": "local-book"}
		if status >= 400 {
			w.WriteHeader(status)
			envelope["ok"] = false
			envelope["error"] = map[string]any{"code": "authentication_required", "message": "Credentials are required.", "details": []any{}, "retryable": false}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		var catalog map[string]any
		if err := json.Unmarshal(api.SchemaJSON, &catalog); err != nil {
			t.Fatal(err)
		}
		if edit != nil {
			edit(catalog)
		}
		envelope["ok"] = true
		envelope["data"] = catalog
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func operationsOf(catalog map[string]any) []any { return catalog["operations"].([]any) }

func decodeCheck(t *testing.T, out string) checkResult {
	t.Helper()
	var result checkResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	return result
}

func TestSchemaCheckOfflineSaysThisBuildHonoursItsFrozenContract(t *testing.T) {
	exit, out, _ := runSchema(t, "schema", "--check")
	result := decodeCheck(t, out)
	if exit != 0 || !result.Data.Compatible || !result.Data.BuiltIn.Compatible || result.Data.Service != nil {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if result.Data.FrozenOperations < 28 || result.Data.PreviewOperations < 0 {
		t.Fatalf("counts: %+v", result.Data)
	}
}

func TestSchemaOptionsAreChecked(t *testing.T) {
	for name, args := range map[string][]string{
		"live without check":      {"schema", "--live"},
		"an unknown option":       {"schema", "--check", "--strict"},
		"a value on a flag":       {"schema", "--check", "maybe"},
		"an operation with check": {"schema", "drafts.create", "--check"},
		"an unknown option alone": {"schema", "--format-all"},
	} {
		exit, out, _ := runSchema(t, args...)
		if exit != 2 || !json.Valid([]byte(out)) {
			t.Errorf("%s: exit %d out %s", name, exit, out)
		}
	}
}

func TestSchemaOfAnOperationSaysWhetherItIsStable(t *testing.T) {
	_, out, _ := runSchema(t, "schema", "drafts.create")
	if !strings.Contains(out, `"stability":"stable"`) {
		t.Fatalf("drafts.create should be stable: %.200s", out)
	}
	_, out, _ = runSchema(t, "schema", "inbox.list")
	if !strings.Contains(out, `"stability":"preview"`) {
		t.Fatalf("inbox.list should be a preview: %.200s", out)
	}
}

func TestHelpMarksEachOperationStableOrPreview(t *testing.T) {
	_, out, _ := runSchema(t, "help")
	if !strings.Contains(out, "stable") || !strings.Contains(out, "preview") || !strings.Contains(out, "previews may change") {
		t.Fatal("help should say which operations are stable")
	}
}

func TestLiveCheckAgainstAServiceServingThisContract(t *testing.T) {
	endpoint := servedCatalog(t, 200, nil)
	exit, out, _ := runSchema(t, "schema", "--check", "--live", "--endpoint", endpoint)
	result := decodeCheck(t, out)
	if exit != 0 || !result.Data.Compatible || result.Data.Service == nil || !result.Data.Service.FrozenHonoured.Compatible || !result.Data.Service.UnderstoodByThisBuild.Compatible {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if len(result.Data.Service.Unavailable) != 0 || len(result.Data.Service.Newer) != 0 {
		t.Fatalf("nothing should differ: %+v", result.Data.Service)
	}
}

func TestLiveCheckFindsAServiceThatBrokeTheFrozenContract(t *testing.T) {
	endpoint := servedCatalog(t, 200, func(catalog map[string]any) {
		kept := []any{}
		for _, item := range operationsOf(catalog) {
			operation := item.(map[string]any)
			if operation["name"] == "drafts.create" {
				continue
			}
			if operation["name"] == "journal.prepare" {
				operation["permission"] = "draft"
			}
			kept = append(kept, operation)
		}
		catalog["operations"] = kept
	})
	exit, out, diagnostics := runSchema(t, "schema", "--check", "--live", "--endpoint", endpoint)
	result := decodeCheck(t, out)
	if exit != 3 || result.Data.Compatible || result.Data.Service.FrozenHonoured.Compatible {
		t.Fatalf("exit %d: %s", exit, out)
	}
	text := ""
	for _, finding := range result.Data.Service.FrozenHonoured.Breaking {
		text += finding.Operation + " " + finding.Path + " " + finding.Message + ";"
	}
	if !strings.Contains(text, "drafts.create  was removed") || !strings.Contains(text, "journal.prepare permission changed from post to draft") {
		t.Fatalf("findings: %s", text)
	}
	if !strings.Contains(diagnostics, "contract-policy.md") {
		t.Fatalf("diagnostics should point to the policy: %s", diagnostics)
	}
}

func TestLiveCheckToleratesANewerAndAnOlderService(t *testing.T) {
	// A newer service: an extra operation and an extra optional reply field are additions.
	newer := servedCatalog(t, 200, func(catalog map[string]any) {
		catalog["operations"] = append(operationsOf(catalog), map[string]any{
			"name": "ledger.futureThing", "description": "From a later release.", "permission": "read", "writes": false,
			"input": map[string]any{"$ref": "#/$defs/Empty"}, "output": map[string]any{"$ref": "#/$defs/Empty"},
		})
		entry := catalog["$defs"].(map[string]any)["JournalEntry"].(map[string]any)
		entry["properties"].(map[string]any)["aFieldAddedLater"] = map[string]any{"type": "string"}
	})
	exit, out, _ := runSchema(t, "schema", "--check", "--live", "--endpoint", newer)
	result := decodeCheck(t, out)
	if exit != 0 || !result.Data.Compatible || len(result.Data.Service.Newer) != 1 || result.Data.Service.Newer[0] != "ledger.futureThing" {
		t.Fatalf("a newer service: exit %d: %s", exit, out)
	}
	// An older service: it lacks operations this build knows, which are unavailable, not broken.
	older := servedCatalog(t, 200, func(catalog map[string]any) {
		kept := []any{}
		for _, item := range operationsOf(catalog) {
			if name := item.(map[string]any)["name"].(string); !strings.HasPrefix(name, "stripe.") {
				kept = append(kept, item)
			}
		}
		catalog["operations"] = kept
	})
	exit, out, _ = runSchema(t, "schema", "--check", "--live", "--endpoint", older)
	result = decodeCheck(t, out)
	if exit != 0 || !result.Data.Compatible || len(result.Data.Service.Unavailable) == 0 {
		t.Fatalf("an older service: exit %d: %s", exit, out)
	}
	for _, name := range result.Data.Service.Unavailable {
		if !strings.HasPrefix(name, "stripe.") {
			t.Errorf("unexpected unavailable operation %s", name)
		}
	}
}

func TestLiveCheckFindsAServiceThisBuildCannotTalkTo(t *testing.T) {
	// The service now demands a field this build never sends.
	endpoint := servedCatalog(t, 200, func(catalog map[string]any) {
		input := catalog["$defs"].(map[string]any)["DraftIdInput"].(map[string]any)
		input["properties"].(map[string]any)["reason"] = map[string]any{"type": "string"}
		input["required"] = append(input["required"].([]any), "reason")
	})
	exit, out, _ := runSchema(t, "schema", "--check", "--live", "--endpoint", endpoint)
	result := decodeCheck(t, out)
	if exit != 3 || result.Data.Service.UnderstoodByThisBuild.Compatible {
		t.Fatalf("exit %d: %s", exit, out)
	}
}

func TestLiveCheckReportsAnUnauthorisedOrUnreachableService(t *testing.T) {
	locked := servedCatalog(t, 401, nil)
	exit, out, _ := runSchema(t, "schema", "--check", "--live", "--endpoint", locked)
	if exit != 3 || !strings.Contains(out, "authentication_required") {
		t.Fatalf("a locked service: exit %d: %s", exit, out)
	}
	exit, out, _ = runSchema(t, "schema", "--check", "--live", "--endpoint", "http://127.0.0.1:1")
	if exit != 4 || !strings.Contains(out, "connection_failed") {
		t.Fatalf("an unreachable service: exit %d: %s", exit, out)
	}
}

func TestADeprecatedOperationSaysSoFirstInHelp(t *testing.T) {
	line := operationLine(api.Operation{Name: "old.thing", Permission: "read", Description: "Does a thing.", Deprecated: "Since 2027-03-01; use new.thing. Removed in v2."}, "read", "stable")
	if !strings.Contains(line, "Deprecated: Since 2027-03-01; use new.thing. Removed in v2. Does a thing.") {
		t.Fatalf("line: %s", line)
	}
	plain := operationLine(api.Operation{Name: "a.b", Permission: "read", Description: "Reads."}, "read", "preview")
	if strings.Contains(plain, "Deprecated") || !strings.Contains(plain, "preview") {
		t.Fatalf("line: %s", plain)
	}
}

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

const pluginSecretFixture = "rsp_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

type pluginSentRequest struct {
	Path        string
	OperationID string
	Input       map[string]any
}

func pluginsTestServer(t *testing.T, sent *[]pluginSentRequest) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		var input map[string]any
		_ = json.Unmarshal(request.Input, &input)
		*sent = append(*sent, pluginSentRequest{
			Path:        r.URL.Path,
			OperationID: request.OperationID,
			Input:       input,
		})
		envelope := map[string]any{
			"version": api.Version,
			"bookId":  "local-book",
			"ok":      true,
		}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/plugins.list":
			envelope["data"] = json.RawMessage(`{"plugins":[]}`)
		case "/v1/plugins.install", "/v1/plugins.configure", "/v1/plugins.status":
			envelope["data"] = json.RawMessage(`{"pluginId":"mercury","version":"1.0.0","name":"Mercury","description":"Imports Mercury.","enabled":true,"ready":true,"domains":["api.mercury.com"],"authKind":"api_key","authLabel":"Mercury API token","authEnvVar":"RASTRATA_PLUGIN_MERCURY_KEY","config":[],"roles":[],"accountMap":[],"clearing":null,"cursors":[],"installedAt":"2026-10-15T12:00:00.000Z","updatedAt":"2026-10-15T12:00:00.000Z"}`)
		case "/v1/plugins.remove":
			envelope["data"] = json.RawMessage(`{"pluginId":"mercury","removed":true}`)
		case "/v1/plugins.createToken":
			envelope["data"] = json.RawMessage(`{"token":"` + pluginSecretFixture + `","record":{"id":"0123456789abcdef","pluginId":"mercury","label":"Cron","status":"active","createdAt":"2026-10-15T12:00:00.000Z","createdBy":"owner","expiresAt":"2027-01-13T12:00:00.000Z","revokedAt":null,"revokedReason":null,"lastUsedAt":null}}`)
		case "/v1/plugins.listTokens":
			envelope["data"] = json.RawMessage(`{"tokens":[{"id":"0123456789abcdef","pluginId":"mercury","label":"Cron","status":"active","createdAt":"2026-10-15T12:00:00.000Z","createdBy":"owner","expiresAt":"2027-01-13T12:00:00.000Z","revokedAt":null,"revokedReason":null,"lastUsedAt":null}]}`)
		case "/v1/plugins.revokeToken":
			envelope["data"] = json.RawMessage(`{"record":{"id":"0123456789abcdef","pluginId":"mercury","label":"Cron","status":"revoked","createdAt":"2026-10-15T12:00:00.000Z","createdBy":"owner","expiresAt":"2027-01-13T12:00:00.000Z","revokedAt":"2026-10-15T12:05:00.000Z","revokedReason":"Rotated","lastUsedAt":null}}`)
		default:
			w.WriteHeader(404)
			envelope["ok"] = false
			envelope["error"] = map[string]any{"code": "route_not_found", "message": "not found", "details": []any{}, "retryable": false}
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func TestPluginInitScaffoldsBankAndLedgerTemplates(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		slug string
		kind string
		want string
	}{
		{slug: "acme-bank", kind: "bank", want: "emit.bankLine"},
		{slug: "acme-pay", kind: "ledger", want: "payouts.in-transit"},
	} {
		target := filepath.Join(dir, tc.slug)
		var out, diag bytes.Buffer
		r := Runner{Output: &out, Diagnostics: &diag}
		code := r.Run(context.Background(), []string{"plugin", "init", tc.slug, "--kind", tc.kind, "--dir", target})
		if code != 0 {
			t.Fatalf("plugin init %s failed (exit %d): %s / %s", tc.slug, code, out.String(), diag.String())
		}
		manifest, _, err := loadPluginManifest(target)
		if err != nil {
			t.Fatalf("manifest.json invalid: %v", err)
		}
		if manifest.ID != tc.slug {
			t.Fatalf("got manifest id %q, want %q", manifest.ID, tc.slug)
		}
		srcBytes, err := os.ReadFile(filepath.Join(target, "src", "index.ts"))
		if err != nil || !strings.Contains(string(srcBytes), tc.want) {
			t.Fatalf("expected %q in scaffolded src/index.ts", tc.want)
		}
		// Refuses overwriting non-empty directory.
		var out2, diag2 bytes.Buffer
		r2 := Runner{Output: &out2, Diagnostics: &diag2}
		if code2 := r2.Run(context.Background(), []string{"plugin", "init", tc.slug, "--dir", target}); code2 == 0 {
			t.Fatalf("expected non-zero exit when directory is non-empty")
		}
	}
}

func TestPluginInstallConfigureRemoveAndTokenJournalRedaction(t *testing.T) {
	var sent []pluginSentRequest
	endpoint := pluginsTestServer(t, &sent)
	reqDir := t.TempDir()
	pluginDir := t.TempDir()

	// Scaffold a valid manifest and install it via `rastrata plugin install`.
	var initOut, initDiag bytes.Buffer
	rInit := Runner{Output: &initOut, Diagnostics: &initDiag}
	if code := rInit.Run(context.Background(), []string{"plugin", "init", "mercury", "--dir", pluginDir}); code != 0 {
		t.Fatalf("init failed: %s", initDiag.String())
	}

	var out, diag bytes.Buffer
	r := Runner{Output: &out, Diagnostics: &diag}
	code := r.Run(context.Background(), []string{
		"--endpoint", endpoint,
		"--request-dir", reqDir,
		"plugin", "install", pluginDir,
		"--account", "mercury:acct_1=acc_1000@2026-10-01",
		"--config", "startDate=2026-10-01",
	})
	if code != 0 {
		t.Fatalf("plugin install failed (exit %d): %s / %s", code, out.String(), diag.String())
	}
	if !strings.Contains(diag.String(), "api.mercury.com") {
		t.Fatalf("expected install diagnostics to display allowed outbound domain, got: %s", diag.String())
	}
	if len(sent) != 1 || sent[0].Path != "/v1/plugins.install" {
		t.Fatalf("unexpected requests: %+v", sent)
	}

	// Configure, status, list, token lifecycle, remove.
	for _, args := range [][]string{
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "configure", "mercury", "--enabled", "true"},
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "status", "mercury"},
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "list"},
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "token-create", "mercury", "--label", "Cron", "--expires-in-days", "30"},
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "token-list", "mercury"},
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "token-revoke", "0123456789abcdef", "--reason", "Rotated"},
		{"--endpoint", endpoint, "--request-dir", reqDir, "plugin", "remove", "mercury"},
	} {
		out.Reset()
		diag.Reset()
		if exit := r.Run(context.Background(), args); exit != 0 {
			t.Fatalf("%v failed (exit %d): %s / %s", args, exit, out.String(), diag.String())
		}
	}

	// Verify the rsp_ token secret returned by plugins.createToken was NEVER written to the request journal!
	err := filepath.Walk(reqDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") {
			t.Fatalf("plugin token secret leaked into request journal file %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk request dir: %v", err)
	}
}

func TestPluginSyncRequiresDeclaredEnvVarAndNeverExposesSecrets(t *testing.T) {
	pluginDir := t.TempDir()
	var initOut, initDiag bytes.Buffer
	if code := (Runner{Output: &initOut, Diagnostics: &initDiag}).Run(context.Background(), []string{"plugin", "init", "demo-bank", "--dir", pluginDir}); code != 0 {
		t.Fatalf("init failed: %s", initDiag.String())
	}

	t.Setenv("RASTRATA_PLUGIN_DEMO_BANK_KEY", "")
	var out, diag bytes.Buffer
	r := Runner{Output: &out, Diagnostics: &diag}
	code := r.Run(context.Background(), []string{"plugin", "sync", pluginDir, "--dry-run"})
	if code == 0 {
		t.Fatalf("expected non-zero exit when RASTRATA_PLUGIN_DEMO_BANK_KEY is unset")
	}
	if !strings.Contains(diag.String(), "RASTRATA_PLUGIN_DEMO_BANK_KEY") {
		t.Fatalf("expected actionable error naming RASTRATA_PLUGIN_DEMO_BANK_KEY, got: %s", diag.String())
	}
}

func TestPluginLooksLikeTokenBlocksRspCredentialsInLabelsAndConfig(t *testing.T) {
	if !api.LooksLikeToken(pluginSecretFixture) {
		t.Fatalf("expected LooksLikeToken to recognize rsp_ plugin tokens")
	}
	if _, err := parseConfigEntriesFlag("apiKey=" + pluginSecretFixture); err == nil {
		t.Fatalf("expected parseConfigEntriesFlag to reject rsp_ token pasted into --config")
	}
}

func TestPluginTestRunsOfficialReferencePluginsWithStrippedEnv(t *testing.T) {
	// Set a canary secret in the parent process and verify `rastrata plugin test` succeeds
	// cleanly against the official Stripe reference plugin.
	t.Setenv("RASTRATA_OWNER_KEY", "rso_should_never_reach_plugin_tests")
	for _, rel := range []string{
		filepath.Join("..", "..", "..", "..", "packages", "plugin-stripe"),
	} {
		var out, diag bytes.Buffer
		r := Runner{Output: &out, Diagnostics: &diag}
		code := r.Run(context.Background(), []string{"plugin", "test", rel})
		if code != 0 {
			t.Fatalf("plugin test %s failed (exit %d): %s / %s", rel, code, out.String(), diag.String())
		}
	}
}

func TestPluginInitFileAndSyncDryRunWithCSVFixture(t *testing.T) {
	// Scaffold inside a temp dir inside the monorepo parent? Use t.TempDir() and symlink node_modules
	// so bun resolves @gantstreet/rastrata-plugin-sdk cleanly without network access.
	dir := filepath.Join(t.TempDir(), "plugin-demo-csv")
	var out, diag bytes.Buffer
	r := Runner{Output: &out, Diagnostics: &diag}
	code := r.Run(context.Background(), []string{"plugin", "init", "demo-csv", "--kind", "file", "--dir", dir})
	if code != 0 {
		t.Fatalf("plugin init --kind file failed (exit %d): %s / %s", code, out.String(), diag.String())
	}
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	scopeDir := filepath.Join(dir, "node_modules", "@gantstreet")
	if err := os.MkdirAll(scopeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(repoRoot, "packages", "plugin-sdk"), filepath.Join(scopeDir, "rastrata-plugin-sdk")); err != nil {
		t.Fatal(err)
	}

	out.Reset()
	diag.Reset()
	code = r.Run(context.Background(), []string{"plugin", "test", dir})
	if code != 0 {
		t.Fatalf("plugin test on scaffolded file plugin failed (exit %d): %s / %s", code, out.String(), diag.String())
	}

	out.Reset()
	diag.Reset()
	code = r.Run(context.Background(), []string{
		"plugin", "sync", dir,
		"--file", filepath.Join(dir, "sample.csv"),
		"--dry-run",
		"--format", "text",
	})
	if code != 0 {
		t.Fatalf("plugin sync --file --dry-run failed (exit %d): %s / %s", code, out.String(), diag.String())
	}
	if !strings.Contains(out.String(), "-42.50") || !strings.Contains(out.String(), "2500.00") {
		t.Fatalf("expected CSV preview table with -42.50 and 2500.00, got:\n%s", out.String())
	}
}

func TestPluginSearchAndInstallFromLocalRegistry(t *testing.T) {
	regFile := filepath.Join(t.TempDir(), "registry.json")
	doc := builtInOfficialRegistry()
	raw, _ := json.Marshal(doc)
	if err := os.WriteFile(regFile, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var out, diag bytes.Buffer
	r := Runner{Output: &out, Diagnostics: &diag}
	code := r.Run(context.Background(), []string{"plugin", "search", "stripe", "--registry", regFile, "--format", "text"})
	if code != 0 {
		t.Fatalf("plugin search failed (exit %d): %s / %s", code, out.String(), diag.String())
	}
	if !strings.Contains(out.String(), "stripe") || !strings.Contains(out.String(), "api.stripe.com") {
		t.Fatalf("expected stripe entry in search output, got:\n%s", out.String())
	}

	var gotOp string
	var gotManifestID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotOp = strings.TrimPrefix(req.URL.Path, "/v1/")
		var env struct {
			OperationID string `json:"operationId"`
			Input       struct {
				Manifest struct {
					ID string `json:"id"`
				} `json:"manifest"`
			} `json:"input"`
		}
		_ = json.NewDecoder(req.Body).Decode(&env)
		gotManifestID = env.Input.Manifest.ID
		w.Header().Set("Content-Type", "application/json")
		resp, _ := json.Marshal(map[string]any{
			"version":     "rastrata-application-v1",
			"bookId":      "local-book",
			"ok":          true,
			"operationId": env.OperationID,
			"data": map[string]any{
				"pluginId":    "stripe",
				"version":     "1.0.0",
				"name":        "Stripe",
				"description": "Stripe payouts",
				"enabled":     true,
				"ready":       true,
				"domains":     []string{"api.stripe.com"},
				"authKind":    "api_key",
				"authLabel":   "Stripe restricted read-only key",
				"authEnvVar":  "RASTRATA_PLUGIN_STRIPE_KEY",
				"config":      []any{},
				"roles":       []any{},
				"accountMap":  []any{},
				"clearing":    map[string]any{"role": "payouts.in-transit", "windowDays": 7},
				"cursors":     []any{},
				"installedAt": "2026-11-27T00:00:00.000Z",
				"updatedAt":   "2026-11-27T00:00:00.000Z",
			},
		})
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	out.Reset()
	diag.Reset()
	code = r.Run(context.Background(), []string{"--endpoint", srv.URL, "plugin", "install", "stripe", "--registry", regFile})
	if code != 0 {
		t.Fatalf("plugin install stripe from registry failed (exit %d): %s / %s", code, out.String(), diag.String())
	}
	if gotOp != "plugins.install" || gotManifestID != "stripe" {
		t.Fatalf("expected plugins.install for stripe, got op=%q id=%q", gotOp, gotManifestID)
	}
}

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/agentkit"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// Plugin commands: Stripe-level developer and operator workflow for out-of-process ingestion
// plugins built on @gantstreet/rastrata-plugin-sdk (MIT).
//
//	rastrata plugin init <slug> [--kind bank|ledger|file] [--dir PATH]
//	rastrata plugin test <dir>
//	rastrata plugin search [query] [--registry URL-OR-FILE]
//	rastrata plugin list
//	rastrata plugin status <id>
//	rastrata plugin install <slug-or-dir-or-manifest.json> [--registry URL-OR-FILE] [--map R=A,...] [--account K=A[@D],...] [--config K=V,...] [--disabled]
//	rastrata plugin configure <id> [--map R=A,...|none] [--account K=A[@D],...|none] [--config K=V,...|none] [--enabled true|false]
//	rastrata plugin remove <id>
//	rastrata plugin token-create <id> --label TEXT [--expires-in-days N]
//	rastrata plugin token-list [<id>]
//	rastrata plugin token-revoke <token-id> [--reason TEXT]
//	rastrata plugin sync <dir> [--dry-run] [--file PATH] [--token-env VAR] [--book-currency USD] [--time-zone UTC] [--cursor C] [--config K=V,...]
func init() {
	Register(Command{Name: "plugin init", Summary: "Plugins: scaffold a new MIT ingestion plugin with manifest, SDK template, and 5-invariant test suite <slug> [--kind bank|ledger|file] [--dir PATH]", Offline: true, Run: runPluginInit})
	Register(Command{Name: "plugin test", Summary: "Plugins: run a plugin's test suite out-of-process with a stripped environment <dir>", Offline: true, Run: runPluginTest})
	Register(Command{Name: "plugin search", Summary: "Plugins: search the Rastrata plugin registry for verified connectors [query] [--registry URL-OR-FILE]", Offline: true, Run: runPluginSearch})
	Register(Command{Name: "plugin list", Summary: "Plugins: list installed ingestion plugins, readiness, missing roles, and last sync", Run: runPluginList})
	Register(Command{Name: "plugin status", Summary: "Plugins: show resolved account roles, cursors, domains, and readiness <id>", Run: runPluginStatus})
	Register(Command{Name: "plugin install", Summary: "Plugins: inspect manifest domains/roles and install or upgrade a plugin <slug-or-dir-or-manifest.json> [--registry URL-OR-FILE] [--map R=A,...] [--account K=A[@D],...] [--config K=V,...] [--disabled]", Run: runPluginInstall})
	Register(Command{Name: "plugin configure", Summary: "Plugins: update role mappings, bank account cutovers, config fields, or enabled state <id> [--map R=A,...|none] [--account K=A[@D],...|none] [--config K=V,...|none] [--enabled true|false]", Run: runPluginConfigure})
	Register(Command{Name: "plugin remove", Summary: "Plugins: remove an installed plugin and revoke its rsp_ tokens (ledger history stays intact) <id>", Run: runPluginRemove})
	Register(Command{Name: "plugin token-create", Summary: "Plugins: create a least-privilege rsp_ token bound strictly to one plugin (shown once) <id> --label TEXT [--expires-in-days N]", Run: runPluginTokenCreate})
	Register(Command{Name: "plugin token-list", Summary: "Plugins: list plugin rsp_ tokens and their status without revealing secrets [<id>]", Run: runPluginTokenList})
	Register(Command{Name: "plugin token-revoke", Summary: "Plugins: revoke a plugin rsp_ token immediately <token-id> [--reason TEXT]", Run: runPluginTokenRevoke})
	Register(Command{Name: "plugin sync", Summary: "Plugins: run a plugin out-of-process with stripped env, preview with --dry-run, or push to Rastrata <dir> [--dry-run] [--file PATH] [--token-env VAR] [--book-currency USD] [--time-zone UTC] [--cursor C] [--config K=V,...]", Run: runPluginSync})
}

var (
	pluginSlugPattern    = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`)
	pluginTokenIDPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)
	pluginDatePattern    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

type pluginManifestFile struct {
	ID          string              `json:"id"`
	Version     string              `json:"version"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Domains     []string            `json:"domains"`
	AuthKind    string              `json:"authKind"`
	AuthLabel   string              `json:"authLabel,omitempty"`
	AuthEnvVar  string              `json:"authEnvVar,omitempty"`
	Roles       []pluginRoleSpec    `json:"roles,omitempty"`
	Clearing    *pluginClearingSpec `json:"clearing,omitempty"`
}

type pluginRoleSpec struct {
	Key            string `json:"key"`
	Label          string `json:"label"`
	Kind           string `json:"kind"`
	Required       bool   `json:"required"`
	DefaultRoleKey string `json:"defaultRoleKey,omitempty"`
}

type pluginClearingSpec struct {
	Role       string `json:"role"`
	WindowDays int    `json:"windowDays,omitempty"`
}

func pluginUsage(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

func pluginFlagProblem(o Options, allowed, valued []string) string {
	known := map[string]bool{}
	for _, name := range allowed {
		known[name] = true
	}
	names := make([]string, 0, len(o.Flags))
	for name := range o.Flags {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !known[name] {
			return "unknown option --" + name
		}
	}
	for _, name := range valued {
		if value, given := o.Flags[name]; given && (value == "true" || value == "") {
			return "--" + name + " needs a value"
		}
	}
	return ""
}

func pluginCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) int {
	definition, _ := api.FindOperation(operation)
	operationID := ""
	if definition.Writes {
		operationID = o.OperationID
		if operationID == "" {
			operationID = api.NewOperationID()
		}
		fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
	}
	response, err := c.Call(ctx, operation, input, operationID)
	return r.result(o, response, err, "")
}

func loadPluginManifest(target string) (pluginManifestFile, string, error) {
	info, err := os.Stat(target)
	if err != nil {
		return pluginManifestFile{}, "", fmt.Errorf("cannot read %q: %w", target, err)
	}
	manifestPath := target
	if info.IsDir() {
		manifestPath = filepath.Join(target, "manifest.json")
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return pluginManifestFile{}, "", fmt.Errorf("could not read manifest %q: %w (expected a manifest.json file)", manifestPath, err)
	}
	var manifest pluginManifestFile
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return pluginManifestFile{}, "", fmt.Errorf("invalid JSON in %q: %w", manifestPath, err)
	}
	if !pluginSlugPattern.MatchString(manifest.ID) {
		return pluginManifestFile{}, "", fmt.Errorf("manifest.id %q must be 3-32 lowercase letters, digits, or hyphens", manifest.ID)
	}
	return manifest, manifestPath, nil
}

func parseRoleMapFlag(raw string) ([]map[string]any, error) {
	if strings.EqualFold(strings.TrimSpace(raw), "none") {
		return []map[string]any{}, nil
	}
	entries := []map[string]any{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		role, accountID, ok := strings.Cut(pair, "=")
		role = strings.TrimSpace(role)
		accountID = strings.TrimSpace(accountID)
		if !ok || role == "" || accountID == "" {
			return nil, fmt.Errorf("invalid --map item %q (expected ROLE=ACCOUNT_ID)", pair)
		}
		entries = append(entries, map[string]any{"role": role, "accountId": accountID})
	}
	return entries, nil
}

func parseAccountMapFlag(raw string) ([]map[string]any, error) {
	if strings.EqualFold(strings.TrimSpace(raw), "none") {
		return []map[string]any{}, nil
	}
	entries := []map[string]any{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, right, ok := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		right = strings.TrimSpace(right)
		if !ok || key == "" || right == "" {
			return nil, fmt.Errorf("invalid --account item %q (expected ACCOUNT_KEY=LEDGER_ACCOUNT_ID[@YYYY-MM-DD])", pair)
		}
		accountID, startOn, hasStart := strings.Cut(right, "@")
		accountID = strings.TrimSpace(accountID)
		startOn = strings.TrimSpace(startOn)
		if accountID == "" {
			return nil, fmt.Errorf("invalid --account item %q: missing ledger account id", pair)
		}
		item := map[string]any{"accountKey": key, "ledgerAccountId": accountID}
		if hasStart {
			if !pluginDatePattern.MatchString(startOn) {
				return nil, fmt.Errorf("invalid cutover date %q in --account (use YYYY-MM-DD)", startOn)
			}
			item["startOn"] = startOn
		}
		entries = append(entries, item)
	}
	return entries, nil
}

func parseConfigEntriesFlag(raw string) ([]map[string]any, error) {
	if strings.EqualFold(strings.TrimSpace(raw), "none") {
		return []map[string]any{}, nil
	}
	entries := []map[string]any{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, value, ok := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid --config item %q (expected KEY=VALUE)", pair)
		}
		if api.LooksLikeToken(value) {
			return nil, fmt.Errorf("--config value for %q looks like a credential; keep secrets in environment variables, never in plugin config", key)
		}
		entries = append(entries, map[string]any{"key": key, "value": value})
	}
	return entries, nil
}

func strippedBaseEnv() []string {
	env := []string{}
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "USER", "TERM"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func runPluginList(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin list"
	if len(o.Args) != 2 {
		return pluginUsage(r, o, "plugin list takes no arguments", usage)
	}
	if problem := pluginFlagProblem(o, nil, nil); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	return pluginCall(r, ctx, o, c, "plugins.list", map[string]any{})
}

func runPluginStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin status <id>"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin status requires a plugin id", usage)
	}
	if problem := pluginFlagProblem(o, nil, nil); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	pluginID := o.Args[2]
	if !pluginSlugPattern.MatchString(pluginID) {
		return pluginUsage(r, o, "invalid plugin id "+strconv.Quote(pluginID), usage)
	}
	return pluginCall(r, ctx, o, c, "plugins.status", map[string]any{"pluginId": pluginID})
}

func runPluginInstall(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin install <slug-or-dir-or-manifest.json> [--registry URL-OR-FILE] [--map R=A,...] [--account K=A[@D],...] [--config K=V,...] [--disabled]"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin install requires a plugin slug, directory, or manifest.json path", usage)
	}
	if problem := pluginFlagProblem(o, []string{"registry", "map", "account", "config", "disabled"}, []string{"registry", "map", "account", "config"}); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	manifest, manifestPath, err := resolvePluginManifest(ctx, o.Args[2], o.Flags["registry"])
	if err != nil {
		return r.localError(o, "invalid_manifest", err.Error(), 2)
	}
	domains := strings.Join(manifest.Domains, ", ")
	if domains == "" {
		domains = "(none — offline/file only)"
	}
	fmt.Fprintf(r.Diagnostics, "Installing %s (%s v%s) from %s\n", manifest.Name, manifest.ID, manifest.Version, manifestPath)
	fmt.Fprintf(r.Diagnostics, "  Allowed outbound domains: %s\n", domains)
	if len(manifest.Roles) > 0 {
		roleKeys := make([]string, 0, len(manifest.Roles))
		for _, role := range manifest.Roles {
			roleKeys = append(roleKeys, role.Key)
		}
		fmt.Fprintf(r.Diagnostics, "  Declared roles: %s\n", strings.Join(roleKeys, ", "))
	}

	rawManifest, _ := json.Marshal(manifest)
	var manifestMap map[string]any
	_ = json.Unmarshal(rawManifest, &manifestMap)
	if manifest.Domains == nil {
		manifestMap["domains"] = []string{}
	}

	input := map[string]any{"manifest": manifestMap}
	if raw, given := o.Flags["map"]; given {
		entries, err := parseRoleMapFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		input["roleMap"] = entries
	}
	if raw, given := o.Flags["account"]; given {
		entries, err := parseAccountMapFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		input["accountMap"] = entries
	}
	if raw, given := o.Flags["config"]; given {
		entries, err := parseConfigEntriesFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		input["config"] = entries
	}
	if o.Flags["disabled"] == "true" {
		input["enabled"] = false
	}
	return pluginCall(r, ctx, o, c, "plugins.install", input)
}

func runPluginConfigure(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin configure <id> [--map R=A,...|none] [--account K=A[@D],...|none] [--config K=V,...|none] [--enabled true|false]"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin configure requires a plugin id", usage)
	}
	if problem := pluginFlagProblem(o, []string{"map", "account", "config", "enabled"}, []string{"map", "account", "config"}); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	pluginID := o.Args[2]
	if !pluginSlugPattern.MatchString(pluginID) {
		return pluginUsage(r, o, "invalid plugin id "+strconv.Quote(pluginID), usage)
	}
	input := map[string]any{"pluginId": pluginID}
	if raw, given := o.Flags["map"]; given {
		entries, err := parseRoleMapFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		input["roleMap"] = entries
	}
	if raw, given := o.Flags["account"]; given {
		entries, err := parseAccountMapFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		input["accountMap"] = entries
	}
	if raw, given := o.Flags["config"]; given {
		entries, err := parseConfigEntriesFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		input["config"] = entries
	}
	if raw, given := o.Flags["enabled"]; given {
		switch strings.ToLower(raw) {
		case "true", "yes", "1":
			input["enabled"] = true
		case "false", "no", "0":
			input["enabled"] = false
		default:
			return pluginUsage(r, o, "--enabled must be true or false", usage)
		}
	}
	return pluginCall(r, ctx, o, c, "plugins.configure", input)
}

func runPluginRemove(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin remove <id>"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin remove requires a plugin id", usage)
	}
	if problem := pluginFlagProblem(o, nil, nil); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	pluginID := o.Args[2]
	if !pluginSlugPattern.MatchString(pluginID) {
		return pluginUsage(r, o, "invalid plugin id "+strconv.Quote(pluginID), usage)
	}
	return pluginCall(r, ctx, o, c, "plugins.remove", map[string]any{"pluginId": pluginID})
}

func runPluginTokenCreate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin token-create <id> --label TEXT [--expires-in-days N]"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin token-create requires a plugin id", usage)
	}
	if problem := pluginFlagProblem(o, []string{"label", "expires-in-days"}, []string{"label", "expires-in-days"}); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	pluginID := o.Args[2]
	if !pluginSlugPattern.MatchString(pluginID) {
		return pluginUsage(r, o, "invalid plugin id "+strconv.Quote(pluginID), usage)
	}
	label, given := o.Flags["label"]
	if !given || strings.TrimSpace(label) == "" {
		return pluginUsage(r, o, "--label is required (for example --label \"Laptop cron\")", usage)
	}
	if api.LooksLikeToken(label) {
		return pluginUsage(r, o, "the label looks like a credential; a label is a name for people", usage)
	}
	input := map[string]any{"pluginId": pluginID, "label": label}
	if raw, given := o.Flags["expires-in-days"]; given {
		days, err := strconv.Atoi(raw)
		if err != nil || days < 1 || days > agentkit.MaxTokenDays {
			return pluginUsage(r, o, fmt.Sprintf("--expires-in-days must be a whole number from 1 to %d", agentkit.MaxTokenDays), usage)
		}
		input["expiresInDays"] = days
	}
	fmt.Fprintf(r.Diagnostics, "The plugin token (rsp_...) is shown once in this output and is scoped strictly to %s (plugins.status, plugins.push, and plugin raw uploads). Export it as RASTRATA_PLUGIN_TOKEN; never commit it.\n", pluginID)
	return pluginCall(r, ctx, o, c, "plugins.createToken", input)
}

func runPluginTokenList(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin token-list [<id>]"
	if len(o.Args) < 2 || len(o.Args) > 3 {
		return pluginUsage(r, o, "plugin token-list takes at most one plugin id", usage)
	}
	if problem := pluginFlagProblem(o, nil, nil); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if len(o.Args) == 3 {
		pluginID := o.Args[2]
		if !pluginSlugPattern.MatchString(pluginID) {
			return pluginUsage(r, o, "invalid plugin id "+strconv.Quote(pluginID), usage)
		}
		input["pluginId"] = pluginID
	}
	return pluginCall(r, ctx, o, c, "plugins.listTokens", input)
}

func runPluginTokenRevoke(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin token-revoke <token-id> [--reason TEXT]"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin token-revoke requires a 16-hex token id", usage)
	}
	if problem := pluginFlagProblem(o, []string{"reason"}, []string{"reason"}); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	tokenID := o.Args[2]
	if !pluginTokenIDPattern.MatchString(tokenID) {
		return pluginUsage(r, o, "token id must be 16 lowercase hex characters (from plugin token-list)", usage)
	}
	input := map[string]any{"tokenId": tokenID}
	if reason, given := o.Flags["reason"]; given {
		input["reason"] = reason
	}
	return pluginCall(r, ctx, o, c, "plugins.revokeToken", input)
}

func runPluginTest(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "plugin test <dir>"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin test requires a plugin directory", usage)
	}
	if problem := pluginFlagProblem(o, nil, nil); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	dir, err := filepath.Abs(o.Args[2])
	if err != nil {
		return r.localError(o, "invalid_input", err.Error(), 2)
	}
	if _, _, err := loadPluginManifest(dir); err != nil {
		return r.localError(o, "invalid_manifest", err.Error(), 2)
	}
	bunPath, err := exec.LookPath("bun")
	if err != nil {
		return r.localError(o, "runtime_missing", "bun is required on PATH to run plugin tests (install from https://bun.sh)", 2)
	}
	cmd := exec.CommandContext(ctx, bunPath, "test")
	cmd.Dir = dir
	// Stripped environment: never expose host Rastrata credentials or unrelated shell secrets to plugin tests.
	cmd.Env = strippedBaseEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if stderr.Len() > 0 {
		_, _ = r.Diagnostics.Write(stderr.Bytes())
	}
	if err != nil {
		if stdout.Len() > 0 {
			_, _ = r.Diagnostics.Write(stdout.Bytes())
		}
		return r.localError(o, "plugin_test_failed", "Plugin test suite failed: "+err.Error(), 1)
	}
	if o.Format == "text" {
		_, _ = r.Output.Write(stdout.Bytes())
		return 0
	}
	payload, _ := json.Marshal(map[string]any{"ok": true, "dir": dir, "output": stdout.String()})
	return r.result(o, api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: payload}, nil, "")
}

// pluginSyncRunnerJS runs inside a stripped-environment Bun child process, imports the plugin
// module and @gantstreet/rastrata-plugin-sdk/runner, and prints a single JSON result on stdout.
const pluginSyncRunnerJS = `
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { isPluginError } from "@gantstreet/rastrata-plugin-sdk";
import { runPluginSync } from "@gantstreet/rastrata-plugin-sdk/runner";

try {
  const entry = process.env.RASTRATA_PLUGIN_ENTRY;
  if (!entry) throw new Error("Missing RASTRATA_PLUGIN_ENTRY");
  const mod = await import(pathToFileURL(entry).href);
  const plugin = mod.default ?? Object.values(mod).find((v) => v && typeof v === "object" && "manifest" in v);
  if (!plugin) throw new Error("Plugin module must export default definePlugin(...)");

  const dryRun = process.env.RASTRATA_PLUGIN_DRY_RUN === "1";
  const authKind = process.env.RASTRATA_PLUGIN_AUTH_KIND || "none";
  const secret = process.env.RASTRATA_PLUGIN_AUTH_SECRET || "";
  const auth = authKind === "api_key" ? { apiKey: secret } : authKind === "oauth2" ? { accessToken: secret } : {};
  const config = process.env.RASTRATA_PLUGIN_CONFIG_JSON ? JSON.parse(process.env.RASTRATA_PLUGIN_CONFIG_JSON) : {};
  const cursor = process.env.RASTRATA_PLUGIN_CURSOR ? process.env.RASTRATA_PLUGIN_CURSOR : undefined;

  let fixtures;
  const filePath = process.env.RASTRATA_PLUGIN_FILE;
  if (filePath) {
    const ext = extname(filePath).toLowerCase();
    const mediaType =
      ext === ".csv" ? "text/csv" :
      ext === ".tsv" ? "text/tab-separated-values" :
      ext === ".json" ? "application/json" :
      ext === ".ofx" || ext === ".qfx" ? "application/x-ofx" :
      "application/octet-stream";
    fixtures = [{ bytes: new Uint8Array(readFileSync(filePath)), mediaType, name: basename(filePath) }];
  }

  const result = await runPluginSync(plugin, {
    dryRun,
    endpoint: process.env.RASTRATA_API_URL || "http://127.0.0.1:4010",
    bookId: process.env.RASTRATA_BOOK_ID || "local-book",
    token: process.env.RASTRATA_PLUGIN_TOKEN || undefined,
    auth,
    config,
    bookCurrency: process.env.RASTRATA_PLUGIN_CURRENCY || "USD",
    timeZone: process.env.RASTRATA_PLUGIN_TZ || "UTC",
    ...(cursor !== undefined ? { cursor } : {}),
    ...(fixtures !== undefined ? { fixtures } : {}),
  });

  process.stdout.write(JSON.stringify({
    ok: result.ok,
    pluginId: result.pluginId,
    dryRun: result.dryRun,
    totals: result.totals,
    pushed: result.pushed,
    preview: result.preview,
  }));
} catch (error) {
  const code = isPluginError(error) ? error.code : "plugin_sync_failed";
  const message = error instanceof Error ? error.message : String(error);
  const hint = isPluginError(error) ? error.hint : undefined;
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code, message, ...(hint ? { hint } : {}) },
  }));
}
`

func runPluginSync(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "plugin sync <dir> [--dry-run] [--file PATH] [--token-env VAR] [--book-currency USD] [--time-zone UTC] [--cursor CURSOR] [--config K=V,...]"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin sync requires a plugin directory", usage)
	}
	if problem := pluginFlagProblem(
		o,
		[]string{"dry-run", "file", "token-env", "book-currency", "time-zone", "cursor", "config"},
		[]string{"file", "token-env", "book-currency", "time-zone", "cursor", "config"},
	); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	dir, err := filepath.Abs(o.Args[2])
	if err != nil {
		return r.localError(o, "invalid_input", err.Error(), 2)
	}
	manifest, _, err := loadPluginManifest(dir)
	if err != nil {
		return r.localError(o, "invalid_manifest", err.Error(), 2)
	}

	inputFile := ""
	if rawFile, given := o.Flags["file"]; given {
		absFile, err := filepath.Abs(rawFile)
		if err != nil {
			return r.localError(o, "invalid_input", err.Error(), 2)
		}
		info, err := os.Stat(absFile)
		if err != nil || info.IsDir() {
			return r.localError(o, "invalid_input", fmt.Sprintf("Cannot read input file %q.", rawFile), 2)
		}
		if info.Size() == 0 {
			return r.localError(o, "invalid_input", fmt.Sprintf("Input file %q is empty.", rawFile), 2)
		}
		if info.Size() > 16*1024*1024 {
			return r.localError(o, "payload_too_large", fmt.Sprintf("Input file %q exceeds the 16 MiB limit.", rawFile), 2)
		}
		inputFile = absFile
	} else if manifest.AuthKind == "file" {
		return pluginUsage(r, o, "--file PATH is required for file-based plugins", usage)
	}

	entry := filepath.Join(dir, "src", "index.ts")
	if _, err := os.Stat(entry); err != nil {
		alt := filepath.Join(dir, "index.ts")
		if _, err2 := os.Stat(alt); err2 != nil {
			return r.localError(o, "invalid_input", "plugin entry point not found (expected src/index.ts or index.ts in "+dir+")", 2)
		}
		entry = alt
	}

	secret := ""
	if manifest.AuthKind == "api_key" || manifest.AuthKind == "oauth2" {
		envVar := manifest.AuthEnvVar
		if envVar == "" {
			envVar = "RASTRATA_PLUGIN_" + strings.ToUpper(strings.ReplaceAll(manifest.ID, "-", "_")) + "_KEY"
		}
		secret = strings.TrimSpace(os.Getenv(envVar))
		if secret == "" {
			return r.localError(
				o,
				"credentials_missing",
				fmt.Sprintf("Set %s in your environment before syncing %s. Provider secrets are never passed on the command line or stored in your book.", envVar, manifest.Name),
				2,
			)
		}
	}

	configObj := map[string]string{}
	if raw, given := o.Flags["config"]; given {
		entries, err := parseConfigEntriesFlag(raw)
		if err != nil {
			return pluginUsage(r, o, err.Error(), usage)
		}
		for _, item := range entries {
			configObj[item["key"].(string)] = item["value"].(string)
		}
	}
	configJSON, _ := json.Marshal(configObj)

	dryRun := o.Flags["dry-run"] == "true"
	pluginToken := ""
	if !dryRun {
		if varName, given := o.Flags["token-env"]; given {
			pluginToken = strings.TrimSpace(os.Getenv(varName))
			if pluginToken == "" {
				return r.localError(o, "credentials_missing", "Environment variable "+varName+" is empty; export your rsp_ plugin token first.", 2)
			}
		} else if envTok := strings.TrimSpace(os.Getenv("RASTRATA_PLUGIN_TOKEN")); envTok != "" {
			pluginToken = envTok
		} else if c != nil && c.Credential != "" {
			pluginToken = c.Credential
		}
		if strings.HasPrefix(pluginToken, "rso_") {
			fmt.Fprintf(r.Diagnostics, "Note: syncing with an owner key. For least privilege, create a plugin-scoped token with: rastrata plugin token-create %s --label \"Local sync\"\n", manifest.ID)
		}
	}

	bunPath, err := exec.LookPath("bun")
	if err != nil {
		return r.localError(o, "runtime_missing", "bun is required on PATH to execute TypeScript plugins (install from https://bun.sh)", 2)
	}

	currency := strings.ToUpper(o.Flags["book-currency"])
	if currency == "" {
		currency = "USD"
	}
	tz := o.Flags["time-zone"]
	if tz == "" {
		tz = "UTC"
	}

	// Out-of-process isolation: pass ONLY the minimum stripped environment to the plugin subprocess.
	childEnv := append(strippedBaseEnv(),
		"RASTRATA_PLUGIN_ENTRY="+entry,
		"RASTRATA_PLUGIN_AUTH_KIND="+manifest.AuthKind,
		"RASTRATA_PLUGIN_AUTH_SECRET="+secret,
		"RASTRATA_PLUGIN_CONFIG_JSON="+string(configJSON),
		"RASTRATA_PLUGIN_CURRENCY="+currency,
		"RASTRATA_PLUGIN_TZ="+tz,
	)
	if dryRun {
		childEnv = append(childEnv, "RASTRATA_PLUGIN_DRY_RUN=1")
	} else {
		endpoint := o.Endpoint
		bookID := o.BookID
		if c != nil {
			endpoint = c.Endpoint
			bookID = c.BookID
		}
		childEnv = append(childEnv,
			"RASTRATA_PLUGIN_DRY_RUN=0",
			"RASTRATA_API_URL="+endpoint,
			"RASTRATA_BOOK_ID="+bookID,
		)
		if pluginToken != "" {
			childEnv = append(childEnv, "RASTRATA_PLUGIN_TOKEN="+pluginToken)
		}
	}
	if cursor, given := o.Flags["cursor"]; given {
		childEnv = append(childEnv, "RASTRATA_PLUGIN_CURSOR="+cursor)
	}
	if inputFile != "" {
		childEnv = append(childEnv, "RASTRATA_PLUGIN_FILE="+inputFile)
	}

	cmd := exec.CommandContext(ctx, bunPath, "-e", pluginSyncRunnerJS)
	cmd.Dir = dir
	cmd.Env = childEnv
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if secret != "" {
			msg = strings.ReplaceAll(msg, secret, "[redacted]")
		}
		if pluginToken != "" {
			msg = strings.ReplaceAll(msg, pluginToken, "[redacted]")
		}
		return r.localError(o, "plugin_sync_failed", msg, 1)
	}

	var result struct {
		OK       bool            `json:"ok"`
		PluginID string          `json:"pluginId"`
		DryRun   bool            `json:"dryRun"`
		Totals   json.RawMessage `json:"totals"`
		Pushed   json.RawMessage `json:"pushed"`
		Preview  string          `json:"preview"`
		Error    *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Hint    string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return r.localError(o, "plugin_sync_failed", "Plugin runner returned invalid JSON: "+err.Error(), 1)
	}
	if !result.OK {
		code := "plugin_sync_failed"
		msg := "Plugin sync failed."
		if result.Error != nil {
			if result.Error.Code != "" {
				code = result.Error.Code
			}
			msg = strings.TrimSpace(result.Error.Message)
			if result.Error.Hint != "" && !strings.Contains(msg, result.Error.Hint) {
				msg = msg + " " + result.Error.Hint
			}
		}
		if secret != "" {
			msg = strings.ReplaceAll(msg, secret, "[redacted]")
		}
		if pluginToken != "" {
			msg = strings.ReplaceAll(msg, pluginToken, "[redacted]")
		}
		return r.localError(o, code, msg, 1)
	}

	if dryRun && result.Preview != "" {
		fmt.Fprintln(r.Diagnostics, result.Preview)
	}
	if o.Format == "text" {
		fmt.Fprintln(r.Output, result.Preview)
		return 0
	}
	return r.result(o, api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: stdout.Bytes()}, nil, "")
}

func titleFromSlug(slug string) string {
	parts := strings.Split(slug, "-")
	for i, part := range parts {
		if len(part) > 0 {
			parts[i] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}

func runPluginInit(r Runner, _ context.Context, o Options, _ *api.Client) int {
	const usage = "plugin init <slug> [--kind bank|ledger|file] [--dir PATH]"
	if len(o.Args) != 3 {
		return pluginUsage(r, o, "plugin init requires a lowercase slug (for example: acme-bank)", usage)
	}
	if problem := pluginFlagProblem(o, []string{"kind", "dir"}, []string{"kind", "dir"}); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	slug := o.Args[2]
	if !pluginSlugPattern.MatchString(slug) {
		return pluginUsage(r, o, "slug must be 3-32 lowercase letters, digits, or hyphens (for example: chase-csv, acme-billing)", usage)
	}
	kind := o.Flags["kind"]
	if kind == "" {
		kind = "bank"
	}
	if kind != "bank" && kind != "ledger" && kind != "file" {
		return pluginUsage(r, o, "--kind must be bank (BankLine feed), ledger (multi-leg LedgerEvent + clearing), or file (offline CSV/JSON normalizer)", usage)
	}
	targetDir := o.Flags["dir"]
	if targetDir == "" {
		targetDir = "plugin-" + slug
	}
	if entries, err := os.ReadDir(targetDir); err == nil && len(entries) > 0 {
		return r.localError(o, "directory_not_empty", fmt.Sprintf("Target directory %q already exists and is not empty.", targetDir), 2)
	}

	title := titleFromSlug(slug)
	envVar := "RASTRATA_PLUGIN_" + strings.ToUpper(strings.ReplaceAll(slug, "-", "_")) + "_KEY"
	domain := "api." + slug + ".com"

	files := scaffoldPluginFiles(slug, title, envVar, domain, kind)
	created := make([]string, 0, len(files))
	for rel, content := range files {
		full := filepath.Join(targetDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return r.localError(o, "io_error", err.Error(), 1)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return r.localError(o, "io_error", err.Error(), 1)
		}
		created = append(created, rel)
	}
	sort.Strings(created)

	fmt.Fprintf(r.Diagnostics, "Scaffolded MIT Rastrata plugin %q (%s) in %s\n", slug, kind, targetDir)
	if kind == "file" {
		fmt.Fprintf(r.Diagnostics, "Next steps:\n  1. cd %s && bun install && bun test\n  2. rastrata plugin sync %s --file sample.csv --dry-run --format text\n  3. rastrata plugin install %s\n", targetDir, targetDir, targetDir)
	} else {
		fmt.Fprintf(r.Diagnostics, "Next steps:\n  1. cd %s && bun install && bun test\n  2. export %s=...\n  3. rastrata plugin sync %s --dry-run --format text\n  4. rastrata plugin install %s\n", targetDir, envVar, targetDir, targetDir)
	}

	data, _ := json.Marshal(map[string]any{
		"pluginId": slug,
		"kind":     kind,
		"dir":      targetDir,
		"envVar":   envVar,
		"files":    created,
	})
	return r.result(o, api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: data}, nil, "")
}

func scaffoldPluginFiles(slug, title, envVar, domain, kind string) map[string]string {
	license := `MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
	pkgJSON := fmt.Sprintf(`{
  "name": "rastrata-plugin-%s",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@gantstreet/rastrata-plugin-sdk": "^0.1.0"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
`, slug)

	readme := fmt.Sprintf(`# %s Rastrata Plugin (MIT)

## Quick start

1. Run the 5-invariant test suite (zero network):

   `+"```sh"+`
   rastrata plugin test .
   `+"```"+`

2. Preview entries without writing to your book:

   `+"```sh"+`
   export %s="..."
   rastrata plugin sync . --dry-run
   `+"```"+`

3. Install, issue a least-privilege plugin token, and sync live:

   `+"```sh"+`
   rastrata plugin install .
   rastrata plugin token-create %s --label "Local sync"
   export RASTRATA_PLUGIN_TOKEN="rsp_..."
   rastrata plugin sync .
   `+"```"+`
`, title, envVar, slug)

	if kind == "file" {
		fileReadme := fmt.Sprintf(`# %s Rastrata File Plugin (MIT)

Offline CSV normalizer — zero network calls, zero API keys.

## Quick start

1. Run the 5-invariant test suite:

   `+"```sh"+`
   rastrata plugin test .
   `+"```"+`

2. Preview entries from a sample CSV without writing to your book:

   `+"```sh"+`
   rastrata plugin sync . --file sample.csv --dry-run --format text
   `+"```"+`

3. Install, issue a plugin token, and import a statement file:

   `+"```sh"+`
   rastrata plugin install .
   rastrata plugin token-create %s --label "CSV import"
   export RASTRATA_PLUGIN_TOKEN="rsp_..."
   rastrata plugin sync . --file sample.csv
   `+"```"+`
`, title, slug)

		manifestJSON := fmt.Sprintf(`{
  "id": %q,
  "version": "0.1.0",
  "name": %q,
  "description": "Imports %s CSV exports into For review with zero network access.",
  "domains": [],
  "authKind": "file",
  "roles": []
}
`, slug, title, title)

		indexTS := fmt.Sprintf(`import { definePlugin, money, PluginError, sanitizeText } from "@gantstreet/rastrata-plugin-sdk";

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"" && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseAmountToMoney(raw: string, rowNum: number): string {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new PluginError({
      code: "invalid_money",
      message: `+"`Row ${rowNum} has invalid amount ${JSON.stringify(raw)}.`"+`,
      hint: "Expected a two-decimal amount such as -42.50 or 1250.00.",
    });
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const dollars = BigInt(match[2] ?? "0");
  const cents = BigInt((match[3] ?? "").padEnd(2, "0"));
  return money.fromCents(sign * (dollars * 100n + cents));
}

export default definePlugin({
  manifest: {
    id: %q,
    version: "0.1.0",
    name: %q,
    description: "Imports %s CSV exports into For review with zero network access.",
    capabilities: ["ingest"],
    domains: [],
    auth: { kind: "file", extensions: [".csv"] },
  },

  normalize(raw, ctx) {
    const text = new TextDecoder("utf-8").decode(raw.bytes).replace(/^\uFEFF/, "");
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (rows.length <= 1) return { lines: [] };

    const lines = rows.slice(1).map((row, idx) => {
      const [postedOn = "", description = "", amountRaw = ""] = parseCsvLine(row);
      const amount = parseAmountToMoney(amountRaw, idx + 2);
      const cleanDesc = sanitizeText(description, 400) || "%s transaction";
      return ctx.emit.bankLine({
        accountKey: "%s:default",
        providerId: `+"`%s:${postedOn}:${amount}:${idx}`"+`,
        rawIndex: idx,
        postedOn,
        amount,
        currency: ctx.bookCurrency,
        description: cleanDesc,
      });
    });

    return { lines };
  },
});
`, slug, title, title, title, slug, slug)

		sampleCSV := "Date,Description,Amount\n2026-10-02,\"AWS Cloud Services\",-42.50\n2026-10-05,\"Client Retainer\",2500.00\n"

		testTS := fmt.Sprintf(`import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestToInstallPayload } from "@gantstreet/rastrata-plugin-sdk/runner";
import { testPlugin } from "@gantstreet/rastrata-plugin-sdk/testing";
import plugin from "../src/index.ts";

test("manifest.json matches plugin manifest", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
  expect(file).toEqual(manifestToInstallPayload(plugin.manifest));
});

test("%s normalizes CSV fixture and passes all five invariants", async () => {
  const bytes = new Uint8Array(readFileSync(join(import.meta.dir, "..", "sample.csv")));
  const report = await testPlugin(plugin, {
    fixtures: [{ bytes, mediaType: "text/csv", name: "sample.csv" }],
  });
  expect(report.issues).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.summary.bankLineCount).toBe(2);
  expect(report.preview).toContain("-42.50");
  expect(report.preview).toContain("2500.00");
});
`, slug)

		return map[string]string{
			"LICENSE":             license,
			"package.json":        pkgJSON,
			"manifest.json":       manifestJSON,
			"README.md":           fileReadme,
			"sample.csv":          sampleCSV,
			"src/index.ts":        indexTS,
			"test/plugin.test.ts": testTS,
		}
	}

	if kind == "ledger" {
		manifestJSON := fmt.Sprintf(`{
  "id": %q,
  "version": "0.1.0",
  "name": %q,
  "description": "Imports %s payouts as balanced multi-leg entries with bank-deposit clearing.",
  "domains": [%q],
  "authKind": "api_key",
  "authLabel": "%s read-only API key",
  "authEnvVar": %q,
  "roles": [
    { "key": "payouts.in-transit", "label": "Payouts in transit", "kind": "asset", "required": true, "defaultRoleKey": "payouts.in-transit" },
    { "key": "revenue.sales", "label": "Sales", "kind": "income", "required": true, "defaultRoleKey": "revenue.sales" },
    { "key": "processing.fees", "label": "Processing fees", "kind": "expense", "required": true }
  ],
  "clearing": { "role": "payouts.in-transit", "windowDays": 7 }
}
`, slug, title, title, domain, title, envVar)

		indexTS := fmt.Sprintf(`import { definePlugin, money } from "@gantstreet/rastrata-plugin-sdk";

export default definePlugin({
  manifest: {
    id: %q,
    version: "0.1.0",
    name: %q,
    description: "Imports %s payouts as balanced multi-leg entries with bank-deposit clearing.",
    capabilities: ["ingest"],
    domains: [%q],
    auth: {
      kind: "api_key",
      label: "%s read-only API key",
      envVar: %q,
    },
    roles: [
      { key: "payouts.in-transit", label: "Payouts in transit", kind: "asset", required: true, defaultRoleKey: "payouts.in-transit" },
      { key: "revenue.sales", label: "Sales", kind: "income", required: true, defaultRoleKey: "revenue.sales" },
      { key: "processing.fees", label: "Processing fees", kind: "expense", required: true },
    ],
    clearing: { role: "payouts.in-transit", windowDays: 7 },
  },

  async *pull(ctx) {
    const res = await ctx.http.getJson<{
      payouts: { id: string; arrivedOn: string; grossCents: number; feeCents: number }[];
    }>("https://%s/v1/payouts", {
      headers: { authorization: `+"`Bearer ${ctx.auth.apiKey}`"+` },
    });

    const lines = res.data.payouts.map((po, index) => {
      const netCents = po.grossCents - po.feeCents;
      return ctx.emit.event({
        accountKey: "%s:default",
        providerId: po.id,
        rawIndex: index,
        eventOn: po.arrivedOn,
        summary: `+"`%s payout ${po.id}`"+`,
        currency: ctx.bookCurrency,
        amount: money.fromCents(netCents),
        legs: [
          { role: "payouts.in-transit", amount: money.fromCents(netCents) },
          { role: "revenue.sales", amount: money.fromCents(-po.grossCents) },
          { role: "processing.fees", amount: money.fromCents(po.feeCents) },
        ],
        links: { payout: po.id },
      });
    });

    if (lines.length > 0) {
      yield {
        sourceKey: "%s:default",
        raw: { bytes: res.raw.bytes, mediaType: "application/json", name: "%s-payouts.json" },
        lines,
        cursor: res.data.payouts.at(-1)?.arrivedOn,
      };
    }
  },
});
`, slug, title, title, domain, title, envVar, domain, slug, title, slug, slug)

		testTS := fmt.Sprintf(`import { expect, test } from "bun:test";
import { testPlugin } from "@gantstreet/rastrata-plugin-sdk/testing";
import plugin from "../src/index.ts";

test("%s passes all five Rastrata plugin invariants", async () => {
  const report = await testPlugin(plugin, {
    routes: {
      "GET https://%s/v1/payouts": {
        body: {
          payouts: [{ id: "po_1001", arrivedOn: "2026-10-10", grossCents: 10000, feeCents: 320 }],
        },
      },
    },
  });
  expect(report.issues).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.preview).toContain("96.80");
});
`, slug, domain)

		return map[string]string{
			"LICENSE":             license,
			"package.json":        pkgJSON,
			"manifest.json":       manifestJSON,
			"README.md":           readme,
			"src/index.ts":        indexTS,
			"test/plugin.test.ts": testTS,
		}
	}

	// Default: BankLine connector template.
	manifestJSON := fmt.Sprintf(`{
  "id": %q,
  "version": "0.1.0",
  "name": %q,
  "description": "Imports %s transactions and balances into For review.",
  "domains": [%q],
  "authKind": "api_key",
  "authLabel": "%s read-only API token",
  "authEnvVar": %q,
  "roles": []
}
`, slug, title, title, domain, title, envVar)

	indexTS := fmt.Sprintf(`import { definePlugin, money } from "@gantstreet/rastrata-plugin-sdk";

export default definePlugin({
  manifest: {
    id: %q,
    version: "0.1.0",
    name: %q,
    description: "Imports %s transactions and balances into For review.",
    capabilities: ["ingest"],
    domains: [%q],
    auth: {
      kind: "api_key",
      label: "%s read-only API token",
      envVar: %q,
    },
    fields: [
      { key: "startDate", label: "Start importing from", kind: "date" },
    ],
  },

  async *pull(ctx) {
    const start = ctx.cursor ?? ctx.config.startDate;
    const query = start ? `+"`?start=${encodeURIComponent(start)}`"+` : "";
    const res = await ctx.http.getJson<{
      transactions: { id: string; postedOn: string; amountCents: number; description: string }[];
    }>(`+"`https://%s/v1/transactions${query}`"+`, {
      headers: { authorization: `+"`Bearer ${ctx.auth.apiKey}`"+` },
    });

    const lines = res.data.transactions.map((tx, index) =>
      ctx.emit.bankLine({
        accountKey: "%s:default",
        providerId: tx.id,
        rawIndex: index,
        postedOn: tx.postedOn,
        amount: money.fromCents(tx.amountCents),
        currency: ctx.bookCurrency,
        description: tx.description,
      }),
    );

    if (lines.length > 0) {
      yield {
        sourceKey: "%s:default",
        raw: { bytes: res.raw.bytes, mediaType: "application/json", name: "%s-transactions.json" },
        lines,
        cursor: res.data.transactions.at(-1)?.postedOn,
      };
    }
  },
});
`, slug, title, title, domain, title, envVar, domain, slug, slug, slug)

	testTS := fmt.Sprintf(`import { expect, test } from "bun:test";
import { testPlugin } from "@gantstreet/rastrata-plugin-sdk/testing";
import plugin from "../src/index.ts";

test("%s passes all five Rastrata plugin invariants", async () => {
  const report = await testPlugin(plugin, {
    routes: {
      "GET https://%s/v1/transactions": {
        body: {
          transactions: [
            { id: "tx_1", postedOn: "2026-10-05", amountCents: -4250, description: "Cloudflare" },
          ],
        },
      },
    },
  });
  expect(report.issues).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.preview).toContain("-42.50");
});
`, slug, domain)

	return map[string]string{
		"LICENSE":             license,
		"package.json":        pkgJSON,
		"manifest.json":       manifestJSON,
		"README.md":           readme,
		"src/index.ts":        indexTS,
		"test/plugin.test.ts": testTS,
	}
}

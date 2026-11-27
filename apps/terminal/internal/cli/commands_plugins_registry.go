package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const defaultPluginRegistryURL = "https://raw.githubusercontent.com/Gant-Street/rastrata-plugins/main/registry.json"

type pluginRegistryDocument struct {
	Version   int                   `json:"version"`
	UpdatedAt string                `json:"updatedAt,omitempty"`
	Plugins   []pluginRegistryEntry `json:"plugins"`
}

type pluginRegistryEntry struct {
	ID          string             `json:"id"`
	Version     string             `json:"version"`
	Name        string             `json:"name"`
	Description string             `json:"description"`
	Tier        string             `json:"tier"`
	Repository  string             `json:"repository,omitempty"`
	Path        string             `json:"path,omitempty"`
	Manifest    pluginManifestFile `json:"manifest"`
}

// builtInOfficialRegistry provides offline fallback entries for dogfooded official plugins
// so `rastrata plugin search` and `rastrata plugin install stripe` work even without network access.
func builtInOfficialRegistry() pluginRegistryDocument {
	return pluginRegistryDocument{
		Version: 1,
		Plugins: []pluginRegistryEntry{
			{
				ID:          "stripe",
				Version:     "1.0.0",
				Name:        "Stripe",
				Description: "Imports Stripe payouts as balanced multi-leg entries (sales, tax, refunds, disputes, fees) with automatic bank-deposit clearing.",
				Tier:        "official",
				Repository:  "https://github.com/Gant-Street/rastrata",
				Path:        "packages/plugin-stripe",
				Manifest: pluginManifestFile{
					ID:          "stripe",
					Version:     "1.0.0",
					Name:        "Stripe",
					Description: "Imports Stripe payouts as balanced multi-leg entries (sales, tax, refunds, disputes, fees) with automatic bank-deposit clearing.",
					Domains:     []string{"api.stripe.com"},
					AuthKind:    "api_key",
					AuthLabel:   "Stripe restricted read-only key",
					AuthEnvVar:  "RASTRATA_PLUGIN_STRIPE_KEY",
					Roles: []pluginRoleSpec{
						{Key: "payouts.in-transit", Label: "Payouts in transit", Kind: "asset", Required: true, DefaultRoleKey: "payouts.in-transit"},
						{Key: "revenue.sales", Label: "Sales", Kind: "income", Required: true, DefaultRoleKey: "revenue.sales"},
						{Key: "tax.sales", Label: "Sales tax payable", Kind: "liability", Required: true, DefaultRoleKey: "tax.sales"},
						{Key: "refunds", Label: "Refunds", Kind: "income", Required: true, DefaultRoleKey: "refunds"},
						{Key: "chargebacks", Label: "Chargebacks and disputes", Kind: "expense", Required: true, DefaultRoleKey: "chargebacks"},
						{Key: "stripe.fees", Label: "Stripe fees", Kind: "expense", Required: true, DefaultRoleKey: "stripe.fees"},
						{Key: "stripe.adjustments", Label: "Other Stripe adjustments", Kind: "expense", Required: false, DefaultRoleKey: "stripe.adjustments"},
					},
					Clearing: &pluginClearingSpec{Role: "payouts.in-transit", WindowDays: 7},
				},
			},
		},
	}
}

func loadPluginRegistry(ctx context.Context, explicitSource string) (pluginRegistryDocument, string, error) {
	source := strings.TrimSpace(explicitSource)
	explicit := source != ""
	if !explicit {
		source = strings.TrimSpace(os.Getenv("RASTRATA_PLUGIN_REGISTRY"))
		explicit = source != ""
	}
	if source == "" {
		source = defaultPluginRegistryURL
	}

	var raw []byte
	var err error
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		parsed, parseErr := url.Parse(source)
		if parseErr != nil {
			return pluginRegistryDocument{}, "", fmt.Errorf("invalid registry URL %q: %w", source, parseErr)
		}
		if parsed.Scheme != "https" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
			return pluginRegistryDocument{}, "", fmt.Errorf("registry URL must use https (got %q)", source)
		}
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if reqErr != nil {
			return pluginRegistryDocument{}, "", reqErr
		}
		req.Header.Set("Accept", "application/json")
		client := &http.Client{Timeout: 8 * time.Second}
		resp, doErr := client.Do(req)
		if doErr != nil {
			if !explicit {
				return builtInOfficialRegistry(), "built-in catalog", nil
			}
			return pluginRegistryDocument{}, "", fmt.Errorf("could not fetch registry %q: %w", source, doErr)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			if !explicit {
				return builtInOfficialRegistry(), "built-in catalog", nil
			}
			return pluginRegistryDocument{}, "", fmt.Errorf("registry %q returned HTTP %d", source, resp.StatusCode)
		}
		raw, err = io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
		if err != nil {
			return pluginRegistryDocument{}, "", fmt.Errorf("could not read registry %q: %w", source, err)
		}
	} else {
		raw, err = os.ReadFile(source)
		if err != nil {
			return pluginRegistryDocument{}, "", fmt.Errorf("could not read registry file %q: %w", source, err)
		}
	}

	var doc pluginRegistryDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		if !explicit {
			return builtInOfficialRegistry(), "built-in catalog", nil
		}
		return pluginRegistryDocument{}, "", fmt.Errorf("invalid registry JSON in %q: %w", source, err)
	}
	if doc.Version != 1 {
		return pluginRegistryDocument{}, "", fmt.Errorf("unsupported plugin registry version %d (expected 1)", doc.Version)
	}
	return doc, source, nil
}

func resolvePluginManifest(ctx context.Context, target, registrySource string) (pluginManifestFile, string, error) {
	if _, err := os.Stat(target); err == nil {
		return loadPluginManifest(target)
	}
	if !pluginSlugPattern.MatchString(target) {
		return loadPluginManifest(target)
	}
	doc, source, err := loadPluginRegistry(ctx, registrySource)
	if err != nil {
		return pluginManifestFile{}, "", err
	}
	for _, entry := range doc.Plugins {
		if entry.ID == target {
			manifest := entry.Manifest
			if manifest.ID == "" {
				manifest.ID = entry.ID
			}
			if !pluginSlugPattern.MatchString(manifest.ID) {
				return pluginManifestFile{}, "", fmt.Errorf("registry entry %q has invalid manifest id", target)
			}
			return manifest, source, nil
		}
	}
	return pluginManifestFile{}, "", fmt.Errorf("plugin %q not found on disk or in %s (run `rastrata plugin search` to list available plugins)", target, source)
}

func runPluginSearch(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "plugin search [query] [--registry URL-OR-FILE]"
	if len(o.Args) < 2 || len(o.Args) > 3 {
		return pluginUsage(r, o, "plugin search takes at most one query", usage)
	}
	if problem := pluginFlagProblem(o, []string{"registry"}, []string{"registry"}); problem != "" {
		return pluginUsage(r, o, problem, usage)
	}
	query := ""
	if len(o.Args) == 3 {
		query = strings.ToLower(strings.TrimSpace(o.Args[2]))
	}
	doc, source, err := loadPluginRegistry(ctx, o.Flags["registry"])
	if err != nil {
		return r.localError(o, "registry_unavailable", err.Error(), 4)
	}

	matches := make([]pluginRegistryEntry, 0, len(doc.Plugins))
	for _, entry := range doc.Plugins {
		if query == "" ||
			strings.Contains(strings.ToLower(entry.ID), query) ||
			strings.Contains(strings.ToLower(entry.Name), query) ||
			strings.Contains(strings.ToLower(entry.Description), query) {
			matches = append(matches, entry)
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].Tier != matches[j].Tier {
			return matches[i].Tier == "official"
		}
		return matches[i].ID < matches[j].ID
	})

	if o.Format == "text" {
		if len(matches) == 0 {
			fmt.Fprintf(r.Output, "No plugins matched %q in %s.\n", query, source)
			return 0
		}
		for _, entry := range matches {
			hosts := strings.Join(entry.Manifest.Domains, ", ")
			if hosts == "" {
				hosts = "offline"
			}
			fmt.Fprintf(r.Output, "%-16s v%-8s %-10s %-24s %s\n", entry.ID, entry.Version, entry.Tier, hosts, entry.Description)
		}
		return 0
	}

	payload, _ := json.Marshal(map[string]any{
		"source":  source,
		"plugins": matches,
	})
	return r.result(o, api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: payload}, nil, "")
}

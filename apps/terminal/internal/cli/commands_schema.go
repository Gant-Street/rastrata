package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// schemaCommand is `schema [OPERATION]` and `schema --check [--live]`.
//
// `schema` prints the operation catalog, or one operation with its inputs, outputs and whether it
// is stable (frozen: it will not break within this contract version) or a preview.
//
// `schema --check` says whether this build still honours the frozen contract it was made against.
// With `--live` it also asks the running service for the catalog it serves and says whether that
// service still honours the frozen contract and still understands what this build sends. Exit 0
// means compatible, 3 means something is not, 4 means the service could not be reached.
// docs/reference/contract-policy.md has the rules.
func (r Runner) schemaCommand(ctx context.Context, o Options) int {
	allowed := map[string]bool{"check": true, "live": true}
	names := make([]string, 0, len(o.Flags))
	for name := range o.Flags {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !allowed[name] {
			return r.localError(o, "usage_error", "unknown option --"+name, 2)
		}
		if value := o.Flags[name]; value != "true" && value != "false" {
			return r.localError(o, "usage_error", "--"+name+" takes no value", 2)
		}
	}
	check, live := o.Flags["check"] == "true", o.Flags["live"] == "true"
	if live && !check {
		return r.localError(o, "usage_error", "--live is an option of --check: use schema --check --live", 2)
	}
	if !check {
		return r.schema(o)
	}
	if len(o.Args) != 1 {
		return r.localError(o, "usage_error", "schema --check takes no operation", 2)
	}
	return r.schemaCheck(ctx, o, live)
}

type compatReport struct {
	Compatible bool          `json:"compatible"`
	Breaking   []api.Finding `json:"breaking"`
	Extended   []string      `json:"extended"`
}

type serviceReport struct {
	Endpoint string `json:"endpoint"`
	Contract string `json:"contract"`
	// FrozenHonoured is whether the service still keeps every promise of the frozen contract.
	FrozenHonoured compatReport `json:"frozenHonoured"`
	// UnderstoodByThisBuild is whether the service accepts what this build sends and this build can
	// read what it returns, for every operation both know.
	UnderstoodByThisBuild compatReport `json:"understoodByThisBuild"`
	// Unavailable are operations this build knows and the service does not (an older service).
	Unavailable []string `json:"unavailable"`
	// Newer are operations the service has and this build does not (a newer service).
	Newer []string `json:"newer"`
}

type checkReport struct {
	Contract          string         `json:"contract"`
	FrozenOn          string         `json:"frozenOn"`
	FrozenOperations  int            `json:"frozenOperations"`
	PreviewOperations int            `json:"previewOperations"`
	BuiltIn           compatReport   `json:"builtIn"`
	Service           *serviceReport `json:"service"`
	Compatible        bool           `json:"compatible"`
}

func report(comparison api.Comparison) compatReport {
	return compatReport{Compatible: len(comparison.Breaking) == 0, Breaking: comparison.Breaking, Extended: comparison.Extended}
}

func (r Runner) schemaCheck(ctx context.Context, o Options, live bool) int {
	built := api.BuiltInContract()
	frozen := api.FrozenContract()
	frozenSet := api.FrozenSet()
	result := checkReport{
		Contract:          built.Version,
		FrozenOn:          frozen.FrozenOn,
		FrozenOperations:  len(frozen.Operations),
		PreviewOperations: len(built.Operations) - len(frozen.Operations),
		BuiltIn:           report(api.Compare(frozen.ContractView, api.ViewOf(built, frozenSet))),
	}
	result.Compatible = result.BuiltIn.Compatible
	if live {
		credential, _, err := credentialFor(&o)
		if err != nil {
			return r.localError(o, "usage_error", err.Error(), 2)
		}
		client, err := api.New(o.Endpoint, o.BookID, o.Directory)
		if err != nil {
			return r.localError(o, "usage_error", err.Error(), 2)
		}
		client.Credential = credential
		served, err := client.Schema(ctx)
		if err != nil {
			var failure *api.Error
			if errors.As(err, &failure) {
				_ = json.NewEncoder(r.Output).Encode(failure.Response)
				fmt.Fprintln(r.Diagnostics, err)
				if failure.Response.Error != nil && failure.Response.Error.Code == "connection_failed" {
					return 4
				}
				return 3
			}
			return r.localError(o, "client_error", err.Error(), 4)
		}
		both := map[string]bool{}
		unavailable := []string{}
		servedNames := map[string]bool{}
		for _, operation := range served.Operations {
			servedNames[operation.Name] = true
		}
		for _, operation := range built.Operations {
			if servedNames[operation.Name] {
				both[operation.Name] = true
			} else {
				unavailable = append(unavailable, operation.Name)
			}
		}
		sort.Strings(unavailable)
		understood := api.Compare(api.ViewOf(built, both), api.ViewOf(served, nil))
		result.Service = &serviceReport{
			Endpoint:              client.Endpoint,
			Contract:              served.Version,
			FrozenHonoured:        report(api.Compare(frozen.ContractView, api.ViewOf(served, frozenSet))),
			UnderstoodByThisBuild: report(api.Comparison{Breaking: understood.Breaking, Extended: understood.Extended}),
			Unavailable:           unavailable,
			Newer:                 understood.Added,
		}
		result.Compatible = result.Compatible && result.Service.FrozenHonoured.Compatible && result.Service.UnderstoodByThisBuild.Compatible
	}
	data, _ := json.Marshal(result)
	envelope := api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: data}
	if o.Format == "text" {
		var formatted bytes.Buffer
		_ = json.Indent(&formatted, data, "", "  ")
		fmt.Fprintln(r.Output, formatted.String())
	} else {
		_ = json.NewEncoder(r.Output).Encode(envelope)
	}
	if !result.Compatible {
		fmt.Fprintln(r.Diagnostics, "The contract is not honoured: "+strings.Join(summaries(result), "; ")+". See docs/reference/contract-policy.md.")
		return 3
	}
	return 0
}

// summaries is a short line per problem, for a person reading standard error.
func summaries(result checkReport) []string {
	lines := []string{}
	add := func(label string, findings []api.Finding) {
		for _, finding := range findings {
			path := finding.Operation
			if finding.Path != "" {
				path += " " + finding.Path
			}
			lines = append(lines, label+": "+path+" "+finding.Message)
		}
	}
	add("this build", result.BuiltIn.Breaking)
	if result.Service != nil {
		add("the service", result.Service.FrozenHonoured.Breaking)
		add("this build against the service", result.Service.UnderstoodByThisBuild.Breaking)
	}
	return lines
}

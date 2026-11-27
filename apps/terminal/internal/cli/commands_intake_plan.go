package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The plan, the status and the friction log of the intake lane.
//
//	rastrata intake plan --input PLAN.json [--cutover D] [--through D] [--fresh=true] [--gaps-only=true] [--check=true] [--record=false]
//	rastrata intake status
//	rastrata intake friction add --kind K --reason TEXT [--source S] [--key K]
//	rastrata intake friction resolve --key K [--note TEXT]
//	rastrata intake friction list [--status open|resolved|all] [--kind K] [--page N]
//	rastrata intake friction export [--status open|resolved|all] [--kind K]
//
// The plan input names files by the SHA-256 the scan returned, never by path: a path in a file the
// customer's agent wrote would be a path taken from file contents, and nothing here reads one.

const (
	intakePlanUsage     = "intake plan --input PLAN.json|- [--cutover YYYY-MM-DD] [--through YYYY-MM-DD] [--fresh=true] [--gaps-only=true] [--check=true] [--record=false]"
	intakeFrictionUsage = "intake friction add --kind KIND --reason TEXT [--source S] [--key K] | resolve --key K [--note TEXT] | list [--status open|resolved|all] [--kind KIND] [--page N] | export [--status S] [--kind KIND]"
)

func init() {
	Register(Command{
		Name:    "intake plan",
		Summary: "A checklist for the move-in: what is present, missing or uncertain, who acts and the next command; --input PLAN.json names files by the ids scan returned [--check=true exits 3 when not ready]",
		Run:     runIntakePlan,
	})
	Register(Command{
		Name:    "intake status",
		Summary: "How the move-in is going: time to the first import and reconciliation, interventions, unresolved gaps",
		Run:     runIntakeStatus,
	})
	Register(Command{
		Name:    "intake friction",
		Summary: "The friction log: where the move-in needed a person or a retry: add | resolve | list | export",
		Run:     runIntakeFriction,
	})
}

// readIntakeInput reads the JSON object --input names (a file, or - for standard input), at most
// 128 KiB.
func readIntakeInput(r Runner, o Options) (map[string]any, string) {
	input := map[string]any{}
	if o.Input == "" {
		return input, ""
	}
	reader := r.Input
	if o.Input != "-" {
		file, err := os.Open(o.Input)
		if err != nil {
			return nil, err.Error()
		}
		defer file.Close()
		reader = file
	}
	raw, err := io.ReadAll(io.LimitReader(reader, 131073))
	if err != nil || len(raw) > 131072 {
		return nil, "The input is unreadable or exceeds 128 KiB"
	}
	if err := json.Unmarshal(raw, &input); err != nil || input == nil {
		return nil, "The input must be one JSON object"
	}
	return input, ""
}

type planNext struct {
	Command string `json:"command"`
	File    string `json:"file"`
	Note    string `json:"note"`
}

type planItem struct {
	Code     string    `json:"code"`
	Status   string    `json:"status"`
	Required bool      `json:"required"`
	Owner    string    `json:"owner"`
	Account  string    `json:"account"`
	File     string    `json:"file"`
	Month    string    `json:"month"`
	Gate     string    `json:"gate"`
	Detail   string    `json:"detail"`
	Next     *planNext `json:"next"`
}

type planResult struct {
	CutoverDate *string `json:"cutoverDate"`
	Through     *string `json:"through"`
	Items       []planItem
	Counts      struct{ Present, Missing, Uncertain int }
	Ready       bool
	Truncated   bool
}

func runIntakePlan(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, intakePlanUsage) }
	if problem := intakeOptions(o.Flags, "cutover", "through", "fresh", "gaps-only", "check", "record"); problem != "" {
		return usage(problem)
	}
	if len(o.Args) != 2 {
		return usage("intake plan takes only options")
	}
	input, problem := readIntakeInput(r, o)
	if problem != "" {
		return r.localError(o, "input_unavailable", plain(problem), 2)
	}
	if o.Input == "" {
		return usage("Give the plan with --input PLAN.json (or - for standard input)")
	}
	if value, given := o.Flags["cutover"]; given {
		input["cutoverDate"] = value
	}
	if value, given := o.Flags["through"]; given {
		input["through"] = value
	}
	if o.Flags["fresh"] == "true" {
		input["fresh"] = true
	}
	if o.Flags["gaps-only"] == "true" {
		input["gapsOnly"] = true
	}
	response, err := c.Call(ctx, "intake.plan", input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	var plan planResult
	if err := json.Unmarshal(response.Data, &plan); err != nil {
		return r.localError(o, "client_error", err.Error(), 4)
	}
	if o.Flags["record"] != "false" {
		recordPlanFriction(ctx, r, c, input, plan)
	}
	if o.Format == "text" {
		printPlanText(r.Output, plan)
	} else {
		_ = json.NewEncoder(r.Output).Encode(response)
	}
	if o.Flags["check"] == "true" && !plan.Ready {
		return 3
	}
	return 0
}

// printPlanText is the plan for a person: the gaps first, each with what to do next.
func printPlanText(w io.Writer, plan planResult) {
	date := func(value *string) string {
		if value == nil {
			return "not set"
		}
		return *value
	}
	ready := "not ready"
	if plan.Ready {
		ready = "ready"
	}
	fmt.Fprintf(w, "Cutover %s, statements through %s: %s (%d present, %d missing, %d uncertain)\n",
		date(plan.CutoverDate), date(plan.Through), ready, plan.Counts.Present, plan.Counts.Missing, plan.Counts.Uncertain)
	for _, item := range plan.Items {
		if item.Status == "present" {
			continue
		}
		where := strings.TrimSpace(strings.Join([]string{item.Account, item.Month, shortHash(item.File)}, " "))
		required := ""
		if item.Required {
			required = " (required)"
		}
		fmt.Fprintf(w, "%-9s %s %s%s: %s\n", strings.ToUpper(item.Status), item.Code, plain(where), required, plain(item.Detail))
		if item.Next != nil {
			if item.Next.Command != "" {
				fmt.Fprintf(w, "          next: %s\n", plain(item.Next.Command))
			}
			fmt.Fprintf(w, "          %s acts: %s\n", item.Owner, plain(item.Next.Note))
		}
	}
	if plan.Truncated {
		fmt.Fprintln(w, "More items than are listed; deal with these first.")
	}
}

func shortHash(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

// ---- Friction ---------------------------------------------------------------------------------

// frictionEvent is one entry for intake.friction.
type frictionEvent struct {
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
	Reason string `json:"reason"`
	Key    string `json:"key,omitempty"`
}

// recordFriction writes events and resolves keys, and says nothing unless it cannot: a token that
// may not draft is not a reason to stop the intake.
func recordFriction(ctx context.Context, r Runner, c *api.Client, events []frictionEvent, resolve []string, note string) {
	if len(events) == 0 && len(resolve) == 0 {
		return
	}
	if len(events) > 50 {
		events = events[:50]
	}
	if len(resolve) > 50 {
		resolve = resolve[:50]
	}
	input := map[string]any{}
	if len(events) > 0 {
		input["events"] = events
	}
	if len(resolve) > 0 {
		input["resolve"] = resolve
		input["note"] = note
	}
	if _, err := c.Call(ctx, "intake.friction", input, api.NewOperationID()); err != nil {
		code := "unavailable"
		if failure, ok := err.(*api.Error); ok && failure.Response.Error != nil {
			code = failure.Response.Error.Code
		}
		if code == "book_not_configured" {
			fmt.Fprintln(r.Diagnostics, "The friction log was not written (book_not_configured): it is kept with the book, so set the book up and run the command again to log it.")
			return
		}
		fmt.Fprintf(r.Diagnostics, "The friction log was not written (%s). The intake goes on; record it with intake friction add when you can.\n", plain(code))
	}
}

func frictionKindFor(item planItem) string {
	switch {
	case item.Code == "cutover_date":
		return "cutover_needed"
	case item.Code == "source_account" || item.Code == "account_without_source":
		return "account_needed"
	case item.Code == "statement_ending_balance":
		return "balance_needed"
	case strings.HasPrefix(item.Code, "trial_balance"):
		return "trial_balance_problem"
	case item.Code == "unparsed_file":
		return "file_not_parsed"
	case item.Code == "duplicate_file":
		return "duplicate_file"
	case item.Gate == "date_order":
		return "date_order_unclear"
	case item.Code == "statement_readable" && item.Owner == "agent":
		return "recipe_needed"
	case item.Code == "statement_readable":
		return "gate_failed"
	default:
		return "coverage_gap"
	}
}

func planKey(item planItem) string {
	key := "plan:" + item.Code + ":" + item.Account + ":" + shortHash(item.File) + ":" + item.Month
	if len(key) > 120 {
		key = key[:120]
	}
	return key
}

// recordPlanFriction turns the required gaps of a plan into friction events, one open event for
// each, and resolves the events of earlier plans whose items are now present.
func recordPlanFriction(ctx context.Context, r Runner, c *api.Client, input map[string]any, plan planResult) {
	current := map[string]bool{}
	var events []frictionEvent
	for _, item := range plan.Items {
		if item.Status == "present" || !item.Required {
			continue
		}
		key := planKey(item)
		current[key] = true
		source := item.Account
		if item.File != "" {
			source = shortHash(item.File)
		}
		if source == "" {
			source = "plan"
		}
		events = append(events, frictionEvent{Kind: frictionKindFor(item), Source: source, Reason: item.Detail, Key: key})
	}
	// The plan itself is an event, once.
	var resolve []string
	for _, key := range openPlanKeys(ctx, c) {
		if !current[key] {
			resolve = append(resolve, key)
		}
	}
	events = append([]frictionEvent{{Kind: "plan", Source: "plan", Reason: fmt.Sprintf("planned the move-in: %d present, %d missing, %d uncertain", plan.Counts.Present, plan.Counts.Missing, plan.Counts.Uncertain)}}, events...)
	recordFriction(ctx, r, c, events, resolve, "the plan no longer lists it")
}

// openPlanKeys lists the keys of the open events the plan recorded.
func openPlanKeys(ctx context.Context, c *api.Client) []string {
	var keys []string
	for page := 1; page <= 20; page++ {
		response, err := c.Call(ctx, "intake.frictionList", map[string]any{"status": "open", "page": page, "pageSize": 100}, "")
		if err != nil {
			return keys
		}
		var listed struct {
			Count  int `json:"count"`
			Events []struct {
				Key string `json:"key"`
			} `json:"events"`
		}
		if json.Unmarshal(response.Data, &listed) != nil {
			return keys
		}
		for _, event := range listed.Events {
			if strings.HasPrefix(event.Key, "plan:") {
				keys = append(keys, event.Key)
			}
		}
		if page*100 >= listed.Count {
			break
		}
	}
	return keys
}

func runIntakeFriction(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, intakeFrictionUsage) }
	if len(o.Args) != 3 {
		return usage("Name what to do: add, resolve, list or export")
	}
	switch o.Args[2] {
	case "add":
		if problem := intakeOptions(o.Flags, "kind", "source", "reason", "key"); problem != "" {
			return usage(problem)
		}
		if o.Flags["kind"] == "" || o.Flags["reason"] == "" {
			return usage("--kind and --reason are required")
		}
		event := frictionEvent{Kind: o.Flags["kind"], Source: o.Flags["source"], Reason: o.Flags["reason"], Key: o.Flags["key"]}
		if o.OperationID == "" {
			o.OperationID = api.NewOperationID()
		}
		fmt.Fprintf(r.Diagnostics, "Retaining %s for intake.friction; use operations requests or operations resume after interruption.\n", o.OperationID)
		response, err := c.Call(ctx, "intake.friction", map[string]any{"events": []frictionEvent{event}}, o.OperationID)
		return r.result(o, response, err, "")
	case "resolve":
		if problem := intakeOptions(o.Flags, "key", "note"); problem != "" {
			return usage(problem)
		}
		if o.Flags["key"] == "" {
			return usage("--key is required")
		}
		if o.OperationID == "" {
			o.OperationID = api.NewOperationID()
		}
		input := map[string]any{"resolve": []string{o.Flags["key"]}}
		if note := o.Flags["note"]; note != "" {
			input["note"] = note
		}
		response, err := c.Call(ctx, "intake.friction", input, o.OperationID)
		return r.result(o, response, err, "")
	case "list":
		if problem := intakeOptions(o.Flags, "status", "kind", "page"); problem != "" {
			return usage(problem)
		}
		input := map[string]any{}
		for flag, field := range map[string]string{"status": "status", "kind": "kind"} {
			if value, given := o.Flags[flag]; given {
				input[field] = value
			}
		}
		if value, given := o.Flags["page"]; given {
			input["page"], _ = strconv.Atoi(value)
		}
		response, err := c.Call(ctx, "intake.frictionList", input, "")
		return r.result(o, response, err, "")
	case "export":
		if problem := intakeOptions(o.Flags, "status", "kind"); problem != "" {
			return usage(problem)
		}
		var all []json.RawMessage
		for page := 1; page <= 1000; page++ {
			input := map[string]any{"page": page, "pageSize": 100}
			for flag, field := range map[string]string{"status": "status", "kind": "kind"} {
				if value, given := o.Flags[flag]; given {
					input[field] = value
				}
			}
			response, err := c.Call(ctx, "intake.frictionList", input, "")
			if err != nil {
				return r.result(o, response, err, "")
			}
			var listed struct {
				Count  int               `json:"count"`
				Events []json.RawMessage `json:"events"`
			}
			if err := json.Unmarshal(response.Data, &listed); err != nil {
				return r.localError(o, "client_error", err.Error(), 4)
			}
			all = append(all, listed.Events...)
			if page*100 >= listed.Count {
				break
			}
		}
		data, _ := json.Marshal(map[string]any{"count": len(all), "events": all})
		return r.result(o, api.Response{Version: api.Version, BookID: c.BookID, OK: true, Data: data}, nil, "")
	}
	return usage("Unknown action " + plain(o.Args[2]))
}

// ---- Status -----------------------------------------------------------------------------------

func runIntakeStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if problem := intakeOptions(o.Flags); problem != "" {
		return intakeUsageError(r, o, problem, "intake status")
	}
	if len(o.Args) != 2 {
		return intakeUsageError(r, o, "intake status takes no arguments", "intake status")
	}
	response, err := c.Call(ctx, "intake.status", map[string]any{}, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	if o.Format == "text" {
		var status struct {
			StartedAt                    *string `json:"startedAt"`
			FirstImportAt                *string `json:"firstImportAt"`
			SecondsToFirstImport         *int    `json:"secondsToFirstImport"`
			SecondsToFirstReconciliation *int    `json:"secondsToFirstReconciliation"`
			Interventions                int     `json:"interventions"`
			UnresolvedGaps               int     `json:"unresolvedGaps"`
			Imports                      int     `json:"imports"`
			Reconciliations              int     `json:"reconciliations"`
			Events                       struct{ Total, Info, Agent, Retry, Human, Gap int }
			GapLog                       struct{ Open int } `json:"gapLog"`
		}
		if json.Unmarshal(response.Data, &status) == nil {
			started := "not started (no event logged yet)"
			if status.StartedAt != nil {
				started = *status.StartedAt
			}
			fmt.Fprintf(r.Output, "Started: %s\n", started)
			fmt.Fprintf(r.Output, "Time to the first import: %s (%d imports)\n", duration(status.SecondsToFirstImport), status.Imports)
			fmt.Fprintf(r.Output, "Time to the first reconciliation: %s (%d reconciliations)\n", duration(status.SecondsToFirstReconciliation), status.Reconciliations)
			fmt.Fprintf(r.Output, "Interventions: %d (agent %d, retry %d, human %d)\n", status.Interventions, status.Events.Agent, status.Events.Retry, status.Events.Human)
			fmt.Fprintf(r.Output, "Unresolved gaps: %d; the move's gap log: %d open\n", status.UnresolvedGaps, status.GapLog.Open)
			return 0
		}
	}
	return r.result(o, response, nil, "")
}

func duration(seconds *int) string {
	if seconds == nil {
		return "not yet"
	}
	total := *seconds
	if total < 60 {
		return fmt.Sprintf("%ds", total)
	}
	if total < 3600 {
		return fmt.Sprintf("%dm %ds", total/60, total%60)
	}
	return fmt.Sprintf("%dh %dm", total/3600, (total%3600)/60)
}

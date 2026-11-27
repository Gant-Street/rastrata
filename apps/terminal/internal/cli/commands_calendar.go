package cli

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The calendar lane's commands. A book's fiscal calendar grows one fiscal year at a time, and a year
// is closed period by period, in order. Both are two-step: prepare a plan, review it, then commit
// exactly that plan. Each command prepares and prints the plan; with --commit it then commits the plan
// it prepared, and prints that receipt instead (stdout always carries exactly one envelope).
//
//	rastrata periods extend [--through YEAR] [--commit [--plan-hash HASH]]
//	rastrata periods year-start MONTH [--commit [--plan-hash HASH]]
//	rastrata periods year-end YEAR --review
//	rastrata periods year-end YEAR --reason TEXT [--commit [--plan-hash HASH]]
//
// To review first and commit afterwards, run the command without --commit, read the plan, then run it
// again with the same --operation-id plus --commit and --plan-hash set to the reviewed plan's planHash:
// the same identity returns the same plan, and a plan that is not the one reviewed is refused.
func init() {
	Register(Command{
		Name:    "periods extend",
		Summary: "Prepare adding fiscal years to the calendar: periods extend [--through YEAR] [--commit [--plan-hash HASH]]",
		Run:     runPeriodsExtend,
	})
	Register(Command{
		Name:    "periods year-start",
		Summary: "Prepare changing the month fiscal years start in, until the book has an entry: periods year-start MONTH [--commit [--plan-hash HASH]]",
		Run:     runPeriodsYearStart,
	})
	Register(Command{
		Name:    "periods year-end",
		Summary: "Review (--review) or prepare closing every open period of a fiscal year, in order: periods year-end YEAR --reason TEXT [--commit [--plan-hash HASH]]",
		Run:     runPeriodsYearEnd,
	})
}

const (
	periodsExtendUsage    = "periods extend [--through YEAR] [--commit [--plan-hash HASH]] (YEAR is a fiscal year, 2000 to 2100; omitted, one more fiscal year)"
	periodsYearStartUsage = "periods year-start MONTH [--commit [--plan-hash HASH]] (MONTH is 1 to 12, 10 for October; allowed until the book has an entry or a closed period)"
	periodsYearEndUsage   = "periods year-end YEAR (--review | --reason TEXT [--commit [--plan-hash HASH]]) (YEAR is a fiscal year, 2000 to 2100; --review only reads the checklist; --reason is at most 400 characters)"
)

// calendarFlagProblem is a usage problem with the flags a calendar command was given, or "". A flag
// that needs a value but came bare reads as "true", which is never a valid value here.
func calendarFlagProblem(o Options, valued []string, switches []string) string {
	known := map[string]bool{}
	for _, name := range append(append([]string{}, valued...), switches...) {
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
		if value, given := o.Flags[name]; given && (value == "" || value == "true") {
			return "--" + name + " needs a value"
		}
	}
	for _, name := range switches {
		if value, given := o.Flags[name]; given && value != "true" {
			return "--" + name + " takes no value (put it after the year; a word after it is read as its value)"
		}
	}
	return ""
}

// fiscalYearFlag reads a fiscal year the way the contract bounds it.
func fiscalYearFlag(text string) (int, bool) {
	year, err := strconv.Atoi(text)
	return year, err == nil && year >= 2000 && year <= 2100
}

// derivedOperationID is a UUID that is a function of an operation identity and a purpose. The same
// request run again after an interruption derives the same commit identity, so the commit is resumed
// and never repeated. It has the layout of a version 5 UUID.
func derivedOperationID(seed, purpose string) string {
	sum := sha256.Sum256([]byte("rastrata-cli:" + purpose + ":" + seed))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// plannedChange is the part of a prepared plan the commit step needs.
type plannedChange struct {
	PlanID   string `json:"planId"`
	PlanHash string `json:"planHash"`
	Valid    bool   `json:"valid"`
}

// retained announces the identity a write is retained under, as every other command does.
func (r Runner) retained(operationID, operation string) {
	fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
}

// prepareThenMaybeCommit sends the prepare operation, prints its plan, or, with --commit, commits the
// plan and prints that receipt. commitOperation is "operations.commit" (identity is the plan id) or an
// operation of its own with a derived identity. summarize tells the person on stderr what is about to
// be committed.
func (r Runner) prepareThenMaybeCommit(ctx context.Context, o Options, c *api.Client, operation string, input map[string]any, commit bool, commitOperation string, summarize func(json.RawMessage)) int {
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	r.retained(operationID, operation)
	response, err := c.Call(ctx, operation, input, operationID)
	if err != nil || !commit {
		return r.result(o, response, err, "")
	}
	var plan plannedChange
	if json.Unmarshal(response.Data, &plan) != nil || plan.PlanID == "" {
		return r.localError(o, "response_invalid", "The prepared plan could not be read; nothing was committed", 4)
	}
	if want := o.Flags["plan-hash"]; want != "" && want != plan.PlanHash {
		return r.localError(o, "plan_hash_conflict", "The plan prepared now has hash "+plan.PlanHash+", not the "+want+" that was reviewed; nothing was committed. Review it again.", 3)
	}
	if !plan.Valid {
		// An invalid plan is printed, not committed: the kernel would only reject it.
		return r.result(o, response, nil, "")
	}
	if summarize != nil {
		summarize(response.Data)
	}
	commitInput := map[string]any{"planId": plan.PlanID, "planHash": plan.PlanHash}
	commitID := ""
	if commitOperation != "operations.commit" {
		commitID = derivedOperationID(operationID, "commit")
		r.retained(commitID, commitOperation)
	}
	receipt, err := c.Call(ctx, commitOperation, commitInput, commitID)
	return r.result(o, receipt, err, "")
}

func runPeriodsExtend(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "periods extend takes options only. Use "+periodsExtendUsage, 2)
	}
	if problem := calendarFlagProblem(o, []string{"through", "plan-hash"}, []string{"commit"}); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+periodsExtendUsage, 2)
	}
	if o.Flags["plan-hash"] != "" && o.Flags["commit"] != "true" {
		return r.localError(o, "usage_error", "--plan-hash is for --commit. Use "+periodsExtendUsage, 2)
	}
	input := map[string]any{}
	if text, given := o.Flags["through"]; given {
		year, ok := fiscalYearFlag(text)
		if !ok {
			return r.localError(o, "usage_error", "--through must be a fiscal year from 2000 to 2100. Use "+periodsExtendUsage, 2)
		}
		input["through"] = year
	}
	return r.prepareThenMaybeCommit(ctx, o, c, "periods.extend", input, o.Flags["commit"] == "true", "operations.commit", func(data json.RawMessage) {
		var plan struct {
			Effects struct {
				Calendar []struct {
					PeriodID string `json:"periodId"`
					Starts   string `json:"startsOn"`
					Ends     string `json:"endsOn"`
				} `json:"calendar"`
			} `json:"effects"`
		}
		if json.Unmarshal(data, &plan) == nil && len(plan.Effects.Calendar) > 0 {
			first, last := plan.Effects.Calendar[0], plan.Effects.Calendar[len(plan.Effects.Calendar)-1]
			fmt.Fprintf(r.Diagnostics, "Committing the plan that adds %d periods, %s to %s.\n", len(plan.Effects.Calendar), first.Starts, last.Ends)
		}
	})
}

func runPeriodsYearStart(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 3 {
		return r.localError(o, "usage_error", "Name the month the fiscal year starts in. Use "+periodsYearStartUsage, 2)
	}
	month, err := strconv.Atoi(o.Args[2])
	if err != nil || month < 1 || month > 12 {
		return r.localError(o, "usage_error", "The month must be a number from 1 to 12. Use "+periodsYearStartUsage, 2)
	}
	if problem := calendarFlagProblem(o, []string{"plan-hash"}, []string{"commit"}); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+periodsYearStartUsage, 2)
	}
	if o.Flags["plan-hash"] != "" && o.Flags["commit"] != "true" {
		return r.localError(o, "usage_error", "--plan-hash is for --commit. Use "+periodsYearStartUsage, 2)
	}
	input := map[string]any{"fiscalYearStartMonth": month}
	return r.prepareThenMaybeCommit(ctx, o, c, "periods.changeYearStart", input, o.Flags["commit"] == "true", "operations.commit", func(data json.RawMessage) {
		var plan struct {
			Effects struct {
				Calendar []struct {
					Starts string `json:"startsOn"`
					Ends   string `json:"endsOn"`
				} `json:"calendar"`
			} `json:"effects"`
		}
		if json.Unmarshal(data, &plan) == nil && len(plan.Effects.Calendar) > 0 {
			first, last := plan.Effects.Calendar[0], plan.Effects.Calendar[len(plan.Effects.Calendar)-1]
			fmt.Fprintf(r.Diagnostics, "Committing the plan that draws the calendar again, %d periods, %s to %s.\n", len(plan.Effects.Calendar), first.Starts, last.Ends)
		}
	})
}

func runPeriodsYearEnd(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 3 {
		return r.localError(o, "usage_error", "Name the fiscal year. Use "+periodsYearEndUsage, 2)
	}
	year, ok := fiscalYearFlag(o.Args[2])
	if !ok {
		return r.localError(o, "usage_error", "The fiscal year must be a number from 2000 to 2100. Use "+periodsYearEndUsage, 2)
	}
	if problem := calendarFlagProblem(o, []string{"reason", "plan-hash"}, []string{"commit", "review"}); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+periodsYearEndUsage, 2)
	}
	if o.Flags["review"] == "true" {
		// Looking is free: the checklist and statements of the year, nothing prepared or retained.
		if len(o.Flags) != 1 {
			return r.localError(o, "usage_error", "--review takes no other option; it only reads. Use "+periodsYearEndUsage, 2)
		}
		response, err := c.Call(ctx, "periods.yearEndReview", map[string]any{"fiscalYear": year}, "")
		return r.result(o, response, err, "")
	}
	reason := strings.TrimSpace(o.Flags["reason"])
	if reason == "" {
		return r.localError(o, "usage_error", "--reason is required: say why the year is being closed. Use "+periodsYearEndUsage, 2)
	}
	if len([]rune(reason)) > 400 {
		return r.localError(o, "usage_error", "--reason is at most 400 characters. Use "+periodsYearEndUsage, 2)
	}
	if o.Flags["plan-hash"] != "" && o.Flags["commit"] != "true" {
		return r.localError(o, "usage_error", "--plan-hash is for --commit. Use "+periodsYearEndUsage, 2)
	}
	input := map[string]any{"fiscalYear": year, "reason": reason}
	return r.prepareThenMaybeCommit(ctx, o, c, "periods.yearEnd", input, o.Flags["commit"] == "true", "periods.commitYearEnd", func(data json.RawMessage) {
		var plan struct {
			FiscalYear int `json:"fiscalYear"`
			OpenCount  int `json:"openCount"`
			Checks     []struct {
				Label  string `json:"label"`
				Status string `json:"status"`
				Detail string `json:"detail"`
			} `json:"checks"`
			Statements struct {
				Currency  string `json:"currency"`
				NetIncome string `json:"netIncome"`
			} `json:"statements"`
		}
		if json.Unmarshal(data, &plan) != nil {
			return
		}
		fmt.Fprintf(r.Diagnostics, "Committing the year-end of fiscal year %d: %d periods in order; net income %s %s.\n", plan.FiscalYear, plan.OpenCount, plan.Statements.NetIncome, plan.Statements.Currency)
		for _, check := range plan.Checks {
			if check.Status == "attention" {
				fmt.Fprintf(r.Diagnostics, "Needs attention: %s. %s\n", check.Label, check.Detail)
			}
		}
	})
}

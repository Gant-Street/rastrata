package cli

import (
	"context"
	"encoding/json"
	"io"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The reports lane's command. Statements are read from one population of the book (a revision, a
// date range and the book's basis), so every figure can be traced and reproduced. The command prints
// the application's JSON envelope; --format csv prints a spreadsheet file instead, rendered by the
// service (reports.export) so there is exactly one implementation that neutralises cells a
// spreadsheet could run as formulas.
//
//	rastrata reports STATEMENT --as-of DATE [--from DATE] [--compare previous-period|previous-year]
//	                           [--share income] [--basis cash|accrual] [--revision N]
//	                           [--format json|text|csv]
//	rastrata reports largest   --as-of DATE [--from DATE] [--kind expense|income] [--limit N]
//
// reports largest is not a statement but a ranking: the entries of the range by what they spent (or took in), largest first. It
// answers "what was the largest single expense in March" without the agent paging the ledger and comparing for itself.
//
// --share income adds each profit and loss line's share of total income (and the comparison's, each
// against its own period's income) to the reply or the file. The service works the figure out from
// integers; nothing here divides or rounds.
func init() {
	Register(Command{
		Name: "reports",
		Summary: "Statements: reports all|trial-balance|profit-loss|balance-sheet|cash-flow|general-ledger|calendar " +
			"--as-of DATE [--from DATE] [--compare previous-period|previous-year] [--share income] [--format csv]; " +
			"reports largest --as-of DATE [--from DATE] [--kind expense|income] [--limit N] ranks the entries by what they spent or took in, largest first",
		Run: runReports,
	})
}

// reportsCSVHint is the answer to --format csv anywhere but the reports command.
const reportsCSVHint = "CSV is available for one report statement: rastrata reports STATEMENT --as-of DATE --format csv"

// reportStatement describes one statement: the operation that reads it, the field of reports.get it
// is cut from, and the flags that mean something for it.
type reportStatement struct {
	operation string
	// field is the CoreReports member a single statement is cut from; empty for operations that
	// return one statement already.
	field string
	flags []string
	// exportable is whether reports.export can render it.
	exportable bool
}

var reportStatements = map[string]reportStatement{
	"all":            {operation: "reports.get", flags: []string{"from", "compare", "basis", "share"}},
	"trial-balance":  {operation: "reports.get", field: "trialBalance", flags: []string{"from", "compare", "basis"}, exportable: true},
	"profit-loss":    {operation: "reports.get", field: "profitAndLoss", flags: []string{"from", "compare", "basis", "share"}, exportable: true},
	"balance-sheet":  {operation: "reports.get", field: "balanceSheet", flags: []string{"from", "compare", "basis"}, exportable: true},
	"cash-flow":      {operation: "reports.cashFlow", flags: []string{"from", "compare", "basis", "tags-revision"}, exportable: true},
	"general-ledger": {operation: "reports.generalLedger", flags: []string{"from", "basis", "page"}, exportable: true},
	"calendar":       {operation: "reports.calendar"},
	"largest":        {operation: "reports.largest", flags: []string{"from", "kind", "limit"}},
}

const reportsUsage = "reports all|trial-balance|profit-loss|balance-sheet|cash-flow|general-ledger|calendar --as-of YYYY-MM-DD " +
	"[--from YYYY-MM-DD] [--compare previous-period|previous-year] [--share income] [--basis cash|accrual] [--revision N] [--format json|text|csv]; " +
	"or reports largest --as-of YYYY-MM-DD [--from YYYY-MM-DD] [--kind expense|income] [--limit 1-50] [--revision N]"

// reportsStatementNames is the statements in a stable order, for messages.
func reportsStatementNames() string {
	names := make([]string, 0, len(reportStatements))
	for name := range reportStatements {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// reportsCompare accepts the spellings a person types and the contract's own.
func reportsCompare(value string) (string, bool) {
	switch strings.ToLower(strings.ReplaceAll(value, "_", "-")) {
	case "previous-period", "previousperiod", "period":
		return "previousPeriod", true
	case "previous-year", "previousyear", "year":
		return "previousYear", true
	case "none", "":
		return "none", true
	}
	return "", false
}

// reportsShare accepts the contract's own two words. "income" asks for each profit and loss line as a
// share of total income; "none" is what a report is without it.
func reportsShare(value string) (string, bool) {
	switch strings.ToLower(value) {
	case "income":
		return "income", true
	case "none":
		return "none", true
	}
	return "", false
}

func runReports(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int {
		return r.localError(o, "usage_error", problem+". Use "+reportsUsage, 2)
	}
	if len(o.Args) != 2 {
		return usage("Name one statement (" + reportsStatementNames() + ")")
	}
	statement, known := reportStatements[o.Args[1]]
	if !known {
		return usage("Unknown statement " + o.Args[1] + " (" + reportsStatementNames() + ")")
	}
	allowed := map[string]bool{}
	for _, name := range statement.flags {
		allowed[name] = true
	}
	names := make([]string, 0, len(o.Flags))
	for name := range o.Flags {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !allowed[name] {
			return usage("--" + name + " does not apply to " + o.Args[1])
		}
		if value := o.Flags[name]; value == "true" || value == "" {
			return usage("--" + name + " needs a value")
		}
	}
	input := map[string]any{}
	if o.Args[1] != "calendar" {
		if o.AsOf == "" {
			return usage("--as-of DATE is required")
		}
		input["asOf"] = o.AsOf
		if o.Revision != "" {
			input["revision"] = o.Revision
		}
	} else if o.AsOf != "" || o.Revision != "" {
		return usage("reports calendar takes no --as-of or --revision")
	}
	if value, given := o.Flags["from"]; given {
		input["from"] = value
	}
	if value, given := o.Flags["basis"]; given {
		input["basis"] = value
	}
	if value, given := o.Flags["compare"]; given {
		compare, ok := reportsCompare(value)
		if !ok {
			return usage("--compare must be previous-period or previous-year")
		}
		input["compare"] = compare
	}
	if value, given := o.Flags["share"]; given {
		share, ok := reportsShare(value)
		if !ok {
			return usage("--share must be income (each profit and loss line as a share of total income) or none")
		}
		input["share"] = share
	}
	if value, given := o.Flags["tags-revision"]; given {
		input["tagsRevision"] = value
	}
	if value, given := o.Flags["page"]; given {
		page, err := strconv.Atoi(value)
		if err != nil || page < 1 {
			return usage("--page must be a whole number from 1")
		}
		input["page"] = page
	}
	if value, given := o.Flags["kind"]; given {
		if value != "expense" && value != "income" {
			return usage("--kind must be expense (what was spent, the default) or income (what was taken in)")
		}
		input["kind"] = value
	}
	if value, given := o.Flags["limit"]; given {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 50 {
			return usage("--limit must be a whole number from 1 to 50")
		}
		input["limit"] = limit
	}

	if o.Format == "csv" {
		if !statement.exportable {
			return usage("CSV is available for one statement at a time (trial-balance, profit-loss, balance-sheet, cash-flow, general-ledger)")
		}
		if _, given := o.Flags["page"]; given {
			return usage("--page does not apply to CSV: the file holds every line")
		}
		input["statement"] = o.Args[1]
		response, err := c.Call(ctx, "reports.export", input, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		var file struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal(response.Data, &file); err != nil {
			return r.localError(o, "export_failed", err.Error(), 4)
		}
		if _, err := io.WriteString(r.Output, file.Content); err != nil {
			return r.localError(o, "export_failed", err.Error(), 4)
		}
		return 0
	}

	response, err := c.Call(ctx, statement.operation, input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	return r.result(o, response, nil, o.Args[1])
}

// reportsNarrow cuts one statement out of a reports.get result, keeping the facts that identify the
// population it came from. Other results (the cash flow, the general ledger) are one statement
// already and are returned unchanged.
func reportsNarrow(data json.RawMessage, name string) json.RawMessage {
	statement, known := reportStatements[name]
	if !known || statement.field == "" {
		return data
	}
	var reports map[string]json.RawMessage
	if err := json.Unmarshal(data, &reports); err != nil {
		return data
	}
	selected := map[string]json.RawMessage{}
	for _, key := range []string{
		"asOf", "periodStart", "basis", "currency", "bookRevision", "populationHash",
		"postingSequence", "compilerVersion", "fiscalYear", "comparison", "warnings",
	} {
		if value, present := reports[key]; present {
			selected[key] = value
		}
	}
	selected["statement"] = reports[statement.field]
	narrowed, err := json.Marshal(selected)
	if err != nil {
		return data
	}
	return narrowed
}

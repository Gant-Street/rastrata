package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The reconcile lane's commands. A reconciliation checks one asset or liability account against a
// statement: a draft is created from the statement date and ending balance, lines are selected
// until the difference is exactly 0.00, and the draft is completed into a record that is never
// edited, only voided with a reason. Every command prints the application's JSON envelope.
//
// Commands that change a draft carry the draft's version. Give --version N to say which version you
// reviewed (an agent should); without it the command reads the draft and uses its current version,
// and says so on stderr.
func init() {
	for name, command := range map[string]struct {
		summary string
		run     func(Runner, context.Context, Options, *api.Client) int
	}{
		"start":     {"Start reconciling an account: --account ID --date YYYY-MM-DD --balance AMOUNT", runReconcileStart},
		"status":    {"Per account: last reconciled date and balance, draft in progress, uncleared postings", runReconcileStatus},
		"show":      {"Show a reconciliation (a draft with its lines, or a completed or voided record): show ID", runReconcileShow},
		"select":    {"Select lines of a draft: select ID (--all | --none | --add IDS | --remove IDS)", runReconcileSelect},
		"statement": {"Correct a draft's statement or refresh its lines: statement ID [--date D] [--balance B]", runReconcileStatement},
		"complete":  {"Complete a draft whose difference is exactly 0.00: complete ID", runReconcileComplete},
		"discard":   {"Abandon a draft: discard ID", runReconcileDiscard},
		"void":      {"Void the newest completed reconciliation of an account: void ID --reason TEXT", runReconcileVoid},
		"list":      {"Page reconciliations: list [--account ID] [--state draft|completed|voided] [--page N]", runReconcileList},
		"cleared":   {"Which postings of these journals are cleared: cleared JOURNAL_ID...", runReconcileCleared},
		"report":    {"Report on a finished reconciliation, with what was outstanding on its statement date: report ID [--format text|csv]", runReconcileReport},
	} {
		Register(Command{Name: "reconcile " + name, Summary: command.summary, Run: command.run})
	}
}

// flagProblem returns a usage error message when a flag is not one of allowed, or is one that needs
// a value but was given bare (a bare flag reads as "true").
func reconcileFlagProblem(o Options, allowed []string, valued []string) string {
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

// reconcileArgs checks "reconcile NAME ID": exactly one identifier after the command words.
func reconcileID(r Runner, o Options, usage string) (string, int, bool) {
	if len(o.Args) != 3 {
		return "", r.localError(o, "usage_error", "Use "+usage, 2), false
	}
	return o.Args[2], 0, true
}

func reconcileUsageError(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

// reconcileCall sends one operation with a retained identity (writes) and prints its result.
func reconcileCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) int {
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

// reconcileVersion is the version a change to a draft is based on: --version, or the draft's
// current one, read now.
func reconcileVersion(r Runner, ctx context.Context, o Options, c *api.Client, id string) (int, int, bool) {
	if value, given := o.Flags["version"]; given {
		version, err := strconv.Atoi(value)
		if err != nil || version < 1 {
			return 0, r.localError(o, "usage_error", "--version must be a whole number from 1", 2), false
		}
		return version, 0, true
	}
	draft, err := c.ReconcileGet(ctx, api.ReconcileIdInput{ID: id}, "")
	if err != nil {
		return 0, r.result(o, api.Response{}, err, ""), false
	}
	if draft.Status != "draft" {
		return 0, r.localError(o, "reconcile_not_open", "That reconciliation is "+draft.Status+"; only a draft can be changed", 3), false
	}
	fmt.Fprintf(r.Diagnostics, "Using the draft's current version %d (difference %s); give --version N to name the version you reviewed.\n", draft.Version, draft.Difference)
	return draft.Version, 0, true
}

func runReconcileStart(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile start --account ID --date YYYY-MM-DD --balance AMOUNT (the balance exactly as the statement prints it; a card's balance owed is positive)"
	if len(o.Args) != 2 {
		return reconcileUsageError(r, o, "reconcile start takes options only", usage)
	}
	if problem := reconcileFlagProblem(o, []string{"account", "date", "balance"}, []string{"account", "date", "balance"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	for _, name := range []string{"account", "date", "balance"} {
		if o.Flags[name] == "" {
			return reconcileUsageError(r, o, "--"+name+" is required", usage)
		}
	}
	return reconcileCall(r, ctx, o, c, "reconcile.start", map[string]any{
		"accountId": o.Flags["account"], "statementDate": o.Flags["date"], "statementBalance": o.Flags["balance"],
	})
}

func runReconcileStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile status [--account ID] [--all]"
	if len(o.Args) != 2 {
		return reconcileUsageError(r, o, "reconcile status takes options only", usage)
	}
	if problem := reconcileFlagProblem(o, []string{"account", "all"}, []string{"account"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	input := map[string]any{}
	if account := o.Flags["account"]; account != "" {
		input["accountId"] = account
	}
	if value, given := o.Flags["all"]; given {
		input["all"] = value == "true"
	}
	return reconcileCall(r, ctx, o, c, "reconcile.status", input)
}

func runReconcileShow(r Runner, ctx context.Context, o Options, c *api.Client) int {
	id, exit, ok := reconcileID(r, o, "reconcile show ID")
	if !ok {
		return exit
	}
	if problem := reconcileFlagProblem(o, nil, nil); problem != "" {
		return reconcileUsageError(r, o, problem, "reconcile show ID")
	}
	return reconcileCall(r, ctx, o, c, "reconcile.get", map[string]any{"id": id})
}

func splitList(value string) []string {
	items := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

func runReconcileSelect(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile select ID (--all | --none | --add POSTING_IDS | --remove POSTING_IDS) [--version N]; ids are comma separated, up to 500 each"
	id, exit, ok := reconcileID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := reconcileFlagProblem(o, []string{"all", "none", "add", "remove", "version"}, []string{"add", "remove", "version"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	input := map[string]any{"id": id}
	switch {
	case o.Flags["all"] == "true" && o.Flags["none"] == "true":
		return reconcileUsageError(r, o, "--all and --none cannot be combined", usage)
	case o.Flags["all"] == "true":
		input["reset"] = "all"
	case o.Flags["none"] == "true":
		input["reset"] = "none"
	}
	if value, given := o.Flags["add"]; given {
		input["select"] = splitList(value)
	}
	if value, given := o.Flags["remove"]; given {
		input["deselect"] = splitList(value)
	}
	if len(input) == 1 {
		return reconcileUsageError(r, o, "Say what to change: --all, --none, --add or --remove", usage)
	}
	version, exit, ok := reconcileVersion(r, ctx, o, c, id)
	if !ok {
		return exit
	}
	input["expectedVersion"] = version
	return reconcileCall(r, ctx, o, c, "reconcile.setCleared", input)
}

func runReconcileStatement(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile statement ID [--date YYYY-MM-DD] [--balance AMOUNT] [--version N]; with neither it refreshes the lines from the books"
	id, exit, ok := reconcileID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := reconcileFlagProblem(o, []string{"date", "balance", "version"}, []string{"date", "balance", "version"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	draft, err := c.ReconcileGet(ctx, api.ReconcileIdInput{ID: id}, "")
	if err != nil {
		return r.result(o, api.Response{}, err, "")
	}
	if draft.Status != "draft" {
		return r.localError(o, "reconcile_not_open", "That reconciliation is "+draft.Status+"; only a draft can be changed", 3)
	}
	date, balance := draft.StatementDate, draft.StatementBalance
	if value := o.Flags["date"]; value != "" {
		date = value
	}
	if value := o.Flags["balance"]; value != "" {
		balance = value
	}
	version := draft.Version
	if value, given := o.Flags["version"]; given {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 {
			return r.localError(o, "usage_error", "--version must be a whole number from 1", 2)
		}
		version = parsed
	} else {
		fmt.Fprintf(r.Diagnostics, "Using the draft's current version %d; give --version N to name the version you reviewed.\n", version)
	}
	return reconcileCall(r, ctx, o, c, "reconcile.setStatement", map[string]any{
		"id": id, "expectedVersion": version, "statementDate": date, "statementBalance": balance,
	})
}

func runReconcileVersioned(r Runner, ctx context.Context, o Options, c *api.Client, operation, usage string) int {
	id, exit, ok := reconcileID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := reconcileFlagProblem(o, []string{"version"}, []string{"version"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	version, exit, ok := reconcileVersion(r, ctx, o, c, id)
	if !ok {
		return exit
	}
	return reconcileCall(r, ctx, o, c, operation, map[string]any{"id": id, "expectedVersion": version})
}

func runReconcileComplete(r Runner, ctx context.Context, o Options, c *api.Client) int {
	return runReconcileVersioned(r, ctx, o, c, "reconcile.complete", "reconcile complete ID [--version N]; the difference must be exactly 0.00")
}

func runReconcileDiscard(r Runner, ctx context.Context, o Options, c *api.Client) int {
	return runReconcileVersioned(r, ctx, o, c, "reconcile.discard", "reconcile discard ID [--version N]")
}

func runReconcileVoid(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile void ID --reason TEXT; only the newest completed reconciliation of an account can be voided"
	id, exit, ok := reconcileID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := reconcileFlagProblem(o, []string{"reason"}, []string{"reason"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	if strings.TrimSpace(o.Flags["reason"]) == "" {
		return reconcileUsageError(r, o, "--reason is required: say why the reconciliation is being voided", usage)
	}
	return reconcileCall(r, ctx, o, c, "reconcile.void", map[string]any{"id": id, "reason": o.Flags["reason"]})
}

func runReconcileList(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile list [--account ID] [--state draft|completed|voided] [--page N]"
	if len(o.Args) != 2 {
		return reconcileUsageError(r, o, "reconcile list takes options only", usage)
	}
	if problem := reconcileFlagProblem(o, []string{"account", "state", "page"}, []string{"account", "state", "page"}); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	input := map[string]any{}
	if value := o.Flags["account"]; value != "" {
		input["accountId"] = value
	}
	if value := o.Flags["state"]; value != "" {
		input["status"] = value
	}
	if value := o.Flags["page"]; value != "" {
		page, err := strconv.Atoi(value)
		if err != nil || page < 1 {
			return r.localError(o, "usage_error", "--page must be a whole number from 1", 2)
		}
		input["page"] = page
	}
	return reconcileCall(r, ctx, o, c, "reconcile.list", input)
}

func runReconcileCleared(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile cleared JOURNAL_ID... (up to 100)"
	if len(o.Args) < 3 {
		return reconcileUsageError(r, o, "Give at least one journal id", usage)
	}
	if problem := reconcileFlagProblem(o, nil, nil); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	return reconcileCall(r, ctx, o, c, "reconcile.cleared", map[string]any{"journalIds": o.Args[2:]})
}

// reconcileReportLine and reconcileReportView are the parts of the report the text and csv forms read; the
// JSON form prints the whole envelope for scripts and agents.
type reconcileReportLine struct {
	Date      string `json:"date"`
	Narration string `json:"narration"`
	Amount    string `json:"amount"`
}

type reconcileReportPart struct {
	Count int                   `json:"count"`
	Total string                `json:"total"`
	Lines []reconcileReportLine `json:"lines"`
}

type reconcileReportView struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Account struct {
		Code string `json:"code"`
		Name string `json:"name"`
	} `json:"account"`
	StatementDate    string `json:"statementDate"`
	StatementBalance string `json:"statementBalance"`
	OpeningBalance   string `json:"openingBalance"`
	CompletedAt      string `json:"completedAt"`
	RecordHash       string `json:"recordHash"`
	BookRevision     string `json:"bookRevision"`
	Void             *struct {
		Reason   string `json:"reason"`
		VoidedAt string `json:"voidedAt"`
	} `json:"void"`
	Cleared     reconcileReportPart `json:"cleared"`
	Outstanding reconcileReportPart `json:"outstanding"`
	BookBalance string              `json:"bookBalance"`
	Difference  string              `json:"difference"`
	File        *struct {
		Content string `json:"content"`
	} `json:"file"`
}

// reconcileTerminalText makes text that came from outside safe to print in a terminal: a control
// character (an escape sequence starts with one) and a character that hides text or changes the order it
// is read in (a right-to-left override) become a space or are dropped.
func reconcileTerminalText(text string) string {
	var out strings.Builder
	for _, r := range text {
		switch {
		case unicode.IsControl(r):
			out.WriteRune(' ')
		case unicode.Is(unicode.Cf, r), r == ' ', r == ' ':
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}

func runReconcileReport(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "reconcile report ID [--format text|csv]; the id of a completed or voided reconciliation, from reconcile list"
	id, exit, ok := reconcileID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := reconcileFlagProblem(o, nil, nil); problem != "" {
		return reconcileUsageError(r, o, problem, usage)
	}
	if o.AsOf != "" || o.Revision != "" {
		// A report is read as of the revision the reconciliation finished at; a date or revision here
		// would be taken for a different report than the one printed.
		return reconcileUsageError(r, o, "--as-of and --revision do not apply: a report is read at the book revision the reconciliation finished at", usage)
	}
	input := map[string]any{"id": id}
	if o.Format == "csv" {
		input["file"] = "csv"
	}
	response, err := c.Call(ctx, "reconcile.report", input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	if o.Format != "text" && o.Format != "csv" {
		return r.result(o, response, nil, "")
	}
	var report reconcileReportView
	if err := json.Unmarshal(response.Data, &report); err != nil {
		return r.localError(o, "response_invalid", "The service's answer could not be read: "+err.Error(), 4)
	}
	if o.Format == "csv" {
		if report.File == nil {
			return r.localError(o, "response_invalid", "The service sent no file.", 4)
		}
		if _, err := io.WriteString(r.Output, report.File.Content); err != nil {
			return r.localError(o, "export_failed", err.Error(), 4)
		}
		return 0
	}
	printReconcileReport(r.Output, report)
	return 0
}

// printReconcileReport prints the report the way a person reads it: what the statement said, how the books
// get to it, and the lines on each side.
func printReconcileReport(out io.Writer, report reconcileReportView) {
	account := strings.TrimSpace(reconcileTerminalText(report.Account.Code + " " + report.Account.Name))
	fmt.Fprintf(out, "Reconciliation report: %s\n", account)
	fmt.Fprintf(out, "Statement ending %s, balance %s. Finished %s at book revision %s.\n",
		report.StatementDate, report.StatementBalance, report.CompletedAt, report.BookRevision)
	fmt.Fprintf(out, "Record fingerprint %s\n", report.RecordHash)
	if report.Void != nil {
		fmt.Fprintf(out, "VOIDED %s: %s\nThis reconciliation no longer counts as a statement the books agree with. Its lines are shown as they were.\n",
			report.Void.VoidedAt, reconcileTerminalText(report.Void.Reason))
	}
	fmt.Fprintf(out, "\nThe books on %s, as they stood at revision %s: %s\n", report.StatementDate, report.BookRevision, report.BookBalance)
	fmt.Fprintf(out, "Less %d not yet on the statement (outstanding): %s\n", report.Outstanding.Count, report.Outstanding.Total)
	fmt.Fprintf(out, "Is the statement balance:  %s\n", report.StatementBalance)
	fmt.Fprintf(out, "\nCleared on this statement: %d, %s (the opening balance was %s; the difference is %s)\n",
		report.Cleared.Count, report.Cleared.Total, report.OpeningBalance, report.Difference)
	for _, line := range report.Cleared.Lines {
		fmt.Fprintf(out, "  %s %12s  %s\n", line.Date, line.Amount, reconcileTerminalText(line.Narration))
	}
	fmt.Fprintf(out, "\nOutstanding on %s: %d, %s\n", report.StatementDate, report.Outstanding.Count, report.Outstanding.Total)
	for _, line := range report.Outstanding.Lines {
		fmt.Fprintf(out, "  %s %12s  %s\n", line.Date, line.Amount, reconcileTerminalText(line.Narration))
	}
}

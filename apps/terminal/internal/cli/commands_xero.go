package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The shadow lane's Xero commands: reading what Xero exports, mapping its chart onto the book's,
// starting the books from its trial balance, comparing the two books where Xero was itself
// reconciled, and the gap log of what that found.
//
//	rastrata xero status
//	rastrata xero chart [--file FILE] [--map CODE=ACCOUNT,...] [--skip CODE,...] [--import] [--accept none|certain|likely]
//	rastrata xero mapping set [--map CODE=ACCOUNT,...] [--skip CODE,...] [--clear CODE,...]
//	rastrata xero trial-balance --file FILE [--as-of D] [--include-profit-loss] [--import] [--balances-only]
//	rastrata xero transactions --file FILE [--date-order mdy|dmy] [--import]
//	rastrata xero reconciled [--set CODE=DATE,...] [--clear CODE,...] [--note TEXT]
//	rastrata xero tie-out [--from D] [--to D] [--tolerance DAYS] [--record]
//	rastrata gaps list|add|close|reopen
//
// Every command prints the JSON envelope; --format text prints a plain table for a person. A file is
// read here and sent as text (a request carries 128 KiB, so a file is about 120,000 characters).
// Nothing here writes to Xero, and a preview, which is what runs without --import, changes nothing.
func init() {
	Register(Command{Name: "xero status", Summary: "What has been imported from Xero, how far the mapping is, and where Xero was reconciled", Run: runXeroStatus})
	Register(Command{Name: "xero chart", Summary: "Read a Xero chart of accounts and map it onto the book's; --import saves it [--file FILE] [--map CODE=ACCOUNT,...] [--skip CODE,...] [--import] [--accept certain|likely|none]", Run: runXeroChart})
	Register(Command{Name: "xero mapping set", Summary: "Save or clear the owner's choices of which account each Xero account is [--map CODE=ACCOUNT,...] [--skip CODE,...] [--clear CODE,...]", Run: runXeroMappingSet})
	Register(Command{Name: "xero trial-balance", Summary: "Read a Xero trial balance: the opening balances it makes, what it leaves out; --import keeps it for the tie-out --file FILE [--as-of D] [--include-profit-loss] [--import] [--balances-only]", Run: runXeroTrialBalance})
	Register(Command{Name: "xero transactions", Summary: "Read a Xero Account Transactions export block by block; --import keeps its lines for the tie-out --file FILE [--date-order mdy|dmy] [--import]", Run: runXeroTransactions})
	Register(Command{Name: "xero reconciled", Summary: "Where Xero's bank accounts were reconciled through [--set CODE=DATE,...] [--clear CODE,...] [--note TEXT]", Run: runXeroReconciled})
	Register(Command{Name: "xero tie-out", Summary: "Compare the books with Xero by account and period, only where Xero was reconciled; --record adds the differences to the gap log [--from D] [--to D] [--tolerance DAYS] [--record]", Run: runXeroTieOut})
	Register(Command{Name: "gaps list", Summary: "The gap log: what the move found that is not yet right [--status open|closed|all]", Run: runGapsList})
	Register(Command{Name: "gaps add", Summary: "Add a gap --title TEXT [--detail TEXT] [--kind difference|unmapped|feature|data|other]", Run: runGapsAdd})
	Register(Command{Name: "gaps close", Summary: "Close a gap with a note saying what was found: gaps close ID --resolution TEXT", Run: runGapsClose})
	Register(Command{Name: "gaps reopen", Summary: "Reopen a closed gap: gaps reopen ID [--note TEXT]", Run: runGapsReopen})
}

// readXeroFile reads --file (or standard input for "-") as UTF-8 text no larger than one request.
func readXeroFile(r Runner, o Options, usage string, required bool) (string, bool, int) {
	path, given := o.Flags["file"]
	if !given {
		if required {
			return "", false, shadowUsage(r, o, "--file is required", usage)
		}
		return "", false, 0
	}
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(io.LimitReader(r.Input, maxOpeningCSV+1))
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return "", false, r.localError(o, "input_unavailable", err.Error(), 2)
	}
	if len(data) > maxOpeningCSV {
		return "", false, shadowUsage(r, o, fmt.Sprintf("the file is larger than %d bytes, which is what one request carries; export a shorter date range (one month of account transactions at a time)", maxOpeningCSV), usage)
	}
	if !utf8.Valid(data) {
		return "", false, shadowUsage(r, o, "the file is not UTF-8 text; save it as UTF-8 CSV", usage)
	}
	return string(data), true, 0
}

// xeroChoices reads --map CODE=ACCOUNT,... and --skip CODE,... into choices.
func xeroChoices(r Runner, o Options, usage string) ([]map[string]any, int) {
	choices := []map[string]any{}
	if value, given := o.Flags["map"]; given {
		for _, pair := range shadowList(value) {
			code, account, found := strings.Cut(pair, "=")
			code, account = strings.TrimSpace(code), strings.TrimSpace(account)
			if !found || code == "" || account == "" {
				return nil, shadowUsage(r, o, "--map is a comma separated list of CODE=ACCOUNT, for example 400=6010,820=2500 (a Xero code, then an account of the book by id or code)", usage)
			}
			choices = append(choices, map[string]any{"xeroCode": code, "accountId": account})
		}
	}
	if value, given := o.Flags["skip"]; given {
		for _, code := range shadowList(value) {
			choices = append(choices, map[string]any{"xeroCode": code, "skip": true})
		}
	}
	return choices, 0
}

func xeroFlag(o Options, name string) bool {
	value, given := o.Flags[name]
	if !given {
		return false
	}
	switch strings.ToLower(value) {
	case "true", "yes", "1", "":
		return true
	}
	return false
}

func xeroDecimal(o Options, input map[string]any) {
	if value, given := o.Flags["decimal"]; given && (value == "comma" || value == ",") {
		input["decimal"] = ","
	}
}

// ---- status -------------------------------------------------------------------------------------

func runXeroStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero status"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "xero status takes no arguments", usage)
	}
	if problem := shadowFlagProblem(o, nil, nil); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	response, err := shadowCall(r, ctx, o, c, "xero.status", map[string]any{})
	if err == nil && o.Format == "text" {
		var status api.XeroStatus
		if json.Unmarshal(response.Data, &status) == nil {
			printXeroStatus(r.Output, status)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func printXeroStatus(w io.Writer, status api.XeroStatus) {
	if status.ChartImportedAt == nil {
		fmt.Fprintln(w, "Xero chart: not imported")
	} else {
		fmt.Fprintf(w, "Xero chart: imported %s\n", *status.ChartImportedAt)
	}
	fmt.Fprintf(w, "Mapping: %d accounts, %d mapped (%d certain, %d likely), %d left out, %d not mapped (%d with a balance)\n",
		status.Counts.Accounts, status.Counts.Mapped, status.Counts.Certain, status.Counts.Likely, status.Counts.Skipped, status.Counts.Unmapped, status.Counts.UnmappedWithBalance)
	if status.CutoverDate != nil {
		fmt.Fprintf(w, "Cutover date: %s\n", *status.CutoverDate)
	}
	if len(status.TrialBalances) > 0 {
		fmt.Fprintf(w, "Trial balances kept, as at: %s\n", strings.Join(status.TrialBalances, ", "))
	}
	for _, rangeOf := range status.Transactions {
		fmt.Fprintf(w, "Account transactions kept: %s to %s (%d lines)\n", rangeOf.From, rangeOf.To, rangeOf.Lines)
	}
	if len(status.Reconciled) > 0 {
		fmt.Fprintln(w, "\nXero was reconciled through:")
		for _, entry := range status.Reconciled {
			name := ""
			if entry.Name != nil {
				name = shadowClip(*entry.Name, 34)
			}
			fmt.Fprintf(w, "  %-8s %-34s %s\n", shadowClip(entry.Code, 8), name, entry.Through)
		}
	}
	if len(status.Files) > 0 {
		fmt.Fprintln(w, "\nFiles imported (newest first):")
		for _, file := range status.Files {
			fmt.Fprintf(w, "  #%-3d %-13s %-28s %s  %d rows\n", file.Seq, file.Kind, shadowClip(file.Name, 28), file.ImportedAt, file.Rows)
		}
	}
	for _, note := range status.Notes {
		fmt.Fprintf(w, "\nNote: %s\n", shadowPlain(note))
	}
}

// ---- chart --------------------------------------------------------------------------------------

func runXeroChart(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero chart [--file FILE] [--name NAME] [--map CODE=ACCOUNT,...] [--skip CODE,...] [--import] [--accept certain|likely|none] [--skip-unreadable] [--decimal comma]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "xero chart takes no arguments", usage)
	}
	flags := []string{"file", "name", "map", "skip", "import", "accept", "skip-unreadable", "decimal"}
	if problem := shadowFlagProblem(o, flags, []string{"file", "name", "map", "skip", "accept", "decimal"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	text, hasFile, failed := readXeroFile(r, o, usage, xeroFlag(o, "import"))
	if failed != 0 {
		return failed
	}
	choices, failed := xeroChoices(r, o, usage)
	if failed != 0 {
		return failed
	}
	input := map[string]any{}
	if hasFile {
		input["text"] = text
	}
	if name, given := o.Flags["name"]; given {
		input["name"] = name
	} else if path, given := o.Flags["file"]; given && path != "-" {
		input["name"] = baseName(path)
	}
	if len(choices) > 0 {
		input["overrides"] = choices
	}
	xeroDecimal(o, input)
	operation := "xero.chart.preview"
	if xeroFlag(o, "import") {
		operation = "xero.chart.import"
		if accept, given := o.Flags["accept"]; given {
			if accept != "none" && accept != "certain" && accept != "likely" {
				return shadowUsage(r, o, "--accept is none, certain or likely", usage)
			}
			input["accept"] = accept
		}
		if xeroFlag(o, "skip-unreadable") {
			input["skipUnreadable"] = true
		}
	} else if _, given := o.Flags["accept"]; given {
		return shadowUsage(r, o, "--accept is for --import", usage)
	}
	response, err := shadowCall(r, ctx, o, c, operation, input)
	if err != nil || o.Format != "text" {
		return r.result(o, response, err, "")
	}
	if operation == "xero.chart.import" {
		var imported api.XeroChartImported
		if json.Unmarshal(response.Data, &imported) != nil {
			return r.result(o, response, nil, "")
		}
		fmt.Fprintf(r.Output, "Imported the chart and saved %d %s.\n\n", imported.Saved, shadowPlural(imported.Saved, "choice", "choices"))
		printXeroChart(r.Output, imported.Preview)
		return 0
	}
	var preview api.XeroChartPreview
	if json.Unmarshal(response.Data, &preview) != nil {
		return r.result(o, response, nil, "")
	}
	printXeroChart(r.Output, preview)
	if !hasFile {
		return 0
	}
	if xeroHasErrors(preview.Issues) {
		return 3
	}
	fmt.Fprintf(r.Output, "\nNothing was saved. Save what you accept with: rastrata xero chart --file FILE --import --accept likely [--map CODE=ACCOUNT,...] [--skip CODE,...]\n")
	return 0
}

func baseName(path string) string {
	if at := strings.LastIndexAny(path, "/\\"); at >= 0 {
		return path[at+1:]
	}
	return path
}

func xeroHasErrors(issues []api.XeroIssue) bool {
	for _, issue := range issues {
		if issue.Severity == "error" {
			return true
		}
	}
	return false
}

func printXeroIssues(w io.Writer, issues []api.XeroIssue) {
	if len(issues) == 0 {
		return
	}
	fmt.Fprintln(w, "\nProblems found in the file:")
	for _, issue := range issues {
		where := ""
		if issue.Row != nil {
			where = fmt.Sprintf("row %d: ", *issue.Row)
		}
		fmt.Fprintf(w, "  %-8s %s%s\n", issue.Severity, where, shadowPlain(issue.Message))
	}
}

// printXeroColumns says how a file's columns were read: the header the file used and what each was
// taken to be. A header that was expected and is missing is the usual difference between Xero's
// documentation and a real export, so a person sees it before anything is kept. The header is the
// file's own text: it is made plain and bounded.
func printXeroColumns(w io.Writer, columns []api.XeroColumn) {
	if len(columns) == 0 {
		return
	}
	parts := make([]string, 0, len(columns))
	for _, column := range columns {
		parts = append(parts, fmt.Sprintf("%q as %s", shadowClip(shadowPlain(column.Header), 30), column.Field))
	}
	fmt.Fprintf(w, "Columns read: %s\n", strings.Join(parts, "; "))
}

func printXeroChart(w io.Writer, preview api.XeroChartPreview) {
	counts := preview.Counts
	source := "the stored chart"
	if preview.Source == "file" {
		source = "the file"
		if preview.Name != nil && *preview.Name != "" {
			source = shadowClip(*preview.Name, 40)
		}
	}
	fmt.Fprintf(w, "Xero chart from %s: %d accounts. Mapped %d (%d certain, %d likely), left out %d, not mapped %d (%d with a balance; %d have a candidate to check).\n",
		source, counts.Accounts, counts.Mapped, counts.Certain, counts.Likely, counts.Skipped, counts.Unmapped, counts.UnmappedWithBalance, counts.Check)
	printXeroColumns(w, preview.Columns)
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %-8s %-34s %-22s %-34s %s\n", "Code", "Xero account", "Type", "Becomes", "How sure")
	for _, row := range preview.Accounts {
		becomes := "-"
		sure := "-"
		switch {
		case row.Skip:
			becomes, sure = "(left out)", "chosen"
		case row.AccountID != nil && row.AccountCode != nil && row.AccountName != nil:
			becomes, sure = shadowClip(*row.AccountCode+" "+*row.AccountName, 34), row.Confidence
			if row.Basis == "saved" || row.Basis == "override" {
				sure = "chosen"
			}
		}
		typeText := row.Type
		if row.TypeLabel != nil {
			typeText = *row.TypeLabel
		}
		fmt.Fprintf(w, "  %-8s %-34s %-22s %-34s %s\n", shadowClip(row.Code, 8), shadowClip(row.Name, 34), shadowClip(typeText, 22), becomes, sure)
	}
	first := true
	for _, row := range preview.Accounts {
		if row.AccountID != nil || row.Skip {
			continue
		}
		if first {
			fmt.Fprintln(w, "\nNot mapped:")
			first = false
		}
		line := fmt.Sprintf("  %-8s %-34s", shadowClip(row.Code, 8), shadowClip(row.Name, 34))
		if row.Balance != nil && *row.Balance != "0.00" {
			line += fmt.Sprintf(" balance %s", shadowGrouped(*row.Balance))
		}
		fmt.Fprintln(w, line)
		if len(row.Candidates) > 0 {
			names := []string{}
			for _, candidate := range row.Candidates {
				names = append(names, shadowClip(candidate.Code+" "+candidate.Name, 34))
			}
			fmt.Fprintf(w, "           could be: %s (check, then map it with --map %s=ACCOUNT)\n", strings.Join(names, "; "), shadowClip(row.Code, 8))
		} else if row.Suggestion != nil {
			suggestion := "create " + strings.TrimSpace(row.Suggestion.Role+" account")
			if row.Suggestion.Like != nil {
				suggestion += " like the templates' " + shadowClip(*row.Suggestion.Like, 30)
			}
			if row.Suggestion.RoleKey != nil {
				suggestion += ", role key " + *row.Suggestion.RoleKey
			}
			fmt.Fprintf(w, "           nothing in the book resembles it: %s, or leave it out with --skip %s\n", suggestion, shadowClip(row.Code, 8))
		}
		for _, problem := range row.Problems {
			fmt.Fprintf(w, "           problem: %s\n", xeroProblemText(problem))
		}
	}
	printXeroIssues(w, preview.Issues)
}

func xeroProblemText(problem string) string {
	switch problem {
	case "target_missing":
		return "the account it was mapped to is not in the book"
	case "target_closed":
		return "the account it is mapped to is closed"
	case "role_differs":
		return "the account it is mapped to is another kind of account"
	case "target_taken":
		return "a better match already stands for that account of the book"
	case "unknown_role":
		return "its Xero type is not known, so its kind is not known"
	}
	return problem
}

// ---- mapping ------------------------------------------------------------------------------------

func runXeroMappingSet(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero mapping set [--map CODE=ACCOUNT,...] [--skip CODE,...] [--clear CODE,...]"
	if len(o.Args) != 3 {
		return shadowUsage(r, o, "xero mapping set takes no arguments", usage)
	}
	flags := []string{"map", "skip", "clear"}
	if problem := shadowFlagProblem(o, flags, flags); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	choices, failed := xeroChoices(r, o, usage)
	if failed != 0 {
		return failed
	}
	input := map[string]any{"choices": choices}
	clear := []string{}
	if value, given := o.Flags["clear"]; given {
		clear = shadowList(value)
	}
	input["clear"] = clear
	if len(choices) == 0 && len(clear) == 0 {
		return shadowUsage(r, o, "give something to change: --map, --skip or --clear", usage)
	}
	response, err := shadowCall(r, ctx, o, c, "xero.mapping.set", input)
	if err == nil && o.Format == "text" {
		var result api.XeroMappingResult
		if json.Unmarshal(response.Data, &result) == nil {
			fmt.Fprintf(r.Output, "Saved %d, cleared %d. %d of %d Xero accounts are mapped, %d left out, %d not mapped.\n", result.Saved, result.Cleared, result.Counts.Mapped, result.Counts.Accounts, result.Counts.Skipped, result.Counts.Unmapped)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

// ---- trial balance ------------------------------------------------------------------------------

func runXeroTrialBalance(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero trial-balance --file FILE [--name NAME] [--as-of D] [--date-order mdy|dmy] [--decimal comma] [--include-profit-loss] [--map CODE=ACCOUNT,...] [--skip CODE,...] [--import] [--skip-unreadable] [--balances-only] [--statement ID=AMOUNT,...]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "xero trial-balance takes no arguments", usage)
	}
	// --as-of is one of the global options (the date a report is as at), so it is in o.AsOf.
	flags := []string{"file", "name", "date-order", "decimal", "include-profit-loss", "map", "skip", "import", "skip-unreadable", "balances-only", "statement"}
	valued := []string{"file", "name", "date-order", "decimal", "map", "skip", "statement"}
	if problem := shadowFlagProblem(o, flags, valued); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	text, _, failed := readXeroFile(r, o, usage, true)
	if failed != 0 {
		return failed
	}
	choices, failed := xeroChoices(r, o, usage)
	if failed != 0 {
		return failed
	}
	input := map[string]any{"text": text}
	if name, given := o.Flags["name"]; given {
		input["name"] = name
	} else if path := o.Flags["file"]; path != "-" {
		input["name"] = baseName(path)
	}
	if o.AsOf != "" {
		input["asOf"] = o.AsOf
	}
	if order, given := o.Flags["date-order"]; given {
		if order != "mdy" && order != "dmy" {
			return shadowUsage(r, o, "--date-order is mdy (month first, as in a US organisation) or dmy", usage)
		}
		input["dateOrder"] = order
	}
	xeroDecimal(o, input)
	if xeroFlag(o, "include-profit-loss") {
		input["includeProfitLoss"] = true
	}
	if len(choices) > 0 {
		input["overrides"] = choices
	}
	operation := "xero.trialBalance.preview"
	if xeroFlag(o, "import") {
		operation = "xero.trialBalance.import"
		if xeroFlag(o, "skip-unreadable") {
			input["skipUnreadable"] = true
		}
	}
	response, err := shadowCall(r, ctx, o, c, operation, input)
	if err != nil {
		return r.result(o, response, err, "")
	}
	var preview api.XeroTbPreview
	imported := false
	if operation == "xero.trialBalance.import" {
		var result api.XeroTbImported
		if json.Unmarshal(response.Data, &result) != nil {
			return r.result(o, response, nil, "")
		}
		preview, imported = result.Preview, true
	} else if json.Unmarshal(response.Data, &preview) != nil {
		return r.result(o, response, nil, "")
	}
	if xeroFlag(o, "balances-only") {
		list, problem := xeroBalanceList(preview, o.Flags["statement"])
		if problem != "" {
			return shadowUsage(r, o, problem, usage)
		}
		fmt.Fprintln(r.Output, list)
		return 0
	}
	if o.Format != "text" {
		return r.result(o, response, nil, "")
	}
	printXeroTrialBalance(r.Output, preview)
	if imported {
		fmt.Fprintf(r.Output, "\nKept for the tie-out, as at %s.\n", shadowDash(preview.AsOf))
	}
	if !preview.Balanced || xeroHasErrors(preview.Issues) {
		return 3
	}
	return 0
}

// xeroBalanceList is the balances of a trial balance as `ID=AMOUNT,...` for `opening review
// --balances`, with each --statement ID=AMOUNT put in place of the account's own balance.
func xeroBalanceList(preview api.XeroTbPreview, statement string) (string, string) {
	amounts := map[string]string{}
	order := []string{}
	for _, entry := range preview.Balances {
		amounts[entry.AccountID] = entry.Balance
		order = append(order, entry.AccountID)
	}
	for _, pair := range shadowList(statement) {
		account, amount, found := strings.Cut(pair, "=")
		account, amount = strings.TrimSpace(account), strings.TrimSpace(amount)
		if !found || account == "" || amount == "" {
			return "", "--statement is a comma separated list of ID=AMOUNT, for example 1000=12000.00 (an account of the book by id, and the balance on its statement)"
		}
		if _, known := amounts[account]; !known {
			order = append(order, account)
		}
		amounts[account] = amount
	}
	parts := []string{}
	for _, account := range order {
		parts = append(parts, account+"="+amounts[account])
	}
	return strings.Join(parts, ","), ""
}

func printXeroTrialBalance(w io.Writer, tb api.XeroTbPreview) {
	state := "balances"
	if !tb.Balanced {
		state = "DOES NOT BALANCE"
	}
	name := ""
	if tb.Organisation != nil {
		name = " (" + shadowClip(*tb.Organisation, 40) + ")"
	}
	fmt.Fprintf(w, "Xero trial balance as at %s%s: %s. Debits %s, credits %s (year to date).\n", shadowDash(tb.AsOf), name, state, shadowGrouped(tb.Sums.YtdDebit), shadowGrouped(tb.Sums.YtdCredit))
	printXeroColumns(w, tb.Columns)
	if tb.Cutover != nil {
		same := "this is not that day"
		if tb.Cutover.AsOfIsDayBefore {
			same = "this is that day"
		}
		fmt.Fprintf(w, "The cutover date is %s; the opening entry holds the balances at the end of %s: %s.\n", tb.Cutover.Date, tb.Cutover.DayBefore, same)
	}
	fmt.Fprintf(w, "\n  %-8s %-34s %-34s %14s  %s\n", "Code", "Xero account", "Becomes", "Balance", "What happens")
	for _, row := range tb.Rows {
		code := "-"
		if row.XeroCode != nil {
			code = *row.XeroCode
		}
		becomes, balance := "-", ""
		if row.AccountCode != nil && row.AccountName != nil {
			becomes = shadowClip(*row.AccountCode+" "+*row.AccountName, 34)
		}
		if row.Balance != nil {
			balance = shadowGrouped(*row.Balance)
		}
		fmt.Fprintf(w, "  %-8s %-34s %-34s %14s  %s\n", shadowClip(code, 8), shadowClip(row.Name, 34), becomes, balance, xeroTbStatusText(row.Status, row.Net))
	}
	left := tb.LeftOut
	fmt.Fprintln(w, "\nNot in the balances (the offset account carries the difference):")
	fmt.Fprintf(w, "  income and expense accounts: %d, net %s (debits less credits)\n", left.ProfitLoss, shadowGrouped(left.ProfitLossNet))
	fmt.Fprintf(w, "  Xero's retained earnings: %s\n", shadowGrouped(left.RetainedEarnings))
	fmt.Fprintf(w, "  accounts not mapped: %d, net %s; left out on purpose: %d, net %s\n", left.Unmapped, shadowGrouped(left.UnmappedNet), left.Skipped, shadowGrouped(left.SkippedNet))
	fmt.Fprintf(w, "\n%d balances for the opening review: use --balances-only for the list, and replace each bank, card and Stripe balance with its statement balance (--statement ID=AMOUNT).\n", len(tb.Balances))
	printXeroIssues(w, tb.Issues)
}

func xeroTbStatusText(status string, net string) string {
	switch status {
	case "mapped":
		return "in the opening balances"
	case "zero":
		return "nothing to carry"
	case "skipped":
		return "left out on purpose (net " + shadowGrouped(net) + ")"
	case "profit_loss":
		return "income or expense: left out (net " + shadowGrouped(net) + ")"
	case "retained_earnings":
		return "retained earnings: the offset carries it (net " + shadowGrouped(net) + ")"
	}
	return "NOT MAPPED (net " + shadowGrouped(net) + ")"
}

// ---- transactions -------------------------------------------------------------------------------

func runXeroTransactions(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero transactions --file FILE [--name NAME] [--date-order mdy|dmy] [--decimal comma] [--import] [--skip-unreadable]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "xero transactions takes no arguments", usage)
	}
	flags := []string{"file", "name", "date-order", "decimal", "import", "skip-unreadable"}
	if problem := shadowFlagProblem(o, flags, []string{"file", "name", "date-order", "decimal"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	text, _, failed := readXeroFile(r, o, usage, true)
	if failed != 0 {
		return failed
	}
	input := map[string]any{"text": text}
	if name, given := o.Flags["name"]; given {
		input["name"] = name
	} else if path := o.Flags["file"]; path != "-" {
		input["name"] = baseName(path)
	}
	if order, given := o.Flags["date-order"]; given {
		if order != "mdy" && order != "dmy" {
			return shadowUsage(r, o, "--date-order is mdy (month first, as in a US organisation) or dmy", usage)
		}
		input["dateOrder"] = order
	}
	xeroDecimal(o, input)
	operation := "xero.transactions.preview"
	if xeroFlag(o, "import") {
		operation = "xero.transactions.import"
		if xeroFlag(o, "skip-unreadable") {
			input["skipUnreadable"] = true
		}
	}
	response, err := shadowCall(r, ctx, o, c, operation, input)
	if err != nil || o.Format != "text" {
		return r.result(o, response, err, "")
	}
	var preview api.XeroAtPreview
	stored, replaced := 0, 0
	if operation == "xero.transactions.import" {
		var result api.XeroAtImported
		if json.Unmarshal(response.Data, &result) != nil {
			return r.result(o, response, nil, "")
		}
		preview, stored, replaced = result.Preview, result.Stored, result.Replaced
	} else if json.Unmarshal(response.Data, &preview) != nil {
		return r.result(o, response, nil, "")
	}
	printXeroTransactions(r.Output, preview)
	if operation == "xero.transactions.import" {
		fmt.Fprintf(r.Output, "\nKept %d lines for the tie-out; %d earlier lines of the same accounts on the same dates were replaced.\n", stored, replaced)
		return 0
	}
	if xeroHasErrors(preview.Issues) {
		return 3
	}
	fmt.Fprintln(r.Output, "\nNothing was kept. Keep it for the tie-out with --import.")
	return 0
}

func printXeroTransactions(w io.Writer, preview api.XeroAtPreview) {
	period := "no period given"
	if preview.PeriodFrom != nil && preview.PeriodTo != nil {
		period = *preview.PeriodFrom + " to " + *preview.PeriodTo
	}
	fmt.Fprintf(w, "Xero account transactions, %s: %d accounts, %d lines.\n", period, len(preview.Blocks), preview.LineCount)
	printXeroColumns(w, preview.Columns)
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %-34s %-34s %6s %14s %14s  %s\n", "Xero account", "Becomes", "Lines", "Debit", "Credit", "Total row")
	for _, block := range preview.Blocks {
		becomes := "(not mapped)"
		switch block.Status {
		case "skipped":
			becomes = "(left out)"
		case "mapped":
			if block.AccountCode != nil && block.AccountName != nil {
				becomes = shadowClip(*block.AccountCode+" "+*block.AccountName, 34)
			}
		}
		check := "none in the file"
		if block.FileDebit != nil && block.FileCredit != nil {
			check = "agrees"
			if *block.FileDebit != block.Debit || *block.FileCredit != block.Credit {
				check = "DOES NOT AGREE (" + shadowGrouped(*block.FileDebit) + " / " + shadowGrouped(*block.FileCredit) + ")"
			}
		}
		fmt.Fprintf(w, "  %-34s %-34s %6d %14s %14s  %s\n", shadowClip(block.Name, 34), becomes, block.Lines, shadowGrouped(block.Debit), shadowGrouped(block.Credit), check)
	}
	printXeroIssues(w, preview.Issues)
}

// ---- where Xero was reconciled ------------------------------------------------------------------

func runXeroReconciled(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero reconciled [--set CODE=DATE,...] [--clear CODE,...] [--note TEXT]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "xero reconciled takes no arguments", usage)
	}
	flags := []string{"set", "clear", "note"}
	if problem := shadowFlagProblem(o, flags, flags); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	choices := []map[string]any{}
	for _, pair := range shadowList(o.Flags["set"]) {
		code, date, found := strings.Cut(pair, "=")
		code, date = strings.TrimSpace(code), strings.TrimSpace(date)
		if !found || code == "" || date == "" {
			return shadowUsage(r, o, "--set is a comma separated list of CODE=DATE, for example 090=2026-08-31 (the Xero bank account's code and the date it was reconciled through)", usage)
		}
		choice := map[string]any{"code": code, "through": date}
		if note, given := o.Flags["note"]; given {
			choice["note"] = note
		}
		choices = append(choices, choice)
	}
	clear := shadowList(o.Flags["clear"])
	var response api.Response
	var err error
	if len(choices) == 0 && len(clear) == 0 {
		// No change asked: show where it stands.
		response, err = shadowCall(r, ctx, o, c, "xero.status", map[string]any{})
		if err == nil && o.Format == "text" {
			var status api.XeroStatus
			if json.Unmarshal(response.Data, &status) == nil {
				printXeroReconciled(r.Output, status.Reconciled)
				return 0
			}
		}
		return r.result(o, response, err, "")
	}
	response, err = shadowCall(r, ctx, o, c, "xero.reconciled.set", map[string]any{"choices": choices, "clear": clear})
	if err == nil && o.Format == "text" {
		var state api.XeroReconciled
		if json.Unmarshal(response.Data, &state) == nil {
			printXeroReconciled(r.Output, state.Entries)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func printXeroReconciled(w io.Writer, entries []api.XeroReconciledState) {
	if len(entries) == 0 {
		fmt.Fprintln(w, "No date is recorded for any Xero bank account. Record each with: rastrata xero reconciled --set CODE=DATE")
		return
	}
	fmt.Fprintln(w, "Xero was reconciled through:")
	for _, entry := range entries {
		name := ""
		if entry.Name != nil {
			name = shadowClip(*entry.Name, 34)
		}
		note := ""
		if entry.Note != "" {
			note = "  " + shadowClip(entry.Note, 40)
		}
		fmt.Fprintf(w, "  %-8s %-34s %s%s\n", shadowClip(entry.Code, 8), name, entry.Through, note)
	}
}

// ---- tie-out ------------------------------------------------------------------------------------

func tieOutInput(r Runner, o Options, usage string) (map[string]any, int) {
	input := map[string]any{}
	if value, given := o.Flags["from"]; given {
		input["from"] = value
	}
	if value, given := o.Flags["to"]; given {
		input["to"] = value
	}
	if value, given := o.Flags["tolerance"]; given {
		days, err := strconv.Atoi(value)
		if err != nil || days < 0 || days > 14 {
			return nil, shadowUsage(r, o, "--tolerance is a number of days from 0 to 14", usage)
		}
		input["toleranceDays"] = days
	}
	return input, 0
}

func runXeroTieOut(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "xero tie-out [--from D] [--to D] [--tolerance DAYS] [--record]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "xero tie-out takes no arguments", usage)
	}
	flags := []string{"from", "to", "tolerance", "record"}
	if problem := shadowFlagProblem(o, flags, []string{"from", "to", "tolerance"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	input, failed := tieOutInput(r, o, usage)
	if failed != 0 {
		return failed
	}
	if xeroFlag(o, "record") {
		response, err := shadowCall(r, ctx, o, c, "tieout.record", input)
		if err == nil && o.Format == "text" {
			var result api.TieoutRecordResult
			if json.Unmarshal(response.Data, &result) == nil {
				fmt.Fprintf(r.Output, "Added %d to the gap log (%d were already there).\n\n", result.Added, result.Existing)
				printGaps(r.Output, result.Gaps)
				fmt.Fprintln(r.Output)
				printTieOutSummary(r.Output, result.Summary)
				return 0
			}
		}
		return r.result(o, response, err, "")
	}
	response, err := shadowCall(r, ctx, o, c, "tieout.report", input)
	if err == nil && o.Format == "text" {
		var report api.TieoutReport
		if json.Unmarshal(response.Data, &report) == nil {
			printTieOut(r.Output, report)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func printTieOutSummary(w io.Writer, summary api.TieoutSummary) {
	fmt.Fprintf(w, "%d %s: %d accounts compared (%d match, %d differ: %d explained to the cent, %d not), %d not comparable. Lines only in Xero: %d; only in Rastrata: %d.\n",
		summary.Periods, shadowPlural(summary.Periods, "period", "periods"), summary.Comparable, summary.Matches, summary.Differs, summary.Explained, summary.Unexplained, summary.NotComparable, summary.LinesOnlyInXero, summary.LinesOnlyInRastrata)
}

func printTieOut(w io.Writer, report api.TieoutReport) {
	cutover := "no cutover date is recorded"
	if report.CutoverDate != nil {
		cutover = "cutover " + *report.CutoverDate
	}
	fmt.Fprintf(w, "Tie-out against Xero (%s, %s basis, %s). Lines pair within %d days.\n", report.Currency, report.Basis, cutover, report.ToleranceDays)
	printTieOutSummary(w, report.Summary)
	for _, period := range report.Periods {
		fmt.Fprintf(w, "\nPeriod %s to %s", period.From, period.To)
		if period.XeroReconciled {
			fmt.Fprintln(w, ": Xero was reconciled through its end.")
		} else {
			fmt.Fprintln(w, ": Xero was NOT reconciled through its end:")
			for _, bank := range period.NotReconciled {
				through := "no date given"
				if bank.Through != nil {
					through = "through " + *bank.Through
				}
				fmt.Fprintf(w, "    %-8s %-34s %s\n", shadowClip(bank.Code, 8), shadowClip(bank.Name, 34), through)
			}
		}
		for _, account := range period.Accounts {
			label := fmt.Sprintf("  %-7s %-30s %-8s", shadowClip(account.Code, 7), shadowClip(account.Name, 30), account.Basis)
			switch account.Status {
			case "not_comparable":
				reason := ""
				if account.Reason != nil {
					reason = account.Reason.Message
				}
				fmt.Fprintf(w, "%s not comparable: %s\n", label, shadowPlain(reason))
			case "matches":
				fmt.Fprintf(w, "%s %14s  matches\n", label, shadowGrouped(shadowDash(account.Rastrata)))
			default:
				state := "not explained"
				if account.Explained {
					state = "explained to the cent"
				}
				fmt.Fprintf(w, "%s Xero %s, Rastrata %s: differs by %s (%s)\n", label, shadowGrouped(shadowDash(account.Xero)), shadowGrouped(shadowDash(account.Rastrata)), shadowGrouped(shadowDash(account.Difference)), state)
				if account.Carried != nil && *account.Carried != "0.00" {
					fmt.Fprintf(w, "            %s of that was already there when the period began\n", shadowGrouped(*account.Carried))
				}
				if account.Residual != nil && *account.Residual != "0.00" {
					fmt.Fprintf(w, "            %s is not accounted for by the lines\n", shadowGrouped(*account.Residual))
				}
				if account.Unmatched == nil {
					fmt.Fprintln(w, "            no Xero transactions cover the period, so the lines cannot be compared")
				} else {
					shown := 0
					for _, line := range *account.Unmatched {
						if shown == 10 {
							rest := len(*account.Unmatched) - shown
							fmt.Fprintf(w, "            and %d more\n", rest)
							break
						}
						only := "only in Xero    "
						if line.Side == "rastrata" {
							only = "only in Rastrata"
						}
						amount := shadowGrouped(line.Debit) + " debit"
						if line.Debit == "0.00" {
							amount = shadowGrouped(line.Credit) + " credit"
						}
						fmt.Fprintf(w, "            %s %s %14s  %s\n", only, line.Date, amount, shadowClip(line.Description, 40))
						shown++
					}
				}
			}
		}
		for _, item := range period.Unmapped {
			fmt.Fprintf(w, "  Xero account %s %s holds %s and nothing in the book is mapped to it\n", shadowClip(item.Code, 8), shadowClip(item.Name, 30), shadowGrouped(item.Net))
		}
	}
	for _, note := range report.Notes {
		fmt.Fprintf(w, "\nNote: %s\n", shadowPlain(note))
	}
}

// ---- the gap log --------------------------------------------------------------------------------

func printGaps(w io.Writer, gaps []api.Gap) {
	if len(gaps) == 0 {
		fmt.Fprintln(w, "No gaps.")
		return
	}
	sorted := append([]api.Gap{}, gaps...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	for _, gap := range sorted {
		fmt.Fprintf(w, "  #%-4d %-6s %-10s %s\n", gap.ID, gap.Status, gap.Kind, shadowClip(gap.Title, 100))
		if gap.Status == "closed" && gap.Resolution != nil {
			fmt.Fprintf(w, "         closed by %s: %s\n", shadowPlain(shadowDash(gap.ClosedBy)), shadowClip(*gap.Resolution, 100))
		}
	}
}

func runGapsList(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "gaps list [--status open|closed|all]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "gaps list takes no arguments", usage)
	}
	if problem := shadowFlagProblem(o, []string{"status"}, []string{"status"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if status, given := o.Flags["status"]; given {
		if status != "open" && status != "closed" && status != "all" {
			return shadowUsage(r, o, "--status is open, closed or all", usage)
		}
		input["status"] = status
	}
	response, err := shadowCall(r, ctx, o, c, "gaps.list", input)
	if err == nil && o.Format == "text" {
		var list api.GapList
		if json.Unmarshal(response.Data, &list) == nil {
			printGaps(r.Output, list.Gaps)
			fmt.Fprintf(r.Output, "\n%d open, %d closed.\n", list.Open, list.Closed)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runGapsAdd(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "gaps add --title TEXT [--detail TEXT] [--kind difference|unmapped|feature|data|other]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "gaps add takes no arguments", usage)
	}
	flags := []string{"title", "detail", "kind"}
	if problem := shadowFlagProblem(o, flags, flags); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	title, given := o.Flags["title"]
	if !given {
		return shadowUsage(r, o, "--title is required", usage)
	}
	input := map[string]any{"title": title}
	if detail, given := o.Flags["detail"]; given {
		input["detail"] = detail
	}
	if kind, given := o.Flags["kind"]; given {
		input["kind"] = kind
	}
	response, err := shadowCall(r, ctx, o, c, "gaps.add", input)
	if err == nil && o.Format == "text" {
		var gap api.Gap
		if json.Unmarshal(response.Data, &gap) == nil {
			printGaps(r.Output, []api.Gap{gap})
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func gapUpdate(r Runner, ctx context.Context, o Options, c *api.Client, usage, status, noteFlag string) int {
	if len(o.Args) != 3 {
		return shadowUsage(r, o, "name the gap by its number", usage)
	}
	id, err := strconv.Atoi(o.Args[2])
	if err != nil || id < 0 {
		return shadowUsage(r, o, "the gap's number is a whole number, as `gaps list` shows it", usage)
	}
	input := map[string]any{"id": id, "status": status}
	if note, given := o.Flags[noteFlag]; given {
		input["resolution"] = note
	} else if status == "closed" {
		return shadowUsage(r, o, "--resolution is required: say what was found", usage)
	}
	response, callErr := shadowCall(r, ctx, o, c, "gaps.update", input)
	if callErr == nil && o.Format == "text" {
		var gap api.Gap
		if json.Unmarshal(response.Data, &gap) == nil {
			printGaps(r.Output, []api.Gap{gap})
			return 0
		}
	}
	return r.result(o, response, callErr, "")
}

func runGapsClose(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "gaps close ID --resolution TEXT"
	if problem := shadowFlagProblem(o, []string{"resolution"}, []string{"resolution"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	return gapUpdate(r, ctx, o, c, usage, "closed", "resolution")
}

func runGapsReopen(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "gaps reopen ID [--note TEXT]"
	if problem := shadowFlagProblem(o, []string{"note"}, []string{"note"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	return gapUpdate(r, ctx, o, c, usage, "open", "note")
}

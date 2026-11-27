package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The shadow lane's commands: starting the books from opening balances, recording the cutover
// date, and the checklist that says whether a month can close. The books are proven against bank
// and card statements and Stripe's own balance, not against the old system.
//
//	rastrata opening review --date D (--csv FILE | --balances ID=AMOUNT,...) [--offset ID]
//	rastrata opening plan   --date D (--csv FILE | --balances ID=AMOUNT,...) [--offset ID]
//	rastrata cutover show   [--date D] [--accounts ID,ID]
//	rastrata cutover set    --date D [--accounts ID,ID]
//	rastrata cutover checklist [--period ID] [--check]
//
// Every command prints the JSON envelope; --format text prints a plain table for a person. Nothing
// here posts: `opening plan` ends at a prepared plan, and `operations commit PLAN_ID PLAN_HASH` is
// what changes the books.
func init() {
	Register(Command{Name: "opening review", Summary: "Opening balances: check them and see the one entry they make; changes nothing --date D (--csv FILE | --balances ID=AMOUNT,...) [--offset ID]", Run: runOpeningReview})
	Register(Command{Name: "opening plan", Summary: "Opening balances: save the one entry as a draft and prepare it; then commit with operations commit --date D (--csv FILE | --balances ...) [--offset ID]", Run: runOpeningPlan})
	Register(Command{Name: "cutover show", Summary: "The cutover: the recorded date, the opening entry's state, and where each statement source starts [--date D] [--accounts ID,ID]", Run: runCutoverShow})
	Register(Command{Name: "cutover set", Summary: "Record the cutover date and give it to the Inbox's statement sources --date D [--accounts ID,ID]", Run: runCutoverSet})
	Register(Command{Name: "cutover checklist", Summary: "Can this period close? Per account, Stripe, the Inbox, backups and the shadow run [--period ID] [--check]", Run: runCutoverChecklist})
}

// maxOpeningCSV is the most CSV text one request carries; the service limits a request to 128 KiB.
const maxOpeningCSV = 120000

func shadowUsage(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

// shadowFlagProblem names the first flag that is not allowed, or a valued flag given bare.
func shadowFlagProblem(o Options, allowed []string, valued []string) string {
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

func shadowCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) (api.Response, error) {
	definition, _ := api.FindOperation(operation)
	operationID := ""
	if definition.Writes {
		operationID = o.OperationID
		if operationID == "" {
			operationID = api.NewOperationID()
		}
		fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
	}
	return c.Call(ctx, operation, input, operationID)
}

// splitList reads "a,b,c" into trimmed, non-empty items.
func shadowList(value string) []string {
	items := []string{}
	for _, item := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return items
}

// openingInput builds the input of opening review and opening plan from the flags.
func openingInput(r Runner, o Options, command string) (map[string]any, int) {
	usage := command + " --date YYYY-MM-DD (--csv FILE | --balances ID=AMOUNT,...) [--offset ID]"
	if len(o.Args) != 2 {
		return nil, shadowUsage(r, o, command+" takes no arguments", usage)
	}
	flags := []string{"date", "csv", "balances", "offset"}
	if problem := shadowFlagProblem(o, flags, flags); problem != "" {
		return nil, shadowUsage(r, o, problem, usage)
	}
	date, hasDate := o.Flags["date"]
	if !hasDate {
		return nil, shadowUsage(r, o, "--date is required: the first day of the books", usage)
	}
	input := map[string]any{"cutoverDate": date}
	csvPath, hasCSV := o.Flags["csv"]
	balances, hasBalances := o.Flags["balances"]
	if hasCSV == hasBalances {
		return nil, shadowUsage(r, o, "give the balances as --csv FILE or as --balances ID=AMOUNT,..., one of the two", usage)
	}
	if hasCSV {
		var data []byte
		var err error
		if csvPath == "-" {
			data, err = io.ReadAll(io.LimitReader(r.Input, maxOpeningCSV+1))
		} else {
			data, err = os.ReadFile(csvPath)
		}
		if err != nil {
			return nil, r.localError(o, "input_unavailable", err.Error(), 2)
		}
		if len(data) > maxOpeningCSV {
			return nil, shadowUsage(r, o, fmt.Sprintf("the CSV is larger than %d bytes; opening balances are one row per account", maxOpeningCSV), usage)
		}
		if !utf8.Valid(data) {
			return nil, shadowUsage(r, o, "the CSV is not UTF-8 text; save it as UTF-8", usage)
		}
		input["csv"] = string(data)
	} else {
		entries := []map[string]string{}
		for _, pair := range shadowList(balances) {
			account, amount, found := strings.Cut(pair, "=")
			account, amount = strings.TrimSpace(account), strings.TrimSpace(amount)
			if !found || account == "" || amount == "" {
				return nil, shadowUsage(r, o, "--balances is a comma separated list of ID=AMOUNT, for example 1000=12000.00,2000=523.10", usage)
			}
			entries = append(entries, map[string]string{"accountId": account, "balance": amount})
		}
		if len(entries) == 0 {
			return nil, shadowUsage(r, o, "--balances is empty", usage)
		}
		input["balances"] = entries
	}
	if offset, given := o.Flags["offset"]; given {
		input["offsetAccountId"] = offset
	}
	return input, 0
}

func runOpeningReview(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, failed := openingInput(r, o, "opening review")
	if failed != 0 {
		return failed
	}
	response, err := shadowCall(r, ctx, o, c, "opening.review", input)
	if err == nil && o.Format == "text" {
		var review api.OpeningReview
		if json.Unmarshal(response.Data, &review) == nil {
			printOpeningReview(r.Output, review)
			if !review.Valid {
				return 3
			}
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runOpeningPlan(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, failed := openingInput(r, o, "opening plan")
	if failed != 0 {
		return failed
	}
	response, err := shadowCall(r, ctx, o, c, "opening.plan", input)
	if err != nil {
		return r.result(o, response, err, "")
	}
	var plan api.OpeningPlan
	if json.Unmarshal(response.Data, &plan) == nil {
		fmt.Fprintf(r.Diagnostics, "Prepared, not posted. Review the entry, then: rastrata operations commit %s %s\n", plan.Plan.PlanID, plan.Plan.PlanHash)
		if o.Format == "text" {
			printOpeningReview(r.Output, plan.Review)
			fmt.Fprintf(r.Output, "\nPlan %s\nHash %s\nCommit it with: rastrata operations commit %s %s\n", plan.Plan.PlanID, plan.Plan.PlanHash, plan.Plan.PlanID, plan.Plan.PlanHash)
			if !plan.Plan.Valid {
				return 3
			}
			return 0
		}
		if !plan.Plan.Valid {
			_ = json.NewEncoder(r.Output).Encode(response)
			return 3
		}
	}
	return r.result(o, response, nil, "")
}

func cutoverInput(r Runner, o Options, command string, requireDate bool) (map[string]any, int) {
	usage := command + " " + map[bool]string{true: "--date YYYY-MM-DD", false: "[--date YYYY-MM-DD]"}[requireDate] + " [--accounts ID,ID]"
	if len(o.Args) != 2 {
		return nil, shadowUsage(r, o, command+" takes no arguments", usage)
	}
	flags := []string{"date", "accounts"}
	if problem := shadowFlagProblem(o, flags, flags); problem != "" {
		return nil, shadowUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if date, given := o.Flags["date"]; given {
		input["cutoverDate"] = date
	} else if requireDate {
		return nil, shadowUsage(r, o, "--date is required: the first day of the books", usage)
	}
	if accounts, given := o.Flags["accounts"]; given {
		ids := shadowList(accounts)
		if len(ids) == 0 {
			return nil, shadowUsage(r, o, "--accounts is a comma separated list of account ids", usage)
		}
		input["accountIds"] = ids
	}
	return input, 0
}

func runCutoverShow(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, failed := cutoverInput(r, o, "cutover show", false)
	if failed != 0 {
		return failed
	}
	response, err := shadowCall(r, ctx, o, c, "cutover.get", input)
	if err == nil && o.Format == "text" {
		var state api.CutoverState
		if json.Unmarshal(response.Data, &state) == nil {
			printCutoverState(r.Output, state)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runCutoverSet(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, failed := cutoverInput(r, o, "cutover set", true)
	if failed != 0 {
		return failed
	}
	response, err := shadowCall(r, ctx, o, c, "cutover.set", input)
	if err == nil && o.Format == "text" {
		var result api.CutoverSetResult
		if json.Unmarshal(response.Data, &result) == nil {
			fmt.Fprintf(r.Output, "Cutover date recorded. %d statement sources start on it; %d queued lines were set aside, %d brought back.\n\n", result.SourcesSet, result.Excluded, result.Restored)
			printCutoverState(r.Output, result.State)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runCutoverChecklist(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "cutover checklist [--period ID] [--check]"
	if len(o.Args) != 2 {
		return shadowUsage(r, o, "cutover checklist takes no arguments", usage)
	}
	if problem := shadowFlagProblem(o, []string{"period", "check"}, []string{"period"}); problem != "" {
		return shadowUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if period, given := o.Flags["period"]; given {
		input["periodId"] = period
	}
	check := false
	if value, given := o.Flags["check"]; given {
		switch strings.ToLower(value) {
		case "true", "yes", "1":
			check = true
		case "false", "no", "0":
		default:
			return shadowUsage(r, o, "--check is true or false", usage)
		}
	}
	response, err := shadowCall(r, ctx, o, c, "cutover.checklist", input)
	if err != nil {
		return r.result(o, response, err, "")
	}
	var checklist api.CutoverChecklist
	decoded := json.Unmarshal(response.Data, &checklist) == nil
	if o.Format == "text" && decoded {
		printCutoverChecklist(r.Output, checklist)
	} else if exit := r.result(o, response, nil, ""); exit != 0 {
		return exit
	}
	// --check makes "not yet" a failing exit, so a script or an agent can stop on it.
	if check && decoded && checklist.Verdict.State != "ready" {
		return 3
	}
	return 0
}

// ---------------------------------------------------------------------------------------------
// Plain text for a person. Everything that came from outside the service (account names, a CSV
// cell echoed in a message) is made safe to print: control characters and terminal escape
// sequences never reach the terminal.

// plain makes text safe to print on one line.
func shadowPlain(text string) string {
	var out strings.Builder
	for _, symbol := range text {
		switch {
		case symbol == '\n' || symbol == '\r' || symbol == '\t':
			out.WriteRune(' ')
		case symbol < 0x20 || (symbol >= 0x7f && symbol <= 0x9f):
			out.WriteString(fmt.Sprintf("\\u%04x", symbol))
		case symbol >= 0x200b && symbol <= 0x200f, symbol >= 0x202a && symbol <= 0x202e, symbol >= 0x2066 && symbol <= 0x2069, symbol == 0x2028, symbol == 0x2029, symbol == 0xfeff:
			out.WriteString(fmt.Sprintf("\\u%04x", symbol))
		default:
			out.WriteRune(symbol)
		}
	}
	return out.String()
}

// clip cuts text to at most n characters, with an ellipsis.
func shadowClip(text string, n int) string {
	runes := []rune(shadowPlain(text))
	if len(runes) <= n {
		return string(runes)
	}
	return string(runes[:n-1]) + "…"
}

// grouped writes an amount with thousands separators: "12000.00" is "12,000.00".
func shadowGrouped(amount string) string {
	sign := ""
	if strings.HasPrefix(amount, "-") {
		sign, amount = "-", amount[1:]
	}
	whole, fraction, found := strings.Cut(amount, ".")
	var out []byte
	for index := range whole {
		if index > 0 && (len(whole)-index)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, whole[index])
	}
	if found {
		return sign + string(out) + "." + fraction
	}
	return sign + string(out)
}

func shadowDash(value *string) string {
	if value == nil || *value == "" {
		return "-"
	}
	return shadowPlain(*value)
}

func shadowPlural(count int, one, many string) string {
	if count == 1 {
		return one
	}
	return many
}

func printOpeningReview(w io.Writer, review api.OpeningReview) {
	fmt.Fprintf(w, "Opening balances at the start of %s (%s)\n", review.CutoverDate, review.Currency)
	if review.EntryDate != nil {
		fmt.Fprintf(w, "Entry dated: %s\n", *review.EntryDate)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %-7s %-36s %16s %16s\n", "Code", "Account", "Debit", "Credit")
	money := func(amount string) string {
		if amount == "0.00" {
			return ""
		}
		return shadowGrouped(amount)
	}
	for _, line := range review.Lines {
		fmt.Fprintf(w, "  %-7s %-36s %16s %16s\n", shadowClip(line.Code, 7), shadowClip(line.Name, 36), money(line.Debit), money(line.Credit))
	}
	if review.Offset != nil {
		fmt.Fprintf(w, "  %-7s %-36s %16s %16s\n", shadowClip(review.Offset.Code, 7), shadowClip(review.Offset.Name+" (offset)", 36), money(review.Offset.Debit), money(review.Offset.Credit))
	}
	balanced := "does not balance"
	if review.Totals.Balanced {
		balanced = "balanced"
	}
	fmt.Fprintf(w, "  %-7s %-36s %16s %16s   %s\n", "", "Total", shadowGrouped(review.Totals.Debit), shadowGrouped(review.Totals.Credit), balanced)
	if review.Offset != nil {
		fmt.Fprintln(w, "\n  The offset line is calculated so the entry balances: it is everything the balances above do not explain.")
	}
	if review.Valid {
		fmt.Fprintf(w, "\nValid: yes. Source %s\n", shadowDash(review.SourceID))
	} else {
		fmt.Fprintf(w, "\nValid: no. Fix the errors below, then review again.\n")
	}
	if len(review.Issues) > 0 {
		fmt.Fprintln(w)
		for _, issue := range review.Issues {
			where := ""
			if issue.Row != nil {
				where = fmt.Sprintf("row %d: ", *issue.Row)
			}
			fmt.Fprintf(w, "  %-8s %s%s\n", issue.Severity, where, shadowPlain(issue.Message))
		}
	}
}

// shadowOpeningDetail says where the opening entry is dated and, when the opening balances were
// entered by hand rather than through the opening tools, that they were.
func shadowOpeningDetail(opening api.OpeningExisting) string {
	var parts []string
	if opening.EntryDate != nil {
		parts = append(parts, "dated "+*opening.EntryDate)
	}
	if opening.ByHand != nil && *opening.ByHand {
		parts = append(parts, "entered by hand")
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}

func printCutoverState(w io.Writer, state api.CutoverState) {
	if state.Cutover != nil {
		fmt.Fprintf(w, "Cutover date: %s (recorded %s by %s)\n", state.Cutover.CutoverDate, state.Cutover.RecordedAt, shadowPlain(state.Cutover.By))
	} else {
		fmt.Fprintln(w, "Cutover date: not recorded")
	}
	if state.ForDate != nil && (state.Cutover == nil || state.Cutover.CutoverDate != *state.ForDate) {
		fmt.Fprintf(w, "Worked out for: %s (not recorded)\n", *state.ForDate)
	}
	fmt.Fprintf(w, "Opening entry: %s%s\n", state.Opening.Status, shadowOpeningDetail(state.Opening))
	if len(state.Accounts) > 0 {
		fmt.Fprintln(w, "\nAccounts that have statements:")
		for _, account := range state.Accounts {
			mark := "[ ]"
			if account.Chosen {
				mark = "[x]"
			}
			reason := "not suggested"
			if account.Reason != nil {
				reason = "suggested: " + *account.Reason
			}
			fmt.Fprintf(w, "  %s %-7s %-32s %-5s %s\n", mark, shadowClip(account.Code, 7), shadowClip(account.Name, 32), account.Kind, reason)
		}
	}
	if len(state.Sources) > 0 {
		fmt.Fprintln(w, "\nStatement sources:")
		for _, source := range state.Sources {
			fmt.Fprintf(w, "  %-30s starts %-10s -> %-10s %s", shadowClip(source.AccountKey, 30), shadowDash(source.StartOn), shadowDash(source.After), source.Action)
			if source.WouldExclude > 0 {
				fmt.Fprintf(w, "; would set aside %d queued %s", source.WouldExclude, shadowPlural(source.WouldExclude, "line", "lines"))
			}
			if source.WouldRestore > 0 {
				fmt.Fprintf(w, "; would bring back %d", source.WouldRestore)
			}
			if source.Excluded > 0 {
				fmt.Fprintf(w, "; %d set aside already", source.Excluded)
			}
			fmt.Fprintln(w)
		}
	}
	if state.Stripe != nil && state.Stripe.Note != nil {
		fmt.Fprintf(w, "\nStripe: %s\n", shadowPlain(*state.Stripe.Note))
	}
	for _, note := range state.Notes {
		fmt.Fprintf(w, "\nNote: %s\n", shadowPlain(note))
	}
}

func printCutoverChecklist(w io.Writer, checklist api.CutoverChecklist) {
	fmt.Fprintln(w, shadowPlain(checklist.Verdict.Summary))
	fmt.Fprintf(w, "Checked %s at book revision %s. The books are proven against bank and card statements and Stripe's own balance, not against the old system.\n", checklist.AsOf, shadowPlain(checklist.BookRevision))
	if len(checklist.Verdict.Blocking) > 0 {
		fmt.Fprintln(w, "\nIn the way:")
		for _, reason := range checklist.Verdict.Blocking {
			fmt.Fprintf(w, "  - %s\n", shadowPlain(reason.Message))
		}
	}
	if len(checklist.Verdict.Attention) > 0 {
		fmt.Fprintln(w, "\nTo look at:")
		for _, reason := range checklist.Verdict.Attention {
			fmt.Fprintf(w, "  - %s\n", shadowPlain(reason.Message))
		}
	}
	if checklist.Period != nil {
		fmt.Fprintf(w, "\nAccounts for %s (%s to %s)\n", shadowPlain(checklist.Period.Label), checklist.Period.StartsOn, checklist.Period.EndsOn)
	} else {
		fmt.Fprintln(w, "\nAccounts")
	}
	for _, account := range checklist.Accounts {
		last := "never reconciled"
		if account.LastReconciliation != nil {
			last = fmt.Sprintf("reconciled to %s at 0.00", account.LastReconciliation.Date)
		}
		waiting := 0
		if account.Unreconciled != nil {
			waiting = account.Unreconciled.Count
		}
		fmt.Fprintf(w, "  %-7s %-30s %-5s %-11s %-34s inbox %d, not on a statement %d\n", shadowClip(account.Code, 7), shadowClip(account.Name, 30), account.Kind, account.Status, last, waiting, account.Uncleared.Count)
	}
	if len(checklist.Accounts) == 0 {
		fmt.Fprintln(w, "  none yet: reconcile an account once, or record the cutover with the accounts that have statements")
	}
	if checklist.Stripe != nil {
		fmt.Fprintf(w, "\nStripe: %s", checklist.Stripe.Status)
		if checklist.Stripe.Difference != nil {
			fmt.Fprintf(w, " (Stripe holds %s that is not imported)", shadowGrouped(*checklist.Stripe.Difference))
		}
		fmt.Fprintf(w, "; %d payouts, %d booked\n", checklist.Stripe.Payouts.Known, checklist.Stripe.Payouts.Booked)
	}
	if checklist.Inbox.Available {
		fmt.Fprintf(w, "\nInbox: %d %s dated through the period end waiting (%d in all)\n", checklist.Inbox.Waiting, shadowPlural(checklist.Inbox.Waiting, "line", "lines"), checklist.Inbox.ToReview)
	}
	if checklist.Backups.KeptByService != nil && *checklist.Backups.KeptByService {
		// A hosted workspace: the service keeps the history of the books, and there is no backup for a person to verify.
		fmt.Fprintln(w, "Backups: this service keeps the history of the books itself; there is nothing to verify")
	} else {
		backup := "none verified"
		if !checklist.Backups.Available {
			backup = "could not be read"
		} else if checklist.Backups.VerifiedAt != nil {
			backup = "newest verified " + *checklist.Backups.VerifiedAt
		}
		drill := "restore drill never run"
		if checklist.Backups.Drill != nil {
			drill = "restore drill passed " + checklist.Backups.Drill.RanAt
			if !checklist.Backups.Drill.Passed {
				drill = "restore drill FAILED " + checklist.Backups.Drill.RanAt
			}
		}
		fmt.Fprintf(w, "Backups: %s; %s\n", backup, drill)
	}
	if checklist.ShadowRun != nil {
		fmt.Fprintf(w, "Shadow run: %d of %d month ends closed and reconciled\n", checklist.ShadowRun.ProvenCount, checklist.ShadowRun.Required)
	}
	if len(checklist.OtherAccounts) > 0 {
		fmt.Fprintln(w, "\nAsset and liability accounts with a balance that nothing tracks:")
		for _, account := range checklist.OtherAccounts {
			fmt.Fprintf(w, "  %-7s %-30s %14s\n", shadowClip(account.Code, 7), shadowClip(account.Name, 30), shadowGrouped(account.Balance))
		}
	}
}

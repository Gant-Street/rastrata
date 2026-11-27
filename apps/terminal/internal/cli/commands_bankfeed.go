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

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The bankfeed lane's commands. A SimpleFIN Bridge connection fills the Inbox from the bank without a
// person downloading statements. It is a paid third-party service that reads the person's banks
// through an aggregator; statement files (rastrata import) stay the universal fallback. A sync reads
// posted transactions of the accounts the owner linked, queues them in the Inbox for review, and never
// posts anything. The Bridge expects about 24 requests a day and disables an access that goes past
// them, so Rastrata counts every request and stops at 20 in any 24 hours.
//
// The setup token is a secret that works once. It is never an argument (an argument is visible to every
// program on the computer in `ps`, and is kept in the shell's history); it comes from standard input or
// from --token-file, and is never written to the request journal or printed.
//
//	rastrata bankfeed connect [--token-file FILE]      (or the setup token on standard input)
//	rastrata bankfeed accounts
//	rastrata bankfeed link --account ID --to ACCOUNT [--from DATE]
//	rastrata bankfeed unlink --account ID
//	rastrata bankfeed sync [--once] [--budget-seconds N] [--account ID]
//	rastrata bankfeed status [--books false]
//	rastrata bankfeed settings [--daily true|false] [--at HH:MM]
//	rastrata bankfeed disconnect --yes
func init() {
	Register(Command{Name: "bankfeed connect", Summary: "Bank feed: connect the SimpleFIN Bridge. The one-time setup token is read from standard input or --token-file, never an argument, so it is not in `ps` or your shell history [--token-file FILE]", Run: runBankfeedConnect})
	Register(Command{Name: "bankfeed accounts", Summary: "Bank feed: ask the Bridge which accounts it lists (one request of its ~24 a day) and whether each is linked", Run: runBankfeedAccounts})
	Register(Command{Name: "bankfeed link", Summary: "Bank feed: link a Bridge account to a chart account, with the first day to read (default: the cutover date) --account ID --to ACCOUNT [--from DATE]", Run: runBankfeedLink})
	Register(Command{Name: "bankfeed unlink", Summary: "Bank feed: stop reading a Bridge account; its imported lines stay --account ID", Run: runBankfeedUnlink})
	Register(Command{Name: "bankfeed sync", Summary: "Bank feed: read new posted transactions of the linked accounts into the Inbox until caught up; stops when the day's request budget is spent [--once] [--budget-seconds N] [--account ID]", Run: runBankfeedSync})
	Register(Command{Name: "bankfeed status", Summary: "Bank feed: connected or not (never the access URL), accounts and links, the last syncs, what needs you, requests used against the limit, feed balances [--books false]", Run: runBankfeedStatus})
	Register(Command{Name: "bankfeed settings", Summary: "Bank feed: the optional daily sync inside the installed service (off by default) [--daily true|false] [--at HH:MM]", Run: runBankfeedSettings})
	Register(Command{Name: "bankfeed disconnect", Summary: "Bank feed: delete the access URL file (imported lines, links and cursors are kept) --yes", Run: runBankfeedDisconnect})
}

// maxBankfeedCalls bounds a catch-up so a stuck service cannot loop forever.
const maxBankfeedCalls = 200

func bankfeedUsage(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

// bankfeedFlagProblem names the first flag that is not one of allowed, or a valued flag given bare.
func bankfeedFlagProblem(o Options, allowed []string, valued []string) string {
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

func bankfeedCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) (api.Response, error) {
	definition, _ := api.FindOperation(operation)
	operationID := ""
	if definition.Writes {
		operationID = o.OperationID
		if operationID == "" {
			operationID = api.NewOperationID()
		}
		// The setup token's request is never kept, so there is nothing to resume.
		if operation != "bankfeed.connect" {
			fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
		}
	}
	return c.Call(ctx, operation, input, operationID)
}

func bankfeedBool(value string) (bool, bool) {
	switch strings.ToLower(value) {
	case "true", "yes", "1", "on":
		return true, true
	case "false", "no", "0", "off":
		return false, true
	}
	return false, false
}

// ---- connect ----------------------------------------------------------------------------------------

// setupTokenLimit is far more than a setup token needs (they are about 100 characters) and far less
// than anything that is not one.
const setupTokenLimit = 4096

// readSetupToken reads the token from the file or from standard input. It never returns the token in an
// error. A second return of 0 means success.
func readSetupToken(r Runner, o Options) (string, int) {
	path, fromFile := o.Flags["token-file"]
	var reader io.Reader = r.Input
	if fromFile {
		file, err := os.Open(path)
		if err != nil {
			return "", r.localError(o, "input_unavailable", "The token file could not be opened.", 2)
		}
		defer file.Close()
		if info, err := file.Stat(); err == nil {
			if !info.Mode().IsRegular() {
				return "", r.localError(o, "input_unavailable", "The token file is not a regular file.", 2)
			}
			if info.Mode().Perm()&0o077 != 0 {
				fmt.Fprintln(r.Diagnostics, "Warning: the token file can be read by other users. The setup token works once; delete the file when this is done.")
			}
		}
		reader = file
	} else if file, ok := r.Input.(*os.File); ok {
		if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprintln(r.Diagnostics, "Paste the SimpleFIN setup token, press Enter, then Ctrl-D. It is read from here and not from the command line, so it is not in the process list or your shell history.")
		}
	}
	if reader == nil {
		return "", r.localError(o, "usage_error", "Give the setup token on standard input (for example `pbpaste | rastrata bankfeed connect`) or with --token-file FILE.", 2)
	}
	raw, err := io.ReadAll(io.LimitReader(reader, setupTokenLimit+1))
	if err != nil || len(raw) > setupTokenLimit {
		return "", r.localError(o, "invalid_input", "The setup token is unreadable or far longer than a setup token.", 2)
	}
	token := strings.Join(strings.Fields(string(raw)), "")
	if token == "" {
		return "", r.localError(o, "usage_error", "No setup token was given. Give it on standard input (for example `pbpaste | rastrata bankfeed connect`) or with --token-file FILE.", 2)
	}
	return token, 0
}

func runBankfeedConnect(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed connect [--token-file FILE]  (the setup token on standard input otherwise)"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed connect takes no arguments", usage)
	}
	// The token as an argument is refused before anything else, and the value is never echoed: it is
	// already in the process list and the shell's history by now, so say so.
	for _, name := range []string{"token", "setup-token", "setuptoken", "access-url"} {
		if _, given := o.Flags[name]; given {
			return r.localError(o, "usage_error", "The setup token is never a command line argument: it would be visible in `ps` and kept in your shell history. Give it on standard input (`pbpaste | rastrata bankfeed connect`) or with --token-file FILE. It works once, so if that command ran, nothing was sent, but create a new token at the Bridge to be safe.", 2)
		}
	}
	if problem := bankfeedFlagProblem(o, []string{"token-file"}, []string{"token-file"}); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	token, failed := readSetupToken(r, o)
	if failed != 0 {
		return failed
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.connect", map[string]any{"setupToken": token})
	if err == nil && o.Format == "text" {
		var result api.BankfeedConnectResult
		if json.Unmarshal(response.Data, &result) == nil {
			host := ""
			if result.Host != nil {
				host = " to " + bankfeedPlain(*result.Host)
			}
			fmt.Fprintf(r.Output, "Connected%s. The access URL is kept in a private file beside the book and is never shown.\n", host)
			if result.AccountsError != nil {
				fmt.Fprintln(r.Output, "The accounts could not be listed yet: "+bankfeedPlain(*result.AccountsError))
			}
			printBankfeedAccounts(r.Output, result.Accounts)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

// ---- the rest ---------------------------------------------------------------------------------------

func runBankfeedAccounts(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed accounts"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed accounts takes no arguments", usage)
	}
	if problem := bankfeedFlagProblem(o, nil, nil); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.accounts", map[string]any{})
	if err == nil && o.Format == "text" {
		var result api.BankfeedAccountsResult
		if json.Unmarshal(response.Data, &result) == nil {
			printBankfeedAccounts(r.Output, result.Accounts)
			printBankfeedRequests(r.Output, result.Requests)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runBankfeedLink(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed link --account BRIDGE_ACCOUNT_ID --to CHART_ACCOUNT_ID [--from YYYY-MM-DD]"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed link takes no arguments", usage)
	}
	flags := []string{"account", "to", "from"}
	if problem := bankfeedFlagProblem(o, flags, flags); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	account, to := o.Flags["account"], o.Flags["to"]
	if account == "" || to == "" {
		return bankfeedUsage(r, o, "--account and --to are both needed", usage)
	}
	input := map[string]any{"accountId": account, "ledgerAccountId": to}
	if from, given := o.Flags["from"]; given {
		input["startOn"] = from
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.link", input)
	if err == nil && o.Format == "text" {
		var result api.BankfeedLinkResult
		if json.Unmarshal(response.Data, &result) == nil {
			printBankfeedAccounts(r.Output, []api.BankfeedAccount{result.Account})
			for _, note := range result.Notes {
				fmt.Fprintln(r.Output, "Note: "+bankfeedPlain(note))
			}
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runBankfeedUnlink(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed unlink --account BRIDGE_ACCOUNT_ID"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed unlink takes no arguments", usage)
	}
	if problem := bankfeedFlagProblem(o, []string{"account"}, []string{"account"}); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	account := o.Flags["account"]
	if account == "" {
		return bankfeedUsage(r, o, "--account is needed", usage)
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.unlink", map[string]any{"accountId": account})
	return r.result(o, response, err, "")
}

func runBankfeedStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed status [--books false]"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed status takes no arguments", usage)
	}
	if problem := bankfeedFlagProblem(o, []string{"books"}, nil); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if value, given := o.Flags["books"]; given {
		books, ok := bankfeedBool(value)
		if !ok {
			return bankfeedUsage(r, o, "--books is true or false", usage)
		}
		input["books"] = books
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.status", input)
	if err == nil && o.Format == "text" {
		var status api.BankfeedStatus
		if json.Unmarshal(response.Data, &status) == nil {
			printBankfeedStatus(r.Output, status)
			return 0
		}
	}
	return r.result(o, response, err, "")
}

func runBankfeedSettings(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed settings [--daily true|false] [--at HH:MM]"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed settings takes no arguments", usage)
	}
	// --daily is a switch: a bare --daily means true, and --daily false turns it off.
	if problem := bankfeedFlagProblem(o, []string{"daily", "at"}, []string{"at"}); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if value, given := o.Flags["daily"]; given {
		on, ok := bankfeedBool(value)
		if !ok {
			return bankfeedUsage(r, o, "--daily is true or false", usage)
		}
		input["dailySync"] = on
	}
	if value, given := o.Flags["at"]; given {
		input["dailyAt"] = value
	}
	if len(input) == 0 {
		// With nothing to change, show what is set.
		response, err := bankfeedCall(r, ctx, o, c, "bankfeed.status", map[string]any{"books": false})
		if err != nil {
			return r.result(o, response, err, "")
		}
		var status struct {
			Settings json.RawMessage `json:"settings"`
		}
		if json.Unmarshal(response.Data, &status) == nil && len(status.Settings) > 0 {
			response.Data = status.Settings
		}
		return r.result(o, response, nil, "")
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.settings", input)
	return r.result(o, response, err, "")
}

func runBankfeedDisconnect(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed disconnect --yes"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed disconnect takes no arguments", usage)
	}
	if problem := bankfeedFlagProblem(o, []string{"yes"}, nil); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	if yes, _ := bankfeedBool(o.Flags["yes"]); !yes {
		return bankfeedUsage(r, o, "this deletes the saved access URL (imported lines, links and cursors are kept); say --yes to do it", usage)
	}
	response, err := bankfeedCall(r, ctx, o, c, "bankfeed.disconnect", map[string]any{})
	return r.result(o, response, err, "")
}

func runBankfeedSync(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "bankfeed sync [--once] [--budget-seconds N] [--account BRIDGE_ACCOUNT_ID]"
	if len(o.Args) != 2 {
		return bankfeedUsage(r, o, "bankfeed sync takes no arguments", usage)
	}
	if problem := bankfeedFlagProblem(o, []string{"once", "budget-seconds", "account"}, []string{"budget-seconds", "account"}); problem != "" {
		return bankfeedUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if raw, given := o.Flags["budget-seconds"]; given {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 1 || seconds > 25 {
			return r.localError(o, "usage_error", "--budget-seconds must be a whole number from 1 to 25", 2)
		}
		input["budgetSeconds"] = seconds
	}
	if account, given := o.Flags["account"]; given {
		input["accountId"] = account
	}
	once := o.Flags["once"] == "true"
	if once || o.OperationID != "" {
		// One call, under the identity the caller gave: a retried call returns the first result.
		response, err := bankfeedCall(r, ctx, o, c, "bankfeed.sync", input)
		return bankfeedSyncResult(r, o, response, err)
	}
	// Catch up: each call works within its time budget and says whether more is left. Every call is a
	// new operation with its own retained identity; the service continues from its own cursors. The
	// loop stops when nothing is left, and also when the service says it is paused (the day's request
	// budget is spent, or the Bridge asked Rastrata to slow down): asking again would only spend what
	// is left of the Bridge's patience.
	var last api.Response
	for call := 1; call <= maxBankfeedCalls; call++ {
		operationID := api.NewOperationID()
		fmt.Fprintf(r.Diagnostics, "Retaining %s for bankfeed.sync; use operations requests or operations resume after interruption.\n", operationID)
		response, err := c.Call(ctx, "bankfeed.sync", input, operationID)
		if err != nil {
			return r.result(o, response, err, "")
		}
		last = response
		var outcome api.BankfeedSyncResult
		_ = json.Unmarshal(response.Data, &outcome)
		if outcome.Paused != nil || !outcome.More {
			break
		}
		fmt.Fprintf(r.Diagnostics, "Bank feed sync: %d new lines so far in call %d; continuing.\n", outcome.Run.NewLines, call)
	}
	return bankfeedSyncResult(r, o, last, nil)
}

// bankfeedSyncResult prints the last result. A pause is not a failure of the sync, but the exit says
// it did not finish (3), and a message on stderr says when it can go on, so a script or an agent
// stops instead of calling again.
func bankfeedSyncResult(r Runner, o Options, response api.Response, err error) int {
	if err != nil {
		return r.result(o, response, err, "")
	}
	var outcome api.BankfeedSyncResult
	decoded := json.Unmarshal(response.Data, &outcome) == nil
	if decoded && o.Format == "text" {
		printBankfeedSync(r.Output, outcome)
	} else if exit := r.result(o, response, nil, ""); exit != 0 {
		return exit
	}
	if decoded && outcome.Paused != nil {
		until := ""
		if outcome.Paused.Until != nil {
			until = " Do not ask again before " + bankfeedPlain(*outcome.Paused.Until) + "."
		}
		fmt.Fprintln(r.Diagnostics, bankfeedPlain(outcome.Paused.Message)+until)
		return 3
	}
	return 0
}

// ---- plain text for a person --------------------------------------------------------------------------
// Everything that came from outside the service (account and bank names, the Bridge's messages) is made
// safe to print: control characters and terminal escape sequences never reach the terminal.

func bankfeedPlain(text string) string { return shadowPlain(text) }

func bankfeedText(value *string) string {
	if value == nil {
		return "-"
	}
	return bankfeedPlain(*value)
}

func printBankfeedAccounts(w io.Writer, accounts []api.BankfeedAccount) {
	if len(accounts) == 0 {
		fmt.Fprintln(w, "The Bridge lists no accounts.")
		return
	}
	for _, account := range accounts {
		balance := "-"
		if account.Balance != nil {
			balance = shadowGrouped(*account.Balance) + " " + bankfeedPlain(account.Currency)
		}
		linked := "not linked"
		if account.Link != nil {
			linked = "linked to " + bankfeedText(account.Link.LedgerAccount)
			if account.Link.LedgerAccount == nil {
				linked = "linked to account " + bankfeedPlain(account.Link.LedgerAccountID)
			}
		}
		state := account.State
		if state == "unsupported" || state == "gone" {
			linked = state
		}
		fmt.Fprintf(w, "%s  %s (%s)  %s  %s\n", shadowClip(account.ID, 40), shadowClip(account.Name, 40), bankfeedText(account.Bank), balance, linked)
	}
}

func printBankfeedRequests(w io.Writer, requests api.BankfeedRequests) {
	fmt.Fprintf(w, "Requests to the Bridge in the last 24 hours: %d of about %d (Rastrata stops at %d).\n", requests.Used, requests.Limit, requests.Budget)
	if requests.PausedUntil != nil {
		fmt.Fprintln(w, "Paused until "+bankfeedPlain(*requests.PausedUntil)+": the Bridge asked Rastrata to slow down.")
	}
}

func printBankfeedStatus(w io.Writer, status api.BankfeedStatus) {
	if status.Connected {
		host := ""
		if status.Credential.Host != nil {
			host = " to " + bankfeedPlain(*status.Credential.Host)
		}
		fmt.Fprintf(w, "Connected%s. %d linked, %d not linked.\n", host, status.Linked, status.Unlinked)
	} else {
		fmt.Fprintln(w, "Not connected.")
		if status.Credential.Problem != nil {
			fmt.Fprintln(w, bankfeedPlain(*status.Credential.Problem))
		}
	}
	for _, item := range status.Attention {
		fmt.Fprintf(w, "[%s] %s\n", item.Severity, bankfeedPlain(item.Message))
	}
	printBankfeedAccounts(w, status.Accounts)
	for _, account := range status.Accounts {
		if account.Link == nil || account.Link.FeedBalance == nil {
			continue
		}
		balance := account.Link.FeedBalance
		difference := "-"
		if balance.Difference != nil {
			difference = shadowGrouped(*balance.Difference)
		}
		fmt.Fprintf(w, "  %s: feed balance %s as of %s; difference from the books %s (a feed balance is not a statement balance)\n", shadowClip(account.Name, 40), shadowGrouped(balance.Reported), bankfeedPlain(balance.AsOf), difference)
	}
	if status.LastSync != nil {
		fmt.Fprintf(w, "Last sync %s: %s, %d new lines.\n", bankfeedPlain(status.LastSync.StartedAt), bankfeedPlain(status.LastSync.Disposition), status.LastSync.NewLines)
	}
	printBankfeedRequests(w, status.Requests)
	if status.HeldCount > 0 {
		fmt.Fprintf(w, "%d transactions could not be read exactly and were not imported.\n", status.HeldCount)
	}
	daily := "off"
	if status.Settings.DailySync {
		daily = "on, at " + bankfeedPlain(status.Settings.DailyAt)
	}
	fmt.Fprintf(w, "Daily sync: %s.\n", daily)
}

func printBankfeedSync(w io.Writer, outcome api.BankfeedSyncResult) {
	fmt.Fprintf(w, "Sync %s: %d new lines, %d already imported, %d pending left for the bank to post, %d requests.\n", bankfeedPlain(outcome.Run.Disposition), outcome.Run.NewLines, outcome.Run.DuplicateLines, outcome.Run.PendingSkipped, outcome.Run.Requests)
	for _, account := range outcome.Accounts {
		through := "-"
		if account.Through != nil {
			through = bankfeedPlain(*account.Through)
		}
		fmt.Fprintf(w, "  %s: %s, read through %s, %d new lines\n", shadowClip(account.Name, 40), account.State, through, account.NewLines)
		if account.Message != nil {
			fmt.Fprintln(w, "    "+bankfeedPlain(*account.Message))
		}
	}
	for _, note := range outcome.Run.Notes {
		fmt.Fprintln(w, "Note: "+bankfeedPlain(note))
	}
	for _, problem := range outcome.Problems {
		fmt.Fprintln(w, "Problem: "+bankfeedPlain(problem.Message))
	}
}

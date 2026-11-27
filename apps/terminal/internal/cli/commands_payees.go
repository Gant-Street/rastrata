package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// Payees: the one list of people and businesses the book pays or is paid by, each with one name and
// the words that identify it in a bank's text, and the report "Money by payee". Words are matched whole
// and in order against what a bank wrote, never as a pattern; naming a payee changes which row of the
// report a transaction is in and posts nothing. The report adds up to the profit and loss to the cent,
// or it is not given. The commands print the application's JSON envelope; --format csv prints a file
// rendered by the service (payees.export), which neutralises text a spreadsheet could run as a formula.
//
//	rastrata payees [--text TEXT] [--include-retired] [--page N]
//	rastrata payees totals --as-of DATE [--from DATE] [--accounts "id; id"] [--direction spent|received|both] [--by-month]
//	    [--page N] [--page-size N] [--revision N] [--payees-revision N] [--format csv --file summary|transactions]
//	rastrata payees show (ID | --unnamed KEY | --ambiguous KEY | --no-payee by_hand|no_bank_text)
//	    --as-of DATE [--from DATE] [--page N]
//	rastrata payees test --words "a; b" --as-of DATE [--from DATE] [--id ID]
//	rastrata payees save [--id ID --expected-version N] [--name TEXT] [--words "a; b"]
//	    [--default-account ID|none] [--note TEXT] [--retired true|false]
func init() {
	Register(Command{
		Name:    "payees",
		Summary: "The payees: payees [--text TEXT] [--include-retired]; payees totals|show|test|save (see rastrata help payees)",
		Run:     runPayees,
	})
	Register(Command{
		Name:    "payees totals",
		Summary: "Money in and out by payee, tied to the profit and loss: payees totals --as-of DATE [--from DATE] [--direction spent|received|both] [--by-month] [--format csv --file summary|transactions]",
		Run:     runPayeesTotals,
	})
	Register(Command{
		Name:    "payees show",
		Summary: "The transactions behind a row of the report: payees show ID|--unnamed KEY|--ambiguous KEY|--no-payee by_hand|no_bank_text --as-of DATE [--from DATE]",
		Run:     runPayeesShow,
	})
	Register(Command{
		Name:    "payees test",
		Summary: "Try a payee's words before saving them: payees test --words \"a; b\" --as-of DATE [--from DATE] [--id ID]",
		Run:     runPayeesTest,
	})
	Register(Command{
		Name:    "payees save",
		Summary: "Create or change a payee: payees save [--id ID --expected-version N] [--name TEXT] [--words \"a; b\"] [--default-account ID|none] [--note TEXT] [--retired true|false]",
		Run:     runPayeesSave,
	})
}

const payeesUsage = "payees [--text TEXT] [--include-retired] [--page N] [--page-size N] [--payees-revision N]"
const payeesTotalsUsage = "payees totals --as-of YYYY-MM-DD [--from YYYY-MM-DD] [--accounts \"6140; 6170\"] [--direction spent|received|both] [--by-month] " +
	"[--page N] [--page-size N] [--revision N] [--payees-revision N] [--format json|csv] [--file summary|transactions] [--id PAYEE_ID]"
const payeesShowUsage = "payees show PAYEE_ID --as-of YYYY-MM-DD [--from YYYY-MM-DD] [--accounts \"6140; 6170\"] [--page N] [--page-size N] [--revision N] [--payees-revision N] " +
	"| payees show --unnamed KEY | --ambiguous KEY | --no-payee by_hand|no_bank_text --as-of YYYY-MM-DD"
const payeesTestUsage = "payees test --words \"jane doe; jane d\" --as-of YYYY-MM-DD [--from YYYY-MM-DD] [--accounts \"6140; 6170\"] [--id PAYEE_ID] [--revision N] [--payees-revision N]"
const payeesSaveUsage = "payees save [--id PAYEE_ID --expected-version N] [--name TEXT] [--words \"jane doe; jane d\"] " +
	"[--default-account ACCOUNT_ID|none] [--note TEXT] [--retired true|false] [--operation-id UUID]"

// payeeWordsFlag reads a list of words written as "a; b": each part is one set of words. The word
// "none" is an empty list.
func payeeWordsFlag(value string) []string {
	words := []string{}
	if value == "none" {
		return words
	}
	for _, part := range strings.Split(value, ";") {
		if text := strings.TrimSpace(part); text != "" {
			words = append(words, text)
		}
	}
	return words
}

// payeesDates puts the range, the pins and the page of a read into its input.
func payeesDates(o Options, input map[string]any) {
	input["asOf"] = o.AsOf
	if o.Revision != "" {
		input["revision"] = o.Revision
	}
	for flag, field := range map[string]string{"from": "from", "payees-revision": "payeesRevision"} {
		if value, given := o.Flags[flag]; given {
			input[field] = value
		}
	}
	// --accounts "6140; 6170" limits the read to those income and expense accounts.
	if value, given := o.Flags["accounts"]; given {
		if ids := payeeWordsFlag(value); len(ids) > 0 {
			input["accountIds"] = ids
		}
	}
}

// payeesNumber reads a whole number flag from 1 up.
func payeesNumber(r Runner, o Options, flag, usage string) (int, bool, bool) {
	value, given := o.Flags[flag]
	if !given {
		return 0, false, true
	}
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		r.localError(o, "usage_error", "--"+flag+" must be a whole number from 1. Use "+usage, 2)
		return 0, true, false
	}
	return number, true, true
}

func runPayees(r Runner, ctx context.Context, o Options, c *api.Client) int {
	// "payees" and "payees list" are the same.
	if len(o.Args) > 2 || (len(o.Args) == 2 && o.Args[1] != "list") {
		return r.localError(o, "usage_error", "Unknown payees command "+strings.Join(o.Args[1:], " ")+". Use "+payeesUsage+
			" | "+payeesTotalsUsage+" | "+payeesShowUsage+" | "+payeesTestUsage+" | "+payeesSaveUsage, 2)
	}
	if name, bad := flagsOutside(o, "text", "include-retired", "page", "page-size", "payees-revision"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+payeesUsage, 2)
	}
	if !rejectBareFlags(r, o, payeesUsage, "text", "page", "page-size", "payees-revision") {
		return 2
	}
	input := map[string]any{}
	if text, given := o.Flags["text"]; given {
		input["text"] = text
	}
	if value, given := o.Flags["include-retired"]; given {
		if value != "true" && value != "false" {
			return r.localError(o, "usage_error", "--include-retired takes no value, or true or false. Use "+payeesUsage, 2)
		}
		input["includeRetired"] = value == "true"
	}
	if value, given := o.Flags["payees-revision"]; given {
		input["payeesRevision"] = value
	}
	for _, flag := range []string{"page", "page-size"} {
		number, given, ok := payeesNumber(r, o, flag, payeesUsage)
		if !ok {
			return 2
		}
		if given {
			input[map[string]string{"page": "page", "page-size": "pageSize"}[flag]] = number
		}
	}
	response, err := c.Call(ctx, "payees.list", input, "")
	return r.result(o, response, err, "")
}

func runPayeesTotals(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "payees totals takes only options. Use "+payeesTotalsUsage, 2)
	}
	if name, bad := flagsOutside(o, "from", "direction", "by-month", "page", "page-size", "payees-revision", "file", "id", "accounts"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+payeesTotalsUsage, 2)
	}
	if !rejectBareFlags(r, o, payeesTotalsUsage, "from", "direction", "page", "page-size", "payees-revision", "file", "id", "accounts") {
		return 2
	}
	if o.AsOf == "" {
		return r.localError(o, "usage_error", "--as-of YYYY-MM-DD is required. Use "+payeesTotalsUsage, 2)
	}
	input := map[string]any{}
	payeesDates(o, input)
	if o.Format == "csv" {
		if value, given := o.Flags["file"]; given {
			if value != "summary" && value != "transactions" {
				return r.localError(o, "usage_error", "--file must be summary or transactions. Use "+payeesTotalsUsage, 2)
			}
			input["file"] = value
		}
		if value, given := o.Flags["id"]; given {
			if o.Flags["file"] != "transactions" {
				return r.localError(o, "usage_error", "--id applies to --file transactions. Use "+payeesTotalsUsage, 2)
			}
			input["payeeId"] = value
		}
		for _, flag := range []string{"direction", "by-month", "page", "page-size"} {
			if _, given := o.Flags[flag]; given {
				return r.localError(o, "usage_error", "--"+flag+" does not apply to a file. Use "+payeesTotalsUsage, 2)
			}
		}
		response, err := c.Call(ctx, "payees.export", input, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		return r.writeContent(o, response.Data)
	}
	for _, flag := range []string{"file", "id"} {
		if _, given := o.Flags[flag]; given {
			return r.localError(o, "usage_error", "--"+flag+" applies to --format csv. Use "+payeesTotalsUsage, 2)
		}
	}
	if value, given := o.Flags["direction"]; given {
		if value != "spent" && value != "received" && value != "both" {
			return r.localError(o, "usage_error", "--direction must be spent, received or both. Use "+payeesTotalsUsage, 2)
		}
		input["direction"] = value
	}
	if value, given := o.Flags["by-month"]; given {
		if value != "true" && value != "false" {
			return r.localError(o, "usage_error", "--by-month takes no value, or true or false. Use "+payeesTotalsUsage, 2)
		}
		input["byMonth"] = value == "true"
	}
	for flag, field := range map[string]string{"page": "page", "page-size": "pageSize"} {
		number, given, ok := payeesNumber(r, o, flag, payeesTotalsUsage)
		if !ok {
			return 2
		}
		if given {
			input[field] = number
		}
	}
	response, err := c.Call(ctx, "payees.totals", input, "")
	return r.result(o, response, err, "")
}

func runPayeesShow(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) > 3 {
		return r.localError(o, "usage_error", "payees show takes one payee id. Use "+payeesShowUsage, 2)
	}
	if name, bad := flagsOutside(o, "from", "page", "page-size", "payees-revision", "unnamed", "ambiguous", "no-payee", "accounts"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+payeesShowUsage, 2)
	}
	if !rejectBareFlags(r, o, payeesShowUsage, "from", "page", "page-size", "payees-revision", "unnamed", "ambiguous", "no-payee", "accounts") {
		return 2
	}
	if o.AsOf == "" {
		return r.localError(o, "usage_error", "--as-of YYYY-MM-DD is required. Use "+payeesShowUsage, 2)
	}
	input := map[string]any{}
	payeesDates(o, input)
	chosen := 0
	if len(o.Args) == 3 {
		input["payeeId"] = o.Args[2]
		chosen++
	}
	if value, given := o.Flags["unnamed"]; given {
		input["unnamed"] = value
		chosen++
	}
	if value, given := o.Flags["ambiguous"]; given {
		input["ambiguous"] = value
		chosen++
	}
	if value, given := o.Flags["no-payee"]; given {
		if value != "by_hand" && value != "no_bank_text" {
			return r.localError(o, "usage_error", "--no-payee must be by_hand or no_bank_text. Use "+payeesShowUsage, 2)
		}
		input["noPayee"] = value
		chosen++
	}
	if chosen != 1 {
		return r.localError(o, "usage_error", "Name exactly one thing to show: a payee id, --unnamed, --ambiguous or --no-payee. Use "+payeesShowUsage, 2)
	}
	for flag, field := range map[string]string{"page": "page", "page-size": "pageSize"} {
		number, given, ok := payeesNumber(r, o, flag, payeesShowUsage)
		if !ok {
			return 2
		}
		if given {
			input[field] = number
		}
	}
	response, err := c.Call(ctx, "payees.get", input, "")
	return r.result(o, response, err, "")
}

func runPayeesTest(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "payees test takes only options. Use "+payeesTestUsage, 2)
	}
	if name, bad := flagsOutside(o, "words", "from", "id", "payees-revision", "accounts"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+payeesTestUsage, 2)
	}
	if !rejectBareFlags(r, o, payeesTestUsage, "words", "from", "id", "payees-revision", "accounts") {
		return 2
	}
	words, given := o.Flags["words"]
	if !given {
		return r.localError(o, "usage_error", "--words is required. Use "+payeesTestUsage, 2)
	}
	if o.AsOf == "" {
		return r.localError(o, "usage_error", "--as-of YYYY-MM-DD is required. Use "+payeesTestUsage, 2)
	}
	list := payeeWordsFlag(words)
	if len(list) == 0 {
		return r.localError(o, "usage_error", "--words needs at least one set of words. Use "+payeesTestUsage, 2)
	}
	input := map[string]any{"words": list}
	payeesDates(o, input)
	if id, given := o.Flags["id"]; given {
		input["payeeId"] = id
	}
	response, err := c.Call(ctx, "payees.test", input, "")
	return r.result(o, response, err, "")
}

func runPayeesSave(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "payees save takes only options. Use "+payeesSaveUsage, 2)
	}
	if name, bad := flagsOutside(o, "id", "expected-version", "name", "words", "default-account", "note", "retired"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+payeesSaveUsage, 2)
	}
	if !rejectBareFlags(r, o, payeesSaveUsage, "id", "expected-version", "words", "default-account") {
		return 2
	}
	input := map[string]any{}
	id, hasID := o.Flags["id"]
	version, hasVersion := o.Flags["expected-version"]
	if hasID != hasVersion {
		return r.localError(o, "usage_error", "Changing a payee needs both --id and --expected-version (the version you read). Use "+payeesSaveUsage, 2)
	}
	if hasID {
		number, err := strconv.Atoi(version)
		if err != nil || number < 1 {
			return r.localError(o, "usage_error", "--expected-version must be a whole number from 1. Use "+payeesSaveUsage, 2)
		}
		input["payeeId"] = id
		input["expectedVersion"] = number
	}
	if name, given := o.Flags["name"]; given {
		input["name"] = name
	}
	if words, given := o.Flags["words"]; given {
		input["words"] = payeeWordsFlag(words)
	}
	if account, given := o.Flags["default-account"]; given {
		if account == "none" {
			input["defaultAccountId"] = nil
		} else {
			input["defaultAccountId"] = account
		}
	}
	if note, given := o.Flags["note"]; given {
		input["note"] = note
	}
	if retired, given := o.Flags["retired"]; given {
		if retired != "true" && retired != "false" {
			return r.localError(o, "usage_error", "--retired must be true or false. Use "+payeesSaveUsage, 2)
		}
		input["retired"] = retired == "true"
	}
	if !hasID && input["name"] == nil {
		return r.localError(o, "usage_error", "A new payee needs --name. Use "+payeesSaveUsage, 2)
	}
	if len(input) == 0 || (hasID && len(input) == 2) {
		return r.localError(o, "usage_error", "Nothing to record: give at least one field to set. Use "+payeesSaveUsage, 2)
	}
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for payees.save; use operations requests or operations resume after interruption.\n", operationID)
	response, err := c.Call(ctx, "payees.save", input, operationID)
	return r.result(o, response, err, "")
}

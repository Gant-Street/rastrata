package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The entries lane's commands: taking posted Inbox lines back, changing the account of posted
// transactions, and the business name and display settings. Every command prints the application's JSON
// envelope.
//
//	rastrata inbox undo IT_ID... [--reason=TEXT]
//	rastrata inbox recategorize (IT_ID... | --journal=ID,ID | filter options | --all) --account=ID
//	                            [--from-account=ID] [--reason=TEXT] [--dry-run] [--expect=N] [--limit=N] [--after=ID]
//	rastrata book update [--name=TEXT] [--date-format=medium|numeric|iso]
//	                     [--show-account-numbers=true|false] [--accept=post|draft]
//
// Write flags as --name=value: a flag followed by a bare word would take the word as its value.
func init() {
	Register(Command{
		Name:    "inbox undo",
		Summary: "Take posted lines back (reverse each entry with a linked reversal, return the line to review): inbox undo ITEM_ID... [--reason=TEXT]",
		Run:     runInboxUndo,
	})
	Register(Command{
		Name:    "inbox recategorize",
		Summary: "Move posted transactions to another account (reverse, categorize, post): inbox recategorize (ITEM_ID... | --journal=ID,ID | filter) --account=ID [--from-account=ID] [--reason=TEXT] [--dry-run]",
		Run:     runInboxRecategorize,
	})
	Register(Command{
		Name:    "book update",
		Summary: "Rename the business or change display settings: book update [--name=TEXT] [--date-format=medium|numeric|iso] [--show-account-numbers=true|false] [--accept=post|draft]",
		Run:     runBookUpdate,
	})
}

func runInboxUndo(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "inbox undo ITEM_ID... [--reason=TEXT]; each call takes back a bounded number of lines and reports how many remain: call it again with the same ids until remaining is 0. The entry of each posted line is reversed (the original stays in the books) and the line returns to review. An entry in a closed month is refused with the ledger's code fiscal_period_admission"
	allowed := []string{"reason"}
	if problem := inboxFlagProblem(o, allowed, inboxValued(allowed)); problem != "" {
		return inboxUsage(r, o, problem, usage)
	}
	ids := o.Args[2:]
	if len(ids) == 0 {
		return inboxUsage(r, o, "name the lines to undo: one or more item ids", usage)
	}
	if len(ids) > 100 {
		return inboxUsage(r, o, "undo takes at most 100 lines in one call", usage)
	}
	input := map[string]any{"itemIds": ids}
	if reason, given := o.Flags["reason"]; given {
		input["reason"] = strings.TrimSpace(reason)
	}
	return inboxCall(r, ctx, o, c, "inbox.undo", input)
}

// inboxBare reads a flag that takes no value: --dry-run alone, or --dry-run=true.
func inboxBare(o Options, name string) (bool, error) {
	value, given := o.Flags[name]
	if !given {
		return false, nil
	}
	if value != "true" && value != "" {
		return false, fmt.Errorf("--%s takes no value", name)
	}
	return true, nil
}

func runInboxRecategorize(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "inbox recategorize (ITEM_ID... | --journal=ID,ID | filter options | --all) --account=ID [--from-account=ID] [--reason=TEXT] [--dry-run] [--expect=N] [--limit=N] [--after=ID]; start with --dry-run, which changes nothing and lists every transaction with the account it is on and the account it would go to, and why any cannot move. Name transactions by their item ids, by the entries they made (--journal, as journal list and payees get give them) or by a filter with the count you saw (--expect). A call moves a bounded number and reports how many remain (and --after for a filter): call again. Send the same --operation-id again to carry on a call that was cut short. Only a transaction booked to one account from a bank line is moved; a split, a transfer, a payout, an entry made by hand and anything in a closed month are skipped with the reason"
	allowed := inboxActionFlags("journal", "account", "from-account", "reason", "dry-run", "after")
	if problem := inboxFlagProblem(o, allowed, inboxValued(allowed)); problem != "" {
		return inboxUsage(r, o, problem, usage)
	}
	account := strings.TrimSpace(o.Flags["account"])
	if account == "" {
		return inboxUsage(r, o, "say which account to move them to with --account=ID", usage)
	}
	var input map[string]any
	if journals, given := o.Flags["journal"]; given {
		ids := inboxList(journals)
		if len(ids) == 0 {
			return inboxUsage(r, o, "--journal needs the ids of the entries", usage)
		}
		if len(ids) > 500 {
			return inboxUsage(r, o, "a call takes at most 500 entries", usage)
		}
		if len(o.Args) > 2 {
			return inboxUsage(r, o, "give item ids or --journal, not both", usage)
		}
		filter, err := inboxFilter(o)
		if err != nil {
			return inboxUsage(r, o, err.Error(), usage)
		}
		if filter != nil || o.Flags["all"] == "true" {
			return inboxUsage(r, o, "--journal names the transactions: leave the filter options out", usage)
		}
		if _, expects := o.Flags["expect"]; expects {
			return inboxUsage(r, o, "--expect goes with a filter, not with named entries", usage)
		}
		input = map[string]any{"journalIds": ids}
		if limit, given, err := inboxWholeNumber(o, "limit"); err != nil {
			return inboxUsage(r, o, err.Error(), usage)
		} else if given {
			input["limit"] = limit
		}
	} else {
		var err error
		if input, err = inboxSelection(o, usage); err != nil {
			return inboxUsage(r, o, err.Error(), usage)
		}
		if ids, named := input["itemIds"].([]string); named && len(ids) > 500 {
			return inboxUsage(r, o, "a call takes at most 500 transactions", usage)
		}
	}
	input["accountId"] = account
	if from, given := o.Flags["from-account"]; given {
		input["fromAccountId"] = from
	}
	if reason, given := o.Flags["reason"]; given {
		input["reason"] = strings.TrimSpace(reason)
	}
	if after, given := o.Flags["after"]; given {
		input["after"] = after
	}
	dry, err := inboxBare(o, "dry-run")
	if err != nil {
		return inboxUsage(r, o, err.Error(), usage)
	}
	if dry {
		input["dryRun"] = true
	}
	return inboxCall(r, ctx, o, c, "inbox.recategorize", input)
}

// bookBool reads a flag that must be the word true or false.
func bookBool(o Options, name string) (value, given bool, err error) {
	text, given := o.Flags[name]
	if !given {
		return false, false, nil
	}
	switch text {
	case "true":
		return true, true, nil
	case "false":
		return false, true, nil
	}
	return false, true, fmt.Errorf("--%s must be true or false", name)
}

func runBookUpdate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "book update [--name=TEXT] [--date-format=medium|numeric|iso] [--show-account-numbers=true|false] [--accept=post|draft]; give only what changes"
	if len(o.Args) != 2 {
		return inboxUsage(r, o, "book update takes options only", usage)
	}
	allowed := []string{"name", "date-format", "show-account-numbers", "accept"}
	valued := []string{"name", "date-format", "accept"}
	if problem := inboxFlagProblem(o, allowed, valued); problem != "" {
		return inboxUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if name, given := o.Flags["name"]; given {
		input["name"] = strings.TrimSpace(name)
	}
	if format, given := o.Flags["date-format"]; given {
		if format != "medium" && format != "numeric" && format != "iso" {
			return inboxUsage(r, o, "--date-format must be medium, numeric or iso", usage)
		}
		input["dateFormat"] = format
	}
	if accept, given := o.Flags["accept"]; given {
		if accept != "post" && accept != "draft" {
			return inboxUsage(r, o, "--accept must be post or draft", usage)
		}
		input["acceptMode"] = accept
	}
	if show, given, err := bookBool(o, "show-account-numbers"); err != nil {
		return inboxUsage(r, o, err.Error(), usage)
	} else if given {
		input["showAccountNumbers"] = show
	}
	if len(input) == 0 {
		return inboxUsage(r, o, "give something to change", usage)
	}
	return inboxCall(r, ctx, o, c, "book.update", input)
}

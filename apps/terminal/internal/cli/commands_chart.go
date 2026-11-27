package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The chart lane's commands: tagging accounts and, from templates, starting a book.
func init() {
	Register(Command{
		Name:    "accounts tag",
		Summary: "Set or clear an account's cash-flow class, tax line or role key from a date",
		Run:     runAccountsTag,
	})
	Register(Command{
		Name:    "templates show",
		Summary: "Show a chart template for a basis and tax year; --setup prints a book.setup input",
		Run:     runTemplatesShow,
	})
	RegisterAlias("templates list", "templates.list")
	RegisterAlias("tax-lines list", "taxLines.list")
}

// flagsOutside returns the first flag that is not in allowed, so a typo is an error and not a
// silently ignored option.
func flagsOutside(o Options, allowed ...string) (string, bool) {
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
			return name, true
		}
	}
	return "", false
}

// accounts tag ACCOUNT_ID [--cash-flow-class CLASS] [--tax-line LINE] [--role-key KEY] [--kind bank|card]
// [--effective-on DATE]. A value of "none" clears that tag. Without --effective-on the tag starts
// on the date the account opened, so it covers the account's whole history; give a date to change
// a tag from then on and keep the earlier one before it.
func runAccountsTag(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "Use accounts tag ACCOUNT_ID [--cash-flow-class CLASS] [--tax-line LINE] [--role-key KEY] [--kind bank|card] [--effective-on DATE]; none clears a tag"
	if len(o.Args) != 3 {
		return r.localError(o, "usage_error", usage, 2)
	}
	if name, bad := flagsOutside(o, "cash-flow-class", "tax-line", "role-key", "kind", "effective-on"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". "+usage, 2)
	}
	tags := map[string]any{}
	for flag, tag := range map[string]string{"cash-flow-class": "cashFlowClass", "tax-line": "taxLine", "role-key": "roleKey", "kind": "kind"} {
		value, given := o.Flags[flag]
		if !given {
			continue
		}
		if value == "true" || value == "" {
			return r.localError(o, "usage_error", "--"+flag+" needs a value (none clears it). "+usage, 2)
		}
		if value == "none" {
			tags[tag] = nil
		} else {
			tags[tag] = value
		}
	}
	if len(tags) == 0 {
		return r.localError(o, "usage_error", "Give at least one of --cash-flow-class, --tax-line or --role-key. "+usage, 2)
	}
	accountID := o.Args[2]
	effectiveOn := o.Flags["effective-on"]
	if effectiveOn == "" {
		list, err := c.AccountsList(ctx, api.Empty{}, "")
		if err != nil {
			return r.result(o, api.Response{}, err, "")
		}
		for _, account := range list.Accounts {
			if account.ID == accountID {
				effectiveOn = account.OpenedOn
			}
		}
		if effectiveOn == "" {
			return r.localError(o, "account_not_found", "No account has the id "+accountID+"; run accounts list to find it", 3)
		}
	}
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for accounts.setTags; use operations requests or operations resume after interruption.\n", operationID)
	input := map[string]any{"accountId": accountID, "effectiveOn": effectiveOn, "tags": tags}
	response, err := c.Call(ctx, "accounts.setTags", input, operationID)
	if err == nil {
		var result api.AccountSetTagsResult
		if json.Unmarshal(response.Data, &result) == nil {
			for _, warning := range result.Warnings {
				fmt.Fprintln(r.Diagnostics, "Warning: "+warning)
			}
		}
	}
	return r.result(o, response, err, "")
}

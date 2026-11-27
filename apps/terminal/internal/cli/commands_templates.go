package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// templates show TEMPLATE_ID [--basis cash|accrual] [--tax-year YEAR] [--add-on NAME[,NAME]]
// [--setup --name NAME --year YEAR [--start-month 1-12] [--periods monthly|quarterly] [--currency USD]]
//
// Without --setup it prints the usual response envelope. With --setup it prints one book.setup
// input document (not an envelope), so it can be reviewed and piped to
// `rastrata call book.setup --input -`. Bank and card accounts in a template are placeholders:
// edit their names in the printed document before setting up.
func runTemplatesShow(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "Use templates show TEMPLATE_ID [--basis cash|accrual] [--tax-year YEAR] [--add-on online-business] [--setup --name NAME --year YEAR [--start-month 1-12] [--periods monthly|quarterly] [--currency USD]]"
	if len(o.Args) != 3 {
		return r.localError(o, "usage_error", usage, 2)
	}
	if name, bad := flagsOutside(o, "basis", "tax-year", "add-on", "setup", "name", "year", "start-month", "periods", "currency"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". "+usage, 2)
	}
	input := map[string]any{"templateId": o.Args[2]}
	if basis := o.Flags["basis"]; basis != "" {
		input["basis"] = basis
	}
	if year := o.Flags["tax-year"]; year != "" {
		n, err := strconv.Atoi(year)
		if err != nil {
			return r.localError(o, "usage_error", "--tax-year must be a year such as 2026. "+usage, 2)
		}
		input["taxYear"] = n
	}
	if addOns := o.Flags["add-on"]; addOns != "" {
		input["addOns"] = strings.Split(addOns, ",")
	}
	if o.Flags["setup"] != "true" {
		for _, flag := range []string{"name", "year", "start-month", "periods", "currency"} {
			if _, given := o.Flags[flag]; given {
				return r.localError(o, "usage_error", "--"+flag+" belongs with --setup. "+usage, 2)
			}
		}
		response, err := c.Call(ctx, "templates.get", input, "")
		return r.result(o, response, err, "")
	}
	name, year := o.Flags["name"], o.Flags["year"]
	if name == "" || name == "true" || year == "" || year == "true" {
		return r.localError(o, "usage_error", "--setup needs --name and --year. "+usage, 2)
	}
	fiscalYear, err := strconv.Atoi(year)
	if err != nil {
		return r.localError(o, "usage_error", "--year must be a year such as 2026. "+usage, 2)
	}
	if _, given := input["taxYear"]; !given {
		input["taxYear"] = fiscalYear
	}
	response, err := c.Call(ctx, "templates.get", input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	var detail api.TemplateDetail
	if err := json.Unmarshal(response.Data, &detail); err != nil {
		return r.localError(o, "client_error", err.Error(), 4)
	}
	currency := o.Flags["currency"]
	if currency == "" {
		currency = "USD"
	}
	periods := o.Flags["periods"]
	if periods == "" {
		periods = "monthly"
	}
	document := map[string]any{
		"name":        name,
		"currency":    currency,
		"fiscalYear":  fiscalYear,
		"periodModel": periods,
		"basis":       detail.Basis,
		"accounts":    setupAccounts(detail.Accounts),
	}
	if month := o.Flags["start-month"]; month != "" {
		n, err := strconv.Atoi(month)
		if err != nil {
			return r.localError(o, "usage_error", "--start-month must be 1 to 12. "+usage, 2)
		}
		document["fiscalYearStartMonth"] = n
	}
	if detail.Disclaimer != "" {
		fmt.Fprintln(r.Diagnostics, detail.Disclaimer)
	}
	if err := json.NewEncoder(r.Output).Encode(document); err != nil {
		return r.localError(o, "client_error", err.Error(), 4)
	}
	return 0
}

// setupAccounts keeps what book.setup accepts: it drops the notes that are only for people reading the
// template. A template carries no bank or card account; add the person's own after setup.
func setupAccounts(accounts []api.TemplateAccount) []map[string]any {
	out := make([]map[string]any, 0, len(accounts))
	for _, account := range accounts {
		item := map[string]any{"code": account.Code, "name": account.Name, "role": account.Role}
		if account.ParentCode != nil {
			item["parentCode"] = *account.ParentCode
		}
		tags := map[string]any{}
		if account.Tags.CashFlowClass != nil {
			tags["cashFlowClass"] = *account.Tags.CashFlowClass
		}
		if account.Tags.TaxLine != nil {
			tags["taxLine"] = *account.Tags.TaxLine
		}
		if account.Tags.RoleKey != nil {
			tags["roleKey"] = *account.Tags.RoleKey
		}
		if account.Tags.Kind != nil {
			tags["kind"] = *account.Tags.Kind
		}
		if len(tags) > 0 {
			item["tags"] = tags
		}
		out = append(out, item)
	}
	return out
}

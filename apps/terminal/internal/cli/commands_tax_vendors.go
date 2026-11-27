package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The 1099 vendor list. A vendor records who a payment went to, whether they need a 1099 and whether a
// W-9 is on file; accounts marked 1099-reportable say which payments are counted. Rastrata files no
// form, gives no tax advice and never stores a taxpayer identification number: there is no option to
// give it one. Writes carry an operation identity like every other write.
//
//	rastrata tax vendors --year YYYY [--format csv --file vendors|payments]
//	rastrata tax vendor show VENDOR_ID --year YYYY
//	rastrata tax vendor save [--id ID --expected-version N] [--name TEXT] [--payees "a; b"]
//	    [--reporting yes|no|undecided] [--reason R] [--w9 not_requested|requested|received] [--w9-on DATE]
//	    [--classification C] [--paid-by unknown|bank|card_or_network] [--notes TEXT]
//	rastrata tax accounts mark ACCOUNT_ID... | unmark ACCOUNT_ID...
func init() {
	Register(Command{
		Name:    "tax vendors",
		Summary: "The 1099 vendor list and what each was paid: tax vendors --year YYYY [--format csv --file vendors|payments]",
		Run:     runTaxVendors,
	})
	Register(Command{
		Name:    "tax vendor",
		Summary: "One 1099 vendor, or record one: tax vendor show ID --year YYYY | tax vendor save --name TEXT [--payees \"a; b\"] [--reporting ...]",
		Run:     runTaxVendor,
	})
	Register(Command{
		Name:    "tax accounts",
		Summary: "Mark the expense accounts that hold payments that may need a 1099: tax accounts mark|unmark ACCOUNT_ID...",
		Run:     runTaxAccounts,
	})
}

const taxVendorsUsage = "tax vendors --year YYYY [--revision N] [--tags-revision N] [--vendors-revision N] [--format json|csv] [--file vendors|payments]"
const taxVendorShowUsage = "tax vendor show VENDOR_ID --year YYYY [--revision N] [--tags-revision N] [--vendors-revision N]"
const taxVendorSaveUsage = "tax vendor save [--id VENDOR_ID --expected-version N] [--name TEXT] [--payees \"jane doe; jane d\"] " +
	"[--reporting yes|no|undecided] [--reason corporation|employee|personal|merchandise|exempt_organization|card_or_network|other|none] " +
	"[--w9 not_requested|requested|received] [--w9-on YYYY-MM-DD|none] " +
	"[--classification individual|c_corporation|s_corporation|partnership|trust_estate|llc_c|llc_s|llc_p|other|none] " +
	"[--paid-by unknown|bank|card_or_network] [--notes TEXT] [--operation-id UUID]"
const taxAccountsUsage = "tax accounts mark|unmark ACCOUNT_ID... [--operation-id UUID]"

func vendorsInput(o Options, year int) map[string]any {
	input := taxInput(o, year)
	delete(input, "form")
	delete(input, "from")
	delete(input, "to")
	if value, given := o.Flags["vendors-revision"]; given {
		input["vendorsRevision"] = value
	}
	return input
}

func runTaxVendors(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax vendors takes only options. Use "+taxVendorsUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "tags-revision", "vendors-revision", "file"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxVendorsUsage, 2)
	}
	if !rejectBareFlags(r, o, taxVendorsUsage, "tags-revision", "vendors-revision", "file") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxVendorsUsage)
	if !ok {
		return 2
	}
	input := vendorsInput(o, year)
	if o.Format == "csv" {
		if file, given := o.Flags["file"]; given {
			input["file"] = file
		}
		response, err := c.Call(ctx, "taxVendors.export", input, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		return r.writeContent(o, response.Data)
	}
	if _, given := o.Flags["file"]; given {
		return r.localError(o, "usage_error", "--file applies to --format csv. Use "+taxVendorsUsage, 2)
	}
	response, err := c.Call(ctx, "taxVendors.list", input, "")
	return r.result(o, response, err, "")
}

// vendorField reads an optional text flag; the word "none" clears a field that can be cleared.
func vendorField(o Options, flag string) (value any, given bool) {
	text, present := o.Flags[flag]
	if !present {
		return nil, false
	}
	if text == "none" {
		return nil, true
	}
	return text, true
}

func runTaxVendor(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := taxVendorShowUsage + " | " + taxVendorSaveUsage
	if len(o.Args) < 3 {
		return r.localError(o, "usage_error", "Use "+usage, 2)
	}
	switch o.Args[2] {
	case "show":
		if len(o.Args) != 4 {
			return r.localError(o, "usage_error", "Use "+taxVendorShowUsage, 2)
		}
		if name, bad := flagsOutside(o, "year", "tags-revision", "vendors-revision"); bad {
			return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxVendorShowUsage, 2)
		}
		if !rejectBareFlags(r, o, taxVendorShowUsage, "tags-revision", "vendors-revision") {
			return 2
		}
		year, ok := taxYearFlag(r, o, taxVendorShowUsage)
		if !ok {
			return 2
		}
		input := vendorsInput(o, year)
		input["vendorId"] = o.Args[3]
		response, err := c.Call(ctx, "taxVendors.get", input, "")
		return r.result(o, response, err, "")
	case "save":
		return runTaxVendorSave(r, ctx, o, c)
	}
	return r.localError(o, "usage_error", "Use "+usage, 2)
}

func runTaxVendorSave(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 3 {
		return r.localError(o, "usage_error", "tax vendor save takes only options. Use "+taxVendorSaveUsage, 2)
	}
	if name, bad := flagsOutside(o, "id", "expected-version", "name", "payees", "reporting", "reason", "w9", "w9-on", "classification", "paid-by", "notes"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxVendorSaveUsage, 2)
	}
	if !rejectBareFlags(r, o, taxVendorSaveUsage, "id", "expected-version", "payees", "reporting", "reason", "w9", "w9-on", "classification", "paid-by") {
		return 2
	}
	input := map[string]any{}
	id, hasID := o.Flags["id"]
	version, hasVersion := o.Flags["expected-version"]
	if hasID != hasVersion {
		return r.localError(o, "usage_error", "Changing a vendor needs both --id and --expected-version (the version you read). Use "+taxVendorSaveUsage, 2)
	}
	if hasID {
		number, err := strconv.Atoi(version)
		if err != nil || number < 1 {
			return r.localError(o, "usage_error", "--expected-version must be a whole number from 1. Use "+taxVendorSaveUsage, 2)
		}
		input["vendorId"] = id
		input["expectedVersion"] = number
	}
	if name, given := o.Flags["name"]; given {
		input["name"] = name
	}
	if payees, given := o.Flags["payees"]; given {
		keys := []string{}
		if payees != "none" {
			for _, part := range strings.Split(payees, ";") {
				if text := strings.TrimSpace(part); text != "" {
					keys = append(keys, text)
				}
			}
		}
		input["payeeKeys"] = keys
	}
	for flag, field := range map[string]string{"reporting": "reporting", "w9": "w9", "paid-by": "paidBy"} {
		if value, given := o.Flags[flag]; given {
			input[field] = value
		}
	}
	for flag, field := range map[string]string{"reason": "reason", "w9-on": "w9On", "classification": "classification"} {
		if value, given := vendorField(o, flag); given {
			input[field] = value
		}
	}
	if notes, given := o.Flags["notes"]; given {
		input["notes"] = notes
	}
	if !hasID && input["name"] == nil {
		return r.localError(o, "usage_error", "A new vendor needs --name. Use "+taxVendorSaveUsage, 2)
	}
	if len(input) == 0 || (hasID && len(input) == 2) {
		return r.localError(o, "usage_error", "Nothing to record: give at least one field to set. Use "+taxVendorSaveUsage, 2)
	}
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for taxVendors.save; use operations requests or operations resume after interruption.\n", operationID)
	response, err := c.Call(ctx, "taxVendors.save", input, operationID)
	return r.result(o, response, err, "")
}

func runTaxAccounts(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) < 4 || (o.Args[2] != "mark" && o.Args[2] != "unmark") {
		return r.localError(o, "usage_error", "Use "+taxAccountsUsage, 2)
	}
	if name, bad := flagsOutside(o); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxAccountsUsage, 2)
	}
	field := "add"
	if o.Args[2] == "unmark" {
		field = "remove"
	}
	ids := append([]string{}, o.Args[3:]...)
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for taxVendors.setAccounts; use operations requests or operations resume after interruption.\n", operationID)
	response, err := c.Call(ctx, "taxVendors.setAccounts", map[string]any{field: ids}, operationID)
	return r.result(o, response, err, "")
}

package cli

import (
	"context"
	"encoding/json"
	"io"
	"strconv"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The tax lane's commands. Rastrata books and reports: nothing here gives tax advice, files a return
// or predicts what anyone owes, and every result says so. The figures are totals of the book's own
// postings by the tax line each account is tagged with; the commands print the application's JSON
// envelope, and --format csv prints a spreadsheet file rendered by the service (the same code the
// screens use, which neutralises text a spreadsheet could run as a formula).
//
//	rastrata tax worksheet --year YYYY [--form scheduleC|form1120S|form1065] [--from DATE] [--to DATE]
//	                       [--meals-percent N] [--revision N] [--tags-revision N]
//	                       [--format csv --file worksheet|accounts|postings]
//	rastrata tax checks    --year YYYY [--form ...] [--from DATE] [--to DATE]
func init() {
	Register(Command{
		Name: "tax worksheet",
		Summary: "Total the books by tax line: tax worksheet --year YYYY [--form scheduleC|form1120S|form1065] " +
			"[--from DATE --to DATE] [--meals-percent N] [--format csv --file worksheet|accounts|postings]",
		Run: runTaxWorksheet,
	})
	Register(Command{
		Name:    "tax checks",
		Summary: "What to look at before relying on a tax year: tax checks --year YYYY [--form scheduleC|form1120S|form1065] [--from DATE --to DATE]",
		Run:     runTaxChecks,
	})
}

const taxWorksheetUsage = "tax worksheet --year YYYY [--form scheduleC|form1120S|form1065] [--from YYYY-MM-DD] [--to YYYY-MM-DD] " +
	"[--meals-percent 0-100] [--revision N] [--tags-revision N] [--format json|csv] [--file worksheet|accounts|postings]"

const taxChecksUsage = "tax checks --year YYYY [--form scheduleC|form1120S|form1065] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--revision N] [--tags-revision N]"

// taxYearFlag reads --year, which every tax command needs: the form's tax year, not a date.
func taxYearFlag(r Runner, o Options, usage string) (int, bool) {
	value, given := o.Flags["year"]
	if !given || value == "true" || value == "" {
		r.localError(o, "usage_error", "--year YYYY is required. Use "+usage, 2)
		return 0, false
	}
	year, err := strconv.Atoi(value)
	if err != nil || year < 2000 || year > 2100 {
		r.localError(o, "usage_error", "--year must be a four-digit tax year such as 2025. Use "+usage, 2)
		return 0, false
	}
	return year, true
}

// rejectBareFlags refuses a flag written without a value ("--from" alone reads as "true").
func rejectBareFlags(r Runner, o Options, usage string, names ...string) bool {
	for _, name := range names {
		if value, given := o.Flags[name]; given && (value == "true" || value == "") {
			r.localError(o, "usage_error", "--"+name+" needs a value. Use "+usage, 2)
			return false
		}
	}
	return true
}

// mealsPercentFlag reads --meals-percent: the value, whether it was given, and whether it was usable.
func mealsPercentFlag(r Runner, o Options, usage string) (int, bool, bool) {
	value, given := o.Flags["meals-percent"]
	if !given {
		return 0, false, true
	}
	percent, err := strconv.Atoi(value)
	if err != nil || percent < 0 || percent > 100 {
		r.localError(o, "usage_error", "--meals-percent must be a whole number from 0 to 100. Use "+usage, 2)
		return 0, true, false
	}
	return percent, true, true
}

// taxInput builds the input every tax command shares from its flags.
func taxInput(o Options, year int) map[string]any {
	input := map[string]any{"taxYear": year}
	for flag, field := range map[string]string{"form": "form", "from": "from", "to": "to", "tags-revision": "tagsRevision"} {
		if value, given := o.Flags[flag]; given {
			input[field] = value
		}
	}
	if o.Revision != "" {
		input["revision"] = o.Revision
	}
	return input
}

// writeContent prints a rendered file exactly as the service made it.
func (r Runner) writeContent(o Options, data json.RawMessage) int {
	var file struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return r.localError(o, "export_failed", err.Error(), 4)
	}
	if _, err := io.WriteString(r.Output, file.Content); err != nil {
		return r.localError(o, "export_failed", err.Error(), 4)
	}
	return 0
}

func runTaxWorksheet(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax worksheet takes only options. Use "+taxWorksheetUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "form", "from", "to", "meals-percent", "tags-revision", "file"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxWorksheetUsage, 2)
	}
	if !rejectBareFlags(r, o, taxWorksheetUsage, "form", "from", "to", "meals-percent", "tags-revision", "file") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxWorksheetUsage)
	if !ok {
		return 2
	}
	input := taxInput(o, year)
	if percent, given, ok := mealsPercentFlag(r, o, taxWorksheetUsage); !ok {
		return 2
	} else if given {
		input["mealsPercent"] = percent
	}
	if o.Format == "csv" {
		if file, given := o.Flags["file"]; given {
			input["file"] = file
		}
		response, err := c.Call(ctx, "taxWorksheet.export", input, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		return r.writeContent(o, response.Data)
	}
	if _, given := o.Flags["file"]; given {
		return r.localError(o, "usage_error", "--file applies to --format csv. Use "+taxWorksheetUsage, 2)
	}
	response, err := c.Call(ctx, "taxWorksheet.get", input, "")
	return r.result(o, response, err, "")
}

func runTaxChecks(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax checks takes only options. Use "+taxChecksUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "form", "from", "to", "tags-revision"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxChecksUsage, 2)
	}
	if !rejectBareFlags(r, o, taxChecksUsage, "form", "from", "to", "tags-revision") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxChecksUsage)
	if !ok {
		return 2
	}
	response, err := c.Call(ctx, "taxChecks.get", taxInput(o, year), "")
	return r.result(o, response, err, "")
}

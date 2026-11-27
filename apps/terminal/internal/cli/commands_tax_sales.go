package cli

import (
	"context"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The sales-tax summary: what the books recorded in the liability account tagged tax.sales, by month,
// quarter or the whole range, beside what Stripe reported on the payouts booked in the same period.
// Rastrata does not know sales tax rates, which sales are taxable or when a return is due, and the
// result says so; it reports what the books hold and never what is owed. --format csv prints the file
// the service renders (the same code the screens and the year-end pack use).
//
//	rastrata tax sales --year YYYY [--period month|quarter|year] [--from DATE] [--to DATE]
//	                   [--revision N] [--tags-revision N] [--format csv --file summary|postings]
func init() {
	Register(Command{
		Name: "tax sales",
		Summary: "Sales tax the books collected and paid, by period: tax sales --year YYYY [--period month|quarter|year] " +
			"[--from DATE --to DATE] [--format csv --file summary|postings]",
		Run: runTaxSales,
	})
}

const taxSalesUsage = "tax sales --year YYYY [--period month|quarter|year] [--from YYYY-MM-DD] [--to YYYY-MM-DD] " +
	"[--revision N] [--tags-revision N] [--format json|csv] [--file summary|postings]"

func runTaxSales(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax sales takes only options. Use "+taxSalesUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "period", "from", "to", "tags-revision", "file"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxSalesUsage, 2)
	}
	if !rejectBareFlags(r, o, taxSalesUsage, "period", "from", "to", "tags-revision", "file") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxSalesUsage)
	if !ok {
		return 2
	}
	input := taxInput(o, year)
	if period, given := o.Flags["period"]; given {
		if period != "month" && period != "quarter" && period != "year" {
			return r.localError(o, "usage_error", "--period must be month, quarter or year. Use "+taxSalesUsage, 2)
		}
		input["period"] = period
	}
	if o.Format == "csv" {
		if file, given := o.Flags["file"]; given {
			if file != "summary" && file != "postings" {
				return r.localError(o, "usage_error", "--file must be summary or postings. Use "+taxSalesUsage, 2)
			}
			input["file"] = file
		}
		response, err := c.Call(ctx, "taxSales.export", input, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		return r.writeContent(o, response.Data)
	}
	if _, given := o.Flags["file"]; given {
		return r.localError(o, "usage_error", "--file applies to --format csv. Use "+taxSalesUsage, 2)
	}
	response, err := c.Call(ctx, "taxSales.get", input, "")
	return r.result(o, response, err, "")
}

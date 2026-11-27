package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The stripe lane's commands. Rastrata books Stripe the way A2X does: one entry in the Inbox for
// each payout Stripe has itemised, added up role by role from the balance transactions Stripe says
// the payout paid out (sales, sales tax, refunds, chargebacks, fees, and the payout against payouts
// in transit), with each transaction kept as evidence and never posted on its own. A sync reads
// with a read-only key; it never posts and never changes anything in Stripe. The key is never an
// argument: it comes from the RASTRATA_STRIPE_KEY environment variable of the service, or the
// private file stripe.key in its data folder, and no command prints it.
//
//	rastrata stripe status [--books false]
//	rastrata stripe sync [--once] [--budget-seconds N]
//	rastrata stripe payouts [--filter all|waiting|mismatch|held|unmatched] [--page N]
//	rastrata stripe configure [--map ROLE=ACCOUNT,...|none] [--sync-from DATE] [--time-zone ZONE]
//	                          [--sales-tax stripe|none] [--overlap-days N] [--match-window-days N]
func init() {
	Register(Command{Name: "stripe status", Summary: "Stripe: key present or missing (never shown), the account each role uses, last sync, Stripe's balance against what is not yet paid out [--books false]", Run: runStripeStatus})
	Register(Command{Name: "stripe sync", Summary: "Stripe: pull new balance transactions and queue one Inbox entry per payout until caught up [--once] [--budget-seconds N]", Run: runStripeSync})
	Register(Command{Name: "stripe payouts", Summary: "Stripe: payouts, how each is booked and whether its transactions add up to the cent [--filter all|waiting|mismatch|held|unmatched] [--page N]", Run: runStripePayouts})
	Register(Command{Name: "stripe configure", Summary: "Stripe: choose the accounts (a role left unchosen uses the account carrying its role key), first day, time zone and sales tax handling [--map ROLE=ACCOUNT,...|none] [--sync-from D] [--time-zone Z] [--sales-tax stripe|none]", Run: runStripeConfigure})
}

// maxStripeCalls bounds a catch-up so a stuck service cannot loop forever.
const maxStripeCalls = 500

func stripeUsage(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

// stripeFlagProblem names the first flag that is not one of allowed, or a valued flag given bare.
func stripeFlagProblem(o Options, allowed []string, valued []string) string {
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

func stripeCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) int {
	definition, _ := api.FindOperation(operation)
	operationID := ""
	if definition.Writes {
		operationID = o.OperationID
		if operationID == "" {
			operationID = api.NewOperationID()
		}
		fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
	}
	response, err := c.Call(ctx, operation, input, operationID)
	return r.result(o, response, err, "")
}

func stripeInteger(r Runner, o Options, name string, low, high int) (int, bool, int) {
	raw, given := o.Flags[name]
	if !given {
		return 0, false, 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < low || value > high {
		return 0, false, r.localError(o, "usage_error", fmt.Sprintf("--%s must be a whole number from %d to %d", name, low, high), 2)
	}
	return value, true, 0
}

func runStripeStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "stripe status [--books false]"
	if len(o.Args) != 2 {
		return stripeUsage(r, o, "stripe status takes no arguments", usage)
	}
	if problem := stripeFlagProblem(o, []string{"books"}, nil); problem != "" {
		return stripeUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if value, given := o.Flags["books"]; given {
		switch strings.ToLower(value) {
		case "false", "no", "0":
			input["books"] = false
		case "true", "yes", "1":
			input["books"] = true
		default:
			return stripeUsage(r, o, "--books is true or false", usage)
		}
	}
	return stripeCall(r, ctx, o, c, "stripe.status", input)
}

func runStripePayouts(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "stripe payouts [--filter all|waiting|mismatch|held|unmatched] [--page N]"
	if len(o.Args) != 2 {
		return stripeUsage(r, o, "stripe payouts takes no arguments", usage)
	}
	if problem := stripeFlagProblem(o, []string{"filter", "page"}, []string{"filter", "page"}); problem != "" {
		return stripeUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if filter, given := o.Flags["filter"]; given {
		switch filter {
		case "all", "waiting", "mismatch", "held", "unmatched":
			input["filter"] = filter
		default:
			return stripeUsage(r, o, "--filter is all, waiting, mismatch, held or unmatched", usage)
		}
	}
	if page, given, failed := stripeInteger(r, o, "page", 1, 100000); failed != 0 {
		return failed
	} else if given {
		input["page"] = page
	}
	return stripeCall(r, ctx, o, c, "stripe.payouts", input)
}

func runStripeSync(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "stripe sync [--once] [--budget-seconds N]"
	if len(o.Args) != 2 {
		return stripeUsage(r, o, "stripe sync takes no arguments", usage)
	}
	if problem := stripeFlagProblem(o, []string{"once", "budget-seconds"}, []string{"budget-seconds"}); problem != "" {
		return stripeUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if seconds, given, failed := stripeInteger(r, o, "budget-seconds", 1, 25); failed != 0 {
		return failed
	} else if given {
		input["budgetSeconds"] = seconds
	}
	once := o.Flags["once"] == "true"
	if once || o.OperationID != "" {
		// One call, under the identity the caller gave: a retried call returns the first result.
		return stripeCall(r, ctx, o, c, "stripe.sync", input)
	}
	// Catch up: each call works within its time budget and says whether more is left. Every call is
	// a new operation with its own retained identity; the service continues from its own cursor.
	var last api.Response
	for call := 1; call <= maxStripeCalls; call++ {
		operationID := api.NewOperationID()
		fmt.Fprintf(r.Diagnostics, "Retaining %s for stripe.sync; use operations requests or operations resume after interruption.\n", operationID)
		response, err := c.Call(ctx, "stripe.sync", input, operationID)
		if err != nil {
			return r.result(o, response, err, "")
		}
		last = response
		var outcome struct {
			More bool `json:"more"`
			Run  struct {
				NewLines int `json:"newLines"`
				Payouts  int `json:"payouts"`
			} `json:"run"`
		}
		_ = json.Unmarshal(response.Data, &outcome)
		if !outcome.More {
			break
		}
		fmt.Fprintf(r.Diagnostics, "Stripe sync: %d payouts booked, %d new lines in call %d; continuing.\n", outcome.Run.Payouts, outcome.Run.NewLines, call)
	}
	return r.result(o, last, nil, "")
}

func runStripeConfigure(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "stripe configure [--map ROLE=ACCOUNT,...|none] [--sync-from YYYY-MM-DD] [--time-zone ZONE] [--sales-tax stripe|none] [--overlap-days N] [--match-window-days N]"
	if len(o.Args) != 2 {
		return stripeUsage(r, o, "stripe configure takes no arguments", usage)
	}
	flags := []string{"map", "sync-from", "time-zone", "sales-tax", "overlap-days", "match-window-days"}
	if problem := stripeFlagProblem(o, flags, flags); problem != "" {
		return stripeUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if value, given := o.Flags["map"]; given {
		// The chosen accounts are replaced as a whole. "none" clears them, and every role then uses
		// the account that carries its role key in the chart.
		mapping := []map[string]string{}
		if strings.TrimSpace(value) != "none" {
			for _, pair := range strings.Split(value, ",") {
				role, account, found := strings.Cut(strings.TrimSpace(pair), "=")
				if !found || role == "" || account == "" {
					return stripeUsage(r, o, "--map is a comma separated list of ROLE=ACCOUNT_ID, or none", usage)
				}
				mapping = append(mapping, map[string]string{"role": role, "accountId": account})
			}
		}
		input["mapping"] = mapping
	}
	if value, given := o.Flags["sync-from"]; given {
		input["syncFrom"] = value
	}
	if value, given := o.Flags["time-zone"]; given {
		input["timeZone"] = value
	}
	if value, given := o.Flags["sales-tax"]; given {
		if value != "stripe" && value != "none" {
			return stripeUsage(r, o, "--sales-tax is stripe or none", usage)
		}
		input["salesTax"] = value
	}
	if days, given, failed := stripeInteger(r, o, "overlap-days", 0, 30); failed != 0 {
		return failed
	} else if given {
		input["overlapDays"] = days
	}
	if days, given, failed := stripeInteger(r, o, "match-window-days", 0, 14); failed != 0 {
		return failed
	} else if given {
		input["matchWindowDays"] = days
	}
	return stripeCall(r, ctx, o, c, "stripe.configure", input)
}

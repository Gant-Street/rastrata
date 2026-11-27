package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// A trial balance of any system, read into exact cents.
//
//	rastrata intake trial-balance FILE [--balances-only=true]
//
// The rows come back with the book's account where a row names one by its code or its exact name,
// and the balance as `opening review --balances` takes it. --balances-only prints just that list for
// the bank and card accounts that have a balance, ready to put in place of the old system's figures
// with the statements' balances. Income and expense rows are year-to-date amounts and are never
// offered. Nothing is imported.
const intakeTrialBalanceUsage = "intake trial-balance FILE [--balances-only=true]"

func init() {
	Register(Command{
		Name:    "intake trial-balance",
		Summary: "Read a trial balance of any system into exact cents, matched to the book's accounts: intake trial-balance FILE [--balances-only=true prints ID=AMOUNT,... for opening review]",
		Run:     runIntakeTrialBalance,
	})
	intakeFlags["balances-only"] = "bool"
}

type tbRow struct {
	Row     int    `json:"row"`
	Section string `json:"section"`
	Code    string `json:"code"`
	Name    string `json:"name"`
	Debit   string `json:"debit"`
	Credit  string `json:"credit"`
	Balance string `json:"balance"`
	Match   *struct {
		AccountID string `json:"accountId"`
		How       string `json:"how"`
		Role      string `json:"role"`
	} `json:"match"`
	Suggested string `json:"suggested"`
}

type tbView struct {
	AsOf     *string `json:"asOf"`
	Layout   *string `json:"layout"`
	Balanced bool    `json:"balanced"`
	Debit    string  `json:"debit"`
	Credit   string  `json:"credit"`
	Rows     []tbRow `json:"rows"`
	Issues   []struct {
		Severity string `json:"severity"`
		Row      int    `json:"row"`
		Message  string `json:"message"`
	} `json:"issues"`
}

func runIntakeTrialBalance(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, intakeTrialBalanceUsage) }
	if problem := intakeOptions(o.Flags, "balances-only"); problem != "" {
		return usage(problem)
	}
	if len(o.Args) != 3 {
		return usage("Name the one trial balance file")
	}
	sha, exit := uploadStatement(r, ctx, o, c, o.Args[2])
	if exit >= 0 {
		return exit
	}
	response, err := c.Call(ctx, "intake.trialBalance", map[string]any{"sha256": sha}, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	var view tbView
	if err := json.Unmarshal(response.Data, &view); err != nil {
		return r.localError(o, "client_error", err.Error(), 4)
	}
	if o.Flags["balances-only"] == "true" {
		if !view.Balanced {
			return r.localError(o, "trial_balance_unbalanced", "A trial balance always balances: rows are missing from this one. Export it again; do not edit it. Nothing is printed.", 3)
		}
		var parts []string
		for _, row := range view.Rows {
			if row.Match == nil || (row.Match.Role != "asset" && row.Match.Role != "liability") || row.Suggested == "" || row.Suggested == "0.00" {
				continue
			}
			parts = append(parts, row.Match.AccountID+"="+row.Suggested)
		}
		fmt.Fprintln(r.Output, strings.Join(parts, ","))
		fmt.Fprintln(r.Diagnostics, "These are the old system's balances. Put the statement's balance in place of each bank, card and Stripe account, and leave income and expense out.")
		return 0
	}
	if o.Format == "text" {
		printTrialBalanceText(r.Output, view)
		return 0
	}
	return r.result(o, response, nil, "")
}

func printTrialBalanceText(w io.Writer, view tbView) {
	asOf := "no date"
	if view.AsOf != nil {
		asOf = *view.AsOf
	}
	state := "balances"
	if !view.Balanced {
		state = "DOES NOT BALANCE"
	}
	fmt.Fprintf(w, "Trial balance as at %s: debits %s, credits %s (%s)\n", asOf, view.Debit, view.Credit, state)
	table := tabwriter.NewWriter(w, 2, 0, 2, ' ', 0)
	fmt.Fprintln(table, "ROW\tCODE\tACCOUNT\tDEBIT\tCREDIT\tBOOK ACCOUNT\tOPENING")
	for _, row := range view.Rows {
		book, suggested := "-", "-"
		if row.Match != nil {
			book = row.Match.AccountID + " (" + row.Match.How + ")"
			suggested = row.Suggested
		}
		fmt.Fprintf(table, "%d\t%s\t%s\t%s\t%s\t%s\t%s\n", row.Row, dash(plain(row.Code)), plain(row.Name), row.Debit, row.Credit, book, suggested)
	}
	_ = table.Flush()
	for _, issue := range view.Issues {
		fmt.Fprintf(w, "%s: %s\n", issue.Severity, plain(issue.Message))
	}
}

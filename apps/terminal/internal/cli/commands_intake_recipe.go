package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// Recipes: a statement layout written down as data, proven once, then run the same way every time.
//
//	rastrata intake recipe test RECIPE.json FILE [--opening-balance A] [--ending-balance A]
//	                            [--period-from D] [--period-to D] [--skip-invalid-rows=true] [--account ID]
//	rastrata intake recipe save RECIPE.json FILE [the same options]
//	rastrata intake recipe list
//	rastrata intake verify FILE [the same options]        (a file that needs no recipe: OFX, a known bank)
//
// A recipe is a JSON file of at most 100 KiB: the mapping an import profile holds, with a name, a
// version and the kind of account. It holds no code and nothing in it is evaluated. The balances are
// what the statement itself prints: they are never read from the books, which are what is checked.
// The statement file is the one path on the command line; no path is read from a file.
const intakeRecipeUsage = "intake recipe test RECIPE.json FILE [--opening-balance A] [--ending-balance A] [--period-from D] [--period-to D] [--skip-invalid-rows=true] [--account ID] [--record=false] | " +
	"intake recipe save RECIPE.json FILE [same options] | intake recipe list | intake verify FILE [same options]"

const maxRecipeBytes = 100 * 1024

func init() {
	Register(Command{
		Name:    "intake recipe",
		Summary: "Recipes: a statement layout as data, proven then reused: test RECIPE.json FILE | save RECIPE.json FILE | list; give the balances the statement prints",
		Run:     runIntakeRecipe,
	})
	Register(Command{
		Name:    "intake verify",
		Summary: "Prove a statement file that needs no recipe (OFX, QFX, a bank the presets know): intake verify FILE [--opening-balance A] [--ending-balance A]",
		Run:     runIntakeVerify,
	})
}

func init() {
	for name, kind := range map[string]string{
		"opening-balance": "text", "ending-balance": "text", "period-from": "text", "period-to": "text",
		"skip-invalid-rows": "bool", "account": "text",
	} {
		intakeFlags[name] = kind
	}
}

var proofFlags = []string{"opening-balance", "ending-balance", "period-from", "period-to", "skip-invalid-rows", "account", "record"}

// readUserFile reads the one file a person named, at most the upload limit.
func readUserFile(path string) ([]byte, string) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err.Error()
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return nil, plain(path) + " is not a file"
	}
	data, err := io.ReadAll(io.LimitReader(file, api.MaxUploadBytes+1))
	if err != nil {
		return nil, err.Error()
	}
	if len(data) > api.MaxUploadBytes {
		return nil, "The file exceeds 16 MiB. Export a shorter date range and import it in parts."
	}
	if len(data) == 0 {
		return nil, "The file is empty"
	}
	return data, ""
}

func readRecipe(path string) (map[string]any, string) {
	raw, problem := readUserFile(path)
	if problem != "" {
		return nil, problem
	}
	if len(raw) > maxRecipeBytes {
		return nil, "The recipe must be one JSON object of at most 100 KiB"
	}
	var recipe map[string]any
	if err := json.Unmarshal(raw, &recipe); err != nil || recipe == nil {
		return nil, "The recipe must be one JSON object of at most 100 KiB"
	}
	return recipe, ""
}

// proofInput turns the options into the balances and agreements a proof carries.
func proofInput(flags map[string]string) map[string]any {
	input := map[string]any{}
	for flag, field := range map[string]string{
		"opening-balance": "openingBalance", "ending-balance": "endingBalance",
		"period-from": "periodFrom", "period-to": "periodTo",
	} {
		if value, given := flags[flag]; given {
			input[field] = value
		}
	}
	if flags["skip-invalid-rows"] == "true" {
		input["skipInvalidRows"] = true
	}
	return input
}

func runIntakeVerify(r Runner, ctx context.Context, o Options, c *api.Client) int {
	return runRecipeTest(r, ctx, o, c, "", "intake verify FILE [--opening-balance A] [--ending-balance A] [--period-from D] [--period-to D] [--skip-invalid-rows=true] [--account ID]", 2)
}

func runIntakeRecipe(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, intakeRecipeUsage) }
	if len(o.Args) < 3 {
		return usage("Name what to do: test, save or list")
	}
	switch o.Args[2] {
	case "list":
		if len(o.Args) != 3 {
			return usage("intake recipe list takes no arguments")
		}
		if problem := intakeOptions(o.Flags); problem != "" {
			return usage(problem)
		}
		response, err := c.Call(ctx, "intake.recipeList", map[string]any{}, "")
		return r.result(o, response, err, "")
	case "test":
		if len(o.Args) != 5 {
			return usage("Name the recipe file and the statement file")
		}
		return runRecipeTest(r, ctx, o, c, o.Args[3], intakeRecipeUsage, 4)
	case "save":
		if len(o.Args) != 5 {
			return usage("Name the recipe file and the statement file it is proven on")
		}
		return runRecipeSave(r, ctx, o, c)
	}
	return usage("Unknown action " + plain(o.Args[2]))
}

// chartAccountID resolves --account to a chart account's id.
func chartAccountID(r Runner, ctx context.Context, o Options, c *api.Client, want string) (string, int) {
	accounts, exit := r.listChart(ctx, o, c)
	if exit >= 0 {
		return "", exit
	}
	account, problem := importAccount(accounts, want)
	if problem != "" {
		return "", r.localError(o, "usage_error", problem, 2)
	}
	return account.ID, -1
}

// uploadStatement reads and uploads the statement file and returns its SHA-256.
func uploadStatement(r Runner, ctx context.Context, o Options, c *api.Client, path string) (string, int) {
	data, problem := readUserFile(path)
	if problem != "" {
		return "", r.localError(o, "input_unavailable", plain(problem), 2)
	}
	receipt, err := c.Upload(ctx, data, "application/octet-stream", filepath.Base(path))
	if err != nil {
		return "", r.result(o, api.Response{}, err, "")
	}
	return receipt.SHA256, -1
}

func runRecipeTest(r Runner, ctx context.Context, o Options, c *api.Client, recipePath, usageText string, expectedArgs int) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, usageText) }
	if problem := intakeOptions(o.Flags, proofFlags...); problem != "" {
		return usage(problem)
	}
	// "intake verify FILE" is three words and "intake recipe test RECIPE FILE" is five.
	filePath := ""
	switch {
	case recipePath == "" && len(o.Args) == 3:
		filePath = o.Args[2]
	case recipePath != "" && len(o.Args) == expectedArgs+1:
		filePath = o.Args[4]
	default:
		return usage("Name the statement file")
	}
	input := proofInput(o.Flags)
	if recipePath != "" {
		recipe, problem := readRecipe(recipePath)
		if problem != "" {
			return r.localError(o, "input_unavailable", plain(problem), 2)
		}
		input["recipe"] = recipe
	}
	if want, given := o.Flags["account"]; given {
		id, exit := chartAccountID(r, ctx, o, c, want)
		if exit >= 0 {
			return exit
		}
		input["ledgerAccountId"] = id
	}
	sha, exit := uploadStatement(r, ctx, o, c, filePath)
	if exit >= 0 {
		return exit
	}
	input["sha256"] = sha
	response, err := c.Call(ctx, "intake.recipeTest", input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	var report recipeReport
	if json.Unmarshal(response.Data, &report) == nil && o.Flags["record"] != "false" {
		recordRecipeFriction(ctx, r, c, sha, report)
	}
	if o.Format == "text" && json.Unmarshal(response.Data, &report) == nil {
		printRecipeText(r.Output, report)
		if !report.Valid {
			return 3
		}
		return 0
	}
	return r.result(o, response, nil, "")
}

func runRecipeSave(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, intakeRecipeUsage) }
	if problem := intakeOptions(o.Flags, proofFlags...); problem != "" {
		return usage(problem)
	}
	recipe, problem := readRecipe(o.Args[3])
	if problem != "" {
		return r.localError(o, "input_unavailable", plain(problem), 2)
	}
	input := map[string]any{"recipe": recipe}
	if want, given := o.Flags["account"]; given {
		id, exit := chartAccountID(r, ctx, o, c, want)
		if exit >= 0 {
			return exit
		}
		input["ledgerAccountId"] = id
	}
	sha, exit := uploadStatement(r, ctx, o, c, o.Args[4])
	if exit >= 0 {
		return exit
	}
	proof := proofInput(o.Flags)
	delete(proof, "ledgerAccountId")
	proof["sha256"] = sha
	input["proofs"] = []map[string]any{proof}
	if o.OperationID == "" {
		o.OperationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for intake.recipeSave; use operations requests or operations resume after interruption.\n", o.OperationID)
	response, err := c.Call(ctx, "intake.recipeSave", input, o.OperationID)
	if err == nil && o.Flags["record"] != "false" {
		// The layout has a recipe now: the file's need for one is met.
		recordFriction(ctx, r, c, nil, []string{"file:" + sha + ":recipe", "balance:" + sha}, "a recipe was proven and saved")
	}
	return r.result(o, response, err, "")
}

// ---- The report ---------------------------------------------------------------------------

type recipeGate struct {
	Gate   string `json:"gate"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Rows   []int  `json:"rows"`
}

type recipeReport struct {
	Valid    bool `json:"valid"`
	Verified bool `json:"verified"`
	File     struct {
		Name string `json:"name"`
	} `json:"file"`
	Recipe *struct {
		Name string `json:"name"`
	} `json:"recipe"`
	Reading struct {
		Format, Source string
	} `json:"reading"`
	Rows struct {
		Total, Lines, Rejected, Filtered int
	} `json:"rows"`
	Range *struct {
		From, To string
	} `json:"range"`
	Totals struct {
		MoneyIn  string `json:"moneyIn"`
		MoneyOut string `json:"moneyOut"`
	} `json:"totals"`
	Rejected []struct {
		Row    int    `json:"row"`
		Reason string `json:"reason"`
	} `json:"rejected"`
	Verification struct {
		Method, Status, Detail string
	} `json:"verification"`
	Gates []recipeGate `json:"gates"`
	Hints []string     `json:"hints"`
}

func printRecipeText(w io.Writer, report recipeReport) {
	name := "no recipe"
	if report.Recipe != nil {
		name = "recipe " + plain(report.Recipe.Name)
	}
	state := "not valid"
	if report.Valid {
		state = "valid"
	}
	proof := "not proven"
	if report.Verified {
		proof = "proven"
	}
	fmt.Fprintf(w, "%s on %s: %s, %s\n", name, plain(report.File.Name), state, proof)
	span := ""
	if report.Range != nil {
		span = fmt.Sprintf("; %s to %s", report.Range.From, report.Range.To)
	}
	fmt.Fprintf(w, "Rows: %d read of %d, %d rejected, %d left out by the filter%s; in %s, out %s\n",
		report.Rows.Lines, report.Rows.Total, report.Rows.Rejected, report.Rows.Filtered, span, report.Totals.MoneyIn, report.Totals.MoneyOut)
	fmt.Fprintf(w, "Proof (%s): %s. %s\n", report.Verification.Method, report.Verification.Status, plain(report.Verification.Detail))
	for _, gate := range report.Gates {
		if gate.Status == "not_applicable" {
			continue
		}
		rows := ""
		if len(gate.Rows) > 0 {
			rows = fmt.Sprintf(" (rows %v)", gate.Rows)
		}
		fmt.Fprintf(w, "  %-10s %-18s %s%s\n", gate.Status, gate.Gate, plain(gate.Detail), rows)
	}
	for _, rejected := range report.Rejected {
		fmt.Fprintf(w, "  rejected row %d: %s\n", rejected.Row, plain(rejected.Reason))
	}
	for _, hint := range report.Hints {
		fmt.Fprintf(w, "check: %s\n", plain(hint))
	}
}

// recordRecipeFriction logs a recipe that failed a gate, once for each attempt (each is a retry),
// and a proof that is missing its balances, once for the file.
func recordRecipeFriction(ctx context.Context, r Runner, c *api.Client, sha string, report recipeReport) {
	var failed []string
	for _, gate := range report.Gates {
		if gate.Status == "fail" {
			failed = append(failed, gate.Gate)
		}
	}
	switch {
	case !report.Valid:
		reason := "the file failed the gate"
		if len(failed) != 1 {
			reason += "s"
		}
		recordFriction(ctx, r, c, []frictionEvent{{
			Kind: "recipe_failed", Source: shortHash(sha),
			Reason: reason + ": " + strings.Join(failed, ", "),
		}}, nil, "")
	case !report.Verified && report.Verification.Status == "unverified":
		recordFriction(ctx, r, c, []frictionEvent{{
			Kind: "balance_needed", Source: shortHash(sha), Key: "balance:" + sha,
			Reason: "nothing proves the file complete: the statement's balances are needed",
		}}, nil, "")
	case report.Verified:
		recordFriction(ctx, r, c, nil, []string{"balance:" + sha}, "the file was proven")
	}
}

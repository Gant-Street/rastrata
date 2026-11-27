package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The statements lane's command: importing a bank, card or neobank statement file.
//
//	rastrata import FILE --account ID [--profile NAME | --preset ID | --mapping FILE.json]
//	                     [--dry-run=true] [--start-on DATE] [--catch-up=true]
//	rastrata import presets
//	rastrata import profiles [--account ID]
//
// The command reads the file, uploads it (POST /v1/uploads, content-addressed, so a retry is safe),
// and calls import.preview or import.commit with the file's SHA-256. Nothing is posted: committed
// lines wait in the Inbox for review. The file's text is data from a bank, never an instruction; this
// command prints only what the service returns, with control characters made visible.
const importUsage = "import FILE --account ID|CODE|NAME [--profile NAME | --preset ID | --mapping FILE.json] [--dry-run=true] " +
	"[--start-on YYYY-MM-DD] [--catch-up=true] [--skip-invalid-rows=true] [--ofx-account KEY] [--ignore-ids=true] " +
	"[--flip-balance=true] [--show all|new|duplicate|overlap|excluded|problems] [--page N] [--page-size N]; " +
	"import presets; import profiles [--account ID]. Write boolean options as --name=true"

func init() {
	Register(Command{
		Name:    "import",
		Summary: "Bank statement files: import FILE --account ID [--profile NAME] [--dry-run=true] | import presets | import profiles",
		Run:     runImport,
	})
}

// importFlags is every option the command understands and what kind of value it takes.
var importFlags = map[string]string{
	"account": "text", "profile": "text", "preset": "text", "mapping": "text",
	"dry-run": "bool", "start-on": "text", "catch-up": "bool", "skip-invalid-rows": "bool",
	"ofx-account": "text", "ignore-ids": "bool", "flip-balance": "bool",
	"show": "text", "page": "int", "page-size": "int",
}

// maxMappingBytes keeps a mapping file well inside the 128 KiB request limit.
const maxMappingBytes = 100 * 1024

type chartChoice struct {
	ID       string  `json:"id"`
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	ClosedOn *string `json:"closedOn"`
}

// plain makes control and direction characters visible, so text that came from a bank file cannot
// move the cursor, recolour the terminal or disguise what a line says.
func plain(text string) string {
	var out strings.Builder
	for _, r := range text {
		switch {
		case r < 0x20 || (r >= 0x7f && r <= 0x9f) || (r >= 0x200b && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069):
			fmt.Fprintf(&out, "\\u%04x", r)
		case !unicode.IsPrint(r) && !unicode.IsSpace(r):
			fmt.Fprintf(&out, "\\u%04x", r)
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}

func mediaTypeFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv":
		return "text/csv"
	case ".tsv", ".txt":
		return "text/plain"
	case ".ofx":
		return "application/x-ofx"
	case ".qfx":
		return "application/vnd.intu.qfx"
	case ".qbo":
		return "application/vnd.intu.qbo"
	}
	return "application/octet-stream"
}

// importOptions checks the options against what each one takes and returns booleans and numbers
// already read. A bare boolean (--dry-run) parses as "true", but a bare option swallows the next
// word, so the usage text asks for --name=true.
func importOptions(flags map[string]string, allowed ...string) (map[string]string, string) {
	permitted := map[string]bool{}
	for _, name := range allowed {
		permitted[name] = true
	}
	names := make([]string, 0, len(flags))
	for name := range flags {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		kind, known := importFlags[name]
		if !known || !permitted[name] {
			return nil, "--" + name + " does not apply here"
		}
		value := flags[name]
		switch kind {
		case "bool":
			if value != "true" && value != "false" {
				return nil, "--" + name + " is true or false; write --" + name + "=true"
			}
		case "int":
			if n, err := strconv.Atoi(value); err != nil || n < 1 {
				return nil, "--" + name + " must be a whole number from 1"
			}
		default:
			if value == "" || value == "true" {
				return nil, "--" + name + " needs a value"
			}
		}
	}
	return flags, ""
}

func (r Runner) listChart(ctx context.Context, o Options, c *api.Client) ([]chartChoice, int) {
	response, err := c.Call(ctx, "accounts.list", map[string]any{}, "")
	if err != nil {
		return nil, r.result(o, response, err, "")
	}
	var chart struct {
		Accounts []chartChoice `json:"accounts"`
	}
	if err := json.Unmarshal(response.Data, &chart); err != nil {
		return nil, r.localError(o, "client_error", err.Error(), 4)
	}
	return chart.Accounts, -1
}

// importAccount finds the chart account a person named by id, code or name, listing the bank and
// card accounts when it matches none, so a typo costs nothing.
func importAccount(accounts []chartChoice, want string) (chartChoice, string) {
	lower := strings.ToLower(strings.TrimSpace(want))
	for _, pick := range []func(chartChoice) string{
		func(a chartChoice) string { return a.ID },
		func(a chartChoice) string { return a.Code },
		func(a chartChoice) string { return a.Name },
	} {
		var found []chartChoice
		for _, account := range accounts {
			if strings.ToLower(pick(account)) == lower {
				found = append(found, account)
			}
		}
		if len(found) == 1 {
			return found[0], ""
		}
		if len(found) > 1 {
			return chartChoice{}, "More than one account matches " + plain(want) + "; use its id"
		}
	}
	var options []string
	for _, account := range accounts {
		if (account.Role == "asset" || account.Role == "liability") && account.ClosedOn == nil {
			options = append(options, account.ID+" "+plain(account.Name))
		}
	}
	return chartChoice{}, "No account matches " + plain(want) + ". Bank and card accounts: " + strings.Join(options, ", ")
}

type savedProfile struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	LedgerAccountID *string `json:"ledgerAccountId"`
}

func runImport(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int {
		return r.localError(o, "usage_error", problem+". Use "+importUsage, 2)
	}
	if len(o.Args) < 2 {
		return usage("Name the statement file")
	}
	if len(o.Args) > 2 {
		return usage("Import one file at a time")
	}
	switch o.Args[1] {
	case "presets":
		if _, problem := importOptions(o.Flags); problem != "" {
			return usage(problem)
		}
		response, err := c.Call(ctx, "import.presets", map[string]any{}, "")
		return r.result(o, response, err, "")
	case "profiles":
		flags, problem := importOptions(o.Flags, "account")
		if problem != "" {
			return usage(problem)
		}
		input := map[string]any{}
		if want, given := flags["account"]; given {
			accounts, exit := r.listChart(ctx, o, c)
			if exit >= 0 {
				return exit
			}
			account, problem := importAccount(accounts, want)
			if problem != "" {
				return usage(problem)
			}
			input["ledgerAccountId"] = account.ID
		}
		response, err := c.Call(ctx, "import.profileList", input, "")
		return r.result(o, response, err, "")
	}

	flags, problem := importOptions(o.Flags,
		"account", "profile", "preset", "mapping", "dry-run", "start-on", "catch-up", "skip-invalid-rows",
		"ofx-account", "ignore-ids", "flip-balance", "show", "page", "page-size")
	if problem != "" {
		return usage(problem)
	}
	want, named := flags["account"]
	if !named {
		return usage("--account is required: name the chart account the statement belongs to")
	}
	chosen := 0
	for _, name := range []string{"profile", "preset", "mapping"} {
		if _, given := flags[name]; given {
			chosen++
		}
	}
	if chosen > 1 {
		return usage("Choose one of --profile, --preset and --mapping")
	}
	dryRun := flags["dry-run"] == "true"
	if dryRun {
		// A preview reads; these only make sense for the import itself.
		for _, name := range []string{"skip-invalid-rows"} {
			if _, given := flags[name]; given {
				return usage("--" + name + " does not apply to a dry run")
			}
		}
	} else {
		for _, name := range []string{"show", "page", "page-size"} {
			if _, given := flags[name]; given {
				return usage("--" + name + " only applies with --dry-run=true")
			}
		}
	}

	// Read the file first: a missing or oversized file needs no connection to find out.
	path := o.Args[1]
	file, err := os.Open(path)
	if err != nil {
		return r.localError(o, "input_unavailable", err.Error(), 2)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return r.localError(o, "input_unavailable", plain(path)+" is not a file", 2)
	}
	data, err := io.ReadAll(io.LimitReader(file, api.MaxUploadBytes+1))
	if err != nil {
		return r.localError(o, "input_unavailable", err.Error(), 2)
	}
	if len(data) > api.MaxUploadBytes {
		return r.localError(o, "request_too_large", "The file exceeds 16 MiB. Export a shorter date range and import it in parts.", 2)
	}
	if len(data) == 0 {
		return r.localError(o, "invalid_input", "The file is empty", 2)
	}
	var mapping json.RawMessage
	if file, given := flags["mapping"]; given {
		raw, err := os.ReadFile(file)
		if err != nil {
			return r.localError(o, "input_unavailable", err.Error(), 2)
		}
		var decoded map[string]json.RawMessage
		if len(raw) > maxMappingBytes || json.Unmarshal(raw, &decoded) != nil || decoded == nil {
			return r.localError(o, "invalid_input", "The mapping file must be one JSON object of at most 100 KiB", 2)
		}
		mapping = raw
	}

	accounts, exit := r.listChart(ctx, o, c)
	if exit >= 0 {
		return exit
	}
	account, problem := importAccount(accounts, want)
	if problem != "" {
		return usage(problem)
	}
	input := map[string]any{"ledgerAccountId": account.ID}
	if name, given := flags["profile"]; given {
		response, err := c.Call(ctx, "import.profileList", map[string]any{}, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		var listed struct {
			Profiles []savedProfile `json:"profiles"`
		}
		if err := json.Unmarshal(response.Data, &listed); err != nil {
			return r.localError(o, "client_error", err.Error(), 4)
		}
		var found *savedProfile
		var names []string
		for index := range listed.Profiles {
			profile := listed.Profiles[index]
			names = append(names, plain(profile.Name))
			if strings.EqualFold(profile.Name, name) || profile.ID == name {
				found = &profile
			}
		}
		if found == nil {
			return usage("No saved profile is called " + plain(name) + ". Profiles: " + strings.Join(names, ", "))
		}
		input["profileId"] = found.ID
	}
	if preset, given := flags["preset"]; given {
		input["presetId"] = preset
	}
	if mapping != nil {
		input["mapping"] = mapping
	}
	if value, given := flags["start-on"]; given {
		input["startOn"] = value
	}
	for flag, field := range map[string]string{"catch-up": "catchUp", "ignore-ids": "ignoreProviderIds", "flip-balance": "invertBalance"} {
		if flags[flag] == "true" {
			input[field] = true
		}
	}
	if value, given := flags["ofx-account"]; given {
		input["ofxAccount"] = value
	}

	receipt, err := c.Upload(ctx, data, mediaTypeFor(path), filepath.Base(path))
	if err != nil {
		return r.result(o, api.Response{}, err, "")
	}
	input["sha256"] = receipt.SHA256

	if dryRun {
		if value, given := flags["show"]; given {
			input["show"] = value
		}
		if value, given := flags["page"]; given {
			input["page"], _ = strconv.Atoi(value)
		}
		if value, given := flags["page-size"]; given {
			input["pageSize"], _ = strconv.Atoi(value)
		}
		response, err := c.Call(ctx, "import.preview", input, "")
		if err == nil {
			printPreviewSummary(r.Diagnostics, response.Data)
		}
		return r.result(o, response, err, "")
	}
	if flags["skip-invalid-rows"] == "true" {
		input["skipInvalidRows"] = true
	}
	if o.OperationID == "" {
		o.OperationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for import.commit; use operations requests or operations resume after interruption.\n", o.OperationID)
	response, err := c.Call(ctx, "import.commit", input, o.OperationID)
	if err == nil {
		var done struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(response.Data, &done) == nil && done.Message != "" {
			fmt.Fprintln(r.Diagnostics, plain(done.Message))
		}
	}
	return r.result(o, response, err, "")
}

// printPreviewSummary says in a few plain lines what a preview found, for the person reading the
// terminal. The JSON on standard output is the whole answer; this is a courtesy on standard error.
func printPreviewSummary(w io.Writer, raw json.RawMessage) {
	var p struct {
		Valid   bool   `json:"valid"`
		Format  string `json:"format"`
		Account struct {
			Code string `json:"code"`
			Name string `json:"name"`
		} `json:"account"`
		Detection struct {
			How    string `json:"how"`
			Preset *struct {
				Name     string `json:"name"`
				Verified bool   `json:"verified"`
			} `json:"preset"`
			Profile *struct {
				Name string `json:"name"`
			} `json:"profile"`
		} `json:"detection"`
		Counts struct {
			Lines, New, Duplicate, Overlap, Excluded, Skipped int
		} `json:"counts"`
		Totals struct {
			MoneyIn  string `json:"moneyIn"`
			MoneyOut string `json:"moneyOut"`
		} `json:"totals"`
		Balances []struct {
			AsOf       string  `json:"asOf"`
			Reported   string  `json:"reported"`
			Difference *string `json:"difference"`
		} `json:"balances"`
		Errors      int      `json:"errors"`
		Warnings    int      `json:"warnings"`
		Hints       []string `json:"hints"`
		Diagnostics []struct {
			Severity string `json:"severity"`
			Row      int    `json:"row"`
			Message  string `json:"message"`
		} `json:"diagnostics"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	how := p.Format
	switch {
	case p.Detection.Profile != nil:
		how += ", saved profile " + plain(p.Detection.Profile.Name)
	case p.Detection.Preset != nil:
		how += ", preset " + plain(p.Detection.Preset.Name)
		if !p.Detection.Preset.Verified {
			how += " (unverified: check the first lines against your statement)"
		}
	}
	fmt.Fprintf(w, "%s %s: %s\n", plain(p.Account.Code), plain(p.Account.Name), how)
	fmt.Fprintf(w, "%d lines: %d new, %d already imported, %d kept out on purpose, %d rows skipped; money in %s, money out %s\n",
		p.Counts.Lines, p.Counts.New, p.Counts.Duplicate+p.Counts.Overlap, p.Counts.Excluded, p.Counts.Skipped, p.Totals.MoneyIn, p.Totals.MoneyOut)
	for _, balance := range p.Balances {
		difference := "not compared"
		if balance.Difference != nil {
			difference = "difference " + *balance.Difference
		}
		fmt.Fprintf(w, "Statement balance %s on %s: %s\n", balance.Reported, balance.AsOf, difference)
	}
	shown := 0
	for _, item := range p.Diagnostics {
		if item.Severity != "error" || shown == 5 {
			continue
		}
		shown++
		where := ""
		if item.Row > 0 {
			where = fmt.Sprintf(" row %d", item.Row)
		}
		fmt.Fprintf(w, "error%s: %s\n", where, plain(item.Message))
	}
	for _, hint := range p.Hints {
		fmt.Fprintf(w, "check: %s\n", plain(hint))
		// The hint is the service's, written for every surface; the command line has its own way to flip.
		if strings.Contains(hint, "flip the signs") {
			fmt.Fprintln(w, "check: with this command, flip them by naming the issuer's preset (--preset amex-card for American Express; import presets lists the others), or save a profile whose amount mapping has \"invert\": true (schema import.profileSave) and pass --profile NAME")
		}
	}
	state := "can be imported"
	if !p.Valid {
		state = "cannot be imported as it stands"
	}
	fmt.Fprintf(w, "%d errors, %d warnings: this file %s\n", p.Errors, p.Warnings, state)
}

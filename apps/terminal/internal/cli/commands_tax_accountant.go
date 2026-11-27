package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The accountant hand-off. `tax accountant` writes the books of a tax year as files an accountant can
// work in (the chart, every journal with where it came from, the general ledger, the trial balance and
// an empty adjusting-entry template); the accountant's adjusting entries come back as a CSV, which
// `tax adjustments preview` reads and says exactly what importing would do, and `tax adjustments import`
// saves as drafts for the owner to review. An import never posts. The file is read here, sent as text and
// treated as hostile data by the service; nothing in it is ever run or opened as a path.
//
//	rastrata tax accountant --year YYYY --out PATH [--from DATE] [--to DATE] [--revision N] [--tags-revision N]
//	rastrata tax adjustments preview FILE|-
//	rastrata tax adjustments import FILE|- [--operation-id UUID]
func init() {
	Register(Command{
		Name: "tax accountant",
		Summary: "Write the accountant pack to a folder or .zip: tax accountant --year YYYY --out PATH " +
			"[--from DATE --to DATE]",
		Run: runTaxAccountant,
	})
	Register(Command{
		Name: "tax adjustments",
		Summary: "An accountant's adjusting entries: tax adjustments preview FILE | import FILE " +
			"(import saves drafts for you to review and posts nothing)",
		Run: runTaxAdjustments,
	})
}

const taxAccountantUsage = "tax accountant --year YYYY --out PATH [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--revision N] [--tags-revision N]"
const taxAdjustmentsUsage = "tax adjustments preview FILE|- | tax adjustments import FILE|- [--operation-id UUID]"

// maxAdjustmentFileBytes is the most the command reads: the service takes at most 2,000,000 characters,
// and a character is at least one byte, so a larger file cannot be accepted.
const maxAdjustmentFileBytes = 8_000_000

func runTaxAccountant(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax accountant takes only options. Use "+taxAccountantUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "out", "from", "to", "tags-revision"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxAccountantUsage, 2)
	}
	if !rejectBareFlags(r, o, taxAccountantUsage, "out", "from", "to", "tags-revision") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxAccountantUsage)
	if !ok {
		return 2
	}
	destination := o.Flags["out"]
	if destination == "" {
		return r.localError(o, "usage_error", "--out PATH is required: a new folder, or a name ending in .zip. Use "+taxAccountantUsage, 2)
	}
	input := taxInput(o, year)
	return r.writePack(ctx, o, c, "taxAccountant.build", input, destination, "accountant pack")
}

// adjustmentProblem and adjustmentPreview are the parts of the service's preview the command reads to
// say what it found in words; the whole preview is still printed for scripts.
type adjustmentProblem struct {
	Severity string  `json:"severity"`
	Code     string  `json:"code"`
	Message  string  `json:"message"`
	Row      *int    `json:"row"`
	Entry    *string `json:"entry"`
	Column   *string `json:"column"`
}

type adjustmentPreview struct {
	FileName    string `json:"fileName"`
	CanImport   bool   `json:"canImport"`
	PreviewHash string `json:"previewHash"`
	Counts      struct {
		Entries         int `json:"entries"`
		Lines           int `json:"lines"`
		New             int `json:"new"`
		AlreadyImported int `json:"alreadyImported"`
		Conflict        int `json:"conflict"`
		Invalid         int `json:"invalid"`
	} `json:"counts"`
	Problems []adjustmentProblem `json:"problems"`
	Entries  []struct {
		Entry    string              `json:"entry"`
		Status   string              `json:"status"`
		Problems []adjustmentProblem `json:"problems"`
	} `json:"entries"`
}

// readAdjustmentFile reads the accountant's file, or standard input for "-".
func (r Runner) readAdjustmentFile(o Options, name string) (string, string, int) {
	var data []byte
	var err error
	label := name
	if name == "-" {
		label = "standard input"
		data, err = io.ReadAll(io.LimitReader(r.Input, maxAdjustmentFileBytes+1))
	} else {
		label = filepath.Base(name)
		info, statErr := os.Stat(name)
		if statErr != nil {
			return "", "", r.localError(o, "file_unreadable", statErr.Error(), 4)
		}
		if info.IsDir() {
			return "", "", r.localError(o, "usage_error", name+" is a folder, not a CSV file", 2)
		}
		data, err = os.ReadFile(name)
	}
	if err != nil {
		return "", "", r.localError(o, "file_unreadable", err.Error(), 4)
	}
	if len(data) > maxAdjustmentFileBytes {
		return "", "", r.localError(o, "usage_error", "The file is too large to import. Split it into several files.", 2)
	}
	return string(data), label, 0
}

func locationOf(problem adjustmentProblem) string {
	where := ""
	if problem.Row != nil {
		where = fmt.Sprintf("row %d", *problem.Row)
	}
	if problem.Entry != nil {
		if where != "" {
			where += ", "
		}
		where += "entry " + *problem.Entry
	}
	if problem.Column != nil {
		where += ", " + *problem.Column
	}
	if where == "" {
		where = "file"
	}
	return where
}

// describePreview says in words what the service found: the counts and each problem with its place.
func (r Runner) describePreview(preview adjustmentPreview) (blocking int) {
	fmt.Fprintf(r.Diagnostics, "%s: %d entries, %d lines: %d new, %d already imported, %d in conflict, %d invalid.\n",
		preview.FileName, preview.Counts.Entries, preview.Counts.Lines, preview.Counts.New,
		preview.Counts.AlreadyImported, preview.Counts.Conflict, preview.Counts.Invalid)
	all := append([]adjustmentProblem{}, preview.Problems...)
	for _, entry := range preview.Entries {
		all = append(all, entry.Problems...)
	}
	for _, problem := range all {
		if problem.Severity == "error" {
			blocking++
		}
		fmt.Fprintf(r.Diagnostics, "  %s (%s): %s: %s\n", problem.Severity, locationOf(problem), problem.Code, problem.Message)
	}
	return blocking
}

func runTaxAdjustments(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) < 3 {
		return r.localError(o, "usage_error", "Use "+taxAdjustmentsUsage, 2)
	}
	switch o.Args[2] {
	case "preview", "import":
		return r.runAdjustmentsFile(ctx, o, c, o.Args[2] == "import")
	}
	return r.localError(o, "usage_error", "Use "+taxAdjustmentsUsage, 2)
}

func (r Runner) runAdjustmentsFile(ctx context.Context, o Options, c *api.Client, importing bool) int {
	usage := taxAdjustmentsUsage
	if len(o.Args) != 4 {
		return r.localError(o, "usage_error", "Name the CSV file (or - for standard input). Use "+usage, 2)
	}
	if name, bad := flagsOutside(o); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+usage, 2)
	}
	csv, label, code := r.readAdjustmentFile(o, o.Args[3])
	if code != 0 {
		return code
	}
	input := map[string]any{"csv": csv, "fileName": label}
	response, err := c.Call(ctx, "taxAdjustments.preview", input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	var preview adjustmentPreview
	if err := json.Unmarshal(response.Data, &preview); err != nil {
		return r.localError(o, "export_failed", err.Error(), 4)
	}
	blocking := r.describePreview(preview)
	if !importing {
		if code := r.result(o, response, nil, ""); code != 0 {
			return code
		}
		if blocking > 0 {
			fmt.Fprintln(r.Diagnostics, "Nothing would be imported until these are fixed.")
			return 3
		}
		return 0
	}
	if blocking > 0 || preview.Counts.Invalid > 0 || preview.Counts.Conflict > 0 {
		_ = r.result(o, response, nil, "")
		fmt.Fprintln(r.Diagnostics, "Nothing was imported. Fix the problems above and run this again.")
		return 3
	}
	if preview.Counts.New == 0 {
		_ = r.result(o, response, nil, "")
		fmt.Fprintln(r.Diagnostics, "Every entry in the file was imported before, so nothing new was made.")
		return 0
	}
	input["previewHash"] = preview.PreviewHash
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for taxAdjustments.import; use operations requests or operations resume after interruption.\n", operationID)
	done, err := c.Call(ctx, "taxAdjustments.import", input, operationID)
	if err != nil {
		return r.result(o, done, err, "")
	}
	fmt.Fprintln(r.Diagnostics, "The entries are saved as drafts for you to review in the Journal. Nothing has been posted.")
	return r.result(o, done, nil, "")
}

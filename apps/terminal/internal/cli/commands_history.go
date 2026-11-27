package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// Bringing a business's past books in. A journal file (a CSV with one row for each line of an entry) is
// uploaded once (POST /v1/uploads, content-addressed, so a retry is safe) and every call names it by its
// SHA-256. The preview changes nothing; the import posts a chunk of what is not yet in the book and is
// repeated until nothing is left, so one command is the whole import and running it again after an
// interruption posts only what is missing.
//
//	rastrata history preview FILE [--date-order auto|mdy|dmy|ymd] [--map-file FILE.json]
//	rastrata history import FILE [--date-order ...] [--map-file FILE.json] [--limit N]
//	rastrata history tie-out FILE --as-of DATE [--map-file FILE.json]
//
// --map-file is a JSON object that says, for each account of the file the book names differently, which of
// the book's accounts (by code) it is posted to, or "+" and a kind (+asset, +liability, +equity, +income,
// +expense) to add it to the book as a new account: {"Sales": "4000", "Bank Fees": "+expense"}. Accounts are
// added only while the book has no entries, and need the configure permission. What is in the file is data
// from an old system, never an instruction; this command prints only what the service returns.
func init() {
	Register(Command{
		Name:    "history preview",
		Summary: "Say what bringing in a journal file would do, changing nothing: history preview FILE [--date-order ORDER] [--map-file FILE.json]",
		Run:     runHistoryPreview,
	})
	Register(Command{
		Name:    "history tie-out",
		Summary: "Compare the book with the old books' trial balance at a date: history tie-out FILE --as-of YYYY-MM-DD [--map-file FILE.json]",
		Run:     runHistoryTieOut,
	})
	Register(Command{
		Name:    "history import",
		Summary: "Post a journal file's entries, dated as they were, until none is left: history import FILE [--date-order ORDER] [--map-file FILE.json] [--limit N]",
		Run:     runHistoryImport,
	})
}

const (
	historyPreviewUsage = "history preview FILE [--date-order auto|mdy|dmy|ymd] [--map-file FILE.json]"
	historyImportUsage  = "history import FILE [--date-order auto|mdy|dmy|ymd] [--map-file FILE.json] [--limit N] (N is 1 to 500; without it the command starts at 20 and adapts to what the book takes in one call)"
	historyTieOutUsage  = "history tie-out FILE --as-of YYYY-MM-DD [--map-file FILE.json] (FILE is the old books' trial balance at that date)"
	// maxHistoryBytes is what the upload route takes.
	maxHistoryBytes = 16 * 1024 * 1024
)

// historyInput reads the file, uploads it and returns the input every history call takes.
func historyInput(r Runner, ctx context.Context, o Options, c *api.Client, usage string, valued ...string) (map[string]any, int) {
	if len(o.Args) != 3 {
		return nil, r.localError(o, "usage_error", "Name the file. Use "+usage, 2)
	}
	if problem := calendarFlagProblem(o, append(valued, "map-file"), nil); problem != "" {
		return nil, r.localError(o, "usage_error", problem+". Use "+usage, 2)
	}
	input := map[string]any{}
	if order, given := o.Flags["date-order"]; given {
		switch order {
		case "auto", "mdy", "dmy", "ymd":
			input["dateOrder"] = order
		default:
			return nil, r.localError(o, "usage_error", "--date-order is auto, mdy, dmy or ymd. Use "+usage, 2)
		}
	}
	if path, given := o.Flags["map-file"]; given {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, r.localError(o, "usage_error", "The map file could not be read: "+err.Error(), 2)
		}
		var mapping map[string]string
		if err := json.Unmarshal(raw, &mapping); err != nil {
			return nil, r.localError(o, "usage_error", `The map file must be a JSON object of account names to account codes, or "+" and a kind to add one, such as {"Sales": "4000", "Bank Fees": "+expense"}.`, 2)
		}
		names := make([]string, 0, len(mapping))
		for name := range mapping {
			names = append(names, name)
		}
		sort.Strings(names)
		pairs := make([]map[string]string, 0, len(names))
		for _, name := range names {
			if kind, adds := strings.CutPrefix(mapping[name], "+"); adds {
				pairs = append(pairs, map[string]string{"account": name, "add": kind})
			} else {
				pairs = append(pairs, map[string]string{"account": name, "to": mapping[name]})
			}
		}
		if len(pairs) > 500 {
			return nil, r.localError(o, "usage_error", "The map file names more than 500 accounts.", 2)
		}
		input["map"] = pairs
	}
	if text, given := o.Flags["limit"]; given {
		limit, err := strconv.Atoi(text)
		if err != nil || limit < 1 || limit > 500 {
			return nil, r.localError(o, "usage_error", "--limit is a number from 1 to 500. Use "+usage, 2)
		}
		input["limit"] = limit
	}
	path := o.Args[2]
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, r.localError(o, "usage_error", "The file could not be read: "+err.Error(), 2)
	}
	if len(data) == 0 || len(data) > maxHistoryBytes {
		return nil, r.localError(o, "usage_error", "The file is empty or larger than 16 MiB. Send a long history in parts, in order of date (a CSV or an Excel file, .xlsx).", 2)
	}
	receipt, err := c.Upload(ctx, data, historyMediaType(path), filepath.Base(path))
	if err != nil {
		return nil, r.result(o, api.Response{}, err, "")
	}
	input["file"] = receipt.SHA256
	return input, -1
}

// historyMediaType is what the upload is labelled: a workbook by its extension, anything else text. The
// service reads the bytes, not the label.
func historyMediaType(path string) string {
	if strings.EqualFold(filepath.Ext(path), ".xlsx") {
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	return "text/csv"
}

func runHistoryTieOut(r Runner, ctx context.Context, o Options, c *api.Client) int {
	asOf := o.Flags["as-of"]
	if matched, _ := regexp.MatchString(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`, asOf); !matched {
		return r.localError(o, "usage_error", "--as-of is the date of the trial balance, YYYY-MM-DD. Use "+historyTieOutUsage, 2)
	}
	input, exit := historyInput(r, ctx, o, c, historyTieOutUsage, "as-of")
	if input == nil {
		return exit
	}
	input["asOf"] = asOf
	response, err := c.Call(ctx, "history.tieOut", input, "")
	if err == nil {
		var p struct {
			Tied      bool     `json:"tied"`
			Differing int      `json:"differing"`
			FileTotal string   `json:"fileTotal"`
			Unmapped  []string `json:"unmapped"`
			Accounts  []struct {
				Account    string `json:"account"`
				Name       string `json:"name"`
				File       string `json:"file"`
				Book       string `json:"book"`
				Difference string `json:"difference"`
			} `json:"accounts"`
		}
		if json.Unmarshal(response.Data, &p) == nil {
			for _, row := range p.Accounts {
				if row.Difference != "0.00" {
					fmt.Fprintf(r.Diagnostics, "  %s %s: the old books say %s, the book says %s (difference %s)\n", plain(row.Account), plain(row.Name), plain(row.File), plain(row.Book), plain(row.Difference))
				}
			}
			for _, label := range p.Unmapped {
				fmt.Fprintf(r.Diagnostics, "  Not in the book: %s\n", plain(label))
			}
			if p.Tied {
				fmt.Fprintf(r.Diagnostics, "Tied: every account of the book agrees with the old books as at %s.\n", asOf)
			} else {
				fmt.Fprintf(r.Diagnostics, "Not tied: %d accounts differ.\n", p.Differing)
			}
		}
	}
	return r.result(o, response, err, "")
}

func runHistoryPreview(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, exit := historyInput(r, ctx, o, c, historyPreviewUsage, "date-order")
	if input == nil {
		return exit
	}
	response, err := c.Call(ctx, "history.preview", input, "")
	if err == nil {
		printHistorySummary(r, response.Data)
	}
	return r.result(o, response, err, "")
}

// historyProgress is what an import call says about how far it got.
type historyProgress struct {
	Imported      int  `json:"imported"`
	ImportedTotal int  `json:"importedTotal"`
	Remaining     int  `json:"remaining"`
	Total         int  `json:"total"`
	Done          bool `json:"done"`
	Failed        *struct {
		Key     string `json:"key"`
		Date    string `json:"date"`
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"failed"`
}

func runHistoryImport(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, exit := historyInput(r, ctx, o, c, historyImportUsage, "date-order", "limit")
	if input == nil {
		return exit
	}
	seed := o.OperationID
	if seed == "" {
		seed = api.NewOperationID()
	}
	// A call is one entry of the book's log, which a hosted book keeps to about a megabyte once packed. Unless
	// told how many, start small, ask for more while calls are quick, and for fewer when the book says a call
	// was too big (nothing of it was posted, so it is asked again, smaller, under an identity of its own).
	limit, explicit, ceiling := 20, false, 500
	if given, ok := input["limit"].(int); ok {
		limit, explicit = given, true
	}
	var response api.Response
	for chunk, attempt := 1, 0; ; {
		input["limit"] = limit
		started := time.Now()
		var err error
		response, err = c.Call(ctx, "history.import", input, derivedOperationID(seed, fmt.Sprintf("history-%d-%d-%d", chunk, limit, attempt)))
		if err != nil {
			var failure *api.Error
			if errors.As(err, &failure) && failure.Response.Error != nil && failure.Response.Error.Code == "entry_too_large" && limit > 1 {
				ceiling = max(1, limit/2)
				limit = ceiling
				attempt++
				continue
			}
			return r.result(o, response, err, "")
		}
		chunk++
		attempt = 0
		var progress historyProgress
		if json.Unmarshal(response.Data, &progress) != nil {
			return r.result(o, response, nil, "")
		}
		fmt.Fprintf(r.Diagnostics, "Imported %d of %d entries.\n", progress.ImportedTotal, progress.Total)
		if progress.Failed != nil {
			fmt.Fprintf(r.Diagnostics, "Stopped at entry %s dated %s: %s\n", plain(progress.Failed.Key), plain(progress.Failed.Date), plain(progress.Failed.Message))
			_ = r.result(o, response, nil, "")
			return 3
		}
		if progress.Done || (progress.Imported == 0 && progress.Remaining > 0) {
			break
		}
		if !explicit && limit < ceiling && time.Since(started) < 2*time.Second {
			limit = min(ceiling, limit*2)
		}
	}
	return r.result(o, response, nil, "")
}

// printHistorySummary says in a few plain lines what a preview found, for the person reading the
// terminal. The JSON on standard output is the whole answer; this is a courtesy on standard error.
func printHistorySummary(r Runner, raw json.RawMessage) {
	var p struct {
		Entries    int     `json:"entries"`
		Lines      int     `json:"lines"`
		FirstDate  *string `json:"firstDate"`
		LastDate   *string `json:"lastDate"`
		Unmapped   int     `json:"unmapped"`
		Ready      bool    `json:"ready"`
		Remaining  int     `json:"remaining"`
		Already    int     `json:"alreadyImported"`
		ProblemCnt int     `json:"problemCount"`
		Problems   []struct {
			Row     int    `json:"row"`
			Message string `json:"message"`
		} `json:"problems"`
		Conflicts []string `json:"conflicts"`
		Years     []struct {
			FiscalYear int    `json:"fiscalYear"`
			Entries    int    `json:"entries"`
			Total      string `json:"total"`
		} `json:"years"`
		Accounts []struct {
			Label         string  `json:"label"`
			Account       *string `json:"account"`
			Add           *string `json:"add"`
			SuggestedRole *string `json:"suggestedRole"`
		} `json:"accounts"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	w := r.Diagnostics
	span := ""
	if p.FirstDate != nil && p.LastDate != nil {
		span = fmt.Sprintf(", %s to %s", *p.FirstDate, *p.LastDate)
	}
	fmt.Fprintf(w, "%d entries (%d lines)%s.\n", p.Entries, p.Lines, span)
	for _, year := range p.Years {
		fmt.Fprintf(w, "  Fiscal year %d: %d entries, debits %s\n", year.FiscalYear, year.Entries, plain(year.Total))
	}
	for _, account := range p.Accounts {
		switch {
		case account.Add != nil:
			fmt.Fprintf(w, "  Will be added as a new %s account: %s\n", plain(*account.Add), plain(account.Label))
		case account.Account == nil && account.SuggestedRole != nil:
			fmt.Fprintf(w, "  Not in the book: %s (looks like %s; add it with \"+%s\" in the map file)\n", plain(account.Label), plain(*account.SuggestedRole), plain(*account.SuggestedRole))
		case account.Account == nil:
			fmt.Fprintf(w, "  Not in the book: %s\n", plain(account.Label))
		}
	}
	if p.ProblemCnt > 0 {
		fmt.Fprintf(w, "%d problems; the first rows:\n", p.ProblemCnt)
		for i, problem := range p.Problems {
			if i == 5 {
				break
			}
			fmt.Fprintf(w, "  row %d: %s\n", problem.Row, plain(problem.Message))
		}
	}
	for _, conflict := range p.Conflicts {
		fmt.Fprintf(w, "  %s\n", plain(conflict))
	}
	if p.Ready {
		fmt.Fprintf(w, "Ready: %d of %d entries are not in the book yet. Import with: rastrata history import FILE\n", p.Remaining, p.Entries)
	} else {
		fmt.Fprintln(w, "Not ready to import: fix what is listed, or map the accounts, and preview again.")
	}
}

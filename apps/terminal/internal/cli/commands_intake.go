package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The intake lane's commands: moving a business in from the raw files its owner has, driven by the
// owner's own agent. Everything here is deterministic and scriptable; no model is called.
//
//	rastrata intake scan FOLDER [--brief=true] [--record=false]
//
// The command reads the folder (the only place the lane touches the file system: see
// intake_walk.go), uploads each file to the content-addressed archive, and asks the service what
// each one is. Nothing is imported and no book is changed. The folder is a path the person typed;
// no path is ever taken from the contents of a file. File names and column headers in the answer
// are text from strangers, printed with control characters made visible, and never instructions.
const intakeUsage = "intake scan FOLDER [--brief=true] [--record=false]"

func init() {
	Register(Command{
		Name:    "intake scan",
		Summary: "Inventory a folder of the customer's files: kind by content, rows, dates, role guess. Reads only; imports nothing: intake scan FOLDER [--brief=true]",
		Run:     runIntakeScan,
	})
}

// intakeFlags is every option the intake commands understand and what kind of value it takes.
var intakeFlags = map[string]string{
	"brief": "bool", "record": "bool", "cutover": "text", "through": "text", "fresh": "bool",
	"gaps-only": "bool", "check": "bool", "kind": "text", "source": "text", "reason": "text",
	"key": "text", "note": "text", "status": "text", "page": "int",
}

func intakeOptions(flags map[string]string, allowed ...string) string {
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
		kind, known := intakeFlags[name]
		if !known || !permitted[name] {
			return "--" + name + " does not apply here"
		}
		value := flags[name]
		switch kind {
		case "bool":
			if value != "true" && value != "false" {
				return "--" + name + " is true or false; write --" + name + "=true"
			}
		case "int":
			if n, err := strconv.Atoi(value); err != nil || n < 1 {
				return "--" + name + " must be a whole number from 1"
			}
		default:
			if value == "" || value == "true" {
				return "--" + name + " needs a value"
			}
		}
	}
	return ""
}

// The limits of one scan: a folder of statements is a few dozen files, so these are generous and
// they are still limits.
var intakeWalkLimits = walkLimits{
	MaxFiles:      200,
	MaxDepth:      4,
	MaxFileBytes:  api.MaxUploadBytes,
	MaxTotalBytes: 128 * 1024 * 1024,
}

const scanBatch = 25

func intakeUsageError(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

func runIntakeScan(r Runner, ctx context.Context, o Options, c *api.Client) int {
	usage := func(problem string) int { return intakeUsageError(r, o, problem, intakeUsage) }
	if problem := intakeOptions(o.Flags, "brief", "record"); problem != "" {
		return usage(problem)
	}
	if len(o.Args) != 3 {
		return usage("Name the one folder to scan")
	}
	walked, err := walkFolder(o.Args[2], intakeWalkLimits)
	if err != nil {
		return r.localError(o, "input_unavailable", plain(err.Error()), 2)
	}
	if len(walked.Files) == 0 {
		return r.localError(o, "invalid_input", "The folder holds no file to scan ("+strconv.Itoa(len(walked.Skipped))+" skipped)", 2)
	}

	// Upload each file once, in name order. The archive is content addressed, so a file seen twice
	// is stored once and both paths name it.
	type placed struct {
		sha   string
		paths []string
	}
	order := []string{}
	byHash := map[string]*placed{}
	skipped := append([]skippedFile{}, walked.Skipped...)
	for _, file := range walked.Files {
		data, err := readWalked(file, api.MaxUploadBytes)
		if err != nil {
			skipped = append(skipped, skippedFile{Path: file.Rel, Reason: skipUnreadable, Size: file.Size})
			continue
		}
		receipt, err := c.Upload(ctx, data, "application/octet-stream", filepath.Base(file.Abs))
		if err != nil {
			return r.result(o, api.Response{}, err, "")
		}
		entry, seen := byHash[receipt.SHA256]
		if !seen {
			entry = &placed{sha: receipt.SHA256}
			byHash[receipt.SHA256] = entry
			order = append(order, receipt.SHA256)
		}
		entry.paths = append(entry.paths, plain(file.Rel))
	}
	for index := range skipped {
		skipped[index].Path = plain(skipped[index].Path)
	}

	// Ask what each is, a batch at a time; the service names what it left for another call.
	var files []json.RawMessage
	missing := []string{}
	totals := map[string]int{"files": 0, "bytes": 0, "parsed": 0, "needRecipe": 0, "needAgent": 0, "needHuman": 0}
	pending := order
	for round := 0; len(pending) > 0 && round < 20; round++ {
		batch := pending
		if len(batch) > scanBatch {
			batch = batch[:scanBatch]
		}
		response, err := c.Call(ctx, "intake.scan", map[string]any{"files": batch}, "")
		if err != nil {
			return r.result(o, response, err, "")
		}
		var page struct {
			Files    []json.RawMessage `json:"files"`
			Missing  []string          `json:"missing"`
			Deferred []string          `json:"deferred"`
			Totals   map[string]int    `json:"totals"`
		}
		if err := json.Unmarshal(response.Data, &page); err != nil {
			return r.localError(o, "client_error", err.Error(), 4)
		}
		files = append(files, page.Files...)
		missing = append(missing, page.Missing...)
		for key, value := range page.Totals {
			totals[key] += value
		}
		rest := append([]string{}, page.Deferred...)
		rest = append(rest, pending[len(batch):]...)
		pending = rest
	}

	brief := o.Flags["brief"] == "true"
	merged := make([]map[string]json.RawMessage, 0, len(files))
	for _, raw := range files {
		var file map[string]json.RawMessage
		if err := json.Unmarshal(raw, &file); err != nil {
			return r.localError(o, "client_error", err.Error(), 4)
		}
		var sha string
		_ = json.Unmarshal(file["sha256"], &sha)
		if entry, ok := byHash[sha]; ok {
			paths, _ := json.Marshal(entry.paths)
			file["paths"] = paths
		}
		if brief {
			for _, key := range []string{"columns", "statement", "accounts", "trialBalance", "summary", "details", "reasons", "encoding", "delimiter", "lineEnding", "headerRow"} {
				delete(file, key)
			}
		}
		merged = append(merged, file)
	}
	data, _ := json.Marshal(map[string]any{
		"folder":    plain(filepath.Base(walked.Root)),
		"limits":    map[string]any{"maxFiles": intakeWalkLimits.MaxFiles, "maxDepth": intakeWalkLimits.MaxDepth, "maxFileBytes": intakeWalkLimits.MaxFileBytes, "maxTotalBytes": intakeWalkLimits.MaxTotalBytes},
		"files":     merged,
		"missing":   missing,
		"skipped":   skipped,
		"truncated": walked.Truncated,
		"totals":    totals,
	})
	response := api.Response{Version: api.Version, BookID: c.BookID, OK: true, Data: data}
	if o.Flags["record"] != "false" {
		recordScanFriction(ctx, r, c, walked.Root, merged)
	}
	if o.Format == "text" {
		printScanTable(r.Output, merged, skipped, walked.Truncated)
		return 0
	}
	return r.result(o, response, nil, "")
}

// recordScanFriction logs the scan, and each file that needs someone: an agent for a file the
// program does not read, a recipe for a layout it cannot read alone.
func recordScanFriction(ctx context.Context, r Runner, c *api.Client, root string, files []map[string]json.RawMessage) {
	events := []frictionEvent{{
		Kind:   "scan",
		Source: plain(filepath.Base(root)),
		Reason: fmt.Sprintf("scanned %d files", len(files)),
	}}
	for _, file := range files {
		sha := stringField(file, "sha256")
		switch stringField(file, "need") {
		case "agent":
			events = append(events, frictionEvent{Kind: "file_not_parsed", Source: shortHash(sha), Reason: "the program does not read this " + stringField(file, "kind") + " file: it needs an agent", Key: "file:" + sha + ":agent"})
		case "recipe":
			events = append(events, frictionEvent{Kind: "recipe_needed", Source: shortHash(sha), Reason: "this " + stringField(file, "kind") + " file is not read correctly without a recipe", Key: "file:" + sha + ":recipe"})
		}
	}
	for start := 0; start < len(events); start += 50 {
		end := start + 50
		if end > len(events) {
			end = len(events)
		}
		recordFriction(ctx, r, c, events[start:end], nil, "")
	}
}

func stringField(file map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(file[key], &value)
	return value
}

// printScanTable is the scan for a person at a terminal: one line a file.
func printScanTable(w io.Writer, files []map[string]json.RawMessage, skipped []skippedFile, truncated bool) {
	table := tabwriter.NewWriter(w, 2, 0, 2, ' ', 0)
	fmt.Fprintln(table, "ID\tKIND\tROLE\tNEEDS\tROWS\tFROM\tTO\tFLAGS\tPATH")
	for _, file := range files {
		sha := stringField(file, "sha256")
		if len(sha) > 8 {
			sha = sha[:8]
		}
		role := stringField(file, "role")
		if stringField(file, "confidence") == "low" {
			role += "?"
		}
		var rows int
		_ = json.Unmarshal(file["rows"], &rows)
		var span struct{ From, To string }
		_ = json.Unmarshal(file["range"], &span)
		var flags []string
		_ = json.Unmarshal(file["flags"], &flags)
		var paths []string
		_ = json.Unmarshal(file["paths"], &paths)
		rowText := "-"
		if file["rows"] != nil {
			rowText = strconv.Itoa(rows)
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", sha, stringField(file, "kind"), role,
			stringField(file, "need"), rowText, dash(span.From), dash(span.To), dash(strings.Join(flags, ",")), strings.Join(paths, " = "))
	}
	_ = table.Flush()
	for _, item := range skipped {
		fmt.Fprintf(w, "skipped %s: %s\n", item.Reason, item.Path)
	}
	if truncated {
		fmt.Fprintln(w, "The folder holds more files than one scan takes; scan a smaller folder for the rest.")
	}
}

func dash(text string) string {
	if text == "" {
		return "-"
	}
	return text
}

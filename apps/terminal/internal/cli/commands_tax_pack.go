package cli

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The year-end pack. The service builds every file (a package of figures that all come from one
// book revision, with a manifest of hashes); this command only writes them where the person says: a
// folder, or a zip if the name ends in .zip. It refuses to write into a folder that already holds
// files, and it never trusts a path the service returned: a name with "..", a drive, a backslash or
// a leading slash is an error, not a file.
//
//	rastrata tax pack --year YYYY --out PATH [--form scheduleC|form1120S|form1065] [--from DATE] [--to DATE]
//	                  [--meals-percent N] [--revision N] [--tags-revision N]
//	rastrata tax verify-pack PATH        (offline: checks the files against manifest.json)
func init() {
	Register(Command{
		Name: "tax pack",
		Summary: "Write the year-end pack to a folder or .zip: tax pack --year YYYY --out PATH " +
			"[--form scheduleC|form1120S|form1065] [--from DATE --to DATE] [--meals-percent N]",
		Run: runTaxPack,
	})
	Register(Command{
		Name: "tax cpa-packet",
		Summary: "Write the unified CPA hand-off packet (statements, tax worksheet, 1099s, chart, journal, reconciliations, changes and adjusting entries template) to a folder or .zip: tax cpa-packet --year YYYY --out PATH " +
			"[--form scheduleC|form1120S|form1065] [--from DATE --to DATE] [--meals-percent N]",
		Run: runTaxCpaPacket,
	})
	Register(Command{
		Name:    "tax verify-pack",
		Summary: "Check a pack's files against its manifest, offline: tax verify-pack PATH (a folder or .zip)",
		Offline: true,
		Run:     runTaxVerifyPack,
	})
}

const taxPackUsage = "tax pack --year YYYY --out PATH [--form scheduleC|form1120S|form1065] [--from YYYY-MM-DD] [--to YYYY-MM-DD] " +
	"[--meals-percent 0-100] [--revision N] [--tags-revision N]"
const taxCpaPacketUsage = "tax cpa-packet --year YYYY --out PATH [--form scheduleC|form1120S|form1065] [--from YYYY-MM-DD] [--to YYYY-MM-DD] " +
	"[--meals-percent 0-100] [--revision N] [--tags-revision N]"

// packFile is one file of the pack as the service returns it.
type packFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	SHA256  string `json:"sha256"`
}

type packResult struct {
	Folder         string     `json:"folder"`
	Files          []packFile `json:"files"`
	ManifestSHA256 string     `json:"manifestSha256"`
	Checks         []struct {
		Status string `json:"status"`
	} `json:"checks"`
	// Close is whether the books for the range are closed, in the calendar's own words; the pack ties
	// itself to the last current close and says so when it is not closed.
	Close struct {
		State     string `json:"state"`
		Statement string `json:"statement"`
	} `json:"close"`
}

// safePackPath turns a path from the service into one that stays inside the destination, or fails.
func safePackPath(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "\\\x00:") || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("unsafe file name %q", name)
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("unsafe file name %q", name)
		}
	}
	return name, nil
}

// zipTime is the same for every entry, so a pack built twice from the same book is the same zip.
var zipTime = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

func writePackZip(destination, folder string, files []packFile) error {
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	archive := zip.NewWriter(out)
	for _, file := range files {
		name, err := safePackPath(file.Path)
		if err != nil {
			_ = archive.Close()
			_ = out.Close()
			_ = os.Remove(destination)
			return err
		}
		header := &zip.FileHeader{Name: path.Join(folder, name), Method: zip.Store, Modified: zipTime}
		header.SetMode(0o644)
		writer, err := archive.CreateHeader(header)
		if err == nil {
			_, err = io.WriteString(writer, file.Content)
		}
		if err != nil {
			_ = archive.Close()
			_ = out.Close()
			_ = os.Remove(destination)
			return err
		}
	}
	if err := archive.Close(); err != nil {
		_ = out.Close()
		_ = os.Remove(destination)
		return err
	}
	return out.Close()
}

func writePackFolder(destination string, files []packFile) error {
	if entries, err := os.ReadDir(destination); err == nil && len(entries) > 0 {
		return fmt.Errorf("%s already holds files; choose a new folder name", destination)
	}
	for _, file := range files {
		name, err := safePackPath(file.Path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func runTaxPack(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax pack takes only options. Use "+taxPackUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "out", "form", "from", "to", "meals-percent", "tags-revision"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxPackUsage, 2)
	}
	if !rejectBareFlags(r, o, taxPackUsage, "out", "form", "from", "to", "meals-percent", "tags-revision") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxPackUsage)
	if !ok {
		return 2
	}
	destination := o.Flags["out"]
	if destination == "" {
		return r.localError(o, "usage_error", "--out PATH is required: a new folder, or a name ending in .zip. Use "+taxPackUsage, 2)
	}
	input := taxInput(o, year)
	if percent, given, ok := mealsPercentFlag(r, o, taxPackUsage); !ok {
		return 2
	} else if given {
		input["mealsPercent"] = percent
	}
	return r.writePack(ctx, o, c, "taxPack.build", input, destination, "pack")
}

func runTaxCpaPacket(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "tax cpa-packet takes only options. Use "+taxCpaPacketUsage, 2)
	}
	if name, bad := flagsOutside(o, "year", "out", "form", "from", "to", "meals-percent", "tags-revision"); bad {
		return r.localError(o, "usage_error", "unknown option --"+name+". Use "+taxCpaPacketUsage, 2)
	}
	if !rejectBareFlags(r, o, taxCpaPacketUsage, "out", "form", "from", "to", "meals-percent", "tags-revision") {
		return 2
	}
	year, ok := taxYearFlag(r, o, taxCpaPacketUsage)
	if !ok {
		return 2
	}
	destination := o.Flags["out"]
	if destination == "" {
		return r.localError(o, "usage_error", "--out PATH is required: a new folder, or a name ending in .zip. Use "+taxCpaPacketUsage, 2)
	}
	input := taxInput(o, year)
	if percent, given, ok := mealsPercentFlag(r, o, taxCpaPacketUsage); !ok {
		return 2
	} else if given {
		input["mealsPercent"] = percent
	}
	return r.writePack(ctx, o, c, "taxCpaPacket.build", input, destination, "CPA packet")
}

// writePack asks the service for a pack (the year-end pack or the accountant pack: the same shape of
// files and manifest) and writes it where the person said, a folder or a .zip. It refuses a destination
// that cannot be written before asking the service for anything.
func (r Runner) writePack(ctx context.Context, o Options, c *api.Client, operation string, input map[string]any, destination, what string) int {
	asZip := strings.HasSuffix(strings.ToLower(destination), ".zip")
	if _, err := os.Stat(destination); err == nil && asZip {
		return r.localError(o, "usage_error", destination+" already exists; choose a new name", 2)
	}
	response, err := c.Call(ctx, operation, input, "")
	if err != nil {
		return r.result(o, response, err, "")
	}
	var pack packResult
	if err := json.Unmarshal(response.Data, &pack); err != nil {
		return r.localError(o, "export_failed", err.Error(), 4)
	}
	if asZip {
		err = writePackZip(destination, pack.Folder, pack.Files)
	} else {
		err = writePackFolder(destination, pack.Files)
	}
	if err != nil {
		return r.localError(o, "export_failed", err.Error(), 4)
	}
	attention := 0
	for _, check := range pack.Checks {
		if check.Status != "ok" {
			attention++
		}
	}
	summary, _ := json.Marshal(map[string]any{
		"written": destination, "files": len(pack.Files), "manifestSha256": pack.ManifestSHA256, "checksToLookAt": attention,
		"booksClosed": pack.Close.State,
	})
	fmt.Fprintf(r.Diagnostics, "Wrote %d files to %s. Rastrata books and reports; this %s is not tax advice and files nothing.\n", len(pack.Files), destination, what)
	if pack.Close.Statement != "" {
		fmt.Fprintf(r.Diagnostics, "%s\n", pack.Close.Statement)
	}
	if attention > 0 {
		fmt.Fprintf(r.Diagnostics, "%d checks need a look before you rely on it; they are listed in README.md.\n", attention)
	}
	return r.result(o, api.Response{Version: api.Version, BookID: c.BookID, OK: true, Data: summary}, nil, "")
}

// manifest is the part of manifest.json that verification reads.
type manifest struct {
	Format string `json:"format"`
	Files  []struct {
		Path   string `json:"path"`
		Bytes  int    `json:"bytes"`
		SHA256 string `json:"sha256"`
	} `json:"files"`
}

// readPack reads every file of a pack folder or zip into memory, by relative path.
func readPack(location string) (map[string][]byte, error) {
	files := map[string][]byte{}
	info, err := os.Stat(location)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		err = filepath.WalkDir(location, func(file string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil || entry.IsDir() {
				return walkErr
			}
			relative, err := filepath.Rel(location, file)
			if err != nil {
				return err
			}
			data, err := os.ReadFile(file)
			files[filepath.ToSlash(relative)] = data
			return err
		})
		return files, err
	}
	archive, err := zip.OpenReader(location)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	var prefix string
	for _, entry := range archive.File {
		if strings.HasSuffix(entry.Name, "/") {
			continue
		}
		if strings.HasSuffix(entry.Name, "manifest.json") && (prefix == "" || len(entry.Name) < len(prefix)+len("manifest.json")) {
			prefix = strings.TrimSuffix(entry.Name, "manifest.json")
		}
	}
	for _, entry := range archive.File {
		if strings.HasSuffix(entry.Name, "/") || !strings.HasPrefix(entry.Name, prefix) {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(reader, 1<<30))
		_ = reader.Close()
		if err != nil {
			return nil, err
		}
		files[strings.TrimPrefix(entry.Name, prefix)] = data
	}
	return files, nil
}

func runTaxVerifyPack(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 3 || len(o.Flags) > 0 {
		return r.localError(o, "usage_error", "Use tax verify-pack PATH (a pack folder or .zip)", 2)
	}
	files, err := readPack(o.Args[2])
	if err != nil {
		return r.localError(o, "verify_failed", err.Error(), 4)
	}
	raw, present := files["manifest.json"]
	var m manifest
	if !present || json.Unmarshal(raw, &m) != nil || m.Format == "" {
		return r.localError(o, "verify_failed", "No readable manifest.json: this is not a Rastrata year-end pack", 3)
	}
	type problem struct {
		Path   string `json:"path"`
		Reason string `json:"reason"`
	}
	problems := []problem{}
	listed := map[string]bool{"manifest.json": true}
	for _, entry := range m.Files {
		listed[entry.Path] = true
		data, found := files[entry.Path]
		if !found {
			problems = append(problems, problem{entry.Path, "missing"})
			continue
		}
		digest := sha256.Sum256(data)
		if hex.EncodeToString(digest[:]) != entry.SHA256 || len(data) != entry.Bytes {
			problems = append(problems, problem{entry.Path, "changed since the pack was written"})
		}
	}
	extra := []string{}
	for name := range files {
		if !listed[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	for _, name := range extra {
		problems = append(problems, problem{name, "not listed in the manifest"})
	}
	result, _ := json.Marshal(map[string]any{"checked": len(m.Files), "ok": len(problems) == 0, "problems": problems})
	response := api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: result}
	_ = json.NewEncoder(r.Output).Encode(response)
	if len(problems) > 0 {
		fmt.Fprintln(r.Diagnostics, errors.New("the pack does not match its manifest"))
		return 3
	}
	return 0
}

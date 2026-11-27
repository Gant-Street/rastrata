package cli

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

func sum(content string) string {
	digest := sha256.Sum256([]byte(content))
	return hex.EncodeToString(digest[:])
}

// packJSON is a year-end pack as the service returns it: the files, with the manifest last.
func packJSON(t *testing.T, files map[string]string, order []string) string {
	t.Helper()
	listed := []map[string]any{}
	manifestFiles := []map[string]any{}
	for _, name := range order {
		content := files[name]
		listed = append(listed, map[string]any{
			"path": name, "mediaType": "text/csv; charset=utf-8", "description": "A file.",
			"bytes": len(content), "sha256": sum(content), "content": content,
		})
		if name != "manifest.json" {
			manifestFiles = append(manifestFiles, map[string]any{"path": name, "bytes": len(content), "sha256": sum(content)})
		}
	}
	manifest, _ := json.Marshal(map[string]any{"format": "rastrata-year-end-pack-v1", "files": manifestFiles})
	for index, entry := range listed {
		if entry["path"] == "manifest.json" {
			entry["content"] = string(manifest)
			entry["bytes"] = len(manifest)
			entry["sha256"] = sum(string(manifest))
			listed[index] = entry
		}
	}
	pack := map[string]any{
		"format": "rastrata-year-end-pack-v1", "folder": "rastrata-year-end-2025", "taxYear": 2025,
		"form": map[string]any{"id": "scheduleC", "name": "Schedule C (Form 1040)", "subject": "Profit or Loss From Business",
			"taxYear": 2025, "status": "final", "verifiedOn": "2026-10-03", "sources": []any{}},
		"from": "2025-01-01", "to": "2025-12-31", "bookRevision": "9",
		"ledgerPopulationHash": taxHash, "worksheetPopulationHash": taxHash, "tagMapHash": taxHash,
		"files": listed, "manifestSha256": sum(string(manifest)),
		"close": map[string]any{"state": "open", "periods": 12, "closed": 0, "superseded": 0, "open": 12, "last": nil,
			"statement": "No period in this range is closed, so the books for it can still change."},
		"checks":   []any{map[string]any{"key": "inbox", "status": "attention", "title": "Inbox lines", "detail": "2 lines are waiting."}},
		"warnings": []any{}, "disclaimer": "Not tax advice.",
	}
	encoded, err := json.Marshal(pack)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

var packFiles = map[string]string{
	"README.md":                      "# Pack\n",
	"statements/profit-and-loss.csv": "Report,Profit and loss\r\n",
	"tax/schedule-c-worksheet.csv":   "Part,Line\r\n",
	"manifest.json":                  "",
}
var packOrder = []string{"README.md", "statements/profit-and-loss.csv", "tax/schedule-c-worksheet.csv", "manifest.json"}

func TestTaxPackWritesAFolderAndSummarises(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxPack.build": packJSON(t, packFiles, packOrder)}, &sent)
	destination := filepath.Join(t.TempDir(), "pack-2025")
	exit, out, diagnostics := runTax(t, server, "tax", "pack", "--year", "2025", "--out", destination, "--meals-percent", "80")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("pack failed: %d %s %s", exit, out, diagnostics)
	}
	for _, name := range packOrder {
		data, err := os.ReadFile(filepath.Join(destination, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
		if name != "manifest.json" && string(data) != packFiles[name] {
			t.Fatalf("%s was changed on the way to disk: %q", name, data)
		}
	}
	if !strings.Contains(out, `"files":4`) || !strings.Contains(out, `"checksToLookAt":1`) {
		t.Fatalf("summary wrong: %s", out)
	}
	if !strings.Contains(out, `"booksClosed":"open"`) || !strings.Contains(diagnostics, "No period in this range is closed") {
		t.Fatalf("how final the pack is must be said: %s %q", out, diagnostics)
	}
	if !strings.Contains(diagnostics, "not tax advice") || !strings.Contains(diagnostics, "1 checks need a look") {
		t.Fatalf("the notice and the checks must be said: %q", diagnostics)
	}
	var input map[string]any
	_ = json.Unmarshal(sent[0].Input, &input)
	if input["taxYear"] != float64(2025) || input["mealsPercent"] != float64(80) {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestTaxPackWritesAZipThatHoldsTheSameBytesEveryTime(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxPack.build": packJSON(t, packFiles, packOrder)}, &sent)
	dir := t.TempDir()
	first := filepath.Join(dir, "first.zip")
	second := filepath.Join(dir, "second.zip")
	for _, destination := range []string{first, second} {
		exit, out, _ := runTax(t, server, "tax", "pack", "--year", "2025", "--out", destination)
		if exit != 0 {
			t.Fatalf("zip failed: %d %s", exit, out)
		}
	}
	a, _ := os.ReadFile(first)
	b, _ := os.ReadFile(second)
	if string(a) != string(b) {
		t.Fatal("the same pack must give the same zip, byte for byte")
	}
	archive, err := zip.OpenReader(first)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	names := []string{}
	for _, entry := range archive.File {
		names = append(names, entry.Name)
		if !strings.HasPrefix(entry.Name, "rastrata-year-end-2025/") {
			t.Fatalf("every file belongs in the top-level folder: %s", entry.Name)
		}
		if entry.Method != zip.Store {
			t.Fatalf("%s is compressed; the pack stores files plainly", entry.Name)
		}
		reader, _ := entry.Open()
		data, _ := io.ReadAll(reader)
		_ = reader.Close()
		want := packFiles[strings.TrimPrefix(entry.Name, "rastrata-year-end-2025/")]
		if want != "" && string(data) != want {
			t.Fatalf("%s changed in the zip", entry.Name)
		}
	}
	if len(names) != 4 {
		t.Fatalf("expected 4 files, got %v", names)
	}
}

func TestTaxPackRefusesToWriteOverExistingFilesAndNeverTrustsAPath(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxPack.build": packJSON(t, packFiles, packOrder)}, &sent)
	dir := t.TempDir()
	// A folder that already holds something is not written into.
	taken := filepath.Join(dir, "taken")
	_ = os.MkdirAll(taken, 0o755)
	_ = os.WriteFile(filepath.Join(taken, "mine.txt"), []byte("keep"), 0o644)
	exit, out, _ := runTax(t, server, "tax", "pack", "--year", "2025", "--out", taken)
	if exit != 4 || !strings.Contains(out, "already holds files") {
		t.Fatalf("expected a refusal: %d %s", exit, out)
	}
	if data, _ := os.ReadFile(filepath.Join(taken, "mine.txt")); string(data) != "keep" {
		t.Fatal("the existing file was touched")
	}
	// An existing zip is not replaced, and the service is not asked.
	existing := filepath.Join(dir, "old.zip")
	_ = os.WriteFile(existing, []byte("old"), 0o644)
	before := len(sent)
	exit, _, _ = runTax(t, server, "tax", "pack", "--year", "2025", "--out", existing)
	if exit != 2 || len(sent) != before {
		t.Fatalf("an existing zip must be refused before calling the service: %d", exit)
	}
	// A path that leaves the destination is an error, not a file.
	for _, bad := range []string{"../escape.csv", "/etc/passwd", "a/../../b", "a\\b", "", "dir//file"} {
		files := map[string]string{bad: "x", "manifest.json": ""}
		hostile := taxServer(t, map[string]string{"taxPack.build": packJSON(t, files, []string{bad, "manifest.json"})}, &sent)
		destination := filepath.Join(t.TempDir(), "out")
		exit, _, _ := runTax(t, hostile, "tax", "pack", "--year", "2025", "--out", destination)
		if exit == 0 {
			t.Fatalf("path %q was accepted", bad)
		}
		if _, err := os.Stat(filepath.Join(filepath.Dir(destination), "escape.csv")); err == nil {
			t.Fatal("a file was written outside the destination")
		}
	}
}

func TestTaxPackRefusesWhatCannotBeRightWithoutCallingTheService(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxPack.build": packJSON(t, packFiles, packOrder)}, &sent)
	cases := map[string][]string{
		"no year":       {"tax", "pack", "--out", "x"},
		"no out":        {"tax", "pack", "--year", "2025"},
		"bare out":      {"tax", "pack", "--year", "2025", "--out"},
		"bad percent":   {"tax", "pack", "--year", "2025", "--out", "x", "--meals-percent", "300"},
		"unknown":       {"tax", "pack", "--year", "2025", "--out", "x", "--zip"},
		"extra word":    {"tax", "pack", "now", "--year", "2025", "--out", "x"},
		"verify no arg": {"tax", "verify-pack"},
	}
	for name, args := range cases {
		exit, out, _ := runTax(t, server, args...)
		if exit != 2 || !strings.Contains(out, "usage_error") {
			t.Errorf("%s: expected a usage error, got %d %s", name, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a refused command must not call the service, sent %d", len(sent))
	}
}

func TestTaxVerifyPackFindsAChangedMissingAndExtraFile(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"taxPack.build": packJSON(t, packFiles, packOrder)}, &sent)
	dir := t.TempDir()
	folder := filepath.Join(dir, "pack")
	if exit, out, _ := runTax(t, server, "tax", "pack", "--year", "2025", "--out", folder); exit != 0 {
		t.Fatalf("pack failed: %s", out)
	}
	// A whole pack verifies, as a folder and as a zip, with no service at all.
	exit, out, _ := runTax(t, "http://127.0.0.1:1", "tax", "verify-pack", folder)
	if exit != 0 || !strings.Contains(out, `"ok":true`) || !strings.Contains(out, `"checked":3`) {
		t.Fatalf("a whole pack must verify: %d %s", exit, out)
	}
	zipped := filepath.Join(dir, "pack.zip")
	if exit, out, _ := runTax(t, server, "tax", "pack", "--year", "2025", "--out", zipped); exit != 0 {
		t.Fatalf("zip failed: %s", out)
	}
	if exit, out, _ := runTax(t, "http://127.0.0.1:1", "tax", "verify-pack", zipped); exit != 0 || !strings.Contains(out, `"ok":true`) {
		t.Fatalf("a whole zip must verify: %d %s", exit, out)
	}
	// Change one file, remove another, add a third.
	_ = os.WriteFile(filepath.Join(folder, "README.md"), []byte("# Edited\n"), 0o644)
	_ = os.Remove(filepath.Join(folder, "statements", "profit-and-loss.csv"))
	_ = os.WriteFile(filepath.Join(folder, "notes.txt"), []byte("extra"), 0o644)
	exit, out, _ = runTax(t, "http://127.0.0.1:1", "tax", "verify-pack", folder)
	if exit != 3 || !strings.Contains(out, `"ok":false`) {
		t.Fatalf("a changed pack must fail: %d %s", exit, out)
	}
	for _, want := range []string{"changed since the pack was written", "missing", "not listed in the manifest", "README.md", "notes.txt"} {
		if !strings.Contains(out, want) {
			t.Errorf("the problem list must say %q: %s", want, out)
		}
	}
	// Something that is not a pack is said not to be.
	empty := t.TempDir()
	if exit, out, _ := runTax(t, "http://127.0.0.1:1", "tax", "verify-pack", empty); exit != 3 || !strings.Contains(out, "not a Rastrata year-end pack") {
		t.Fatalf("a folder without a manifest must be refused: %d %s", exit, out)
	}
}

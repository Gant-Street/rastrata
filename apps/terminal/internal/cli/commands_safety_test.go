package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const zeroHash = "0000000000000000000000000000000000000000000000000000000000000000"
const backupRecord = `{"id":"20261003T181500Z-00000004-1a2b3c4d","createdAt":"2026-10-03T18:15:00.000Z","reason":"manual","fileName":"20261003T181500Z-00000004-1a2b3c4d.sqlite","bytes":4096,"sha256":"` + zeroHash + `","head":{"sequence":"4","bookRevision":"4","chainHash":"` + zeroHash + `"},"bookName":"Co","currency":"USD","release":"0.1.0","schemaVersion":"core 1","fileState":"present","verification":null}`

// jobServer answers a long operation: "running" for the first `running` calls, then the finished job.
// It records every request so a test can check the identity is the same each time.
func jobServer(t *testing.T, operation string, running int, finished string, ids *[]string) string {
	t.Helper()
	var mutex sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		mutex.Lock()
		calls++
		n := calls
		*ids = append(*ids, request.OperationID)
		mutex.Unlock()
		if r.URL.Path != "/v1/"+operation {
			w.WriteHeader(404)
			return
		}
		data := finished
		if n <= running {
			data = `{"state":"running","kind":"verify","startedAt":"2026-10-03T18:15:00.000Z","stage":"Replaying the ledger","done":340,"total":1200,"elapsedMs":9000,"remainingMs":31000}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "operationId": request.OperationID, "data": json.RawMessage(data)})
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runSafety(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Output: &out, Diagnostics: &diagnostics}
	all := append(args, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func TestBackupVerifyKeepsAskingWithOneIdentityAndShowsProgress(t *testing.T) {
	var ids []string
	finished := `{"state":"done","kind":"verify","startedAt":"2026-10-03T18:15:00.000Z","finishedAt":"2026-10-03T18:15:30.000Z","stage":"Finished","done":1200,"total":1200,"elapsedMs":30000,"remainingMs":null,"verification":{"backupId":"20261003T181500Z-00000004-1a2b3c4d","verifiedAt":"2026-10-03T18:15:30.000Z","passed":true,"durationMs":30000,"replayMs":28000,"outcomes":1200,"journals":1199,"head":{"sequence":"1200","bookRevision":"1200","chainHash":"` + zeroHash + `"},"checks":[{"code":"file_sha256","status":"passed","message":"ok"}]}}`
	server := jobServer(t, "backup.verify", 2, finished, &ids)
	exit, out, diagnostics := runSafety(t, server, "backup", "verify")
	if exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	if len(ids) != 3 || ids[0] == "" || ids[0] != ids[1] || ids[1] != ids[2] {
		t.Fatalf("every ask must carry the same operation identity: %v", ids)
	}
	if !strings.Contains(diagnostics, "Replaying the ledger: 340 of 1200 (28%), about 31 s left (an estimate") {
		t.Fatalf("no progress with an honest estimate: %s", diagnostics)
	}
	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			State        string `json:"state"`
			Verification struct{ Passed bool }
		}
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &envelope); err != nil || !envelope.OK || envelope.Data.State != "done" || !envelope.Data.Verification.Passed {
		t.Fatalf("final answer is one envelope: %s", out)
	}
}

func TestBackupVerifyThatDoesNotPassExitsWithRejection(t *testing.T) {
	var ids []string
	finished := `{"state":"done","kind":"verify","startedAt":"2026-10-03T18:15:00.000Z","finishedAt":"2026-10-03T18:15:01.000Z","stage":"Finished","done":null,"total":null,"elapsedMs":1000,"remainingMs":null,"verification":{"backupId":"20261003T181500Z-00000004-1a2b3c4d","verifiedAt":"2026-10-03T18:15:01.000Z","passed":false,"durationMs":1000,"replayMs":null,"outcomes":0,"journals":0,"head":null,"checks":[{"code":"file_sha256","status":"failed","message":"The file does not match its manifest"}]}}`
	server := jobServer(t, "backup.verify", 0, finished, &ids)
	exit, out, _ := runSafety(t, server, "backup", "verify", "20261003T181500Z-00000004-1a2b3c4d")
	if exit != 3 || !strings.Contains(out, `"passed":false`) {
		t.Fatalf("a failed verification must exit 3 and say why: %d %s", exit, out)
	}
}

func TestBackupDrillFailureAndJobFailureExitWithRejection(t *testing.T) {
	var ids []string
	failed := `{"state":"failed","kind":"backup","startedAt":"2026-10-03T18:15:00.000Z","finishedAt":"2026-10-03T18:15:01.000Z","stage":"Stopped","done":null,"total":null,"elapsedMs":1000,"remainingMs":null,"error":{"code":"backup_no_space","message":"There is not enough free space"}}`
	server := jobServer(t, "backup.create", 0, failed, &ids)
	exit, out, _ := runSafety(t, server, "backup", "create")
	if exit != 3 || !strings.Contains(out, "backup_no_space") {
		t.Fatalf("a failed job exits 3: %d %s", exit, out)
	}
}

func TestBackupCreateReturnsTheBackup(t *testing.T) {
	var ids []string
	finished := `{"state":"done","kind":"backup","startedAt":"2026-10-03T18:15:00.000Z","finishedAt":"2026-10-03T18:15:01.000Z","stage":"Finished","done":null,"total":null,"elapsedMs":900,"remainingMs":null,"backup":` + backupRecord + `}`
	server := jobServer(t, "backup.create", 0, finished, &ids)
	exit, out, _ := runSafety(t, server, "backup", "create")
	if exit != 0 || !strings.Contains(out, "20261003T181500Z-00000004-1a2b3c4d") {
		t.Fatalf("backup create: %d %s", exit, out)
	}
}

func TestBackupStatusAndListAreReadsThroughTheCatalog(t *testing.T) {
	var sent []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent = append(sent, r.URL.Path)
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		data := `{"directory":"/data/backups","backups":[` + backupRecord + `],"unrecorded":[]}`
		if r.URL.Path == "/v1/export.list" {
			data = `{"directory":"/data/exports","exports":[]}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "data": json.RawMessage(data)})
	}))
	t.Cleanup(server.Close)
	for _, words := range [][]string{{"backup", "list"}, {"export", "list"}} {
		exit, out, _ := runSafety(t, server.URL, words...)
		if exit != 0 || !strings.Contains(out, `"ok":true`) {
			t.Fatalf("%v: %d %s", words, exit, out)
		}
	}
	if len(sent) != 2 || sent[0] != "/v1/backup.list" || sent[1] != "/v1/export.list" {
		t.Fatalf("unexpected requests %v", sent)
	}
}

func TestRestoreRejectsMisuseBeforeRunningAnything(t *testing.T) {
	t.Setenv("RASTRATA_TOOL", "/nonexistent/tool-that-must-not-run")
	for _, args := range [][]string{
		{"restore"},
		{"restore", "latest"},
		{"restore", "latest", "--to"},
		{"restore", "latest", "--to", "x.sqlite", "--bogus"},
		{"restore", "--replace", "latest", "--to", "x.sqlite"},
		{"restore", "latest", "--to", "x.sqlite", "--quick=maybe"},
		{"import-export", "dir"},
		{"export", "verify"},
	} {
		var out, diagnostics bytes.Buffer
		exit := Runner{Output: &out, Diagnostics: &diagnostics}.Run(context.Background(), args)
		if exit != 2 || !strings.Contains(out.String(), "usage_error") {
			t.Fatalf("%v: exit %d %s", args, exit, out.String())
		}
	}
}

// fakeTool writes a shell script that prints its arguments as a JSON envelope and exits with `code`.
func fakeTool(t *testing.T, code string) string {
	t.Helper()
	script := filepath.Join(t.TempDir(), "tool.sh")
	body := "#!/bin/sh\necho \"progress: $*\" >&2\nprintf '{\"ok\":true,\"args\":\"%s\"}\\n' \"$*\"\nexit " + code + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script
}

func TestRestoreRunsTheToolWithItsArgumentsAndPassesItsExitCodeThrough(t *testing.T) {
	for _, code := range []string{"0", "3", "4"} {
		t.Setenv("RASTRATA_TOOL", fakeTool(t, code))
		var out, diagnostics bytes.Buffer
		exit := Runner{Output: &out, Diagnostics: &diagnostics}.Run(context.Background(),
			[]string{"restore", "latest", "--to", "/data/book.sqlite", "--replace", "--quick", "--backup-dir", "/backups"})
		if strconvAtoi(code) != exit {
			t.Fatalf("exit %d, want %s", exit, code)
		}
		if !strings.Contains(out.String(), `"args":"restore latest --to /data/book.sqlite --replace --quick --backup-dir /backups"`) {
			t.Fatalf("arguments not passed through: %s", out.String())
		}
		if !strings.Contains(diagnostics.String(), "progress: restore latest") {
			t.Fatalf("the tool's progress must reach stderr: %s", diagnostics.String())
		}
	}
}

func strconvAtoi(value string) int {
	n := 0
	for _, digit := range value {
		n = n*10 + int(digit-'0')
	}
	return n
}

func TestImportExportAndExportVerifyRunTheTool(t *testing.T) {
	t.Setenv("RASTRATA_TOOL", fakeTool(t, "0"))
	var out bytes.Buffer
	exit := Runner{Output: &out, Diagnostics: &bytes.Buffer{}}.Run(context.Background(), []string{"import-export", "/exports/x", "--to", "/data/new.sqlite"})
	if exit != 0 || !strings.Contains(out.String(), `"args":"import-export /exports/x --to /data/new.sqlite"`) {
		t.Fatalf("import-export: %d %s", exit, out.String())
	}
	out.Reset()
	exit = Runner{Output: &out, Diagnostics: &bytes.Buffer{}}.Run(context.Background(), []string{"export", "verify", "/exports/x"})
	if exit != 0 || !strings.Contains(out.String(), `"args":"check-export /exports/x"`) {
		t.Fatalf("export verify: %d %s", exit, out.String())
	}
}

func TestOfflineToolMissingSaysHowToFixIt(t *testing.T) {
	t.Setenv("RASTRATA_TOOL", "")
	t.Setenv("BUN_BIN", "")
	t.Setenv("PATH", t.TempDir())
	var out bytes.Buffer
	exit := Runner{Output: &out, Diagnostics: &bytes.Buffer{}}.Run(context.Background(), []string{"restore", "latest", "--to", "x.sqlite"})
	if exit != 4 || !strings.Contains(out.String(), "tool_unavailable") || !strings.Contains(out.String(), "RASTRATA_TOOL") {
		t.Fatalf("a missing tool is a clear failure: %d %s", exit, out.String())
	}
}

func TestToolIsFoundInTheRepositoryByWalkingUp(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "apps", "api", "src", "tool.ts")
	if err := os.MkdirAll(filepath.Dir(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "apps", "terminal", "deep")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RASTRATA_TOOL", "")
	t.Setenv("BUN_BIN", "/usr/bin/true")
	previous, _ := os.Getwd()
	if err := os.Chdir(nested); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(previous) }()
	argv, err := toolCommand()
	if err != nil {
		t.Fatal(err)
	}
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	resolvedScript, _ := filepath.EvalSymlinks(argv[1])
	if argv[0] != "/usr/bin/true" || resolvedScript != filepath.Join(resolvedRoot, "apps", "api", "src", "tool.ts") {
		t.Fatalf("unexpected tool command %v", argv)
	}
}

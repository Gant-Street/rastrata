package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const importSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func importPreviewJSON(valid bool, errors int) string {
	diagnostics := `[]`
	if errors > 0 {
		diagnostics = `[{"severity":"error","row":3,"message":"Row skipped: the amount \"abc\" is not an amount"}]`
	}
	validText := "true"
	if !valid {
		validText = "false"
	}
	return `{"valid":` + validText + `,"skippable":false,"file":{"sha256":"` + importSHA + `","size":120,"mediaType":"text/csv","name":"chase.csv"},` +
		`"format":"csv","account":{"id":"1010","code":"1010","name":"Chase Checking","role":"asset"},` +
		`"detection":{"how":"preset","preset":{"id":"chase-checking","name":"Chase checking","verified":false},"delimiter":",","headerRow":1,"dateOrder":"mdy"},` +
		`"columns":[],"counts":{"rows":3,"lines":3,"new":3,"duplicate":0,"overlap":0,"excluded":0,"invalid":0,"skipped":0},` +
		`"skipped":{"notFinal":[],"noAmount":0,"zero":0,"unreadable":0},"range":{"from":"2026-01-02","to":"2026-01-05"},` +
		`"totals":{"moneyIn":"100.00","moneyOut":"-30.00","net":"70.00","inCount":1,"outCount":2},` +
		`"newTotals":{"moneyIn":"100.00","moneyOut":"-30.00","net":"70.00","inCount":1,"outCount":2},` +
		`"balances":[{"accountKey":"csv:1010","asOf":"2026-01-05","reported":"70.00","ledger":"0.00","waiting":"0.00","excluded":"0.00","difference":"70.00"}],` +
		`"errors":` + string(rune('0'+errors)) + `,"warnings":0,"infos":0,"diagnostics":` + diagnostics + `,"hints":["Check the first line against your statement."],` +
		`"sample":{"count":3,"page":1,"pageSize":25,"lines":[]}}`
}

const importCommitJSON = `{"batchId":"batch-1","file":{"sha256":"` + importSHA + `","size":120,"mediaType":"text/csv"},` +
	`"account":{"id":"1010","code":"1010","name":"Chase Checking","role":"asset"},"source":{"provider":"csv","accountKey":"csv:1010"},` +
	`"counts":{"rows":3,"lines":3,"new":3,"duplicate":0,"overlap":0,"excluded":0,"invalid":0,"skipped":0},"waiting":3,` +
	`"range":{"from":"2026-01-02","to":"2026-01-05"},"newTotals":{"moneyIn":"100.00","moneyOut":"-30.00","net":"70.00","inCount":1,"outCount":2},` +
	`"balances":[],"warnings":0,"message":"3 lines are waiting in your Inbox."}`

const importChartJSON = `{"currency":"USD","configurationRevision":"1","suggestedEffectiveOn":"2026-01-01","tagsAsOf":"2026-01-01","tagsRevision":"0","tagsHash":"` + hash64 + `","accounts":[` +
	`{"id":"1010","tags":{},"code":"1010","name":"Chase Checking","role":"asset","parentId":null,"openedOn":"2026-01-01","closedOn":null,"balance":"0.00"},` +
	`{"id":"2100","tags":{},"code":"2100","name":"Business Card","role":"liability","parentId":null,"openedOn":"2026-01-01","closedOn":null,"balance":"0.00"},` +
	`{"id":"4000","tags":{},"code":"4000","name":"Sales","role":"income","parentId":null,"openedOn":"2026-01-01","closedOn":null,"balance":"0.00"}]}`

type importServer struct {
	uploads  [][]byte
	headers  []http.Header
	requests []sentRequest
	valid    bool
	errors   int
	refuse   bool
}

func (s *importServer) start(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if r.URL.Path == "/v1/uploads" {
			body, _ := io.ReadAll(r.Body)
			s.uploads = append(s.uploads, body)
			s.headers = append(s.headers, r.Header.Clone())
			envelope["data"] = json.RawMessage(`{"sha256":"` + importSHA + `","size":` + string(rune('0'+len(body)%10)) + `,"mediaType":"` + r.Header.Get("Content-Type") + `"}`)
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		s.requests = append(s.requests, sentRequest{Path: r.URL.Path, Request: request})
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/accounts.list":
			envelope["data"] = json.RawMessage(importChartJSON)
		case "/v1/import.preview":
			envelope["data"] = json.RawMessage(importPreviewJSON(s.valid, s.errors))
		case "/v1/import.commit":
			if s.refuse {
				w.WriteHeader(409)
				envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
					"error": map[string]any{"code": "import_blocked", "message": "This file cannot be imported as it stands.", "details": []any{}, "retryable": false}}
			} else {
				envelope["data"] = json.RawMessage(importCommitJSON)
			}
		case "/v1/import.presets":
			envelope["data"] = json.RawMessage(`{"presets":[]}`)
		case "/v1/import.profileList":
			envelope["data"] = json.RawMessage(`{"profiles":[{"id":"p-1","name":"Neo bank","ledgerAccountId":"1010","presetId":null,"mapping":{"date":{"index":1},"amount":{"kind":"signed","amount":{"index":2}},"description":[{"index":3}]},"version":1,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]}`)
		default:
			w.WriteHeader(404)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
				"error": map[string]any{"code": "route_not_found", "message": "not found", "details": []any{}, "retryable": false}}
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func writeStatement(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runImportCommand(t *testing.T, url string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	exit := runner.Run(context.Background(), append(args, "--endpoint", url, "--request-dir", t.TempDir()))
	return exit, out.String(), diagnostics.String()
}

func TestImportDryRunUploadsExactBytesAndPreviewsWithoutCommitting(t *testing.T) {
	server := &importServer{valid: true}
	url := server.start(t)
	content := "Details,Posting Date,Description,Amount\nDEBIT,01/02/2026,\"A, B\",-12.34\n"
	path := writeStatement(t, "Chase 1234.csv", content)
	exit, out, diagnostics := runImportCommand(t, url, "import", path, "--account", "Chase Checking", "--dry-run=true")
	if exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	if len(server.uploads) != 1 || string(server.uploads[0]) != content {
		t.Fatalf("the file was not uploaded byte for byte: %q", server.uploads)
	}
	header := server.headers[0]
	if header.Get("Content-Type") != "text/csv" || header.Get("X-Upload-Name") != "Chase%201234.csv" {
		t.Fatalf("bad upload headers: %v", header)
	}
	paths := []string{}
	for _, request := range server.requests {
		paths = append(paths, request.Path)
	}
	if strings.Join(paths, ",") != "/v1/accounts.list,/v1/import.preview" {
		t.Fatalf("a dry run must not commit: %v", paths)
	}
	var sent map[string]any
	_ = json.Unmarshal(server.requests[1].Request.Input, &sent)
	if sent["sha256"] != importSHA || sent["ledgerAccountId"] != "1010" {
		t.Fatalf("preview input: %v", sent)
	}
	if !json.Valid([]byte(out)) || strings.Contains(out, "\x1b") {
		t.Fatalf("stdout must be one JSON envelope: %q", out)
	}
	for _, want := range []string{"1010 Chase Checking: csv, preset Chase checking (unverified", "3 lines: 3 new", "difference 70.00", "can be imported"} {
		if !strings.Contains(diagnostics, want) {
			t.Fatalf("summary lacks %q:\n%s", want, diagnostics)
		}
	}
}

func TestImportCommitsWithAnOperationIdentityAndSaysWhatIsWaiting(t *testing.T) {
	server := &importServer{valid: true}
	url := server.start(t)
	path := writeStatement(t, "statement.qfx", "OFXHEADER:100\n<OFX></OFX>\n")
	exit, out, diagnostics := runImportCommand(t, url, "import", path, "--account", "1010", "--start-on", "2026-01-01", "--catch-up=false")
	if exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	last := server.requests[len(server.requests)-1]
	if last.Path != "/v1/import.commit" || last.Request.OperationID == "" {
		t.Fatalf("commit must carry an operation identity: %+v", last)
	}
	var sent map[string]any
	_ = json.Unmarshal(last.Request.Input, &sent)
	if sent["startOn"] != "2026-01-01" || sent["catchUp"] != nil || sent["skipInvalidRows"] != nil {
		t.Fatalf("commit input: %v", sent)
	}
	if server.headers[0].Get("Content-Type") != "application/vnd.intu.qfx" {
		t.Fatalf("a .qfx file is uploaded as Intuit QFX: %v", server.headers[0])
	}
	if !strings.Contains(diagnostics, "3 lines are waiting in your Inbox.") || !strings.Contains(diagnostics, "Retaining "+last.Request.OperationID) {
		t.Fatalf("diagnostics: %s", diagnostics)
	}
	// The identity is the caller's when given, so a retry after a lost reply is the same operation.
	_, _, _ = runImportCommand(t, url, "import", path, "--account", "1010", "--operation-id", "11111111-1111-4111-8111-111111111111")
	last = server.requests[len(server.requests)-1]
	if last.Request.OperationID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("the given identity was not used: %+v", last)
	}
}

func TestImportRefusedByTheServiceExitsThree(t *testing.T) {
	server := &importServer{valid: false, errors: 1, refuse: true}
	url := server.start(t)
	path := writeStatement(t, "bad.csv", "a,b\n1,2\n")
	exit, out, _ := runImportCommand(t, url, "import", path, "--account", "1010")
	if exit != 3 || !strings.Contains(out, "import_blocked") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	exit, out, diagnostics := runImportCommand(t, url, "import", path, "--account", "1010", "--dry-run=true")
	if exit != 3 || !strings.Contains(diagnostics, "error row 3") || !strings.Contains(diagnostics, "cannot be imported as it stands") {
		t.Fatalf("a preview that cannot be committed exits 3: %d %s %s", exit, out, diagnostics)
	}
}

func TestImportResolvesAccountsAndProfilesAndListsTheChoicesWhenItCannot(t *testing.T) {
	server := &importServer{valid: true}
	url := server.start(t)
	path := writeStatement(t, "s.csv", "a,b\n1,2\n")
	for _, name := range []string{"1010", "Chase Checking", "chase checking"} {
		if exit, out, _ := runImportCommand(t, url, "import", path, "--account", name, "--dry-run=true"); exit != 0 {
			t.Fatalf("account %q: exit %d %s", name, exit, out)
		}
	}
	exit, out, _ := runImportCommand(t, url, "import", path, "--account", "Savings", "--dry-run=true")
	if exit != 2 || !strings.Contains(out, "Bank and card accounts: 1010 Chase Checking, 2100 Business Card") || strings.Contains(out, "Sales") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if exit, _, _ := runImportCommand(t, url, "import", path, "--account", "1010", "--profile", "neo BANK", "--dry-run=true"); exit != 0 {
		t.Fatalf("profile by name: exit %d", exit)
	}
	var sent map[string]any
	_ = json.Unmarshal(server.requests[len(server.requests)-1].Request.Input, &sent)
	if sent["profileId"] != "p-1" {
		t.Fatalf("the profile was not resolved to its id: %v", sent)
	}
	exit, out, _ = runImportCommand(t, url, "import", path, "--account", "1010", "--profile", "nothing")
	if exit != 2 || !strings.Contains(out, "Profiles: Neo bank") {
		t.Fatalf("exit %d: %s", exit, out)
	}
}

func TestImportUsageErrorsNeverReachTheService(t *testing.T) {
	server := &importServer{valid: true}
	url := server.start(t)
	path := writeStatement(t, "s.csv", "a,b\n1,2\n")
	mapping := writeStatement(t, "mapping.json", `{"date":{"index":1}}`)
	cases := [][]string{
		{"import"},
		{"import", path},
		{"import", path, "extra", "--account", "1010"},
		{"import", path, "--account", "1010", "--bogus", "x"},
		{"import", path, "--account", "1010", "--dry-run", "maybe"},
		{"import", path, "--account", "1010", "--page", "0", "--dry-run=true"},
		{"import", path, "--account", "1010", "--page", "2"},
		{"import", path, "--account", "1010", "--profile", "a", "--preset", "b"},
		{"import", path, "--account", "1010", "--preset", "chase-checking", "--mapping", mapping},
		{"import", path, "--account", "1010", "--dry-run=true", "--skip-invalid-rows=true"},
		{"import", filepath.Join(t.TempDir(), "missing.csv"), "--account", "1010"},
		{"import", t.TempDir(), "--account", "1010"},
		{"import", path, "--account", "1010", "--mapping", filepath.Join(t.TempDir(), "none.json")},
		{"import", writeStatement(t, "empty.csv", ""), "--account", "1010"},
		{"import", path, "--account", "1010", "--mapping", writeStatement(t, "bad.json", "[1,2]")},
	}
	for _, args := range cases {
		exit, out, _ := runImportCommand(t, url, args...)
		if exit != 2 || !json.Valid([]byte(out)) {
			t.Fatalf("%v: exit %d %s", args, exit, out)
		}
	}
	if len(server.uploads) != 0 {
		t.Fatalf("nothing may be uploaded when the usage is wrong: %d uploads", len(server.uploads))
	}
}

func TestImportRefusesAFileOverSixteenMebibytesWithoutSendingIt(t *testing.T) {
	server := &importServer{valid: true}
	url := server.start(t)
	path := filepath.Join(t.TempDir(), "huge.csv")
	if err := os.WriteFile(path, bytes.Repeat([]byte("a"), api.MaxUploadBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	exit, out, _ := runImportCommand(t, url, "import", path, "--account", "1010")
	if exit != 2 || !strings.Contains(out, "request_too_large") || len(server.uploads) != 0 {
		t.Fatalf("exit %d: %s (%d uploads)", exit, out, len(server.uploads))
	}
}

func TestImportPresetsAndProfilesAreReads(t *testing.T) {
	server := &importServer{valid: true}
	url := server.start(t)
	if exit, out, _ := runImportCommand(t, url, "import", "presets"); exit != 0 || !strings.Contains(out, `"presets"`) {
		t.Fatalf("presets: %d %s", exit, out)
	}
	exit, out, _ := runImportCommand(t, url, "import", "profiles", "--account", "Chase Checking")
	if exit != 0 || !strings.Contains(out, "Neo bank") {
		t.Fatalf("profiles: %d %s", exit, out)
	}
	last := server.requests[len(server.requests)-1]
	var sent map[string]any
	_ = json.Unmarshal(last.Request.Input, &sent)
	if last.Path != "/v1/import.profileList" || sent["ledgerAccountId"] != "1010" || last.Request.OperationID != "" {
		t.Fatalf("a profile list is a read for one account: %+v %v", last, sent)
	}
}

func TestPlainMakesControlCharactersVisible(t *testing.T) {
	got := plain("a\x1b[31mred\u202edcba\x07")
	if strings.ContainsAny(got, "\x1b\x07\u202e") || !strings.Contains(got, `\u001b[31mred\u202edcba\u0007`) {
		t.Fatalf("plain left control characters in: %q", got)
	}
	if plain("café — 日本語") != "café — 日本語" {
		t.Fatal("plain changed ordinary text")
	}
}

// The service says to flip a card statement's signs and means the screen's switch; the command line
// has to say how, or an agent reads the schemas to find out (the first baseline runs spent up to ten
// turns on it and one saved a profile the owner had not asked for).
func TestAPreviewThatSaysToFlipTheSignsSaysHowToWithTheCommand(t *testing.T) {
	var out bytes.Buffer
	printPreviewSummary(&out, json.RawMessage(`{"valid":true,"format":"csv","account":{"code":"2000","name":"Amex business card"},`+
		`"detection":{},"counts":{"lines":26,"new":24},"totals":{"moneyIn":"2694.52","moneyOut":"-725.00"},"balances":[],"errors":0,"warnings":2,`+
		`"hints":["Most lines are positive, but on a credit card most lines are charges, which are negative here. If these are charges, the issuer shows them as positive: choose to flip the signs (American Express does this)."],"diagnostics":[]}`))
	for _, want := range []string{"choose to flip the signs", "--preset amex-card", "import presets", `"invert": true`, "--profile NAME"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the summary lacks %q:\n%s", want, out.String())
		}
	}
	// Any other hint stands alone.
	out.Reset()
	printPreviewSummary(&out, json.RawMessage(`{"valid":true,"format":"csv","account":{"code":"1010","name":"Chase"},"detection":{},"counts":{},"totals":{},"balances":[],"hints":["Check the first line against your statement."],"diagnostics":[]}`))
	if strings.Contains(out.String(), "--preset") {
		t.Errorf("an unrelated hint got the flip advice:\n%s", out.String())
	}
}

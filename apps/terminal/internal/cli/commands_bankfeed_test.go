package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// A made-up setup token: base64 of a made-up claim URL. Nothing here is a real credential.
const fixtureSetupToken = "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9GSVhUVVJFLTIwMjYtQTFCMkMzRDQ="

const bankfeedRequestsJSON = `{"used":3,"limit":24,"budget":20,"freesAt":"2026-10-05T13:00:00.000Z","pausedUntil":null}`
const bankfeedAccountJSON = `{"id":"ACT-1","name":"Business Checking","bank":"Example Bank","currency":"USD","isoCurrency":"USD","foreignCurrency":false,"balance":"4021.35","balanceOn":"2026-10-04","support":"ok","state":"unlinked","link":null}`
const bankfeedSettingsJSON = `{"dailySync":false,"dailyAt":"06:17"}`

func bankfeedRunJSON(id string, disposition string, newLines int) string {
	return `{"id":"` + id + `","startedAt":"2026-10-04T13:00:00.000Z","finishedAt":"2026-10-04T13:00:01.000Z","disposition":"` + disposition +
		`","trigger":"manual","requests":2,"accounts":1,"windows":1,"newLines":` + strconv.Itoa(newLines) + `,"duplicateLines":0,"pendingSkipped":0,"heldLines":0,"errorCode":null,"errorMessage":null,"notes":[]}`
}

const bankfeedStatusJSON = `{"connected":true,"credential":{"present":true,"host":"beta-bridge.simplefin.org","problem":null},"bookCurrency":"USD",` +
	`"accounts":[{"id":"ACT-1","name":"Business \u001b[31mChecking","bank":"Example Bank","currency":"USD","isoCurrency":"USD","foreignCurrency":false,"balance":"4021.35","balanceOn":"2026-10-04","support":"ok","state":"linked",` +
	`"link":{"ledgerAccountId":"1000","ledgerAccount":"1000 Business Checking","startOn":"2026-09-01","sourceStartOn":"2026-09-01","linkedAt":"2026-10-04T13:00:00.000Z","through":"2026-10-04","lastSyncAt":null,"lastOkAt":null,"lastError":null,` +
	`"feedBalance":{"asOf":"2026-10-04","reported":"4021.35","ledger":"2798.00","waiting":"1223.35","excluded":"0.00","difference":"0.00"}}}],` +
	`"linked":1,"unlinked":0,"attention":[{"code":"stale","severity":"warning","message":"The last successful sync was 4 days ago."}],"problems":[],"messages":[],` +
	`"requests":` + bankfeedRequestsJSON + `,"settings":` + bankfeedSettingsJSON + `,"lastSync":null,"history":[],"held":[],"heldCount":0,"scheduler":false}`

type bankfeedFake struct {
	moreFor int
	pauseOn int
	failure string
	sent    []sentRequest
	calls   int
}

// server answers the bankfeed operations like the application and records what the CLI sent.
func (f *bankfeedFake) server(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		f.sent = append(f.sent, sentRequest{Path: r.URL.Path, Request: request})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		if f.failure != "" && r.URL.Path != "/v1/bankfeed.status" {
			w.WriteHeader(409)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
				"error": map[string]any{"code": f.failure, "message": "The bank feed is not connected.", "details": []any{}, "retryable": false}}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		switch r.URL.Path {
		case "/v1/bankfeed.connect":
			envelope["data"] = json.RawMessage(`{"connected":true,"host":"beta-bridge.simplefin.org","accounts":[` + bankfeedAccountJSON + `],"accountsError":null}`)
		case "/v1/bankfeed.accounts":
			envelope["data"] = json.RawMessage(`{"accounts":[` + bankfeedAccountJSON + `],"problems":[],"messages":[],"requests":` + bankfeedRequestsJSON + `}`)
		case "/v1/bankfeed.link":
			envelope["data"] = json.RawMessage(`{"account":` + bankfeedAccountJSON + `,"notes":["Statement files already feed this account."]}`)
		case "/v1/bankfeed.unlink":
			envelope["data"] = json.RawMessage(`{"account":null,"unlinked":true}`)
		case "/v1/bankfeed.status":
			envelope["data"] = json.RawMessage(bankfeedStatusJSON)
		case "/v1/bankfeed.settings":
			envelope["data"] = json.RawMessage(bankfeedSettingsJSON)
		case "/v1/bankfeed.disconnect":
			envelope["data"] = json.RawMessage(`{"connected":false,"removed":true}`)
		case "/v1/bankfeed.sync":
			f.calls++
			disposition, more, paused := "complete", false, "null"
			if f.calls <= f.moreFor {
				disposition, more = "more", true
			}
			if f.pauseOn != 0 && f.calls == f.pauseOn {
				disposition, more = "paused", false
				paused = `{"reason":"daily_budget","until":"2026-10-05T01:00:00.000Z","message":"The day's request budget for the Bridge is spent."}`
			}
			moreText := "false"
			if more {
				moreText = "true"
			}
			envelope["data"] = json.RawMessage(`{"run":` + bankfeedRunJSON(request.OperationID, disposition, f.calls) + `,"more":` + moreText + `,"paused":` + paused + `,"accounts":[],"problems":[]}`)
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

type bankfeedRun struct {
	exit        int
	out         string
	diagnostics string
	journal     string
}

// run executes `rastrata bankfeed ...` with the given standard input against the fake service. The
// request journal is a directory of its own so a test can read everything the CLI wrote.
func (f *bankfeedFake) run(t *testing.T, stdin string, args ...string) bankfeedRun {
	t.Helper()
	server := f.server(t)
	journal := t.TempDir()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(stdin), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"bankfeed"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", journal)
	exit := runner.Run(context.Background(), all)
	return bankfeedRun{exit: exit, out: out.String(), diagnostics: diagnostics.String(), journal: journal}
}

// everythingWritten is every byte the CLI wrote to the journal, as one string.
func everythingWritten(t *testing.T, directory string) string {
	t.Helper()
	var all strings.Builder
	_ = filepath.Walk(directory, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			data, _ := os.ReadFile(path)
			all.Write(data)
		}
		return nil
	})
	return all.String()
}

func TestBankfeedConnectReadsTheTokenFromStandardInputAndNeverKeepsOrPrintsIt(t *testing.T) {
	fake := &bankfeedFake{}
	// A person pastes it with a line break, or a wrapped copy: whitespace is not part of a token.
	run := fake.run(t, fixtureSetupToken[:30]+"\n"+fixtureSetupToken[30:]+"\n", "connect")
	if run.exit != 0 || !json.Valid([]byte(run.out)) {
		t.Fatalf("connect failed: %d %s", run.exit, run.out)
	}
	if len(fake.sent) != 1 || fake.sent[0].Path != "/v1/bankfeed.connect" || fake.sent[0].Request.OperationID == "" {
		t.Fatalf("connect is one call under an identity: %+v", fake.sent)
	}
	var input map[string]string
	_ = json.Unmarshal(fake.sent[0].Request.Input, &input)
	if input["setupToken"] != fixtureSetupToken {
		t.Fatalf("the token arrived changed: %v", input)
	}
	// Nothing the CLI printed or wrote holds the token.
	for name, text := range map[string]string{"stdout": run.out, "stderr": run.diagnostics, "the request journal": everythingWritten(t, run.journal)} {
		if strings.Contains(text, fixtureSetupToken) || strings.Contains(text, fixtureSetupToken[:30]) {
			t.Fatalf("%s holds the setup token", name)
		}
	}
	if strings.Contains(run.diagnostics, "Retaining") {
		t.Fatalf("a request that is never kept must not say it is retained: %q", run.diagnostics)
	}
	if everythingWritten(t, run.journal) != "" {
		t.Fatal("the request journal must stay empty for connect")
	}
}

func TestBankfeedConnectReadsTheTokenFromAFileAndWarnsAboutOpenPermissions(t *testing.T) {
	fake := &bankfeedFake{}
	file := filepath.Join(t.TempDir(), "token.txt")
	if err := os.WriteFile(file, []byte(fixtureSetupToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run := fake.run(t, "", "connect", "--token-file", file)
	if run.exit != 0 || len(fake.sent) != 1 {
		t.Fatalf("connect --token-file failed: %d %s %s", run.exit, run.out, run.diagnostics)
	}
	var input map[string]string
	_ = json.Unmarshal(fake.sent[0].Request.Input, &input)
	if input["setupToken"] != fixtureSetupToken || strings.Contains(run.diagnostics, "Warning") {
		t.Fatalf("a private file is read quietly: %v %q", input, run.diagnostics)
	}
	open := filepath.Join(t.TempDir(), "open.txt")
	if err := os.WriteFile(open, []byte(fixtureSetupToken), 0o644); err != nil {
		t.Fatal(err)
	}
	other := &bankfeedFake{}
	run = other.run(t, "", "connect", "--token-file", open)
	if run.exit != 0 || !strings.Contains(run.diagnostics, "can be read by other users") || strings.Contains(run.diagnostics, fixtureSetupToken) {
		t.Fatalf("an open file must be warned about without repeating it: %d %q", run.exit, run.diagnostics)
	}
}

func TestBankfeedConnectRefusesTheTokenAsAnArgumentAndNeverEchoesIt(t *testing.T) {
	for _, args := range [][]string{
		{"connect", "--token", fixtureSetupToken},
		{"connect", "--token=" + fixtureSetupToken},
		{"connect", "--setup-token", fixtureSetupToken},
		{"connect", fixtureSetupToken},
	} {
		fake := &bankfeedFake{}
		run := fake.run(t, "", args...)
		if run.exit != 2 || len(fake.sent) != 0 {
			t.Fatalf("%v: a token on the command line must be refused and nothing sent: %d %+v", args, run.exit, fake.sent)
		}
		if strings.Contains(run.out, fixtureSetupToken) || strings.Contains(run.diagnostics, fixtureSetupToken) {
			t.Fatalf("%v: the refusal echoed the token", args)
		}
		if args[1] != fixtureSetupToken && !strings.Contains(run.out, "ps") {
			t.Fatalf("the refusal must say why (it shows in ps): %s", run.out)
		}
	}
}

func TestBankfeedConnectNeedsATokenAndSaysWhereItComesFrom(t *testing.T) {
	for name, stdin := range map[string]string{"nothing": "", "only whitespace": " \n\t \n"} {
		fake := &bankfeedFake{}
		run := fake.run(t, stdin, "connect")
		if run.exit != 2 || len(fake.sent) != 0 || !strings.Contains(run.out, "standard input") {
			t.Fatalf("%s: %d %s", name, run.exit, run.out)
		}
	}
	fake := &bankfeedFake{}
	if run := fake.run(t, strings.Repeat("A", 5000), "connect"); run.exit != 2 || len(fake.sent) != 0 {
		t.Fatalf("a huge input is not a setup token: %d", run.exit)
	}
	missing := &bankfeedFake{}
	run := missing.run(t, "", "connect", "--token-file", filepath.Join(t.TempDir(), "nope.txt"))
	if run.exit != 2 || len(missing.sent) != 0 {
		t.Fatalf("a missing token file: %d %s", run.exit, run.out)
	}
}

func TestBankfeedConnectFailureIsPrintedAsTheServiceSaidItWithoutTheToken(t *testing.T) {
	fake := &bankfeedFake{failure: "bankfeed_token_rejected"}
	run := fake.run(t, fixtureSetupToken, "connect")
	if run.exit != 3 || !strings.Contains(run.out, "bankfeed_token_rejected") || strings.Contains(run.out+run.diagnostics, fixtureSetupToken) {
		t.Fatalf("a refused token exits 3 and prints the service's error: %d %s", run.exit, run.out)
	}
	if everythingWritten(t, run.journal) != "" {
		t.Fatal("a failed connect must leave nothing in the request journal either")
	}
}

func TestBankfeedSyncCatchesUpOneCallAtATimeUnderNewIdentities(t *testing.T) {
	fake := &bankfeedFake{moreFor: 2}
	run := fake.run(t, "", "sync")
	if run.exit != 0 || !json.Valid([]byte(run.out)) || len(fake.sent) != 3 {
		t.Fatalf("sync failed: %d %s (%d calls)", run.exit, run.out, len(fake.sent))
	}
	seen := map[string]bool{}
	for _, request := range fake.sent {
		if request.Path != "/v1/bankfeed.sync" || request.Request.OperationID == "" || seen[request.Request.OperationID] {
			t.Fatalf("each call needs its own identity: %+v", fake.sent)
		}
		seen[request.Request.OperationID] = true
	}
	var envelope struct {
		Data struct {
			More bool `json:"more"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(run.out), &envelope); err != nil || envelope.Data.More || strings.Count(run.out, "\n") > 1 {
		t.Fatalf("stdout holds one envelope, the last, with nothing left: %s", run.out)
	}
	if !strings.Contains(run.diagnostics, "continuing") {
		t.Fatalf("progress belongs on stderr: %q", run.diagnostics)
	}
}

func TestBankfeedSyncStopsWhenPausedAndSaysWhenItCanGoOn(t *testing.T) {
	fake := &bankfeedFake{moreFor: 5, pauseOn: 2}
	run := fake.run(t, "", "sync")
	// The day's request budget is spent: asking again would only spend the Bridge's patience.
	if run.exit != 3 || len(fake.sent) != 2 {
		t.Fatalf("a pause stops the loop at once and exits 3: %d, %d calls", run.exit, len(fake.sent))
	}
	if !strings.Contains(run.diagnostics, "Do not ask again before 2026-10-05T01:00:00.000Z") {
		t.Fatalf("the pause must say until when: %q", run.diagnostics)
	}
	if !strings.Contains(run.out, `"paused":{"reason":"daily_budget"`) {
		t.Fatalf("the paused result is the one printed: %s", run.out)
	}
}

func TestBankfeedSyncOnceOrWithAnIdentityMakesExactlyOneCall(t *testing.T) {
	fake := &bankfeedFake{moreFor: 5}
	if run := fake.run(t, "", "sync", "--once", "--budget-seconds", "7", "--account", "ACT-1"); run.exit != 0 || len(fake.sent) != 1 {
		t.Fatalf("--once makes one call: %d %d", run.exit, len(fake.sent))
	}
	var input map[string]any
	_ = json.Unmarshal(fake.sent[0].Request.Input, &input)
	if input["budgetSeconds"] != float64(7) || input["accountId"] != "ACT-1" {
		t.Fatalf("the options did not arrive: %v", input)
	}
	other := &bankfeedFake{moreFor: 5}
	id := api.NewOperationID()
	if run := other.run(t, "", "sync", "--operation-id", id); run.exit != 0 || len(other.sent) != 1 || other.sent[0].Request.OperationID != id {
		t.Fatalf("a given identity is used for one call: %+v", other.sent)
	}
}

func TestBankfeedSyncFailureStopsAndExitsWithTheRejectionCode(t *testing.T) {
	fake := &bankfeedFake{failure: "bankfeed_not_connected"}
	run := fake.run(t, "", "sync")
	if run.exit != 3 || !strings.Contains(run.out, "bankfeed_not_connected") || len(fake.sent) != 1 {
		t.Fatalf("a failed sync stops with exit 3: %d %s (%d calls)", run.exit, run.out, len(fake.sent))
	}
}

func TestBankfeedCommandsSendOnlyWhatWasAsked(t *testing.T) {
	fake := &bankfeedFake{}
	if run := fake.run(t, "", "status", "--books", "false"); run.exit != 0 || !strings.Contains(run.out, `"connected":true`) {
		t.Fatalf("status failed: %d %s", run.exit, run.out)
	}
	var status map[string]bool
	_ = json.Unmarshal(fake.sent[0].Request.Input, &status)
	if fake.sent[0].Path != "/v1/bankfeed.status" || status["books"] {
		t.Fatalf("--books false must reach the service: %+v", fake.sent[0])
	}
	fake.sent = nil
	if run := fake.run(t, "", "link", "--account", "Demo Checking", "--to", "1000", "--from", "2026-09-01"); run.exit != 0 {
		t.Fatalf("link failed: %d %s", run.exit, run.out)
	}
	var link map[string]string
	_ = json.Unmarshal(fake.sent[0].Request.Input, &link)
	if fake.sent[0].Path != "/v1/bankfeed.link" || link["accountId"] != "Demo Checking" || link["ledgerAccountId"] != "1000" || link["startOn"] != "2026-09-01" {
		t.Fatalf("a link changed on the way (an id may hold a space): %v", link)
	}
	fake.sent = nil
	if run := fake.run(t, "", "link", "--account", "ACT-1", "--to", "1000"); run.exit != 0 {
		t.Fatal("link without a first day failed")
	}
	var bare map[string]any
	_ = json.Unmarshal(fake.sent[0].Request.Input, &bare)
	if _, present := bare["startOn"]; present {
		t.Fatalf("only what was named is sent: %v", bare)
	}
	fake.sent = nil
	if run := fake.run(t, "", "unlink", "--account", "ACT-1"); run.exit != 0 || fake.sent[0].Path != "/v1/bankfeed.unlink" {
		t.Fatalf("unlink failed: %d", run.exit)
	}
	fake.sent = nil
	if run := fake.run(t, "", "accounts"); run.exit != 0 || fake.sent[0].Path != "/v1/bankfeed.accounts" || !strings.Contains(run.diagnostics, "Retaining") {
		t.Fatalf("accounts is a write that is retained: %d %q", run.exit, run.diagnostics)
	}
}

func TestBankfeedSettingsChangesOnlyWhatIsNamedAndShowsWhatIsSetOtherwise(t *testing.T) {
	fake := &bankfeedFake{}
	if run := fake.run(t, "", "settings", "--daily", "true", "--at", "06:17"); run.exit != 0 {
		t.Fatalf("settings failed: %d %s", run.exit, run.out)
	}
	var input map[string]any
	_ = json.Unmarshal(fake.sent[0].Request.Input, &input)
	if fake.sent[0].Path != "/v1/bankfeed.settings" || input["dailySync"] != true || input["dailyAt"] != "06:17" {
		t.Fatalf("settings changed on the way: %v", input)
	}
	other := &bankfeedFake{}
	run := other.run(t, "", "settings")
	if run.exit != 0 || other.sent[0].Path != "/v1/bankfeed.status" || !strings.Contains(run.out, `"dailyAt":"06:17"`) || strings.Contains(run.out, `"connected"`) {
		t.Fatalf("with nothing to change it shows the settings: %d %s", run.exit, run.out)
	}
}

func TestBankfeedDisconnectNeedsYes(t *testing.T) {
	fake := &bankfeedFake{}
	if run := fake.run(t, "", "disconnect"); run.exit != 2 || len(fake.sent) != 0 {
		t.Fatalf("disconnect without --yes must refuse: %d", run.exit)
	}
	if run := fake.run(t, "", "disconnect", "--yes"); run.exit != 0 || fake.sent[0].Path != "/v1/bankfeed.disconnect" {
		t.Fatalf("disconnect --yes: %d", run.exit)
	}
}

func TestBankfeedCommandsRefuseWhatTheyDoNotUnderstand(t *testing.T) {
	cases := [][]string{
		{"status", "extra"},
		{"status", "--books", "maybe"},
		{"sync", "--budget-seconds"},
		{"sync", "--budget-seconds", "99"},
		{"sync", "--bogus", "1"},
		{"sync", "extra"},
		{"link", "--account", "ACT-1"},
		{"link", "--to", "1000"},
		{"link", "--account"},
		{"unlink"},
		{"settings", "--daily", "sometimes"},
		{"settings", "--at"},
		{"accounts", "--refresh"},
		{"disconnect", "--now"},
	}
	for _, args := range cases {
		fake := &bankfeedFake{}
		run := fake.run(t, "", args...)
		if run.exit != 2 || !json.Valid([]byte(run.out)) || len(fake.sent) != 0 {
			t.Fatalf("%v should be a usage error and send nothing, got %d %s", args, run.exit, run.out)
		}
	}
}

func TestBankfeedTextIsSafeToPrintAndSaysFeedBalanceIsNotAStatementBalance(t *testing.T) {
	fake := &bankfeedFake{}
	run := fake.run(t, "", "status", "--format", "text")
	if run.exit != 0 {
		t.Fatalf("status --format text: %d %s", run.exit, run.out)
	}
	if strings.ContainsRune(run.out, 0x1b) {
		t.Fatalf("a terminal escape from the bank's account name reached the terminal: %q", run.out)
	}
	for _, want := range []string{"Connected to beta-bridge.simplefin.org", "1 linked", "[warning]", "feed balance 4,021.35", "not a statement balance", "3 of about 24", "Daily sync: off"} {
		if !strings.Contains(run.out, want) {
			t.Fatalf("the text omits %q: %s", want, run.out)
		}
	}
}

func TestBankfeedHelpListsEveryCommandAndTheTokenRule(t *testing.T) {
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	if exit := runner.Run(context.Background(), []string{"help"}); exit != 0 {
		t.Fatalf("help failed: %d", exit)
	}
	for _, want := range []string{"bankfeed connect", "bankfeed accounts", "bankfeed link", "bankfeed unlink", "bankfeed sync", "bankfeed status", "bankfeed settings", "bankfeed disconnect", "never an argument"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("help omits %q", want)
		}
	}
}

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const reportsHash = "1111111111111111111111111111111111111111111111111111111111111111"

const reportsFiscalYear = `{"year":2026,"startsOn":"2026-01-01","endsOn":"2026-12-31"}`

// A report with one account in each statement, so narrowing a statement has something to keep.
const coreReportsJSON = `{"compilerVersion":"rastrata-core-report-v2","populationHash":"` + reportsHash + `","bookRevision":"9007199254740993","postingSequence":"3",` +
	`"asOf":"2026-06-30","periodStart":"2026-01-01","currency":"USD","basis":"cash","fiscalYear":` + reportsFiscalYear + `,` +
	`"trialBalance":{"rows":[{"accountId":"1000","code":"1000","name":"Cash, bank","role":"asset","signedBalance":"1000000000000000.01","debit":"1000000000000000.01","credit":"0.00"}],` +
	`"debit":"1000000000000000.01","credit":"1000000000000000.01","balanced":true,"fiscalYearStart":"2026-01-01","retainedEarnings":null},` +
	`"profitAndLoss":{"rows":[{"accountId":"4000","code":"4000","name":"Sales","role":"income","amount":"10.00"}],"revenue":"10.00","expenses":"0.00","netIncome":"10.00","totals":[]},` +
	`"balanceSheet":{"rows":[],"assets":"0.00","liabilities":"0.00","equity":"0.00","currentEarnings":"0.00","balanced":true,"contributedEquity":"0.00","priorEarnings":"0.00","difference":"0.00","totals":[]},` +
	`"comparison":null,"warnings":[]}`

const cashFlowJSON = `{"compilerVersion":"rastrata-cash-flow-v1","populationHash":"` + reportsHash + `","ledgerPopulationHash":"` + reportsHash + `","tagMapHash":"` + reportsHash + `","tagsRevision":"0",` +
	`"bookRevision":"5","postingSequence":"3","asOf":"2026-06-30","periodStart":"2026-01-01","currency":"USD","basis":"cash","fiscalYear":` + reportsFiscalYear + `,` +
	`"available":false,"reason":"No account is tagged as cash.","sections":[],"cashAccounts":[],"openingCash":null,"netChange":null,"closingCash":null,"ties":null,"totals":[],"comparison":null,"warnings":[]}`

const generalLedgerJSON = `{"compilerVersion":"rastrata-core-report-v2","populationHash":"` + reportsHash + `","bookRevision":"5","postingSequence":"3","asOf":"2026-06-30","periodStart":"2026-01-01",` +
	`"currency":"USD","basis":"cash","fiscalYear":` + reportsFiscalYear + `,"accounts":[],"count":0,"page":2,"pageSize":100,"lines":[]}`

const largestJSON = `{"bookRevision":"9007199254740993","postingSequence":"3","asOf":"2026-03-31","periodStart":"2026-03-01","currency":"USD","kind":"expense","limit":2,"count":5,` +
	`"rows":[{"rank":1,"journalId":"rent","date":"2026-03-02","narration":"March rent","postingSequence":"2","accountId":"5100","code":"5100","name":"Rent","accounts":1,"amount":"750.00"},` +
	`{"rank":2,"journalId":"check","date":"2026-03-05","narration":"Check 1041","postingSequence":"3","accountId":"5200","code":"5200","name":"Contract labor","accounts":1,"amount":"600.00"}]}`

const calendarJSON = `{"currency":"USD","basis":"cash","bookRevision":"5","firstDate":"2026-01-01","lastDate":"2026-12-31","latestPostingDate":null,"fiscalYears":[` + reportsFiscalYear + `]}`

// A file as the service renders it: CRLF line ends and a quoted, neutralised cell.
const exportContent = "Report,Profit and loss\r\nBook,\"'=cmd|\"\" /C calc\"\"!A0\"\r\n\r\nAccount ID,Code\r\n4000,4000\r\n"

type reportsRequest struct {
	Path  string
	Input map[string]any
}

// reportsServer answers the report operations like the application and records what the CLI sent.
// failure, when set, is the error code every report operation answers with (a 409).
func reportsServer(t *testing.T, sent *[]reportsRequest, failure string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		var input map[string]any
		_ = json.Unmarshal(request.Input, &input)
		*sent = append(*sent, reportsRequest{Path: r.URL.Path, Input: input})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if failure != "" {
			w.WriteHeader(409)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
				"error": map[string]any{"code": failure, "message": "The book cannot do that.", "details": []any{}, "retryable": false}}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		switch r.URL.Path {
		case "/v1/reports.get":
			envelope["data"] = json.RawMessage(coreReportsJSON)
		case "/v1/reports.cashFlow":
			envelope["data"] = json.RawMessage(cashFlowJSON)
		case "/v1/reports.generalLedger":
			envelope["data"] = json.RawMessage(generalLedgerJSON)
		case "/v1/reports.calendar":
			envelope["data"] = json.RawMessage(calendarJSON)
		case "/v1/reports.largest":
			envelope["data"] = json.RawMessage(largestJSON)
		case "/v1/reports.export":
			content, _ := json.Marshal(exportContent)
			envelope["data"] = json.RawMessage(`{"statement":"profit-loss","filename":"profit-loss-2026-01-01-to-2026-06-30.csv","mediaType":"text/csv; charset=utf-8",` +
				`"bookRevision":"5","populationHash":"` + reportsHash + `","content":` + string(content) + `}`)
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runReportsCLI(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"reports"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func TestReportsSendsTheRangeBasisAndComparisonAndNarrowsOneStatement(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	exit, out, _ := runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30", "--from", "2026-04-01", "--compare", "previous-year", "--basis", "cash", "--revision", "9007199254740993")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("reports failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/reports.get" {
		t.Fatalf("unexpected requests: %+v", sent)
	}
	want := map[string]string{"asOf": "2026-06-30", "from": "2026-04-01", "compare": "previousYear", "basis": "cash", "revision": "9007199254740993"}
	for key, value := range want {
		if sent[0].Input[key] != value {
			t.Fatalf("%s changed on the way: %v", key, sent[0].Input)
		}
	}
	// The revision is a decimal string end to end, never a number.
	if _, isString := sent[0].Input["revision"].(string); !isString {
		t.Fatal("revision was not sent as a string")
	}
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"asOf", "periodStart", "basis", "currency", "bookRevision", "populationHash", "fiscalYear", "statement"} {
		if _, present := envelope.Data[key]; !present {
			t.Fatalf("narrowed statement lacks %s: %s", key, out)
		}
	}
	if _, whole := envelope.Data["trialBalance"]; whole {
		t.Fatal("a single statement carried the others too")
	}
	if !strings.Contains(string(envelope.Data["statement"]), `"netIncome":"10.00"`) || !strings.Contains(string(envelope.Data["bookRevision"]), "9007199254740993") {
		t.Fatalf("narrowing changed the figures or the pinned revision: %s", out)
	}
}

// --share income asks the service for each profit and loss line's share of total income. The command
// sends the contract's word as it is, and neither divides nor rounds: the figure is the service's.
func TestReportsSendsTheShareOfIncomeToTheProfitAndLossAndItsFile(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	for _, statement := range []string{"profit-loss", "all"} {
		sent = nil
		exit, out, _ := runReportsCLI(t, server, statement, "--as-of", "2026-06-30", "--compare", "previous-year", "--share", "income")
		if exit != 0 || !json.Valid([]byte(out)) {
			t.Fatalf("%s with a share failed: %d %s", statement, exit, out)
		}
		if len(sent) != 1 || sent[0].Path != "/v1/reports.get" || sent[0].Input["share"] != "income" || sent[0].Input["compare"] != "previousYear" {
			t.Fatalf("%s: the share did not reach the service: %+v", statement, sent)
		}
	}
	// The file is the service's, with the same word.
	sent = nil
	exit, out, _ := runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30", "--share", "income", "--format", "csv")
	if exit != 0 || out != exportContent {
		t.Fatalf("csv with a share: %d %q", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/reports.export" || sent[0].Input["share"] != "income" || sent[0].Input["statement"] != "profit-loss" {
		t.Fatalf("the file request did not carry the share: %+v", sent)
	}
	// Asking for none is asking for what a report is, and the spellings of the word are one word.
	sent = nil
	if exit, _, _ := runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30", "--share", "NONE"); exit != 0 || sent[0].Input["share"] != "none" {
		t.Fatalf("share none: %d %+v", exit, sent)
	}
	// Without the flag nothing about shares is sent.
	sent = nil
	if exit, _, _ := runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30"); exit != 0 {
		t.Fatal("a plain profit and loss failed")
	}
	if _, asked := sent[0].Input["share"]; asked {
		t.Fatalf("a share was sent that nobody asked for: %+v", sent[0].Input)
	}
}

// Only the profit and loss has a share, so the other statements refuse the flag before anything is
// sent, as they refuse --page, and a word the contract does not have is a usage error too.
func TestReportsRefusesAShareWhereThereIsNoIncomeToTakeOneOf(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	for name, args := range map[string][]string{
		"the trial balance":    {"trial-balance", "--as-of", "2026-06-30", "--share", "income"},
		"the balance sheet":    {"balance-sheet", "--as-of", "2026-06-30", "--share", "income"},
		"the cash flow":        {"cash-flow", "--as-of", "2026-06-30", "--share", "income"},
		"the general ledger":   {"general-ledger", "--as-of", "2026-06-30", "--share", "income"},
		"a csv of the balance": {"balance-sheet", "--as-of", "2026-06-30", "--share", "income", "--format", "csv"},
		"another word":         {"profit-loss", "--as-of", "2026-06-30", "--share", "revenue"},
		"a percent sign":       {"profit-loss", "--as-of", "2026-06-30", "--share", "%"},
		"no word":              {"profit-loss", "--as-of", "2026-06-30", "--share"},
	} {
		exit, out, diagnostics := runReportsCLI(t, server, args...)
		if exit != 2 || !json.Valid([]byte(out)) || !strings.Contains(out, `"usage_error"`) {
			t.Fatalf("%s: want a usage error, got %d %s", name, exit, out)
		}
		if diagnostics == "" {
			t.Fatalf("%s: nothing told the person what to do", name)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a refused command still reached the service: %+v", sent)
	}
}

func TestReportsAllKeepsEveryStatementAndTheOtherOperationsReachTheirOwn(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	if exit, out, _ := runReportsCLI(t, server, "all", "--as-of", "2026-06-30"); exit != 0 || !strings.Contains(out, `"trialBalance"`) || !strings.Contains(out, `"balanceSheet"`) {
		t.Fatalf("reports all lost a statement: %d %s", exit, out)
	}
	if exit, _, _ := runReportsCLI(t, server, "cash-flow", "--as-of", "2026-06-30", "--tags-revision", "7", "--compare", "previous-period"); exit != 0 {
		t.Fatal("cash flow failed")
	}
	if exit, _, _ := runReportsCLI(t, server, "general-ledger", "--as-of", "2026-06-30", "--page", "2", "--from", "2026-03-01"); exit != 0 {
		t.Fatal("general ledger failed")
	}
	if exit, out, _ := runReportsCLI(t, server, "calendar"); exit != 0 || !strings.Contains(out, `"firstDate":"2026-01-01"`) {
		t.Fatalf("calendar failed: %d %s", exit, out)
	}
	paths := []string{}
	for _, request := range sent {
		paths = append(paths, request.Path)
	}
	if strings.Join(paths, " ") != "/v1/reports.get /v1/reports.cashFlow /v1/reports.generalLedger /v1/reports.calendar" {
		t.Fatalf("wrong operations: %v", paths)
	}
	if sent[1].Input["tagsRevision"] != "7" || sent[1].Input["compare"] != "previousPeriod" {
		t.Fatalf("cash flow input: %v", sent[1].Input)
	}
	if page, isNumber := sent[2].Input["page"].(float64); !isNumber || page != 2 || sent[2].Input["from"] != "2026-03-01" {
		t.Fatalf("general ledger input: %v", sent[2].Input)
	}
	if len(sent[3].Input) != 0 {
		t.Fatalf("calendar takes no input: %v", sent[3].Input)
	}
}

func TestReportsCSVPrintsTheServicesFileExactlyAndNotAnEnvelope(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	exit, out, _ := runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30", "--from", "2026-01-01", "--format", "csv")
	if exit != 0 {
		t.Fatalf("csv failed: %d %s", exit, out)
	}
	if out != exportContent {
		t.Fatalf("the file changed on the way to the terminal:\n%q\n%q", out, exportContent)
	}
	if json.Valid([]byte(out)) || strings.Contains(out, `"version"`) {
		t.Fatal("CSV mode printed an envelope")
	}
	if len(sent) != 1 || sent[0].Path != "/v1/reports.export" || sent[0].Input["statement"] != "profit-loss" || sent[0].Input["from"] != "2026-01-01" {
		t.Fatalf("export request: %+v", sent)
	}
	if !strings.Contains(out, "'=cmd|") {
		t.Fatal("the neutralised cell was lost")
	}
	// Every statement that can be a file is exported through the same operation.
	for _, statement := range []string{"trial-balance", "balance-sheet", "cash-flow", "general-ledger"} {
		sent = nil
		if exit, _, _ := runReportsCLI(t, server, statement, "--as-of", "2026-06-30", "--format", "csv"); exit != 0 || len(sent) != 1 || sent[0].Path != "/v1/reports.export" || sent[0].Input["statement"] != statement {
			t.Fatalf("%s did not export: %+v", statement, sent)
		}
	}
}

func TestReportsRefusesWhatItCannotDoBeforeAskingTheService(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	for name, args := range map[string][]string{
		"no statement":           {"--as-of", "2026-06-30"},
		"unknown statement":      {"income-statement", "--as-of", "2026-06-30"},
		"no date":                {"profit-loss"},
		"bad comparison":         {"profit-loss", "--as-of", "2026-06-30", "--compare", "last-decade"},
		"a flag that is not for": {"profit-loss", "--as-of", "2026-06-30", "--page", "2"},
		"a bare flag":            {"profit-loss", "--as-of", "2026-06-30", "--from"},
		"a bad page":             {"general-ledger", "--as-of", "2026-06-30", "--page", "0"},
		"csv of everything":      {"all", "--as-of", "2026-06-30", "--format", "csv"},
		"csv of the calendar":    {"calendar", "--format", "csv"},
		"csv with a page":        {"general-ledger", "--as-of", "2026-06-30", "--page", "2", "--format", "csv"},
		"calendar with a date":   {"calendar", "--as-of", "2026-06-30"},
		"an unknown flag":        {"profit-loss", "--as-of", "2026-06-30", "--colour", "blue"},
		"a kind of nothing":      {"largest", "--as-of", "2026-06-30", "--kind", "asset"},
		"a limit of none":        {"largest", "--as-of", "2026-06-30", "--limit", "0"},
		"too large a limit":      {"largest", "--as-of", "2026-06-30", "--limit", "51"},
		"a limit in words":       {"largest", "--as-of", "2026-06-30", "--limit", "five"},
		"a basis for a ranking":  {"largest", "--as-of", "2026-06-30", "--basis", "cash"},
		"a kind on a statement":  {"profit-loss", "--as-of", "2026-06-30", "--kind", "expense"},
		"a ranking with no date": {"largest"},
		"a ranking as csv":       {"largest", "--as-of", "2026-06-30", "--format", "csv"},
	} {
		exit, out, diagnostics := runReportsCLI(t, server, args...)
		if exit != 2 || !json.Valid([]byte(out)) || !strings.Contains(out, `"usage_error"`) || strings.Contains(out, "\x1b") {
			t.Fatalf("%s: want a usage error, got %d %s", name, exit, out)
		}
		if diagnostics == "" {
			t.Fatalf("%s: nothing told the person what to do", name)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("a refused command still reached the service: %+v", sent)
	}
}

// reports largest is a ranking and not a statement: its reply is the service's, whole, and what it asks for is the range, the kind and how many.
func TestReportsLargestRanksTheEntriesAndSendsTheRangeKindAndLimit(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	exit, out, _ := runReportsCLI(t, server, "largest", "--as-of", "2026-03-31", "--from", "2026-03-01", "--kind", "income", "--limit", "2", "--revision", "9007199254740993")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("reports largest failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/reports.largest" {
		t.Fatalf("unexpected requests: %+v", sent)
	}
	want := map[string]any{"asOf": "2026-03-31", "from": "2026-03-01", "kind": "income", "limit": float64(2), "revision": "9007199254740993"}
	for key, value := range want {
		if sent[0].Input[key] != value {
			t.Fatalf("%s changed on the way: %v", key, sent[0].Input)
		}
	}
	if len(sent[0].Input) != len(want) {
		t.Fatalf("something else was sent: %v", sent[0].Input)
	}
	// Nothing is cut out of the reply: the rows and how many entries were ranked are the answer.
	var envelope struct {
		Data struct {
			Count int `json:"count"`
			Rows  []struct {
				Rank   int    `json:"rank"`
				Amount string `json:"amount"`
			} `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Count != 5 || len(envelope.Data.Rows) != 2 || envelope.Data.Rows[0].Rank != 1 || envelope.Data.Rows[0].Amount != "750.00" {
		t.Fatalf("the ranking was changed: %s", out)
	}
	// With only a date, the service chooses the kind (expense) and the number of rows (ten).
	sent = nil
	if exit, out, _ := runReportsCLI(t, server, "largest", "--as-of", "2026-03-31"); exit != 0 {
		t.Fatalf("%d %s", exit, out)
	}
	if len(sent) != 1 || len(sent[0].Input) != 1 || sent[0].Input["asOf"] != "2026-03-31" {
		t.Fatalf("a bare ranking asked for more than the date: %+v", sent)
	}
}

func TestReportsSurfacesTheServicesRefusalWithItsExitCode(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "basis_unavailable")
	exit, out, _ := runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30", "--basis", "accrual")
	if exit != 3 || !strings.Contains(out, `"basis_unavailable"`) {
		t.Fatalf("a refused basis should exit 3 with the code: %d %s", exit, out)
	}
	// CSV mode reports a failure the same way, as an envelope, never as an empty or partial file.
	exit, out, _ = runReportsCLI(t, server, "profit-loss", "--as-of", "2026-06-30", "--format", "csv")
	if exit != 3 || !strings.Contains(out, `"basis_unavailable"`) || strings.HasPrefix(out, "Report,") {
		t.Fatalf("csv failure: %d %s", exit, out)
	}
}

func TestCSVOutsideTheReportsCommandPointsAtIt(t *testing.T) {
	var sent []reportsRequest
	server := reportsServer(t, &sent, "")
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	exit := runner.Run(context.Background(), []string{"call", "reports.get", "--as-of", "2026-06-30", "--format", "csv", "--endpoint", server, "--request-dir", t.TempDir()})
	if exit != 2 || !strings.Contains(out.String(), "rastrata reports STATEMENT") {
		t.Fatalf("generic csv: %d %s", exit, out.String())
	}
	// The generic path still carries --as-of and --revision to every report operation.
	out.Reset()
	exit = runner.Run(context.Background(), []string{"call", "reports.cashFlow", "--as-of", "2026-06-30", "--revision", "5", "--endpoint", server, "--request-dir", t.TempDir()})
	if exit != 0 || len(sent) != 1 || sent[0].Input["asOf"] != "2026-06-30" || sent[0].Input["revision"] != "5" {
		t.Fatalf("call reports.cashFlow: %d %+v", exit, sent)
	}
}

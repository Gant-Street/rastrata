package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const countsJSON = `{"accounts":3,"mapped":2,"skipped":0,"unmapped":1,"unmappedWithBalance":1,"bank":1,"certain":1,"likely":1,"check":1}`

func chartPreviewJSON(name string) string {
	return `{"source":"file","name":` + jsonString(name) + `,"sha256":null,"importedAt":null,"rows":3,"columns":[{"field":"code","header":"*Code"}],` +
		`"accounts":[` +
		`{"row":2,"code":"090","name":` + jsonString(name) + `,"type":"Bank","typeLabel":"Bank","role":"asset","bank":true,"system":false,"taxCode":"x","balance":"12873.20","archived":false,"accountId":"1000","accountCode":"1000","accountName":"Business checking","skip":false,"basis":"name","confidence":"likely","candidates":[],"problems":[],"suggestion":null},` +
		`{"row":3,"code":"200","name":"Sales","type":"Revenue","typeLabel":"Revenue","role":"income","bank":false,"system":false,"taxCode":"x","balance":null,"archived":false,"accountId":"4000","accountCode":"4000","accountName":"Sales","skip":false,"basis":"saved","confidence":"certain","candidates":[],"problems":[],"suggestion":null},` +
		`{"row":4,"code":"820","name":"Sales Tax","type":"Sales Tax","typeLabel":"Sales Tax","role":"liability","bank":false,"system":true,"taxCode":"x","balance":"-95.00","archived":false,"accountId":null,"accountCode":null,"accountName":null,"skip":false,"basis":"none","confidence":"none","candidates":[{"accountId":"2500","code":"2500","name":"Sales tax payable"}],"problems":[],"suggestion":null}],` +
		`"counts":` + countsJSON + `,"issues":[{"severity":"warning","code":"unknown_type","message":"Row 5: odd type.","row":5}]}`
}

func chartImportedJSON(name string) string {
	return `{"preview":` + chartPreviewJSON(name) + `,"saved":2,"replaced":false}`
}

const tbPreviewJSON = `{"name":"tb.csv","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","organisation":"Harbor Studio LLC","asOf":"2026-07-31","layout":"period_and_ytd",` +
	`"rows":[{"row":7,"section":"Assets","xeroCode":"090","name":"Business checking","type":null,"net":"12873.20","status":"mapped","accountId":"1000","accountCode":"1000","accountName":"Business checking","balance":"12873.20"},` +
	`{"row":8,"section":"Revenue","xeroCode":"200","name":"Sales","type":null,"net":"-9800.00","status":"profit_loss","accountId":"4000","accountCode":"4000","accountName":"Sales","balance":null},` +
	`{"row":9,"section":"Assets","xeroCode":"999","name":"Mystery","type":null,"net":"400.00","status":"unmapped","accountId":null,"accountCode":null,"accountName":null,"balance":null}],` +
	`"sums":{"debit":"0.00","credit":"0.00","ytdDebit":"13273.20","ytdCredit":"13273.20"},"fileTotals":null,"balanced":true,` +
	`"balances":[{"accountId":"1000","balance":"12873.20"},{"accountId":"2000","balance":"523.10"}],` +
	`"leftOut":{"profitLoss":1,"profitLossNet":"-9800.00","unmapped":1,"unmappedNet":"400.00","skipped":0,"skippedNet":"0.00","retainedEarnings":"-3873.20"},` +
	`"cutover":{"date":"2026-08-01","dayBefore":"2026-07-31","asOfIsDayBefore":true},"columns":[],"issues":[{"severity":"warning","code":"unmapped_balances","message":"1 Xero account is not mapped."}]}`

func tieOutJSON(hostile string) string {
	return `{"currency":"USD","basis":"cash","cutoverDate":"2026-10-01","toleranceDays":4,"periods":[{"from":"2026-10-01","to":"2026-10-31","xeroReconciled":true,"notReconciled":[],"accounts":[` +
		`{"accountId":"1000","code":"1000","name":"Business checking","role":"asset","basis":"closing","status":"differs","reason":null,"xero":"10750.00","rastrata":"10700.01","difference":"-49.99","carried":"0.00","matched":2,` +
		`"unmatched":[{"side":"rastrata","date":"2026-10-20","description":` + jsonString(hostile) + `,"reference":"j-1","source":"","debit":"0.00","credit":"49.99"}],"unmatchedCount":1,"residual":"0.00","explained":true},` +
		`{"accountId":"4000","code":"4000","name":"Sales","role":"income","basis":"movement","status":"matches","reason":null,"xero":"1000.00","rastrata":"1000.00","difference":"0.00","carried":null,"matched":1,"unmatched":[],"unmatchedCount":0,"residual":"0.00","explained":false},` +
		`{"accountId":"6000","code":"6000","name":"Software","role":"expense","basis":"movement","status":"not_comparable","reason":{"code":"no_xero_counterpart","message":"No Xero account is mapped to this account."},"xero":null,"rastrata":"379.99","difference":null,"carried":null,"matched":0,"unmatched":null,"unmatchedCount":null,"residual":null,"explained":false}],` +
		`"unmapped":[{"code":"777","name":"Mystery","net":"12.30"}]}],` +
		`"summary":{"periods":1,"comparable":2,"matches":1,"differs":1,"explained":1,"unexplained":0,"notComparable":1,"linesOnlyInXero":0,"linesOnlyInRastrata":1},"notes":["A difference is Rastrata less Xero."]}`
}

const gapJSON = `{"id":7,"kind":"difference","title":"Rastrata only: 2026-10-20 49.99 credit","detail":"d","source":"tieout","status":"open","openedAt":"2026-11-05T10:00:00.000Z","openedBy":"owner","closedAt":null,"closedBy":null,"resolution":null}`
const closedGapJSON = `{"id":7,"kind":"difference","title":"Rastrata only: 2026-10-20 49.99 credit","detail":"d","source":"tieout","status":"closed","openedAt":"2026-11-05T10:00:00.000Z","openedBy":"owner","closedAt":"2026-11-06T10:00:00.000Z","closedBy":"owner","resolution":"Xero never got the line."}`

func writeFile(t *testing.T, name, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestXeroChartPreviewSendsTheFileAsTextAndSavesNothing(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"xero.chart.preview": chartPreviewJSON("Business Bank Account")}, &sent)
	file := writeFile(t, "chart.csv", "*Code,*Name,*Type\n090,Business Bank Account,Bank\n")
	exit, out, _ := runShadow(t, server, "", "xero", "chart", "--file", file, "--map", "820=2500, 400=6010", "--skip", "999")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("preview failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/xero.chart.preview" || sent[0].Request.OperationID != "" {
		t.Fatalf("a preview is a read: %+v", sent)
	}
	input := inputOf(t, sent[0])
	if input["text"] != "*Code,*Name,*Type\n090,Business Bank Account,Bank\n" || input["name"] != "chart.csv" {
		t.Fatalf("the file must be sent as it is, with its name: %v", input)
	}
	overrides := input["overrides"].([]any)
	if len(overrides) != 3 || overrides[0].(map[string]any)["accountId"] != "2500" || overrides[2].(map[string]any)["skip"] != true {
		t.Fatalf("wrong overrides: %v", overrides)
	}
}

func TestXeroChartImportRetainsTheRequestAndAsksForWhatItSaves(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"xero.chart.import": chartImportedJSON("x")}, &sent)
	file := writeFile(t, "chart.csv", "*Code,*Name,*Type\n090,Bank,Bank\n")
	exit, out, diagnostics := runShadow(t, server, "", "xero", "chart", "--file", file, "--import", "--accept", "likely", "--skip-unreadable")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("import failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/xero.chart.import" || sent[0].Request.OperationID == "" || !strings.Contains(diagnostics, "Retaining") {
		t.Fatalf("an import is a retained write: %+v %s", sent, diagnostics)
	}
	input := inputOf(t, sent[0])
	if input["accept"] != "likely" || input["skipUnreadable"] != true {
		t.Fatalf("wrong input: %v", input)
	}
}

func TestXeroChartTextShowsHowSureEachMatchIsAndNeverPrintsControlCharacters(t *testing.T) {
	var sent []sentRequest
	hostile := "Operating\x1b[31m RED ‮\nsecond"
	server := shadowServer(t, map[string]string{"xero.chart.preview": chartPreviewJSON(hostile)}, &sent)
	file := writeFile(t, "chart.csv", "x")
	exit, out, _ := runShadow(t, server, "", "xero", "chart", "--file", file, "--format", "text")
	// The file has a warning, not an error: it exits 0, and says nothing was saved.
	if exit != 0 {
		t.Fatalf("text failed: %d %s", exit, out)
	}
	for _, want := range []string{"likely", "chosen", "Not mapped:", "could be: 2500 Sales tax payable", "Nothing was saved", "row 5: Row 5: odd type.", `Columns read: "*Code" as code`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	for _, bad := range []string{"\x1b", "‮"} {
		if strings.Contains(out, bad) {
			t.Errorf("a control or direction character reached the terminal: %q", bad)
		}
	}
}

func TestXeroUsageErrorsNeverReachTheService(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"xero.chart.preview": chartPreviewJSON("x"), "xero.status": `{}`}, &sent)
	file := writeFile(t, "f.csv", "x")
	large := writeFile(t, "large.csv", strings.Repeat("x", 130000))
	binary := writeFile(t, "binary.csv", "\xff\xfe\x00\x01")
	cases := [][]string{
		{"xero", "status", "extra"},
		{"xero", "chart", "--import"},
		{"xero", "chart", "--file", file, "--map", "820"},
		{"xero", "chart", "--file", file, "--map", "=2500"},
		{"xero", "chart", "--file", file, "--accept", "maybe", "--import"},
		{"xero", "chart", "--file", file, "--accept", "likely"},
		{"xero", "chart", "--file", large},
		{"xero", "chart", "--file", binary},
		{"xero", "chart", "--file", filepath.Join(t.TempDir(), "missing.csv")},
		{"xero", "chart", "--file", file, "--typo", "x"},
		{"xero", "mapping", "set"},
		{"xero", "trial-balance"},
		{"xero", "trial-balance", "--file", file, "--date-order", "ymd"},
		{"xero", "transactions", "--file", file, "--date-order", "weird"},
		{"xero", "reconciled", "--set", "090"},
		{"xero", "reconciled", "--set", "=2026-08-31"},
		{"xero", "tie-out", "--tolerance", "40"},
		{"xero", "tie-out", "--tolerance", "x"},
		{"gaps", "add"},
		{"gaps", "close", "7"},
		{"gaps", "close", "seven", "--resolution", "ok"},
		{"gaps", "close", "--resolution", "ok"},
		{"gaps", "list", "--status", "maybe"},
	}
	for _, args := range cases {
		if exit, out, _ := runShadow(t, server, "", args...); exit != 2 || !json.Valid([]byte(out)) {
			t.Errorf("%v: expected a usage error, got %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("nothing may reach the service: %+v", sent)
	}
}

func TestXeroTrialBalanceBalancesOnlyIsTheListOpeningReviewTakes(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"xero.trialBalance.preview": tbPreviewJSON}, &sent)
	file := writeFile(t, "tb.csv", "Account,Debit\n")
	exit, out, _ := runShadow(t, server, "", "xero", "trial-balance", "--file", file, "--balances-only", "--statement", "1000=12000.00, 2500=10.00", "--as-of", "2026-07-31", "--include-profit-loss", "--date-order", "mdy")
	if exit != 0 || strings.TrimSpace(out) != "1000=12000.00,2000=523.10,2500=10.00" {
		t.Fatalf("the statement balance replaces the account's own, and a new one is added: %d %q", exit, out)
	}
	input := inputOf(t, sent[0])
	if sent[0].Path != "/v1/xero.trialBalance.preview" || input["asOf"] != "2026-07-31" || input["includeProfitLoss"] != true || input["dateOrder"] != "mdy" || input["name"] != "tb.csv" {
		t.Fatalf("wrong request: %s %v", sent[0].Path, input)
	}
}

func TestXeroTrialBalanceTextSaysWhatWasLeftOutAndExitsWithRejectionWhenItDoesNotBalance(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"xero.trialBalance.preview": tbPreviewJSON}, &sent)
	file := writeFile(t, "tb.csv", "x")
	exit, out, _ := runShadow(t, server, "", "xero", "trial-balance", "--file", file, "--format", "text")
	if exit != 0 {
		t.Fatalf("a balanced file is fine: %d %s", exit, out)
	}
	for _, want := range []string{"balances", "this is that day", "NOT MAPPED (net 400.00)", "income or expense: left out (net -9,800.00)", "Xero's retained earnings: -3,873.20", "--statement ID=AMOUNT", "1 Xero account is not mapped."} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	unbalanced := strings.Replace(tbPreviewJSON, `"balanced":true`, `"balanced":false`, 1)
	server = shadowServer(t, map[string]string{"xero.trialBalance.preview": unbalanced}, &sent)
	if exit, out, _ := runShadow(t, server, "", "xero", "trial-balance", "--file", file, "--format", "text"); exit != 3 || !strings.Contains(out, "DOES NOT BALANCE") {
		t.Fatalf("a trial balance that does not balance is a rejection: %d %s", exit, out)
	}
}

func TestXeroReconciledSetsDatesAndShowsWhereItStands(t *testing.T) {
	var sent []sentRequest
	state := `{"entries":[{"code":"090","name":"Business Bank Account","through":"2026-10-31","note":"from the reconcile screen","setAt":"2026-11-01T00:00:00.000Z"}]}`
	server := shadowServer(t, map[string]string{"xero.reconciled.set": state}, &sent)
	exit, out, _ := runShadow(t, server, "", "xero", "reconciled", "--set", "090=2026-10-31, 092=2026-10-15", "--clear", "091", "--note", "from the reconcile screen", "--format", "text")
	if exit != 0 || !strings.Contains(out, "090") || !strings.Contains(out, "2026-10-31") {
		t.Fatalf("failed: %d %s", exit, out)
	}
	input := inputOf(t, sent[0])
	choices := input["choices"].([]any)
	if sent[0].Request.OperationID == "" || len(choices) != 2 || choices[1].(map[string]any)["through"] != "2026-10-15" || choices[0].(map[string]any)["note"] != "from the reconcile screen" || input["clear"].([]any)[0] != "091" {
		t.Fatalf("wrong request: %+v %v", sent[0], input)
	}
}

func TestXeroTieOutTextShowsDifferencesLineByLineAndIsSafeToPrint(t *testing.T) {
	var sent []sentRequest
	hostile := "Domain\x1b[2J ‮\nsecond line"
	server := shadowServer(t, map[string]string{"tieout.report": tieOutJSON(hostile)}, &sent)
	exit, out, _ := runShadow(t, server, "", "xero", "tie-out", "--tolerance", "2", "--from", "2026-10-01", "--format", "text")
	if exit != 0 {
		t.Fatalf("failed: %d %s", exit, out)
	}
	if sent[0].Request.OperationID != "" || inputOf(t, sent[0])["toleranceDays"] != float64(2) || inputOf(t, sent[0])["from"] != "2026-10-01" {
		t.Fatalf("the report is a read with its options: %+v %v", sent[0], inputOf(t, sent[0]))
	}
	for _, want := range []string{"differs by -49.99 (explained to the cent)", "only in Rastrata", "49.99 credit", "matches", "not comparable: No Xero account is mapped", "Xero was reconciled through its end", "Xero account 777 Mystery holds 12.30", "Note: A difference is Rastrata less Xero."} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	for _, bad := range []string{"\x1b", "‮"} {
		if strings.Contains(out, bad) {
			t.Errorf("a control or direction character reached the terminal: %q", bad)
		}
	}
}

func TestXeroTieOutRecordAddsToTheGapLog(t *testing.T) {
	var sent []sentRequest
	recorded := `{"summary":{"periods":1,"comparable":2,"matches":1,"differs":1,"explained":1,"unexplained":0,"notComparable":1,"linesOnlyInXero":0,"linesOnlyInRastrata":1},"added":1,"existing":2,"gaps":[` + gapJSON + `]}`
	server := shadowServer(t, map[string]string{"tieout.record": recorded}, &sent)
	exit, out, _ := runShadow(t, server, "", "xero", "tie-out", "--record", "--format", "text")
	if exit != 0 || sent[0].Path != "/v1/tieout.record" || sent[0].Request.OperationID == "" || !strings.Contains(out, "Added 1 to the gap log (2 were already there)") || !strings.Contains(out, "#7") {
		t.Fatalf("recording is a retained write: %d %s %+v", exit, out, sent)
	}
}

func TestGapsCloseNeedsANoteAndReopenNeedsNone(t *testing.T) {
	var sent []sentRequest
	server := shadowServer(t, map[string]string{"gaps.update": closedGapJSON, "gaps.list": `{"gaps":[` + closedGapJSON + `,` + gapJSON + `],"open":1,"closed":1}`, "gaps.add": gapJSON}, &sent)
	exit, out, _ := runShadow(t, server, "", "gaps", "close", "7", "--resolution", "Xero never got the line.", "--format", "text")
	if exit != 0 || !strings.Contains(out, "closed by owner: Xero never got the line.") {
		t.Fatalf("close failed: %d %s", exit, out)
	}
	input := inputOf(t, sent[0])
	if input["id"] != float64(7) || input["status"] != "closed" || input["resolution"] != "Xero never got the line." || sent[0].Request.OperationID == "" {
		t.Fatalf("wrong request: %v", input)
	}
	if exit, _, _ := runShadow(t, server, "", "gaps", "reopen", "7"); exit != 0 || inputOf(t, sent[1])["status"] != "open" {
		t.Fatalf("reopen: %d %v", exit, inputOf(t, sent[1]))
	}
	if exit, out, _ := runShadow(t, server, "", "gaps", "list", "--status", "all", "--format", "text"); exit != 0 || !strings.Contains(out, "1 open, 1 closed.") {
		t.Fatalf("list: %d %s", exit, out)
	}
	if exit, out, _ := runShadow(t, server, "", "gaps", "add", "--title", "Xero tracks projects", "--kind", "feature", "--detail", "We have no tracking categories", "--format", "text"); exit != 0 || !strings.Contains(out, "#7") {
		t.Fatalf("add: %d %s", exit, out)
	}
	added := inputOf(t, sent[3])
	if added["title"] != "Xero tracks projects" || added["kind"] != "feature" || added["detail"] != "We have no tracking categories" {
		t.Fatalf("wrong add: %v", added)
	}
}

func TestXeroStatusTextShowsTheMappingAndWhereXeroWasReconciled(t *testing.T) {
	var sent []sentRequest
	status := `{"chartImportedAt":"2026-11-01T00:00:00.000Z","counts":` + countsJSON + `,"files":[{"seq":3,"kind":"chart","name":"chart.csv","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","organisation":null,"asOf":null,"from":null,"to":null,"rows":3,"importedAt":"2026-11-01T00:00:00.000Z"}],` +
		`"trialBalances":["2026-09-30","2026-10-31"],"transactions":[{"from":"2026-10-01","to":"2026-10-31","accounts":4,"lines":8}],` +
		`"reconciled":[{"code":"090","name":"Business Bank Account","through":"2026-10-31","note":"","setAt":"2026-11-01T00:00:00.000Z"}],"cutoverDate":"2026-10-01","notes":["1 Xero account is not mapped (1 with a balance)."]}`
	server := shadowServer(t, map[string]string{"xero.status": status}, &sent)
	exit, out, _ := runShadow(t, server, "", "xero", "status", "--format", "text")
	if exit != 0 {
		t.Fatalf("status failed: %d %s", exit, out)
	}
	for _, want := range []string{"Mapping: 3 accounts, 2 mapped (1 certain, 1 likely)", "Trial balances kept, as at: 2026-09-30, 2026-10-31", "(8 lines)", "Business Bank Account", "#3", "Note: 1 Xero account is not mapped"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}

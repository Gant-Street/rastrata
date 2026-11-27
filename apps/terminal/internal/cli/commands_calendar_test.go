package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const calendarHash = "1111111111111111111111111111111111111111111111111111111111111111"

// extensionPlanJSON satisfies the PreparedOperation contract for an extension.
func extensionPlanJSON(id string, valid bool) string {
	state := "true"
	if !valid {
		state = "false"
	}
	return `{"disposition":"prepared","operationId":"` + id + `","outcomeSequence":null,"diagnostics":[],"problems":[],` +
		`"planId":"` + id + `","planHash":"` + calendarHash + `","bookRevision":"1","kind":"extendCalendar","valid":` + state + `,` +
		`"effects":{"journals":[],"accounts":[],"periods":[],"calendar":[` +
		`{"periodId":"period-2027-01","fiscalYear":2027,"label":"January","startsOn":"2027-01-01","endsOn":"2027-01-31"},` +
		`{"periodId":"period-2027-12","fiscalYear":2027,"label":"December","startsOn":"2027-12-01","endsOn":"2027-12-31"}]}}`
}

func closePlanJSON(id string) string {
	return `{"disposition":"prepared","operationId":"` + id + `","outcomeSequence":null,"diagnostics":[],"problems":[],` +
		`"planId":"` + id + `","planHash":"` + calendarHash + `","bookRevision":"7","kind":"closePeriod","valid":true,` +
		`"effects":{"journals":[],"accounts":[],"periods":[{"periodId":"period-01","kind":"close","reason":"Year end FY2026 (1 of 1): Reviewed"}]}}`
}

// yearEndPlanJSON satisfies the YearEndPlan contract: one open period and one check needing attention.
func yearEndPlanJSON(id string) string {
	return `{"disposition":"prepared","operationId":"` + id + `","planId":"` + id + `","planHash":"` + calendarHash + `",` +
		`"bookRevision":"7","fiscalYear":2026,"startsOn":"2026-01-01","endsOn":"2026-01-31","reason":"Reviewed","valid":true,` +
		`"openCount":1,"supersededCount":0,"closedCount":0,"diagnostics":[],"problems":[],` +
		`"steps":[{"order":1,"periodId":"period-01","label":"January","startsOn":"2026-01-01","endsOn":"2026-01-31","status":"open","closeSuperseded":false,"plans":[` + closePlanJSON("5d5d5d5d-0000-5000-8000-000000000001") + `]}],` +
		`"checks":[{"id":"drafts","label":"No unposted drafts dated in the year","status":"attention","detail":"1 unposted draft is dated in fiscal year 2026."}],` +
		`"statements":{"asOf":"2026-01-31","periodStart":"2026-01-01","currency":"USD","basis":"accrual","compilerVersion":"rastrata-core-report-v2",` +
		`"populationHash":"` + calendarHash + `","debit":"10.00","credit":"10.00","balanced":true,"revenue":"10.00","expenses":"0.00","netIncome":"10.00",` +
		`"assets":"10.00","liabilities":"0.00","equity":"10.00","priorEarnings":"0.00","currentEarnings":"10.00"}}`
}

// yearEndReviewJSON satisfies the YearEndReview contract.
const yearEndReviewJSON = `{"bookRevision":"7","today":"2027-02-10","fiscalYear":2026,"startsOn":"2026-01-01","endsOn":"2026-01-31",` +
	`"openCount":1,"supersededCount":0,"closedCount":0,"periods":[{"order":1,"periodId":"period-01","label":"January","startsOn":"2026-01-01","endsOn":"2026-01-31","status":"open","closeSuperseded":false,"ended":true,"beforeBooks":false}],` +
	`"checks":[{"id":"drafts","label":"No unposted drafts dated in the year","status":"pass","detail":"Every journal dated in this year is posted or discarded."}],` +
	`"statements":{"asOf":"2026-01-31","periodStart":"2026-01-01","currency":"USD","basis":"accrual","compilerVersion":"rastrata-core-report-v2",` +
	`"populationHash":"` + calendarHash + `","debit":"10.00","credit":"10.00","balanced":true,"revenue":"10.00","expenses":"0.00","netIncome":"10.00",` +
	`"assets":"10.00","liabilities":"0.00","equity":"10.00","priorEarnings":"0.00","currentEarnings":"10.00"}}`

func yearEndReceiptJSON(id, disposition string) string {
	return `{"disposition":"` + disposition + `","operationId":"` + id + `","outcomeSequence":"9","diagnostics":[],"problems":[],` +
		`"planId":"` + id + `","planHash":"` + calendarHash + `","fiscalYear":2026,"closedCount":1,"totalCount":1,` +
		`"steps":[{"periodId":"period-01","kind":"closePeriod","disposition":"` + disposition + `","outcomeSequence":"9","diagnostics":[],"problems":[]}]}`
}

// calendarServer answers the calendar operations like the application and records what the CLI sent.
func calendarServer(t *testing.T, validPlan bool, receipt string, sent *[]sentRequest) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		*sent = append(*sent, sentRequest{Path: r.URL.Path, Request: request})
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "operationId": request.OperationID}
		var planID struct {
			PlanID string `json:"planId"`
		}
		_ = json.Unmarshal(request.Input, &planID)
		switch r.URL.Path {
		case "/v1/periods.extend", "/v1/periods.changeYearStart":
			envelope["data"] = json.RawMessage(extensionPlanJSON(request.OperationID, validPlan))
		case "/v1/periods.yearEnd":
			envelope["data"] = json.RawMessage(yearEndPlanJSON(request.OperationID))
		case "/v1/periods.yearEndReview":
			envelope["data"] = json.RawMessage(yearEndReviewJSON)
		case "/v1/operations.commit":
			envelope["data"] = json.RawMessage(`{"disposition":"` + receipt + `","operationId":"` + planID.PlanID + `","outcomeSequence":"9","diagnostics":[],"problems":[]}`)
		case "/v1/periods.commitYearEnd":
			envelope["data"] = json.RawMessage(yearEndReceiptJSON(request.OperationID, receipt))
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func runPeriods(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"periods"}, args...)
	all = append(all, "--endpoint", server, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func calendarInput(t *testing.T, request sentRequest) map[string]any {
	t.Helper()
	var input map[string]any
	if err := json.Unmarshal(request.Request.Input, &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestPeriodsExtendPreparesWithTheFiscalYearAndRetainsTheIdentity(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runPeriods(t, server, "extend", "--through", "2028", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) || strings.Count(strings.TrimSpace(out), "\n") != 0 {
		t.Fatalf("extend failed or printed more than one envelope: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/periods.extend" || sent[0].Request.OperationID != id {
		t.Fatalf("a prepare is one call with the identity: %+v", sent)
	}
	if input := calendarInput(t, sent[0]); input["through"] != float64(2028) || len(input) != 1 {
		t.Fatalf("the fiscal year changed on the way: %v", input)
	}
	if !strings.Contains(diagnostics, id) || !strings.Contains(out, `"kind":"extendCalendar"`) {
		t.Fatal("the identity was not announced or the plan not printed")
	}
}

func TestPeriodsExtendWithoutAYearSendsAnEmptyRequest(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	if exit, _, _ := runPeriods(t, server, "extend"); exit != 0 {
		t.Fatal("extend failed")
	}
	if input := calendarInput(t, sent[0]); len(input) != 0 {
		t.Fatalf("omitting --through must send no year: %v", input)
	}
}

func TestPeriodsExtendCommitCommitsExactlyThePlanItPrepared(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	exit, out, diagnostics := runPeriods(t, server, "extend", "--commit", "--plan-hash", calendarHash)
	if exit != 0 {
		t.Fatalf("extend --commit failed: %d %s", exit, out)
	}
	if len(sent) != 2 || sent[0].Path != "/v1/periods.extend" || sent[1].Path != "/v1/operations.commit" {
		t.Fatalf("expected prepare then commit: %+v", sent)
	}
	commit := calendarInput(t, sent[1])
	if commit["planId"] != sent[0].Request.OperationID || commit["planHash"] != calendarHash {
		t.Fatalf("committed something other than the prepared plan: %v", commit)
	}
	if !strings.Contains(out, `"disposition":"committed"`) || strings.Contains(out, "extendCalendar") {
		t.Fatalf("stdout must carry the receipt only: %s", out)
	}
	if !strings.Contains(diagnostics, "adds 2 periods, 2027-01-01 to 2027-12-31") {
		t.Fatalf("the person was not told what is being committed: %s", diagnostics)
	}
}

func TestPeriodsExtendCommitRefusesAPlanThatIsNotTheOneReviewed(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	other := strings.Repeat("2", 64)
	exit, out, _ := runPeriods(t, server, "extend", "--commit", "--plan-hash", other)
	if exit != 3 || !strings.Contains(out, "plan_hash_conflict") {
		t.Fatalf("a different plan must be refused with exit 3: %d %s", exit, out)
	}
	if len(sent) != 1 {
		t.Fatalf("nothing may be committed: %+v", sent)
	}
}

func TestPeriodsExtendNeverCommitsAnInvalidPlan(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, false, "committed", &sent)
	exit, out, _ := runPeriods(t, server, "extend", "--commit")
	if exit != 3 || !strings.Contains(out, `"valid":false`) {
		t.Fatalf("an invalid plan is printed and exits 3: %d %s", exit, out)
	}
	if len(sent) != 1 {
		t.Fatalf("an invalid plan must not be committed: %+v", sent)
	}
}

func TestPeriodsExtendRejectedCommitExitsThree(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "rejected", &sent)
	if exit, _, _ := runPeriods(t, server, "extend", "--commit"); exit != 3 {
		t.Fatalf("a rejected commit must exit 3, got %d", exit)
	}
}

func TestPeriodsExtendUsageErrorsNeverCallTheService(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	for _, args := range [][]string{
		{"extend", "--through", "1999"},
		{"extend", "--through", "2101"},
		{"extend", "--through", "next"},
		{"extend", "--through"},
		{"extend", "--commit", "2027"},
		{"extend", "--plan-hash", calendarHash},
		{"extend", "--bogus", "1"},
		{"extend", "2027"},
	} {
		if exit, out, _ := runPeriods(t, server, args...); exit != 2 || !strings.Contains(out, "usage_error") {
			t.Fatalf("%v should be a usage error: %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("usage errors reached the service: %+v", sent)
	}
}

func TestPeriodsYearEndPreparesWithoutCommitting(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	exit, out, _ := runPeriods(t, server, "year-end", "2026", "--reason", "  Reviewed with the accountant  ")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("year-end failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/periods.yearEnd" {
		t.Fatalf("a prepare is one call: %+v", sent)
	}
	input := calendarInput(t, sent[0])
	if input["fiscalYear"] != float64(2026) || input["reason"] != "Reviewed with the accountant" {
		t.Fatalf("year or reason changed on the way: %v", input)
	}
}

func TestPeriodsYearEndReviewOnlyReadsAndNeedsNoReasonOrIdentity(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	exit, out, diagnostics := runPeriods(t, server, "year-end", "2026", "--review")
	if exit != 0 || !json.Valid([]byte(out)) || !strings.Contains(out, `"checks"`) {
		t.Fatalf("review failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/periods.yearEndReview" || sent[0].Request.OperationID != "" {
		t.Fatalf("a review is one read with no identity: %+v", sent)
	}
	if input := calendarInput(t, sent[0]); input["fiscalYear"] != float64(2026) || len(input) != 1 {
		t.Fatalf("the year changed on the way: %v", input)
	}
	if strings.Contains(diagnostics, "Retaining") {
		t.Fatal("a read retains nothing")
	}
}

func TestPeriodsYearEndCommitDerivesItsIdentityFromTheRequestSoARerunResumes(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	id := api.NewOperationID()
	runOnce := func() (int, string, string) {
		return runPeriods(t, server, "year-end", "2026", "--reason", "Reviewed", "--commit", "--operation-id", id, "--plan-hash", calendarHash)
	}
	exit, out, diagnostics := runOnce()
	if exit != 0 || !strings.Contains(out, `"closedCount":1`) {
		t.Fatalf("year-end --commit failed: %d %s", exit, out)
	}
	if len(sent) != 2 || sent[1].Path != "/v1/periods.commitYearEnd" {
		t.Fatalf("expected prepare then commit: %+v", sent)
	}
	if sent[1].Request.OperationID != derivedOperationID(id, "commit") || sent[1].Request.OperationID == id {
		t.Fatalf("the commit identity must be derived from the request identity: %s", sent[1].Request.OperationID)
	}
	if commit := calendarInput(t, sent[1]); commit["planId"] != id || commit["planHash"] != calendarHash {
		t.Fatalf("committed something other than the prepared plan: %v", commit)
	}
	if !strings.Contains(diagnostics, "Needs attention: No unposted drafts dated in the year") ||
		!strings.Contains(diagnostics, "1 periods in order") {
		t.Fatalf("the checklist was not surfaced: %s", diagnostics)
	}
	// Run again after an interruption: the same request derives the same identities.
	if exit, _, _ := runOnce(); exit != 0 {
		t.Fatal("the rerun failed")
	}
	if len(sent) != 4 || sent[2].Request.OperationID != id || sent[3].Request.OperationID != sent[1].Request.OperationID {
		t.Fatalf("a rerun must reuse both identities: %+v", sent)
	}
}

func TestPeriodsYearEndRejectedCommitExitsThree(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "rejected", &sent)
	if exit, out, _ := runPeriods(t, server, "year-end", "2026", "--reason", "Reviewed", "--commit"); exit != 3 || !strings.Contains(out, `"rejected"`) {
		t.Fatalf("a rejected year-end must exit 3: %d %s", exit, out)
	}
}

func TestPeriodsYearEndNeedsAYearAndAReason(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	for _, args := range [][]string{
		{"year-end"},
		{"year-end", "--reason", "x"},
		{"year-end", "next", "--reason", "x"},
		{"year-end", "1999", "--reason", "x"},
		{"year-end", "2026"},
		{"year-end", "2026", "--reason"},
		{"year-end", "2026", "--reason", "   "},
		{"year-end", "2026", "--reason", strings.Repeat("x", 401)},
		{"year-end", "2026", "--reason", "x", "--commit", "2027"},
		{"year-end", "2026", "--review", "--reason", "x"},
		{"year-end", "2026", "--review", "--commit"},
		{"year-end", "2026", "--review", "yes"},
		{"year-end", "2026", "--reason", "x", "--plan-hash", calendarHash},
		{"year-end", "2026", "--reason", "x", "--bogus", "1"},
	} {
		if exit, out, _ := runPeriods(t, server, args...); exit != 2 || !strings.Contains(out, "usage_error") {
			t.Fatalf("%v should be a usage error: %d %s", args, exit, out)
		}
	}
	if len(sent) != 0 {
		t.Fatalf("usage errors reached the service: %+v", sent)
	}
}

func TestDerivedOperationIDsAreDeterministicUUIDsThatDifferByPurposeAndSeed(t *testing.T) {
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seed := api.NewOperationID()
	a, b := derivedOperationID(seed, "commit"), derivedOperationID(seed, "commit")
	if a != b || !uuid.MatchString(a) {
		t.Fatalf("not a stable UUID: %s %s", a, b)
	}
	if a == derivedOperationID(seed, "other") || a == derivedOperationID(api.NewOperationID(), "commit") {
		t.Fatal("identities must differ by purpose and by seed")
	}
}

func TestPeriodsYearStartSendsTheMonthAndRefusesABadOne(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	id := api.NewOperationID()
	exit, out, _ := runPeriods(t, server, "year-start", "10", "--operation-id", id)
	if exit != 0 || !json.Valid([]byte(out)) || strings.Count(strings.TrimSpace(out), "\n") != 0 {
		t.Fatalf("year-start failed or printed more than one envelope: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].Path != "/v1/periods.changeYearStart" || sent[0].Request.OperationID != id {
		t.Fatalf("a prepare is one call with the identity: %+v", sent)
	}
	if input := calendarInput(t, sent[0]); input["fiscalYearStartMonth"] != float64(10) || len(input) != 1 {
		t.Fatalf("the month changed on the way: %v", input)
	}
	for _, bad := range []string{"0", "13", "october"} {
		sent = nil
		if exit, _, _ := runPeriods(t, server, "year-start", bad); exit != 2 || len(sent) != 0 {
			t.Fatalf("%q must be a usage error before anything is sent: exit %d, sent %d", bad, exit, len(sent))
		}
	}
}

func TestPeriodsYearStartCommitCommitsExactlyThePlanItPrepared(t *testing.T) {
	var sent []sentRequest
	server := calendarServer(t, true, "committed", &sent)
	exit, out, _ := runPeriods(t, server, "year-start", "4", "--commit", "--plan-hash", calendarHash)
	if exit != 0 {
		t.Fatalf("year-start --commit failed: %d %s", exit, out)
	}
	if len(sent) != 2 || sent[0].Path != "/v1/periods.changeYearStart" || sent[1].Path != "/v1/operations.commit" {
		t.Fatalf("expected prepare then commit: %+v", sent)
	}
	commit := calendarInput(t, sent[1])
	if commit["planId"] != sent[0].Request.OperationID || commit["planHash"] != calendarHash {
		t.Fatalf("committed something other than the prepared plan: %v", commit)
	}
}

// historyServer answers the upload and the two history operations like the application: the file is
// kept by its SHA-256, a preview says what it holds, and an import posts `chunk` entries a call until the
// file's entries are all in, or refuses one at `failAt`.
type historyServer struct {
	total, posted, chunk, failAt int
	// limitCap, when set, refuses a call that asks for more entries than it, as a hosted book does when a
	// call packs to more than the tail keeps.
	limitCap int
	limits   []int
	calls    int
	sent     []sentRequest
	uploaded map[string]string
}

func (s *historyServer) start(t *testing.T) string {
	t.Helper()
	s.uploaded = map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if r.URL.Path == "/v1/uploads" {
			body, _ := io.ReadAll(r.Body)
			sum := sha256.Sum256(body)
			sha := hex.EncodeToString(sum[:])
			s.uploaded[sha] = string(body)
			envelope["data"] = map[string]any{"sha256": sha, "size": len(body), "mediaType": "text/csv"}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		s.sent = append(s.sent, sentRequest{Path: r.URL.Path, Request: request})
		switch r.URL.Path {
		case "/v1/history.preview":
			envelope["data"] = map[string]any{
				"file": strings.Repeat("a", 64), "entries": s.total, "lines": s.total * 2, "firstDate": "2016-01-05", "lastDate": "2025-12-20",
				"dateOrder": "ymd", "dateOrderAssumed": false, "unmapped": 0, "adding": 0, "ready": true, "remaining": s.total - s.posted,
				"alreadyImported": s.posted, "problemCount": 0, "problems": []any{}, "conflicts": []any{}, "startsBefore": "2016-01-05",
				"years":    []any{map[string]any{"fiscalYear": 2016, "from": "2016-01-05", "to": "2016-12-20", "entries": s.total, "lines": s.total * 2, "total": "100.00"}},
				"accounts": []any{map[string]any{"label": "1000 Cash", "code": "1000", "name": "Cash", "lines": 2, "account": "1000", "accountName": "Cash", "add": nil, "suggestedRole": nil, "suggestedAccount": nil}},
			}
		case "/v1/history.import":
			envelope["operationId"] = request.OperationID
			var asked struct {
				Limit int `json:"limit"`
			}
			_ = json.Unmarshal(request.Input, &asked)
			s.limits = append(s.limits, asked.Limit)
			if s.limitCap > 0 && asked.Limit > s.limitCap {
				w.WriteHeader(413)
				_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
					"error": map[string]any{"code": "entry_too_large", "message": "That is more than can be saved in one go.", "details": []any{}, "retryable": false}})
				return
			}
			s.calls++
			take := s.chunk
			if asked.Limit > 0 && asked.Limit < take {
				take = asked.Limit
			}
			if s.total-s.posted < take {
				take = s.total - s.posted
			}
			data := map[string]any{"imported": take, "total": s.total, "failed": nil, "booksBegan": "2016-01-05"}
			if s.failAt > 0 && s.posted+take >= s.failAt {
				take = s.failAt - 1 - s.posted
				data["imported"] = take
				data["failed"] = map[string]any{"key": "E-" + strconv.Itoa(s.failAt), "date": "2019-03-10", "code": "period_closed", "message": "That period is closed."}
			}
			s.posted += take
			data["importedTotal"] = s.posted
			data["remaining"] = s.total - s.posted
			data["done"] = s.posted == s.total
			envelope["data"] = data
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

func runHistory(t *testing.T, url string, args ...string) (int, string, string) {
	t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"history"}, args...)
	all = append(all, "--endpoint", url, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func historyFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "history.csv")
	if err := os.WriteFile(path, []byte("Date,Account,Debit,Credit\n2016-01-05,1000,10.00,\n2016-01-05,4000,,10.00\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHistoryPreviewUploadsOnceAndNamesTheFileByItsHash(t *testing.T) {
	server := &historyServer{total: 240, chunk: 200}
	url := server.start(t)
	file := historyFile(t)
	exit, out, diagnostics := runHistory(t, url, "preview", file, "--date-order", "mdy")
	if exit != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("preview failed: %d %s", exit, out)
	}
	if len(server.sent) != 1 || server.sent[0].Path != "/v1/history.preview" {
		t.Fatalf("a preview is one call: %+v", server.sent)
	}
	input := calendarInput(t, server.sent[0])
	sum := sha256.Sum256([]byte(server.uploaded[input["file"].(string)]))
	if len(server.uploaded) != 1 || input["file"] != hex.EncodeToString(sum[:]) || input["dateOrder"] != "mdy" {
		t.Fatalf("the file was not named by its hash, or the order changed on the way: %v", input)
	}
	if !strings.Contains(diagnostics, "240 entries (480 lines), 2016-01-05 to 2025-12-20") || !strings.Contains(diagnostics, "Ready: 240 of 240") {
		t.Fatalf("the summary is missing: %s", diagnostics)
	}
}

func TestHistoryMapFileSendsAnAccountCodeOrAskForANewAccountWithAPlus(t *testing.T) {
	server := &historyServer{total: 10, chunk: 10}
	url := server.start(t)
	mapPath := filepath.Join(t.TempDir(), "map.json")
	if err := os.WriteFile(mapPath, []byte(`{"Sales": "4000", "Bank Fees": "+expense"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if exit, out, _ := runHistory(t, url, "preview", historyFile(t), "--map-file", mapPath); exit != 0 {
		t.Fatalf("preview failed: %d %s", exit, out)
	}
	pairs, _ := calendarInput(t, server.sent[0])["map"].([]any)
	if len(pairs) != 2 {
		t.Fatalf("both accounts must be sent: %v", pairs)
	}
	fees, _ := pairs[0].(map[string]any)
	sales, _ := pairs[1].(map[string]any)
	if fees["account"] != "Bank Fees" || fees["add"] != "expense" || fees["to"] != nil {
		t.Fatalf("a plus asks for a new account of that kind: %v", fees)
	}
	if sales["account"] != "Sales" || sales["to"] != "4000" || sales["add"] != nil {
		t.Fatalf("a code names an account of the book: %v", sales)
	}
}

func TestHistoryImportCallsUntilTheFileIsInAndSaysHowFarItGot(t *testing.T) {
	server := &historyServer{total: 450, chunk: 200}
	url := server.start(t)
	exit, out, diagnostics := runHistory(t, url, "import", historyFile(t), "--limit", "200")
	if exit != 0 || !json.Valid([]byte(out)) || strings.Count(strings.TrimSpace(out), "\n") != 0 {
		t.Fatalf("import failed or printed more than one envelope: %d %s", exit, out)
	}
	if server.calls != 3 || server.posted != 450 {
		t.Fatalf("expected three calls to post 450 entries, got %d calls and %d posted", server.calls, server.posted)
	}
	if !strings.Contains(diagnostics, "Imported 200 of 450 entries.") || !strings.Contains(diagnostics, "Imported 450 of 450 entries.") {
		t.Fatalf("progress was not said: %s", diagnostics)
	}
	if !strings.Contains(out, `"done":true`) {
		t.Fatalf("stdout must carry the last answer: %s", out)
	}
	// Each call is its own request with its own identity, so a lost reply is never the same as the next call.
	ids := map[string]bool{}
	for _, request := range server.sent {
		ids[request.Request.OperationID] = true
	}
	if len(ids) != 3 {
		t.Fatalf("every chunk needs its own operation identity: %v", ids)
	}
}

func TestHistoryImportAsksForFewerEntriesWhenTheBookSaysACallWasTooBig(t *testing.T) {
	server := &historyServer{total: 300, chunk: 1000, limitCap: 25}
	url := server.start(t)
	exit, out, _ := runHistory(t, url, "import", historyFile(t))
	if exit != 0 || !strings.Contains(out, `"done":true`) {
		t.Fatalf("the import must finish by asking for less: %d %s", exit, out)
	}
	// It starts at 20, asks for 40, is refused, and goes on with 20: no call over the book's limit is posted.
	if server.limits[0] != 20 || server.limits[1] != 40 || server.limits[2] != 20 {
		t.Fatalf("the limits asked for were %v", server.limits)
	}
	for _, calls := range server.limits[3:] {
		if calls > 20 {
			t.Fatalf("after a refusal the command must not ask for more than the book took: %v", server.limits)
		}
	}
}

func TestHistoryImportStopsAtTheEntryTheBookRefusesAndSaysWhich(t *testing.T) {
	server := &historyServer{total: 450, chunk: 200, failAt: 250}
	url := server.start(t)
	exit, _, diagnostics := runHistory(t, url, "import", historyFile(t), "--limit", "200")
	if exit != 3 {
		t.Fatalf("a refused entry is exit 3, got %d", exit)
	}
	if server.calls != 2 || !strings.Contains(diagnostics, "Stopped at entry E-250 dated 2019-03-10: That period is closed.") {
		t.Fatalf("the stop was not said: %d calls, %s", server.calls, diagnostics)
	}
}

func TestHistoryRefusesWhatItCannotSendBeforeSendingAnything(t *testing.T) {
	server := &historyServer{total: 1, chunk: 1}
	url := server.start(t)
	for _, args := range [][]string{
		{"import"},
		{"preview", historyFile(t), "--date-order", "yesterday"},
		{"import", historyFile(t), "--limit", "9999"},
		{"preview", historyFile(t), "--limit", "5"},
		{"preview", "/no/such/file.csv"},
	} {
		if exit, _, _ := runHistory(t, url, args...); exit != 2 {
			t.Fatalf("%v must be a usage error: exit %d", args, exit)
		}
	}
	if len(server.sent) != 0 || len(server.uploaded) != 0 {
		t.Fatalf("nothing may be sent for a usage error: %+v", server.sent)
	}
}

func TestHistoryTieOutNeedsADateAndNamesTheFile(t *testing.T) {
	server := &historyServer{total: 1, chunk: 1}
	url := server.start(t)
	if exit, _, _ := runHistory(t, url, "tie-out", historyFile(t)); exit != 2 {
		t.Fatalf("a tie-out without --as-of is a usage error, got %d", exit)
	}
	if exit, _, _ := runHistory(t, url, "tie-out", historyFile(t), "--as-of", "last year"); exit != 2 {
		t.Fatalf("a date that is not a date is a usage error, got %d", exit)
	}
	if len(server.sent) != 0 {
		t.Fatalf("nothing may be sent for a usage error: %+v", server.sent)
	}
}

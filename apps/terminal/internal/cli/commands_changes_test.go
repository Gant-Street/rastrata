package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// changeListJSON is a list the contract accepts: two changes (one by an agent, one nobody recorded the
// maker of), a source that could not be read, and what the list leaves out.
const changeListJSON = `{"revision":"12","asOf":"2026-04-02T12:00:00.000Z",` +
	`"window":{"since":"the last time the changes were marked as looked at (Apr 1, 2026)","sinceRevision":"9","sinceAt":"2026-04-01T09:00:00.000Z","until":null},` +
	`"count":3,"page":1,"pageSize":2,"changes":[` +
	`{"id":"ledger:12","at":"2026-04-02T11:00:00.000Z","revision":"12","kind":"entry.posted","summary":"Posted No. 5, Mar 20, 2026: Coffee 4.85",` +
	`"subject":{"kind":"journal","id":"j1"},"by":{"kind":"agent","label":"weekly-run","id":"abc"},"how":"Posted from For review"},` +
	`{"id":"ledger:11","at":"2026-04-02T10:00:00.000Z","revision":"11","kind":"period.closed","summary":"Closed March 2026 (reason: done).",` +
	`"subject":{"kind":"period","id":"period-03"},"by":{"kind":"unknown","label":"not recorded"},"how":"How it was committed was not recorded"}],` +
	`"actors":[{"by":{"kind":"agent","label":"weekly-run","id":"abc"},"count":1},{"by":{"kind":"unknown","label":"not recorded"},"count":2}],` +
	`"sources":[{"name":"ledger","title":"The books","read":true,"reason":null,"changes":3},` +
	`{"name":"access","title":"Who has access","read":false,"reason":"Agent keys were not read: this sign-in may not manage access.","changes":0}],` +
	`"notCovered":["Changes to 1099 vendors","Changes to the book's settings"],"attribution":{"fromRevision":"10","fromAt":"2026-04-01T08:00:00.000Z"},"lastReview":null}`

const changeReviewJSON = `{"seq":1,"at":"2026-04-02T12:00:00.000Z","by":{"kind":"owner","label":"owner"},` +
	`"upToRevision":"12","upToAt":"2026-04-02T12:00:00.000Z","note":"Looked at it"}`

func changesInput(t *testing.T, request api.Request) map[string]any {
	t.Helper()
	var input map[string]any
	if err := json.Unmarshal(request.Input, &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestChangesAskedWithNoOptionsReadsTheWholeBookAndPrintsTheEnvelope(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"changes.list": changeListJSON}, &sent)
	exit, out, _ := runTax(t, server, "changes")
	if exit != 0 || !json.Valid([]byte(out)) || !strings.Contains(out, `"summary":"Posted No. 5, Mar 20, 2026: Coffee 4.85"`) {
		t.Fatalf("changes failed: %d %s", exit, out)
	}
	if len(sent) != 1 || sent[0].OperationID != "" || string(sent[0].Input) != "{}" {
		t.Fatalf("a read of everything is one call with no options and no identity: %+v", sent)
	}
}

func TestChangesSendsEveryOptionAsTheContractNamesIt(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"changes.list": changeListJSON}, &sent)
	exit, _, diagnostics := runTax(t, server, "changes", "--since", "last-review", "--until", "2026-03-31",
		"--kind", "entry.posted,period.closed", "--by", "agent:weekly-run", "--text", "coffee",
		"--page", "2", "--page-size", "10", "--revision", "12", "--read-at", "2026-04-02T12:00:00.000Z")
	if exit != 0 {
		t.Fatalf("changes failed: %d %q", exit, diagnostics)
	}
	input := changesInput(t, sent[0])
	by, _ := input["by"].(map[string]any)
	kinds, _ := input["kinds"].([]any)
	if input["since"] != "lastReview" || input["until"] != "2026-03-31" || input["text"] != "coffee" ||
		input["page"] != float64(2) || input["pageSize"] != float64(10) || input["revision"] != "12" ||
		input["asOf"] != "2026-04-02T12:00:00.000Z" || by["kind"] != "agent" || by["label"] != "weekly-run" ||
		len(kinds) != 2 || kinds[0] != "entry.posted" || kinds[1] != "period.closed" || len(input) != 9 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestChangesByNamesAMakerByNameOrByIdentifier(t *testing.T) {
	cases := map[string]map[string]any{
		"agent":                {"kind": "agent"},
		"agent:weekly-run":     {"kind": "agent", "label": "weekly-run"},
		"agent@tok_7f3a91c2":   {"kind": "agent", "id": "tok_7f3a91c2"},
		"person:a@b: the name": {"kind": "person", "label": "a@b: the name"},
		"person@user_3":        {"kind": "person", "id": "user_3"},
	}
	for given, want := range cases {
		var sent []api.Request
		server := taxServer(t, map[string]string{"changes.list": changeListJSON}, &sent)
		if exit, _, diagnostics := runTax(t, server, "changes", "--by", given); exit != 0 {
			t.Fatalf("--by %s failed: %d %q", given, exit, diagnostics)
		}
		by, _ := changesInput(t, sent[0])["by"].(map[string]any)
		if len(by) != len(want) {
			t.Fatalf("--by %s must be sent as %v, was %v", given, want, by)
		}
		for key, value := range want {
			if by[key] != value {
				t.Fatalf("--by %s must be sent as %v, was %v", given, want, by)
			}
		}
	}
}

func TestChangesSinceTakesTheTwoNamedPointsARevisionOrADate(t *testing.T) {
	for given, sent := range map[string]string{
		"last-review": "lastReview", "last-close": "lastClose", "41": "41", "2026-03-01": "2026-03-01",
	} {
		var requests []api.Request
		server := taxServer(t, map[string]string{"changes.list": changeListJSON}, &requests)
		if exit, _, diagnostics := runTax(t, server, "changes", "--since", given); exit != 0 {
			t.Fatalf("--since %s failed: %d %q", given, exit, diagnostics)
		}
		if got := changesInput(t, requests[0])["since"]; got != sent {
			t.Fatalf("--since %s must be sent as %s, was %v", given, sent, got)
		}
	}
}

func TestChangesRefusesWhatItCannotSendBeforeSendingAnything(t *testing.T) {
	cases := map[string][]string{
		"an unknown option":        {"changes", "--sinse", "last-review"},
		"a since that is none":     {"changes", "--since", "yesterday"},
		"an until that is none":    {"changes", "--until", "last-close"},
		"a kind that is none":      {"changes", "--kind", "entry.posted,entry.bogus"},
		"a maker that is none":     {"changes", "--by", "robot"},
		"a maker with no name":     {"changes", "--by", "agent:"},
		"a maker with no id":       {"changes", "--by", "agent@"},
		"a page of zero":           {"changes", "--page", "0"},
		"a page size that is text": {"changes", "--page-size", "many"},
		"a pin that is not a time": {"changes", "--read-at", "yesterday"},
		"a revision that is text":  {"changes", "--revision", "latest"},
		"an option with no value":  {"changes", "--text"},
		"a word after the command": {"changes", "last-review"},
	}
	for name, args := range cases {
		var sent []api.Request
		server := taxServer(t, map[string]string{"changes.list": changeListJSON}, &sent)
		exit, out, _ := runTax(t, server, args...)
		if exit != 2 || !strings.Contains(out, `"usage_error"`) || len(sent) != 0 {
			t.Fatalf("%s: want exit 2 and nothing sent, got %d %s (%d sent)", name, exit, out, len(sent))
		}
	}
}

func TestChangesAsTextPrintsTheLinesAPersonReadsAndWhatWasNotRead(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"changes.list": changeListJSON}, &sent)
	exit, out, _ := runTax(t, server, "changes", "--format", "text")
	if exit != 0 {
		t.Fatalf("text failed: %d %s", exit, out)
	}
	for _, want := range []string{
		"Changes since the last time the changes were marked as looked at (Apr 1, 2026): 3",
		"2026-04-02T11:00:00.000Z  weekly-run          Posted No. 5, Mar 20, 2026: Coffee 4.85",
		"2026-04-02T10:00:00.000Z  not recorded        Closed March 2026 (reason: done).",
		"(page 1 shows 2 of 3; use --page)",
		"Not read in full: Who has access. Agent keys were not read: this sign-in may not manage access.",
		"Not covered by this list: Changes to 1099 vendors; Changes to the book's settings.",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
}

func TestChangesReviewMarksWhatIsInTheBookNowAndSaysHowMuch(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"changes.list": changeListJSON, "changes.review": changeReviewJSON}, &sent)
	id := api.NewOperationID()
	exit, out, diagnostics := runTax(t, server, "changes", "review", "--note", "Looked at it", "--operation-id", id)
	if exit != 0 || !strings.Contains(out, `"upToRevision":"12"`) {
		t.Fatalf("review failed: %d %s %q", exit, out, diagnostics)
	}
	if len(sent) != 2 || sent[0].OperationID != "" || sent[1].OperationID != id {
		t.Fatalf("a read of what is new, then a retained review under the identity: %+v", sent)
	}
	read := changesInput(t, sent[0])
	if read["since"] != "lastReview" || read["pageSize"] != float64(1) {
		t.Fatalf("the read must ask what is new since the last look: %s", sent[0].Input)
	}
	review := changesInput(t, sent[1])
	if review["upToRevision"] != "12" || review["upToAt"] != "2026-04-02T12:00:00.000Z" || review["note"] != "Looked at it" {
		t.Fatalf("the review must carry the point that was read: %s", sent[1].Input)
	}
	if !strings.Contains(diagnostics, "Marking the 3 changes since the last look, up to revision 12, as looked at.") ||
		!strings.Contains(diagnostics, "Retaining "+id) {
		t.Fatalf("the count, the point and the identity must be said: %q", diagnostics)
	}
}

func TestChangesReviewOfAPointYouNameReadsNothingFirst(t *testing.T) {
	var sent []api.Request
	server := taxServer(t, map[string]string{"changes.review": changeReviewJSON}, &sent)
	exit, _, diagnostics := runTax(t, server, "changes", "review", "--up-to-revision", "12", "--up-to-time", "2026-04-02T12:00:00.000Z")
	if exit != 0 || len(sent) != 1 {
		t.Fatalf("review failed: %d %q (%d calls)", exit, diagnostics, len(sent))
	}
	review := changesInput(t, sent[0])
	if review["upToRevision"] != "12" || review["upToAt"] != "2026-04-02T12:00:00.000Z" || len(review) != 2 {
		t.Fatalf("wrong input: %s", sent[0].Input)
	}
}

func TestChangesReviewRefusesHalfAPointAndAMalformedOne(t *testing.T) {
	for name, args := range map[string][]string{
		"a revision with no time": {"changes", "review", "--up-to-revision", "12"},
		"a time with no revision": {"changes", "review", "--up-to-time", "2026-04-02T12:00:00.000Z"},
		"a revision that is text": {"changes", "review", "--up-to-revision", "latest", "--up-to-time", "2026-04-02T12:00:00.000Z"},
		"an unknown option":       {"changes", "review", "--everything"},
		"a word after it":         {"changes", "review", "now"},
	} {
		var sent []api.Request
		server := taxServer(t, map[string]string{"changes.list": changeListJSON, "changes.review": changeReviewJSON}, &sent)
		exit, out, _ := runTax(t, server, args...)
		if exit != 2 || !strings.Contains(out, `"usage_error"`) || len(sent) != 0 {
			t.Fatalf("%s: want exit 2 and nothing sent, got %d %s (%d sent)", name, exit, out, len(sent))
		}
	}
}

func TestChangesReviewByAnAgentIsRefusedByTheServiceAndSaidAsItWas(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		name := strings.TrimPrefix(r.URL.Path, "/v1/")
		if name == "changes.list" {
			_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "data": json.RawMessage(changeListJSON)})
			return
		}
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
			"error": map[string]any{"code": "review_needs_a_person", "message": "Only a person can mark changes as looked at.", "details": []any{}, "retryable": false},
		})
	}))
	t.Cleanup(server.Close)
	exit, out, diagnostics := runTax(t, server.URL, "changes", "review")
	if exit != 3 || !strings.Contains(out, `"review_needs_a_person"`) || !strings.Contains(diagnostics, "Only a person can mark changes as looked at") {
		t.Fatalf("the refusal must be printed and exit 3: %d %s %q", exit, out, diagnostics)
	}
}

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(server.URL, "local-book", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return client
}
func TestClientPersistsBeforeDispatchAndResumesExactBytes(t *testing.T) {
	id := NewOperationID()
	var original string
	calls := 0
	var client *Client
	client = testClient(t, func(w http.ResponseWriter, r *http.Request) {
		record, err := client.Journal.Load(id)
		if err != nil {
			t.Errorf("request was not durable before dispatch: %v", err)
		}
		var request Request
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		body, _ := json.Marshal(request)
		if string(record.Body) != string(body) {
			t.Error("retained bytes differ")
		}
		if calls == 0 {
			original = string(body)
			calls++
			w.WriteHeader(503)
			fmt.Fprint(w, "connection lost")
			return
		}
		if string(body) != original {
			t.Error("resume changed bytes")
		}
		calls++
		data := SavedDraft{ID: "draft-one", Version: 1, Status: "draft", Data: JournalDraftData{Date: "2026-01-15", Reference: "OPEN", Narration: "Owner contribution", Lines: []JournalLine{{AccountID: "1000", Debit: "1000.00", Credit: ""}, {AccountID: "3000", Debit: "", Credit: "1000.00"}}}}
		raw, _ := json.Marshal(data)
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: true, OperationID: request.OperationID, Data: raw})
	})
	input := DraftCreateInput{Data: JournalDraftData{Date: "2026-01-15", Reference: "OPEN", Narration: "Owner contribution", Lines: []JournalLine{{AccountID: "1000", Debit: "1000.00", Credit: ""}, {AccountID: "3000", Debit: "", Credit: "1000.00"}}}}
	_, err := client.DraftsCreate(context.Background(), input, id)
	if err == nil {
		t.Fatal("expected interrupted response")
	}
	replacement, err := New(client.Endpoint, client.BookID, client.Journal.Directory)
	if err != nil {
		t.Fatal(err)
	}
	response, err := replacement.Resume(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK || calls != 2 {
		t.Fatal("resume failed")
	}
	input.Data.Reference = "DIFFERENT"
	if _, err := replacement.DraftsCreate(context.Background(), input, id); err == nil {
		t.Fatal("changed input reused identity")
	}
	if calls != 2 {
		t.Fatal("conflicting request reached server")
	}
	info, err := os.Stat(client.Journal.Directory)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("request journal must be private")
	}
}
func TestScopeVersionAndRedirectCannotBeAccepted(t *testing.T) {
	for _, mode := range []string{"scope", "version", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if mode == "redirect" {
					http.Redirect(w, r, "/other", 302)
					return
				}
				version, book := Version, "local-book"
				if mode == "scope" {
					book = "other"
				} else {
					version = "future"
				}
				_ = json.NewEncoder(w).Encode(Response{Version: version, BookID: book, OK: true, Data: json.RawMessage(`{}`)})
			})
			if _, err := client.BookGet(context.Background(), Empty{}, ""); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
func TestInputValidationCannotSendNumericAmountsOrUnknownFields(t *testing.T) {
	calls := 0
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) })
	input := map[string]any{"data": map[string]any{"date": "2026-01-15", "reference": "x", "narration": "x", "lines": []any{map[string]any{"accountId": "1000", "debit": 1, "credit": ""}, map[string]any{"accountId": "3000", "debit": "", "credit": "1.00"}}}}
	_, err := client.Call(context.Background(), "drafts.create", input, "")
	if err == nil || !strings.Contains(err.Error(), "input.data.lines[0].debit") {
		t.Fatalf("missing field error: %v", err)
	}
	_, err = client.Call(context.Background(), "book.get", map[string]any{"actorId": "root"}, "")
	if err == nil || calls != 0 {
		t.Fatal("malformed input reached server")
	}
}
func TestPreparationAndCommitUseSeparateRetainedPhases(t *testing.T) {
	journal := Journal{Directory: t.TempDir()}
	id := NewOperationID()
	request := Request{Version: Version, BookID: "local-book", OperationID: id, Input: json.RawMessage(`{"draftId":"draft-one","expectedVersion":1}`)}
	body, _ := json.Marshal(request)
	if err := journal.Retain(Record{Endpoint: "http://127.0.0.1:4010", BookID: "local-book", Name: "journal.prepare", OperationID: id, Body: body}); err != nil {
		t.Fatal(err)
	}
	request.Input = json.RawMessage(`{"planId":"` + id + `","planHash":"` + strings.Repeat("a", 64) + `"}`)
	body, _ = json.Marshal(request)
	if err := journal.Retain(Record{Endpoint: "http://127.0.0.1:4010", BookID: "local-book", Name: "operations.commit", OperationID: id, Body: body}); err != nil {
		t.Fatal(err)
	}
	record, err := journal.Load(id)
	if err != nil || record.Name != "operations.commit" {
		t.Fatal("resume must prefer submitted commit")
	}
}

// A sandbox that cannot write to the user's cache folder must not leave an agent with a bare operating
// system error: the command sends nothing and says which setting to change.
func TestAnUnwritableRequestJournalSaysWhatToDoAndSendsNothing(t *testing.T) {
	sent := false
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) { sent = true })
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A folder inside a regular file can never be made, as one inside a read-only home cannot be.
	client.Journal.Directory = filepath.Join(blocker, "requests")
	_, err := client.Call(context.Background(), "drafts.create", map[string]any{"data": map[string]any{"date": "2026-01-15", "reference": "x", "narration": "x", "lines": []any{map[string]any{"accountId": "1000", "debit": "1.00", "credit": ""}, map[string]any{"accountId": "3000", "debit": "", "credit": "1.00"}}}}, "")
	var failure *Error
	if !errors.As(err, &failure) || failure.Response.Error == nil {
		t.Fatalf("expected a failure, got %v", err)
	}
	if failure.Response.Error.Code != "request_journal_unwritable" {
		t.Fatalf("code %q", failure.Response.Error.Code)
	}
	for _, want := range []string{"RASTRATA_REQUEST_DIR", "--request-dir", "sent nothing", blocker} {
		if !strings.Contains(failure.Response.Error.Message, want) {
			t.Errorf("the message does not say %q: %s", want, failure.Response.Error.Message)
		}
	}
	if sent {
		t.Fatal("a write whose request could not be kept was sent")
	}
}

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The SimpleFIN setup token is a credential that works once. The service claims it and keeps what
// comes back in a private file of its own, so the CLI never needs to keep the request: and a journal
// of requests is a place a secret would sit, readable by anything with the user's files, long after.

const journalFixtureToken = "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9GSVhUVVJFLUpPVVJOQUwtMDAwMQ=="

func TestTheSetupTokenIsNeverWrittenToTheRequestJournal(t *testing.T) {
	directory := t.TempDir()
	var received string
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var request Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		received = string(request.Input)
		// The journal is where the CLI would have kept it before sending: it must be empty even now.
		if entries, _ := os.ReadDir(directory); len(entries) != 0 {
			t.Errorf("the token was written to the journal before it was sent: %v", entries)
		}
		reply := `{"connected":true,"host":"beta-bridge.simplefin.org","accounts":[],"accountsError":null}`
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: true, OperationID: request.OperationID, Data: json.RawMessage(reply)})
	})
	client.Journal = &Journal{Directory: directory}
	if _, err := client.Call(context.Background(), "bankfeed.connect", map[string]any{"setupToken": journalFixtureToken}, ""); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	if !strings.Contains(received, journalFixtureToken) {
		t.Fatal("the service must receive the token")
	}
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		data, _ := os.ReadFile(filepath.Join(directory, entry.Name()))
		if strings.Contains(string(data), journalFixtureToken) {
			t.Fatalf("%s holds the setup token", entry.Name())
		}
	}
	if len(entries) != 0 {
		t.Fatalf("nothing about connect is journaled: %v", entries)
	}
}

func TestAFailedConnectLeavesNothingInTheJournalAndNoTokenInTheError(t *testing.T) {
	directory := t.TempDir()
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var request Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		w.WriteHeader(409)
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: false, OperationID: request.OperationID,
			Error: &Failure{Code: "bankfeed_token_rejected", Message: "SimpleFIN says this setup token does not exist or has already been used.", Details: []FieldError{}}})
	})
	client.Journal = &Journal{Directory: directory}
	_, err := client.Call(context.Background(), "bankfeed.connect", map[string]any{"setupToken": journalFixtureToken}, "")
	if err == nil || strings.Contains(err.Error(), journalFixtureToken) {
		t.Fatalf("error: %v", err)
	}
	if entries, _ := os.ReadDir(directory); len(entries) != 0 {
		t.Fatalf("a failed connect must not be journaled: %v", entries)
	}
}

func TestOtherWritesAreStillJournaledBeforeTheyAreSent(t *testing.T) {
	directory := t.TempDir()
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var request Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		reply := `{"account":null,"unlinked":false}`
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: true, OperationID: request.OperationID, Data: json.RawMessage(reply)})
	})
	client.Journal = &Journal{Directory: directory}
	if _, err := client.Call(context.Background(), "bankfeed.unlink", map[string]any{"accountId": "ACT-1"}, ""); err != nil {
		t.Fatalf("unlink failed: %v", err)
	}
	if entries, _ := os.ReadDir(directory); len(entries) == 0 {
		t.Fatal("every other write keeps its exact request, so a lost reply can be resumed")
	}
}

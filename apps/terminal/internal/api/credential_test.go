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

const (
	testToken    = "rst_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	testOwnerKey = "rso_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
)

func environment(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func writeKey(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "owner.key")
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCredentialIsTheTokenFirstThenTheOwnerKeyThenNothing(t *testing.T) {
	keyFile := writeKey(t, testOwnerKey+"\n", 0o600)
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"nothing set", map[string]string{}, ""},
		{"a token", map[string]string{TokenVariable: testToken}, testToken},
		{"a token with surrounding space", map[string]string{TokenVariable: "  " + testToken + "\n"}, testToken},
		{"the owner key file", map[string]string{OwnerKeyFileVariable: keyFile}, testOwnerKey},
		// An agent that inherited the owner's environment still acts as its own token.
		{"both: the token wins", map[string]string{TokenVariable: testToken, OwnerKeyFileVariable: keyFile}, testToken},
	}
	for _, c := range cases {
		got, err := CredentialFromEnvironment(environment(c.env))
		if err != nil || got != c.want {
			t.Errorf("%s: got %q, %v", c.name, got, err)
		}
	}
}

func TestCredentialProblemsAreExplainedWithoutEchoingTheValue(t *testing.T) {
	secret := "rst_not-really-a-token-but-sensitive-looking-text-0000000000000"
	_, err := CredentialFromEnvironment(environment(map[string]string{TokenVariable: secret}))
	if err == nil || strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "agent token") {
		t.Fatalf("bad token message: %v", err)
	}
	// A token in the owner-key file, a key in the token variable, and loose permissions are all refused.
	for name, setup := range map[string]func() map[string]string{
		"a token where the owner key belongs": func() map[string]string {
			return map[string]string{OwnerKeyFileVariable: writeKey(t, testToken, 0o600)}
		},
		"a key where the token belongs": func() map[string]string { return map[string]string{TokenVariable: testOwnerKey} },
		"a group-readable owner key file": func() map[string]string {
			return map[string]string{OwnerKeyFileVariable: writeKey(t, testOwnerKey, 0o640)}
		},
		"a world-readable owner key file": func() map[string]string {
			return map[string]string{OwnerKeyFileVariable: writeKey(t, testOwnerKey, 0o644)}
		},
		"a missing owner key file": func() map[string]string {
			return map[string]string{OwnerKeyFileVariable: filepath.Join(t.TempDir(), "missing")}
		},
		"a directory instead of the key file": func() map[string]string { return map[string]string{OwnerKeyFileVariable: t.TempDir()} },
		"an empty owner key file":             func() map[string]string { return map[string]string{OwnerKeyFileVariable: writeKey(t, "\n", 0o600)} },
	} {
		got, err := CredentialFromEnvironment(environment(setup()))
		if err == nil || got != "" {
			t.Errorf("%s: accepted (%q)", name, got)
			continue
		}
		for _, secret := range []string{testToken, testOwnerKey} {
			if strings.Contains(err.Error(), secret) {
				t.Errorf("%s: message echoes a credential: %v", name, err)
			}
		}
	}
}

func TestLooksLikeTokenCatchesCredentialsPastedWhereANameBelongs(t *testing.T) {
	for _, text := range []string{testToken, testOwnerKey, "my laptop " + testToken} {
		if !LooksLikeToken(text) {
			t.Errorf("missed %q", text)
		}
	}
	for _, text := range []string{"Claude Code", "rst_", "the rst_ prefix", "rso_", ""} {
		if LooksLikeToken(text) {
			t.Errorf("flagged %q", text)
		}
	}
}

func TestClientSendsTheCredentialAsABearerTokenAndOnlyThen(t *testing.T) {
	var seen []string
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: true, Data: json.RawMessage(`{}`)})
	})
	// Output the schema does not accept fails; the point here is the header, so use a failure reply.
	client.Credential = ""
	_, _ = client.BookGet(context.Background(), Empty{}, "")
	client.Credential = testToken
	_, _ = client.BookGet(context.Background(), Empty{}, "")
	if len(seen) != 2 || seen[0] != "" || seen[1] != "Bearer "+testToken {
		t.Fatalf("headers: %q", seen)
	}
}

func TestTheCredentialIsNeverWrittenToTheRequestJournalOrAnError(t *testing.T) {
	directory := t.TempDir()
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	})
	client.Credential = testToken
	client.Journal = &Journal{Directory: directory}
	_, err := client.Call(context.Background(), "drafts.create", map[string]any{"data": map[string]any{"date": "2026-01-15", "reference": "x", "narration": "x", "lines": []any{map[string]any{"accountId": "1000", "debit": "1.00", "credit": ""}, map[string]any{"accountId": "3000", "debit": "", "credit": "1.00"}}}}, "")
	if err == nil || strings.Contains(err.Error(), testToken) {
		t.Fatalf("error: %v", err)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) == 0 {
		t.Fatal("the request was not retained")
	}
	for _, entry := range entries {
		data, _ := os.ReadFile(filepath.Join(directory, entry.Name()))
		if strings.Contains(string(data), testToken) || strings.Contains(string(data), "Bearer") {
			t.Fatalf("%s holds a credential", entry.Name())
		}
	}
}

func TestATokenCreationReplyIsNeverRetainedButItsRequestIs(t *testing.T) {
	directory := t.TempDir()
	secret := "rst_fedcba9876543210_" + strings.Repeat("Z", 43)
	var identity string
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var request Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		identity = request.OperationID
		data := `{"token":{"id":"fedcba9876543210","prefix":"rst_fedcba9876543210","label":"Agent","permissions":["read"],"status":"active","createdAt":"2026-10-04T00:00:00.000Z","createdBy":"owner","expiresAt":"2027-01-02T00:00:00.000Z","revokedAt":null,"revokedReason":null,"lastUsedAt":null},"secret":"` + secret + `"}`
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: true, OperationID: request.OperationID, Data: json.RawMessage(data)})
	})
	client.Journal = &Journal{Directory: directory}
	response, err := client.Call(context.Background(), "tokens.create", map[string]any{"label": "Agent", "permissions": []string{"read"}}, "")
	if err != nil || !strings.Contains(string(response.Data), secret) {
		t.Fatalf("the caller must receive the secret once: %v", err)
	}
	entries, _ := os.ReadDir(directory)
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
		data, _ := os.ReadFile(filepath.Join(directory, entry.Name()))
		if strings.Contains(string(data), secret) {
			t.Fatalf("%s holds the token secret", entry.Name())
		}
	}
	// The exact request is retained (so a lost reply can be resumed), the reply is not.
	if len(names) != 1 || names[0] != identity+".request.json" {
		t.Fatalf("journal: %v", names)
	}
}

func TestOutputsMayGainFieldsButRequestsAndKnownFieldsStayStrict(t *testing.T) {
	operation, _ := FindOperation("book.get")
	reply := `{"enabled":true,"bookId":"local-book","setup":null,"mode":"local","permissions":["read"],"head":null,"aFieldAddedLater":{"any":"thing"}}`
	if err := ValidateOutput([]byte(reply), operation.Output, "output"); err != nil {
		t.Fatalf("an additive output field must be tolerated: %v", err)
	}
	if err := Validate([]byte(reply), operation.Output, "output"); err == nil {
		t.Fatal("strict validation must still refuse an unknown field")
	}
	if err := ValidateOutput([]byte(`{"enabled":"yes","bookId":"local-book","setup":null,"mode":"local","permissions":[],"head":null}`), operation.Output, "output"); err == nil {
		t.Fatal("a known field with the wrong type must still be refused")
	}
	if err := ValidateOutput([]byte(`{"bookId":"local-book","setup":null,"mode":"local","permissions":[],"head":null}`), operation.Output, "output"); err == nil {
		t.Fatal("a missing required field must still be refused")
	}
	create, _ := FindOperation("drafts.create")
	if err := Validate([]byte(`{"data":{"date":"2026-01-15","reference":"x","narration":"x","lines":[]},"extra":1}`), create.Input, "input"); err == nil {
		t.Fatal("requests stay strict")
	}
}

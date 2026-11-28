package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const (
	multiKey1 = "rsa_1111111111111111_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	multiKey2 = "rsa_2222222222222222_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
)

func TestMultiLLCSameDirectoryFailClosedAliasWorkspacesAndDisconnect(t *testing.T) {
	_, _ = connectSetting(t)
	var mu sync.Mutex
	var bearers []string
	var tokenExchanges int
	rejectFirstToken := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/agent-connect":
			var body map[string]string
			_ = json.Unmarshal(raw, &body)
			w.WriteHeader(201)
			if body["code"] == "AAAA-BBBB-CCCC" {
				_, _ = w.Write([]byte(`{"secret":"` + multiKey1 + `","key":{"id":"1111111111111111","name":"Agent","scopes":["read","draft","post"],"expiresAt":"2027-02-15T17:00:00.000Z"},"workspace":{"id":"wsp_0000000001","name":"Alpha Holdings LLC","slug":"alpha-holdings"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"secret":"` + multiKey2 + `","key":{"id":"2222222222222222","name":"Agent","scopes":["read","draft","post"],"expiresAt":"2027-02-15T17:00:00.000Z"},"workspace":{"id":"wsp_0000000002","name":"Beta Ventures LLC","slug":"beta-ventures"}}`))
		case "/auth/agent-token":
			mu.Lock()
			tokenExchanges++
			count := tokenExchanges
			mu.Unlock()
			var body map[string]string
			_ = json.Unmarshal(raw, &body)
			tok := "tok-alpha"
			if body["key"] == multiKey2 {
				tok = "tok-beta"
			}
			if count > 10 {
				tok += "-refreshed"
			}
			_, _ = w.Write([]byte(`{"token":"` + tok + `","expiresIn":300}`))
		case "/v1/book.get":
			mu.Lock()
			auth := r.Header.Get("Authorization")
			if rejectFirstToken && auth == "Bearer tok-alpha" {
				rejectFirstToken = false
				mu.Unlock()
				w.WriteHeader(401)
				_ = json.NewEncoder(w).Encode(api.Response{Version: api.Version, BookID: "local-book", Error: &api.Failure{Code: "token_invalid", Message: "expired"}})
				return
			}
			bearers = append(bearers, auth)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": api.Version, "bookId": "local-book", "ok": true,
				"data": map[string]any{
					"enabled": true, "bookId": "local-book", "setup": nil, "mode": "hosted",
					"permissions": []string{"read", "draft", "post"}, "head": nil,
					"principal":   map[string]any{"kind": "token", "tokenId": "1111111111111111", "label": "Agent", "expiresAt": "2027-02-15T17:00:00.000Z"},
					"ownerAccess": "key",
				},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)

	// Connect LLC #1 and LLC #2 from the exact same directory.
	if run := runAgent(t, server.URL, "connect", "AAAA-BBBB-CCCC", "--alias", "alpha", "--agent", "none"); run.exit != 0 {
		t.Fatalf("connect alpha failed (%d): %s %s", run.exit, run.out, run.diagnostics)
	}
	if run := runAgent(t, server.URL, "connect", "DDDD-EEEE-FFFF", "--agent", "none"); run.exit != 0 {
		t.Fatalf("connect beta failed (%d): %s %s", run.exit, run.out, run.diagnostics)
	}

	// Both connections remain in connections.json and `workspaces` lists them without secrets.
	ws := runAgentHere(t, "workspaces")
	if ws.exit != 0 {
		t.Fatalf("workspaces failed (%d): %s %s", ws.exit, ws.out, ws.diagnostics)
	}
	if strings.Contains(ws.out, "rsa_") || !strings.Contains(ws.out, `"selector":"alpha"`) || !strings.Contains(ws.out, `"selector":"beta-ventures"`) {
		t.Fatalf("unexpected workspaces output: %s", ws.out)
	}

	// Running without --workspace in an ambiguous folder MUST fail closed.
	ambiguous := runAgentHere(t, "context")
	if ambiguous.exit != 2 || !strings.Contains(ambiguous.diagnostics, "--workspace") {
		t.Fatalf("expected fail-closed ambiguity, got exit=%d out=%s diag=%s", ambiguous.exit, ambiguous.out, ambiguous.diagnostics)
	}

	// Passing --workspace routes cleanly to each LLC and reuses the disk JWT cache across commands.
	sharedReqDir := filepath.Join(t.TempDir(), "requests")
	runWithReqDir := func(args ...string) agentRun {
		var out, diag strings.Builder
		r := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diag}
		exit := r.Run(t.Context(), append(args, "--request-dir", sharedReqDir))
		return agentRun{exit, out.String(), diag.String()}
	}
	mu.Lock()
	exchangesBefore := tokenExchanges
	mu.Unlock()
	if res := runWithReqDir("context", "--workspace", "alpha"); res.exit != 0 {
		t.Fatalf("context --workspace alpha failed: %s %s", res.out, res.diagnostics)
	}
	if res := runWithReqDir("context", "--workspace", "alpha"); res.exit != 0 {
		t.Fatalf("second context --workspace alpha failed: %s %s", res.out, res.diagnostics)
	}
	mu.Lock()
	exchangesAfter := tokenExchanges
	mu.Unlock()
	if exchangesAfter-exchangesBefore != 1 {
		t.Fatalf("expected 1 token exchange across two cached invocations, got %d", exchangesAfter-exchangesBefore)
	}

	// A 401 invalidates the cached token on disk and exchanges a fresh one automatically.
	mu.Lock()
	rejectFirstToken = true
	exchangesBefore = tokenExchanges
	mu.Unlock()
	if res := runWithReqDir("context", "--workspace", "alpha"); res.exit != 0 {
		t.Fatalf("context after 401 failed: %s %s", res.out, res.diagnostics)
	}
	mu.Lock()
	exchangesAfter = tokenExchanges
	mu.Unlock()
	if exchangesAfter-exchangesBefore != 1 {
		t.Fatalf("expected 1 fresh token exchange after 401, got %d", exchangesAfter-exchangesBefore)
	}

	// RASTRATA_WORKSPACE env var selects Beta cleanly.
	t.Setenv("RASTRATA_WORKSPACE", "beta-ventures")
	if res := runWithReqDir("context"); res.exit != 0 {
		t.Fatalf("RASTRATA_WORKSPACE=beta-ventures failed: %s %s", res.out, res.diagnostics)
	}
	t.Setenv("RASTRATA_WORKSPACE", "")
	mu.Lock()
	lastBearer := bearers[len(bearers)-1]
	mu.Unlock()
	if lastBearer != "Bearer tok-beta" {
		t.Fatalf("expected Beta bearer, got %q", lastBearer)
	}

	// Disconnecting Beta leaves Alpha as the sole unambiguous workspace.
	if disc := runAgentHere(t, "disconnect", "--workspace", "beta-ventures"); disc.exit != 0 {
		t.Fatalf("disconnect beta failed: %s %s", disc.out, disc.diagnostics)
	}
	if ok := runWithReqDir("context"); ok.exit != 0 {
		t.Fatalf("context after disconnecting beta should resolve unambiguously to alpha: %s %s", ok.out, ok.diagnostics)
	}
}

func TestRequestJournalRefusesCrossWorkspaceResume(t *testing.T) {
	reqDir := t.TempDir()
	clientA, err := api.New("https://app.rastrata.com", "local-book", reqDir)
	if err != nil {
		t.Fatal(err)
	}
	clientA.WorkspaceID = "wsp_0000000001"
	opID := api.NewOperationID()
	body, _ := json.Marshal(api.Request{
		Version:     api.Version,
		BookID:      "local-book",
		OperationID: opID,
		Input:       json.RawMessage(`{"name":"New Name"}`),
	})
	if err := clientA.Journal.Retain(api.Record{
		Endpoint:    clientA.Endpoint,
		BookID:      clientA.BookID,
		WorkspaceID: clientA.WorkspaceID,
		Name:        "book.update",
		OperationID: opID,
		Body:        body,
	}); err != nil {
		t.Fatal(err)
	}

	clientB, err := api.New("https://app.rastrata.com", "local-book", reqDir)
	if err != nil {
		t.Fatal(err)
	}
	clientB.WorkspaceID = "wsp_0000000002"
	_, err = clientB.Resume(t.Context(), opID)
	if err == nil || !strings.Contains(err.Error(), "workspace_scope_mismatch") {
		t.Fatalf("expected workspace_scope_mismatch on cross-workspace resume, got %v", err)
	}
	recordsB, err := clientB.Journal.ListForWorkspace(clientB.Endpoint, clientB.BookID, clientB.WorkspaceID)
	if err != nil || len(recordsB) != 0 {
		t.Fatalf("expected 0 journal records for workspace B, got %d (%v)", len(recordsB), err)
	}
	recordsA, err := clientA.Journal.ListForWorkspace(clientA.Endpoint, clientA.BookID, clientA.WorkspaceID)
	if err != nil || len(recordsA) != 1 {
		t.Fatalf("expected 1 journal record for workspace A, got %d (%v)", len(recordsA), err)
	}
}

func TestDryRunPostCpaPacketExportDownloadAndVendorSaveFlags(t *testing.T) {
	var seenDryRun bool
	var seenVendor map[string]any
	zipContent := []byte("PK\x03\x04fake-open-export-zip-bytes")

	manifestJSON := `{"format":"rastrata-cpa-packet-v1","files":[{"path":"README.md","bytes":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}]}`
	manifestSum := sha256.Sum256([]byte(manifestJSON))
	manifestHex := hex.EncodeToString(manifestSum[:])

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/exports/exp_2026_01" {
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(zipContent)
			return
		}
		var req api.Request
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/inbox.post":
			var input map[string]any
			_ = json.Unmarshal(req.Input, &input)
			seenDryRun = input["dryRun"] == true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": api.Version, "bookId": "local-book", "ok": true, "operationId": req.OperationID,
				"data": map[string]any{
					"results": []any{}, "applied": 0, "skipped": 0, "failed": 0, "remaining": 0,
					"dryRun": true, "accountDeltas": []any{},
				},
			})
		case "/v1/taxCpaPacket.build":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": api.Version, "bookId": "local-book", "ok": true,
				"data": map[string]any{
					"format": "rastrata-cpa-packet-v1", "folder": "rastrata-cpa-packet-2026",
					"taxYear": 2026,
					"form":    map[string]any{"id": "scheduleC", "name": "Schedule C", "subject": "Sole proprietor", "taxYear": 2026, "status": "final", "verifiedOn": "2026-01-01", "sources": []any{}},
					"from":    "2026-01-01", "to": "2026-12-31", "bookRevision": "1",
					"ledgerPopulationHash":    strings.Repeat("a", 64),
					"worksheetPopulationHash": strings.Repeat("b", 64),
					"tagMapHash":              strings.Repeat("c", 64),
					"close":                   map[string]any{"state": "open", "periods": 12, "closed": 0, "superseded": 0, "open": 12, "last": nil, "statement": "Open."},
					"files": []map[string]any{
						{"path": "README.md", "mediaType": "text/markdown", "description": "Readme", "bytes": 5, "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", "content": "hello"},
						{"path": "manifest.json", "mediaType": "application/json", "description": "Manifest", "bytes": len(manifestJSON), "sha256": manifestHex, "content": manifestJSON},
					},
					"manifestSha256": manifestHex,
					"checks":         []any{}, "warnings": []any{}, "disclaimer": "Not tax advice.",
				},
			})
		case "/v1/taxVendors.save":
			_ = json.Unmarshal(req.Input, &seenVendor)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": api.Version, "bookId": "local-book", "ok": true, "operationId": req.OperationID,
				"data": map[string]any{
					"vendor": map[string]any{
						"id": "ven_1", "version": 1, "name": "Acme", "payeeKeys": []string{},
						"reporting": "yes", "reason": nil, "w9": "received", "w9On": nil,
						"classification": nil, "paidBy": "bank", "notes": "",
						"legalName":  "Acme Consulting LLC",
						"address":    map[string]any{"line1": "100 Main St", "city": "Austin", "state": "TX", "postalCode": "78701"},
						"email":      "ap@acme.example",
						"tinStatus":  "on_file",
						"recordedAt": "2026-01-01T00:00:00Z", "principal": "owner",
					},
					"changed": true, "vendorsRevision": "1", "vendorsHash": strings.Repeat("d", 64),
				},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)

	run := func(args ...string) agentRun {
		var out, diag strings.Builder
		r := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diag}
		full := append(args, "--endpoint", server.URL, "--request-dir", t.TempDir())
		return agentRun{r.Run(t.Context(), full), out.String(), diag.String()}
	}

	if res := run("inbox", "post", "--all", "--dry-run"); res.exit != 0 || !seenDryRun {
		t.Fatalf("inbox post --dry-run failed: exit=%d seen=%v out=%s diag=%s", res.exit, seenDryRun, res.out, res.diagnostics)
	}

	packetOut := filepath.Join(t.TempDir(), "cpa-2026.zip")
	if res := run("tax", "cpa-packet", "--year", "2026", "--out", packetOut); res.exit != 0 {
		t.Fatalf("tax cpa-packet failed: exit=%d out=%s diag=%s", res.exit, res.out, res.diagnostics)
	}
	if res := run("tax", "verify-pack", packetOut); res.exit != 0 {
		t.Fatalf("tax verify-pack on CPA packet failed: exit=%d out=%s diag=%s", res.exit, res.out, res.diagnostics)
	}

	exportOut := filepath.Join(t.TempDir(), "open-export.zip")
	if res := run("export", "download", "exp_2026_01", "--out", exportOut); res.exit != 0 {
		t.Fatalf("export download failed: exit=%d out=%s diag=%s", res.exit, res.out, res.diagnostics)
	}
	gotBytes, err := os.ReadFile(exportOut)
	if err != nil || string(gotBytes) != string(zipContent) {
		t.Fatalf("downloaded export mismatch: %q %v", string(gotBytes), err)
	}
	if dup := run("export", "download", "exp_2026_01", "--out", exportOut); dup.exit != 2 {
		t.Fatalf("expected refusal to overwrite existing export file, got exit=%d", dup.exit)
	}

	if res := run(
		"tax", "vendor", "save",
		"--name", "Acme",
		"--legal-name", "Acme Consulting LLC",
		"--address-line1", "100 Main St",
		"--address-city", "Austin",
		"--address-state", "TX",
		"--address-postal-code", "78701",
		"--email", "ap@acme.example",
		"--tin-status", "on_file",
	); res.exit != 0 {
		t.Fatalf("tax vendor save failed: exit=%d out=%s diag=%s", res.exit, res.out, res.diagnostics)
	}
	if seenVendor["legalName"] != "Acme Consulting LLC" || seenVendor["email"] != "ap@acme.example" || seenVendor["tinStatus"] != "on_file" {
		t.Fatalf("vendor save payload missing new fields: %+v", seenVendor)
	}
}

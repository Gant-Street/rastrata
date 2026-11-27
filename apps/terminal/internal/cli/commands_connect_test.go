package cli

import (
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

// No test of this package reads the connections a person keeps on this computer: each run has a folder of its own.
func TestMain(m *testing.M) {
	directory, err := os.MkdirTemp("", "rastrata-cli-test-config-*")
	if err != nil {
		panic(err)
	}
	_ = os.Setenv(api.ConfigDirVariable, directory)
	code := m.Run()
	_ = os.RemoveAll(directory)
	os.Exit(code)
}

const (
	connectTestCode = "R7K2-9QDM-4XHT"
	connectTestKey  = "rsa_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

// workspaceService is a hosted workspace as the command meets it: the door that takes a code, the door that takes a key, and the book.
type workspaceService struct {
	refuse   string // the code's refusal, when the code is not to be taken
	paths    []string
	codes    []map[string]string
	keys     []string
	bearers  []string
	tokenFor string
}

func (s *workspaceService) start(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.paths = append(s.paths, r.URL.Path)
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/agent-connect":
			var body map[string]string
			_ = json.Unmarshal(raw, &body)
			s.codes = append(s.codes, body)
			if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
				t.Errorf("a code is the whole credential: nothing else is sent with it")
			}
			if s.refuse != "" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"code":"` + s.refuse + `","message":"This code was already used. Get a new one in your workspace's agent settings."}`))
				return
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"secret":"` + connectTestKey + `","key":{"id":"0123456789abcdef","name":"` + body["name"] + `","scopes":["read","draft"],"expiresAt":"2027-02-15T17:00:00.000Z"},"workspace":{"id":"wsp_0000000001","name":"Larimer Studio"}}`))
		case "/auth/agent-token":
			var body map[string]string
			_ = json.Unmarshal(raw, &body)
			s.keys = append(s.keys, body["key"])
			_, _ = w.Write([]byte(`{"token":"short-lived-token","expiresIn":300,"workspace":"wsp_0000000001"}`))
		case "/v1/book.get":
			s.bearers = append(s.bearers, r.Header.Get("Authorization"))
			_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "data": map[string]any{
				"enabled": true, "bookId": "local-book", "setup": nil, "mode": "hosted", "permissions": []string{"read", "draft"}, "head": nil,
				"principal": map[string]any{"kind": "token", "tokenId": "0123456789abcdef", "label": "Agent on studio-mac", "expiresAt": "2027-02-15T17:00:00.000Z"}, "ownerAccess": "key",
			}})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	return server.URL
}

// connectSetting gives a test a configuration folder and a project folder of its own, and runs it in the project.
func connectSetting(t *testing.T) (config, project string) {
	t.Helper()
	config, project = t.TempDir(), t.TempDir()
	t.Setenv(api.ConfigDirVariable, config)
	t.Setenv(api.TokenVariable, "")
	t.Setenv(api.OwnerKeyFileVariable, "")
	t.Setenv("RASTRATA_API_URL", "")
	t.Chdir(project)
	previous := hostname
	hostname = func() (string, error) { return "studio-mac.local", nil }
	t.Cleanup(func() { hostname = previous })
	return config, project
}

func TestConnectExchangesTheCodeKeepsTheKeyPrivateChecksItAndWritesTheInstructions(t *testing.T) {
	config, project := connectSetting(t)
	workspace := &workspaceService{}
	endpoint := workspace.start(t)

	run := runAgent(t, endpoint, "connect", connectTestCode)
	if run.exit != 0 {
		t.Fatalf("connect failed (%d): %s\n%s", run.exit, run.out, run.diagnostics)
	}
	// The code went to the service once, with a name that says where the agent runs, and nothing else.
	if len(workspace.codes) != 1 || workspace.codes[0]["code"] != connectTestCode || workspace.codes[0]["name"] != "Agent on studio-mac" {
		t.Fatalf("what was sent: %+v", workspace.codes)
	}
	// One line for the person, in words.
	if !strings.Contains(run.diagnostics, "Connected to Larimer Studio. This agent can read and draft until February 15, 2027.") {
		t.Fatalf("what the person is told:\n%s", run.diagnostics)
	}
	// The key is nowhere a person or a log would see it.
	if strings.Contains(run.out+run.diagnostics, "rsa_") || strings.Contains(run.out+run.diagnostics, connectTestKey[20:]) {
		t.Fatalf("the key was printed:\n%s\n%s", run.out, run.diagnostics)
	}
	var result struct {
		Data struct {
			Connected   bool     `json:"connected"`
			Checked     bool     `json:"checked"`
			Endpoint    string   `json:"endpoint"`
			Directory   string   `json:"directory"`
			Name        string   `json:"name"`
			Permissions []string `json:"permissions"`
			Workspace   struct {
				Name string `json:"name"`
			} `json:"workspace"`
			Files []struct {
				Path   string `json:"path"`
				Action string `json:"action"`
			} `json:"files"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(run.out), &result); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, run.out)
	}
	data := result.Data
	if !data.Connected || !data.Checked || data.Endpoint != endpoint || data.Workspace.Name != "Larimer Studio" || strings.Join(data.Permissions, ",") != "read,draft" {
		t.Fatalf("the result: %+v", data)
	}
	// It is kept in a file only the person can read, in a folder only they can open, outside the project.
	path := filepath.Join(config, "connections.json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the connections file: %v %v", info, err)
	}
	kept, _ := os.ReadFile(path)
	if !strings.Contains(string(kept), connectTestKey) {
		t.Fatalf("the key was not kept")
	}
	_ = filepath.WalkDir(project, func(file string, entry os.DirEntry, _ error) error {
		if entry != nil && !entry.IsDir() {
			text, _ := os.ReadFile(file)
			if strings.Contains(string(text), "rsa_0123456789abcdef_") {
				t.Errorf("%s holds the key", file)
			}
		}
		return nil
	})
	// The key was checked: exchanged for a short-lived token, and the book asked who that is.
	if len(workspace.keys) != 1 || workspace.keys[0] != connectTestKey || len(workspace.bearers) != 1 || workspace.bearers[0] != "Bearer short-lived-token" {
		t.Fatalf("the check: keys %v bearers %v", workspace.keys, workspace.bearers)
	}
	// The instructions for every agent are in the project.
	for _, file := range []string{".claude/skills/rastrata/SKILL.md", ".claude/skills/rastrata/guide.md", "AGENTS.md"} {
		if _, err := os.Stat(filepath.Join(project, filepath.FromSlash(file))); err != nil {
			t.Errorf("%s was not written: %v", file, err)
		}
	}
	if _, err := os.Stat(filepath.Join(project, ".mcp.json")); err == nil {
		t.Errorf("connect writes no MCP entry: the agent works through the command")
	}

	// From now on a command run in the folder, or under it, needs nothing set: it knows where the books are and who it is.
	nested := filepath.Join(project, "statements", "2026")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(nested)
	var out, diagnostics strings.Builder
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	if exit := runner.Run(t.Context(), []string{"context", "--request-dir", t.TempDir()}); exit != 0 {
		t.Fatalf("a command in the connected folder failed (%d): %s %s", exit, out.String(), diagnostics.String())
	}
	if len(workspace.bearers) != 2 || workspace.bearers[1] != "Bearer short-lived-token" {
		t.Fatalf("the command did not use the folder's connection: %v", workspace.bearers)
	}
	status := runAgentHere(t, "agent", "status")
	if status.exit != 0 || !strings.Contains(status.out, `"credential":"connection"`) || !strings.Contains(status.out, `"endpoint":"`+endpoint+`"`) {
		t.Fatalf("agent status in the connected folder: %d %s", status.exit, status.out)
	}
}

// runAgentHere runs a command with no address given, as an agent does in a connected folder.
func runAgentHere(t *testing.T, args ...string) agentRun {
	t.Helper()
	var out, diagnostics strings.Builder
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	exit := runner.Run(t.Context(), append(args, "--request-dir", t.TempDir()))
	return agentRun{exit, out.String(), diagnostics.String()}
}

func TestAConnectionIsUsedOnlyWhereItWasMadeAndOnlyForItsAddressAndATokenInTheEnvironmentWins(t *testing.T) {
	_, project := connectSetting(t)
	workspace := &workspaceService{}
	endpoint := workspace.start(t)
	if run := runAgent(t, endpoint, "connect", connectTestCode, "--agent", "none"); run.exit != 0 {
		t.Fatalf("connect failed: %s", run.diagnostics)
	}
	if entries, _ := os.ReadDir(project); len(entries) != 0 {
		t.Fatalf("--agent none writes nothing into the project: %v", entries)
	}
	options := defaults()
	credential, source, err := credentialFor(&options)
	if err != nil || credential != connectTestKey || source != "connection" || options.Endpoint != endpoint {
		t.Fatalf("in the folder: %q %q %v %s", source, options.Endpoint, err, credential[:4])
	}
	// Another address named by the person: the key is not for it, and is not sent to it.
	other := defaults()
	other.Endpoint, other.EndpointGiven = "http://127.0.0.1:1", true
	if credential, source, _ := credentialFor(&other); credential != "" || source != "none" || other.Endpoint != "http://127.0.0.1:1" {
		t.Fatalf("for another address: %q %q", source, other.Endpoint)
	}
	// The same address named in full is the same address.
	same := defaults()
	same.Endpoint, same.EndpointGiven = endpoint+"/", true
	if credential, _, _ := credentialFor(&same); credential != connectTestKey {
		t.Fatalf("the address with a trailing slash is the same address")
	}
	// A token set by the person, or their secrets manager, is obeyed.
	t.Setenv(api.TokenVariable, "rsa_fedcba9876543210_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
	set := defaults()
	if credential, source, _ := credentialFor(&set); source != "token" || credential == connectTestKey {
		t.Fatalf("RASTRATA_TOKEN wins: %q", source)
	}
	t.Setenv(api.TokenVariable, "")
	// A folder that is not the project, nor under it: a build with a service of its own on this computer does not reach for a workspace.
	t.Chdir(t.TempDir())
	elsewhere := defaults()
	if credential, source, _ := credentialFor(&elsewhere); credential != "" || source != "none" {
		t.Fatalf("outside the folder: %q", source)
	}
	// The command line on its own has nowhere else to look: a person with one workspace need not be in the folder.
	commandLineOnly(t)
	alone := defaults()
	if credential, source, _ := credentialFor(&alone); credential != connectTestKey || source != "connection" || alone.Endpoint != endpoint {
		t.Fatalf("the command line on its own, outside the folder: %q %q", source, alone.Endpoint)
	}
}

func TestConnectSaysWhatIsWrongWithACodeAndKeepsNothing(t *testing.T) {
	config, _ := connectSetting(t)
	workspace := &workspaceService{refuse: "code_used"}
	endpoint := workspace.start(t)
	run := runAgent(t, endpoint, "connect", connectTestCode)
	if run.exit != 3 || !strings.Contains(run.diagnostics, "This code was already used. Get a new one in your workspace's agent settings.") || !strings.Contains(run.out, `"code":"code_used"`) {
		t.Fatalf("a used code: %d %s\n%s", run.exit, run.out, run.diagnostics)
	}
	kept, _ := os.ReadFile(filepath.Join(config, "connections.json"))
	if strings.Contains(string(kept), "rsa_") {
		t.Fatalf("something was kept for a refused code")
	}
	// What is not a code is refused before anything is sent: a token in its place, words, a code with a preset.
	sent := len(workspace.paths)
	for _, args := range [][]string{
		{"connect", connectTestKey},
		{"connect", "rst_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		{"connect", "x"},
		{"connect", connectTestCode, "extra"},
		{"connect", connectTestCode, "--preset", "draft"},
		{"connect", connectTestCode, "--agent", "cursor"},
		{"connect", connectTestCode, "--name", connectTestKey},
		{"connect", connectTestCode, "--dir", "/no/such/folder"},
		{"connect", connectTestCode, "--force"},
	} {
		run := runAgent(t, endpoint, args...)
		if run.exit != 2 {
			t.Errorf("%v: want a usage error, got %d %s", args, run.exit, run.diagnostics)
		}
		if strings.Contains(run.out+run.diagnostics, connectTestKey[20:]) {
			t.Errorf("%v: a credential given by mistake was repeated", args)
		}
	}
	if len(workspace.paths) != sent {
		t.Fatalf("a malformed request reached the service: %v", workspace.paths[sent:])
	}
}

func TestConnectFindsOutThatTheKeyCannotBeKeptBeforeTheCodeIsUsed(t *testing.T) {
	config, _ := connectSetting(t)
	workspace := &workspaceService{}
	endpoint := workspace.start(t)
	// A connections file that others can read is refused, as the owner key file is.
	path := filepath.Join(config, "connections.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"connections":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	run := runAgent(t, endpoint, "connect", connectTestCode)
	if run.exit != 4 || !strings.Contains(run.diagnostics, "must be private to you (chmod 600)") {
		t.Fatalf("a readable connections file: %d %s", run.exit, run.diagnostics)
	}
	// A file that is not ours is not overwritten.
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	run = runAgent(t, endpoint, "connect", connectTestCode)
	if run.exit != 4 || !strings.Contains(run.diagnostics, "is not one this version of rastrata wrote") {
		t.Fatalf("a foreign connections file: %d %s", run.exit, run.diagnostics)
	}
	if len(workspace.paths) != 0 {
		t.Fatalf("the code was sent although the key could not have been kept: %v", workspace.paths)
	}
	// Every other command says the same, and sends nothing.
	if status := runAgentHere(t, "context"); status.exit != 2 || !strings.Contains(status.diagnostics, "is not one this version of rastrata wrote") {
		t.Fatalf("a command with a broken connections file: %d %s", status.exit, status.diagnostics)
	}
}

func TestConnectWithACodeGoesToTheHostedServiceUnlessAnAddressIsNamed(t *testing.T) {
	connectSetting(t)
	// A build with a service of its own would otherwise ask this computer; a code is from a hosted workspace. What is checked is where the command tried to go.
	var asked []string
	transport := http.DefaultTransport
	http.DefaultTransport = roundTrip(func(request *http.Request) (*http.Response, error) {
		asked = append(asked, request.URL.Scheme+"://"+request.URL.Host+request.URL.Path)
		return nil, io.ErrUnexpectedEOF
	})
	t.Cleanup(func() { http.DefaultTransport = transport })
	var out, diagnostics strings.Builder
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	if exit := runner.Run(t.Context(), []string{"connect", connectTestCode, "--request-dir", t.TempDir()}); exit != 4 {
		t.Fatalf("want a failed connection, got %d %s", exit, diagnostics.String())
	}
	if len(asked) != 1 || asked[0] != "https://app.rastrata.com/auth/agent-connect" {
		t.Fatalf("where the code went: %v", asked)
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestConnectWithNoCodeMakesATokenOfTheServiceOnThisComputerAndTheCommandLineOnItsOwnAsksForACode(t *testing.T) {
	config, project := connectSetting(t)
	const token = "rst_0123456789abcdef_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
	var created map[string]any
	var bearers []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		bearers = append(bearers, r.URL.Path+" "+r.Header.Get("Authorization"))
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		switch r.URL.Path {
		case "/v1/tokens.create":
			_ = json.Unmarshal(request.Input, &created)
			envelope["data"] = map[string]any{"secret": token, "token": map[string]any{
				"id": "0123456789abcdef", "prefix": "rst_0123456789abcdef", "label": created["label"], "permissions": created["permissions"], "status": "active",
				"createdAt": "2026-11-17T17:00:00.000Z", "createdBy": "owner", "expiresAt": "2027-02-15T17:00:00.000Z", "revokedAt": nil, "revokedReason": nil, "lastUsedAt": nil,
			}}
		case "/v1/book.get":
			envelope["data"] = map[string]any{"enabled": true, "bookId": "local-book", "setup": nil, "mode": "local", "permissions": []string{"read"}, "head": nil,
				"principal": map[string]any{"kind": "token", "tokenId": "0123456789abcdef", "label": "Agent on studio-mac", "expiresAt": "2027-02-15T17:00:00.000Z"}, "ownerAccess": "key"}
		default:
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(server.Close)

	run := runAgent(t, server.URL, "connect", "--preset", "read-only", "--agent", "claude")
	if run.exit != 0 {
		t.Fatalf("connect failed (%d): %s\n%s", run.exit, run.out, run.diagnostics)
	}
	if created["label"] != "Agent on studio-mac" || len(created["permissions"].([]any)) != 1 {
		t.Fatalf("the token asked for: %+v", created)
	}
	if !strings.Contains(run.diagnostics, "Connected to your books. This agent can read until February 15, 2027.") || strings.Contains(run.out+run.diagnostics, "rst_0123456789abcdef_") {
		t.Fatalf("what the person is told:\n%s\n%s", run.diagnostics, run.out)
	}
	kept, _ := os.ReadFile(filepath.Join(config, "connections.json"))
	if !strings.Contains(string(kept), token) {
		t.Fatalf("the token was not kept")
	}
	if _, err := os.Stat(filepath.Join(project, ".claude", "skills", "rastrata", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(project, "AGENTS.md")); err == nil {
		t.Fatalf("--agent claude writes Claude's files only")
	}
	// The check used the token, not the owner.
	if last := bearers[len(bearers)-1]; last != "/v1/book.get Bearer "+token {
		t.Fatalf("the check: %v", bearers)
	}
	// Connecting again from the same folder is the owner's act, not the token's: the folder's own connection is not what asks.
	if again := runAgent(t, server.URL, "connect"); again.exit != 0 {
		t.Fatalf("a second connect: %s", again.diagnostics)
	}
	if asked := bearers[len(bearers)-2]; asked != "/v1/tokens.create " {
		t.Fatalf("the second token was asked for as %q", asked)
	}
	if created["permissions"].([]any)[1] != "draft" {
		t.Fatalf("with no preset the agent reads and drafts: %+v", created)
	}

	// The command line on its own has no service here: it asks for the code.
	commandLineOnly(t)
	alone := runAgent(t, server.URL, "connect")
	if alone.exit != 2 || !strings.Contains(alone.diagnostics, "give the code from your workspace's agent settings") {
		t.Fatalf("the command line on its own with no code: %d %s", alone.exit, alone.diagnostics)
	}
}

func TestFindConnectionChoosesTheNearestFolderAboveAndOnlyTheAddressNamed(t *testing.T) {
	root := string(filepath.Separator)
	books := filepath.Join(root, "work", "books")
	client := filepath.Join(books, "client")
	connections := []api.Connection{
		{Endpoint: "https://app.rastrata.com", Directory: books, Key: "a", ConnectedAt: "2026-11-01T00:00:00Z"},
		{Endpoint: "https://app.rastrata.com", Directory: client, Key: "b", ConnectedAt: "2026-11-02T00:00:00Z"},
		{Endpoint: "http://127.0.0.1:7278", Directory: books, Key: "c", ConnectedAt: "2026-11-03T00:00:00Z"},
	}
	key := func(folder, endpoint string, anywhere bool) string {
		if found := api.FindConnection(connections, folder, endpoint, anywhere); found != nil {
			return found.Key
		}
		return ""
	}
	for _, check := range []struct {
		folder, endpoint string
		anywhere         bool
		want             string
	}{
		{filepath.Join(client, "2026"), "https://app.rastrata.com", false, "b"},
		{filepath.Join(books, "other"), "https://app.rastrata.com", false, "a"},
		{books, "http://127.0.0.1:7278", false, "c"},
		// The folder's newest connection when no address is named.
		{books, "", false, "c"},
		// A folder whose name only begins like another's is not under it.
		{books + "-old", "", false, ""},
		{filepath.Join(root, "elsewhere"), "", false, ""},
		{filepath.Join(root, "elsewhere"), "", true, "c"},
		{filepath.Join(root, "elsewhere"), "https://app.rastrata.com", true, "b"},
		{filepath.Join(root, "elsewhere"), "https://other.rastrata.com", true, ""},
	} {
		if got := key(check.folder, check.endpoint, check.anywhere); got != check.want {
			t.Errorf("%s %q anywhere=%v: got %q, want %q", check.folder, check.endpoint, check.anywhere, got, check.want)
		}
	}
}

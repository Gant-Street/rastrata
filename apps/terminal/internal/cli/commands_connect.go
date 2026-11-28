package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/agentkit"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
)

// Connecting an agent in one command.
//
//	rastrata connect CODE [--name TEXT] [--agent claude|codex|opencode|all|none] [--dir PATH]
//	rastrata connect [--preset read-only|draft|bookkeeper] [--name TEXT] [--agent ...] [--dir PATH]
//
// With a code from the Agents page of a hosted workspace: the code is exchanged, once, for a credential made for the person who asked for it, with what they chose the
// agent may do. Without one, on a computer that runs the service itself: the owner makes a token of that service. Either way the command then does what took four:
// it keeps the credential for this folder in the connections file (private to the person; never printed, never in the project), checks that the service takes it, and
// writes the bookkeeping instructions for the agents into the folder. Every later `rastrata` command run in the folder, or under it, works with no variable set.
// RASTRATA_TOKEN still wins when it is set.
func init() {
	Register(Command{Name: "connect", Offline: true, Summary: "Connect an agent to your books from this folder, in one step: CODE (from your workspace's agent settings; works once, for ten minutes) [--name TEXT] [--alias SLUG] [--agent claude|codex|opencode|all|none] [--dir PATH]. On a computer that runs the service itself, with no code: [--preset read-only|draft|bookkeeper]", Run: runConnect})
	Register(Command{Name: "workspaces", Offline: true, Summary: "List connected workspaces and show which one is selected in this folder", Run: runWorkspaces})
	Register(Command{Name: "disconnect", Offline: true, Summary: "Remove a connected workspace from this computer: disconnect [--workspace SLUG|ID] [--all]", Run: runDisconnect})
}

// connectTimeout bounds each talk with the service.
const connectTimeout = 20 * time.Second

// hostname is replaced in tests.
var hostname = os.Hostname

// normalizedEndpoint is an address as a connection records it (the client's own form), so that the two can be compared.
func normalizedEndpoint(endpoint string) string {
	client, err := api.New(endpoint, "local-book", "")
	if err != nil {
		return endpoint
	}
	return client.Endpoint
}

// realFolder is a folder's path with its links followed, so that the same folder is the same text however the person came to it.
func realFolder(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved, nil
	}
	return absolute, nil
}

// connectionHere is the connection `rastrata connect` kept for the folder (or --workspace selector) this command runs in, if there is one that may be used.
func connectionHere(o Options) (*api.Connection, error) {
	connections, err := api.LoadConnections(os.Getenv)
	if err != nil || len(connections) == 0 {
		if err == nil && o.Workspace != "" {
			return nil, fmt.Errorf("no connected workspaces found for %q; run rastrata connect first", o.Workspace)
		}
		return nil, err
	}
	folder, err := os.Getwd()
	if err != nil {
		folder = ""
	} else if resolved, err := realFolder(folder); err == nil {
		folder = resolved
	}
	endpoint := ""
	if o.EndpointGiven {
		endpoint = normalizedEndpoint(o.Endpoint)
	}
	// The command line on its own has no service on this computer to fall back to, so a person with one workspace need not be in the folder they connected from.
	// When multiple workspaces are connected, ResolveConnection fails closed and asks for --workspace or RASTRATA_WORKSPACE.
	return api.ResolveConnection(connections, folder, endpoint, o.Workspace, buildinfo.CommandLineOnly())
}

// credentialFor says what this process presents to the service, where it took it from ("token", "owner key", "connection" or "none"), and, when it is a folder's
// connection, sets where the service is. The order: RASTRATA_TOKEN, RASTRATA_OWNER_KEY_FILE, the folder's connection, the installed service's own owner key, nothing.
func credentialFor(o *Options) (string, string, error) {
	named := strings.TrimSpace(os.Getenv(api.TokenVariable)) != "" || os.Getenv(api.OwnerKeyFileVariable) != ""
	if !named || o.Workspace != "" {
		connection, err := connectionHere(*o)
		if err != nil {
			return "", "connection", err
		}
		if connection != nil {
			o.Endpoint = connection.Endpoint
			o.WorkspaceID = connection.WorkspaceID
			return connection.Key, "connection", nil
		}
	}
	credential, err := api.CredentialFromEnvironment(os.Getenv)
	return credential, api.CredentialSource(os.Getenv), err
}

// defaultAgentName is what the agent is called on the Agents page when the person gave no name: where it runs.
func defaultAgentName() string {
	host, err := hostname()
	if err != nil {
		return ""
	}
	host, _, _ = strings.Cut(strings.TrimSpace(host), ".")
	if host == "" || len(host) > 60 || api.LooksLikeToken(host) {
		return ""
	}
	for _, character := range host {
		if character < 0x20 || character == 0x7f {
			return ""
		}
	}
	return "Agent on " + host
}

var scopeWords = map[string]string{"read": "read", "draft": "draft", "post": "post", "configure": "change the setup", "correct": "reverse entries", "close": "reconcile and close"}

// canDo is what a set of permissions lets an agent do, as a clause: "read and draft".
func canDo(scopes []string) string {
	words := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if word, known := scopeWords[scope]; known {
			words = append(words, word)
		}
	}
	switch len(words) {
	case 0:
		return "nothing"
	case 1:
		return words[0]
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}

func longDay(instant string) string {
	at, err := time.Parse(time.RFC3339, instant)
	if err != nil {
		return ""
	}
	return at.UTC().Format("January 2, 2006")
}

type connectResult struct {
	Connected bool   `json:"connected"`
	Endpoint  string `json:"endpoint"`
	Directory string `json:"directory"`
	Alias     string `json:"alias,omitempty"`
	Workspace *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug,omitempty"`
	} `json:"workspace,omitempty"`
	Name        string          `json:"name"`
	KeyID       string          `json:"keyId,omitempty"`
	Permissions []string        `json:"permissions"`
	ExpiresAt   string          `json:"expiresAt,omitempty"`
	Checked     bool            `json:"checked"`
	Files       []agentkit.File `json:"files"`
	Notes       []string        `json:"notes"`
}

func runConnect(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "connect CODE [--name TEXT] [--alias SLUG] [--agent claude|codex|opencode|all|none] [--dir PATH]"
	if len(o.Args) > 2 {
		return agentUsage(r, o, "connect takes one code", usage)
	}
	if problem := agentFlagProblem(o, []string{"name", "alias", "agent", "dir", "preset"}, []string{"name", "alias", "agent", "dir", "preset"}); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	for name, value := range o.Flags {
		if api.LooksLikeToken(value) || api.IsAgentKey(value) {
			return agentUsage(r, o, "--"+name+" looks like a credential; this command takes a code from your workspace's agent settings, never a token", usage)
		}
	}
	code := ""
	if len(o.Args) == 2 {
		code = o.Args[1]
		if api.LooksLikeToken(code) || api.IsAgentKey(code) {
			return agentUsage(r, o, "that is a token, not a code. Set it as "+api.TokenVariable+" in the agent's environment, or get a code in your workspace's agent settings and run connect with it", usage)
		}
		if !api.LooksLikeConnectCode(code) {
			return agentUsage(r, o, "that is not a code from your workspace's agent settings (a code looks like R7K2-9QDM-4XHT)", usage)
		}
		if _, given := o.Flags["preset"]; given {
			return agentUsage(r, o, "a code already says what the agent may do; --preset is for a service on this computer, with no code", usage)
		}
	} else if buildinfo.CommandLineOnly() {
		return agentUsage(r, o, "give the code from your workspace's agent settings ("+hostedEndpoint+"/settings/agent)", usage)
	}
	var agents []agentkit.Agent
	switch chosen := o.Flags["agent"]; chosen {
	case "", "all":
		agents = agentkit.Agents
	case "none":
	default:
		var err error
		if agents, err = parseAgents(chosen); err != nil {
			return agentUsage(r, o, strings.Replace(err.Error(), "or all", "all or none", 1), usage)
		}
	}
	name := o.Flags["name"]
	if name == "" {
		name = defaultAgentName()
	}
	folder := o.Flags["dir"]
	if folder == "" {
		folder = "."
	}
	folder, err := realFolder(folder)
	if err != nil {
		return agentUsage(r, o, err.Error(), usage)
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return agentUsage(r, o, folder+" is not a folder; run this from the folder your agent works in, or choose one with --dir", usage)
	}

	// Before anything is asked of the service: the place the credential will be kept can be read and written. A code works once, so finding out afterwards would
	// leave a credential made and nowhere to put it.
	connections, err := api.LoadConnections(os.Getenv)
	if err == nil {
		err = api.SaveConnections(os.Getenv, connections)
	}
	if err != nil {
		return r.localError(o, "connections_unavailable", err.Error(), 4)
	}

	result := connectResult{Directory: folder, Files: []agentkit.File{}, Notes: []string{}, Permissions: []string{}}
	alias := strings.TrimSpace(o.Flags["alias"])
	if alias != "" {
		cleaned := api.SlugifyWorkspace(alias)
		if cleaned == "" {
			return agentUsage(r, o, "--alias must contain letters or digits", usage)
		}
		alias = cleaned
	}
	connection := api.Connection{Directory: folder, Alias: alias, ConnectedAt: time.Now().UTC().Format(time.RFC3339)}
	if code != "" {
		// A code is from a hosted workspace: that is where it goes unless the person named another address.
		endpoint := hostedEndpoint
		if o.EndpointGiven {
			endpoint = o.Endpoint
		}
		client, err := api.New(endpoint, o.BookID, o.Directory)
		if err != nil {
			return r.localError(o, "usage_error", err.Error(), 2)
		}
		asking, cancel := context.WithTimeout(ctx, connectTimeout)
		made, err := client.ConnectAgent(asking, code, name)
		cancel()
		if err != nil {
			return r.result(o, api.Response{}, err, "")
		}
		slug := made.WorkspaceSlug
		if slug == "" {
			slug = api.SlugifyWorkspace(made.WorkspaceName)
		}
		connection.Endpoint, connection.Key, connection.KeyID = client.Endpoint, made.Key, made.KeyID
		connection.Name, connection.ExpiresAt = made.Name, made.ExpiresAt
		connection.WorkspaceID, connection.WorkspaceName, connection.WorkspaceSlug = made.WorkspaceID, made.WorkspaceName, slug
		result.Alias = alias
		result.Permissions = made.Scopes
		result.Workspace = &struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Slug string `json:"slug,omitempty"`
		}{made.WorkspaceID, made.WorkspaceName, slug}
	} else {
		// The service on this computer: its owner makes a token for the agent. A folder's own connection is not what asks (a token cannot make a token).
		client, err := api.New(o.Endpoint, o.BookID, o.Directory)
		if err != nil {
			return r.localError(o, "usage_error", err.Error(), 2)
		}
		if client.Credential, err = api.CredentialFromEnvironment(os.Getenv); err != nil {
			return r.localError(o, "usage_error", err.Error(), 2)
		}
		preset := o.Flags["preset"]
		if preset == "" {
			preset = "draft"
		}
		permissions, known := agentkit.TokenPresets[preset]
		if !known {
			names := make([]string, 0, len(agentkit.TokenPresets))
			for candidate := range agentkit.TokenPresets {
				names = append(names, candidate)
			}
			sort.Strings(names)
			return agentUsage(r, o, "unknown preset "+strconv.Quote(preset)+" (choose "+strings.Join(names, ", ")+")", usage)
		}
		if name == "" {
			name = "Agent"
		}
		asking, cancel := context.WithTimeout(ctx, connectTimeout)
		created, err := client.TokensCreate(asking, api.AgentTokenCreateInput{Label: name, Permissions: permissions}, api.NewOperationID())
		cancel()
		if err != nil {
			return r.result(o, api.Response{}, err, "")
		}
		if created.Secret == nil {
			return r.localError(o, "response_invalid", "The service made the token and did not show it. Revoke "+created.Token.Label+" with rastrata tokens revoke "+created.Token.ID+" and run connect again.", 4)
		}
		connection.Endpoint, connection.Key, connection.KeyID = client.Endpoint, *created.Secret, created.Token.ID
		connection.Name, connection.ExpiresAt = created.Token.Label, created.Token.ExpiresAt
		result.Permissions = created.Token.Permissions
	}
	if err := api.SaveConnections(os.Getenv, api.PutConnection(connections, connection)); err != nil {
		// The credential exists and could not be kept. It is not printed: the person ends it where they can see it and starts again.
		return r.localError(o, "connections_unavailable", err.Error()+". The agent was connected but its credential could not be kept: disconnect "+strconv.Quote(connection.Name)+" in your workspace's agent settings, then run connect again with a new code.", 4)
	}
	result.Connected, result.Endpoint, result.Name, result.KeyID, result.ExpiresAt = true, connection.Endpoint, connection.Name, connection.KeyID, connection.ExpiresAt

	// Does the service take it? A hosted workspace exchanges the key for a short-lived token and the book answers with what the agent may do there now.
	if client, err := api.New(connection.Endpoint, o.BookID, o.Directory); err == nil {
		client.Credential = connection.Key
		looking, cancel := context.WithTimeout(ctx, connectTimeout)
		book, err := client.BookGet(looking, api.Empty{}, "")
		cancel()
		if err == nil {
			result.Checked = true
			if len(book.Permissions) > 0 {
				result.Permissions = book.Permissions
			}
		} else {
			var failure *api.Error
			reason := "the service did not answer"
			if errors.As(err, &failure) && failure.Response.Error != nil {
				reason = failure.Response.Error.Message
			}
			result.Notes = append(result.Notes, "The connection is kept, but it could not be checked just now ("+reason+"). Run rastrata agent status to check it.")
		}
	}

	// The instructions the agent follows, written into the folder for each agent: never a secret, never over a file that is not ours.
	if len(agents) > 0 {
		written, err := agentkit.Init(agentkit.Options{Dir: folder, Agents: agents, MCP: false})
		if err != nil {
			result.Notes = append(result.Notes, "The instructions for the agent were not written ("+err.Error()+"). Run rastrata agent init --agent all in the folder the agent works in.")
		} else {
			result.Files = written.Files
			for _, file := range written.Files {
				if file.Action == "skipped" {
					result.Notes = append(result.Notes, "Left "+file.Path+" as it is: "+file.Note)
				}
			}
		}
	}

	where := connection.WorkspaceName
	if where == "" {
		where = "your books"
	}
	line := "Connected to " + where + ". This agent can " + canDo(result.Permissions)
	if day := longDay(connection.ExpiresAt); day != "" {
		line += " until " + day
	}
	fmt.Fprintln(r.Diagnostics, line+".")
	for _, note := range result.Notes {
		fmt.Fprintln(r.Diagnostics, note)
	}
	return agentJSON(r, o, result)
}

type workspaceEntry struct {
	Selector    string `json:"selector"`
	ID          string `json:"id,omitempty"`
	Slug        string `json:"slug,omitempty"`
	Alias       string `json:"alias,omitempty"`
	Name        string `json:"name,omitempty"`
	Endpoint    string `json:"endpoint"`
	Directory   string `json:"directory"`
	KeyID       string `json:"keyId,omitempty"`
	AgentName   string `json:"agentName,omitempty"`
	ConnectedAt string `json:"connectedAt"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	Active      bool   `json:"active"`
}

func runWorkspaces(r Runner, _ context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 1 || len(o.Flags) > 0 {
		return r.localError(o, "usage_error", "Use rastrata workspaces", 2)
	}
	connections, err := api.LoadConnections(os.Getenv)
	if err != nil {
		return r.localError(o, "connections_unavailable", err.Error(), 4)
	}
	active, resolveErr := connectionHere(o)
	entries := make([]workspaceEntry, 0, len(connections))
	for _, c := range connections {
		slug := c.WorkspaceSlug
		if slug == "" && c.WorkspaceName != "" {
			slug = api.SlugifyWorkspace(c.WorkspaceName)
		}
		isActive := active != nil &&
			c.Endpoint == active.Endpoint &&
			c.WorkspaceID == active.WorkspaceID &&
			c.Directory == active.Directory &&
			c.KeyID == active.KeyID
		entries = append(entries, workspaceEntry{
			Selector:    c.SelectorOf(),
			ID:          c.WorkspaceID,
			Slug:        slug,
			Alias:       c.Alias,
			Name:        c.WorkspaceName,
			Endpoint:    c.Endpoint,
			Directory:   c.Directory,
			KeyID:       c.KeyID,
			AgentName:   c.Name,
			ConnectedAt: c.ConnectedAt,
			ExpiresAt:   c.ExpiresAt,
			Active:      isActive,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Selector != entries[j].Selector {
			return entries[i].Selector < entries[j].Selector
		}
		return entries[i].ID < entries[j].ID
	})
	payload := map[string]any{
		"workspaces": entries,
		"count":      len(entries),
	}
	if active != nil {
		payload["active"] = active.SelectorOf()
	} else if resolveErr != nil {
		payload["ambiguity"] = resolveErr.Error()
		fmt.Fprintln(r.Diagnostics, resolveErr.Error())
	}
	return agentJSON(r, o, payload)
}

func runDisconnect(r Runner, _ context.Context, o Options, _ *api.Client) int {
	const usage = "disconnect [--workspace SLUG|ID] [--all]"
	if len(o.Args) != 1 {
		return agentUsage(r, o, "disconnect takes options only", usage)
	}
	if problem := agentFlagProblem(o, []string{"all"}, nil); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	connections, err := api.LoadConnections(os.Getenv)
	if err != nil {
		return r.localError(o, "connections_unavailable", err.Error(), 4)
	}
	if o.Flags["all"] == "true" {
		if err := api.SaveConnections(os.Getenv, []api.Connection{}); err != nil {
			return r.localError(o, "connections_unavailable", err.Error(), 4)
		}
		fmt.Fprintf(r.Diagnostics, "Disconnected %d workspace connection(s) from this computer.\n", len(connections))
		return agentJSON(r, o, map[string]any{"removed": len(connections), "remaining": 0})
	}
	target, err := connectionHere(o)
	if err != nil {
		return r.localError(o, "usage_error", err.Error(), 2)
	}
	if target == nil {
		return r.localError(o, "not_connected", "No connected workspace matches this folder. Run rastrata workspaces to list connected workspaces.", 3)
	}
	remaining := api.RemoveConnection(connections, *target)
	if err := api.SaveConnections(os.Getenv, remaining); err != nil {
		return r.localError(o, "connections_unavailable", err.Error(), 4)
	}
	fmt.Fprintf(r.Diagnostics, "Disconnected %s from this computer.\n", target.SelectorOf())
	return agentJSON(r, o, map[string]any{
		"removed":   1,
		"selector":  target.SelectorOf(),
		"workspace": target.WorkspaceID,
		"remaining": len(remaining),
	})
}

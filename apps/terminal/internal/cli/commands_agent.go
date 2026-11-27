package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/agentkit"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
)

// The agent lane's setup commands. They need no running service, so a person can prepare a project
// before the service is up; each looks at the service on a short timeout and reports what it finds,
// so a service that is open to every program on this computer is said out loud, never silent.
//
//	rastrata agent init --agent claude|codex|opencode|all [--dir PATH] [--mcp=false] [--mcp-url URL]
//	                    [--force] [--dry-run]
//	rastrata agent guide [--format json]
//	rastrata agent status
//
// `agent init` writes the runbook and the guide for the chosen agents into the project, from one
// text that the MCP server also serves. It never writes a secret: a token is named by its
// environment variable, RASTRATA_TOKEN, and nothing here reads it except to ask the service who it is.
func init() {
	Register(Command{Name: "agent init", Offline: true, Summary: "Set up an agent in this project: writes the runbook and guide, never a secret --agent claude|codex|opencode|all [--dir PATH] [--mcp=false] [--mcp-url URL] [--force] [--dry-run]", Run: runAgentInit})
	Register(Command{Name: "agent guide", Offline: true, Summary: "Print the full bookkeeping guide for this version of Rastrata, with the table of tools and operations [--format json]", Run: runAgentGuide})
	Register(Command{Name: "agent status", Offline: true, Summary: "Who you are to the service: principal, permissions, token expiry, and whether the service is open to any program on this computer", Run: runAgentStatus})
}

// probeTimeout bounds the look at the service so setup never hangs on a service that is not there.
const probeTimeout = 3 * time.Second

// serviceStatus is what the service says about the caller, or why it could not.
type serviceStatus struct {
	Endpoint      string   `json:"endpoint"`
	Reachable     bool     `json:"reachable"`
	Authenticated bool     `json:"authenticated"`
	Credential    string   `json:"credential"`
	Principal     string   `json:"principal,omitempty"`
	TokenID       string   `json:"tokenId,omitempty"`
	Label         string   `json:"label,omitempty"`
	ExpiresAt     string   `json:"expiresAt,omitempty"`
	Permissions   []string `json:"permissions,omitempty"`
	OwnerAccess   string   `json:"ownerAccess,omitempty"`
	ErrorCode     string   `json:"errorCode,omitempty"`
	Notes         []string `json:"notes"`
}

const openNote = "Owner access is OPEN: any program running as you on this computer can use Rastrata without a token. An agent token limits an agent that uses it; it cannot stop a program that ignores it. Start the service with RASTRATA_OWNER_KEY_FILE to require the owner key. Even then, a program running as you can read that file, so on one computer the lock bounds a well-behaved agent configured with a token, not hostile software."

// lookAtService asks the service who this process is. It never fails the command: an unreachable or
// locked service is information.
func lookAtService(ctx context.Context, o Options) serviceStatus {
	// What this folder was connected with (rastrata connect) says where the service is too.
	credential, source, problem := credentialFor(&o)
	status := serviceStatus{Endpoint: o.Endpoint, Credential: source, Notes: []string{}}
	if problem != nil {
		status.Notes = append(status.Notes, problem.Error())
		return status
	}
	client, err := api.New(o.Endpoint, o.BookID, o.Directory)
	if err != nil {
		status.Notes = append(status.Notes, err.Error())
		return status
	}
	client.Credential = credential
	look, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	book, err := client.BookGet(look, api.Empty{}, "")
	if err != nil {
		failure, answered := err.(*api.Error)
		code := ""
		if answered && failure.Response.Error != nil {
			code = failure.Response.Error.Code
		}
		// The client reports a service that did not answer as an error too; it did not answer.
		if answered && code != "connection_failed" && code != "operation_unresolved" {
			status.Reachable = true
			status.ErrorCode = code
			switch status.ErrorCode {
			case "authentication_required":
				status.OwnerAccess = "key"
				status.Notes = append(status.Notes, "The service requires credentials and none were given. Run rastrata connect CODE in this folder with a code from your workspace's agent settings, or set "+api.TokenVariable+" to an agent token, or "+api.OwnerKeyFileVariable+" if you are the owner.")
			case "token_revoked", "token_expired", "token_invalid":
				status.Notes = append(status.Notes, "The service refused this token ("+status.ErrorCode+"). Ask the owner to connect the agent again: rastrata connect CODE, with a new code from the workspace's agent settings.")
			default:
				status.Notes = append(status.Notes, err.Error())
			}
			return status
		}
		if buildinfo.CommandLineOnly() {
			status.Notes = append(status.Notes, "The workspace at "+o.Endpoint+" did not answer. Check this computer's connection to the internet and the address in RASTRATA_API_URL ("+hostedEndpoint+" unless you set another).")
			return status
		}
		status.Notes = append(status.Notes, "The service at "+o.Endpoint+" is not reachable. That is fine for writing files; start it with "+startCommand()+" before the agent works.")
		return status
	}
	status.Reachable, status.Authenticated = true, true
	status.Permissions = book.Permissions
	status.OwnerAccess = "open"
	if book.OwnerAccess != nil {
		status.OwnerAccess = *book.OwnerAccess
	}
	status.Principal = "owner"
	if book.Principal != nil {
		status.Principal = book.Principal.Kind
		if book.Principal.TokenID != nil {
			status.TokenID = *book.Principal.TokenID
		}
		if book.Principal.Label != nil {
			status.Label = *book.Principal.Label
		}
		if book.Principal.ExpiresAt != nil {
			status.ExpiresAt = *book.Principal.ExpiresAt
		}
	}
	if status.Principal == "owner" && status.Credential != "owner key" {
		status.Notes = append(status.Notes, "No agent is connected in this folder and no token is set, so commands here run as the owner. Give an agent only a token: run rastrata connect in the folder it works in, or create one with rastrata tokens create and set "+api.TokenVariable+" in the agent's environment.")
	}
	if status.Principal == "token" {
		status.Notes = append(status.Notes, "This token grants: "+strings.Join(status.Permissions, ", ")+".")
		if expires, err := time.Parse(time.RFC3339, status.ExpiresAt); err == nil && time.Until(expires) < 14*24*time.Hour {
			status.Notes = append(status.Notes, "This token expires within 14 days ("+status.ExpiresAt+"). Ask the owner for a replacement before it does.")
		}
	}
	if status.OwnerAccess == "open" {
		status.Notes = append(status.Notes, openNote)
	}
	return status
}

func agentJSON(r Runner, o Options, data any) int {
	encoded, err := json.Marshal(data)
	if err != nil {
		return r.localError(o, "client_error", err.Error(), 4)
	}
	return r.result(o, api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: encoded}, nil, "")
}

func runAgentStatus(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 2 || len(o.Flags) > 0 {
		return agentUsage(r, o, "agent status takes no arguments", "agent status")
	}
	status := lookAtService(ctx, o)
	exit := agentJSON(r, o, status)
	if exit != 0 {
		return exit
	}
	switch {
	case !status.Reachable:
		return 4
	case !status.Authenticated:
		return 3
	}
	return 0
}

func runAgentGuide(r Runner, _ context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 2 || len(o.Flags) > 0 {
		return agentUsage(r, o, "agent guide takes no arguments", "agent guide [--format json]")
	}
	if !o.FormatGiven {
		fmt.Fprint(r.Output, agentkit.Guide())
		return 0
	}
	return agentJSON(r, o, map[string]string{"uri": "skill://rastrata/bookkeeping/SKILL.md", "digest": agentkit.GuideDigest(), "text": agentkit.Guide()})
}

func runAgentInit(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "agent init --agent claude|codex|opencode|all [--dir PATH] [--mcp=false] [--mcp-url URL] [--force] [--dry-run]"
	if len(o.Args) != 2 {
		return agentUsage(r, o, "agent init takes only options", usage)
	}
	if problem := agentFlagProblem(o, []string{"agent", "dir", "mcp", "mcp-url", "force", "dry-run"}, []string{"agent", "dir", "mcp-url"}); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	for name, value := range o.Flags {
		if api.LooksLikeToken(value) {
			return agentUsage(r, o, "--"+name+" looks like a credential; this command never takes one, and never writes one", usage)
		}
	}
	// The installed package has no MCP server to point an entry at: an agent uses this command line
	// with its token. --mcp=true still writes the entry for someone who runs the server themselves.
	options := agentkit.Options{MCP: !buildinfo.Installed()}
	var err error
	if options.Agents, err = parseAgents(o.Flags["agent"]); err != nil {
		return agentUsage(r, o, err.Error(), usage)
	}
	for name, target := range map[string]*bool{"mcp": &options.MCP, "force": &options.Force, "dry-run": &options.DryRun} {
		if value, given := o.Flags[name]; given {
			switch strings.ToLower(value) {
			case "true", "yes", "1":
				*target = true
			case "false", "no", "0":
				*target = false
			default:
				return agentUsage(r, o, "--"+name+" is true or false", usage)
			}
		}
	}
	options.Dir = o.Flags["dir"]
	if options.Dir == "" {
		options.Dir = "."
	}
	if options.Dir, err = filepath.Abs(options.Dir); err != nil {
		return agentUsage(r, o, err.Error(), usage)
	}
	if raw := o.Flags["mcp-url"]; raw != "" {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") || parsed.User != nil {
			return agentUsage(r, o, "--mcp-url must be a loopback HTTP address such as "+agentkit.DefaultMCPURL, usage)
		}
		options.MCPURL = raw
	}
	result, err := agentkit.Init(options)
	if err != nil {
		return agentUsage(r, o, err.Error(), usage)
	}
	service := lookAtService(ctx, o)
	skipped := false
	for _, file := range result.Files {
		if file.Action == "skipped" {
			skipped = true
			fmt.Fprintf(r.Diagnostics, "Skipped %s: %s\n", file.Path, file.Note)
		}
	}
	exit := agentJSON(r, o, struct {
		agentkit.Result
		Service serviceStatus `json:"service"`
	}{result, service})
	if exit == 0 && skipped {
		return 3
	}
	return exit
}

func parseAgents(value string) ([]agentkit.Agent, error) {
	if value == "" {
		return nil, fmt.Errorf("--agent is required: choose claude, codex, opencode or all")
	}
	if value == "all" {
		return agentkit.Agents, nil
	}
	seen := map[agentkit.Agent]bool{}
	chosen := []agentkit.Agent{}
	for _, item := range strings.Split(value, ",") {
		agent := agentkit.Agent(strings.TrimSpace(item))
		known := false
		for _, candidate := range agentkit.Agents {
			known = known || candidate == agent
		}
		if !known {
			return nil, fmt.Errorf("unknown agent %q: choose claude, codex, opencode or all", strings.TrimSpace(item))
		}
		if !seen[agent] {
			seen[agent] = true
			chosen = append(chosen, agent)
		}
	}
	return chosen, nil
}

package cli

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/agentkit"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The agent lane's token commands. The owner creates a token for an agent, gives it to the agent
// as RASTRATA_TOKEN, and can revoke it at any time. A token holds a subset of read, draft, post,
// configure, correct and close, never provision, so an agent cannot create, widen or revoke a
// token. The secret is shown once, on stdout, and is never written to the request journal.
//
//	rastrata tokens create --label TEXT [--preset read-only|draft|bookkeeper | --permissions a,b]
//	                       [--expires-in-days N]
//	rastrata tokens list [--active]
//	rastrata tokens revoke TOKEN_ID [--reason TEXT]
//	rastrata tokens activity [--token TOKEN_ID] [--page N]
func init() {
	Register(Command{Name: "tokens create", Summary: "Agent access: create a scoped token for an agent, shown once --label TEXT [--preset read-only|draft|bookkeeper | --permissions read,draft,...] [--expires-in-days N]. No preset includes close, which lets an agent finish reconciliations and close periods with no review first: leave it off unless you want that", Run: runTokensCreate})
	Register(Command{Name: "tokens list", Summary: "Agent access: tokens with their access, expiry, last use and status, and whether the service requires the owner key [--active]", Run: runTokensList})
	Register(Command{Name: "tokens revoke", Summary: "Agent access: revoke a token now; it cannot be restored TOKEN_ID [--reason TEXT]", Run: runTokensRevoke})
	Register(Command{Name: "tokens activity", Summary: "Agent access: what agents did with their tokens, newest first [--token TOKEN_ID] [--page N]", Run: runTokensActivity})
}

// agentFlagProblem names the first flag that is not allowed, or a valued flag given without a value.
func agentFlagProblem(o Options, allowed, valued []string) string {
	known := map[string]bool{}
	for _, name := range allowed {
		known[name] = true
	}
	names := make([]string, 0, len(o.Flags))
	for name := range o.Flags {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !known[name] {
			return "unknown option --" + name
		}
	}
	for _, name := range valued {
		if value, given := o.Flags[name]; given && (value == "true" || value == "") {
			return "--" + name + " needs a value"
		}
	}
	return ""
}

func agentUsage(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

func agentCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) int {
	definition, _ := api.FindOperation(operation)
	operationID := ""
	if definition.Writes {
		operationID = o.OperationID
		if operationID == "" {
			operationID = api.NewOperationID()
		}
		fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
	}
	response, err := c.Call(ctx, operation, input, operationID)
	return r.result(o, response, err, "")
}

func runTokensCreate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "tokens create --label TEXT [--preset read-only|draft|bookkeeper | --permissions read,draft,...] [--expires-in-days N]"
	if len(o.Args) != 2 {
		return agentUsage(r, o, "tokens create takes only options", usage)
	}
	if problem := agentFlagProblem(o, []string{"label", "preset", "permissions", "expires-in-days"}, []string{"label", "preset", "permissions", "expires-in-days"}); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	label, given := o.Flags["label"]
	if !given {
		return agentUsage(r, o, "--label is required: say which agent this token is for, for example --label \"Claude Code on the laptop\"", usage)
	}
	if api.LooksLikeToken(label) {
		return agentUsage(r, o, "the label looks like a credential; a label is a name for people", usage)
	}
	if _, preset := o.Flags["preset"]; preset {
		if _, permissions := o.Flags["permissions"]; permissions {
			return agentUsage(r, o, "choose --preset or --permissions, not both", usage)
		}
	}
	var permissions []string
	switch {
	case o.Flags["permissions"] != "":
		for _, item := range strings.Split(o.Flags["permissions"], ",") {
			permissions = append(permissions, strings.TrimSpace(item))
		}
	case o.Flags["preset"] != "":
		chosen, exists := agentkit.TokenPresets[o.Flags["preset"]]
		if !exists {
			names := make([]string, 0, len(agentkit.TokenPresets))
			for name := range agentkit.TokenPresets {
				names = append(names, name)
			}
			sort.Strings(names)
			return agentUsage(r, o, "unknown preset "+strconv.Quote(o.Flags["preset"])+" (choose "+strings.Join(names, ", ")+")", usage)
		}
		permissions = chosen
	default:
		permissions = agentkit.TokenPresets["draft"]
		fmt.Fprintln(r.Diagnostics, "No access chosen: creating the token with read and draft, the default for an agent. Use --preset or --permissions to choose.")
	}
	input := map[string]any{"label": label, "permissions": permissions}
	if raw, given := o.Flags["expires-in-days"]; given {
		days, err := strconv.Atoi(raw)
		if err != nil || days < 1 || days > agentkit.MaxTokenDays {
			return agentUsage(r, o, fmt.Sprintf("--expires-in-days must be a whole number from 1 to %d", agentkit.MaxTokenDays), usage)
		}
		input["expiresInDays"] = days
	}
	for _, permission := range permissions {
		if permission == "close" {
			fmt.Fprintln(r.Diagnostics, "This token holds close: the agent can finish reconciliations and close accounting periods with no review from you first. No preset includes close; leave it off unless you want the agent to do those steps on its own.")
			break
		}
	}
	fmt.Fprintln(r.Diagnostics, "The token is shown once, in this command's output. Give it to the agent as RASTRATA_TOKEN; do not save it in a file in your project. If you lose it, revoke it and create another.")
	return agentCall(r, ctx, o, c, "tokens.create", input)
}

func runTokensList(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "tokens list [--active]"
	if len(o.Args) != 2 {
		return agentUsage(r, o, "tokens list takes only options", usage)
	}
	if problem := agentFlagProblem(o, []string{"active"}, nil); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if value, given := o.Flags["active"]; given {
		switch strings.ToLower(value) {
		case "true", "yes", "1":
			input["active"] = true
		case "false", "no", "0":
		default:
			return agentUsage(r, o, "--active is true or false", usage)
		}
	}
	return agentCall(r, ctx, o, c, "tokens.list", input)
}

func runTokensRevoke(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "tokens revoke TOKEN_ID [--reason TEXT]"
	if len(o.Args) != 3 {
		return agentUsage(r, o, "name the token to revoke (its id is in tokens list)", usage)
	}
	if problem := agentFlagProblem(o, []string{"reason"}, []string{"reason"}); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	input := map[string]any{"tokenId": strings.TrimPrefix(o.Args[2], "rst_")}
	if reason := o.Flags["reason"]; reason != "" {
		input["reason"] = reason
	}
	return agentCall(r, ctx, o, c, "tokens.revoke", input)
}

func runTokensActivity(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "tokens activity [--token TOKEN_ID] [--page N]"
	if len(o.Args) != 2 {
		return agentUsage(r, o, "tokens activity takes only options", usage)
	}
	if problem := agentFlagProblem(o, []string{"token", "page"}, []string{"token", "page"}); problem != "" {
		return agentUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if token := o.Flags["token"]; token != "" {
		input["tokenId"] = strings.TrimPrefix(token, "rst_")
	}
	if raw, given := o.Flags["page"]; given {
		page, err := strconv.Atoi(raw)
		if err != nil || page < 1 || page > 100000 {
			return agentUsage(r, o, "--page must be a whole number from 1", usage)
		}
		input["page"] = page
	}
	return agentCall(r, ctx, o, c, "tokens.activity", input)
}

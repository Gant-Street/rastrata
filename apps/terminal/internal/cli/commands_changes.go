package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The changes lane's commands: one list of what changed in the books, who made each change and when,
// and the record that a person has looked at the changes up to a point.
//
//	rastrata changes [--since last-review|last-close|REVISION|YYYY-MM-DD] [--until REVISION|YYYY-MM-DD]
//	                 [--kind KIND[,KIND]] [--by KIND[:NAME|@ID]] [--text TEXT] [--page N] [--page-size N]
//	                 [--revision N] [--read-at INSTANT]
//	rastrata changes review [--up-to-revision N] [--up-to-time INSTANT] [--note TEXT]
//
// Both print the application's JSON envelope, or, with --format text, the changes a person reads: one
// line each, newest first, and under them the sources that were and were not read. An agent reads the
// list at the end of a routine to say what it did. Only a person can mark changes as looked at: the
// service refuses an agent (review_needs_a_person).
func init() {
	Register(Command{
		Name: "changes",
		Summary: "What changed in the books, who made it and when: changes [--since last-review|last-close|REVISION|DATE] " +
			"[--until REVISION|DATE] [--kind K] [--by KIND[:NAME|@ID]] [--text TEXT] [--page N] [--page-size N] [--format text]",
		Run: runChanges,
	})
	Register(Command{
		Name: "changes review",
		Summary: "Say you have looked at the changes up to now (a person only): changes review " +
			"[--up-to-revision N --up-to-time INSTANT] [--note TEXT]",
		Run: runChangesReview,
	})
}

const (
	changesUsage = "changes [--since last-review|last-close|REVISION|YYYY-MM-DD] [--until REVISION|YYYY-MM-DD] " +
		"[--kind KIND[,KIND]] [--by KIND[:NAME|@ID]] [--text TEXT] [--page N] [--page-size N] [--revision N] [--read-at INSTANT]"
	changesReviewUsage = "changes review [--up-to-revision N --up-to-time INSTANT] [--note TEXT] " +
		"(without a point it marks everything up to now as looked at)"
)

var (
	changesRevision = regexp.MustCompile(`^[0-9]{1,18}$`)
	changesDate     = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	changesInstant  = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$`)
	changesKinds    = map[string]bool{
		"entry.posted": true, "entry.reversed": true, "period.closed": true, "period.reopened": true,
		"calendar.extended": true, "account.added": true, "account.changed": true, "account.closed": true,
		"account.tagged": true, "rule.created": true, "rule.changed": true,
		"reconciliation.completed": true, "reconciliation.voided": true, "access.granted": true,
		"access.revoked": true, "book.opened": true, "book.changed": true,
	}
	changesActors = map[string]bool{"owner": true, "person": true, "agent": true, "service": true, "unknown": true}
)

// changesFlagProblem is a usage problem with the flags a changes command was given, or "".
func changesFlagProblem(o Options, valued ...string) string {
	known := map[string]bool{}
	for _, name := range valued {
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
		if value, given := o.Flags[name]; given && (value == "" || value == "true") {
			return "--" + name + " needs a value"
		}
	}
	return ""
}

// changesSince turns --since into what the service reads: the two names the book gives a point
// (last-review, last-close), a revision or a date.
func changesSince(value string) (string, bool) {
	switch value {
	case "last-review":
		return "lastReview", true
	case "last-close":
		return "lastClose", true
	}
	if changesRevision.MatchString(value) || changesDate.MatchString(value) {
		return value, true
	}
	return "", false
}

func runChanges(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 1 {
		return r.localError(o, "usage_error", "changes takes only options. Use "+changesUsage, 2)
	}
	if problem := changesFlagProblem(o, "since", "until", "kind", "by", "text", "page", "page-size", "read-at"); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+changesUsage, 2)
	}
	input := map[string]any{}
	if value, given := o.Flags["since"]; given {
		since, ok := changesSince(value)
		if !ok {
			return r.localError(o, "usage_error", "--since is last-review, last-close, a revision number or a date such as 2026-03-31. Use "+changesUsage, 2)
		}
		input["since"] = since
	}
	if value, given := o.Flags["until"]; given {
		if !changesRevision.MatchString(value) && !changesDate.MatchString(value) {
			return r.localError(o, "usage_error", "--until is a revision number or a date such as 2026-03-31. Use "+changesUsage, 2)
		}
		input["until"] = value
	}
	if value, given := o.Flags["kind"]; given {
		kinds := []string{}
		for _, kind := range strings.Split(value, ",") {
			kind = strings.TrimSpace(kind)
			if !changesKinds[kind] {
				return r.localError(o, "usage_error", "--kind "+strconv.Quote(kind)+" is not a kind of change (for example entry.posted, period.closed, rule.created). Use "+changesUsage, 2)
			}
			kinds = append(kinds, kind)
		}
		input["kinds"] = kinds
	}
	if value, given := o.Flags["by"]; given {
		// A kind, then optionally a name after ":" (agent:weekly-run) or an identifier after "@" (agent@tok_7f3a91c2),
		// whichever comes first: a name may hold either character.
		kind, separator, rest := value, "", ""
		if at := strings.IndexAny(value, ":@"); at >= 0 {
			kind, separator, rest = value[:at], value[at:at+1], value[at+1:]
		}
		if !changesActors[kind] || (separator != "" && rest == "") {
			return r.localError(o, "usage_error", "--by is owner, person, agent, service or unknown, optionally followed by :NAME (agent:weekly-run) or @ID (agent@tok_7f3a91c2). Use "+changesUsage, 2)
		}
		by := map[string]any{"kind": kind}
		if separator == ":" {
			by["label"] = rest
		} else if separator == "@" {
			by["id"] = rest
		}
		input["by"] = by
	}
	if value, given := o.Flags["text"]; given {
		input["text"] = value
	}
	for flag, field := range map[string]string{"page": "page", "page-size": "pageSize"} {
		if value, given := o.Flags[flag]; given {
			number, err := strconv.Atoi(value)
			if err != nil || number < 1 {
				return r.localError(o, "usage_error", "--"+flag+" must be a whole number from 1. Use "+changesUsage, 2)
			}
			input[field] = number
		}
	}
	if o.Revision != "" {
		if !changesRevision.MatchString(o.Revision) {
			return r.localError(o, "usage_error", "--revision must be a revision number. Use "+changesUsage, 2)
		}
		input["revision"] = o.Revision
	}
	if value, given := o.Flags["read-at"]; given {
		if !changesInstant.MatchString(value) {
			return r.localError(o, "usage_error", "--read-at is an instant such as 2026-04-02T12:00:00.000Z, the asOf of the first page. Use "+changesUsage, 2)
		}
		input["asOf"] = value
	}
	response, err := c.Call(ctx, "changes.list", input, "")
	if err == nil && o.Format == "text" {
		return r.printChangesText(o, response)
	}
	return r.result(o, response, err, "")
}

// changeLine is the part of a change the text form prints.
type changeLine struct {
	At      string `json:"at"`
	Summary string `json:"summary"`
	By      struct {
		Kind  string `json:"kind"`
		Label string `json:"label"`
	} `json:"by"`
	How string `json:"how"`
}

type changeSource struct {
	Title  string  `json:"title"`
	Read   bool    `json:"read"`
	Reason *string `json:"reason"`
}

// printChangesText prints the list a person reads: when, who, what; and under it what was not read.
func (r Runner) printChangesText(o Options, response api.Response) int {
	var list struct {
		Revision string       `json:"revision"`
		Count    int          `json:"count"`
		Page     int          `json:"page"`
		PageSize int          `json:"pageSize"`
		Changes  []changeLine `json:"changes"`
		Window   struct {
			Since string `json:"since"`
		} `json:"window"`
		Sources    []changeSource `json:"sources"`
		NotCovered []string       `json:"notCovered"`
	}
	if err := json.Unmarshal(response.Data, &list); err != nil {
		return r.localError(o, "response_invalid", "The service's answer could not be read: "+err.Error(), 4)
	}
	fmt.Fprintf(r.Output, "Changes since %s: %d\n", list.Window.Since, list.Count)
	for _, change := range list.Changes {
		who := change.By.Label
		if change.By.Kind == "unknown" {
			who = "not recorded"
		}
		fmt.Fprintf(r.Output, "%s  %-18s  %s\n", change.At, who, change.Summary)
	}
	if list.Count > len(list.Changes) {
		fmt.Fprintf(r.Output, "(page %d shows %d of %d; use --page)\n", list.Page, len(list.Changes), list.Count)
	}
	for _, source := range list.Sources {
		if !source.Read {
			reason := ""
			if source.Reason != nil {
				reason = *source.Reason
			}
			fmt.Fprintf(r.Output, "Not read in full: %s. %s\n", source.Title, reason)
		}
	}
	if len(list.NotCovered) > 0 {
		fmt.Fprintf(r.Output, "Not covered by this list: %s.\n", strings.Join(list.NotCovered, "; "))
	}
	return 0
}

func runChangesReview(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "changes review takes only options. Use "+changesReviewUsage, 2)
	}
	if problem := changesFlagProblem(o, "up-to-revision", "up-to-time", "note"); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+changesReviewUsage, 2)
	}
	input := map[string]any{}
	revision, hasRevision := o.Flags["up-to-revision"]
	instant, hasInstant := o.Flags["up-to-time"]
	if hasRevision != hasInstant {
		return r.localError(o, "usage_error", "--up-to-revision and --up-to-time go together: they are the revision and the asOf of the list that was looked at. Use "+changesReviewUsage, 2)
	}
	if hasRevision {
		if !changesRevision.MatchString(revision) || !changesInstant.MatchString(instant) {
			return r.localError(o, "usage_error", "--up-to-revision is a revision number and --up-to-time an instant such as 2026-04-02T12:00:00.000Z. Use "+changesReviewUsage, 2)
		}
		input["upToRevision"] = revision
		input["upToAt"] = instant
	} else {
		// Without a point, what is marked is what is in the book now, and the person is told how much that is.
		list, err := c.Call(ctx, "changes.list", map[string]any{"since": "lastReview", "pageSize": 1}, "")
		if err != nil {
			return r.result(o, list, err, "")
		}
		var read struct {
			Revision string `json:"revision"`
			AsOf     string `json:"asOf"`
			Count    int    `json:"count"`
		}
		if err := json.Unmarshal(list.Data, &read); err != nil {
			return r.localError(o, "response_invalid", "The service's answer could not be read: "+err.Error(), 4)
		}
		fmt.Fprintf(r.Diagnostics, "Marking the %d changes since the last look, up to revision %s, as looked at.\n", read.Count, read.Revision)
		input["upToRevision"] = read.Revision
		input["upToAt"] = read.AsOf
	}
	if note, given := o.Flags["note"]; given {
		input["note"] = note
	}
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for changes.review; use operations requests or operations resume after interruption.\n", operationID)
	response, err := c.Call(ctx, "changes.review", input, operationID)
	return r.result(o, response, err, "")
}

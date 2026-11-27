package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The rules lane's commands. Rules and the classifier only ever propose: nothing here books
// anything. Agents write rules and rules do the daily work, so these commands are built for an
// agent to run as much as a person: every command prints the application's JSON envelope, writes
// carry a retained operation identity, and an edit says which revision it was based on.
//
//	rastrata rules list [--usage] [--days N] [--deleted]
//	rastrata rules show RULE_ID
//	rastrata rules suggest (--item ITEM_ID | --description TEXT --amount AMOUNT) [--category ACCOUNT_ID]
//	rastrata rules test (RULE_ID | --input RULE.json) [--days N] [--samples N] [--position N]
//	rastrata rules create (--input RULE.json | --name N --contains TEXT --category ACCOUNT_ID ...)
//	rastrata rules update RULE_ID (--input RULE.json | --name N ...) [--version N]
//	rastrata rules enable|disable RULE_ID, rules delete RULE_ID --reason TEXT, rules move, rules reorder
//	rastrata classifier status|train|evaluate|configure
//
// Who made a rule is recorded: a person by default, an agent with --agent NAME or the
// RASTRATA_AGENT environment variable. It is a record for a reviewer, not an access control.
func init() {
	for name, command := range map[string]struct {
		summary string
		run     func(Runner, context.Context, Options, *api.Client) int
	}{
		"list":    {"List the rules in priority order: list [--usage] [--days N] [--deleted]", runRulesList},
		"show":    {"Show one rule with its revision history: show RULE_ID", runRulesShow},
		"suggest": {"Generalise one line into a candidate rule: suggest (--item ID | --description TEXT --amount AMOUNT)", runRulesSuggest},
		"test":    {"Dry-run a rule against the Inbox and history: test (RULE_ID | --input FILE)", runRulesTest},
		"create":  {"Create a rule: create (--input FILE|- | --name N --contains TEXT --category ACCOUNT_ID)", runRulesCreate},
		"update":  {"Replace a rule's definition: update RULE_ID (--input FILE|- | --name N ...) [--version N]", runRulesUpdate},
		"enable":  {"Switch a rule on: enable RULE_ID [--version N]", runRulesEnable},
		"disable": {"Switch a rule off: disable RULE_ID [--version N]", runRulesDisable},
		"delete":  {"Retire a rule: delete RULE_ID --reason TEXT [--version N]", runRulesDelete},
		"move":    {"Move a rule in the priority order: move RULE_ID --to POSITION", runRulesMove},
		"reorder": {"Set the whole priority order: reorder RULE_ID...", runRulesReorder},
	} {
		Register(Command{Name: "rules " + name, Summary: command.summary, Run: command.run})
	}
	for name, command := range map[string]struct {
		summary string
		run     func(Runner, context.Context, Options, *api.Client) int
	}{
		"status":    {"Show the local classifier: thresholds, training and last evaluation", runClassifierStatus},
		"train":     {"Learn from posted history and Inbox decisions again, then re-measure", runClassifierTrain},
		"evaluate":  {"Measure the classifier on this book's history: evaluate [--min-agreement N ...]", runClassifierEvaluate},
		"configure": {"Change thresholds: configure [--enabled true|false] [--min-agreement N] [--min-margin N] [--min-examples N] [--min-known-words N]", runClassifierConfigure},
	} {
		Register(Command{Name: "classifier " + name, Summary: command.summary, Run: command.run})
	}
}

// rulesFlagProblem returns a usage message when a flag is not one of allowed, or is one that needs
// a value but was given bare (a bare flag reads as "true").
func rulesFlagProblem(o Options, allowed []string, valued []string) string {
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

// rulesSplitList splits a comma separated list, dropping empty items.
func rulesSplitList(value string) []string {
	items := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

func rulesUsage(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

// rulesCall sends one operation. Writes carry a retained identity: --operation-id when given,
// otherwise a new one, announced so an interrupted run can be resumed.
func rulesCall(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) int {
	response, err := rulesSend(r, ctx, o, c, operation, input)
	return r.result(o, response, err, "")
}

func rulesSend(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) (api.Response, error) {
	definition, _ := api.FindOperation(operation)
	operationID := ""
	if definition.Writes {
		operationID = o.OperationID
		if operationID == "" {
			operationID = api.NewOperationID()
		}
		fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", operationID, operation)
	}
	return c.Call(ctx, operation, input, operationID)
}

// rulesRead calls a read operation and decodes its data into a generic object.
func rulesRead(ctx context.Context, c *api.Client, operation string, input map[string]any) (map[string]any, error) {
	response, err := c.Call(ctx, operation, input, "")
	if err != nil {
		return nil, err
	}
	var data map[string]any
	if err := json.Unmarshal(response.Data, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// rulesAuthored adds who is making the change to a write's input, when the caller says it is an
// agent (--agent NAME or RASTRATA_AGENT). Otherwise nothing is sent and the service records what it
// knows the caller to be: a scoped agent token is always an agent, the owner is a person. A
// declaration made with the owner's own access is a note for a reviewer, not something the service
// can check.
func rulesAuthored(o Options, input map[string]any) map[string]any {
	name := strings.TrimSpace(o.Flags["agent"])
	if name == "" || name == "true" {
		name = strings.TrimSpace(os.Getenv("RASTRATA_AGENT"))
	}
	if name != "" {
		if len(name) > 80 {
			name = name[:80]
		}
		input["madeBy"] = map[string]any{"kind": "agent", "name": name}
	}
	return input
}

// rulesReadObject reads one JSON object from --input (a file, or - for stdin), at most 128 KiB.
func rulesReadObject(r Runner, o Options) (map[string]any, error) {
	reader := r.Input
	if o.Input != "-" {
		file, err := os.Open(o.Input)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		reader = file
	}
	raw, err := io.ReadAll(io.LimitReader(reader, 131073))
	if err != nil || len(raw) > 131072 {
		return nil, fmt.Errorf("the input is unreadable or exceeds 128 KiB")
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, fmt.Errorf("the input must be one JSON object")
	}
	return object, nil
}

// rulesDefinition finds the rule definition in what a person or an agent supplied: the rule itself,
// a create input ({"rule": ...}), what `rules suggest` printed ({"rule": ..., "basis": ...}) or the
// whole envelope of either ({"data": {"rule": ...}}), so one command can feed the next.
func rulesDefinition(object map[string]any) (map[string]any, bool) {
	if data, ok := object["data"].(map[string]any); ok {
		return rulesDefinition(data)
	}
	if rule, ok := object["rule"].(map[string]any); ok {
		return rule, true
	}
	if _, hasAction := object["action"]; hasAction {
		return object, true
	}
	return nil, false
}

// rulesDefinitionFields are the parts of a rule a person writes, as rules.update takes them.
var rulesDefinitionFields = []string{"name", "enabled", "accountIds", "match", "conditions", "groups", "action", "note"}

func rulesFromRecord(record map[string]any) map[string]any {
	definition := map[string]any{}
	for _, field := range rulesDefinitionFields {
		if value, present := record[field]; present && value != nil {
			definition[field] = value
		}
	}
	return definition
}

// rulesBuildFromFlags builds a simple rule from flags. Anything richer (groups, splits, several
// text conditions) is written as JSON and given with --input.
func rulesBuildFromFlags(o Options, base map[string]any) (map[string]any, string) {
	rule := map[string]any{}
	for key, value := range base {
		rule[key] = value
	}
	if value, given := o.Flags["name"]; given {
		rule["name"] = value
	}
	if value, given := o.Flags["note"]; given {
		rule["note"] = value
	}
	if value, given := o.Flags["scope"]; given {
		rule["accountIds"] = rulesSplitList(value)
	}
	if value, given := o.Flags["match"]; given {
		if value != "all" && value != "any" {
			return nil, "--match is all or any"
		}
		rule["match"] = value
	}
	if o.Flags["disabled"] == "true" {
		rule["enabled"] = false
	}
	conditions := []any{}
	field := "description"
	if value, given := o.Flags["field"]; given {
		field = value
	}
	for _, text := range []struct{ flag, operator string }{{"contains", "contains"}, {"equals", "equals"}, {"starts-with", "startsWith"}, {"ends-with", "endsWith"}, {"word", "wholeWord"}} {
		if value, given := o.Flags[text.flag]; given {
			conditions = append(conditions, map[string]any{"field": field, "operator": text.operator, "value": value})
		}
	}
	if value, given := o.Flags["direction"]; given {
		conditions = append(conditions, map[string]any{"field": "direction", "operator": "is", "value": value})
	}
	if value, given := o.Flags["amount"]; given {
		conditions = append(conditions, map[string]any{"field": "amount", "operator": "equals", "value": value})
	}
	lower, hasLower := o.Flags["min"]
	upper, hasUpper := o.Flags["max"]
	if hasLower || hasUpper {
		condition := map[string]any{"field": "amount", "operator": "range"}
		if hasLower {
			condition["min"] = lower
		}
		if hasUpper {
			condition["max"] = upper
		}
		conditions = append(conditions, condition)
	}
	if len(conditions) > 0 {
		rule["conditions"] = conditions
	}
	actions := 0
	if value, given := o.Flags["category"]; given {
		rule["action"] = map[string]any{"kind": "categorize", "accountId": value}
		actions++
	}
	if value, given := o.Flags["transfer"]; given {
		rule["action"] = map[string]any{"kind": "transfer", "accountId": value}
		actions++
	}
	if o.Flags["exclude"] == "true" {
		action := map[string]any{"kind": "exclude"}
		if reason := o.Flags["reason"]; reason != "" && reason != "true" {
			action["reason"] = reason
		}
		rule["action"] = action
		actions++
	}
	if actions > 1 {
		return nil, "give only one of --category, --transfer and --exclude"
	}
	if value, given := o.Flags["narration"]; given {
		action, _ := rule["action"].(map[string]any)
		if action == nil {
			return nil, "--narration needs --category or --transfer"
		}
		withNarration := map[string]any{}
		for key, current := range action {
			withNarration[key] = current
		}
		withNarration["narration"] = value
		rule["action"] = withNarration
	}
	return rule, ""
}

var rulesBuildFlags = []string{"name", "note", "scope", "match", "disabled", "field", "contains", "equals", "starts-with", "ends-with", "word", "direction", "amount", "min", "max", "category", "transfer", "exclude", "reason", "narration"}
var rulesBuildValued = []string{"name", "note", "scope", "match", "field", "contains", "equals", "starts-with", "ends-with", "word", "direction", "amount", "min", "max", "category", "transfer", "reason", "narration"}

func runRulesList(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules list [--usage] [--days N] [--deleted]; --usage measures each rule over the Inbox and the last N days (90 by default)"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "rules list takes options only", usage)
	}
	if problem := rulesFlagProblem(o, []string{"usage", "days", "deleted"}, []string{"days"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if o.Flags["usage"] == "true" {
		input["usage"] = true
	}
	if value := o.Flags["days"]; value != "" {
		days, err := strconv.Atoi(value)
		if err != nil || days < 1 || days > 365 {
			return r.localError(o, "usage_error", "--days must be a whole number from 1 to 365", 2)
		}
		input["days"] = days
	}
	if o.Flags["deleted"] == "true" {
		input["status"] = "deleted"
	}
	return rulesCall(r, ctx, o, c, "rules.list", input)
}

func rulesID(r Runner, o Options, usage string) (string, int, bool) {
	if len(o.Args) != 3 {
		return "", rulesUsage(r, o, "give one rule id", usage), false
	}
	return o.Args[2], 0, true
}

func runRulesShow(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules show RULE_ID"
	id, exit, ok := rulesID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := rulesFlagProblem(o, nil, nil); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	return rulesCall(r, ctx, o, c, "rules.get", map[string]any{"ruleId": id})
}

// rulesItemLine reads one Inbox item and returns what rules.suggest needs: the memo, the
// counterparty, the signed amount, the account the line is on and, when the item has been decided,
// the category chosen.
func rulesItemLine(ctx context.Context, c *api.Client, itemID string) (map[string]any, error) {
	detail, err := rulesRead(ctx, c, "inbox.get", map[string]any{"itemId": itemID})
	if err != nil {
		return nil, err
	}
	item, _ := detail["item"].(map[string]any)
	line, _ := item["line"].(map[string]any)
	if item == nil || line == nil {
		return nil, fmt.Errorf("that item could not be read")
	}
	if line["kind"] != "bankLine" {
		return nil, fmt.Errorf("only a bank line can be generalised into a rule")
	}
	input := map[string]any{"description": line["description"], "amount": line["amount"]}
	if counterparty, ok := line["counterparty"].(string); ok && counterparty != "" {
		input["counterparty"] = counterparty
	}
	bank, _ := item["ledgerAccountId"].(string)
	if bank != "" {
		input["accountId"] = bank
	}
	if decision, ok := item["decision"].(map[string]any); ok {
		if legs, ok := decision["legs"].([]any); ok {
			best, size := "", 0.0
			for _, raw := range legs {
				leg, _ := raw.(map[string]any)
				account, _ := leg["accountId"].(string)
				if account == "" || account == bank {
					continue
				}
				amount, _ := strconv.ParseFloat(strings.TrimPrefix(fmt.Sprint(leg["amount"]), "-"), 64)
				if best == "" || amount > size {
					best, size = account, amount
				}
			}
			if best != "" {
				input["categoryAccountId"] = best
			}
		}
	}
	return input, nil
}

func runRulesSuggest(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules suggest (--item ITEM_ID | --description TEXT --amount AMOUNT [--counterparty TEXT]) [--category ACCOUNT_ID]; the amount is signed, negative is money out"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "rules suggest takes options only", usage)
	}
	if problem := rulesFlagProblem(o, []string{"item", "description", "amount", "counterparty", "category", "account"}, []string{"item", "description", "amount", "counterparty", "category", "account"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	input := map[string]any{}
	if item := o.Flags["item"]; item != "" {
		line, err := rulesItemLine(ctx, c, item)
		if err != nil {
			return r.result(o, api.Response{}, err, "")
		}
		input = line
	} else {
		if o.Flags["description"] == "" || o.Flags["amount"] == "" {
			return rulesUsage(r, o, "give --item, or --description and --amount", usage)
		}
		input["description"] = o.Flags["description"]
		input["amount"] = o.Flags["amount"]
		if value := o.Flags["counterparty"]; value != "" {
			input["counterparty"] = value
		}
		if value := o.Flags["account"]; value != "" {
			input["accountId"] = value
		}
	}
	if value := o.Flags["category"]; value != "" {
		input["categoryAccountId"] = value
	}
	return rulesCall(r, ctx, o, c, "rules.suggest", input)
}

func runRulesTest(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules test (RULE_ID | --input RULE.json) [--days N] [--samples N] [--position N] [--as-of DATE] [--try-description TEXT --try-amount AMOUNT [--try-counterparty TEXT] [--try-reference TEXT] [--try-account ID] [--try-provider KIND]]; with both a rule id and a file, the file replaces the stored definition for the test; --try-* checks one line you type"
	tryFlags := []string{"try-description", "try-amount", "try-counterparty", "try-reference", "try-account", "try-provider"}
	valued := append([]string{"days", "samples", "position"}, tryFlags...)
	if problem := rulesFlagProblem(o, valued, valued); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	if len(o.Args) > 3 {
		return rulesUsage(r, o, "give at most one rule id", usage)
	}
	input := map[string]any{}
	if len(o.Args) == 3 {
		input["ruleId"] = o.Args[2]
	}
	if o.Input != "" {
		object, err := rulesReadObject(r, o)
		if err != nil {
			return r.localError(o, "input_unavailable", err.Error(), 2)
		}
		rule, found := rulesDefinition(object)
		if !found {
			return r.localError(o, "invalid_input", "The input has no rule: expected a rule object or {\"rule\": ...}", 2)
		}
		input["rule"] = rule
	}
	if len(input) == 0 {
		return rulesUsage(r, o, "give a rule id or --input", usage)
	}
	for flag, key := range map[string]string{"days": "days", "samples": "samples", "position": "position"} {
		if value := o.Flags[flag]; value != "" {
			number, err := strconv.Atoi(value)
			if err != nil || number < 0 {
				return r.localError(o, "usage_error", "--"+flag+" must be a whole number", 2)
			}
			input[key] = number
		}
	}
	if o.AsOf != "" {
		input["asOf"] = o.AsOf
	}
	anyTry := false
	for _, flag := range tryFlags {
		if _, given := o.Flags[flag]; given {
			anyTry = true
		}
	}
	if anyTry {
		if o.Flags["try-description"] == "" || o.Flags["try-amount"] == "" {
			return rulesUsage(r, o, "--try-description and --try-amount go together", usage)
		}
		typed := map[string]any{"description": o.Flags["try-description"], "amount": o.Flags["try-amount"]}
		for flag, key := range map[string]string{"try-counterparty": "counterparty", "try-reference": "reference", "try-account": "accountId", "try-provider": "provider"} {
			if value := o.Flags[flag]; value != "" {
				typed[key] = value
			}
		}
		input["lines"] = []any{typed}
	}
	return rulesCall(r, ctx, o, c, "rules.test", input)
}

func runRulesCreate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules create (--input RULE.json|- | --name N (--contains TEXT | --equals TEXT | --starts-with TEXT | --ends-with TEXT | --word TEXT) --category ACCOUNT_ID) [--field description|counterparty|reference] [--direction in|out] [--amount A] [--min A] [--max A] [--scope ID,ID] [--narration TEMPLATE] [--transfer ACCOUNT_ID | --exclude --reason TEXT] [--match any] [--disabled] [--note TEXT] [--position N] [--agent NAME]"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "rules create takes options only", usage)
	}
	if problem := rulesFlagProblem(o, append([]string{"position", "agent"}, rulesBuildFlags...), append([]string{"position", "agent"}, rulesBuildValued...)); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	base := map[string]any{}
	if o.Input != "" {
		object, err := rulesReadObject(r, o)
		if err != nil {
			return r.localError(o, "input_unavailable", err.Error(), 2)
		}
		rule, found := rulesDefinition(object)
		if !found {
			return r.localError(o, "invalid_input", "The input has no rule: expected a rule object, {\"rule\": ...} or the output of rules suggest", 2)
		}
		base = rule
	}
	rule, problem := rulesBuildFromFlags(o, base)
	if problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	if len(rule) == 0 {
		return rulesUsage(r, o, "describe the rule with --input or flags", usage)
	}
	input := rulesAuthored(o, map[string]any{"rule": rule})
	if value := o.Flags["position"]; value != "" {
		position, err := strconv.Atoi(value)
		if err != nil || position < 1 {
			return r.localError(o, "usage_error", "--position must be a whole number from 1", 2)
		}
		input["position"] = position
	}
	return rulesCall(r, ctx, o, c, "rules.create", input)
}

// rulesRevision is the revision a change is based on: --version, or the rule's current one, read now
// and announced so an agent can see which revision it acted on.
func rulesRevision(r Runner, ctx context.Context, o Options, c *api.Client, id string) (map[string]any, int, int, bool) {
	detail, err := rulesRead(ctx, c, "rules.get", map[string]any{"ruleId": id})
	if err != nil {
		return nil, 0, r.result(o, api.Response{}, err, ""), false
	}
	record, _ := detail["rule"].(map[string]any)
	current, _ := record["revision"].(float64)
	if record["status"] == "deleted" {
		return nil, 0, r.localError(o, "rule_deleted", "That rule has been deleted; create a new rule instead", 3), false
	}
	if value, given := o.Flags["version"]; given {
		version, err := strconv.Atoi(value)
		if err != nil || version < 1 {
			return nil, 0, r.localError(o, "usage_error", "--version must be a whole number from 1", 2), false
		}
		return record, version, 0, true
	}
	fmt.Fprintf(r.Diagnostics, "Using the rule's current revision %d; give --version N to name the revision you reviewed.\n", int(current))
	return record, int(current), 0, true
}

func runRulesUpdate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules update RULE_ID (--input RULE.json|- | flags as for create) [--version N] [--agent NAME]; the new definition replaces the old one, so flags change only what they name"
	id, exit, ok := rulesID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := rulesFlagProblem(o, append([]string{"version", "agent"}, rulesBuildFlags...), append([]string{"version", "agent"}, rulesBuildValued...)); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	record, version, exit, ok := rulesRevision(r, ctx, o, c, id)
	if !ok {
		return exit
	}
	base := rulesFromRecord(record)
	if o.Input != "" {
		object, err := rulesReadObject(r, o)
		if err != nil {
			return r.localError(o, "input_unavailable", err.Error(), 2)
		}
		rule, found := rulesDefinition(object)
		if !found {
			return r.localError(o, "invalid_input", "The input has no rule: expected a rule object or {\"rule\": ...}", 2)
		}
		base = rule
	}
	rule, problem := rulesBuildFromFlags(o, base)
	if problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	return rulesCall(r, ctx, o, c, "rules.update", rulesAuthored(o, map[string]any{"ruleId": id, "expectedRevision": version, "rule": rule}))
}

func rulesSwitch(r Runner, ctx context.Context, o Options, c *api.Client, enabled bool) int {
	verb := "enable"
	if !enabled {
		verb = "disable"
	}
	usage := "rules " + verb + " RULE_ID [--version N] [--agent NAME]"
	id, exit, ok := rulesID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := rulesFlagProblem(o, []string{"version", "agent"}, []string{"version", "agent"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	record, version, exit, ok := rulesRevision(r, ctx, o, c, id)
	if !ok {
		return exit
	}
	rule := rulesFromRecord(record)
	rule["enabled"] = enabled
	return rulesCall(r, ctx, o, c, "rules.update", rulesAuthored(o, map[string]any{"ruleId": id, "expectedRevision": version, "rule": rule}))
}

func runRulesEnable(r Runner, ctx context.Context, o Options, c *api.Client) int {
	return rulesSwitch(r, ctx, o, c, true)
}

func runRulesDisable(r Runner, ctx context.Context, o Options, c *api.Client) int {
	return rulesSwitch(r, ctx, o, c, false)
}

func runRulesDelete(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules delete RULE_ID --reason TEXT [--version N] [--agent NAME]; a deleted rule stays in the history and cannot be restored (prefer rules disable when you may want it back)"
	id, exit, ok := rulesID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := rulesFlagProblem(o, []string{"reason", "version", "agent"}, []string{"reason", "version", "agent"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	if strings.TrimSpace(o.Flags["reason"]) == "" {
		return rulesUsage(r, o, "--reason is required: say why the rule is being retired", usage)
	}
	_, version, exit, ok := rulesRevision(r, ctx, o, c, id)
	if !ok {
		return exit
	}
	return rulesCall(r, ctx, o, c, "rules.delete", rulesAuthored(o, map[string]any{"ruleId": id, "expectedRevision": version, "reason": o.Flags["reason"]}))
}

// rulesOrder reads the active rules' ids in priority order and the revision to reorder against.
func rulesOrder(ctx context.Context, c *api.Client) ([]string, float64, error) {
	list, err := rulesRead(ctx, c, "rules.list", map[string]any{})
	if err != nil {
		return nil, 0, err
	}
	ids := []string{}
	rules, _ := list["rules"].([]any)
	for _, raw := range rules {
		record, _ := raw.(map[string]any)
		if id, ok := record["id"].(string); ok {
			ids = append(ids, id)
		}
	}
	revision, _ := list["rulesRevision"].(float64)
	return ids, revision, nil
}

func runRulesMove(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules move RULE_ID --to POSITION [--agent NAME]; position 1 is decided first"
	id, exit, ok := rulesID(r, o, usage)
	if !ok {
		return exit
	}
	if problem := rulesFlagProblem(o, []string{"to", "agent"}, []string{"to", "agent"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	target, err := strconv.Atoi(o.Flags["to"])
	if err != nil || target < 1 {
		return rulesUsage(r, o, "--to must be a whole number from 1", usage)
	}
	ids, revision, err := rulesOrder(ctx, c)
	if err != nil {
		return r.result(o, api.Response{}, err, "")
	}
	from := -1
	for index, candidate := range ids {
		if candidate == id {
			from = index
		}
	}
	if from < 0 {
		return r.localError(o, "rule_not_found", "No active rule has that id", 3)
	}
	if target > len(ids) {
		target = len(ids)
	}
	moved := append([]string{}, ids[:from]...)
	moved = append(moved, ids[from+1:]...)
	ordered := append([]string{}, moved[:target-1]...)
	ordered = append(ordered, id)
	ordered = append(ordered, moved[target-1:]...)
	return rulesCall(r, ctx, o, c, "rules.reorder", rulesAuthored(o, map[string]any{"expectedRulesRevision": int(revision), "orderedRuleIds": ordered}))
}

func runRulesReorder(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "rules reorder RULE_ID... [--agent NAME]; list every active rule once, highest priority first"
	if len(o.Args) < 3 {
		return rulesUsage(r, o, "give every active rule id", usage)
	}
	if problem := rulesFlagProblem(o, []string{"agent"}, []string{"agent"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	_, revision, err := rulesOrder(ctx, c)
	if err != nil {
		return r.result(o, api.Response{}, err, "")
	}
	return rulesCall(r, ctx, o, c, "rules.reorder", rulesAuthored(o, map[string]any{"expectedRulesRevision": int(revision), "orderedRuleIds": o.Args[2:]}))
}

func runClassifierStatus(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "classifier status"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "classifier status takes no arguments", usage)
	}
	if problem := rulesFlagProblem(o, nil, nil); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	return rulesCall(r, ctx, o, c, "classifier.status", map[string]any{})
}

func runClassifierTrain(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "classifier train"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "classifier train takes no arguments", usage)
	}
	if problem := rulesFlagProblem(o, nil, nil); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	return rulesCall(r, ctx, o, c, "classifier.train", map[string]any{})
}

var classifierThresholds = []struct{ flag, key string }{{"min-agreement", "minAgreement"}, {"min-margin", "minMargin"}, {"min-examples", "minExamples"}, {"min-known-words", "minKnownWords"}}

// classifierConfig builds the thresholds named by flags; each is a whole number.
func classifierConfig(o Options) (map[string]any, string) {
	config := map[string]any{}
	for _, threshold := range classifierThresholds {
		value, given := o.Flags[threshold.flag]
		if !given {
			continue
		}
		number, err := strconv.Atoi(value)
		if err != nil {
			return nil, "--" + threshold.flag + " must be a whole number"
		}
		config[threshold.key] = number
	}
	if value, given := o.Flags["enabled"]; given {
		switch value {
		case "true":
			config["enabled"] = true
		case "false":
			config["enabled"] = false
		default:
			return nil, "--enabled is true or false"
		}
	}
	return config, ""
}

func runClassifierEvaluate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "classifier evaluate [--min-agreement N] [--min-margin N] [--min-examples N] [--min-known-words N]; with none it measures the stored thresholds"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "classifier evaluate takes options only", usage)
	}
	if problem := rulesFlagProblem(o, []string{"min-agreement", "min-margin", "min-examples", "min-known-words"}, []string{"min-agreement", "min-margin", "min-examples", "min-known-words"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	config, problem := classifierConfig(o)
	if problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	return rulesCall(r, ctx, o, c, "classifier.evaluate", map[string]any{"config": config})
}

func runClassifierConfigure(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "classifier configure [--enabled true|false] [--min-agreement N] [--min-margin N] [--min-examples N] [--min-known-words N]; only the options given change"
	if len(o.Args) != 2 {
		return rulesUsage(r, o, "classifier configure takes options only", usage)
	}
	if problem := rulesFlagProblem(o, []string{"enabled", "min-agreement", "min-margin", "min-examples", "min-known-words"}, []string{"enabled", "min-agreement", "min-margin", "min-examples", "min-known-words"}); problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	config, problem := classifierConfig(o)
	if problem != "" {
		return rulesUsage(r, o, problem, usage)
	}
	if len(config) == 0 {
		return rulesUsage(r, o, "say what to change", usage)
	}
	return rulesCall(r, ctx, o, c, "classifier.configure", config)
}

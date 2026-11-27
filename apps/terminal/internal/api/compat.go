package api

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Compatibility between two versions of the operation contract: what a frozen contract promised and
// what a build or a running service offers. This is a port of packages/application/src/contract-compat.ts;
// both are held to the same vectors (packages/application/test/fixtures/contract-compat-vectors.json).
//
//   - A request the frozen contract accepted must still be accepted: nothing becomes required, no
//     field or choice is removed, no limit gets tighter, no format changes.
//   - A reply must stay readable by a client written against the frozen contract: every field it
//     named is still there with the same type, no field it required goes optional, no limit gets
//     looser and no new choice appears in a set of choices. New optional fields are additions.
//   - An operation is never removed or renamed, and its permission and whether it writes never change.

// FrozenOperation is what the contract promises about one operation.
type FrozenOperation struct {
	Permission string `json:"permission"`
	Writes     bool   `json:"writes"`
	Input      Schema `json:"input"`
	Output     Schema `json:"output"`
}

// ContractView is the part of a contract that compatibility is judged on.
type ContractView struct {
	Contract            string                     `json:"contract"`
	PreparedPermissions map[string]string          `json:"preparedPermissions"`
	Definitions         map[string]Schema          `json:"definitions"`
	Operations          map[string]FrozenOperation `json:"operations"`
}

// Golden is the frozen contract: a view plus its labels.
type Golden struct {
	ContractView
	FrozenOn string `json:"frozenOn"`
	Note     string `json:"note"`
}

// Finding is one thing the new contract no longer honours.
type Finding struct {
	Operation string `json:"operation"`
	Path      string `json:"path"`
	Message   string `json:"message"`
}

// Comparison is the result of comparing a frozen contract with a current one.
type Comparison struct {
	Breaking []Finding `json:"breaking"`
	Added    []string  `json:"added"`
	Extended []string  `json:"extended"`
}

// ViewOf is the view of a catalog (the contract the CLI was built with or a service reports),
// limited to the named operations when `only` is not nil.
func ViewOf(c Contract, only map[string]bool) ContractView {
	view := ContractView{
		Contract:            c.Version,
		PreparedPermissions: c.PreparedPermissions,
		Definitions:         c.Definitions,
		Operations:          map[string]FrozenOperation{},
	}
	for _, operation := range c.Operations {
		if only != nil && !only[operation.Name] {
			continue
		}
		view.Operations[operation.Name] = FrozenOperation{Permission: operation.Permission, Writes: operation.Writes, Input: operation.Input, Output: operation.Output}
	}
	return view
}

type compatContext struct {
	aDefinitions, bDefinitions map[string]Schema
	// extras is what to do with a property one side names and the other does not: a request's
	// receiver refuses it ("forbid"); a reply's reader ignores it ("ignore").
	extras    string
	request   bool
	operation string
	findings  *[]Finding
	seen      map[string]bool
}

func (c compatContext) side(request, reply string) string {
	if c.request {
		return request
	}
	return reply
}

func (c compatContext) fail(path, message string) {
	*c.findings = append(*c.findings, Finding{Operation: c.operation, Path: path, Message: message})
}

func dereference(schema Schema, definitions map[string]Schema) (Schema, error) {
	current := schema
	for hops := 0; current.Ref != ""; hops++ {
		if hops > 32 {
			return Schema{}, fmt.Errorf("schema reference chain is too long")
		}
		target, exists := definitions[strings.TrimPrefix(current.Ref, "#/$defs/")]
		if !exists {
			return Schema{}, fmt.Errorf("unknown schema reference %s", current.Ref)
		}
		current = target
	}
	return current, nil
}

func unconstrained(s Schema) bool {
	return s.Type == "" && len(s.AnyOf) == 0 && len(s.Enum) == 0 && len(s.Properties) == 0 && s.Items == nil
}

func enumContains(values []any, wanted any) bool {
	encoded, _ := json.Marshal(wanted)
	for _, value := range values {
		candidate, _ := json.Marshal(value)
		if string(candidate) == string(encoded) {
			return true
		}
	}
	return false
}

// subset records, in c.findings, every way a value that satisfies a can fail to satisfy b.
func (c compatContext) subset(a, b Schema, path string) {
	if a.Ref != "" && b.Ref != "" {
		pair := a.Ref + "|" + b.Ref
		if c.seen[pair] {
			return
		}
		c.seen[pair] = true
	}
	left, err := dereference(a, c.aDefinitions)
	if err != nil {
		c.fail(path, err.Error())
		return
	}
	right, err := dereference(b, c.bDefinitions)
	if err != nil {
		c.fail(path, err.Error())
		return
	}
	if unconstrained(right) {
		return
	}
	if unconstrained(left) {
		c.fail(path, c.side("now limits what it accepts here", "may now return anything here, where it named a shape"))
		return
	}
	if len(left.AnyOf) > 0 {
		for _, variant := range left.AnyOf {
			if len(right.AnyOf) > 0 {
				fits := false
				for _, option := range right.AnyOf {
					if c.holds(variant, option, path) {
						fits = true
						break
					}
				}
				if !fits {
					c.fail(path, c.side("a shape it accepted is no longer accepted", "it can return a shape it did not name"))
				}
			} else {
				c.subset(variant, right, path)
			}
		}
		return
	}
	if len(right.AnyOf) > 0 {
		for _, option := range right.AnyOf {
			if c.holds(left, option, path) {
				return
			}
		}
		c.fail(path, c.side("what it accepted no longer matches any accepted shape", "it can return a shape it did not name"))
		return
	}
	if left.Type != right.Type {
		c.fail(path, fmt.Sprintf("the type changed from %s to %s", orAny(right.Type), orAny(left.Type)))
		return
	}
	if len(right.Enum) > 0 {
		if len(left.Enum) == 0 {
			c.fail(path, c.side("now accepts only a fixed set of values", "can now return values outside the set it named"))
		} else {
			for _, value := range left.Enum {
				if !enumContains(right.Enum, value) {
					encoded, _ := json.Marshal(value)
					c.fail(path, c.side("no longer accepts "+string(encoded), "can now return "+string(encoded)+", which it did not name"))
				}
			}
		}
	}
	switch left.Type {
	case "object":
		c.subsetObject(left, right, path)
	case "array":
		if right.Items != nil {
			if left.Items != nil {
				c.subset(*left.Items, *right.Items, path+"[]")
			} else {
				c.fail(path, "the items are no longer described")
			}
		}
		if intOr(right.MinItems, 0) > intOr(left.MinItems, 0) {
			c.fail(path, c.side("now needs more items", "can now return fewer items"))
		}
		if right.MaxItems != nil && (left.MaxItems == nil || *left.MaxItems > *right.MaxItems) {
			c.fail(path, c.side("now accepts fewer items", "can now return more items"))
		}
	case "string":
		if intOr(right.MinLength, 0) > intOr(left.MinLength, 0) {
			c.fail(path, c.side("now needs a longer text", "can now return a shorter text"))
		}
		if right.MaxLength != nil && (left.MaxLength == nil || *left.MaxLength > *right.MaxLength) {
			c.fail(path, c.side("now accepts a shorter text", "can now return a longer text"))
		}
		if right.Pattern != "" && left.Pattern != right.Pattern {
			c.fail(path, "the required format changed")
		}
	case "integer":
		if right.Minimum != nil && (left.Minimum == nil || *right.Minimum > *left.Minimum) {
			c.fail(path, c.side("now accepts a smaller range", "can now return smaller numbers"))
		}
		if right.Maximum != nil && (left.Maximum == nil || *right.Maximum < *left.Maximum) {
			c.fail(path, c.side("now accepts a smaller range", "can now return larger numbers"))
		}
	}
}

func orAny(kind string) string {
	if kind == "" {
		return "any"
	}
	return kind
}

func intOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

// holds reports whether a fits in b without recording what differs.
func (c compatContext) holds(a, b Schema, path string) bool {
	var scratch []Finding
	trial := c
	trial.findings = &scratch
	trial.seen = map[string]bool{}
	for key := range c.seen {
		trial.seen[key] = true
	}
	trial.subset(a, b, path)
	return len(scratch) == 0
}

func (c compatContext) subsetObject(a, b Schema, path string) {
	aRequired := map[string]bool{}
	for _, name := range a.Required {
		aRequired[name] = true
	}
	for _, name := range b.Required {
		if !aRequired[name] {
			c.fail(path+"."+name, c.side("is now required", "may now be missing"))
		}
	}
	names := make([]string, 0, len(a.Properties))
	for name := range a.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if other, exists := b.Properties[name]; exists {
			c.subset(a.Properties[name], other, path+"."+name)
		} else if c.extras == "forbid" {
			c.fail(path+"."+name, "is no longer accepted")
		}
	}
	if c.extras == "ignore" {
		missing := []string{}
		for name := range b.Properties {
			if _, exists := a.Properties[name]; !exists {
				missing = append(missing, name)
			}
		}
		sort.Strings(missing)
		for _, name := range missing {
			c.fail(path+"."+name, "is no longer returned")
		}
	}
	if c.extras == "forbid" && a.AdditionalProperties && !b.AdditionalProperties {
		c.fail(path, "no longer accepts additional fields")
	}
}

func operationFindings(name string, old, current FrozenOperation, oldDefinitions, newDefinitions map[string]Schema) []Finding {
	findings := []Finding{}
	if old.Permission != current.Permission {
		findings = append(findings, Finding{Operation: name, Path: "permission", Message: fmt.Sprintf("changed from %s to %s", old.Permission, current.Permission)})
	}
	if old.Writes != current.Writes {
		message := "now writes"
		if old.Writes {
			message = "no longer writes"
		}
		findings = append(findings, Finding{Operation: name, Path: "writes", Message: message})
	}
	request := compatContext{aDefinitions: oldDefinitions, bDefinitions: newDefinitions, extras: "forbid", request: true, operation: name, findings: &findings, seen: map[string]bool{}}
	request.subset(old.Input, current.Input, "input")
	reply := compatContext{aDefinitions: newDefinitions, bDefinitions: oldDefinitions, extras: "ignore", request: false, operation: name, findings: &findings, seen: map[string]bool{}}
	reply.subset(current.Output, old.Output, "output")
	return findings
}

// inlined renders a schema with every reference followed, keys sorted, so two schemas that mean
// the same thing give the same text.
func inlined(schema Schema, definitions map[string]Schema, depth int) string {
	if depth > 40 {
		return "<too deep>"
	}
	resolved, err := dereference(schema, definitions)
	if err != nil {
		return "<" + err.Error() + ">"
	}
	parts := []string{"type=" + resolved.Type}
	if len(resolved.Enum) > 0 {
		encoded, _ := json.Marshal(resolved.Enum)
		parts = append(parts, "enum="+string(encoded))
	}
	if resolved.Pattern != "" {
		parts = append(parts, "pattern="+resolved.Pattern)
	}
	for _, bound := range []struct {
		label string
		value *int
	}{{"minLength", resolved.MinLength}, {"maxLength", resolved.MaxLength}, {"minimum", resolved.Minimum}, {"maximum", resolved.Maximum}, {"minItems", resolved.MinItems}, {"maxItems", resolved.MaxItems}} {
		if bound.value != nil {
			parts = append(parts, fmt.Sprintf("%s=%d", bound.label, *bound.value))
		}
	}
	required := append([]string(nil), resolved.Required...)
	sort.Strings(required)
	parts = append(parts, "required="+strings.Join(required, ","), fmt.Sprintf("additional=%t", resolved.AdditionalProperties))
	names := make([]string, 0, len(resolved.Properties))
	for name := range resolved.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		parts = append(parts, name+":("+inlined(resolved.Properties[name], definitions, depth+1)+")")
	}
	if resolved.Items != nil {
		parts = append(parts, "items:("+inlined(*resolved.Items, definitions, depth+1)+")")
	}
	variants := make([]string, 0, len(resolved.AnyOf))
	for _, variant := range resolved.AnyOf {
		variants = append(variants, inlined(variant, definitions, depth+1))
	}
	sort.Strings(variants)
	parts = append(parts, "anyOf:("+strings.Join(variants, "|")+")")
	return strings.Join(parts, ";")
}

// Compare says what the current contract no longer honours of the frozen one.
func Compare(old, current ContractView) Comparison {
	result := Comparison{Breaking: []Finding{}, Added: []string{}, Extended: []string{}}
	if old.Contract != current.Contract {
		result.Breaking = append(result.Breaking, Finding{Operation: "(contract)", Path: "version", Message: fmt.Sprintf("the contract is %s, the frozen one is %s", current.Contract, old.Contract)})
	}
	names := make([]string, 0, len(old.Operations))
	for name := range old.Operations {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		frozen := old.Operations[name]
		now, exists := current.Operations[name]
		if !exists {
			result.Breaking = append(result.Breaking, Finding{Operation: name, Path: "", Message: "was removed or renamed"})
			continue
		}
		findings := operationFindings(name, frozen, now, old.Definitions, current.Definitions)
		result.Breaking = append(result.Breaking, findings...)
		if len(findings) == 0 && (inlined(frozen.Input, old.Definitions, 0) != inlined(now.Input, current.Definitions, 0) || inlined(frozen.Output, old.Definitions, 0) != inlined(now.Output, current.Definitions, 0)) {
			result.Extended = append(result.Extended, name)
		}
	}
	kinds := make([]string, 0, len(old.PreparedPermissions))
	for kind := range old.PreparedPermissions {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		permission := old.PreparedPermissions[kind]
		now, exists := current.PreparedPermissions[kind]
		if !exists {
			result.Breaking = append(result.Breaking, Finding{Operation: "(commit)", Path: kind, Message: "this kind of plan was removed"})
		} else if now != permission {
			result.Breaking = append(result.Breaking, Finding{Operation: "(commit)", Path: kind, Message: fmt.Sprintf("committing it needed %s and now needs %s", permission, now)})
		}
	}
	for name := range current.Operations {
		if _, frozen := old.Operations[name]; !frozen {
			result.Added = append(result.Added, name)
		}
	}
	sort.Strings(result.Added)
	sort.Strings(result.Extended)
	return result
}

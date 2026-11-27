package api

import (
	_ "embed"
	"encoding/json"
	"sort"
)

// GoldenJSON is the frozen operation contract this build was made against. The service's tests
// and the landing gate keep it honoured; docs/reference/contract-policy.md says what that means.
//
//go:embed contract-v1.golden.json
var GoldenJSON []byte

var golden = func() Golden {
	var g Golden
	if err := json.Unmarshal(GoldenJSON, &g); err != nil {
		panic(err)
	}
	if g.Contract != Version {
		panic("golden contract version mismatch")
	}
	return g
}()

// FrozenContract returns the frozen contract.
func FrozenContract() Golden { return golden }

// Stability says whether an operation is part of the frozen contract ("stable") or may still
// change in a release ("preview").
func Stability(name string) string {
	if _, frozen := golden.Operations[name]; frozen {
		return "stable"
	}
	return "preview"
}

// FrozenNames lists the frozen operations, sorted.
func FrozenNames() []string {
	names := make([]string, 0, len(golden.Operations))
	for name := range golden.Operations {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// FrozenSet is the frozen operation names as a set.
func FrozenSet() map[string]bool {
	set := map[string]bool{}
	for name := range golden.Operations {
		set[name] = true
	}
	return set
}

// BuiltInContract is the contract this build was generated from.
func BuiltInContract() Contract { return contract }

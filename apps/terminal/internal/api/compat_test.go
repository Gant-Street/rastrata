package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type compatVector struct {
	Name        string `json:"name"`
	Direction   string `json:"direction"`
	Old         Schema `json:"old"`
	New         Schema `json:"new"`
	Expect      string `json:"expect"`
	Path        string `json:"path"`
	Definitions *struct {
		Old map[string]Schema `json:"old"`
		New map[string]Schema `json:"new"`
	} `json:"definitions"`
}

func probeView(vector compatVector, old bool) ContractView {
	empty := Schema{Type: "object", Properties: map[string]Schema{}, Required: []string{}}
	schema, definitions := vector.New, map[string]Schema{}
	if old {
		schema = vector.Old
	}
	if vector.Definitions != nil {
		definitions = vector.Definitions.New
		if old {
			definitions = vector.Definitions.Old
		}
	}
	operation := FrozenOperation{Permission: "read", Input: empty, Output: empty}
	if vector.Direction == "input" {
		operation.Input = schema
	} else {
		operation.Output = schema
	}
	return ContractView{Contract: "probe", PreparedPermissions: map[string]string{}, Definitions: definitions, Operations: map[string]FrozenOperation{"probe": operation}}
}

// The same vectors the service's tests use: the two implementations of the compatibility rules
// must judge every case alike.
func TestSharedVectorsAreJudgedLikeTheServiceJudgesThem(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "application", "test", "fixtures", "contract-compat-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []compatVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 50 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, vector := range vectors {
		result := Compare(probeView(vector, true), probeView(vector, false))
		if vector.Expect == "compatible" {
			if len(result.Breaking) != 0 {
				t.Errorf("%s: judged breaking: %+v", vector.Name, result.Breaking)
			}
			continue
		}
		if len(result.Breaking) == 0 {
			t.Errorf("%s: judged compatible", vector.Name)
			continue
		}
		if vector.Path != "" {
			found := false
			for _, finding := range result.Breaking {
				if finding.Path == vector.Path {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: no finding at %s: %+v", vector.Name, vector.Path, result.Breaking)
			}
		}
	}
}

func TestThisBuildHonoursTheFrozenContractItWasMadeAgainst(t *testing.T) {
	frozen := FrozenContract()
	result := Compare(frozen.ContractView, ViewOf(BuiltInContract(), FrozenSet()))
	if len(result.Breaking) != 0 {
		t.Fatalf("the built-in catalog breaks the frozen contract: %+v", result.Breaking)
	}
	for _, name := range []string{"book.get", "drafts.create", "journal.prepare", "operations.commit", "tokens.create"} {
		if Stability(name) != "stable" {
			t.Errorf("%s should be stable", name)
		}
	}
	if Stability("definitely.not.an.operation") != "preview" {
		t.Error("an operation that is not frozen is a preview")
	}
	if len(FrozenNames()) != len(frozen.Operations) {
		t.Error("frozen names disagree with the snapshot")
	}
}

func TestEveryBreakingKindOfChangeToTheRealContractIsCaught(t *testing.T) {
	built := BuiltInContract()
	frozen := FrozenContract()
	mutate := func(edit func(*Contract)) Comparison {
		var copy Contract
		raw, _ := json.Marshal(built)
		_ = json.Unmarshal(raw, &copy)
		edit(&copy)
		return Compare(frozen.ContractView, ViewOf(copy, FrozenSet()))
	}
	removed := mutate(func(c *Contract) {
		kept := c.Operations[:0]
		for _, operation := range c.Operations {
			if operation.Name != "drafts.create" {
				kept = append(kept, operation)
			}
		}
		c.Operations = kept
	})
	if len(removed.Breaking) != 1 || !strings.Contains(removed.Breaking[0].Message, "removed") {
		t.Errorf("removal: %+v", removed.Breaking)
	}
	permission := mutate(func(c *Contract) {
		for i := range c.Operations {
			if c.Operations[i].Name == "journal.prepare" {
				c.Operations[i].Permission = "draft"
			}
		}
	})
	if len(permission.Breaking) != 1 || permission.Breaking[0].Path != "permission" {
		t.Errorf("permission: %+v", permission.Breaking)
	}
	kind := mutate(func(c *Contract) { c.PreparedPermissions["postDraft"] = "draft" })
	if len(kind.Breaking) != 1 || kind.Breaking[0].Operation != "(commit)" {
		t.Errorf("plan kind: %+v", kind.Breaking)
	}
	grown := mutate(func(c *Contract) {
		definition := c.Definitions["JournalEntry"]
		properties := map[string]Schema{}
		for name, schema := range definition.Properties {
			properties[name] = schema
		}
		properties["aFieldAddedLater"] = Schema{Type: "string"}
		definition.Properties = properties
		c.Definitions["JournalEntry"] = definition
	})
	if len(grown.Breaking) != 0 {
		t.Errorf("an added optional reply field is not breaking: %+v", grown.Breaking)
	}
}

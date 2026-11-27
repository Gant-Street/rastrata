package api

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"unicode/utf16"
)

//go:embed application-v1.json
var SchemaJSON []byte

type Schema struct {
	Ref                  string            `json:"$ref"`
	Type                 string            `json:"type"`
	AnyOf                []Schema          `json:"anyOf"`
	Enum                 []any             `json:"enum"`
	Properties           map[string]Schema `json:"properties"`
	Required             []string          `json:"required"`
	AdditionalProperties bool              `json:"additionalProperties"`
	Items                *Schema           `json:"items"`
	MinLength            *int              `json:"minLength"`
	MaxLength            *int              `json:"maxLength"`
	Pattern              string            `json:"pattern"`
	Minimum              *int              `json:"minimum"`
	Maximum              *int              `json:"maximum"`
	MinItems             *int              `json:"minItems"`
	MaxItems             *int              `json:"maxItems"`
}
type Operation struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Permission  string `json:"permission"`
	Writes      bool   `json:"writes"`
	Input       Schema `json:"input"`
	Output      Schema `json:"output"`
	// Deprecated is set while an operation is on its way out; see docs/reference/contract-policy.md.
	Deprecated string `json:"deprecated,omitempty"`
}
type Contract struct {
	Version     string            `json:"version"`
	Definitions map[string]Schema `json:"$defs"`
	Operations  []Operation       `json:"operations"`
	// PreparedPermissions is the permission needed to commit each kind of prepared action.
	PreparedPermissions map[string]string `json:"preparedPermissions"`
}

var contract = func() Contract {
	var c Contract
	if err := json.Unmarshal(SchemaJSON, &c); err != nil {
		panic(err)
	}
	if c.Version != Version {
		panic("generated schema version mismatch")
	}
	return c
}()

func Catalog() []Operation { return append([]Operation(nil), contract.Operations...) }
func FindOperation(name string) (Operation, bool) {
	for _, item := range contract.Operations {
		if item.Name == name {
			return item, true
		}
	}
	return Operation{}, false
}

// Validate checks a request: it refuses any field the schema does not name.
func Validate(raw []byte, schema Schema, path string) error {
	return validate(raw, schema, path, false)
}

// ValidateOutput checks a reply the same way but ignores object properties the schema does not
// name. A service one revision newer than this client may add optional fields to a reply (an
// additive change, see docs/reference/contract-policy.md); everything this client does know must
// still match exactly.
func ValidateOutput(raw []byte, schema Schema, path string) error {
	return validate(raw, schema, path, true)
}

func validate(raw []byte, schema Schema, path string, lenient bool) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("%s: invalid JSON", path)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("%s: trailing JSON", path)
	}
	return validateValue(value, schema, path, lenient)
}
func validateValue(value any, schema Schema, path string, lenient bool) error {
	fail := func(message string) error { return &ValidationError{Path: path, Message: message} }
	if len(schema.AnyOf) > 0 {
		for _, variant := range schema.AnyOf {
			if validateValue(value, variant, path, lenient) == nil {
				return nil
			}
		}
		return fail("unsupported value type")
	}
	if schema.Ref != "" {
		definition, exists := contract.Definitions[schema.Ref[len("#/$defs/"):]]
		if !exists {
			return fail("unknown schema reference")
		}
		return validateValue(value, definition, path, lenient)
	}
	switch schema.Type {
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return fail("expected an object")
		}
		for _, key := range schema.Required {
			if _, exists := object[key]; !exists {
				return fail("missing " + key)
			}
		}
		for key, child := range object {
			field, exists := schema.Properties[key]
			if !exists {
				if !schema.AdditionalProperties && !lenient {
					return fail("unknown field " + key)
				}
				continue
			}
			if err := validateValue(child, field, path+"."+key, lenient); err != nil {
				return err
			}
		}
	case "array":
		array, ok := value.([]any)
		if !ok {
			return fail("expected an array")
		}
		if (schema.MinItems != nil && len(array) < *schema.MinItems) || (schema.MaxItems != nil && len(array) > *schema.MaxItems) {
			return fail("array length outside supported range")
		}
		if schema.Items != nil {
			for i, child := range array {
				if err := validateValue(child, *schema.Items, fmt.Sprintf("%s[%d]", path, i), lenient); err != nil {
					return err
				}
			}
		}
	case "string":
		s, ok := value.(string)
		if !ok {
			return fail("expected a string")
		}
		length := len(utf16.Encode([]rune(s)))
		if (schema.MinLength != nil && length < *schema.MinLength) || (schema.MaxLength != nil && length > *schema.MaxLength) {
			return fail("string length outside supported range")
		}
		if schema.Pattern != "" {
			pattern, err := regexp.Compile(schema.Pattern)
			if err != nil {
				return fail("invalid generated pattern")
			}
			if !pattern.MatchString(s) {
				return fail("unsupported value format")
			}
		}
	case "integer":
		n, ok := value.(json.Number)
		if !ok {
			return fail("expected an integer")
		}
		rational, ok := new(big.Rat).SetString(string(n))
		if !ok || !rational.IsInt() || !rational.Num().IsInt64() {
			return fail("expected a safe integer")
		}
		integer := rational.Num().Int64()
		if integer > 9007199254740991 || integer < -9007199254740991 || (schema.Minimum != nil && integer < int64(*schema.Minimum)) || (schema.Maximum != nil && integer > int64(*schema.Maximum)) {
			return fail("integer outside supported range")
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fail("expected a boolean")
		}
	case "null":
		if value != nil {
			return fail("expected null")
		}
	}
	if len(schema.Enum) > 0 {
		matched := false
		for _, allowed := range schema.Enum {
			a, _ := json.Marshal(allowed)
			v, _ := json.Marshal(value)
			if bytes.Equal(a, v) {
				matched = true
				break
			}
		}
		if !matched {
			return fail("unsupported choice")
		}
	}
	return nil
}

type ValidationError struct{ Path, Message string }

func (e *ValidationError) Error() string { return e.Path + ": " + e.Message }

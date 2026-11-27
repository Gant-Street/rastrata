package agentkit

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// member is one key of a JSON object with its value untouched, so a file can be edited without
// reordering or reformatting what the person wrote.
type member struct {
	key   string
	value json.RawMessage
}

// parseObject reads a JSON object into its members in order. Anything else is an error, and so is
// a comment or trailing text: those files are the person's to edit.
func parseObject(raw []byte) ([]member, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("not a JSON object")
	}
	members := []member{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("not a JSON object")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		members = append(members, member{key, value})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("text after the JSON object")
	}
	return members, nil
}

func find(members []member, key string) int {
	for index, item := range members {
		if item.key == key {
			return index
		}
	}
	return -1
}

// renderObject writes members as an indented JSON object, in order.
func renderObject(members []member) (json.RawMessage, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, item := range members {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := json.Marshal(item.key)
		if err != nil {
			return nil, err
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(item.value)
	}
	buffer.WriteByte('}')
	var indented bytes.Buffer
	if err := json.Indent(&indented, buffer.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	return indented.Bytes(), nil
}

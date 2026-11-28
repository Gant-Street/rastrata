package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Record struct {
	Endpoint    string          `json:"endpoint"`
	BookID      string          `json:"bookId"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
	Name        string          `json:"name"`
	OperationID string          `json:"operationId"`
	Body        json.RawMessage `json:"body"`
}
type Journal struct{ Directory string }

func (j *Journal) path(id, name string) (string, error) {
	if j.Directory == "" || !uuid.MatchString(id) {
		return "", errors.New("request directory and UUID are required")
	}
	if _, exists := FindOperation(name); !exists {
		return "", errors.New("unknown operation")
	}
	phase := "request"
	if name == "operations.commit" {
		phase = "commit"
	}
	return filepath.Join(j.Directory, id+"."+phase+".json"), nil
}
func (j *Journal) Retain(record Record) error {
	path, err := j.path(record.OperationID, record.Name)
	if err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(j.Directory, 0700); err != nil {
		return err
	}
	if err := os.Chmod(j.Directory, 0700); err != nil {
		return err
	}
	// A fully written temporary file is atomically claimed without overwriting an
	// existing identity. Concurrent processes either agree on bytes or fail.
	file, err := os.CreateTemp(j.Directory, ".request-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Link(file.Name(), path); err != nil {
		if !errors.Is(err, fs.ErrExist) {
			return err
		}
		existing, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if !bytes.Equal(existing, data) {
			return errors.New("operation identity was reused for different input or scope; use its original request or a new identity")
		}
	}
	return syncDirectory(j.Directory)
}
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
func (j *Journal) SaveResponse(id, name string, raw []byte) error {
	path, err := j.path(id, name)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(j.Directory, ".response-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path+".response"); err != nil {
		return err
	}
	return syncDirectory(j.Directory)
}
func (j *Journal) Load(id string) (Record, error) {
	var record Record
	for _, name := range []string{"operations.commit", "drafts.create"} {
		path, err := j.path(id, name)
		if err != nil {
			return record, err
		}
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return record, err
		}
		if err := json.Unmarshal(data, &record); err != nil {
			return record, errors.New("retained request is invalid; no request was sent")
		}
		if record.OperationID != id {
			return record, errors.New("retained request identity mismatch")
		}
		var request Request
		if err := json.Unmarshal(record.Body, &request); err != nil || request.Version != Version || request.BookID != record.BookID || request.OperationID != id {
			return record, errors.New("retained request envelope mismatch")
		}
		operation, exists := FindOperation(record.Name)
		if !exists || !operation.Writes {
			return record, errors.New("retained operation is not a supported write")
		}
		if err := Validate(request.Input, operation.Input, "input"); err != nil {
			return record, err
		}
		return record, nil
	}
	return record, errors.New("no retained request for that identity; use operations status to inspect server state")
}
func (j *Journal) List(endpoint, bookID string) ([]Record, error) {
	return j.ListForWorkspace(endpoint, bookID, "")
}

// ListForWorkspace returns retained requests matching endpoint, bookID, and (when non-empty) workspaceID.
func (j *Journal) ListForWorkspace(endpoint, bookID, workspaceID string) ([]Record, error) {
	records := []Record{}
	entries, err := os.ReadDir(j.Directory)
	if errors.Is(err, fs.ErrNotExist) {
		return records, nil
	}
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.Split(entry.Name(), ".")[0]
		if seen[id] {
			continue
		}
		seen[id] = true
		record, err := j.Load(id)
		if err != nil {
			return nil, err
		}
		if record.Endpoint == endpoint && record.BookID == bookID && (workspaceID == "" || record.WorkspaceID == workspaceID) {
			records = append(records, record)
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].OperationID < records[j].OperationID })
	return records, nil
}

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The connections file: what `rastrata connect` keeps so that every later command in the same folder works with no variable set. It holds, for each folder a person connected
// from, the address of the service, the credential (the key of a hosted workspace's agent, rsa_..., or a token of this computer's own service, rst_...) and what to call it.
// It is in the person's configuration folder, private to them (0600 in a 0700 folder), written whole and renamed into place, and it is refused if anyone else can read it,
// as the owner key file is. A credential in it goes only to the address it was made for.
//
// RASTRATA_TOKEN and RASTRATA_OWNER_KEY_FILE still win: a person or a secrets manager that sets one is obeyed.

// ConfigDirVariable names the environment variable that moves the folder the connections file is in (a test, a sandbox with no home folder).
const ConfigDirVariable = "RASTRATA_CONFIG_DIR"

const connectionsVersion = 1

// Connection is one folder's way to a book.
type Connection struct {
	// Endpoint is the service's origin, as Client.Endpoint has it.
	Endpoint string `json:"endpoint"`
	// Directory is the folder `rastrata connect` was run in: commands run in it, or under it, use this connection.
	Directory string `json:"directory"`
	// Key is the credential. It is never printed.
	Key string `json:"key"`
	// KeyID is its public identifier, as the Agents page and the trail show it.
	KeyID         string `json:"keyId,omitempty"`
	Name          string `json:"name,omitempty"`
	WorkspaceID   string `json:"workspace,omitempty"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	ConnectedAt   string `json:"connectedAt"`
	ExpiresAt     string `json:"expiresAt,omitempty"`
}

type connectionsFile struct {
	Version     int          `json:"version"`
	Connections []Connection `json:"connections"`
}

// ConnectionsPath is where the connections file is: RASTRATA_CONFIG_DIR if set, else the person's configuration folder.
func ConnectionsPath(getenv func(string) string) (string, error) {
	if directory := getenv(ConfigDirVariable); directory != "" {
		return filepath.Join(directory, "connections.json"), nil
	}
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", errors.New("this computer has no configuration folder for you; set " + ConfigDirVariable + " to a private folder")
	}
	return filepath.Join(directory, "rastrata", "connections.json"), nil
}

// LoadConnections reads the file. A file that is not there is no connections; one that others can read, or that is not what this command wrote, is an error that names it
// and never quotes it.
func LoadConnections(getenv func(string) string) ([]Connection, error) {
	path, err := ConnectionsPath(getenv)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("the connections file %s cannot be read: %s", path, describeFileError(err))
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("the connections file %s must be a regular file", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("the connections file %s must be private to you (chmod 600)", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("the connections file %s cannot be read: %s", path, describeFileError(err))
	}
	var file connectionsFile
	if err := json.Unmarshal(raw, &file); err != nil || file.Version != connectionsVersion {
		return nil, fmt.Errorf("the connections file %s is not one this version of rastrata wrote; move it away and run rastrata connect again", path)
	}
	kept := make([]Connection, 0, len(file.Connections))
	for _, connection := range file.Connections {
		// Anything that is not a credential this command keeps, for an address it talks to, is not a connection.
		if connection.Directory == "" || connection.Endpoint == "" || !(IsAgentKey(connection.Key) || tokenPattern.MatchString(connection.Key)) {
			continue
		}
		kept = append(kept, connection)
	}
	return kept, nil
}

// SaveConnections writes the file whole: to a private temporary file beside it, then renamed into place, so that a command that reads it never sees half of it.
func SaveConnections(getenv func(string) string, connections []Connection) error {
	path, err := ConnectionsPath(getenv)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("the folder %s cannot be made: %s", directory, describeFileError(err))
	}
	if connections == nil {
		connections = []Connection{}
	}
	raw, err := json.MarshalIndent(connectionsFile{Version: connectionsVersion, Connections: connections}, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".connections-*")
	if err != nil {
		return fmt.Errorf("the connections file %s cannot be written: %s", path, describeFileError(err))
	}
	name := temporary.Name()
	defer os.Remove(name)
	err = temporary.Chmod(0o600)
	if err == nil {
		_, err = temporary.Write(append(raw, '\n'))
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		return fmt.Errorf("the connections file %s cannot be written: %s", path, describeFileError(err))
	}
	return nil
}

// PutConnection adds a connection, in place of the one the same folder had to the same address.
func PutConnection(connections []Connection, added Connection) []Connection {
	kept := make([]Connection, 0, len(connections)+1)
	for _, connection := range connections {
		if connection.Directory == added.Directory && connection.Endpoint == added.Endpoint {
			continue
		}
		kept = append(kept, connection)
	}
	return append(kept, added)
}

// within says whether a folder is another or is under it.
func within(folder, ancestor string) bool {
	if folder == ancestor {
		return true
	}
	prefix := ancestor
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(folder, prefix)
}

// FindConnection chooses the connection for a command run in `folder`: the one made in that folder or in the nearest folder above it. `endpoint`, when not empty, is the
// address the person named (RASTRATA_API_URL or --endpoint): only a connection to it is used, so a credential never goes to an address it was not made for. When no folder
// above matches and `anywhere` is set, the connection made last is used: the command line on its own has nowhere else to look, and a person with one workspace should not
// have to be in a particular folder.
func FindConnection(connections []Connection, folder, endpoint string, anywhere bool) *Connection {
	var candidates []Connection
	for _, connection := range connections {
		if endpoint == "" || connection.Endpoint == endpoint {
			candidates = append(candidates, connection)
		}
	}
	var best *Connection
	for index := range candidates {
		candidate := &candidates[index]
		if !within(folder, candidate.Directory) {
			continue
		}
		if best == nil || len(candidate.Directory) > len(best.Directory) || (len(candidate.Directory) == len(best.Directory) && candidate.ConnectedAt > best.ConnectedAt) {
			best = candidate
		}
	}
	if best != nil || !anywhere || len(candidates) == 0 {
		return best
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].ConnectedAt > candidates[j].ConnectedAt })
	return &candidates[0]
}

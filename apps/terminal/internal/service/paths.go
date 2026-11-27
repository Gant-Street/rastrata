// Package service is everything the command line knows about the installed service: where its data
// lives, how the operating system starts it at login, how to look at it and how to update it.
//
// The functions in paths.go are the Go twin of apps/api/src/data-directory.ts. The service and this
// program must agree on where the book, its backups and the owner key are, so both are tested against
// the same cases (apps/api/test/data-directory.vectors.json).
package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// DefaultPort is the port the installed service listens on unless told otherwise. It is not 4010,
// the development API's port, so a checkout and a real book can run side by side.
const DefaultPort = 7278

// Paths is every place the installed service keeps something.
type Paths struct {
	Directory  string `json:"directory"`
	Database   string `json:"database"`
	Backups    string `json:"backups"`
	Exports    string `json:"exports"`
	OwnerKey   string `json:"ownerKey"`
	Logs       string `json:"logs"`
	ServiceLog string `json:"serviceLog"`
	StdioLog   string `json:"stdioLog"`
	Config     string `json:"config"`
}

// Settings are the service's settings file, config.json in the data directory.
type Settings struct {
	Port      int    `json:"port,omitempty"`
	BackupDir string `json:"backupDir,omitempty"`
}

// ConfigError is a problem with the configuration that a person can fix; its message says what to
// change.
type ConfigError struct{ Message string }

func (e *ConfigError) Error() string { return e.Message }

func configError(format string, args ...any) error {
	return &ConfigError{Message: fmt.Sprintf(format, args...)}
}

// Environment reads one environment variable. os.Getenv is the real one.
type Environment func(name string) string

// given is the value of a variable, or "" when it is missing or blank.
func given(env Environment, name string) string {
	value := env(name)
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return value
}

func absolutePath(name, value string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", configError("%s must be an absolute path, and %q is not. Write the whole path, for example /Users/you/Books.", name, value)
	}
	return filepath.Clean(value), nil
}

// override is the cleaned absolute path an environment variable names; ok is false when it is not set.
func override(env Environment, name string) (path string, ok bool, err error) {
	value := given(env, name)
	if value == "" {
		return "", false, nil
	}
	path, err = absolutePath(name, value)
	return path, err == nil, err
}

// homeDirectory is the explicit home, else HOME, else what the operating system says.
func homeDirectory(env Environment, explicit *string) (string, error) {
	candidate := ""
	switch {
	case explicit != nil:
		candidate = *explicit
	case given(env, "HOME") != "":
		candidate = given(env, "HOME")
	default:
		if current, err := user.Current(); err == nil {
			candidate = current.HomeDir
		}
	}
	if candidate == "" || !filepath.IsAbs(candidate) {
		return "", configError("Cannot tell where your home directory is. Set HOME, or set RASTRATA_DATA_DIR to an absolute path.")
	}
	return filepath.Clean(candidate), nil
}

func dataDirectory(env Environment, goos string, home *string) (string, error) {
	if chosen, ok, err := override(env, "RASTRATA_DATA_DIR"); err != nil || ok {
		return chosen, err
	}
	base, err := homeDirectory(env, home)
	if err != nil {
		return "", err
	}
	if goos == "darwin" {
		return filepath.Join(base, "Library", "Application Support", "Rastrata"), nil
	}
	// The XDG rule: a relative XDG_DATA_HOME is invalid and is ignored.
	share := filepath.Join(base, ".local", "share")
	if xdg := given(env, "XDG_DATA_HOME"); xdg != "" && filepath.IsAbs(xdg) {
		share = filepath.Clean(xdg)
	}
	return filepath.Join(share, "rastrata"), nil
}

// extension is path.extname as Node has it: the part of the last element from its last dot, and
// nothing when the only dot is the first character (a dotfile has no extension).
func extension(path string) string {
	base := filepath.Base(path)
	dot := strings.LastIndex(base, ".")
	if dot <= 0 {
		return ""
	}
	return base[dot:]
}

// Resolve gives every path of the installed service for an environment, a platform ("darwin" or
// anything else, which follows the Linux rule) and a home directory. home is nil to mean "work it
// out"; settings is nil when there is no settings file. It reads no file and creates nothing.
func Resolve(env Environment, goos string, home *string, settings *Settings) (Paths, error) {
	directory, err := dataDirectory(env, goos, home)
	if err != nil {
		return Paths{}, err
	}
	database, ok, err := override(env, "RASTRATA_LOCAL_DB")
	if err != nil {
		return Paths{}, err
	}
	if !ok {
		database = filepath.Join(directory, "book.sqlite")
	}
	// The safety code names its folders after the database file, so a book kept somewhere else
	// brings its backups along (backups/<name>/ beside it).
	book := strings.TrimSuffix(filepath.Base(database), extension(database))
	if book == "" {
		book = "book"
	}
	logs, ok, err := override(env, "RASTRATA_LOG_DIR")
	if err != nil {
		return Paths{}, err
	}
	if !ok {
		logs = filepath.Join(directory, "logs")
	}
	backups, ok, err := override(env, "RASTRATA_BACKUP_DIR")
	if err != nil {
		return Paths{}, err
	}
	if !ok {
		backups = filepath.Join(filepath.Dir(database), "backups", book)
		if settings != nil && settings.BackupDir != "" {
			backups = settings.BackupDir
		}
	}
	exports, ok, err := override(env, "RASTRATA_EXPORT_DIR")
	if err != nil {
		return Paths{}, err
	}
	if !ok {
		exports = filepath.Join(filepath.Dir(database), "exports", book)
	}
	ownerKey, ok, err := override(env, "RASTRATA_OWNER_KEY_FILE")
	if err != nil {
		return Paths{}, err
	}
	if !ok {
		ownerKey = filepath.Join(directory, "owner.key")
	}
	return Paths{
		Directory:  directory,
		Database:   database,
		Backups:    backups,
		Exports:    exports,
		OwnerKey:   ownerKey,
		Logs:       logs,
		ServiceLog: filepath.Join(logs, "service.log"),
		StdioLog:   filepath.Join(logs, "service-stdio.log"),
		Config:     filepath.Join(directory, "config.json"),
	}, nil
}

var portPattern = regexp.MustCompile(`^[0-9]{1,5}$`)

// ParsePort reads a port number: 1 to 65535, or 0 to let the system choose.
func ParsePort(value, source string) (int, error) {
	number, _ := strconv.Atoi(value)
	if !portPattern.MatchString(value) || number > 65535 {
		return 0, configError("%s must be a port number from 1 to 65535 (or 0 to let the system choose).", source)
	}
	return number, nil
}

// ResolvePort is the port the service uses: RASTRATA_API_PORT, else the settings file, else the
// default.
func ResolvePort(env Environment, settings *Settings) (int, error) {
	if value := strings.TrimSpace(env("RASTRATA_API_PORT")); value != "" {
		return ParsePort(value, "RASTRATA_API_PORT")
	}
	if settings != nil && settings.Port != 0 {
		return settings.Port, nil
	}
	return DefaultPort, nil
}

// ParseSettings reads the settings file's text. Unknown keys are ignored, so a later version's
// file can still be read by this one.
func ParseSettings(text []byte, path string) (Settings, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(text, &raw); err != nil || raw == nil {
		return Settings{}, configError("%s must hold one JSON object, for example {\"port\": %d}. Delete it to use the defaults.", path, DefaultPort)
	}
	var settings Settings
	if value, present := raw["port"]; present {
		var port float64
		if err := json.Unmarshal(value, &port); err != nil || port != float64(int(port)) || port < 1 || port > 65535 {
			return Settings{}, configError("The port in %s must be a whole number from 1 to 65535.", path)
		}
		settings.Port = int(port)
	}
	if value, present := raw["backupDir"]; present {
		var dir string
		if err := json.Unmarshal(value, &dir); err != nil || !filepath.IsAbs(dir) {
			return Settings{}, configError("backupDir in %s must be an absolute path.", path)
		}
		settings.BackupDir = filepath.Clean(dir)
	}
	return settings, nil
}

// LoadSettings reads the settings file of the data directory the environment points at. A missing
// file is no settings. The returned Paths already take the settings into account.
func LoadSettings(env Environment, goos string, home *string) (Paths, Settings, error) {
	paths, err := Resolve(env, goos, home, nil)
	if err != nil {
		return Paths{}, Settings{}, err
	}
	text, err := os.ReadFile(paths.Config)
	if errors.Is(err, os.ErrNotExist) {
		return paths, Settings{}, nil
	}
	if err != nil {
		return Paths{}, Settings{}, configError("Cannot read %s: %v", paths.Config, err)
	}
	settings, err := ParseSettings(text, paths.Config)
	if err != nil {
		return Paths{}, Settings{}, err
	}
	paths, err = Resolve(env, goos, home, &settings)
	return paths, settings, err
}

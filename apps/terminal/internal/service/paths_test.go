package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The vectors are shared with the TypeScript twin of this code (apps/api/src/data-directory.ts):
// the service and the command line must agree on where the book, its backups and the key are.
type vector struct {
	Name       string            `json:"name"`
	Platform   string            `json:"platform"`
	Home       string            `json:"home"`
	Env        map[string]string `json:"env"`
	Settings   *Settings         `json:"settings"`
	Expect     map[string]string `json:"expect"`
	Error      string            `json:"error"`
	ExpectPort *int              `json:"expectPort"`
	PortError  string            `json:"portError"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "test", "data-directory.vectors.json"))
	if err != nil {
		t.Fatalf("the shared vectors: %v", err)
	}
	var file struct {
		Cases []vector `json:"cases"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatalf("the shared vectors: %v", err)
	}
	if len(file.Cases) < 20 {
		t.Fatalf("expected the shared vectors to have many cases, got %d", len(file.Cases))
	}
	return file.Cases
}

func environment(values map[string]string) Environment {
	return func(name string) string { return values[name] }
}

func TestVectorsAgreeWithTheServiceTwin(t *testing.T) {
	for _, item := range loadVectors(t) {
		t.Run(item.Name, func(t *testing.T) {
			home := item.Home
			paths, err := Resolve(environment(item.Env), item.Platform, &home, item.Settings)
			if item.Error != "" {
				if err == nil || !strings.Contains(err.Error(), item.Error) {
					t.Fatalf("want an error containing %q, got %v", item.Error, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got := map[string]string{
				"directory": paths.Directory, "database": paths.Database, "backups": paths.Backups,
				"exports": paths.Exports, "ownerKey": paths.OwnerKey, "logs": paths.Logs,
				"serviceLog": paths.ServiceLog, "stdioLog": paths.StdioLog, "config": paths.Config,
			}
			for field, want := range item.Expect {
				if got[field] != want {
					t.Errorf("%s: want %q, got %q", field, want, got[field])
				}
			}
			port, portErr := ResolvePort(environment(item.Env), item.Settings)
			switch {
			case item.PortError != "":
				if portErr == nil || !strings.Contains(portErr.Error(), item.PortError) {
					t.Errorf("want a port error containing %q, got %v (port %d)", item.PortError, portErr, port)
				}
			case item.ExpectPort != nil:
				if portErr != nil || port != *item.ExpectPort {
					t.Errorf("want port %d, got %d (%v)", *item.ExpectPort, port, portErr)
				}
			}
		})
	}
}

func TestHomeComesFromTheEnvironmentWhenNotGiven(t *testing.T) {
	paths, err := Resolve(environment(map[string]string{"HOME": "/Users/ada"}), "darwin", nil, nil)
	if err != nil || paths.Directory != "/Users/ada/Library/Application Support/Rastrata" {
		t.Fatalf("got %q, %v", paths.Directory, err)
	}
	paths, err = Resolve(environment(map[string]string{"HOME": "/home/ada"}), "linux", nil, nil)
	if err != nil || paths.Directory != "/home/ada/.local/share/rastrata" {
		t.Fatalf("got %q, %v", paths.Directory, err)
	}
}

func TestSettingsFileRoundTrip(t *testing.T) {
	good := map[string]Settings{
		`{}`:                                      {},
		`{"port": 7300, "future": true}`:          {Port: 7300},
		`{"backupDir": "/Volumes/Backup//x/"}`:    {BackupDir: "/Volumes/Backup/x"},
		`{"port": 7300, "backupDir": "/b"}`:       {Port: 7300, BackupDir: "/b"},
		`{"port": 7300.0}`:                        {Port: 7300},
		"{\n  \"port\": 65535\n}\n":               {Port: 65535},
		`{"unrelated": {"nested": [1, 2, 3]}}`:    {},
		`{"port": 1, "backupDir": "/with space"}`: {Port: 1, BackupDir: "/with space"},
	}
	for text, want := range good {
		got, err := ParseSettings([]byte(text), "/data/config.json")
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: want %+v, got %+v (%v)", text, want, got, err)
		}
	}
	for _, text := range []string{"not json", "[]", "null", `{"port": "7300"}`, `{"port": 0}`, `{"port": 70000}`, `{"port": 1.5}`, `{"backupDir": "relative"}`, `{"backupDir": 5}`} {
		_, err := ParseSettings([]byte(text), "/data/config.json")
		if err == nil || !strings.Contains(err.Error(), "/data/config.json") {
			t.Errorf("%s: want an error naming the file, got %v", text, err)
		}
		var configProblem *ConfigError
		if err != nil && !asConfigError(err, &configProblem) {
			t.Errorf("%s: want a ConfigError, got %T", text, err)
		}
	}
}

func asConfigError(err error, target **ConfigError) bool {
	value, ok := err.(*ConfigError)
	if ok {
		*target = value
	}
	return ok
}

func TestLoadSettingsReadsTheFileOfTheDataDirectory(t *testing.T) {
	home := t.TempDir()
	env := environment(map[string]string{"RASTRATA_DATA_DIR": filepath.Join(home, "data")})
	paths, settings, err := LoadSettings(env, "linux", &home)
	if err != nil || settings != (Settings{}) {
		t.Fatalf("no file: want no settings, got %+v (%v)", settings, err)
	}
	if err := os.MkdirAll(paths.Directory, 0o700); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(home, "elsewhere")
	if err := os.WriteFile(paths.Config, []byte(`{"port": 7301, "backupDir": "`+backup+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	paths, settings, err = LoadSettings(env, "linux", &home)
	if err != nil || settings.Port != 7301 || paths.Backups != backup {
		t.Fatalf("got %+v, backups %q, %v", settings, paths.Backups, err)
	}
	port, err := ResolvePort(env, &settings)
	if err != nil || port != 7301 {
		t.Fatalf("port: %d, %v", port, err)
	}
	if err := os.WriteFile(paths.Config, []byte("nonsense"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadSettings(env, "linux", &home); err == nil || !strings.Contains(err.Error(), paths.Config) {
		t.Fatalf("a settings file that cannot be read must say which one: %v", err)
	}
}

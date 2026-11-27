package service_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

// The command line reads the data directory back out of the unit it installed, so it looks where
// the service looks. The directories here are chosen to be awkward in each file format.
var awkwardDirectories = []string{
	"/Volumes/Books/rastrata",
	"/Users/a b/My Books & Co/rastrata",
	`/data/"quoted" $HOME %h <x>`,
	`/data/back\slash`,
}

func TestTheDataDirectoryIsReadBackFromTheUnitInBothFormats(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		for _, directory := range awkwardDirectories {
			home := t.TempDir()
			env := func(string) string { return "" }
			manager, err := service.NewManager(service.ManagerOptions{GOOS: goos, Home: home, Env: env})
			if err != nil {
				t.Fatal(err)
			}
			render := service.RenderLaunchd
			if goos == "linux" {
				render = service.RenderSystemd
			}
			text, err := render(service.Spec{Executable: "/bin/rastrata-service", StdioLog: "/tmp/x.log", Environment: map[string]string{"RASTRATA_DATA_DIR": directory}})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(manager.UnitPath()), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(manager.UnitPath(), []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := service.UnitDataDirectory(goos, home, env); got != filepath.Clean(directory) {
				t.Errorf("%s: want %q, got %q", goos, directory, got)
			}
		}
	}
}

func TestAUnitWithoutAnEnvironmentOrNoUnitMeansTheDefaultPlace(t *testing.T) {
	home := t.TempDir()
	env := func(string) string { return "" }
	if got := service.UnitDataDirectory("darwin", home, env); got != "" {
		t.Fatalf("no unit: %q", got)
	}
	manager, _ := service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: home, Env: env})
	text, _ := service.RenderLaunchd(service.Spec{Executable: "/bin/rastrata-service", StdioLog: "/tmp/x.log"})
	_ = os.MkdirAll(filepath.Dir(manager.UnitPath()), 0o755)
	_ = os.WriteFile(manager.UnitPath(), []byte(text), 0o644)
	if got := service.UnitDataDirectory("darwin", home, env); got != "" {
		t.Fatalf("a unit with no environment: %q", got)
	}
	// A relative value was never written by us and is not trusted.
	_ = os.WriteFile(manager.UnitPath(), []byte("<key>RASTRATA_DATA_DIR</key><string>relative/dir</string>"), 0o644)
	if got := service.UnitDataDirectory("darwin", home, env); got != "" {
		t.Fatalf("a relative value: %q", got)
	}
}

func TestLocateUsesTheUnitsDirectoryUnlessTheEnvironmentNamesOne(t *testing.T) {
	home := t.TempDir()
	custom := filepath.Join(home, "elsewhere")
	env := map[string]string{"HOME": home}
	system := service.System{GOOS: "darwin", GOARCH: "arm64", Home: home, Getenv: func(name string) string { return env[name] }}
	manager, _ := system.Manager()
	text, _ := service.RenderLaunchd(service.Spec{Executable: "/bin/rastrata-service", StdioLog: "/tmp/x.log", Environment: map[string]string{"RASTRATA_DATA_DIR": custom}})
	_ = os.MkdirAll(filepath.Dir(manager.UnitPath()), 0o755)
	_ = os.WriteFile(manager.UnitPath(), []byte(text), 0o644)

	location, err := system.Locate()
	if err != nil || location.Paths.Directory != custom {
		t.Fatalf("from the unit: %q, %v", location.Paths.Directory, err)
	}
	// The unit needs no environment of its own when it already names the directory.
	environment, err := system.UnitEnvironment(location)
	if err != nil || environment["RASTRATA_DATA_DIR"] != custom {
		t.Fatalf("the unit keeps naming it: %v %v", environment, err)
	}
	env["RASTRATA_DATA_DIR"] = filepath.Join(home, "from-the-shell")
	location, err = system.Locate()
	if err != nil || location.Paths.Directory != filepath.Join(home, "from-the-shell") {
		t.Fatalf("the environment wins: %q, %v", location.Paths.Directory, err)
	}
	// With neither, the default.
	delete(env, "RASTRATA_DATA_DIR")
	_ = os.Remove(manager.UnitPath())
	location, _ = system.Locate()
	if location.Paths.Directory != filepath.Join(home, "Library", "Application Support", "Rastrata") {
		t.Fatalf("the default: %q", location.Paths.Directory)
	}
	if environment, _ := system.UnitEnvironment(location); len(environment) != 0 {
		t.Fatalf("the default place needs no environment: %v", environment)
	}
}

func TestUnitEnvironmentIgnoresTheShellForTheDefault(t *testing.T) {
	home := t.TempDir()
	// A shell that sets XDG_DATA_HOME moves the data, and the unit must say so: a login item does not
	// see that variable.
	env := map[string]string{"HOME": home, "XDG_DATA_HOME": filepath.Join(home, "xdg")}
	system := service.System{GOOS: "linux", GOARCH: "amd64", Home: home, Getenv: func(name string) string { return env[name] }}
	location, err := system.Locate()
	if err != nil {
		t.Fatal(err)
	}
	environment, err := system.UnitEnvironment(location)
	if err != nil || environment["RASTRATA_DATA_DIR"] != filepath.Join(home, "xdg", "rastrata") {
		t.Fatalf("%v %v", environment, err)
	}
}

func TestLocateIgnoresVariablesTheLoginItemDoesNotSee(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{
		"HOME":                    home,
		"RASTRATA_LOCAL_DB":       "/dev/book.sqlite",
		"RASTRATA_BACKUP_DIR":     "/dev/backups",
		"RASTRATA_EXPORT_DIR":     "/dev/exports",
		"RASTRATA_OWNER_KEY_FILE": "/dev/key",
		"RASTRATA_LOG_DIR":        "/dev/logs",
		"RASTRATA_API_PORT":       "4010",
	}
	system := service.System{GOOS: "darwin", GOARCH: "arm64", Home: home, Getenv: func(name string) string { return env[name] }}
	location, err := system.Locate()
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(home, "Library", "Application Support", "Rastrata")
	if location.Paths.Directory != directory || location.Paths.Database != filepath.Join(directory, "book.sqlite") ||
		location.Paths.OwnerKey != filepath.Join(directory, "owner.key") || location.Paths.Backups != filepath.Join(directory, "backups", "book") ||
		location.Paths.Logs != filepath.Join(directory, "logs") || location.Port != service.DefaultPort {
		t.Fatalf("a developer's variables moved the installed service's places: %+v port %d", location.Paths, location.Port)
	}
	// The data directory is the one variable the login item is given, and it is honoured.
	env["RASTRATA_DATA_DIR"] = filepath.Join(home, "Books")
	location, _ = system.Locate()
	if location.Paths.Directory != filepath.Join(home, "Books") || location.Paths.Database != filepath.Join(home, "Books", "book.sqlite") {
		t.Fatalf("the data directory: %+v", location.Paths)
	}
}

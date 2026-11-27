package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// System is how the service commands reach the machine: its platform, its home directory, the
// environment, the service manager's command line tool and the clock. DefaultSystem is the real one;
// tests replace the parts they need to.
type System struct {
	GOOS   string
	GOARCH string
	Home   string
	UID    int
	Getenv Environment
	Runner Runner
	HTTP   *http.Client
	Now    func() time.Time
	// Executable is the path of the running program, which is where rastrata-service is looked for.
	Executable func() (string, error)
}

// DefaultSystem is this machine.
func DefaultSystem() System {
	home, _ := os.UserHomeDir()
	return System{
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH, Home: home, UID: os.Getuid(), Getenv: os.Getenv,
		Runner: ExecRunner{}, HTTP: NewHealthClient(), Now: time.Now, Executable: os.Executable,
	}
}

// home is the home directory: the one given, else HOME, else what the operating system says.
func (s System) home() (string, error) {
	return homeDirectory(s.Getenv, s.homePointer())
}

// Manager is the platform's service manager for this system.
func (s System) Manager() (Manager, error) {
	home, err := s.home()
	if err != nil {
		return nil, err
	}
	return NewManager(ManagerOptions{GOOS: s.GOOS, Home: home, UID: s.UID, Env: s.Getenv, Runner: s.Runner, Label: strings.TrimSpace(s.Getenv(ServiceLabelVariable))})
}

// notSeenByTheLoginItem are the variables that move the service's files or port when the service is
// started by hand. A login item does not see a shell's variables (only the data directory is given to
// it, through its unit), so a command that looks after the login item must not read them either: a
// developer's shell, with RASTRATA_LOCAL_DB or RASTRATA_API_PORT set for the development service,
// would otherwise send the command line to places the installed service never uses.
var notSeenByTheLoginItem = map[string]bool{
	"RASTRATA_LOCAL_DB": true, "RASTRATA_BACKUP_DIR": true, "RASTRATA_EXPORT_DIR": true,
	"RASTRATA_OWNER_KEY_FILE": true, "RASTRATA_LOG_DIR": true, "RASTRATA_API_PORT": true,
}

func loginItemEnvironment(getenv Environment) Environment {
	return func(name string) string {
		if notSeenByTheLoginItem[name] {
			return ""
		}
		return getenv(name)
	}
}

// Location is where the service's data is and where it listens.
type Location struct {
	Paths    Paths
	Settings Settings
	Port     int
	Endpoint string
}

func (s System) homePointer() *string {
	if s.Home == "" {
		return nil
	}
	return &s.Home
}

// Locate reads the settings file (if there is one) and works out the paths and the port. The data
// directory is RASTRATA_DATA_DIR if this program's environment has it, else the one the installed
// login item was made with, else the default place: the command line looks where the service looks
// even when it is run from a shell that does not have the variable the service was started with.
func (s System) Locate() (Location, error) {
	env := loginItemEnvironment(s.Getenv)
	if given(env, "RASTRATA_DATA_DIR") == "" {
		if home, err := s.home(); err == nil {
			if directory := UnitDataDirectory(s.GOOS, home, s.Getenv); directory != "" {
				inner := env
				env = func(name string) string {
					if name == "RASTRATA_DATA_DIR" {
						return directory
					}
					return inner(name)
				}
			}
		}
	}
	paths, settings, err := LoadSettings(env, s.GOOS, s.homePointer())
	if err != nil {
		return Location{}, err
	}
	port, err := ResolvePort(loginItemEnvironment(s.Getenv), &settings)
	if err != nil {
		return Location{}, err
	}
	return Location{Paths: paths, Settings: settings, Port: port, Endpoint: Endpoint(port)}, nil
}

// LocateWith is Locate with RASTRATA_DATA_DIR taken from dataDir instead of the environment, for
// 'rastrata install --data-dir'.
func (s System) LocateWith(dataDir string) (System, Location, error) {
	if dataDir != "" {
		inner := s.Getenv
		s.Getenv = func(name string) string {
			if name == "RASTRATA_DATA_DIR" {
				return dataDir
			}
			return inner(name)
		}
	}
	location, err := s.Locate()
	return s, location, err
}

// ServiceExecutable is rastrata-service, which sits beside this program (the installer puts both in
// the same directory).
func (s System) ServiceExecutable() (string, error) {
	self, err := s.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot tell where this program is: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	candidate := filepath.Join(filepath.Dir(self), "rastrata-service")
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("cannot find rastrata-service beside this program (looked for %s). Install the package again", candidate)
	}
	return candidate, nil
}

// ExecutableVersion asks an executable of the package for its release (`<exe> version`).
func (s System) ExecutableVersion(ctx context.Context, executable string) (string, error) {
	out, err := s.Runner.Run(ctx, executable, "version")
	if err != nil {
		return "", err
	}
	if out.ExitCode != 0 {
		return "", fmt.Errorf("%s version failed: %s", filepath.Base(executable), describe(out))
	}
	return oneLine(out.Stdout), nil
}

// PrepareDataDirectory makes the data directory and the log folder, private to the user. An
// existing directory is never changed; if others can read it, that is a warning.
func PrepareDataDirectory(paths Paths) (warnings []string, err error) {
	for _, folder := range []string{paths.Directory, paths.Logs} {
		if err := os.MkdirAll(folder, 0o700); err != nil {
			return warnings, fmt.Errorf("cannot create %s: %w. Choose another place with RASTRATA_DATA_DIR", folder, err)
		}
		info, err := os.Stat(folder)
		if err != nil {
			return warnings, err
		}
		if !info.IsDir() {
			return warnings, fmt.Errorf("%s is not a directory. Move it aside, or choose another place with RASTRATA_DATA_DIR", folder)
		}
		if info.Mode().Perm()&0o077 != 0 {
			warnings = append(warnings, fmt.Sprintf("%s can be read by other users (mode %04o). Your books are in it; make it private with: chmod 700 '%s'", folder, info.Mode().Perm(), folder))
		}
	}
	return warnings, nil
}

// WriteSettings changes the settings file, keeping any key this version does not know.
func WriteSettings(paths Paths, change func(settings map[string]any)) error {
	current := map[string]any{}
	switch text, err := os.ReadFile(paths.Config); {
	case err == nil:
		if err := json.Unmarshal(text, &current); err != nil || current == nil {
			return configError("%s is not a JSON object; fix it or delete it, then try again", paths.Config)
		}
	case !errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("cannot read %s: %w", paths.Config, err)
	}
	change(current)
	encoded, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(paths.Config, append(encoded, '\n'))
}

// writePrivate writes a file that only its owner can read, all at once.
func writePrivate(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".rastrata-")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

// UnitEnvironment is what the unit file must set: RASTRATA_DATA_DIR when the data directory is not
// the place the service would choose by itself, with nothing but HOME to go on (a login item does not
// see the variables of a shell), so the service the manager starts looks where this program looks.
func (s System) UnitEnvironment(location Location) (map[string]string, error) {
	defaults, err := Resolve(func(name string) string {
		if name == "HOME" {
			return s.Getenv(name)
		}
		return ""
	}, s.GOOS, s.homePointer(), nil)
	if err != nil {
		return nil, err
	}
	if location.Paths.Directory == defaults.Directory {
		return nil, nil
	}
	return map[string]string{"RASTRATA_DATA_DIR": location.Paths.Directory}, nil
}

// PortFree reports whether nothing is listening on a loopback port (it is a courtesy check; the
// service checks again when it starts).
func PortFree(port int) bool {
	if port == 0 {
		return true
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	listener.Close()
	return true
}

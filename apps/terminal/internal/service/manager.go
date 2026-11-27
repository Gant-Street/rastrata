package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// State is what the operating system's service manager says about the service.
type State struct {
	// Installed: the unit file exists.
	Installed bool `json:"installed"`
	// Loaded: the manager knows the unit.
	Loaded  bool `json:"loaded"`
	Running bool `json:"running"`
	PID     int  `json:"pid,omitempty"`
	// Detail is the manager's own words, for a person to read when something is wrong.
	Detail string `json:"detail,omitempty"`
}

// Manager starts the service at login and keeps it running: launchd on macOS, a systemd user unit
// on Linux. It runs the manager's command line tool through a Runner, so tests need no real one.
type Manager interface {
	// Name is "launchd" or "systemd".
	Name() string
	// UnitPath is the file Install writes.
	UnitPath() string
	// Install writes the unit, loads it and starts the service. Installing again replaces the unit
	// and restarts the service.
	Install(ctx context.Context, spec Spec) error
	// Start starts the service if it is not running.
	Start(ctx context.Context) error
	// Stop stops the service; it starts again at the next login.
	Stop(ctx context.Context) error
	Status(ctx context.Context) (State, error)
	// Uninstall stops the service and removes the unit. Nothing else is touched.
	Uninstall(ctx context.Context) error
}

// ErrNotInstalled is what Start says when the service was never installed.
var ErrNotInstalled = errors.New("the Rastrata service is not installed: run 'rastrata install' (or install.sh from the package)")

// ServiceLabelVariable names a different login item for the same program: com.rastrata.service on
// macOS and rastrata.service on Linux are the real ones, and this is for a check that must not touch
// them. It is not for use: every command must be given the same value to find the same item.
const ServiceLabelVariable = "RASTRATA_SERVICE_LABEL"

var labelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$`)

// ManagerOptions says where the manager's files live and how to reach it.
type ManagerOptions struct {
	GOOS string
	Home string
	UID  int
	// Label replaces the name of the login item; empty is the real one.
	Label string
	// Env reads XDG_CONFIG_HOME for the systemd unit's place.
	Env    Environment
	Runner Runner
}

// NewManager is the service manager of this platform.
func NewManager(options ManagerOptions) (Manager, error) {
	runner := options.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	if options.Label != "" && !labelPattern.MatchString(options.Label) {
		return nil, fmt.Errorf("%s must be a plain name of letters, digits, dots, dashes and underscores", ServiceLabelVariable)
	}
	switch options.GOOS {
	case "darwin":
		label := options.Label
		if label == "" {
			label = LaunchdLabel
		}
		return &launchd{home: options.Home, uid: options.UID, run: runner, label: label}, nil
	case "linux":
		env := options.Env
		if env == nil {
			env = os.Getenv
		}
		unit := SystemdUnit
		if options.Label != "" {
			unit = options.Label + ".service"
		}
		return &systemd{home: options.Home, env: env, run: runner, unit: unit}, nil
	}
	return nil, fmt.Errorf("Rastrata starts at login on macOS and Linux; %s is not supported yet. You can still run rastrata-service yourself", options.GOOS)
}

// writeUnit writes a unit file so that a reader sees all of it or none of it.
func writeUnit(path, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".rastrata-unit-")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.WriteString(text); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// describe is the text of a failed command, for an error a person will read.
func describe(out Output) string {
	text := strings.TrimSpace(out.Stderr)
	if text == "" {
		text = strings.TrimSpace(out.Stdout)
	}
	if text == "" {
		return fmt.Sprintf("exit status %d", out.ExitCode)
	}
	return oneLine(text)
}

// oneLine puts text on one line and removes control characters, so output that came from outside
// cannot move a terminal.
func oneLine(text string) string {
	var out strings.Builder
	space := false
	for _, character := range text {
		if character < 0x20 || (character >= 0x7f && character <= 0x9f) || character == 0x2028 || character == 0x2029 {
			character = ' '
		}
		if character == ' ' {
			if space {
				continue
			}
			space = true
		} else {
			space = false
		}
		out.WriteRune(character)
	}
	return strings.TrimSpace(out.String())
}

// Package servicetest is a test double for the operating system's service managers, launchctl and
// systemctl, and for the commands that open a browser. It keeps the state a real manager keeps (is
// the unit loaded, is it running, its pid) and records every command it was asked to run, so tests
// can check what the program asked for without touching the machine's real launch agents or units.
package servicetest

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

// Fake is a service.Runner.
type Fake struct {
	mu sync.Mutex
	// Calls is every command run, as "name arg arg".
	Calls []string
	// Loaded, Running and PID are what the manager believes.
	Loaded  bool
	Running bool
	PID     int
	Enabled bool
	// Missing makes the named commands fail to run at all, as if they were not installed.
	Missing map[string]bool
	// Fail makes a verb fail with this stderr text and exit status 1 ("bootstrap", "start", ...).
	Fail map[string]string
	// OnStart runs when the unit starts and returns the pid; OnStop runs when it stops. A test uses
	// them to make a fake or real service appear and disappear with the unit.
	OnStart func() int
	OnStop  func()
	// Opened is every URL passed to open or xdg-open.
	Opened []string
	// ServiceVersion is what a rastrata-service answers to "version".
	ServiceVersion string
	// Label is the name print-disabled lists the unit under (the real one when empty).
	Label string
	// Disabled makes launchd refuse to load the unit, as it does when the login item has been
	// switched off, with its generic error; print-disabled then lists the unit as disabled.
	Disabled bool
	// Handle, when set, is offered every command first; it returns false to leave the command to
	// the double. A test uses it to make programs of its own (rastrata install) do something.
	Handle func(name string, args []string) (service.Output, bool)
}

var _ service.Runner = (*Fake)(nil)

func (f *Fake) start() {
	f.Running = true
	f.PID = 4242
	if f.OnStart != nil {
		f.PID = f.OnStart()
	}
}

func (f *Fake) stop() {
	if f.Running && f.OnStop != nil {
		f.OnStop()
	}
	f.Running, f.PID = false, 0
}

// Called reports whether a command line containing text was run.
func (f *Fake) Called(text string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range f.Calls {
		if strings.Contains(call, text) {
			return true
		}
	}
	return false
}

// Run implements service.Runner.
func (f *Fake) Run(_ context.Context, name string, args ...string) (service.Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	if f.Missing[name] {
		return service.Output{}, fmt.Errorf("exec: %q: executable file not found in $PATH", name)
	}
	if f.Handle != nil {
		f.mu.Unlock()
		out, handled := f.Handle(name, args)
		f.mu.Lock()
		if handled {
			return out, nil
		}
	}
	if filepath.Base(name) == "rastrata-service" && len(args) == 1 && args[0] == "version" {
		return service.Output{Stdout: f.ServiceVersion + "\n"}, nil
	}
	switch name {
	case "launchctl":
		return f.launchctl(args), nil
	case "systemctl":
		return f.systemctl(args), nil
	case "open", "xdg-open":
		if len(args) > 0 {
			f.Opened = append(f.Opened, args[len(args)-1])
		}
		return service.Output{}, nil
	}
	return service.Output{Stderr: "unknown command " + name, ExitCode: 127}, nil
}

func (f *Fake) failed(verb string) (service.Output, bool) {
	if message, fail := f.Fail[verb]; fail {
		return service.Output{Stderr: message, ExitCode: 1}, true
	}
	return service.Output{}, false
}

func (f *Fake) launchctl(args []string) service.Output {
	if len(args) == 0 {
		return service.Output{Stderr: "Usage: launchctl <subcommand>", ExitCode: 64}
	}
	if out, fail := f.failed(args[0]); fail {
		return out
	}
	switch args[0] {
	case "bootstrap":
		if f.Disabled {
			return service.Output{Stderr: "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.", ExitCode: 5}
		}
		if f.Loaded {
			return service.Output{Stderr: "Bootstrap failed: 5: Input/output error", ExitCode: 5}
		}
		f.Loaded = true
		f.start() // RunAtLoad
	case "bootout":
		if !f.Loaded {
			return service.Output{Stderr: "Boot-out failed: 3: No such process", ExitCode: 3}
		}
		f.stop()
		f.Loaded = false
	case "kickstart":
		if !f.Loaded {
			return service.Output{Stderr: "Could not find service in domain", ExitCode: 113}
		}
		if !f.Running {
			f.start()
		}
	case "print-disabled":
		state := "enabled"
		if f.Disabled {
			state = "disabled"
		}
		label := "com.rastrata.service"
		if len(args) > 1 && f.Label != "" {
			label = f.Label
		}
		return service.Output{Stdout: fmt.Sprintf("\tdisabled services = {\n\t\t\"com.apple.Siri.agent\" => disabled\n\t\t\"%s\" => %s\n\t}\n", label, state)}
	case "print":
		if !f.Loaded {
			return service.Output{Stderr: "Could not find service \"com.rastrata.service\" in domain for user gui: 501", ExitCode: 113}
		}
		state := "not running"
		pid := ""
		if f.Running {
			state = "running"
			pid = fmt.Sprintf("\tpid = %d\n", f.PID)
		}
		return service.Output{Stdout: fmt.Sprintf("gui/501/com.rastrata.service = {\n\tactive count = 1\n\ttype = LaunchAgent\n\tstate = %s\n%s\tlast exit code = 0\n}\n", state, pid)}
	default:
		return service.Output{Stderr: "unsupported subcommand " + args[0], ExitCode: 64}
	}
	return service.Output{}
}

func (f *Fake) systemctl(args []string) service.Output {
	if len(args) == 0 || args[0] != "--user" {
		return service.Output{Stderr: "this double only serves systemctl --user", ExitCode: 64}
	}
	args = args[1:]
	if len(args) == 0 {
		return service.Output{ExitCode: 64}
	}
	if out, fail := f.failed(args[0]); fail {
		return out
	}
	switch args[0] {
	case "daemon-reload":
	case "enable":
		f.Enabled = true
	case "disable":
		f.Enabled = false
	case "start":
		f.Loaded = true
		if !f.Running {
			f.start()
		}
	case "restart":
		f.Loaded = true
		f.stop()
		f.start()
	case "stop":
		f.stop()
	case "show":
		load, active, sub := "not-found", "inactive", "dead"
		if f.Loaded || f.Enabled {
			load = "loaded"
		}
		if f.Running {
			active, sub = "active", "running"
		}
		return service.Output{Stdout: fmt.Sprintf("LoadState=%s\nActiveState=%s\nSubState=%s\nMainPID=%d\n", load, active, sub, f.PID)}
	default:
		return service.Output{Stderr: "unsupported verb " + args[0], ExitCode: 64}
	}
	return service.Output{}
}

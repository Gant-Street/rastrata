package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// launchd is the macOS service manager: a LaunchAgent in ~/Library/LaunchAgents, loaded into the
// user's own domain, started at login and restarted if it stops without being asked to.
type launchd struct {
	home  string
	uid   int
	run   Runner
	label string
}

func (l *launchd) Name() string { return "launchd" }

func (l *launchd) UnitPath() string {
	return filepath.Join(l.home, "Library", "LaunchAgents", l.label+".plist")
}

func (l *launchd) domain() string { return "gui/" + strconv.Itoa(l.uid) }
func (l *launchd) target() string { return l.domain() + "/" + l.label }

func (l *launchd) ctl(ctx context.Context, args ...string) (Output, error) {
	out, err := l.run.Run(ctx, "launchctl", args...)
	if err != nil {
		return out, fmt.Errorf("cannot run launchctl: %w", err)
	}
	return out, nil
}

func (l *launchd) Install(ctx context.Context, spec Spec) error {
	spec.Label = l.label
	text, err := RenderLaunchd(spec)
	if err != nil {
		return err
	}
	if err := writeUnit(l.UnitPath(), text); err != nil {
		return fmt.Errorf("cannot write %s: %w", l.UnitPath(), err)
	}
	// Unload first so that installing again replaces what is loaded; it is not an error to be
	// unloaded already.
	if _, err := l.ctl(ctx, "bootout", l.target()); err != nil {
		return err
	}
	return l.bootstrap(ctx)
}

func (l *launchd) bootstrap(ctx context.Context) error {
	out, err := l.ctl(ctx, "bootstrap", l.domain(), l.UnitPath())
	if err != nil {
		return err
	}
	if out.ExitCode != 0 {
		if l.switchedOff(ctx) {
			return fmt.Errorf("macOS has this login item switched off, so it cannot start. Switch it on in System Settings (Login Items), or run: launchctl enable %s", l.target())
		}
		reason := strings.TrimSpace(strings.ReplaceAll(describe(out), "Try re-running the command as root for richer errors.", ""))
		return fmt.Errorf("launchctl could not load %s: %s", l.UnitPath(), reason)
	}
	return nil
}

// switchedOff reports whether launchd's list of disabled login items has this one. A person can do
// that in System Settings, and launchd then refuses to load it with an error that does not say why.
func (l *launchd) switchedOff(ctx context.Context) bool {
	out, err := l.ctl(ctx, "print-disabled", l.domain())
	if err != nil || out.ExitCode != 0 {
		return false
	}
	return strings.Contains(out.Stdout, `"`+l.label+`" => disabled`) || strings.Contains(out.Stdout, `"`+l.label+`" => true`)
}

func (l *launchd) Start(ctx context.Context) error {
	state, err := l.Status(ctx)
	if err != nil {
		return err
	}
	switch {
	case !state.Installed:
		return ErrNotInstalled
	case state.Running:
		return nil
	case !state.Loaded:
		return l.bootstrap(ctx)
	}
	out, err := l.ctl(ctx, "kickstart", l.target())
	if err != nil {
		return err
	}
	if out.ExitCode != 0 {
		return fmt.Errorf("launchctl could not start the service: %s", describe(out))
	}
	return nil
}

func (l *launchd) Stop(ctx context.Context) error {
	if _, err := l.ctl(ctx, "bootout", l.target()); err != nil {
		return err
	}
	// A bootout of something that is not loaded fails; what matters is that it is not loaded now.
	state, err := l.Status(ctx)
	if err != nil {
		return err
	}
	if state.Loaded {
		return fmt.Errorf("launchctl could not stop the service: %s", state.Detail)
	}
	return nil
}

var (
	launchdState = regexp.MustCompile(`(?m)^\s*state = (\S+)`)
	launchdPID   = regexp.MustCompile(`(?m)^\s*pid = (\d+)`)
)

func (l *launchd) Status(ctx context.Context) (State, error) {
	state := State{Installed: exists(l.UnitPath())}
	out, err := l.ctl(ctx, "print", l.target())
	if err != nil {
		return state, err
	}
	if out.ExitCode != 0 {
		state.Detail = describe(out)
		return state, nil
	}
	state.Loaded = true
	if match := launchdState.FindStringSubmatch(out.Stdout); match != nil {
		state.Running = match[1] == "running"
		state.Detail = "state " + oneLine(match[1])
	}
	if match := launchdPID.FindStringSubmatch(out.Stdout); match != nil {
		state.PID, _ = strconv.Atoi(match[1])
	}
	return state, nil
}

func (l *launchd) Uninstall(ctx context.Context) error {
	if err := l.Stop(ctx); err != nil {
		return err
	}
	if err := os.Remove(l.UnitPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

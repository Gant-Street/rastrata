package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// systemd is the Linux service manager: a user unit in ~/.config/systemd/user, enabled so that it
// starts when the user logs in, restarted if it fails.
type systemd struct {
	home string
	env  Environment
	run  Runner
	unit string
}

func (s *systemd) Name() string { return "systemd" }

func (s *systemd) UnitPath() string {
	base := filepath.Join(s.home, ".config")
	if xdg := s.env("XDG_CONFIG_HOME"); xdg != "" && filepath.IsAbs(xdg) {
		base = filepath.Clean(xdg)
	}
	return filepath.Join(base, "systemd", "user", s.unit)
}

const systemdUnreachable = "systemd cannot be reached for your user. Log in with a session that has a user manager, or run: loginctl enable-linger $USER"

func (s *systemd) ctl(ctx context.Context, args ...string) (Output, error) {
	out, err := s.run.Run(ctx, "systemctl", append([]string{"--user"}, args...)...)
	if err != nil {
		return out, fmt.Errorf("cannot run systemctl: %w", err)
	}
	return out, nil
}

// must runs a systemctl command that has to succeed.
func (s *systemd) must(ctx context.Context, what string, args ...string) error {
	out, err := s.ctl(ctx, args...)
	if err != nil {
		return err
	}
	if out.ExitCode != 0 {
		detail := describe(out)
		if strings.Contains(detail, "Failed to connect to bus") || strings.Contains(detail, "No medium found") {
			return fmt.Errorf("%s: %s", systemdUnreachable, detail)
		}
		return fmt.Errorf("systemctl could not %s: %s", what, detail)
	}
	return nil
}

func (s *systemd) Install(ctx context.Context, spec Spec) error {
	text, err := RenderSystemd(spec)
	if err != nil {
		return err
	}
	if err := writeUnit(s.UnitPath(), text); err != nil {
		return fmt.Errorf("cannot write %s: %w", s.UnitPath(), err)
	}
	if err := s.must(ctx, "reload its units", "daemon-reload"); err != nil {
		return err
	}
	if err := s.must(ctx, "enable the service", "enable", s.unit); err != nil {
		return err
	}
	return s.must(ctx, "start the service", "restart", s.unit)
}

func (s *systemd) Start(ctx context.Context) error {
	if !exists(s.UnitPath()) {
		return ErrNotInstalled
	}
	return s.must(ctx, "start the service", "start", s.unit)
}

func (s *systemd) Stop(ctx context.Context) error {
	return s.must(ctx, "stop the service", "stop", s.unit)
}

func (s *systemd) Status(ctx context.Context) (State, error) {
	state := State{Installed: exists(s.UnitPath())}
	out, err := s.ctl(ctx, "show", s.unit, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID")
	if err != nil {
		return state, err
	}
	if out.ExitCode != 0 {
		state.Detail = describe(out)
		return state, nil
	}
	values := map[string]string{}
	for _, line := range strings.Split(out.Stdout, "\n") {
		if key, value, found := strings.Cut(strings.TrimSpace(line), "="); found {
			values[key] = value
		}
	}
	state.Loaded = values["LoadState"] == "loaded"
	state.Running = values["ActiveState"] == "active" && values["SubState"] == "running"
	state.PID, _ = strconv.Atoi(values["MainPID"])
	state.Detail = oneLine(fmt.Sprintf("%s (%s)", values["ActiveState"], values["SubState"]))
	return state, nil
}

func (s *systemd) Uninstall(ctx context.Context) error {
	// Stopping and disabling a unit that is not there fails; the unit file's absence is the goal.
	_ = s.must(ctx, "stop the service", "stop", s.unit)
	_ = s.must(ctx, "disable the service", "disable", s.unit)
	if err := os.Remove(s.UnitPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return s.must(ctx, "reload its units", "daemon-reload")
}

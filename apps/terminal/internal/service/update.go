package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// UpdateOptions says what an update may do and how to tell the person about it.
type UpdateOptions struct {
	// Archive is the package to install, rastrata-<version>-<os>-<arch>.tar.gz.
	Archive string
	// AllowDowngrade lets an older package replace a newer install. A book that a newer release has
	// migrated may not open in an older one, so this is off unless asked for.
	AllowDowngrade bool
	// Backup takes a backup of the running book before the service is stopped. Nil takes none.
	Backup func(ctx context.Context) error
	// Progress is told each step.
	Progress func(step string)
	// StopTimeout and StartTimeout bound the waits (the service takes a last backup when it stops);
	// Step is how often to look. Zero means the defaults.
	StopTimeout, StartTimeout, Step time.Duration
}

// UpdateResult says what an update did.
type UpdateResult struct {
	From, To string
	// Kept are the files of the old version, kept beside the new ones so it can be put back by hand.
	Kept       []string
	RolledBack bool
}

type replacement struct {
	target, previous, fresh string
	swapped                 bool
}

func (r *replacement) swap() error {
	_ = os.Remove(r.previous)
	if exists(r.target) {
		if err := os.Rename(r.target, r.previous); err != nil {
			return err
		}
	}
	if err := os.Rename(r.fresh, r.target); err != nil {
		_ = os.Rename(r.previous, r.target)
		return err
	}
	r.swapped = true
	return nil
}

func (r *replacement) undo() {
	if !r.swapped {
		return
	}
	_ = os.Remove(r.target)
	if exists(r.previous) {
		_ = os.Rename(r.previous, r.target)
	}
	r.swapped = false
}

func firstWord(text string) string {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// Update installs a newer package over the installed one, without a network: it verifies the
// package, takes a backup, stops the service, puts the new programs in place, installs the unit
// with the new program's own templates and starts it, and checks that the new release is the one
// answering. If it is not, the old programs are put back and started, and the error says so.
func (s System) Update(ctx context.Context, current string, options UpdateOptions) (UpdateResult, error) {
	progress := func(step string) {
		if options.Progress != nil {
			options.Progress(step)
		}
	}
	stopTimeout, startTimeout, step := options.StopTimeout, options.StartTimeout, options.Step
	if stopTimeout == 0 {
		stopTimeout = 60 * time.Second
	}
	if startTimeout == 0 {
		startTimeout = 60 * time.Second
	}
	if step == 0 {
		step = 250 * time.Millisecond
	}
	result := UpdateResult{From: current}

	location, err := s.Locate()
	if err != nil {
		return result, err
	}
	manager, err := s.Manager()
	if err != nil {
		return result, err
	}
	serviceExecutable, err := s.ServiceExecutable()
	if err != nil {
		return result, err
	}
	binDirectory := filepath.Dir(serviceExecutable)

	progress("Checking the package")
	stage, err := os.MkdirTemp(binDirectory, ".rastrata-update-")
	if err != nil {
		return result, fmt.Errorf("cannot work in %s: %w", binDirectory, err)
	}
	defer os.RemoveAll(stage)
	pkg, err := ExtractPackage(options.Archive, filepath.Join(stage, "package"))
	if err != nil {
		return result, err
	}
	result.To = pkg.Version
	if pkg.OS != s.GOOS || pkg.Arch != s.GOARCH {
		return result, fmt.Errorf("this package is for %s-%s and this computer is %s-%s", pkg.OS, pkg.Arch, s.GOOS, s.GOARCH)
	}
	if CompareVersions(pkg.Version, current) < 0 && !options.AllowDowngrade {
		return result, fmt.Errorf("this package is %s and %s is installed. A book that a newer release has opened may not open in an older one; use --allow-downgrade if you have a verified backup and are sure", pkg.Version, current)
	}
	for _, name := range []string{"rastrata-service", "rastrata"} {
		out, err := s.Runner.Run(ctx, pkg.Bin(name), "version")
		if err != nil || out.ExitCode != 0 || firstWord(strings.TrimPrefix(strings.TrimSpace(out.Stdout), "rastrata ")) != pkg.Version {
			return result, fmt.Errorf("%s from the package does not run here or does not say %s: %s", name, pkg.Version, describe(out))
		}
	}

	state, err := manager.Status(ctx)
	if err != nil {
		return result, err
	}
	if state.Running && options.Backup != nil {
		progress("Taking a backup of your books")
		if err := options.Backup(ctx); err != nil {
			return result, fmt.Errorf("the backup before the update failed, so nothing was changed: %w", err)
		}
	}
	progress("Stopping the service")
	if err := manager.Stop(ctx); err != nil {
		return result, fmt.Errorf("could not stop the service, so nothing was changed: %w", err)
	}
	if err := WaitStopped(ctx, s.HTTP, location.Endpoint, stopTimeout, step); err != nil {
		return result, fmt.Errorf("the service did not stop, so nothing was changed: %w", err)
	}

	progress("Putting the new version in place")
	replacements := []*replacement{}
	for _, name := range []string{"rastrata-service", "rastrata"} {
		replacements = append(replacements, &replacement{
			target: filepath.Join(binDirectory, name), previous: filepath.Join(binDirectory, name+".previous"), fresh: pkg.Bin(name),
		})
	}
	undo := func() {
		for index := len(replacements) - 1; index >= 0; index-- {
			replacements[index].undo()
		}
	}
	for _, item := range replacements {
		if err := item.swap(); err != nil {
			undo()
			s.restart(ctx, location, step, startTimeout)
			return result, fmt.Errorf("could not replace %s, so the old version was put back: %w", filepath.Base(item.target), err)
		}
		result.Kept = append(result.Kept, item.previous)
	}

	progress("Starting the new version")
	failure := s.install(ctx, binDirectory, location, pkg.Version, step, startTimeout)
	if failure == nil {
		return result, nil
	}
	progress("The new version did not start; putting the old one back")
	_ = manager.Stop(ctx)
	_ = WaitStopped(ctx, s.HTTP, location.Endpoint, stopTimeout, step)
	undo()
	result.Kept = nil
	result.RolledBack = true
	if restored := s.install(ctx, binDirectory, location, current, step, startTimeout); restored != nil {
		return result, fmt.Errorf("the update to %s failed (%v) and the old version could not be started again (%v). Your books are untouched: run rastrata doctor", pkg.Version, failure, restored)
	}
	return result, fmt.Errorf("the update to %s failed (%w); the old version %s was put back and is running", pkg.Version, failure, current)
}

// install runs the installed rastrata's own install (which writes the unit from its templates and
// starts the service) and waits for the expected release to answer.
func (s System) install(ctx context.Context, binDirectory string, location Location, want string, step, timeout time.Duration) error {
	out, err := s.Runner.Run(ctx, filepath.Join(binDirectory, "rastrata"), "install")
	if err != nil {
		return err
	}
	if out.ExitCode != 0 {
		return fmt.Errorf("rastrata install failed: %s", describe(out))
	}
	health, err := WaitHealthy(ctx, s.HTTP, location.Endpoint, timeout, step)
	if err != nil {
		return fmt.Errorf("the service did not answer: %w", err)
	}
	if health.Version != want {
		return fmt.Errorf("the service that answers is %s, not %s", health.Version, want)
	}
	return nil
}

// restart starts the service again after a step that failed before anything was replaced.
func (s System) restart(ctx context.Context, location Location, step, timeout time.Duration) {
	manager, err := s.Manager()
	if err != nil {
		return
	}
	if err := manager.Start(ctx); err != nil && !errors.Is(err, ErrNotInstalled) {
		return
	}
	_, _ = WaitHealthy(ctx, s.HTTP, location.Endpoint, timeout, step)
}

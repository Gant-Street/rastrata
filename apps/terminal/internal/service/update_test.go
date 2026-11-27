package service_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

func (w *world) options(archive string) (service.UpdateOptions, *[]string) {
	steps := &[]string{}
	return service.UpdateOptions{
		Archive:      archive,
		Progress:     func(step string) { *steps = append(*steps, step) },
		StopTimeout:  2 * time.Second,
		StartTimeout: 2 * time.Second,
		Step:         10 * time.Millisecond,
	}, steps
}

func (w *world) content(name string) string {
	w.t.Helper()
	text, err := os.ReadFile(filepath.Join(w.bin, name))
	if err != nil {
		w.t.Fatal(err)
	}
	return string(text)
}

func TestAnUpdateBacksUpStopsReplacesStartsAndChecksTheNewReleaseAnswers(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	archive := makePackage(t, t.TempDir(), recipe{version: "0.2.0"})
	options, steps := w.options(archive)
	backedUp := 0
	options.Backup = func(context.Context) error { backedUp++; return nil }

	result, err := w.system.Update(context.Background(), "0.1.0", options)
	if err != nil {
		t.Fatal(err)
	}
	if result.From != "0.1.0" || result.To != "0.2.0" || result.RolledBack || len(result.Kept) != 2 {
		t.Fatalf("%+v", result)
	}
	if backedUp != 1 {
		t.Fatalf("one backup before the update, got %d", backedUp)
	}
	want := []string{"Checking the package", "Taking a backup of your books", "Stopping the service", "Putting the new version in place", "Starting the new version"}
	if strings.Join(*steps, "|") != strings.Join(want, "|") {
		t.Fatalf("steps: %v", *steps)
	}
	if w.content("rastrata") != "version=0.2.0" || w.content("rastrata-service") != "version=0.2.0" {
		t.Fatal("the new programs must be in place")
	}
	if w.content("rastrata.previous") != "version=0.1.0" || w.content("rastrata-service.previous") != "version=0.1.0" {
		t.Fatal("the old programs must be kept beside them")
	}
	if w.installs != 1 || !w.fake.Running || w.version != "0.2.0" {
		t.Fatalf("the new rastrata installs the unit once: installs %d, running %v, version %s", w.installs, w.fake.Running, w.version)
	}
	// Nothing is left behind in the programs' directory but the programs and their previous copies.
	entries, _ := os.ReadDir(w.bin)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			t.Errorf("a staging file was left behind: %s", entry.Name())
		}
	}
}

func TestAnUpdateOfTheSameReleaseIsAllowedAsARepair(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	options, _ := w.options(makePackage(t, t.TempDir(), recipe{version: "0.1.0"}))
	if _, err := w.system.Update(context.Background(), "0.1.0", options); err != nil {
		t.Fatal(err)
	}
}

func TestADowngradeNeedsToBeAskedForAndNothingChangesWhenItIsRefused(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.3.0")
	options, steps := w.options(makePackage(t, t.TempDir(), recipe{version: "0.2.0"}))
	_, err := w.system.Update(context.Background(), "0.3.0", options)
	if err == nil || !strings.Contains(err.Error(), "--allow-downgrade") {
		t.Fatalf("%v", err)
	}
	if w.content("rastrata") != "version=0.3.0" || !w.fake.Running || w.fake.Called("bootout") {
		t.Fatal("a refused update must change nothing and leave the service running")
	}
	if len(*steps) != 1 {
		t.Fatalf("it must stop at the check: %v", *steps)
	}
	options.AllowDowngrade = true
	if _, err := w.system.Update(context.Background(), "0.3.0", options); err != nil {
		t.Fatalf("allowed: %v", err)
	}
	if w.content("rastrata") != "version=0.2.0" {
		t.Fatal("the downgrade must have been done")
	}
}

func TestAPackageForAnotherComputerOrADamagedOneChangesNothing(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	for name, item := range map[string]struct {
		r    recipe
		want string
	}{
		"another system":       {recipe{goos: "linux", goarch: "amd64"}, "is for linux-amd64 and this computer is darwin-arm64"},
		"another architecture": {recipe{goarch: "amd64"}, "is for darwin-amd64"},
		"a damaged file":       {recipe{tamper: nil, versionFile: "9.9.9"}, "does not say 0.2.0"},
		"programs that do not say what the package says": {recipe{files: map[string]string{"bin/rastrata": "version=0.9.9"}}, "does not run here or does not say 0.2.0"},
	} {
		t.Run(name, func(t *testing.T) {
			options, _ := w.options(makePackage(t, t.TempDir(), item.r))
			if _, err := w.system.Update(context.Background(), "0.1.0", options); err == nil || !strings.Contains(err.Error(), item.want) {
				t.Fatalf("want %q, got %v", item.want, err)
			}
			if w.content("rastrata-service") != "version=0.1.0" || !w.fake.Running || w.fake.Called("bootout") {
				t.Fatal("nothing may change, and the service keeps running")
			}
		})
	}
}

func TestIfTheBackupFailsNothingIsChanged(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	options, _ := w.options(makePackage(t, t.TempDir(), recipe{}))
	options.Backup = func(context.Context) error { return errors.New("no space left") }
	_, err := w.system.Update(context.Background(), "0.1.0", options)
	if err == nil || !strings.Contains(err.Error(), "the backup before the update failed, so nothing was changed") || !strings.Contains(err.Error(), "no space left") {
		t.Fatalf("%v", err)
	}
	if w.content("rastrata") != "version=0.1.0" || !w.fake.Running {
		t.Fatal("the service must be left as it was")
	}
}

func TestASafeUpdateOfAServiceThatIsNotRunningTakesNoBackup(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	w.fake.Running, w.fake.Loaded = false, false
	w.setDown(true)
	options, _ := w.options(makePackage(t, t.TempDir(), recipe{}))
	options.Backup = func(context.Context) error {
		t.Fatal("there is nothing to back up through a stopped service")
		return nil
	}
	if _, err := w.system.Update(context.Background(), "0.1.0", options); err != nil {
		t.Fatal(err)
	}
	if !w.fake.Running || w.version != "0.2.0" {
		t.Fatal("an update leaves the new version running")
	}
}

func TestANewVersionThatDoesNotStartIsRolledBack(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	w.failInstall = map[string]bool{"0.2.0": true}
	options, steps := w.options(makePackage(t, t.TempDir(), recipe{}))

	result, err := w.system.Update(context.Background(), "0.1.0", options)
	if err == nil || !result.RolledBack || !strings.Contains(err.Error(), "the old version 0.1.0 was put back and is running") {
		t.Fatalf("%+v %v", result, err)
	}
	if w.content("rastrata") != "version=0.1.0" || w.content("rastrata-service") != "version=0.1.0" {
		t.Fatal("the old programs must be back in place")
	}
	if !w.fake.Running || w.version != "0.1.0" || w.installs != 2 {
		t.Fatalf("the old version must be installed again: running %v, version %s, installs %d", w.fake.Running, w.version, w.installs)
	}
	last := (*steps)[len(*steps)-1]
	if last != "The new version did not start; putting the old one back" {
		t.Fatalf("steps: %v", *steps)
	}
	if _, statErr := os.Stat(filepath.Join(w.bin, "rastrata.previous")); !os.IsNotExist(statErr) {
		t.Fatal("after a rollback there is nothing left to keep")
	}
}

func TestANewVersionThatStartsAsTheOldOneIsRolledBackToo(t *testing.T) {
	// The service that answers is not the release that was installed (it was never replaced).
	w := newWorld(t)
	w.writeVersion("0.1.0")
	options, _ := w.options(makePackage(t, t.TempDir(), recipe{}))
	w.fake.Handle = func(name string, args []string) (service.Output, bool) {
		if filepath.Base(name) == "rastrata" && len(args) == 1 && args[0] == "install" && w.installs == 0 {
			w.installs++
			w.fake.Loaded, w.fake.Running = true, true
			w.setDown(false)
			w.setVersion("0.1.0") // still the old release answering
			return service.Output{}, true
		}
		return w.command(name, args)
	}
	result, err := w.system.Update(context.Background(), "0.1.0", options)
	if err == nil || !result.RolledBack || !strings.Contains(err.Error(), "not 0.2.0") {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestIfTheOldVersionCannotBeStartedAgainTheErrorSaysTheBooksAreUntouched(t *testing.T) {
	w := newWorld(t)
	w.writeVersion("0.1.0")
	w.failInstall = map[string]bool{"0.2.0": true, "0.1.0": false}
	options, _ := w.options(makePackage(t, t.TempDir(), recipe{}))
	installs := 0
	w.fake.Handle = func(name string, args []string) (service.Output, bool) {
		if filepath.Base(name) == "rastrata" && len(args) == 1 && args[0] == "install" {
			installs++
			return service.Output{Stderr: "launchctl broke", ExitCode: 1}, true
		}
		return w.command(name, args)
	}
	_, err := w.system.Update(context.Background(), "0.1.0", options)
	if err == nil || !strings.Contains(err.Error(), "could not be started again") || !strings.Contains(err.Error(), "Your books are untouched") || installs != 2 {
		t.Fatalf("installs %d: %v", installs, err)
	}
}

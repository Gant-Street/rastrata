package cli

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

func portOf(w *installWorld) string { return strconv.Itoa(w.server.Port()) }

// recordingTool is a program that records the arguments it was given and prints one JSON envelope, in
// place of the offline tool.
func recordingTool(t *testing.T, directory string) (script, record string) {
	t.Helper()
	script = filepath.Join(directory, "fake-tool")
	record = filepath.Join(directory, "tool-args")
	text := "#!/bin/sh\nprintf '%s\\n' \"$*\" > '" + record + "'\nprintf '{\"version\":\"rastrata-application-v1\",\"ok\":true,\"data\":{}}\\n'\n"
	if err := os.WriteFile(script, []byte(text), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, record
}

func TestInstalledRestoreKnowsWhereTheBookAndItsBackupsAre(t *testing.T) {
	w := newInstallWorld(t)
	script, record := recordingTool(t, w.home)
	t.Setenv("RASTRATA_TOOL", script)
	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	if err := os.MkdirAll(w.data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.data, "config.json"), []byte(`{"port": `+portOf(w)+`}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// While the service has the book open, a restore of that book is refused, and says what to do.
	w.server.Set(func(b *servicetest.Behaviour) { b.Down = false })
	exit, out, _ := w.run("restore", "latest", "--replace")
	if _, _, code := envelope(t, out); exit != 3 || code != "service_running" || !strings.Contains(out, "rastrata stop") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if _, err := os.Stat(record); err == nil {
		t.Fatal("the tool must not have been run")
	}

	// Stopped: the book and the backup folder are the installed ones, with nothing to type but the backup.
	w.server.Set(func(b *servicetest.Behaviour) { b.Down = true })
	exit, out, diagnostics := w.run("restore", "latest", "--replace")
	if exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	args, _ := os.ReadFile(record)
	want := "restore latest --to " + filepath.Join(w.data, "book.sqlite") + " --replace --backup-dir " + filepath.Join(w.data, "backups", "book")
	if strings.TrimSpace(string(args)) != want {
		t.Fatalf("the tool was run with\n%s\nwant\n%s", args, want)
	}

	// A backup folder moved with the settings file is the one it looks in.
	elsewhere := filepath.Join(w.home, "another drive")
	if err := os.WriteFile(filepath.Join(w.data, "config.json"), []byte(`{"port": `+portOf(w)+`, "backupDir": "`+elsewhere+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if exit, _, _ := w.run("restore", "latest", "--replace"); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	args, _ = os.ReadFile(record)
	if !strings.HasSuffix(strings.TrimSpace(string(args)), "--backup-dir "+elsewhere) {
		t.Fatalf("%s", args)
	}

	// Saying where to is respected: no running-service check, and no default for it.
	target := filepath.Join(w.home, "restored", "book.sqlite")
	w.server.Set(func(b *servicetest.Behaviour) { b.Down = false })
	if exit, out, _ := w.run("restore", "latest", "--to", target); exit != 0 {
		t.Fatalf("a restore to another place needs no stop: %d %s", exit, out)
	}
	args, _ = os.ReadFile(record)
	if !strings.Contains(string(args), "--to "+target) {
		t.Fatalf("%s", args)
	}
}

func TestDevelopmentRestoreStillNeedsToBeToldWhere(t *testing.T) {
	w := newInstallWorld(t)
	script, _ := recordingTool(t, w.home)
	t.Setenv("RASTRATA_TOOL", script)
	if exit, out, _ := w.run("restore", "latest"); exit != 2 || !strings.Contains(out, "--to PATH") {
		t.Fatalf("exit %d: %s", exit, out)
	}
}

func TestTheInstalledRestoreRunsTheToolInsideTheServiceExecutable(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Skip("cannot tell where the test binary is")
	}
	t.Setenv("RASTRATA_TOOL", "")
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	beside := filepath.Join(filepath.Dir(executable), "rastrata-service")
	if _, err := os.Stat(beside); err == nil {
		t.Skip("there is already a rastrata-service beside the test binary")
	}
	if err := os.WriteFile(beside, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Skip("cannot write beside the test binary")
	}
	t.Cleanup(func() { _ = os.Remove(beside) })
	command, err := toolCommand()
	if err != nil || len(command) != 2 || command[0] != beside || command[1] != "tool" {
		t.Fatalf("%v %v", command, err)
	}
	// A file that is not executable is not the service.
	if err := os.Chmod(beside, 0o644); err != nil {
		t.Fatal(err)
	}
	if command, err := toolCommand(); err == nil && len(command) > 0 && command[0] == beside {
		t.Fatalf("a file that cannot run was chosen: %v", command)
	}
}

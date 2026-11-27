package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
	svc "github.com/Gant-Street/rastrata/apps/terminal/internal/service"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

const installKey = "rso_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"

// installWorld is a computer with the Rastrata package unpacked on it: the programs in a bin
// directory, a home directory, a double for the service manager, and a fake service that is up when
// the manager says it is.
type installWorld struct {
	t      *testing.T
	home   string
	bin    string
	data   string
	fake   *servicetest.Fake
	server *servicetest.Server
	sys    svc.System
}

func newInstallWorld(t *testing.T) *installWorld {
	t.Helper()
	home := t.TempDir()
	w := &installWorld{t: t, home: home, bin: filepath.Join(home, ".local", "bin")}
	w.data = filepath.Join(home, "Library", "Application Support", "Rastrata")
	if err := os.MkdirAll(w.bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"rastrata", "rastrata-service"} {
		if err := os.WriteFile(filepath.Join(w.bin, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	w.server = servicetest.NewServer(t, servicetest.Behaviour{
		Version: buildinfo.Version, OwnerKey: installKey, Down: true,
		Book:    `{"ok":true,"data":{"setup":null}}`,
		Backups: `{"ok":true,"data":{"directory":"/b","settings":{"warnAfterHours":48},"latestVerified":null,"backupCount":0,"warnings":[]}}`,
	})
	w.fake = &servicetest.Fake{ServiceVersion: buildinfo.Version}
	w.fake.OnStart = func() int { w.server.Set(func(b *servicetest.Behaviour) { b.Down = false }); return 4321 }
	w.fake.OnStop = func() { w.server.Set(func(b *servicetest.Behaviour) { b.Down = true }) }
	env := map[string]string{"HOME": home}
	w.sys = svc.System{
		GOOS: "darwin", GOARCH: "arm64", Home: home, UID: os.Getuid(),
		Getenv: func(name string) string { return env[name] },
		Runner: w.fake, HTTP: svc.NewHealthClient(), Now: time.Now,
		Executable: func() (string, error) { return filepath.Join(w.bin, "rastrata"), nil },
	}
	previous, previousStart, previousStop, previousStep := systemFactory, startWait, stopWait, waitStep
	systemFactory = func() svc.System { return w.sys }
	startWait, stopWait, waitStep = 3*time.Second, 3*time.Second, 10*time.Millisecond
	t.Cleanup(func() {
		systemFactory, startWait, stopWait, waitStep = previous, previousStart, previousStop, previousStep
	})
	return w
}

// install runs rastrata install --port <the fake service's port>.
func (w *installWorld) install(extra ...string) (int, string, string) {
	w.t.Helper()
	return w.run(append([]string{"install", "--port", strconv.Itoa(w.server.Port())}, extra...)...)
}

func (w *installWorld) run(args ...string) (int, string, string) {
	w.t.Helper()
	var out, diagnostics bytes.Buffer
	runner := Runner{Output: &out, Diagnostics: &diagnostics}
	exit := runner.Run(context.Background(), args)
	return exit, out.String(), diagnostics.String()
}

func (w *installWorld) writeKey() {
	w.t.Helper()
	if err := os.MkdirAll(w.data, 0o700); err != nil {
		w.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.data, "owner.key"), []byte(installKey+"\n"), 0o600); err != nil {
		w.t.Fatal(err)
	}
}

// envelope reads the JSON a command printed.
func envelope(t *testing.T, out string) (ok bool, data map[string]any, code string) {
	t.Helper()
	var response struct {
		OK    bool           `json:"ok"`
		Data  map[string]any `json:"data"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &response); err != nil {
		t.Fatalf("not a JSON envelope: %q (%v)", out, err)
	}
	if response.Error != nil {
		code = response.Error.Code
	}
	return response.OK, response.Data, code
}

func TestInstallMakesTheDataDirectoryTheLoginItemAndTheSettingsAndWaitsForTheService(t *testing.T) {
	w := newInstallWorld(t)
	exit, out, diagnostics := w.install()
	if exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	ok, data, _ := envelope(t, out)
	port := strconv.Itoa(w.server.Port())
	if !ok || data["address"] != "http://127.0.0.1:"+port || data["dataDirectory"] != w.data || data["manager"] != "launchd" || data["serviceVersion"] != buildinfo.Version {
		t.Fatalf("%+v", data)
	}
	// The data directory and its log folder are private to the user.
	for _, folder := range []string{w.data, filepath.Join(w.data, "logs")} {
		if info, err := os.Stat(folder); err != nil || info.Mode().Perm() != 0o700 {
			t.Errorf("%s: %v %v", folder, info, err)
		}
	}
	// The port is remembered where the service and the command line both read it.
	config, _ := os.ReadFile(filepath.Join(w.data, "config.json"))
	if !strings.Contains(string(config), `"port": `+port) {
		t.Errorf("config.json: %s", config)
	}
	if info, _ := os.Stat(filepath.Join(w.data, "config.json")); info.Mode().Perm() != 0o600 {
		t.Errorf("config.json mode %v", info.Mode())
	}
	// The unit is the one for this machine, pointing at the programs beside the command.
	plist, err := os.ReadFile(filepath.Join(w.home, "Library", "LaunchAgents", "com.rastrata.service.plist"))
	if err != nil || !strings.Contains(string(plist), filepath.Join(w.bin, "rastrata-service")) || !strings.Contains(string(plist), filepath.Join(w.data, "logs", "service-stdio.log")) {
		t.Fatalf("the plist: %v\n%s", err, plist)
	}
	if strings.Contains(string(plist), "RASTRATA_DATA_DIR") {
		t.Error("the default data directory needs no environment in the unit")
	}
	if !w.fake.Called("launchctl bootstrap gui/") {
		t.Fatalf("calls: %v", w.fake.Calls)
	}

	// For a person, text: where to open it and where the data is.
	w.fake.Calls = nil
	exit, text, _ := w.run("install", "--port", port, "--format", "text")
	if exit != 0 || !strings.Contains(text, "Open it:    http://127.0.0.1:"+port) || !strings.Contains(text, "Your data:") || !strings.Contains(text, "The owner lock is on") {
		t.Fatalf("exit %d: %s", exit, text)
	}
}

func TestInstallKeepsACustomDataDirectoryInTheUnitAndTheCommandLineFindsItAgain(t *testing.T) {
	w := newInstallWorld(t)
	custom := filepath.Join(w.home, "Books & Co", "rastrata")
	exit, out, diagnostics := w.install("--data-dir", custom)
	if exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	if info, err := os.Stat(custom); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the custom directory: %v %v", info, err)
	}
	plist, _ := os.ReadFile(filepath.Join(w.home, "Library", "LaunchAgents", "com.rastrata.service.plist"))
	if !strings.Contains(string(plist), "<key>RASTRATA_DATA_DIR</key>") || !strings.Contains(string(plist), "Books &amp; Co") {
		t.Fatalf("the unit must name the directory, escaped:\n%s", plist)
	}
	// A later command, with no RASTRATA_DATA_DIR in its shell, looks where the service looks.
	exit, out, _ = w.run("status", "--format", "json")
	_, data, _ := envelope(t, out)
	if exit != 0 || data["dataDirectory"] != custom {
		t.Fatalf("exit %d: %v", exit, data)
	}
	// And installing again without the flag keeps it, instead of quietly pointing at an empty place.
	if exit, out, diagnostics = w.install(); exit != 0 {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	plist, _ = os.ReadFile(filepath.Join(w.home, "Library", "LaunchAgents", "com.rastrata.service.plist"))
	if !strings.Contains(string(plist), "Books &amp; Co") {
		t.Fatalf("installing again lost the data directory:\n%s", plist)
	}
	if exit, _, _ := w.run("install", "--data-dir", "relative/dir"); exit != 2 {
		t.Fatalf("a relative data directory is a usage error, got %d", exit)
	}
}

func TestInstallRefusesWhatCannotWork(t *testing.T) {
	cases := map[string]struct {
		prepare func(w *installWorld)
		args    []string
		exit    int
		code    string
	}{
		"no service program beside the command": {func(w *installWorld) { _ = os.Remove(filepath.Join(w.bin, "rastrata-service")) }, nil, 4, "service_program_missing"},
		"a service of another release":          {func(w *installWorld) { w.fake.ServiceVersion = "9.9.9" }, nil, 4, "version_mismatch"},
		"another program on the port":           {func(w *installWorld) { w.server.Set(func(b *servicetest.Behaviour) { b.Other, b.Down = true, false }) }, nil, 4, "port_in_use"},
		"a port that is not one":                {func(*installWorld) {}, []string{"--port", "70000"}, 2, "usage_error"},
		"port 0":                                {func(*installWorld) {}, []string{"--port", "0"}, 2, "usage_error"},
		"an unknown option":                     {func(*installWorld) {}, []string{"--nope"}, 2, "usage_error"},
		"a stray argument":                      {func(*installWorld) {}, []string{"now"}, 2, "usage_error"},
		"an unsupported platform":               {func(w *installWorld) { w.sys.GOOS = "windows" }, nil, 4, "unsupported_platform"},
		"a login manager that refuses":          {func(w *installWorld) { w.fake.Fail = map[string]string{"bootstrap": "Bootstrap failed: 5"} }, nil, 4, "install_failed"},
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			w := newInstallWorld(t)
			item.prepare(w)
			args := append([]string{"install"}, item.args...)
			if len(item.args) == 0 || item.args[0] != "--port" {
				args = append(args, "--port", strconv.Itoa(w.server.Port()))
			}
			exit, out, _ := w.run(args...)
			if exit != item.exit {
				t.Fatalf("exit %d (want %d): %s", exit, item.exit, out)
			}
			if _, _, code := envelope(t, out); code != item.code {
				t.Fatalf("code %q, want %q: %s", code, item.code, out)
			}
			// A refused install writes nothing: no data directory, no settings, no login item.
			for _, path := range []string{
				filepath.Join(w.data, "config.json"),
				filepath.Join(w.home, "Library", "LaunchAgents", "com.rastrata.service.plist"),
			} {
				if _, err := os.Stat(path); err == nil && item.exit != 2 && item.code != "install_failed" {
					t.Errorf("%s was written by an install that was refused", path)
				}
			}
		})
	}
}

func TestStartStopAndStatusFollowTheManager(t *testing.T) {
	w := newInstallWorld(t)
	// Never installed: start says what to run.
	exit, out, _ := w.run("start")
	if _, _, code := envelope(t, out); exit != 4 || code != "not_installed" {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if exit, _, _ := w.run("status"); exit != 3 {
		t.Fatalf("status of something not installed exits 3, got %d", exit)
	}
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}

	exit, out, _ = w.run("status", "--format", "json")
	_, data, _ := envelope(t, out)
	if exit != 0 || data["running"] != true || data["answering"] != true || data["pid"] != float64(4321) || data["ownerKey"] != filepath.Join(w.data, "owner.key") {
		t.Fatalf("exit %d: %v", exit, data)
	}
	_, text, _ := w.run("status", "--format", "text")
	if !strings.Contains(text, "is running at http://127.0.0.1:") || !strings.Contains(text, "process 4321") || !strings.Contains(text, "none yet") {
		t.Fatalf("%s", text)
	}
	if exit, out, _ = w.run("start"); exit != 0 || !strings.Contains(out, `"changed":false`) {
		t.Fatalf("starting what runs says so and changes nothing: %d %s", exit, out)
	}

	exit, out, _ = w.run("stop", "--format", "text")
	if exit != 0 || !strings.Contains(out, "Rastrata is stopped") || !strings.Contains(out, "last backup") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if exit, _, _ := w.run("status"); exit != 3 {
		t.Fatalf("status after a stop exits 3, got %d", exit)
	}
	if exit, out, _ = w.run("stop"); exit != 0 || !strings.Contains(out, `"running":false`) {
		t.Fatalf("stopping what is stopped is not an error: %d %s", exit, out)
	}
	exit, out, _ = w.run("start", "--format", "text")
	if exit != 0 || !strings.Contains(out, "is running at") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	// A service that is loaded but never answers is reported with where to look.
	w.server.Set(func(b *servicetest.Behaviour) { b.Down = true })
	w.fake.OnStart = func() int { return 1 }
	_, _, _ = w.run("stop")
	startWait = 100 * time.Millisecond
	exit, out, diagnostics := w.run("start")
	if _, _, code := envelope(t, out); exit != 4 || code != "service_not_answering" || !strings.Contains(diagnostics, "rastrata logs") {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	for _, args := range [][]string{{"start", "--now"}, {"stop", "now"}, {"status", "--json=1"}} {
		if exit, _, _ := w.run(args...); exit != 2 {
			t.Errorf("%v: want a usage error, got %d", args, exit)
		}
	}
}

func TestLogsShowTheLastLinesWithoutAnythingThatMovesATerminal(t *testing.T) {
	w := newInstallWorld(t)
	logs := filepath.Join(w.data, "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	var log strings.Builder
	for i := 1; i <= 120; i++ {
		log.WriteString("2026-10-04T12:00:00.000Z info event " + strconv.Itoa(i) + "\n")
	}
	log.WriteString("2026-10-04T12:00:01.000Z error hostile \x1b[2J\x1b]0;title\x07 text\n")
	if err := os.WriteFile(filepath.Join(logs, "service.log"), []byte(log.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logs, "service-stdio.log"), []byte("a crash message\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	exit, out, _ := w.run("logs", "--lines", "3")
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if exit != 0 || len(lines) != 3 || !strings.HasSuffix(lines[0], "event 119") || !strings.Contains(lines[2], "hostile ?[2J?]0;title? text") {
		t.Fatalf("exit %d: %q", exit, lines)
	}
	if strings.ContainsRune(out, 0x1b) {
		t.Fatal("an escape sequence reached the output")
	}
	if exit, out, _ = w.run("logs"); exit != 0 || len(strings.Split(strings.TrimRight(out, "\n"), "\n")) != 50 {
		t.Fatalf("the default is 50 lines: %d", len(strings.Split(out, "\n")))
	}
	if exit, out, _ = w.run("logs", "--stdio"); exit != 0 || strings.TrimSpace(out) != "a crash message" {
		t.Fatalf("stdio: %q", out)
	}
	exit, out, _ = w.run("logs", "--lines", "2", "--format", "json")
	_, data, _ := envelope(t, out)
	if exit != 0 || len(data["lines"].([]any)) != 2 {
		t.Fatalf("json: %v", data)
	}
	for _, args := range [][]string{{"logs", "--lines", "0"}, {"logs", "--lines", "x"}, {"logs", "--lines", "6000"}, {"logs", "--lines"}, {"logs", "--follow", "--format", "json"}, {"logs", "extra"}} {
		if exit, _, _ := w.run(args...); exit != 2 {
			t.Errorf("%v: want a usage error, got %d", args, exit)
		}
	}
	// No log yet is not an error.
	if err := os.Remove(filepath.Join(logs, "service.log")); err != nil {
		t.Fatal(err)
	}
	if exit, out, diagnostics := w.run("logs"); exit != 0 || out != "" || !strings.Contains(diagnostics, "Nothing has been logged yet") {
		t.Fatalf("%d %q %q", exit, out, diagnostics)
	}
}

func TestOpenStartsTheServiceIfNeededAndOpensTheBrowser(t *testing.T) {
	w := newInstallWorld(t)
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}
	address := "http://127.0.0.1:" + strconv.Itoa(w.server.Port()) + "/"
	exit, out, _ := w.run("open", "--print")
	if _, data, _ := envelope(t, out); exit != 0 || data["address"] != address {
		t.Fatalf("print: %d %s", exit, out)
	}
	if len(w.fake.Opened) != 0 {
		t.Fatal("--print must not open anything")
	}
	if exit, out, _ = w.run("open"); exit != 0 || len(w.fake.Opened) != 1 || w.fake.Opened[0] != address {
		t.Fatalf("exit %d: %s, opened %v", exit, out, w.fake.Opened)
	}
	if !w.fake.Called("open " + address) {
		t.Fatalf("calls %v", w.fake.Calls)
	}
	// Stopped: open starts it first, unless told not to.
	w.run("stop")
	exit, out, _ = w.run("open", "--no-start")
	if _, _, code := envelope(t, out); exit != 4 || code != "service_not_answering" {
		t.Fatalf("no-start: %d %s", exit, out)
	}
	exit, _, diagnostics := w.run("open")
	if exit != 0 || !strings.Contains(diagnostics, "starting it") || len(w.fake.Opened) != 2 {
		t.Fatalf("exit %d: %s, opened %v", exit, diagnostics, w.fake.Opened)
	}
	// On Linux the browser is opened with xdg-open; if it cannot be, the address is printed.
	w.sys.GOOS = "linux"
	w.sys.Getenv = func(name string) string {
		return map[string]string{"HOME": w.home, "RASTRATA_DATA_DIR": w.data}[name]
	}
	w.fake.Missing = map[string]bool{"xdg-open": true}
	exit, out, _ = w.run("open", "--format", "text")
	if exit != 0 || !strings.Contains(out, "Could not start a browser. Open this address yourself: "+address) {
		t.Fatalf("%d %s", exit, out)
	}
}

func TestDoctorReportsAndExitsByWhatFailed(t *testing.T) {
	w := newInstallWorld(t)
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}
	w.writeKey()
	exit, out, _ := w.run("doctor", "--format", "text")
	if !strings.Contains(out, "Rastrata "+buildinfo.Version+" doctor") || !strings.Contains(out, "Login item") || !strings.Contains(out, "Owner lock") {
		t.Fatalf("%s", out)
	}
	if exit != 0 && !strings.Contains(out, "problem(s) need attention") {
		t.Fatalf("exit %d with no explanation: %s", exit, out)
	}
	if strings.Contains(out, installKey) || strings.Contains(out, "ABCDEFGHIJ") {
		t.Fatal("doctor must never print the owner key")
	}
	if exit != 0 {
		t.Fatalf("a fresh install with a key should pass: %s", out)
	}
	exit, out, _ = w.run("doctor", "--format", "json")
	_, data, _ := envelope(t, out)
	if exit != 0 || data["failed"] != float64(0) || len(data["checks"].([]any)) < 6 {
		t.Fatalf("%d %v", exit, data)
	}
	// A book that is a good way to the ceiling is a warning with its fix, not a failure.
	w.server.Set(func(b *servicetest.Behaviour) {
		b.Capacity = `{"configured":true,"journals":1010,"outcomes":1100,"ceilingBytes":16777216,"snapshot":{"bytes":10485760,"sequence":1100}}`
	})
	exit, out, _ = w.run("doctor", "--format", "text")
	if exit != 0 || !strings.Contains(out, "WARN  Capacity") || !strings.Contains(out, "1,010 journals") || !strings.Contains(out, "10 MB of the 16 MB") || !strings.Contains(out, "The scale limit") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	// The same book made by this version (the chain-head commitment) is not a warning at all: a snapshot
	// of 10 MB is information, and a restart takes a few seconds.
	w.server.Set(func(b *servicetest.Behaviour) {
		b.Capacity = `{"configured":true,"journals":1010,"outcomes":1100,"ceilingBytes":16777216,"snapshot":{"bytes":10485760,"sequence":1100},"commitment":"chain-head","replay":"linear","fromStartSeconds":1.1,"restartSeconds":0.4}`
	})
	exit, out, _ = w.run("doctor", "--format", "text")
	if exit != 0 || strings.Contains(out, "WARN  Capacity") || !strings.Contains(out, "Capacity") || !strings.Contains(out, "1,010 journals. The saved snapshot is 10 MB, so a restart takes a few seconds.") || strings.Contains(out, "The scale limit") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	w.server.Set(func(b *servicetest.Behaviour) { b.Capacity = "" })
	// An open service fails the check and the exit status.
	w.server.Set(func(b *servicetest.Behaviour) { b.Open = true })
	exit, out, _ = w.run("doctor", "--format", "text")
	if exit != 3 || !strings.Contains(out, "FAIL  Owner lock") || !strings.Contains(out, "OPEN") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if exit, _, _ := w.run("doctor", "--fix"); exit != 2 {
		t.Fatalf("an unknown option: %d", exit)
	}
}

func TestUninstallRemovesTheLoginItemAndKeepsTheBooks(t *testing.T) {
	w := newInstallWorld(t)
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}
	w.writeKey()
	book := filepath.Join(w.data, "book.sqlite")
	if err := os.WriteFile(book, []byte("the books"), 0o600); err != nil {
		t.Fatal(err)
	}
	exit, out, _ := w.run("uninstall", "--format", "text")
	if exit != 0 || !strings.Contains(out, "Your books and backups are still in "+w.data) {
		t.Fatalf("exit %d: %s", exit, out)
	}
	if _, err := os.Stat(filepath.Join(w.home, "Library", "LaunchAgents", "com.rastrata.service.plist")); !os.IsNotExist(err) {
		t.Fatal("the plist must be gone")
	}
	if w.fake.Running || w.fake.Loaded {
		t.Fatal("the service must be stopped and unloaded")
	}
	if text, err := os.ReadFile(book); err != nil || string(text) != "the books" {
		t.Fatal("the books must not be touched")
	}
	// A build from the repository leaves its programs alone.
	for _, name := range []string{"rastrata", "rastrata-service"} {
		if _, err := os.Stat(filepath.Join(w.bin, name)); err != nil {
			t.Errorf("%s was removed by a development build: %v", name, err)
		}
	}
	// The installed build removes the programs it was installed with, and their previous copies.
	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	for _, name := range []string{"rastrata.previous", "rastrata-service.previous"} {
		_ = os.WriteFile(filepath.Join(w.bin, name), []byte("old"), 0o755)
	}
	exit, out, _ = w.run("uninstall")
	_, data, _ := envelope(t, out)
	if exit != 0 || len(data["removed"].([]any)) < 4 {
		t.Fatalf("exit %d: %v", exit, data)
	}
	entries, _ := os.ReadDir(w.bin)
	if len(entries) != 0 {
		t.Fatalf("the programs must be gone: %v", entries)
	}
}

func TestBackupFolderMovesTheBackupsAndRestartsTheService(t *testing.T) {
	w := newInstallWorld(t)
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}
	exit, out, _ := w.run("backup", "folder", "--format", "text")
	if exit != 0 || !strings.Contains(out, "Backups are kept in "+filepath.Join(w.data, "backups", "book")) || !strings.Contains(out, "rastrata backup folder /Volumes/Backup/rastrata") || !strings.Contains(out, "not encrypted") {
		t.Fatalf("showing the default: %d %s", exit, out)
	}
	target := filepath.Join(w.home, "Backup drive", "rastrata")
	w.fake.Calls = nil
	exit, out, diagnostics := w.run("backup", "folder", target)
	_, data, _ := envelope(t, out)
	if exit != 0 || data["restarted"] != true || data["folder"] != target || !strings.Contains(diagnostics, "Restarting the service") {
		t.Fatalf("exit %d: %s %s", exit, out, diagnostics)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the folder is made private: %v %v", info, err)
	}
	if !w.fake.Called("bootout") || !w.fake.Running {
		t.Fatalf("it must stop and start the service: %v", w.fake.Calls)
	}
	config, _ := os.ReadFile(filepath.Join(w.data, "config.json"))
	if !strings.Contains(string(config), `"backupDir": "`+target+`"`) || !strings.Contains(string(config), `"port"`) {
		t.Fatalf("the setting is kept beside the port: %s", config)
	}
	if exit, out, _ = w.run("backup", "folder", "--format", "text"); !strings.Contains(out, "Backups are kept in "+target) {
		t.Fatalf("%d %s", exit, out)
	}
	exit, out, _ = w.run("backup", "folder", "--reset")
	_, data, _ = envelope(t, out)
	config, _ = os.ReadFile(filepath.Join(w.data, "config.json"))
	if exit != 0 || data["reset"] != true || strings.Contains(string(config), "backupDir") {
		t.Fatalf("reset: %d %s %s", exit, out, config)
	}
	for _, args := range [][]string{{"backup", "folder", "relative/path"}, {"backup", "folder", "--reset", target}, {"backup", "folder", "--nope"}} {
		if exit, _, _ := w.run(args...); exit != 2 {
			t.Errorf("%v: want a usage error, got %d", args, exit)
		}
	}
	file := filepath.Join(w.home, "a-file")
	_ = os.WriteFile(file, []byte("x"), 0o600)
	if exit, out, _ := w.run("backup", "folder", filepath.Join(file, "inside")); exit != 4 {
		t.Fatalf("a folder that cannot be made: %d %s", exit, out)
	}
}

func TestUpdateNeedsAPackageAndSaysSoBeforeDoingAnything(t *testing.T) {
	w := newInstallWorld(t)
	for _, args := range [][]string{{"update"}, {"update", "--from"}, {"update", "--nope", "x"}, {"update", "--from", "a", "extra"}} {
		if exit, _, _ := w.run(args...); exit != 2 {
			t.Errorf("%v: want a usage error, got %d", args, exit)
		}
	}
	exit, out, _ := w.run("update", "--from", filepath.Join(w.home, "rastrata-0.2.0-darwin-arm64.tar.gz"))
	if _, _, code := envelope(t, out); exit != 4 || code != "update_failed" {
		t.Fatalf("a package that is not there: %d %s", exit, out)
	}
	exit, out, _ = w.run("update", "--from", filepath.Join(w.home, "notes.txt"))
	if _, _, code := envelope(t, out); exit != 4 || code != "update_failed" || !strings.Contains(out, "not a Rastrata package") {
		t.Fatalf("a file that is not a package: %d %s", exit, out)
	}
}

func TestTheInstalledCommandLineFindsTheServiceAndTheOwnerKeyByItself(t *testing.T) {
	w := newInstallWorld(t)
	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	// The default endpoint is the installed port, and follows the settings file.
	if got := defaultEndpoint(); got != "http://127.0.0.1:7278" {
		t.Fatalf("the default installed port: %s", got)
	}
	if err := os.MkdirAll(w.data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.data, "config.json"), []byte(`{"port": 7391}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := defaultEndpoint(); got != "http://127.0.0.1:7391" {
		t.Fatalf("the port from the settings file: %s", got)
	}
	// With no key yet, there is no credential; once the service has made one, it is used.
	none := func(name string) string { return map[string]string{"HOME": w.home}[name] }
	if credential, err := api.CredentialFromEnvironment(none); err != nil || credential != "" {
		t.Fatalf("no key file: %q %v", credential, err)
	}
	if source := api.CredentialSource(none); source != "none" {
		t.Fatalf("source %s", source)
	}
	w.writeKey()
	w.sys.Getenv = none
	if credential, err := api.CredentialFromEnvironment(none); err != nil || credential != installKey {
		t.Fatalf("the default key: %q %v", credential, err)
	}
	if source := api.CredentialSource(none); source != "owner key" {
		t.Fatalf("source %s", source)
	}
	// A token in the environment wins, as it always did.
	token := "rst_0123456789abcdef_" + strings.Repeat("A", 43)
	withToken := func(name string) string {
		if name == "RASTRATA_TOKEN" {
			return token
		}
		return none(name)
	}
	if credential, _ := api.CredentialFromEnvironment(withToken); credential != token {
		t.Fatalf("a token must win over the key file: %q", credential)
	}
	// A key file other users can read is refused, not used.
	if err := os.Chmod(filepath.Join(w.data, "owner.key"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.CredentialFromEnvironment(none); err == nil || !strings.Contains(err.Error(), "chmod 600") || strings.Contains(err.Error(), installKey) {
		t.Fatalf("an open key file: %v", err)
	}
	// A development build never reads it.
	buildinfo.Channel = "development"
	if credential, err := api.CredentialFromEnvironment(none); err != nil || credential != "" {
		t.Fatalf("development: %q %v", credential, err)
	}
	if got := defaultEndpoint(); got != "http://127.0.0.1:4010" {
		t.Fatalf("development: %s", got)
	}
}

func TestVersionAndHelpSayWhichBuildThisIs(t *testing.T) {
	w := newInstallWorld(t)
	_, out, _ := w.run("version")
	if strings.TrimSpace(out) != "rastrata "+buildinfo.Version+" ("+api.Version+")" {
		t.Fatalf("%q", out)
	}
	_, help, _ := w.run("help")
	if !strings.Contains(help, "Start the Bun service separately") {
		t.Error("a development build tells a developer how to start the service")
	}
	for _, name := range []string{"install", "start", "stop", "status", "logs", "open", "doctor", "update", "uninstall", "backup folder"} {
		if !strings.Contains(help, "  "+name+" ") {
			t.Errorf("help does not list %q", name)
		}
	}
	buildinfo.Channel = "installed"
	t.Cleanup(func() { buildinfo.Channel = "development" })
	_, help, _ = w.run("help")
	if strings.Contains(help, "bun run dev:api") || !strings.Contains(help, "login service") {
		t.Errorf("the installed build says it is a login service: %s", help)
	}
}

func TestTheVersionIsTheOneInPackageJSON(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "package.json"))
	if err != nil {
		t.Skip("run outside the repository")
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(text, &manifest); err != nil || manifest.Version != buildinfo.Version {
		t.Fatalf("buildinfo.Version is %q and package.json says %q: change both together", buildinfo.Version, manifest.Version)
	}
}

func TestTheBackupBeforeAnUpdateWaitsForABackupThatIsAlreadyRunning(t *testing.T) {
	busyWait = time.Millisecond
	t.Cleanup(func() { busyWait = time.Second })
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		asked = append(asked, request.OperationID)
		if len(asked) <= 2 {
			// The service's own backup, taken as it starts, is still running.
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
				"error": map[string]any{"code": "backup_busy", "message": "A backup is already running. Wait for it to finish, then try again.", "details": []any{}, "retryable": true}})
			return
		}
		data := `{"state":"done","kind":"backup","startedAt":"2026-10-03T18:15:00.000Z","finishedAt":"2026-10-03T18:15:01.000Z","stage":"Finished","done":null,"total":null,"elapsedMs":900,"remainingMs":null,"backup":` + backupRecord + `}`
		_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": true, "operationId": request.OperationID, "data": json.RawMessage(data)})
	}))
	t.Cleanup(server.Close)
	key := filepath.Join(t.TempDir(), "owner.key")
	if err := os.WriteFile(key, []byte(installKey), 0o600); err != nil {
		t.Fatal(err)
	}
	location := svc.Location{Endpoint: server.URL, Paths: svc.Paths{OwnerKey: key}}
	if err := backupBeforeUpdate(Options{BookID: "local-book", Directory: t.TempDir()}, location)(context.Background()); err != nil {
		t.Fatalf("the update must wait for the running backup and then take its own: %v", err)
	}
	if len(asked) != 3 || asked[0] == "" || asked[0] != asked[1] || asked[1] != asked[2] {
		t.Fatalf("it asks again, with one identity, until the backup is made: %v", asked)
	}
}

func TestTheBackupBeforeAnUpdateGivesUpWhenTheServiceIsNeverFree(t *testing.T) {
	busyWait = time.Millisecond
	t.Cleanup(func() { busyWait = time.Second })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request api.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
			"error": map[string]any{"code": "backup_busy", "message": "A backup is already running.", "details": []any{}, "retryable": true}})
	}))
	t.Cleanup(server.Close)
	key := filepath.Join(t.TempDir(), "owner.key")
	if err := os.WriteFile(key, []byte(installKey), 0o600); err != nil {
		t.Fatal(err)
	}
	location := svc.Location{Endpoint: server.URL, Paths: svc.Paths{OwnerKey: key}}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := backupBeforeUpdate(Options{BookID: "local-book", Directory: t.TempDir()}, location)(ctx); err == nil {
		t.Fatal("a service that is never free must not be waited for for ever")
	}
}

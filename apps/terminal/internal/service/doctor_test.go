package service_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

const ownerKey = "rso_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq" // 43 characters after the prefix

var now = time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)

// world is an installed Rastrata in a scratch home: a data directory, a service manager double, and
// a small web server that says what the service says.
type world struct {
	t      *testing.T
	home   string
	data   string
	bin    string
	fake   *servicetest.Fake
	server *servicetest.Server
	system service.System
	// status and book are the bodies of backup.status and book.get, kept here to be edited.
	status  string
	book    string
	version string
	// installs counts runs of the installed rastrata's own install; failInstall names releases whose
	// install fails.
	installs    int
	failInstall map[string]bool
}

const verifiedBackups = `{"ok":true,"data":{"directory":"%DIR%","settings":{"warnAfterHours":48},"latestVerified":{"verification":{"verifiedAt":"%AT%"}},"backupCount":4,"warnings":[]}}`

func newWorld(t *testing.T) *world {
	t.Helper()
	home := t.TempDir()
	w := &world{t: t, home: home, data: filepath.Join(home, "data"), bin: filepath.Join(home, "bin"), version: "0.1.0"}
	for _, dir := range []string{w.data, filepath.Join(w.data, "logs"), w.bin, filepath.Join(w.data, "backups", "book")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"rastrata", "rastrata-service"} {
		if err := os.WriteFile(filepath.Join(w.bin, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(w.data, "owner.key"), []byte(ownerKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	w.setBook(`{"ok":true,"data":{"setup":{"name":"Co"}}}`)
	w.setBackups(now.Add(-3*time.Hour), 48)

	w.server = servicetest.NewServer(t, servicetest.Behaviour{Version: w.version, OwnerKey: ownerKey, Book: w.book, Backups: w.status})
	w.fake = &servicetest.Fake{Loaded: true, Running: true, PID: 777, ServiceVersion: w.version}
	w.fake.OnStart = func() int { w.setDown(false); return 777 }
	w.fake.OnStop = func() { w.setDown(true) }
	w.fake.Handle = w.command
	if err := os.WriteFile(filepath.Join(w.data, "config.json"), []byte(`{"port": `+strconv.Itoa(w.server.Port())+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// The unit file exists, as install made it.
	unit := filepath.Join(home, "Library", "LaunchAgents", "com.rastrata.service.plist")
	if err := os.MkdirAll(filepath.Dir(unit), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unit, []byte("<plist/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": home, "RASTRATA_DATA_DIR": w.data}
	w.system = service.System{
		GOOS: "darwin", GOARCH: "arm64", Home: home, UID: os.Getuid(),
		Getenv: func(name string) string { return env[name] },
		Runner: w.fake, HTTP: service.NewHealthClient(), Now: func() time.Time { return now },
		Executable: func() (string, error) { return filepath.Join(w.bin, "rastrata"), nil },
	}
	return w
}

func (w *world) setBackups(verifiedAt time.Time, warnAfter int) {
	text := strings.ReplaceAll(verifiedBackups, "%DIR%", filepath.Join(w.data, "backups", "book"))
	text = strings.ReplaceAll(text, "%AT%", verifiedAt.Format(time.RFC3339))
	text = strings.ReplaceAll(text, `"warnAfterHours":48`, `"warnAfterHours":`+strconv.Itoa(warnAfter))
	w.setStatus(text)
}

func (w *world) setStatus(body string) {
	w.status = body
	if w.server != nil {
		w.server.Set(func(b *servicetest.Behaviour) { b.Backups = body })
	}
}

func (w *world) setBook(body string) {
	w.book = body
	if w.server != nil {
		w.server.Set(func(b *servicetest.Behaviour) { b.Book = body })
	}
}

func (w *world) setVersion(version string) {
	w.version = version
	w.server.Set(func(b *servicetest.Behaviour) { b.Version = version })
}

func (w *world) setDown(down bool) {
	w.server.Set(func(b *servicetest.Behaviour) { b.Down = down })
}

func (w *world) doctor() service.Report {
	w.t.Helper()
	return service.Doctor{System: w.system, Version: "0.1.0"}.Run(context.Background())
}

func find(report service.Report, name string) []service.Check {
	var found []service.Check
	for _, check := range report.Checks {
		if check.Name == name {
			found = append(found, check)
		}
	}
	return found
}

func only(t *testing.T, report service.Report, name string) service.Check {
	t.Helper()
	found := find(report, name)
	if len(found) != 1 {
		t.Fatalf("want exactly one %q check, got %d in %+v", name, len(found), report.Checks)
	}
	return found[0]
}

func TestADoctorOnAHealthyInstallFailsNothingAndNeverPrintsTheKey(t *testing.T) {
	w := newWorld(t)
	report := w.doctor()
	if !report.Healthy() {
		t.Fatalf("a healthy install must have no failures: %+v", report.Checks)
	}
	for name, want := range map[string]string{"Login item": "running as process 777", "Answers": "Rastrata 0.1.0 answers", "Version": "agree", "Data directory": "private to you", "Owner lock": "refused; the key is accepted", "Backups": "3 hours ago"} {
		check := only(t, report, name)
		if check.Status != service.StatusOK || !strings.Contains(check.Message, want) {
			t.Errorf("%s: want ok containing %q, got %+v", name, want, check)
		}
	}
	// Backups on the same disk as the book are pointed at, with the one-line fix.
	place := only(t, report, "Backup place")
	if place.Status != service.StatusWarn || !strings.Contains(place.Fix, "rastrata backup folder") || !strings.Contains(place.Message, "not encrypted") {
		t.Errorf("backup place: %+v", place)
	}
	encoded, _ := json.Marshal(report)
	if strings.Contains(string(encoded), ownerKey) || strings.Contains(string(encoded), "ABCDEFGHIJ") {
		t.Fatal("doctor must never print the owner key")
	}
}

func TestNothingInstalledSaysWhatToRun(t *testing.T) {
	w := newWorld(t)
	_ = os.Remove(filepath.Join(w.home, "Library", "LaunchAgents", "com.rastrata.service.plist"))
	w.fake.Loaded, w.fake.Running = false, false
	w.server.Close()
	report := w.doctor()
	if report.Healthy() {
		t.Fatal("nothing is running: that must fail")
	}
	if check := only(t, report, "Login item"); check.Status != service.StatusFail || check.Fix != "Run rastrata install." {
		t.Errorf("login item: %+v", check)
	}
	if check := only(t, report, "Answers"); check.Status != service.StatusFail || check.Fix != "Run rastrata start." {
		t.Errorf("answers: %+v", check)
	}
	// The lock cannot be tested, and says so; the key file is still looked at.
	if check := only(t, report, "Owner lock"); check.Status != service.StatusOK || !strings.Contains(check.Message, "could not be tested") {
		t.Errorf("lock: %+v", check)
	}
}

func TestAServiceThatIsLoadedButNotRunningSaysSo(t *testing.T) {
	w := newWorld(t)
	w.fake.Running = false
	w.server.Close()
	check := only(t, w.doctor(), "Login item")
	if check.Status != service.StatusFail || !strings.Contains(check.Fix, "rastrata logs") {
		t.Errorf("%+v", check)
	}
}

func TestAnOpenServiceIsAFailureAndSaysWhatItMeans(t *testing.T) {
	w := newWorld(t)
	w.server.Set(func(b *servicetest.Behaviour) { b.Open = true })
	check := only(t, w.doctor(), "Owner lock")
	if check.Status != service.StatusFail || !strings.Contains(check.Message, "OPEN") || !strings.Contains(check.Message, "any program on this computer") {
		t.Errorf("%+v", check)
	}
}

func TestAKeyFileOthersCanReadIsAFailureThatNamesTheFix(t *testing.T) {
	w := newWorld(t)
	path := filepath.Join(w.data, "owner.key")
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	report := w.doctor()
	check := only(t, report, "Owner lock")
	if check.Status != service.StatusFail || check.Fix != "chmod 600 '"+path+"'" || !strings.Contains(check.Message, "0644") {
		t.Errorf("%+v", check)
	}
	encoded, _ := json.Marshal(report)
	if strings.Contains(string(encoded), "ABCDEFGHIJ") {
		t.Fatal("doctor must never print the owner key")
	}
	// A file that is not a key at all, and a key file that is missing.
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if check := only(t, w.doctor(), "Owner lock"); check.Status != service.StatusFail || !strings.Contains(check.Message, "not a Rastrata owner key") {
		t.Errorf("not a key: %+v", check)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if check := only(t, w.doctor(), "Owner lock"); check.Status != service.StatusFail || !strings.Contains(check.Message, "no owner key") {
		t.Errorf("no key: %+v", check)
	}
}

func TestAKeyThatIsNotTheRunningServicesIsAFailure(t *testing.T) {
	w := newWorld(t)
	other := "rso_" + strings.Repeat("z", 43)
	if err := os.WriteFile(filepath.Join(w.data, "owner.key"), []byte(other+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	check := only(t, w.doctor(), "Owner lock")
	if check.Status != service.StatusFail || !strings.Contains(check.Message, "not the one the running service uses") {
		t.Errorf("%+v", check)
	}
}

func TestAnotherProgramOnThePortIsNamedAndAnotherPortIsOffered(t *testing.T) {
	w := newWorld(t)
	w.server.Set(func(b *servicetest.Behaviour) { b.Other = true })
	check := only(t, w.doctor(), "Answers")
	if check.Status != service.StatusFail || !strings.Contains(check.Message, "Another program is using port") || !strings.Contains(check.Fix, "rastrata install --port") {
		t.Errorf("%+v", check)
	}
}

func TestVersionsThatDisagreeAreWarnedAbout(t *testing.T) {
	w := newWorld(t)
	w.fake.ServiceVersion = "0.2.0"
	if check := only(t, w.doctor(), "Version"); check.Status != service.StatusWarn || !strings.Contains(check.Message, "0.1.0 but the installed service program is 0.2.0") {
		t.Errorf("a command older than the service: %+v", check)
	}
	// The program on disk is newer than the one that is running: it was updated and not restarted.
	w = newWorld(t)
	w.setVersion("0.0.9")
	if check := only(t, w.doctor(), "Version"); check.Status != service.StatusWarn || !strings.Contains(check.Fix, "rastrata stop") {
		t.Errorf("a running service older than the installed one: %+v", check)
	}
	// No rastrata-service beside the command.
	w = newWorld(t)
	_ = os.Remove(filepath.Join(w.bin, "rastrata-service"))
	if check := only(t, w.doctor(), "Version"); check.Status != service.StatusFail || !strings.Contains(check.Message, "cannot find rastrata-service") {
		t.Errorf("missing: %+v", check)
	}
}

func TestADataDirectoryOthersCanOpenIsWarnedAbout(t *testing.T) {
	w := newWorld(t)
	if err := os.Chmod(w.data, 0o755); err != nil {
		t.Fatal(err)
	}
	check := only(t, w.doctor(), "Data directory")
	if check.Status != service.StatusWarn || check.Fix != "chmod 700 '"+w.data+"'" {
		t.Errorf("%+v", check)
	}
	if err := os.RemoveAll(w.data); err != nil {
		t.Fatal(err)
	}
	w2 := w.doctor()
	if check := only(t, w2, "Data directory"); check.Status != service.StatusFail {
		t.Errorf("missing: %+v", check)
	}
}

func TestBackupsAreJudgedByTheVerifiedOnesAge(t *testing.T) {
	w := newWorld(t)
	w.setBackups(now.Add(-60*time.Hour), 48)
	w.setStatus(strings.Replace(w.status, `"warnings":[]`, `"warnings":[{"code":"stale_verification","tone":"review","message":"The last verified backup was verified 2 days ago, more than 48 hours ago. Verify a backup again."}]`, 1))
	report := w.doctor()
	var stale *service.Check
	for _, check := range find(report, "Backups") {
		if check.Status == service.StatusWarn {
			stale = &check
		}
	}
	if stale == nil || !strings.Contains(stale.Message, "more than 48 hours") || stale.Fix != "Run rastrata backup verify." {
		t.Fatalf("a stale verification: %+v", report.Checks)
	}
	for _, check := range find(report, "Backups") {
		if check.Status == service.StatusOK {
			t.Errorf("a stale backup must not be reported as fine: %+v", check)
		}
	}

	// Never backed up is a failure; the service says so and doctor passes the advice on.
	w = newWorld(t)
	w.setStatus(`{"ok":true,"data":{"directory":"/b","settings":{"warnAfterHours":48},"latestVerified":null,"backupCount":0,"warnings":[{"code":"never_backed_up","tone":"error","message":"This book has never been backed up."}]}}`)
	report = w.doctor()
	check := only(t, report, "Backups")
	if check.Status != service.StatusFail || !strings.Contains(check.Fix, "rastrata backup create") {
		t.Errorf("never backed up: %+v", check)
	}
	if report.Healthy() {
		t.Error("no backup at all must fail the check")
	}

	// Nothing to back up before the books are set up.
	w = newWorld(t)
	w.setBook(`{"ok":true,"data":{"setup":null}}`)
	if check := only(t, w.doctor(), "Backups"); check.Status != service.StatusOK || !strings.Contains(check.Message, "nothing to back up") {
		t.Errorf("no book yet: %+v", check)
	}
}

func TestWithoutTheServiceBackupsAreLookedForInTheFolder(t *testing.T) {
	w := newWorld(t)
	w.server.Close()
	w.fake.Running = false
	check := only(t, w.doctor(), "Backups")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "No backup found") {
		t.Errorf("an empty folder: %+v", check)
	}
	manifest := filepath.Join(w.data, "backups", "book", "20261004T090000Z.manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(manifest, now.Add(-5*time.Hour), now.Add(-5*time.Hour)); err != nil {
		t.Fatal(err)
	}
	check = only(t, w.doctor(), "Backups")
	if !strings.Contains(check.Message, "from 5 hours ago") || !strings.Contains(check.Message, "not known") {
		t.Errorf("a backup file: %+v", check)
	}
}

func TestASettingsFileThatCannotBeReadStopsDoctorWithTheFileName(t *testing.T) {
	w := newWorld(t)
	if err := os.WriteFile(filepath.Join(w.data, "config.json"), []byte("port = 1"), 0o600); err != nil {
		t.Fatal(err)
	}
	report := w.doctor()
	if len(report.Checks) != 1 || report.Checks[0].Name != "Settings" || !strings.Contains(report.Checks[0].Message, "config.json") || report.Healthy() {
		t.Errorf("%+v", report.Checks)
	}
}

// versionOf reads the release a test program says it is: its content is "version=X".
func versionOf(path string) (string, bool) {
	text, err := os.ReadFile(path)
	if err != nil || !strings.HasPrefix(string(text), "version=") {
		return "", false
	}
	return strings.TrimSpace(strings.TrimPrefix(string(text), "version=")), true
}

// command is what the test programs do when the service code runs them.
func (w *world) command(name string, args []string) (service.Output, bool) {
	base := filepath.Base(name)
	switch {
	case (base == "rastrata-service" || base == "rastrata") && len(args) == 1 && args[0] == "version":
		version, known := versionOf(name)
		if !known {
			return service.Output{}, false
		}
		if base == "rastrata" {
			return service.Output{Stdout: "rastrata " + version + " (rastrata-application-v1)\n"}, true
		}
		return service.Output{Stdout: version + "\n"}, true
	case base == "rastrata" && len(args) == 1 && args[0] == "install":
		w.installs++
		version, _ := versionOf(filepath.Join(filepath.Dir(name), "rastrata-service"))
		if w.failInstall[version] {
			return service.Output{Stderr: "the new version could not start", ExitCode: 1}, true
		}
		w.setVersion(version)
		w.fake.Loaded, w.fake.Running = true, true
		w.setDown(false)
		return service.Output{}, true
	}
	return service.Output{}, false
}

// writeVersion makes both programs of the world say they are this release.
func (w *world) writeVersion(version string) {
	w.t.Helper()
	for _, name := range []string{"rastrata", "rastrata-service"} {
		if err := os.WriteFile(filepath.Join(w.bin, name), []byte("version="+version), 0o755); err != nil {
			w.t.Fatal(err)
		}
	}
	w.setVersion(version)
}

func TestVariablesThatPointTheCommandLineElsewhereAreWarnedAbout(t *testing.T) {
	w := newWorld(t)
	if checks := find(w.doctor(), "Environment"); len(checks) != 0 {
		t.Fatalf("a clean environment has nothing to say: %+v", checks)
	}
	inner := w.system.Getenv
	set := map[string]string{
		"RASTRATA_API_URL":        "http://127.0.0.1:4010/",
		"RASTRATA_OWNER_KEY_FILE": "/elsewhere/key",
		"RASTRATA_TOKEN":          "rst_0123456789abcdef_" + strings.Repeat("A", 43),
	}
	w.system.Getenv = func(name string) string {
		if value, present := set[name]; present {
			return value
		}
		return inner(name)
	}
	report := w.doctor()
	checks := find(report, "Environment")
	if len(checks) != 3 {
		t.Fatalf("one warning for each: %+v", checks)
	}
	text := ""
	for _, check := range checks {
		if check.Status != service.StatusWarn || check.Fix == "" {
			t.Errorf("%+v", check)
		}
		text += check.Message
	}
	for _, want := range []string{"RASTRATA_API_URL is set to http://127.0.0.1:4010", "RASTRATA_OWNER_KEY_FILE names /elsewhere/key", "acts as that agent token"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %s", want, text)
		}
	}
	if strings.Contains(text, "rst_0123456789abcdef") {
		t.Error("the token must never be printed")
	}
	// The same address, written the same way, is not a conflict.
	set["RASTRATA_API_URL"] = w.server.URL + "/"
	delete(set, "RASTRATA_OWNER_KEY_FILE")
	delete(set, "RASTRATA_TOKEN")
	if checks := find(w.doctor(), "Environment"); len(checks) != 0 {
		t.Fatalf("the installed address is no conflict: %+v", checks)
	}
}

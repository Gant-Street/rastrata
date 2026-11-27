package service_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

// A throwaway label lets a check run the real launchd or systemd without touching the login item
// that a real install would use.

func TestAThrowawayLabelRenamesTheLaunchdAgentEverywhere(t *testing.T) {
	home := t.TempDir()
	fake := &servicetest.Fake{}
	manager, err := service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: home, UID: 501, Runner: fake, Label: "com.rastrata.service.trial-1"})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "Library", "LaunchAgents", "com.rastrata.service.trial-1.plist")
	if manager.UnitPath() != want {
		t.Fatalf("unit path %s", manager.UnitPath())
	}
	if err := manager.Install(context.Background(), spec(t)); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(fake.Calls, "\n"); got != "launchctl bootout gui/501/com.rastrata.service.trial-1\nlaunchctl bootstrap gui/501 "+want {
		t.Fatalf("calls:\n%s", got)
	}
	text, _ := os.ReadFile(want)
	if !strings.Contains(string(text), "<string>com.rastrata.service.trial-1</string>") || strings.Contains(string(text), "<string>com.rastrata.service</string>") {
		t.Fatalf("the plist must carry the throwaway label:\n%s", text)
	}
	// Without a label, the real one.
	real, _ := service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: home, UID: 501, Runner: fake})
	if filepath.Base(real.UnitPath()) != "com.rastrata.service.plist" {
		t.Fatalf("the real label: %s", real.UnitPath())
	}
}

func TestAThrowawayLabelRenamesTheSystemdUnitToo(t *testing.T) {
	home := t.TempDir()
	fake := &servicetest.Fake{}
	env := func(string) string { return "" }
	manager, err := service.NewManager(service.ManagerOptions{GOOS: "linux", Home: home, Env: env, Runner: fake, Label: "rastrata-trial"})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".config", "systemd", "user", "rastrata-trial.service"); manager.UnitPath() != want {
		t.Fatalf("unit path %s", manager.UnitPath())
	}
	if err := manager.Install(context.Background(), spec(t)); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(fake.Calls, "\n"); got != "systemctl --user daemon-reload\nsystemctl --user enable rastrata-trial.service\nsystemctl --user restart rastrata-trial.service" {
		t.Fatalf("calls:\n%s", got)
	}
}

func TestALabelThatCouldEscapeItsFolderIsRefused(t *testing.T) {
	for _, label := range []string{"../evil", "a/b", `a\b`, "-x", ".hidden", "has space", "semi;colon", "$(x)", strings.Repeat("a", 102), "bell\x07"} {
		for _, goos := range []string{"darwin", "linux"} {
			if _, err := service.NewManager(service.ManagerOptions{GOOS: goos, Home: t.TempDir(), Label: label}); err == nil || !strings.Contains(err.Error(), service.ServiceLabelVariable) {
				t.Errorf("%s %q: want a refusal naming the variable, got %v", goos, label, err)
			}
		}
	}
}

func TestTheEnvironmentsLabelReachesTheManagerAndTheUnitLookup(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{"HOME": home, service.ServiceLabelVariable: "com.rastrata.service.trial-2"}
	system := service.System{GOOS: "darwin", GOARCH: "arm64", Home: home, Getenv: func(name string) string { return env[name] }}
	manager, err := system.Manager()
	if err != nil || filepath.Base(manager.UnitPath()) != "com.rastrata.service.trial-2.plist" {
		t.Fatalf("%v %v", manager, err)
	}
	// The data directory recorded in the throwaway unit is read back from that unit, not the real one's.
	custom := filepath.Join(home, "trial-data")
	text, _ := service.RenderLaunchd(service.Spec{Executable: "/bin/rastrata-service", StdioLog: "/tmp/x.log", Environment: map[string]string{"RASTRATA_DATA_DIR": custom}, Label: "com.rastrata.service.trial-2"})
	_ = os.MkdirAll(filepath.Dir(manager.UnitPath()), 0o755)
	_ = os.WriteFile(manager.UnitPath(), []byte(text), 0o644)
	if got := service.UnitDataDirectory("darwin", home, system.Getenv); got != custom {
		t.Fatalf("the throwaway unit's directory: %q", got)
	}
	delete(env, service.ServiceLabelVariable)
	if got := service.UnitDataDirectory("darwin", home, system.Getenv); got != "" {
		t.Fatalf("the real unit does not exist, so there is no directory to read: %q", got)
	}
	env[service.ServiceLabelVariable] = "../bad"
	if _, err := system.Manager(); err == nil {
		t.Fatal("a bad label must be refused where the manager is made")
	}
}

func TestALoginItemSwitchedOffIsNamedNotLeftAsAnInputOutputError(t *testing.T) {
	home := t.TempDir()
	fake := &servicetest.Fake{Disabled: true}
	manager, _ := service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: home, UID: 501, Runner: fake})
	err := manager.Install(context.Background(), spec(t))
	if err == nil || !strings.Contains(err.Error(), "switched off") || !strings.Contains(err.Error(), "launchctl enable gui/501/com.rastrata.service") {
		t.Fatalf("a login item that is switched off: %v", err)
	}
	if strings.Contains(err.Error(), "root") {
		t.Fatalf("launchd's advice to run as root must not reach a person: %v", err)
	}
	// Another reason for the same error keeps launchd's words, without the advice about root.
	fake = &servicetest.Fake{Fail: map[string]string{"bootstrap": "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors."}}
	manager, _ = service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: t.TempDir(), UID: 501, Runner: fake})
	err = manager.Install(context.Background(), spec(t))
	if err == nil || !strings.Contains(err.Error(), "Input/output error") || strings.Contains(err.Error(), "root") || strings.Contains(err.Error(), "switched off") {
		t.Fatalf("an unexplained refusal: %v", err)
	}
}

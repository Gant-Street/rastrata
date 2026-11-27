package service_test

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

// plistValue reads one value of a property list: a string, an integer, a boolean, an array or a dict.
func plistValue(decoder *xml.Decoder, start xml.StartElement) any {
	switch start.Name.Local {
	case "string", "integer":
		var text string
		_ = decoder.DecodeElement(&text, &start)
		return text
	case "true":
		_ = decoder.Skip()
		return true
	case "false":
		_ = decoder.Skip()
		return false
	case "array":
		var items []any
		for {
			token, err := decoder.Token()
			if err != nil {
				return items
			}
			switch element := token.(type) {
			case xml.StartElement:
				items = append(items, plistValue(decoder, element))
			case xml.EndElement:
				return items
			}
		}
	case "dict":
		values := map[string]any{}
		key := ""
		for {
			token, err := decoder.Token()
			if err != nil {
				return values
			}
			switch element := token.(type) {
			case xml.StartElement:
				if element.Name.Local == "key" {
					_ = decoder.DecodeElement(&key, &element)
				} else {
					values[key] = plistValue(decoder, element)
				}
			case xml.EndElement:
				return values
			}
		}
	}
	_ = decoder.Skip()
	return nil
}

// parsePlist reads the top-level dict of a property list, failing the test if the XML is not
// well formed.
func parsePlist(t *testing.T, text string) map[string]any {
	t.Helper()
	decoder := xml.NewDecoder(strings.NewReader(text))
	for {
		token, err := decoder.Token()
		if err != nil {
			t.Fatalf("the property list is not well-formed XML: %v\n%s", err, text)
		}
		if element, ok := token.(xml.StartElement); ok && element.Name.Local == "dict" {
			values, _ := plistValue(decoder, element).(map[string]any)
			return values
		}
	}
}

const awkwardDirectory = `/Users/a&b <c>/Library/Application Support/Rastrata "x"`

func TestTheLaunchdAgentIsWellFormedAndSaysWhatItShould(t *testing.T) {
	text, err := service.RenderLaunchd(service.Spec{
		Executable:  "/Users/a&b <c>/.local/bin/rastrata-service",
		StdioLog:    awkwardDirectory + "/logs/service-stdio.log",
		Environment: map[string]string{"RASTRATA_DATA_DIR": awkwardDirectory, "AAA": "first"},
	})
	if err != nil {
		t.Fatal(err)
	}
	plist := parsePlist(t, text)
	if plist["Label"] != "com.rastrata.service" {
		t.Errorf("label: %v", plist["Label"])
	}
	arguments, _ := plist["ProgramArguments"].([]any)
	if len(arguments) != 2 || arguments[0] != "/Users/a&b <c>/.local/bin/rastrata-service" || arguments[1] != "serve" {
		t.Errorf("program arguments: %v", arguments)
	}
	if plist["RunAtLoad"] != true {
		t.Errorf("it must start at login: %v", plist["RunAtLoad"])
	}
	keepAlive, _ := plist["KeepAlive"].(map[string]any)
	if keepAlive["SuccessfulExit"] != false {
		t.Errorf("it must restart after a crash and not after a clean stop: %v", keepAlive)
	}
	if plist["Umask"] != "63" {
		t.Errorf("umask 077 is 63 in decimal: %v", plist["Umask"])
	}
	if plist["StandardOutPath"] != awkwardDirectory+"/logs/service-stdio.log" || plist["StandardErrorPath"] != plist["StandardOutPath"] {
		t.Errorf("stdio: %v / %v", plist["StandardOutPath"], plist["StandardErrorPath"])
	}
	environment, _ := plist["EnvironmentVariables"].(map[string]any)
	if environment["RASTRATA_DATA_DIR"] != awkwardDirectory || environment["AAA"] != "first" || len(environment) != 2 {
		t.Errorf("environment: %v", environment)
	}
	// No environment, no section.
	bare, err := service.RenderLaunchd(service.Spec{Executable: "/bin/rastrata-service", StdioLog: "/tmp/x.log"})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := parsePlist(t, bare)["EnvironmentVariables"]; present {
		t.Error("an empty environment must leave the section out")
	}
	if strings.Contains(text, "<!--") && strings.Index(text, "<!--") > strings.Index(text, "<plist") {
		t.Error("the comment belongs before the plist, where every parser accepts it")
	}
}

func TestTheSystemdUnitQuotesWhatSystemdWouldReadSpecially(t *testing.T) {
	text, err := service.RenderSystemd(service.Spec{
		Executable:  `/home/a b/bin/rastrata-service`,
		StdioLog:    "/home/a b/100%/service-stdio.log",
		Environment: map[string]string{"RASTRATA_DATA_DIR": `/data/"quoted" $HOME %h`},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"[Unit]", "[Service]", "[Install]",
		`ExecStart="/home/a b/bin/rastrata-service" serve`,
		`Environment="RASTRATA_DATA_DIR=/data/\"quoted\" $$HOME %%h"`,
		"Restart=on-failure", "UMask=0077", "WantedBy=default.target",
		"StandardOutput=append:/home/a b/100%%/service-stdio.log",
		"StandardError=append:/home/a b/100%%/service-stdio.log",
	} {
		if !strings.Contains(text, want+"\n") && !strings.HasSuffix(text, want) {
			t.Errorf("the unit lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "Environment=\n") {
		t.Error("no environment must mean no Environment line")
	}
}

func TestTheTemplatesInThePackageAreTheEmbeddedOnes(t *testing.T) {
	for _, name := range service.TemplateNames {
		text, err := service.Template(name)
		if err != nil || len(text) < 100 {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func spec(t *testing.T) service.Spec {
	t.Helper()
	return service.Spec{Executable: "/home/a/.local/bin/rastrata-service", StdioLog: filepath.Join(t.TempDir(), "stdio.log")}
}

func TestLaunchdInstallStartStopUninstall(t *testing.T) {
	home := t.TempDir()
	fake := &servicetest.Fake{}
	manager, err := service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: home, UID: 501, Runner: fake})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	want := filepath.Join(home, "Library", "LaunchAgents", "com.rastrata.service.plist")
	if manager.Name() != "launchd" || manager.UnitPath() != want {
		t.Fatalf("%s at %s", manager.Name(), manager.UnitPath())
	}
	if err := manager.Start(ctx); !errors.Is(err, service.ErrNotInstalled) {
		t.Fatalf("starting what was never installed: %v", err)
	}
	fake.Calls = nil

	if err := manager.Install(ctx, spec(t)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(want)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("the plist: %v %v", info, err)
	}
	if got := strings.Join(fake.Calls, "\n"); got != "launchctl bootout gui/501/com.rastrata.service\nlaunchctl bootstrap gui/501 "+want {
		t.Fatalf("install asked launchctl for:\n%s", got)
	}
	state, err := manager.Status(ctx)
	if err != nil || !state.Installed || !state.Loaded || !state.Running || state.PID != 4242 {
		t.Fatalf("after install: %+v %v", state, err)
	}

	// Installing again replaces what is loaded; it does not fail because it is loaded already.
	if err := manager.Install(ctx, spec(t)); err != nil {
		t.Fatalf("install twice: %v", err)
	}
	// Start of something running is nothing to do.
	before := len(fake.Calls)
	if err := manager.Start(ctx); err != nil || fake.Called("kickstart") {
		t.Fatalf("start while running: %v, calls %v", err, fake.Calls[before:])
	}

	if err := manager.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	state, _ = manager.Status(ctx)
	if state.Loaded || state.Running || !state.Installed {
		t.Fatalf("after stop the unit stays installed and is not loaded: %+v", state)
	}
	// Stopping again is fine.
	if err := manager.Stop(ctx); err != nil {
		t.Fatalf("stop twice: %v", err)
	}
	// Start after a stop loads it again.
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if state, _ = manager.Status(ctx); !state.Running {
		t.Fatalf("after start: %+v", state)
	}
	// A loaded unit that is not running (it exited by itself) is kickstarted, not reloaded.
	fake.Running, fake.PID = false, 0
	if err := manager.Start(ctx); err != nil || !fake.Called("kickstart gui/501/com.rastrata.service") {
		t.Fatalf("kickstart: %v %v", err, fake.Calls)
	}

	if err := manager.Uninstall(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(want); !os.IsNotExist(err) {
		t.Fatalf("the plist must be gone: %v", err)
	}
	if state, _ = manager.Status(ctx); state.Installed || state.Loaded {
		t.Fatalf("after uninstall: %+v", state)
	}
	if err := manager.Uninstall(ctx); err != nil {
		t.Fatalf("uninstall twice: %v", err)
	}
}

func TestLaunchdFailuresSayWhatWentWrong(t *testing.T) {
	home := t.TempDir()
	fake := &servicetest.Fake{Fail: map[string]string{"bootstrap": "Bootstrap failed: 5: Input/output error\nwith\x1b[2J extra"}}
	manager, _ := service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: home, UID: 501, Runner: fake})
	err := manager.Install(context.Background(), spec(t))
	if err == nil || !strings.Contains(err.Error(), "launchctl could not load") || !strings.Contains(err.Error(), "Input/output error") {
		t.Fatalf("a failed load: %v", err)
	}
	if strings.ContainsAny(err.Error(), "\x1b\n") {
		t.Fatalf("output from outside must not reach a terminal as it came: %q", err.Error())
	}

	missing := &servicetest.Fake{Missing: map[string]bool{"launchctl": true}}
	manager, _ = service.NewManager(service.ManagerOptions{GOOS: "darwin", Home: t.TempDir(), UID: 501, Runner: missing})
	if err := manager.Install(context.Background(), spec(t)); err == nil || !strings.Contains(err.Error(), "cannot run launchctl") {
		t.Fatalf("no launchctl: %v", err)
	}
}

func TestSystemdInstallStartStopUninstall(t *testing.T) {
	home := t.TempDir()
	fake := &servicetest.Fake{}
	env := func(name string) string { return map[string]string{}[name] }
	manager, err := service.NewManager(service.ManagerOptions{GOOS: "linux", Home: home, Env: env, Runner: fake})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	want := filepath.Join(home, ".config", "systemd", "user", "rastrata.service")
	if manager.Name() != "systemd" || manager.UnitPath() != want {
		t.Fatalf("%s at %s", manager.Name(), manager.UnitPath())
	}
	if err := manager.Start(ctx); !errors.Is(err, service.ErrNotInstalled) {
		t.Fatalf("starting what was never installed: %v", err)
	}
	if err := manager.Install(ctx, spec(t)); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(fake.Calls, "\n"); got != "systemctl --user daemon-reload\nsystemctl --user enable rastrata.service\nsystemctl --user restart rastrata.service" {
		t.Fatalf("install asked systemctl for:\n%s", got)
	}
	state, err := manager.Status(ctx)
	if err != nil || !state.Installed || !state.Loaded || !state.Running || state.PID != 4242 {
		t.Fatalf("after install: %+v %v", state, err)
	}
	if err := manager.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if state, _ = manager.Status(ctx); state.Running || !state.Installed {
		t.Fatalf("after stop: %+v", state)
	}
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if state, _ = manager.Status(ctx); !state.Running {
		t.Fatalf("after start: %+v", state)
	}
	if err := manager.Uninstall(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(want); !os.IsNotExist(err) {
		t.Fatalf("the unit must be gone: %v", err)
	}
	if !fake.Called("systemctl --user disable rastrata.service") {
		t.Fatalf("uninstall must disable the unit: %v", fake.Calls)
	}
}

func TestSystemdUnitPlaceFollowsXDGConfigHome(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(home, "cfg")
	env := func(name string) string {
		if name == "XDG_CONFIG_HOME" {
			return config
		}
		return ""
	}
	manager, _ := service.NewManager(service.ManagerOptions{GOOS: "linux", Home: home, Env: env, Runner: &servicetest.Fake{}})
	if manager.UnitPath() != filepath.Join(config, "systemd", "user", "rastrata.service") {
		t.Fatalf("%s", manager.UnitPath())
	}
	relative := func(string) string { return "relative/cfg" }
	manager, _ = service.NewManager(service.ManagerOptions{GOOS: "linux", Home: home, Env: relative, Runner: &servicetest.Fake{}})
	if manager.UnitPath() != filepath.Join(home, ".config", "systemd", "user", "rastrata.service") {
		t.Fatalf("a relative XDG_CONFIG_HOME is ignored: %s", manager.UnitPath())
	}
}

func TestSystemdWithoutAUserSessionSaysHowToGetOne(t *testing.T) {
	fake := &servicetest.Fake{Fail: map[string]string{"daemon-reload": "Failed to connect to bus: No medium found"}}
	manager, _ := service.NewManager(service.ManagerOptions{GOOS: "linux", Home: t.TempDir(), Runner: fake})
	err := manager.Install(context.Background(), spec(t))
	if err == nil || !strings.Contains(err.Error(), "loginctl enable-linger") {
		t.Fatalf("no user manager: %v", err)
	}
}

func TestOtherPlatformsAreRefusedPlainly(t *testing.T) {
	if _, err := service.NewManager(service.ManagerOptions{GOOS: "windows", Home: "C:\\Users\\a"}); err == nil || !strings.Contains(err.Error(), "macOS and Linux") {
		t.Fatalf("windows: %v", err)
	}
}

func serviceAt(handler http.HandlerFunc) *httptest.Server { return httptest.NewServer(handler) }

func TestHealthTellsRastrataFromAnythingElse(t *testing.T) {
	client := service.NewHealthClient()
	ctx := context.Background()

	rastrata := serviceAt(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"service":"rastrata","version":"9.9.9"}`)
	})
	defer rastrata.Close()
	if health, err := service.CheckHealth(ctx, client, rastrata.URL); err != nil || health.Version != "9.9.9" {
		t.Fatalf("rastrata: %+v %v", health, err)
	}

	for name, body := range map[string]string{
		"a web page":        "<html>hello</html>",
		"a different JSON":  `{"ok":true}`,
		"another service":   `{"ok":true,"service":"other"}`,
		"not ok":            `{"ok":false,"service":"rastrata"}`,
		"an empty answer":   "",
		"a very long lie":   strings.Repeat("x", 100000),
		"truncated JSON":    `{"ok":true,"service":"rast`,
		"JSON of the wrong": `[1,2,3]`,
	} {
		other := serviceAt(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) })
		_, err := service.CheckHealth(ctx, client, other.URL)
		other.Close()
		if !errors.Is(err, service.ErrOtherProgram) {
			t.Errorf("%s: want ErrOtherProgram, got %v", name, err)
		}
	}
	teapot := serviceAt(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	if _, err := service.CheckHealth(ctx, client, teapot.URL); !errors.Is(err, service.ErrOtherProgram) {
		t.Errorf("a non-200 answer: %v", err)
	}
	teapot.Close()

	gone := serviceAt(func(http.ResponseWriter, *http.Request) {})
	url := gone.URL
	gone.Close()
	if _, err := service.CheckHealth(ctx, client, url); !errors.Is(err, service.ErrNotRunning) {
		t.Errorf("nothing listening: %v", err)
	}
}

func TestWaitingForTheServiceToComeAndGo(t *testing.T) {
	client := service.NewHealthClient()
	ctx := context.Background()
	listener := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"service":"rastrata","version":"1.2.3"}`)
	}))
	address := "http://" + listener.Listener.Addr().String()

	// Not yet up: the wait gives up at its timeout.
	if _, err := service.WaitHealthy(ctx, client, address, 150*time.Millisecond, 20*time.Millisecond); !errors.Is(err, service.ErrNotRunning) {
		t.Fatalf("not up: %v", err)
	}
	// It comes up while we wait.
	go func() {
		time.Sleep(100 * time.Millisecond)
		listener.Start()
	}()
	health, err := service.WaitHealthy(ctx, client, address, 3*time.Second, 20*time.Millisecond)
	if err != nil || health.Version != "1.2.3" {
		t.Fatalf("coming up: %+v %v", health, err)
	}
	// It is up, so waiting for it to stop times out ...
	if err := service.WaitStopped(ctx, client, address, 100*time.Millisecond, 20*time.Millisecond); err == nil {
		t.Fatal("it is still answering")
	}
	// ... and returns once it is gone.
	go func() {
		time.Sleep(100 * time.Millisecond)
		listener.Close()
	}()
	if err := service.WaitStopped(ctx, client, address, 3*time.Second, 20*time.Millisecond); err != nil {
		t.Fatalf("going down: %v", err)
	}
}

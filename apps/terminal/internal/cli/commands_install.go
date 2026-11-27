package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
	svc "github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

// The install lane's commands: the installed service, which starts at login and keeps itself
// running, and the tools to look after it. None needs the service to be up, so each is Offline; the
// ones that ask the service something (doctor, update's backup) make their own connection.
//
//	rastrata install [--port N] [--data-dir DIR]   install the login item and start the service
//	rastrata start | stop                          start it now, or stop it now (it starts again at login)
//	rastrata status                                is it running, where, which release, where the data is
//	rastrata logs [--lines N] [--follow] [--stdio] what the service says
//	rastrata open [--print] [--no-start]           open the web app in the browser
//	rastrata doctor                                check the install, the lock and the backups
//	rastrata update --from FILE [--allow-downgrade] install a newer package, without a network
//	rastrata uninstall                             remove the login item and the programs; keep the books
//	rastrata backup folder [PATH | --reset]        keep backups somewhere else
//
// The text output is for a person at a terminal; with --format json, or when output is piped, every
// command prints the usual JSON envelope.
func init() {
	Register(Command{Name: "install", Offline: true, Local: true, Summary: "Install the login service: Rastrata starts when you log in and restarts if it stops [--port N] [--data-dir DIR]", Run: runInstall})
	Register(Command{Name: "start", Offline: true, Local: true, Summary: "Start the installed service and wait until it answers", Run: runStart})
	Register(Command{Name: "stop", Offline: true, Local: true, Summary: "Stop the installed service (it takes a last backup first, and starts again at your next login)", Run: runStop})
	Register(Command{Name: "status", Offline: true, Local: true, Summary: "Is the service running, at which address, which release, and where the data is", Run: runStatus})
	Register(Command{Name: "logs", Offline: true, Local: true, Summary: "Show what the service has logged [--lines N] [--follow] [--stdio]", Run: runLogs})
	Register(Command{Name: "open", Offline: true, Local: true, Summary: "Open Rastrata in your browser, starting the service if needed [--print] [--no-start]", Run: runOpen})
	Register(Command{Name: "doctor", Offline: true, Local: true, Summary: "Check the install: version, port, data directory, owner lock, backups, and whether the service answers", Run: runDoctor})
	Register(Command{Name: "update", Offline: true, Local: true, Summary: "Install a newer package over this one, with no network: update --from rastrata-VERSION-OS-ARCH.tar.gz [--allow-downgrade]", Run: runUpdate})
	Register(Command{Name: "uninstall", Offline: true, Local: true, Summary: "Remove the login item and the programs; your books and backups are kept", Run: runUninstall})
	Register(Command{Name: "backup folder", Offline: true, Local: true, Summary: "Keep backups on another drive: backup folder PATH (no PATH shows the folder; --reset returns to the default)", Run: runBackupFolder})
}

// systemFactory is the machine the commands act on; tests replace it.
var systemFactory = svc.DefaultSystem

// startCommand is how to start the service: the development service is started from the repository.
func startCommand() string {
	if buildinfo.Installed() {
		return "rastrata start"
	}
	return "bun run dev:api"
}

func init() { configureForBuild() }

// configureForBuild sets what depends on which build this is: what a connection that failed says to do, and where the owner
// key is looked for. The program runs it once at start-up; a test that stamps another build runs it again.
func configureForBuild() {
	if buildinfo.CommandLineOnly() {
		api.ServiceUnavailable = "Rastrata did not answer. Check this computer's connection to the internet and the address in RASTRATA_API_URL (" + hostedEndpoint + " unless you set another)"
	} else if buildinfo.Installed() {
		api.ServiceUnavailable = "Rastrata is not answering. Run rastrata status to see whether it is running, and rastrata start to start it"
	}
	// The installed command line finds the owner key in the data directory by itself. The command line on its own has no data directory.
	api.DefaultOwnerKeyFile = func(getenv func(string) string) string {
		if !buildinfo.Installed() || buildinfo.CommandLineOnly() {
			return ""
		}
		sys := systemFactory()
		sys.Getenv = getenv
		location, err := sys.Locate()
		if err != nil {
			return ""
		}
		return location.Paths.OwnerKey
	}
}

// hostedEndpoint is where the hosted service is: the address of the sign-in page and of every workspace's API.
const hostedEndpoint = "https://app.rastrata.com"

// defaultEndpoint is where the service is when nothing says otherwise: the development API's port
// for a build from the repository, the installed service's port (7278 unless it was changed with
// rastrata install --port) for the installed build, and the hosted service for the command line on its own.
func defaultEndpoint() string {
	if buildinfo.CommandLineOnly() {
		return hostedEndpoint
	}
	if !buildinfo.Installed() {
		return "http://127.0.0.1:4010"
	}
	if location, err := systemFactory().Locate(); err == nil {
		return location.Endpoint
	}
	return svc.Endpoint(svc.DefaultPort)
}

// serviceHelp is the sentence of the help text about starting the service.
func serviceHelp() string {
	if buildinfo.CommandLineOnly() {
		return "This is the command line on its own: your books are in your workspace at " + hostedEndpoint + "/, and nothing runs on this computer.\n"
	}
	if buildinfo.Installed() {
		return "Rastrata runs as a login service on this computer: rastrata status, doctor, logs, stop and start\nmanage it, and the command line reads the owner key from your data directory by itself.\n"
	}
	return "Start the Bun service separately: bun run dev:api. "
}

// endpointHelp is the help text's line for --endpoint.
func endpointHelp() string {
	if buildinfo.CommandLineOnly() {
		return "API origin (default " + hostedEndpoint + ")"
	}
	return "API origin: this computer (default http://127.0.0.1:4010) or https://app.rastrata.com"
}

// accessHelp is the paragraph of the help text about credentials.
func accessHelp() string {
	if buildinfo.CommandLineOnly() {
		return "To connect an agent, run 'connect CODE' in the folder it works in, with the code from your workspace's agent settings: it keeps the agent's\naccess for that folder and writes its instructions there. RASTRATA_TOKEN, when set, is used instead (a token that starts rsa_).\nRASTRATA_API_URL is the workspace's address, " + hostedEndpoint + " unless you set another.\n"
	}
	return "With no credentials the CLI acts as the owner of an open service. An agent should be given only a token: run 'connect' in the folder it\nworks in (with the code from a hosted workspace's agent settings, or with no code for the service on this computer), or set RASTRATA_TOKEN\n(create one with 'tokens create', set up the agent with 'agent init'). RASTRATA_OWNER_KEY_FILE names the\nowner key file of a service started with the same variable; RASTRATA_TOKEN wins when both are set.\n"
}

// The waits. A service that has to stop takes a last backup first.
var (
	startWait = 45 * time.Second
	stopWait  = 90 * time.Second
	waitStep  = 250 * time.Millisecond
	logStep   = 500 * time.Millisecond
)

func installFlagProblem(o Options, allowed, valued []string, booleans ...string) string {
	known := map[string]bool{}
	for _, name := range allowed {
		known[name] = true
	}
	names := make([]string, 0, len(o.Flags))
	for name := range o.Flags {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !known[name] {
			return "unknown option --" + name
		}
	}
	for _, name := range valued {
		if value, given := o.Flags[name]; given && (value == "true" || value == "") {
			return "--" + name + " needs a value"
		}
	}
	// A flag written on its own takes the next word as its value; a switch has none.
	for _, name := range booleans {
		if value, given := o.Flags[name]; given && value != "true" && value != "false" {
			return "--" + name + " takes no value (write it before the other options, or as --" + name + "=true)"
		}
	}
	return ""
}

func isTerminal(w io.Writer) bool {
	file, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// wantsText says whether to write for a person: --format text asks for it, --format json refuses
// it, and with neither the output is text when it goes to a terminal.
func (r Runner) wantsText(o Options) bool {
	if o.FormatGiven {
		return o.Format == "text"
	}
	return isTerminal(r.Output)
}

// installResult prints a finished command: the text for a person, or the JSON envelope.
func (r Runner) installResult(o Options, data any, text string) {
	if r.wantsText(o) {
		fmt.Fprintln(r.Output, strings.TrimRight(text, "\n"))
		return
	}
	raw, _ := json.Marshal(data)
	_ = json.NewEncoder(r.Output).Encode(api.Response{Version: api.Version, BookID: o.BookID, OK: true, Data: raw})
}

func usageFor(r Runner, o Options, problem, usage string) int {
	return r.localError(o, "usage_error", problem+". Use "+usage, 2)
}

// serviceProblem is the exit for an install that cannot do what was asked: not a mistake in the
// command, a fact about the machine.
func (r Runner) serviceProblem(o Options, code string, err error) int {
	exit := 4
	var configProblem *svc.ConfigError
	if errors.As(err, &configProblem) {
		exit = 2
	}
	return r.localError(o, code, err.Error(), exit)
}

func shortHome(path string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(path, home+string(filepath.Separator)) {
		return "~" + strings.TrimPrefix(path, home)
	}
	return path
}

// ---- install ------------------------------------------------------------------------------

type installed struct {
	Version     string   `json:"version"`
	Address     string   `json:"address"`
	DataDir     string   `json:"dataDirectory"`
	Manager     string   `json:"manager"`
	Unit        string   `json:"unit"`
	Service     string   `json:"serviceVersion"`
	OwnerKey    string   `json:"ownerKey"`
	Warnings    []string `json:"warnings"`
	StartsLogin bool     `json:"startsAtLogin"`
	// Reading is true while the service is still reading the book it started on.
	Reading     bool     `json:"reading,omitempty"`
	SecondsLeft *float64 `json:"secondsLeft,omitempty"`
}

// readingFields is what a command that has just seen the service answer says about its reading of
// the book: whether it is under way, and about how long is left.
func readingFields(h svc.Health) (bool, *float64) {
	if !h.Reading() {
		return false, nil
	}
	return true, h.Warmup.SecondsLeft
}

func runInstall(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "install [--port N] [--data-dir DIR]"
	if problem := installFlagProblem(o, []string{"port", "data-dir"}, []string{"port", "data-dir"}); problem != "" {
		return usageFor(r, o, problem, usage)
	}
	if len(o.Args) != 1 {
		return usageFor(r, o, "install takes no arguments", usage)
	}
	sys, location, err := systemFactory().LocateWith(o.Flags["data-dir"])
	if err != nil {
		return r.serviceProblem(o, "configuration_error", err)
	}
	port, portGiven := 0, false
	if value, given := o.Flags["port"]; given {
		if port, err = svc.ParsePort(value, "--port"); err != nil || port == 0 {
			return usageFor(r, o, "--port must be a port number from 1 to 65535", usage)
		}
		portGiven = true
		location.Port, location.Endpoint = port, svc.Endpoint(port)
	}
	executable, err := sys.ServiceExecutable()
	if err != nil {
		return r.serviceProblem(o, "service_program_missing", err)
	}
	release, err := sys.ExecutableVersion(ctx, executable)
	if err != nil {
		return r.serviceProblem(o, "service_program_broken", fmt.Errorf("rastrata-service does not run: %w", err))
	}
	if release != buildinfo.Version {
		return r.serviceProblem(o, "version_mismatch", fmt.Errorf("rastrata is %s but rastrata-service is %s: they must be the same release. Install the package again", buildinfo.Version, release))
	}
	manager, err := sys.Manager()
	if err != nil {
		return r.serviceProblem(o, "unsupported_platform", err)
	}
	if _, err := svc.CheckHealth(ctx, sys.HTTP, location.Endpoint); errors.Is(err, svc.ErrOtherProgram) {
		return r.serviceProblem(o, "port_in_use", fmt.Errorf("another program is using port %d. Choose another: rastrata install --port %d", location.Port, location.Port+1))
	}
	environment, err := sys.UnitEnvironment(location)
	if err != nil {
		return r.serviceProblem(o, "configuration_error", err)
	}
	// Only now, with everything checked, is anything written: a refused install must not leave a
	// settings file that points the command line at a port the service is not on.
	warnings, err := svc.PrepareDataDirectory(location.Paths)
	if err != nil {
		return r.serviceProblem(o, "data_directory_unusable", err)
	}
	if portGiven {
		if err := svc.WriteSettings(location.Paths, func(settings map[string]any) { settings["port"] = port }); err != nil {
			return r.serviceProblem(o, "settings_unwritable", err)
		}
	}
	if err := manager.Install(ctx, svc.Spec{Executable: executable, StdioLog: location.Paths.StdioLog, Environment: environment}); err != nil {
		return r.serviceProblem(o, "install_failed", err)
	}
	health, err := svc.WaitHealthy(ctx, sys.HTTP, location.Endpoint, startWait, waitStep)
	if err != nil {
		return r.serviceProblem(o, "service_not_answering", fmt.Errorf("installed, but the service did not answer at %s within %d seconds. Run rastrata logs and rastrata doctor to see why", location.Endpoint, int(startWait.Seconds())))
	}
	summary := installed{
		Version: buildinfo.Version, Address: location.Endpoint, DataDir: location.Paths.Directory,
		Manager: manager.Name(), Unit: manager.UnitPath(), Service: health.Version,
		OwnerKey: location.Paths.OwnerKey, Warnings: append([]string{}, warnings...), StartsLogin: true,
	}
	summary.Reading, summary.SecondsLeft = readingFields(health)
	var text strings.Builder
	fmt.Fprintf(&text, "Rastrata %s is installed and running.\n\n", health.Version)
	fmt.Fprintf(&text, "  Open it:    %s   (or run: rastrata open)\n", location.Endpoint)
	fmt.Fprintf(&text, "  Your data:  %s\n", location.Paths.Directory)
	fmt.Fprintf(&text, "  It starts when you log in and restarts if it stops (%s: %s).\n", manager.Name(), shortHome(manager.UnitPath()))
	fmt.Fprintf(&text, "  The owner lock is on: the key is in %s.\n", shortHome(location.Paths.OwnerKey))
	if note := health.ReadingNote(); note != "" {
		fmt.Fprintf(&text, "  It is %s; the web app fills in when it is done.\n", note)
	}
	text.WriteString("\n")
	for _, warning := range warnings {
		fmt.Fprintf(&text, "  Warning: %s\n", warning)
	}
	fmt.Fprint(&text, "Next: rastrata doctor checks everything; rastrata status, logs, stop and start manage it.")
	r.installResult(o, summary, text.String())
	return 0
}

// ---- start and stop -----------------------------------------------------------------------

func serviceContext(r Runner, o Options) (svc.System, svc.Location, svc.Manager, int) {
	sys := systemFactory()
	location, err := sys.Locate()
	if err != nil {
		return sys, location, nil, r.serviceProblem(o, "configuration_error", err)
	}
	manager, err := sys.Manager()
	if err != nil {
		return sys, location, nil, r.serviceProblem(o, "unsupported_platform", err)
	}
	return sys, location, manager, 0
}

type serviceState struct {
	Running bool   `json:"running"`
	Address string `json:"address"`
	Version string `json:"version,omitempty"`
	Changed bool   `json:"changed"`
	// Reading is true while the service is still reading the book it started on.
	Reading     bool     `json:"reading,omitempty"`
	SecondsLeft *float64 `json:"secondsLeft,omitempty"`
}

// readingSentence is the sentence a command adds when the service it has just seen is still reading
// its book, or nothing.
func readingSentence(h svc.Health) string {
	if note := h.ReadingNote(); note != "" {
		return fmt.Sprintf(" It is %s; what needs your books waits until it is done.", note)
	}
	return ""
}

func runStart(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 1 || len(o.Flags) > 0 {
		return usageFor(r, o, "start takes no arguments or options", "start")
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	before, _ := svc.CheckHealth(ctx, sys.HTTP, location.Endpoint)
	if before.OK {
		already := serviceState{Running: true, Address: location.Endpoint, Version: before.Version}
		already.Reading, already.SecondsLeft = readingFields(before)
		r.installResult(o, already, fmt.Sprintf("Rastrata %s is already running at %s.%s", before.Version, location.Endpoint, readingSentence(before)))
		return 0
	}
	if err := manager.Start(ctx); err != nil {
		code := "start_failed"
		if errors.Is(err, svc.ErrNotInstalled) {
			code = "not_installed"
		}
		return r.serviceProblem(o, code, err)
	}
	health, err := svc.WaitHealthy(ctx, sys.HTTP, location.Endpoint, startWait, waitStep)
	if err != nil {
		return r.serviceProblem(o, "service_not_answering", fmt.Errorf("started, but the service did not answer at %s within %d seconds. Run rastrata logs and rastrata doctor to see why", location.Endpoint, int(startWait.Seconds())))
	}
	started := serviceState{Running: true, Address: location.Endpoint, Version: health.Version, Changed: true}
	started.Reading, started.SecondsLeft = readingFields(health)
	r.installResult(o, started, fmt.Sprintf("Rastrata %s is running at %s.%s", health.Version, location.Endpoint, readingSentence(health)))
	return 0
}

func runStop(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 1 || len(o.Flags) > 0 {
		return usageFor(r, o, "stop takes no arguments or options", "stop")
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	state, err := manager.Status(ctx)
	if err != nil {
		return r.serviceProblem(o, "stop_failed", err)
	}
	if !state.Loaded && !state.Running {
		_, err := svc.CheckHealth(ctx, sys.HTTP, location.Endpoint)
		if errors.Is(err, svc.ErrNotRunning) {
			r.installResult(o, serviceState{Running: false, Address: location.Endpoint}, "Rastrata is not running.")
			return 0
		}
		if err == nil {
			return r.localError(o, "service_not_managed", fmt.Sprintf("Rastrata answers at %s, but the login service is not running it: it was started some other way (by hand, or by another copy). Stop that process yourself", location.Endpoint), 3)
		}
	}
	if err := manager.Stop(ctx); err != nil {
		return r.serviceProblem(o, "stop_failed", err)
	}
	if err := svc.WaitStopped(ctx, sys.HTTP, location.Endpoint, stopWait, waitStep); err != nil {
		return r.serviceProblem(o, "stop_failed", fmt.Errorf("asked it to stop, but %w. Run rastrata logs to see what it is doing", err))
	}
	r.installResult(o, serviceState{Running: false, Address: location.Endpoint, Changed: true},
		"Rastrata is stopped. It took a last backup first, and starts again when you log in; rastrata start starts it now, rastrata uninstall removes it.")
	return 0
}

// ---- status -------------------------------------------------------------------------------

type statusReport struct {
	Version        string `json:"version"`
	Installed      bool   `json:"installed"`
	Running        bool   `json:"running"`
	Answering      bool   `json:"answering"`
	PID            int    `json:"pid,omitempty"`
	Address        string `json:"address"`
	ServiceRelease string `json:"serviceVersion,omitempty"`
	DataDirectory  string `json:"dataDirectory"`
	Manager        string `json:"manager"`
	OwnerKey       string `json:"ownerKey"`
	OwnerKeyMode   string `json:"ownerKeyMode,omitempty"`
	// Reading is true while the service is reading the book it started on (it answers, but what needs
	// the book waits); SecondsLeft is about how long is left. BookError is why it could not read it.
	Reading     bool     `json:"reading"`
	SecondsLeft *float64 `json:"secondsLeft,omitempty"`
	BookError   string   `json:"bookError,omitempty"`
}

func runStatus(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 1 || len(o.Flags) > 0 {
		return usageFor(r, o, "status takes no arguments or options", "status")
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	state, err := manager.Status(ctx)
	if err != nil {
		return r.serviceProblem(o, "status_failed", err)
	}
	health, healthErr := svc.CheckHealth(ctx, sys.HTTP, location.Endpoint)
	report := statusReport{
		Version: buildinfo.Version, Installed: state.Installed, Running: state.Running, Answering: healthErr == nil,
		PID: state.PID, Address: location.Endpoint, ServiceRelease: health.Version, DataDirectory: location.Paths.Directory,
		Manager: manager.Name(), OwnerKey: location.Paths.OwnerKey,
	}
	if info, err := os.Stat(location.Paths.OwnerKey); err == nil {
		report.OwnerKeyMode = fmt.Sprintf("%04o", info.Mode().Perm())
	}
	if healthErr == nil {
		report.Reading, report.SecondsLeft = readingFields(health)
		report.BookError, _ = health.ReadFailure()
	}
	var text strings.Builder
	switch {
	case healthErr == nil:
		fmt.Fprintf(&text, "Rastrata %s is running at %s", health.Version, location.Endpoint)
		if state.PID > 0 {
			fmt.Fprintf(&text, " (process %d)", state.PID)
		}
		text.WriteString(".\n")
		if note := health.ReadingNote(); note != "" {
			fmt.Fprintf(&text, "  It is %s; what needs your books waits until it is done.\n", note)
		}
		if report.BookError != "" {
			fmt.Fprintf(&text, "  It could not read your books: %s. rastrata doctor says what to do.\n", report.BookError)
		}
	case errors.Is(healthErr, svc.ErrOtherProgram):
		fmt.Fprintf(&text, "Another program is using port %d, so Rastrata cannot run there. rastrata doctor says more.\n", location.Port)
	case !state.Installed:
		text.WriteString("Rastrata is not installed as a login service. Run rastrata install.\n")
	case state.Running:
		fmt.Fprintf(&text, "The service is running but does not answer at %s yet. rastrata logs says what it is doing.\n", location.Endpoint)
	default:
		text.WriteString("Rastrata is installed but not running. Run rastrata start.\n")
	}
	fmt.Fprintf(&text, "  Your data:  %s\n", location.Paths.Directory)
	if report.OwnerKeyMode == "" {
		fmt.Fprintf(&text, "  Owner key:  none yet (%s); the service makes one when it first starts\n", shortHome(location.Paths.OwnerKey))
	} else {
		fmt.Fprintf(&text, "  Owner key:  %s (mode %s)\n", shortHome(location.Paths.OwnerKey), report.OwnerKeyMode)
	}
	fmt.Fprintf(&text, "  This command is %s; started by %s", buildinfo.Version, manager.Name())
	r.installResult(o, report, text.String())
	if healthErr != nil {
		return 3
	}
	return 0
}

// ---- logs ---------------------------------------------------------------------------------

func runLogs(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "logs [--lines N] [--follow] [--stdio]"
	if problem := installFlagProblem(o, []string{"lines", "follow", "stdio"}, []string{"lines"}, "follow", "stdio"); problem != "" {
		return usageFor(r, o, problem, usage)
	}
	if len(o.Args) != 1 {
		return usageFor(r, o, "logs takes no arguments", usage)
	}
	count := 50
	if value, given := o.Flags["lines"]; given {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 5000 {
			return usageFor(r, o, "--lines must be a number from 1 to 5000", usage)
		}
		count = parsed
	}
	follow := o.Flags["follow"] == "true"
	location, err := systemFactory().Locate()
	if err != nil {
		return r.serviceProblem(o, "configuration_error", err)
	}
	file := location.Paths.ServiceLog
	if o.Flags["stdio"] == "true" {
		file = location.Paths.StdioLog
	}
	lines, size, err := svc.TailLines(file, count)
	if err != nil {
		return r.serviceProblem(o, "log_unreadable", fmt.Errorf("cannot read %s: %w", file, err))
	}
	if o.FormatGiven && o.Format == "json" {
		if follow {
			return usageFor(r, o, "--follow prints lines as they come; it cannot be used with --format json", usage)
		}
		r.installResult(o, map[string]any{"file": file, "lines": append([]string{}, lines...)}, "")
		return 0
	}
	if len(lines) == 0 {
		fmt.Fprintf(r.Diagnostics, "Nothing has been logged yet in %s.\n", file)
	}
	for _, line := range lines {
		fmt.Fprintln(r.Output, line)
	}
	if follow {
		_ = svc.Follow(ctx, file, size, logStep, func(line string) { fmt.Fprintln(r.Output, line) })
	}
	return 0
}

// ---- open ---------------------------------------------------------------------------------

func runOpen(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "open [--print] [--no-start]"
	if problem := installFlagProblem(o, []string{"print", "no-start"}, nil, "print", "no-start"); problem != "" {
		return usageFor(r, o, problem, usage)
	}
	if len(o.Args) != 1 {
		return usageFor(r, o, "open takes no arguments", usage)
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	if _, err := svc.CheckHealth(ctx, sys.HTTP, location.Endpoint); err != nil {
		if o.Flags["no-start"] == "true" || o.Flags["print"] == "true" {
			return r.serviceProblem(o, "service_not_answering", fmt.Errorf("Rastrata is not answering at %s. Run rastrata start", location.Endpoint))
		}
		fmt.Fprintln(r.Diagnostics, "Rastrata is not running; starting it.")
		if err := manager.Start(ctx); err != nil {
			return r.serviceProblem(o, "start_failed", err)
		}
		if _, err := svc.WaitHealthy(ctx, sys.HTTP, location.Endpoint, startWait, waitStep); err != nil {
			return r.serviceProblem(o, "service_not_answering", fmt.Errorf("started, but the service did not answer at %s. Run rastrata logs", location.Endpoint))
		}
	}
	address := location.Endpoint + "/"
	if _, err := url.Parse(address); err != nil {
		return r.serviceProblem(o, "invalid_address", err)
	}
	if o.Flags["print"] == "true" {
		r.installResult(o, map[string]any{"address": address}, address)
		return 0
	}
	command := "open"
	if sys.GOOS != "darwin" {
		command = "xdg-open"
	}
	if out, err := sys.Runner.Run(ctx, command, address); err != nil || out.ExitCode != 0 {
		r.installResult(o, map[string]any{"address": address, "opened": false}, "Could not start a browser. Open this address yourself: "+address)
		return 0
	}
	r.installResult(o, map[string]any{"address": address, "opened": true}, "Opening "+address)
	return 0
}

// ---- doctor -------------------------------------------------------------------------------

func runDoctor(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 1 || len(o.Flags) > 0 {
		return usageFor(r, o, "doctor takes no arguments or options", "doctor")
	}
	book := o.BookID
	report := svc.Doctor{System: systemFactory(), Version: buildinfo.Version, BookID: book}.Run(ctx)
	var text strings.Builder
	fmt.Fprintf(&text, "Rastrata %s doctor\n\n", buildinfo.Version)
	for _, check := range report.Checks {
		label := map[string]string{svc.StatusOK: "ok  ", svc.StatusWarn: "WARN", svc.StatusFail: "FAIL"}[check.Status]
		fmt.Fprintf(&text, "  %s  %-15s %s\n", label, check.Name, check.Message)
		if check.Fix != "" {
			fmt.Fprintf(&text, "        %-15s -> %s\n", "", check.Fix)
		}
	}
	switch {
	case report.Failed > 0:
		fmt.Fprintf(&text, "\n%d problem(s) need attention", report.Failed)
		if report.Warnings > 0 {
			fmt.Fprintf(&text, ", and %d warning(s)", report.Warnings)
		}
		text.WriteString(".")
	case report.Warnings > 0:
		fmt.Fprintf(&text, "\nNothing is broken. %d warning(s) are worth reading.", report.Warnings)
	default:
		text.WriteString("\nEverything is as it should be.")
	}
	r.installResult(o, report, text.String())
	if report.Failed > 0 {
		return 3
	}
	return 0
}

// ---- update -------------------------------------------------------------------------------

// backupBeforeUpdate takes a backup through the running service and waits for it. An update is the
// owner's act, so it uses the owner key, never an agent token that happens to be in the environment.
// busyWait is how long the backup before an update waits, when the service says a backup is already running, before it asks again.
var busyWait = time.Second

func backupBeforeUpdate(o Options, location svc.Location) func(context.Context) error {
	return func(ctx context.Context) error {
		client, err := api.New(location.Endpoint, o.BookID, o.Directory)
		if err != nil {
			return err
		}
		if client.Credential, err = api.ReadOwnerKey(location.Paths.OwnerKey); err != nil {
			return err
		}
		id := api.NewOperationID()
		for attempt := 0; attempt < 600; attempt++ {
			response, err := client.Call(ctx, "backup.create", map[string]any{}, id)
			if err != nil {
				var failure *api.Error
				if errors.As(err, &failure) && failure.Response.Error != nil {
					switch failure.Response.Error.Code {
					case "book_not_configured":
						return nil // there is nothing to back up yet
					case "backup_busy":
						// The service takes a backup of its own when it starts and on a schedule, and one is running: wait for it, then ask for ours.
						select {
						case <-ctx.Done():
							return ctx.Err()
						case <-time.After(busyWait):
						}
						continue
					}
				}
				return err
			}
			var job jobView
			_ = json.Unmarshal(response.Data, &job)
			switch job.State {
			case "running":
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Second):
				}
			case "failed":
				if job.Error != nil {
					return errors.New(job.Error.Message)
				}
				return errors.New("the backup failed")
			default:
				return nil
			}
		}
		return errors.New("the backup did not finish in time")
	}
}

func runUpdate(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "update --from rastrata-VERSION-OS-ARCH.tar.gz [--allow-downgrade]"
	if problem := installFlagProblem(o, []string{"from", "allow-downgrade"}, []string{"from"}, "allow-downgrade"); problem != "" {
		return usageFor(r, o, problem, usage)
	}
	if len(o.Args) != 1 || o.Flags["from"] == "" {
		return usageFor(r, o, "name the package with --from", usage)
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	options := svc.UpdateOptions{
		Archive:        o.Flags["from"],
		AllowDowngrade: o.Flags["allow-downgrade"] == "true",
		Backup:         backupBeforeUpdate(o, location),
		Progress:       func(step string) { fmt.Fprintln(r.Diagnostics, step+"...") },
	}
	result, err := sys.Update(ctx, buildinfo.Version, options)
	if err != nil {
		code := "update_failed"
		if result.RolledBack {
			code = "update_rolled_back"
		}
		return r.serviceProblem(o, code, err)
	}
	text := fmt.Sprintf("Rastrata is now %s (it was %s) and running at %s.\nThe previous programs are kept as rastrata.previous and rastrata-service.previous beside them.", result.To, result.From, location.Endpoint)
	if result.To == result.From {
		text = fmt.Sprintf("Rastrata %s was installed again and is running at %s.", result.To, location.Endpoint)
	}
	r.installResult(o, result, text)
	return 0
}

// ---- uninstall ----------------------------------------------------------------------------

func runUninstall(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	if len(o.Args) != 1 || len(o.Flags) > 0 {
		return usageFor(r, o, "uninstall takes no arguments or options", "uninstall")
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	if err := manager.Uninstall(ctx); err != nil {
		return r.serviceProblem(o, "uninstall_failed", err)
	}
	removed := []string{shortHome(manager.UnitPath())}
	// The programs are removed only from an installed copy; a build run from the repository leaves
	// its own files alone.
	if buildinfo.Installed() {
		if self, err := sys.Executable(); err == nil {
			if resolved, err := filepath.EvalSymlinks(self); err == nil {
				self = resolved
			}
			directory := filepath.Dir(self)
			for _, name := range []string{"rastrata-service", "rastrata-service.previous", "rastrata.previous", filepath.Base(self)} {
				path := filepath.Join(directory, name)
				if err := os.Remove(path); err == nil {
					removed = append(removed, shortHome(path))
				}
			}
		}
	}
	data := map[string]any{"removed": removed, "dataDirectory": location.Paths.Directory, "keptBooks": true}
	r.installResult(o, data, fmt.Sprintf("Rastrata is uninstalled. Removed:\n  %s\n\nYour books and backups are still in %s. Nothing there was touched; delete that folder yourself only if you are sure you will never need them.", strings.Join(removed, "\n  "), location.Paths.Directory))
	return 0
}

// ---- backup folder ------------------------------------------------------------------------

func runBackupFolder(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "backup folder [PATH | --reset]"
	if problem := installFlagProblem(o, []string{"reset"}, nil, "reset"); problem != "" {
		return usageFor(r, o, problem, usage)
	}
	if len(o.Args) > 3 {
		return usageFor(r, o, "too many arguments", usage)
	}
	sys, location, manager, exit := serviceContext(r, o)
	if manager == nil {
		return exit
	}
	reset := o.Flags["reset"] == "true"
	var target string
	if len(o.Args) == 3 {
		target = o.Args[2]
	}
	if target == "" && !reset {
		same, known := svc.SameDevice(location.Paths.Database, location.Paths.Backups)
		note := ""
		if known && same {
			note = "\nThat is the same disk as your books. If the disk fails you lose both. " + svc.BackupFolderFix + "\nBackups are not encrypted."
		}
		r.installResult(o, map[string]any{"folder": location.Paths.Backups, "sameDisk": known && same}, "Backups are kept in "+location.Paths.Backups+"."+note)
		return 0
	}
	if reset && target != "" {
		return usageFor(r, o, "give a PATH or --reset, not both", usage)
	}
	if !reset {
		if !filepath.IsAbs(target) {
			return usageFor(r, o, fmt.Sprintf("%q is not an absolute path; write the whole path, for example /Volumes/Backup/rastrata", target), usage)
		}
		target = filepath.Clean(target)
		if err := os.MkdirAll(target, 0o700); err != nil {
			return r.serviceProblem(o, "folder_unusable", fmt.Errorf("cannot use %s: %w", target, err))
		}
		probe, err := os.CreateTemp(target, ".rastrata-write-test-")
		if err != nil {
			return r.serviceProblem(o, "folder_unusable", fmt.Errorf("cannot write to %s: %w", target, err))
		}
		probe.Close()
		_ = os.Remove(probe.Name())
	}
	if err := svc.WriteSettings(location.Paths, func(settings map[string]any) {
		if reset {
			delete(settings, "backupDir")
		} else {
			settings["backupDir"] = target
		}
	}); err != nil {
		return r.serviceProblem(o, "settings_unwritable", err)
	}
	warning := ""
	if !reset {
		if same, known := svc.SameDevice(location.Paths.Database, target); known && same {
			warning = "\nThat folder is on the same disk as your books, so it does not protect you from the disk failing."
		}
	}
	// A running service reads the folder when it starts: restart it so the change takes effect.
	restarted := false
	if state, err := manager.Status(ctx); err == nil && state.Running {
		fmt.Fprintln(r.Diagnostics, "Restarting the service so it uses the new folder...")
		if err := manager.Stop(ctx); err != nil {
			return r.serviceProblem(o, "stop_failed", err)
		}
		if err := svc.WaitStopped(ctx, sys.HTTP, location.Endpoint, stopWait, waitStep); err != nil {
			return r.serviceProblem(o, "stop_failed", err)
		}
		if err := manager.Start(ctx); err != nil {
			return r.serviceProblem(o, "start_failed", err)
		}
		if _, err := svc.WaitHealthy(ctx, sys.HTTP, location.Endpoint, startWait, waitStep); err != nil {
			return r.serviceProblem(o, "service_not_answering", err)
		}
		restarted = true
	}
	where := target
	if reset {
		where = "its default place"
	}
	r.installResult(o, map[string]any{"folder": target, "reset": reset, "restarted": restarted},
		fmt.Sprintf("New backups go to %s. Backups already made stay where they are: copy them over yourself if you want them together.%s", where, warning))
	return 0
}

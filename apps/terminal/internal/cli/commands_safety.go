package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
	svc "github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

// The safety lane's commands: backups, the restore drill, restore, and the open export.
//
//	rastrata backup status | list                      read how safe the book is, and the backups
//	rastrata backup create | verify [ID] | drill [ID]  long jobs: they report progress and wait
//	rastrata backup configure --input settings.json    automatic backup settings (owner only)
//	rastrata export create | list                      the open export, rastrata-export-v1
//	rastrata restore BACKUP --to PATH [--replace]      offline: put a verified backup in place
//	rastrata import-export DIR --to PATH               offline: rebuild a book from an export
//	rastrata export verify DIR                         offline: check an export's files
//
// A long job (a backup, a verification, a drill, an export) is asked for with one operation
// identity and asked about again with the same one until it is done, so an interrupted command
// resumes the same job instead of starting another. The offline commands work on files and need no
// service; they run the same code the service does, through the tool in apps/api (set
// RASTRATA_TOOL to a command that starts it).
func init() {
	RegisterAlias("backup status", "backup.status")
	RegisterAlias("backup list", "backup.list")
	RegisterAlias("backup configure", "backup.configure")
	RegisterAlias("export list", "export.list")
	Register(Command{Name: "backup create", Summary: "Take a snapshot of the whole book now and wait for it [--operation-id UUID]", Run: runBackupCreate})
	Register(Command{Name: "backup verify", Summary: "Verify the newest backup (or BACKUP_ID) on a copy: hash, integrity, a full replay; shows progress and takes longer for a bigger book", Run: runBackupVerify})
	Register(Command{Name: "backup drill", Summary: "Restore the newest backup (or BACKUP_ID) to a temporary directory and compare it with the live book; the book is not changed", Run: runBackupDrill})
	Register(Command{Name: "export create", Summary: "Write the open export (rastrata-export-v1) of the whole book and wait for it", Run: runExportCreate})
	Register(Command{Name: "export verify", Summary: "Check an export folder against its manifest and hashes, offline: export verify DIR", Offline: true, Local: true, Run: runExportVerify})
	Register(Command{Name: "restore", Summary: "Restore a backup to a database file, offline, after verifying it: restore BACKUP --to PATH [--replace] [--no-manifest] [--quick] [--backup-dir DIR]", Offline: true, Local: true, Run: runRestore})
	Register(Command{Name: "import-export", Summary: "Rebuild a book from an export by replay, offline, and prove it by head hash: import-export DIR --to PATH", Offline: true, Local: true, Run: runImportExport})
}

func safetyFlagProblem(o Options, allowed, valued []string) string {
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
			return "--" + name + " needs a value; write the options after the arguments, as --name VALUE or --name=VALUE"
		}
	}
	return ""
}

// jobView is what a long operation returns while it runs and when it ends.
type jobView struct {
	State       string `json:"state"`
	Kind        string `json:"kind"`
	Stage       string `json:"stage"`
	Done        *int   `json:"done"`
	Total       *int   `json:"total"`
	ElapsedMs   int64  `json:"elapsedMs"`
	RemainingMs *int64 `json:"remainingMs"`
	Error       *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Verification *struct {
		Passed bool `json:"passed"`
	} `json:"verification"`
	Drill *struct {
		Passed bool `json:"passed"`
	} `json:"drill"`
}

func progressLine(job jobView) string {
	line := job.Stage
	if job.Done != nil && job.Total != nil && *job.Total > 0 {
		line += fmt.Sprintf(": %d of %d (%d%%)", *job.Done, *job.Total, *job.Done*100 / *job.Total)
	}
	if job.RemainingMs != nil {
		line += fmt.Sprintf(", about %d s left (an estimate)", (*job.RemainingMs+500)/1000)
	}
	return line
}

// runJob asks for a long operation and keeps asking, with the same identity, until it is done.
// Progress goes to stderr; the final answer is the usual envelope on stdout. Exit codes: 0 done
// (and, for a verification or a drill, passed), 3 the job failed or the check did not pass, 5 the
// wait was interrupted (the job carries on in the service; run the command again to resume it).
func runJob(r Runner, ctx context.Context, o Options, c *api.Client, operation string, input map[string]any) int {
	operationID := o.OperationID
	if operationID == "" {
		operationID = api.NewOperationID()
	}
	fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; ask again with --operation-id %s to resume it.\n", operationID, operation, operationID)
	last := ""
	for {
		response, err := c.Call(ctx, operation, input, operationID)
		if err != nil {
			return r.result(o, response, err, "")
		}
		var job jobView
		_ = json.Unmarshal(response.Data, &job)
		if job.State != "running" {
			exit := r.result(o, response, nil, "")
			failed := job.State == "failed" ||
				(job.Verification != nil && !job.Verification.Passed) ||
				(job.Drill != nil && !job.Drill.Passed)
			if exit == 0 && failed {
				return 3
			}
			return exit
		}
		if line := progressLine(job); line != last {
			fmt.Fprintln(r.Diagnostics, line)
			last = line
		}
		select {
		case <-ctx.Done():
			fmt.Fprintf(r.Diagnostics, "Stopped waiting. The job is still running in the service; run the same command with --operation-id %s to resume it.\n", operationID)
			return 5
		case <-time.After(time.Second):
		}
	}
}

func jobTarget(r Runner, o Options, usage string, allowed ...string) (map[string]any, int, bool) {
	if problem := safetyFlagProblem(o, allowed, nil); problem != "" {
		return nil, r.localError(o, "usage_error", problem+". Use "+usage, 2), false
	}
	input := map[string]any{}
	if len(o.Args) == 3 {
		input["backupId"] = o.Args[2]
	} else if len(o.Args) != 2 {
		return nil, r.localError(o, "usage_error", "Use "+usage, 2), false
	}
	return input, 0, true
}

func runBackupCreate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 || len(o.Flags) > 0 {
		return r.localError(o, "usage_error", "Use backup create", 2)
	}
	return runJob(r, ctx, o, c, "backup.create", map[string]any{})
}

func runBackupVerify(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, exit, ok := jobTarget(r, o, "backup verify [BACKUP_ID]")
	if !ok {
		return exit
	}
	return runJob(r, ctx, o, c, "backup.verify", input)
}

func runBackupDrill(r Runner, ctx context.Context, o Options, c *api.Client) int {
	input, exit, ok := jobTarget(r, o, "backup drill [BACKUP_ID]")
	if !ok {
		return exit
	}
	return runJob(r, ctx, o, c, "backup.drill", input)
}

func runExportCreate(r Runner, ctx context.Context, o Options, c *api.Client) int {
	if len(o.Args) != 2 || len(o.Flags) > 0 {
		return r.localError(o, "usage_error", "Use export create", 2)
	}
	return runJob(r, ctx, o, c, "export.create", map[string]any{})
}

// toolCommand finds the command that runs the offline tool: RASTRATA_TOOL (a command line, split on
// spaces), the rastrata-service beside this program (an installed copy), or `bun apps/api/src/tool.ts`
// of the repository this program is in or is run from.
func toolCommand() ([]string, error) {
	if value := strings.Fields(os.Getenv("RASTRATA_TOOL")); len(value) > 0 {
		return value, nil
	}
	// An installed copy: the service executable beside this program runs the tool as `tool ...`, so
	// restore needs no Bun and no repository.
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		beside := filepath.Join(filepath.Dir(executable), "rastrata-service")
		if info, err := os.Stat(beside); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return []string{beside, "tool"}, nil
		}
	}
	bun := os.Getenv("BUN_BIN")
	if bun == "" {
		found, err := exec.LookPath("bun")
		if err != nil {
			return nil, fmt.Errorf("the offline tool needs Bun on the PATH (or RASTRATA_TOOL set to a command that runs apps/api/src/tool.ts)")
		}
		bun = found
	}
	starts := []string{}
	if executable, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(executable))
	}
	if directory, err := os.Getwd(); err == nil {
		starts = append(starts, directory)
	}
	for _, start := range starts {
		for directory := start; ; directory = filepath.Dir(directory) {
			script := filepath.Join(directory, "apps", "api", "src", "tool.ts")
			if _, err := os.Stat(script); err == nil {
				return []string{bun, script}, nil
			}
			if filepath.Dir(directory) == directory {
				break
			}
		}
	}
	return nil, fmt.Errorf("cannot find the offline tool (apps/api/src/tool.ts). Run this from the repository, or set RASTRATA_TOOL to a command that runs it")
}

// runTool runs the offline tool with the given arguments. Its stderr is progress, its stdout the
// JSON envelope, and its exit code is ours: 0 done, 2 usage, 3 refused or failed verification, 4
// failed.
func runTool(r Runner, ctx context.Context, o Options, args []string) int {
	argv, err := toolCommand()
	if err != nil {
		return r.localError(o, "tool_unavailable", err.Error(), 4)
	}
	command := exec.CommandContext(ctx, argv[0], append(argv[1:], args...)...)
	command.Stdout = r.Output
	command.Stderr = r.Diagnostics
	command.Stdin = nil
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		return r.localError(o, "tool_failed", err.Error(), 4)
	}
	return 0
}

func runRestore(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	usage := "restore BACKUP --to PATH [--replace] [--no-manifest] [--quick] [--backup-dir DIR] (BACKUP is a backup file, its manifest, a backup id or latest; write the options after it)"
	if buildinfo.Installed() {
		usage = "restore BACKUP [--replace] [--no-manifest] [--quick] [--to PATH] [--backup-dir DIR] (BACKUP is a backup file, its manifest, a backup id or latest; the book and the backups are the installed ones unless you say otherwise; stop the service first)"
	}
	if problem := safetyFlagProblem(o, []string{"to", "replace", "no-manifest", "quick", "backup-dir"}, []string{"to", "backup-dir"}); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+usage, 2)
	}
	to, backupDir := o.Flags["to"], o.Flags["backup-dir"]
	if len(o.Args) != 2 || (to == "" && !buildinfo.Installed()) {
		return r.localError(o, "usage_error", "Use "+usage, 2)
	}
	if buildinfo.Installed() {
		sys := systemFactory()
		location, err := sys.Locate()
		if err != nil {
			return r.serviceProblem(o, "configuration_error", err)
		}
		if to == "" {
			to = location.Paths.Database
		}
		if backupDir == "" {
			backupDir = location.Paths.Backups
		}
		// Restoring replaces the book's files: not while the service has them open.
		if to == location.Paths.Database {
			if _, err := svc.CheckHealth(ctx, sys.HTTP, location.Endpoint); err == nil {
				return r.localError(o, "service_running", "Rastrata is running, so its book is in use. Stop it first (rastrata stop), then restore, then rastrata start", 3)
			}
		}
	}
	args := []string{"restore", o.Args[1], "--to", to}
	for _, name := range []string{"replace", "no-manifest", "quick"} {
		if o.Flags[name] == "true" {
			args = append(args, "--"+name)
		} else if value, given := o.Flags[name]; given && value != "false" {
			return r.localError(o, "usage_error", "--"+name+" takes no value. Use "+usage, 2)
		}
	}
	if backupDir != "" {
		args = append(args, "--backup-dir", backupDir)
	}
	return runTool(r, ctx, o, args)
}

func runImportExport(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "import-export DIR --to PATH (a new database path; an existing database is never overwritten)"
	if problem := safetyFlagProblem(o, []string{"to"}, []string{"to"}); problem != "" {
		return r.localError(o, "usage_error", problem+". Use "+usage, 2)
	}
	if len(o.Args) != 2 || o.Flags["to"] == "" {
		return r.localError(o, "usage_error", "Use "+usage, 2)
	}
	return runTool(r, ctx, o, []string{"import-export", o.Args[1], "--to", o.Flags["to"]})
}

func runExportVerify(r Runner, ctx context.Context, o Options, _ *api.Client) int {
	const usage = "export verify DIR"
	if len(o.Flags) > 0 || len(o.Args) != 3 {
		return r.localError(o, "usage_error", "Use "+usage, 2)
	}
	return runTool(r, ctx, o, []string{"check-export", o.Args[2]})
}

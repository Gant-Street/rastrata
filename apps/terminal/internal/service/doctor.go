package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// Statuses of a check.
const (
	StatusOK   = "ok"
	StatusWarn = "warn"
	StatusFail = "fail"
)

// Check is one thing doctor looked at.
type Check struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Message string `json:"message"`
	// Fix is what to do about a warning or a failure, as one command or one sentence.
	Fix string `json:"fix,omitempty"`
}

// Report is everything doctor found.
type Report struct {
	Checks   []Check `json:"checks"`
	Failed   int     `json:"failed"`
	Warnings int     `json:"warnings"`
}

// Healthy is true when nothing failed; warnings are advice.
func (r Report) Healthy() bool { return r.Failed == 0 }

func (r *Report) add(checks ...Check) {
	for _, check := range checks {
		switch check.Status {
		case StatusFail:
			r.Failed++
		case StatusWarn:
			r.Warnings++
		}
		r.Checks = append(r.Checks, check)
	}
}

func ok(name, message string) Check { return Check{Name: name, Status: StatusOK, Message: message} }
func warn(name, message, fix string) Check {
	return Check{Name: name, Status: StatusWarn, Message: message, Fix: fix}
}
func fail(name, message, fix string) Check {
	return Check{Name: name, Status: StatusFail, Message: message, Fix: fix}
}

// Doctor looks at an installed service and says what is wrong and what to do. It reads and asks; it
// changes nothing, and it never prints the owner key (only whether there is one and who can read it).
type Doctor struct {
	System  System
	Version string
	// BookID is the book the API is asked about; "local-book" unless told otherwise.
	BookID string
}

const (
	lowSpace  = 50 << 20  // below this, backups and the book itself are at risk
	thinSpace = 500 << 20 // below this (or five times the book), warn
)

// Run does every check.
func (d Doctor) Run(ctx context.Context) Report {
	var report Report
	location, err := d.System.Locate()
	if err != nil {
		report.add(fail("Settings", err.Error(), "Fix the setting it names, then run rastrata doctor again."))
		return report
	}
	manager, managerErr := d.System.Manager()
	var state State
	if managerErr == nil {
		state, managerErr = manager.Status(ctx)
	}
	health, healthErr := CheckHealth(ctx, d.System.HTTP, location.Endpoint)

	report.add(d.serviceCheck(manager, state, managerErr, healthErr))
	report.add(d.answerCheck(location, state, health, healthErr))
	report.add(d.versionCheck(ctx, health, healthErr))
	report.add(d.bookChecks(health, healthErr)...)
	report.add(d.environmentChecks(location)...)
	report.add(d.dataCheck(location)...)
	lockChecks, key := d.lockChecks(ctx, location, healthErr == nil)
	report.add(lockChecks...)
	backups, replay := d.backupChecks(ctx, location, healthErr == nil, key)
	report.add(backups...)
	// The capacity is asked of a service that has read its book: while it is still reading, the question
	// would wait for the read, and if it could not read, it has no answer (the Book check says why).
	_, unreadable := health.ReadFailure()
	report.add(d.capacityChecks(ctx, location, healthErr == nil && !health.Reading() && !unreadable, key, replay)...)
	return report
}

func (d Doctor) serviceCheck(manager Manager, state State, err error, healthErr error) Check {
	switch {
	case manager == nil && err != nil:
		return fail("Login item", err.Error(), "")
	case err != nil:
		return fail("Login item", err.Error(), "Run rastrata install again.")
	case !state.Installed:
		return fail("Login item", fmt.Sprintf("Rastrata is not set to start at login (no %s).", manager.UnitPath()), "Run rastrata install.")
	case !state.Loaded:
		return fail("Login item", fmt.Sprintf("%s has the service installed but not loaded, so it is not running.", manager.Name()), "Run rastrata start.")
	case !state.Running:
		return fail("Login item", fmt.Sprintf("%s has the service loaded but it is not running (%s).", manager.Name(), state.Detail), "Run rastrata start, then rastrata logs to see why it stopped.")
	}
	where := "running"
	if state.PID > 0 {
		where = fmt.Sprintf("running as process %d", state.PID)
	}
	if healthErr != nil {
		where += ", but it does not answer yet"
	}
	return ok("Login item", fmt.Sprintf("Started at login by %s; %s.", manager.Name(), where))
}

func (d Doctor) answerCheck(location Location, state State, health Health, err error) Check {
	switch {
	case err == nil:
		return ok("Answers", fmt.Sprintf("Rastrata %s answers at %s.", health.Version, location.Endpoint))
	case errors.Is(err, ErrOtherProgram):
		return fail("Answers", fmt.Sprintf("Another program is using port %d, so Rastrata cannot answer there.", location.Port),
			fmt.Sprintf("Choose another port for Rastrata: rastrata install --port %d", location.Port+1))
	case state.Running:
		return fail("Answers", fmt.Sprintf("The service is running but nothing answers at %s.", location.Endpoint), "Run rastrata logs to see what it says.")
	}
	return fail("Answers", fmt.Sprintf("Nothing is listening at %s.", location.Endpoint), "Run rastrata start.")
}

func (d Doctor) versionCheck(ctx context.Context, health Health, healthErr error) Check {
	executable, err := d.System.ServiceExecutable()
	if err != nil {
		return fail("Version", err.Error(), "Install the package again.")
	}
	installed, err := d.System.ExecutableVersion(ctx, executable)
	if err != nil {
		return fail("Version", fmt.Sprintf("rastrata-service does not run: %v", err), "Install the package again.")
	}
	switch {
	case installed != d.Version:
		return warn("Version", fmt.Sprintf("This command is %s but the installed service program is %s.", d.Version, installed), "Install the package again, or run rastrata update --from the newer package.")
	case healthErr == nil && health.Version != installed:
		return warn("Version", fmt.Sprintf("The running service is %s but the installed program is %s: it was updated and not restarted.", health.Version, installed), "Run rastrata stop, then rastrata start.")
	}
	return ok("Version", fmt.Sprintf("Rastrata %s: the command, the installed service and the running service agree.", installed))
}

// bookChecks says whether the service has read the book it started on. It reads it once each time it
// starts, so that the first page a person opens does not wait for it; until it has finished, whatever
// needs the book waits, and if it could not read it, whatever needs the book fails. A service that
// does not report this (an older one) gets no row.
func (d Doctor) bookChecks(health Health, healthErr error) []Check {
	if healthErr != nil || health.Warmup == nil {
		return nil
	}
	if message, failed := health.ReadFailure(); failed {
		return []Check{fail("Book", fmt.Sprintf("The service is up but could not read your books: %s. Nothing was changed, and anything that needs the book will fail until this is fixed.", message),
			"Run rastrata logs for the details. If the book itself is damaged, restore the newest verified backup: rastrata stop, then rastrata restore latest --replace, then rastrata start.")}
	}
	warmup := health.Warmup
	if health.Reading() {
		progress := ""
		if warmup.Done != nil && warmup.Total != nil && *warmup.Total > 0 {
			progress = fmt.Sprintf(" (%s of %s entries)", thousands(*warmup.Done), thousands(*warmup.Total))
		}
		left := "It is not known yet how long it will take"
		if warmup.SecondsLeft != nil {
			left = "About " + strings.TrimPrefix(about(*warmup.SecondsLeft), "about ") + " to go"
			if *warmup.SecondsLeft < 5 {
				left = "It is almost done"
			}
		}
		return []Check{warn("Book", fmt.Sprintf("The service is up and is still reading your books%s. %s. It does this once each time it starts, and whatever needs the book waits until it is done.", progress, left),
			"Wait, then run rastrata doctor again.")}
	}
	if warmup.State == "ready" && warmup.Entries > 0 {
		return []Check{ok("Book", fmt.Sprintf("Read at start-up: %s in %s.", entriesWords(warmup.Entries), tookWords(warmup.Seconds)))}
	}
	return nil
}

func entriesWords(entries int64) string {
	if entries == 1 {
		return "1 entry"
	}
	return thousands(entries) + " entries"
}

// tookWords says how long something that has happened took.
func tookWords(seconds float64) string {
	switch {
	case seconds < 1:
		return "under a second"
	case seconds < 2:
		return "a second"
	case seconds < 120:
		return fmt.Sprintf("%d seconds", int(math.Round(seconds)))
	}
	return fmt.Sprintf("%d minutes", int(math.Round(seconds/60)))
}

// environmentChecks looks for variables that make the command line talk to something other than
// the installed service: a developer's shell often has them set, and they win over the defaults.
func (d Doctor) environmentChecks(location Location) []Check {
	var checks []Check
	env := d.System.Getenv
	if url := strings.TrimRight(strings.TrimSpace(env("RASTRATA_API_URL")), "/"); url != "" && url != location.Endpoint {
		checks = append(checks, warn("Environment", fmt.Sprintf("RASTRATA_API_URL is set to %s, so the rastrata command talks to that instead of the installed service at %s.", url, location.Endpoint), "Unset RASTRATA_API_URL to use the installed service."))
	}
	if path := strings.TrimSpace(env("RASTRATA_OWNER_KEY_FILE")); path != "" && path != location.Paths.OwnerKey {
		checks = append(checks, warn("Environment", fmt.Sprintf("RASTRATA_OWNER_KEY_FILE names %s, not the installed service's key at %s.", path, location.Paths.OwnerKey), "Unset RASTRATA_OWNER_KEY_FILE to use the installed service."))
	}
	if strings.TrimSpace(env("RASTRATA_TOKEN")) != "" {
		checks = append(checks, warn("Environment", "RASTRATA_TOKEN is set, so the rastrata command acts as that agent token and not as the owner; it can only do what the token allows.", "Unset RASTRATA_TOKEN to act as the owner."))
	}
	return checks
}

func gigabytes(bytes uint64) string {
	if bytes >= 1<<30 {
		return fmt.Sprintf("%.1f GB", float64(bytes)/(1<<30))
	}
	return fmt.Sprintf("%d MB", bytes>>20)
}

func (d Doctor) dataCheck(location Location) []Check {
	paths := location.Paths
	info, err := os.Stat(paths.Directory)
	if err != nil {
		return []Check{fail("Data directory", fmt.Sprintf("%s does not exist.", paths.Directory), "Run rastrata install; it is made private to you (mode 700).")}
	}
	var checks []Check
	var problems []string
	status, fix := StatusOK, ""
	if !info.IsDir() {
		return []Check{fail("Data directory", paths.Directory+" is not a directory.", "Move it aside and run rastrata install.")}
	}
	if owned, known := OwnedBy(paths.Directory, d.System.UID); known && !owned {
		status, fix = StatusFail, "Move your books to a directory you own and set RASTRATA_DATA_DIR to it."
		problems = append(problems, "it belongs to another user")
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		if status == StatusOK {
			status, fix = StatusWarn, fmt.Sprintf("chmod 700 '%s'", paths.Directory)
		}
		problems = append(problems, fmt.Sprintf("other users can open it (mode %04o)", mode))
	}
	message := fmt.Sprintf("%s, private to you (mode %04o).", paths.Directory, info.Mode().Perm())
	if len(problems) > 0 {
		message = fmt.Sprintf("%s: %s.", paths.Directory, strings.Join(problems, "; "))
	}
	checks = append(checks, Check{Name: "Data directory", Status: status, Message: message, Fix: fix})

	var bookSize uint64
	if book, err := os.Stat(paths.Database); err == nil {
		bookSize = uint64(book.Size())
	}
	if free, known := FreeBytes(paths.Directory); known {
		need := max(uint64(thinSpace), 5*bookSize)
		switch {
		case free < lowSpace:
			checks = append(checks, fail("Free space", fmt.Sprintf("Only %s is free where your books are. Backups and the book itself are at risk.", gigabytes(free)), "Free some space now."))
		case free < need:
			checks = append(checks, warn("Free space", fmt.Sprintf("%s is free where your books are (the book is %s).", gigabytes(free), gigabytes(bookSize)), "Free some space; backups need room too."))
		default:
			checks = append(checks, ok("Free space", fmt.Sprintf("%s free (the book is %s).", gigabytes(free), gigabytes(bookSize))))
		}
	}
	return checks
}

// post asks the service an operation, with the owner key if there is one.
func (d Doctor) post(ctx context.Context, endpoint, operation, key string) (int, []byte, error) {
	book := d.BookID
	if book == "" {
		book = "local-book"
	}
	body, _ := json.Marshal(map[string]any{"version": api.Version, "bookId": book, "input": map[string]any{}})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1/"+operation, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("content-type", "application/json")
	if key != "" {
		request.Header.Set("authorization", "Bearer "+key)
	}
	response, err := d.System.HTTP.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, data, err
}

// lockChecks says whether the owner lock is on and whether the key file is as private as it must
// be. It returns the key (never printed) for the checks that ask the service something.
func (d Doctor) lockChecks(ctx context.Context, location Location, answering bool) ([]Check, string) {
	path := location.Paths.OwnerKey
	info, err := os.Stat(path)
	if err != nil {
		return []Check{fail("Owner lock", fmt.Sprintf("There is no owner key at %s. The service makes one the first time it starts.", path), "Run rastrata start.")}, ""
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return []Check{fail("Owner lock", fmt.Sprintf("The owner key file %s can be read by other users (mode %04o), so the lock protects nothing.", path, mode),
			fmt.Sprintf("chmod 600 '%s'", path))}, ""
	}
	key, err := api.ReadOwnerKey(path)
	if err != nil {
		return []Check{fail("Owner lock", fmt.Sprintf("The file at %s is not a Rastrata owner key.", path), "Move it aside and run rastrata stop, then rastrata start: the service makes a new key.")}, ""
	}
	present := fmt.Sprintf("Owner key present, mode %04o, readable only by you.", info.Mode().Perm())
	if !answering {
		return []Check{ok("Owner lock", present+" The service is not answering, so the lock itself could not be tested.")}, key
	}
	bare, _, err := d.post(ctx, location.Endpoint, "book.get", "")
	switch {
	case err != nil:
		return []Check{warn("Owner lock", present+" The service did not answer the lock test.", "Run rastrata logs.")}, key
	case bare == http.StatusOK:
		return []Check{fail("Owner lock", "The service is OPEN: a request with no credentials was accepted, so any program on this computer can use your books.", "Run rastrata stop, then rastrata start. If it is still open, check that the service is the one from this package.")}, key
	case bare != http.StatusUnauthorized:
		return []Check{warn("Owner lock", fmt.Sprintf("%s A request with no credentials was answered with status %d, not refused with 401.", present, bare), "Run rastrata logs.")}, key
	}
	withKey, _, err := d.post(ctx, location.Endpoint, "book.get", key)
	switch {
	case err == nil && withKey == http.StatusOK:
		return []Check{ok("Owner lock", present+" Requests with no credentials are refused; the key is accepted.")}, key
	case err == nil && withKey == http.StatusUnauthorized:
		return []Check{fail("Owner lock", "The key in "+path+" is not the one the running service uses.", "Run rastrata stop, then rastrata start.")}, ""
	}
	return []Check{warn("Owner lock", present+" The service did not answer when the key was used.", "Run rastrata logs.")}, key
}

// verifiedBackup is the newest verified backup in backup.status. Its head's sequence is the number of
// entries the verification replayed, and ReplayMs is how long that took on this computer.
type verifiedBackup struct {
	Head *struct {
		Sequence string `json:"sequence"`
	} `json:"head"`
	Verification *struct {
		VerifiedAt string `json:"verifiedAt"`
		ReplayMs   *int64 `json:"replayMs"`
	} `json:"verification"`
}

// backupSummary is the part of backup.status that doctor reads.
type backupSummary struct {
	OK   bool `json:"ok"`
	Data struct {
		Directory string `json:"directory"`
		Settings  struct {
			WarnAfterHours int `json:"warnAfterHours"`
		} `json:"settings"`
		LatestVerified *verifiedBackup `json:"latestVerified"`
		BackupCount    int             `json:"backupCount"`
		Warnings       []struct {
			Code    string `json:"code"`
			Tone    string `json:"tone"`
			Message string `json:"message"`
		} `json:"warnings"`
	} `json:"data"`
}

func ago(now, then time.Time) string {
	age := now.Sub(then)
	switch {
	case age < 0:
		return "just now"
	case age < 90*time.Minute:
		return fmt.Sprintf("%d minutes ago", int(age.Minutes()))
	case age < 48*time.Hour:
		return fmt.Sprintf("%d hours ago", int(age.Hours()))
	}
	return fmt.Sprintf("%d days ago", int(age.Hours()/24))
}

// BackupFolderFix is the one line that moves the backups to another drive.
const BackupFolderFix = "Keep them on another drive you trust: rastrata backup folder /Volumes/Backup/rastrata"

// backupAdvice is what to do about each warning the service gives about its backups.
var backupAdvice = map[string]string{
	"never_backed_up":     "Run rastrata backup create, then rastrata backup verify.",
	"backup_file_missing": "Run rastrata backup create.",
	"verification_failed": "Run rastrata backup create, then rastrata backup verify.",
	"backup_ahead":        "Check which copy is right before relying on either.",
	"never_verified":      "Run rastrata backup verify.",
	"stale_verification":  "Run rastrata backup verify.",
	"automatic_failed":    "Run rastrata logs to see why, then rastrata backup create.",
	"automatic_off":       "Turn them on from the Backups screen.",
	"drill_failed":        "Run rastrata backup drill and read the checks.",
	"same_disk":           BackupFolderFix,
}

const sameDiskNote = " Backups are not encrypted: anyone who can read that folder can read your books."

// backupChecks also returns the replay the newest verified backup timed, when the service says so: the
// one measurement of how fast this computer reads a book, which the capacity check scales.
func (d Doctor) backupChecks(ctx context.Context, location Location, answering bool, key string) ([]Check, *Replay) {
	if answering && key != "" {
		if checks, replay := d.backupStatus(ctx, location, key); checks != nil {
			return checks, replay
		}
	}
	// The service cannot be asked: look at the folder, and at which disk it is on.
	checks := []Check{d.backupFiles(location)}
	if same, known := SameDevice(location.Paths.Database, location.Paths.Backups); known && same {
		checks = append(checks, warn("Backup place",
			fmt.Sprintf("Backups are kept on the same disk as your books (%s). If the disk fails you lose both.%s", location.Paths.Backups, sameDiskNote), BackupFolderFix))
	}
	return checks, nil
}

// backupFiles is the look at backups when the service cannot be asked: the newest file in the folder.
func (d Doctor) backupFiles(location Location) Check {
	entries, err := os.ReadDir(location.Paths.Backups)
	var newest time.Time
	if err == nil {
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".manifest.json") {
				if info, err := entry.Info(); err == nil && info.ModTime().After(newest) {
					newest = info.ModTime()
				}
			}
		}
	}
	if newest.IsZero() {
		return warn("Backups", fmt.Sprintf("No backup found in %s, and the service is not answering to ask.", location.Paths.Backups), "Start the service; once your books are set up it backs up by itself.")
	}
	return warn("Backups", fmt.Sprintf("The newest backup in %s is from %s. The service is not answering, so whether it passed verification is not known.", location.Paths.Backups, ago(d.System.Now(), newest)), "Run rastrata start, then rastrata doctor again.")
}

// backupStatus asks the service how its backups are. It returns nil when the service cannot say, so
// that the caller falls back to looking at the folder.
func (d Doctor) backupStatus(ctx context.Context, location Location, key string) ([]Check, *Replay) {
	now := d.System.Now()
	status, bookBody, err := d.post(ctx, location.Endpoint, "book.get", key)
	if err != nil || status != http.StatusOK {
		return nil, nil
	}
	var book struct {
		Data struct {
			Setup json.RawMessage `json:"setup"`
		} `json:"data"`
	}
	if json.Unmarshal(bookBody, &book) == nil && (len(book.Data.Setup) == 0 || string(book.Data.Setup) == "null") {
		return []Check{ok("Backups", "There is nothing to back up until you set up your books. Backups start by themselves after that.")}, nil
	}
	status, body, err := d.post(ctx, location.Endpoint, "backup.status", key)
	var summary backupSummary
	if err != nil || status != http.StatusOK || json.Unmarshal(body, &summary) != nil || !summary.OK {
		return nil, nil
	}
	data := summary.Data
	var checks []Check
	flagged := map[string]bool{}
	for _, warning := range data.Warnings {
		flagged[warning.Code] = true
		message, advice := oneLine(warning.Message), backupAdvice[warning.Code]
		switch {
		case warning.Code == "same_disk":
			checks = append(checks, warn("Backup place", message+sameDiskNote, advice))
		case warning.Tone == "error":
			checks = append(checks, fail("Backups", message, advice))
		case warning.Tone == "review":
			checks = append(checks, warn("Backups", message, advice))
		}
	}
	// The service says when the backups are on the book's own disk; look too, in case it did not.
	if same, known := SameDevice(location.Paths.Database, data.Directory); !flagged["same_disk"] && known && same {
		checks = append(checks, warn("Backup place",
			fmt.Sprintf("Backups are kept on the same disk as your books (%s). If the disk fails you lose both.%s", data.Directory, sameDiskNote), BackupFolderFix))
	}
	// When nothing is wrong with the newest verified backup, say how old it is.
	if verified := data.LatestVerified; verified != nil && verified.Verification != nil && !flagged["stale_verification"] && !flagged["verification_failed"] {
		if at, err := time.Parse(time.RFC3339, verified.Verification.VerifiedAt); err == nil {
			checks = append([]Check{ok("Backups", fmt.Sprintf("The newest verified backup is from %s (%d kept in %s).", ago(now, at), data.BackupCount, data.Directory))}, checks...)
		}
	}
	if len(checks) == 0 {
		checks = append(checks, ok("Backups", fmt.Sprintf("%d backups in %s.", data.BackupCount, data.Directory)))
	}
	return checks, replayOf(data.LatestVerified)
}

// replayOf is the replay the newest verified backup timed, if it says.
func replayOf(verified *verifiedBackup) *Replay {
	if verified == nil || verified.Head == nil || verified.Verification == nil || verified.Verification.ReplayMs == nil {
		return nil
	}
	entries, err := strconv.ParseInt(verified.Head.Sequence, 10, 64)
	if err != nil || entries <= 0 || *verified.Verification.ReplayMs <= 0 {
		return nil
	}
	return &Replay{Entries: entries, Seconds: float64(*verified.Verification.ReplayMs) / 1000}
}

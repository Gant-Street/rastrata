package service_test

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

// A book made with the chain-head state commitment reads back in linear time: a millisecond an entry, so a
// restart is information (what the snapshot is, what a restart costs) and a warning only when it would
// take a minute. A legacy book, made without it, keeps the warnings of the first version of this check
// and is told once that books made now are faster. These tests are the doctor's side of
// docs/reference/program/scale/scaleestimates.md.

// kindBody is what GET /api/capacity says of a book of a kind: the figures the service itself gives for
// it (here the rule of thumb, as the service computes it).
func kindBody(kind string, journals int, outcomes, snapshotBytes, snapshotSequence int64, fromStart, restart float64) string {
	snapshot := "null"
	if snapshotBytes > 0 {
		snapshot = fmt.Sprintf(`{"bytes":%d,"sequence":%d}`, snapshotBytes, snapshotSequence)
	}
	replay := "linear"
	if kind == "legacy" {
		replay = "quadratic"
	}
	return fmt.Sprintf(`{"configured":true,"journals":%d,"outcomes":%d,"ceilingBytes":%d,"snapshot":%s,"commitment":%q,"replay":%q,"fromStartSeconds":%g,"restartSeconds":%g}`,
		journals, outcomes, ceiling, snapshot, kind, replay, fromStart, restart)
}

// baselineWarnings is how many warnings doctor gives a world with no capacity row at all (the stand-in
// disk is the backups' disk, and so on), so that a test can say that the capacity check added none.
func baselineWarnings(t *testing.T) int {
	t.Helper()
	return newWorld(t).doctor().Warnings
}

// chainHead is a chain-head book of this many journals (and one more entry, the activation) whose newest
// snapshot is snapshotBytes long and was saved at entry snapshotSequence (0 bytes: none).
func chainHead(journals int, snapshotBytes, snapshotSequence int64) string {
	return kindBody("chain-head", journals, int64(journals)+1, snapshotBytes, snapshotSequence, 0, 0)
}

func TestDoctorIsQuietAboutAChainHeadBookAtTheFoundersSize(t *testing.T) {
	w := newWorld(t)
	// 750 journals once their year is imported: a 7.4 MB snapshot, current.
	w.setCapacity(chainHead(750, 7_760_000, 751))
	report := w.doctor()
	check := only(t, report, "Capacity")
	if check.Status != service.StatusOK || check.Fix != "" || report.Warnings != baselineWarnings(t) {
		t.Fatalf("a new book of the founder's size is not a warning: %+v (warnings %d)", check, report.Warnings)
	}
	for _, want := range []string{"750 journals", "The saved snapshot is 7.4 MB", "a restart takes a few seconds"} {
		if !strings.Contains(check.Message, want) {
			t.Errorf("%q is not in %q", want, check.Message)
		}
	}
	// It is not a percentage of a ceiling, and says nothing of a limit it is nowhere near.
	for _, never := range []string{"%", "16 MB", "limit", "cannot save", "legacy", "older"} {
		if strings.Contains(check.Message, never) {
			t.Errorf("%q should not be in %q", never, check.Message)
		}
	}
}

func TestDoctorDoesNotCallAChainHeadBookNearTheSnapshotLimitFull(t *testing.T) {
	// The first version warned from 60 percent of the 16 MB a snapshot can be (about 750 journals): 11 MB
	// of a 1,100-journal book. For a book that reads back in a millisecond an entry it is a snapshot that
	// is large, not a book that is.
	baseline := baselineWarnings(t)
	for _, bytes := range []int64{10066330, 11 << 20, 15 << 20, ceiling - 1024, ceiling} {
		w := newWorld(t)
		w.setCapacity(chainHead(1100, bytes, 1101))
		report := w.doctor()
		check := only(t, report, "Capacity")
		if check.Status != service.StatusOK || report.Warnings != baseline || strings.Contains(check.Message, "%") {
			t.Fatalf("a snapshot of %d bytes: %+v", bytes, check)
		}
	}
}

func TestDoctorSaysPlainlyWhatAChainHeadBookPastTheSnapshotLimitCosts(t *testing.T) {
	// 5,000 journals: the service stopped saving snapshots at 1,500 entries (a 14.6 MB one), and keeps it.
	w := newWorld(t)
	w.setCapacity(chainHead(5000, 15_322_110, 1501))
	report := w.doctor()
	check := only(t, report, "Capacity")
	if check.Status != service.StatusOK || check.Fix != "" || report.Warnings != baselineWarnings(t) {
		t.Fatalf("a book past the snapshot limit is information, not a warning: %+v", check)
	}
	for _, want := range []string{
		"5,000 journals",
		"A snapshot of the whole book can be at most 16 MB",
		"this book is past that",
		"the last one it saved (14.6 MB, at entry 1,501)",
		"replays the 3,500 entries after it, which takes a few seconds",
		"about a second for every thousand entries",
	} {
		if !strings.Contains(check.Message, want) {
			t.Errorf("%q is not in %q", want, check.Message)
		}
	}
	if strings.Contains(check.Message, "%") || strings.Contains(check.Message, "older") {
		t.Errorf("no percentage of a ceiling, and no older book: %q", check.Message)
	}
	// 20,000 journals take about 20 seconds, with or without the old snapshot.
	w.setCapacity(chainHead(20000, 15_322_110, 1501))
	if message := only(t, w.doctor(), "Capacity").Message; !strings.Contains(message, "which takes about 20 seconds") {
		t.Fatalf("20,000 journals: %s", message)
	}
	w.setCapacity(chainHead(20000, 0, 0))
	check = only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusOK || !strings.Contains(check.Message, "No snapshot is saved, so a restart replays every entry from the start, which takes about 20 seconds") {
		t.Fatalf("%+v", check)
	}
}

func TestDoctorWarnsOfAChainHeadBookOnlyWhenARestartWouldTakeAMinute(t *testing.T) {
	// The line is slowRestart, 60 seconds: 60,000 entries at a millisecond each.
	for _, test := range []struct {
		entries int64
		warns   bool
	}{{59_000, false}, {59_999, false}, {60_000, true}, {61_000, true}} {
		w := newWorld(t)
		w.setCapacity(kindBody("chain-head", int(test.entries)-1, test.entries, 0, 0, 0, 0))
		check := only(t, w.doctor(), "Capacity")
		if (check.Status == service.StatusWarn) != test.warns {
			t.Errorf("%d entries: %+v", test.entries, check)
		}
	}
	// A big book with an old snapshot: the warning says what the restart is made of and what to do.
	w := newWorld(t)
	w.setCapacity(chainHead(80_000, 15_322_110, 1501))
	report := w.doctor()
	check := only(t, report, "Capacity")
	if check.Status != service.StatusWarn || !report.Healthy() || report.Warnings < 1 {
		t.Fatalf("a warning, and not a failure: %+v", check)
	}
	for _, want := range []string{
		"The book holds 80,000 journals",
		"A restart takes about a minute",
		"a rule of thumb",
		"reads the last snapshot it saved (14.6 MB, at entry 1,501) and replays the 78,500 entries made since",
		"whatever needs the book waits until it has finished",
	} {
		if !strings.Contains(check.Message, want) {
			t.Errorf("%q is not in %q", want, check.Message)
		}
	}
	for _, want := range []string{"Nothing is wrong", "Leave the service running", "The scale limit"} {
		if !strings.Contains(check.Fix, want) {
			t.Errorf("%q is not in the fix %q", want, check.Fix)
		}
	}
	if strings.Contains(check.Message, "%") {
		t.Errorf("no percentage of a ceiling: %s", check.Message)
	}
}

func TestDoctorWarnsOfAChainHeadSnapshotFarBehindABookThatStillFits(t *testing.T) {
	// A snapshot can still be saved for 1,000 journals (a megabyte at entry 100 says ten for a thousand), so
	// a restart that is slow because the snapshot is far behind (a slow computer: 100 ms an entry) has a
	// fix: stopping the service saves one.
	w := newWorld(t)
	w.setVerifiedReplay(500, 50_000)
	w.setCapacity(chainHead(1000, 1<<20, 100))
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "far behind the book") || !strings.Contains(check.Fix, "rastrata stop") {
		t.Fatalf("%+v", check)
	}
	if !strings.Contains(check.Message, "going by how long your last backup check took") {
		t.Errorf("the time is this computer's own: %s", check.Message)
	}
}

func TestDoctorScalesTheReplayThisComputerTimedByTheEntriesForAChainHeadBook(t *testing.T) {
	// 500 entries took 10 seconds here (20 ms an entry, a computer under load). The book has 4,000
	// entries: eight times as many, so eight times as long: 80 seconds. The square, which is how a legacy
	// book would be scaled, would say 640.
	c := service.Capacity{Configured: true, Journals: 3999, Outcomes: 4000, CeilingBytes: ceiling, Commitment: "chain-head", Replay: "linear", Measured: &service.Replay{Entries: 500, Seconds: 10}}
	if fromStart, measured := c.FromStartSeconds(); !measured || math.Abs(fromStart-80) > 1e-9 {
		t.Fatalf("scaled by the entries: %.1f (measured %v)", fromStart, measured)
	}
	c.Commitment, c.Replay = "legacy", "quadratic"
	if fromStart, _ := c.FromStartSeconds(); math.Abs(fromStart-640) > 1e-9 {
		t.Fatalf("a legacy book scales by the square: %.1f", fromStart)
	}
	// Through the doctor: the chain-head book of 4,000 entries warns, going by the computer's own time.
	w := newWorld(t)
	w.setVerifiedReplay(500, 10_000)
	w.setCapacity(chainHead(3999, 0, 0))
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "A restart takes about a minute") ||
		!strings.Contains(check.Message, "going by how long your last backup check took") {
		t.Fatalf("%+v", check)
	}
}

func TestDoctorTellsALegacyBookOnceThatBooksMadeNowAreFaster(t *testing.T) {
	const sentence = "Books made by this version read back in about a second for every thousand entries; this one was made before that and keeps its older, slower form."
	for _, test := range []struct {
		name   string
		body   string
		status string
	}{
		{"nearly full", kindBody("legacy", 1000, 1100, 11<<20, 1100, 24.2, 3), service.StatusWarn},
		{"room", kindBody("legacy", 412, 800, 3670016, 800, 8, 1), service.StatusOK},
		{"small and no snapshot", kindBody("legacy", 37, 40, 0, 0, 1, 1), service.StatusOK},
		{"big and no snapshot", kindBody("legacy", 2000, 2100, 0, 0, 92, 92), service.StatusWarn},
	} {
		w := newWorld(t)
		w.setCapacity(test.body)
		check := only(t, w.doctor(), "Capacity")
		if check.Status != test.status {
			t.Errorf("%s: %+v", test.name, check)
		}
		if strings.Count(check.Message, sentence) != 1 || !strings.HasSuffix(check.Message, sentence) {
			t.Errorf("%s: the sentence once, at the end: %q", test.name, check.Message)
		}
		// Everything it said before is still said.
		if check.Status == service.StatusWarn && !strings.Contains(check.Fix, "The scale limit") && !strings.Contains(check.Fix, "rastrata stop") {
			t.Errorf("%s: the fix: %q", test.name, check.Fix)
		}
	}
	// A service that does not say which kind of book it holds (an older one) gets what it always got.
	w := newWorld(t)
	w.setCapacity(capacityBody(1000, 1100, 11<<20, 1100))
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || strings.Contains(check.Message, "older, slower form") {
		t.Fatalf("%+v", check)
	}
	// And a book of the new kind is never told it is the old one.
	w.setCapacity(chainHead(1100, 11<<20, 1101))
	if message := only(t, w.doctor(), "Capacity").Message; strings.Contains(message, "older, slower form") {
		t.Fatalf("%s", message)
	}
}

func TestACapacityAnswerIsReadWithItsNewFields(t *testing.T) {
	var c service.Capacity
	body := kindBody("chain-head", 750, 800, 7_760_000, 800, 1, 0.1)
	if err := json.Unmarshal([]byte(body), &c); err != nil {
		t.Fatal(err)
	}
	if c.Commitment != "chain-head" || c.Replay != "linear" || c.ServiceFromStart == nil || *c.ServiceFromStart != 1 || c.ServiceRestart == nil || *c.ServiceRestart != 0.1 {
		t.Fatalf("%+v", c)
	}
	// An older service has none of them, and the answer is still understood.
	var older service.Capacity
	if err := json.Unmarshal([]byte(capacityBody(10, 20, 0, 0)), &older); err != nil {
		t.Fatal(err)
	}
	if older.Commitment != "" || older.Replay != "" || older.ServiceFromStart != nil || older.ServiceRestart != nil {
		t.Fatalf("%+v", older)
	}
	// A book that is not set up has them null.
	var empty service.Capacity
	if err := json.Unmarshal([]byte(`{"configured":false,"journals":0,"outcomes":0,"ceilingBytes":16777216,"snapshot":null,"commitment":null,"replay":null,"fromStartSeconds":null,"restartSeconds":null}`), &empty); err != nil {
		t.Fatal(err)
	}
	if empty.Check().Status != service.StatusOK || !strings.Contains(empty.Check().Message, "no book yet") {
		t.Fatalf("%+v", empty.Check())
	}
}

// replayVectors are the rule of thumb as numbers, shared with the service
// (packages/application/test/fixtures/replay-estimate-vectors.json): both are held to them.
type replayVector struct {
	Name     string `json:"name"`
	Growth   string `json:"growth"`
	Journals int    `json:"journals"`
	Entries  int64  `json:"entries"`
	Snapshot *struct {
		Bytes    int64 `json:"bytes"`
		Sequence int64 `json:"sequence"`
	} `json:"snapshot"`
	FromStartSeconds float64 `json:"fromStartSeconds"`
	RestartSeconds   float64 `json:"restartSeconds"`
}

func TestTheRuleOfThumbIsTheOneTheServiceUses(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "application", "test", "fixtures", "replay-estimate-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []replayVector `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Cases) < 10 {
		t.Fatalf("only %d vectors", len(vectors.Cases))
	}
	kinds := map[string]bool{}
	for _, v := range vectors.Cases {
		kinds[v.Growth] = true
		c := service.Capacity{Configured: true, Journals: v.Journals, Outcomes: v.Entries, CeilingBytes: ceiling, Replay: v.Growth}
		if v.Snapshot != nil {
			c.Snapshot = &service.SavedSnapshot{Bytes: v.Snapshot.Bytes, Sequence: v.Snapshot.Sequence}
		}
		if fromStart, measured := c.FromStartSeconds(); measured || math.Abs(fromStart-v.FromStartSeconds) > 1e-6 {
			t.Errorf("%s: from the start %.6f, the service says %.6f", v.Name, fromStart, v.FromStartSeconds)
		}
		if restart := c.RestartSeconds(); math.Abs(restart-v.RestartSeconds) > 1e-6 {
			t.Errorf("%s: a restart %.6f, the service says %.6f", v.Name, restart, v.RestartSeconds)
		}
	}
	if !kinds["linear"] || !kinds["quadratic"] {
		t.Fatalf("both kinds of book are in the vectors: %v", kinds)
	}
}

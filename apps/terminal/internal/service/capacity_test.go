package service_test

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

const ceiling = 16 << 20

// capacityBody is what GET /api/capacity says: snapshotBytes of 0 means no snapshot is saved.
func capacityBody(journals int, outcomes, snapshotBytes, snapshotSequence int64) string {
	snapshot := "null"
	if snapshotBytes > 0 {
		snapshot = fmt.Sprintf(`{"bytes":%d,"sequence":%d}`, snapshotBytes, snapshotSequence)
	}
	return fmt.Sprintf(`{"configured":true,"journals":%d,"outcomes":%d,"ceilingBytes":%d,"snapshot":%s}`, journals, outcomes, ceiling, snapshot)
}

func (w *world) setCapacity(body string) {
	w.server.Set(func(b *servicetest.Behaviour) { b.Capacity = body })
}

// setVerifiedReplay makes the newest verified backup a book of entries entries that this computer
// replayed in replayMs.
func (w *world) setVerifiedReplay(entries, replayMs int64) {
	w.setStatus(fmt.Sprintf(`{"ok":true,"data":{"directory":%q,"settings":{"warnAfterHours":48},"latestVerified":{"head":{"sequence":"%d"},"verification":{"verifiedAt":%q,"replayMs":%d}},"backupCount":4,"warnings":[]}}`,
		filepath.Join(w.data, "backups", "book"), entries, now.Add(-3*time.Hour).Format(time.RFC3339), replayMs))
}

func TestDoctorSaysHowMuchTheBookHoldsAndStaysQuietWhileThereIsRoom(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(capacityBody(412, 800, 3670016, 800)) // 3.5 MB of 16
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusOK || check.Fix != "" {
		t.Fatalf("a book with room: %+v", check)
	}
	for _, want := range []string{"412 journals", "3.5 MB", "16 MB", "(21%)", "a few seconds"} {
		if !strings.Contains(check.Message, want) {
			t.Errorf("%q is not in %q", want, check.Message)
		}
	}
}

func TestDoctorWarnsFromSixtyPercentOfTheCeiling(t *testing.T) {
	const sixty = ceiling * 6 / 10 // 10,066,329.6 bytes
	for _, test := range []struct {
		name  string
		bytes int64
		want  string
		warns bool
	}{
		{"one byte short of sixty percent", sixty, service.StatusOK, false},
		{"sixty percent", sixty + 1, service.StatusWarn, true},
		{"nearly full", ceiling - 1024, service.StatusWarn, true},
		{"full", ceiling, service.StatusWarn, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := newWorld(t)
			w.setCapacity(capacityBody(1000, 1100, test.bytes, 1100))
			report := w.doctor()
			check := only(t, report, "Capacity")
			if check.Status != test.want {
				t.Fatalf("%s: %+v", test.name, check)
			}
			if test.warns {
				for _, want := range []string{"1,000 journals", "16 MB", "cannot save a snapshot", "A restart takes"} {
					if !strings.Contains(check.Message, want) {
						t.Errorf("%q is not in %q", want, check.Message)
					}
				}
				if !strings.Contains(check.Fix, "The scale limit") || report.Warnings < 1 || !report.Healthy() {
					t.Errorf("a warning with a fix, and not a failure: %+v (warnings %d)", check, report.Warnings)
				}
			}
		})
	}
}

func TestDoctorWarnsAtTheEdgeInThePercentItShows(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(capacityBody(1000, 1100, 10066330, 1100))
	if message := only(t, w.doctor(), "Capacity").Message; !strings.Contains(message, "(60%)") {
		t.Fatalf("the warning says another percent than the one it warns at: %s", message)
	}
	w.setCapacity(capacityBody(1000, 1100, 10066329, 1100))
	if message := only(t, w.doctor(), "Capacity").Message; !strings.Contains(message, "(59%)") {
		t.Fatalf("just under: %s", message)
	}
}

func TestDoctorSaysATimeAPersonCanUse(t *testing.T) {
	// A thousand journals replay from the start in about 22 seconds; two thousand in about 90.
	w := newWorld(t)
	w.setCapacity(capacityBody(2000, 2000, 12<<20, 1900))
	message := only(t, w.doctor(), "Capacity").Message
	if !strings.Contains(message, "from the very start it would take about a minute") && !strings.Contains(message, "from the very start it would take about 2 minutes") {
		t.Fatalf("the time from the start: %s", message)
	}
	if !strings.Contains(message, "(75%)") || !strings.Contains(message, "A restart takes about") {
		t.Fatalf("%s", message)
	}
}

func TestDoctorSaysSoWhenTheSnapshotFallsFarBehindTheBook(t *testing.T) {
	// Half full, so no warning on size: but a restart would replay a thousand entries.
	w := newWorld(t)
	w.setCapacity(capacityBody(1600, 2000, 8<<20, 1000))
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "far behind") || !strings.Contains(check.Fix, "rastrata stop") {
		t.Fatalf("%+v", check)
	}
}

func TestDoctorCountsASmallBookWithoutASnapshotAsFine(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(capacityBody(37, 40, 0, 0))
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusOK || !strings.Contains(check.Message, "37 journals so far, a small book") || !strings.Contains(check.Message, "No snapshot is saved yet") {
		t.Fatalf("%+v", check)
	}
	w.setCapacity(capacityBody(1, 2, 0, 0))
	if message := only(t, w.doctor(), "Capacity").Message; !strings.Contains(message, "1 journal so far") {
		t.Fatalf("one journal: %s", message)
	}
}

func TestDoctorWarnsOfABigBookWithNoSnapshot(t *testing.T) {
	w := newWorld(t)
	// 2,000 journals with nothing saved: a restart replays them all, about a minute and a half.
	w.setCapacity(capacityBody(2000, 2100, 0, 0))
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "no snapshot of it is saved") || !strings.Contains(check.Message, "16 MB") {
		t.Fatalf("%+v", check)
	}
	// 1,500 take less than a minute: said, and not a warning.
	w.setCapacity(capacityBody(1500, 1600, 0, 0))
	check = only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusOK || !strings.Contains(check.Message, "from the start") {
		t.Fatalf("%+v", check)
	}
}

func TestDoctorHasNothingToMeasureBeforeThereIsABook(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(`{"configured":false,"journals":0,"outcomes":0,"ceilingBytes":16777216,"snapshot":null}`)
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusOK || !strings.Contains(check.Message, "no book yet") {
		t.Fatalf("%+v", check)
	}
}

func TestDoctorSaysNothingOfCapacityWhenTheServiceHasNoSuchQuestionOrWillNotAnswerIt(t *testing.T) {
	w := newWorld(t)
	// An older service: the route is not there.
	if found := find(w.doctor(), "Capacity"); len(found) != 0 {
		t.Fatalf("an older service has no capacity: %+v", found)
	}
	// A service that refuses the key: the owner lock check says so, once.
	w.setCapacity(capacityBody(10, 20, 0, 0))
	w.server.Set(func(b *servicetest.Behaviour) { b.OwnerKey = "rso_aDifferentKeyThatIsNotTheOneInTheFile000000" })
	report := w.doctor()
	if found := find(report, "Capacity"); len(found) != 0 {
		t.Fatalf("a refused key is the lock check's to report: %+v", found)
	}
	if lock := only(t, report, "Owner lock"); lock.Status != service.StatusFail {
		t.Fatalf("%+v", lock)
	}
}

func TestDoctorDoesNotAskWhenTheServiceIsDown(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(capacityBody(10, 20, 0, 0))
	w.setDown(true)
	if found := find(w.doctor(), "Capacity"); len(found) != 0 {
		t.Fatalf("a service that is down has nothing to say: %+v", found)
	}
}

func TestDoctorSaysWhenTheServiceAnswersCapacityBadly(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(`not json`)
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "did not say how much the book holds") {
		t.Fatalf("%+v", check)
	}
}

func TestCapacityNumbersFormatLikeTheRestOfDoctor(t *testing.T) {
	for _, test := range []struct {
		journals int
		want     string
	}{{0, "0 journals"}, {1, "1 journal"}, {999, "999 journals"}, {1000, "1,000 journals"}, {1234567, "1,234,567 journals"}} {
		c := service.Capacity{Configured: true, Journals: test.journals, Outcomes: int64(test.journals), CeilingBytes: ceiling}
		if message := c.Check().Message; !strings.Contains(message, test.want) {
			t.Errorf("%d journals: %q", test.journals, message)
		}
	}
	// The time a book of one thousand journals takes from the start is the integrator's measurement.
	c := service.Capacity{Configured: true, Journals: 1000, Outcomes: 1000, CeilingBytes: ceiling}
	if fromStart, measured := c.FromStartSeconds(); measured || fromStart < 21 || fromStart > 23 {
		t.Fatalf("a thousand journals take about 22 seconds from the start, not %.1f (measured %v)", fromStart, measured)
	}
	c = service.Capacity{Configured: true, Journals: 2000, Outcomes: 2000, CeilingBytes: ceiling}
	if fromStart, _ := c.FromStartSeconds(); fromStart < 85 || fromStart > 92 {
		t.Fatalf("two thousand take about 90 seconds, not %.1f", fromStart)
	}
}

func TestDoctorScalesTheReplayThisComputerTimed(t *testing.T) {
	// A verified backup of 500 entries took 10 seconds to replay here, so a thousand take four times
	// as long: 40 seconds, whatever the rule of thumb says (22 at a thousand journals).
	w := newWorld(t)
	w.setVerifiedReplay(500, 10_000)
	w.setCapacity(capacityBody(1000, 1000, 11<<20, 1000)) // 68 percent of the ceiling: a warning with times
	check := only(t, w.doctor(), "Capacity")
	if check.Status != service.StatusWarn || !strings.Contains(check.Message, "from the very start it would take about 40 seconds") ||
		!strings.Contains(check.Message, "going by how long your last backup check took") || strings.Contains(check.Message, "rule of thumb") {
		t.Fatalf("%+v", check)
	}
	// Without a timed replay the rule of thumb is used, and the message says so.
	w.setStatus(strings.ReplaceAll(strings.ReplaceAll(verifiedBackups, "%DIR%", filepath.Join(w.data, "backups", "book")), "%AT%", now.Add(-3*time.Hour).Format(time.RFC3339)))
	check = only(t, w.doctor(), "Capacity")
	if !strings.Contains(check.Message, "from the very start it would take about 20 seconds") || !strings.Contains(check.Message, "a rule of thumb") {
		t.Fatalf("%+v", check)
	}
}

func TestDoctorIgnoresATimedReplayTooSmallToScale(t *testing.T) {
	// Fifty entries replayed in a second say nothing about a book of a thousand: start-up dominates.
	w := newWorld(t)
	w.setVerifiedReplay(50, 1_000)
	w.setCapacity(capacityBody(1000, 1000, 11<<20, 1000))
	if message := only(t, w.doctor(), "Capacity").Message; !strings.Contains(message, "a rule of thumb") {
		t.Fatalf("%s", message)
	}
	// Nor does a replay with no time, or no head, change anything.
	w.setStatus(fmt.Sprintf(`{"ok":true,"data":{"directory":%q,"settings":{"warnAfterHours":48},"latestVerified":{"verification":{"verifiedAt":%q,"replayMs":null}},"backupCount":1,"warnings":[]}}`,
		filepath.Join(w.data, "backups", "book"), now.Add(-time.Hour).Format(time.RFC3339)))
	if message := only(t, w.doctor(), "Capacity").Message; !strings.Contains(message, "a rule of thumb") {
		t.Fatalf("%s", message)
	}
}

func TestTheRestartTakesTheSnapshotAndTheEntriesSinceIt(t *testing.T) {
	// A thousand journals of a legacy book: 22 seconds from the start, so an entry costs 44 ms; the
	// snapshot is read in a third of a second (10 MB took 0.2 to 0.35 s to read, measured).
	snapshot := func(bytes, sequence int64) *service.SavedSnapshot {
		return &service.SavedSnapshot{Bytes: bytes, Sequence: sequence}
	}
	c := service.Capacity{Configured: true, Journals: 1000, Outcomes: 1100, CeilingBytes: ceiling, Snapshot: snapshot(10<<20, 1100)}
	if restart := c.RestartSeconds(); restart < 0.2 || restart > 0.6 {
		t.Fatalf("a current snapshot is read in a third of a second, not %.2f", restart)
	}
	c.Snapshot = snapshot(10<<20, 1000) // a hundred entries behind
	withTail := c.RestartSeconds()
	c.Snapshot = snapshot(10<<20, 1100)
	if current := c.RestartSeconds(); withTail-current < 4 || withTail-current > 6 {
		t.Fatalf("a hundred entries at a thousand journals take about 5 seconds, not %.1f", withTail-current)
	}
	// Never more than reading the book from the start.
	c.Snapshot = snapshot(1<<20, 0)
	if restart, fromStart := c.RestartSeconds(), 22.0*1.1; restart > fromStart+0.01 {
		t.Fatalf("a restart with a snapshot cannot take longer than without one: %.1f > %.1f", restart, fromStart)
	}
}

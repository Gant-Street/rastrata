package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Capacity is what the service says about how much one book holds (GET /api/capacity, owner only).
type Capacity struct {
	Configured bool `json:"configured"`
	Journals   int  `json:"journals"`
	// Outcomes is the number of entries in the ledger.
	Outcomes int64 `json:"outcomes"`
	// CeilingBytes is the most a saved snapshot can be: the kernel will not encode a book of more than
	// 16 MiB. It limits the snapshot, not the book.
	CeilingBytes int64 `json:"ceilingBytes"`
	// Snapshot is the snapshot saved in the book's file, nil when there is none yet. Past the ceiling the
	// last one saved stays, behind the book.
	Snapshot *SavedSnapshot `json:"snapshot"`
	// Commitment says which kind of book this is: "chain-head" for a book made with the chain-head state
	// commitment (every book the service makes now), "legacy" for one made without it (the install
	// package built on 2026-10-06, and older test books). Empty when the service does not say, which an
	// older one does not; the book is then read as legacy, as it was before the service said.
	Commitment string `json:"commitment"`
	// Replay is how reading the book from its first entry grows with its size: "linear" or "quadratic".
	Replay string `json:"replay"`
	// ServiceFromStart and ServiceRestart are the service's own figures, in seconds, by the same rule of
	// thumb (packages/application/src/replay-cost.ts); nil when it does not say. This command computes the
	// same numbers itself (the shared vectors hold the two together) so that it can put a replay this
	// computer has timed in their place.
	ServiceFromStart *float64 `json:"fromStartSeconds"`
	ServiceRestart   *float64 `json:"restartSeconds"`
	// Measured is a replay this computer has timed, if it has; the estimate scales it.
	Measured *Replay `json:"-"`
}

// SavedSnapshot is the snapshot the service saved in the book's file: its size, and the entry it was
// saved at.
type SavedSnapshot struct {
	Bytes    int64 `json:"bytes"`
	Sequence int64 `json:"sequence"`
}

// Replay is how long this computer took to read a whole book from its first entry: the newest verified
// backup times one, and the capacity check scales that to the size of the book now.
type Replay struct {
	// Entries is how many entries the replayed book had.
	Entries int64
	Seconds float64
}

// The kinds of book, as the service says them.
const (
	commitmentChainHead = "chain-head"
	commitmentLegacy    = "legacy"
	replayLinear        = "linear"
)

// The numbers behind the estimate. A saved snapshot is limited: the kernel refuses to encode more than
// 16 MiB, about 1,600 journals of two lines (10 KB a journal, measured). The service goes on working
// past that, from the state it has verified in memory, but it cannot save a newer snapshot, so a restart
// reads the last one it saved and replays the entries since, or the whole book when there is none. What
// that costs depends on the kind of book. A chain-head book is replayed in time linear in its entries,
// about a millisecond each, so past the snapshot's limit the restart is slower, not dangerous: it is
// information, and warns only when it would take a minute. A legacy book is replayed in time that grows
// with the square of the entries (each costs in proportion to the journals the book holds when it is
// applied), which is where the warnings of the first version of this check come from. See
// docs/reference/program/main.md, "The scale limit", and docs/reference/program/scale/scaleestimates.md.
// The two rules of thumb are held to the same numbers as the service's
// (packages/application/test/fixtures/replay-estimate-vectors.json).
const (
	// capacityWarnPercent is how full the snapshot may be before doctor warns about a legacy book.
	capacityWarnPercent = 60
	// snapshotEvery is how many entries the service makes between snapshots (SNAPSHOT_EVERY there).
	snapshotEvery = 100
	// replayAtThousand is the integrator's rule of thumb, in seconds, for replaying a thousand journals
	// of a legacy book from the start (22 s; about 90 s at two thousand). It is used until a verified
	// backup has timed a replay on this computer, which is a better guide: computers differ, and so does
	// how busy they are.
	replayAtThousand = 22.0
	// linearSecondsPerEntry is the same for a chain-head book: a millisecond an entry. Measured with
	// bench/scale.ts at 0.72 to 0.88 ms on a quiet laptop from 500 to 20,000 journals and rounded up.
	linearSecondsPerEntry = 0.001
	// minMeasured is the fewest entries a timed replay may have to be scaled: a small book's replay is
	// mostly start-up and says nothing about a large one.
	minMeasured = 100
	// floor is the least a start can take, in seconds.
	floor = 1.0
	// snapshotLoadFixed and snapshotLoadPerMB are what reading a saved snapshot costs, in seconds and in
	// seconds per megabyte of it, for either kind of book. A 14.6 MiB snapshot was read in 0.35 s and an
	// 8 MiB one in 0.21 s in a fresh process; rounded up.
	snapshotLoadFixed = 0.1
	snapshotLoadPerMB = 0.025
	// slowRestart is the restart, in seconds, from which doctor warns whatever the snapshot's size.
	slowRestart = 60.0
	// capacityTimeout is how long doctor waits: the service may have to read a large book first.
	capacityTimeout = 45 * time.Second
)

// newerBooks is the one sentence a legacy book is told about the books made now.
const newerBooks = "Books made by this version read back in about a second for every thousand entries; this one was made before that and keeps its older, slower form."

// linear is true for a book whose replay costs the same for every entry: a chain-head book.
func (c Capacity) linear() bool {
	return c.Replay == replayLinear || c.Commitment == commitmentChainHead
}

// Percent is how much of the ceiling the saved snapshot uses, and false when there is none.
func (c Capacity) Percent() (float64, bool) {
	if c.Snapshot == nil || c.CeilingBytes <= 0 {
		return 0, false
	}
	return 100 * float64(c.Snapshot.Bytes) / float64(c.CeilingBytes), true
}

// entries is the number of entries a replay of the whole book has to apply.
func (c Capacity) entries() float64 { return float64(max(c.Outcomes, int64(c.Journals), 1)) }

// behindBy is how many entries the book is past its saved snapshot: what a restart replays after reading
// it. Zero when there is no snapshot.
func (c Capacity) behindBy() int64 {
	if c.Snapshot == nil {
		return 0
	}
	return max(0, int64(c.entries())-c.Snapshot.Sequence)
}

// outgrown is true when the book has passed what a snapshot can hold: the saved one is further behind
// than the service ever lets it fall while it can save (it saves every snapshotEvery entries), and a
// snapshot of the book as it is now would be past the ceiling, going by how big the saved one was for the
// entries it held. The service has stopped saving them and the one in the file stays. The second part is a
// guess from the book's own figures; the first is what the service has done.
func (c Capacity) outgrown() bool {
	if c.Snapshot == nil || c.CeilingBytes <= 0 || c.behindBy() <= 2*snapshotEvery {
		return false
	}
	perEntry := float64(c.Snapshot.Bytes) / float64(max(c.Snapshot.Sequence, 1))
	return perEntry*c.entries() > float64(c.CeilingBytes)
}

// FromStartSeconds is about how long reading the whole book from its first entry takes: the time this
// computer measured, scaled to the book's size now, or the rule of thumb when it has measured none. A
// replay of a chain-head book grows with the entries, and one of a legacy book with their square.
func (c Capacity) FromStartSeconds() (seconds float64, measured bool) {
	entries := c.entries()
	if m := c.Measured; m != nil && m.Entries >= minMeasured && m.Seconds > 0 {
		ratio := entries / float64(m.Entries)
		if c.linear() {
			return max(floor, m.Seconds*ratio), true
		}
		return max(floor, m.Seconds*ratio*ratio), true
	}
	if c.linear() {
		return max(floor, entries*linearSecondsPerEntry), false
	}
	return max(floor, replayAtThousand*(float64(c.Journals)/1000)*(entries/1000)), false
}

// RestartSeconds is about how long the service takes to be ready after it starts: it reads the saved
// snapshot and replays the entries made since, or replays everything when there is no snapshot.
func (c Capacity) RestartSeconds() float64 {
	fromStart, measured := c.FromStartSeconds()
	if c.Snapshot == nil {
		return fromStart
	}
	since := float64(c.behindBy())
	load := snapshotLoadFixed + snapshotLoadPerMB*float64(c.Snapshot.Bytes)/(1<<20)
	// An entry of a linear replay costs the same whatever the size of the book: the rule of thumb's
	// millisecond, or the pace this computer measured. An entry of a quadratic one, at the size the book
	// has now, costs twice the average over the replay that built it.
	var perEntry float64
	switch {
	case c.linear() && !measured:
		perEntry = linearSecondsPerEntry
	case c.linear():
		perEntry = fromStart / c.entries()
	default:
		perEntry = 2 * fromStart / c.entries()
	}
	return min(fromStart, load+since*perEntry)
}

// Check is the doctor's judgement of the capacity.
func (c Capacity) Check() Check {
	if !c.Configured {
		return ok("Capacity", "There is no book yet, so nothing to measure.")
	}
	if c.linear() {
		return c.chainHeadCheck()
	}
	check := c.legacyCheck()
	if c.Commitment == commitmentLegacy {
		check.Message += " " + newerBooks
	}
	return check
}

// chainHeadCheck judges a book that reads back in linear time. There is no limit in journals to warn of
// before a restart takes a minute, which is tens of thousands of them. The saved snapshot is information:
// what it is, and what a restart costs given where it stopped. A restart is a warning only when it would
// take slowRestart.
func (c Capacity) chainHeadCheck() Check {
	const name = "Capacity"
	restart := c.RestartSeconds()
	fromStart, measured := c.FromStartSeconds()
	held := plural(c.Journals, "journal")
	snapshot := c.Snapshot
	// The entries made since the saved snapshot, which a restart replays after reading it.
	since := c.behindBy()
	switch {
	case restart >= slowRestart && snapshot != nil && !c.outgrown():
		return warn(name, fmt.Sprintf("The book holds %s and its saved snapshot is %s (at entry %s), but it is far behind the book, so a restart takes %s %s. "+
			"The service saves a snapshot every %d entries and when it stops.",
			held, megabytes(snapshot.Bytes), thousands(snapshot.Sequence), about(restart), basis(measured), snapshotEvery),
			"Run rastrata stop and then rastrata start: it saves a snapshot when it stops. If that does not help, see docs/reference/program/main.md under The scale limit.")
	case restart >= slowRestart:
		from := "replays every entry from the start"
		if snapshot != nil {
			from = fmt.Sprintf("reads the last snapshot it saved (%s, at entry %s) and replays the %s entries made since", megabytes(snapshot.Bytes), thousands(snapshot.Sequence), thousands(since))
		}
		return warn(name, fmt.Sprintf("The book holds %s. A restart takes %s %s: the service %s, at about a second for every thousand entries, and whatever needs the book waits until it has finished.",
			held, about(restart), basis(measured), from),
			"Nothing is wrong. Leave the service running instead of restarting it. What is planned for a faster restart is in docs/reference/program/main.md under The scale limit.")
	case snapshot == nil && c.Outcomes <= 2*snapshotEvery:
		return ok(name, fmt.Sprintf("%s so far, a small book. No snapshot is saved yet (the service saves one every %d entries and when it stops); a restart replays it in %s.",
			capitalise(held), snapshotEvery, about(fromStart)))
	case snapshot == nil:
		return ok(name, fmt.Sprintf("%s. No snapshot is saved, so a restart replays every entry from the start, which takes %s.", capitalise(held), about(fromStart)))
	case c.outgrown():
		return ok(name, fmt.Sprintf("%s. A snapshot of the whole book can be at most %s, and this book is past that, so the service keeps the last one it saved (%s, at entry %s) and a restart replays the %s entries after it, which takes %s. "+
			"Nothing needs doing: a book this size reads back in about a second for every thousand entries.",
			capitalise(held), megabytes(c.CeilingBytes), megabytes(snapshot.Bytes), thousands(snapshot.Sequence), thousands(since), about(restart)))
	}
	return ok(name, fmt.Sprintf("%s. The saved snapshot is %s, so a restart takes %s.", capitalise(held), megabytes(snapshot.Bytes), about(restart)))
}

// legacyCheck judges a book whose replay grows with the square of its entries, or whose kind the service
// did not say (an older one): the snapshot is the thing that keeps a restart short, so how full it is
// matters, and a restart that has to replay far past it is a warning.
func (c Capacity) legacyCheck() Check {
	const name = "Capacity"
	restart := c.RestartSeconds()
	fromStart, measured := c.FromStartSeconds()
	held := plural(c.Journals, "journal")
	slow := restart >= slowRestart
	const fix = "Nothing is wrong yet. What to expect, and what is planned, is in docs/reference/program/main.md under The scale limit."
	percent, saved := c.Percent()
	switch {
	case saved && percent >= capacityWarnPercent:
		return warn(name, fmt.Sprintf("The book holds %s and its saved snapshot is %s of the %s one book can have (%d%%). "+
			"Past that limit the service keeps working but cannot save a snapshot, so each restart replays the entries made since the last one, and that grows with the book. "+
			"A restart takes %s now; from the very start it would take %s %s.",
			held, megabytes(c.Snapshot.Bytes), megabytes(c.CeilingBytes), int(math.Floor(percent)), about(restart), about(fromStart), basis(measured)), fix)
	case saved && slow:
		return warn(name, fmt.Sprintf("The book holds %s and its saved snapshot is %s of %s (%d%%), but it is far behind the book, so a restart takes %s. "+
			"The service saves a snapshot every %d entries and when it stops.",
			held, megabytes(c.Snapshot.Bytes), megabytes(c.CeilingBytes), int(math.Floor(percent)), about(restart), snapshotEvery),
			"Run rastrata stop and then rastrata start: it saves a snapshot when it stops. If that does not help, see docs/reference/program/main.md under The scale limit.")
	case saved:
		return ok(name, fmt.Sprintf("%s; the saved snapshot is %s of the %s one book can have (%d%%). A restart takes %s.",
			capitalise(held), megabytes(c.Snapshot.Bytes), megabytes(c.CeilingBytes), int(math.Floor(percent)), about(restart)))
	case slow:
		return warn(name, fmt.Sprintf("The book holds %s but no snapshot of it is saved, so a restart replays every entry from the start: %s %s. "+
			"The service saves a snapshot every %d entries and when it stops; when it cannot, the book may have passed the %s one book can have.",
			held, about(fromStart), basis(measured), snapshotEvery, megabytes(c.CeilingBytes)), fix)
	case c.Outcomes <= 2*snapshotEvery:
		return ok(name, fmt.Sprintf("%s so far, a small book. No snapshot is saved yet (the service saves one every %d entries and when it stops); a restart replays it in %s.",
			capitalise(held), snapshotEvery, about(fromStart)))
	}
	return ok(name, fmt.Sprintf("%s. No snapshot is saved, so a restart replays every entry from the start, which takes %s.", capitalise(held), about(fromStart)))
}

// basis says where a time came from, so that a person knows how far to trust it.
func basis(measured bool) string {
	if measured {
		return "(going by how long your last backup check took to replay the book)"
	}
	return "(a rule of thumb: no backup check on this computer has timed a book big enough to go by)"
}

// capacityChecks asks the service how much the book holds. It says nothing when the service has no
// such question (an older one) or does not let the command in (the lock check has already said why).
// replay is what the newest verified backup timed, when the service said.
func (d Doctor) capacityChecks(ctx context.Context, location Location, answering bool, key string, replay *Replay) []Check {
	if !answering {
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location.Endpoint+"/api/capacity", nil)
	if err != nil {
		return nil
	}
	if key != "" {
		request.Header.Set("authorization", "Bearer "+key)
	}
	// The service may have to read a large book before it can say how large it is.
	client := *d.System.HTTP
	client.Timeout = capacityTimeout
	response, err := client.Do(request)
	if err != nil {
		return []Check{warn("Capacity", "The service did not say how much the book holds: it did not answer in time.", "Run rastrata logs.")}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound, http.StatusUnauthorized, http.StatusForbidden:
		return nil
	default:
		return []Check{warn("Capacity", fmt.Sprintf("The service did not say how much the book holds (status %d).", response.StatusCode), "Run rastrata logs.")}
	}
	var capacity Capacity
	if json.Unmarshal(body, &capacity) != nil {
		return []Check{warn("Capacity", "The service did not say how much the book holds in a form this command understands.", "Run rastrata doctor again after rastrata update, so that the command and the service agree.")}
	}
	capacity.Measured = replay
	return []Check{capacity.Check()}
}

func plural(count int, noun string) string {
	if count == 1 {
		return "1 " + noun
	}
	return thousands(int64(count)) + " " + noun + "s"
}

func capitalise(text string) string {
	if text == "" {
		return text
	}
	return strings.ToUpper(text[:1]) + text[1:]
}

// thousands writes 1234567 as 1,234,567.
func thousands(n int64) string {
	text := strconv.FormatInt(n, 10)
	for i := len(text) - 3; i > 0 && text[i-1] != '-'; i -= 3 {
		text = text[:i] + "," + text[i:]
	}
	return text
}

// megabytes writes a size in the units the rest of doctor uses: whole megabytes when it is one, and
// otherwise rounded down, so that a size just under a limit is never written as the limit.
func megabytes(bytes int64) string {
	mb := float64(bytes) / (1 << 20)
	if mb == math.Trunc(mb) {
		return fmt.Sprintf("%d MB", int64(mb))
	}
	return fmt.Sprintf("%.1f MB", math.Floor(mb*10)/10)
}

// about writes a time estimate in words a person can use: it is a guess, and sounds like one.
func about(seconds float64) string {
	switch {
	case seconds < 5:
		return "a few seconds"
	case seconds < 57.5:
		return fmt.Sprintf("about %d seconds", int(math.Round(seconds/5)*5))
	case seconds < 90:
		return "about a minute"
	case seconds < 90*60:
		return fmt.Sprintf("about %d minutes", int(math.Round(seconds/60)))
	}
	return fmt.Sprintf("about %d hours", int(math.Round(seconds/3600)))
}

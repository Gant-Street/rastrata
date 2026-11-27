package service_test

import (
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

// The fields GET /health adds while the service reads its book, as the stand-in splices them in.
const (
	readingHealth = `"warming":true,"warmup":{"state":"reading","done":160,"total":1001,"secondsLeft":41}`
	startedHealth = `"warming":true,"warmup":{"state":"reading","done":null,"total":null,"secondsLeft":null}`
	almostHealth  = `"warming":true,"warmup":{"state":"reading","done":990,"total":1001,"secondsLeft":2}`
	readyHealth   = `"warming":false,"warmup":{"state":"ready","entries":1001,"seconds":37.6}`
	failedHealth  = `"warming":false,"warmup":{"state":"failed","error":"native_ledger_outcome_corrupt"}`
)

func (w *world) setHealth(fields string) {
	w.server.Set(func(b *servicetest.Behaviour) { b.Health = fields })
}

func TestHealthSaysInTheCommandsWordsWhatTheServiceIsReading(t *testing.T) {
	for _, test := range []struct {
		name    string
		seconds *float64
		want    string
	}{
		{"unknown", nil, "reading your books"},
		{"almost done", ptr(2.0), "reading your books, almost done"},
		{"seconds", ptr(41.0), "reading your books, about 40 seconds"},
		{"a minute", ptr(75.0), "reading your books, about a minute"},
		{"minutes", ptr(240.0), "reading your books, about 4 minutes"},
	} {
		health := service.Health{OK: true, Warming: true, Warmup: &service.Warmup{State: "reading", SecondsLeft: test.seconds}}
		if got := health.ReadingNote(); got != test.want {
			t.Errorf("%s: %q, want %q", test.name, got, test.want)
		}
	}
	// A service that is not reading, or says nothing of it, has nothing to say.
	for _, health := range []service.Health{
		{OK: true},
		{OK: true, Warmup: &service.Warmup{State: "ready", Entries: 5}},
		{OK: true, Warmup: &service.Warmup{State: "failed", Error: "x"}},
	} {
		if note := health.ReadingNote(); note != "" || health.Reading() {
			t.Errorf("%+v: %q", health, note)
		}
	}
}

func ptr(value float64) *float64 { return &value }

func TestDoctorSaysWhenTheServiceIsStillReadingItsBooksAndDoesNotWaitForThem(t *testing.T) {
	w := newWorld(t)
	w.setHealth(readingHealth)
	// The capacity question would wait for the read: if doctor asked it, the stand-in's answer would
	// show up as a row. It must not be asked while the service reads.
	w.setCapacity(capacityBody(1000, 1001, 10<<20, 1001))
	report := w.doctor()
	book := only(t, report, "Book")
	if book.Status != service.StatusWarn {
		t.Fatalf("%+v", book)
	}
	for _, want := range []string{"still reading your books", "160 of 1,001 entries", "About 40 seconds to go", "waits until it is done"} {
		if !strings.Contains(book.Message, want) {
			t.Errorf("%q is not in %q", want, book.Message)
		}
	}
	if !strings.Contains(book.Fix, "run rastrata doctor again") {
		t.Errorf("the fix: %q", book.Fix)
	}
	if found := find(report, "Capacity"); len(found) != 0 {
		t.Fatalf("doctor asked a service that is reading how big the book is: %+v", found)
	}
	if !report.Healthy() {
		t.Fatalf("reading is not a failure: %+v", report.Checks)
	}
	// Nothing known yet, and nearly done, are said as they are.
	w.setHealth(startedHealth)
	if message := only(t, w.doctor(), "Book").Message; !strings.Contains(message, "It is not known yet how long it will take") || strings.Contains(message, "entries") {
		t.Errorf("%s", message)
	}
	w.setHealth(almostHealth)
	if message := only(t, w.doctor(), "Book").Message; !strings.Contains(message, "It is almost done") {
		t.Errorf("%s", message)
	}
}

func TestDoctorReportsABookTheServiceCouldNotRead(t *testing.T) {
	w := newWorld(t)
	w.setHealth(failedHealth)
	w.setCapacity(capacityBody(10, 20, 0, 0))
	report := w.doctor()
	book := only(t, report, "Book")
	if book.Status != service.StatusFail || report.Healthy() {
		t.Fatalf("a book that cannot be read is a failure: %+v", book)
	}
	for _, want := range []string{"could not read your books", "native_ledger_outcome_corrupt", "Nothing was changed"} {
		if !strings.Contains(book.Message, want) {
			t.Errorf("%q is not in %q", want, book.Message)
		}
	}
	for _, want := range []string{"rastrata logs", "rastrata stop", "rastrata restore latest --replace", "rastrata start"} {
		if !strings.Contains(book.Fix, want) {
			t.Errorf("%q is not in the fix %q", want, book.Fix)
		}
	}
	if found := find(report, "Capacity"); len(found) != 0 {
		t.Fatalf("a book that cannot be read has no capacity to report: %+v", found)
	}
	// The rest of doctor goes on: the service is up and the lock works.
	if lock := only(t, report, "Owner lock"); lock.Status != service.StatusOK {
		t.Fatalf("%+v", lock)
	}
}

func TestDoctorSaysHowLongTheLastStartTookToReadTheBook(t *testing.T) {
	w := newWorld(t)
	w.setHealth(readyHealth)
	book := only(t, w.doctor(), "Book")
	if book.Status != service.StatusOK || book.Message != "Read at start-up: 1,001 entries in 38 seconds." {
		t.Fatalf("%+v", book)
	}
	for _, test := range []struct {
		fields string
		want   string
	}{
		{`"warming":false,"warmup":{"state":"ready","entries":1,"seconds":0.2}`, "Read at start-up: 1 entry in under a second."},
		{`"warming":false,"warmup":{"state":"ready","entries":5000,"seconds":260}`, "Read at start-up: 5,000 entries in 4 minutes."},
	} {
		w.setHealth(test.fields)
		if message := only(t, w.doctor(), "Book").Message; message != test.want {
			t.Errorf("%q, want %q", message, test.want)
		}
	}
	// No book yet, or a service that says nothing of reading it: no row.
	for _, fields := range []string{`"warming":false,"warmup":{"state":"ready","entries":0,"seconds":0}`, ""} {
		w.setHealth(fields)
		if found := find(w.doctor(), "Book"); len(found) != 0 {
			t.Errorf("%q: %+v", fields, found)
		}
	}
}

func TestDoctorAsksForTheCapacityOnceTheServiceHasReadItsBooks(t *testing.T) {
	w := newWorld(t)
	w.setCapacity(capacityBody(412, 800, 3670016, 800))
	w.setHealth(readingHealth)
	if found := find(w.doctor(), "Capacity"); len(found) != 0 {
		t.Fatalf("%+v", found)
	}
	w.setHealth(readyHealth)
	if capacity := only(t, w.doctor(), "Capacity"); capacity.Status != service.StatusOK {
		t.Fatalf("%+v", capacity)
	}
}

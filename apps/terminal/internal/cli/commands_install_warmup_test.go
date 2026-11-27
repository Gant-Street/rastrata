package cli

import (
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service/servicetest"
)

const (
	servicePartWay = `"warming":true,"warmup":{"state":"reading","done":160,"total":1001,"secondsLeft":41}`
	serviceFailed  = `"warming":false,"warmup":{"state":"failed","error":"native_ledger_outcome_corrupt"}`
)

func (w *installWorld) health(fields string) {
	w.t.Helper()
	w.server.Set(func(b *servicetest.Behaviour) { b.Health = fields })
}

func TestStatusAndStartSayWhenTheServiceIsStillReadingItsBooks(t *testing.T) {
	w := newInstallWorld(t)
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}
	w.writeKey()
	w.health(servicePartWay)
	sentence := "It is reading your books, about 40 seconds; what needs your books waits until it is done."

	exit, out, _ := w.run("status", "--format", "text")
	if exit != 0 || !strings.Contains(out, "is running at") || !strings.Contains(out, sentence) {
		t.Fatalf("status while reading, exit %d: %s", exit, out)
	}
	_, data, _ := envelope(t, mustRun(t, w, "status", "--format", "json"))
	if data["reading"] != true || data["secondsLeft"] != float64(41) || data["answering"] != true {
		t.Fatalf("status as JSON: %v", data)
	}
	// start finds it already running, and says what it is doing.
	exit, out, _ = w.run("start", "--format", "text")
	if exit != 0 || !strings.Contains(out, "is already running at") || !strings.Contains(out, sentence) {
		t.Fatalf("start while reading, exit %d: %s", exit, out)
	}
	_, data, _ = envelope(t, mustRun(t, w, "start", "--format", "json"))
	if data["reading"] != true || data["running"] != true {
		t.Fatalf("start as JSON: %v", data)
	}
	// Once it has read its books, nothing more is said.
	w.health(`"warming":false,"warmup":{"state":"ready","entries":1001,"seconds":37.6}`)
	exit, out, _ = w.run("status", "--format", "text")
	if exit != 0 || strings.Contains(out, "reading your books") {
		t.Fatalf("status when ready, exit %d: %s", exit, out)
	}
	_, data, _ = envelope(t, mustRun(t, w, "status", "--format", "json"))
	if data["reading"] != false {
		t.Fatalf("status as JSON when ready: %v", data)
	}
}

func TestStatusSaysWhyTheServiceCouldNotReadItsBooks(t *testing.T) {
	w := newInstallWorld(t)
	if exit, out, _ := w.install(); exit != 0 {
		t.Fatalf("%s", out)
	}
	w.writeKey()
	w.health(serviceFailed)
	exit, out, _ := w.run("status", "--format", "text")
	// The service answers, so status does not say it is down; it says what is wrong.
	if exit != 0 || !strings.Contains(out, "It could not read your books: native_ledger_outcome_corrupt. rastrata doctor says what to do.") {
		t.Fatalf("exit %d: %s", exit, out)
	}
	_, data, _ := envelope(t, mustRun(t, w, "status", "--format", "json"))
	if data["bookError"] != "native_ledger_outcome_corrupt" || data["reading"] != false {
		t.Fatalf("%v", data)
	}
}

func TestInstallSaysWhenTheServiceItStartedIsReadingItsBooks(t *testing.T) {
	w := newInstallWorld(t)
	w.health(servicePartWay)
	exit, out, _ := w.install("--format", "text")
	if exit != 0 || !strings.Contains(out, "is installed and running") ||
		!strings.Contains(out, "It is reading your books, about 40 seconds; the web app fills in when it is done.") {
		t.Fatalf("exit %d: %s", exit, out)
	}
}

func mustRun(t *testing.T, w *installWorld, args ...string) string {
	t.Helper()
	_, out, _ := w.run(args...)
	return out
}

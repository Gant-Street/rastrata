package cli

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// The pull's tests stand a Stripe and a Rastrata service up on this computer. The service is a
// script: what it answers to the nth call to stripe.receive. They hold the command to what matters:
// it fetches what it is told and only what the lane reads, with the key only to Stripe, delivers the
// exact bytes it got in bundles the service can read, and stops when it is not getting anywhere.

const pullKeyValue = "rk_" + "live_AbCdEfGhIjKlMnOpQrStUvWx"
const pullVersion = "2026-09-30.endive"

type stripeSeen struct {
	Method, Request, Authorization, Version string
}

type fakeStripe struct {
	server *httptest.Server
	mutex  sync.Mutex
	seen   []stripeSeen
}

func startFakeStripe(t *testing.T, answer func(request string) (int, string)) *fakeStripe {
	t.Helper()
	f := &fakeStripe{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mutex.Lock()
		f.seen = append(f.seen, stripeSeen{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), r.Header.Get("Stripe-Version")})
		f.mutex.Unlock()
		status, body := answer(r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeStripe) requests() []string {
	f.mutex.Lock()
	defer f.mutex.Unlock()
	out := make([]string, 0, len(f.seen))
	for _, seen := range f.seen {
		out = append(out, seen.Request)
	}
	return out
}

type receiveCall struct {
	AsOf     string   `json:"asOf"`
	Bundles  []string `json:"bundles"`
	LiveMode *bool    `json:"livemode"`
}

type fakeService struct {
	t       *testing.T
	server  *httptest.Server
	mutex   sync.Mutex
	blobs   map[string][]byte
	headers []http.Header
	bodies  []string
	calls   []receiveCall
	// script is what the service answers to the nth call (from 1): the data of a reply, or a
	// failure as a status, a code and a message.
	script func(n int, call receiveCall) (data string, status int, code, message string)
}

func startFakeService(t *testing.T, script func(n int, call receiveCall) (string, int, string, string)) *fakeService {
	t.Helper()
	s := &fakeService{t: t, blobs: map[string][]byte{}, script: script}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mutex.Lock()
		defer s.mutex.Unlock()
		s.bodies = append(s.bodies, string(body))
		s.headers = append(s.headers, r.Header.Clone())
		envelope := map[string]any{"version": api.Version, "bookId": "local-book", "ok": true}
		if r.URL.Path == "/v1/uploads" {
			sum := sha256.Sum256(body)
			sha := hex.EncodeToString(sum[:])
			s.blobs[sha] = body
			envelope["data"] = map[string]any{"sha256": sha, "size": len(body), "mediaType": r.Header.Get("Content-Type")}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		var request api.Request
		_ = json.NewDecoder(bytes.NewReader(body)).Decode(&request)
		if request.OperationID != "" {
			envelope["operationId"] = request.OperationID
		}
		if r.URL.Path != "/v1/stripe.receive" {
			w.WriteHeader(404)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
				"error": map[string]any{"code": "route_not_found", "message": "Application operation not found", "details": []any{}, "retryable": false}}
			_ = json.NewEncoder(w).Encode(envelope)
			return
		}
		var input struct {
			Input receiveCall `json:"input"`
		}
		_ = json.Unmarshal(body, &input)
		s.calls = append(s.calls, input.Input)
		data, status, code, message := s.script(len(s.calls), input.Input)
		if status != 0 {
			w.WriteHeader(status)
			envelope = map[string]any{"version": api.Version, "bookId": "local-book", "ok": false, "operationId": request.OperationID,
				"error": map[string]any{"code": code, "message": message, "details": []any{}, "retryable": status == 429 || status == 503}}
		} else {
			envelope["data"] = json.RawMessage(data)
		}
		_ = json.NewEncoder(w).Encode(envelope)
	}))
	t.Cleanup(s.server.Close)
	return s
}

// unframe reads the answers in a bundle the way the service does: a line of JSON, the bytes, a newline.
func unframe(t *testing.T, packed []byte) []answer {
	t.Helper()
	zip, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		t.Fatalf("a bundle is not gzip: %v", err)
	}
	reader := bufio.NewReader(zip)
	var out []answer
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF && len(line) == 0 {
			return out
		}
		if err != nil {
			t.Fatalf("a bundle has a header without an end: %v", err)
		}
		var header struct {
			Request string `json:"request"`
			Status  int    `json:"status"`
			Size    int    `json:"size"`
		}
		if err := json.Unmarshal(line, &header); err != nil {
			t.Fatalf("a bundle has a header that is not JSON: %q", line)
		}
		body := make([]byte, header.Size)
		if _, err := io.ReadFull(reader, body); err != nil {
			t.Fatalf("a bundle is cut short: %v", err)
		}
		if end, err := reader.ReadByte(); err != nil || end != '\n' {
			t.Fatalf("an answer in a bundle is not followed by a newline")
		}
		out = append(out, answer{Request: header.Request, Status: header.Status, Body: body})
	}
}

// answersOf is every answer the call delivered, in order, read from the bundles it named.
func (s *fakeService) answersOf(t *testing.T, call receiveCall) []answer {
	t.Helper()
	s.mutex.Lock()
	defer s.mutex.Unlock()
	var out []answer
	for _, sha := range call.Bundles {
		packed, ok := s.blobs[sha]
		if !ok {
			t.Fatalf("a call named a bundle that was never uploaded: %s", sha)
		}
		out = append(out, unframe(t, packed)...)
	}
	return out
}

// receiveData is the data of a reply of stripe.receive.
func receiveData(more bool, payouts, newLines int, needs ...string) string {
	if needs == nil {
		needs = []string{}
	}
	encoded, _ := json.Marshal(needs)
	return fmt.Sprintf(`{"run":{"id":"run-1","startedAt":"2026-03-20T12:00:00.000Z","finishedAt":"2026-03-20T12:00:01.000Z","disposition":"%s","requests":3,"pages":1,"transactions":%d,"newLines":%d,`+
		`"duplicateLines":0,"heldLines":0,"payouts":%d,"through":"2026-03-20","errorCode":null,"errorMessage":null,"notes":[]},"more":%t,"balance":null,"needs":%s,"apiVersion":"%s"}`,
		map[bool]string{true: "more", false: "complete"}[more], newLines, newLines, payouts, more, encoded, pullVersion)
}

func runPull(t *testing.T, service string, stripe *fakeStripe, env map[string]string, args ...string) (int, string, string) {
	t.Helper()
	for name, value := range env {
		t.Setenv(name, value)
	}
	if stripe != nil {
		t.Setenv(stripeURLVariable, stripe.server.URL)
	}
	var out, diagnostics bytes.Buffer
	runner := Runner{Input: strings.NewReader(""), Output: &out, Diagnostics: &diagnostics}
	all := append([]string{"stripe", "pull"}, args...)
	all = append(all, "--endpoint", service, "--request-dir", t.TempDir())
	exit := runner.Run(context.Background(), all)
	return exit, out.String(), diagnostics.String()
}

func withKey() map[string]string { return map[string]string{stripeKeyVariable: pullKeyValue} }

func fastRetries(t *testing.T) {
	t.Helper()
	was, wasService := pullBackoff, pullServiceBackoff
	pullBackoff, pullServiceBackoff = time.Millisecond, time.Millisecond
	t.Cleanup(func() { pullBackoff, pullServiceBackoff = was, wasService })
}

const (
	accountPath = "/v1/account"
	windowPath  = "/v1/balance_transactions?created%5Bgte%5D=1000&created%5Blt%5D=2000&limit=100"
	payoutPath  = "/v1/payouts/po_123"
)

// stripeStory answers the requests of a small pull: the account, a window of two pages, a payout.
func stripeStory(request string) (int, string) {
	switch {
	case request == accountPath:
		return 200, `{"id":"acct_1"}`
	case strings.HasPrefix(request, "/v1/balance_transactions") && strings.Contains(request, "starting_after=txn_2"):
		return 200, `{"object":"list","data":[{"id":"txn_3"}],"has_more":false}`
	case strings.HasPrefix(request, "/v1/balance_transactions"):
		return 200, `{"object":"list","data":[{"id":"txn_1"},{"id":"txn_2"}],"has_more":true}`
	case request == payoutPath:
		return 200, `{"id":"po_123","object":"payout"}`
	}
	return 404, `{"error":{"message":"No such thing."}}`
}

func TestBundleOfPacksAnswersByteForByteInTheFrameTheServiceReads(t *testing.T) {
	// Bodies of every kind: with newlines in them, binary, empty, and one that looks like a header.
	given := []*answer{
		{Request: "/v1/account", Status: 200, Body: []byte(`{"id":"acct_1"}`)},
		{Request: "/v1/balance", Status: 403, Body: []byte("line one\nline two\n\n")},
		{Request: "/v1/payouts/po_1AbC", Status: 200, Body: []byte{0, 1, 2, 255, '\n', '{', '"', 0xe2, 0x82, 0xac}},
		{Request: "/v1/checkout/sessions?limit=10", Status: 404, Body: nil},
		{Request: "/v1/invoice_payments", Status: 200, Body: []byte(`{"request":"/v1/customers","status":200,"size":1}` + "\n")},
	}
	packed, err := bundleOf(given)
	if err != nil {
		t.Fatal(err)
	}
	read := unframe(t, packed)
	if len(read) != len(given) {
		t.Fatalf("%d answers came out of %d", len(read), len(given))
	}
	for index, want := range given {
		got := read[index]
		if got.Request != want.Request || got.Status != want.Status || !bytes.Equal(got.Body, want.Body) {
			t.Fatalf("answer %d came out as %+v, want %+v", index, got, *want)
		}
	}
}

func TestCutBundlesKeepsEachBundleAndEachCallWithinTheirLimits(t *testing.T) {
	tiny := make([]*answer, 1200)
	for index := range tiny {
		tiny[index] = &answer{Request: fmt.Sprintf("/v1/payouts/po_%d", 100+index), Status: 200, Body: []byte("{}")}
	}
	bundles, rest := cutBundles(tiny)
	if len(bundles) != 3 || len(bundles[0]) != pullAnswersPerBundle || len(bundles[1]) != pullAnswersPerBundle || len(bundles[2]) != 200 || len(rest) != 0 {
		t.Fatalf("1,200 small answers came out as %d bundles with %d left over", len(bundles), len(rest))
	}
	big := make([]*answer, 30)
	for index := range big {
		big[index] = &answer{Request: fmt.Sprintf("/v1/payouts/po_%d", 100+index), Status: 200, Body: make([]byte, pullBundleBytes)}
	}
	bundles, rest = cutBundles(big)
	if len(bundles) != pullBundlesPerCall || len(rest) != 30-pullBundlesPerCall {
		t.Fatalf("30 answers of a bundle's size came out as %d bundles with %d left over", len(bundles), len(rest))
	}
	for _, bundle := range bundles {
		if len(bundle) != 1 {
			t.Fatalf("a bundle of %d answers each as big as a bundle may be", len(bundle))
		}
	}
	// An answer larger than a bundle may be has a bundle of its own, and is not lost.
	huge := []*answer{{Request: "/v1/account", Status: 200, Body: make([]byte, 3*pullBundleBytes)}, {Request: "/v1/balance", Status: 200, Body: []byte("{}")}}
	bundles, rest = cutBundles(huge)
	if len(bundles) != 2 || len(rest) != 0 {
		t.Fatalf("a huge answer and a small one came out as %d bundles with %d left over", len(bundles), len(rest))
	}
}

func shaOf(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func TestPullFetchesWhatTheServiceAsksForWithTheKeyOnlyToStripeAndDeliversTheExactBytes(t *testing.T) {
	stripe := startFakeStripe(t, stripeStory)
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		switch n {
		case 1:
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		case 2:
			return receiveData(true, 0, 0, windowPath), 0, "", ""
		case 3:
			return receiveData(true, 0, 0, payoutPath), 0, "", ""
		}
		return receiveData(false, 1, 4), 0, "", ""
	})
	exit, out, diagnostics := runPull(t, service.server.URL, stripe, withKey())
	if exit != 0 {
		t.Fatalf("exit %d\n%s\n%s", exit, out, diagnostics)
	}
	// Stripe was asked for exactly what the service named, and the list was read on to its second page unasked.
	asked := stripe.requests()
	want := []string{accountPath, windowPath, "/v1/balance_transactions?created%5Bgte%5D=1000&created%5Blt%5D=2000&limit=100&starting_after=txn_2", payoutPath}
	if strings.Join(asked, "\n") != strings.Join(want, "\n") {
		t.Fatalf("Stripe was asked for:\n%s\nwant:\n%s", strings.Join(asked, "\n"), strings.Join(want, "\n"))
	}
	for _, seen := range stripe.seen {
		if seen.Method != "GET" || seen.Authorization != "Bearer "+pullKeyValue || seen.Version != pullVersion {
			t.Fatalf("a request to Stripe went out as %+v", seen)
		}
	}
	// The service never saw the key, in a body or in a header.
	for _, body := range service.bodies {
		if strings.Contains(body, pullKeyValue) {
			t.Fatal("the service was sent the key in a body")
		}
	}
	for _, header := range service.headers {
		for name, values := range header {
			if strings.Contains(strings.Join(values, ","), pullKeyValue) {
				t.Fatalf("the service was sent the key in %s", name)
			}
		}
	}
	// Each answer reached the service byte for byte, in a gzip bundle uploaded for Stripe.
	delivered := map[string]answer{}
	for _, call := range service.calls {
		for _, a := range service.answersOf(t, call) {
			delivered[a.Request] = a
		}
	}
	for _, request := range want {
		status, body := stripeStory(request)
		got, ok := delivered[request]
		if !ok || got.Status != status || string(got.Body) != body {
			t.Fatalf("%s was delivered as %+v, want status %d and %q", request, got, status, body)
		}
	}
	uploads := 0
	for _, header := range service.headers {
		if header.Get("X-Upload-For") == "stripe" {
			uploads++
			if header.Get("Content-Type") != "application/gzip" {
				t.Fatalf("a bundle was uploaded as %s", header.Get("Content-Type"))
			}
		}
	}
	// One upload a round that had answers to deliver, not one for each answer.
	if uploads != 3 {
		t.Fatalf("%d uploads, want one for each of the three rounds that delivered answers", uploads)
	}
	// Every call said which mode the key reads: this one is a live key.
	for _, call := range service.calls {
		if call.LiveMode == nil || !*call.LiveMode {
			t.Fatalf("a call did not say its answers are Stripe's live mode: %+v", call)
		}
	}
	// The whole pull used one instant, in UTC, and said so in every call.
	instant := regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`)
	for _, call := range service.calls {
		if !instant.MatchString(call.AsOf) || call.AsOf != service.calls[0].AsOf {
			t.Fatalf("asOf %q is not one UTC instant for the whole pull", call.AsOf)
		}
	}
	// Both pages of the window were delivered in one call, so the service needed no round for the second.
	if got := service.answersOf(t, service.calls[2]); len(got) != 2 {
		t.Fatalf("the third call carried %d answers, want the window's two pages", len(got))
	}
	var summary struct {
		OK   bool `json:"ok"`
		Data struct {
			Rounds         int `json:"rounds"`
			StripeRequests int `json:"stripeRequests"`
			PayoutsBooked  int `json:"payoutsBooked"`
			NewLines       int `json:"newLines"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &summary); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !summary.OK || summary.Data.Rounds != 4 || summary.Data.StripeRequests != 4 || summary.Data.PayoutsBooked != 1 || summary.Data.NewLines != 4 {
		t.Fatalf("summary %+v\n%s", summary.Data, out)
	}
	if strings.Contains(out, pullKeyValue) || strings.Contains(diagnostics, pullKeyValue) {
		t.Fatal("the key was printed")
	}
}

func TestPullMakesNoRequestTheLaneDoesNotMake(t *testing.T) {
	for _, asked := range []string{
		"/v1/customers?limit=100",
		"/v1/charges/ch_1",
		"/v1/payouts/po_1/../customers",
		"/v1/payouts/po_1%2Fx",
		"//evil.example/v1/account",
		"https://evil.example/v1/account",
		"/v1/account#x",
		"/v2/account",
		"/v1/balance_transactions/txn_1",
	} {
		stripe := startFakeStripe(t, stripeStory)
		service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
			return receiveData(true, 0, 0, asked), 0, "", ""
		})
		exit, out, _ := runPull(t, service.server.URL, stripe, withKey())
		if exit != 3 || !strings.Contains(out, "stripe_request_refused") {
			t.Fatalf("%s: exit %d\n%s", asked, exit, out)
		}
		if len(stripe.requests()) != 0 {
			t.Fatalf("%s: Stripe was asked for %v", asked, stripe.requests())
		}
	}
}

func TestPullChecksTheKeyBeforeAnythingLeavesTheComputer(t *testing.T) {
	cases := []struct {
		name, key string
		args      []string
		refused   bool
		says      string
	}{
		{"none", "", nil, true, "There is no Stripe key"},
		{"not a key", "hello", nil, true, "not a Stripe API key"},
		{"unrestricted", "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWx", nil, true, "unrestricted"},
		{"test mode", "rk_" + "test_AbCdEfGhIjKlMnOpQrStUvWx", nil, true, "test-mode key"},
		{"test mode on purpose", "rk_" + "test_AbCdEfGhIjKlMnOpQrStUvWx", []string{"--test-mode=true"}, false, ""},
		{"restricted live", pullKeyValue, nil, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stripe := startFakeStripe(t, stripeStory)
			service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
				return receiveData(false, 0, 0), 0, "", ""
			})
			exit, out, diagnostics := runPull(t, service.server.URL, stripe, map[string]string{stripeKeyVariable: c.key}, c.args...)
			if c.key != "" && (strings.Contains(out, c.key) || strings.Contains(diagnostics, c.key)) {
				t.Fatal("the key was printed")
			}
			if c.refused {
				if exit != 3 || !strings.Contains(out, c.says) || !strings.Contains(out, "stripe_key_unusable") {
					t.Fatalf("exit %d\n%s", exit, out)
				}
				if len(service.calls) != 0 || len(stripe.requests()) != 0 {
					t.Fatal("something was sent before the key was accepted")
				}
				return
			}
			if exit != 0 {
				t.Fatalf("exit %d\n%s", exit, out)
			}
		})
	}
}

func TestPullSendsTheKeyOnlyToStripeEvenWhenToldElsewhere(t *testing.T) {
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		return receiveData(false, 0, 0), 0, "", ""
	})
	for _, address := range []string{"https://evil.example", "http://evil.example", "http://192.168.1.5:9", "http://127.0.0.1:9/path", "ftp://127.0.0.1", "http://user:pw@127.0.0.1:9"} {
		exit, out, _ := runPull(t, service.server.URL, nil, map[string]string{stripeKeyVariable: pullKeyValue, stripeURLVariable: address})
		if exit != 2 || !strings.Contains(out, "usage_error") {
			t.Fatalf("%s: exit %d\n%s", address, exit, out)
		}
	}
	if len(service.calls) != 0 {
		t.Fatal("the service was called")
	}
}

func TestPullDeliversStripesRefusalsAsAnswersSoTheServiceSaysWhatTheyMean(t *testing.T) {
	stripe := startFakeStripe(t, func(request string) (int, string) {
		if request == accountPath {
			return 403, `{"error":{"message":"The provided key lacks a permission."}}`
		}
		return 404, `{}`
	})
	var delivered []answer
	var asked *fakeService
	asked = startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		if n == 1 {
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		}
		delivered = asked.answersOfLocked(call)
		return "", 403, "stripe_permission_denied", "Stripe refused a request because the key lacks a permission. Add read access for it."
	})
	exit, out, _ := runPull(t, asked.server.URL, stripe, withKey())
	if exit != 3 || !strings.Contains(out, "stripe_permission_denied") {
		t.Fatalf("exit %d\n%s", exit, out)
	}
	if len(delivered) != 1 || delivered[0].Status != 403 || !strings.Contains(string(delivered[0].Body), "lacks a permission") {
		t.Fatalf("the refusal was not delivered as the answer: %+v", delivered)
	}
}

// answersOfLocked is answersOf for use inside the script, which runs with the service's lock held.
func (s *fakeService) answersOfLocked(call receiveCall) []answer {
	var out []answer
	for _, sha := range call.Bundles {
		zip, err := gzip.NewReader(bytes.NewReader(s.blobs[sha]))
		if err != nil {
			s.t.Errorf("a bundle is not gzip: %v", err)
			continue
		}
		reader := bufio.NewReader(zip)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				break
			}
			var header struct {
				Request string `json:"request"`
				Status  int    `json:"status"`
				Size    int    `json:"size"`
			}
			_ = json.Unmarshal(line, &header)
			body := make([]byte, header.Size)
			_, _ = io.ReadFull(reader, body)
			_, _ = reader.ReadByte()
			out = append(out, answer{Request: header.Request, Status: header.Status, Body: body})
		}
	}
	return out
}

func TestPullGivesUpOnAStripeThatKeepsFailingWithoutSayingTheKey(t *testing.T) {
	fastRetries(t)
	stripe := startFakeStripe(t, func(request string) (int, string) {
		return 503, `{"error":{"message":"` + pullKeyValue + ` is why"}}`
	})
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		return receiveData(true, 0, 0, accountPath), 0, "", ""
	})
	exit, out, diagnostics := runPull(t, service.server.URL, stripe, withKey())
	if exit != 4 || !strings.Contains(out, "stripe_unreachable") {
		t.Fatalf("exit %d\n%s", exit, out)
	}
	if got := len(stripe.requests()); got != pullAttempts {
		t.Fatalf("Stripe was asked %d times, want %d", got, pullAttempts)
	}
	if strings.Contains(out, pullKeyValue) || strings.Contains(diagnostics, pullKeyValue) {
		t.Fatal("the key was printed")
	}
}

func TestPullDeliversAnAnswerAgainWithoutAskingStripeAgainWhenTheServiceForgot(t *testing.T) {
	stripe := startFakeStripe(t, stripeStory)
	var again []answer
	var s *fakeService
	s = startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		switch n {
		case 1:
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		case 2:
			// The book moved to another process, which has nothing: it asks for the account again.
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		}
		again = s.answersOfLocked(call)
		return receiveData(false, 0, 0), 0, "", ""
	})
	exit, out, _ := runPull(t, s.server.URL, stripe, withKey())
	if exit != 0 {
		t.Fatalf("exit %d\n%s", exit, out)
	}
	if got := stripe.requests(); len(got) != 1 {
		t.Fatalf("Stripe was asked %v, want the account once", got)
	}
	if len(again) != 1 || again[0].Request != accountPath || string(again[0].Body) != `{"id":"acct_1"}` {
		t.Fatalf("the third call carried %+v, want the account again", again)
	}
}

func TestPullStopsWhenTheServiceKeepsAskingForWhatItWasGiven(t *testing.T) {
	stripe := startFakeStripe(t, stripeStory)
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		return receiveData(true, 0, 0, accountPath), 0, "", ""
	})
	exit, out, _ := runPull(t, service.server.URL, stripe, withKey())
	if exit != 3 || !strings.Contains(out, "stripe_pull_stalled") {
		t.Fatalf("exit %d\n%s", exit, out)
	}
	if len(service.calls) > 6 {
		t.Fatalf("%d calls before it stopped", len(service.calls))
	}
	if len(stripe.requests()) != 1 {
		t.Fatalf("Stripe was asked %v", stripe.requests())
	}
}

func TestPullStopsWhenTheServiceIsNotFinishedAndAsksForNothing(t *testing.T) {
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		return receiveData(true, 0, 0), 0, "", ""
	})
	exit, out, _ := runPull(t, service.server.URL, nil, withKey())
	if exit != 3 || !strings.Contains(out, "stripe_pull_stalled") {
		t.Fatalf("exit %d\n%s", exit, out)
	}
}

func TestPullSaysWhenTheServiceIsOlderThanTheCommandLine(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_ = json.NewEncoder(w).Encode(map[string]any{"version": api.Version, "bookId": "local-book", "ok": false,
			"error": map[string]any{"code": "route_not_found", "message": "Application operation not found", "details": []any{}, "retryable": false}})
	}))
	defer service.Close()
	exit, out, _ := runPull(t, service.URL, nil, withKey())
	if exit != 3 || !strings.Contains(out, "stripe_pull_unavailable") || !strings.Contains(out, "older than this command line") {
		t.Fatalf("exit %d\n%s", exit, out)
	}
}

func TestPullWaitsAndTriesAgainWhenTheWorkspaceSaysItIsLimitingRequests(t *testing.T) {
	fastRetries(t)
	stripe := startFakeStripe(t, stripeStory)
	refused := 0
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		if refused < 2 {
			refused++
			return "", 429, "rate_limited", "Too many requests for this book; slow down and try again in a moment."
		}
		if len(call.Bundles) == 0 {
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		}
		return receiveData(false, 0, 0), 0, "", ""
	})
	exit, out, _ := runPull(t, service.server.URL, stripe, withKey())
	if exit != 0 || refused != 2 {
		t.Fatalf("exit %d after %d refusals\n%s", exit, refused, out)
	}
}

func TestPullCarriesManyAnswersInSeveralCallsWithinTheLimitsOfACall(t *testing.T) {
	// Two hundred lists of two pages each: four hundred answers. With a bundle made to hold two, that
	// is two hundred bundles, which a call may not carry more than twenty of.
	was := pullBundleBytes
	pullBundleBytes = 100
	t.Cleanup(func() { pullBundleBytes = was })
	stripe := startFakeStripe(t, func(request string) (int, string) {
		if strings.Contains(request, "starting_after") {
			return 200, `{"object":"list","data":[{"id":"txn_b"}],"has_more":false}`
		}
		return 200, `{"object":"list","data":[{"id":"txn_a"}],"has_more":true}`
	})
	var needs []string
	for n := 100; n < 300; n++ {
		needs = append(needs, fmt.Sprintf("/v1/balance_transactions?limit=100&payout=po_%d", n))
	}
	var s *fakeService
	delivered := 0
	s = startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		if n == 1 {
			return receiveData(true, 0, 0, needs...), 0, "", ""
		}
		if len(call.Bundles) > pullBundlesPerCall {
			t.Errorf("call %d carried %d bundles", n, len(call.Bundles))
		}
		delivered += len(s.answersOfLocked(call))
		if delivered < 400 {
			// Not finished, and nothing to ask: it only wants the rest of what it was sent.
			return receiveData(true, 0, 0), 0, "", ""
		}
		return receiveData(false, 200, 400), 0, "", ""
	})
	exit, out, _ := runPull(t, s.server.URL, stripe, withKey())
	if exit != 0 {
		t.Fatalf("exit %d\n%s", exit, out)
	}
	if delivered != 400 {
		t.Fatalf("%d answers delivered, want 400", delivered)
	}
	if len(s.calls) < 3 {
		t.Fatalf("%d calls: the answers cannot have fitted in fewer", len(s.calls))
	}
	for _, body := range s.bodies {
		if len(body) > 128*1024 && !strings.HasPrefix(body, "\x1f\x8b") {
			t.Fatalf("a request of %d bytes", len(body))
		}
	}
}

func TestPullTakesNoOptionsItDoesNotKnow(t *testing.T) {
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		return receiveData(false, 0, 0), 0, "", ""
	})
	for _, args := range [][]string{{"--key", "x"}, {"extra"}, {"--concurrency", "0"}, {"--concurrency", "17"}, {"--test-mode=maybe"}, {"--operation-id", "5b0e2d8e-8d0d-4d4b-9d3a-1a2b3c4d5e6f"}} {
		exit, _, _ := runPull(t, service.server.URL, nil, withKey(), args...)
		if exit != 2 {
			t.Fatalf("%v: exit %d, want a usage error", args, exit)
		}
	}
	if len(service.calls) != 0 {
		t.Fatal("the service was called")
	}
}

// listStory answers the first page of each list the lane reads in bulk, and the second.
func listStory(request string) (int, string) {
	for _, path := range []string{"/v1/payouts", "/v1/checkout/sessions", "/v1/invoice_payments"} {
		if !strings.HasPrefix(request, path+"?") {
			continue
		}
		if strings.Contains(request, "starting_after=x_2") {
			return 200, `{"object":"list","data":[{"id":"x_3"}],"has_more":false}`
		}
		return 200, `{"object":"list","data":[{"id":"x_1"},{"id":"x_2"}],"has_more":true}`
	}
	if request == accountPath {
		return 200, `{"id":"acct_1"}`
	}
	return 404, `{"error":{"message":"No such thing."}}`
}

func TestPullReadsOnThroughEveryListTheLaneReadsInBulk(t *testing.T) {
	const query = "?created%5Bgte%5D=1000&created%5Blt%5D=2000&limit=100"
	stripe := startFakeStripe(t, listStory)
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		switch n {
		case 1:
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		case 2:
			return receiveData(true, 0, 0, "/v1/payouts"+query, "/v1/checkout/sessions"+query, "/v1/invoice_payments"+query), 0, "", ""
		}
		return receiveData(false, 1, 4), 0, "", ""
	})
	exit, out, diagnostics := runPull(t, service.server.URL, stripe, withKey())
	if exit != 0 {
		t.Fatalf("exit %d\n%s\n%s", exit, out, diagnostics)
	}
	asked := strings.Join(stripe.requests(), "\n")
	for _, path := range []string{"/v1/payouts", "/v1/checkout/sessions", "/v1/invoice_payments"} {
		next := path + query + "&starting_after=x_2"
		if !strings.Contains(asked, next) {
			t.Errorf("%s was not read on to its second page; Stripe was asked for:\n%s", path, asked)
		}
	}
}

func TestLaneRequestAcceptsOnlyWhatTheLaneReads(t *testing.T) {
	for _, ok := range []string{"/v1/account", "/v1/balance", "/v1/balance_transactions?limit=100", "/v1/payouts/po_1AbC", "/v1/payouts?limit=100&created%5Bgte%5D=1767225600&created%5Blt%5D=1769904000", "/v1/checkout/sessions?payment_intent=pi_1&limit=10", "/v1/checkout/sessions?limit=100&created%5Bgte%5D=1767225600&created%5Blt%5D=1769904000", "/v1/invoice_payments?limit=10&expand%5B%5D=data.invoice"} {
		if _, lane := laneRequest(ok); !lane {
			t.Errorf("%s was refused", ok)
		}
	}
	for _, no := range []string{"/v1/payouts/", "/v1/payouts/po", "/v1/payouts/po_1/cancel", "/v1/accounts", "/v1/refunds", "/v1/transfers", "/v1/checkout/sessions/cs_1", "/v1/", "v1/account", ""} {
		if _, lane := laneRequest(no); lane {
			t.Errorf("%s was accepted", no)
		}
	}
}

func TestPullSaysItsAnswersAreTestModeWhenTheKeyIsATestKey(t *testing.T) {
	stripe := startFakeStripe(t, stripeStory)
	service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
		if n == 1 {
			return receiveData(true, 0, 0, accountPath), 0, "", ""
		}
		return receiveData(false, 0, 0), 0, "", ""
	})
	env := map[string]string{stripeKeyVariable: "rk_" + "test_AbCdEfGhIjKlMnOpQrStUvWx"}
	exit, out, diagnostics := runPull(t, service.server.URL, stripe, env, "--test-mode=true")
	if exit != 0 {
		t.Fatalf("exit %d\n%s\n%s", exit, out, diagnostics)
	}
	if len(service.calls) == 0 {
		t.Fatal("the service was not called")
	}
	for _, call := range service.calls {
		if call.LiveMode == nil || *call.LiveMode {
			t.Fatalf("a call did not say its answers are Stripe's test mode: %+v", call)
		}
	}
}

func TestPullSaysWhatToDoWhenStripeHasNoPayoutToBook(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		args []string
		test bool
	}{
		{"live", withKey(), nil, false},
		{"test mode", map[string]string{stripeKeyVariable: "rk_" + "test_AbCdEfGhIjKlMnOpQrStUvWx"}, []string{"--test-mode=true"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stripe := startFakeStripe(t, stripeStory)
			service := startFakeService(t, func(n int, call receiveCall) (string, int, string, string) {
				return receiveData(false, 0, 0), 0, "", ""
			})
			exit, out, diagnostics := runPull(t, service.server.URL, stripe, c.env, c.args...)
			if exit != 0 {
				t.Fatalf("exit %d\n%s\n%s", exit, out, diagnostics)
			}
			if !strings.Contains(diagnostics, "Stripe had no payout to book this time.") {
				t.Fatalf("an empty pull said nothing of it:\n%s", diagnostics)
			}
			if got := strings.Contains(diagnostics, "make a test payment"); got != c.test {
				t.Fatalf("the test-mode hint appeared=%v, want %v:\n%s", got, c.test, diagnostics)
			}
		})
	}
}

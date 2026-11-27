package cli

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// rastrata stripe pull: Stripe, for a workspace that holds no Stripe key.
//
// A hosted workspace has many books on one service and, on purpose, no customer's secret. This
// command reads Stripe from the customer's own computer, with a restricted read-only key that stays in
// this process and goes to api.stripe.com and nowhere else, and delivers Stripe's answers to the
// workspace (stripe.receive), which books them the way stripe.sync does: one entry in the Inbox for
// each payout, with its transactions as evidence.
//
// The command knows nothing about Stripe's data. The service says which requests it needs answered
// (a path and its query); the command makes each one, if it is one of the few the lane reads, packs
// the exact bytes of the answers into a bundle (a gzip file), uploads it (POST /v1/uploads), delivers
// it, and asks again, until the service needs nothing more. A list is read on to its next page
// without being asked, which only saves a round: the service would ask for it next. Nothing is posted
// and nothing in Stripe is changed.
//
//	rastrata stripe pull [--test-mode=true] [--concurrency N]
//
// The key is read from the RASTRATA_STRIPE_KEY environment variable and is never an argument, never
// printed and never sent to the service.
func init() {
	Register(Command{
		Name:    "stripe pull",
		Summary: "Stripe, for a workspace that holds no key: read Stripe from this computer with the read-only key in RASTRATA_STRIPE_KEY and book it, one Inbox entry per payout [--test-mode=true] [--concurrency N]",
		Run:     runStripePull,
	})
}

const (
	stripeKeyVariable = "RASTRATA_STRIPE_KEY"
	stripeURLVariable = "RASTRATA_STRIPE_API_URL"
	stripeOrigin      = "https://api.stripe.com"
	// pullMaxRounds bounds a pull so that a service that never stops asking cannot keep it going.
	pullMaxRounds = 1000
	// A call delivers at most this many bundles, and a bundle holds at most this many answers.
	pullBundlesPerCall   = 20
	pullAnswersPerBundle = 500
	pullAttempts         = 4
	pullServiceAttempts  = 6
	pullMaxBody          = 16 * 1024 * 1024
	// A request the service asks for again right after being given its answer is a fault; it is
	// given the answer again twice and then the pull stops.
	pullMaxRepeats = 2
)

// pullBackoff is the first wait before Stripe is asked again after it limited requests or had a fault,
// and pullServiceBackoff the same for the workspace when it said it was busy; both grow each time.
// Variables so that a test need not wait. pullBundleBytes is how much of Stripe's answers one bundle
// holds before another is begun.
var (
	pullBackoff        = 250 * time.Millisecond
	pullServiceBackoff = time.Second
	pullBundleBytes    = 4 * 1024 * 1024
)

var (
	stripeKeyShape     = regexp.MustCompile(`^(rk|sk)_(live|test)_[A-Za-z0-9]{16,250}$`)
	stripeVersionShape = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z]{1,20})?$`)
	// The requests the lane makes of Stripe. The command makes no other, whoever asks.
	stripeLanePaths = []*regexp.Regexp{
		regexp.MustCompile(`^/v1/account$`),
		regexp.MustCompile(`^/v1/balance$`),
		regexp.MustCompile(`^/v1/balance_transactions$`),
		regexp.MustCompile(`^/v1/payouts$`),
		regexp.MustCompile(`^/v1/payouts/[A-Za-z0-9_]{3,100}$`),
		regexp.MustCompile(`^/v1/checkout/sessions$`),
		regexp.MustCompile(`^/v1/invoice_payments$`),
	}
)

// stripeLists are the lists the command reads on through without being asked: the service would
// ask for each next page in the round after.
var stripeLists = map[string]bool{
	"/v1/balance_transactions": true,
	"/v1/checkout/sessions":    true,
	"/v1/invoice_payments":     true,
	"/v1/payouts":              true,
}

// laneRequest parses a request the service named and says whether it is one the lane makes.
func laneRequest(request string) (*url.URL, bool) {
	if len(request) > 800 || !strings.HasPrefix(request, "/v1/") || strings.HasPrefix(request, "//") {
		return nil, false
	}
	parsed, err := url.Parse(request)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" || parsed.Fragment != "" || parsed.User != nil {
		return nil, false
	}
	for _, path := range stripeLanePaths {
		if path.MatchString(parsed.EscapedPath()) && parsed.EscapedPath() == parsed.Path {
			return parsed, true
		}
	}
	return nil, false
}

// stripeBase is Stripe's address, or the one named for a test: only an http address on this machine.
func stripeBase(override string) (string, error) {
	override = strings.TrimSpace(override)
	if override == "" {
		return stripeOrigin, nil
	}
	parsed, err := url.Parse(override)
	loopback := err == nil && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1")
	if err != nil || parsed.Scheme != "http" || !loopback || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%s must be an http address on this computer (127.0.0.1, localhost or [::1]). The Stripe key is never sent anywhere else", stripeURLVariable)
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// pullKey checks the key before anything leaves the computer. The message never repeats it.
func pullKey(key string, testMode bool) string {
	key = strings.TrimSpace(key)
	switch {
	case key == "":
		return "There is no Stripe key. Create a restricted key in the Stripe dashboard with Read access to what the pull needs (see the how-to Book Stripe in a hosted workspace), and put it in the " + stripeKeyVariable + " environment variable of this computer, outside any chat. Rastrata never sees it."
	case !stripeKeyShape.MatchString(key):
		return "The value of " + stripeKeyVariable + " is not a Stripe API key. Use a restricted key: it starts with rk_live_."
	case strings.HasPrefix(key, "sk_"):
		return "That is an unrestricted secret key. Rastrata only reads from Stripe, so create a restricted key with Read access only and use that: if it ever leaked it could not move money."
	case strings.Contains(key, "_test_") && !testMode:
		return "That is a test-mode key: what it reads is not your real sales, and it would be booked as if it were. Use your live restricted key (rk_live_), or add --test-mode=true to book test data on purpose."
	}
	return ""
}

// answer is what Stripe said to one request, byte for byte.
type answer struct {
	Request string
	Status  int
	Body    []byte
}

// bundleOf packs answers as the service reads them, in a gzip file: for each, a line of JSON
// {request, status, size}, then size bytes exactly as Stripe sent them, then a newline.
func bundleOf(answers []*answer) ([]byte, error) {
	var out bytes.Buffer
	zip := gzip.NewWriter(&out)
	for _, a := range answers {
		header, err := json.Marshal(struct {
			Request string `json:"request"`
			Status  int    `json:"status"`
			Size    int    `json:"size"`
		}{a.Request, a.Status, len(a.Body)})
		if err != nil {
			return nil, err
		}
		for _, part := range [][]byte{header, {'\n'}, a.Body, {'\n'}} {
			if _, err := zip.Write(part); err != nil {
				return nil, err
			}
		}
	}
	if err := zip.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

type receiveReply struct {
	Run struct {
		Payouts        int      `json:"payouts"`
		NewLines       int      `json:"newLines"`
		DuplicateLines int      `json:"duplicateLines"`
		HeldLines      int      `json:"heldLines"`
		Through        *string  `json:"through"`
		Notes          []string `json:"notes"`
	} `json:"run"`
	More       bool            `json:"more"`
	Balance    json.RawMessage `json:"balance"`
	Needs      []string        `json:"needs"`
	APIVersion string          `json:"apiVersion"`
}

// stripePull is one pull: the key, the clients of Stripe and of the service, and what has been
// fetched so far.
type stripePull struct {
	runner  Runner
	options Options
	service *api.Client
	stripe  *http.Client
	origin  string
	key     string
	// live says whether the key reads Stripe's live mode (real sales) or its test mode. The workspace keeps the mode of the first data it takes and turns the other away.
	live    bool
	version string
	asOf    string
	workers int
	// cache holds every answer of this pull by the request the service named, so that a request the
	// service asks for again (it forgot, because another process took the book) is not made twice.
	cache map[string]*answer
	// pages remembers, for a list read page by page, what it takes to read on.
	pages map[string]nextPage
	mutex sync.Mutex
	made  int
}

type nextPage struct {
	more bool
	last string
}

func runStripePull(r Runner, ctx context.Context, o Options, c *api.Client) int {
	const usage = "stripe pull [--test-mode=true] [--concurrency N]"
	if len(o.Args) != 2 {
		return stripeUsage(r, o, "stripe pull takes no arguments", usage)
	}
	if problem := stripeFlagProblem(o, []string{"test-mode", "concurrency"}, []string{"concurrency"}); problem != "" {
		return stripeUsage(r, o, problem, usage)
	}
	if o.OperationID != "" {
		return stripeUsage(r, o, "a pull makes many calls and has no one operation identity", usage)
	}
	testMode := false
	switch o.Flags["test-mode"] {
	case "", "false":
	case "true":
		testMode = true
	default:
		return stripeUsage(r, o, "--test-mode is true or false; write --test-mode=true", usage)
	}
	workers := 6
	if value, given, failed := stripeInteger(r, o, "concurrency", 1, 16); failed != 0 {
		return failed
	} else if given {
		workers = value
	}
	key := os.Getenv(stripeKeyVariable)
	if problem := pullKey(key, testMode); problem != "" {
		return r.localError(o, "stripe_key_unusable", problem, 3)
	}
	origin, err := stripeBase(os.Getenv(stripeURLVariable))
	if err != nil {
		return r.localError(o, "usage_error", err.Error(), 2)
	}
	pull := &stripePull{
		runner:  r,
		options: o,
		service: c,
		origin:  origin,
		key:     strings.TrimSpace(key),
		live:    !strings.Contains(key, "_test_"),
		asOf:    time.Now().UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z"),
		workers: workers,
		cache:   map[string]*answer{},
		pages:   map[string]nextPage{},
		stripe: &http.Client{
			Timeout: 45 * time.Second,
			// The key goes to Stripe and is never followed anywhere else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Stripe redirects are not followed") },
		},
	}
	return pull.run(ctx)
}

// scrub removes the key from anything that is about to be said.
func (p *stripePull) scrub(text string) string {
	return strings.ReplaceAll(text, p.key, "[the Stripe key]")
}

func (p *stripePull) fail(code, message string, exit int) int {
	return p.runner.localError(p.options, code, p.scrub(message), exit)
}

type totals struct {
	rounds, payouts, newLines, duplicateLines, heldLines int
	through                                              *string
	notes                                                []string
	balance                                              json.RawMessage
}

func (t *totals) add(reply receiveReply) {
	t.payouts += reply.Run.Payouts
	t.newLines += reply.Run.NewLines
	t.duplicateLines += reply.Run.DuplicateLines
	t.heldLines += reply.Run.HeldLines
	if reply.Run.Through != nil {
		t.through = reply.Run.Through
	}
	for _, note := range reply.Run.Notes {
		known := false
		for _, have := range t.notes {
			known = known || have == note
		}
		if !known && len(t.notes) < 10 {
			t.notes = append(t.notes, note)
		}
	}
	if len(reply.Balance) > 0 && string(reply.Balance) != "null" {
		t.balance = reply.Balance
	}
}

func (p *stripePull) run(ctx context.Context) int {
	var sum totals
	var outbox []*answer
	queued := map[string]bool{}
	sentIn := map[string]int{}
	repeats := map[string]int{}
	idle := 0
	for round := 1; round <= pullMaxRounds; round++ {
		if ctx.Err() != nil {
			return p.fail("cancelled", "The pull was stopped. Nothing is lost: run it again and it carries on.", 4)
		}
		bundles, rest := cutBundles(outbox)
		outbox = rest
		for _, bundle := range bundles {
			for _, a := range bundle {
				delete(queued, a.Request)
				sentIn[a.Request] = round
			}
		}
		reply, exit, ok := p.call(ctx, bundles)
		if !ok {
			return exit
		}
		sum.rounds = round
		sum.add(reply)
		if reply.APIVersion != "" {
			if !stripeVersionShape.MatchString(reply.APIVersion) {
				return p.fail("response_invalid", "The service named a Stripe API version that is not one.", 4)
			}
			p.version = reply.APIVersion
		}
		if p.version == "" {
			return p.fail("response_invalid", "The service did not say which version of Stripe's API to ask in.", 4)
		}
		if len(reply.Needs) == 0 && !reply.More {
			break
		}
		if len(reply.Needs) == 0 {
			// The service ran out of time with work left and asked for nothing: it only wants calling again.
			if idle++; idle > 100 {
				return p.fail("stripe_pull_stalled", "The service keeps saying it is not finished and asking for nothing. Run the pull again later.", 3)
			}
			continue
		}
		idle = 0
		var fetch []string
		for _, need := range reply.Needs {
			if _, lane := laneRequest(need); !lane {
				return p.fail("stripe_request_refused", "The service asked for a request this command never makes ("+plain(truncate(need, 80))+"), so nothing more was fetched. Rastrata only reads balance transactions, payouts, the account, the balance and the tax figures of Checkout sessions and invoices.", 3)
			}
			if queued[need] {
				continue
			}
			have, cached := p.cache[need]
			if !cached {
				fetch = append(fetch, need)
				continue
			}
			if sentIn[need] == round {
				if repeats[need]++; repeats[need] > pullMaxRepeats {
					return p.fail("stripe_pull_stalled", "The service keeps asking for "+plain(truncate(need, 80))+" after being given it. Run the pull again; if it happens again, tell Rastrata.", 3)
				}
			}
			queued[need] = true
			outbox = append(outbox, have)
		}
		fetched, err := p.fetchAll(ctx, fetch)
		if err != nil {
			return p.fail("stripe_unreachable", err.Error(), 4)
		}
		for _, chain := range fetched {
			for _, a := range chain {
				if !queued[a.Request] {
					queued[a.Request] = true
					outbox = append(outbox, a)
				}
			}
		}
		if round%5 == 0 || round == 1 {
			fmt.Fprintf(p.runner.Diagnostics, "Stripe pull: round %d, %d requests made of Stripe so far, %d payouts booked.\n", round, p.made, sum.payouts)
		}
		if round == pullMaxRounds {
			return p.fail("stripe_pull_stalled", "The pull is still asking after "+strconv.Itoa(pullMaxRounds)+" rounds. Run it again; it carries on from where it was.", 3)
		}
	}
	fmt.Fprintf(p.runner.Diagnostics, "Stripe pull: done in %d rounds, %d requests made of Stripe: %d payouts booked, %d lines queued in the Inbox.\n", sum.rounds, p.made, sum.payouts, sum.newLines)
	if sum.payouts == 0 && sum.newLines == 0 && sum.duplicateLines == 0 && sum.heldLines == 0 {
		hint := "Stripe had no payout to book this time."
		if !p.live {
			hint += " In test mode a payout exists once you make a test payment and then pay out from the Balances page of the Stripe dashboard; run the pull again after that."
		}
		fmt.Fprintln(p.runner.Diagnostics, hint)
	}
	summary := map[string]any{
		"rounds":         sum.rounds,
		"stripeRequests": p.made,
		"payoutsBooked":  sum.payouts,
		"newLines":       sum.newLines,
		"alreadyKnown":   sum.duplicateLines,
		"heldLines":      sum.heldLines,
		"through":        sum.through,
		"notes":          sum.notes,
	}
	if len(sum.balance) > 0 {
		summary["balance"] = sum.balance
	} else {
		summary["balance"] = nil
	}
	data, _ := json.Marshal(summary)
	return p.runner.result(p.options, api.Response{Version: api.Version, BookID: p.options.BookID, OK: true, Data: data}, nil, "")
}

// cutBundles takes from the outbox the answers the next call will deliver, in bundles of at most
// pullBundleBytes and pullAnswersPerBundle each and at most pullBundlesPerCall of them, and returns
// what is left for the call after.
func cutBundles(outbox []*answer) (bundles [][]*answer, rest []*answer) {
	var current []*answer
	size := 0
	for index, a := range outbox {
		full := len(current) >= pullAnswersPerBundle || (len(current) > 0 && size+len(a.Body) > pullBundleBytes)
		if full {
			bundles = append(bundles, current)
			current, size = nil, 0
			if len(bundles) == pullBundlesPerCall {
				return bundles, outbox[index:]
			}
		}
		current = append(current, a)
		size += len(a.Body)
	}
	if len(current) > 0 {
		bundles = append(bundles, current)
	}
	return bundles, nil
}

// retrying does a call to the workspace again, after a wait that grows, when the workspace said it
// was busy or was limiting requests (a book is allowed some thirty a second), or the answer was lost on
// the way. A call here is safe to repeat: an upload is addressed by what it holds, and delivering the
// same answers twice changes nothing.
func (p *stripePull) retrying(ctx context.Context, do func() error) error {
	for attempt := 1; ; attempt++ {
		err := do()
		var failure *api.Error
		if err == nil || !errors.As(err, &failure) || failure.Response.Error == nil || !failure.Response.Error.Retryable || attempt >= pullServiceAttempts {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(pullServiceBackoff * time.Duration(attempt)):
		}
	}
}

func (p *stripePull) call(ctx context.Context, bundles [][]*answer) (receiveReply, int, bool) {
	shas := []string{}
	for _, bundle := range bundles {
		packed, err := bundleOf(bundle)
		if err != nil {
			return receiveReply{}, p.fail("client_error", err.Error(), 4), false
		}
		var receipt api.Receipt
		err = p.retrying(ctx, func() (failed error) {
			receipt, failed = p.service.UploadStripeBundle(ctx, packed, "stripe answers")
			return failed
		})
		if err != nil {
			return receiveReply{}, p.runner.result(p.options, api.Response{}, err, ""), false
		}
		shas = append(shas, receipt.SHA256)
	}
	var response api.Response
	err := p.retrying(ctx, func() (failed error) {
		response, failed = p.service.Call(ctx, "stripe.receive", map[string]any{"asOf": p.asOf, "bundles": shas, "livemode": p.live}, "")
		return failed
	})
	if err != nil {
		var failure *api.Error
		if errors.As(err, &failure) && failure.Response.Error != nil {
			switch failure.Response.Error.Code {
			case "route_not_found", "unknown_operation":
				return receiveReply{}, p.fail("stripe_pull_unavailable", "This workspace's service is older than this command line and cannot take a Stripe pull yet. Update the service, or use an older command line.", 3), false
			}
		}
		return receiveReply{}, p.runner.result(p.options, response, err, ""), false
	}
	var reply receiveReply
	if err := json.Unmarshal(response.Data, &reply); err != nil {
		return receiveReply{}, p.fail("response_invalid", "The service's reply to the pull could not be read.", 4), false
	}
	return reply, 0, true
}

// fetchAll makes each request, at most workers at a time, and returns for each the answers it
// produced (more than one when a list was read on), in the order the requests were given.
func (p *stripePull) fetchAll(ctx context.Context, requests []string) ([][]*answer, error) {
	results := make([][]*answer, len(requests))
	if len(requests) == 0 {
		return results, nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var failed error
	var once sync.Once
	work := make(chan int)
	var group sync.WaitGroup
	for range min(p.workers, len(requests)) {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range work {
				chain, err := p.answerFor(ctx, requests[index])
				if err != nil {
					once.Do(func() { failed = err; cancel() })
					continue
				}
				results[index] = chain
			}
		}()
	}
	for index := range requests {
		work <- index
	}
	close(work)
	group.Wait()
	if failed != nil {
		return nil, failed
	}
	return results, nil
}

// answerFor makes one request and, for a list that says there is more, reads on to the next page
// the way the service would ask for it.
func (p *stripePull) answerFor(ctx context.Context, request string) ([]*answer, error) {
	var chain []*answer
	for page := 0; page < 10000; page++ {
		a, err := p.fetchOne(ctx, request)
		if err != nil {
			return nil, err
		}
		chain = append(chain, a)
		p.mutex.Lock()
		more := p.pages[request]
		p.mutex.Unlock()
		if !more.more || more.last == "" {
			return chain, nil
		}
		parsed, _ := laneRequest(request)
		values := parsed.Query()
		values.Set("starting_after", more.last)
		request = parsed.Path + "?" + values.Encode()
	}
	return nil, errors.New("A list of Stripe's went on for more than ten thousand pages.")
}

func (p *stripePull) fetchOne(ctx context.Context, request string) (*answer, error) {
	parsed, lane := laneRequest(request)
	if !lane {
		return nil, fmt.Errorf("%q is not a request this command makes", plain(truncate(request, 80)))
	}
	status, body, err := p.get(ctx, request)
	if err != nil {
		return nil, err
	}
	a := &answer{Request: request, Status: status, Body: body}
	p.mutex.Lock()
	p.cache[request] = a
	p.mutex.Unlock()
	if status == http.StatusOK && stripeLists[parsed.Path] {
		var list struct {
			Object  string `json:"object"`
			HasMore bool   `json:"has_more"`
			Data    []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &list) == nil && list.Object == "list" && list.HasMore && len(list.Data) > 0 {
			p.mutex.Lock()
			p.pages[request] = nextPage{more: true, last: list.Data[len(list.Data)-1].ID}
			p.mutex.Unlock()
		}
	}
	return a, nil
}

// get makes one read of Stripe, trying again when Stripe is limiting requests or has a fault. Any
// other answer is returned as it is: the service says what a refusal means, as the sync does.
func (p *stripePull) get(ctx context.Context, request string) (int, []byte, error) {
	var last string
	for attempt := 1; attempt <= pullAttempts; attempt++ {
		if attempt > 1 {
			select {
			case <-ctx.Done():
				return 0, nil, ctx.Err()
			case <-time.After(pullBackoff * time.Duration(1<<(attempt-2))):
			}
		}
		call, err := http.NewRequestWithContext(ctx, http.MethodGet, p.origin+request, nil)
		if err != nil {
			return 0, nil, err
		}
		call.Header.Set("Authorization", "Bearer "+p.key)
		call.Header.Set("Stripe-Version", p.version)
		call.Header.Set("Accept", "application/json")
		call.Header.Set("User-Agent", "rastrata-terminal/0.1")
		response, err := p.stripe.Do(call)
		if err != nil {
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			last = "Stripe could not be reached. Check the connection and run the pull again."
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, pullMaxBody+1))
		response.Body.Close()
		if readErr != nil {
			last = "Stripe's answer was cut off. Run the pull again."
			continue
		}
		if len(body) > pullMaxBody {
			return 0, nil, errors.New("Stripe's answer was larger than expected")
		}
		if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			last = "Stripe is limiting requests or had a fault. Wait a moment and run the pull again."
			if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 && seconds <= 10 {
				select {
				case <-ctx.Done():
					return 0, nil, ctx.Err()
				case <-time.After(time.Duration(seconds) * time.Second):
				}
			}
			continue
		}
		p.mutex.Lock()
		p.made++
		p.mutex.Unlock()
		return response.StatusCode, body, nil
	}
	return 0, nil, errors.New(last)
}

func truncate(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return text[:n] + "..."
}

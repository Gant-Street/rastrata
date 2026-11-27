package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Health is what GET /health says when Rastrata answers.
type Health struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
	Version string `json:"version"`
	// Warming is true while the service is reading the book for the first time since it started. It
	// answers, but whatever needs the book waits for the read to finish. An older service says nothing.
	Warming bool    `json:"warming"`
	Warmup  *Warmup `json:"warmup"`
}

// Warmup is what the service says about that read: how far it has got while it is reading ("reading"),
// how long it took ("ready"), or why it could not ("failed").
type Warmup struct {
	State       string   `json:"state"`
	Done        *int64   `json:"done"`
	Total       *int64   `json:"total"`
	SecondsLeft *float64 `json:"secondsLeft"`
	Entries     int64    `json:"entries"`
	Seconds     float64  `json:"seconds"`
	Error       string   `json:"error"`
}

// Reading is true while the service is reading the book.
func (h Health) Reading() bool { return h.Warming && h.Warmup != nil && h.Warmup.State == "reading" }

// ReadFailure is why the service could not read the book, and whether it could not.
func (h Health) ReadFailure() (string, bool) {
	if h.Warmup == nil || h.Warmup.State != "failed" {
		return "", false
	}
	return h.Warmup.Error, true
}

// ReadingNote says what the service is doing and about how long it has still to do it, in the words
// the rest of the command uses ("reading your books, about 40 seconds"). It is empty when the service
// is not reading.
func (h Health) ReadingNote() string {
	if !h.Reading() {
		return ""
	}
	left := h.Warmup.SecondsLeft
	switch {
	case left == nil:
		return "reading your books"
	case *left < 5:
		return "reading your books, almost done"
	}
	return "reading your books, " + about(*left)
}

var (
	// ErrNotRunning is what a health check says when nothing accepts the connection.
	ErrNotRunning = errors.New("nothing is listening")
	// ErrOtherProgram is what it says when something answers that is not Rastrata.
	ErrOtherProgram = errors.New("something other than Rastrata answers")
)

// Endpoint is the address of the service on a port.
func Endpoint(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

// NewHealthClient is a client for the loopback service: a timeout, and no redirects, which the
// service never sends. Nothing listening is refused at once, whatever the timeout; it is for a service
// that is up but busy. One that is reading its book answers between pages of it, and on a big book on a
// busy computer a page takes a second or more, so two seconds would call it down.
func NewHealthClient() *http.Client {
	return &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// CheckHealth asks the service at endpoint whether it is up, and which release it is.
func CheckHealth(ctx context.Context, client *http.Client, endpoint string) (Health, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/health", nil)
	if err != nil {
		return Health{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return Health{}, fmt.Errorf("%w at %s", ErrNotRunning, endpoint)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	var health Health
	if err != nil || response.StatusCode != http.StatusOK || json.Unmarshal(body, &health) != nil || !health.OK || health.Service != "rastrata" {
		return Health{}, fmt.Errorf("%w at %s", ErrOtherProgram, endpoint)
	}
	return health, nil
}

// WaitHealthy polls until the service answers, the context ends or the timeout passes.
func WaitHealthy(ctx context.Context, client *http.Client, endpoint string, timeout, step time.Duration) (Health, error) {
	deadline := time.Now().Add(timeout)
	for {
		health, err := CheckHealth(ctx, client, endpoint)
		if err == nil {
			return health, nil
		}
		if errors.Is(err, ErrOtherProgram) || time.Now().After(deadline) || ctx.Err() != nil {
			return Health{}, err
		}
		select {
		case <-ctx.Done():
			return Health{}, ctx.Err()
		case <-time.After(step):
		}
	}
}

// WaitStopped polls until nothing answers on the endpoint any more, or the timeout passes.
func WaitStopped(ctx context.Context, client *http.Client, endpoint string, timeout, step time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if _, err := CheckHealth(ctx, client, endpoint); errors.Is(err, ErrNotRunning) {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return fmt.Errorf("the service at %s is still answering", endpoint)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(step):
		}
	}
}

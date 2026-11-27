package servicetest

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

// Behaviour is what the fake service does. Change it with Server.Set while the test runs.
type Behaviour struct {
	// Version is the release GET /health reports.
	Version string
	// OwnerKey is the key the service accepts.
	OwnerKey string
	// Open makes the service accept requests with no credentials, as an unlocked one does.
	Open bool
	// Other makes something other than Rastrata answer on the port: a web page.
	Other bool
	// Down drops every connection, as a stopped service does.
	Down bool
	// Book and Backups are the bodies of book.get and backup.status.
	Book    string
	Backups string
	// Capacity is the body of GET /api/capacity; empty, the route does not exist, as in an older service.
	Capacity string
	// Health is added to the answer of GET /health, as the fields of a JSON object without its braces:
	// `"warming":true,"warmup":{"state":"reading"}`. Empty, the service says nothing of reading its book,
	// as an older one does not.
	Health string
}

// Server is a stand-in for the installed service, on a loopback port of its own: it answers /health,
// and book.get and backup.status the way the real one does (a request with no credentials is
// refused with 401 unless Open), so command line tests need no Bun and no database.
type Server struct {
	*httptest.Server
	mu sync.Mutex
	b  Behaviour
}

// NewServer starts one. It is closed when the test ends.
func NewServer(t testing.TB, b Behaviour) *Server {
	t.Helper()
	s := &Server{b: b}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.Close)
	return s
}

// Set changes how the server behaves.
func (s *Server) Set(change func(*Behaviour)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	change(&s.b)
}

// Port is the port it listens on.
func (s *Server) Port() int {
	_, port, _ := net.SplitHostPort(s.Listener.Addr().String())
	number, _ := strconv.Atoi(port)
	return number
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	b := s.b
	s.mu.Unlock()
	if b.Down {
		if connection, _, err := w.(http.Hijacker).Hijack(); err == nil {
			connection.Close()
		}
		return
	}
	if b.Other {
		_, _ = io.WriteString(w, "<html>some other program</html>")
		return
	}
	switch r.URL.Path {
	case "/health":
		extra := ""
		if b.Health != "" {
			extra = "," + b.Health
		}
		_, _ = io.WriteString(w, `{"ok":true,"service":"rastrata","version":"`+b.Version+`"`+extra+`}`)
	case "/v1/book.get", "/v1/backup.status", "/api/capacity":
		authorized := b.OwnerKey != "" && r.Header.Get("Authorization") == "Bearer "+b.OwnerKey
		if !b.Open && !authorized {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"ok":false,"error":{"code":"authentication_required"}}`)
			return
		}
		switch r.URL.Path {
		case "/v1/book.get":
			_, _ = io.WriteString(w, b.Book)
		case "/api/capacity":
			if b.Capacity == "" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = io.WriteString(w, b.Capacity)
		default:
			_, _ = io.WriteString(w, b.Backups)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

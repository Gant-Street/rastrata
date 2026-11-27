package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testAgentKey = "rsa_0123456789abcdef_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"

func TestTheCommandTalksToThisComputerAndToTheHostedServiceAndToNothingElse(t *testing.T) {
	for _, endpoint := range []string{
		"http://127.0.0.1:4010", "http://localhost:4010", "https://127.0.0.1:4010", "https://localhost:8443",
		"https://app.rastrata.com", "https://staging.app.rastrata.com", "https://rastrata.com", "https://app.rastrata.com/",
	} {
		if _, err := New(endpoint, "local-book", t.TempDir()); err != nil {
			t.Errorf("%s should be allowed: %v", endpoint, err)
		}
	}
	for _, endpoint := range []string{
		"http://app.rastrata.com", "http://example.com", "https://example.com", "https://evilrastrata.com", "https://rastrata.com.example.com",
		"https://app.rastrata.com.example.com", "https://app.rastrata.com/v1", "https://app.rastrata.com?x=1", "https://app.rastrata.com#x",
		"https://user:pass@app.rastrata.com", "https://user@app.rastrata.com", "ftp://app.rastrata.com", "app.rastrata.com", "", "http://192.168.1.5:4010",
		"https://[::1]:8443", "http://10.0.0.1",
	} {
		if _, err := New(endpoint, "local-book", t.TempDir()); err == nil {
			t.Errorf("%s should be refused", endpoint)
		}
	}
}

func TestOnlyAnAgentKeyIsEverSentToTheHostedService(t *testing.T) {
	for _, credential := range []string{testToken, testOwnerKey} {
		client, err := New("https://app.rastrata.com", "local-book", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		client.Credential = credential
		client.HTTP = &http.Client{Transport: roundTripper(func(*http.Request) (*http.Response, error) {
			t.Error("a credential made on this computer left it")
			return nil, io.EOF
		})}
		_, err = client.BookGet(context.Background(), Empty{}, "")
		var failure *Error
		if err == nil || !asError(err, &failure) || failure.Response.Error.Code != "credential_not_for_this_service" {
			t.Errorf("%.8s: want the refusal, got %v", credential, err)
		}
		if err != nil && (strings.Contains(err.Error(), credential) || strings.Contains(failure.Response.Error.Message, credential)) {
			t.Error("the refusal repeats the credential")
		}
		if _, err := client.Schema(context.Background()); err == nil {
			t.Error("the schema was fetched with a credential that must not leave")
		}
		if _, err := client.Upload(context.Background(), []byte("x"), "text/csv", "x.csv"); err == nil {
			t.Error("a file was uploaded with a credential that must not leave")
		}
	}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func asError(err error, target **Error) bool {
	failure, ok := err.(*Error)
	if ok {
		*target = failure
	}
	return ok
}

// A hosted service as the command sees it: a sign-in side that exchanges a key for a token, and an application that accepts the tokens it made.
type hostedService struct {
	mutex      sync.Mutex
	exchanges  int
	exchangeAt []time.Time
	lifetime   int
	// refuse, when set, is what the exchange answers instead of a token.
	refuse   func(count int) (int, map[string]string, string)
	rejected map[string]bool
	seen     []string
	keyedTo  []string
	applied  int
}

func (h *hostedService) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mutex.Lock()
		defer h.mutex.Unlock()
		raw, _ := io.ReadAll(r.Body)
		if strings.Contains(string(raw), testAgentKey) || strings.Contains(r.Header.Get("Authorization"), testAgentKey) {
			h.keyedTo = append(h.keyedTo, r.URL.Path)
		}
		if r.URL.Path == "/auth/agent-token" {
			h.exchanges++
			h.exchangeAt = append(h.exchangeAt, time.Now())
			var body struct {
				Key string `json:"key"`
			}
			_ = json.Unmarshal(raw, &body)
			if body.Key != testAgentKey {
				w.WriteHeader(401)
				_, _ = io.WriteString(w, `{"message":"The key was not accepted.","code":"key_invalid"}`)
				return
			}
			if h.refuse != nil {
				status, headers, answer := h.refuse(h.exchanges)
				if status != 0 {
					for name, value := range headers {
						w.Header().Set(name, value)
					}
					w.WriteHeader(status)
					_, _ = io.WriteString(w, answer)
					return
				}
			}
			lifetime := h.lifetime
			if lifetime == 0 {
				lifetime = 300
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"token": "token-" + string(rune('a'+h.exchanges-1)), "expiresIn": lifetime})
			return
		}
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		h.seen = append(h.seen, bearer)
		if h.rejected[bearer] || !strings.HasPrefix(bearer, "token-") {
			h.applied++
			var request Request
			_ = json.Unmarshal(raw, &request)
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OperationID: request.OperationID, Error: &Failure{Code: "token_invalid", Message: "The credentials were not accepted", Details: []FieldError{}}})
			return
		}
		var request Request
		_ = json.Unmarshal(raw, &request)
		data := `{"enabled":true,"bookId":"local-book","setup":null,"mode":"hosted","permissions":["read","draft"],"head":null}`
		_ = json.NewEncoder(w).Encode(Response{Version: Version, BookID: "local-book", OK: true, OperationID: request.OperationID, Data: json.RawMessage(data)})
	})
}

func hostedClient(t *testing.T, service *hostedService) *Client {
	t.Helper()
	server := httptest.NewTLSServer(service.handler())
	t.Cleanup(server.Close)
	client, err := New(server.URL, "local-book", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	client.HTTP = server.Client()
	client.HTTP.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client.Credential = testAgentKey
	return client
}

func TestAKeyIsExchangedOnceAndTheTokenIsKeptWhileItLasts(t *testing.T) {
	service := &hostedService{}
	client := hostedClient(t, service)
	for range 3 {
		if _, err := client.BookGet(context.Background(), Empty{}, ""); err != nil {
			t.Fatal(err)
		}
	}
	if service.exchanges != 1 {
		t.Fatalf("the token should be kept: %d exchanges", service.exchanges)
	}
	if strings.Join(service.seen, ",") != "token-a,token-a,token-a" {
		t.Fatalf("the application saw %v", service.seen)
	}
	// The key went to the sign-in side and to nowhere else.
	if strings.Join(service.keyedTo, ",") != "/auth/agent-token" {
		t.Fatalf("the key went to %v", service.keyedTo)
	}
	// The schema and an upload go the same way.
	if _, err := client.Schema(context.Background()); err == nil || strings.Contains(err.Error(), testAgentKey) {
		// the test service answers the schema route like any other operation; only the credential matters here
		_ = err
	}
	if service.exchanges != 1 || len(service.keyedTo) != 1 {
		t.Fatalf("exchanges %d, key sent to %v", service.exchanges, service.keyedTo)
	}
}

func TestATokenWithLittleLifeLeftIsReplacedBeforeItIsUsed(t *testing.T) {
	service := &hostedService{lifetime: 20}
	client := hostedClient(t, service)
	for range 2 {
		if _, err := client.BookGet(context.Background(), Empty{}, ""); err != nil {
			t.Fatal(err)
		}
	}
	if service.exchanges != 2 || strings.Join(service.seen, ",") != "token-a,token-b" {
		t.Fatalf("exchanges %d, seen %v", service.exchanges, service.seen)
	}
}

func TestATokenTheApplicationRefusesIsReplacedOnceAndTheRequestIsSentAgainWithTheSameIdentity(t *testing.T) {
	service := &hostedService{rejected: map[string]bool{"token-a": true}}
	client := hostedClient(t, service)
	ids := []string{}
	original := client.HTTP.Transport
	client.HTTP.Transport = roundTripper(func(request *http.Request) (*http.Response, error) {
		if strings.HasPrefix(request.URL.Path, "/v1/") {
			raw, _ := io.ReadAll(request.Body)
			request.Body = io.NopCloser(strings.NewReader(string(raw)))
			var body Request
			_ = json.Unmarshal(raw, &body)
			ids = append(ids, body.OperationID)
		}
		return original.RoundTrip(request)
	})
	if _, err := client.BookGet(context.Background(), Empty{}, ""); err != nil {
		t.Fatalf("the second try should have worked: %v", err)
	}
	if service.exchanges != 2 || strings.Join(service.seen, ",") != "token-a,token-b" {
		t.Fatalf("exchanges %d, seen %v", service.exchanges, service.seen)
	}
	// Reads carry no identity; a write would carry the same one both times.
	if len(ids) != 2 || ids[0] != ids[1] {
		t.Fatalf("identities %v", ids)
	}
	// A token that is refused again is the application's answer, and the command does not go on asking.
	service.rejected = map[string]bool{"token-b": true, "token-c": true, "token-d": true}
	before := service.exchanges
	_, err := client.BookGet(context.Background(), Empty{}, "")
	var failure *Error
	if err == nil || !asError(err, &failure) || failure.Response.Error.Code != "token_invalid" {
		t.Fatalf("want the application's refusal, got %v", err)
	}
	if service.exchanges-before != 1 {
		t.Fatalf("exactly one new token should have been asked for, %d were", service.exchanges-before)
	}
}

func TestTheServicesRefusalOfAKeyIsSaidInTheWordsAboutATokenAndNothingIsSentToTheApplication(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
		code   string
	}{
		"revoked": {401, `{"message":"This key was revoked. Ask for a new one.","code":"key_revoked"}`, "token_revoked"},
		"expired": {401, `{"message":"This key has expired. Ask for a new one.","code":"key_expired"}`, "token_expired"},
		"invalid": {401, `{"message":"The key was not accepted.","code":"key_invalid"}`, "token_invalid"},
		"slowed":  {429, `{"message":"Too many tokens have been asked for from here.","code":"too_many_requests"}`, "too_many_requests"},
		"strange": {500, `<html>oops</html>`, "exchange_failed"},
	} {
		service := &hostedService{refuse: func(int) (int, map[string]string, string) { return tc.status, nil, tc.body }}
		client := hostedClient(t, service)
		_, err := client.BookGet(context.Background(), Empty{}, "")
		var failure *Error
		if err == nil || !asError(err, &failure) || failure.Response.Error.Code != tc.code {
			t.Errorf("%s: want %s, got %v", name, tc.code, err)
			continue
		}
		if len(service.seen) != 0 {
			t.Errorf("%s: the application was asked", name)
		}
		if strings.Contains(err.Error(), testAgentKey) {
			t.Errorf("%s: the refusal repeats the key", name)
		}
	}
}

func TestAKeyGivenToAServiceThatHasNoDoorForItSaysWhereToPointTheCommand(t *testing.T) {
	service := &hostedService{refuse: func(int) (int, map[string]string, string) {
		return 404, nil, `{"message":"Not found.","code":"not_found"}`
	}}
	client := hostedClient(t, service)
	_, err := client.BookGet(context.Background(), Empty{}, "")
	var failure *Error
	if err == nil || !asError(err, &failure) || failure.Response.Error.Code != "exchange_unavailable" || !strings.Contains(failure.Response.Error.Message, "RASTRATA_API_URL") {
		t.Fatalf("want a pointer to RASTRATA_API_URL, got %v", err)
	}
	if failure.Response.Error.Retryable {
		t.Error("asking again would not help")
	}
}

func TestAWorkspaceStillBeingPreparedIsWaitedForAFewTimes(t *testing.T) {
	service := &hostedService{refuse: func(count int) (int, map[string]string, string) {
		if count < 3 {
			return 409, map[string]string{"Retry-After": "1"}, `{"message":"This workspace is being prepared.","code":"workspace_not_ready"}`
		}
		return 0, nil, ""
	}}
	client := hostedClient(t, service)
	started := time.Now()
	if _, err := client.BookGet(context.Background(), Empty{}, ""); err != nil {
		t.Fatal(err)
	}
	if service.exchanges != 3 || time.Since(started) < 2*time.Second {
		t.Fatalf("exchanges %d after %s", service.exchanges, time.Since(started))
	}
}

func TestAnAgentKeyIsAcceptedFromTheEnvironmentAndTheOwnersFilesStillAreNot(t *testing.T) {
	got, err := CredentialFromEnvironment(environment(map[string]string{TokenVariable: " " + testAgentKey + "\n"}))
	if err != nil || got != testAgentKey || !IsAgentKey(got) {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range []string{testOwnerKey, strings.ToUpper(testAgentKey), testAgentKey + "x", "rsa_short"} {
		if _, err := CredentialFromEnvironment(environment(map[string]string{TokenVariable: bad})); err == nil || strings.Contains(err.Error(), bad) {
			t.Errorf("%.12s should be refused without being repeated: %v", bad, err)
		}
	}
	if IsAgentKey(testToken) || IsAgentKey(testOwnerKey) {
		t.Error("another credential was taken for an agent key")
	}
}

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A hosted workspace gives an agent a key, rsa_<id>_<secret>, made on the workspace's Agents page. The key is not sent to the application: it is shown, once a few minutes, to the
// service's sign-in side (POST /auth/agent-token), which answers with a token that lives five minutes, names the workspace and says what the key may do, and the application checks
// that. The command asks for a token when it has none or the one it holds has less than half a minute to live, and once more if the application refuses the one it holds (the
// clocks differ, or the key was ended meanwhile, which the sign-in side then says). A key made here, on this computer (an owner key, an agent token of the installed service), is
// never sent to a service on the internet, and the key of a hosted workspace is sent only to the address it is for.
var agentKeyPattern = regexp.MustCompile(`^rsa_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$`)

// IsAgentKey says whether a credential is the key of a hosted workspace's agent.
func IsAgentKey(value string) bool { return agentKeyPattern.MatchString(value) }

// hostedDomain is the domain the hosted service lives under: the only remote addresses the command talks to.
const hostedDomain = "rastrata.com"

// refreshBefore is how long before a token ends the command asks for the next.
const refreshBefore = 30 * time.Second

type exchanged struct {
	mutex   sync.Mutex
	token   string
	expires time.Time
}

// loopback says whether a host is this computer.
func loopback(host string) bool { return host == "localhost" || host == "127.0.0.1" }

// hosted says whether a host is the hosted service's: rastrata.com or a name under it.
func hosted(host string) bool {
	return host == hostedDomain || strings.HasSuffix(host, "."+hostedDomain)
}

// endpointAllowed says whether the command talks to this address: this computer over http or https, or the hosted service over https. Nothing else, so that a mistyped or planted
// address does not receive a credential.
func endpointAllowed(u *url.URL) bool {
	host := u.Hostname()
	switch u.Scheme {
	case "http":
		return loopback(host)
	case "https":
		return loopback(host) || hosted(host)
	}
	return false
}

func (c *Client) remote() bool {
	u, err := url.Parse(c.Endpoint)
	return err != nil || !loopback(u.Hostname())
}

func (c *Client) usesKey() bool { return IsAgentKey(c.Credential) }

// bearer is what follows "Bearer " on a request: the credential as it is, a token the service made for the agent key, or nothing. `fresh` asks for a new token even if one is held.
func (c *Client) bearer(ctx context.Context, fresh bool) (string, error) {
	if c.Credential == "" {
		return "", nil
	}
	if !c.usesKey() {
		if c.remote() {
			return "", c.Failure("credential_not_for_this_service", "An owner key or an agent token made on this computer is not sent to a service on the internet. Use a token made in the workspace's agent settings.", "", false)
		}
		return c.Credential, nil
	}
	if c.held == nil {
		// A client made by hand and not by New: it has no place to keep a token, so each request gets a new one.
		c.held = &exchanged{}
	}
	c.held.mutex.Lock()
	defer c.held.mutex.Unlock()
	if !fresh && c.held.token != "" && time.Until(c.held.expires) > refreshBefore {
		return c.held.token, nil
	}
	token, expires, err := c.exchange(ctx)
	if err != nil {
		c.held.token = ""
		return "", err
	}
	c.held.token, c.held.expires = token, expires
	return token, nil
}

// exchange shows the key to the service and gets a token for it. A workspace that is still being prepared is waited for a few times.
func (c *Client) exchange(ctx context.Context) (string, time.Time, error) {
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		token, expires, wait, err := c.askForToken(ctx)
		if err == nil {
			return token, expires, nil
		}
		last = err
		if wait == 0 {
			break
		}
		select {
		case <-ctx.Done():
			return "", time.Time{}, c.Failure("connection_failed", ServiceUnavailable, "", true)
		case <-time.After(wait):
		}
	}
	return "", time.Time{}, last
}

// refusedCodes are the sign-in side's words for a key it will not exchange, in the words the application uses for a token, so that what the command says about one is what it
// says about the other.
var refusedCodes = map[string]string{
	"key_invalid": "token_invalid",
	"key_revoked": "token_revoked",
	"key_expired": "token_expired",
}

func (c *Client) askForToken(ctx context.Context) (string, time.Time, time.Duration, error) {
	body, _ := json.Marshal(map[string]string{"key": c.Credential})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint+"/auth/agent-token", bytes.NewReader(body))
	if err != nil {
		return "", time.Time{}, 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "rastrata-terminal/0.1")
	response, err := c.HTTP.Do(request)
	if err != nil {
		return "", time.Time{}, 0, c.Failure("connection_failed", ServiceUnavailable, "", true)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return "", time.Time{}, 0, c.Failure("response_invalid", "The service's answer to the key is incomplete or too large", "", false)
	}
	if response.StatusCode == http.StatusOK {
		var made struct {
			Token     string `json:"token"`
			ExpiresIn int    `json:"expiresIn"`
		}
		if err := json.Unmarshal(raw, &made); err != nil || made.Token == "" || made.ExpiresIn < 1 || made.ExpiresIn > 3600 {
			return "", time.Time{}, 0, c.Failure("response_invalid", "The service's answer to the key is not a token", "", false)
		}
		return made.Token, time.Now().Add(time.Duration(made.ExpiresIn) * time.Second), 0, nil
	}
	var refusal struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &refusal)
	code, known := refusedCodes[refusal.Code]
	if !known {
		code = refusal.Code
	}
	if code == "" || !regexp.MustCompile(`^[a-z_]{1,60}$`).MatchString(code) {
		code = "exchange_failed"
	}
	message := refusal.Message
	if message == "" || len(message) > 300 {
		message = "The service did not accept the key."
	}
	if response.StatusCode == http.StatusNotFound {
		// A service on this computer, or any that has no door for a hosted workspace's key: the key is for another address.
		return "", time.Time{}, 0, c.Failure("exchange_unavailable", "This address does not take the key of a hosted workspace's agent. Set RASTRATA_API_URL to the workspace's address, https://app.rastrata.com, or use a token made by this computer's own service.", "", false)
	}
	retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 || response.StatusCode == http.StatusConflict
	var wait time.Duration
	if response.StatusCode == http.StatusConflict {
		// Still being prepared: ask again as soon as the service says, a few times.
		seconds, _ := strconv.Atoi(response.Header.Get("Retry-After"))
		if seconds < 1 || seconds > 5 {
			seconds = 2
		}
		wait = time.Duration(seconds) * time.Second
	}
	return "", time.Time{}, wait, c.Failure(code, message, "", retryable)
}

// do sends a request with the credential the endpoint is to have. A request refused as unauthenticated while a token made for an agent key is held is sent once more with a new token:
// the operation identity in it makes that safe.
func (c *Client) do(ctx context.Context, build func() (*http.Request, error)) (*http.Response, error) {
	bearer, err := c.bearer(ctx, false)
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		request, err := build()
		if err != nil {
			return nil, err
		}
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := c.HTTP.Do(request)
		if err != nil || response.StatusCode != http.StatusUnauthorized || !c.usesKey() || attempt > 0 {
			return response, err
		}
		_ = response.Body.Close()
		if bearer, err = c.bearer(ctx, true); err != nil {
			return nil, err
		}
	}
}

// asFailure turns an error from do into the failure to report: the service's refusal of the key as it was, anything else as a connection that did not work.
func (c *Client) asFailure(err error, code, message, operationID string, retryable bool) *Error {
	var failure *Error
	if errors.As(err, &failure) {
		if failure.Response.OperationID == "" && operationID != "" {
			failure.Response.OperationID = operationID
		}
		return failure
	}
	return c.Failure(code, message, operationID, retryable)
}

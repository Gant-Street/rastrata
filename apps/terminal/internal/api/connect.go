package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// rastrata connect CODE: a hosted workspace's Agents page shows a code that works once, for ten minutes. The command shows it to the service's sign-in side
// (POST /auth/agent-connect), which answers with an agent key (rsa_...) made for the person who asked for the code, with what they chose the agent may do. The key is kept in
// the connections file (connections.go) and never printed. The code is sent only to the hosted service or to this computer, as every credential is (endpointAllowed).

// ConnectedAgent is what the service says about the key it made for a code.
type ConnectedAgent struct {
	// Key is the agent key. It is a credential: keep it in the connections file and nowhere else.
	Key           string
	KeyID         string
	Name          string
	Scopes        []string
	ExpiresAt     string
	WorkspaceID   string
	WorkspaceName string
	WorkspaceSlug string
}

var connectCodeShape = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z -]{6,30}[0-9A-Za-z]$`)

// LooksLikeConnectCode says whether text could be a code from the Agents page: a few letters and digits, perhaps in groups. The service decides whether it is one.
func LooksLikeConnectCode(text string) bool {
	return connectCodeShape.MatchString(strings.TrimSpace(text)) && !strings.Contains(text, "_")
}

// ConnectAgent exchanges a code for an agent key. It sends nothing but the code and the name.
func (c *Client) ConnectAgent(ctx context.Context, code, name string) (ConnectedAgent, error) {
	payload := map[string]string{"code": strings.TrimSpace(code)}
	if name != "" {
		payload["name"] = name
	}
	body, _ := json.Marshal(payload)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint+"/auth/agent-connect", bytes.NewReader(body))
	if err != nil {
		return ConnectedAgent{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "rastrata-terminal/0.1")
	response, err := c.HTTP.Do(request)
	if err != nil {
		return ConnectedAgent{}, c.Failure("connection_failed", ServiceUnavailable, "", true)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return ConnectedAgent{}, c.Failure("response_invalid", "The service's answer to the code is incomplete or too large", "", false)
	}
	if response.StatusCode == http.StatusCreated {
		var made struct {
			Secret string `json:"secret"`
			Key    struct {
				ID        string   `json:"id"`
				Name      string   `json:"name"`
				Scopes    []string `json:"scopes"`
				ExpiresAt string   `json:"expiresAt"`
			} `json:"key"`
			Workspace struct {
				ID   string `json:"id"`
				Name string `json:"name"`
				Slug string `json:"slug"`
			} `json:"workspace"`
		}
		if err := json.Unmarshal(raw, &made); err != nil || !IsAgentKey(made.Secret) {
			// The code is used up and the key cannot be kept: say what to do about the key that was made.
			return ConnectedAgent{}, c.Failure("response_invalid", "The service's answer to the code was not understood. If an agent now shows in your workspace's agent settings, disconnect it there, then get a new code.", "", false)
		}
		return ConnectedAgent{Key: made.Secret, KeyID: made.Key.ID, Name: made.Key.Name, Scopes: made.Key.Scopes, ExpiresAt: made.Key.ExpiresAt, WorkspaceID: made.Workspace.ID, WorkspaceName: made.Workspace.Name, WorkspaceSlug: made.Workspace.Slug}, nil
	}
	var refusal struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &refusal)
	code = refusal.Code
	if code == "" || !regexp.MustCompile(`^[a-z_]{1,60}$`).MatchString(code) {
		code = "connect_failed"
	}
	message := refusal.Message
	if message == "" || len(message) > 300 {
		message = "The service did not accept the code. Get a new one in your workspace's agent settings."
	}
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed {
		return ConnectedAgent{}, c.Failure("connect_unavailable", "This address does not take a code from a workspace's agent settings. The code is for "+c.Endpoint+" only if that is where your workspace is; a hosted workspace is at https://app.rastrata.com.", "", false)
	}
	retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 || response.StatusCode == http.StatusConflict
	return ConnectedAgent{}, c.Failure(code, message, "", retryable)
}

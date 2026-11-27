package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

type Request struct {
	Version     string          `json:"version"`
	BookID      string          `json:"bookId"`
	OperationID string          `json:"operationId,omitempty"`
	Input       json.RawMessage `json:"input"`
}
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}
type Failure struct {
	Code      string       `json:"code"`
	Message   string       `json:"message"`
	Details   []FieldError `json:"details"`
	Retryable bool         `json:"retryable"`
}
type Response struct {
	Version     string          `json:"version"`
	BookID      string          `json:"bookId"`
	OK          bool            `json:"ok"`
	OperationID string          `json:"operationId,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	Error       *Failure        `json:"error,omitempty"`
}
type Error struct {
	Response Response
	Status   int
}

func (e *Error) Error() string {
	if e.Response.Error == nil {
		return "Application request failed"
	}
	return e.Response.Error.Code + ": " + e.Response.Error.Message
}
func (e *Error) OperationID() string { return e.Response.OperationID }

type Client struct {
	Endpoint string
	BookID   string
	HTTP     *http.Client
	Journal  *Journal
	// Credential, when set, is sent as "Authorization: Bearer ..." on every request: an agent
	// token, or the owner key. It goes only to the endpoint it was set for (redirects are
	// refused), and it is never written to the request journal or put in an error. The key of a
	// hosted workspace's agent (rsa_...) is exchanged for a token first (exchange.go); an owner key
	// or an agent token of the installed service is never sent to a service on the internet.
	Credential string
	held       *exchanged
}

// retainsNoResponse lists operations whose reply must never be written to the request journal,
// because it carries a secret that is shown once. The request is still retained, so a lost reply
// can be resumed with the same identity; the service then confirms the token exists and does not
// show the secret again. (bankfeed.connect keeps neither: see retainsNoRequest.)
var retainsNoResponse = map[string]bool{
	"tokens.create":       true,
	"plugins.createToken": true,
	"bankfeed.connect":    true,
}

// retainsNoRequest lists operations whose request carries a secret that must not be written to the
// request journal, not even briefly. The SimpleFIN setup token is a credential that works once: the
// service claims it and keeps what comes back in a private file of its own, so there is nothing to
// resume. A lost reply to bankfeed.connect is answered by reading bankfeed.status and, if the feed is
// not connected, by creating a new setup token at the Bridge, never by sending this one again.
var retainsNoRequest = map[string]bool{"bankfeed.connect": true}

// ServiceUnavailable is what a connection that failed says to do about it. The installed command
// line replaces it with the commands that look after the installed service.
var ServiceUnavailable = "Application service unavailable; start bun run dev:api and check the endpoint"

func New(endpoint, bookID, journalDirectory string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || !endpointAllowed(u) || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("endpoint must be a loopback HTTP origin, for example http://127.0.0.1:4010, or the hosted service's HTTPS origin, https://app.rastrata.com")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`).MatchString(bookID) {
		return nil, errors.New("book ID is required and must be an explicit identifier")
	}
	u.Path = ""
	c := &Client{Endpoint: u.String(), BookID: bookID, Journal: &Journal{Directory: journalDirectory}, held: &exchanged{}}
	c.HTTP = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return errors.New("application redirects are not allowed")
	}}
	return c, nil
}
func NewOperationID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func (c *Client) Failure(code, message, id string, retryable bool) *Error {
	return &Error{Response: Response{Version: Version, BookID: c.BookID, OperationID: id, Error: &Failure{Code: code, Message: message, Details: []FieldError{}, Retryable: retryable}}}
}

// Call is shared by headless and interactive clients. Before a write leaves the
// process its exact request and identity are fsynced to the private journal.
func (c *Client) Call(ctx context.Context, name string, input any, operationID string) (Response, error) {
	operation, exists := FindOperation(name)
	if !exists {
		return Response{}, c.Failure("unknown_operation", "Use help or schema to select an operation", "", false)
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return Response{}, c.Failure("invalid_input", err.Error(), "", false)
	}
	if err := Validate(encoded, operation.Input, "input"); err != nil {
		failure := c.Failure("invalid_input", err.Error(), "", false)
		var validation *ValidationError
		if errors.As(err, &validation) {
			failure.Response.Error.Details = []FieldError{{Path: validation.Path, Message: validation.Message}}
		}
		return Response{}, failure
	}
	if operation.Writes {
		if name == "operations.commit" {
			var commit CommitInput
			if err := json.Unmarshal(encoded, &commit); err != nil {
				return Response{}, err
			}
			if operationID != "" && operationID != commit.PlanID {
				return Response{}, c.Failure("operation_identity_conflict", "Commit identity must be the plan ID", operationID, false)
			}
			operationID = commit.PlanID
		} else if operationID == "" {
			operationID = NewOperationID()
		}
		if !uuid.MatchString(operationID) {
			return Response{}, c.Failure("invalid_operation_id", "Use a lowercase UUID operation identity", operationID, false)
		}
	}
	request := Request{Version: Version, BookID: c.BookID, OperationID: operationID, Input: encoded}
	body, _ := json.Marshal(request)
	if len(body) > 131072 {
		return Response{}, c.Failure("request_too_large", "Request exceeds 128 KiB", operationID, false)
	}
	if operation.Writes && !retainsNoRequest[name] {
		if c.Journal == nil {
			return Response{}, c.Failure("request_journal_unavailable", "A private request journal is required for writes", operationID, false)
		}
		if err := c.Journal.Retain(Record{Endpoint: c.Endpoint, BookID: c.BookID, Name: name, OperationID: operationID, Body: body}); err != nil {
			var pathError *fs.PathError
			if errors.As(err, &pathError) {
				return Response{}, c.Failure("request_journal_unwritable", journalHelp(c.Journal.Directory, pathError), operationID, false)
			}
			return Response{}, c.Failure("request_journal_conflict", err.Error(), operationID, false)
		}
	}
	return c.send(ctx, name, body, operationID, operation.Writes)
}

// journalHelp says what to do when the request journal cannot be written. The command keeps the exact
// bytes of every write before it sends it, so that an interrupted write can be resumed with the same
// identity. By default the journal is in the user's cache folder, which a sandbox (an agent's, for one)
// may not let a program write to: then nothing is sent, and the way forward is a folder it can write to.
func journalHelp(directory string, err *fs.PathError) string {
	return "The command cannot keep its request journal in " + directory + " (" + err.Op + " " + err.Path + ": " + err.Err.Error() + "), so it sent nothing. Set RASTRATA_REQUEST_DIR (or pass --request-dir) to a folder you can write to, such as .rastrata/requests in your project, and run the same command again."
}
func (c *Client) send(ctx context.Context, name string, body []byte, operationID string, writes bool) (Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint+"/v1/"+name, bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "rastrata-terminal/0.1")
	response, err := c.do(ctx, func() (*http.Request, error) {
		again := request.Clone(ctx)
		again.Body = io.NopCloser(bytes.NewReader(body))
		return again, nil
	})
	if err != nil {
		code, message := "connection_failed", ServiceUnavailable
		if writes {
			code, message = "operation_unresolved", "Write result is unknown; inspect operations status or resume the original identity"
		}
		return Response{}, c.asFailure(err, code, message, operationID, true)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4194305))
	if err != nil || len(raw) > 4194304 {
		return Response{}, c.Failure("response_invalid", "Application response is incomplete or exceeds 4 MiB; inspect the original operation", operationID, writes)
	}
	var envelope Response
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&envelope)
	if err == nil && decoder.Decode(new(any)) != io.EOF {
		err = errors.New("trailing response")
	}
	if err != nil || envelope.Version != Version || envelope.BookID != c.BookID || (envelope.OperationID != "" && envelope.OperationID != operationID) || (envelope.OK && (envelope.OperationID != operationID || envelope.Error != nil || len(envelope.Data) == 0 || response.StatusCode != 200)) || (!envelope.OK && (envelope.Error == nil || response.StatusCode < 400)) {
		return Response{}, c.Failure("response_invalid", "Response version, scope or envelope does not match; inspect the original operation before retrying", operationID, writes)
	}
	if envelope.OperationID == "" {
		envelope.OperationID = operationID
	}
	if envelope.OK {
		operation, _ := FindOperation(name)
		if err := ValidateOutput(envelope.Data, operation.Output, "output"); err != nil {
			return Response{}, c.Failure("response_invalid", err.Error(), operationID, writes)
		}
	}
	if writes && !retainsNoResponse[name] {
		if err := c.Journal.SaveResponse(operationID, name, raw); err != nil {
			return envelope, c.Failure("operation_unresolved", "Response received but could not be retained locally; inspect the original operation", operationID, true)
		}
	}
	if !envelope.OK {
		return envelope, &Error{Response: envelope, Status: response.StatusCode}
	}
	return envelope, nil
}
func (c *Client) Resume(ctx context.Context, id string) (Response, error) {
	record, err := c.Journal.Load(id)
	if err != nil {
		return Response{}, c.Failure("request_not_found", err.Error(), id, false)
	}
	if record.Endpoint != c.Endpoint || record.BookID != c.BookID {
		return Response{}, c.Failure("book_scope_mismatch", "Retained request belongs to another endpoint or book", id, false)
	}
	// Always send the retained bytes, never rebuild a command from current state.
	return c.send(ctx, record.Name, record.Body, record.OperationID, true)
}
func typedCall[T any](ctx context.Context, c *Client, name string, input any, id string) (T, error) {
	var value T
	response, err := c.Call(ctx, name, input, id)
	if err != nil {
		return value, err
	}
	err = json.Unmarshal(response.Data, &value)
	return value, err
}

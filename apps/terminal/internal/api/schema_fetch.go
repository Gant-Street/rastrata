package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Schema reads the operation catalog the running service publishes (GET /v1/schema), which is the
// contract it actually serves. `rastrata schema --check --live` compares it with this build's.
func (c *Client) Schema(ctx context.Context) (Contract, error) {
	response, err := c.do(ctx, func() (*http.Request, error) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Endpoint+"/v1/schema", nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("User-Agent", "rastrata-terminal/0.1")
		return request, nil
	})
	if err != nil {
		return Contract{}, c.asFailure(err, "connection_failed", ServiceUnavailable, "", true)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16<<20+1))
	if err != nil || len(raw) > 16<<20 {
		return Contract{}, c.Failure("response_invalid", "The schema response is incomplete or too large", "", false)
	}
	var envelope Response
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&envelope)
	if err == nil && decoder.Decode(new(any)) != io.EOF {
		err = errors.New("trailing response")
	}
	if err != nil || envelope.BookID != c.BookID || (envelope.OK && (envelope.Error != nil || len(envelope.Data) == 0 || response.StatusCode != 200)) ||
		(!envelope.OK && (envelope.Error == nil || response.StatusCode < 400)) {
		return Contract{}, c.Failure("response_invalid", "The schema response does not match the expected envelope", "", false)
	}
	if !envelope.OK {
		return Contract{}, &Error{Response: envelope, Status: response.StatusCode}
	}
	var served Contract
	if err := json.Unmarshal(envelope.Data, &served); err != nil || served.Version == "" || served.Definitions == nil || served.Operations == nil {
		return Contract{}, c.Failure("response_invalid", "The schema response is not an operation catalog", "", false)
	}
	return served, nil
}

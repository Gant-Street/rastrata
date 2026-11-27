package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
)

// MaxUploadBytes is the largest statement file the service accepts (16 MiB). Operations keep their
// 128 KiB JSON limit; only POST /v1/uploads takes a raw body.
const MaxUploadBytes = 16 * 1024 * 1024

// Receipt is what the service says about an uploaded file. The import operations name the file by
// its SHA-256.
type Receipt struct {
	SHA256    string `json:"sha256"`
	Size      int    `json:"size"`
	MediaType string `json:"mediaType"`
	Name      string `json:"name,omitempty"`
}

// Upload sends a statement file as the raw body of POST /v1/uploads. The file is addressed by its
// content, so an upload needs no operation identity and is safe to repeat: the same bytes give the
// same receipt and store nothing new.
func (c *Client) Upload(ctx context.Context, data []byte, mediaType, name string) (Receipt, error) {
	return c.upload(ctx, data, mediaType, name, "")
}

// UploadStripeBundle sends a bundle of Stripe's answers (a gzip file) to be unpacked by stripe.receive. It
// is the same route and the same content address as a statement file, told apart by what it is for.
func (c *Client) UploadStripeBundle(ctx context.Context, data []byte, name string) (Receipt, error) {
	return c.upload(ctx, data, "application/gzip", name, "stripe")
}

func (c *Client) upload(ctx context.Context, data []byte, mediaType, name, purpose string) (Receipt, error) {
	if len(data) == 0 {
		return Receipt{}, c.Failure("invalid_input", "The file is empty", "", false)
	}
	if len(data) > MaxUploadBytes {
		return Receipt{}, c.Failure("request_too_large", "The file exceeds 16 MiB. Export a shorter date range and import it in parts.", "", false)
	}
	response, err := c.do(ctx, func() (*http.Request, error) {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint+"/v1/uploads", bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Content-Type", mediaType)
		if purpose != "" {
			request.Header.Set("X-Upload-For", purpose)
		}
		if name != "" {
			// The name is a label for people; the service cleans it again, so only a percent-encoded form travels.
			request.Header.Set("X-Upload-Name", url.PathEscape(name))
		}
		request.Header.Set("User-Agent", "rastrata-terminal/0.1")
		return request, nil
	})
	if err != nil {
		return Receipt{}, c.asFailure(err, "connection_failed", ServiceUnavailable, "", true)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil || len(raw) > 1<<20 {
		return Receipt{}, c.Failure("response_invalid", "The upload response is incomplete or too large", "", false)
	}
	var envelope Response
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&envelope)
	if err == nil && decoder.Decode(new(any)) != io.EOF {
		err = errors.New("trailing response")
	}
	if err != nil || envelope.Version != Version || envelope.BookID != c.BookID ||
		(envelope.OK && (envelope.Error != nil || len(envelope.Data) == 0 || response.StatusCode != 200)) ||
		(!envelope.OK && (envelope.Error == nil || response.StatusCode < 400)) {
		return Receipt{}, c.Failure("response_invalid", "The upload response does not match the expected envelope", "", false)
	}
	if !envelope.OK {
		return Receipt{}, &Error{Response: envelope, Status: response.StatusCode}
	}
	if err := ValidateOutput(envelope.Data, Schema{Ref: "#/$defs/UploadReceipt"}, "output"); err != nil {
		return Receipt{}, c.Failure("response_invalid", err.Error(), "", false)
	}
	var receipt Receipt
	if err := json.Unmarshal(envelope.Data, &receipt); err != nil {
		return Receipt{}, c.Failure("response_invalid", err.Error(), "", false)
	}
	return receipt, nil
}

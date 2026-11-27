/** A bundle of Stripe's answers as `stripe.receive` reads it: a gzip file in which each answer is a line
 * of JSON, {request, status, size}, then size bytes exactly as Stripe sent them, then a newline. For
 * tests, which make what the command line makes. */

export interface Answer {
  readonly request: string;
  readonly status: number;
  /** Stripe's answer, byte for byte. */
  readonly body: Uint8Array;
}

const encoder = new TextEncoder();

export function bundleOf(answers: readonly Answer[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const answer of answers) {
    parts.push(
      encoder.encode(
        `${JSON.stringify({ request: answer.request, status: answer.status, size: answer.body.byteLength })}\n`,
      ),
      answer.body,
      encoder.encode("\n"),
    );
  }
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return Bun.gzipSync(whole);
}

/** The headers of the upload that delivers a bundle (`POST /v1/uploads`). */
export const BUNDLE_UPLOAD = {
  "content-type": "application/gzip",
  "x-upload-for": "stripe",
} as const;

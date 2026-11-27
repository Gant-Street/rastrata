/** What a sender of Stripe's answers and the book that takes them say to each other (docs/reference/program/hosting/hosted-stripe.md): the requests the lane makes, the bundle the
 * answers travel in, and the sizes, so that the code that delivers (the command line's twin in the control Worker) and the book that receives (`stripe.receive`) read one definition
 * and cannot disagree about a limit. Nothing here talks to anything: it is shapes, a few checks and the bundle's two functions. */

export const STRIPE_WIRE = {
  /** Where the answers come from. A sender reads nothing else. */
  origin: "https://api.stripe.com",
  /** The version of Stripe's API the books' decoders and fixtures are written against; a pull asks in it (the books name it in their reply, and this is the one a sender uses before they have). */
  apiVersion: "2026-09-30.endive",
  /** The longest a request the book names may be. */
  requestLength: 800,
  /** Requests the book names in one reply, at most; a pull asks again for the rest. */
  needsPerReply: 200,
  /** Bundles one call may name, and answers one bundle holds, and the bytes of answers a bundle holds before another is begun. */
  bundlesPerCall: 20,
  answersPerBundle: 500,
  bundleBytes: 4 * 1024 * 1024,
  /** The largest one answer may be: Stripe's own largest (a page of a hundred expanded charges) is a few megabytes. */
  answerBytes: 16 * 1024 * 1024,
  /** How far ahead of the book's clock the instant a pull reads up to may be. */
  clockSkewMs: 2 * 60 * 1000,
  /** The shape of the version of Stripe's API the book names for a pull. */
  versionPattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}(\\.[a-z]{1,20})?$",
} as const;

/** What the control plane tells the books about the Stripe account the owner connected with the button (`stripe.link`), and what they answer. */
export interface StripeLinkInput {
  readonly account: { readonly id: string; readonly livemode: boolean } | null;
}
export interface StripeLinkResult {
  readonly linked: boolean;
  /** When the account was not taken: the books have been reading another Stripe account (`account_changed`), or the other mode (`mode_changed`). */
  readonly reason: "account_changed" | "mode_changed" | null;
}

/** The requests the lane makes of Stripe, and so the only ones a sender makes and the book keeps an answer for. */
export const STRIPE_LANE_PATHS: readonly RegExp[] = [
  /^\/v1\/account$/,
  /^\/v1\/balance$/,
  /^\/v1\/balance_transactions$/,
  /^\/v1\/payouts$/,
  /^\/v1\/payouts\/[A-Za-z0-9_]{3,100}$/,
  /^\/v1\/checkout\/sessions$/,
  /^\/v1\/invoice_payments$/,
];

/** A request the book named, parsed, if it is one the lane makes; otherwise null. A sender fetches nothing else, whoever asks. */
export function laneRequest(
  request: string,
): { readonly path: string; readonly query: URLSearchParams } | null {
  if (
    request.length > STRIPE_WIRE.requestLength ||
    !request.startsWith("/v1/") ||
    request.startsWith("//")
  )
    return null;
  let url: URL;
  try {
    url = new URL(request, STRIPE_WIRE.origin);
  } catch {
    return null;
  }
  if (url.origin !== STRIPE_WIRE.origin || url.hash !== "" || url.username || url.password)
    return null;
  if (!STRIPE_LANE_PATHS.some((path) => path.test(url.pathname))) return null;
  return { path: url.pathname, query: url.searchParams };
}

/** What Stripe said to one request, byte for byte. */
export interface StripeAnswer {
  readonly request: string;
  readonly status: number;
  readonly body: Uint8Array;
}

const encoder = new TextEncoder();

/** Answers packed as the book reads them, in a gzip file: for each, a line of JSON {request, status, size}, then size bytes exactly as Stripe sent them, then a newline. */
export async function bundleOf(answers: readonly StripeAnswer[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const answer of answers) {
    const header = encoder.encode(
      `${JSON.stringify({ request: answer.request, status: answer.status, size: answer.body.byteLength })}\n`,
    );
    parts.push(header, answer.body, encoder.encode("\n"));
    total += header.byteLength + answer.body.byteLength + 1;
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  const zipped = new Blob([whole]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(zipped).arrayBuffer());
}

/** What the next call will deliver, out of the answers waiting: bundles of at most {@link STRIPE_WIRE.answersPerBundle} answers and {@link STRIPE_WIRE.bundleBytes} bytes, at most
 * {@link STRIPE_WIRE.bundlesPerCall} of them, and what is left for the call after. */
export function cutBundles(
  outbox: readonly StripeAnswer[],
  bundleBytes: number = STRIPE_WIRE.bundleBytes,
): { readonly bundles: StripeAnswer[][]; readonly rest: StripeAnswer[] } {
  const bundles: StripeAnswer[][] = [];
  let current: StripeAnswer[] = [];
  let size = 0;
  for (let index = 0; index < outbox.length; index += 1) {
    const answer = outbox[index] as StripeAnswer;
    const full =
      current.length >= STRIPE_WIRE.answersPerBundle ||
      (current.length > 0 && size + answer.body.byteLength > bundleBytes);
    if (full) {
      bundles.push(current);
      current = [];
      size = 0;
      if (bundles.length === STRIPE_WIRE.bundlesPerCall)
        return { bundles, rest: outbox.slice(index) };
    }
    current.push(answer);
    size += answer.body.byteLength;
  }
  if (current.length > 0) bundles.push(current);
  return { bundles, rest: [] };
}

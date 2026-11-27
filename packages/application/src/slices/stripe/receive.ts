import { STRIPE_LANE_PATHS, STRIPE_WIRE } from "../../agent/stripe-wire.ts";
import { ApplicationError } from "../../errors.ts";
import type { IngestPort } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { type FetchFn, ResponseMissing, StripeError } from "../../stripe/client.ts";
import { ingestPort } from "../ingest/port.ts";
import { sliceState } from "../state.ts";
import { stripeRuntime } from "./runtime.ts";
import { type Delivered, type SyncOutcome, runStripeSync } from "./sync.ts";

/** `stripe.receive`: Stripe, for a service that holds no Stripe key.
 *
 * A hosted service has many books and no customer's secret, so it cannot read Stripe itself. The
 * customer's own computer can: it holds a read-only key of its own and fetches the pages the service
 * asks for. This is the service's half. It runs the same run as `stripe.sync` (the same requests in
 * the same order, the same decoding, the same payouts booked the same way), with one difference:
 * where the sync would have asked Stripe, it looks for the answer the sender delivered, and where
 * there is none, it leaves that part for the next call and says what it asked for. The sender
 * fetches those, delivers them, and calls again, until nothing is asked for.
 *
 * So the sender knows nothing of Stripe's data. It only fetches what it is told to, and only the
 * few kinds of request this lane makes. It delivers Stripe's answers byte for byte in a bundle: a
 * gzip file, uploaded first (`POST /v1/uploads` with `X-Upload-For: stripe`), of answers framed one
 * after another. One bundle a round, not one upload an answer: a book may be asked about thirty
 * times a second, and a year of a business is thousands of answers. The answers wait in memory for
 * the pull in progress and nowhere else; the run archives the pages it reads, under the names and
 * the addresses the sync gives them, so the evidence is the same. If the service forgets what it was
 * delivered (another process took the book), it asks again and the sender delivers it again.
 *
 * What the service cannot know is that the bytes are Stripe's. They are the sender's word, as a
 * file the sender uploads is; the sender is the owner or an agent the owner trusted with the right
 * to draft. A page that is not what it should be is refused by the decoders, and a payout whose
 * transactions do not add up is held, as in a sync. */

/** The requests the lane makes of Stripe, and so the only ones an answer is kept for, and the sizes a sender and this service agree on, are one definition (agent/stripe-wire.ts). */
const LANE_PATHS = STRIPE_LANE_PATHS;
const STRIPE_ORIGIN = STRIPE_WIRE.origin;
/** Most requests named in one reply. A pull asks again for the rest. */
const MAX_NEEDS = STRIPE_WIRE.needsPerReply;
/** A pull nobody has touched for this long is forgotten. */
const FORGET_AFTER_MS = 2 * 60 * 60 * 1000;
/** How far ahead of the service's clock the sender's may be. */
const CLOCK_SKEW_MS = STRIPE_WIRE.clockSkewMs;
/** The oldest a pull may be when it is continued. */
const OLDEST_PULL_MS = 24 * 60 * 60 * 1000;
/** One answer: Stripe's own largest (a page of a hundred expanded charges) is a few megabytes. */
const MAX_ANSWER_BYTES = STRIPE_WIRE.answerBytes;
/** What one bundle may hold, unpacked. The bundle itself is at most an upload (16 MiB). */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** The answers a pull holds in memory at once. Past this the oldest are let go, and asked for again if they are needed. */
const MAX_HELD_BYTES = 48 * 1024 * 1024;
const MAX_BUNDLES_PER_CALL = STRIPE_WIRE.bundlesPerCall;
/** The answers a pull holds at once, however small: each costs a map entry. */
const MAX_HELD_ANSWERS = 20_000;
/** What every pull in this process holds together. A service has many books, and a pull is the one thing here whose memory the owner of a book decides. */
const MAX_HELD_ALL_BYTES = 192 * 1024 * 1024;

export interface ReceiveInput {
  readonly asOf: string;
  readonly bundles?: readonly string[];
  readonly budgetSeconds?: number;
  /** Whether the sender says the answers are Stripe's live mode (true) or test mode (false). */
  readonly livemode?: boolean;
}

export interface ReceiveOutcome extends SyncOutcome {
  readonly needs: readonly string[];
}

interface Answer {
  readonly status: number;
  readonly bytes: Uint8Array;
}
interface Pull {
  readonly asOf: string;
  /** By the request in one form whatever order its parameters came in. */
  readonly answers: Map<string, Answer>;
  readonly unpacked: Set<string>;
  held: number;
  touched: number;
}

/** A request in one form whatever order its parameters came in, and as the service asked it. */
export function lanePathOf(
  request: string,
): { readonly key: string; readonly asked: string } | null {
  if (request.length > 800 || !request.startsWith("/v1/") || request.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(request, STRIPE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== STRIPE_ORIGIN || url.hash !== "") return null;
  if (!LANE_PATHS.some((path) => path.test(url.pathname))) return null;
  const pairs = [...url.searchParams].sort(([a, x], [b, y]) =>
    a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
  );
  const query = pairs
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  return { key: query === "" ? url.pathname : `${url.pathname}?${query}`, asked: request };
}

type Held = { current: Pull | null };
const heldPull = (service: ApplicationService): Held =>
  sliceState(service, "stripe.delivered", () => ({ current: null }) as Held);

/** Every pull in progress in this process, and what they hold together. A pull nobody finishes is let go
 * when it is old, so that it cannot keep memory for good. */
const live = new Set<Pull>();
let heldAll = 0;

function release(pull: Pull): void {
  heldAll -= pull.held;
  pull.held = 0;
  pull.answers.clear();
  pull.unpacked.clear();
  live.delete(pull);
}

function pullOf(service: ApplicationService, asOf: string, now: number): Pull {
  for (const pull of live) if (now - pull.touched >= FORGET_AFTER_MS) release(pull);
  const held = heldPull(service);
  const current = held.current;
  if (current && current.asOf === asOf && live.has(current)) {
    current.touched = now;
    return current;
  }
  // A new pull starts with nothing: an answer from an earlier one may be out of date (a payout
  // Stripe had not finished itemising then), and must not be read as if it were fresh.
  if (current) release(current);
  const next: Pull = { asOf, answers: new Map(), unpacked: new Set(), held: 0, touched: now };
  held.current = next;
  live.add(next);
  return next;
}

/** The instant the sender reads up to, whole seconds. It must be a UTC instant that is neither ahead
 * of this service's clock (a book would be told it has read what has not happened, and the next pull
 * would start after what it missed) nor so old that it belongs to another day. */
function checkedAsOf(value: string, now: number): string {
  const shaped = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/.test(
    value,
  );
  const at = shaped ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at))
    throw new ApplicationError(
      "invalid_input",
      "asOf is the instant the pull reads up to, in UTC, like 2026-10-20T14:03:05Z.",
    );
  if (at > now + CLOCK_SKEW_MS)
    throw new ApplicationError(
      "clock_ahead",
      "The time your computer sent is ahead of this service's clock by more than two minutes. Set your computer's clock right and pull again.",
    );
  if (at < now - OLDEST_PULL_MS)
    throw new ApplicationError(
      "pull_too_old",
      "This pull began more than a day ago. Start a new one.",
    );
  return new Date(Math.floor(at / 1000) * 1000).toISOString();
}

const refusal = (message: string, status = 400): ApplicationError =>
  new ApplicationError("invalid_input", message, status);

/** A gzip file, unpacked, never past `max` bytes: a small file that unpacks to gigabytes is turned away. */
async function gunzip(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new ApplicationError(
          "stripe_bundle_too_large",
          "A bundle of Stripe's answers unpacks to more than 64 MiB. Deliver fewer answers at a time.",
          413,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw refusal(
      "A bundle of Stripe's answers is a gzip file, and this one could not be read as one.",
    );
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The answers in a bundle, in order. Each is a line of JSON, `{"request","status","size"}`, then
 * `size` bytes exactly as Stripe sent them, then a newline. Nothing is guessed: anything that does
 * not fit the frame refuses the whole bundle. */
function unframe(bytes: Uint8Array): { key: string; answer: Answer }[] {
  const header = new TextDecoder("utf-8", { fatal: true });
  const out: { key: string; answer: Answer }[] = [];
  let at = 0;
  while (at < bytes.length) {
    const lineEnd = bytes.indexOf(0x0a, at);
    if (lineEnd < 0 || lineEnd - at > 2000)
      throw refusal("A bundle of Stripe's answers has a line that is not an answer's header.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(header.decode(bytes.subarray(at, lineEnd)));
    } catch {
      throw refusal("A bundle of Stripe's answers has a header that is not JSON.");
    }
    const shape = parsed as { request?: unknown; status?: unknown; size?: unknown } | null;
    const lane = typeof shape?.request === "string" ? lanePathOf(shape.request) : null;
    if (lane === null)
      throw refusal(
        `${typeof shape?.request === "string" ? shape.request.slice(0, 80) : "A request"} is not a request the Stripe lane makes.`,
      );
    const { status, size } = shape as { status: unknown; size: unknown };
    if (!Number.isInteger(status) || (status as number) < 200 || (status as number) > 599)
      throw refusal("A bundle of Stripe's answers has a status that is not an HTTP status.");
    if (!Number.isInteger(size) || (size as number) < 0 || (size as number) > MAX_ANSWER_BYTES)
      throw refusal("A bundle of Stripe's answers has an answer of a size Stripe does not give.");
    const start = lineEnd + 1;
    const stop = start + (size as number);
    if (stop >= bytes.length) throw refusal("A bundle of Stripe's answers is cut short.");
    if (bytes[stop] !== 0x0a)
      throw refusal(
        "A bundle of Stripe's answers has an answer that is not followed by a newline.",
      );
    out.push({
      key: lane.key,
      answer: { status: status as number, bytes: bytes.slice(start, stop) },
    });
    at = stop + 1;
  }
  return out;
}

async function unpack(pull: Pull, port: IngestPort, bundles: readonly string[]): Promise<void> {
  if (bundles.length > MAX_BUNDLES_PER_CALL)
    throw refusal(`Deliver at most ${MAX_BUNDLES_PER_CALL} bundles in one call.`);
  for (const sha256 of bundles) {
    if (pull.unpacked.has(sha256)) continue;
    const stored = port.readArchive(sha256);
    if (!stored)
      throw refusal(
        `The bundle ${sha256.slice(0, 12)} is not in this workspace. Upload it first (POST /v1/uploads with X-Upload-For: stripe).`,
      );
    for (const { key, answer } of unframe(await gunzip(stored.bytes, MAX_BUNDLE_BYTES))) {
      const before = pull.answers.get(key);
      if (before) {
        pull.held -= before.bytes.byteLength;
        heldAll -= before.bytes.byteLength;
        pull.answers.delete(key);
      }
      pull.answers.set(key, answer);
      pull.held += answer.bytes.byteLength;
      heldAll += answer.bytes.byteLength;
    }
    pull.unpacked.add(sha256);
  }
  // Past what a pull may hold, or what all of them may, the oldest are let go; the run asks for them
  // again if it still needs them.
  for (const [key, answer] of pull.answers) {
    if (
      pull.held <= MAX_HELD_BYTES &&
      pull.answers.size <= MAX_HELD_ANSWERS &&
      heldAll <= MAX_HELD_ALL_BYTES
    )
      break;
    pull.answers.delete(key);
    pull.held -= answer.bytes.byteLength;
    heldAll -= answer.bytes.byteLength;
  }
  if (heldAll > MAX_HELD_ALL_BYTES)
    throw new ApplicationError(
      "server_busy",
      "The server is holding other pulls of Stripe just now; try again in a moment.",
      503,
      [],
      true,
    );
}

/** The run's `fetch`: Stripe's answers as they were delivered. A request with no answer is recorded as
 * asked and refused with `ResponseMissing`. */
function deliveredFetch(pull: Pull, misses: Map<string, string>): FetchFn {
  return async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const lane = lanePathOf(`${url.pathname}${url.search}`);
    if (lane === null)
      throw new StripeError(
        "stripe_request_rejected",
        "The Stripe lane asked for a request it does not make.",
        false,
      );
    const answer = pull.answers.get(lane.key);
    if (!answer) {
      misses.set(lane.key, lane.asked);
      throw new ResponseMissing(lane.asked);
    }
    return new Response(answer.bytes as BodyInit, {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
}

export async function receiveStripe(
  service: ApplicationService,
  input: ReceiveInput,
  operationId: string,
): Promise<ReceiveOutcome> {
  const runtime = stripeRuntime(service);
  const now = Date.parse(runtime.now());
  const asOf = checkedAsOf(input.asOf, now);
  const pull = pullOf(service, asOf, now);
  await unpack(pull, runtime.port ?? ingestPort(service), input.bundles ?? []);
  const misses = new Map<string, string>();
  const delivered: Delivered = {
    fetch: deliveredFetch(pull, misses),
    asOf,
    misses: () => [...misses.values()],
    ...(input.livemode === undefined ? {} : { livemode: input.livemode }),
  };
  const outcome = await runStripeSync(
    service,
    input.budgetSeconds === undefined ? {} : { budgetSeconds: input.budgetSeconds },
    operationId,
    delivered,
  );
  // A finished pull has no more use for what it was delivered: the pages it read are archived.
  if (!outcome.more) {
    release(pull);
    heldPull(service).current = null;
  }
  return { ...outcome, needs: [...misses.values()].slice(0, MAX_NEEDS) };
}

import {
  STRIPE_WIRE,
  type StripeAnswer,
  bundleOf,
  cutBundles,
  laneRequest,
} from "./stripe-wire.ts";

/** The sender's half of `stripe.receive`, for a sender that is not the command line: the control Worker, which reads the Stripe account an owner connected with the button and delivers
 * the answers to the book, and the tests that hold it to the sync. It is the command line's loop (apps/terminal/internal/cli/commands_stripe_pull.go) in TypeScript, with the same
 * protocol: ask the book what it needs, fetch exactly that from Stripe and nothing else, deliver the answers in gzip bundles, and call again until the book needs nothing more.
 *
 * It knows nothing of Stripe's data. A request it is told to make is a request it makes, if the lane makes it; the book decodes what comes back, books the payouts whose transactions add
 * up to the payout, and holds the rest. It reads on to the next page of a list unasked, as the command line does (the book would ask for it in the next round anyway). Everything that
 * talks to a network is handed in, so that a test never reaches one. */

/** What the sender needs of a reply of `stripe.receive`. */
export interface PullReply {
  readonly more: boolean;
  readonly needs: readonly string[];
  readonly apiVersion?: string;
  readonly run: {
    readonly payouts: number;
    readonly newLines: number;
    readonly duplicateLines: number;
    readonly heldLines: number;
    readonly through: string | null;
    readonly notes: readonly string[];
  };
}

/** Why a pull stopped without finishing, in a word the caller can act on. */
export type PullStop =
  | "request_refused"
  | "stalled"
  | "bad_version"
  | "stripe_unreachable"
  | "service_failed";

export class PullError extends Error {
  constructor(
    readonly code: PullStop,
    message: string,
  ) {
    super(message);
    this.name = "PullError";
  }
}

/** A failure the sender may try again after a wait: the workspace was busy or limiting requests, or the answer was lost on the way. */
export interface Retryable {
  readonly retryable?: boolean;
}

export interface SenderDeps {
  /** `stripe.receive` in the book. Throws an error with `retryable: true` when asking again may work. */
  receive(input: {
    readonly asOf: string;
    readonly bundles: readonly string[];
    readonly livemode: boolean;
  }): Promise<PullReply>;
  /** Upload one bundle (`POST /v1/uploads`, `application/gzip`, `X-Upload-For: stripe`); the SHA-256 of what was stored. */
  upload(bundle: Uint8Array): Promise<string>;
  /** One read of Stripe in the version the book named: the status and the exact bytes. Whatever is not a limit or a fault is returned as it is; the book says what a refusal means. */
  get(
    request: string,
    apiVersion: string,
  ): Promise<{ readonly status: number; readonly body: Uint8Array }>;
  /** Epoch milliseconds. */
  now(): number;
  sleep?(ms: number): Promise<void>;
}

export interface PullOptions {
  /** The instant the pull reads up to, in UTC, whole seconds: chosen once for the whole pull and never ahead of the book's clock. */
  readonly asOf: string;
  /** Whether the answers are Stripe's live mode (the key's, or the connection's). */
  readonly livemode: boolean;
  /** Requests to Stripe at once. */
  readonly concurrency?: number;
  readonly maxRounds?: number;
  /** No round that has requests to make begins after this instant (epoch milliseconds), or after this many requests have been made: the pull is then unfinished, and the next one carries on. */
  readonly deadline?: number;
  readonly maxStripeRequests?: number;
  /** The answers already fetched (by request), as a pull that was begun before would have them. */
  readonly cache?: Map<string, StripeAnswer>;
  /** How long to wait before asking the workspace again after it said it was busy, growing with each try. */
  readonly serviceBackoffMs?: number;
}

export interface PullSummary {
  /** The book needed nothing more: everything Stripe has was read, and every payout it could book is booked. */
  readonly finished: boolean;
  /** When unfinished, why this call stopped: its time or its request budget. */
  readonly stopped: "time" | "requests" | null;
  readonly rounds: number;
  readonly stripeRequests: number;
  readonly payouts: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly heldLines: number;
  readonly through: string | null;
  readonly notes: readonly string[];
}

/** The lists the sender reads on through without being asked: the book would ask for each next page in the round after. */
const LISTS: ReadonlySet<string> = new Set([
  "/v1/balance_transactions",
  "/v1/checkout/sessions",
  "/v1/invoice_payments",
  "/v1/payouts",
]);
/** A request the book asks for again right after being given its answer is a fault; it is given the answer again twice and then the pull stops. */
const MAX_REPEATS = 2;
const SERVICE_ATTEMPTS = 6;
const IDLE_ROUNDS = 100;

/** The instant `ms` is, as a pull states it: UTC, whole seconds. */
export const instantOf = (ms: number): string =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

const sleepFor = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function pullStripe(deps: SenderDeps, options: PullOptions): Promise<PullSummary> {
  const sleep = deps.sleep ?? sleepFor;
  const workers = Math.max(1, Math.min(16, options.concurrency ?? 6));
  const maxRounds = options.maxRounds ?? 1000;
  const cache = options.cache ?? new Map<string, StripeAnswer>();
  const pages = new Map<string, { readonly last: string }>();
  const queued = new Set<string>();
  const sentIn = new Map<string, number>();
  const repeats = new Map<string, number>();
  let outbox: StripeAnswer[] = [];
  let version = "";
  let made = 0;
  let idle = 0;
  const sum = {
    rounds: 0,
    payouts: 0,
    newLines: 0,
    duplicateLines: 0,
    heldLines: 0,
    through: null as string | null,
    notes: [] as string[],
  };

  const retrying = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if ((error as Retryable).retryable !== true || attempt >= SERVICE_ATTEMPTS) throw error;
        await sleep((options.serviceBackoffMs ?? 1000) * attempt);
      }
    }
  };

  const fetchOne = async (request: string): Promise<StripeAnswer> => {
    const lane = laneRequest(request);
    if (lane === null)
      throw new PullError(
        "request_refused",
        `The workspace asked for a request this sender never makes (${request.slice(0, 80)}), so nothing more was fetched.`,
      );
    const got = await deps.get(request, version);
    made += 1;
    const answer: StripeAnswer = { request, status: got.status, body: got.body };
    cache.set(request, answer);
    if (got.status === 200 && LISTS.has(lane.path)) {
      try {
        const list = JSON.parse(new TextDecoder().decode(got.body)) as {
          object?: unknown;
          has_more?: unknown;
          data?: unknown;
        };
        const items = Array.isArray(list.data) ? (list.data as { id?: unknown }[]) : [];
        const last = items.at(-1)?.id;
        if (list.object === "list" && list.has_more === true && typeof last === "string")
          pages.set(request, { last });
      } catch {
        // Not a list the sender can read on: the book will say what is wrong with it.
      }
    }
    return answer;
  };

  /** One request and, for a list that says there is more, the pages after it, the way the book would ask for them. */
  const answerFor = async (first: string): Promise<StripeAnswer[]> => {
    const chain: StripeAnswer[] = [];
    let request = first;
    for (let page = 0; page < 10_000; page += 1) {
      chain.push(await fetchOne(request));
      const more = pages.get(request);
      if (more === undefined) return chain;
      const lane = laneRequest(request);
      if (lane === null) return chain;
      const next = new URLSearchParams(lane.query);
      next.set("starting_after", more.last);
      request = `${lane.path}?${next.toString()}`;
    }
    throw new PullError(
      "stripe_unreachable",
      "A list of Stripe's went on for more than ten thousand pages.",
    );
  };

  const fetchAll = async (requests: readonly string[]): Promise<StripeAnswer[][]> => {
    const results: StripeAnswer[][] = new Array(requests.length);
    let next = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= requests.length) return;
        results[index] = await answerFor(requests[index] as string);
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, requests.length) }, lane));
    return results;
  };

  let finished = false;
  let stopped: PullSummary["stopped"] = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    const cut = cutBundles(outbox);
    outbox = cut.rest;
    for (const bundle of cut.bundles)
      for (const answer of bundle) {
        queued.delete(answer.request);
        sentIn.set(answer.request, round);
      }
    const shas: string[] = [];
    for (const bundle of cut.bundles) {
      const packed = await bundleOf(bundle);
      shas.push(await retrying(() => deps.upload(packed)));
    }
    const reply = await retrying(() =>
      deps.receive({ asOf: options.asOf, bundles: shas, livemode: options.livemode }),
    );
    sum.rounds = round;
    sum.payouts += reply.run.payouts;
    sum.newLines += reply.run.newLines;
    sum.duplicateLines += reply.run.duplicateLines;
    sum.heldLines += reply.run.heldLines;
    sum.through = reply.run.through ?? sum.through;
    for (const note of reply.run.notes) if (!sum.notes.includes(note)) sum.notes.push(note);
    if (reply.apiVersion !== undefined && reply.apiVersion !== "") {
      if (!new RegExp(STRIPE_WIRE.versionPattern).test(reply.apiVersion))
        throw new PullError(
          "bad_version",
          "The workspace named a Stripe API version that is not one.",
        );
      version = reply.apiVersion;
    }
    if (version === "")
      throw new PullError(
        "bad_version",
        "The workspace did not say which version of Stripe's API to ask in.",
      );
    if (reply.needs.length === 0 && !reply.more) {
      finished = true;
      break;
    }
    if (reply.needs.length === 0) {
      // The workspace ran out of time with work left and asked for nothing: it only wants calling again.
      idle += 1;
      if (idle > IDLE_ROUNDS)
        throw new PullError(
          "stalled",
          "The workspace keeps saying it is not finished and asking for nothing.",
        );
      continue;
    }
    idle = 0;
    // The budget is spent before a round begins its requests, never in the middle of one: what was fetched is delivered.
    if (options.deadline !== undefined && deps.now() >= options.deadline) {
      stopped = "time";
      break;
    }
    if (options.maxStripeRequests !== undefined && made >= options.maxStripeRequests) {
      stopped = "requests";
      break;
    }
    const fetch: string[] = [];
    for (const need of reply.needs) {
      if (laneRequest(need) === null)
        throw new PullError(
          "request_refused",
          `The workspace asked for a request this sender never makes (${need.slice(0, 80)}), so nothing more was fetched.`,
        );
      if (queued.has(need)) continue;
      const have = cache.get(need);
      if (have === undefined) {
        fetch.push(need);
        continue;
      }
      if (sentIn.get(need) === round) {
        const again = (repeats.get(need) ?? 0) + 1;
        repeats.set(need, again);
        if (again > MAX_REPEATS)
          throw new PullError(
            "stalled",
            `The workspace keeps asking for ${need.slice(0, 80)} after being given it.`,
          );
      }
      queued.add(need);
      outbox.push(have);
    }
    const fetched = await fetchAll(fetch);
    for (const chain of fetched)
      for (const answer of chain)
        if (!queued.has(answer.request)) {
          queued.add(answer.request);
          outbox.push(answer);
        }
  }
  return {
    finished,
    stopped,
    rounds: sum.rounds,
    stripeRequests: made,
    payouts: sum.payouts,
    newLines: sum.newLines,
    duplicateLines: sum.duplicateLines,
    heldLines: sum.heldLines,
    through: sum.through,
    notes: sum.notes,
  };
}

export interface StripeGetOptions {
  /** The key that reads: a restricted key of the sender's own, or the key of the account that owns the Stripe app. It is sent to Stripe and nowhere else, and never appears in an error. */
  readonly key: string;
  /** The connected account to act on (`Stripe-Account`), for a sender that reads an account that installed the app. */
  readonly account?: string;
  readonly fetch: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attempts?: number;
  readonly backoffMs?: number;
}

/** One read of Stripe, trying again when Stripe is limiting requests or has a fault. Any other answer is returned as it is: the book says what a refusal means, as the sync does. */
export function stripeGetter(options: StripeGetOptions): SenderDeps["get"] {
  const sleep = options.sleep ?? sleepFor;
  const attempts = options.attempts ?? 4;
  const backoff = options.backoffMs ?? 250;
  return async (request, apiVersion) => {
    if (laneRequest(request) === null)
      throw new PullError(
        "request_refused",
        `${request.slice(0, 80)} is not a request this sender makes.`,
      );
    let last = "Stripe could not be reached.";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(backoff * 2 ** (attempt - 2));
      let response: Response;
      try {
        response = await options.fetch(`${STRIPE_WIRE.origin}${request}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${options.key}`,
            "stripe-version": apiVersion,
            accept: "application/json",
            "user-agent": "rastrata-stripe-connection/1",
            ...(options.account === undefined ? {} : { "stripe-account": options.account }),
          },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        last = "Stripe could not be reached.";
        continue;
      }
      let body: Uint8Array;
      try {
        body = new Uint8Array(await response.arrayBuffer());
      } catch {
        last = "Stripe's answer was cut off.";
        continue;
      }
      if (body.byteLength > STRIPE_WIRE.answerBytes)
        throw new PullError("stripe_unreachable", "Stripe's answer was larger than expected.");
      if (response.status === 429 || response.status >= 500) {
        last = "Stripe is limiting requests or had a fault.";
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isInteger(seconds) && seconds > 0 && seconds <= 10) await sleep(seconds * 1000);
        continue;
      }
      return { status: response.status, body };
    }
    throw new PullError("stripe_unreachable", last);
  };
}

import { STRIPE_WIRE } from "../agent/stripe-wire.ts";
import { redact, safeText } from "./redact.ts";

/** A small, read-only Stripe HTTP client. It can only GET. The key is held in a closure, sent as a
 * bearer token and nowhere else: every message that leaves this module is scrubbed of it, whatever
 * Stripe (or a hostile server) echoes back. `fetch`, the clock, the sleep and the randomness are
 * injected so tests never touch the network or wait.
 *
 * It follows Stripe's guidance for failures: retry 429 (honouring Retry-After) and 5xx and network
 * errors with exponential backoff and jitter, never retry a refusal (401, 403) or a bad request,
 * and stop starting work when the caller's time or request budget is spent. */

export type StripeErrorCode =
  | "stripe_key_rejected"
  | "stripe_permission_denied"
  | "stripe_rate_limited"
  | "stripe_unavailable"
  | "stripe_bad_response"
  | "stripe_request_rejected";

export class StripeError extends Error {
  constructor(
    readonly code: StripeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** Thrown when the time or request budget is spent. Not a failure: the caller stops cleanly and the
 * next call carries on from the last cursor. */
export class BudgetExhausted extends Error {
  constructor() {
    super("The time or request budget for this call is spent");
    this.name = "BudgetExhausted";
  }
}

/** Thrown by a `fetch` that is serving answers somebody else already fetched (`stripe.receive`) when
 * it was asked for one that was not delivered. It is not a failure of Stripe, so the client passes it
 * on without retrying: the caller collects what is missing and asks the sender for it. */
export class ResponseMissing extends Error {
  constructor(readonly request: string) {
    super("A Stripe answer that was needed has not been delivered");
    this.name = "ResponseMissing";
  }
}

/** Shared by everything that talks to Stripe in one call, so the budget covers all of it. */
export interface RequestBudget {
  /** Epoch milliseconds after which no new request starts; null for no deadline. */
  readonly deadline: number | null;
  readonly maxRequests: number;
  used: number;
}

/** How Stripe is reached. Narrower than the global `fetch` type, which carries extras (like
 * `preconnect` in Bun) a stand-in has no reason to provide. */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  readonly key: string;
  readonly fetch: FetchFn;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly budget?: RequestBudget;
  readonly maxAttempts?: number;
}

/** The API version the decoders and fixtures are written against. Pinning it keeps the shapes
 * stable whatever version the Stripe account defaults to. */
export const STRIPE_API_VERSION = STRIPE_WIRE.apiVersion;
export const STRIPE_BASE_URL = "https://api.stripe.com";
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type Query = readonly (readonly [string, string | number])[];

export interface Fetched {
  readonly bytes: Uint8Array;
  readonly json: unknown;
}

export class StripeClient {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ClientOptions) {
    this.key = options.key;
    this.baseUrl = options.baseUrl ?? STRIPE_BASE_URL;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 4;
    const url = new URL(this.baseUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw new TypeError("The Stripe address must be https (or a loopback address in tests)");
  }

  /** Remove the key and anything shaped like one from text. */
  private clean(text: unknown, max = 300): string {
    return safeText(text, { max, secrets: [this.key] });
  }

  private spend(): void {
    const budget = this.options.budget;
    if (!budget) return;
    if (budget.used >= budget.maxRequests) throw new BudgetExhausted();
    if (budget.deadline !== null && this.options.now() >= budget.deadline)
      throw new BudgetExhausted();
    budget.used++;
  }

  private timeoutMs(): number {
    const deadline = this.options.budget?.deadline ?? null;
    if (deadline === null) return 15_000;
    return Math.min(8_000, Math.max(3_000, deadline - this.options.now() + 3_000));
  }

  /** GET `path` with `query`. Resolves with the exact response bytes and their parsed JSON. */
  async get(path: string, query: Query = []): Promise<Fetched> {
    if (!path.startsWith("/v1/")) throw new TypeError("Only Stripe /v1/ paths are read");
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of query) url.searchParams.append(name, String(value));
    let last: StripeError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.spend();
      try {
        return await this.once(url);
      } catch (error) {
        if (!(error instanceof StripeError) || !error.retryable) throw error;
        last = error;
        if (attempt === this.maxAttempts) break;
        const wait = this.backoff(attempt, error);
        const deadline = this.options.budget?.deadline ?? null;
        if (deadline !== null && this.options.now() + wait > deadline) throw new BudgetExhausted();
        await this.sleep(wait);
      }
    }
    throw last ?? new StripeError("stripe_unavailable", "Stripe did not answer.", true);
  }

  private retryAfter = new WeakMap<StripeError, number>();

  private backoff(attempt: number, error: StripeError): number {
    const hinted = this.retryAfter.get(error);
    if (hinted !== undefined) return Math.min(10_000, Math.max(0, hinted));
    const exponential = Math.min(8_000, 250 * 2 ** (attempt - 1));
    return Math.round(exponential / 2 + (this.random() * exponential) / 2);
  }

  private async once(url: URL): Promise<Fetched> {
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.key}`,
          "stripe-version": this.options.apiVersion ?? STRIPE_API_VERSION,
          accept: "application/json",
          "user-agent": "rastrata-stripe/1",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (error) {
      if (error instanceof ResponseMissing) throw error;
      throw new StripeError(
        "stripe_unavailable",
        "Stripe could not be reached. Check the connection and try again.",
        true,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new StripeError(
        "stripe_unavailable",
        "Stripe's answer was cut off. Try again.",
        true,
        response.status,
      );
    }
    if (bytes.byteLength > MAX_BODY_BYTES)
      throw new StripeError(
        "stripe_bad_response",
        "Stripe's answer was larger than expected.",
        false,
      );
    let json: unknown;
    let parsed = true;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      parsed = false;
    }
    if (response.ok) {
      if (!parsed)
        throw new StripeError(
          "stripe_bad_response",
          "Stripe's answer was not valid JSON.",
          false,
          response.status,
        );
      return { bytes, json };
    }
    throw this.failure(response, parsed ? json : null);
  }

  private failure(response: Response, json: unknown): StripeError {
    const status = response.status;
    const detail =
      json && typeof json === "object"
        ? (json as { error?: { message?: unknown; code?: unknown } }).error
        : undefined;
    const said = this.clean(detail?.message, 240);
    if (status === 401)
      return new StripeError(
        "stripe_key_rejected",
        "Stripe rejected the key. Create a new restricted read-only key and replace it.",
        false,
        status,
      );
    if (status === 403)
      return new StripeError(
        "stripe_permission_denied",
        `Stripe refused a request because the key lacks a permission.${said ? ` Stripe says: ${said}` : ""} Add read access for it, or use a key that has it.`,
        false,
        status,
      );
    if (status === 429) {
      const error = new StripeError(
        "stripe_rate_limited",
        "Stripe is limiting requests. Wait a moment and sync again.",
        true,
        status,
      );
      const header = response.headers.get("retry-after");
      const seconds = header && /^[0-9]{1,4}$/.test(header) ? Number(header) : null;
      if (seconds !== null) this.retryAfter.set(error, seconds * 1000);
      return error;
    }
    if (status >= 500)
      return new StripeError(
        "stripe_unavailable",
        "Stripe had a problem answering. Try again shortly.",
        true,
        status,
      );
    return new StripeError(
      "stripe_request_rejected",
      `Stripe rejected a request (${status}).${said ? ` Stripe says: ${said}` : ""}`,
      false,
      status,
    );
  }

  /** Text that may contain the key, made safe. For callers that build their own messages. */
  scrub(text: string): string {
    return redact(text, [this.key]);
  }
}

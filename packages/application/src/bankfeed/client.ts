import { MAX_RESPONSE_BYTES } from "./constants.ts";
import { type AccessUrl, type HostPolicy, parseAccessUrl, parseSetupToken } from "./credentials.ts";
import { type BridgeProblem, readProblems } from "./problems.ts";
import { scrub } from "./redact.ts";

/** A small client for the SimpleFIN Bridge. It can claim a setup token and read accounts, and it can
 * do nothing else: no other path, no redirects, no body but the empty claim.
 *
 * `fetch`, the clock and the sleep are injected, so tests never touch the network or wait. The access
 * URL's credentials travel only in an `Authorization` header: they are never in the URL handed to
 * `fetch` (which would put them in any error it throws), and every message that leaves this module is
 * scrubbed of them whatever the Bridge, or a hostile server, echoes back.
 *
 * Failure handling follows the Bridge's rules, which are strict: an access URL that makes too many
 * requests is disabled. So nothing is retried that could be a refusal (401, 402, 403, 429 and any
 * other 4xx are final), a network failure or a 5xx is retried once (each attempt is a request and is
 * counted), and a `guard` is asked before every request so a daily budget can stop the call. */

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BridgeErrorCode =
  | "bankfeed_token_invalid"
  | "bankfeed_host_refused"
  | "bankfeed_token_rejected"
  | "bankfeed_access_denied"
  | "bankfeed_payment_required"
  | "bankfeed_rate_limited"
  | "bankfeed_unavailable"
  | "bankfeed_bad_response"
  | "bankfeed_redirected"
  | "bankfeed_request_rejected";

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    /** For a rate limit: epoch milliseconds before which no request should be made. */
    readonly until: number | null = null,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Thrown by a guard when the next request must not be made: a budget is spent. Not a failure: the
 * caller stops cleanly and the next call carries on from the last applied cursor. */
export class BridgeBudgetSpent extends Error {
  constructor(
    readonly reason: "daily_budget" | "call_budget" | "rate_limited",
    /** Epoch milliseconds from which asking is allowed again, when that is known. */
    readonly until: number | null = null,
  ) {
    super("No further request to the Bridge may be made now");
    this.name = "BridgeBudgetSpent";
  }
}

/** What was asked, for the record of requests (the Bridge's quota is counted from it). */
export interface RequestEvent {
  readonly kind: "claim" | "listing" | "account";
  readonly accountId: string | null;
  /** The HTTP status, or null when no answer came. */
  readonly status: number | null;
  readonly at: number;
}

export interface ClientOptions {
  readonly fetch: FetchFn;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Asked before every request; throws `BridgeBudgetSpent` to stop the call. */
  readonly guard?: (kind: RequestEvent["kind"]) => void;
  /** Told after every request, whether or not an answer came. */
  readonly onRequest?: (event: RequestEvent) => void;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export interface Fetched {
  readonly bytes: Uint8Array;
  readonly json: unknown;
  readonly status: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

/** Read a body up to the limit; null if it is larger. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limit) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array): { ok: true; json: unknown } | { ok: false } {
  try {
    return { ok: true, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);

class Transport {
  constructor(protected readonly options: ClientOptions) {}

  /** One attempt. Returns the response, or throws `BridgeError`. */
  private async once(
    url: string,
    init: RequestInit,
    kind: RequestEvent["kind"],
    accountId: string | null,
  ): Promise<Response> {
    this.options.guard?.(kind);
    const at = this.options.now();
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      // Whatever fetch says may name the address; it is replaced by a fixed sentence.
      this.options.onRequest?.({ kind, accountId, status: null, at });
      throw new BridgeError(
        "bankfeed_unavailable",
        "The SimpleFIN Bridge could not be reached. Check the connection and try again.",
        true,
      );
    }
    this.options.onRequest?.({ kind, accountId, status: response.status, at });
    return response;
  }

  /** Make a request, retrying a network failure or a 5xx once. */
  protected async attempt(
    url: string,
    init: RequestInit,
    kind: RequestEvent["kind"],
    accountId: string | null,
  ): Promise<Response> {
    const attempts = Math.max(1, this.options.maxAttempts ?? 2);
    let last: BridgeError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.once(url, init, kind, accountId);
        if (response.status < 500 || attempt === attempts) return response;
        void response.body?.cancel().catch(() => {});
        last = new BridgeError(
          "bankfeed_unavailable",
          "The SimpleFIN Bridge had a problem answering. Try again shortly.",
          true,
          response.status,
        );
      } catch (error) {
        if (!(error instanceof BridgeError) || !error.retryable || attempt === attempts)
          throw error;
        last = error;
      }
      await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        1_500,
      );
    }
    throw (
      last ?? new BridgeError("bankfeed_unavailable", "The SimpleFIN Bridge did not answer.", true)
    );
  }
}

/** Only ever used to claim: a POST with no body to the claim URL a setup token names. */
class ClaimTransport extends Transport {
  post(url: string): Promise<Response> {
    return this.attempt(url, { method: "POST" }, "claim", null);
  }
}

/** Claim a setup token: POST to the claim URL it names, with no body. The reply is the access URL.
 *
 * The caller has already checked that it can keep the access URL (a token can be claimed only once),
 * and must keep it before doing anything else. A 403 means the token does not exist or was already
 * claimed, which the spec says could mean someone else has the person's bank data: the message says so. */
export async function claimSetupToken(
  setupToken: string,
  policy: HostPolicy,
  options: ClientOptions,
): Promise<{ readonly accessUrl: string }> {
  const parsed = parseSetupToken(setupToken, policy);
  if (!parsed.ok) throw new BridgeError(parsed.code, parsed.message, false);
  const response = await new ClaimTransport(options).post(parsed.claimUrl);
  if (isRedirect(response))
    throw new BridgeError(
      "bankfeed_redirected",
      "The SimpleFIN Bridge answered the claim with a redirect, which Rastrata does not follow. Nothing was claimed.",
      false,
      response.status,
    );
  if (response.status === 403)
    throw new BridgeError(
      "bankfeed_token_rejected",
      "SimpleFIN says this setup token does not exist or has already been used. If you did not use it yourself, it may have been compromised: sign in at the SimpleFIN Bridge, disable it, and create a new one. Then try again with the new token.",
      false,
      403,
    );
  const bytes = await readBounded(response, 4096).catch(() => null);
  if (response.status !== 200 || bytes === null)
    throw new BridgeError(
      response.status >= 500 ? "bankfeed_unavailable" : "bankfeed_request_rejected",
      `The SimpleFIN Bridge did not accept the claim (${response.status}). The token has not been used up unless the Bridge says so; try again, or create a new one.`,
      response.status >= 500,
      response.status,
    );
  const text = new TextDecoder("utf-8").decode(bytes).trim();
  // The reply is checked before it is used: an https address of the Bridge, with a user and password.
  if (parseAccessUrl(text, policy) === null)
    throw new BridgeError(
      "bankfeed_bad_response",
      "The SimpleFIN Bridge accepted the claim but its answer was not a usable access URL. The token is used up; create a new one and try again.",
      false,
    );
  return { accessUrl: text };
}

export interface AccountsQuery {
  /** Only this account (the Bridge counts these requests against their own quota). */
  readonly account?: string;
  /** Epoch seconds, inclusive. */
  readonly startDate?: number;
  /** Epoch seconds, exclusive. */
  readonly endDate?: number;
  /** No transaction data: the cheapest way to list accounts and balances. */
  readonly balancesOnly?: boolean;
}

export class BridgeClient extends Transport {
  constructor(
    private readonly access: AccessUrl,
    options: ClientOptions,
  ) {
    super(options);
  }

  /** Remove the credentials and anything shaped like them from text. */
  scrubText(text: string): string {
    return scrub(text, this.access.secrets);
  }

  /** `GET {access}/accounts`. Always asks for version 2 (as the Bridge's own examples do) and never
   * for pending transactions. Parameters are percent-encoded one by one: an account id can hold a
   * space. Resolves with the exact bytes of the answer and the parsed JSON of a 200. */
  async accounts(query: AccountsQuery = {}): Promise<Fetched> {
    const parts = ["version=2"];
    if (query.account !== undefined) parts.push(`account=${encodeURIComponent(query.account)}`);
    if (query.startDate !== undefined) parts.push(`start-date=${Math.trunc(query.startDate)}`);
    if (query.endDate !== undefined) parts.push(`end-date=${Math.trunc(query.endDate)}`);
    if (query.balancesOnly) parts.push("balances-only=1");
    const url = `${this.access.base}/accounts?${parts.join("&")}`;
    const kind = query.balancesOnly ? "listing" : "account";
    const response = await this.attempt(
      url,
      {
        method: "GET",
        headers: {
          authorization: this.access.authorization,
          accept: "application/json",
          "user-agent": "rastrata-bankfeed/1",
        },
      },
      kind,
      query.account ?? null,
    );
    return this.read(response);
  }

  private async read(response: Response): Promise<Fetched> {
    const status = response.status;
    if (isRedirect(response))
      throw new BridgeError(
        "bankfeed_redirected",
        "The SimpleFIN Bridge answered with a redirect, which Rastrata does not follow (the access URL goes only where it was issued). Disconnect and connect again with a new setup token.",
        false,
        status,
      );
    let bytes: Uint8Array | null;
    try {
      bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch {
      throw new BridgeError(
        "bankfeed_unavailable",
        "The SimpleFIN Bridge's answer was cut off. Try again.",
        true,
        status,
      );
    }
    if (bytes === null)
      throw new BridgeError(
        "bankfeed_bad_response",
        "The SimpleFIN Bridge's answer was larger than Rastrata will read.",
        false,
        status,
      );
    const parsed = parseJson(bytes);
    if (status === 200) {
      if (
        !parsed.ok ||
        parsed.json === null ||
        typeof parsed.json !== "object" ||
        Array.isArray(parsed.json)
      )
        throw new BridgeError(
          "bankfeed_bad_response",
          "The SimpleFIN Bridge's answer was not valid JSON.",
          false,
          status,
        );
      return { bytes, json: parsed.json, status };
    }
    // What the Bridge says about a refusal is shown, quoted as its words and made safe.
    const problems: BridgeProblem[] =
      parsed.ok &&
      parsed.json !== null &&
      typeof parsed.json === "object" &&
      !Array.isArray(parsed.json)
        ? readProblems(parsed.json as Record<string, unknown>, this.access.secrets)
        : [];
    const said = problems[0]?.message ?? "";
    const quoted = said === "" ? "" : ` The Bridge says: "${said}"`;
    if (status >= 500)
      throw new BridgeError(
        "bankfeed_unavailable",
        "The SimpleFIN Bridge had a problem answering. Try again shortly.",
        true,
        status,
      );
    if (status === 402)
      throw new BridgeError(
        "bankfeed_payment_required",
        `The SimpleFIN Bridge says payment is required: the subscription may have lapsed. Sign in at the Bridge to renew it, then sync again.${quoted}`,
        false,
        status,
      );
    if (status === 401 || status === 403)
      throw new BridgeError(
        "bankfeed_access_denied",
        `The SimpleFIN Bridge did not accept Rastrata's access (${status}). The access may have been revoked, or disabled because too many requests were made. Sign in at the Bridge, create a new setup token, and connect again.${quoted}`,
        false,
        status,
      );
    if (status === 429) {
      throw new BridgeError(
        "bankfeed_rate_limited",
        "The SimpleFIN Bridge says Rastrata is asking too often. Rastrata has stopped asking for 24 hours so the Bridge does not disable its access.",
        true,
        status,
        this.options.now() + 24 * 60 * 60 * 1000,
      );
    }
    throw new BridgeError(
      "bankfeed_request_rejected",
      `The SimpleFIN Bridge rejected a request (${status}).${quoted}`,
      false,
      status,
    );
  }
}

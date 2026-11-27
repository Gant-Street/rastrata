import { systemClock, type Clock } from "./clock.ts";
import { ObjectStoreError, ObjectStoreUncertain } from "./objectstore.ts";
import { Rng } from "./rng.ts";
import { assertSecureRemote } from "./secure-url.ts";
import type { SteadyFetch } from "./steady-fetch.ts";
import { BookDeletedError } from "./tier.ts";
import type {
  AcquireResult,
  AdoptResult,
  AdoptState,
  AppendInput,
  AppendResult,
  LogTier,
  RenewResult,
  SealManifest,
  SealResult,
  TailEntry,
  TierCapabilities,
  TierHead,
  TierPage,
} from "./tier.ts";

/** The tail as a Durable Object per book, spoken to over HTTP. This file is the client, the wire protocol
 * and a fake Worker to test them against; the Worker that serves it is apps/tail-worker (a SQLite-backed
 * Durable Object per book, with the same two tables as the Postgres tail, book_log and book_head, and the
 * object's own clock for leases). {@link durableObjectHandler} is its job as a function over any LogTier.
 *
 * Protocol (all bodies JSON, all requests `POST /v1/books/<book>/<operation>` with
 * `authorization: Bearer <token>`; a byte string travels as base64):
 *
 *   head     {}                                         -> TierHead
 *   read     {seq, limit?}                              -> {entries: TailEntry[], head: TierHead}
 *   append   {seq, prevHash, hash, fence, body}         -> {ok:true, duplicate, head} | {ok:false, reason, head}
 *   acquire  {holder, ttlMs}                            -> {ok:true, lease} | {ok:false, heldBy, expiresInMs, head}
 *   renew    {holder, fence, ttlMs}                     -> {ok:true, lease} | {ok:false, reason, head}
 *   release  {holder, fence}                            -> {}
 *   seal     {upTo, manifest}                           -> {ok:true, trimmed, head} | {ok:false, reason, head}
 *   adopt    {seq, hash, fence}                         -> {ok:true, head} | {ok:false, reason:"not_empty", head}
 *            (an operator's step: a tail that lost the book gets a head at the newest sealed entry)
 *
 * One Durable Object serves one book and handles one request at a time, so each operation is atomic
 * with no further locking; its clock decides when a lease lapses. Errors: 401 for a bad token, 400 for
 * a malformed request, 5xx for anything the object could not do (the client then treats the outcome of
 * a write as uncertain and reads the tail back). So are a 429, a 408, a timeout and any answer that is
 * not JSON (an error page of Cloudflare's, such as error 1027, the free plan's daily limit): the tail
 * was not reached. Put a {@link GuardedLogTier} in front of this client so that a tail which keeps
 * failing is not called again and again. */

/** The largest entry (header and compressed payload, as stored) the Worker accepts: an entry is one row of
 * a Durable Object's SQLite database, which cannot hold much more than 2 MB (apps/tail-worker). A host
 * that uses this tail sets `commit.maxStoredEntryBytes` to it, so that a request that changes more is
 * refused with a clear error before anything is sent. */
export const DURABLE_OBJECT_MAX_ENTRY_BYTES = 1024 * 1024;

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

interface WireEntry {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly fence: number;
  readonly body: string;
  readonly writtenAt: number;
}

export interface DurableObjectTierOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Give up on a request after this long; the answer is then "uncertain" (default 10 s). */
  readonly timeoutMs?: number;
  /** How the calls are sent when the tail is a service somewhere else (steady-fetch.ts): a call that can be made twice is sent again when it does not answer at once. Without it each call is sent once. */
  readonly steady?: SteadyFetch;
}

/** The calls that are the same made twice as made once: the reads, and a lease asked for or renewed (the tail gives the same holder the same lease again). An append is not: what became of one that did not
 * answer is the runtime's to find out. */
const REPEATABLE: ReadonlySet<string> = new Set(["head", "read", "acquire", "renew"]);

export class DurableObjectLogTier implements LogTier {
  readonly capabilities: TierCapabilities = { name: "durable-object", leases: true };
  readonly #options: DurableObjectTierOptions;

  constructor(options: DurableObjectTierOptions) {
    // The token goes in a header of every call: never to another computer in clear text. (A caller that
    // brings its own `fetch` owns the transport, as the tests do.)
    if (!options.fetch) assertSecureRemote(options.baseUrl, "The tail address");
    this.#options = options;
  }

  async #call<T>(book: string, operation: string, body: unknown): Promise<T> {
    const url = `${this.#options.baseUrl.replace(/\/+$/, "")}/v1/books/${encodeURIComponent(book)}/${operation}`;
    const send = this.#options.fetch ?? ((target, init) => fetch(target, init));
    const timeoutMs = this.#options.timeoutMs ?? 10_000;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#options.token ? { authorization: `Bearer ${this.#options.token}` } : {}),
      },
      body: JSON.stringify(body),
      // A redirect would carry the token to wherever it points.
      redirect: "error",
    };
    let response: Response;
    try {
      response = this.#options.steady
        ? await this.#options.steady(url, init, {
            what: `tail ${operation}`,
            repeatable: REPEATABLE.has(operation),
            timeoutMs,
          })
        : await send(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ObjectStoreUncertain(
        `durable object ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A limit of the service is announced in the answer's text (error 1027, the daily limit of Cloudflare's
    // free plan, arrives as an HTML page); say so in the error, without repeating the page.
    const limit = async (): Promise<string> =>
      /\b1027\b/.test((await response.text().catch(() => "")).slice(0, 4000))
        ? " (Cloudflare error 1027, a limit of the service)"
        : "";
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new ObjectStoreUncertain(
        `durable object ${operation}: HTTP ${response.status}${await limit()}`,
        response.status,
      );
    }
    // Every answer of the Worker is JSON, errors included. Anything else is not the Worker speaking: an
    // error page of Cloudflare's, of a proxy or of a login wall. Whatever status it came with, the tail
    // was not reached, so it is the same as a tail that is down.
    if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) {
      throw new ObjectStoreUncertain(
        `durable object ${operation}: HTTP ${response.status}, an answer that is not JSON${await limit()}`,
        response.status,
        "NotJson",
      );
    }
    // The book was deleted and the tail keeps a mark that says so: every call for it, of any kind, is this answer, and trying again changes nothing.
    if (response.status === 410) throw new BookDeletedError();
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ObjectStoreError(
        `durable object ${operation}: HTTP ${response.status} ${text}`,
        response.status,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ObjectStoreUncertain(
        `durable object ${operation}: HTTP ${response.status}, an answer that is not valid JSON`,
        response.status,
        "NotJson",
      );
    }
  }

  head(book: string): Promise<TierHead> {
    return this.#call(book, "head", {});
  }

  async readFrom(book: string, seq: number, limit?: number): Promise<TierPage> {
    const page = await this.#call<{ entries: WireEntry[]; head: TierHead }>(book, "read", {
      seq,
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      head: page.head,
      entries: page.entries.map((entry): TailEntry => ({ ...entry, body: fromBase64(entry.body) })),
    };
  }

  append(book: string, input: AppendInput): Promise<AppendResult> {
    return this.#call(book, "append", { ...input, body: toBase64(input.body) });
  }
  acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    return this.#call(book, "acquire", { holder, ttlMs });
  }
  renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    return this.#call(book, "renew", { ...lease, ttlMs });
  }
  async release(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
  ): Promise<void> {
    await this.#call(book, "release", lease);
  }
  seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    return this.#call(book, "seal", input);
  }
  adopt(book: string, state: AdoptState): Promise<AdoptResult> {
    return this.#call(book, "adopt", state);
  }
}

/** The Worker's side of the protocol: route a request to a LogTier (in production the object's own
 * storage; here any implementation, so the contract suite can run against the wire). */
export function durableObjectHandler(
  core: LogTier,
  options: { readonly token?: string } = {},
): (request: Request) => Promise<Response> {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  return async (request) => {
    if (options.token && request.headers.get("authorization") !== `Bearer ${options.token}`)
      return json({ error: "unauthorized" }, 401);
    const match =
      /^\/v1\/books\/([^/]+)\/(head|read|append|acquire|renew|release|seal|adopt)$/.exec(
        new URL(request.url).pathname,
      );
    if (!match || request.method !== "POST") return json({ error: "not found" }, 404);
    const book = decodeURIComponent(match[1] as string);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "bad json" }, 400);
    }
    try {
      switch (match[2]) {
        case "head":
          return json(await core.head(book));
        case "read": {
          const page = await core.readFrom(
            book,
            Number(body.seq),
            body.limit === undefined ? undefined : Number(body.limit),
          );
          return json({
            head: page.head,
            entries: page.entries.map(
              (entry): WireEntry => ({ ...entry, body: toBase64(entry.body) }),
            ),
          });
        }
        case "append":
          return json(
            await core.append(book, {
              seq: Number(body.seq),
              prevHash: String(body.prevHash),
              hash: String(body.hash),
              fence: Number(body.fence),
              body: fromBase64(String(body.body)),
            }),
          );
        case "acquire":
          return json(await core.acquire(book, String(body.holder), Number(body.ttlMs)));
        case "renew":
          return json(
            await core.renew(
              book,
              { holder: String(body.holder), fence: Number(body.fence) },
              Number(body.ttlMs),
            ),
          );
        case "release":
          await core.release(book, { holder: String(body.holder), fence: Number(body.fence) });
          return json({});
        case "adopt":
          if (!core.adopt) return json({ error: "this tail cannot be restored" }, 501);
          return json(
            await core.adopt(book, {
              seq: Number(body.seq),
              hash: String(body.hash),
              fence: Number(body.fence),
            }),
          );
        default:
          return json(
            await core.seal(book, {
              upTo: Number(body.upTo),
              manifest: body.manifest as SealManifest,
            }),
          );
      }
    } catch (error) {
      // What the tail Worker answers for a book it has a mark for (see apps/tail-worker).
      if (error instanceof BookDeletedError) return json({ error: "deleted" }, 410);
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}

export interface FakeDurableObjectOptions {
  /** The tail's own implementation behind the wire. */
  readonly core: LogTier;
  readonly token?: string;
  /** Round trip from a client to the object and back, as a log-normal (the charter's measured save was 94 ms at p95). */
  readonly latency?: { readonly medianMs: number; readonly sigma?: number };
  readonly seed?: number;
  readonly clock?: Clock;
}

/** A `fetch` that answers as the Durable Object Worker would, with the extra hop's latency. */
export function fakeDurableObjectFetch(
  options: FakeDurableObjectOptions,
): (url: string, init: RequestInit) => Promise<Response> {
  const handler = durableObjectHandler(options.core, options.token ? { token: options.token } : {});
  const clock = options.clock ?? systemClock;
  const rng = new Rng(options.seed ?? 1);
  return async (url, init) => {
    const median = options.latency?.medianMs ?? 0;
    const trip = () =>
      median > 0
        ? clock.sleep(rng.lognormal(median / 2, options.latency?.sigma ?? 0.4))
        : Promise.resolve();
    await trip();
    const response = await handler(new Request(url, init));
    await trip();
    return response;
  };
}

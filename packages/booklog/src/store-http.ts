import { createHash } from "node:crypto";
import {
  MAX_LIST,
  ObjectStoreError,
  ObjectStoreUncertain,
  type ListedObject,
  type ListPage,
  type ObjectMeta,
  type ObjectStore,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from "./objectstore.ts";
import { assertSecureRemote } from "./secure-url.ts";
import type { SteadyFetch } from "./steady-fetch.ts";

/** The bulk store as the tail Worker's gateway (apps/tail-worker, src/bulk.ts): the same bearer token as the
 * tail, and the objects in R2 behind it. The interface is {@link ObjectStore}; what is different from an S3
 * store is what it cannot do. A write is create-only, as in S3, but there is no delete at all (the gateway
 * has no such route, so a pod that holds the token cannot erase a book), and `delete` here says so.
 *
 *   PUT  /v1/bulk/<key>                 201 {etag,size} | 412 (the key exists)
 *   GET  /v1/bulk/<key>                 200 bytes | 404
 *   HEAD /v1/bulk/<key>                 200 | 404
 *   GET  /v1/bulk?prefix=&after=&limit= 200 {objects:[{key,size,etag}], truncated}
 *
 * User metadata travels as `x-meta-<name>` headers; a put carries `x-content-sha256` so that R2 itself checks
 * the body. Every answer of the Worker carries `x-rastrata-bulk: 1`. A client believes an answer only if it has
 * it: a "not found" from an error page of Cloudflare's or a proxy's is not the object being absent (a store that
 * said so would let a caller write over history it could not see), it is a failure to ask.
 *
 * Failures are told as {@link S3ObjectStore} tells them: an answer that leaves a write's fate unknown (a timeout,
 * a dropped connection, any 5xx, 429, 408, anything that is not this Worker speaking) is an
 * {@link ObjectStoreUncertain}, and the caller reads the object back; a refusal is an {@link ObjectStoreError}. */
export interface HttpObjectStoreOptions {
  /** `https://host` (or `http://127.0.0.1:port` for a test); a path, if any, is kept. */
  readonly baseUrl: string;
  readonly token: string;
  /** Give up on a request after this long (default 30 s: an object can be tens of megabytes). */
  readonly timeoutMs?: number;
  /** For tests. When it is given, the address is not required to be https (the caller owns the transport). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** How the calls are sent when the gateway is a service somewhere else (steady-fetch.ts): a read that does not answer at once is sent again. Without it each call is sent once. */
  readonly steady?: SteadyFetch;
}

const MARK = "x-rastrata-bulk";
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    return error.message;
  }
  return String(error);
}

export class HttpObjectStore implements ObjectStore {
  readonly #base: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #send: (url: string, init: RequestInit) => Promise<Response>;
  readonly #steady: SteadyFetch | undefined;

  constructor(options: HttpObjectStoreOptions) {
    if (!options.token) throw new Error("The bulk gateway needs its token");
    if (!options.fetch) assertSecureRemote(options.baseUrl, "The bulk store address");
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#send = options.fetch ?? ((url, init) => fetch(url, init));
    this.#steady = options.steady;
  }

  async putIfAbsent(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult> {
    const headers: Record<string, string> = {
      "content-type": options?.contentType ?? "application/octet-stream",
      "x-content-sha256": sha256Hex(body),
    };
    for (const [name, value] of Object.entries(options?.metadata ?? {}))
      headers[`x-meta-${name.toLowerCase()}`] = value;
    const response = await this.#request("PUT", "put", this.#objectUrl(key), headers, body);
    if (response.status === 201 && this.#fromWorker(response)) {
      const answer = (await response.json().catch(() => ({}))) as { etag?: string };
      return { created: true, etag: answer.etag ?? "" };
    }
    if (response.status === 412 && this.#fromWorker(response)) {
      await response.body?.cancel();
      return { created: false };
    }
    throw await this.#failure("PUT", key, response);
  }

  async get(key: string): Promise<StoredObject | null> {
    const response = await this.#request("GET", "get", this.#objectUrl(key), {});
    if (response.status === 404 && this.#fromWorker(response)) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200 || !this.#fromWorker(response))
      throw await this.#failure("GET", key, response);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new ObjectStoreUncertain(`GET ${key}: the body was cut short (${describe(error)})`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== bytes.byteLength)
      throw new ObjectStoreUncertain(`GET ${key}: the body was cut short`);
    return { key, body: bytes, size: bytes.byteLength, ...this.#meta(response) };
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const response = await this.#request("HEAD", "head", this.#objectUrl(key), {});
    if (response.status === 404 && this.#fromWorker(response)) return null;
    if (response.status !== 200 || !this.#fromWorker(response))
      throw await this.#failure("HEAD", key, response);
    return {
      key,
      size: Number(response.headers.get("content-length") ?? "0"),
      ...this.#meta(response),
    };
  }

  async list(prefix: string, after?: string, limit?: number): Promise<ListPage> {
    const bound = Math.min(Math.max(1, limit ?? MAX_LIST), MAX_LIST);
    const query = new URLSearchParams({ prefix, limit: String(bound) });
    if (after !== undefined) query.set("after", after);
    const response = await this.#request("GET", "list", `${this.#base}/v1/bulk?${query}`, {});
    if (response.status !== 200 || !this.#fromWorker(response))
      throw await this.#failure("LIST", prefix, response);
    let answer: { objects?: ListedObject[]; truncated?: boolean };
    try {
      answer = (await response.json()) as typeof answer;
    } catch {
      throw new ObjectStoreUncertain(`LIST ${prefix}: an answer that is not valid JSON`);
    }
    if (!Array.isArray(answer.objects))
      throw new ObjectStoreUncertain(`LIST ${prefix}: an answer that is not a listing`);
    return {
      objects: answer.objects.map((object) => ({
        key: object.key,
        size: object.size,
        etag: object.etag,
      })),
      truncated: answer.truncated === true,
    };
  }

  /** There is no delete: the gateway has no route for it, so that a token cannot be used to erase a book. */
  async delete(_key: string): Promise<void> {
    throw new ObjectStoreError("This store cannot delete: the gateway has no delete", 405);
  }

  #objectUrl(key: string): string {
    return `${this.#base}/v1/bulk/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  #fromWorker(response: Response): boolean {
    return response.headers.get(MARK) === "1";
  }

  #meta(response: Response): { etag: string; metadata: Record<string, string> } {
    const metadata: Record<string, string> = {};
    for (const [name, value] of response.headers.entries())
      if (name.startsWith("x-meta-")) metadata[name.slice("x-meta-".length)] = value;
    return { etag: response.headers.get("etag") ?? "", metadata };
  }

  /** `operation` is what is asked, for the log of a slow call ("get", "list"): a read is the same asked twice, a write is sent once. */
  async #request(
    method: string,
    operation: "put" | "get" | "head" | "list",
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { ...headers, authorization: `Bearer ${this.#token}` },
      // A redirect would carry the token to wherever it points.
      redirect: "error",
      ...(body ? { body: body as BodyInit } : {}),
    };
    try {
      return this.#steady
        ? await this.#steady(url, init, {
            what: `bucket ${operation}`,
            repeatable: operation !== "put",
            timeoutMs: this.#timeoutMs,
          })
        : await this.#send(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      // The message of a transport error can name the address; it never holds the token, which is only a header.
      throw new ObjectStoreUncertain(`${method} ${new URL(url).pathname}: ${describe(error)}`);
    }
  }

  async #failure(operation: string, key: string, response: Response): Promise<ObjectStoreError> {
    const worker = this.#fromWorker(response);
    let message = "";
    let limit = false;
    try {
      const text = (await response.text()).slice(0, 4000);
      // The free plan's daily limit arrives as an HTML page (error 1027), from Cloudflare and not from the Worker.
      limit = /\b1027\b/.test(text);
      if (worker) message = (JSON.parse(text) as { error?: string }).error ?? "";
    } catch {
      /* the status is enough */
    }
    const text = `${operation} ${key}: HTTP ${response.status}${message ? `, ${message}` : ""}${worker ? "" : limit ? " (Cloudflare error 1027, a limit of the service)" : ", not an answer of the gateway"}`;
    // Anything that is not the Worker speaking, and the Worker's own 5xx, leaves a write's fate unknown; a read
    // that failed that way can simply be asked again.
    if (!worker || response.status >= 500 || response.status === 429 || response.status === 408)
      return new ObjectStoreUncertain(text, response.status);
    return new ObjectStoreError(text, response.status);
  }
}

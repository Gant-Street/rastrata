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
import { sha256Hex, signRequest, uriEncode } from "./sigv4.ts";

export interface S3Config {
  /** `https://<account>.r2.cloudflarestorage.com`, an OCI compatibility endpoint, `http://127.0.0.1:9000` for MinIO. */
  readonly endpoint: string;
  readonly bucket: string;
  /** "auto" for R2; the region name for OCI Object Storage and S3. */
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Give up on a request after this long (default 10 s). The answer is then "uncertain". */
  readonly timeoutMs?: number;
  /** Reuse connections (default true). False sends `Connection: close` so every request pays for a new one. */
  readonly keepAlive?: boolean;
  /** For tests. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeEntities(match[1] as string) : undefined;
};

/** The S3 API as R2, OCI Object Storage and MinIO speak it, path-style, signed with SigV4. Only what
 * the log needs: create-only PUT, GET, HEAD, ListObjectsV2 and DELETE. A failure that leaves the
 * outcome of a write unknown (timeout, dropped connection, any 5xx, a 409 conflict in flight) is an
 * {@link ObjectStoreUncertain}; the caller reads the object back to find out. */
export class S3ObjectStore implements ObjectStore {
  readonly #config: S3Config;
  readonly #base: string;
  readonly #region: string;
  readonly #send: (url: string, init: RequestInit) => Promise<Response>;

  constructor(config: S3Config) {
    this.#config = config;
    this.#base = `${config.endpoint.replace(/\/+$/, "")}/${uriEncode(config.bucket)}`;
    this.#region = config.region ?? "auto";
    this.#send = config.fetch ?? ((url, init) => fetch(url, init));
  }

  async putIfAbsent(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult> {
    const headers: Record<string, string> = {
      "content-type": options?.contentType ?? "application/octet-stream",
      "if-none-match": "*",
    };
    for (const [name, value] of Object.entries(options?.metadata ?? {}))
      headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    const response = await this.#request("PUT", this.#objectUrl(key), headers, body);
    if (response.status === 200 || response.status === 201) {
      await response.body?.cancel();
      return { created: true, etag: response.headers.get("etag") ?? "" };
    }
    if (response.status === 412) {
      await response.body?.cancel();
      return { created: false };
    }
    throw await this.#failure("PUT", key, response, true);
  }

  async get(key: string): Promise<StoredObject | null> {
    const response = await this.#request("GET", this.#objectUrl(key), {});
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) throw await this.#failure("GET", key, response, false);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new ObjectStoreUncertain(`GET ${key}: the body was cut short (${describe(error)})`);
    }
    return { key, body: bytes, size: bytes.byteLength, ...this.#meta(response) };
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const response = await this.#request("HEAD", this.#objectUrl(key), {});
    if (response.status === 404) return null;
    if (response.status !== 200) throw await this.#failure("HEAD", key, response, false);
    return {
      key,
      size: Number(response.headers.get("content-length") ?? "0"),
      ...this.#meta(response),
    };
  }

  async list(prefix: string, after?: string, limit?: number): Promise<ListPage> {
    const bound = Math.min(Math.max(1, limit ?? MAX_LIST), MAX_LIST);
    const query = [
      ["list-type", "2"],
      ["max-keys", String(bound)],
      ["prefix", prefix],
      ...(after !== undefined ? [["start-after", after] as const] : []),
    ]
      .map(([name, value]) => `${uriEncode(name as string)}=${uriEncode(value as string)}`)
      .sort()
      .join("&");
    const response = await this.#request("GET", `${this.#base}?${query}`, {});
    if (response.status !== 200) throw await this.#failure("LIST", prefix, response, false);
    const xml = await response.text();
    const objects: ListedObject[] = [];
    for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = block[1] as string;
      const key = tag(body, "Key");
      if (key === undefined) continue;
      objects.push({
        key,
        size: Number(tag(body, "Size") ?? "0"),
        etag: tag(body, "ETag") ?? "",
      });
    }
    return { objects, truncated: tag(xml, "IsTruncated") === "true" };
  }

  async delete(key: string): Promise<void> {
    const response = await this.#request("DELETE", this.#objectUrl(key), {});
    if (response.status === 204 || response.status === 200 || response.status === 404) {
      await response.body?.cancel();
      return;
    }
    throw await this.#failure("DELETE", key, response, false);
  }

  #objectUrl(key: string): string {
    return `${this.#base}/${uriEncode(key, true)}`;
  }

  #meta(response: Response): { etag: string; metadata: Record<string, string> } {
    const metadata: Record<string, string> = {};
    for (const [name, value] of response.headers.entries())
      if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
    return { etag: response.headers.get("etag") ?? "", metadata };
  }

  async #request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const target = new URL(url);
    const payloadHash = sha256Hex(body ?? "");
    const signed = signRequest({
      method,
      url: target,
      headers,
      payloadHash,
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      ...(this.#config.sessionToken ? { sessionToken: this.#config.sessionToken } : {}),
      region: this.#region,
      date: this.#config.now?.() ?? new Date(),
    });
    // `host` is signed and sent by the HTTP client from the URL; do not set it twice. `connection`
    // is a hop-by-hop header and is not signed.
    const { host: _host, ...send } = signed.headers;
    if (this.#config.keepAlive === false) send.connection = "close";
    const init: RequestInit = {
      method,
      headers: send,
      signal: AbortSignal.timeout(this.#config.timeoutMs ?? 10_000),
      ...(body ? { body: body as BodyInit } : {}),
      ...(this.#config.keepAlive === false ? { keepalive: false } : {}),
    };
    try {
      return await this.#send(target.toString(), init);
    } catch (error) {
      throw new ObjectStoreUncertain(`${method} ${target.pathname}: ${describe(error)}`);
    }
  }

  async #failure(
    operation: string,
    key: string,
    response: Response,
    write: boolean,
  ): Promise<ObjectStoreError> {
    let code: string | undefined;
    let message = "";
    try {
      const text = await response.text();
      code = tag(text, "Code");
      message = tag(text, "Message") ?? "";
    } catch {
      /* the status is enough */
    }
    const text = `${operation} ${key}: HTTP ${response.status}${code ? ` ${code}` : ""}${message ? `, ${message}` : ""}`;
    // 5xx, throttling, a request timeout, and S3's "another conditional write is in flight" leave a
    // write's fate unknown; a read that failed that way can simply be asked again.
    if (response.status >= 500 || response.status === 429 || response.status === 408)
      return new ObjectStoreUncertain(text, response.status, code);
    if (write && response.status === 409) return new ObjectStoreUncertain(text, 409, code);
    return new ObjectStoreError(text, response.status, code);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    return error.message;
  }
  return String(error);
}

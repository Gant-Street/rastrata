import { createHash } from "node:crypto";
import { sha256Hex, signRequest } from "../../src/sigv4.ts";

export const FAKE_ACCESS = "AKIDEXAMPLE";
export const FAKE_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

interface Stored {
  body: Uint8Array;
  meta: Record<string, string>;
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Just enough S3 to test the client without a network: path-style objects, create-only writes,
 * ListObjectsV2, metadata, and a check that every request carries a signature we can reproduce
 * from what was sent (so the client cannot sign one thing and send another). */
export class FakeS3 {
  readonly objects = new Map<string, Stored>();
  readonly requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  /** Responses to give the next requests instead of serving them: a status, or "stall". */
  readonly script: (number | "stall")[] = [];
  readonly server: ReturnType<typeof Bun.serve>;

  constructor(readonly bucket = "bucket") {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.#handle(request),
    });
  }
  get endpoint(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }
  stop(): void {
    this.server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers.entries()) headers[name] = value;
    this.requests.push({ method: request.method, path: url.pathname + url.search, headers });
    const body = new Uint8Array(await request.arrayBuffer());

    const next = this.script.shift();
    if (next === "stall") return new Promise<Response>(() => {});
    if (next !== undefined)
      return new Response(
        `<Error><Code>Injected</Code><Message>injected ${next}</Message></Error>`,
        {
          status: next,
        },
      );

    const authorization = headers.authorization ?? "";
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
    const given = /Signature=([0-9a-f]+)/.exec(authorization)?.[1];
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(authorization)?.[1] ?? "";
    const stamp = headers["x-amz-date"] ?? "";
    const date = new Date(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    );
    const extra: Record<string, string> = {};
    for (const name of signedHeaders)
      if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(name))
        extra[name] = headers[name] ?? "";
    const expected = signRequest({
      method: request.method,
      url,
      headers: extra,
      payloadHash: headers["x-amz-content-sha256"] ?? "",
      accessKeyId: FAKE_ACCESS,
      secretAccessKey: FAKE_SECRET,
      region,
      date,
    });
    if (expected.signature !== given)
      return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 });
    if (headers["x-amz-content-sha256"] !== sha256Hex(body))
      return new Response("<Error><Code>XAmzContentSHA256Mismatch</Code></Error>", { status: 400 });

    const prefix = `/${this.bucket}`;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));

    if (request.method === "GET" && url.pathname === prefix) return this.#list(url);
    if (request.method === "PUT") {
      if (headers["if-none-match"] === "*" && this.objects.has(key))
        return new Response(
          "<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>",
          { status: 412 },
        );
      const meta: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers))
        if (name.startsWith("x-amz-meta-")) meta[name] = value;
      this.objects.set(key, { body, meta });
      return new Response(null, { status: 200, headers: { etag: this.#etag(body) } });
    }
    const found = this.objects.get(key);
    if (request.method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!found) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const reply = {
      etag: this.#etag(found.body),
      "content-length": String(found.body.byteLength),
      ...found.meta,
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: reply });
    return new Response(found.body as BodyInit, { status: 200, headers: reply });
  }

  #etag(body: Uint8Array): string {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  }

  #list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const after = url.searchParams.get("start-after") ?? "";
    const max = Number(url.searchParams.get("max-keys") ?? "1000");
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && key > after)
      .sort();
    const page = keys.slice(0, max);
    const contents = page
      .map((key) => {
        const stored = this.objects.get(key) as Stored;
        return `<Contents><Key>${xml(key)}</Key><Size>${stored.body.byteLength}</Size><ETag>${xml(this.#etag(stored.body))}</ETag></Contents>`;
      })
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.bucket}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${keys.length > max}</IsTruncated>${contents}</ListBucketResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    );
  }
}

import { Miniflare } from "miniflare";
import { randomUUID } from "node:crypto";

export interface TestR2Bucket {
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      onlyIf: { etagMatches?: string; etagDoesNotMatch?: string };
      sha256?: string;
    },
  ): Promise<{ key: string; size: number; etag: string } | null>;
  get(key: string): Promise<{
    key: string;
    size: number;
    etag: string;
    body: ReadableStream<Uint8Array>;
    text(): Promise<string>;
  } | null>;
  delete(key: string): Promise<void>;
}
/** Real R2 operations execute inside workerd. Use HTTP rather than the host-side
 * synchronous RPC proxy: its message-port assertion is unreliable under Bun.
 * No test/assertion retry is performed here; failures reach the release gate. */
export async function withBucket(run: (bucket: TestR2Bucket) => Promise<void>) {
  const capability = randomUUID();
  const runtime = new Miniflare({
    modules: true,
    script: `export default { async fetch(request, env) {
      if (request.headers.get("x-fixture-capability") !== env.CAPABILITY)
        return new Response(null, { status: 403 });
      const key = new URL(request.url).searchParams.get("key");
      if (key === null) return new Response(null, { status: 400 });
      if (request.method === "PUT") {
        const match = request.headers.get("x-etag-match");
        const absent = request.headers.get("x-etag-absent");
        const checksum = request.headers.get("x-sha256");
        const object = await env.ARCHIVE.put(key, await request.arrayBuffer(), {
          ...(match === null && absent === null ? {} : { onlyIf: {
            ...(match === null ? {} : { etagMatches: match }),
            ...(absent === null ? {} : { etagDoesNotMatch: absent }),
          }}),
          ...(checksum === null ? {} : { sha256: checksum }),
        });
        return Response.json(object === null ? null :
          { key: object.key, size: object.size, etag: object.etag });
      }
      if (request.method === "DELETE") {
        await env.ARCHIVE.delete(key);
        return new Response(null, { status: 204 });
      }
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const object = await env.ARCHIVE.get(key);
      if (object === null) return new Response(null, { status: 404 });
      return new Response(object.body, { headers: { "x-fixture-metadata":
        encodeURIComponent(JSON.stringify({ key: object.key, size: object.size, etag: object.etag })) } });
    }};`,
    compatibilityDate: "2026-07-30",
    r2Buckets: ["ARCHIVE"],
    bindings: { CAPABILITY: capability },
    cf: false,
  });
  const call = async (
    key: string,
    init: { method?: string; body?: string | Uint8Array; headers?: Headers } = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set("x-fixture-capability", capability);
    const response = await runtime.dispatchFetch(
      `http://fixture.test/?key=${encodeURIComponent(key)}`,
      {
        ...init,
        headers,
      },
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`R2 fixture HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
  try {
    await run({
      async put(key, value, options) {
        const headers = new Headers();
        if (options?.onlyIf.etagMatches !== undefined)
          headers.set("x-etag-match", options.onlyIf.etagMatches);
        if (options?.onlyIf.etagDoesNotMatch !== undefined)
          headers.set("x-etag-absent", options.onlyIf.etagDoesNotMatch);
        if (options?.sha256 !== undefined) headers.set("x-sha256", options.sha256);
        return (await call(key, { method: "PUT", body: value, headers })).json() as Promise<{
          key: string;
          size: number;
          etag: string;
        } | null>;
      },
      async delete(key) {
        await call(key, { method: "DELETE" });
      },
      async get(key) {
        const response = await call(key);
        if (response.status === 404) return null;
        const metadata = response.headers.get("x-fixture-metadata");
        if (metadata === null) throw new Error("Missing R2 metadata");
        const object = JSON.parse(decodeURIComponent(metadata)) as {
          key: string;
          size: number;
          etag: string;
        };
        const buffer = await response.arrayBuffer();
        const body = new Response(buffer).body;
        if (body === null) throw new Error("Missing host bridge stream");
        return {
          ...object,
          body,
          async text() {
            return new TextDecoder().decode(buffer);
          },
        };
      },
    });
  } finally {
    await runtime.dispose();
  }
}

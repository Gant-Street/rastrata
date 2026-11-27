/** The browser beacon's endpoint: how pages report what they felt (the web vitals) and how long a key
 * action took from the click to the screen showing it. It exists only when telemetry is on AND
 * RASTRATA_RUM is set: otherwise this route is not registered and a request to it is any other
 * unknown address, whose body is never read.
 *
 * What the endpoint guarantees (test/rum.test.ts holds it to each):
 *  - it takes a request only with credentials (the owner key or an agent token that may read), and
 *    no credential means no parsing at all;
 *  - one credential may send only so many a minute;
 *  - it refuses a body over 2 KiB from its Content-Length, without reading it;
 *  - it accepts only the fixed message shape of @rastrata/telemetry/web, closed sets and bounded
 *    numbers, and refuses anything else whole, with a reason that does not repeat it;
 *  - it records only the catalog's metrics, under the size bucket of the book (which it knows), and
 *    keeps no address, no page, no user agent and no identifier of any kind. */
import { counter, type SizeBucket } from "@rastrata/telemetry";
import { RateLimiter, recordBeacon } from "@rastrata/telemetry/beacon";
import { BEACON_MAX_BYTES, parseBeacon } from "@rastrata/telemetry/web";
import type { ApplicationHttp } from "@rastrata/application/http";

export interface BeaconOptions {
  readonly application: Pick<ApplicationHttp, "credentialed">;
  /** The size bucket of the book the beacon is about, as the service last saw it. */
  readonly size: () => SizeBucket;
  /** A token bucket per credential; 20 at once, then one every two seconds. */
  readonly limiter?: RateLimiter;
}

const refuse = (status: number, code: string, headers: Record<string, string> = {}) => {
  counter("web.beacons").add(1, { web_beacon: "rejected" });
  return Response.json(
    { error: "The report was not accepted", code },
    {
      status,
      headers: { "cache-control": "no-store", ...headers },
    },
  );
};

/** Read at most `limit` bytes of a body; undefined when there is more. */
async function readCapped(request: Request, limit: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) return undefined;
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

export function beaconHandler(options: BeaconOptions): (request: Request) => Promise<Response> {
  const limiter = options.limiter ?? new RateLimiter(20, 0.5);
  return async (request) => {
    if (request.method !== "POST") return refuse(405, "method_not_allowed", { allow: "POST" });
    // Cheap refusals first, from headers alone: nothing of the body is read for any of them.
    const declared = request.headers.get("content-length");
    if (!declared || !/^[0-9]+$/.test(declared) || Number(declared) > BEACON_MAX_BYTES)
      return refuse(413, "payload_too_large");
    if (
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
    )
      return refuse(415, "media_type_unsupported");
    const who = await options.application.credentialed(request);
    if (who instanceof Response) {
      counter("web.beacons").add(1, { web_beacon: "rejected" });
      return who;
    }
    if (!limiter.take(who.key))
      return refuse(429, "rate_limited", {
        "retry-after": String(Math.max(1, limiter.retryAfterSeconds(who.key))),
      });
    const text = await readCapped(request, BEACON_MAX_BYTES);
    if (text === undefined) return refuse(413, "payload_too_large");
    const parsed = parseBeacon(text);
    if (!parsed.ok) return refuse(400, "invalid_report");
    // A book whose size is not known yet cannot be put in a bucket: the report is dropped, and the
    // browser is told it was received, because sending it again would not help.
    const taken = recordBeacon(parsed.beacon, options.size());
    counter("web.beacons").add(1, { web_beacon: taken ? "accepted" : "rejected" });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  };
}

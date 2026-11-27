/** A collector for tests: an OTLP/HTTP receiver on a free local port that keeps what it is sent, decodes
 * the JSON, and can be told to misbehave. */
import { gunzipSync } from "node:zlib";

// biome-ignore lint/suspicious/noExplicitAny: decoded OTLP JSON, walked by the test helpers below
export type Json = Record<string, any>;
export type CollectorMode =
  | { kind: "ok" }
  | { kind: "status"; status: number; retryAfter?: string }
  | { kind: "hang" }
  | { kind: "slow"; ms: number };

export interface Received {
  readonly path: string;
  readonly body: Json;
  readonly encoding: string | null;
  readonly headers: Headers;
  readonly bytes: number;
}

export interface DecodedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly kind: number;
  readonly attributes: Record<string, string | number | boolean>;
  readonly statusCode: number;
  readonly events: { name: string; attributes: Record<string, string | number | boolean> }[];
}

export interface DecodedPoint {
  readonly name: string;
  readonly type: "sum" | "gauge" | "histogram";
  readonly unit: string;
  readonly attributes: Record<string, string>;
  /** Counters and gauges. */
  readonly value?: number;
  /** Histograms. */
  readonly count?: number;
  readonly sum?: number;
  readonly bounds?: number[];
  readonly buckets?: number[];
  readonly monotonic?: boolean;
}

const value = (any: Json): string | number | boolean => {
  if ("stringValue" in any) return any.stringValue;
  if ("intValue" in any) return Number(any.intValue);
  if ("doubleValue" in any) return any.doubleValue;
  if ("boolValue" in any) return any.boolValue;
  return JSON.stringify(any);
};
const attributes = (list: Json[] | undefined) =>
  Object.fromEntries((list ?? []).map((item) => [item.key as string, value(item.value)]));

export interface Collector {
  readonly url: string;
  mode: CollectorMode;
  readonly received: Received[];
  /** Requests that reached the server, whatever it answered. */
  hits(): number;
  spans(): DecodedSpan[];
  resources(): Record<string, string | number | boolean>[];
  /** The newest value of each series: the metrics are cumulative. */
  latestPoints(): DecodedPoint[];
  stop(): Promise<void>;
}

export async function startCollector(mode: CollectorMode = { kind: "ok" }): Promise<Collector> {
  const received: Received[] = [];
  let hits = 0;
  const pending = new Set<() => void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      hits += 1;
      const current = collector.mode;
      const raw = new Uint8Array(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding");
      const text = new TextDecoder().decode(encoding === "gzip" ? gunzipSync(raw) : raw);
      let body: Json = {};
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: kept as an empty body so a test can see the request arrived.
      }
      if (current.kind === "hang")
        return new Promise<Response>((resolve) => pending.add(() => resolve(new Response("late"))));
      if (current.kind === "slow") await Bun.sleep(current.ms);
      if (current.kind === "status")
        return new Response("no", {
          status: current.status,
          headers: current.retryAfter ? { "retry-after": current.retryAfter } : {},
        });
      received.push({
        path: new URL(request.url).pathname,
        body,
        encoding,
        headers: request.headers,
        bytes: raw.byteLength,
      });
      return Response.json({ partialSuccess: {} });
    },
  });
  const collector: Collector = {
    url: `http://127.0.0.1:${server.port}`,
    mode,
    received,
    hits: () => hits,
    spans() {
      return received
        .filter((item) => item.path === "/v1/traces")
        .flatMap((item) => item.body.resourceSpans ?? [])
        .flatMap((resource: Json) => resource.scopeSpans ?? [])
        .flatMap((scope: Json) => scope.spans ?? [])
        .map(
          (span: Json): DecodedSpan => ({
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId || undefined,
            kind: span.kind,
            attributes: attributes(span.attributes) as DecodedSpan["attributes"],
            statusCode: span.status?.code ?? 0,
            events: (span.events ?? []).map((event: Json) => ({
              name: event.name,
              attributes: attributes(event.attributes) as DecodedSpan["attributes"],
            })),
          }),
        );
    },
    resources() {
      return received.flatMap((item) =>
        [...(item.body.resourceSpans ?? []), ...(item.body.resourceMetrics ?? [])].map(
          (resource: Json) => attributes(resource.resource?.attributes),
        ),
      );
    },
    latestPoints() {
      const latest = new Map<string, DecodedPoint>();
      for (const item of received.filter((entry) => entry.path === "/v1/metrics"))
        for (const resource of item.body.resourceMetrics ?? [])
          for (const scope of resource.scopeMetrics ?? [])
            for (const metric of scope.metrics ?? []) {
              const kind = metric.sum ? "sum" : metric.gauge ? "gauge" : "histogram";
              for (const point of metric[kind].dataPoints ?? []) {
                const labels = attributes(point.attributes) as Record<string, string>;
                const decoded: DecodedPoint = {
                  name: metric.name,
                  type: kind,
                  unit: metric.unit,
                  attributes: labels,
                  ...(kind === "histogram"
                    ? {
                        count: Number(point.count),
                        sum: point.sum,
                        bounds: point.explicitBounds,
                        buckets: (point.bucketCounts ?? []).map(Number),
                      }
                    : { value: Number(point.asInt ?? point.asDouble) }),
                  ...(kind === "sum" ? { monotonic: metric.sum.isMonotonic } : {}),
                };
                latest.set(`${metric.name}|${JSON.stringify(labels)}`, decoded);
              }
            }
      return [...latest.values()];
    },
    async stop() {
      for (const release of pending) release();
      await server.stop(true);
    },
  };
  return collector;
}

/** A port nothing listens on: bind one, note it, close it. */
export async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const { port } = server;
  await server.stop(true);
  return port as number;
}

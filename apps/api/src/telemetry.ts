/** The API server's telemetry: one span per HTTP request (continuing the caller's trace when it sent a
 * `traceparent`), the legacy browser routes counted as a class of their own, and what `/health` says
 * about telemetry. Off unless `@rastrata/telemetry` has a backend; then each function here is the
 * thing it wraps. */
import {
  counter,
  histogram,
  outcomeOfStatus,
  span,
  stopwatch,
  telemetryEnabled,
  telemetryStatus,
  withTraceparent,
} from "@rastrata/telemetry";
import { BEACON_PATH } from "@rastrata/telemetry/web";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** The route a path belongs to, low in cardinality: the span carries this, never the path, which can
 * be anything a client typed. */
export function routeOf(pathname: string): string {
  if (pathname === "/v1/uploads") return "/v1/uploads";
  if (pathname.startsWith("/v1/")) return "/v1/:operation";
  if (pathname.startsWith("/api/")) return "/api/*";
  if (pathname === "/health") return "/health";
  if (pathname === BEACON_PATH) return BEACON_PATH;
  return "static";
}

/** Wrap one HTTP request in an `http.request` span. An incoming W3C `traceparent` makes it part of
 * the caller's trace; a malformed one starts a new trace. The browser compatibility routes under
 * /api (which the application's own dispatch does not see) are counted and timed here as the
 * `legacy` class. With telemetry off this is `run()`. */
export function observeHttp(request: Request, run: () => Promise<Response>): Promise<Response> {
  if (!telemetryEnabled()) return run();
  let pathname = "/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // A request whose address cannot be read is answered by `run`, and is "static" here.
  }
  const route = routeOf(pathname);
  const method = METHODS.has(request.method) ? request.method : "OTHER";
  const elapsed = stopwatch();
  return withTraceparent(request.headers.get("traceparent"), () =>
    span("http.request", { "http.request.method": method, "http.route": route }, async (s) => {
      const response = await run();
      s.setAttribute("http.response.status_code", response.status);
      if (route === "/api/*") {
        const mapped = outcomeOfStatus(response.status);
        counter("requests").add(1, {
          operation_class: "legacy",
          outcome: mapped === "timeout" ? "client_error" : mapped,
        });
        histogram("request.duration").record(elapsed(), { operation_class: "legacy" });
      }
      return response;
    }),
  );
}

/** Whether a request is a browser asking for a page (a navigation), not for an asset or the API. */
export function asksForDocument(request: Request): boolean {
  if (request.method !== "GET") return false;
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null) return destination === "document";
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

/** What `/health` says about telemetry: nothing when it is off, and when it is on whether it is
 * getting through, so that a silent outage of the monitoring can be seen by anything that reads
 * /health. Counts only: no endpoint, no header, no value. */
export function healthTelemetry(): Record<string, unknown> {
  if (!telemetryEnabled()) return {};
  const status = telemetryStatus();
  return {
    telemetry: {
      enabled: true,
      exported: { traces: status.exports.traces.ok, metrics: status.exports.metrics.ok },
      failed: { traces: status.exports.traces.failed, metrics: status.exports.metrics.failed },
      dropped: status.dropped,
      queued: status.queued,
      backingOff: status.consecutiveFailures.traces > 0 || status.consecutiveFailures.metrics > 0,
      lastSuccessAt: status.lastSuccessAt,
    },
  };
}

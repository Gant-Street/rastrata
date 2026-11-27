/** Reading the environment into a telemetry configuration. Pure: no SDK, no I/O, so it can be tested
 * and so the local product, which never sets these, loads nothing more than this file.
 *
 * Telemetry is OFF unless an endpoint is given, in `RASTRATA_OTEL_ENDPOINT` or the standard
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (the base URL of an OTLP/HTTP collector, such as
 * http://collector:4318). `OTEL_SDK_DISABLED=true` turns it off whatever else is set.
 *
 *   RASTRATA_OTEL_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT   base URL; /v1/traces and /v1/metrics are added
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / _METRICS_ENDPOINT full URLs, used as given
 *   RASTRATA_OTEL_HEADERS / OTEL_EXPORTER_OTLP_HEADERS     "name=value,name=value" (an authorization header)
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES            who is sending
 *   RASTRATA_INSTANCE_ID (else HOSTNAME)                   which process: the pod name
 *   RASTRATA_ENV, RASTRATA_VERSION                         deployment.environment.name, service.version
 *   RASTRATA_OTEL_SAMPLE_RATE   share of ordinary traces kept, 0 to 1 (default 0.05)
 *   RASTRATA_OTEL_SLOW_MS       a request this slow is always kept (default 1000)
 *   RASTRATA_OTEL_METRICS_INTERVAL_MS   default 60000
 *   RASTRATA_OTEL_FLUSH_MS      the most a flush at shutdown may take (default 2000)
 *   RASTRATA_OTEL_COMPRESSION   gzip (default) or none
 *   RASTRATA_OTEL_TIMEOUT_MS    the longest one attempt to send may take (default 5000)
 *   RASTRATA_OTEL_ERROR_MESSAGES=1   record an error's message too (default: only its type and code)
 *   RASTRATA_OTEL_FILE          also append every metrics export to this file, as OTLP/JSON lines: the
 *                               dump the cost report reads
 *
 * A header value is a credential and is never written anywhere by this package. */

export type Environment = Readonly<Record<string, string | undefined>>;

export interface TelemetryConfig {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly resourceAttributes: Readonly<Record<string, string>>;
  /** The share of ordinary traces kept, 0 to 1. Errors and slow requests are always kept. */
  readonly sampleRate: number;
  readonly slowMs: number;
  readonly metricsIntervalMs: number;
  readonly flushMs: number;
  readonly compression: "gzip" | "none";
  /** The longest one attempt to send a batch may take. */
  readonly timeoutMs: number;
  readonly errorMessages: boolean;
  readonly dumpFile: string | undefined;
  /** How often the process gauges (memory, idle time) are read. */
  readonly runtimeSampleMs: number;
}

export type ConfigResult =
  | { readonly on: false; readonly reason: "no-endpoint" | "disabled" | "invalid" }
  | { readonly on: true; readonly config: TelemetryConfig };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function number(text: string | undefined, fallback: number, low: number, high: number): number {
  if (text === undefined || text.trim() === "") return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? clamp(parsed, low, high) : fallback;
}

/** `name=value,name=value` as the OpenTelemetry environment variables write it. Values may be
 * percent-encoded. A pair that is malformed is skipped. */
export function parsePairs(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    let value = pair.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not percent-encoded after all: keep it as written.
    }
    if (name && value) out[name] = value;
  }
  return out;
}

/** An http or https URL with no credentials in it (those belong in a header), or undefined. */
export function cleanUrl(text: string | undefined): URL | undefined {
  if (!text?.trim()) return undefined;
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export function readTelemetryConfig(
  env: Environment,
  defaults: { readonly serviceName?: string } = {},
): ConfigResult {
  if (/^(true|1)$/i.test(env.OTEL_SDK_DISABLED ?? "")) return { on: false, reason: "disabled" };
  const base = env.RASTRATA_OTEL_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return { on: false, reason: "no-endpoint" };
  const root = cleanUrl(base);
  if (!root) return { on: false, reason: "invalid" };
  const signal = (specific: string | undefined, path: string): string | undefined => {
    if (specific?.trim()) return cleanUrl(specific)?.href;
    return cleanUrl(`${root.href.replace(/\/+$/, "")}/${path}`)?.href;
  };
  const tracesUrl = signal(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "v1/traces");
  const metricsUrl = signal(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, "v1/metrics");
  if (!tracesUrl || !metricsUrl) return { on: false, reason: "invalid" };

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    parsePairs(env.RASTRATA_OTEL_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
  ))
    if (HEADER_NAME.test(name) && !/[\r\n]/.test(value)) headers[name] = value;

  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaults.serviceName || "rastrata";
  const resourceAttributes: Record<string, string> = {
    ...parsePairs(env.OTEL_RESOURCE_ATTRIBUTES),
    "service.name": serviceName,
  };
  const instance = env.RASTRATA_INSTANCE_ID?.trim() || env.HOSTNAME?.trim();
  if (instance) resourceAttributes["service.instance.id"] = instance;
  if (env.RASTRATA_VERSION?.trim())
    resourceAttributes["service.version"] = env.RASTRATA_VERSION.trim();
  if (env.RASTRATA_ENV?.trim())
    resourceAttributes["deployment.environment.name"] = env.RASTRATA_ENV.trim();

  const interval = number(
    env.RASTRATA_OTEL_METRICS_INTERVAL_MS ?? env.OTEL_METRIC_EXPORT_INTERVAL,
    60_000,
    1_000,
    3_600_000,
  );
  return {
    on: true,
    config: {
      tracesUrl,
      metricsUrl,
      headers,
      serviceName,
      resourceAttributes,
      sampleRate: number(env.RASTRATA_OTEL_SAMPLE_RATE, 0.05, 0, 1),
      slowMs: number(env.RASTRATA_OTEL_SLOW_MS, 1_000, 0, 3_600_000),
      metricsIntervalMs: interval,
      flushMs: number(env.RASTRATA_OTEL_FLUSH_MS, 2_000, 0, 30_000),
      compression: env.RASTRATA_OTEL_COMPRESSION?.toLowerCase() === "none" ? "none" : "gzip",
      timeoutMs: number(env.RASTRATA_OTEL_TIMEOUT_MS, 5_000, 100, 60_000),
      errorMessages: /^(1|true|yes|on)$/i.test(env.RASTRATA_OTEL_ERROR_MESSAGES ?? ""),
      dumpFile: env.RASTRATA_OTEL_FILE?.trim() || undefined,
      runtimeSampleMs: clamp(Math.min(interval / 2, 10_000), 1_000, 10_000),
    },
  };
}

/** What may be said about a configuration in a log line: where it goes, never the credentials. */
export function describeConfig(config: TelemetryConfig): string {
  const host = (url: string) => new URL(url).host;
  return `telemetry on: traces to ${host(config.tracesUrl)}, metrics to ${host(config.metricsUrl)} every ${config.metricsIntervalMs / 1000} s, ${Math.round(config.sampleRate * 100)}% of ordinary traces kept, errors and requests over ${config.slowMs} ms always`;
}

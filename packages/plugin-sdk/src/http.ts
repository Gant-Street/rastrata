import { PluginError } from "./errors.ts";
import { redact } from "./redact.ts";
import type { GuardedHttp, JsonResponse } from "./types.ts";

/** Domain-restricted, secret-scrubbing HTTP client injected into every plugin's `pull()`.
 *
 * Defense-in-depth guarantees:
 * 1. Only exact hostnames listed in `manifest.domains` may be requested.
 * 2. HTTPS is required everywhere except explicit loopback test mode (`allowLoopback: true`).
 * 3. Private / link-local / loopback IP literals are refused (SSRF protection).
 * 4. Redirects are handled manually and refused if `Location` leaves `manifest.domains` or HTTPS.
 * 5. Responses above 16 MiB are aborted; secrets are scrubbed from every error. */

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 10_000;
const MAX_REDIRECTS = 3;

const PRIVATE_IP_PATTERNS: readonly RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

export interface GuardedHttpOptions {
  readonly domains: readonly string[];
  readonly secrets?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Total attempts for retryable failures (HTTP 429, 5xx, network errors). Defaults to 4. */
  readonly maxAttempts?: number;
  /** Optional sleep hook for retry backoff (injectable for instant unit tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional RNG in [0, 1) for retry jitter (injectable for deterministic tests). */
  readonly random?: () => number;
  /** Test-only flag permitting http://127.0.0.1 and http://localhost mock servers. Never enabled in production. */
  readonly allowLoopback?: boolean;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function assertAllowedUrl(
  rawUrl: string,
  allowedDomains: ReadonlySet<string>,
  allowLoopback: boolean,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PluginError({
      code: "egress_blocked",
      message: `Invalid request URL "${rawUrl}".`,
      hint: "Pass a full HTTPS URL such as https://api.stripe.com/v1/payouts.",
    });
  }

  const host = parsed.hostname.toLowerCase();
  const loopbackOk = allowLoopback && isLoopbackHost(host);

  if (!loopbackOk) {
    if (parsed.protocol !== "https:") {
      throw new PluginError({
        code: "egress_blocked",
        message: `Blocked non-HTTPS request to "${parsed.origin}".`,
        hint: "Plugins may only make HTTPS requests in production.",
      });
    }
    if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(host))) {
      throw new PluginError({
        code: "egress_blocked",
        message: `Blocked request to private or local address "${host}".`,
        hint: "Plugins cannot access loopback, link-local, or private network addresses.",
      });
    }
    if (!allowedDomains.has(host)) {
      const list = [...allowedDomains].join(", ") || "(none)";
      throw new PluginError({
        code: "egress_blocked",
        message: `Blocked outbound request to "${host}".`,
        hint: `Add the exact HTTPS hostname to manifest.domains (currently allowed: [${list}]).`,
      });
    }
  }

  return parsed;
}

function summarizeErrorBody(text: string, secrets: readonly string[]): string {
  let detail = text;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        detail = parsed.error.trim();
      } else if (
        parsed.error &&
        typeof parsed.error === "object" &&
        typeof parsed.error.message === "string" &&
        parsed.error.message.trim()
      ) {
        detail = parsed.error.message.trim();
      } else if (typeof parsed.message === "string" && parsed.message.trim()) {
        detail = parsed.message.trim();
      }
    }
  } catch {
    // Plain-text body; keep verbatim trimmed snippet.
  }
  return redact(detail.replace(/\s+/g, " ").trim().slice(0, 240), secrets);
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new PluginError({
        code: "payload_too_large",
        message: `Response from ${url} is ${size} bytes (max ${maxBytes}).`,
        hint: "Use smaller page sizes (e.g. limit=100) so each batch fits within the 16 MiB archive cap.",
      });
    }
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new PluginError({
      code: "payload_too_large",
      message: `Response from ${url} is ${buffer.byteLength} bytes (max ${maxBytes}).`,
      hint: "Use smaller page sizes so each batch fits within the 16 MiB archive cap.",
    });
  }
  return new Uint8Array(buffer);
}

export function createGuardedHttp(options: GuardedHttpOptions): GuardedHttp {
  const allowedDomains = new Set(options.domains.map((d) => d.toLowerCase()));
  const secrets = options.secrets ?? [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.min(8, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const allowLoopback = options.allowLoopback === true;

  function backoffMs(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds !== undefined) {
      return Math.min(MAX_BACKOFF_MS, Math.max(0, retryAfterSeconds * 1000));
    }
    const exponential = Math.min(8_000, 250 * 2 ** (attempt - 1));
    return Math.round(exponential / 2 + (random() * exponential) / 2);
  }

  async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
    let currentUrl = assertAllowedUrl(url, allowedDomains, allowLoopback).toString();
    let redirects = 0;

    while (true) {
      const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(currentUrl, {
          ...init,
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (error instanceof PluginError) throw error;
        const message = redact(error instanceof Error ? error.message : String(error), secrets);
        throw new PluginError({
          code: "provider_error",
          message: `Request to ${new URL(currentUrl).hostname} failed: ${message}`,
          hint: "Check network connectivity and retry; credentials have been scrubbed from this error.",
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return response;
        if (redirects >= MAX_REDIRECTS) {
          throw new PluginError({
            code: "egress_blocked",
            message: `Too many redirects (${MAX_REDIRECTS}) while fetching ${new URL(currentUrl).hostname}.`,
            hint: "Request the canonical API endpoint URL directly.",
          });
        }
        const resolved = new URL(location, currentUrl).toString();
        currentUrl = assertAllowedUrl(resolved, allowedDomains, allowLoopback).toString();
        redirects += 1;
        continue;
      }

      return response;
    }
  }

  async function getJson<T = unknown>(
    url: string,
    init?: RequestInit & { readonly name?: string },
  ): Promise<JsonResponse<T>> {
    const requestInit: RequestInit = {
      ...init,
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    };
    const canRetryMethod = (requestInit.method ?? "GET").toUpperCase() === "GET";
    const attempts = canRetryMethod ? maxAttempts : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await guardedFetch(url, requestInit);
      } catch (error) {
        if (error instanceof PluginError && error.code === "provider_error" && attempt < attempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      const bytes = await readBoundedBytes(response, maxBytes, new URL(url).hostname);
      const text = new TextDecoder().decode(bytes);

      if (response.status === 401 || response.status === 403) {
        throw new PluginError({
          code: "auth_error",
          message: `Provider rejected credentials (${response.status}): ${summarizeErrorBody(text, secrets)}`,
          hint: "Check that your API key or OAuth token is active and holds the required read-only permissions.",
        });
      }
      if (response.status === 429) {
        const retryHeader = response.headers.get("retry-after");
        const retryAfterSeconds =
          retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
        if (attempt < attempts) {
          await sleep(backoffMs(attempt, retryAfterSeconds));
          continue;
        }
        throw new PluginError({
          code: "rate_limited",
          message: `Provider rate limited the request (429).`,
          hint: retryAfterSeconds
            ? `Retry after ${retryAfterSeconds} seconds.`
            : "Wait briefly and re-run sync; previously applied batches will not be duplicated.",
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
      }
      if (response.status >= 500) {
        if (attempt < attempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new PluginError({
          code: "provider_error",
          message: `Provider returned HTTP ${response.status}: ${summarizeErrorBody(text, secrets)}`,
          hint: "Upstream service is temporarily unavailable. Re-run sync; previously applied batches will not be duplicated.",
        });
      }
      if (!response.ok) {
        throw new PluginError({
          code: "provider_error",
          message: `Provider returned HTTP ${response.status}: ${summarizeErrorBody(text, secrets)}`,
          hint: "Inspect the provider response and retry once the upstream error clears.",
        });
      }

      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new PluginError({
          code: "provider_error",
          message: `Expected JSON from ${new URL(url).hostname}, received invalid JSON.`,
          hint: "Verify the endpoint URL and API version header.",
        });
      }

      const mediaType =
        response.headers.get("content-type")?.split(";")[0]?.trim() || "application/json";
      return {
        status: response.status,
        headers: response.headers,
        data,
        raw: {
          bytes,
          mediaType,
          ...(init?.name !== undefined ? { name: init.name } : {}),
        },
      };
    }

    throw new PluginError({
      code: "provider_error",
      message: `Request to ${new URL(url).hostname} failed after ${attempts} attempts.`,
      hint: "Retry sync; previously applied batches will not be duplicated.",
    });
  }

  return { fetch: guardedFetch, getJson };
}

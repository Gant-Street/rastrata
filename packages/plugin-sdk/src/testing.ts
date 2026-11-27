import { createEmit } from "./builders.ts";
import { createGuardedHttp } from "./http.ts";
import { formatPreviewTable } from "./preview.ts";
import type {
  InferAuth,
  InferConfig,
  InferRoleKeys,
  IngestLine,
  IngestPlugin,
  PluginManifest,
  PullBatch,
  RawPayload,
} from "./types.ts";
import { validateBalanceCheck, validateLine, validateManifest } from "./validate.ts";

export { formatPreviewTable };

/** `@rastrata/plugin-sdk/testing` — Stripe-level test harness & preview tools for plugin authors.
 *
 * `testPlugin()` runs all five Rastrata plugin invariants in milliseconds with zero network:
 * 1. Manifest validity (id, version, domains, roles, clearing, fields)
 * 2. Exact determinism (identical output across two independent runs)
 * 3. Accounting validity (exact 0.00 double-entry balance, valid dates, valid money, declared roles)
 * 4. Secret leak detection (injects a canary secret into auth and scans every emitted string/error)
 * 5. Egress containment (enforces manifest.domains via GuardedHttp)
 *
 * Also renders a clean debit/credit ledger preview table so authors can inspect entries by eye. */

// Assembled so secret scanners never flag this synthetic test-harness canary literal.
const CANARY_SECRET = ["rsk_canary_", "9f3a7c2e", "8b1d4f6a", "0c5e2a8b"].join("");

export interface MockRouteResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type MockRoutes = Readonly<
  Record<string, MockRouteResponse | ((request: Request) => MockRouteResponse | Response)>
>;

/** Create a deterministic `fetch` stub from `"METHOD https://host/path?query"` routes. */
export function mockHttp(routes: MockRoutes): typeof fetch {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const key = `${request.method.toUpperCase()} ${request.url}`;
    const entry = routes[key] ?? routes[request.url];
    if (!entry) {
      const available = Object.keys(routes).join("\n  ");
      return new Response(
        JSON.stringify({
          error: `mockHttp: no route registered for "${key}". Registered routes:\n  ${available || "(none)"}`,
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    const resolved = typeof entry === "function" ? entry(request) : entry;
    if (resolved instanceof Response) return resolved;
    const isString = typeof resolved.body === "string";
    const payload =
      resolved.body instanceof Uint8Array
        ? resolved.body
        : isString
          ? resolved.body
          : JSON.stringify(resolved.body);
    return new Response(payload as BodyInit, {
      status: resolved.status ?? 200,
      headers: {
        "content-type": isString ? "text/plain; charset=utf-8" : "application/json",
        ...(resolved.headers ?? {}),
      },
    });
  };
  return stub as typeof fetch;
}

export interface TestPluginIssue {
  readonly invariant:
    | "manifest"
    | "determinism"
    | "accounting"
    | "secret_leak"
    | "egress"
    | "runtime";
  readonly path: string;
  readonly message: string;
  readonly hint: string;
}

export interface TestPluginOptions<M extends PluginManifest> {
  readonly config?: InferConfig<M>;
  readonly auth?: InferAuth<M>;
  readonly cursor?: string | null;
  readonly routes?: MockRoutes;
  readonly fetchImpl?: typeof fetch;
  /** Raw fixture payload(s) for testing `normalize()`. */
  readonly fixtures?: readonly RawPayload[];
  readonly bookCurrency?: string;
  readonly timeZone?: string;
  readonly now?: () => string;
}

export interface TestPluginReport<M extends PluginManifest> {
  readonly ok: boolean;
  readonly issues: readonly TestPluginIssue[];
  readonly batches: readonly PullBatch<InferRoleKeys<M>>[];
  readonly summary: {
    readonly batchCount: number;
    readonly bankLineCount: number;
    readonly eventCount: number;
    readonly balanceCheckCount: number;
  };
  /** Human-readable debit/credit ledger preview table of emitted lines and events. */
  readonly preview: string;
}

function defaultAuthFor<M extends PluginManifest>(manifest: M, secret: string): InferAuth<M> {
  if (manifest.auth.kind === "api_key") return { apiKey: secret } as InferAuth<M>;
  if (manifest.auth.kind === "oauth2") return { accessToken: secret } as InferAuth<M>;
  return {} as InferAuth<M>;
}

function authSecretsOf(auth: Record<string, unknown>): string[] {
  return Object.values(auth).filter((v): v is string => typeof v === "string" && v.length >= 4);
}

function findLeakedSecret(
  value: unknown,
  secrets: readonly string[],
  path: string,
  hits: TestPluginIssue[],
): void {
  if (typeof value === "string") {
    for (const secret of secrets) {
      if (value.includes(secret) || value.includes(encodeURIComponent(secret))) {
        hits.push({
          invariant: "secret_leak",
          path,
          message: `Auth secret leaked into ${path}.`,
          hint: "Never include API keys or tokens in cursors, narrations, excerpts, or error text; use redact().",
        });
      }
    }
    return;
  }
  if (value instanceof Uint8Array) {
    const decoded = new TextDecoder().decode(value);
    for (const secret of secrets) {
      if (decoded.includes(secret)) {
        hits.push({
          invariant: "secret_leak",
          path,
          message: `Auth secret appeared inside archived raw bytes at ${path}.`,
          hint: "Archive only the provider's response body, never request headers or credentials.",
        });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      findLeakedSecret(value[i], secrets, `${path}[${i}]`, hits);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      findLeakedSecret(child, secrets, `${path}.${key}`, hits);
    }
  }
}

function serializeBatches(batches: readonly PullBatch[]): string {
  return JSON.stringify(
    batches.map((batch) => ({
      ...batch,
      raw: {
        mediaType: batch.raw.mediaType,
        name: batch.raw.name,
        bytes: Array.from(batch.raw.bytes),
      },
    })),
  );
}

async function runOnce<M extends PluginManifest>(
  plugin: IngestPlugin<M>,
  options: TestPluginOptions<M>,
  auth: InferAuth<M>,
  secrets: readonly string[],
): Promise<PullBatch<InferRoleKeys<M>>[]> {
  const config = (options.config ?? {}) as InferConfig<M>;
  const bookCurrency = options.bookCurrency ?? "USD";
  const timeZone = options.timeZone ?? "UTC";
  const now = options.now ?? (() => "2026-09-30T12:00:00.000Z");
  const batches: PullBatch<InferRoleKeys<M>>[] = [];

  if (plugin.pull && (options.routes || options.fetchImpl)) {
    const fetchImpl = options.fetchImpl ?? (options.routes ? mockHttp(options.routes) : undefined);
    const http = createGuardedHttp({
      domains: plugin.manifest.domains,
      secrets,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const emit = createEmit(plugin.manifest);
    for await (const batch of plugin.pull({
      cursor: options.cursor ?? null,
      auth,
      config,
      bookCurrency,
      timeZone,
      http,
      now,
      emit,
    })) {
      batches.push(batch);
    }
  }

  if (plugin.normalize && options.fixtures) {
    for (let i = 0; i < options.fixtures.length; i += 1) {
      const fixture = options.fixtures[i];
      if (!fixture) continue;
      const emit = createEmit(plugin.manifest);
      const result = plugin.normalize(fixture, { config, bookCurrency, timeZone, emit });
      batches.push({
        sourceKey: `${plugin.manifest.id}:fixture-${i}`,
        raw: fixture,
        lines: result.lines,
        ...(result.balances !== undefined ? { balances: result.balances } : {}),
      });
    }
  }

  return batches;
}

/** Run all five Rastrata plugin invariants against a plugin and its mock routes or fixtures. */
export async function testPlugin<M extends PluginManifest>(
  plugin: IngestPlugin<M>,
  options: TestPluginOptions<M> = {},
): Promise<TestPluginReport<M>> {
  const issues: TestPluginIssue[] = [];

  // 1. Manifest validity
  for (const issue of validateManifest(plugin.manifest)) {
    issues.push({
      invariant: "manifest",
      path: issue.field,
      message: issue.message,
      hint: issue.hint,
    });
  }

  const auth = options.auth ?? defaultAuthFor(plugin.manifest, CANARY_SECRET);
  const secrets = authSecretsOf(auth as Record<string, unknown>);

  // 2. Run twice with identical inputs to prove byte-for-byte determinism
  let first: PullBatch<InferRoleKeys<M>>[] = [];
  let second: PullBatch<InferRoleKeys<M>>[] = [];

  try {
    first = await runOnce(plugin, options, auth, secrets);
    second = await runOnce(plugin, options, auth, secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findLeakedSecret(message, secrets, "thrownError", issues);
    issues.push({
      invariant:
        error instanceof Error && "code" in error && error.code === "egress_blocked"
          ? "egress"
          : "runtime",
      path: "plugin",
      message,
      hint:
        error instanceof Error && "hint" in error && typeof error.hint === "string"
          ? error.hint
          : "Fix the thrown error and re-run testPlugin().",
    });
  }

  if (issues.length === 0 && serializeBatches(first) !== serializeBatches(second)) {
    issues.push({
      invariant: "determinism",
      path: "batches",
      message: "Two identical runs produced different outputs.",
      hint: "Avoid Date.now(), Math.random(), or non-deterministic map ordering; use context.now() instead.",
    });
  }

  // 3. Accounting & structural validation + 4. Secret leak scan
  let bankLineCount = 0;
  let eventCount = 0;
  let balanceCheckCount = 0;

  for (let b = 0; b < first.length; b += 1) {
    const batch = first[b];
    if (!batch) continue;
    if (!batch.sourceKey.trim()) {
      issues.push({
        invariant: "accounting",
        path: `batches[${b}].sourceKey`,
        message: "PullBatch sourceKey cannot be empty.",
        hint: `Use a stable key such as "${plugin.manifest.id}:default".`,
      });
    }
    if (batch.raw.bytes.byteLength === 0) {
      issues.push({
        invariant: "accounting",
        path: `batches[${b}].raw.bytes`,
        message: "Archived raw payload cannot be empty.",
        hint: "Pass the verbatim response bytes from http.getJson().raw.",
      });
    }
    for (let i = 0; i < batch.lines.length; i += 1) {
      const line = batch.lines[i] as IngestLine | undefined;
      if (!line) continue;
      if (line.kind === "bankLine") bankLineCount += 1;
      else eventCount += 1;
      for (const issue of validateLine(line, plugin.manifest, `batches[${b}].lines[${i}]`)) {
        issues.push({
          invariant: "accounting",
          path: issue.field,
          message: issue.message,
          hint: issue.hint,
        });
      }
    }
    for (let c = 0; c < (batch.balances?.length ?? 0); c += 1) {
      const check = batch.balances?.[c];
      if (!check) continue;
      balanceCheckCount += 1;
      for (const issue of validateBalanceCheck(check, `batches[${b}].balances[${c}]`)) {
        issues.push({
          invariant: "accounting",
          path: issue.field,
          message: issue.message,
          hint: issue.hint,
        });
      }
    }
    findLeakedSecret(batch, secrets, `batches[${b}]`, issues);
  }

  return {
    ok: issues.length === 0,
    issues,
    batches: first,
    summary: {
      batchCount: first.length,
      bankLineCount,
      eventCount,
      balanceCheckCount,
    },
    preview: formatPreviewTable(first, plugin.manifest),
  };
}

import { createEmit } from "./builders.ts";
import { PluginError } from "./errors.ts";
import { createGuardedHttp } from "./http.ts";
import { formatPreviewTable } from "./preview.ts";
import { redact } from "./redact.ts";
import type {
  BalanceCheck,
  BankLine,
  InferAuth,
  InferConfig,
  InferRoleKeys,
  IngestLine,
  IngestPlugin,
  LedgerEvent,
  PluginManifest,
  PullBatch,
  RawPayload,
} from "./types.ts";
import {
  assertValidIssues,
  validateBalanceCheck,
  validateLine,
  validateManifest,
} from "./validate.ts";

/** `@rastrata/plugin-sdk/runner` — Zero-dependency out-of-process runner for Rastrata plugins.
 *
 * Pure Web Standards (Fetch, Crypto, TextEncoder) so the exact same runner works in:
 * - Local CLI (`rastrata plugin sync <id> [--dry-run]`)
 * - Standalone user/agent scripts
 * - Isolated Cloud Workers */

const APPLICATION_API_VERSION = "rastrata-application-v1";
const MAX_LINES_PER_PUSH = 500;

export interface PluginInstallManifestPayload {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly authKind: "api_key" | "oauth2" | "file" | "none";
  readonly authLabel?: string;
  readonly authEnvVar?: string;
  readonly roles: readonly {
    readonly key: string;
    readonly label: string;
    readonly kind: "asset" | "liability" | "equity" | "income" | "expense";
    readonly required: boolean;
    readonly defaultRoleKey?: string;
  }[];
  readonly clearing?: {
    readonly role: string;
    readonly windowDays: number;
  };
}

/** Convert an SDK `PluginManifest` into the exact wire object accepted by `POST /v1/plugins.install`. */
export function manifestToInstallPayload(manifest: PluginManifest): PluginInstallManifestPayload {
  assertValidIssues(validateManifest(manifest));
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    domains: [...manifest.domains],
    authKind: manifest.auth.kind,
    ...(manifest.auth.kind === "api_key"
      ? { authLabel: manifest.auth.label, authEnvVar: manifest.auth.envVar }
      : {}),
    roles: (manifest.roles ?? []).map((r) => ({
      key: r.key,
      label: r.label,
      kind: r.kind,
      required: r.required,
      ...(r.defaultRoleKey ? { defaultRoleKey: r.defaultRoleKey } : {}),
    })),
    ...(manifest.clearing
      ? {
          clearing: {
            role: manifest.clearing.role,
            windowDays: manifest.clearing.windowDays ?? 7,
          },
        }
      : {}),
  };
}

export interface PluginPushPayload {
  readonly pluginId: string;
  readonly sourceKey: string;
  readonly rawSha256: string;
  readonly fetchedAt: string;
  readonly bankLines: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly balances: readonly BalanceCheck[];
  readonly cursor?: string;
  readonly ledgerAccountId?: string;
  readonly startOn?: string;
  readonly catchUp?: boolean;
}

/** Convert a `PullBatch` (or a slice of its lines) into a wire payload for `POST /v1/plugins.push`. */
export function batchToPushPayload(
  pluginId: string,
  batch: Pick<PullBatch, "sourceKey" | "lines" | "balances" | "cursor">,
  rawSha256: string,
  options: {
    readonly fetchedAt: string;
    readonly ledgerAccountId?: string;
    readonly startOn?: string;
    readonly catchUp?: boolean;
    readonly includeCursor?: boolean;
    readonly includeBalances?: boolean;
  },
): PluginPushPayload {
  const bankLines: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];

  for (const line of batch.lines) {
    if (line.kind === "bankLine") {
      const b = line as BankLine;
      bankLines.push({
        accountKey: b.accountKey,
        ...(b.providerId !== undefined ? { providerId: b.providerId } : {}),
        rawIndex: b.rawIndex,
        postedOn: b.postedOn,
        amount: b.amount,
        currency: b.currency,
        description: b.description,
        ...(b.counterparty !== undefined ? { counterparty: b.counterparty } : {}),
        ...(b.reference !== undefined ? { reference: b.reference } : {}),
        ...(b.runningBalance !== undefined ? { runningBalance: b.runningBalance } : {}),
        ...(b.excerpt !== undefined ? { excerpt: b.excerpt } : {}),
      });
    } else {
      const e = line as LedgerEvent;
      const links = e.links
        ? Object.entries(e.links).map(([key, value]) => ({ key, value }))
        : undefined;
      events.push({
        accountKey: e.accountKey,
        providerId: e.providerId,
        rawIndex: e.rawIndex,
        eventOn: e.eventOn,
        summary: e.summary,
        currency: e.currency,
        ...(e.amount !== undefined ? { amount: e.amount } : {}),
        legs: e.legs.map((leg) => ({
          role: leg.role,
          amount: leg.amount,
          ...(leg.memo !== undefined ? { memo: leg.memo } : {}),
        })),
        ...(links && links.length > 0 ? { links } : {}),
        ...(e.coveredBy !== undefined ? { coveredBy: e.coveredBy } : {}),
        ...(e.evidence !== undefined ? { evidence: e.evidence } : {}),
        ...(e.sourceId !== undefined ? { sourceId: e.sourceId } : {}),
        ...(e.excerpt !== undefined ? { excerpt: e.excerpt } : {}),
      });
    }
  }

  return {
    pluginId,
    sourceKey: batch.sourceKey,
    rawSha256,
    fetchedAt: options.fetchedAt,
    bankLines,
    events,
    balances: options.includeBalances === false ? [] : [...(batch.balances ?? [])],
    ...(options.includeCursor !== false && batch.cursor !== undefined
      ? { cursor: batch.cursor }
      : {}),
    ...(options.ledgerAccountId !== undefined ? { ledgerAccountId: options.ledgerAccountId } : {}),
    ...(options.startOn !== undefined ? { startOn: options.startOn } : {}),
    ...(options.catchUp ? { catchUp: true } : {}),
  };
}

export interface PluginPushReceipt {
  readonly pluginId: string;
  readonly sourceKey: string;
  readonly batchId: string;
  readonly newCount: number;
  readonly duplicateCount: number;
  readonly overlapCount: number;
  readonly excludedCount: number;
  readonly cursor: string | null;
  readonly balances: readonly {
    readonly accountKey: string;
    readonly asOf: string;
    readonly reported: string;
    readonly ledger: string | null;
    readonly waiting: string | null;
    readonly excluded: string | null;
    readonly difference: string | null;
  }[];
}

export interface RunPluginSyncOptions<M extends PluginManifest> {
  /** Rastrata API base URL (e.g. "http://127.0.0.1:4010"). Required when `dryRun` is false. */
  readonly endpoint?: string;
  /** Book ID (defaults to "local-book"). */
  readonly bookId?: string;
  /** Plugin-scoped `rsp_...` token (recommended) or owner/agent bearer token. */
  readonly token?: string;
  /** Plugin non-secret configuration matching `manifest.fields`. */
  readonly config?: InferConfig<M>;
  /** Provider credentials matching `manifest.auth` (kept local; automatically redacted on errors). */
  readonly auth: InferAuth<M>;
  /** Override starting cursor instead of reading saved cursor from `plugins.status`. */
  readonly cursor?: string | null;
  /** Raw fixture payload(s) for file-based `normalize()` plugins. */
  readonly fixtures?: readonly RawPayload[];
  /** Book currency (ISO-4217 uppercase, default "USD"). */
  readonly bookCurrency?: string;
  /** IANA time zone (default "UTC"). */
  readonly timeZone?: string;
  /** When true, runs provider pull/normalize and prints ledger preview without touching Rastrata. */
  readonly dryRun?: boolean;
  /** Optional clock override for deterministic tests. */
  readonly now?: () => string;
  /** Optional provider `fetch` override for tests. */
  readonly providerFetch?: typeof fetch;
  /** Optional Rastrata API `fetch` override for in-memory integration tests. */
  readonly rastrataFetch?: typeof fetch;
  /** Total attempts for retryable provider HTTP errors (429, 5xx). Defaults to 4. */
  readonly maxAttempts?: number;
  /** Optional sleep hook for retry backoff (injectable for fast tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Allow loopback HTTP URLs in `GuardedHttp` (test mode only). */
  readonly allowLoopback?: boolean;
}

export interface RunPluginSyncResult<M extends PluginManifest> {
  readonly ok: true;
  readonly pluginId: string;
  readonly dryRun: boolean;
  readonly batches: readonly PullBatch<InferRoleKeys<M>>[];
  readonly pushed: readonly PluginPushReceipt[];
  readonly preview: string;
  readonly totals: {
    readonly batches: number;
    readonly bankLines: number;
    readonly events: number;
    readonly balanceChecks: number;
    readonly newCount: number;
    readonly duplicateCount: number;
    readonly excludedCount: number;
  };
}

function authSecretsOf(auth: unknown): string[] {
  if (!auth || typeof auth !== "object") return [];
  return Object.values(auth as Record<string, unknown>).filter(
    (v): v is string => typeof v === "string" && v.length >= 4,
  );
}

interface Envelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}

async function callRastrata<T>(
  fetchImpl: typeof fetch,
  endpoint: string,
  bookId: string,
  token: string | undefined,
  operation: string,
  input: Record<string, unknown>,
  operationId: string | undefined,
  secrets: readonly string[],
): Promise<T> {
  const base = endpoint.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/v1/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId,
      input,
      ...(operationId ? { operationId } : {}),
    }),
  });
  const text = await response.text();
  let parsed: Envelope<T>;
  try {
    parsed = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new PluginError({
      code: "provider_error",
      message: redact(
        `Rastrata ${operation} returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        secrets,
      ),
      hint: "Verify the Rastrata endpoint URL and that the service is running.",
    });
  }
  if (!response.ok || !parsed.ok || parsed.data === undefined) {
    const code = parsed.error?.code ?? `http_${response.status}`;
    const msg = parsed.error?.message ?? `HTTP ${response.status}`;
    throw new PluginError({
      code: "provider_error",
      message: redact(`Rastrata ${operation} failed (${code}): ${msg}`, secrets),
      hint:
        response.status === 401 || response.status === 403
          ? "Check that your plugin token (rsp_...) is active and bound to this plugin."
          : "Inspect the error message from Rastrata and retry.",
    });
  }
  return parsed.data;
}

async function uploadPluginRaw(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string | undefined,
  raw: RawPayload,
  secrets: readonly string[],
): Promise<string> {
  const base = endpoint.replace(/\/+$/, "");
  const body = new Uint8Array(raw.bytes);
  const response = await fetchImpl(`${base}/v1/uploads`, {
    method: "POST",
    headers: {
      "content-type": raw.mediaType || "application/octet-stream",
      "x-upload-for": "plugin",
      ...(raw.name ? { "x-upload-name": encodeURIComponent(raw.name) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  const text = await response.text();
  let parsed: Envelope<{ readonly sha256: string }>;
  try {
    parsed = JSON.parse(text) as Envelope<{ readonly sha256: string }>;
  } catch {
    throw new PluginError({
      code: "provider_error",
      message: redact(`Rastrata /v1/uploads returned HTTP ${response.status}`, secrets),
      hint: "Ensure the raw payload is non-empty and under 16 MiB.",
    });
  }
  if (!response.ok || !parsed.ok || !parsed.data?.sha256) {
    const msg = parsed.error?.message ?? `HTTP ${response.status}`;
    throw new PluginError({
      code: "provider_error",
      message: redact(`Raw payload upload failed: ${msg}`, secrets),
      hint: "Verify your plugin token is valid and the workspace is not read-only.",
    });
  }
  return parsed.data.sha256;
}

function validateBatch(batch: PullBatch, manifest: PluginManifest, batchIndex: number): void {
  if (!batch.sourceKey.trim()) {
    throw new PluginError({
      code: "invalid_line",
      message: `Batch ${batchIndex} has an empty sourceKey.`,
      hint: `Set sourceKey to a stable identifier such as "${manifest.id}:default".`,
    });
  }
  if (batch.raw.bytes.byteLength === 0) {
    throw new PluginError({
      code: "invalid_line",
      message: `Batch ${batchIndex} has empty raw bytes.`,
      hint: "Archive the verbatim provider response bytes in batch.raw.bytes.",
    });
  }
  const issues = [];
  for (let i = 0; i < batch.lines.length; i += 1) {
    const line = batch.lines[i] as IngestLine | undefined;
    if (!line) continue;
    issues.push(...validateLine(line, manifest, `batches[${batchIndex}].lines[${i}]`));
  }
  for (let i = 0; i < (batch.balances?.length ?? 0); i += 1) {
    const check = batch.balances?.[i];
    if (!check) continue;
    issues.push(...validateBalanceCheck(check, `batches[${batchIndex}].balances[${i}]`));
  }
  assertValidIssues(issues);
}

/** Run an ingestion plugin end-to-end: pull/normalize -> validate -> preview (`--dry-run`) or
 * archive raw bytes + `plugins.push` atomically to Rastrata. */
export async function runPluginSync<M extends PluginManifest>(
  plugin: IngestPlugin<M>,
  options: RunPluginSyncOptions<M>,
): Promise<RunPluginSyncResult<M>> {
  assertValidIssues(validateManifest(plugin.manifest));

  const dryRun = options.dryRun === true;
  const endpoint = options.endpoint ?? "http://127.0.0.1:4010";
  const bookId = options.bookId ?? "local-book";
  const rastrataFetch = options.rastrataFetch ?? fetch;
  const config = (options.config ?? {}) as InferConfig<M>;
  const bookCurrency = (options.bookCurrency ?? "USD").toUpperCase();
  const timeZone = options.timeZone ?? "UTC";
  const now = options.now ?? (() => new Date().toISOString());
  const secrets = authSecretsOf(options.auth);

  // Resolve starting cursor from Rastrata `plugins.status` when not supplied explicitly.
  let startingCursor: string | null = options.cursor ?? null;
  if (!dryRun && options.cursor === undefined) {
    const status = await callRastrata<{
      readonly cursors: readonly { readonly sourceKey: string; readonly cursor: string | null }[];
    }>(
      rastrataFetch,
      endpoint,
      bookId,
      options.token,
      "plugins.status",
      { pluginId: plugin.manifest.id },
      undefined,
      secrets,
    );
    const nonNull = status.cursors.filter((c) => c.cursor !== null);
    if (nonNull.length === 1 && nonNull[0]) {
      startingCursor = nonNull[0].cursor;
    } else if (nonNull.length > 1) {
      // Multi-source plugins receive a JSON map of sourceKey -> cursor when multiple cursors exist.
      const map: Record<string, string> = {};
      for (const entry of nonNull) {
        if (entry.cursor !== null) map[entry.sourceKey] = entry.cursor;
      }
      startingCursor = JSON.stringify(map);
    }
  }

  const batches: PullBatch<InferRoleKeys<M>>[] = [];
  const pushed: PluginPushReceipt[] = [];
  const emit = createEmit(plugin.manifest);

  // Stream each yielded batch directly to Rastrata (archive -> chunked push + cursor)
  // so long backfills commit progress incrementally and never lose earlier pages on failure.
  const commitBatch = async (batch: PullBatch<InferRoleKeys<M>>): Promise<void> => {
    if (dryRun) return;
    const sha256 = await uploadPluginRaw(
      rastrataFetch,
      endpoint,
      options.token,
      batch.raw,
      secrets,
    );
    const fetchedAt = now();
    // Respect Rastrata's 500-line push bound automatically; cursor & balances commit on final chunk.
    const total = batch.lines.length;
    const chunkCount = Math.max(1, Math.ceil(total / MAX_LINES_PER_PUSH));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * MAX_LINES_PER_PUSH;
      const slice = batch.lines.slice(start, start + MAX_LINES_PER_PUSH);
      const isLast = chunkIndex === chunkCount - 1;
      const payload = batchToPushPayload(
        plugin.manifest.id,
        {
          sourceKey: batch.sourceKey,
          lines: slice,
          ...(isLast && batch.balances ? { balances: batch.balances } : {}),
          ...(isLast && batch.cursor !== undefined ? { cursor: batch.cursor } : {}),
        },
        sha256,
        {
          fetchedAt,
          includeCursor: isLast,
          includeBalances: isLast,
        },
      );
      const receipt = await callRastrata<PluginPushReceipt>(
        rastrataFetch,
        endpoint,
        bookId,
        options.token,
        "plugins.push",
        payload as unknown as Record<string, unknown>,
        crypto.randomUUID(),
        secrets,
      );
      pushed.push(receipt);
    }
  };

  if (plugin.pull && !options.fixtures) {
    const http = createGuardedHttp({
      domains: plugin.manifest.domains,
      secrets,
      ...(options.providerFetch ? { fetchImpl: options.providerFetch } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.allowLoopback ? { allowLoopback: true } : {}),
    });
    for await (const batch of plugin.pull({
      cursor: startingCursor,
      auth: options.auth,
      config,
      bookCurrency,
      timeZone,
      http,
      now,
      emit,
    })) {
      validateBatch(batch, plugin.manifest, batches.length);
      await commitBatch(batch);
      batches.push(batch);
    }
  } else if (plugin.normalize && options.fixtures) {
    for (let i = 0; i < options.fixtures.length; i += 1) {
      const fixture = options.fixtures[i];
      if (!fixture) continue;
      const result = plugin.normalize(fixture, { config, bookCurrency, timeZone, emit });
      const batch: PullBatch<InferRoleKeys<M>> = {
        sourceKey: `${plugin.manifest.id}:${fixture.name ?? `file-${i}`}`,
        raw: fixture,
        lines: result.lines,
        ...(result.balances !== undefined ? { balances: result.balances } : {}),
      };
      validateBatch(batch, plugin.manifest, batches.length);
      await commitBatch(batch);
      batches.push(batch);
    }
  } else {
    throw new PluginError({
      code: "invalid_manifest",
      message: `Plugin "${plugin.manifest.id}" has neither a runnable pull() method nor fixtures for normalize().`,
      hint: "Implement pull() for API connectors, or pass fixtures for file-based normalize() plugins.",
    });
  }

  let bankLines = 0;
  let events = 0;
  let balanceChecks = 0;
  for (const batch of batches) {
    for (const line of batch.lines) {
      if (line.kind === "bankLine") bankLines += 1;
      else events += 1;
    }
    balanceChecks += batch.balances?.length ?? 0;
  }

  let newCount = 0;
  let duplicateCount = 0;
  let excludedCount = 0;
  for (const receipt of pushed) {
    newCount += receipt.newCount;
    duplicateCount += receipt.duplicateCount;
    excludedCount += receipt.excludedCount;
  }

  return {
    ok: true,
    pluginId: plugin.manifest.id,
    dryRun,
    batches,
    pushed,
    preview: formatPreviewTable(batches, plugin.manifest),
    totals: {
      batches: batches.length,
      bankLines,
      events,
      balanceChecks,
      newCount,
      duplicateCount,
      excludedCount,
    },
  };
}

export { formatPreviewTable };

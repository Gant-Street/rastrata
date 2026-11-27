/** Shared by the experiment scripts: where a store comes from (the in-memory fake, MinIO, R2), how
 * run identifiers and result files are named, and how a table is printed. Nothing here ever prints,
 * logs or returns a credential except to the S3 client that signs with it. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { VirtualClock } from "../src/clock.ts";
import { MemoryObjectStore, type FaultRates, type LatencyModel } from "../src/memory.ts";
import { MeteredObjectStore, quantile, summarize, type OpSummary } from "../src/metered.ts";
import { ObjectStoreError } from "../src/objectstore.ts";
import { S3ObjectStore } from "../src/s3.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { ObjectStoreLogTier } from "../src/tier-objects.ts";
import { PostgresLogTier } from "../src/tier-postgres.ts";
import type { LogTier } from "../src/tier.ts";
import { sha256Hex, signRequest } from "../src/sigv4.ts";

export type Target = "memory" | "minio" | "r2";

export const R2_ENV_FILE = join(homedir(), ".config", "rastrata", "r2-spike.env");
/** The only place in the bucket this lane may write. */
export const R2_PREFIX_ROOT = "runs/hoststore/";

export interface R2Env {
  readonly accountId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Reads the key file if it exists. Returns null when it does not (every R2 run then skips). */
export function loadR2Env(): R2Env | null {
  if (!existsSync(R2_ENV_FILE)) return null;
  const values: Record<string, string> = {};
  for (const line of readFileSync(R2_ENV_FILE, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    values[match[1] as string] = (match[2] as string).replace(/^(['"])(.*)\1$/, "$2");
  }
  const accountId = values.R2_ACCOUNT_ID;
  const bucket = values.R2_BUCKET;
  const accessKeyId = values.R2_ACCESS_KEY_ID;
  const secretAccessKey = values.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: values.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

export interface MinioEnv {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
export function minioEnv(): MinioEnv {
  return {
    endpoint: process.env.BOOKLOG_MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
    bucket: process.env.BOOKLOG_MINIO_BUCKET ?? "booklog-spike",
    accessKeyId: process.env.BOOKLOG_MINIO_USER ?? "minioadmin",
    secretAccessKey: process.env.BOOKLOG_MINIO_PASSWORD ?? "minioadmin",
  };
}

/** Make the bucket if the service does not have it yet (MinIO only; the R2 bucket exists). */
export async function ensureBucket(env: MinioEnv): Promise<void> {
  const url = new URL(`${env.endpoint}/${env.bucket}`);
  const signed = signRequest({
    method: "PUT",
    url,
    headers: {},
    payloadHash: sha256Hex(""),
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    region: "us-east-1",
    date: new Date(),
  });
  const { host: _host, ...headers } = signed.headers;
  const response = await fetch(url, { method: "PUT", headers });
  if (response.status !== 200 && response.status !== 409)
    throw new ObjectStoreError(`Could not create the bucket: HTTP ${response.status}`);
}

export function newRunId(): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Argv {
  readonly flags: ReadonlyMap<string, string>;
  string(name: string, fallback: string): string;
  number(name: string, fallback: number): number;
  has(name: string): boolean;
}
export function parseArgs(argv: readonly string[] = process.argv.slice(2)): Argv {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;
    if (!item.startsWith("--")) continue;
    const [name, inline] = item.slice(2).split("=", 2);
    const next = argv[index + 1];
    if (inline !== undefined) flags.set(name as string, inline);
    else if (next !== undefined && !next.startsWith("--")) {
      flags.set(name as string, next);
      index += 1;
    } else flags.set(name as string, "true");
  }
  return {
    flags,
    string: (name, fallback) => flags.get(name) ?? fallback,
    number: (name, fallback) => {
      const value = flags.get(name);
      return value === undefined ? fallback : Number(value);
    },
    has: (name) => flags.has(name),
  };
}

export interface StoreHandle {
  readonly target: Target;
  readonly store: MeteredObjectStore;
  /** A new store on the same bucket, for experiments that compare connection policies. With
   * `abortAfterMs` every request is abandoned that many milliseconds after it starts: the way to
   * lose a response on a real service. */
  readonly open: (options?: {
    keepAlive?: boolean;
    abortAfterMs?: () => number;
  }) => MeteredObjectStore;
  /** Every store this handle has made, for counting operations. */
  readonly stores: () => readonly MeteredObjectStore[];
  /** The Cloudflare data centers that answered (from the cf-ray header), when there are any. */
  readonly colos?: () => string[];
  readonly prefix: string;
  readonly runId: string;
  readonly description: Record<string, unknown>;
  readonly memory?: MemoryObjectStore;
  readonly clock?: VirtualClock;
  /** Delete every object this run wrote. Returns the number deleted. */
  cleanup(): Promise<number>;
}

export interface MemoryShape {
  readonly latency?: LatencyModel;
  readonly faults?: FaultRates;
  readonly seed?: number;
}

/** A store for `target`, or null with a reason when it cannot be had (the R2 key file is absent,
 * MinIO is not running). `reason` is for the person running the script. */
export async function openTarget(
  target: Target,
  options: { runId?: string; keepAlive?: boolean; memory?: MemoryShape } = {},
): Promise<{ handle: StoreHandle } | { skipped: string }> {
  const runId = options.runId ?? newRunId();
  const prefix = `${R2_PREFIX_ROOT}${runId}/`;
  if (target === "memory") {
    const clock = new VirtualClock();
    const memory = new MemoryObjectStore({
      clock,
      seed: options.memory?.seed ?? 1,
      ...(options.memory?.latency ? { latency: options.memory.latency } : {}),
      ...(options.memory?.faults ? { faults: options.memory.faults } : {}),
    });
    const made: MeteredObjectStore[] = [];
    const build = () => {
      const metered = new MeteredObjectStore(memory, { now: () => clock.now() });
      made.push(metered);
      return metered;
    };
    return {
      handle: {
        target,
        store: build(),
        open: build,
        stores: () => made,
        prefix,
        runId,
        memory,
        clock,
        description: { kind: "in-memory fake", latency: options.memory?.latency ?? null },
        cleanup: async () => {
          const count = memory.size;
          memory.clear();
          return count;
        },
      },
    };
  }
  let config: ConstructorParameters<typeof S3ObjectStore>[0];
  let description: Record<string, unknown>;
  if (target === "r2") {
    const env = loadR2Env();
    if (!env) return { skipped: `no R2 key file at ${R2_ENV_FILE}` };
    config = {
      endpoint: env.endpoint,
      bucket: env.bucket,
      region: "auto",
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    };
    description = {
      kind: "Cloudflare R2 (S3 API)",
      bucket: env.bucket,
      endpointHost: new URL(env.endpoint).host,
    };
  } else {
    const env = minioEnv();
    try {
      await ensureBucket(env);
    } catch (error) {
      return {
        skipped: `MinIO is not reachable at ${env.endpoint} (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    config = {
      endpoint: env.endpoint,
      bucket: env.bucket,
      region: "us-east-1",
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    };
    description = { kind: "MinIO (S3 API)", endpoint: env.endpoint, bucket: env.bucket };
  }
  const made: MeteredObjectStore[] = [];
  const colos = new Set<string>();
  const build = (extra: { keepAlive?: boolean; abortAfterMs?: () => number } = {}) => {
    const metered = new MeteredObjectStore(
      new S3ObjectStore({
        ...config,
        timeoutMs: 15_000,
        keepAlive: extra.keepAlive ?? options.keepAlive ?? true,
        fetch: async (url, init) => {
          const signals = [
            init.signal,
            extra.abortAfterMs ? AbortSignal.timeout(extra.abortAfterMs()) : null,
          ];
          const response = await fetch(url, {
            ...init,
            signal: AbortSignal.any(
              signals.filter((item): item is AbortSignal => item !== null && item !== undefined),
            ),
          });
          const ray = response.headers.get("cf-ray");
          if (ray) colos.add(ray.split("-").pop() ?? "");
          return response;
        },
      }),
    );
    made.push(metered);
    return metered;
  };
  const store = build();
  return {
    handle: {
      target,
      store,
      open: build,
      stores: () => made,
      colos: () => [...colos].sort(),
      prefix,
      runId,
      description,
      cleanup: async () => {
        // Deletes are free; the listing is a Class A operation.
        let deleted = 0;
        let after: string | undefined;
        for (;;) {
          const page = await store.list(prefix, after);
          for (const item of page.objects) {
            await store.delete(item.key);
            deleted += 1;
          }
          if (!page.truncated) break;
          after = page.objects[page.objects.length - 1]?.key;
        }
        return deleted;
      },
    },
  };
}

export function machine(): Record<string, unknown> {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    bun: Bun.version,
    container: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  };
}

export const ms = (seconds: number): string => (seconds * 1000).toFixed(1);

export function printTable(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): void {
  const cells = [headers.map(String), ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) =>
    Math.max(...cells.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  console.log(line(cells[0] as string[]));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of cells.slice(1)) console.log(line(row));
}

export function summaryRow(label: string, summary: OpSummary): (string | number)[] {
  return [
    label,
    summary.n,
    ms(summary.p50),
    ms(summary.p95),
    ms(summary.p99),
    ms(summary.min),
    ms(summary.max),
    ms(summary.mean),
  ];
}
export const SUMMARY_HEADERS = [
  "what",
  "n",
  "p50 ms",
  "p95 ms",
  "p99 ms",
  "min ms",
  "max ms",
  "mean ms",
];

/** Seconds -> summary with the percentile rule used everywhere (nearest rank). */
export { quantile, summarize };

/** Write the JSON result where asked, and append a line of operation counts to the ledger the
 * person running the script keeps for the shared R2 budget. */
export function record(
  name: string,
  result: unknown,
  options: { out?: string; ledger?: string; counts?: { classA: number; classB: number } },
): void {
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(result, replacer, 2)}\n`);
  }
  if (options.ledger && options.counts)
    appendFileSync(
      options.ledger,
      `${JSON.stringify({ at: new Date().toISOString(), experiment: name, ...options.counts })}\n`,
    );
}
export function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export type TierKind = "memory" | "postgres" | "r2" | "minio";

export interface TierHandle {
  readonly kind: TierKind;
  readonly tier: LogTier;
  readonly description: Record<string, unknown>;
  /** The object store behind an object-store tail, for counting its operations. */
  readonly stores: () => readonly MeteredObjectStore[];
  readonly runId: string;
  cleanup(): Promise<void>;
}

export const POSTGRES_URL =
  process.env.BOOKLOG_PG_URL ?? "postgres://postgres:booklog@127.0.0.1:55432/booklog";

/** A tail of the given kind, or a reason it cannot be had. */
export async function openTier(
  kind: TierKind,
  options: { runId?: string } = {},
): Promise<{ handle: TierHandle } | { skipped: string }> {
  const runId = options.runId ?? newRunId();
  if (kind === "memory") {
    const tier = new MemoryLogTier();
    return {
      handle: {
        kind,
        tier,
        runId,
        description: { kind: "in-memory tail (no network)" },
        stores: () => [],
        cleanup: async () => {},
      },
    };
  }
  if (kind === "postgres") {
    try {
      const tier = await PostgresLogTier.connect(POSTGRES_URL, { max: 4 });
      return {
        handle: {
          kind,
          tier,
          runId,
          description: {
            kind: "Postgres 17 (container on this machine's VM, not the cluster)",
            host: new URL(POSTGRES_URL).host,
          },
          stores: () => [],
          cleanup: async () => {
            await tier.close();
          },
        },
      };
    } catch (error) {
      return {
        skipped: `Postgres is not reachable (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  const opened = await openTarget(kind, { runId });
  if ("skipped" in opened) return opened;
  const { handle } = opened;
  return {
    handle: {
      kind,
      tier: new ObjectStoreLogTier(handle.store, { prefix: handle.prefix }),
      runId,
      description: { ...handle.description, as: "tail of create-only objects (no lease)" },
      stores: () => handle.stores(),
      cleanup: async () => {
        await handle.cleanup();
      },
    },
  };
}

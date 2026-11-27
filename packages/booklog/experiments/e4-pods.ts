/** What the E4 experiments share: real API server processes (apps/api with `RASTRATA_BOOK_STORE`) serving
 * one book from a tail and a directory bucket, a client's way of asking them, and a way to read the log
 * back from nothing and check it. */
import { join, resolve } from "node:path";
import { GENESIS_HASH, type LogTier } from "../src/tier.ts";
import { durableObjectHandler } from "../src/tier-durable.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { PostgresLogTier } from "../src/tier-postgres.ts";
import { FileObjectStore } from "../src/store-file.ts";
import { BookKeys } from "../src/objectstore.ts";
import { readLog, type LogEntry } from "../src/logreader.ts";
import { APPLICATION_SCHEMA } from "../test/support/app.ts";

export const REPO = resolve(import.meta.dir, "../../..");
export const MAIN = join(REPO, "apps/api/src/main.ts");
/** The port offset this lane works in (RASTRATA_PORT_OFFSET). */
export const PORT_BASE = 4010 + Number(process.env.RASTRATA_PORT_OFFSET ?? 2900) + 20;
export const PG_URL =
  process.env.BOOKLOG_PG_URL ?? "postgres://postgres:booklog@127.0.0.1:55432/booklog";

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export const BOOK = {
  name: "Contention Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "6100", name: "Software", role: "expense" },
  ],
};
export const draftInput = (reference: string) => ({
  data: {
    date: "2026-03-02",
    reference,
    narration: reference,
    lines: [
      { accountId: "6100", debit: "5.00", credit: "" },
      { accountId: "1010", debit: "", credit: "5.00" },
    ],
  },
});

export interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  readonly body: any;
}

/** One request to an operation; null when it could not be answered in time (the outcome is unknown). */
export async function call(
  port: number,
  name: string,
  input: unknown,
  operationId: string | undefined,
  timeoutMs: number,
): Promise<Reply | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "rastrata-application-v1",
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return null;
  }
}

export async function control(port: number, path: string, body?: unknown): Promise<Reply | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/control/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return null;
  }
}

export interface Pod {
  readonly name: string;
  readonly port: number;
  readonly cache: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** The client does not try this pod again before this time (milliseconds of the run's clock): it
   * did not answer, as a balancer's passive health check would see. */
  badUntil: number;
}

export function startPod(options: {
  readonly name: string;
  readonly port: number;
  readonly cache: string;
  readonly bookId: string;
  readonly bucket: string;
  readonly tail: string;
  /** More settings for this pod (RASTRATA_BOOK_STANDBY=1, ...). */
  readonly env?: Readonly<Record<string, string>>;
}): Pod {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("RASTRATA_")) env[key] = value;
  Object.assign(env, {
    RASTRATA_LOCAL_DEV: "1",
    RASTRATA_API_PORT: String(options.port),
    RASTRATA_BOOK_STORE: `r2log://${options.bookId}`,
    RASTRATA_BOOK_BULK: `file://${options.bucket}`,
    // The tail's address (a Postgres URL has a password in it) goes by the environment, not the command line.
    RASTRATA_BOOK_TAIL: options.tail,
    RASTRATA_BOOK_CACHE: options.cache,
    RASTRATA_BOOK_CONTROL: "1",
    // A Durable Object tail gets a circuit breaker and a lease given up when idle by default; these
    // experiments inject their own faults and measure the lease as it is, so they run without either.
    RASTRATA_BOOK_TAIL_BREAKER: "off",
    RASTRATA_BOOK_IDLE_RELEASE_MS: "0",
    // A snapshot now and then, as a hosted book has, so that the pod taking over replays a bounded log.
    RASTRATA_BOOK_SNAPSHOT_EVERY: "500",
    ...options.env,
  });
  const proc = Bun.spawn([process.execPath, MAIN], { env, stdout: "ignore", stderr: "ignore" });
  return { name: options.name, port: options.port, cache: options.cache, proc, badUntil: 0 };
}

/** Stop or continue a pod's process. (`Subprocess.kill("SIGSTOP")` in Bun does not stop the process;
 * `process.kill` does.) */
export function signal(pod: Pod, name: "SIGSTOP" | "SIGCONT"): void {
  try {
    process.kill(pod.proc.pid, name);
  } catch {
    // already gone
  }
}

export async function ready(pod: Pod): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${pod.port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`Pod ${pod.name} did not start`);
}

export interface TailHandle {
  /** What a pod is told to use as its tail. */
  readonly url: string;
  /** A tier of its own, for importing a book and for reading the log back. */
  readonly reader: () => Promise<LogTier>;
  readonly close: () => Promise<void>;
}

/** The tail the pods share: Postgres (the local container), or a Durable Object protocol server run by
 * this process around the in-memory tail. */
export async function openTail(kind: "postgres" | "do"): Promise<TailHandle> {
  if (kind === "postgres") {
    // The schema is made once, here, so that the pods do not race to create it.
    const first = await PostgresLogTier.connect(PG_URL, { max: 2, createSchema: true });
    await first.close();
    const readers: PostgresLogTier[] = [];
    return {
      url: PG_URL,
      reader: async () => {
        const tier = await PostgresLogTier.connect(PG_URL, { max: 2, createSchema: false });
        readers.push(tier);
        return tier;
      },
      close: async () => {
        for (const reader of readers) await reader.close().catch(() => {});
      },
    };
  }
  const core = new MemoryLogTier();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: durableObjectHandler(core),
  });
  return {
    url: `do:http://127.0.0.1:${server.port}`,
    reader: async () => core,
    close: async () => {
      await server.stop(true);
    },
  };
}

export interface LogCheck {
  readonly entries: LogEntry[];
  /** "ok", or what stopped the read (a gap, a bad link). */
  readonly chain: string;
  /** How many entries carry each operation identity. */
  readonly counts: Map<string, number>;
  /** Entries whose fence is lower than the one before. */
  readonly fenceRegressions: number;
  readonly writers: string[];
  readonly fences: number[];
}

/** The whole log, read from nothing and verified link by link. */
export async function readWholeLog(
  tier: LogTier,
  bucket: string,
  bookId: string,
): Promise<LogCheck> {
  const entries: LogEntry[] = [];
  let chain = "ok";
  try {
    const generator = readLog({
      tier,
      bulk: new FileObjectStore(bucket),
      keys: new BookKeys("", bookId),
      schema: APPLICATION_SCHEMA,
      after: { seq: 0, hash: GENESIS_HASH },
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) break;
      entries.push(next.value);
    }
  } catch (error) {
    chain = error instanceof Error ? error.message : String(error);
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const id = entry.header.opId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let fenceRegressions = 0;
  for (let index = 1; index < entries.length; index += 1)
    if ((entries[index] as LogEntry).header.fence < (entries[index - 1] as LogEntry).header.fence)
      fenceRegressions += 1;
  return {
    entries,
    chain,
    counts,
    fenceRegressions,
    writers: [...new Set(entries.map((entry) => entry.header.writer))],
    fences: [...new Set(entries.map((entry) => entry.header.fence))],
  };
}

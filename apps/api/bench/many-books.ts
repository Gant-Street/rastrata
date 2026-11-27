#!/usr/bin/env bun
/** Measure a pod that serves many books, in one process: the real server (apps/api/src/hosted.ts in many-books mode) on a memory tail and a folder
 * for a bucket, with the control plane's tokens told to the front door. The clients are in the same process, so they share the server's one thread and
 * the neighbours' latencies come out larger than a pod's. It is the quick check of the registry; the load profile at the launch count is the k6 run
 * against a pod on the cluster (docs/reference/program/hosting/many-books.md, "Not done").
 *
 *   bun load/many-books.ts fixed-cost [--books 100] [--drafts 0]
 *       what each additional empty (or small) tenant book costs in memory and time, and the latency of a warm read across them
 *   bun load/many-books.ts memory --ladder DIR
 *       resident memory of a book of each size in the ladder after its first read, and after it is closed
 *   bun load/many-books.ts activation --ladder DIR [--small 30]
 *       thirty small tenants read all the time while the books of the ladder open cold, one by one and then together: their latency, the event loop's lag,
 *       the cold-open times and the peak resident set
 *
 * DIR is made by the seeder: `bun scripts/seed-books.ts --out DIR --tenants 1 --scale 0.01 --huge no --ladder 500,2000,5000`. */
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueOwnerKey, issueServiceKey, sha256Hex } from "@rastrata/application/agent";
import { APPLICATION_DERIVED, APPLICATION_SCHEMA } from "@rastrata/application/hosted";
import type { MemberTokenVerdict, MemberTokenVerifier } from "@rastrata/application/member-token";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { FileObjectStore, importBookFile } from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import type { BooksSettings } from "../src/hosted-books.ts";
import { parseBookStore, startHostedApplicationServer } from "../src/hosted.ts";

const MB = 2 ** 20;
const HOST = "app.example.test";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const args = process.argv.slice(2);
const command = args[0];
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
};
const rss = (): number => process.memoryUsage().rss / MB;
const settled = (): number => {
  Bun.gc(true);
  return rss();
};

const BOOK = {
  name: "Load Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "6100", name: "Software", role: "expense" },
  ],
};
const draft = (reference: string) => ({
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

interface Answer {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: decoded JSON of many shapes
  readonly body: any;
  readonly ms: number;
}

/** A pod serving many books, and the control plane around it: a service key, and tokens it will vouch for. */
async function pod(settings: Partial<BooksSettings> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rastrata-many-bench-"));
  const ownerKey = issueOwnerKey();
  const serviceKey = issueServiceKey();
  const known = new Map<string, MemberTokenVerdict>();
  const verifier: MemberTokenVerifier = {
    verify: async (token) => known.get(token) ?? { kind: "refused" },
  };
  const tail = new MemoryLogTier();
  const bucket = join(root, "bucket");
  const server = await startHostedApplicationServer({
    config: parseBookStore("r2log://rastrata-main", {
      RASTRATA_BOOK_BULK: pathToFileURL(bucket).href,
      RASTRATA_BOOK_TAIL: "memory",
      RASTRATA_BOOK_CACHE: join(root, "cache"),
    }),
    port: 0,
    telemetry: false,
    stores: { tail },
    ownerKey,
    serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: `https://${HOST}` },
    web: null,
    agentTokens: false,
    memberTokens: { origin: `https://${HOST}`, verifier },
    serviceKeys: [await sha256Hex(serviceKey)],
    books: {
      settings: {
        sweepMs: 0,
        maxBooks: 10_000,
        warmBudgetBytes: 100_000 * MB,
        rate: 100_000,
        burst: 100_000,
        inflight: 1000,
        ...settings,
      },
    },
  });
  const registry = server.books;
  if (!registry) throw new Error("the server has no registry");
  const base = `http://127.0.0.1:${server.server.port}`;
  let operations = 0;
  const call = async (
    credential: string,
    name: string,
    input: unknown,
    book?: string,
  ): Promise<Answer> => {
    const started = performance.now();
    const response = await fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: HOST,
        authorization: `Bearer ${credential}`,
        ...(book ? { "x-rastrata-book": book } : {}),
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        operationId: `00000000-0000-4000-8000-${String(++operations).padStart(12, "0")}`,
      }),
    });
    const body = await response.json();
    return { status: response.status, body, ms: performance.now() - started };
  };
  let people = 0;
  /** The control plane puts a person in a book as its owner, and gives them a token for it. */
  const owner = async (bookId: string): Promise<string> => {
    const n = ++people;
    const userId = `user_${String(n).padStart(10, "0")}`;
    const token = `aaaaaaaaaa${String(n).padStart(6, "0")}.bbbbbbbbbbbb.cccccccccccc`;
    known.set(token, {
      kind: "valid",
      claims: { sub: userId, wid: `wsp_${String(n).padStart(10, "0")}`, bid: bookId },
    });
    const added = await call(
      serviceKey,
      "members.add",
      { userId, email: `${userId}@example.com`, role: "owner" },
      bookId,
    );
    if (added.status !== 200) throw new Error(`members.add ${added.status}`);
    return token;
  };
  return {
    server,
    registry,
    tail,
    bucket,
    root,
    call,
    owner,
    stop: async () => {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Rung {
  readonly id: string;
  readonly file: string;
  readonly journals: number;
}
/** The books of a seeded ladder, imported whole into the pod's log under names a pod will take. */
async function importLadder(running: Awaited<ReturnType<typeof pod>>): Promise<Rung[]> {
  const dir = option("ladder");
  if (!dir) throw new Error("--ladder DIR is needed (see the top of this file)");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    tenants: { tenantId: string; file: string; journals: number }[];
  };
  const bulk = new FileObjectStore(running.bucket);
  const rungs: Rung[] = [];
  for (const tenant of manifest.tenants.toSorted((a, b) => a.journals - b.journals)) {
    const id = `tenant_${String(tenant.journals).padStart(6, "0")}`;
    const file = join(dir, tenant.file);
    await importBookFile({
      tier: running.tail,
      bulk,
      bookId: id,
      prefix: "",
      path: file,
      schema: APPLICATION_SCHEMA,
      holder: "bench-seed",
      exclude: APPLICATION_DERIVED,
      journals: tenant.journals,
    });
    rungs.push({ id, file, journals: tenant.journals });
  }
  return rungs;
}

async function fixedCost(): Promise<void> {
  const books = Number(option("books") ?? 100);
  const drafts = Number(option("drafts") ?? 0);
  const running = await pod();
  const baseline = settled();
  console.log(`before any tenant: resident ${baseline.toFixed(0)} MB`);
  const samples: { books: number; rss: number }[] = [];
  const made: number[] = [];
  const tokens: string[] = [];
  for (let i = 1; i <= books; i += 1) {
    const started = performance.now();
    const token = await running.owner(`tenant_${String(i).padStart(6, "0")}`);
    tokens.push(token);
    const setup = await running.call(token, "book.setup", BOOK);
    if (setup.status !== 200) throw new Error(`book.setup ${setup.status}`);
    for (let j = 0; j < drafts; j += 1) await running.call(token, "drafts.create", draft(`d-${j}`));
    made.push(performance.now() - started);
    if (i % Math.max(1, Math.floor(books / 10)) === 0 || i === books)
      samples.push({ books: i, rss: settled() });
  }
  console.log("books  resident MB");
  for (const s of samples)
    console.log(`${String(s.books).padStart(5)}  ${s.rss.toFixed(0).padStart(11)}`);
  const last = samples.at(-1);
  if (last) console.log(`per warm book: ${((last.rss - baseline) / books).toFixed(2)} MB`);
  console.log(
    `make and set up one book${drafts ? ` and ${drafts} drafts` : ""}: p50 ${percentile(made, 0.5).toFixed(0)} ms, p95 ${percentile(made, 0.95).toFixed(0)} ms`,
  );
  const reads: number[] = [];
  for (let round = 0; round < 3; round += 1)
    for (const token of tokens) reads.push((await running.call(token, "book.get", {})).ms);
  console.log(
    `warm book.get across the books: p50 ${percentile(reads, 0.5).toFixed(1)} ms, p95 ${percentile(reads, 0.95).toFixed(1)} ms, p99 ${percentile(reads, 0.99).toFixed(1)} ms`,
  );
  console.log(`registry ${JSON.stringify(running.registry.stats())}`);
  const stopping = performance.now();
  await running.stop();
  console.log(`stop: ${(performance.now() - stopping).toFixed(0)} ms`);
}

async function memory(): Promise<void> {
  const running = await pod({ idleMs: 1000 });
  const rungs = await importLadder(running);
  console.log(
    "journals  cache file  resident before  after first read  delta  after closing  first read",
  );
  for (const rung of rungs) {
    const token = await running.owner(rung.id);
    await sleep(1100);
    await running.registry.sweep();
    const before = settled();
    const first = await running.call(token, "journal.list", { page: 1, status: "Posted" });
    if (first.status !== 200) throw new Error(`read ${first.status}`);
    const after = settled();
    const file = statSync(join(running.root, "cache", `${rung.id}.sqlite`)).size / MB;
    await sleep(1100);
    await running.registry.sweep();
    const closed = settled();
    console.log(
      `${String(rung.journals).padStart(8)}  ${file.toFixed(1).padStart(7)} MB  ${before.toFixed(0).padStart(11)} MB  ${after.toFixed(0).padStart(12)} MB  ${(after - before).toFixed(0).padStart(4)} MB  ${closed.toFixed(0).padStart(10)} MB  ${first.ms.toFixed(0).padStart(7)} ms`,
    );
  }
  await running.stop();
}

async function activation(): Promise<void> {
  const small = Number(option("small") ?? 30);
  const running = await pod({ idleMs: 1500 });
  const rungs = (await importLadder(running)).filter((rung) => rung.journals >= 500);
  const big = new Map<string, string>();
  for (const rung of rungs) big.set(rung.id, await running.owner(rung.id));
  await sleep(1700);
  await running.registry.sweep();
  const tokens: string[] = [];
  for (let i = 1; i <= small; i += 1) {
    const token = await running.owner(`tenant_small_${String(i).padStart(4, "0")}`);
    await running.call(token, "book.setup", BOOK);
    tokens.push(token);
  }
  console.log(
    `${small} small tenants and ${rungs.length} big books; resident ${settled().toFixed(0)} MB`,
  );

  interface Sample {
    readonly at: number;
    readonly ms: number;
  }
  const samples: Sample[] = [];
  const lags: Sample[] = [];
  let running_ = true;
  const loops = tokens.map(async (token, k) => {
    await sleep(k * 3);
    while (running_) {
      const answer = await running.call(token, "book.get", {});
      if (answer.status !== 200) throw new Error(`small tenant ${answer.status}`);
      samples.push({ at: performance.now(), ms: answer.ms });
      await sleep(8 + ((k * 7) % 13));
    }
  });
  let last = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push({ at: now, ms: now - last - 10 });
    last = now;
  }, 10);
  let peak = 0;
  const peakTimer = setInterval(() => {
    peak = Math.max(peak, rss());
  }, 25);
  const report = (label: string, from: number, to: number, extra = "") => {
    const during = samples.filter((s) => s.at >= from && s.at <= to).map((s) => s.ms);
    const lag = lags.filter((s) => s.at >= from && s.at <= to).map((s) => s.ms);
    console.log(
      `${label.padEnd(26)} small tenants n=${String(during.length).padStart(4)} p50 ${percentile(during, 0.5).toFixed(1).padStart(6)} p95 ${percentile(during, 0.95).toFixed(1).padStart(6)} p99 ${percentile(during, 0.99).toFixed(1).padStart(6)} max ${Math.max(
        ...during,
      )
        .toFixed(0)
        .padStart(4)} ms | loop lag max ${Math.max(...lag)
        .toFixed(0)
        .padStart(4)} ms | peak resident ${peak.toFixed(0)} MB ${extra}`,
    );
  };
  await sleep(1500);
  const steadyFrom = performance.now();
  await sleep(3000);
  report("steady", steadyFrom, performance.now());
  for (const rung of rungs) {
    peak = 0;
    const from = performance.now();
    const first = await running.call(big.get(rung.id) as string, "journal.list", {
      page: 1,
      status: "Posted",
    });
    const to = performance.now();
    await sleep(500);
    report(`cold ${rung.journals} journals`, from, to, `| first read ${first.ms.toFixed(0)} ms`);
  }
  await sleep(1700);
  await running.registry.sweep();
  peak = 0;
  const from = performance.now();
  const together = await Promise.all(
    rungs.map((rung) =>
      running.call(big.get(rung.id) as string, "journal.list", { page: 1, status: "Posted" }),
    ),
  );
  const to = performance.now();
  await sleep(500);
  report(
    "cold, all together",
    from,
    to,
    `| first reads ${together.map((a) => a.ms.toFixed(0)).join("/")} ms`,
  );
  running_ = false;
  await Promise.all(loops);
  clearInterval(lagTimer);
  clearInterval(peakTimer);
  console.log(`registry ${JSON.stringify(running.registry.stats())}`);
  await running.stop();
}

const commands: Record<string, () => Promise<void>> = {
  "fixed-cost": fixedCost,
  memory,
  activation,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.error(
    "usage: bun load/many-books.ts fixed-cost|memory|activation [options] (see the top of apps/api/bench/many-books.ts)",
  );
  process.exit(2);
}
await run();

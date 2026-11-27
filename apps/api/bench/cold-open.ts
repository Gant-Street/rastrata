#!/usr/bin/env bun
/** What a person waits for on the first visit to a book that the pod has not opened: the real server (apps/api/src/hosted.ts) on a memory tail and a folder for a bucket, a seeded book
 * imported into its log, the server stopped and started again with an empty cache (a pod that has just been released), and then the requests the page makes, in the order it makes them:
 * `book.get` alone first, then the panels of Home all at once. The clients are in the same process, so they share the server's one thread, as the page's requests share a pod's.
 *
 *   bun bench/cold-open.ts --ladder DIR [--journals 2000] [--replay full|trusted] [--repeat 3]
 *       a fresh process for each run; prints the time of each part and the median of the runs
 *   bun bench/cold-open.ts run --ladder DIR --journals 2000 --replay full [--calls]
 *       one run, as JSON (what the driver starts); with --calls, also what the cold open asks of the tail and of the bucket, which on the live service are calls over a network;
 *       --bucket-ms and --tail-ms make each such call take that long, as a network would (about 40 and 30 on the live service, a guess to be replaced by a measurement);
 *       --snapshot-every N makes a snapshot every N entries (the live service: 1000);
 *       --post N posts N more journals one request at a time before the server is stopped, with a pause now and then so that the log is sealed into segments, as a book that has been used
 *       is (the seeded books are imported whole and have almost no log)
 *
 * DIR is made by the seeder: `bun scripts/seed-books.ts --out DIR --tenants 1 --scale 0.01 --huge no --ladder 1000,2000`. With `--replay full` (what a pod runs) the first read of the book is
 * answered from the stored revisions and every outcome is executed again behind it (`checkMs` is how long after the last panel that check ends); with `trusted` nothing is executed again. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueOwnerKey, issueServiceKey, sha256Hex } from "@rastrata/application/agent";
import { APPLICATION_DERIVED, APPLICATION_SCHEMA } from "@rastrata/application/hosted";
import type { MemberTokenVerdict, MemberTokenVerifier } from "@rastrata/application/member-token";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { FileObjectStore, importBookFile } from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import { parseBookStore, startHostedApplicationServer } from "../src/hosted.ts";

const HOST = "app.example.test";
const args = process.argv.slice(2);
const single = args[0] === "run";
const option = (name: string, fallback?: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

/** The reads Home makes once the book has answered, as the page makes them (from a visit of 2026-11-21): the panels together. */
const PANELS = [
  "accounts.list",
  "reports.calendar",
  "reconcile.status",
  "inbox.summary",
  "bankfeed.status",
  "inbox.balanceChecks",
  "stripe.status",
  "inbox.summary",
  "book.get",
  "accounts.list",
  "inbox.summary",
  "import.history",
  "periods.list",
  "reconcile.status",
  "banks.status",
  "bankfeed.status",
  "stripe.status",
  "tokens.list",
  "changes.list",
  "cutover.checklist",
];

/** Records every call made to a store, so that what a cold open asks for can be counted. */
function watching<T extends object>(
  kind: string,
  target: T,
  into: { at: number; kind: string; what: string; ms: number }[],
  delayMs = 0,
): T {
  const describe = (given: unknown[]): string => {
    const first = given[0];
    if (typeof first === "string") return first.slice(0, 70);
    try {
      return JSON.stringify(first)?.slice(0, 70) ?? "";
    } catch {
      return "";
    }
  };
  return new Proxy(target, {
    get(self, name) {
      const value = Reflect.get(self, name, self);
      if (typeof value !== "function") return value;
      return async (...given: unknown[]) => {
        const started = performance.now();
        if (delayMs > 0) await new Promise<void>((done) => setTimeout(done, delayMs));
        const noted = () =>
          into.push({
            at: started,
            kind,
            what: `${String(name)} ${describe(given)}`,
            ms: performance.now() - started,
          });
        try {
          return await value.apply(self, given);
        } finally {
          noted();
        }
      };
    },
  }) as T;
}

async function run(): Promise<Record<string, number | string>> {
  const dir = option("ladder");
  if (!dir) throw new Error("--ladder DIR is needed (see the top of this file)");
  const journals = Number(option("journals", "2000"));
  const replay = option("replay", "full") === "trusted" ? "trusted" : "full";
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    tenants: { file: string; journals: number }[];
  };
  const seeded = manifest.tenants.find((tenant) => tenant.journals === journals);
  if (!seeded) throw new Error(`the ladder has no book of ${journals} journals`);

  const root = mkdtempSync(join(tmpdir(), "rastrata-cold-open-"));
  const ownerKey = issueOwnerKey();
  const serviceKey = issueServiceKey();
  const known = new Map<string, MemberTokenVerdict>();
  const verifier: MemberTokenVerifier = {
    verify: async (token) => known.get(token) ?? { kind: "refused" },
  };
  const tail = new MemoryLogTier();
  const bucket = join(root, "bucket");
  const calls: { at: number; kind: string; what: string; ms: number }[] = [];
  let recording = false;
  const lines: { at: number; line: string }[] = [];
  const bookId = `tenant_${String(journals).padStart(6, "0")}`;
  const start = async (cache: string) =>
    startHostedApplicationServer({
      config: parseBookStore("r2log://rastrata-main", {
        RASTRATA_BOOK_BULK: pathToFileURL(bucket).href,
        RASTRATA_BOOK_TAIL: "memory",
        RASTRATA_BOOK_CACHE: cache,
        RASTRATA_BOOK_SNAPSHOT_EVERY: option("snapshot-every", "0") as string,
      }),
      port: 0,
      telemetry: false,
      stores: recording
        ? {
            tail: watching("tail", tail, calls, Number(option("tail-ms", "0"))),
            bulk: watching(
              "bulk",
              new FileObjectStore(bucket),
              calls,
              Number(option("bucket-ms", "0")),
            ),
          }
        : { tail },
      ownerKey,
      replay,
      log: (line) => lines.push({ at: performance.now(), line }),
      serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: `https://${HOST}` },
      web: null,
      agentTokens: false,
      memberTokens: { origin: `https://${HOST}`, verifier },
      serviceKeys: [await sha256Hex(serviceKey)],
      books: {
        settings: {
          sweepMs: 0,
          maxBooks: 10_000,
          warmBudgetBytes: 100_000 * 2 ** 20,
          rate: 100_000,
          burst: 100_000,
          inflight: 1000,
        },
      },
    });
  let operations = 0;
  const call = async (base: string, credential: string, name: string, input: unknown) => {
    const started = performance.now();
    const response = await fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: HOST,
        authorization: `Bearer ${credential}`,
        "x-rastrata-book": bookId,
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        operationId: `00000000-0000-4000-8000-${String(++operations).padStart(12, "0")}`,
      }),
    });
    await response.arrayBuffer();
    return { status: response.status, ms: performance.now() - started };
  };

  // The book is imported whole into the pod's log, and the owner is put in it, by a first server that is then stopped.
  const bulk = new FileObjectStore(bucket);
  await importBookFile({
    tier: tail,
    bulk,
    bookId,
    prefix: "",
    path: join(dir, seeded.file),
    schema: APPLICATION_SCHEMA,
    holder: "bench-seed",
    exclude: APPLICATION_DERIVED,
    journals: seeded.journals,
  });
  const userId = "user_0000000001";
  const token = "aaaaaaaaaa000001.bbbbbbbbbbbb.cccccccccccc";
  known.set(token, {
    kind: "valid",
    claims: { sub: userId, wid: "wsp_0000000001", bid: bookId },
  });
  const first = await start(join(root, "cache-first"));
  const firstBase = `http://127.0.0.1:${first.server.port}`;
  const added = await call(firstBase, serviceKey, "members.add", {
    userId,
    email: `${userId}@example.com`,
    role: "owner",
  });
  if (added.status !== 200) throw new Error(`members.add ${added.status}`);
  const extra = Number(option("post", "0"));
  if (extra > 0) {
    const chart = await fetch(`${firstBase}/v1/accounts.list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: HOST,
        authorization: `Bearer ${token}`,
        "x-rastrata-book": bookId,
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input: {},
        operationId: "00000000-0000-4000-8000-0000000000aa",
      }),
    });
    const listed = (await chart.json()) as {
      data?: { accounts?: { id: string; role?: string; postable?: boolean }[] };
    };
    const accounts = listed.data?.accounts ?? [];
    const debit = accounts.find((account) => account.role === "expense")?.id ?? accounts[0]?.id;
    const credit = accounts.find((account) => account.role === "asset")?.id ?? accounts[1]?.id;
    if (!debit || !credit) throw new Error("the book has no accounts to post to");
    const posting = Date.now();
    for (let n = 1; n <= extra; n += 1) {
      const posted = await call(firstBase, token, "journal.post", {
        data: {
          date: "2026-03-02",
          reference: `b${n}`,
          narration: `b${n}`,
          lines: [
            { accountId: debit, debit: "5.00", credit: "" },
            { accountId: credit, debit: "", credit: "5.00" },
          ],
        },
      });
      if (posted.status !== 200) throw new Error(`journal.post ${posted.status} at ${n}`);
      if (n % 120 === 0) await new Promise<void>((done) => setTimeout(done, 2300));
    }
    console.error(`posted ${extra} journals in ${Math.round((Date.now() - posting) / 1000)} s`);
    await new Promise<void>((done) => setTimeout(done, 2500));
  }
  await first.stop();

  // The pod that has just been released: a new server, an empty cache, nothing in memory.
  recording = args.includes("--calls");
  const second = await start(join(root, "cache-second"));
  const opening = performance.now();
  const base = `http://127.0.0.1:${second.server.port}`;
  const began = performance.now();
  const opened = await call(base, token, "book.get", {});
  const bookGetMs = performance.now() - began;
  const burstBegan = performance.now();
  const panels = await Promise.all(PANELS.map((name) => call(base, token, name, {})));
  const burstMs = performance.now() - burstBegan;
  const lastPanelAt = performance.now();
  let checkMs: number | string = "-";
  if (replay === "full") {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const said = lines.find((entry) => entry.at >= began && entry.line.includes("was checked"));
      if (said) {
        checkMs = Math.round(said.at - lastPanelAt);
        break;
      }
      if (performance.now() > deadline) {
        checkMs = "never";
        break;
      }
      await new Promise<void>((done) => setTimeout(done, 20));
    }
  }
  if (recording) {
    const summary = (from: number, to: number) => {
      const counts = new Map<string, { n: number; ms: number }>();
      for (const call of calls.filter((entry) => entry.at >= from && entry.at < to)) {
        const key = `${call.kind} ${call.what.split(" ")[0]}`;
        const seen = counts.get(key) ?? { n: 0, ms: 0 };
        counts.set(key, { n: seen.n + 1, ms: seen.ms + call.ms });
      }
      return [...counts].map(
        ([key, value]) => `${key} x${value.n} (${value.ms.toFixed(0)} ms in all)`,
      );
    };
    console.error(
      `calls while the first book.get was answered (${bookGetMs.toFixed(0)} ms):\n  ${summary(opening, began + bookGetMs).join("\n  ")}`,
    );
    console.error(
      `calls during Home's reads and the check after them:\n  ${summary(began + bookGetMs, performance.now()).join("\n  ")}`,
    );
    console.error(
      `the first calls of the cold open:\n  ${calls
        .filter((entry) => entry.at >= opening)
        .slice(0, 14)
        .map(
          (entry) =>
            `${(entry.at - opening).toFixed(0).padStart(5)} ms  ${entry.kind} ${entry.what} (${entry.ms.toFixed(1)} ms)`,
        )
        .join("\n  ")}`,
    );
  }
  const sorted = panels.map((panel) => panel.ms).sort((a, b) => a - b);
  const statuses = [...new Set([opened.status, ...panels.map((panel) => panel.status)])].join(",");
  await second.stop();
  rmSync(root, { recursive: true, force: true });
  return {
    journals,
    replay,
    bookGetMs: Math.round(bookGetMs),
    burstMs: Math.round(burstMs),
    toLastPanelMs: Math.round(bookGetMs + burstMs),
    panelMedianMs: Math.round(sorted[Math.floor(sorted.length / 2)] as number),
    panelSlowestMs: Math.round(sorted.at(-1) as number),
    checkAfterLastPanelMs: checkMs,
    statuses,
  };
}

if (single) {
  console.log(JSON.stringify(await run()));
  process.exit(0);
}

// The driver: a fresh process for each run, since a first request is a first request only once in a process.
const repeat = Number(option("repeat", "3"));
const modes = (option("replay") ?? "full,trusted").split(",");
const results: Record<string, Record<string, number | string>[]> = {};
for (const mode of modes) {
  results[mode] = [];
  for (let n = 0; n < repeat; n += 1) {
    const child = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        "run",
        "--ladder",
        option("ladder") as string,
        "--journals",
        option("journals", "2000") as string,
        "--replay",
        mode,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const out = await new Response(child.stdout).text();
    await child.exited;
    const line = out.trim().split("\n").at(-1) ?? "";
    try {
      const run = JSON.parse(line) as Record<string, number | string>;
      results[mode]?.push(run);
      console.log(
        `${mode.padEnd(8)} book.get ${String(run.bookGetMs).padStart(5)} ms, panels ${String(run.burstMs).padStart(5)} ms (median ${run.panelMedianMs}, slowest ${run.panelSlowestMs}), to the last panel ${String(run.toLastPanelMs).padStart(5)} ms, check ends ${run.checkAfterLastPanelMs} ms after, statuses ${run.statuses}`,
      );
    } catch {
      console.log(`${mode}: no result\n${out}`);
    }
  }
}

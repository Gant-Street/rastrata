/** E3: how long does a cold book take to be ready, and how much memory does it need?
 *
 * A book of N journals is seeded as a closed file, imported into a log (a base snapshot, then a sealed
 * segment of later entries, then a tail), and a fresh process then does what a pod does when a person
 * signs in to a book it does not hold: take the lease, download and unpack the snapshot, apply the
 * entries after it, build the application, and answer the first requests (book.get, which reads the
 * ledger; the journal list; a report). Each measurement is a process of its own, so the heap is
 * clean and the peak resident memory is the activation's.
 *
 *   bun experiments/e3-activation.ts seed --dir /tmp/e3 --sizes 500,2000,5000,20000
 *   bun experiments/e3-activation.ts run  --dir /tmp/e3 --sizes 500,2000,5000,20000 --reps 3 [--container] [--first list|report] [--json out]
 *   bun experiments/e3-activation.ts report --json out          (print the table again from a saved run)
 *
 * What the table says: "storage ready" is the book open and `book.get` answered (download, unpack, apply the
 * entries after the snapshot, build the application); "first read" is the first request that needs the
 * ledger's read model (the journal list, or with `--first report` a report), which replays every journal in
 * the process once; "activation" is the two together, which is when a person's first screen can be drawn.
 *
 * `--store file` (the default) keeps the bucket in `--dir`, so the download is a file read and the
 * figures are the compute and memory of a cold start; `--store minio` keeps it in the local MinIO, so the
 * download is an HTTP GET of the same bytes (set BOOKLOG_MINIO_* as for E1). Add the time to move the
 * snapshot's bytes from the bucket to the pod to the "ready" figure: the table prints the bytes.
 *
 * With and without the failed snapshot attempt (the application's own `snapshots` setting): left on, a
 * cold read of a book between about 1,600 and 10,000 journals makes one attempt to encode a state past
 * the kernel's 16 MiB cap, which fails after allocating hundreds of megabytes.
 *
 * Pass: 5,000 journals ready (activation, as above) in at most 3 s with at most 1 GiB peak, on arm64 (a Linux container on this
 * machine stands in for a pod). Fallback: rework snapshots, add the in-region cache, or bring the read
 * model forward. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBookService } from "@rastrata/application/local";
import { BULK_BOOK, postBulk } from "@rastrata/application/testing/bulk-book";
import { importBookFile } from "../src/import.ts";
import { MeteredObjectStore } from "../src/metered.ts";
import type { ObjectStore } from "../src/objectstore.ts";
import { S3ObjectStore } from "../src/s3.ts";
import { FileObjectStore } from "../src/store-file.ts";
import { ObjectStoreLogTier } from "../src/tier-objects.ts";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  callOperation,
  openHostedApplication,
} from "../test/support/app.ts";
import { ensureBucket, machine, minioEnv, parseArgs, printTable, quantile } from "./lib.ts";

const PREFIX = "e3/";

type StoreKind = "file" | "minio";

function bucket(kind: StoreKind, dir: string): MeteredObjectStore {
  let inner: ObjectStore;
  if (kind === "minio") {
    const env = minioEnv();
    inner = new S3ObjectStore({
      endpoint: env.endpoint,
      bucket: env.bucket,
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
      region: "us-east-1",
    });
  } else inner = new FileObjectStore(join(dir, "bucket"));
  return new MeteredObjectStore(inner, { keepSamples: false });
}

async function seed(
  kind: StoreKind,
  dir: string,
  sizes: readonly number[],
  tailEntries: number,
): Promise<void> {
  if (kind === "minio") await ensureBucket(minioEnv());
  const bulk = bucket(kind, dir);
  const tier = new ObjectStoreLogTier(bulk, { prefix: PREFIX });
  for (const size of sizes) {
    const bookId = `j${size}`;
    const work = mkdtempSync(join(tmpdir(), `e3-seed-${size}-`));
    try {
      const file = join(work, "book.sqlite");
      const started = performance.now();
      const service = await LocalBookService.open(file, {
        safety: false,
        snapshots: false,
        prepareSlices: true,
      });
      await service.setup(BULK_BOOK);
      await postBulk(service, size);
      service.close();
      const built = performance.now() - started;
      const imported = await importBookFile({
        tier,
        bulk,
        bookId,
        prefix: PREFIX,
        path: file,
        schema: APPLICATION_SCHEMA,
        exclude: APPLICATION_DERIVED,
        journals: size,
      });
      // Later entries: the book is used for a while (postings by hand), sealed, and used a little more.
      const cache = join(work, "cache.sqlite");
      const writer = await openHostedApplication({
        tier,
        bulk,
        bookId,
        prefix: PREFIX,
        holder: "e3-seed",
        path: cache,
        sealing: { delayMs: 0 },
      });
      const post = async (n: number) => {
        const draft = (
          await callOperation(writer, "drafts.create", {
            data: {
              date: `2026-03-${String(1 + (n % 27)).padStart(2, "0")}`,
              reference: `e3-${n}`,
              narration: `Entry ${n}`,
              lines: [
                { accountId: "5000", debit: `${10 + n}.00`, credit: "" },
                { accountId: "1000", debit: "", credit: `${10 + n}.00` },
              ],
            },
          })
        ).body.data;
        const plan = (
          await callOperation(writer, "journal.prepare", {
            draftId: draft.id,
            expectedVersion: draft.version,
          })
        ).body.data;
        await callOperation(writer, "operations.commit", {
          planId: plan.planId,
          planHash: plan.planHash,
        });
      };
      const third = Math.max(1, Math.floor(tailEntries / 3));
      for (let n = 1; n <= third; n += 1) await post(n);
      await writer.runtime.sealNow();
      for (let n = 1000; n < 1000 + Math.max(1, Math.floor(third / 2)); n += 1) await post(n);
      const head = writer.runtime.head.seq;
      await writer.close({ seal: false });
      rmSync(cache, { force: true });
      console.log(
        `seeded ${bookId}: file ${(statSync(file).size / 1e6).toFixed(1)} MB, snapshot ${(imported.bytes / 1e6).toFixed(1)} MB gz, built in ${(built / 1000).toFixed(1)} s, imported in ${(imported.milliseconds / 1000).toFixed(1)} s, then ${head - 1} entries (about two thirds sealed)`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

interface ChildResult {
  readonly size: number;
  readonly attempt: boolean;
  readonly first?: "list" | "report";
  readonly ms: {
    readonly open: number;
    readonly bookGet: number;
    readonly journalList: number;
    readonly report: number;
    readonly ready: number;
  };
  readonly activation: {
    readonly source: string;
    readonly snapshotBytes: number;
    readonly rawBytes: number;
    readonly entriesApplied: number;
    readonly ms: {
      readonly download: number;
      readonly unpack: number;
      readonly open: number;
      readonly apply: number;
      readonly log: number;
      readonly total: number;
    };
  };
  readonly store: { readonly classB: number; readonly bytesOut: number };
  readonly peakRssMb: number;
  readonly endRssMb: number;
  readonly journals: number;
}

/** Peak resident memory of this process, in MB. Linux says it in /proc (VmHWM, kB) and in ru_maxrss
 * (kB); macOS says it in ru_maxrss in bytes. */
function peakRssMb(): number {
  try {
    const text = readFileSync("/proc/self/status", "utf8");
    const kb = Number(/VmHWM:\s+(\d+) kB/.exec(text)?.[1] ?? 0);
    if (kb > 0) return kb / 1024;
  } catch {
    // not Linux
  }
  const usage = process.resourceUsage().maxRSS;
  return usage > 1e8 ? usage / 1e6 : usage / 1024;
}

async function child(
  kind: StoreKind,
  dir: string,
  size: number,
  attempt: boolean,
  first: "list" | "report",
): Promise<void> {
  const bulk = bucket(kind, dir);
  const tier = new ObjectStoreLogTier(bulk, { prefix: PREFIX });
  const work = mkdtempSync(join(tmpdir(), "e3-cache-"));
  const t0 = performance.now();
  const book = await openHostedApplication({
    tier,
    bulk,
    bookId: `j${size}`,
    prefix: PREFIX,
    holder: `e3-child-${process.pid}`,
    path: join(work, "cache.sqlite"),
    sealing: { delayMs: 0 },
    applicationSnapshots: attempt,
  });
  const opened = performance.now();
  const got = await callOperation(book, "book.get", {});
  const gotBook = performance.now();
  const ask = {
    list: () => callOperation(book, "journal.list", { page: 1, status: "Posted" }),
    report: () => callOperation(book, "reports.get", { asOf: "2026-12-31" }),
  };
  // The first of the two pays for the replay; the second shows what it left behind.
  const order = first === "list" ? (["list", "report"] as const) : (["report", "list"] as const);
  const firstReply = await ask[order[0]]();
  const firstDone = performance.now();
  const secondReply = await ask[order[1]]();
  const secondDone = performance.now();
  if (got.status !== 200 || firstReply.status !== 200 || secondReply.status !== 200)
    throw new Error(
      `A first request failed: ${got.status} ${firstReply.status} ${secondReply.status}`,
    );
  const list = order[0] === "list" ? firstReply : secondReply;
  const stats = book.runtime.stats.activation;
  if (!stats) throw new Error("The book reports no activation");
  const counts = bulk.counts;
  const result: ChildResult = {
    size,
    attempt,
    first,
    ms: {
      open: opened - t0,
      bookGet: gotBook - opened,
      // The first aggregate read, whichever it was, and the second.
      journalList: firstDone - gotBook,
      report: secondDone - firstDone,
      ready: gotBook - t0,
    },
    activation: {
      source: stats.source,
      snapshotBytes: stats.snapshotBytes,
      rawBytes: stats.rawBytes,
      entriesApplied: stats.entriesApplied,
      ms: stats.ms,
    },
    store: { classB: counts.classB, bytesOut: counts.bytesOut },
    peakRssMb: peakRssMb(),
    endRssMb: process.memoryUsage().rss / 1e6,
    journals: Number(list.body?.data?.count ?? 0),
  };
  process.stdout.write(`CHILD ${JSON.stringify(result)}\n`);
  await book.close({ seal: false, release: false }).catch(() => {});
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

function runChild(options: {
  readonly kind: StoreKind;
  readonly dir: string;
  readonly size: number;
  readonly attempt: boolean;
  readonly first: "list" | "report";
  readonly container: boolean;
  readonly cpus: string;
  readonly memory: string;
}): ChildResult {
  const args = [
    "child",
    "--store",
    options.kind,
    "--dir",
    options.container ? "/data" : options.dir,
    "--size",
    String(options.size),
    "--attempt",
    options.attempt ? "on" : "off",
    "--first",
    options.first,
  ];
  const script = resolve(import.meta.dir, "e3-activation.ts");
  const repo = resolve(import.meta.dir, "../../..");
  const command = options.container
    ? [
        "docker",
        "run",
        "--rm",
        "--platform",
        "linux/arm64",
        "--cpus",
        options.cpus,
        "--memory",
        options.memory,
        "-v",
        `${repo}:/repo:ro`,
        "-v",
        `${options.dir}:/data:ro`,
        "-w",
        "/repo/packages/booklog",
        "oven/bun:1.4.2",
        "bun",
        "/repo/packages/booklog/experiments/e3-activation.ts",
        ...args,
      ]
    : [process.execPath, script, ...args];
  const run = spawnSync(command[0] as string, command.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (run.stdout ?? "").split("\n").find((item) => item.startsWith("CHILD "));
  if (!line)
    throw new Error(
      `The measurement produced no result (${run.status}): ${(run.stderr ?? "").slice(-800)}`,
    );
  return JSON.parse(line.slice(6)) as ChildResult;
}

const median = (values: number[]): number =>
  quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );

async function main(): Promise<void> {
  const args = parseArgs();
  const mode = process.argv[2];
  const kind = args.string("store", "file") as StoreKind;
  const dir = resolve(args.string("dir", join(tmpdir(), "e3")));
  const sizes = args.string("sizes", "500,2000,5000,20000").split(",").map(Number);
  if (mode === "seed") {
    mkdirSync(dir, { recursive: true });
    await seed(kind, dir, sizes, args.number("tail", 60));
    return;
  }
  if (mode === "child") {
    await child(
      kind,
      dir,
      args.number("size", 500),
      args.string("attempt", "off") === "on",
      args.string("first", "list") === "report" ? "report" : "list",
    );
    return;
  }
  if (mode === "report") {
    const loaded = JSON.parse(readFileSync(args.string("json", ""), "utf8")) as {
      container: boolean;
      store: StoreKind;
      reps: number;
      results: ChildResult[];
    };
    summarise(loaded.results, loaded.container, loaded.store, loaded.reps);
    return;
  }
  const reps = args.number("reps", 3);
  const container = args.has("container");
  const first = args.string("first", "list") === "report" ? "report" : "list";
  const all: ChildResult[] = [];
  for (const size of sizes)
    for (const attempt of [false, true])
      for (let rep = 0; rep < reps; rep += 1)
        all.push(
          runChild({
            kind,
            dir,
            size,
            attempt,
            first,
            container,
            cpus: args.string("cpus", "1"),
            memory: args.string("memory", "2g"),
          }),
        );
  summarise(all, container, kind, reps);
  const json = args.string("json", "");
  if (json)
    writeFileSync(
      json,
      `${JSON.stringify({ container, store: kind, reps, machine: machine(), results: all }, null, 2)}\n`,
    );
}

/** The table: medians over the runs of each size, and the worst where a limit is at stake. */
function summarise(all: ChildResult[], container: boolean, kind: StoreKind, reps: number): void {
  const groups = new Map<string, ChildResult[]>();
  for (const run of all) {
    const key = `${run.size}/${run.attempt}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const rows: (string | number)[][] = [];
  for (const runs of groups.values()) {
    const head = runs[0] as ChildResult;
    const total = (run: ChildResult) => run.ms.ready + run.ms.journalList;
    rows.push([
      head.size,
      head.attempt ? "on" : "off",
      Math.round(median(runs.map((run) => run.ms.ready))),
      Math.round(median(runs.map((run) => run.ms.journalList))),
      Math.round(median(runs.map(total))),
      Math.round(Math.max(...runs.map(total))),
      (median(runs.map((run) => run.ms.journalList)) / head.size).toFixed(2),
      Math.round(median(runs.map((run) => run.ms.report))),
      Math.round(Math.max(...runs.map((run) => run.peakRssMb))),
      `${Math.round(median(runs.map((run) => run.activation.ms.download)))} / ${Math.round(median(runs.map((run) => run.activation.ms.unpack)))} / ${Math.round(median(runs.map((run) => run.activation.ms.apply)))}`,
      head.activation.entriesApplied,
      (head.activation.snapshotBytes / 1e6).toFixed(1),
    ]);
  }
  console.log(
    `\nE3: cold activation${container ? " in a linux/arm64 container" : " on this machine"}, ${kind} bucket, ${reps} runs each (medians; worst and peak are the largest). ${JSON.stringify(machine())}`,
  );
  printTable(
    [
      "journals",
      "snapshot attempt",
      "storage ready ms (open + book.get)",
      "first read ms",
      "activation ms (median)",
      "activation ms (worst)",
      "first read ms / journal",
      "second read ms",
      "peak RSS MB",
      "download / unpack / apply ms",
      "entries applied",
      "snapshot MB (gz)",
    ],
    rows,
  );
}

await main();

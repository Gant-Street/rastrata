/** E4, the other half: a node drain with every tenant cold-loading. One pod (a process, in a container with
 * a memory limit when `--container` is given) is asked for every tenant it serves at once, as a pod is
 * after the node under it was drained, and the cold loads are either let go all together or held
 * back by the activation limiter (a few at a time, in order, within a memory budget).
 *
 *   bun experiments/e4-drain.ts seed --dir /tmp/e4d [--mix 500:20,2000:10,5000:4,20000:1]
 *   bun experiments/e4-drain.ts run  --dir /tmp/e4d [--container] [--memory 2g] [--cpus 2] [--budget-mb 1024] [--concurrent 4] [--json out]
 *
 * Three arrangements are run: every load let go at once; the limiter, in the order the tenants happened
 * to ask; and the limiter with the smallest book admitted first and the memory of a finished load given
 * back before the next starts (a finished load keeps its memory until the collector returns it, so loads
 * add up whatever the order unless it is collected between them).
 *
 * "Ready" for a tenant is its book open and its first request that needs the ledger's read model (the
 * journal list) answered, which is where most of a cold load's memory goes; measured from the moment the
 * pod was asked. Pass (the proof plan): cold loads capped (the pod stays inside its memory and is not
 * killed), and the tenants a person is waiting for ready within 10 s. Fallback: fix the limiter. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBookService } from "@rastrata/application/local";
import { BULK_BOOK, postBulk } from "@rastrata/application/testing/bulk-book";
import { importBookFile } from "../src/import.ts";
import { ActivationLimiter, estimateActivationBytes } from "../src/limiter.ts";
import { MeteredObjectStore } from "../src/metered.ts";
import { FileObjectStore } from "../src/store-file.ts";
import { ObjectStoreLogTier } from "../src/tier-objects.ts";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  callOperation,
  openHostedApplication,
} from "../test/support/app.ts";
import { Rng } from "../src/rng.ts";
import { machine, parseArgs, printTable, quantile } from "./lib.ts";

const PREFIX = "e4d/";
const DEFAULT_MIX = "500:20,2000:10,5000:4,20000:1";

interface Tenant {
  readonly id: string;
  readonly size: number;
}

const tenantsOf = (mix: string): Tenant[] =>
  mix.split(",").flatMap((part) => {
    const [size, count] = part.split(":").map(Number) as [number, number];
    return Array.from({ length: count }, (_, index) => ({ id: `d${size}-${index}`, size }));
  });

async function seed(dir: string, mix: string): Promise<void> {
  const bulk = new MeteredObjectStore(new FileObjectStore(join(dir, "bucket")), {
    keepSamples: false,
  });
  const tier = new ObjectStoreLogTier(bulk, { prefix: PREFIX });
  const tenants = tenantsOf(mix);
  for (const size of [...new Set(tenants.map((tenant) => tenant.size))]) {
    const work = mkdtempSync(join(tmpdir(), `e4d-seed-${size}-`));
    try {
      const file = join(work, "book.sqlite");
      const service = await LocalBookService.open(file, {
        safety: false,
        snapshots: false,
        prepareSlices: true,
      });
      await service.setup(BULK_BOOK);
      await postBulk(service, size);
      service.close();
      const started = performance.now();
      let imported = 0;
      for (const tenant of tenants.filter((item) => item.size === size)) {
        await importBookFile({
          tier,
          bulk,
          bookId: tenant.id,
          prefix: PREFIX,
          path: file,
          schema: APPLICATION_SCHEMA,
          exclude: APPLICATION_DERIVED,
          journals: size,
        });
        imported += 1;
      }
      console.log(
        `seeded ${imported} tenants of ${size} journals in ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

interface Arrangement {
  readonly name: string;
  readonly limiter: boolean;
  readonly order: "random" | "smallest-first";
  readonly gc: boolean;
}

const ARRANGEMENTS: readonly Arrangement[] = [
  { name: "all at once", limiter: false, order: "random", gc: false },
  { name: "limiter, asked order", limiter: true, order: "random", gc: false },
  {
    name: "limiter, smallest first, collect between",
    limiter: true,
    order: "smallest-first",
    gc: true,
  },
];

interface ChildResult {
  readonly arrangement: string;
  readonly tenants: { readonly id: string; readonly size: number; readonly readyMs: number }[];
  readonly totalMs: number;
  readonly peakRssMb: number;
  readonly limiterStats: unknown;
  readonly failed: string[];
}

function peakRssMb(): number {
  try {
    const kb = Number(
      /VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? 0,
    );
    if (kb > 0) return kb / 1024;
  } catch {
    // not Linux
  }
  return process.resourceUsage().maxRSS / 1024;
}

async function child(options: {
  readonly dir: string;
  readonly mix: string;
  readonly arrangement: Arrangement;
  readonly budgetMb: number;
  readonly concurrent: number;
}): Promise<void> {
  const bulk = new MeteredObjectStore(new FileObjectStore(join(options.dir, "bucket")), {
    keepSamples: false,
  });
  const tier = new ObjectStoreLogTier(bulk, { prefix: PREFIX });
  const { arrangement } = options;
  const limiter = arrangement.limiter
    ? new ActivationLimiter({
        maxConcurrent: options.concurrent,
        memoryBudgetBytes: options.budgetMb * 2 ** 20,
      })
    : null;
  let tenants = tenantsOf(options.mix);
  // The order the pod is asked in: every tenant at once, so only the order of arrival differs.
  if (arrangement.order === "smallest-first") tenants = tenants.sort((a, b) => a.size - b.size);
  else {
    const rng = new Rng(7);
    tenants = tenants
      .map((tenant) => ({ tenant, key: rng.next() }))
      .sort((a, b) => a.key - b.key)
      .map((item) => item.tenant);
  }
  const work = mkdtempSync(join(tmpdir(), "e4d-cache-"));
  const t0 = performance.now();
  const failed: string[] = [];
  const results = await Promise.all(
    tenants.map(async (tenant) => {
      const load = async () => {
        const book = await openHostedApplication({
          tier,
          bulk,
          bookId: tenant.id,
          prefix: PREFIX,
          holder: `e4d-${process.pid}-${tenant.id}`,
          path: join(work, `${tenant.id}.sqlite`),
          sealing: { delayMs: 0 },
        });
        const answer = await callOperation(book, "journal.list", { page: 1, status: "Posted" });
        if (answer.status !== 200) throw new Error(`journal.list answered ${answer.status}`);
        return book;
      };
      try {
        // What a load is expected to need, from what the pod knows of the book before it reads it.
        const estimate = estimateActivationBytes({
          journals: tenant.size,
          snapshotBytes: tenant.size * 1560,
          rawBytes: tenant.size * 7000,
        });
        const guarded = async () => {
          const book = await load();
          // The pod keeps the book; a load that is over has its working memory collected before the next.
          if (arrangement.gc) Bun.gc(true);
          return book;
        };
        const book = limiter ? await limiter.run(estimate, guarded) : await load();
        const readyMs = performance.now() - t0;
        await book.close({ seal: false, release: false }).catch(() => {});
        return { id: tenant.id, size: tenant.size, readyMs };
      } catch (error) {
        failed.push(`${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { id: tenant.id, size: tenant.size, readyMs: Number.NaN };
      }
    }),
  );
  const result: ChildResult = {
    arrangement: arrangement.name,
    tenants: results,
    totalMs: performance.now() - t0,
    peakRssMb: peakRssMb(),
    limiterStats: limiter?.stats ?? null,
    failed,
  };
  process.stdout.write(`CHILD ${JSON.stringify(result)}\n`);
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

interface Outcome {
  readonly arrangement: string;
  readonly killed: boolean;
  readonly status: number | null;
  readonly result: ChildResult | null;
  readonly stderr: string;
}

function runChild(options: {
  readonly dir: string;
  readonly mix: string;
  readonly arrangement: Arrangement;
  readonly budgetMb: number;
  readonly concurrent: number;
  readonly container: boolean;
  readonly cpus: string;
  readonly memory: string;
}): Outcome {
  const args = [
    "child",
    "--dir",
    options.container ? "/data" : options.dir,
    "--mix",
    options.mix,
    "--arrangement",
    String(ARRANGEMENTS.indexOf(options.arrangement)),
    "--budget-mb",
    String(options.budgetMb),
    "--concurrent",
    String(options.concurrent),
  ];
  const script = resolve(import.meta.dir, "e4-drain.ts");
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
        "--memory-swap",
        options.memory,
        "-v",
        `${repo}:/repo:ro`,
        "-v",
        `${options.dir}:/data:ro`,
        "-w",
        "/repo/packages/booklog",
        "oven/bun:1.4.2",
        "bun",
        "/repo/packages/booklog/experiments/e4-drain.ts",
        ...args,
      ]
    : [process.execPath, script, ...args];
  const run = spawnSync(command[0] as string, command.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (run.stdout ?? "").split("\n").find((item) => item.startsWith("CHILD "));
  return {
    arrangement: options.arrangement.name,
    // Docker reports a container killed for memory as 137.
    killed: !line && (run.status === 137 || run.signal !== null),
    status: run.status,
    result: line ? (JSON.parse(line.slice(6)) as ChildResult) : null,
    stderr: (run.stderr ?? "").slice(-600),
  };
}

const quantileOf = (values: number[], p: number): number =>
  quantile(
    values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b),
    p,
  );

async function main(): Promise<void> {
  const args = parseArgs();
  const mode = process.argv[2];
  const dir = resolve(args.string("dir", join(tmpdir(), "e4d")));
  const mix = args.string("mix", DEFAULT_MIX);
  if (mode === "seed") {
    mkdirSync(dir, { recursive: true });
    await seed(dir, mix);
    return;
  }
  if (mode === "child") {
    await child({
      dir,
      mix,
      arrangement: ARRANGEMENTS[args.number("arrangement", 0)] as Arrangement,
      budgetMb: args.number("budget-mb", 1024),
      concurrent: args.number("concurrent", 4),
    });
    return;
  }
  const container = args.has("container");
  const outcomes: Outcome[] = [];
  for (const arrangement of ARRANGEMENTS)
    outcomes.push(
      runChild({
        dir,
        mix,
        arrangement,
        budgetMb: args.number("budget-mb", 1024),
        concurrent: args.number("concurrent", 4),
        container,
        cpus: args.string("cpus", "2"),
        memory: args.string("memory", "2g"),
      }),
    );
  console.log(
    `\nE4: a node drain, ${tenantsOf(mix).length} tenants (${mix}) asked for at once${container ? ` in a linux/arm64 container (${args.string("cpus", "2")} cpus, ${args.string("memory", "2g")})` : " on this machine"}. ${JSON.stringify(machine())}`,
  );
  const rows: (string | number)[][] = [];
  for (const outcome of outcomes) {
    const result = outcome.result;
    if (!result) {
      rows.push([
        outcome.arrangement,
        outcome.killed ? "KILLED (out of memory)" : `no result (${outcome.status})`,
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
      continue;
    }
    const readies = result.tenants.map((tenant) => tenant.readyMs);
    const within = readies.filter((value) => value <= 10_000).length;
    rows.push([
      outcome.arrangement,
      `${result.tenants.length - result.failed.length} / ${result.tenants.length}`,
      Math.round(result.totalMs),
      Math.round(quantileOf(readies, 0.5)),
      Math.round(quantileOf(readies, 0.95)),
      `${within} / ${result.tenants.length}`,
      Math.round(result.peakRssMb),
      JSON.stringify(result.limiterStats ?? {}),
    ]);
  }
  printTable(
    [
      "arrangement",
      "ready",
      "all ready ms",
      "median ms",
      "p95 ms",
      "ready within 10 s",
      "peak RSS MB",
      "limiter stats",
    ],
    rows,
  );
  // By size class, in the last arrangement.
  const last = outcomes[outcomes.length - 1]?.result;
  if (last) {
    const sizes = [...new Set(last.tenants.map((tenant) => tenant.size))].sort((a, b) => a - b);
    printTable(
      ["journals", "tenants", "median ready ms", "slowest ready ms"],
      sizes.map((size) => {
        const readies = last.tenants.filter((tenant) => tenant.size === size).map((t) => t.readyMs);
        return [
          size,
          readies.length,
          Math.round(quantileOf(readies, 0.5)),
          Math.round(Math.max(...readies)),
        ];
      }),
    );
  }
  const json = args.string("json", "");
  if (json)
    writeFileSync(
      json,
      `${JSON.stringify({ container, mix, machine: machine(), outcomes }, null, 2)}\n`,
    );
}

await main();

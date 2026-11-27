/** E1, per tail: what an append, a lease and a read cost, from wherever this runs.
 *
 *   bun experiments/e1-tiers.ts --tier postgres|r2|minio|memory [--samples 300] [--json path] [--ledger path]
 *
 * The commit threshold is p95 at most 100 ms (target 30 ms). A commit on a tail with leases is one
 * append (a read under a valid lease needs no remote call); on a tail without leases (objects in the
 * bulk store) it is the append plus the freshness check that every read must make. A Postgres in a
 * container on this machine's VM measures the protocol's cost on that database, not the cluster's
 * network: the in-cluster number is the one to decide on. */
import { createHash, randomBytes } from "node:crypto";
import { GENESIS_HASH } from "../src/tier.ts";
import {
  SUMMARY_HEADERS,
  machine,
  newRunId,
  openTier,
  parseArgs,
  printTable,
  record,
  summarize,
  summaryRow,
  type TierKind,
} from "./lib.ts";

const args = parseArgs();
const kind = args.string("tier", "postgres") as TierKind;
const samples = args.number("samples", kind === "r2" ? 100 : 300);
const THRESHOLD_MS = 100;

const opened = await openTier(kind, { runId: args.string("run", newRunId()) });
if ("skipped" in opened) {
  console.log(JSON.stringify({ experiment: "E1-tiers", tier: kind, skipped: opened.skipped }));
  process.exit(0);
}
const { handle } = opened;
const { tier } = handle;
const leases = tier.capabilities.leases;
const book = (name: string) => `e1-${handle.runId.slice(-6)}-${name}`;

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, (performance.now() - started) / 1000];
}
const hash = (seq: number, prev: string) =>
  createHash("sha256").update(`${seq}:${prev}`).digest("hex");

// ---- append, then commit (append plus whatever a read must also ask) ---------------------------
const bookA = book("append");
const grant = await tier.acquire(bookA, "e1-holder", 600_000);
if (!grant.ok) throw new Error("no lease");
const fence = grant.lease.fence;
const body = new Uint8Array(randomBytes(2048));
const appendTimes: number[] = [];
const commitTimes: number[] = [];
let prev = GENESIS_HASH;
for (let seq = 1; seq <= samples; seq += 1) {
  const next = hash(seq, prev);
  const [result, seconds] = await timed(() =>
    tier.append(bookA, { seq, prevHash: prev, hash: next, fence, body }),
  );
  if (!result.ok) throw new Error(`append ${seq} refused: ${result.reason}`);
  prev = next;
  appendTimes.push(seconds);
  // On a tail without leases the next read has to ask whether anything is newer; the commit that
  // makes the next request fast includes that check.
  if (!leases) {
    const [, extra] = await timed(() => tier.head(bookA));
    commitTimes.push(seconds + extra);
  } else commitTimes.push(seconds);
}

// ---- reads ------------------------------------------------------------------------------------------
const headTimes: number[] = [];
const readOne: number[] = [];
const readFifty: number[] = [];
for (let index = 0; index < samples; index += 1) {
  headTimes.push((await timed(() => tier.head(bookA)))[1]);
  readOne.push((await timed(() => tier.readFrom(bookA, samples, 1)))[1]);
  if (index < Math.ceil(samples / 3))
    readFifty.push((await timed(() => tier.readFrom(bookA, 1, 50)))[1]);
}

// ---- leases -------------------------------------------------------------------------------------------
const acquireNew: number[] = [];
const acquireAgain: number[] = [];
const renew: number[] = [];
const takeover: number[] = [];
const release: number[] = [];
if (leases) {
  for (let index = 0; index < samples; index += 1) {
    const b = book(`lease-${index}`);
    const [first, firstTime] = await timed(() => tier.acquire(b, "holder-a", 30_000));
    acquireNew.push(firstTime);
    if (!first.ok) throw new Error("no lease");
    acquireAgain.push((await timed(() => tier.acquire(b, "holder-a", 30_000)))[1]);
    renew.push(
      (
        await timed(() => tier.renew(b, { holder: "holder-a", fence: first.lease.fence }, 30_000))
      )[1],
    );
    release.push(
      (await timed(() => tier.release(b, { holder: "holder-a", fence: first.lease.fence })))[1],
    );
    takeover.push((await timed(() => tier.acquire(b, "holder-b", 30_000)))[1]);
  }
}

const stores = handle.stores();
const classA = stores.reduce((sum, s) => sum + s.counts.classA, 0);
const classB = stores.reduce((sum, s) => sum + s.counts.classB, 0);
await handle.cleanup();

const rows: (readonly [string, number[]])[] = [
  ["append (2 KiB entry)", appendTimes],
  [
    leases ? "COMMIT = append (reads need no check)" : "COMMIT = append + freshness HEAD",
    commitTimes,
  ],
  ["head", headTimes],
  ["read 1 entry", readOne],
  ["read 50 entries", readFifty],
  ...(leases
    ? ([
        ["lease acquire (new book)", acquireNew],
        ["lease acquire (same holder, inside lease)", acquireAgain],
        ["lease renew", renew],
        ["lease release", release],
        ["lease takeover after release", takeover],
      ] as const)
    : []),
];
const summaries = rows.map(([label, values]) => [label, summarize(values)] as const);
const commit = summarize(commitTimes);
const result = {
  experiment: "E1-tiers",
  tier: kind,
  runId: handle.runId,
  environment: { ...machine(), tail: handle.description },
  samples,
  results: Object.fromEntries(
    summaries.map(([label, summary]) => [
      label,
      Object.fromEntries(
        Object.entries(summary).map(([name, value]) => [
          name,
          name === "n" ? value : Math.round(value * 1000 * 100) / 100,
        ]),
      ),
    ]),
  ),
  commit: {
    p95LimitMs: THRESHOLD_MS,
    p50Ms: Math.round(commit.p50 * 1000 * 10) / 10,
    p95Ms: Math.round(commit.p95 * 1000 * 10) / 10,
    p99Ms: Math.round(commit.p99 * 1000 * 10) / 10,
    pass: commit.p95 * 1000 <= THRESHOLD_MS,
  },
  operations: { classA, classB },
};

console.log(`\nE1 per tail: ${kind} (${handle.runId}), ${samples} samples a cell`);
printTable(
  SUMMARY_HEADERS,
  summaries.map(([label, summary]) => summaryRow(label, summary)),
);
console.log(
  `\ncommit p95 ${result.commit.p95Ms} ms against the limit of ${THRESHOLD_MS} ms: ${result.commit.pass ? "within" : "OVER"}${kind === "postgres" ? " (a container on this machine's VM, not the cluster's network)" : ""}`,
);
if (classA + classB > 0)
  console.log(`object store operations: ${classA} Class A, ${classB} Class B`);
console.log(`\nJSON: ${JSON.stringify(result)}`);
record("E1-tiers", result, {
  ...(args.has("json") ? { out: args.string("json", "") } : {}),
  ...(args.has("ledger") ? { ledger: args.string("ledger", "") } : {}),
  counts: { classA, classB },
});

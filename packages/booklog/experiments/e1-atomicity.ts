/** E1: does a create-only write behave atomically on the store, does a lost response get resolved by
 * reading the object back, and what do PUT, HEAD, GET and LIST cost, on a reused and on a new
 * connection, and what does a commit (the entry PUT plus the freshness HEAD) cost end to end?
 *
 *   bun experiments/e1-atomicity.ts --target memory|minio|r2 [--writers 20] [--rounds 50]
 *       [--lost 100] [--samples 200] [--modes reused,fresh] [--run <id>] [--json path] [--ledger path]
 *
 * Pass: exactly one writer wins every round and the losers see 412; every lost response is resolved
 * correctly by reading back; p95 of a commit at most 300 ms (a threshold fixed in advance; it is
 * measured here from wherever this runs, and the real number comes from a pod). R2 runs skip when
 * the key file is absent. Objects are written under runs/hoststore/<run id>/ and deleted at the end. */
import { randomBytes } from "node:crypto";
import { VirtualClock } from "../src/clock.ts";
import type { MeteredObjectStore } from "../src/metered.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { ObjectStoreUncertain } from "../src/objectstore.ts";
import {
  SUMMARY_HEADERS,
  machine,
  ms,
  newRunId,
  openTarget,
  parseArgs,
  printTable,
  record,
  summarize,
  summaryRow,
  type StoreHandle,
  type Target,
} from "./lib.ts";

const args = parseArgs();
const target = args.string("target", "memory") as Target;
const writers = args.number("writers", 20);
const rounds = args.number("rounds", 50);
const lostRounds = args.number("lost", 100);
const samples = args.number("samples", target === "memory" ? 0 : 200);
const modes = args.string("modes", "reused,fresh").split(",") as ("reused" | "fresh")[];
const THRESHOLD_COMMIT_P95_MS = 300;

const opened = await openTarget(target, { runId: args.string("run", newRunId()) });
if ("skipped" in opened) {
  console.log(JSON.stringify({ experiment: "E1", target, skipped: opened.skipped }));
  process.exit(0);
}
const handle: StoreHandle = opened.handle;
const store = handle.store;
const drive = <T>(work: Promise<T>): Promise<T> => (handle.clock ? handle.clock.drive(work) : work);
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const key = (name: string) => `${handle.prefix}e1/${name}`;

// ---- 1. create-only atomicity ------------------------------------------------------------------
const atomic = {
  rounds,
  writers,
  exactlyOneWinner: 0,
  noWinner: 0,
  severalWinners: 0,
  losersSaw412: 0,
  uncertain: 0,
  storedBodyIsTheWinners: 0,
  failures: [] as string[],
};
for (let round = 1; round <= rounds; round += 1) {
  const name = key(`atomic/${String(round).padStart(4, "0")}`);
  const bodies = Array.from({ length: writers }, (_, index) =>
    new TextEncoder().encode(`round ${round} writer ${index} ${randomBytes(8).toString("hex")}`),
  );
  const results = await drive(
    Promise.all(
      bodies.map((body, index) =>
        store.putIfAbsent(name, body).then(
          (result) => ({ index, result }),
          (error: unknown) => ({ index, error }),
        ),
      ),
    ),
  );
  const created = results.filter((item) => "result" in item && item.result.created);
  const exists = results.filter((item) => "result" in item && !item.result.created);
  const unsure = results.filter((item) => "error" in item);
  atomic.uncertain += unsure.length;
  atomic.losersSaw412 += exists.length;
  const stored = await drive(store.get(name));
  const holder = stored ? bodies.findIndex((body) => equal(body, stored.body)) : -1;
  if (created.length === 1) {
    atomic.exactlyOneWinner += 1;
    if (holder === created[0]?.index) atomic.storedBodyIsTheWinners += 1;
    else atomic.failures.push(`round ${round}: stored body is not the winner's`);
  } else if (created.length === 0) {
    atomic.noWinner += 1;
    atomic.failures.push(`round ${round}: no writer was told it won (${unsure.length} uncertain)`);
  } else {
    atomic.severalWinners += 1;
    atomic.failures.push(`round ${round}: ${created.length} writers were told they won`);
  }
}

// ---- 2. a lost response ------------------------------------------------------------------------
const lost = {
  rounds: lostRounds,
  answered: 0,
  uncertainAndApplied: 0,
  uncertainAndNotApplied: 0,
  other: 0,
  retryTold412: 0,
  retryCreated: 0,
  /** Read-back found nothing, yet the retry was told 412: the abandoned request landed in between. */
  landedAfterReadBack: 0,
  finalBodyIsOurs: 0,
  failures: [] as string[],
};
async function measureMedian(kind: "put"): Promise<number> {
  if (handle.clock) return 30;
  const times: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const started = performance.now();
    await store.putIfAbsent(key(`calibrate/${index}`), new Uint8Array(2048));
    times.push(performance.now() - started);
  }
  void kind;
  return summarize(times.map((value) => value / 1000)).p50 * 1000;
}
const median = await measureMedian("put");
for (let round = 1; round <= lostRounds; round += 1) {
  const name = key(`lost/${String(round).padStart(4, "0")}`);
  const body = new TextEncoder().encode(`lost ${round} ${randomBytes(8).toString("hex")}`);
  let outcome: "answered" | "uncertain" | "other" = "answered";
  if (handle.memory) {
    handle.memory.script([{ op: "put", key: name, fault: "failAfter", nth: 1 }]);
    try {
      await drive(store.putIfAbsent(name, body));
    } catch (error) {
      outcome = error instanceof ObjectStoreUncertain ? "uncertain" : "other";
    }
  } else {
    // Abort the request while it is in flight: the service may already have applied it.
    const abortAfter = median * (0.25 + 0.75 * Math.random());
    const aborting = handle.open({ abortAfterMs: () => abortAfter });
    try {
      await aborting.putIfAbsent(name, body);
    } catch (error) {
      outcome = error instanceof ObjectStoreUncertain ? "uncertain" : "other";
    }
  }
  if (outcome === "answered") lost.answered += 1;
  if (outcome === "other") lost.other += 1;
  const found = await drive(store.get(name));
  const applied = found !== null;
  if (outcome === "uncertain") {
    if (applied) lost.uncertainAndApplied += 1;
    else lost.uncertainAndNotApplied += 1;
  }
  // The protocol's answer to an uncertain write: read back (done), then write again.
  const retry = await drive(store.putIfAbsent(name, body));
  if (retry.created) lost.retryCreated += 1;
  else lost.retryTold412 += 1;
  const final = await drive(store.get(name));
  if (final && equal(final.body, body)) lost.finalBodyIsOurs += 1;
  else lost.failures.push(`round ${round}: the object is not our body after the retry`);
  // An abandoned request can still be on its way to the service when the read-back looks: the
  // read-back then finds nothing and the retry is told 412, because the first write landed in
  // between. Both are fine; what matters is that exactly one version exists and it is ours.
  if (!applied && !retry.created) lost.landedAfterReadBack += 1;
  if (applied && retry.created)
    lost.failures.push(
      `round ${round}: the read-back saw the object and the retry still created it`,
    );
}

// ---- 3. latency ---------------------------------------------------------------------------------
interface ModeResult {
  mode: string;
  put2k: ReturnType<typeof summarize>;
  put64k: ReturnType<typeof summarize>;
  headHit: ReturnType<typeof summarize>;
  headMiss: ReturnType<typeof summarize>;
  get2k: ReturnType<typeof summarize>;
  listOne: ReturnType<typeof summarize>;
  listFifty: ReturnType<typeof summarize>;
  commit: ReturnType<typeof summarize>;
}
const latency: ModeResult[] = [];
async function timeIt(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return (performance.now() - started) / 1000;
}
async function measure(mode: "reused" | "fresh", s: MeteredObjectStore): Promise<ModeResult> {
  const base = key(`latency/${mode}`);
  const entry = (size: number) => new Uint8Array(randomBytes(size));
  // A connection to reuse: a few requests before anything is timed.
  if (mode === "reused") for (let index = 0; index < 5; index += 1) await s.head(`${base}/warm`);
  const put2k: number[] = [];
  const put64k: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    put2k.push(await timeIt(() => s.putIfAbsent(`${base}/p2/${index}`, entry(2048))));
    if (index < Math.ceil(samples / 2))
      put64k.push(await timeIt(() => s.putIfAbsent(`${base}/p64/${index}`, entry(65536))));
  }
  const headHit: number[] = [];
  const headMiss: number[] = [];
  const get2k: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    headHit.push(await timeIt(() => s.head(`${base}/p2/${index % samples}`)));
    headMiss.push(await timeIt(() => s.head(`${base}/missing/${index}`)));
    get2k.push(await timeIt(() => s.get(`${base}/p2/${index % samples}`)));
  }
  const listOne: number[] = [];
  const listFifty: number[] = [];
  const last = `${base}/p2/${String(samples - 1)}`;
  for (let index = 0; index < Math.ceil(samples / 2); index += 1) {
    listOne.push(await timeIt(() => s.list(`${base}/p2/`, last, 100)));
    listFifty.push(await timeIt(() => s.list(`${base}/p2/`, undefined, 50)));
  }
  // A commit as the protocol does it: the entry PUT, then the freshness HEAD of the next sequence.
  const commit: number[] = [];
  for (let index = 0; index < samples; index += 1)
    commit.push(
      await timeIt(async () => {
        await s.putIfAbsent(`${base}/log/${String(index).padStart(6, "0")}`, entry(2048));
        await s.head(`${base}/log/${String(index + 1).padStart(6, "0")}`);
      }),
    );
  return {
    mode,
    put2k: summarize(put2k),
    put64k: summarize(put64k),
    headHit: summarize(headHit),
    headMiss: summarize(headMiss),
    get2k: summarize(get2k),
    listOne: summarize(listOne),
    listFifty: summarize(listFifty),
    commit: summarize(commit),
  };
}
if (samples > 0 && !handle.clock)
  for (const mode of modes)
    latency.push(await measure(mode, handle.open({ keepAlive: mode === "reused" })));

// ---- the report -----------------------------------------------------------------------------------
const cleaned = await handle.cleanup();
const stores = handle.stores();
const classA = stores.reduce((sum, s) => sum + s.counts.classA, 0);
const classB = stores.reduce((sum, s) => sum + s.counts.classB, 0);
const worstCommitP95 = latency.length
  ? Math.max(...latency.map((item) => item.commit.p95)) * 1000
  : null;
const reusedCommit = latency.find((item) => item.mode === "reused")?.commit.p95;
const result = {
  experiment: "E1",
  target,
  runId: handle.runId,
  environment: {
    ...machine(),
    store: handle.description,
    cloudflareColos: handle.colos?.() ?? null,
  },
  atomicity: atomic,
  lostResponse: lost,
  latency: latency.map((item) => ({
    mode: item.mode,
    ...Object.fromEntries(
      Object.entries(item)
        .filter(([name]) => name !== "mode")
        .map(([name, value]) => [name, scaleToMs(value as ReturnType<typeof summarize>)]),
    ),
  })),
  commitThreshold: {
    p95LimitMs: THRESHOLD_COMMIT_P95_MS,
    reusedConnectionP95Ms:
      reusedCommit === undefined ? null : Math.round(reusedCommit * 1000 * 10) / 10,
    worstP95Ms: worstCommitP95 === null ? null : Math.round(worstCommitP95 * 10) / 10,
    pass: reusedCommit === undefined ? null : reusedCommit * 1000 <= THRESHOLD_COMMIT_P95_MS,
  },
  operations: { classA, classB, objectsDeleted: cleaned },
  atomicPass:
    atomic.exactlyOneWinner === rounds &&
    atomic.failures.length === 0 &&
    lost.failures.length === 0,
};

function scaleToMs(summary: ReturnType<typeof summarize>) {
  const scale = (value: number) => Math.round(value * 1000 * 10) / 10;
  return {
    n: summary.n,
    p50: scale(summary.p50),
    p95: scale(summary.p95),
    p99: scale(summary.p99),
    min: scale(summary.min),
    max: scale(summary.max),
    mean: scale(summary.mean),
  };
}

console.log(`\nE1 on ${target} (${handle.runId})`);
console.log(
  `\natomicity: ${atomic.exactlyOneWinner}/${rounds} rounds with exactly one winner of ${writers} concurrent writers; ${atomic.losersSaw412} losers saw 412; ${atomic.uncertain} uncertain; stored body was the winner's in ${atomic.storedBodyIsTheWinners}`,
);
console.log(
  `lost response: ${lost.uncertainAndApplied} applied-but-unanswered, ${lost.uncertainAndNotApplied} not applied, ${lost.answered} answered before the abort; retry told 412 ${lost.retryTold412}x (${lost.landedAfterReadBack} of them after a read-back that saw nothing), created ${lost.retryCreated}x; final body was ours in ${lost.finalBodyIsOurs}/${lostRounds}`,
);
for (const failure of [...atomic.failures, ...lost.failures].slice(0, 10))
  console.log(`  FAIL ${failure}`);
if (latency.length) {
  console.log("");
  printTable(
    SUMMARY_HEADERS,
    latency.flatMap((item) => [
      summaryRow(`${item.mode}: PUT 2 KiB`, item.put2k),
      summaryRow(`${item.mode}: PUT 64 KiB`, item.put64k),
      summaryRow(`${item.mode}: HEAD hit`, item.headHit),
      summaryRow(`${item.mode}: HEAD miss (404)`, item.headMiss),
      summaryRow(`${item.mode}: GET 2 KiB`, item.get2k),
      summaryRow(`${item.mode}: LIST after last key`, item.listOne),
      summaryRow(`${item.mode}: LIST 50 keys`, item.listFifty),
      summaryRow(`${item.mode}: COMMIT = PUT + HEAD`, item.commit),
    ]),
  );
  console.log(
    `\ncommit p95 on a reused connection: ${result.commitThreshold.reusedConnectionP95Ms} ms against the limit of ${THRESHOLD_COMMIT_P95_MS} ms: ${result.commitThreshold.pass ? "within" : "OVER"} (measured from this machine, not a pod)`,
  );
}
console.log(`\noperations: ${classA} Class A, ${classB} Class B; ${cleaned} objects deleted`);
console.log(`\nJSON: ${JSON.stringify(result)}`);
record("E1", result, {
  ...(args.has("json") ? { out: args.string("json", "") } : {}),
  ...(args.has("ledger") ? { ledger: args.string("ledger", "") } : {}),
  counts: { classA, classB },
});
void ms;
void MemoryObjectStore;
void VirtualClock;

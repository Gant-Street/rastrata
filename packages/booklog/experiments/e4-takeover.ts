/** E4, the takeovers: how long is a book without a holder, for books of 500, 2,000 and 5,000 journals,
 * in the three ways a book changes hands. Two real API server processes (apps/api with
 * `RASTRATA_BOOK_STORE`) share the book through Postgres and a directory bucket; a client sends a read
 * (the journal list, which needs the ledger's read model) every 100 ms and a write every 250 ms to
 * whichever pod answered last, and the other when it did not.
 *
 *   cold      The holder is killed (SIGKILL). The other pod has not opened the book: it waits for the lease
 *             to lapse (up to 5 s), reads the book, and replays the ledger at the first read.
 *   hot       The same, but the other pod is a standby: it has been following the log with its application
 *             built and warmed, and takes the book when the lease lapses. Writes stop before the kill, until
 *             the standby has the log to its end and has warmed, so that it is current: this is the floor,
 *             what a takeover costs when everything that can be ready is.
 *   graceful  The holder is told to hand over: it refuses writes and goes on answering reads, the standby
 *             follows the log to its end and warms, and only then does the holder give up the lease. The
 *             writes are where the cost shows; the reads should not notice.
 *
 *   bun experiments/e4-takeover.ts [--sizes 500,2000,5000] [--modes cold,hot,graceful] [--reps 2] [--tail postgres|do] [--lease-ms 5000] [--json out]
 *
 * What is reported for each: the longest time without a successful read, and without a successful write,
 * seen by the client across the change (the steady gap is about 100 and 250 ms), and then the log is read
 * from nothing and every acknowledged write must be in it exactly once. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "@rastrata/application/local";
import { BULK_BOOK, postBulk } from "@rastrata/application/testing/bulk-book";
import { importBookFile } from "../src/import.ts";
import { FileObjectStore } from "../src/store-file.ts";
import { APPLICATION_DERIVED, APPLICATION_SCHEMA } from "../test/support/app.ts";
import {
  PORT_BASE,
  call,
  control,
  openTail,
  readWholeLog,
  ready,
  signal,
  sleep,
  startPod,
  type Pod,
} from "./e4-pods.ts";
import { machine, newRunId, parseArgs, printTable, quantile } from "./lib.ts";

type Mode = "cold" | "hot" | "graceful";

const FIRST_SCREEN = { page: 1, status: "Posted" };
const bulkDraft = (reference: string) => ({
  data: {
    date: "2026-03-02",
    reference,
    narration: reference,
    lines: [
      { accountId: "5000", debit: "5.00", credit: "" },
      { accountId: "1000", debit: "", credit: "5.00" },
    ],
  },
});

async function buildSeed(size: number, directory: string): Promise<string> {
  const file = join(directory, `seed-${size}.sqlite`);
  const service = await LocalBookService.open(file, {
    safety: false,
    snapshots: false,
    prepareSlices: true,
  });
  await service.setup(BULK_BOOK);
  await postBulk(service, size);
  service.close();
  return file;
}

interface Sample {
  readonly at: number;
  readonly ok: boolean;
  readonly pod: string;
  readonly ms: number;
}

interface CellResult {
  readonly size: number;
  readonly mode: Mode;
  readonly rep: number;
  readonly readGapMs: number;
  readonly writeGapMs: number;
  readonly firstReadAfterMs: number | null;
  readonly firstWriteAfterMs: number | null;
  /** How long the new holder's first answered read took itself: for a cold standby that is the time it
   * spent reading the book (and replaying it) inside the request, once the lease was free. */
  readonly firstReadTookMs: number | null;
  readonly steadyReadMs: number;
  readonly steadyWriteMs: number;
  /** For a handover: from the order to refuse writes to the holder giving the lease up. */
  readonly drainToReleaseMs: number | null;
  readonly acked: number;
  readonly lost: number;
  readonly doubled: number;
  readonly fenceRegressions: number;
  readonly chain: string;
  readonly activation: unknown;
  readonly pass: boolean;
}

/** The longest gap between two successes, looking only at the stretch that starts at `from`. */
function longestGap(samples: readonly Sample[], from: number): number {
  const ok = samples.filter((sample) => sample.ok).map((sample) => sample.at);
  let longest = 0;
  let previous: number | null = null;
  for (const at of ok) {
    if (previous !== null && at >= from) longest = Math.max(longest, at - previous);
    previous = at;
  }
  return longest;
}

async function cell(options: {
  readonly size: number;
  readonly mode: Mode;
  readonly rep: number;
  readonly seed: string;
  readonly tail: "postgres" | "do";
  readonly tailHandle: Awaited<ReturnType<typeof openTail>>;
  readonly port: number;
  readonly leaseMs: number;
}): Promise<CellResult> {
  const { size, mode } = options;
  const bookId = `t${size}-${mode}-${options.rep}-${newRunId()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")}`;
  const work = mkdtempSync(join(tmpdir(), "e4t-"));
  const bucket = join(work, "bucket");
  mkdirSync(bucket, { recursive: true });
  const pods: Pod[] = [];
  const running = { value: true };
  const started = performance.now();
  const clock = () => performance.now() - started;
  try {
    // The book: the seeded file, imported as the beginning of a log.
    await importBookFile({
      tier: await options.tailHandle.reader(),
      bulk: new FileObjectStore(bucket),
      bookId,
      path: options.seed,
      schema: APPLICATION_SCHEMA,
      exclude: APPLICATION_DERIVED,
      journals: size,
    });
    const make = (name: string, port: number, env: Record<string, string>) =>
      startPod({
        name,
        port,
        cache: join(work, `cache-${name}`),
        bookId,
        bucket,
        tail: options.tailHandle.url,
        env: { RASTRATA_BOOK_LEASE_MS: String(options.leaseMs), ...env },
      });
    pods.push(
      make("a", options.port, { RASTRATA_BOOK_WARM: "1" }),
      make(
        "b",
        options.port + 1,
        mode === "cold" ? {} : { RASTRATA_BOOK_STANDBY: "1", RASTRATA_BOOK_FOLLOW_MS: "100" },
      ),
    );
    await Promise.all(pods.map(ready));
    const [podA, podB] = pods as [Pod, Pod];
    // A is the holder, and has done what a first screen does (the replay is behind it).
    const first = await call(podA.port, "journal.list", FIRST_SCREEN, undefined, 120_000);
    if (first?.status !== 200)
      throw new Error(`The holder could not serve the book: ${first?.status}`);
    if (mode !== "cold") {
      // The standby has read the book and warmed its application.
      for (let waited = 0; ; waited += 100) {
        const status = await control(podB.port, "status");
        if (status?.body?.following?.warmed === true) break;
        if (waited > 180_000) throw new Error("The standby did not warm");
        await sleep(100);
      }
    }

    const reads: Sample[] = [];
    const writes: Sample[] = [];
    const acks: { opId: string; reference: string }[] = [];
    let target = 0;
    let writesOn = true;
    let counter = 0;
    const attempt = async (kind: "read" | "write"): Promise<void> => {
      const opId = crypto.randomUUID();
      const reference = `c${counter++}`;
      for (const index of [target, 1 - target]) {
        const pod = pods[index] as Pod;
        const begun = clock();
        const reply =
          kind === "read"
            ? await call(pod.port, "journal.list", FIRST_SCREEN, undefined, 60_000)
            : await call(pod.port, "drafts.create", bulkDraft(reference), opId, 60_000);
        const ok = reply !== null && reply.status === 200 && reply.body?.ok === true;
        (kind === "read" ? reads : writes).push({
          at: clock(),
          ok,
          pod: pod.name,
          ms: clock() - begun,
        });
        if (ok) {
          target = index;
          if (kind === "write") acks.push({ opId, reference });
          return;
        }
      }
    };
    const loop = async (kind: "read" | "write", every: number) => {
      while (running.value) {
        const begun = clock();
        if (kind === "read" || writesOn) await attempt(kind);
        await sleep(Math.max(0, every - (clock() - begun)));
      }
    };
    const loops = [loop("read", 100), loop("write", 250)];

    // A few seconds of steady state, then the change. `changed` is when the book's holder stops being
    // able to serve it as it was: the kill, or the order to hand over.
    await sleep(4000);
    let changed = clock();
    let drainToReleaseMs: number | null = null;
    if (mode === "cold") {
      podA.proc.kill("SIGKILL");
    } else if (mode === "hot") {
      // No writes, until the standby has the log to its end and has warmed: it is current when its holder dies.
      writesOn = false;
      await sleep(500);
      for (let waited = 0; ; waited += 50) {
        const holder = await control(podA.port, "tail");
        const standby = await control(podB.port, "status");
        const following = standby?.body?.following;
        if (
          following?.warmed === true &&
          typeof holder?.body?.seq === "number" &&
          following.seq === holder.body.seq
        )
          break;
        if (waited > 180_000) throw new Error("The standby did not catch up");
        await sleep(50);
      }
      podA.proc.kill("SIGKILL");
      changed = clock();
      writesOn = true;
    } else {
      const drainedAt = clock();
      await control(podA.port, "drain", {});
      // The standby must have the log to its end, and have warmed, before the holder lets go.
      for (let waited = 0; ; waited += 50) {
        const holder = await control(podA.port, "tail");
        const standby = await control(podB.port, "status");
        const following = standby?.body?.following;
        if (
          following?.warmed === true &&
          typeof holder?.body?.seq === "number" &&
          following.seq === holder.body.seq
        )
          break;
        if (waited > 180_000) throw new Error("The standby did not catch up");
        await sleep(50);
      }
      await control(podA.port, "release", { exit: true });
      drainToReleaseMs = clock() - drainedAt;
    }

    // Until both reads and writes are served by the other pod, and then a little longer.
    for (let waited = 0; waited < 90_000; waited += 100) {
      const after = (samples: Sample[]) =>
        samples.some((sample) => sample.ok && sample.pod === "b" && sample.at > changed);
      if (after(reads) && after(writes)) break;
      await sleep(100);
    }
    await sleep(3000);
    running.value = false;
    await Promise.all(loops);

    const steady = (samples: Sample[]) =>
      quantile(
        samples
          .filter((sample) => sample.ok && sample.at < changed)
          .map((sample) => sample.ms)
          .sort((a, b) => a - b),
        0.5,
      );
    const firstAfter = (samples: Sample[]) => {
      const found = samples.find(
        (sample) => sample.ok && sample.pod === "b" && sample.at > changed,
      );
      return found ? Math.round(found.at - changed) : null;
    };
    const firstRead = reads.find(
      (sample) => sample.ok && sample.pod === "b" && sample.at > changed,
    );
    const status = await control(podB.port, "status");

    // Stop the pods, then read the log from nothing.
    for (const pod of pods) {
      try {
        pod.proc.kill("SIGTERM");
      } catch {
        // gone
      }
    }
    await Promise.race([Promise.all(pods.map((pod) => pod.proc.exited)), sleep(20_000)]);
    for (const pod of pods) pod.proc.kill("SIGKILL");
    const log = await readWholeLog(await options.tailHandle.reader(), bucket, bookId);
    const lost = acks.filter((ack) => (log.counts.get(ack.opId) ?? 0) === 0).length;
    const doubled = [...log.counts.values()].filter((n) => n > 1).length;
    const readGap = longestGap(reads, changed - 300);
    // After a quiet spell by design the writes' own gap would include it: from the change to the first
    // write by the new holder is what a client waits.
    const writeGap =
      mode === "hot" ? (firstAfter(writes) ?? Number.NaN) : longestGap(writes, changed - 300);
    return {
      size,
      mode,
      rep: options.rep,
      readGapMs: Math.round(readGap),
      writeGapMs: Math.round(writeGap),
      firstReadAfterMs: firstAfter(reads),
      firstWriteAfterMs: firstAfter(writes),
      firstReadTookMs: firstRead ? Math.round(firstRead.ms) : null,
      steadyReadMs: Math.round(steady(reads)),
      steadyWriteMs: Math.round(steady(writes)),
      drainToReleaseMs: drainToReleaseMs === null ? null : Math.round(drainToReleaseMs),
      acked: acks.length,
      lost,
      doubled,
      fenceRegressions: log.fenceRegressions,
      chain: log.chain,
      activation: status?.body?.stats?.activation ?? null,
      pass: log.chain === "ok" && lost === 0 && doubled === 0 && log.fenceRegressions === 0,
    };
  } finally {
    running.value = false;
    for (const pod of pods) {
      try {
        signal(pod, "SIGCONT");
        pod.proc.kill("SIGKILL");
      } catch {
        // gone
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sizes = args.string("sizes", "500,2000,5000").split(",").map(Number);
  const modes = args.string("modes", "cold,hot,graceful").split(",") as Mode[];
  const reps = args.number("reps", 2);
  const tailKind = args.string("tail", "postgres") as "postgres" | "do";
  const leaseMs = args.number("lease-ms", 5000);
  const seeds = mkdtempSync(join(tmpdir(), "e4t-seeds-"));
  const tailHandle = await openTail(tailKind);
  const results: CellResult[] = [];
  try {
    let port = PORT_BASE + 40;
    for (const size of sizes) {
      const seed = await buildSeed(size, seeds);
      for (const mode of modes)
        for (let rep = 1; rep <= reps; rep += 1) {
          const result = await cell({
            size,
            mode,
            rep,
            seed,
            tail: tailKind,
            tailHandle,
            port,
            leaseMs,
          });
          port += 2;
          results.push(result);
          console.error(
            `${size} ${mode} #${rep}: reads ${result.readGapMs} ms, writes ${result.writeGapMs} ms ${result.pass ? "" : "FAILED"}`,
          );
        }
    }
  } finally {
    await tailHandle.close().catch(() => {});
    rmSync(seeds, { recursive: true, force: true });
  }
  console.log(
    `\nE4: a book changes hands, ${tailKind} tail, leases of ${leaseMs} ms, the real API server, a read every 100 ms and a write every 250 ms. ${JSON.stringify(machine())}`,
  );
  printTable(
    [
      "journals",
      "takeover",
      "rep",
      "longest gap, reads ms",
      "longest gap, writes ms",
      "first read by the new holder ms",
      "(that read took ms)",
      "first write ms",
      "steady read / write ms",
      "drain to release ms",
      "acked",
      "lost",
      "doubled",
      "fence regressions",
      "chain",
    ],
    results.map((result) => [
      result.size,
      result.mode,
      result.rep,
      result.readGapMs,
      result.writeGapMs,
      result.firstReadAfterMs ?? "",
      result.firstReadTookMs ?? "",
      result.firstWriteAfterMs ?? "",
      `${result.steadyReadMs} / ${result.steadyWriteMs}`,
      result.drainToReleaseMs ?? "",
      result.acked,
      result.lost,
      result.doubled,
      result.fenceRegressions,
      result.chain,
    ]),
  );
  const json = args.string("json", "");
  if (json) writeFileSync(json, `${JSON.stringify({ machine: machine(), results }, null, 2)}\n`);
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

await main();

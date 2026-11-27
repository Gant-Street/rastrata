/** E4: two pods and one book. The real API server (apps/api, `RASTRATA_BOOK_STORE`) runs as two processes
 * on the same book, a client writes to it all the time under operation identities and retries on the
 * other pod when one fails, and the pod that holds the book is made to fail: frozen past its lease
 * (SIGSTOP, then SIGCONT: a stop-the-world pause or a frozen VM), killed (SIGKILL, restarted cold), or
 * cut off from the tail. Afterwards the whole log is read from nothing and checked.
 *
 *   bun experiments/e4-contention.ts [--tail postgres|do] [--fault none|pause|kill|tail] [--seconds 40] [--writers 4] [--json out]
 *   bun experiments/e4-contention.ts all          (both tails, every fault)
 *
 * Pass (the proof plan): no acknowledged commit lost, none doubled; recovery in at most 10 s (the longest
 * time the client saw without any commit being acknowledged); no stale fence accepted (every entry's
 * fence is at least the one before it, and a pod that woke up and tried to write was refused); no read
 * served that missed a commit acknowledged before it began. Fallback: fix the protocol.
 *
 * The takeover times by book size, cold and warm and graceful, are `e4-takeover.ts`; the node drain with
 * every tenant cold-loading is `e4-drain.ts`.
 *
 * The tail is Postgres (the local container `booklog-pg`, BOOKLOG_PG_URL to point elsewhere) or a
 * Durable Object protocol server run by this script around the in-memory tail. The bulk store is a
 * directory both pods share. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOK,
  PORT_BASE,
  call,
  control,
  draftInput,
  openTail,
  readWholeLog,
  ready,
  signal,
  sleep,
  startPod,
  type Pod,
} from "./e4-pods.ts";
import { machine, newRunId, parseArgs, printTable } from "./lib.ts";

type Fault = "none" | "pause" | "kill" | "tail";

interface Ack {
  readonly opId: string;
  readonly reference: string;
  readonly draftId: string;
  readonly at: number;
  readonly pod: string;
}

interface FailoverResult {
  readonly tail: string;
  readonly fault: Fault;
  readonly seconds: number;
  readonly acks: number;
  readonly unresolved: number;
  readonly attempts: number;
  readonly clean503: number;
  readonly unknownOutcomes: number;
  readonly acksByPod: Record<string, number>;
  readonly maxGapMs: number;
  readonly gapStartedAtMs: number;
  readonly takeoverMs: number | null;
  readonly reads: number;
  readonly readsRefused: number;
  readonly staleReads: number;
  readonly zombieWrites: number;
  readonly zombieAcked: number;
  readonly fenceRejectionsOnTheOldHolder: number | null;
  readonly entries: number;
  readonly lost: string[];
  readonly doubled: string[];
  readonly fenceRegressions: number;
  readonly writers: string[];
  readonly fences: number[];
  readonly chain: string;
  readonly pass: boolean;
}

async function failover(options: {
  readonly tail: "postgres" | "do";
  readonly fault: Fault;
  readonly seconds: number;
  readonly writers: number;
  readonly port: number;
}): Promise<FailoverResult> {
  const runId = newRunId()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const bookId = `e4-${runId}`;
  const work = mkdtempSync(join(tmpdir(), "e4-"));
  const bucket = join(work, "bucket");
  mkdirSync(bucket, { recursive: true });
  const tail = await openTail(options.tail);
  const pods: Pod[] = [];
  const make = (name: string, port: number) =>
    startPod({
      name,
      port,
      cache: join(work, `cache-${name}-${Date.now()}`),
      bookId,
      bucket,
      tail: tail.url,
    });
  const running = { value: true };
  const acks: Ack[] = [];
  let attempts = 0;
  let clean503 = 0;
  let unknownOutcomes = 0;
  const unresolved: string[] = [];
  let preferred = 0;
  const started = performance.now();
  const clock = () => performance.now() - started;
  try {
    pods.push(make("a", options.port), make("b", options.port + 1));
    await Promise.all(pods.map(ready));
    const podA = () => pods[0] as Pod;
    // The book is made through pod A.
    const setup = await call(podA().port, "book.setup", BOOK, crypto.randomUUID(), 20000);
    if (setup?.status !== 200) throw new Error(`The book could not be set up: ${setup?.status}`);

    const t0 = clock();
    const faultAt = t0 + 10_000;
    const resumeAfterMs = options.fault === "kill" ? 8_000 : 12_000;
    let faultStarted = 0;
    const zombies: { at: number; status: number | null; code: string | null; opId: string }[] = [];

    /** The pod to try: the one that answered last, then the other, leaving out one that has just not answered. */
    const pick = (attempt: number): Pod => {
      const live = pods.filter((pod) => pod.badUntil <= clock());
      const from = live.length > 0 ? live : pods;
      const last = pods[preferred] as Pod;
      const start = Math.max(0, from.indexOf(last));
      return from[(start + attempt) % from.length] as Pod;
    };

    const writer = async (id: number) => {
      let n = 0;
      while (running.value) {
        const opId = crypto.randomUUID();
        const reference = `w${id}-${n++}`;
        const begun = clock();
        let done = false;
        for (let attempt = 0; clock() - begun < 45_000 && running.value; attempt += 1) {
          const pod = pick(attempt);
          attempts += 1;
          const reply = await call(pod.port, "drafts.create", draftInput(reference), opId, 1500);
          if (reply === null) {
            unknownOutcomes += 1;
            pod.badUntil = clock() + 2000;
            await sleep(100);
            continue;
          }
          if (reply.status === 200 && reply.body?.ok === true) {
            acks.push({
              opId,
              reference,
              draftId: String(reply.body.data?.id ?? ""),
              at: clock(),
              pod: pod.name,
            });
            preferred = pods.indexOf(pod);
            done = true;
            break;
          }
          if (reply.status === 503) clean503 += 1;
          await sleep(100);
        }
        if (!done) unresolved.push(opId);
        await sleep(20);
      }
    };

    let reads = 0;
    let readsRefused = 0;
    let staleReads = 0;
    const reader = async () => {
      let turn = 0;
      while (running.value) {
        await sleep(150);
        const before = clock();
        // The newest commit acknowledged before this read began.
        let newest: Ack | undefined;
        for (let index = acks.length - 1; index >= 0; index -= 1) {
          const ack = acks[index] as Ack;
          if (ack.at < before) {
            newest = ack;
            break;
          }
        }
        if (!newest?.draftId) continue;
        const pod = pods[turn++ % pods.length] as Pod;
        reads += 1;
        const reply = await call(
          pod.port,
          "drafts.get",
          { draftId: newest.draftId },
          undefined,
          2500,
        );
        if (reply === null || reply.status === 503) {
          readsRefused += 1;
          continue;
        }
        if (reply.status === 200 && reply.body?.ok === true) continue;
        // An answer that says the draft does not exist, for a draft that was acknowledged: stale.
        if (reply.status === 404 || reply.body?.error?.code === "not_found") staleReads += 1;
        else readsRefused += 1;
      }
    };

    const chaos = async () => {
      await sleep(Math.max(0, faultAt - clock()));
      faultStarted = clock();
      const old = podA();
      if (options.fault === "pause") {
        signal(old, "SIGSTOP");
        await sleep(resumeAfterMs);
        signal(old, "SIGCONT");
      } else if (options.fault === "kill") {
        old.proc.kill("SIGKILL");
        await sleep(resumeAfterMs);
        // A new pod in its place: cold, with a cache of its own, on the same address.
        pods[0] = make("a2", old.port);
        await ready(pods[0] as Pod);
      } else if (options.fault === "tail") {
        await control(old.port, "fault", { kind: "tail", seconds: resumeAfterMs / 1000 });
        await sleep(resumeAfterMs);
      }
      if (options.fault === "none") return;
      // Writes sent straight to the old holder after it is back: they must not be taken while another holds the book.
      for (const wait of [500, 1000, 1500, 3000]) {
        await sleep(wait);
        const opId = crypto.randomUUID();
        const reply = await call(
          podA().port,
          "drafts.create",
          draftInput(`zombie-${zombies.length}`),
          opId,
          4000,
        );
        zombies.push({
          at: clock(),
          status: reply?.status ?? null,
          code: reply?.body?.error?.code ?? null,
          opId,
        });
      }
    };

    const workers = [
      ...Array.from({ length: options.writers }, (_, index) => writer(index)),
      reader(),
    ];
    const chaosDone = chaos();
    await sleep(options.seconds * 1000);
    running.value = false;
    await Promise.all(workers);
    await chaosDone.catch(() => {});

    // What the old holder says about itself, before the pods are stopped.
    const status = await control(podA().port, "status");
    const fenceRejections: number | null = status?.body?.tail_calls?.fenceRejections ?? null;

    // Stop the pods cleanly, the one that holds the book last.
    for (const pod of pods) {
      try {
        signal(pod, "SIGCONT");
        pod.proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    await Promise.race([Promise.all(pods.map((pod) => pod.proc.exited)), sleep(15000)]);
    for (const pod of pods) pod.proc.kill("SIGKILL");

    // The log, read from nothing: every link, every entry.
    const log = await readWholeLog(await tail.reader(), bucket, bookId);
    const lost = acks
      .filter((ack) => (log.counts.get(ack.opId) ?? 0) === 0)
      .map((ack) => ack.reference);
    const doubled = [...log.counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

    // Recovery: the longest the client saw without any commit being acknowledged around the fault.
    const times = acks.map((ack) => ack.at).sort((a, b) => a - b);
    let maxGap = 0;
    let gapStart = 0;
    for (let index = 1; index < times.length; index += 1) {
      const gap = (times[index] as number) - (times[index - 1] as number);
      if (gap > maxGap) {
        maxGap = gap;
        gapStart = (times[index - 1] as number) - t0;
      }
    }
    const firstOther = acks.find(
      (ack) => ack.at > faultStarted && ack.pod !== "a" && ack.pod !== "a2",
    );
    const takeover = options.fault === "none" || !firstOther ? null : firstOther.at - faultStarted;
    const acksByPod: Record<string, number> = {};
    for (const ack of acks) acksByPod[ack.pod] = (acksByPod[ack.pod] ?? 0) + 1;
    const zombieAcked = zombies.filter((zombie) => zombie.status === 200).length;
    const zombieLost = zombies.filter(
      (zombie) => zombie.status === 200 && (log.counts.get(zombie.opId) ?? 0) !== 1,
    ).length;
    return {
      tail: options.tail,
      fault: options.fault,
      seconds: options.seconds,
      acks: acks.length,
      unresolved: unresolved.length,
      attempts,
      clean503,
      unknownOutcomes,
      acksByPod,
      maxGapMs: Math.round(maxGap),
      gapStartedAtMs: Math.round(gapStart),
      takeoverMs: takeover === null ? null : Math.round(takeover),
      reads,
      readsRefused,
      staleReads,
      zombieWrites: zombies.length,
      zombieAcked,
      fenceRejectionsOnTheOldHolder: fenceRejections,
      entries: log.entries.length,
      lost: [...lost, ...(zombieLost > 0 ? [`${zombieLost} zombie acks`] : [])],
      doubled,
      fenceRegressions: log.fenceRegressions,
      writers: log.writers,
      fences: log.fences,
      chain: log.chain,
      pass:
        log.chain === "ok" &&
        lost.length === 0 &&
        zombieLost === 0 &&
        doubled.length === 0 &&
        log.fenceRegressions === 0 &&
        staleReads === 0 &&
        maxGap <= 10_000,
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
    await tail.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const all = process.argv[2] === "all";
  const results: FailoverResult[] = [];
  const tails = (all ? "postgres,do" : args.string("tail", "postgres")).split(",");
  const faults = (all ? "none,pause,kill,tail" : args.string("fault", "pause")).split(",");
  let port = PORT_BASE;
  for (const tail of tails)
    for (const fault of faults) {
      const result = await failover({
        tail: tail as "postgres" | "do",
        fault: fault as Fault,
        seconds: args.number("seconds", 40),
        writers: args.number("writers", 4),
        port,
      });
      port += 2;
      results.push(result);
      console.error(
        `${tail} ${fault}: ${result.pass ? "pass" : "FAIL"} (max gap ${result.maxGapMs} ms)`,
      );
    }
  console.log(`\nE4: two pods, one book, the real API server. ${JSON.stringify(machine())}`);
  printTable(
    [
      "tail",
      "fault",
      "acked",
      "unresolved",
      "max gap ms",
      "takeover ms",
      "stale reads",
      "zombie writes (acked)",
      "fence rejections (old holder)",
      "entries",
      "lost",
      "doubled",
      "fence regressions",
      "chain",
      "pass",
    ],
    results.map((result) => [
      result.tail,
      result.fault,
      result.acks,
      result.unresolved,
      result.maxGapMs,
      result.takeoverMs ?? "",
      result.staleReads,
      `${result.zombieWrites} (${result.zombieAcked})`,
      result.fenceRejectionsOnTheOldHolder ?? "",
      result.entries,
      result.lost.length,
      result.doubled.length,
      result.fenceRegressions,
      result.chain,
      result.pass ? "yes" : "NO",
    ]),
  );
  const json = args.string("json", "");
  if (json) writeFileSync(json, `${JSON.stringify({ machine: machine(), results }, null, 2)}\n`);
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

await main();

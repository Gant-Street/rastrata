/** E7, the sealing policy: how many segments does an hour of traffic make, when entries that carry only
 * a read's effects (an agent's audit row, logged before it is answered) are told apart from entries that
 * carry a write?
 *
 * Under the old policy every entry arms the short window (2 s), so an agent reading every 5 seconds
 * makes a segment per read: one PUT and one verifying GET each. Under the new one only an entry that
 * carries a write does; the audit rows wait for the next seal of any kind, or ten minutes.
 *
 * And the other end: a book written to faster than the window (an import, a script) must still make one
 * segment a window and no more, however long a seal takes, so a second table writes to a book every
 * 100 ms to 1 s against a bulk store that answers in 0 to 400 ms.
 *
 *   bun experiments/e7-policy.ts [--hours 1] [--agent-every 5] [--busy-seconds 120] [--json out.json]
 *
 * Virtual time, a real SQLite cache, the in-memory tail and bucket. */
import { writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { BookKeys } from "../src/objectstore.ts";
import { Rng } from "../src/rng.ts";
import { BookRuntime } from "../src/runtime.ts";
import { World } from "../test/support/world.ts";
import { machine, parseArgs, printTable } from "./lib.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL);
`;

interface Row {
  readonly scenario: string;
  readonly policy: string;
  readonly entries: number;
  readonly writes: number;
  readonly agentReads: number;
  readonly seals: number;
  readonly byReason: Record<string, number>;
  readonly classA: number;
  readonly classB: number;
  readonly sealedBytes: number;
  readonly longestWriteWaitSeconds: number;
  readonly longestAuditWaitSeconds: number;
  readonly sealsPerHour: number;
}

async function simulate(options: {
  readonly scenario: string;
  readonly everythingUrgent: boolean;
  readonly hours: number;
  readonly agentEverySeconds: number;
  readonly writesPerHour: number;
  readonly seed: number;
}): Promise<Row> {
  const w = new World();
  try {
    const rng = new Rng(options.seed);
    const pod = await BookRuntime.open({
      ...w.runtimeOptions("pod-a#1"),
      sealing: {
        delayMs: 2000,
        routineMaxAgeMs: 600_000,
        everythingUrgent: options.everythingUrgent,
      },
    });
    const keys = new BookKeys("runs/t/", w.bookId);
    const total = options.hours * 3600 * 1000;
    const urgent: number[] = [];
    const routine: number[] = [];
    let writes = 0;
    let reads = 0;
    let longestWrite = 0;
    let longestAudit = 0;
    const writeEvery =
      options.writesPerHour > 0 ? (3600 * 1000) / options.writesPerHour : Number.POSITIVE_INFINITY;
    let nextWrite = rng.next() * writeEvery;
    const step = 1000;
    let nextAgent = 0;
    const seen = new Map<number, number>();
    for (let t = 0; t < total; t += step) {
      if (options.agentEverySeconds > 0 && w.clock.now() >= nextAgent) {
        nextAgent += options.agentEverySeconds * 1000;
        await pod.read(
          (db: Database) => {
            db.exec(SCHEMA);
            db.run("INSERT INTO audit (what) VALUES ('read')");
          },
          { effects: "log-first" },
        );
        reads += 1;
        routine.push(pod.head.seq);
        seen.set(pod.head.seq, w.clock.now());
      }
      if (w.clock.now() >= nextWrite) {
        nextWrite += writeEvery * (0.5 + rng.next());
        await pod.write((db: Database) => {
          db.exec(SCHEMA);
          db.run("INSERT INTO kv (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1", [
            `k${writes}`,
          ]);
        });
        writes += 1;
        urgent.push(pod.head.seq);
        seen.set(pod.head.seq, w.clock.now());
      }
      await w.sleep(step);
      const sealed = (await w.tier.head(w.bookId)).sealedThrough;
      for (const seq of urgent)
        if (seq > sealed)
          longestWrite = Math.max(longestWrite, (w.clock.now() - (seen.get(seq) ?? 0)) / 1000);
      for (const seq of routine)
        if (seq > sealed)
          longestAudit = Math.max(longestAudit, (w.clock.now() - (seen.get(seq) ?? 0)) / 1000);
    }
    await w.sleep(2500);
    const seals = Object.values(pod.stats.seals).reduce((sum, n) => sum + n, 0);
    const stats = w.bulk.stats;
    const sealedBytes = w.bulk
      .keys(keys.sealedPrefix)
      .reduce((sum, key) => sum + (w.bulk.peek(key)?.body.byteLength ?? 0), 0);
    const row: Row = {
      scenario: options.scenario,
      policy: options.everythingUrgent
        ? "every entry urgent (old)"
        : "writes urgent, audit rows routine (new)",
      entries: pod.head.seq,
      writes,
      agentReads: reads,
      seals,
      byReason: { ...pod.stats.seals },
      classA: stats.classA,
      classB: stats.classB,
      sealedBytes,
      longestWriteWaitSeconds: longestWrite,
      longestAuditWaitSeconds: longestAudit,
      sealsPerHour: seals / options.hours,
    };
    await pod.close({ seal: false });
    return row;
  } finally {
    w.dispose();
  }
}

interface BusyRow {
  readonly everyMs: number;
  readonly bulkLatencyMs: number;
  readonly seconds: number;
  readonly writes: number;
  readonly seals: number;
  readonly sealsPerHour: number;
  readonly classA: number;
  readonly longestWriteWaitSeconds: number;
}

/** A book written to every `everyMs` for `seconds`, against a bulk store whose every call takes about
 * `bulkLatencyMs`: how many segments, and how long does the longest-waiting write wait for its seal? */
async function simulateBusy(options: {
  readonly everyMs: number;
  readonly bulkLatencyMs: number;
  readonly seconds: number;
}): Promise<BusyRow> {
  const w = new World();
  try {
    const pod = await BookRuntime.open({
      ...w.runtimeOptions("pod-a#1"),
      sealing: { delayMs: 2000, routineMaxAgeMs: 600_000 },
    });
    if (options.bulkLatencyMs > 0)
      w.bulk.wire.configure({ latency: { medianMs: options.bulkLatencyMs, sigma: 0.01 } });
    const urgent: { seq: number; at: number }[] = [];
    const writes = Math.floor((options.seconds * 1000) / options.everyMs);
    let longest = 0;
    for (let step = 0; step < writes; step += 1) {
      await pod.write((db: Database) => {
        db.exec(SCHEMA);
        db.run("INSERT INTO kv (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1", [
          `k${step}`,
        ]);
      });
      urgent.push({ seq: pod.head.seq, at: w.clock.now() });
      await w.sleep(options.everyMs);
      const sealed = (await w.tier.head(w.bookId)).sealedThrough;
      for (const entry of urgent)
        if (entry.seq > sealed) longest = Math.max(longest, w.clock.now() - entry.at);
    }
    await w.sleep(4000);
    const seals = Object.values(pod.stats.seals).reduce((sum, n) => sum + n, 0);
    const perHour = 3600 / options.seconds;
    const row: BusyRow = {
      everyMs: options.everyMs,
      bulkLatencyMs: options.bulkLatencyMs,
      seconds: options.seconds,
      writes,
      seals,
      sealsPerHour: Math.round(seals * perHour),
      classA: w.bulk.stats.classA,
      longestWriteWaitSeconds: longest / 1000,
    };
    await pod.close({ seal: false });
    return row;
  } finally {
    w.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const hours = args.number("hours", 1);
  const every = args.number("agent-every", 5);
  const rows: Row[] = [];
  for (const [scenario, agent, writes] of [
    [`an agent reading every ${every} s, nobody writing`, every, 0],
    ["the same agent, and a person writing 30 times an hour", every, 30],
    ["a person writing 30 times an hour, no agent", 0, 30],
    ["a person writing 300 times an hour (a busy hour)", 0, 300],
  ] as const)
    for (const everythingUrgent of [true, false])
      rows.push(
        await simulate({
          scenario,
          everythingUrgent,
          hours,
          agentEverySeconds: agent,
          writesPerHour: writes,
          seed: 7,
        }),
      );
  console.log(`E7 sealing policy, ${hours} simulated hour(s). ${JSON.stringify(machine())}`);
  printTable(
    [
      "scenario",
      "policy",
      "entries",
      "writes",
      "agent reads",
      "seals / hour",
      "by reason",
      "class A",
      "class B",
      "longest write wait s",
      "longest audit wait s",
    ],
    rows.map((row) => [
      row.scenario,
      row.policy,
      row.entries,
      row.writes,
      row.agentReads,
      row.sealsPerHour.toFixed(0),
      Object.entries(row.byReason)
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} ${n}`)
        .join(", "),
      row.classA,
      row.classB,
      row.longestWriteWaitSeconds.toFixed(1),
      row.longestAuditWaitSeconds.toFixed(0),
    ]),
  );
  const busySeconds = args.number("busy-seconds", 120);
  const busy: BusyRow[] = [];
  for (const [everyMs, bulkLatencyMs] of [
    [100, 0],
    [100, 150],
    [100, 400],
    [500, 150],
    [1000, 150],
  ] as const)
    busy.push(await simulateBusy({ everyMs, bulkLatencyMs, seconds: busySeconds }));
  console.log(
    `\nA book written to faster than the window, ${busySeconds} simulated seconds each (the window is 2 s)`,
  );
  printTable(
    [
      "a write every ms",
      "bulk store latency ms",
      "writes",
      "seals",
      "seals / hour",
      "class A in the run",
      "longest write wait s",
    ],
    busy.map((row) => [
      row.everyMs,
      row.bulkLatencyMs,
      row.writes,
      row.seals,
      row.sealsPerHour,
      row.classA,
      row.longestWriteWaitSeconds.toFixed(1),
    ]),
  );
  const json = args.string("json", "");
  if (json)
    writeFileSync(json, `${JSON.stringify({ hours, machine: machine(), rows, busy }, null, 2)}\n`);
}

await main();

import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VirtualClock } from "../../src/clock.ts";
import { compactOnce } from "../../src/compactor.ts";
import { MemoryObjectStore } from "../../src/memory.ts";
import { LeaseHeldElsewhereError } from "../../src/lease.ts";
import { readLog } from "../../src/logreader.ts";
import { BookKeys } from "../../src/objectstore.ts";
import { SimPodClock } from "../../src/podclock.ts";
import { Rng } from "../../src/rng.ts";
import { BookRuntime, type BookRuntimeOptions } from "../../src/runtime.ts";
import { MemoryLogTier } from "../../src/tier-memory.ts";
import { GENESIS_HASH, type LogTier } from "../../src/tier.ts";
import type { ObjectStore } from "../../src/objectstore.ts";
import type { FaultRates, LatencyModel } from "../../src/wire.ts";

/** A small application with the properties the real one has: every write carries an operation
 * identity and is deduplicated on it, in the same transaction as its effects. */
export const SIM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, k TEXT NOT NULL, amount INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS derived (k TEXT PRIMARY KEY, v);
`;
export const SIM_EXCLUDE = ["derived"];

export interface SimOp {
  readonly id: string;
  readonly key: string;
  readonly amount: number;
}

export function applyOp(db: Database, op: SimOp): string {
  db.exec(SIM_SCHEMA);
  const done = db.query("SELECT result FROM ops WHERE id=?").get(op.id) as {
    result: string;
  } | null;
  if (done) return done.result;
  db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v", [
    op.key,
    op.amount,
  ]);
  db.run("INSERT INTO events (op, k, amount) VALUES (?, ?, ?)", [op.id, op.key, op.amount]);
  db.run("INSERT INTO derived (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [
    op.key,
    op.amount,
  ]);
  const total = (db.query("SELECT v FROM kv WHERE k=?").get(op.key) as { v: number }).v;
  db.run("INSERT INTO ops (id, result) VALUES (?, ?)", [op.id, String(total)]);
  return String(total);
}

export interface SimConfig {
  readonly seed: number;
  readonly slots: number;
  readonly clients: number;
  readonly ops: number;
  readonly events: number;
  readonly horizonMs: number;
  readonly tierLatency: LatencyModel;
  readonly bulkLatency: LatencyModel;
  readonly tierFaults: FaultRates;
  readonly bulkFaults: FaultRates;
  readonly visibilityDelayMs: number;
  readonly leaseTtlMs: number;
  readonly drift: number;
  /** The lease check that notices a frozen or stepped process by comparing the wall clock with the
   * monotonic one. Off, a suspended machine believes its lease on waking. */
  readonly wallGuard: boolean;
  /** The drift the lease assumes a monotonic clock may have (the process divides the lease by 1 plus this). */
  readonly assumedDrift: number;
  readonly sealDelayMs: number;
  readonly snapshotEvery: number;
  readonly requestTimeoutMs: number;
  readonly maxTries: number;
  readonly diskSurvives: number;
  /** How many reads a client makes for every write (0: none). A read must show every operation that
   * was acknowledged before the read began. */
  readonly readRatio: number;
  /** How many of the lifecycle events are pauses, partitions and clock steps (the rest as before). */
  readonly stress: "mixed" | "leases";
  /** Every other pod starts as a standby: it reads the book without the lease, follows the log, and
   * takes the book over as soon as the lease is free, instead of taking the lease first. */
  readonly standby?: boolean;
}

/** A schedule drawn from the seed: how many pods, how rough the network, how often processes die. */
export function randomConfig(seed: number): SimConfig {
  const rng = new Rng(seed ^ 0x9e3779b9);
  const rough = rng.chance(0.5);
  const unsafe = rng.chance(0.15);
  const rate = (max: number) => (rng.chance(0.6) ? rng.next() * max : 0);
  return {
    seed,
    slots: rng.between(1, 3),
    clients: rng.between(1, 3),
    ops: rng.between(8, 30),
    events: rng.between(0, 6),
    horizonMs: 30_000,
    tierLatency: { medianMs: rng.between(1, 40), sigma: rough ? 1.1 : 0.4 },
    bulkLatency: { medianMs: rng.between(5, 120), sigma: rough ? 1.1 : 0.4 },
    tierFaults: rough
      ? {
          failBefore: rate(0.05),
          failAfter: rate(0.05),
          duplicate: rate(0.04),
          killAfter: rate(0.008),
          killBefore: rate(0.005),
        }
      : {},
    bulkFaults: rough
      ? {
          failBefore: rate(0.08),
          failAfter: rate(0.05),
          duplicate: rate(0.04),
          killAfter: rate(0.004),
        }
      : {},
    visibilityDelayMs: rng.chance(0.3) ? rng.between(1, 200) : 0,
    leaseTtlMs: rng.between(1500, 5000),
    drift: unsafe ? 0.3 + rng.next() * 0.6 : rng.chance(0.5) ? rng.next() * 0.008 : 0,
    wallGuard: !unsafe,
    assumedDrift: unsafe ? 0 : 0.01,
    sealDelayMs: rng.between(20, 600),
    snapshotEvery: rng.chance(0.5) ? rng.between(3, 9) : 0,
    requestTimeoutMs: 4000,
    maxTries: 14,
    diskSurvives: rng.next(),
    readRatio: 0,
    stress: "mixed",
    // Drawn last, so that the other dimensions of a seed are what they were.
    standby: rng.chance(0.3),
  };
}

export interface SimReport {
  readonly seed: number;
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly acked: number;
  readonly gaveUp: number;
  readonly entries: number;
  readonly kills: number;
  readonly commits: number;
  readonly conflicts: number;
  readonly uncertain: number;
  readonly resolvedOurs: number;
  readonly rebuilds: number;
  readonly catchUps: number;
  readonly opens: number;
  readonly fenceRefusals: number;
  readonly sealedSegments: number;
  readonly snapshots: number;
  readonly virtualMs: number;
  readonly reads: number;
  readonly staleReads: number;
  /** Accepted appends whose fence was not the newest granted before them. */
  readonly staleFenceAccepted: number;
  /** Times two different processes held a lease on the tail's clock at once. */
  readonly leaseOverlaps: number;
}

/** A process frozen for a while (a stop-the-world collection, a stopped container): until it is
 * resumed, nothing it does reaches the tail or the bucket and nothing they say reaches it. Its
 * monotonic clock keeps running, as it does in a stopped process. */
class PauseGate {
  #paused = false;
  readonly #waiters: (() => void)[] = [];
  pause(): void {
    this.#paused = true;
  }
  resume(): void {
    this.#paused = false;
    for (const wake of this.#waiters.splice(0)) wake();
  }
  async wait(): Promise<void> {
    while (this.#paused) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
}

function pausableTier(inner: LogTier, gate: PauseGate): LogTier {
  const wrap =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await gate.wait();
      const result = await call(...args);
      await gate.wait();
      return result;
    };
  return {
    capabilities: inner.capabilities,
    head: wrap(inner.head.bind(inner)),
    readFrom: wrap(inner.readFrom.bind(inner)),
    append: wrap(inner.append.bind(inner)),
    acquire: wrap(inner.acquire.bind(inner)),
    renew: wrap(inner.renew.bind(inner)),
    release: wrap(inner.release.bind(inner)),
    seal: wrap(inner.seal.bind(inner)),
  };
}

function pausableStore(inner: ObjectStore, gate: PauseGate): ObjectStore {
  const wrap =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await gate.wait();
      const result = await call(...args);
      await gate.wait();
      return result;
    };
  return {
    putIfAbsent: wrap(inner.putIfAbsent.bind(inner)),
    get: wrap(inner.get.bind(inner)),
    head: wrap(inner.head.bind(inner)),
    list: wrap(inner.list.bind(inner)),
    delete: wrap(inner.delete.bind(inner)),
  };
}

class SimPod {
  incarnation = 0;
  podClock: SimPodClock | null = null;
  runtime: BookRuntime | null = null;
  #opening: Promise<BookRuntime> | null = null;
  readonly clock: VirtualClock;
  constructor(
    readonly slot: number,
    private readonly sim: Sim,
  ) {
    this.clock = sim.clock;
  }
  get holder(): string {
    return `pod-${this.slot}#${this.incarnation}`;
  }
  get alive(): boolean {
    return !this.sim.deadHolders.has(this.holder);
  }

  async serve(op: SimOp): Promise<string> {
    const runtime = await this.#runtime();
    return runtime.write((db) => applyOp(db, op), { opId: op.id });
  }

  async serveRead(): Promise<ReadonlySet<string>> {
    const runtime = await this.#runtime();
    return runtime.read(
      (db) =>
        new Set(
          (db.query("SELECT id FROM ops").values() as string[][]).map((row) => row[0] as string),
        ),
    );
  }

  #runtime(): Promise<BookRuntime> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (!this.#opening) {
      const holder = this.holder;
      const { config } = this.sim;
      const pod = new SimPodClock(this.clock, { rate: 1 - config.drift });
      this.podClock = pod;
      const gate = new PauseGate();
      this.sim.gates.set(holder, gate);
      const options: BookRuntimeOptions = {
        tier: pausableTier(this.sim.tier.client(holder), gate),
        bulk: pausableStore(this.sim.bulk.client(holder), gate),
        bookId: "b1",
        prefix: "runs/sim/",
        holder,
        path: join(this.sim.directory, `slot-${this.slot}.sqlite`),
        schema: 1,
        exclude: SIM_EXCLUDE,
        clock: this.clock,
        pod,
        lease: {
          ttlMs: config.leaseTtlMs,
          driftBound: config.assumedDrift,
          ...(config.wallGuard ? {} : { skewToleranceMs: 1e12 }),
        },
        sealing: { delayMs: config.sealDelayMs },
        snapshots: { everyEntries: config.snapshotEvery },
        commit: { backoffMs: 10 },
      };
      const standby = config.standby === true && this.slot % 2 === 1;
      this.#opening = (standby ? this.#takeOver(options) : BookRuntime.open(options)).then(
        (runtime) => {
          if (this.sim.deadHolders.has(holder) || this.holder !== holder) {
            runtime.abandon();
            try {
              runtime.db.close();
            } catch {
              // already closed
            }
            this.sim.kill(holder);
            throw new Error("the process died while opening");
          }
          this.runtime = runtime;
          this.sim.runtimes.push(runtime);
          this.sim.byHolder.set(holder, runtime);
          return runtime;
        },
        (error) => {
          this.#opening = null;
          throw error;
        },
      );
    }
    return this.#opening;
  }

  /** Open as a standby: read the book without the lease, follow the log for a while, and take the book
   * as soon as its lease is free. */
  async #takeOver(options: BookRuntimeOptions): Promise<BookRuntime> {
    const runtime = await BookRuntime.openStandby(options);
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await runtime.follow();
        try {
          await runtime.promote();
          return runtime;
        } catch (error) {
          if (!(error instanceof LeaseHeldElsewhereError)) throw error;
        }
        await this.clock.sleep(100);
      }
      throw new LeaseHeldElsewhereError("another process", 0);
    } catch (error) {
      // Not taken: the process stops as one that gave up would, and the lease it may hold lapses.
      runtime.abandon();
      try {
        runtime.db.close();
      } catch {
        // already closed
      }
      throw error;
    }
  }

  /** The process is gone: its connections close and its pending calls never answer. */
  die(): void {
    this.sim.kill(this.holder);
  }

  stepWall(deltaMs: number): void {
    this.podClock?.stepWall(deltaMs);
  }
  suspend(ms: number): void {
    this.podClock?.suspend(ms);
  }

  /** Forget the process this pod pointed at (it was killed, perhaps by the network, mid-call). */
  forget(): void {
    this.runtime = null;
    this.#opening = null;
  }

  restart(diskSurvives: boolean): void {
    if (this.alive) this.die();
    this.incarnation += 1;
    if (!diskSurvives) {
      const path = join(this.sim.directory, `slot-${this.slot}.sqlite`);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  }

  async shutDown(): Promise<void> {
    let runtime = this.runtime;
    const holder = this.holder;
    // A process still in the middle of opening comes up holding the lease: wait for it, then let go.
    if (!runtime && this.#opening)
      runtime = await Promise.race([
        this.#opening.catch(() => null),
        this.clock.sleep(10_000).then(() => null),
      ]);
    if (!runtime || !this.alive) return;
    this.runtime = null;
    this.#opening = null;
    const closed = await Promise.race([
      runtime.close().then(
        () => true,
        () => true,
      ),
      this.clock.sleep(15_000).then(() => false),
    ]);
    // A process that cannot stop itself is stopped from outside, as an orchestrator would.
    if (!closed) this.sim.kill(holder);
  }
}

export class Sim {
  readonly clock = new VirtualClock();
  readonly tier: MemoryLogTier;
  readonly bulk: MemoryObjectStore;
  readonly keys = new BookKeys("runs/sim/", "b1");
  readonly deadHolders = new Set<string>();
  readonly pods: SimPod[] = [];
  readonly acked = new Set<string>();
  readonly specs = new Map<string, SimOp>();
  readonly violations: string[] = [];
  /** Every runtime any pod ever opened, for the totals. */
  readonly runtimes: BookRuntime[] = [];
  readonly byHolder = new Map<string, BookRuntime>();
  readonly gates = new Map<string, PauseGate>();
  readonly ackedAt = new Map<string, number>();
  readonly readLog: { start: number; end: number; ids: ReadonlySet<string>; pod: string }[] = [];
  kills = 0;
  gaveUp = 0;
  snapshots = 0;
  /** A hook between the end of the workload and the checks (the negative control uses it). */
  afterClients: (() => void) | null = null;

  constructor(
    readonly config: SimConfig,
    readonly directory: string,
  ) {
    this.tier = new MemoryLogTier({
      clock: this.clock,
      seed: config.seed,
      latency: config.tierLatency,
      faults: config.tierFaults,
      timeoutMs: 1500,
    });
    this.bulk = new MemoryObjectStore({
      clock: this.clock,
      seed: config.seed + 1,
      latency: config.bulkLatency,
      faults: config.bulkFaults,
      timeoutMs: 1500,
      ...(config.visibilityDelayMs ? { visibilityDelayMs: config.visibilityDelayMs } : {}),
    });
    for (let slot = 0; slot < config.slots; slot += 1) this.pods.push(new SimPod(slot, this));
    const onKill = (client: string) => {
      if (this.deadHolders.has(client)) return;
      this.kills += 1;
      this.kill(client);
    };
    this.tier.wire.onKill(onKill);
    this.bulk.onKill(onKill);
  }

  /** Kill a process by its holder name, whoever's idea it was: the network's (a fault that fires
   * while it is mid-call) or the schedule's. Its connections close, its calls never answer. */
  kill(holder: string): void {
    if (this.deadHolders.has(holder)) return;
    this.deadHolders.add(holder);
    this.tier.kill(holder);
    this.bulk.kill(holder);
    const runtime = this.byHolder.get(holder);
    if (runtime) {
      runtime.abandon();
      try {
        runtime.db.close();
      } catch {
        // already closed
      }
    }
    const pod = this.pods.find((candidate) => candidate.holder === holder);
    if (pod) pod.forget();
  }

  async run(): Promise<SimReport> {
    const { config } = this;
    mkdirSync(this.directory, { recursive: true });
    const rng = new Rng(config.seed);
    const ops: SimOp[] = Array.from({ length: config.ops }, (_, index) => ({
      id: `op-${config.seed}-${index}`,
      key: "abc"[rng.int(3)] as string,
      amount: rng.between(1, 9),
    }));
    for (const op of ops) this.specs.set(op.id, op);

    const clients = Array.from({ length: config.clients }, (_, index) =>
      this.#client(
        ops.filter((_, at) => at % config.clients === index),
        new Rng(config.seed * 31 + index),
      ),
    );
    const lifecycle = this.#lifecycle(new Rng(config.seed * 17 + 5));
    await this.clock.drive(Promise.all([...clients, lifecycle]));
    this.afterClients?.();

    // Everything that can still go wrong has gone wrong. Stop the faults, let the pods go, and look.
    this.tier.configure({ faults: {} });
    this.tier.wire.clearScript();
    this.bulk.configure({ faults: {} });
    this.bulk.wire.clearScript();
    await this.clock.drive(
      (async () => {
        for (const pod of this.pods) {
          this.#trace(`shutting down ${pod.holder}`);
          await pod.shutDown();
        }
        this.#trace("pods down; waiting for leases to lapse");
        await this.clock.sleep(config.leaseTtlMs * 3);
        this.#trace("verifying");
        await this.#verify();
        this.#trace("verified");
      })(),
    );
    return this.#report();
  }

  #trace(message: string): void {
    if (process.env.BOOKLOG_SIM_TRACE)
      console.error(`[sim ${this.config.seed} @${Math.round(this.clock.now())}] ${message}`);
  }

  async #client(ops: readonly SimOp[], rng: Rng): Promise<void> {
    for (const op of ops) {
      await this.clock.sleep(rng.int(300));
      let acknowledged = false;
      for (let attempt = 1; attempt <= this.config.maxTries && !acknowledged; attempt += 1) {
        const pod = this.pods[rng.int(this.pods.length)] as SimPod;
        if (!pod.alive) pod.restart(rng.chance(this.config.diskSurvives));
        const outcome = await Promise.race([
          pod.serve(op).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          ),
          this.clock.sleep(this.config.requestTimeoutMs).then(() => ({ timeout: true })),
        ]);
        if ("value" in outcome) {
          acknowledged = true;
          this.acked.add(op.id);
          this.ackedAt.set(op.id, this.clock.now());
        } else await this.clock.sleep(50 + rng.int(400));
      }
      if (!acknowledged) this.gaveUp += 1;
      for (let read = 0; read < this.config.readRatio; read += 1) await this.#readOnce(rng);
    }
  }

  /** One read at a random pod; if it answers, remember when it began, when it answered and what it showed. */
  async #readOnce(rng: Rng): Promise<void> {
    await this.clock.sleep(rng.int(200));
    const pod = this.pods[rng.int(this.pods.length)] as SimPod;
    if (!pod.alive) return;
    const start = this.clock.now();
    const holder = pod.holder;
    const outcome = await Promise.race([
      pod.serveRead().then(
        (ids) => ({ ids }),
        () => ({ failed: true }),
      ),
      this.clock.sleep(this.config.requestTimeoutMs).then(() => ({ timeout: true })),
    ]);
    if ("ids" in outcome)
      this.readLog.push({ start, end: this.clock.now(), ids: outcome.ids, pod: holder });
  }

  async #lifecycle(rng: Rng): Promise<void> {
    for (let index = 0; index < this.config.events; index += 1) {
      await this.clock.sleep(rng.between(100, 3000));
      const pod = this.pods[rng.int(this.pods.length)] as SimPod;
      if (this.config.stress === "leases") {
        await this.#leaseStress(pod, rng);
        continue;
      }
      const dice = rng.int(11);
      if (dice < 4) {
        this.kills += 1;
        pod.restart(rng.chance(this.config.diskSurvives));
      } else if (dice < 6) {
        await pod.shutDown();
        // However it ended, that process is over: a new one takes the slot.
        this.kill(pod.holder);
        pod.incarnation += 1;
      } else if (dice < 8) {
        // The tail is unreachable for a while.
        const before = this.config.tierFaults;
        this.tier.configure({ faults: { failBefore: 1 } });
        await this.clock.sleep(rng.between(200, 3000));
        this.tier.configure({ faults: before });
      } else if (dice === 8) {
        // The process freezes for longer than its lease, then wakes up and carries on.
        const gate = this.gates.get(pod.holder);
        if (gate && pod.alive) {
          gate.pause();
          await this.clock.sleep(
            rng.between(Math.round(this.config.leaseTtlMs * 0.4), this.config.leaseTtlMs * 3),
          );
          gate.resume();
        }
      } else {
        // The janitor is a process like any other: it can be killed mid-call, and a killed process
        // never answers, so the schedule does not wait for it.
        const keys = new BookKeys("runs/sim/", "b1");
        const janitor = `janitor#${index}`;
        await Promise.race([
          compactOnce({
            bulk: this.bulk.client(janitor),
            keys,
            minSegments: 2,
            clock: this.clock,
          }).catch(() => {}),
          this.clock.sleep(20_000),
        ]);
      }
    }
  }

  /** Things that go wrong for a lease: a frozen process, an unreachable tail, a stepped or
   * stopped clock, a process that comes back from the dead. */
  async #leaseStress(pod: SimPod, rng: Rng): Promise<void> {
    const ttl = this.config.leaseTtlMs;
    const gate = this.gates.get(pod.holder);
    const kind = rng.int(5);
    if (kind === 0 && gate && pod.alive) {
      gate.pause();
      await this.clock.sleep(rng.between(Math.round(ttl * 0.3), ttl * 3));
      gate.resume();
    } else if (kind === 1) {
      // The tail cannot be reached by anyone for a while.
      const before = this.config.tierFaults;
      this.tier.configure({ faults: { failBefore: 1 } });
      await this.clock.sleep(rng.between(Math.round(ttl * 0.3), ttl * 3));
      this.tier.configure({ faults: before });
    } else if (kind === 2) {
      pod.stepWall(rng.chance(0.5) ? rng.between(5_000, 3_600_000) : -rng.between(5_000, 600_000));
    } else if (kind === 3 && gate && pod.alive) {
      // The whole machine is suspended: nothing runs, and the monotonic clock stops with it.
      const length = rng.between(Math.round(ttl * 0.5), ttl * 4);
      gate.pause();
      pod.suspend(length);
      await this.clock.sleep(length);
      gate.resume();
    } else {
      pod.restart(rng.chance(this.config.diskSurvives));
      this.kills += 1;
    }
  }

  async #verify(): Promise<void> {
    const { config } = this;
    const fail = (message: string) => this.violations.push(message);

    // I2 and I4: the log, read whole, is one hash chain with one entry per sequence number.
    const entries: { seq: number; hash: string; opId: string | null }[] = [];
    try {
      const reader = readLog({
        tier: this.tier,
        bulk: this.bulk,
        keys: this.keys,
        schema: 1,
        after: { seq: 0, hash: GENESIS_HASH },
      });
      for (let step = await reader.next(); !step.done; step = await reader.next())
        entries.push({
          seq: step.value.header.seq,
          hash: step.value.header.hash,
          opId: step.value.header.opId,
        });
    } catch (error) {
      fail(
        `I2: the log does not read as one chain (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    entries.forEach((entry, index) => {
      if (entry.seq !== index + 1)
        fail(`I4: entry ${index + 1} is missing or doubled (found ${entry.seq})`);
    });
    const appended = new Map<number, Set<string>>();
    for (const record of this.tier.records)
      if (record.op === "append") {
        const set = appended.get(record.seq as number) ?? new Set<string>();
        set.add(record.hash as string);
        appended.set(record.seq as number, set);
      }
    for (const [seq, hashes] of appended)
      if (hashes.size > 1)
        fail(`I4: the tail accepted ${hashes.size} different entries for sequence ${seq}`);
    const head = this.tier.peek("b1").head;
    if (entries.length !== head.seq)
      fail(`I2: the tail's head is ${head.seq}, the log reads to ${entries.length}`);

    // I3 and I1: a fresh process materialized from the log holds exactly the book.
    const holder = "verifier#1";
    let verifier: BookRuntime | null = null;
    try {
      verifier = await BookRuntime.open({
        tier: this.tier.client(holder),
        bulk: this.bulk.client(holder),
        bookId: "b1",
        prefix: "runs/sim/",
        holder,
        path: join(this.directory, "verifier.sqlite"),
        schema: 1,
        exclude: SIM_EXCLUDE,
        clock: this.clock,
        pod: new SimPodClock(this.clock),
        lease: { ttlMs: config.leaseTtlMs },
        sealing: { delayMs: 0 },
      });
    } catch (error) {
      fail(
        `I3: a fresh process could not materialize the book (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (verifier) {
      const db = verifier.db;
      const events = db.query("SELECT op, k, amount FROM events ORDER BY id").all() as {
        op: string;
        k: string;
        amount: number;
      }[];
      const seen = new Set<string>();
      for (const row of events) {
        if (seen.has(row.op)) fail(`I3: operation ${row.op} was applied more than once`);
        seen.add(row.op);
        const spec = this.specs.get(row.op);
        if (!spec) fail(`I3: operation ${row.op} is in the book and was never sent`);
        else if (spec.key !== row.k || spec.amount !== row.amount)
          fail(`I3: operation ${row.op} was recorded with other values`);
      }
      for (const id of this.acked)
        if (!seen.has(id)) fail(`I1: operation ${id} was acknowledged and is not in the book`);
      const expected = new Map<string, number>();
      for (const row of events) expected.set(row.k, (expected.get(row.k) ?? 0) + row.amount);
      const kv = db.query("SELECT k, v FROM kv").all() as { k: string; v: number }[];
      for (const row of kv)
        if (expected.get(row.k) !== row.v)
          fail(`I3: ${row.k} holds ${row.v}, the operations add up to ${expected.get(row.k)}`);
      if (kv.length !== expected.size)
        fail("I3: the keys of the book are not those of its operations");
      const opsRows = (db.query("SELECT count(*) c FROM ops").get() as { c: number }).c;
      if (opsRows !== events.length) fail("I3: the operation ledger and the events disagree");
      // Two ways of materializing the book agree: the first came from the newest snapshot there is,
      // the second reads the whole log from its first entry.
      const hashA = verifier.capture.stateHash();
      await verifier.close({ seal: false });
      const second = "verifier#2";
      let other: BookRuntime | null = null;
      try {
        other = await BookRuntime.open({
          tier: this.tier.client(second),
          bulk: this.bulk.client(second),
          bookId: "b1",
          prefix: "runs/sim/",
          holder: second,
          path: join(this.directory, "verifier2.sqlite"),
          schema: 1,
          exclude: SIM_EXCLUDE,
          clock: this.clock,
          pod: new SimPodClock(this.clock),
          lease: { ttlMs: config.leaseTtlMs },
          sealing: { delayMs: 0 },
          materialize: { snapshotsToTry: 0, reuse: false },
        });
        if (other.capture.stateHash() !== hashA)
          fail("I3: the snapshot-and-tail route and the whole-log route build different books");
      } catch (error) {
        fail(
          `I3: the second fresh process failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      await other?.close({ seal: false });
    }
  }

  /** Reads that missed an operation acknowledged before they began; appends accepted with an old
   * fence; leases that overlapped on the tail's clock. */
  #leaseFindings(): { stale: number; fence: number; overlaps: number } {
    let stale = 0;
    for (const read of this.readLog)
      for (const [id, at] of this.ackedAt)
        if (at < read.start && !read.ids.has(id)) {
          stale += 1;
          break;
        }
    let fence = 0;
    let newest = 0;
    let overlaps = 0;
    let holder: string | null = null;
    let until = 0;
    for (const record of this.tier.records) {
      if (record.op === "grant") {
        // Tokens must grow with every new holder; the holder asking again inside its lease keeps its own.
        const again = record.fence === newest && record.holder === holder;
        if ((record.fence as number) <= newest && !again) fence += 1;
        newest = record.fence as number;
        if (holder !== null && holder !== record.holder && record.at < until) overlaps += 1;
        holder = record.holder as string;
        until = record.expiresAt as number;
      } else if (record.op === "renew") {
        if (record.fence === newest) until = record.expiresAt as number;
      } else if (record.op === "release") {
        // The record carries the token after the release: letting go retires the old one.
        until = record.at;
        newest = Math.max(newest, record.fence as number);
        holder = null;
      } else if (record.op === "append") {
        if ((record.fence as number) !== newest) fence += 1;
      }
    }
    return { stale, fence, overlaps };
  }

  #report(): SimReport {
    const findings = this.#leaseFindings();
    const stats = this.runtimes.reduce(
      (sum, runtime) => ({
        commits: sum.commits + runtime.stats.commits,
        conflicts: sum.conflicts + runtime.stats.conflicts,
        uncertain: sum.uncertain + runtime.stats.uncertain,
        resolvedOurs: sum.resolvedOurs + runtime.stats.resolvedOurs,
        rebuilds: sum.rebuilds + runtime.stats.rebuilds,
        catchUps: sum.catchUps + runtime.stats.catchUps,
      }),
      { commits: 0, conflicts: 0, uncertain: 0, resolvedOurs: 0, rebuilds: 0, catchUps: 0 },
    );
    return {
      seed: this.config.seed,
      ok: this.violations.length === 0,
      violations: this.violations,
      acked: this.acked.size,
      gaveUp: this.gaveUp,
      entries: this.tier.peek("b1").head.seq,
      kills: this.kills,
      ...stats,
      opens: this.runtimes.length,
      fenceRefusals: this.tier.refusals.append.fence,
      sealedSegments: this.bulk.keys(this.keys.sealedPrefix).length,
      snapshots: this.bulk.keys(this.keys.snapPrefix).filter((key) => key.endsWith(".sqlite.gz"))
        .length,
      virtualMs: this.clock.now(),
      reads: this.readLog.length,
      staleReads: findings.stale,
      staleFenceAccepted: findings.fence,
      leaseOverlaps: findings.overlaps,
    };
  }
}

export async function runSimulation(
  seed: number,
  directory: string,
  override: Partial<SimConfig> = {},
): Promise<SimReport> {
  const sim = new Sim({ ...randomConfig(seed), ...override }, directory);
  try {
    return await sim.run();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The report of a run that could not finish. */
export function failedReport(seed: number, message: string): SimReport {
  return {
    seed,
    ok: false,
    violations: [message],
    acked: 0,
    gaveUp: 0,
    entries: 0,
    kills: 0,
    commits: 0,
    conflicts: 0,
    uncertain: 0,
    resolvedOurs: 0,
    rebuilds: 0,
    catchUps: 0,
    opens: 0,
    fenceRefusals: 0,
    sealedSegments: 0,
    snapshots: 0,
    virtualMs: 0,
    reads: 0,
    staleReads: 0,
    staleFenceAccepted: 0,
    leaseOverlaps: 0,
  };
}

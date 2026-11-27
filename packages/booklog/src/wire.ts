import { systemClock, type Clock } from "./clock.ts";
import { ObjectStoreUncertain } from "./objectstore.ts";
import { Rng } from "./rng.ts";

/** What can go wrong with one request, on the way to a service and back:
 *  - failBefore: a 5xx before the request was applied (the client cannot tell it from failAfter).
 *  - failAfter:  the request was applied, then the response was lost; the client times out.
 *  - duplicate:  the request was delivered twice (a retry inside the HTTP client after a lost
 *                response) and the client sees the second delivery's answer: for a create-only
 *                write that is "412, it already exists" about a write that was its own.
 *  - killBefore: the calling process dies before the request is sent.
 *  - killAfter:  the calling process dies after the request was applied, before it saw the answer. */
export type FaultKind = "failBefore" | "failAfter" | "duplicate" | "killBefore" | "killAfter";
export const FAULT_KINDS: readonly FaultKind[] = [
  "failBefore",
  "failAfter",
  "duplicate",
  "killBefore",
  "killAfter",
];

/** Probabilities per request, each in [0, 1], summing to at most 1. */
export type FaultRates = { readonly [kind in FaultKind]?: number };

/** A round trip with a log-normal tail: half the median each way. */
export interface LatencyModel {
  readonly medianMs: number;
  readonly sigma?: number;
  readonly floorMs?: number;
}

export interface ScriptedFault<Op extends string> {
  readonly op: Op;
  /** A key, or a pattern it must match; any key when absent. */
  readonly key?: string | RegExp;
  /** One client's calls only. */
  readonly client?: string;
  /** Fire on the n-th matching call (1-based); every matching call when absent. */
  readonly nth?: number;
  /** Stop after this many firings (every `nth` rule fires once). */
  readonly times?: number;
  readonly fault: FaultKind;
}

export interface WireOptions<Op extends string> {
  /** Root of every random stream: the same seed and the same calls give the same faults. */
  readonly seed?: number;
  readonly clock?: Clock;
  readonly latency?: LatencyModel | { readonly [op in Op]?: LatencyModel };
  readonly faults?: FaultRates | { readonly [op in Op]?: FaultRates };
  /** What a lost response costs the client before it gives up. */
  readonly timeoutMs?: number;
}

const never = (): Promise<never> => new Promise<never>(() => {});

/** The network between a client process and a simulated service: latency, scripted and random
 * faults, and processes that die. Every simulated service (the object store, the log tier) puts
 * each of its requests through one, so a simulation can kill a client mid-call and leave the
 * others running, and the same seed gives the same faults. The service's own effect runs
 * atomically at the moment the request arrives. */
export class Wire<Op extends string> {
  readonly clock: Clock;
  readonly #ops: readonly Op[];
  readonly #seed: number;
  #latency: WireOptions<Op>["latency"];
  #faults: WireOptions<Op>["faults"];
  #timeoutMs: number;
  readonly #dead = new Set<string>();
  readonly #killListeners: ((client: string) => void)[] = [];
  readonly #scripted: { rule: ScriptedFault<Op>; seen: number; fired: number }[] = [];
  readonly #streams = new Map<string, Rng>();
  readonly #opNames: ReadonlySet<string>;
  calls: Record<string, number> = {};
  faultsSeen: Record<FaultKind, number> = {
    failBefore: 0,
    failAfter: 0,
    duplicate: 0,
    killBefore: 0,
    killAfter: 0,
  };

  constructor(ops: readonly Op[], options: WireOptions<Op> = {}) {
    this.#ops = ops;
    this.#opNames = new Set(ops);
    this.clock = options.clock ?? systemClock;
    this.#seed = options.seed ?? 0;
    this.#latency = options.latency;
    this.#faults = options.faults;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.resetCounts();
  }

  configure(options: Pick<WireOptions<Op>, "latency" | "faults" | "timeoutMs">): void {
    if ("latency" in options) this.#latency = options.latency;
    if ("faults" in options) this.#faults = options.faults;
    if (options.timeoutMs !== undefined) this.#timeoutMs = options.timeoutMs;
  }

  resetCounts(): void {
    this.calls = Object.fromEntries(this.#ops.map((op) => [op, 0]));
    this.faultsSeen = { failBefore: 0, failAfter: 0, duplicate: 0, killBefore: 0, killAfter: 0 };
  }

  /** The calling process dies: every call it has in flight or makes later never answers. */
  kill(client: string): void {
    if (this.#dead.has(client)) return;
    this.#dead.add(client);
    for (const listener of this.#killListeners) listener(client);
  }
  isDead(client: string): boolean {
    return this.#dead.has(client);
  }
  onKill(listener: (client: string) => void): void {
    this.#killListeners.push(listener);
  }

  /** Faults for specific calls, taking precedence over the random ones. */
  script(rules: readonly ScriptedFault<Op>[]): void {
    for (const rule of rules) this.#scripted.push({ rule, seen: 0, fired: 0 });
  }
  clearScript(): void {
    this.#scripted.length = 0;
  }

  /** Run `effect` as one request from `client`. `duplicate` runs it twice and answers with the
   * second result. */
  async call<T>(client: string, op: Op, key: string, effect: () => T): Promise<T> {
    if (this.#dead.has(client)) return never();
    const fault = this.#choose(client, op, key);
    const model = this.#model(op);
    await this.#travel(model);
    if (this.#dead.has(client)) return never();
    if (fault === "killBefore") {
      this.faultsSeen.killBefore += 1;
      this.kill(client);
      return never();
    }
    if (fault === "failBefore") {
      this.faultsSeen.failBefore += 1;
      await this.#travel(model);
      throw new ObjectStoreUncertain(
        `${op} ${key}: simulated 503, the request was not applied`,
        503,
        "InternalError",
      );
    }
    this.calls[op] = (this.calls[op] ?? 0) + 1;
    let result = effect();
    if (fault === "duplicate") {
      this.faultsSeen.duplicate += 1;
      this.calls[op] = (this.calls[op] ?? 0) + 1;
      result = effect();
    }
    if (fault === "killAfter") {
      this.faultsSeen.killAfter += 1;
      this.kill(client);
      return never();
    }
    if (fault === "failAfter") {
      this.faultsSeen.failAfter += 1;
      await this.clock.sleep(this.#timeoutMs);
      throw new ObjectStoreUncertain(
        `${op} ${key}: no response within ${this.#timeoutMs} ms`,
        undefined,
        "RequestTimeout",
      );
    }
    await this.#travel(model);
    if (this.#dead.has(client)) return never();
    return result;
  }

  async #travel(model: LatencyModel | undefined): Promise<void> {
    if (!model || model.medianMs <= 0) return;
    const draw = this.stream("latency").lognormal(model.medianMs / 2, model.sigma ?? 0.5);
    await this.clock.sleep(Math.max(model.floorMs ?? 0, draw));
  }

  #model(op: Op): LatencyModel | undefined {
    const latency = this.#latency;
    if (!latency) return undefined;
    return this.#perOp(latency)
      ? (latency as { [o in Op]?: LatencyModel })[op]
      : (latency as LatencyModel);
  }

  #perOp(value: object): boolean {
    return Object.keys(value).some((key) => this.#opNames.has(key));
  }

  #choose(client: string, op: Op, key: string): FaultKind | undefined {
    for (const entry of this.#scripted) {
      const rule = entry.rule;
      if (rule.op !== op) continue;
      if (rule.client !== undefined && rule.client !== client) continue;
      if (typeof rule.key === "string" && rule.key !== key) continue;
      if (rule.key instanceof RegExp && !rule.key.test(key)) continue;
      entry.seen += 1;
      const limit = rule.times ?? (rule.nth === undefined ? Number.POSITIVE_INFINITY : 1);
      if (entry.fired >= limit) continue;
      if (rule.nth !== undefined && entry.seen !== rule.nth) continue;
      entry.fired += 1;
      return rule.fault;
    }
    const faults = this.#faults;
    if (!faults) return undefined;
    const rates = this.#perOp(faults)
      ? (faults as { [o in Op]?: FaultRates })[op]
      : (faults as FaultRates);
    if (!rates) return undefined;
    const draw = this.stream(`fault:${op}`).next();
    let edge = 0;
    for (const kind of FAULT_KINDS) {
      edge += rates[kind] ?? 0;
      if (draw < edge) return kind;
    }
    return undefined;
  }

  /** A named random stream of this wire (also used by services for their own draws). */
  stream(label: string): Rng {
    let stream = this.#streams.get(label);
    if (!stream) {
      stream = Rng.derive(this.#seed, label);
      this.#streams.set(label, stream);
    }
    return stream;
  }
}

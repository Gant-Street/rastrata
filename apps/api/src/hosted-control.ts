/** Faults and evictions for load and fault experiments on the hosted server, off unless
 * `RASTRATA_BOOK_CONTROL=1`, and only ever on the loopback address the server listens on. With an
 * owner key set, a control request must present it, as every other request does.
 *
 *   GET  /control/status                               which tail and store this process uses, whether the
 *                                                      book is open, what faults are in force
 *   GET  /control/tail                                 { depth, ageSeconds, bytes, seq, sealedThrough }:
 *                                                      the entries not yet sealed, for a tail panel
 *   POST /control/evict  {tenant?}                     stop the book cleanly and delete its cache file: the
 *                                                      next request opens it cold, from the bulk store and
 *                                                      the log
 *   POST /control/fault  {kind, tenant?, seconds}      kind: pause | tail | r2 | clear
 *   POST /control/drain                                refuse writes (503 book_draining) and go on answering
 *                                                      reads: the first half of a handover
 *   POST /control/release {exit?}                      stop the book cleanly and give it up (and, with exit,
 *                                                      end the process): the second half
 *   POST /control/promote                              (a standby) take the book now if its lease is free
 *
 * `pause` freezes the whole process for `seconds` (a stop-the-world pause or a frozen VM): no timer
 * runs meanwhile, so the lease is not renewed, and the clocks go on. `tail` makes every call to the
 * tail fail as an unreachable server does, `r2` every call to the bulk store, for `seconds`. `clear`
 * ends both. A fault sits inside the metering, so the failed calls are counted as failures.
 *
 * Nothing here ever returns an address or a credential: a store is named by its kind. */
import { timingSafeEqual } from "node:crypto";
import {
  ObjectStoreUncertain,
  type LogTier,
  type ObjectStore,
  type RuntimeStats,
} from "@rastrata/booklog";

/** A switch the proxies below consult: while it is on, calls fail. */
export class FaultSwitch {
  #until = 0;
  trip(seconds: number): void {
    this.#until = Date.now() + Math.max(0, seconds) * 1000;
  }
  clear(): void {
    this.#until = 0;
  }
  get active(): boolean {
    return Date.now() < this.#until;
  }
  get remainingSeconds(): number {
    return Math.max(0, Math.round(((this.#until - Date.now()) / 1000) * 10) / 10);
  }
  check(what: string): void {
    if (this.active) throw new ObjectStoreUncertain(`${what}: unreachable (injected)`);
  }
}

/** The tail, failing while `fault` is on. */
export function faultyTier(inner: LogTier, fault: FaultSwitch): LogTier {
  return {
    capabilities: inner.capabilities,
    async head(book) {
      fault.check("tail head");
      return inner.head(book);
    },
    async readFrom(book, seq, limit) {
      fault.check("tail read");
      return inner.readFrom(book, seq, limit);
    },
    async append(book, input) {
      fault.check("tail append");
      return inner.append(book, input);
    },
    async acquire(book, holder, ttl) {
      fault.check("tail acquire");
      return inner.acquire(book, holder, ttl);
    },
    async renew(book, lease, ttl) {
      fault.check("tail renew");
      return inner.renew(book, lease, ttl);
    },
    async release(book, lease) {
      fault.check("tail release");
      return inner.release(book, lease);
    },
    async seal(book, input) {
      fault.check("tail seal");
      return inner.seal(book, input);
    },
  };
}

/** The bulk store, failing while `fault` is on. */
export function faultyStore(inner: ObjectStore, fault: FaultSwitch): ObjectStore {
  return {
    async putIfAbsent(key, body, options) {
      fault.check("object store put");
      return inner.putIfAbsent(key, body, options);
    },
    async get(key) {
      fault.check("object store get");
      return inner.get(key);
    },
    async head(key) {
      fault.check("object store head");
      return inner.head(key);
    },
    async list(prefix, after, limit) {
      fault.check("object store list");
      return inner.list(prefix, after, limit);
    },
    async delete(key) {
      fault.check("object store delete");
      return inner.delete(key);
    },
  };
}

export interface TailStatus {
  readonly seq: number;
  readonly sealedThrough: number;
  readonly depth: number;
  readonly bytes: number;
  readonly ageSeconds: number;
}

export interface ControlOptions {
  readonly bookId: string;
  readonly faults: { readonly tail: FaultSwitch; readonly bulk: FaultSwitch };
  /** Stop the book cleanly and forget its cache file. */
  readonly evict: () => Promise<void>;
  /** What each store is, by kind only (never an address or a credential). */
  readonly kind: { readonly bulk: string; readonly tail: string };
  /** The book's tail as this process sees it, or null when the book is not open. */
  readonly tailStatus: () => TailStatus | null;
  /** The runtime's counters, or null when the book is not open. */
  readonly stats: () => RuntimeStats | null;
  /** What the process is doing with the book: idle, standby, active, draining or released. */
  readonly role: () => string;
  /** Refuse writes from now on; false when there is no book held to drain. */
  readonly drain: () => boolean;
  /** Give the book up cleanly. */
  readonly release: () => Promise<void>;
  /** (A standby) Take the book if its lease is free; false when it was not. */
  readonly promote: () => Promise<boolean>;
  /** End the process (after `release` with `exit`). */
  readonly exit: () => void;
  /** More to put in the status: the lease, the tail's counters (never an address or a key). */
  readonly extra?: () => Record<string, unknown>;
  readonly ownerKey?: string;
}

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function controlRoutes(options: ControlOptions) {
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  return async (request: Request, url: URL): Promise<Response> => {
    if (options.ownerKey) {
      const presented = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!presented || !same(presented, options.ownerKey))
        return json({ error: "The owner key is needed" }, 401);
    }
    if (url.pathname === "/control/status" && request.method === "GET") {
      const stats = options.stats();
      return json({
        hosted: true,
        book: options.bookId,
        role: options.role(),
        tail: options.kind.tail,
        bulk: options.kind.bulk,
        open: options.tailStatus() !== null,
        faults: {
          tail: options.faults.tail.remainingSeconds,
          r2: options.faults.bulk.remainingSeconds,
        },
        tailStatus: options.tailStatus(),
        ...(options.extra?.() ?? {}),
        ...(stats
          ? {
              stats: {
                commits: stats.commits,
                entriesWritten: stats.entriesWritten,
                bytesWritten: stats.bytesWritten,
                conflicts: stats.conflicts,
                uncertain: stats.uncertain,
                rollbacks: stats.rollbacks,
                rebuilds: stats.rebuilds,
                readFlushes: stats.readFlushes,
                readsDeferred: stats.readsDeferred,
                seals: stats.seals,
                activation: stats.activation,
              },
            }
          : {}),
      });
    }
    if (url.pathname === "/control/tail" && request.method === "GET") {
      const status = options.tailStatus();
      return json(
        status ?? { open: false, depth: 0, ageSeconds: 0, bytes: 0, seq: 0, sealedThrough: 0 },
      );
    }
    if (request.method !== "POST") return json({ error: "not found" }, 404);
    let body: { kind?: unknown; seconds?: unknown; exit?: unknown };
    try {
      body = (await request.json()) as { kind?: unknown; seconds?: unknown; exit?: unknown };
    } catch {
      body = {};
    }
    if (url.pathname === "/control/evict") {
      const started = performance.now();
      await options.evict();
      return json({ evicted: true, ms: Math.round(performance.now() - started) });
    }
    if (url.pathname === "/control/drain") return json({ drained: options.drain() });
    if (url.pathname === "/control/promote") return json({ promoted: await options.promote() });
    if (url.pathname === "/control/release") {
      const started = performance.now();
      await options.release();
      if (body.exit === true) setTimeout(() => options.exit(), 50);
      return json({ released: true, ms: Math.round(performance.now() - started) });
    }
    if (url.pathname === "/control/fault") {
      const seconds = Number(body.seconds ?? 10);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600)
        return json({ error: "seconds must be between 0 and 3600" }, 400);
      switch (body.kind) {
        case "tail":
          options.faults.tail.trip(seconds);
          return json({ kind: "tail", seconds });
        case "r2":
          options.faults.bulk.trip(seconds);
          return json({ kind: "r2", seconds });
        case "clear":
          options.faults.tail.clear();
          options.faults.bulk.clear();
          return json({ kind: "clear" });
        case "pause":
          // Answer first, then stop the world.
          setTimeout(() => Bun.sleepSync(seconds * 1000), 20);
          return json({ kind: "pause", seconds });
        default:
          return json({ error: "kind must be pause, tail, r2 or clear" }, 400);
      }
    }
    return json({ error: "not found" }, 404);
  };
}

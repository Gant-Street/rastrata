import type { Database } from "bun:sqlite";
import { counter, histogram, span } from "@rastrata/telemetry";
import { UnsentChangesError, catchUp } from "./apply.ts";
import type { ChangeCapture, Pending } from "./capture.ts";
import { systemClock, type Clock } from "./clock.ts";
import { encodeChangeSet } from "./codec.ts";
import { EntryError, buildEntry, sha256, type BuiltEntry, type EntryKind } from "./entry.ts";
import {
  LeaseHeldElsewhereError,
  LeaseKeeper,
  LeaseLostError,
  type LeaseOptions,
  type PodClock,
} from "./lease.ts";
import { estimateActivationBytes, type ActivationLimiter } from "./limiter.ts";
import { readLog } from "./logreader.ts";
import { materialize, type MaterializeStats } from "./materialize.ts";
import { knownBucket } from "./metrics.ts";
import {
  BookKeys,
  ObjectStoreError,
  ObjectStoreUncertain,
  type ObjectStore,
} from "./objectstore.ts";
import { AsyncRwLock } from "./rwlock.ts";
import { Sealer, type SealOutcome } from "./sealer.ts";
import { reportTail } from "./tail-gauges.ts";
import { TailUnavailableError } from "./tier-guard.ts";
import { compressSnapshot, uploadSnapshot, type SnapshotManifest } from "./snapshot.ts";
import { GENESIS_HASH, type LogTier } from "./tier.ts";

export class CommitConflictError extends Error {
  constructor(
    message = "Someone else changed the book; the operation could not be retried into a clean state",
  ) {
    super(message);
    this.name = "CommitConflictError";
  }
}

/** The entry may or may not be in the log. The cache has been put back to the last entry it knows
 * for sure; the operation can be sent again under its identity and will find out. */
export class CommitUncertainError extends Error {
  constructor(message = "The commit's outcome is not known") {
    super(message);
    this.name = "CommitUncertainError";
  }
}

/** A read changed something replicated and was to be logged before it was answered (an audit row of
 * an agent's request, say), and the entry could not be made durable. The answer is withheld: the
 * request is refused, and can be sent again. */
export class ReadNotLoggedError extends Error {
  constructor(
    readonly reason: unknown,
    message = "The request changed the book (its own record) and that could not be made durable, so it was refused",
  ) {
    super(message);
    this.name = "ReadNotLoggedError";
  }
}

/** The request reached a book that was stopped (or evicted) a moment before it could begin. Nothing
 * was done for it, so a host that holds the book somewhere else can send it there. */
export class BookClosedError extends Error {
  constructor(bookId: string) {
    super(`The book ${bookId} is closed`);
    this.name = "BookClosedError";
  }
}

/** The process follows the book but does not hold it: it has no lease, so it can neither read nor
 * write for a client. It is waiting to take the book over (see `openStandby`). */
export class BookStandbyError extends Error {
  constructor(bookId: string) {
    super(`This process follows the book ${bookId} and does not serve it yet`);
    this.name = "BookStandbyError";
  }
}

/** The process is handing the book over: it still answers reads, and writes are refused until it
 * lets go (see `drain`). Nothing was done for the refused request. */
export class BookDrainingError extends Error {
  constructor(bookId: string) {
    super(`The book ${bookId} is being handed to another process; writes are refused for a moment`);
    this.name = "BookDrainingError";
  }
}

export class EntryTooLargeError extends Error {
  /** `stored`: the size is of the packed entry, as the tail keeps it, not of the changes. */
  constructor(bytes: number, limit: number, stored = false) {
    super(
      stored
        ? `The request changed ${bytes} bytes once packed; one entry may hold at most ${limit}. Do it in smaller parts.`
        : `The request changed ${bytes} bytes; one entry may hold at most ${limit}`,
    );
    this.name = "EntryTooLargeError";
  }
}

/** What one entry the process appended was, for the host that wants to account for them. */
export interface EntryInfo {
  readonly seq: number;
  readonly kind: EntryKind;
  /** The host's name for the request that caused it (an operation name), if it gave one. */
  readonly label: string | null;
  /** A write, or a read that changed something replicated and so had to be logged before it was answered. */
  readonly cause: "write" | "read";
  /** Bytes as stored (compressed, framed). */
  readonly bytes: number;
  /** Bytes of the change set before compression. */
  readonly rawBytes: number;
  readonly changes: number;
  /** Row changes by table; a table sent whole counts its rows under `replace`. */
  readonly tables: Readonly<
    Record<string, { insert: number; update: number; delete: number; replace: number }>
  >;
  /** Schema statements in the entry. */
  readonly ddl: number;
  /** A rough share of the change set's size by table (the sum of the sizes of the values), and
   * under "(schema)" the statements. */
  readonly sizeByTable: Readonly<Record<string, number>>;
  /** Where the time of the request went, in milliseconds (see {@link RuntimeStats.ms}). */
  readonly ms: { work: number; peek: number; encode: number; append: number; commit: number };
  readonly opId: string | null;
}

/** What a host says about a request when it runs it. */
export interface RequestMeta {
  /** The identity the client gave a write, recorded in the entry. */
  readonly opId?: string;
  /** A name for the request, passed to {@link BookRuntimeOptions.onEntry}. */
  readonly label?: string;
  /** For a read that turns out to have changed something replicated: log it before answering, or
   * answer now and log it soon. By default what {@link BookRuntimeOptions.readEffects} says. */
  readonly effects?: "log-first" | "defer";
}

export interface BookRuntimeOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly bookId: string;
  /** Key prefix in the bulk store: empty, or ending in "/". */
  readonly prefix?: string;
  /** Unique per process incarnation: it is the lease holder and the entry writer. */
  readonly holder: string;
  /** The cache file. */
  readonly path: string;
  /** The highest schema version this code understands. Every entry is stamped with it. */
  readonly schema: number;
  /** Tables that are derived and never replicated. */
  readonly exclude?: readonly string[];
  readonly clock?: Clock;
  readonly pod?: PodClock;
  readonly lease?: Pick<
    LeaseOptions,
    "ttlMs" | "renewEveryMs" | "driftBound" | "safetyMs" | "skewToleranceMs"
  >;
  /** Give the book's lease up after this long without a request (0, the default, never), and take it
   * again when the next request comes. A lease is renewed every third of its length for as long as it is
   * held, and each renewal is a call to the tail, which on a metered service (a Durable Object, billed by
   * the request and by the row written) is nearly all of what an idle book costs. While the lease is
   * given up nothing is renewed, and any other process may take the book; the next request here takes it
   * back, catches up with what was written meanwhile, and goes on. Not for a process that has a standby:
   * the standby takes the book as soon as the lease is free. */
  readonly idleReleaseMs?: number;
  readonly sealing?: {
    /** Seal this long after the first unsealed entry that carries a write (default 2 s); 0 turns the
     * job off. This is the window: the acknowledged writes at risk if the whole tail were lost. */
    readonly delayMs?: number;
    /** How long entries that carry only what a read wrote (an agent's audit row, derived rows flushed
     * on their own, a snapshot's announcement) may wait for a seal of their own (default 10 minutes).
     * They do not arm the window; they go out with the next seal of any kind, or when the oldest of
     * them reaches this age, or when the process stops. */
    readonly routineMaxAgeMs?: number;
    /** The old behaviour: every entry arms the window. For comparing policies. */
    readonly everythingUrgent?: boolean;
    readonly maxEntries?: number;
    readonly attempts?: number;
  };
  readonly snapshots?: {
    /** Take a snapshot every this many entries (default 0: only on request). */
    readonly everyEntries?: number;
    /** Put a hash of the replicated content in the manifest (costs a pass over the database). */
    readonly stateHash?: boolean;
  };
  readonly commit?: {
    /** How many times to bring the cache up to date and run the operation again after losing a race (default 4). */
    readonly conflictAttempts?: number;
    /** How many times to send an append again when its answer is lost and the entry is not there (default 4). */
    readonly uncertainAttempts?: number;
    readonly backoffMs?: number;
    /** The most one entry may hold, uncompressed (default 32 MiB). */
    readonly maxEntryBytes?: number;
    /** The most one entry may hold as stored, compressed and framed (default: no limit beyond the
     * tail's own). A tail that keeps an entry in one row has a limit on a row, and a request that would
     * pass it is refused here with {@link EntryTooLargeError}, before anything is sent. */
    readonly maxStoredEntryBytes?: number;
  };
  /** Told when the database changed beneath the application's in-memory state: after a rollback
   * that undid a request, after catching up with entries written elsewhere, after a rebuild (which
   * replaces the connection: read `runtime.db`). The host drops whatever it derived from the
   * database and reopens it. It is called before the next operation or read runs. */
  readonly onReset?: (
    reason: "rollback" | "caught-up" | "rebuilt",
    runtime: BookRuntime,
  ) => Promise<void> | void;
  /** What to do with a read that changed something replicated (a table made on first use, an audit
   * row, a derived row stored). `log-first`, the default, appends its entry before answering, as for
   * a write. `defer` answers now and appends within `deferMs` (default 2 seconds), or with the next
   * write, or when the process stops, whichever comes first. What is deferred is lost if the process
   * dies first, so a host defers only what can be made again or can wait. */
  readonly readEffects?: { readonly mode?: "log-first" | "defer"; readonly deferMs?: number };
  /** Told about every entry this process appends for a request, after it is durable. */
  readonly onEntry?: (info: EntryInfo) => void;
  /** The number of journals in the book, for the size bucket on metrics and for snapshot manifests. */
  readonly journals?: (db: Database) => number | null;
  readonly onDatabase?: (db: Database) => void;
  readonly limiter?: ActivationLimiter;
  /** What a cold load of this book is expected to need, in bytes, when the host knows better than the log does (it remembers how big the
   * book was the last time it held it). By default the limiter is told what the log's length suggests, which is nothing like the truth for a
   * book that was imported whole or that has been snapshotted many times. */
  readonly limiterBytes?: number;
  readonly synchronous?: "OFF" | "NORMAL" | "FULL";
  /** How the cache is first made current (tests and experiments choose the route). */
  readonly materialize?: {
    readonly snapshotsToTry?: number;
    readonly reuse?: boolean;
  };
}

export interface RuntimeStats {
  commits: number;
  entriesWritten: number;
  conflicts: number;
  uncertain: number;
  resolvedOurs: number;
  catchUps: number;
  rebuilds: number;
  rollbacks: number;
  /** Reads that changed the book and were logged before they were answered. */
  readFlushes: number;
  /** Reads that changed the book whose entry was left for later (see readEffects). */
  readsDeferred: number;
  /** Segments this process sealed, by what asked for the seal. */
  seals: { window: number; age: number; close: number; handover: number; manual: number };
  /** Entries appended by the timer, close or a snapshot to carry what reads had left unsent. */
  deferredFlushes: number;
  /** Times the lease was given up because no request came for `idleReleaseMs`. */
  idleReleases: number;
  /** Times the cache was thrown away because it held changes the log did not and the log moved. */
  unsentRebuilds: number;
  leaseReads: number;
  /** Bytes of entries this process appended (compressed, as stored). */
  bytesWritten: number;
  /** Requests that changed nothing replicated, whose transaction was committed with no entry. */
  emptyWrites: number;
  /** Where the time of the requests that changed the book went, in milliseconds: the application's
   * own work, reading what the triggers captured, building the entry (encode, compress, hash), the
   * tail's append (with any resolution of a lost answer), and the local commit. */
  ms: { work: number; peek: number; encode: number; append: number; commit: number };
  /** Seconds each acknowledged commit took (from the end of the operation to durable). */
  commitSeconds: number[];
  activation: MaterializeStats | null;
}

type AppendOutcome = "committed" | "conflict" | "uncertain";

function describe(
  entry: BuiltEntry,
  pending: Pending,
  rawBytes: number,
  meta: RequestMeta & { readonly cause?: "write" | "read" },
  ms: EntryInfo["ms"],
): EntryInfo {
  const tables: Record<
    string,
    { insert: number; update: number; delete: number; replace: number }
  > = {};
  const sizeByTable: Record<string, number> = {};
  const sizeOf = (values: readonly unknown[]): number => {
    let total = 0;
    for (const value of values) {
      if (typeof value === "string") total += value.length;
      else if (value instanceof Uint8Array) total += value.byteLength;
      else total += 8;
    }
    return total;
  };
  let ddl = 0;
  for (const change of pending.set.changes) {
    if (change.op === "ddl") {
      ddl += 1;
      sizeByTable["(schema)"] = (sizeByTable["(schema)"] ?? 0) + change.sql.length;
      continue;
    }
    if (change.op === "sequence") continue;
    let counts = tables[change.table];
    if (!counts) {
      counts = { insert: 0, update: 0, delete: 0, replace: 0 };
      tables[change.table] = counts;
    }
    let size = 0;
    if (change.op === "replace") {
      counts.replace += change.rows.length;
      for (const row of change.rows) size += sizeOf(row);
    } else {
      counts[change.op] += 1;
      size += change.op === "delete" ? sizeOf(change.key) : sizeOf(change.row);
      if (change.op === "update") size += sizeOf(change.key);
    }
    sizeByTable[change.table] = (sizeByTable[change.table] ?? 0) + size;
  }
  return {
    seq: entry.header.seq,
    kind: entry.header.kind,
    label: meta.label ?? null,
    cause: meta.cause ?? "write",
    bytes: entry.bytes.byteLength,
    rawBytes,
    changes: pending.count,
    tables,
    ddl,
    sizeByTable,
    ms,
    opId: meta.opId ?? null,
  };
}

/** One book on one process: the cache file, its change capture, the lease, the way an operation
 * becomes durable, and the background work of sealing and snapshotting.
 *
 * An operation runs inside one SQLite transaction that is held open until its entry is in the
 * tail: if the append is refused or its fate is not known, the transaction is rolled back, so
 * the cache is always exactly the log up to the entry it names, never ahead of it. The response
 * is released only after the entry is durable and the local commit is made. */
export class BookRuntime {
  readonly bookId: string;
  readonly #options: BookRuntimeOptions;
  readonly #tier: LogTier;
  readonly #bulk: ObjectStore;
  readonly #keys: BookKeys;
  readonly #clock: Clock;
  readonly #keeper: LeaseKeeper;
  readonly #sealer: Sealer;
  readonly #gate = new AsyncRwLock();
  #db: Database;
  #capture: ChangeCapture;
  #head: { seq: number; hash: string };
  #stale = false;
  /** The cache file was closed to be built again and the new one is not ready, because the log or the
   * bulk store could not be read just then: nothing may touch the database until a rebuild succeeds,
   * and every operation tries again. */
  #needsRebuild = false;
  /** A request was rolled back and the host has not yet been told: its in-memory state may be ahead of the database. */
  #undone = false;
  #closed = false;
  /** Following the log without the lease: see `openStandby`. */
  #standby = false;
  /** Writes are refused while the lease is held, ahead of letting go of it: see `drain`. */
  #draining = false;
  #urgentLoop = false;
  #routineLoop = false;
  #sealInFlight: Promise<SealOutcome> | null = null;
  /** The sequence of the last entry a previous holder left unsealed when this process took the book
   * (0 when there was none): sealed on the window, whoever's it was. */
  #handoverThrough = 0;
  /** When this process noticed that tail (by its own clock): the window runs from then. */
  #handoverAt = 0;
  #flushing = false;
  /** When a request last began or ended here, by the clock: the lease is given up when it is old. */
  #lastRequestAt: number;
  #idleWatching = false;
  #idleGeneration = 0;
  /** The lease was given up for idleness and not taken again yet. */
  #idleReleased = false;
  #snapshotting = false;
  #lastSnapshotSeq = 0;
  /** Entries this process appended that it does not know to be sealed, for the tail gauges. */
  #unsealed: { seq: number; bytes: number; at: number; urgent: boolean }[] = [];
  #sealedThrough = 0;
  /** The oldest entry not known to be sealed, and when it was written by this process's clock. */
  #oldest: { seq: number; at: number } | null = null;
  readonly stats: RuntimeStats = {
    commits: 0,
    entriesWritten: 0,
    conflicts: 0,
    uncertain: 0,
    resolvedOurs: 0,
    catchUps: 0,
    rebuilds: 0,
    rollbacks: 0,
    readFlushes: 0,
    readsDeferred: 0,
    seals: { window: 0, age: 0, close: 0, handover: 0, manual: 0 },
    deferredFlushes: 0,
    idleReleases: 0,
    unsentRebuilds: 0,
    leaseReads: 0,
    bytesWritten: 0,
    emptyWrites: 0,
    ms: { work: 0, peek: 0, encode: 0, append: 0, commit: 0 },
    commitSeconds: [],
    activation: null,
  };

  private constructor(
    options: BookRuntimeOptions,
    keeper: LeaseKeeper,
    db: Database,
    capture: ChangeCapture,
    head: { seq: number; hash: string },
    activation: MaterializeStats,
  ) {
    this.bookId = options.bookId;
    this.#options = options;
    this.#tier = options.tier;
    this.#bulk = options.bulk;
    this.#keys = new BookKeys(options.prefix ?? "", options.bookId);
    this.#clock = options.clock ?? systemClock;
    this.#lastRequestAt = this.#clock.now();
    this.#keeper = keeper;
    this.#db = db;
    this.#capture = capture;
    this.#head = head;
    this.stats.activation = activation;
    this.#lastSnapshotSeq = activation.snapshotSeq;
    this.#sealer = new Sealer({
      tier: this.#tier,
      bulk: this.#bulk,
      keys: this.#keys,
      clock: this.#clock,
      ...(options.sealing?.maxEntries !== undefined
        ? { maxEntries: options.sealing.maxEntries }
        : {}),
      ...(options.sealing?.attempts !== undefined ? { attempts: options.sealing.attempts } : {}),
    });
  }

  static #newKeeper(options: BookRuntimeOptions): LeaseKeeper {
    return new LeaseKeeper({
      tier: options.tier,
      book: options.bookId,
      holder: options.holder,
      clock: options.clock ?? systemClock,
      ...(options.pod ? { pod: options.pod } : {}),
      ...options.lease,
    });
  }

  /** Read the book into a cache file: through the limiter when one is given. `seq` is what the tail
   * is known to hold, for the limiter's estimate of what the load needs. */
  static async #materialize(options: BookRuntimeOptions, seq: number) {
    const keys = new BookKeys(options.prefix ?? "", options.bookId);
    const load = async () =>
      materialize({
        tier: options.tier,
        bulk: options.bulk,
        keys,
        schema: options.schema,
        path: options.path,
        ...(options.exclude ? { exclude: options.exclude } : {}),
        ...(options.synchronous ? { synchronous: options.synchronous } : {}),
        ...(options.onDatabase ? { onDatabase: options.onDatabase } : {}),
        ...(options.materialize?.snapshotsToTry !== undefined
          ? { snapshotsToTry: options.materialize.snapshotsToTry }
          : {}),
        ...(options.materialize?.reuse !== undefined ? { reuse: options.materialize.reuse } : {}),
      });
    return options.limiter
      ? options.limiter.run(
          options.limiterBytes ?? estimateActivationBytes({ journals: Math.floor(seq / 3) }),
          load,
        )
      : load();
  }

  /** Follow a book without holding it: read it into a cache and keep that cache current (`follow`),
   * so that when the lease is free the process can take the book over (`promote`) with next to nothing
   * left to read. It cannot serve a client meanwhile: reads and writes say `BookStandbyError`. */
  static async openStandby(options: BookRuntimeOptions): Promise<BookRuntime> {
    const keeper = BookRuntime.#newKeeper(options);
    const known = await options.tier.head(options.bookId).catch(() => null);
    const materialized = await BookRuntime.#materialize(options, known?.seq ?? 0);
    const runtime = new BookRuntime(
      options,
      keeper,
      materialized.db,
      materialized.capture,
      { ...materialized.head },
      materialized.stats,
    );
    runtime.#standby = true;
    return runtime;
  }

  /** Take the lease, make the cache current with the log, and start renewing. Cold loads go through
   * the limiter when one is given. */
  static async open(options: BookRuntimeOptions): Promise<BookRuntime> {
    const keeper = BookRuntime.#newKeeper(options);
    await keeper.require();
    keeper.start();
    try {
      const materialized = await BookRuntime.#materialize(options, keeper.head?.seq ?? 0);
      const runtime = new BookRuntime(
        options,
        keeper,
        materialized.db,
        materialized.capture,
        { ...materialized.head },
        materialized.stats,
      );
      // Nobody else could append while this process held the lease, unless it lapsed on the way.
      await runtime.#gate.exclusive(() => runtime.#ensureCurrent());
      await runtime.#observeTail();
      runtime.#touch();
      runtime.#watchIdle();
      return runtime;
    } catch (error) {
      await keeper.stop();
      throw error;
    }
  }

  get db(): Database {
    return this.#db;
  }
  get head(): { readonly seq: number; readonly hash: string } {
    return this.#head;
  }
  get capture(): ChangeCapture {
    return this.#capture;
  }
  get lease(): LeaseKeeper {
    return this.#keeper;
  }
  get sealer(): Sealer {
    return this.#sealer;
  }
  /** True while the process follows the book without holding it. */
  get standby(): boolean {
    return this.#standby;
  }
  /** True once `drain` was called: writes are refused. */
  get draining(): boolean {
    return this.#draining;
  }

  /** (Standby) Apply what the log has beyond the cache, if anything. The host is told the database
   * changed (so it can build its application again) when something was applied. Returns how many
   * entries were applied, and the sequence the cache is at now. */
  async follow(): Promise<{ readonly applied: number; readonly seq: number }> {
    this.#assertOpen();
    if (!this.#standby) return { applied: 0, seq: this.#head.seq };
    return this.#gate.exclusive(async () => {
      this.#assertOpen();
      const head = await this.#tier.head(this.bookId);
      if (head.seq < this.#head.seq) {
        // The log is behind the cache: the cache is on a history that is not the log's. Start again.
        await this.#rebuild();
        return { applied: 0, seq: this.#head.seq };
      }
      if (head.seq === this.#head.seq && head.hash === this.#head.hash)
        return { applied: 0, seq: this.#head.seq };
      const before = this.#head.seq;
      await this.#catchUp();
      return { applied: Math.max(0, this.#head.seq - before), seq: this.#head.seq };
    });
  }

  /** (Standby) Take the book: acquire the lease, bring the cache up to the log's end, and start
   * serving. Says `LeaseHeldElsewhereError` while another process holds the book (try again). With the
   * cache already current this reads nothing, and the host's application, and whatever it has built in
   * memory, stays as it is. */
  async promote(): Promise<void> {
    this.#assertOpen();
    if (!this.#standby) return;
    await this.#gate.exclusive(async () => {
      this.#assertOpen();
      const result = await this.#keeper.acquire();
      if (!result.ok) throw new LeaseHeldElsewhereError(result.heldBy, result.expiresInMs);
      this.#keeper.start();
      const head = result.lease.head;
      if (head.seq < this.#head.seq) await this.#rebuild();
      else if (head.seq !== this.#head.seq || head.hash !== this.#head.hash) await this.#catchUp();
      this.#standby = false;
    });
    await this.#observeTail();
    this.#touch();
    this.#watchIdle();
  }

  /** (Standby) Run work against the cache while it cannot be moved from under it: not at the same time
   * as `follow` or `promote`. For the host to warm its application on a followed cache. */
  async withCache<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    return this.#gate.shared(work);
  }

  /** Refuse writes from now on, with `BookDrainingError`, and go on answering reads: the first half of
   * a handover. The process lets go of the book with `close` once the one taking over has the log
   * to its end. */
  drain(): void {
    this.#draining = true;
  }
  /** What this process knows of the entries its tail holds that are not sealed: how many, how big,
   * and how late the oldest one that is due is (see the gauge `tail.age`). For a status page. */
  tailStatus(): {
    readonly seq: number;
    readonly sealedThrough: number;
    readonly depth: number;
    readonly bytes: number;
    readonly ageSeconds: number;
  } {
    return {
      seq: this.#head.seq,
      sealedThrough: this.#sealedThrough,
      depth: Math.max(0, this.#head.seq - this.#sealedThrough),
      bytes: this.#unsealed.reduce((total, entry) => total + entry.bytes, 0),
      ageSeconds: this.#dueAge(this.#clock.now()),
    };
  }
  /** True while an operation is running or waiting to (for tests that look for a stuck process). */
  get busy(): boolean {
    return this.#gate.busy || this.#gate.waiting > 0;
  }

  // ---- reading --------------------------------------------------------------------------------------

  /** Run a read against the cache. With a valid lease this is a local call; without one the process
   * first asks the tail whether anything is newer. Nothing is returned after the lease may have
   * lapsed. */
  async read<T>(
    work: (db: Database) => Promise<T> | T,
    meta: Pick<RequestMeta, "label" | "effects"> = {},
  ): Promise<T> {
    this.#touch();
    try {
      return await this.#read(work, meta);
    } finally {
      this.#touch();
    }
  }

  async #read<T>(
    work: (db: Database) => Promise<T> | T,
    meta: Pick<RequestMeta, "label" | "effects">,
  ): Promise<T> {
    this.#assertOpen();
    if (this.#standby) throw new BookStandbyError(this.bookId);
    let unsent = false;
    const lapsed = Symbol("lapsed");
    let value: T | typeof lapsed = lapsed;
    for (let attempt = 0; value === lapsed; attempt += 1) {
      if (attempt > 0 || !this.#fresh() || this.#undone)
        await this.#gate.exclusive(async () => {
          this.#assertOpen();
          await this.#ensureCurrent();
          await this.#settleHost();
        });
      value = await this.#gate.shared(async () => {
        // Asked while the book was being stopped: the stop came first.
        this.#assertOpen();
        if (this.#keeper.leases && !this.#keeper.valid()) {
          // The lease was given up for idleness between the check above and getting the book: that is
          // not a lease lost, so take it again and ask once more.
          if (this.#idleReleased && attempt === 0) return lapsed;
          throw this.#keeper.leaseError();
        }
        const before = this.#capture.mark();
        const result = await work(this.#db);
        // A read that wrote something replicated (a table made on first use, an audit row) is logged
        // before it is answered, or soon after (see readEffects). What was already waiting from an
        // earlier read is not this read's business: it is carried by a write or the timer.
        if (!unsent && this.#capture.mark() !== before && this.#capture.hasUnsent()) unsent = true;
        return result;
      });
    }
    if (unsent) {
      if ((meta.effects ?? this.#options.readEffects?.mode ?? "log-first") === "defer") {
        this.stats.readsDeferred += 1;
        this.#deferFlush();
      } else {
        this.stats.readFlushes += 1;
        const discarded = this.stats.unsentRebuilds;
        try {
          await this.write(() => undefined, { ...meta, cause: "read" });
          // A rebuild that threw away what the read wrote (another process had moved the book) means it
          // is not on record, whatever the empty entry that followed said.
          if (this.stats.unsentRebuilds !== discarded) throw new ReadNotLoggedError("rebuilt");
        } catch (error) {
          // Fail closed: nothing that is to be on record is answered unless it is. What the read
          // wrote stays in the cache, unsent, and goes out with the next write or the timer.
          if (
            error instanceof ReadNotLoggedError ||
            error instanceof CommitUncertainError ||
            error instanceof CommitConflictError ||
            error instanceof LeaseHeldElsewhereError ||
            error instanceof LeaseLostError ||
            error instanceof ObjectStoreUncertain
          ) {
            this.#deferFlush();
            throw error instanceof ReadNotLoggedError ? error : new ReadNotLoggedError(error);
          }
          throw error;
        }
      }
    }
    if (this.#keeper.leases) {
      // A response is released only while the lease is still good by this process's own timer.
      this.#keeper.assertValid();
      this.stats.leaseReads += 1;
      counter("lease.reads").add(1, { lease_state: "leased" });
    } else counter("lease.reads").add(1, { lease_state: "unleased" });
    return value;
  }

  #fresh(): boolean {
    return !this.#stale && !this.#needsRebuild && this.#keeper.leases && this.#keeper.valid();
  }

  /** Append what reads left unsent after a short while, once for however many reads there were. */
  #deferFlush(): void {
    if (this.#flushing || this.#closed) return;
    this.#flushing = true;
    const delay = this.#options.readEffects?.deferMs ?? 2000;
    void (async () => {
      try {
        await this.#clock.sleep(delay);
        await this.flushDeferred();
      } catch {
        // The next write carries it, or it goes with the process: it was deferrable.
      } finally {
        this.#flushing = false;
      }
    })();
  }

  /** Append the entry for what reads left unsent, if anything is. Stopping and taking a snapshot do
   * this themselves; a host that wants the log to be everything the cache holds, now, can too. */
  async flushDeferred(): Promise<void> {
    if (this.#closed || this.#needsRebuild || !this.#capture.hasUnsent()) return;
    this.stats.deferredFlushes += 1;
    await this.write(() => undefined, { label: "(deferred)", cause: "read" });
  }

  // ---- writing --------------------------------------------------------------------------------------

  /** Run an operation and make its effects durable before returning. The operation may be run again
   * if another process won the race for the next entry: it must be safe to repeat (every write
   * carries an operation identity the application already deduplicates on). */
  async write<T>(
    work: (db: Database) => Promise<T> | T,
    meta: RequestMeta & { readonly cause?: "write" | "read" } = {},
  ): Promise<T> {
    // What a read left unsent, written on its behalf, is not a request: it neither keeps the lease nor
    // asks for it back.
    const request = meta.cause !== "read";
    if (request) this.#touch();
    try {
      return await this.#write(work, meta);
    } finally {
      if (request) this.#touch();
    }
  }

  async #write<T>(
    work: (db: Database) => Promise<T> | T,
    meta: RequestMeta & { readonly cause?: "write" | "read" },
  ): Promise<T> {
    this.#assertOpen();
    if (this.#standby) throw new BookStandbyError(this.bookId);
    // What reads left unsent still goes out while the book is handed over; a client's write does not.
    if (this.#draining && meta.cause !== "read") throw new BookDrainingError(this.bookId);
    const attempts = this.#options.commit?.conflictAttempts ?? 4;
    return this.#gate.exclusive(async () => {
      for (let attempt = 1; ; attempt += 1) {
        // Asked while the book was being stopped: the stop came first, and nothing has been done.
        this.#assertOpen();
        if (this.#draining && meta.cause !== "read") throw new BookDrainingError(this.bookId);
        await this.#ensureCurrent();
        await this.#settleHost();
        const fence = this.#keeper.leases ? this.#keeper.assertValid() : 0;
        const started = performance.now();
        this.#db.exec("BEGIN IMMEDIATE");
        let value: T | undefined;
        let failure: { error: unknown } | null = null;
        try {
          value = await work(this.#db);
        } catch (error) {
          failure = { error };
        }
        const worked = performance.now();
        this.stats.ms.work += worked - started;
        let pending: Pending | null;
        try {
          pending = this.#capture.peek();
        } catch (error) {
          this.#rollback();
          throw error;
        }
        const peeked = performance.now();
        this.stats.ms.peek += peeked - worked;
        if (!pending) {
          this.#db.exec("COMMIT");
          this.stats.emptyWrites += 1;
          if (failure) throw failure.error;
          return value as T;
        }
        const kind: EntryKind = this.#head.seq === 0 ? "genesis" : "commit";
        let entry: BuiltEntry;
        let rawBytes = 0;
        try {
          const payload = encodeChangeSet(pending.set);
          rawBytes = payload.byteLength;
          entry = this.#entryFor(kind, payload, pending.count, fence, meta.opId ?? null);
        } catch (error) {
          this.#rollback();
          throw error;
        }
        const encoded = performance.now();
        this.stats.ms.encode += encoded - peeked;
        let outcome: AppendOutcome;
        try {
          outcome = await this.#append(entry, fence);
        } catch (error) {
          // The commit did not go out (the tail is not being called, or refused the request), or what
          // happened is not known: either way the cache goes back to the last entry it knows, and a
          // failure nobody expected makes it learn from the log before it is used again.
          this.#rollback(meta.cause === "read");
          if (!(error instanceof ObjectStoreError)) this.#markStale();
          throw error;
        }
        const appended = performance.now();
        this.stats.ms.append += appended - encoded;
        if (outcome === "committed") {
          try {
            this.#capture.settle(pending);
            this.#capture.setHead({
              bookId: this.bookId,
              seq: entry.header.seq,
              hash: entry.header.hash,
            });
            this.#db.exec("COMMIT");
          } catch (error) {
            // The entry is durable but the cache could not take it: the answer stands, the cache
            // is rebuilt from the log before it is used again.
            this.#markStale();
            void error;
          }
          const committed = performance.now();
          this.stats.ms.commit += committed - appended;
          this.#head = { seq: entry.header.seq, hash: entry.header.hash };
          this.stats.commits += 1;
          this.#appended(
            entry.header.seq,
            entry.bytes.byteLength,
            this.#urgent(meta.cause ?? "write"),
          );
          if (this.#options.onEntry)
            this.#options.onEntry(
              describe(entry, pending, rawBytes, meta, {
                work: worked - started,
                peek: peeked - worked,
                encode: encoded - peeked,
                append: appended - encoded,
                commit: committed - appended,
              }),
            );
          this.#afterCommit();
          if (failure) throw failure.error;
          return value as T;
        }
        // A flush has no work of its own: what it carries is already in the cache (a read wrote it),
        // so rolling its transaction back undoes nothing the application holds, and not knowing
        // whether the entry landed leaves the cache a book that is right either way. The next
        // append finds out: if the entry did land, the sequence is taken and the cache is rebuilt.
        const flush = meta.cause === "read";
        this.#rollback(flush);
        if (outcome === "uncertain") {
          if (!flush) this.#markStale();
          throw new CommitUncertainError();
        }
        // Another process has the next entry (or took the lease): bring the cache up to date, put
        // the application's state right, and run the operation again.
        this.stats.conflicts += 1;
        if (attempt >= attempts) throw new CommitConflictError();
        await this.#recover();
      }
    });
  }

  #entryFor(
    kind: EntryKind,
    payload: Uint8Array,
    changes: number,
    fence: number,
    opId: string | null,
  ): BuiltEntry {
    const limit = this.#options.commit?.maxEntryBytes ?? 32 * 2 ** 20;
    if (payload.byteLength > limit) throw new EntryTooLargeError(payload.byteLength, limit);
    const entry = buildEntry({
      bookId: this.bookId,
      seq: this.#head.seq + 1,
      prev: this.#head.hash,
      writer: this.#options.holder,
      fence,
      schema: this.#options.schema,
      kind,
      opId,
      at: new Date(this.#clock.now()).toISOString(),
      payload,
      changes,
    });
    const stored = this.#options.commit?.maxStoredEntryBytes;
    if (stored !== undefined && entry.bytes.byteLength > stored)
      throw new EntryTooLargeError(entry.bytes.byteLength, stored, true);
    return entry;
  }

  #rollback(hostUnaffected = false): void {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      // not in a transaction
    }
    this.#capture.invalidate();
    if (!hostUnaffected) this.#undone = true;
    this.stats.rollbacks += 1;
  }

  /** Tell the host about a rollback it has not heard of (a request that failed before it reached the tail). */
  async #settleHost(): Promise<void> {
    if (!this.#undone) return;
    this.#undone = false;
    await this.#options.onReset?.("rollback", this);
  }

  #markStale(): void {
    this.#stale = true;
  }

  /** Append an entry and settle what happened: it is in the log (committed), someone else's entry
   * is where it should be (conflict), or no one can say yet (uncertain). */
  async #append(entry: BuiltEntry, fence: number): Promise<AppendOutcome> {
    const started = performance.now();
    const bucket = knownBucket(this.#options.journals?.(this.#db) ?? null, entry.header.seq);
    return span(
      "booklog.commit",
      { "book.id": this.bookId, seq: entry.header.seq, bytes: entry.bytes.byteLength, fence },
      async (s) => {
        const tries = this.#options.commit?.uncertainAttempts ?? 4;
        const backoff = this.#options.commit?.backoffMs ?? 50;
        let outcome: AppendOutcome = "uncertain";
        // Whether an attempt of this commit went out and was not answered: if so the entry may be there.
        let sent = false;
        for (let attempt = 1; attempt <= tries; attempt += 1) {
          let refusal: string | null = null;
          let lost = false;
          try {
            const result = await this.#tier.append(this.bookId, {
              seq: entry.header.seq,
              prevHash: entry.header.prev,
              hash: entry.header.hash,
              fence,
              body: entry.bytes,
            });
            if (result.ok) {
              outcome = "committed";
              break;
            }
            refusal = result.reason;
          } catch (error) {
            if (error instanceof TailUnavailableError) {
              // The tail is not being called, and trying again here would only wait. If nothing of this
              // commit went out, say so (the commit is refused, whole); if an attempt did, its fate
              // is not known and the commit is uncertain, to be sent again under its identity.
              if (!sent) throw error;
              s.addEvent("uncertain");
              break;
            }
            if (!(error instanceof ObjectStoreUncertain)) throw error;
            lost = true;
            sent = true;
            s.addEvent("uncertain");
          }
          if (refusal === "prev") {
            outcome = "conflict";
            break;
          }
          // A refusal for the sequence or the fence, or a lost answer: is the entry there, and is it ours?
          const landed = await this.#landed(entry);
          if (landed === "ours") {
            this.stats.resolvedOurs += 1;
            if (lost || refusal)
              counter("commit.uncertain").add(1, { size_bucket: bucket, resolution: "ours" });
            outcome = "committed";
            break;
          }
          if (refusal === "fence") {
            // The token is no longer the current one: whoever holds the book now, it is not this process.
            s.addEvent("fenced");
            this.#keeper.forget();
          }
          if (landed === "theirs") {
            if (lost)
              counter("commit.uncertain").add(1, { size_bucket: bucket, resolution: "theirs" });
            s.addEvent("conflict");
            outcome = "conflict";
            break;
          }
          if (refusal === "fence" || refusal === "seq") {
            outcome = "conflict";
            break;
          }
          // The append did not land: send it again.
          if (attempt < tries) await this.#clock.sleep(backoff * 2 ** (attempt - 1));
        }
        if (outcome === "conflict") counter("commit.conflicts").add(1, { size_bucket: bucket });
        if (outcome === "uncertain") {
          this.stats.uncertain += 1;
          counter("commit.uncertain").add(1, { size_bucket: bucket, resolution: "unknown" });
        }
        s.setAttribute("outcome", outcome);
        if (outcome === "committed") {
          const seconds = (performance.now() - started) / 1000;
          histogram("commit.duration").record(seconds, { size_bucket: bucket });
          histogram("entry.bytes").record(entry.bytes.byteLength, { object_kind: "log" });
          this.stats.commitSeconds.push(seconds);
          this.stats.entriesWritten += 1;
          this.stats.bytesWritten += entry.bytes.byteLength;
        }
        return outcome;
      },
    );
  }

  /** Whether the entry at this sequence is this very entry, a different one, or not there yet. */
  async #landed(entry: BuiltEntry): Promise<"ours" | "theirs" | "absent"> {
    try {
      const head = await this.#tier.head(this.bookId);
      if (head.seq < entry.header.seq) return "absent";
      const reader = readLog({
        tier: this.#tier,
        bulk: this.#bulk,
        keys: this.#keys,
        schema: this.#options.schema,
        after: { seq: entry.header.seq - 1, hash: entry.header.prev },
      });
      try {
        const first = await reader.next();
        if (first.done) return "absent";
        return first.value.header.hash === entry.header.hash ? "ours" : "theirs";
      } finally {
        await reader.return({
          head: { seq: 0, hash: GENESIS_HASH },
          sealedEntries: 0,
          tailEntries: 0,
          segmentsRead: 0,
          lists: 0,
        });
      }
    } catch (error) {
      // A chain that does not lead to our entry means the entry at that place is someone else's.
      if (error instanceof EntryError && (error.code === "chain" || error.code === "sequence"))
        return "theirs";
      if (error instanceof ObjectStoreUncertain) return "absent";
      throw error;
    }
  }

  // ---- keeping current ---------------------------------------------------------------------------------

  /** Make sure the cache can be used: the lease is held, and the cache has every entry the log has. */
  async #ensureCurrent(): Promise<void> {
    if (this.#needsRebuild) await this.#rebuild();
    if (this.#stale) await this.#recover();
    if (this.#keeper.leases) {
      if (this.#keeper.valid()) return;
      const result = await this.#keeper.acquire();
      if (!result.ok) throw new LeaseHeldElsewhereError(result.heldBy, result.expiresInMs);
      this.#leased();
      const head = result.lease.head;
      if (head.seq < this.#head.seq) {
        await this.#rebuild();
        return;
      }
      if (head.seq !== this.#head.seq || head.hash !== this.#head.hash) await this.#catchUp();
      return;
    }
    const head = await this.#tier.head(this.bookId);
    if (head.seq < this.#head.seq) await this.#rebuild();
    else if (head.seq !== this.#head.seq || head.hash !== this.#head.hash) await this.#catchUp();
  }

  /** Apply what the log has beyond the cache. Returns whether the host was told that the database
   * changed. A cache that holds changes the log does not (they cannot be applied on top of) is
   * thrown away and built again. */
  async #catchUp(): Promise<{ reset: boolean }> {
    return span("booklog.apply", { "book.id": this.bookId, seq: this.#head.seq }, async () => {
      try {
        const result = await catchUp(this.#db, this.#capture, {
          tier: this.#tier,
          bulk: this.#bulk,
          keys: this.#keys,
          schema: this.#options.schema,
        });
        this.#head = { ...result.head };
        this.stats.catchUps += 1;
        if (result.applied > 0) await this.#options.onReset?.("caught-up", this);
        return { reset: result.applied > 0 };
      } catch (error) {
        if (!(error instanceof UnsentChangesError)) throw error;
        this.stats.unsentRebuilds += 1;
        await this.#rebuild();
        return { reset: true };
      }
    });
  }

  /** After a refused or lost commit: the cache is rolled back to what it knew; learn what happened. */
  async #recover(): Promise<void> {
    this.#stale = false;
    try {
      if (!this.#keeper.valid() && this.#keeper.leases) {
        const result = await this.#keeper.acquire();
        if (!result.ok) throw new LeaseHeldElsewhereError(result.heldBy, result.expiresInMs);
        this.#leased();
      }
      const caught = await this.#catchUp();
      if (caught.reset) {
        this.#undone = false;
        return;
      }
    } catch (error) {
      this.#stale = true;
      throw error;
    }
    this.#undone = false;
    await this.#options.onReset?.("rollback", this);
  }

  /** Throw the file away and read the book from the log again. */
  async #rebuild(): Promise<void> {
    this.#needsRebuild = true;
    this.#db.close();
    const materialized = await materialize({
      tier: this.#tier,
      bulk: this.#bulk,
      keys: this.#keys,
      schema: this.#options.schema,
      path: this.#options.path,
      reuse: false,
      ...(this.#options.exclude ? { exclude: this.#options.exclude } : {}),
      ...(this.#options.synchronous ? { synchronous: this.#options.synchronous } : {}),
      ...(this.#options.onDatabase ? { onDatabase: this.#options.onDatabase } : {}),
    });
    this.#db = materialized.db;
    this.#capture = materialized.capture;
    this.#head = { ...materialized.head };
    this.#needsRebuild = false;
    this.#stale = false;
    this.stats.rebuilds += 1;
    this.#undone = false;
    await this.#options.onReset?.("rebuilt", this);
  }

  // ---- background work ------------------------------------------------------------------------------------

  #afterCommit(): void {
    this.#scheduleSeal();
    const every = this.#options.snapshots?.everyEntries ?? 0;
    if (every > 0 && this.#head.seq - this.#lastSnapshotSeq >= every && !this.#snapshotting)
      void this.snapshotNow().catch(() => {});
  }

  /** Whether an entry caused by this arms the window: one that carries a write does; one that carries
   * only what a read wrote does not. */
  #urgent(cause: "write" | "read"): boolean {
    return cause === "write" || this.#options.sealing?.everythingUrgent === true;
  }

  #hasUrgent(): boolean {
    return (
      this.#handoverThrough > this.#sealedThrough || this.#unsealed.some((entry) => entry.urgent)
    );
  }

  /** Start whatever waits are needed: the short one for entries that carry a write (or that a
   * previous holder left), the long one for entries that carry only a read's effects. A seal of either
   * kind takes every entry up to the head, so the other wait usually ends with nothing to do. */
  #scheduleSeal(): void {
    const delay = this.#options.sealing?.delayMs ?? 2000;
    if (delay <= 0 || this.#closed) return;
    if (!this.#urgentLoop && this.#hasUrgent()) this.#waitAndSeal(delay);
    if (!this.#routineLoop && this.#unsealed.some((entry) => !entry.urgent))
      this.#waitAndSealRoutine(delay);
  }

  /** When the oldest urgent entry (or a previous holder's tail) will have waited a whole window. */
  #urgentDue(delay: number): number {
    let oldest = Number.POSITIVE_INFINITY;
    if (this.#handoverThrough > this.#sealedThrough) oldest = this.#handoverAt;
    const first = this.#unsealed.find((entry) => entry.urgent);
    if (first) oldest = Math.min(oldest, first.at);
    return oldest + delay;
  }

  #waitAndSeal(delay: number): void {
    this.#urgentLoop = true;
    void (async () => {
      try {
        let waits = 0;
        while (!this.#closed && this.#hasUrgent()) {
          // An entry waits one window from the moment it was appended, however busy the book is: the
          // next seal comes when the oldest urgent entry has waited that long, not in a chain, and
          // after a failure the wait grows.
          const wait = this.#urgentDue(delay) - this.#clock.now();
          if (wait > 0) {
            await this.#clock.sleep(wait);
            continue;
          }
          const outcome = await this.#sealOnce(
            this.#handoverThrough > this.#sealedThrough ? "handover" : "window",
          ).catch((): SealOutcome => ({ status: "deferred", reason: "error" }));
          if (outcome.status === "deferred") {
            waits += 1;
            await this.#clock.sleep(delay * Math.min(8, 2 ** waits));
            continue;
          }
          waits = 0;
          const head = await this.#tier.head(this.bookId).catch(() => null);
          if (head) this.#sealed(head.sealedThrough);
          if (!head) break;
          if (outcome.status === "nothing" && head.seq > head.sealedThrough) {
            // Someone else's seal or an empty read: look again after a window rather than spin.
            await this.#clock.sleep(delay);
          }
        }
      } finally {
        this.#urgentLoop = false;
        this.#scheduleSeal();
      }
    })();
  }

  #waitAndSealRoutine(delay: number): void {
    const maxAge = this.#options.sealing?.routineMaxAgeMs ?? 600_000;
    this.#routineLoop = true;
    void (async () => {
      try {
        let waits = 0;
        while (!this.#closed) {
          const oldest = this.#unsealed.find((entry) => !entry.urgent);
          if (!oldest) break;
          const wait = oldest.at + maxAge - this.#clock.now();
          if (wait > 0) {
            await this.#clock.sleep(wait);
            continue;
          }
          const outcome = await this.#sealOnce("age").catch(
            (): SealOutcome => ({ status: "deferred", reason: "error" }),
          );
          if (outcome.status === "deferred") {
            waits += 1;
            await this.#clock.sleep(delay * Math.min(8, 2 ** waits));
            continue;
          }
          waits = 0;
          const head = await this.#tier.head(this.bookId).catch(() => null);
          if (head) this.#sealed(head.sealedThrough);
          if (!head) break;
        }
      } finally {
        this.#routineLoop = false;
        this.#scheduleSeal();
      }
    })();
  }

  /** Seal what the tail holds now. */
  sealNow(): Promise<SealOutcome> {
    return this.#sealOnce("manual");
  }

  /** One seal at a time: a second ask while one runs gets that one's outcome (and asks again if the
   * entry it cares about was not in it). */
  #sealOnce(reason: "window" | "age" | "close" | "handover" | "manual"): Promise<SealOutcome> {
    if (this.#sealInFlight) return this.#sealInFlight;
    const run: Promise<SealOutcome> = (async () => {
      const outcome = await this.#sealer.sealOnce({
        reason,
        sizeBucket: knownBucket(this.#options.journals?.(this.#db) ?? null, this.#head.seq),
      });
      if (outcome.status === "sealed") {
        this.stats.seals[reason] += 1;
        this.#sealed(outcome.to);
      }
      return outcome;
    })().finally(() => {
      if (this.#sealInFlight === run) this.#sealInFlight = null;
    });
    this.#sealInFlight = run;
    return run;
  }

  // ---- the tail gauges --------------------------------------------------------------------------------

  /** Learn how much of the tail is waiting to be sealed when the book is opened (a process that takes
   * over from another finds its entries there). Best effort: the gauges are not worth a failure. */
  async #observeTail(): Promise<void> {
    try {
      const head = await this.#tier.head(this.bookId);
      this.#sealedThrough = head.sealedThrough;
      if (head.seq > head.sealedThrough) {
        // A previous holder left entries unsealed: they are sealed on the window, whatever they are.
        this.#handoverThrough = head.seq;
        this.#handoverAt = this.#clock.now();
        const page = await this.#tier.readFrom(this.bookId, head.sealedThrough + 1, 1);
        const first = page.entries[0];
        if (first)
          this.#oldest = {
            seq: first.seq,
            at: this.#clock.now() - Math.max(0, page.head.now - first.writtenAt),
          };
      }
    } catch {
      // unknown
    }
    this.#reportTail();
    this.#scheduleSeal();
  }

  #appended(seq: number, bytes: number, urgent: boolean): void {
    const at = this.#clock.now();
    this.#unsealed.push({ seq, bytes, at, urgent });
    this.#oldest ??= { seq, at };
    this.#reportTail();
  }

  #sealed(through: number): void {
    if (through <= this.#sealedThrough) return;
    this.#sealedThrough = through;
    if (through >= this.#handoverThrough) this.#handoverThrough = 0;
    this.#unsealed = this.#unsealed.filter((entry) => entry.seq > through);
    this.#oldest =
      this.#head.seq > through
        ? (this.#unsealed[0] ?? { seq: through + 1, at: this.#clock.now() })
        : null;
    this.#reportTail();
  }

  /** The age, in seconds, of the oldest unsealed entry that is due: one that carries a write, one a
   * previous holder left, or a read's effects older than they may wait. Entries that are allowed to
   * wait do not make the tail look late. */
  #dueAge(now: number): number {
    let oldest: number | null = null;
    const consider = (at: number) => {
      if (oldest === null || at < oldest) oldest = at;
    };
    if (this.#handoverThrough > this.#sealedThrough && this.#oldest) consider(this.#oldest.at);
    const urgent = this.#unsealed.find((entry) => entry.urgent);
    if (urgent) consider(urgent.at);
    const maxAge = this.#options.sealing?.routineMaxAgeMs ?? 600_000;
    const routine = this.#unsealed.find((entry) => !entry.urgent);
    if (routine && now - routine.at > maxAge) consider(routine.at);
    return oldest === null ? 0 : Math.max(0, (now - oldest) / 1000);
  }

  #reportTail(): void {
    if (this.#closed) return;
    const depth = Math.max(0, this.#head.seq - this.#sealedThrough);
    const now = () => this.#clock.now();
    reportTail(
      this.bookId,
      depth === 0
        ? null
        : {
            count: depth,
            bytes: this.#unsealed.reduce((total, entry) => total + entry.bytes, 0),
            ageSeconds: this.#dueAge(now()),
            observedAt: now(),
            now,
          },
    );
  }

  /** Take a snapshot of the cache as it is now, put it in the bulk store, and announce it in the log. */
  async snapshotNow(): Promise<SnapshotManifest> {
    this.#assertOpen();
    await this.flushDeferred();
    this.#snapshotting = true;
    try {
      const taken = await this.#gate.exclusive(async () => {
        // Asked while the book was being stopped: the stop came first.
        this.#assertOpen();
        await this.#ensureCurrent();
        if (this.#capture.hasUnsent()) throw new Error("There are changes not yet in the log");
        return {
          head: { ...this.#head },
          raw: this.#db.serialize(),
          stateHash: this.#options.snapshots?.stateHash ? this.#capture.stateHash() : null,
          journals: this.#options.journals?.(this.#db) ?? null,
        };
      });
      const gz = await compressSnapshot(taken.raw);
      const manifest: SnapshotManifest = await uploadSnapshot(
        this.#bulk,
        this.#keys,
        {
          v: 1,
          bookId: this.bookId,
          seq: taken.head.seq,
          entryHash: taken.head.hash,
          sha256: sha256(gz),
          bytes: gz.byteLength,
          rawBytes: taken.raw.byteLength,
          schema: this.#options.schema,
          stateHash: taken.stateHash,
          journals: taken.journals,
          writer: this.#options.holder,
          at: new Date(this.#clock.now()).toISOString(),
        },
        gz,
      );
      histogram("entry.bytes").record(gz.byteLength, { object_kind: "snapshot" });
      await this.#announce(manifest);
      this.#lastSnapshotSeq = manifest.seq;
      return manifest;
    } finally {
      this.#snapshotting = false;
    }
  }

  /** Append the entry that says a snapshot exists. It changes no rows. */
  async #announce(manifest: SnapshotManifest): Promise<void> {
    const attempts = this.#options.commit?.conflictAttempts ?? 4;
    await this.#gate.exclusive(async () => {
      for (let attempt = 1; ; attempt += 1) {
        this.#assertOpen();
        await this.#ensureCurrent();
        const fence = this.#keeper.leases ? this.#keeper.assertValid() : 0;
        const entry = this.#entryFor(
          "snapshot-published",
          new TextEncoder().encode(JSON.stringify(manifest)),
          1,
          fence,
          null,
        );
        const outcome = await this.#append(entry, fence);
        if (outcome === "committed") {
          this.#db.exec("BEGIN IMMEDIATE");
          this.#capture.setHead({
            bookId: this.bookId,
            seq: entry.header.seq,
            hash: entry.header.hash,
          });
          this.#db.exec("COMMIT");
          this.#head = { seq: entry.header.seq, hash: entry.header.hash };
          // A snapshot's announcement carries no book state: it waits like a read's effects.
          this.#appended(entry.header.seq, entry.bytes.byteLength, this.#urgent("read"));
          this.#scheduleSeal();
          return;
        }
        if (outcome === "uncertain") {
          this.#markStale();
          throw new CommitUncertainError();
        }
        if (attempt >= attempts) throw new CommitConflictError();
        await this.#recover();
      }
    });
  }

  // ---- giving the lease up when nobody asks ---------------------------------------------------------------------

  #touch(): void {
    this.#lastRequestAt = this.#clock.now();
  }

  /** The lease was just taken: renew it again if renewing had stopped, and watch for idleness. */
  #leased(): void {
    // A closed book that takes the lease for a request it was already running (a snapshot) must not
    // start renewing it: nothing is left to give it up.
    if (this.#closed) return;
    this.#idleReleased = false;
    this.#keeper.start();
    this.#watchIdle();
  }

  /** While the lease is held, wait for `idleReleaseMs` without a request and then give it up. One watcher
   * at a time; it ends when it has released the lease, and the next acquisition starts another. */
  #watchIdle(): void {
    const idle = this.#options.idleReleaseMs ?? 0;
    if (idle <= 0 || this.#idleWatching || this.#closed || this.#standby || !this.#keeper.leases)
      return;
    this.#idleWatching = true;
    const mine = ++this.#idleGeneration;
    void (async () => {
      try {
        for (;;) {
          if (this.#closed || this.#standby) return;
          const wait = this.#lastRequestAt + idle - this.#clock.now();
          if (wait > 0) {
            await this.#clock.sleep(wait);
            continue;
          }
          // What reads left unsent still goes out, and it needs the lease: before it is given up.
          await this.flushDeferred().catch(() => {});
          const released = await this.#gate.exclusive(async () => {
            if (this.#closed || this.#standby) return true;
            // A request came in while this waited for its turn.
            if (this.#clock.now() - this.#lastRequestAt < idle) return false;
            // Stop renewing and let go; if the tail cannot be told, the lease lapses by itself.
            await this.#keeper.stop();
            this.#idleReleased = true;
            this.stats.idleReleases += 1;
            // This watcher is done. The request waiting for its turn takes the lease again the moment the
            // book is free, and must find that it is to start the next one.
            this.#idleWatching = false;
            return true;
          });
          if (released) return;
        }
      } catch {
        // Nothing to undo: the next request that takes the lease starts the watch again.
      } finally {
        if (this.#idleGeneration === mine) this.#idleWatching = false;
      }
    })();
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new BookClosedError(this.bookId);
  }

  /** Stop serving: wait for the operation in flight, give the lease back, close the file. */
  async close(
    options: { readonly release?: boolean; readonly seal?: boolean } = {},
  ): Promise<void> {
    if (this.#closed) return;
    await this.flushDeferred().catch(() => {});
    await this.#gate.exclusive(async () => {
      this.#closed = true;
      if (options.seal !== false) {
        try {
          // A seal that was already running when the process was asked to stop may not have taken the
          // last entries: seal again until the tail has nothing of ours.
          for (let round = 0; round < 3; round += 1) {
            await this.#sealOnce("close");
            const head = await this.#tier.head(this.bookId).catch(() => null);
            if (!head || head.seq <= head.sealedThrough) break;
          }
        } catch {
          // the next holder seals
        }
      }
      await this.#keeper.stop(options.release === false ? { release: false } : {});
      try {
        this.#db.close();
      } catch {
        // already closed by a rebuild that did not finish
      }
      reportTail(this.bookId, null);
    });
  }

  /** Stop without touching the tail or the file's contents: what a killed process does. For tests. */
  abandon(): void {
    this.#closed = true;
    reportTail(this.bookId, null);
    void this.#keeper.stop({ release: false });
  }
}

import type { Clock } from "./clock.ts";
import {
  BookDeletedError,
  GENESIS_HASH,
  type AcquireResult,
  type AdoptResult,
  type AdoptState,
  type AppendInput,
  type AppendRefusal,
  type AppendResult,
  type LeaseGrant,
  type LogTier,
  type RenewResult,
  type SealManifest,
  type SealResult,
  type TailEntry,
  type TierCapabilities,
  type TierHead,
  type TierPage,
} from "./tier.ts";
import {
  Wire,
  type FaultKind,
  type ScriptedFault as WireScriptedFault,
  type WireOptions,
} from "./wire.ts";

export type TierOp = "append" | "read" | "head" | "acquire" | "renew" | "release" | "seal";
export const TIER_OPS: readonly TierOp[] = [
  "append",
  "read",
  "head",
  "acquire",
  "renew",
  "release",
  "seal",
];
export type TierScriptedFault = WireScriptedFault<TierOp>;

export interface MemoryTierOptions extends WireOptions<TierOp> {
  /** The tier's own clock, by which leases lapse. Defaults to the wire's clock; a test can give it a
   * clock of its own and step it, as an operator stepping a database host's time would. */
  readonly tailClock?: Clock;
  readonly name?: string;
}

interface BookState {
  seq: number;
  hash: string;
  sealedThrough: number;
  sealedHash: string;
  fence: number;
  holder: string | null;
  expiresAt: number | null;
  entries: TailEntry[];
  lastSeal: SealManifest | null;
}

/** What the tier did, for an oracle that checks the protocol from the outside. */
export interface TierRecord {
  readonly book: string;
  readonly op: "append" | "grant" | "renew" | "release" | "seal";
  readonly at: number;
  readonly client: string;
  readonly seq?: number;
  readonly hash?: string;
  readonly fence?: number;
  readonly holder?: string;
  readonly expiresAt?: number;
}

export interface TierRefusals {
  readonly append: Record<AppendRefusal, number>;
  readonly acquireHeld: number;
  readonly renewRefused: number;
}

/** The reference tail: strongly consistent, atomic per call, with the seeded faults of a {@link Wire}
 * (a lost response, a duplicate delivery, a 5xx, a client that dies, latency). Every other tier is
 * held to what this one does by the same conformance tests. */
export class MemoryLogTier implements LogTier {
  readonly wire: Wire<TierOp>;
  readonly capabilities: TierCapabilities;
  readonly tailClock: Clock;
  readonly #books = new Map<string, BookState>();
  /** Books that were deleted: nothing of them is kept and no call of any kind is answered (the tail Worker's mark). */
  readonly #deleted = new Set<string>();
  readonly #views = new Map<string, LogTier>();
  readonly records: TierRecord[] = [];
  refusals: { append: Record<AppendRefusal, number>; acquireHeld: number; renewRefused: number } = {
    append: { fence: 0, seq: 0, prev: 0 },
    acquireHeld: 0,
    renewRefused: 0,
  };

  constructor(options: MemoryTierOptions = {}) {
    this.wire = new Wire<TierOp>(TIER_OPS, options);
    this.tailClock = options.tailClock ?? this.wire.clock;
    this.capabilities = { name: options.name ?? "memory", leases: true };
  }

  /** The tier as seen by one client process: killing the id freezes its calls. */
  client(id: string): LogTier {
    let view = this.#views.get(id);
    if (!view) {
      view = {
        capabilities: this.capabilities,
        head: (book) => this.#head(id, book),
        readFrom: (book, seq, limit) => this.#read(id, book, seq, limit),
        append: (book, input) => this.#append(id, book, input),
        acquire: (book, holder, ttl) => this.#acquire(id, book, holder, ttl),
        renew: (book, lease, ttl) => this.#renew(id, book, lease, ttl),
        release: (book, lease) => this.#release(id, book, lease),
        seal: (book, input) => this.#seal(id, book, input),
      };
      this.#views.set(id, view);
    }
    return view;
  }

  kill(client: string): void {
    this.wire.kill(client);
  }
  script(rules: readonly TierScriptedFault[]): void {
    this.wire.script(rules);
  }
  configure(options: Pick<WireOptions<TierOp>, "latency" | "faults" | "timeoutMs">): void {
    this.wire.configure(options);
  }
  get faultsSeen(): Record<FaultKind, number> {
    return this.wire.faultsSeen;
  }

  head(book: string): Promise<TierHead> {
    return this.#head("default", book);
  }
  readFrom(book: string, seq: number, limit?: number): Promise<TierPage> {
    return this.#read("default", book, seq, limit);
  }
  append(book: string, input: AppendInput): Promise<AppendResult> {
    return this.#append("default", book, input);
  }
  acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    return this.#acquire("default", book, holder, ttlMs);
  }
  renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    return this.#renew("default", book, lease, ttlMs);
  }
  release(book: string, lease: { readonly holder: string; readonly fence: number }): Promise<void> {
    return this.#release("default", book, lease);
  }
  seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    return this.#seal("default", book, input);
  }

  /** An operator's step (see {@link LogTier.adopt}): no fault is injected into it. */
  adopt(book: string, state: AdoptState): Promise<AdoptResult> {
    const held = this.#state(book);
    const live =
      held.holder !== null && held.expiresAt !== null && held.expiresAt > this.tailClock.now();
    if (held.seq !== 0 || held.sealedThrough !== 0 || held.entries.length > 0 || live)
      return Promise.resolve({ ok: false, reason: "not_empty", head: this.#headOf(held) });
    held.seq = state.seq;
    held.hash = state.hash;
    held.sealedThrough = state.seq;
    held.sealedHash = state.hash;
    held.fence = Math.max(held.fence, state.fence);
    held.holder = null;
    held.expiresAt = null;
    return Promise.resolve({ ok: true, head: this.#headOf(held) });
  }

  /** The book is deleted: what it held goes, and every later call for it, of any kind, throws {@link BookDeletedError}, as the tail Worker answers `410`. For tests of what a
   * pod does when a book is gone: it is not on {@link LogTier}, so nothing in the pod can call it. Deleting again changes nothing. */
  destroy(book: string): { readonly alreadyDeleted: boolean } {
    if (this.#deleted.has(book)) return { alreadyDeleted: true };
    this.#books.delete(book);
    this.#deleted.add(book);
    return { alreadyDeleted: false };
  }

  // ---- the god's-eye view for tests -----------------------------------------------------------

  /** The head and the tail entries, with no fault and no latency. */
  peek(book: string): { head: TierHead; entries: readonly TailEntry[] } {
    const state = this.#state(book);
    return { head: this.#headOf(state), entries: [...state.entries] };
  }
  /** Drop the newest `count` entries of a book and move the head back: what a failover to a
   * replica that was behind would do. A negative control for the durability checks, never a feature. */
  loseLast(book: string, count: number): void {
    const state = this.#state(book);
    const kept = state.entries.slice(0, Math.max(0, state.entries.length - count));
    state.entries = kept;
    const last = kept[kept.length - 1];
    state.seq = last ? last.seq : state.sealedThrough;
    state.hash = last ? last.hash : state.sealedHash;
  }

  // ---- operations ---------------------------------------------------------------------------------

  #state(book: string): BookState {
    if (this.#deleted.has(book)) throw new BookDeletedError();
    let state = this.#books.get(book);
    if (!state) {
      state = {
        seq: 0,
        hash: GENESIS_HASH,
        sealedThrough: 0,
        sealedHash: GENESIS_HASH,
        fence: 0,
        holder: null,
        expiresAt: null,
        entries: [],
        lastSeal: null,
      };
      this.#books.set(book, state);
    }
    return state;
  }

  #headOf(state: BookState): TierHead {
    const now = this.tailClock.now();
    const live = state.holder !== null && state.expiresAt !== null && state.expiresAt > now;
    return {
      seq: state.seq,
      hash: state.hash,
      sealedThrough: state.sealedThrough,
      sealedHash: state.sealedHash,
      fence: state.fence,
      leaseHolder: live ? state.holder : null,
      leaseExpiresAt: live ? state.expiresAt : null,
      now,
    };
  }

  #head(client: string, book: string): Promise<TierHead> {
    return this.wire.call(client, "head", book, () => this.#headOf(this.#state(book)));
  }

  #read(client: string, book: string, seq: number, limit: number | undefined): Promise<TierPage> {
    return this.wire.call(client, "read", book, () => {
      const state = this.#state(book);
      const from = state.entries.filter((entry) => entry.seq >= seq);
      return {
        entries: limit === undefined ? from : from.slice(0, limit),
        head: this.#headOf(state),
      };
    });
  }

  #append(client: string, book: string, input: AppendInput): Promise<AppendResult> {
    const body = input.body.slice();
    return this.wire.call(client, "append", `${book}#${input.seq}`, () => {
      const state = this.#state(book);
      const refuse = (reason: AppendRefusal): AppendResult => {
        this.refusals.append[reason] += 1;
        return { ok: false, reason, head: this.#headOf(state) };
      };
      // Under a lease the token must be the current one; a book nobody has ever leased takes nothing.
      if (input.fence <= 0 || input.fence !== state.fence) return refuse("fence");
      if (input.seq === state.seq && input.hash === state.hash)
        return { ok: true, duplicate: true, head: this.#headOf(state) };
      if (input.seq !== state.seq + 1) return refuse("seq");
      if (input.prevHash !== state.hash) return refuse("prev");
      state.entries.push({
        seq: input.seq,
        prevHash: input.prevHash,
        hash: input.hash,
        fence: input.fence,
        body,
        writtenAt: this.tailClock.now(),
      });
      state.seq = input.seq;
      state.hash = input.hash;
      this.records.push({
        book,
        op: "append",
        at: this.tailClock.now(),
        client,
        seq: input.seq,
        hash: input.hash,
        fence: input.fence,
      });
      return { ok: true, duplicate: false, head: this.#headOf(state) };
    });
  }

  #grant(state: BookState, holder: string, ttlMs: number): LeaseGrant {
    return {
      holder,
      fence: state.fence,
      ttlMs,
      expiresAt: state.expiresAt as number,
      head: this.#headOf(state),
    };
  }

  #acquire(client: string, book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    return this.wire.call(client, "acquire", book, () => {
      const state = this.#state(book);
      const now = this.tailClock.now();
      const live = state.holder !== null && state.expiresAt !== null && state.expiresAt > now;
      if (live && state.holder !== holder) {
        this.refusals.acquireHeld += 1;
        return {
          ok: false,
          heldBy: state.holder as string,
          expiresInMs: (state.expiresAt as number) - now,
          head: this.#headOf(state),
        };
      }
      // The same holder asking again inside its lease keeps its token; anyone else, or the same
      // holder after a lapse, begins a new tenure with the next token.
      if (!(live && state.holder === holder)) state.fence += 1;
      state.holder = holder;
      state.expiresAt = now + ttlMs;
      this.records.push({
        book,
        op: "grant",
        at: now,
        client,
        fence: state.fence,
        holder,
        expiresAt: state.expiresAt,
      });
      return { ok: true, lease: this.#grant(state, holder, ttlMs) };
    });
  }

  #renew(
    client: string,
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    return this.wire.call(client, "renew", book, () => {
      const state = this.#state(book);
      const now = this.tailClock.now();
      const refuse = (reason: "expired" | "taken"): RenewResult => {
        this.refusals.renewRefused += 1;
        return { ok: false, reason, head: this.#headOf(state) };
      };
      if (state.holder !== lease.holder || state.fence !== lease.fence) return refuse("taken");
      if (state.expiresAt === null || state.expiresAt <= now) return refuse("expired");
      state.expiresAt = now + ttlMs;
      this.records.push({
        book,
        op: "renew",
        at: now,
        client,
        fence: state.fence,
        holder: lease.holder,
        expiresAt: state.expiresAt,
      });
      return { ok: true, lease: this.#grant(state, lease.holder, ttlMs) };
    });
  }

  #release(
    client: string,
    book: string,
    lease: { readonly holder: string; readonly fence: number },
  ): Promise<void> {
    return this.wire.call(client, "release", book, () => {
      const state = this.#state(book);
      if (state.holder === lease.holder && state.fence === lease.fence) {
        // The token dies with the lease: a late append from the one who let go is refused too.
        state.fence += 1;
        state.holder = null;
        state.expiresAt = this.tailClock.now();
        this.records.push({
          book,
          op: "release",
          at: state.expiresAt,
          client,
          fence: state.fence,
          holder: lease.holder,
        });
      }
    });
  }

  #seal(
    client: string,
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    return this.wire.call(client, "seal", `${book}#${input.upTo}`, () => {
      const state = this.#state(book);
      if (input.upTo > state.seq) return { ok: false, reason: "ahead", head: this.#headOf(state) };
      if (input.upTo <= state.sealedThrough)
        return { ok: true, trimmed: 0, head: this.#headOf(state) };
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) => entry.seq > input.upTo);
      state.sealedThrough = input.upTo;
      state.sealedHash = input.manifest.lastHash;
      state.lastSeal = input.manifest;
      this.records.push({
        book,
        op: "seal",
        at: this.tailClock.now(),
        client,
        seq: input.upTo,
        hash: input.manifest.lastHash,
      });
      return { ok: true, trimmed: before - state.entries.length, head: this.#headOf(state) };
    });
  }
}

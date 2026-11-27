/** The books a pod serves besides its home book: the ones a signed member token names, and the ones the control plane's key
 * makes. A pod opens a book when its first request arrives, keeps it while it is used, closes the ones nobody uses, closes the
 * least recently used when its memory budget is reached, and keeps one tenant from taking the whole pod. The design and the
 * numbers it is built on are in docs/reference/program/hosting/many-books.md.
 *
 * The registry does not open a book itself. It decides whether a request may go on to one (the limits of the book, room in the
 * pod, the load queue), counts what the book is expected to cost while it is opening and what it costs once it is open, and
 * closes what has to go. The request then opens the book through the slot, as the home book's requests do. */
import { BookClosedError, memoryLimitBytes } from "@rastrata/booklog";
import { gauge, sizeBucket } from "@rastrata/telemetry";

const MB = 2 ** 20;

/** While the books held take more than this share of the warm budget the pod is crowded, and a book idle for `CROWDED_IDLE_MS` is closed instead of waiting for `idleMs`: the long
 * wait is for a pod that has room, and a pod that has not goes on as it did when every book went after ten minutes. */
export const CROWDED_SHARE = 0.75;
export const CROWDED_IDLE_MS = 10 * 60_000;

/** What the registry needs of a slot. `BookSlot` is one; a test supplies a stand-in. */
export interface ServedSlot {
  /** Whether the slot holds its book. */
  readonly open: boolean;
  /** The sequence of the newest entry of the book it holds, or null when it holds none. It says little of the size of a book that was imported whole. */
  readonly seq: number | null;
  /** The size of the book's cache file, which says how big it is, or null when it holds none. */
  readonly bytes: number | null;
  /** Close the book and forget its cache. */
  evict(): Promise<void>;
  /** Close the book for good, as the process stops. */
  stop(): Promise<void>;
}

/** The memory a warm book is expected to take. From the file of its cache when that is known, which is how big the book is whatever its log
 * looks like: about 2 MB and two and a half times the file (measured on books of 20 to 5,000 journals, which took from 21 to 93 MB warm for files
 * of 0.4 to 34 MB). From the length of its log when it is not: about 1.7 MB and 8 KB a journal, times 1.5 for the allocator
 * (docs/reference/program/hosting/hostload.md), a journal being three entries. The greater of the two is used when both are known, since a log that
 * is long for a small file is a book that was rewritten, and a short log with a large file is a book that was imported whole. */
export function warmBookBytes(seq: number | null, fileBytes: number | null = null): number {
  const journals = seq === null ? 0 : Math.floor(seq / 3);
  const fromLog = (1.7 * MB + 8 * 1024 * journals) * 1.5;
  const fromFile = fileBytes === null ? 0 : 2 * MB + 2.5 * fileBytes;
  return Math.round(Math.max(fromLog, fromFile));
}

/** What a cold load of a book of this size needs while it runs, above what the book will take once it is warm: about 40 MB and four times the file
 * (a 34 MB book peaked 250 MB above its start, with garbage not yet collected). The limiter is told this. */
export function activationBytesFor(fileBytes: number): number {
  return Math.round(40 * MB + 4 * fileBytes);
}

/** What a book that is opening is counted for until it is open and its size is known: the size of a book of a thousand journals. */
export const TYPICAL_BOOK_BYTES = warmBookBytes(3000);

/** How many books' sizes are remembered after they are closed, so that the next opening is counted and gated for what the book took last time. */
const REMEMBERED_SIZES = 4096;

export interface BooksSettings {
  /** The most books held open at once, besides the home book. */
  readonly maxBooks: number;
  /** The sum of the expected sizes of the books held open may not pass this. */
  readonly warmBudgetBytes: number;
  /** A book nobody has asked for in this long is closed (sooner while the pod is crowded, see `CROWDED_SHARE`). */
  readonly idleMs: number;
  /** The same, while the process is short of memory. */
  readonly pressureIdleMs: number;
  /** How often idle books are looked for, in milliseconds; 0 for never (a test sweeps by hand). */
  readonly sweepMs: number;
  /** Cold loads allowed at once, and the memory they may be expected to need together. */
  readonly loads: number;
  readonly loadBytes: number;
  /** Requests that may wait for a cold load; past this, the answer is "busy". */
  readonly loadQueue: number;
  /** Requests at once, and per second (with a burst), for one book. */
  readonly inflight: number;
  readonly rate: number;
  readonly burst: number;
  /** The same per second for the control plane's key, which is one caller for every book. */
  readonly serviceRate: number;
  readonly serviceBurst: number;
  /** While the process's resident memory is past this, no book is opened (0 for no check). */
  readonly residentLimitBytes: number;
}

/** How long a book stays open after its last use while the pod has room: thirty days. The list a pod leaves for the pods after it names the books used in the same time (`HOT_BOOK_MAX_AGE_MS`). */
export const BOOK_IDLE_MS = 30 * 86_400_000;

/** The settings for a process allowed `memoryBytes`: the warm books may have what is left of it after the process itself (about 130 MB with
 * its first book), the cold loads a fifth, and a tenth is kept free. */
export function defaultBooksSettings(
  memoryBytes: number = memoryLimitBytes(),
  overrides: Partial<BooksSettings> = {},
): BooksSettings {
  const floor = 130 * MB;
  const loadBytes = Math.round(memoryBytes * 0.2);
  return {
    maxBooks: 256,
    warmBudgetBytes: Math.max(
      64 * MB,
      Math.round(memoryBytes - floor - loadBytes - memoryBytes * 0.1),
    ),
    // Hours, and not minutes: what closes a book is the budget (the least recently used goes when another needs the room) and a pod short of memory (`pressureIdleMs`),
    // and not the clock. A book that was closed is read again from its log, which is seconds for a book with years in it (about a millisecond for each journal), and a
    // person who comes back from a coffee break, or in the afternoon, must not wait for that on a blank page. Nor the next morning, nor at the next month's end: it was six hours until the founder's
    // first visit of a day (2026-11-22) found the book closed and took ten seconds, and books are kept by the month, so a book is kept for thirty days after its last use. An open book that is not
    // asked for costs its memory, which the budget counts, and nothing else (its lease is given up after a minute).
    idleMs: BOOK_IDLE_MS,
    pressureIdleMs: 30_000,
    sweepMs: 30_000,
    loads: 2,
    loadBytes,
    loadQueue: 64,
    // One page of the application asks for some twenty-five things at once, and they all wait together while a book is opened: at 32, a second page beside it (a reload, another member, the
    // person's agent) was turned away. What protects the pod is the rate, and the budget of memory; this is the bound on what one book may have waiting.
    inflight: 128,
    rate: 30,
    burst: 90,
    serviceRate: 20,
    serviceBurst: 60,
    residentLimitBytes: Math.round(memoryBytes * 0.9),
    ...overrides,
  };
}

/** Why a request was not let through to its book. */
export class BooksRefused extends Error {
  readonly failure: {
    readonly code: "server_busy" | "rate_limited";
    readonly message: string;
    readonly retryable: true;
    readonly status: 503 | 429;
    readonly retryAfterSeconds: number;
  };
  constructor(kind: "busy" | "rate", retryAfterSeconds: number) {
    super(
      kind === "busy" ? "The server is busy with other books" : "Too many requests for the book",
    );
    this.name = "BooksRefused";
    this.failure =
      kind === "busy"
        ? {
            code: "server_busy",
            message: "The server is busy with other books; try again in a moment.",
            retryable: true,
            status: 503,
            retryAfterSeconds,
          }
        : {
            code: "rate_limited",
            message: "Too many requests for this book; slow down and try again in a moment.",
            retryable: true,
            status: 429,
            retryAfterSeconds,
          };
  }
}

/** A token bucket: `rate` a second, `burst` at most. */
export class TokenBucket {
  #tokens: number;
  #at: number;
  readonly #rate: number;
  readonly #burst: number;
  constructor(rate: number, burst: number, now: number) {
    this.#rate = rate;
    this.#burst = burst;
    this.#tokens = burst;
    this.#at = now;
  }
  /** 0 when a token was taken; otherwise the seconds until one will be there. */
  take(now: number): number {
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
    this.#at = now;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return (1 - this.#tokens) / this.#rate;
  }
}

interface Entry<S extends ServedSlot> {
  readonly id: string;
  readonly slot: S;
  readonly bucket: TokenBucket;
  inflight: number;
  lastUsed: number;
  /** Whether the book is counted in the budget, and for how much. */
  counted: boolean;
  bytes: number;
  /** When the cache file was last measured. */
  measuredAt: number;
  /** Being closed: not a candidate for closing again. */
  evicting: boolean;
}

export interface Lease<S extends ServedSlot> {
  readonly slot: S;
  /** The request is over. Once only; later calls do nothing. */
  release(): void;
}

export interface RegistryStats {
  /** Books the pod holds open besides the home book, and books counted in the budget (those opening are counted too). */
  readonly open: number;
  /** Books the registry keeps account of, open or not (a book that is closed is kept, with its allowance, until the sweep finds it idle). */
  readonly tracked: number;
  readonly counted: number;
  readonly expectedBytes: number;
  readonly maxBooks: number;
  readonly budgetBytes: number;
  readonly closed: { readonly idle: number; readonly room: number; readonly pressure: number };
  readonly refused: { readonly busy: number; readonly rate: number };
  readonly queued: number;
}

export interface RegistryOptions<S extends ServedSlot> {
  readonly settings: BooksSettings;
  /** Make the slot for a book. `sizeHint` says how big the book's cache file was when this process last held it, if it did. */
  readonly make: (id: string, sizeHint: () => number | undefined) => S;
  /** Cold loads waiting for a place, from the activation limiter. */
  readonly queued?: () => number;
  /** For tests. */
  readonly now?: () => number;
  readonly rss?: () => number;
}

export class BookRegistry<S extends ServedSlot> {
  readonly #settings: BooksSettings;
  readonly #make: (id: string, sizeHint: () => number | undefined) => S;
  readonly #queued: () => number;
  readonly #now: () => number;
  readonly #rss: () => number;
  readonly #entries = new Map<string, Entry<S>>();
  readonly #service: TokenBucket;
  #counted = 0;
  #bytes = 0;
  /** The size of the cache file each book had when last measured, newest last. */
  readonly #sizes = new Map<string, number>();
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #closed = { idle: 0, room: 0, pressure: 0 };
  readonly #refused = { busy: 0, rate: 0 };

  constructor(options: RegistryOptions<S>) {
    this.#settings = options.settings;
    this.#make = options.make;
    this.#queued = options.queued ?? (() => 0);
    this.#now = options.now ?? (() => Date.now());
    this.#rss = options.rss ?? (() => process.memoryUsage.rss());
    this.#service = new TokenBucket(
      options.settings.serviceRate,
      options.settings.serviceBurst,
      this.#now(),
    );
    if (options.settings.sweepMs > 0) {
      this.#timer = setInterval(() => void this.sweep().catch(() => {}), options.settings.sweepMs);
      (this.#timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** The size of the cache file the book had when it was last held, or undefined if this process has not held it. */
  remembered(id: string): number | undefined {
    return this.#sizes.get(id);
  }

  #remember(id: string, bytes: number): void {
    this.#sizes.delete(id);
    this.#sizes.set(id, bytes);
    if (this.#sizes.size > REMEMBERED_SIZES) {
      const oldest = this.#sizes.keys().next().value;
      if (oldest !== undefined) this.#sizes.delete(oldest);
    }
  }

  stats(): RegistryStats {
    let open = 0;
    for (const entry of this.#entries.values()) if (entry.slot.open) open += 1;
    return {
      open,
      tracked: this.#entries.size,
      counted: this.#counted,
      expectedBytes: this.#bytes,
      maxBooks: this.#settings.maxBooks,
      budgetBytes: this.#settings.warmBudgetBytes,
      closed: { ...this.#closed },
      refused: { ...this.#refused },
      queued: this.#queued(),
    };
  }

  /** The books this registry holds open, the one used last first, with when each was last used (milliseconds since 1970): what a pod tells the pods that start after it (hot-books.ts). A book that is being
   * closed is not on it. */
  hot(): { readonly id: string; readonly at: number }[] {
    const books: { id: string; at: number }[] = [];
    for (const entry of this.#entries.values())
      if (entry.slot.open && !entry.evicting) books.push({ id: entry.id, at: entry.lastUsed });
    return books.sort((left, right) => right.at - left.at);
  }

  /** Say when a book was last used, for a book that was opened ahead of a request and has not been used since: its use is what the list it was opened from said, and not the moment it was opened, or a book that nobody asks for
   * would be kept, and told to the next server, for ever. A time ahead of this clock is now. Nothing is done for a book that is not tracked or is in use. */
  markUsed(id: string, at: number): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined && entry.inflight === 0) entry.lastUsed = Math.min(at, this.#now());
  }

  /** Let a request go on to book `id`, or say why not. `caller` is the control plane's key or a member. The book is not opened here:
   * the request opens it through the slot, and releases the lease when it is over. */
  async acquire(
    id: string,
    caller: "member" | "service" = "member",
    /** `evict: false`: do not close another book to make room (a server opening the books in use before it is ready, which would only be closing the ones it has just opened): say "busy" instead. */
    options: { readonly evict?: boolean } = {},
  ): Promise<Lease<S>> {
    if (this.#stopped) throw new BookClosedError(id);
    const now = this.#now();
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = {
        id,
        slot: this.#make(id, () => this.#sizes.get(id)),
        bucket: new TokenBucket(this.#settings.rate, this.#settings.burst, now),
        inflight: 0,
        lastUsed: now,
        counted: false,
        bytes: 0,
        measuredAt: 0,
        evicting: false,
      };
      this.#entries.set(id, entry);
    }
    // The limits of the book come first, so that a flood for a book that is not open opens it for no one.
    if (entry.inflight >= this.#settings.inflight) {
      this.#refused.rate += 1;
      throw new BooksRefused("rate", 1);
    }
    const wait = (caller === "service" ? this.#service : entry.bucket).take(now);
    if (wait > 0) {
      this.#refused.rate += 1;
      throw new BooksRefused("rate", Math.max(1, Math.ceil(wait)));
    }
    entry.inflight += 1;
    entry.lastUsed = now;
    try {
      if (!entry.counted) await this.#reserve(entry, options.evict !== false);
    } catch (error) {
      entry.inflight -= 1;
      throw error;
    }
    let released = false;
    return {
      slot: entry.slot,
      release: () => {
        if (released) return;
        released = true;
        entry.inflight -= 1;
        entry.lastUsed = this.#now();
        if (entry.slot.open) this.#settle(entry);
        else this.#uncount(entry);
      },
    };
  }

  /** Make room for a book that is about to open, and count it. Says "busy" when there is none to make. */
  async #reserve(entry: Entry<S>, evict = true): Promise<void> {
    const limit = this.#settings.residentLimitBytes;
    if (limit > 0 && this.#rss() > limit) {
      this.#refused.busy += 1;
      throw new BooksRefused("busy", 5);
    }
    if (this.#settings.loadQueue > 0 && this.#queued() >= this.#settings.loadQueue) {
      this.#refused.busy += 1;
      throw new BooksRefused("busy", 3);
    }
    // A book held before is counted for what it took then; one this process has not seen, for a typical one.
    const known = this.#sizes.get(entry.id);
    const expected =
      known === undefined
        ? TYPICAL_BOOK_BYTES
        : Math.max(TYPICAL_BOOK_BYTES, warmBookBytes(null, known));
    while (
      this.#counted + 1 > this.#settings.maxBooks ||
      this.#bytes + expected > this.#settings.warmBudgetBytes
    ) {
      const victim = evict ? this.#leastRecentlyUsedIdle(entry) : null;
      if (victim === null) {
        this.#refused.busy += 1;
        throw new BooksRefused("busy", 2);
      }
      await this.#evict(victim, "room");
    }
    // Nothing awaits between the check above and this, so two requests cannot both take the last place.
    entry.counted = true;
    entry.bytes = expected;
    this.#counted += 1;
    this.#bytes += expected;
  }

  /** The book is open: count it for what it is, and close others if it has taken the pod past its budget. */
  #settle(entry: Entry<S>): void {
    if (entry.counted) {
      // The file is measured when the book has just opened and then at most once a minute: a request should not cost a call to the file system.
      const now = this.#now();
      let file = this.#sizes.get(entry.id) ?? null;
      if (now - entry.measuredAt >= 60_000 || entry.measuredAt === 0) {
        const measured = entry.slot.bytes;
        if (measured !== null) {
          file = measured;
          this.#remember(entry.id, measured);
          entry.measuredAt = now;
        }
      }
      const real = warmBookBytes(entry.slot.seq, file);
      this.#bytes += real - entry.bytes;
      entry.bytes = real;
    }
    this.#publish();
    if (this.#bytes > this.#settings.warmBudgetBytes) void this.#trim(entry).catch(() => {});
  }

  /** Close least recently used idle books until the budget holds. */
  async #trim(keep: Entry<S>): Promise<void> {
    while (this.#bytes > this.#settings.warmBudgetBytes) {
      const victim = this.#leastRecentlyUsedIdle(keep);
      if (victim === null) return;
      await this.#evict(victim, "room");
    }
  }

  #leastRecentlyUsedIdle(except: Entry<S> | null): Entry<S> | null {
    let found: Entry<S> | null = null;
    for (const entry of this.#entries.values()) {
      if (entry === except || entry.evicting || entry.inflight > 0) continue;
      if (!entry.counted || !entry.slot.open) continue;
      if (found === null || entry.lastUsed < found.lastUsed) found = entry;
    }
    return found;
  }

  async #evict(entry: Entry<S>, reason: "idle" | "room" | "pressure"): Promise<void> {
    entry.evicting = true;
    // The memory is counted as given back at once: a request that arrives while the book is closing must not close another for it.
    if (entry.counted) {
      this.#bytes -= entry.bytes;
      this.#counted -= 1;
      entry.counted = false;
      entry.bytes = 0;
      entry.measuredAt = 0;
    }
    this.#closed[reason] += 1;
    this.#publish();
    try {
      await entry.slot.evict();
    } finally {
      entry.evicting = false;
      this.#uncount(entry);
      this.#publish();
    }
  }

  /** Give back the place counted for a book that nobody is using and that holds nothing (it could not be opened, or was closed under a
   * request that has since finished). The entry stays, with its bucket, until the sweep finds it idle: a book that keeps failing to open must
   * not get a fresh allowance with every request. */
  #uncount(entry: Entry<S>): void {
    if (entry.inflight > 0 || entry.evicting || entry.slot.open || !entry.counted) return;
    this.#bytes -= entry.bytes;
    this.#counted -= 1;
    entry.counted = false;
    entry.bytes = 0;
    entry.measuredAt = 0;
  }

  /** Close the books nobody has asked for in a while. Returns how many. */
  async sweep(): Promise<number> {
    const pressure =
      this.#settings.residentLimitBytes > 0 && this.#rss() > this.#settings.residentLimitBytes;
    // With room to spare a book is kept for hours; past three quarters of the budget, or past 90 % of the memory, the ones nobody is using go sooner.
    const crowded = this.#bytes > this.#settings.warmBudgetBytes * CROWDED_SHARE;
    const limit = pressure
      ? this.#settings.pressureIdleMs
      : crowded
        ? Math.min(CROWDED_IDLE_MS, this.#settings.idleMs)
        : this.#settings.idleMs;
    const now = this.#now();
    let closed = 0;
    for (const entry of [...this.#entries.values()]) {
      if (entry.evicting || entry.inflight > 0) continue;
      if (now - entry.lastUsed < limit) continue;
      if (entry.slot.open) {
        await this.#evict(entry, pressure ? "pressure" : "idle");
        closed += 1;
      }
      // Closed and idle: nothing more is kept of it, bucket included.
      if (!entry.slot.open && entry.inflight === 0 && !entry.evicting && !entry.counted)
        if (this.#entries.get(entry.id) === entry) this.#entries.delete(entry.id);
    }
    return closed;
  }

  /** The gauge of books held open, by size, for the whole process (the catalog allows no label that names a tenant). */
  #publish(): void {
    const counts: Record<"xs" | "s" | "m" | "l" | "xl", number> = {
      xs: 0,
      s: 0,
      m: 0,
      l: 0,
      xl: 0,
    };
    for (const entry of this.#entries.values()) {
      if (!entry.slot.open) continue;
      const bucket = sizeBucket(entry.slot.seq === null ? 0 : Math.floor(entry.slot.seq / 3));
      if (bucket !== "unknown") counts[bucket] += 1;
    }
    const resident = gauge("books.resident");
    for (const [bucket, count] of Object.entries(counts))
      resident.set(count, { size_bucket: bucket as keyof typeof counts });
  }

  /** Stop: no request is let through, and every book is closed, sealed and its lease given back. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await Promise.all(
      [...this.#entries.values()].map((entry) => entry.slot.stop().catch(() => {})),
    );
    this.#entries.clear();
    this.#counted = 0;
    this.#bytes = 0;
  }
}

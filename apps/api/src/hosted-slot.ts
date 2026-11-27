/** What a process keeps for one book it serves: whether it holds the book, follows it or has given it up, the book itself when it
 * is open, and the steps between those states (open, evict, hand over, take over, stop). The product server (hosted.ts) keeps
 * one slot for its home book; the registry of many books (hosted-books.ts) keeps one for each of the others. The record is
 * docs/reference/program/hosting/many-books.md. */
import { rmSync, statSync } from "node:fs";
import {
  BookClosedError,
  BookStandbyError,
  BookUnderReviewError,
  HostedBook,
  LeaseHeldElsewhereError,
  type HostedBookOptions,
} from "@rastrata/booklog";

/** What this process is doing with the book. `idle`: it opens the book when the first request needs
 * it. `standby`: it follows the book and serves nothing. `active`: it holds the book. `draining`: it
 * holds the book, answers reads and refuses writes, ahead of letting go. `released`: it has given the
 * book up and serves nothing. */
export type Role = "idle" | "standby" | "active" | "draining" | "released";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface BookSlotOptions {
  readonly id: string;
  /** Where the book's cache file is. It is deleted, with its journal files, when the book is evicted. */
  readonly cachePath: string;
  /** Start as a standby: follow the book without serving it (see `startFollowing`). */
  readonly standby?: boolean;
  /** A standby takes the book by itself as soon as its lease is free (the default), or only when told to. */
  readonly promote?: "auto" | "manual";
  /** How often a standby looks at the log, in milliseconds (default 250). */
  readonly followMs?: number;
  /** The options for opening the book. Called each time the book is opened, since a lease holder's name must not repeat. */
  readonly bookOptions: () => HostedBookOptions;
  /** Whether the process is stopping: a request that arrives too late does not take the book again. */
  readonly stopping: () => boolean;
  /** Asked before the book is opened, each time: it throws `BookUnderReviewError` to refuse the book (a book under review is not opened, no lease is taken and nothing is written). It is asked
   * again of a book that is open, at most every `recheckMs`, so that a stop written while people are using the book closes it; an answer that is any other failure (the store did not
   * answer) leaves an open book as it is. */
  readonly beforeOpen?: () => Promise<void>;
  /** How long an open book goes without being asked about again, in milliseconds (default 300,000; 0 asks at every request). */
  readonly recheckMs?: number;
  /** Called when the check the application makes behind the book's answers (`HostedApplication.verification`) finds that the book's ledger does not replay: it writes the stop, the same as the verifier's, so that
   * no process serves the book until a person has cleared it. The slot closes the book after it. Absent: the book is closed and the next request opens it again. */
  readonly unsound?: () => Promise<unknown>;
  /** How long a request waits for a book that another process holds, in milliseconds (default 0: it is refused at once, `book_busy`). A holder gives its books up when it stops, and one
   * that was killed lets go of them when their leases lapse, so a process that starts beside the one it replaces, or after one that died, waits a moment for the book and does not turn
   * the person away. */
  readonly leaseWaitMs?: number;
  /** Asked when another process holds the book: whether that process is a peer that the request can be handed to (hosted-peers.ts). If it is, the wait is skipped and `HeldByPeerError` is
   * thrown at once, for the caller to hand the request on. */
  readonly peerHolds?: (heldBy: string) => Promise<boolean>;
  /** The whole read (whole-read.ts), for this book: whether the next open is the first this process makes of it, what to do when that open has answered (the log is read from its first entry in the background), and
   * what to make of a first open that failed. Absent: nothing is read in the background. */
  readonly wholeRead?: {
    readonly first: () => boolean;
    readonly opened: () => void;
    readonly failed: (error: unknown) => Promise<unknown>;
  };
}

/** How often a request that waits for a book asks again whether it is free. */
const LEASE_WAIT_STEP_MS = 250;

/** The book is held by a peer that the request can be handed to (see `BookSlotOptions.peerHolds`): said at once, without waiting. It is `LeaseHeldElsewhereError` to anything that does not know
 * of peers, so a request that is not handed on is answered as a book that is busy. */
export class HeldByPeerError extends LeaseHeldElsewhereError {}

export class BookSlot {
  readonly id: string;
  readonly cachePath: string;
  #role: Role;
  /** The book this process holds. */
  #book: HostedBook | null = null;
  #opening: Promise<HostedBook> | null = null;
  /** The book it follows, as a standby. */
  #following: HostedBook | null = null;
  #followLoop: Promise<void> | null = null;
  /** The book this process has opened without holding it, to have it ready before anyone asks (`prewarm`), and the opening of it while it is going on. */
  #warm: HostedBook | null = null;
  #warming: Promise<boolean> | null = null;
  /** Evictions, handovers and the stop run one at a time, and a request waits for them before it opens the book. */
  #transition: Promise<void> = Promise.resolve();
  /** When the book was last allowed (it was opened, or `beforeOpen` was asked about it), and the question under way. */
  #allowedAt = 0;
  #asking: Promise<void> | null = null;
  readonly #options: BookSlotOptions;

  constructor(options: BookSlotOptions) {
    this.#options = options;
    this.id = options.id;
    this.cachePath = options.cachePath;
    this.#role = options.standby ? "standby" : "idle";
  }

  get role(): Role {
    return this.#role;
  }
  /** The book this slot holds, or null when it holds none. */
  get book(): HostedBook | null {
    return this.#book;
  }
  /** The book a standby follows, or null. */
  get following(): HostedBook | null {
    return this.#following;
  }
  /** Whether the slot has opened the book without holding it (`prewarm`) and no request has taken it yet. */
  get warmed(): boolean {
    return this.#warm !== null;
  }
  /** The check the application is making behind the book that was opened ahead (every outcome of its ledger executed again), or null when there is none: a server that is opening the books in use waits for it,
   * for as long as its time for opening them allows, so that it is over before the first person asks. */
  checking(): Promise<void> | null {
    return this.#warm?.application.verification?.() ?? null;
  }
  /** Whether the slot holds the book (it is open here, whatever the lease is doing; one opened without being held, `prewarm`, is open too: it takes the memory). */
  get open(): boolean {
    return this.#book !== null || this.#warm !== null;
  }
  /** The size of the book's cache file, which is how big the book is, or null when it holds none or the file cannot be read. */
  get bytes(): number | null {
    if (!this.#book && !this.#warm) return null;
    try {
      return statSync(this.cachePath).size;
    } catch {
      return null;
    }
  }
  /** The sequence of the newest entry of the book it holds, or null when it holds none. */
  get seq(): number | null {
    const held = this.#book ?? this.#warm;
    return held ? held.runtime.head.seq : null;
  }

  /** The book, opened if need be (once, however many requests are waiting for it). */
  async current(): Promise<HostedBook> {
    // A book that is being opened without being held (`prewarm`) is waited for and taken: opening it again beside it would be two files for one book.
    if (this.#warming) await this.#warming.catch(() => {});
    await this.#transition;
    // A standby, or a process that has given the book up, does not hold it and does not open it.
    if (this.#role === "standby" || this.#role === "released") throw new BookStandbyError(this.id);
    if (this.#book) {
      await this.#stillAllowed();
      return this.#book ?? this.current();
    }
    // A process that is stopping does not take the book again for a request that arrived too late.
    if (this.#options.stopping()) throw new BookClosedError(this.id);
    this.#opening ??= (async () => {
      try {
        await this.#options.beforeOpen?.();
      } catch (error) {
        // A book that was opened ahead and has been stopped since (the verifier, or the read of its whole log) is let go: nobody is served from it.
        if (error instanceof BookUnderReviewError) await this.#dropWarm();
        throw error;
      }
      return this.#openWhenFree();
    })()
      .then((opened) => {
        this.#book = opened;
        this.#allowedAt = Date.now();
        if (this.#role === "idle") this.#role = "active";
        return opened;
      })
      .finally(() => {
        this.#opening = null;
      });
    return this.#opening;
  }

  /** Open the book. While another process holds it, ask again every quarter of a second for as long as `leaseWaitMs` allows (the requests that want the book share this one wait), then say
   * `LeaseHeldElsewhereError` as before. A process that is stopping does not go on waiting, and neither does one whose holder is a peer (`peerHolds`) that the request can be handed to. */
  async #openWhenFree(): Promise<HostedBook> {
    const until = Date.now() + (this.#options.leaseWaitMs ?? 0);
    for (;;) {
      const first = this.#options.wholeRead?.first() ?? false;
      try {
        const given = this.#options.bookOptions();
        let opened: HostedBook | null = null;
        const options: HostedBookOptions = {
          ...given,
          unsound: (error: unknown) => void this.#unsound(opened, error),
        };
        // A book opened without being held is taken (the lease, and what the log has gained since); any other is opened.
        const warm = this.#warm;
        const book = warm ? await this.#take(warm) : await HostedBook.open(options);
        opened = book;
        // The first open this process has made of the book has answered: its log is read from the first entry now, behind the first answer.
        if (first) this.#options.wholeRead?.opened();
        return book;
      } catch (error) {
        // A first open that fails because of the log stops the book the second time it does (whole-read.ts).
        if (first && !(error instanceof LeaseHeldElsewhereError))
          throw await (this.#options.wholeRead?.failed(error) ?? error);
        if (!(error instanceof LeaseHeldElsewhereError) || this.#options.stopping()) throw error;
        if (await this.#options.peerHolds?.(error.heldBy))
          throw new HeldByPeerError(error.heldBy, error.expiresInMs);
        const left = until - Date.now();
        if (left <= 0) throw error;
        await sleep(Math.min(left, LEASE_WAIT_STEP_MS));
      }
    }
  }

  /** Take the lease of the book that was opened without it, and read what the log has gained since: a round trip and a few entries, and not a cold open. Says `LeaseHeldElsewhereError` while another process holds the book. */
  async #take(warm: HostedBook): Promise<HostedBook> {
    await warm.promote();
    this.#warm = null;
    return warm;
  }

  /** Open the book without taking it, so that the first request finds it open: the cache is read from the snapshot and the log, the application is built and has answered a first read
   * (`HostedBook.openStandby`), and no lease is taken, so a book that another process holds can be opened this way, and nothing is renewed. A pod that starts beside the one it replaces
   * does this for the books in use before it says it is ready (hot-books.ts); the first request takes the lease. Says whether the book is open this way now: not when it is open already, when
   * the process is stopping or follows the book, when the book is under review (`beforeOpen`), or when it could not be read, and a book that did not open costs nothing: its first request opens
   * it. A request that comes while this is going on waits for it and takes the book it opens. */
  prewarm(): Promise<boolean> {
    this.#warming ??= this.#prewarm().finally(() => {
      this.#warming = null;
    });
    return this.#warming;
  }

  async #prewarm(): Promise<boolean> {
    await this.#transition;
    const busy = () =>
      this.#role !== "idle" ||
      this.#book ||
      this.#warm ||
      this.#opening ||
      this.#options.stopping();
    if (busy()) return this.#warm !== null;
    try {
      await this.#options.beforeOpen?.();
      // The first open this process makes of the book, and the log is read from its first entry behind it (whole-read.ts): this one is it, so that the read is over before the first person asks and
      // does not take the processor from the page that is being drawn. A book whose log is damaged is found, read twice, and stopped before anyone has been served from it.
      const first = this.#options.wholeRead?.first() ?? false;
      let warm: HostedBook | null = null;
      warm = await HostedBook.openStandby({
        ...this.#options.bookOptions(),
        unsound: (error: unknown) => void this.#unsound(warm, error),
      });
      if (busy()) {
        await warm.close({ seal: false, release: false }).catch(() => {});
        return false;
      }
      // A book with nothing in its log is not a book in use but a name on a list that nobody made: it is not kept, and nothing of it is left on disk.
      if (warm.runtime.head.seq === 0) {
        await warm.close({ seal: false, release: false }).catch(() => {});
        for (const suffix of ["", "-wal", "-shm"])
          rmSync(`${this.cachePath}${suffix}`, { force: true });
        return false;
      }
      this.#warm = warm;
      this.#allowedAt = Date.now();
      if (first) this.#options.wholeRead?.opened();
      return true;
    } catch {
      return false;
    }
  }

  /** Let go of the book that was opened without being held, and of its cache file: nobody was served from it, and a file that nothing is going to use is not kept. */
  async #dropWarm(): Promise<void> {
    const warm = this.#warm;
    this.#warm = null;
    if (!warm) return;
    await warm.close({ seal: false, release: false }).catch(() => {});
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${this.cachePath}${suffix}`, { force: true });
  }

  /** The check the application makes behind the book's answers failed (`HostedBookOptions.unsound`). A book whose ledger does not replay (`BookUnderReviewError`, which the pod makes of `LedgerReplayError`) is stopped: the
   * stop is written first, so that no process opens the book again until a person has cleared it, and then the book is closed here, so the next request is refused as one under review. Any other failure of the check
   * (a read that did not complete) says nothing about the book: it stays open, its writes waiting for a check that is made again. */
  async #unsound(book: HostedBook | null, error: unknown): Promise<void> {
    if (!(error instanceof BookUnderReviewError)) return;
    await this.#options.unsound?.().catch(() => {});
    if (book !== null && this.#book === book) await this.closeBook();
    else if (book !== null && this.#warm === book) await this.#dropWarm();
  }

  /** Ask again whether the open book may be served, if it has been a while. A book that is now under review is closed (the request in flight finishes, what the tail holds is sealed,
   * the lease is given back) and the request that asked is refused, like every request after it until a person has cleared the book. */
  async #stillAllowed(): Promise<void> {
    const ask = this.#options.beforeOpen;
    const every = this.#options.recheckMs ?? 300_000;
    if (!ask || Date.now() - this.#allowedAt < every) return;
    this.#asking ??= (async () => {
      try {
        await ask();
        this.#allowedAt = Date.now();
      } catch (error) {
        if (!(error instanceof BookUnderReviewError)) return;
        await this.closeBook();
        throw error;
      }
    })().finally(() => {
      this.#asking = null;
    });
    // Asked at every request (a test, or an operator who wants it so), the request waits for the answer and is refused by it. Otherwise the book was allowed when it opened and the answer is
    // a few minutes old, so the request does not wait for a listing of the bucket to find that there is nothing new: the question goes out and the first request after it finds the answer,
    // which for a book that was stopped is the book closed and the refusal. (Whoever was first after each five minutes used to wait for it.)
    if (every === 0) await this.#asking;
    else this.#asking.catch(() => {});
  }

  /** Stop the book this process holds, cleanly: the request in flight finishes, what the tail holds is
   * sealed, the lease is given back. */
  async closeBook(): Promise<void> {
    const held = this.#book ?? (this.#opening ? await this.#opening.catch(() => null) : null);
    this.#book = null;
    if (this.#role === "active" || this.#role === "draining") this.#role = "idle";
    if (held) await held.close().catch(() => {});
    await this.#dropWarm();
  }

  /** Drop the book from this process and forget its cache file. The next request opens it again from
   * the log and the bulk store, which is what a cold start costs. */
  evict(): Promise<void> {
    const run = this.#transition.then(async () => {
      await this.#warming?.catch(() => {});
      await this.closeBook();
      if (this.#following) {
        const dropped = this.#following;
        this.#following = null;
        await dropped.close({ seal: false, release: false }).catch(() => {});
      }
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(`${this.cachePath}${suffix}`, { force: true });
    });
    this.#transition = run.catch(() => {});
    return run;
  }

  // ---- a handover: the first half (refuse writes, keep answering reads) and the second (let go) -----
  drain(): boolean {
    if (!this.#book) return false;
    this.#book.drain();
    this.#role = "draining";
    return true;
  }

  handOver(): Promise<void> {
    const run = this.#transition.then(async () => {
      const held = this.#book ?? (this.#opening ? await this.#opening.catch(() => null) : null);
      this.#book = null;
      this.#role = "released";
      if (held) await held.close().catch(() => {});
      await this.#dropWarm();
    });
    this.#transition = run.catch(() => {});
    return run;
  }

  // ---- a standby: follow the log, keep the application warm, take the book when its lease is free ---
  async takeOver(): Promise<boolean> {
    const candidate = this.#following;
    if (!candidate || this.#role !== "standby") return false;
    try {
      await candidate.promote();
    } catch (error) {
      if (error instanceof LeaseHeldElsewhereError) return false;
      throw error;
    }
    this.#book = candidate;
    this.#following = null;
    this.#role = "active";
    return true;
  }

  async #follow(): Promise<void> {
    const every = this.#options.followMs ?? 250;
    while (!this.#options.stopping() && this.#role === "standby") {
      try {
        await this.#transition;
        if (this.#role !== "standby") break;
        if (!this.#following) {
          // A standby's log is read from the first entry too, the first time it follows the book.
          const first = this.#options.wholeRead?.first() ?? false;
          this.#following = await HostedBook.openStandby(this.#options.bookOptions());
          if (first) this.#options.wholeRead?.opened();
        }
        await this.#following.follow({ quietMs: 300 });
        if ((this.#options.promote ?? "auto") === "auto") await this.takeOver();
      } catch {
        // The log or the store could not be read just now; look again.
      }
      if (this.#role === "standby") await sleep(every);
    }
  }

  /** Begin following the book (a standby). */
  startFollowing(): void {
    this.#followLoop = this.#follow();
  }

  /** What stopping the process does for this book, in order: the follower ends, what is in flight finishes, the book is sealed
   * and its lease given back, and a book that was only followed is let go. */
  async stop(): Promise<void> {
    await this.#followLoop?.catch(() => {});
    await this.#warming?.catch(() => {});
    await this.#transition;
    await this.closeBook();
    if (this.#following)
      await this.#following.close({ seal: false, release: false }).catch(() => {});
    this.#following = null;
  }
}

import type { Database } from "bun:sqlite";
import { LeaseHeldElsewhereError, LeaseLostError } from "./lease.ts";
import { TailBehindBulkError } from "./materialize.ts";
import { ObjectStoreUncertain } from "./objectstore.ts";
import { BookUnderReviewError } from "./review.ts";
import {
  BookDrainingError,
  BookRuntime,
  BookStandbyError,
  CommitConflictError,
  CommitUncertainError,
  EntryTooLargeError,
  ReadNotLoggedError,
  type BookRuntimeOptions,
} from "./runtime.ts";
import { BookDeletedError } from "./tier.ts";
import { TailUnavailableError } from "./tier-guard.ts";

/** What a host builds on the book's database: something that answers requests. The database is the
 * runtime's own connection and the application must not close it. */
export interface HostedApplication {
  fetch(request: Request): Promise<Response>;
  close(): void | Promise<void>;
  /** What the application has worked out of the book that the one built after it may start from, which `open` is given when the database has moved on only by entries caught up from the log (an
   * application that rebuilt everything on each catch-up replayed the whole book for every entry another pod wrote). Opaque to the book log; the application takes only what the ledger vouches for. */
  carry?(): unknown;
  /** The check of the book that goes on behind the application's answers, when it makes one: a promise that rejects with what it found wrong. The host reads it (`HostedBook.application.verification`)
   * and stops the book when it rejects. */
  verification?(): Promise<void> | null;
  /** Waited for before a write is let in (not inside the write: reads go on meanwhile): the application says when it is safe to run a command on the book. */
  beforeWrite?(): Promise<void>;
}

/** Why the application is being built: the first time, or because the database changed beneath the
 * one before (a rolled-back request, entries caught up from the log, a rebuilt file). */
export type HostedReason = "open" | "rollback" | "caught-up" | "rebuilt";

/** A request that could not be answered by the book, and what the client should do about it. */
export interface HostedFailure {
  readonly code:
    | "commit_uncertain"
    | "commit_conflict"
    | "read_not_logged"
    | "tail_unavailable"
    | "service_limit"
    | "book_busy"
    | "book_standby"
    | "book_draining"
    | "tail_behind"
    | "lease_lost"
    | "book_deleted"
    | "book_under_review"
    | "entry_too_large";
  readonly message: string;
  /** Whether sending the same request again (under the same operation identity) can succeed. */
  readonly retryable: boolean;
  readonly status: number;
  /** How long the client should wait before it does (default: a second). */
  readonly retryAfterSeconds?: number;
}

export interface HostedBookOptions extends Omit<BookRuntimeOptions, "onReset"> {
  /** Build the application on the book's database. It is called once before the book serves and
   * again whenever the database has changed beneath the application's memory. Whatever the
   * application does to the schema while it opens is part of the book and is logged. */
  readonly open: (
    db: Database,
    reason: HostedReason,
    /** From the application this one replaces, for a catch-up only (see `HostedApplication.carry`). */
    carried?: unknown,
  ) => Promise<HostedApplication>;
  /** Whether the request may change the book. A request that does not is served from the cache with
   * no round trip while the lease is good; one that changes something anyway is logged before it is
   * answered, the same as a write. */
  readonly changesBook: (request: Request) => boolean;
  /** The identity the client gave a write, recorded in the entry. */
  readonly operationId?: (request: Request, body: Uint8Array | null) => string | null;
  /** For a read that has to be logged: before it is answered, or soon after. Undefined for "no
   * preference": what `readEffects.mode` says. A host that must have an audit row durable first says
   * so here; a log-first read that cannot be logged is refused (503 `read_not_logged`). */
  readonly effects?: (request: Request) => "log-first" | "defer" | undefined;
  /** A name for the request in the accounting of entries (default: the path after /v1/). */
  readonly label?: (request: Request) => string;
  /** The answer for a request the book could not take. It is given the request and its body, so that a
   * host can answer in the shape its clients expect (echoing the identities they sent). */
  readonly unavailable?: (
    failure: HostedFailure,
    request: { readonly request: Request; readonly body: Uint8Array | null },
  ) => Response;
  /** What `fetch` does when the book's lease was given up while it was quiet and another process holds the book by the time a request comes: `"answer"` (the default) answers `book_busy`; `"throw"` throws
   * `LeaseHeldElsewhereError`, for a server that can hand the request to the process that holds the book, or wait for it. */
  readonly heldElsewhere?: "answer" | "throw";
  /** (Standby) Make the application build what it keeps in memory now, by asking it for what a
   * person's first screen asks. Called after the application is built on a followed cache, and again
   * each time the cache moves under it, so that taking the book over finds it ready. */
  readonly warm?: (application: HostedApplication) => Promise<void>;
  /** Called, once for each check, when the check the application makes behind its answers (`HostedApplication.verification`) rejects: with what it found. The host decides what that says about the book
   * (a failure that is the book's own stops it; trouble of the host's does not). It is looked for after each request, so a check that began during one is watched from its end. */
  readonly unsound?: (error: unknown) => void;
}

interface Captured {
  readonly status: number;
  readonly statusText: string;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
}

const decoder = new TextDecoder();

/** The `operationId` of a JSON request body, if it has one. */
export function jsonOperationId(request: Request, body: Uint8Array | null): string | null {
  if (!body || !(request.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const parsed = JSON.parse(decoder.decode(body)) as { operationId?: unknown };
    return typeof parsed.operationId === "string" ? parsed.operationId : null;
  } catch {
    return null;
  }
}

const pathLabel = (request: Request): string =>
  new URL(request.url).pathname.replace(/^\/v1\//, "");

/** What a person is told when the tail is not being called because it keeps failing. */
export const SERVICE_LIMIT_MESSAGE = "Service limit reached, try again later.";

/** What a client should be told about an error the book raised while it was being opened or while it
 * served a request, or null when the error is not the book's (a bug, which propagates). */
export function hostedFailure(error: unknown): HostedFailure | null {
  // The tail is not being called because it keeps failing (a limit of the service, an outage): one
  // answer for it, whatever the request was about, including a read that was to be logged first.
  const unreached =
    error instanceof TailUnavailableError
      ? error
      : error instanceof ReadNotLoggedError && error.reason instanceof TailUnavailableError
        ? error.reason
        : null;
  if (unreached)
    return {
      code: "service_limit",
      message: SERVICE_LIMIT_MESSAGE,
      retryable: true,
      status: 503,
      retryAfterSeconds: Math.max(1, Math.ceil(unreached.retryAfterMs / 1000)),
    };
  if (error instanceof CommitUncertainError)
    return {
      code: "commit_uncertain",
      message:
        "The change may or may not have been saved. Send the same request again with the same operation identity to find out.",
      retryable: true,
      status: 503,
    };
  if (error instanceof CommitConflictError)
    return {
      code: "commit_conflict",
      message: "The book changed under the request again and again; send it again.",
      retryable: true,
      status: 503,
    };
  if (error instanceof ReadNotLoggedError)
    return {
      code: "read_not_logged",
      message:
        "This request is recorded in the book (an audit record) and the record could not be made durable, so it was refused. Send it again.",
      retryable: true,
      status: 503,
    };
  if (error instanceof ObjectStoreUncertain)
    return {
      code: "tail_unavailable",
      message:
        "The book's log could not be reached, so the request could not be served safely. Try again shortly.",
      retryable: true,
      status: 503,
    };
  if (error instanceof TailBehindBulkError)
    return {
      code: "tail_behind",
      message:
        "The book's log has lost state and is behind what the bulk store holds, so the book is not served. It needs restoring from the bulk store by an operator.",
      retryable: false,
      status: 503,
    };
  if (error instanceof BookStandbyError)
    return {
      code: "book_standby",
      message: "This process is waiting to take the book over and does not serve it yet.",
      retryable: true,
      status: 503,
    };
  if (error instanceof BookDrainingError)
    return {
      code: "book_draining",
      message:
        "The book is being handed to another process; writes are refused for a moment. Send it again.",
      retryable: true,
      status: 503,
    };
  if (error instanceof LeaseHeldElsewhereError)
    return {
      code: "book_busy",
      message: "The book is being served by another process; try again shortly.",
      retryable: true,
      status: 503,
    };
  if (error instanceof LeaseLostError)
    return {
      code: "lease_lost",
      message: "This process could not confirm that it still holds the book; try again.",
      retryable: true,
      status: 503,
    };
  if (error instanceof BookDeletedError)
    return {
      code: "book_deleted",
      message: "This book was deleted.",
      retryable: false,
      status: 410,
    };
  if (error instanceof BookUnderReviewError)
    return {
      code: "book_under_review",
      message: "This book is being checked and cannot be used for now.",
      retryable: false,
      status: 423,
    };
  // The library's own words (how many bytes, once packed) are for the logs; a person is told what to do.
  if (error instanceof EntryTooLargeError)
    return {
      code: "entry_too_large",
      message:
        "That is more than can be saved in one go. Split it into smaller parts, such as one statement file for each quarter, and send each.",
      retryable: false,
      status: 413,
    };
  return null;
}

/** The answer for a request the book could not take, when the host does not supply its own. */
export const hostedUnavailable = (failure: HostedFailure): Response =>
  Response.json(
    {
      ok: false,
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    },
    {
      status: failure.status,
      headers: {
        "cache-control": "no-store",
        ...(failure.retryable ? { "retry-after": String(failure.retryAfterSeconds ?? 1) } : {}),
      },
    },
  );

/** A book served from its log. Each request that changes the book runs inside one transaction on the
 * cache that is not committed until the entry is in the tail, and its answer is released only after
 * that (the write barrier at the end of the request). A request that does not change the book is
 * served from the cache under the lease. When the log moves under the application (a request is
 * undone, entries arrive from elsewhere, the file is rebuilt) the application is built again on the
 * connection. */
export class HostedBook {
  readonly #options: HostedBookOptions;
  #runtime: BookRuntime | null = null;
  #app: HostedApplication | null = null;
  #ready = false;
  /** How many times the application was built again after the first. */
  resets = 0;
  /** The value of `resets` when the application was last warmed (standby). */
  #warmedAt = -1;
  /** When the cache last moved under the application (standby), by this process's clock. */
  #movedAt = 0;
  /** The checks of the application that are being watched (`HostedBookOptions.unsound`), each once however many applications carry it. */
  readonly #watched = new WeakSet<Promise<void>>();

  private constructor(options: HostedBookOptions) {
    this.#options = options;
  }

  static async open(options: HostedBookOptions): Promise<HostedBook> {
    const book = new HostedBook(options);
    const {
      open: _open,
      changesBook: _changes,
      operationId: _id,
      unavailable: _un,
      label: _label,
      effects: _effects,
      warm: _warm,
      heldElsewhere: _held,
      unsound: _unsound,
      ...rest
    } = options;
    const runtime = await BookRuntime.open({
      ...rest,
      onReset: (reason, current) => book.#reset(current, reason),
    });
    book.#runtime = runtime;
    try {
      // The application opens inside a write: if it has to create or change tables (a new book, a
      // new release) that becomes the next entry of the log.
      await runtime.write(async () => {
        await book.#build(runtime, "open");
      });
      book.#ready = true;
    } catch (error) {
      await runtime.close({ seal: false }).catch(() => {});
      await Promise.resolve(book.#app?.close()).catch(() => {});
      throw error;
    }
    return book;
  }

  /** Follow a book without holding it (see `BookRuntime.openStandby`): the cache is read, the
   * application is built on it and warmed, and `follow` keeps all of that current. `promote` takes the
   * book when its lease is free. A standby refuses requests with `book_standby`. */
  static async openStandby(options: HostedBookOptions): Promise<HostedBook> {
    const book = new HostedBook(options);
    const {
      open: _open,
      changesBook: _changes,
      operationId: _id,
      unavailable: _un,
      label: _label,
      effects: _effects,
      warm: _warm,
      heldElsewhere: _held,
      unsound: _unsound,
      ...rest
    } = options;
    const runtime = await BookRuntime.openStandby({
      ...rest,
      onReset: (reason, current) => book.#reset(current, reason),
    });
    book.#runtime = runtime;
    try {
      // A standby cannot write, so the application is built outside a request.
      await book.#build(runtime, "open");
      book.#ready = true;
      await book.warm();
    } catch (error) {
      await runtime.close({ seal: false, release: false }).catch(() => {});
      await Promise.resolve(book.#app?.close()).catch(() => {});
      throw error;
    }
    return book;
  }

  /** Whether the application has built what it keeps in memory since the cache last moved under it. */
  get warmed(): boolean {
    return this.#warmedAt === this.resets;
  }

  /** Ask the application for what a first screen asks, so that it has built its read model. */
  async warm(): Promise<void> {
    const ask = this.#options.warm;
    if (!ask || !this.#app) return;
    const at = this.resets;
    const app = this.#app;
    // Not while the cache is being moved, or the book taken.
    await this.runtime.withCache(() => ask(app));
    this.#warmedAt = at;
  }

  /** (Standby) Apply what the log has beyond the cache, and warm the application again once the cache
   * has moved under it and then stayed still for `quietMs`. Warming is a whole replay of the ledger
   * for a large book, so a standby that chased a book being written to would do nothing else: it
   * keeps the cache current at once, and warms when the writes stop. */
  async follow(
    options: { readonly quietMs?: number } = {},
  ): Promise<{ readonly applied: number; readonly seq: number }> {
    const result = await this.runtime.follow();
    if (result.applied > 0) this.#movedAt = performance.now();
    if (!this.warmed && performance.now() - this.#movedAt >= (options.quietMs ?? 0))
      await this.warm();
    return result;
  }

  /** (Standby) Take the book. Says `LeaseHeldElsewhereError` while another process holds it. */
  async promote(): Promise<void> {
    await this.runtime.promote();
  }

  /** Refuse writes from now on and go on answering reads (the first half of a handover). */
  drain(): void {
    this.runtime.drain();
  }

  async #build(runtime: BookRuntime, reason: HostedReason): Promise<void> {
    // Entries caught up from the log leave what the application derived from the ledger true as far as it went, and the ledger vouches for where the new entries continue from it. A rollback or a
    // rebuilt file does not: the application starts again.
    const carried = reason === "caught-up" ? this.#app?.carry?.() : undefined;
    const app = await this.#options.open(
      runtime.db,
      reason,
      ...(carried === undefined || carried === null ? [] : [carried]),
    );
    const old = this.#app;
    this.#app = app;
    if (old) await Promise.resolve(old.close()).catch(() => {});
  }

  async #reset(runtime: BookRuntime, reason: Exclude<HostedReason, "open">): Promise<void> {
    // Until the book is open, the opening write builds the application itself.
    if (!this.#ready) return;
    this.resets += 1;
    await this.#build(runtime, reason);
  }

  get runtime(): BookRuntime {
    if (!this.#runtime) throw new Error("The book is not open");
    return this.#runtime;
  }

  get application(): HostedApplication {
    if (!this.#app) throw new Error("The book is not open");
    return this.#app;
  }

  #effects(request: Request): { effects?: "log-first" | "defer" } {
    const chosen = this.#options.effects?.(request);
    return chosen ? { effects: chosen } : {};
  }

  /** Begin watching the check the application makes behind its answers, if it has begun one that is not watched yet. */
  #watchVerification(): void {
    const watching = this.#options.unsound;
    if (!watching || !this.#app?.verification) return;
    const check = this.#app.verification();
    if (check === null || this.#watched.has(check)) return;
    this.#watched.add(check);
    check.catch((error: unknown) => watching(error));
  }

  /** Answer one request. */
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#answer(request);
    } finally {
      this.#watchVerification();
    }
  }

  async #answer(request: Request): Promise<Response> {
    const writes = this.#options.changesBook(request);
    const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : null;
    const operationId = (this.#options.operationId ?? jsonOperationId)(request, body);
    const label = (this.#options.label ?? pathLabel)(request);
    const run = async (): Promise<Captured> => {
      const again = new Request(request.url, {
        method: request.method,
        headers: new Headers(request.headers),
        ...(body ? { body: body as BodyInit } : {}),
        signal: request.signal,
      });
      const response = await this.application.fetch(again);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body: new Uint8Array(await response.arrayBuffer()),
      };
    };
    let done: Captured;
    try {
      // The application may need something to be true before a command is run on the book (that the ledger has been checked, behind the answers it began with). It is waited for here, before the
      // write is let in, so that the requests that only read are answered meanwhile.
      if (writes) await this.application.beforeWrite?.();
      done = writes
        ? await this.runtime.write(run, { label, ...(operationId ? { opId: operationId } : {}) })
        : await this.runtime.read(run, { label, ...this.#effects(request) });
    } catch (error) {
      if (error instanceof LeaseHeldElsewhereError && this.#options.heldElsewhere === "throw")
        throw error;
      const failure = hostedFailure(error);
      if (!failure) throw error;
      return this.#options.unavailable
        ? this.#options.unavailable(failure, { request, body })
        : hostedUnavailable(failure);
    }
    return new Response(done.body.byteLength > 0 ? (done.body as BodyInit) : null, {
      status: done.status,
      statusText: done.statusText,
      headers: done.headers,
    });
  }

  /** Stop serving: finish the request in flight, seal what the tail holds, give the lease back. */
  async close(
    options: { readonly release?: boolean; readonly seal?: boolean } = {},
  ): Promise<void> {
    await this.runtime.close(options);
    await Promise.resolve(this.#app?.close()).catch(() => {});
  }
}

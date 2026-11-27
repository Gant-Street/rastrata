/** The books a pod has open, written down in the bucket for the pods that start after it.
 *
 * A release replaces every pod, and a pod that has just started has no book open: the first person to ask for each one waited for it to be read from its snapshot and its log (about a
 * second for a book of a couple of thousand journals, measured live on 2026-11-21, 0.9 to 1.05 s), on the pod that the request happened to reach. A pod that starts reads this list before it says
 * it is ready, and opens the books the pods before it had open and were using, so that nobody does (docs/reference/program/performance.md, step 1; docs/reference/program/hosting/many-books.md).
 *
 * It is soft state and wrong for a moment at a time, and nothing depends on it: a book that is not on the list is opened by its first request, as it always was. Each pod writes a list of its
 * own, a small object that is created and never changed (the bucket's interface has no overwrite, and the log's objects are not overwritten either; and the gateway in front of the bucket in production
 * has no delete, so nothing here deletes a list), named for the moment and the pod: `service/hot/<milliseconds, 13 digits>.<pod>.json`. A pod that starts looks at the lists of the last ninety minutes, takes the
 * newest of each pod and puts them together, newest use first. A pod writes when the set of books it has open has changed (a book opened, or one closed), and at least every thirty minutes, so that a
 * list in the last ninety is always there for any pod that is running: a few dozen a day for each pod, a kilobyte each, and a listing starts after the moment it is told to, so the number of old ones
 * does not make a start slower. The names of books are in it and nothing else: no person, no address, no figure. The gateway takes this one shape and no other outside `books/` (apps/tail-worker/src/bulk.ts); a server uses it in apps/api/src/hosted.ts. */
import { BOOK_ID, type ObjectStore } from "./objectstore.ts";

/** Where the lists are, under the bucket's key prefix, beside `books/` and never under it (the verifier lists `books/`). */
export const HOT_FOLDER = "service/hot/";
/** A starting pod looks at the lists written this long ago and since. */
export const HOT_LOOKBACK_MS = 90 * 60_000;
/** A book last used longer ago than this is not on a list: a pod would have closed it by now (`idleMs` of the registry is thirty days, `BOOK_IDLE_MS` in apps/api/src/hosted-books.ts). */
export const HOT_BOOK_MAX_AGE_MS = 30 * 86_400_000;
/** The most books a list names, and the most lists a starting pod reads. */
export const HOT_MAX_BOOKS = 256;
const MAX_LISTS = 8;
const MAX_PAGES = 5;
/** The size of a list that is read: far more than 256 names need. */
const MAX_LIST_BYTES = 64 * 1024;
const STAMP_DIGITS = 13;

export interface HotBook {
  readonly id: string;
  /** The last time a request used the book, in milliseconds since 1970 by the clock of the pod that wrote the list. */
  readonly at: number;
}

export interface HotBooksOptions {
  readonly bulk: ObjectStore;
  /** The bucket's key prefix: empty, or folders each ending in a slash. */
  readonly prefix?: string;
  /** The name of this process: part of the key of each list it writes, so that a pod's own newest list is told from another pod's. */
  readonly holder: string;
  readonly now?: () => number;
  /** Told what could not be done and why, never more than a kind of failure: the list is a convenience and a failure of it is not an error. */
  readonly log?: (line: string) => void;
}

const stamp = (at: number): string =>
  String(Math.max(0, Math.floor(at))).padStart(STAMP_DIGITS, "0");
const safe = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "pod";
const KEY = new RegExp(`^(\\d{${STAMP_DIGITS}})\\.([A-Za-z0-9_-]{1,48})\\.json$`);

export class HotBooks {
  readonly #bulk: ObjectStore;
  readonly #root: string;
  readonly #name: string;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(options: HotBooksOptions) {
    const prefix = options.prefix ?? "";
    if (prefix !== "" && !/^(?:[A-Za-z0-9._-]+\/)+$/.test(prefix))
      throw new RangeError("The key prefix is empty or made of folders ending in a slash");
    this.#bulk = options.bulk;
    this.#root = `${prefix}${HOT_FOLDER}`;
    this.#name = safe(options.holder);
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  /** Write the books this pod has open. `true` when the list is in the bucket; a failure is told in the log and is `false`, never thrown. */
  async publish(books: readonly HotBook[]): Promise<boolean> {
    const at = this.#now();
    const named = [...books]
      .filter((book) => BOOK_ID.test(book.id) && Number.isFinite(book.at))
      .sort((left, right) => right.at - left.at)
      .slice(0, HOT_MAX_BOOKS)
      .map((book) => ({ id: book.id, at: Math.floor(book.at) }));
    const body = new TextEncoder().encode(JSON.stringify({ v: 1, at, books: named }));
    try {
      const written = await this.#bulk.putIfAbsent(
        `${this.#root}${stamp(at)}.${this.#name}.json`,
        body,
        {
          contentType: "application/json",
        },
      );
      return written.created;
    } catch (error) {
      this.#log(`hot books: the list could not be written (${describe(error)})`);
      return false;
    }
  }

  /** The books the pods of the service have had open lately, newest use first: the newest list of each pod of the last ninety minutes, put together. Lists that cannot be read are left
   * out; nothing is thrown, and no list is an empty answer. */
  async recent(): Promise<HotBook[]> {
    const now = this.#now();
    try {
      const keys = await this.#keysAfter(`${this.#root}${stamp(now - HOT_LOOKBACK_MS)}`);
      const newest = new Map<string, string>();
      for (const key of keys) {
        const found = KEY.exec(key.slice(this.#root.length));
        if (found) newest.set(found[2] as string, key);
      }
      const chosen = [...newest.values()].sort().slice(-MAX_LISTS);
      const lists = await Promise.all(
        chosen.map(async (key) => {
          try {
            const stored = await this.#bulk.get(key);
            return stored && stored.body.length <= MAX_LIST_BYTES ? parse(stored.body, now) : [];
          } catch {
            return [];
          }
        }),
      );
      const merged = new Map<string, number>();
      for (const list of lists)
        for (const book of list)
          if (now - book.at <= HOT_BOOK_MAX_AGE_MS)
            merged.set(book.id, Math.max(merged.get(book.id) ?? 0, book.at));
      return [...merged]
        .map(([id, at]) => ({ id, at }))
        .sort((left, right) => right.at - left.at || (left.id < right.id ? -1 : 1))
        .slice(0, HOT_MAX_BOOKS);
    } catch (error) {
      this.#log(`hot books: the lists could not be read (${describe(error)})`);
      return [];
    }
  }

  async #keysAfter(after: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = after;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const page = await this.#bulk.list(this.#root, cursor);
      for (const listed of page.objects) keys.push(listed.key);
      const last = page.objects.at(-1)?.key;
      if (!page.truncated || last === undefined) break;
      cursor = last;
    }
    return keys;
  }
}

/** The books a list names, as far as it is what a list is: an object with `books` of `{id, at}`. Anything else is nothing. A time ahead of this clock by more than an hour is taken as now. */
function parse(body: Uint8Array, now: number): HotBook[] {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    const books = (value as { books?: unknown } | null)?.books;
    if (!Array.isArray(books)) return [];
    const found: HotBook[] = [];
    for (const entry of books.slice(0, HOT_MAX_BOOKS)) {
      const { id, at } = (entry ?? {}) as { id?: unknown; at?: unknown };
      if (typeof id !== "string" || !BOOK_ID.test(id)) continue;
      if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
      found.push({ id, at: Math.min(at, now + 3_600_000) });
    }
    return found;
  } catch {
    return [];
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 80) : "unknown";

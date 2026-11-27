/** The seam between a book's log and the bucket that holds it. Everything the protocol needs from
 * object storage is here: a create-only write (the commit point), reads, a prefix listing in key
 * order, and a delete that only tests and housekeeping use. The same interface is served by the
 * in-memory fake with seeded faults, by any S3-compatible service (R2, OCI Object Storage, MinIO),
 * and by a thin gateway if one is ever put in front. */

export interface ObjectMeta {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  /** User metadata (x-amz-meta-*), lower-cased names. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StoredObject extends ObjectMeta {
  /** Never mutate: a store may hand out the bytes it holds. */
  readonly body: Uint8Array;
}

export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

export interface ListPage {
  readonly objects: readonly ListedObject[];
  /** More keys follow the last one returned: ask again with `after` set to it. */
  readonly truncated: boolean;
}

export type PutResult =
  | { readonly created: true; readonly etag: string }
  /** The key already existed (HTTP 412): nothing was written. */
  | { readonly created: false };

export interface PutOptions {
  readonly metadata?: Readonly<Record<string, string>>;
  readonly contentType?: string;
}

export interface ObjectStore {
  /** Create `key` with `body` only if no object has that key (`If-None-Match: *`). Atomic: of any
   * number of concurrent callers, exactly one gets `created: true`. A response that never arrives
   * throws {@link ObjectStoreUncertain}: the write may or may not have happened. */
  putIfAbsent(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectMeta | null>;
  /** Keys that start with `prefix` and sort after `after`, in key order, at most `limit` (1,000 by
   * default and at most). */
  list(prefix: string, after?: string, limit?: number): Promise<ListPage>;
  /** Idempotent. The protocol never deletes a log entry; tests and housekeeping do. */
  delete(key: string): Promise<void>;
}

/** The store answered with a failure that is certain: nothing was applied, or the request was refused. */
export class ObjectStoreError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ObjectStoreError";
    this.status = status;
    this.code = code;
  }
}

/** The request may have been applied: a timeout, a connection dropped after the bytes were sent,
 * or a 5xx. The caller has to find out (read the object back) and never assume either way. */
export class ObjectStoreUncertain extends ObjectStoreError {
  constructor(message: string, status?: number, code?: string) {
    super(message, status, code);
    this.name = "ObjectStoreUncertain";
  }
}

export const MAX_LIST = 1000;

/** The storage-level identifier of a book. It is not the application's internal book scope: every
 * hosted book file says "local-book" inside, and many books share a bucket. */
export const BOOK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PREFIX = /^(?:[A-Za-z0-9._-]+\/)*$/;
export const SEQ_DIGITS = 12;
export const MAX_SEQ = 10 ** SEQ_DIGITS - 1;

export const padSeq = (seq: number): string => {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_SEQ) throw new RangeError("Bad sequence");
  return String(seq).padStart(SEQ_DIGITS, "0");
};

/** The keys of one book. `prefix` is empty or ends with "/" (a test run keeps its objects under
 * `runs/<lane>/<run>/` so a bucket's lifecycle rule can expire them). */
export class BookKeys {
  readonly prefix: string;
  readonly bookId: string;
  constructor(prefix: string, bookId: string) {
    if (!PREFIX.test(prefix)) throw new RangeError("The key prefix is empty or ends with a slash");
    if (!BOOK_ID.test(bookId)) throw new RangeError("Bad book identifier");
    this.prefix = prefix;
    this.bookId = bookId;
  }
  get root(): string {
    return `${this.prefix}books/${this.bookId}/`;
  }
  get logPrefix(): string {
    return `${this.root}log/`;
  }
  log(seq: number): string {
    return `${this.logPrefix}${padSeq(seq)}`;
  }
  /** The sequence a log key names, or null for a key that is not an entry of this book. */
  seqOfLog(key: string): number | null {
    if (!key.startsWith(this.logPrefix)) return null;
    const tail = key.slice(this.logPrefix.length);
    return new RegExp(`^\\d{${SEQ_DIGITS}}$`).test(tail) ? Number(tail) : null;
  }
  get snapPrefix(): string {
    return `${this.root}snap/`;
  }
  snapshot(seq: number): string {
    return `${this.snapPrefix}${padSeq(seq)}.sqlite.gz`;
  }
  manifest(seq: number): string {
    return `${this.snapPrefix}${padSeq(seq)}.json`;
  }
  seqOfManifest(key: string): number | null {
    if (!key.startsWith(this.snapPrefix)) return null;
    const tail = key.slice(this.snapPrefix.length);
    return new RegExp(`^\\d{${SEQ_DIGITS}}\\.json$`).test(tail)
      ? Number(tail.slice(0, SEQ_DIGITS))
      : null;
  }
  blob(sha256: string): string {
    return `${this.root}blobs/${sha256}`;
  }
  get sealedPrefix(): string {
    return `${this.root}sealed/`;
  }
  /** What the verifier found that must stop a book being served: one small object for each finding, numbered, never changed or removed by the protocol (see review.ts). */
  get reviewPrefix(): string {
    return `${this.root}review/`;
  }
  review(number: number): string {
    return `${this.reviewPrefix}${padSeq(number)}.json`;
  }
  /** The number a review key carries, or null for a key that is not one of this book's. */
  numberOfReview(key: string): number | null {
    if (!key.startsWith(this.reviewPrefix)) return null;
    const match = new RegExp(`^(\\d{${SEQ_DIGITS}})\\.json$`).exec(
      key.slice(this.reviewPrefix.length),
    );
    return match ? Number(match[1]) : null;
  }
  /** A sealed segment: entries `from` to `to` inclusive, one immutable object. */
  sealed(from: number, to: number): string {
    return `${this.sealedPrefix}${padSeq(from)}-${padSeq(to)}`;
  }
  /** The range a sealed key names, or null for a key that is not a segment of this book. */
  rangeOfSealed(key: string): { readonly from: number; readonly to: number } | null {
    if (!key.startsWith(this.sealedPrefix)) return null;
    const match = new RegExp(`^(\\d{${SEQ_DIGITS}})-(\\d{${SEQ_DIGITS}})$`).exec(
      key.slice(this.sealedPrefix.length),
    );
    if (!match) return null;
    const from = Number(match[1]);
    const to = Number(match[2]);
    return from >= 1 && to >= from ? { from, to } : null;
  }
}

/** The kind of object a key names, for byte counters. */
export function kindOfKey(key: string): "log" | "snapshot" | "blob" | "sealed" | "other" {
  if (key.includes("/log/")) return "log";
  if (key.includes("/snap/")) return "snapshot";
  if (key.includes("/blobs/")) return "blob";
  if (key.includes("/sealed/")) return "sealed";
  return "other";
}

/** R2 bills `put` and `list` as Class A, `get` and `head` as Class B and `delete` as free. */
export type OperationClass = "A" | "B" | "free";
export function classOf(operation: "put" | "get" | "head" | "list" | "delete"): OperationClass {
  return operation === "put" || operation === "list" ? "A" : operation === "delete" ? "free" : "B";
}

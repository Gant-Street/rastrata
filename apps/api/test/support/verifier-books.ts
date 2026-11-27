/** Books for the verifier's tests (verify-books.test.ts, verifier-main.test.ts): a closed book file, set up and given journals, put into a log as a hosted book's beginning, optionally changed first so that
 * the log is a valid chain of a book that is not valid. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { APPLICATION_DERIVED, APPLICATION_SCHEMA } from "@rastrata/application/hosted";
import { LocalBookService } from "@rastrata/application/local";
import { BULK_BOOK, postBulk } from "@rastrata/application/testing/bulk-book";
import { importBookFile, type LogTier, type ObjectStore } from "@rastrata/booklog";

/** A tier that answers as the real one does except where `over` says. */
export const tierWith = (
  inner: LogTier,
  over: Partial<Pick<LogTier, "head" | "readFrom">> = {},
): LogTier => ({
  capabilities: inner.capabilities,
  head: over.head ?? ((book) => inner.head(book)),
  readFrom: over.readFrom ?? ((book, seq, limit) => inner.readFrom(book, seq, limit)),
  append: (book, input) => inner.append(book, input),
  acquire: (book, holder, ttl) => inner.acquire(book, holder, ttl),
  renew: (book, lease, ttl) => inner.renew(book, lease, ttl),
  release: (book, lease) => inner.release(book, lease),
  seal: (book, input) => inner.seal(book, input),
});

/** A bucket that answers as the real one does except for what `get` returns. */
export const bucketWith = (
  inner: ObjectStore,
  get: (key: string) => Promise<Awaited<ReturnType<ObjectStore["get"]>>>,
): ObjectStore => ({
  putIfAbsent: (key, body, options) => inner.putIfAbsent(key, body, options),
  get,
  head: (key) => inner.head(key),
  list: (prefix, after, limit) => inner.list(prefix, after, limit),
  delete: (key) => inner.delete(key),
});

/** One character of the stored outcome with this sequence changed: the ledger's own checksum no longer holds, under a log whose chain is untouched. */
export const breakOutcome = (sequence: number) => (db: Database) =>
  db.exec(
    `UPDATE ledger_native_outcomes SET body = substr(body, 1, 60) || 'x' || substr(body, 62) WHERE sequence = ${sequence}`,
  );

export async function importedBook(options: {
  /** A folder to build the file in. */
  readonly folder: string;
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly book: string;
  readonly prefix?: string;
  readonly journals?: number;
  readonly change?: (db: Database) => void;
}): Promise<void> {
  const path = join(options.folder, `${options.book}.sqlite`);
  const service = await LocalBookService.open(path, { safety: false });
  await service.setup(BULK_BOOK);
  await postBulk(service, options.journals ?? 20);
  service.close();
  if (options.change) {
    const db = new Database(path);
    options.change(db);
    db.close();
  }
  await importBookFile({
    tier: options.tier,
    bulk: options.bulk,
    bookId: options.book,
    ...(options.prefix ? { prefix: options.prefix } : {}),
    path,
    schema: APPLICATION_SCHEMA,
    exclude: APPLICATION_DERIVED,
  });
}

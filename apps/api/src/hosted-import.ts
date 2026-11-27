#!/usr/bin/env bun
/** Put a closed book file into the log as the beginning of a hosted book (see hosted.ts for the
 * settings): the file becomes the book's first snapshot in the bulk store and entry 1 of its log, and a
 * process started with `RASTRATA_BOOK_STORE=r2log://<book id>` then serves it. The file is copied,
 * never changed, and a book that is already in the log is refused.
 *
 *   RASTRATA_BOOK_STORE='r2log://tenant-1?bulk=file:///data/bucket&tail=objects' \
 *     bun apps/api/src/hosted-import.ts --file /data/seed/tenant-1.sqlite
 *
 * Prints one line of JSON: the entry made, the size of the snapshot and how long it took. */
import type { Database } from "bun:sqlite";
import { APPLICATION_DERIVED, APPLICATION_SCHEMA } from "@rastrata/application/hosted";
import { importBookFile, type ImportResult, MeteredObjectStore } from "@rastrata/booklog";
import { type BookStoreConfig, openBulkStore, openTail, parseBookStore } from "./hosted.ts";

/** The number of outcomes in the book: close to the number of journals, which is what the manifest
 * wants as a size hint (it sizes the memory a cold start asks for). */
function outcomes(db: Database): number | null {
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM ledger_native_outcomes").get() as {
      n: number;
    } | null;
    return row ? row.n : null;
  } catch {
    return null;
  }
}

export async function importIntoLog(
  config: BookStoreConfig,
  file: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ImportResult> {
  const bulk = new MeteredObjectStore(openBulkStore(config, env), { keepSamples: false });
  const tail = await openTail(config, bulk, env);
  try {
    return await importBookFile({
      tier: tail.tier,
      bulk,
      bookId: config.bookId,
      ...(config.prefix ? { prefix: config.prefix } : {}),
      path: file,
      schema: APPLICATION_SCHEMA,
      exclude: APPLICATION_DERIVED,
      journals: outcomes,
    });
  } finally {
    await tail.close().catch(() => {});
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--file");
  const file = at >= 0 ? args[at + 1] : undefined;
  const store = process.env.RASTRATA_BOOK_STORE;
  if (!file || !store) {
    console.error(
      "usage: RASTRATA_BOOK_STORE=r2log://<book id>?bulk=...&tail=... bun apps/api/src/hosted-import.ts --file <book.sqlite>",
    );
    process.exit(2);
  }
  try {
    const config = parseBookStore(store);
    const result = await importIntoLog(config, file);
    console.log(
      JSON.stringify({
        book: config.bookId,
        seq: result.seq,
        hash: result.hash,
        snapshotBytes: result.bytes,
        fileBytes: result.rawBytes,
        milliseconds: Math.round(result.milliseconds),
      }),
    );
  } catch (error) {
    console.error(`Not imported: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

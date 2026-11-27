#!/usr/bin/env bun
/** Restore a book's tail from its bulk store, after the tail lost the book (a wiped database, a reset
 * object): the server refuses such a book with `tail_behind` until this has been run (see hosted.ts for
 * the settings, and packages/booklog/src/adopt.ts for what it checks). What only the tail held, at most
 * the last seal window of acknowledged writes, is gone; this prints where the log now ends.
 *
 *   RASTRATA_BOOK_STORE='r2log://tenant-1?bulk=file:///data/bucket&tail=postgres' \
 *   RASTRATA_BOOK_TAIL='postgres://...' \
 *     bun apps/api/src/hosted-adopt.ts --pods-stopped [--delete-orphan-snapshots]
 *
 * `--pods-stopped` says that every server process of the book is stopped: one that survived the loss
 * would write under a fence the restored tail may grant again. `--delete-orphan-snapshots` deletes
 * snapshots of entries after the newest sealed one, which describe history the log no longer has. */
import { BookKeys, MeteredObjectStore, adoptFromBulk, type AdoptOutcome } from "@rastrata/booklog";
import { openBulkStore, openTail, parseBookStore, type BookStoreConfig } from "./hosted.ts";

export async function adoptIntoTail(
  config: BookStoreConfig,
  options: { readonly deleteOrphanSnapshots?: boolean } = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AdoptOutcome> {
  const bulk = new MeteredObjectStore(openBulkStore(config, env), { keepSamples: false });
  const tail = await openTail(config, bulk, env);
  try {
    return await adoptFromBulk({
      tier: tail.tier,
      bulk,
      keys: new BookKeys(config.prefix, config.bookId),
      ...(options.deleteOrphanSnapshots ? { deleteOrphanSnapshots: true } : {}),
    });
  } finally {
    await tail.close().catch(() => {});
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const store = process.env.RASTRATA_BOOK_STORE;
  if (!store || !args.includes("--pods-stopped")) {
    console.error(
      "usage: RASTRATA_BOOK_STORE=r2log://<book id>?bulk=...&tail=... bun apps/api/src/hosted-adopt.ts --pods-stopped [--delete-orphan-snapshots]\n(--pods-stopped: every server process of the book is stopped)",
    );
    process.exit(2);
  }
  try {
    const config = parseBookStore(store);
    const outcome = await adoptIntoTail(config, {
      deleteOrphanSnapshots: args.includes("--delete-orphan-snapshots"),
    });
    console.log(JSON.stringify({ book: config.bookId, ...outcome }));
  } catch (error) {
    console.error(`Not restored: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

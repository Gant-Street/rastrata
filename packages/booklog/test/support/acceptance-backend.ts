/** The application's acceptance story on a book in the log. The story (packages/application/test/
 * acceptance) opens its world through whatever module ACCEPTANCE_BACKEND names; this is that module:
 *
 *   ACCEPTANCE_BACKEND=$PWD/packages/booklog/test/support/acceptance-backend.ts \
 *     bun test packages/application/test/acceptance
 *
 * Every request goes through a HostedBook (a held transaction, an entry in a tail, the answer
 * released after), and a restart alternates between a warm one (the cache file is reused and caught
 * up) and a cold one (the cache is thrown away and the book is read from the log). When the world
 * closes, a process that has nothing but the log reads the book and must hold exactly what the
 * live cache holds.
 *
 * Environment:
 *   ACCEPTANCE_ACCOUNT_FILE  append one JSON line per world: the requests by operation, every entry
 *                            the world appended (cause, tables, bytes), restarts, and where the time
 *                            went; a world that fails to close writes {world, error} instead
 *   ACCEPTANCE_CAPTURE=off   leave the change capture dormant (its triggers stay installed but record
 *                            nothing), to time the story without the capture; the log is then empty and
 *                            the closing verification is skipped
 *   ACCEPTANCE_TRACE_READS   print each read that had to be logged, with the tables it wrote
 *   ACCEPTANCE_READS         log-first | defer (default defer): what a read that wrote something does
 *   ACCEPTANCE_DEFER_MS      how long a deferred read effect may wait (default 2000)
 *   ACCEPTANCE_PREPARE=off   leave the slices' tables to be made on first use, as a book in a file does
 *   ACCEPTANCE_SEAL_MS       seal the tail into the bulk store this long after a commit (default: not at all) */
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LocalBookService } from "@rastrata/application/local";
import type { HostedBook } from "../../src/hosted.ts";
import { materialize } from "../../src/materialize.ts";
import { MemoryObjectStore } from "../../src/memory.ts";
import { BookKeys } from "../../src/objectstore.ts";
import type { EntryInfo } from "../../src/runtime.ts";
import { MemoryLogTier } from "../../src/tier-memory.ts";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  changesBook,
  openHostedApplication,
  type ServedApplication,
} from "./app.ts";

interface Context {
  readonly directory: string;
  readonly path: string;
  readonly now: () => Date;
  readonly wire: (service: LocalBookService) => void;
}

let worlds = 0;

const backend = {
  async start(context: Context) {
    const world = worlds++;
    const tier = new MemoryLogTier();
    const bulk = new MemoryObjectStore();
    const cache = join(context.directory, "log-cache", "book.sqlite");
    mkdirSync(dirname(cache), { recursive: true });
    const dormant = process.env.ACCEPTANCE_CAPTURE === "off";
    const reads = process.env.ACCEPTANCE_READS === "log-first" ? "log-first" : "defer";
    const deferMs = Number(process.env.ACCEPTANCE_DEFER_MS ?? 2000);
    const prepare = process.env.ACCEPTANCE_PREPARE !== "off";
    const sealMs = Number(process.env.ACCEPTANCE_SEAL_MS ?? 0);
    const accountFile = process.env.ACCEPTANCE_ACCOUNT_FILE;
    let incarnation = 0;
    const account = {
      world,
      requests: {} as Record<string, { reads: number; writes: number; ms: number }>,
      entries: [] as EntryInfo[],
      restarts: [] as { kind: "warm" | "cold"; closeMs: number; openMs: number }[],
      openMs: 0,
      verifyMs: 0,
      runtime: { work: 0, peek: 0, encode: 0, append: 0, commit: 0, emptyWrites: 0 },
      resets: 0,
      readFlushes: 0,
      readsDeferred: 0,
      deferredFlushes: 0,
      commits: 0,
      tables: {} as Record<string, number>,
      bulk: null as null | {
        classA: number;
        classB: number;
        ops: Record<string, number>;
        objects: Record<string, number>;
      },
    };
    const open = async (): Promise<HostedBook> => {
      incarnation += 1;
      const started = performance.now();
      const opened = await openHostedApplication({
        tier,
        bulk,
        bookId: "acceptance",
        prefix: "acceptance/",
        holder: `world#${incarnation}`,
        path: cache,
        sealing: { delayMs: sealMs },
        readEffects: { mode: reads, deferMs },
        local: { now: context.now, safety: {}, prepareSlices: prepare },
        wire: context.wire,
        onEntry: (info) => {
          account.entries.push(info);
          if (process.env.ACCEPTANCE_TRACE_READS && info.cause === "read")
            console.info(
              `read logged: ${info.label}: ${info.bytes} bytes; ${Object.entries(info.tables)
                .map(([name, n]) => `${name} +${n.insert} ~${n.update} -${n.delete} =${n.replace}`)
                .join(", ")}${info.ddl ? `; ${info.ddl} schema statements` : ""}`,
            );
        },
      });
      if (dormant) opened.runtime.db.exec("UPDATE _cdc_gate SET on_=0");
      account.openMs += performance.now() - started;
      return opened;
    };
    const tally = (book: HostedBook) => {
      const stats = book.runtime.stats;
      for (const key of ["work", "peek", "encode", "append", "commit"] as const)
        account.runtime[key] += stats.ms[key];
      account.runtime.emptyWrites += stats.emptyWrites;
      account.commits += stats.commits;
      account.resets += book.resets;
      account.readFlushes += stats.readFlushes;
      account.readsDeferred += stats.readsDeferred;
      account.deferredFlushes += stats.deferredFlushes;
    };
    let book = await open();

    /** Stop the book and check that a process with nothing but the log reads exactly what this one held. */
    const closeAndVerify = async (): Promise<void> => {
      // What reads left unsent is logged first, so the log and the cache are the same book.
      await book.runtime.flushDeferred();
      const digest = book.runtime.capture.stateDigest();
      const head = { ...book.runtime.head };
      for (const [name, table] of Object.entries(digest.tables)) account.tables[name] = table.rows;
      await book.close();
      tally(book);
      // The bulk store's work for the book itself, before the check below reads it.
      if (sealMs > 0) {
        const objects: Record<string, number> = {};
        for (const key of bulk.keys("acceptance/")) {
          const kind = /\/(sealed|snap|log)\//.exec(key)?.[1] ?? "other";
          objects[kind] = (objects[kind] ?? 0) + 1;
        }
        const stats = bulk.stats;
        account.bulk = { classA: stats.classA, classB: stats.classB, ops: stats.ops, objects };
      }
      if (!dormant) {
        const verifying = performance.now();
        const cold = await materialize({
          tier,
          bulk,
          keys: new BookKeys("acceptance/", "acceptance"),
          schema: APPLICATION_SCHEMA,
          path: join(context.directory, "log-cache", "verify.sqlite"),
          exclude: APPLICATION_DERIVED,
          reuse: false,
        });
        account.verifyMs = performance.now() - verifying;
        try {
          if (cold.head.seq !== head.seq || cold.head.hash !== head.hash)
            throw new Error(
              `The log is at entry ${cold.head.seq}, the live cache was at ${head.seq}`,
            );
          if (cold.capture.stateHash() !== digest.overall)
            throw new Error(
              "A process that reads the log holds a different book than the live cache",
            );
        } finally {
          cold.db.close();
        }
      }
      if (accountFile) appendFileSync(accountFile, `${JSON.stringify(account)}\n`);
      if (process.env.ACCEPTANCE_TIMING)
        console.info(
          `book log: ${account.entries.length} entries for ${account.commits} commits, ${account.resets} application rebuilds, ${account.readsDeferred} read effects deferred, ${account.restarts.length} restarts${dormant ? " (capture dormant)" : "; a process holding only the log reads exactly the live book"}`,
        );
    };

    return {
      async fetch(request: Request) {
        const label = new URL(request.url).pathname.replace(/^\/v1\//, "");
        const write = changesBook(request);
        const started = performance.now();
        const response = await book.fetch(request);
        let row = account.requests[label];
        if (!row) {
          row = { reads: 0, writes: 0, ms: 0 };
          account.requests[label] = row;
        }
        row[write ? "writes" : "reads"] += 1;
        row.ms += performance.now() - started;
        return response;
      },
      service: () => (book.application as ServedApplication).service,
      async restart() {
        // Every other restart starts from nothing but the log.
        // (With the capture dormant the log holds nothing, so the cache is all there is: always warm.)
        const cold = !dormant && incarnation % 2 === 1;
        const closing = performance.now();
        await book.close();
        tally(book);
        const closeMs = performance.now() - closing;
        if (cold)
          for (const suffix of ["", "-wal", "-shm"]) rmSync(`${cache}${suffix}`, { force: true });
        const opening = performance.now();
        book = await open();
        account.restarts.push({
          kind: cold ? "cold" : "warm",
          closeMs,
          openMs: performance.now() - opening,
        });
      },
      /** The world swallows whatever this throws (a test may have closed it already), so a failure is
       * also said aloud and written to the accounting, where the wrapper test looks for it. */
      async close() {
        try {
          await closeAndVerify();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`BOOK LOG CLOSE FAILED (world ${world}): ${message}`);
          if (accountFile)
            appendFileSync(accountFile, `${JSON.stringify({ world, error: message })}\n`);
          throw error;
        }
      },
    };
  },
};

export default backend;

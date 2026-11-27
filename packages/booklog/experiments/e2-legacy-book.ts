/** Make the closed book file a "legacy" book of E2 starts from: a book written by a release, with what
 * a month of bookkeeping leaves in it (postings, rules, drafts, statement imports and the Inbox, tokens),
 * made by the real application through its HTTP boundary on a file, as the local product keeps one.
 *
 *   bun experiments/e2-legacy-book.ts --out test/fixtures/schema1-book.sqlite.gz [--steps 400] [--seed 11]
 *
 * It must be run on the code of the release the book is to be from, and the file is named for that
 * release's schema (`APPLICATION_SCHEMA` at the time: 1 for `schema1-book.sqlite.gz`). When a later release
 * changes the schema, E2 starts some of its books from this file: the new release opens it, migrates it
 * (the migration reaches the log as ordinary entries stamped with the new schema), and goes on writing,
 * and a process of the old release will not open what the new one wrote. */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApplicationHttp } from "@rastrata/application/http";
import { LocalBookService } from "@rastrata/application/local";
import { BUSINESS_PERMISSIONS } from "@rastrata/application/schema";
import { Rng } from "../src/rng.ts";
import { APPLICATION_SCHEMA } from "../test/support/app.ts";
import { Workload } from "./e2-workload.ts";
import { parseArgs } from "./lib.ts";

const args = parseArgs();
const out = resolve(args.string("out", "schema-book.sqlite.gz"));
const steps = args.number("steps", 400);
const seed = args.number("seed", 11);

const directory = mkdtempSync(join(tmpdir(), "e2-legacy-"));
try {
  const file = join(directory, "book.sqlite");
  const service = await LocalBookService.open(file, {
    safety: false,
    snapshots: false,
    prepareSlices: true,
  });
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const workload = new Workload({ fetch: (request) => http.fetch(request) }, new Rng(seed), {
    retryDelayMs: 0,
    maxRetries: 1,
  });
  for (let step = 0; step < steps; step += 1) await workload.step();
  service.close();
  // A closed file: nothing left in the write-ahead log.
  const db = new Database(file);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const bytes = readFileSync(file);
  writeFileSync(out, Bun.gzipSync(bytes));
  console.log(
    JSON.stringify({
      out,
      schema: APPLICATION_SCHEMA,
      steps,
      seed,
      requests: workload.counters.requests,
      writes: workload.counters.writes,
      acknowledged: workload.counters.acknowledged,
      fileBytes: bytes.byteLength,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

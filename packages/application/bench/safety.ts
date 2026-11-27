/** Measure the safety lane on books of growing size: the snapshot, a verification (whose replay grows
 * with the book, and with its square for a book made before the chain-head state commitment), a drill, a
 * restore, an export and its import by replay.
 *
 *   SIZES=100,250,500,1000 bun packages/application/bench/safety.ts
 *
 * Journals are posted straight to the ledger (see test/support/bulk-book.ts), so building a book is
 * cheap; the numbers are for the safety operations themselves. They depend on the machine and on
 * what else it is doing. */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { importOpenExport, LocalBookService, restoreBackup } from "../src/local.ts";
import { configureSafety } from "../src/safety/jobs.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const sizes = (process.env.SIZES ?? "100,250,500,1000").split(",").map(Number);

const seconds = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

async function measure(count: number) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-safety-bench-"));
  try {
    const service = await LocalBookService.open(join(directory, "book.sqlite"));
    configureSafety(service, { waitMs: 3_600_000 });
    const http = new ApplicationHttp(service, {
      bookId: service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    const call = async (name: string, input: unknown = {}) => {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: "local-book",
            input,
            operationId: crypto.randomUUID(),
          }),
        }),
      );
      const body = await response.json();
      if (!body.ok) throw new Error(JSON.stringify(body.error));
      return body.data;
    };
    await call("book.setup", BULK_BOOK);
    await postBulk(service, count);
    await service.readAggregate();
    const rows: Record<string, string | number> = { journals: count };
    // The event loop must keep turning while a job runs: sample its worst gap.
    let worstGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 10);

    let started = performance.now();
    const created = await call("backup.create");
    rows["backup s"] = seconds(performance.now() - started);
    rows["backup MB"] = megabytes(created.backup.bytes);

    started = performance.now();
    const verified = await call("backup.verify");
    rows["verify s"] = seconds(performance.now() - started);
    rows["replay s"] = seconds(verified.verification.replayMs);

    started = performance.now();
    await call("backup.drill");
    rows["drill s"] = seconds(performance.now() - started);

    started = performance.now();
    await restoreBackup({
      backup: created.backup.id,
      to: join(directory, "restored.sqlite"),
      backupDirectory: join(directory, "backups", "book"),
      quick: true,
    });
    rows["restore quick s"] = seconds(performance.now() - started);

    started = performance.now();
    const exported = await call("export.create");
    rows["export s"] = seconds(performance.now() - started);
    rows["export MB"] = megabytes(exported.export.bytes);

    started = performance.now();
    await importOpenExport({
      directory: exported.export.location,
      to: join(directory, "rebuilt.sqlite"),
    });
    rows["import s"] = seconds(performance.now() - started);
    clearInterval(timer);
    rows["worst loop gap ms"] = Math.round(worstGap);
    rows["db MB"] = megabytes(statSync(join(directory, "book.sqlite")).size);
    service.close();
    return rows;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const results: Record<string, string | number>[] = [];
for (const size of sizes) {
  console.error(`measuring ${size} journals...`);
  results.push(await measure(size));
}
console.table(results);

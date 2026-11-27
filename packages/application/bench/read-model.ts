// Benchmark: how the read model behaves on a large book (N journals, default 1000). Run it with
//   N=1000 bun bench/read-model.ts
// A full replay is O(n) for a book made with the chain-head state commitment (every book the application
// makes now) and was O(n^2) before it; a saved snapshot makes a restart O(n) and a posting O(n) per read.
// bench/scale.ts measures the same things at larger sizes and for both kinds of book.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const n = Number(process.env.N ?? "1000");
const dir = mkdtempSync(join(tmpdir(), "rastrata-bench-"));
const path = join(dir, "book.sqlite");
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
let service = await LocalBookService.open(path);
await service.setup(BULK_BOOK);
let t = performance.now();
await postBulk(service, n);
console.log(`built ${n} journals directly through the ledger: ${ms(t)}`);
t = performance.now();
await service.readAggregate();
console.log(`first read, full replay from genesis: ${ms(t)}`);
service.close();
t = performance.now();
service = await LocalBookService.open(path);
await service.readAggregate();
console.log(`cold start from the snapshot: ${ms(t)} (stats ${JSON.stringify(service.readStats)})`);
t = performance.now();
await postBulk(service, 1);
const posted = ms(t);
t = performance.now();
await service.readAggregate();
console.log(`one more posting ${posted}, then the incremental read: ${ms(t)}`);
service.close();
rmSync(dir, { recursive: true, force: true });

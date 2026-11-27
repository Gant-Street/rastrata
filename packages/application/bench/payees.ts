// Benchmark: the report by payee on a book of N posted bank lines (default 20,000), and what it costs to
// read the text behind each journal through the Inbox's own operation (`inbox.list`, paged), which is
// how the report gets it. Run it with
//   N=20000 bun bench/payees.ts
// It prints, for the Inbox read, the number of pages and the time; for the report, the time of the pure
// compile and of the whole operation, cold and warm; and, for comparison, the time to read the same
// text straight out of the Inbox's table (what a cheap read in the Inbox could cost at best).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { ApplicationHttp } from "../src/http.ts";
import type { BankLine } from "../src/ingest-types.ts";
import { LocalBookService } from "../src/local.ts";
import { compilePayeeTotals } from "../src/payees/totals.ts";
import { APPLICATION_API_VERSION } from "../src/schema.ts";
import { ingestPort } from "../src/slices/ingest/port.ts";
import { appendPayee, payeesRuntime, readPayeeState } from "../src/slices/payees/store.ts";
import { readJournalTexts } from "../src/slices/payees/sources.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const n = Number(process.env.N ?? "20000");
const payeeCount = Number(process.env.PAYEES ?? "300");
const dir = mkdtempSync(join(tmpdir(), "rastrata-payees-"));
const service = await LocalBookService.open(join(dir, "book.sqlite"));
const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
const call = async (name: string, input: unknown) => {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input,
      }),
    }),
  );
  const body = (await response.json()) as { ok: boolean; data?: unknown; error?: unknown };
  if (!body.ok) throw new Error(`${name} failed: ${JSON.stringify(body.error)}`);
  return body.data as Record<string, unknown>;
};
const ms = (start: number) => `${(performance.now() - start).toFixed(0)} ms`;
const cpu = () => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

await service.setup(BULK_BOOK as never);
const dateOf = (k: number) =>
  `2026-${String(1 + (k % 12)).padStart(2, "0")}-${String(1 + (k % 27)).padStart(2, "0")}`;
const income = (k: number) => k % 20 === 0;

let t = performance.now();
const posted = await postBulk(service, n, {
  entry: (k) => ({
    date: dateOf(k),
    debit: income(k) ? "1000" : "5000",
    credit: income(k) ? "4000" : "1000",
    cents: BigInt(500 + ((k * 37) % 90_000)),
  }),
});
console.log(`${n} journals posted straight to the ledger: ${ms(t)}`);

// The same number of Inbox lines, dated as the journals are, then marked posted with their journal.
t = performance.now();
const port = ingestPort(service);
const lines: BankLine[] = Array.from({ length: n }, (_, index) => ({
  kind: "bankLine",
  provider: "csv",
  accountKey: "csv:1000",
  rawIndex: index,
  postedOn: dateOf(index + 1),
  amount: `${income(index + 1) ? "" : "-"}${((500 + (((index + 1) * 37) % 90_000)) / 100).toFixed(2)}`,
  currency: "USD",
  description: `POS DEBIT MERCHANT ${index % 400} STORE ${index} AUSTIN TX`,
  ...(index % 3 === 0 ? { counterparty: `MERCHANT ${index % 400} INC` } : {}),
}));
const raw = port.archive(new TextEncoder().encode(JSON.stringify(lines)), "text/csv", "lines.csv");
port.submit({
  provider: "csv",
  sourceKey: "csv:1000",
  raw,
  lines,
  balances: [],
  fetchedAt: new Date().toISOString(),
  ledgerAccountId: "1000",
});
console.log(`${n} Inbox lines submitted: ${ms(t)}`);
t = performance.now();
const items = service.store.query("SELECT id FROM app_ingest_items ORDER BY raw_index").all() as {
  id: string;
}[];
service.store.transaction(() => {
  const update = service.store.query(
    "UPDATE app_ingest_items SET status='posted', journal_id=? WHERE id=?",
  );
  for (const [index, item] of items.entries()) update.run(posted[index], item.id);
});
console.log(`${items.length} lines marked posted with their journals: ${ms(t)}`);

// Payees: merchant N's words are "merchant N".
const runtime = payeesRuntime(service);
service.store.transaction(() => {
  for (let index = 0; index < payeeCount; index++)
    appendPayee(runtime, {
      payee: `pay_${index}`,
      body: {
        name: `Merchant ${index}`,
        words: [`merchant ${index}`],
        defaultAccountId: null,
        note: "",
        retired: false,
      },
      principal: "owner",
      operationId: `bench-${index}`,
      via: "payees.save",
    });
});

const context = {
  service,
  access: { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
  operationId: "",
};
const from = "2026-01-01";
const to = "2026-12-31";

// 1. The text. First the way the 1099 lane reads it, paging inbox.list; then the read made for it.
for (const round of ["cold", "warm"]) {
  t = performance.now();
  const c0 = cpu();
  let pages = 0;
  let journals = 0;
  for (let page = 1; ; page++) {
    const result = (await call("inbox.list", {
      filter: { status: ["posted"], covered: false, from: "2025-12-01", to: "2027-01-31" },
      sort: "date_asc",
      page,
      pageSize: 200,
    })) as { items: { journalId?: string }[]; count: number; pageSize: number };
    pages += 1;
    journals += result.items.filter((item) => item.journalId).length;
    if (result.items.length === 0 || page * result.pageSize >= result.count) break;
  }
  console.log(
    `inbox.list paged for the text (${round}): ${pages} pages, ${journals} journals, ${ms(t)} wall, ${(cpu() - c0).toFixed(0)} ms cpu`,
  );
}
for (const round of ["cold", "warm"]) {
  t = performance.now();
  const c0 = cpu();
  const read = await readJournalTexts(context, from, to);
  console.log(
    `inbox.texts for the text (${round}): ${read.pages} pages, ${read.texts.size} journals, ${ms(t)} wall, ${(cpu() - c0).toFixed(0)} ms cpu`,
  );
}

// 2. The same text straight from the table: the least a cheap read could cost.
t = performance.now();
const rows = service.store
  .query(
    "SELECT journal_id, json_extract(line, '$.counterparty') AS counterparty, json_extract(line, '$.description') AS description FROM app_ingest_items WHERE status='posted' AND covered_by IS NULL AND posted_on BETWEEN ? AND ?",
  )
  .all(from, to) as { journal_id: string }[];
console.log(`the same text straight out of the table: ${rows.length} rows, ${ms(t)}`);

// 3. The report.
const { aggregate } = await service.readAggregate();
const state = aggregate.state;
const texts = (await readJournalTexts(context, from, to)).texts;
const payees = readPayeeState(runtime.store).payees.map((payee) => ({
  id: payee.id,
  name: payee.name,
  words: payee.words,
  retired: payee.retired,
}));
for (const round of ["cold", "warm"]) {
  t = performance.now();
  const report = compilePayeeTotals({ state, from, to, payees, texts });
  console.log(
    `compilePayeeTotals (${round}): ${ms(t)}; ${report.journals.length} journals, ${report.rows.length} payees, ${report.unnamed.length} unnamed groups`,
  );
}
for (const round of ["cold", "warm"]) {
  t = performance.now();
  const answer = await call("payees.totals", { asOf: to, from });
  console.log(
    `payees.totals end to end (${round}): ${ms(t)}; tie ${JSON.stringify((answer as { tieOut: unknown }).tieOut)}`,
  );
}
t = performance.now();
await call("payees.test", { words: ["merchant 17 store"], asOf: to, from });
console.log(`payees.test: ${ms(t)}`);
t = performance.now();
const file = (await call("payees.export", { asOf: to, from, file: "transactions" })) as {
  content: string;
};
console.log(`payees.export transactions: ${ms(t)}, ${(file.content.length / 1e6).toFixed(1)} MB`);
console.log(`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);

service.close();
rmSync(dir, { recursive: true, force: true });

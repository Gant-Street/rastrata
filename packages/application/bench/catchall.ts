// Benchmark: the catch-all lane on a book of N posted bank lines (default 20,000), all in one expense
// account that the book marks as its catch-all. It measures what a person waits for:
//   1. the month checklist, without and with the catch-all note (the note's cost is the report by payee
//      limited to that account, for the month);
//   2. a plan (`dryRun`) for 100 and for 500 transactions (the most one request names), named by their entries;
//   3. a move of 100 transactions: the time of the whole call and per transaction (two ledger commands
//      and the Inbox's own steps each), and what the book holds afterwards.
// Run it with
//   N=20000 bun bench/catchall.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import type { BankLine } from "../src/ingest-types.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { ingestPort } from "../src/slices/ingest/port.ts";
import { ingestRuntime } from "../src/slices/ingest/store.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const n = Number(process.env.N ?? "20000");
const moved = Number(process.env.MOVE ?? "100");
const dir = mkdtempSync(join(tmpdir(), "rastrata-catchall-"));
const service = await LocalBookService.open(join(dir, "book.sqlite"));
ingestRuntime(service).postBudgetMs = 600_000;
const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
// What the bench reads from the replies of the two operations it calls.
type Json = {
  notes: { transactions?: number; largest?: unknown[] }[];
  would: number;
  applied: number;
  skipped: number;
  failed: number;
  remaining: number;
};
const call = async (name: string, input: unknown, operationId?: string): Promise<Json> => {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  const body = (await response.json()) as { ok: boolean; error?: unknown; data: Json };
  if (!body.ok) throw new Error(`${name} failed: ${JSON.stringify(body.error)}`);
  return body.data;
};
const ms = (start: number) => `${(performance.now() - start).toFixed(0)} ms`;

await service.setup({
  ...BULK_BOOK,
  accounts: [...BULK_BOOK.accounts, { code: "6000", name: "Software", role: "expense" }],
} as never);
const dateOf = (k: number) =>
  `2026-${String(1 + (k % 12)).padStart(2, "0")}-${String(1 + (k % 27)).padStart(2, "0")}`;

let t = performance.now();
const posted = await postBulk(service, n, {
  entry: (k) => ({
    date: dateOf(k),
    debit: "5000",
    credit: "1000",
    cents: BigInt(500 + ((k * 37) % 90_000)),
  }),
});
console.log(`${n} journals posted straight to the ledger: ${ms(t)}`);

t = performance.now();
const port = ingestPort(service);
const lines: BankLine[] = Array.from({ length: n }, (_, index) => ({
  kind: "bankLine",
  provider: "csv",
  accountKey: "csv:1000",
  rawIndex: index,
  postedOn: dateOf(index + 1),
  amount: `-${((500 + (((index + 1) * 37) % 90_000)) / 100).toFixed(2)}`,
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
const items = service.store.query("SELECT id FROM app_ingest_items ORDER BY raw_index").all() as {
  id: string;
}[];
service.store.transaction(() => {
  const update = service.store.query(
    "UPDATE app_ingest_items SET status='posted', journal_id=? WHERE id=?",
  );
  for (const [index, item] of items.entries()) update.run(posted[index], item.id);
});
console.log(`${items.length} Inbox lines made and marked posted with their journals: ${ms(t)}`);

const checklist = () => call("cutover.checklist", { periodId: "period-03" });
for (const round of ["cold", "warm", "warm"]) {
  t = performance.now();
  const answer = await checklist();
  console.log(`checklist, nothing marked (${round}): ${ms(t)}; ${answer.notes.length} notes`);
}
await call(
  "accounts.setTags",
  { accountId: "5000", effectiveOn: "2026-01-01", tags: { roleKey: "catchall.expense" } },
  crypto.randomUUID(),
);
for (const round of ["cold", "warm", "warm"]) {
  t = performance.now();
  const answer = await checklist();
  const note = answer.notes[0];
  console.log(
    `checklist, with the catch-all marked (${round}): ${ms(t)}; ${note?.transactions} transactions, ${note?.largest?.length} largest`,
  );
}

// The transactions of March by their entries, as journal.list and payees.get name them.
const inMarch = items
  .map((item, index) => ({ item, index }))
  .filter(({ index }) => dateOf(index + 1).startsWith("2026-03"));
const journalsOf = (count: number) =>
  inMarch.slice(0, count).map(({ index }) => posted[index] as string);
for (const count of [100, Math.min(500, inMarch.length)]) {
  t = performance.now();
  const plan = await call(
    "inbox.recategorize",
    {
      journalIds: journalsOf(count),
      accountId: "6000",
      fromAccountId: "5000",
      limit: count,
      dryRun: true,
    },
    crypto.randomUUID(),
  );
  console.log(`a plan for ${count} transactions: ${ms(t)}; would move ${plan.would}`);
}

const before = await service.readAggregate();
t = performance.now();
const done = await call(
  "inbox.recategorize",
  { journalIds: journalsOf(moved), accountId: "6000", fromAccountId: "5000", reason: "Software" },
  crypto.randomUUID(),
);
const took = performance.now() - t;
const after = await service.readAggregate();
console.log(
  `a move of ${moved} transactions: ${took.toFixed(0)} ms, ${(took / moved).toFixed(1)} ms each; applied ${done.applied}, skipped ${done.skipped}, failed ${done.failed}, remaining ${done.remaining}; entries ${before.aggregate.state.journals.length} -> ${after.aggregate.state.journals.length}`,
);
t = performance.now();
const again = await checklist();
console.log(
  `the checklist after the move: ${ms(t)}; ${again.notes[0]?.transactions} transactions left in the catch-all`,
);
console.log(`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);

service.close();
rmSync(dir, { recursive: true, force: true });

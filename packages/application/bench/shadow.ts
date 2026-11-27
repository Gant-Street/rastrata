// Benchmark: how the shadow lane's operations behave on a large book (N journals, default 1000):
// the cutover checklist, an opening review of every account, reading a Xero chart, trial balance and
// account transactions, and the tie-out. Run it with
//   N=1000 bun bench/shadow.ts
// Every figure is a median of a few runs, in milliseconds, on this machine, with nothing else asked of
// it. Everything here is made up.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const n = Number(process.env.N ?? "1000");
const runs = Number(process.env.RUNS ?? "5");
const dir = mkdtempSync(join(tmpdir(), "rastrata-bench-"));
const service = await LocalBookService.open(join(dir, "book.sqlite"));

// A book of 195 accounts so a chart, a trial balance and an opening review are a realistic size.
const accounts = [
  { code: "1000", name: "Cash", role: "asset", tags: { cashFlowClass: "cash" } },
  { code: "3000", name: "Capital", role: "equity" },
  { code: "3900", name: "Opening balance equity", role: "equity" },
  { code: "4000", name: "Sales", role: "income" },
  { code: "5000", name: "Expense", role: "expense" },
  ...Array.from({ length: 190 }, (_, index) => ({
    code: String(6000 + index),
    name: `Cost centre ${index}`,
    role: "expense",
  })),
];
await service.setup({ ...BULK_BOOK, accounts } as never);

const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
async function call(name: string, input: unknown, operationId?: string) {
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
  const body = (await response.json()) as { ok: boolean; data: unknown; error?: unknown };
  if (!body.ok) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body.data;
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
async function measure(label: string, work: () => Promise<unknown>) {
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  console.log(`${label.padEnd(58)} ${median(times).toFixed(0).padStart(6)} ms`);
}

const t = performance.now();
await postBulk(service, n);
console.log(
  `built ${n} journals directly through the ledger: ${(performance.now() - t).toFixed(0)} ms`,
);
await service.readAggregate();

// ---- Xero's files, made up -------------------------------------------------------------------
const csv = (rows: string[][]) => rows.map((row) => row.join(",")).join("\n");
const chart = csv([
  ["*Code", "*Name", "*Type", "*Tax Code", "Balance"],
  ["090", "Cash", "Bank", "x", "0.00"],
  ["200", "Sales", "Revenue", "x", "0.00"],
  ["300", "Capital", "Equity", "x", "0.00"],
  ["400", "Expense", "Expense", "x", "0.00"],
  ...Array.from({ length: 190 }, (_, index) => [
    String(7000 + index),
    `Cost centre ${index}`,
    "Expense",
    "x",
    "0.00",
  ]),
]);
const tbRows = [
  ["Cash (090)", "5000.00", "", "5000.00", ""],
  ["Capital (300)", "", "5000.00", "", "5000.00"],
  ...Array.from({ length: 190 }, (_, index) => [
    `Cost centre ${index} (${7000 + index})`,
    "0.00",
    "0.00",
    "0.00",
    "0.00",
  ]),
];
const trialBalance = csv([
  ["Trial Balance"],
  ["Bench Co"],
  ["As at 31 December 2026"],
  [""],
  ["Account", "Debit", "Credit", "YTD Debit", "YTD Credit"],
  ...tbRows,
  ["Total", "5000.00", "5000.00", "5000.00", "5000.00"],
]);
const lines = Array.from(
  { length: 1400 },
  (_, index) =>
    `${String((index % 28) + 1).padStart(2, "0")} Mar 2026,Spend Money,Line ${index},R${index},${(index % 90) + 1}.00,,0.00,0.00,0.00`,
);
const transactions = [
  "Account Transactions",
  "Bench Co",
  "For the period 1 March 2026 to 31 March 2026",
  "",
  "Date,Source,Description,Reference,Debit,Credit,Running Balance,Gross,GST",
  "Cash (090)",
  ...lines,
  `Total Cash (090),,,,${lines.reduce((sum, _, index) => sum + (index % 90) + 1, 0)}.00,0.00,,,`,
].join("\n");
console.log(
  `files: chart ${chart.length} chars, trial balance ${trialBalance.length}, transactions ${transactions.length}`,
);

await measure("cutover.checklist", () => call("cutover.checklist", {}));
await measure("opening.review, 190 balances", () =>
  call("opening.review", {
    cutoverDate: "2026-01-01",
    balances: accounts.slice(5).map((account) => ({ accountId: account.code, balance: "1.00" })),
  }),
);
await measure("xero.chart.preview, 194 accounts", () =>
  call("xero.chart.preview", { text: chart }),
);
await call("xero.chart.import", { text: chart, accept: "likely" }, crypto.randomUUID());
await measure("xero.trialBalance.preview, 192 rows", () =>
  call("xero.trialBalance.preview", { text: trialBalance }),
);
await measure("xero.transactions.preview, 1400 lines", () =>
  call("xero.transactions.preview", { text: transactions }),
);
await call("xero.trialBalance.import", { text: trialBalance }, crypto.randomUUID());
await call("xero.transactions.import", { text: transactions }, crypto.randomUUID());
await call(
  "xero.reconciled.set",
  { choices: [{ code: "090", through: "2026-12-31" }] },
  crypto.randomUUID(),
);
await measure(`tieout.report, ${n} journals in the book`, () => call("tieout.report", {}));

service.close();
rmSync(dir, { recursive: true, force: true });

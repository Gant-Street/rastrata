// Benchmark: what the statements cost on a large book (N journals, default 1000). Run it with
//   N=1000 bun bench/reports.ts
// Reading the ledger back (the first read replays it, see bench/read-model.ts) is the kernel's cost
// and dominates; this measures what a report costs once the verified state is in hand, which is the
// part the compiler controls. Every figure is also checked, so a fast wrong answer cannot pass.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "@rastrata/kernel";
import type { AccountTagMap } from "../src/account-tags.ts";
import { LocalBookService } from "../src/local.ts";
import { parseMoney } from "../src/money.ts";
import { accountActivity, compileGeneralLedger } from "../src/reports/activity.ts";
import { compileCashFlow } from "../src/reports/cash-flow.ts";
import { exportStatement } from "../src/reports/export.ts";
import { compileReports } from "../src/reports.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const n = Number(process.env.N ?? "1000");
const runs = 7;
const dir = mkdtempSync(join(tmpdir(), "rastrata-reports-bench-"));
const ms = (start: number) => performance.now() - start;
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const table: [string, string][] = [];
const note = (label: string, value: string) => {
  table.push([label, value]);
  console.log(`${label.padEnd(58)} ${value}`);
};

const service = await LocalBookService.open(join(dir, "book.sqlite"));
await service.setup(BULK_BOOK);
let t = performance.now();
await postBulk(service, n);
note(`built ${n} journals straight through the ledger`, `${ms(t).toFixed(0)} ms`);
t = performance.now();
const { aggregate } = await service.readAggregate();
note("first read, full replay from genesis (the kernel's cost)", `${ms(t).toFixed(0)} ms`);
const state = aggregate.state;

const tags: AccountTagMap = {
  hash: hashCanonical({ type: "BenchTags" }).digest,
  revision: 0,
  tagsFor: (id) =>
    id === "1000" ? { cashFlowClass: "cash" } : id === "3000" ? { cashFlowClass: "financing" } : {},
};
const measure = <T>(label: string, work: () => T, check: (result: T) => void): T => {
  t = performance.now();
  const first = work();
  const cold = ms(t);
  check(first);
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    t = performance.now();
    check(work());
    times.push(ms(t));
  }
  note(label, `${cold.toFixed(1)} ms first, ${median(times).toFixed(1)} ms median of ${runs}`);
  return first;
};

const asOf = "2026-12-31";
const report = measure(
  "reports.get: three statements, fiscal year to date",
  () => compileReports(state, asOf),
  (result) => {
    if (!result.balanceSheet.balanced || result.balanceSheet.difference !== "0.00")
      throw new Error("does not balance");
    if (parseMoney(result.trialBalance.debit) !== parseMoney(result.trialBalance.credit))
      throw new Error("trial balance");
  },
);
measure(
  "reports.get: a quarter with a comparison",
  () => compileReports(state, asOf, { from: "2026-10-01", compare: "previousPeriod" }),
  (result) => {
    if (result.comparison === null) throw new Error("no comparison");
  },
);
// The share of income adds one division in integers to each line and total of the profit and loss.
measure(
  "reports.get: the same, with each line's share of income",
  () => compileReports(state, asOf, { share: "income" }),
  (result) => {
    const income = result.profitAndLoss.totals.find((total) => total.key === "income");
    if (income?.amount !== "0.00" && income?.share !== "100.0") throw new Error("share of income");
    if (
      result.profitAndLoss.rows.some((row) => row.share === undefined && income?.amount !== "0.00")
    )
      throw new Error("a line has no share");
  },
);
measure(
  "reports.get: a quarter with a comparison and shares",
  () =>
    compileReports(state, asOf, {
      from: "2026-10-01",
      compare: "previousPeriod",
      share: "income",
    }),
  (result) => {
    if (result.comparison === null) throw new Error("no comparison");
  },
);
measure(
  "reports.cashFlow: the whole year",
  () => compileCashFlow(state, asOf, { tags }),
  (result) => {
    if (!result.available || result.ties !== true) throw new Error("cash flow does not tie");
    if (result.closingCash !== report.balanceSheet.rows.find((row) => row.code === "1000")?.amount)
      throw new Error("cash");
  },
);
const ledger = measure(
  "reports.generalLedger: the whole year (all lines, then one page)",
  () => compileGeneralLedger(state, { asOf, page: 1 }),
  (result) => {
    if (result.count !== n * 2) throw new Error(`expected ${n * 2} lines, got ${result.count}`);
  },
);
measure(
  "activity.get: one account, one page of 25",
  () =>
    accountActivity(state, {
      accountId: "1000",
      asOf,
      from: report.periodStart,
      to: asOf,
      populationHash: report.populationHash,
      page: 1,
    }),
  (result) => {
    if (result.count !== n) throw new Error("activity count");
  },
);
const file = measure(
  "reports.export: the general ledger as CSV (every line)",
  () => exportStatement(state, { statement: "general-ledger", asOf, bookName: "Bulk Co", tags }),
  (result) => {
    if (!result.content.startsWith("Report,General ledger")) throw new Error("export");
  },
);
measure(
  "reports.export: the profit and loss as CSV with shares of income",
  () =>
    exportStatement(state, {
      statement: "profit-loss",
      asOf,
      share: "income",
      bookName: "Bulk Co",
      tags,
    }),
  (result) => {
    if (!result.content.includes("% of income")) throw new Error("export");
  },
);
note(
  "general ledger CSV size",
  `${(file.content.length / 1024 / 1024).toFixed(2)} MiB for ${ledger.count} lines`,
);
t = performance.now();
await service.reports(asOf);
note("through the service (incremental read + compile), once", `${ms(t).toFixed(1)} ms`);
service.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ journals: n, rows: table }));

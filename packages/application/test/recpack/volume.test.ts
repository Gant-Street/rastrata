/** The report and the pack on a book of 20,000 entries, reconciled a month at a time through the real
 * operations: that every month's report is right at that size (the books less what was outstanding is the
 * statement, to the cent, for each of twelve statements that each continue from the one before) and what it
 * costs, one report and the pack of the year. The book is made straight through the ledger, as the other
 * volume tests make theirs. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_OPERATIONS } from "../../src/client-contracts.gen.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { cents, dec } from "../acceptance/month.ts";
import { expectWithin } from "../support/budget.ts";
import { BULK_BOOK, postBulk } from "../support/bulk-book.ts";
import type { Json } from "./support.ts";

const ENTRIES = 20_000;
const MONTHS = 12;
/** Lines of each month's last days that its statement does not show yet. */
const LEFT_OFF = 5;
let directory: string;
let service: LocalBookService;
let http: ApplicationHttp;
const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
const ids: string[] = [];
const statements: { date: string; balance: string; outstanding: bigint }[] = [];

async function ask(name: string, input: unknown = {}): Promise<Json> {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(WRITES.has(name) ? { operationId: crypto.randomUUID() } : {}),
      }),
    }),
  );
  const body = (await response.json()) as Json;
  if (response.status !== 200 || body.ok !== true)
    throw new Error(
      `${name} answered ${response.status}: ${JSON.stringify(body.error).slice(0, 400)}`,
    );
  return body.data;
}

const monthEnd = (month: number) =>
  `2026-${String(month).padStart(2, "0")}-${month === 2 ? "28" : "30"}`;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rastrata-recpack-volume-"));
  const now = () => new Date(Date.UTC(2027, 0, 5, 12, 0, 0));
  service = await LocalBookService.open(join(directory, "book.sqlite"), { now });
  http = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock: now },
  );
  await service.setup(BULK_BOOK);
  // Money in and out of the cash account all year, a month at a time; no day past the 28th, so that a
  // statement ending on the 28th or the 30th holds the whole month.
  await postBulk(service, ENTRIES, {
    entry: (n) => {
      const month = Math.min(MONTHS, 1 + Math.floor(((n - 1) * MONTHS) / ENTRIES));
      const day = 1 + (n % 27);
      const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const amount = 1000n + BigInt((n * 37) % 90_000);
      return n % 2 === 0
        ? { date, debit: "5000", credit: "1000", cents: amount }
        : { date, debit: "1000", credit: "4000", cents: amount };
    },
  });
  await service.readAggregate();
  for (let month = 1; month <= MONTHS; month += 1) {
    const date = monthEnd(month);
    let draft = await ask("reconcile.start", {
      accountId: "1000",
      statementDate: date,
      statementBalance: "0.00",
    });
    const lines = draft.lines as Json[];
    // The last lines of the month by date are the ones the statement does not show yet.
    const left = lines.slice(-LEFT_OFF);
    const kept = lines.slice(0, -LEFT_OFF);
    const balance = kept.reduce(
      (sum, line) => sum + cents(line.amount),
      cents(draft.openingBalance),
    );
    draft = await ask("reconcile.setStatement", {
      id: draft.id,
      expectedVersion: draft.version,
      statementDate: date,
      statementBalance: dec(balance),
    });
    const progress = await ask("reconcile.setCleared", {
      id: draft.id,
      expectedVersion: draft.version,
      reset: "all",
      deselect: left.map((line) => line.postingId),
    });
    expect(progress.difference).toBe("0.00");
    const done = await ask("reconcile.complete", {
      id: draft.id,
      expectedVersion: progress.version,
    });
    ids.push(done.id);
    statements.push({
      date,
      balance: dec(balance),
      outstanding: left.reduce((sum, line) => sum + cents(line.amount), 0n),
    });
  }
}, 600_000);

afterAll(() => {
  service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("every month's report is right: each statement continues from the one before and the books less the outstanding lines are the statement", async () => {
  let previousBalance = "0.00";
  let cleared = 0;
  for (const [index, id] of ids.entries()) {
    const report = await ask("reconcile.report", { id });
    const statement = statements[index] as (typeof statements)[number];
    expect(report.statementBalance).toBe(statement.balance);
    expect(report.openingBalance).toBe(previousBalance);
    expect(report.outstanding.count).toBe(LEFT_OFF);
    // The lines that were off the first month's statement are on the next one's, because they are cleared there.
    expect(report.outstanding.total).toBe(dec(statement.outstanding));
    expect(cents(report.bookBalance) - cents(report.outstanding.total)).toBe(
      cents(report.statementBalance),
    );
    previousBalance = report.statementBalance;
    cleared += report.cleared.count;
  }
  // Every entry of the year is on one statement or another, except the last month's five.
  expect(cleared).toBe(ENTRIES - LEFT_OFF);
});

test("one report costs milliseconds at 20,000 entries, and the last of twelve, which has eleven behind it, costs no more than a few times that", async () => {
  const last = ids.at(-1) as string;
  const first = ids[0] as string;
  const time = async (id: string, rounds = 5) => {
    const start = performance.now();
    for (let round = 0; round < rounds; round += 1) await ask("reconcile.report", { id });
    return (performance.now() - start) / rounds;
  };
  const early = await time(first);
  const late = await time(last);
  console.info(
    `reconcile.report, ${ENTRIES} entries: the first of ${MONTHS} statements ${early.toFixed(1)} ms, the last (eleven before it) ${late.toFixed(1)} ms`,
  );
  expectWithin("the first month's report", early, 1000);
  expectWithin("the last month's report", late, 2000);
});

test("the pack of the year has all twelve and costs seconds at most", async () => {
  const start = performance.now();
  const pack = await ask("taxAccountant.build", { taxYear: 2026 });
  const ms = performance.now() - start;
  const file = (path: string) => (pack.files as Json[]).find((item) => item.path === path) as Json;
  const summary = file("reconciliations.csv");
  const lines = file("reconciliation-lines.csv");
  console.info(
    `taxAccountant.build, ${ENTRIES} entries and ${MONTHS} reconciliations: ${ms.toFixed(0)} ms; reconciliations.csv ${summary.bytes} bytes, reconciliation-lines.csv ${(lines.bytes / 1_000_000).toFixed(1)} MB`,
  );
  expect(
    (summary.content as string).split("\r\n").filter((row) => /^[0-9a-f-]{36},/.test(row)),
  ).toHaveLength(MONTHS);
  expect(lines.bytes).toBeGreaterThan(1_000_000);
  expectWithin("the pack of the year", ms, 30_000);
});

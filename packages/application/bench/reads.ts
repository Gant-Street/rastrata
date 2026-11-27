// Benchmark: what a person waits for when they look at a report or a register right after posting
// something, by size of book. Run it with
//   N=5000 bun bench/reads.ts
// It builds N journals through the native ledger (the write path), reads the book back once (the replay),
// and then, for each read in READS, ROUNDS times: posts one more journal and times that read as the first
// thing that looks at the new state. That is the case a person meets after every posting, and the one a
// per-state cache does not help. `read` is the incremental read (the kernel verifies the new outcome),
// `compile` is the rest. Prints the median and the 95th percentile, and one JSON line at the end.
// Environment:
//   N        journals in the book (default 2000)
//   ROUNDS   postings per read (default 20)
//   READS    comma-separated: report (the three statements), home (the seven reports the Home screen asks
//            for), register (one account for a month), accounts (the chart with balances), cashflow,
//            ledger (the general ledger, first page), journal (the Journal screen's first page),
//            search (the same page narrowed by a month and an account), entry (the newest entry, as
//            the entry screen reads it), posting (not a read: a draft, its preview and its commit, as
//            the screens post), homepage (everything the Home screen asks for, in its order), and
//            op:<name> (any operation by name, with the input of INPUT when there is one: op:reconcile.status,
//            or op:payees.totals with INPUT='{"asOf":"2026-12-31"}').
//            Default: all of the named ones.
//   ACCOUNTS (default 4) and REVISIONS (default 0): the chart and the configuration revisions, as in
//            scale.ts. With more than four accounts the postings spread over the chart, as a real book's do.
//   ORDER    scattered (default: dates all over the year, so nearly every posting is backdated, as scale.ts
//            posts them) or chronological (each posting is dated on or after the one before).
//   REVERSED a fraction of the journals that are reversed after the build (0.05: every twentieth), because a
//            book that has been used has corrections and some screens search them for every entry.
//   DRAFTS   yes: every journal also has the posted draft the screens leave behind when a person posts.
//   INBOX    a number of bank lines waiting in the Inbox (try READS=op:inbox.list,op:inbox.summary).
//   STEADY   yes: post nothing between the rounds, so a read is timed on a state it has already seen (the cost
//            a screen pays each time it refreshes, rather than the first time after a posting).
//   INPUT    the input of every op: read, as JSON (default {}).
//   SLOW     a number of milliseconds: each round slower than that is listed with how it split (the ledger's read
//            and the rest), to tell a read that is slow from a pause (a collection, another process) in its way.
// Profile one read with `READS=report bun --cpu-prof --cpu-prof-dir=/tmp/prof bench/reads.ts` and read the
// result with `bun bench/profile-summary.ts /tmp/prof/CPU.*.cpuprofile 25 compileCoreReports`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalsOf } from "@rastrata/kernel";
import { readAccountTags } from "../src/account-tags.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { compileGeneralLedger } from "../src/reports/activity.ts";
import { compileCashFlow } from "../src/reports/cash-flow.ts";
import type { BankLine } from "../src/ingest-types.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { ingestPort } from "../src/slices/ingest/port.ts";
import { BULK_BOOK, type BulkEntry, postBulk, reverseBulk } from "../test/support/bulk-book.ts";
import { chart, reconfigure } from "./book.ts";

const total = Number(process.env.N ?? "2000");
const rounds = Number(process.env.ROUNDS ?? "20");
const accounts = Number(process.env.ACCOUNTS ?? String(BULK_BOOK.accounts.length));
const revisions = Number(process.env.REVISIONS ?? "0");
const chronological = (process.env.ORDER ?? "scattered") === "chronological";
const reversed = Number(process.env.REVERSED ?? "0");
const drafts = process.env.DRAFTS === "yes";
const inbox = Number(process.env.INBOX ?? "0");
const steady = process.env.STEADY === "yes";
const slowMs = Number(process.env.SLOW ?? "0");
const askedWith: unknown = JSON.parse(process.env.INPUT ?? "{}");
const ALL = [
  "report",
  "home",
  "register",
  "accounts",
  "cashflow",
  "ledger",
  "journal",
  "search",
  "entry",
  "posting",
  "homepage",
];
const wanted = (process.env.READS ?? ALL.join(","))
  .split(",")
  .filter((name) => ALL.includes(name) || name.startsWith("op:"));
const ASOF = "2026-12-31";

const mb = (bytes: number) => (bytes / 1048576).toFixed(0);
const day = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
const expected = total + rounds * wanted.length;

/** The n-th posting. A chart of more than four accounts is used the way a real book's is: income against
 * cash, and every expense account against cash. */
function entry(n: number): BulkEntry {
  const date = chronological
    ? day(Math.min(364, Math.floor(((n - 1) / expected) * 365)))
    : `2026-${String(1 + (n % 12)).padStart(2, "0")}-${String(1 + (n % 27)).padStart(2, "0")}`;
  const cents = 1000n + BigInt(n);
  if (accounts <= 4) return { date, debit: "1000", credit: "4000", cents };
  if (n % 2 === 0) return { date, debit: "1000", credit: "4000", cents };
  const expense = n % (accounts - 3);
  return {
    date,
    debit: expense === 0 ? "5000" : String(6000 + expense - 1),
    credit: "1000",
    cents,
  };
}

const dir = mkdtempSync(join(tmpdir(), "rastrata-reads-"));
// The hosted option (no aggregate snapshot), with the safety host a local book has, because the Home
// screen asks for the backup status.
const service = await LocalBookService.open(join(dir, "book.sqlite"), { snapshots: false });
await service.setup(chart(accounts));
await reconfigure(service, revisions);
console.log(
  `# ${total} journals, ${accounts} accounts, ${revisions} configuration revisions, ${chronological ? "chronological" : "scattered"} dates`,
);

let started = performance.now();
await postBulk(service, total, { entry: (n) => entry(n) });
// A book that has been used has corrections, and every entry a person posted keeps its draft.
if (reversed > 0) {
  const every = Math.max(1, Math.round(1 / reversed));
  const ids: string[] = [];
  for (let n = every; n <= total; n += every) ids.push(`bulk-${n}`);
  await reverseBulk(service, ids);
}
if (drafts) {
  // biome-ignore lint/suspicious/noExplicitAny: the bench reaches the service's product store
  const store = (service as any).db as {
    query(sql: string): { run(...args: unknown[]): unknown };
    transaction<T>(work: () => T): T;
  };
  store.transaction(() => {
    const insert = store.query(
      "INSERT INTO app_drafts (id, version, status, body, outcome_sequence) VALUES (?, 1, 'posted', ?, ?)",
    );
    for (let n = 1; n <= total; n += 1)
      insert.run(
        `bulk-${n}`,
        JSON.stringify({
          date: "2026-06-15",
          reference: `INV-${n}`,
          narration: `Bulk journal ${n}`,
          lines: [
            { accountId: "1000", debit: "10.00", credit: "" },
            { accountId: "4000", debit: "", credit: "10.00" },
          ],
        }),
        String(n + 1),
      );
  });
}
if (inbox > 0) {
  const port = ingestPort(service);
  const lines: BankLine[] = Array.from({ length: inbox }, (_, index) => ({
    kind: "bankLine",
    provider: "csv",
    accountKey: "csv:1000",
    rawIndex: index,
    postedOn: `2026-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`,
    amount: `-${(1 + (index % 300)).toString()}.${String(index % 100).padStart(2, "0")}`,
    currency: "USD",
    description: `VENDOR ${index % 400} CARD PURCHASE ${index}`,
  }));
  const raw = port.archive(
    new TextEncoder().encode(JSON.stringify(lines)),
    "text/csv",
    "inbox.csv",
  );
  port.submit({
    provider: "csv",
    sourceKey: "csv:1000",
    raw,
    lines,
    balances: [],
    fetchedAt: new Date().toISOString(),
    ledgerAccountId: "1000",
  });
}
console.log(
  `build   ${((performance.now() - started) / 1000).toFixed(1)} s to write ${total} journals${reversed > 0 ? `, ${Math.floor(total * reversed)} of them reversed` : ""}${drafts ? ", each with its posted draft" : ""}`,
);
started = performance.now();
await service.readAggregate();
console.log(
  `replay  ${((performance.now() - started) / 1000).toFixed(1)} s, rss ${mb(process.memoryUsage.rss())} MB`,
);

const home = [
  ...[7, 8, 9, 10, 11, 12].map((month) => ({
    asOf: `2026-${String(month).padStart(2, "0")}-${new Date(Date.UTC(2026, month, 0)).getUTCDate()}`,
    from: `2026-${String(month).padStart(2, "0")}-01`,
  })),
  { asOf: ASOF, from: "2026-01-01" },
];

/** An operation by name, through the same `/v1` surface the screens use. */
const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
async function call(name: string, input: unknown = {}): Promise<unknown> {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
      }),
    }),
  );
  const body = (await response.json()) as { ok: boolean; data?: unknown };
  if (!body.ok) throw new Error(`${name} failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data;
}

const reads: Record<string, () => Promise<unknown>> = {
  report: () => service.reports(ASOF),
  // What the Home screen asks for, in the order it asks (apps/web/src/routes/home-facts.ts and
  // home-money.ts): nine reads together, then the checklist, then the calendar and the seven reports.
  homepage: async () => {
    await Promise.all([
      call("accounts.list"),
      call("inbox.summary"),
      call("reconcile.status"),
      call("import.history"),
      call("backup.status"),
      call("periods.list"),
      call("stripe.status", { books: false }),
      call("bankfeed.status", { books: false }),
      call("tokens.list"),
    ]);
    await call("cutover.checklist", {});
    await call("reports.calendar");
    await Promise.all(home.map((range) => call("reports.get", range)));
  },
  home: () =>
    Promise.all(home.map((range) => service.reports(range.asOf, undefined, { from: range.from }))),
  register: () =>
    service.accountActivity({
      accountId: "1000",
      asOf: ASOF,
      from: "2026-03-01",
      to: "2026-03-31",
      page: 1,
    }),
  accounts: () => service.accounts(),
  cashflow: async () => {
    const { aggregate } = await service.readAggregate();
    return compileCashFlow(aggregate.state, ASOF, { tags: readAccountTags(service.store) });
  },
  ledger: async () => {
    const { aggregate } = await service.readAggregate();
    return compileGeneralLedger(aggregate.state, { asOf: ASOF, page: 1 });
  },
  journal: () =>
    service.journalBook({ page: 1, text: "", from: "", to: "", accountId: "", status: "" }),
  search: () =>
    service.journalBook({
      page: 1,
      text: "",
      from: "2026-03-01",
      to: "2026-03-31",
      accountId: "1000",
      status: "",
    }),
  entry: async () => {
    const { aggregate } = await service.readAggregate();
    // The newest journal without copying the book's list of them, which a screen's read does not do either.
    const newest = journalsOf(aggregate.state).at(-1);
    if (!newest) throw new Error("The book has no journals");
    return service.journalEntry(newest.journal.id, aggregate.state.bookRevision);
  },
  // Not a read: a person's posting, as the screens make it (a draft, its preview, its commit).
  posting: async () => {
    const draft = service.createDraft({
      date: "2026-06-15",
      reference: "Bench",
      narration: "A posting made by the bench",
      lines: [
        { accountId: "1000", debit: "12.34", credit: "" },
        { accountId: "4000", debit: "", credit: "12.34" },
      ],
    });
    const operationId = crypto.randomUUID();
    const prepared = await service.prepareDraft(draft.id, draft.version, operationId);
    return service.commitAction(operationId, prepared.planHash);
  },
};

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const summary: Record<string, unknown>[] = [];
let posted = total;
const first = (name: string): (() => Promise<unknown>) =>
  name.startsWith("op:")
    ? () => call(name.slice(3), askedWith)
    : (reads[name] as () => Promise<unknown>);

// The first read of the replayed state, which every later one is compared with.
for (const name of wanted) {
  started = performance.now();
  await first(name)();
  console.log(
    `first   ${name.padEnd(8)} ${(performance.now() - started).toFixed(0)} ms on the replayed state`,
  );
  break;
}

for (const name of wanted) {
  const read: number[] = [];
  const compile: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    if (!steady) {
      await postBulk(service, 1, { entry: (n) => entry(n) });
      posted += 1;
    }
    const t0 = performance.now();
    await service.readAggregate();
    const t1 = performance.now();
    await first(name)();
    const t2 = performance.now();
    read.push(t1 - t0);
    compile.push(t2 - t1);
    if (slowMs > 0 && t2 - t0 > slowMs)
      console.log(
        `slow    ${name} round ${round}: ${(t2 - t0).toFixed(0)} ms (read ${(t1 - t0).toFixed(1)} + compile ${(t2 - t1).toFixed(1)})`,
      );
  }
  const whole = read.map((value, index) => value + (compile[index] as number));
  console.log(
    `reads   ${name.padEnd(8)} after a posting: median ${percentile(whole, 0.5).toFixed(0)} ms, p95 ${percentile(whole, 0.95).toFixed(0)} ms, max ${Math.max(...whole).toFixed(0)} ms ` +
      `(read ${percentile(read, 0.5).toFixed(1)} + compile ${percentile(compile, 0.5).toFixed(1)} at the median; ${rounds} rounds)`,
  );
  summary.push({
    read: name,
    medianMs: Number(percentile(whole, 0.5).toFixed(1)),
    p95Ms: Number(percentile(whole, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...whole).toFixed(1)),
    readMs: Number(percentile(read, 0.5).toFixed(2)),
    compileMs: Number(percentile(compile, 0.5).toFixed(2)),
  });
}
Bun.gc(true);
console.log(
  `memory  rss ${mb(process.memoryUsage.rss())} MB, heap ${mb(process.memoryUsage().heapUsed)} MB after a collection, after ${posted} journals`,
);
console.log(
  JSON.stringify({
    journals: total,
    accounts,
    revisions,
    order: chronological ? "chronological" : "scattered",
    rounds,
    summary,
  }),
);
service.close();
rmSync(dir, { recursive: true, force: true });

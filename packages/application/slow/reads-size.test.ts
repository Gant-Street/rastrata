/** The complexity budget of docs/reference/program/performance.md ("Under 100 ms", principle 7) as a test: a read of
 * the Inbox, the checklist, the list of changes, the calendar, the Journal's first page and its search by an
 * account, the general ledger's first page, an account's register or an entry, as the first look after a posting (the case a person meets after every posting, and the one a cache per state does not
 * help), costs on a book of 10,000 journals no more than 1.3 times what it costs on a book of 2,000, and under
 * 5 ms. The books are made as `bench/reads.ts` makes
 * them, with the Inbox growing with the book (1,500 lines at 2,000 journals, 5,000 at 10,000), a twentieth of the
 * entries reversed and every entry with its posted draft, and each read is timed after a posting, the way the
 * bench times it, over many postings, after some that are not counted (the first of a process is a compile). The
 * Inbox's reads are also timed with 20,000 lines waiting against 1,500 on the same 2,000 journals, so that a read
 * that looks at the lines is seen at a size where it is more than a fraction of a millisecond.
 *
 * The ratio is asserted whatever the machine is doing, because both sizes are timed one after the other by the
 * same process and a slower or a busier computer makes both longer; a read that is over it is timed again on the
 * same books before it is said to grow. The limit in milliseconds is a claim about a quiet machine: it is asserted
 * when the machine is quiet (`test/support/budget.ts`), made longer by how much slower than a laptop of 2026 this
 * computer is, and otherwise printed. Run it with `bun run --cwd packages/application test:slow` when the computer
 * is quiet; the medians it prints are what to record in docs/reference/program/performance.md. */
import { afterAll, describe, expect, test } from "bun:test";
import { type BulkInboxBook, bulkInboxBook } from "../test/support/bulk-inbox.ts";
import { budgetsApply } from "../test/support/budget.ts";

const SIZES = [
  { journals: 2000, lines: 1500 },
  { journals: 10000, lines: 5000 },
] as const;
/** A read as a screen asks for it: the operation, and what it is asked with (a function of the journal just posted,
 * for a read of an entry). */
interface Read {
  readonly label: string;
  readonly name: string;
  readonly input?: unknown | ((posted: string) => unknown);
}
const plain = (name: string): Read => ({ label: name, name });
/** What is asked of the first look at a read that needs an input, as the screens ask it (a filter that is not set
 * is not sent): the Journal's first page and its search by month and account, the general ledger's first page,
 * one account's register for a month, and the entry just posted. */
const ASKED = {
  "journal.list": { page: 1 },
  "journal.search": { page: 1, from: "2026-03-01", to: "2026-03-31", accountId: "1000" },
  "reports.generalLedger": { asOf: "2026-12-31", page: 1 },
  "activity.get": {
    accountId: "1000",
    asOf: "2026-12-31",
    from: "2026-03-01",
    to: "2026-03-31",
    page: 1,
  },
};
/** The reads that cost at 10,000 journals what they cost at 2,000, and under 5 ms. */
const HELD: readonly Read[] = [
  plain("inbox.list"),
  plain("inbox.summary"),
  plain("cutover.checklist"),
  plain("changes.list"),
  plain("reconcile.status"),
  plain("periods.list"),
  { label: "journal.list", name: "journal.list", input: ASKED["journal.list"] },
  { label: "journal.search", name: "journal.list", input: ASKED["journal.search"] },
  {
    label: "reports.generalLedger",
    name: "reports.generalLedger",
    input: ASKED["reports.generalLedger"],
  },
  { label: "activity.get", name: "activity.get", input: ASKED["activity.get"] },
  { label: "journal.get", name: "journal.get", input: (posted: string) => ({ journalId: posted }) },
];
/** The reads still known to grow with the book (docs/reference/program/performance.md says which and by how much).
 * They are not in the run, which they would fail: name one in `RASTRATA_SIZE_READS` to time it, and move it to
 * `HELD` when it is fixed. */
const GROWING: readonly Read[] = [
  { label: "reports.largest", name: "reports.largest", input: { asOf: "2026-12-31" } },
  { label: "payees.totals", name: "payees.totals", input: { asOf: "2026-12-31" } },
  { label: "taxSummary.get", name: "taxSummary.get", input: { taxYear: 2026 } },
  { label: "taxChecks.get", name: "taxChecks.get", input: { taxYear: 2026 } },
  { label: "taxSales.get", name: "taxSales.get", input: { taxYear: 2026 } },
  { label: "taxWorksheet.get", name: "taxWorksheet.get", input: { taxYear: 2026 } },
  { label: "taxPack.build", name: "taxPack.build", input: { taxYear: 2026 } },
  { label: "taxAccountant.build", name: "taxAccountant.build", input: { taxYear: 2026 } },
];
/** `RASTRATA_SIZE_READS=journal.list,journal.get` times only those, to work on one read at a time. */
const ONLY = process.env.RASTRATA_SIZE_READS?.split(",").map((label) => label.trim());
const READS: readonly Read[] = [...HELD, ...(ONLY ? GROWING : [])].filter(
  (read) => !ONLY || ONLY.includes(read.label),
);
/** The reads that ask the Inbox, and a number of lines that waits in it a dozen times as long as the one the book
 * of 2,000 journals is made with. */
const LINE_READS: readonly Read[] = [
  plain("inbox.list"),
  plain("inbox.summary"),
  plain("cutover.checklist"),
].filter((read) => !ONLY || ONLY.includes(read.label));
const MANY_LINES = 20000;
/** Postings that are timed for each read, and those before them that are not. */
const ROUNDS = Number(process.env.RASTRATA_SIZE_ROUNDS ?? "30");
const WARM = 8;
/** What a timer cannot tell apart, in milliseconds on the computer the limit was set on, added to the 1.3 times. */
const SLACK_MS = 0.5;
/** A read as the first look after a posting costs under this many milliseconds, whatever the size, on the computer
 * the figure was set on (a laptop of 2026). On another it is the same figure made longer by how much longer a fixed
 * piece of work takes there, so that a slower computer is not told its reads are slow for being on it. */
const LIMIT_MS = 5;
/** What the fixed piece of work below takes on the computer the limit was set on, in milliseconds. */
const REFERENCE_MS = 4;
/** A median of thirty postings moves by about a tenth from one run to the next on a quiet computer, and the
 * checklist, which asks seven other reads, is within a tenth of the limit. */
const NOISE = 1.15;

const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** How many times longer than on the computer the limit was set on a fixed piece of work takes here, one or more:
 * a map of 40,000 keys, a sort and 8,000 rows made into text. */
function slowness(): number {
  const work = (): number => {
    const map = new Map<string, number>();
    for (let n = 0; n < 40000; n += 1) map.set(`key-${(n * 7919) % 40000}`, n);
    const keys = [...map.keys()].sort();
    const rows = keys.slice(0, 8000).map((key, at) => ({ key, at, text: `row ${at} of ${key}` }));
    return JSON.stringify(rows).length + keys.length;
  };
  for (let round = 0; round < 3; round += 1) work();
  const times: number[] = [];
  for (let round = 0; round < 9; round += 1) {
    const started = performance.now();
    work();
    times.push(performance.now() - started);
  }
  return Math.max(1, median(times) / REFERENCE_MS);
}

describe("a read as the first look after a posting", () => {
  const found = new Map<string, number[]>();
  const books = new Map<number, BulkInboxBook>();
  let crowded: BulkInboxBook | undefined;
  /** The times of a read as the first look after a posting, one for each posting, on that book. */
  const timeOn = async (made: BulkInboxBook, read: Read, warm: number): Promise<number[]> => {
    for (let round = 0; round < warm; round += 1) await made.firstLook(read.name, read.input);
    const times: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1)
      times.push(await made.firstLook(read.name, read.input));
    return times;
  };
  const timeRead = (read: Read, journals: number, warm: number) =>
    timeOn(books.get(journals) as BulkInboxBook, read, warm);
  test("is measured on a book of 2,000 journals and one of 10,000", async () => {
    for (const { journals, lines } of SIZES) {
      // The cash account is mostly cleared, as it is in a book that is reconciled every month.
      books.set(
        journals,
        await bulkInboxBook(journals, lines, (work) => cleanup.push(work), { cleared: 0.9 }),
      );
      for (const read of READS) {
        // The first look at all is the one that makes what the read keeps, and is not timed.
        const first = typeof read.input === "function" ? read.input("bulk-1") : read.input;
        await (books.get(journals) as BulkInboxBook).call(read.name, first);
        found.set(`${read.label} ${journals}`, await timeRead(read, journals, WARM));
      }
    }
    if (LINE_READS.length > 0)
      crowded = await bulkInboxBook(2000, MANY_LINES, (work) => cleanup.push(work));
    for (const read of LINE_READS) {
      await (crowded as BulkInboxBook).call(read.name);
      found.set(`${read.label} crowded`, await timeOn(crowded as BulkInboxBook, read, WARM));
    }
    for (const { label } of READS)
      console.log(
        `${label.padEnd(20)} ${SIZES.map(({ journals }) => `${journals}: median ${median(found.get(`${label} ${journals}`) ?? []).toFixed(1)} ms`).join(", ")}`,
      );
    for (const { label } of LINE_READS)
      console.log(
        `${label.padEnd(20)} 2000 journals with 1500 lines: median ${median(found.get(`${label} 2000`) ?? []).toFixed(1)} ms, with ${MANY_LINES} lines: median ${median(found.get(`${label} crowded`) ?? []).toFixed(1)} ms`,
      );
  }, 3_600_000);

  for (const read of READS) {
    const { label } = read;
    test(`${label} costs at 10,000 journals within 1.3 times what it costs at 2,000, and under ${LIMIT_MS} ms`, async () => {
      const speed = slowness();
      let small = median(found.get(`${label} 2000`) ?? []);
      let large = median(found.get(`${label} 10000`) ?? []);
      expect(small).toBeGreaterThan(0);
      if (large > 1.3 * small + SLACK_MS * speed) {
        // Another process may have been in the way of one size: both are timed again on the same books.
        small = median(await timeRead(read, 2000, 3));
        large = median(await timeRead(read, 10000, 3));
      }
      expect(
        large,
        `${label}: ${large.toFixed(2)} ms against ${small.toFixed(2)} ms`,
      ).toBeLessThanOrEqual(1.3 * small + SLACK_MS * speed);
      const limit = LIMIT_MS * NOISE * speed;
      if (!budgetsApply()) {
        console.info(
          `${label}: ${large.toFixed(2)} ms against ${small.toFixed(2)} ms; the limit of ${limit.toFixed(1)} ms is not asserted, the machine is busy`,
        );
        return;
      }
      expect(
        large,
        `${label}: ${large.toFixed(2)} ms, the limit here ${limit.toFixed(1)} ms`,
      ).toBeLessThan(limit);
    });
  }

  for (const read of LINE_READS) {
    const { label } = read;
    test(`${label} costs with ${MANY_LINES} lines waiting in the Inbox within 1.3 times what it costs with 1,500`, async () => {
      const speed = slowness();
      let small = median(found.get(`${label} 2000`) ?? []);
      let large = median(found.get(`${label} crowded`) ?? []);
      expect(small).toBeGreaterThan(0);
      if (large > 1.3 * small + SLACK_MS * speed) {
        small = median(await timeRead(read, 2000, 3));
        large = median(await timeOn(crowded as BulkInboxBook, read, 3));
      }
      expect(
        large,
        `${label}: ${large.toFixed(2)} ms with ${MANY_LINES} lines against ${small.toFixed(2)} ms with 1,500`,
      ).toBeLessThanOrEqual(1.3 * small + SLACK_MS * speed);
    });
  }
});

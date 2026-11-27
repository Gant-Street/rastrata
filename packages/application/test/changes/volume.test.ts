/** The list on a book of 20,000 entries: that it is right at that size (every revision once, the pages
 * where they should be, the windows and filters exact) and what it costs. The book is made straight
 * through the ledger as the other volume tests make theirs, and every command is given a maker as if it
 * had been committed through the application, so that the table the list reads is as large as the book. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesCsv } from "../../src/changes/csv.ts";
import { LocalBookService } from "../../src/local.ts";
import { BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { collectChanges, listChanges } from "../../src/slices/changes/list.ts";
import { changesState } from "../../src/slices/changes/store.ts";
import { expectWithin } from "../support/budget.ts";
import { BULK_BOOK, postBulk } from "../support/bulk-book.ts";

const ENTRIES = 20_000;
let directory: string;
let service: LocalBookService;

const context = () => ({
  service,
  access: { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
  operationId: "",
});

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rastrata-changes-volume-"));
  service = await LocalBookService.open(join(directory, "book.sqlite"));
  await service.setup(BULK_BOOK);
  await postBulk(service, ENTRIES);
  // Every command was asked for by someone: the agent for the first half, the owner for the rest.
  const state = changesState(service);
  const at = "2026-04-02T12:00:00.000Z";
  service.store.transaction(() => {
    for (let n = 1; n <= ENTRIES; n += 1)
      state.recordCommit(
        `bulk-${n}`,
        n <= ENTRIES / 2
          ? { by: "agent:0123456789abcdef", operation: "inbox.post" }
          : { by: "owner", operation: "journal.post" },
        at,
      );
  });
  // The book is read once, as a person's first screen would, so that what is timed below is the list
  // and not the replay of the book.
  await service.readAggregate();
}, 300_000);

afterAll(() => {
  service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("lists every revision once, newest first, and the pages are where they should be", async () => {
  const first = await listChanges(context(), { pageSize: 200 });
  expect(first.revision).toBe(String(ENTRIES + 1));
  // The sources besides the ledger have nothing here: the book has no rules, no reconciliations and nobody with access.
  expect(first.count).toBe(ENTRIES + 1);
  expect(first.changes[0]).toMatchObject({
    revision: String(ENTRIES + 1),
    kind: "entry.posted",
    by: { kind: "owner" },
  });
  expect(first.attribution).toEqual({ fromRevision: "2", fromAt: "2026-04-02T12:00:00.000Z" });
  // A page in the middle: revisions fall one at a time from where the page begins.
  const page = 51;
  const middle = await listChanges(context(), {
    page,
    pageSize: 200,
    revision: first.revision,
    asOf: first.asOf,
  });
  expect(middle.changes.map((change) => Number(change.revision))).toEqual(
    Array.from({ length: 200 }, (_, index) => ENTRIES + 1 - (page - 1) * 200 - index),
  );
  // The last page ends with the opening of the book, which nobody recorded the maker of.
  const lastPage = Math.ceil((ENTRIES + 1) / 200);
  const last = await listChanges(context(), {
    page: lastPage,
    pageSize: 200,
    revision: first.revision,
    asOf: first.asOf,
  });
  expect(last.changes.at(-1)).toMatchObject({
    revision: "1",
    kind: "book.opened",
    by: { kind: "unknown", label: "not recorded" },
  });
});

test("windows and filters are exact at this size", async () => {
  const since = await listChanges(context(), { since: String(ENTRIES - 9), pageSize: 200 });
  expect(since.count).toBe(10);
  expect(since.window.sinceRevision).toBe(String(ENTRIES - 9));
  const agents = await listChanges(context(), { by: { kind: "agent" }, pageSize: 1 });
  expect(agents.count).toBe(ENTRIES / 2);
  const owner = await listChanges(context(), { by: { kind: "owner" }, pageSize: 1 });
  expect(owner.count).toBe(ENTRIES / 2);
  const kinds = await listChanges(context(), { kinds: ["book.opened"], pageSize: 1 });
  expect(kinds.count).toBe(1);
  const found = await listChanges(context(), { text: "Bulk journal 12345", pageSize: 5 });
  expect(found.changes.map((change) => change.entry?.description)).toEqual(["Bulk journal 12345"]);
});

test("costs milliseconds, and the whole list for a file costs seconds at most", async () => {
  const pageStart = performance.now();
  for (let round = 0; round < 5; round += 1) await listChanges(context(), { pageSize: 25 });
  const page = (performance.now() - pageStart) / 5;
  console.info(`changes.list, ${ENTRIES} entries, one page of 25: ${page.toFixed(1)} ms`);
  expectWithin("one page of the list", page, 250);

  const filterStart = performance.now();
  await listChanges(context(), { by: { kind: "agent" }, kinds: ["entry.posted"], pageSize: 25 });
  const filtered = performance.now() - filterStart;
  console.info(
    `changes.list, ${ENTRIES} entries, filtered by maker and kind: ${filtered.toFixed(1)} ms`,
  );
  expectWithin("a filtered page of the list", filtered, 400);

  const searchStart = performance.now();
  await listChanges(context(), { text: "journal 19", pageSize: 25 });
  const searched = performance.now() - searchStart;
  console.info(`changes.list, ${ENTRIES} entries, searched for text: ${searched.toFixed(1)} ms`);
  expectWithin("a search of the list", searched, 2500);

  const allStart = performance.now();
  const all = await collectChanges(context(), { since: "2026-01-01" }, { asOfRevision: true });
  const csv = changesCsv(
    {
      title: "Changes",
      book: "Bulk Co",
      currency: "USD",
      basis: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      bookRevision: all.revision,
      populationHash: "a".repeat(64),
      compilerVersion: "rastrata-changes-v1",
    },
    {
      changes: all.changes,
      sources: all.sources,
      attributionFrom: all.attribution?.fromRevision ?? null,
      from: "2026-01-01",
    },
  );
  const everything = performance.now() - allStart;
  console.info(
    `changes.csv, ${ENTRIES} entries: ${everything.toFixed(0)} ms, ${(csv.length / 1_000_000).toFixed(1)} MB`,
  );
  expect(all.changes).toHaveLength(ENTRIES + 1);
  expect(csv.length).toBeLessThan(16_000_000);
  expectWithin("the file of all the changes", everything, 8000);
}, 120_000);

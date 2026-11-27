/** The edges of the incremental report views: what they refuse, what they do not trust, and what they
 * do across a restart from a saved snapshot. The views themselves are held to account in
 * `reports-incremental.test.ts`. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookState } from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import { compileCoreReports } from "../src/reports.ts";
import { LedgerView, bookView, ledgerView, ledgerViewCounts } from "../src/reports/ledger.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";
import { failure } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { CHART } from "./support/scenario.ts";

const counted = <T>(work: () => T) => {
  const before = ledgerViewCounts();
  const value = work();
  const after = ledgerViewCounts();
  return {
    value,
    built: after.built - before.built,
    extended: after.extended - before.extended,
  };
};

describe("what a view will not be made from", () => {
  test("a book with a closing entry is refused, whether its view is made from nothing or from the one before", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    book.post("2025-01-10", [
      ["1000", 500n],
      ["4000", -500n],
    ]);
    compileCoreReports(book.state, "2025-12-31");
    expect(
      book.closeWithEntry("period-001", "2025-01-31", [
        ["4000", 500n],
        ["3000", -500n],
      ]),
    ).toBe(true);
    // A fresh identity makes a view of its own, from nothing; a report on it refuses just the same.
    const alone = { ...book.state, identity: { ...book.state.identity } } as BookState;
    for (const make of [
      () => compileCoreReports(book.state, "2025-12-31"),
      () => compileCoreReports(alone, "2025-12-31"),
      () => ledgerView(book.state),
      () => ledgerView(alone),
    ])
      expect(failure(make).code).toBe("closing_entries_unsupported");
    // The view itself is made (a reader that is not a report may use it), and says what it holds.
    expect(new LedgerView(alone).closing).toBe(true);
    expect(bookView(book.state).closing).toBe(true);
    expect(bookView(book.state)).toBe(bookView(book.state));
  });

  test("a state whose counts do not fit its history is made from nothing", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    book.post("2025-01-10", [
      ["1000", 500n],
      ["4000", -500n],
    ]);
    compileCoreReports(book.state, "2025-12-31");
    book.post("2025-01-11", [
      ["1000", 5n],
      ["4000", -5n],
    ]);
    const honest = book.state;
    // The same book with a posting sequence that is not the number of its journals, and with a
    // correction its revisions never recorded.
    const wrongSequence = { ...honest, latestPostingSequence: 99n } as BookState;
    const extraLink = {
      ...honest,
      corrections: [{ kind: "reversal", originalJournalId: "nope", correctionJournalId: "none" }],
    } as BookState;
    for (const state of [wrongSequence, extraLink]) {
      const { built, extended } = counted(() => ledgerView(state));
      expect({ built, extended }).toEqual({ built: 1, extended: 0 });
    }
    const { built, extended } = counted(() => ledgerView(honest));
    expect({ built, extended }).toEqual({ built: 0, extended: 1 });
  });
});

describe("through the service", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const work of cleanup.splice(0)) work();
  });

  test("a report after a posting extends the view the last read made, and does so after a restart from a snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rastrata-reports-incremental-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "book.sqlite");
    let service = await LocalBookService.open(path);
    await service.setup(BULK_BOOK);
    await postBulk(service, 40);
    const asOf = "2026-12-31";
    await service.reports(asOf);

    const before = ledgerViewCounts();
    await postBulk(service, 1);
    const afterOne = await service.reports(asOf);
    const during = ledgerViewCounts();
    expect(during.built - before.built).toBe(0);
    expect(during.extended - before.extended).toBe(1);
    // The same figures as a view made from nothing says, for the same state.
    const { aggregate } = await service.readAggregate();
    const fresh = { ...aggregate.state, identity: { ...aggregate.state.identity } } as BookState;
    expect(afterOne).toEqual(compileCoreReports(fresh, asOf));
    service.close();

    // A restart reads the snapshot the close saved: a state with a new identity, so a view from
    // nothing, and the postings after it extend that.
    service = await LocalBookService.open(path);
    cleanup.push(() => service.close());
    const restarted = ledgerViewCounts();
    const first = await service.reports(asOf);
    expect(first).toEqual(afterOne);
    expect(service.readStats.snapshot).toBe(1);
    await postBulk(service, 2);
    const more = await service.reports(asOf);
    const finished = ledgerViewCounts();
    expect(finished.built - restarted.built).toBe(1);
    expect(finished.extended - restarted.extended).toBe(1);
    const { aggregate: latest } = await service.readAggregate();
    const again = { ...latest.state, identity: { ...latest.state.identity } } as BookState;
    expect(more).toEqual(compileCoreReports(again, asOf));
  });
});

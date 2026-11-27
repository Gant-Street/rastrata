import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookHistoryMaterializations } from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";

// A state the kernel builds keeps its journals, revisions and retained results in one shared store and
// copies them into frozen arrays only when somebody reads `state.journals`, `state.revisions` or
// `protocol.retainedResults`. The copy costs 50 to 130 ns an element, so a replay that read any of them
// after each command would be quadratic again. These tests turn that into a failure, not a slowdown.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

async function openBulkBook() {
  const path = mkdtempSync(join(tmpdir(), "rastrata-replay-history-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  const service = await LocalBookService.open(join(path, "book.sqlite"));
  cleanup.push(() => service.close());
  await service.setup(BULK_BOOK);
  return service;
}

test("a full replay verifies every outcome without copying the history into arrays", async () => {
  const service = await openBulkBook();
  await postBulk(service, 80);
  const before = bookHistoryMaterializations();
  const { aggregate } = await service.readAggregate(undefined, { verify: "full" });
  expect(service.readStats.verified).toBeGreaterThanOrEqual(81);
  // One copy, at the end: the kernel's own rebuild of the balances, which a full verification compares with
  // the ones carried through the replay, takes the list of revisions. The replay reads none of them per command.
  expect(bookHistoryMaterializations()).toBe(before + 1);
  // Reading the lists is what pays, once each (the revisions were copied for the rebuild already).
  expect(aggregate.state.journals).toHaveLength(80);
  expect(aggregate.state.revisions).toHaveLength(Number(aggregate.state.bookRevision));
  expect(aggregate.protocol.retainedResults).toHaveLength(Number(aggregate.state.bookRevision));
  expect(bookHistoryMaterializations()).toBe(before + 3);
});

test("an incremental read of newer outcomes does not copy the history either", async () => {
  const service = await openBulkBook();
  await postBulk(service, 20);
  await service.readAggregate();
  await postBulk(service, 15);
  const before = bookHistoryMaterializations();
  const { aggregate } = await service.readAggregate();
  expect(service.readStats.incremental).toBeGreaterThanOrEqual(1);
  expect(bookHistoryMaterializations()).toBe(before);
  expect(aggregate.state.journals).toHaveLength(35);
});

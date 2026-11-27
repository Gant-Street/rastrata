/** `ledgerHead()` says where the ledger ends without decoding the first page of the book, and says the same
 * thing the page read does, whether or not the service has read the book and however far the ledger has
 * moved since. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

test("the head is the page read's tip before the book is read, after it, and after the ledger moves on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rastrata-head-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const service = await LocalBookService.open(join(dir, "book.sqlite"));
  cleanup.push(() => service.close());
  await service.setup(BULK_BOOK);
  await postBulk(service, 40);
  const tip = async () => (await service.outcomePage()).observedTip;

  // The service has not read the book yet (postBulk reads only to sign): from the start.
  expect(await service.ledgerHead()).toEqual(await tip());
  await service.readAggregate();
  expect(await service.ledgerHead()).toEqual(await tip());
  // The ledger moves on without the service reading it, by one entry and by more than a page (sixteen).
  await postBulk(service, 1);
  expect(await service.ledgerHead()).toEqual(await tip());
  const moved = (await service.ledgerHead()).sequence;
  await postBulk(service, 40);
  const head = await service.ledgerHead();
  expect(head).toEqual(await tip());
  expect(Number(head.sequence)).toBe(Number(moved) + 40);
});

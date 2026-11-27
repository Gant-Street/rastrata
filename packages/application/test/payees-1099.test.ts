/** The 1099 totals do not move when vendors become payees.
 *
 * The golden file was made from the acceptance month's book (see `payees-support.ts`) by the code that
 * stood before payees existed: every vendor, total, flag, sentence and file the 1099 screens and the
 * year-end pack are built from. These tests read the same book through the code as it is now and
 * require the same bytes. They are a permanent guard: a change to what the 1099 says fails here, and
 * the golden is made again only by a person who has decided it should say something else
 * (`UPDATE_GOLDEN=1 bun test test/payees-1099.test.ts`, then `bun run format`). */
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { World } from "./acceptance/world.ts";
import { bookTheMonth, capture1099 } from "./payees-support.ts";

const GOLDEN = new URL("./fixtures/payees-1099-golden.json", import.meta.url).pathname;

const open: World[] = [];
afterEach(async () => {
  for (const world of open.splice(0)) await world.close();
});

test("the 1099 totals, files and details of the acceptance book are what they were", async () => {
  const book = await bookTheMonth();
  open.push(book.world);
  const capture = JSON.parse(JSON.stringify(await capture1099(book)));
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN, `${JSON.stringify(capture, null, 2)}\n`);
    return;
  }
  expect(capture).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
}, 60_000);

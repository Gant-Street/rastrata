import { afterEach, expect, test } from "bun:test";
import { runFiveYears, timingLine } from "./support/five-years.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

// The one replay of the freshly built book costs about a millisecond a journal (it was quadratic before the
// chain-head state commitment: 3 s at 300 journals, 8 s at 500 and 21 s at 800). This book is five hundred;
// the same scenario with thousands runs under `bun run test:slow` (see slow/).
const JOURNALS = Number(process.env.RASTRATA_FIVE_YEAR_JOURNALS ?? "500");

test("a book of five fiscal years posts, reports, closes and reopens across year boundaries", async () => {
  const result = await runFiveYears(JOURNALS, (work) => cleanup.push(work), {
    operationMs: 30_000,
  });
  expect(result.journals).toBe(JOURNALS + 5);
  console.log(timingLine(result));
}, 240_000);

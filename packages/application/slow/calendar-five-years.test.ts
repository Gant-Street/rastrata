import { afterEach, expect, test } from "bun:test";
import { runFiveYears, timingLine } from "../test/support/five-years.ts";

// The scenario of test/calendar-five-years.test.ts at the size a small business reaches in a few
// years: thousands of journals across five fiscal years. The first read of the freshly built book is one
// replay, about a millisecond a journal (it was quadratic, and took minutes, before the chain-head state
// commitment); everything after it is incremental. Run it with `bun run --cwd packages/application
// test:slow` when the machine is quiet, and record the printed line in docs/reference/program/calendar.md.
const JOURNALS = Number(process.env.RASTRATA_FIVE_YEAR_JOURNALS ?? "3000");

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

test(`a book of ${JOURNALS} journals over five fiscal years closes year by year`, async () => {
  const result = await runFiveYears(JOURNALS, (work) => cleanup.push(work), {
    // A year-end is thirty-odd kernel commands, each linear in the journals: seconds, not minutes.
    operationMs: 120_000,
  });
  expect(result.journals).toBe(JOURNALS + 5);
  console.log(timingLine(result));
}, 3_600_000);

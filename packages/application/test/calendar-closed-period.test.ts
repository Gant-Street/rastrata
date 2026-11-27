import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture } from "./calendar-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

/** March 2026 is closed, and the clock stands in April. */
async function closedMarch() {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 3, 10, 12, 0, 0),
  });
  await f.setup(baseSetup);
  await f.postOk("2026-03-10", "100.00", ["1000", "4000"], "SALE");
  const closed = await f.prepareCommit("periods.prepare", {
    periodId: "period-03",
    operation: "close",
    reason: "Reviewed",
  });
  expect(closed.receipt?.body.data.disposition).toBe("committed");
  return f;
}

const REOPEN = 'Reopen March 2026 first (periods.prepare with operation "reopen")';

test("an entry dated in a closed month is refused with the month, its dates and the way forward", async () => {
  const f = await closedMarch();
  const posted = await f.post("2026-03-20", "10.00", ["1000", "4000"], "LATE");
  expect(posted.plan.ok).toBe(true);
  expect(posted.plan.data.valid).toBe(false);
  // The kernel's code stays, so whatever branches on it still can; the words are for people.
  const [problem] = posted.plan.data.problems;
  expect(problem.code).toBe("fiscal_period_admission");
  expect(problem.message).toContain("March 2026 (2026-03-01 to 2026-03-31) is closed");
  expect(problem.message).toContain("nothing can be posted into it");
  expect(problem.message).toContain(REOPEN);
  expect(problem.message).not.toContain("period-03");
  expect(posted.plan.data.diagnostics[0]).toBe(problem.message);
});

test("reversing an entry that sits in a closed month says which month, and an open month is untouched", async () => {
  const f = await closedMarch();
  const posted = (await f.call("journal.list", { status: "Posted" })).body.data.entries[0];
  const refused = (
    await f.call(
      "journal.prepareReverse",
      { journalId: posted.id, accountingDate: "2026-04-02", reason: "Probe" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(refused.valid).toBe(false);
  const [problem] = refused.problems;
  expect(problem.code).toBe("fiscal_period_admission");
  expect(problem.message).toContain(
    "The entry is dated 2026-03-10, in March 2026 (2026-03-01 to 2026-03-31), which is closed",
  );
  expect(problem.message).toContain(REOPEN);
  // An entry in an open month reverses without a word.
  const april = await f.postOk("2026-04-05", "20.00", ["1000", "4000"], "APR");
  const fine = (
    await f.call(
      "journal.prepareReverse",
      { journalId: april, accountingDate: "2026-04-06", reason: "Probe" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(fine.valid).toBe(true);
});

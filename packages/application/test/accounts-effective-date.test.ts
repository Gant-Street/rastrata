import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture } from "./calendar-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

test("an account dated on or before the latest entry is refused with the date to use instead", async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 3, 10, 12, 0, 0),
  });
  await f.setup(baseSetup);
  await f.postOk("2026-03-10", "100.00", ["1000", "4000"], "SALE");
  const suggested = (await f.call("accounts.list")).body.data.suggestedEffectiveOn as string;
  expect(suggested).toBe("2026-03-11");
  const prepare = async (effectiveOn: string) =>
    (
      await f.call(
        "accounts.prepareCreate",
        { code: "6296", name: "Late account", role: "expense", effectiveOn },
        crypto.randomUUID(),
      )
    ).body.data;
  for (const date of ["2026-03-01", "2026-03-10"]) {
    const refused = await prepare(date);
    expect(refused.valid, date).toBe(false);
    // The ledger's code stays; the words say which date the books are at and which to use.
    const [problem] = refused.problems;
    expect(problem.code).toBe("fiscal_period_admission");
    expect(problem.message).toContain("dated 2026-03-10");
    expect(problem.message).toContain(`Use ${suggested} or later`);
    expect(problem.message).not.toContain("Configuration evolution");
  }
  // The day after the latest entry, the date the Accounts screen suggests, is accepted.
  expect((await prepare(suggested)).valid).toBe(true);
});

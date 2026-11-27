/** The first step of the catch-all lane: the riskiest thing it assumes is that fifty posted transactions can
 * be moved to another account by a request that is killed in the middle and sent again, and that every
 * run, resumed, ends with each transaction posted once to the new account, the original and its reversal
 * both in the books, nothing twice, and the plan that was shown equal to what was done.
 *
 * "Killed" here is a throw from between two steps (`onMoveStep`) followed by closing the service and
 * opening the book again from its file, so nothing a dead process held in memory survives. The same is
 * done with a real SIGKILL in `entries-recategorize-sigkill.test.ts`. The pass rule is in
 * `docs/reference/program/catchall.md`. */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { type MoveStep, onMoveStep } from "../src/slices/entries/recategorize.ts";
import { closeFixtures, type Fixture } from "./support/ingest-fixture.ts";
import { TO, act, before, expectMovedOnce, postedBook, reopen, uuid } from "./support/move-book.ts";

// Each test here posts, kills and reopens whole books. It takes a second or two on a quiet machine and
// went past the default five on a busy runner (8.5 s, 2026-11-07), so the limit is what a loaded one needs.
setDefaultTimeout(60_000);

afterEach(() => closeFixtures());

const COUNT = 50;

class Killed extends Error {}

/** The throw that stands for the process dying, at the `nth` time a step is reached. */
function dieAt(f: Fixture, when: "before" | "after", step: MoveStep, nth: number): () => number {
  let reached = 0;
  onMoveStep(f.service, (at, what) => {
    if (at !== when || what !== step) return;
    reached += 1;
    if (reached === nth) throw new Killed(`killed ${when} ${step} of transaction ${nth}`);
  });
  return () => reached;
}

const STEPS: readonly MoveStep[] = ["reverse", "return", "categorize", "post"];
const POINTS = STEPS.flatMap((step) =>
  (["before", "after"] as const).map((when) => ({ when, step })),
);

for (const { when, step } of POINTS) {
  test(`fifty transactions moved with the process killed ${when} the ${step} step of the 17th, then sent again, end posted once on the new account`, async () => {
    const { f, ids } = await postedBook(COUNT);
    const start = await before(f, ids);
    const input = { itemIds: ids, accountId: TO, reason: "Software, not meals" };
    const operationId = uuid();
    const reached = dieAt(f, when, step, 17);

    const killed = await f.call("inbox.recategorize", input, operationId);
    // The request did not finish: it is open under its identity, and says so.
    expect(killed.body.ok).toBe(false);
    expect(killed.status).toBe(503);
    expect(killed.body.error.code).toBe("operation_unresolved");
    expect(reached()).toBe(17);
    // Sixteen are done and the seventeenth is where it was left: seventeen are in hand.
    expect(
      f.service.store
        .query("SELECT COUNT(*) AS n FROM entries_moves WHERE operation_id=?")
        .get(operationId),
    ).toEqual({ n: 17 });

    // The process dies: nothing it held in memory survives, only the file.
    await reopen(f);
    const done = await act(f, "inbox.recategorize", input, operationId);
    await expectMovedOnce(f, ids, start, done);

    // And once more: the answer is the first answer, and nothing is moved again.
    const again = await act(f, "inbox.recategorize", input, operationId);
    expect(again).toEqual(done);
    expect((await f.service.readAggregate()).aggregate.state.journals).toHaveLength(COUNT * 3);
  });
}

test("a request sent again in the same process after being cut short carries on the same way", async () => {
  const { f, ids } = await postedBook(COUNT);
  const start = await before(f, ids);
  const input = { itemIds: ids, accountId: TO };
  const operationId = uuid();
  dieAt(f, "after", "categorize", 30);
  const killed = await f.call("inbox.recategorize", input, operationId);
  expect(killed.status).toBe(503);
  onMoveStep(f.service, null);
  const done = await act(f, "inbox.recategorize", input, operationId);
  await expectMovedOnce(f, ids, start, done);
});

test("a request killed on the first transaction and on the last is carried on from there", async () => {
  for (const [when, step, nth] of [
    ["before", "reverse", 1],
    ["after", "post", COUNT],
  ] as const) {
    const { f, ids } = await postedBook(COUNT);
    const start = await before(f, ids);
    const input = { itemIds: ids, accountId: TO };
    const operationId = uuid();
    dieAt(f, when, step, nth);
    expect((await f.call("inbox.recategorize", input, operationId)).status).toBe(503);
    await reopen(f);
    await expectMovedOnce(f, ids, start, await act(f, "inbox.recategorize", input, operationId));
    closeFixtures();
  }
});

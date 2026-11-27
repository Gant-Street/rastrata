/** What a change of account does when things go wrong in the middle: the books turn a step down, the
 * ledger's reply is lost, two requests meet the same transaction. The rule in each: the books are never
 * edited, nothing is booked twice, the transaction is left where a person will see it, and the result says
 * which. */
import { afterEach, expect, test } from "bun:test";
import { onMoveStep } from "../src/slices/entries/recategorize.ts";
import { closeFixtures, type Fixture, itemRows, type Json } from "./support/ingest-fixture.ts";
import {
  FROM,
  TO,
  act,
  balances,
  changeMonth,
  importLines,
  item,
  journalCount,
  postLine,
  uuid,
} from "./support/move-book.ts";
import { ingestFixture } from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

const move = (f: Fixture, input: Record<string, unknown>, operationId = uuid()) =>
  f.call("inbox.recategorize", input, operationId);

async function twoPosted(f: Fixture): Promise<{ ids: string[]; journals: string[] }> {
  const a = await postLine(f, { date: "2026-03-02", amount: "-25.00", description: "FIRST" });
  const b = await postLine(f, { date: "2026-03-03", amount: "-40.50", description: "SECOND" });
  return { ids: [a.id, b.id], journals: [a.journalId, b.journalId] };
}

test("a month that closes between the assessment and the reversal refuses it: nothing changes, and the result says so", async () => {
  const f = await ingestFixture();
  const { ids } = await twoPosted(f);
  const entries = await journalCount(f);
  await changeMonth(f, "period-03", "close");
  // The assessment reads the books as they are, so it already says the month is closed.
  const closed = await act(f, "inbox.recategorize", { itemIds: ids, accountId: TO });
  expect(closed).toMatchObject({ applied: 0, skipped: 2, failed: 0 });
  expect(await journalCount(f)).toBe(entries);

  // The race itself: the month closes after the call read the books and before it reversed an entry.
  await changeMonth(f, "period-03", "reopen");
  let fired = false;
  onMoveStep(f.service, async (when, step) => {
    if (when !== "before" || step !== "reverse" || fired) return;
    fired = true;
    await changeMonth(f, "period-03", "close");
  });
  const raced = await act(f, "inbox.recategorize", { itemIds: ids, accountId: TO });
  // The books have the last word, with their own code and words, for every transaction the call reached.
  expect(raced).toMatchObject({ applied: 0, failed: 2 });
  for (const result of raced.results) {
    expect(result).toMatchObject({
      outcome: "failed",
      code: "fiscal_period_admission",
      status: "posted",
    });
    expect(result.message).toContain("which is closed");
    expect(result.reversalJournalId).toBeUndefined();
  }
  expect(await journalCount(f)).toBe(entries);
  expect(await balances(f)).toMatchObject({ [FROM]: "65.50", [TO]: "0.00" });
  for (const id of ids) expect((await item(f, id)).item.status).toBe("posted");
});

test("a posting the books turn down leaves the transaction ready to post in For review, and posting it there finishes the move", async () => {
  const f = await ingestFixture();
  const { ids } = await twoPosted(f);
  const [first] = ids as [string, string];
  let fired = false;
  onMoveStep(f.service, async (when, step) => {
    if (when !== "after" || step !== "categorize" || fired) return;
    fired = true;
    await changeMonth(f, "period-03", "close");
  });
  const report = await act(f, "inbox.recategorize", { itemIds: [first], accountId: TO });
  expect(report).toMatchObject({ applied: 0, failed: 1, remaining: 0 });
  const [result] = report.results as Json[];
  expect(result).toMatchObject({ outcome: "failed", status: "drafted", fromAccountId: FROM });
  expect(typeof result?.reversalJournalId).toBe("string");
  expect(result?.message).toContain("The old entry was reversed, but the new entry was not posted");
  expect(result?.message).toContain("The transaction is ready to post.");
  // The books keep what was done: the original and its reversal, and no new entry. The money is on no
  // account until the transaction is posted again, and the transaction is where a person sees it.
  expect(await journalCount(f)).toBe(3);
  expect(await balances(f)).toMatchObject({ [FROM]: "40.50", [TO]: "0.00", "1000": "-40.50" });
  const detail = await item(f, first);
  expect(detail.item.status).toBe("drafted");
  expect(detail.item.postError).toBeTruthy();

  // The month is reopened and the draft is posted: the move is finished the ordinary way.
  await changeMonth(f, "period-03", "reopen");
  const posted = await act(f, "inbox.post", { itemIds: [first] });
  expect(posted).toMatchObject({ applied: 1, failed: 0 });
  expect(await journalCount(f)).toBe(4);
  expect(await balances(f)).toMatchObject({ [FROM]: "40.50", [TO]: "25.00", "1000": "-65.50" });
  expect((await item(f, first)).item.status).toBe("posted");
});

/** Make the nth command this service commits under `inbox.recategorize` answer as if the connection
 * dropped after the ledger had taken it. */
function dropReplyOfCommit(f: Fixture, nth: number): void {
  const real = f.service.commitAction.bind(f.service);
  let seen = 0;
  Object.defineProperty(f.service, "commitAction", {
    configurable: true,
    value: async (...args: Parameters<typeof real>) => {
      const receipt = await real(...args);
      if (args[2]?.operation === "inbox.recategorize" && ++seen === nth)
        throw new Error("the connection dropped after the ledger took the command");
      return receipt;
    },
  });
}

for (const [step, nth] of [
  ["a reversal", 1],
  ["a posting", 2],
] as const) {
  test(`when the reply to ${step} is lost the request is left open, and sent again it carries on and books nothing twice`, async () => {
    const f = await ingestFixture();
    const { ids, journals } = await twoPosted(f);
    const input = { itemIds: ids, accountId: TO };
    const operationId = uuid();
    dropReplyOfCommit(f, nth);

    const lost = await move(f, input, operationId);
    expect(lost.status).toBe(503);
    expect(lost.body.error).toMatchObject({ code: "operation_unresolved", retryable: true });
    expect(lost.body.error.message).toContain("Send the same request again");
    // The books took it: the reply is what was lost.
    expect(await journalCount(f)).toBeGreaterThan(2);

    const done = await act(f, "inbox.recategorize", input, operationId);
    expect(done).toMatchObject({ applied: 2, skipped: 0, failed: 0, remaining: 0 });
    expect(await journalCount(f)).toBe(6);
    expect(await balances(f)).toMatchObject({ [FROM]: "0.00", [TO]: "65.50", "1000": "-65.50" });
    const state = (await f.service.readAggregate()).aggregate.state;
    expect(state.corrections.map((link) => link.originalJournalId).sort()).toEqual(
      [...journals].sort(),
    );
    for (const id of ids)
      expect(
        (await item(f, id)).history.map((event: Json) => event.kind),
        id,
      ).toEqual(["categorize", "post", "undo", "categorize", "post"]);
  });
}

test("two requests for the same transactions at once move each of them once", async () => {
  const f = await ingestFixture();
  const lines = Array.from({ length: 6 }, (_, index) => ({
    date: `2026-03-${String(index + 2).padStart(2, "0")}`,
    amount: `-${10 + index}.00`,
    description: `BOTH ${index}`,
  }));
  const ids = importLines(f, lines);
  await act(f, "inbox.categorize", { itemIds: ids, accountId: FROM });
  await act(f, "inbox.post", { itemIds: ids, limit: 100 });
  const input = { itemIds: ids, accountId: TO };

  const [one, two] = await Promise.all([move(f, input), move(f, input)]);
  expect(one.body.ok, JSON.stringify(one.body)).toBe(true);
  expect(two.body.ok, JSON.stringify(two.body)).toBe(true);
  // Whichever got to a transaction first, it is on the new account once, with one reversal and one new entry.
  expect(await journalCount(f)).toBe(18);
  expect(await balances(f)).toMatchObject({ [FROM]: "0.00", [TO]: "75.00", "1000": "-75.00" });
  const state = (await f.service.readAggregate()).aggregate.state;
  expect(state.corrections).toHaveLength(6);
  for (const id of ids) {
    expect(itemRows(f, `id='${id}'`)[0]).toMatchObject({ status: "posted", source_generation: 1 });
  }
  // Neither request lost a transaction: each says where every one of them ended up.
  for (const reply of [one, two])
    expect(
      reply.body.data.results.filter((r: Json) => r.outcome === "applied").length +
        reply.body.data.results.filter((r: Json) => r.outcome === "skipped").length,
    ).toBe(6);
});

test("a transaction undone or moved by something else while a move is under way is left to it", async () => {
  const f = await ingestFixture();
  const { ids } = await twoPosted(f);
  const [first] = ids as [string, string];
  // Between the reversal and the categorization of the first, someone categorizes it elsewhere.
  onMoveStep(f.service, async (when, step, itemId) => {
    if (when === "after" && step === "return" && itemId === first) {
      onMoveStep(f.service, null);
      await act(f, "inbox.categorize", { itemIds: [first], accountId: "5200" });
    }
  });
  const report = await act(f, "inbox.recategorize", { itemIds: ids, accountId: TO });
  expect(report.results[0]).toMatchObject({
    outcome: "failed",
    code: "changed",
    status: "drafted",
  });
  expect(report.results[0].message).toContain("categorized to another account");
  expect(report.results[1]).toMatchObject({ outcome: "applied" });
  // It is where they put it: drafted, to be posted by them; the books hold the original and its reversal.
  expect((await item(f, first)).item.status).toBe("drafted");
  const posted = await act(f, "inbox.post", { itemIds: [first] });
  expect(posted.results[0]).toMatchObject({ outcome: "applied" });
  expect(await balances(f)).toMatchObject({ [FROM]: "0.00", "5200": "25.00", [TO]: "40.50" });
});

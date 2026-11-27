/** A book with posted transactions to move, and what must be true of it after they were moved. Test
 * support for the catch-all lane's change of account. */
import { expect } from "bun:test";
import { ingestRuntime } from "../../src/slices/ingest/store.ts";
import {
  batchOf,
  type Fixture,
  ingestFixture,
  itemRows,
  type Json,
  type LineInit,
} from "./ingest-fixture.ts";

export const FROM = "5000";
export const TO = "5100";

export const uuid = () => crypto.randomUUID();

export const money = (cents: number): string =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
/** Different amounts, so no two transactions look alike. */
export const cents = (index: number): number => 1_000 + index * 137;

export async function act(
  f: Fixture,
  name: string,
  input: unknown,
  operationId = uuid(),
): Promise<Json> {
  const reply = await f.call(name, input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
}

/** How long one request may go on moving or posting before it stops and says what remains. The product's is five
 * seconds; these tests move fifty transactions in one request and count them, so theirs is ten minutes. */
const BUDGET_MS = Number(process.env.RASTRATA_TEST_MOVE_BUDGET_MS ?? 600_000);

/** The book closed and opened again from its file, as after the process died. A service that is opened again
 * has the product's own budget, not the one this fixture gave the first: on a loaded runner the request sent
 * again then stopped at five seconds with "applied 41" of 50 and nine remaining, which is the product working
 * and the test failing (the Tests workflow, 2026-11-18). So the budget is given again. */
export async function reopen(f: Fixture): Promise<void> {
  await f.restart();
  ingestRuntime(f.service).postBudgetMs = BUDGET_MS;
}

/** A book with `count` transactions from the bank (account 1000), categorized to Software and posted. */
export async function postedBook(count: number): Promise<{ f: Fixture; ids: string[] }> {
  const f = await ingestFixture();
  ingestRuntime(f.service).postBudgetMs = BUDGET_MS;
  const lines = Array.from({ length: count }, (_, index) => ({
    date: `2026-03-${String((index % 28) + 1).padStart(2, "0")}`,
    amount: `-${money(cents(index))}`,
    description: `VENDOR ${index + 1} MONTHLY`,
  }));
  const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000" }));
  const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
  expect(ids).toHaveLength(count);
  await act(f, "inbox.categorize", { itemIds: ids, accountId: FROM });
  for (let remaining = count; remaining > 0; ) {
    const posted = await act(f, "inbox.post", { itemIds: ids, limit: 100 });
    remaining = posted.remaining;
  }
  return { f, ids };
}

export interface Before {
  readonly journalOf: Map<string, string>;
  readonly plan: { itemId: string; from: string; to: string }[];
}

/** What is in the books before the move, and the plan the move will be held to. */
export async function before(f: Fixture, ids: readonly string[]): Promise<Before> {
  const journalOf = new Map<string, string>();
  for (const row of itemRows(f)) journalOf.set(row.id as string, row.journal_id as string);
  const shown = await act(f, "inbox.recategorize", { itemIds: ids, accountId: TO, dryRun: true });
  expect(shown).toMatchObject({
    dryRun: true,
    would: ids.length,
    applied: 0,
    skipped: 0,
    failed: 0,
  });
  return {
    journalOf,
    plan: shown.results.map((item: Json) => ({
      itemId: item.itemId,
      from: item.fromAccountId,
      to: item.toAccountId,
    })),
  };
}

/** The books and the Inbox after the move: every transaction on the new account once, nothing twice. */
export async function expectMovedOnce(
  f: Fixture,
  ids: readonly string[],
  start: Before,
  done: Json,
): Promise<void> {
  const count = ids.length;
  // The plan that was shown is what was done: the same transactions, in the same order, from and to
  // the same accounts.
  expect(done).toMatchObject({
    dryRun: false,
    applied: count,
    skipped: 0,
    failed: 0,
    remaining: 0,
  });
  expect(
    done.results.map((item: Json) => ({
      itemId: item.itemId,
      from: item.fromAccountId,
      to: item.toAccountId,
    })),
  ).toEqual(start.plan);
  expect(done.results.every((item: Json) => item.outcome === "applied")).toBe(true);

  const state = (await f.service.readAggregate()).aggregate.state;
  // The entries, their reversals and the new entries: nothing was edited or deleted, nothing is twice.
  expect(state.journals).toHaveLength(count * 3);
  const reversals = state.corrections.filter((link) => link.kind === "reversal");
  expect(reversals).toHaveLength(count);
  expect(state.corrections).toHaveLength(count);
  expect(new Set(reversals.map((link) => link.originalJournalId)).size).toBe(count);
  expect(new Set(reversals.map((link) => link.correctionJournalId)).size).toBe(count);

  const rows = new Map(itemRows(f).map((row) => [row.id as string, row]));
  const newJournals = new Set<string>();
  for (const [index, id] of ids.entries()) {
    const row = rows.get(id);
    if (!row) throw new Error(`the line ${id} is gone`);
    expect(row.status, id).toBe("posted");
    expect(row.source_generation, id).toBe(1);
    const original = start.journalOf.get(id) as string;
    // The original is still there, reversed; the new entry is another entry.
    expect(row.journal_id).not.toBe(original);
    newJournals.add(row.journal_id as string);
    expect(reversals.some((link) => link.originalJournalId === original)).toBe(true);
    const booked = state.journals.find((entry) => entry.journal.id === row.journal_id);
    if (!booked) throw new Error(`the new entry of ${id} is not in the books`);
    const byAccount = new Map(
      booked.journal.postings.map((posting) => [
        posting.accountId as string,
        posting.bookValue.amount.coefficient,
      ]),
    );
    expect(byAccount.get(TO), id).toBe(BigInt(cents(index)));
    expect(byAccount.get("1000"), id).toBe(-BigInt(cents(index)));
    expect(byAccount.size).toBe(2);
    const detail = (await f.call("inbox.get", { itemId: id })).body.data;
    expect(detail.provenance.sourceEventId).toMatch(/-r1$/);
    // What was done to the line, once each: posted, taken back, categorized, posted.
    expect(
      detail.history.map((event: Json) => event.kind),
      id,
    ).toEqual(["categorize", "post", "undo", "categorize", "post"]);
  }
  expect(newJournals.size).toBe(count);

  // The accounts: the old one is empty, the new one holds everything, the bank is as it was.
  const total = Array.from({ length: count }, (_, index) => cents(index)).reduce(
    (a, b) => a + b,
    0,
  );
  const chart = (await f.call("accounts.list", {})).body.data.accounts as Json[];
  const balance = (code: string) => chart.find((account) => account.code === code)?.balance;
  expect(balance(FROM)).toBe("0.00");
  expect(balance(TO)).toBe(money(total));
  expect(balance("1000")).toBe(`-${money(total)}`);

  // Who moved it is on record for both commands of every transaction.
  const commits = f.service.store
    .query(
      "SELECT operation, principal, COUNT(*) AS n FROM changes_commits GROUP BY operation, principal",
    )
    .all() as { operation: string; principal: string; n: number }[];
  const moved = commits.find((row) => row.operation === "inbox.recategorize");
  expect(moved).toMatchObject({ principal: "owner", n: count * 2 });
}

// ---------------------------------------------------------------------------------------------
// small books for the rules of a move

/** Import lines into the checking account (1000) and return the ids of the new items. */
export function importLines(f: Fixture, lines: readonly LineInit[], extra = {}): string[] {
  const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000", ...extra }));
  return report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
}

export const NOTION: LineInit = {
  date: "2026-03-02",
  amount: "-25.00",
  description: "NOTION LABS",
};

/** Import one line, categorize it and post it. Returns its item id and the id of its entry. */
export async function postLine(
  f: Fixture,
  line: LineInit = NOTION,
  accountId = FROM,
): Promise<{ id: string; journalId: string }> {
  const [id] = importLines(f, [line]) as [string];
  await act(f, "inbox.categorize", { itemIds: [id], accountId });
  const posted = await act(f, "inbox.post", { itemIds: [id] });
  expect(posted.results[0], JSON.stringify(posted)).toMatchObject({
    outcome: "applied",
    status: "posted",
  });
  return { id, journalId: posted.results[0].journalId as string };
}

/** Every account's balance by id, as the chart shows it. */
export async function balances(f: Fixture): Promise<Record<string, string>> {
  const chart = (await f.call("accounts.list", {})).body.data.accounts as Json[];
  return Object.fromEntries(chart.map((account) => [account.id, account.balance]));
}

/** Entries in the books (a draft that has not been posted is not one). */
export const journalCount = async (f: Fixture): Promise<number> =>
  (await f.call("journal.list", { status: "Posted" })).body.data.count;

export const item = async (f: Fixture, itemId: string): Promise<Json> =>
  (await f.call("inbox.get", { itemId })).body.data;

/** Close or reopen one month through the ordinary prepare and commit path. */
export async function changeMonth(f: Fixture, periodId: string, operation: "close" | "reopen") {
  const prepared = await act(f, "periods.prepare", { periodId, operation, reason: "Reviewed" });
  const receipt = await f.call("operations.commit", {
    planId: prepared.planId,
    planHash: prepared.planHash,
  });
  expect(receipt.body.data.disposition, JSON.stringify(receipt.body)).toBe("committed");
}

/** Close an account from a date, through the ordinary prepare and commit path. */
export async function closeAccount(
  f: Fixture,
  accountId: string,
  name: string,
  effectiveOn: string,
) {
  const closing = await act(f, "accounts.prepareChange", {
    accountId,
    name,
    close: true,
    effectiveOn,
  });
  const receipt = await f.call("operations.commit", {
    planId: closing.planId,
    planHash: closing.planHash,
  });
  expect(receipt.body.data.disposition, JSON.stringify(receipt.body)).toBe("committed");
}

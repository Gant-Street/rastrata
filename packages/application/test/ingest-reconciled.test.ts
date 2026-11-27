import { afterEach, expect, test } from "bun:test";
import { reconciledLines } from "../src/slices/ingest/reconciled.ts";
import type { ItemRow } from "../src/slices/ingest/store.ts";
import {
  batchOf,
  closeFixtures,
  ingestFixture,
  postManual,
  type Fixture,
  type Json,
} from "./support/ingest-fixture.ts";

afterEach(closeFixtures);

const act = async (f: Fixture, name: string, input: unknown) => {
  const reply = await f.call(name, input, crypto.randomUUID());
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};

/** Every posted line, oldest first, as the Inbox lists them. */
const posted = async (f: Fixture): Promise<Json[]> => {
  const reply = await f.call("inbox.list", { filter: { status: ["posted"] }, sort: "date_asc" });
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data.items as Json[];
};

/** Reconcile an account to a statement by taking every line, and finish it. */
async function reconcile(
  f: Fixture,
  accountId: string,
  statementDate: string,
  statementBalance: string,
): Promise<Json> {
  const draft = await act(f, "reconcile.start", { accountId, statementDate, statementBalance });
  const all = await act(f, "reconcile.setCleared", {
    id: draft.id,
    expectedVersion: draft.version,
    reset: "all",
  });
  expect(all.canComplete, JSON.stringify(all)).toBe(true);
  return act(f, "reconcile.complete", { id: draft.id, expectedVersion: all.version });
}

test("a posted line says it is reconciled once a completed reconciliation has it, and stops when that is voided", async () => {
  const f = await ingestFixture();
  const report = f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-03-02", amount: "100.00", description: "CLIENT A" },
        { date: "2026-03-20", amount: "50.00", description: "CLIENT B" },
        { date: "2026-04-10", amount: "25.00", description: "CLIENT C" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  const ids = report.dispositions.map((line) => line.itemId as string);
  await act(f, "inbox.categorize", { itemIds: ids, accountId: "4000" });
  // Drafted is not posted: there is no posting to be on a statement yet.
  const drafted = (await f.call("inbox.list", { filter: { status: ["drafted"] } })).body.data;
  expect(drafted.items).toHaveLength(3);
  for (const item of drafted.items) expect(item.reconciled).toBeUndefined();
  await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  const before = await posted(f);
  expect(before).toHaveLength(3);
  for (const item of before) expect(item.reconciled, item.line.description).toBeUndefined();

  // March is reconciled to its statement; the April line is on no statement yet.
  const record = await reconcile(f, "1000", "2026-03-31", "150.00");
  const after = await posted(f);
  expect(
    after.map((item) => [item.line.description, item.reconciled?.statementDate ?? null]),
  ).toEqual([
    ["CLIENT A", "2026-03-31"],
    ["CLIENT B", "2026-03-31"],
    ["CLIENT C", null],
  ]);
  for (const item of after.slice(0, 2)) expect(item.reconciled.reconciliationId).toBe(record.id);
  // One line read by itself says the same, and reconcile.cleared agrees about the same postings.
  const [first, , third] = ids as [string, string, string];
  expect((await f.call("inbox.get", { itemId: first })).body.data.item.reconciled).toEqual({
    reconciliationId: record.id,
    statementDate: "2026-03-31",
  });
  expect((await f.call("inbox.get", { itemId: third })).body.data.item.reconciled).toBeUndefined();
  const cleared = await act(f, "reconcile.cleared", {
    journalIds: after.map((item) => item.journalId),
  });
  // Only the two March postings on the checking account are on it; the entries' other sides are not.
  expect(
    cleared.postings.map((posting: Json) => [posting.accountId, posting.reconciliationId]),
  ).toEqual([
    ["1000", record.id],
    ["1000", record.id],
  ]);

  // A voided reconciliation no longer has them, and the Inbox follows.
  await act(f, "reconcile.void", { id: record.id, reason: "It was the wrong statement" });
  for (const item of await posted(f))
    expect(item.reconciled, item.line.description).toBeUndefined();
  expect((await f.call("inbox.get", { itemId: first })).body.data.item.reconciled).toBeUndefined();
});

test("a transfer shows each side's own state: the line on the account that was reconciled, not the other", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-01", amount: "-500.00", description: "TO CHECKING" }], {
      ledgerAccountId: "1100",
      sourceKey: "csv:1100",
      accountKey: "csv:1100",
    }),
  );
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-02", amount: "500.00", description: "FROM SAVINGS" }], {
      ledgerAccountId: "1000",
    }),
  );
  const page = (await f.call("inbox.list", {})).body.data;
  const out = page.items.find((item: Json) => item.line.amount === "-500.00");
  await act(f, "inbox.accept", { itemIds: [out.id] });
  await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  const record = await reconcile(f, "1000", "2026-03-31", "500.00");
  const lines = Object.fromEntries((await posted(f)).map((item) => [item.line.description, item]));
  // One entry for both lines; only the checking side is on a statement.
  expect(lines["FROM SAVINGS"].journalId).toBe(lines["TO CHECKING"].journalId);
  expect(lines["FROM SAVINGS"].reconciled).toEqual({
    reconciliationId: record.id,
    statementDate: "2026-03-31",
  });
  expect(lines["TO CHECKING"].reconciled).toBeUndefined();
});

test("a line matched to an entry already in the books is reconciled when that entry is", async () => {
  const f = await ingestFixture();
  await postManual(f, "2026-01-01", "Capital paid in", [
    { accountId: "1000", debit: "100.00", credit: "" },
    { accountId: "3000", debit: "", credit: "100.00" },
  ]);
  const journalId = await postManual(f, "2026-01-09", "SaaS subscription acme", [
    { accountId: "5000", debit: "30.00", credit: "" },
    { accountId: "1000", debit: "", credit: "30.00" },
  ]);
  f.port.submit(
    batchOf(
      f.port,
      [{ date: "2026-01-09", amount: "-30.00", description: "ACME SAAS SUBSCRIPTION" }],
      { ledgerAccountId: "1000" },
    ),
  );
  const [line] = (await f.call("inbox.list", {})).body.data.items as Json[];
  const accepted = await act(f, "inbox.accept", { itemIds: [(line as Json).id] });
  expect(accepted.results[0]).toMatchObject({ outcome: "applied", status: "posted", journalId });
  // It is posted by matching, not by a new entry, and still not on any statement.
  expect((await posted(f))[0]?.reconciled).toBeUndefined();
  const record = await reconcile(f, "1000", "2026-01-31", "70.00");
  const [matched] = await posted(f);
  expect(matched).toMatchObject({
    journalId,
    reconciled: { reconciliationId: record.id, statementDate: "2026-01-31" },
  });
});

test("a line that no chart account holds, such as a provider's own event, is on no statement", () => {
  const row = {
    id: "item-1",
    status: "posted",
    ledger_account_id: null,
    journal_id: "journal-1",
    matched_journal_id: null,
  } as ItemRow;
  expect(reconciledLines(null as never, [row]).size).toBe(0);
  // Nor is a line that is not posted, whatever its account.
  const waiting = { ...row, status: "drafted", ledger_account_id: "1000" } as ItemRow;
  expect(reconciledLines(null as never, [waiting]).size).toBe(0);
});

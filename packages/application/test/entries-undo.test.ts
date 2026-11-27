import { afterEach, expect, test } from "bun:test";
import {
  commandId,
  derivationId,
  evidenceId,
  hashCanonical,
  instant,
  journalId as kernelJournalId,
  postingId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import type { LedgerEvent } from "../src/ingest-types.ts";
import { clip } from "../src/slices/entries/undo.ts";
import { registerProposer } from "../src/slices/ingest/proposers.ts";
import { ingestRuntime, ledgerSourceId } from "../src/slices/ingest/store.ts";
import {
  batchOf,
  closeFixtures,
  type Fixture,
  ingestFixture,
  itemRows,
  type Json,
  type LineInit,
  postManual,
  stripeEvent,
} from "./support/ingest-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  closeFixtures();
  for (const work of cleanup.splice(0).reverse()) work();
});

const uuid = () => crypto.randomUUID();

const act = async (f: Fixture, name: string, input: unknown, operationId = uuid()) => {
  const reply = await f.call(name, input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};

/** Import lines into the checking account (1000) and return the ids of the new items. */
function importLines(f: Fixture, lines: readonly LineInit[], extra = {}): string[] {
  const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000", ...extra }));
  return report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
}

const NOTION: LineInit = { date: "2026-03-02", amount: "-25.00", description: "NOTION LABS" };

/** Import one line, categorize it and post it. Returns its item id and the id of its entry. */
async function postLine(
  f: Fixture,
  line: LineInit = NOTION,
  accountId = "5000",
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
async function balances(f: Fixture): Promise<Record<string, string>> {
  const chart = (await f.call("accounts.list", {})).body.data.accounts as Json[];
  return Object.fromEntries(chart.map((account) => [account.id, account.balance]));
}

/** Entries in the books (a draft that has not been posted is not one). */
const journalCount = async (f: Fixture): Promise<number> =>
  (await f.call("journal.list", { status: "Posted" })).body.data.count;

const item = async (f: Fixture, itemId: string): Promise<Json> =>
  (await f.call("inbox.get", { itemId })).body.data;

/** Close or reopen one month through the ordinary prepare and commit path. */
async function changeMonth(f: Fixture, periodId: string, operation: "close" | "reopen") {
  const prepared = await f.call(
    "periods.prepare",
    { periodId, operation, reason: "Reviewed" },
    uuid(),
  );
  expect(prepared.body.ok, JSON.stringify(prepared.body)).toBe(true);
  const receipt = await f.call("operations.commit", {
    planId: prepared.body.data.planId,
    planHash: prepared.body.data.planHash,
  });
  expect(receipt.body.data.disposition, JSON.stringify(receipt.body)).toBe("committed");
}

test("undo reverses the entry with a linked reversal and returns the line to review", async () => {
  const f = await ingestFixture();
  const { id, journalId } = await postLine(f);
  expect(await balances(f)).toMatchObject({ "1000": "-25.00", "5000": "25.00" });

  const undone = await act(f, "inbox.undo", { itemIds: [id] });
  expect(undone).toMatchObject({ applied: 1, skipped: 0, failed: 0, remaining: 0 });
  const [result] = undone.results;
  expect(result).toMatchObject({ itemId: id, outcome: "applied", status: "new", journalId });
  expect(typeof result.reversalJournalId).toBe("string");

  // Nothing was deleted: the entry and its reversal are both there, linked, and net to zero.
  expect(await journalCount(f)).toBe(2);
  const original = (await f.call("journal.get", { journalId })).body.data;
  expect(original.correction).toMatchObject({
    kind: "reversal",
    originalJournalId: journalId,
    correctionJournalId: result.reversalJournalId,
  });
  // The link also carries the numbers the two entries are shown under (additive, from the accounting lane).
  expect(original.correction).toHaveProperty("originalPostingSequence");
  expect(original.correction).toHaveProperty("correctionPostingSequence");
  const reversal = (await f.call("journal.get", { journalId: result.reversalJournalId })).body.data;
  expect(reversal).toMatchObject({ kind: "reversing", date: NOTION.date });
  expect(reversal.narration).toContain("Undone: the transaction went back to review");
  // In the app's words: the retired ones (the Inbox, a line) are not written into the books.
  expect(reversal.narration).not.toMatch(/Inbox|\bline\b/);
  expect(await balances(f)).toMatchObject({ "1000": "0.00", "5000": "0.00" });

  // The line is waiting again, with no entry, and nothing offers it the entry it was undone from.
  const back = await item(f, id);
  expect(["new", "proposed"]).toContain(back.item.status);
  expect(back.item.journalId).toBeUndefined();
  expect(back.item.draftId).toBeUndefined();
  expect(back.proposals.filter((proposal: Json) => proposal.kind === "match")).toEqual([]);
  // The trail says who, and links to both entries.
  expect(back.history.at(-1)).toMatchObject({
    kind: "undo",
    by: "owner",
    journalId,
    reversalJournalId: result.reversalJournalId,
  });
  expect((await f.call("inbox.summary", {})).body.data.counts).toMatchObject({
    posted: 0,
    toReview: 1,
  });
});

test("a line that was undone is posted again under the next source identity, and an identity is still never booked twice", async () => {
  const f = await ingestFixture();
  const { id, journalId } = await postLine(f);
  const firstIdentity = (await item(f, id)).provenance.sourceEventId as string;
  expect(firstIdentity).toMatch(/^ingest-csv-[0-9a-f]{32}$/);

  await act(f, "inbox.undo", { itemIds: [id], reason: "Wrong category" });
  // The second time round the person chooses another account. Nothing refuses it: the line is not a
  // match for the entry it was undone from, and the ledger has not seen its next identity.
  const second = await act(f, "inbox.categorize", { itemIds: [id], accountId: "5100" });
  expect(second.results[0], JSON.stringify(second)).toMatchObject({ outcome: "applied" });
  const posted = await act(f, "inbox.post", { itemIds: [id] });
  expect(posted.results[0]).toMatchObject({ outcome: "applied", status: "posted" });
  const again = posted.results[0].journalId as string;
  expect(again).not.toBe(journalId);

  // Three entries (the original, its reversal and the new one); the books say the new decision once.
  expect(await journalCount(f)).toBe(3);
  expect(await balances(f)).toMatchObject({ "1000": "-25.00", "5000": "0.00", "5100": "25.00" });
  const secondIdentity = (await item(f, id)).provenance.sourceEventId as string;
  expect(secondIdentity).toBe(`${firstIdentity}-r1`);
  expect(itemRows(f, `id='${id}'`)[0]?.source_generation).toBe(1);

  // Both identities are in the ledger now. Any other draft that claims either one is refused, even
  // one that carries exactly the same facts, so a line can never be booked twice under one identity.
  for (const identity of [firstIdentity, secondIdentity]) {
    const source = (await f.call("sources.get", { sourceId: identity })).body.data;
    expect(source.status).toBe("posted");
    const draft = await act(f, "drafts.create", {
      data: {
        date: NOTION.date,
        reference: "AGAIN",
        narration: "Booked a second time",
        source: source.source,
        lines: [
          { accountId: "1000", debit: "", credit: "25.00" },
          { accountId: "5000", debit: "25.00", credit: "" },
        ],
      },
    });
    const refused = await f.call(
      "journal.prepare",
      { draftId: draft.id, expectedVersion: draft.version },
      uuid(),
    );
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error.code).toBe("source_already_posted");
  }

  // And again: the next undo moves to the next identity, and the line is posted a third time.
  await act(f, "inbox.undo", { itemIds: [id] });
  await act(f, "inbox.categorize", { itemIds: [id], accountId: "5200" });
  const third = await act(f, "inbox.post", { itemIds: [id] });
  expect(third.results[0]).toMatchObject({ outcome: "applied" });
  expect((await item(f, id)).provenance.sourceEventId).toBe(`${firstIdentity}-r2`);
  expect(await journalCount(f)).toBe(5);
  expect(await balances(f)).toMatchObject({ "1000": "-25.00", "5100": "0.00", "5200": "25.00" });
});

test("a retried undo returns the first answer, and an undo of a line already back in review changes nothing", async () => {
  const f = await ingestFixture();
  const { id } = await postLine(f);
  const operationId = uuid();
  const first = await f.call("inbox.undo", { itemIds: [id] }, operationId);
  expect(first.body.ok, JSON.stringify(first.body)).toBe(true);
  expect(first.body.data.applied).toBe(1);
  const retried = await f.call("inbox.undo", { itemIds: [id] }, operationId);
  expect(retried.body.data).toEqual(first.body.data);
  expect(await journalCount(f)).toBe(2);

  // A new identity for the same lines is a new request: the line is not posted any more.
  const later = await act(f, "inbox.undo", { itemIds: [id] });
  expect(later).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
  expect(later.results[0]).toMatchObject({ outcome: "skipped", code: "wrong_status" });
  expect(later.results[0].message).toContain("nothing to undo");
  expect(await journalCount(f)).toBe(2);

  // The same identity for different lines is a conflict, not a second undo.
  const other = await f.call("inbox.undo", { itemIds: [id, "it_other"] }, operationId);
  expect(other.status).toBe(409);
  expect(other.body.error.code).toBe("operation_identity_conflict");
});

test("an entry that was reversed by hand is not reversed twice: the line just goes back", async () => {
  const f = await ingestFixture();
  const { id, journalId } = await postLine(f);
  // The Journal screen's Reverse: prepare, then commit.
  const prepared = await act(
    f,
    "journal.prepareReverse",
    { journalId, accountingDate: "2026-03-05", reason: "By hand" },
    uuid(),
  );
  await act(f, "operations.commit", { planId: prepared.planId, planHash: prepared.planHash });
  const byHand = prepared.effects.journals[0].id as string;
  expect(await journalCount(f)).toBe(2);
  // The line still says posted: nothing told the Inbox.
  expect((await item(f, id)).item.status).toBe("posted");

  const undone = await act(f, "inbox.undo", { itemIds: [id] });
  expect(undone.results[0]).toMatchObject({
    outcome: "applied",
    status: "new",
    journalId,
    reversalJournalId: byHand,
  });
  expect(await journalCount(f)).toBe(2);
  // It can be decided and posted again.
  await act(f, "inbox.categorize", { itemIds: [id], accountId: "5000" });
  const posted = await act(f, "inbox.post", { itemIds: [id] });
  expect(posted.results[0]).toMatchObject({ outcome: "applied", status: "posted" });
  expect(await journalCount(f)).toBe(3);
});

/** Replace an entry with a corrected one, the way a supersession does. The application only ever
 * reverses, so the command is built here, as the service builds a reversal, and run under the
 * service's own action identity. */
async function supersede(f: Fixture, journalId: string): Promise<void> {
  const actionId = uuid();
  await f.service.executeAction(actionId, "supersedeForTest", { journalId }, (state) => {
    const original = state.journals.find((entry) => entry.journal.id === journalId);
    const quantization = state.quantizationPolicies[0];
    const policy = state.policies[0];
    if (!original || !quantization || !policy)
      throw new Error("the book is not as the test expects");
    const now = instant(new Date().toISOString());
    const journal = {
      id: kernelJournalId(actionId),
      kind: "ordinary" as const,
      bookId: state.identity.bookId,
      functionalCommodityId: state.identity.functionalCommodityId,
      economicAt: original.journal.economicAt,
      accountingDate: original.journal.accountingDate,
      recordedAt: now,
      narration: "Corrected entry",
      postings: original.journal.postings.map((posting, index) => ({
        ...posting,
        id: postingId(`${actionId}-${index}`),
      })),
    };
    const resolved = resolveJournal(
      journal,
      state.policies,
      state.identity.ownerId,
      quantization,
      journal.postings.map((posting) => posting.bookValue.amount.toRational()),
      [
        {
          id: derivationId(`${actionId}-lineage`),
          policyId: policy.id,
          policyVersion: policy.version,
          algorithmVersion: semanticVersion("1.0.0"),
          inputHash: hashCanonical({ originalJournalId: journalId }),
          actorId: f.service.commandActor,
          state: "approved" as const,
          recordedAt: now,
          evidence: [
            {
              id: evidenceId(`${actionId}-evidence`),
              sourceSystem: "test",
              sourceRecordId: journalId,
              observedAt: now,
              contentHash: original.canonicalHash,
            },
          ],
        },
      ],
    );
    if (Array.isArray(resolved)) throw new Error(resolved.map((item) => item.message).join("; "));
    return sealCommand({
      id: commandId(actionId),
      type: "correctJournal",
      protocolVersion: semanticVersion("1.0.0"),
      bookId: state.identity.bookId,
      expectedBookRevision: state.bookRevision,
      actorId: f.service.commandActor,
      issuedAt: now,
      completedAt: now,
      committedAt: now,
      correctionKind: "supersession",
      originalJournalId: journalId,
      resolved: resolved as ResolvedTransaction,
    });
  });
}

test("an entry that a corrected entry replaced cannot be undone from here, and nothing changes", async () => {
  const f = await ingestFixture();
  const { id, journalId } = await postLine(f);
  await supersede(f, journalId);
  const state = (await f.service.readAggregate()).aggregate.state;
  expect(state.corrections.map((link) => link.kind)).toEqual(["supersession"]);

  const refused = await act(f, "inbox.undo", { itemIds: [id] });
  expect(refused.results[0]).toMatchObject({
    outcome: "failed",
    status: "posted",
    code: "already_corrected",
  });
  expect(refused.results[0].message).toContain("replaced by a corrected entry");
  expect((await item(f, id)).item).toMatchObject({ status: "posted", journalId });
  expect(await journalCount(f)).toBe(2);
});

test("an entry in a closed month is refused with the ledger's code and nothing changes; after the month is reopened it is undone", async () => {
  const f = await ingestFixture();
  const { id, journalId } = await postLine(f);
  await changeMonth(f, "period-03", "close");

  const refused = await act(f, "inbox.undo", { itemIds: [id] });
  expect(refused).toMatchObject({ applied: 0, skipped: 0, failed: 1 });
  expect(refused.results[0]).toMatchObject({
    itemId: id,
    outcome: "failed",
    status: "posted",
    code: "fiscal_period_admission",
  });
  expect(refused.results[0].message).toContain("March 2026");
  expect(refused.results[0].message).toContain("closed");
  expect(await journalCount(f)).toBe(1);
  expect((await item(f, id)).item).toMatchObject({ status: "posted", journalId });

  await changeMonth(f, "period-03", "reopen");
  const undone = await act(f, "inbox.undo", { itemIds: [id] });
  expect(undone).toMatchObject({ applied: 1, failed: 0 });
  expect(await journalCount(f)).toBe(2);
  expect((await item(f, id)).item.journalId).toBeUndefined();
});

test("undo needs the permission to correct the books, and nothing else", async () => {
  const f = await ingestFixture();
  const { id } = await postLine(f);
  const denied = await f.call("inbox.undo", { itemIds: [id] }, uuid(), [
    "read",
    "draft",
    "post",
    "configure",
    "close",
  ]);
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("permission_denied");
  expect(await journalCount(f)).toBe(1);
  const allowed = await f.call("inbox.undo", { itemIds: [id] }, uuid(), ["read", "correct"]);
  expect(allowed.body.ok, JSON.stringify(allowed.body)).toBe(true);
  expect(allowed.body.data.applied).toBe(1);
});

test("a line that is not posted is skipped with the way forward, and an unknown line is refused", async () => {
  const f = await ingestFixture();
  const [waiting, drafted, set] = importLines(f, [
    { date: "2026-03-03", amount: "-1.00", description: "ONE" },
    { date: "2026-03-04", amount: "-2.00", description: "TWO" },
    { date: "2026-03-05", amount: "-3.00", description: "THREE" },
  ]) as [string, string, string];
  await act(f, "inbox.categorize", { itemIds: [drafted], accountId: "5000" });
  await act(f, "inbox.exclude", { itemIds: [set], reason: "Personal" });
  const report = await act(f, "inbox.undo", { itemIds: [waiting, drafted, set, "it_nothing"] });
  expect(report).toMatchObject({ applied: 0, skipped: 3, failed: 1 });
  const byId = Object.fromEntries(report.results.map((result: Json) => [result.itemId, result]));
  expect(byId[waiting]).toMatchObject({ outcome: "skipped", code: "wrong_status" });
  expect(byId[waiting].message).toContain("nothing to undo");
  expect(byId[drafted].message).toContain("restore");
  expect(byId[set].message).toContain("Restore it");
  expect(byId.it_nothing).toMatchObject({ outcome: "failed", code: "item_not_found" });
  expect(await journalCount(f)).toBe(0);
  // The same id twice is one line.
  const posted = await postLine(f);
  const twice = await act(f, "inbox.undo", { itemIds: [posted.id, posted.id] });
  expect(twice.results).toHaveLength(1);
  expect(await journalCount(f)).toBe(2);
});

test("an empty or oversized list of lines is refused before anything happens", async () => {
  const f = await ingestFixture();
  importLines(f, [NOTION]);
  const none = await f.call("inbox.undo", { itemIds: [] }, uuid());
  expect(none.status).toBe(400);
  const many = await f.call(
    "inbox.undo",
    { itemIds: Array.from({ length: 101 }, (_, index) => `it_${index}`) },
    uuid(),
  );
  expect(many.status).toBe(400);
  expect(many.body.error.code).toBe("invalid_input");
  const unknown = await f.call("inbox.undo", { itemIds: ["it_1"], filter: {} }, uuid());
  expect(unknown.status).toBe(400);
  // An id is plain characters: text that would be SQL is not an id at all.
  const hostile = await f.call(
    "inbox.undo",
    { itemIds: ["x'; DROP TABLE app_ingest_items; --"] },
    uuid(),
  );
  expect(hostile.status).toBe(400);
  expect(hostile.body.error.code).toBe("invalid_input");
  expect(itemRows(f)).toHaveLength(1);
});

test("a transfer is undone as one entry for both lines, and posted again from either side", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-01", amount: "-500.00", description: "TO SAVINGS" }], {
      ledgerAccountId: "1000",
    }),
  );
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-02", amount: "500.00", description: "FROM CHECKING" }], {
      ledgerAccountId: "1100",
      sourceKey: "csv:1100",
      accountKey: "csv:1100",
    }),
  );
  const out = itemRows(f, "amount='-500.00'")[0]?.id as string;
  const into = itemRows(f, "amount='500.00'")[0]?.id as string;
  await f.call("inbox.list", {});
  await act(f, "inbox.accept", { itemIds: [out] });
  await act(f, "inbox.post", { itemIds: [out] });
  expect(await journalCount(f)).toBe(1);

  // Undoing either side takes the one entry back and returns both lines.
  const undone = await act(f, "inbox.undo", { itemIds: [into] });
  expect(undone).toMatchObject({ applied: 1, failed: 0 });
  expect(await journalCount(f)).toBe(2);
  expect(await balances(f)).toMatchObject({ "1000": "0.00", "1100": "0.00" });
  for (const id of [out, into]) {
    expect(["new", "proposed"]).toContain((await item(f, id)).item.status);
    expect(itemRows(f, `id='${id}'`)[0]?.source_generation).toBe(1);
  }
  // Accepted from the other side this time: the line that was not acted on first posts again.
  await act(f, "inbox.accept", { itemIds: [into] });
  await act(f, "inbox.post", { itemIds: [into] });
  expect(await journalCount(f)).toBe(3);
  expect(await balances(f)).toMatchObject({ "1000": "-500.00", "1100": "500.00" });
  const detail = await item(f, out);
  expect(detail.item.status).toBe("posted");
  expect(detail.provenance.sourceEventId).toMatch(/-r1$/);
});

test("a line matched to an entry booked by hand is only unlinked: the entry is left alone", async () => {
  const f = await ingestFixture();
  await postManual(f, "2026-01-01", "Capital paid in", [
    { accountId: "1000", debit: "100.00", credit: "" },
    { accountId: "3000", debit: "", credit: "100.00" },
  ]);
  const handBooked = await postManual(f, "2026-01-09", "SaaS subscription acme", [
    { accountId: "5000", debit: "30.00", credit: "" },
    { accountId: "1000", debit: "", credit: "30.00" },
  ]);
  const [id] = importLines(f, [
    { date: "2026-01-09", amount: "-30.00", description: "ACME SAAS SUBSCRIPTION" },
  ]) as [string];
  const proposed = await item(f, id);
  expect(proposed.proposals[0]).toMatchObject({ kind: "match", matchJournalId: handBooked });
  await act(f, "inbox.accept", { itemIds: [id] });
  expect((await item(f, id)).item).toMatchObject({ status: "posted", journalId: handBooked });
  const before = await journalCount(f);

  const undone = await act(f, "inbox.undo", { itemIds: [id] });
  expect(undone.results[0]).toMatchObject({
    outcome: "applied",
    status: "new",
    journalId: handBooked,
  });
  expect(undone.results[0].reversalJournalId).toBeUndefined();
  expect(undone.results[0].message).toContain("left as it was");
  expect(await journalCount(f)).toBe(before);
  // The line never used an identity of its own (nothing of it was posted), so it has none to advance.
  expect(itemRows(f, `id='${id}'`)[0]?.source_generation).toBe(0);
  const entry = (await f.call("journal.get", { journalId: handBooked })).body.data;
  expect(entry.correction).toBeNull();
  // The entry is still unlinked, so it is offered again; accepting it links the line once more.
  expect((await item(f, id)).proposals[0]).toMatchObject({ kind: "match" });
});

test("an entry that is on a finished reconciliation is still taken back, with a warning, and the reversal waits for the next statement", async () => {
  const f = await ingestFixture();
  const { id } = await postLine(
    f,
    {
      date: "2026-03-02",
      amount: "100.00",
      description: "CLIENT A",
    },
    "4000",
  );
  const draft = await act(f, "reconcile.start", {
    accountId: "1000",
    statementDate: "2026-03-31",
    statementBalance: "100.00",
  });
  const ticked = await act(f, "reconcile.setCleared", {
    id: draft.id,
    expectedVersion: draft.version,
    reset: "all",
  });
  expect(ticked.canComplete, JSON.stringify(ticked)).toBe(true);
  await act(f, "reconcile.complete", { id: draft.id, expectedVersion: ticked.version });
  expect((await item(f, id)).item.reconciled).toMatchObject({ statementDate: "2026-03-31" });

  const undone = await act(f, "inbox.undo", { itemIds: [id] });
  expect(undone.results[0]).toMatchObject({ outcome: "applied", status: "new" });
  const [warning] = undone.results[0].warnings;
  expect(warning.code).toBe("cleared_posting_corrected");
  expect(warning.message).toContain("2026-03-31");
  // The line is no longer reconciled (it has no entry); the books now differ from the statement by the
  // reversal, which shows as a line to reconcile on the next statement.
  expect((await item(f, id)).item.reconciled).toBeUndefined();
  const status = (await f.call("reconcile.status", {})).body.data.accounts.find(
    (account: Json) => account.account.id === "1000",
  );
  expect(status).toMatchObject({
    lastReconciledBalance: "100.00",
    bookBalance: "0.00",
    unclearedCount: 1,
    unclearedTotal: "-100.00",
  });
});

test("a payout's lines go back with the payout, and the payout is posted again under its next identity", async () => {
  const f = await ingestFixture();
  const accounts: Record<string, string> = {
    "stripe.balance": "1100",
    "stripe.fees": "5200",
    "revenue.sales": "4000",
    "payouts.in-transit": "1000",
  };
  cleanup.push(
    registerProposer({
      name: "example.undo-payout",
      revision: () => "1",
      create: () => ({
        name: "example.undo-payout",
        propose: (line) =>
          line.line.kind === "event"
            ? [
                {
                  proposer: "example.undo-payout",
                  kind: "event" as const,
                  confidence: 1,
                  reasons: ["A payout, booked from the provider's own identifiers"],
                  legs: line.line.legs.map((leg) => ({
                    accountId: accounts[leg.role] as string,
                    amount: leg.amount,
                  })),
                },
              ]
            : [],
      }),
    }),
  );
  const charge = (id: string, rawIndex: number): LedgerEvent =>
    stripeEvent(
      id,
      "2026-03-03",
      [
        { role: "stripe.balance", amount: "97.10" },
        { role: "stripe.fees", amount: "2.90" },
        { role: "revenue.sales", amount: "-100.00" },
      ],
      rawIndex,
      { coveredBy: "po_1" },
    );
  const raw = f.port.archive(new TextEncoder().encode("payout"), "application/json");
  f.port.submit({
    provider: "stripe",
    sourceKey: "stripe:acct_1",
    raw,
    lines: [
      charge("txn_1", 0),
      charge("txn_2", 1),
      stripeEvent(
        "po_1",
        "2026-03-05",
        [
          { role: "payouts.in-transit", amount: "194.20" },
          { role: "stripe.fees", amount: "5.80" },
          { role: "revenue.sales", amount: "-200.00" },
        ],
        2,
      ),
    ],
    balances: [],
    fetchedAt: "2026-03-06T00:00:00.000Z",
  });
  const payoutId = itemRows(f, "provider_id='po_1'")[0]?.id as string;
  const memberIds = itemRows(f, "provider_id IN ('txn_1','txn_2')").map((row) => row.id as string);
  await f.call("inbox.list", {});
  await act(f, "inbox.accept", { itemIds: [payoutId] });
  await act(f, "inbox.post", { itemIds: [payoutId] });
  expect(await journalCount(f)).toBe(1);
  for (const id of memberIds) expect((await item(f, id)).item.status).toBe("posted");

  // A line the payout books cannot be undone alone.
  const alone = await act(f, "inbox.undo", { itemIds: [memberIds[0]] });
  expect(alone.results[0]).toMatchObject({ outcome: "skipped", code: "covered" });
  expect(await journalCount(f)).toBe(1);

  const undone = await act(f, "inbox.undo", { itemIds: [payoutId] });
  expect(undone).toMatchObject({ applied: 1, failed: 0 });
  expect(await journalCount(f)).toBe(2);
  for (const id of [payoutId, ...memberIds])
    expect(["new", "proposed"], id).toContain((await item(f, id)).item.status);
  // The payout is the line with an identity of its own; its lines never had one.
  expect(itemRows(f, `id='${payoutId}'`)[0]?.source_generation).toBe(1);
  for (const id of memberIds) expect(itemRows(f, `id='${id}'`)[0]?.source_generation).toBe(0);

  await act(f, "inbox.accept", { itemIds: [payoutId] });
  const again = await act(f, "inbox.post", { itemIds: [payoutId] });
  expect(again.results[0]).toMatchObject({ outcome: "applied" });
  expect(await journalCount(f)).toBe(3);
  for (const id of memberIds) expect((await item(f, id)).item.status).toBe("posted");
});

test("several lines undone at once, even while other undos run, all come back", async () => {
  const f = await ingestFixture();
  const lines = [
    { date: "2026-03-03", amount: "-1.00", description: "ONE" },
    { date: "2026-03-04", amount: "-2.00", description: "TWO" },
    { date: "2026-03-05", amount: "-3.00", description: "THREE" },
  ];
  const ids = importLines(f, lines);
  await act(f, "inbox.categorize", { itemIds: ids, accountId: "5000" });
  await act(f, "inbox.post", { itemIds: ids });
  expect(await journalCount(f)).toBe(3);

  const [one, ...rest] = ids as [string, string, string];
  const [first, second, third] = await Promise.all([
    act(f, "inbox.undo", { itemIds: [one] }),
    act(f, "inbox.undo", { itemIds: [rest[0]] }),
    act(f, "inbox.undo", { itemIds: [rest[1]] }),
  ]);
  for (const report of [first, second, third])
    expect(report, JSON.stringify(report)).toMatchObject({ applied: 1, failed: 0 });
  expect(await journalCount(f)).toBe(6);
  expect(await balances(f)).toMatchObject({ "1000": "0.00", "5000": "0.00" });
});

test("a call that runs out of time says how many lines remain, and the next call finishes them", async () => {
  const f = await ingestFixture();
  const ids = importLines(f, [
    { date: "2026-03-03", amount: "-1.00", description: "ONE" },
    { date: "2026-03-04", amount: "-2.00", description: "TWO" },
    { date: "2026-03-05", amount: "-3.00", description: "THREE" },
  ]);
  await act(f, "inbox.categorize", { itemIds: ids, accountId: "5000" });
  await act(f, "inbox.post", { itemIds: ids });
  ingestRuntime(f.service).postBudgetMs = 0;
  const first = await act(f, "inbox.undo", { itemIds: ids });
  expect(first).toMatchObject({ applied: 1, remaining: 2 });
  const second = await act(f, "inbox.undo", { itemIds: ids });
  // The first line is already back; the budget lets one more through each time.
  expect(second.applied).toBe(1);
  expect(second.remaining).toBe(1);
  const third = await act(f, "inbox.undo", { itemIds: ids });
  expect(third.applied).toBe(1);
  expect(await balances(f)).toMatchObject({ "1000": "0.00", "5000": "0.00" });
});

test("an undone line survives a restart: it is back in review and still postable", async () => {
  const f = await ingestFixture();
  const { id } = await postLine(f);
  await act(f, "inbox.undo", { itemIds: [id] });
  await f.restart();
  expect(["new", "proposed"]).toContain((await item(f, id)).item.status);
  await act(f, "inbox.categorize", { itemIds: [id], accountId: "5000" });
  const posted = await act(f, "inbox.post", { itemIds: [id] });
  expect(posted.results[0]).toMatchObject({ outcome: "applied", status: "posted" });
  expect(await journalCount(f)).toBe(3);
});

test("two undos of the same line at once reverse its entry once, and the second is told the line is already back", async () => {
  const f = await ingestFixture();
  const { id } = await postLine(f);
  const reports = await Promise.all([
    act(f, "inbox.undo", { itemIds: [id] }),
    act(f, "inbox.undo", { itemIds: [id] }),
  ]);
  const outcomes = reports.flatMap((report) =>
    report.results.map((result: Json) => result.outcome),
  );
  expect(outcomes.sort()).toEqual(["applied", "skipped"]);
  const skipped = reports
    .flatMap((report) => report.results)
    .find((result: Json) => result.outcome === "skipped");
  expect(skipped).toMatchObject({ code: "wrong_status" });
  // One entry and one reversal, and the line moved one generation, not two.
  expect(await journalCount(f)).toBe(2);
  expect(itemRows(f, `id='${id}'`)[0]?.source_generation).toBe(1);
  expect(await balances(f)).toMatchObject({ "1000": "0.00", "5000": "0.00" });
});

test("the books' words are cut to what the contract carries, whole and with a mark that they were cut", () => {
  expect(clip("short", 500)).toBe("short");
  const long = `${"word ".repeat(200)}end`;
  const cut = clip(long, 500);
  expect(cut).toHaveLength(500);
  expect(cut.endsWith("…")).toBe(true);
  expect(clip("x".repeat(80), 80)).toHaveLength(80);
  expect(clip("x".repeat(81), 80)).toHaveLength(80);
});

test("the identity of a line after each undo is deterministic, fits the ledger, and never meets another line's", () => {
  const row = (source: string, generation: number) => ({
    source_event_id: source,
    source_generation: generation,
  });
  const plain = `ingest-csv-${"a".repeat(32)}`;
  expect(ledgerSourceId(row(plain, 0))).toBe(plain);
  expect(ledgerSourceId(row(plain, 1))).toBe(`${plain}-r1`);
  expect(ledgerSourceId(row(plain, 12))).toBe(`${plain}-r12`);
  // A connector may choose an identity as long as the ledger allows; the suffix still fits.
  const longA = `stripe-payout-${"x".repeat(100)}-${"a".repeat(13)}`;
  const longB = `stripe-payout-${"x".repeat(100)}-${"b".repeat(13)}`;
  expect(longA).toHaveLength(128);
  const shown = [1, 2, 10].flatMap((generation) => [
    ledgerSourceId(row(longA, generation)),
    ledgerSourceId(row(longB, generation)),
  ]);
  for (const identity of shown) {
    expect(identity.length).toBeLessThanOrEqual(128);
    expect(identity).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  }
  expect(new Set(shown).size).toBe(shown.length);
  expect(ledgerSourceId(row(longA, 1))).toBe(ledgerSourceId(row(longA, 1)));
  expect(shown).not.toContain(longA);
  expect(ledgerSourceId(row(longA, 3))).toMatch(/-r3$/);
});

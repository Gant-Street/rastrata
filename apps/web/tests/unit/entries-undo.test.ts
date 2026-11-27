import { expect, test } from "bun:test";
import { API_VERSION, type InboxUndoResult } from "@rastrata/application/client-contracts";
import { BrowserApplicationClient, type ApplicationFetch } from "../../src/application-client";
import { forPeople } from "../../src/routes/entries/messages";
import { shown } from "../support/shown";
import { summarize, undoLines, undoMessage } from "../../src/routes/entries/undo";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

type Result = InboxUndoResult;

const applied = (itemId: string, extra: Partial<Result> = {}): Result => ({
  itemId,
  outcome: "applied",
  status: "new",
  journalId: `j-${itemId}`,
  reversalJournalId: `r-${itemId}`,
  ...extra,
});

/** A client whose service answers each `inbox.undo` call with the next reply, and records what it was sent. */
function clientWith(replies: { results: Result[]; remaining?: number }[]) {
  const sent: { itemIds: string[]; reason?: string }[] = [];
  let call = 0;
  const fetcher = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    sent.push(request.input);
    const reply = replies[Math.min(call++, replies.length - 1)] as {
      results: Result[];
      remaining?: number;
    };
    const results = reply.results;
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: request.operationId,
      data: {
        results,
        applied: results.filter((item) => item.outcome === "applied").length,
        skipped: results.filter((item) => item.outcome === "skipped").length,
        failed: results.filter((item) => item.outcome === "failed").length,
        remaining: reply.remaining ?? 0,
      },
    });
  }) as ApplicationFetch;
  return { client: new BrowserApplicationClient(storage(), fetcher), sent };
}

test("every line is undone in one call when the service reaches them all", async () => {
  const { client, sent } = clientWith([{ results: [applied("a"), applied("b")] }]);
  const summary = await undoLines(client, ["a", "b"], "inbox:action");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.itemIds).toEqual(["a", "b"]);
  expect(summary).toEqual({
    undone: ["a", "b"],
    refused: [],
    warnings: [],
    remaining: 0,
    unlinked: 0,
  });
  expect(undoMessage(summary)).toEqual({
    message: "Undone. 2 transactions are waiting for review again.",
    tone: "calm",
  });
});

test("a call that runs out of time is followed by another for the lines it did not reach", async () => {
  const { client, sent } = clientWith([
    { results: [applied("a")], remaining: 2 },
    { results: [applied("b")], remaining: 1 },
    { results: [applied("c")], remaining: 0 },
  ]);
  const summary = await undoLines(client, ["a", "b", "c"], "inbox:action");
  expect(sent.map((request) => request.itemIds)).toEqual([["a", "b", "c"], ["b", "c"], ["c"]]);
  expect(summary.undone).toEqual(["a", "b", "c"]);
  expect(summary.remaining).toBe(0);
});

test("a call that reaches nothing is not asked again, and what is left is said", async () => {
  const { client, sent } = clientWith([{ results: [], remaining: 2 }]);
  const summary = await undoLines(client, ["a", "b"], "inbox:action");
  expect(sent).toHaveLength(1);
  expect(summary.remaining).toBe(2);
  expect(undoMessage(summary).tone).toBe("problem");
  expect(undoMessage(summary).message).toContain("2 more transactions");
});

test("a line the books refused stays as it was, and the books' own words are what the person reads", () => {
  const closed =
    "The entry is dated 2026-03-10, in March 2026 (2026-03-01 to 2026-03-31), which is closed, so it cannot be corrected or reversed yet. Reopen March 2026 first, correct the entry, then close it again.";
  const summary = summarize(
    [
      applied("a"),
      {
        itemId: "b",
        outcome: "failed",
        status: "posted",
        code: "fiscal_period_admission",
        message: closed,
      },
    ],
    0,
  );
  expect(summary.undone).toEqual(["a"]);
  // The books' words, with their dates shown the way every date on a screen is.
  expect(summary.refused).toEqual([
    { itemId: "b", code: "fiscal_period_admission", message: shown.text(closed) },
  ]);
  const said = undoMessage(summary);
  expect(said.tone).toBe("problem");
  expect(said.message).toContain("The transaction is waiting for review again.");
  expect(said.message).toContain("March 2026");
  expect(said.message).toContain(shown.date("2026-03-10"));
  expect(said.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});

test("a transaction matched to an entry booked by hand says only the link was removed", () => {
  const summary = summarize(
    [{ itemId: "a", outcome: "applied", status: "new", journalId: "j-hand" }],
    0,
  );
  expect(summary.unlinked).toBe(1);
  expect(undoMessage(summary).message).toContain("left as it was");
});

test("warnings from the books are kept once each", () => {
  const warning = { code: "cleared_posting_corrected", message: "Already reconciled." };
  const summary = summarize(
    [applied("a", { warnings: [warning] }), applied("b", { warnings: [warning] })],
    0,
  );
  expect(summary.warnings).toEqual(["Already reconciled."]);
});

test("an entry that was on a finished reconciliation is undone, and the toast says the books now differ", () => {
  const warning = { code: "cleared_posting_corrected", message: "Already reconciled." };
  const warned = summarize([applied("a", { warnings: [warning] }), applied("b")], 0);
  const said = undoMessage(warned);
  expect(said.tone).toBe("attention");
  expect(said.message).toBe(
    "Undone. 2 transactions are waiting for review again. It was already on a reconciliation, so your books differ from that statement until it is posted again.",
  );
  // The warning is not said for a line that was not undone, and a plain undo stays calm.
  expect(undoMessage(summarize([applied("a")], 0)).tone).toBe("calm");
  const refused = summarize(
    [
      applied("a", { warnings: [warning] }),
      { itemId: "b", outcome: "failed", status: "posted", code: "x", message: "Closed." },
    ],
    0,
  );
  const mixed = undoMessage(refused);
  expect(mixed.tone).toBe("problem");
  expect(mixed.message).toBe(
    "The transaction is waiting for review again. It was already on a reconciliation, so your books differ from that statement until it is posted again. Closed.",
  );
  // A line that was only unlinked changed no entry, so there is nothing to say about a reconciliation.
  expect(undoMessage(summarize([{ itemId: "c", outcome: "applied", status: "new" }], 0)).tone).toBe(
    "calm",
  );
});

test("the same line twice is one line", async () => {
  const { client, sent } = clientWith([{ results: [applied("a")] }]);
  await undoLines(client, ["a", "a"], "inbox:action");
  expect(sent[0]?.itemIds).toEqual(["a"]);
});

test("the books' words for a closed month read whole on a screen, without the way a script reopens it", () => {
  const said =
    'The entry is dated 2026-03-10, in March 2026 (2026-03-01 to 2026-03-31), which is closed, so it cannot be corrected or reversed yet. Reopen March 2026 first (Reopen on the Periods screen, or periods.prepare with operation "reopen"), correct the entry, then close it again.';
  expect(forPeople(said)).toBe(
    shown.text(
      "The entry is dated 2026-03-10, in March 2026 (2026-03-01 to 2026-03-31), which is closed, so it cannot be corrected or reversed yet. Reopen March 2026 first, correct the entry, then close it again.",
    ),
  );
  // A sentence that has been through it once (an error the client already formatted) is not changed again.
  expect(forPeople(forPeople(said))).toBe(forPeople(said));
  expect(forPeople("Posted 1,250.50 on 2026-03-10.")).toBe(
    `Posted 1,250.50 on ${shown.date("2026-03-10")}.`,
  );
  const summary = summarize(
    [
      {
        itemId: "b",
        outcome: "failed",
        status: "posted",
        code: "fiscal_period_admission",
        message: said,
      },
    ],
    0,
  );
  expect(summary.refused[0]?.message).not.toContain("periods.prepare");
  expect(forPeople("Nothing to take out.")).toBe("Nothing to take out.");
});

test("an undo that was asked for nothing says so, and drafts taken back are not read as links", () => {
  expect(undoMessage(summarize([], 0)).message).toBe("There was nothing to undo.");
  const drafts = summarize([{ itemId: "a", outcome: "applied" }], 0, false);
  expect(drafts.unlinked).toBe(0);
  expect(undoMessage(drafts).message).toBe("Undone. The transaction is waiting for review again.");
});

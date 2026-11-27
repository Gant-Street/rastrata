/** The changes lane's first step: its riskiest assumption, tested before anything is built on it.
 *
 * The assumption: one list can say what changed in the books, who made each change and when, from the
 * ledger alone and one small table written beside each commit. The pass rule, from the charter:
 *
 *  - on the acceptance month's book, one change of every kind the ledger can hold is made by an owner,
 *    a person, an agent's token (and the control plane, which commits nothing but changes who has
 *    access), and the ledger reader gives one record for every committed revision;
 *  - `by` is right for each commit path (the six on /v1 and the older routes);
 *  - a revision from before the table says "not recorded", and is not guessed;
 *  - a book with a source that cannot be read still lists the others and names the one that failed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLegacyBookHandler } from "../../src/legacy-http.ts";
import { BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { Candidate } from "../../src/changes/candidate.ts";
import { ApplicationError } from "../../src/errors.ts";
import { listChanges } from "../../src/slices/changes/list.ts";
import type { SourceReader } from "../../src/slices/changes/sources/types.ts";
import { OPENING, APRIL, cents, chaseCsv } from "../acceptance/month.ts";
import {
  type Caller,
  type Json,
  type MonthBook,
  MARCH_ROWS,
  agentCaller,
  allChanges,
  LEDGER_KINDS,
  memberCaller,
  monthBook,
} from "./support.ts";

let m: MonthBook;
let agent: Awaited<ReturnType<typeof agentCaller>>;
let admin: Caller;

beforeAll(async () => {
  m = await monthBook();
  agent = await agentCaller(m.world, "weekly-run", [
    "read",
    "draft",
    "post",
    "configure",
    "correct",
    "close",
  ]);
  admin = await memberCaller(m.world, "user_0000000002", "admin");
}, 120_000);
afterAll(() => m?.close());

const OWNER = { kind: "owner", label: "owner" };
const AGENT = () => ({ kind: "agent", label: "weekly-run", id: agent.tokenId });
const PERSON = { kind: "person", label: "admin", id: "user_0000000002" };
const NOT_RECORDED = { kind: "unknown", label: "not recorded" };

/** The newest `n` changes, newest first. */
async function newest(n = 1): Promise<Json[]> {
  const data = await m.owner.ok("changes.list", { pageSize: n, kinds: LEDGER_KINDS });
  return data.changes;
}

/** Commit a prepared plan as `who`, with the permission its kind needs. */
async function commit(who: Caller, prepared: Json): Promise<Json> {
  expect(prepared.valid, JSON.stringify(prepared.problems)).toBe(true);
  const done = await who.ok("operations.commit", {
    planId: prepared.planId,
    planHash: prepared.planHash,
  });
  expect(done.disposition).toBe("committed");
  return done;
}

const legacy = async (path: string, body: unknown): Promise<Json> => {
  const handler = createLegacyBookHandler(m.world.service, BUSINESS_PERMISSIONS);
  const response = await handler(
    new Request(`http://127.0.0.1:4010${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const answer = (await response.json()) as Json;
  if (response.status !== 200 && response.status !== 201)
    throw new Error(`${path} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
};

describe("a change of every kind, by every maker", () => {
  test("the book the owner leaves: opened, the opening entry, and the posted lines", async () => {
    const { changes } = await allChanges(m.owner, { kinds: LEDGER_KINDS });
    const oldest = [...changes].reverse();
    // Revision 1 is the book being opened; revision 2 the opening balances; then one entry per line.
    expect(oldest[0]).toMatchObject({
      revision: "1",
      kind: "book.opened",
      by: OWNER,
      how: "Set up the book",
      subject: { kind: "book" },
    });
    expect(oldest[0].summary).toMatch(/^Opened the books with \d+ accounts\.$/);
    expect(oldest[1]).toMatchObject({
      revision: "2",
      kind: "entry.posted",
      by: OWNER,
      how: "Committed a prepared plan",
    });
    expect(oldest[1].entry).toMatchObject({ number: 1, date: "2026-02-28" });
    const lines = oldest.slice(2);
    expect(lines).toHaveLength(MARCH_ROWS.length);
    for (const change of lines)
      expect(change).toMatchObject({
        kind: "entry.posted",
        by: OWNER,
        how: expect.stringMatching(/^Posted after review/),
      });
    // The sentence is built, short and plain: the number, the day, what it was and the amount.
    for (const change of lines)
      expect(change.summary).toMatch(
        /^Posted No\. \d+ on [A-Z][a-z]{2} \d{1,2}, 2026 for [\d,]+\.\d{2}: .+$/,
      );
    const rent = lines.find((change) => change.entry.description.startsWith("RENT PAYMENT"));
    expect(rent?.summary).toMatch(
      /^Posted No\. \d+ on Mar 1, 2026 for 750\.00: RENT PAYMENT ACH WEWORK$/,
    );
  });

  test("an agent enters, posts a file's lines and reverses its own entry", async () => {
    m.advance();
    const entered = await agent.ok("journal.post", {
      data: {
        date: "2026-03-20",
        reference: "AGENT-1",
        narration: "Software subscription entered by the agent",
        lines: [
          { accountId: "6200", debit: "20.00", credit: "" },
          { accountId: "1000", debit: "", credit: "20.00" },
        ],
      },
    });
    expect(entered.receipt.disposition).toBe("committed");
    const [byHand] = await newest();
    expect(byHand).toMatchObject({
      kind: "entry.posted",
      by: AGENT(),
      how: "Entered by hand and posted",
    });
    expect(byHand.summary).toMatch(/ for 20\.00: Software subscription entered by the agent$/);

    // The agent imports April's first lines, categorises and posts them: four entries, one call.
    m.advance();
    const afterMarch =
      cents(OPENING["1000"] as string) + m.rows.reduce((sum, row) => sum + cents(row.amount), 0n);
    const upload = await m.world.upload(
      chaseCsv(APRIL, afterMarch),
      "chase-april.csv",
      "text/csv",
      agent.secret,
    );
    expect(upload.status).toBe(200);
    await agent.ok("import.commit", {
      sha256: upload.body.data.sha256,
      ledgerAccountId: "1000",
    });
    const waiting = await m.owner.ok("inbox.list", { filter: { status: ["new", "proposed"] } });
    expect(waiting.items).toHaveLength(APRIL.length);
    for (const row of APRIL) {
      const item = waiting.items.find((i: Json) => i.line.description === row.memo) as Json;
      await agent.ok("inbox.categorize", {
        itemIds: [item.id],
        accountId: (row.dest as { to: string }).to,
      });
    }
    m.advance();
    const posted = await agent.ok("inbox.post", { filter: { status: ["drafted"] } });
    expect(posted).toMatchObject({ applied: APRIL.length, failed: 0 });
    const four = await newest(APRIL.length);
    expect(four).toHaveLength(APRIL.length);
    for (const change of four)
      expect(change).toMatchObject({
        kind: "entry.posted",
        by: AGENT(),
        how: expect.stringMatching(/^Posted after review/),
      });

    // It reverses the entry it made by hand: a plan, committed under its own token.
    m.advance();
    const plan = await agent.ok("journal.prepareReverse", {
      journalId: byHand.subject.id,
      accountingDate: "2026-03-20",
      reason: "Entered twice",
    });
    await commit(agent, plan);
    const [reversed] = await newest();
    expect(reversed).toMatchObject({
      kind: "entry.reversed",
      by: AGENT(),
      how: "Committed a prepared plan",
      subject: { kind: "journal", id: byHand.subject.id },
    });
    expect(reversed.summary).toMatch(
      /^Reversed No\. \d+ on Mar 20, 2026 for 20\.00, with No\. \d+: Software subscription entered by the agent$/,
    );
    expect(reversed.entry.description).toBe(
      `Reversal of No. ${byHand.entry.number}: Entered twice`,
    );
  }, 60_000);

  test("the owner undoes a line from For review", async () => {
    m.advance();
    const first = [...m.items.values()][0] as Json;
    const undone = await m.owner.ok("inbox.undo", { itemIds: [first.id], reason: "Wrong month" });
    expect(undone.applied ?? undone.results?.length).toBeGreaterThan(0);
    const [change] = await newest();
    expect(change).toMatchObject({
      kind: "entry.reversed",
      by: OWNER,
      how: "Sent back for review",
    });
  }, 60_000);

  test("a person adds an account and closes a month; the owner reopens it and renames and closes the account", async () => {
    m.advance();
    const when = (await admin.ok("accounts.list")).suggestedEffectiveOn as string;
    await commit(
      admin,
      await admin.ok("accounts.prepareCreate", {
        code: "6310",
        name: "Software licences",
        role: "expense",
        effectiveOn: when,
      }),
    );
    const [added] = await newest();
    expect(added).toMatchObject({
      kind: "account.added",
      by: PERSON,
      how: "Committed a prepared plan",
      subject: { kind: "account", id: "6310" },
    });
    expect(added.summary).toBe("Added the expense account 6310 Software licences.");

    m.advance();
    const periods = (await admin.ok("periods.list")).periods as Json[];
    const march = periods.find((p) => p.startsOn === "2026-03-01") as Json;
    await commit(
      admin,
      await admin.ok("periods.prepare", {
        periodId: march.id,
        operation: "close",
        reason: "March checked against the statement",
      }),
    );
    const [closed] = await newest();
    expect(closed).toMatchObject({
      kind: "period.closed",
      by: PERSON,
      subject: { kind: "period", id: march.id },
    });
    expect(closed.summary).toBe("Closed March 2026 (reason: March checked against the statement).");

    m.advance();
    await commit(
      m.owner,
      await m.owner.ok("periods.prepare", {
        periodId: march.id,
        operation: "reopen",
        reason: "A late invoice",
      }),
    );
    const [reopened] = await newest();
    expect(reopened).toMatchObject({ kind: "period.reopened", by: OWNER });
    expect(reopened.summary).toBe("Reopened March 2026 (reason: A late invoice).");

    m.advance();
    await commit(
      m.owner,
      await m.owner.ok("accounts.prepareChange", {
        accountId: "6310",
        name: "Software",
        close: false,
        effectiveOn: when,
      }),
    );
    const [renamed] = await newest();
    expect(renamed).toMatchObject({ kind: "account.changed", by: OWNER });
    expect(renamed.summary).toBe('Renamed account 6310 from "Software licences" to "Software".');

    m.advance();
    await commit(
      m.owner,
      await m.owner.ok("accounts.prepareChange", {
        accountId: "6310",
        name: "Software",
        close: true,
        effectiveOn: when,
      }),
    );
    const [closedAccount] = await newest();
    expect(closedAccount).toMatchObject({ kind: "account.closed", by: OWNER });
  }, 60_000);

  test("the owner lengthens the calendar and closes the year", async () => {
    m.advance();
    await commit(m.owner, await m.owner.ok("periods.extend", {}));
    const [extended] = await newest();
    expect(extended).toMatchObject({ kind: "calendar.extended", by: OWNER });
    expect(extended.summary).toMatch(/^Extended the calendar through Dec 31, 2027/);

    // A year later, so that every period of 2026 has ended and the year can be closed in one go.
    m.world.clock.ms = Date.UTC(2027, 0, 5, 12, 0, 0);
    const plan = await m.owner.ok("periods.yearEnd", { fiscalYear: 2026, reason: "Year end 2026" });
    expect(plan.valid, JSON.stringify(plan.problems)).toBe(true);
    const done = await m.owner.ok("periods.commitYearEnd", {
      planId: plan.planId,
      planHash: plan.planHash,
    });
    expect(done.disposition).toBe("committed");
    const closes = await newest(done.closedCount);
    expect(closes.length).toBe(done.closedCount);
    expect(closes.length).toBeGreaterThanOrEqual(12);
    for (const change of closes)
      expect(change).toMatchObject({
        by: OWNER,
        how: "Closed as part of a year-end",
      });
    expect(new Set(closes.map((c) => c.kind))).toEqual(new Set(["period.closed"]));
  }, 120_000);

  test("the older routes commit as the owner", async () => {
    m.advance();
    await legacy("/api/accounts", {
      actionId: crypto.randomUUID(),
      code: "6320",
      name: "Legacy account",
      role: "expense",
      effectiveOn: "2027-01-06",
    });
    const [account] = await newest();
    expect(account).toMatchObject({
      kind: "account.added",
      by: OWNER,
      how: "Committed from an older screen",
    });

    m.advance();
    const draft = await legacy("/api/drafts", {
      data: {
        date: "2027-01-07",
        reference: "LEGACY-1",
        narration: "Posted from an older screen",
        lines: [
          { accountId: "6200", debit: "5.00", credit: "" },
          { accountId: "1000", debit: "", credit: "5.00" },
        ],
      },
      version: 1,
    });
    const posted = await legacy(`/api/drafts/${draft.id}/post`, {});
    expect(posted.disposition).toBe("committed");
    const [entry] = await newest();
    expect(entry).toMatchObject({
      kind: "entry.posted",
      by: OWNER,
      how: "Committed from an older screen",
    });
  }, 60_000);

  test("a command nobody recorded the maker of says so, and a book older than the table does too", async () => {
    m.advance();
    const prepared = await m.owner.ok("accounts.prepareCreate", {
      code: "6330",
      name: "Committed without a maker",
      role: "expense",
      effectiveOn: "2027-01-08",
    });
    // As code that predates the lane would have: committed with nobody named.
    const receipt = await m.world.service.commitAction(prepared.planId, prepared.planHash);
    expect(receipt.disposition).toBe("committed");
    const [change] = await newest();
    expect(change).toMatchObject({
      kind: "account.added",
      by: NOT_RECORDED,
      how: "How it was committed was not recorded",
    });
  });

  test("one record for every committed revision, none twice, and the right maker for each path", async () => {
    const { changes, first } = await allChanges(m.owner, { kinds: LEDGER_KINDS });
    const head = Number(first.revision);
    const revisions = changes.map((c) => Number(c.revision));
    // Newest first, one record for each revision: 1..head with nothing missing and nothing twice.
    expect(revisions).toEqual(Array.from({ length: head }, (_, i) => head - i));
    expect(first.count).toBe(head);
    // Every maker recorded is one of the principals the test used, and nothing is made up.
    const makers = new Set(changes.map((c) => `${c.by.kind}:${c.by.label}`));
    expect([...makers].sort()).toEqual(
      ["agent:weekly-run", "owner:owner", "person:admin", "unknown:not recorded"].sort(),
    );
    // The table holds one row for each command that was committed through a path that names its maker.
    const rows = m.world.service.store
      .query("SELECT principal, operation FROM changes_commits")
      .all() as { principal: string; operation: string }[];
    expect(new Set(rows.map((r) => r.operation))).toEqual(
      new Set([
        "book.setup",
        "operations.commit",
        "inbox.post",
        "inbox.undo",
        "journal.post",
        "periods.commitYearEnd",
        "legacy.accounts",
        "legacy.drafts",
      ]),
    );
    // How far back the book recorded who: from the first revision, here.
    expect(first.attribution).toMatchObject({ fromRevision: "1" });
  });

  test("a revision from before the table is shown as not recorded; the list says how far back makers are known", async () => {
    // The book as a release before this one left it: its first three commands have no row.
    const gone = m.world.service.store
      .query("SELECT action_id FROM changes_commits ORDER BY rowid LIMIT 3")
      .all() as { action_id: string }[];
    expect(gone).toHaveLength(3);
    for (const { action_id } of gone)
      m.world.service.store.query("DELETE FROM changes_commits WHERE action_id=?").run(action_id);
    const { changes, first } = await allChanges(m.owner, { kinds: LEDGER_KINDS });
    const oldest = changes.slice(-3).reverse();
    for (const [index, change] of oldest.entries())
      expect(change, `revision ${index + 1}`).toMatchObject({
        revision: String(index + 1),
        by: NOT_RECORDED,
      });
    expect(changes.at(-4)?.by).not.toEqual(NOT_RECORDED);
    // Their `at` is the only time the ledger has: when each command was made ready.
    for (const change of oldest) expect(new Date(change.at).toISOString()).toBe(change.at);
    expect(first.attribution).toMatchObject({ fromRevision: "4" });
  });
});

describe("a source that fails does not hide the others", () => {
  const failing: SourceReader = {
    name: "rules",
    title: "Rules",
    read: async () => {
      throw new ApplicationError("permission_denied", "This needs provision permission", 403);
    },
  };
  const tagged = (id: string, at: string): Candidate => ({
    at,
    revision: null,
    kind: "account.tagged",
    actor: { kind: "unknown", label: "not recorded" },
    order: id,
    build: () => ({
      id,
      at,
      revision: null,
      kind: "account.tagged",
      summary: "Tagged account 6200.",
      subject: { kind: "account", id: "6200" },
      by: { kind: "unknown", label: "not recorded" },
      how: "A tag was set",
    }),
  });
  const working: SourceReader = {
    name: "tags",
    title: "Account tags",
    read: async () => ({ candidates: [tagged("tag:1", "2026-04-02T12:00:30.000Z")] }),
  };
  const partial: SourceReader = {
    name: "access",
    title: "Who has access",
    read: async () => ({
      candidates: [tagged("tag:2", "2026-04-02T12:00:40.000Z")],
      incomplete: "Agent keys were not read: this sign-in may not see them.",
    }),
  };

  test("the ledger and the working source are listed, and the failed one is named with its reason", async () => {
    const data = await listChanges(
      {
        service: m.world.service,
        access: { bookId: m.world.service.bookId, permissions: BUSINESS_PERMISSIONS },
        operationId: "",
      },
      { pageSize: 5, kinds: ["account.tagged", "book.opened"] },
      { sources: [failing, working, partial] },
    );
    const status = Object.fromEntries(data.sources.map((s) => [s.name, s]));
    expect(status.ledger).toMatchObject({ read: true, reason: null });
    expect(status.rules).toMatchObject({ read: false, changes: 0 });
    expect(status.rules?.reason).toMatch(/needs provision permission/);
    expect(status.tags).toMatchObject({ read: true, changes: 1 });
    // A source that read only part of what it keeps is not "read": what it found is listed, and what it
    // could not read is said.
    expect(status.access).toMatchObject({
      read: false,
      changes: 1,
      reason: "Agent keys were not read: this sign-in may not see them.",
    });
    // A source with no reader at all is named too, as not read.
    expect(status.reconciliation).toMatchObject({ read: false, changes: 0 });
    // The changes of the sources that gave any are in the list beside the ledger's.
    expect(data.changes.some((c) => c.id === "tag:1")).toBe(true);
    expect(data.changes.some((c) => c.id === "tag:2")).toBe(true);
    expect(data.changes.some((c) => c.id.startsWith("ledger:"))).toBe(true);
  });
});

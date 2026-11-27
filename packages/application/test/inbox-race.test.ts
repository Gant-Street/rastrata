/** Posting Inbox lines while the book moves under the posting.
 *
 * A posting prepares its entry against the book as it is and commits it a moment later. When another
 * write lands between the two, the ledger refuses the commit as stale, and used to keep that refusal
 * against the posting's identity for good: the line stayed drafted and every later post found the same
 * refusal without looking at the entry again. These tests hold what replaced it: a refusal that says
 * only that the book moved is met with a fresh evaluation, a refusal about the entry is not, nothing is
 * posted twice, and a line that fails for good does not keep the lines behind it from being reached. */
import { afterEach, expect, test } from "bun:test";
import { decodeBookCommand } from "@rastrata/kernel";
import type { SavedDraft } from "../src/contracts.ts";
import { deriveUuid } from "../src/ingest/hash.ts";
import type { ApplicationService } from "../src/service.ts";
import { postBulk } from "./support/bulk-book.ts";
import {
  type Fixture,
  type Json,
  batchOf,
  closeFixtures,
  ingestFixture,
} from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

const uuid = () => crypto.randomUUID();

const act = async (f: Fixture, name: string, input: unknown, operationId = uuid()) => {
  const reply = await f.call(name, input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};

let serial = 0;
/** Import lines into the checking account (1000), decide them all (5000) and return their item ids. */
async function drafted(
  f: Fixture,
  count: number,
  month = 2,
  label = "LINE",
  year = 2026,
): Promise<string[]> {
  serial += 1;
  const lines = Array.from({ length: count }, (_, index) => ({
    date: `${year}-${String(month).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`,
    amount: `-${10 + index + serial}.${String(10 + (index % 90))}`,
    description: `${label} ${serial} NUMBER ${index}`,
  }));
  const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000" }));
  const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
  // A hundred a call: that is what one call drafts unless it is asked for more.
  for (let at = 0; at < ids.length; at += 100)
    await act(f, "inbox.categorize", { itemIds: ids.slice(at, at + 100), accountId: "5000" });
  return ids;
}

const itemRow = (f: Fixture, itemId: string) =>
  f.service.store.query("SELECT * FROM app_ingest_items WHERE id=?").get(itemId) as Json;

const draftOf = (f: Fixture, itemId: string): SavedDraft => {
  const draft = f.service.draft(itemRow(f, itemId).draft_id);
  if (!draft) throw new Error("the line has no draft");
  return draft;
};

const identity = (draftId: string, version: number) =>
  deriveUuid(["ingest.post", draftId, String(version)]);

/** Every outcome the ledger holds, in order. */
async function outcomes(service: ApplicationService) {
  const all = [];
  let page = await service.outcomePage();
  for (;;) {
    all.push(...page.outcomes);
    if (page.through.sequence === page.observedTip.sequence) return all;
    page = await service.outcomePage(page.through);
  }
}
const refusals = async (service: ApplicationService) =>
  (await outcomes(service)).filter(
    (item) => item.payload.originalResult.disposition === "rejected",
  );

/** The journals the Inbox made, by id. */
async function inboxJournals(service: ApplicationService): Promise<string[]> {
  const { aggregate } = await service.readAggregate();
  return aggregate.state.journals
    .map((booked) => booked.journal.id as string)
    .filter((id) => id.startsWith("source-"));
}

/** The two ways another write outruns a plan. A write sealed after the plan is a later commit time
 * as well as a new revision (the kernel names the time first); a write sealed at the plan's own
 * instant leaves only the revision wrong. */
type Race = "revision" | "time";
const RACES: Record<Race, string> = {
  revision: "stale_book_revision",
  time: "temporal_semantics_violation",
};

/** The instant a retained plan was stamped with. */
function stampOf(f: Fixture, planId: string): string {
  const row = f.service.store
    .query("SELECT sealed_command FROM app_actions WHERE id=?")
    .get(planId) as { sealed_command: string };
  const decoded = decodeBookCommand(row.sealed_command);
  if (decoded.disposition !== "decoded") throw new Error("the plan cannot be read");
  return decoded.command.committedAt;
}

/** Another write lands in the book, as the Journal screen's would. Its clock is set, not left to run: a
 * write that follows the plan within the same millisecond (a warm process does) is a new revision and
 * nothing more, so a "time" race that relied on the clock moving on would sometimes be a "revision" one. */
async function otherWrite(f: Fixture, planId: string, race: Race): Promise<void> {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(stampOf(f, planId)).getTime() + (race === "time" ? 5 : 0);
  class AtThePlan extends RealDate {
    constructor(...args: unknown[]) {
      super(...((args.length === 0 ? [fixed] : args) as [number]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = AtThePlan as unknown as DateConstructor;
  try {
    await postBulk(f.service, 1);
  } finally {
    globalThis.Date = RealDate;
  }
  // A write dated ahead of the clock (the "time" race) must be behind it before the next plan is made: a plan
  // stamped earlier than the latest write is refused for its time and not for its revision, which is a
  // different test, and the next write of this kind would be dated before this one.
  while (RealDate.now() <= fixed) await Bun.sleep(1);
}

/** What the race used to do to a line: its plan was made, another write landed, and the commit was
 * refused, under the identity the Inbox derives from the draft. */
async function refuseAsStale(f: Fixture, itemId: string, race: Race = "revision"): Promise<string> {
  const draft = draftOf(f, itemId);
  const id = identity(draft.id, draft.version);
  const prepared = await f.service.prepareDraft(draft.id, draft.version, id);
  await otherWrite(f, id, race);
  const receipt = await f.service.commitAction(id, prepared.planHash);
  expect(receipt.disposition).toBe("rejected");
  expect(receipt.problems.map((problem) => problem.code)).toEqual([RACES[race]]);
  return id;
}

/** Another writer: a write lands in front of each of the next commits, of the kinds given. */
function interfere(f: Fixture, races: readonly Race[]): () => void {
  const service = f.service;
  const original = service.commitAction.bind(service);
  let next = 0;
  service.commitAction = async (id, planHash) => {
    const race = races[next];
    next += 1;
    if (race) await otherWrite(f, id, race);
    return original(id, planHash);
  };
  return () => {
    service.commitAction = original;
  };
}

/** Close January, so that an entry dated in it is refused for what it is. */
async function closeJanuary(f: Fixture): Promise<void> {
  const periods = (await f.call("periods.list", {})).body.data.periods as Json[];
  const plan = await f.call(
    "periods.prepare",
    { periodId: periods[0].id, operation: "close", reason: "month end" },
    uuid(),
  );
  expect(plan.body.ok, JSON.stringify(plan.body)).toBe(true);
  await f.call("operations.commit", {
    planId: plan.body.data.planId,
    planHash: plan.body.data.planHash,
  });
}

/** Reopen January: the cause of an entry dated in it being refused is gone. */
async function reopenJanuary(f: Fixture): Promise<void> {
  const periods = (await f.call("periods.list", {})).body.data.periods as Json[];
  const plan = await f.call(
    "periods.prepare",
    { periodId: periods[0].id, operation: "reopen", reason: "a late entry" },
    uuid(),
  );
  expect(plan.body.ok, JSON.stringify(plan.body)).toBe(true);
  await f.call("operations.commit", {
    planId: plan.body.data.planId,
    planHash: plan.body.data.planHash,
  });
}

test("a commit refused because another write landed is evaluated again and posted once", async () => {
  const f = await ingestFixture();
  const ids = await drafted(f, 3);
  // The first line meets a write sealed at its own instant, and then, on its second try, one sealed
  // after it; the other lines are not in anyone's way.
  const restore = interfere(f, ["revision", "time"]);
  const report = await act(f, "inbox.post", { itemIds: ids });
  restore();
  expect(report).toMatchObject({ applied: 3, failed: 0, skipped: 0, remaining: 0 });
  // The refusals are in the ledger, as refusals, and say only that the book moved.
  const refused = await refusals(f.service);
  expect(refused.map((item) => item.payload.originalResult.diagnostics.map((d) => d.code))).toEqual(
    [["stale_book_revision"], ["temporal_semantics_violation"]],
  );
  // Every line is posted, once: one journal for each, and nothing is left on the lines.
  expect(await inboxJournals(f.service)).toHaveLength(3);
  for (const id of ids)
    expect(itemRow(f, id)).toMatchObject({
      status: "posted",
      post_error: null,
      post_error_code: null,
    });
  // The line that met the writes was posted under the third identity of its draft, the others under
  // their first.
  for (const [index, version] of [3, 1, 1].entries()) {
    const draft = draftOf(f, ids[index] as string);
    const result = report.results.find((item: Json) => item.itemId === ids[index]);
    expect(draft.version).toBe(version);
    expect(draft.status).toBe("posted");
    expect(result.operationId).toBe(identity(draft.id, version));
  }
  // A second post finds nothing to do and the books hold exactly the three entries.
  const again = await act(f, "inbox.post", { itemIds: ids });
  expect(again.results.every((result: Json) => result.outcome === "skipped")).toBe(true);
  expect(await inboxJournals(f.service)).toHaveLength(3);
});

test("two clients posting at once do not make each other's plans stale", async () => {
  const f = await ingestFixture();
  const mine = await drafted(f, 8, 2, "MINE");
  const theirs = await drafted(f, 8, 3, "THEIRS");
  const [a, b] = await Promise.all([
    act(f, "inbox.post", { itemIds: mine }),
    act(f, "inbox.post", { itemIds: theirs }),
  ]);
  expect(a).toMatchObject({ applied: 8, failed: 0 });
  expect(b).toMatchObject({ applied: 8, failed: 0 });
  expect(await refusals(f.service)).toHaveLength(0);
  expect(await inboxJournals(f.service)).toHaveLength(16);
  // The same two lines posted by two clients, whichever wins, are one entry.
  const shared = await drafted(f, 6, 4, "SHARED");
  const [c, d] = await Promise.all([
    act(f, "inbox.post", { itemIds: shared }),
    act(f, "inbox.post", { itemIds: shared }),
  ]);
  expect(c.applied + d.applied).toBeGreaterThanOrEqual(6);
  expect(await inboxJournals(f.service)).toHaveLength(22);
  expect(await refusals(f.service)).toHaveLength(0);
});

test("a book poisoned by the old race recovers on the next post, with no restore", async () => {
  const f = await ingestFixture();
  const ids = await drafted(f, 4);
  // Three lines met the race when the refusal was kept for good, in both of the ways the kernel
  // words it; the fourth did not.
  const refusedIds: string[] = [];
  for (const [index, id] of ids.slice(0, 3).entries())
    refusedIds.push(await refuseAsStale(f, id, index === 1 ? "time" : "revision"));
  for (const [index, id] of refusedIds.entries()) {
    const found = await f.service.operation(id);
    expect(found.disposition, `line ${index}`).toBe("rejected");
    expect(draftOf(f, ids[index] as string).status).toBe("rejected");
  }
  const before = (await refusals(f.service)).length;
  expect(before).toBe(3);
  // The post by filter that used to repeat the same refusal now posts all four.
  const report = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(report).toMatchObject({ applied: 4, failed: 0, skipped: 0, remaining: 0 });
  expect(await inboxJournals(f.service)).toHaveLength(4);
  // The old refusals stay in the ledger as what they were; nothing new was refused.
  expect((await refusals(f.service)).length).toBe(before);
  for (const id of ids) {
    expect(itemRow(f, id)).toMatchObject({ status: "posted", post_error: null });
  }
  // The three were posted under the next identity of their drafts.
  for (const [index, id] of ids.slice(0, 3).entries()) {
    const draft = draftOf(f, id);
    expect(draft.version).toBe(2);
    expect(draft.postingOperationId).toBe(identity(draft.id, 2));
    expect(draft.postingOperationId).not.toBe(refusedIds[index]);
  }
  expect((await act(f, "inbox.post", { filter: { status: ["drafted"] } })).applied).toBe(0);
});

test("a plan the book outran before it was sent is made again, and nothing is refused", async () => {
  const f = await ingestFixture();
  const [id] = await drafted(f, 1);
  // Another write lands between the moment the entry is sealed and the moment it is previewed: the
  // second time a plan is prepared the book is read.
  const original = f.service.readAggregate.bind(f.service);
  const prepare = f.service.prepareDraft.bind(f.service);
  let preparing = false;
  let reads = 0;
  let injected = false;
  f.service.prepareDraft = async (...args) => {
    preparing = true;
    reads = 0;
    try {
      return await prepare(...args);
    } finally {
      preparing = false;
    }
  };
  f.service.readAggregate = async (...args) => {
    if (preparing && !injected) {
      reads += 1;
      if (reads === 2) {
        injected = true;
        await postBulk(f.service, 1);
      }
    }
    return original(...args);
  };
  const report = await act(f, "inbox.post", { itemIds: [id] });
  f.service.readAggregate = original;
  f.service.prepareDraft = prepare;
  expect(injected).toBe(true);
  expect(report).toMatchObject({ applied: 1, failed: 0 });
  // The first plan was never sent, so the ledger refused nothing; the draft is on its next version.
  expect(await refusals(f.service)).toHaveLength(0);
  expect(draftOf(f, id as string).version).toBe(2);
  expect(await inboxJournals(f.service)).toHaveLength(1);
});

test("a refusal about the entry stops at the ledger's words, is not tried again, and blocks nothing", async () => {
  const f = await ingestFixture();
  const january = await drafted(f, 2, 1, "JANUARY");
  const february = await drafted(f, 2, 2, "FEBRUARY");
  await closeJanuary(f);
  // One January line was sent anyway (its plan was invalid, and an uncertain posting is resumed
  // whatever the preview says), so the ledger holds a refusal for it that is about the entry.
  const draft = draftOf(f, january[0] as string);
  const refusedId = identity(draft.id, draft.version);
  const prepared = await f.service.prepareDraft(draft.id, draft.version, refusedId);
  expect(prepared.valid).toBe(false);
  expect((await f.service.commitAction(refusedId, prepared.planHash)).disposition).toBe("rejected");
  const before = (await refusals(f.service)).length;

  const report = await act(f, "inbox.post", {
    itemIds: [january[0], february[0], january[1], february[1]],
  });
  const byItem = Object.fromEntries(report.results.map((result: Json) => [result.itemId, result]));
  expect(byItem[january[0] as string]).toMatchObject({
    outcome: "failed",
    code: "posting_rejected",
  });
  expect(byItem[january[0] as string].message).toContain("The ledger refused this entry:");
  expect(byItem[january[0] as string].message).toContain("closed");
  expect(byItem[january[1] as string]).toMatchObject({
    outcome: "failed",
    code: "posting_invalid",
  });
  expect(byItem[february[0] as string]).toMatchObject({ outcome: "applied", status: "posted" });
  expect(byItem[february[1] as string]).toMatchObject({ outcome: "applied", status: "posted" });
  // It was not evaluated again: the draft is as it was, and the ledger refused nothing more.
  expect(draftOf(f, january[0] as string).version).toBe(1);
  expect((await refusals(f.service)).length).toBe(before);
  // Both January lines now carry a failure that trying again will not change.
  for (const id of january)
    expect(itemRow(f, id)).toMatchObject({
      status: "drafted",
      post_error_code: expect.any(String),
    });
  expect(await inboxJournals(f.service)).toHaveLength(2);
});

test("a post by filter leaves alone the lines refused before, reaches the lines behind them, and says so once", async () => {
  const f = await ingestFixture();
  const january = await drafted(f, 4, 1, "JANUARY");
  await drafted(f, 6, 2, "FEBRUARY");
  await closeJanuary(f);
  // The first call spends its turns on the head of the queue: the January lines fail, and are kept.
  const first = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 4 });
  expect(first).toMatchObject({ applied: 0, failed: 4, remaining: 6 });
  for (const id of january) expect(itemRow(f, id).post_error_code).toBe("posting_invalid");
  // From then on they do not take the turns of the lines behind them.
  const second = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 4 });
  expect(second).toMatchObject({ applied: 4, failed: 0, skipped: 0, remaining: 2 });
  // The call that finishes the rest names them, once, with the reason and what to do.
  const third = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 4 });
  expect(third).toMatchObject({ applied: 2, failed: 0, skipped: 4, remaining: 0 });
  const left = third.results.filter((result: Json) => result.outcome === "skipped");
  expect(left.map((result: Json) => result.itemId).sort()).toEqual([...january].sort());
  for (const result of left) {
    expect(result).toMatchObject({ code: "refused_earlier", status: "drafted" });
    expect(result.message).toContain("closed");
    expect(result.message).toContain("by itself");
  }
  expect(await inboxJournals(f.service)).toHaveLength(6);
  // Naming the lines is what a person does to try them again, and they are tried.
  const named = await act(f, "inbox.post", { itemIds: [january[0]] });
  expect(named.results[0]).toMatchObject({ outcome: "failed", code: "posting_invalid" });
  // Returning a line to review clears what was kept against it.
  await act(f, "inbox.restore", { itemIds: january, reason: "period closed" });
  expect(january.every((id) => itemRow(f, id).post_error_code === null)).toBe(true);
});

test("a long list of lines left alone is named up to a hundred, and says how many more there are", async () => {
  const f = await ingestFixture();
  const january = await drafted(f, 105, 1, "JANUARY");
  await closeJanuary(f);
  const first = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 1000 });
  expect(first).toMatchObject({ applied: 0, failed: 105, remaining: 0 });
  const second = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 1000 });
  expect(second).toMatchObject({ applied: 0, failed: 0, skipped: 100, remaining: 0 });
  expect(second.results).toHaveLength(100);
  expect(second.results.at(-1).message).toContain("5 more lines that were refused before");
  // Every line is still there, and each is tried when it is named.
  expect(january).toHaveLength(105);
  const named = await act(f, "inbox.post", { itemIds: january.slice(100) });
  expect(named).toMatchObject({ applied: 0, failed: 5, skipped: 0 });
}, 60_000);

test("once the books change, a post by filter tries the lines it left alone again, without naming them", async () => {
  const f = await ingestFixture();
  const january = await drafted(f, 3, 1, "JANUARY");
  const late = await drafted(f, 2, 2, "LATE", 2027);
  await closeJanuary(f);
  // The two lines dated after the calendar's end grow it as they post; the three in the closed month fail.
  const first = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(first).toMatchObject({ applied: 2, failed: 3, remaining: 0 });
  expect((await f.call("periods.list")).body.data.calendar.lastDate).toBe("2027-12-31");
  // Those two postings changed the books, so the three are tried once more by themselves, and refused again.
  const second = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(second).toMatchObject({ applied: 0, failed: 3, skipped: 0, remaining: 0 });
  // Nothing changed in the books since: the three are left alone, and named.
  const third = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(third).toMatchObject({ applied: 0, failed: 0, skipped: 3, remaining: 0 });
  // The month is reopened. The three are tried again by themselves, since the books changed, and post.
  await reopenJanuary(f);
  const fourth = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(fourth).toMatchObject({ applied: 3, failed: 0, skipped: 0, remaining: 0 });
  const fifth = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(fifth).toMatchObject({ applied: 0, failed: 0, skipped: 0, remaining: 0 });
  expect(await inboxJournals(f.service)).toHaveLength(5);
  for (const id of [...january, ...late])
    expect(itemRow(f, id)).toMatchObject({ status: "posted", post_error: null });
});

test("lines whose last failure may pass are tried after the lines that have not failed", async () => {
  const f = await ingestFixture();
  const ids = await drafted(f, 5);
  // The first line failed before, but not in a way that is known to stand (a book that moved).
  f.service.store
    .query("UPDATE app_ingest_items SET post_error=? WHERE id=?")
    .run(
      "The ledger refused this entry: Command was evaluated against a stale book revision",
      ids[0] as string,
    );
  const first = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 3 });
  const posted = first.results.map((result: Json) => result.itemId);
  expect(posted).toEqual([ids[1], ids[2], ids[3]]);
  expect(first).toMatchObject({ applied: 3, remaining: 2 });
  const second = await act(f, "inbox.post", { filter: { status: ["drafted"] }, limit: 3 });
  expect(second.results.map((result: Json) => result.itemId)).toEqual([ids[4], ids[0]]);
  expect(second).toMatchObject({ applied: 2, remaining: 0 });
  expect(itemRow(f, ids[0] as string)).toMatchObject({ status: "posted", post_error: null });
});

test("a commit that went through but was never recorded, after a retry, is recognised and not repeated", async () => {
  const f = await ingestFixture();
  const [id] = await drafted(f, 1);
  // Attempt one met the race and was refused, as the old code left it.
  const refusedId = await refuseAsStale(f, id as string);
  const draft = draftOf(f, id as string);
  // The retry committed, and then the reply, or the Inbox's note of it, was lost.
  const reopened = await f.service.recoverDraft(
    draft.id,
    draft.version,
    refusedId,
    deriveUuid(["ingest.repost", draft.id, String(draft.version)]),
  );
  expect(reopened.version).toBe(2);
  const second = identity(reopened.id, 2);
  const prepared = await f.service.prepareDraft(reopened.id, 2, second);
  expect((await f.service.commitAction(second, prepared.planHash)).disposition).toBe("committed");
  expect(itemRow(f, id as string).status).toBe("drafted");
  const report = await act(f, "inbox.post", { itemIds: [id] });
  expect(report.results[0]).toMatchObject({
    outcome: "applied",
    status: "posted",
    operationId: second,
  });
  expect(await inboxJournals(f.service)).toHaveLength(1);
  expect(await refusals(f.service)).toHaveLength(1);
});

test("a posting whose reply was lost is resumed under the same identity and posted once", async () => {
  const f = await ingestFixture();
  const ids = await drafted(f, 2);
  // The ledger takes the first command and the answer never arrives.
  const original = f.service.ledger.execute.bind(f.service.ledger);
  let lost = true;
  f.service.ledger.execute = async (credential, command) => {
    const receipt = await original(credential, command);
    if (lost) {
      lost = false;
      throw new Error("the connection dropped");
    }
    return receipt;
  };
  const first = await act(f, "inbox.post", { itemIds: ids });
  f.service.ledger.execute = original;
  expect(first.results[0]).toMatchObject({ outcome: "failed", code: "posting_uncertain" });
  // The call stopped there: the second line was not touched.
  expect(first.results).toHaveLength(1);
  expect(first.remaining).toBe(1);
  expect(itemRow(f, ids[0] as string).status).toBe("drafted");
  const resumed = await act(f, "inbox.post", { itemIds: ids });
  expect(resumed).toMatchObject({ applied: 2, failed: 0 });
  expect(await inboxJournals(f.service)).toHaveLength(2);
  expect(await refusals(f.service)).toHaveLength(0);
  // The line that was uncertain was posted under the identity it started with, and its draft, which the
  // lost answer left in posting, is brought in line with the books.
  const draft = draftOf(f, ids[0] as string);
  expect(draft.version).toBe(1);
  expect(resumed.results[0].operationId).toBe(identity(draft.id, 1));
  expect(draft.status).toBe("posted");
  expect(draft.outcomeSequence).toBe(resumed.results[0].outcomeSequence);
});

test("a call gives a line a few evaluations, says when the book would not hold still, and tries again next time", async () => {
  const f = await ingestFixture();
  const [id, other] = await drafted(f, 2);
  const restore = interfere(f, Array(99).fill("time"));
  const busy = await act(f, "inbox.post", { itemIds: [id] });
  restore();
  expect(busy.results[0]).toMatchObject({ outcome: "failed", code: "posting_conflict" });
  expect(busy.results[0].message).toContain("post it again");
  // Four evaluations, four refusals that are only about the book moving, and a draft left open.
  const refused = await refusals(f.service);
  expect(refused).toHaveLength(4);
  for (const item of refused)
    expect(item.payload.originalResult).toMatchObject({
      diagnostics: [{ code: "temporal_semantics_violation" }],
    });
  expect(draftOf(f, id as string)).toMatchObject({ version: 5, status: "draft" });
  // The failure is shown on the line, and is not one that will stand: a post by filter tries it, after the clean line.
  expect(itemRow(f, id as string)).toMatchObject({ status: "drafted", post_error_code: null });
  expect(itemRow(f, id as string).post_error).toContain("post it again");
  const later = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(later.results.map((result: Json) => result.itemId)).toEqual([other, id]);
  expect(later).toMatchObject({ applied: 2, failed: 0 });
  expect(await inboxJournals(f.service)).toHaveLength(2);
});

test("lines that failed before this release are tried once more, and a failure that stands is then kept", async () => {
  const f = await ingestFixture();
  const january = await drafted(f, 1, 1, "JANUARY");
  const february = await drafted(f, 1, 2, "FEBRUARY");
  await closeJanuary(f);
  // As the old release left them: a failure on the line and no code for it.
  for (const id of [...january, ...february])
    f.service.store
      .query("UPDATE app_ingest_items SET post_error=?, post_error_code=NULL WHERE id=?")
      .run("The ledger refused this entry: an earlier refusal", id);
  const report = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(report).toMatchObject({ applied: 1, failed: 1, skipped: 0, remaining: 0 });
  expect(itemRow(f, february[0] as string)).toMatchObject({ status: "posted", post_error: null });
  expect(itemRow(f, january[0] as string)).toMatchObject({
    status: "drafted",
    post_error_code: "posting_invalid",
  });
});

/** `journal.post`: a draft, its preparation and its commit in one request.
 *
 * What these hold: it does what the three operations do, by the same checks and in the same words; it is
 * one operation with one identity, so a retry never posts twice and never makes a second draft; an error
 * the books raise once the draft is kept comes back with the draft, so that the next try edits it; and a
 * posting the ledger refuses leaves the draft reopened. */
import { afterEach, expect, test } from "bun:test";
import { postBulk } from "./support/bulk-book.ts";
import { type Fixture, type Json, closeFixtures, ingestFixture } from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

const uuid = () => crypto.randomUUID();

const lines = (amount: string) => [
  { accountId: "5000", debit: amount, credit: "" },
  { accountId: "1000", debit: "", credit: amount },
];
const entry = (reference: string, amount = "12.00", date = "2026-03-02") => ({
  date,
  reference,
  narration: reference,
  lines: lines(amount),
});

const ok = async (f: Fixture, name: string, input: unknown, operationId?: string) => {
  const reply = await f.call(name, input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};
const postOne = async (f: Fixture, data: unknown, extra: Json = {}, operationId = uuid()) =>
  ok(f, "journal.post", { data, ...extra }, operationId);

const journals = async (f: Fixture): Promise<Json[]> =>
  (await ok(f, "journal.list", { status: "Posted" })).entries;
const draftList = async (f: Fixture): Promise<Json[]> => (await ok(f, "drafts.list", {})).drafts;
const balance = async (f: Fixture, id: string): Promise<string> =>
  (await ok(f, "accounts.list", {})).accounts.find((account: Json) => account.id === id).balance;

test("one request saves the draft, prepares the posting and commits it, and the book is what the three operations leave", async () => {
  const f = await ingestFixture();
  const operationId = uuid();
  const result = await postOne(f, entry("one request"), {}, operationId);
  expect(result.refusal).toBeNull();
  expect(result.draft).toMatchObject({ version: 1, status: "posted", data: entry("one request") });
  expect(result.plan).toMatchObject({ disposition: "prepared", valid: true, kind: "postDraft" });
  expect(result.plan.effects.journals).toHaveLength(1);
  expect(result.receipt).toMatchObject({ disposition: "committed", problems: [] });
  expect(result.receipt.operationId).toBe(result.plan.planId);
  // The posting has an identity of its own, derived from the request's, and both can be asked about.
  expect(result.plan.planId).not.toBe(operationId);
  expect((await ok(f, "operations.get", { operationId: result.plan.planId })).disposition).toBe(
    "committed",
  );
  expect((await ok(f, "operations.get", { operationId })).disposition).toBe("completed");

  // The same entry the old way: a draft, a preparation, a commit.
  const draft = await ok(f, "drafts.create", { data: entry("three requests") }, uuid());
  const prepared = await ok(
    f,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: draft.version },
    uuid(),
  );
  const committed = await ok(f, "operations.commit", {
    planId: prepared.planId,
    planHash: prepared.planHash,
  });
  expect(committed.disposition).toBe("committed");
  const entries = await journals(f);
  expect(entries).toHaveLength(2);
  const shape = (item: Json) => ({
    date: item.date,
    type: item.type,
    amount: item.amount,
    lines: item.lines.map((line: Json) => ({
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
    })),
    status: item.status,
  });
  expect(shape(entries.find((item) => item.description === "one request") as Json)).toEqual(
    shape(entries.find((item) => item.description === "three requests") as Json),
  );
  // Two entries of 12.00 each: the account has been credited twice.
  expect(await balance(f, "5000")).toBe("24.00");
  expect(prepared.effects.journals[0].lines).toEqual(result.plan.effects.journals[0].lines);
  expect(Object.keys(prepared).sort()).toEqual(Object.keys(result.plan).sort());
  expect(Object.keys(committed).sort()).toEqual(Object.keys(result.receipt).sort());
  expect(await draftList(f)).toEqual([]);
});

test("sent again with the same identity it is the same answer: one entry, one draft", async () => {
  const f = await ingestFixture();
  const operationId = uuid();
  const first = await postOne(f, entry("once"), {}, operationId);
  const again = await postOne(f, entry("once"), {}, operationId);
  expect(again).toEqual(first);
  expect(await journals(f)).toHaveLength(1);
  expect(await draftList(f)).toEqual([]);
  // Other input under the same identity is refused, as for any write.
  const reused = await f.call("journal.post", { data: entry("other", "99.00") }, operationId);
  expect(reused.status).toBe(409);
  expect(reused.body.error.code).toBe("operation_identity_conflict");
  expect(await journals(f)).toHaveLength(1);
});

test("a request that stopped before the commit is finished by the same request, not repeated", async () => {
  const f = await ingestFixture();
  const operationId = uuid();
  const real = f.service.commitAction.bind(f.service);
  let first = true;
  // The ledger cannot be reached the first time.
  f.service.commitAction = async (id, hash) => {
    if (first) {
      first = false;
      throw new Error("the ledger is not answering");
    }
    return real(id, hash);
  };
  const lost = await f.call("journal.post", { data: entry("resumed") }, operationId);
  expect(lost.status).toBe(503);
  expect(lost.body.error.code).toBe("operation_unresolved");
  // What was done is there: the draft and the prepared plan, nothing posted.
  expect(await draftList(f)).toHaveLength(1);
  expect(await journals(f)).toHaveLength(0);
  // Sent again, it finds them and commits the same plan.
  const done = await postOne(f, entry("resumed"), {}, operationId);
  expect(done.receipt.disposition).toBe("committed");
  expect(await journals(f)).toHaveLength(1);
  expect(await draftList(f)).toEqual([]);
  const rows = f.service.store.query("SELECT count(*) AS n FROM app_drafts").get() as { n: number };
  expect(rows.n).toBe(1);
  const plans = f.service.store.query("SELECT count(*) AS n FROM app_actions").get() as {
    n: number;
  };
  expect(plans.n).toBe(1);
});

test("the checks and the words are those of the operations it stands for", async () => {
  const f = await ingestFixture();
  const same = async (data: unknown) => {
    const post = await f.call("journal.post", { data }, uuid());
    const draft = await f.call("drafts.create", { data }, uuid());
    expect(post.status).toBe(draft.status);
    expect(post.body.error?.code).toBe(draft.body.error?.code);
    expect(post.body.error?.message).toBe(draft.body.error?.message);
    expect(post.body.error?.details ?? []).toEqual(draft.body.error?.details ?? []);
    return post;
  };
  // Malformed against the contract.
  expect((await same({ ...entry("x"), date: "yesterday" })).status).toBe(400);
  expect((await same({ ...entry("x"), lines: [lines("1.00")[0]] })).status).toBe(400);
  expect((await same({ ...entry("x"), reference: "x", extra: true })).status).toBe(400);
  // The books' own checks come at the preparation. An entry that does not balance is kept as a draft and
  // refused there, with journal.prepare's words for the same draft, beside the draft.
  const unbalanced = {
    ...entry("unbalanced"),
    lines: [
      { accountId: "5000", debit: "10.00", credit: "" },
      { accountId: "1000", debit: "", credit: "9.00" },
    ],
  };
  const refused = await postOne(f, unbalanced);
  expect(refused.plan).toBeNull();
  expect(refused.receipt).toBeNull();
  expect(refused.draft).toMatchObject({ version: 1, status: "draft" });
  const prepare = await f.call(
    "journal.prepare",
    { draftId: refused.draft.id, expectedVersion: refused.draft.version },
    uuid(),
  );
  expect(prepare.status).toBe(400);
  expect(refused.refusal).toEqual({
    code: prepare.body.error.code,
    message: prepare.body.error.message,
    details: prepare.body.error.details,
    retryable: prepare.body.error.retryable,
  });
  expect(refused.refusal.code).toBe("journal_unbalanced");
  expect(await draftList(f)).toHaveLength(1);
  // Nothing was posted by any of those, and the malformed ones kept no draft.
  expect(await journals(f)).toHaveLength(0);
});

test("a plan that is not valid is the plan, nothing is committed, and the draft is the caller's to edit", async () => {
  const f = await ingestFixture();
  // An account closed from March: the preview says the entry cannot be posted to it.
  const closing = await ok(
    f,
    "accounts.prepareChange",
    { accountId: "5100", name: "Meals", close: true, effectiveOn: "2026-03-01" },
    uuid(),
  );
  await ok(f, "operations.commit", { planId: closing.planId, planHash: closing.planHash });
  const toMeals = (account: string) => ({
    ...entry("meals", "10.00", "2026-03-10"),
    lines: [
      { accountId: account, debit: "10.00", credit: "" },
      { accountId: "1000", debit: "", credit: "10.00" },
    ],
  });
  const refused = await postOne(f, toMeals("5100"));
  expect(refused.plan).toMatchObject({ disposition: "prepared", valid: false });
  expect(refused.plan.problems.map((problem: Json) => problem.code)).toEqual([
    "invalid_chart_or_account",
  ]);
  expect(refused.receipt).toBeNull();
  expect(refused.refusal).toBeNull();
  expect(refused.draft).toMatchObject({ version: 1, status: "draft" });
  expect(await journals(f)).toHaveLength(0);
  expect(await draftList(f)).toHaveLength(1);
  // What journal.prepare says of the same draft is what the plan says.
  const prepared = await ok(
    f,
    "journal.prepare",
    { draftId: refused.draft.id, expectedVersion: refused.draft.version },
    uuid(),
  );
  expect(prepared.valid).toBe(false);
  expect(prepared.problems).toEqual(refused.plan.problems);
  expect(prepared.diagnostics).toEqual(refused.plan.diagnostics);
  // Corrected and sent again with the draft it holds: the same draft, one version on, posted.
  const held = refused.draft;
  const fixed = await postOne(f, toMeals("5000"), {
    draftId: held.id,
    expectedVersion: held.version,
  });
  expect(fixed.draft.id).toBe(held.id);
  expect(fixed.draft.version).toBe(held.version + 1);
  expect(fixed.receipt.disposition).toBe("committed");
  expect(await draftList(f)).toEqual([]);
  expect(await journals(f)).toHaveLength(1);
});

test("a date after the calendar's end posts, growing the calendar; one before its first day comes back with the draft and the words the preparation uses", async () => {
  const f = await ingestFixture();
  const far = entry("far away", "7.00", "2029-06-01");
  const posted = await f.call("journal.post", { data: far }, uuid());
  expect(posted.body.ok, JSON.stringify(posted.body)).toBe(true);
  expect(posted.body.data.refusal).toBeNull();
  expect(posted.body.data.receipt).toMatchObject({ disposition: "committed" });
  expect(await journals(f)).toHaveLength(1);
  expect((await f.call("periods.list")).body.data.calendar.lastDate).toBe("2029-12-31");
  const early = entry("too early", "7.00", "2025-12-30");
  const post = await f.call("journal.post", { data: early }, uuid());
  expect(post.body.ok, JSON.stringify(post.body)).toBe(true);
  const result = post.body.data as Json;
  expect(result.plan).toBeNull();
  expect(result.receipt).toBeNull();
  expect(result.refusal).toMatchObject({ code: "calendar_not_configured" });
  expect(result.refusal.message).toContain("before the first day");
  expect(result.draft.status).toBe("draft");
  // The words are those of journal.prepare for the same draft.
  const prepared = await f.call(
    "journal.prepare",
    { draftId: result.draft.id, expectedVersion: result.draft.version },
    uuid(),
  );
  expect(prepared.body.error.code).toBe(result.refusal.code);
  expect(prepared.body.error.message).toBe(result.refusal.message);
  expect(prepared.body.error.details).toEqual(result.refusal.details);
  // The draft is kept (not lost to the error), once.
  expect(await draftList(f)).toHaveLength(1);
});

test("a posting the ledger refuses is the receipt, and the draft is reopened for a second try", async () => {
  const f = await ingestFixture();
  const real = f.service.commitAction.bind(f.service);
  // Another entry lands between the preparation and the commit: the plan is for a book that has moved.
  f.service.commitAction = async (id, hash) => {
    await postBulk(f.service, 1);
    return real(id, hash);
  };
  const result = await postOne(f, entry("outrun"));
  expect(result.plan.valid).toBe(true);
  expect(result.receipt.disposition).toBe("rejected");
  expect(result.receipt.problems.length).toBeGreaterThan(0);
  expect(result.refusal).toBeNull();
  // The draft is reopened at the next version, as drafts.recover leaves it, and records why.
  expect(result.draft).toMatchObject({ version: 2, status: "draft" });
  expect(result.draft.recoveredFromOperationId).toBe(result.plan.planId);
  const before = (await journals(f)).length;
  // A second try, with the draft it holds, posts it.
  f.service.commitAction = real;
  const second = await postOne(f, entry("outrun"), {
    draftId: result.draft.id,
    expectedVersion: result.draft.version,
  });
  expect(second.receipt.disposition).toBe("committed");
  expect(second.draft.id).toBe(result.draft.id);
  expect(second.draft.version).toBe(2);
  expect((await journals(f)).length).toBe(before + 1);
  expect(await draftList(f)).toEqual([]);
});

test("a draft the caller holds is edited if the words changed and left alone if they did not", async () => {
  const f = await ingestFixture();
  const zero = await postOne(f, entry("held", "8.00", "2025-06-01"));
  const held = zero.draft;
  expect(zero.refusal).not.toBeNull();
  // The same words: the draft keeps its version, and is prepared as it is.
  const same = await postOne(f, entry("held", "8.00", "2025-06-01"), {
    draftId: held.id,
    expectedVersion: held.version,
  });
  expect(same.draft.version).toBe(held.version);
  expect(same.refusal).not.toBeNull();
  // Other words: the next version.
  const edited = await postOne(f, entry("held", "8.00", "2026-04-02"), {
    draftId: held.id,
    expectedVersion: held.version,
  });
  expect(edited.draft.version).toBe(held.version + 1);
  expect(edited.receipt.disposition).toBe("committed");
  // A draft that has changed under the caller is a conflict, the words drafts.save uses.
  const stale = await f.call(
    "journal.post",
    { data: entry("held", "9.00"), draftId: held.id, expectedVersion: held.version },
    uuid(),
  );
  const save = await f.call(
    "drafts.save",
    { draftId: held.id, expectedVersion: held.version, data: entry("held", "9.00") },
    uuid(),
  );
  expect(stale.status).toBe(save.status);
  expect(stale.body.error.code).toBe(save.body.error.code);
  expect(stale.body.error.message).toBe(save.body.error.message);
  // A draft id with no version, or a version with no draft id, is a malformed request.
  for (const extra of [{ draftId: held.id }, { expectedVersion: 1 }]) {
    const bad = await f.call("journal.post", { data: entry("held"), ...extra }, uuid());
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
  }
});

test("it needs the permission to post and the permission to draft", async () => {
  const f = await ingestFixture();
  const call = (permissions: readonly string[]) =>
    f.call("journal.post", { data: entry("allowed") }, uuid(), permissions as never);
  expect((await call(["read", "draft"])).status).toBe(403);
  const noDraft = await call(["read", "post"]);
  expect(noDraft.status).toBe(403);
  expect(noDraft.body.error.message).toBe("This operation requires draft permission");
  expect(await draftList(f)).toEqual([]);
  expect((await call(["read", "draft", "post"])).status).toBe(200);
  expect(await journals(f)).toHaveLength(1);
});

test("it is a write the host logs: the catalog says so, and a read is not mistaken for it", async () => {
  const f = await ingestFixture();
  const schema = (await ok(f, "capabilities.get", {})).operations as Json[];
  const posted = schema.find((operation) => operation.name === "journal.post");
  expect(posted).toMatchObject({ writes: true, permission: "post" });
  const { changesBook } = await import("../src/local/hosted.ts");
  const request = (name: string) =>
    new Request(`http://127.0.0.1/v1/${name}`, { method: "POST", body: "{}" });
  expect(changesBook(request("journal.post"))).toBe(true);
  expect(changesBook(request("journal.list"))).toBe(false);
});

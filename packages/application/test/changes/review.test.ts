/** `changes.review`: a person says they have looked at the changes up to a point. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Caller,
  type Json,
  type MonthBook,
  agentCaller,
  memberCaller,
  monthBook,
  serviceCaller,
} from "./support.ts";

let m: MonthBook;
let accountant: Caller;
let agent: Awaited<ReturnType<typeof agentCaller>>;

async function post(who: Caller, narration: string, amount = "10.00"): Promise<void> {
  const done = await who.ok("journal.post", {
    data: {
      date: "2026-03-25",
      reference: narration.slice(0, 20),
      narration,
      lines: [
        { accountId: "6200", debit: amount, credit: "" },
        { accountId: "1000", debit: "", credit: amount },
      ],
    },
  });
  expect(done.receipt.disposition).toBe("committed");
}

beforeAll(async () => {
  m = await monthBook();
  accountant = await memberCaller(m.world, "user_0000000003", "accountant");
  agent = await agentCaller(m.world, "weekly-run", ["read", "draft", "post", "close"]);
}, 120_000);
afterAll(() => m?.close());

const reviews = () =>
  m.world.service.store.query("SELECT COUNT(*) AS n FROM changes_reviews").get() as { n: number };

describe("who may say they have looked", () => {
  test("an agent may not mark changes as looked at, even with every permission, and nothing is recorded", async () => {
    const before = reviews().n;
    const refused = await agent.call("changes.review", {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("review_needs_a_person");
    expect(refused.body.error.message).toMatch(/agent cannot mark its own work/);
    expect(reviews().n).toBe(before);
    const listed = await m.owner.ok("changes.list", { pageSize: 1 });
    expect(listed.lastReview).toBeNull();
  });

  test("an agent without the permission is refused by the permission first", async () => {
    const reader = await agentCaller(m.world, "reader", ["read", "draft"]);
    const refused = await reader.call("changes.review", {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("permission_denied");
  });

  test("the control plane is not a person either", async () => {
    const refused = await serviceCaller(m.world).call("changes.review", {});
    expect(refused.status).toBe(403);
    expect(reviews().n).toBe(0);
  });

  test("a member with the permission to close is refused while a part of the list is hidden from them", async () => {
    // Who has access is read with the permission to manage access, which only the owner has. An
    // accountant reads a list with that part left out (said, not a failure), and the next list starts
    // after the point they name: what they did not see would never be shown to anyone, so they cannot say
    // they looked.
    const seen = await accountant.ok("changes.list", { pageSize: 1 });
    expect(seen.sources.filter((source: Json) => !source.read)).toEqual([]);
    expect(
      seen.sources.filter((source: Json) => source.withheld).map((source: Json) => source.name),
    ).toEqual(["access"]);
    const refused = await accountant.call("changes.review", {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("review_incomplete");
    expect(refused.body.error.message).toMatch(/Who has access\) is shown only to the owner/);
    expect(reviews().n).toBe(0);
    const listed = await m.owner.ok("changes.list", { pageSize: 1 });
    expect(listed.lastReview).toBeNull();
  });

  test("the owner may, and is recorded as themselves", async () => {
    const done = await m.owner.ok("changes.review", { note: "Looked at the opening month" });
    expect(done.by).toEqual({ kind: "owner", label: "owner" });
    expect(done.note).toBe("Looked at the opening month");
    expect(done.seq).toBe(1);
    const listed = await m.owner.ok("changes.list", { pageSize: 1 });
    expect(listed.lastReview).toEqual(done);
  });

  test("a member who may not close is refused", async () => {
    const member = await memberCaller(m.world, "user_0000000004", "member");
    const refused = await member.call("changes.review", {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("permission_denied");
  });
});

describe("what a review covers", () => {
  test("the list that starts since the last look begins after the point that was looked at", async () => {
    const listed = await m.owner.ok("changes.list", { since: "lastReview", pageSize: 5 });
    // Everything up to the review was looked at: the book has not changed since.
    expect(listed.changes).toEqual([]);
    expect(listed.count).toBe(0);
    expect(listed.window.since).toMatch(
      /^the last time the changes were marked as looked at \(Apr 2, 2026\)$/,
    );
    m.advance();
    await post(agent, "Agent entry after the look", "21.00");
    await post(m.owner, "Owner entry after the look", "22.00");
    const after = await m.owner.ok("changes.list", { since: "lastReview" });
    expect(after.changes.map((c: Json) => c.entry.description)).toEqual([
      "Owner entry after the look",
      "Agent entry after the look",
    ]);
    expect(after.actors.map((a: Json) => [a.by.label, a.count]).sort()).toEqual([
      ["owner", 1],
      ["weekly-run", 1],
    ]);
  });

  test("a review of the list that was read leaves later changes unreviewed", async () => {
    const read = await m.owner.ok("changes.list", { since: "lastReview" });
    expect(read.count).toBe(2);
    m.advance();
    await post(agent, "Agent entry while the owner was reading", "23.00");
    const done = await m.owner.ok("changes.review", {
      upToRevision: read.revision,
      upToAt: read.asOf,
    });
    expect(done).toMatchObject({
      upToRevision: read.revision,
      upToAt: read.asOf,
      by: { kind: "owner" },
    });
    const left = await m.owner.ok("changes.list", { since: "lastReview" });
    expect(left.changes.map((c: Json) => c.entry.description)).toEqual([
      "Agent entry while the owner was reading",
    ]);
  });

  test("the point may not be later than the book's, and a time in the future is now", async () => {
    const head = Number((await m.owner.ok("changes.list", { pageSize: 1 })).revision);
    const refused = await m.owner.call("changes.review", { upToRevision: String(head + 1) });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("invalid_input");
    const done = await m.owner.ok("changes.review", { upToAt: "2099-01-01T00:00:00.000Z" });
    expect(done.upToAt).toBe(new Date(m.world.clock.ms).toISOString());
    expect(done.upToRevision).toBe(String(head));
  });

  test("a review that would go back is refused, so a stale page cannot un-look at changes", async () => {
    const newest = await m.owner.ok("changes.list", { pageSize: 1 });
    const refused = await m.owner.call("changes.review", {
      upToRevision: String(Number(newest.revision) - 1),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("review_out_of_date");
    const stale = await m.owner.call("changes.review", {
      upToRevision: newest.revision,
      upToAt: "2026-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(409);
    // The newest record stands.
    expect((await m.owner.ok("changes.list", { pageSize: 1 })).lastReview.upToRevision).toBe(
      newest.revision,
    );
  });
});

describe("a record that is kept", () => {
  test("is added and never changed: every review stays, newest last", async () => {
    const rows = m.world.service.store
      .query("SELECT seq, principal, label, up_to_revision FROM changes_reviews ORDER BY seq")
      .all() as { seq: number; principal: string; label: string; up_to_revision: string }[];
    expect(rows.map((r) => r.principal)).toEqual(["owner", "owner", "owner"]);
    expect(rows.map((r) => Number(r.up_to_revision))).toEqual(
      [...rows.map((r) => Number(r.up_to_revision))].sort((a, b) => a - b),
    );
    expect(() => m.world.service.store.query("SELECT 1 FROM changes_reviews").all()).not.toThrow();
  });

  test("asking again with the same identity returns the first record and adds none", async () => {
    const id = crypto.randomUUID();
    const first = await m.owner.ok("changes.review", { note: "Once" }, id);
    const before = reviews().n;
    const again = await m.owner.ok("changes.review", { note: "Once" }, id);
    expect(again).toEqual(first);
    expect(reviews().n).toBe(before);
    const other = await m.owner.call("changes.review", { note: "Twice" }, id);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("operation_identity_conflict");
  });

  test("asking again for a look that was recorded returns it, whatever can be read at the second asking", async () => {
    // A reply lost on its way is asked for again with the same identity. If a part of the list cannot be read
    // the second time (here, a caller who may not read who has access), that must not turn a look that
    // happened into a refusal: the record is returned as it was made, and none is added.
    const id = crypto.randomUUID();
    const first = await m.owner.ok("changes.review", { note: "Recorded first" }, id);
    const before = reviews().n;
    const again = await accountant.call("changes.review", { note: "Recorded first" }, id);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first);
    expect(reviews().n).toBe(before);
    // The same words without that identity are refused for that caller, as they were.
    const fresh = await accountant.call("changes.review", { note: "Recorded first" });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe("review_incomplete");
  });

  test("a note is plain and short", async () => {
    const done = await m.owner.ok("changes.review", {
      note: "Looked‮ at it\u0000 \n   twice",
    });
    expect(done.note).toBe("Looked at it twice");
  });
});

/** `commitAction` keeps who asked for each command, beside the command. These are the rules of that
 * record: when it is written, whose it is when two ask, and what is true of a command the ledger
 * refused. Who made which kind of change, by which path, is `first-step.test.ts`. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Json, type MonthBook, monthBook } from "./support.ts";

let m: MonthBook;
beforeAll(async () => {
  m = await monthBook();
}, 120_000);
afterAll(() => m?.close());

const row = (id: string) =>
  m.world.service.store
    .query("SELECT principal, label, operation, at FROM changes_commits WHERE action_id=?")
    .get(id) as { principal: string; label: string; operation: string; at: string } | null;

let n = 0;
async function plan(code?: string): Promise<Json> {
  n += 1;
  const when = (await m.owner.ok("accounts.list")).suggestedEffectiveOn as string;
  return m.owner.ok("accounts.prepareCreate", {
    code: code ?? `7${String(n).padStart(3, "0")}`,
    name: `Account ${n}`,
    role: "expense",
    effectiveOn: when,
  });
}

describe("the record of who asked", () => {
  test("is written when the command is sent, with the time of the commit and not of the plan", async () => {
    const prepared = await plan();
    expect(row(prepared.planId)).toBeNull();
    m.advance(30);
    const committedAt = new Date(m.world.clock.ms).toISOString();
    const receipt = await m.world.service.commitAction(prepared.planId, prepared.planHash, {
      by: "agent:0123456789abcdef",
      operation: "operations.commit",
    });
    expect(receipt.disposition).toBe("committed");
    expect(row(prepared.planId)).toEqual({
      principal: "agent:0123456789abcdef",
      label: "agent 01234567",
      operation: "operations.commit",
      at: committedAt,
    });
    const [change] = (await m.owner.ok("changes.list", { pageSize: 1 })).changes as Json[];
    // The plan was made half an hour before; the change is dated when it was committed.
    expect(change.at).toBe(committedAt);
    expect(change.by).toEqual({ kind: "agent", label: "agent 01234567", id: "0123456789abcdef" });
  });

  test("keeps the first to ask: a second commit of a command that was sent only reconciles it", async () => {
    const prepared = await plan();
    const first = await m.world.service.commitAction(prepared.planId, prepared.planHash, {
      by: "owner",
      operation: "operations.commit",
    });
    m.advance(5);
    const again = await m.world.service.commitAction(prepared.planId, prepared.planHash, {
      by: "member:user_0000000009",
      operation: "inbox.post",
    });
    expect(again).toEqual(first);
    expect(row(prepared.planId)).toMatchObject({
      principal: "owner",
      operation: "operations.commit",
    });
    const count = m.world.service.store
      .query("SELECT COUNT(*) AS n FROM changes_commits WHERE action_id=?")
      .get(prepared.planId) as { n: number };
    expect(count.n).toBe(1);
  });

  test("a command committed with nobody named leaves no row, and its change says not recorded", async () => {
    const prepared = await plan();
    await m.world.service.commitAction(prepared.planId, prepared.planHash);
    expect(row(prepared.planId)).toBeNull();
    const [change] = (await m.owner.ok("changes.list", { pageSize: 1 })).changes as Json[];
    expect(change.by).toEqual({ kind: "unknown", label: "not recorded" });
  });

  test("a command the ledger refuses leaves a row that nothing reads, and no change", async () => {
    const stale = await plan();
    const other = await plan();
    await m.world.service.commitAction(other.planId, other.planHash, {
      by: "owner",
      operation: "operations.commit",
    });
    const before = await m.owner.ok("changes.list", { pageSize: 1 });
    // Made against the book as it was before the other one: the ledger turns it down.
    const refused = await m.world.service.commitAction(stale.planId, stale.planHash, {
      by: "owner",
      operation: "operations.commit",
    });
    expect(refused.disposition).toBe("rejected");
    expect(row(stale.planId)).not.toBeNull();
    const after = await m.owner.ok("changes.list", { pageSize: 1 });
    expect(after.revision).toBe(before.revision);
    expect(after.count).toBe(before.count);
    expect(after.changes[0].id).toBe(before.changes[0].id);
    // And the first change the book recorded a maker for is still the book's own first.
    expect(after.attribution).toMatchObject({ fromRevision: "1" });
  });

  test("a plan whose hash does not match is refused before anything is kept", async () => {
    const prepared = await plan();
    await expect(
      m.world.service.commitAction(prepared.planId, "0".repeat(64), {
        by: "owner",
        operation: "operations.commit",
      }),
    ).rejects.toThrow(/does not match the reviewed plan/);
    expect(row(prepared.planId)).toBeNull();
  });
});

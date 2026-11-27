import { afterEach, expect, test } from "bun:test";
import { NUL, RIGHT_TO_LEFT_OVERRIDE } from "./fixtures/hostile.ts";
import { githubRule, rulesBook } from "./fixtures/rules-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture() {
  const f = await rulesBook({ clean: (work) => cleanup.push(work) });
  await f.setup();
  return f;
}

test("who made a rule is decided by the runtime: a token is always that agent, the owner is a person unless it says otherwise", async () => {
  const f = await fixture();
  // The owner's own access: a person by default, and an agent only if it says so.
  const byDefault = await f.write("rules.create", { rule: githubRule({ name: "Default" }) });
  expect(byDefault.createdBy).toEqual({ kind: "person" });
  const said = await f.write("rules.create", {
    rule: githubRule({ name: "Said" }),
    madeBy: { kind: "agent", name: "claude-code" },
  });
  expect(said.createdBy).toEqual({ kind: "agent", name: "claude-code" });
  // A claimed name is text, not markup: control and direction characters are stripped.
  const hostile = await f.write("rules.create", {
    rule: githubRule({ name: "Hostile" }),
    madeBy: { kind: "agent", name: `evil${RIGHT_TO_LEFT_OVERRIDE}\nname${NUL}` },
  });
  expect(hostile.createdBy).toEqual({ kind: "agent", name: "evil name" });

  // A scoped token is an agent whatever the request says: it cannot present itself as a person.
  const bookkeeper = await f.token(["read", "draft"], "Weekly close agent");
  const asToken = async (name: string, input: unknown) => {
    const reply = await f.as(bookkeeper.secret, name, input, crypto.randomUUID());
    expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
    return reply.body.data;
  };
  const recorded = { kind: "agent", name: `Weekly close agent (agent:${bookkeeper.id})` };
  const created = await asToken("rules.create", {
    rule: githubRule({ name: "By token" }),
    madeBy: { kind: "person" },
  });
  expect(created.createdBy).toEqual(recorded);
  expect(created.updatedBy).toEqual(recorded);
  // Claiming to be another agent does not work either: the token's own identity is recorded.
  const posing = await asToken("rules.create", {
    rule: githubRule({ name: "Posing" }),
    madeBy: { kind: "agent", name: "somebody else" },
  });
  expect(posing.createdBy).toEqual(recorded);
  // Omitting madeBy is fine for a token, and gives the same record.
  const omitted = await asToken("rules.create", { rule: githubRule({ name: "Omitted" }) });
  expect(omitted.createdBy).toEqual(recorded);

  // Every kind of change by a token is attributed to it.
  const updated = await asToken("rules.update", {
    ruleId: byDefault.id,
    expectedRevision: 1,
    rule: githubRule({ name: "Default, renamed" }),
    madeBy: { kind: "person" },
  });
  expect(updated.createdBy).toEqual({ kind: "person" });
  expect(updated.updatedBy).toEqual(recorded);
  const listed = await f.read("rules.list");
  const ids = listed.rules.map((rule: { id: string }) => rule.id);
  const reordered = await asToken("rules.reorder", {
    expectedRulesRevision: listed.rulesRevision,
    orderedRuleIds: [...ids].reverse(),
    madeBy: { kind: "person" },
  });
  expect(reordered.orderedBy).toEqual(recorded);
  const removed = await asToken("rules.delete", {
    ruleId: said.id,
    expectedRevision: 1,
    madeBy: { kind: "person" },
    reason: "Duplicate",
  });
  expect(removed.updatedBy).toEqual(recorded);
  const history = (await f.read("rules.get", { ruleId: byDefault.id })).history;
  expect(history.map((entry: { madeBy: unknown }) => entry.madeBy)).toEqual([
    { kind: "person" },
    recorded,
  ]);
});

test("a token does only what its permissions allow, and can read who made each rule", async () => {
  const f = await fixture();
  await f.write("rules.create", {
    rule: githubRule(),
    madeBy: { kind: "agent", name: "claude-code" },
  });
  const drafter = await f.token(["read", "draft"], "Drafter");
  // Changing what the classifier is willing to suggest is configuration; a drafter cannot.
  const denied = await f.as(
    drafter.secret,
    "classifier.configure",
    { enabled: false },
    crypto.randomUUID(),
  );
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("permission_denied");
  const reader = await f.token(["read"], "Reader");
  const refused = await f.as(
    reader.secret,
    "rules.create",
    { rule: githubRule({ name: "Nope" }) },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(403);
  expect((await f.read("rules.list")).count).toBe(1);
  // A read-only token can still read the rules, who made them, and test one without saving it.
  const listed = await f.as(reader.secret, "rules.list");
  expect(listed.body.ok).toBe(true);
  expect(listed.body.data.rules[0].createdBy).toEqual({ kind: "agent", name: "claude-code" });
  const tested = await f.as(reader.secret, "rules.test", { rule: githubRule() });
  expect(tested.body.ok).toBe(true);
  // A revoked token stops working at once.
  const revoke = await f.call("tokens.revoke", { tokenId: drafter.id }, crypto.randomUUID());
  expect(revoke.body.ok, JSON.stringify(revoke.body)).toBe(true);
  const after = await f.as(
    drafter.secret,
    "rules.create",
    { rule: githubRule({ name: "After revoke" }) },
    crypto.randomUUID(),
  );
  expect(after.status).toBe(401);
});

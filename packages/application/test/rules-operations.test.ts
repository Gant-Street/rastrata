import { afterEach, expect, test } from "bun:test";
import { agent, author, githubRule, rulesBook } from "./fixtures/rules-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture() {
  const f = await rulesBook({ clean: (work) => cleanup.push(work) });
  await f.setup();
  return f;
}

test("a rule is created with who made it and when, and read back exactly", async () => {
  const f = await fixture();
  const created = await f.write("rules.create", { rule: githubRule(), madeBy: agent });
  expect(created.status).toBe("active");
  expect(created.priority).toBe(1);
  expect(created.revision).toBe(1);
  expect(created.createdBy).toEqual({ kind: "agent", name: "claude-code" });
  expect(created.createdAt).toMatch(/^2026-04-01T09:00:/);
  expect(created.enabled).toBe(true);
  expect(created.match).toBe("all");
  expect(created.accountIds).toEqual([]);
  expect(created.problems).toEqual([]);
  const listed = await f.read("rules.list");
  expect(listed.count).toBe(1);
  expect(listed.enabled).toBe(1);
  expect(listed.rules[0]).toEqual(created);
  const detail = await f.read("rules.get", { ruleId: created.id });
  expect(detail.rule).toEqual(created);
  expect(detail.history).toEqual([
    {
      revision: 1,
      madeBy: { kind: "agent", name: "claude-code" },
      madeAt: created.createdAt,
      changed: ["created"],
    },
  ]);
});

test("a write retried under the same identity returns the first result and never repeats", async () => {
  const f = await fixture();
  const identity = crypto.randomUUID();
  const input = { rule: githubRule(), madeBy: author };
  const first = await f.call("rules.create", input, identity);
  const again = await f.call("rules.create", input, identity);
  expect(again).toEqual(first);
  expect((await f.read("rules.list")).count).toBe(1);
  const different = await f.call(
    "rules.create",
    { rule: githubRule({ name: "Other" }), madeBy: author },
    identity,
  );
  expect(different.status).toBe(409);
  expect(different.body.error.code).toBe("operation_identity_conflict");
  await f.restart();
  expect(await f.call("rules.create", input, identity)).toEqual(first);
  expect((await f.read("rules.list")).count).toBe(1);
});

test("rules need an identity, and read access cannot write", async () => {
  const f = await fixture();
  const input = { rule: githubRule(), madeBy: author };
  expect((await f.call("rules.create", input)).body.error.code).toBe("operation_id_required");
  expect((await f.call("rules.create", input, crypto.randomUUID(), ["read"])).status).toBe(403);
  expect((await f.call("rules.create", input, crypto.randomUUID(), ["draft"])).body.ok).toBe(true);
  for (const name of ["rules.list", "rules.test", "classifier.status", "classifier.evaluate"])
    expect(
      (await f.call(name, name === "rules.test" ? { rule: githubRule() } : {}, undefined, ["read"]))
        .status,
      name,
    ).toBe(200);
  const suggestion = await f.call(
    "rules.suggest",
    { description: "GITHUB", amount: "-4.00" },
    undefined,
    ["read"],
  );
  expect(suggestion.status).toBe(200);
  // Changing what the classifier is willing to suggest is configuration, not drafting.
  expect(
    (await f.call("classifier.configure", { minAgreement: 80 }, crypto.randomUUID(), ["draft"]))
      .status,
  ).toBe(403);
  expect(
    (await f.call("classifier.configure", { minAgreement: 80 }, crypto.randomUUID(), ["configure"]))
      .body.ok,
  ).toBe(true);
  expect((await f.call("classifier.train", {}, crypto.randomUUID(), ["draft"])).body.ok).toBe(true);
});

test("an unusable rule is refused with every problem and its path", async () => {
  const f = await fixture();
  const reply = await f.call(
    "rules.create",
    {
      rule: {
        name: "Bad",
        conditions: [
          { field: "description", operator: "contains", value: "***" },
          { field: "amount", operator: "range", min: "9.00", max: "1.00" },
        ],
        action: { kind: "categorize", accountId: "nowhere" },
      },
      madeBy: author,
    },
    crypto.randomUUID(),
  );
  expect(reply.status).toBe(400);
  expect(reply.body.error.code).toBe("rule_invalid");
  const paths = reply.body.error.details.map((detail: { path: string }) => detail.path);
  expect(paths).toContain("input.rule.conditions[0].value");
  expect(paths).toContain("input.rule.conditions[1].max");
  expect(paths).toContain("input.rule.action.accountId");
  expect((await f.read("rules.list")).count).toBe(0);
  // Unknown fields, regular-expression-looking operators and oversized values never reach the engine.
  for (const bad of [
    { ...githubRule(), extra: true },
    githubRule({ conditions: [{ field: "description", operator: "regex", value: "a.*" }] }),
    githubRule({
      conditions: [{ field: "description", operator: "contains", value: "x".repeat(201) }],
    }),
    githubRule({ name: "" }),
    githubRule({
      conditions: Array.from({ length: 21 }, () => ({
        field: "description",
        operator: "contains",
        value: "x",
      })),
    }),
  ]) {
    const refused = await f.call(
      "rules.create",
      { rule: bad, madeBy: author },
      crypto.randomUUID(),
    );
    expect(refused.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
  }
});

test("a closed account stops a rule from being saved, and later flags a saved one", async () => {
  const f = await fixture();
  const kept = await f.write("rules.create", {
    rule: githubRule({ action: { kind: "categorize", accountId: "6900" } }),
    madeBy: author,
  });
  expect(kept.problems).toEqual([]);
  const closing = (
    await f.call(
      "accounts.prepareChange",
      { accountId: "6900", name: "Old software", close: true, effectiveOn: "2026-02-01" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(
    (await f.call("operations.commit", { planId: closing.planId, planHash: closing.planHash })).body
      .data.disposition,
  ).toBe("committed");
  const listed = await f.read("rules.list");
  expect(listed.rules[0].problems[0].message).toContain("closed");
  expect(listed.rules[0].problems[0].path).toBe("action.accountId");
  const refused = await f.call(
    "rules.create",
    { rule: githubRule({ action: { kind: "categorize", accountId: "6900" } }), madeBy: author },
    crypto.randomUUID(),
  );
  expect(refused.body.error.code).toBe("rule_invalid");
});

test("updating needs the revision you read, keeps every revision, and ignores a no-op", async () => {
  const f = await fixture();
  const created = await f.write("rules.create", { rule: githubRule(), madeBy: author });
  const renamed = await f.write("rules.update", {
    ruleId: created.id,
    expectedRevision: 1,
    rule: githubRule({ name: "GitHub subscriptions", enabled: false }),
    madeBy: agent,
  });
  expect(renamed.revision).toBe(2);
  expect(renamed.name).toBe("GitHub subscriptions");
  expect(renamed.enabled).toBe(false);
  expect(renamed.createdBy).toEqual({ kind: "person" });
  expect(renamed.updatedBy).toEqual({ kind: "agent", name: "claude-code" });
  const stale = await f.call(
    "rules.update",
    {
      ruleId: created.id,
      expectedRevision: 1,
      rule: githubRule({ name: "Third" }),
      madeBy: author,
    },
    crypto.randomUUID(),
  );
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe("rule_revision_conflict");
  expect(stale.body.error.message).toContain("revision 2");
  const same = await f.write("rules.update", {
    ruleId: created.id,
    expectedRevision: 2,
    rule: githubRule({ name: "GitHub subscriptions", enabled: false }),
    madeBy: author,
  });
  expect(same.revision).toBe(2);
  const detail = await f.read("rules.get", { ruleId: created.id });
  expect(
    detail.history.map((entry: { revision: number; changed: string[] }) => [
      entry.revision,
      entry.changed,
    ]),
  ).toEqual([
    [1, ["created"]],
    [2, ["name", "enabled"]],
  ]);
  expect(
    (
      await f.call(
        "rules.update",
        { ruleId: "missing", expectedRevision: 1, rule: githubRule(), madeBy: author },
        crypto.randomUUID(),
      )
    ).body.error.code,
  ).toBe("rule_not_found");
});

test("deleting retires a rule but keeps its history, and it cannot be edited afterwards", async () => {
  const f = await fixture();
  const created = await f.write("rules.create", { rule: githubRule(), madeBy: author });
  const removed = await f.write("rules.delete", {
    ruleId: created.id,
    expectedRevision: 1,
    madeBy: author,
    reason: "Replaced by the Stripe rule",
  });
  expect(removed.status).toBe("deleted");
  expect(removed.priority).toBe(0);
  expect(removed.revision).toBe(2);
  expect((await f.read("rules.list")).count).toBe(0);
  const retired = await f.read("rules.list", { status: "deleted" });
  expect(retired.count).toBe(1);
  expect(retired.rules[0].id).toBe(created.id);
  const detail = await f.read("rules.get", { ruleId: created.id });
  expect(detail.history[1]).toMatchObject({
    revision: 2,
    changed: ["deleted"],
    note: "Replaced by the Stripe rule",
  });
  const edit = await f.call(
    "rules.update",
    { ruleId: created.id, expectedRevision: 2, rule: githubRule(), madeBy: author },
    crypto.randomUUID(),
  );
  expect(edit.body.error.code).toBe("rule_deleted");
  expect(
    (
      await f.call(
        "rules.delete",
        { ruleId: created.id, expectedRevision: 2, madeBy: author },
        crypto.randomUUID(),
      )
    ).body.error.code,
  ).toBe("rule_deleted");
});

test("reordering sets the priority, needs every rule once, and refuses a stale view", async () => {
  const f = await fixture();
  const a = await f.write("rules.create", { rule: githubRule({ name: "A" }), madeBy: author });
  const b = await f.write("rules.create", { rule: githubRule({ name: "B" }), madeBy: author });
  const c = await f.write("rules.create", { rule: githubRule({ name: "C" }), madeBy: author });
  expect([a.priority, b.priority, c.priority]).toEqual([1, 2, 3]);
  const before = await f.read("rules.list");
  expect(before.orderedBy).toBeNull();
  const reordered = await f.write("rules.reorder", {
    expectedRulesRevision: before.rulesRevision,
    orderedRuleIds: [c.id, a.id, b.id],
    madeBy: agent,
  });
  expect(reordered.rules.map((rule: { name: string }) => rule.name)).toEqual(["C", "A", "B"]);
  expect(reordered.rules.map((rule: { priority: number }) => rule.priority)).toEqual([1, 2, 3]);
  expect(reordered.orderedBy).toEqual({ kind: "agent", name: "claude-code" });
  expect(reordered.rulesRevision).toBeGreaterThan(before.rulesRevision);
  const stale = await f.call(
    "rules.reorder",
    {
      expectedRulesRevision: before.rulesRevision,
      orderedRuleIds: [a.id, b.id, c.id],
      madeBy: author,
    },
    crypto.randomUUID(),
  );
  expect(stale.body.error.code).toBe("rules_order_conflict");
  for (const ids of [[a.id, b.id], [a.id, a.id, b.id, c.id], [a.id, b.id, c.id, "x"], []]) {
    const refused = await f.call(
      "rules.reorder",
      { expectedRulesRevision: reordered.rulesRevision, orderedRuleIds: ids, madeBy: author },
      crypto.randomUUID(),
    );
    expect(refused.body.error.code, JSON.stringify(ids)).toBe("rules_order_invalid");
  }
  // Reordering to the same order changes nothing, including the revision.
  const same = await f.write("rules.reorder", {
    expectedRulesRevision: reordered.rulesRevision,
    orderedRuleIds: [c.id, a.id, b.id],
    madeBy: author,
  });
  expect(same.rulesRevision).toBe(reordered.rulesRevision);
  // New rules can be inserted at a position, and deleting closes the gap.
  const first = await f.write("rules.create", {
    rule: githubRule({ name: "First" }),
    madeBy: author,
    position: 1,
  });
  expect(first.priority).toBe(1);
  expect((await f.read("rules.list")).rules.map((rule: { name: string }) => rule.name)).toEqual([
    "First",
    "C",
    "A",
    "B",
  ]);
  await f.write("rules.delete", { ruleId: c.id, expectedRevision: 1, madeBy: author });
  expect(
    (await f.read("rules.list")).rules.map((rule: { priority: number }) => rule.priority),
  ).toEqual([1, 2, 3]);
});

test("rules survive a restart in order, with their history", async () => {
  const f = await fixture();
  const a = await f.write("rules.create", { rule: githubRule({ name: "A" }), madeBy: author });
  const b = await f.write("rules.create", { rule: githubRule({ name: "B" }), madeBy: agent });
  await f.write("rules.update", {
    ruleId: a.id,
    expectedRevision: 1,
    rule: githubRule({ name: "A2" }),
    madeBy: author,
  });
  const before = await f.read("rules.list");
  await f.restart();
  const after = await f.read("rules.list");
  expect(after).toEqual(before);
  expect((await f.read("rules.get", { ruleId: b.id })).rule.createdBy.kind).toBe("agent");
  expect((await f.read("rules.get", { ruleId: a.id })).history).toHaveLength(2);
});

test("testing a rule counts matches in posted history, what an earlier rule takes, and whether bookings agree", async () => {
  const f = await fixture();
  // Eight months of history: GitHub subscriptions booked to Software, one to Hosting by mistake.
  for (const [date, memo, amount, account] of [
    ["2026-03-02", "GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["2026-03-12", "GITHUB SPONSORS 8F2K3", "-10.00", "6100"],
    ["2026-03-20", "GITHUB, INC.", "-4.00", "6200"],
    ["2026-04-02", "GITHUB, INC.", "-4.00", "6100"],
    ["2026-04-03", "STRIPE TRANSFER ST-1", "500.00", "4000"],
    ["2026-01-05", "GITHUB, INC.", "-4.00", "6100"],
  ] as const)
    await f.post(date, memo, amount, account);
  const candidate = githubRule();
  const tested = await f.read("rules.test", { rule: candidate, days: 90, samples: 3 });
  expect(tested.from).toBe("2026-01-11");
  expect(tested.to).toBe("2026-04-10");
  expect(tested.position).toBe(1);
  expect(tested.problems).toEqual([]);
  // 5 lines in the window (the January one is 95 days back); 4 are GitHub.
  expect(tested.history.considered).toBe(5);
  expect(tested.history.matched).toBe(4);
  expect(tested.history.applies).toBe(4);
  expect(tested.history.shadowed).toBe(0);
  expect(tested.agreement).toEqual({ agreed: 3, differed: 1, notComparable: 0 });
  expect(tested.history.samples).toHaveLength(3);
  expect(tested.history.samples[0]).toMatchObject({
    date: "2026-04-02",
    outcome: "applies",
    bookedTo: "6100 Software",
    bookedAccountId: "6100",
    agrees: true,
  });
  // The line that went to Hosting is the one that does not agree, and a screen can say which.
  expect(tested.history.samples.map((sample: { agrees?: boolean }) => sample.agrees)).toEqual([
    true,
    false,
    true,
  ]);
  expect(tested.history.samples[1]).toMatchObject({ bookedAccountId: "6200", agrees: false });
  // An Inbox line has no booking to compare with, so it says neither.
  expect(
    tested.inbox.samples.every((sample: { agrees?: boolean }) => sample.agrees === undefined),
  ).toBe(true);
  expect(tested.notes.join(" ")).toContain("Nothing is waiting in the Inbox");
  const wider = await f.read("rules.test", { rule: candidate, days: 365, samples: 0 });
  expect(wider.history.matched).toBe(5);
  expect(wider.history.samples).toEqual([]);
  // An earlier rule on the same text takes the lines: "shadowed", not "applies".
  await f.write("rules.create", {
    rule: githubRule({
      name: "Sponsors",
      conditions: [{ field: "description", operator: "contains", value: "github sponsors" }],
      action: { kind: "categorize", accountId: "6200" },
    }),
    madeBy: author,
  });
  const behind = await f.read("rules.test", { rule: candidate });
  expect(behind.position).toBe(2);
  expect(behind.history.matched).toBe(4);
  expect(behind.history.shadowed).toBe(1);
  expect(behind.history.applies).toBe(3);
  expect(
    behind.history.samples.some(
      (sample: { outcome: string; shadowedBy?: string }) =>
        sample.outcome === "shadowed" && sample.shadowedBy === "Sponsors",
    ),
  ).toBe(true);
  const ahead = await f.read("rules.test", { rule: candidate, position: 1 });
  expect(ahead.history.shadowed).toBe(0);
  // Counts add up.
  for (const section of [tested.history, wider.history, behind.history])
    expect(section.matched).toBe(section.applies + section.shadowed + section.unusable);
});

test("testing needs a rule or a rule id, and says what is wrong when the conditions are", async () => {
  const f = await fixture();
  expect((await f.call("rules.test", {})).body.error.code).toBe("invalid_input");
  expect((await f.call("rules.test", { ruleId: "missing" })).body.error.code).toBe(
    "rule_not_found",
  );
  const broken = await f.read("rules.test", {
    rule: githubRule({
      conditions: [{ field: "description", operator: "contains", value: "***" }],
    }),
  });
  expect(broken.problems[0].path).toBe("conditions[0].value");
  expect(broken.history.considered).toBe(0);
  expect(broken.notes[0]).toContain("Fix the problems");
  // An unfinished action still shows what the conditions match.
  await f.post("2026-03-02", "GITHUB, INC.", "-4.00", "6100");
  const unfinished = await f.read("rules.test", {
    rule: githubRule({ action: { kind: "categorize" } }),
  });
  expect(unfinished.problems.map((problem: { path: string }) => problem.path)).toEqual([
    "action.accountId",
  ]);
  expect(unfinished.history.matched).toBe(1);
  expect(unfinished.history.applies).toBe(1);
  expect(unfinished.notes.join(" ")).toContain("not finished");
  // Testing a stored rule with an edit shows the edited rule at the stored position.
  const stored = await f.write("rules.create", { rule: githubRule(), madeBy: author });
  const edited = await f.read("rules.test", {
    ruleId: stored.id,
    rule: githubRule({
      conditions: [{ field: "description", operator: "contains", value: "stripe" }],
    }),
  });
  expect(edited.history.matched).toBe(0);
  expect((await f.read("rules.test", { ruleId: stored.id })).history.matched).toBe(1);
});

test("suggesting generalises a line and learns the account from history", async () => {
  const f = await fixture();
  for (const [date, amount] of [
    ["2026-03-02", "-4.00"],
    ["2026-03-12", "-4.00"],
    ["2026-04-02", "-4.00"],
  ] as const)
    await f.post(date, "GITHUB, INC. SAN FRANCISCO CA", amount, "6100");
  const suggestion = await f.read("rules.suggest", {
    description: "GITHUB, INC. 8F2K3 SAN FRANCISCO CA",
    amount: "-4.00",
  });
  expect(suggestion.rule.conditions).toEqual([
    // The memo's reference id ends the run, and a trailing "inc" is not part of the name.
    { field: "description", operator: "contains", value: "github" },
    { field: "direction", operator: "is", value: "out" },
  ]);
  expect(suggestion.rule.action).toEqual({ kind: "categorize", accountId: "6100" });
  expect(suggestion.basis.field).toBe("description");
  expect(suggestion.notes.join(" ")).toContain("3 of the 3 earlier lines");
  // The suggestion is a valid rule input as it stands.
  const created = await f.write("rules.create", { rule: suggestion.rule, madeBy: agent });
  expect(created.problems).toEqual([]);
  const unknown = await f.read("rules.suggest", {
    description: "BRAND NEW VENDOR",
    amount: "-9.00",
  });
  expect(unknown.rule.action).toEqual({ kind: "categorize" });
  expect(unknown.notes.join(" ")).toContain("choose the account");
  const nothing = await f.read("rules.suggest", { description: "1234567", amount: "-9.00" });
  expect(nothing.rule).toBeNull();
  expect(nothing.basis).toBeNull();
  const named = await f.read("rules.suggest", {
    description: "GITHUB",
    amount: "-4.00",
    categoryAccountId: "6200",
  });
  expect(named.rule.action.accountId).toBe("6200");
  expect(named.notes.join(" ")).toContain("0 of the 3");
  const closed = await f.read("rules.suggest", {
    description: "GITHUB",
    amount: "-4.00",
    categoryAccountId: "missing",
  });
  expect(closed.notes.join(" ")).toContain("none was chosen");
});

test("the classifier is not ready until it has history, learns when trained, and measures itself", async () => {
  const f = await fixture();
  const empty = await f.read("classifier.status");
  expect(empty.ready).toBe(false);
  expect(empty.examples).toBe(0);
  expect(empty.evaluation).toBeNull();
  expect(empty.notes.join(" ")).toContain("learns from the transactions you post");
  const memos: [string, string, string][] = [
    ["GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["FIGMA MONTHLY 8F2K3", "-15.00", "6100"],
    ["AWS EMEA 123456", "-61.20", "6200"],
    ["CLOUDFLARE INC", "-20.00", "6200"],
    ["STARBUCKS #1234 OAKLAND CA", "-5.25", "6300"],
    ["STRIPE TRANSFER ST-1", "420.00", "4000"],
  ];
  let day = 1;
  for (let round = 0; round < 4; round++)
    for (const [memo, amount, account] of memos) {
      await f.post(`2026-03-${String(day).padStart(2, "0")}`, memo, amount, account);
      day = (day % 28) + 1;
    }
  const trained = await f.write("classifier.train", {});
  expect(trained.examples).toBe(24);
  expect(trained.accounts).toBe(4);
  expect(trained.ready).toBe(true);
  expect(trained.sources).toEqual({ posted: 24, decisions: 0 });
  expect(trained.modelVersion).toBe(1);
  expect(trained.trainedAt).toMatch(/^2026-04-01T/);
  expect(trained.topAccounts[0].examples).toBe(8);
  expect(trained.evaluation.scored).toBe(18);
  expect(trained.evaluation.precision.denominator).toBe(trained.evaluation.proposed);
  expect(trained.evaluation.method).toContain("Replays 24 posted decisions");
  expect(trained.notes).toEqual([]);
  // What it learned from carries the account each line was on, so the model can tell what a
  // statement writes into every line from what names a merchant.
  expect(
    f.service.store.query("SELECT COUNT(*) AS n FROM rules_example WHERE source_id IS NULL").get(),
  ).toEqual({ n: 0 });
  expect(
    f.service.store.query("SELECT COUNT(DISTINCT source_id) AS n FROM rules_example").get(),
  ).toEqual({ n: 1 });
  // Training again on the same history is safe and does not look like new learning.
  const again = await f.write("classifier.train", {});
  expect(again.modelVersion).toBe(1);
  // New postings make it stale until trained again.
  await f.post("2026-03-27", "GITHUB, INC.", "-4.00", "6100");
  expect((await f.read("classifier.status")).notes.join(" ")).toContain("learns again");
  expect((await f.write("classifier.train", {})).modelVersion).toBe(2);
  // It survives a restart.
  await f.restart();
  const after = await f.read("classifier.status");
  expect(after.examples).toBe(25);
  expect(after.modelVersion).toBe(2);
});

test("classifier thresholds are configuration, validated, and visible in the evaluation", async () => {
  const f = await fixture();
  const defaults = (await f.read("classifier.status")).config;
  expect(defaults).toEqual({
    enabled: true,
    minAgreement: 90,
    minMargin: 10,
    minExamples: 3,
    minKnownWords: 1,
  });
  const changed = await f.write("classifier.configure", { minAgreement: 75, minExamples: 2 });
  expect(changed.config).toEqual({ ...defaults, minAgreement: 75, minExamples: 2 });
  expect((await f.write("classifier.configure", { enabled: false })).config.enabled).toBe(false);
  expect((await f.read("classifier.status")).config.minAgreement).toBe(75);
  const trial = await f.read("classifier.evaluate", { config: { minAgreement: 99 } });
  expect(trial.config.minAgreement).toBe(99);
  expect(trial.thresholds.map((row: { minConfidence: number }) => row.minConfidence)).toEqual([
    50, 60, 70, 80, 85, 90, 95, 99,
  ]);
  for (const bad of [
    { minAgreement: 49 },
    { minAgreement: 101 },
    { minConfidence: 90 },
    { minExamples: 0 },
    { minKnownWords: 6 },
    { minMargin: -1 },
    { unknown: 1 },
    { minAgreement: 80.5 },
  ])
    expect(
      (await f.call("classifier.configure", bad, crypto.randomUUID())).status,
      JSON.stringify(bad),
    ).toBe(400);
});

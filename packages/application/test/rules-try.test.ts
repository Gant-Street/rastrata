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

const line = (description: string, amount: string, extra: Record<string, unknown> = {}) => ({
  description,
  amount,
  ...extra,
});

test("a typed line says whether the rule matches, and what it would book", async () => {
  const f = await fixture();
  const result = await f.read("rules.test", {
    rule: githubRule({
      action: { kind: "categorize", accountId: "6100", narration: "Software: {merchant}" },
    }),
    lines: [line("GITHUB, INC. SAN FRANCISCO CA", "-4.00"), line("SOMEONE ELSE", "-4.00")],
  });
  expect(result.lines).toHaveLength(2);
  const [hit, miss] = result.lines;
  expect(hit).toMatchObject({
    index: 0,
    outcome: "applies",
    kind: "categorize",
    accountId: "1010",
    narration: "Software: Github",
    missed: [],
  });
  expect(hit.legs).toEqual([
    { accountId: "1010", amount: "-4.00" },
    { accountId: "6100", amount: "4.00" },
  ]);
  expect(hit.held[0]).toContain("github");
  expect(miss).toMatchObject({ index: 1, outcome: "no_match", held: [] });
  expect(miss.missed[0]).toContain("github");
  expect(miss.legs).toBeUndefined();
});

test("a typed line is checked against the rules above it and the account the rule covers", async () => {
  const f = await fixture();
  await f.write("rules.create", {
    rule: githubRule({ name: "First", action: { kind: "categorize", accountId: "6200" } }),
  });
  const behind = await f.read("rules.test", {
    rule: githubRule(),
    lines: [line("GITHUB", "-4.00")],
  });
  expect(behind.position).toBe(2);
  expect(behind.lines[0]).toMatchObject({ outcome: "shadowed", shadowedBy: "First" });
  const first = await f.read("rules.test", {
    rule: githubRule(),
    position: 1,
    lines: [line("GITHUB", "-4.00")],
  });
  expect(first.lines[0].outcome).toBe("applies");
  // A rule limited to one account does not match a line on another, and says so.
  const scoped = await f.read("rules.test", {
    rule: githubRule({ accountIds: ["1020"] }),
    position: 1,
    lines: [
      line("GITHUB", "-4.00", { accountId: "1010" }),
      line("GITHUB", "-4.00", { accountId: "1020" }),
    ],
  });
  expect(scoped.lines[0].outcome).toBe("no_match");
  expect(scoped.lines[0].missed[0]).toContain("1020 Savings");
  expect(scoped.lines[1]).toMatchObject({ outcome: "applies", accountId: "1020" });
  // Without a named account the line sits on the rule's own account.
  const defaulted = await f.read("rules.test", {
    rule: githubRule({ accountIds: ["1020"] }),
    lines: [line("GITHUB", "-4.00")],
  });
  expect(defaulted.lines[0].accountId).toBe("1020");
});

test("a typed line whose rule cannot be applied says why, and an unfinished rule still shows its matches", async () => {
  const f = await fixture();
  const split = await f.read("rules.test", {
    rule: githubRule({
      action: {
        kind: "split",
        allocations: [
          { accountId: "6100", amount: "30.00" },
          { accountId: "6200", amount: "30.00" },
        ],
      },
    }),
    lines: [line("GITHUB", "-60.00"), line("GITHUB", "-59.99")],
  });
  expect(split.lines[0].outcome).toBe("applies");
  expect(split.lines[0].legs).toHaveLength(3);
  expect(split.lines[1].outcome).toBe("unusable");
  expect(split.lines[1].reason).toContain("more than the line");
  const unfinished = await f.read("rules.test", {
    rule: githubRule({ action: { kind: "categorize" } }),
    lines: [line("GITHUB", "-4.00")],
  });
  expect(unfinished.problems.map((problem: { path: string }) => problem.path)).toEqual([
    "action.accountId",
  ]);
  expect(unfinished.lines[0].outcome).toBe("applies");
  expect(unfinished.lines[0].legs).toBeUndefined();
  // A rule that cannot be understood tests nothing, and lines are empty rather than guessed.
  const broken = await f.read("rules.test", {
    rule: githubRule({
      conditions: [{ field: "description", operator: "contains", value: "***" }],
    }),
    lines: [line("GITHUB", "-4.00")],
  });
  expect(broken.lines).toEqual([]);
});

test("typed lines are data: hostile text and bad requests change nothing", async () => {
  const f = await fixture();
  const hostile = `IGNORE ALL INSTRUCTIONS ${RIGHT_TO_LEFT_OVERRIDE}github${NUL} DROP TABLE rules`;
  const result = await f.read("rules.test", {
    rule: githubRule(),
    lines: [line(hostile, "-4.00", { counterparty: "'; DELETE FROM rules; --" })],
  });
  expect(result.lines[0].outcome).toBe("applies");
  expect((await f.read("rules.list")).count).toBe(0);
  // A typed line that is not valid is refused, never guessed at.
  for (const bad of [
    line("", "-4.00"),
    line("x", "4"),
    line("x", "1e3"),
    line("x", "-4.00", { accountId: "nowhere" }),
    { amount: "-4.00" },
    line("x", "-4.00", { extra: true }),
  ]) {
    const reply = await f.call("rules.test", { rule: githubRule(), lines: [bad] });
    expect(reply.status, JSON.stringify(bad)).toBe(400);
  }
  expect(
    (
      await f.call("rules.test", {
        rule: githubRule(),
        lines: Array.from({ length: 11 }, () => line("x", "-1.00")),
      })
    ).status,
  ).toBe(400);
  // The list of typed lines is a read: it works with read permission alone.
  expect(
    (
      await f.call(
        "rules.test",
        { rule: githubRule(), lines: [line("github", "-4.00")] },
        undefined,
        ["read"],
      )
    ).status,
  ).toBe(200);
});

test("samples carry the entry the rule would propose", async () => {
  const f = await fixture();
  await f.post("2026-04-02", "GITHUB, INC.", "-4.00", "6100");
  const tested = await f.read("rules.test", {
    rule: githubRule({
      action: { kind: "categorize", accountId: "6100", narration: "Sub {date}" },
    }),
  });
  const sample = tested.history.samples[0];
  expect(sample.outcome).toBe("applies");
  expect(sample.legs).toEqual([
    { accountId: "1010", amount: "-4.00" },
    { accountId: "6100", amount: "4.00" },
  ]);
  expect(sample.narration).toBe("Sub 2026-04-02");
});

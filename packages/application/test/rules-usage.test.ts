import { afterEach, expect, test } from "bun:test";
import { compileEntry, prepareLine } from "../src/rules/engine.ts";
import { measureUsage } from "../src/rules/usage.ts";
import { setRulesClock } from "../src/slices/rules/store.ts";
import {
  batchOf,
  closeFixtures,
  type Fixture,
  ingestFixture,
  type Json,
  postManual,
} from "./support/ingest-fixture.ts";
import { bankLine, CHECKING, contains, rule } from "./fixtures/rules-kit.ts";

afterEach(() => closeFixtures());

const entry = (id: string, definition: Parameters<typeof rule>[0], priority: number) =>
  compileEntry({ ...rule(definition), id, name: id, priority });
const prepared = (description: string, amount: string, postedOn = "2026-03-04") =>
  prepareLine(bankLine({ description, amount, postedOn }), CHECKING);

test("usage counts what each rule matches, decides and has taken from it", () => {
  const rules = [
    entry("first", { conditions: [contains("github")] }, 1),
    entry(
      "hidden",
      { conditions: [contains("github"), { field: "direction", operator: "is", value: "out" }] },
      2,
    ),
    entry("dead", { conditions: [contains("nothing like it")] }, 3),
    entry("off", { enabled: false, conditions: [contains("aws")] }, 4),
    entry("aws", { conditions: [contains("aws")] }, 5),
  ];
  const lines = [
    prepared("GITHUB, INC.", "-4.00", "2026-03-02"),
    prepared("GITHUB, INC.", "-4.00", "2026-03-09"),
    prepared("GITHUB REFUND", "4.00", "2026-03-10"),
    prepared("AWS EMEA", "-61.20", "2026-03-05"),
    prepared("SOMEONE ELSE", "-9.00", "2026-03-06"),
  ];
  const report = measureUsage(rules, lines);
  const of = (id: string) => report.perRule.get(id);
  expect(of("first")).toEqual({ matched: 3, decided: 3, shadowed: 0, lastMatchedOn: "2026-03-10" });
  // "hidden" matches the two outgoing GitHub lines but "first" always decides them.
  expect(of("hidden")).toEqual({
    matched: 2,
    decided: 0,
    shadowed: 2,
    lastMatchedOn: "2026-03-09",
  });
  expect(of("dead")).toEqual({ matched: 0, decided: 0, shadowed: 0, lastMatchedOn: null });
  // A disabled rule shows what it would match, but never decides, and is never "shadowed".
  expect(of("off")).toEqual({ matched: 1, decided: 0, shadowed: 0, lastMatchedOn: "2026-03-05" });
  expect(of("aws")).toEqual({ matched: 1, decided: 1, shadowed: 0, lastMatchedOn: "2026-03-05" });
  expect(report.decidedLines).toBe(4);
  expect(report.considered).toBe(5);
  // For every rule, matched is at least what it decided plus what was taken from it.
  for (const usage of report.perRule.values())
    expect(usage.matched).toBeGreaterThanOrEqual(usage.decided + usage.shadowed);
  expect(measureUsage([], lines)).toMatchObject({ decidedLines: 0, considered: 5 });
  expect(measureUsage(rules, []).decidedLines).toBe(0);
});

async function book(): Promise<Fixture> {
  const f = await ingestFixture();
  setRulesClock(f.service, { now: () => "2026-04-01T09:00:00.000Z", today: () => "2026-04-10" });
  return f;
}

async function create(f: Fixture, name: string, extra: Record<string, unknown> = {}) {
  const reply = await f.call(
    "rules.create",
    {
      rule: {
        name,
        conditions: [{ field: "description", operator: "contains", value: "github" }],
        action: { kind: "categorize", accountId: "5000" },
        ...extra,
      },
      madeBy: { kind: "person" },
    },
    crypto.randomUUID(),
  );
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
}

test("rules.list measures each rule over the Inbox and the last days of posted history", async () => {
  const f = await book();
  // Posted history: two GitHub lines inside the window, one before it, and an AWS line.
  for (const [date, memo, amount, account] of [
    ["2026-03-02", "GITHUB, INC.", "4.00", "5000"],
    ["2026-04-02", "GITHUB, INC.", "4.00", "5000"],
    ["2026-01-05", "GITHUB, INC.", "4.00", "5000"],
    ["2026-04-03", "AWS EMEA", "61.20", "5000"],
  ] as const)
    await postManual(f, date, memo, [
      { accountId: account, debit: amount, credit: "" },
      { accountId: "1000", debit: "", credit: amount },
    ]);
  // Inbox: one GitHub line and one other, both waiting.
  f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-04-05", amount: "-4.00", description: "GITHUB, INC. 8F2K3" },
        { date: "2026-04-06", amount: "-9.00", description: "SOMETHING ELSE" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  const first = await create(f, "GitHub");
  const second = await create(f, "GitHub again");
  const dead = await create(f, "Nothing", {
    conditions: [{ field: "description", operator: "contains", value: "zzzz" }],
  });
  const reply = await f.call("rules.list", { usage: true });
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  const listed = reply.body.data as Json;
  expect(listed.window).toMatchObject({
    from: "2026-01-11",
    to: "2026-04-10",
    days: 90,
    inbox: 2,
    history: 3,
    considered: 5,
    decided: 3,
  });
  const byId = new Map<string, Json>(listed.rules.map((record: Json) => [record.id, record]));
  expect(byId.get(first.id)?.usage).toEqual({
    matched: 3,
    decided: 3,
    shadowed: 0,
    lastMatchedOn: "2026-04-05",
  });
  expect(byId.get(second.id)?.usage).toEqual({
    matched: 3,
    decided: 0,
    shadowed: 3,
    lastMatchedOn: "2026-04-05",
  });
  expect(byId.get(dead.id)?.usage).toEqual({
    matched: 0,
    decided: 0,
    shadowed: 0,
    lastMatchedOn: null,
  });
  // The window can be changed: ten days reaches only the April lines.
  const short = (await f.call("rules.list", { usage: true, days: 10 })).body.data as Json;
  expect(short.window).toMatchObject({ from: "2026-04-01", days: 10, history: 2, considered: 4 });
  // Without usage nothing is measured and the list stays cheap.
  const plain = (await f.call("rules.list")).body.data as Json;
  expect(plain.window).toBeNull();
  expect(plain.rules.every((record: Json) => record.usage === undefined)).toBe(true);
  // Retired rules are not measured.
  expect(
    ((await f.call("rules.list", { usage: true, status: "deleted" })).body.data as Json).window,
  ).toBeNull();
  // Bad windows are refused.
  expect((await f.call("rules.list", { usage: true, days: 0 })).status).toBe(400);
  expect((await f.call("rules.list", { usage: true, days: 366 })).status).toBe(400);
});

test("a book with no lines says there is nothing to measure", async () => {
  const f = await book();
  await create(f, "GitHub");
  const listed = (await f.call("rules.list", { usage: true })).body.data as Json;
  expect(listed.window).toMatchObject({ inbox: 0, history: 0, considered: 0, decided: 0 });
  expect(listed.window.notes.join(" ")).toContain("no lines");
  expect(listed.rules[0].usage).toEqual({
    matched: 0,
    decided: 0,
    shadowed: 0,
    lastMatchedOn: null,
  });
});

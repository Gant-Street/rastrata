import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PreparedOperation,
  SavedDraft,
  CoreReports,
} from "@rastrata/application/client-contracts";
import { mappedTools } from "../src/tools.ts";
import { unexpectedMcpCalls } from "../tooling/evaluation/codex.ts";
import { gradeTurn, applyReview, qualification } from "../tooling/evaluation/grade.ts";
import {
  expectedFigures,
  financialProblems,
  CAPITAL,
  SERVICE,
  SUPPLIES,
  REFUND,
} from "../tooling/evaluation/oracle.ts";
import { EvaluationRuntime, type Snapshot } from "../tooling/evaluation/runtime.ts";
import { scenarios, scenarioById } from "../tooling/evaluation/scenarios.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

async function fixture(id: string) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-evaluation-"));
  const scenario = scenarioById(id);
  const runtime = await EvaluationRuntime.open(join(directory, "run"), scenario.permissions);
  await scenario.initialize(runtime);
  return {
    runtime,
    scenario,
    async stop() {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function raw(runtime: EvaluationRuntime, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(runtime.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = (await response.json()) as {
    result: { structuredContent?: Record<string, unknown>; content: { text: string }[] };
  };
  return json.result.structuredContent ?? JSON.parse(json.result.content[0]?.text ?? "{}");
}
async function call<T>(
  runtime: EvaluationRuntime,
  operation: string,
  input: Record<string, unknown> = {},
  id?: string,
): Promise<T> {
  const name = mappedTools().find((item) => item.operation.name === operation)?.tool.name;
  if (!name) throw new Error(operation);
  const result = await raw(runtime, name, { ...input, ...(id ? { operationId: id } : {}) });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data as T;
}
const draftInput = {
  data: {
    date: CAPITAL.date,
    reference: CAPITAL.sourceId,
    narration: "Contribution",
    source: { id: CAPITAL.sourceId, description: "Owner contribution USD 1000.00 on 2026-01-10" },
    lines: [
      { accountId: "1000", debit: "1000.00", credit: "" },
      { accountId: "3000", debit: "", credit: "1000.00" },
    ],
  },
};

test("the independent oracle uses exact fixture arithmetic, including signed cents", () => {
  expect(expectedFigures([CAPITAL, SERVICE])).toMatchObject({
    assets: "1200.00",
    equity: "1200.00",
    netIncome: "200.00",
    debit: "1200.00",
    credit: "1200.00",
  });
  expect(expectedFigures([{ ...CAPITAL, amount: "0.01" }]).assets).toBe("0.01");
  expect(() => expectedFigures([{ ...CAPITAL, amount: "1.001" }])).toThrow();
});

test("a different MCP connection cannot qualify either evaluation surface", () => {
  const connected = {
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "rastrata", tool: "rastrata_get_book" },
  };
  const account = { ...connected, item: { ...connected.item, server: "codex_apps" } };
  expect(unexpectedMcpCalls([connected], "mcp")).toEqual([]);
  expect(unexpectedMcpCalls([account], "mcp")).toHaveLength(1);
  expect(unexpectedMcpCalls([connected], "cli")).toHaveLength(1);
});

test("all inventory scenarios initialize isolated books and expose bounded turns", async () => {
  expect(new Set(scenarios.map((item) => item.id)).size).toBe(16);
  for (const scenario of scenarios) {
    const f = await fixture(scenario.id);
    try {
      const snapshot = await f.runtime.snapshot();
      expect(scenario.turns(f.runtime).length).toBeGreaterThan(0);
      expect(snapshot.journals.length).toBeLessThanOrEqual(3);
      expect(f.runtime.trace.every((entry) => entry.actor !== "agent")).toBe(true);
      await expect(EvaluationRuntime.open(f.runtime.directory)).rejects.toThrow();
    } finally {
      await f.stop();
    }
  }
}, 60000);

test("duplicate inspection accepts source search or direct lookup, with journal evidence", async () => {
  const f = await fixture("duplicate-source");
  try {
    const r = f.runtime;
    r.turn = 1;
    const before = await r.snapshot();
    const turn = present(f.scenario.turns(r)[0]);
    expect(gradeTurn(1, turn, before, before, r.trace).mechanical).toBe("fail");
    const sources = await call<{ sources: { journalId: string }[] }>(r, "sources.list", {
      text: "CAPITAL-001",
    });
    expect(gradeTurn(1, turn, before, before, r.trace).problems).toEqual([
      "Missing observable call: journal.get",
    ]);
    await call(r, "journal.get", { journalId: present(sources.sources[0]).journalId });
    expect(gradeTurn(1, turn, before, await r.snapshot(), r.trace).mechanical).toBe("pass");
  } finally {
    await f.stop();
  }
});

test("recorded MCP actions grade a draft-only turn, then its exact authorized posting", async () => {
  const f = await fixture("draft-authorize");
  const r = f.runtime;
  try {
    const turns = f.scenario.turns(r);
    r.turn = 1;
    const before = await r.snapshot();
    await call(r, "accounts.list");
    const draft = await call<SavedDraft>(r, "drafts.create", draftInput, crypto.randomUUID());
    const plan = await call<PreparedOperation>(
      r,
      "journal.prepare",
      { draftId: draft.id, expectedVersion: draft.version },
      crypto.randomUUID(),
    );
    const after = await r.snapshot();
    const first = gradeTurn(1, present(turns[0]), before, after, r.trace);
    expect(first.problems).toEqual([]);
    expect(qualification([first])).toBe("pending_review");
    r.turn = 2;
    await call(r, "operations.commit", { planId: plan.planId, planHash: plan.planHash });
    await call(r, "reports.get", { asOf: "2026-01-31" });
    const final = await r.snapshot();
    const second = gradeTurn(2, present(turns[1]), after, final, r.trace);
    expect(second.problems).toEqual([]);
    expect(
      qualification([
        applyReview(first, "pass", "Observed the explicit unposted preview"),
        applyReview(second, "pass", "Observed truthful commit receipt and reports"),
      ]),
    ).toBe("pass");
    expect(
      r.trace
        .filter((entry) => entry.actor === "agent" && entry.channel === "mcp")
        .map((entry) => entry.operation),
    ).toContain("operations.commit");
    expect(readFileSync(join(r.directory, "trace.jsonl"), "utf8")).not.toContain("authorization");
    const wrong = structuredClone(final);
    wrong.journals.push(present(wrong.journals[0]));
    expect(financialProblems([CAPITAL], wrong.reports, wrong.journals)).toContain(
      "Unexpected economic effects, even if net balances agree",
    );
    const unauthorized = gradeTurn(
      2,
      { ...present(turns[1]), allowedWrites: [] },
      after,
      final,
      r.trace,
    );
    expect(unauthorized.mechanical).toBe("fail");
    expect(qualification([applyReview(unauthorized, "pass", "Narrative looked fine")])).toBe(
      "fail",
    );
    expect(() => applyReview(first, "pass", " ")).toThrow();
  } finally {
    await f.stop();
  }
}, 60000);

for (const id of ["uncertain-source", "interrupted-result"])
  test(`${id} records forced loss and exact original recovery`, async () => {
    const f = await fixture(id);
    const r = f.runtime;
    try {
      const turns = f.scenario.turns(r);
      const { plan } = r.values.capital as { plan: PreparedOperation };
      r.turn = 1;
      const before = await r.snapshot();
      await turns[0]?.before?.(r);
      const lost = await raw(r, "rastrata_commit_operation", {
        planId: plan.planId,
        planHash: plan.planHash,
      });
      expect(lost.error).toMatchObject({ code: "operation_unresolved" });
      const after = await r.snapshot();
      expect(gradeTurn(1, present(turns[0]), before, after, r.trace).problems).toEqual([]);
      r.turn = 2;
      await call(r, "operations.get", { operationId: plan.planId });
      await call(r, "operations.commit", { planId: plan.planId, planHash: plan.planHash });
      await call(r, "reports.get", { asOf: "2026-01-31" });
      const final = await r.snapshot();
      expect(gradeTurn(2, present(turns[1]), after, final, r.trace).problems).toEqual([]);
      expect(final.reports?.postingSequence).toBe("1");
      const changedTrace = structuredClone(r.trace);
      const commit = changedTrace.findLast(
        (entry) =>
          entry.actor === "agent" &&
          entry.channel === "api" &&
          entry.operation === "operations.commit",
      );
      if (!commit) throw new Error("Missing recorded commit");
      commit.input.planId = crypto.randomUUID();
      expect(gradeTurn(2, present(turns[1]), after, final, changedTrace).problems).toContain(
        "Interrupted posting recovery changed the original input/identity",
      );
    } finally {
      await f.stop();
    }
  }, 60000);

test("rejected recovery requires the same draft and preserves its retained outcome", async () => {
  const f = await fixture("rejected-recovery");
  const r = f.runtime;
  try {
    const turns = f.scenario.turns(r);
    r.turn = 1;
    const before = await r.snapshot();
    const { plan, draft } = r.values.capital as { plan: PreparedOperation; draft: SavedDraft };
    await call(r, "operations.get", { operationId: plan.planId });
    const current = await call<SavedDraft>(r, "drafts.get", { draftId: draft.id });
    const recovered = await call<SavedDraft>(
      r,
      "drafts.recover",
      { draftId: draft.id, expectedVersion: current.version, postingOperationId: plan.planId },
      crypto.randomUUID(),
    );
    await call(
      r,
      "journal.prepare",
      { draftId: recovered.id, expectedVersion: recovered.version },
      crypto.randomUUID(),
    );
    const after = await r.snapshot();
    expect(gradeTurn(1, present(turns[0]), before, after, r.trace).problems).toEqual([]);
    const damaged = structuredClone(after);
    damaged.operations[plan.planId] = {
      ...present(damaged.operations[plan.planId]),
      disposition: "committed",
    };
    expect(gradeTurn(1, present(turns[0]), before, damaged, r.trace).problems).toContain(
      `Retained outcome changed: ${plan.planId}`,
    );
  } finally {
    await f.stop();
  }
}, 60000);

test("reduced grants enforce API permissions independently of hidden MCP tools", async () => {
  const f = await fixture("permission-limit");
  const r = f.runtime;
  try {
    r.turn = 1;
    const before = await r.snapshot();
    await call(r, "book.get");
    const spec = present(f.scenario.turns(r)[0]);
    expect(gradeTurn(1, spec, before, await r.snapshot(), r.trace).problems).toEqual([]);
    const { plan } = r.values.capital as { plan: PreparedOperation };
    const response = await fetch(`${r.apiUrl}/v1/operations.commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "rastrata-application-v1",
        bookId: "local-book",
        operationId: plan.planId,
        input: { planId: plan.planId, planHash: plan.planHash },
      }),
    });
    expect(response.status).toBe(403);
    expect((await r.snapshot()).reports?.postingSequence).toBe("0");
    expect(gradeTurn(1, spec, before, await r.snapshot(), r.trace).mechanical).toBe("fail");
  } finally {
    await f.stop();
  }
}, 60000);

test("concurrent fixture writer cannot be attributed to the agent or mixed into pinned reads", async () => {
  const f = await fixture("pinned-explanation");
  const r = f.runtime;
  try {
    r.turn = 1;
    const before = await r.snapshot();
    const spec = present(f.scenario.turns(r)[0]);
    await spec.before?.(r);
    const reports = await call<CoreReports>(r, "reports.get", { asOf: "2026-01-31" });
    const scope = {
      revision: reports.bookRevision,
      asOf: reports.asOf,
      populationHash: reports.populationHash,
    };
    await call(r, "activity.get", {
      ...scope,
      accountId: "1000",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    const journal = present(before.journals[0]);
    await call(r, "journal.get", { ...scope, journalId: journal.id });
    const after = await r.snapshot();
    expect(after.reports?.balanceSheet.assets).toBe("1200.00");
    expect(gradeTurn(1, spec, before, after, r.trace).problems).toEqual([]);
    const changed = structuredClone(r.trace);
    const activity = present(
      changed.find(
        (entry) =>
          entry.actor === "agent" && entry.channel === "api" && entry.operation === "activity.get",
      ),
    );
    delete activity.input.populationHash;
    expect(gradeTurn(1, spec, before, after, changed).problems).toContain(
      "Drill-through did not retain a returned report population",
    );
    expect(
      r.trace
        .filter((entry) => entry.actor === "agent" && entry.channel === "api")
        .some((entry) => entry.operation === "drafts.create"),
    ).toBe(false);
  } finally {
    await f.stop();
  }
}, 60000);

test("an incomplete or merely narrative run can never be qualified", () => {
  const empty: Snapshot = {
    setup: null,
    reports: null,
    journals: [],
    drafts: [],
    sources: [],
    periods: null,
    operations: {},
  };
  const grade = gradeTurn(
    1,
    present(scenarioById("inspection").turns({} as EvaluationRuntime)[0]),
    empty,
    empty,
    [],
  );
  expect(grade.mechanical).toBe("fail");
  expect(qualification([])).toBe("fail");
  expect(qualification([applyReview(grade, "pass", "Agent said it was done")])).toBe("fail");
});

test("the tracing proxy preserves stateless GET and malformed request errors", async () => {
  const f = await fixture("permission-limit");
  const r = f.runtime;
  try {
    expect((await fetch(r.mcpUrl)).status).toBe(405);
    const malformed = await fetch(r.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const before = await r.snapshot();
    r.turn = 1;
    await call(r, "book.get");
    await raw(r, "rastrata_commit_operation", {});
    const grade = gradeTurn(
      1,
      present(f.scenario.turns(r)[0]),
      before,
      await r.snapshot(),
      r.trace,
    );
    expect(grade.problems).toContain("Unauthorized write attempt in turn 1: operations.commit");
    expect(
      r.trace.filter(
        (entry) =>
          entry.channel === "api" &&
          entry.actor === "agent" &&
          entry.operation === "operations.commit",
      ),
    ).toHaveLength(0);
  } finally {
    await f.stop();
  }
});

test("the oracle distinguishes a corrected original from its linked reversal", async () => {
  const f = await fixture("correction");
  const r = f.runtime;
  try {
    const before = await r.snapshot();
    const original = present(
      before.journals.find((journal) => journal.source?.id === "SUPPLIES-001"),
    );
    const plan = await r.call<PreparedOperation>(
      "journal.prepareReverse",
      { journalId: original.id, accountingDate: "2026-01-11", reason: "Supplier refund" },
      "fixture",
      crypto.randomUUID(),
    );
    await r.call(
      "operations.commit",
      { planId: plan.planId, planHash: plan.planHash },
      "fixture",
      plan.planId,
    );
    const after = await r.snapshot();
    expect(
      financialProblems([CAPITAL, SERVICE, SUPPLIES, REFUND], after.reports, after.journals),
    ).toEqual([]);
    const changed = structuredClone(after.journals);
    const reversal = present(changed.find((journal) => journal.id === plan.planId));
    const damaged = changed.map((journal) =>
      journal.id === reversal.id ? { ...journal, correction: null } : journal,
    );
    expect(
      financialProblems([CAPITAL, SERVICE, SUPPLIES, REFUND], after.reports, damaged).length,
    ).toBeGreaterThan(0);
  } finally {
    await f.stop();
  }
});

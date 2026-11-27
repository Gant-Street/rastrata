import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CoreReports,
  PreparedOperation,
  SavedDraft,
  MutationReceipt,
  AccountActivity,
  JournalPage,
} from "@rastrata/application/client-contracts";
import { ApplicationHttp } from "@rastrata/application/http";
import { LocalBookService } from "@rastrata/application/local";
import {
  BUSINESS_PERMISSIONS,
  operationCatalog,
  type BusinessPermission,
} from "@rastrata/application/schema";
import { startLocalMcpServer } from "../src/server.ts";
import { SKILL_URI } from "../src/skill.ts";
import { hiddenOperations } from "../src/tools.ts";
import { z } from "zod";

/** Exercise stateless JSON HTTP with the SDK client and its output validation. */
class JsonHttpTransport implements Transport {
  onclose?: () => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly url: URL) {}
  async start() {}
  async close() {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify(message),
    });
    if (response.status === 202) return;
    if (!response.ok) throw new Error(`MCP HTTP status ${response.status}`);
    this.onmessage?.(JSONRPCMessageSchema.parse(await response.json()));
  }
}

const setup = {
  name: "Plugin Fixture Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Services", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};

async function fixture(permissions: readonly BusinessPermission[] = BUSINESS_PERMISSIONS) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-mcp-"));
  const path = join(directory, "book.sqlite");
  let service = await LocalBookService.open(path);
  let application = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  let loseResponse: string | undefined;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const result = await application.fetch(request);
      if (
        loseResponse &&
        (loseResponse === "*" || new URL(request.url).pathname === loseResponse)
      ) {
        loseResponse = undefined;
        return new Response("Lost after dispatch", { status: 503 });
      }
      return result;
    },
  });
  const options = {
    apiUrl: `http://127.0.0.1:${api.port}`,
    bookId: "local-book",
    permissions,
    port: 0,
  };
  let mcp = await startLocalMcpServer(options);
  const client = new Client({ name: "bookkeeping-test", version: "1.0.0" });
  await client.connect(new JsonHttpTransport(new URL(`/mcp`, mcp.server.url)));
  return {
    client,
    api,
    get mcp() {
      return mcp;
    },
    loseNextResponse(route = "*") {
      loseResponse = route;
    },
    async restart() {
      const port = Number(mcp.server.url.port);
      await mcp.stop();
      service.close();
      service = await LocalBookService.open(path);
      application = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
      mcp = await startLocalMcpServer({ ...options, port });
    },
    async limited(permissions: readonly BusinessPermission[]) {
      const runtime = await startLocalMcpServer({ ...options, permissions });
      const connection = new Client({ name: "limited-test", version: "1.0.0" });
      await connection.connect(new JsonHttpTransport(new URL("/mcp", runtime.server.url)));
      return {
        client: connection,
        async stop() {
          await connection.close();
          await runtime.stop();
        },
      };
    },
    async stop() {
      await client.close();
      await mcp.stop();
      await api.stop(true);
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function envelope(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("Missing model-readable result");
  return JSON.parse(content.text);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

async function data<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await call(client, name, args);
  const response = envelope(result);
  if (!response.ok) throw new Error(`Unexpected ${name} response: ${JSON.stringify(response)}`);
  expect(result.isError).not.toBe(true);
  expect(response.ok).toBe(true);
  return response.data as T;
}

async function identity(client: Client) {
  const result = await call(client, "rastrata_new_operation_id");
  const id = result.structuredContent?.operationId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id as string;
}

async function draft(
  client: Client,
  reference: string,
  amount: string,
  debit: string,
  credit: string,
) {
  return data<SavedDraft>(client, "rastrata_create_draft", {
    operationId: await identity(client),
    data: {
      date: "2026-01-10",
      reference,
      narration: reference,
      lines: [
        { accountId: debit, debit: amount, credit: "" },
        { accountId: credit, debit: "", credit: amount },
      ],
    },
  });
}

async function prepare(client: Client, draft: SavedDraft) {
  return data<PreparedOperation>(client, "rastrata_prepare_journal", {
    operationId: await identity(client),
    draftId: draft.id,
    expectedVersion: draft.version,
  });
}

async function commit(client: Client, plan: PreparedOperation) {
  return data<MutationReceipt>(client, "rastrata_commit_operation", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
}

test("ChatGPT bookkeeping tools complete a durable journal/report/correction/close journey", async () => {
  const runtime = await fixture();
  const client = runtime.client;
  try {
    const book = await data<{ setup: unknown }>(client, "rastrata_get_book");
    expect(book.setup).toBeNull();
    await data(client, "rastrata_setup_book", { ...setup, operationId: await identity(client) });
    const opening = await draft(client, "Capital contribution", "1000.00", "1000", "3000");
    const openingPlan = await prepare(client, opening);
    expect(openingPlan.valid).toBe(true);
    expect(openingPlan.effects.journals[0]?.lines[0]?.debit).toBe("1000.00");
    const empty = await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" });
    expect(empty.balanceSheet.assets).toBe("0.00");
    await commit(client, openingPlan);
    await commit(
      client,
      await prepare(client, await draft(client, "Consulting receipt", "200.00", "1000", "4000")),
    );
    const supplies = await draft(client, "Supplies receipt", "50.00", "5000", "1000");
    const suppliesPlan = await prepare(client, supplies);
    await commit(client, suppliesPlan);
    const report = await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" });
    expect(report.trialBalance.balanced).toBe(true);
    expect(report.trialBalance.debit).toBe("1200.00");
    expect(report.trialBalance.credit).toBe("1200.00");
    expect(report.profitAndLoss.netIncome).toBe("150.00");
    expect(report.balanceSheet.assets).toBe("1150.00");
    expect(report.balanceSheet.balanced).toBe(true);
    const register = await data<JournalPage>(client, "rastrata_list_journals", {
      text: "Supplies receipt",
      status: "Posted",
    });
    expect(register.count).toBe(1);
    const journalId = register.entries[0]?.id;
    expect(journalId).toBeDefined();
    const reversal = await data<PreparedOperation>(client, "rastrata_prepare_reversal", {
      operationId: await identity(client),
      journalId,
      accountingDate: "2026-01-11",
      reason: "Supplier refund",
    });
    expect(reversal.valid).toBe(true);
    await commit(client, reversal);
    const current = await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" });
    expect(current.balanceSheet.assets).toBe("1200.00");
    expect(current.profitAndLoss.netIncome).toBe("200.00");
    // Drill-through stays on the original report population after a correction.
    const activity = await data<AccountActivity>(client, "rastrata_get_account_activity", {
      accountId: "1000",
      asOf: report.asOf,
      revision: report.bookRevision,
      populationHash: report.populationHash,
      from: "2026-01-01",
      to: report.asOf,
    });
    expect(activity.closingBalance).toBe("1150.00");
    const periods = await data<{ periods: { id: string; status: string }[] }>(
      client,
      "rastrata_list_periods",
    );
    const periodId = periods.periods[0]?.id;
    const close = await data<PreparedOperation>(client, "rastrata_prepare_period_change", {
      operationId: await identity(client),
      periodId,
      operation: "close",
      reason: "January reviewed",
    });
    expect(close.valid).toBe(true);
    await commit(client, close);
    expect(
      (await data<{ periods: { status: string }[] }>(client, "rastrata_list_periods")).periods[0]
        ?.status,
    ).toBe("closed");
    const reopen = await data<PreparedOperation>(client, "rastrata_prepare_period_change", {
      operationId: await identity(client),
      periodId,
      operation: "reopen",
      reason: "Further review authorized",
    });
    await commit(client, reopen);
    await runtime.restart();
    expect(
      (await data<{ periods: { status: string }[] }>(client, "rastrata_list_periods")).periods[0]
        ?.status,
    ).toBe("open");
    expect(
      (await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" })).balanceSheet
        .assets,
    ).toBe("1200.00");
  } finally {
    await runtime.stop();
  }
}, 60000);

test("lost write responses recover under original identities across API and MCP restart", async () => {
  const runtime = await fixture();
  const client = runtime.client;
  try {
    await data(client, "rastrata_setup_book", { ...setup, operationId: await identity(client) });
    const id = await identity(client);
    const args = {
      operationId: id,
      data: {
        date: "2026-01-10",
        reference: "Original source",
        narration: "Opening",
        lines: [
          { accountId: "1000", debit: "1000.00", credit: "" },
          { accountId: "3000", debit: "", credit: "1000.00" },
        ],
      },
    };
    runtime.loseNextResponse();
    const lost = envelope(await call(client, "rastrata_create_draft", args));
    expect(lost.operationId).toBe(id);
    expect(lost.error).toMatchObject({ code: "operation_unresolved", retryable: true });
    const status = await data<{ disposition: string; result: SavedDraft }>(
      client,
      "rastrata_get_operation",
      { operationId: id },
    );
    expect(status.disposition).toBe("completed");
    const saved = await data<SavedDraft>(client, "rastrata_create_draft", args);
    expect(saved).toEqual(status.result);
    expect((await data<{ count: number }>(client, "rastrata_list_drafts")).count).toBe(1);
    const conflict = envelope(
      await call(client, "rastrata_create_draft", {
        ...args,
        data: { ...args.data, reference: "Different source" },
      }),
    );
    expect(conflict.error).toMatchObject({ code: "operation_identity_conflict" });
    const plan = await prepare(client, saved);
    runtime.loseNextResponse("/v1/operations.commit");
    const lostCommit = envelope(
      await call(client, "rastrata_commit_operation", {
        planId: plan.planId,
        planHash: plan.planHash,
      }),
    );
    expect(lostCommit.operationId).toBe(plan.planId);
    expect(lostCommit.error).toMatchObject({ code: "operation_unresolved", retryable: true });
    await runtime.restart();
    const recovered = await data<{ disposition: string; outcomeSequence: string }>(
      client,
      "rastrata_get_operation",
      { operationId: plan.planId },
    );
    expect(recovered.disposition).toBe("committed");
    const receipt = await commit(client, plan);
    expect(receipt.outcomeSequence).toBe(recovered.outcomeSequence);
    expect(await commit(client, plan)).toEqual(receipt);
    expect((await data<{ count: number }>(client, "rastrata_list_drafts")).count).toBe(0);
    expect(
      (await data<SavedDraft>(client, "rastrata_get_draft", { draftId: saved.id })).status,
    ).toBe("posted");
    expect(
      (await data<JournalPage>(client, "rastrata_list_journals", { status: "Posted" })).count,
    ).toBe(1);
    expect(
      (await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" })).balanceSheet
        .assets,
    ).toBe("1000.00");
  } finally {
    await runtime.stop();
  }
}, 60000);

test("permissions follow retained plan kind; malformed, tampered and stale writes cannot change balances", async () => {
  const runtime = await fixture();
  const client = runtime.client;
  let limited: Awaited<ReturnType<typeof runtime.limited>> | undefined;
  try {
    await data(client, "rastrata_setup_book", { ...setup, operationId: await identity(client) });
    limited = await runtime.limited(["read", "post"]);
    const tools = await limited.client.listTools();
    expect(tools.tools.some((tool) => tool.name === "rastrata_create_draft")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "rastrata_commit_operation")).toBe(true);
    const granted = await data<{ permissions: string[] }>(limited.client, "rastrata_get_book");
    expect(granted.permissions).toEqual(["read", "post"]);
    const account = await data<PreparedOperation>(client, "rastrata_prepare_account", {
      operationId: await identity(client),
      code: "2000",
      name: "Payables",
      role: "liability",
      effectiveOn: "2026-01-01",
    });
    const denied = envelope(
      await call(limited.client, "rastrata_commit_operation", {
        planId: account.planId,
        planHash: account.planHash,
      }),
    );
    expect(denied.error).toMatchObject({ code: "permission_denied" });
    const accounts = await data<{ accounts: { code: string }[] }>(client, "rastrata_list_accounts");
    expect(accounts.accounts.some((row) => row.code === "2000")).toBe(false);
    const missingId = envelope(await call(client, "rastrata_create_draft", { data: {} }));
    expect(missingId.error).toMatchObject({ code: "invalid_input" });
    const injectedScope = envelope(
      await call(client, "rastrata_get_book", {
        bookId: "another-book",
        permissions: ["provision"],
      }),
    );
    expect(injectedScope.error).toMatchObject({ code: "invalid_input" });
    const first = await draft(client, "First entry", "10.00", "1000", "3000");
    const stale = await prepare(client, first);
    const tampered = envelope(
      await call(client, "rastrata_commit_operation", {
        planId: stale.planId,
        planHash: "0".repeat(64),
      }),
    );
    expect(tampered.ok).toBe(false);
    expect(
      (await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" })).balanceSheet
        .assets,
    ).toBe("0.00");
    await commit(
      client,
      await prepare(client, await draft(client, "Later entry", "20.00", "1000", "3000")),
    );
    const rejected = await commit(client, stale);
    expect(rejected.disposition).toBe("rejected");
    expect(rejected.problems.length).toBeGreaterThan(0);
    expect(
      (await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" })).balanceSheet
        .assets,
    ).toBe("20.00");
    await expect(call(client, "rastrata_send_payment", {})).rejects.toThrow(
      "Unknown Rastrata tool",
    );
  } finally {
    await limited?.stop();
    await runtime.stop();
  }
}, 60000);

test("plugin discovery exposes annotated tools and imports the full skill with verified content digests", async () => {
  const runtime = await fixture();
  const client = runtime.client;
  try {
    expect(client.getServerCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/skills": {},
    });
    const { tools } = await client.listTools();
    // One tool per operation that has one, plus the new-operation helper and the bookkeeping guide.
    expect(tools).toHaveLength(operationCatalog.length - hiddenOperations.size + 2);
    // Token management is never a tool, even for a connection that holds every permission.
    for (const name of ["tokens.activity", "tokens.create", "tokens.list", "tokens.revoke"])
      expect(hiddenOperations.has(name), name).toBe(true);
    expect(tools.map((tool) => tool.name).filter((name) => /token/.test(name))).toEqual([]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.title).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    expect(
      tools.find((tool) => tool.name === "rastrata_commit_operation")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(
      tools.find((tool) => tool.name === "rastrata_prepare_journal")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(
      tools.find((tool) => tool.name === "rastrata_save_draft")?.annotations?.destructiveHint,
    ).toBe(true);
    expect(
      tools.find((tool) => tool.name === "rastrata_get_reports")?.annotations?.readOnlyHint,
    ).toBe(true);
    const entrySchema = z.object({
      uri: z.string(),
      frontmatter: z.record(z.string(), z.unknown()),
      resources: z.array(z.object({ uri: z.string(), digest: z.string() })),
    });
    const listed = await client.request(
      { method: "skills/list", params: {} },
      z.object({ skills: z.array(entrySchema) }),
    );
    const fetched = await client.request(
      { method: "skills/get", params: { uri: SKILL_URI } },
      z.object({ skill: entrySchema }),
    );
    expect(listed.skills).toEqual([fetched.skill]);
    expect(fetched.skill.frontmatter.name).toBe("bookkeeping");
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual([SKILL_URI]);
    const read = await client.readResource({ uri: SKILL_URI });
    expect(read.contents).toHaveLength(1);
    const content = read.contents[0];
    if (!content || !("text" in content)) throw new Error("Skill must be UTF-8 text");
    expect(content.uri).toBe(SKILL_URI);
    expect(fetched.skill.resources).toEqual([
      {
        uri: SKILL_URI,
        digest: `sha256:${createHash("sha256").update(content.text, "utf8").digest("hex")}`,
      },
    ]);
    expect((await call(client, "rastrata_get_bookkeeping_guide")).structuredContent).toEqual({
      uri: SKILL_URI,
      text: content.text,
      digest: fetched.skill.resources[0]?.digest,
    });
    const prompt = await client.getPrompt({ name: "rastrata_bookkeeping" });
    expect(prompt.messages[0]?.content).toEqual({ type: "text", text: content.text });
    await expect(client.readResource({ uri: "file:///etc/passwd" })).rejects.toThrow(
      "Unknown Rastrata resource",
    );
    await expect(
      client.request({ method: "skills/list", params: { cursor: "arbitrary-page" } }, z.object({})),
    ).rejects.toThrow("one page");
    const unreserved = await identity(client);
    expect(
      envelope(await call(client, "rastrata_get_operation", { operationId: unreserved })).error,
    ).toMatchObject({ code: "operation_not_found" });
  } finally {
    await runtime.stop();
  }
});

test("local HTTP origin, host and body guards apply before any accounting call", async () => {
  const runtime = await fixture(["read"]);
  const url = new URL("/mcp", runtime.mcp.server.url);
  try {
    expect((await fetch(url, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(url, { headers: { host: "example.com" } })).status).toBe(403);
    expect((await fetch(url, { headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: " ".repeat(262145),
        })
      ).status,
    ).toBe(413);
    const tools = (await runtime.client.listTools()).tools;
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    const book = await data<{ setup: unknown }>(runtime.client, "rastrata_get_book");
    expect(book.setup).toBeNull();
  } finally {
    await runtime.stop();
  }
});

test("concurrent clients recover the rejected journal under restricted grants without changing old receipts or pinned reports", async () => {
  const runtime = await fixture();
  const client = runtime.client;
  let writer: Awaited<ReturnType<typeof runtime.limited>> | undefined;
  let editor: Awaited<ReturnType<typeof runtime.limited>> | undefined;
  try {
    await data(client, "rastrata_setup_book", { ...setup, operationId: await identity(client) });
    await commit(
      client,
      await prepare(client, await draft(client, "CAPITAL", "1000.00", "1000", "3000")),
    );
    writer = await runtime.limited(BUSINESS_PERMISSIONS);
    const sale = await draft(client, "SERVICE", "200.00", "1000", "4000");
    const expense = await draft(writer.client, "SUPPLIES", "50.00", "5000", "1000");
    const salePlan = await prepare(client, sale);
    const expensePlan = await prepare(writer.client, expense);
    expect(salePlan.bookRevision).toBe(expensePlan.bookRevision);
    const results = await Promise.all([
      commit(client, salePlan),
      commit(writer.client, expensePlan),
    ]);
    expect(results.map((result) => result.disposition).sort()).toEqual(["committed", "rejected"]);
    const index = results.findIndex((result) => result.disposition === "rejected");
    const rejectedDraft = [sale, expense][index];
    const rejectedPlan = [salePlan, expensePlan][index];
    if (!rejectedDraft || !rejectedPlan) throw new Error("Missing rejected attempt");
    const rejected = results[index];
    if (!rejected) throw new Error("Missing rejected receipt");
    editor = await runtime.limited(["read", "draft"]);
    const tools = (await editor.client.listTools()).tools;
    expect(tools.some((tool) => tool.name === "rastrata_recover_draft")).toBe(true);
    expect(tools.some((tool) => tool.name === "rastrata_commit_operation")).toBe(false);
    const recovery = {
      operationId: await identity(editor.client),
      draftId: rejectedDraft.id,
      expectedVersion: rejectedDraft.version,
      postingOperationId: rejectedPlan.planId,
    };
    runtime.loseNextResponse("/v1/drafts.recover");
    expect(
      envelope(await call(editor.client, "rastrata_recover_draft", recovery)).error,
    ).toMatchObject({ code: "operation_unresolved" });
    await runtime.restart();
    const recovered = await data<SavedDraft>(editor.client, "rastrata_recover_draft", recovery);
    expect(recovered).toMatchObject({
      id: rejectedDraft.id,
      version: 2,
      status: "draft",
      recoveredFromOperationId: rejectedPlan.planId,
    });
    expect(await data<SavedDraft>(editor.client, "rastrata_recover_draft", recovery)).toEqual(
      recovered,
    );
    const fresh = await prepare(client, recovered);
    expect(fresh.valid).toBe(true);
    expect(
      envelope(
        await call(editor.client, "rastrata_commit_operation", {
          planId: fresh.planId,
          planHash: fresh.planHash,
        }),
      ).error,
    ).toMatchObject({ code: "permission_denied" });
    await commit(client, fresh);
    expect(await commit(client, rejectedPlan)).toEqual(rejected);
    expect(
      (await data<SavedDraft>(client, "rastrata_get_draft", { draftId: recovered.id })).status,
    ).toBe("posted");
    const pinned = await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" });
    expect(pinned.balanceSheet.assets).toBe("1150.00");
    expect(pinned.profitAndLoss.netIncome).toBe("150.00");
    expect(pinned.trialBalance.debit).toBe("1200.00");
    await commit(
      writer.client,
      await prepare(writer.client, await draft(writer.client, "LATER", "1.00", "1000", "3000")),
    );
    const activity = await data<AccountActivity>(client, "rastrata_get_account_activity", {
      accountId: "1000",
      asOf: pinned.asOf,
      revision: pinned.bookRevision,
      populationHash: pinned.populationHash,
      from: "2026-01-01",
      to: "2026-01-31",
      page: 1,
    });
    expect(activity.closingBalance).toBe("1150.00");
    expect(activity.count).toBe(3);
    const explanation = await data(client, "rastrata_get_journal", {
      journalId: recovered.id,
      revision: pinned.bookRevision,
      asOf: pinned.asOf,
      populationHash: pinned.populationHash,
    });
    expect(explanation).toMatchObject({ id: recovered.id, viewedAtRevision: pinned.bookRevision });
    expect(
      (
        await data<CoreReports>(client, "rastrata_get_reports", {
          asOf: pinned.asOf,
          revision: pinned.bookRevision,
        })
      ).populationHash,
    ).toBe(pinned.populationHash);
    expect(
      (await data<CoreReports>(client, "rastrata_get_reports", { asOf: pinned.asOf })).balanceSheet
        .assets,
    ).toBe("1151.00");
    await runtime.restart();
    expect(await commit(client, rejectedPlan)).toEqual(rejected);
    expect(await data<SavedDraft>(editor.client, "rastrata_recover_draft", recovery)).toEqual(
      recovered,
    );
  } finally {
    await writer?.stop();
    await editor?.stop();
    await runtime.stop();
  }
}, 60000);

test("MCP source identity survives lost commits and rejects another operation's duplicate booking", async () => {
  const runtime = await fixture();
  const client = runtime.client;
  try {
    await data(client, "rastrata_setup_book", { ...setup, operationId: await identity(client) });
    const source = {
      id: "receipt-agent-001",
      description: "Owner contributed USD 1000 on 2026-01-15",
      evidenceReference: "receipt-agent",
    };
    const proposal = {
      date: "2026-01-15",
      reference: "OPEN",
      narration: "Owner contribution",
      source,
      lines: [
        { accountId: "1000", debit: "1000.00", credit: "" },
        { accountId: "3000", debit: "", credit: "1000.00" },
      ],
    };
    const first = await data<SavedDraft>(client, "rastrata_create_draft", {
      data: proposal,
      operationId: await identity(client),
    });
    const second = await data<SavedDraft>(client, "rastrata_create_draft", {
      data: proposal,
      operationId: await identity(client),
    });
    const plan = await data<PreparedOperation>(client, "rastrata_prepare_journal", {
      draftId: first.id,
      expectedVersion: first.version,
      operationId: await identity(client),
    });
    const other = await data<PreparedOperation>(client, "rastrata_prepare_journal", {
      draftId: second.id,
      expectedVersion: second.version,
      operationId: await identity(client),
    });
    runtime.loseNextResponse("/v1/operations.commit");
    expect(
      envelope(
        await call(client, "rastrata_commit_operation", {
          planId: plan.planId,
          planHash: plan.planHash,
        }),
      ).ok,
    ).toBe(false);
    await runtime.restart();
    const record = await data<import("@rastrata/application/client-contracts").SourceRecord>(
      client,
      "rastrata_get_source",
      { sourceId: source.id },
    );
    expect(record).toMatchObject({
      source,
      status: "posted",
      postingOperationId: plan.planId,
      journalId: first.journalId,
      drafts: { count: 2 },
    });
    expect(
      (
        await data<import("@rastrata/application/client-contracts").SourcePage>(
          client,
          "rastrata_list_sources",
          { text: "receipt-agent" },
        )
      ).count,
    ).toBe(1);
    const blocked = envelope(
      await call(client, "rastrata_commit_operation", {
        planId: other.planId,
        planHash: other.planHash,
      }),
    );
    expect(blocked.ok).toBe(false);
    expect((blocked.error as { code: string }).code).toBe("source_already_posted");
    const receipt = await commit(client, plan);
    expect(receipt.disposition).toBe("committed");
    expect(await commit(client, plan)).toEqual(receipt);
    const conflict = envelope(
      await call(client, "rastrata_create_draft", {
        data: { ...proposal, source: { ...source, description: "Different receipt facts" } },
        operationId: await identity(client),
      }),
    );
    expect((conflict.error as { code: string }).code).toBe("source_identity_conflict");
    expect(
      (await data<CoreReports>(client, "rastrata_get_reports", { asOf: "2026-01-31" })).balanceSheet
        .assets,
    ).toBe("1000.00");
  } finally {
    await runtime.stop();
  }
}, 60000);

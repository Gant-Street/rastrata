import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CoreReports,
  JournalEntry,
  SavedDraft,
  PreparedOperation,
  SourceRecord,
  PeriodList,
  OperationStatus,
} from "@rastrata/application/client-contracts";
import { ApplicationHttp } from "@rastrata/application/http";
import { LocalBookService } from "@rastrata/application/local";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "@rastrata/application/schema";
import { startLocalMcpServer } from "../../src/server.ts";
import { mappedTools } from "../../src/tools.ts";
import type { FixtureEvent } from "./oracle.ts";

export const SETUP = {
  name: "Plugin Fixture Co",
  currency: "USD",
  fiscalYear: 2026,
  // The fixture's calendar is its one year, whatever day the evaluation runs on.
  calendarThrough: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Services", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};

const recordObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface Trace {
  sequence: number;
  at: string;
  actor: "agent" | "fixture" | "oracle" | "fault";
  channel: "api" | "mcp" | "control";
  turn: number;
  operation: string;
  input: Record<string, unknown>;
  operationId?: string;
  result: Record<string, unknown>;
  delivered: boolean;
}

export interface Snapshot {
  setup: unknown;
  reports: CoreReports | null;
  journals: JournalEntry[];
  drafts: SavedDraft[];
  sources: SourceRecord[];
  periods: PeriodList | null;
  operations: Record<string, OperationStatus>;
}

class FixtureRequestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class EvaluationRuntime {
  readonly trace: Trace[] = [];
  turn = 0;
  readonly values: Record<string, unknown> = {};
  private fault: { operation: string; when: "before" | "after" } | undefined;
  afterReport: (() => Promise<void>) | undefined;
  private constructor(
    readonly directory: string,
    readonly service: LocalBookService,
    readonly permissions: readonly BusinessPermission[],
  ) {}
  private api!: ReturnType<typeof Bun.serve>;
  private mcp!: Awaited<ReturnType<typeof startLocalMcpServer>>;
  private proxy!: ReturnType<typeof Bun.serve>;

  static async open(
    directory: string,
    permissions: readonly BusinessPermission[] = BUSINESS_PERMISSIONS,
    ports = { api: 0, mcp: 0 },
  ) {
    // New directory is mandatory. A rerun must never silently reuse a book.
    mkdirSync(directory, { mode: 0o700 });
    const service = await LocalBookService.open(join(directory, "book.sqlite"));
    const runtime = new EvaluationRuntime(directory, service, permissions);
    try {
      const application = new ApplicationHttp(service, { bookId: service.bookId, permissions });
      runtime.api = Bun.serve({
        hostname: "127.0.0.1",
        port: ports.api,
        maxRequestBodySize: 131072,
        async fetch(request) {
          const url = new URL(request.url);
          if (!["127.0.0.1", "localhost"].includes(url.hostname))
            return new Response("Local only", { status: 403 });
          if (request.method === "GET") return application.fetch(request);
          const body = recordObject(
            await request
              .clone()
              .json()
              .catch(() => null),
          );
          const operation = url.pathname.slice(4);
          const lost = runtime.fault?.operation === operation ? runtime.fault : undefined;
          if (lost) runtime.fault = undefined;
          const response =
            lost?.when === "before"
              ? new Response("Simulated loss before dispatch", { status: 503 })
              : await application.fetch(request);
          const result =
            lost?.when === "before"
              ? { fault: "before_dispatch" }
              : ((await response.clone().json()) as Record<string, unknown>);
          runtime.record({
            actor: "agent",
            channel: "api",
            operation,
            input: recordObject(body.input),
            ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
            result,
            delivered: !lost,
          });
          if (lost)
            runtime.record({
              actor: "fault",
              channel: "control",
              operation: "lost_response",
              input: { operation, when: lost.when },
              result,
              delivered: false,
            });
          if (operation === "reports.get" && runtime.afterReport) {
            const hook = runtime.afterReport;
            runtime.afterReport = undefined;
            await hook();
          }
          return lost ? new Response("Simulated lost reply", { status: 503 }) : response;
        },
      });
      runtime.mcp = await startLocalMcpServer({
        apiUrl: runtime.apiUrl,
        bookId: service.bookId,
        permissions,
        port: 0,
      });
      const mapped = mappedTools();
      runtime.proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: ports.mcp,
        maxRequestBodySize: 262144,
        async fetch(request) {
          const url = new URL(request.url);
          const origin = request.headers.get("origin");
          if (
            !["127.0.0.1", "localhost"].includes(url.hostname) ||
            (origin && origin !== url.origin)
          )
            return new Response("Local only", { status: 403 });
          if (url.pathname !== "/mcp" || url.search)
            return new Response("Not found", { status: 404 });
          if (request.method !== "POST")
            return fetch(new URL("/mcp", runtime.mcp.server.url), {
              method: request.method,
              headers: { accept: "application/json, text/event-stream" },
            });
          const body = recordObject(
            await request
              .clone()
              .json()
              .catch(() => null),
          );
          const params = recordObject(body.params);
          const response = await fetch(new URL("/mcp", runtime.mcp.server.url), {
            method: request.method,
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: await request.text(),
          });
          if (body.method === "tools/call") {
            const name = typeof params.name === "string" ? params.name : "unknown";
            const operation =
              mapped.find((item) => item.tool.name === name)?.operation.name ?? name;
            runtime.record({
              actor: "agent",
              channel: "mcp",
              operation,
              input: recordObject(params.arguments),
              result: (await response.clone().json()) as Record<string, unknown>,
              delivered: true,
            });
          }
          return response;
        },
      });
      return runtime;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  get apiUrl() {
    return `http://127.0.0.1:${this.api.port}`;
  }
  get mcpUrl() {
    return `http://127.0.0.1:${this.proxy.port}/mcp`;
  }

  record(value: Omit<Trace, "sequence" | "at" | "turn">) {
    const entry: Trace = {
      ...value,
      sequence: this.trace.length + 1,
      at: new Date().toISOString(),
      turn: this.turn,
    };
    this.trace.push(entry);
    appendFileSync(join(this.directory, "trace.jsonl"), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  }

  loseNext(operation: string, when: "before" | "after") {
    this.fault = { operation, when };
  }

  async call<T>(
    operation: string,
    input: Record<string, unknown> = {},
    actor: "fixture" | "oracle" = "fixture",
    operationId?: string,
  ): Promise<T> {
    const application = new ApplicationHttp(this.service, {
      bookId: this.service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    const response = await application.fetch(
      new Request(`http://127.0.0.1/v1/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: this.service.bookId,
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    this.record({
      actor,
      channel: "api",
      operation,
      input,
      ...(operationId ? { operationId } : {}),
      result,
      delivered: true,
    });
    if (!result.ok)
      throw new FixtureRequestFailure(
        (result.error as { code: string }).code,
        `Fixture ${operation}: ${JSON.stringify(result.error)}`,
      );
    return result.data as T;
  }

  async seed(event: FixtureEvent, post = true) {
    const draft = await this.call<SavedDraft>(
      "drafts.create",
      {
        data: {
          date: event.date,
          reference: event.sourceId,
          narration: event.sourceId,
          source: {
            id: event.sourceId,
            description: `${event.sourceId}: USD ${event.amount} on ${event.date}`,
          },
          lines: [
            { accountId: event.debit, debit: event.amount, credit: "" },
            { accountId: event.credit, debit: "", credit: event.amount },
          ],
        },
      },
      "fixture",
      crypto.randomUUID(),
    );
    const plan = await this.call<PreparedOperation>(
      "journal.prepare",
      { draftId: draft.id, expectedVersion: draft.version },
      "fixture",
      crypto.randomUUID(),
    );
    if (!plan.valid) throw new Error("Invalid fixture preparation");
    if (post)
      await this.call(
        "operations.commit",
        { planId: plan.planId, planHash: plan.planHash },
        "fixture",
        plan.planId,
      );
    return { draft, plan };
  }

  async snapshot(): Promise<Snapshot> {
    const context = await this.call<{ setup: unknown }>("book.get", {}, "oracle");
    const reports = context.setup
      ? await this.call<CoreReports>("reports.get", { asOf: "2026-01-31" }, "oracle")
      : null;
    const journals: JournalEntry[] = [],
      drafts: SavedDraft[] = [],
      sources: SourceRecord[] = [];
    if (reports) {
      for (let page = 1; ; page++) {
        const rows = await this.call<{ count: number; entries: { id: string }[] }>(
          "journal.list",
          { status: "Posted", revision: reports.bookRevision, page },
          "oracle",
        );
        for (const row of rows.entries)
          journals.push(
            await this.call<JournalEntry>(
              "journal.get",
              { journalId: row.id, revision: reports.bookRevision },
              "oracle",
            ),
          );
        if (page * 25 >= rows.count) break;
      }
      for (let page = 1; ; page++) {
        const rows = await this.call<{ count: number; drafts: SavedDraft[] }>(
          "drafts.list",
          { page },
          "oracle",
        );
        drafts.push(...rows.drafts);
        if (page * 25 >= rows.count) break;
      }
      for (let page = 1; ; page++) {
        const rows = await this.call<{ count: number; sources: { source: { id: string } }[] }>(
          "sources.list",
          { page },
          "oracle",
        );
        for (const row of rows.sources)
          sources.push(
            await this.call<SourceRecord>("sources.get", { sourceId: row.source.id }, "oracle"),
          );
        if (page * 25 >= rows.count) break;
      }
    }
    const operations: Record<string, OperationStatus> = {};
    const ids = new Set(
      this.trace
        .flatMap((entry) => [
          entry.operationId,
          typeof entry.input.planId === "string" ? entry.input.planId : undefined,
        ])
        .filter((id): id is string => Boolean(id)),
    );
    for (const operationId of ids) {
      try {
        operations[operationId] = await this.call<OperationStatus>(
          "operations.get",
          { operationId },
          "oracle",
        );
      } catch (error) {
        if (!(error instanceof FixtureRequestFailure) || error.code !== "operation_not_found")
          throw error;
        /* An unadmitted request may legitimately have no retained operation. Its failed lookup remains in the trace. */
      }
    }
    return {
      setup: context.setup,
      reports,
      journals,
      drafts,
      sources,
      periods: reports ? await this.call<PeriodList>("periods.list", {}, "oracle") : null,
      operations,
    };
  }

  save(name: string, value: unknown) {
    writeFileSync(join(this.directory, name), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async stop() {
    if (this.proxy) await this.proxy.stop(true);
    if (this.mcp) await this.mcp.stop();
    if (this.api) await this.api.stop(true);
    this.service.close();
  }
}

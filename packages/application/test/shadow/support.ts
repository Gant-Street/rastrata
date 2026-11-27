/** A real local book for the shadow lane's tests: a chart shaped like a small online business (a
 * bank account, a savings account, a card, Stripe), a clock the test controls, the versioned HTTP
 * boundary, and helpers that do what a person does on the other screens (post a journal, import
 * statement lines, reconcile, back up). Everything is synthetic: no real business data. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import type { IngestPort } from "../../src/ingest-types.ts";
import { LocalBookService, type LocalOpenOptions } from "../../src/local.ts";
import { configureSafety } from "../../src/safety/jobs.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "../../src/schema.ts";
import { ingestPort } from "../../src/slices/ingest/port.ts";
import { batchOf, type LineInit } from "../support/ingest-fixture.ts";

export const BOOK = {
  name: "Shadow Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  basis: "cash",
  accounts: [
    { code: "1000", name: "Business checking", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1010", name: "Business savings", role: "asset", tags: { cashFlowClass: "cash" } },
    {
      code: "1100",
      name: "Stripe balance",
      role: "asset",
      tags: { cashFlowClass: "cash", roleKey: "stripe.balance" },
    },
    {
      code: "1110",
      name: "Stripe payouts in transit",
      role: "asset",
      tags: { cashFlowClass: "cash", roleKey: "payouts.in-transit" },
    },
    { code: "1500", name: "Equipment", role: "asset", tags: { cashFlowClass: "investing" } },
    {
      code: "2000",
      name: "Business credit card",
      role: "liability",
      tags: { cashFlowClass: "operating" },
    },
    {
      code: "2500",
      name: "Sales tax payable",
      role: "liability",
      tags: { cashFlowClass: "operating", roleKey: "tax.sales" },
    },
    {
      code: "3000",
      name: "Owner's investment",
      role: "equity",
      tags: { cashFlowClass: "financing" },
    },
    {
      code: "3900",
      name: "Opening balance equity",
      role: "equity",
      tags: { cashFlowClass: "financing" },
    },
    { code: "4000", name: "Sales", role: "income", tags: { roleKey: "revenue.sales" } },
    { code: "6000", name: "Software and subscriptions", role: "expense" },
    { code: "6025", name: "Stripe fees", role: "expense", tags: { roleKey: "stripe.fees" } },
  ],
} as const;

export type Json = Awaited<ReturnType<Response["json"]>>;

const cleanup: (() => void)[] = [];
export const closeShadowFixtures = () => {
  for (const work of cleanup.splice(0)) work();
};

/** A local date at noon, so the service's local-date reading of "today" is the same everywhere. */
export const at = (date: string): Date => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12, 0, 0);
};

export interface ShadowFixture {
  readonly service: LocalBookService;
  readonly port: IngestPort;
  /** Change what the service reads as today. */
  today(date: string): void;
  call(
    name: string,
    input?: unknown,
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ): Promise<{ status: number; body: Json }>;
  /** Call and require success; returns the data. */
  ok(name: string, input?: unknown, operationId?: string): Promise<Json>;
  /** Post an entry the way the Journal screen does: draft, prepare, commit. */
  post(
    date: string,
    narration: string,
    lines: readonly (readonly [string, string, string])[],
  ): Promise<string>;
  /** Submit statement lines for a chart account as a CSV import would. */
  importLines(
    accountId: string,
    lines: readonly LineInit[],
    extra?: Parameters<typeof batchOf>[2],
  ): ReturnType<IngestPort["submit"]>;
  /** Run a long job (backup, verify, drill) to its end. */
  finish(name: string, input?: unknown): Promise<Json>;
  /** Back up and verify, so the checklist finds a verified backup. */
  backUp(): Promise<void>;
  /** Reconcile an account to a statement ending balance, selecting every line. */
  reconcile(accountId: string, statementDate: string, statementBalance: string): Promise<Json>;
  restart(options?: LocalOpenOptions): Promise<void>;
}

/** The first date of the book is 2026-01-01; `today` is when the clock starts. */
export async function shadowFixture(
  options: { today?: string; open?: LocalOpenOptions; setup?: boolean } = {},
): Promise<ShadowFixture> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-shadow-"));
  const path = join(directory, "book.sqlite");
  let current = options.today ?? "2026-11-20";
  const clock = () => at(current);
  let service = await LocalBookService.open(path, { now: clock, ...options.open });
  configureSafety(service, { waitMs: 60_000 });
  cleanup.push(() => {
    try {
      service.close();
    } catch {
      // Already closed by the test.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const fixture: ShadowFixture = {
    get service() {
      return service;
    },
    get port() {
      return ingestPort(service);
    },
    today(date) {
      current = date;
    },
    async call(name, input = {}, operationId, permissions) {
      const http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: permissions ?? BUSINESS_PERMISSIONS,
      });
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: service.bookId,
            input,
            ...(operationId ? { operationId } : {}),
          }),
        }),
      );
      return { status: response.status, body: await response.json() };
    },
    async ok(name, input = {}, operationId) {
      const answer = await fixture.call(name, input, operationId ?? crypto.randomUUID());
      if (!answer.body.ok) throw new Error(`${name} failed: ${JSON.stringify(answer.body.error)}`);
      return answer.body.data;
    },
    async post(date, narration, lines) {
      const draft = await fixture.ok("drafts.create", {
        data: {
          date,
          reference: narration.slice(0, 80),
          narration,
          lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
        },
      });
      const prepared = await fixture.ok("journal.prepare", {
        draftId: draft.id,
        expectedVersion: draft.version,
      });
      if (!prepared.valid) throw new Error(`prepare failed: ${JSON.stringify(prepared.problems)}`);
      const done = await fixture.call("operations.commit", {
        planId: prepared.planId,
        planHash: prepared.planHash,
      });
      if (!done.body.ok || done.body.data.disposition !== "committed")
        throw new Error(`commit failed: ${JSON.stringify(done.body)}`);
      return prepared.effects.journals[0].id as string;
    },
    importLines(accountId, lines, extra = {}) {
      const port = ingestPort(service);
      return port.submit(
        batchOf(port, lines, {
          accountKey: `csv:${accountId}`,
          sourceKey: `csv:${accountId}`,
          ledgerAccountId: accountId,
          ...extra,
        }),
      );
    },
    async finish(name, input = {}) {
      const id = crypto.randomUUID();
      for (let attempt = 0; attempt < 600; attempt++) {
        const answer = await fixture.call(name, input, id);
        if (answer.status !== 200) throw new Error(`${name}: ${JSON.stringify(answer.body.error)}`);
        if (answer.body.data.state !== "running") return answer.body.data;
        await Bun.sleep(50);
      }
      throw new Error(`${name} did not finish`);
    },
    async backUp() {
      const made = await fixture.finish("backup.create");
      if (made.state !== "done") throw new Error(`backup failed: ${JSON.stringify(made.error)}`);
      const checked = await fixture.finish("backup.verify");
      if (checked.state !== "done" || !checked.verification.passed)
        throw new Error(`verify failed: ${JSON.stringify(checked)}`);
    },
    async reconcile(accountId, statementDate, statementBalance) {
      const draft = await fixture.ok("reconcile.start", {
        accountId,
        statementDate,
        statementBalance,
      });
      const selected = await fixture.ok("reconcile.setCleared", {
        id: draft.id,
        expectedVersion: draft.version,
        reset: "all",
      });
      return fixture.ok("reconcile.complete", { id: draft.id, expectedVersion: selected.version });
    },
    async restart(open) {
      service.close();
      service = await LocalBookService.open(path, { now: clock, ...(open ?? options.open) });
      configureSafety(service, { waitMs: 60_000 });
    },
  };
  if (options.setup !== false) await fixture.ok("book.setup", BOOK);
  return fixture;
}

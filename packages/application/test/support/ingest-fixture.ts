/** A configured local book with a bank-shaped chart, an `ApplicationHttp` to call operations
 * through, and builders for ingestion batches. Test support for the ingest lane. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import type { BankLine, IngestBatch, IngestPort, LedgerEvent } from "../../src/ingest-types.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { BusinessPermission } from "../../src/schema.ts";
import { ingestPort } from "../../src/slices/ingest/port.ts";

export const CHART = [
  { code: "1000", name: "Checking", role: "asset" },
  { code: "1100", name: "Savings", role: "asset" },
  { code: "2000", name: "Card", role: "liability" },
  { code: "3000", name: "Capital", role: "equity" },
  { code: "4000", name: "Sales", role: "income" },
  { code: "5000", name: "Software", role: "expense" },
  { code: "5100", name: "Meals", role: "expense" },
  { code: "5200", name: "Fees", role: "expense" },
] as const;

export const BOOK = {
  name: "Ingest Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: CHART,
};

const cleanup: (() => void)[] = [];
export const closeFixtures = () => {
  for (const work of cleanup.splice(0)) work();
};

/** Parsed JSON, typed the way `Response.json()` types it, so tests can read fields freely. */
export type Json = Awaited<ReturnType<Response["json"]>>;

export interface Fixture {
  readonly path: string;
  readonly service: LocalBookService;
  readonly port: IngestPort;
  call(
    name: string,
    input?: unknown,
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ): Promise<{ status: number; body: Json }>;
  /** A second service over the same file, as another process would hold. */
  second(): Promise<LocalBookService>;
  restart(): Promise<void>;
}

export async function ingestFixture(options: { setup?: boolean } = {}): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-ingest-"));
  const path = join(directory, "book.sqlite");
  let service = await LocalBookService.open(path);
  const extras: LocalBookService[] = [];
  cleanup.push(() => {
    for (const extra of extras) extra.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const fixture: Fixture = {
    path,
    get service() {
      return service;
    },
    get port() {
      return ingestPort(service);
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
    async second() {
      const other = await LocalBookService.open(path);
      extras.push(other);
      return other;
    },
    async restart() {
      service.close();
      service = await LocalBookService.open(path);
    },
  };
  if (options.setup !== false) {
    const result = await fixture.call("book.setup", BOOK, crypto.randomUUID());
    if (!result.body.ok) throw new Error(`Book setup failed: ${JSON.stringify(result.body)}`);
  }
  return fixture;
}

export interface LineInit {
  readonly date: string;
  readonly amount: string;
  readonly description: string;
  readonly providerId?: string;
  readonly currency?: string;
  readonly counterparty?: string;
  readonly reference?: string;
  readonly runningBalance?: string;
  readonly excerpt?: string;
}

export const bankLine = (
  init: LineInit,
  rawIndex: number,
  provider = "csv",
  accountKey = "csv:1000",
): BankLine => ({
  kind: "bankLine",
  provider,
  accountKey,
  ...(init.providerId !== undefined ? { providerId: init.providerId } : {}),
  rawIndex,
  ...(init.excerpt !== undefined ? { excerpt: init.excerpt } : {}),
  postedOn: init.date,
  amount: init.amount,
  currency: init.currency ?? "USD",
  description: init.description,
  ...(init.counterparty !== undefined ? { counterparty: init.counterparty } : {}),
  ...(init.reference !== undefined ? { reference: init.reference } : {}),
  ...(init.runningBalance !== undefined ? { runningBalance: init.runningBalance } : {}),
});

let unique = 0;

/** Archive the lines as the "file" they came from and build the batch that submits them. Each call
 * gives different bytes unless `bytes` says otherwise, as two downloads of a bank's CSV would. */
export function batchOf(
  port: IngestPort,
  lines: readonly LineInit[],
  extra: Partial<IngestBatch> & { readonly bytes?: string; readonly accountKey?: string } = {},
): IngestBatch {
  const { bytes, accountKey, ...rest } = extra;
  const text = bytes ?? `${JSON.stringify(lines)}#${unique++}`;
  const raw = port.archive(new TextEncoder().encode(text), "text/csv", "statement.csv");
  return {
    provider: "csv",
    sourceKey: "csv:1000",
    raw,
    lines: lines.map((line, index) => bankLine(line, index, "csv", accountKey ?? "csv:1000")),
    balances: [],
    fetchedAt: "2026-04-01T00:00:00.000Z",
    ...rest,
  };
}

export const stripeEvent = (
  id: string,
  date: string,
  legs: readonly { role: string; amount: string }[],
  rawIndex = 0,
  extra: Partial<LedgerEvent> = {},
): LedgerEvent => ({
  kind: "event",
  provider: "stripe",
  accountKey: "stripe:acct_1:usd",
  providerId: id,
  rawIndex,
  eventOn: date,
  summary: `Stripe ${id}`,
  currency: "USD",
  legs,
  ...extra,
});

export function itemRows(f: Fixture, where = "1=1"): Json[] {
  return f.service.store
    .query(`SELECT * FROM app_ingest_items WHERE ${where} ORDER BY seq`)
    .all() as Json[];
}

export const count = (f: Fixture, table: string): number =>
  (f.service.store.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Post an entry by hand through the application, as a person on the Journal screen would: draft,
 * prepare, commit. Returns the id of the journal. */
export async function postManual(
  f: Fixture,
  date: string,
  narration: string,
  lines: readonly { accountId: string; debit: string; credit: string }[],
): Promise<string> {
  const draft = await f.call(
    "drafts.create",
    { data: { date, reference: narration.slice(0, 80), narration, lines } },
    crypto.randomUUID(),
  );
  if (!draft.body.ok) throw new Error(`draft failed: ${JSON.stringify(draft.body)}`);
  const prepared = await f.call(
    "journal.prepare",
    { draftId: draft.body.data.id, expectedVersion: draft.body.data.version },
    crypto.randomUUID(),
  );
  if (!prepared.body.ok || !prepared.body.data.valid)
    throw new Error(`prepare failed: ${JSON.stringify(prepared.body)}`);
  const done = await f.call("operations.commit", {
    planId: prepared.body.data.planId,
    planHash: prepared.body.data.planHash,
  });
  if (!done.body.ok || done.body.data.disposition !== "committed")
    throw new Error(`commit failed: ${JSON.stringify(done.body)}`);
  return prepared.body.data.effects.journals[0].id as string;
}

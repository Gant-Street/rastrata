import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import type { BankLine } from "../../src/ingest-types.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { BusinessPermission } from "../../src/schema.ts";
import { ingestPort } from "../../src/slices/ingest/port.ts";
import { configureStripeRuntime } from "../../src/slices/stripe/runtime.ts";
import { type FakePort, fakePort } from "./fake-port.ts";
import { type FakeStripe, fakeStripe } from "./fake-stripe.ts";
import { NOW, type Scenario, buildScenario, fakeKey } from "./fixtures.ts";

/** A book with the online-business accounts (each tagged with its Stripe role key, as the chart
 * template creates them), a fake Stripe, a fake pipeline port and an injected clock. */

export const KEY = fakeKey();

export const ONLINE_BOOK = {
  name: "Example Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Checking", role: "asset" },
    { code: "1100", name: "Stripe balance", role: "asset", tags: { roleKey: "stripe.balance" } },
    {
      code: "1110",
      name: "Stripe payouts in transit",
      role: "asset",
      tags: { roleKey: "payouts.in-transit" },
    },
    { code: "2500", name: "Sales tax payable", role: "liability", tags: { roleKey: "tax.sales" } },
    { code: "3000", name: "Owner's equity", role: "equity" },
    { code: "4000", name: "Sales", role: "income", tags: { roleKey: "revenue.sales" } },
    // Not tagged: where a role key can be moved to.
    { code: "4010", name: "Other sales", role: "income" },
    { code: "4100", name: "Returns and allowances", role: "income", tags: { roleKey: "refunds" } },
    { code: "6025", name: "Stripe fees", role: "expense", tags: { roleKey: "stripe.fees" } },
    {
      code: "6026",
      name: "Chargebacks and disputes",
      role: "expense",
      tags: { roleKey: "chargebacks" },
    },
    { code: "6050", name: "Other processing costs", role: "expense" },
  ],
} as const;

/** The same book with the optional account for what Stripe adjusts that Rastrata does not book by
 * itself (the chart template does not create it; the owner adds and tags it). */
export const ONLINE_BOOK_WITH_ADJUSTMENTS = {
  ...ONLINE_BOOK,
  accounts: [
    ...ONLINE_BOOK.accounts,
    {
      code: "6040",
      name: "Other Stripe adjustments",
      role: "expense",
      tags: { roleKey: "stripe.adjustments" },
    },
  ],
} as const;

/** The same accounts with no role keys at all, as a book set up by hand would have them. */
export const UNTAGGED_BOOK = {
  ...ONLINE_BOOK,
  accounts: ONLINE_BOOK.accounts.map(({ code, name, role }) => ({ code, name, role })),
} as const;

/** The chart account each Stripe role resolves to in the online-business book. */
export const ACCOUNT_OF: Readonly<Record<string, string>> = {
  "stripe.balance": "1100",
  "payouts.in-transit": "1110",
  "tax.sales": "2500",
  "revenue.sales": "4000",
  refunds: "4100",
  "stripe.fees": "6025",
  chargebacks: "6026",
  "stripe.adjustments": "6040",
};

// biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely.
type Loose = any;

export interface World {
  readonly service: LocalBookService;
  readonly scenario: Scenario;
  readonly stripe: FakeStripe;
  readonly port: FakePort;
  readonly clock: { ms: number; perRequestMs: number };
  call(
    name: string,
    input?: unknown,
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ): Promise<{ status: number; body: Loose }>;
  /** `POST /v1/uploads` with the headers given: the raw body route. */
  upload(
    body: Uint8Array | string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Loose }>;
  close(): void;
  readonly path: string;
}

export interface WorldOptions {
  readonly scenario?: Scenario;
  /** A service that holds no Stripe key and never will (a hosted one): Stripe arrives by `stripe.receive`. */
  readonly senderFetches?: boolean;
  readonly key?: string | null;
  readonly book?: unknown;
  readonly maxLimit?: number;
  /** Use the service's real ingestion pipeline instead of the fake port. */
  readonly realPort?: boolean;
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-stripe-"));
  const path = join(directory, "book.sqlite");
  const clock = { ms: (NOW + 3600) * 1000, perRequestMs: 0 };
  const service = await LocalBookService.open(path, { now: () => new Date(clock.ms) });
  const scenario = options.scenario ?? buildScenario();
  const stripe = fakeStripe(scenario, {
    key: KEY,
    ...(options.maxLimit ? { maxLimit: options.maxLimit } : {}),
  });
  const port = fakePort();
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  configureStripeRuntime(service, {
    keySource: {
      read: () =>
        options.key === null ? null : { key: options.key ?? KEY, source: "environment" },
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      clock.ms += clock.perRequestMs;
      return stripe.fetch(input, init);
    }) as typeof fetch,
    now: () => new Date(clock.ms).toISOString(),
    sleep: async (ms) => {
      clock.ms += ms;
    },
    random: () => 0.5,
    ...(options.senderFetches ? { senderFetches: true } : {}),
    ...(options.realPort ? {} : { port }),
  });
  const call: World["call"] = async (name, input = {}, operationId, permissions) => {
    const target = permissions
      ? new ApplicationHttp(service, { bookId: service.bookId, permissions })
      : http;
    const response = await target.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    return { status: response.status, body: (await response.json()) as never };
  };
  const upload: World["upload"] = async (body, headers = {}) => {
    const response = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/uploads", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : (body as unknown as BodyInit),
      }),
    );
    return { status: response.status, body: (await response.json()) as never };
  };
  const result: World = {
    service,
    scenario,
    stripe,
    port,
    clock,
    call,
    upload,
    path,
    close() {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  const setup = await call("book.setup", options.book ?? ONLINE_BOOK, crypto.randomUUID());
  if (!setup.body.ok) throw new Error(`book setup failed: ${JSON.stringify(setup.body)}`);
  return result;
}

export const uuid = (): string => crypto.randomUUID();

/** What the Inbox does once the owner has looked: accept every complete proposal Stripe made for a
 * payout, then post what was accepted. Only payouts are offered: the transactions they carry are
 * evidence and follow them. */
export async function acceptAndPost(
  w: World,
  minConfidence = 100,
): Promise<{ accepted: Loose; posted: Loose }> {
  const filter = { provider: "stripe", covered: false };
  const accepted = await w.call(
    "inbox.accept",
    { filter, proposer: "stripe", minConfidence },
    uuid(),
  );
  const posted = await w.call("inbox.post", { filter }, uuid());
  return { accepted: accepted.body, posted: posted.body };
}

export interface JournalEntry {
  id: string;
  isoDate: string;
  reference: string;
  amount: string;
  debitTotal: string;
  creditTotal: string;
  lines: { accountId: string; debit: string | null; credit: string | null }[];
}

/** Every journal of the book, paging through the register 25 at a time. */
export async function journals(w: World): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for (let page = 1; page < 200; page++) {
    const data = (await w.call("journal.list", { page })).body.data;
    out.push(...(data.entries as JournalEntry[]));
    if (out.length >= data.count || data.entries.length === 0) break;
  }
  return out;
}

/** A journal's lines as "account debit" and "account credit" strings, in the order they are listed. */
export const linesOf = (entry: JournalEntry): string[] =>
  entry.lines.map((l) =>
    l.debit ? `${l.accountId} Dr ${l.debit}` : `${l.accountId} Cr ${l.credit}`,
  );

/** A deposit as the bank's statement shows it: from another source, in the checking account. */
export const deposit = (id: string, date: string, amount: string): BankLine => ({
  kind: "bankLine",
  provider: "csv",
  accountKey: "csv:checking",
  providerId: id,
  rawIndex: 0,
  postedOn: date,
  amount,
  currency: "USD",
  description: "STRIPE TRANSFER ST-0001",
});

export function importDeposits(w: World, lines: readonly BankLine[]): void {
  const port = ingestPort(w.service);
  const raw = port.archive(
    new TextEncoder().encode(`bank file ${lines.map((l) => l.providerId)}`),
    "text/csv",
    "checking.csv",
  );
  port.submit({
    provider: "csv",
    sourceKey: "csv:checking",
    raw,
    lines: lines.map((line, index) => ({ ...line, rawIndex: index })),
    balances: [],
    fetchedAt: new Date(w.clock.ms).toISOString(),
    ledgerAccountId: "1000",
  });
}

export async function itemIdOf(w: World, providerId: string): Promise<string> {
  const page = await w.call("inbox.list", { pageSize: 200 });
  const found = (page.body.data.items as { id: string; line: { providerId?: string } }[]).find(
    (item) => item.line.providerId === providerId,
  );
  if (!found) throw new Error(`no inbox item for ${providerId}`);
  return found.id;
}

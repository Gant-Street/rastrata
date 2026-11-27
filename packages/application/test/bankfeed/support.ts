import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { BusinessPermission } from "../../src/schema.ts";
import { configureBankfeedRuntime } from "../../src/slices/bankfeed/runtime.ts";
import {
  type FakeAccount,
  type FakeBridge,
  NOW,
  checking,
  fakeBridge,
  savings,
} from "./fake-bridge.ts";

/** A configured local book with a bank-shaped chart, a stand-in Bridge, the real credential file in a
 * temporary data directory, the real ingestion pipeline and an injected clock. Test support for the
 * bankfeed lane. Nothing here is a real credential, bank or account. */

export const CHART = [
  { code: "1000", name: "Business Checking", role: "asset" },
  { code: "1100", name: "Business Savings", role: "asset" },
  { code: "1200", name: "Euro Account", role: "asset" },
  { code: "2000", name: "Company Card", role: "liability" },
  { code: "3000", name: "Capital", role: "equity" },
  { code: "4000", name: "Sales", role: "income" },
  { code: "5000", name: "Software", role: "expense" },
  { code: "5100", name: "Meals", role: "expense" },
  { code: "5200", name: "Rent", role: "expense" },
  { code: "1300", name: "Stripe balance", role: "asset", tags: { roleKey: "stripe.balance" } },
] as const;

export const BOOK = {
  name: "Feed Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: CHART,
};

/** Parsed JSON, typed the way `Response.json()` types it, so tests can read fields freely. */
export type Json = Awaited<ReturnType<Response["json"]>>;

export interface World {
  readonly service: LocalBookService;
  readonly bridge: FakeBridge;
  /** The data directory: the book and the credential file are here. */
  readonly directory: string;
  readonly path: string;
  readonly credentialPath: string;
  readonly clock: { ms: number };
  call(
    name: string,
    input?: unknown,
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ): Promise<{ status: number; body: Json }>;
  /** Call an operation that must succeed, and return its data. */
  ok(name: string, input?: unknown, operationId?: string): Promise<Json>;
  restart(): Promise<void>;
  close(): void;
}

export interface WorldOptions {
  readonly accounts?: FakeAccount[];
  readonly book?: unknown;
  /** Connect with the stand-in's setup token right after the book is set up, and list its accounts. */
  readonly connected?: boolean;
  readonly bridge?: FakeBridge;
}

const cleanup: (() => void)[] = [];
export const closeWorlds = (): void => {
  for (const work of cleanup.splice(0)) work();
};

export const uuid = (): string => crypto.randomUUID();

export async function world(options: WorldOptions = {}): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-bankfeed-"));
  const path = join(directory, "book.sqlite");
  const clock = { ms: NOW * 1000 };
  const bridge = options.bridge ?? fakeBridge(options.accounts ?? [checking(), savings()]);
  const open = async (): Promise<LocalBookService> => {
    const service = await LocalBookService.open(path, { now: () => new Date(clock.ms) });
    configureBankfeedRuntime(service, {
      fetch: bridge.fetch,
      sleep: async (ms) => {
        clock.ms += ms;
        bridge.now = Math.floor(clock.ms / 1000);
      },
    });
    return service;
  };
  let service = await open();
  const made: World = {
    get service() {
      return service;
    },
    bridge,
    directory,
    path,
    credentialPath: join(directory, "simplefin.access"),
    clock,
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
    async ok(name, input = {}, operationId = uuid()) {
      const reply = await made.call(name, input, operationId);
      if (!reply.body.ok) throw new Error(`${name} failed: ${JSON.stringify(reply.body.error)}`);
      return reply.body.data;
    },
    async restart() {
      service.close();
      service = await open();
    },
    close() {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  cleanup.push(() => made.close());
  await made.ok("book.setup", options.book ?? BOOK);
  if (options.connected) await made.ok("bankfeed.connect", { setupToken: bridge.setupToken() });
  return made;
}

/** Advance the world's clock (and the Bridge's idea of now) by `ms`. */
export function advance(w: World, ms: number): void {
  w.clock.ms += ms;
  w.bridge.now = Math.floor(w.clock.ms / 1000);
}

export const HOUR = 3_600_000;
export const DAY_MS = 24 * HOUR;

/** The Inbox lines of one provider account, newest listing first as the Inbox gives them. */
export async function lines(
  w: World,
  filter: Record<string, unknown> = {},
): Promise<{ id: string; status: string; flags?: string[]; line: Json }[]> {
  const page = await w.ok("inbox.list", {
    filter: { provider: "simplefin", ...filter },
    pageSize: 200,
  });
  return page.items;
}

export const idsOf = async (w: World, filter: Record<string, unknown> = {}): Promise<string[]> =>
  (await lines(w, filter)).map((item) => item.line.providerId as string).sort();

/** Post an entry by hand through the application, as a person on the Journal screen would: draft,
 * prepare, commit. Returns the id of the journal. */
export async function postManual(
  w: World,
  date: string,
  narration: string,
  entries: readonly { accountId: string; debit: string; credit: string }[],
): Promise<string> {
  const draft = await w.ok("drafts.create", {
    data: { date, reference: narration.slice(0, 80), narration, lines: entries },
  });
  const prepared = await w.ok("journal.prepare", {
    draftId: draft.id,
    expectedVersion: draft.version,
  });
  if (!prepared.valid) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
  const done = await w.call("operations.commit", {
    planId: prepared.planId,
    planHash: prepared.planHash,
  });
  if (!done.body.ok || done.body.data.disposition !== "committed")
    throw new Error(`commit failed: ${JSON.stringify(done.body)}`);
  return prepared.effects.journals[0].id as string;
}

/** The chart's account ids by code. */
export async function chartIds(w: World): Promise<Record<string, string>> {
  const accounts = await w.ok("accounts.list", {});
  return Object.fromEntries(
    accounts.accounts.map((a: { code: string; id: string }) => [a.code, a.id]),
  );
}

/** Link a Bridge account to a chart account by code, as the owner would. */
export async function linkByCode(
  w: World,
  feedAccountId: string,
  code: string,
  startOn?: string,
): Promise<Json> {
  const ids = await chartIds(w);
  return w.ok("bankfeed.link", {
    accountId: feedAccountId,
    ledgerAccountId: ids[code],
    ...(startOn ? { startOn } : {}),
  });
}

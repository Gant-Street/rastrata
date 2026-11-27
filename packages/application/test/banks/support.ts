import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BankAccountOffer, BankTransaction } from "../../src/agent/bank-wire.ts";
import type { ApplicationAccess } from "../../src/agent/principal.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { BOOK } from "../bankfeed/support.ts";

/** A configured local book with a bank-shaped chart, the real ingestion pipeline and an injected clock; the control plane's access, to put accounts and transactions in as
 * the control plane does; and the owner's, to book them. Nothing here is a real bank, account or credential. */

export type Json = Awaited<ReturnType<Response["json"]>>;

export const CLOCK_START = Date.UTC(2026, 9, 18, 12, 0, 0);
export const uuid = (): string => crypto.randomUUID();

/** Seconds since the epoch of a day of October 2026 at 08:00 UTC. */
export const at = (day: number, hour = 8): number => Date.UTC(2026, 9, day, hour) / 1000;

export const checkingOffer = (overrides: Partial<BankAccountOffer> = {}): BankAccountOffer => ({
  id: "fca_checking",
  institution: "Test Bank",
  name: "Business Checking",
  last4: "6789",
  kind: "checking",
  state: "active",
  ...overrides,
});

export const cardOffer = (overrides: Partial<BankAccountOffer> = {}): BankAccountOffer => ({
  id: "fca_card",
  institution: "Test Bank",
  name: "Company Card",
  last4: "4242",
  kind: "credit_card",
  state: "active",
  ...overrides,
});

export const tx = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  id: "fctxn_1",
  amount: -1000,
  currency: "usd",
  description: "Rocket Rides",
  status: "posted",
  transactedAt: at(3),
  postedAt: at(4),
  updated: at(5),
  ...overrides,
});

export interface BanksWorld {
  readonly service: LocalBookService;
  readonly http: ApplicationHttp;
  readonly clock: { ms: number };
  /** The control plane's access: the only one that may offer and receive. */
  readonly control: ApplicationAccess;
  call(
    name: string,
    input?: unknown,
    options?: { as?: ApplicationAccess; id?: string },
  ): Promise<{ status: number; body: Json }>;
  /** Call an operation that must succeed, and return its data. */
  ok(name: string, input?: unknown, as?: ApplicationAccess): Promise<Json>;
  /** The chart's account ids by code. */
  ids(): Promise<Record<string, string>>;
  /** The Inbox lines of the bank provider, as `inbox.list` gives them. */
  lines(
    filter?: Record<string, unknown>,
  ): Promise<{ id: string; status: string; flags?: string[]; line: Json }[]>;
  receive(
    account: BankAccountOffer,
    transactions: BankTransaction[],
    refresh?: string,
  ): Promise<Json>;
  book(account: string, code: string, startOn?: string): Promise<Json>;
  close(): void;
}

const cleanup: (() => void)[] = [];
export const closeWorlds = (): void => {
  for (const work of cleanup.splice(0)) work();
};

export async function world(options: { setup?: boolean } = {}): Promise<BanksWorld> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-banks-"));
  const clock = { ms: CLOCK_START };
  const service = await LocalBookService.open(join(directory, "book.sqlite"), {
    now: () => new Date(clock.ms),
  });
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const control = http.serviceAccess("control");
  const made: BanksWorld = {
    service,
    http,
    clock,
    control,
    async call(name, input = {}, callOptions = {}) {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: service.bookId,
            input,
            operationId: callOptions.id ?? uuid(),
          }),
        }),
        callOptions.as,
      );
      return { status: response.status, body: await response.json() };
    },
    async ok(name, input = {}, as) {
      const reply = await made.call(name, input, as ? { as } : {});
      if (!reply.body.ok) throw new Error(`${name} failed: ${JSON.stringify(reply.body.error)}`);
      return reply.body.data;
    },
    async ids() {
      const accounts = await made.ok("accounts.list", {});
      return Object.fromEntries(
        accounts.accounts.map((account: { code: string; id: string }) => [
          account.code,
          account.id,
        ]),
      );
    },
    async lines(filter = {}) {
      const page = await made.ok("inbox.list", {
        filter: { provider: "bank", ...filter },
        pageSize: 200,
      });
      return page.items;
    },
    receive(account, transactions, refresh = "fctxnref_1") {
      return made.ok("banks.receive", { account, refresh, transactions }, control);
    },
    async book(account, code, startOn) {
      const ids = await made.ids();
      return made.ok("banks.book", {
        account,
        ledgerAccountId: ids[code],
        ...(startOn ? { startOn } : {}),
      });
    },
    close() {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  cleanup.push(() => made.close());
  if (options.setup !== false) await made.ok("book.setup", BOOK);
  return made;
}

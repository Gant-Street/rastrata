import type { FetchFn } from "../../src/bankfeed/client.ts";

/** A stand-in SimpleFIN Bridge, built from the protocol page, the Bridge's developer guide and what a
 * live request with the Bridge's public demo token showed on 2026-10-04 (docs/reference/program/
 * bankfeed.md, "The protocol as verified"). Nothing here is a real credential, bank, account or
 * business: the user and password below are made up for the tests.
 *
 * It behaves as the Bridge was seen to behave:
 *  - claim: `POST /simplefin/claim/<code>` answers the access URL once and 403 "Forbidden (was it
 *    already claimed?)" ever after;
 *  - `GET /simplefin/accounts` with Basic credentials; wrong ones are 403 with a `gen.auth` error;
 *  - `version=2` answers `errlist` and `connections` (and `conn_id` on accounts), anything else the
 *    version 1 shape (`errors`, `org`);
 *  - `start-date` is inclusive and `end-date` exclusive, in epoch seconds; without `start-date` only
 *    the last day is returned, with an `x-api-message` saying so;
 *  - a range over 45 days draws a `gen.api` warning, over 90 days it is capped (with a `gen.api` error
 *    saying so);
 *  - `account=` limits the answer to that account (an unknown id is an empty answer, not an error);
 *  - `balances-only=1` answers every account with an empty transaction list;
 *  - pending transactions are returned only with `pending=1`;
 *  - a malformed `start-date` is 400 with a `gen.api` error.
 * Every request is logged (without the Authorization value) so tests can say what was asked. */

export const FIXTURE_USER = "fx-user-4f9c2a81";
export const FIXTURE_PASSWORD = "fx-pass-7d1e0b66a9c3";
export const FIXTURE_CLAIM_CODE = "FIXTURE-2026-A1B2C3D4";
export const DAY = 86_400;

export interface FakeTransaction {
  id: string;
  posted: number;
  /** A string like the real thing; a number is for tests of what must be refused. */
  amount: string | number;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
  transacted_at?: number;
  [extra: string]: unknown;
}

export interface FakeAccount {
  id: string;
  name: string;
  currency?: string;
  balance: string | number;
  balanceDate: number;
  connId?: string;
  /** Omit to answer the account with no `transactions` key at all. */
  transactions?: FakeTransaction[];
}

export interface FakeConnection {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
}

export interface FakeProblem {
  code?: string;
  msg: string;
  conn_id?: string;
  account_id?: string;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string[]>;
  hasAuthorization: boolean;
  /** The URL as it was handed to fetch: tests check it carries no credentials. */
  url: string;
  status: number;
  /** The Bridge's idea of now when the request arrived, in epoch seconds. */
  at: number;
}

export type Override = (request: { url: URL; method: string }) => Response | null;

export class FakeBridge {
  /** Where this Bridge is: the Bridge's own address, or a loopback one when it is served locally. */
  readonly origin: string;
  accounts: FakeAccount[] = [];
  connections: FakeConnection[] = [];
  /** Added to every answer's `errlist` (version 2) or `errors` (version 1). */
  problems: FakeProblem[] = [];
  /** Added to `errors` even in a version 2 answer: how the Bridge sends its warnings. */
  warnings: string[] = [];
  /** Added as `x-api-message`. */
  messages: string[] = [];
  claimed = false;
  readonly log: LoggedRequest[] = [];
  /** One-shot answers, used in order before the normal behaviour. */
  readonly overrides: Override[] = [];
  /** Seconds since 1970, the Bridge's idea of now. */
  now: number;
  /** How a careless server behaves, for tests of what must not be trusted. */
  sloppy: { ignoreEnd: boolean; ignoreStart: boolean; sendPending: boolean } = {
    ignoreEnd: false,
    ignoreStart: false,
    sendPending: false,
  };

  constructor(
    now = Date.UTC(2026, 9, 4, 13, 0, 0) / 1000,
    origin = "https://beta-bridge.simplefin.org",
  ) {
    this.now = now;
    this.origin = origin;
  }

  get host(): string {
    return new URL(this.origin).host;
  }

  /** The setup token a person would copy: base64 of the claim URL. */
  setupToken(code = FIXTURE_CLAIM_CODE): string {
    return btoa(`${this.origin}/simplefin/claim/${code}`);
  }

  accessUrl(): string {
    const url = new URL(this.origin);
    return `${url.protocol}//${FIXTURE_USER}:${FIXTURE_PASSWORD}@${url.host}/simplefin`;
  }

  requests(kind?: "claim" | "accounts"): LoggedRequest[] {
    return this.log.filter(
      (entry) => kind === undefined || (kind === "claim") === entry.path.includes("/claim/"),
    );
  }

  /** Answer the next request with this, whatever it is. */
  respondOnce(status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    this.overrides.push(
      () =>
        new Response(text, {
          status,
          headers: {
            "content-type": typeof body === "string" ? "text/plain" : "application/json",
            ...headers,
          },
        }),
    );
  }

  /** Fail the next request as the network would. */
  failOnce(): void {
    this.overrides.push(() => {
      throw new TypeError("fetch failed: connect ECONNREFUSED beta-bridge.simplefin.org:443");
    });
  }

  readonly fetch: FetchFn = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const logged: LoggedRequest = {
      method,
      path: url.pathname,
      query: {},
      hasAuthorization: headers.has("authorization"),
      url: url.toString(),
      status: 0,
      at: this.now,
    };
    for (const [name, value] of url.searchParams) {
      const list = logged.query[name] ?? [];
      list.push(value);
      logged.query[name] = list;
    }
    this.log.push(logged);
    const next = this.overrides.shift();
    if (next) {
      const response = next({ url, method });
      if (response) {
        logged.status = response.status;
        return response;
      }
    }
    const response = this.answer(url, method, headers);
    logged.status = response.status;
    return response;
  };

  private text(status: number, body: string): Response {
    return new Response(body, { status, headers: { "content-type": "text/plain" } });
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private answer(url: URL, method: string, headers: Headers): Response {
    const claim = /^\/simplefin\/claim\/(.+)$/.exec(url.pathname);
    if (claim) {
      if (method !== "POST") return this.text(405, "Method Not Allowed");
      if (claim[1] !== FIXTURE_CLAIM_CODE || this.claimed)
        return this.text(403, "Forbidden (was it already claimed?)");
      this.claimed = true;
      return this.text(200, this.accessUrl());
    }
    if (url.pathname === "/simplefin/info") return this.json(200, { versions: ["1.0"] });
    if (url.pathname !== "/simplefin/accounts" || method !== "GET")
      return this.text(404, "Not Found");
    const expected = `Basic ${btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`)}`;
    if (headers.get("authorization") !== expected)
      return this.json(403, {
        errlist: [{ code: "gen.auth", msg: "Forbidden" }],
        accounts: [],
        connections: [],
      });

    const v2 = url.searchParams.get("version") === "2";
    const problems: FakeProblem[] = [...this.problems];
    const startText = url.searchParams.get("start-date");
    const endText = url.searchParams.get("end-date");
    for (const text of [startText, endText])
      if (text !== null && !/^[0-9]+$/.test(text))
        return this.json(400, {
          errlist: [
            {
              code: "gen.api",
              msg: `Invalid ${text === startText ? "start" : "end"}-date provided. It must be a UNIX timestamp integer.`,
            },
          ],
          accounts: [],
          connections: [],
        });
    const end = endText === null ? this.now + DAY : Number(endText);
    let start = startText === null ? this.now - DAY : Number(startText);
    if (end - start > 90 * DAY) {
      start = end - 90 * DAY;
      problems.push({
        code: "gen.api",
        msg: "Requested date range exceeds limit of 90 days and was capped.",
      });
    } else if (end - start > 45 * DAY)
      problems.push({
        code: "gen.api",
        msg: "Requested date range exceeds recommended range of 45 days. In the future, this may be capped.",
      });
    const wanted = url.searchParams.getAll("account");
    const balancesOnly = url.searchParams.get("balances-only") === "1";
    const withPending = url.searchParams.get("pending") === "1" || this.sloppy.sendPending;
    const chosen = this.accounts.filter(
      (account) => wanted.length === 0 || wanted.includes(account.id),
    );
    const accounts = chosen.map((account) => {
      const out: Record<string, unknown> = {
        id: account.id,
        name: account.name,
        currency: account.currency ?? "USD",
        balance: account.balance,
        "available-balance": account.balance,
        "balance-date": account.balanceDate,
      };
      if (account.transactions !== undefined)
        out.transactions = balancesOnly
          ? []
          : account.transactions
              .filter((tx) => (withPending ? true : tx.pending !== true))
              .filter(
                (tx) =>
                  tx.pending === true ||
                  ((this.sloppy.ignoreStart || tx.posted >= start) &&
                    (this.sloppy.ignoreEnd || tx.posted < end)),
              );
      if (v2) {
        if (account.connId !== undefined) out.conn_id = account.connId;
      } else {
        const connection = this.connections.find((c) => c.id === account.connId);
        out.org = {
          name: connection?.orgName ?? "Fixture Bank",
          domain: "bank.invalid",
          "sfin-url": `${this.origin}/simplefin`,
          id: connection?.orgId ?? "fixture.org",
        };
      }
      return out;
    });
    const body: Record<string, unknown> = v2
      ? {
          errlist: problems,
          accounts,
          connections: this.connections.map((c) => ({
            conn_id: c.id,
            name: c.name,
            org_id: c.orgId,
            org_name: c.orgName,
            org_url: `https://${c.orgId}`,
            sfin_url: `${this.origin}/simplefin`,
          })),
        }
      : { errors: problems.map((p) => p.msg), accounts };
    if (this.warnings.length > 0) body.errors = [...this.warnings];
    const notes = [...this.messages];
    // As seen live: asked for transactions with no start-date, the Bridge says so (balances-only is not).
    if (startText === null && !balancesOnly)
      notes.push("Provide a 'start-date' parameter to receive transactions prior to yesterday");
    if (notes.length > 0) body["x-api-message"] = notes;
    return this.json(200, body);
  }
}

/** A month of one business's checking account, written by hand: the same figures every time.
 * `now` is 2026-10-04 13:00 UTC. Every transaction is posted at 08:00 UTC, midnight Pacific, as the
 * Bridge's demo data is. */
export const NOW = Date.UTC(2026, 9, 4, 13, 0, 0) / 1000;
export const day = (iso: string, hour = 8): number => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hour) / 1000;
};

export function checking(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id: "ACT-checking-0001",
    name: "Business Checking",
    currency: "USD",
    balance: "4021.35",
    balanceDate: day("2026-10-04", 12),
    connId: "CON-bank-a",
    transactions: [
      {
        id: "T-1001",
        posted: day("2026-09-28"),
        amount: "-12.50",
        description: "COFFEE SHOP 0042",
        payee: "Coffee Shop",
      },
      {
        id: "T-1002",
        posted: day("2026-09-29"),
        amount: "2500.00",
        description: "ACME INVOICE 77 PAYMENT",
      },
      { id: "T-1003", posted: day("2026-09-30"), amount: "-1200.00", description: "RENT SEPT" },
      {
        id: "T-1004",
        posted: day("2026-10-01"),
        amount: "-45.15",
        description: "SOFTWARE SUBSCRIPTION",
      },
      { id: "T-1005", posted: day("2026-10-02"), amount: "-19.00", description: "CLOUD HOSTING" },
    ],
    ...overrides,
  };
}

export function savings(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id: "ACT-savings-0002",
    name: "Business Savings",
    currency: "USD",
    balance: "10000.00",
    balanceDate: day("2026-10-04", 12),
    connId: "CON-bank-a",
    transactions: [
      { id: "S-2001", posted: day("2026-09-30"), amount: "1.20", description: "INTEREST" },
    ],
    ...overrides,
  };
}

export const BANK_A: FakeConnection = {
  id: "CON-bank-a",
  name: "Example Bank (business)",
  orgId: "bank-a.invalid",
  orgName: "Example Bank",
};

export function fakeBridge(accounts: FakeAccount[] = [checking(), savings()]): FakeBridge {
  const bridge = new FakeBridge();
  bridge.accounts = accounts;
  bridge.connections = [BANK_A];
  return bridge;
}

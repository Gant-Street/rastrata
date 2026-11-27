import { type Entry, type Json, type Scenario, membersOf } from "./fixtures.ts";

/** An in-memory stand-in for api.stripe.com, as an injected `fetch`. It serves the scenario in
 * Stripe's documented shapes: newest first, `limit` and `starting_after` paging, `created` ranges,
 * `payout` and `expand[]=data.source`, plus balance, account, Checkout Sessions and invoice
 * payments. It enforces what a real read-only integration must respect (GET only, a bearer key,
 * nothing secret in the URL) and records every request so tests can assert on them.
 *
 * Tests never reach the network: `fetch` is injected everywhere. */

export interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string[]>>;
  readonly keyInUrl: boolean;
  readonly authorised: boolean;
  readonly stripeVersion: string | null;
}

export interface FakeStripe {
  readonly fetch: typeof fetch;
  readonly seen: Seen[];
  /** Replace what a request returns. Return nothing to let the fake answer normally. */
  intercept(handler: (request: Seen, index: number) => Response | undefined): void;
  /** Add or change balance transactions after the fact (new activity arrives). */
  push(entry: Entry): void;
}

const error = (status: number, message: string, type = "invalid_request_error"): Response =>
  Response.json({ error: { type, message } }, { status });

export function fakeStripe(
  scenario: Scenario,
  options: {
    readonly key: string;
    /** Stripe truncates `limit` at 100; a smaller value forces multi-page lists in tests. */
    readonly maxLimit?: number;
    /** The instant the balance is read at; defaults to the scenario's. */
    readonly now?: () => number;
  },
): FakeStripe {
  const entries: Entry[] = [...scenario.entries];
  const seen: Seen[] = [];
  let handler: ((request: Seen, index: number) => Response | undefined) | null = null;

  const newestFirst = (list: readonly Entry[]): Entry[] =>
    [...list].sort(
      (a, b) =>
        Number(b.bt.created) - Number(a.bt.created) ||
        (String(b.bt.id) < String(a.bt.id) ? -1 : String(b.bt.id) > String(a.bt.id) ? 1 : 0),
    );

  const range = (query: Record<string, string[]>, field: string, value: number): boolean => {
    const get = (suffix: string): number | null => {
      const raw = query[`${field}[${suffix}]`]?.[0];
      return raw === undefined ? null : Number(raw);
    };
    const exact = query[field]?.[0];
    if (exact !== undefined && value !== Number(exact)) return false;
    const gt = get("gt");
    const gte = get("gte");
    const lt = get("lt");
    const lte = get("lte");
    return (
      (gt === null || value > gt) &&
      (gte === null || value >= gte) &&
      (lt === null || value < lt) &&
      (lte === null || value <= lte)
    );
  };

  const page = (
    path: string,
    all: readonly Json[],
    query: Record<string, string[]>,
    idOf: (item: Json) => string,
  ): Response => {
    const requested = Number(query.limit?.[0] ?? 10);
    if (!Number.isInteger(requested) || requested < 1 || requested > 100)
      return error(400, "Invalid limit: must be an integer between 1 and 100.");
    const limit = Math.min(requested, options.maxLimit ?? 100);
    let start = 0;
    const after = query.starting_after?.[0];
    if (after !== undefined) {
      const at = all.findIndex((item) => idOf(item) === after);
      if (at < 0) return error(400, `No such object: '${after}'`);
      start = at + 1;
    }
    const data = all.slice(start, start + limit);
    return Response.json({
      object: "list",
      data,
      has_more: start + limit < all.length,
      url: path,
    });
  };

  const respond = (path: string, query: Record<string, string[]>): Response => {
    const expandSource = (query["expand[]"] ?? []).includes("data.source");
    if (path === "/v1/balance_transactions") {
      let list = newestFirst(entries);
      const payout = query.payout?.[0];
      if (payout !== undefined) {
        const members = new Set(membersOf(scenario, payout).map((bt) => String(bt.id)));
        list = list.filter((e) => members.has(String(e.bt.id)));
      }
      list = list.filter((e) => range(query, "created", Number(e.bt.created)));
      const type = query.type?.[0];
      if (type !== undefined) list = list.filter((e) => e.bt.type === type);
      const shaped = list.map((e) =>
        expandSource && e.source ? { ...e.bt, source: e.source } : e.bt,
      );
      return page(path, shaped, query, (item) => String(item.id));
    }
    if (path === "/v1/balance") {
      const now = options.now?.() ?? scenario.now;
      const sum = (pending: boolean): number =>
        entries
          .filter((e) => e.bt.currency === "usd")
          .filter((e) => Number(e.bt.available_on) > now === pending)
          .reduce((total, e) => total + Number(e.bt.net), 0);
      return Response.json({
        object: "balance",
        available: [{ amount: sum(false), currency: "usd", source_types: { card: sum(false) } }],
        livemode: true,
        pending: [{ amount: sum(true), currency: "usd", source_types: { card: sum(true) } }],
      });
    }
    if (path === "/v1/account") return Response.json(scenario.account);
    if (path.startsWith("/v1/payouts/")) {
      const found = scenario.payouts.find((po) => `/v1/payouts/${po.id}` === path);
      return found ? Response.json(found) : error(404, "No such payout.");
    }
    if (path === "/v1/payouts") {
      const list = scenario.payouts
        .filter((po) => range(query, "created", Number(po.created)))
        .sort(
          (a, b) => Number(b.created) - Number(a.created) || (String(b.id) < String(a.id) ? 1 : -1),
        );
      return page(path, list, query, (item) => String(item.id));
    }
    if (path === "/v1/checkout/sessions") {
      const pi = query.payment_intent?.[0];
      const list = scenario.sessions
        .filter((s) => pi === undefined || s.payment_intent === pi)
        .filter((s) => range(query, "created", Number(s.created)))
        .sort(
          (a, b) => Number(b.created) - Number(a.created) || (String(b.id) < String(a.id) ? 1 : -1),
        );
      return page(path, list, query, (item) => String(item.id));
    }
    if (path === "/v1/invoice_payments") {
      const pi = query["payment[payment_intent]"]?.[0];
      const list = scenario.invoicePayments
        .filter((p) => pi === undefined || (p.payment as Json).payment_intent === pi)
        .filter((p) => range(query, "created", Number(p.created)))
        .sort(
          (a, b) => Number(b.created) - Number(a.created) || (String(b.id) < String(a.id) ? 1 : -1),
        );
      const expandInvoice = (query["expand[]"] ?? []).includes("data.invoice");
      return page(
        path,
        list.map((p) => (expandInvoice ? p : { ...p, invoice: (p.invoice as Json).id })),
        query,
        (item) => String(item.id),
      );
    }
    return error(404, `Unrecognized request URL (GET: ${path}).`);
  };

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const query: Record<string, string[]> = {};
    for (const [name, value] of url.searchParams) {
      const existing = query[name];
      if (existing) existing.push(value);
      else query[name] = [value];
    }
    const entry: Seen = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query,
      keyInUrl: url.href.includes(options.key),
      authorised: headers.get("authorization") === `Bearer ${options.key}`,
      stripeVersion: headers.get("stripe-version"),
    };
    seen.push(entry);
    const forced = handler?.(entry, seen.length - 1);
    if (forced) return forced;
    if (entry.method !== "GET") return error(405, "Only GET is supported by this fake.");
    if (!entry.authorised)
      return error(401, "Invalid API Key provided: rk_live_********", "invalid_request_error");
    return respond(url.pathname, query);
  };

  return {
    fetch: fetcher as typeof fetch,
    seen,
    intercept(next) {
      handler = next;
    },
    push(entryToAdd) {
      entries.push(entryToAdd);
    },
  };
}

import type { Connector, IngestBatch, IngestLine } from "../ingest-types.ts";
import { minorToCents } from "./amounts.ts";
import {
  type FetchFn,
  type Query,
  type RequestBudget,
  ResponseMissing,
  StripeClient,
  StripeError,
} from "./client.ts";
import { startOfLocalDay } from "./dates.ts";
import {
  type Decoded,
  decodeBalanceTransactionPage,
  decodeCheckoutSessionPage,
  decodeInvoicePaymentPage,
  decodePayout,
  decodePayoutPage,
} from "./decode.ts";
import { needsTaxFigure, paymentIntentOf } from "./normalise.ts";
import { type PayoutMember, summarisePayout } from "./payout-summary.ts";
import { redact } from "./redact.ts";
import {
  type TaxResolution,
  notReported,
  taxFromCheckoutSessions,
  taxFromInvoicePayments,
} from "./tax.ts";
import type { BalanceTransaction, CheckoutSession, InvoicePayment, Page, Payout } from "./types.ts";

/** The Stripe connector. Two passes, one batch per page of Stripe's answer, every page handed over
 * with its exact bytes to be archived:
 *
 *  1. The window pass reads balance transactions by `created` window and `starting_after` cursor
 *     (with a safety overlap) to learn what exists: every transaction is recorded, and the payouts
 *     among them are found. It queues no lines: a transaction that is not yet in a payout is
 *     pending, kept in the lane's own records and counted as "in Stripe, not yet paid out".
 *  2. The payout pass takes each payout that is not yet booked, waits until Stripe has finished
 *     itemising it, reads the transactions it paid out, checks they add up to the payout to the
 *     cent, and hands over the payout's entry together with its transactions as covered evidence.
 *     What it needs besides the transactions is read in bulk, a month of it in a request of up to
 *     a hundred: the payouts themselves, and the Checkout Sessions and invoice payments that carry a
 *     charge's tax. One request for each payment (the way this began) was three quarters of what a
 *     year of a small shop cost Stripe, and a refund or a dispute, which belongs to a payment of any
 *     age, is still asked for by itself.
 *
 * Properties the tests hold it to:
 *  - Fetching is read-only and goes through the injected `fetch`; the key is a constructor argument
 *    held in the client and never appears in a batch, a cursor, an error or a record.
 *  - The window cursor in a batch is only meaningful after that batch is applied. A run that stops
 *    (budget, failure) resumes from the last applied cursor, and a payout whose entry was not
 *    applied is simply done again: the pipeline refuses duplicates by Stripe's own identifiers.
 *  - Nothing is invented: uncaptured authorisations and failed payments have no balance transaction
 *    and produce nothing; a payout that does not add up is reported, never forced.
 *  - Settlement in another currency, and manual payouts, are held for a person, never converted. */

export interface ConnectorSettings {
  /** "acct_1ABC", from Stripe's account endpoint. */
  readonly accountId: string;
  readonly bookCurrency: string;
  readonly timeZone: string;
  /** The first day to import, YYYY-MM-DD, cut at midnight in `timeZone`. */
  readonly syncFrom: string;
  readonly salesTax: "stripe" | "none";
  /** Re-read this much before the last applied cursor, to catch late arrivals. */
  readonly overlapSeconds: number;
  /** How much time one window covers; windows are read oldest first. */
  readonly windowSeconds: number;
  /** Balance transactions per request, 1 to 100. */
  readonly pageSize: number;
  /** The chart account of the Stripe balance, recorded on the source by the first batch. */
  readonly balanceAccountId: string | null;
}

export interface TaxStore {
  get(paymentIntent: string): TaxResolution | undefined;
  set(paymentIntent: string, resolution: TaxResolution): void;
}

export interface ConnectorDeps {
  readonly key: string;
  /** True for a balance transaction id that has already been recorded. */
  readonly known: (transactionId: string) => boolean;
  /** The payouts still to be booked: asked for when the window pass is complete, so it sees
   * everything that pass recorded. */
  readonly pendingPayouts: () => readonly string[];
  /** The day (YYYY-MM-DD, in the book's zone) each pending payout was created on, where it is known: with it a payout is found in the month's list of them and not asked for by itself. */
  readonly pendingPayoutDays?: () => ReadonlyMap<string, string>;
  readonly tax: TaxStore;
  readonly budget?: RequestBudget;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly baseUrl?: string;
  /** How many tax lookups may run at once. */
  readonly concurrency?: number;
  /** Read what a payout needs besides its transactions in bulk, a month of it in a list of up to a hundred (see the doc above), and not one request for each payment and each payout. For answers
   * that are delivered whole (`stripe.receive`), which cost no round trip and are not read within a call's time: a sync that fetches for itself in calls of a few seconds could never finish
   * a month's list of a busy shop in one, and asks for each payment by itself as it always has. */
  readonly bulk?: boolean;
  /** For answers that were fetched by somebody else (`stripe.receive`): when a payout needs an
   * answer that was not delivered, leave that payout for the next call and go on to the next one,
   * so that one call finds out everything the payouts need. The `fetch` records what it was asked
   * for. Without it a missing answer ends the run, which is what a failed request does. */
  readonly collectMisses?: boolean;
  /** The clock the time budget is measured by, in epoch milliseconds, when it is not the instant the pull reads up to (which a delivery fixes for its whole length, and may put ahead of the service's own clock). */
  readonly clock?: () => number;
  /** Asked of every payout as soon as it is decoded, before anything of it is handed on: it throws to stop the run (a payout labelled with the other mode, say). */
  readonly checkPayout?: (payout: Payout) => void;
}

export interface StripeCursor {
  readonly v: 1;
  /** Everything created before this instant (Unix seconds) has been recorded. */
  readonly through: number;
  /** Set while a window is part-way through: continue it after this balance transaction. */
  readonly window?: { readonly from: number; readonly to: number; readonly after: string };
}

export function encodeCursor(cursor: StripeCursor): string {
  return JSON.stringify(
    cursor.window
      ? { v: 1, through: cursor.through, window: cursor.window }
      : { v: 1, through: cursor.through },
  );
}

/** A cursor this connector wrote, or null. An unreadable cursor is treated as none: the sync starts
 * over from `syncFrom`, which is safe because everything already recorded is known. */
export function decodeCursor(text: string | null | undefined): StripeCursor | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const whole = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
    if (value.v !== 1 || !whole(value.through)) return null;
    const window = value.window as Record<string, unknown> | undefined;
    if (window === undefined) return { v: 1, through: value.through };
    if (
      whole(window.from) &&
      whole(window.to) &&
      typeof window.after === "string" &&
      /^[A-Za-z0-9_]{3,200}$/.test(window.after)
    )
      return {
        v: 1,
        through: value.through,
        window: { from: window.from, to: window.to, after: window.after },
      };
    return null;
  } catch {
    return null;
  }
}

/** A balance transaction the window pass recorded. */
export interface TransactionRecord {
  readonly id: string;
  readonly created: number;
  readonly currency: string;
  readonly category: string;
  /** Hundredths; null when it cannot be written exactly, or sits on another Stripe balance. */
  readonly netCents: bigint | null;
  /** For a payout's own debit of the balance: the payout it belongs to. */
  readonly payout: string | null;
}

export type PayoutState =
  /** Not booked yet: Stripe has not finished itemising it, or it is not read yet. */
  "waiting" | "summarised" | "mismatch" | "invalid" | "empty" | "held";

export interface PayoutRecord {
  readonly payoutId: string;
  readonly state: PayoutState;
  /** In words, for a person; null when it is booked or only waiting. */
  readonly reason: string | null;
  /** Why a held payout was held: `other_currency` or `manual`. */
  readonly heldKind: string | null;
  readonly memberCount: number | null;
  readonly memberNetCents: bigint | null;
  readonly membersSha256: string | null;
  readonly counts: {
    readonly taxNotReported: number;
    readonly refundTaxNotSplit: number;
    readonly adjustments: number;
  };
}

/** What a batch carries beside the contract's fields, for the runner to record with it. */
export interface PulledRecords {
  readonly transactions: readonly TransactionRecord[];
  readonly payouts: readonly Payout[];
  /** Balance transactions now covered by a payout's entry. */
  readonly covered: readonly {
    readonly id: string;
    readonly created: number;
    readonly currency: string;
    readonly netCents: bigint | null;
  }[];
  readonly outcome: PayoutRecord | null;
  readonly warnings: readonly string[];
  /** How many transactions this page held, for the run's counts. */
  readonly pageTransactions: number;
}

export type PulledBatch = {
  readonly batch: Omit<IngestBatch, "raw">;
  readonly raw: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly name?: string;
  };
  readonly records: PulledRecords;
};

export const DAY = 86_400;
export const DEFAULT_WINDOW_SECONDS = 31 * DAY;
export const DEFAULT_OVERLAP_SECONDS = 3 * DAY;
/** How long before a charge its Checkout Session can have been made, and its subscription's invoice payment: a session lives a day, but a payment method that settles later (a bank debit) finishes
 * a week or two after it is made, and an invoice whose payment is tried again is paid up to three weeks after it was first tried (the first attempt is what the invoice payment is made at). */
const SESSION_LOOKBACK = 14 * DAY;
const INVOICE_LOOKBACK = 45 * DAY;
/** A list that goes on for more pages than this is a fault. */
const MAX_LIST_PAGES = 1000;

/** A list's items by the payment intent each belongs to, the ones that belong to none left out. */
function byPaymentIntent<T>(
  items: readonly T[],
  intentOf: (item: T) => string | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const intent = intentOf(item);
    if (intent === null) continue;
    const known = out.get(intent);
    if (known) known.push(item);
    else out.set(intent, [item]);
  }
  return out;
}

const NO_COUNTS = { taxNotReported: 0, refundTaxNotSplit: 0, adjustments: 0 } as const;
const emptyRecords = (over: Partial<PulledRecords> = {}): PulledRecords => ({
  transactions: [],
  payouts: [],
  covered: [],
  outcome: null,
  warnings: [],
  pageTransactions: 0,
  ...over,
});

/** Run `work` over `items` at most `limit` at a time, keeping the results in order. */
async function inChunks<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit)
    out.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  return out;
}

/** The Stripe connector: the contract's `Connector`, with each batch also carrying the records the
 * runner keeps. A `PulledBatch` is a contract batch with one more field, so this is a `Connector`. */
export interface StripeConnector {
  readonly provider: "stripe";
  pull(
    cursor: string | null,
    options: { readonly fetch: FetchFn; readonly now: () => string },
  ): AsyncIterable<PulledBatch>;
}

/** Compile-time proof that the Stripe connector satisfies the ingestion contract. */
export const asConnector = (connector: StripeConnector): Connector => connector;

export function createStripeConnector(
  settings: ConnectorSettings,
  deps: ConnectorDeps,
): StripeConnector {
  const sourceKey = `stripe:${settings.accountId}`;
  const concurrency = Math.max(1, Math.min(deps.collectMisses ? 1000 : 8, deps.concurrency ?? 4));
  return {
    provider: "stripe",
    async *pull(cursorText, { fetch, now }) {
      const clock = (): number => Date.parse(now());
      const client = new StripeClient({
        key: deps.key,
        fetch,
        now: deps.clock ?? clock,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.random ? { random: deps.random } : {}),
        ...(deps.budget ? { budget: deps.budget } : {}),
        ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      });
      const base = {
        provider: "stripe",
        sourceKey,
        balances: [],
        startOn: settings.syncFrom,
        ...(settings.balanceAccountId ? { ledgerAccountId: settings.balanceAccountId } : {}),
      } as const;
      const batchOf = (
        lines: readonly IngestLine[],
        cursor?: string,
      ): Omit<IngestBatch, "raw"> => ({
        ...base,
        fetchedAt: now(),
        lines,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const scrub = (text: string): string => redact(text, [deps.key]);

      // ---- 1. The window pass: learn what exists ------------------------------------------
      const start = startOfLocalDay(settings.syncFrom, settings.timeZone);
      const end = Math.floor(clock() / 1000);
      const cursor = decodeCursor(cursorText);
      let from =
        cursor?.window?.from ??
        (cursor ? Math.max(start, cursor.through - settings.overlapSeconds) : start);
      let resumeAfter: string | null = cursor?.window?.after ?? null;
      let windowTo: number | null = cursor?.window?.to ?? null;
      const through = cursor?.through ?? start;
      let sequence = 0;

      while (from < end) {
        const to = windowTo ?? Math.min(from + settings.windowSeconds, end);
        let after = resumeAfter;
        resumeAfter = null;
        windowTo = null;
        for (;;) {
          const fetched = await client.get("/v1/balance_transactions", [
            ["limit", settings.pageSize],
            ["created[gte]", from],
            ["created[lt]", to],
            ...(after ? ([["starting_after", after]] as const) : []),
          ]);
          const decoded = decodeBalanceTransactionPage(fetched.json);
          if (!decoded.ok)
            throw new StripeError(
              "stripe_bad_response",
              `Stripe sent a balance transaction this version cannot read: ${scrub(decoded.problems[0] ?? "")}`,
              false,
            );
          const { items, hasMore } = decoded.value;
          if (hasMore && items.length === 0)
            throw new StripeError("stripe_bad_response", "Stripe's list never ended.", false);

          const fresh = items.filter((t) => !deps.known(t.id));
          const records = fresh.map(
            (t): TransactionRecord => ({
              id: t.id,
              created: t.created,
              currency: t.currency,
              category: t.reportingCategory,
              netCents:
                t.balanceType !== null && t.balanceType !== "payments"
                  ? null
                  : minorToCents(t.net, t.currency),
              payout: t.type === "payout" && t.source ? t.source.id : null,
            }),
          );
          const last = items.at(-1);
          const nextCursor: StripeCursor =
            hasMore && last
              ? { v: 1, through, window: { from, to, after: last.id } }
              : { v: 1, through: to };
          yield {
            batch: batchOf([], encodeCursor(nextCursor)),
            raw: {
              bytes: fetched.bytes,
              mediaType: "application/json",
              name: `stripe-balance-transactions-${from}-${to}-${++sequence}.json`,
            },
            records: emptyRecords({ transactions: records, pageTransactions: items.length }),
          };
          if (!hasMore || !last) break;
          after = last.id;
        }
        from = to;
      }

      // ---- 2. The payout pass: one entry per payout ---------------------------------------

      // Bulk reads. A list is read a month at a time, every page of it, and shared by everything of that month in this run: a request of up to a hundred where there was one for each
      // payment and each payout. What is in a month's list is what Stripe has now, as what was asked for by itself would have been.
      const lists = new Map<string, Promise<unknown>>();
      const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
        const known = lists.get(key);
        if (known) return known as Promise<T>;
        const started = load();
        lists.set(key, started);
        // One that could not be read now (an answer not delivered yet, a fault) is asked for again.
        started.catch(() => lists.delete(key));
        return started;
      };
      const monthOf = (seconds: number): { readonly from: number; readonly to: number } => {
        const at = new Date(seconds * 1000);
        return {
          from: Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) / 1000,
          to: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) / 1000,
        };
      };
      /** The calendar months (UTC) from the one that holds `from` to the one that holds `to`. */
      const monthsFrom = (
        from: number,
        to: number,
      ): { readonly from: number; readonly to: number }[] => {
        const months: { readonly from: number; readonly to: number }[] = [];
        let month = monthOf(Math.min(from, to));
        for (;;) {
          months.push(month);
          if (month.to > to) return months;
          month = monthOf(month.to);
        }
      };
      interface Listed<T> {
        readonly items: readonly T[];
        /** Each page's exact bytes, with the items it held. */
        readonly pages: readonly { readonly bytes: Uint8Array; readonly items: readonly T[] }[];
      }
      /** Every page of one list, the way Stripe pages it. */
      const readList = async <T extends { readonly id: string }>(
        path: string,
        query: Query,
        decode: (json: unknown) => Decoded<Page<T>>,
        what: string,
      ): Promise<Listed<T>> => {
        const items: T[] = [];
        const pages: { bytes: Uint8Array; items: readonly T[] }[] = [];
        let after: string | null = null;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const fetched = await client.get(path, [
            ...query,
            ...(after ? ([["starting_after", after]] as const) : []),
          ]);
          const decoded = decode(fetched.json);
          if (!decoded.ok)
            throw new StripeError(
              "stripe_bad_response",
              `Stripe sent a ${what} this version cannot read: ${scrub(decoded.problems[0] ?? "")}`,
              false,
            );
          pages.push({ bytes: fetched.bytes, items: decoded.value.items });
          items.push(...decoded.value.items);
          const last = decoded.value.items.at(-1);
          if (!decoded.value.hasMore || !last) return { items, pages };
          after = last.id;
        }
        throw new StripeError(
          "stripe_bad_response",
          `Stripe's list of ${what}s never ended.`,
          false,
        );
      };

      const sessionsOfMonth = (month: { readonly from: number; readonly to: number }) =>
        once(`sessions:${month.from}`, async () => {
          const listed = await readList(
            "/v1/checkout/sessions",
            [
              ["limit", 100],
              ["created[gte]", month.from],
              ["created[lt]", month.to],
            ],
            decodeCheckoutSessionPage,
            "Checkout Session",
          );
          return byPaymentIntent<CheckoutSession>(listed.items, (s) => s.paymentIntent);
        });
      const invoicePaymentsOfMonth = (month: { readonly from: number; readonly to: number }) =>
        once(`invoice_payments:${month.from}`, async () => {
          const listed = await readList(
            "/v1/invoice_payments",
            [
              ["limit", 100],
              ["created[gte]", month.from],
              ["created[lt]", month.to],
              ["expand[]", "data.invoice"],
            ],
            decodeInvoicePaymentPage,
            "invoice payment",
          );
          return byPaymentIntent<InvoicePayment>(listed.items, (p) => p.paymentIntent);
        });

      /** What the book was told when each pending payout was created, read once. */
      let pendingDays: ReadonlyMap<string, string> | null = null;
      const payoutDays = (): ReadonlyMap<string, string> =>
        (pendingDays ??= deps.pendingPayoutDays?.() ?? new Map());
      const payoutsOfMonth = (month: { readonly from: number; readonly to: number }) =>
        once(`payouts:${month.from}`, async () => {
          const listed = await readList(
            "/v1/payouts",
            [
              ["limit", 100],
              ["created[gte]", month.from],
              ["created[lt]", month.to],
            ],
            decodePayoutPage,
            "payout",
          );
          const found = new Map<string, { payout: Payout; bytes: Uint8Array; name: string }>();
          listed.pages.forEach((page, index) => {
            for (const payout of page.items)
              found.set(payout.id, {
                payout,
                bytes: page.bytes,
                name: `stripe-payouts-${month.from}-${month.to}-${index + 1}.json`,
              });
          });
          return found;
        });
      /** A payout, from the month's list of payouts where its day is known, else by itself. */
      const payoutOf = async (
        payoutId: string,
      ): Promise<{
        readonly payout: Payout;
        readonly bytes: Uint8Array;
        readonly name: string;
      }> => {
        const day = deps.bulk ? payoutDays().get(payoutId) : undefined;
        if (day !== undefined) {
          // The day is the book's, the month is UTC's: a day either side is looked at too.
          const at = startOfLocalDay(day, settings.timeZone);
          for (const month of monthsFrom(at - DAY, at + 2 * DAY)) {
            const found = (await payoutsOfMonth(month)).get(payoutId);
            if (found) return found;
          }
        }
        const single = await client.get(`/v1/payouts/${encodeURIComponent(payoutId)}`);
        const decoded = decodePayout(single.json);
        if (!decoded.ok)
          throw new StripeError(
            "stripe_bad_response",
            `Stripe sent a payout this version cannot read: ${scrub(decoded.problems[0] ?? "")}`,
            false,
          );
        return {
          payout: decoded.value,
          bytes: single.bytes,
          name: `stripe-payout-${decoded.value.id}.json`,
        };
      };

      /** One payment's tax by asking for it: the Checkout Sessions of the payment intent, then its invoice payments. For a refund or a dispute, whose payment may be of any age. */
      const taxOfPayment = async (paymentIntent: string): Promise<TaxResolution> => {
        const sessions = decodeCheckoutSessionPage(
          (
            await client.get("/v1/checkout/sessions", [
              ["payment_intent", paymentIntent],
              ["limit", 10],
            ])
          ).json,
        );
        if (!sessions.ok)
          throw new StripeError(
            "stripe_bad_response",
            `Stripe sent a Checkout Session this version cannot read: ${scrub(sessions.problems[0] ?? "")}`,
            false,
          );
        let found = taxFromCheckoutSessions(sessions.value.items, paymentIntent);
        if (!found) {
          const invoices = decodeInvoicePaymentPage(
            (
              await client.get("/v1/invoice_payments", [
                ["payment[type]", "payment_intent"],
                ["payment[payment_intent]", paymentIntent],
                ["expand[]", "data.invoice"],
                ["limit", 10],
              ])
            ).json,
          );
          if (!invoices.ok)
            throw new StripeError(
              "stripe_bad_response",
              `Stripe sent an invoice payment this version cannot read: ${scrub(invoices.problems[0] ?? "")}`,
              false,
            );
          found = taxFromInvoicePayments(invoices.value.items, paymentIntent);
        }
        return found ?? notReported("no_checkout_session_or_invoice");
      };

      /** A charge's tax from the lists of the months it can have been made in: the Checkout Session a payment is made through is made up to a day (some payment methods, a week or two) before it,
       * and the invoice of a subscription's payment that was tried again is made up to a month and a half before. A session or an invoice made earlier than that is not found, and the payment
       * is counted as one whose tax Stripe does not report, as it is when it was not made through Checkout or an invoice at all. */
      const taxFromLists = async (
        transaction: BalanceTransaction,
        paymentIntent: string,
      ): Promise<TaxResolution> => {
        const at = transaction.created;
        const sessions = (
          await Promise.all(monthsFrom(at - SESSION_LOOKBACK, at + DAY).map(sessionsOfMonth))
        ).flatMap((month) => month.get(paymentIntent) ?? []);
        let found = taxFromCheckoutSessions(sessions, paymentIntent);
        if (!found) {
          const payments = (
            await Promise.all(
              monthsFrom(at - INVOICE_LOOKBACK, at + DAY).map(invoicePaymentsOfMonth),
            )
          ).flatMap((month) => month.get(paymentIntent) ?? []);
          found = taxFromInvoicePayments(payments, paymentIntent);
        }
        return found ?? notReported("no_checkout_session_or_invoice");
      };

      const taxOf = async (transaction: BalanceTransaction): Promise<TaxResolution> => {
        if (settings.salesTax === "none") return { state: "none" };
        const paymentIntent = paymentIntentOf(transaction);
        if (!paymentIntent) return notReported("no_payment_intent");
        const cached = deps.tax.get(paymentIntent);
        if (cached) return cached;
        const resolved =
          deps.bulk && transaction.source?.object === "charge"
            ? await taxFromLists(transaction, paymentIntent)
            : await taxOfPayment(paymentIntent);
        deps.tax.set(paymentIntent, resolved);
        return resolved;
      };

      async function* payoutBatches(payoutId: string): AsyncGenerator<PulledBatch> {
        const found = await payoutOf(payoutId);
        const payout = found.payout;
        deps.checkPayout?.(payout);
        const payoutRaw = { bytes: found.bytes, mediaType: "application/json", name: found.name };
        const waiting = payout.automatic && payout.reconciliationStatus === "in_progress";
        if (waiting) {
          // Stripe is still itemising it: try again on the next sync.
          yield {
            batch: batchOf([]),
            raw: payoutRaw,
            records: emptyRecords({
              payouts: [payout],
              outcome: {
                payoutId: payout.id,
                state: "waiting",
                reason: null,
                heldKind: null,
                memberCount: null,
                memberNetCents: null,
                membersSha256: null,
                counts: NO_COUNTS,
              },
            }),
          };
          return;
        }

        // The transactions Stripe says it paid out, every page, with the exact bytes of each.
        const itemised = payout.automatic && payout.reconciliationStatus === "completed";
        const pages: { bytes: Uint8Array; members: PayoutMember[] }[] = [];
        if (itemised && payout.currency === settings.bookCurrency.toUpperCase()) {
          let pageAfter: string | null = null;
          for (let page = 0; page < 200; page++) {
            const fetched = await client.get("/v1/balance_transactions", [
              ["payout", payout.id],
              ["limit", 100],
              ...(settings.salesTax === "stripe" ? ([["expand[]", "data.source"]] as const) : []),
              ...(pageAfter ? ([["starting_after", pageAfter]] as const) : []),
            ]);
            const decoded = decodeBalanceTransactionPage(fetched.json);
            if (!decoded.ok)
              throw new StripeError(
                "stripe_bad_response",
                `Stripe sent a transaction of payout ${payout.id} this version cannot read: ${scrub(decoded.problems[0] ?? "")}`,
                false,
              );
            pages.push({
              bytes: fetched.bytes,
              members: decoded.value.items.map((transaction, rawIndex) => ({
                transaction,
                page,
                rawIndex,
              })),
            });
            const last = decoded.value.items.at(-1);
            if (!decoded.value.hasMore || !last) break;
            pageAfter = last.id;
          }
        }
        const members = pages.flatMap((p) => p.members);
        const resolved = new Map<string, TaxResolution>();
        let missed = false;
        await inChunks(
          members.filter((m) => settings.salesTax === "stripe" && needsTaxFigure(m.transaction)),
          concurrency,
          async (m) => {
            try {
              resolved.set(m.transaction.id, await taxOf(m.transaction));
            } catch (error) {
              // Every lookup is tried, so that all the ones this payout needs are asked for together.
              if (error instanceof ResponseMissing && deps.collectMisses) missed = true;
              else throw error;
            }
          },
        );
        if (missed) return;

        const outcome = summarisePayout(payout, members, {
          accountKeyBase: sourceKey,
          bookCurrency: settings.bookCurrency,
          taxFor: (t) => resolved.get(t.id) ?? { state: "none" },
        });
        const record = (
          state: PayoutState,
          reason: string | null,
          extra: Partial<PayoutRecord> = {},
        ): PayoutRecord => ({
          payoutId: payout.id,
          state,
          reason: reason === null ? null : scrub(reason),
          heldKind: null,
          memberCount: null,
          memberNetCents: null,
          membersSha256: null,
          counts: NO_COUNTS,
          ...extra,
        });

        if (outcome.kind === "summary") {
          // The transactions first, as evidence covered by a payout whose entry follows: if the run
          // stops in between, the payout is simply done again and the pipeline refuses duplicates.
          for (const [index, page] of pages.entries()) {
            const events = outcome.members.filter((m) => m.page === index).map((m) => m.event);
            yield {
              batch: batchOf(events),
              raw: {
                bytes: page.bytes,
                mediaType: "application/json",
                name: `stripe-payout-${payout.id}-transactions-${index + 1}.json`,
              },
              records: emptyRecords({
                covered: page.members.map((m) => ({
                  id: m.transaction.id,
                  created: m.transaction.created,
                  currency: m.transaction.currency,
                  netCents: minorToCents(m.transaction.net, m.transaction.currency),
                })),
                warnings: index === 0 ? outcome.diagnostics.map((d) => scrub(d.message)) : [],
              }),
            };
          }
          yield {
            batch: batchOf([outcome.payout]),
            raw: payoutRaw,
            records: emptyRecords({
              payouts: [payout],
              covered: payout.balanceTransaction
                ? [
                    {
                      id: payout.balanceTransaction,
                      created: payout.created,
                      currency: payout.currency,
                      netCents: null,
                    },
                  ]
                : [],
              outcome: record("summarised", null, {
                memberCount: outcome.counts.members,
                memberNetCents: minorToCents(payout.amount, payout.currency),
                membersSha256: outcome.membersSha256,
                counts: {
                  taxNotReported: outcome.counts.taxNotReported,
                  refundTaxNotSplit: outcome.counts.refundTaxNotSplit,
                  adjustments: outcome.counts.adjustments,
                },
              }),
            }),
          };
        } else if (outcome.kind === "held") {
          yield {
            batch: batchOf([outcome.line]),
            raw: payoutRaw,
            records: emptyRecords({
              payouts: [payout],
              warnings: [scrub(outcome.message)],
              outcome: record("held", outcome.message, { heldKind: outcome.reason }),
            }),
          };
        } else {
          yield {
            batch: batchOf([]),
            raw: payoutRaw,
            records: emptyRecords({
              payouts: [payout],
              warnings: [scrub(outcome.message)],
              outcome:
                outcome.kind === "mismatch"
                  ? record("mismatch", outcome.message, {
                      memberCount: outcome.memberCount,
                      memberNetCents: outcome.memberNetCents,
                    })
                  : record(outcome.kind, outcome.message),
            }),
          };
        }
      }
      for (const payoutId of deps.pendingPayouts()) {
        try {
          yield* payoutBatches(payoutId);
        } catch (error) {
          if (error instanceof ResponseMissing && deps.collectMisses) continue;
          throw error;
        }
      }
    },
  };
}

import { ApplicationError } from "../../errors.ts";
import type { IngestPort } from "../../ingest-types.ts";
import { formatMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import { minorToCents } from "../../stripe/amounts.ts";
import {
  BudgetExhausted,
  type FetchFn,
  type RequestBudget,
  ResponseMissing,
  StripeClient,
  StripeError,
} from "../../stripe/client.ts";
import {
  DAY,
  type PulledBatch,
  createStripeConnector,
  decodeCursor,
} from "../../stripe/connector.ts";
import { isKeyProblem, keyMode } from "../../stripe/credentials.ts";
import { isTimeZone, localDate, utcDate } from "../../stripe/dates.ts";
import { decodeAccount, decodeBalance } from "../../stripe/decode.ts";
import { redact } from "../../stripe/redact.ts";
import type { Payout } from "../../stripe/types.ts";
import { ingestPort } from "../ingest/port.ts";
import { sliceState } from "../state.ts";
import { readChart } from "./chart.ts";
import { settingsInUse } from "./defaults.ts";
import { ModeGuard } from "./mode.ts";
import { type StripeRuntime, stripeRuntime, todayOf } from "./runtime.ts";
import {
  type StripeSettings,
  accountOf,
  isReady,
  resolveRoles,
  serialiseSettings,
  unresolvedRoles,
} from "./settings.ts";
import { type RunRow, type StripeStore, stripeStore } from "./store.ts";

/** Running a sync: read the key, check which Stripe account it belongs to, read the balance
 * transactions Stripe has (recording each, and finding the payouts among them), then for every
 * payout that Stripe has finished itemising read what it paid out and hand the pipeline one entry
 * for the payout with its transactions as covered evidence. Every page goes to the archive first
 * and to the pipeline second, and only after the pipeline has applied it does the lane remember what
 * it contained. A sync stopped by its time budget, by Stripe, or by a crash continues from the last
 * applied page next time, and nothing is ever applied twice.
 *
 * It never posts anything: a payout becomes one Inbox item; a person (or an agent with the grant)
 * posts it. Transactions not yet in a payout stay pending in the lane's own records. */

export interface SyncInput {
  readonly budgetSeconds?: number;
}

/** What a run reads, when the answers were fetched by somebody else and delivered (`stripe.receive`)
 * instead of fetched with a key the service holds. The run is the same run: it asks for the same
 * requests in the same order and does what it does with the answers. Where an answer was not
 * delivered, the run leaves that part for the next call, and `misses` says what it asked for. */
export interface Delivered {
  /** Serves the delivered answers, and throws `ResponseMissing` for a request that has none. */
  readonly fetch: FetchFn;
  /** The instant the pull reads up to: fixed for the whole pull, so that the requests it makes in
   * one call are the requests it makes in the next. */
  readonly asOf: string;
  /** The requests that were asked for and had no answer, as they were asked, in order. */
  readonly misses: () => readonly string[];
  /** Whether the sender says these answers are Stripe's live mode (true) or test mode (false); absent when it did not say. */
  readonly livemode?: boolean;
}

/** What a run signs its requests with when the answers were delivered: no request leaves the
 * service, so nothing is signed, and this is only here so that the client has a key to hold. */
const DELIVERED_KEY = "answers-delivered-by-the-sender";

export interface SyncOutcome {
  readonly run: RunRow;
  readonly more: boolean;
  readonly balance: BalanceSnapshot | null;
}

export interface BalanceSnapshot {
  readonly readAt: string;
  readonly currency: string;
  readonly available: string;
  readonly pending: string;
  readonly total: string;
  readonly otherCurrencies: readonly { readonly currency: string; readonly total: string }[];
}

/** Each call works within a few seconds so no client's reply timeout (the CLI waits 15 s, the
 * browser 10 s) is ever the limit; a long first sync is simply several calls. */
export const DEFAULT_BUDGET_SECONDS = 6;
const MAX_REQUESTS_PER_CALL = 400;
const MAX_DELIVERED_REQUESTS_PER_CALL = 100_000;
/** What one call that is given its answers (`stripe.receive`) may change in the book before it stops and asks to be called again, roughly, in bytes: the raw pages it keeps and the lines it
 * queues. A call is one entry of the log, and a Durable Object tail holds an entry to a megabyte as stored; what these changes come to once packed is about a tenth of this (measured on a year of
 * a small shop's payouts), so there is room for a payout of thousands of transactions. The call stops between units, a page of a window or a payout whose entry is booked, never inside a payout,
 * so that what is booked is whole and the next call carries on from the cursor. */
export const DELIVERED_WORK_PER_CALL = 1024 * 1024;
/** What a line queued in the Inbox counts for in that, besides the page it came from: the item, and what the log keeps of it. */
const LINE_WORK = 2_000;

const failure = (error: StripeError): ApplicationError =>
  new ApplicationError(
    error.code,
    error.message,
    error.code === "stripe_rate_limited" ? 429 : error.code === "stripe_unavailable" ? 502 : 424,
    [],
    error.retryable,
  );

async function requireReady(
  service: ApplicationService,
  store: StripeStore,
  runtime: StripeRuntime,
  delivered: boolean,
): Promise<{
  settings: StripeSettings;
  /** The settings are the defaults, not yet saved: the first reading saves them, with the time zone of the Stripe account. */
  defaulted: boolean;
  key: string;
  port: IngestPort;
  balanceAccountId: string;
}> {
  // What the owner saved, else the defaults: a book is not asked to save what it already knows before Stripe can be read (defaults.ts).
  const inUse = settingsInUse(service, store, runtime);
  if (!inUse) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
  const settings = inUse.settings;
  // Each role's account as of today: the owner's choice, else the chart's role key.
  const { chart, roleKeyOf } = await readChart(service);
  const roles = resolveRoles(settings, chart, roleKeyOf, todayOf(runtime));
  const balanceAccountId = accountOf(roles, "stripe.balance");
  if (!isReady(roles) || balanceAccountId === null)
    throw new ApplicationError(
      "stripe_not_configured",
      `Choose the accounts Stripe is booked to first. ${unresolvedRoles(roles)
        .map((r) => r.problem ?? r.role)
        .join(" ")} Use stripe.configure.`.slice(0, 900),
      409,
    );
  let key = DELIVERED_KEY;
  if (!delivered) {
    const read = runtime.keySource.read();
    if (read === null)
      throw new ApplicationError(
        "stripe_key_missing",
        store.connection().linkAccount !== null
          ? "This workspace holds no Stripe key, and never will. Rastrata reads Stripe for it every day through the Stripe app the owner connected; the owner can ask for a read now. To pull it from your own computer instead, use rastrata stripe pull."
          : runtime.senderFetches
            ? "This workspace holds no Stripe key, and never will. Pull Stripe from your own computer with rastrata stripe pull: it reads Stripe with a read-only key that stays there."
            : "Rastrata has no Stripe key. Create a restricted read-only key in the Stripe dashboard and put it in the RASTRATA_STRIPE_KEY environment variable or in the file stripe.key in the data folder (readable only by you), then sync again.",
        409,
      );
    if (isKeyProblem(read)) throw new ApplicationError("stripe_key_unusable", read.problem, 409);
    key = read.key;
  }
  let port: IngestPort;
  try {
    port = runtime.port ?? ingestPort(service);
  } catch {
    throw new ApplicationError(
      "ingest_unavailable",
      "The Inbox is not available in this build, so Stripe lines cannot be queued.",
      503,
    );
  }
  return { settings, defaulted: !inUse.saved, key, port, balanceAccountId };
}

interface Counters {
  pages: Set<string>;
  transactions: number;
  newLines: number;
  duplicateLines: number;
  invalid: number;
  heldPayouts: number;
  payoutsBooked: number;
  taxNotReported: number;
  refundTaxNotSplit: number;
  adjustments: number;
  problems: string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function notesFrom(c: Counters, waiting: number): string[] {
  const notes: string[] = [];
  if (c.payoutsBooked > 0)
    notes.push(
      `${plural(c.payoutsBooked, "payout", "payouts")} booked, each as one entry waiting in the Inbox with its transactions as evidence.`,
    );
  if (waiting > 0)
    notes.push(
      `${plural(waiting, "payout is", "payouts are")} waiting for Stripe to finish itemising ${waiting === 1 ? "it" : "them"}. They are booked on a later sync.`,
    );
  if (c.heldPayouts > 0)
    notes.push(
      `${plural(c.heldPayouts, "payout", "payouts")} could not be itemised (another currency or made by hand). ${c.heldPayouts === 1 ? "It is" : "They are"} in the Inbox for you to categorise.`,
    );
  if (c.adjustments > 0)
    notes.push(
      `${plural(c.adjustments, "movement", "movements")} Rastrata does not book by itself (an adjustment, a top-up, a reserve) ${c.adjustments === 1 ? "is" : "are"} inside payouts. Choose an adjustments account in the settings so those payouts can be proposed.`,
    );
  if (c.taxNotReported > 0)
    notes.push(
      `${plural(c.taxNotReported, "charge", "charges")} had no sales tax figure from Stripe (not paid through Checkout or an invoice), so all of ${c.taxNotReported === 1 ? "it was" : "them were"} booked as sales.`,
    );
  if (c.refundTaxNotSplit > 0)
    notes.push(
      `${plural(c.refundTaxNotSplit, "partial refund", "partial refunds")} of taxed sales: Stripe does not say how much tax was refunded, so all of it is booked to refunds. Adjust the tax by hand if tax was refunded.`,
    );
  if (c.invalid > 0)
    notes.push(
      `${plural(c.invalid, "line", "lines")} already in the Inbox ${c.invalid === 1 ? "was" : "were"} reported by Stripe with different figures. ${c.invalid === 1 ? "The original is" : "The originals are"} flagged; nothing was overwritten.`,
    );
  for (const problem of c.problems.slice(0, 4)) notes.push(problem);
  return notes.slice(0, 10).map((n) => n.slice(0, 300));
}

/** One sync at a time per book: two at once would race on the cursor. */
function claim(service: ApplicationService): () => void {
  const state = sliceState(service, "stripe.sync", () => ({ running: false }));
  if (state.running)
    throw new ApplicationError(
      "stripe_sync_running",
      "A Stripe sync is already running. Wait for it to finish.",
      409,
      [],
      true,
    );
  state.running = true;
  return () => {
    state.running = false;
  };
}

function recordPayout(store: StripeStore, payout: Payout, timeZone: string): void {
  const cents = minorToCents(payout.amount, payout.currency);
  if (cents === null) return;
  store.upsertPayout({
    id: payout.id,
    amountCents: cents,
    currency: payout.currency,
    createdOn: localDate(payout.created, timeZone),
    arrivalOn: utcDate(payout.arrivalDate),
    status: payout.status,
    automatic: payout.automatic,
    reconciliationStatus: payout.reconciliationStatus,
    reversed: payout.status === "failed" || payout.status === "canceled",
  });
}

async function readBalance(
  client: StripeClient,
  store: StripeStore,
  guard: ModeGuard,
  bookCurrency: string,
  at: string,
): Promise<BalanceSnapshot | null> {
  const fetched = await client.get("/v1/balance");
  const decoded = decodeBalance(fetched.json);
  if (!decoded.ok) return null;
  guard.seen(decoded.value.livemode);
  const totals = new Map<string, { available: bigint; pending: bigint }>();
  for (const [bucket, list] of [
    ["available", decoded.value.available],
    ["pending", decoded.value.pending],
  ] as const)
    for (const amount of list) {
      const cents = minorToCents(amount.amount, amount.currency);
      if (cents === null) continue;
      const entry = totals.get(amount.currency) ?? { available: 0n, pending: 0n };
      entry[bucket] += cents;
      totals.set(amount.currency, entry);
    }
  const book = totals.get(bookCurrency.toUpperCase()) ?? { available: 0n, pending: 0n };
  const snapshot: BalanceSnapshot = {
    readAt: at,
    currency: bookCurrency.toUpperCase(),
    available: formatMoney(book.available),
    pending: formatMoney(book.pending),
    total: formatMoney(book.available + book.pending),
    otherCurrencies: [...totals]
      .filter(([currency]) => currency !== bookCurrency.toUpperCase())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, t]) => ({ currency, total: formatMoney(t.available + t.pending) })),
  };
  store.saveBalance(JSON.stringify(snapshot), at);
  return snapshot;
}

export async function runStripeSync(
  service: ApplicationService,
  input: SyncInput,
  operationId: string,
  delivered?: Delivered,
): Promise<SyncOutcome> {
  const store = stripeStore(service);
  const runtime = stripeRuntime(service);
  // Claim first: reading the chart waits, and a second call must not slip in while this one does.
  const release = claim(service);
  let ready: Awaited<ReturnType<typeof requireReady>>;
  try {
    ready = await requireReady(service, store, runtime, delivered !== undefined);
  } catch (error) {
    release();
    throw error;
  }
  const { settings: initial, defaulted, key, port, balanceAccountId } = ready;
  const setup = service.setupState();
  if (!setup) {
    release();
    throw new ApplicationError("book_not_configured", "Book is not configured", 409);
  }
  const startedAt = runtime.now();
  store.startRun(operationId, startedAt);
  const counters: Counters = {
    pages: new Set(),
    transactions: 0,
    newLines: 0,
    duplicateLines: 0,
    invalid: 0,
    heldPayouts: 0,
    payoutsBooked: 0,
    taxNotReported: 0,
    refundTaxNotSplit: 0,
    adjustments: 0,
    problems: [],
  };
  const seconds = Math.max(1, Math.min(25, input.budgetSeconds ?? DEFAULT_BUDGET_SECONDS));
  const budget: RequestBudget = {
    deadline: Date.parse(startedAt) + seconds * 1000,
    // Delivered answers cost no round trip, so only the time limits a call.
    maxRequests: delivered ? MAX_DELIVERED_REQUESTS_PER_CALL : MAX_REQUESTS_PER_CALL,
    used: 0,
  };
  // The instant the pull reads up to: the clock for a sync, the sender's choice for the whole pull
  // for a delivery.
  const pullNow = delivered ? () => delivered.asOf : runtime.now;
  let settings = initial;
  let more = false;
  // The work of a call that is given its answers, and whether it stopped early for having done enough of it.
  let work = 0;
  let stopped = false;
  let balance: BalanceSnapshot | null = null;
  let through: string | null = store.connection().through;
  const scrub = (text: string): string => redact(text, [key]);
  const finish = (
    disposition: RunRow["disposition"],
    error: { code: string; message: string } | null,
  ): RunRow => {
    const waiting = store.pendingPayoutIds().length;
    const row: RunRow = {
      id: operationId,
      startedAt,
      finishedAt: runtime.now(),
      disposition,
      requests: budget.used,
      pages: counters.pages.size,
      transactions: counters.transactions,
      newLines: counters.newLines,
      duplicateLines: counters.duplicateLines,
      heldLines: counters.heldPayouts,
      payouts: counters.payoutsBooked,
      through,
      errorCode: error?.code ?? null,
      errorMessage: error ? scrub(error.message).slice(0, 500) : null,
      notes: notesFrom(counters, disposition === "complete" ? waiting : 0),
    };
    store.finishRun(row);
    return row;
  };
  // What this run says it reads: the mode of the key it holds, or what the sender of the answers declared.
  const guard = new ModeGuard(
    store,
    delivered
      ? delivered.livemode === undefined
        ? null
        : delivered.livemode
          ? "live"
          : "test"
      : keyMode(key),
  );
  try {
    guard.begin();
    const client = new StripeClient({
      key,
      fetch: delivered ? delivered.fetch : runtime.fetch,
      now: () => Date.parse(runtime.now()),
      budget,
      // A delivered answer is the same answer however often it is asked for: there is nothing to wait for.
      ...(delivered ? { sleep: async () => {} } : runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.random ? { random: runtime.random } : {}),
      ...(runtime.baseUrl && !delivered ? { baseUrl: runtime.baseUrl } : {}),
    });

    // Which Stripe account is this? Part of every line's identity, so it is fixed once learned.
    const account = decodeAccount((await client.get("/v1/account")).json);
    if (!account.ok)
      throw new StripeError(
        "stripe_bad_response",
        "Stripe's account answer could not be read.",
        false,
      );
    const accountKey = `stripe:${account.value.id}`;
    if (settings.accountKey !== null && settings.accountKey !== accountKey)
      throw new ApplicationError(
        "stripe_account_changed",
        "This Stripe key belongs to a different Stripe account than the one this book has been syncing. Nothing was imported. Use the original account's key, or start a new book for the other account.",
        409,
      );
    store.rememberAccount(
      account.value.id,
      account.value.defaultCurrency,
      account.value.dashboardTimeZone,
    );
    guard.learn();
    if (settings.accountKey === null) {
      // The first reading of a book that was never told otherwise dates each movement in the time zone its Stripe dashboard reports in.
      const zone = account.value.dashboardTimeZone;
      settings = {
        ...settings,
        accountKey,
        ...(defaulted && zone !== null && isTimeZone(zone) ? { timeZone: zone } : {}),
      };
      store.saveSettings(serialiseSettings(settings), startedAt);
    }
    if (
      account.value.defaultCurrency &&
      account.value.defaultCurrency.toUpperCase() !== setup.currency
    )
      counters.problems.push(
        `Stripe settles in ${account.value.defaultCurrency.toUpperCase()} but this book is in ${setup.currency}. Payouts in ${account.value.defaultCurrency.toUpperCase()} are held for review and never converted.`,
      );

    const connector = createStripeConnector(
      {
        accountId: account.value.id,
        bookCurrency: setup.currency,
        timeZone: settings.timeZone,
        syncFrom: settings.syncFrom,
        salesTax: settings.salesTax,
        overlapSeconds: settings.overlapDays * DAY,
        windowSeconds: 31 * DAY,
        pageSize: 100,
        balanceAccountId,
      },
      {
        key,
        known: (id) => store.isKnown(id),
        pendingPayouts: () => store.pendingPayoutIds(),
        pendingPayoutDays: () => store.pendingPayoutDays(),
        tax: { get: (pi) => store.taxGet(pi), set: (pi, value) => store.taxSet(pi, value) },
        budget,
        // A payout Stripe labels with the other mode is turned away before anything of it is kept.
        checkPayout: (payout) => guard.seen(payout.livemode),
        ...(delivered ? { sleep: async () => {} } : runtime.sleep ? { sleep: runtime.sleep } : {}),
        ...(runtime.random ? { random: runtime.random } : {}),
        ...(runtime.baseUrl && !delivered ? { baseUrl: runtime.baseUrl } : {}),
        // The time budget is the service's own clock's, whatever instant the pull reads up to.
        ...(delivered
          ? {
              collectMisses: true,
              bulk: true,
              concurrency: 1000,
              clock: () => Date.parse(runtime.now()),
            }
          : {}),
      },
    );

    try {
      const pulled: AsyncIterable<PulledBatch> = connector.pull(store.connection().cursor, {
        fetch: delivered ? delivered.fetch : runtime.fetch,
        now: pullNow,
      });
      for await (const item of pulled) {
        // Archive every page (the same bytes are one blob), then submit what it queues, and only
        // after the pipeline has applied it remember what it contained.
        const raw = port.archive(item.raw.bytes, item.raw.mediaType, item.raw.name);
        let queued = 0;
        let repeated = 0;
        let refused = 0;
        if (item.batch.lines.length > 0) {
          const report = port.submit({ ...item.batch, raw });
          queued = report.newCount;
          repeated = report.duplicateCount + report.overlapCount;
          refused = report.invalidCount;
        }
        store.transaction(() => {
          for (const t of item.records.transactions) {
            store.recordTransaction({
              id: t.id,
              created: t.created,
              currency: t.currency,
              category: t.category,
              netCents: t.netCents,
              payout: t.payout,
            });
            // A payout is first seen as Stripe's own debit of the balance.
            if (t.payout && t.netCents !== null && t.netCents < 0n)
              store.noticePayout(
                t.payout,
                -t.netCents,
                t.currency,
                localDate(t.created, settings.timeZone),
              );
          }
          for (const payout of item.records.payouts) recordPayout(store, payout, settings.timeZone);
          for (const c of item.records.covered)
            store.markCovered(c.id, c.currency, c.netCents, c.created);
          const outcome = item.records.outcome;
          if (outcome) {
            store.recordPayoutOutcome(outcome.payoutId, {
              state: outcome.state,
              reason: outcome.reason,
              memberCount: outcome.memberCount,
              memberNetCents: outcome.memberNetCents,
              membersSha256: outcome.membersSha256,
              heldKind: outcome.heldKind,
              taxNotReported: outcome.counts.taxNotReported,
              refundTaxNotSplit: outcome.counts.refundTaxNotSplit,
              adjustments: outcome.counts.adjustments,
            });
          }
          if (item.batch.cursor !== undefined) {
            const cursor = decodeCursor(item.batch.cursor);
            through = cursor ? localDate(cursor.through, settings.timeZone) : through;
            store.saveCursor(item.batch.cursor, through);
          }
        });
        counters.pages.add(item.raw.name ?? "");
        counters.transactions += item.records.pageTransactions;
        counters.newLines += queued;
        counters.duplicateLines += repeated;
        counters.invalid += refused;
        for (const warning of item.records.warnings) counters.problems.push(warning);
        const outcome = item.records.outcome;
        if (outcome?.state === "summarised") {
          counters.payoutsBooked++;
          counters.taxNotReported += outcome.counts.taxNotReported;
          counters.refundTaxNotSplit += outcome.counts.refundTaxNotSplit;
          counters.adjustments += outcome.counts.adjustments;
        } else if (outcome?.state === "held") counters.heldPayouts++;
        // Only what is new counts: the days a window reads again from the cursor change nothing, and a call that stopped for them would never get past them.
        if (delivered && (queued > 0 || item.records.transactions.length > 0 || outcome !== null)) {
          work += item.raw.bytes.byteLength + queued * LINE_WORK;
          const unitEnds = outcome !== null || item.batch.cursor !== undefined;
          if (unitEnds && work >= (runtime.workPerCall ?? DELIVERED_WORK_PER_CALL)) {
            stopped = true;
            break;
          }
        }
      }
      // The pull is complete: read Stripe's own balance for the control. A delivery that still lacks
      // answers for some payouts is not complete, and asks for them before it asks for the balance.
      if (stopped || (delivered && delivered.misses().length > 0)) more = true;
      else balance = await readBalance(client, store, guard, setup.currency, pullNow());
    } catch (error) {
      if (error instanceof BudgetExhausted || error instanceof ResponseMissing) more = true;
      else throw error;
    }
    const run = finish(more ? "more" : "complete", null);
    return { run, more, balance };
  } catch (error) {
    // The first thing a run asks Stripe is which account this is: a delivery that has no answer to
    // that yet is not a failure, it only has to be sent it.
    if (error instanceof ResponseMissing) {
      const run = finish("more", null);
      return { run, more: true, balance: null };
    }
    if (error instanceof StripeError) {
      const converted = failure(error);
      finish("failed", { code: converted.code, message: converted.message });
      throw converted;
    }
    if (error instanceof ApplicationError) {
      finish("failed", { code: error.code, message: error.message });
      throw error;
    }
    finish("failed", { code: "stripe_sync_failed", message: "The sync stopped unexpectedly." });
    throw error;
  } finally {
    release();
  }
}

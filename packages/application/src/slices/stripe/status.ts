import { compareMoney, formatMoney, subtractMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import { describeKey } from "../../stripe/credentials.ts";
import { ROLE_LABELS, STRIPE_ROLES } from "../../stripe/roles.ts";
import { type ChartRead, readChart } from "./chart.ts";
import { addDays } from "../../stripe/dates.ts";
import { depositOf } from "./deposits.ts";
import { planForBook } from "./matching.ts";
import { stripeRuntime, todayOf } from "./runtime.ts";
import {
  DEFAULT_MATCH_WINDOW_DAYS,
  type RoleResolution,
  type StripeSettings,
  accountOf,
  isReady,
  resolveRoles,
  parseSettings,
} from "./settings.ts";
import { type PayoutRow, type RunRow, stripeStore } from "./store.ts";
import type { BalanceSnapshot } from "./sync.ts";

/** The wire shapes of the Stripe slice (see schema.ts) and the code that builds them. Everything
 * here is read-only. Nothing in a status ever contains the key. */

export const settingsWire = (settings: StripeSettings) => ({
  // Only what the owner chose. A role they left to the chart's role key is not listed here; see
  // `roles` for the account it resolves to.
  mapping: STRIPE_ROLES.flatMap((role) => {
    const chosen = settings.mapping.find((m) => m.role === role);
    return chosen ? [{ role, accountId: chosen.accountId }] : [];
  }),
  syncFrom: settings.syncFrom,
  timeZone: settings.timeZone,
  salesTax: settings.salesTax,
  overlapDays: settings.overlapDays,
  matchWindowDays: settings.matchWindowDays,
  accountKey: settings.accountKey,
});

export const roleWire = (r: RoleResolution) => ({
  role: r.role,
  label: ROLE_LABELS[r.role],
  required: r.required,
  state: r.state,
  accountId: r.accountId,
  code: r.code,
  problem: r.problem,
});

export const runWire = (run: RunRow) => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  disposition: run.disposition,
  requests: run.requests,
  pages: run.pages,
  transactions: run.transactions,
  newLines: run.newLines,
  duplicateLines: run.duplicateLines,
  heldLines: run.heldLines,
  payouts: run.payouts,
  through: run.through,
  errorCode: run.errorCode,
  errorMessage: run.errorMessage,
  notes: [...run.notes],
});

export const snapshotWire = (s: BalanceSnapshot) => ({
  readAt: s.readAt,
  currency: s.currency,
  available: s.available,
  pending: s.pending,
  total: s.total,
  otherCurrencies: s.otherCurrencies.map((o) => ({ currency: o.currency, total: o.total })),
});

const ONE_HOUR = 3_600_000;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function explainBalance(input: {
  readonly snapshot: BalanceSnapshot | null;
  readonly unpaid: string;
  readonly unpaidCount: number;
  readonly difference: string | null;
  readonly inTransit: string | null;
  readonly settings: StripeSettings | null;
  readonly lastDisposition: RunRow["disposition"] | null;
  readonly waiting: number;
  /** Stripe is read by the sender's computer (`rastrata stripe pull`), not by the service. */
  readonly bySender?: boolean;
  /** The owner connected a Stripe account with the button: Rastrata reads it every day. */
  readonly linked?: boolean;
}): string {
  const { snapshot, difference } = input;
  const run = input.bySender ? "rastrata stripe pull" : "a sync";
  if (!snapshot)
    return input.linked
      ? "Stripe's balance has not been read yet. Rastrata reads the connected Stripe account every day; the owner can ask for a read now."
      : `Stripe's balance has not been read yet. Run ${run} to read it and compare it with what Rastrata has imported.`;
  const parts = [
    `Stripe holds ${snapshot.total} (${snapshot.available} available, ${snapshot.pending} pending): every transaction not yet paid out.`,
    `Rastrata knows of ${plural(input.unpaidCount, "transaction", "transactions")} not yet in a payout, ${input.unpaid} in all.`,
  ];
  if (difference !== null) {
    if (compareMoney(difference, "0.00") === 0) parts.push("They agree to the cent.");
    else if (compareMoney(difference, "0.00") > 0)
      parts.push(
        `The other ${difference} is in transactions Rastrata has not imported: older than ${input.settings?.syncFrom ?? "the first day"} (the first payouts after it carry them, and are booked with them), or newer than the last sync.`,
      );
    else
      parts.push(
        `Rastrata knows of ${difference.slice(1)} more than Stripe holds. Check that no payout was imported twice.`,
      );
  }
  if (input.waiting > 0)
    parts.push(
      `${plural(input.waiting, "payout is", "payouts are")} waiting for Stripe to finish itemising ${input.waiting === 1 ? "it" : "them"}.`,
    );
  if (input.inTransit !== null)
    parts.push(
      `Your books show ${input.inTransit} in payouts in transit: payouts booked whose bank deposit has not been matched yet.`,
    );
  if (input.lastDisposition !== "complete")
    parts.push(
      input.linked
        ? "The last read did not finish, so some movements may not be imported yet. Rastrata tries again; the owner can ask for a read now."
        : input.bySender
          ? "The last pull did not finish, so some movements may not be imported yet. Run rastrata stripe pull again."
          : "The last sync did not finish, so some movements may not be imported yet. Sync again.",
    );
  return parts.join(" ");
}

export function payoutCounts(
  payouts: readonly PayoutRow[],
  matched: ReadonlySet<string>,
  today: string,
  windowDays: number,
) {
  // Unmatched is not the same as late: a payout sent yesterday has no deposit yet and that is normal.
  // One whose arrival date and window have both passed should have arrived.
  const overdue = payouts
    .filter(
      (p) => depositOf(p, matched) === "unmatched" && addDays(p.arrivalOn, windowDays) < today,
    )
    .map((p) => p.arrivalOn)
    .sort();
  return {
    known: payouts.length,
    booked: payouts.filter((p) => p.booking === "summarised").length,
    waiting: payouts.filter((p) => p.booking === "waiting").length,
    mismatched: payouts.filter((p) => ["mismatch", "invalid", "empty"].includes(p.booking)).length,
    held: payouts.filter((p) => p.booking === "held").length,
    reversed: payouts.filter((p) => p.reversed).length,
    unmatched: payouts.filter((p) => depositOf(p, matched) === "unmatched").length,
    overdue: overdue.length,
    oldestOverdueOn: overdue[0] ?? null,
  };
}

export async function stripeStatus(service: ApplicationService, input: { books?: boolean }) {
  const store = stripeStore(service);
  const runtime = stripeRuntime(service);
  // What the owner saved, or the first reading did (defaults.ts): null says nothing of Stripe has been set in this book, which is how the rest of the application tells a business that
  // uses Stripe from one that does not. A reading does not wait for it.
  const settings = parseSettings(store.settingsBody());
  const setup = service.setupState();
  const connection = store.connection();
  const runs = store.runs(10);
  const last = runs[0] ?? null;
  const lastRead = store.lastRead();
  const books: ChartRead | null =
    setup !== null ? await readChart(service, { balances: input.books !== false }) : null;
  // Each role's account as of today: what the owner chose, else what the chart's role key names.
  const roles = resolveRoles(
    settings ?? { mapping: [], salesTax: "stripe" },
    books?.chart ?? [],
    books?.roleKeyOf ?? (() => undefined),
    todayOf(runtime),
  );
  const transitAccount = accountOf(roles, "payouts.in-transit");
  const inTransit = transitAccount ? (books?.balances.get(transitAccount) ?? null) : null;
  const snapshot = connection.balanceBody
    ? (JSON.parse(connection.balanceBody) as BalanceSnapshot)
    : null;
  const unpaid = store.unpaid(snapshot?.currency ?? setup?.currency ?? "USD");
  const unpaidText = formatMoney(unpaid.netCents);
  const difference = snapshot ? subtractMoney(snapshot.total, unpaidText) : null;
  const stale =
    snapshot === null ||
    Date.parse(runtime.now()) - Date.parse(snapshot.readAt) > ONE_HOUR ||
    last?.disposition !== "complete";
  const totals = store.bookingTotals();
  const payouts = store.payouts();
  const window = settings?.matchWindowDays ?? DEFAULT_MATCH_WINDOW_DAYS;
  const counts = payoutCounts(
    payouts,
    planForBook(service, payouts, window).settled,
    todayOf(runtime),
    window,
  );
  return {
    configured: settings !== null && isReady(roles),
    bookCurrency: setup?.currency ?? "USD",
    fetchedBy: runtime.senderFetches ? ("sender" as const) : ("service" as const),
    mode: connection.mode,
    link:
      connection.linkAccount !== null
        ? {
            accountId: connection.linkAccount,
            livemode: connection.linkLive === true,
            since: connection.linkedAt ?? "",
          }
        : null,
    key: describeKey(runtime.keySource),
    settings: settings ? settingsWire(settings) : null,
    roles: roles.map(roleWire),
    account: connection.accountId
      ? {
          id: connection.accountId,
          defaultCurrency: connection.defaultCurrency ?? "",
          timeZone: connection.timeZone,
        }
      : null,
    lastSync: last ? runWire(last) : null,
    lastRead: lastRead ? runWire(lastRead) : null,
    history: runs.map(runWire),
    through: connection.through,
    balance: {
      snapshot: snapshot ? snapshotWire(snapshot) : null,
      unpaid: snapshot ? unpaidText : null,
      unpaidCount: unpaid.count,
      difference,
      inTransit,
      ties: difference !== null && compareMoney(difference, "0.00") === 0,
      stale,
      explanation: explainBalance({
        snapshot,
        unpaid: unpaidText,
        unpaidCount: unpaid.count,
        difference,
        inTransit,
        settings,
        lastDisposition: last?.disposition ?? null,
        waiting: counts.waiting,
        bySender: runtime.senderFetches,
        linked: connection.linkAccount !== null,
      }).slice(0, 1500),
    },
    payouts: counts,
    held: {
      lines: totals.held,
      otherCurrency: totals.otherCurrency,
      manualPayouts: totals.manual,
      adjustments: totals.adjustments,
      taxNotReported: totals.taxNotReported,
      refundsWithoutTaxSplit: totals.refundNotSplit,
    },
  };
}

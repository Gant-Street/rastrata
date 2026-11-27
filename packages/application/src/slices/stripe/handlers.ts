import { requireControlPlane } from "../../agent/principal.ts";
import { ApplicationError } from "../../errors.ts";
import { formatMoney, subtractMoney } from "../../money.ts";
import { STRIPE_API_VERSION } from "../../stripe/client.ts";
import type { SliceHandler, SliceHandlers } from "../types.ts";
import { stripeStore } from "./store.ts";
import "./proposer.ts";
import { readChart } from "./chart.ts";
import { firstDay } from "./defaults.ts";
import { depositOf, matchedPayouts } from "./deposits.ts";
import { stripeRuntime, todayOf } from "./runtime.ts";
import {
  type ConfigureInput,
  type RoleResolution,
  type StripeSettings,
  applyConfigure,
  defaultSettings,
  isResolved,
  parseSettings,
  rejectUnusableChoices,
  resolveRoles,
  serialiseSettings,
  unresolvedRoles,
} from "./settings.ts";
import { type ReceiveInput, receiveStripe } from "./receive.ts";
import { roleWire, runWire, settingsWire, snapshotWire, stripeStatus } from "./status.ts";
import { runStripeSync } from "./sync.ts";

/** Handlers for the Stripe operations. Inputs are validated, permission checked and the book is
 * configured by the time they run. None of them returns, logs or echoes the key. */

const PAGE_SIZE = 25;

const configure: SliceHandler = (input, { service, operationId }) =>
  service.retainAsyncRequest(operationId, "stripe.configure", input, async () => {
    const store = stripeStore(service);
    const runtime = stripeRuntime(service);
    const setup = service.setupState();
    if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
    const { chart, roleKeyOf } = await readChart(service);
    const existing = store.settingsBody();
    const today = todayOf(runtime);
    const current = parseSettings(existing) ?? defaultSettings(firstDay(service, setup, today));
    const request = input as ConfigureInput;
    const connection = store.connection();
    if (
      connection.cursor !== null &&
      request.syncFrom !== undefined &&
      request.syncFrom !== current.syncFrom
    )
      throw new ApplicationError(
        "stripe_start_fixed",
        "The first day to import cannot change once Stripe lines have been imported. It keeps every line's date and the Inbox's cutover consistent.",
        409,
      );
    const next = applyConfigure(current, request, chart, today);
    // What is saved is what the owner chose. A role they did not choose takes the account the chart
    // tags with its role key, looked up again on the date of each entry, so it follows the chart.
    const roles = resolveRoles(next, chart, roleKeyOf, today);
    rejectUnusableChoices(next, roles);
    store.saveSettings(serialiseSettings(next), runtime.now());
    return {
      settings: settingsWire(next),
      roles: roles.map(roleWire),
      ready: unresolvedRoles(roles).length === 0,
      notes: configureNotes(next, roles, connection.timeZone),
    };
  });

function configureNotes(
  settings: StripeSettings,
  roles: readonly RoleResolution[],
  dashboardZone: string | null,
): string[] {
  const notes: string[] = [];
  const open = unresolvedRoles(roles);
  for (const role of open) if (role.problem) notes.push(role.problem);
  if (open.length > 0)
    notes.push(
      `Stripe cannot sync until ${open.length === 1 ? "this account is" : "these accounts are"} settled: ${open.map((r) => r.role).join(", ")}.`,
    );
  else notes.push("Every account Stripe needs is settled. You can sync now.");
  const tagged = roles.filter((r) => r.state === "tagged");
  if (tagged.length > 0)
    notes.push(
      `Taken from the chart's role keys, as of today: ${tagged.map((r) => `${r.role} is account ${r.code}`).join("; ")}. Choose an account here to override one.`,
    );
  const optional = roles.find((r) => r.role === "stripe.adjustments");
  if (optional && !isResolved(optional))
    notes.push(
      optional.state === "missing"
        ? "No account is chosen for other Stripe adjustments. A payout that contains one (an adjustment, a top-up, a reserve) is shown in the Inbox without a proposal until you choose one."
        : (optional.problem ?? ""),
    );
  notes.push(
    `Imports begin on ${settings.syncFrom} (midnight in ${settings.timeZone}); each movement is dated by that time zone.`,
  );
  if (dashboardZone && dashboardZone !== settings.timeZone)
    notes.push(
      `Stripe's dashboard reports in ${dashboardZone}; set timeZone to match if you compare with Stripe's reports.`,
    );
  notes.push(
    settings.salesTax === "stripe"
      ? "Sales tax is taken only from figures Stripe reports on Checkout and invoices. Payments made another way are booked whole as sales, and counted."
      : "Sales tax is not split: every charge is booked whole as sales.",
  );
  return notes
    .filter((n) => n.length > 0)
    .slice(0, 20)
    .map((n) => n.slice(0, 500));
}

const sync: SliceHandler = (input, { service, operationId }) =>
  service.retainAsyncRequest(operationId, "stripe.sync", input, async () => {
    const outcome = await runStripeSync(
      service,
      input.budgetSeconds === undefined ? {} : { budgetSeconds: input.budgetSeconds as number },
      operationId,
    );
    return {
      run: runWire(outcome.run),
      more: outcome.more,
      balance: outcome.balance ? snapshotWire(outcome.balance) : null,
    };
  });

const receive: SliceHandler = (input, { service, operationId }) =>
  service.retainAsyncRequest(operationId, "stripe.receive", input, async () => {
    const outcome = await receiveStripe(service, input as unknown as ReceiveInput, operationId);
    return {
      run: runWire(outcome.run),
      more: outcome.more,
      balance: outcome.balance ? snapshotWire(outcome.balance) : null,
      needs: [...outcome.needs],
      apiVersion: STRIPE_API_VERSION,
    };
  });

/** Link: the control plane says which Stripe account the owner connected with the button, or that none is any more. It keeps no answer by the call's identity, as the bank
 * connections' messages do not: it says how things stand now, and saying it again must change what an earlier word left. An account other than the one these books have been
 * reading, or in the other mode, is not taken: the owner is told at once, not when the first read fails. */
const link: SliceHandler = (input, { service, access }) => {
  requireControlPlane(access, "stripe.link");
  const store = stripeStore(service);
  const account = input.account as { readonly id: string; readonly livemode: boolean } | null;
  const at = service.now();
  if (account === null) {
    store.saveLink(null, at);
    return { linked: false, reason: null };
  }
  const connection = store.connection();
  if (connection.accountId !== null && connection.accountId !== account.id)
    return { linked: false, reason: "account_changed" };
  if (connection.mode !== null && connection.mode !== (account.livemode ? "live" : "test"))
    return { linked: false, reason: "mode_changed" };
  store.saveLink({ account: account.id, live: account.livemode }, at);
  return { linked: true, reason: null };
};

const status: SliceHandler = async (input, { service }) =>
  stripeStatus(service, {
    ...(input.books === undefined ? {} : { books: input.books as boolean }),
  });

const BOOKING: Readonly<Record<string, string>> = {
  summarised: "booked",
  waiting: "waiting",
  mismatch: "mismatch",
  invalid: "invalid",
  empty: "empty",
  held: "held",
};

const REASONS: Readonly<Record<string, string>> = {
  summarised:
    "Booked as one entry in the Inbox, with its transactions as evidence. The bank deposit is matched there.",
  waiting: "Waiting for Stripe to finish itemising this payout; it is booked on a later sync.",
  held: "Held for you to categorise in the Inbox.",
};

const payouts: SliceHandler = (input, { service }) => {
  const store = stripeStore(service);
  const matched = matchedPayouts(service);
  const filter = (input.filter as string | undefined) ?? "all";
  const pageNumber = (input.page as number | undefined) ?? 1;
  const all = store.payouts().filter((p) => {
    if (filter === "waiting") return p.booking === "waiting";
    if (filter === "mismatch") return ["mismatch", "invalid", "empty"].includes(p.booking);
    if (filter === "held") return p.booking === "held";
    if (filter === "unmatched") return depositOf(p, matched) === "unmatched";
    return true;
  });
  const slice = all.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  return {
    count: all.length,
    page: pageNumber,
    pageSize: PAGE_SIZE,
    payouts: slice.map((p) => ({
      id: p.id,
      amount: formatMoney(p.amountCents),
      currency: p.currency,
      createdOn: p.createdOn,
      arrivalOn: p.arrivalOn,
      status: p.status,
      automatic: p.automatic,
      itemised: ["completed", "in_progress", "not_applicable"].includes(p.reconciliationStatus)
        ? p.reconciliationStatus
        : "not_applicable",
      booking: BOOKING[p.booking] ?? "waiting",
      memberCount: p.memberCount ?? 0,
      memberNet: p.memberNetCents === null ? null : formatMoney(p.memberNetCents),
      difference:
        p.memberNetCents === null
          ? null
          : subtractMoney(formatMoney(p.amountCents), formatMoney(p.memberNetCents)),
      deposit: depositOf(p, matched),
      reason:
        (
          p.bookingReason ??
          (p.reversed
            ? "Stripe returned this payout to the balance, so no deposit is expected."
            : (REASONS[p.booking] ?? null))
        )?.slice(0, 500) ?? null,
    })),
  };
};

export const stripeHandlers: SliceHandlers = {
  "stripe.configure": configure,
  "stripe.sync": sync,
  "stripe.receive": receive,
  "stripe.link": link,
  "stripe.status": status,
  "stripe.payouts": payouts,
};

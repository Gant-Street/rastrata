import { BridgeBudgetSpent, type RequestEvent } from "../../bankfeed/client.ts";
import {
  BRIDGE_REQUESTS_PER_DAY,
  QUOTA_WINDOW_MS,
  REQUEST_BUDGET_PER_DAY,
} from "../../bankfeed/constants.ts";
import type { BankfeedStore } from "./store.ts";

/** The Bridge's quota, counted by us. The Bridge expects "24 requests or fewer per day", replenishes
 * that "throughout the day", and sends no counter in its answers, so the only way to stay inside it is
 * to count every request in a rolling 24 hours and stop before the limit. Rastrata stops at 20 of the
 * 24: a retry, a second press of Sync or an agent calling in a loop can then never reach the point
 * where the Bridge disables the access. The count survives restarts because it lives in the book's
 * product state (a row per request, kept three days). */

export interface Quota {
  /** Requests in the last 24 hours. */
  readonly used: number;
  /** When the oldest request that counts leaves the window, freeing one: null when none count. */
  readonly freesAtMs: number | null;
  /** Rastrata will not make another request now. */
  readonly spent: boolean;
  /** When a request is next allowed because of the budget alone. */
  readonly nextAtMs: number | null;
}

export function quotaAt(store: BankfeedStore, nowMs: number): Quota {
  const times = store.requestTimesSince(nowMs - QUOTA_WINDOW_MS);
  const used = times.length;
  const spent = used >= REQUEST_BUDGET_PER_DAY;
  // The request that, once aged out, brings the count below the budget.
  const releasing = times[used - REQUEST_BUDGET_PER_DAY];
  return {
    used,
    freesAtMs: times[0] === undefined ? null : times[0] + QUOTA_WINDOW_MS,
    spent,
    nextAtMs: spent && releasing !== undefined ? releasing + QUOTA_WINDOW_MS : null,
  };
}

export const REQUESTS_LIMIT = BRIDGE_REQUESTS_PER_DAY;
export const REQUESTS_BUDGET = REQUEST_BUDGET_PER_DAY;

/** The guard the client asks before every request. It refuses, by throwing `BridgeBudgetSpent`, when
 * the Bridge has asked Rastrata to slow down, when the day's budget is spent, and when this call's own
 * time is up. A claim is not a request against the quota and is never refused here. */
export function budgetGuard(
  store: BankfeedStore,
  now: () => number,
  deadlineMs: number | null,
): (kind: RequestEvent["kind"]) => void {
  return (kind) => {
    if (kind === "claim") return;
    const at = now();
    const pausedUntil = store.connection().pausedUntil;
    const paused = pausedUntil === null ? Number.NaN : Date.parse(pausedUntil);
    if (paused > at) throw new BridgeBudgetSpent("rate_limited", paused);
    const quota = quotaAt(store, at);
    if (quota.spent) throw new BridgeBudgetSpent("daily_budget", quota.nextAtMs);
    if (deadlineMs !== null && at >= deadlineMs) throw new BridgeBudgetSpent("call_budget");
  };
}

/** Every request, whether or not an answer came, is written down: the quota is counted from these. */
export function recorder(store: BankfeedStore): (event: RequestEvent) => void {
  return (event) => store.recordRequest(event.at, event.kind, event.accountId, event.status);
}

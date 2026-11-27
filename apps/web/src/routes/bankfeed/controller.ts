import type {
  AccountRow,
  BankfeedAccount,
  BankfeedAttention,
  BankfeedProblem,
  BankfeedRun,
  BankfeedStatus,
  BankfeedSyncResult,
} from "@rastrata/application/client-contracts";
import type {
  BankfeedAccountView,
  BankfeedAttentionView,
  BankfeedCardSummary,
  BankfeedChartOption,
  BankfeedPauseView,
  BankfeedRunView,
} from "@rastrata/ui/bankfeed/types";
import { formatInstant } from "@rastrata/ui/format";

/** Pure translation between what the bank feed operations return and what the screen shows. No
 * fetching, no state: so every rule here (which chart accounts may take a feed, why syncing is
 * blocked, what the Home line says) is tested without a browser. */

/** The workflow names under which a write is kept until the service has answered it, so a reply that
 * is lost can be resumed with exactly what was sent. The setup token is never one of them: it is
 * sent from a client that keeps nothing (see page.tsx). */
export const SYNC = "bankfeed:sync";
export const SETTINGS = "bankfeed:settings";
export const REFRESH = "bankfeed:accounts";
export const DISCONNECT = "bankfeed:disconnect";
export const linkKey = (accountId: string): string => `bankfeed:link:${accountId}`;
export const unlinkKey = (accountId: string): string => `bankfeed:unlink:${accountId}`;

/** Roles whose accounts are Stripe's own: a bank feed does not feed them. */
const STRIPE_ROLE_KEYS = new Set(["stripe.balance", "payouts.in-transit"]);

/** The chart accounts a feed may be booked to: an open asset or liability that is not one of the
 * Stripe accounts. The service refuses anything else, and says why. */
export function chartOptions(accounts: readonly AccountRow[]): BankfeedChartOption[] {
  return accounts
    .filter(
      (account) =>
        (account.role === "asset" || account.role === "liability") &&
        account.closedOn === null &&
        !STRIPE_ROLE_KEYS.has(account.tags?.roleKey ?? ""),
    )
    .map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }));
}

const UNSUPPORTED: Readonly<Record<string, string>> = {
  custom_currency:
    "This account is in a custom currency (an address, not a national currency), which Rastrata cannot book.",
  bad_id: "This account's id from the Bridge cannot be used as a key, so it cannot be linked.",
  ambiguous:
    "Another account in the Bridge's list has the same id, so Rastrata cannot ask for this one on its own and will not link it.",
};

export function accountView(account: BankfeedAccount): BankfeedAccountView {
  const link = account.link;
  return {
    id: account.id,
    name: account.name,
    bank: account.bank,
    currency: account.currency,
    foreignCurrency: account.foreignCurrency,
    balance: account.balance,
    balanceOn: account.balanceOn,
    state: account.state,
    unsupported: account.support === "ok" ? null : (UNSUPPORTED[account.support] ?? null),
    link: link
      ? {
          ledgerAccountId: link.ledgerAccountId,
          ledgerAccount: link.ledgerAccount,
          startOn: link.startOn,
          through: link.through,
          lastSyncAt: link.lastSyncAt,
          lastError: link.lastError?.message ?? null,
          feedBalance: link.feedBalance,
        }
      : null,
  };
}

export function runView(run: BankfeedRun): BankfeedRunView {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    disposition: run.disposition,
    trigger: run.trigger,
    requests: run.requests,
    newLines: run.newLines,
    duplicateLines: run.duplicateLines,
    pendingSkipped: run.pendingSkipped,
    heldLines: run.heldLines,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    notes: run.notes,
  };
}

export function attentionView(items: readonly BankfeedAttention[]): BankfeedAttentionView[] {
  return items.map((item) => ({ code: item.code, severity: item.severity, message: item.message }));
}

/** The Bridge's own words, each once, for the "what the Bridge said" disclosure. */
export function saidBy(problems: readonly BankfeedProblem[]): string[] {
  return [...new Set(problems.map((problem) => problem.said).filter((text) => text !== ""))];
}

/** Why a sync is paused, from the result of a sync. */
export function pauseOf(result: BankfeedSyncResult): BankfeedPauseView | null {
  return result.paused ? { message: result.paused.message, until: result.paused.until } : null;
}

/** Why requests are held back right now, from the status: the Bridge asked Rastrata to slow down. */
export function pauseFromStatus(status: BankfeedStatus, now: Date): BankfeedPauseView | null {
  const until = status.requests.pausedUntil;
  if (until === null || Date.parse(until) <= now.getTime()) return null;
  return {
    message:
      "The Bridge asked Rastrata to slow down, so no request is made until the pause ends. Asking sooner would only risk the access.",
    until,
  };
}

/** Why syncing is not possible right now, in words; null when it is. */
export function syncBlocked(status: BankfeedStatus, now: Date): string | null {
  if (!status.connected) return "Connect your bank first.";
  if (status.linked === 0) return "Link an account first: nothing is read until you do.";
  const pause = pauseFromStatus(status, now);
  if (pause?.until)
    return `Paused: the Bridge asked Rastrata to slow down. It carries on after ${formatInstant(pause.until)}.`;
  return null;
}

/** The Home line. Something that needs the owner is every error or warning; "info" is only good to
 * know ("2 accounts are not linked"). */
export function cardSummary(status: BankfeedStatus, now: Date): BankfeedCardSummary {
  const last = status.lastSync;
  return {
    stage: !status.connected ? "not-connected" : status.linked === 0 ? "no-links" : "ready",
    lastSync: last
      ? {
          at: last.finishedAt ?? last.startedAt,
          ok: last.disposition !== "failed",
          newLines: last.newLines,
        }
      : null,
    needsYou: status.attention.filter((item) => item.severity !== "info").length,
    paused: pauseFromStatus(status, now) !== null,
    unlinked: status.unlinked,
  };
}

/** The words for an error of a request: the service's own message (which already says what to do),
 * or a plain sentence when the failure was not the service's. */
export function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
}

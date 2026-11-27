/** The cutover checklist: from facts other lanes report (reconciliation, the Inbox, Stripe, backups,
 * periods) to one plain verdict, "ready to close this period" or "not yet, because...".
 *
 * Pure and deterministic: it reads nothing and takes the date as a fact, so every rule is a test.
 * Money is exact (cents in a bigint through `money.ts`); no figure is parsed as a float and nothing
 * is forgiven by a tolerance. The rules follow the launch plan: the evidence that a business has
 * moved is that every bank, card and Stripe balance reconciles to its statement at exactly 0.00,
 * not that the books agree with the old system.
 *
 * A fact that could not be read is `null`, never zero: the verdict then says what could not be
 * checked and stays at "not yet". A missing check is never a pass. */
import { sanitizeText } from "../ingest/text.ts";
import { compareMoney, isMoney, parseMoney } from "../money.ts";

export type AccountKind = "bank" | "card";
export type AccountReason = "chosen" | "reconciled" | "imported" | "cash";
export type Section =
  | "accounts"
  | "inbox"
  | "stripe"
  | "backups"
  | "periods"
  | "opening"
  | "cutover";
export type AccountStatus = "ready" | "attention" | "blocked" | "no_activity";
export type VerdictState = "ready" | "not_yet" | "nothing_to_close";

/** How many month ends must be closed and reconciled before the old system is set aside. */
export const SHADOW_RUN_MONTHS = 2;

export interface Reason {
  readonly code: string;
  readonly section: Section;
  readonly message: string;
  readonly accountId?: string;
}

export interface PeriodFacts {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: "open" | "closed";
  /** The period's last day is before today. */
  readonly ended: boolean;
  /** The period ends before the books began, so it holds none of the books' own activity. A book
   * that starts early has years of these; none of them is open work. */
  readonly beforeBooks?: boolean | undefined;
}

/** What the Stripe lane reports: Stripe's own balance against what Rastrata has imported, and the
 * state of the payouts. Stripe is checked against its own balance, not against a bank statement:
 * the evidence is that nothing Stripe holds is missing from Rastrata and every payout adds up. */
export interface StripeFacts {
  /** Stripe's own balance has been read and compared. */
  readonly compared: boolean;
  /** Stripe's balance equals what Rastrata expects it to hold. */
  readonly ties: boolean;
  /** What Stripe holds that Rastrata has not imported; null until compared. */
  readonly difference: string | null;
  /** Imported and not yet paid out. */
  readonly unpaid: string | null;
  /** Payouts booked whose bank deposit is not matched yet. */
  readonly inTransit: string | null;
  readonly readAt: string | null;
  readonly stale: boolean;
  readonly explanation: string;
  readonly payouts: {
    readonly known: number;
    readonly booked: number;
    readonly waiting: number;
    readonly mismatched: number;
    readonly held: number;
    readonly unmatched: number;
    /** Of the unmatched, those whose deposit should have arrived by now (past the arrival date and
     * the matching window), and the arrival date of the oldest. Absent means none is known. */
    readonly overdue?: number;
    readonly oldestOverdueOn?: string | null;
  };
}

export interface AccountFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly kind: AccountKind;
  readonly reason: AccountReason;
  /** In statement orientation: a card that owes 300.00 is 300.00. */
  readonly bookBalance: string;
  readonly lastReconciliation: { readonly date: string; readonly balance: string } | null;
  readonly draft: {
    readonly id: string;
    readonly statementDate: string;
    readonly statementBalance: string;
    readonly difference: string;
  } | null;
  readonly uncleared: {
    readonly count: number;
    readonly total: string;
    readonly oldestOn: string | null;
  };
  /** Inbox lines dated through the period end that still wait; null when the Inbox was not read. */
  readonly waiting: { readonly count: number; readonly oldestOn: string | null } | null;
}

export interface BackupFacts {
  readonly available: boolean;
  /** The service keeps the history of the books itself: there is nothing to verify or drill, and nothing here stands in the way of a month. */
  readonly keptByService?: boolean;
  readonly reason?: string;
  readonly verifiedAt: string | null;
  readonly ageHours: number | null;
  readonly limitHours: number;
  readonly drill: { readonly ranAt: string; readonly passed: boolean } | null;
}

export interface InboxFacts {
  readonly available: boolean;
  /** Lines dated through the period end that still need a person or a posting. */
  readonly waiting: number;
  readonly oldestOn: string | null;
  readonly toReview: number;
}

export interface OtherAccountFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly balance: string;
}

/** Where the money in a catch-all account went, one place of the report by payee. */
export type LargestKind = "payee" | "unnamed" | "ambiguous" | "by_hand" | "no_bank_text";
export interface Largest {
  /** A payee's name, or the bank's text for a group not named yet. Untrusted: it is cut short and made
   * plain before it is put in a sentence. */
  readonly name: string;
  /** What it took, net: an entry that was reversed in the month and its reversal add up to nothing. */
  readonly amount: string;
  readonly kind: LargestKind;
}

/** A catch-all account the book marks (Other expenses, Other income) and what it took in the month being
 * checked. The figures are null when they could not be read, and `reason` says why. */
export interface CatchAllFacts {
  readonly account: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly role: "expense" | "income";
  };
  readonly month: {
    /** What the account took in the month, on its own side: spent for an expense account, received for an
     * income account. */
    readonly amount: string;
    /** How many entries are in it at the end of the month: an entry that was reversed by then, and its
     * reversal, are not counted, as they add up to nothing. */
    readonly transactions: number;
    readonly largest: readonly Largest[];
  } | null;
  readonly reason?: string;
}

export interface ChecklistFacts {
  readonly today: string;
  readonly cutover: { readonly date: string; readonly basis: "recorded" | "opening_entry" } | null;
  readonly opening: "none" | "planned" | "posted" | "reversed";
  /** All periods in date order; null when they could not be read. */
  readonly periods: readonly PeriodFacts[] | null;
  /** The period being checked, chosen by `choosePeriod`. */
  readonly period: PeriodFacts | null;
  /** Null when reconciliation could not be read. */
  readonly accounts: readonly AccountFacts[] | null;
  readonly otherAccounts: readonly OtherAccountFacts[];
  readonly inbox: InboxFacts;
  /** Stripe's control, or null when the business does not use Stripe (or it could not be read, in
   * which case `unavailable` says so). */
  readonly stripe: StripeFacts | null;
  readonly backups: BackupFacts;
  readonly unavailable: readonly { readonly section: Section; readonly reason: string }[];
  /** The catch-all accounts the book marks, with what each took in the period. Absent or empty when the
   * book marks none: it then watches nothing, and says nothing. */
  readonly catchAll?: readonly CatchAllFacts[];
}

/** An observation about the period that is not a reason to wait: money collecting in a catch-all account.
 * A note never changes the verdict and never blocks a close; leaving money in "Other expenses" is a choice
 * a business may make. */
export interface Note {
  /** `catchall_holds_money`, or `catchall_not_checked` when the account's figures could not be read. */
  readonly code: "catchall_holds_money" | "catchall_not_checked";
  readonly message: string;
  readonly account: CatchAllFacts["account"];
  /** The period's dates, so a screen can link to the transactions. Present with the figures. */
  readonly from?: string;
  readonly to?: string;
  readonly amount?: string;
  readonly transactions?: number;
  readonly largest?: readonly Largest[];
}

export interface AccountResult {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly kind: AccountKind;
  readonly reason: AccountReason;
  readonly bookBalance: string;
  readonly hasActivity: boolean;
  readonly lastReconciliation: {
    readonly date: string;
    readonly balance: string;
    readonly closedAtZero: boolean;
  } | null;
  readonly throughPeriodEnd: boolean;
  readonly draft: AccountFacts["draft"];
  readonly unreconciled: AccountFacts["waiting"];
  readonly uncleared: AccountFacts["uncleared"];
  readonly status: AccountStatus;
  readonly reasons: readonly Reason[];
}

export interface StripeResult extends Omit<StripeFacts, "payouts"> {
  readonly payouts: StripeFacts["payouts"] & {
    readonly overdue: number;
    readonly oldestOverdueOn: string | null;
  };
  readonly status: "ready" | "attention" | "blocked";
  readonly reasons: readonly Reason[];
}

export interface ShadowRun {
  readonly required: number;
  readonly provenCount: number;
  readonly provenThrough: string | null;
  readonly complete: boolean;
  readonly months: readonly {
    readonly periodId: string;
    readonly label: string;
    readonly endsOn: string;
    readonly closed: boolean;
    readonly proven: boolean;
  }[];
}

export interface ChecklistResult {
  readonly period: PeriodFacts | null;
  readonly verdict: {
    readonly state: VerdictState;
    readonly summary: string;
    readonly blocking: readonly Reason[];
    readonly attention: readonly Reason[];
  };
  readonly accounts: readonly AccountResult[];
  readonly stripe: StripeResult | null;
  readonly openPeriods: readonly PeriodFacts[];
  readonly shadowRun: ShadowRun | null;
  /** Observations that are not reasons to wait; none when nothing is marked or nothing is there. */
  readonly notes: readonly Note[];
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** The period to check: the one asked for, or the earliest open period that ends on or after the
 * cutover date. A period that ended before the cutover holds nothing to prove. Null when every
 * period is closed (or the one asked for does not exist). */
export function choosePeriod(
  periods: readonly PeriodFacts[],
  cutoverDate: string | null,
  requestedId?: string,
): PeriodFacts | null {
  if (requestedId !== undefined) return periods.find((period) => period.id === requestedId) ?? null;
  return (
    periods.find(
      (period) =>
        period.status === "open" &&
        period.beforeBooks !== true &&
        (cutoverDate === null || period.endsOn >= cutoverDate),
    ) ?? null
  );
}

/** Whether Stripe holds money Rastrata has not imported: the difference is exact, never within a
 * tolerance. Not compared is not a difference; it is its own reason. */
export function stripeDiffers(stripe: StripeFacts): boolean {
  if (!stripe.compared || stripe.difference === null || !isMoney(stripe.difference)) return false;
  return compareMoney(stripe.difference, "0.00") !== 0;
}

/** Stripe's own checks. Stripe has no bank statement to reconcile to; its evidence is that its
 * balance holds nothing Rastrata has not imported, and that every payout adds up to its
 * transactions. The control compares Stripe's balance now, not at a month end, so it says nothing
 * about a past month except that nothing is missing. */
export function evaluateStripe(stripe: StripeFacts): {
  readonly result: StripeResult;
  readonly blocking: readonly Reason[];
  readonly attention: readonly Reason[];
} {
  const blocking: Reason[] = [];
  const attention: Reason[] = [];
  const note = (list: Reason[], code: string, message: string) =>
    list.push({ code, section: "stripe", message });
  if (!stripe.compared)
    note(
      blocking,
      "stripe_not_compared",
      "Stripe's own balance has not been compared with your books. Run a Stripe sync to read it.",
    );
  else if (stripeDiffers(stripe))
    note(
      blocking,
      "stripe_differs",
      `Stripe holds ${stripe.difference} that has not been imported. ${stripe.explanation}`.trim(),
    );
  else if (stripe.stale)
    note(
      attention,
      "stripe_stale",
      `Stripe's balance was last compared at ${stripe.readAt ?? "an unknown time"}. Sync again to refresh it.`,
    );
  const { mismatched, waiting, held, unmatched } = stripe.payouts;
  if (mismatched > 0)
    note(
      blocking,
      "stripe_payouts_mismatched",
      `${mismatched} Stripe ${plural(mismatched, "payout does", "payouts do")} not add up to ${plural(mismatched, "its", "their")} transactions.`,
    );
  if (waiting > 0)
    note(
      attention,
      "stripe_payouts_waiting",
      `${waiting} Stripe ${plural(waiting, "payout is", "payouts are")} waiting for Stripe to finish itemising ${plural(waiting, "it", "them")}. Sync again later.`,
    );
  if (held > 0)
    note(
      attention,
      "stripe_payouts_held",
      `${held} Stripe ${plural(held, "payout is", "payouts are")} held for a person to categorise: ${plural(held, "it is", "they are")} in the Inbox.`,
    );
  // A payout sent in the last day or two has no deposit yet, and that is normal. One whose arrival
  // date and matching window have passed should have arrived: it is said, not excused.
  const overdue = Math.min(unmatched, stripe.payouts.overdue ?? 0);
  const recent = unmatched - overdue;
  if (recent > 0)
    note(
      attention,
      "stripe_deposits_unmatched",
      `${recent} booked Stripe ${plural(recent, "payout has", "payouts have")} no matched bank deposit yet${stripe.inTransit ? ` (${stripe.inTransit} in transit)` : ""}. That is normal for a payout sent in the last day or two.`,
    );
  if (overdue > 0)
    note(
      attention,
      "stripe_deposits_overdue",
      `${overdue} booked Stripe ${plural(overdue, "payout was", "payouts were")} due at the bank${stripe.payouts.oldestOverdueOn ? ` (the oldest on ${stripe.payouts.oldestOverdueOn})` : ""} and ${plural(overdue, "has", "have")} no matched bank deposit. That is not normal for a payout that old: import the bank statement that covers ${plural(overdue, "its date", "those dates")}, or look in the bank for the deposit.`,
    );
  return {
    result: {
      ...stripe,
      payouts: {
        ...stripe.payouts,
        overdue: stripe.payouts.overdue ?? 0,
        oldestOverdueOn: stripe.payouts.oldestOverdueOn ?? null,
      },
      status: blocking.length > 0 ? "blocked" : attention.length > 0 ? "attention" : "ready",
      reasons: [...blocking, ...attention],
    },
    blocking,
    attention,
  };
}

/** The places the money of a catch-all account went, largest first, as many as `limit`: only those that
 * took money (an amount above zero), by amount, then by name so that two of one size are always in the
 * same order. Money is exact; nothing is rounded or compared within a tolerance. */
export function largestOf(candidates: readonly Largest[], limit = 3): Largest[] {
  return candidates
    .filter((item) => isMoney(item.amount) && parseMoney(item.amount) > 0n)
    .sort((left, right) => {
      const difference = parseMoney(right.amount) - parseMoney(left.amount);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })
    .slice(0, limit);
}

/** A list in a sentence: "a", "a and b", "a, b and c". */
const sentenceList = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** What to say of the catch-all accounts the book marks, for the period being checked. A marked account
 * that took money in the period is one note, with the largest places it went; one that took nothing says
 * nothing; one whose figures could not be read says that it could not be checked, because a check that did
 * not run is never a pass. No period (every one is closed) and no marked account give no notes. */
export function catchAllNotes(
  catchAll: readonly CatchAllFacts[],
  period: PeriodFacts | null,
): Note[] {
  if (period === null) return [];
  const notes: Note[] = [];
  for (const item of catchAll) {
    const name = `${item.account.code} ${sanitizeText(item.account.name, 60)}`;
    if (item.month === null) {
      notes.push({
        code: "catchall_not_checked",
        message: `${name} is marked as a catch-all account, but what it took in ${period.label} could not be read${item.reason ? `: ${sanitizeText(item.reason, 200).replace(/\.+$/, "")}` : ""}. Until it can be, it is not known whether money is collecting there.`,
        account: item.account,
      });
      continue;
    }
    const { amount, transactions } = item.month;
    if (!isMoney(amount) || parseMoney(amount) === 0n) continue;
    const largest = item.month.largest.map(
      (place) => `${sanitizeText(place.name, 60)} (${place.amount})`,
    );
    const where = period.ended ? period.label : `${period.label} so far`;
    notes.push({
      code: "catchall_holds_money",
      message: `${name} holds ${amount} from ${transactions} ${plural(transactions, "transaction", "transactions")} in ${where}.${largest.length > 0 ? ` The largest ${plural(largest.length, "is", "are")} ${sentenceList(largest)}.` : ""} This does not hold up closing the month.`,
      account: item.account,
      from: period.startsOn,
      to: period.endsOn,
      amount,
      transactions,
      largest: item.month.largest.map((place) => ({
        ...place,
        name: sanitizeText(place.name, 60),
      })),
    });
  }
  return notes;
}

/** An account as a sentence names it. The name is the owner's (or an agent's) text, so it is cut
 * short and stripped of control and direction characters before it is put in a message. */
const label = (account: AccountFacts): string =>
  `${account.code} ${sanitizeText(account.name, 60)}`;

/** Whether the account has anything the checklist can ask about. With no period, any sign of life
 * counts. With one, what is proven to come after its end does not: an account whose first posting is
 * in October has nothing to reconcile through January, and January's checklist must not ask for it.
 * That proof is the oldest posting not on a reconciliation being dated after the end, with no
 * reconciliation, no draft dated by the end and nothing waiting in the Inbox through the end (that
 * count is already taken through the end). Everything else counts, a balance with no dated posting
 * behind it included: a missing fact is never a pass. */
function hasActivity(account: AccountFacts, period: PeriodFacts | null): boolean {
  const hasBalance = isMoney(account.bookBalance) && parseMoney(account.bookBalance) !== 0n;
  if (period === null)
    return (
      account.lastReconciliation !== null ||
      account.draft !== null ||
      account.uncleared.count > 0 ||
      hasBalance ||
      (account.waiting?.count ?? 0) > 0
    );
  const end = period.endsOn;
  const postingsAfter =
    account.uncleared.count > 0 &&
    account.uncleared.oldestOn !== null &&
    account.uncleared.oldestOn > end;
  return (
    account.lastReconciliation !== null ||
    (account.draft !== null && account.draft.statementDate <= end) ||
    (account.waiting?.count ?? 0) > 0 ||
    (!postingsAfter && (account.uncleared.count > 0 || hasBalance))
  );
}

interface Evaluated {
  readonly result: AccountResult;
  readonly blocking: readonly Reason[];
  readonly attention: readonly Reason[];
}

function evaluateAccount(account: AccountFacts, period: PeriodFacts | null): Evaluated {
  const active = hasActivity(account, period);
  const last = account.lastReconciliation;
  const through = period !== null && last !== null && last.date >= period.endsOn;
  const blocking: Reason[] = [];
  const attention: Reason[] = [];
  const base = {
    accountId: account.id,
    code: account.code,
    name: account.name,
    role: account.role,
    kind: account.kind,
    reason: account.reason,
    bookBalance: account.bookBalance,
    hasActivity: active,
    lastReconciliation: last ? { ...last, closedAtZero: true } : null,
    throughPeriodEnd: through,
    draft: account.draft,
    unreconciled: account.waiting,
    uncleared: account.uncleared,
  };
  if (!active)
    return { result: { ...base, status: "no_activity", reasons: [] }, blocking, attention };
  const note = (list: Reason[], code: string, section: Section, message: string) =>
    list.push({ code, section, message, accountId: account.id });
  if (period !== null && !through) {
    const draft = account.draft
      ? ` A draft for ${account.draft.statementDate} is open with a difference of ${account.draft.difference}.`
      : "";
    if (last === null)
      note(
        blocking,
        "never_reconciled",
        "accounts",
        `${label(account)} has not been reconciled to a statement yet.${draft}`,
      );
    else
      note(
        blocking,
        "not_through_period",
        "accounts",
        `${label(account)} is reconciled through ${last.date}. Reconcile a statement dated on or after ${period.endsOn}.${draft}`,
      );
  }
  if (account.waiting && account.waiting.count > 0)
    note(
      blocking,
      "inbox_waiting",
      "inbox",
      `${account.waiting.count} Inbox ${plural(account.waiting.count, "line", "lines")} for ${label(account)}${period ? ` dated through ${period.endsOn}` : ""} still ${plural(account.waiting.count, "needs", "need")} a decision or a posting${account.waiting.oldestOn ? ` (oldest ${account.waiting.oldestOn})` : ""}.`,
    );
  if (
    last !== null &&
    account.uncleared.oldestOn !== null &&
    account.uncleared.oldestOn <= last.date
  )
    note(
      attention,
      "uncleared_before_statement",
      "accounts",
      `${label(account)} has postings dated as early as ${account.uncleared.oldestOn} that are not on a reconciliation, though it is reconciled through ${last.date}. They are fine only if they are outstanding, such as a check not yet cashed.`,
    );
  return {
    result: {
      ...base,
      status: blocking.length > 0 ? "blocked" : attention.length > 0 ? "attention" : "ready",
      reasons: [...blocking, ...attention],
    },
    blocking,
    attention,
  };
}

/** The verdict and everything the screen shows, from the facts. */
export function evaluateChecklist(facts: ChecklistFacts): ChecklistResult {
  const period = facts.period;
  const evaluated = (facts.accounts ?? []).map((account) => evaluateAccount(account, period));
  const accounts = evaluated.map((item) => item.result);
  const stripe = facts.stripe ? evaluateStripe(facts.stripe) : null;
  const blocking: Reason[] = [];
  const attention: Reason[] = [];

  for (const gap of facts.unavailable)
    blocking.push({
      code: "section_unavailable",
      section: gap.section,
      message: `${gap.reason} Until it can be read, the month cannot be called ready.`,
    });

  if (period !== null && period.status === "open" && !period.ended)
    blocking.push({
      code: "period_not_ended",
      section: "periods",
      message: `${period.label} ends on ${period.endsOn}; it cannot close before then.`,
    });

  // Until the period has ended there is nothing to prove yet: the one reason is the date.
  if (period === null || period.ended || period.status === "closed") {
    // Each account's reasons are in its row. The verdict lists them too, except the Inbox ones:
    // those are one line below, counted across every account.
    for (const item of evaluated) {
      blocking.push(...item.blocking.filter((reason) => reason.code !== "inbox_waiting"));
      attention.push(...item.attention);
    }
    if (stripe) {
      blocking.push(...stripe.blocking);
      attention.push(...stripe.attention);
    }
    if (facts.inbox.available && facts.inbox.waiting > 0)
      blocking.push({
        code: "inbox_waiting",
        section: "inbox",
        message: `${facts.inbox.waiting} Inbox ${plural(facts.inbox.waiting, "line", "lines")}${period ? ` dated through ${period.endsOn}` : ""} still ${plural(facts.inbox.waiting, "needs", "need")} a decision or a posting${facts.inbox.oldestOn ? ` (oldest ${facts.inbox.oldestOn})` : ""}.`,
      });
    if (facts.cutover?.basis === "recorded" && facts.opening !== "posted")
      blocking.push({
        code: "opening_not_posted",
        section: "opening",
        message:
          facts.opening === "planned"
            ? "The opening entry is planned but not posted. Post it so the books start from your real balances."
            : facts.opening === "reversed"
              ? "The opening entry was reversed. Plan and post a new one so the books start from your real balances."
              : "The opening balances have not been posted. Post them so the books start from your real balances.",
      });
    const backups = facts.backups;
    if (backups.keptByService) {
      // A hosted workspace: the history of the books is the service's to keep, and a person has no backup to verify, so the month is not held up by one.
    } else if (!backups.available)
      blocking.push({
        code: "backups_unavailable",
        section: "backups",
        message: `${backups.reason ?? "The backups could not be checked."} Until they can be read, the month cannot be called ready.`,
      });
    else {
      if (backups.verifiedAt === null)
        blocking.push({
          code: "no_verified_backup",
          section: "backups",
          message:
            "No backup of your books has been verified. Back up and verify before closing a month.",
        });
      else if (backups.ageHours !== null && backups.ageHours > backups.limitHours)
        blocking.push({
          code: "backup_too_old",
          section: "backups",
          message: `The newest verified backup is ${backups.ageHours} hours old; the limit is ${backups.limitHours}. Back up and verify first.`,
        });
      if (backups.drill === null)
        attention.push({
          code: "drill_never_run",
          section: "backups",
          message:
            "A restore drill has not been run. It proves a backup restores to the same books.",
        });
      else if (!backups.drill.passed)
        blocking.push({
          code: "drill_failed",
          section: "backups",
          message: `The last restore drill (${backups.drill.ranAt.slice(0, 10)}) failed. A backup that does not restore is not a backup.`,
        });
    }
  }

  const periods = facts.periods ?? [];
  const cutoverDate = facts.cutover?.date ?? null;
  const openPeriods = periods.filter(
    (item) =>
      item.status === "open" &&
      item.beforeBooks !== true &&
      (cutoverDate === null || item.endsOn >= cutoverDate),
  );
  // Month ends closed and reconciled since the cutover.
  let shadowRun: ShadowRun | null = null;
  if (cutoverDate !== null && facts.periods !== null) {
    const active = accounts.filter((item) => item.hasActivity);
    const dates = active.map((item) => item.lastReconciliation?.date ?? null);
    const provenThrough =
      active.length > 0 && dates.every((item) => item !== null)
        ? (dates as string[]).reduce((a, b) => (a < b ? a : b))
        : null;
    const months = periods
      .filter(
        (item) =>
          item.beforeBooks !== true &&
          item.endsOn >= cutoverDate &&
          (item.ended || item.status === "closed"),
      )
      .map((item) => ({
        periodId: item.id,
        label: item.label,
        endsOn: item.endsOn,
        closed: item.status === "closed",
        proven: provenThrough !== null && provenThrough >= item.endsOn,
      }));
    const provenCount = months.filter((item) => item.closed && item.proven).length;
    shadowRun = {
      required: SHADOW_RUN_MONTHS,
      provenCount,
      provenThrough,
      complete: provenCount >= SHADOW_RUN_MONTHS,
      months,
    };
  }

  let state: VerdictState;
  let summary: string;
  if (period === null && facts.periods === null) {
    state = "not_yet";
    summary = "Not yet: the calendar could not be read, so no period can be checked.";
  } else if (period === null || period.status === "closed") {
    state = "nothing_to_close";
    summary =
      period === null
        ? "Every period of the calendar is closed. It grows when an entry is dated after it."
        : `${period.label} is already closed.`;
  } else if (blocking.length === 0) {
    state = "ready";
    summary = `Ready to close ${period.label}.${attention.length > 0 ? ` ${attention.length} ${plural(attention.length, "thing", "things")} to look at first.` : ""}`;
  } else {
    state = "not_yet";
    summary = `Not yet: ${blocking.length} ${plural(blocking.length, "thing stands", "things stand")} in the way of closing ${period.label}.`;
  }
  return {
    period,
    verdict: { state, summary, blocking, attention },
    accounts,
    stripe: stripe?.result ?? null,
    openPeriods,
    shadowRun,
    notes: catchAllNotes(facts.catchAll ?? [], period),
  };
}

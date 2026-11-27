/** The shapes the shadow lane's components take. They are plain data: the application maps what the
 * service says into them, and every amount is an exact decimal string with two places. Nothing in
 * this folder computes money; the parent passes the figures it has already checked. */

import type { ChecklistNoteView } from "../catchall/types";

export type AccountRole =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense"
  | "gain"
  | "unrealizedGain";

/** One account of the balances table. `value` is what the person typed; `debit` and `credit` are
 * what it means as an entry line, worked out by the parent, empty when there is nothing to show. */
export interface BalanceRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: AccountRole;
  readonly value: string;
  readonly debit: string;
  readonly credit: string;
  /** Why the typed amount cannot be used. */
  readonly error?: string;
}

/** A group of rows in the balances table. A section may be collapsed (the optional income and
 * expense accounts), and then its rows are not shown. */
export interface BalanceSection {
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  readonly rows: readonly BalanceRow[];
  readonly collapsible?: boolean;
  readonly collapsed?: boolean;
}

export interface OffsetView {
  readonly code: string;
  readonly name: string;
  /** "none" while the balances need no offset or none can be worked out yet. */
  readonly side: "debit" | "credit" | "none";
  readonly amount: string;
}

export interface TotalsView {
  readonly debit: string;
  readonly credit: string;
}

export type IssueSeverity = "error" | "warning" | "info";

export interface IssueView {
  readonly severity: IssueSeverity;
  readonly message: string;
  readonly code?: string;
  readonly row?: number;
  /** The id of the balance input this problem is about, when the table has one. */
  readonly accountId?: string;
}

/** One line of a reviewed entry. */
export interface EntryLineView {
  readonly code: string;
  readonly name: string;
  readonly debit: string;
  readonly credit: string;
  /** The line is the calculated offset. */
  readonly offset?: boolean;
  readonly row?: number;
}

export interface EntryView {
  readonly date: string;
  readonly currency: string;
  readonly lines: readonly EntryLineView[];
  readonly debit: string;
  readonly credit: string;
  readonly balanced: boolean;
}

export type CutoverAction =
  | "unchanged"
  | "set"
  | "move_later"
  | "move_earlier"
  | "create"
  | "managed"
  | "unmapped";

export interface SourceView {
  readonly key: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly account: string | null;
  readonly startOn: string | null;
  readonly after: string | null;
  readonly action: CutoverAction;
  readonly excluded: number;
  readonly wouldExclude: number;
  readonly wouldRestore: number;
  readonly note?: string;
}

export interface StatementAccountView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: "bank" | "card" | "stripe";
  readonly chosen: boolean;
  /** Why it is suggested, in words; empty when nothing suggests it. */
  readonly suggested: string;
  readonly selectable: boolean;
}

export type OpeningStatus = "none" | "planned" | "posted" | "reversed";

export type ReasonSection =
  | "accounts"
  | "inbox"
  | "stripe"
  | "backups"
  | "periods"
  | "opening"
  | "cutover";

export interface ReasonView {
  readonly code: string;
  readonly section: ReasonSection;
  readonly message: string;
  readonly accountId?: string;
}

export type VerdictState = "ready" | "not_yet" | "nothing_to_close";

export interface VerdictView {
  readonly state: VerdictState;
  readonly summary: string;
  readonly blocking: readonly ReasonView[];
  readonly attention: readonly ReasonView[];
}

export type AccountStatus = "ready" | "attention" | "blocked" | "no_activity";

export interface ChecklistAccountView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: "bank" | "card";
  readonly status: AccountStatus;
  readonly bookBalance: string;
  /** The newest completed reconciliation. Always closed at 0.00: the service refuses otherwise. */
  readonly last: { readonly date: string; readonly balance: string } | null;
  readonly throughPeriodEnd: boolean;
  readonly draft: {
    readonly href: string | null;
    readonly statementDate: string;
    readonly difference: string;
  } | null;
  /** Inbox lines through the period end that wait; null when the Inbox was not read. */
  readonly waiting: { readonly count: number; readonly oldestOn: string | null } | null;
  readonly uncleared: {
    readonly count: number;
    readonly total: string;
    readonly oldestOn: string | null;
  };
  readonly reasons: readonly ReasonView[];
  /** Where to reconcile this account. */
  readonly reconcileHref?: string;
}

export interface PeriodView {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: "open" | "closed";
  readonly ended: boolean;
}

export interface StripeView {
  readonly status: "ready" | "attention" | "blocked";
  readonly compared: boolean;
  readonly ties: boolean;
  readonly difference: string | null;
  readonly unpaid: string | null;
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
  };
  readonly reasons: readonly ReasonView[];
}

export interface BackupsView {
  readonly available: boolean;
  /** The service keeps the history of the books itself (a hosted workspace): there is no backup to verify, and the section says so instead of saying that they could not be read. */
  readonly keptByService?: boolean;
  readonly reason: string | null;
  readonly verifiedAt: string | null;
  readonly ageHours: number | null;
  readonly limitHours: number;
  readonly drill: { readonly ranAt: string; readonly passed: boolean } | null;
}

export interface InboxView {
  readonly available: boolean;
  readonly waiting: number;
  readonly oldestOn: string | null;
  readonly toReview: number;
}

export interface ShadowRunView {
  readonly required: number;
  readonly provenCount: number;
  readonly provenThrough: string | null;
  readonly complete: boolean;
  readonly months: readonly {
    readonly id: string;
    readonly label: string;
    readonly endsOn: string;
    readonly closed: boolean;
    readonly proven: boolean;
  }[];
}

export interface OtherAccountView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: "asset" | "liability";
  readonly balance: string;
}

export interface ChecklistView {
  readonly asOf: string;
  readonly currency: string;
  readonly cutover: { readonly date: string; readonly basis: "recorded" | "opening_entry" } | null;
  readonly opening: OpeningStatus;
  readonly period: PeriodView | null;
  readonly verdict: VerdictView;
  readonly accounts: readonly ChecklistAccountView[];
  readonly otherAccounts: readonly OtherAccountView[];
  readonly stripe: StripeView | null;
  readonly inbox: InboxView;
  readonly backups: BackupsView;
  readonly openPeriods: readonly PeriodView[];
  readonly shadowRun: ShadowRunView | null;
  readonly unavailable: readonly { readonly section: ReasonSection; readonly reason: string }[];
  /** What the month holds that is good to know and never holds up a close: money collecting in an account the
   * book keeps for what fits nowhere else. Left out by a service that does not make notes. */
  readonly notes?: readonly ChecklistNoteView[];
}

/** The summary the Home card shows. */
export interface ShadowCardSummary {
  readonly state: VerdictState | "start" | "opening";
  readonly summary: string;
  /** The most important thing in the way, in words. */
  readonly first: string | null;
  readonly attention: number;
  readonly shadowRun: { readonly provenCount: number; readonly required: number } | null;
}

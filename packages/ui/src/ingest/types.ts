/** What the Inbox components show. They mirror the application's shapes (the web route hands API
 * results straight in) but import nothing from it, so the components stay presentational and the
 * stories can run them over fictional lines. Money is always an exact decimal string with two places,
 * signed from the bank's view (negative is money out); the components never turn one into a number. */

import type { AccountOption as PickerAccount } from "../kit/accounts";

export type InboxStatus = "new" | "proposed" | "drafted" | "posted" | "excluded";
/** The views of the list that For review's page has: what waits for a decision, what is ready to post, and
 * what was set aside. (What is posted is in the books: the list of all transactions shows it.) */
export type InboxTab = "review" | "ready" | "excluded";

export interface InboxLineView {
  readonly kind: "bankLine" | "event";
  readonly provider: string;
  readonly accountKey: string;
  readonly providerId?: string;
  readonly rawIndex: number;
  readonly date: string;
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly counterparty?: string;
  readonly reference?: string;
  readonly runningBalance?: string;
  readonly legs?: readonly {
    readonly role: string;
    readonly amount: string;
    readonly memo?: string;
  }[];
  readonly links?: readonly { readonly key: string; readonly value: string }[];
}

export interface InboxSuggestionView {
  readonly proposalId: string;
  readonly proposer: string;
  readonly kind: "categorize" | "transfer" | "match" | "exclude" | "event";
  /** A whole percent. Kept for the terminal and the order of suggestions; the screen never shows it. */
  readonly confidence: number;
  /** One full sentence: why this was suggested. */
  readonly reason: string;
  /** What accepting it would book: the legs of the proposal, the line's own account among them. */
  readonly legs?: readonly InboxLegView[];
}

/** One side of an entry: an account and an amount, signed as the ledger carries it (a debit is
 * positive). */
export interface InboxLegView {
  readonly accountId: string;
  readonly amount: string;
}

export interface InboxItemView {
  readonly id: string;
  readonly status: InboxStatus;
  readonly line: InboxLineView;
  readonly ledgerAccountId: string | null;
  readonly batchId: string;
  readonly flags: readonly string[];
  readonly suggestion?: InboxSuggestionView;
  readonly proposalCount: number;
  readonly exclusion?: { readonly code: string; readonly reason: string; readonly at: string };
  readonly decision?: {
    readonly kind: string;
    readonly by: string;
    readonly principal?: string;
    readonly at: string;
    readonly narration?: string;
    readonly reason?: string;
    /** What was drafted or posted. */
    readonly legs?: readonly InboxLegView[];
  };
  readonly draftId?: string;
  readonly journalId?: string;
  readonly pairItemId?: string;
  readonly postError?: string;
  readonly coveredBy?: {
    readonly providerId: string;
    readonly itemId?: string;
    readonly status?: InboxStatus;
  };
  /** A posted line whose posting is on a completed reconciliation: which one, and the statement it
   * was checked against. Absent while it is on none. */
  readonly reconciled?: { readonly reconciliationId: string; readonly statementDate: string };
  readonly ingestedAt: string;
}

export interface InboxProposalView {
  readonly id: string;
  readonly proposer: string;
  readonly kind: "categorize" | "transfer" | "match" | "exclude" | "event";
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly legs?: readonly { readonly accountId: string; readonly amount: string }[];
  readonly matchJournalId?: string;
  readonly pairItemId?: string;
  readonly narration?: string;
}

export interface InboxProvenanceView {
  readonly batchId: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly rawIndex: number;
  readonly rawSha256: string;
  readonly rawName?: string;
  readonly rawMediaType: string;
  readonly rawSize: number;
  readonly fetchedAt: string;
  readonly submittedAt: string;
  readonly evidenceReference: string;
  readonly sourceEventId: string;
  readonly excerpt?: string;
}

export interface InboxDetailView {
  readonly item: InboxItemView;
  readonly proposals: readonly InboxProposalView[];
  readonly proposalProblems: readonly string[];
  readonly provenance: InboxProvenanceView;
  readonly draft?: { readonly id: string; readonly version: number; readonly status: string };
  readonly history: readonly {
    readonly at: string;
    readonly kind: string;
    readonly by: string;
    readonly reason?: string;
    readonly draftId?: string;
    readonly journalId?: string;
  }[];
  readonly coveredCount?: number;
}

export interface InboxCountsView {
  readonly total: number;
  readonly new: number;
  readonly proposed: number;
  readonly drafted: number;
  readonly posted: number;
  readonly excluded: number;
  readonly toReview: number;
  readonly covered?: number;
  /** Drafted lines that Post will post (a payout's lines are posted with the payout). */
  readonly postable?: number;
  readonly beforeCutover: number;
}

export interface InboxSourceView {
  readonly provider: string;
  readonly accountKey: string;
  readonly ledgerAccountId: string | null;
  readonly startOn: string | null;
  readonly counts: InboxCountsView;
  /** Bank lines are waiting and there is no chart account to book them to. */
  readonly needsAccount?: boolean;
}

/** A chart account a person can choose: what the kit's account picker takes (the name as `label`, the number
 * muted beside it, where it sits, whether it is closed) and its `role` (asset, liability, expense...), which
 * what an entry does to its balance and the accounts a provider account may be booked to depend on. */
export interface AccountOption extends PickerAccount {
  readonly role?: string | undefined;
}

export interface InboxFilterState {
  readonly text: string;
  /** The account the list is narrowed to: empty for every account, a chart account's id, or
   * "provider:stripe" for what came from Stripe. Chosen beside the search box. */
  readonly account: string;
  /** "provider\u0000accountKey": one provider account, from the Filter fold. Empty for every one. */
  readonly source: string;
  readonly from: string;
  readonly to: string;
  /** Only the lines one payout books, whatever has become of them: the provider id of the payout. Set from
   * a payout's detail. */
  readonly coveredBy: string;
  readonly sort: "date_desc" | "date_asc" | "amount_desc" | "amount_asc" | "confidence_desc";
}

export const emptyFilters: InboxFilterState = {
  text: "",
  account: "",
  source: "",
  from: "",
  to: "",
  coveredBy: "",
  sort: "date_desc",
};

/** Who an action applies to: the lines ticked on the page, or every line matching the filter. */
export type InboxTarget =
  | { readonly kind: "items"; readonly ids: readonly string[] }
  | { readonly kind: "matching"; readonly count: number };

export interface InboxSplitInput {
  readonly accountId: string;
  readonly amount: string;
}

export interface InboxActions {
  /** `allowDuplicate` says a transaction that is already in the books really is a second payment.
   * `suggestionsOnly` makes "all matching" mean the transactions that have a suggestion (the ones
   * "Accept N suggested" counted). `chosen` is the category a person chose on a transaction's own row, by
   * the transaction's id: each of those is recorded with that category and the rest of the target with its
   * suggestion, so a row is always booked as it reads. Every transaction named in `chosen` belongs to the
   * target. */
  accept(
    target: InboxTarget,
    proposalId?: string,
    options?: {
      readonly allowDuplicate?: boolean;
      readonly suggestionsOnly?: boolean;
      readonly chosen?: ReadonlyMap<string, string>;
    },
  ): void;
  categorize(
    target: InboxTarget,
    choice: {
      readonly accountId?: string;
      readonly splits?: readonly InboxSplitInput[];
      readonly narration?: string;
      readonly allowDuplicate?: boolean;
    },
  ): void;
  exclude(target: InboxTarget, reason: string): void;
  restore(target: InboxTarget, reason: string): void;
  post(target: InboxTarget): void;
  /** Stop a long action between calls. What was done stays done. */
  stop(): void;
}

/** What an action did, said as a notice. `attention` is a person's decision (some could not be done),
 * `problem` is a failure; the old names `review` and `error` are the same two. */
export interface InboxActionNote {
  readonly tone: "info" | "calm" | "attention" | "problem" | "review" | "error";
  readonly title: string;
  readonly lines: readonly string[];
}

/** What accepting a suggestion does: post it to the books, or save it as a draft in Ready to post. */
export type AcceptMode = "post" | "draft";

export interface InboxProgress {
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

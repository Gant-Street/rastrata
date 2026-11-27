/** What the control plane and a pod say to each other about bank connections (docs/reference/program/hosting/bankfeed-stripe.md): the shapes and the sizes, and
 * nothing else, so that the Worker that makes the call and the pod that answers it import one definition and cannot disagree about a limit. The control plane holds
 * the Stripe key and reads the transactions; the pod decides what becomes of them. */

/** The kinds of account a bank connection brings. Stripe's `subcategory`, with the ones the product does not tell apart folded into `other`. */
export const BANK_KINDS = [
  "checking",
  "savings",
  "credit_card",
  "line_of_credit",
  "mortgage",
  "other",
] as const;
export type BankKind = (typeof BANK_KINDS)[number];

/** Whether the connection to the bank works: `active`, `inactive` (the bank no longer lets Stripe read it: the owner has to sign in to the bank again) or
 * `disconnected` (stopped on purpose, by the owner or because the workspace is going). */
export const BANK_STATES = ["active", "inactive", "disconnected"] as const;
export type BankState = (typeof BANK_STATES)[number];

export const BANK_WIRE = {
  /** Transactions in one `banks.receive` call; a longer list is sent as several, and the last one's refresh is the one that counts. */
  transactionsPerCall: 100,
  /** Accounts in one `banks.offer` call. */
  accountsPerOffer: 25,
  /** The longest a bank's or an account's name is kept, and the longest a description. */
  nameLength: 120,
  descriptionLength: 500,
  /** The identifiers Stripe makes (`fca_…`, `fctxn_…`, `fctxnref_…`). */
  idPattern: "^[A-Za-z0-9_]{3,64}$",
} as const;

/** An account the bank connection brought, as the pod is told of it. */
export interface BankAccountOffer {
  /** Stripe's identifier of the account (`fca_…`); to the pod it is only a name that is the same every time. */
  readonly id: string;
  readonly institution: string;
  readonly name: string;
  readonly last4: string | null;
  readonly kind: BankKind;
  readonly state: BankState;
}

/** A transaction as Stripe reported it, with the amount in the smallest unit of its currency (cents). Nothing here has been interpreted. */
export interface BankTransaction {
  readonly id: string;
  /** Negative is money leaving the account. */
  readonly amount: number;
  readonly currency: string;
  readonly description: string;
  readonly status: "pending" | "posted" | "void";
  /** Seconds since the epoch. */
  readonly transactedAt: number;
  readonly postedAt: number | null;
  readonly updated: number;
}

export interface BankOfferInput {
  readonly accounts: readonly BankAccountOffer[];
}

export interface BankOfferResult {
  /** The accounts the pod now knows, and for each whether it is booked to a chart account. */
  readonly accounts: readonly { readonly id: string; readonly booked: boolean }[];
}

export interface BankReceiveInput {
  readonly account: BankAccountOffer;
  /** The transaction refresh these transactions were read after (Stripe's `fctxnref_…`): how far the account has been read. */
  readonly refresh: string;
  readonly transactions: readonly BankTransaction[];
}

export interface BankReceiveResult {
  /** Whether the account is booked to a chart account. If it is not, nothing was queued, and the sender keeps its place and sends the same transactions again once it is. */
  readonly booked: boolean;
  readonly received: number;
  /** Lines queued in the Inbox for review. */
  readonly queued: number;
  readonly duplicates: number;
  /** Pending and voided transactions, which are not imported until the bank has posted them. */
  readonly pending: number;
  /** Transactions that could not be read exactly and were not imported. */
  readonly held: number;
}

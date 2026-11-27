/** The shapes the catch-all components take. They are plain data: the application maps what the service says
 * into them, and every amount is an exact decimal string with two places. Nothing in this folder computes
 * money or reads the book. */

/** Where the money of a catch-all account went, as the checklist says it. */
export type PlaceKind = "payee" | "unnamed" | "ambiguous" | "by_hand" | "no_bank_text";

/** One note the month checklist makes about an account the book keeps for what fits nowhere else. */
export interface ChecklistNoteView {
  /** `catchall_holds_money`: the account took money in the period. `catchall_not_checked`: it is marked
   * and what it took could not be read, so whether money is collecting there is not known. */
  readonly code: "catchall_holds_money" | "catchall_not_checked";
  readonly account: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly role: "expense" | "income";
  };
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly amount?: string | undefined;
  readonly transactions?: number | undefined;
  readonly largest: readonly {
    readonly name: string;
    readonly amount: string;
    readonly kind: PlaceKind;
  }[];
}

/** One note on a month of Close the books, ready to show. */
export interface CloseNote {
  readonly id: string;
  readonly state: "found" | "not_checked";
  /** The account, by name: text the owner or a template wrote. */
  readonly accountName: string;
  /** A short heading: "Money is collecting in Other expenses". */
  readonly title: string;
  /** The sentence: how much, from how many transactions, in which month. */
  readonly text: string;
  /** The largest places the money went, largest first. Names are text from a bank or the owner. */
  readonly largest: readonly {
    readonly name: string;
    readonly amount: string;
    readonly kind: PlaceKind;
  }[];
  /** Where the transactions are listed, filtered to the account and the month. */
  readonly href?: string | undefined;
}

/** What a transaction in a plan, or in what was done, comes to. */
export type MoveOutcome = "would_apply" | "applied" | "skipped" | "failed";

/** One transaction of a change of account, as the dialog shows it. */
export interface MoveRow {
  /** The key of the row: the entry's id. */
  readonly id: string;
  readonly outcome: MoveOutcome;
  readonly date?: string | undefined;
  /** What the bank wrote, short and plain. Untrusted text: shown as text, never as markup. */
  readonly description: string;
  readonly amount?: string | undefined;
  /** The account it is on and the account it goes to, by name. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Why it was skipped or could not be done, in the service's words. */
  readonly why?: string | undefined;
  /** What a person should know before it is moved (a finished reconciliation). */
  readonly warnings: readonly string[];
  /** After a step that failed past the first: where the transaction was left. */
  readonly left?: "review" | "ready" | undefined;
}

/** How far a change of account has got. */
export type ChangeAccountStage = "choose" | "planning" | "review" | "working" | "done" | "failed";

/** What a bank tile shows, as plain types: no components, so the web application's code and its unit
 * tests can build tiles without loading any markup (`@rastrata/ui/banking/types`). */

/** One bank account, credit card or Stripe account, as the tiles show it: what the books hold, what
 * the bank (or a statement) says, and what is waiting. Money is the wire amount (two places, signed
 * from the account's own side: a card that owes 1,250.00 is "-1250.00"), never a number. */
export interface BankTileData {
  /** The chart account. For Stripe: the account that holds Stripe's balance, or "" when the chart has none. */
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: "bank" | "card" | "stripe";
  /** What the books hold, or null when there is no account in the books to ask (Stripe, not set up). */
  readonly bookBalance: string | null;
  /** The newest balance an outside party reported: a statement file, the bank's feed or a
   * reconciled statement. Absent when none has been seen. */
  readonly statementBalance?: string;
  /** A date, or an instant (Stripe reads its balance at a moment): show it with `formatDate`. */
  readonly statementAsOf?: string;
  readonly statementSource?: "statement" | "feed" | "reconciliation";
  /** Transactions waiting for a person (For review), across every source that feeds the account. */
  readonly toReview: number;
  /** A statement or a feed has brought transactions for this account. Without it "nothing to
   * review" would be a claim about an account nobody has imported. */
  readonly imported: boolean;
  readonly lastReconciled?: { readonly date: string; readonly balance: string };
  readonly connection?: {
    readonly kind: "feed" | "stripe";
    /** `setup`: Stripe has a key that works, and its accounts are not chosen yet. It is the next step, not
     * a fault, so the tile names the step and does not say the connection needs attention. */
    readonly state: "connected" | "attention" | "not_connected" | "setup";
    /** When it last read, as an instant. */
    readonly syncedAt?: string;
  };
}

/** Where a tile goes. The route supplies them, so the component knows no addresses. */
export interface BankTileLinks {
  /** The account's own page: what a tile opens. */
  open(tile: BankTileData): string;
  /** The page that connects Stripe, or finishes setting it up. */
  connect(tile: BankTileData): string;
}

/** One account the list of transactions for review can be narrowed to: a bank or card account, or Stripe.
 * The list's select names "All accounts" itself. */
export interface AccountChoiceItem {
  /** What the list is filtered by: the chart account's id, or "provider:stripe" for what Stripe reported. */
  readonly key: string;
  readonly label: string;
}

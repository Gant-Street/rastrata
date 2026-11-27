/** The words the bank tiles own. A tile says what the books hold, what the bank says when that is
 * something else, and how many transactions wait; it never says a thing it does not know. Names and
 * balances are data and are never in this file. */

export const tileWords = {
  sectionLabel: "Bank and card accounts",

  notConnected: "Not connected",

  // The one line under the balance: who said the other figure (the figure follows), and what waits.
  bankSays: "Bank says",
  stripeSays: "Stripe says",
  toReview: (count: string) => `${count} to review`,
  /** On the Accounts page the other figure says when it was said: "Bank says 5,411.40 as of Oct 29, 2026". */
  asOf: "as of",

  // The one thing to do on a bank or card account's row of the Accounts page.
  reconcile: "Reconcile",
  reconcileLabel: (name: string) => `Reconcile ${name}`,

  // Stripe's ways in, where it is not connected or not set up yet: the tile's one link.
  connectStripe: "Connect Stripe",
  finishStripeSetup: "Finish setting up Stripe",

  connectionAttention: "The connection needs attention",

  // Whole-band states.
  loading: "Checking your accounts…",
  stale: "These figures may be out of date: the last read did not finish.",
  failedTitle: "Your accounts could not be read",
  failedBody: "Nothing in your books has changed.",
  retry: "Try again",
} as const;

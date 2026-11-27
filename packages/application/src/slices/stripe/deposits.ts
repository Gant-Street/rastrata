import type { ApplicationService } from "../../service.ts";
import { matchWindow, planForBook } from "./matching.ts";
import { type PayoutRow, stripeStore } from "./store.ts";

export type DepositState = "matched" | "unmatched" | "reversed" | "unchecked";

/** Where a payout's bank deposit stands. A payout Stripe returned has no deposit to expect, and one
 * held for a person is matched by hand, so neither is counted as missing its deposit. */
export function depositOf(payout: PayoutRow, matched: ReadonlySet<string>): DepositState {
  if (payout.reversed) return "reversed";
  if (payout.booking === "held") return "unchecked";
  return matched.has(payout.id) ? "matched" : "unmatched";
}

/** Which Stripe payouts a bank deposit has been matched to. A payout is matched when its deposit has
 * been accepted so that it clears Payouts in transit (drafted or posted): either from the Stripe
 * proposer's suggestion, which names the payout in its links and which the Inbox keeps on the
 * decision, or by hand, in which case the payout is the one the deposit pairs with (see
 * `planMatching`: every payout and deposit of the same amount are paired together, one to one, the
 * closest dates first). A deposit that is only suggested is not a match, and one that was set aside
 * (excluded), booked elsewhere or restored to review no longer counts.
 *
 * It reads the Inbox's own table with one query, so a payout list of any size costs one read. */
export function matchedPayouts(service: ApplicationService): ReadonlySet<string> {
  return planForBook(service, stripeStore(service).payouts(), matchWindow(service)).settled;
}

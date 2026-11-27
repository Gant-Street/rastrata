/** The founder's synthetic month, for the agent evaluations (apps/mcp/tooling/evaluation/cli-path).
 *
 * The evaluations grade an agent against the same world the acceptance test books: the statements,
 * the stand-in Stripe, and the oracle that computes every expected figure in integer cents from the
 * rows. They reach it through this one entry point (`@rastrata/application/testing/evaluation-fixtures`)
 * so the dependency rules still hold: nothing else in `test/` is a public file, and nothing under
 * `src/` imports from here. Everything is synthetic; nothing here is a real name, number or key. */
export {
  APRIL,
  APRIL_FILE,
  BANK_AND_CARD,
  CARD,
  CASH_CODES,
  CHASE,
  CUTOVER,
  HOSTILE,
  MONTH,
  OPENING,
  RENAMED,
  STRIPE_ACCOUNT,
  aprilFileOpening,
  booked,
  cardCsv,
  cents,
  chaseCsv,
  closing,
  dec,
  expectedLedger,
  openingLedger,
  payoutEntries,
  profitLoss,
  rhoCsv,
  rhoRows,
} from "./acceptance/month.ts";
export type { Dest, Figures, How, Ledger, PayoutEntry, Row } from "./acceptance/month.ts";
export { fakeStripe } from "./stripe/fake-stripe.ts";
export type { FakeStripe } from "./stripe/fake-stripe.ts";
export { buildScenario, fakeKey } from "./stripe/fixtures.ts";
export type { Entry, Scenario } from "./stripe/fixtures.ts";

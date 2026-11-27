import { ApplicationError } from "../../errors.ts";
import type { StripeMode, StripeStore } from "./store.ts";

/** Test data and real data are never in the same books. Stripe has two modes, live (real sales) and test (practice data), and a test key, a sandbox or a practice
 * connection reads the second as readily as a live one reads the first. The books learn which they are reading from the first Stripe data they take, once, and every later
 * read must be the same: a mixed book cannot be told apart again, and a real owner's books with a practice payout in them are wrong in a way nobody sees. */

const changed = (booked: StripeMode): ApplicationError =>
  new ApplicationError(
    "stripe_mode_changed",
    booked === "live"
      ? "This workspace has booked Stripe's live mode (real sales), and these answers are from test mode (practice data). Nothing was imported. Use a live key, or a workspace of its own for practice data."
      : "This workspace has only ever read Stripe's test mode (practice data), and these answers are from live mode (real sales). Nothing was imported. Real sales belong in a workspace of their own: make one and connect Stripe there.",
    409,
  );

const mismatch = (declared: StripeMode, labelled: StripeMode): ApplicationError =>
  new ApplicationError(
    "stripe_mode_mismatch",
    `These answers were sent as Stripe's ${declared} mode, but Stripe's own label on them says ${labelled} mode. Nothing was imported.`,
    409,
  );

const modeOf = (livemode: boolean): StripeMode => (livemode ? "live" : "test");

/** What one run may read, as to live and test. `declared` is what the run says it reads: the mode of the key, or what the sender of delivered answers declared; null when
 * nothing was said (an older sender), and the first thing Stripe itself labels then decides. */
export class ModeGuard {
  private declared: StripeMode | null;

  constructor(
    private readonly store: StripeStore,
    declared: StripeMode | null,
  ) {
    this.declared = declared;
  }

  /** Before anything is asked of Stripe or recorded: the mode the run declares must be the mode the books have booked. */
  begin(): void {
    const booked = this.store.connection().mode;
    if (this.declared !== null && booked !== null && booked !== this.declared)
      throw changed(booked);
  }

  /** The account is known and it fits: if these are the first data, the books now are in this mode for good. */
  learn(): void {
    if (this.declared !== null) this.store.rememberMode(this.declared);
  }

  /** An object Stripe itself labelled (`livemode`): a payout, the balance. It must be the mode the run declared, and the books'. With nothing declared and nothing booked it is
   * the first word on the matter. */
  seen(livemode: boolean | undefined): void {
    if (livemode === undefined) return;
    const labelled = modeOf(livemode);
    if (this.declared !== null && this.declared !== labelled)
      throw mismatch(this.declared, labelled);
    const booked = this.store.connection().mode;
    if (booked !== null && booked !== labelled) throw changed(booked);
    if (booked === null) this.store.rememberMode(labelled);
    this.declared = labelled;
  }
}

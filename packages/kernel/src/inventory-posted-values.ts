import { ExactDecimal, ExactRational } from "./numeric.ts";
import { diagnostic, type SemanticDiagnostic } from "./journal.ts";
import { quantize, quantizeCumulativePostedShare, type CumulativePostedShare, type QuantizationPolicy } from "./quantization.ts";

/** Actual posted components, not quantized economic carrying estimates. The
 * canonical owner must authenticate their source, currency, policy and epoch.
 * This arithmetic module cannot initialize/adopt an existing holding or commit
 * a journal. New component-bearing anchors require their own explicit version. */
export interface InventoryPostedValueBudget {
  readonly basis: ExactDecimal;
  readonly allowance: ExactDecimal;
}

interface ValueRejection {
  readonly disposition: "rejected";
  readonly diagnostics: readonly SemanticDiagnostic[];
}

function reject(path: string, message: string): ValueRejection {
  return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([
    diagnostic("inventory_value_adjustment_violation", path, message, ["ACC-039.5", "ACC-039.7", "ACC-039.9"]),
  ]) });
}

/** Only called after policy, representable total and fractions are validated. */
function share(total: ExactDecimal, before: ExactRational, after: ExactRational, policy: QuantizationPolicy): CumulativePostedShare {
  const beforeTarget = total.toRational().multiply(before), afterTarget = total.toRational().multiply(after);
  const beforeQuantization = quantize(beforeTarget, policy), afterQuantization = quantize(afterTarget, policy);
  return Object.freeze({ postedTotal: total, beforeFraction: before, afterFraction: after, beforeTarget, afterTarget,
    beforeQuantization, afterQuantization,
    postedAmount: ExactDecimal.of(afterQuantization.amount.coefficient - beforeQuantization.amount.coefficient, policy.targetScale), policy });
}

export interface InventoryPostedValueAllocation {
  readonly disposition: "allocated";
  /** Positive basis and carrying consumption; allowance consumption is their
   * signed difference. Transfer destinations receive these exact components. */
  readonly consumed: InventoryPostedValueBudget;
  readonly remaining: InventoryPostedValueBudget;
  readonly carryingConsumed: ExactDecimal;
  readonly carryingRemaining: ExactDecimal;
  readonly allowanceProof: CumulativePostedShare;
  readonly carryingProof: CumulativePostedShare;
}

/** Preserve the existing cumulative NET carrying share exactly. Allocate the
 * nonnegative allowance MAGNITUDE cumulatively under the same pinned fractions;
 * basis is NET plus that magnitude, never an independently rounded third counter.
 * Independently rounding basis and net can produce a positive allowance share
 * over a subinterval, even though both cumulative counters are monotonic.
 * Thus basis + allowance = carrying
 * for every movement and remainder, and terminal depletion consumes each actual
 * posted component exactly. Fractions refer to the original epoch quantity. */
export function allocateInventoryPostedValue(
  supplied: InventoryPostedValueBudget,
  beforeFraction: ExactRational,
  afterFraction: ExactRational,
  suppliedPolicy: QuantizationPolicy,
): InventoryPostedValueAllocation | ValueRejection {
  const policy = Object.freeze({ ...suppliedPolicy }), budget = Object.freeze({ ...supplied });
  const basis = quantizeCumulativePostedShare(budget.basis, beforeFraction, afterFraction, policy);
  if (basis.disposition === "rejected") return basis;
  const allowance = quantize(budget.allowance.toRational(), policy);
  const carrying = quantize(budget.basis.toRational().add(budget.allowance.toRational()), policy);
  if (budget.allowance.coefficient > 0n || !allowance.residual.isZero() || !carrying.residual.isZero() || carrying.amount.coefficient < 0n) {
    return reject("inventoryPostedValue.budget", "Posted basis and non-positive allowance must be representable in one pinned policy, with nonnegative net carrying value");
  }
  const allowanceProof = share(allowance.amount.negate(), beforeFraction, afterFraction, policy);
  const carryingProof = share(carrying.amount, beforeFraction, afterFraction, policy);
  const allowanceRemaining = -allowance.amount.coefficient - allowanceProof.afterQuantization.amount.coefficient;
  const carryingRemaining = carrying.amount.coefficient - carryingProof.afterQuantization.amount.coefficient;
  return Object.freeze({ disposition: "allocated", allowanceProof, carryingProof,
    consumed: Object.freeze({ basis: ExactDecimal.of(carryingProof.postedAmount.coefficient + allowanceProof.postedAmount.coefficient, policy.targetScale),
      allowance: allowanceProof.postedAmount.negate() }),
    remaining: Object.freeze({ basis: ExactDecimal.of(carryingRemaining + allowanceRemaining, policy.targetScale),
      allowance: ExactDecimal.of(-allowanceRemaining, policy.targetScale) }),
    carryingConsumed: carryingProof.postedAmount, carryingRemaining: ExactDecimal.of(carryingRemaining, policy.targetScale) });
}

export interface InventoryAllowanceChange {
  readonly disposition: "adjusted";
  readonly kind: "writeDown" | "writeDownReversal";
  readonly before: InventoryPostedValueBudget;
  readonly after: InventoryPostedValueBudget;
  readonly economicChange: ExactRational;
  readonly postedChange: ExactDecimal;
  /** Explicit signed difference; not authority for an automatic rounding entry. */
  readonly postedMinusEconomic: ExactRational;
  readonly proof: CumulativePostedShare;
}

/** Prospective allowance-transition arithmetic. The caller supplies authenticated
 * CURRENT posted components and matching exact economics, after any quantity
 * consumption. A write-down consumes the affected fraction of actual posted net
 * carrying value; a reversal restores only the affected fraction of the remaining
 * actual posted allowance. Full write-downs therefore reach zero, and full
 * reversals restore remaining posted basis even at half-cent boundaries.
 *
 * This does not admit policy, dates, journal omission, identities or sources.
 * Canonical integration must record the economic change separately, post exactly
 * postedChange (or retain a journal-free value effect when zero), and create a
 * successor anchor from before + postedChange, never Q(current economic value).
 * Earlier command/artifact versions must not acquire these semantics implicitly. */
export function adjustInventoryPostedAllowance(
  budget: InventoryPostedValueBudget,
  economics: { readonly basis: ExactRational; readonly allowance: ExactRational },
  kind: "writeDown" | "writeDownReversal",
  economicChange: ExactRational,
  policy: QuantizationPolicy,
): InventoryAllowanceChange | ValueRejection {
  const zero = ExactRational.zero();
  const current = allocateInventoryPostedValue(budget, zero, zero, policy);
  if (current.disposition === "rejected") return current;
  const economicCarrying = economics.basis.add(economics.allowance);
  const afterAllowance = economics.allowance.add(economicChange);
  if (economics.basis.isNegative() || economics.allowance.compare(zero) > 0 || economicCarrying.isNegative() ||
    economics.basis.add(afterAllowance).isNegative() || afterAllowance.compare(zero) > 0 ||
    (kind !== "writeDown" && kind !== "writeDownReversal") ||
    (kind === "writeDown" ? economicChange.compare(zero) >= 0 : economicChange.compare(zero) <= 0)) {
    return reject("inventoryPostedValue.allowance", "Allowance changes must have the declared sign, preserve nonnegative economic carrying value, and never reverse more than remaining write-downs");
  }
  const before = current.remaining;
  const down = kind === "writeDown";
  const fraction = down ? economicChange.negate().divide(economicCarrying) : economicChange.divide(economics.allowance.negate());
  const total = down ? current.carryingRemaining : before.allowance.negate();
  const proof = share(total, zero, fraction, current.carryingProof.policy);
  const postedChange = down ? proof.postedAmount.negate() : proof.postedAmount;
  const after = Object.freeze({ basis: before.basis,
    allowance: ExactDecimal.of(before.allowance.coefficient + postedChange.coefficient, before.allowance.scale) });
  return Object.freeze({ disposition: "adjusted", kind, before, after, proof, economicChange, postedChange,
    postedMinusEconomic: postedChange.toRational().subtract(economicChange) });
}

import { hashCanonical, identifier, type ContentHash, type Identifier } from "./canonical.ts";
import type { AccountId, BookId, BookValue, CommodityId, LocalDate, SemanticDiagnostic } from "./journal.ts";
import { diagnostic } from "./journal.ts";
import { ExactDecimal, ExactRational, MAX_DECIMAL_SCALE } from "./numeric.ts";
import type { SemanticVersion } from "./policy.ts";

export type QuantizationPolicyId = Identifier<"QuantizationPolicy">;
export const quantizationPolicyId = (value: string): QuantizationPolicyId =>
  identifier<"QuantizationPolicy">(value);

export type RoundingMode = "halfEven" | "halfAwayFromZero" | "towardZero" | "floor" | "ceiling";

export interface QuantizationPolicy {
  readonly id: QuantizationPolicyId;
  readonly version: SemanticVersion;
  readonly bookId: BookId;
  readonly functionalCommodityId: CommodityId;
  readonly validFrom: LocalDate;
  readonly validTo?: LocalDate;
  readonly targetScale: bigint;
  readonly roundingMode: RoundingMode;
  readonly roundingAccountId: AccountId;
}

export function hashQuantizationPolicy(policy: QuantizationPolicy): ContentHash {
  return hashCanonical({
    type: "QuantizationPolicy",
    id: policy.id,
    version: policy.version,
    bookId: policy.bookId,
    functionalCommodityId: policy.functionalCommodityId,
    validFrom: policy.validFrom,
    validTo: policy.validTo ?? null,
    targetScale: policy.targetScale,
    roundingMode: policy.roundingMode,
    roundingAccountId: policy.roundingAccountId,
  });
}

export interface QuantizedValue {
  readonly amount: ExactDecimal;
  readonly residual: ExactRational;
}

export interface CumulativePostedShare {
  readonly postedTotal: ExactDecimal;
  readonly beforeFraction: ExactRational;
  readonly afterFraction: ExactRational;
  readonly beforeTarget: ExactRational;
  readonly afterTarget: ExactRational;
  readonly beforeQuantization: QuantizedValue;
  readonly afterQuantization: QuantizedValue;
  readonly postedAmount: ExactDecimal;
  readonly policy: QuantizationPolicy;
}

/** Arithmetic only: the caller must prove postedTotal from canonical journal
 * history and pin the same anchor/policy across successive shares. Fractions are
 * cumulative, not per-command proportions. This does not authenticate inventory,
 * create a posting, or opt an existing holding into a new accounting algorithm. */
export function quantizeCumulativePostedShare(
  postedTotal: ExactDecimal,
  beforeFraction: ExactRational,
  afterFraction: ExactRational,
  policy: QuantizationPolicy,
): { readonly disposition: "quantized"; readonly share: CumulativePostedShare } | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] } {
  const total = postedTotal.toRational();
  const one = ExactRational.of(1n, 1n);
  if (
    policy.targetScale < 0n || policy.targetScale > MAX_DECIMAL_SCALE ||
    !["halfEven", "halfAwayFromZero", "towardZero", "floor", "ceiling"].includes(policy.roundingMode) ||
    total.isNegative() || beforeFraction.isNegative() ||
    afterFraction.compare(beforeFraction) < 0 || afterFraction.compare(one) > 0
  ) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([
      diagnostic("invalid_exact_number", "cumulativePostedShare", "A posted share requires an admitted quantization policy, a nonnegative total, and ordered cumulative fractions from zero through one", ["ACC-001", "ACC-003", "ACC-039.5"]),
    ]) });
  }
  const normalizedTotal = quantize(total, policy);
  if (!normalizedTotal.residual.isZero()) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([
      diagnostic("invalid_exact_number", "cumulativePostedShare.postedTotal", "The authenticated posted total must already be representable in the pinned policy; a new policy may not silently reround it", ["ACC-003", "ACC-011", "ACC-039.5"]),
    ]) });
  }
  const beforeTarget = total.multiply(beforeFraction);
  const afterTarget = total.multiply(afterFraction);
  const beforeQuantization = quantize(beforeTarget, policy);
  const afterQuantization = quantize(afterTarget, policy);
  const postedAmount = ExactDecimal.of(afterQuantization.amount.coefficient - beforeQuantization.amount.coefficient, policy.targetScale);
  return Object.freeze({ disposition: "quantized", share: Object.freeze({
    postedTotal: normalizedTotal.amount, beforeFraction, afterFraction,
    beforeTarget, afterTarget, beforeQuantization, afterQuantization, postedAmount,
    policy: Object.freeze({ ...policy }),
  }) });
}

function roundedCoefficient(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = remainder < 0n ? -remainder : remainder;
  switch (mode) {
    case "towardZero": return quotient;
    case "floor": return sign < 0n ? quotient - 1n : quotient;
    case "ceiling": return sign > 0n ? quotient + 1n : quotient;
    case "halfAwayFromZero": return magnitude * 2n >= denominator ? quotient + sign : quotient;
    case "halfEven": {
      const comparison = magnitude * 2n - denominator;
      if (comparison > 0n || (comparison === 0n && (quotient < 0n ? -quotient : quotient) % 2n === 1n)) {
        return quotient + sign;
      }
      return quotient;
    }
  }
}

export function quantize(value: ExactRational, policy: QuantizationPolicy): QuantizedValue {
  if (policy.targetScale < 0n || policy.targetScale > MAX_DECIMAL_SCALE) {
    throw new RangeError(`Quantization scale must be between 0 and ${MAX_DECIMAL_SCALE}`);
  }
  const factor = 10n ** policy.targetScale;
  const coefficient = roundedCoefficient(
    value.numerator * factor,
    value.denominator,
    policy.roundingMode,
  );
  const amount = ExactDecimal.of(coefficient, policy.targetScale);
  return Object.freeze({ amount, residual: value.subtract(amount.toRational()) });
}

export type BalancedQuantizationResult =
  | {
      readonly disposition: "quantized";
      readonly bookValues: readonly BookValue[];
      readonly roundingPosting?: {
        readonly accountId: AccountId;
        readonly bookValue: BookValue;
      };
    }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

export function quantizeBalancedBookValues(
  exactValues: readonly ExactRational[],
  bookId: BookId,
  functionalCommodityId: CommodityId,
  policy: QuantizationPolicy,
): BalancedQuantizationResult {
  if (policy.targetScale < 0n || policy.targetScale > MAX_DECIMAL_SCALE) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("invalid_exact_number", "quantizationPolicy.targetScale", "Quantization scale exceeds the admitted exact-decimal representation", ["ACC-001", "ACC-003", "ACC-022"]),
      ]),
    });
  }
  if (policy.bookId !== bookId || policy.functionalCommodityId !== functionalCommodityId) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("book_isolation_violation", "quantizationPolicy", "Quantization policy belongs to another book or commodity", ["ACC-002", "ACC-003", "ACC-026"]),
      ]),
    });
  }
  const exactTotal = exactValues.reduce((total, value) => total.add(value), ExactRational.zero());
  if (!exactTotal.isZero()) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("journal_imbalance", "exactValues", "Values must balance exactly before quantization", ["ACC-001", "ACC-003"]),
      ]),
    });
  }
  const quantized = exactValues.map((value) => quantize(value, policy).amount);
  const quantizedTotal = quantized.reduce(
    (total, amount) => total.add(amount.toRational()),
    ExactRational.zero(),
  );
  const bookValues = Object.freeze(
    quantized.map((amount) => Object.freeze({ amount, functionalCommodityId })),
  );
  if (quantizedTotal.isZero()) return Object.freeze({ disposition: "quantized", bookValues });
  const rounding = quantize(quantizedTotal.negate(), policy).amount;
  return Object.freeze({
    disposition: "quantized",
    bookValues,
    roundingPosting: Object.freeze({
      accountId: policy.roundingAccountId,
      bookValue: Object.freeze({ amount: rounding, functionalCommodityId }),
    }),
  });
}

import {
  ExactDecimal,
  ExactRational,
  compareCanonicalText,
  hashCanonical,
  identifier,
  quantizeCumulativePostedShare,
  quantize,
  contentHashEquals,
  type CanonicalValue,
  type ContentHash,
  type LotHoldingId,
  type PostingId,
  type QuantizationPolicy,
} from "@rastrata/kernel";
import { LEDGER_LIMITS, LedgerError } from "./records.ts";

const VERSION = "legacy-inventory-posted-attribution-v1";
const MAX_SHARES = 10_000;
export interface InventoryPostedWitnessRow {
  readonly postingId: PostingId;
  readonly postingHash: ContentHash;
  readonly shares: readonly {
    readonly holdingId: LotHoldingId;
    readonly postedAmount: ExactDecimal;
  }[];
}
export interface InventoryPostedWitness {
  readonly sourceHash: ContentHash;
  readonly postings: readonly InventoryPostedWitnessRow[];
  readonly contentHash: ContentHash;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|")
  )
    throw new Error("Invalid witness fields");
  return value as Record<string, unknown>;
}
function hash(value: unknown): ContentHash {
  const item = record(value, ["algorithm", "canonicalizationVersion", "digest"]);
  if (
    item.algorithm !== "sha256" ||
    item.canonicalizationVersion !== "rastrata-canonical-v1" ||
    typeof item.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.digest)
  )
    throw new Error("Invalid witness hash");
  return Object.freeze({
    algorithm: item.algorithm,
    canonicalizationVersion: item.canonicalizationVersion,
    digest: item.digest,
  });
}
function id(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid witness identity");
  return identifier(value);
}

/** Bounded JSON is copied before ledger I/O. No getters, caller-owned mutable
 * arrays, unknown fields or unbounded apportionment populations are admitted. */
export function decodeInventoryPostedWitness(encoded: string): InventoryPostedWitness {
  try {
    if (
      typeof encoded !== "string" ||
      new TextEncoder().encode(encoded).byteLength > LEDGER_LIMITS.recordBytes
    )
      throw new Error("Invalid witness size");
    const input = record(JSON.parse(encoded), ["version", "sourceHash", "postings"]);
    if (
      input.version !== VERSION ||
      !Array.isArray(input.postings) ||
      input.postings.length === 0 ||
      input.postings.length > MAX_SHARES
    )
      throw new Error("Invalid witness version or population");
    let count = 0;
    const postingIds = new Set<string>();
    const postings = input.postings
      .map((value): InventoryPostedWitnessRow => {
        const row = record(value, ["postingId", "postingHash", "shares"]);
        const postingId = id(row.postingId) as PostingId;
        if (postingIds.has(postingId) || !Array.isArray(row.shares) || row.shares.length === 0)
          throw new Error("Invalid witness shares");
        count += row.shares.length;
        if (count > MAX_SHARES) throw new Error("Invalid witness shares");
        postingIds.add(postingId);
        const holdingIds = new Set<string>();
        const shares = row.shares
          .map((value) => {
            const share = record(value, ["holdingId", "postedAmount"]);
            const holdingId = id(share.holdingId) as LotHoldingId;
            if (holdingIds.has(holdingId) || typeof share.postedAmount !== "string")
              throw new Error("Invalid share");
            holdingIds.add(holdingId);
            const postedAmount = ExactDecimal.parse(share.postedAmount);
            if (postedAmount.toString() !== share.postedAmount)
              throw new Error("Noncanonical decimal");
            return Object.freeze({ holdingId, postedAmount });
          })
          .sort((left, right) => compareCanonicalText(left.holdingId, right.holdingId));
        return Object.freeze({
          postingId,
          postingHash: hash(row.postingHash),
          shares: Object.freeze(shares),
        });
      })
      .sort((left, right) => compareCanonicalText(left.postingId, right.postingId));
    const sourceHash = hash(input.sourceHash);
    const contentHash = hashCanonical({
      version: VERSION,
      sourceHash: { ...sourceHash },
      postings: postings.map((row) => ({
        postingId: row.postingId,
        postingHash: { ...row.postingHash },
        shares: row.shares.map((share) => ({
          holdingId: share.holdingId,
          postedAmount: share.postedAmount.toRational().toString(),
        })),
      })),
    } as CanonicalValue);
    return Object.freeze({ sourceHash, postings: Object.freeze(postings), contentHash });
  } catch {
    throw new LedgerError("ledger_inventory_witness_invalid");
  }
}

export interface PostedShareTarget {
  readonly holdingId: LotHoldingId;
  readonly exactWeight: ExactRational;
  /** Transfer destinations inherit their source's accepted posted shares. */
  readonly prescribedAmount?: ExactRational;
}

/** The versioned proposal rule distributes the actual posted budget using
 * canonical holding-ID order and cumulative exact carrying weights. It does not
 * assert that this was the original book's undocumented allocation algorithm. */
export function resolveInventoryPostedShares(
  targets: readonly PostedShareTarget[],
  postedTotal: ExactDecimal,
  postingHash: ContentHash,
  policy: QuantizationPolicy,
  witness: InventoryPostedWitnessRow | undefined,
):
  | { readonly disposition: "resolved"; readonly shares: ReadonlyMap<LotHoldingId, ExactRational> }
  | { readonly disposition: "missing" | "invalid" } {
  const ordered = [...targets].sort((a, b) => compareCanonicalText(a.holdingId, b.holdingId));
  if (
    ordered.length === 0 ||
    new Set(ordered.map((target) => target.holdingId)).size !== ordered.length ||
    ordered.some((target) => target.exactWeight.isNegative())
  )
    return { disposition: "invalid" };
  const prescribed = ordered.every((target) => target.prescribedAmount !== undefined);
  if (!prescribed && ordered.some((target) => target.prescribedAmount !== undefined))
    return { disposition: "invalid" };
  const budget = quantizeCumulativePostedShare(
    postedTotal.toRational().isNegative() ? postedTotal.negate() : postedTotal,
    ExactRational.zero(),
    ExactRational.of(1n, 1n),
    policy,
  );
  if (budget.disposition !== "quantized") return { disposition: "invalid" };
  if (ordered.length > 1 && witness === undefined && !prescribed) return { disposition: "missing" };
  if (
    witness !== undefined &&
    (!contentHashEquals(witness.postingHash, postingHash) ||
      witness.shares.length !== ordered.length ||
      witness.shares.some((share, index) => share.holdingId !== ordered[index]?.holdingId))
  )
    return { disposition: "invalid" };
  const totalWeight = ordered.reduce(
    (sum, target) => sum.add(target.exactWeight),
    ExactRational.zero(),
  );
  if (ordered.length > 1 && !prescribed && totalWeight.isZero() && !postedTotal.isZero())
    return { disposition: "invalid" };
  const total = postedTotal.toRational();
  const shares = new Map<LotHoldingId, ExactRational>();
  let weight = ExactRational.zero();
  let assigned = ExactRational.zero();
  for (const [index, target] of ordered.entries()) {
    let amount: ExactRational;
    if (prescribed) amount = target.prescribedAmount as ExactRational;
    else if (ordered.length === 1) amount = total;
    else {
      const next = weight.add(target.exactWeight);
      const result = quantizeCumulativePostedShare(
        total.isNegative() ? postedTotal.negate() : postedTotal,
        totalWeight.isZero() ? ExactRational.zero() : weight.divide(totalWeight),
        totalWeight.isZero() ? ExactRational.zero() : next.divide(totalWeight),
        policy,
      );
      if (result.disposition !== "quantized") return { disposition: "invalid" };
      amount = total.isNegative()
        ? result.share.postedAmount.toRational().negate()
        : result.share.postedAmount.toRational();
      weight = next;
    }
    if (witness !== undefined && !witness.shares[index]?.postedAmount.toRational().equals(amount))
      return { disposition: "invalid" };
    if (!quantize(amount, policy).residual.isZero()) return { disposition: "invalid" };
    if (!amount.isZero() && (total.isZero() || amount.isNegative() !== total.isNegative()))
      return { disposition: "invalid" };
    shares.set(target.holdingId, amount);
    assigned = assigned.add(amount);
  }
  if (!assigned.equals(total)) return { disposition: "invalid" };
  return { disposition: "resolved", shares };
}

/-
What the TypeScript does that the laws did not expect, as theorems about the model; each was run
under Bun on the real `packages/kernel/src` functions with the same outcome.

- A journal source whose effect key is blank but not empty makes a group throw the `RangeError` of
  `effectKey` instead of rejecting (`reductionGroupPosting_blank_effectKey`; the acquisition and the
  transfer groups have the same test and the same call, lines 408, 420, 651, 665, 675 and 689).
- An adoption group whose policy scale is out of range throws the `RangeError` of `quantize`
  (line 841) instead of rejecting (`prepareInventoryPostedAdoptionGroup_scale_throws`).
- A transfer whose destination policy scale is negative throws the `ExactNumberError` of
  `ExactDecimal.of` (line 742) instead of rejecting (`transferConstruction_negative_scale_throws`).
- The destination test of a transfer never reads the destination lot's acquisition quantity, basis,
  date or evidence identifiers (`transferDestinationInvalid_ignores_lot_amounts`).
- A transfer from a `1.0.0` anchor drops the source's valuation allowance: the destination carries
  its basis (`prepareInventoryPostedTransferGroup_destination_economics`, `Transfer/Laws.lean`).
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.TransferRejections

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- A journal source whose effect key is blank but not empty passes the test of line 512
(`source.effectKey.length === 0` is false) and then makes `effectKey` throw at line 526: a
money-bearing reduction group with such a source, whose posting passes every test, throws instead
of rejecting. -/
theorem reductionGroupPosting_blank_effectKey {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {link : InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} {actual : Posting}
    (hmoney : postedAmount.isZero = false)
    (hsource : journalSourceMismatch context.toInventoryReductionEffectContext
      coordinate.functionalCommodityId link.source = false)
    (hfilter : link.source.journal.postings.filter (fun p => p.id == link.postingId) = [actual])
    (hattr : postingAttributionInvalid coordinate.accountId coordinate.unitsCommodityId
      coordinate.functionalCommodityId coordinate.dimensionMemberIds actual postedAmount
      quantity.negate historicalBasis.negate = .ok false)
    (hblank : jsTrim link.source.effectKey = "") :
    reductionGroupPosting context coordinate (some link) postedAmount quantity historicalBasis =
      .error (.effectKey .emptyEffectKey) := by
  have hkey : effectKey link.source.effectKey = .error .emptyEffectKey := by
    unfold effectKey
    rw [hblank]
    rfl
  unfold reductionGroupPosting
  simp only [hmoney, Bool.false_eq_true, ↓reduceIte, hsource, hfilter, hkey]
  rw [show InventoryOwnershipErr.ofQuantize (postingAttributionInvalid coordinate.accountId
    coordinate.unitsCommodityId coordinate.functionalCommodityId coordinate.dimensionMemberIds
    actual postedAmount quantity.negate historicalBasis.negate) = .ok false by
      rw [ofQuantize_eq_ok_iff]; exact hattr]

/-- An adoption group whose policy scale is outside `0` to `1000` throws the `RangeError` of
`quantize` (line 841) instead of rejecting, once its tests and its source loop pass: nothing before
line 841 validates the policy (the acquisition group's `zeroCheck` of line 380 has no counterpart
here). -/
theorem prepareInventoryPostedAdoptionGroup_scale_throws
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance quantity carrying : ExactRational}
    (hpop : adoptionPopulationInvalid context entries = false)
    (hev : adoptionEvidenceExceeded 0 entries = false)
    (hid : adoptionIdentityInvalid context entries = false)
    (hsrc : adoptionSourceLoop context (adoptionFirst entries) ExactRational.zero
      ExactRational.zero (adoptionOrdered entries) = .ok (.proceed (quantity, carrying)))
    (hscale : context.quantizationPolicy.targetScale < 0 ∨
      context.quantizationPolicy.targetScale > maxDecimalScale) :
    prepareInventoryPostedAdoptionGroup context entries postedBalance =
      .error (.quantize .scaleOutOfRange) := by
  have hq : quantize postedBalance context.quantizationPolicy.rule = .error .scaleOutOfRange := by
    unfold quantize
    exact ite_eq_left_of_eq_true _ _ (eq_true hscale)
  unfold prepareInventoryPostedAdoptionGroup
  simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte]
  unfold adoptionOrdered adoptionFirst at hsrc
  rw [show InventoryOwnershipErr.ofQuantize (adoptionSourceLoop context
    ((Option.map (fun x => x.holding) (sortByText (fun x => x.holding.id.value) entries).head?).getD
      default) ExactRational.zero ExactRational.zero (sortByText (fun x => x.holding.id.value) entries)) =
        .ok (.proceed (quantity, carrying)) by rw [ofQuantize_eq_ok_iff]; exact hsrc]
  simp only [hq, InventoryOwnershipErr.ofQuantize]

end InventoryOwnership


namespace InventoryOwnership

attribute [local irreducible] withinMagnitude

/-- A transfer whose destination policy scale is negative throws the `ExactNumberError` of
`ExactDecimal.of(0n, destPolicy.targetScale)` (line 742) instead of rejecting, at the first entry
whose source reduction carries no posted components: nothing before validates the destination
scale (only `allocateInventoryPostedValue`, reached for a component-bearing source, would reject
it). -/
theorem transferConstruction_negative_scale_throws (context : InventoryPostedTransferGroupContext)
    (sourcePosting destinationPosting : Option CanonicalPostingReference) (count index : Nat)
    (entry : InventoryPostedTransferEntry) (entries : List InventoryPostedTransferEntry)
    (reduction : InventoryPostedReduction) (reductions : List InventoryPostedReduction)
    (hnone : reduction.postedValue = none)
    (hscale : context.destinationQuantizationPolicy.targetScale < 0) :
    transferConstruction context sourcePosting destinationPosting count index (entry :: entries)
        (reduction :: reductions) = .error (.exactNumber .invalidDecimal) := by
  rw [transferConstruction_cons]
  unfold transferStep
  have hpv : transferPostedValue context.destinationQuantizationPolicy reduction =
      .ok (.proceed none) := by
    unfold transferPostedValue
    rw [hnone]
  have hof : ExactDecimal.of 0 context.destinationQuantizationPolicy.targetScale =
      .error .invalidDecimal := by
    unfold ExactDecimal.of scaleError
    simp only [hscale, ↓reduceIte]
  simp only [hpv, hof, liftExact]

/-- The destination test of a transfer reads nothing of the destination lot but its book, its
identifier and its two commodities: the lot's acquisition quantity, basis, date and evidence
identifiers may be anything (line 618 to 626). -/
theorem transferDestinationInvalid_ignores_lot_amounts
    (context : InventoryPostedTransferGroupContext) (sourceCoordinate : InventoryPostedCoordinate)
    (firstDest : LotHolding) (entry : InventoryPostedTransferEntry) (quantity basis : ExactRational)
    (acquiredAt : Instant) (evidenceIds : List String) :
    transferDestinationInvalid context sourceCoordinate firstDest
        { entry with
          destinationLot :=
            { entry.destinationLot with
              acquisitionQuantity := quantity
              acquisitionTotalBasis := basis
              acquiredAt := acquiredAt
              evidenceIds := evidenceIds } } =
      transferDestinationInvalid context sourceCoordinate firstDest entry := rfl

end InventoryOwnership

end Rastrata.Kernel

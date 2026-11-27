/-
The laws of the hashes of the effects that `Accounting/Inventory.lean` creates: each carries the hash of its
body, `validateAccountingEffectHash` accepts it, and two such effects with one hash are one effect or a
collision of SHA-256 is in hand.

This file depends on the laws of `Accounting/Core/Effects.lean`: `eq_of_validateAccountingEffectHash`
(and the laws of `Accounting/Core/Hashes.lean` it rests on).
-/
import Rastrata.Kernel.Accounting.Inventory.AdjustmentLaws
import Rastrata.Kernel.Accounting.Inventory.RecostingLaws
import Rastrata.Kernel.Accounting.Core.Effects

namespace Rastrata.Kernel

namespace Inventory

/-- A value of the canonical kind is itself. -/
theorem canonicalize_canonicalValue (v : CanonicalValue) : canonicalize v = v := rfl

/-- The body of a provisional layer that carries any hash is the canonical value of the layer's body. -/
theorem layer_bodyValue (value : ProvisionalInventoryLayerBody) (h : ContentHash) :
    bodyValue ({ toProvisionalInventoryLayerBody := value, contentHash := h } :
      ProvisionalInventoryLayer) = canonicalize value := by
  simp [bodyValue, CanonicalObject.members, ProvisionalInventoryLayer.canonicalMembers,
    withoutContentHash, canonicalize_object, ProvisionalInventoryLayerBody.canonicalMembers, member,
    optMember]

/-- The effect `createProvisionalInventoryLayerEffect` makes carries the hash of its body:
`validateAccountingEffectHash` accepts it. -/
theorem createProvisionalInventoryLayerEffect_valid (value : ProvisionalInventoryLayerBody) :
    validateAccountingEffectHash (createProvisionalInventoryLayerEffect value) = .ok true := by
  unfold validateAccountingEffectHash
  simp [createProvisionalInventoryLayerEffect, AccountingEffect.typeName, AccountingEffect.bodyValue,
    AccountingEffect.contentHash, layer_bodyValue, accountingHash, canonicalize_canonicalValue]

/-- The recosting of `calculateInventoryRecosting` carries the hash of its body. -/
theorem recostingEffect_valid (request : RecostInventoryRequest) (adjustment : ExactRational) :
    validateAccountingEffectHash (.inventoryRecosting (recostingEffect request adjustment)) =
      .ok true := by
  unfold validateAccountingEffectHash
  simp [recostingEffect, AccountingEffect.typeName, AccountingEffect.bodyValue,
    AccountingEffect.contentHash, InventoryRecosting.bodyValue_contentHash, accountingBodyHash]

/-- The value adjustment of `calculateInventoryValueAdjustment` carries the hash of its body. -/
theorem adjustmentEffect_valid (bookId : BookId) (policy : InventoryValueAdjustmentPolicy)
    (request : InventoryValueAdjustmentRequest) (bookedAdjustment : QuantizedValue) :
    validateAccountingEffectHash
      (.inventoryValueAdjustment (adjustmentEffect bookId policy request bookedAdjustment)) =
        .ok true := by
  unfold validateAccountingEffectHash
  simp [adjustmentEffect, AccountingEffect.typeName, AccountingEffect.bodyValue,
    AccountingEffect.contentHash, InventoryValueAdjustment.bodyValue_contentHash, accountingBodyHash]

/-- Every effect of a drafted recosting carries the hash of its body. -/
theorem calculateInventoryRecosting_effects_valid {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} {d : AccountingDraft}
    (h : calculateInventoryRecosting state request = .ok (.draft d)) :
    ∀ e ∈ d.effects, validateAccountingEffectHash e = .ok true := by
  obtain ⟨prior, layer, remaining, sourceQuantity, finalBasis, product, provisionalShare,
    adjustment, -, -, -, -, -, -, -, -, -, hd⟩ := calculateInventoryRecosting_draft_inv h
  intro e he
  rw [hd] at he
  simp only [List.mem_singleton] at he
  subst he
  exact recostingEffect_valid request adjustment

/-- Every effect of a drafted value adjustment carries the hash of its body. -/
theorem calculateInventoryValueAdjustment_effects_valid {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    ∀ e ∈ d.effects, validateAccountingEffectHash e = .ok true := by
  obtain ⟨policy, -, -, hdraft⟩ := calculateInventoryValueAdjustment_draft_inv h
  obtain ⟨ic, rc, postings, booked, jid, -, -, -, -, -, hd⟩ := adjustmentDraft_inv hdraft
  intro e he
  rw [hd] at he
  simp only [List.mem_singleton] at he
  subst he
  exact adjustmentEffect_valid bookId policy request booked

/-- Two effects that these functions make, with one content hash, are one effect, or a collision of
SHA-256 is in hand. -/
theorem inventory_effects_hash_inj {e f : AccountingEffect}
    (he : validateAccountingEffectHash e = .ok true) (hf : validateAccountingEffectHash f = .ok true)
    (h : e.contentHash = f.contentHash) : e = f ∨ HashCollision :=
  eq_of_validateAccountingEffectHash he hf h

/-- The provisional layer `createProvisionalInventoryLayerEffect` makes carries the `accountingHash` of
the body it was made from. -/
theorem createProvisionalInventoryLayerEffect_contentHash (value : ProvisionalInventoryLayerBody) :
    (createProvisionalInventoryLayerEffect value).contentHash =
      accountingHash "ProvisionalInventoryLayer" value := rfl

/-- The recosting `calculateInventoryRecosting` makes carries the hash of its body. -/
theorem recostingEffect_contentHash (request : RecostInventoryRequest) (adjustment : ExactRational) :
    (recostingEffect request adjustment).contentHash =
      accountingBodyHash "InventoryRecosting" (recostingEffect request adjustment) := by
  unfold recostingEffect
  simp only [accountingBodyHash, InventoryRecosting.bodyValue_contentHash]

/-- The value adjustment `calculateInventoryValueAdjustment` makes carries the hash of its body. -/
theorem adjustmentEffect_contentHash (bookId : BookId) (policy : InventoryValueAdjustmentPolicy)
    (request : InventoryValueAdjustmentRequest) (bookedAdjustment : QuantizedValue) :
    (adjustmentEffect bookId policy request bookedAdjustment).contentHash =
      accountingBodyHash "InventoryValueAdjustment"
        (adjustmentEffect bookId policy request bookedAdjustment) := by
  unfold adjustmentEffect
  simp only [accountingBodyHash, InventoryValueAdjustment.bodyValue_contentHash]


end Inventory

end Rastrata.Kernel

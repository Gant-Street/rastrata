/-
The laws of the two effect hashes (`inventory-ownership.ts` lines 892 to 899) and of the journal
source hash of `prepareInventoryOwnershipEffect` (lines 1338 to 1341).

`hashInventoryOwnershipEffect` is `accountingHash` of the effect without its `contentHash`: it covers
`effectKey`, `bookRevision`, `newAnchors`, `journalLinkedMovements` and `quantityOnlyMovements`,
every field of the effect but `contentHash`, and each anchor and movement in full (with its own
`contentHash`). Two effect bodies with equal hashes are equal or a collision of SHA-256 is in hand
(`hashInventoryOwnershipEffect_inj_or_collision`). `hashInventoryReductionOwnershipEffect` is the
same hash of the same object (`hashInventoryReductionOwnershipEffect_eq`), and is as injective
(`hashInventoryReductionOwnershipEffect_inj_or_collision`). The journal source hash covers the
journal's canonical value and the five other fields of the source.
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Model
import Rastrata.Kernel.InventoryOwnership.Reduction.Lawful
import Rastrata.Kernel.InventoryOwnership.Reduction.Basic

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

attribute [ext] InventoryOwnershipEffectBody

instance : LawfulCanonicalize InventoryOwnershipEffectBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryOwnershipEffectBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryOwnershipEffectBody.canonicalMembers, List.cons_append,
          List.nil_append, List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf,
          literalMember_wf, IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryOwnershipEffectBody.canonicalMembers, member, optMember,
        literalMember]) h
    simp only [InventoryOwnershipEffectBody.canonicalMembers, List.cons_append, List.nil_append,
      List.forall₂_cons, member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryOwnershipEffectBody.ext_iff.mpr this

/-- An effect's hash is a function of its content: two effects with the same fields but
`contentHash` hash alike. -/
theorem hashInventoryOwnershipEffect_of_body_eq {a b : InventoryOwnershipEffect}
    (h : a.toInventoryOwnershipEffectBody = b.toInventoryOwnershipEffectBody) :
    hashInventoryOwnershipEffect a.toInventoryOwnershipEffectBody =
      hashInventoryOwnershipEffect b.toInventoryOwnershipEffectBody := by
  rw [h]

/-- Two effect bodies with equal hashes are the same body, or a collision of SHA-256 is in hand: the
hash covers the effect key, the revision, every new anchor and every movement, in order. -/
theorem hashInventoryOwnershipEffect_inj_or_collision {a b : InventoryOwnershipEffectBody}
    (h : hashInventoryOwnershipEffect a = hashInventoryOwnershipEffect b) : a = b ∨ HashCollision :=
  accountingHash_eq_iff_or_collision "InventoryOwnershipEffect" a b h

/-- The hash of a reduction effect is the hash of the same effect read as an ownership effect. -/
theorem hashInventoryReductionOwnershipEffect_eq (body : InventoryReductionOwnershipEffectBody) :
    hashInventoryReductionOwnershipEffect body =
      hashInventoryOwnershipEffect body.toInventoryOwnershipEffectBody :=
  rfl

/-- Reading a reduction effect as an ownership effect loses nothing. -/
theorem InventoryReductionOwnershipEffectBody.toInventoryOwnershipEffectBody_injective
    {a b : InventoryReductionOwnershipEffectBody}
    (h : a.toInventoryOwnershipEffectBody = b.toInventoryOwnershipEffectBody) : a = b := by
  simp only [InventoryReductionOwnershipEffectBody.toInventoryOwnershipEffectBody,
    InventoryOwnershipEffectBody.mk.injEq] at h
  obtain ⟨h1, h2, h3, h4, h5⟩ := h
  have hj := List.map_injective_iff.mpr
    (fun x y (hxy : JournalLinkedInventoryPostedMovement.reduction x = .reduction y) => by
      cases hxy; rfl) h4
  have hq := List.map_injective_iff.mpr
    (fun x y (hxy : QuantityOnlyInventoryPostedMovement.reduction x = .reduction y) => by
      cases hxy; rfl) h5
  cases a; cases b
  simp_all

/-- Two reduction effect bodies with equal hashes are the same body, or a collision of SHA-256 is
in hand. -/
theorem hashInventoryReductionOwnershipEffect_inj_or_collision
    {a b : InventoryReductionOwnershipEffectBody}
    (h : hashInventoryReductionOwnershipEffect a = hashInventoryReductionOwnershipEffect b) :
    a = b ∨ HashCollision :=
  (hashInventoryOwnershipEffect_inj_or_collision h).imp
    InventoryReductionOwnershipEffectBody.toInventoryOwnershipEffectBody_injective id

end Rastrata.Kernel

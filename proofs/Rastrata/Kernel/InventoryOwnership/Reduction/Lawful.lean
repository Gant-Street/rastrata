/-
The canonical value of every artifact of inventory ownership is well formed and determines the
artifact (`LawfulCanonicalize`, `Accounting/Core/Canonical.lean`): two anchors, positions,
references, coordinates or movements whose canonical values agree up to the order of record
entries are the same. With `accountingHash_inj_or_collision` this makes every content hash of
the module a function that only a collision of SHA-256 can fool.

Each instance follows the steps of the instances of `Accounting/Core/Canonical.lean`: the keys
are distinct, every present value is well formed, and equal canonical values are equal property
by property.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Canonical

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

/-! ## String literals -/

theorem InventoryPostedAnchorAlgorithm.text_injective {a b : InventoryPostedAnchorAlgorithm}
    (_h : a.text = b.text) : a = b := by
  cases a; cases b; rfl

/-- The algorithm literal has one value. -/
theorem InventoryPostedAnchorAlgorithm.eq (a b : InventoryPostedAnchorAlgorithm) : a = b := by
  cases a; cases b; rfl

instance : LawfulCanonicalize InventoryPostedAnchorAlgorithm :=
  lawful_of_text InventoryPostedAnchorAlgorithm.text (fun _ => rfl) fun _ _ h =>
    InventoryPostedAnchorAlgorithm.text_injective h

theorem InventoryPostedMonetaryKind.text_injective {a b : InventoryPostedMonetaryKind}
    (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize InventoryPostedMonetaryKind :=
  lawful_of_text InventoryPostedMonetaryKind.text (fun _ => rfl) fun _ _ h =>
    InventoryPostedMonetaryKind.text_injective h

theorem InventoryPostedReductionKind.text_injective {a b : InventoryPostedReductionKind}
    (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize InventoryPostedReductionKind :=
  lawful_of_text InventoryPostedReductionKind.text (fun _ => rfl) fun _ _ h =>
    InventoryPostedReductionKind.text_injective h

theorem InventoryPostedAcquisitionKind.text_injective {a b : InventoryPostedAcquisitionKind}
    (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize InventoryPostedAcquisitionKind :=
  lawful_of_text InventoryPostedAcquisitionKind.text (fun _ => rfl) fun _ _ h =>
    InventoryPostedAcquisitionKind.text_injective h

/-! ## Records -/

attribute [ext] Lot

instance : LawfulCanonicalize Lot where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [Lot.canonicalMembers, member, optMember, literalMember])
    (by simp only [Lot.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [Lot.canonicalMembers, member, optMember, literalMember]) h
    simp only [Lot.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact Lot.ext_iff.mpr this

attribute [ext] LotHolding

instance : LawfulCanonicalize LotHolding where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [LotHolding.canonicalMembers, member, optMember, literalMember])
    (by simp only [LotHolding.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [LotHolding.canonicalMembers, member, optMember, literalMember]) h
    simp only [LotHolding.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact LotHolding.ext_iff.mpr this

attribute [ext] LotAllocation

instance : LawfulCanonicalize LotAllocation where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [LotAllocation.canonicalMembers, member, optMember, literalMember])
    (by simp only [LotAllocation.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [LotAllocation.canonicalMembers, member, optMember, literalMember]) h
    simp only [LotAllocation.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact LotAllocation.ext_iff.mpr this

attribute [ext] PolicyCumulativePostedShare

instance : LawfulCanonicalize PolicyCumulativePostedShare where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [PolicyCumulativePostedShare.canonicalMembers, member, optMember, literalMember])
    (by simp only [PolicyCumulativePostedShare.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [PolicyCumulativePostedShare.canonicalMembers, member, optMember, literalMember]) h
    simp only [PolicyCumulativePostedShare.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact PolicyCumulativePostedShare.ext_iff.mpr this

attribute [ext] InventoryPostedValueBudget

instance : LawfulCanonicalize InventoryPostedValueBudget where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedValueBudget.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedValueBudget.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedValueBudget.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedValueBudget.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedValueBudget.ext_iff.mpr this

attribute [ext] InventoryPostedCoordinate

instance : LawfulCanonicalize InventoryPostedCoordinate where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedCoordinate.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedCoordinate.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedCoordinate.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedCoordinate.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedCoordinate.ext_iff.mpr this

attribute [ext] InventoryPostedArtifactReference

instance : LawfulCanonicalize InventoryPostedArtifactReference where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedArtifactReference.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedArtifactReference.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedArtifactReference.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedArtifactReference.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedArtifactReference.ext_iff.mpr this

attribute [ext] InventoryPostedAnchorReference

instance : LawfulCanonicalize InventoryPostedAnchorReference where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedAnchorReference.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedAnchorReference.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedAnchorReference.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedAnchorReference.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedAnchorReference.ext_iff.mpr this

attribute [ext] InventoryPostedPositionReference

instance : LawfulCanonicalize InventoryPostedPositionReference where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedPositionReference.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedPositionReference.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedPositionReference.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedPositionReference.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedPositionReference.ext_iff.mpr this

attribute [ext] InventoryPostedMovementReference

instance : LawfulCanonicalize InventoryPostedMovementReference where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedMovementReference.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedMovementReference.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedMovementReference.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedMovementReference.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedMovementReference.ext_iff.mpr this

attribute [ext] InventoryPostedAnchorPolicy

instance : LawfulCanonicalize InventoryPostedAnchorPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedAnchorPolicy.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedAnchorPolicy.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedAnchorPolicy.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedAnchorPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedAnchorPolicy.ext_iff.mpr this

attribute [ext] InventoryPostedAnchorBody

instance : LawfulCanonicalize InventoryPostedAnchorBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedAnchorBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedAnchorBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedAnchorBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedAnchorBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedAnchorBody.ext_iff.mpr ⟨this.1, InventoryPostedAnchorAlgorithm.eq _ _, this.2⟩

attribute [ext] InventoryPostedAnchor

instance : LawfulCanonicalize InventoryPostedAnchor where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedAnchor.canonicalMembers, InventoryPostedAnchorBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedAnchor.canonicalMembers, InventoryPostedAnchorBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedAnchor.canonicalMembers, InventoryPostedAnchorBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedAnchor.canonicalMembers, InventoryPostedAnchorBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedAnchor.ext_iff.mpr ⟨this.1, InventoryPostedAnchorAlgorithm.eq _ _, this.2⟩

attribute [ext] InventoryPostedPositionBody

instance : LawfulCanonicalize InventoryPostedPositionBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedPositionBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedPositionBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedPositionBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedPositionBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedPositionBody.ext_iff.mpr this

attribute [ext] InventoryPostedPosition

instance : LawfulCanonicalize InventoryPostedPosition where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedPosition.canonicalMembers, InventoryPostedPositionBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedPosition.canonicalMembers, InventoryPostedPositionBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedPosition.canonicalMembers, InventoryPostedPositionBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedPosition.canonicalMembers, InventoryPostedPositionBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedPosition.ext_iff.mpr this

attribute [ext] InventoryPostedReductionMovementBody

instance : LawfulCanonicalize InventoryPostedReductionMovementBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedReductionMovementBody.ext_iff.mpr this

attribute [ext] JournalLinkedInventoryReductionMovementBody

instance : LawfulCanonicalize JournalLinkedInventoryReductionMovementBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact JournalLinkedInventoryReductionMovementBody.ext_iff.mpr this

attribute [ext] JournalLinkedInventoryReductionMovement

instance : LawfulCanonicalize JournalLinkedInventoryReductionMovement where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [JournalLinkedInventoryReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [JournalLinkedInventoryReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [JournalLinkedInventoryReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [JournalLinkedInventoryReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact JournalLinkedInventoryReductionMovement.ext_iff.mpr this

attribute [ext] QuantityOnlyInventoryReductionMovement

instance : LawfulCanonicalize QuantityOnlyInventoryReductionMovement where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [QuantityOnlyInventoryReductionMovement.canonicalMembers, InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [QuantityOnlyInventoryReductionMovement.canonicalMembers, InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [QuantityOnlyInventoryReductionMovement.canonicalMembers, InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [QuantityOnlyInventoryReductionMovement.canonicalMembers, InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact QuantityOnlyInventoryReductionMovement.ext_iff.mpr this

attribute [ext] InventoryPostedAcquisitionMovementBody

instance : LawfulCanonicalize InventoryPostedAcquisitionMovementBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact InventoryPostedAcquisitionMovementBody.ext_iff.mpr this

attribute [ext] JournalLinkedInventoryAcquisitionMovementBody

instance : LawfulCanonicalize JournalLinkedInventoryAcquisitionMovementBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact JournalLinkedInventoryAcquisitionMovementBody.ext_iff.mpr this

attribute [ext] JournalLinkedInventoryAcquisitionMovement

instance : LawfulCanonicalize JournalLinkedInventoryAcquisitionMovement where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [JournalLinkedInventoryAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [JournalLinkedInventoryAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [JournalLinkedInventoryAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [JournalLinkedInventoryAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact JournalLinkedInventoryAcquisitionMovement.ext_iff.mpr this

attribute [ext] QuantityOnlyInventoryAcquisitionMovement

instance : LawfulCanonicalize QuantityOnlyInventoryAcquisitionMovement where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [QuantityOnlyInventoryAcquisitionMovement.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [QuantityOnlyInventoryAcquisitionMovement.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [QuantityOnlyInventoryAcquisitionMovement.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [QuantityOnlyInventoryAcquisitionMovement.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
      member, optMember, literalMember, optEquiv_some_canonicalize_iff,
      optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
      and_true] at this
    exact QuantityOnlyInventoryAcquisitionMovement.ext_iff.mpr this

/-! ## Unions -/

/-- The quantity-only record of a body is well formed. -/
theorem InventoryPostedReductionMovementBody.quantityOnly_wf (value : InventoryPostedReductionMovementBody) :
    (object value.quantityOnlyMembers).WF :=
  object_wf_of (members := value.quantityOnlyMembers)
    (by simp [InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])

/-- The quantity-only record of a body determines the body. -/
theorem InventoryPostedReductionMovementBody.quantityOnly_inj {a b : InventoryPostedReductionMovementBody}
    (h : (object a.quantityOnlyMembers).Equiv (object b.quantityOnlyMembers)) : a = b := by
  have := object_equiv_forall₂ (members₁ := a.quantityOnlyMembers)
    (members₂ := b.quantityOnlyMembers) rfl
    (by simp [InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]) h
  simp only [InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
    member, optMember, literalMember, optEquiv_some_canonicalize_iff,
    optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
    and_true] at this
  exact InventoryPostedReductionMovementBody.ext_iff.mpr this

/-- The `monetaryKind` property of the input of a reduction movement's hash. -/
theorem MovementHashInput.entryAt_monetaryKind (value : MovementHashInput) :
    entryAt "monetaryKind" value.canonicalMembers =
      some (some (.string (match value with
        | .journalLinked _ => "journalLinked"
        | .quantityOnly _ => "quantityOnly"))) := by
  cases value <;>
    simp [MovementHashInput.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember,
      entryAt]

/-- The properties of the input of a reduction movement's hash have distinct keys. -/
theorem MovementHashInput.canonicalMembers_nodup (value : MovementHashInput) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  cases value <;>
    simp [MovementHashInput.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize MovementHashInput where
  wf value := by
    cases value with
    | journalLinked body => exact LawfulCanonicalize.wf body
    | quantityOnly body => exact body.quantityOnly_wf
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h
      "monetaryKind"
    rw [a.entryAt_monetaryKind, b.entryAt_monetaryKind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (by decide)
    · exact absurd hk (by decide)
    · exact congrArg _ (InventoryPostedReductionMovementBody.quantityOnly_inj h)

/-- The `monetaryKind` property of a reduction movement. -/
theorem InventoryPostedReductionMovement.entryAt_monetaryKind (value : InventoryPostedReductionMovement) :
    entryAt "monetaryKind" value.canonicalMembers =
      some (some (.string (match value with
        | .journalLinked _ => "journalLinked"
        | .quantityOnly _ => "quantityOnly"))) := by
  cases value <;>
    simp [InventoryPostedReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers, QuantityOnlyInventoryReductionMovement.canonicalMembers, InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember, entryAt]

/-- The properties of a reduction movement have distinct keys. -/
theorem InventoryPostedReductionMovement.canonicalMembers_nodup (value : InventoryPostedReductionMovement) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  cases value <;> simp [InventoryPostedReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovement.canonicalMembers, JournalLinkedInventoryReductionMovementBody.canonicalMembers, QuantityOnlyInventoryReductionMovement.canonicalMembers, InventoryPostedReductionMovementBody.quantityOnlyMembers, InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize InventoryPostedReductionMovement where
  wf value := by
    cases value with
    | journalLinked x => exact LawfulCanonicalize.wf x
    | quantityOnly x => exact LawfulCanonicalize.wf x
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h
      "monetaryKind"
    rw [a.entryAt_monetaryKind, b.entryAt_monetaryKind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (by decide)
    · exact absurd hk (by decide)
    · exact congrArg _ (LawfulCanonicalize.inj h)

/-- The quantity-only record of a body is well formed. -/
theorem InventoryPostedAcquisitionMovementBody.quantityOnly_wf (value : InventoryPostedAcquisitionMovementBody) :
    (object value.quantityOnlyMembers).WF :=
  object_wf_of (members := value.quantityOnlyMembers)
    (by simp [InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append,
          List.forall_mem_cons, List.not_mem_nil, member_wf, optMember_wf, literalMember_wf,
          IsEmpty.forall_iff, implies_true, and_self])

/-- The quantity-only record of a body determines the body. -/
theorem InventoryPostedAcquisitionMovementBody.quantityOnly_inj {a b : InventoryPostedAcquisitionMovementBody}
    (h : (object a.quantityOnlyMembers).Equiv (object b.quantityOnlyMembers)) : a = b := by
  have := object_equiv_forall₂ (members₁ := a.quantityOnlyMembers)
    (members₂ := b.quantityOnlyMembers) rfl
    (by simp [InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]) h
  simp only [InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons,
    member, optMember, literalMember, optEquiv_some_canonicalize_iff,
    optEquiv_map_canonicalize_iff, optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and,
    and_true] at this
  exact InventoryPostedAcquisitionMovementBody.ext_iff.mpr this

/-- The `monetaryKind` property of the input of an acquisition movement's hash. -/
theorem InventoryPostedAcquisitionMovementHashInput.entryAt_monetaryKind (value : InventoryPostedAcquisitionMovementHashInput) :
    entryAt "monetaryKind" value.canonicalMembers =
      some (some (.string (match value with
        | .journalLinked _ => "journalLinked"
        | .quantityOnly _ => "quantityOnly"))) := by
  cases value <;>
    simp [InventoryPostedAcquisitionMovementHashInput.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember, entryAt]

/-- The properties of the input of an acquisition movement's hash have distinct keys. -/
theorem InventoryPostedAcquisitionMovementHashInput.canonicalMembers_nodup (value : InventoryPostedAcquisitionMovementHashInput) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  cases value <;> simp [InventoryPostedAcquisitionMovementHashInput.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize InventoryPostedAcquisitionMovementHashInput where
  wf value := by
    cases value with
    | journalLinked x => exact LawfulCanonicalize.wf x
    | quantityOnly x => exact x.quantityOnly_wf
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h
      "monetaryKind"
    rw [a.entryAt_monetaryKind, b.entryAt_monetaryKind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (by decide)
    · exact absurd hk (by decide)
    · exact congrArg _ (InventoryPostedAcquisitionMovementBody.quantityOnly_inj h)

/-- The `monetaryKind` property of an acquisition movement. -/
theorem InventoryPostedAcquisitionMovement.entryAt_monetaryKind (value : InventoryPostedAcquisitionMovement) :
    entryAt "monetaryKind" value.canonicalMembers =
      some (some (.string (match value with
        | .journalLinked _ => "journalLinked"
        | .quantityOnly _ => "quantityOnly"))) := by
  cases value <;>
    simp [InventoryPostedAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, QuantityOnlyInventoryAcquisitionMovement.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember, entryAt]

/-- The properties of an acquisition movement have distinct keys. -/
theorem InventoryPostedAcquisitionMovement.canonicalMembers_nodup (value : InventoryPostedAcquisitionMovement) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  cases value <;> simp [InventoryPostedAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovement.canonicalMembers, JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers, QuantityOnlyInventoryAcquisitionMovement.canonicalMembers, InventoryPostedAcquisitionMovementBody.quantityOnlyMembers, InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize InventoryPostedAcquisitionMovement where
  wf value := by
    cases value with
    | journalLinked x => exact LawfulCanonicalize.wf x
    | quantityOnly x => exact LawfulCanonicalize.wf x
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h
      "monetaryKind"
    rw [a.entryAt_monetaryKind, b.entryAt_monetaryKind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (by decide)
    · exact absurd hk (by decide)
    · exact congrArg _ (LawfulCanonicalize.inj h)

/-- No reduction kind is written as an acquisition kind. -/
theorem InventoryPostedReductionKind.text_ne_acquisition (a : InventoryPostedReductionKind)
    (b : InventoryPostedAcquisitionKind) : a.text ≠ b.text := by
  cases a <;> cases b <;> decide

/-- The `kind` property of a movement of either kind: a reduction kind or an acquisition kind. -/
theorem InventoryPostedMovement.entryAt_kind (value : InventoryPostedMovement) :
    entryAt "kind" value.canonicalMembers = some (some (.string (match value with
      | .reduction m => m.kind.text
      | .acquisition m => m.kind.text))) := by
  rcases value with (m | m) <;> cases m <;>
    simp [InventoryPostedMovement.canonicalMembers,
      InventoryPostedReductionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      QuantityOnlyInventoryReductionMovement.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
      QuantityOnlyInventoryAcquisitionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
      InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember, entryAt] <;>
    rfl

/-- The properties of a movement of either kind have distinct keys. -/
theorem InventoryPostedMovement.canonicalMembers_nodup (value : InventoryPostedMovement) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  rcases value with (m | m) <;> cases m <;>
    simp [InventoryPostedMovement.canonicalMembers,
      InventoryPostedReductionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      QuantityOnlyInventoryReductionMovement.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
      QuantityOnlyInventoryAcquisitionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
      InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize InventoryPostedMovement where
  wf value := by
    cases value with
    | reduction x => exact LawfulCanonicalize.wf x
    | acquisition x => exact LawfulCanonicalize.wf x
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h "kind"
    rw [a.entryAt_kind, b.entryAt_kind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (InventoryPostedReductionKind.text_ne_acquisition _ _)
    · exact absurd hk.symm (InventoryPostedReductionKind.text_ne_acquisition _ _)
    · exact congrArg _ (LawfulCanonicalize.inj h)

/-- The `kind` property of a journal-linked movement of either kind. -/
theorem JournalLinkedInventoryPostedMovement.entryAt_kind (value : JournalLinkedInventoryPostedMovement) :
    entryAt "kind" value.canonicalMembers = some (some (.string (match value with
      | .reduction m => m.kind.text
      | .acquisition m => m.kind.text))) := by
  cases value <;>
    simp [JournalLinkedInventoryPostedMovement.canonicalMembers, JournalLinkedInventoryReductionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      QuantityOnlyInventoryReductionMovement.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
      QuantityOnlyInventoryAcquisitionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
      InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember, entryAt] <;>
    rfl

/-- The properties of a journal-linked movement of either kind have distinct keys. -/
theorem JournalLinkedInventoryPostedMovement.canonicalMembers_nodup (value : JournalLinkedInventoryPostedMovement) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  cases value <;>
    simp [JournalLinkedInventoryPostedMovement.canonicalMembers, JournalLinkedInventoryReductionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      QuantityOnlyInventoryReductionMovement.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
      QuantityOnlyInventoryAcquisitionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
      InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize JournalLinkedInventoryPostedMovement where
  wf value := by
    cases value with
    | reduction x => exact LawfulCanonicalize.wf x
    | acquisition x => exact LawfulCanonicalize.wf x
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h "kind"
    rw [a.entryAt_kind, b.entryAt_kind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (InventoryPostedReductionKind.text_ne_acquisition _ _)
    · exact absurd hk.symm (InventoryPostedReductionKind.text_ne_acquisition _ _)
    · exact congrArg _ (LawfulCanonicalize.inj h)

/-- The `kind` property of a quantity-only movement of either kind. -/
theorem QuantityOnlyInventoryPostedMovement.entryAt_kind (value : QuantityOnlyInventoryPostedMovement) :
    entryAt "kind" value.canonicalMembers = some (some (.string (match value with
      | .reduction m => m.kind.text
      | .acquisition m => m.kind.text))) := by
  cases value <;>
    simp [QuantityOnlyInventoryPostedMovement.canonicalMembers, JournalLinkedInventoryReductionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      QuantityOnlyInventoryReductionMovement.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
      QuantityOnlyInventoryAcquisitionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
      InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember, entryAt] <;>
    rfl

/-- The properties of a quantity-only movement of either kind have distinct keys. -/
theorem QuantityOnlyInventoryPostedMovement.canonicalMembers_nodup (value : QuantityOnlyInventoryPostedMovement) :
    (value.canonicalMembers.map Prod.fst).Nodup := by
  cases value <;>
    simp [QuantityOnlyInventoryPostedMovement.canonicalMembers, JournalLinkedInventoryReductionMovement.canonicalMembers,
      JournalLinkedInventoryReductionMovementBody.canonicalMembers,
      QuantityOnlyInventoryReductionMovement.canonicalMembers,
      InventoryPostedReductionMovementBody.quantityOnlyMembers,
      InventoryPostedReductionMovementBody.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovement.canonicalMembers,
      JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
      QuantityOnlyInventoryAcquisitionMovement.canonicalMembers,
      InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
      InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember]

instance : LawfulCanonicalize QuantityOnlyInventoryPostedMovement where
  wf value := by
    cases value with
    | reduction x => exact LawfulCanonicalize.wf x
    | acquisition x => exact LawfulCanonicalize.wf x
  inj {a b} h := by
    have hk := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h "kind"
    rw [a.entryAt_kind, b.entryAt_kind] at hk
    cases a <;> cases b <;> simp only [Option.bind_some, id, OptEquiv, CanonicalValue.Equiv,
      reduceCtorEq] at hk
    · exact congrArg _ (LawfulCanonicalize.inj h)
    · exact absurd hk (InventoryPostedReductionKind.text_ne_acquisition _ _)
    · exact absurd hk.symm (InventoryPostedReductionKind.text_ne_acquisition _ _)
    · exact congrArg _ (LawfulCanonicalize.inj h)

end Rastrata.Kernel

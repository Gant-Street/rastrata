/-
`LawfulCanonicalize` for the types of `Accounting/Basis/Canonical.lean` that hold no record of
arbitrary keys: the canonical value of such a value is well formed and determines the value, as
`Accounting/Core/Canonical.lean` proves for the types of `Accounting/Types.lean`, with the same steps.
-/
import Rastrata.Kernel.Accounting.Basis.Canonical

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false
set_option linter.unusedTactic false
set_option linter.unnecessarySeqFocus false
set_option linter.unreachableTactic false

/-! ## String literals -/

instance : LawfulCanonicalize JournalKind :=
  lawful_of_text JournalKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize AccountRole :=
  lawful_of_text AccountRole.canonicalText (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize NormalSide :=
  lawful_of_text NormalSide.canonicalText (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize FiscalPeriodKind :=
  lawful_of_text FiscalPeriodKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize LotSelectionMethod :=
  lawful_of_text LotSelectionMethod.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize PolicyScope :=
  lawful_of_text PolicyScope.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize PolicyCapabilityStatus :=
  lawful_of_text PolicyCapabilityStatus.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize BookExecutionProfile :=
  lawful_of_text BookExecutionProfile.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize BookStateCommitmentProfile :=
  lawful_of_text BookStateCommitmentProfile.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-! ## Objects -/

attribute [ext] Quantity

instance : LawfulCanonicalize Quantity where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [Quantity.canonicalMembers, member, optMember, literalMember])
    (by simp only [Quantity.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [Quantity.canonicalMembers, member, optMember, literalMember]) h
    simp only [Quantity.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact Quantity.ext_iff.mpr this

attribute [ext] BookValue

instance : LawfulCanonicalize BookValue where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [BookValue.canonicalMembers, member, optMember, literalMember])
    (by simp only [BookValue.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [BookValue.canonicalMembers, member, optMember, literalMember]) h
    simp only [BookValue.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact BookValue.ext_iff.mpr this

attribute [ext] TransactionPrice

instance : LawfulCanonicalize TransactionPrice where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [TransactionPrice.canonicalMembers, member, optMember, literalMember])
    (by simp only [TransactionPrice.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [TransactionPrice.canonicalMembers, member, optMember, literalMember]) h
    simp only [TransactionPrice.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact TransactionPrice.ext_iff.mpr this

attribute [ext] CostBasis

instance : LawfulCanonicalize CostBasis where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [CostBasis.canonicalMembers, member, optMember, literalMember])
    (by simp only [CostBasis.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [CostBasis.canonicalMembers, member, optMember, literalMember]) h
    simp only [CostBasis.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact CostBasis.ext_iff.mpr this

attribute [ext] Posting

instance : LawfulCanonicalize Posting where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [Posting.canonicalMembers, member, optMember, literalMember])
    (by simp only [Posting.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [Posting.canonicalMembers, member, optMember, literalMember]) h
    simp only [Posting.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact Posting.ext_iff.mpr this

attribute [ext] JournalTransaction

instance : LawfulCanonicalize JournalTransaction where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [JournalTransaction.canonicalMembers, member, optMember, literalMember])
    (by simp only [JournalTransaction.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [JournalTransaction.canonicalMembers, member, optMember, literalMember]) h
    simp only [JournalTransaction.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact JournalTransaction.ext_iff.mpr this

attribute [ext] AccountSnapshot

instance : LawfulCanonicalize AccountSnapshot where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountSnapshot.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountSnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountSnapshot.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountSnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountSnapshot.ext_iff.mpr this

attribute [ext] AccountingDimensionSnapshot

instance : LawfulCanonicalize AccountingDimensionSnapshot where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingDimensionSnapshot.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingDimensionSnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingDimensionSnapshot.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingDimensionSnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingDimensionSnapshot.ext_iff.mpr this

attribute [ext] DimensionMemberSnapshot

instance : LawfulCanonicalize DimensionMemberSnapshot where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [DimensionMemberSnapshot.canonicalMembers, member, optMember, literalMember])
    (by simp only [DimensionMemberSnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [DimensionMemberSnapshot.canonicalMembers, member, optMember, literalMember]) h
    simp only [DimensionMemberSnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact DimensionMemberSnapshot.ext_iff.mpr this

attribute [ext] PolicyCapability

instance : LawfulCanonicalize PolicyCapability where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [PolicyCapability.canonicalMembers, member, optMember, literalMember])
    (by simp only [PolicyCapability.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [PolicyCapability.canonicalMembers, member, optMember, literalMember]) h
    simp only [PolicyCapability.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact PolicyCapability.ext_iff.mpr this

attribute [ext] BookingPolicy

instance : LawfulCanonicalize BookingPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [BookingPolicy.canonicalMembers, member, optMember, literalMember])
    (by simp only [BookingPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [BookingPolicy.canonicalMembers, member, optMember, literalMember]) h
    simp only [BookingPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact BookingPolicy.ext_iff.mpr this

attribute [ext] FiscalPeriod

instance : LawfulCanonicalize FiscalPeriod where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [FiscalPeriod.canonicalMembers, member, optMember, literalMember])
    (by simp only [FiscalPeriod.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [FiscalPeriod.canonicalMembers, member, optMember, literalMember]) h
    simp only [FiscalPeriod.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact FiscalPeriod.ext_iff.mpr this

attribute [ext] BookedJournal

instance : LawfulCanonicalize BookedJournal where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [BookedJournal.canonicalMembers, member, optMember, literalMember])
    (by simp only [BookedJournal.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [BookedJournal.canonicalMembers, member, optMember, literalMember]) h
    simp only [BookedJournal.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact BookedJournal.ext_iff.mpr this

attribute [ext] BasisSourceEvent

instance : LawfulCanonicalize BasisSourceEvent where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [BasisSourceEvent.canonicalMembers, member, optMember, literalMember])
    (by simp only [BasisSourceEvent.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [BasisSourceEvent.canonicalMembers, member, optMember, literalMember]) h
    simp only [BasisSourceEvent.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact BasisSourceEvent.ext_iff.mpr this

attribute [ext] AccountingBasisProjectionEntry

instance : LawfulCanonicalize AccountingBasisProjectionEntry where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingBasisProjectionEntry.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingBasisProjectionEntry.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingBasisProjectionEntry.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingBasisProjectionEntry.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingBasisProjectionEntry.ext_iff.mpr this

attribute [ext] AccountingBasisReconciliation

instance : LawfulCanonicalize AccountingBasisReconciliation where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingBasisReconciliation.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingBasisReconciliation.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingBasisReconciliation.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingBasisReconciliation.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member,
      optMember, literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingBasisReconciliation.ext_iff.mpr this

end Rastrata.Kernel

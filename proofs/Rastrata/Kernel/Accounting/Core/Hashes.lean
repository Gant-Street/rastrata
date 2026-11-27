/-
Laws of the hashes of `accounting.ts` (law 1 of the brief of `Accounting/Core.lean`).

Every hash of the module is `hashCanonical` of a canonical value, and every canonical value of
`Accounting/Core/Canonical.lean` determines the value it was written from
(`LawfulCanonicalize`). So:

- `accountingHash type value` determines the type name and the value
  (`accountingHash_inj_or_collision`, in `Canonical.lean`);
- the hash of a body, `accountingBodyHash type value`, determines every field of the value but its
  `contentHash`, and nothing else: `T.bodyValue_equiv` for each of the twenty types whose
  `contentHash` the kernel computes this way (the six artifacts of a policy, the thirteen values of
  an effect, the posting plan), and `T.bodyValue_contentHash` (the body does not read the content
  hash);
- `hashAccountingPolicy` determines the policy, every field of it and of everything it nests, the
  nested artifacts' content hashes included (`hashAccountingPolicy_inj_or_collision`);
- `hashAccountingPolicySnapshot` determines the sorted list of the policies
  (`hashAccountingPolicySnapshot_inj_or_collision`), does not depend on the order the policies are
  given in when their sort keys are distinct (`hashAccountingPolicySnapshot_perm`), and does
  depend on it when two different policies share a key
  (`hashAccountingPolicySnapshot_order_dependent`);
- the canonical values of an effect and of a state determine them
  (`hashCanonical_canonicalAccountingEffectValue_inj_or_collision`,
  `hashCanonical_canonicalAccountingStateValue_inj_or_collision`).

No field of any type is left out of its canonical value: `canonicalize` walks every property, and
the model writes every field (each `LawfulCanonicalize` instance proves it). The only field a hash
of the module leaves out is `contentHash`, by design (`const { contentHash, ...body }`).
-/
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

/-! ## Bodies: an object without its `contentHash` -/

/-- Leaving out the property `contentHash` and then writing the entries is writing the entries and
then leaving out the entry `contentHash`. -/
theorem objectEntries_withoutContentHash : ∀ (members : List Member),
    objectEntries (withoutContentHash members) =
      (objectEntries members).filter (fun e => e.1 != "contentHash")
  | [] => rfl
  | (key, value) :: rest => by
    have ih := objectEntries_withoutContentHash rest
    unfold withoutContentHash at ih ⊢
    cases value <;> by_cases hk : (key != "contentHash") = true <;>
      simp_all [objectEntries, List.filter_cons, List.filterMap_cons]

/-- The entries of a record are well formed exactly when each value is. -/
theorem wfEntries_iff_forall : ∀ (entries : List (String × CanonicalValue)),
    CanonicalValue.WFEntries entries ↔ ∀ e ∈ entries, e.2.WF
  | [] => by simp [CanonicalValue.WFEntries]
  | (k, v) :: rest => by
    simp [CanonicalValue.WFEntries, wfEntries_iff_forall rest]

/-- Leaving entries out of a well-formed record leaves it well formed. -/
theorem record_filter_wf {entries : List (String × CanonicalValue)}
    (p : String × CanonicalValue → Bool) (h : (CanonicalValue.record entries).WF) :
    (CanonicalValue.record (entries.filter p)).WF :=
  ⟨((List.filter_sublist).map Prod.fst).nodup h.1,
    (wfEntries_iff_forall _).mpr fun e he =>
      (wfEntries_iff_forall _).mp h.2 e (List.mem_of_mem_filter he)⟩

/-- The body of a value of a lawful type is well formed. -/
theorem bodyValue_wf {α : Type} [CanonicalObject α] [LawfulCanonicalize α] (value : α) :
    (bodyValue value).WF := by
  have h : (object (CanonicalObject.members value)).WF := LawfulCanonicalize.wf value
  unfold bodyValue object
  rw [objectEntries_withoutContentHash]
  exact record_filter_wf _ h

/-- The record `accountingHash` hashes, of a well-formed canonical value, is well formed. -/
theorem accountingHash_record_wf (type : String) {value : CanonicalValue} (h : value.WF) :
    (CanonicalValue.record [("type", .string type), ("value", value)]).WF :=
  ⟨by simp, trivial, h, trivial⟩

/-- Two `accountingHash`es of well-formed canonical values are equal only for the same type name
and values equal up to the order of record entries, or a collision of SHA-256 is in hand. -/
theorem accountingHash_canonicalValue_inj_or_collision {type₁ type₂ : String}
    {v w : CanonicalValue} (hv : v.WF) (hw : w.WF)
    (h : accountingHash type₁ v = accountingHash type₂ w) :
    (type₁ = type₂ ∧ v.Equiv w) ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (accountingHash_record_wf type₁ hv)
    (accountingHash_record_wf type₂ hw) h with hequiv | hcollision
  · left
    have := object_equiv_forall₂
      (members₁ := [("type", some (.string type₁)), ("value", some v)])
      (members₂ := [("type", some (.string type₂)), ("value", some w)])
      rfl (by simp) hequiv
    simp only [List.forall₂_cons, List.forall₂_nil_left_iff, and_true, OptEquiv,
      CanonicalValue.Equiv] at this
    exact this
  · exact Or.inr hcollision

/-- Two body hashes are equal only for the same type name and bodies equal up to the order of
record entries, or a collision of SHA-256 is in hand. -/
theorem accountingBodyHash_inj_or_collision {α : Type} [CanonicalObject α] [LawfulCanonicalize α]
    {type₁ type₂ : String} {a b : α} (h : accountingBodyHash type₁ a = accountingBodyHash type₂ b) :
    (type₁ = type₂ ∧ (bodyValue a).Equiv (bodyValue b)) ∨ HashCollision :=
  accountingHash_canonicalValue_inj_or_collision (bodyValue_wf a) (bodyValue_wf b) h

/-! ## What each body covers: every field but `contentHash` -/

/-- The body of an inventory pool covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem InventoryPool.bodyValue_equiv {a b : InventoryPool} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [InventoryPool.ext_iff]
  simpa using this

/-- The body of an inventory pool does not read its content hash. -/
theorem InventoryPool.bodyValue_contentHash (a : InventoryPool) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of an inventory pool whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem InventoryPool.accountingBodyHash_inj_or_collision {type : String} {a b : InventoryPool}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => InventoryPool.bodyValue_equiv h.2) _root_.id

/-- The body of a basis rule covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem AccountingBasisRule.bodyValue_equiv {a b : AccountingBasisRule} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [AccountingBasisRule.ext_iff]
  simpa using this

/-- The body of a basis rule does not read its content hash. -/
theorem AccountingBasisRule.bodyValue_contentHash (a : AccountingBasisRule) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a basis rule whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem AccountingBasisRule.accountingBodyHash_inj_or_collision {type : String} {a b : AccountingBasisRule}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => AccountingBasisRule.bodyValue_equiv h.2) _root_.id

/-- The body of a classification rule covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem MonetaryClassificationRule.bodyValue_equiv {a b : MonetaryClassificationRule} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [MonetaryClassificationRule.ext_iff]
  simpa using this

/-- The body of a classification rule does not read its content hash. -/
theorem MonetaryClassificationRule.bodyValue_contentHash (a : MonetaryClassificationRule) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a classification rule whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem MonetaryClassificationRule.accountingBodyHash_inj_or_collision {type : String} {a b : MonetaryClassificationRule}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => MonetaryClassificationRule.bodyValue_equiv h.2) _root_.id

/-- The body of a tax component covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem TaxPolicyComponent.bodyValue_equiv {a b : TaxPolicyComponent} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [TaxPolicyComponent.ext_iff]
  simpa using this

/-- The body of a tax component does not read its content hash. -/
theorem TaxPolicyComponent.bodyValue_contentHash (a : TaxPolicyComponent) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a tax component whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem TaxPolicyComponent.accountingBodyHash_inj_or_collision {type : String} {a b : TaxPolicyComponent}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => TaxPolicyComponent.bodyValue_equiv h.2) _root_.id

/-- The body of an account mapping covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem ConsolidationAccountMapping.bodyValue_equiv {a b : ConsolidationAccountMapping} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [ConsolidationAccountMapping.ext_iff]
  simpa using this

/-- The body of an account mapping does not read its content hash. -/
theorem ConsolidationAccountMapping.bodyValue_contentHash (a : ConsolidationAccountMapping) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of an account mapping whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem ConsolidationAccountMapping.accountingBodyHash_inj_or_collision {type : String} {a b : ConsolidationAccountMapping}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => ConsolidationAccountMapping.bodyValue_equiv h.2) _root_.id

/-- The body of a translation rule covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem ConsolidationTranslationRule.bodyValue_equiv {a b : ConsolidationTranslationRule} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [ConsolidationTranslationRule.ext_iff]
  simpa using this

/-- The body of a translation rule does not read its content hash. -/
theorem ConsolidationTranslationRule.bodyValue_contentHash (a : ConsolidationTranslationRule) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a translation rule whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem ConsolidationTranslationRule.accountingBodyHash_inj_or_collision {type : String} {a b : ConsolidationTranslationRule}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => ConsolidationTranslationRule.bodyValue_equiv h.2) _root_.id

/-- The body of a provisional layer covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem ProvisionalInventoryLayer.bodyValue_equiv {a b : ProvisionalInventoryLayer} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [ProvisionalInventoryLayer.ext_iff]
  simpa using this

/-- The body of a provisional layer does not read its content hash. -/
theorem ProvisionalInventoryLayer.bodyValue_contentHash (a : ProvisionalInventoryLayer) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a provisional layer whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem ProvisionalInventoryLayer.accountingBodyHash_inj_or_collision {type : String} {a b : ProvisionalInventoryLayer}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => ProvisionalInventoryLayer.bodyValue_equiv h.2) _root_.id

/-- The body of a recosting covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem InventoryRecosting.bodyValue_equiv {a b : InventoryRecosting} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, InventoryRecosting.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, InventoryRecosting.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [InventoryRecosting.ext_iff]
  simpa using this

/-- The body of a recosting does not read its content hash. -/
theorem InventoryRecosting.bodyValue_contentHash (a : InventoryRecosting) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, InventoryRecosting.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a recosting whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem InventoryRecosting.accountingBodyHash_inj_or_collision {type : String} {a b : InventoryRecosting}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => InventoryRecosting.bodyValue_equiv h.2) _root_.id

/-- The body of a value adjustment covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem InventoryValueAdjustment.bodyValue_equiv {a b : InventoryValueAdjustment} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, InventoryValueAdjustment.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, InventoryValueAdjustment.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [InventoryValueAdjustment.ext_iff]
  simpa using this

/-- The body of a value adjustment does not read its content hash. -/
theorem InventoryValueAdjustment.bodyValue_contentHash (a : InventoryValueAdjustment) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, InventoryValueAdjustment.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a value adjustment whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem InventoryValueAdjustment.accountingBodyHash_inj_or_collision {type : String} {a b : InventoryValueAdjustment}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => InventoryValueAdjustment.bodyValue_equiv h.2) _root_.id

/-- The body of an open item covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem OpenItem.bodyValue_equiv {a b : OpenItem} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [OpenItem.ext_iff]
  simpa using this

/-- The body of an open item does not read its content hash. -/
theorem OpenItem.bodyValue_contentHash (a : OpenItem) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of an open item whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem OpenItem.accountingBodyHash_inj_or_collision {type : String} {a b : OpenItem}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => OpenItem.bodyValue_equiv h.2) _root_.id

/-- The body of a settlement covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem Settlement.bodyValue_equiv {a b : Settlement} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, Settlement.canonicalMembers, SettlementBody.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, Settlement.canonicalMembers, SettlementBody.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [Settlement.ext_iff]
  simpa using this

/-- The body of a settlement does not read its content hash. -/
theorem Settlement.bodyValue_contentHash (a : Settlement) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, Settlement.canonicalMembers, SettlementBody.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a settlement whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem Settlement.accountingBodyHash_inj_or_collision {type : String} {a b : Settlement}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => Settlement.bodyValue_equiv h.2) _root_.id

/-- The body of a settlement allocation covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem SettlementAllocation.bodyValue_equiv {a b : SettlementAllocation} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [SettlementAllocation.ext_iff]
  simpa using this

/-- The body of a settlement allocation does not read its content hash. -/
theorem SettlementAllocation.bodyValue_contentHash (a : SettlementAllocation) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a settlement allocation whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem SettlementAllocation.accountingBodyHash_inj_or_collision {type : String} {a b : SettlementAllocation}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => SettlementAllocation.bodyValue_equiv h.2) _root_.id

/-- The body of a remeasurement result covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem RemeasurementResult.bodyValue_equiv {a b : RemeasurementResult} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, RemeasurementResult.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, RemeasurementResult.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [RemeasurementResult.ext_iff]
  simpa using this

/-- The body of a remeasurement result does not read its content hash. -/
theorem RemeasurementResult.bodyValue_contentHash (a : RemeasurementResult) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, RemeasurementResult.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a remeasurement result whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem RemeasurementResult.accountingBodyHash_inj_or_collision {type : String} {a b : RemeasurementResult}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => RemeasurementResult.bodyValue_equiv h.2) _root_.id

/-- The body of a remeasurement reversal covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem RemeasurementReversal.bodyValue_equiv {a b : RemeasurementReversal} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, RemeasurementReversal.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, RemeasurementReversal.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [RemeasurementReversal.ext_iff]
  simpa using this

/-- The body of a remeasurement reversal does not read its content hash. -/
theorem RemeasurementReversal.bodyValue_contentHash (a : RemeasurementReversal) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, RemeasurementReversal.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a remeasurement reversal whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem RemeasurementReversal.accountingBodyHash_inj_or_collision {type : String} {a b : RemeasurementReversal}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => RemeasurementReversal.bodyValue_equiv h.2) _root_.id

/-- The body of a posting plan covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem AllocationPostingPlan.bodyValue_equiv {a b : AllocationPostingPlan} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, AllocationPostingPlan.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, AllocationPostingPlan.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  have hversion : ∀ x y : AllocationPostingAlgorithm, x = y := by
    intro x y; cases x; cases y; rfl
  rw [AllocationPostingPlan.ext_iff]
  simpa [hversion a.algorithmVersion b.algorithmVersion] using this

/-- The body of a posting plan does not read its content hash. -/
theorem AllocationPostingPlan.bodyValue_contentHash (a : AllocationPostingPlan) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, AllocationPostingPlan.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a posting plan whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem AllocationPostingPlan.accountingBodyHash_inj_or_collision {type : String} {a b : AllocationPostingPlan}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => AllocationPostingPlan.bodyValue_equiv h.2) _root_.id

/-- The body of an allocation schedule covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem AllocationSchedule.bodyValue_equiv {a b : AllocationSchedule} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, AllocationSchedule.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, AllocationSchedule.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [AllocationSchedule.ext_iff]
  simpa using this

/-- The body of an allocation schedule does not read its content hash. -/
theorem AllocationSchedule.bodyValue_contentHash (a : AllocationSchedule) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, AllocationSchedule.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of an allocation schedule whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem AllocationSchedule.accountingBodyHash_inj_or_collision {type : String} {a b : AllocationSchedule}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => AllocationSchedule.bodyValue_equiv h.2) _root_.id

/-- The body of an allocation recognition covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem AllocationRecognition.bodyValue_equiv {a b : AllocationRecognition} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, AllocationRecognition.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, AllocationRecognition.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [AllocationRecognition.ext_iff]
  simpa using this

/-- The body of an allocation recognition does not read its content hash. -/
theorem AllocationRecognition.bodyValue_contentHash (a : AllocationRecognition) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, AllocationRecognition.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of an allocation recognition whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem AllocationRecognition.accountingBodyHash_inj_or_collision {type : String} {a b : AllocationRecognition}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => AllocationRecognition.bodyValue_equiv h.2) _root_.id

/-- The body of a schedule revision covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem AllocationScheduleRevision.bodyValue_equiv {a b : AllocationScheduleRevision} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, AllocationScheduleRevision.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, AllocationScheduleRevision.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [AllocationScheduleRevision.ext_iff]
  simpa using this

/-- The body of a schedule revision does not read its content hash. -/
theorem AllocationScheduleRevision.bodyValue_contentHash (a : AllocationScheduleRevision) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, AllocationScheduleRevision.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a schedule revision whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem AllocationScheduleRevision.accountingBodyHash_inj_or_collision {type : String} {a b : AllocationScheduleRevision}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => AllocationScheduleRevision.bodyValue_equiv h.2) _root_.id

/-- The body of a tax determination covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem TaxDetermination.bodyValue_equiv {a b : TaxDetermination} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, TaxDetermination.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, TaxDetermination.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [TaxDetermination.ext_iff]
  simpa using this

/-- The body of a tax determination does not read its content hash. -/
theorem TaxDetermination.bodyValue_contentHash (a : TaxDetermination) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, TaxDetermination.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a tax determination whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem TaxDetermination.accountingBodyHash_inj_or_collision {type : String} {a b : TaxDetermination}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => TaxDetermination.bodyValue_equiv h.2) _root_.id

/-- The body of a consolidation compilation covers every field but its content hash: two whose bodies are equal up to
the order of record entries differ at most in `contentHash`. -/
theorem ConsolidationCompilation.bodyValue_equiv {a b : ConsolidationCompilation} (h : (bodyValue a).Equiv (bodyValue b)) :
    { a with contentHash := b.contentHash } = b := by
  have := object_equiv_forall₂ (members₁ := withoutContentHash a.canonicalMembers)
    (members₂ := withoutContentHash b.canonicalMembers) rfl
    (by simp [withoutContentHash, ConsolidationCompilation.canonicalMembers, member, optMember, literalMember]) h
  simp [withoutContentHash, ConsolidationCompilation.canonicalMembers, List.cons_append, List.nil_append, List.filter_cons, member,
    optMember, literalMember, -Option.map_eq_map] at this
  simp only [List.forall₂_cons, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
    optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
  rw [ConsolidationCompilation.ext_iff]
  simpa using this

/-- The body of a consolidation compilation does not read its content hash. -/
theorem ConsolidationCompilation.bodyValue_contentHash (a : ConsolidationCompilation) (hash : ContentHash) :
    bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash, ConsolidationCompilation.canonicalMembers, member, optMember,
    literalMember]

/-- Two values of a consolidation compilation whose bodies hash equal under the same type name are the same but for
their content hash, or a collision of SHA-256 is in hand. -/
theorem ConsolidationCompilation.accountingBodyHash_inj_or_collision {type : String} {a b : ConsolidationCompilation}
    (h : accountingBodyHash type a = accountingBodyHash type b) :
    { a with contentHash := b.contentHash } = b ∨ HashCollision :=
  (Rastrata.Kernel.accountingBodyHash_inj_or_collision h).imp (fun h => ConsolidationCompilation.bodyValue_equiv h.2) _root_.id

/-! ## Policies -/

/-- Two policies with the same hash are the same policy, every field of it and of the artifacts
it nests (their content hashes included), or a collision of SHA-256 is in hand. -/
theorem hashAccountingPolicy_inj_or_collision {p q : AccountingPolicy}
    (h : hashAccountingPolicy p = hashAccountingPolicy q) : p = q ∨ HashCollision :=
  (accountingHash_inj_or_collision h).imp (fun h => h.2) _root_.id

/-- A policy's hash is a function of its content. -/
theorem hashAccountingPolicy_congr {p q : AccountingPolicy} (h : p = q) :
    hashAccountingPolicy p = hashAccountingPolicy q := h ▸ rfl

/-! ## The snapshot -/

/-- JavaScript's `<=` on two strings holds exactly when the first is before the second by UTF-16
code unit, or they are the same string. -/
private theorem jsStringLe_iff_core (a b : String) :
    jsStringLe a b = true ↔ compareCanonicalText a b = .lt ∨ a = b := by
  unfold jsStringLe
  have h2 := compareCanonicalText_eq_iff a b
  cases hc : compareCanonicalText a b
  · simp
  · simp [h2.mp hc]
  · have hne : a ≠ b := fun hab => by rw [h2.mpr hab] at hc; cases hc
    simp [hne]

private theorem jsStringLe_total_core (a b : String) :
    (jsStringLe a b || jsStringLe b a) = true := by
  rw [Bool.or_eq_true, jsStringLe_iff_core, jsStringLe_iff_core]
  have h1 := compareCanonicalText_antisymm b a
  have h2 := compareCanonicalText_eq_iff a b
  cases hc : compareCanonicalText a b
  · exact Or.inl (Or.inl rfl)
  · exact Or.inl (Or.inr (h2.mp hc))
  · exact Or.inr (Or.inl (h1.mpr hc))

private theorem jsStringLe_trans_core (a b c : String) (hab : jsStringLe a b = true)
    (hbc : jsStringLe b c = true) : jsStringLe a c = true := by
  rw [jsStringLe_iff_core] at *
  rcases hab with hab | rfl
  · rcases hbc with hbc | rfl
    · exact Or.inl (compareCanonicalText_trans a b c hab hbc)
    · exact Or.inl hab
  · exact hbc

private theorem jsStringLe_antisymm_core {a b : String} (hab : jsStringLe a b = true)
    (hba : jsStringLe b a = true) : a = b := by
  rw [jsStringLe_iff_core] at *
  rcases hab with hab | rfl
  · rcases hba with hba | rfl
    · have := (compareCanonicalText_antisymm a b).mp hab
      rw [hba] at this
      cases this
    · rfl
  · rfl

private theorem jsStringLe_refl_core (a : String) : jsStringLe a a = true :=
  (jsStringLe_iff_core a a).mpr (Or.inr rfl)

/-- Sorting keeps every policy, as many times as it was there. -/
theorem sortAccountingPolicies_perm (policies : List AccountingPolicy) :
    (sortAccountingPolicies policies).Perm policies :=
  List.mergeSort_perm policies _

/-- The sorted policies are in the order of their keys. -/
theorem sortAccountingPolicies_pairwise (policies : List AccountingPolicy) :
    (sortAccountingPolicies policies).Pairwise fun a b =>
      jsStringLe (accountingPolicySortKey a) (accountingPolicySortKey b) = true :=
  List.pairwise_mergeSort
    (le := fun a b => jsStringLe (accountingPolicySortKey a) (accountingPolicySortKey b))
    (fun _ _ _ => jsStringLe_trans_core _ _ _) (fun _ _ => jsStringLe_total_core _ _) policies

/-- The record a snapshot hashes is the object of its type and its sorted policies' hashes. -/
theorem accountingPolicySnapshotValue_eq (policies : List AccountingPolicy) :
    accountingPolicySnapshotValue policies =
      object [literalMember "type" "AccountingPolicySnapshot",
        member "policyHashes" ((sortAccountingPolicies policies).map hashAccountingPolicy)] := by
  simp only [accountingPolicySnapshotValue, object, objectEntries, literalMember, member,
    List.filterMap_cons, List.filterMap_nil, Option.map_some]
  show _ = CanonicalValue.record [_, ("policyHashes", CanonicalValue.array
    (((sortAccountingPolicies policies).map hashAccountingPolicy).map canonicalize))]
  rw [List.map_map]
  rfl

/-- The record a snapshot hashes is well formed. -/
theorem accountingPolicySnapshotValue_wf (policies : List AccountingPolicy) :
    (accountingPolicySnapshotValue policies).WF := by
  rw [accountingPolicySnapshotValue_eq]
  exact object_wf_of (by simp [literalMember, member])
    (by simp only [List.forall_mem_cons, literalMember_wf, member_wf, List.not_mem_nil,
      IsEmpty.forall_iff, implies_true, and_self])

/-- Two snapshots with the same hash hold, once sorted, the same policies in the same order, or a
collision of SHA-256 is in hand. -/
theorem hashAccountingPolicySnapshot_inj_or_collision {ps qs : List AccountingPolicy}
    (h : hashAccountingPolicySnapshot ps = hashAccountingPolicySnapshot qs) :
    sortAccountingPolicies ps = sortAccountingPolicies qs ∨ HashCollision := by
  by_cases hcollision : HashCollision
  · exact Or.inr hcollision
  · left
    rcases hashCanonical_inj_or_collision (accountingPolicySnapshotValue_wf ps)
      (accountingPolicySnapshotValue_wf qs) h with hequiv | hc
    · rw [accountingPolicySnapshotValue_eq, accountingPolicySnapshotValue_eq] at hequiv
      have := object_equiv_forall₂
        (members₁ := [literalMember "type" "AccountingPolicySnapshot",
          member "policyHashes" ((sortAccountingPolicies ps).map hashAccountingPolicy)])
        (members₂ := [literalMember "type" "AccountingPolicySnapshot",
          member "policyHashes" ((sortAccountingPolicies qs).map hashAccountingPolicy)])
        rfl (by simp [literalMember, member]) hequiv
      simp only [List.forall₂_cons, literalMember, member, optEquiv_literal_iff,
        optEquiv_some_canonicalize_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
      exact List.map_injective_iff.mpr
        (fun p q hpq => (hashAccountingPolicy_inj_or_collision hpq).resolve_right hcollision) this
    · exact absurd hc hcollision

/-- Two snapshots with the same hash hold the same policies, up to their order, or a collision of
SHA-256 is in hand. -/
theorem hashAccountingPolicySnapshot_perm_or_collision {ps qs : List AccountingPolicy}
    (h : hashAccountingPolicySnapshot ps = hashAccountingPolicySnapshot qs) :
    ps.Perm qs ∨ HashCollision :=
  (hashAccountingPolicySnapshot_inj_or_collision h).imp
    (fun (hs : sortAccountingPolicies ps = sortAccountingPolicies qs) =>
      (sortAccountingPolicies_perm ps).symm.trans
      (hs ▸ sortAccountingPolicies_perm qs)) _root_.id

/-- Policies whose sort keys are distinct sort to the same list whatever order they are given
in. -/
theorem sortAccountingPolicies_eq_of_perm {ps qs : List AccountingPolicy} (hp : ps.Perm qs)
    (hkeys : (ps.map accountingPolicySortKey).Nodup) :
    sortAccountingPolicies ps = sortAccountingPolicies qs := by
  apply List.Perm.eq_of_pairwise
    (le := fun a b => jsStringLe (accountingPolicySortKey a) (accountingPolicySortKey b) = true)
  · intro a b ha hb hab hba
    have hk := jsStringLe_antisymm_core hab hba
    have ha' : a ∈ ps := (sortAccountingPolicies_perm ps).subset ha
    have hb' : b ∈ ps := hp.symm.subset ((sortAccountingPolicies_perm qs).subset hb)
    exact List.inj_on_of_nodup_map hkeys ha' hb' hk
  · exact sortAccountingPolicies_pairwise ps
  · exact sortAccountingPolicies_pairwise qs
  · exact (sortAccountingPolicies_perm ps).trans (hp.trans (sortAccountingPolicies_perm qs).symm)

/-- The hash of a snapshot does not depend on the order its policies are given in, when no two
of them share a kind, an identifier and a version. -/
theorem hashAccountingPolicySnapshot_perm {ps qs : List AccountingPolicy} (hp : ps.Perm qs)
    (hkeys : (ps.map accountingPolicySortKey).Nodup) :
    hashAccountingPolicySnapshot ps = hashAccountingPolicySnapshot qs := by
  unfold hashAccountingPolicySnapshot accountingPolicySnapshotValue
  rw [sortAccountingPolicies_eq_of_perm hp hkeys]

/-- The hash of a snapshot does depend on the order its policies are given in when two different
policies share a kind, an identifier and a version: the stable sort keeps them in the order given,
and the two orders hash differently unless a collision of SHA-256 is in hand. -/
theorem hashAccountingPolicySnapshot_order_dependent {p q : AccountingPolicy}
    (hkey : accountingPolicySortKey p = accountingPolicySortKey q) (hne : p ≠ q)
    (h : hashAccountingPolicySnapshot [p, q] = hashAccountingPolicySnapshot [q, p]) :
    HashCollision := by
  rcases hashAccountingPolicySnapshot_inj_or_collision h with hs | hc
  · exfalso
    have hle : ∀ a b : AccountingPolicy, accountingPolicySortKey a = accountingPolicySortKey b →
        sortAccountingPolicies [a, b] = [a, b] := by
      intro a b hab
      apply List.mergeSort_of_pairwise
      simp [hab, jsStringLe_refl_core]
    rw [hle p q hkey, hle q p hkey.symm] at hs
    exact hne (List.cons.inj hs).1
  · exact hc

/-- Two different policies with the same sort key exist: two inventory cost policies that differ
only in their method. So the order dependence above is reachable; `createAccountingPolicySnapshot`
does not reject such a pair. -/
theorem accountingPolicySortKey_collision_exists :
    ∃ p q : AccountingPolicy, accountingPolicySortKey p = accountingPolicySortKey q ∧ p ≠ q ∧
      verifyAccountingPolicyArtifacts [p, q] = true :=
  ⟨.inventoryCost { (default : InventoryCostPolicy) with method := .fifo },
    .inventoryCost { (default : InventoryCostPolicy) with method := .lifo }, rfl,
    by simp, rfl⟩

/-! ## State and effects -/

/-- The canonical value of a state determines the state: two states whose canonical values hash
equal are the same state, every collection in the same order, or a collision is in hand. -/
theorem hashCanonical_canonicalAccountingStateValue_inj_or_collision
    {s t : AccountingCanonicalState}
    (h : hashCanonical (canonicalAccountingStateValue s) =
      hashCanonical (canonicalAccountingStateValue t)) : s = t ∨ HashCollision :=
  (hashCanonical_inj_or_collision (LawfulCanonicalize.wf s) (LawfulCanonicalize.wf t) h).imp
    LawfulCanonicalize.inj _root_.id

/-- The canonical value of an effect is the object `{ type, value }` `canonicalize` writes. -/
theorem canonicalAccountingEffectValue_eq (effect : AccountingEffect) :
    canonicalAccountingEffectValue effect = canonicalize effect := rfl

/-- The canonical value of an effect determines the effect: two effects whose canonical values
hash equal are the same effect, or a collision is in hand. -/
theorem hashCanonical_canonicalAccountingEffectValue_inj_or_collision {e f : AccountingEffect}
    (h : hashCanonical (canonicalAccountingEffectValue e) =
      hashCanonical (canonicalAccountingEffectValue f)) : e = f ∨ HashCollision :=
  (hashCanonical_inj_or_collision (LawfulCanonicalize.wf e) (LawfulCanonicalize.wf f) h).imp
    LawfulCanonicalize.inj _root_.id

end Rastrata.Kernel

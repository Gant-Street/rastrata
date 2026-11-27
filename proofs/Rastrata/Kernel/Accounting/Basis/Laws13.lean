/-
What the hashes of a read snapshot and a report population say about the configuration snapshot they
cover. Its canonical value is the same for two snapshots exactly when they have the same content: every
field the same, and the entries of `requiredDimensionIdsByPosting` the same in some order (a record's
entries are sorted when it is written, so their order is not part of the value). Equal hashes therefore
mean the same hashed content with configuration snapshots that are the same but for that order, or a
collision of SHA-256.
-/
import Rastrata.Kernel.Accounting.Basis.Laws12

namespace Rastrata.Kernel

/-! ## The configuration snapshot, up to the order of a record -/

/-- A record of identifiers is the same as another exactly when its entries are the other's, in
some order. -/
theorem requiredDimensionIdsByPostingValue_equiv_iff
    (es es' : List (String × List DimensionId)) :
    (requiredDimensionIdsByPostingValue es).Equiv (requiredDimensionIdsByPostingValue es') ↔
      es.Perm es' := by
  let f : String × List DimensionId → String × CanonicalValue :=
    fun entry => (entry.1, canonicalize entry.2)
  have hf : Function.Injective f := by
    intro a b hab
    simp only [f, Prod.mk.injEq] at hab
    exact Prod.ext hab.1 ((canonicalize_eq_iff _ _).mp hab.2)
  have key : ∀ (zs : List (String × CanonicalValue)) (es'' : List (String × List DimensionId)),
      (∀ z ∈ zs, ∃ e, f e = z) → CanonicalValue.EquivEntries zs (es''.map f) → zs = es''.map f := by
    intro zs
    induction zs with
    | nil =>
      intro es'' _ h
      cases es'' with
      | nil => rfl
      | cons _ _ => simp [CanonicalValue.EquivEntries] at h
    | cons z rest ih =>
      intro es'' hz h
      cases es'' with
      | nil => simp [CanonicalValue.EquivEntries] at h
      | cons e' es''' =>
        obtain ⟨e₁, he₁⟩ := hz z (by simp)
        obtain ⟨k, v⟩ := z
        obtain ⟨hk, hv, hrest⟩ := h
        simp only [f, Prod.mk.injEq] at he₁
        obtain ⟨rfl, rfl⟩ := he₁
        have hids : e₁.2 = e'.2 := (optEquiv_some_canonicalize_iff e₁.2 e'.2).mp hv
        have hpair : f e₁ = f e' := by
          simp only [f, Prod.mk.injEq]
          exact ⟨hk, by rw [hids]⟩
        have := ih es''' (fun z' hz' => hz z' (by simp [hz'])) hrest
        show f e₁ :: rest = (e' :: es''').map f
        rw [List.map_cons, hpair, this]
  constructor
  · rintro ⟨zs, hperm, hent⟩
    have hmem : ∀ z ∈ zs, ∃ e, f e = z := by
      intro z hz
      obtain ⟨e, -, he⟩ := List.mem_map.mp (hperm.symm.subset hz)
      exact ⟨e, he⟩
    have hzs := key zs es' hmem hent
    rw [hzs] at hperm
    exact (List.map_perm_map_iff hf).mp hperm
  · intro hperm
    unfold requiredDimensionIdsByPostingValue
    exact ⟨es'.map f, hperm.map f, CanonicalValue.EquivEntries_refl _⟩


/-- Two admission snapshots with the same content: every field the same, and the entries of
`requiredDimensionIdsByPosting` the same in some order. -/
structure JournalAdmissionSnapshot.SameContent (a b : JournalAdmissionSnapshot) : Prop where
  bookId : a.bookId = b.bookId
  functionalCommodityId : a.functionalCommodityId = b.functionalCommodityId
  accounts : a.accounts = b.accounts
  dimensions : a.dimensions = b.dimensions
  dimensionMembers : a.dimensionMembers = b.dimensionMembers
  requiredDimensionIds : a.requiredDimensionIds = b.requiredDimensionIds
  requiredDimensionIdsByPosting :
    match a.requiredDimensionIdsByPosting, b.requiredDimensionIdsByPosting with
    | none, none => True
    | some entries, some entries' => entries.Perm entries'
    | _, _ => False

/-- Admission snapshots with equivalent canonical values have the same content. -/
theorem JournalAdmissionSnapshot.sameContent_of_equiv {a b : JournalAdmissionSnapshot}
    (h : (canonicalize a).Equiv (canonicalize b)) : a.SameContent b := by
  have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
    rfl (by simp [JournalAdmissionSnapshot.canonicalMembers, Rastrata.Kernel.member]) h
  simp only [JournalAdmissionSnapshot.canonicalMembers, List.forall₂_cons,
    List.forall₂_nil_left_iff, and_true, Rastrata.Kernel.member,
    optEquiv_some_canonicalize_iff] at this
  obtain ⟨h1, h2, h3, h4, h5, h6, h7⟩ := this
  refine ⟨h1, h2, h3, h4, h5, h6, ?_⟩
  cases ha : a.requiredDimensionIdsByPosting <;> cases hb : b.requiredDimensionIdsByPosting <;>
    simp only [ha, hb, Option.map_none, Option.map_some, OptEquiv] at h7 ⊢
  exact (requiredDimensionIdsByPostingValue_equiv_iff _ _).mp h7


/-- Admission snapshots with the same content have equivalent canonical values. -/
theorem JournalAdmissionSnapshot.equiv_of_sameContent {a b : JournalAdmissionSnapshot}
    (h : a.SameContent b) : (canonicalize a).Equiv (canonicalize b) := by
  show (object a.canonicalMembers).Equiv (object b.canonicalMembers)
  apply object_equiv_of_forall₂
  simp only [JournalAdmissionSnapshot.canonicalMembers, List.forall₂_cons,
    List.forall₂_nil_left_iff, and_true, Rastrata.Kernel.member, OptEquiv, true_and]
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · rw [h.bookId]; exact CanonicalValue.Equiv_refl _
  · rw [h.functionalCommodityId]; exact CanonicalValue.Equiv_refl _
  · rw [h.accounts]; exact CanonicalValue.Equiv_refl _
  · rw [h.dimensions]; exact CanonicalValue.Equiv_refl _
  · rw [h.dimensionMembers]; exact CanonicalValue.Equiv_refl _
  · rw [h.requiredDimensionIds]; exact CanonicalValue.Equiv_refl _
  · have hr := h.requiredDimensionIdsByPosting
    cases ha : a.requiredDimensionIdsByPosting <;> cases hb : b.requiredDimensionIdsByPosting <;>
      simp only [ha, hb] at hr ⊢
    · trivial
    · exact (requiredDimensionIdsByPostingValue_equiv_iff _ _).mpr hr


/-- Two configuration snapshots with the same content: every field the same, the admission snapshots
the same in the sense above. -/
structure BookConfigurationSnapshot.SameContent (a b : BookConfigurationSnapshot) : Prop where
  revision : a.revision = b.revision
  effectiveAt : a.effectiveAt = b.effectiveAt
  executionProfile : a.executionProfile = b.executionProfile
  stateCommitmentProfile : a.stateCommitmentProfile = b.stateCommitmentProfile
  periods : a.periods = b.periods
  admissionSnapshot : a.admissionSnapshot.SameContent b.admissionSnapshot
  policies : a.policies = b.policies
  quantizationPolicies : a.quantizationPolicies = b.quantizationPolicies
  accountingPolicySnapshot : a.accountingPolicySnapshot = b.accountingPolicySnapshot
  contentHash : a.contentHash = b.contentHash

/-- Configuration snapshots with equivalent canonical values have the same content. -/
theorem BookConfigurationSnapshot.sameContent_of_equiv {a b : BookConfigurationSnapshot}
    (h : (canonicalize a).Equiv (canonicalize b)) : a.SameContent b := by
  have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
    rfl (by simp [BookConfigurationSnapshot.canonicalMembers, Rastrata.Kernel.member, optMember]) h
  simp only [BookConfigurationSnapshot.canonicalMembers, List.forall₂_cons,
    List.forall₂_nil_left_iff, and_true, Rastrata.Kernel.member, optMember,
    optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff] at this
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10⟩ := this
  exact ⟨h1, h2, h3, h4, h5, JournalAdmissionSnapshot.sameContent_of_equiv h6, h7, h8, h9, h10⟩

/-- Configuration snapshots with the same content have equivalent canonical values. -/
theorem BookConfigurationSnapshot.equiv_of_sameContent {a b : BookConfigurationSnapshot}
    (h : a.SameContent b) : (canonicalize a).Equiv (canonicalize b) := by
  show (object a.canonicalMembers).Equiv (object b.canonicalMembers)
  apply object_equiv_of_forall₂
  simp only [BookConfigurationSnapshot.canonicalMembers, List.forall₂_cons,
    List.forall₂_nil_left_iff, and_true, Rastrata.Kernel.member, optMember, true_and]
  refine ⟨(optEquiv_some_canonicalize_iff _ _).mpr h.revision,
    (optEquiv_some_canonicalize_iff _ _).mpr h.effectiveAt,
    (optEquiv_map_canonicalize_iff _ _).mpr h.executionProfile,
    (optEquiv_map_canonicalize_iff _ _).mpr h.stateCommitmentProfile,
    (optEquiv_some_canonicalize_iff _ _).mpr h.periods,
    JournalAdmissionSnapshot.equiv_of_sameContent h.admissionSnapshot,
    (optEquiv_some_canonicalize_iff _ _).mpr h.policies,
    (optEquiv_some_canonicalize_iff _ _).mpr h.quantizationPolicies,
    (optEquiv_some_canonicalize_iff _ _).mpr h.accountingPolicySnapshot,
    (optEquiv_some_canonicalize_iff _ _).mpr h.contentHash⟩

/-- Configuration snapshots have equivalent canonical values exactly when they have the same content. -/
theorem BookConfigurationSnapshot.equiv_iff_sameContent (a b : BookConfigurationSnapshot) :
    (canonicalize a).Equiv (canonicalize b) ↔ a.SameContent b :=
  ⟨BookConfigurationSnapshot.sameContent_of_equiv, BookConfigurationSnapshot.equiv_of_sameContent⟩

/-- Two snapshot bodies whose configuration snapshots have distinct keys and whose hashes are equal have
the same hashed content, and their configuration snapshots have the same content (every field the same,
the entries of `requiredDimensionIdsByPosting` the same in some order), or a collision of SHA-256 is in
hand. -/
theorem hashAccountingReadSnapshot_inj_or_collision_content {a b : AccountingReadSnapshotBody}
    (ha : a.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (hb : b.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (h : hashAccountingReadSnapshot a = hashAccountingReadSnapshot b) :
    (a.SameHashedContent b ∧ a.configurationSnapshot.SameContent b.configurationSnapshot) ∨
      HashCollision := by
  rcases hashAccountingReadSnapshot_inj_or_collision ha hb h with hs | hc
  · exact Or.inl ⟨hs, BookConfigurationSnapshot.sameContent_of_equiv hs.configurationSnapshot⟩
  · exact Or.inr hc

/-- Two report populations whose configuration snapshots have distinct keys and whose hashes are equal
have the same hashed content, and their configuration snapshots have the same content, or a collision of
SHA-256 is in hand. -/
theorem hashAccountingReadPopulation_inj_or_collision_content {a b : AccountingReadPopulation}
    (ha : a.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (hb : b.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (h : hashAccountingReadPopulation a = hashAccountingReadPopulation b) :
    (a.SameHashedContent b ∧ a.configurationSnapshot.SameContent b.configurationSnapshot) ∨
      HashCollision := by
  rcases hashAccountingReadPopulation_inj_or_collision ha hb h with hs | hc
  · exact Or.inl ⟨hs, BookConfigurationSnapshot.sameContent_of_equiv hs.configurationSnapshot⟩
  · exact Or.inr hc

end Rastrata.Kernel

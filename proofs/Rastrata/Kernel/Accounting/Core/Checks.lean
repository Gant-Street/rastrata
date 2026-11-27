/-
Laws of the small checks of `accounting.ts` (law 5 of the brief of `Accounting/Core.lean`):
`reject`, `drafted`, `validAccountingDerivation`, `rejectExternalAccountingAuthority`,
`supportsInventoryValueAdjustmentAlgorithm`, `usesStructuralTaxGrouping`,
`usesCumulativeAllocation` and `policyAt`.

- `reject` and `drafted` are exactly the two calculations (`reject_eq`, `drafted_eq`), and a draft
  is constructible exactly when its journals and effects are.
- `validAccountingDerivation` accepts exactly an approved derivation with evidence whose
  `recordedAt` `Date.parse` reads (`validAccountingDerivation_iff`), which every constructible
  instant is (`validAccountingDerivation_iff_of_wf`); one theorem for each reason it refuses.
- `rejectExternalAccountingAuthority` returns one diagnostic whose path names the attempt.
- `policyAt` selects a policy exactly when exactly one policy matches the kind, identifier, version
  and instant, and that one is executable (`policyAt_selected_iff`); otherwise it rejects with the
  one diagnostic of its kind (`policyAt_rejected_iff`). The result does not depend on the order of
  the policies (`policyAt_perm`). It compares instants as texts, which is not their order in time
  (`policyAt_instants_compared_as_text`).
-/
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

/-! ## `reject` and `drafted` -/

/-- `reject` is the rejection with that one diagnostic. -/
theorem reject_eq (code : SemanticDiagnosticCode) (path message : String)
    (requirements : List String) :
    reject code path message requirements =
      .rejected [{ code, path, message, requirementIds := requirements }] := rfl

/-- `drafted` is the draft of those journals and effects. -/
theorem drafted_eq (journals : List ExactPreparedJournal) (effects : List AccountingEffect) :
    drafted journals effects = .draft { journals, effects } := rfl

/-- Two drafts are the same exactly when their journals and their effects are. -/
theorem drafted_inj {j₁ j₂ : List ExactPreparedJournal} {e₁ e₂ : List AccountingEffect} :
    drafted j₁ e₁ = drafted j₂ e₂ ↔ j₁ = j₂ ∧ e₁ = e₂ := by
  simp [drafted_eq]

/-- A rejection is never a draft. -/
theorem reject_ne_drafted (code : SemanticDiagnosticCode) (path message : String)
    (requirements : List String) (journals : List ExactPreparedJournal)
    (effects : List AccountingEffect) :
    reject code path message requirements ≠ drafted journals effects := by
  simp [reject_eq, drafted_eq]

/-- A draft is constructible exactly when its journals and effects are. -/
theorem drafted_wf_iff (journals : List ExactPreparedJournal) (effects : List AccountingEffect) :
    (drafted journals effects).WF ↔
      (∀ journal ∈ journals, journal.WF) ∧ ∀ effect ∈ effects, effect.WF :=
  ⟨fun h => ⟨h.journals, h.effects⟩, fun h => ⟨h.1, h.2⟩⟩

/-- A rejection is constructible. -/
theorem reject_wf (code : SemanticDiagnosticCode) (path message : String)
    (requirements : List String) : (reject code path message requirements).WF := trivial

/-! ## `validAccountingDerivation` -/

/-- `validAccountingDerivation` accepts exactly an approved derivation with at least one item of
evidence whose `recordedAt` `Date.parse` reads as a finite number. -/
theorem validAccountingDerivation_iff (derivation : DerivationRecord) :
    validAccountingDerivation derivation = true ↔
      derivation.state = .approved ∧ derivation.evidence ≠ [] ∧
        (dateParse derivation.recordedAt.value).isSome := by
  unfold validAccountingDerivation
  simp [List.length_pos_iff, and_assoc]

/-- `Date.parse` reads every constructible instant. -/
theorem dateParse_isSome_of_wf {i : Instant} (h : i.WF) : (dateParse i.value).isSome := by
  have : instant i.value = .ok i := (instant_ok_iff _ _).mpr ⟨rfl, h⟩
  simp [dateParse, this]

/-- For a constructible `recordedAt`, `validAccountingDerivation` accepts exactly an approved
derivation with at least one item of evidence. -/
theorem validAccountingDerivation_iff_of_wf {derivation : DerivationRecord}
    (h : derivation.recordedAt.WF) :
    validAccountingDerivation derivation = true ↔
      derivation.state = .approved ∧ derivation.evidence ≠ [] := by
  rw [validAccountingDerivation_iff]
  simp [dateParse_isSome_of_wf h]

/-- A derivation that is not approved is refused. -/
theorem validAccountingDerivation_not_approved {derivation : DerivationRecord}
    (h : derivation.state ≠ .approved) : validAccountingDerivation derivation = false := by
  rw [← Bool.not_eq_true, validAccountingDerivation_iff]
  exact fun hv => h hv.1

/-- A derivation without evidence is refused. -/
theorem validAccountingDerivation_no_evidence {derivation : DerivationRecord}
    (h : derivation.evidence = []) : validAccountingDerivation derivation = false := by
  rw [← Bool.not_eq_true, validAccountingDerivation_iff]
  exact fun hv => hv.2.1 h

/-- A derivation whose `recordedAt` `Date.parse` does not read is refused. -/
theorem validAccountingDerivation_unreadable {derivation : DerivationRecord}
    (h : dateParse derivation.recordedAt.value = none) :
    validAccountingDerivation derivation = false := by
  rw [← Bool.not_eq_true, validAccountingDerivation_iff]
  exact fun hv => by simp [h] at hv

/-! ## `rejectExternalAccountingAuthority` -/

/-- `rejectExternalAccountingAuthority` returns one diagnostic, `external_accounting_authority`,
whose path is `external.` and the attempt, with the attempt's requirements. -/
theorem rejectExternalAccountingAuthority_eq (attempt : ExternalAccountingAuthorityAttempt) :
    rejectExternalAccountingAuthority attempt =
      [diagnostic .external_accounting_authority ("external." ++ attempt.text)
        "External workflows may submit evidence and typed commands, but may not exercise canonical accounting authority"
        attempt.requirements] := rfl

/-- The diagnostic names the attempt: two attempts give the same diagnostics only if they are the
same attempt. -/
theorem rejectExternalAccountingAuthority_injective {a b : ExternalAccountingAuthorityAttempt}
    (h : rejectExternalAccountingAuthority a = rejectExternalAccountingAuthority b) : a = b := by
  cases a <;> cases b <;> first | rfl | (simp [rejectExternalAccountingAuthority, diagnostic,
    ExternalAccountingAuthorityAttempt.text] at h)

/-- Every attempt names at least one requirement. -/
theorem rejectExternalAccountingAuthority_requirements_nonempty
    (attempt : ExternalAccountingAuthorityAttempt) : attempt.requirements ≠ [] := by
  cases attempt <;> simp [ExternalAccountingAuthorityAttempt.requirements]

/-! ## Algorithm versions -/

/-- The inventory value adjustment algorithms the kernel supports are 1.0.0, 1.0.1 and 1.0.2. -/
theorem supportsInventoryValueAdjustmentAlgorithm_iff (version : SemanticVersion) :
    supportsInventoryValueAdjustmentAlgorithm version = true ↔
      version.value = "1.0.0" ∨ version.value = "1.0.1" ∨ version.value = "1.0.2" := by
  unfold supportsInventoryValueAdjustmentAlgorithm inventoryValueAdjustmentAlgorithmVersion
  cases version
  simp [or_assoc]

/-- Structural tax grouping is used exactly when the policy names it and its algorithm version is
1.1.0. -/
theorem usesStructuralTaxGrouping_iff (policy : TaxPolicy) :
    usesStructuralTaxGrouping policy = true ↔
      policy.groupingAlgorithm = some .structuralTaxGroupsV1 ∧
        policy.algorithmVersion.value = "1.1.0" := by
  simp [usesStructuralTaxGrouping]

/-- The cumulative allocation is used exactly when the policy names it and its algorithm version
is 1.1.0. -/
theorem usesCumulativeAllocation_iff (policy : AllocationPolicy) :
    usesCumulativeAllocation policy = true ↔
      policy.postingAlgorithm = some .cumulativePostedAllocationV1 ∧
        policy.algorithmVersion.value = "1.1.0" := by
  unfold usesCumulativeAllocation cumulativeAllocationAlgorithmVersion
  cases policy.algorithmVersion
  simp

/-! ## `policyAt` -/

/-- A policy type whose `ofPolicy?` finds exactly the policies of its kind. -/
class LawfulAccountingPolicyKind (T : Type) [AccountingPolicyKind T] : Prop where
  /-- `ofPolicy?` finds a policy exactly when it is of the type's kind. -/
  ofPolicy?_isSome : ∀ policy : AccountingPolicy,
    (AccountingPolicyKind.ofPolicy? (T := T) policy).isSome = true ↔
      policy.kind = AccountingPolicyKind.kind T

instance : LawfulAccountingPolicyKind InventoryCostPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind InventoryValueAdjustmentPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind AccountingBasisPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind MonetaryClassificationPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind CurrencyPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind AllocationPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind TaxPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩
instance : LawfulAccountingPolicyKind ConsolidationPolicy :=
  ⟨fun policy => by
    cases policy <;> constructor <;> intro h <;> first | rfl | cases h⟩

/-- A policy the filter of `policyAt` keeps is of the kind asked for. -/
theorem policyMatches_kind {kind : AccountingFeature} {id : PolicyId} {version : SemanticVersion}
    {at_ : Instant} {policy : AccountingPolicy} (h : policyMatches kind id version at_ policy = true) :
    policy.kind = kind := by
  unfold policyMatches at h
  simp only [Bool.and_eq_true, beq_iff_eq] at h
  exact h.1.1.1.1

/-- The filter of `policyAt` keeps a policy exactly when it has the kind, identifier and version
asked for, starts at or before the instant and ends after it, the instants compared as texts. -/
theorem policyMatches_iff (kind : AccountingFeature) (id : PolicyId) (version : SemanticVersion)
    (at_ : Instant) (policy : AccountingPolicy) :
    policyMatches kind id version at_ policy = true ↔
      policy.kind = kind ∧ policy.id = id ∧ policy.version = version ∧
        jsStringLe policy.validFrom.value at_.value = true ∧
        ∀ validTo, policy.validTo = some validTo → jsStringLt at_.value validTo.value = true := by
  unfold policyMatches
  cases hto : policy.validTo <;> simp [and_assoc]

/-- `policyAt` without its `let`. -/
theorem policyAt_def (T : Type) [AccountingPolicyKind T] (policies : List AccountingPolicy)
    (id : PolicyId) (version : SemanticVersion) (at_ : Instant) :
    policyAt T policies id version at_ =
      match policies.filter (policyMatches (AccountingPolicyKind.kind T) id version at_) with
      | [selected] =>
        if policyExecutable (AccountingPolicyKind.kind T) selected then
          match AccountingPolicyKind.ofPolicy? selected with
          | some policy => .selected policy
          | none => .rejected [policyAtDiagnostic (AccountingPolicyKind.kind T)]
        else .rejected [policyAtDiagnostic (AccountingPolicyKind.kind T)]
      | _ => .rejected [policyAtDiagnostic (AccountingPolicyKind.kind T)] := rfl

/-- `policyAt` selects a policy exactly when one policy, and only one, has the kind, identifier and
version asked for and is valid at the instant, that one is executable (`policyExecutable`), and the
selected policy is it. -/
theorem policyAt_selected_iff (T : Type) [AccountingPolicyKind T] (policies : List AccountingPolicy)
    (id : PolicyId) (version : SemanticVersion) (at_ : Instant) (policy : T) :
    policyAt T policies id version at_ = .selected policy ↔
      ∃ selected, policies.filter (policyMatches (AccountingPolicyKind.kind T) id version at_) =
          [selected] ∧
        policyExecutable (AccountingPolicyKind.kind T) selected = true ∧
        AccountingPolicyKind.ofPolicy? selected = some policy := by
  rw [policyAt_def]
  constructor
  · intro h
    split at h
    · rename_i selected hf
      split at h
      · rename_i hex
        split at h
        · rename_i found hfound
          cases h
          exact ⟨selected, hf, hex, hfound⟩
        · cases h
      · cases h
    · cases h
  · rintro ⟨selected, hf, hex, hof⟩
    simp only [hf, hex, hof, ↓reduceIte]

/-- `policyAt` rejects exactly when no single valid policy of the kind, identifier and version is
executable, and then with the one diagnostic of its kind. -/
theorem policyAt_rejected_iff (T : Type) [AccountingPolicyKind T] [LawfulAccountingPolicyKind T]
    (policies : List AccountingPolicy) (id : PolicyId) (version : SemanticVersion) (at_ : Instant)
    (diagnostics : List SemanticDiagnostic) :
    policyAt T policies id version at_ = .rejected diagnostics ↔
      diagnostics = [policyAtDiagnostic (AccountingPolicyKind.kind T)] ∧
        ¬ ∃ selected, policies.filter (policyMatches (AccountingPolicyKind.kind T) id version at_) =
            [selected] ∧ policyExecutable (AccountingPolicyKind.kind T) selected = true := by
  have hsome : ∀ selected, policies.filter
      (policyMatches (AccountingPolicyKind.kind T) id version at_) = [selected] →
      ∃ found, AccountingPolicyKind.ofPolicy? (T := T) selected = some found := by
    intro selected hf
    have hmem : selected ∈ policies.filter
        (policyMatches (AccountingPolicyKind.kind T) id version at_) := by simp [hf]
    have hk := policyMatches_kind (List.mem_filter.mp hmem).2
    exact Option.isSome_iff_exists.mp ((LawfulAccountingPolicyKind.ofPolicy?_isSome _).mpr hk)
  rw [policyAt_def]
  constructor
  · intro h
    split at h
    · rename_i selected hf
      split at h
      · rename_i hex
        obtain ⟨found, hfound⟩ := hsome selected hf
        rw [hfound] at h
        cases h
      · cases h
        refine ⟨rfl, fun ⟨s, hs, hex'⟩ => ?_⟩
        rw [hf] at hs
        cases hs
        contradiction
    · rename_i hnot
      cases h
      exact ⟨rfl, fun ⟨s, hs, _⟩ => hnot s hs⟩
  · rintro ⟨rfl, hnone⟩
    split
    · rename_i selected hf
      have hex : policyExecutable (AccountingPolicyKind.kind T) selected = false := by
        cases hx : policyExecutable (AccountingPolicyKind.kind T) selected
        · rfl
        · exact absurd ⟨selected, hf, hx⟩ hnone
      simp [hex]
    · rfl

/-- The diagnostic of `policyAt` is `inventory_cost_policy_incoherent` for inventory cost policies
and `unresolved_accounting_input` for every other kind. -/
theorem policyAtDiagnostic_code (kind : AccountingFeature) :
    (policyAtDiagnostic kind).code =
      if kind = .inventoryCost then .inventory_cost_policy_incoherent
      else .unresolved_accounting_input := rfl

/-- What `policyAt` answers does not depend on the order the policies are given in. -/
theorem policyAt_perm (T : Type) [AccountingPolicyKind T] {policies others : List AccountingPolicy}
    (hperm : policies.Perm others) (id : PolicyId) (version : SemanticVersion) (at_ : Instant) :
    policyAt T policies id version at_ = policyAt T others id version at_ := by
  have hp := hperm.filter (policyMatches (AccountingPolicyKind.kind T) id version at_)
  rw [policyAt_def, policyAt_def]
  rcases hps : policies.filter (policyMatches (AccountingPolicyKind.kind T) id version at_) with
    _ | ⟨q, _ | ⟨r, rest⟩⟩
  · rw [hps] at hp
    rw [List.nil_perm.mp hp]
  · rw [hps] at hp
    rw [List.perm_singleton.mp hp.symm]
  · rw [hps] at hp
    have hlen := hp.length_eq
    rcases hos : others.filter (policyMatches (AccountingPolicyKind.kind T) id version at_) with
      _ | ⟨a, _ | ⟨b, tail⟩⟩ <;> first | rfl | (rw [hos] at hlen; simp at hlen)

/-- `policyAt` compares instants as texts (`policy.validFrom <= at`), which is not their order in
time. A policy valid from 01:00 at UTC+2 (23:00 UTC the day before) is not valid at 00:30 UTC,
which `Date.parse` reads as 1.5 hours later; and a policy valid from 00:30 UTC is valid at 01:00
at UTC+2, which is 1.5 hours earlier. -/
theorem policyAt_instants_compared_as_text :
    dateParse "2024-01-01T01:00:00+02:00" = some 1704063600000 ∧
      dateParse "2024-01-01T00:30:00Z" = some 1704069000000 ∧
      policyMatches .inventoryCost default default ⟨"2024-01-01T00:30:00Z"⟩
          (.inventoryCost { (default : InventoryCostPolicy) with
            validFrom := ⟨"2024-01-01T01:00:00+02:00"⟩, validTo := none }) = false ∧
      policyMatches .inventoryCost default default ⟨"2024-01-01T01:00:00+02:00"⟩
          (.inventoryCost { (default : InventoryCostPolicy) with
            validFrom := ⟨"2024-01-01T00:30:00Z"⟩, validTo := none }) = true := by
  decide +kernel

end Rastrata.Kernel

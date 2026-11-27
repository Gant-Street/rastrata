/-
The ways a call of `projectAccountingBasis` can end, and the conditions that lead to each.
-/
import Rastrata.Kernel.Accounting.Basis.Laws1

namespace Rastrata.Kernel

/-! ## The exits of `projectAccountingBasis` -/

/-- The nine rejections of `projectAccountingBasis` have nine different diagnostics. -/
theorem basisDiagnostics_ne :
    basisPolicyDiagnostic ≠ basisBoundDiagnostic ∧ basisPolicyDiagnostic ≠ basisIdentityDiagnostic ∧
    basisPolicyDiagnostic ≠ basisSnapshotDiagnostic ∧ basisPolicyDiagnostic ≠ basisRuleDiagnostic ∧
    basisPolicyDiagnostic ≠ basisGraphDiagnostic ∧ basisPolicyDiagnostic ≠ basisRatioDiagnostic ∧
    basisPolicyDiagnostic ≠ basisReconciliationDiagnostic ∧
    basisBoundDiagnostic ≠ basisIdentityDiagnostic ∧ basisBoundDiagnostic ≠ basisSnapshotDiagnostic ∧
    basisBoundDiagnostic ≠ basisRuleDiagnostic ∧ basisBoundDiagnostic ≠ basisGraphDiagnostic ∧
    basisBoundDiagnostic ≠ basisRatioDiagnostic ∧
    basisBoundDiagnostic ≠ basisReconciliationDiagnostic ∧
    basisIdentityDiagnostic ≠ basisSnapshotDiagnostic ∧ basisIdentityDiagnostic ≠ basisRuleDiagnostic ∧
    basisIdentityDiagnostic ≠ basisGraphDiagnostic ∧ basisIdentityDiagnostic ≠ basisRatioDiagnostic ∧
    basisIdentityDiagnostic ≠ basisReconciliationDiagnostic ∧
    basisSnapshotDiagnostic ≠ basisRuleDiagnostic ∧ basisSnapshotDiagnostic ≠ basisGraphDiagnostic ∧
    basisSnapshotDiagnostic ≠ basisRatioDiagnostic ∧
    basisSnapshotDiagnostic ≠ basisReconciliationDiagnostic ∧
    basisRuleDiagnostic ≠ basisGraphDiagnostic ∧ basisRuleDiagnostic ≠ basisRatioDiagnostic ∧
    basisRuleDiagnostic ≠ basisReconciliationDiagnostic ∧
    basisGraphDiagnostic ≠ basisRatioDiagnostic ∧ basisGraphDiagnostic ≠ basisReconciliationDiagnostic ∧
    basisRatioDiagnostic ≠ basisReconciliationDiagnostic ∧
    (∀ event, basisEventDiagnostic event ≠ basisPolicyDiagnostic ∧
      basisEventDiagnostic event ≠ basisBoundDiagnostic ∧
      basisEventDiagnostic event ≠ basisIdentityDiagnostic ∧
      basisEventDiagnostic event ≠ basisSnapshotDiagnostic ∧
      basisEventDiagnostic event ≠ basisRuleDiagnostic ∧
      basisEventDiagnostic event ≠ basisGraphDiagnostic ∧
      basisEventDiagnostic event ≠ basisRatioDiagnostic ∧
      basisEventDiagnostic event ≠ basisReconciliationDiagnostic) := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_,
    ?_, ?_, ?_, ?_, ?_, ?_, fun event => ?_⟩ <;>
  simp [basisPolicyDiagnostic, basisBoundDiagnostic, basisIdentityDiagnostic,
    basisSnapshotDiagnostic, basisEventDiagnostic, basisRuleDiagnostic, basisGraphDiagnostic,
    basisRatioDiagnostic, basisReconciliationDiagnostic, diagnostic]

/-- Every exit of `projectAccountingBasis`, with the conditions that lead to it, in the order the
function tests them. -/
inductive BasisRun (policies : List AccountingPolicy) (policyIdValue : PolicyId)
    (version : SemanticVersion) (snapshot : AccountingReadSnapshot) :
    Except QuantizeErr BasisProjectionResult → Prop where
  /-- No policy is selected. -/
  | noPolicy {ds : List SemanticDiagnostic}
      (h : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .rejected ds) :
      BasisRun policies policyIdValue version snapshot (.ok (.rejected [basisPolicyDiagnostic]))
  /-- The population is above the bound. -/
  | tooMany {policy : AccountingBasisPolicy}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (h : snapshot.sourceEvents.length > accountingLimits.maxBasisEvents) :
      BasisRun policies policyIdValue version snapshot (.ok (.rejected [basisBoundDiagnostic]))
  /-- The identities of the events fail. -/
  | identity {policy : AccountingBasisPolicy}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (h : populationIdentityRejects snapshot.sourceEvents = true) :
      BasisRun policies policyIdValue version snapshot (.ok (.rejected [basisIdentityDiagnostic]))
  /-- The checks of the snapshot throw. -/
  | snapshotThrows {policy : AccountingBasisPolicy} {code : QuantizeErr}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (h : readSnapshotRejects policy snapshot = .error code) :
      BasisRun policies policyIdValue version snapshot (.error code)
  /-- The snapshot is refused. -/
  | snapshot {policy : AccountingBasisPolicy}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (h : readSnapshotRejects policy snapshot = .ok true) :
      BasisRun policies policyIdValue version snapshot (.ok (.rejected [basisSnapshotDiagnostic]))
  /-- An event does not close over its reference and posting. -/
  | event {policy : AccountingBasisPolicy} {event : BasisSourceEvent}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (hs : readSnapshotRejects policy snapshot = .ok false)
      (h : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) =
        some event) :
      BasisRun policies policyIdValue version snapshot (.ok (.rejected [basisEventDiagnostic event]))
  /-- The loop over the events throws. -/
  | loopThrows {policy : AccountingBasisPolicy} {code : QuantizeErr}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (hs : readSnapshotRejects policy snapshot = .ok false)
      (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
      (h : basisLoop policy snapshot 0 BasisTotals.empty
        (sortBasisEventsById snapshot.sourceEvents) = .error code) :
      BasisRun policies policyIdValue version snapshot (.error code)
  /-- The loop over the events rejects one of them. -/
  | loopRejects {policy : AccountingBasisPolicy} {diagnostic : SemanticDiagnostic}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (hs : readSnapshotRejects policy snapshot = .ok false)
      (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
      (h : basisLoop policy snapshot 0 BasisTotals.empty
        (sortBasisEventsById snapshot.sourceEvents) = .ok (.rejected diagnostic)) :
      BasisRun policies policyIdValue version snapshot (.ok (.rejected [diagnostic]))
  /-- The reconciliation throws. -/
  | reconciliationThrows {policy : AccountingBasisPolicy}
      {entries : List AccountingBasisProjectionEntry} {totals : BasisTotals} {code : QuantizeErr}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (hs : readSnapshotRejects policy snapshot = .ok false)
      (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
      (h : basisLoop policy snapshot 0 BasisTotals.empty
        (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals))
      (hr : reconciliationFails totals = .error code) :
      BasisRun policies policyIdValue version snapshot (.error code)
  /-- The totals do not reconcile. -/
  | reconciliation {policy : AccountingBasisPolicy}
      {entries : List AccountingBasisProjectionEntry} {totals : BasisTotals}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (hs : readSnapshotRejects policy snapshot = .ok false)
      (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
      (h : basisLoop policy snapshot 0 BasisTotals.empty
        (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals))
      (hr : reconciliationFails totals = .ok true) :
      BasisRun policies policyIdValue version snapshot
        (.ok (.rejected [basisReconciliationDiagnostic]))
  /-- The projection is made. -/
  | projected {policy : AccountingBasisPolicy}
      {entries : List AccountingBasisProjectionEntry} {totals : BasisTotals}
      (hp : policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy)
      (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
      (hi : populationIdentityRejects snapshot.sourceEvents = false)
      (hs : readSnapshotRejects policy snapshot = .ok false)
      (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
      (h : basisLoop policy snapshot 0 BasisTotals.empty
        (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals))
      (hr : reconciliationFails totals = .ok false) :
      BasisRun policies policyIdValue version snapshot
        (.ok (.projected (basisProjection policy snapshot
          (sortBasisEventsById snapshot.sourceEvents) entries (basisReconciliation totals))))

/-- A call of `projectAccountingBasis` ends in exactly one of these ways. -/
theorem projectAccountingBasis_run (policies : List AccountingPolicy) (policyIdValue : PolicyId)
    (version : SemanticVersion) (snapshot : AccountingReadSnapshot) :
    BasisRun policies policyIdValue version snapshot
      (projectAccountingBasis policies policyIdValue version snapshot) := by
  unfold projectAccountingBasis
  split
  · rename_i ds h
    exact .noPolicy h
  · rename_i policy hp
    split
    · rename_i h
      exact .tooMany hp (by simpa using h)
    · rename_i hb
      have hb' : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents := by simpa using hb
      split
      · rename_i h
        exact .identity hp hb' h
      · rename_i hi
        have hi' : populationIdentityRejects snapshot.sourceEvents = false := by simpa using hi
        split
        · rename_i code h
          exact .snapshotThrows hp hb' hi' h
        · rename_i h
          exact .snapshot hp hb' hi' h
        · rename_i h
          dsimp only
          split
          · rename_i event hf
            exact .event hp hb' hi' h hf
          · rename_i hf
            split
            · rename_i code hl
              exact .loopThrows hp hb' hi' h hf hl
            · rename_i diagnostic hl
              exact .loopRejects hp hb' hi' h hf hl
            · rename_i entries totals hl
              split
              · rename_i code hr
                exact .reconciliationThrows hp hb' hi' h hf hl hr
              · rename_i hr
                exact .reconciliation hp hb' hi' h hf hl hr
              · rename_i hr
                exact .projected hp hb' hi' h hf hl hr

/-! ## Introduction rules: the conditions that make `projectAccountingBasis` exit each way -/

section Intro

variable {policies : List AccountingPolicy} {policyIdValue : PolicyId} {version : SemanticVersion}
  {snapshot : AccountingReadSnapshot} {policy : AccountingBasisPolicy}

/-- A call whose policy is not selected ends with the policy diagnostic. -/
theorem projectAccountingBasis_of_noPolicy {ds : List SemanticDiagnostic}
    (h : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .rejected ds) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisPolicyDiagnostic]) := by
  unfold projectAccountingBasis
  rw [h]

/-- A call with a selected policy and more events than the bound ends with the bound diagnostic. -/
theorem projectAccountingBasis_of_tooMany
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (h : snapshot.sourceEvents.length > accountingLimits.maxBasisEvents) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisBoundDiagnostic]) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [h]

/-- A call within the bound whose events fail the identity test ends with the identity diagnostic. -/
theorem projectAccountingBasis_of_identity
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (h : populationIdentityRejects snapshot.sourceEvents = true) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisIdentityDiagnostic]) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, h]

/-- A call whose snapshot checks throw ends with that error. -/
theorem projectAccountingBasis_of_snapshotThrows {code : QuantizeErr}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (h : readSnapshotRejects policy snapshot = .error code) :
    projectAccountingBasis policies policyIdValue version snapshot = .error code := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, h]

/-- A call whose snapshot checks refuse the snapshot ends with the snapshot diagnostic. -/
theorem projectAccountingBasis_of_snapshot
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (h : readSnapshotRejects policy snapshot = .ok true) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisSnapshotDiagnostic]) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, h]

/-- A call whose first non-closing event, in identifier order, is `event` ends with the event diagnostic at its path. -/
theorem projectAccountingBasis_of_event {event : BasisSourceEvent}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (hs : readSnapshotRejects policy snapshot = .ok false)
    (h : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) =
      some event) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisEventDiagnostic event]) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, hs, h]

/-- A call whose loop over the events throws ends with that error. -/
theorem projectAccountingBasis_of_loopThrows {code : QuantizeErr}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (hs : readSnapshotRejects policy snapshot = .ok false)
    (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
    (h : basisLoop policy snapshot 0 BasisTotals.empty
      (sortBasisEventsById snapshot.sourceEvents) = .error code) :
    projectAccountingBasis policies policyIdValue version snapshot = .error code := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, hs, hc, h]

/-- A call whose loop rejects an event ends with the diagnostic of the loop. -/
theorem projectAccountingBasis_of_loopRejects {diagnostic : SemanticDiagnostic}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (hs : readSnapshotRejects policy snapshot = .ok false)
    (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
    (h : basisLoop policy snapshot 0 BasisTotals.empty
      (sortBasisEventsById snapshot.sourceEvents) = .ok (.rejected diagnostic)) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [diagnostic]) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, hs, hc, h]

/-- A call whose reconciliation throws ends with that error. -/
theorem projectAccountingBasis_of_reconciliationThrows
    {entries : List AccountingBasisProjectionEntry} {totals : BasisTotals} {code : QuantizeErr}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (hs : readSnapshotRejects policy snapshot = .ok false)
    (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
    (h : basisLoop policy snapshot 0 BasisTotals.empty
      (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals))
    (hr : reconciliationFails totals = .error code) :
    projectAccountingBasis policies policyIdValue version snapshot = .error code := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, hs, hc, h, hr]

/-- A call whose totals fail the reconciliation test ends with the reconciliation diagnostic. -/
theorem projectAccountingBasis_of_reconciliation
    {entries : List AccountingBasisProjectionEntry} {totals : BasisTotals}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (hs : readSnapshotRejects policy snapshot = .ok false)
    (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
    (h : basisLoop policy snapshot 0 BasisTotals.empty
      (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals))
    (hr : reconciliationFails totals = .ok true) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisReconciliationDiagnostic]) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, hs, hc, h, hr]

/-- A call that passes every check ends with the projection of the entries and totals of the loop. -/
theorem projectAccountingBasis_of_projected
    {entries : List AccountingBasisProjectionEntry} {totals : BasisTotals}
    (hp : policyAt AccountingBasisPolicy policies policyIdValue version
      snapshot.policyEffectiveAt = .selected policy)
    (hb : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents)
    (hi : populationIdentityRejects snapshot.sourceEvents = false)
    (hs : readSnapshotRejects policy snapshot = .ok false)
    (hc : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none)
    (h : basisLoop policy snapshot 0 BasisTotals.empty
      (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals))
    (hr : reconciliationFails totals = .ok false) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected (basisProjection policy snapshot
        (sortBasisEventsById snapshot.sourceEvents) entries (basisReconciliation totals))) := by
  unfold projectAccountingBasis
  rw [hp]
  simp [hb, hi, hs, hc, h, hr]

end Intro

end Rastrata.Kernel

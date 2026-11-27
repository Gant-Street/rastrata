/-
Every rejection of `projectAccountingBasis` and the diagnostic it gives: one theorem for each, over
the conditions of the model.
-/
import Rastrata.Kernel.Accounting.Basis.Laws3

namespace Rastrata.Kernel

/-! ## The checks that come before the loop -/

/-- The first three checks pass for `policy`: it is the policy `policyAt` selects at the snapshot's
cutoff, the population is within the bound, and the identities of the events are sound. -/
structure BasisPopulationOk (policies : List AccountingPolicy) (policyIdValue : PolicyId)
    (version : SemanticVersion) (snapshot : AccountingReadSnapshot)
    (policy : AccountingBasisPolicy) : Prop where
  selected : policyAt AccountingBasisPolicy policies policyIdValue version
    snapshot.policyEffectiveAt = .selected policy
  bound : ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents
  identity : populationIdentityRejects snapshot.sourceEvents = false

/-- The first four checks pass: the snapshot is accepted too. -/
structure BasisAdmits (policies : List AccountingPolicy) (policyIdValue : PolicyId)
    (version : SemanticVersion) (snapshot : AccountingReadSnapshot)
    (policy : AccountingBasisPolicy) : Prop extends
    BasisPopulationOk policies policyIdValue version snapshot policy where
  accepted : readSnapshotRejects policy snapshot = .ok false

/-- The first five checks pass: every event, in identifier order, closes over its reference and
posting. -/
structure BasisCloses (policies : List AccountingPolicy) (policyIdValue : PolicyId)
    (version : SemanticVersion) (snapshot : AccountingReadSnapshot)
    (policy : AccountingBasisPolicy) : Prop extends
    BasisAdmits policies policyIdValue version snapshot policy where
  closes : (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) = none

variable {policies : List AccountingPolicy} {policyIdValue : PolicyId} {version : SemanticVersion}
  {snapshot : AccountingReadSnapshot}

/-- The diagnostics of the nine rejections, for `simp` to tell them apart. -/
macro "basis_diag_ne" loc:(Lean.Parser.Tactic.location)? : tactic =>
  `(tactic| simp [basisPolicyDiagnostic, basisBoundDiagnostic, basisIdentityDiagnostic,
    basisSnapshotDiagnostic, basisEventDiagnostic, basisRuleDiagnostic, basisGraphDiagnostic,
    basisRatioDiagnostic, basisReconciliationDiagnostic, diagnostic] $[$loc]?)

set_option hygiene false in
/-- Closes a case of `BasisRun` in which the result is not the one the equation `hr` names: the
diagnostics differ, the result is an error or a projection, or the loop rejected with another of the
three diagnostics it can give. -/
macro "basis_contra" : tactic =>
  `(tactic| first
    | (exfalso; basis_diag_ne at hr; done)
    | (exfalso; rcases basisLoop_rejected (by assumption) with rfl | rfl | rfl <;>
        basis_diag_ne at hr))

/-- Rejection 1 (line 1398): the policy diagnostic is given exactly when `policyAt` selects no
policy. -/
theorem projectAccountingBasis_policy_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisPolicyDiagnostic]) ↔
      ∃ ds, policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .rejected ds := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | exact ⟨_, by assumption⟩
      | basis_contra
  · rintro ⟨ds, h⟩
    exact projectAccountingBasis_of_noPolicy h

/-- Rejection 2 (line 1400): the bound diagnostic is given exactly when a policy is selected and the
population is above the bound. -/
theorem projectAccountingBasis_bound_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisBoundDiagnostic]) ↔
      (∃ policy, policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy) ∧
      snapshot.sourceEvents.length > accountingLimits.maxBasisEvents := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | exact ⟨⟨_, by assumption⟩, by assumption⟩
      | basis_contra
  · rintro ⟨⟨policy, hp⟩, hb⟩
    exact projectAccountingBasis_of_tooMany hp hb

/-- Rejection 3 (line 1401): the identity diagnostic is given exactly when a policy is selected, the
population is within the bound and the identities of the events fail. -/
theorem projectAccountingBasis_identity_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisIdentityDiagnostic]) ↔
      ∃ policy, policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy ∧
      ¬ snapshot.sourceEvents.length > accountingLimits.maxBasisEvents ∧
      populationIdentityRejects snapshot.sourceEvents = true := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | exact ⟨_, by assumption, by assumption, by assumption⟩
      | basis_contra
  · rintro ⟨policy, hp, hb, hi⟩
    exact projectAccountingBasis_of_identity hp hb hi

/-- Rejection 4 (line 1441): the snapshot diagnostic is given exactly when the first three checks
pass and the checks of the snapshot refuse it. -/
theorem projectAccountingBasis_snapshot_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisSnapshotDiagnostic]) ↔
      ∃ policy, BasisPopulationOk policies policyIdValue version snapshot policy ∧
        readSnapshotRejects policy snapshot = .ok true := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | exact ⟨_, ⟨by assumption, by assumption, by assumption⟩, by assumption⟩
      | basis_contra
  · rintro ⟨policy, ⟨hp, hb, hi⟩, hs⟩
    exact projectAccountingBasis_of_snapshot hp hb hi hs

/-- The event diagnostic names the event by its identifier, and by nothing else. -/
theorem basisEventDiagnostic_eq_iff (e₁ e₂ : BasisSourceEvent) :
    basisEventDiagnostic e₁ = basisEventDiagnostic e₂ ↔ e₁.id = e₂.id := by
  constructor
  · intro h
    have hp := congrArg SemanticDiagnostic.path h
    simp only [basisEventDiagnostic, diagnostic] at hp
    have hl := congrArg String.toList hp
    simp only [String.toList_append, List.append_assoc] at hl
    have hl := List.append_cancel_left hl
    have hl := List.append_cancel_right hl
    exact String.toList_inj.mp hl
  · intro h
    simp only [basisEventDiagnostic, diagnostic, h]

/-- Rejection 5 (line 1446): the event diagnostic, at the path of an event, is given exactly when the
first four checks pass and the first event, in identifier order, that does not close has that
identifier. -/
theorem projectAccountingBasis_event_iff (event : BasisSourceEvent) :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisEventDiagnostic event]) ↔
      ∃ policy first, BasisAdmits policies policyIdValue version snapshot policy ∧
        (sortBasisEventsById snapshot.sourceEvents).find? (eventDoesNotClose policy) =
          some first ∧ first.id = event.id := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | (simp only [Except.ok.injEq, BasisProjectionResult.rejected.injEq, List.cons.injEq,
          and_true] at hr
         exact ⟨_, _, ⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
           by assumption, ((basisEventDiagnostic_eq_iff _ _).mp hr).symm⟩)
      | basis_contra
  · rintro ⟨policy, first, ⟨⟨hp, hb, hi⟩, hs⟩, hf, hid⟩
    have := projectAccountingBasis_of_event hp hb hi hs hf
    rwa [(basisEventDiagnostic_eq_iff first event).mpr hid] at this

/-! ## The rejections inside the loop -/

/-- The loop stops at an event for which `P` holds, after taking every event before it. -/
def BasisLoopStopsAt (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (events : List BasisSourceEvent) (P : BasisSourceEvent → Prop) : Prop :=
  ∃ pre event suf entries totals, events = pre ++ event :: suf ∧
    basisLoop policy snapshot 0 BasisTotals.empty pre = .ok (.done entries totals) ∧ P event

/-- The event has no single rule (rejection 6, line 1456). -/
def BasisRuleFails (policy : AccountingBasisPolicy) (event : BasisSourceEvent) : Prop :=
  (basisRulesFor policy event).length ≠ 1

/-- The event's rule allocates by the settlement ratio and the open item or the graph of
allocations does not close (rejection 7, line 1470). -/
def BasisGraphFails (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (event : BasisSourceEvent) : Prop :=
  ∃ rule, basisRulesFor policy event = [rule] ∧ rule.treatment = .allocateBySettlementRatio ∧
    settlementGraphFails policy snapshot event = true

/-- The event's rule allocates by the settlement ratio, the graph closes, and the ratio is below zero
or above one (rejection 8, line 1472). -/
def BasisRangeFails (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (event : BasisSourceEvent) : Prop :=
  ∃ rule, basisRulesFor policy event = [rule] ∧ rule.treatment = .allocateBySettlementRatio ∧
    settlementGraphFails policy snapshot event = false ∧
    ∃ item total ratio, basisOpenItem snapshot event = some item ∧
      liftExact (accountingSum (ratioValues snapshot event)) = .ok total ∧
      liftExact (total.divide item.bookValue.abs) = .ok ratio ∧
      (ratio.compare ExactRational.zero = .lt ∨ ratio.compare basisOne = .gt)

/-- The loop rejects with the rule diagnostic exactly at an event without a single rule. -/
theorem basisLoop_rule_iff (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (events : List BasisSourceEvent) :
    basisLoop policy snapshot 0 BasisTotals.empty events = .ok (.rejected basisRuleDiagnostic) ↔
      BasisLoopStopsAt policy snapshot events (BasisRuleFails policy) := by
  rw [basisLoop_rejects_iff]
  unfold BasisLoopStopsAt BasisRuleFails
  constructor
  · rintro ⟨pre, event, suf, es, t, hsplit, hdone, hp⟩
    refine ⟨pre, event, suf, es, t, hsplit, hdone, ?_⟩
    rcases (processBasisEvent_rejected_iff _ _ _ _ _ _).mp hp with ⟨hlen, -⟩ | ⟨rule, -, -, hs⟩
    · exact hlen
    · rcases settlementRatioOf_rejected hs with h | h <;> basis_diag_ne at h
  · rintro ⟨pre, event, suf, es, t, hsplit, hdone, hlen⟩
    exact ⟨pre, event, suf, es, t, hsplit, hdone,
      (processBasisEvent_rejected_iff _ _ _ _ _ _).mpr (Or.inl ⟨hlen, rfl⟩)⟩

/-- The loop rejects with the graph diagnostic exactly at an event whose rule allocates by the
settlement ratio and whose open item or graph does not close. -/
theorem basisLoop_graph_iff (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (events : List BasisSourceEvent) :
    basisLoop policy snapshot 0 BasisTotals.empty events = .ok (.rejected basisGraphDiagnostic) ↔
      BasisLoopStopsAt policy snapshot events (BasisGraphFails policy snapshot) := by
  rw [basisLoop_rejects_iff]
  unfold BasisLoopStopsAt BasisGraphFails
  constructor
  · rintro ⟨pre, event, suf, es, t, hsplit, hdone, hp⟩
    refine ⟨pre, event, suf, es, t, hsplit, hdone, ?_⟩
    rcases (processBasisEvent_rejected_iff _ _ _ _ _ _).mp hp with ⟨-, h⟩ | ⟨rule, hr, ht, hs⟩
    · basis_diag_ne at h
    · exact ⟨rule, hr, ht, (settlementRatioOf_graph_iff _ _ _).mp hs⟩
  · rintro ⟨pre, event, suf, es, t, hsplit, hdone, rule, hr, ht, hg⟩
    exact ⟨pre, event, suf, es, t, hsplit, hdone,
      (processBasisEvent_rejected_iff _ _ _ _ _ _).mpr
        (Or.inr ⟨rule, hr, ht, (settlementRatioOf_graph_iff _ _ _).mpr hg⟩)⟩

/-- The loop rejects with the range diagnostic exactly at an event whose rule allocates by the
settlement ratio, whose graph closes, and whose ratio is out of range. -/
theorem basisLoop_range_iff (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (events : List BasisSourceEvent) :
    basisLoop policy snapshot 0 BasisTotals.empty events = .ok (.rejected basisRatioDiagnostic) ↔
      BasisLoopStopsAt policy snapshot events (BasisRangeFails policy snapshot) := by
  rw [basisLoop_rejects_iff]
  unfold BasisLoopStopsAt BasisRangeFails
  constructor
  · rintro ⟨pre, event, suf, es, t, hsplit, hdone, hp⟩
    refine ⟨pre, event, suf, es, t, hsplit, hdone, ?_⟩
    rcases (processBasisEvent_rejected_iff _ _ _ _ _ _).mp hp with ⟨-, h⟩ | ⟨rule, hr, ht, hs⟩
    · basis_diag_ne at h
    · exact ⟨rule, hr, ht, (settlementRatioOf_range_iff _ _ _).mp hs⟩
  · rintro ⟨pre, event, suf, es, t, hsplit, hdone, rule, hr, ht, hg⟩
    exact ⟨pre, event, suf, es, t, hsplit, hdone,
      (processBasisEvent_rejected_iff _ _ _ _ _ _).mpr
        (Or.inr ⟨rule, hr, ht, (settlementRatioOf_range_iff _ _ _).mpr hg⟩)⟩

/-- Rejection 6 (line 1456): the rule diagnostic is given exactly when the first five checks pass and
the loop reaches an event whose kind has no single rule. -/
theorem projectAccountingBasis_rule_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisRuleDiagnostic]) ↔
      ∃ policy, BasisCloses policies policyIdValue version snapshot policy ∧
        BasisLoopStopsAt policy snapshot (sortBasisEventsById snapshot.sourceEvents)
          (BasisRuleFails policy) := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | (simp only [Except.ok.injEq, BasisProjectionResult.rejected.injEq, List.cons.injEq,
          and_true] at hr
         subst hr
         exact ⟨_, ⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
           by assumption⟩, (basisLoop_rule_iff _ _ _).mp (by assumption)⟩)
      | basis_contra
  · rintro ⟨policy, ⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hstop⟩
    exact projectAccountingBasis_of_loopRejects hp hb hi hs hc ((basisLoop_rule_iff _ _ _).mpr hstop)

/-- Rejection 7 (line 1470): the graph diagnostic is given exactly when the first five checks pass and
the loop reaches an event whose rule allocates by the settlement ratio and whose open item or graph
does not close. -/
theorem projectAccountingBasis_graph_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisGraphDiagnostic]) ↔
      ∃ policy, BasisCloses policies policyIdValue version snapshot policy ∧
        BasisLoopStopsAt policy snapshot (sortBasisEventsById snapshot.sourceEvents)
          (BasisGraphFails policy snapshot) := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | (simp only [Except.ok.injEq, BasisProjectionResult.rejected.injEq, List.cons.injEq,
          and_true] at hr
         subst hr
         exact ⟨_, ⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
           by assumption⟩, (basisLoop_graph_iff _ _ _).mp (by assumption)⟩)
      | basis_contra
  · rintro ⟨policy, ⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hstop⟩
    exact projectAccountingBasis_of_loopRejects hp hb hi hs hc
      ((basisLoop_graph_iff _ _ _).mpr hstop)

/-- Rejection 8 (line 1472): the range diagnostic is given exactly when the first five checks pass and
the loop reaches an event whose settlement ratio is below zero or above one. -/
theorem projectAccountingBasis_range_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisRatioDiagnostic]) ↔
      ∃ policy, BasisCloses policies policyIdValue version snapshot policy ∧
        BasisLoopStopsAt policy snapshot (sortBasisEventsById snapshot.sourceEvents)
          (BasisRangeFails policy snapshot) := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | (simp only [Except.ok.injEq, BasisProjectionResult.rejected.injEq, List.cons.injEq,
          and_true] at hr
         subst hr
         exact ⟨_, ⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
           by assumption⟩, (basisLoop_range_iff _ _ _).mp (by assumption)⟩)
      | basis_contra
  · rintro ⟨policy, ⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hstop⟩
    exact projectAccountingBasis_of_loopRejects hp hb hi hs hc
      ((basisLoop_range_iff _ _ _).mpr hstop)

/-- Rejection 9 (line 1490): the reconciliation diagnostic is given exactly when the first five checks
pass, the loop completes, and the test of the totals holds. -/
theorem projectAccountingBasis_reconciliation_iff :
    projectAccountingBasis policies policyIdValue version snapshot =
        .ok (.rejected [basisReconciliationDiagnostic]) ↔
      ∃ policy entries totals, BasisCloses policies policyIdValue version snapshot policy ∧
        basisLoop policy snapshot 0 BasisTotals.empty
          (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals) ∧
        reconciliationFails totals = .ok true := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | exact ⟨_, _, _, ⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
          by assumption⟩, by assumption, by assumption⟩
      | basis_contra
  · rintro ⟨policy, entries, totals, ⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hl, hr⟩
    exact projectAccountingBasis_of_reconciliation hp hb hi hs hc hl hr

/-- The call throws exactly when the checks of the snapshot throw, or the loop throws after the first
five checks pass, or the reconciliation throws after the loop completes. -/
theorem projectAccountingBasis_error_iff (code : QuantizeErr) :
    projectAccountingBasis policies policyIdValue version snapshot = .error code ↔
      ∃ policy,
        (BasisPopulationOk policies policyIdValue version snapshot policy ∧
          readSnapshotRejects policy snapshot = .error code) ∨
        (BasisCloses policies policyIdValue version snapshot policy ∧
          (basisLoop policy snapshot 0 BasisTotals.empty
              (sortBasisEventsById snapshot.sourceEvents) = .error code ∨
            ∃ entries totals, basisLoop policy snapshot 0 BasisTotals.empty
                (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals) ∧
              reconciliationFails totals = .error code)) := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | basis_contra
      | (simp only [Except.error.injEq] at hr
         subst hr
         first
         | exact ⟨_, Or.inl ⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩⟩
         | exact ⟨_, Or.inr ⟨⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
             by assumption⟩, Or.inl (by assumption)⟩⟩
         | exact ⟨_, Or.inr ⟨⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
             by assumption⟩, Or.inr ⟨_, _, by assumption, by assumption⟩⟩⟩)
  · rintro ⟨policy, ⟨⟨hp, hb, hi⟩, hs⟩ | ⟨⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hl | ⟨entries, totals, hl, hr⟩⟩⟩
    · exact projectAccountingBasis_of_snapshotThrows hp hb hi hs
    · exact projectAccountingBasis_of_loopThrows hp hb hi hs hc hl
    · exact projectAccountingBasis_of_reconciliationThrows hp hb hi hs hc hl hr

/-- The projection is made exactly when the first five checks pass, the loop completes, the totals
reconcile, and it is the projection of those entries and totals. -/
theorem projectAccountingBasis_projected_iff (projection : AccountingBasisProjection) :
    projectAccountingBasis policies policyIdValue version snapshot = .ok (.projected projection) ↔
      ∃ policy entries totals, BasisCloses policies policyIdValue version snapshot policy ∧
        basisLoop policy snapshot 0 BasisTotals.empty
          (sortBasisEventsById snapshot.sourceEvents) = .ok (.done entries totals) ∧
        reconciliationFails totals = .ok false ∧
        projection = basisProjection policy snapshot (sortBasisEventsById snapshot.sourceEvents)
          entries (basisReconciliation totals) := by
  constructor
  · intro h
    have run := projectAccountingBasis_run policies policyIdValue version snapshot
    generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
    cases run <;> rw [h] at hr <;>
      first
      | basis_contra
      | (simp only [Except.ok.injEq, BasisProjectionResult.projected.injEq] at hr
         exact ⟨_, _, _, ⟨⟨⟨by assumption, by assumption, by assumption⟩, by assumption⟩,
           by assumption⟩, by assumption, by assumption, hr⟩)
  · rintro ⟨policy, entries, totals, ⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hl, hr, rfl⟩
    exact projectAccountingBasis_of_projected hp hb hi hs hc hl hr

end Rastrata.Kernel

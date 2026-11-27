/-
What `projectAccountingBasis` returns when it projects: one entry for each event, the amounts, the
reconciliation, and the hash of the projection.
-/
import Rastrata.Kernel.Accounting.Basis.Laws6

namespace Rastrata.Kernel

/-- A reconciliation's content hash does not enter its own body. -/
theorem AccountingBasisReconciliation.bodyValue_contentHash (r : AccountingBasisReconciliation)
    (c : ContentHash) : bodyValue { r with contentHash := c } = bodyValue r := by
  simp [bodyValue, CanonicalObject.members, AccountingBasisReconciliation.canonicalMembers,
    withoutContentHash, member]

/-- A projection's content hash does not enter its own body. -/
theorem AccountingBasisProjection.bodyValue_contentHash (r : AccountingBasisProjection)
    (c : ContentHash) : bodyValue { r with contentHash := c } = bodyValue r := by
  simp [bodyValue, CanonicalObject.members, AccountingBasisProjection.canonicalMembers,
    withoutContentHash, member]

/-- Replacing the content hash of a reconciliation does not change the hash of its body. -/
theorem accountingBodyHash_reconciliation_update (body : AccountingBasisReconciliation)
    (c : ContentHash) :
    accountingBodyHash "AccountingBasisReconciliation" { body with contentHash := c } =
      accountingBodyHash "AccountingBasisReconciliation" body := by
  unfold accountingBodyHash
  rw [AccountingBasisReconciliation.bodyValue_contentHash]

/-- Replacing the content hash of a projection does not change the hash of its body. -/
theorem accountingBodyHash_projection_update (body : AccountingBasisProjection) (c : ContentHash) :
    accountingBodyHash "AccountingBasisProjection" { body with contentHash := c } =
      accountingBodyHash "AccountingBasisProjection" body := by
  unfold accountingBodyHash
  rw [AccountingBasisProjection.bodyValue_contentHash]

/-- The reconciliation carries the hash of its body. -/
theorem basisReconciliation_contentHash (totals : BasisTotals) :
    (basisReconciliation totals).contentHash =
      accountingBodyHash "AccountingBasisReconciliation" (basisReconciliation totals) :=
  (accountingBodyHash_reconciliation_update (basisReconciliationBody totals) _).symm

/-- The projection carries the hash of its body. -/
theorem basisProjection_contentHash (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (ordered : List BasisSourceEvent)
    (entries : List AccountingBasisProjectionEntry) (reconciliation : AccountingBasisReconciliation) :
    (basisProjection policy snapshot ordered entries reconciliation).contentHash =
      accountingBodyHash "AccountingBasisProjection"
        (basisProjection policy snapshot ordered entries reconciliation) :=
  (accountingBodyHash_projection_update
    { policyId := policy.id, sourcePopulationHash := snapshot.sourcePopulationHash, entries,
      reconciliation, sourceSnapshot := basisSourceSnapshot snapshot ordered,
      contentHash := default } _).symm

/-! ## What a projection means -/

/-- A constructible snapshot has a constructible accounting state. -/
theorem AccountingReadSnapshot.WF.accountingState' {snapshot : AccountingReadSnapshot}
    (h : snapshot.WF) : snapshot.accountingState.WF :=
  (h : AccountingReadPopulation.WF snapshot.toAccountingReadSnapshotBody.toAccountingReadPopulation).accountingState

/-- A constructible snapshot has constructible events. -/
theorem AccountingReadSnapshot.WF.sourceEvents' {snapshot : AccountingReadSnapshot}
    (h : snapshot.WF) : ∀ event ∈ snapshot.sourceEvents, event.WF :=
  (h : AccountingReadPopulation.WF snapshot.toAccountingReadSnapshotBody.toAccountingReadPopulation).sourceEvents

/-- The events in identifier order are those of the snapshot. -/
theorem mem_sortBasisEventsById {events : List BasisSourceEvent} {event : BasisSourceEvent} :
    event ∈ sortBasisEventsById events ↔ event ∈ events :=
  List.mem_mergeSort

/-- What `projectAccountingBasis` returns when it projects, over a constructible snapshot: the
policy is the one `policyAt` selected and every check before the loop passed; the loop over the
events in identifier order computed the entries and the totals as `BasisLoopMeans` says; the
projection names the policy and the source population hash, holds those entries, the reconciliation
of those totals, and the source snapshot with its events in identifier order; and it carries the
hash of its own body. -/
theorem projectAccountingBasis_projected_spec {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {projection : AccountingBasisProjection} (hW : snapshot.WF)
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected projection)) :
    ∃ policy totals, BasisCloses policies policyIdValue version snapshot policy ∧
      BasisLoopMeans policy snapshot (sortBasisEventsById snapshot.sourceEvents) 0
        BasisTotals.empty projection.entries totals ∧
      projection.policyId = policy.id ∧
      projection.sourcePopulationHash = snapshot.sourcePopulationHash ∧
      projection.reconciliation = basisReconciliation totals ∧
      projection.sourceSnapshot = basisSourceSnapshot snapshot
        (sortBasisEventsById snapshot.sourceEvents) ∧
      projection.contentHash = accountingBodyHash "AccountingBasisProjection" projection := by
  obtain ⟨policy, entries, totals, hc, hl, hr, rfl⟩ := (projectAccountingBasis_projected_iff _).mp h
  have hevents : ∀ event ∈ sortBasisEventsById snapshot.sourceEvents,
      event.sourcePosting.bookValue.amount.WF := fun event he =>
    (hW.sourceEvents' event (mem_sortBasisEventsById.mp he)).sourcePosting.amount
  have hmeans := basisLoop_done_spec hW.accountingState' _ 0 BasisTotals.empty totals entries
    hevents BasisTotals.empty_wf hl
  exact ⟨policy, totals, hc, hmeans, rfl, rfl, rfl, rfl, basisProjection_contentHash _ _ _ _ _⟩

/-- The entries are those of the events, in order, numbered from the position given. -/
theorem basisEntriesMean_order {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} :
    ∀ {count : Nat} {events : List BasisSourceEvent}
      {entries : List AccountingBasisProjectionEntry},
      BasisEntriesMean policy snapshot count events entries →
        entries.map (·.sourceId) = events.map (·.id) ∧
          entries.map (·.ordinal) =
            (List.range events.length).map fun i => ((count + i + 1 : Nat) : Int)
  | _, [], [], _ => by simp
  | _, [], _ :: _, h => by simp [BasisEntriesMean] at h
  | _, _ :: _, [], h => by simp [BasisEntriesMean] at h
  | count, event :: events, entry :: entries, h => by
    obtain ⟨⟨rule, -, hmeans, -⟩, hrest⟩ := h
    obtain ⟨hids, hords⟩ := basisEntriesMean_order hrest
    refine ⟨?_, ?_⟩
    · simp only [List.map_cons, hids, hmeans.sourceId]
    · simp only [List.map_cons, hords, hmeans.ordinal, List.length_cons, List.range_succ_eq_map]
      simp only [List.map_map, Function.comp_def, Nat.add_zero]
      congr 1
      apply List.map_congr_left
      intro i _
      congr 1
      omega

/-- One entry for each event, in identifier order: when the projection is made, it has one entry for each event of the snapshot, the entries name the events in the order of
their identifiers, and are numbered from one. -/
theorem projectAccountingBasis_entries_order {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {projection : AccountingBasisProjection} (hW : snapshot.WF)
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected projection)) :
    projection.entries.map (·.sourceId) = (sortBasisEventsById snapshot.sourceEvents).map (·.id) ∧
      projection.entries.map (·.ordinal) =
        (List.range snapshot.sourceEvents.length).map fun i => ((i + 1 : Nat) : Int) := by
  obtain ⟨policy, totals, -, hmeans, -⟩ := projectAccountingBasis_projected_spec hW h
  obtain ⟨hids, hords⟩ := basisEntriesMean_order hmeans.means
  refine ⟨hids, ?_⟩
  have hlen : (sortBasisEventsById snapshot.sourceEvents).length = snapshot.sourceEvents.length :=
    List.length_mergeSort _
  rw [hords, hlen]
  simp

/-- The amount of each entry, as an equation over meanings: for each event in identifier order, its
entry has the event's rule's treatment, includes `basisIncluded` of the posting's amount and the
settlement ratio (nothing for `exclude`, the amount times the ratio for `allocateBySettlementRatio`,
the whole amount otherwise), excludes the rest, and holds a recognized amount that is the included
amount rounded in the policy's rule (and none for `exclude`); `BasisEntriesMean` says each of these. -/
theorem projectAccountingBasis_entry_amounts {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {projection : AccountingBasisProjection} (hW : snapshot.WF)
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected projection)) :
    ∃ policy, policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy ∧
      BasisEntriesMean policy snapshot 0 (sortBasisEventsById snapshot.sourceEvents)
        projection.entries := by
  obtain ⟨policy, totals, hc, hmeans, -⟩ := projectAccountingBasis_projected_spec hW h
  exact ⟨policy, hc.selected, hmeans.means⟩

/-- The reconciliation is exact: the totals mean the sums of the events' amounts and of the entries'
included, excluded, recognized and residual amounts; the source total is the included plus the
excluded total; the booked plus the residual total is the projected exact total, which is the
included total; and the reconciliation carries the hash of its own body. No difference is reported
because there is none. -/
theorem projectAccountingBasis_reconciliation_exact {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {projection : AccountingBasisProjection} (hW : snapshot.WF)
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected projection)) :
    projection.reconciliation.WF ∧
      projection.reconciliation.sourceExactTotal.toRat =
        ((sortBasisEventsById snapshot.sourceEvents).map fun event =>
          event.sourcePosting.bookValue.amount.toRat).sum ∧
      projection.reconciliation.includedExactTotal.toRat =
        (projection.entries.map fun entry => entry.includedExactAmount.toRat).sum ∧
      projection.reconciliation.excludedExactTotal.toRat =
        (projection.entries.map fun entry => entry.excludedExactAmount.toRat).sum ∧
      projection.reconciliation.projectedExactTotal = projection.reconciliation.includedExactTotal ∧
      projection.reconciliation.projectedBookValueTotal.toRat =
        (projection.entries.map fun entry => recognizedAmountValue entry.recognizedAmount).sum ∧
      projection.reconciliation.quantizationResidualTotal.toRat =
        (projection.entries.map fun entry => recognizedResidualValue entry.recognizedAmount).sum ∧
      projection.reconciliation.sourceExactTotal.toRat =
        projection.reconciliation.includedExactTotal.toRat +
          projection.reconciliation.excludedExactTotal.toRat ∧
      projection.reconciliation.projectedBookValueTotal.toRat +
          projection.reconciliation.quantizationResidualTotal.toRat =
        projection.reconciliation.projectedExactTotal.toRat ∧
      projection.reconciliation.contentHash =
        accountingBodyHash "AccountingBasisReconciliation" projection.reconciliation := by
  obtain ⟨policy, totals, hc, hmeans, -, -, hrec, -⟩ := projectAccountingBasis_projected_spec hW h
  have hre := hmeans.reconciles
  rw [hrec]
  refine ⟨⟨hmeans.wf.source, hmeans.wf.included, hmeans.wf.excluded, hmeans.wf.included,
      hmeans.wf.projectedBookValue, hmeans.wf.residual⟩, ?_, ?_, ?_, rfl, ?_, ?_, hre.source,
      hre.booked, basisReconciliation_contentHash totals⟩
  · simpa [basisReconciliation, basisReconciliationBody, BasisTotals.empty,
      ExactRational.zero_toRat] using hmeans.source
  · simpa [basisReconciliation, basisReconciliationBody, BasisTotals.empty,
      ExactRational.zero_toRat] using hmeans.included
  · simpa [basisReconciliation, basisReconciliationBody, BasisTotals.empty,
      ExactRational.zero_toRat] using hmeans.excluded
  · simpa [basisReconciliation, basisReconciliationBody, BasisTotals.empty,
      ExactRational.zero_toRat] using hmeans.booked
  · simpa [basisReconciliation, basisReconciliationBody, BasisTotals.empty,
      ExactRational.zero_toRat] using hmeans.residual

/-- The reconciliation diagnostic (line 1490) is never given for a constructible snapshot: the
totals always reconcile, so `projection.reconciliation` is dead code. -/
theorem projectAccountingBasis_reconciliation_never {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    (hW : snapshot.WF) :
    projectAccountingBasis policies policyIdValue version snapshot ≠
      .ok (.rejected [basisReconciliationDiagnostic]) := by
  intro h
  obtain ⟨policy, entries, totals, hc, hl, hr⟩ := (projectAccountingBasis_reconciliation_iff).mp h
  have hevents : ∀ event ∈ sortBasisEventsById snapshot.sourceEvents,
      event.sourcePosting.bookValue.amount.WF := fun event he =>
    (hW.sourceEvents' event (mem_sortBasisEventsById.mp he)).sourcePosting.amount
  have hmeans := basisLoop_done_spec hW.accountingState' _ 0 BasisTotals.empty totals entries
    hevents BasisTotals.empty_wf hl
  exact reconciliationFails_ne_true hmeans.wf hmeans.reconciles hr

end Rastrata.Kernel

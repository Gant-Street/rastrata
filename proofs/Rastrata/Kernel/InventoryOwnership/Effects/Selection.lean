/-
The laws of `prepareInventoryOwnershipSelection` (`inventory-ownership.ts` lines 1032 to 1105).

What a selection guarantees (`prepareInventoryOwnershipSelection_selected`,
`prepareInventoryOwnershipSelection_conserves`): every test passed in the TypeScript's order; the
quantity selected plus the quantity short is the quantity requested; the selected basis is the cost
method's; the holdings allocated are exactly the layers the cost method chose, sorted by holding;
each allocation takes the holding's exact basis and allowance in proportion, and carries their sum.
Rejections: the bounds rejection and the policy rejection exactly when their tests fail
(`prepareInventoryOwnershipSelection_bounds_iff`, `prepareInventoryOwnershipSelection_policy_iff`);
every later rejection is one of six of this module or the cost calculation's own
(`prepareInventoryOwnershipSelection_later`).
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Resolution
import Rastrata.Kernel.Accounting.Inventory.CostLaws

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false
set_option linter.unusedTactic false
set_option linter.unnecessarySeqFocus false

open InventoryOwnership InventoryOwnershipEffects

/-- What an addition returns is constructible. -/
theorem ExactRational.add_ok_wf {a b c : ExactRational} (h : a.add b = .ok c) : c.WF :=
  (ExactRational.of_ok h).1

/-- What a subtraction returns is constructible. -/
theorem ExactRational.subtract_ok_wf {a b c : ExactRational} (h : a.subtract b = .ok c) : c.WF :=
  (ExactRational.of_ok h).1

/-- A sum from a constructible start is constructible. -/
theorem addExactValues_ok_wf :
    ∀ {total result : ExactRational} {values : List ExactRational}, total.WF →
      addExactValues total values = .ok result → result.WF
  | _, _, [], ht, h => by simp only [addExactValues, Except.ok.injEq] at h; exact h ▸ ht
  | total, result, value :: rest, _, h => by
    unfold addExactValues at h
    cases hn : total.add value with
    | error e => simp [hn] at h
    | ok next =>
      simp only [hn] at h
      exact addExactValues_ok_wf (ExactRational.add_ok_wf hn) h

/-- What one selected allocation is, against the computed allocation it comes from: of the same
holding and quantity, with the request's derivation and the identities supplied for that holding, of
the holding's lot, its basis and allowance the holding's times the fraction taken, and its carrying
amount their sum. -/
structure SelectedAllocation (request : InventoryOwnershipSelectionRequest)
    (holdings : List LotHolding) (selected : InventoryAllocationResult)
    (item : InventoryReductionOperationAllocation) : Prop where
  holdingId : item.allocation.holdingId.value = selected.layerId
  quantity : item.allocation.allocatedQuantity = selected.quantity
  derivation : item.allocation.derivation = request.derivation
  identity : ∃ identity ∈ request.identities, identity.holdingId = item.allocation.holdingId ∧
    identity.allocationId = item.allocation.id ∧ identity.movementId = item.movementId
  holding : ∃ h ∈ holdings, h.id = item.allocation.holdingId ∧ item.allocation.lotId = h.lotId ∧
    ∃ fraction, selected.quantity.divide h.remainingQuantity = .ok fraction ∧
      h.remainingTotalBasis.multiply fraction = .ok item.allocation.allocatedTotalBasis ∧
      h.remainingValuationAllowance.multiply fraction = .ok item.allocation.allocatedValuationAllowance
  carrying : item.allocation.allocatedTotalBasis.add item.allocation.allocatedValuationAllowance =
    .ok item.allocation.allocatedCarryingAmount

/-- Each computed allocation becomes one `SelectedAllocation`, in order. -/
theorem selectionAllocationLoop_proceed {request : InventoryOwnershipSelectionRequest}
    {holdings : List LotHolding} :
    ∀ {quantity basis allowance : ExactRational} {allocations : List InventoryAllocationResult}
      {items : List InventoryReductionOperationAllocation} {totals : ExactRational × ExactRational × ExactRational},
      selectionAllocationLoop request holdings quantity basis allowance allocations =
          .ok (.proceed (items, totals)) →
        List.Forall₂ (SelectedAllocation request holdings) allocations items
  | _, _, _, [], items, _, h => by
    simp only [selectionAllocationLoop, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    rw [← h.1]; exact .nil
  | quantity, basis, allowance, selected :: rest, items, totals, h => by
    unfold selectionAllocationLoop at h
    simp only [InventoryOwnershipEffectErr.ofExact] at h
    cases hid : request.identities.find?
        (fun identity => identity.holdingId == (⟨selected.layerId⟩ : LotHoldingId)) with
    | none => simp [hid] at h
    | some identity =>
      cases hh : holdings.find? (fun held => held.id == (⟨selected.layerId⟩ : LotHoldingId)) with
      | none => simp [hid, hh] at h
      | some held =>
        cases hf : selected.quantity.divide held.remainingQuantity with
        | error e => simp [hid, hh, hf] at h
        | ok fraction =>
          cases hb : held.remainingTotalBasis.multiply fraction with
          | error e => simp [hid, hh, hf, hb] at h
          | ok itemBasis =>
            cases ha : held.remainingValuationAllowance.multiply fraction with
            | error e => simp [hid, hh, hf, hb, ha] at h
            | ok itemAllowance =>
              cases hc : itemBasis.add itemAllowance with
              | error e => simp [hid, hh, hf, hb, ha, hc] at h
              | ok carrying =>
                cases hq : quantity.add selected.quantity with
                | error e => simp [hid, hh, hf, hb, ha, hc, hq] at h
                | ok quantity' =>
                  cases hb' : basis.add itemBasis with
                  | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb'] at h
                  | ok basis' =>
                    cases ha' : allowance.add itemAllowance with
                    | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha'] at h
                    | ok allowance' =>
                      cases hl : selectionAllocationLoop request holdings quantity' basis'
                          allowance' rest with
                      | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl] at h
                      | ok step =>
                        cases step with
                        | rejected r => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl] at h
                        | proceed value =>
                          obtain ⟨items', totals'⟩ := value
                          simp only [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl, Except.ok.injEq,
                            OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
                          obtain ⟨rfl, -⟩ := h
                          have hidm := List.mem_of_find?_eq_some hid
                          have hidp := List.find?_some hid
                          have hhm := List.mem_of_find?_eq_some hh
                          have hhp := List.find?_some hh
                          simp only [beq_iff_eq] at hidp hhp
                          refine .cons ⟨?_, rfl, rfl, ⟨identity, hidm, ?_, rfl, rfl⟩,
                            ⟨held, hhm, rfl, rfl, fraction, ?_, hb, ha⟩, hc⟩
                            (selectionAllocationLoop_proceed hl)
                          · simp [hhp]
                          · rw [hidp, ← hhp]
                          · exact hf

/-- The running totals of the allocation loop are constructible. -/
theorem selectionAllocationLoop_totals_wf {request : InventoryOwnershipSelectionRequest}
    {holdings : List LotHolding} :
    ∀ {quantity basis allowance : ExactRational} {allocations : List InventoryAllocationResult}
      {items : List InventoryReductionOperationAllocation}
      {totals : ExactRational × ExactRational × ExactRational},
      quantity.WF → basis.WF → allowance.WF →
      selectionAllocationLoop request holdings quantity basis allowance allocations =
          .ok (.proceed (items, totals)) →
        totals.1.WF ∧ totals.2.1.WF ∧ totals.2.2.WF
  | _, _, _, [], items, _, hq, hb, ha, h => by
    simp only [selectionAllocationLoop, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    rw [← h.2]; exact ⟨hq, hb, ha⟩
  | quantity, basis, allowance, selected :: rest, items, totals, _, _, _, h => by
    unfold selectionAllocationLoop at h
    simp only [InventoryOwnershipEffectErr.ofExact] at h
    cases hid : request.identities.find?
        (fun identity => identity.holdingId == (⟨selected.layerId⟩ : LotHoldingId)) with
    | none => simp [hid] at h
    | some identity =>
      cases hh : holdings.find? (fun held => held.id == (⟨selected.layerId⟩ : LotHoldingId)) with
      | none => simp [hid, hh] at h
      | some held =>
        cases hf : selected.quantity.divide held.remainingQuantity with
        | error e => simp [hid, hh, hf] at h
        | ok fraction =>
          cases hb : held.remainingTotalBasis.multiply fraction with
          | error e => simp [hid, hh, hf, hb] at h
          | ok itemBasis =>
            cases ha : held.remainingValuationAllowance.multiply fraction with
            | error e => simp [hid, hh, hf, hb, ha] at h
            | ok itemAllowance =>
              cases hc : itemBasis.add itemAllowance with
              | error e => simp [hid, hh, hf, hb, ha, hc] at h
              | ok carrying =>
                cases hq : quantity.add selected.quantity with
                | error e => simp [hid, hh, hf, hb, ha, hc, hq] at h
                | ok quantity' =>
                  cases hb' : basis.add itemBasis with
                  | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb'] at h
                  | ok basis' =>
                    cases ha' : allowance.add itemAllowance with
                    | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha'] at h
                    | ok allowance' =>
                      cases hl : selectionAllocationLoop request holdings quantity' basis'
                          allowance' rest with
                      | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl] at h
                      | ok step =>
                        cases step with
                        | rejected r => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl] at h
                        | proceed value =>
                          obtain ⟨items', totals'⟩ := value
                          simp only [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl, Except.ok.injEq,
                            OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
                          obtain ⟨-, rfl⟩ := h
                          exact selectionAllocationLoop_totals_wf (ExactRational.add_ok_wf hq)
                            (ExactRational.add_ok_wf hb') (ExactRational.add_ok_wf ha') hl

/-- A selection is returned only after every test of the TypeScript passed, in order: the bounds,
the one applicable policy and its derivation, the pool, the cost calculation under that policy alone
over the pool's layers, the identities, every allocation, and the conservation test; its allocations
are those of the cost calculation sorted by holding, its provisional quantity and basis the cost's,
and its policy the selected one with its hash. -/
theorem prepareInventoryOwnershipSelection_selected {policies : List AccountingPolicy}
    {bookId : BookId} {pool : List InventoryOwnershipPoolRow}
    {request : InventoryOwnershipSelectionRequest} {s : InventoryOwnershipSelection}
    (h : prepareInventoryOwnershipSelection policies bookId pool request = .ok (.selected s)) :
    ∃ (policy : InventoryCostPolicy) (holdings : List LotHolding)
      (layers : List InventoryLayerInput) (allocations : List InventoryAllocationResult)
      (ordinaryBasis : ExactRational) (items : List InventoryReductionOperationAllocation)
      (total : ExactRational),
      selectionBoundsExceeded policies pool request = false ∧
      selectionMatches policies request = [.inventoryCost policy] ∧
      selectionPolicyInvalid bookId policy request = false ∧
      selectionPoolLoop bookId policy request 0 [] [] [] pool = .ok (.proceed (holdings, layers)) ∧
      calculateInventoryCost [.inventoryCost policy] bookId (selectionCostRequest request layers) =
        .ok (.costed allocations ordinaryBasis s.provisionalQuantity s.provisionalBasis) ∧
      selectionIdentitiesInvalid request allocations = false ∧
      selectionAllocationLoop request holdings ExactRational.zero ExactRational.zero
        ExactRational.zero allocations =
          .ok (.proceed (items, s.ordinaryQuantity, s.ordinaryBasis, s.ordinaryValuationAllowance)) ∧
      s.allocations = sortByText (·.allocation.holdingId.value) items ∧
      s.ordinaryQuantity.add s.provisionalQuantity = .ok total ∧
      total.equals request.quantity = true ∧ s.ordinaryBasis.equals ordinaryBasis = true ∧
      s.ordinaryBasis.add s.ordinaryValuationAllowance = .ok s.ordinaryCarryingAmount ∧
      s.inventoryPolicy =
        ⟨policy.id, policy.version, hashAccountingPolicy (.inventoryCost policy)⟩ := by
  unfold prepareInventoryOwnershipSelection at h
  split at h
  · simp at h
  · rename_i hb
    split at h
    · rename_i policy hm
      split at h
      · simp at h
      · rename_i hpi
        cases hp : selectionPoolLoop bookId policy request 0 [] [] [] pool with
        | error e => simp [hp, InventoryOwnershipEffectErr.ofExact] at h
        | ok step =>
          cases step with
          | rejected r => simp [hp, InventoryOwnershipEffectErr.ofExact] at h
          | proceed value =>
            obtain ⟨holdings, layers⟩ := value
            simp only [hp, InventoryOwnershipEffectErr.ofExact] at h
            cases hc : calculateInventoryCost [.inventoryCost policy] bookId
                (selectionCostRequest request layers) with
            | error e => simp [hc] at h
            | ok cost =>
              cases cost with
              | rejected d => simp [hc] at h
              | costed allocations ordinaryBasis provisionalQuantity provisionalBasis =>
                simp only [hc] at h
                unfold selectionOfCost at h
                split at h
                · simp at h
                · rename_i hid
                  cases hl : selectionAllocationLoop request holdings ExactRational.zero
                      ExactRational.zero ExactRational.zero allocations with
                  | error e => simp [hl] at h
                  | ok step =>
                    cases step with
                    | rejected r => simp [hl] at h
                    | proceed value =>
                      obtain ⟨items, quantity, basis, allowance⟩ := value
                      simp only [hl, InventoryOwnershipEffectErr.ofExact] at h
                      cases ht : quantity.add provisionalQuantity with
                      | error e => simp [ht] at h
                      | ok total =>
                        simp only [ht] at h
                        split at h
                        · simp at h
                        · rename_i hcons
                          cases hcar : basis.add allowance with
                          | error e => simp [hcar] at h
                          | ok carrying =>
                            simp only [hcar, Except.ok.injEq,
                              InventoryOwnershipSelectionResult.selected.injEq] at h
                            subst h
                            simp only [Bool.or_eq_true, Bool.not_eq_true', not_or,
                              Bool.not_eq_false] at hcons
                            exact ⟨policy, holdings, layers, allocations, ordinaryBasis, items, total,
                              by simpa using hb, hm, by simpa using hpi, hp, hc,
                              by simpa using hid, hl, rfl, ht, hcons.1, hcons.2, hcar, rfl⟩
    · simp at h

/-- What a multiplication returns is constructible. -/
theorem ExactRational.multiply_ok_wf {a b c : ExactRational} (h : a.multiply b = .ok c) : c.WF :=
  (ExactRational.of_ok h).1

/-- A selected allocation's carrying amount is its basis plus its allowance. -/
theorem SelectedAllocation.carrying_toRat {request : InventoryOwnershipSelectionRequest}
    {holdings : List LotHolding} {selected : InventoryAllocationResult}
    {item : InventoryReductionOperationAllocation}
    (h : SelectedAllocation request holdings selected item) :
    item.allocation.allocatedCarryingAmount.toRat =
      item.allocation.allocatedTotalBasis.toRat + item.allocation.allocatedValuationAllowance.toRat := by
  obtain ⟨_, -, -, -, fraction, -, hb, ha⟩ := h.holding
  exact (ExactRational.add_ok (ExactRational.multiply_ok_wf hb) (ExactRational.multiply_ok_wf ha)
    h.carrying).2

/-- The holdings of the selected allocations are the layers of the computed ones, in order. -/
theorem selectedAllocations_map {request : InventoryOwnershipSelectionRequest}
    {holdings : List LotHolding} :
    ∀ {allocations : List InventoryAllocationResult}
      {items : List InventoryReductionOperationAllocation},
      List.Forall₂ (SelectedAllocation request holdings) allocations items →
        items.map (·.allocation.holdingId.value) = allocations.map (·.layerId)
  | _, _, .nil => rfl
  | _, _, .cons hsel rest => by
    simp only [List.map_cons, hsel.holdingId, selectedAllocations_map rest]

/-- Every selected allocation comes from a computed one. -/
theorem selectedAllocations_mem {request : InventoryOwnershipSelectionRequest}
    {holdings : List LotHolding} :
    ∀ {allocations : List InventoryAllocationResult}
      {items : List InventoryReductionOperationAllocation},
      List.Forall₂ (SelectedAllocation request holdings) allocations items →
        ∀ item ∈ items, ∃ selected ∈ allocations, SelectedAllocation request holdings selected item
  | _, _, .nil, _, hmem => by cases hmem
  | _, _, .cons hsel rest, item, hmem => by
    rcases List.mem_cons.mp hmem with rfl | hmem
    · exact ⟨_, List.mem_cons_self, hsel⟩
    · obtain ⟨sel, hsel', hsa⟩ := selectedAllocations_mem rest item hmem
      exact ⟨sel, List.mem_cons_of_mem _ hsel', hsa⟩

/-- What a selection guarantees for a constructible request: the quantity selected from the
holdings plus the quantity short is the quantity requested, the selected basis is the basis the cost
method computed, the carrying amount is basis plus allowance, the holdings allocated are exactly the
layers the cost method chose (a permutation, sorted by holding), and each allocation is a
`SelectedAllocation` of one computed allocation. -/
theorem prepareInventoryOwnershipSelection_conserves {policies : List AccountingPolicy}
    {bookId : BookId} {pool : List InventoryOwnershipPoolRow}
    {request : InventoryOwnershipSelectionRequest} {s : InventoryOwnershipSelection}
    (hr : request.WF)
    (h : prepareInventoryOwnershipSelection policies bookId pool request = .ok (.selected s)) :
    ∃ (policy : InventoryCostPolicy) (holdings : List LotHolding)
      (layers : List InventoryLayerInput) (allocations : List InventoryAllocationResult)
      (ordinaryBasis : ExactRational),
      calculateInventoryCost [.inventoryCost policy] bookId (selectionCostRequest request layers) =
        .ok (.costed allocations ordinaryBasis s.provisionalQuantity s.provisionalBasis) ∧
      s.ordinaryQuantity.toRat + s.provisionalQuantity.toRat = request.quantity.toRat ∧
      s.ordinaryBasis.toRat = ordinaryBasis.toRat ∧
      s.ordinaryCarryingAmount.toRat =
        s.ordinaryBasis.toRat + s.ordinaryValuationAllowance.toRat ∧
      (s.allocations.map (·.allocation.holdingId.value)).Perm (allocations.map (·.layerId)) ∧
      ∀ item ∈ s.allocations, ∃ selected ∈ allocations,
        SelectedAllocation request holdings selected item := by
  obtain ⟨policy, holdings, layers, allocations, ordinaryBasis, items, total, -, -, -, -, hc, -, hl,
    hs, ht, hte, hbe, hcar, -⟩ := prepareInventoryOwnershipSelection_selected h
  obtain ⟨hqwf, hbwf, hawf⟩ := selectionAllocationLoop_totals_wf ExactRational.zero_wf
    ExactRational.zero_wf ExactRational.zero_wf hl
  obtain ⟨_, _, _, _, -, -, -, -, hpq, -, -, hob, -, -, -⟩ :=
    Inventory.calculateInventoryCost_costed_inv hc
  have hpqwf := ExactRational.subtract_ok_wf hpq
  have hobwf : ordinaryBasis.WF := addExactValues_ok_wf ExactRational.zero_wf hob
  have hreq : request.quantity.WF := hr.core.quantity
  have hfa := selectionAllocationLoop_proceed hl
  refine ⟨policy, holdings, layers, allocations, ordinaryBasis, hc, ?_, ?_, ?_, ?_, ?_⟩
  · rw [← (ExactRational.add_ok hqwf hpqwf ht).2]
    exact (ExactRational.equals_iff (ExactRational.add_ok_wf ht) hreq).mp hte
  · exact (ExactRational.equals_iff hbwf hobwf).mp hbe
  · exact (ExactRational.add_ok hbwf hawf hcar).2
  · rw [hs, ← selectedAllocations_map hfa]
    exact (sortByText_perm _ _).map _
  · intro item hitem
    rw [hs] at hitem
    exact selectedAllocations_mem hfa item ((sortByText_perm _ items).mem_iff.mp hitem)

/-- A policy that cannot be selected is refused with a diagnostic that is not a rejection of
ownership. -/
theorem policyAt_rejected_code {T : Type} [AccountingPolicyKind T] {policies : List AccountingPolicy}
    {id : PolicyId} {version : SemanticVersion} {at_ : Instant} {ds : List SemanticDiagnostic}
    (h : policyAt T policies id version at_ = .rejected ds) :
    ∀ d ∈ ds, d.code ≠ .lot_overallocation := by
  have hd : ∀ kind, (policyAtDiagnostic kind).code ≠ .lot_overallocation := by
    intro kind; unfold policyAtDiagnostic; split <;> simp [diagnostic]
  unfold policyAt at h
  dsimp only at h
  repeat' split at h
  all_goals simp only [AccountingPolicySelection.rejected.injEq, reduceCtorEq] at h
  all_goals (subst h; simpa using hd _)

/-- A cost calculation is refused only with diagnostics that are not rejections of ownership. -/
theorem calculateInventoryCost_rejected_code {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {ds : List SemanticDiagnostic}
    (h : calculateInventoryCost policies bookId request = .ok (.rejected ds)) :
    ∀ d ∈ ds, d.code ≠ .lot_overallocation := by
  unfold calculateInventoryCost at h
  dsimp only at h
  split at h
  · rename_i ds' hp
    simp only [Except.ok.injEq, InventoryCostCalculation.rejected.injEq] at h
    exact h ▸ policyAt_rejected_code hp
  · repeat' split at h
    all_goals simp only [Except.ok.injEq, InventoryCostCalculation.rejected.injEq, reduceCtorEq] at h
    all_goals (subst h; simp [Inventory.incoherentDiagnostic, Inventory.specificDiagnostic,
      Inventory.shortageDiagnostic, Inventory.rateDiagnostic, diagnostic])

/-- A rejection made of such diagnostics is no rejection of this module. -/
theorem cost_rejection_ne_reject {ds : List SemanticDiagnostic}
    (h : ∀ d ∈ ds, d.code ≠ .lot_overallocation) (path message : String) :
    (⟨ds⟩ : OwnershipRejection) ≠ InventoryOwnership.reject path message := by
  intro he
  simp only [InventoryOwnership.reject, OwnershipRejection.mk.injEq] at he
  subst he
  exact h _ List.mem_cons_self rfl

/-- The pool loop rejects only for the evidence bound, an incoherent row or a conflicting lot. -/
theorem selectionPoolLoop_rejected_mem {bookId : BookId} {policy : InventoryCostPolicy}
    {request : InventoryOwnershipSelectionRequest} :
    ∀ {work : Nat} {holdings : List LotHolding} {lots : List (LotId × ContentHash)}
      {layers : List InventoryLayerInput} {rows : List InventoryOwnershipPoolRow}
      {r : OwnershipRejection},
      selectionPoolLoop bookId policy request work holdings lots layers rows = .ok (.rejected r) →
        r = selectionEvidenceRejection ∨ r = selectionPoolRejection ∨
          r = selectionLotConflictRejection
  | _, _, _, _, [], _, h => by simp [selectionPoolLoop] at h
  | work, holdings, lots, layers, row :: rest, r, h => by
    unfold selectionPoolLoop at h
    dsimp only at h
    repeat' split at h
    all_goals try simp only [Except.ok.injEq, OwnershipStep.rejected.injEq, reduceCtorEq] at h
    all_goals first
      | (subst h; simp)
      | exact selectionPoolLoop_rejected_mem h

/-- The allocation loop rejects only for a missing identity. -/
theorem selectionAllocationLoop_rejected {request : InventoryOwnershipSelectionRequest}
    {holdings : List LotHolding} :
    ∀ {quantity basis allowance : ExactRational} {allocations : List InventoryAllocationResult}
      {r : OwnershipRejection},
      selectionAllocationLoop request holdings quantity basis allowance allocations =
          .ok (.rejected r) → r = selectionMissingIdentityRejection
  | _, _, _, [], _, h => by simp [selectionAllocationLoop] at h
  | quantity, basis, allowance, selected :: rest, r, h => by
    unfold selectionAllocationLoop at h
    simp only [InventoryOwnershipEffectErr.ofExact] at h
    cases hid : request.identities.find?
        (fun identity => identity.holdingId == (⟨selected.layerId⟩ : LotHoldingId)) with
    | none =>
      simp only [hid, Except.ok.injEq, OwnershipStep.rejected.injEq] at h; exact h.symm
    | some identity =>
      cases hh : holdings.find? (fun held => held.id == (⟨selected.layerId⟩ : LotHoldingId)) with
      | none => simp [hid, hh] at h
      | some held =>
        cases hf : selected.quantity.divide held.remainingQuantity with
        | error e => simp [hid, hh, hf] at h
        | ok fraction =>
          cases hb : held.remainingTotalBasis.multiply fraction with
          | error e => simp [hid, hh, hf, hb] at h
          | ok itemBasis =>
            cases ha : held.remainingValuationAllowance.multiply fraction with
            | error e => simp [hid, hh, hf, hb, ha] at h
            | ok itemAllowance =>
              cases hc : itemBasis.add itemAllowance with
              | error e => simp [hid, hh, hf, hb, ha, hc] at h
              | ok carrying =>
                cases hq : quantity.add selected.quantity with
                | error e => simp [hid, hh, hf, hb, ha, hc, hq] at h
                | ok quantity' =>
                  cases hb' : basis.add itemBasis with
                  | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb'] at h
                  | ok basis' =>
                    cases ha' : allowance.add itemAllowance with
                    | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha'] at h
                    | ok allowance' =>
                      cases hl : selectionAllocationLoop request holdings quantity' basis'
                          allowance' rest with
                      | error e => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl] at h
                      | ok step =>
                        cases step with
                        | rejected r' =>
                          simp only [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl, Except.ok.injEq,
                            OwnershipStep.rejected.injEq] at h
                          exact h ▸ selectionAllocationLoop_rejected hl
                        | proceed value => simp [hid, hh, hf, hb, ha, hc, hq, hb', ha', hl] at h

/-- After the cost calculation, a selection is rejected only for its identities, a missing identity
or conservation. -/
theorem selectionOfCost_rejected {policy : InventoryCostPolicy}
    {request : InventoryOwnershipSelectionRequest} {holdings : List LotHolding}
    {allocations : List InventoryAllocationResult} {ob pq pb : ExactRational}
    {r : OwnershipRejection}
    (h : selectionOfCost policy request holdings allocations ob pq pb = .ok (.rejected r)) :
    r = selectionIdentityRejection ∨ r = selectionMissingIdentityRejection ∨
      r = selectionConservationRejection := by
  unfold selectionOfCost at h
  split at h
  · simp only [Except.ok.injEq, InventoryOwnershipSelectionResult.rejected.injEq] at h
    exact Or.inl h.symm
  · split at h
    · simp at h
    · simp only [Except.ok.injEq, InventoryOwnershipSelectionResult.rejected.injEq] at h
      rename_i hl
      exact Or.inr (Or.inl (h ▸ selectionAllocationLoop_rejected hl))
    · repeat' split at h
      all_goals simp only [Except.ok.injEq, InventoryOwnershipSelectionResult.rejected.injEq,
        reduceCtorEq, InventoryOwnershipEffectErr.ofExact] at h
      exact Or.inr (Or.inr h.symm)

/-- The rejections a selection gives after its bounds and its policy. -/
theorem prepareInventoryOwnershipSelection_later {bookId : BookId} {pool : List InventoryOwnershipPoolRow}
    {request : InventoryOwnershipSelectionRequest} {policy : InventoryCostPolicy}
    {r : OwnershipRejection}
    (h : (match InventoryOwnershipEffectErr.ofExact
            (selectionPoolLoop bookId policy request 0 [] [] [] pool) with
          | .error e => .error e
          | .ok (.rejected rejection) => .ok (.rejected rejection)
          | .ok (.proceed (holdings, layers)) =>
            match InventoryOwnershipEffectErr.ofExact (calculateInventoryCost [.inventoryCost policy]
                bookId (selectionCostRequest request layers)) with
            | .error e => .error e
            | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
            | .ok (.costed allocations ordinaryBasis provisionalQuantity provisionalBasis) =>
              selectionOfCost policy request holdings allocations ordinaryBasis provisionalQuantity
                provisionalBasis : Except InventoryOwnershipEffectErr InventoryOwnershipSelectionResult) =
        .ok (.rejected r)) :
    r = selectionEvidenceRejection ∨ r = selectionPoolRejection ∨
      r = selectionLotConflictRejection ∨ r = selectionIdentityRejection ∨
      r = selectionMissingIdentityRejection ∨ r = selectionConservationRejection ∨
      (∀ d ∈ r.diagnostics, d.code ≠ .lot_overallocation) := by
  cases hp : selectionPoolLoop bookId policy request 0 [] [] [] pool with
  | error e => simp [hp, InventoryOwnershipEffectErr.ofExact] at h
  | ok step =>
    cases step with
    | rejected r' =>
      simp only [hp, InventoryOwnershipEffectErr.ofExact, Except.ok.injEq,
        InventoryOwnershipSelectionResult.rejected.injEq] at h
      rcases selectionPoolLoop_rejected_mem hp with h1 | h1 | h1 <;> simp_all
    | proceed value =>
      obtain ⟨holdings, layers⟩ := value
      simp only [hp, InventoryOwnershipEffectErr.ofExact] at h
      cases hc : calculateInventoryCost [.inventoryCost policy] bookId
          (selectionCostRequest request layers) with
      | error e => simp [hc] at h
      | ok cost =>
        cases cost with
        | rejected ds =>
          simp only [hc, Except.ok.injEq, InventoryOwnershipSelectionResult.rejected.injEq] at h
          subst h
          exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
            (calculateInventoryCost_rejected_code hc))))))
        | costed allocations ob pq pb =>
          simp only [hc] at h
          rcases selectionOfCost_rejected h with h1 | h1 | h1 <;> simp_all

/-- The bounds and policy rejections are distinct from each other and from every later one. -/
theorem selectionRejections_distinct :
    selectionBoundsRejection ≠ selectionPolicyRejection ∧
    selectionBoundsRejection ∉ [selectionEvidenceRejection, selectionPoolRejection,
      selectionLotConflictRejection, selectionIdentityRejection,
      selectionMissingIdentityRejection, selectionConservationRejection] ∧
    selectionPolicyRejection ∉ [selectionEvidenceRejection, selectionPoolRejection,
      selectionLotConflictRejection, selectionIdentityRejection,
      selectionMissingIdentityRejection, selectionConservationRejection] := by
  simp [selectionBoundsRejection, selectionPolicyRejection, selectionEvidenceRejection,
    selectionPoolRejection, selectionLotConflictRejection, selectionIdentityRejection,
    selectionMissingIdentityRejection, selectionConservationRejection, InventoryOwnership.reject,
    diagnostic]

/-- The bounds rejection (line 1040) is given exactly when an input population is over the bound. -/
theorem prepareInventoryOwnershipSelection_bounds_iff {policies : List AccountingPolicy}
    {bookId : BookId} {pool : List InventoryOwnershipPoolRow}
    {request : InventoryOwnershipSelectionRequest} :
    prepareInventoryOwnershipSelection policies bookId pool request =
        .ok (.rejected selectionBoundsRejection) ↔
      selectionBoundsExceeded policies pool request = true := by
  obtain ⟨hbp, hbl, -⟩ := selectionRejections_distinct
  unfold prepareInventoryOwnershipSelection
  by_cases hb : selectionBoundsExceeded policies pool request = true
  · simp [hb]
  · simp only [hb, Bool.false_eq_true, ↓reduceIte, iff_false]
    split
    · split
      · simpa [eq_comm] using hbp
      · intro h
        rcases prepareInventoryOwnershipSelection_later h with h1 | h1 | h1 | h1 | h1 | h1 | h1
        all_goals first
          | exact hbl (by rw [h1]; simp)
          | exact h1 _ List.mem_cons_self rfl
    · simpa [eq_comm] using hbp

/-- The policy rejection (line 1051) is given exactly when the bounds pass and there is not one
applicable inventory cost policy, or that policy or the derivation fails the test of lines 1045 to
1050. -/
theorem prepareInventoryOwnershipSelection_policy_iff {policies : List AccountingPolicy}
    {bookId : BookId} {pool : List InventoryOwnershipPoolRow}
    {request : InventoryOwnershipSelectionRequest} :
    prepareInventoryOwnershipSelection policies bookId pool request =
        .ok (.rejected selectionPolicyRejection) ↔
      selectionBoundsExceeded policies pool request = false ∧
        (match selectionMatches policies request with
          | [.inventoryCost policy] => selectionPolicyInvalid bookId policy request
          | _ => true) = true := by
  obtain ⟨hbp, -, hpl⟩ := selectionRejections_distinct
  unfold prepareInventoryOwnershipSelection
  by_cases hb : selectionBoundsExceeded policies pool request = true
  · simp only [hb, ↓reduceIte, Except.ok.injEq, InventoryOwnershipSelectionResult.rejected.injEq,
      Bool.true_eq_false, false_and, iff_false]
    exact hbp
  · simp only [hb, Bool.false_eq_true, ↓reduceIte, Bool.not_eq_true, true_and]
    split
    · rename_i policy hm
      rw [hm]
      by_cases hpi : selectionPolicyInvalid bookId policy request = true
      · simp [hpi]
      · simp only [hpi, Bool.false_eq_true, ↓reduceIte, iff_false]
        intro h
        rcases prepareInventoryOwnershipSelection_later h with h1 | h1 | h1 | h1 | h1 | h1 | h1
        all_goals first
          | exact hpl (by rw [h1]; simp)
          | exact h1 _ List.mem_cons_self rfl
    · simp

end Rastrata.Kernel

/-
The laws of `applyInventoryValueAdjustmentToHoldings` and `calculateInventoryValueAdjustment`: what the
adjustment does to the holdings, that the journal it drafts balances, the effect it carries, and every
way it rejects.
-/
import Rastrata.Kernel.Accounting.Inventory.Support

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

namespace Inventory

/-! ## The steps that make the draft -/

/-- An exact-number result lifted into the errors of the adjustment returns exactly when it did. -/
theorem liftNum_eq_ok {α : Type} {x : Except NumErr α} {v : α} :
    liftNum x = .ok v ↔ x = .ok v := by
  cases x <;> simp [liftNum]

/-- An identity result lifted into the errors of the adjustment returns exactly when it did. -/
theorem liftId_eq_ok {α : Type} {x : Except CanonicalErr α} {v : α} :
    liftId x = .ok v ↔ x = .ok v := by
  cases x <;> simp [liftId]

/-- When the draft of lines 1111 to 1128 is made, every step returned: the two changes were summed,
the postings and the booked adjustment made, the journal's identifier formed; the draft is the
journal and the effect. -/
theorem adjustmentDraft_inv {bookId : BookId} {functionalCommodityId : CommodityId}
    {policy : InventoryValueAdjustmentPolicy} {request : InventoryValueAdjustmentRequest}
    {d : AccountingDraft}
    (h : adjustmentDraft bookId functionalCommodityId policy request = .ok (.draft d)) :
    ∃ (inventoryChange recognizedCostChange : ExactRational)
      (postings : List ExactPreparedPosting) (bookedAdjustment : QuantizedValue) (jid : JournalId),
      sumMapped (fun allocation => allocation.remainingBasisChange.add
        allocation.remainingValuationAllowanceChange) request.allocations = .ok inventoryChange ∧
      accountingSum (request.allocations.map (·.recognizedCostChange)) = .ok recognizedCostChange ∧
      adjustmentPostings request policy functionalCommodityId inventoryChange
        recognizedCostChange = .ok postings ∧
      quantize request.exactSourceAmount policy.quantizationPolicy.rule = .ok bookedAdjustment ∧
      journalId (request.id.value ++ "-journal") = .ok jid ∧
      d = { journals := [adjustmentJournal request jid postings],
            effects := [.inventoryValueAdjustment
              (adjustmentEffect bookId policy request bookedAdjustment)] } := by
  unfold adjustmentDraft at h
  cases h1 : liftNum (sumMapped (fun allocation => allocation.remainingBasisChange.add
      allocation.remainingValuationAllowanceChange) request.allocations) with
  | error e => simp [h1] at h
  | ok inventoryChange =>
    simp only [h1] at h
    cases h2 : liftNum (accountingSum (request.allocations.map (·.recognizedCostChange))) with
    | error e => simp [h2] at h
    | ok recognizedCostChange =>
      simp only [h2] at h
      cases h3 : liftId (adjustmentPostings request policy functionalCommodityId inventoryChange
          recognizedCostChange) with
      | error e => simp [h3] at h
      | ok postings =>
        simp only [h3] at h
        cases h4 : quantize request.exactSourceAmount policy.quantizationPolicy.rule with
        | error e => simp [h4] at h
        | ok bookedAdjustment =>
          simp only [h4] at h
          cases h5 : liftId (journalId (request.id.value ++ "-journal")) with
          | error e => simp [h5] at h
          | ok jid =>
            simp only [h5, Except.ok.injEq] at h
            exact ⟨inventoryChange, recognizedCostChange, postings, bookedAdjustment, jid,
              liftNum_eq_ok.mp h1, liftNum_eq_ok.mp h2, liftId_eq_ok.mp h3, rfl,
              liftId_eq_ok.mp h5, AccountingCalculation.draft.inj h.symm⟩

/-- The postings of the adjustment's journal, once their identifiers are formed: the inventory posting
when the inventory change is not zero, the posting of the recognized cost when that is not zero, and the
posting of the adjustment account, in this order. -/
theorem adjustmentPostings_spec {request : InventoryValueAdjustmentRequest}
    {policy : InventoryValueAdjustmentPolicy} {functionalCommodityId : CommodityId}
    {inventoryChange recognizedCostChange : ExactRational} {postings : List ExactPreparedPosting}
    (h : adjustmentPostings request policy functionalCommodityId inventoryChange
      recognizedCostChange = .ok postings) :
    ∃ (inventoryPostings costPostings : List ExactPreparedPosting) (adjustmentId : PostingId),
      postings = inventoryPostings ++ costPostings ++
        [adjustmentPosting adjustmentId policy.adjustmentAccountId functionalCommodityId
          request.exactSourceAmount.negate] ∧
      (inventoryChange.isZero = true → inventoryPostings = []) ∧
      (inventoryChange.isZero = false → ∃ id, inventoryPostings =
        [adjustmentPosting id policy.inventoryAccountId functionalCommodityId inventoryChange]) ∧
      (recognizedCostChange.isZero = true → costPostings = []) ∧
      (recognizedCostChange.isZero = false → ∃ id, costPostings =
        [adjustmentPosting id policy.recognizedCostAccountId functionalCommodityId
          recognizedCostChange]) := by
  unfold adjustmentPostings at h
  by_cases hi : inventoryChange.isZero = true
  · simp only [hi, ↓reduceIte] at h
    by_cases hc : recognizedCostChange.isZero = true
    · simp only [hc, ↓reduceIte] at h
      cases ha : postingId (request.id.value ++ "-adjustment") with
      | error e => simp [ha] at h
      | ok aid =>
        simp only [ha, Except.ok.injEq] at h
        subst h
        exact ⟨[], [], aid, rfl, fun _ => rfl, fun h' => absurd hi (by simp [h']),
          fun _ => rfl, fun h' => absurd hc (by simp [h'])⟩
    · have hc' : recognizedCostChange.isZero = false := Bool.eq_false_iff.mpr hc
      simp only [hc', Bool.false_eq_true, ↓reduceIte] at h
      cases hid : postingId (request.id.value ++ "-recognized-cost") with
      | error e => simp [hid] at h
      | ok cid =>
        simp only [hid] at h
        cases ha : postingId (request.id.value ++ "-adjustment") with
        | error e => simp [ha] at h
        | ok aid =>
          simp only [ha, Except.ok.injEq] at h
          subst h
          exact ⟨[], [adjustmentPosting cid policy.recognizedCostAccountId functionalCommodityId
            recognizedCostChange], aid, rfl, fun _ => rfl, fun h' => absurd hi (by simp [h']),
            fun h' => absurd h' hc, fun _ => ⟨cid, rfl⟩⟩
  · have hi' : inventoryChange.isZero = false := Bool.eq_false_iff.mpr hi
    simp only [hi', Bool.false_eq_true, ↓reduceIte] at h
    cases hid : postingId (request.id.value ++ "-inventory") with
    | error e => simp [hid] at h
    | ok iid =>
      simp only [hid] at h
      by_cases hc : recognizedCostChange.isZero = true
      · simp only [hc, ↓reduceIte] at h
        cases ha : postingId (request.id.value ++ "-adjustment") with
        | error e => simp [ha] at h
        | ok aid =>
          simp only [ha, Except.ok.injEq] at h
          subst h
          exact ⟨[adjustmentPosting iid policy.inventoryAccountId functionalCommodityId
            inventoryChange], [], aid, rfl, fun h' => absurd h' hi, fun _ => ⟨iid, rfl⟩,
            fun _ => rfl, fun h' => absurd hc (by simp [h'])⟩
      · have hc' : recognizedCostChange.isZero = false := Bool.eq_false_iff.mpr hc
        simp only [hc', Bool.false_eq_true, ↓reduceIte] at h
        cases hcid : postingId (request.id.value ++ "-recognized-cost") with
        | error e => simp [hcid] at h
        | ok cid =>
          simp only [hcid] at h
          cases ha : postingId (request.id.value ++ "-adjustment") with
          | error e => simp [ha] at h
          | ok aid =>
            simp only [ha, Except.ok.injEq] at h
            subst h
            exact ⟨[adjustmentPosting iid policy.inventoryAccountId functionalCommodityId
              inventoryChange], [adjustmentPosting cid policy.recognizedCostAccountId
              functionalCommodityId recognizedCostChange], aid, rfl, fun h' => absurd h' hi,
              fun _ => ⟨iid, rfl⟩, fun h' => absurd h' hc, fun _ => ⟨cid, rfl⟩⟩

/-! ## The tests of the adjustment -/

set_option maxRecDepth 100000 in
/-- The nine diagnostics of `calculateInventoryValueAdjustment` differ, so the diagnostic says which
test rejected. -/
theorem adjustmentDiagnostics_nodup :
    [policyAtDiagnostic .inventoryValueAdjustment, identityDiagnostic, sourceSignDiagnostic,
      signsDiagnostic, combinedDiagnostic, targetDiagnostic, amountDirectionDiagnostic,
      allowanceDirectionDiagnostic, resultingDiagnostic].Nodup := by
  decide

/-- When no test of the adjustment rejects, every step returned and every test passed: the sum of the
allocations and the population of holdings, the test of identity and conservation, the signs, the
targets, the directions, and the holdings after the adjustment. -/
theorem adjustmentRejection_none_inv {policies : List AccountingPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holdings : List LotHolding}
    {request : InventoryValueAdjustmentRequest} {policy : InventoryValueAdjustmentPolicy}
    (h : adjustmentRejection policies bookId functionalCommodityId lots holdings request policy =
      .ok none) :
    ∃ (allocated : ExactRational) (holdingPopulation : Bool) (resulting : List LotHolding),
      exactAllocated request.allocations = .ok allocated ∧
      holdingPopulationValid policy bookId functionalCommodityId lots holdings =
        .ok holdingPopulation ∧
      identityRejected policy (linkedInventoryPolicies policies policy request.policyEffectiveAt)
        bookId functionalCommodityId lots holdings request
        (lotPopulationValid bookId functionalCommodityId lots) holdingPopulation allocated =
          false ∧
      sourceSignRejected request.kind request.exactSourceAmount = false ∧
      allocationSignsValid request.kind request.allocations = true ∧
      combinedRejected request.kind request.allocations = false ∧
      request.allocations.any (targetRejected holdings) = false ∧
      amountDirectionRejected request.kind request.exactSourceAmount = false ∧
      allowanceDirectionValid request.kind request.allocations = true ∧
      applyInventoryValueAdjustmentToHoldings holdings request.allocations = .ok resulting ∧
      resultingRejected resulting = false := by
  unfold adjustmentRejection at h
  cases h1 : exactAllocated request.allocations with
  | error e => simp [h1] at h
  | ok allocated =>
    simp only [h1] at h
    cases h2 : holdingPopulationValid policy bookId functionalCommodityId lots holdings with
    | error e => simp [h2] at h
    | ok holdingPopulation =>
      simp only [h2] at h
      by_cases c1 : identityRejected policy
          (linkedInventoryPolicies policies policy request.policyEffectiveAt) bookId
          functionalCommodityId lots holdings request
          (lotPopulationValid bookId functionalCommodityId lots) holdingPopulation allocated = true
      · simp [c1] at h
      · simp only [c1, ↓reduceIte] at h
        by_cases c2 : sourceSignRejected request.kind request.exactSourceAmount = true
        · simp [c2] at h
        · simp only [c2, ↓reduceIte] at h
          by_cases c3 : allocationSignsValid request.kind request.allocations = true
          · simp only [c3, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
            by_cases c4 : combinedRejected request.kind request.allocations = true
            · simp [c4] at h
            · simp only [c4, ↓reduceIte] at h
              by_cases c5 : request.allocations.any (targetRejected holdings) = true
              · simp [c5] at h
              · simp only [c5, ↓reduceIte] at h
                by_cases c6 : amountDirectionRejected request.kind request.exactSourceAmount = true
                · simp [c6] at h
                · simp only [c6, ↓reduceIte] at h
                  by_cases c7 : allowanceDirectionValid request.kind request.allocations = true
                  · simp only [c7, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
                    cases h8 : applyInventoryValueAdjustmentToHoldings holdings request.allocations
                    with
                    | error e => simp [h8] at h
                    | ok resulting =>
                      simp only [h8] at h
                      by_cases c8 : resultingRejected resulting = true
                      · simp [c8] at h
                      · exact ⟨allocated, holdingPopulation, resulting, rfl, rfl,
                          Bool.eq_false_iff.mpr c1, Bool.eq_false_iff.mpr c2, c3,
                          Bool.eq_false_iff.mpr c4, Bool.eq_false_iff.mpr c5,
                          Bool.eq_false_iff.mpr c6, c7, rfl, Bool.eq_false_iff.mpr c8⟩
                  · simp [c7] at h
          · simp [c3] at h

/-! ## The sums of the allocations -/

/-- Mapping with a function that can throw, when it returns: one value an element, each constructible
and meaning what the function says it means. -/
theorem mapAll_ok {α : Type} {f : α → Except NumErr ExactRational} {g : α → ℚ} :
    ∀ {xs : List α} {ys : List ExactRational},
      (∀ x ∈ xs, ∀ y, f x = .ok y → y.WF ∧ y.toRat = g x) → mapAll f xs = .ok ys →
      (∀ y ∈ ys, y.WF) ∧ ys.map ExactRational.toRat = xs.map g
  | [], ys, _, h => by
    simp only [mapAll, Except.ok.injEq] at h
    subst h
    exact ⟨fun y hy => absurd hy (by simp), rfl⟩
  | x :: rest, ys, hf, h => by
    simp only [mapAll] at h
    cases h1 : f x with
    | error e => simp [h1] at h
    | ok y =>
      simp only [h1] at h
      cases h2 : mapAll f rest with
      | error e => simp [h2] at h
      | ok later =>
        simp only [h2, Except.ok.injEq] at h
        subst h
        obtain ⟨hw, hr⟩ := hf x List.mem_cons_self y h1
        obtain ⟨hlw, hlr⟩ := mapAll_ok (fun x' hx' => hf x' (List.mem_cons_of_mem _ hx')) h2
        refine ⟨fun z hz => ?_, ?_⟩
        · rcases List.mem_cons.mp hz with rfl | hz
          · exact hw
          · exact hlw z hz
        · simp only [List.map_cons, hr, hlr]

/-- A sum of a mapped list, when it returns: it is constructible and means the sum of what the
elements mean. -/
theorem sumMapped_ok {α : Type} {f : α → Except NumErr ExactRational} {g : α → ℚ}
    {xs : List α} {r : ExactRational}
    (hf : ∀ x ∈ xs, ∀ y, f x = .ok y → y.WF ∧ y.toRat = g x) (h : sumMapped f xs = .ok r) :
    r.WF ∧ r.toRat = (xs.map g).sum := by
  unfold sumMapped at h
  cases h1 : mapAll f xs with
  | error e => simp [h1] at h
  | ok ys =>
    simp only [h1] at h
    obtain ⟨hw, hr⟩ := mapAll_ok hf h1
    obtain ⟨hrw, hrr⟩ := accountingSum_ok hw h
    exact ⟨hrw, by rw [hrr, hr]⟩

/-- What one allocation adds up to, when the sums return: its basis, recognized cost and allowance
changes added. -/
theorem allocationTotal_ok {allocation : InventoryValueAdjustmentAllocation}
    (ha : allocation.WF) {t : ExactRational} (h : allocationTotal allocation = .ok t) :
    t.WF ∧ t.toRat = allocation.remainingBasisChange.toRat + allocation.recognizedCostChange.toRat +
      allocation.remainingValuationAllowanceChange.toRat := by
  unfold allocationTotal at h
  cases h1 : allocation.remainingBasisChange.add allocation.recognizedCostChange with
  | error e => simp [h1] at h
  | ok sofar =>
    simp only [h1] at h
    obtain ⟨hw1, hr1⟩ := ExactRational.add_ok ha.remainingBasisChange ha.recognizedCostChange h1
    obtain ⟨hw2, hr2⟩ := ExactRational.add_ok hw1 ha.remainingValuationAllowanceChange h
    exact ⟨hw2, by rw [hr2, hr1]⟩

/-- The sum of the allocations, when it returns, is constructible and means the total of their three
changes. -/
theorem exactAllocated_ok {allocations : List InventoryValueAdjustmentAllocation}
    (ha : ∀ a ∈ allocations, a.WF) {r : ExactRational} (h : exactAllocated allocations = .ok r) :
    r.WF ∧ r.toRat = (allocations.map fun a => a.remainingBasisChange.toRat +
      a.recognizedCostChange.toRat + a.remainingValuationAllowanceChange.toRat).sum :=
  sumMapped_ok (fun x hx _ hy => allocationTotal_ok (ha x hx) hy) h

/-! ## The journal of an adjustment balances -/

/-- The postings of the adjustment's journal add up to the inventory change plus the recognized cost
change less the amount, which they carry with its sign changed. -/
theorem adjustmentPostings_sum {request : InventoryValueAdjustmentRequest}
    {policy : InventoryValueAdjustmentPolicy} {functionalCommodityId : CommodityId}
    {inventoryChange recognizedCostChange : ExactRational} {postings : List ExactPreparedPosting}
    (hic : inventoryChange.WF) (hrc : recognizedCostChange.WF)
    (h : adjustmentPostings request policy functionalCommodityId inventoryChange
      recognizedCostChange = .ok postings) :
    (postings.map (·.exactBookValue.toRat)).sum =
      inventoryChange.toRat + recognizedCostChange.toRat - request.exactSourceAmount.toRat := by
  obtain ⟨ip, cp, aid, rfl, hi0, hi1, hc0, hc1⟩ := adjustmentPostings_spec h
  have hip : (ip.map (·.exactBookValue.toRat)).sum = inventoryChange.toRat := by
    by_cases hz : inventoryChange.isZero = true
    · rw [hi0 hz]
      simp [(ExactRational.isZero_iff hic).mp hz]
    · obtain ⟨id, hid⟩ := hi1 (Bool.eq_false_iff.mpr hz)
      rw [hid]
      simp [adjustmentPosting]
  have hcp : (cp.map (·.exactBookValue.toRat)).sum = recognizedCostChange.toRat := by
    by_cases hz : recognizedCostChange.isZero = true
    · rw [hc0 hz]
      simp [(ExactRational.isZero_iff hrc).mp hz]
    · obtain ⟨id, hid⟩ := hc1 (Bool.eq_false_iff.mpr hz)
      rw [hid]
      simp [adjustmentPosting]
  simp only [List.map_append, List.sum_append, hip, hcp, List.map_cons, List.map_nil, List.sum_cons,
    List.sum_nil, adjustmentPosting, ExactRational.negate_toRat]
  ring

/-- The total of the inventory change and the recognized cost change is the total of the allocations. -/
theorem allocations_split (allocations : List InventoryValueAdjustmentAllocation) :
    (allocations.map fun a => a.remainingBasisChange.toRat +
        a.remainingValuationAllowanceChange.toRat).sum +
      (allocations.map fun a => a.recognizedCostChange.toRat).sum =
    (allocations.map fun a => a.remainingBasisChange.toRat + a.recognizedCostChange.toRat +
        a.remainingValuationAllowanceChange.toRat).sum := by
  induction allocations with
  | nil => simp
  | cons a rest ih =>
    simp only [List.map_cons, List.sum_cons]
    rw [← ih]
    ring

/-- What an adjustment that is not rejected says of the amount: it is not zero and it equals the total of
the allocations' three changes, which is the identity and conservation test. -/
theorem identityRejected_false_equals {policy : InventoryValueAdjustmentPolicy}
    {linked : List InventoryCostPolicy} {bookId : BookId} {functionalCommodityId : CommodityId}
    {lots : List Lot} {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest}
    {lotPopulation holdingPopulation : Bool} {allocated : ExactRational}
    (h : identityRejected policy linked bookId functionalCommodityId lots holdings request
      lotPopulation holdingPopulation allocated = false) :
    allocated.equals request.exactSourceAmount = true ∧ holdingPopulation = true ∧
      lotPopulation = true ∧ request.exactSourceAmount.isZero = false := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · by_contra hn
    have hn' : allocated.equals request.exactSourceAmount = false := Bool.eq_false_iff.mpr hn
    simp [identityRejected, hn'] at h
  · by_contra hn
    have hn' : holdingPopulation = false := Bool.eq_false_iff.mpr hn
    simp [identityRejected, hn'] at h
  · by_contra hn
    have hn' : lotPopulation = false := Bool.eq_false_iff.mpr hn
    simp [identityRejected, hn'] at h
  · by_contra hn
    have hn' : request.exactSourceAmount.isZero = true := by simpa using hn
    simp [identityRejected, hn'] at h

/-- When the adjustment is drafted, the policy was selected, no test rejected, and the draft was made. -/
theorem calculateInventoryValueAdjustment_draft_inv {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    ∃ policy : InventoryValueAdjustmentPolicy,
      policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .selected policy ∧
      adjustmentRejection policies bookId functionalCommodityId lots holdings request policy =
        .ok none ∧
      adjustmentDraft bookId functionalCommodityId policy request = .ok (.draft d) := by
  unfold calculateInventoryValueAdjustment at h
  cases hp : policyAt InventoryValueAdjustmentPolicy policies request.policyId
      request.policyVersion request.policyEffectiveAt with
  | rejected ds => simp [hp] at h
  | selected policy =>
    simp only [hp] at h
    cases hr : liftNum (adjustmentRejection policies bookId functionalCommodityId lots holdings
        request policy) with
    | error e => simp [hr] at h
    | ok o =>
      cases o with
      | some rejection => simp [hr] at h
      | none =>
        simp only [hr] at h
        exact ⟨policy, rfl, liftNum_eq_ok.mp hr, h⟩

/-- The journal an adjustment drafts balances: its postings add up to zero, exactly. The draft holds
the one journal, with one posting for the change in inventory (when there is one), one for the
recognized cost (when there is one) and one for the adjustment account, all in the functional
commodity with no cost basis, and the one effect. -/
theorem calculateInventoryValueAdjustment_balanced {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (hr : request.WF)
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    ∃ (policy : InventoryValueAdjustmentPolicy) (jid : JournalId)
      (postings : List ExactPreparedPosting) (bookedAdjustment : QuantizedValue),
      policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .selected policy ∧
      d.journals = [adjustmentJournal request jid postings] ∧
      d.effects = [.inventoryValueAdjustment
        (adjustmentEffect bookId policy request bookedAdjustment)] ∧
      (postings.map (·.exactBookValue.toRat)).sum = 0 ∧
      (∀ posting ∈ postings, posting.units = posting.exactBookValue ∧
        posting.unitsCommodityId = functionalCommodityId ∧ posting.costBasis = none) := by
  obtain ⟨policy, hpol, hrej, hdraft⟩ := calculateInventoryValueAdjustment_draft_inv h
  obtain ⟨ic, rc, postings, booked, jid, hic, hrc, hpost, hq, hj, hd⟩ :=
    adjustmentDraft_inv hdraft
  obtain ⟨allocated, hpop, resulting, hall, hhold, hid, -⟩ := adjustmentRejection_none_inv hrej
  obtain ⟨heq, -, -, -⟩ := identityRejected_false_equals hid
  obtain ⟨hallw, hallr⟩ := exactAllocated_ok hr.allocations hall
  obtain ⟨hicw, hicr⟩ := sumMapped_ok (g := fun a => a.remainingBasisChange.toRat +
      a.remainingValuationAllowanceChange.toRat) (fun a ha y hy => by
    obtain ⟨hw1, hr1⟩ := ExactRational.add_ok (hr.allocations a ha).remainingBasisChange
      (hr.allocations a ha).remainingValuationAllowanceChange hy
    exact ⟨hw1, hr1⟩) hic
  obtain ⟨hrcw, hrcr⟩ := accountingSum_ok (fun v hv => by
    obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hv
    exact (hr.allocations a ha).recognizedCostChange) hrc
  have hbalance := adjustmentPostings_sum hicw hrcw hpost
  have hamount : allocated.toRat = request.exactSourceAmount.toRat :=
    (ExactRational.equals_iff hallw hr.exactSourceAmount).mp heq
  refine ⟨policy, jid, postings, booked, hpol, ?_, ?_, ?_, ?_⟩
  · rw [hd]
  · rw [hd]
  · rw [hbalance, hicr, hrcr, List.map_map, ← hamount, hallr]
    have := allocations_split request.allocations
    simp only [Function.comp_def] at this ⊢
    linarith
  · obtain ⟨ip, cp, aid, rfl, hi0, hi1, hc0, hc1⟩ := adjustmentPostings_spec hpost
    intro posting hposting
    simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hposting
    rcases hposting with (hp | hp) | hp
    · by_cases hz : ic.isZero = true
      · rw [hi0 hz] at hp; cases hp
      · obtain ⟨id, hid'⟩ := hi1 (Bool.eq_false_iff.mpr hz)
        rw [hid'] at hp
        simp only [List.mem_singleton] at hp
        subst hp
        exact ⟨rfl, rfl, rfl⟩
    · by_cases hz : rc.isZero = true
      · rw [hc0 hz] at hp; cases hp
      · obtain ⟨id, hid'⟩ := hc1 (Bool.eq_false_iff.mpr hz)
        rw [hid'] at hp
        simp only [List.mem_singleton] at hp
        subst hp
        exact ⟨rfl, rfl, rfl⟩
    · subst hp
      exact ⟨rfl, rfl, rfl⟩

/-! ## What an adjustment does to the holdings -/

/-- `after` is `before` as an adjustment leaves it: a holding with no allocation is unchanged; one with
an allocation has its total basis and its valuation allowance changed by that allocation's changes and
its carrying amount made their sum, and nothing else changes (identifier, book, lot, account,
commodities and quantity). -/
structure HoldingAfter
    (byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation))
    (before after : LotHolding) : Prop where
  wf : after.WF
  frame : after = { before with
    remainingTotalBasis := after.remainingTotalBasis
    remainingValuationAllowance := after.remainingValuationAllowance
    remainingCarryingAmount := after.remainingCarryingAmount }
  untouched : Lots.mapGet byHolding before.id = none → after = before
  touched : ∀ a, Lots.mapGet byHolding before.id = some a →
    after.remainingTotalBasis.toRat = before.remainingTotalBasis.toRat +
      a.remainingBasisChange.toRat ∧
    after.remainingValuationAllowance.toRat = before.remainingValuationAllowance.toRat +
      a.remainingValuationAllowanceChange.toRat ∧
    after.remainingCarryingAmount.toRat =
      after.remainingTotalBasis.toRat + after.remainingValuationAllowance.toRat

/-- What the callback of the map does to one constructible holding. -/
theorem adjustHolding_spec {byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation)}
    {holding after : LotHolding} (hh : holding.WF)
    (hb : ∀ id a, (id, a) ∈ byHolding → a.WF) (h : adjustHolding byHolding holding = .ok after) :
    HoldingAfter byHolding holding after := by
  unfold adjustHolding at h
  cases hg : Lots.mapGet byHolding holding.id with
  | none =>
    simp only [hg, Except.ok.injEq] at h
    subst h
    exact ⟨hh, rfl, fun _ => rfl, fun a ha => absurd (hg.symm.trans ha) (by simp)⟩
  | some allocation =>
    simp only [hg] at h
    have haw := hb _ _ (Lots.mem_of_mapGet hg)
    cases h1 : holding.remainingTotalBasis.add allocation.remainingBasisChange with
    | error e => simp [h1] at h
    | ok tb =>
      simp only [h1] at h
      cases h2 : holding.remainingValuationAllowance.add
          allocation.remainingValuationAllowanceChange with
      | error e => simp [h2] at h
      | ok al =>
        simp only [h2] at h
        cases h3 : tb.add al with
        | error e => simp [h3] at h
        | ok carrying =>
          simp only [h3, Except.ok.injEq] at h
          subst h
          obtain ⟨hw1, hr1⟩ := ExactRational.add_ok hh.remainingTotalBasis haw.remainingBasisChange h1
          obtain ⟨hw2, hr2⟩ := ExactRational.add_ok hh.remainingValuationAllowance
            haw.remainingValuationAllowanceChange h2
          obtain ⟨hw3, hr3⟩ := ExactRational.add_ok hw1 hw2 h3
          refine ⟨⟨hh.remainingQuantity, hw1, hw2, hw3⟩, rfl, fun hn => ?_, fun a ha => ?_⟩
          · exact absurd (hg.symm.trans hn) (by simp)
          · rw [hg] at ha
            cases ha
            exact ⟨hr1, hr2, hr3⟩

/-- What the map does to the holdings: each is related to the holding it becomes, in order. -/
theorem adjustHoldings_spec {byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation)}
    (hb : ∀ id a, (id, a) ∈ byHolding → a.WF) :
    ∀ {holdings after : List LotHolding}, (∀ h ∈ holdings, h.WF) →
      adjustHoldings byHolding holdings = .ok after →
      List.Forall₂ (HoldingAfter byHolding) holdings after
  | [], after, _, h => by
    simp only [adjustHoldings, Except.ok.injEq] at h
    subst h
    exact List.Forall₂.nil
  | holding :: rest, after, hh, h => by
    simp only [adjustHoldings] at h
    cases h1 : adjustHolding byHolding holding with
    | error e => simp [h1] at h
    | ok adjusted =>
      simp only [h1] at h
      cases h2 : adjustHoldings byHolding rest with
      | error e => simp [h2] at h
      | ok later =>
        simp only [h2, Except.ok.injEq] at h
        subst h
        exact List.Forall₂.cons (adjustHolding_spec (hh holding List.mem_cons_self) hb h1)
          (adjustHoldings_spec hb (fun x hx => hh x (List.mem_cons_of_mem _ hx)) h2)

/-- The entries of the map of allocations by holding are constructible when the allocations are. -/
theorem allocationsByHolding_wf {allocations : List InventoryValueAdjustmentAllocation}
    (ha : ∀ a ∈ allocations, a.WF) :
    ∀ id a, (id, a) ∈ allocationsByHolding allocations → a.WF := by
  intro id a hmem
  unfold allocationsByHolding at hmem
  obtain ⟨b, hb, hbb⟩ := List.mem_filterMap.mp hmem
  cases hid : b.holdingId with
  | none => simp [hid] at hbb
  | some hid' =>
    simp only [hid, Option.map_some, Option.some.injEq, Prod.mk.injEq] at hbb
    obtain ⟨-, rfl⟩ := hbb
    exact ha b hb

/-- `applyInventoryValueAdjustmentToHoldings`, for constructible holdings and allocations, returns a
holding for each holding, in order, each as the adjustment leaves it. -/
theorem applyInventoryValueAdjustmentToHoldings_spec {holdings after : List LotHolding}
    {allocations : List InventoryValueAdjustmentAllocation} (hh : ∀ h ∈ holdings, h.WF)
    (ha : ∀ a ∈ allocations, a.WF)
    (h : applyInventoryValueAdjustmentToHoldings holdings allocations = .ok after) :
    List.Forall₂ (HoldingAfter (allocationsByHolding allocations)) holdings after :=
  adjustHoldings_spec (allocationsByHolding_wf ha) hh h

/-- A holding the population test accepts: its carrying amount is its basis plus its allowance, its basis
is not negative and its allowance not above zero. -/
theorem holdingValid_true {policy : InventoryValueAdjustmentPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holding : LotHolding}
    (hh : holding.WF) (h : holdingValid policy bookId functionalCommodityId lots holding = .ok true) :
    holding.remainingCarryingAmount.toRat =
        holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat ∧
      0 ≤ holding.remainingTotalBasis.toRat ∧ holding.remainingValuationAllowance.toRat ≤ 0 := by
  unfold holdingValid at h
  cases hl : Lots.lotById lots holding.lotId with
  | none => simp [hl] at h
  | some lot =>
    simp only [hl] at h
    by_cases hc : (holding.bookId == bookId &&
        (policy.algorithmVersion.value != "1.0.0" || holding.accountId == policy.inventoryAccountId) &&
        holding.commodityId == lot.commodityId && holding.basisCommodityId == functionalCommodityId &&
        !holding.remainingQuantity.isNegative && !holding.remainingTotalBasis.isNegative &&
        holding.remainingValuationAllowance.compare ExactRational.zero != .gt) = true
    · simp only [hc, ↓reduceIte] at h
      cases hs : holding.remainingTotalBasis.add holding.remainingValuationAllowance with
      | error e => simp [hs] at h
      | ok carrying =>
        simp only [hs, Except.ok.injEq] at h
        obtain ⟨hcw, hcr⟩ := ExactRational.add_ok hh.remainingTotalBasis
          hh.remainingValuationAllowance hs
        simp only [Bool.and_eq_true] at h hc
        obtain ⟨⟨⟨⟨⟨⟨-, -⟩, -⟩, -⟩, -⟩, hnb⟩, hal⟩ := hc
        have hnb' : ¬ holding.remainingTotalBasis.toRat < 0 := fun hl => by
          have := (ExactRational.isNegative_iff hh.remainingTotalBasis).mpr hl
          simp [this] at hnb
        have hal' : ¬ 0 < holding.remainingValuationAllowance.toRat := fun hl => by
          have := (ExactRational.compare_gt_iff hh.remainingValuationAllowance
            ExactRational.zero_wf).mpr (by rw [ExactRational.zero_toRat]; exact hl)
          simp [this] at hal
        refine ⟨?_, not_lt.mp hnb', not_lt.mp hal'⟩
        rw [(ExactRational.equals_iff hh.remainingCarryingAmount hcw).mp h.1, hcr]
    · simp [hc] at h

/-- Every holding of a population the test accepts is accepted. -/
theorem holdingsAllValid_true {policy : InventoryValueAdjustmentPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} :
    ∀ {holdings : List LotHolding},
      holdingsAllValid policy bookId functionalCommodityId lots holdings = .ok true →
      ∀ x ∈ holdings, holdingValid policy bookId functionalCommodityId lots x = .ok true
  | [], _ => fun x hx => by cases hx
  | holding :: rest, h => by
    simp only [holdingsAllValid] at h
    cases hv : holdingValid policy bookId functionalCommodityId lots holding with
    | error e => simp [hv] at h
    | ok b =>
      cases b with
      | false => simp [hv] at h
      | true =>
        simp only [hv] at h
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hx
        · exact hv
        · exact holdingsAllValid_true h x hx

/-- The holdings an adjustment starts from, when it is not rejected: each has its carrying amount equal
to its basis plus its allowance, a basis that is not negative and an allowance not above zero. -/
theorem holdingPopulationValid_true {policy : InventoryValueAdjustmentPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holdings : List LotHolding}
    (hh : ∀ x ∈ holdings, x.WF)
    (h : holdingPopulationValid policy bookId functionalCommodityId lots holdings = .ok true) :
    ∀ x ∈ holdings, x.remainingCarryingAmount.toRat =
        x.remainingTotalBasis.toRat + x.remainingValuationAllowance.toRat ∧
      0 ≤ x.remainingTotalBasis.toRat ∧ x.remainingValuationAllowance.toRat ≤ 0 := by
  unfold holdingPopulationValid at h
  by_cases hs : (Lots.setSize (holdings.map (·.id)) == holdings.length) = true
  · simp only [hs, ↓reduceIte] at h
    intro x hx
    exact holdingValid_true (hh x hx) (holdingsAllValid_true h x hx)
  · simp [hs] at h

/-- The holdings after an adjustment are the holdings before, one each in order, each as the adjustment
leaves it (`HoldingAfter`); before and after, every holding's carrying amount is its basis plus its
allowance; before, no basis is negative and no allowance is above zero; after, none of the three is
negative, so a write-down never takes the carrying amount below zero and a reversal never raises the
allowance above zero. -/
theorem calculateInventoryValueAdjustment_holdings {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (hh : ∀ x ∈ holdings, x.WF) (hr : request.WF)
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    ∃ resulting : List LotHolding,
      applyInventoryValueAdjustmentToHoldings holdings request.allocations = .ok resulting ∧
      List.Forall₂ (HoldingAfter (allocationsByHolding request.allocations)) holdings resulting ∧
      (∀ x ∈ holdings, x.remainingCarryingAmount.toRat =
          x.remainingTotalBasis.toRat + x.remainingValuationAllowance.toRat ∧
        0 ≤ x.remainingTotalBasis.toRat ∧ x.remainingValuationAllowance.toRat ≤ 0) ∧
      (∀ x ∈ resulting, x.remainingCarryingAmount.toRat =
          x.remainingTotalBasis.toRat + x.remainingValuationAllowance.toRat ∧
        0 ≤ x.remainingTotalBasis.toRat ∧ 0 ≤ x.remainingCarryingAmount.toRat ∧
        x.remainingValuationAllowance.toRat ≤ 0) := by
  obtain ⟨policy, hpol, hrej, -⟩ := calculateInventoryValueAdjustment_draft_inv h
  obtain ⟨allocated, hpop, resulting, hall, hhold, hid, -, -, -, -, -, -, happly, hres⟩ :=
    adjustmentRejection_none_inv hrej
  obtain ⟨-, hpop', -, -⟩ := identityRejected_false_equals hid
  subst hpop'
  have hbefore := holdingPopulationValid_true hh hhold
  have hfa := applyInventoryValueAdjustmentToHoldings_spec hh hr.allocations happly
  refine ⟨resulting, happly, hfa, hbefore, ?_⟩
  intro x hx
  obtain ⟨y, hy, hxy⟩ := forall₂_right_mem hfa x hx
  have hxw := hxy.wf
  have hcarry : x.remainingCarryingAmount.toRat =
      x.remainingTotalBasis.toRat + x.remainingValuationAllowance.toRat := by
    cases hg : Lots.mapGet (allocationsByHolding request.allocations) y.id with
    | none => rw [hxy.untouched hg]; exact (hbefore y hy).1
    | some a => exact (hxy.touched a hg).2.2
  unfold resultingRejected at hres
  simp only [List.any_eq_false, Bool.or_eq_true, not_or] at hres
  obtain ⟨⟨hnb, hnc⟩, hal⟩ := hres x hx
  refine ⟨hcarry, ?_, ?_, ?_⟩
  · by_contra hn
    exact hnb ((ExactRational.isNegative_iff hxw.remainingTotalBasis).mpr (not_le.mp hn))
  · by_contra hn
    exact hnc ((ExactRational.isNegative_iff hxw.remainingCarryingAmount).mpr (not_le.mp hn))
  · by_contra hn
    exact hal (by
      have := (ExactRational.compare_gt_iff hxw.remainingValuationAllowance
        ExactRational.zero_wf).mpr (by rw [ExactRational.zero_toRat]; exact not_le.mp hn)
      simp [this])

/-! ## What the allocations of each kind say -/

/-- The kinds that change the historical basis are exactly three. -/
theorem capitalizable_iff (kind : InventoryValueAdjustmentKind) :
    capitalizable kind = true ↔ kind = .directlyAttributableCost ∨ kind = .purchaseRebate ∨
      kind = .productionOverhead := by
  unfold capitalizable
  simp only [Bool.or_eq_true, beq_iff_eq, or_assoc]

/-- A write-down or reversal changes neither the basis nor the recognized cost of any allocation, only
the allowance. -/
theorem allocationSignsValid_writeDown {kind : InventoryValueAdjustmentKind}
    {allocations : List InventoryValueAdjustmentAllocation}
    (hk : capitalizable kind = false) (ha : ∀ a ∈ allocations, a.WF)
    (h : allocationSignsValid kind allocations = true) :
    ∀ a ∈ allocations, a.remainingBasisChange.toRat = 0 ∧ a.recognizedCostChange.toRat = 0 := by
  intro a hmem
  unfold allocationSignsValid at h
  rw [List.all_eq_true] at h
  have := h a hmem
  simp only [hk, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at this
  exact ⟨(ExactRational.isZero_iff (ha a hmem).remainingBasisChange).mp this.1,
    (ExactRational.isZero_iff (ha a hmem).recognizedCostChange).mp this.2⟩

/-- A cost, rebate or overhead leaves every allowance alone, and its basis and recognized cost move one
way: down (not above zero) for a purchase rebate, up (not below zero) for the others. -/
theorem allocationSignsValid_capitalized {kind : InventoryValueAdjustmentKind}
    {allocations : List InventoryValueAdjustmentAllocation}
    (hk : capitalizable kind = true) (ha : ∀ a ∈ allocations, a.WF)
    (h : allocationSignsValid kind allocations = true) :
    ∀ a ∈ allocations, a.remainingValuationAllowanceChange.toRat = 0 ∧
      (kind = .purchaseRebate → a.remainingBasisChange.toRat ≤ 0 ∧ a.recognizedCostChange.toRat ≤ 0) ∧
      (kind ≠ .purchaseRebate → 0 ≤ a.remainingBasisChange.toRat ∧ 0 ≤ a.recognizedCostChange.toRat) := by
  intro a hmem
  unfold allocationSignsValid at h
  rw [List.all_eq_true] at h
  have hh := h a hmem
  have haw := ha a hmem
  simp only [hk, ↓reduceIte] at hh
  by_cases hr : kind = .purchaseRebate
  · simp only [hr, beq_self_eq_true, ↓reduceIte, Bool.and_eq_true] at hh
    obtain ⟨⟨hb, hc⟩, hw⟩ := hh
    refine ⟨(ExactRational.isZero_iff haw.remainingValuationAllowanceChange).mp hw,
      fun _ => ⟨?_, ?_⟩, fun hne => absurd hr hne⟩
    · by_contra hn
      have := (ExactRational.compare_gt_iff haw.remainingBasisChange ExactRational.zero_wf).mpr
        (by rw [ExactRational.zero_toRat]; exact not_le.mp hn)
      simp [this] at hb
    · by_contra hn
      have := (ExactRational.compare_gt_iff haw.recognizedCostChange ExactRational.zero_wf).mpr
        (by rw [ExactRational.zero_toRat]; exact not_le.mp hn)
      simp [this] at hc
  · have hr' : (kind == .purchaseRebate) = false := by simpa using hr
    simp only [hr', Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at hh
    obtain ⟨⟨hb, hc⟩, hw⟩ := hh
    refine ⟨(ExactRational.isZero_iff haw.remainingValuationAllowanceChange).mp hw,
      fun h' => absurd h' hr, fun _ => ⟨?_, ?_⟩⟩
    · by_contra hn
      have := (ExactRational.isNegative_iff haw.remainingBasisChange).mpr (not_le.mp hn)
      simp [this] at hb
    · by_contra hn
      have := (ExactRational.isNegative_iff haw.recognizedCostChange).mpr (not_le.mp hn)
      simp [this] at hc

/-- What an adjustment that is drafted conserves: the amount is not zero, and it is exactly the total of
the three changes of the allocations. A write-down or a reversal changes only the allowance: no
allocation changes a basis or a recognized cost, the allocations' allowance changes add up to the
amount, a write-down lowers every allowance and a reversal raises every one. -/
theorem calculateInventoryValueAdjustment_conservation {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (hr : request.WF)
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    request.exactSourceAmount.toRat ≠ 0 ∧
      (request.allocations.map fun a => a.remainingBasisChange.toRat + a.recognizedCostChange.toRat +
        a.remainingValuationAllowanceChange.toRat).sum = request.exactSourceAmount.toRat ∧
      ((request.kind = .writeDown ∨ request.kind = .writeDownReversal) →
        (∀ a ∈ request.allocations, a.remainingBasisChange.toRat = 0 ∧
          a.recognizedCostChange.toRat = 0) ∧
        (request.allocations.map (·.remainingValuationAllowanceChange.toRat)).sum =
          request.exactSourceAmount.toRat ∧
        (request.kind = .writeDown → request.exactSourceAmount.toRat < 0 ∧
          ∀ a ∈ request.allocations, a.remainingValuationAllowanceChange.toRat < 0) ∧
        (request.kind = .writeDownReversal → 0 < request.exactSourceAmount.toRat ∧
          ∀ a ∈ request.allocations, 0 < a.remainingValuationAllowanceChange.toRat)) ∧
      ((request.kind = .directlyAttributableCost ∨ request.kind = .purchaseRebate ∨
          request.kind = .productionOverhead) →
        (∀ a ∈ request.allocations, a.remainingValuationAllowanceChange.toRat = 0) ∧
        (request.allocations.map fun a => a.remainingBasisChange.toRat +
          a.recognizedCostChange.toRat).sum = request.exactSourceAmount.toRat ∧
        (request.kind = .purchaseRebate → request.exactSourceAmount.toRat < 0 ∧
          ∀ a ∈ request.allocations, a.remainingBasisChange.toRat ≤ 0 ∧
            a.recognizedCostChange.toRat ≤ 0) ∧
        (request.kind ≠ .purchaseRebate → 0 < request.exactSourceAmount.toRat ∧
          ∀ a ∈ request.allocations, 0 ≤ a.remainingBasisChange.toRat ∧
            0 ≤ a.recognizedCostChange.toRat)) := by
  obtain ⟨policy, hpol, hrej, -⟩ := calculateInventoryValueAdjustment_draft_inv h
  obtain ⟨allocated, hpop, resulting, hall, hhold, hid, c2, c3, c4, c5, c6, c7, -, -⟩ :=
    adjustmentRejection_none_inv hrej
  obtain ⟨heq, -, -, hzero⟩ := identityRejected_false_equals hid
  obtain ⟨hallw, hallr⟩ := exactAllocated_ok hr.allocations hall
  have hsum : (request.allocations.map fun a => a.remainingBasisChange.toRat +
      a.recognizedCostChange.toRat + a.remainingValuationAllowanceChange.toRat).sum =
      request.exactSourceAmount.toRat := by
    rw [← hallr]
    exact (ExactRational.equals_iff hallw hr.exactSourceAmount).mp heq
  have hne : request.exactSourceAmount.toRat ≠ 0 := fun h0 => by
    have := (ExactRational.isZero_iff hr.exactSourceAmount).mpr h0
    rw [hzero] at this
    cases this
  refine ⟨hne, hsum, ?_, ?_⟩
  · intro hk
    have hcap : capitalizable request.kind = false := by
      rcases hk with hk | hk <;> simp [capitalizable, hk]
    have hbr := allocationSignsValid_writeDown hcap hr.allocations c3
    have hall' : (request.allocations.map (·.remainingValuationAllowanceChange.toRat)).sum =
        request.exactSourceAmount.toRat := by
      rw [← hsum]
      congr 1
      apply List.map_congr_left
      intro a ha
      rw [(hbr a ha).1, (hbr a ha).2]
      ring
    refine ⟨hbr, hall', ?_, ?_⟩
    · intro hwd
      refine ⟨?_, ?_⟩
      · by_contra hn
        have hge : 0 ≤ request.exactSourceAmount.toRat := not_lt.mp hn
        have : amountDirectionRejected request.kind request.exactSourceAmount = true := by
          simp only [amountDirectionRejected, hwd, beq_self_eq_true, Bool.true_and, Bool.or_eq_true]
          left
          have : request.exactSourceAmount.compare ExactRational.zero ≠ .lt := fun hlt =>
            absurd ((ExactRational.compare_lt_iff hr.exactSourceAmount ExactRational.zero_wf).mp hlt)
              (by rw [ExactRational.zero_toRat]; exact not_lt.mpr hge)
          simpa using this
        rw [c6] at this
        cases this
      · intro a ha
        unfold allowanceDirectionValid at c7
        rw [List.all_eq_true] at c7
        have := c7 a ha
        simp only [hwd] at this
        exact (ExactRational.compare_lt_iff (hr.allocations a ha).remainingValuationAllowanceChange
          ExactRational.zero_wf).mp (by simpa using this) |> fun x => by rwa [ExactRational.zero_toRat] at x
    · intro hrv
      refine ⟨?_, ?_⟩
      · by_contra hn
        have hle : request.exactSourceAmount.toRat ≤ 0 := not_lt.mp hn
        have : amountDirectionRejected request.kind request.exactSourceAmount = true := by
          simp only [amountDirectionRejected, hrv, beq_self_eq_true, Bool.true_and, Bool.or_eq_true]
          right
          have : request.exactSourceAmount.compare ExactRational.zero ≠ .gt := fun hgt =>
            absurd ((ExactRational.compare_gt_iff hr.exactSourceAmount ExactRational.zero_wf).mp hgt)
              (by rw [ExactRational.zero_toRat]; exact not_lt.mpr hle)
          simpa using this
        rw [c6] at this
        cases this
      · intro a ha
        unfold allowanceDirectionValid at c7
        rw [List.all_eq_true] at c7
        have := c7 a ha
        simp only [hrv] at this
        exact (ExactRational.compare_gt_iff (hr.allocations a ha).remainingValuationAllowanceChange
          ExactRational.zero_wf).mp (by simpa using this) |> fun x => by rwa [ExactRational.zero_toRat] at x
  · intro hk
    have hcap : capitalizable request.kind = true := (capitalizable_iff _).mpr hk
    have hsg := allocationSignsValid_capitalized hcap hr.allocations c3
    refine ⟨fun a ha => (hsg a ha).1, ?_, ?_, ?_⟩
    · rw [← hsum]
      congr 1
      apply List.map_congr_left
      intro a ha
      rw [(hsg a ha).1]
      ring
    · intro hrb
      refine ⟨?_, fun a ha => (hsg a ha).2.1 hrb⟩
      by_contra hn
      have hge : 0 ≤ request.exactSourceAmount.toRat := not_lt.mp hn
      have : sourceSignRejected request.kind request.exactSourceAmount = true := by
        have hc2 : capitalizable .purchaseRebate = true := rfl
        simp only [sourceSignRejected, hcap, hrb, hc2, ↓reduceIte, beq_self_eq_true]
        have : request.exactSourceAmount.compare ExactRational.zero ≠ .lt := fun hlt =>
          absurd ((ExactRational.compare_lt_iff hr.exactSourceAmount ExactRational.zero_wf).mp hlt)
            (by rw [ExactRational.zero_toRat]; exact not_lt.mpr hge)
        simpa using this
      rw [c2] at this
      cases this
    · intro hnr
      refine ⟨?_, fun a ha => (hsg a ha).2.2 hnr⟩
      by_contra hn
      have hle : request.exactSourceAmount.toRat ≤ 0 := not_lt.mp hn
      have hnr' : (request.kind == .purchaseRebate) = false := by simpa using hnr
      have : sourceSignRejected request.kind request.exactSourceAmount = true := by
        simp only [sourceSignRejected, hcap, hnr', Bool.false_eq_true, ↓reduceIte]
        have : request.exactSourceAmount.compare ExactRational.zero ≠ .gt := fun hgt =>
          absurd ((ExactRational.compare_gt_iff hr.exactSourceAmount ExactRational.zero_wf).mp hgt)
            (by rw [ExactRational.zero_toRat]; exact not_lt.mpr hle)
        simpa using this
      rw [c2] at this
      cases this

/-! ## Every way the adjustment rejects -/

/-- The test of identity and conservation of line 1053, with what it reads. -/
def identityTest (policies : List AccountingPolicy) (bookId : BookId)
    (functionalCommodityId : CommodityId) (lots : List Lot) (holdings : List LotHolding)
    (request : InventoryValueAdjustmentRequest) (policy : InventoryValueAdjustmentPolicy)
    (holdingPopulation : Bool) (allocated : ExactRational) : Bool :=
  identityRejected policy (linkedInventoryPolicies policies policy request.policyEffectiveAt)
    bookId functionalCommodityId lots holdings request
    (lotPopulationValid bookId functionalCommodityId lots) holdingPopulation allocated

/-- Every way a request for an adjustment is rejected after its policy is selected, each with its
diagnostic and each holding exactly when the sums and the population of holdings returned and every
earlier test passed: identity and conservation, the sign of the amount, the signs of the allocations,
the (never reached) mixed components, the targets, the direction of the amount, the direction of the
allowances, and the holdings after the adjustment. -/
theorem adjustmentRejection_some_iff {policies : List AccountingPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holdings : List LotHolding}
    {request : InventoryValueAdjustmentRequest} {policy : InventoryValueAdjustmentPolicy}
    {rej : SemanticDiagnostic} :
    adjustmentRejection policies bookId functionalCommodityId lots holdings request policy =
        .ok (some rej) ↔
      ∃ (allocated : ExactRational) (holdingPopulation : Bool),
        exactAllocated request.allocations = .ok allocated ∧
        holdingPopulationValid policy bookId functionalCommodityId lots holdings =
          .ok holdingPopulation ∧
        ((identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = true ∧ rej = identityDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = true ∧
            rej = sourceSignDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = false ∧
            allocationSignsValid request.kind request.allocations = false ∧
            rej = signsDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = false ∧
            allocationSignsValid request.kind request.allocations = true ∧
            combinedRejected request.kind request.allocations = true ∧ rej = combinedDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = false ∧
            allocationSignsValid request.kind request.allocations = true ∧
            combinedRejected request.kind request.allocations = false ∧
            request.allocations.any (targetRejected holdings) = true ∧ rej = targetDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = false ∧
            allocationSignsValid request.kind request.allocations = true ∧
            combinedRejected request.kind request.allocations = false ∧
            request.allocations.any (targetRejected holdings) = false ∧
            amountDirectionRejected request.kind request.exactSourceAmount = true ∧
            rej = amountDirectionDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = false ∧
            allocationSignsValid request.kind request.allocations = true ∧
            combinedRejected request.kind request.allocations = false ∧
            request.allocations.any (targetRejected holdings) = false ∧
            amountDirectionRejected request.kind request.exactSourceAmount = false ∧
            allowanceDirectionValid request.kind request.allocations = false ∧
            rej = allowanceDirectionDiagnostic) ∨
          (identityTest policies bookId functionalCommodityId lots holdings request policy
              holdingPopulation allocated = false ∧
            sourceSignRejected request.kind request.exactSourceAmount = false ∧
            allocationSignsValid request.kind request.allocations = true ∧
            combinedRejected request.kind request.allocations = false ∧
            request.allocations.any (targetRejected holdings) = false ∧
            amountDirectionRejected request.kind request.exactSourceAmount = false ∧
            allowanceDirectionValid request.kind request.allocations = true ∧
            (∃ resulting : List LotHolding,
              applyInventoryValueAdjustmentToHoldings holdings request.allocations =
                .ok resulting ∧ resultingRejected resulting = true) ∧
            rej = resultingDiagnostic)) := by
  constructor
  · intro h
    unfold adjustmentRejection at h
    cases h1 : exactAllocated request.allocations with
    | error e => simp [h1] at h
    | ok allocated =>
      simp only [h1] at h
      cases h2 : holdingPopulationValid policy bookId functionalCommodityId lots holdings with
      | error e => simp [h2] at h
      | ok hp =>
        simp only [h2] at h
        refine ⟨allocated, hp, rfl, rfl, ?_⟩
        by_cases c1 : identityRejected policy
            (linkedInventoryPolicies policies policy request.policyEffectiveAt) bookId
            functionalCommodityId lots holdings request
            (lotPopulationValid bookId functionalCommodityId lots) hp allocated = true
        · simp only [c1, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
          exact Or.inl ⟨c1, h.symm⟩
        · have c1' := Bool.eq_false_iff.mpr c1
          simp only [c1, ↓reduceIte] at h
          by_cases c2 : sourceSignRejected request.kind request.exactSourceAmount = true
          · simp only [c2, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
            exact Or.inr (Or.inl ⟨c1', c2, h.symm⟩)
          · have c2' := Bool.eq_false_iff.mpr c2
            simp only [c2, ↓reduceIte] at h
            by_cases c3 : allocationSignsValid request.kind request.allocations = true
            · simp only [c3, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
              by_cases c4 : combinedRejected request.kind request.allocations = true
              · simp only [c4, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
                exact Or.inr (Or.inr (Or.inr (Or.inl ⟨c1', c2', c3, c4, h.symm⟩)))
              · have c4' := Bool.eq_false_iff.mpr c4
                simp only [c4, ↓reduceIte] at h
                by_cases c5 : request.allocations.any (targetRejected holdings) = true
                · simp only [c5, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
                  exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl ⟨c1', c2', c3, c4', c5, h.symm⟩))))
                · have c5' := Bool.eq_false_iff.mpr c5
                  simp only [c5, ↓reduceIte] at h
                  by_cases c6 : amountDirectionRejected request.kind request.exactSourceAmount = true
                  · simp only [c6, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
                    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
                      ⟨c1', c2', c3, c4', c5', c6, h.symm⟩)))))
                  · have c6' := Bool.eq_false_iff.mpr c6
                    simp only [c6, ↓reduceIte] at h
                    by_cases c7 : allowanceDirectionValid request.kind request.allocations = true
                    · simp only [c7, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
                      cases h8 : applyInventoryValueAdjustmentToHoldings holdings
                          request.allocations with
                      | error e => simp [h8] at h
                      | ok resulting =>
                        simp only [h8] at h
                        by_cases c8 : resultingRejected resulting = true
                        · simp only [c8, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
                          exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
                            ⟨c1', c2', c3, c4', c5', c6', c7, ⟨resulting, rfl, c8⟩, h.symm⟩))))))
                        · simp [c8] at h
                    · have c7' : allowanceDirectionValid request.kind request.allocations = false :=
                        Bool.eq_false_iff.mpr c7
                      simp only [c7', Bool.not_false, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
                        Option.some.injEq] at h
                      exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
                        ⟨c1', c2', c3, c4', c5', c6', c7', h.symm⟩))))))
            · have c3' : allocationSignsValid request.kind request.allocations = false :=
                Bool.eq_false_iff.mpr c3
              simp only [c3', Bool.not_false, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
                Option.some.injEq] at h
              exact Or.inr (Or.inr (Or.inl ⟨c1', c2', c3', h.symm⟩))
  · rintro ⟨allocated, hp, h1, h2, h⟩
    unfold identityTest at h
    unfold adjustmentRejection
    simp only [h1, h2]
    rcases h with ⟨c1, rfl⟩ | ⟨c1, c2, rfl⟩ | ⟨c1, c2, c3, rfl⟩ | ⟨c1, c2, c3, c4, rfl⟩ |
      ⟨c1, c2, c3, c4, c5, rfl⟩ | ⟨c1, c2, c3, c4, c5, c6, rfl⟩ | ⟨c1, c2, c3, c4, c5, c6, c7, rfl⟩ |
      ⟨c1, c2, c3, c4, c5, c6, c7, ⟨resulting, c8, c9⟩, rfl⟩
    · simp [c1]
    · simp [c1, c2]
    · simp [c1, c2, c3]
    · simp [c1, c2, c3, c4]
    · simp [c1, c2, c3, c4, c5]
    · simp [c1, c2, c3, c4, c5, c6]
    · simp [c1, c2, c3, c4, c5, c6, c7]
    · simp [c1, c2, c3, c4, c5, c6, c7, c8, c9]

/-- The draft step makes a draft or throws; it never rejects. -/
theorem adjustmentDraft_ne_rejected {bookId : BookId} {functionalCommodityId : CommodityId}
    {policy : InventoryValueAdjustmentPolicy} {request : InventoryValueAdjustmentRequest}
    {ds : List SemanticDiagnostic} :
    adjustmentDraft bookId functionalCommodityId policy request ≠ .ok (.rejected ds) := by
  intro h
  unfold adjustmentDraft at h
  cases h1 : liftNum (sumMapped (fun allocation => allocation.remainingBasisChange.add
      allocation.remainingValuationAllowanceChange) request.allocations) with
  | error e => simp [h1] at h
  | ok ic =>
    simp only [h1] at h
    cases h2 : liftNum (accountingSum (request.allocations.map (·.recognizedCostChange))) with
    | error e => simp [h2] at h
    | ok rc =>
      simp only [h2] at h
      cases h3 : liftId (adjustmentPostings request policy functionalCommodityId ic rc) with
      | error e => simp [h3] at h
      | ok postings =>
        simp only [h3] at h
        cases h4 : quantize request.exactSourceAmount policy.quantizationPolicy.rule with
        | error e => simp [h4] at h
        | ok booked =>
          simp only [h4] at h
          cases h5 : liftId (journalId (request.id.value ++ "-journal")) with
          | error e => simp [h5] at h
          | ok jid => simp [h5, drafted, immutableAccountingValue] at h

/-- An adjustment is rejected exactly when its policy is not selected, or it is and a test rejects. -/
theorem calculateInventoryValueAdjustment_rejected_iff {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest}
    {ds : List SemanticDiagnostic} :
    calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings request =
        .ok (.rejected ds) ↔
      (policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
          request.policyEffectiveAt = .rejected ds) ∨
      (∃ (policy : InventoryValueAdjustmentPolicy) (rej : SemanticDiagnostic),
        policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
          request.policyEffectiveAt = .selected policy ∧
        adjustmentRejection policies bookId functionalCommodityId lots holdings request policy =
          .ok (some rej) ∧ ds = [rej]) := by
  constructor
  · intro h
    unfold calculateInventoryValueAdjustment at h
    cases hp : policyAt InventoryValueAdjustmentPolicy policies request.policyId
        request.policyVersion request.policyEffectiveAt with
    | rejected ds' =>
      simp only [hp, Except.ok.injEq, AccountingCalculation.rejected.injEq] at h
      subst h
      exact Or.inl rfl
    | selected policy =>
      simp only [hp] at h
      cases hr : liftNum (adjustmentRejection policies bookId functionalCommodityId lots holdings
          request policy) with
      | error e => simp [hr] at h
      | ok o =>
        cases o with
        | some rej =>
          simp only [hr, Except.ok.injEq, AccountingCalculation.rejected.injEq] at h
          subst h
          exact Or.inr ⟨policy, rej, rfl, liftNum_eq_ok.mp hr, rfl⟩
        | none =>
          simp only [hr] at h
          exact absurd h adjustmentDraft_ne_rejected
  · rintro (h | ⟨policy, rej, hp, hr, rfl⟩)
    · simp [calculateInventoryValueAdjustment, h]
    · simp [calculateInventoryValueAdjustment, hp, hr, liftNum]

/-- The test for components that may not be combined never rejects once the signs have passed: the
signs test already demands that the components it forbids are zero. -/
theorem combinedRejected_of_signs {kind : InventoryValueAdjustmentKind}
    {allocations : List InventoryValueAdjustmentAllocation}
    (h : allocationSignsValid kind allocations = true) : combinedRejected kind allocations = false := by
  unfold allocationSignsValid at h
  unfold combinedRejected
  rw [List.all_eq_true] at h
  by_cases hk : capitalizable kind = true
  · simp only [hk, ↓reduceIte, List.any_eq_false]
    intro a ha
    have := h a ha
    simp only [hk, ↓reduceIte] at this
    by_cases hr : (kind == .purchaseRebate) = true
    · simp only [hr, ↓reduceIte, Bool.and_eq_true] at this
      simp [this.2]
    · have hr' : (kind == .purchaseRebate) = false := Bool.eq_false_iff.mpr hr
      simp only [hr', Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at this
      simp [this.2]
  · have hk' : capitalizable kind = false := Bool.eq_false_iff.mpr hk
    simp only [hk', Bool.false_eq_true, ↓reduceIte, List.any_eq_false]
    intro a ha
    have := h a ha
    simp only [hk', Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at this
    simp [this.1, this.2]

set_option maxRecDepth 100000 in
/-- Every other diagnostic of the adjustment differs from the one about mixed components. -/
theorem adjustmentDiagnostics_ne_combined :
    policyAtDiagnostic .inventoryValueAdjustment ≠ combinedDiagnostic ∧
    identityDiagnostic ≠ combinedDiagnostic ∧ sourceSignDiagnostic ≠ combinedDiagnostic ∧
    signsDiagnostic ≠ combinedDiagnostic ∧ targetDiagnostic ≠ combinedDiagnostic ∧
    amountDirectionDiagnostic ≠ combinedDiagnostic ∧
    allowanceDirectionDiagnostic ≠ combinedDiagnostic ∧ resultingDiagnostic ≠ combinedDiagnostic := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide

/-- The diagnostic about mixed components is never produced: an adjustment is never rejected for it. -/
theorem calculateInventoryValueAdjustment_never_combined {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} :
    calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings request ≠
      .ok (.rejected [combinedDiagnostic]) := by
  intro h
  obtain ⟨n0, n1, n2, n3, n5, n6, n7, n8⟩ := adjustmentDiagnostics_ne_combined
  rw [calculateInventoryValueAdjustment_rejected_iff] at h
  rcases h with h | ⟨policy, rej, hp, hr, hds⟩
  · exact n0 (List.singleton_inj.mp ((policyAt_rejected_eq h).symm))
  · have hrej : rej = combinedDiagnostic := (List.singleton_inj.mp hds).symm
    subst hrej
    obtain ⟨allocated, hpop, h1, h2, h3⟩ := adjustmentRejection_some_iff.mp hr
    rcases h3 with ⟨-, h⟩ | ⟨-, -, h⟩ | ⟨-, -, -, h⟩ | ⟨-, -, hs, hc, -⟩ | ⟨-, -, -, -, -, h⟩ |
      ⟨-, -, -, -, -, -, h⟩ | ⟨-, -, -, -, -, -, -, h⟩ | ⟨-, -, -, -, -, -, -, -, h⟩
    · exact n1 h.symm
    · exact n2 h.symm
    · exact n3 h.symm
    · rw [combinedRejected_of_signs hs] at hc
      cases hc
    · exact n5 h.symm
    · exact n6 h.symm
    · exact n7 h.symm
    · exact n8 h.symm

/-! ## What the exact operations of `calculateInventoryValueAdjustment` can throw -/

/-- A mapped value that returned is constructible when the function's values are. -/
theorem mapAll_wf {α : Type} {f : α → Except NumErr ExactRational} :
    ∀ {xs : List α} {ys : List ExactRational},
      (∀ x ∈ xs, ∀ y, f x = .ok y → y.WF) → mapAll f xs = .ok ys → ∀ y ∈ ys, y.WF
  | [], ys, _, h => by
    simp only [mapAll, Except.ok.injEq] at h
    subst h
    exact fun y hy => absurd hy (by simp)
  | x :: rest, ys, hf, h => by
    simp only [mapAll] at h
    cases h1 : f x with
    | error e => simp [h1] at h
    | ok y =>
      simp only [h1] at h
      cases h2 : mapAll f rest with
      | error e => simp [h2] at h
      | ok later =>
        simp only [h2, Except.ok.injEq] at h
        subst h
        intro z hz
        rcases List.mem_cons.mp hz with h' | hz
        · rw [h']
          exact hf x List.mem_cons_self y h1
        · exact mapAll_wf (fun x' hx' => hf x' (List.mem_cons_of_mem _ hx')) h2 z hz

/-- Mapping with a function that throws only for size throws only for size. -/
theorem mapAll_error {α : Type} {f : α → Except NumErr ExactRational} {e : NumErr} :
    ∀ {xs : List α}, (∀ x ∈ xs, ∀ e', f x = .error e' → e' = .representationLimitExceeded) →
      mapAll f xs = .error e → e = .representationLimitExceeded
  | [], _, h => by simp [mapAll] at h
  | x :: rest, hf, h => by
    simp only [mapAll] at h
    cases h1 : f x with
    | error e' =>
      simp only [h1, Except.error.injEq] at h
      subst h
      exact hf x List.mem_cons_self _ h1
    | ok y =>
      simp only [h1] at h
      cases h2 : mapAll f rest with
      | error e' =>
        simp only [h2, Except.error.injEq] at h
        subst h
        exact mapAll_error (fun x' hx' => hf x' (List.mem_cons_of_mem _ hx')) h2
      | ok later => simp [h2] at h

/-- A sum of a mapped list throws only for size when the function does and its values are
constructible. -/
theorem sumMapped_error {α : Type} {f : α → Except NumErr ExactRational} {e : NumErr}
    {xs : List α} (hf : ∀ x ∈ xs, ∀ e', f x = .error e' → e' = .representationLimitExceeded)
    (hw : ∀ x ∈ xs, ∀ y, f x = .ok y → y.WF) (h : sumMapped f xs = .error e) :
    e = .representationLimitExceeded := by
  unfold sumMapped at h
  cases h1 : mapAll f xs with
  | error e' =>
    simp only [h1, Except.error.injEq] at h
    subst h
    exact mapAll_error hf h1
  | ok ys =>
    simp only [h1] at h
    exact accountingSum_error (mapAll_wf hw h1) h

/-- One allocation's three changes added throw only for size. -/
theorem allocationTotal_error {allocation : InventoryValueAdjustmentAllocation} {e : NumErr}
    (ha : allocation.WF) (h : allocationTotal allocation = .error e) :
    e = .representationLimitExceeded := by
  unfold allocationTotal at h
  cases h1 : allocation.remainingBasisChange.add allocation.recognizedCostChange with
  | error e' =>
    simp only [h1, Except.error.injEq] at h
    subst h
    exact add_error ha.remainingBasisChange ha.recognizedCostChange h1
  | ok sofar =>
    simp only [h1] at h
    obtain ⟨hw1, -⟩ := ExactRational.add_ok ha.remainingBasisChange ha.recognizedCostChange h1
    exact add_error hw1 ha.remainingValuationAllowanceChange h

/-- The sum of the allocations throws only for size. -/
theorem exactAllocated_error {allocations : List InventoryValueAdjustmentAllocation} {e : NumErr}
    (ha : ∀ a ∈ allocations, a.WF) (h : exactAllocated allocations = .error e) :
    e = .representationLimitExceeded :=
  sumMapped_error (fun x hx _ he' => allocationTotal_error (ha x hx) he')
    (fun x hx _ hy => (allocationTotal_ok (ha x hx) hy).1) h

/-- Testing one holding of the population throws only for size. -/
theorem holdingValid_error {policy : InventoryValueAdjustmentPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holding : LotHolding} {e : NumErr}
    (hh : holding.WF)
    (h : holdingValid policy bookId functionalCommodityId lots holding = .error e) :
    e = .representationLimitExceeded := by
  unfold holdingValid at h
  cases hl : Lots.lotById lots holding.lotId with
  | none => simp [hl] at h
  | some lot =>
    simp only [hl] at h
    by_cases hc : (holding.bookId == bookId &&
        (policy.algorithmVersion.value != "1.0.0" || holding.accountId == policy.inventoryAccountId) &&
        holding.commodityId == lot.commodityId && holding.basisCommodityId == functionalCommodityId &&
        !holding.remainingQuantity.isNegative && !holding.remainingTotalBasis.isNegative &&
        holding.remainingValuationAllowance.compare ExactRational.zero != .gt) = true
    · simp only [hc, ↓reduceIte] at h
      cases hs : holding.remainingTotalBasis.add holding.remainingValuationAllowance with
      | error e' =>
        simp only [hs, Except.error.injEq] at h
        subst h
        exact add_error hh.remainingTotalBasis hh.remainingValuationAllowance hs
      | ok carrying => simp [hs] at h
    · simp [hc] at h

/-- Testing the holdings one by one throws only for size. -/
theorem holdingsAllValid_error {policy : InventoryValueAdjustmentPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {e : NumErr} :
    ∀ {holdings : List LotHolding}, (∀ x ∈ holdings, x.WF) →
      holdingsAllValid policy bookId functionalCommodityId lots holdings = .error e →
      e = .representationLimitExceeded
  | [], _, h => by simp [holdingsAllValid] at h
  | holding :: rest, hh, h => by
    simp only [holdingsAllValid] at h
    cases hv : holdingValid policy bookId functionalCommodityId lots holding with
    | error e' =>
      simp only [hv, Except.error.injEq] at h
      subst h
      exact holdingValid_error (hh holding List.mem_cons_self) hv
    | ok b =>
      cases b with
      | false => simp [hv] at h
      | true =>
        simp only [hv] at h
        exact holdingsAllValid_error (fun x hx => hh x (List.mem_cons_of_mem _ hx)) h

/-- The test of the population of holdings throws only for size. -/
theorem holdingPopulationValid_error {policy : InventoryValueAdjustmentPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holdings : List LotHolding}
    {e : NumErr} (hh : ∀ x ∈ holdings, x.WF)
    (h : holdingPopulationValid policy bookId functionalCommodityId lots holdings = .error e) :
    e = .representationLimitExceeded := by
  unfold holdingPopulationValid at h
  by_cases hs : (Lots.setSize (holdings.map (·.id)) == holdings.length) = true
  · simp only [hs, ↓reduceIte] at h
    exact holdingsAllValid_error hh h
  · simp [hs] at h

/-- Changing one holding throws only for size. -/
theorem adjustHolding_error {byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation)}
    {holding : LotHolding} {e : NumErr} (hh : holding.WF)
    (hb : ∀ id a, (id, a) ∈ byHolding → a.WF) (h : adjustHolding byHolding holding = .error e) :
    e = .representationLimitExceeded := by
  unfold adjustHolding at h
  cases hg : Lots.mapGet byHolding holding.id with
  | none => simp [hg] at h
  | some allocation =>
    simp only [hg] at h
    have haw := hb _ _ (Lots.mem_of_mapGet hg)
    cases h1 : holding.remainingTotalBasis.add allocation.remainingBasisChange with
    | error e' =>
      simp only [h1, Except.error.injEq] at h
      subst h
      exact add_error hh.remainingTotalBasis haw.remainingBasisChange h1
    | ok tb =>
      simp only [h1] at h
      obtain ⟨hw1, -⟩ := ExactRational.add_ok hh.remainingTotalBasis haw.remainingBasisChange h1
      cases h2 : holding.remainingValuationAllowance.add
          allocation.remainingValuationAllowanceChange with
      | error e' =>
        simp only [h2, Except.error.injEq] at h
        subst h
        exact add_error hh.remainingValuationAllowance haw.remainingValuationAllowanceChange h2
      | ok al =>
        simp only [h2] at h
        obtain ⟨hw2, -⟩ := ExactRational.add_ok hh.remainingValuationAllowance
          haw.remainingValuationAllowanceChange h2
        cases h3 : tb.add al with
        | error e' =>
          simp only [h3, Except.error.injEq] at h
          subst h
          exact add_error hw1 hw2 h3
        | ok carrying => simp [h3] at h

/-- Changing the holdings throws only for size. -/
theorem adjustHoldings_error {byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation)}
    {e : NumErr} (hb : ∀ id a, (id, a) ∈ byHolding → a.WF) :
    ∀ {holdings : List LotHolding}, (∀ x ∈ holdings, x.WF) →
      adjustHoldings byHolding holdings = .error e → e = .representationLimitExceeded
  | [], _, h => by simp [adjustHoldings] at h
  | holding :: rest, hh, h => by
    simp only [adjustHoldings] at h
    cases h1 : adjustHolding byHolding holding with
    | error e' =>
      simp only [h1, Except.error.injEq] at h
      subst h
      exact adjustHolding_error (hh holding List.mem_cons_self) hb h1
    | ok adjusted =>
      simp only [h1] at h
      cases h2 : adjustHoldings byHolding rest with
      | error e' =>
        simp only [h2, Except.error.injEq] at h
        subst h
        exact adjustHoldings_error hb (fun x hx => hh x (List.mem_cons_of_mem _ hx)) h2
      | ok later => simp [h2] at h

/-- `applyInventoryValueAdjustmentToHoldings` throws only for size, for constructible holdings and
allocations. -/
theorem applyInventoryValueAdjustmentToHoldings_error {holdings : List LotHolding}
    {allocations : List InventoryValueAdjustmentAllocation} {e : NumErr}
    (hh : ∀ x ∈ holdings, x.WF) (ha : ∀ a ∈ allocations, a.WF)
    (h : applyInventoryValueAdjustmentToHoldings holdings allocations = .error e) :
    e = .representationLimitExceeded :=
  adjustHoldings_error (allocationsByHolding_wf ha) hh h

/-- Forming an identifier fails only as an identity conflict. -/
theorem identifier_error_eq {Kind value : String} {e : CanonicalErr}
    (h : identifier Kind value = .error e) : e = .canonicalIdentityConflict := by
  unfold identifier at h
  split at h
  · cases h; rfl
  · split at h
    · cases h; rfl
    · split at h
      · cases h; rfl
      · cases h

/-- The tests of the adjustment throw only for size, for constructible allocations and holdings. -/
theorem adjustmentRejection_error {policies : List AccountingPolicy} {bookId : BookId}
    {functionalCommodityId : CommodityId} {lots : List Lot} {holdings : List LotHolding}
    {request : InventoryValueAdjustmentRequest} {policy : InventoryValueAdjustmentPolicy}
    {e : NumErr} (hh : ∀ x ∈ holdings, x.WF) (hr : request.WF)
    (h : adjustmentRejection policies bookId functionalCommodityId lots holdings request policy =
      .error e) : e = .representationLimitExceeded := by
  unfold adjustmentRejection at h
  cases h1 : exactAllocated request.allocations with
  | error e' =>
    simp only [h1, Except.error.injEq] at h
    subst h
    exact exactAllocated_error hr.allocations h1
  | ok allocated =>
    simp only [h1] at h
    cases h2 : holdingPopulationValid policy bookId functionalCommodityId lots holdings with
    | error e' =>
      simp only [h2, Except.error.injEq] at h
      subst h
      exact holdingPopulationValid_error hh h2
    | ok hp =>
      simp only [h2] at h
      by_cases c1 : identityRejected policy
          (linkedInventoryPolicies policies policy request.policyEffectiveAt) bookId
          functionalCommodityId lots holdings request
          (lotPopulationValid bookId functionalCommodityId lots) hp allocated = true
      · simp [c1] at h
      · simp only [c1, ↓reduceIte] at h
        by_cases c2 : sourceSignRejected request.kind request.exactSourceAmount = true
        · simp [c2] at h
        · simp only [c2, ↓reduceIte] at h
          by_cases c3 : allocationSignsValid request.kind request.allocations = true
          · simp only [c3, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
            by_cases c4 : combinedRejected request.kind request.allocations = true
            · simp [c4] at h
            · simp only [c4, ↓reduceIte] at h
              by_cases c5 : request.allocations.any (targetRejected holdings) = true
              · simp [c5] at h
              · simp only [c5, ↓reduceIte] at h
                by_cases c6 : amountDirectionRejected request.kind request.exactSourceAmount = true
                · simp [c6] at h
                · simp only [c6, ↓reduceIte] at h
                  by_cases c7 : allowanceDirectionValid request.kind request.allocations = true
                  · simp only [c7, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
                    cases h8 : applyInventoryValueAdjustmentToHoldings holdings request.allocations
                    with
                    | error e' =>
                      simp only [h8, Except.error.injEq] at h
                      subst h
                      exact applyInventoryValueAdjustmentToHoldings_error hh hr.allocations h8
                    | ok resulting =>
                      simp only [h8] at h
                      by_cases c8 : resultingRejected resulting = true
                      · simp [c8] at h
                      · simp [c8] at h
                  · simp [c7] at h
          · simp [c3] at h

/-- The postings of the adjustment's journal are refused only as an identity conflict. -/
theorem adjustmentPostings_error {request : InventoryValueAdjustmentRequest}
    {policy : InventoryValueAdjustmentPolicy} {functionalCommodityId : CommodityId}
    {inventoryChange recognizedCostChange : ExactRational} {e : CanonicalErr}
    (h : adjustmentPostings request policy functionalCommodityId inventoryChange
      recognizedCostChange = .error e) : e = .canonicalIdentityConflict := by
  unfold adjustmentPostings at h
  by_cases hi : inventoryChange.isZero = true
  · simp only [hi, ↓reduceIte] at h
    by_cases hc : recognizedCostChange.isZero = true
    · simp only [hc, ↓reduceIte] at h
      cases ha : postingId (request.id.value ++ "-adjustment") with
      | error e' =>
        simp only [ha, Except.error.injEq] at h
        subst h
        exact identifier_error_eq ha
      | ok aid => simp [ha] at h
    · have hc' : recognizedCostChange.isZero = false := Bool.eq_false_iff.mpr hc
      simp only [hc', Bool.false_eq_true, ↓reduceIte] at h
      cases hid : postingId (request.id.value ++ "-recognized-cost") with
      | error e' =>
        simp only [hid, Except.error.injEq] at h
        subst h
        exact identifier_error_eq hid
      | ok cid =>
        simp only [hid] at h
        cases ha : postingId (request.id.value ++ "-adjustment") with
        | error e' =>
          simp only [ha, Except.error.injEq] at h
          subst h
          exact identifier_error_eq ha
        | ok aid => simp [ha] at h
  · have hi' : inventoryChange.isZero = false := Bool.eq_false_iff.mpr hi
    simp only [hi', Bool.false_eq_true, ↓reduceIte] at h
    cases hid : postingId (request.id.value ++ "-inventory") with
    | error e' =>
      simp only [hid, Except.error.injEq] at h
      subst h
      exact identifier_error_eq hid
    | ok iid =>
      simp only [hid] at h
      by_cases hc : recognizedCostChange.isZero = true
      · simp only [hc, ↓reduceIte] at h
        cases ha : postingId (request.id.value ++ "-adjustment") with
        | error e' =>
          simp only [ha, Except.error.injEq] at h
          subst h
          exact identifier_error_eq ha
        | ok aid => simp [ha] at h
      · have hc' : recognizedCostChange.isZero = false := Bool.eq_false_iff.mpr hc
        simp only [hc', Bool.false_eq_true, ↓reduceIte] at h
        cases hcid : postingId (request.id.value ++ "-recognized-cost") with
        | error e' =>
          simp only [hcid, Except.error.injEq] at h
          subst h
          exact identifier_error_eq hcid
        | ok cid =>
          simp only [hcid] at h
          cases ha : postingId (request.id.value ++ "-adjustment") with
          | error e' =>
            simp only [ha, Except.error.injEq] at h
            subst h
            exact identifier_error_eq ha
          | ok aid => simp [ha] at h

/-- Rounding a constructible value throws the `RangeError` for a scale out of range, or the size error. -/
theorem quantize_error_cases {value : ExactRational} {rule : QuantizationRule} {e : QuantizeErr}
    (hv : value.WF) (h : quantize value rule = .error e) :
    e = .scaleOutOfRange ∨ e = .exactNumber .representationLimitExceeded := by
  by_cases h0 : 0 ≤ rule.targetScale ∧ rule.targetScale ≤ maxDecimalScale
  · exact Or.inr (quantize_error hv h0.1 h0.2 h)
  · left
    have hs : rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale := by omega
    unfold quantize at h
    simp only [hs, ↓reduceIte, Except.error.injEq] at h
    exact h.symm

/-- An exact-number error lifted into the errors of the adjustment came from the exact-number error. -/
theorem liftNum_eq_error {α : Type} {x : Except NumErr α} {e : InventoryAdjustmentErr}
    (h : liftNum x = .error e) : ∃ n, x = .error n ∧ e = .quantize (.exactNumber n) := by
  cases x with
  | error n => simp only [liftNum, Except.error.injEq] at h; exact ⟨n, rfl, h.symm⟩
  | ok v => simp [liftNum] at h

/-- An identity error lifted into the errors of the adjustment came from the identity error. -/
theorem liftId_eq_error {α : Type} {x : Except CanonicalErr α} {e : InventoryAdjustmentErr}
    (h : liftId x = .error e) : ∃ n, x = .error n ∧ e = .identity n := by
  cases x with
  | error n => simp only [liftId, Except.error.injEq] at h; exact ⟨n, rfl, h.symm⟩
  | ok v => simp [liftId] at h

/-- The draft of an adjustment throws only for size, the scale of the rounding, or an identity
conflict in an identifier made from the request's. -/
theorem adjustmentDraft_error {bookId : BookId} {functionalCommodityId : CommodityId}
    {policy : InventoryValueAdjustmentPolicy} {request : InventoryValueAdjustmentRequest}
    {e : InventoryAdjustmentErr} (hr : request.WF)
    (h : adjustmentDraft bookId functionalCommodityId policy request = .error e) :
    e = .quantize (.exactNumber .representationLimitExceeded) ∨ e = .quantize .scaleOutOfRange ∨
      e = .identity .canonicalIdentityConflict := by
  unfold adjustmentDraft at h
  cases h1 : liftNum (sumMapped (fun allocation => allocation.remainingBasisChange.add
      allocation.remainingValuationAllowanceChange) request.allocations) with
  | error e' =>
    simp only [h1, Except.error.injEq] at h
    subst h
    obtain ⟨n, hn, rfl⟩ := liftNum_eq_error h1
    refine Or.inl (congrArg _ (congrArg _ (sumMapped_error (fun a ha e'' he'' => ?_)
      (fun a ha y hy => ?_) hn)))
    · exact add_error (hr.allocations a ha).remainingBasisChange
        (hr.allocations a ha).remainingValuationAllowanceChange he''
    · exact (ExactRational.add_ok (hr.allocations a ha).remainingBasisChange
        (hr.allocations a ha).remainingValuationAllowanceChange hy).1
  | ok ic =>
    simp only [h1] at h
    obtain ⟨hicw, -⟩ := sumMapped_ok (g := fun a => a.remainingBasisChange.toRat +
        a.remainingValuationAllowanceChange.toRat) (fun a ha y hy => by
      obtain ⟨hw1, hr1⟩ := ExactRational.add_ok (hr.allocations a ha).remainingBasisChange
        (hr.allocations a ha).remainingValuationAllowanceChange hy
      exact ⟨hw1, hr1⟩) (liftNum_eq_ok.mp h1)
    cases h2 : liftNum (accountingSum (request.allocations.map (·.recognizedCostChange))) with
    | error e' =>
      simp only [h2, Except.error.injEq] at h
      subst h
      obtain ⟨n, hn, rfl⟩ := liftNum_eq_error h2
      exact Or.inl (congrArg _ (congrArg _ (accountingSum_error (fun v hv => by
        obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hv
        exact (hr.allocations a ha).recognizedCostChange) hn)))
    | ok rc =>
      simp only [h2] at h
      cases h3 : liftId (adjustmentPostings request policy functionalCommodityId ic rc) with
      | error e' =>
        simp only [h3, Except.error.injEq] at h
        subst h
        obtain ⟨n, hn, rfl⟩ := liftId_eq_error h3
        exact Or.inr (Or.inr (congrArg _ (adjustmentPostings_error hn)))
      | ok postings =>
        simp only [h3] at h
        cases h4 : quantize request.exactSourceAmount policy.quantizationPolicy.rule with
        | error e' =>
          simp only [h4, Except.error.injEq] at h
          subst h
          rcases quantize_error_cases hr.exactSourceAmount h4 with h5 | h5
          · exact Or.inr (Or.inl (congrArg _ h5))
          · exact Or.inl (congrArg _ h5)
        | ok booked =>
          simp only [h4] at h
          cases h5 : liftId (journalId (request.id.value ++ "-journal")) with
          | error e' =>
            simp only [h5, Except.error.injEq] at h
            subst h
            obtain ⟨n, hn, rfl⟩ := liftId_eq_error h5
            exact Or.inr (Or.inr (congrArg _ (identifier_error_eq hn)))
          | ok jid => simp [h5, drafted, immutableAccountingValue] at h

/-- `calculateInventoryValueAdjustment` throws only for the size limit, the scale of the rounding of
the booked amount (a `RangeError`, where the TypeScript does not reject), or an identity conflict in an
identifier made from the request's identifier. -/
theorem calculateInventoryValueAdjustment_error {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest}
    {e : InventoryAdjustmentErr} (hh : ∀ x ∈ holdings, x.WF) (hr : request.WF)
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .error e) :
    e = .quantize (.exactNumber .representationLimitExceeded) ∨ e = .quantize .scaleOutOfRange ∨
      e = .identity .canonicalIdentityConflict := by
  unfold calculateInventoryValueAdjustment at h
  cases hp : policyAt InventoryValueAdjustmentPolicy policies request.policyId
      request.policyVersion request.policyEffectiveAt with
  | rejected ds => simp [hp] at h
  | selected policy =>
    simp only [hp] at h
    cases hr' : liftNum (adjustmentRejection policies bookId functionalCommodityId lots holdings
        request policy) with
    | error e' =>
      simp only [hr', Except.error.injEq] at h
      subst h
      obtain ⟨n, hn, rfl⟩ := liftNum_eq_error hr'
      exact Or.inl (congrArg _ (congrArg _ (adjustmentRejection_error hh hr hn)))
    | ok o =>
      cases o with
      | some rej => simp [hr'] at h
      | none =>
        simp only [hr'] at h
        exact adjustmentDraft_error hr h


/-! ## What a drafted adjustment rests on -/

/-- What the test of identity and conservation says when it does not reject, clause by clause (the
sum of the allocations is `allocated`; the clauses about the one linked policy are in
`identityRejected_false_linked`). -/
theorem identityRejected_false_facts {policy : InventoryValueAdjustmentPolicy}
    {linked : List InventoryCostPolicy} {bookId : BookId} {functionalCommodityId : CommodityId}
    {lots : List Lot} {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest}
    {lotPopulation holdingPopulation : Bool} {allocated : ExactRational}
    (h : identityRejected policy linked bookId functionalCommodityId lots holdings request
      lotPopulation holdingPopulation allocated = false) :
    policy.bookId = bookId ∧ policy.quantizationPolicy.functionalCommodityId = functionalCommodityId ∧
      linked.length = 1 ∧ lotPopulation = true ∧ holdingPopulation = true ∧
      policy.allowedKinds.contains request.kind = true ∧ request.allocations.length ≠ 0 ∧
      request.allocations.length ≤ accountingLimits.maxInventoryLayers ∧
      request.evidence.length ≠ 0 ∧
      (request.evidence.all fun item =>
        request.derivation.evidence.any fun evidence => evidence.id == item.id) = true ∧
      validAccountingDerivation request.derivation = true ∧
      request.derivation.policyId = policy.id ∧ request.derivation.policyVersion = policy.version ∧
      request.exactSourceAmount.isZero = false ∧ (jsTrim request.generatedEffectKey.value).length ≠ 0 ∧
      allocated.equals request.exactSourceAmount = true ∧
      Lots.setSize (request.allocations.map (·.ordinal)) = request.allocations.length ∧
      Lots.setSize (request.allocations.map (allocationKey policy.algorithmVersion)) =
        request.allocations.length ∧
      anyMisplaced policy lots holdings 0 request.allocations = false ∧
      policy.inventoryAccountId ≠ policy.recognizedCostAccountId ∧
      policy.inventoryAccountId ≠ policy.adjustmentAccountId ∧
      policy.recognizedCostAccountId ≠ policy.adjustmentAccountId := by
  unfold identityRejected at h
  simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, beq_eq_false_iff_ne, Bool.not_false,
    decide_eq_false_iff_not, not_lt, and_assoc] at h
  obtain ⟨h1, h2, h3, -, h5, h6, h7, h8, h9, h10, h11, h12, h13, h14, h15, h16, h17, h18, h19,
    h20, h21, h22, h23⟩ := h
  exact ⟨h1, h2, h3, by simpa using h5, by simpa using h6, by simpa using h7, h8, h9, h10,
    by simpa using h11, by simpa using h12, h13, h14, h15, h16, by simpa using h17, h18, h19, h20,
    h21, h22, h23⟩

/-- When the test does not reject and one policy is linked, that policy is of the book and of the
functional commodity, rounds as the adjustment's policy does (their rounding policies hash alike), and
has a pool at the inventory account. -/
theorem identityRejected_false_linked {policy : InventoryValueAdjustmentPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest}
    {lotPopulation holdingPopulation : Bool} {allocated : ExactRational}
    {linkedPolicy : InventoryCostPolicy}
    (h : identityRejected policy [linkedPolicy] bookId functionalCommodityId lots holdings request
      lotPopulation holdingPopulation allocated = false) :
    linkedPolicy.bookId = bookId ∧
      linkedPolicy.quantizationPolicy.functionalCommodityId = functionalCommodityId ∧
      contentHashEquals (hashQuantizationPolicy policy.quantizationPolicy)
        (hashQuantizationPolicy linkedPolicy.quantizationPolicy) = true ∧
      (linkedPolicy.pools.any fun pool => pool.accountId == policy.inventoryAccountId) = true := by
  unfold identityRejected at h
  simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, beq_eq_false_iff_ne, Bool.not_false,
    decide_eq_false_iff_not, not_lt, and_assoc] at h
  obtain ⟨-, -, -, h4a, h4b, h4c, h4d, -⟩ := h
  exact ⟨h4a, h4b, by simpa using h4c, by simpa using h4d⟩

/-- What an adjustment that is drafted rests on, in plain terms: the policy is of the book and of its
functional commodity; exactly one inventory cost policy is linked, of the book, rounding as this policy
does, with a pool at the inventory account; the kind is allowed; there are allocations, no more than the
limit; the evidence is not empty and every item is in the derivation; the derivation is approved with
evidence and a time, and is of this policy and its version; the effect key is not blank; the ordinals
and the allocation keys are all different; and the three accounts differ. -/
theorem calculateInventoryValueAdjustment_identity {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    ∃ policy : InventoryValueAdjustmentPolicy,
      policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .selected policy ∧
      policy.bookId = bookId ∧ policy.quantizationPolicy.functionalCommodityId = functionalCommodityId ∧
      (∃ linkedPolicy : InventoryCostPolicy,
        linkedInventoryPolicies policies policy request.policyEffectiveAt = [linkedPolicy] ∧
        linkedPolicy.bookId = bookId ∧
        linkedPolicy.quantizationPolicy.functionalCommodityId = functionalCommodityId ∧
        contentHashEquals (hashQuantizationPolicy policy.quantizationPolicy)
          (hashQuantizationPolicy linkedPolicy.quantizationPolicy) = true ∧
        ∃ pool ∈ linkedPolicy.pools, pool.accountId = policy.inventoryAccountId) ∧
      request.kind ∈ policy.allowedKinds ∧ request.allocations ≠ [] ∧
      request.allocations.length ≤ accountingLimits.maxInventoryLayers ∧ request.evidence ≠ [] ∧
      (∀ item ∈ request.evidence, ∃ evidence ∈ request.derivation.evidence, evidence.id = item.id) ∧
      validAccountingDerivation request.derivation = true ∧
      request.derivation.policyId = policy.id ∧ request.derivation.policyVersion = policy.version ∧
      jsTrim request.generatedEffectKey.value ≠ "" ∧
      (request.allocations.map (·.ordinal)).Nodup ∧
      (request.allocations.map (allocationKey policy.algorithmVersion)).Nodup ∧
      anyMisplaced policy lots holdings 0 request.allocations = false ∧
      policy.inventoryAccountId ≠ policy.recognizedCostAccountId ∧
      policy.inventoryAccountId ≠ policy.adjustmentAccountId ∧
      policy.recognizedCostAccountId ≠ policy.adjustmentAccountId := by
  obtain ⟨policy, hpol, hrej, -⟩ := calculateInventoryValueAdjustment_draft_inv h
  obtain ⟨allocated, hpop, resulting, hall, hhold, hid, -⟩ := adjustmentRejection_none_inv hrej
  obtain ⟨f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20,
    f21, f22⟩ := identityRejected_false_facts hid
  refine ⟨policy, hpol, f1, f2, ?_, ?_, ?_, f8, ?_, ?_, f11, f12, f13, ?_, ?_, ?_, f19, f20, f21,
    f22⟩
  · obtain ⟨lp, hlp⟩ : ∃ lp, linkedInventoryPolicies policies policy request.policyEffectiveAt = [lp] := by
      cases hl : linkedInventoryPolicies policies policy request.policyEffectiveAt with
      | nil => rw [hl] at f3; simp at f3
      | cons a rest =>
        cases rest with
        | nil => exact ⟨a, rfl⟩
        | cons b more => rw [hl] at f3; simp at f3
    rw [hlp] at hid
    obtain ⟨g1, g2, g3, g4⟩ := identityRejected_false_linked hid
    refine ⟨lp, hlp, g1, g2, g3, ?_⟩
    obtain ⟨pool, hpool, hacc⟩ := List.any_eq_true.mp g4
    exact ⟨pool, hpool, by simpa using hacc⟩
  · exact List.contains_iff_mem.mp f6
  · intro hnil
    exact f7 (by rw [hnil]; rfl)
  · intro hnil
    exact f9 (by rw [hnil]; rfl)
  · intro item hitem
    have := (List.all_eq_true.mp f10) item hitem
    obtain ⟨evidence, hev, hid'⟩ := List.any_eq_true.mp this
    exact ⟨evidence, hev, by simpa using hid'⟩
  · intro hempty
    apply f15
    rw [hempty]
    rfl
  · exact (Lots.setSize_eq_length_iff _).mp (by simpa using f17)
  · exact (Lots.setSize_eq_length_iff _).mp (by simpa using f18)

/-- The effect of a drafted adjustment records the request and the policy exactly, and its booked
adjustment is the exact amount rounded by the policy's rounding: the booked amount and its residual add
up to the exact amount. -/
theorem calculateInventoryValueAdjustment_effect {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (hr : request.WF)
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d)) :
    ∃ (policy : InventoryValueAdjustmentPolicy) (bookedAdjustment : QuantizedValue)
      (effect : InventoryValueAdjustment),
      policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .selected policy ∧
      d.effects = [.inventoryValueAdjustment effect] ∧
      effect.id = request.id ∧ effect.kind = request.kind ∧ effect.effectiveOn = request.effectiveOn ∧
      effect.generatedEffectKey = request.generatedEffectKey ∧ effect.bookId = bookId ∧
      effect.policy = policy ∧ effect.exactSourceAmount = request.exactSourceAmount ∧
      effect.allocations = request.allocations ∧ effect.evidence = request.evidence ∧
      effect.derivation = request.derivation ∧ effect.bookedAdjustment = bookedAdjustment ∧
      quantize request.exactSourceAmount policy.quantizationPolicy.rule = .ok bookedAdjustment ∧
      bookedAdjustment.amount.toRat + bookedAdjustment.residual.toRat =
        request.exactSourceAmount.toRat := by
  obtain ⟨policy, hpol, -, hdraft⟩ := calculateInventoryValueAdjustment_draft_inv h
  obtain ⟨ic, rc, postings, booked, jid, -, -, -, hq, -, hd⟩ := adjustmentDraft_inv hdraft
  refine ⟨policy, booked, adjustmentEffect bookId policy request booked, hpol, ?_, rfl, rfl, rfl,
    rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, hq, quantize_amount_add_residual hr.exactSourceAmount hq⟩
  rw [hd]


/-! ## What a write-down leaves alone -/

/-- A pair of the map of allocations by holding is an allocation of the request. -/
theorem allocationsByHolding_mem {allocations : List InventoryValueAdjustmentAllocation}
    {id : LotHoldingId} {a : InventoryValueAdjustmentAllocation}
    (h : (id, a) ∈ allocationsByHolding allocations) : a ∈ allocations := by
  unfold allocationsByHolding at h
  obtain ⟨b, hb, hbb⟩ := List.mem_filterMap.mp h
  cases hid : b.holdingId with
  | none => simp [hid] at hbb
  | some hid' =>
    simp only [hid, Option.map_some, Option.some.injEq, Prod.mk.injEq] at hbb
    obtain ⟨-, rfl⟩ := hbb
    exact hb

/-- Related lists whose left members all have a property: each pair has it on the left. -/
theorem forall₂_with_left {α β : Type} {R : α → β → Prop} {P : α → Prop} :
    ∀ {l : List α} {a : List β}, List.Forall₂ R l a → (∀ x ∈ l, P x) →
      List.Forall₂ (fun x y => P x ∧ R x y) l a
  | _, _, .nil, _ => .nil
  | _, _, .cons hxy hrest, hp =>
    .cons ⟨hp _ List.mem_cons_self, hxy⟩
      (forall₂_with_left hrest (fun x hx => hp x (List.mem_cons_of_mem _ hx)))

/-- A write-down or a reversal leaves every holding's quantity and total basis as it was, and changes
only its allowance, by the change of the allocation that names the holding. -/
theorem calculateInventoryValueAdjustment_writeDown_holdings {policies : List AccountingPolicy}
    {bookId : BookId} {functionalCommodityId : CommodityId} {lots : List Lot}
    {holdings : List LotHolding} {request : InventoryValueAdjustmentRequest} {d : AccountingDraft}
    (hh : ∀ x ∈ holdings, x.WF) (hr : request.WF)
    (h : calculateInventoryValueAdjustment policies bookId functionalCommodityId lots holdings
      request = .ok (.draft d))
    (hk : request.kind = .writeDown ∨ request.kind = .writeDownReversal) :
    ∃ resulting : List LotHolding,
      applyInventoryValueAdjustmentToHoldings holdings request.allocations = .ok resulting ∧
      List.Forall₂ (fun (before after : LotHolding) =>
        after.remainingQuantity = before.remainingQuantity ∧
        after.remainingTotalBasis = before.remainingTotalBasis ∧
        ∀ a, Lots.mapGet (allocationsByHolding request.allocations) before.id = some a →
          after.remainingValuationAllowance.toRat =
            before.remainingValuationAllowance.toRat + a.remainingValuationAllowanceChange.toRat)
        holdings resulting := by
  obtain ⟨resulting, happly, hfa, -, -⟩ := calculateInventoryValueAdjustment_holdings hh hr h
  obtain ⟨-, -, hwd, -⟩ := calculateInventoryValueAdjustment_conservation hr h
  obtain ⟨hzero, -, -, -⟩ := hwd hk
  refine ⟨resulting, happly, (forall₂_with_left hfa hh).imp ?_⟩
  rintro before after ⟨hbw, hba⟩
  refine ⟨?_, ?_, fun a ha => (hba.touched a ha).2.1⟩
  · cases hg : Lots.mapGet (allocationsByHolding request.allocations) before.id with
    | none => rw [hba.untouched hg]
    | some a => rw [hba.frame]
  · cases hg : Lots.mapGet (allocationsByHolding request.allocations) before.id with
    | none => rw [hba.untouched hg]
    | some a =>
      have hmem := allocationsByHolding_mem (Lots.mem_of_mapGet hg)
      have hb0 := (hzero a hmem).1
      have htb := (hba.touched a hg).1
      rw [hb0, add_zero] at htb
      exact ExactRational.eq_of_toRat_eq hba.wf.remainingTotalBasis hbw.remainingTotalBasis htb


end Inventory

end Rastrata.Kernel

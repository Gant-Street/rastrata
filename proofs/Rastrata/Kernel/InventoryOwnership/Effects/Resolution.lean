/-
The laws of `resolveInventoryOwnershipSources` (`inventory-ownership.ts` lines 934 to 1000).

What resolved sources guarantee (`resolveInventoryOwnershipSources_resolved`, `ResolvedSource`,
`ResolvedSource.facts`): one source for each requested holding, in UTF-16 order of the
identifiers, each read through the context for exactly that holding, its position equal to the
after-image at its origin, the position and the anchor valid, the anchor bound by the position and
of the holding's coordinate in the pinned book, the position not after the pinned revision, and the
holding's quantity the anchor's unconsumed rest with balances that reconcile. Rejections: the
read-set rejection exactly when the context is current and the set fails the test of lines 940 and
941 (`resolveInventoryOwnershipSources_readSet_iff`); every other rejection is one of the nine of
the loop (`resolveLoop_rejected_mem`).
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Validity

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

open InventoryOwnership InventoryOwnershipEffects

/-- What one resolved source satisfies, as the model's own tests: the holding, position and anchor
were read for this holding, the after-image at the position's origin was read and is the same
position, and each test of lines 960 to 995 passed. -/
structure ResolvedSource (reader : InventoryOwnershipReadContext) (id : LotHoldingId)
    (source : InventoryPostedReductionSource) : Prop where
  holdingRead : reader.readCurrentHolding id = .ok (some source.holding)
  positionRead : reader.readCurrentPosition id = .ok (some source.position)
  anchorRead : reader.readAnchor source.position.anchor = .ok (some source.anchor)
  afterImage : ∃ image, reader.readPositionAfterImage (positionOrigin reader.bookId source.position) =
    .ok (some image) ∧ sameOwnershipValue source.position image = true
  currentSource : resolveCurrentSourceInvalid reader.bookId reader.bookRevision id source.holding
    source.position = .ok false
  anchorSource : resolveAnchorSourceInvalid reader.bookId id source.holding source.position
    source.anchor = .ok false
  balance : resolveBalanceInvalid source.anchor source.position source.holding = .ok false
  target : resolveConsumedTargetInvalid source.anchor source.position = .ok false

/-- The anchor stage of one holding goes on only with the anchor read for the position, a matching
after-image, its three tests passed, and the work within the bound. -/
theorem resolveAnchorStage_proceed {reader : InventoryOwnershipReadContext} {work work' : Nat}
    {id : LotHoldingId} {holding : LotHolding} {position : InventoryPostedPosition}
    {source : InventoryPostedReductionSource} (hg : reader.assertCurrent () = .ok ())
    (h : resolveAnchorStage reader work id holding position = .ok (.proceed (work', source))) :
    source.holding = holding ∧ source.position = position ∧
      reader.readAnchor position.anchor = .ok (some source.anchor) ∧
      (∃ image, reader.readPositionAfterImage (positionOrigin reader.bookId position) =
        .ok (some image) ∧ sameOwnershipValue position image = true) ∧
      resolveAnchorSourceInvalid reader.bookId id holding position source.anchor = .ok false ∧
      resolveBalanceInvalid source.anchor position holding = .ok false ∧
      resolveConsumedTargetInvalid source.anchor position = .ok false ∧
      work' = work + anchorWork source.anchor ∧ work' ≤ cap := by
  unfold resolveAnchorStage readGuard at h
  rw [hg] at h
  simp only [InventoryOwnershipEffectErr.ofRead, InventoryOwnershipEffectErr.ofQuantize] at h
  cases ha : reader.readAnchor position.anchor with
  | error e => simp [ha] at h
  | ok supplied =>
    cases supplied with
    | none => simp [ha] at h
    | some anchor =>
      simp only [ha] at h
      split at h
      · simp at h
      · rename_i hcap
        cases hs : resolveAnchorSourceInvalid reader.bookId id holding position anchor with
        | error e => simp [hs] at h
        | ok bad =>
          cases bad
          · cases hi : reader.readPositionAfterImage (positionOrigin reader.bookId position) with
            | error e => simp [hs, hi] at h
            | ok image =>
              cases image with
              | none => simp [hs, hi] at h
              | some image =>
                by_cases hsame : sameOwnershipValue position image = true
                · cases hb : resolveBalanceInvalid anchor position holding with
                  | error e => simp [hs, hi, hsame, hb] at h
                  | ok bb =>
                    cases bb
                    · cases ht : resolveConsumedTargetInvalid anchor position with
                      | error e => simp [hs, hi, hsame, hb, ht] at h
                      | ok tb =>
                        cases tb
                        · simp only [hs, hi, hsame, hb, ht, Bool.not_true, Bool.false_eq_true,
                            ↓reduceIte, Except.ok.injEq, OwnershipStep.proceed.injEq,
                            Prod.mk.injEq] at h
                          obtain ⟨rfl, rfl⟩ := h
                          exact ⟨rfl, rfl, rfl, ⟨image, rfl, hsame⟩, hs, hb, ht, rfl,
                            Nat.le_of_not_lt hcap⟩
                        · simp [hs, hi, hsame, hb, ht] at h
                    · simp [hs, hi, hsame, hb] at h
                · simp [hs, hi, hsame] at h
          · simp [hs] at h

/-- One holding resolves only as a `ResolvedSource`, its anchor's work counted within the bound. -/
theorem resolveHolding_proceed {reader : InventoryOwnershipReadContext} {work work' : Nat}
    {id : LotHoldingId} {source : InventoryPostedReductionSource}
    (hg : reader.assertCurrent () = .ok ())
    (h : resolveHolding reader work id = .ok (.proceed (work', source))) :
    ResolvedSource reader id source ∧ work' = work + anchorWork source.anchor ∧ work' ≤ cap := by
  unfold resolveHolding readGuard at h
  rw [hg] at h
  simp only [InventoryOwnershipEffectErr.ofRead, InventoryOwnershipEffectErr.ofQuantize] at h
  cases hh : reader.readCurrentHolding id with
  | error e => simp [hh] at h
  | ok supplied =>
    cases supplied with
    | none => simp [hh] at h
    | some holding =>
      cases hp : reader.readCurrentPosition id with
      | error e => simp [hh, hp] at h
      | ok supplied =>
        cases supplied with
        | none => simp [hh, hp] at h
        | some position =>
          cases hc : resolveCurrentSourceInvalid reader.bookId reader.bookRevision id holding
              position with
          | error e => simp [hh, hp, hc] at h
          | ok bad =>
            cases bad
            · simp only [hh, hp, hc] at h
              obtain ⟨rfl, rfl, ha, hi, hs, hb, ht, hw, hcap⟩ := resolveAnchorStage_proceed hg h
              exact ⟨⟨hh, hp, ha, hi, hc, hs, hb, ht⟩, hw, hcap⟩
            · simp [hh, hp, hc] at h

/-- The loop resolves the holdings one by one, each to a `ResolvedSource`, in the order given. -/
theorem resolveLoop_proceed {reader : InventoryOwnershipReadContext}
    (hg : reader.assertCurrent () = .ok ()) :
    ∀ {work : Nat} {ids : List LotHoldingId} {sources : List InventoryPostedReductionSource},
      resolveLoop reader work ids = .ok (.proceed sources) →
        List.Forall₂ (ResolvedSource reader) ids sources
  | _, [], sources, h => by
    simp only [resolveLoop, Except.ok.injEq, OwnershipStep.proceed.injEq] at h
    subst h; exact .nil
  | work, id :: rest, sources, h => by
    unfold resolveLoop at h
    cases hh : resolveHolding reader work id with
    | error e => simp [hh] at h
    | ok step =>
      cases step with
      | rejected r => simp [hh] at h
      | proceed value =>
        obtain ⟨work', source⟩ := value
        cases hl : resolveLoop reader work' rest with
        | error e => simp [hh, hl] at h
        | ok step' =>
          cases step' with
          | rejected r => simp [hh, hl] at h
          | proceed sources' =>
            simp only [hh, hl, Except.ok.injEq, OwnershipStep.proceed.injEq] at h
            subst h
            exact .cons (resolveHolding_proceed hg hh).1 (resolveLoop_proceed hg hl)

/-- Resolved sources come from a current read context and a valid read set: one
`ResolvedSource` for each requested holding, in UTF-16 order of the holding identifiers. -/
theorem resolveInventoryOwnershipSources_resolved {reader : InventoryOwnershipReadContext}
    {holdingIds : List LotHoldingId} {sources : List InventoryPostedReductionSource}
    (h : resolveInventoryOwnershipSources reader holdingIds = .ok (.resolved sources)) :
    reader.assertCurrent () = .ok () ∧
      resolveReadSetInvalid reader.bookId reader.bookRevision holdingIds = false ∧
      List.Forall₂ (ResolvedSource reader) (sortByText (·.value) holdingIds) sources := by
  unfold resolveInventoryOwnershipSources at h
  cases hg : reader.assertCurrent () with
  | error e => simp [hg, InventoryOwnershipEffectErr.ofRead] at h
  | ok u =>
    cases u
    simp only [hg, InventoryOwnershipEffectErr.ofRead] at h
    split at h
    · simp at h
    · rename_i hset
      cases hl : resolveLoop reader 0 (sortByText (·.value) holdingIds) with
      | error e => simp [hl] at h
      | ok step =>
        cases step with
        | rejected r => simp [hl] at h
        | proceed sources' =>
          simp only [hl, readGuard, hg, InventoryOwnershipEffectErr.ofRead, Except.ok.injEq,
            InventoryOwnershipSourceResolution.resolved.injEq] at h
          subst h
          exact ⟨rfl, by simpa using hset, resolveLoop_proceed hg hl⟩

/-- The current-source test passes exactly when the holding and the position are of the holding
and the pinned book, the position is valid, its anchor is of the pinned book and its origin is not
after the pinned revision. -/
theorem resolveCurrentSourceInvalid_eq_ok_false_iff {book : BookId} {revision : Int}
    {id : LotHoldingId} {holding : LotHolding} {position : InventoryPostedPosition} :
    resolveCurrentSourceInvalid book revision id holding position = .ok false ↔
      holding.id = id ∧ holding.bookId = book ∧ position.holdingId = id ∧
        ownershipPositionValid position = .ok true ∧ position.anchor.bookId = book ∧
        position.originBookRevision ≤ revision := by
  unfold resolveCurrentSourceInvalid
  by_cases h1 : (holding.id != id || holding.bookId != book || position.holdingId != id) = true
  · simp only [h1, ↓reduceIte]
    simp only [Bool.or_eq_true, bne_iff_ne, ne_eq] at h1
    simp only [Except.ok.injEq, Bool.true_eq_false, false_iff, not_and]
    rcases h1 with (h1 | h1) | h1 <;> intros <;> simp_all
  · simp only [h1, Bool.false_eq_true, ↓reduceIte]
    simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, not_or, not_not] at h1
    obtain ⟨⟨h1, h2⟩, h3⟩ := h1
    cases hv : ownershipPositionValid position with
    | error e => simp
    | ok valid =>
      cases valid <;> simp [h1, h2, h3, Bool.or_eq_false_iff, bne_eq_false_iff_eq, not_lt]

/-- The anchor-source test passes exactly when the anchor is valid, the position binds its exact
version, and its coordinate is the holding's in the pinned book. -/
theorem resolveAnchorSourceInvalid_eq_ok_false_iff {book : BookId} {id : LotHoldingId}
    {holding : LotHolding} {position : InventoryPostedPosition} {anchor : InventoryPostedAnchor} :
    resolveAnchorSourceInvalid book id holding position anchor = .ok false ↔
      ownershipAnchorValid anchor = .ok true ∧
        sameOwnershipValue position.anchor (anchorReferenceOf anchor) = true ∧
        anchor.coordinate.bookId = book ∧ anchor.coordinate.holdingId = id ∧
        anchor.coordinate.lotId = holding.lotId ∧ anchor.coordinate.accountId = holding.accountId ∧
        anchor.coordinate.unitsCommodityId = holding.commodityId ∧
        anchor.coordinate.functionalCommodityId = holding.basisCommodityId := by
  unfold resolveAnchorSourceInvalid
  cases hv : ownershipAnchorValid anchor with
  | error e => simp
  | ok valid =>
    cases valid <;> simp [Bool.or_eq_false_iff, bne_eq_false_iff_eq, and_assoc]

/-- When the balance test passes for constructible values, the holding holds exactly the anchor's
unconsumed quantity, with a nonnegative basis and carrying amount, an allowance that is not
positive, nothing carried when nothing is held, and a carrying amount of basis plus allowance. -/
theorem resolveBalanceInvalid_eq_ok_false {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} (hA : anchor.WF)
    (hP : position.WF) (hH : holding.WF)
    (h : resolveBalanceInvalid anchor position holding = .ok false) :
    position.consumedQuantity.toRat ≤ anchor.quantity.toRat ∧
      holding.remainingQuantity.toRat = anchor.quantity.toRat - position.consumedQuantity.toRat ∧
      0 ≤ holding.remainingTotalBasis.toRat ∧ holding.remainingValuationAllowance.toRat ≤ 0 ∧
      0 ≤ holding.remainingCarryingAmount.toRat ∧
      (holding.remainingQuantity.toRat = 0 →
        holding.remainingTotalBasis.toRat = 0 ∧ holding.remainingValuationAllowance.toRat = 0) ∧
      holding.remainingCarryingAmount.toRat =
        holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat := by
  have hq := hA.quantity
  have hc := hP.consumedQuantity
  have hrq := hH.remainingQuantity
  have hrb := hH.remainingTotalBasis
  have hra := hH.remainingValuationAllowance
  have hrc := hH.remainingCarryingAmount
  unfold resolveBalanceInvalid at h
  split at h
  · simp at h
  · rename_i hgt
    rw [ExactRational.compare_eq_compare_toRat hc hq] at hgt
    have hle : position.consumedQuantity.toRat ≤ anchor.quantity.toRat := by
      by_contra hlt
      exact hgt (by simp [compare_gt_iff_gt.mpr (not_le.mp hlt)])
    cases hs : anchor.quantity.subtract position.consumedQuantity with
    | error e => simp [liftExact, hs] at h
    | ok d =>
      obtain ⟨hdwf, hdrat⟩ := ExactRational.subtract_ok hq hc hs
      simp only [liftExact, hs] at h
      split at h
      · simp at h
      · rename_i hbad
        simp only [Bool.or_eq_true, Bool.and_eq_true, Bool.not_eq_true', beq_iff_eq, not_or,
          not_and, Bool.not_eq_false] at hbad
        obtain ⟨⟨⟨⟨heq, hbn⟩, hag⟩, hcn⟩, hz⟩ := hbad
        cases ha : holding.remainingTotalBasis.add holding.remainingValuationAllowance with
        | error e => simp [ha] at h
        | ok sum =>
          obtain ⟨hswf, hsrat⟩ := ExactRational.add_ok hrb hra ha
          simp only [ha, Except.ok.injEq, Bool.not_eq_false'] at h
          have heq' := (ExactRational.equals_iff hrq hdwf).mp heq
          have hcar := (ExactRational.equals_iff hrc hswf).mp h
          rw [ExactRational.compare_eq_compare_toRat hra ExactRational.zero_wf,
            ExactRational.zero_toRat] at hag
          refine ⟨hle, heq'.trans hdrat, ?_, ?_, ?_, ?_, hcar.trans hsrat⟩
          · exact not_lt.mp (fun hlt => hbn ((ExactRational.isNegative_iff hrb).mpr hlt))
          · exact not_lt.mp (fun hlt => hag (compare_gt_iff_gt.mpr hlt))
          · exact not_lt.mp (fun hlt => hcn ((ExactRational.isNegative_iff hrc).mpr hlt))
          · intro h0
            have hz' := hz ((ExactRational.isZero_iff hrq).mpr h0)
            exact ⟨(ExactRational.isZero_iff hrb).mp hz'.1, (ExactRational.isZero_iff hra).mp hz'.2⟩

/-- The rejections the loop of lines 950 to 997 can give. -/
def resolveLoopRejections : List OwnershipRejection :=
  [resolveHoldingAbsentRejection, resolvePositionAbsentRejection, resolveCurrentSourceRejection,
    resolveAnchorAbsentRejection, resolveWorkRejection, resolveAnchorSourceRejection,
    resolvePositionOriginRejection, resolvePositionBalanceRejection, resolveConsumedTargetRejection]

/-- The anchor stage rejects only with a rejection of the loop. -/
theorem resolveAnchorStage_rejected_mem {reader : InventoryOwnershipReadContext} {work : Nat}
    {id : LotHoldingId} {holding : LotHolding} {position : InventoryPostedPosition}
    {rejection : OwnershipRejection}
    (h : resolveAnchorStage reader work id holding position = .ok (.rejected rejection)) :
    rejection ∈ resolveLoopRejections := by
  unfold resolveAnchorStage at h
  dsimp only at h
  repeat' split at h
  all_goals
    simp only [Except.ok.injEq, OwnershipStep.rejected.injEq, reduceCtorEq] at h
  all_goals subst h; simp [resolveLoopRejections]

/-- One holding is rejected only with a rejection of the loop. -/
theorem resolveHolding_rejected_mem {reader : InventoryOwnershipReadContext} {work : Nat}
    {id : LotHoldingId} {rejection : OwnershipRejection}
    (h : resolveHolding reader work id = .ok (.rejected rejection)) :
    rejection ∈ resolveLoopRejections := by
  unfold resolveHolding at h
  repeat' split at h
  all_goals first
    | exact resolveAnchorStage_rejected_mem h
    | (simp only [Except.ok.injEq, OwnershipStep.rejected.injEq, reduceCtorEq] at h; done)
    | (simp only [Except.ok.injEq, OwnershipStep.rejected.injEq] at h
       subst h; simp [resolveLoopRejections])

/-- The loop rejects only with one of its own rejections. -/
theorem resolveLoop_rejected_mem {reader : InventoryOwnershipReadContext} :
    ∀ {work : Nat} {ids : List LotHoldingId} {rejection : OwnershipRejection},
      resolveLoop reader work ids = .ok (.rejected rejection) →
        rejection ∈ resolveLoopRejections
  | _, [], _, h => by simp [resolveLoop] at h
  | work, id :: rest, rejection, h => by
    unfold resolveLoop at h
    cases hh : resolveHolding reader work id with
    | error e => simp [hh] at h
    | ok step =>
      cases step with
      | rejected r =>
        simp only [hh, Except.ok.injEq, OwnershipStep.rejected.injEq] at h
        exact h ▸ resolveHolding_rejected_mem hh
      | proceed value =>
        cases hl : resolveLoop reader value.1 rest with
        | error e => simp [hh, hl] at h
        | ok step' =>
          cases step' with
          | rejected r =>
            simp only [hh, hl, Except.ok.injEq, OwnershipStep.rejected.injEq] at h
            exact h ▸ resolveLoop_rejected_mem hl
          | proceed sources => simp [hh, hl] at h

/-- The read-set rejection is not one the loop gives. -/
theorem resolveReadSetRejection_not_mem : resolveReadSetRejection ∉ resolveLoopRejections := by
  simp [resolveLoopRejections, resolveReadSetRejection, resolveHoldingAbsentRejection,
    resolvePositionAbsentRejection, resolveCurrentSourceRejection, resolveAnchorAbsentRejection,
    resolveWorkRejection, resolveAnchorSourceRejection, resolvePositionOriginRejection,
    resolvePositionBalanceRejection, resolveConsumedTargetRejection, InventoryOwnership.reject,
    diagnostic]

/-- The read-set rejection (line 942) is given exactly when the context is current and the read
set is not one bounded, distinct, nonempty set of nonempty identifiers at a committed head. -/
theorem resolveInventoryOwnershipSources_readSet_iff {reader : InventoryOwnershipReadContext}
    {holdingIds : List LotHoldingId} :
    resolveInventoryOwnershipSources reader holdingIds = .ok (.rejected resolveReadSetRejection) ↔
      reader.assertCurrent () = .ok () ∧
        resolveReadSetInvalid reader.bookId reader.bookRevision holdingIds = true := by
  unfold resolveInventoryOwnershipSources
  cases hg : reader.assertCurrent () with
  | error e => simp [InventoryOwnershipEffectErr.ofRead]
  | ok u =>
    cases u
    simp only [InventoryOwnershipEffectErr.ofRead, true_and]
    by_cases hs : resolveReadSetInvalid reader.bookId reader.bookRevision holdingIds = true
    · simp [hs]
    · simp only [hs, Bool.false_eq_true, ↓reduceIte, iff_false]
      cases hl : resolveLoop reader 0 (sortByText (·.value) holdingIds) with
      | error e => simp
      | ok step =>
        cases step with
        | rejected r =>
          simp only [Except.ok.injEq, InventoryOwnershipSourceResolution.rejected.injEq]
          intro hr
          exact resolveReadSetRejection_not_mem (hr ▸ resolveLoop_rejected_mem hl)
        | proceed sources =>
          simp only [readGuard, hg, InventoryOwnershipEffectErr.ofRead]
          simp

/-- What every resolved source of a constructible read context means: the holding and the position
are of the requested holding in the pinned book, the position is valid and not from after the pinned
revision, the anchor is valid, bound by the position and of the holding's coordinate, and the
holding's balances reconcile with the anchor. -/
theorem ResolvedSource.facts {reader : InventoryOwnershipReadContext} {id : LotHoldingId}
    {source : InventoryPostedReductionSource} (hR : reader.WF) (h : ResolvedSource reader id source) :
    source.holding.id = id ∧ source.holding.bookId = reader.bookId ∧ source.position.holdingId = id ∧
      ownershipPositionValid source.position = .ok true ∧
      source.position.anchor.bookId = reader.bookId ∧
      source.position.originBookRevision ≤ reader.bookRevision ∧
      ownershipAnchorValid source.anchor = .ok true ∧
      sameOwnershipValue source.position.anchor (anchorReferenceOf source.anchor) = true ∧
      source.anchor.coordinate.bookId = reader.bookId ∧ source.anchor.coordinate.holdingId = id ∧
      source.anchor.coordinate.lotId = source.holding.lotId ∧
      source.anchor.coordinate.accountId = source.holding.accountId ∧
      source.anchor.coordinate.unitsCommodityId = source.holding.commodityId ∧
      source.anchor.coordinate.functionalCommodityId = source.holding.basisCommodityId ∧
      source.position.consumedQuantity.toRat ≤ source.anchor.quantity.toRat ∧
      source.holding.remainingQuantity.toRat =
        source.anchor.quantity.toRat - source.position.consumedQuantity.toRat ∧
      0 ≤ source.holding.remainingTotalBasis.toRat ∧
      source.holding.remainingValuationAllowance.toRat ≤ 0 ∧
      0 ≤ source.holding.remainingCarryingAmount.toRat ∧
      source.holding.remainingCarryingAmount.toRat =
        source.holding.remainingTotalBasis.toRat +
          source.holding.remainingValuationAllowance.toRat := by
  obtain ⟨c1, c2, c3, c4, c5, c6⟩ := resolveCurrentSourceInvalid_eq_ok_false_iff.mp h.currentSource
  obtain ⟨a1, a2, a3, a4, a5, a6, a7, a8⟩ :=
    resolveAnchorSourceInvalid_eq_ok_false_iff.mp h.anchorSource
  obtain ⟨b1, b2, b3, b4, b5, -, b7⟩ := resolveBalanceInvalid_eq_ok_false
    (hR.readAnchor _ _ h.anchorRead) (hR.readCurrentPosition _ _ h.positionRead)
    (hR.readCurrentHolding _ _ h.holdingRead).1 h.balance
  exact ⟨c1, c2, c3, c4, c5, c6, a1, a2, a3, a4, a5, a6, a7, a8, b1, b2, b3, b4, b5, b7⟩

end Rastrata.Kernel

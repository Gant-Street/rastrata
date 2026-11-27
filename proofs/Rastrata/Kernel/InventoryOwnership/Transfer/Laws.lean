/-
The laws of `prepareInventoryPostedTransferGroup` (`inventory-ownership.ts` line 577): a prepared
transfer group is its sources' reductions, each prepared as `prepareInventoryPostedReduction`
prepares it, and what leaves the source arrives at the destination: each destination anchor's
budget is its source share's posted amount, exactly, and its quantity is the allocation's.

`transferConstruction` holds the closed term `ExactRational.of(1n, 1n)`; reducing it would make
Lean compute `2 ^ maxExactIntegerBits`, which this file must never do. `withinMagnitude` is
therefore irreducible here (`attribute [local irreducible]`), the loop is taken one turn at a time
through `transferConstruction_cons`, and the closed term is rewritten by `exactRational_of_one_one`,
whose proof uses `withinMagnitude_one`.
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.Model
import Rastrata.Kernel.InventoryOwnership.Reduction

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- `ordered` (line 606): the entries in source holding-identifier order. -/
def transferOrdered (entries : List InventoryPostedTransferEntry) :
    List InventoryPostedTransferEntry :=
  sortByText (·.source.holding.id.value) entries

/-- `sourceCoordinate` (line 607). -/
def transferSourceCoordinate (entries : List InventoryPostedTransferEntry) :
    InventoryPostedCoordinate :=
  ((transferOrdered entries).head?.map (·.source.anchor.coordinate)).getD default

/-- `firstDest` (line 608). -/
def transferFirstDest (entries : List InventoryPostedTransferEntry) : LotHolding :=
  ((transferOrdered entries).head?.map (·.destinationHolding)).getD default

/-- Every value a prepared transfer group was computed from, and how (lines 583 to 773). -/
structure TransferGroupView (context : InventoryPostedTransferGroupContext)
    (entries : List InventoryPostedTransferEntry)
    (sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink)
    (group : InventoryPostedTransferGroup) where
  reductions : List InventoryPostedReduction
  total : ExactRational
  totalBasis : ExactRational
  sourcePosting : Option CanonicalPostingReference
  destinationPosting : Option CanonicalPostingReference
  transferred : QuantizedValue
  population : transferPopulationInvalid entries sourceJournalLink destinationJournalLink = false
  sources : transferSourcesExceeded 0 entries = false
  identity : transferIdentityInvalid context entries = false
  checks : transferCheckLoop context (transferSourceCoordinate entries) (transferFirstDest entries)
    (transferOrdered entries) = none
  loop : transferReductionLoop context 0 ExactRational.zero ExactRational.zero ExactRational.zero
    (transferOrdered entries) = .ok (.proceed (reductions, total, group.transferredQuantity,
      totalBasis))
  sourceStep : transferSourcePosting context (transferSourceCoordinate entries) sourceJournalLink
    total group.transferredQuantity totalBasis = .ok (.proceed sourcePosting)
  destinationStep : transferDestinationPosting context (transferSourceCoordinate entries)
    (transferFirstDest entries) destinationJournalLink total group.transferredQuantity totalBasis =
      .ok (.proceed destinationPosting)
  construction : transferConstruction context sourcePosting destinationPosting
    (transferOrdered entries).length 0 (transferOrdered entries) reductions =
      .ok (.proceed (group.transferOutMovements, group.destinationAnchors,
        group.destinationMovements))
  quantized : quantize total context.destinationQuantizationPolicy.rule = .ok transferred
  transferredPostedAmount : group.transferredPostedAmount = transferred.amount
  destinationLots : group.destinationLots = (transferOrdered entries).map (·.destinationLot)
  destinationHoldings : group.destinationHoldings =
    (transferOrdered entries).map (·.destinationHolding)
  afterSourceHoldings : group.afterSourceHoldings = reductions.map (·.afterHolding)
  afterSourcePositions : group.afterSourcePositions = reductions.map (·.afterPosition)

end InventoryOwnership

open InventoryOwnership in
/-- A prepared transfer group passed every test and was computed as the TypeScript computes it. -/
theorem prepareInventoryPostedTransferGroup_prepared
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    {group : InventoryPostedTransferGroup}
    (h : prepareInventoryPostedTransferGroup context entries sourceJournalLink
      destinationJournalLink = .ok (.prepared group)) :
    Nonempty (TransferGroupView context entries sourceJournalLink destinationJournalLink group) := by
  unfold prepareInventoryPostedTransferGroup at h
  split at h
  · cases h
  rename_i hpop
  split at h
  · cases h
  rename_i hsrc
  split at h
  · cases h
  rename_i hid
  dsimp only at h
  split at h
  · cases h
  rename_i hchecks
  split at h
  · cases h
  · cases h
  rename_i reductions total totalQuantity totalBasis hloop
  split at h
  · cases h
  · cases h
  rename_i sourcePosting hsourceStep
  split at h
  · cases h
  · cases h
  rename_i destinationPosting hdestStep
  split at h
  · cases h
  · cases h
  rename_i outs anchors ins hcons
  split at h
  · cases h
  rename_i transferred hq
  simp only [Except.ok.injEq, InventoryPostedTransferGroupResult.prepared.injEq] at h
  subst h
  rw [ofQuantize_eq_ok_iff] at hloop hcons hq
  exact ⟨⟨reductions, total, totalBasis, sourcePosting, destinationPosting, transferred,
    by simpa using hpop, by simpa using hsrc, by simpa using hid, hchecks, hloop, hsourceStep,
    hdestStep, hcons, hq, rfl, rfl, rfl, rfl, rfl⟩⟩

namespace InventoryOwnership

/-- The transfer's source reductions, from the entry at `index`: each is the reduction
`prepareInventoryPostedReduction` prepares for its entry's source and allocation, with the origin of
its transfer-out movement and ordinal. -/
def TransferReductionsPrepared (context : InventoryPostedGroupContext) :
    Nat → List InventoryPostedTransferEntry → List InventoryPostedReduction → Prop
  | _, [], [] => True
  | index, entry :: entries, reduction :: reductions =>
    prepareInventoryPostedReduction entry.source.anchor entry.source.position entry.source.holding
        entry.allocation (groupOrigin context entry.transferOutMovementId index) =
          .ok (.prepared reduction) ∧
      TransferReductionsPrepared context (index + 1) entries reductions
  | _, _, _ => False

/-- The reductions prepared for a transfer are as many as its entries. -/
theorem TransferReductionsPrepared.length_eq {context : InventoryPostedGroupContext} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction},
      TransferReductionsPrepared context index entries reductions →
      entries.length = reductions.length
  | _, [], [], _ => rfl
  | _, [], _ :: _, h => h.elim
  | _, _ :: _, [], h => h.elim
  | _, _ :: _, _ :: _, h => by
    simp only [List.length_cons, TransferReductionsPrepared.length_eq h.2]

/-- The share of a prepared reduction posts a constructible amount. -/
theorem prepared_proof_postedAmount_wf {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (hA : anchor.WF) (hP : position.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) : reduction.reductionProof.postedAmount.WF := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨-, -, -, -, -, -, -, -, -, -, -, hproof, -⟩ := reductionRecord_ok v.record_eq
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hP.consumedQuantity hL.allocatedQuantity v.consumed_eq
  obtain ⟨hbfwf, -⟩ := ExactRational.divide_ok hP.consumedQuantity hA.quantity v.before_eq
  obtain ⟨hafwf, -⟩ := ExactRational.divide_ok hcqwf hA.quantity v.after_eq
  rw [hproof]
  exact (share_facts hA.postedBudget hbfwf hafwf v.share_eq).2.2.2.1

/-- The reduction loop of a transfer, when it goes through: one reduction per entry, each prepared
for its entry, and the running posted money, quantity and basis grown by exactly the shares' posted
amounts and the allocations' quantities and bases. -/
theorem transferReductionLoop_proceed {context : InventoryPostedTransferGroupContext} :
    ∀ {entries : List InventoryPostedTransferEntry} {index : Nat}
      {posted quantity basis : ExactRational} {reductions : List InventoryPostedReduction}
      {total totalQuantity totalBasis : ExactRational},
      posted.WF → quantity.WF → basis.WF → (∀ entry ∈ entries, entry.WF) →
      transferReductionLoop context index posted quantity basis entries =
        .ok (.proceed (reductions, total, totalQuantity, totalBasis)) →
      TransferReductionsPrepared context.toInventoryPostedGroupContext index entries reductions ∧
        total.WF ∧ totalQuantity.WF ∧ totalBasis.WF ∧
        total.toRat = posted.toRat + (reductions.map (·.reductionProof.postedAmount.toRat)).sum ∧
        totalQuantity.toRat =
          quantity.toRat + (entries.map (·.allocation.allocatedQuantity.toRat)).sum ∧
        totalBasis.toRat =
          basis.toRat + (entries.map (·.allocation.allocatedTotalBasis.toRat)).sum
  | [], _, posted, quantity, basis, reductions, total, totalQuantity, totalBasis, hp, hq, hb, _,
      h => by
    simp only [transferReductionLoop, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl, rfl⟩ := h
    simp [TransferReductionsPrepared, hp, hq, hb]
  | entry :: entries, index, posted, quantity, basis, reductions, total, totalQuantity,
      totalBasis, hp, hq, hb, hE, h => by
    have hW := hE entry (by simp)
    unfold transferReductionLoop at h
    split at h
    · cases h
    · cases h
    rename_i reduction hprep
    split at h
    · cases h
    rename_i amount hamount
    split at h
    · cases h
    rename_i posted' hposted
    split at h
    · cases h
    rename_i quantity' hquantity
    split at h
    · cases h
    rename_i basis' hbasis
    rw [liftExact_eq_ok_iff] at hamount hposted hquantity hbasis
    have hpa := ExactDecimal.toRational_ok (prepared_proof_postedAmount_wf hW.source.anchor
      hW.source.position hW.allocation hprep) hamount
    obtain ⟨hp', hptr⟩ := ExactRational.add_ok hp hpa.1 hposted
    obtain ⟨hq', hqtr⟩ := ExactRational.add_ok hq hW.allocation.allocatedQuantity hquantity
    obtain ⟨hb', hbtr⟩ := ExactRational.add_ok hb hW.allocation.allocatedTotalBasis hbasis
    split at h
    · cases h
    · cases h
    rename_i reductions' total' totalQuantity' totalBasis' hrest
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl, rfl⟩ := h
    obtain ⟨hprepared, htwf, hqwf, hbwf, ht, hqt, hbt⟩ :=
      transferReductionLoop_proceed hp' hq' hb' (fun e he => hE e (by simp [he])) hrest
    refine ⟨⟨hprep, hprepared⟩, htwf, hqwf, hbwf, ?_, ?_, ?_⟩
    · rw [ht, hptr, hpa.2]
      simp only [List.map_cons, List.sum_cons]
      ring
    · rw [hqt, hqtr]
      simp only [List.map_cons, List.sum_cons]
      ring
    · rw [hbt, hbtr]
      simp only [List.map_cons, List.sum_cons]
      ring

end InventoryOwnership

namespace InventoryOwnership

/-- `ExactRational.of(1n, 1n)` is one. -/
theorem exactRational_of_one_one : ExactRational.of 1 1 = .ok ⟨1, 1⟩ := by
  unfold ExactRational.of
  simp only [withinMagnitude_one]
  rfl

attribute [local irreducible] withinMagnitude

/-- One turn of the construction loop of a transfer (lines 696 to 760), given what the rest of the
loop returns. -/
def transferStep (context : InventoryPostedTransferGroupContext)
    (sourcePosting destinationPosting : Option CanonicalPostingReference) (count index : Nat)
    (entry : InventoryPostedTransferEntry) (reduction : InventoryPostedReduction)
    (rest : Except QuantizeErr (OwnershipStep (List InventoryPostedReductionMovement ×
      List InventoryPostedAnchor × List InventoryPostedAcquisitionMovement))) :
    Except QuantizeErr (OwnershipStep (List InventoryPostedReductionMovement ×
      List InventoryPostedAnchor × List InventoryPostedAcquisitionMovement)) :=
  let destPolicy := context.destinationQuantizationPolicy
  let transferOutOrdinal := context.firstArtifactOrdinal + index
  let anchorOrdinal := context.firstArtifactOrdinal + ((count + index : Nat) : Int)
  let destMovementOrdinal := context.firstArtifactOrdinal + ((2 * count + index : Nat) : Int)
  let transferOut := reductionMovementOf context.toInventoryReductionEffectContext .transferOut
    entry.transferOutMovementId transferOutOrdinal entry.source.anchor.coordinate reduction
    sourcePosting
  let transferredBudget := reduction.reductionProof.postedAmount
  let transferOutRef : InventoryPostedMovementReference :=
    { id := transferOut.id, contentHash := transferOut.contentHash, bookId := context.bookId,
      effectKey := context.effectKey, artifactOrdinal := transferOut.artifactOrdinal,
      bookRevision := context.bookRevision }
  let predecessorRef : InventoryPostedPositionReference :=
    { id := entry.source.position.holdingId, contentHash := entry.source.position.contentHash,
      bookId := context.bookId, effectKey := entry.source.position.originEffectKey,
      artifactOrdinal := entry.source.position.originArtifactOrdinal,
      bookRevision := entry.source.position.originBookRevision }
  match transferPostedValue destPolicy reduction with
  | .error e => .error e
  | .ok (.rejected rejection) => .ok (.rejected rejection)
  | .ok (.proceed postedValue) =>
    let anchorBody := transferAnchorBody context entry anchorOrdinal transferredBudget postedValue
      destinationPosting predecessorRef transferOutRef
    let destAnchor : InventoryPostedAnchor := ⟨anchorBody, hashInventoryPostedAnchor anchorBody⟩
    match liftExact (ExactDecimal.of 0 destPolicy.targetScale) with
    | .error e => .error e
    | .ok zeroPosted =>
      let destPositionBody : InventoryPostedPositionBody :=
        { holdingId := entry.destinationHolding.id, consumedQuantity := ExactRational.zero,
          consumedPosted := zeroPosted, anchor := groupAnchorReference context.bookId destAnchor,
          originMovementId := entry.destinationMovementId, originEffectKey := context.effectKey,
          originArtifactOrdinal := destMovementOrdinal,
          originBookRevision := context.bookRevision }
      let destPosition : InventoryPostedPosition :=
        ⟨destPositionBody, hashInventoryPostedPosition destPositionBody⟩
      match liftExact (ExactRational.of 1 1) with
      | .error e => .error e
      | .ok one =>
        match destPolicy.quantizeCumulativePostedShare transferredBudget ExactRational.zero one with
        | .error e => .error e
        | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
        | .ok (.quantized acqProof) =>
          let acqBody : InventoryPostedAcquisitionMovementBody :=
            { id := entry.destinationMovementId, kind := .transferIn,
              effectKey := context.effectKey, artifactOrdinal := destMovementOrdinal,
              bookRevision := context.bookRevision, accountingDate := context.accountingDate,
              fiscalPeriodId := context.fiscalPeriodId, coordinate := destAnchor.coordinate,
              postedAmount := transferredBudget, afterPosition := destPosition,
              acquisitionProof := acqProof, incomingSources := [transferOutRef] }
          match rest with
          | .error e => .error e
          | .ok (.rejected rejection) => .ok (.rejected rejection)
          | .ok (.proceed (outs, anchors, ins)) =>
            .ok (.proceed (transferOut :: outs, destAnchor :: anchors,
              acquisitionMovementOf acqBody destinationPosting :: ins))


/-- The construction loop of a transfer, one turn at a time. -/
theorem transferConstruction_cons (context : InventoryPostedTransferGroupContext)
    (sourcePosting destinationPosting : Option CanonicalPostingReference) (count index : Nat)
    (entry : InventoryPostedTransferEntry) (entries : List InventoryPostedTransferEntry)
    (reduction : InventoryPostedReduction) (reductions : List InventoryPostedReduction) :
    transferConstruction context sourcePosting destinationPosting count index (entry :: entries)
        (reduction :: reductions) =
      transferStep context sourcePosting destinationPosting count index entry reduction
        (transferConstruction context sourcePosting destinationPosting count (index + 1) entries
          reductions) := by
  exact rfl


/-- What the posted components of a destination anchor are: none when the source reduction has
none, and otherwise the source's consumed components carried whole into the destination policy. -/
def DestinationPostedValue (destPolicy : QuantizationPolicy) (reduction : InventoryPostedReduction)
    (anchor : InventoryPostedAnchor) : Prop :=
  (reduction.postedValue = none → anchor.postedValue = none) ∧
    ∀ values, reduction.postedValue = some values → ∃ destination,
      allocateInventoryPostedValue values.consumed ExactRational.zero ExactRational.zero destPolicy =
        .ok (.allocated destination) ∧ anchor.postedValue = some destination.remaining

/-- The construction loop of a transfer, when it goes through: one transfer-out movement, one
destination anchor and one transfer-in movement per entry; each destination anchor's budget is its
source share's posted amount and its quantity the allocation's; each transfer-out movement posts
what its reduction posts and each transfer-in movement what the share posted; and each destination
anchor carries its source's consumed components, if any. -/
theorem transferConstruction_proceed {context : InventoryPostedTransferGroupContext}
    {sourcePosting destinationPosting : Option CanonicalPostingReference} {count : Nat} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction} {outs : List InventoryPostedReductionMovement}
      {anchors : List InventoryPostedAnchor} {ins : List InventoryPostedAcquisitionMovement},
      entries.length = reductions.length →
      transferConstruction context sourcePosting destinationPosting count index entries
          reductions = .ok (.proceed (outs, anchors, ins)) →
      anchors.map (·.postedBudget) = reductions.map (·.reductionProof.postedAmount) ∧
        anchors.map (·.quantity) = entries.map (·.allocation.allocatedQuantity) ∧
        outs.map (·.postedAmount) = reductions.map (·.postedAmount) ∧
        ins.map (·.postedAmount) = reductions.map (·.reductionProof.postedAmount) ∧
        List.Forall₂ (DestinationPostedValue context.destinationQuantizationPolicy) reductions
          anchors
  | index, [], [], outs, anchors, ins, _, h => by
    have hnil : transferConstruction context sourcePosting destinationPosting count index [] [] =
        .ok (.proceed ([], [], [])) := rfl
    rw [hnil] at h
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl⟩ := h
    simp
  | _, [], _ :: _, _, _, _, hlen, _ => by simp at hlen
  | _, _ :: _, [], _, _, _, hlen, _ => by simp at hlen
  | index, entry :: entries, reduction :: reductions, outs, anchors, ins, hlen, h => by
    simp only [List.length_cons, Nat.add_right_cancel_iff] at hlen
    rw [transferConstruction_cons] at h
    unfold transferStep at h
    rw [exactRational_of_one_one] at h
    dsimp only at h
    split at h
    · cases h
    · cases h
    rename_i postedValue hpv
    split at h
    · cases h
    rename_i zeroPosted hzero
    split at h
    · cases h
    rename_i one hone
    split at h
    · cases h
    · cases h
    rename_i acqProof hacq
    split at h
    · cases h
    · cases h
    rename_i outs' anchors' ins' hrest
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl⟩ := h
    obtain ⟨h1, h2, h3, h4, h5⟩ := transferConstruction_proceed hlen hrest
    refine ⟨?_, ?_, ?_, ?_, ?_⟩
    · simp only [List.map_cons, h1]
      rfl
    · simp only [List.map_cons, h2]
      rfl
    · simp only [List.map_cons, h3, List.cons.injEq, and_true]
      unfold reductionMovementOf
      cases reduction.monetaryKind <;> rfl
    · simp only [List.map_cons, h4, List.cons.injEq, and_true]
      unfold acquisitionMovementOf
      split <;> rfl
    · refine .cons ⟨fun hnone => ?_, fun values hsome => ?_⟩ h5
      · unfold transferPostedValue at hpv
        rw [hnone] at hpv
        simp only [Except.ok.injEq, OwnershipStep.proceed.injEq] at hpv
        subst hpv
        rfl
      · unfold transferPostedValue at hpv
        rw [hsome] at hpv
        simp only at hpv
        split at hpv
        · cases hpv
        · cases hpv
        rename_i destination halloc
        simp only [Except.ok.injEq, OwnershipStep.proceed.injEq] at hpv
        subst hpv
        exact ⟨destination, halloc, rfl⟩

end InventoryOwnership

namespace InventoryOwnership

/-- When the destination test passes: the destination holding and lot are of the book and of each
other, the holding is of the group's account, units commodity and currency, it holds exactly the
allocation's quantity and basis, and either the source anchor is component-bearing and the holding
holds the allocation's allowance and carrying amount, or it is not and the holding has no allowance
and carries its basis. -/
theorem transferDestinationInvalid_false {context : InventoryPostedTransferGroupContext}
    {sourceCoordinate : InventoryPostedCoordinate} {firstDest : LotHolding}
    {entry : InventoryPostedTransferEntry}
    (h : transferDestinationInvalid context sourceCoordinate firstDest entry = false) :
    entry.destinationHolding.bookId = context.bookId ∧ entry.destinationLot.bookId = context.bookId ∧
      entry.destinationHolding.lotId = entry.destinationLot.id ∧
      entry.destinationHolding.accountId = firstDest.accountId ∧
      entry.destinationHolding.commodityId = sourceCoordinate.unitsCommodityId ∧
      entry.destinationHolding.basisCommodityId =
        context.destinationQuantizationPolicy.functionalCommodityId ∧
      entry.destinationHolding.remainingQuantity = entry.allocation.allocatedQuantity ∧
      entry.destinationHolding.remainingTotalBasis = entry.allocation.allocatedTotalBasis ∧
      (entry.source.anchor.algorithmVersion.value = "1.1.0" →
        entry.destinationHolding.remainingValuationAllowance =
          entry.allocation.allocatedValuationAllowance ∧
        entry.destinationHolding.remainingCarryingAmount =
          entry.allocation.allocatedCarryingAmount) ∧
      (entry.source.anchor.algorithmVersion.value ≠ "1.1.0" →
        entry.destinationHolding.remainingValuationAllowance.isZero = true ∧
        entry.destinationHolding.remainingCarryingAmount =
          entry.destinationHolding.remainingTotalBasis) := by
  unfold transferDestinationInvalid at h
  simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, Bool.not_eq_false',
    exactRational_equals_iff_eq] at h
  obtain ⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨hb, hlb⟩, hlot⟩, hacct⟩, hcomm⟩, -⟩, hbc⟩, -⟩, hq⟩, hbasis⟩, hv⟩, -⟩ := h
  refine ⟨hb, hlb, hlot, hacct, hcomm, hbc, hq, hbasis, fun h11 => ?_, fun h11 => ?_⟩
  · simp only [h11, beq_self_eq_true, ↓reduceIte, Bool.or_eq_false_iff, Bool.not_eq_false',
      exactRational_equals_iff_eq] at hv
    exact hv
  · simp only [beq_iff_eq, h11, ↓reduceIte, Bool.or_eq_false_iff, Bool.not_eq_false',
      exactRational_equals_iff_eq] at hv
    exact hv

/-- When the check loop of a transfer finds nothing, every entry is of the group's source
coordinate and passes the destination test. -/
theorem transferCheckLoop_none {context : InventoryPostedTransferGroupContext}
    {sourceCoordinate : InventoryPostedCoordinate} {firstDest : LotHolding} :
    ∀ {entries : List InventoryPostedTransferEntry},
      transferCheckLoop context sourceCoordinate firstDest entries = none →
      ∀ entry ∈ entries,
        groupCoordinateMismatch context.bookId sourceCoordinate entry.source.anchor.coordinate =
          false ∧ transferDestinationInvalid context sourceCoordinate firstDest entry = false
  | [], _ => by simp
  | entry :: entries, h => by
    unfold transferCheckLoop at h
    split at h
    · cases h
    rename_i h1
    split at h
    · cases h
    rename_i h2
    intro e he
    simp only [List.mem_cons] at he
    rcases he with rfl | he
    · exact ⟨by simpa using h1, by simpa using h2⟩
    · exact transferCheckLoop_none h e he

/-- Two sums over one list whose terms agree on its members agree. -/
theorem sum_map_congr_mem {α : Type} {f g : α → ℚ} {xs : List α} (h : ∀ x ∈ xs, f x = g x) :
    (xs.map f).sum = (xs.map g).sum := by
  rw [List.map_congr_left h]

/-- What the source reductions of a transfer post is minus what their shares post, summed. -/
theorem sum_postedAmount_eq_neg' {context : InventoryPostedGroupContext} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction},
      TransferReductionsPrepared context index entries reductions →
      (∀ entry ∈ entries, entry.WF) →
      (reductions.map (·.postedAmount.toRat)).sum =
        -(reductions.map (·.reductionProof.postedAmount.toRat)).sum
  | _, [], [], _, _ => by simp
  | _, [], _ :: _, h, _ => h.elim
  | _, _ :: _, [], h, _ => h.elim
  | _, entry :: entries, reduction :: reductions, h, hE => by
    have hW := hE entry (by simp)
    obtain ⟨-, -, -, -, -, -, -, -, hr, -⟩ := prepareInventoryPostedReduction_posted
      hW.source.anchor hW.source.position hW.source.holding hW.allocation h.1
    have hrest := sum_postedAmount_eq_neg' h.2 (fun e he => hE e (List.mem_cons_of_mem _ he))
    simp only [List.map_cons, List.sum_cons]
    rw [hr, hrest]
    ring

end InventoryOwnership

open InventoryOwnership in
/-- A prepared transfer group moves exactly what leaves to where it arrives: one source reduction,
one transfer-out movement, one destination anchor, holding, lot and transfer-in movement per entry;
each destination anchor's budget is its source share's posted amount, so what arrives in the
destination budgets is exactly the posted money the shares took out of the source, and the
transfer-out movements post it negated and the transfer-in movements post it, with nothing lost to
rounding; each destination anchor's quantity is its allocation's, and the destination holdings hold
exactly the allocations' quantities and bases, which add up to the transferred quantity and basis. -/
theorem prepareInventoryPostedTransferGroup_conserved
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    {group : InventoryPostedTransferGroup} (hE : ∀ entry ∈ entries, entry.WF)
    (h : prepareInventoryPostedTransferGroup context entries sourceJournalLink
      destinationJournalLink = .ok (.prepared group)) :
    ∃ reductions,
      TransferReductionsPrepared context.toInventoryPostedGroupContext 0 (transferOrdered entries)
        reductions ∧
      group.afterSourceHoldings = reductions.map (·.afterHolding) ∧
      group.afterSourcePositions = reductions.map (·.afterPosition) ∧
      group.destinationAnchors.length = entries.length ∧
      group.transferOutMovements.length = entries.length ∧
      group.destinationMovements.length = entries.length ∧
      group.destinationAnchors.map (·.postedBudget) =
        reductions.map (·.reductionProof.postedAmount) ∧
      (group.transferOutMovements.map (·.postedAmount.toRat)).sum =
        -(group.destinationAnchors.map (·.postedBudget.toRat)).sum ∧
      group.destinationMovements.map (·.postedAmount) =
        group.destinationAnchors.map (·.postedBudget) ∧
      group.transferredQuantity.toRat = (entries.map (·.allocation.allocatedQuantity.toRat)).sum ∧
      (group.destinationAnchors.map (·.quantity.toRat)).sum = group.transferredQuantity.toRat ∧
      (group.destinationHoldings.map (·.remainingQuantity.toRat)).sum =
        group.transferredQuantity.toRat ∧
      (group.destinationHoldings.map (·.remainingTotalBasis.toRat)).sum =
        (entries.map (·.allocation.allocatedTotalBasis.toRat)).sum ∧
      List.Forall₂ (DestinationPostedValue context.destinationQuantizationPolicy) reductions
        group.destinationAnchors := by
  obtain ⟨v⟩ := prepareInventoryPostedTransferGroup_prepared h
  have hperm := sortByText_perm (·.source.holding.id.value) entries
  have hEo : ∀ entry ∈ transferOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  obtain ⟨hprep, -, hqwf, -, ht, hq, hb⟩ := transferReductionLoop_proceed ExactRational.zero_wf
    ExactRational.zero_wf ExactRational.zero_wf hEo v.loop
  have hlenR := hprep.length_eq
  have hordlen : (transferOrdered entries).length = entries.length := hperm.length_eq
  obtain ⟨h1, h2, h3, h4, h5⟩ := transferConstruction_proceed hlenR v.construction
  have hchecks := transferCheckLoop_none v.checks
  have hlenA : group.destinationAnchors.length = entries.length := by
    have := congrArg List.length h1
    simp only [List.length_map] at this
    rw [this, ← hlenR, hordlen]
  have hlenO : group.transferOutMovements.length = entries.length := by
    have := congrArg List.length h3
    simp only [List.length_map] at this
    rw [this, ← hlenR, hordlen]
  have hlenI : group.destinationMovements.length = entries.length := by
    have := congrArg List.length h4
    simp only [List.length_map] at this
    rw [this, ← hlenR, hordlen]
  have hO : group.transferOutMovements.map (·.postedAmount.toRat) =
      v.reductions.map (·.postedAmount.toRat) := by
    have := congrArg (List.map ExactDecimal.toRat) h3
    simpa only [List.map_map, Function.comp_def] using this
  have hA : group.destinationAnchors.map (·.postedBudget.toRat) =
      v.reductions.map (·.reductionProof.postedAmount.toRat) := by
    have := congrArg (List.map ExactDecimal.toRat) h1
    simpa only [List.map_map, Function.comp_def] using this
  have hAq : group.destinationAnchors.map (·.quantity.toRat) =
      (transferOrdered entries).map (·.allocation.allocatedQuantity.toRat) := by
    have := congrArg (List.map ExactRational.toRat) h2
    simpa only [List.map_map, Function.comp_def] using this
  refine ⟨v.reductions, hprep, v.afterSourceHoldings, v.afterSourcePositions, hlenA, hlenO, hlenI,
    h1, ?_, by rw [h4, h1], ?_, ?_, ?_, ?_, h5⟩
  · rw [hO, hA]
    exact sum_postedAmount_eq_neg' hprep hEo
  · rw [hq, ExactRational.zero_toRat, zero_add]
    exact (hperm.map _).sum_eq
  · rw [hAq, hq, ExactRational.zero_toRat, zero_add]
  · rw [v.destinationHoldings, List.map_map, hq, ExactRational.zero_toRat, zero_add]
    exact sum_map_congr_mem (fun e he => by
      rw [Function.comp_apply, ((transferDestinationInvalid_false
        (hchecks e he).2).2.2.2.2.2.2.1)])
  · rw [v.destinationHoldings, List.map_map, ← (hperm.map _).sum_eq]
    exact sum_map_congr_mem (fun e he => by
      rw [Function.comp_apply, ((transferDestinationInvalid_false
        (hchecks e he).2).2.2.2.2.2.2.2.1)])

namespace InventoryOwnership

/-- Every entry of a transfer has its source reduction prepared, with some origin. -/
theorem TransferReductionsPrepared.exists_of_mem {context : InventoryPostedGroupContext} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction},
      TransferReductionsPrepared context index entries reductions →
      ∀ {entry}, entry ∈ entries → ∃ origin reduction,
        prepareInventoryPostedReduction entry.source.anchor entry.source.position
          entry.source.holding entry.allocation origin = .ok (.prepared reduction)
  | _, [], _, _, _, he => by simp at he
  | _, _ :: _, [], h, _, _ => h.elim
  | _, e :: es, r :: rs, h, entry, he => by
    simp only [List.mem_cons] at he
    rcases he with rfl | he
    · exact ⟨_, r, h.1⟩
    · exact TransferReductionsPrepared.exists_of_mem h.2 he

end InventoryOwnership

open InventoryOwnership in
/-- What arrives at a destination holding of a prepared transfer: its quantity and basis are the
allocation's; from a component-bearing (`1.1.0`) source its allowance and carrying amount are the
allocation's too; from any other source it has no allowance and carries its basis, so its carrying
amount exceeds what left the source by exactly the allowance that left with the allocation (the
write-down is dropped, not transferred). -/
theorem prepareInventoryPostedTransferGroup_destination_economics
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    {group : InventoryPostedTransferGroup} (hE : ∀ entry ∈ entries, entry.WF)
    (h : prepareInventoryPostedTransferGroup context entries sourceJournalLink
      destinationJournalLink = .ok (.prepared group)) :
    ∀ entry ∈ entries,
      entry.destinationHolding.remainingQuantity = entry.allocation.allocatedQuantity ∧
      entry.destinationHolding.remainingTotalBasis = entry.allocation.allocatedTotalBasis ∧
      (entry.source.anchor.algorithmVersion.value = "1.1.0" →
        entry.destinationHolding.remainingValuationAllowance =
          entry.allocation.allocatedValuationAllowance ∧
        entry.destinationHolding.remainingCarryingAmount =
          entry.allocation.allocatedCarryingAmount) ∧
      (entry.source.anchor.algorithmVersion.value ≠ "1.1.0" →
        entry.destinationHolding.remainingValuationAllowance.toRat = 0 ∧
        entry.destinationHolding.remainingCarryingAmount.toRat =
          entry.allocation.allocatedCarryingAmount.toRat -
            entry.allocation.allocatedValuationAllowance.toRat) := by
  obtain ⟨v⟩ := prepareInventoryPostedTransferGroup_prepared h
  have hperm := sortByText_perm (·.source.holding.id.value) entries
  have hEo : ∀ entry ∈ transferOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  have hchecks := transferCheckLoop_none v.checks
  obtain ⟨hprep, -⟩ := transferReductionLoop_proceed ExactRational.zero_wf
    ExactRational.zero_wf ExactRational.zero_wf hEo v.loop
  intro entry hentry
  have hmem : entry ∈ transferOrdered entries := hperm.symm.subset hentry
  obtain ⟨-, -, -, -, -, -, hq, hb, h11, hnot⟩ := transferDestinationInvalid_false
    (hchecks entry hmem).2
  refine ⟨hq, hb, h11, fun hv => ?_⟩
  obtain ⟨hz, hcarry⟩ := hnot hv
  have hW := hE entry hentry
  -- the allocation's carrying amount is its basis plus its allowance
  obtain ⟨index, reduction, hred⟩ := TransferReductionsPrepared.exists_of_mem hprep hmem
  obtain ⟨-, -, hsum, -⟩ := prepareInventoryPostedReduction_holding_conserved hW.source.holding
    hW.allocation hred
  refine ⟨(ExactRational.isZero_iff hW.destinationHolding.remainingValuationAllowance).mp hz, ?_⟩
  rw [hcarry, hb, hsum]
  ring


namespace InventoryOwnership

/-- A total that a share quantized is representable at the policy's scale. -/
theorem representable_of_share {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {share : PolicyCumulativePostedShare} (hT : total.WF)
    (h : policy.quantizeCumulativePostedShare total before after = .ok (.quantized share)) :
    ∃ c : Int, total.toRat = c / 10 ^ policy.targetScale.toNat := by
  obtain ⟨hrule, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  obtain ⟨t, -, normalized, htotal, -, -, -, -, -, hnorm, hres, -⟩ :=
    quantizeCumulativePostedShare_quantized hrule
  obtain ⟨htwf, httr⟩ := ExactDecimal.toRational_ok hT htotal
  obtain ⟨-, hreswf, hns, -, hnres⟩ := quantize_ok htwf hnorm
  have hres0 := (ExactRational.isZero_iff hreswf).mp hres
  refine ⟨normalized.amount.coefficient, ?_⟩
  rw [← httr]
  have : t.toRat = normalized.amount.toRat := by linarith
  rw [this]
  unfold ExactDecimal.toRat
  rw [hns]
  rfl

attribute [local irreducible] withinMagnitude

/-- Every source share of a transfer was quantized again in the destination policy, from zero to
one. -/
theorem transferConstruction_shares {context : InventoryPostedTransferGroupContext}
    {sourcePosting destinationPosting : Option CanonicalPostingReference} {count : Nat} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction} {outs : List InventoryPostedReductionMovement}
      {anchors : List InventoryPostedAnchor} {ins : List InventoryPostedAcquisitionMovement},
      entries.length = reductions.length →
      transferConstruction context sourcePosting destinationPosting count index entries
          reductions = .ok (.proceed (outs, anchors, ins)) →
      ∀ reduction ∈ reductions, ∃ acqProof,
        context.destinationQuantizationPolicy.quantizeCumulativePostedShare
          reduction.reductionProof.postedAmount ExactRational.zero ⟨1, 1⟩ =
            .ok (.quantized acqProof)
  | _, [], [], _, _, _, _, _ => by simp
  | _, [], _ :: _, _, _, _, hlen, _ => by simp at hlen
  | _, _ :: _, [], _, _, _, hlen, _ => by simp at hlen
  | index, entry :: entries, reduction :: reductions, outs, anchors, ins, hlen, h => by
    simp only [List.length_cons, Nat.add_right_cancel_iff] at hlen
    rw [transferConstruction_cons] at h
    unfold transferStep at h
    rw [exactRational_of_one_one] at h
    dsimp only at h
    split at h
    · cases h
    · cases h
    split at h
    · cases h
    simp only [liftExact] at h
    split at h
    · cases h
    · cases h
    rename_i acqProof hacq
    split at h
    · cases h
    · cases h
    rename_i outs' anchors' ins' hrest
    intro r hr
    simp only [List.mem_cons] at hr
    rcases hr with rfl | hr
    · exact ⟨acqProof, hacq⟩
    · exact transferConstruction_shares hlen hrest r hr

end InventoryOwnership


namespace InventoryOwnership

/-- The shares of a transfer's source reductions post constructible amounts. -/
theorem TransferReductionsPrepared.proof_wf {context : InventoryPostedGroupContext} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction},
      TransferReductionsPrepared context index entries reductions →
      (∀ entry ∈ entries, entry.WF) →
      ∀ reduction ∈ reductions, reduction.reductionProof.postedAmount.WF
  | _, [], [], _, _ => by simp
  | _, [], _ :: _, h, _ => h.elim
  | _, _ :: _, [], h, _ => h.elim
  | _, e :: es, r :: rs, h, hE => by
    intro reduction hr
    simp only [List.mem_cons] at hr
    have hW := hE e (by simp)
    rcases hr with rfl | hr
    · exact prepared_proof_postedAmount_wf hW.source.anchor hW.source.position hW.allocation h.1
    · exact TransferReductionsPrepared.proof_wf h.2 (fun x hx => hE x (List.mem_cons_of_mem _ hx))
        reduction hr

/-- A sum of numbers each representable at a scale is representable at it. -/
theorem sum_representable {α : Type} (f : α → ℚ) (scale : Nat) :
    ∀ {xs : List α}, (∀ x ∈ xs, ∃ c : Int, f x = c / 10 ^ scale) →
      ∃ c : Int, (xs.map f).sum = c / 10 ^ scale
  | [], _ => ⟨0, by simp⟩
  | x :: xs, h => by
    obtain ⟨c, hc⟩ := h x (by simp)
    obtain ⟨d, hd⟩ := sum_representable f scale (fun y hy => h y (List.mem_cons_of_mem _ hy))
    refine ⟨c + d, ?_⟩
    simp only [List.map_cons, List.sum_cons, hc, hd]
    push_cast
    ring

end InventoryOwnership

open InventoryOwnership in
/-- The transferred posted amount a prepared transfer reports is exactly the money that arrives in
the destination budgets: each source share was quantized again in the destination policy, so their
total is representable there and the final quantization does not round it. -/
theorem prepareInventoryPostedTransferGroup_transferredPostedAmount
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    {group : InventoryPostedTransferGroup} (hE : ∀ entry ∈ entries, entry.WF)
    (h : prepareInventoryPostedTransferGroup context entries sourceJournalLink
      destinationJournalLink = .ok (.prepared group)) :
    group.transferredPostedAmount.toRat =
      (group.destinationAnchors.map (·.postedBudget.toRat)).sum := by
  obtain ⟨v⟩ := prepareInventoryPostedTransferGroup_prepared h
  have hperm := sortByText_perm (·.source.holding.id.value) entries
  have hEo : ∀ entry ∈ transferOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  obtain ⟨hprep, htwf, -, -, ht, -, -⟩ := transferReductionLoop_proceed ExactRational.zero_wf
    ExactRational.zero_wf ExactRational.zero_wf hEo v.loop
  have hlenR := hprep.length_eq
  obtain ⟨h1, -⟩ := transferConstruction_proceed hlenR v.construction
  have hshares := transferConstruction_shares hlenR v.construction
  have hwf := hprep.proof_wf hEo
  obtain ⟨c, hc⟩ := sum_representable (fun r : InventoryPostedReduction =>
      r.reductionProof.postedAmount.toRat) context.destinationQuantizationPolicy.targetScale.toNat
    (xs := v.reductions) (fun r hr => by
      obtain ⟨acq, hacq⟩ := hshares r hr
      exact representable_of_share (hwf r hr) hacq)
  have htotal : v.total.toRat = (v.reductions.map (·.reductionProof.postedAmount.toRat)).sum := by
    rw [ht, ExactRational.zero_toRat, zero_add]
  have hrep := quantize_representable htwf v.quantized (c := c) (by rw [htotal, hc]; rfl)
  have hA : group.destinationAnchors.map (·.postedBudget.toRat) =
      v.reductions.map (·.reductionProof.postedAmount.toRat) := by
    have := congrArg (List.map ExactDecimal.toRat) h1
    simpa only [List.map_map, Function.comp_def] using this
  rw [v.transferredPostedAmount, hrep.2.1, htotal, hA]

end Rastrata.Kernel

/-
The rejections of `prepareInventoryPostedTransferGroup` before its loops (lines 584 to 604), one
`iff` a diagnostic: what follows the three tests is classified by path (`transferRestPaths`); the
rejections of the destination components need the consumed components of the source reductions to
be constructible (`TransferReductionsPrepared.consumed_wf`). As in `Transfer/Laws.lean`,
`withinMagnitude` is irreducible where the construction loop is taken apart.
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.GroupRejections

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- The consumed components of a prepared reduction are constructible. -/
theorem prepared_postedValue_consumed_wf {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (hA : anchor.WF) (hP : position.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    ∀ values, reduction.postedValue = some values → values.consumed.WF := by
  intro values hv
  obtain ⟨-, hsome⟩ := prepareInventoryPostedReduction_postedValue hA hP hL h
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨-, -, -, -, -, -, -, -, -, -, -, hproof, -⟩ := reductionRecord_ok v.record_eq
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hP.consumedQuantity hL.allocatedQuantity v.consumed_eq
  obtain ⟨hbfwf, -⟩ := ExactRational.divide_ok hP.consumedQuantity hA.quantity v.before_eq
  obtain ⟨hafwf, -⟩ := ExactRational.divide_ok hcqwf hA.quantity v.after_eq
  obtain ⟨hsb, hsa, -⟩ := share_facts hA.postedBudget hbfwf hafwf v.share_eq
  cases hpv : anchor.postedValue with
  | none =>
    have := (prepareInventoryPostedReduction_postedValue hA hP hL h).1 hpv
    rw [this] at hv
    cases hv
  | some budget =>
    obtain ⟨values', hv', halloc, -⟩ := hsome budget hpv
    rw [hv] at hv'
    cases hv'
    rw [hproof, hsb, hsa] at halloc
    exact (allocateInventoryPostedValue_wf (hA.postedValue budget hpv) hbfwf hafwf halloc).1

/-- The consumed components of a transfer's prepared source reductions are constructible. -/
theorem TransferReductionsPrepared.consumed_wf {context : InventoryPostedGroupContext} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction},
      TransferReductionsPrepared context index entries reductions →
      (∀ entry ∈ entries, entry.WF) →
      ∀ reduction ∈ reductions, ∀ values, reduction.postedValue = some values →
        values.consumed.WF
  | _, [], [], _, _ => by simp
  | _, [], _ :: _, h, _ => h.elim
  | _, _ :: _, [], h, _ => h.elim
  | _, e :: es, r :: rs, h, hE => by
    intro reduction hr
    simp only [List.mem_cons] at hr
    have hW := hE e (by simp)
    rcases hr with rfl | hr
    · exact prepared_postedValue_consumed_wf hW.source.anchor hW.source.position hW.allocation
        h.1
    · exact TransferReductionsPrepared.consumed_wf h.2
        (fun x hx => hE x (List.mem_cons_of_mem _ hx)) reduction hr

attribute [local irreducible] withinMagnitude

/-- The construction loop of a transfer rejects only with the rejection of a destination's posted
components or of a destination share. -/
theorem transferConstruction_rejected {context : InventoryPostedTransferGroupContext}
    {sourcePosting destinationPosting : Option CanonicalPostingReference} {count : Nat} :
    ∀ {index : Nat} {entries : List InventoryPostedTransferEntry}
      {reductions : List InventoryPostedReduction} {rejection : OwnershipRejection},
      (∀ reduction ∈ reductions, ∀ values, reduction.postedValue = some values →
        values.consumed.WF) →
      transferConstruction context sourcePosting destinationPosting count index entries
          reductions = .ok (.rejected rejection) → rejection.Inner
  | index, [], [], rejection, _, h => by
    have hnil : transferConstruction context sourcePosting destinationPosting count index [] [] =
        .ok (.proceed ([], [], [])) := rfl
    rw [hnil] at h
    cases h
  | index, [], r :: rs, rejection, _, h => by
    have hnil : transferConstruction context sourcePosting destinationPosting count index []
        (r :: rs) = .ok (.proceed ([], [], [])) := rfl
    rw [hnil] at h
    cases h
  | index, e :: es, [], rejection, _, h => by
    have hnil : transferConstruction context sourcePosting destinationPosting count index
        (e :: es) [] = .ok (.proceed ([], [], [])) := rfl
    rw [hnil] at h
    cases h
  | index, entry :: entries, reduction :: reductions, rejection, hC, h => by
    rw [transferConstruction_cons] at h
    unfold transferStep at h
    rw [exactRational_of_one_one] at h
    dsimp only at h
    split at h
    · cases h
    · rename_i r hr
      cases h
      unfold transferPostedValue at hr
      split at hr
      · cases hr
      rename_i values hvalues
      split at hr
      · cases hr
      · rename_i vr hvr
        cases hr
        exact value_rejection_inner (hC reduction (by simp) values hvalues) ExactRational.zero_wf
          ExactRational.zero_wf hvr
      · cases hr
    split at h
    · cases h
    simp only [liftExact] at h
    split at h
    · cases h
    · rename_i d hd
      cases h
      exact share_rejection_inner hd
    split at h
    · cases h
    · cases h
      exact transferConstruction_rejected (fun r hr => hC r (List.mem_cons_of_mem _ hr))
        (by assumption)
    · cases h

end InventoryOwnership


namespace InventoryOwnership

/-- The reduction loop of a transfer rejects only with a reduction's rejection. -/
theorem transferReductionLoop_fromPaths {context : InventoryPostedTransferGroupContext} :
    ∀ {entries : List InventoryPostedTransferEntry} {index : Nat}
      {posted quantity basis : ExactRational} {rejection : OwnershipRejection},
      (∀ entry ∈ entries, entry.WF) →
      transferReductionLoop context index posted quantity basis entries =
        .ok (.rejected rejection) → rejection.FromPaths reductionPaths
  | [], _, _, _, _, _, _, h => by simp [transferReductionLoop] at h
  | entry :: rest, index, posted, quantity, basis, rejection, hE, h => by
    have hW := hE entry (by simp)
    unfold transferReductionLoop at h
    split at h
    · cases h
    · rename_i r hr
      cases h
      exact prepareInventoryPostedReduction_fromPaths hW.source.anchor hW.source.position
        hW.allocation hr
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    · cases h
      exact transferReductionLoop_fromPaths (fun e he => hE e (List.mem_cons_of_mem _ he))
        (by assumption)
    · cases h

/-- The check loop of a transfer rejects for a source coordinate or a destination. -/
theorem transferCheckLoop_some {context : InventoryPostedTransferGroupContext}
    {sourceCoordinate : InventoryPostedCoordinate} {firstDest : LotHolding} :
    ∀ {entries : List InventoryPostedTransferEntry} {rejection : OwnershipRejection},
      transferCheckLoop context sourceCoordinate firstDest entries = some rejection →
      rejection = transferCoordinateRejection ∨ rejection = transferDestinationRejection
  | [], _, h => by simp [transferCheckLoop] at h
  | entry :: rest, rejection, h => by
    unfold transferCheckLoop at h
    split at h
    · cases h; exact Or.inl rfl
    split at h
    · cases h; exact Or.inr rfl
    exact transferCheckLoop_some h

/-- The paths of the two posting steps of a transfer. -/
def postingPaths : List String :=
  ["inventoryOwnership.posting", "inventoryOwnership.journalSource",
    "inventoryOwnership.postingAttribution"]

/-- The source posting step of a transfer rejects only for its posting. -/
theorem transferSourcePosting_fromPaths {context : InventoryPostedTransferGroupContext}
    {sourceCoordinate : InventoryPostedCoordinate} {link : Option InventoryPostedJournalLink}
    {total quantity basis : ExactRational} {rejection : OwnershipRejection}
    (h : transferSourcePosting context sourceCoordinate link total quantity basis =
      .ok (.rejected rejection)) : rejection.FromPaths postingPaths := by
  unfold transferSourcePosting at h
  split at h
  · split at h
    · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
    · cases h
  · split at h
    · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
    · split at h
      · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
      · split at h
        · split at h
          · cases h
          · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
          · split at h
            · cases h
            · cases h
        · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩

/-- The destination posting step of a transfer rejects only for its posting. -/
theorem transferDestinationPosting_fromPaths {context : InventoryPostedTransferGroupContext}
    {sourceCoordinate : InventoryPostedCoordinate} {firstDest : LotHolding}
    {link : Option InventoryPostedJournalLink} {total quantity basis : ExactRational}
    {rejection : OwnershipRejection}
    (h : transferDestinationPosting context sourceCoordinate firstDest link total quantity basis =
      .ok (.rejected rejection)) : rejection.FromPaths postingPaths := by
  unfold transferDestinationPosting at h
  dsimp only at h
  split at h
  · split at h
    · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
    · cases h
  · split at h
    · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
    · split at h
      · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
      · split at h
        · split at h
          · cases h
          · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩
          · split at h
            · cases h
            · cases h
        · cases h; exact Or.inr ⟨_, by simp [postingPaths], _, rfl⟩

/-- The paths of what follows the three tests of a transfer group. -/
def transferRestPaths : List String :=
  "inventoryOwnership.groupCoordinate" :: "inventoryOwnership.transferDestination" ::
    reductionPaths ++ postingPaths

/-- After its three tests, a transfer group is rejected only for a source coordinate, a
destination, a source reduction or a posting, or by the arithmetic of its shares and posted
components. -/
theorem transfer_rest_fromPaths {context : InventoryPostedTransferGroupContext}
    {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    {rejection : OwnershipRejection} (hE : ∀ entry ∈ entries, entry.WF)
    (hpop : transferPopulationInvalid entries sourceJournalLink destinationJournalLink = false)
    (hsrc : transferSourcesExceeded 0 entries = false)
    (hid : transferIdentityInvalid context entries = false)
    (h : prepareInventoryPostedTransferGroup context entries sourceJournalLink
      destinationJournalLink = .ok (.rejected rejection)) :
    rejection.FromPaths transferRestPaths := by
  have hperm := sortByText_perm (·.source.holding.id.value) entries
  have hEo : ∀ entry ∈ sortByText (·.source.holding.id.value) entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  have hsub : ∀ {paths : List String}, (∀ p ∈ paths, p ∈ transferRestPaths) →
      rejection.FromPaths paths → rejection.FromPaths transferRestPaths :=
    fun hp hr => FromPaths.mono hr hp
  unfold prepareInventoryPostedTransferGroup at h
  simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte] at h
  split at h
  · rename_i r hr
    cases h
    rcases transferCheckLoop_some hr with rfl | rfl
    · exact Or.inr ⟨_, by simp [transferRestPaths], _, rfl⟩
    · exact Or.inr ⟨_, by simp [transferRestPaths], _, rfl⟩
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    exact hsub (fun p hp => by simp only [transferRestPaths, List.cons_append, List.mem_cons,
      List.mem_append] at hp ⊢; tauto) (transferReductionLoop_fromPaths hEo hr)
  rename_i reductions total totalQuantity totalBasis hloop
  rw [ofQuantize_eq_ok_iff] at hloop
  obtain ⟨hprep, -⟩ := transferReductionLoop_proceed ExactRational.zero_wf ExactRational.zero_wf
    ExactRational.zero_wf hEo hloop
  split at h
  · cases h
  · rename_i r hr
    cases h
    exact hsub (fun p hp => by simp only [transferRestPaths, List.cons_append, List.mem_cons,
      List.mem_append] at hp ⊢; tauto) (transferSourcePosting_fromPaths hr)
  split at h
  · cases h
  · rename_i r hr
    cases h
    exact hsub (fun p hp => by simp only [transferRestPaths, List.cons_append, List.mem_cons,
      List.mem_append] at hp ⊢; tauto) (transferDestinationPosting_fromPaths hr)
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    exact Or.inl (transferConstruction_rejected (hprep.consumed_wf hEo) hr)
  split at h
  · cases h
  · cases h

end InventoryOwnership


open InventoryOwnership in
/-- A transfer group is rejected for its populations exactly when it has no entry, more entries
than the bound, or a source or destination journal with more postings than the bound
(lines 584 to 586). -/
theorem prepareInventoryPostedTransferGroup_population_iff
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    (hE : ∀ entry ∈ entries, entry.WF) :
    prepareInventoryPostedTransferGroup context entries sourceJournalLink destinationJournalLink = .ok (.rejected transferPopulationRejection) ↔ transferPopulationInvalid entries sourceJournalLink destinationJournalLink = true := by
  constructor
  · intro h
    by_contra hpop
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : transferSourcesExceeded 0 entries = true
    · unfold prepareInventoryPostedTransferGroup at h
      simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedTransferGroupResult.rejected.injEq] at h
      exact reject_ne_of_message (by decide) h
    simp only [Bool.not_eq_true] at hsrc
    by_cases hid : transferIdentityInvalid context entries = true
    · unfold prepareInventoryPostedTransferGroup at h
      simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedTransferGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (transfer_rest_fromPaths hE hpop hsrc hid h) (by decide) rfl
  · intro h
    unfold prepareInventoryPostedTransferGroup
    simp only [h, ↓reduceIte]

open InventoryOwnership in
/-- A transfer group is rejected for its combined sources exactly when its populations fit and the
source anchors' sources and the entries' evidence, all counted, are more than the bound
(lines 589 to 593). -/
theorem prepareInventoryPostedTransferGroup_sources_iff
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    (hE : ∀ entry ∈ entries, entry.WF) :
    prepareInventoryPostedTransferGroup context entries sourceJournalLink destinationJournalLink = .ok (.rejected transferSourcesRejection) ↔
      transferPopulationInvalid entries sourceJournalLink destinationJournalLink = false ∧ (entries.map transferSourceCount).sum > cap := by
  constructor
  · intro h
    by_cases hpop : transferPopulationInvalid entries sourceJournalLink destinationJournalLink = true
    · unfold prepareInventoryPostedTransferGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq, InventoryPostedTransferGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_message (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : transferSourcesExceeded 0 entries = true
    · refine ⟨hpop, ?_⟩
      have := ((transferSourcesExceeded_iff 0 entries).mp hsrc).2
      omega
    simp only [Bool.not_eq_true] at hsrc
    exfalso
    by_cases hid : transferIdentityInvalid context entries = true
    · unfold prepareInventoryPostedTransferGroup at h
      simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedTransferGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (transfer_rest_fromPaths hE hpop hsrc hid h) (by decide) rfl
  · rintro ⟨hpop, hsum⟩
    have hsrc : transferSourcesExceeded 0 entries = true := by
      rw [transferSourcesExceeded_iff]
      refine ⟨?_, by omega⟩
      rintro rfl
      simp at hsum
    unfold prepareInventoryPostedTransferGroup
    simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte]

open InventoryOwnership in
/-- A transfer group is rejected for its identities exactly when its populations and sources fit
and its origin, destination policies or dimensions are not as required or a source holding,
destination holding, lot, anchor, movement or allocation repeats (lines 594 to 603). -/
theorem prepareInventoryPostedTransferGroup_identity_iff
    {context : InventoryPostedTransferGroupContext} {entries : List InventoryPostedTransferEntry}
    {sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink}
    (hE : ∀ entry ∈ entries, entry.WF) :
    prepareInventoryPostedTransferGroup context entries sourceJournalLink destinationJournalLink = .ok (.rejected transferIdentityRejection) ↔
      transferPopulationInvalid entries sourceJournalLink destinationJournalLink = false ∧ transferSourcesExceeded 0 entries = false ∧ transferIdentityInvalid context entries = true := by
  constructor
  · intro h
    by_cases hpop : transferPopulationInvalid entries sourceJournalLink destinationJournalLink = true
    · unfold prepareInventoryPostedTransferGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq, InventoryPostedTransferGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : transferSourcesExceeded 0 entries = true
    · unfold prepareInventoryPostedTransferGroup at h
      simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedTransferGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hsrc
    by_cases hid : transferIdentityInvalid context entries = true
    · exact ⟨hpop, hsrc, hid⟩
    simp only [Bool.not_eq_true] at hid
    exact absurd h (fun h' => fromPaths_ne_reject (transfer_rest_fromPaths hE hpop hsrc hid h')
      (by decide) rfl)
  · rintro ⟨hpop, hsrc, hid⟩
    unfold prepareInventoryPostedTransferGroup
    simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte]

end Rastrata.Kernel

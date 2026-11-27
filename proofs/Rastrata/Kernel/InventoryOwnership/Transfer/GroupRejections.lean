/-
The rejections of the four group functions before their loops, one `iff` a diagnostic, over the
model's own tests in the order of the TypeScript: the populations (lines 364, 468, 584 and 806), the
combined work bounds (lines 367, 471, 589 and 809), each loop's stopping test being exactly that the
whole count is over the bound (`…Exceeded_iff`), and the identities (lines 372, 476, 594 and 814).
What follows the three tests never produces one of their diagnostics: its rejections are its own
(listed by path in `…RestPaths`) or pass through from the arithmetic (`OwnershipRejection.Inner`).
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.Adoption

namespace Rastrata.Kernel

namespace InventoryOwnership

/-! ## Work bounds: a loop that stops at the first running count over the bound stops exactly when
the whole count is over it -/

/-- The source loop of a reduction group rejects exactly when the anchors' sources, all counted, are
more than the bound. -/
theorem reductionGroupSourcesExceeded_iff :
    ∀ (work : Nat) (entries : List InventoryPostedReductionEntry),
      reductionGroupSourcesExceeded work entries = true ↔
        entries ≠ [] ∧ work + (entries.map (anchorSourceCount ·.anchor)).sum > cap
  | work, [] => by simp [reductionGroupSourcesExceeded]
  | work, entry :: rest => by
    rw [reductionGroupSourcesExceeded, Bool.or_eq_true, decide_eq_true_eq,
      reductionGroupSourcesExceeded_iff]
    simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and, List.map_cons, List.sum_cons]
    constructor
    · rintro (h | ⟨-, h⟩) <;> omega
    · intro h
      by_cases h' : work + anchorSourceCount entry.anchor > cap
      · exact Or.inl h'
      · right
        refine ⟨?_, by omega⟩
        intro hnil
        subst hnil
        simp at h
        omega

/-- The evidence loop of an acquisition group rejects exactly when the evidence and lot evidence
identifiers, all counted, are more than the bound. -/
theorem acquisitionEvidenceExceeded_iff :
    ∀ (work : Nat) (entries : List InventoryPostedAcquisitionEntry),
      acquisitionEvidenceExceeded work entries = true ↔
        entries ≠ [] ∧
          work + (entries.map fun e => e.evidence.length + e.lot.evidenceIds.length).sum > cap
  | work, [] => by simp [acquisitionEvidenceExceeded]
  | work, entry :: rest => by
    rw [acquisitionEvidenceExceeded, Bool.or_eq_true, decide_eq_true_eq,
      acquisitionEvidenceExceeded_iff]
    simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and, List.map_cons, List.sum_cons]
    constructor
    · rintro (h | ⟨-, h⟩) <;> omega
    · intro h
      by_cases h' : work + (entry.evidence.length + entry.lot.evidenceIds.length) > cap
      · exact Or.inl h'
      · right
        refine ⟨?_, by omega⟩
        intro hnil
        subst hnil
        simp at h
        omega

/-- The source loop of a transfer group rejects exactly when the source anchors' sources and the
entries' evidence, all counted, are more than the bound. -/
theorem transferSourcesExceeded_iff :
    ∀ (work : Nat) (entries : List InventoryPostedTransferEntry),
      transferSourcesExceeded work entries = true ↔
        entries ≠ [] ∧ work + (entries.map transferSourceCount).sum > cap
  | work, [] => by simp [transferSourcesExceeded]
  | work, entry :: rest => by
    rw [transferSourcesExceeded, Bool.or_eq_true, decide_eq_true_eq, transferSourcesExceeded_iff]
    simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and, List.map_cons, List.sum_cons]
    constructor
    · rintro (h | ⟨-, h⟩) <;> omega
    · intro h
      by_cases h' : work + transferSourceCount entry > cap
      · exact Or.inl h'
      · right
        refine ⟨?_, by omega⟩
        intro hnil
        subst hnil
        simp at h
        omega

/-- The evidence loop of an adoption group rejects exactly when the evidence and historical
postings, all counted, are more than the bound. -/
theorem adoptionEvidenceExceeded_iff :
    ∀ (work : Nat) (entries : List InventoryPostedAdoptionEntry),
      adoptionEvidenceExceeded work entries = true ↔
        entries ≠ [] ∧
          work + (entries.map fun e => e.evidence.length + e.historicalPostings.length).sum > cap
  | work, [] => by simp [adoptionEvidenceExceeded]
  | work, entry :: rest => by
    rw [adoptionEvidenceExceeded, Bool.or_eq_true, decide_eq_true_eq,
      adoptionEvidenceExceeded_iff]
    simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and, List.map_cons, List.sum_cons]
    constructor
    · rintro (h | ⟨-, h⟩) <;> omega
    · intro h
      by_cases h' : work + (entry.evidence.length + entry.historicalPostings.length) > cap
      · exact Or.inl h'
      · right
        refine ⟨?_, by omega⟩
        intro hnil
        subst hnil
        simp at h
        omega

end InventoryOwnership


/-! ## Where a rejection comes from -/

/-- A rejection passed through from the arithmetic, or one of this module's with one of these
paths. -/
def OwnershipRejection.FromPaths (paths : List String) (rejection : OwnershipRejection) : Prop :=
  rejection.Inner ∨ ∃ path ∈ paths, ∃ message, rejection = InventoryOwnership.reject path message

namespace InventoryOwnership

/-- A rejection from some paths is no rejection of this module with another path. -/
theorem fromPaths_ne_reject {paths : List String} {rejection : OwnershipRejection}
    (h : rejection.FromPaths paths) {path message : String} (hp : path ∉ paths) :
    rejection ≠ reject path message := by
  rcases h with h | ⟨p, hp', m, rfl⟩
  · exact inner_ne_reject h path message
  · exact reject_ne_of_path (fun he => hp (he ▸ hp'))

/-- A rejection from some paths is from any longer list of paths. -/
theorem FromPaths.mono {paths paths' : List String} {rejection : OwnershipRejection}
    (h : rejection.FromPaths paths) (hsub : ∀ p ∈ paths, p ∈ paths') :
    rejection.FromPaths paths' := by
  rcases h with h | ⟨p, hp, m, rfl⟩
  · exact Or.inl h
  · exact Or.inr ⟨p, hsub p hp, m, rfl⟩

/-- The paths of the rejections of `prepareInventoryPostedReduction`. -/
def reductionPaths : List String :=
  ["inventoryOwnership.anchor", "inventoryOwnership.hash", "inventoryOwnership.lineage",
    "inventoryOwnership.sources", "inventoryOwnership.coordinate", "inventoryOwnership.quantity",
    "inventoryOwnership.consumedPosted", "inventoryOwnership.allocation",
    "inventoryOwnership.postedValue"]

/-- A rejected reduction is rejected by one of its own tests or by the arithmetic it calls. -/
theorem prepareInventoryPostedReduction_fromPaths {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {rejection : OwnershipRejection} (hA : anchor.WF)
    (hP : position.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.rejected rejection)) : rejection.FromPaths reductionPaths := by
  unfold prepareInventoryPostedReduction at h
  split at h
  · cases h; exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  split at h
  · cases h; exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  split at h
  · cases h; exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  split at h
  · cases h; exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  split at h
  · cases h; exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  split at h
  · cases h
  · cases h; exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  rcases reductionPlanned_rejected hA hP hL h with rfl | rfl | rfl | h'
  · exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  · exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  · exact Or.inr ⟨_, by simp [reductionPaths], _, rfl⟩
  · exact Or.inl h'

/-- The loop of a reduction group rejects for a coordinate or with a reduction's rejection. -/
theorem reductionGroupLoop_fromPaths {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} :
    ∀ {entries : List InventoryPostedReductionEntry} {index : Nat}
      {posted quantity basis : ExactRational} {rejection : OwnershipRejection},
      (∀ entry ∈ entries, entry.WF) →
      reductionGroupLoop context coordinate index posted quantity basis entries =
        .ok (.rejected rejection) →
      rejection.FromPaths ("inventoryOwnership.groupCoordinate" :: reductionPaths)
  | [], _, _, _, _, _, _, h => by simp [reductionGroupLoop] at h
  | entry :: rest, index, posted, quantity, basis, rejection, hE, h => by
    have hW := hE entry (by simp)
    unfold reductionGroupLoop at h
    split at h
    · cases h; exact Or.inr ⟨_, by simp, _, rfl⟩
    split at h
    · cases h
    · rename_i r hr
      cases h
      exact FromPaths.mono (prepareInventoryPostedReduction_fromPaths hW.anchor hW.position
        hW.allocation hr) (fun p hp => List.mem_cons_of_mem _ hp)
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
      exact reductionGroupLoop_fromPaths (fun e he => hE e (List.mem_cons_of_mem _ he))
        (by assumption)
    · cases h

/-- The posting step of a reduction group rejects only for its posting. -/
theorem reductionGroupPosting_fromPaths {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {journalLink : Option InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} {rejection : OwnershipRejection}
    (h : reductionGroupPosting context coordinate journalLink postedAmount quantity
      historicalBasis = .ok (.rejected rejection)) :
    rejection.FromPaths ["inventoryOwnership.posting", "inventoryOwnership.journalSource",
      "inventoryOwnership.postingAttribution"] := by
  unfold reductionGroupPosting at h
  split at h
  · split at h
    · cases h; exact Or.inr ⟨_, by simp, _, rfl⟩
    · cases h
  · split at h
    · cases h; exact Or.inr ⟨_, by simp, _, rfl⟩
    · split at h
      · cases h; exact Or.inr ⟨_, by simp, _, rfl⟩
      · split at h
        · split at h
          · cases h
          · cases h; exact Or.inr ⟨_, by simp, _, rfl⟩
          · split at h
            · cases h
            · cases h
        · cases h; exact Or.inr ⟨_, by simp, _, rfl⟩

end InventoryOwnership


namespace InventoryOwnership

/-- The paths of what follows the three tests of a reduction group. -/
def reductionGroupRestPaths : List String :=
  "inventoryOwnership.groupCoordinate" :: reductionPaths ++
    ["inventoryOwnership.posting", "inventoryOwnership.journalSource",
      "inventoryOwnership.postingAttribution"]

/-- After its three tests, a reduction group is rejected only for a coordinate, by a reduction, or
for its posting. -/
theorem reductionGroup_rest_fromPaths {context : InventoryPostedReductionGroupContext}
    {entries : List InventoryPostedReductionEntry} {journalLink : Option InventoryPostedJournalLink}
    {rejection : OwnershipRejection} (hE : ∀ entry ∈ entries, entry.WF)
    (hpop : reductionGroupPopulationInvalid entries journalLink = false)
    (hsrc : reductionGroupSourcesExceeded 0 entries = false)
    (hid : reductionGroupIdentityInvalid context entries = false)
    (h : prepareInventoryPostedReductionGroup context entries journalLink =
      .ok (.rejected rejection)) : rejection.FromPaths reductionGroupRestPaths := by
  unfold prepareInventoryPostedReductionGroup at h
  simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte] at h
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    have hperm := sortByText_perm (·.holding.id.value) entries
    exact FromPaths.mono (reductionGroupLoop_fromPaths (fun e he => hE e (hperm.subset he)) hr)
      (fun p hp => by simp only [reductionGroupRestPaths, List.cons_append, List.mem_cons,
        List.mem_append] at hp ⊢; tauto)
  split at h
  · cases h
  · rename_i r hr
    cases h
    exact FromPaths.mono (reductionGroupPosting_fromPaths hr)
      (fun p hp => by simp only [reductionGroupRestPaths, List.cons_append, List.mem_cons,
        List.mem_append] at hp ⊢; tauto)
  · cases h

end InventoryOwnership

open InventoryOwnership in
/-- A reduction group is rejected for its populations exactly when it has no entry, more entries
than the bound, or a journal source with more postings than the bound (line 468). -/
theorem prepareInventoryPostedReductionGroup_population_iff
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} (hE : ∀ entry ∈ entries, entry.WF) :
    prepareInventoryPostedReductionGroup context entries journalLink =
        .ok (.rejected reductionGroupPopulationRejection) ↔
      reductionGroupPopulationInvalid entries journalLink = true := by
  constructor
  · intro h
    by_contra hpop
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : reductionGroupSourcesExceeded 0 entries = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      exact reject_ne_of_message (by decide) h
    simp only [Bool.not_eq_true] at hsrc
    by_cases hid : reductionGroupIdentityInvalid context entries = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (reductionGroup_rest_fromPaths hE hpop hsrc hid h)
      (by decide) rfl
  · intro h
    unfold prepareInventoryPostedReductionGroup
    simp only [h, ↓reduceIte]

open InventoryOwnership in
/-- A reduction group is rejected for its combined sources exactly when its populations fit and the
anchors' sources, all counted, are more than the bound (lines 471 to 475). -/
theorem prepareInventoryPostedReductionGroup_sources_iff
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} (hE : ∀ entry ∈ entries, entry.WF) :
    prepareInventoryPostedReductionGroup context entries journalLink =
        .ok (.rejected reductionGroupSourcesRejection) ↔
      reductionGroupPopulationInvalid entries journalLink = false ∧
        (entries.map (anchorSourceCount ·.anchor)).sum > cap := by
  constructor
  · intro h
    by_cases hpop : reductionGroupPopulationInvalid entries journalLink = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_message (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : reductionGroupSourcesExceeded 0 entries = true
    · refine ⟨hpop, ?_⟩
      have := ((reductionGroupSourcesExceeded_iff 0 entries).mp hsrc).2
      omega
    simp only [Bool.not_eq_true] at hsrc
    exfalso
    by_cases hid : reductionGroupIdentityInvalid context entries = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (reductionGroup_rest_fromPaths hE hpop hsrc hid h)
      (by decide) rfl
  · rintro ⟨hpop, hsum⟩
    have hsrc : reductionGroupSourcesExceeded 0 entries = true := by
      rw [reductionGroupSourcesExceeded_iff]
      refine ⟨?_, by omega⟩
      rintro rfl
      simp at hsum
    unfold prepareInventoryPostedReductionGroup
    simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte]

open InventoryOwnership in
/-- A reduction group is rejected for its identities exactly when its populations and sources fit
and its origin is not committed or its holdings, anchors, allocations or movements repeat
(lines 476 to 480). -/
theorem prepareInventoryPostedReductionGroup_identity_iff
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} (hE : ∀ entry ∈ entries, entry.WF) :
    prepareInventoryPostedReductionGroup context entries journalLink =
        .ok (.rejected reductionGroupIdentityRejection) ↔
      reductionGroupPopulationInvalid entries journalLink = false ∧
        reductionGroupSourcesExceeded 0 entries = false ∧
        reductionGroupIdentityInvalid context entries = true := by
  constructor
  · intro h
    by_cases hpop : reductionGroupPopulationInvalid entries journalLink = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : reductionGroupSourcesExceeded 0 entries = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hsrc
    by_cases hid : reductionGroupIdentityInvalid context entries = true
    · exact ⟨hpop, hsrc, hid⟩
    simp only [Bool.not_eq_true] at hid
    exact absurd h (fun h' => fromPaths_ne_reject (reductionGroup_rest_fromPaths hE hpop hsrc hid h')
      (by decide) rfl)
  · rintro ⟨hpop, hsrc, hid⟩
    unfold prepareInventoryPostedReductionGroup
    simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte]


namespace InventoryOwnership

/-- The source loop of an acquisition rejects only for a source. -/
theorem acquisitionSourceLoop_rejected {context : InventoryPostedAcquisitionContext}
    {first : LotHolding} :
    ∀ {entries : List InventoryPostedAcquisitionEntry} {quantity basis carrying : ExactRational}
      {rejection : OwnershipRejection},
      acquisitionSourceLoop context first quantity basis carrying entries =
        .ok (.rejected rejection) → rejection = acquisitionSourceRejection
  | [], _, _, _, _, h => by simp [acquisitionSourceLoop] at h
  | entry :: rest, quantity, basis, carrying, rejection, h => by
    unfold acquisitionSourceLoop at h
    split at h
    · cases h
    · cases h; rfl
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    exact acquisitionSourceLoop_rejected h

/-- The construction loop of an acquisition rejects only with a share's rejection. -/
theorem acquisitionConstruction_rejected {context : InventoryPostedAcquisitionContext}
    {posted : ExactDecimal} {posting : Option CanonicalPostingReference} {carryingZero : Bool}
    {denominator : ExactRational} {count : Nat} :
    ∀ {entries : List InventoryPostedAcquisitionEntry} {index : Nat} {cumulative : ExactRational}
      {rejection : OwnershipRejection},
      acquisitionConstruction context posted posting carryingZero denominator count index
        cumulative entries = .ok (.rejected rejection) → rejection.Inner
  | [], _, _, _, h => by simp [acquisitionConstruction] at h
  | entry :: rest, index, cumulative, rejection, h => by
    unfold acquisitionConstruction at h
    dsimp only at h
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    · rename_i d hd
      cases h
      exact share_rejection_inner hd
    split at h
    · cases h
    split at h
    · cases h
    · cases h
      exact acquisitionConstruction_rejected (by assumption)
    · cases h

/-- The paths of what follows the three tests of an acquisition group. -/
def acquisitionRestPaths : List String :=
  ["inventoryOwnership.acquisitionSource", "inventoryOwnership.acquisitionPosting",
    "inventoryOwnership.acquisitionJournal"]

/-- After its three tests, an acquisition group is rejected only for a source or its posting, or by
the arithmetic of its shares. -/
theorem acquisition_rest_fromPaths {context : InventoryPostedAcquisitionContext}
    {entries : List InventoryPostedAcquisitionEntry} {journalLink : Option InventoryPostedJournalLink}
    {rejection : OwnershipRejection}
    (hpop : acquisitionPopulationInvalid context entries journalLink = false)
    (hev : acquisitionEvidenceExceeded 0 entries = false)
    (hid : acquisitionIdentityInvalid context entries = false)
    (h : prepareInventoryPostedAcquisitionGroup context entries journalLink =
      .ok (.rejected rejection)) : rejection.FromPaths acquisitionRestPaths := by
  unfold prepareInventoryPostedAcquisitionGroup at h
  simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte] at h
  split at h
  · cases h
  split at h
  · cases h
  · rename_i d hd
    cases h
    rw [ofQuantize_eq_ok_iff] at hd
    exact Or.inl (share_rejection_inner hd)
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    rw [acquisitionSourceLoop_rejected hr]
    exact Or.inr ⟨_, by simp [acquisitionRestPaths], _, rfl⟩
  split at h
  · cases h
  · rename_i r hr
    cases h
    unfold acquisitionPosting at hr
    dsimp only at hr
    split at hr
    · cases hr
    split at hr
    · split at hr
      · cases hr
      · split at hr
        · cases hr; exact Or.inr ⟨_, by simp [acquisitionRestPaths], _, rfl⟩
        · cases hr
    · split at hr
      · cases hr; exact Or.inr ⟨_, by simp [acquisitionRestPaths], _, rfl⟩
      · split at hr
        · split at hr
          · cases hr
          · cases hr; exact Or.inr ⟨_, by simp [acquisitionRestPaths], _, rfl⟩
          · split at hr
            · cases hr
            · cases hr
        · cases hr; exact Or.inr ⟨_, by simp [acquisitionRestPaths], _, rfl⟩
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    exact Or.inl (acquisitionConstruction_rejected hr)
  · cases h

end InventoryOwnership


open InventoryOwnership in
/-- An acquisition group is rejected for its populations exactly when it has no entry, more entries, dimensions or journal postings than the bound (line 364). -/
theorem prepareInventoryPostedAcquisitionGroup_population_iff
    {context : InventoryPostedAcquisitionContext} {entries : List InventoryPostedAcquisitionEntry}
    {journalLink : Option InventoryPostedJournalLink} :
    prepareInventoryPostedAcquisitionGroup context entries journalLink =
        .ok (.rejected acquisitionPopulationRejection) ↔
      acquisitionPopulationInvalid context entries journalLink = true := by
  constructor
  · intro h
    by_contra hpop
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : acquisitionEvidenceExceeded 0 entries = true
    · unfold prepareInventoryPostedAcquisitionGroup at h
      simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAcquisitionGroupResult.rejected.injEq] at h
      exact reject_ne_of_message (by decide) h
    simp only [Bool.not_eq_true] at hev
    by_cases hid : acquisitionIdentityInvalid context entries = true
    · unfold prepareInventoryPostedAcquisitionGroup at h
      simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAcquisitionGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (acquisition_rest_fromPaths hpop hev hid h) (by decide) rfl
  · intro h
    unfold prepareInventoryPostedAcquisitionGroup
    simp only [h, ↓reduceIte]

open InventoryOwnership in
/-- An acquisition group is rejected for its evidence exactly when its populations fit and the evidence and lot evidence identifiers, all counted, are more than the bound (lines 367 to 371). -/
theorem prepareInventoryPostedAcquisitionGroup_evidence_iff
    {context : InventoryPostedAcquisitionContext} {entries : List InventoryPostedAcquisitionEntry}
    {journalLink : Option InventoryPostedJournalLink} :
    prepareInventoryPostedAcquisitionGroup context entries journalLink =
        .ok (.rejected acquisitionEvidenceRejection) ↔
      acquisitionPopulationInvalid context entries journalLink = false ∧ (entries.map fun e => e.evidence.length + e.lot.evidenceIds.length).sum > cap := by
  constructor
  · intro h
    by_cases hpop : acquisitionPopulationInvalid context entries journalLink = true
    · unfold prepareInventoryPostedAcquisitionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq, InventoryPostedAcquisitionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_message (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : acquisitionEvidenceExceeded 0 entries = true
    · refine ⟨hpop, ?_⟩
      have := ((acquisitionEvidenceExceeded_iff) 0 entries).mp hev
      omega
    simp only [Bool.not_eq_true] at hev
    exfalso
    by_cases hid : acquisitionIdentityInvalid context entries = true
    · unfold prepareInventoryPostedAcquisitionGroup at h
      simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAcquisitionGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (acquisition_rest_fromPaths hpop hev hid h) (by decide) rfl
  · rintro ⟨hpop, hsum⟩
    have hev : acquisitionEvidenceExceeded 0 entries = true := by
      rw [acquisitionEvidenceExceeded_iff]
      refine ⟨?_, by omega⟩
      rintro rfl
      simp at hsum
    unfold prepareInventoryPostedAcquisitionGroup
    simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte]

open InventoryOwnership in
/-- An acquisition group is rejected for its identities exactly when its populations and evidence fit and its origin, policy, holding, lot, anchor or movement identities, or its dimensions, are not as required (lines 372 to 377). -/
theorem prepareInventoryPostedAcquisitionGroup_identity_iff
    {context : InventoryPostedAcquisitionContext} {entries : List InventoryPostedAcquisitionEntry}
    {journalLink : Option InventoryPostedJournalLink} :
    prepareInventoryPostedAcquisitionGroup context entries journalLink =
        .ok (.rejected acquisitionIdentityRejection) ↔
      acquisitionPopulationInvalid context entries journalLink = false ∧ acquisitionEvidenceExceeded 0 entries = false ∧ acquisitionIdentityInvalid context entries = true := by
  constructor
  · intro h
    by_cases hpop : acquisitionPopulationInvalid context entries journalLink = true
    · unfold prepareInventoryPostedAcquisitionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq, InventoryPostedAcquisitionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : acquisitionEvidenceExceeded 0 entries = true
    · unfold prepareInventoryPostedAcquisitionGroup at h
      simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAcquisitionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hev
    by_cases hid : acquisitionIdentityInvalid context entries = true
    · exact ⟨hpop, hev, hid⟩
    simp only [Bool.not_eq_true] at hid
    exact absurd h (fun h' => fromPaths_ne_reject (acquisition_rest_fromPaths hpop hev hid h') (by decide) rfl)
  · rintro ⟨hpop, hev, hid⟩
    unfold prepareInventoryPostedAcquisitionGroup
    simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte]

namespace InventoryOwnership

/-- The source loop of an adoption rejects only for a source. -/
theorem adoptionSourceLoop_rejected {context : InventoryPostedAdoptionContext}
    {first : LotHolding} :
    ∀ {entries : List InventoryPostedAdoptionEntry} {quantity carrying : ExactRational}
      {rejection : OwnershipRejection},
      adoptionSourceLoop context first quantity carrying entries = .ok (.rejected rejection) →
        rejection = adoptionSourceRejection
  | [], _, _, _, h => by simp [adoptionSourceLoop] at h
  | entry :: rest, quantity, carrying, rejection, h => by
    unfold adoptionSourceLoop at h
    split at h
    · cases h
    · cases h; rfl
    split at h
    · cases h
    split at h
    · cases h
    exact adoptionSourceLoop_rejected h

/-- The construction loop of an adoption rejects only with a share's rejection. -/
theorem adoptionConstruction_rejected {context : InventoryPostedAdoptionContext}
    {balance : ExactDecimal} {carryingZero : Bool} {denominator : ExactRational} {count : Nat} :
    ∀ {entries : List InventoryPostedAdoptionEntry} {index : Nat} {cumulative : ExactRational}
      {rejection : OwnershipRejection},
      adoptionConstruction context balance carryingZero denominator count index cumulative
        entries = .ok (.rejected rejection) → rejection.Inner
  | [], _, _, _, h => by simp [adoptionConstruction] at h
  | entry :: rest, index, cumulative, rejection, h => by
    unfold adoptionConstruction at h
    dsimp only at h
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    · rename_i d hd
      cases h
      exact share_rejection_inner hd
    split at h
    · cases h
    split at h
    · cases h
    split at h
    · cases h
    · rename_i d hd
      cases h
      exact share_rejection_inner hd
    split at h
    · cases h
    split at h
    · cases h
    · cases h
      exact adoptionConstruction_rejected (by assumption)
    · cases h

/-- The paths of what follows the three tests of an adoption group. -/
def adoptionRestPaths : List String :=
  ["inventoryOwnership.adoptionSource", "inventoryOwnership.adoptionBalance"]

/-- After its three tests, an adoption group is rejected only for a source or its balance, or by
the arithmetic of its shares. -/
theorem adoption_rest_fromPaths {context : InventoryPostedAdoptionContext}
    {entries : List InventoryPostedAdoptionEntry} {postedBalance : ExactRational}
    {rejection : OwnershipRejection}
    (hpop : adoptionPopulationInvalid context entries = false)
    (hev : adoptionEvidenceExceeded 0 entries = false)
    (hid : adoptionIdentityInvalid context entries = false)
    (h : prepareInventoryPostedAdoptionGroup context entries postedBalance =
      .ok (.rejected rejection)) : rejection.FromPaths adoptionRestPaths := by
  unfold prepareInventoryPostedAdoptionGroup at h
  simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte] at h
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    rw [adoptionSourceLoop_rejected hr]
    exact Or.inr ⟨_, by simp [adoptionRestPaths], _, rfl⟩
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h; exact Or.inr ⟨_, by simp [adoptionRestPaths], _, rfl⟩
  split at h
  · cases h
  · rename_i r hr
    cases h
    rw [ofQuantize_eq_ok_iff] at hr
    exact Or.inl (adoptionConstruction_rejected hr)
  · cases h

end InventoryOwnership

open InventoryOwnership in
/-- An adoption group is rejected for its populations exactly when it has no entry, or more entries or dimensions than the bound (line 806). -/
theorem prepareInventoryPostedAdoptionGroup_population_iff
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance : ExactRational} :
    prepareInventoryPostedAdoptionGroup context entries postedBalance =
        .ok (.rejected adoptionPopulationRejection) ↔
      adoptionPopulationInvalid context entries = true := by
  constructor
  · intro h
    by_contra hpop
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : adoptionEvidenceExceeded 0 entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact reject_ne_of_message (by decide) h
    simp only [Bool.not_eq_true] at hev
    by_cases hid : adoptionIdentityInvalid context entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (adoption_rest_fromPaths hpop hev hid h) (by decide) rfl
  · intro h
    unfold prepareInventoryPostedAdoptionGroup
    simp only [h, ↓reduceIte]

open InventoryOwnership in
/-- An adoption group is rejected for its evidence exactly when its populations fit and the evidence and historical postings, all counted, are more than the bound (lines 809 to 813). -/
theorem prepareInventoryPostedAdoptionGroup_evidence_iff
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance : ExactRational} :
    prepareInventoryPostedAdoptionGroup context entries postedBalance =
        .ok (.rejected adoptionEvidenceRejection) ↔
      adoptionPopulationInvalid context entries = false ∧ (entries.map fun e => e.evidence.length + e.historicalPostings.length).sum > cap := by
  constructor
  · intro h
    by_cases hpop : adoptionPopulationInvalid context entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq, InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_message (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : adoptionEvidenceExceeded 0 entries = true
    · refine ⟨hpop, ?_⟩
      have := ((adoptionEvidenceExceeded_iff) 0 entries).mp hev
      omega
    simp only [Bool.not_eq_true] at hev
    exfalso
    by_cases hid : adoptionIdentityInvalid context entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact reject_ne_of_path (by decide) h
    simp only [Bool.not_eq_true] at hid
    exact fromPaths_ne_reject (adoption_rest_fromPaths hpop hev hid h) (by decide) rfl
  · rintro ⟨hpop, hsum⟩
    have hev : adoptionEvidenceExceeded 0 entries = true := by
      rw [adoptionEvidenceExceeded_iff]
      refine ⟨?_, by omega⟩
      rintro rfl
      simp at hsum
    unfold prepareInventoryPostedAdoptionGroup
    simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte]

open InventoryOwnership in
/-- An adoption group is rejected for its identities exactly when its populations and evidence fit and its origin, policy, holding, anchor or movement identities, or its dimensions, are not as required (lines 814 to 819). -/
theorem prepareInventoryPostedAdoptionGroup_identity_iff
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance : ExactRational} :
    prepareInventoryPostedAdoptionGroup context entries postedBalance =
        .ok (.rejected adoptionIdentityRejection) ↔
      adoptionPopulationInvalid context entries = false ∧ adoptionEvidenceExceeded 0 entries = false ∧ adoptionIdentityInvalid context entries = true := by
  constructor
  · intro h
    by_cases hpop : adoptionPopulationInvalid context entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq, InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : adoptionEvidenceExceeded 0 entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hev
    by_cases hid : adoptionIdentityInvalid context entries = true
    · exact ⟨hpop, hev, hid⟩
    simp only [Bool.not_eq_true] at hid
    exact absurd h (fun h' => fromPaths_ne_reject (adoption_rest_fromPaths hpop hev hid h') (by decide) rfl)
  · rintro ⟨hpop, hev, hid⟩
    unfold prepareInventoryPostedAdoptionGroup
    simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte]

end Rastrata.Kernel

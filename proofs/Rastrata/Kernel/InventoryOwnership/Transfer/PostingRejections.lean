/-
The rejections of the posting step of `prepareInventoryPostedReductionGroup` (lines 504 to 524),
one `iff` a diagnostic over the step's own tests, and the decomposition of the group's posting
rejections into its tests passing, its loop going through and the step rejecting
(`prepareInventoryPostedReductionGroup_posting_stage`); and the balance rejection of the adoption
group (`prepareInventoryPostedAdoptionGroup_balance_iff`).
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.Findings

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- The posting step of a reduction group rejects an all-zero group exactly when it is linked to a
journal (line 506). -/
theorem reductionGroupPosting_zero_iff {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {journalLink : Option InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} :
    reductionGroupPosting context coordinate journalLink postedAmount quantity historicalBasis =
        .ok (.rejected reductionGroupZeroPostingRejection) ↔
      postedAmount.isZero = true ∧ journalLink.isSome = true := by
  unfold reductionGroupPosting
  by_cases hz : postedAmount.isZero = true
  · cases journalLink <;> simp [hz]
  · simp only [hz, Bool.false_eq_true, ↓reduceIte, false_and, iff_false]
    cases journalLink with
    | none => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
              exact reject_ne_of_message (by decide)
    | some link =>
      simp only
      split
      · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
        exact reject_ne_of_path (by decide)
      · split
        · split
          · simp
          · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
            exact reject_ne_of_path (by decide)
          · split <;> simp
        · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
          exact reject_ne_of_message (by decide)


/-- The posting step of a reduction group rejects a money-bearing group exactly when it has no
journal link (line 508). -/
theorem reductionGroupPosting_missing_iff {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {journalLink : Option InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} :
    reductionGroupPosting context coordinate journalLink postedAmount quantity historicalBasis =
        .ok (.rejected reductionGroupMissingPostingRejection) ↔
      postedAmount.isZero = false ∧ journalLink = none := by
  unfold reductionGroupPosting
  by_cases hz : postedAmount.isZero = true
  · simp only [hz, ↓reduceIte, Bool.true_eq_false, false_and, iff_false]
    cases journalLink with
    | none => simp
    | some _ => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
                exact reject_ne_of_message (by decide)
  · simp only [Bool.not_eq_true] at hz
    simp only [hz, Bool.false_eq_true, ↓reduceIte, true_and]
    cases journalLink with
    | none => simp
    | some link =>
      simp only [reduceCtorEq, iff_false]
      split
      · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
        exact reject_ne_of_path (by decide)
      · split
        · split
          · simp
          · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
            exact reject_ne_of_path (by decide)
          · split <;> simp
        · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
          exact reject_ne_of_message (by decide)

/-- The posting step of a reduction group rejects a money-bearing group for its journal source
exactly when it is linked to a journal that does not match the group's command, book, currency,
revision, period or date, whose effect key is empty or the group's own, or whose hash does not check
(lines 510 to 513). -/
theorem reductionGroupPosting_journalSource_iff {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {journalLink : Option InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} :
    reductionGroupPosting context coordinate journalLink postedAmount quantity historicalBasis =
        .ok (.rejected reductionGroupJournalSourceRejection) ↔
      postedAmount.isZero = false ∧ ∃ link, journalLink = some link ∧
        journalSourceMismatch context.toInventoryReductionEffectContext
          coordinate.functionalCommodityId link.source = true := by
  unfold reductionGroupPosting
  by_cases hz : postedAmount.isZero = true
  · simp only [hz, ↓reduceIte, Bool.true_eq_false, false_and, iff_false]
    cases journalLink with
    | none => simp
    | some _ => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
                exact reject_ne_of_path (by decide)
  · simp only [Bool.not_eq_true] at hz
    simp only [hz, Bool.false_eq_true, ↓reduceIte, true_and]
    cases journalLink with
    | none => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq, reduceCtorEq, false_and,
                exists_false, iff_false]
              exact reject_ne_of_path (by decide)
    | some link =>
      simp only [Option.some.injEq, exists_eq_left']
      split
      · rename_i hm
        simp [hm]
      · rename_i hm
        simp only [Bool.not_eq_true] at hm
        simp only [hm, Bool.false_eq_true, iff_false]
        split
        · split
          · simp
          · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
            exact reject_ne_of_path (by decide)
          · split <;> simp
        · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
          exact reject_ne_of_path (by decide)

/-- The posting step of a reduction group rejects a money-bearing group for its posting count
exactly when its journal matches and does not have exactly one posting of the given identifier
(line 517). -/
theorem reductionGroupPosting_count_iff {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {journalLink : Option InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} :
    reductionGroupPosting context coordinate journalLink postedAmount quantity historicalBasis =
        .ok (.rejected reductionGroupPostingCountRejection) ↔
      postedAmount.isZero = false ∧ ∃ link, journalLink = some link ∧
        journalSourceMismatch context.toInventoryReductionEffectContext
          coordinate.functionalCommodityId link.source = false ∧
        (link.source.journal.postings.filter (fun p => p.id == link.postingId)).length ≠ 1 := by
  unfold reductionGroupPosting
  by_cases hz : postedAmount.isZero = true
  · simp only [hz, ↓reduceIte, Bool.true_eq_false, false_and, iff_false]
    cases journalLink with
    | none => simp
    | some _ => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
                exact reject_ne_of_message (by decide)
  · simp only [Bool.not_eq_true] at hz
    simp only [hz, Bool.false_eq_true, ↓reduceIte, true_and]
    cases journalLink with
    | none => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq, reduceCtorEq, false_and,
                exists_false, iff_false]
              exact reject_ne_of_message (by decide)
    | some link =>
      simp only [Option.some.injEq, exists_eq_left']
      split
      · rename_i hm
        simp only [hm, Bool.true_eq_false, false_and, iff_false, Except.ok.injEq,
          OwnershipStep.rejected.injEq]
        exact reject_ne_of_path (by decide)
      · rename_i hm
        simp only [Bool.not_eq_true] at hm
        simp only [hm, true_and]
        split
        · rename_i actual hfilter
          simp only [hfilter, List.length_singleton, ne_eq, not_true_eq_false, iff_false]
          split
          · simp
          · simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
            exact reject_ne_of_path (by decide)
          · split <;> simp
        · rename_i hfilter
          simp only [true_iff]
          intro hlen
          obtain ⟨a, ha⟩ := List.length_eq_one_iff.mp hlen
          exact hfilter a ha


/-- The posting step of a reduction group rejects a money-bearing group for its posting's
attribution exactly when its journal matches, has exactly one posting of the given identifier, and
that posting fails the attribution test: another account, commodity, currency or dimensions, or
not exactly the group's signed money, quantity taken out or basis taken out (lines 519 to 523). -/
theorem reductionGroupPosting_attribution_iff {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} {journalLink : Option InventoryPostedJournalLink}
    {postedAmount quantity historicalBasis : ExactRational} :
    reductionGroupPosting context coordinate journalLink postedAmount quantity historicalBasis =
        .ok (.rejected reductionGroupAttributionRejection) ↔
      postedAmount.isZero = false ∧ ∃ link actual, journalLink = some link ∧
        journalSourceMismatch context.toInventoryReductionEffectContext
          coordinate.functionalCommodityId link.source = false ∧
        link.source.journal.postings.filter (fun p => p.id == link.postingId) = [actual] ∧
        postingAttributionInvalid coordinate.accountId coordinate.unitsCommodityId
          coordinate.functionalCommodityId coordinate.dimensionMemberIds actual postedAmount
          quantity.negate historicalBasis.negate = .ok true := by
  unfold reductionGroupPosting
  by_cases hz : postedAmount.isZero = true
  · simp only [hz, ↓reduceIte, Bool.true_eq_false, false_and, iff_false]
    cases journalLink with
    | none => simp
    | some _ => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
                exact reject_ne_of_path (by decide)
  · simp only [Bool.not_eq_true] at hz
    simp only [hz, Bool.false_eq_true, ↓reduceIte, true_and]
    cases journalLink with
    | none => simp only [Except.ok.injEq, OwnershipStep.rejected.injEq, reduceCtorEq, false_and,
                exists_false, iff_false]
              exact reject_ne_of_path (by decide)
    | some link =>
      simp only [Option.some.injEq, exists_and_left, exists_eq_left']
      split
      · rename_i hm
        simp only [hm, Bool.true_eq_false, false_and, iff_false, Except.ok.injEq,
          OwnershipStep.rejected.injEq]
        exact reject_ne_of_path (by decide)
      · rename_i hm
        simp only [Bool.not_eq_true] at hm
        simp only [hm, true_and]
        split
        · rename_i actual hfilter
          simp only [hfilter, List.cons.injEq, and_true, exists_eq_left']
          split
          · rename_i e he
            rw [ofQuantize_eq_error_iff] at he
            obtain ⟨inner, hinner, -⟩ := he
            simp [hinner]
          · rename_i ht
            rw [ofQuantize_eq_ok_iff] at ht
            simp [ht]
          · rename_i ht
            rw [ofQuantize_eq_ok_iff] at ht
            simp only [ht]
            split <;> simp
        · rename_i hfilter
          simp only [Except.ok.injEq, OwnershipStep.rejected.injEq]
          constructor
          · intro he
            exact absurd he (reject_ne_of_path (by decide))
          · rintro ⟨actual, hf, -⟩
            exact absurd hf (hfilter actual)

end InventoryOwnership


open InventoryOwnership in
/-- A reduction group is rejected for its posting (lines 504 to 524) with a given diagnostic exactly
when its three tests pass, its loop goes through with its money, quantity and basis, and the posting
step rejects them with that diagnostic (`reductionGroupPosting_zero_iff` and the four beside it). -/
theorem prepareInventoryPostedReductionGroup_posting_stage
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} (hE : ∀ entry ∈ entries, entry.WF)
    {path message : String}
    (hpath : path ∈ ["inventoryOwnership.posting", "inventoryOwnership.journalSource",
      "inventoryOwnership.postingAttribution"]) :
    prepareInventoryPostedReductionGroup context entries journalLink =
        .ok (.rejected (InventoryOwnership.reject path message)) ↔
      reductionGroupPopulationInvalid entries journalLink = false ∧
      reductionGroupSourcesExceeded 0 entries = false ∧
      reductionGroupIdentityInvalid context entries = false ∧
      ∃ reductions postedAmount quantity historicalBasis,
        reductionGroupLoop context (reductionGroupCoordinate entries) 0 ExactRational.zero
          ExactRational.zero ExactRational.zero (reductionGroupOrdered entries) =
            .ok (.proceed (reductions, postedAmount, quantity, historicalBasis)) ∧
        reductionGroupPosting context (reductionGroupCoordinate entries) journalLink postedAmount
          quantity historicalBasis = .ok (.rejected (InventoryOwnership.reject path message)) := by
  have hperm := sortByText_perm (·.holding.id.value) entries
  constructor
  · intro h
    by_cases hpop : reductionGroupPopulationInvalid entries journalLink = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      obtain ⟨hp, -⟩ := reject_inj.mp h
      subst hp; exact absurd hpath (by decide)
    simp only [Bool.not_eq_true] at hpop
    by_cases hsrc : reductionGroupSourcesExceeded 0 entries = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, hsrc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      obtain ⟨hp, -⟩ := reject_inj.mp h
      subst hp; exact absurd hpath (by decide)
    simp only [Bool.not_eq_true] at hsrc
    by_cases hid : reductionGroupIdentityInvalid context entries = true
    · unfold prepareInventoryPostedReductionGroup at h
      simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedReductionGroupResult.rejected.injEq] at h
      obtain ⟨hp, -⟩ := reject_inj.mp h
      subst hp; exact absurd hpath (by decide)
    simp only [Bool.not_eq_true] at hid
    refine ⟨hpop, hsrc, hid, ?_⟩
    unfold prepareInventoryPostedReductionGroup at h
    simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte] at h
    split at h
    · cases h
    · rename_i r hr
      cases h
      rw [ofQuantize_eq_ok_iff] at hr
      exfalso
      refine fromPaths_ne_reject (reductionGroupLoop_fromPaths
        (fun e he => hE e (hperm.subset he)) hr) ?_ rfl
      intro hmem
      simp only [List.mem_cons, List.not_mem_nil, or_false] at hpath
      simp only [reductionPaths, List.mem_cons, List.not_mem_nil, or_false] at hmem
      rcases hpath with rfl | rfl | rfl <;> revert hmem <;> decide
    rename_i reductions postedAmount quantity historicalBasis hloop
    rw [ofQuantize_eq_ok_iff] at hloop
    split at h
    · cases h
    · rename_i r hr
      cases h
      exact ⟨reductions, postedAmount, quantity, historicalBasis, hloop, hr⟩
    · cases h
  · rintro ⟨hpop, hsrc, hid, reductions, postedAmount, quantity, historicalBasis, hloop, hpost⟩
    unfold prepareInventoryPostedReductionGroup
    simp only [hpop, hsrc, hid, Bool.false_eq_true, ↓reduceIte]
    unfold reductionGroupOrdered reductionGroupCoordinate at hloop
    unfold reductionGroupCoordinate reductionGroupOrdered at hpost
    rw [show InventoryOwnershipErr.ofQuantize (reductionGroupLoop context
      ((Option.map (fun x => x.anchor.coordinate) (sortByText (fun x => x.holding.id.value)
        entries).head?).getD default) 0 ExactRational.zero ExactRational.zero ExactRational.zero
      (sortByText (fun x => x.holding.id.value) entries)) =
        .ok (.proceed (reductions, postedAmount, quantity, historicalBasis)) by
          rw [ofQuantize_eq_ok_iff]; exact hloop]
    simp only [hpost]

open InventoryOwnership in
/-- An adoption group is rejected for its balance exactly when its three tests pass, its source loop
goes through with the holdings' quantity and carrying amount, the supplied balance is quantized, and
either the balance is not representable in the policy or it is not the holdings' complete carrying
amount (lines 841 to 843). -/
theorem prepareInventoryPostedAdoptionGroup_balance_iff
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance : ExactRational} :
    prepareInventoryPostedAdoptionGroup context entries postedBalance =
        .ok (.rejected adoptionBalanceRejection) ↔
      adoptionPopulationInvalid context entries = false ∧
      adoptionEvidenceExceeded 0 entries = false ∧
      adoptionIdentityInvalid context entries = false ∧
      ∃ quantity carrying balance balanceRational,
        adoptionSourceLoop context (adoptionFirst entries) ExactRational.zero ExactRational.zero
          (adoptionOrdered entries) = .ok (.proceed (quantity, carrying)) ∧
        quantize postedBalance context.quantizationPolicy.rule = .ok balance ∧
        balance.amount.toRational = .ok balanceRational ∧
        (balanceRational.equals postedBalance = false ∨ postedBalance.equals carrying = false) := by
  constructor
  · intro h
    by_cases hpop : adoptionPopulationInvalid context entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hpop
    by_cases hev : adoptionEvidenceExceeded 0 entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, hev, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hev
    by_cases hid : adoptionIdentityInvalid context entries = true
    · unfold prepareInventoryPostedAdoptionGroup at h
      simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    simp only [Bool.not_eq_true] at hid
    refine ⟨hpop, hev, hid, ?_⟩
    unfold prepareInventoryPostedAdoptionGroup at h
    simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte] at h
    split at h
    · cases h
    · rename_i r hr
      rw [ofQuantize_eq_ok_iff] at hr
      have := adoptionSourceLoop_rejected hr
      subst this
      simp only [Except.ok.injEq, InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd h (reject_ne_of_path (by decide))
    rename_i quantity carrying hsrc
    rw [ofQuantize_eq_ok_iff] at hsrc
    split at h
    · cases h
    rename_i balance hbal
    rw [ofQuantize_eq_ok_iff] at hbal
    split at h
    · cases h
    rename_i balanceRational hbr
    rw [ofQuantize_eq_ok_iff, liftExact_eq_ok_iff] at hbr
    split at h
    · rename_i hcond
      simp only [Bool.or_eq_true, Bool.not_eq_true'] at hcond
      exact ⟨quantity, carrying, balance, balanceRational, hsrc, hbal, hbr, hcond⟩
    split at h
    · cases h
    · rename_i r hr
      rw [ofQuantize_eq_ok_iff] at hr
      simp only [Except.ok.injEq, InventoryPostedAdoptionGroupResult.rejected.injEq] at h
      exact absurd (h ▸ adoptionConstruction_rejected hr) (reject_not_inner _ _)
    · cases h
  · rintro ⟨hpop, hev, hid, quantity, carrying, balance, balanceRational, hsrc, hbal, hbr, hcond⟩
    unfold prepareInventoryPostedAdoptionGroup
    simp only [hpop, hev, hid, Bool.false_eq_true, ↓reduceIte]
    unfold adoptionOrdered adoptionFirst at hsrc
    rw [show InventoryOwnershipErr.ofQuantize (adoptionSourceLoop context
      ((Option.map (fun x => x.holding) (sortByText (fun x => x.holding.id.value) entries).head?).getD
        default) ExactRational.zero ExactRational.zero
        (sortByText (fun x => x.holding.id.value) entries)) =
          .ok (.proceed (quantity, carrying)) by rw [ofQuantize_eq_ok_iff]; exact hsrc]
    simp only [hbal, InventoryOwnershipErr.ofQuantize, liftExact, hbr]
    have hc : ((!balanceRational.equals postedBalance) || !postedBalance.equals carrying) = true := by
      rcases hcond with h1 | h1 <;> simp [h1]
    simp only [hc, ↓reduceIte]

end Rastrata.Kernel

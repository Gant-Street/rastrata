/-
A source whose posting is found in the booked journals, and one whose posting is not.
-/
import Rastrata.Kernel.Accounting.Basis.Laws7

namespace Rastrata.Kernel

/-! ## The tables -/

/-- A value `mapLast` finds is under its key in the entries. -/
theorem mapLast_mem {V : Type} {entries : List (String × V)} {key : String} {value : V}
    (h : mapLast entries key = some value) : (key, value) ∈ entries := by
  unfold mapLast at h
  cases hf : entries.reverse.find? (fun entry => entry.1 == key) with
  | none => simp [hf] at h
  | some entry =>
    simp only [hf, Option.map_some, Option.some.injEq] at h
    have hkey := List.find?_some hf
    have hmem := List.mem_of_find?_eq_some hf
    simp only [beq_iff_eq] at hkey
    obtain ⟨k, v⟩ := entry
    simp only at hkey h
    subst hkey
    subst h
    simpa using hmem

/-- A value is not found under a key no entry has. -/
theorem mapLast_eq_none {V : Type} {entries : List (String × V)} {key : String}
    (h : ∀ entry ∈ entries, entry.1 ≠ key) : mapLast entries key = none := by
  unfold mapLast
  have : entries.reverse.find? (fun entry => entry.1 == key) = none := by
    apply List.find?_eq_none.mpr
    intro entry hmem
    simpa using h entry (List.mem_reverse.mp hmem)
  simp [this]

/-- The set size of a list is its length exactly when its members are distinct. -/
theorem setSize_eq_length_iff {α : Type} [DecidableEq α] (values : List α) :
    setSize values = values.length ↔ values.Nodup := by
  unfold setSize
  constructor
  · intro h
    have hsub : values.dedup.Sublist values := List.dedup_sublist values
    have : values.dedup = values := hsub.eq_of_length h
    rw [← this]
    exact List.nodup_dedup values
  · intro h
    rw [List.dedup_eq_self.mpr h]

/-! ## `postingReferenceCloses` -/

/-- A reference closes exactly when it is valid and of the policy's book, a booked journal has its
journal and effect key with distinct posting identifiers, and that journal has the referenced
posting, on the accounting date when one is given, with the reference's posting hash, as the copied
posting has when one is given. -/
theorem postingReferenceCloses_true_iff (policy : AccountingBasisPolicy) (ordered : List BookedJournal)
    (reference : CanonicalPostingReference) (copied : Option Posting) (date : Option LocalDate) :
    postingReferenceCloses policy ordered reference copied date = true ↔
      validateCanonicalPostingReferenceHash reference = true ∧ reference.bookId = policy.bookId ∧
        ∃ booked, mapLast (bookedBySourceKey ordered)
            (reference.journalId.value ++ "\x00" ++ reference.effectKey.value) = some booked ∧
          setSize ((bookedPostingMap booked).map (·.1)) = booked.journal.postings.length ∧
          ∃ posting, mapLast (bookedPostingMap booked) reference.postingId.value = some posting ∧
            (∀ d, date = some d → d = booked.journal.accountingDate) ∧
            hashCanonical (canonicalPostingValue posting) = reference.postingContentHash ∧
            (∀ c, copied = some c →
              hashCanonical (canonicalPostingValue c) = reference.postingContentHash) := by
  unfold postingReferenceCloses
  by_cases hv : (!validateCanonicalPostingReferenceHash reference ||
      reference.bookId != policy.bookId) = true
  · rw [if_pos hv]
    simp only [Bool.or_eq_true, Bool.not_eq_true', bne_iff_ne] at hv
    constructor
    · intro h
      cases h
    · rintro ⟨hval, hbook, -⟩
      rcases hv with hv | hv
      · rw [hval] at hv
        cases hv
      · exact absurd hbook hv
  · rw [if_neg hv]
    simp only [Bool.or_eq_true, Bool.not_eq_true', bne_iff_ne, not_or, not_not] at hv
    obtain ⟨hval, hbook⟩ := hv
    constructor
    · intro h
      refine ⟨by simpa using hval, hbook, ?_⟩
      split at h
      · cases h
      · rename_i booked hbooked
        split at h
        · cases h
        · rename_i hsize
          split at h
          · cases h
          · rename_i posting hposting
            refine ⟨booked, hbooked, ?_, posting, hposting, ?_⟩
            · by_contra hne
              exact hsize (by simpa using hne)
            · simp only [Bool.and_eq_true] at h
              obtain ⟨⟨hdate, hhash⟩, hcopy⟩ := h
              refine ⟨?_, ?_, ?_⟩
              · intro d hd
                rw [hd] at hdate
                simpa using hdate
              · simpa [contentHashEquals_iff] using hhash
              · intro c hc
                rw [hc] at hcopy
                simpa [contentHashEquals_iff] using hcopy
    · rintro ⟨-, -, booked, hbooked, hsize, posting, hposting, hdate, hhash, hcopy⟩
      rw [hbooked]
      simp only
      rw [if_neg (by simpa using hsize), hposting]
      simp only [Bool.and_eq_true]
      refine ⟨⟨?_, (contentHashEquals_iff _ _).mpr hhash⟩, ?_⟩
      · cases date with
        | none => rfl
        | some d => simpa using hdate d rfl
      · cases copied with
        | none => rfl
        | some c => exact (contentHashEquals_iff _ _).mpr (hcopy c rfl)

/-! ## The checks of the snapshot -/

/-- `snapshotFailsBeforeState` holds exactly when one of the eight checks of line 1441 that come
before the accounting state fails. -/
theorem snapshotFailsBeforeState_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (ordered : List BookedJournal) :
    snapshotFailsBeforeState policy snapshot ordered = true ↔
      snapshot.throughBookRevision < 0 ∨ snapshot.throughPostingSequence < 0 ∨
        configuredPolicyMatches policy snapshot = false ∨
        journalPopulationValid policy snapshot ordered = false ∨
        uniqueJournalSources ordered = false ∨ completeClassification snapshot = false ∨
        exactReferenceClassification snapshot = false ∨
        sourcePopulationCloses policy snapshot ordered = false := by
  unfold snapshotFailsBeforeState
  simp only [Bool.or_eq_true, decide_eq_true_eq, Bool.not_eq_true', or_assoc]

/-- `snapshotHashesDiffer` holds exactly when the carried report population hash, source population
hash or content hash is not the recomputed one. -/
theorem snapshotHashesDiffer_iff (snapshot : AccountingReadSnapshot) :
    snapshotHashesDiffer snapshot = true ↔
      snapshot.reportPopulationHash ≠
          hashAccountingReadPopulation snapshot.toAccountingReadPopulation ∨
        snapshot.sourcePopulationHash ≠ hashAccountingBasisSourcePopulation snapshot.sourceEvents ∨
        snapshot.contentHash ≠ hashAccountingReadSnapshot snapshot.toAccountingReadSnapshotBody := by
  unfold snapshotHashesDiffer contentHashEqual
  simp only [Bool.or_eq_true, Bool.not_eq_true', or_assoc]
  have key : ∀ a b : ContentHash, contentHashEquals a b = false ↔ a ≠ b := by
    intro a b
    rw [Bool.eq_false_iff, ne_eq, ne_eq, contentHashEquals_iff]
  rw [key, key, key]

/-- The checks of the snapshot refuse it exactly when one of the checks before the state fails, or the
hash of an effect of the state does not check, or one of the three hashes differs. -/
theorem readSnapshotRejects_true_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) :
    readSnapshotRejects policy snapshot = .ok true ↔
      snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) = true ∨
        (snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) = false ∧
          accountingStateHashesAreValid snapshot.accountingState = .ok false) ∨
        (snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) = false ∧
          accountingStateHashesAreValid snapshot.accountingState = .ok true ∧
          snapshotHashesDiffer snapshot = true) := by
  unfold readSnapshotRejects
  cases hf : snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) with
  | true => simp
  | false =>
    simp only [Bool.false_eq_true, ite_false, false_or]
    cases hs : accountingStateHashesAreValid snapshot.accountingState with
    | error e => simp
    | ok b =>
      cases b <;> simp

/-- The checks of the snapshot let it pass exactly when no check before the state fails, the hash of
every effect of the state checks, and the three hashes are the recomputed ones. -/
theorem readSnapshotRejects_false_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) :
    readSnapshotRejects policy snapshot = .ok false ↔
      snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) = false ∧
        accountingStateHashesAreValid snapshot.accountingState = .ok true ∧
        snapshotHashesDiffer snapshot = false := by
  unfold readSnapshotRejects
  cases hf : snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) with
  | true => simp
  | false =>
    simp only [Bool.false_eq_true, ite_false, true_and]
    cases hs : accountingStateHashesAreValid snapshot.accountingState with
    | error e => simp
    | ok b =>
      cases b <;> simp

end Rastrata.Kernel

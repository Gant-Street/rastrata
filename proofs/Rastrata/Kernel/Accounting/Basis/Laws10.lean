/-
The projection does not depend on the order of the booked journals, except for the echo of that
order in the source snapshot it returns.
-/
import Rastrata.Kernel.Accounting.Basis.Laws9
import Mathlib.Data.List.Sort

namespace Rastrata.Kernel

/-! ## Sorting the journals -/

/-- The journals in order of their posting sequence are in order. -/
theorem sortBookedJournals_pairwise (journals : List BookedJournal) :
    (sortBookedJournals journals).Pairwise fun a b => a.postingSequence ≤ b.postingSequence := by
  have h := List.pairwise_mergeSort (le := fun left right : BookedJournal =>
    decide (left.postingSequence ≤ right.postingSequence))
    (fun a b c hab hbc => by simp only [decide_eq_true_eq] at *; omega)
    (fun a b => by simp only [Bool.or_eq_true, decide_eq_true_eq]; omega) journals
  exact h.imp fun hab => by simpa using hab

/-- The sort puts the same journals in the same list. -/
theorem sortBookedJournals_perm' (journals : List BookedJournal) :
    (sortBookedJournals journals).Perm journals :=
  List.mergeSort_perm _ _

/-- Two orders of the same journals, with distinct posting sequences, sort to the same list. -/
theorem sortBookedJournals_eq_of_perm {js js' : List BookedJournal} (hperm : js.Perm js')
    (hdistinct : (js.map (·.postingSequence)).Nodup) :
    sortBookedJournals js = sortBookedJournals js' := by
  have hp : (sortBookedJournals js).Perm (sortBookedJournals js') :=
    ((sortBookedJournals_perm' js).trans hperm).trans (sortBookedJournals_perm' js').symm
  apply List.Perm.eq_of_pairwise _ (sortBookedJournals_pairwise js) (sortBookedJournals_pairwise js') hp
  intro a b ha hb hab hba
  have ha' : a ∈ js := (sortBookedJournals_perm' js).subset ha
  have hb' : b ∈ js := hperm.symm.subset ((sortBookedJournals_perm' js').subset hb)
  exact List.inj_on_of_nodup_map hdistinct ha' hb' (le_antisymm hab hba)

/-! ## Everything but the echo of the order -/

section Order

variable (snapshot : AccountingReadSnapshot) (js : List BookedJournal)

/-- The snapshot hashes read the journals only in order of their sequence: another order that sorts to
the same list leaves the hash of the report population unchanged. -/
theorem hashAccountingReadPopulation_journals
    (hsort : sortBookedJournals js = sortBookedJournals snapshot.journals) :
    hashAccountingReadPopulation { snapshot.toAccountingReadPopulation with journals := js } =
      hashAccountingReadPopulation snapshot.toAccountingReadPopulation := by
  unfold hashAccountingReadPopulation
  simp only [hsort]

/-- The same for the hash of the snapshot. -/
theorem hashAccountingReadSnapshot_journals
    (hsort : sortBookedJournals js = sortBookedJournals snapshot.journals) :
    hashAccountingReadSnapshot { snapshot.toAccountingReadSnapshotBody with journals := js } =
      hashAccountingReadSnapshot snapshot.toAccountingReadSnapshotBody := by
  unfold hashAccountingReadSnapshot
  simp only [hsort]

/-- The three hash checks read the journals only in order of their sequence. -/
theorem snapshotHashesDiffer_journals
    (hsort : sortBookedJournals js = sortBookedJournals snapshot.journals) :
    snapshotHashesDiffer { snapshot with journals := js } = snapshotHashesDiffer snapshot := by
  have e1 : hashAccountingReadPopulation { snapshot with journals := js }.toAccountingReadPopulation =
      hashAccountingReadPopulation snapshot.toAccountingReadPopulation :=
    hashAccountingReadPopulation_journals snapshot js hsort
  have e2 : hashAccountingReadSnapshot { snapshot with journals := js }.toAccountingReadSnapshotBody =
      hashAccountingReadSnapshot snapshot.toAccountingReadSnapshotBody :=
    hashAccountingReadSnapshot_journals snapshot js hsort
  unfold snapshotHashesDiffer
  rw [e1, e2]

/-- The hash of a snapshot body reads its journals only in order of their sequence. -/
theorem hashAccountingReadSnapshot_journals' (body : AccountingReadSnapshotBody)
    (hsort : sortBookedJournals js = sortBookedJournals body.journals) :
    hashAccountingReadSnapshot { body with journals := js } = hashAccountingReadSnapshot body := by
  unfold hashAccountingReadSnapshot
  simp only [hsort]

/-- The checks of the snapshot read the journals only in order of their sequence. -/
theorem readSnapshotRejects_journals (policy : AccountingBasisPolicy)
    (hsort : sortBookedJournals js = sortBookedJournals snapshot.journals) :
    readSnapshotRejects policy { snapshot with journals := js } =
      readSnapshotRejects policy snapshot := by
  have hf : snapshotFailsBeforeState policy { snapshot with journals := js }
      (sortBookedJournals js) = snapshotFailsBeforeState policy snapshot
        (sortBookedJournals snapshot.journals) := by
    rw [hsort]
    rfl
  unfold readSnapshotRejects
  show (if snapshotFailsBeforeState policy { snapshot with journals := js } (sortBookedJournals js)
      then _ else _) = _
  rw [hf, snapshotHashesDiffer_journals snapshot js hsort]

/-- The loop reads the state of the snapshot and no journal: another order of the journals leaves it
unchanged. -/
theorem basisLoop_journals (policy : AccountingBasisPolicy) :
    ∀ (events : List BasisSourceEvent) (count : Nat) (totals : BasisTotals),
      basisLoop policy { snapshot with journals := js } count totals events =
        basisLoop policy snapshot count totals events
  | [], _, _ => rfl
  | event :: rest, count, totals => by
    have hp : processBasisEvent policy { snapshot with journals := js } event count totals =
        processBasisEvent policy snapshot event count totals := rfl
    unfold basisLoop
    rw [hp]
    cases processBasisEvent policy snapshot event count totals with
    | error e => rfl
    | ok outcome =>
      cases outcome with
      | rejected d => rfl
      | entry entry totals' =>
        simp only
        rw [basisLoop_journals policy rest (count + 1) totals']

end Order

/-! ## The agreement of two results -/

/-- Two results agree up to the order of the booked journals: both throw the same, both reject with
the same diagnostics, or both project with the same policy, source population hash, entries,
reconciliation and source snapshot hash (the projections differ in the echo of the journals in their
given order, and so in their own hash). -/
def BasisProjectionResult.Agrees :
    Except QuantizeErr BasisProjectionResult → Except QuantizeErr BasisProjectionResult → Prop
  | .error e, .error e' => e = e'
  | .ok (.rejected ds), .ok (.rejected ds') => ds = ds'
  | .ok (.projected p), .ok (.projected p') =>
    p.policyId = p'.policyId ∧ p.sourcePopulationHash = p'.sourcePopulationHash ∧
      p.entries = p'.entries ∧ p.reconciliation = p'.reconciliation ∧
      p.sourceSnapshot.contentHash = p'.sourceSnapshot.contentHash
  | _, _ => False


/-- The projection does not depend on the order of the booked journals: for another order of journals
with distinct posting sequences, the call throws the same, or rejects with the same diagnostics, or
projects with the same policy, source population hash, entries, reconciliation and source snapshot
hash. (The projection echoes the journals in the order it was given, so the projections themselves
differ, `projectAccountingBasis_journals_echo`.) -/
theorem projectAccountingBasis_journals_order (policies : List AccountingPolicy)
    (policyIdValue : PolicyId) (version : SemanticVersion) (snapshot : AccountingReadSnapshot)
    (js : List BookedJournal) (hperm : js.Perm snapshot.journals)
    (hdistinct : (snapshot.journals.map (·.postingSequence)).Nodup) :
    BasisProjectionResult.Agrees
      (projectAccountingBasis policies policyIdValue version { snapshot with journals := js })
      (projectAccountingBasis policies policyIdValue version snapshot) := by
  have hsort : sortBookedJournals js = sortBookedJournals snapshot.journals :=
    sortBookedJournals_eq_of_perm hperm ((hperm.map _).nodup_iff.mpr hdistinct)
  have run := projectAccountingBasis_run policies policyIdValue version snapshot
  generalize hr : projectAccountingBasis policies policyIdValue version snapshot = r at run
  have hrs := fun policy => readSnapshotRejects_journals snapshot js policy hsort
  have hlp := fun policy count totals events => basisLoop_journals snapshot js policy events count totals
  cases run with
  | noPolicy h =>
    rw [projectAccountingBasis_of_noPolicy (snapshot := { snapshot with journals := js }) h]
    exact rfl
  | tooMany hp h =>
    rw [projectAccountingBasis_of_tooMany (snapshot := { snapshot with journals := js }) hp h]
    exact rfl
  | identity hp hb h =>
    rw [projectAccountingBasis_of_identity (snapshot := { snapshot with journals := js }) hp hb h]
    exact rfl
  | snapshotThrows hp hb hi h =>
    rw [projectAccountingBasis_of_snapshotThrows (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans h)]
    exact rfl
  | snapshot hp hb hi h =>
    rw [projectAccountingBasis_of_snapshot (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans h)]
    exact rfl
  | event hp hb hi hs h =>
    rw [projectAccountingBasis_of_event (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans hs) h]
    exact rfl
  | loopThrows hp hb hi hs hc h =>
    rw [projectAccountingBasis_of_loopThrows (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans hs) hc ((hlp _ _ _ _).trans h)]
    exact rfl
  | loopRejects hp hb hi hs hc h =>
    rw [projectAccountingBasis_of_loopRejects (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans hs) hc ((hlp _ _ _ _).trans h)]
    exact rfl
  | reconciliationThrows hp hb hi hs hc h hrc =>
    rw [projectAccountingBasis_of_reconciliationThrows (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans hs) hc ((hlp _ _ _ _).trans h) hrc]
    exact rfl
  | reconciliation hp hb hi hs hc h hrc =>
    rw [projectAccountingBasis_of_reconciliation (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans hs) hc ((hlp _ _ _ _).trans h) hrc]
    exact rfl
  | projected hp hb hi hs hc h hrc =>
    rw [projectAccountingBasis_of_projected (snapshot := { snapshot with journals := js })
      hp hb hi ((hrs _).trans hs) hc ((hlp _ _ _ _).trans h) hrc]
    refine ⟨rfl, rfl, rfl, rfl, ?_⟩
    exact hashAccountingReadSnapshot_journals' js
      { snapshot.toAccountingReadSnapshotBody with
        sourceEvents := sortBasisEventsById snapshot.sourceEvents } hsort

/-- The projection echoes the booked journals in the order it was given: its source snapshot carries
them as they came, so two orders of the same journals give two different projections. -/
theorem projectAccountingBasis_journals_echo {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {projection : AccountingBasisProjection}
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected projection)) :
    projection.sourceSnapshot.journals = snapshot.journals := by
  obtain ⟨policy, entries, totals, -, -, -, rfl⟩ := (projectAccountingBasis_projected_iff _).mp h
  rfl

end Rastrata.Kernel

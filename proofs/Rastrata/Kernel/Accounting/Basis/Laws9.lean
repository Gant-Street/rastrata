/-
Every source of a projection is found in the booked journals, and a source that is not found is
refused.
-/
import Rastrata.Kernel.Accounting.Basis.Laws8

namespace Rastrata.Kernel

/-! ## The source key of a booked journal -/

/-- The key of a booked journal, with a valid journal identifier, names the identifier and the effect
key and nothing else. -/
theorem journalKey_eq_iff {a b : JournalId} {x y : String} (ha : a.WF) (hb : b.WF) :
    a.value ++ "\x00" ++ x = b.value ++ "\x00" ++ y ↔ a = b ∧ x = y := by
  constructor
  · intro h
    have h := congrArg String.toList h
    simp only [String.toList_append, List.append_assoc] at h
    have h' : a.value.toList ++ '\x00' :: x.toList = b.value.toList ++ '\x00' :: y.toList := by
      simpa using h
    obtain ⟨h1, h2⟩ := append_cons_inj ha.not_nul hb.not_nul h'
    exact ⟨identifier_eq_of_toList h1, String.toList_inj.mp h2⟩
  · rintro ⟨rfl, rfl⟩
    rfl

/-- The accepted snapshot closes every source: the last of the checks before the state. -/
theorem sourcePopulationCloses_of_accepted {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot}
    (h : readSnapshotRejects policy snapshot = .ok false) :
    sourcePopulationCloses policy snapshot (sortBookedJournals snapshot.journals) = true := by
  obtain ⟨hf, -, -⟩ := (readSnapshotRejects_false_iff policy snapshot).mp h
  by_contra hne
  have hfalse : sourcePopulationCloses policy snapshot (sortBookedJournals snapshot.journals) =
      false := by simpa using hne
  have : snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) = true :=
    (snapshotFailsBeforeState_iff _ _ _).mpr
      (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr hfalse)))))))
  rw [hf] at this
  cases this

/-- Every journal the check of line 1407 passes is of the policy's book. -/
theorem journalsAreOrdered_bookId {policy : AccountingBasisPolicy} {throughBookRevision : Int} :
    ∀ {index : Nat} {journals : List BookedJournal},
      journalsAreOrdered policy throughBookRevision index journals = true →
        ∀ booked ∈ journals, booked.journal.bookId = policy.bookId
  | _, [], _ => by simp
  | index, booked :: rest, h => by
    simp only [journalsAreOrdered, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq] at h
    intro b hb
    rcases List.mem_cons.mp hb with rfl | hb
    · exact h.1.1.2
    · exact journalsAreOrdered_bookId h.2 b hb

/-- The accepted snapshot's journals are all of the policy's book. -/
theorem journalBook_of_accepted {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} (h : readSnapshotRejects policy snapshot = .ok false) :
    ∀ booked ∈ sortBookedJournals snapshot.journals, booked.journal.bookId = policy.bookId := by
  obtain ⟨hf, -, -⟩ := (readSnapshotRejects_false_iff policy snapshot).mp h
  have hvalid : journalPopulationValid policy snapshot (sortBookedJournals snapshot.journals) =
      true := by
    by_contra hne
    have hfalse : journalPopulationValid policy snapshot
        (sortBookedJournals snapshot.journals) = false := by simpa using hne
    have : snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) =
        true := (snapshotFailsBeforeState_iff _ _ _).mpr
      (Or.inr (Or.inr (Or.inr (Or.inl hfalse))))
    rw [hf] at this
    cases this
  unfold journalPopulationValid at hvalid
  simp only [Bool.and_eq_true] at hvalid
  exact journalsAreOrdered_bookId hvalid.2

/-- A source of the snapshot that closes has a booked journal of the snapshot with its journal and
effect key, which holds the posting it names, on the event's accounting date, with the content hash
the source records, which is also that of the event's copied posting. -/
theorem postingReferenceCloses_found {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} (hW : snapshot.WF) {event : BasisSourceEvent}
    (he : event ∈ snapshot.sourceEvents)
    (hevent : postingReferenceCloses policy (sortBookedJournals snapshot.journals) event.source
      (some event.sourcePosting) (some event.accountingDate) = true) :
    ∃ booked ∈ sortBookedJournals snapshot.journals, booked.journal.id = event.source.journalId ∧
      booked.effectKey = event.source.effectKey.value ∧
      ∃ posting ∈ booked.journal.postings, posting.id = event.source.postingId ∧
        booked.journal.accountingDate = event.accountingDate ∧
        hashCanonical (canonicalPostingValue posting) = event.source.postingContentHash ∧
        hashCanonical (canonicalPostingValue event.sourcePosting) =
          event.source.postingContentHash := by
  obtain ⟨-, hbook, booked, hbooked, -, posting, hposting, hdate, hhash, hcopy⟩ :=
    (postingReferenceCloses_true_iff _ _ _ _ _).mp hevent
  have hmem := mapLast_mem hbooked
  unfold bookedBySourceKey at hmem
  obtain ⟨b', hb', hpair⟩ := List.mem_map.mp hmem
  simp only [Prod.mk.injEq] at hpair
  obtain ⟨hkey, rfl⟩ := hpair
  have hbWF : b'.WF := (hW : AccountingReadPopulation.WF
    snapshot.toAccountingReadSnapshotBody.toAccountingReadPopulation).journals b'
    (List.mem_mergeSort.mp hb')
  have heWF := hW.sourceEvents' event he
  unfold bookedSourceKey at hkey
  obtain ⟨hid, hkeyEq⟩ :=
    (journalKey_eq_iff hbWF.journalIdentifiers.id heWF.source.journalId).mp hkey
  have hpmem := mapLast_mem hposting
  unfold bookedPostingMap at hpmem
  obtain ⟨p', hp', hppair⟩ := List.mem_map.mp hpmem
  simp only [Prod.mk.injEq] at hppair
  obtain ⟨hpid, rfl⟩ := hppair
  exact ⟨b', hb', hid, hkeyEq, p', hp', identifier_eq_of_toList (by rw [hpid]),
    (hdate event.accountingDate rfl).symm, hhash, hcopy _ rfl⟩

/-- The event's source, in the accepted snapshot: a booked journal of the snapshot has the source's
journal and effect key, in the policy's book, and has the posting the source names, on the event's
accounting date, with the content hash the source records, which is also that of the event's copied
posting. -/
theorem sourceClosed_of_accepted {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} (hW : snapshot.WF)
    (h : readSnapshotRejects policy snapshot = .ok false) {event : BasisSourceEvent}
    (he : event ∈ snapshot.sourceEvents) :
    ∃ booked ∈ snapshot.journals, booked.journal.id = event.source.journalId ∧
      booked.effectKey = event.source.effectKey.value ∧
      booked.journal.bookId = policy.bookId ∧
      ∃ posting ∈ booked.journal.postings, posting.id = event.source.postingId ∧
        booked.journal.accountingDate = event.accountingDate ∧
        hashCanonical (canonicalPostingValue posting) = event.source.postingContentHash ∧
        hashCanonical (canonicalPostingValue event.sourcePosting) =
          event.source.postingContentHash := by
  have hclose := sourcePopulationCloses_of_accepted h
  unfold sourcePopulationCloses at hclose
  simp only [Bool.and_eq_true, List.all_eq_true] at hclose
  obtain ⟨booked, hb, rest⟩ := postingReferenceCloses_found hW he (hclose.2 event he)
  exact ⟨booked, List.mem_mergeSort.mp hb, rest.1, rest.2.1, journalBook_of_accepted h booked hb,
    rest.2.2⟩

/-- Every source of a projection is found in the booked journals: for each event, a booked journal
of the snapshot has the source's journal and effect key and holds the posting the source names, on the
event's accounting date, with the content hash the source records, which is also that of the event's
copied posting; and the journal is of the policy's book. -/
theorem projectAccountingBasis_sources_found {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {projection : AccountingBasisProjection} (hW : snapshot.WF)
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.projected projection)) :
    ∃ policy, policyAt AccountingBasisPolicy policies policyIdValue version
        snapshot.policyEffectiveAt = .selected policy ∧
      ∀ event ∈ snapshot.sourceEvents, ∃ booked ∈ snapshot.journals,
        booked.journal.id = event.source.journalId ∧
        booked.effectKey = event.source.effectKey.value ∧
        booked.journal.bookId = policy.bookId ∧
        ∃ posting ∈ booked.journal.postings, posting.id = event.source.postingId ∧
          booked.journal.accountingDate = event.accountingDate ∧
          hashCanonical (canonicalPostingValue posting) = event.source.postingContentHash ∧
          hashCanonical (canonicalPostingValue event.sourcePosting) =
            event.source.postingContentHash := by
  obtain ⟨policy, entries, totals, hc, -⟩ := (projectAccountingBasis_projected_iff _).mp h
  exact ⟨policy, hc.selected, fun event he => sourceClosed_of_accepted hW hc.accepted he⟩

/-- A source whose posting is not found in the booked journals is refused with the diagnostic of the
snapshot (line 1441), when the first three checks pass: no booked journal with the source's journal
and effect key holds a posting with the identifier the source names. -/
theorem projectAccountingBasis_unfound_source_refused {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {policy : AccountingBasisPolicy} (hW : snapshot.WF)
    (hp : BasisPopulationOk policies policyIdValue version snapshot policy)
    {event : BasisSourceEvent} (he : event ∈ snapshot.sourceEvents)
    (hmissing : ∀ booked ∈ snapshot.journals, booked.journal.id = event.source.journalId →
      booked.effectKey = event.source.effectKey.value →
      ∀ posting ∈ booked.journal.postings, posting.id ≠ event.source.postingId) :
    projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisSnapshotDiagnostic]) := by
  have hfalse : postingReferenceCloses policy (sortBookedJournals snapshot.journals) event.source
      (some event.sourcePosting) (some event.accountingDate) = false := by
    by_contra hne
    have hclose : postingReferenceCloses policy (sortBookedJournals snapshot.journals) event.source
        (some event.sourcePosting) (some event.accountingDate) = true := by simpa using hne
    obtain ⟨booked, hb, hid, hkey, posting, hpm, hpid, -⟩ := postingReferenceCloses_found hW he hclose
    exact hmissing booked (List.mem_mergeSort.mp hb) hid hkey posting hpm hpid
  have hsource : sourcePopulationCloses policy snapshot (sortBookedJournals snapshot.journals) =
      false := by
    unfold sourcePopulationCloses
    simp only [Bool.and_eq_false_iff, List.all_eq_false]
    right
    exact ⟨event, he, by simpa using hfalse⟩
  have hfail : snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) =
      true := (snapshotFailsBeforeState_iff _ _ _).mpr
    (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr hsource)))))))
  have hs : readSnapshotRejects policy snapshot = .ok true := by
    simp [readSnapshotRejects, hfail]
  exact projectAccountingBasis_of_snapshot hp.selected hp.bound hp.identity hs

end Rastrata.Kernel

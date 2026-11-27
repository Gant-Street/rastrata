/-
The hashes of the read snapshot and of the source population are functions of the content they
cover, and equal hashes mean equal content or a collision of SHA-256.
-/
import Rastrata.Kernel.Accounting.Basis.Laws10
import Rastrata.Kernel.Accounting.Basis.Lawful

namespace Rastrata.Kernel

/-! ## `accountingHash` of an object -/

/-- Two `accountingHash`es of objects with the same distinct keys, each property well formed, are
equal only when the properties are equal one by one, up to the order of record entries, or a collision
of SHA-256 is in hand; and when the type names differ they are not equal. -/
theorem accountingHash_object_inj_or_collision {type₁ type₂ : String}
    {members₁ members₂ : List Member}
    (hkeys : members₁.map Prod.fst = members₂.map Prod.fst)
    (hnodup : (members₁.map Prod.fst).Nodup)
    (hwf₁ : ∀ m ∈ members₁, MemberWF m) (hwf₂ : ∀ m ∈ members₂, MemberWF m)
    (h : accountingHash type₁ (object members₁) = accountingHash type₂ (object members₂)) :
    (type₁ = type₂ ∧ List.Forall₂ (fun m₁ m₂ => OptEquiv m₁.2 m₂.2) members₁ members₂) ∨
      HashCollision := by
  have hobj₁ : (object members₁).WF := object_wf_of hnodup hwf₁
  have hobj₂ : (object members₂).WF := object_wf_of (hkeys ▸ hnodup) hwf₂
  have hrec₁ : (CanonicalValue.record [("type", .string type₁), ("value", object members₁)]).WF :=
    ⟨by simp, trivial, hobj₁, trivial⟩
  have hrec₂ : (CanonicalValue.record [("type", .string type₂), ("value", object members₂)]).WF :=
    ⟨by simp, trivial, hobj₂, trivial⟩
  unfold accountingHash at h
  rcases hashCanonical_inj_or_collision hrec₁ hrec₂ h with heq | hc
  · left
    have := object_equiv_forall₂
      (members₁ := [("type", some (.string type₁)), ("value", some (object members₁))])
      (members₂ := [("type", some (.string type₂)), ("value", some (object members₂))])
      rfl (by simp) heq
    simp only [List.forall₂_cons, List.forall₂_nil_left_iff, and_true, OptEquiv] at this
    obtain ⟨htype, hvalue⟩ := this
    refine ⟨?_, object_equiv_forall₂ hkeys hnodup hvalue⟩
    simpa [CanonicalValue.Equiv] using htype
  · exact Or.inr hc

/-- Two `hashCanonical`s of objects with the same distinct keys, each property well formed, are equal
only when the properties are equal one by one, up to the order of record entries, or a collision of
SHA-256 is in hand. -/
theorem hashCanonical_object_inj_or_collision {members₁ members₂ : List Member}
    (hkeys : members₁.map Prod.fst = members₂.map Prod.fst)
    (hnodup : (members₁.map Prod.fst).Nodup)
    (hwf₁ : ∀ m ∈ members₁, MemberWF m) (hwf₂ : ∀ m ∈ members₂, MemberWF m)
    (h : hashCanonical (object members₁) = hashCanonical (object members₂)) :
    List.Forall₂ (fun m₁ m₂ => OptEquiv m₁.2 m₂.2) members₁ members₂ ∨ HashCollision := by
  have hobj₁ : (object members₁).WF := object_wf_of hnodup hwf₁
  have hobj₂ : (object members₂).WF := object_wf_of (hkeys ▸ hnodup) hwf₂
  rcases hashCanonical_inj_or_collision hobj₁ hobj₂ h with heq | hc
  · exact Or.inl (object_equiv_forall₂ hkeys hnodup heq)
  · exact Or.inr hc

/-- The members of the record `hashAccountingBasisSourcePopulation` hashes. -/
def sourcePopulationHashMembers (events : List BasisSourceEvent) : List Member :=
  [literalMember "type" "AccountingBasisSourcePopulation",
    member "events" (sortBasisEventsById events)]

/-- The hash of the source population is the hash of that object. -/
theorem hashAccountingBasisSourcePopulation_eq (events : List BasisSourceEvent) :
    hashAccountingBasisSourcePopulation events = hashCanonical (object (sourcePopulationHashMembers events)) :=
  rfl

/-- The hash of the source population covers every event, each in full (its identifier, kind, date,
reference, copied posting and optional identifiers), in the order of the identifiers, and nothing
else: two populations with equal hashes sort to the same list of events, or a collision of SHA-256 is
in hand. -/
theorem hashAccountingBasisSourcePopulation_inj_or_collision {a b : List BasisSourceEvent}
    (h : hashAccountingBasisSourcePopulation a = hashAccountingBasisSourcePopulation b) :
    sortBasisEventsById a = sortBasisEventsById b ∨ HashCollision := by
  rw [hashAccountingBasisSourcePopulation_eq, hashAccountingBasisSourcePopulation_eq] at h
  rcases hashCanonical_object_inj_or_collision (members₁ := sourcePopulationHashMembers a)
      (members₂ := sourcePopulationHashMembers b) rfl
      (by simp [sourcePopulationHashMembers, member, literalMember])
      (by simp [sourcePopulationHashMembers, literalMember_wf, member_wf])
      (by simp [sourcePopulationHashMembers, literalMember_wf, member_wf]) h with hf | hc
  · left
    simp only [sourcePopulationHashMembers, List.forall₂_cons, List.forall₂_nil_left_iff,
      and_true, member, literalMember, optEquiv_some_canonicalize_iff] at hf
    exact hf.2
  · exact Or.inr hc

/-! ## Records with distinct keys -/

/-- The keys of `requiredDimensionIdsByPosting` are distinct, as the properties of a JavaScript
object are. The Lean vocabulary keeps a list of pairs, which may repeat a key; the canonical value of
such a list is not well formed, and the laws of the hashes are stated for snapshots whose list does
not. -/
def JournalAdmissionSnapshot.KeysDistinct (snapshot : JournalAdmissionSnapshot) : Prop :=
  ∀ entries, snapshot.requiredDimensionIdsByPosting = some entries →
    (entries.map Prod.fst).Nodup

/-- The record of an object whose keys are distinct and whose values are lists of identifiers is
well formed. -/
theorem requiredDimensionIdsByPostingValue_wf :
    ∀ entries : List (String × List DimensionId), (entries.map Prod.fst).Nodup →
      (requiredDimensionIdsByPostingValue entries).WF
  | entries, h => by
    unfold requiredDimensionIdsByPostingValue
    refine ⟨by simpa [Function.comp_def] using h, ?_⟩
    clear h
    induction entries with
    | nil => trivial
    | cons entry rest ih =>
      exact ⟨LawfulCanonicalize.wf entry.2, ih⟩

/-- The canonical value of an admission snapshot with distinct keys is well formed. -/
theorem JournalAdmissionSnapshot.canonicalize_wf {snapshot : JournalAdmissionSnapshot}
    (h : snapshot.KeysDistinct) : (canonicalize snapshot).WF := by
  refine object_wf_of (members := snapshot.canonicalMembers) ?_ ?_
  · simp [JournalAdmissionSnapshot.canonicalMembers, Rastrata.Kernel.member]
  · intro m hm
    simp only [JournalAdmissionSnapshot.canonicalMembers, List.mem_cons, List.not_mem_nil,
      or_false] at hm
    rcases hm with rfl | rfl | rfl | rfl | rfl | rfl | rfl
    · exact member_wf _ _
    · exact member_wf _ _
    · exact member_wf _ _
    · exact member_wf _ _
    · exact member_wf _ _
    · exact member_wf _ _
    · intro value hv
      cases hreq : snapshot.requiredDimensionIdsByPosting with
      | none => simp [hreq] at hv
      | some entries =>
        simp only [hreq, Option.map_some, Option.some.injEq] at hv
        subst hv
        exact requiredDimensionIdsByPostingValue_wf entries (h entries hreq)

/-- The canonical value of a configuration snapshot with distinct keys is well formed. -/
theorem BookConfigurationSnapshot.canonicalize_wf {snapshot : BookConfigurationSnapshot}
    (h : snapshot.admissionSnapshot.KeysDistinct) : (canonicalize snapshot).WF := by
  refine object_wf_of (members := snapshot.canonicalMembers) ?_ ?_
  · simp [BookConfigurationSnapshot.canonicalMembers, Rastrata.Kernel.member, optMember]
  · intro m hm
    simp only [BookConfigurationSnapshot.canonicalMembers, List.mem_cons, List.not_mem_nil,
      or_false] at hm
    rcases hm with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
    · exact member_wf _ _
    · exact member_wf _ _
    · exact optMember_wf _ _
    · exact optMember_wf _ _
    · exact member_wf _ _
    · intro value hv
      simp only [Rastrata.Kernel.member, Option.some.injEq] at hv
      subst hv
      exact JournalAdmissionSnapshot.canonicalize_wf h
    · exact member_wf _ _
    · exact member_wf _ _
    · exact member_wf _ _
    · exact member_wf _ _

/-! ## The hash of the read snapshot -/

/-- The properties `hashAccountingReadSnapshot` hashes (lines 1338 to 1348): the three counters and
hashes, the configuration snapshot, the journals in order of their sequence, the accounting state,
the source population in order of its keys and the events in order of their identifiers. -/
def readSnapshotHashMembers (snapshot : AccountingReadSnapshotBody) : List Member :=
  [member "throughBookRevision" snapshot.throughBookRevision,
    member "throughPostingSequence" snapshot.throughPostingSequence,
    member "policyEffectiveAt" snapshot.policyEffectiveAt,
    member "bookStateHash" snapshot.bookStateHash,
    member "reportPopulationHash" snapshot.reportPopulationHash,
    member "sourcePopulationHash" snapshot.sourcePopulationHash,
    member "configurationSnapshot" snapshot.configurationSnapshot,
    member "journals" (sortBookedJournals snapshot.journals),
    member "accountingState" snapshot.accountingState,
    member "sourcePostingPopulation" (sortSourcePostingPopulation snapshot.sourcePostingPopulation),
    member "sourceEvents" (sortBasisEventsById snapshot.sourceEvents)]

/-- The hash of the read snapshot is the `accountingHash` of that object. -/
theorem hashAccountingReadSnapshot_eq (snapshot : AccountingReadSnapshotBody) :
    hashAccountingReadSnapshot snapshot =
      accountingHash "AccountingReadSnapshot" (object (readSnapshotHashMembers snapshot)) :=
  rfl

/-- The properties `hashAccountingReadPopulation` hashes (lines 1355 to 1363): those of the snapshot
but the report population hash. -/
def readPopulationHashMembers (snapshot : AccountingReadPopulation) : List Member :=
  [member "throughBookRevision" snapshot.throughBookRevision,
    member "throughPostingSequence" snapshot.throughPostingSequence,
    member "policyEffectiveAt" snapshot.policyEffectiveAt,
    member "bookStateHash" snapshot.bookStateHash,
    member "sourcePopulationHash" snapshot.sourcePopulationHash,
    member "configurationSnapshot" snapshot.configurationSnapshot,
    member "journals" (sortBookedJournals snapshot.journals),
    member "accountingState" snapshot.accountingState,
    member "sourcePostingPopulation" (sortSourcePostingPopulation snapshot.sourcePostingPopulation),
    member "sourceEvents" (sortBasisEventsById snapshot.sourceEvents)]

/-- The hash of the report population is the `accountingHash` of that object. -/
theorem hashAccountingReadPopulation_eq (snapshot : AccountingReadPopulation) :
    hashAccountingReadPopulation snapshot =
      accountingHash "AccountingReadPopulation" (object (readPopulationHashMembers snapshot)) :=
  rfl


/-- What the hash of a read snapshot covers, and how: every field but `contentHash`; the journals, the
source population and the events by their sorted lists (so the order the lists came in does not
count, and journals that share a sequence, or references that share a key, or events that share an
identifier, count in the order they came in); the configuration snapshot by its canonical value (so
the order of the entries of its `requiredDimensionIdsByPosting` does not count). -/
structure AccountingReadSnapshotBody.SameHashedContent (a b : AccountingReadSnapshotBody) : Prop where
  throughBookRevision : a.throughBookRevision = b.throughBookRevision
  throughPostingSequence : a.throughPostingSequence = b.throughPostingSequence
  policyEffectiveAt : a.policyEffectiveAt = b.policyEffectiveAt
  bookStateHash : a.bookStateHash = b.bookStateHash
  reportPopulationHash : a.reportPopulationHash = b.reportPopulationHash
  sourcePopulationHash : a.sourcePopulationHash = b.sourcePopulationHash
  configurationSnapshot : (canonicalize a.configurationSnapshot).Equiv
    (canonicalize b.configurationSnapshot)
  journals : sortBookedJournals a.journals = sortBookedJournals b.journals
  accountingState : a.accountingState = b.accountingState
  sourcePostingPopulation : sortSourcePostingPopulation a.sourcePostingPopulation =
    sortSourcePostingPopulation b.sourcePostingPopulation
  sourceEvents : sortBasisEventsById a.sourceEvents = sortBasisEventsById b.sourceEvents

/-- Two snapshot bodies whose configuration snapshots have distinct keys and whose hashes are equal
have the same hashed content (`SameHashedContent`), or a collision of SHA-256 is in hand. -/
theorem hashAccountingReadSnapshot_inj_or_collision {a b : AccountingReadSnapshotBody}
    (ha : a.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (hb : b.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (h : hashAccountingReadSnapshot a = hashAccountingReadSnapshot b) :
    a.SameHashedContent b ∨ HashCollision := by
  rw [hashAccountingReadSnapshot_eq, hashAccountingReadSnapshot_eq] at h
  have hmem : ∀ (s : AccountingReadSnapshotBody),
      s.configurationSnapshot.admissionSnapshot.KeysDistinct →
        ∀ m ∈ readSnapshotHashMembers s, MemberWF m := by
    intro s hs m hm
    simp only [readSnapshotHashMembers, List.mem_cons, List.not_mem_nil, or_false] at hm
    rcases hm with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
    all_goals first
      | exact member_wf _ _
      | (intro value hv
         simp only [Rastrata.Kernel.member, Option.some.injEq] at hv
         subst hv
         exact BookConfigurationSnapshot.canonicalize_wf hs)
  rcases accountingHash_object_inj_or_collision (members₁ := readSnapshotHashMembers a)
      (members₂ := readSnapshotHashMembers b) rfl
      (by simp [readSnapshotHashMembers, Rastrata.Kernel.member])
      (hmem a ha) (hmem b hb) h with ⟨-, hf⟩ | hc
  · left
    simp only [readSnapshotHashMembers, List.forall₂_cons, List.forall₂_nil_left_iff, and_true,
      Rastrata.Kernel.member, optEquiv_some_canonicalize_iff] at hf
    obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11⟩ := hf
    exact ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11⟩
  · exact Or.inr hc

/-- What the hash of a report population covers (`SameHashedContent` of the snapshot, without the
report population hash, which it does not cover). -/
structure AccountingReadPopulation.SameHashedContent (a b : AccountingReadPopulation) : Prop where
  throughBookRevision : a.throughBookRevision = b.throughBookRevision
  throughPostingSequence : a.throughPostingSequence = b.throughPostingSequence
  policyEffectiveAt : a.policyEffectiveAt = b.policyEffectiveAt
  bookStateHash : a.bookStateHash = b.bookStateHash
  sourcePopulationHash : a.sourcePopulationHash = b.sourcePopulationHash
  configurationSnapshot : (canonicalize a.configurationSnapshot).Equiv
    (canonicalize b.configurationSnapshot)
  journals : sortBookedJournals a.journals = sortBookedJournals b.journals
  accountingState : a.accountingState = b.accountingState
  sourcePostingPopulation : sortSourcePostingPopulation a.sourcePostingPopulation =
    sortSourcePostingPopulation b.sourcePostingPopulation
  sourceEvents : sortBasisEventsById a.sourceEvents = sortBasisEventsById b.sourceEvents

/-- Two report populations whose configuration snapshots have distinct keys and whose hashes are equal
have the same hashed content, or a collision of SHA-256 is in hand. -/
theorem hashAccountingReadPopulation_inj_or_collision {a b : AccountingReadPopulation}
    (ha : a.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (hb : b.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (h : hashAccountingReadPopulation a = hashAccountingReadPopulation b) :
    a.SameHashedContent b ∨ HashCollision := by
  rw [hashAccountingReadPopulation_eq, hashAccountingReadPopulation_eq] at h
  have hmem : ∀ (s : AccountingReadPopulation),
      s.configurationSnapshot.admissionSnapshot.KeysDistinct →
        ∀ m ∈ readPopulationHashMembers s, MemberWF m := by
    intro s hs m hm
    simp only [readPopulationHashMembers, List.mem_cons, List.not_mem_nil, or_false] at hm
    rcases hm with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
    all_goals first
      | exact member_wf _ _
      | (intro value hv
         simp only [Rastrata.Kernel.member, Option.some.injEq] at hv
         subst hv
         exact BookConfigurationSnapshot.canonicalize_wf hs)
  rcases accountingHash_object_inj_or_collision (members₁ := readPopulationHashMembers a)
      (members₂ := readPopulationHashMembers b) rfl
      (by simp [readPopulationHashMembers, Rastrata.Kernel.member])
      (hmem a ha) (hmem b hb) h with ⟨-, hf⟩ | hc
  · left
    simp only [readPopulationHashMembers, List.forall₂_cons, List.forall₂_nil_left_iff, and_true,
      Rastrata.Kernel.member, optEquiv_some_canonicalize_iff] at hf
    obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10⟩ := hf
    exact ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10⟩
  · exact Or.inr hc

/-- The hash of the read snapshot does not cover its `contentHash`: it is the hash of the snapshot
that the `contentHash` is. -/
theorem hashAccountingReadSnapshot_ignores_contentHash (snapshot : AccountingReadSnapshot)
    (contentHash : ContentHash) :
    hashAccountingReadSnapshot { snapshot with contentHash }.toAccountingReadSnapshotBody =
      hashAccountingReadSnapshot snapshot.toAccountingReadSnapshotBody :=
  rfl

/-- The hash of the report population does not cover the `reportPopulationHash` or the
`contentHash`. -/
theorem hashAccountingReadPopulation_ignores_hashes (snapshot : AccountingReadSnapshot)
    (reportPopulationHash contentHash : ContentHash) :
    hashAccountingReadPopulation
        { snapshot with reportPopulationHash, contentHash }.toAccountingReadPopulation =
      hashAccountingReadPopulation snapshot.toAccountingReadPopulation :=
  rfl

/-! ## The conditions of the early rejections, as statements -/

/-- The set size of the images of a list under a map is the length of the list exactly when the
images are distinct. -/
theorem setSize_map_eq_length_iff {α β : Type} [DecidableEq β] (f : α → β) (values : List α) :
    setSize (values.map f) = values.length ↔ (values.map f).Nodup := by
  have := setSize_eq_length_iff (values.map f)
  simpa [List.length_map] using this

/-- The identity test of line 1401 holds exactly when two events share an identifier, or an identifier
is blank, or an event lists a settlement allocation identifier twice. -/
theorem populationIdentityRejects_iff (events : List BasisSourceEvent) :
    populationIdentityRejects events = true ↔
      ¬ (events.map (·.id)).Nodup ∨ (∃ event ∈ events, (jsTrim event.id).length = 0) ∨
        ∃ event ∈ events, ∃ ids, event.settlementAllocationIds = some ids ∧ ¬ ids.Nodup := by
  unfold populationIdentityRejects
  simp only [Bool.or_eq_true, decide_eq_true_eq, List.any_eq_true, beq_iff_eq, Ne,
    setSize_map_eq_length_iff]
  constructor
  · rintro (h | ⟨event, hmem, h⟩)
    · exact Or.inl h
    · right
      rcases h with (h | h) | h
      · exact Or.inl ⟨event, hmem, h⟩
      · right
        cases hs : event.settlementAllocationIds with
        | none => simp [hs] at h
        | some ids =>
          simp only [hs, decide_eq_true_eq, setSize_eq_length_iff] at h
          exact ⟨event, hmem, ids, hs, h⟩
      · cases h
  · rintro (h | ⟨event, hmem, h⟩ | ⟨event, hmem, ids, hids, h⟩)
    · exact Or.inl h
    · exact Or.inr ⟨event, hmem, Or.inl (Or.inl h)⟩
    · refine Or.inr ⟨event, hmem, Or.inl (Or.inr ?_)⟩
      simp only [hids, decide_eq_true_eq, setSize_eq_length_iff]
      exact h

/-- The journals of the snapshot have distinct source keys exactly when `uniqueJournalSources`
holds. -/
theorem uniqueJournalSources_iff (ordered : List BookedJournal) :
    uniqueJournalSources ordered = true ↔ (ordered.map bookedSourceKey).Nodup := by
  unfold uniqueJournalSources
  rw [decide_eq_true_eq]
  exact setSize_map_eq_length_iff bookedSourceKey ordered

/-- The classification of the population is complete exactly when the population and the events have
as many source keys, each set of keys has no repeat, and the two sorted lists of keys are equal. -/
theorem completeClassification_iff (snapshot : AccountingReadSnapshot) :
    completeClassification snapshot = true ↔
      (snapshot.sourcePostingPopulation.map canonicalPostingSourceKey).length =
          (snapshot.sourceEvents.map fun event => canonicalPostingSourceKey event.source).length ∧
        (snapshot.sourcePostingPopulation.map canonicalPostingSourceKey).Nodup ∧
        (snapshot.sourceEvents.map fun event => canonicalPostingSourceKey event.source).Nodup ∧
        sortTexts (snapshot.sourcePostingPopulation.map canonicalPostingSourceKey) =
          sortTexts (snapshot.sourceEvents.map fun event => canonicalPostingSourceKey event.source) := by
  unfold completeClassification
  simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq, setSize_eq_length_iff, and_assoc]

/-- Every event's source is in the population under its key, with the same content hash, exactly when
`exactReferenceClassification` holds. -/
theorem exactReferenceClassification_iff (snapshot : AccountingReadSnapshot) :
    exactReferenceClassification snapshot = true ↔
      ∀ event ∈ snapshot.sourceEvents, ∃ populationSource,
        mapLast (snapshot.sourcePostingPopulation.map fun source =>
            (canonicalPostingSourceKey source, source)) (canonicalPostingSourceKey event.source) =
          some populationSource ∧ populationSource.contentHash = event.source.contentHash := by
  unfold exactReferenceClassification
  simp only [List.all_eq_true]
  constructor
  · intro h event hmem
    have hev := h event hmem
    cases hm : mapLast (snapshot.sourcePostingPopulation.map fun source =>
        (canonicalPostingSourceKey source, source)) (canonicalPostingSourceKey event.source) with
    | none => simp [hm] at hev
    | some populationSource =>
      simp only [hm, contentHashEquals_iff] at hev
      exact ⟨populationSource, rfl, hev⟩
  · intro h event hmem
    obtain ⟨populationSource, hm, hhash⟩ := h event hmem
    simp only [hm, contentHashEquals_iff]
    exact hhash

/-- The sources close exactly when every member of the population closes, and every event's source
closes over its copied posting and its accounting date. -/
theorem sourcePopulationCloses_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (ordered : List BookedJournal) :
    sourcePopulationCloses policy snapshot ordered = true ↔
      (∀ source ∈ snapshot.sourcePostingPopulation,
          postingReferenceCloses policy ordered source none none = true) ∧
        ∀ event ∈ snapshot.sourceEvents,
          postingReferenceCloses policy ordered event.source (some event.sourcePosting)
            (some event.accountingDate) = true := by
  unfold sourcePopulationCloses
  simp only [Bool.and_eq_true, List.all_eq_true]

/-- The configuration holds the policy exactly when exactly one of its basis policies has the policy's
identifier and version, and its canonical hash is the policy's. -/
theorem configuredPolicyMatches_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) :
    configuredPolicyMatches policy snapshot = true ↔
      ∃ configured,
        snapshot.configurationSnapshot.accountingPolicySnapshot.policies.filter (fun candidate =>
          candidate.kind == .accountingBasis && candidate.id == policy.id &&
            candidate.version == policy.version) = [configured] ∧
        hashCanonical (canonicalize configured) =
          hashCanonical (canonicalize (AccountingPolicy.accountingBasis policy)) := by
  unfold configuredPolicyMatches
  cases hf : snapshot.configurationSnapshot.accountingPolicySnapshot.policies.filter (fun candidate =>
      candidate.kind == .accountingBasis && candidate.id == policy.id &&
        candidate.version == policy.version) with
  | nil => simp
  | cons configured rest =>
    cases rest with
    | nil =>
      simp only [contentHashEquals_iff, List.cons.injEq, and_true]
      exact ⟨fun h => ⟨configured, rfl, h⟩, fun ⟨c, hc, h⟩ => hc ▸ h⟩
    | cons _ _ => simp

/-- The journals are in place exactly when each journal, at its position in the order of the
sequence, has the sequence one more than the position, a revision within the cutoff, the policy's
book, and the hash of its journal. -/
theorem journalsAreOrdered_iff (policy : AccountingBasisPolicy) (throughBookRevision : Int) :
    ∀ (journals : List BookedJournal) (index : Nat),
      journalsAreOrdered policy throughBookRevision index journals = true ↔
        ∀ (offset : Nat) (booked : BookedJournal), journals[offset]? = some booked →
          booked.postingSequence = ((index + offset + 1 : Nat) : Int) ∧
          booked.bookRevision ≤ throughBookRevision ∧
          booked.journal.bookId = policy.bookId ∧
          booked.canonicalHash = hashCanonical (canonicalJournalValue booked.journal)
  | [], index => by simp [journalsAreOrdered]
  | booked :: rest, index => by
    have ih := journalsAreOrdered_iff policy throughBookRevision rest (index + 1)
    simp only [journalsAreOrdered, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq,
      contentHashEquals_iff, ih]
    constructor
    · rintro ⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩ offset b hb
      cases offset with
      | zero =>
        simp only [List.getElem?_cons_zero, Option.some.injEq] at hb
        subst hb
        exact ⟨by simpa using h1, h2, h3, h4⟩
      | succ k =>
        simp only [List.getElem?_cons_succ] at hb
        have := h5 k b hb
        refine ⟨?_, this.2⟩
        have e : index + 1 + k + 1 = index + (k + 1) + 1 := by omega
        rw [← e]
        exact this.1
    · intro h
      refine ⟨⟨⟨⟨?_, ?_⟩, ?_⟩, ?_⟩, ?_⟩
      · simpa using (h 0 booked (by simp)).1
      · exact (h 0 booked (by simp)).2.1
      · exact (h 0 booked (by simp)).2.2.1
      · exact (h 0 booked (by simp)).2.2.2
      · intro k b hb
        have := h (k + 1) b (by simpa using hb)
        refine ⟨?_, this.2⟩
        have e : index + 1 + k + 1 = index + (k + 1) + 1 := by omega
        rw [e]
        exact this.1


/-- The journals of the snapshot are in place exactly when there are as many as the cutoff sequence
and each journal, at its position in the order of the sequence, has the sequence one more than the
position, a revision within the cutoff, the policy's book and the hash of its journal. -/
theorem journalPopulationValid_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (ordered : List BookedJournal) :
    journalPopulationValid policy snapshot ordered = true ↔
      (ordered.length : Int) = snapshot.throughPostingSequence ∧
        ∀ (offset : Nat) (booked : BookedJournal), ordered[offset]? = some booked →
          booked.postingSequence = ((offset + 1 : Nat) : Int) ∧
          booked.bookRevision ≤ snapshot.throughBookRevision ∧
          booked.journal.bookId = policy.bookId ∧
          booked.canonicalHash = hashCanonical (canonicalJournalValue booked.journal) := by
  unfold journalPopulationValid
  simp only [Bool.and_eq_true, decide_eq_true_eq, journalsAreOrdered_iff, Nat.zero_add]

/-! ## Sorting by a key is canonical when the keys are distinct -/

/-- `left <= right` on strings is the order of the UTF-16 code units: it relates every two strings one
way or the other. -/
theorem jsStringLe_total (a b : String) : (jsStringLe a b || jsStringLe b a) = true := by
  unfold jsStringLe
  have := compareCanonicalText_antisymm b a
  cases h1 : compareCanonicalText a b <;> cases h2 : compareCanonicalText b a <;> simp_all

/-- It is transitive. -/
theorem jsStringLe_trans {a b c : String} (hab : jsStringLe a b = true)
    (hbc : jsStringLe b c = true) : jsStringLe a c = true := by
  unfold jsStringLe at *
  have e1 := compareCanonicalText_eq_iff a b
  have e2 := compareCanonicalText_eq_iff b c
  have e3 := compareCanonicalText_eq_iff a c
  cases h1 : compareCanonicalText a b with
  | gt => simp [h1] at hab
  | lt =>
    cases h2 : compareCanonicalText b c with
    | gt => simp [h2] at hbc
    | lt => simp [compareCanonicalText_trans a b c h1 h2]
    | eq =>
      have hbc' : b = c := e2.mp h2
      subst hbc'
      simp [h1]
  | eq =>
    have hab' : a = b := e1.mp h1
    subst hab'
    simpa using hbc

/-- It is antisymmetric. -/
theorem jsStringLe_antisymm {a b : String} (hab : jsStringLe a b = true)
    (hba : jsStringLe b a = true) : a = b := by
  unfold jsStringLe at *
  have h1 := compareCanonicalText_antisymm a b
  have h2 := compareCanonicalText_eq_iff a b
  cases hc : compareCanonicalText a b <;> simp_all


/-- A stable sort by an order that relates every two elements, transitively, puts two orders of the same
elements in the same list when no two different elements are equivalent for the order. -/
theorem mergeSort_eq_of_perm {α : Type} {le : α → α → Bool}
    (htrans : ∀ a b c, le a b = true → le b c = true → le a c = true)
    (htotal : ∀ a b, (le a b || le b a) = true) {l l' : List α} (hperm : l.Perm l')
    (hanti : ∀ a ∈ l, ∀ b ∈ l, le a b = true → le b a = true → a = b) :
    l.mergeSort le = l'.mergeSort le := by
  have hp : (l.mergeSort le).Perm (l'.mergeSort le) :=
    ((List.mergeSort_perm l le).trans hperm).trans (List.mergeSort_perm l' le).symm
  apply List.Perm.eq_of_pairwise _ (List.pairwise_mergeSort htrans htotal l)
    (List.pairwise_mergeSort htrans htotal l') hp
  intro a b ha hb hab hba
  have ha' : a ∈ l := (List.mergeSort_perm l le).subset ha
  have hb' : b ∈ l := hperm.symm.subset ((List.mergeSort_perm l' le).subset hb)
  exact hanti a ha' b hb' hab hba

/-- Two orders of the same events, with distinct identifiers, sort to the same list. -/
theorem sortBasisEventsById_eq_of_perm {events events' : List BasisSourceEvent}
    (hperm : events.Perm events') (hdistinct : (events.map (·.id)).Nodup) :
    sortBasisEventsById events = sortBasisEventsById events' := by
  unfold sortBasisEventsById
  refine mergeSort_eq_of_perm
    (le := fun left right : BasisSourceEvent => jsStringLe left.id right.id) ?_ ?_ hperm ?_
  · intro a b c hab hbc
    exact jsStringLe_trans hab hbc
  · intro a b
    exact jsStringLe_total _ _
  · intro a ha b hb hab hba
    exact List.inj_on_of_nodup_map hdistinct ha hb (jsStringLe_antisymm hab hba)

/-- Two orders of the same references, with distinct source keys, sort to the same list. -/
theorem sortSourcePostingPopulation_eq_of_perm {population population' : List CanonicalPostingReference}
    (hperm : population.Perm population')
    (hdistinct : (population.map canonicalPostingSourceKey).Nodup) :
    sortSourcePostingPopulation population = sortSourcePostingPopulation population' := by
  unfold sortSourcePostingPopulation
  refine mergeSort_eq_of_perm
    (le := fun left right : CanonicalPostingReference =>
      jsStringLe (canonicalPostingSourceKey left) (canonicalPostingSourceKey right)) ?_ ?_ hperm ?_
  · intro a b c hab hbc
    exact jsStringLe_trans hab hbc
  · intro a b
    exact jsStringLe_total _ _
  · intro a ha b hb hab hba
    exact List.inj_on_of_nodup_map hdistinct ha hb (jsStringLe_antisymm hab hba)


/-- The hash of the source population does not depend on the order of the events, when their
identifiers are distinct. -/
theorem hashAccountingBasisSourcePopulation_perm {events events' : List BasisSourceEvent}
    (hperm : events'.Perm events) (hdistinct : (events.map (·.id)).Nodup) :
    hashAccountingBasisSourcePopulation events' = hashAccountingBasisSourcePopulation events := by
  have h := sortBasisEventsById_eq_of_perm hperm ((hperm.map _).nodup_iff.mpr hdistinct)
  unfold hashAccountingBasisSourcePopulation
  rw [h]

/-- The hash of the read snapshot does not depend on the order of its journals, its source population
or its events, when their sequences, keys and identifiers are distinct. -/
theorem hashAccountingReadSnapshot_perm (body : AccountingReadSnapshotBody)
    (js : List BookedJournal) (ps : List CanonicalPostingReference) (es : List BasisSourceEvent)
    (hj : js.Perm body.journals) (hdj : (body.journals.map (·.postingSequence)).Nodup)
    (hp : ps.Perm body.sourcePostingPopulation)
    (hdp : (body.sourcePostingPopulation.map canonicalPostingSourceKey).Nodup)
    (he : es.Perm body.sourceEvents) (hde : (body.sourceEvents.map (·.id)).Nodup) :
    hashAccountingReadSnapshot
        { body with journals := js, sourcePostingPopulation := ps, sourceEvents := es } =
      hashAccountingReadSnapshot body := by
  have sj := sortBookedJournals_eq_of_perm hj ((hj.map _).nodup_iff.mpr hdj)
  have sp := sortSourcePostingPopulation_eq_of_perm hp ((hp.map _).nodup_iff.mpr hdp)
  have se := sortBasisEventsById_eq_of_perm he ((he.map _).nodup_iff.mpr hde)
  unfold hashAccountingReadSnapshot
  simp only [sj, sp, se]

/-- The same for the hash of the report population. -/
theorem hashAccountingReadPopulation_perm (body : AccountingReadPopulation)
    (js : List BookedJournal) (ps : List CanonicalPostingReference) (es : List BasisSourceEvent)
    (hj : js.Perm body.journals) (hdj : (body.journals.map (·.postingSequence)).Nodup)
    (hp : ps.Perm body.sourcePostingPopulation)
    (hdp : (body.sourcePostingPopulation.map canonicalPostingSourceKey).Nodup)
    (he : es.Perm body.sourceEvents) (hde : (body.sourceEvents.map (·.id)).Nodup) :
    hashAccountingReadPopulation
        { body with journals := js, sourcePostingPopulation := ps, sourceEvents := es } =
      hashAccountingReadPopulation body := by
  have sj := sortBookedJournals_eq_of_perm hj ((hj.map _).nodup_iff.mpr hdj)
  have sp := sortSourcePostingPopulation_eq_of_perm hp ((hp.map _).nodup_iff.mpr hdp)
  have se := sortBasisEventsById_eq_of_perm he ((he.map _).nodup_iff.mpr hde)
  unfold hashAccountingReadPopulation
  simp only [sj, sp, se]

/-- Properties with the same keys, and values equal up to the order of record entries, make records
equal up to that order, entry by entry. -/
theorem equivEntries_objectEntries {members members' : List Member}
    (h : List.Forall₂ (fun m₁ m₂ => m₁.1 = m₂.1 ∧ OptEquiv m₁.2 m₂.2) members members') :
    CanonicalValue.EquivEntries (objectEntries members) (objectEntries members') := by
  induction h with
  | nil => trivial
  | @cons m m' ms ms' hm hrest ih =>
    obtain ⟨k, o⟩ := m
    obtain ⟨k', o'⟩ := m'
    obtain ⟨hk, hv⟩ := hm
    simp only at hk hv
    subst hk
    cases o with
    | none =>
      cases o' with
      | none => simpa [objectEntries] using ih
      | some v' => exact absurd hv (by simp [OptEquiv])
    | some v =>
      cases o' with
      | none => exact absurd hv (by simp [OptEquiv])
      | some v' =>
        simp only [objectEntries, List.filterMap_cons, Option.map_some]
        exact ⟨rfl, hv, ih⟩

/-- Objects whose properties have the same keys, and values equal up to the order of record entries,
are equal up to that order. -/
theorem object_equiv_of_forall₂ {members members' : List Member}
    (h : List.Forall₂ (fun m₁ m₂ => m₁.1 = m₂.1 ∧ OptEquiv m₁.2 m₂.2) members members') :
    (object members).Equiv (object members') :=
  ⟨objectEntries members, List.Perm.refl _, equivEntries_objectEntries h⟩


/-- `accountingHash` of objects whose properties have the same keys and equal values, up to the order
of record entries, is equal. -/
theorem accountingHash_object_eq_of_forall₂ {type : String} {members members' : List Member}
    (hnodup : (members.map Prod.fst).Nodup) (hnodup' : (members'.map Prod.fst).Nodup)
    (hwf : ∀ m ∈ members, MemberWF m) (hwf' : ∀ m ∈ members', MemberWF m)
    (h : List.Forall₂ (fun m₁ m₂ => m₁.1 = m₂.1 ∧ OptEquiv m₁.2 m₂.2) members members') :
    accountingHash type (object members) = accountingHash type (object members') := by
  have hobj : (object members).WF := object_wf_of hnodup hwf
  have hobj' : (object members').WF := object_wf_of hnodup' hwf'
  unfold accountingHash
  apply hashCanonical_eq_of_equiv
  · exact ⟨by simp, trivial, hobj, trivial⟩
  · exact ⟨by simp, trivial, hobj', trivial⟩
  · refine ⟨_, List.Perm.refl _, rfl, CanonicalValue.Equiv_refl _, rfl, object_equiv_of_forall₂ h, trivial⟩


/-- Every property of the hashed object of a read snapshot is well formed. -/
theorem readSnapshotHashMembers_wf (s : AccountingReadSnapshotBody)
    (hs : s.configurationSnapshot.admissionSnapshot.KeysDistinct) :
    ∀ m ∈ readSnapshotHashMembers s, MemberWF m := by
  intro m hm
  simp only [readSnapshotHashMembers, List.mem_cons, List.not_mem_nil, or_false] at hm
  rcases hm with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
  all_goals first
    | exact member_wf _ _
    | (intro value hv
       simp only [Rastrata.Kernel.member, Option.some.injEq] at hv
       subst hv
       exact BookConfigurationSnapshot.canonicalize_wf hs)

/-- The hash of a read snapshot is a function of its hashed content: two snapshot bodies with the
same hashed content (`SameHashedContent`) have the same hash. -/
theorem hashAccountingReadSnapshot_eq_of_sameHashedContent {a b : AccountingReadSnapshotBody}
    (ha : a.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (hb : b.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (h : a.SameHashedContent b) : hashAccountingReadSnapshot a = hashAccountingReadSnapshot b := by
  rw [hashAccountingReadSnapshot_eq, hashAccountingReadSnapshot_eq]
  apply accountingHash_object_eq_of_forall₂ (by simp [readSnapshotHashMembers, Rastrata.Kernel.member])
    (by simp [readSnapshotHashMembers, Rastrata.Kernel.member])
    (readSnapshotHashMembers_wf a ha) (readSnapshotHashMembers_wf b hb)
  simp only [readSnapshotHashMembers, Rastrata.Kernel.member, List.forall₂_cons,
    List.forall₂_nil_left_iff, and_true, true_and, OptEquiv]
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, h.configurationSnapshot, ?_, ?_, ?_, ?_⟩
  · rw [h.throughBookRevision]; exact CanonicalValue.Equiv_refl _
  · rw [h.throughPostingSequence]; exact CanonicalValue.Equiv_refl _
  · rw [h.policyEffectiveAt]; exact CanonicalValue.Equiv_refl _
  · rw [h.bookStateHash]; exact CanonicalValue.Equiv_refl _
  · rw [h.reportPopulationHash]; exact CanonicalValue.Equiv_refl _
  · rw [h.sourcePopulationHash]; exact CanonicalValue.Equiv_refl _
  · rw [h.journals]; exact CanonicalValue.Equiv_refl _
  · rw [h.accountingState]; exact CanonicalValue.Equiv_refl _
  · rw [h.sourcePostingPopulation]; exact CanonicalValue.Equiv_refl _
  · rw [h.sourceEvents]; exact CanonicalValue.Equiv_refl _


/-- Every property of the hashed object of a report population is well formed. -/
theorem readPopulationHashMembers_wf (s : AccountingReadPopulation)
    (hs : s.configurationSnapshot.admissionSnapshot.KeysDistinct) :
    ∀ m ∈ readPopulationHashMembers s, MemberWF m := by
  intro m hm
  simp only [readPopulationHashMembers, List.mem_cons, List.not_mem_nil, or_false] at hm
  rcases hm with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
  all_goals first
    | exact member_wf _ _
    | (intro value hv
       simp only [Rastrata.Kernel.member, Option.some.injEq] at hv
       subst hv
       exact BookConfigurationSnapshot.canonicalize_wf hs)

/-- The hash of a report population is a function of its hashed content. -/
theorem hashAccountingReadPopulation_eq_of_sameHashedContent {a b : AccountingReadPopulation}
    (ha : a.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (hb : b.configurationSnapshot.admissionSnapshot.KeysDistinct)
    (h : a.SameHashedContent b) : hashAccountingReadPopulation a = hashAccountingReadPopulation b := by
  rw [hashAccountingReadPopulation_eq, hashAccountingReadPopulation_eq]
  apply accountingHash_object_eq_of_forall₂ (by simp [readPopulationHashMembers, Rastrata.Kernel.member])
    (by simp [readPopulationHashMembers, Rastrata.Kernel.member])
    (readPopulationHashMembers_wf a ha) (readPopulationHashMembers_wf b hb)
  simp only [readPopulationHashMembers, Rastrata.Kernel.member, List.forall₂_cons,
    List.forall₂_nil_left_iff, and_true, true_and, OptEquiv]
  refine ⟨?_, ?_, ?_, ?_, ?_, h.configurationSnapshot, ?_, ?_, ?_, ?_⟩
  · rw [h.throughBookRevision]; exact CanonicalValue.Equiv_refl _
  · rw [h.throughPostingSequence]; exact CanonicalValue.Equiv_refl _
  · rw [h.policyEffectiveAt]; exact CanonicalValue.Equiv_refl _
  · rw [h.bookStateHash]; exact CanonicalValue.Equiv_refl _
  · rw [h.sourcePopulationHash]; exact CanonicalValue.Equiv_refl _
  · rw [h.journals]; exact CanonicalValue.Equiv_refl _
  · rw [h.accountingState]; exact CanonicalValue.Equiv_refl _
  · rw [h.sourcePostingPopulation]; exact CanonicalValue.Equiv_refl _
  · rw [h.sourceEvents]; exact CanonicalValue.Equiv_refl _

end Rastrata.Kernel

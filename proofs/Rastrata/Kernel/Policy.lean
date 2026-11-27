/-
Booking policy: the Lean model of the functions of `packages/kernel/src/policy.ts`
(`selectBookingPolicy`, `canonicalPolicyValue`, `hashPolicySnapshot`, `canonicalDerivationValue`,
`resolveJournal`, and the type `ResolvedTransaction`). The types, `semanticVersion` and
`instantMillis` are in `Policy/Types.lean`.

This file imports `Valuation.lean` for one thing only: the meaning of an instant in time
(`Instant.exactMillis`, `Instant.ReadTruncated`, `instantMillis_eq_floor`), which was first needed
there.
-/
import Rastrata.Prelude
import Mathlib.Data.List.Dedup
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.NumericLimits
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Policy.Types
import Rastrata.Kernel.Valuation

namespace Rastrata.Kernel

/-! ## `selectBookingPolicy` (`policy.ts` line 122): the model -/

/-- The second argument of `selectBookingPolicy`, an object type without a name in the
TypeScript: the book, the governed economic time and the scope key of what is to be booked. -/
structure GovernedFact where
  bookId : BookId
  governedAt : Instant
  scopeKey : String
  deriving DecidableEq, Repr, Inhabited

/-- The test of the `filter` of `selectBookingPolicy` (lines 128 to 132) on one policy, `at` being
`instantMillis(fact.governedAt)`. The four tests are joined by `&&`, so `instantMillis` is called
on `validFrom` only for a policy of the book and the scope, and on `validTo` only when the policy
has started; either call can throw. -/
def policyApplies (policy : BookingPolicy) (fact : GovernedFact) (at_ : Int) :
    Except TemporalErr Bool :=
  if policy.bookId ≠ fact.bookId then .ok false
  else if policy.scopeKey ≠ fact.scopeKey then .ok false
  else
    match instantMillis policy.validFrom with
    | .error err => .error err
    | .ok validFrom =>
      if ¬ validFrom ≤ at_ then .ok false
      else
        match policy.validTo with
        | none => .ok true
        | some validTo =>
          match instantMillis validTo with
          | .error err => .error err
          | .ok validTo => .ok (decide (at_ < validTo))

/-- `policies.filter(...)` of `selectBookingPolicy` (line 127): the policies that pass the test,
in the order given; the first test that throws ends it. -/
def applicablePolicies (fact : GovernedFact) (at_ : Int) :
    List BookingPolicy → Except TemporalErr (List BookingPolicy)
  | [] => .ok []
  | policy :: rest =>
    match policyApplies policy fact at_ with
    | .error err => .error err
    | .ok applies =>
      match applicablePolicies fact at_ rest with
      | .error err => .error err
      | .ok applicable => .ok (if applies then policy :: applicable else applicable)

/-- The negation of the test of lines 149 to 155: the capability of the policy is supported, is
for the policy's method, scope and implementation version, and has verification evidence. -/
def capabilityExecutable (policy : BookingPolicy) : Bool :=
  decide (policy.capability.status = .supported ∧
    policy.capability.method = policy.lotSelection ∧
    policy.capability.scope = policy.scope ∧
    policy.capability.implementationVersion = policy.implementationVersion ∧
    policy.capability.verificationEvidenceIds.length ≠ 0)

/-- The diagnostic of line 138, for `count` applicable policies. -/
def policyCountDiagnostic (count : Nat) : SemanticDiagnostic :=
  diagnostic .policy_ambiguity "policies"
    ("Expected exactly one applicable policy at the governed economic time; found " ++
      toString count)
    ["ACC-007", "ACC-011", "ACC-013"]

/-- The diagnostic of line 159. -/
def policyCapabilityDiagnostic : SemanticDiagnostic :=
  diagnostic .policy_ambiguity "policies.capability"
    "Applicable policy does not have matching supported executable capability evidence"
    ["ACC-007", "ACC-011"]

/-- `selectBookingPolicy` (`policy.ts` line 122). The `Error` of line 148 is not modelled: it is
thrown only when a list of length one has no first element. -/
def selectBookingPolicy (policies : List BookingPolicy) (fact : GovernedFact) :
    Except TemporalErr PolicyResolution :=
  match instantMillis fact.governedAt with
  | .error err => .error err
  | .ok at_ =>
    match applicablePolicies fact at_ policies with
    | .error err => .error err
    | .ok applicable =>
      match applicable with
      | [policy] =>
        if capabilityExecutable policy then .ok (.resolved policy)
        else .ok (.rejected [policyCapabilityDiagnostic])
      | _ => .ok (.rejected [policyCountDiagnostic applicable.length])

/-! ## Meaning: constructible policies, and when a policy governs a fact -/

/-- What every `PolicyCapability` built from the makers satisfies. -/
structure PolicyCapability.WF (capability : PolicyCapability) : Prop where
  id_wf : capability.id.WF
  implementationVersion_wf : capability.implementationVersion.WF
  verificationEvidenceIds_wf : ∀ id ∈ capability.verificationEvidenceIds, id.WF

/-- What every `BookingPolicy` built from the makers satisfies: its identifiers, versions and
instants are ones that `identifier`, `semanticVersion` and `instant` return. -/
structure BookingPolicy.WF (policy : BookingPolicy) : Prop where
  id_wf : policy.id.WF
  bookId_wf : policy.bookId.WF
  version_wf : policy.version.WF
  validFrom_wf : policy.validFrom.WF
  validTo_wf : ∀ validTo, policy.validTo = some validTo → validTo.WF
  requiredDimensionIds_wf : ∀ id ∈ policy.requiredDimensionIds, id.WF
  implementationVersion_wf : policy.implementationVersion.WF
  capability_wf : policy.capability.WF

/-- What `Date.parse` reads from an instant, in milliseconds (`instantMillis` when it returns). -/
def Instant.readMillis (i : Instant) : Int := i.toFields.dateParseMillis

/-- A policy governs a fact, as `selectBookingPolicy` tests it: the policy is of the fact's book
and scope key, and the governed time, as `Date.parse` reads it, is at or after the policy's
`validFrom` and, when the policy has a `validTo`, before it. -/
def BookingPolicy.governs (policy : BookingPolicy) (fact : GovernedFact) : Bool :=
  decide (policy.bookId = fact.bookId) && decide (policy.scopeKey = fact.scopeKey) &&
    decide (policy.validFrom.readMillis ≤ fact.governedAt.readMillis) &&
    (match policy.validTo with
      | none => true
      | some validTo => decide (fact.governedAt.readMillis < validTo.readMillis))

/-- `governs`, as a statement. -/
theorem BookingPolicy.governs_iff (policy : BookingPolicy) (fact : GovernedFact) :
    policy.governs fact = true ↔
      policy.bookId = fact.bookId ∧ policy.scopeKey = fact.scopeKey ∧
        policy.validFrom.readMillis ≤ fact.governedAt.readMillis ∧
        ∀ validTo, policy.validTo = some validTo →
          fact.governedAt.readMillis < validTo.readMillis := by
  unfold BookingPolicy.governs
  cases policy.validTo with
  | none => simp [and_assoc]
  | some validTo => simp [and_assoc]

/-! ## What `selectBookingPolicy` returns -/

/-- On a constructible policy the test of the filter does not throw and answers whether the
policy governs the fact. -/
theorem policyApplies_ok {policy : BookingPolicy} (hp : policy.WF) (fact : GovernedFact) :
    policyApplies policy fact fact.governedAt.readMillis = .ok (policy.governs fact) := by
  unfold policyApplies BookingPolicy.governs Instant.readMillis
  rw [instantMillis_ok hp.validFrom_wf]
  by_cases hbook : policy.bookId = fact.bookId
  · by_cases hscope : policy.scopeKey = fact.scopeKey
    · by_cases hfrom : policy.validFrom.toFields.dateParseMillis ≤
          fact.governedAt.toFields.dateParseMillis
      · cases hto : policy.validTo with
        | none => simp [hbook, hscope, hfrom]
        | some validTo =>
          simp [hbook, hscope, hfrom, instantMillis_ok (hp.validTo_wf validTo hto)]
      · simp [hbook, hscope, hfrom]
    · simp [hbook, hscope]
  · simp [hbook]

/-- On constructible policies the filter does not throw and keeps exactly the policies that govern
the fact, in the order given. -/
theorem applicablePolicies_ok {policies : List BookingPolicy} (hp : ∀ policy ∈ policies, policy.WF)
    (fact : GovernedFact) :
    applicablePolicies fact fact.governedAt.readMillis policies =
      .ok (policies.filter (·.governs fact)) := by
  induction policies with
  | nil => rfl
  | cons policy rest ih =>
    rw [applicablePolicies, policyApplies_ok (hp policy (by simp)),
      ih (fun q hq => hp q (by simp [hq]))]
    by_cases hg : policy.governs fact = true
    · simp [hg]
    · simp [hg]

/-- What `selectBookingPolicy` answers once it has the policies that govern the fact: that policy
when there is exactly one and its capability is executable, the capability diagnostic when there
is exactly one and it is not, and otherwise the diagnostic that counts them. -/
def resolutionOfGoverning : List BookingPolicy → PolicyResolution
  | [policy] =>
    if capabilityExecutable policy then .resolved policy
    else .rejected [policyCapabilityDiagnostic]
  | found => .rejected [policyCountDiagnostic found.length]

/-- `selectBookingPolicy` on constructible policies and a constructible governed time never
throws, and its answer is read from the list of the policies that govern the fact, in the order
given. -/
theorem selectBookingPolicy_eq {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF) :
    selectBookingPolicy policies fact =
      .ok (resolutionOfGoverning (policies.filter (·.governs fact))) := by
  have happ := applicablePolicies_ok hp fact
  unfold Instant.readMillis at happ
  unfold selectBookingPolicy
  rw [instantMillis_ok hf]
  simp only [happ]
  generalize policies.filter (·.governs fact) = found
  rcases found with _ | ⟨policy, _ | ⟨second, rest⟩⟩
  · rfl
  · by_cases hc : capabilityExecutable policy = true <;> simp [hc, resolutionOfGoverning]
  · rfl

/-- Exactly which policy governs: `selectBookingPolicy` resolves to a policy exactly when that
policy is the only one of the policies given that governs the fact, and its capability is
executable. -/
theorem selectBookingPolicy_resolved_iff {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    (policy : BookingPolicy) :
    selectBookingPolicy policies fact = .ok (.resolved policy) ↔
      policies.filter (·.governs fact) = [policy] ∧ capabilityExecutable policy = true := by
  rw [selectBookingPolicy_eq hp hf]
  generalize policies.filter (·.governs fact) = found
  unfold resolutionOfGoverning
  rcases found with _ | ⟨first, _ | ⟨second, rest⟩⟩
  · simp
  · by_cases hc : capabilityExecutable first = true
    · simp only [hc, ↓reduceIte, Except.ok.injEq, PolicyResolution.resolved.injEq,
        List.cons.injEq, and_true]
      constructor
      · rintro rfl; exact ⟨rfl, hc⟩
      · rintro ⟨rfl, -⟩; rfl
    · simp only [hc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, reduceCtorEq,
        List.cons.injEq, and_true, false_iff, not_and]
      rintro rfl
      exact hc
  · simp

/-- A rejection of `selectBookingPolicy` carries exactly one diagnostic, with the code
`policy_ambiguity`: the one that counts the governing policies when their number is not one
(a missing policy is "found 0", there is no other missing-policy diagnostic), and the capability
diagnostic when the one governing policy has no executable capability. -/
theorem selectBookingPolicy_rejected_iff {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    (diagnostics : List SemanticDiagnostic) :
    selectBookingPolicy policies fact = .ok (.rejected diagnostics) ↔
      ((policies.filter (·.governs fact)).length ≠ 1 ∧
          diagnostics = [policyCountDiagnostic (policies.filter (·.governs fact)).length]) ∨
        (∃ policy, policies.filter (·.governs fact) = [policy] ∧
          capabilityExecutable policy = false ∧ diagnostics = [policyCapabilityDiagnostic]) := by
  rw [selectBookingPolicy_eq hp hf]
  generalize policies.filter (·.governs fact) = found
  unfold resolutionOfGoverning
  rcases found with _ | ⟨first, _ | ⟨second, rest⟩⟩
  · simp only [Except.ok.injEq, PolicyResolution.rejected.injEq]
    constructor
    · rintro rfl; exact Or.inl ⟨by simp, rfl⟩
    · rintro (⟨-, rfl⟩ | ⟨other, hother, -⟩)
      · rfl
      · simp at hother
  · by_cases hc : capabilityExecutable first = true
    · simp [hc]
    · simp only [hc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
        PolicyResolution.rejected.injEq]
      constructor
      · rintro rfl; exact Or.inr ⟨first, rfl, by simpa using hc, rfl⟩
      · rintro (⟨hlen, -⟩ | ⟨other, -, -, rfl⟩)
        · simp at hlen
        · rfl
  · simp only [Except.ok.injEq, PolicyResolution.rejected.injEq]
    constructor
    · rintro rfl; exact Or.inl ⟨by simp, rfl⟩
    · rintro (⟨-, rfl⟩ | ⟨other, hother, -⟩)
      · rfl
      · simp at hother

/-- Soundness: the policy `selectBookingPolicy` resolves to is one of the policies given, governs
the fact, has an executable capability, and every policy given that governs the fact is that
policy; it is in the list once. -/
theorem selectBookingPolicy_resolved {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    {policy : BookingPolicy} (h : selectBookingPolicy policies fact = .ok (.resolved policy)) :
    policy ∈ policies ∧ policy.governs fact = true ∧ capabilityExecutable policy = true ∧
      (∀ other ∈ policies, other.governs fact = true → other = policy) ∧
      policies.count policy = 1 := by
  obtain ⟨hfound, hc⟩ := (selectBookingPolicy_resolved_iff hp hf policy).mp h
  have hmem : ∀ other, other ∈ policies ∧ other.governs fact = true ↔ other = policy := by
    intro other
    have key : other ∈ policies.filter (·.governs fact) ↔
        other ∈ policies ∧ other.governs fact = true := List.mem_filter
    rw [← key, hfound, List.mem_singleton]
  have hcount : policies.count policy = 1 := by
    have h1 : (policies.filter (·.governs fact)).count policy = 1 := by rw [hfound]; simp
    rw [List.count_filter (p := (·.governs fact)) (a := policy) ((hmem policy).mpr rfl).2] at h1
    exact h1
  exact ⟨((hmem policy).mpr rfl).1, ((hmem policy).mpr rfl).2, hc,
    fun other ho hg => (hmem other).mp ⟨ho, hg⟩, hcount⟩

/-- Completeness: a policy that is in the list once, governs the fact, has an executable
capability, and is the only policy of the list that governs the fact, is the one
`selectBookingPolicy` resolves to. -/
theorem selectBookingPolicy_complete {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    {policy : BookingPolicy} (hcount : policies.count policy = 1)
    (hg : policy.governs fact = true) (hc : capabilityExecutable policy = true)
    (honly : ∀ other ∈ policies, other.governs fact = true → other = policy) :
    selectBookingPolicy policies fact = .ok (.resolved policy) := by
  refine (selectBookingPolicy_resolved_iff hp hf policy).mpr ⟨?_, hc⟩
  have hall : ∀ other ∈ policies.filter (·.governs fact), other = policy := by
    intro other ho
    obtain ⟨h1, h2⟩ := List.mem_filter.mp ho
    exact honly other h1 h2
  have hrep := List.eq_replicate_of_mem hall
  have hlen : (policies.filter (·.governs fact)).length = 1 := by
    have h1 : (policies.filter (·.governs fact)).count policy = 1 := by
      rw [List.count_filter (p := (·.governs fact)) (a := policy) hg]; exact hcount
    rw [hrep, List.count_replicate_self] at h1
    exact h1
  rw [hrep, hlen]
  rfl

/-- `selectBookingPolicy` never throws on constructible policies and a constructible governed
time. -/
theorem selectBookingPolicy_isOk {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF) :
    ∃ resolution, selectBookingPolicy policies fact = .ok resolution :=
  ⟨_, selectBookingPolicy_eq hp hf⟩

/-- When no policy given governs the fact the answer is the diagnostic `policy_ambiguity` at
`policies`, "found 0": a missing policy has no diagnostic of its own. -/
theorem selectBookingPolicy_none_governs {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hnone : ∀ policy ∈ policies, policy.governs fact = false) :
    selectBookingPolicy policies fact = .ok (.rejected [policyCountDiagnostic 0]) := by
  rw [selectBookingPolicy_eq hp hf]
  have : policies.filter (·.governs fact) = [] :=
    List.filter_eq_nil_iff.mpr (fun policy hpol => by simp [hnone policy hpol])
  rw [this]
  rfl

/-- When two or more of the policies given govern the fact (the same policy given twice counts
twice) the answer is the diagnostic `policy_ambiguity` at `policies`, with their number. -/
theorem selectBookingPolicy_several_govern {policies : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hmany : 2 ≤ (policies.filter (·.governs fact)).length) :
    selectBookingPolicy policies fact =
      .ok (.rejected [policyCountDiagnostic (policies.filter (·.governs fact)).length]) := by
  rw [selectBookingPolicy_eq hp hf]
  generalize policies.filter (·.governs fact) = found at hmany
  rcases found with _ | ⟨first, _ | ⟨second, rest⟩⟩
  · simp at hmany
  · simp at hmany
  · rfl

/-- The answer of `selectBookingPolicy` does not depend on the order in which the policies are
given. -/
theorem selectBookingPolicy_perm {policies reordered : List BookingPolicy}
    (hp : ∀ policy ∈ policies, policy.WF) {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hperm : policies.Perm reordered) :
    selectBookingPolicy policies fact = selectBookingPolicy reordered fact := by
  rw [selectBookingPolicy_eq hp hf,
    selectBookingPolicy_eq (fun policy hpol => hp policy (hperm.mem_iff.mpr hpol)) hf]
  have hfilter := hperm.filter (·.governs fact)
  generalize policies.filter (·.governs fact) = found at hfilter
  generalize reordered.filter (·.governs fact) = found' at hfilter
  have hlen := hfilter.length_eq
  rcases found with _ | ⟨first, _ | ⟨second, rest⟩⟩
  · rw [List.nil_perm.mp hfilter]
  · rw [List.singleton_perm.mp hfilter]
  · rcases found' with _ | ⟨first', _ | ⟨second', rest'⟩⟩
    · simp at hlen
    · simp at hlen
    · simp only [resolutionOfGoverning, hlen]

/-! ## The validity of a policy, in time

`selectBookingPolicy` compares instants by `instantMillis`, that is by `Date.parse` (lines 126,
131 and 132): `validFrom <= at` and `at < validTo`, never as strings. `Date.parse` answers the
whole milliseconds of an instant read to the millisecond (`instantMillis_eq_floor`), so a
policy's validity is the half-open interval from `validFrom` to `validTo` taken in whole
milliseconds: its start may be honoured up to a millisecond early, its last partial millisecond
is not governed, and an instant that `Date.parse` misreads moves the interval. -/

/-- What `Date.parse` reads from a constructible instant read to the millisecond is the whole
milliseconds of the moment it names. -/
theorem Instant.readMillis_eq_floor {i : Instant} (h : i.WF) (hread : i.ReadTruncated) :
    i.readMillis = ⌊i.exactMillis⌋ :=
  InstantFields.dateParseMillis_eq_floor h.toFields_spec.1.fraction_lt hread

/-- With every instant read to the millisecond, a policy governs a fact exactly when it is of the
fact's book and scope key and the whole milliseconds of the governed time are at or after those
of `validFrom` and before those of `validTo`. -/
theorem BookingPolicy.governs_iff_floor {policy : BookingPolicy} (hp : policy.WF)
    {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hfrom : policy.validFrom.ReadTruncated)
    (hto : ∀ validTo, policy.validTo = some validTo → validTo.ReadTruncated)
    (hat : fact.governedAt.ReadTruncated) :
    policy.governs fact = true ↔
      policy.bookId = fact.bookId ∧ policy.scopeKey = fact.scopeKey ∧
        ⌊policy.validFrom.exactMillis⌋ ≤ ⌊fact.governedAt.exactMillis⌋ ∧
        ∀ validTo, policy.validTo = some validTo →
          ⌊fact.governedAt.exactMillis⌋ < ⌊validTo.exactMillis⌋ := by
  rw [BookingPolicy.governs_iff, Instant.readMillis_eq_floor hp.validFrom_wf hfrom,
    Instant.readMillis_eq_floor hf hat]
  constructor
  · rintro ⟨h1, h2, h3, h4⟩
    refine ⟨h1, h2, h3, fun validTo hv => ?_⟩
    rw [← Instant.readMillis_eq_floor (hp.validTo_wf validTo hv) (hto validTo hv)]
    exact h4 validTo hv
  · rintro ⟨h1, h2, h3, h4⟩
    refine ⟨h1, h2, h3, fun validTo hv => ?_⟩
    rw [Instant.readMillis_eq_floor (hp.validTo_wf validTo hv) (hto validTo hv)]
    exact h4 validTo hv

/-- A governing policy started less than a millisecond after the governed time at the latest, and
the governed time is before the policy's end, every instant being read to the millisecond. -/
theorem BookingPolicy.governs_time {policy : BookingPolicy} (hp : policy.WF)
    {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hfrom : policy.validFrom.ReadTruncated)
    (hto : ∀ validTo, policy.validTo = some validTo → validTo.ReadTruncated)
    (hat : fact.governedAt.ReadTruncated) (h : policy.governs fact = true) :
    policy.validFrom.exactMillis < fact.governedAt.exactMillis + 1 ∧
      ∀ validTo, policy.validTo = some validTo →
        fact.governedAt.exactMillis < validTo.exactMillis := by
  obtain ⟨-, -, h3, h4⟩ := (BookingPolicy.governs_iff_floor hp hf hfrom hto hat).mp h
  refine ⟨?_, fun validTo hv => ?_⟩
  · have h1 : policy.validFrom.exactMillis < ⌊policy.validFrom.exactMillis⌋ + 1 :=
      Int.lt_floor_add_one _
    have h2 : (⌊policy.validFrom.exactMillis⌋ : ℚ) ≤ ⌊fact.governedAt.exactMillis⌋ := by
      exact_mod_cast h3
    have h5 : (⌊fact.governedAt.exactMillis⌋ : ℚ) ≤ fact.governedAt.exactMillis := Int.floor_le _
    linarith
  · exact lt_of_lt_of_le (Int.floor_lt.mp (h4 validTo hv)) (Int.floor_le _)

/-- A policy of the fact's book and scope key that has started at the governed time, and whose
end, if it has one, is a millisecond or more after it, governs the fact, every instant being read
to the millisecond. -/
theorem BookingPolicy.governs_of_time {policy : BookingPolicy} (hp : policy.WF)
    {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hfrom : policy.validFrom.ReadTruncated)
    (hto : ∀ validTo, policy.validTo = some validTo → validTo.ReadTruncated)
    (hat : fact.governedAt.ReadTruncated)
    (hbook : policy.bookId = fact.bookId) (hscope : policy.scopeKey = fact.scopeKey)
    (hstarted : policy.validFrom.exactMillis ≤ fact.governedAt.exactMillis)
    (hnotEnded : ∀ validTo, policy.validTo = some validTo →
      fact.governedAt.exactMillis + 1 ≤ validTo.exactMillis) :
    policy.governs fact = true := by
  refine (BookingPolicy.governs_iff_floor hp hf hfrom hto hat).mpr
    ⟨hbook, hscope, Int.floor_le_floor hstarted, fun validTo hv => ?_⟩
  have h1 : ⌊fact.governedAt.exactMillis⌋ + 1 ≤ ⌊validTo.exactMillis⌋ := by
    rw [← Int.floor_add_one]
    exact Int.floor_le_floor (hnotEnded validTo hv)
  omega

/-- A policy that has ended at the governed time does not govern the fact, every instant being
read to the millisecond. -/
theorem BookingPolicy.not_governs_of_ended {policy : BookingPolicy} (hp : policy.WF)
    {fact : GovernedFact} (hf : fact.governedAt.WF)
    (hfrom : policy.validFrom.ReadTruncated)
    (hto : ∀ validTo, policy.validTo = some validTo → validTo.ReadTruncated)
    (hat : fact.governedAt.ReadTruncated) {validTo : Instant}
    (hv : policy.validTo = some validTo)
    (hended : validTo.exactMillis ≤ fact.governedAt.exactMillis) :
    policy.governs fact = false := by
  by_contra hg
  have := (BookingPolicy.governs_time hp hf hfrom hto hat (by simpa using hg)).2 validTo hv
  linarith

/-! ## Where the validity test disagrees with time -/

/-- A first-in-first-out policy of the book `book` for the scope `scope`, with an executable
capability, valid between the two instants given: the policy of the examples below. -/
def examplePolicy (validFrom : String) (validTo : Option String) : BookingPolicy :=
  { id := ⟨"policy"⟩
    bookId := ⟨"book"⟩
    version := ⟨"1.0.0"⟩
    validFrom := ⟨validFrom⟩
    validTo := validTo.map Instant.mk
    lotSelection := .fifo
    scope := .legalEntity
    scopeKey := "scope"
    requiredDimensionIds := []
    implementationVersion := ⟨"1.0.0"⟩
    capability :=
      { id := ⟨"capability"⟩
        method := .fifo
        scope := .legalEntity
        status := .supported
        implementationVersion := ⟨"1.0.0"⟩
        verificationEvidenceIds := [⟨"evidence"⟩] } }

/-- A fact of the book `book` in the scope `scope`, governed at the instant given. -/
def exampleFact (governedAt : String) : GovernedFact := ⟨⟨"book"⟩, ⟨governedAt⟩, "scope"⟩

/-- A policy governs a fact from 0.8 of a millisecond before the policy starts: both instants are
admitted and read to the millisecond, the governed time is the earlier moment, and the policy is
selected. -/
theorem selectBookingPolicy_governs_before_start :
    instant "2024-01-01T00:00:00.0009Z" = .ok ⟨"2024-01-01T00:00:00.0009Z"⟩ ∧
      instant "2024-01-01T00:00:00.0001Z" = .ok ⟨"2024-01-01T00:00:00.0001Z"⟩ ∧
      (⟨"2024-01-01T00:00:00.0009Z"⟩ : Instant).ReadTruncated ∧
      (⟨"2024-01-01T00:00:00.0001Z"⟩ : Instant).ReadTruncated ∧
      (⟨"2024-01-01T00:00:00.0001Z"⟩ : Instant).exactMillis <
        (⟨"2024-01-01T00:00:00.0009Z"⟩ : Instant).exactMillis ∧
      selectBookingPolicy [examplePolicy "2024-01-01T00:00:00.0009Z" none]
          (exampleFact "2024-01-01T00:00:00.0001Z") =
        .ok (.resolved (examplePolicy "2024-01-01T00:00:00.0009Z" none)) := by
  decide +kernel

/-- A policy does not govern a fact from more than 37 milliseconds after the policy starts,
because `Date.parse` misreads the start: of its fraction `.0123456789` it makes 123 milliseconds.
The answer is "found 0". -/
theorem selectBookingPolicy_misses_started_policy :
    instant "2020-01-01T00:00:00.0123456789Z" = .ok ⟨"2020-01-01T00:00:00.0123456789Z"⟩ ∧
      instant "2020-01-01T00:00:00.05Z" = .ok ⟨"2020-01-01T00:00:00.05Z"⟩ ∧
      (⟨"2020-01-01T00:00:00.0123456789Z"⟩ : Instant).exactMillis + 37 <
        (⟨"2020-01-01T00:00:00.05Z"⟩ : Instant).exactMillis ∧
      selectBookingPolicy [examplePolicy "2020-01-01T00:00:00.0123456789Z" none]
          (exampleFact "2020-01-01T00:00:00.05Z") =
        .ok (.rejected [policyCountDiagnostic 0]) := by
  decide +kernel

/-- A policy governs a fact from more than 37 milliseconds after the policy ended, because
`Date.parse` misreads the end. -/
theorem selectBookingPolicy_governs_after_end :
    instant "2020-01-01T00:00:00.0123456789Z" = .ok ⟨"2020-01-01T00:00:00.0123456789Z"⟩ ∧
      instant "2020-01-01T00:00:00.05Z" = .ok ⟨"2020-01-01T00:00:00.05Z"⟩ ∧
      (⟨"2020-01-01T00:00:00.0123456789Z"⟩ : Instant).exactMillis + 37 <
        (⟨"2020-01-01T00:00:00.05Z"⟩ : Instant).exactMillis ∧
      selectBookingPolicy
          [examplePolicy "2020-01-01T00:00:00Z" (some "2020-01-01T00:00:00.0123456789Z")]
          (exampleFact "2020-01-01T00:00:00.05Z") =
        .ok (.resolved
          (examplePolicy "2020-01-01T00:00:00Z" (some "2020-01-01T00:00:00.0123456789Z"))) := by
  decide +kernel

/-- Two policies that follow one another at a moment written two ways, once with a fraction that
`Date.parse` misreads, both govern a fact between the two readings: the answer is "found 2",
though in time the first has ended. -/
theorem selectBookingPolicy_overlap_by_misreading :
    (⟨"2020-01-01T00:00:00.0123456789Z"⟩ : Instant).exactMillis <
        (⟨"2020-01-01T00:00:00.05Z"⟩ : Instant).exactMillis ∧
      (⟨"2020-01-01T00:00:00.012Z"⟩ : Instant).exactMillis <
        (⟨"2020-01-01T00:00:00.05Z"⟩ : Instant).exactMillis ∧
      selectBookingPolicy
          [examplePolicy "2020-01-01T00:00:00Z" (some "2020-01-01T00:00:00.0123456789Z"),
            examplePolicy "2020-01-01T00:00:00.012Z" none]
          (exampleFact "2020-01-01T00:00:00.05Z") =
        .ok (.rejected [policyCountDiagnostic 2]) := by
  decide +kernel

/-! ## Canonical values: what `Equiv` says about records of a fixed shape

`hashCanonical_inj_or_collision` answers with `CanonicalValue.Equiv`: equal up to the order of the
entries of every record. The canonical values below are records with fixed keys in a fixed order,
so for them `Equiv` is equality entry by entry; these lemmas say so. They are private to this
file so that their names cannot meet another file's. -/

private theorem CanonicalValue.equivEntries_keys {xs ys : List (String × CanonicalValue)}
    (h : CanonicalValue.EquivEntries xs ys) : xs.map Prod.fst = ys.map Prod.fst := by
  induction xs generalizing ys with
  | nil =>
    cases ys with
    | nil => rfl
    | cons y ys => simp [CanonicalValue.EquivEntries] at h
  | cons x xs ih =>
    cases ys with
    | nil => simp [CanonicalValue.EquivEntries] at h
    | cons y ys =>
      obtain ⟨kx, vx⟩ := x
      obtain ⟨ky, vy⟩ := y
      simp only [CanonicalValue.EquivEntries] at h
      simp [h.1, ih h.2.2]

/-- A list of entries with distinct keys has one arrangement for each order of its keys. -/
private theorem perm_eq_of_keys_eq {α : Type} {xs zs : List (String × α)} (hperm : xs.Perm zs)
    (hkeys : xs.map Prod.fst = zs.map Prod.fst) (hnodup : (xs.map Prod.fst).Nodup) : xs = zs := by
  induction xs generalizing zs with
  | nil => exact (List.nil_perm.mp hperm).symm
  | cons x xs ih =>
    cases zs with
    | nil => simp at hkeys
    | cons z zs =>
      simp only [List.map_cons, List.cons.injEq] at hkeys
      simp only [List.map_cons, List.nodup_cons] at hnodup
      have hz : z ∈ x :: xs := hperm.symm.subset (by simp)
      rcases List.mem_cons.mp hz with rfl | hz
      · rw [ih (List.Perm.cons_inv hperm) hkeys.2 hnodup.2]
      · exact absurd (hkeys.1 ▸ List.mem_map_of_mem (f := Prod.fst) hz) hnodup.1

/-- Two records with the same distinct keys in the same order are equal up to the order of
entries only when they are equal up to that order entry by entry. -/
private theorem CanonicalValue.equivEntries_of_equiv_record {xs ys : List (String × CanonicalValue)}
    (hnodup : (xs.map Prod.fst).Nodup) (hkeys : xs.map Prod.fst = ys.map Prod.fst)
    (h : CanonicalValue.Equiv (.record xs) (.record ys)) : CanonicalValue.EquivEntries xs ys := by
  simp only [CanonicalValue.Equiv] at h
  obtain ⟨zs, hperm, hentries⟩ := h
  have hzs := CanonicalValue.equivEntries_keys hentries
  rw [perm_eq_of_keys_eq hperm (hkeys.trans hzs.symm) hnodup]
  exact hentries

/-- Two arrays of strings are equal up to the order of record entries exactly when they are the
same strings in the same order. -/
private theorem CanonicalValue.equivList_strings_iff (xs ys : List String) :
    CanonicalValue.EquivList (xs.map .string) (ys.map .string) ↔ xs = ys := by
  induction xs generalizing ys with
  | nil => cases ys <;> simp [CanonicalValue.EquivList]
  | cons x xs ih =>
    cases ys with
    | nil => simp [CanonicalValue.EquivList]
    | cons y ys => simp [CanonicalValue.EquivList, CanonicalValue.Equiv, ih]

/-! ## `canonicalPolicyValue` (`policy.ts` line 171): the model -/

/-- A lot selection method as the TypeScript writes it: the string literal. -/
def LotSelectionMethod.text : LotSelectionMethod → String
  | .specificIdentification => "specificIdentification"
  | .fifo => "fifo"
  | .lifo => "lifo"
  | .hifo => "hifo"
  | .weightedAverage => "weightedAverage"

/-- A policy scope as the TypeScript writes it: the string literal. -/
def PolicyScope.text : PolicyScope → String
  | .account => "account"
  | .legalEntity => "legalEntity"
  | .jurisdictionPool => "jurisdictionPool"

/-- A capability status as the TypeScript writes it: the string literal. -/
def PolicyCapabilityStatus.text : PolicyCapabilityStatus → String
  | .supported => "supported"
  | .experimental => "experimental"
  | .unsupported => "unsupported"

/-- A derivation state as the TypeScript writes it: the string literal. -/
def DerivationState.text : DerivationState → String
  | .proposed => "proposed"
  | .approved => "approved"
  | .rejected => "rejected"
  | .applied => "applied"

/-- `[...values].sort()` on strings (lines 182 and 190): `Array.prototype.sort` without a
comparator orders strings by UTF-16 code unit, and is stable. -/
def sortTexts (values : List String) : List String := values.mergeSort jsStringLe

/-- The `capability` record of `canonicalPolicyValue` (lines 184 to 191). -/
def canonicalCapabilityValue (capability : PolicyCapability) : CanonicalValue :=
  .record [
    ("id", .string capability.id.value),
    ("method", .string capability.method.text),
    ("scope", .string capability.scope.text),
    ("status", .string capability.status.text),
    ("implementationVersion", .string capability.implementationVersion.value),
    ("verificationEvidenceIds",
      .array ((sortTexts (capability.verificationEvidenceIds.map (·.value))).map .string))]

/-- `canonicalPolicyValue` (`policy.ts` line 171): the same field names in the same order as the
TypeScript object, `null` for a policy without `validTo`. -/
def canonicalPolicyValue (policy : BookingPolicy) : CanonicalValue :=
  .record [
    ("type", .string "BookingPolicy"),
    ("id", .string policy.id.value),
    ("bookId", .string policy.bookId.value),
    ("version", .string policy.version.value),
    ("validFrom", .string policy.validFrom.value),
    ("validTo", match policy.validTo with
      | some validTo => .string validTo.value
      | none => .null),
    ("lotSelection", .string policy.lotSelection.text),
    ("scope", .string policy.scope.text),
    ("scopeKey", .string policy.scopeKey),
    ("requiredDimensionIds",
      .array ((sortTexts (policy.requiredDimensionIds.map (·.value))).map .string)),
    ("implementationVersion", .string policy.implementationVersion.value),
    ("capability", canonicalCapabilityValue policy.capability)]

/-! ## The canonical value of a policy determines the policy -/

theorem LotSelectionMethod.text_injective {a b : LotSelectionMethod} (h : a.text = b.text) :
    a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

theorem PolicyScope.text_injective {a b : PolicyScope} (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

theorem PolicyCapabilityStatus.text_injective {a b : PolicyCapabilityStatus}
    (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

theorem DerivationState.text_injective {a b : DerivationState} (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- JavaScript's `<=` on two strings holds exactly when the first is before the second by UTF-16
code unit, or they are the same string. -/
private theorem jsStringLe_iff' (a b : String) :
    jsStringLe a b = true ↔ compareCanonicalText a b = .lt ∨ a = b := by
  unfold jsStringLe
  have h1 := compareCanonicalText_antisymm b a
  have h2 := compareCanonicalText_eq_iff a b
  cases hc : compareCanonicalText a b
  · simp
  · simp [h2.mp hc]
  · have hne : a ≠ b := fun hab => by rw [h2.mpr hab] at hc; cases hc
    simp [hne]

private theorem jsStringLe_total' (a b : String) : (jsStringLe a b || jsStringLe b a) = true := by
  rw [Bool.or_eq_true, jsStringLe_iff', jsStringLe_iff']
  have h1 := compareCanonicalText_antisymm b a
  have h2 := compareCanonicalText_eq_iff a b
  cases hc : compareCanonicalText a b
  · exact Or.inl (Or.inl rfl)
  · exact Or.inl (Or.inr (h2.mp hc))
  · exact Or.inr (Or.inl (h1.mpr hc))

private theorem jsStringLe_trans' (a b c : String) (hab : jsStringLe a b = true)
    (hbc : jsStringLe b c = true) : jsStringLe a c = true := by
  rw [jsStringLe_iff'] at *
  rcases hab with hab | rfl
  · rcases hbc with hbc | rfl
    · exact Or.inl (compareCanonicalText_trans a b c hab hbc)
    · exact Or.inl hab
  · exact hbc

private theorem jsStringLe_antisymm' {a b : String} (hab : jsStringLe a b = true)
    (hba : jsStringLe b a = true) : a = b := by
  rw [jsStringLe_iff'] at *
  rcases hab with hab | rfl
  · rcases hba with hba | rfl
    · have := (compareCanonicalText_antisymm a b).mp hab
      rw [hba] at this
      cases this
    · rfl
  · rfl

/-- Sorting keeps every string, as many times as it was there. -/
theorem sortTexts_perm (values : List String) : (sortTexts values).Perm values :=
  List.mergeSort_perm values jsStringLe

/-- Two lists of strings sort to the same list exactly when one is a rearrangement of the
other. -/
theorem sortTexts_eq_iff (left right : List String) :
    sortTexts left = sortTexts right ↔ left.Perm right := by
  constructor
  · intro h
    exact (sortTexts_perm left).symm.trans (h ▸ sortTexts_perm right)
  · intro h
    exact List.Perm.eq_of_pairwise (le := fun a b => jsStringLe a b = true)
      (fun a b _ _ hab hba => jsStringLe_antisymm' hab hba)
      (List.pairwise_mergeSort jsStringLe_trans' jsStringLe_total' left)
      (List.pairwise_mergeSort jsStringLe_trans' jsStringLe_total' right)
      ((sortTexts_perm left).trans (h.trans (sortTexts_perm right).symm))

private theorem identifier_eq_of_value {Kind : String} {a b : Identifier Kind}
    (h : a.value = b.value) : a = b := by
  cases a; cases b; simp_all

private theorem semanticVersion_eq_of_value {a b : SemanticVersion} (h : a.value = b.value) :
    a = b := by
  cases a; cases b; simp_all

private theorem instant_eq_of_value {a b : Instant} (h : a.value = b.value) : a = b := by
  cases a; cases b; simp_all

private theorem identifier_value_injective (Kind : String) :
    Function.Injective (fun id : Identifier Kind => id.value) :=
  fun _ _ h => identifier_eq_of_value h

/-- Two capabilities with the same content: every field the same, the verification evidence up to
its order. -/
structure PolicyCapability.SameContent (a b : PolicyCapability) : Prop where
  id : a.id = b.id
  method : a.method = b.method
  scope : a.scope = b.scope
  status : a.status = b.status
  implementationVersion : a.implementationVersion = b.implementationVersion
  verificationEvidenceIds : a.verificationEvidenceIds.Perm b.verificationEvidenceIds

/-- Two policies with the same content: every field the same, the required dimensions and the
verification evidence of the capability up to their order. -/
structure BookingPolicy.SameContent (a b : BookingPolicy) : Prop where
  id : a.id = b.id
  bookId : a.bookId = b.bookId
  version : a.version = b.version
  validFrom : a.validFrom = b.validFrom
  validTo : a.validTo = b.validTo
  lotSelection : a.lotSelection = b.lotSelection
  scope : a.scope = b.scope
  scopeKey : a.scopeKey = b.scopeKey
  requiredDimensionIds : a.requiredDimensionIds.Perm b.requiredDimensionIds
  implementationVersion : a.implementationVersion = b.implementationVersion
  capability : a.capability.SameContent b.capability

/-- Two capabilities whose canonical values are the same up to the order of record entries have
the same content. -/
theorem canonicalCapabilityValue_equiv {a b : PolicyCapability}
    (h : (canonicalCapabilityValue a).Equiv (canonicalCapabilityValue b)) : a.SameContent b := by
  unfold canonicalCapabilityValue at h
  have h := (fun hnodup hkeys => CanonicalValue.equivEntries_of_equiv_record hnodup hkeys h)
    (by simp) rfl
  simp only [CanonicalValue.EquivEntries, CanonicalValue.Equiv,
    CanonicalValue.equivList_strings_iff, sortTexts_eq_iff, and_true, true_and] at h
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := h
  exact ⟨identifier_eq_of_value h1, LotSelectionMethod.text_injective h2,
    PolicyScope.text_injective h3, PolicyCapabilityStatus.text_injective h4,
    semanticVersion_eq_of_value h5,
    (List.map_perm_map_iff (identifier_value_injective _)).mp h6⟩

/-- Two policies whose canonical values are the same up to the order of record entries have the
same content. -/
theorem canonicalPolicyValue_equiv {a b : BookingPolicy}
    (h : (canonicalPolicyValue a).Equiv (canonicalPolicyValue b)) : a.SameContent b := by
  unfold canonicalPolicyValue at h
  have h := (fun hnodup hkeys => CanonicalValue.equivEntries_of_equiv_record hnodup hkeys h)
    (by simp) rfl
  simp only [CanonicalValue.EquivEntries, CanonicalValue.Equiv,
    CanonicalValue.equivList_strings_iff, sortTexts_eq_iff, and_true, true_and] at h
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11⟩ := h
  refine ⟨identifier_eq_of_value h1, identifier_eq_of_value h2, semanticVersion_eq_of_value h3,
    instant_eq_of_value h4, ?_, LotSelectionMethod.text_injective h6,
    PolicyScope.text_injective h7, h8,
    (List.map_perm_map_iff (identifier_value_injective _)).mp h9,
    semanticVersion_eq_of_value h10, canonicalCapabilityValue_equiv h11⟩
  cases ha : a.validTo <;> cases hb : b.validTo <;>
    simp only [ha, hb, CanonicalValue.Equiv] at h5
  · rfl
  · rw [instant_eq_of_value h5]

/-- Two capabilities with the same content have the same canonical value. -/
theorem canonicalCapabilityValue_eq_of_sameContent {a b : PolicyCapability}
    (h : a.SameContent b) : canonicalCapabilityValue a = canonicalCapabilityValue b := by
  unfold canonicalCapabilityValue
  rw [h.id, h.method, h.scope, h.status, h.implementationVersion,
    (sortTexts_eq_iff _ _).mpr (h.verificationEvidenceIds.map (·.value))]

/-- Two policies with the same content have the same canonical value. -/
theorem canonicalPolicyValue_eq_of_sameContent {a b : BookingPolicy} (h : a.SameContent b) :
    canonicalPolicyValue a = canonicalPolicyValue b := by
  unfold canonicalPolicyValue
  rw [h.id, h.bookId, h.version, h.validFrom, h.validTo, h.lotSelection, h.scope, h.scopeKey,
    h.implementationVersion, canonicalCapabilityValue_eq_of_sameContent h.capability,
    (sortTexts_eq_iff _ _).mpr (h.requiredDimensionIds.map (·.value))]

/-- The canonical value of a policy determines the policy: two policies have the same canonical
value exactly when every field is the same, the required dimensions and the capability's
verification evidence up to their order (the two lists are sorted before they are written). -/
theorem canonicalPolicyValue_eq_iff (a b : BookingPolicy) :
    canonicalPolicyValue a = canonicalPolicyValue b ↔ a.SameContent b :=
  ⟨fun h => canonicalPolicyValue_equiv (h ▸ CanonicalValue.Equiv_refl _),
    canonicalPolicyValue_eq_of_sameContent⟩

/-- Two policies with the same content and the same order of required dimensions and of
verification evidence are the same policy. -/
theorem BookingPolicy.SameContent.eq {a b : BookingPolicy} (h : a.SameContent b)
    (hdimensions : a.requiredDimensionIds = b.requiredDimensionIds)
    (hevidence : a.capability.verificationEvidenceIds = b.capability.verificationEvidenceIds) :
    a = b := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, -, h10, ⟨c1, c2, c3, c4, c5, -⟩⟩ := h
  obtain ⟨_, _, _, _, _, _, _, _, _, _, ⟨_, _, _, _, _, _⟩⟩ := a
  obtain ⟨_, _, _, _, _, _, _, _, _, _, ⟨_, _, _, _, _, _⟩⟩ := b
  simp_all

/-- Having the same content is an equivalence: reflexive. -/
theorem BookingPolicy.SameContent.refl (a : BookingPolicy) : a.SameContent a :=
  (canonicalPolicyValue_eq_iff a a).mp rfl

/-- Having the same content is an equivalence: symmetric. -/
theorem BookingPolicy.SameContent.symm {a b : BookingPolicy} (h : a.SameContent b) :
    b.SameContent a :=
  (canonicalPolicyValue_eq_iff b a).mp ((canonicalPolicyValue_eq_iff a b).mpr h).symm

/-- Having the same content is an equivalence: transitive. -/
theorem BookingPolicy.SameContent.trans {a b c : BookingPolicy} (hab : a.SameContent b)
    (hbc : b.SameContent c) : a.SameContent c :=
  (canonicalPolicyValue_eq_iff a c).mp
    (((canonicalPolicyValue_eq_iff a b).mpr hab).trans ((canonicalPolicyValue_eq_iff b c).mpr hbc))

/-- The canonical value of a policy is a well-formed canonical value: no record has a key
twice. -/
theorem canonicalPolicyValue_wf (policy : BookingPolicy) : (canonicalPolicyValue policy).WF := by
  have strings : ∀ texts : List String, CanonicalValue.WFList (texts.map .string) := by
    intro texts
    induction texts with
    | nil => trivial
    | cons text rest ih => exact ⟨trivial, ih⟩
  unfold canonicalPolicyValue canonicalCapabilityValue
  cases policy.validTo <;>
    simp [CanonicalValue.WF, CanonicalValue.WFEntries, strings]

/-- Equal hashes of two policies' canonical values mean the two policies have the same content,
or a collision of SHA-256 is in hand. -/
theorem hashCanonical_canonicalPolicyValue_inj_or_collision {a b : BookingPolicy}
    (h : hashCanonical (canonicalPolicyValue a) = hashCanonical (canonicalPolicyValue b)) :
    a.SameContent b ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (canonicalPolicyValue_wf a) (canonicalPolicyValue_wf b) h
    with hequiv | hcollision
  · exact Or.inl (canonicalPolicyValue_equiv hequiv)
  · exact Or.inr hcollision

/-! ## `hashPolicySnapshot` (`policy.ts` line 195): the model -/

/-- The text `hashPolicySnapshot` sorts a policy by (line 199):
`${id}@${version}:${hashCanonical(canonicalPolicyValue(policy)).digest}`. -/
def policySnapshotKey (policy : BookingPolicy) : String :=
  policy.id.value ++ "@" ++ policy.version.value ++ ":" ++
    (hashCanonical (canonicalPolicyValue policy)).digest

/-- `[...policies].sort((left, right) => compareCanonicalText(key(left), key(right)))` (lines 198
and 199): a stable sort by the key, in UTF-16 code unit order. -/
def sortPoliciesForSnapshot (policies : List BookingPolicy) : List BookingPolicy :=
  policies.mergeSort fun left right => jsStringLe (policySnapshotKey left) (policySnapshotKey right)

/-- The record `hashPolicySnapshot` hashes (lines 196 to 201). -/
def policySnapshotValue (policies : List BookingPolicy) : CanonicalValue :=
  .record [
    ("type", .string "BookingPolicySnapshot"),
    ("policies", .array ((sortPoliciesForSnapshot policies).map canonicalPolicyValue))]

/-- `hashPolicySnapshot` (`policy.ts` line 195). -/
def hashPolicySnapshot (policies : List BookingPolicy) : ContentHash :=
  hashCanonical (policySnapshotValue policies)

/-! ## The hash of a snapshot determines its policies -/

/-- Sorting for the snapshot keeps every policy, as many times as it was there. -/
theorem sortPoliciesForSnapshot_perm (policies : List BookingPolicy) :
    (sortPoliciesForSnapshot policies).Perm policies :=
  List.mergeSort_perm policies _

/-- An array of canonical values each well formed is well formed. -/
private theorem wfList_map {α : Type} (f : α → CanonicalValue) (hf : ∀ a, (f a).WF)
    (values : List α) : CanonicalValue.WFList (values.map f) := by
  induction values with
  | nil => trivial
  | cons value rest ih => exact ⟨hf value, ih⟩

/-- Two arrays written from two lists by the same function are equal up to the order of record
entries only when the two lists have the same length and their members are so, one by one. -/
private theorem forall₂_of_equivList_map {α : Type} (f : α → CanonicalValue) :
    ∀ {xs ys : List α}, CanonicalValue.EquivList (xs.map f) (ys.map f) →
      List.Forall₂ (fun x y => (f x).Equiv (f y)) xs ys
  | [], [], _ => List.Forall₂.nil
  | [], _ :: _, h => by simp [CanonicalValue.EquivList] at h
  | _ :: _, [], h => by simp [CanonicalValue.EquivList] at h
  | x :: xs, y :: ys, h => by
    simp only [List.map_cons, CanonicalValue.EquivList] at h
    exact List.Forall₂.cons h.1 (forall₂_of_equivList_map f h.2)

/-- The record a snapshot hashes is a well-formed canonical value. -/
theorem policySnapshotValue_wf (policies : List BookingPolicy) :
    (policySnapshotValue policies).WF := by
  unfold policySnapshotValue
  simp [CanonicalValue.WF, CanonicalValue.WFEntries, wfList_map _ canonicalPolicyValue_wf]

/-- Two snapshots with the same hash hold, once each is put in the snapshot's order, policies
with the same content one by one; or a collision of SHA-256 is in hand. -/
theorem hashPolicySnapshot_inj_or_collision {left right : List BookingPolicy}
    (h : hashPolicySnapshot left = hashPolicySnapshot right) :
    List.Forall₂ BookingPolicy.SameContent (sortPoliciesForSnapshot left)
        (sortPoliciesForSnapshot right) ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (policySnapshotValue_wf left)
    (policySnapshotValue_wf right) h with hequiv | hcollision
  · left
    unfold policySnapshotValue at hequiv
    have hentries := (fun hnodup hkeys =>
      CanonicalValue.equivEntries_of_equiv_record hnodup hkeys hequiv) (by simp) rfl
    simp only [CanonicalValue.EquivEntries, CanonicalValue.Equiv, and_true, true_and] at hentries
    exact (forall₂_of_equivList_map canonicalPolicyValue hentries).imp
      (fun _ _ hab => canonicalPolicyValue_equiv hab)
  · exact Or.inr hcollision

/-- Two snapshots with the same hash hold the same policies: each is a rearrangement of a list
that matches the other's, policy by policy, in content; or a collision of SHA-256 is in hand. -/
theorem hashPolicySnapshot_same_policies_or_collision {left right : List BookingPolicy}
    (h : hashPolicySnapshot left = hashPolicySnapshot right) :
    (∃ left' right', left.Perm left' ∧ right.Perm right' ∧
      List.Forall₂ BookingPolicy.SameContent left' right') ∨ HashCollision := by
  rcases hashPolicySnapshot_inj_or_collision h with hsame | hcollision
  · exact Or.inl ⟨_, _, (sortPoliciesForSnapshot_perm left).symm,
      (sortPoliciesForSnapshot_perm right).symm, hsame⟩
  · exact Or.inr hcollision

/-- Two texts that end in parts of the same length and are equal end in the same part. -/
private theorem string_append_inj_right {x y d d' : String} (h : x ++ d = y ++ d')
    (hlen : d.length = d'.length) : d = d' := by
  have hlist := congrArg String.toList h
  simp only [String.toList_append] at hlist
  have hl : d.toList.length = d'.toList.length := by
    rw [String.length_toList, String.length_toList]; exact hlen
  exact String.toList_inj.mp (List.append_inj' hlist hl).2

/-- Two policies with the same sort key have canonical values with the same hash: the key ends
in the digest, and a digest has sixty-four characters. -/
theorem policySnapshotKey_hash {a b : BookingPolicy}
    (h : policySnapshotKey a = policySnapshotKey b) :
    hashCanonical (canonicalPolicyValue a) = hashCanonical (canonicalPolicyValue b) := by
  have hd := string_append_inj_right h
    (by rw [(hashCanonical_wf _).digest_length, (hashCanonical_wf _).digest_length])
  simp only [hashCanonical, ContentHash.mk.injEq, true_and] at hd ⊢
  exact hd

/-- Two policies with the same sort key have the same content, or a collision of SHA-256 is in
hand. -/
theorem policySnapshotKey_inj_or_collision {a b : BookingPolicy}
    (h : policySnapshotKey a = policySnapshotKey b) : a.SameContent b ∨ HashCollision :=
  hashCanonical_canonicalPolicyValue_inj_or_collision (policySnapshotKey_hash h)

/-- The policies of a snapshot, once sorted, are in the order of their keys. -/
private theorem sortPoliciesForSnapshot_pairwise (policies : List BookingPolicy) :
    (sortPoliciesForSnapshot policies).Pairwise
      (fun a b => jsStringLe (policySnapshotKey a) (policySnapshotKey b) = true) := by
  unfold sortPoliciesForSnapshot
  exact List.pairwise_mergeSort
    (le := fun left right => jsStringLe (policySnapshotKey left) (policySnapshotKey right))
    (fun a b c hab hbc => jsStringLe_trans' (policySnapshotKey a) (policySnapshotKey b)
      (policySnapshotKey c) hab hbc)
    (fun a b => jsStringLe_total' (policySnapshotKey a) (policySnapshotKey b)) policies

/-- The hash of a snapshot does not depend on the order in which its policies are given, unless a
collision of SHA-256 is in hand (two policies with different content and the same sort key keep
the order they were given in, and their key ends in the digest of their content). -/
theorem hashPolicySnapshot_perm {left right : List BookingPolicy} (hperm : left.Perm right) :
    hashPolicySnapshot left = hashPolicySnapshot right ∨ HashCollision := by
  by_cases hcollision : HashCollision
  · exact Or.inr hcollision
  · left
    have hkey : ∀ a b, policySnapshotKey a = policySnapshotKey b →
        canonicalPolicyValue a = canonicalPolicyValue b := fun a b h =>
      (canonicalPolicyValue_eq_iff a b).mpr
        ((policySnapshotKey_inj_or_collision h).resolve_right hcollision)
    have hpairs : (sortPoliciesForSnapshot left).map
          (fun p => (policySnapshotKey p, canonicalPolicyValue p)) =
        (sortPoliciesForSnapshot right).map
          (fun p => (policySnapshotKey p, canonicalPolicyValue p)) := by
      apply List.Perm.eq_of_pairwise
        (le := fun (x y : String × CanonicalValue) => jsStringLe x.1 y.1 = true)
      · intro x y hx hy hxy hyx
        obtain ⟨p, -, rfl⟩ := List.mem_map.mp hx
        obtain ⟨q, -, rfl⟩ := List.mem_map.mp hy
        have hk : policySnapshotKey p = policySnapshotKey q := jsStringLe_antisymm' hxy hyx
        rw [hk, hkey p q hk]
      · rw [List.pairwise_map]
        exact sortPoliciesForSnapshot_pairwise left
      · rw [List.pairwise_map]
        exact sortPoliciesForSnapshot_pairwise right
      · exact ((sortPoliciesForSnapshot_perm left).trans
          (hperm.trans (sortPoliciesForSnapshot_perm right).symm)).map _
    have hmap := congrArg (List.map Prod.snd) hpairs
    simp only [List.map_map, Function.comp_def] at hmap
    unfold hashPolicySnapshot policySnapshotValue
    rw [hmap]

/-! ## `canonicalDerivationValue` (`policy.ts` line 204): the model -/

/-- The record written for a content hash (lines 211 to 215 and 226 to 230): its three fields,
read one by one. -/
def canonicalContentHashValue (hash : ContentHash) : CanonicalValue :=
  .record [
    ("algorithm", .string hash.algorithm),
    ("canonicalizationVersion", .string hash.canonicalizationVersion),
    ("digest", .string hash.digest)]

/-- The record written for one item of evidence (lines 221 to 231); the same record is hashed
for the sort key (line 220). -/
def canonicalEvidenceValue (evidence : SourceEvidence) : CanonicalValue :=
  .record [
    ("id", .string evidence.id.value),
    ("sourceSystem", .string evidence.sourceSystem),
    ("sourceRecordId", .string evidence.sourceRecordId),
    ("observedAt", .string evidence.observedAt.value),
    ("contentHash", canonicalContentHashValue evidence.contentHash)]

/-- The text `canonicalDerivationValue` sorts an item of evidence by (line 220):
`${id}:${hashCanonical(record).digest}`. -/
def evidenceSortKey (evidence : SourceEvidence) : String :=
  evidence.id.value ++ ":" ++ (hashCanonical (canonicalEvidenceValue evidence)).digest

/-- `[...derivation.evidence].sort(...)` (lines 219 and 220): a stable sort by the key, in UTF-16
code unit order. -/
def sortEvidence (evidence : List SourceEvidence) : List SourceEvidence :=
  evidence.mergeSort fun left right => jsStringLe (evidenceSortKey left) (evidenceSortKey right)

/-- `canonicalDerivationValue` (`policy.ts` line 204): the same field names in the same order as
the TypeScript object. -/
def canonicalDerivationValue (derivation : DerivationRecord) : CanonicalValue :=
  .record [
    ("type", .string "DerivationRecord"),
    ("id", .string derivation.id.value),
    ("policyId", .string derivation.policyId.value),
    ("policyVersion", .string derivation.policyVersion.value),
    ("algorithmVersion", .string derivation.algorithmVersion.value),
    ("inputHash", canonicalContentHashValue derivation.inputHash),
    ("actorId", .string derivation.actorId.value),
    ("state", .string derivation.state.text),
    ("recordedAt", .string derivation.recordedAt.value),
    ("evidence", .array ((sortEvidence derivation.evidence).map canonicalEvidenceValue))]

/-! ## The canonical value of a derivation determines the derivation -/

/-- Two content hashes whose records are the same up to the order of entries are the same. -/
theorem canonicalContentHashValue_equiv {a b : ContentHash}
    (h : (canonicalContentHashValue a).Equiv (canonicalContentHashValue b)) : a = b := by
  unfold canonicalContentHashValue at h
  have h := (fun hnodup hkeys => CanonicalValue.equivEntries_of_equiv_record hnodup hkeys h)
    (by simp) rfl
  simp only [CanonicalValue.EquivEntries, CanonicalValue.Equiv, and_true, true_and] at h
  obtain ⟨h1, h2, h3⟩ := h
  cases a; cases b; simp_all

/-- Two items of evidence whose records are the same up to the order of entries are the same
item: the record covers every field. -/
theorem canonicalEvidenceValue_equiv {a b : SourceEvidence}
    (h : (canonicalEvidenceValue a).Equiv (canonicalEvidenceValue b)) : a = b := by
  unfold canonicalEvidenceValue at h
  have h := (fun hnodup hkeys => CanonicalValue.equivEntries_of_equiv_record hnodup hkeys h)
    (by simp) rfl
  simp only [CanonicalValue.EquivEntries, CanonicalValue.Equiv, and_true, true_and] at h
  obtain ⟨h1, h2, h3, h4, h5⟩ := h
  have h1 := identifier_eq_of_value h1
  have h4 := instant_eq_of_value h4
  have h5 := canonicalContentHashValue_equiv h5
  cases a; cases b; simp_all

/-- Sorting the evidence keeps every item, as many times as it was there. -/
theorem sortEvidence_perm (evidence : List SourceEvidence) :
    (sortEvidence evidence).Perm evidence :=
  List.mergeSort_perm evidence _

/-- Two derivations with the same content: every field the same, the evidence up to its order. -/
structure DerivationRecord.SameContent (a b : DerivationRecord) : Prop where
  id : a.id = b.id
  policyId : a.policyId = b.policyId
  policyVersion : a.policyVersion = b.policyVersion
  algorithmVersion : a.algorithmVersion = b.algorithmVersion
  inputHash : a.inputHash = b.inputHash
  actorId : a.actorId = b.actorId
  state : a.state = b.state
  recordedAt : a.recordedAt = b.recordedAt
  evidence : a.evidence.Perm b.evidence

/-- Two derivations whose canonical values are the same up to the order of record entries have
the same content: the canonical value covers every field, the evidence up to its order. -/
theorem canonicalDerivationValue_equiv {a b : DerivationRecord}
    (h : (canonicalDerivationValue a).Equiv (canonicalDerivationValue b)) : a.SameContent b := by
  unfold canonicalDerivationValue at h
  have h := (fun hnodup hkeys => CanonicalValue.equivEntries_of_equiv_record hnodup hkeys h)
    (by simp) rfl
  simp only [CanonicalValue.EquivEntries, CanonicalValue.Equiv, and_true, true_and] at h
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9⟩ := h
  have hsorted : sortEvidence a.evidence = sortEvidence b.evidence := by
    have hall := (forall₂_of_equivList_map canonicalEvidenceValue h9).imp
      (fun _ _ hab => canonicalEvidenceValue_equiv hab)
    rw [List.forall₂_eq_eq_eq] at hall
    exact hall
  exact ⟨identifier_eq_of_value h1, identifier_eq_of_value h2, semanticVersion_eq_of_value h3,
    semanticVersion_eq_of_value h4, canonicalContentHashValue_equiv h5,
    identifier_eq_of_value h6, DerivationState.text_injective h7, instant_eq_of_value h8,
    (sortEvidence_perm a.evidence).symm.trans (hsorted ▸ sortEvidence_perm b.evidence)⟩

/-- The canonical value of a derivation determines the derivation: two derivations with the same
canonical value have every field the same, the evidence up to its order. -/
theorem canonicalDerivationValue_inj {a b : DerivationRecord}
    (h : canonicalDerivationValue a = canonicalDerivationValue b) : a.SameContent b :=
  canonicalDerivationValue_equiv (h ▸ CanonicalValue.Equiv_refl _)

/-- Two derivations with the same content and the same order of evidence are the same
derivation. -/
theorem DerivationRecord.SameContent.eq {a b : DerivationRecord} (h : a.SameContent b)
    (hevidence : a.evidence = b.evidence) : a = b := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, -⟩ := h
  cases a; cases b; simp_all

/-- The record of a content hash is a well-formed canonical value. -/
theorem canonicalContentHashValue_wf (hash : ContentHash) :
    (canonicalContentHashValue hash).WF := by
  unfold canonicalContentHashValue
  simp [CanonicalValue.WF, CanonicalValue.WFEntries]

/-- The record of an item of evidence is a well-formed canonical value. -/
theorem canonicalEvidenceValue_wf (evidence : SourceEvidence) :
    (canonicalEvidenceValue evidence).WF := by
  have := canonicalContentHashValue_wf evidence.contentHash
  unfold canonicalEvidenceValue
  simp [CanonicalValue.WF, CanonicalValue.WFEntries, this]

/-- The canonical value of a derivation is a well-formed canonical value. -/
theorem canonicalDerivationValue_wf (derivation : DerivationRecord) :
    (canonicalDerivationValue derivation).WF := by
  have := canonicalContentHashValue_wf derivation.inputHash
  unfold canonicalDerivationValue
  simp [CanonicalValue.WF, CanonicalValue.WFEntries, this,
    wfList_map _ canonicalEvidenceValue_wf]

/-- Equal hashes of two derivations' canonical values mean the two derivations have the same
content, or a collision of SHA-256 is in hand. -/
theorem hashCanonical_canonicalDerivationValue_inj_or_collision {a b : DerivationRecord}
    (h : hashCanonical (canonicalDerivationValue a) =
      hashCanonical (canonicalDerivationValue b)) :
    a.SameContent b ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (canonicalDerivationValue_wf a)
    (canonicalDerivationValue_wf b) h with hequiv | hcollision
  · exact Or.inl (canonicalDerivationValue_equiv hequiv)
  · exact Or.inr hcollision

/-- Two items of evidence with the same sort key are the same item, or a collision of SHA-256 is
in hand. -/
theorem evidenceSortKey_inj_or_collision {a b : SourceEvidence}
    (h : evidenceSortKey a = evidenceSortKey b) : a = b ∨ HashCollision := by
  have hd := string_append_inj_right h
    (by rw [(hashCanonical_wf _).digest_length, (hashCanonical_wf _).digest_length])
  have hhash : hashCanonical (canonicalEvidenceValue a) =
      hashCanonical (canonicalEvidenceValue b) := by
    simp only [hashCanonical, ContentHash.mk.injEq, true_and] at hd ⊢
    exact hd
  rcases hashCanonical_inj_or_collision (canonicalEvidenceValue_wf a)
    (canonicalEvidenceValue_wf b) hhash with hequiv | hcollision
  · exact Or.inl (canonicalEvidenceValue_equiv hequiv)
  · exact Or.inr hcollision

/-- Two derivations with the same content have the same canonical value, whatever the order of
their evidence, unless a collision of SHA-256 is in hand. -/
theorem canonicalDerivationValue_eq_of_sameContent {a b : DerivationRecord}
    (h : a.SameContent b) :
    canonicalDerivationValue a = canonicalDerivationValue b ∨ HashCollision := by
  by_cases hcollision : HashCollision
  · exact Or.inr hcollision
  · left
    have sorted : ∀ evidence : List SourceEvidence, (sortEvidence evidence).Pairwise
        (fun x y => jsStringLe (evidenceSortKey x) (evidenceSortKey y) = true) := by
      intro evidence
      unfold sortEvidence
      exact List.pairwise_mergeSort
        (le := fun left right => jsStringLe (evidenceSortKey left) (evidenceSortKey right))
        (fun x y z hxy hyz => jsStringLe_trans' (evidenceSortKey x) (evidenceSortKey y)
          (evidenceSortKey z) hxy hyz)
        (fun x y => jsStringLe_total' (evidenceSortKey x) (evidenceSortKey y)) evidence
    have hsorted : sortEvidence a.evidence = sortEvidence b.evidence :=
      List.Perm.eq_of_pairwise
        (le := fun x y => jsStringLe (evidenceSortKey x) (evidenceSortKey y) = true)
        (fun x y _ _ hxy hyx =>
          (evidenceSortKey_inj_or_collision (jsStringLe_antisymm' hxy hyx)).resolve_right
            hcollision)
        (sorted a.evidence) (sorted b.evidence)
        ((sortEvidence_perm a.evidence).trans
          (h.evidence.trans (sortEvidence_perm b.evidence).symm))
    unfold canonicalDerivationValue
    rw [h.id, h.policyId, h.policyVersion, h.algorithmVersion, h.inputHash, h.actorId, h.state,
      h.recordedAt, hsorted]

/-! ## `resolveJournal` (`policy.ts` line 235): the model

`resolveJournal` calls `quantizeBalancedBookValues` and `hashQuantizationPolicy` and reads four
fields of a `QuantizationPolicy`. Those belong to the model of `quantization.ts`
(`QuantizationBalanced.lean`), which this file does not import; so the model is written over a
type `QP` of quantization policies and a `QuantizationInterface` that supplies what is read and
called. Everything else of `resolveJournal` is modelled here. -/

/-- One element of the list form of the argument `governedScope`. -/
structure ScopeApplication where
  postingId : PostingId
  scopeKey : String
  deriving DecidableEq, Repr, Inhabited

/-- The argument `governedScope`: one scope key for every posting, or a list that names a scope
key for each posting. -/
inductive GovernedScope where
  | all (scopeKey : String)
  | each (applications : List ScopeApplication)
  deriving DecidableEq, Repr, Inhabited

/-- What `resolveJournal` reads of a `BalancedQuantizationResult`: the book values and the
rounding posting (its account and its book value) when quantized, the diagnostics when
rejected. -/
inductive BalancedOutcome where
  | quantized (bookValues : List BookValue) (roundingPosting : Option (AccountId × BookValue))
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- The parts of `quantization.ts` that `resolveJournal` uses: four fields of a quantization
policy, `hashQuantizationPolicy`, and `quantizeBalancedBookValues` (which may throw an `E`). -/
structure QuantizationInterface (QP E : Type) where
  bookId : QP → BookId
  functionalCommodityId : QP → CommodityId
  validFrom : QP → LocalDate
  validTo : QP → Option LocalDate
  hashQuantizationPolicy : QP → ContentHash
  quantizeBalancedBookValues :
    List ExactRational → BookId → CommodityId → QP → Except E BalancedOutcome

/-- `ResolvedTransaction`, over the type of quantization policies. -/
structure ResolvedTransaction (QP : Type) where
  journal : JournalTransaction
  policyApplications : List PolicyApplication
  policySnapshotHash : ContentHash
  quantizationPolicy : QP
  quantizationPolicySnapshotHash : ContentHash
  exactBookValues : List ExactRational
  derivations : List DerivationRecord

/-- The result of `resolveJournal` when it does not throw, `ResolvedTransaction | readonly
SemanticDiagnostic[]` in the TypeScript. -/
inductive JournalResolution (QP : Type) where
  | resolved (transaction : ResolvedTransaction QP)
  | rejected (diagnostics : List SemanticDiagnostic)

/-- What `resolveJournal` throws: the `RangeError` of `instantMillis`; the `TypeError` of line 267
when it reads `accountId` of a posting that `find` did not find; an `ExactNumberError` of
`toRational`; or whatever `quantizeBalancedBookValues` throws. -/
inductive ResolveErr (E : Type) where
  | instant (err : TemporalErr)
  | postingNotFound
  | exactNumber (code : NumErr)
  | quantization (err : E)

/-- The diagnostic of line 253. -/
def governedScopeDiagnostic : SemanticDiagnostic :=
  diagnostic .policy_ambiguity "governedScope"
    "Policy scope must resolve exactly once for every canonical posting"
    ["ACC-007", "ACC-011", "ACC-018", "ACC-038"]

/-- The diagnostic of line 268. -/
def accountScopeDiagnostic : SemanticDiagnostic :=
  diagnostic .policy_ambiguity "governedScope"
    "Account-scoped policy must govern the posting account identity"
    ["ACC-007", "ACC-011", "ACC-026"]

/-- The diagnostic of line 285, for the key `${id}@${version}`. -/
def policyIdentityConflictDiagnostic (key : String) : SemanticDiagnostic :=
  diagnostic .canonical_identity_conflict "policies"
    ("Policy identity " ++ key ++ " has conflicting complete content") ["ACC-011", "ACC-038"]

/-- The diagnostic of line 297. -/
def quantizationPolicyDiagnostic : SemanticDiagnostic :=
  diagnostic .policy_ambiguity "quantizationPolicy"
    "Quantization policy is not applicable to this book, commodity, and accounting date"
    ["ACC-003", "ACC-011", "ACC-013", "ACC-026"]

/-- The diagnostic of line 318. -/
def postingOrdinalDiagnostic : SemanticDiagnostic :=
  diagnostic .invalid_journal_structure "journal.postings"
    "Posting ordinals must be unique before resolving their quantized values"
    ["ACC-018", "ACC-019"]

/-- The diagnostic of line 336. -/
def quantizationReproductionDiagnostic : SemanticDiagnostic :=
  diagnostic .journal_imbalance "journal.postings"
    "Booked values and any rounding posting do not reproduce the pinned quantization policy"
    ["ACC-003", "ACC-005", "ACC-011"]

/-- The diagnostic of line 350, for the derivation at `index`. -/
def derivationPolicyDiagnostic (index : Nat) : SemanticDiagnostic :=
  diagnostic .policy_ambiguity ("derivations[" ++ toString index ++ "].policyId")
    "Derivation does not identify the policy selected for the governed economic time"
    ["ACC-011", "ACC-017"]

/-- The diagnostic of line 360, for the derivation at `index`. -/
def derivationApprovalDiagnostic (index : Nat) : SemanticDiagnostic :=
  diagnostic .unresolved_accounting_input ("derivations[" ++ toString index ++ "]")
    "A canonical derivation must be approved and retain at least one evidence item"
    ["ACC-005", "ACC-017"]

/-- The diagnostic of line 379, for the derivation at `index` and an evidence identifier. -/
def evidenceConflictDiagnostic (index : Nat) (id : EvidenceId) : SemanticDiagnostic :=
  diagnostic .canonical_identity_conflict ("derivations[" ++ toString index ++ "].evidence")
    ("Evidence identifier " ++ id.value ++ " resolves to conflicting content")
    ["ACC-017", "ACC-038"]

/-- `suppliedApplications` (lines 244 to 246): the one scope key for every posting, in the order
of the postings, or the list as given. -/
def suppliedApplications (journal : JournalTransaction) : GovernedScope → List ScopeApplication
  | .all scopeKey => journal.postings.map fun posting => ⟨posting.id, scopeKey⟩
  | .each applications => applications

/-- The negation of the test of lines 247 to 251: there are as many applications as postings, as
many different posting identifiers among them (the size of the `Set`), and every posting's
identifier is among them. -/
def scopeResolvesOnce (journal : JournalTransaction) (supplied : List ScopeApplication) : Bool :=
  decide (supplied.length = journal.postings.length) &&
    decide ((supplied.map (·.postingId)).dedup.length = journal.postings.length) &&
    journal.postings.all fun posting =>
      supplied.any fun application => decide (application.postingId = posting.id)

/-- What the loop of lines 258 to 278 has built when it ends: the diagnostics pushed, the policies
selected and the policy applications, each in the order of the applications. -/
structure PolicySelection where
  diagnostics : List SemanticDiagnostic
  selected : List BookingPolicy
  applications : List PolicyApplication
  deriving DecidableEq, Repr, Inhabited

/-- The fact `resolveJournal` asks `selectBookingPolicy` about for one application (lines 259 to
263): the journal's book, its economic time, the application's scope key. -/
def applicationFact (journal : JournalTransaction) (application : ScopeApplication) :
    GovernedFact :=
  ⟨journal.bookId, journal.economicAt, application.scopeKey⟩

/-- The loop of lines 258 to 278. For a resolved policy, `find` looks the posting up (line 266);
`posting.accountId` is read only for an account-scoped policy, and throws a `TypeError` when
`find` found nothing. -/
def selectForApplications {E : Type} (journal : JournalTransaction)
    (policies : List BookingPolicy) :
    List ScopeApplication → Except (ResolveErr E) PolicySelection
  | [] => .ok ⟨[], [], []⟩
  | application :: rest =>
    match selectBookingPolicy policies (applicationFact journal application) with
    | .error err => .error (.instant err)
    | .ok (.rejected diagnostics) =>
      match selectForApplications journal policies rest with
      | .error err => .error err
      | .ok tail => .ok { tail with diagnostics := diagnostics ++ tail.diagnostics }
    | .ok (.resolved policy) =>
      let accountDiagnostics : Except (ResolveErr E) (List SemanticDiagnostic) :=
        if policy.scope = .account then
          match journal.postings.find? (fun candidate => candidate.id = application.postingId) with
          | none => .error .postingNotFound
          | some posting =>
            .ok (if policy.scopeKey ≠ posting.accountId.value then [accountScopeDiagnostic] else [])
        else .ok []
      match accountDiagnostics with
      | .error err => .error err
      | .ok diagnostics =>
        match selectForApplications journal policies rest with
        | .error err => .error err
        | .ok tail =>
          .ok
            { diagnostics := diagnostics ++ tail.diagnostics
              selected := policy :: tail.selected
              applications :=
                ⟨application.postingId, application.scopeKey, policy.id, policy.version⟩ ::
                  tail.applications }

/-- The key of the map `selectedByIdentity` (line 282): `${id}@${version}`. -/
def policyIdentityKey (policy : BookingPolicy) : String :=
  policy.id.value ++ "@" ++ policy.version.value

/-- `Map.prototype.set` on a map kept as its entries in insertion order: a key already there
keeps its place and gets the new value, a new key goes to the end. -/
def identityMapSet (entries : List (String × BookingPolicy)) (key : String)
    (policy : BookingPolicy) : List (String × BookingPolicy) :=
  if entries.any (fun entry => entry.1 = key) then
    entries.map fun entry => if entry.1 = key then (key, policy) else entry
  else entries ++ [(key, policy)]

/-- The loop of lines 281 to 288 from a map already built: the key of the conflict it returns
with (`inl`), or the map at the end (`inr`). `JSON.stringify(a) !== JSON.stringify(b)` on two
canonical policy values is modelled as `a ≠ b`: both are records with the same keys in the same
order whose leaves are strings, `null` and arrays of strings, and `JSON.stringify` writes two
such values to the same text only when they are equal. -/
def selectedByIdentity :
    List (String × BookingPolicy) → List BookingPolicy → String ⊕ List (String × BookingPolicy)
  | entries, [] => .inr entries
  | entries, selected :: rest =>
    match entries.find? (fun entry => entry.1 = policyIdentityKey selected) with
    | some existing =>
      if canonicalPolicyValue existing.2 ≠ canonicalPolicyValue selected then
        .inl (policyIdentityKey selected)
      else selectedByIdentity (identityMapSet entries (policyIdentityKey selected) selected) rest
    | none => selectedByIdentity (identityMapSet entries (policyIdentityKey selected) selected) rest

/-- The negation of the test of lines 290 to 295: the quantization policy is of the journal's book
and functional commodity, and the accounting date is not before its `validFrom` and, when it has
a `validTo`, before it. The two dates are compared as strings (`>` and `>=`). -/
def quantizationPolicyApplies {QP E : Type} (quantization : QuantizationInterface QP E)
    (quantizationPolicy : QP) (journal : JournalTransaction) : Bool :=
  decide (quantization.bookId quantizationPolicy = journal.bookId) &&
    decide (quantization.functionalCommodityId quantizationPolicy =
      journal.functionalCommodityId) &&
    !decide (journal.accountingDate < quantization.validFrom quantizationPolicy) &&
    (match quantization.validTo quantizationPolicy with
      | none => true
      | some validTo => !decide (validTo ≤ journal.accountingDate))

/-- `left.toRational().equals(right.toRational())` (lines 325 and 332): the left conversion
first; either can throw. -/
def decimalsEqual (left right : ExactDecimal) : Except NumErr Bool :=
  match left.toRational with
  | .error code => .error code
  | .ok leftRational =>
    match right.toRational with
    | .error code => .error code
    | .ok rightRational => .ok (leftRational.equals rightRational)

/-- `quantized.bookValues.every((bookValue, index) => ...)` (lines 321 to 326) against the
postings from `index` on: it stops at the first book value that has no posting, another
commodity or another amount. -/
def bookValuesMatch : List Posting → List BookValue → Except NumErr Bool
  | _, [] => .ok true
  | [], _ :: _ => .ok false
  | posting :: postings, bookValue :: bookValues =>
    if posting.bookValue.functionalCommodityId ≠ bookValue.functionalCommodityId then .ok false
    else
      match decimalsEqual posting.bookValue.amount bookValue.amount with
      | .error code => .error code
      | .ok false => .ok false
      | .ok true => bookValuesMatch postings bookValues

/-- `roundingMatches` (lines 328 to 333): no rounding posting, or the last posting in ordinal
order is on the rounding account with the rounding amount in the same commodity. -/
def roundingPostingMatches (ordered : List Posting) :
    Option (AccountId × BookValue) → Except NumErr Bool
  | none => .ok true
  | some (accountId, bookValue) =>
    match ordered.getLast? with
    | none => .ok false
    | some posting =>
      if posting.accountId ≠ accountId then .ok false
      else if posting.bookValue.functionalCommodityId ≠ bookValue.functionalCommodityId then
        .ok false
      else decimalsEqual posting.bookValue.amount bookValue.amount

/-- `[...journal.postings].sort(...)` (lines 314 to 316): a stable sort by ordinal. -/
def postingsByOrdinal (journal : JournalTransaction) : List Posting :=
  journal.postings.mergeSort fun left right => decide (left.ordinal ≤ right.ordinal)

/-- How lines 290 to 345 end: with the diagnostic of line 318 returned at once, or with the
diagnostics they pushed (none when the journal reproduces the quantization). -/
inductive QuantizationCheck where
  | returned (diagnostics : List SemanticDiagnostic)
  | pushed (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- Lines 290 to 345. `valuesMatch` is computed before `roundingMatches`, and both are computed
whatever the other answers. -/
def quantizationCheck {QP E : Type} (quantization : QuantizationInterface QP E)
    (journal : JournalTransaction) (quantizationPolicy : QP)
    (exactBookValues : List ExactRational) : Except (ResolveErr E) QuantizationCheck :=
  if !quantizationPolicyApplies quantization quantizationPolicy journal then
    .ok (.pushed [quantizationPolicyDiagnostic])
  else
    match quantization.quantizeBalancedBookValues exactBookValues journal.bookId
        journal.functionalCommodityId quantizationPolicy with
    | .error err => .error (.quantization err)
    | .ok (.rejected diagnostics) => .ok (.pushed diagnostics)
    | .ok (.quantized bookValues roundingPosting) =>
      let ordered := postingsByOrdinal journal
      if (ordered.map (·.ordinal)).dedup.length ≠ ordered.length then
        .ok (.returned [postingOrdinalDiagnostic])
      else
        let expectedCount := bookValues.length + (if roundingPosting.isSome then 1 else 0)
        let valuesMatch : Except NumErr Bool :=
          if ordered.length ≠ expectedCount then .ok false else bookValuesMatch ordered bookValues
        match valuesMatch with
        | .error code => .error (.exactNumber code)
        | .ok valuesMatch =>
          match roundingPostingMatches ordered roundingPosting with
          | .error code => .error (.exactNumber code)
          | .ok roundingMatches =>
            .ok (.pushed
              (if !valuesMatch || !roundingMatches then [quantizationReproductionDiagnostic]
              else []))

/-- The test of line 377. `retained` is the map `evidenceHashes` as the evidence it has kept,
newest first, so that the first item with an identifier is what the map holds for it.
`retainedContent !== canonicalEvidence`, a comparison of two `JSON.stringify` texts of the five
fields of an item, is modelled as the two items being different. That assumes the two
`contentHash` objects list their three properties in the same order, as every `ContentHash` that
`hashCanonical` makes does: `JSON.stringify` writes properties in the order the object holds
them, which a Lean structure does not have. -/
def evidenceConflicting (retained : List SourceEvidence) (evidence : SourceEvidence) : Bool :=
  match retained.find? (fun kept => kept.id = evidence.id) with
  | some kept => decide (kept ≠ evidence)
  | none => false

/-- The loop of lines 368 to 388 over the evidence of the derivation at `index`: the diagnostics
pushed, and the map at the end. -/
def evidenceConflicts (index : Nat) :
    List SourceEvidence → List SourceEvidence → List SemanticDiagnostic × List SourceEvidence
  | retained, [] => ([], retained)
  | retained, evidence :: rest =>
    let tail := evidenceConflicts index (evidence :: retained) rest
    ((if evidenceConflicting retained evidence = true then
        [evidenceConflictDiagnostic index evidence.id]
      else []) ++ tail.1, tail.2)

/-- The loop of lines 347 to 389 from the derivation at `index` on. -/
def derivationDiagnostics (uniquePolicies : List BookingPolicy) :
    Nat → List SourceEvidence → List DerivationRecord → List SemanticDiagnostic
  | _, _, [] => []
  | index, retained, derivation :: rest =>
    let named : Bool := uniquePolicies.any fun selected =>
      decide (derivation.policyId = selected.id ∧ derivation.policyVersion = selected.version)
    let conflicts := evidenceConflicts index retained derivation.evidence
    (if named = true then [] else [derivationPolicyDiagnostic index]) ++
      (if derivation.evidence.length = 0 ∨ derivation.state ≠ .approved then
        [derivationApprovalDiagnostic index]
      else []) ++
      conflicts.1 ++ derivationDiagnostics uniquePolicies (index + 1) conflicts.2 rest

/-- `resolveJournal` (`policy.ts` line 235), over the parts of `quantization.ts` it uses. -/
def resolveJournal {QP E : Type} (quantization : QuantizationInterface QP E)
    (journal : JournalTransaction) (policies : List BookingPolicy) (governedScope : GovernedScope)
    (quantizationPolicy : QP) (exactBookValues : List ExactRational)
    (derivations : List DerivationRecord := []) : Except (ResolveErr E) (JournalResolution QP) :=
  let supplied := suppliedApplications journal governedScope
  if !scopeResolvesOnce journal supplied then .ok (.rejected [governedScopeDiagnostic])
  else
    match selectForApplications journal policies supplied with
    | .error err => .error err
    | .ok selection =>
      if selection.diagnostics.length > 0 then .ok (.rejected selection.diagnostics)
      else
        match selectedByIdentity [] selection.selected with
        | .inl key => .ok (.rejected [policyIdentityConflictDiagnostic key])
        | .inr entries =>
          let uniquePolicies := entries.map (·.2)
          match quantizationCheck quantization journal quantizationPolicy exactBookValues with
          | .error err => .error err
          | .ok (.returned diagnostics) => .ok (.rejected diagnostics)
          | .ok (.pushed quantizationDiagnostics) =>
            let diagnostics :=
              quantizationDiagnostics ++ derivationDiagnostics uniquePolicies 0 [] derivations
            if diagnostics.length > 0 then .ok (.rejected diagnostics)
            else
              .ok (.resolved
                { journal
                  policyApplications := selection.applications
                  policySnapshotHash := hashPolicySnapshot uniquePolicies
                  quantizationPolicy
                  quantizationPolicySnapshotHash :=
                    quantization.hashQuantizationPolicy quantizationPolicy
                  exactBookValues
                  derivations })

/-! ## What `resolveJournal` returns: the five steps -/

/-- `resolveJournal` returns a resolved transaction exactly when each of its five steps passes:
the scope names every posting once, a policy is selected for every application without a
diagnostic, the selected policies have no identity conflict, the quantization is reproduced
without a diagnostic, and the derivations give no diagnostic; and the transaction is then the
inputs, the policy applications and the two hashes. -/
theorem resolveJournal_resolved_iff {QP E : Type} (quantization : QuantizationInterface QP E)
    (journal : JournalTransaction) (policies : List BookingPolicy) (governedScope : GovernedScope)
    (quantizationPolicy : QP) (exactBookValues : List ExactRational)
    (derivations : List DerivationRecord) (transaction : ResolvedTransaction QP) :
    resolveJournal quantization journal policies governedScope quantizationPolicy
        exactBookValues derivations = .ok (.resolved transaction) ↔
      scopeResolvesOnce journal (suppliedApplications journal governedScope) = true ∧
      ∃ selected applications entries,
        selectForApplications (E := E) journal policies
            (suppliedApplications journal governedScope) = .ok ⟨[], selected, applications⟩ ∧
          selectedByIdentity [] selected = .inr entries ∧
          quantizationCheck quantization journal quantizationPolicy exactBookValues =
            .ok (.pushed []) ∧
          derivationDiagnostics (entries.map (·.2)) 0 [] derivations = [] ∧
          transaction =
            { journal
              policyApplications := applications
              policySnapshotHash := hashPolicySnapshot (entries.map (·.2))
              quantizationPolicy
              quantizationPolicySnapshotHash :=
                quantization.hashQuantizationPolicy quantizationPolicy
              exactBookValues
              derivations } := by
  constructor
  · intro h
    unfold resolveJournal at h
    simp only [] at h
    by_cases hscope :
        scopeResolvesOnce journal (suppliedApplications journal governedScope) = true
    · simp only [hscope, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
      refine ⟨hscope, ?_⟩
      cases hsel : selectForApplications (E := E) journal policies
          (suppliedApplications journal governedScope) with
      | error err => rw [hsel] at h; simp at h
      | ok selection =>
        rw [hsel] at h
        obtain ⟨selectionDiagnostics, selected, applications⟩ := selection
        cases selectionDiagnostics with
        | cons first more => simp at h
        | nil =>
          simp only [List.length_nil, gt_iff_lt, Nat.lt_irrefl, ↓reduceIte] at h
          cases hidentity : selectedByIdentity [] selected with
          | inl key => rw [hidentity] at h; simp at h
          | inr entries =>
            rw [hidentity] at h
            simp only [] at h
            cases hcheck : quantizationCheck quantization journal quantizationPolicy
                exactBookValues with
            | error err => rw [hcheck] at h; simp at h
            | ok check =>
              rw [hcheck] at h
              cases check with
              | returned diagnostics => simp at h
              | pushed diagnostics =>
                simp only [] at h
                split_ifs at h with hpos
                · simp at h
                · simp only [Except.ok.injEq, JournalResolution.resolved.injEq] at h
                  have hnil : diagnostics ++
                      derivationDiagnostics (entries.map (·.2)) 0 [] derivations = [] :=
                    List.eq_nil_of_length_eq_zero (by omega)
                  obtain ⟨rfl, hder⟩ := List.append_eq_nil_iff.mp hnil
                  exact ⟨selected, applications, entries, rfl, hidentity, rfl, hder, h.symm⟩
    · simp [hscope] at h
  · rintro ⟨hscope, selected, applications, entries, hsel, hidentity, hcheck, hder, rfl⟩
    unfold resolveJournal
    simp [hscope, hsel, hidentity, hcheck, hder]

/-! ## Step one: the scope names every posting once -/

/-- The first test passes exactly when there are as many applications as postings, no posting
identifier is named twice, and every posting's identifier is named. -/
theorem scopeResolvesOnce_iff (journal : JournalTransaction) (supplied : List ScopeApplication) :
    scopeResolvesOnce journal supplied = true ↔
      supplied.length = journal.postings.length ∧ (supplied.map (·.postingId)).Nodup ∧
        ∀ posting ∈ journal.postings, posting.id ∈ supplied.map (·.postingId) := by
  unfold scopeResolvesOnce
  simp only [Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true, List.any_eq_true,
    List.mem_map]
  constructor
  · rintro ⟨⟨hlen, hdedup⟩, hall⟩
    refine ⟨hlen, ?_, fun posting hp => ?_⟩
    · rw [← List.dedup_eq_self]
      exact (List.dedup_sublist _).eq_of_length (by rw [hdedup, List.length_map, hlen])
    · obtain ⟨application, ha, hid⟩ := hall posting hp
      exact ⟨application, ha, hid⟩
  · rintro ⟨hlen, hnodup, hall⟩
    refine ⟨⟨hlen, ?_⟩, fun posting hp => ?_⟩
    · rw [hnodup.dedup, List.length_map, hlen]
    · obtain ⟨application, ha, hid⟩ := hall posting hp
      exact ⟨application, ha, hid⟩

/-- For a journal whose postings have different identifiers, the first test passes exactly when
the posting identifiers the applications name are those of the journal, each once, in any
order. -/
theorem scopeResolvesOnce_iff_perm {journal : JournalTransaction}
    (hids : (journal.postings.map (·.id)).Nodup) (supplied : List ScopeApplication) :
    scopeResolvesOnce journal supplied = true ↔
      (supplied.map (·.postingId)).Perm (journal.postings.map (·.id)) := by
  rw [scopeResolvesOnce_iff]
  constructor
  · rintro ⟨hlen, -, hall⟩
    have hsub : (journal.postings.map (·.id)).Subperm (supplied.map (·.postingId)) :=
      List.subperm_of_subset hids (fun id hid => by
        obtain ⟨posting, hp, rfl⟩ := List.mem_map.mp hid
        exact hall posting hp)
    exact (hsub.perm_of_length_le (by simp [hlen])).symm
  · intro hperm
    refine ⟨by simpa using hperm.length_eq, hperm.nodup_iff.mpr hids, fun posting hp => ?_⟩
    exact hperm.mem_iff.mpr (List.mem_map_of_mem hp)

/-- With one scope key for every posting, the first test passes exactly when the journal's
postings have different identifiers. -/
theorem scopeResolvesOnce_all_iff (journal : JournalTransaction) (scopeKey : String) :
    scopeResolvesOnce journal (suppliedApplications journal (.all scopeKey)) = true ↔
      (journal.postings.map (·.id)).Nodup := by
  have hmap : (suppliedApplications journal (.all scopeKey)).map (·.postingId) =
      journal.postings.map (·.id) := by
    simp [suppliedApplications, List.map_map, Function.comp_def]
  rw [scopeResolvesOnce_iff, hmap]
  constructor
  · exact fun h => h.2.1
  · exact fun h => ⟨by simp [suppliedApplications], h, fun posting hp => List.mem_map_of_mem hp⟩

/-! ## Step two: a policy for every application -/

/-- A rejection of `selectBookingPolicy` always carries a diagnostic, whatever the inputs. -/
theorem selectBookingPolicy_rejected_ne_nil {policies : List BookingPolicy} {fact : GovernedFact}
    {diagnostics : List SemanticDiagnostic}
    (h : selectBookingPolicy policies fact = .ok (.rejected diagnostics)) : diagnostics ≠ [] := by
  unfold selectBookingPolicy at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · split at h
        · cases h
        · cases h; simp
      · cases h; simp

/-- The step of the loop for one application passes with a policy: `selectBookingPolicy` resolves
to it for the journal's book and economic time and the application's scope key, and when the
policy is account-scoped the posting the application names exists and the policy's scope key is
that posting's account. -/
def SelectsPolicy (journal : JournalTransaction) (policies : List BookingPolicy)
    (application : ScopeApplication) (policy : BookingPolicy) : Prop :=
  selectBookingPolicy policies (applicationFact journal application) = .ok (.resolved policy) ∧
    (policy.scope = .account →
      ∃ posting, journal.postings.find? (fun candidate => candidate.id = application.postingId) =
          some posting ∧ policy.scopeKey = posting.accountId.value)

/-- The policy application recorded for an application and the policy selected for it. -/
def policyApplicationOf (application : ScopeApplication) (policy : BookingPolicy) :
    PolicyApplication :=
  ⟨application.postingId, application.scopeKey, policy.id, policy.version⟩

/-- Soundness of the loop: when it ends without a diagnostic, every application passed with the
policy selected for it, and the policy applications are those. -/
theorem selectForApplications_sound {E : Type} {journal : JournalTransaction}
    {policies : List BookingPolicy} :
    ∀ {supplied : List ScopeApplication} {selected : List BookingPolicy}
      {applications : List PolicyApplication},
      selectForApplications (E := E) journal policies supplied =
          .ok ⟨[], selected, applications⟩ →
        List.Forall₂ (SelectsPolicy journal policies) supplied selected ∧
          applications = List.zipWith policyApplicationOf supplied selected
  | [], selected, applications, h => by
    simp only [selectForApplications, Except.ok.injEq, PolicySelection.mk.injEq, true_and] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨.nil, rfl⟩
  | application :: rest, selected, applications, h => by
    rw [selectForApplications] at h
    cases hsel : selectBookingPolicy policies (applicationFact journal application) with
    | error err => rw [hsel] at h; simp at h
    | ok resolution =>
      rw [hsel] at h
      cases resolution with
      | rejected diagnostics =>
        simp only [] at h
        cases htail : selectForApplications (E := E) journal policies rest with
        | error err => rw [htail] at h; simp at h
        | ok tail =>
          rw [htail] at h
          simp only [Except.ok.injEq, PolicySelection.mk.injEq, List.append_eq_nil_iff] at h
          exact absurd h.1.1 (selectBookingPolicy_rejected_ne_nil hsel)
      | resolved policy =>
        simp only [] at h
        have key : ∀ accountDiagnostics : List SemanticDiagnostic,
            (match selectForApplications (E := E) journal policies rest with
              | .error err => (.error err : Except (ResolveErr E) PolicySelection)
              | .ok tail =>
                .ok
                  { diagnostics := accountDiagnostics ++ tail.diagnostics
                    selected := policy :: tail.selected
                    applications :=
                      ⟨application.postingId, application.scopeKey, policy.id, policy.version⟩ ::
                        tail.applications }) = .ok ⟨[], selected, applications⟩ →
            accountDiagnostics = [] ∧ ∃ tailSelected tailApplications,
              selectForApplications (E := E) journal policies rest =
                .ok ⟨[], tailSelected, tailApplications⟩ ∧
              selected = policy :: tailSelected ∧
              applications = policyApplicationOf application policy :: tailApplications := by
          intro accountDiagnostics hk
          cases htail : selectForApplications (E := E) journal policies rest with
          | error err => rw [htail] at hk; simp at hk
          | ok tail =>
            rw [htail] at hk
            obtain ⟨tailDiagnostics, tailSelected, tailApplications⟩ := tail
            simp only [Except.ok.injEq, PolicySelection.mk.injEq, List.append_eq_nil_iff] at hk
            obtain ⟨⟨h1, rfl⟩, rfl, rfl⟩ := hk
            exact ⟨h1, tailSelected, tailApplications, rfl, rfl, rfl⟩
        by_cases haccount : policy.scope = .account
        · simp only [haccount, ↓reduceIte] at h
          cases hfind : journal.postings.find?
              (fun candidate => candidate.id = application.postingId) with
          | none => rw [hfind] at h; simp at h
          | some posting =>
            rw [hfind] at h
            simp only [] at h
            obtain ⟨hdiag, tailSelected, tailApplications, htail, rfl, rfl⟩ := key _ h
            have hscopeKey : policy.scopeKey = posting.accountId.value := by
              by_contra hne
              simp [hne] at hdiag
            obtain ⟨hforall, happs⟩ := selectForApplications_sound htail
            exact ⟨.cons ⟨hsel, fun _ => ⟨posting, hfind, hscopeKey⟩⟩ hforall, by
              rw [happs]; rfl⟩
        · simp only [haccount, ↓reduceIte] at h
          obtain ⟨-, tailSelected, tailApplications, htail, rfl, rfl⟩ := key _ h
          obtain ⟨hforall, happs⟩ := selectForApplications_sound htail
          exact ⟨.cons ⟨hsel, fun hacc => absurd hacc haccount⟩ hforall, by rw [happs]; rfl⟩

/-- Completeness of the loop: when every application passes with a policy, the loop ends without
a diagnostic and without throwing, with those policies and their applications. -/
theorem selectForApplications_complete {E : Type} {journal : JournalTransaction}
    {policies : List BookingPolicy} {supplied : List ScopeApplication}
    {selected : List BookingPolicy}
    (h : List.Forall₂ (SelectsPolicy journal policies) supplied selected) :
    selectForApplications (E := E) journal policies supplied =
      .ok ⟨[], selected, List.zipWith policyApplicationOf supplied selected⟩ := by
  induction h with
  | nil => rfl
  | @cons application policy rest tailSelected hhead _ ih =>
    obtain ⟨hsel, haccountScope⟩ := hhead
    rw [selectForApplications, hsel]
    simp only []
    by_cases haccount : policy.scope = .account
    · obtain ⟨posting, hfind, hscopeKey⟩ := haccountScope haccount
      simp only [haccount, ↓reduceIte, hfind, hscopeKey, ne_eq, not_true_eq_false, ih,
        List.nil_append, List.zipWith_cons_cons, policyApplicationOf]
    · simp only [haccount, ↓reduceIte, ih, List.nil_append, List.zipWith_cons_cons,
        policyApplicationOf]

/-- The loop ends without a diagnostic exactly when every application passes with a policy. -/
theorem selectForApplications_ok_iff {E : Type} (journal : JournalTransaction)
    (policies : List BookingPolicy) (supplied : List ScopeApplication)
    (selected : List BookingPolicy) (applications : List PolicyApplication) :
    selectForApplications (E := E) journal policies supplied =
        .ok ⟨[], selected, applications⟩ ↔
      List.Forall₂ (SelectsPolicy journal policies) supplied selected ∧
        applications = List.zipWith policyApplicationOf supplied selected :=
  ⟨selectForApplications_sound, fun ⟨h, happs⟩ => happs ▸ selectForApplications_complete h⟩

/-! ## Step four: the journal reproduces the quantization -/

/-- Lines 290 to 345 end without a diagnostic exactly when the quantization policy applies to the
journal and either the quantizer rejected without any diagnostic (which
`quantizeBalancedBookValues` never does), or it returned book values and the postings in ordinal
order have different ordinals, are as many as the book values and the rounding posting, match
the book values one by one and end with the rounding posting when there is one. -/
theorem quantizationCheck_pushed_nil_iff {QP E : Type} (quantization : QuantizationInterface QP E)
    (journal : JournalTransaction) (quantizationPolicy : QP)
    (exactBookValues : List ExactRational) :
    quantizationCheck quantization journal quantizationPolicy exactBookValues =
        .ok (.pushed []) ↔
      quantizationPolicyApplies quantization quantizationPolicy journal = true ∧
        (quantization.quantizeBalancedBookValues exactBookValues journal.bookId
            journal.functionalCommodityId quantizationPolicy = .ok (.rejected []) ∨
          ∃ bookValues roundingPosting,
            quantization.quantizeBalancedBookValues exactBookValues journal.bookId
                journal.functionalCommodityId quantizationPolicy =
              .ok (.quantized bookValues roundingPosting) ∧
            ((postingsByOrdinal journal).map (·.ordinal)).Nodup ∧
            (postingsByOrdinal journal).length =
              bookValues.length + (if roundingPosting.isSome then 1 else 0) ∧
            bookValuesMatch (postingsByOrdinal journal) bookValues = .ok true ∧
            roundingPostingMatches (postingsByOrdinal journal) roundingPosting = .ok true) := by
  unfold quantizationCheck
  by_cases happlies : quantizationPolicyApplies quantization quantizationPolicy journal = true
  · simp only [happlies, Bool.not_true, Bool.false_eq_true, ↓reduceIte, true_and]
    cases hq : quantization.quantizeBalancedBookValues exactBookValues journal.bookId
        journal.functionalCommodityId quantizationPolicy with
    | error err => simp
    | ok outcome =>
      cases outcome with
      | rejected diagnostics => simp
      | quantized bookValues roundingPosting =>
        simp only [reduceCtorEq, Except.ok.injEq, BalancedOutcome.quantized.injEq, false_or]
        by_cases hordinals : ((postingsByOrdinal journal).map (·.ordinal)).Nodup
        · have hdedup : ((postingsByOrdinal journal).map (·.ordinal)).dedup.length =
              (postingsByOrdinal journal).length := by rw [hordinals.dedup, List.length_map]
          simp only [hdedup, ne_eq, not_true_eq_false, ↓reduceIte]
          by_cases hlen : (postingsByOrdinal journal).length =
              bookValues.length + (if roundingPosting.isSome then 1 else 0)
          · simp only [hlen, not_true_eq_false, ↓reduceIte]
            cases hvalues : bookValuesMatch (postingsByOrdinal journal) bookValues with
            | error code =>
              simp only [reduceCtorEq, false_iff, not_exists, not_and]
              rintro _ _ ⟨rfl, rfl⟩ - - h
              rw [hvalues] at h; cases h
            | ok valuesMatch =>
              cases hrounding : roundingPostingMatches (postingsByOrdinal journal)
                  roundingPosting with
              | error code =>
                simp only [reduceCtorEq, false_iff, not_exists, not_and]
                rintro _ _ ⟨rfl, rfl⟩ - - - h
                rw [hrounding] at h; cases h
              | ok roundingMatches =>
                simp only [Except.ok.injEq, QuantizationCheck.pushed.injEq]
                constructor
                · intro h
                  have hboth : valuesMatch = true ∧ roundingMatches = true := by
                    cases valuesMatch <;> cases roundingMatches <;> simp at h ⊢
                  exact ⟨_, _, ⟨rfl, rfl⟩, hordinals, rfl, by rw [hvalues, hboth.1],
                    by rw [hrounding, hboth.2]⟩
                · rintro ⟨_, _, ⟨rfl, rfl⟩, -, -, h1, h2⟩
                  rw [hvalues] at h1; rw [hrounding] at h2
                  cases h1; cases h2
                  simp
          · simp only [hlen, not_false_eq_true, ↓reduceIte]
            cases hrounding : roundingPostingMatches (postingsByOrdinal journal)
                roundingPosting with
            | error code =>
              simp only [reduceCtorEq, false_iff, not_exists, not_and]
              rintro _ _ ⟨rfl, rfl⟩ - h
              exact absurd h hlen
            | ok roundingMatches =>
              simp only [Bool.not_false, Bool.true_or, ↓reduceIte, Except.ok.injEq,
                QuantizationCheck.pushed.injEq, List.cons_ne_self, false_iff, not_exists,
                not_and]
              rintro _ _ ⟨rfl, rfl⟩ - h
              exact absurd h hlen
        · have hdedup : ((postingsByOrdinal journal).map (·.ordinal)).dedup.length ≠
              (postingsByOrdinal journal).length := by
            intro heq
            apply hordinals
            rw [← List.dedup_eq_self]
            exact (List.dedup_sublist _).eq_of_length (by rw [heq, List.length_map])
          simp only [hdedup, ne_eq, not_false_eq_true, ↓reduceIte]
          constructor
          · intro h
            simp at h
          · rintro ⟨_, _, ⟨rfl, rfl⟩, h, -⟩
            exact absurd h hordinals
  · simp [happlies]

/-- The quantization policy applies to a journal exactly when it is of the journal's book and
functional commodity and the accounting date is on or after the day of `validFrom` and, when
there is a `validTo`, before its day. The code compares the dates as strings (`>` on line 293,
`>=` on line 294), which for two real dates written `YYYY-MM-DD` is their order as days. -/
theorem quantizationPolicyApplies_iff {QP E : Type} (quantization : QuantizationInterface QP E)
    (quantizationPolicy : QP) (journal : JournalTransaction)
    (hfrom : (quantization.validFrom quantizationPolicy).WF)
    (hto : ∀ validTo, quantization.validTo quantizationPolicy = some validTo → validTo.WF)
    (hdate : journal.accountingDate.WF) :
    quantizationPolicyApplies quantization quantizationPolicy journal = true ↔
      quantization.bookId quantizationPolicy = journal.bookId ∧
        quantization.functionalCommodityId quantizationPolicy = journal.functionalCommodityId ∧
        (quantization.validFrom quantizationPolicy).toCalendarDate.dayNumber ≤
          journal.accountingDate.toCalendarDate.dayNumber ∧
        ∀ validTo, quantization.validTo quantizationPolicy = some validTo →
          journal.accountingDate.toCalendarDate.dayNumber <
            validTo.toCalendarDate.dayNumber := by
  unfold quantizationPolicyApplies
  have h1 := hdate.lt_iff hfrom
  cases hvalidTo : quantization.validTo quantizationPolicy with
  | none =>
    simp only [Bool.and_eq_true, decide_eq_true_eq, Bool.not_eq_true', decide_eq_false_iff_not,
      h1, and_true, reduceCtorEq, false_implies, implies_true, and_assoc, Nat.not_lt]
  | some validTo =>
    have h2 := (hto validTo hvalidTo).le_iff hdate
    simp only [Bool.and_eq_true, decide_eq_true_eq, Bool.not_eq_true', decide_eq_false_iff_not,
      h1, h2, Option.some.injEq, forall_eq', and_assoc, Nat.not_lt, Nat.not_le]

/-- On two constructible decimals the comparison of lines 325 and 332 does not throw and answers
whether they are the same number, whatever their scales. -/
theorem decimalsEqual_ok {left right : ExactDecimal} (hl : left.WF) (hr : right.WF) :
    decimalsEqual left right = .ok (decide (left.toRat = right.toRat)) := by
  obtain ⟨leftRational, hlr, hlwf, hlrat⟩ := ExactDecimal.toRational_isOk hl
  obtain ⟨rightRational, hrr, hrwf, hrrat⟩ := ExactDecimal.toRational_isOk hr
  unfold decimalsEqual
  rw [hlr, hrr]
  simp only [Except.ok.injEq]
  rw [← hlrat, ← hrrat]
  by_cases heq : leftRational.toRat = rightRational.toRat
  · simp [heq, (ExactRational.equals_iff hlwf hrwf).mpr heq]
  · have : leftRational.equals rightRational = false := by
      rw [← Bool.not_eq_true, ExactRational.equals_iff hlwf hrwf]; exact heq
    simp [heq, this]

end Rastrata.Kernel

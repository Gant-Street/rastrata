/-
The vocabulary of booking policy: the Lean model of the types, the identifier makers and the two
validators of `packages/kernel/src/policy.ts`: `semanticVersion`, and `instantMillis` (not exported
there; it is what `selectBookingPolicy` compares instants with).

Not here, and why:

- `ResolvedTransaction` has a field of type `QuantizationPolicy`, which belongs to
  `quantization.ts`; and `quantization.ts` itself needs `SemanticVersion` from this file. So this
  file does not import `Rastrata.Kernel.Quantization` (which can then import this one), and
  `ResolvedTransaction` waits for the file that models `resolveJournal`. Its unnamed element type
  is here as `PolicyApplication`.
- `selectBookingPolicy`, `canonicalPolicyValue`, `hashPolicySnapshot`, `canonicalDerivationValue`
  and `resolveJournal` are functions of the next wave.

What is assumed about JavaScript:

- The regular expression of `semanticVersion` has no flag, so `\d` is exactly `0` to `9`,
  `[0-9A-Za-z.-]` is exactly those sixty-four ASCII characters, and `^` and `$` match only at the two
  ends of the whole string. The expression has no back-reference and no look-around, so `test`
  answers whether the whole string belongs to its regular language.
- What `Date.parse` answers for a text that `instant` accepts (`dateParseFractionMillis`,
  `InstantFields.dateParseMillis`). This one is an assumption about the engines and is said in full
  where it is made.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types

namespace Rastrata.Kernel

/-! ## Identifier types and their makers (`policy.ts` lines 24 to 34) -/

/-- `PolicyId`. -/
abbrev PolicyId := Identifier "BookingPolicy"

/-- `EvidenceId`. -/
abbrev EvidenceId := Identifier "SourceEvidence"

/-- `DerivationId`. -/
abbrev DerivationId := Identifier "DerivationRecord"

/-- `PolicyCapabilityId`. -/
abbrev PolicyCapabilityId := Identifier "PolicyCapability"

/-- `policyId`. -/
def policyId (value : String) : Except CanonicalErr PolicyId := identifier "BookingPolicy" value

/-- `evidenceId`. -/
def evidenceId (value : String) : Except CanonicalErr EvidenceId :=
  identifier "SourceEvidence" value

/-- `derivationId`. -/
def derivationId (value : String) : Except CanonicalErr DerivationId :=
  identifier "DerivationRecord" value

/-- `policyCapabilityId`. -/
def policyCapabilityId (value : String) : Except CanonicalErr PolicyCapabilityId :=
  identifier "PolicyCapability" value

/-! ## `SemanticVersion` (`policy.ts` lines 36 to 44): the model -/

/-- The `RangeError` of `semanticVersion`: `Invalid semantic version: ${value}`. -/
inductive SemanticVersionErr where
  | invalidSemanticVersion (value : String)
  deriving DecidableEq, Repr, Inhabited

/-- `SemanticVersion`: a branded string. Built only by `semanticVersion`, as in the TypeScript. -/
structure SemanticVersion where
  value : String
  deriving DecidableEq, Repr, Inhabited

/-- `(0|[1-9]\d*)` at the head of `cs`: what is left after it, or `none`. After a `0` nothing more
is taken; after `1` to `9` every digit that follows is taken, because what the expression demands
next (a point, a hyphen or the end) is not a digit. So there is no backtracking to model. -/
def matchVersionNumber : List Char → Option (List Char)
  | [] => none
  | c :: rest =>
    if c == '0' then some rest
    else if isAsciiDigit c then some (rest.dropWhile isAsciiDigit)
    else none

/-- `\.` at the head of `cs`: what is left after it, or `none`. -/
def matchPoint : List Char → Option (List Char)
  | [] => none
  | c :: rest => if c == '.' then some rest else none

/-- `[0-9A-Za-z.-]`. -/
def isPrereleaseChar (c : Char) : Bool :=
  isAsciiDigit c || decide (65 ≤ c.toNat ∧ c.toNat ≤ 90) || decide (97 ≤ c.toNat ∧ c.toNat ≤ 122) ||
    c == '.' || c == '-'

/-- `(?:-[0-9A-Za-z.-]+)?$` on what is left after the third number. -/
def matchPrereleaseAndEnd : List Char → Bool
  | [] => true
  | c :: rest => c == '-' && !rest.isEmpty && rest.all isPrereleaseChar

/-- `/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)`. -/
def matchSemanticVersion (cs : List Char) : Bool :=
  match matchVersionNumber cs >>= matchPoint >>= matchVersionNumber >>= matchPoint
      >>= matchVersionNumber with
  | none => false
  | some rest => matchPrereleaseAndEnd rest

/-- `semanticVersion` (`policy.ts` line 39). -/
def semanticVersion (value : String) : Except SemanticVersionErr SemanticVersion :=
  if !matchSemanticVersion value.toList then .error (.invalidSemanticVersion value)
  else .ok ⟨value⟩

/-! ## Policy types (`policy.ts` lines 46 to 114)

A union of string literals written inline in the TypeScript has no name there; it gets one here
(`PolicyCapabilityStatus`, `DerivationState`). -/

/-- `SourceEvidence`. -/
structure SourceEvidence where
  id : EvidenceId
  sourceSystem : String
  sourceRecordId : String
  observedAt : Instant
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `LotSelectionMethod`. -/
inductive LotSelectionMethod where
  | specificIdentification
  | fifo
  | lifo
  | hifo
  | weightedAverage
  deriving DecidableEq, Repr, Inhabited

/-- `PolicyScope`. -/
inductive PolicyScope where
  | account
  | legalEntity
  | jurisdictionPool
  deriving DecidableEq, Repr, Inhabited

/-- The type of `PolicyCapability.status`. -/
inductive PolicyCapabilityStatus where
  | supported
  | experimental
  | unsupported
  deriving DecidableEq, Repr, Inhabited

/-- `PolicyCapability`. -/
structure PolicyCapability where
  id : PolicyCapabilityId
  method : LotSelectionMethod
  scope : PolicyScope
  status : PolicyCapabilityStatus
  implementationVersion : SemanticVersion
  verificationEvidenceIds : List EvidenceId
  deriving DecidableEq, Repr, Inhabited

/-- `BookingPolicy`. -/
structure BookingPolicy where
  id : PolicyId
  bookId : BookId
  version : SemanticVersion
  validFrom : Instant
  validTo : Option Instant
  lotSelection : LotSelectionMethod
  scope : PolicyScope
  scopeKey : String
  requiredDimensionIds : List DimensionId
  implementationVersion : SemanticVersion
  capability : PolicyCapability
  deriving DecidableEq, Repr, Inhabited

/-- The type of `DerivationRecord.state`. -/
inductive DerivationState where
  | proposed
  | approved
  | rejected
  | applied
  deriving DecidableEq, Repr, Inhabited

/-- `DerivationRecord`. -/
structure DerivationRecord where
  id : DerivationId
  policyId : PolicyId
  policyVersion : SemanticVersion
  algorithmVersion : SemanticVersion
  inputHash : ContentHash
  actorId : Identifier "Actor"
  state : DerivationState
  recordedAt : Instant
  evidence : List SourceEvidence
  deriving DecidableEq, Repr, Inhabited

/-- The element type of `ResolvedTransaction.policyApplications`, unnamed in the TypeScript. -/
structure PolicyApplication where
  postingId : PostingId
  scopeKey : String
  policyId : PolicyId
  policyVersion : SemanticVersion
  deriving DecidableEq, Repr, Inhabited

/-- `PolicyResolution`: the two dispositions, `resolved` and `rejected`. -/
inductive PolicyResolution where
  | resolved (policy : BookingPolicy)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited


/-! ## Meaning of a semantic version -/

/-- A natural number written in decimal, with no sign and no leading zero. -/
def decimalChars (n : Nat) : List Char := Nat.toDigits 10 n

theorem natDigitChar_eq {n : Nat} (h : n < 10) : Nat.digitChar n = digitChar n := by
  have cases : n = 0 ∨ n = 1 ∨ n = 2 ∨ n = 3 ∨ n = 4 ∨ n = 5 ∨ n = 6 ∨ n = 7 ∨ n = 8 ∨ n = 9 := by
    omega
  rcases cases with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> rfl

theorem decimalChars_of_lt {n : Nat} (h : n < 10) : decimalChars n = [digitChar n] := by
  rw [decimalChars, Nat.toDigits_of_lt_base h, natDigitChar_eq h]

theorem decimalChars_of_ge {n : Nat} (h : 10 ≤ n) :
    decimalChars n = decimalChars (n / 10) ++ [digitChar (n % 10)] := by
  rw [decimalChars, Nat.toDigits_of_base_le (by decide) h, natDigitChar_eq (Nat.mod_lt _ (by decide))]
  rfl

/-- A positive number in decimal starts with a digit from 1 to 9 and goes on with digits. -/
theorem decimalChars_pos {n : Nat} (h : 0 < n) :
    ∃ c rest, decimalChars n = c :: rest ∧ isAsciiDigit c = true ∧ c ≠ '0' ∧
      ∀ x ∈ rest, isAsciiDigit x = true := by
  induction n using Nat.strongRecOn with
  | _ n ih =>
    by_cases hn : n < 10
    · refine ⟨digitChar n, [], decimalChars_of_lt hn, isAsciiDigit_digitChar hn, ?_, by simp⟩
      intro h0
      have := digitValue_digitChar hn
      rw [h0] at this
      have : digitValue '0' = 0 := by decide
      omega
    · obtain ⟨c, rest, hc, hd, h0, hr⟩ := ih (n / 10) (by omega) (by omega)
      refine ⟨c, rest ++ [digitChar (n % 10)], ?_, hd, h0, ?_⟩
      · rw [decimalChars_of_ge (by omega), hc]
        rfl
      · intro x hx
        rcases List.mem_append.mp hx with hx | hx
        · exact hr x hx
        · rw [List.mem_singleton.mp hx]
          exact isAsciiDigit_digitChar_mod n


theorem digitsToNat_append_singleton (text : List Char) (c : Char) :
    digitsToNat (text ++ [c]) = digitsToNat text * 10 + digitValue c := by
  simp [digitsToNat, List.foldl_append]

/-- Digits that do not start with `0` are the decimal writing of the number they spell. -/
theorem decimalChars_digitsToNat (text : List Char) :
    ∀ c rest, text = c :: rest → (∀ x ∈ text, isAsciiDigit x = true) → c ≠ '0' →
      decimalChars (digitsToNat text) = text ∧ 0 < digitsToNat text := by
  induction text using List.reverseRecOn with
  | nil => intro c rest h; exact absurd h (by simp)
  | append_singleton init last ih =>
    intro c rest htext hdigits h0
    have hlast : isAsciiDigit last = true := hdigits last (by simp)
    have blast := digitValue_lt hlast
    rw [digitsToNat_append_singleton]
    cases init with
    | nil =>
      simp only [List.nil_append, List.cons.injEq] at htext
      obtain ⟨rfl, -⟩ := htext
      have hpos : 0 < digitValue last := by
        rcases Nat.eq_zero_or_pos (digitValue last) with hz | hp
        · exact absurd (by rw [← digitChar_digitValue hlast, hz]; rfl) h0
        · exact hp
      simp only [digitsToNat, List.foldl_nil, Nat.zero_mul, Nat.zero_add, List.nil_append]
      exact ⟨by rw [decimalChars_of_lt blast, digitChar_digitValue hlast], hpos⟩
    | cons first more =>
      simp only [List.cons_append, List.cons.injEq] at htext
      obtain ⟨rfl, -⟩ := htext
      obtain ⟨hinit, hpos⟩ := ih first more rfl
        (fun x hx => hdigits x (List.mem_append_left _ hx)) h0
      refine ⟨?_, by omega⟩
      rw [decimalChars_of_ge (by omega),
        show (digitsToNat (first :: more) * 10 + digitValue last) / 10 =
          digitsToNat (first :: more) by omega,
        show (digitsToNat (first :: more) * 10 + digitValue last) % 10 = digitValue last by omega,
        hinit, digitChar_digitValue hlast]

theorem dropWhile_isAsciiDigit_append {digits rest : List Char}
    (hd : ∀ x ∈ digits, isAsciiDigit x = true) (hr : ∀ c tail, rest = c :: tail → isAsciiDigit c = false) :
    (digits ++ rest).dropWhile isAsciiDigit = rest := by
  rw [List.dropWhile_append_of_pos hd]
  cases rest with
  | nil => rfl
  | cons c tail => exact List.dropWhile_cons_of_neg (by simp [hr c tail rfl])

/-- `(0|[1-9]\d*)` takes a number written in decimal when what follows does not start with a
digit. -/
theorem matchVersionNumber_decimalChars (n : Nat) {rest : List Char}
    (hr : ∀ c tail, rest = c :: tail → isAsciiDigit c = false) :
    matchVersionNumber (decimalChars n ++ rest) = some rest := by
  rcases Nat.eq_zero_or_pos n with rfl | hpos
  · rw [decimalChars_of_lt (by decide)]
    rfl
  · obtain ⟨c, more, hc, hd, h0, hm⟩ := decimalChars_pos hpos
    rw [hc]
    simp only [List.cons_append, matchVersionNumber, beq_iff_eq, h0, ↓reduceIte, hd,
      dropWhile_isAsciiDigit_append hm hr]

/-- What `(0|[1-9]\d*)` takes is a number written in decimal. -/
theorem matchVersionNumber_sound {cs rest : List Char} (h : matchVersionNumber cs = some rest) :
    ∃ n, cs = decimalChars n ++ rest := by
  unfold matchVersionNumber at h
  split at h
  · exact absurd h (by simp)
  · rename_i c more
    split at h
    · rename_i hz
      simp only [beq_iff_eq] at hz
      simp only [Option.some.injEq] at h
      subst hz h
      exact ⟨0, rfl⟩
    · rename_i hz
      simp only [beq_iff_eq] at hz
      split at h
      · rename_i hd
        simp only [Option.some.injEq] at h
        subst h
        have hall : ∀ x ∈ c :: more.takeWhile isAsciiDigit, isAsciiDigit x = true := by
          intro x hx
          rcases List.mem_cons.mp hx with rfl | hx
          · exact hd
          · exact mem_takeWhile_isAsciiDigit hx
        refine ⟨digitsToNat (c :: more.takeWhile isAsciiDigit), ?_⟩
        rw [(decimalChars_digitsToNat _ c _ rfl hall hz).1, List.cons_append,
          List.takeWhile_append_dropWhile]
      · exact absurd h (by simp)


/-- The parts of a semantic version: three numbers, and the characters after the hyphen (empty
when there is no hyphen). -/
structure SemanticVersionFields where
  major : Nat
  minor : Nat
  patch : Nat
  prerelease : List Char
  deriving DecidableEq, Repr, Inhabited

namespace SemanticVersionFields

/-- A version as it is written: `MAJOR.MINOR.PATCH`, then a hyphen and the prerelease if any. -/
def chars (f : SemanticVersionFields) : List Char :=
  decimalChars f.major ++ '.' :: (decimalChars f.minor ++ '.' :: (decimalChars f.patch ++
    (if f.prerelease = [] then [] else '-' :: f.prerelease)))

/-- A version as it is written, as a string. -/
def format (f : SemanticVersionFields) : String := String.ofList f.chars

/-- The prerelease has only ASCII letters, digits, points and hyphens. -/
def Valid (f : SemanticVersionFields) : Prop := ∀ c ∈ f.prerelease, isPrereleaseChar c = true

end SemanticVersionFields

/-- What every `SemanticVersion` that `semanticVersion` returns satisfies. -/
def SemanticVersion.WF (v : SemanticVersion) : Prop :=
  ∃ f : SemanticVersionFields, f.Valid ∧ v.value = f.format

theorem matchPoint_eq_some_iff (cs rest : List Char) :
    matchPoint cs = some rest ↔ cs = '.' :: rest := by
  unfold matchPoint
  split
  · simp
  · rename_i c more
    by_cases hc : c = '.'
    · subst hc; simp
    · simp [hc]

theorem matchPrereleaseAndEnd_iff (cs : List Char) :
    matchPrereleaseAndEnd cs = true ↔
      ∃ prerelease, (∀ c ∈ prerelease, isPrereleaseChar c = true) ∧
        cs = if prerelease = [] then [] else '-' :: prerelease := by
  unfold matchPrereleaseAndEnd
  split
  · exact ⟨fun _ => ⟨[], by simp, by simp⟩, fun _ => rfl⟩
  · rename_i c rest
    simp only [Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true', List.isEmpty_eq_false_iff,
      List.all_eq_true]
    constructor
    · rintro ⟨⟨rfl, hne⟩, hall⟩
      exact ⟨rest, hall, by simp [hne]⟩
    · rintro ⟨prerelease, hall, heq⟩
      by_cases hp : prerelease = []
      · simp [hp] at heq
      · simp only [hp, ↓reduceIte, List.cons.injEq] at heq
        obtain ⟨rfl, rfl⟩ := heq
        exact ⟨⟨rfl, hp⟩, hall⟩

theorem matchSemanticVersion_iff (cs : List Char) :
    matchSemanticVersion cs = true ↔ ∃ f : SemanticVersionFields, f.Valid ∧ cs = f.chars := by
  unfold matchSemanticVersion
  constructor
  · intro h
    cases h1 : matchVersionNumber cs with
    | none => simp [h1] at h
    | some r1 =>
      cases h2 : matchPoint r1 with
      | none => simp [h1, h2] at h
      | some r2 =>
        cases h3 : matchVersionNumber r2 with
        | none => simp [h1, h2, h3] at h
        | some r3 =>
          cases h4 : matchPoint r3 with
          | none => simp [h1, h2, h3, h4] at h
          | some r4 =>
            cases h5 : matchVersionNumber r4 with
            | none => simp [h1, h2, h3, h4, h5] at h
            | some r5 =>
              simp only [h1, h2, h3, h4, h5, Option.bind_eq_bind, Option.bind_some] at h
              obtain ⟨prerelease, hall, hr5⟩ := (matchPrereleaseAndEnd_iff r5).mp h
              obtain ⟨major, e1⟩ := matchVersionNumber_sound h1
              obtain ⟨minor, e3⟩ := matchVersionNumber_sound h3
              obtain ⟨patch, e5⟩ := matchVersionNumber_sound h5
              rw [matchPoint_eq_some_iff] at h2 h4
              refine ⟨⟨major, minor, patch, prerelease⟩, hall, ?_⟩
              rw [SemanticVersionFields.chars, e1, h2, e3, h4, e5, hr5]
  · rintro ⟨⟨major, minor, patch, prerelease⟩, hall, rfl⟩
    have point : ∀ (rest : List Char) (c : Char) (tail : List Char),
        '.' :: rest = c :: tail → isAsciiDigit c = false := by
      intro rest c tail h
      rw [← (List.cons.inj h).1]
      decide
    have last : ∀ (c : Char) (tail : List Char),
        (if prerelease = [] then [] else '-' :: prerelease) = c :: tail →
          isAsciiDigit c = false := by
      intro c tail h
      by_cases hp : prerelease = []
      · simp [hp] at h
      · simp only [hp, ↓reduceIte, List.cons.injEq] at h
        rw [← h.1]
        decide
    simp only [SemanticVersionFields.chars, Option.bind_eq_bind,
      matchVersionNumber_decimalChars major (point _), Option.bind_some,
      (matchPoint_eq_some_iff _ _).mpr rfl, matchVersionNumber_decimalChars minor (point _),
      matchVersionNumber_decimalChars patch last]
    exact (matchPrereleaseAndEnd_iff _).mpr ⟨prerelease, hall, rfl⟩

/-! ## Laws of `semanticVersion` -/

/-- `semanticVersion` accepts a text exactly when it is three numbers in decimal without leading
zeros, joined by points, optionally followed by a hyphen and one or more ASCII letters, digits,
points or hyphens; and it returns that text unchanged. -/
theorem semanticVersion_ok_iff (value : String) (v : SemanticVersion) :
    semanticVersion value = .ok v ↔ v.value = value ∧ v.WF := by
  unfold semanticVersion SemanticVersion.WF
  by_cases h : matchSemanticVersion value.toList = true
  · simp only [h, Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq]
    obtain ⟨f, hf, hc⟩ := (matchSemanticVersion_iff _).mp h
    constructor
    · rintro rfl
      exact ⟨rfl, f, hf, by rw [SemanticVersionFields.format, ← hc, String.ofList_toList]⟩
    · rintro ⟨rfl, -⟩
      rfl
  · simp only [h, Bool.not_false, ↓reduceIte, reduceCtorEq, false_iff, not_and, not_exists]
    rintro rfl f hf hv
    exact h ((matchSemanticVersion_iff _).mpr
      ⟨f, hf, by rw [hv, SemanticVersionFields.format, String.toList_ofList]⟩)


/-- `semanticVersion` accepts every version written out from its parts. -/
theorem semanticVersion_format {f : SemanticVersionFields} (h : f.Valid) :
    semanticVersion f.format = .ok ⟨f.format⟩ :=
  (semanticVersion_ok_iff _ _).mpr ⟨rfl, f, h, rfl⟩

/-- `semanticVersion` fails with one error only: `Invalid semantic version:` and the text. -/
theorem semanticVersion_error {value : String} {err : SemanticVersionErr}
    (h : semanticVersion value = .error err) : err = .invalidSemanticVersion value := by
  unfold semanticVersion at h
  split at h
  · exact (Except.error.inj h).symm
  · exact absurd h (by simp)

example : semanticVersion "1.0.0-01" = .ok ⟨"1.0.0-01"⟩ := by decide
example : semanticVersion "1.0.0-.." = .ok ⟨"1.0.0-.."⟩ := by decide
example : semanticVersion "1.0.0+build" = .error (.invalidSemanticVersion "1.0.0+build") := by
  decide
example : semanticVersion "01.0.0" = .error (.invalidSemanticVersion "01.0.0") := by decide
example : localDate "0000-02-29" = .ok ⟨"0000-02-29"⟩ := by decide
example : instant "2024-01-01T00:00:00-14:00" = .ok ⟨"2024-01-01T00:00:00-14:00"⟩ := by decide
example : instant "2023-02-29T00:00:00Z" = .error (.invalidLocalDate "2023-02-29") := by decide
example : instant "2024-06-30T23:59:60Z" =
    .error (.invalidSuppliedInstant "2024-06-30T23:59:60Z") := by decide


/-! ## `instantMillis` (`policy.ts` line 116): what `Date.parse` reads from an instant

`instantMillis` is `Date.parse(value)`, and a `RangeError` when the result is not finite. ECMAScript
fixes `Date.parse` only for its own date-time format, in which the fraction of a second has exactly
three digits; for any other number of digits the result is left to the engine. `instant` accepts
any number of digits, so the model below is an assumption about the engines, not a reading of the
standard. The rule for the fraction is the one V8's reader of ISO dates applies; its only warrant
here is observation: this model and `Date.parse` were run on the same generated instants under
Bun 1.4.4 and Node 26.12.1 and did not differ (the counts are in the report of the work). -/

/-- The number a list of digits spells. -/
def digitsValue (digits : List Nat) : Nat := digits.foldl (fun acc digit => acc * 10 + digit) 0

/-- The milliseconds `Date.parse` takes from the digits after the decimal point. The engine skips
leading zeros, reads at most nine of the digits that follow as a number, and scales that number by
the count of all the digits, a count it caps at nine. -/
def dateParseFractionMillis (digits : List Nat) : Nat :=
  let number := digitsValue ((digits.dropWhile (· == 0)).take 9)
  if digits.length = 0 then 0
  else if digits.length = 1 then number * 100
  else if digits.length = 2 then number * 10
  else if digits.length = 3 then number
  else number / 10 ^ (min digits.length 9 - 3)

/-- An offset in minutes east of UTC. -/
def InstantOffset.minutes : InstantOffset → Int
  | .utc => 0
  | .plus hours minutes => (hours * 60 + minutes : Nat)
  | .minus hours minutes => -((hours * 60 + minutes : Nat) : Int)

/-- What `Date.parse` answers for an instant with these parts: milliseconds from
1970-01-01T00:00:00Z, which is day 719528 of the day count. -/
def InstantFields.dateParseMillis (f : InstantFields) : Int :=
  ((((f.date.dayNumber : Int) - 719528) * 86400 + f.hour * 3600 + f.minute * 60 + f.second) * 1000
    + dateParseFractionMillis f.fraction) - f.offset.minutes * 60000

/-- `Date.parse(text)` for a text that `instant` accepts. `none` stands for every other text: there
the engines read many more formats, each in its own way, and none of it is modelled, because an
`Instant` is never such a text. -/
def dateParse (text : String) : Option Int :=
  match instant text with
  | .ok found => some found.toFields.dateParseMillis
  | .error _ => none

/-- `instantMillis` (`policy.ts` line 116). On a text `instant` accepts, `Date.parse` is a whole
number of milliseconds within the range of a JavaScript date, so `Number.isFinite` holds and nothing
is thrown. The error stands for the texts that are not modelled (see `dateParse`). -/
def instantMillis (value : Instant) : Except TemporalErr Int :=
  match dateParse value.value with
  | some millis => .ok millis
  | none => .error (.invalidSuppliedInstant value.value)


/-! ## Laws of `instantMillis` -/

/-- `instantMillis` never throws on an `Instant` that `instant` built, and answers what
`Date.parse` reads from its parts. -/
theorem instantMillis_ok {i : Instant} (h : i.WF) :
    instantMillis i = .ok i.toFields.dateParseMillis := by
  have : instant i.value = .ok i := (instant_ok_iff _ _).mpr ⟨rfl, h⟩
  simp [instantMillis, dateParse, this]

theorem foldl_digits (digits : List Nat) (acc : Nat) :
    digits.foldl (fun acc digit => acc * 10 + digit) acc =
      acc * 10 ^ digits.length + digitsValue digits := by
  induction digits generalizing acc with
  | nil => simp [digitsValue]
  | cons d ds ih =>
    simp only [List.foldl_cons, digitsValue, List.length_cons]
    rw [ih, ih (0 * 10 + d), Nat.pow_succ]
    ring

theorem digitsValue_cons (d : Nat) (ds : List Nat) :
    digitsValue (d :: ds) = d * 10 ^ ds.length + digitsValue ds := by
  rw [digitsValue, List.foldl_cons, foldl_digits]
  simp

theorem digitsValue_append (xs ys : List Nat) :
    digitsValue (xs ++ ys) = digitsValue xs * 10 ^ ys.length + digitsValue ys := by
  rw [digitsValue, List.foldl_append, foldl_digits]
  rfl

theorem digitsValue_lt {digits : List Nat} (h : ∀ digit ∈ digits, digit < 10) :
    digitsValue digits < 10 ^ digits.length := by
  induction digits with
  | nil => simp [digitsValue]
  | cons d ds ih =>
    rw [digitsValue_cons, List.length_cons, Nat.pow_succ]
    have h1 := h d (by simp)
    have h2 := ih (fun x hx => h x (by simp [hx]))
    have h3 : d * 10 ^ ds.length ≤ 9 * 10 ^ ds.length := Nat.mul_le_mul_right _ (by omega)
    omega

/-- Zeros in front do not change the number that digits spell. -/
theorem digitsValue_dropWhile_zero (digits : List Nat) :
    digitsValue (digits.dropWhile (· == 0)) = digitsValue digits := by
  induction digits with
  | nil => rfl
  | cons d ds ih =>
    by_cases hd : d = 0
    · subst hd
      rw [List.dropWhile_cons_of_pos (by simp), ih, digitsValue_cons]
      simp
    · rw [List.dropWhile_cons_of_neg (by simp [hd])]

/-- The first `count` digits spell the whole number with its last digits cut off. -/
theorem digitsValue_take {digits : List Nat} (h : ∀ digit ∈ digits, digit < 10) (count : Nat) :
    digitsValue (digits.take count) = digitsValue digits / 10 ^ (digits.length - count) := by
  have hsplit := digitsValue_append (digits.take count) (digits.drop count)
  rw [List.take_append_drop, List.length_drop] at hsplit
  have hlt : digitsValue (digits.drop count) < 10 ^ (digits.length - count) := by
    have := digitsValue_lt (digits := digits.drop count)
      (fun x hx => h x (List.mem_of_mem_drop hx))
    rwa [List.length_drop] at this
  rw [hsplit, Nat.add_comm, Nat.add_mul_div_right _ _ (Nat.pow_pos (by decide)),
    Nat.div_eq_of_lt hlt, Nat.zero_add]
/-- When the fraction has at most nine digits, or does not start with a zero, the milliseconds
`Date.parse` takes from it are the fraction cut off after its third digit. -/
theorem dateParseFractionMillis_eq {digits : List Nat} (h : ∀ digit ∈ digits, digit < 10)
    (hshape : digits.length ≤ 9 ∨ digits.head? ≠ some 0) :
    dateParseFractionMillis digits = digitsValue digits * 1000 / 10 ^ digits.length := by
  by_cases hlen : digits.length ≤ 9
  · have hall : ((digits.dropWhile (· == 0)).take 9) = digits.dropWhile (· == 0) :=
      List.take_of_length_le (Nat.le_trans (List.dropWhile_sublist _).length_le hlen)
    unfold dateParseFractionMillis
    simp only [hall, digitsValue_dropWhile_zero]
    have hv := digitsValue_lt h
    generalize digitsValue digits = number at *
    generalize hL : digits.length = length at *
    have cases : length = 0 ∨ length = 1 ∨ length = 2 ∨ length = 3 ∨ length = 4 ∨ length = 5 ∨
        length = 6 ∨ length = 7 ∨ length = 8 ∨ length = 9 := by omega
    rcases cases with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
      norm_num at hv ⊢ <;> omega
  · have hhead : digits.head? ≠ some 0 := hshape.resolve_left hlen
    have hdrop : digits.dropWhile (· == 0) = digits := by
      cases digits with
      | nil => rfl
      | cons d ds =>
        have : d ≠ 0 := fun hd => hhead (by simp [hd])
        exact List.dropWhile_cons_of_neg (by simp [this])
    have hmin : min digits.length 9 - 3 = 6 := by omega
    have hpow : (10 : Nat) ^ digits.length = 10 ^ (digits.length - 9) * 10 ^ 6 * 1000 := by
      have e : digits.length = (digits.length - 9) + 9 := by omega
      conv_lhs => rw [e, Nat.pow_add]
      norm_num [Nat.mul_assoc]
    unfold dateParseFractionMillis
    simp only [hdrop, digitsValue_take h 9, show ¬ digits.length = 0 by omega,
      show ¬ digits.length = 1 by omega, show ¬ digits.length = 2 by omega,
      show ¬ digits.length = 3 by omega, ↓reduceIte]
    rw [hmin, Nat.div_div_eq_div_mul, hpow, Nat.mul_div_mul_right _ _ (by decide)]
/-- The milliseconds `Date.parse` takes from a fraction are always below one thousand. -/
theorem dateParseFractionMillis_lt {digits : List Nat} (h : ∀ digit ∈ digits, digit < 10) :
    dateParseFractionMillis digits < 1000 := by
  have hsig : ∀ digit ∈ (digits.dropWhile (· == 0)).take 9, digit < 10 := fun x hx =>
    h x ((List.dropWhile_sublist _).subset (List.mem_of_mem_take hx))
  have hv := digitsValue_lt hsig
  have hlen9 : ((digits.dropWhile (· == 0)).take 9).length ≤ 9 := by
    rw [List.length_take]; omega
  have hlenL : ((digits.dropWhile (· == 0)).take 9).length ≤ digits.length := by
    rw [List.length_take]
    have := (List.dropWhile_sublist (· == 0) (l := digits)).length_le
    omega
  unfold dateParseFractionMillis
  dsimp only
  generalize digitsValue ((digits.dropWhile (· == 0)).take 9) = number at *
  generalize ((digits.dropWhile (· == 0)).take 9).length = k at *
  generalize digits.length = length at *
  have hk : number < 10 ^ (min length 9) :=
    Nat.lt_of_lt_of_le hv (Nat.pow_le_pow_right (by decide) (by omega))
  split_ifs with h0 h1 h2 h3
  · omega
  · subst h1; norm_num at hk; omega
  · subst h2; norm_num at hk; omega
  · subst h3; norm_num at hk; omega
  · have e : min length 9 = (min length 9 - 3) + 3 := by omega
    rw [e, Nat.pow_add] at hk
    exact Nat.div_lt_of_lt_mul hk

/-- A fraction of ten or more digits that starts with a zero is misread: of `.0123456789`
`Date.parse` makes 123 milliseconds, and the fraction cut off after its third digit is 12. -/
theorem dateParseFractionMillis_misread :
    dateParseFractionMillis [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] = 123 ∧
      digitsValue [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] * 1000 / 10 ^ 10 = 12 := by
  decide


/-! ## What `semanticVersion` accepts that Semantic Versioning does not, and the reverse -/

/-- `semanticVersion` accepts a numeric prerelease part with a leading zero, which Semantic
Versioning 2.0.0 forbids. -/
theorem semanticVersion_accepts_leading_zero_prerelease :
    semanticVersion "1.0.0-01" = .ok ⟨"1.0.0-01"⟩ := by decide

/-- `semanticVersion` accepts empty prerelease parts, which Semantic Versioning 2.0.0 forbids. -/
theorem semanticVersion_accepts_empty_prerelease_parts :
    semanticVersion "1.0.0-.." = .ok ⟨"1.0.0-.."⟩ := by decide

/-- `semanticVersion` rejects build metadata, which Semantic Versioning 2.0.0 allows. -/
theorem semanticVersion_rejects_build_metadata :
    semanticVersion "1.0.0+build" = .error (.invalidSemanticVersion "1.0.0+build") := by decide

/-! ## Laws of the identifier makers -/

/-- `policyId` accepts exactly the well-formed identifier texts and returns the text unchanged. -/
theorem policyId_ok_iff (value : String) (id : PolicyId) :
    policyId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `evidenceId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem evidenceId_ok_iff (value : String) (id : EvidenceId) :
    evidenceId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `derivationId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem derivationId_ok_iff (value : String) (id : DerivationId) :
    derivationId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `policyCapabilityId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem policyCapabilityId_ok_iff (value : String) (id : PolicyCapabilityId) :
    policyCapabilityId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _


/-! ## An instant is not ordered by its text

Unlike a `LocalDate`, an `Instant` does not sort as a string. The same moment has many texts (with
`Z` or `+00:00`, with or without a fraction, at any offset), and a point sorts before `Z`. Code that
compares two `Instant`s with `<` compares texts; only `instantMillis` compares moments. -/

/-- Half a second after midnight sorts, as a JavaScript string, before midnight itself; `Date.parse`
puts it 500 milliseconds after. -/
theorem instant_string_order_is_not_time_order :
    instant "2024-01-01T00:00:00.5Z" = .ok ⟨"2024-01-01T00:00:00.5Z"⟩ ∧
      instant "2024-01-01T00:00:00Z" = .ok ⟨"2024-01-01T00:00:00Z"⟩ ∧
      jsStringLt "2024-01-01T00:00:00.5Z" "2024-01-01T00:00:00Z" = true ∧
      instantMillis ⟨"2024-01-01T00:00:00.5Z"⟩ = .ok 1704067200500 ∧
      instantMillis ⟨"2024-01-01T00:00:00Z"⟩ = .ok 1704067200000 := by
  decide +kernel

/-- One moment written at two offsets is two different `Instant`s, and they sort apart. -/
theorem instant_same_moment_two_texts :
    instantMillis ⟨"2024-01-01T02:00:00+02:00"⟩ = .ok 1704067200000 ∧
      instantMillis ⟨"2024-01-01T00:00:00Z"⟩ = .ok 1704067200000 ∧
      jsStringLt "2024-01-01T00:00:00Z" "2024-01-01T02:00:00+02:00" = true := by
  decide +kernel

/-- `Date.parse` reads `.0123456789` of a second as later than `.1` of a second. -/
theorem instantMillis_misread_order :
    instantMillis ⟨"2020-01-01T00:00:00.0123456789Z"⟩ = .ok 1577836800123 ∧
      instantMillis ⟨"2020-01-01T00:00:00.1Z"⟩ = .ok 1577836800100 := by
  decide +kernel

end Rastrata.Kernel

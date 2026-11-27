/-
The vocabulary of the journal: the Lean model of `packages/kernel/src/journal.ts` from its first
line through `diagnostic` (the identifier types and their makers, `LocalDate` and `localDate`,
`Instant` and `instant`, the value, snapshot and transaction types, and the diagnostic codes).

Three layers, as everywhere in this project:

1. Model: `localDate`, `instant`, the identifier makers and `diagnostic` do what the TypeScript does.
   A regular expression is modelled character by character (`matchLocalDate`, `matchInstant`).
2. Meaning: a `CalendarDate` (year, month, day) and its day number; `InstantFields`.
3. Laws: each validator accepts exactly its format; an accepted local date is a real date of the
   proleptic Gregorian calendar; and the order of two accepted local dates as JavaScript strings
   is their order as dates. (Two instants do not have that last property: see
   `instant_string_order_is_not_time_order` in `Policy/Types.lean`.)

Nothing after `diagnostic` in `journal.ts` is modelled here: admission and the canonical value of a
journal are the next wave.

What is assumed about JavaScript is said where it is used and collected here:

- A JavaScript string is a sequence of UTF-16 code units and may hold a lone surrogate; a Lean
  `String` is a sequence of Unicode scalar values and cannot. Every position of the two regular
  expressions below demands an ASCII character, so a string with a lone surrogate is rejected by
  the TypeScript; the model simply has no such input.
- Neither regular expression has the `u`, `i` or `m` flag: `\d` is exactly `0` to `9`, letters match
  only themselves, and `^` and `$` match only at the two ends of the whole string (a trailing line
  break is not skipped).
- `Number(text)` of a text of one to four ASCII digits is its decimal value.
- `left < right` and `left <= right` on two strings compare UTF-16 code units (`compareCanonicalText`).
-/
import Rastrata.Prelude
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.Canonical

namespace Rastrata.Kernel

/-! ## Identifier types and their makers (`journal.ts` lines 11 to 27) -/

/-- `BookId`. -/
abbrev BookId := Identifier "Book"

/-- `AccountId`. -/
abbrev AccountId := Identifier "Account"

/-- `CommodityId`. -/
abbrev CommodityId := Identifier "Commodity"

/-- `DimensionId`. -/
abbrev DimensionId := Identifier "AccountingDimension"

/-- `DimensionMemberId`. -/
abbrev DimensionMemberId := Identifier "DimensionMember"

/-- `JournalId`. -/
abbrev JournalId := Identifier "JournalTransaction"

/-- `PostingId`. -/
abbrev PostingId := Identifier "Posting"

/-- `bookId`. -/
def bookId (value : String) : Except CanonicalErr BookId := identifier "Book" value

/-- `accountId`. -/
def accountId (value : String) : Except CanonicalErr AccountId := identifier "Account" value

/-- `commodityId`. -/
def commodityId (value : String) : Except CanonicalErr CommodityId := identifier "Commodity" value

/-- `dimensionId`. -/
def dimensionId (value : String) : Except CanonicalErr DimensionId :=
  identifier "AccountingDimension" value

/-- `dimensionMemberId`. -/
def dimensionMemberId (value : String) : Except CanonicalErr DimensionMemberId :=
  identifier "DimensionMember" value

/-- `journalId`. -/
def journalId (value : String) : Except CanonicalErr JournalId :=
  identifier "JournalTransaction" value

/-- `postingId`. -/
def postingId (value : String) : Except CanonicalErr PostingId := identifier "Posting" value

/-! ## `LocalDate` and `Instant` (`journal.ts` lines 29 to 93): the model -/

/-- The two `RangeError`s of `localDate` and `instant`, told apart by their message:
`Invalid local date: ${value}` and `Invalid supplied instant: ${value}`. -/
inductive TemporalErr where
  | invalidLocalDate (value : String)
  | invalidSuppliedInstant (value : String)
  deriving DecidableEq, Repr, Inhabited

/-- `LocalDate`: a branded string. Built only by `localDate`, as in the TypeScript. -/
structure LocalDate where
  value : String
  deriving DecidableEq, Repr, Inhabited

/-- `Instant`: a branded string. Built only by `instant`, as in the TypeScript. -/
structure Instant where
  value : String
  deriving DecidableEq, Repr, Inhabited

/-- `\d` in a regular expression without the `u` flag: one of the ten characters `0` to `9`. -/
def isAsciiDigit (c : Char) : Bool := decide (48 ≤ c.toNat ∧ c.toNat ≤ 57)

/-- The value of one ASCII digit. -/
def digitValue (c : Char) : Nat := c.toNat - 48

/-- `Number(text)` for a text the regular expression has shown to be ASCII digits only. -/
def digitsToNat (text : List Char) : Nat := text.foldl (fun acc c => acc * 10 + digitValue c) 0

/-- `isLeapYear` (`journal.ts` line 35). -/
def isLeapYear (year : Nat) : Bool := year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)

/-- `/^(\d{4})-(\d{2})-(\d{2})$/.exec(value)`: the three captures, or `none` for `null`. -/
def matchLocalDate : List Char → Option (List Char × List Char × List Char)
  | [y1, y2, y3, y4, s1, m1, m2, s2, d1, d2] =>
    if isAsciiDigit y1 && isAsciiDigit y2 && isAsciiDigit y3 && isAsciiDigit y4 && s1 == '-' &&
        isAsciiDigit m1 && isAsciiDigit m2 && s2 == '-' && isAsciiDigit d1 && isAsciiDigit d2 then
      some ([y1, y2, y3, y4], [m1, m2], [d1, d2])
    else none
  | _ => none

/-- `localDate` (`journal.ts` line 39). `daysInMonth[month - 1]` is `undefined` for month `00`
(index `-1`) and for months above `12`. -/
def localDate (value : String) : Except TemporalErr LocalDate :=
  match matchLocalDate value.toList with
  | none => .error (.invalidLocalDate value)
  | some (yearText, monthText, dayText) =>
    let year := digitsToNat yearText
    let month := digitsToNat monthText
    let day := digitsToNat dayText
    let daysInMonth : List Nat :=
      [31, if isLeapYear year then 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    let maximumDay : Option Nat := if month = 0 then none else daysInMonth[month - 1]?
    match maximumDay with
    | none => .error (.invalidLocalDate value)
    | some maximumDay =>
      if day < 1 || day > maximumDay then .error (.invalidLocalDate value)
      else .ok ⟨value⟩

/-- What `matchInstant` found. `date`, `hourText`, `minuteText` and `secondText` are the
captures 1 to 4 of the regular expression; `offset` is `none` for `Z` and otherwise the sign with
the captures 6 and 7. `fraction` (the digits after the point, empty when there is no point) and the
sign are not captured by the TypeScript and not read by `instant`; they are kept for the meaning. -/
structure InstantMatch where
  date : List Char
  hourText : List Char
  minuteText : List Char
  secondText : List Char
  fraction : List Char
  offset : Option (Char × List Char × List Char)
  deriving DecidableEq, Repr, Inhabited

/-- `(?:\.\d+)?` at the head of `cs`: the digits it took and what is left. With a point at the
head the group must match (the offset cannot start with a point) and must take every digit that
follows (the offset cannot start with a digit), so the match is decided without backtracking. -/
def matchFraction : List Char → Option (List Char × List Char)
  | [] => some ([], [])
  | c :: rest =>
    if c == '.' then
      if (rest.takeWhile isAsciiDigit).isEmpty then none
      else some (rest.takeWhile isAsciiDigit, rest.dropWhile isAsciiDigit)
    else some ([], c :: rest)

/-- `(Z|[+-](\d{2}):(\d{2}))$`: `some none` for `Z`, the sign and the two captures otherwise. -/
def matchOffset : List Char → Option (Option (Char × List Char × List Char))
  | [z] => if z == 'Z' then some none else none
  | [sign, h1, h2, colon, m1, m2] =>
    if (sign == '+' || sign == '-') && isAsciiDigit h1 && isAsciiDigit h2 && colon == ':' &&
        isAsciiDigit m1 && isAsciiDigit m2 then
      some (some (sign, [h1, h2], [m1, m2]))
    else none
  | _ => none

/-- `/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)`,
or `none` for `null`. -/
def matchInstant : List Char → Option InstantMatch
  | y1 :: y2 :: y3 :: y4 :: s1 :: m1 :: m2 :: s2 :: d1 :: d2 :: t ::
      h1 :: h2 :: c1 :: n1 :: n2 :: c2 :: e1 :: e2 :: rest =>
    if isAsciiDigit y1 && isAsciiDigit y2 && isAsciiDigit y3 && isAsciiDigit y4 && s1 == '-' &&
        isAsciiDigit m1 && isAsciiDigit m2 && s2 == '-' && isAsciiDigit d1 && isAsciiDigit d2 &&
        t == 'T' && isAsciiDigit h1 && isAsciiDigit h2 && c1 == ':' &&
        isAsciiDigit n1 && isAsciiDigit n2 && c2 == ':' && isAsciiDigit e1 && isAsciiDigit e2 then
      match matchFraction rest with
      | none => none
      | some (fraction, tail) =>
        match matchOffset tail with
        | none => none
        | some offset =>
          some
            { date := [y1, y2, y3, y4, s1, m1, m2, s2, d1, d2]
              hourText := [h1, h2], minuteText := [n1, n2], secondText := [e1, e2]
              fraction, offset }
    else none
  | _ => none

/-- `instant` (`journal.ts` line 61). The date is checked by `localDate`, whose own error escapes
(`Invalid local date:` with the date part, not the whole value); then the time of day; then the
offset, which may be at most fourteen hours either way. -/
def instant (value : String) : Except TemporalErr Instant :=
  match matchInstant value.toList with
  | none => .error (.invalidSuppliedInstant value)
  | some found =>
    match localDate (String.ofList found.date) with
    | .error err => .error err
    | .ok _ =>
      let hour := digitsToNat found.hourText
      let minute := digitsToNat found.minuteText
      let second := digitsToNat found.secondText
      if hour > 23 || minute > 59 || second > 59 then .error (.invalidSuppliedInstant value)
      else
        match found.offset with
        | none => .ok ⟨value⟩
        | some (_, offsetHourText, offsetMinuteText) =>
          let offsetHour := digitsToNat offsetHourText
          let offsetMinute := digitsToNat offsetMinuteText
          if offsetHour > 14 || offsetMinute > 59 || (offsetHour == 14 && offsetMinute != 0) then
            .error (.invalidSuppliedInstant value)
          else .ok ⟨value⟩

/-- JavaScript `left < right` on two strings: by UTF-16 code unit. -/
def jsStringLt (left right : String) : Bool := compareCanonicalText left right == .lt

/-- JavaScript `left <= right` on two strings: by UTF-16 code unit. -/
def jsStringLe (left right : String) : Bool := compareCanonicalText left right != .gt

/-- `left < right` on two `LocalDate`s is JavaScript's order of the two strings. -/
instance : LT LocalDate := ⟨fun left right => jsStringLt left.value right.value = true⟩

/-- `left <= right` on two `LocalDate`s is JavaScript's order of the two strings. -/
instance : LE LocalDate := ⟨fun left right => jsStringLe left.value right.value = true⟩

instance (left right : LocalDate) : Decidable (left < right) :=
  inferInstanceAs (Decidable (jsStringLt left.value right.value = true))

instance (left right : LocalDate) : Decidable (left ≤ right) :=
  inferInstanceAs (Decidable (jsStringLe left.value right.value = true))

/-! ## Value, snapshot and transaction types (`journal.ts` lines 95 to 196)

An optional field is an `Option`, a `readonly T[]` a `List`, a `bigint` an `Int`. A union of
string literals written inline in the TypeScript has no name there; it gets one here
(`AccountRole`, `NormalSide`). -/

/-- `Quantity`. -/
structure Quantity where
  canonicalNumber : ExactRational
  commodityId : CommodityId
  sourceNumber : Option ExactDecimal
  deriving DecidableEq, Repr, Inhabited

/-- `BookValue`. -/
structure BookValue where
  amount : ExactDecimal
  functionalCommodityId : CommodityId
  deriving DecidableEq, Repr, Inhabited

/-- `TransactionPrice`. -/
structure TransactionPrice where
  unitRate : ExactRational
  baseCommodityId : CommodityId
  quoteCommodityId : CommodityId
  deriving DecidableEq, Repr, Inhabited

/-- `CostBasis`. -/
structure CostBasis where
  totalBasis : ExactRational
  basisCommodityId : CommodityId
  sourceTotalBasis : Option ExactDecimal
  deriving DecidableEq, Repr, Inhabited

/-- The type of `AccountSnapshot.role`. -/
inductive AccountRole where
  | asset
  | liability
  | equity
  | income
  | expense
  | gain
  | unrealizedGain
  deriving DecidableEq, Repr, Inhabited

/-- The type of `AccountSnapshot.normalSide`. -/
inductive NormalSide where
  | debit
  | credit
  deriving DecidableEq, Repr, Inhabited

/-- `AccountSnapshot`. -/
structure AccountSnapshot where
  id : AccountId
  bookId : BookId
  code : String
  name : String
  role : AccountRole
  normalSide : NormalSide
  postingAllowed : Bool
  openedOn : LocalDate
  closedOn : Option LocalDate
  parentId : Option AccountId
  allowedCommodityIds : List CommodityId
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingDimensionSnapshot`. -/
structure AccountingDimensionSnapshot where
  id : DimensionId
  bookId : BookId
  code : String
  name : String
  openedOn : LocalDate
  closedOn : Option LocalDate
  deriving DecidableEq, Repr, Inhabited

/-- `DimensionMemberSnapshot`. -/
structure DimensionMemberSnapshot where
  id : DimensionMemberId
  dimensionId : DimensionId
  code : String
  name : String
  openedOn : LocalDate
  closedOn : Option LocalDate
  parentId : Option DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `Posting`. -/
structure Posting where
  id : PostingId
  ordinal : Int
  accountId : AccountId
  units : Quantity
  bookValue : BookValue
  transactionPrice : Option TransactionPrice
  costBasis : Option CostBasis
  dimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `JournalKind`. -/
inductive JournalKind where
  | opening
  | ordinary
  | adjustment
  | reversing
  | closing
  deriving DecidableEq, Repr, Inhabited

/-- `JournalTransaction`. -/
structure JournalTransaction where
  id : JournalId
  kind : JournalKind
  bookId : BookId
  functionalCommodityId : CommodityId
  economicAt : Instant
  accountingDate : LocalDate
  settledAt : Option Instant
  recordedAt : Instant
  narration : String
  postings : List Posting
  deriving DecidableEq, Repr, Inhabited

/-- `JournalAdmissionSnapshot`. `requiredDimensionIdsByPosting` is a `Record<string, ...>` in the
TypeScript: here the list of the object's own properties, key and value, in insertion order. What
a JavaScript object answers for a key it inherits (`constructor`, `toString`, `__proto__`) is not
in this type; the wave that models the lookup (`journal.ts` line 843) has to deal with it. -/
structure JournalAdmissionSnapshot where
  bookId : BookId
  functionalCommodityId : CommodityId
  accounts : List AccountSnapshot
  dimensions : List AccountingDimensionSnapshot
  dimensionMembers : List DimensionMemberSnapshot
  requiredDimensionIds : List DimensionId
  requiredDimensionIdsByPosting : Option (List (String × List DimensionId))
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingCoordinate`. -/
structure AccountingCoordinate where
  bookId : BookId
  functionalCommodityId : CommodityId
  accountingDate : LocalDate
  accountId : AccountId
  unitsCommodityId : CommodityId
  dimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-! ## Diagnostics (`journal.ts` lines 198 to 258) -/

/-- `SemanticDiagnosticCode`: one constructor a code, spelled as in the TypeScript. -/
inductive SemanticDiagnosticCode where
  | atomic_commit_failed
  | command_identity_conflict
  | dependent_close_not_current
  | fabricated_opening_journal
  | fiscal_period_admission
  | immutable_book_identity
  | invalid_correction_topology
  | canonical_identity_conflict
  | invalid_chart_or_account
  | invalid_dimension_selection
  | invalid_exact_number
  | invalid_journal_structure
  | book_isolation_violation
  | lot_overallocation
  | policy_ambiguity
  | projection_rebuild_mismatch
  | stale_book_revision
  | ordered_history_violation
  | temporal_semantics_violation
  | transfer_policy_missing
  | unresolved_accounting_input
  | monetary_type_mismatch
  | journal_imbalance
  | inventory_cost_policy_incoherent
  | provisional_inventory_violation
  | inventory_value_adjustment_violation
  | settlement_allocation_violation
  | accounting_basis_policy_incomplete
  | currency_remeasurement_violation
  | allocation_schedule_violation
  | allocation_schedule_revision_violation
  | tax_policy_ambiguity
  | consolidation_input_violation
  | external_accounting_authority
  deriving DecidableEq, Repr, Inhabited

/-- `SemanticDiagnostic`. -/
structure SemanticDiagnostic where
  code : SemanticDiagnosticCode
  path : String
  message : String
  requirementIds : List String
  deriving DecidableEq, Repr, Inhabited

/-- `JournalAdmissionResult`: the two dispositions, `admitted` and `rejected`. -/
inductive JournalAdmissionResult where
  | admitted (canonicalHash : ContentHash)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- `diagnostic` (`journal.ts` line 251). The copy and the freezing of the list are not modelled. -/
def diagnostic (code : SemanticDiagnosticCode) (path message : String)
    (requirementIds : List String) : SemanticDiagnostic :=
  { code, path, message, requirementIds }

/-! ## Meaning: digits, calendar dates and the day number -/

/-- The ASCII digit that writes a number below ten. -/
def digitChar (n : Nat) : Char := Char.ofNat (48 + n)

theorem digitChar_toNat {n : Nat} (h : n < 10) : (digitChar n).toNat = 48 + n := by
  have cases : n = 0 ∨ n = 1 ∨ n = 2 ∨ n = 3 ∨ n = 4 ∨ n = 5 ∨ n = 6 ∨ n = 7 ∨ n = 8 ∨ n = 9 := by
    omega
  rcases cases with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> rfl

theorem isAsciiDigit_digitChar {n : Nat} (h : n < 10) : isAsciiDigit (digitChar n) = true := by
  simp [isAsciiDigit, digitChar_toNat h]; omega

theorem digitValue_digitChar {n : Nat} (h : n < 10) : digitValue (digitChar n) = n := by
  simp [digitValue, digitChar_toNat h]

theorem digitValue_lt {c : Char} (h : isAsciiDigit c = true) : digitValue c < 10 := by
  simp [isAsciiDigit] at h; unfold digitValue; omega

theorem digitChar_digitValue {c : Char} (h : isAsciiDigit c = true) :
    digitChar (digitValue c) = c := by
  simp [isAsciiDigit] at h
  unfold digitChar digitValue
  rw [show 48 + (c.toNat - 48) = c.toNat by omega, Char.ofNat_toNat]

/-- A date of the calendar as three numbers. -/
structure CalendarDate where
  year : Nat
  month : Nat
  day : Nat
  deriving DecidableEq, Repr, Inhabited

namespace CalendarDate

/-- A leap year by the rule of the Gregorian calendar: every fourth year, except the years of a
century that are not a multiple of four hundred. -/
def IsLeapYear (year : Nat) : Prop := (4 ∣ year ∧ ¬ 100 ∣ year) ∨ 400 ∣ year

instance (year : Nat) : Decidable (IsLeapYear year) := by unfold IsLeapYear; infer_instance

/-- The number of days of a month of the Gregorian calendar. -/
def monthLength (year month : Nat) : Nat :=
  if month = 2 then (if IsLeapYear year then 29 else 28)
  else if month = 4 ∨ month = 6 ∨ month = 9 ∨ month = 11 then 30
  else 31

/-- A real date of the proleptic Gregorian calendar in the years 0000 to 9999. -/
structure Valid (d : CalendarDate) : Prop where
  year_le : d.year ≤ 9999
  month_pos : 1 ≤ d.month
  month_le : d.month ≤ 12
  day_pos : 1 ≤ d.day
  day_le : d.day ≤ monthLength d.year d.month

/-- The ten characters `YYYY-MM-DD` of a date. -/
def chars (d : CalendarDate) : List Char :=
  [digitChar (d.year / 1000 % 10), digitChar (d.year / 100 % 10), digitChar (d.year / 10 % 10),
    digitChar (d.year % 10), '-', digitChar (d.month / 10 % 10), digitChar (d.month % 10), '-',
    digitChar (d.day / 10 % 10), digitChar (d.day % 10)]

/-- A date written `YYYY-MM-DD`. -/
def format (d : CalendarDate) : String := String.ofList d.chars

/-- The order of the calendar: by year, then month, then day. -/
def Before (a b : CalendarDate) : Prop :=
  a.year < b.year ∨ (a.year = b.year ∧ (a.month < b.month ∨ (a.month = b.month ∧ a.day < b.day)))

end CalendarDate

/-! ## Laws of `localDate` -/

theorem isAsciiDigit_digitChar_mod (n : Nat) : isAsciiDigit (digitChar (n % 10)) = true :=
  isAsciiDigit_digitChar (Nat.mod_lt _ (by decide))

theorem digitValue_digitChar_mod (n : Nat) : digitValue (digitChar (n % 10)) = n % 10 :=
  digitValue_digitChar (Nat.mod_lt _ (by decide))

theorem eq_digitChar {c : Char} (h : isAsciiDigit c = true) {n : Nat} (hn : n = digitValue c) :
    c = digitChar n := by
  rw [hn, digitChar_digitValue h]

/-- `isLeapYear` decides the leap years of the Gregorian calendar. -/
theorem isLeapYear_iff (year : Nat) : isLeapYear year = true ↔ CalendarDate.IsLeapYear year := by
  unfold isLeapYear CalendarDate.IsLeapYear
  simp only [Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq, bne_iff_ne, ne_eq,
    Nat.dvd_iff_mod_eq_zero]
  omega

/-- The year, month and day that `localDate` reads from a text, as numbers, or `none` when the
regular expression does not match. -/
def parseLocalDate (cs : List Char) : Option CalendarDate :=
  match matchLocalDate cs with
  | none => none
  | some (yearText, monthText, dayText) =>
    some ⟨digitsToNat yearText, digitsToNat monthText, digitsToNat dayText⟩

theorem parseLocalDate_eq_some_iff (cs : List Char) (d : CalendarDate) :
    parseLocalDate cs = some d ↔
      d.year ≤ 9999 ∧ d.month ≤ 99 ∧ d.day ≤ 99 ∧ cs = d.chars := by
  constructor
  · intro h
    unfold parseLocalDate at h
    split at h
    · exact absurd h (by simp)
    · rename_i yt mt dt hm
      unfold matchLocalDate at hm
      split at hm
      · rename_i y1 y2 y3 y4 s1 m1 m2 s2 d1 d2
        split at hm
        · rename_i hc
          simp only [Bool.and_eq_true, beq_iff_eq] at hc
          obtain ⟨⟨⟨⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, rfl⟩, h5⟩, h6⟩, rfl⟩, h7⟩, h8⟩ := hc
          simp only [Option.some.injEq, Prod.mk.injEq] at hm
          obtain ⟨rfl, rfl, rfl⟩ := hm
          simp only [Option.some.injEq] at h
          subst h
          have b1 := digitValue_lt h1
          have b2 := digitValue_lt h2
          have b3 := digitValue_lt h3
          have b4 := digitValue_lt h4
          have b5 := digitValue_lt h5
          have b6 := digitValue_lt h6
          have b7 := digitValue_lt h7
          have b8 := digitValue_lt h8
          simp only [digitsToNat, List.foldl_cons, List.foldl_nil, CalendarDate.chars]
          refine ⟨by omega, by omega, by omega, ?_⟩
          rw [← eq_digitChar h1 (by omega), ← eq_digitChar h2 (by omega),
            ← eq_digitChar h3 (by omega), ← eq_digitChar h4 (by omega),
            ← eq_digitChar h5 (by omega), ← eq_digitChar h6 (by omega),
            ← eq_digitChar h7 (by omega), ← eq_digitChar h8 (by omega)]
        · exact absurd hm (by simp)
      · exact absurd hm (by simp)
  · rintro ⟨hy, hm, hd, rfl⟩
    obtain ⟨y, m, d⟩ := d
    simp only at hy hm hd
    simp only [parseLocalDate, matchLocalDate, CalendarDate.chars, isAsciiDigit_digitChar_mod,
      beq_self_eq_true, Bool.and_self, ite_true, digitsToNat, List.foldl_cons, List.foldl_nil,
      digitValue_digitChar_mod, Option.some.injEq, CalendarDate.mk.injEq]
    omega


theorem maximumDay_eq (year month : Nat) :
    (if month = 0 then none else
      ([31, if isLeapYear year then 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] :
        List Nat)[month - 1]?) =
      if 1 ≤ month ∧ month ≤ 12 then some (CalendarDate.monthLength year month) else none := by
  have leap : (if isLeapYear year then 29 else 28) =
      if CalendarDate.IsLeapYear year then 29 else 28 := by
    by_cases h : CalendarDate.IsLeapYear year
    · simp [h, (isLeapYear_iff year).mpr h]
    · have : isLeapYear year = false := by
        rw [← Bool.not_eq_true, isLeapYear_iff]; exact h
      simp [h, this]
  by_cases h0 : month = 0
  · simp [h0]
  by_cases h13 : 13 ≤ month
  · have : ¬ (1 ≤ month ∧ month ≤ 12) := by omega
    simp only [h0, this, ↓reduceIte]
    exact List.getElem?_eq_none (by simp; omega)
  have cases : month = 1 ∨ month = 2 ∨ month = 3 ∨ month = 4 ∨ month = 5 ∨ month = 6 ∨
      month = 7 ∨ month = 8 ∨ month = 9 ∨ month = 10 ∨ month = 11 ∨ month = 12 := by omega
  rcases cases with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
    simp [CalendarDate.monthLength, leap]

theorem CalendarDate.Valid.month_le_99 {c : CalendarDate} (h : c.Valid) : c.month ≤ 99 := by
  have := h.month_le; omega

theorem CalendarDate.Valid.day_le_31 {c : CalendarDate} (h : c.Valid) : c.day ≤ 31 := by
  have := h.day_le; unfold CalendarDate.monthLength at this; split_ifs at this <;> omega

theorem parseLocalDate_format {c : CalendarDate} (h : c.Valid) :
    parseLocalDate c.format.toList = some c :=
  (parseLocalDate_eq_some_iff _ _).mpr ⟨h.year_le, h.month_le_99, by have := h.day_le_31; omega,
    by rw [CalendarDate.format, String.toList_ofList]⟩

theorem format_of_parseLocalDate {value : String} {c : CalendarDate}
    (h : parseLocalDate value.toList = some c) : value = c.format := by
  have := ((parseLocalDate_eq_some_iff _ _).mp h).2.2.2
  rw [CalendarDate.format, ← this, String.ofList_toList]

/-- What every `LocalDate` that `localDate` returns satisfies: it is a real date of the calendar,
written `YYYY-MM-DD`. -/
def LocalDate.WF (d : LocalDate) : Prop := ∃ c : CalendarDate, c.Valid ∧ d.value = c.format

/-- `localDate` accepts a text exactly when it is a real date of the proleptic Gregorian calendar
in the years 0000 to 9999 written `YYYY-MM-DD`, and returns that text unchanged. -/
theorem localDate_ok_iff (value : String) (d : LocalDate) :
    localDate value = .ok d ↔ d.value = value ∧ d.WF := by
  unfold localDate LocalDate.WF
  cases hm : matchLocalDate value.toList with
  | none =>
    simp only [reduceCtorEq, false_iff, not_and, not_exists]
    rintro rfl c hc hf
    have := parseLocalDate_format hc
    rw [← hf] at this
    simp [parseLocalDate, hm] at this
  | some found =>
    obtain ⟨yt, mt, dt⟩ := found
    have hp : parseLocalDate value.toList =
        some ⟨digitsToNat yt, digitsToNat mt, digitsToNat dt⟩ := by
      simp [parseLocalDate, hm]
    have hy := ((parseLocalDate_eq_some_iff _ _).mp hp).1
    have unique : ∀ c : CalendarDate, c.Valid → value = c.format →
        c = ⟨digitsToNat yt, digitsToNat mt, digitsToNat dt⟩ := by
      intro c hc hf
      have := parseLocalDate_format hc
      rw [← hf, hp] at this
      exact (Option.some.inj this).symm
    simp only []
    rw [maximumDay_eq]
    by_cases hmonth : 1 ≤ digitsToNat mt ∧ digitsToNat mt ≤ 12
    · simp only [hmonth, and_self, ↓reduceIte]
      by_cases hday : 1 ≤ digitsToNat dt ∧
          digitsToNat dt ≤ CalendarDate.monthLength (digitsToNat yt) (digitsToNat mt)
      · have : (digitsToNat dt < 1 ||
            digitsToNat dt > CalendarDate.monthLength (digitsToNat yt) (digitsToNat mt)) = false := by
          simp; omega
        simp only [this, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq]
        constructor
        · rintro rfl
          exact ⟨rfl, _, ⟨hy, hmonth.1, hmonth.2, hday.1, hday.2⟩, format_of_parseLocalDate hp⟩
        · rintro ⟨rfl, -⟩
          rfl
      · have : (digitsToNat dt < 1 ||
            digitsToNat dt > CalendarDate.monthLength (digitsToNat yt) (digitsToNat mt)) = true := by
          simp; omega
        simp only [this, ↓reduceIte, reduceCtorEq, false_iff, not_and, not_exists]
        rintro rfl c hc hf
        have hcv := hc
        rw [unique c hc hf] at hcv
        exact hday ⟨hcv.day_pos, hcv.day_le⟩
    · simp only [hmonth, ↓reduceIte, reduceCtorEq, false_iff, not_and, not_exists]
      rintro rfl c hc hf
      have hcv := hc
      rw [unique c hc hf] at hcv
      exact hmonth ⟨hcv.month_pos, hcv.month_le⟩


theorem charToUTF16_of_lt {c : Char} (h : c.toNat < 0x10000) :
    charToUTF16 c = [UInt16.ofNat c.toNat] := by
  simp [charToUTF16, h]

theorem compare_utf16_cons_lt {a b : Char} (ha : a.toNat < 0x10000) (hb : b.toNat < 0x10000)
    (as bs : List Char) :
    compare ((a :: as).flatMap charToUTF16) ((b :: bs).flatMap charToUTF16) = .lt ↔
      a.toNat < b.toNat ∨
        (a.toNat = b.toNat ∧ compare (as.flatMap charToUTF16) (bs.flatMap charToUTF16) = .lt) := by
  simp only [List.flatMap_cons, charToUTF16_of_lt ha, charToUTF16_of_lt hb, List.singleton_append]
  change List.compareLex compare _ _ = .lt ↔ _ ∨ (_ ∧ List.compareLex compare _ _ = .lt)
  rw [List.compareLex_cons_cons]
  have hlt : (UInt16.ofNat a.toNat < UInt16.ofNat b.toNat) ↔ a.toNat < b.toNat := by
    rw [UInt16.lt_iff_toNat_lt, UInt16.toNat_ofNat', UInt16.toNat_ofNat', Nat.mod_eq_of_lt ha,
      Nat.mod_eq_of_lt hb]
  have heq : (UInt16.ofNat a.toNat = UInt16.ofNat b.toNat) ↔ a.toNat = b.toNat := by
    rw [← UInt16.toNat_inj, UInt16.toNat_ofNat', UInt16.toNat_ofNat', Nat.mod_eq_of_lt ha,
      Nat.mod_eq_of_lt hb]
  have hc : compare (UInt16.ofNat a.toNat) (UInt16.ofNat b.toNat) =
      if UInt16.ofNat a.toNat < UInt16.ofNat b.toNat then Ordering.lt
      else if UInt16.ofNat a.toNat = UInt16.ofNat b.toNat then Ordering.eq else Ordering.gt := rfl
  rw [Ordering.then_eq_lt, hc]
  simp only [hlt, heq]
  by_cases h1 : a.toNat < b.toNat
  · simp [h1]
  · by_cases h2 : a.toNat = b.toNat
    · simp [h2]
    · simp [h1, h2]

theorem compare_utf16_nil_lt :
    compare (([] : List Char).flatMap charToUTF16) (([] : List Char).flatMap charToUTF16) = .lt ↔
      False := by
  simp only [List.flatMap_nil, iff_false]
  decide

theorem compare_utf16_digit_cons_lt (x y : Nat) (as bs : List Char) :
    compare ((digitChar (x % 10) :: as).flatMap charToUTF16)
        ((digitChar (y % 10) :: bs).flatMap charToUTF16) = .lt ↔
      x % 10 < y % 10 ∨
        (x % 10 = y % 10 ∧ compare (as.flatMap charToUTF16) (bs.flatMap charToUTF16) = .lt) := by
  have hx := digitChar_toNat (Nat.mod_lt x (by decide : 0 < 10))
  have hy := digitChar_toNat (Nat.mod_lt y (by decide : 0 < 10))
  rw [compare_utf16_cons_lt (by omega) (by omega), hx, hy]
  simp only [Nat.add_lt_add_iff_left, Nat.add_left_cancel_iff]

theorem compare_utf16_same_cons_lt (c : Char) (hc : c.toNat < 0x10000) (as bs : List Char) :
    compare ((c :: as).flatMap charToUTF16) ((c :: bs).flatMap charToUTF16) = .lt ↔
      compare (as.flatMap charToUTF16) (bs.flatMap charToUTF16) = .lt := by
  rw [compare_utf16_cons_lt hc hc]
  simp

/-- Two real dates written `YYYY-MM-DD` compare as JavaScript strings the way the dates compare
in the calendar. -/
theorem CalendarDate.jsStringLt_format_iff {a b : CalendarDate} (ha : a.Valid) (hb : b.Valid) :
    jsStringLt a.format b.format = true ↔ a.Before b := by
  have h1 := ha.year_le
  have h2 := hb.year_le
  have h3 := ha.month_le
  have h4 := hb.month_le
  have h5 := ha.day_le_31
  have h6 := hb.day_le_31
  unfold jsStringLt compareCanonicalText stringToUTF16 CalendarDate.format CalendarDate.chars
    CalendarDate.Before
  simp only [beq_iff_eq, String.toList_ofList, compare_utf16_digit_cons_lt,
    compare_utf16_same_cons_lt '-' (by decide), compare_utf16_nil_lt, and_false, or_false]
  have e1 : a.year = 1000 * (a.year / 1000 % 10) + 100 * (a.year / 100 % 10) +
      10 * (a.year / 10 % 10) + a.year % 10 := by omega
  have e2 : b.year = 1000 * (b.year / 1000 % 10) + 100 * (b.year / 100 % 10) +
      10 * (b.year / 10 % 10) + b.year % 10 := by omega
  have e3 : a.month = 10 * (a.month / 10 % 10) + a.month % 10 := by omega
  have e4 : b.month = 10 * (b.month / 10 % 10) + b.month % 10 := by omega
  have e5 : a.day = 10 * (a.day / 10 % 10) + a.day % 10 := by omega
  have e6 : b.day = 10 * (b.day / 10 % 10) + b.day % 10 := by omega
  have l1 : a.year / 100 % 10 < 10 := Nat.mod_lt _ (by decide)
  have l2 : a.year / 10 % 10 < 10 := Nat.mod_lt _ (by decide)
  have l3 : a.year % 10 < 10 := Nat.mod_lt _ (by decide)
  have l4 : a.month % 10 < 10 := Nat.mod_lt _ (by decide)
  have l5 : a.day % 10 < 10 := Nat.mod_lt _ (by decide)
  have l6 : b.year / 100 % 10 < 10 := Nat.mod_lt _ (by decide)
  have l7 : b.year / 10 % 10 < 10 := Nat.mod_lt _ (by decide)
  have l8 : b.year % 10 < 10 := Nat.mod_lt _ (by decide)
  have l9 : b.month % 10 < 10 := Nat.mod_lt _ (by decide)
  have l10 : b.day % 10 < 10 := Nat.mod_lt _ (by decide)
  generalize a.year / 1000 % 10 = a1 at *
  generalize a.year / 100 % 10 = a2 at *
  generalize a.year / 10 % 10 = a3 at *
  generalize a.year % 10 = a4 at *
  generalize a.month / 10 % 10 = a5 at *
  generalize a.month % 10 = a6 at *
  generalize a.day / 10 % 10 = a7 at *
  generalize a.day % 10 = a8 at *
  generalize b.year / 1000 % 10 = b1 at *
  generalize b.year / 100 % 10 = b2 at *
  generalize b.year / 10 % 10 = b3 at *
  generalize b.year % 10 = b4 at *
  generalize b.month / 10 % 10 = b5 at *
  generalize b.month % 10 = b6 at *
  generalize b.day / 10 % 10 = b7 at *
  generalize b.day % 10 = b8 at *
  rw [e1, e2, e3, e4, e5, e6]
  omega


namespace CalendarDate

/-- The number of days of a year of the Gregorian calendar. -/
def yearLength (year : Nat) : Nat := if IsLeapYear year then 366 else 365

/-- The days of all the years before `year`, from the year 0000. -/
def daysBeforeYear : Nat → Nat
  | 0 => 0
  | year + 1 => daysBeforeYear year + yearLength year

/-- The days of the months of `year` before `month` (January is month 1). -/
def daysBeforeMonth (year : Nat) : Nat → Nat
  | 0 => 0
  | month + 1 => if month = 0 then 0 else daysBeforeMonth year month + monthLength year month

/-- The number of days from 0000-01-01 to a date: 0000-01-01 is day 0. -/
def dayNumber (d : CalendarDate) : Nat :=
  daysBeforeYear d.year + daysBeforeMonth d.year d.month + (d.day - 1)

theorem daysBeforeMonth_succ (year : Nat) {month : Nat} (h : 1 ≤ month) :
    daysBeforeMonth year (month + 1) = daysBeforeMonth year month + monthLength year month := by
  rw [daysBeforeMonth]
  simp only [show ¬ month = 0 by omega, ↓reduceIte]

theorem daysBeforeMonth_mono (year : Nat) {month : Nat} (h : 1 ≤ month) (k : Nat) :
    daysBeforeMonth year month + monthLength year month ≤ daysBeforeMonth year (month + 1 + k) := by
  induction k with
  | zero => rw [Nat.add_zero, daysBeforeMonth_succ year h]
  | succ k ih =>
    rw [← Nat.add_assoc, daysBeforeMonth_succ year (by omega)]
    omega

theorem daysBeforeMonth_thirteen (year : Nat) : daysBeforeMonth year 13 = yearLength year := by
  unfold yearLength
  by_cases h : IsLeapYear year <;> simp [daysBeforeMonth, monthLength, h]

theorem daysBeforeYear_mono {a b : Nat} (h : a < b) :
    daysBeforeYear a + yearLength a ≤ daysBeforeYear b := by
  induction b with
  | zero => omega
  | succ b ih =>
    rw [daysBeforeYear]
    by_cases hab : a = b
    · subst hab; exact Nat.le_refl _
    · have := ih (by omega); omega

theorem Valid.dayOfYear_lt {d : CalendarDate} (h : d.Valid) :
    daysBeforeMonth d.year d.month + (d.day - 1) < yearLength d.year := by
  have h1 := h.day_pos
  have h2 := h.day_le
  have h3 := daysBeforeMonth_mono d.year h.month_pos (12 - d.month)
  have h4 : d.month + 1 + (12 - d.month) = 13 := by have := h.month_le; omega
  rw [h4, daysBeforeMonth_thirteen] at h3
  omega

theorem Valid.dayNumber_lt_of_before {a b : CalendarDate} (ha : a.Valid)
    (h : a.Before b) : a.dayNumber < b.dayNumber := by
  unfold dayNumber
  rcases h with hy | ⟨hy, hm | ⟨hm, hd⟩⟩
  · have := ha.dayOfYear_lt
    have := daysBeforeYear_mono hy
    omega
  · have h1 := ha.day_pos
    have h2 := ha.day_le
    have h3 := daysBeforeMonth_mono a.year ha.month_pos (b.month - a.month - 1)
    have h4 : a.month + 1 + (b.month - a.month - 1) = b.month := by omega
    rw [h4] at h3
    rw [← hy]
    omega
  · have := ha.day_pos
    rw [hy, hm]
    omega

/-- Of two real dates, the earlier in the calendar is the one with the smaller day number. -/
theorem Valid.before_iff_dayNumber_lt {a b : CalendarDate} (ha : a.Valid) (hb : b.Valid) :
    a.Before b ↔ a.dayNumber < b.dayNumber := by
  refine ⟨ha.dayNumber_lt_of_before, fun h => ?_⟩
  by_contra hn
  have cases : a = b ∨ b.Before a := by
    by_cases he : a.year = b.year ∧ a.month = b.month ∧ a.day = b.day
    · left
      obtain ⟨y, m, d⟩ := a
      obtain ⟨y', m', d'⟩ := b
      simp only at he
      obtain ⟨rfl, rfl, rfl⟩ := he
      rfl
    · right
      unfold Before at hn ⊢
      omega
  rcases cases with rfl | hba
  · omega
  · have := hb.dayNumber_lt_of_before hba
    omega

end CalendarDate


/-- The date a `LocalDate` names: its year, month and day as numbers. -/
def LocalDate.toCalendarDate (d : LocalDate) : CalendarDate :=
  (parseLocalDate d.value.toList).getD default

/-- A `LocalDate` names a real date of the calendar and is that date written `YYYY-MM-DD`. -/
theorem LocalDate.WF.toCalendarDate_spec {d : LocalDate} (h : d.WF) :
    d.toCalendarDate.Valid ∧ d.toCalendarDate.format = d.value := by
  obtain ⟨c, hc, hf⟩ := h
  have : d.toCalendarDate = c := by
    unfold LocalDate.toCalendarDate
    rw [hf, parseLocalDate_format hc]
    rfl
  rw [this]
  exact ⟨hc, hf.symm⟩

/-- A date that `localDate` accepts is a real date of the calendar: its month is 1 to 12 and its
day exists in that month of that year, leap years counted by the rule of the calendar. -/
theorem localDate_valid {value : String} {d : LocalDate} (h : localDate value = .ok d) :
    d.toCalendarDate.Valid ∧ d.toCalendarDate.format = value := by
  obtain ⟨hv, hwf⟩ := (localDate_ok_iff value d).mp h
  rw [← hv]
  exact hwf.toCalendarDate_spec

/-- `localDate` accepts every real date of the years 0000 to 9999 written `YYYY-MM-DD`. -/
theorem localDate_format {c : CalendarDate} (h : c.Valid) :
    localDate c.format = .ok ⟨c.format⟩ :=
  (localDate_ok_iff _ _).mpr ⟨rfl, c, h, rfl⟩

/-- JavaScript's `left <= right` on strings is the negation of `right < left`. -/
theorem jsStringLe_iff_not_lt (left right : String) :
    jsStringLe left right = true ↔ ¬ jsStringLt right left = true := by
  unfold jsStringLe jsStringLt
  have := compareCanonicalText_antisymm right left
  cases h1 : compareCanonicalText left right <;> cases h2 : compareCanonicalText right left <;>
    simp_all

/-- Two `LocalDate`s compare as JavaScript strings the way their dates compare in the calendar. -/
theorem LocalDate.WF.lt_iff_before {a b : LocalDate} (ha : a.WF) (hb : b.WF) :
    a < b ↔ a.toCalendarDate.Before b.toCalendarDate := by
  obtain ⟨va, fa⟩ := ha.toCalendarDate_spec
  obtain ⟨vb, fb⟩ := hb.toCalendarDate_spec
  rw [← CalendarDate.jsStringLt_format_iff va vb, fa, fb]
  rfl

/-- `a < b` on two `LocalDate`s, the comparison JavaScript makes on the two strings, holds exactly
when the date of `a` is an earlier day than the date of `b`. -/
theorem LocalDate.WF.lt_iff {a b : LocalDate} (ha : a.WF) (hb : b.WF) :
    a < b ↔ a.toCalendarDate.dayNumber < b.toCalendarDate.dayNumber := by
  rw [ha.lt_iff_before hb,
    ha.toCalendarDate_spec.1.before_iff_dayNumber_lt hb.toCalendarDate_spec.1]

/-- `a <= b` on two `LocalDate`s, the comparison JavaScript makes on the two strings, holds exactly
when the date of `a` is the same day as the date of `b` or an earlier one. -/
theorem LocalDate.WF.le_iff {a b : LocalDate} (ha : a.WF) (hb : b.WF) :
    a ≤ b ↔ a.toCalendarDate.dayNumber ≤ b.toCalendarDate.dayNumber := by
  have h : a ≤ b ↔ ¬ b < a := jsStringLe_iff_not_lt a.value b.value
  rw [h, hb.lt_iff ha]
  omega

/-- Two `LocalDate`s are the same string exactly when they are the same day. -/
theorem LocalDate.WF.eq_iff {a b : LocalDate} (ha : a.WF) (hb : b.WF) :
    a = b ↔ a.toCalendarDate.dayNumber = b.toCalendarDate.dayNumber := by
  constructor
  · rintro rfl; rfl
  · intro h
    have va := ha.toCalendarDate_spec
    have vb := hb.toCalendarDate_spec
    have h1 : ¬ a.toCalendarDate.Before b.toCalendarDate := by
      rw [va.1.before_iff_dayNumber_lt vb.1]; omega
    have h2 : ¬ b.toCalendarDate.Before a.toCalendarDate := by
      rw [vb.1.before_iff_dayNumber_lt va.1]; omega
    have h3 : a.toCalendarDate = b.toCalendarDate := by
      generalize a.toCalendarDate = x at *
      generalize b.toCalendarDate = y at *
      obtain ⟨y1, m1, d1⟩ := x
      obtain ⟨y2, m2, d2⟩ := y
      simp only [CalendarDate.Before] at h1 h2
      simp only [CalendarDate.mk.injEq]
      omega
    obtain ⟨sa⟩ := a
    obtain ⟨sb⟩ := b
    have := va.2
    have := vb.2
    simp_all

/-- The order of two dates that `localDate` accepted, taken as JavaScript strings, is their order
as days of the calendar. -/
theorem localDate_lt_iff {left right : String} {a b : LocalDate} (ha : localDate left = .ok a)
    (hb : localDate right = .ok b) :
    jsStringLt left right = true ↔ a.toCalendarDate.dayNumber < b.toCalendarDate.dayNumber := by
  obtain ⟨rfl, wa⟩ := (localDate_ok_iff _ _).mp ha
  obtain ⟨rfl, wb⟩ := (localDate_ok_iff _ _).mp hb
  exact wa.lt_iff wb

/-- The days of the years before a year, counted in one formula: 365 a year and one more for each
leap year. -/
theorem CalendarDate.daysBeforeYear_eq (year : Nat) :
    CalendarDate.daysBeforeYear year =
      365 * year + (year + 3) / 4 - (year + 99) / 100 + (year + 399) / 400 := by
  induction year with
  | zero => rfl
  | succ y ih =>
    rw [CalendarDate.daysBeforeYear, ih, CalendarDate.yearLength]
    by_cases h : CalendarDate.IsLeapYear y
    · simp only [h, ↓reduceIte]
      unfold CalendarDate.IsLeapYear at h
      simp only [Nat.dvd_iff_mod_eq_zero] at h
      omega
    · simp only [h, ↓reduceIte]
      unfold CalendarDate.IsLeapYear at h
      simp only [Nat.dvd_iff_mod_eq_zero] at h
      omega

/-- 1970-01-01, the day JavaScript counts time from, is day 719528. -/
theorem CalendarDate.dayNumber_epoch : (CalendarDate.mk 1970 1 1).dayNumber = 719528 := by
  simp [CalendarDate.dayNumber, CalendarDate.daysBeforeYear_eq, CalendarDate.daysBeforeMonth]


/-! ## Meaning of an instant -/

/-- The offset from UTC written at the end of an instant: `Z`, `+HH:MM` or `-HH:MM`. -/
inductive InstantOffset where
  | utc
  | plus (hours minutes : Nat)
  | minus (hours minutes : Nat)
  deriving DecidableEq, Repr, Inhabited

/-- The parts of an instant as numbers. `fraction` is the digits after the decimal point of the
seconds, empty when there is no point. -/
structure InstantFields where
  date : CalendarDate
  hour : Nat
  minute : Nat
  second : Nat
  fraction : List Nat
  offset : InstantOffset
  deriving DecidableEq, Repr, Inhabited

/-- A number below one hundred written with two digits. -/
def twoDigits (n : Nat) : List Char := [digitChar (n / 10 % 10), digitChar (n % 10)]

/-- The decimal point and the digits after it, or nothing when there are no digits. -/
def fractionChars (digits : List Nat) : List Char :=
  if digits = [] then [] else '.' :: digits.map digitChar

namespace InstantOffset

/-- An offset as it is written. -/
def chars : InstantOffset → List Char
  | utc => ['Z']
  | plus hours minutes => '+' :: twoDigits hours ++ ':' :: twoDigits minutes
  | minus hours minutes => '-' :: twoDigits hours ++ ':' :: twoDigits minutes

/-- An offset that two digits of hours and two of minutes can write. -/
def Bounded : InstantOffset → Prop
  | utc => True
  | plus hours minutes => hours ≤ 99 ∧ minutes ≤ 99
  | minus hours minutes => hours ≤ 99 ∧ minutes ≤ 99

/-- An offset `instant` accepts: at most fourteen hours either way, minutes below sixty. -/
def Valid : InstantOffset → Prop
  | utc => True
  | plus hours minutes => hours ≤ 14 ∧ minutes ≤ 59 ∧ (hours = 14 → minutes = 0)
  | minus hours minutes => hours ≤ 14 ∧ minutes ≤ 59 ∧ (hours = 14 → minutes = 0)

end InstantOffset

namespace InstantFields

/-- An instant as it is written: `YYYY-MM-DDTHH:MM:SS`, the fraction if any, the offset. -/
def chars (f : InstantFields) : List Char :=
  f.date.chars ++ 'T' :: twoDigits f.hour ++ ':' :: twoDigits f.minute ++ ':' ::
    twoDigits f.second ++ (fractionChars f.fraction ++ f.offset.chars)

/-- An instant as it is written, as a string. -/
def format (f : InstantFields) : String := String.ofList f.chars

/-- What the regular expression of `instant` alone demands: every part has its number of digits. -/
structure Bounded (f : InstantFields) : Prop where
  year_le : f.date.year ≤ 9999
  month_le : f.date.month ≤ 99
  day_le : f.date.day ≤ 99
  hour_le : f.hour ≤ 99
  minute_le : f.minute ≤ 99
  second_le : f.second ≤ 99
  fraction_lt : ∀ digit ∈ f.fraction, digit < 10
  offset_bounded : f.offset.Bounded

/-- An instant `instant` accepts: a real date, a time of day from 00:00:00 to 23:59:59 with any
number of fraction digits, and an offset of at most fourteen hours. -/
structure Valid (f : InstantFields) : Prop where
  date_valid : f.date.Valid
  hour_le : f.hour ≤ 23
  minute_le : f.minute ≤ 59
  second_le : f.second ≤ 59
  fraction_lt : ∀ digit ∈ f.fraction, digit < 10
  offset_valid : f.offset.Valid

end InstantFields

/-- The offset `matchOffset` found, as numbers. -/
def offsetOfMatch : Option (Char × List Char × List Char) → InstantOffset
  | none => .utc
  | some (sign, hourText, minuteText) =>
    if sign == '+' then .plus (digitsToNat hourText) (digitsToNat minuteText)
    else .minus (digitsToNat hourText) (digitsToNat minuteText)

theorem twoDigits_digitsToNat {a b : Char} (ha : isAsciiDigit a = true)
    (hb : isAsciiDigit b = true) :
    digitsToNat [a, b] ≤ 99 ∧ twoDigits (digitsToNat [a, b]) = [a, b] := by
  have b1 := digitValue_lt ha
  have b2 := digitValue_lt hb
  simp only [digitsToNat, List.foldl_cons, List.foldl_nil, twoDigits]
  refine ⟨by omega, ?_⟩
  rw [← eq_digitChar ha (by omega), ← eq_digitChar hb (by omega)]

theorem digitsToNat_twoDigits {n : Nat} (h : n ≤ 99) : digitsToNat (twoDigits n) = n := by
  simp only [twoDigits, digitsToNat, List.foldl_cons, List.foldl_nil, digitValue_digitChar_mod]
  omega

theorem matchOffset_sound {tail : List Char} {found : Option (Char × List Char × List Char)}
    (h : matchOffset tail = some found) :
    (offsetOfMatch found).Bounded ∧ tail = (offsetOfMatch found).chars := by
  unfold matchOffset at h
  split at h
  · rename_i z
    split at h
    · rename_i hz
      simp only [beq_iff_eq] at hz
      simp only [Option.some.injEq] at h
      subst h hz
      exact ⟨trivial, rfl⟩
    · exact absurd h (by simp)
  · rename_i sign h1 h2 colon m1 m2
    split at h
    · rename_i hc
      simp only [Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq] at hc
      obtain ⟨⟨⟨⟨⟨hs, d1⟩, d2⟩, rfl⟩, d3⟩, d4⟩ := hc
      simp only [Option.some.injEq] at h
      subst h
      obtain ⟨l1, e1⟩ := twoDigits_digitsToNat d1 d2
      obtain ⟨l2, e2⟩ := twoDigits_digitsToNat d3 d4
      rcases hs with rfl | rfl
      · simp only [offsetOfMatch, beq_self_eq_true, ↓reduceIte, InstantOffset.Bounded,
          InstantOffset.chars, e1, e2]
        exact ⟨⟨l1, l2⟩, rfl⟩
      · simp only [offsetOfMatch, show ('-' == '+') = false by decide, Bool.false_eq_true,
          ↓reduceIte, InstantOffset.Bounded, InstantOffset.chars, e1, e2]
        exact ⟨⟨l1, l2⟩, rfl⟩
    · exact absurd h (by simp)
  · exact absurd h (by simp)

theorem matchOffset_complete {offset : InstantOffset} (h : offset.Bounded) :
    ∃ found, matchOffset offset.chars = some found ∧ offsetOfMatch found = offset := by
  cases offset with
  | utc => exact ⟨none, by simp [matchOffset, InstantOffset.chars], rfl⟩
  | plus hours minutes =>
    refine ⟨some ('+', twoDigits hours, twoDigits minutes), ?_, ?_⟩
    · simp [matchOffset, InstantOffset.chars, twoDigits, isAsciiDigit_digitChar_mod]
    · simp [offsetOfMatch, digitsToNat_twoDigits h.1, digitsToNat_twoDigits h.2]
  | minus hours minutes =>
    refine ⟨some ('-', twoDigits hours, twoDigits minutes), ?_, ?_⟩
    · simp [matchOffset, InstantOffset.chars, twoDigits, isAsciiDigit_digitChar_mod]
    · simp [offsetOfMatch, digitsToNat_twoDigits h.1, digitsToNat_twoDigits h.2]

/-- An offset starts with `Z`, `+` or `-`: not a digit and not a point. -/
theorem InstantOffset.chars_head (offset : InstantOffset) :
    ∃ c rest, offset.chars = c :: rest ∧ isAsciiDigit c = false ∧ c ≠ '.' := by
  cases offset with
  | utc => exact ⟨'Z', [], rfl, by decide, by decide⟩
  | plus hours minutes => exact ⟨'+', _, rfl, by decide, by decide⟩
  | minus hours minutes => exact ⟨'-', _, rfl, by decide, by decide⟩


theorem map_digitChar_map_digitValue {digits : List Char}
    (h : ∀ c ∈ digits, isAsciiDigit c = true) : (digits.map digitValue).map digitChar = digits := by
  rw [List.map_map]
  conv_rhs => rw [← List.map_id digits]
  exact List.map_congr_left fun c hc => digitChar_digitValue (h c hc)

theorem map_digitValue_map_digitChar {digits : List Nat} (h : ∀ digit ∈ digits, digit < 10) :
    (digits.map digitChar).map digitValue = digits := by
  rw [List.map_map]
  conv_rhs => rw [← List.map_id digits]
  exact List.map_congr_left fun n hn => digitValue_digitChar (h n hn)

theorem mem_takeWhile_isAsciiDigit {l : List Char} {c : Char}
    (h : c ∈ l.takeWhile isAsciiDigit) : isAsciiDigit c = true := by
  induction l with
  | nil => simp at h
  | cons a l ih =>
    by_cases ha : isAsciiDigit a = true
    · rw [List.takeWhile_cons_of_pos ha] at h
      rcases List.mem_cons.mp h with rfl | h
      · exact ha
      · exact ih h
    · rw [List.takeWhile_cons_of_neg ha] at h
      simp at h

theorem matchFraction_sound {rest fraction tail : List Char}
    (h : matchFraction rest = some (fraction, tail)) :
    (∀ c ∈ fraction, isAsciiDigit c = true) ∧
      rest = fractionChars (fraction.map digitValue) ++ tail := by
  unfold matchFraction at h
  split at h
  · simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨by simp, by simp [fractionChars]⟩
  · rename_i c rest
    split at h
    · rename_i hc
      simp only [beq_iff_eq] at hc
      subst hc
      split at h
      · exact absurd h (by simp)
      · rename_i hne
        simp only [Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        have hd : ∀ c ∈ rest.takeWhile isAsciiDigit, isAsciiDigit c = true :=
          fun c hc => mem_takeWhile_isAsciiDigit hc
        refine ⟨hd, ?_⟩
        have hne' : List.map digitValue (rest.takeWhile isAsciiDigit) ≠ [] := by
          simpa using hne
        simp only [fractionChars, hne', ↓reduceIte, map_digitChar_map_digitValue hd,
          List.cons_append, List.takeWhile_append_dropWhile]
    · simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨by simp, by simp [fractionChars]⟩

theorem matchFraction_complete {digits : List Nat} (h : ∀ digit ∈ digits, digit < 10)
    {c : Char} {rest : List Char} (hc : isAsciiDigit c = false) (hp : c ≠ '.') :
    matchFraction (fractionChars digits ++ c :: rest) = some (digits.map digitChar, c :: rest) := by
  by_cases he : digits = []
  · subst he
    simp [fractionChars, matchFraction, hp]
  · have hd : ∀ x ∈ digits.map digitChar, isAsciiDigit x = true := by
      intro x hx
      obtain ⟨n, hn, rfl⟩ := List.mem_map.mp hx
      exact isAsciiDigit_digitChar (h n hn)
    have ht : (digits.map digitChar ++ c :: rest).takeWhile isAsciiDigit = digits.map digitChar := by
      rw [List.takeWhile_append_of_pos hd, List.takeWhile_cons_of_neg (by simp [hc]),
        List.append_nil]
    have hdw : (digits.map digitChar ++ c :: rest).dropWhile isAsciiDigit = c :: rest := by
      rw [List.dropWhile_append_of_pos hd, List.dropWhile_cons_of_neg (by simp [hc])]
    simp only [fractionChars, he, ↓reduceIte, List.cons_append, matchFraction, beq_self_eq_true,
      ht, hdw]
    simp [he]


/-- The parts `matchInstant` found, as numbers. -/
def InstantMatch.fields (m : InstantMatch) : InstantFields :=
  { date := (parseLocalDate m.date).getD default
    hour := digitsToNat m.hourText
    minute := digitsToNat m.minuteText
    second := digitsToNat m.secondText
    fraction := m.fraction.map digitValue
    offset := offsetOfMatch m.offset }

theorem matchInstant_sound {cs : List Char} {m : InstantMatch} (h : matchInstant cs = some m) :
    m.fields.Bounded ∧ cs = m.fields.chars ∧ m.date = m.fields.date.chars := by
  unfold matchInstant at h
  split at h
  · rename_i y1 y2 y3 y4 s1 m1 m2 s2 d1 d2 t h1 h2 c1 n1 n2 c2 e1 e2 rest
    split at h
    · rename_i hc
      simp only [Bool.and_eq_true, beq_iff_eq] at hc
      obtain ⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨g1, g2⟩, g3⟩, g4⟩, rfl⟩, g5⟩, g6⟩, rfl⟩, g7⟩, g8⟩, rfl⟩, g9⟩, g10⟩,
        rfl⟩, g11⟩, g12⟩, rfl⟩, g13⟩, g14⟩ := hc
      split at h
      · exact absurd h (by simp)
      · rename_i fraction tail hf
        split at h
        · exact absurd h (by simp)
        · rename_i offset ho
          simp only [Option.some.injEq] at h
          subst h
          have hp : parseLocalDate [y1, y2, y3, y4, '-', m1, m2, '-', d1, d2] =
              some ⟨digitsToNat [y1, y2, y3, y4], digitsToNat [m1, m2], digitsToNat [d1, d2]⟩ := by
            simp [parseLocalDate, matchLocalDate, g1, g2, g3, g4, g5, g6, g7, g8]
          obtain ⟨by1, by2, by3, hdc⟩ := (parseLocalDate_eq_some_iff _ _).mp hp
          obtain ⟨hfd, hfr⟩ := matchFraction_sound hf
          obtain ⟨hob, hot⟩ := matchOffset_sound ho
          obtain ⟨l1, t1⟩ := twoDigits_digitsToNat g9 g10
          obtain ⟨l2, t2⟩ := twoDigits_digitsToNat g11 g12
          obtain ⟨l3, t3⟩ := twoDigits_digitsToNat g13 g14
          simp only [InstantMatch.fields, hp, Option.getD_some]
          refine ⟨⟨by1, by2, by3, l1, l2, l3, ?_, hob⟩, ?_, hdc⟩
          · intro digit hd
            obtain ⟨c, hc, rfl⟩ := List.mem_map.mp hd
            exact digitValue_lt (hfd c hc)
          · simp only [InstantFields.chars, ← hdc, t1, t2, t3, ← hot, ← hfr]
            rfl
    · exact absurd h (by simp)
  · exact absurd h (by simp)

theorem matchInstant_complete {f : InstantFields} (h : f.Bounded) :
    ∃ m, matchInstant f.chars = some m ∧ m.fields = f ∧ m.date = f.date.chars := by
  obtain ⟨c, rest, hch, hnd, hnp⟩ := f.offset.chars_head
  have hf := matchFraction_complete h.fraction_lt hnd hnp (rest := rest)
  rw [← hch] at hf
  obtain ⟨found, ho, hoe⟩ := matchOffset_complete h.offset_bounded
  obtain ⟨⟨year, month, day⟩, hour, minute, second, fraction, offset⟩ := f
  have b1 := h.year_le
  have b2 := h.month_le
  have b3 := h.day_le
  simp only at b1 b2 b3 hf ho hoe
  have hp := (parseLocalDate_eq_some_iff (CalendarDate.chars ⟨year, month, day⟩)
    ⟨year, month, day⟩).mpr ⟨b1, b2, b3, rfl⟩
  simp only [CalendarDate.chars] at hp
  simp only [InstantFields.chars, CalendarDate.chars, twoDigits, List.cons_append,
    List.nil_append, matchInstant, isAsciiDigit_digitChar_mod, beq_self_eq_true, Bool.and_self,
    ↓reduceIte, hf, ho]
  refine ⟨_, rfl, ?_, rfl⟩
  simp only [InstantMatch.fields, hp, Option.getD_some, hoe,
    map_digitValue_map_digitChar h.fraction_lt, InstantFields.mk.injEq, true_and, and_true]
  have := digitsToNat_twoDigits h.hour_le
  have := digitsToNat_twoDigits h.minute_le
  have := digitsToNat_twoDigits h.second_le
  simp_all [twoDigits]


/-! ## Laws of `instant` -/

/-- What every `Instant` that `instant` returns satisfies: a real date, a time of day and an
offset, written `YYYY-MM-DDTHH:MM:SS`, an optional fraction, then `Z` or `+HH:MM` or `-HH:MM`. -/
def Instant.WF (i : Instant) : Prop := ∃ f : InstantFields, f.Valid ∧ i.value = f.format

theorem InstantOffset.Valid.bounded {offset : InstantOffset} (h : offset.Valid) :
    offset.Bounded := by
  cases offset with
  | utc => trivial
  | plus hours minutes => exact ⟨by have := h.1; omega, by have := h.2.1; omega⟩
  | minus hours minutes => exact ⟨by have := h.1; omega, by have := h.2.1; omega⟩

theorem InstantFields.Valid.bounded {f : InstantFields} (h : f.Valid) : f.Bounded :=
  ⟨h.date_valid.year_le, h.date_valid.month_le_99, by have := h.date_valid.day_le_31; omega,
    by have := h.hour_le; omega, by have := h.minute_le; omega, by have := h.second_le; omega,
    h.fraction_lt, h.offset_valid.bounded⟩

theorem localDate_chars_isOk_iff {c : CalendarDate} (hy : c.year ≤ 9999) (hm : c.month ≤ 99)
    (hd : c.day ≤ 99) : (∃ d, localDate (String.ofList c.chars) = .ok d) ↔ c.Valid := by
  constructor
  · rintro ⟨d, h⟩
    obtain ⟨-, c', hv, hf⟩ := (localDate_ok_iff _ _).mp h
    have h1 := parseLocalDate_format hv
    have h2 : parseLocalDate (String.ofList c.chars).toList = some c :=
      (parseLocalDate_eq_some_iff _ _).mpr ⟨hy, hm, hd, String.toList_ofList⟩
    have h3 : d.value = String.ofList c.chars := ((localDate_ok_iff _ _).mp h).1
    rw [← hf, h3, h2] at h1
    rw [Option.some.inj h1]
    exact hv
  · intro hv
    exact ⟨_, localDate_format hv⟩

theorem offsetOfMatch_valid_iff (sign : Char) (hourText minuteText : List Char) :
    (offsetOfMatch (some (sign, hourText, minuteText))).Valid ↔
      ¬ (digitsToNat hourText > 14 || digitsToNat minuteText > 59 ||
        (digitsToNat hourText == 14 && digitsToNat minuteText != 0)) = true := by
  unfold offsetOfMatch
  by_cases hs : (sign == '+') = true
  · simp only [hs, ↓reduceIte, InstantOffset.Valid, Bool.or_eq_true, decide_eq_true_eq,
      Bool.and_eq_true, beq_iff_eq, bne_iff_ne, ne_eq]
    omega
  · simp only [hs, Bool.false_eq_true, ↓reduceIte, InstantOffset.Valid, Bool.or_eq_true,
      decide_eq_true_eq, Bool.and_eq_true, beq_iff_eq, bne_iff_ne, ne_eq]
    omega

/-- `instant` accepts a text exactly when it is a real date, `T`, a time of day from 00:00:00 to
23:59:59, an optional point with one or more digits, and `Z` or an offset of at most fourteen
hours, each part with its fixed number of digits; and it returns that text unchanged. -/
theorem instant_ok_iff (value : String) (i : Instant) :
    instant value = .ok i ↔ i.value = value ∧ i.WF := by
  unfold instant Instant.WF
  cases hm : matchInstant value.toList with
  | none =>
    simp only [reduceCtorEq, false_iff, not_and, not_exists]
    rintro rfl f hf hv
    obtain ⟨m, hm', -, -⟩ := matchInstant_complete hf.bounded
    rw [hv, InstantFields.format, String.toList_ofList, hm'] at hm
    exact absurd hm (by simp)
  | some m =>
    obtain ⟨hb, hcs, hdate⟩ := matchInstant_sound hm
    have hformat : value = m.fields.format := by
      rw [InstantFields.format, ← hcs, String.ofList_toList]
    have unique : ∀ f : InstantFields, f.Valid → value = f.format → f = m.fields := by
      intro f hf hv
      obtain ⟨m', hm', hfields, -⟩ := matchInstant_complete hf.bounded
      rw [hv, InstantFields.format, String.toList_ofList, hm'] at hm
      rw [← hfields, Option.some.inj hm]
    have key : (i.value = value ∧ ∃ f : InstantFields, f.Valid ∧ i.value = f.format) ↔
        (i = ⟨value⟩ ∧ m.fields.Valid) := by
      constructor
      · rintro ⟨rfl, f, hf, hv⟩
        exact ⟨rfl, unique f hf hv ▸ hf⟩
      · rintro ⟨rfl, hv⟩
        exact ⟨rfl, _, hv, hformat⟩
    rw [key]
    simp only []
    rw [hdate]
    have hdv := localDate_chars_isOk_iff hb.year_le hb.month_le hb.day_le
    cases hl : localDate (String.ofList m.fields.date.chars) with
    | error err =>
      simp only [reduceCtorEq, false_iff, not_and]
      intro _ hv
      obtain ⟨d, hd⟩ := hdv.mpr hv.date_valid
      rw [hl] at hd
      exact absurd hd (by simp)
    | ok d =>
      have hdate_valid : m.fields.date.Valid := hdv.mp ⟨d, hl⟩
      simp only []
      by_cases htime : (digitsToNat m.hourText > 23 || digitsToNat m.minuteText > 59 ||
          digitsToNat m.secondText > 59) = true
      · simp only [htime, ↓reduceIte, reduceCtorEq, false_iff, not_and]
        intro _ hv
        have h1 : digitsToNat m.hourText ≤ 23 := hv.hour_le
        have h2 : digitsToNat m.minuteText ≤ 59 := hv.minute_le
        have h3 : digitsToNat m.secondText ≤ 59 := hv.second_le
        simp only [Bool.or_eq_true, decide_eq_true_eq] at htime
        omega
      · simp only [htime, Bool.false_eq_true, ↓reduceIte]
        simp only [Bool.or_eq_true, decide_eq_true_eq, not_or, Nat.not_lt] at htime
        obtain ⟨⟨t1, t2⟩, t3⟩ := htime
        have valid_iff : m.fields.Valid ↔ (offsetOfMatch m.offset).Valid :=
          ⟨fun hv => hv.offset_valid,
            fun ho => ⟨hdate_valid, t1, t2, t3, hb.fraction_lt, ho⟩⟩
        rw [valid_iff]
        cases hoff : m.offset with
        | none =>
          simp only [Except.ok.injEq]
          exact ⟨fun h => ⟨h.symm, trivial⟩, fun h => h.1.symm⟩
        | some found =>
          obtain ⟨sign, hourText, minuteText⟩ := found
          simp only []
          rw [offsetOfMatch_valid_iff]
          by_cases hoffset : (digitsToNat hourText > 14 || digitsToNat minuteText > 59 ||
              (digitsToNat hourText == 14 && digitsToNat minuteText != 0)) = true
          · simp [hoffset]
          · simp only [hoffset, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, not_false_eq_true,
              and_true]
            exact ⟨fun h => h.symm, fun h => h.symm⟩


/-- The parts of an `Instant`, as numbers. -/
def Instant.toFields (i : Instant) : InstantFields :=
  ((matchInstant i.value.toList).map InstantMatch.fields).getD default

/-- An `Instant` has a real date, a real time of day and an offset of at most fourteen hours, and
is those parts written out. -/
theorem Instant.WF.toFields_spec {i : Instant} (h : i.WF) :
    i.toFields.Valid ∧ i.toFields.format = i.value := by
  obtain ⟨f, hf, hv⟩ := h
  obtain ⟨m, hm, hfields, -⟩ := matchInstant_complete hf.bounded
  have : i.toFields = f := by
    unfold Instant.toFields
    rw [hv, InstantFields.format, String.toList_ofList, hm]
    exact hfields
  rw [this]
  exact ⟨hf, hv.symm⟩

/-- What `instant` accepts has a real date, a real time of day and an offset of at most fourteen
hours. -/
theorem instant_valid {value : String} {i : Instant} (h : instant value = .ok i) :
    i.toFields.Valid ∧ i.toFields.format = value := by
  obtain ⟨hv, hwf⟩ := (instant_ok_iff value i).mp h
  rw [← hv]
  exact hwf.toFields_spec

/-- `instant` accepts every valid instant written out. -/
theorem instant_format {f : InstantFields} (h : f.Valid) : instant f.format = .ok ⟨f.format⟩ :=
  (instant_ok_iff _ _).mpr ⟨rfl, f, h, rfl⟩

/-- `localDate` fails with one error only: `Invalid local date:` and the text it was given. -/
theorem localDate_error {value : String} {err : TemporalErr} (h : localDate value = .error err) :
    err = .invalidLocalDate value := by
  unfold localDate at h
  split at h
  · exact (Except.error.inj h).symm
  · simp only [] at h
    split at h
    · exact (Except.error.inj h).symm
    · split at h
      · exact (Except.error.inj h).symm
      · exact absurd h (by simp)

theorem matchInstant_date {cs : List Char} {m : InstantMatch} (h : matchInstant cs = some m) :
    m.date = cs.take 10 := by
  unfold matchInstant at h
  split at h
  · split at h
    · split at h
      · exact absurd h (by simp)
      · split at h
        · exact absurd h (by simp)
        · simp only [Option.some.injEq] at h
          subst h
          rfl
    · exact absurd h (by simp)
  · exact absurd h (by simp)

/-- `instant` fails with `Invalid supplied instant:` and the whole text, except when the text has
the shape of an instant and its date is not a real date: then the error is `localDate`'s,
`Invalid local date:` and the first ten characters. -/
theorem instant_error {value : String} {err : TemporalErr} (h : instant value = .error err) :
    err = .invalidSuppliedInstant value ∨
      err = .invalidLocalDate (String.ofList (value.toList.take 10)) := by
  unfold instant at h
  split at h
  · exact .inl (Except.error.inj h).symm
  · rename_i m hm
    rw [matchInstant_date hm] at h
    split at h
    · rename_i e he
      rw [← Except.error.inj h]
      exact .inr (localDate_error he)
    · simp only [] at h
      split at h
      · exact .inl (Except.error.inj h).symm
      · split at h
        · exact absurd h (by simp)
        · split at h
          · exact .inl (Except.error.inj h).symm
          · exact absurd h (by simp)


/-! ## Laws of the identifier makers

Each maker is `identifier` with its kind, so it accepts exactly what `identifier` accepts: a text
that is not empty, has no white space at either end, is in Unicode normal form C and has no control
character (`Identifier.WF`); and it returns that text unchanged. -/

/-- `bookId` accepts exactly the well-formed identifier texts and returns the text unchanged. -/
theorem bookId_ok_iff (value : String) (id : BookId) :
    bookId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `accountId` accepts exactly the well-formed identifier texts and returns the text unchanged. -/
theorem accountId_ok_iff (value : String) (id : AccountId) :
    accountId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `commodityId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem commodityId_ok_iff (value : String) (id : CommodityId) :
    commodityId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `dimensionId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem dimensionId_ok_iff (value : String) (id : DimensionId) :
    dimensionId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `dimensionMemberId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem dimensionMemberId_ok_iff (value : String) (id : DimensionMemberId) :
    dimensionMemberId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `journalId` accepts exactly the well-formed identifier texts and returns the text unchanged. -/
theorem journalId_ok_iff (value : String) (id : JournalId) :
    journalId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `postingId` accepts exactly the well-formed identifier texts and returns the text unchanged. -/
theorem postingId_ok_iff (value : String) (id : PostingId) :
    postingId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-- `diagnostic` returns the four values it was given. -/
theorem diagnostic_eq (code : SemanticDiagnosticCode) (path message : String)
    (requirementIds : List String) :
    diagnostic code path message requirementIds = ⟨code, path, message, requirementIds⟩ :=
  rfl


/-! ## What the two validators accept or refuse that a reader might not expect -/

/-- `localDate` accepts the year 0000, and counts it a leap year. -/
theorem localDate_accepts_year_zero : localDate "0000-02-29" = .ok ⟨"0000-02-29"⟩ := by decide

/-- `instant` accepts an offset of fourteen hours west of UTC, which no place on Earth keeps. -/
theorem instant_accepts_minus_fourteen :
    instant "2024-01-01T00:00:00-14:00" = .ok ⟨"2024-01-01T00:00:00-14:00"⟩ := by decide

/-- `instant` refuses a leap second. -/
theorem instant_rejects_leap_second :
    instant "2016-12-31T23:59:60Z" = .error (.invalidSuppliedInstant "2016-12-31T23:59:60Z") := by
  decide

/-- For a date that does not exist, `instant` fails with the error of `localDate` and only the
date part of the text. -/
theorem instant_unreal_date_error :
    instant "2023-02-29T00:00:00Z" = .error (.invalidLocalDate "2023-02-29") := by decide

end Rastrata.Kernel

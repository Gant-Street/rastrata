/-
Valuation: the Lean model of `packages/kernel/src/valuation.ts` (`PriceObservationId`,
`priceObservationId`, `MarketPriceObservation`, `MarketValue`, `valueWithObservation`).

Three layers, as everywhere in this project:

1. Model: `valueWithObservation` does what the TypeScript does, with the same checks in the same
   order. Each of its two `RangeError`s has its own error constructor; an `ExactNumberError` of
   `multiply` or `divide` escapes with its code.
2. Meaning: `ExactRational.toRat` for the amounts, and for the times `Instant.exactMillis`, the
   moment an instant names as an exact number of milliseconds, fraction of a second included.
3. Laws: what a returned value is, when the call is refused and for which reason, the round trip
   through the inverse rate, and what the comparison of the two times means in time.

What is assumed about JavaScript:

- `Date.parse` on a text that `instant` accepts is `dateParse` of `Policy/Types.lean`, with the
  assumption about the engines that is stated there. `valuation.ts` calls `Date.parse` directly
  and does not test the result, so on a text that is not an instant the comparison would be made
  with `NaN` or with whatever the engine reads; the model answers `false` there
  (`dateParseAfter`), which is what `NaN > x` and `x > NaN` answer. An `Instant` is never such a
  text, and no law below is about one.
- `===` on two identifiers is equality of the two strings.

`Object.freeze` is not modelled.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.NumericLimits
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Policy.Types

namespace Rastrata.Kernel

/-! ## Types (`valuation.ts` lines 6 to 27) -/

/-- `PriceObservationId`. -/
abbrev PriceObservationId := Identifier "MarketPriceObservation"

/-- `priceObservationId`. -/
def priceObservationId (value : String) : Except CanonicalErr PriceObservationId :=
  identifier "MarketPriceObservation" value

/-- The type of `MarketPriceObservation.kind`, unnamed in the TypeScript. -/
inductive PriceObservationKind where
  | marketQuote
  | officialRate
  | appraisedValue
  deriving DecidableEq, Repr, Inhabited

/-- `MarketPriceObservation`. -/
structure MarketPriceObservation where
  id : PriceObservationId
  effectiveAt : Instant
  observedAt : Instant
  kind : PriceObservationKind
  rate : ExactRational
  baseCommodityId : CommodityId
  quoteCommodityId : CommodityId
  evidenceId : EvidenceId
  deriving DecidableEq, Repr, Inhabited

/-- `MarketValue`. -/
structure MarketValue where
  exactAmount : ExactRational
  reportingCommodityId : CommodityId
  sourceObservationId : PriceObservationId
  usesInverse : Bool
  effectiveAt : Instant
  deriving DecidableEq, Repr, Inhabited

/-! ## `valueWithObservation` (`valuation.ts` line 29): the model -/

/-- What `valueWithObservation` throws: its two `RangeError`s, told apart by their message
(`A valuation cannot use an observation from after its effective time` and `Observation does not
connect the source commodity under the supplied policy`), or the `ExactNumberError` of `multiply`
or `divide`. -/
inductive ValuationErr where
  | observationAfterEffectiveTime
  | observationDoesNotConnect
  | exactNumber (code : NumErr)
  deriving DecidableEq, Repr, Inhabited

/-- `Date.parse(left) > Date.parse(right)` (`valuation.ts` line 35). `false` when either text is
not an instant: see the head of this file. -/
def dateParseAfter (left right : Instant) : Bool :=
  match dateParse left.value, dateParse right.value with
  | some leftMillis, some rightMillis => decide (leftMillis > rightMillis)
  | _, _ => false

/-- `valueWithObservation` (`valuation.ts` line 29). -/
def valueWithObservation (quantity : Quantity) (observation : MarketPriceObservation)
    (effectiveAt : Instant) (allowInverse : Bool) : Except ValuationErr MarketValue :=
  if dateParseAfter observation.effectiveAt effectiveAt then .error .observationAfterEffectiveTime
  else if quantity.commodityId = observation.baseCommodityId then
    match quantity.canonicalNumber.multiply observation.rate with
    | .error code => .error (.exactNumber code)
    | .ok exactAmount =>
      .ok
        { exactAmount
          reportingCommodityId := observation.quoteCommodityId
          sourceObservationId := observation.id
          usesInverse := false
          effectiveAt }
  else if allowInverse ∧ quantity.commodityId = observation.quoteCommodityId then
    match quantity.canonicalNumber.divide observation.rate with
    | .error code => .error (.exactNumber code)
    | .ok exactAmount =>
      .ok
        { exactAmount
          reportingCommodityId := observation.baseCommodityId
          sourceObservationId := observation.id
          usesInverse := true
          effectiveAt }
  else .error .observationDoesNotConnect

/-! ## What `valueWithObservation` returns -/

/-- `valueWithObservation` returns a value exactly when the observation is not from after the
effective time and either the quantity is in the base commodity and the multiplication returned,
or the inverse is allowed, the quantity is in the quote commodity and not in the base commodity,
and the division returned; and the value is then that result with the other commodity. -/
theorem valueWithObservation_ok_iff (quantity : Quantity) (observation : MarketPriceObservation)
    (effectiveAt : Instant) (allowInverse : Bool) (value : MarketValue) :
    valueWithObservation quantity observation effectiveAt allowInverse = .ok value ↔
      dateParseAfter observation.effectiveAt effectiveAt = false ∧
      ((quantity.commodityId = observation.baseCommodityId ∧
          quantity.canonicalNumber.multiply observation.rate = .ok value.exactAmount ∧
          value.reportingCommodityId = observation.quoteCommodityId ∧
          value.usesInverse = false ∧ value.sourceObservationId = observation.id ∧
          value.effectiveAt = effectiveAt) ∨
        (quantity.commodityId ≠ observation.baseCommodityId ∧ allowInverse = true ∧
          quantity.commodityId = observation.quoteCommodityId ∧
          quantity.canonicalNumber.divide observation.rate = .ok value.exactAmount ∧
          value.reportingCommodityId = observation.baseCommodityId ∧
          value.usesInverse = true ∧ value.sourceObservationId = observation.id ∧
          value.effectiveAt = effectiveAt)) := by
  obtain ⟨amount, reporting, source, inverse, at_⟩ := value
  unfold valueWithObservation
  by_cases hafter : dateParseAfter observation.effectiveAt effectiveAt = true
  · simp [hafter]
  · simp only [hafter, Bool.false_eq_true, ↓reduceIte, true_and]
    by_cases hbase : quantity.commodityId = observation.baseCommodityId
    · simp only [hbase, ↓reduceIte, true_and, ne_eq, not_true_eq_false, false_and, or_false]
      cases quantity.canonicalNumber.multiply observation.rate with
      | error code => simp
      | ok product =>
        simp only [Except.ok.injEq, MarketValue.mk.injEq]
        constructor
        · rintro ⟨rfl, rfl, rfl, rfl, rfl⟩; exact ⟨rfl, rfl, rfl, rfl, rfl⟩
        · rintro ⟨rfl, rfl, rfl, rfl, rfl⟩; exact ⟨rfl, rfl, rfl, rfl, rfl⟩
    · simp only [hbase, ↓reduceIte, false_and, ne_eq, not_false_eq_true, true_and, false_or]
      by_cases hinverse : allowInverse = true ∧ quantity.commodityId = observation.quoteCommodityId
      · simp only [hinverse, and_self, ↓reduceIte, true_and]
        cases quantity.canonicalNumber.divide observation.rate with
        | error code => simp
        | ok quotient =>
          simp only [Except.ok.injEq, MarketValue.mk.injEq]
          constructor
          · rintro ⟨rfl, rfl, rfl, rfl, rfl⟩; exact ⟨rfl, rfl, rfl, rfl, rfl⟩
          · rintro ⟨rfl, rfl, rfl, rfl, rfl⟩; exact ⟨rfl, rfl, rfl, rfl, rfl⟩
      · simp only [hinverse, ↓reduceIte, reduceCtorEq, false_iff]
        rintro ⟨h1, h2, -⟩
        exact hinverse ⟨h1, h2⟩

/-- A value computed with the direct rate is the quantity times the rate, in the quote commodity
of the observation, citing the observation, at the effective time asked for; and the quantity
was in the base commodity. -/
theorem valueWithObservation_direct {quantity : Quantity} {observation : MarketPriceObservation}
    {effectiveAt : Instant} {allowInverse : Bool} {value : MarketValue}
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value)
    (hdirect : value.usesInverse = false) :
    value.exactAmount.WF ∧
      value.exactAmount.toRat = quantity.canonicalNumber.toRat * observation.rate.toRat ∧
      quantity.commodityId = observation.baseCommodityId ∧
      value.reportingCommodityId = observation.quoteCommodityId ∧
      value.sourceObservationId = observation.id ∧ value.effectiveAt = effectiveAt := by
  rcases ((valueWithObservation_ok_iff _ _ _ _ _).mp h).2 with
    ⟨hbase, hmul, hrep, -, hsrc, hat⟩ | ⟨-, -, -, -, -, hinv, -, -⟩
  · obtain ⟨hwf, hrat⟩ := ExactRational.multiply_ok hq hr hmul
    exact ⟨hwf, hrat, hbase, hrep, hsrc, hat⟩
  · rw [hdirect] at hinv
    exact absurd hinv (by simp)

/-- A value computed with the inverse rate is the quantity divided by the rate, which is not zero,
in the base commodity of the observation, citing the observation, at the effective time asked
for; the inverse was allowed, and the quantity was in the quote commodity and not in the base
commodity. -/
theorem valueWithObservation_inverse {quantity : Quantity} {observation : MarketPriceObservation}
    {effectiveAt : Instant} {allowInverse : Bool} {value : MarketValue}
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value)
    (hinverse : value.usesInverse = true) :
    value.exactAmount.WF ∧ observation.rate.toRat ≠ 0 ∧
      value.exactAmount.toRat = quantity.canonicalNumber.toRat / observation.rate.toRat ∧
      allowInverse = true ∧ quantity.commodityId = observation.quoteCommodityId ∧
      quantity.commodityId ≠ observation.baseCommodityId ∧
      value.reportingCommodityId = observation.baseCommodityId ∧
      value.sourceObservationId = observation.id ∧ value.effectiveAt = effectiveAt := by
  rcases ((valueWithObservation_ok_iff _ _ _ _ _).mp h).2 with
    ⟨-, -, -, hdir, -, -⟩ | ⟨hbase, hallow, hquote, hdiv, hrep, -, hsrc, hat⟩
  · rw [hinverse] at hdir
    exact absurd hdir (by simp)
  · obtain ⟨hwf, hne, hrat⟩ := ExactRational.divide_ok hq hr hdiv
    exact ⟨hwf, hne, hrat, hallow, hquote, hbase, hrep, hsrc, hat⟩

/-- A returned value used the inverse rate exactly when the quantity was not in the base
commodity of the observation: the direct rate is preferred whenever it applies. -/
theorem valueWithObservation_usesInverse_iff {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt : Instant} {allowInverse : Bool}
    {value : MarketValue}
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value) :
    value.usesInverse = true ↔ quantity.commodityId ≠ observation.baseCommodityId := by
  rcases ((valueWithObservation_ok_iff _ _ _ _ _).mp h).2 with
    ⟨hbase, -, -, hdir, -, -⟩ | ⟨hbase, -, -, -, -, hinv, -, -⟩
  · simp [hbase, hdir]
  · simp [hbase, hinv]

/-- The amount of a returned value means the quantity times the rate, or the quantity divided by
the rate when the inverse was used, and it is a constructible exact number. -/
theorem valueWithObservation_amount {quantity : Quantity} {observation : MarketPriceObservation}
    {effectiveAt : Instant} {allowInverse : Bool} {value : MarketValue}
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value) :
    value.exactAmount.WF ∧
      value.exactAmount.toRat =
        if value.usesInverse then quantity.canonicalNumber.toRat / observation.rate.toRat
        else quantity.canonicalNumber.toRat * observation.rate.toRat := by
  cases hu : value.usesInverse with
  | false =>
    obtain ⟨hwf, hrat, -⟩ := valueWithObservation_direct hq hr h hu
    exact ⟨hwf, by simpa using hrat⟩
  | true =>
    obtain ⟨hwf, -, hrat, -⟩ := valueWithObservation_inverse hq hr h hu
    exact ⟨hwf, by simpa using hrat⟩

/-! ## When `valueWithObservation` refuses, and for which reason -/

/-- The valuation is refused for the time exactly when `Date.parse` reads the observation's
effective time as later than the effective time asked for; no other check comes before it. -/
theorem valueWithObservation_error_after_iff (quantity : Quantity)
    (observation : MarketPriceObservation) (effectiveAt : Instant) (allowInverse : Bool) :
    valueWithObservation quantity observation effectiveAt allowInverse =
        .error .observationAfterEffectiveTime ↔
      dateParseAfter observation.effectiveAt effectiveAt = true := by
  unfold valueWithObservation
  by_cases hafter : dateParseAfter observation.effectiveAt effectiveAt = true
  · simp [hafter]
  · simp only [hafter, Bool.false_eq_true, ↓reduceIte, iff_false]
    split_ifs
    · cases quantity.canonicalNumber.multiply observation.rate <;> simp
    · cases quantity.canonicalNumber.divide observation.rate <;> simp
    · simp

/-- The valuation is refused because the observation does not connect the commodity exactly when
the time is admitted, the quantity is not in the base commodity, and the inverse is not allowed
or the quantity is not in the quote commodity either. -/
theorem valueWithObservation_error_connect_iff (quantity : Quantity)
    (observation : MarketPriceObservation) (effectiveAt : Instant) (allowInverse : Bool) :
    valueWithObservation quantity observation effectiveAt allowInverse =
        .error .observationDoesNotConnect ↔
      dateParseAfter observation.effectiveAt effectiveAt = false ∧
        quantity.commodityId ≠ observation.baseCommodityId ∧
        ¬ (allowInverse = true ∧ quantity.commodityId = observation.quoteCommodityId) := by
  unfold valueWithObservation
  by_cases hafter : dateParseAfter observation.effectiveAt effectiveAt = true
  · simp [hafter]
  · simp only [hafter, Bool.false_eq_true, ↓reduceIte, true_and]
    by_cases hbase : quantity.commodityId = observation.baseCommodityId
    · simp only [hbase, ↓reduceIte, ne_eq, not_true_eq_false, false_and, iff_false]
      cases quantity.canonicalNumber.multiply observation.rate <;> simp
    · simp only [hbase, ↓reduceIte, ne_eq, not_false_eq_true, true_and]
      by_cases hinverse : allowInverse = true ∧ quantity.commodityId = observation.quoteCommodityId
      · simp only [hinverse, and_self, ↓reduceIte, not_true_eq_false, iff_false]
        cases quantity.canonicalNumber.divide observation.rate <;> simp
      · simp [hinverse]

/-- The valuation fails with an error of the exact numbers exactly when the time is admitted and
the multiplication by the rate, or the division by it when the inverse is the one used, failed
with that error. -/
theorem valueWithObservation_error_exactNumber_iff (quantity : Quantity)
    (observation : MarketPriceObservation) (effectiveAt : Instant) (allowInverse : Bool)
    (code : NumErr) :
    valueWithObservation quantity observation effectiveAt allowInverse =
        .error (.exactNumber code) ↔
      dateParseAfter observation.effectiveAt effectiveAt = false ∧
        ((quantity.commodityId = observation.baseCommodityId ∧
            quantity.canonicalNumber.multiply observation.rate = .error code) ∨
          (quantity.commodityId ≠ observation.baseCommodityId ∧ allowInverse = true ∧
            quantity.commodityId = observation.quoteCommodityId ∧
            quantity.canonicalNumber.divide observation.rate = .error code)) := by
  unfold valueWithObservation
  by_cases hafter : dateParseAfter observation.effectiveAt effectiveAt = true
  · simp [hafter]
  · simp only [hafter, Bool.false_eq_true, ↓reduceIte, true_and]
    by_cases hbase : quantity.commodityId = observation.baseCommodityId
    · simp only [hbase, ↓reduceIte, true_and, ne_eq, not_true_eq_false, false_and, or_false]
      cases quantity.canonicalNumber.multiply observation.rate <;> simp
    · simp only [hbase, ↓reduceIte, false_and, ne_eq, not_false_eq_true, true_and, false_or]
      by_cases hinverse : allowInverse = true ∧ quantity.commodityId = observation.quoteCommodityId
      · simp only [hinverse, and_self, ↓reduceIte, true_and]
        cases quantity.canonicalNumber.divide observation.rate <;> simp
      · simp only [hinverse, ↓reduceIte]
        constructor
        · intro h
          simp at h
        · rintro ⟨h1, h2, -⟩
          exact absurd ⟨h1, h2⟩ hinverse

/-- Completeness: for a constructible quantity and rate, a value is returned exactly when the time
is admitted and either the quantity is in the base commodity and the product fits the size limit,
or the inverse is allowed, the quantity is in the quote commodity and not the base commodity, the
rate is not zero and the quotient fits the size limit (each limit taken on the parts before they
are reduced). -/
theorem valueWithObservation_isOk_iff {quantity : Quantity} {observation : MarketPriceObservation}
    (effectiveAt : Instant) (allowInverse : Bool)
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF) :
    (∃ value, valueWithObservation quantity observation effectiveAt allowInverse = .ok value) ↔
      dateParseAfter observation.effectiveAt effectiveAt = false ∧
        ((quantity.commodityId = observation.baseCommodityId ∧
            (quantity.canonicalNumber.numerator * observation.rate.numerator = 0 ∨
              (withinMagnitude
                  (quantity.canonicalNumber.numerator * observation.rate.numerator) = true ∧
                withinMagnitude
                  (quantity.canonicalNumber.denominator * observation.rate.denominator) = true))) ∨
          (quantity.commodityId ≠ observation.baseCommodityId ∧ allowInverse = true ∧
            quantity.commodityId = observation.quoteCommodityId ∧
            observation.rate.numerator ≠ 0 ∧
            (quantity.canonicalNumber.numerator * observation.rate.denominator = 0 ∨
              (withinMagnitude
                  (quantity.canonicalNumber.numerator * observation.rate.denominator) = true ∧
                withinMagnitude
                  (quantity.canonicalNumber.denominator * observation.rate.numerator) = true)))) := by
  rw [← ExactRational.multiply_isOk_iff hq hr, ← ExactRational.divide_isOk_iff hq]
  constructor
  · rintro ⟨value, h⟩
    obtain ⟨hafter, hcases⟩ := (valueWithObservation_ok_iff _ _ _ _ _).mp h
    refine ⟨hafter, ?_⟩
    rcases hcases with ⟨hbase, hmul, -⟩ | ⟨hbase, hallow, hquote, hdiv, -⟩
    · exact Or.inl ⟨hbase, _, hmul⟩
    · exact Or.inr ⟨hbase, hallow, hquote, _, hdiv⟩
  · rintro ⟨hafter, ⟨hbase, product, hmul⟩ | ⟨hbase, hallow, hquote, quotient, hdiv⟩⟩
    · exact ⟨⟨product, observation.quoteCommodityId, observation.id, false, effectiveAt⟩,
        (valueWithObservation_ok_iff _ _ _ _ _).mpr
          ⟨hafter, Or.inl ⟨hbase, hmul, rfl, rfl, rfl, rfl⟩⟩⟩
    · exact ⟨⟨quotient, observation.baseCommodityId, observation.id, true, effectiveAt⟩,
        (valueWithObservation_ok_iff _ _ _ _ _).mpr
          ⟨hafter, Or.inr ⟨hbase, hallow, hquote, hdiv, rfl, rfl, rfl, rfl⟩⟩⟩

/-- For a constructible quantity and rate the only errors of the exact numbers are the size limit,
and a division by a rate of zero when the inverse is the one used; a rate of zero is not refused
with the direct rate. -/
theorem valueWithObservation_error_exactNumber {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt : Instant} {allowInverse : Bool}
    {code : NumErr} (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (h : valueWithObservation quantity observation effectiveAt allowInverse =
      .error (.exactNumber code)) :
    code = .representationLimitExceeded ∨
      (code = .invalidRational ∧ observation.rate.numerator = 0 ∧
        quantity.commodityId ≠ observation.baseCommodityId) := by
  rcases ((valueWithObservation_error_exactNumber_iff _ _ _ _ _).mp h).2 with
    ⟨-, hmul⟩ | ⟨hbase, -, -, hdiv⟩
  · rcases ExactRational.multiply_ok_or_limit hq hr with ⟨product, hok⟩ | hlimit
    · rw [hok] at hmul; cases hmul
    · rw [hlimit] at hmul; cases hmul; exact Or.inl rfl
  · rcases ExactRational.divide_ok_or_error (b := observation.rate) hq with
      ⟨quotient, hok⟩ | ⟨hzero, herr⟩ | ⟨-, herr⟩
    · rw [hok] at hdiv; cases hdiv
    · rw [herr] at hdiv; cases hdiv; exact Or.inr ⟨rfl, hzero, hbase⟩
    · rw [herr] at hdiv; cases hdiv; exact Or.inl rfl

/-! ## The round trip through the inverse rate -/

/-- Valuing a quantity with the direct rate and then valuing the result back through the inverse
of the same observation gives the original number in the original commodity. -/
theorem valueWithObservation_roundTrip {quantity : Quantity} {observation : MarketPriceObservation}
    {effectiveAt backAt : Instant} {allowInverse backAllowInverse : Bool}
    {sourceNumber : Option ExactDecimal} {value back : MarketValue}
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value)
    (hdirect : value.usesInverse = false)
    (hback : valueWithObservation ⟨value.exactAmount, value.reportingCommodityId, sourceNumber⟩
      observation backAt backAllowInverse = .ok back)
    (hinverse : back.usesInverse = true) :
    back.exactAmount = quantity.canonicalNumber ∧
      back.reportingCommodityId = quantity.commodityId := by
  obtain ⟨hwf, hrat, hbase, -⟩ := valueWithObservation_direct hq hr h hdirect
  obtain ⟨hbwf, hne, hbrat, -, -, -, hrep, -⟩ :=
    valueWithObservation_inverse (quantity := ⟨value.exactAmount, value.reportingCommodityId,
      sourceNumber⟩) hwf hr hback hinverse
  refine ⟨ExactRational.eq_of_toRat_eq hbwf hq ?_, by rw [hrep, hbase]⟩
  rw [hbrat]
  simp only [hrat]
  field_simp

/-- When the two commodities of the observation differ, the way back from the quote commodity
always uses the inverse rate; so the round trip gives the original number whenever both calls
return. -/
theorem valueWithObservation_roundTrip_of_ne {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt backAt : Instant}
    {allowInverse backAllowInverse : Bool} {sourceNumber : Option ExactDecimal}
    {value back : MarketValue}
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (hne : observation.baseCommodityId ≠ observation.quoteCommodityId)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value)
    (hdirect : value.usesInverse = false)
    (hback : valueWithObservation ⟨value.exactAmount, value.reportingCommodityId, sourceNumber⟩
      observation backAt backAllowInverse = .ok back) :
    back.exactAmount = quantity.canonicalNumber ∧
      back.reportingCommodityId = quantity.commodityId := by
  obtain ⟨-, -, -, hrep, -⟩ := valueWithObservation_direct hq hr h hdirect
  refine valueWithObservation_roundTrip hq hr h hdirect hback ?_
  rw [valueWithObservation_usesInverse_iff hback]
  simp only [hrep]
  exact fun heq => hne heq.symm

/-! ## What an instant means in time, and what `Date.parse` makes of it

`valueWithObservation` compares two instants by `Date.parse` (line 35), not as strings. The
meaning of an instant is `Instant.exactMillis`: the milliseconds from 1970-01-01T00:00:00Z as an
exact number, with every digit of the fraction of a second. `Date.parse` answers the whole
milliseconds of that number, provided the fraction has at most nine digits or does not start with
a zero (`Instant.ReadTruncated`); a fraction of ten or more digits that starts with a zero is
misread (`dateParseFractionMillis_misread`). So the comparison by `Date.parse` is the order in
time only up to a millisecond, and for a misread instant not even that. Each statement below says
which. -/

/-- The fraction of a second that the digits after the point spell, in milliseconds, exactly. -/
def fractionExactMillis (digits : List Nat) : ℚ :=
  ((digitsValue digits * 1000 : Nat) : ℚ) / ((10 ^ digits.length : Nat) : ℚ)

/-- The whole seconds of an instant, as milliseconds from 1970-01-01T00:00:00Z. -/
def InstantFields.wholeSecondMillis (f : InstantFields) : Int :=
  (((f.date.dayNumber : Int) - 719528) * 86400 + f.hour * 3600 + f.minute * 60 + f.second) * 1000
    - f.offset.minutes * 60000

/-- The moment an instant names: milliseconds from 1970-01-01T00:00:00Z, exactly. -/
def InstantFields.exactMillis (f : InstantFields) : ℚ :=
  (f.wholeSecondMillis : ℚ) + fractionExactMillis f.fraction

/-- The moment an `Instant` names: milliseconds from 1970-01-01T00:00:00Z, exactly. -/
def Instant.exactMillis (i : Instant) : ℚ := i.toFields.exactMillis

/-- The instants `Date.parse` reads to the millisecond below: the fraction of a second has at most
nine digits, or does not start with a zero. -/
def Instant.ReadTruncated (i : Instant) : Prop :=
  i.toFields.fraction.length ≤ 9 ∨ i.toFields.fraction.head? ≠ some 0

instance (i : Instant) : Decidable i.ReadTruncated := by
  unfold Instant.ReadTruncated; infer_instance

/-- `Date.parse` answers the whole milliseconds of the moment an instant names, when the fraction
of a second has at most nine digits or does not start with a zero. -/
theorem InstantFields.dateParseMillis_eq_floor {f : InstantFields}
    (hdigits : ∀ digit ∈ f.fraction, digit < 10)
    (hshape : f.fraction.length ≤ 9 ∨ f.fraction.head? ≠ some 0) :
    f.dateParseMillis = ⌊f.exactMillis⌋ := by
  unfold InstantFields.exactMillis fractionExactMillis
  rw [Int.floor_intCast_add, Rat.floor_natCast_div_natCast, ← Int.natCast_div,
    ← dateParseFractionMillis_eq hdigits hshape]
  unfold InstantFields.dateParseMillis InstantFields.wholeSecondMillis
  ring

/-- `instantMillis`, and so `Date.parse`, answers the whole milliseconds of the moment a
constructible instant names, when its fraction of a second has at most nine digits or does not
start with a zero. -/
theorem instantMillis_eq_floor {i : Instant} (h : i.WF) (hread : i.ReadTruncated) :
    instantMillis i = .ok ⌊i.exactMillis⌋ := by
  rw [instantMillis_ok h, Instant.exactMillis,
    InstantFields.dateParseMillis_eq_floor h.toFields_spec.1.fraction_lt hread]

/-- On two constructible instants `Date.parse(left) > Date.parse(right)` compares the two numbers
of milliseconds `Date.parse` reads. -/
theorem dateParseAfter_eq {left right : Instant} (hl : left.WF) (hr : right.WF) :
    dateParseAfter left right =
      decide (left.toFields.dateParseMillis > right.toFields.dateParseMillis) := by
  have h1 : instant left.value = .ok left := (instant_ok_iff _ _).mpr ⟨rfl, hl⟩
  have h2 : instant right.value = .ok right := (instant_ok_iff _ _).mpr ⟨rfl, hr⟩
  simp [dateParseAfter, dateParse, h1, h2]

/-- `Date.parse(left) > Date.parse(right)` on two instants read to the millisecond says that the
whole milliseconds of `left` are more than those of `right`. -/
theorem dateParseAfter_iff_floor {left right : Instant} (hl : left.WF) (hr : right.WF)
    (hlr : left.ReadTruncated) (hrr : right.ReadTruncated) :
    dateParseAfter left right = true ↔ ⌊right.exactMillis⌋ < ⌊left.exactMillis⌋ := by
  rw [dateParseAfter_eq hl hr, decide_eq_true_eq, Instant.exactMillis, Instant.exactMillis,
    ← InstantFields.dateParseMillis_eq_floor hl.toFields_spec.1.fraction_lt hlr,
    ← InstantFields.dateParseMillis_eq_floor hr.toFields_spec.1.fraction_lt hrr]

/-- When `Date.parse(left) > Date.parse(right)` holds for two instants read to the millisecond,
`left` is a later moment than `right`. -/
theorem dateParseAfter_later {left right : Instant} (hl : left.WF) (hr : right.WF)
    (hlr : left.ReadTruncated) (hrr : right.ReadTruncated)
    (h : dateParseAfter left right = true) : right.exactMillis < left.exactMillis := by
  have hfloor := (dateParseAfter_iff_floor hl hr hlr hrr).mp h
  exact lt_of_lt_of_le (Int.floor_lt.mp hfloor) (Int.floor_le _)

/-- When `left` is a millisecond or more after `right`, both read to the millisecond,
`Date.parse(left) > Date.parse(right)` holds. -/
theorem dateParseAfter_of_millisecond_later {left right : Instant} (hl : left.WF) (hr : right.WF)
    (hlr : left.ReadTruncated) (hrr : right.ReadTruncated)
    (h : right.exactMillis + 1 ≤ left.exactMillis) : dateParseAfter left right = true := by
  rw [dateParseAfter_iff_floor hl hr hlr hrr]
  have h1 : ⌊right.exactMillis⌋ + 1 ≤ ⌊left.exactMillis⌋ := by
    rw [← Int.floor_add_one]
    exact Int.floor_le_floor h
  omega

/-! ## The time check of `valueWithObservation`, in time -/

/-- An observation that `Date.parse` reads as later than the effective time is always refused,
whatever the commodities and the rate. -/
theorem valueWithObservation_refuses_later_reading (quantity : Quantity)
    {observation : MarketPriceObservation} {effectiveAt : Instant} (allowInverse : Bool)
    (ho : observation.effectiveAt.WF) (he : effectiveAt.WF)
    (h : effectiveAt.toFields.dateParseMillis < observation.effectiveAt.toFields.dateParseMillis) :
    valueWithObservation quantity observation effectiveAt allowInverse =
      .error .observationAfterEffectiveTime := by
  rw [valueWithObservation_error_after_iff, dateParseAfter_eq ho he]
  simpa using h

/-- An observation from a millisecond or more after the effective time is always refused, when
both instants are read to the millisecond. -/
theorem valueWithObservation_refuses_millisecond_later (quantity : Quantity)
    {observation : MarketPriceObservation} {effectiveAt : Instant} (allowInverse : Bool)
    (ho : observation.effectiveAt.WF) (he : effectiveAt.WF)
    (hor : observation.effectiveAt.ReadTruncated) (her : effectiveAt.ReadTruncated)
    (h : effectiveAt.exactMillis + 1 ≤ observation.effectiveAt.exactMillis) :
    valueWithObservation quantity observation effectiveAt allowInverse =
      .error .observationAfterEffectiveTime :=
  (valueWithObservation_error_after_iff _ _ _ _).mpr
    (dateParseAfter_of_millisecond_later ho he hor her h)

/-- A valuation refused for the time had an observation from after the effective time, when both
instants are read to the millisecond. -/
theorem valueWithObservation_refused_time_was_later {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt : Instant} {allowInverse : Bool}
    (ho : observation.effectiveAt.WF) (he : effectiveAt.WF)
    (hor : observation.effectiveAt.ReadTruncated) (her : effectiveAt.ReadTruncated)
    (h : valueWithObservation quantity observation effectiveAt allowInverse =
      .error .observationAfterEffectiveTime) :
    effectiveAt.exactMillis < observation.effectiveAt.exactMillis :=
  dateParseAfter_later ho he hor her ((valueWithObservation_error_after_iff _ _ _ _).mp h)

/-- A returned value used an observation whose whole milliseconds are not after those of the
effective time: the observation is less than a millisecond after it, when both instants are read
to the millisecond. -/
theorem valueWithObservation_ok_time {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt : Instant} {allowInverse : Bool}
    {value : MarketValue}
    (ho : observation.effectiveAt.WF) (he : effectiveAt.WF)
    (hor : observation.effectiveAt.ReadTruncated) (her : effectiveAt.ReadTruncated)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value) :
    ⌊observation.effectiveAt.exactMillis⌋ ≤ ⌊effectiveAt.exactMillis⌋ ∧
      observation.effectiveAt.exactMillis < effectiveAt.exactMillis + 1 := by
  have hafter := ((valueWithObservation_ok_iff _ _ _ _ _).mp h).1
  have hfloor : ⌊observation.effectiveAt.exactMillis⌋ ≤ ⌊effectiveAt.exactMillis⌋ := by
    by_contra hlt
    have := (dateParseAfter_iff_floor ho he hor her).mpr (not_le.mp hlt)
    rw [hafter] at this
    exact absurd this (by simp)
  refine ⟨hfloor, ?_⟩
  have h1 : observation.effectiveAt.exactMillis < ⌊observation.effectiveAt.exactMillis⌋ + 1 :=
    Int.lt_floor_add_one _
  have h2 : (⌊observation.effectiveAt.exactMillis⌋ : ℚ) ≤ ⌊effectiveAt.exactMillis⌋ := by
    exact_mod_cast hfloor
  have h3 : (⌊effectiveAt.exactMillis⌋ : ℚ) ≤ effectiveAt.exactMillis := Int.floor_le _
  linarith

/-! ## Where the time check disagrees with time

Three inputs on which `valuation.ts` line 35 does not do what "an observation from after the
effective time is refused" says. The size limit is never evaluated in their proofs: the time
check is computed, the arithmetic goes through `of_small`. -/

/-- `ExactRational.of` on two parts below 256, the denominator positive: the two parts divided by
their greatest common divisor. -/
private theorem of_small {n d : Int} (hd : 0 < d) (hn : n.natAbs < 2 ^ 8) (hdd : d.natAbs < 2 ^ 8) :
    ExactRational.of n d = .ok ⟨n / (Int.gcd n d : Int), d / (Int.gcd n d : Int)⟩ := by
  have small : ∀ v : Int, v.natAbs < 2 ^ 8 → withinMagnitude v = true := fun v hv =>
    (withinMagnitude_iff v).mpr
      (Nat.lt_of_lt_of_le hv (Nat.pow_le_pow_right (by decide) (by decide)))
  by_cases h0 : n = 0
  · subst h0
    have hg : ((Int.gcd 0 d : Nat) : Int) = d := by
      rw [Int.gcd_zero_left]; omega
    rw [hg, Int.ediv_self (by omega)]
    simp [ExactRational.of, show ¬ d ≤ 0 by omega]
  · exact ExactRational.of_eq_reduced hd h0 (small n hn) (small d hdd)

/-- An observation of euros in dollars at the rate 2, effective at the given instant: the
observation of the examples below. -/
def exampleObservation (effectiveAt : String) : MarketPriceObservation :=
  { id := ⟨"observation"⟩
    effectiveAt := ⟨effectiveAt⟩
    observedAt := ⟨effectiveAt⟩
    kind := .marketQuote
    rate := ⟨2, 1⟩
    baseCommodityId := ⟨"EUR"⟩
    quoteCommodityId := ⟨"USD"⟩
    evidenceId := ⟨"evidence"⟩ }

/-- Three euros: the quantity of the examples below. -/
def exampleQuantity : Quantity := ⟨⟨3, 1⟩, ⟨"EUR"⟩, none⟩

/-- Three euros at the rate 2 are six dollars, whenever the time check passes. -/
private theorem example_value {observedAt : String} {effectiveAt : Instant}
    (h : dateParseAfter ⟨observedAt⟩ effectiveAt = false) :
    valueWithObservation exampleQuantity (exampleObservation observedAt) effectiveAt false =
      .ok ⟨⟨6, 1⟩, ⟨"USD"⟩, ⟨"observation"⟩, false, effectiveAt⟩ := by
  refine (valueWithObservation_ok_iff _ _ _ _ _).mpr ⟨h, Or.inl ⟨rfl, ?_, rfl, rfl, rfl, rfl⟩⟩
  show ExactRational.of (3 * 2) (1 * 1) = .ok ⟨6, 1⟩
  rw [of_small (by decide) (by decide) (by decide)]
  decide

/-- An observation from 0.8 of a millisecond after the effective time is accepted: both instants
are admitted and read to the millisecond, the observation is the later moment, and a value is
returned. -/
theorem valueWithObservation_accepts_later_within_millisecond :
    instant "2024-01-01T00:00:00.0009Z" = .ok ⟨"2024-01-01T00:00:00.0009Z"⟩ ∧
      instant "2024-01-01T00:00:00.0001Z" = .ok ⟨"2024-01-01T00:00:00.0001Z"⟩ ∧
      (⟨"2024-01-01T00:00:00.0009Z"⟩ : Instant).ReadTruncated ∧
      (⟨"2024-01-01T00:00:00.0001Z"⟩ : Instant).ReadTruncated ∧
      (⟨"2024-01-01T00:00:00.0001Z"⟩ : Instant).exactMillis <
        (⟨"2024-01-01T00:00:00.0009Z"⟩ : Instant).exactMillis ∧
      valueWithObservation exampleQuantity (exampleObservation "2024-01-01T00:00:00.0009Z")
          ⟨"2024-01-01T00:00:00.0001Z"⟩ false =
        .ok ⟨⟨6, 1⟩, ⟨"USD"⟩, ⟨"observation"⟩, false, ⟨"2024-01-01T00:00:00.0001Z"⟩⟩ :=
  ⟨by decide +kernel, by decide +kernel, by decide +kernel, by decide +kernel,
    by decide +kernel, example_value (by decide +kernel)⟩

/-- An observation from more than 37 milliseconds after the effective time is accepted, because
`Date.parse` misreads the effective time: of its fraction `.0123456789` it makes 123
milliseconds. -/
theorem valueWithObservation_accepts_later_misread :
    instant "2020-01-01T00:00:00.05Z" = .ok ⟨"2020-01-01T00:00:00.05Z"⟩ ∧
      instant "2020-01-01T00:00:00.0123456789Z" = .ok ⟨"2020-01-01T00:00:00.0123456789Z"⟩ ∧
      (⟨"2020-01-01T00:00:00.0123456789Z"⟩ : Instant).exactMillis + 37 <
        (⟨"2020-01-01T00:00:00.05Z"⟩ : Instant).exactMillis ∧
      valueWithObservation exampleQuantity (exampleObservation "2020-01-01T00:00:00.05Z")
          ⟨"2020-01-01T00:00:00.0123456789Z"⟩ false =
        .ok ⟨⟨6, 1⟩, ⟨"USD"⟩, ⟨"observation"⟩, false, ⟨"2020-01-01T00:00:00.0123456789Z"⟩⟩ :=
  ⟨by decide +kernel, by decide +kernel, by decide +kernel, example_value (by decide +kernel)⟩

/-- An observation from more than 87 milliseconds before the effective time is refused as being
from after it, because `Date.parse` misreads the observation's time. -/
theorem valueWithObservation_refuses_earlier_misread :
    instant "2020-01-01T00:00:00.0123456789Z" = .ok ⟨"2020-01-01T00:00:00.0123456789Z"⟩ ∧
      instant "2020-01-01T00:00:00.1Z" = .ok ⟨"2020-01-01T00:00:00.1Z"⟩ ∧
      (⟨"2020-01-01T00:00:00.0123456789Z"⟩ : Instant).exactMillis + 87 <
        (⟨"2020-01-01T00:00:00.1Z"⟩ : Instant).exactMillis ∧
      valueWithObservation exampleQuantity
          (exampleObservation "2020-01-01T00:00:00.0123456789Z") ⟨"2020-01-01T00:00:00.1Z"⟩
          false =
        .error .observationAfterEffectiveTime :=
  ⟨by decide +kernel, by decide +kernel, by decide +kernel,
    (valueWithObservation_error_after_iff _ _ _ _).mpr (by decide +kernel)⟩

/-! ## What else `valueWithObservation` does that a reader might not expect -/

/-- When the two commodities of an observation are the same, the inverse is never used: valuing
there and "back" multiplies by the rate twice. -/
theorem valueWithObservation_same_commodity_twice {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt backAt : Instant}
    {allowInverse backAllowInverse : Bool} {sourceNumber : Option ExactDecimal}
    {value back : MarketValue}
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (hsame : observation.baseCommodityId = observation.quoteCommodityId)
    (h : valueWithObservation quantity observation effectiveAt allowInverse = .ok value)
    (hback : valueWithObservation ⟨value.exactAmount, value.reportingCommodityId, sourceNumber⟩
      observation backAt backAllowInverse = .ok back) :
    value.usesInverse = false ∧ back.usesInverse = false ∧
      back.exactAmount.toRat =
        quantity.canonicalNumber.toRat * observation.rate.toRat * observation.rate.toRat := by
  have direct : ∀ {q : Quantity} {t : Instant} {allow : Bool} {v : MarketValue},
      valueWithObservation q observation t allow = .ok v → v.usesInverse = false := by
    intro q t allow v hv
    rcases ((valueWithObservation_ok_iff _ _ _ _ _).mp hv).2 with
      ⟨-, -, -, hdir, -⟩ | ⟨hbase, -, hquote, -⟩
    · exact hdir
    · exact absurd (hquote.trans hsame.symm) hbase
  obtain ⟨hwf, hrat, -⟩ := valueWithObservation_direct hq hr h (direct h)
  obtain ⟨-, hbrat, -⟩ := valueWithObservation_direct (quantity := ⟨value.exactAmount,
    value.reportingCommodityId, sourceNumber⟩) hwf hr hback (direct hback)
  exact ⟨direct h, direct hback, by rw [hbrat]; simp only [hrat]⟩

/-- A rate of zero is not refused with the direct rate: the quantity is worth exactly nothing. -/
theorem valueWithObservation_zero_rate_direct {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt : Instant} (allowInverse : Bool)
    (hq : quantity.canonicalNumber.WF) (hr : observation.rate.WF)
    (hafter : dateParseAfter observation.effectiveAt effectiveAt = false)
    (hbase : quantity.commodityId = observation.baseCommodityId)
    (hzero : observation.rate.numerator = 0) :
    valueWithObservation quantity observation effectiveAt allowInverse =
      .ok ⟨ExactRational.zero, observation.quoteCommodityId, observation.id, false,
        effectiveAt⟩ := by
  refine (valueWithObservation_ok_iff _ _ _ _ _).mpr ⟨hafter, Or.inl ⟨hbase, ?_, rfl, rfl, rfl, rfl⟩⟩
  have hd : ¬ quantity.canonicalNumber.denominator * observation.rate.denominator ≤ 0 := by
    have := Int.mul_pos hq.denominator_pos hr.denominator_pos
    omega
  simp [ExactRational.multiply, ExactRational.of, hzero, hd, ExactRational.zero]

/-- With the inverse, a rate of zero is not a `RangeError` of the valuation: the division throws
the error of the exact numbers, `invalid_rational`. -/
theorem valueWithObservation_zero_rate_inverse {quantity : Quantity}
    {observation : MarketPriceObservation} {effectiveAt : Instant}
    (hq : quantity.canonicalNumber.WF)
    (hafter : dateParseAfter observation.effectiveAt effectiveAt = false)
    (hbase : quantity.commodityId ≠ observation.baseCommodityId)
    (hquote : quantity.commodityId = observation.quoteCommodityId)
    (hzero : observation.rate.numerator = 0) :
    valueWithObservation quantity observation effectiveAt true =
      .error (.exactNumber .invalidRational) :=
  (valueWithObservation_error_exactNumber_iff _ _ _ _ _).mpr
    ⟨hafter, Or.inr ⟨hbase, rfl, hquote,
      (ExactRational.divide_eq_invalidRational_iff hq).mpr hzero⟩⟩

/-- A rate below zero is not refused: three euros at the rate minus two are worth minus six
dollars. -/
theorem valueWithObservation_accepts_negative_rate :
    valueWithObservation exampleQuantity
        { exampleObservation "2024-01-01T00:00:00Z" with rate := ⟨-2, 1⟩ }
        ⟨"2024-01-01T00:00:00Z"⟩ false =
      .ok ⟨⟨-6, 1⟩, ⟨"USD"⟩, ⟨"observation"⟩, false, ⟨"2024-01-01T00:00:00Z"⟩⟩ := by
  refine (valueWithObservation_ok_iff _ _ _ _ _).mpr
    ⟨by decide +kernel, Or.inl ⟨rfl, ?_, rfl, rfl, rfl, rfl⟩⟩
  show ExactRational.of (3 * -2) (1 * 1) = .ok ⟨-6, 1⟩
  rw [of_small (by decide) (by decide) (by decide)]
  decide

/-- `priceObservationId` accepts exactly the well-formed identifier texts and returns the text
unchanged. -/
theorem priceObservationId_ok_iff (value : String) (id : PriceObservationId) :
    priceObservationId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

end Rastrata.Kernel

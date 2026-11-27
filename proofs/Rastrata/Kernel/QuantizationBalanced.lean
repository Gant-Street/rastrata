/-
Rounding that balances: the Lean model of the rest of `packages/kernel/src/quantization.ts`
(`QuantizationPolicyId`, `QuantizationPolicy`, `hashQuantizationPolicy`,
`quantizeBalancedBookValues`, and `quantizeCumulativePostedShare` over the full policy), on top
of the arithmetic of `Quantization.lean`.

Every definition mirrors one TypeScript member, named in its doc comment, with the same checks
in the same order and the same diagnostics (code, path, message text and requirement
identifiers, none left out). The soundness laws assume only that the inputs are constructible
and that the calls returned `.ok`; a completeness law assumes the conditions it names; and
`quantizeBalancedBookValues_rounding_isOk` alone assumes that the list is shorter than the size
limit, which every JavaScript array is.

Where the model differs from the TypeScript in form:

- `quantizeCumulativePostedShare` over the rule already has the TypeScript's name, so the one
  over the full policy is `QuantizationPolicy.quantizeCumulativePostedShare`, with its record
  `PolicyCumulativePostedShare` and its result `PolicyShareResult`.
- The TypeScript's test that the rounding mode is one of the five (line 71) always passes for a
  value of the type `RoundingMode`.
- `Object.freeze` and the copy of the policy (`{ ...policy }`, line 93) are not modelled.
-/
import Rastrata.Kernel.Quantization
import Rastrata.Kernel.NumericLimits
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Policy.Types

namespace Rastrata.Kernel

/-! ## The policy record -/

/-- `QuantizationPolicyId`. -/
abbrev QuantizationPolicyId := Identifier "QuantizationPolicy"

/-- `quantizationPolicyId`. -/
def quantizationPolicyId (value : String) : Except CanonicalErr QuantizationPolicyId :=
  identifier "QuantizationPolicy" value

/-- `QuantizationPolicy`. The optional `validTo` is an `Option`. -/
structure QuantizationPolicy where
  id : QuantizationPolicyId
  version : SemanticVersion
  bookId : BookId
  functionalCommodityId : CommodityId
  validFrom : LocalDate
  validTo : Option LocalDate
  targetScale : Int
  roundingMode : RoundingMode
  roundingAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- The two fields of a policy that the arithmetic of `Quantization.lean` reads. -/
def QuantizationPolicy.rule (policy : QuantizationPolicy) : QuantizationRule :=
  ⟨policy.targetScale, policy.roundingMode⟩

/-- A rounding mode as the TypeScript writes it: the string literal of `RoundingMode`. -/
def RoundingMode.text : RoundingMode → String
  | .halfEven => "halfEven"
  | .halfAwayFromZero => "halfAwayFromZero"
  | .towardZero => "towardZero"
  | .floor => "floor"
  | .ceiling => "ceiling"

/-- The entries of the object `hashQuantizationPolicy` hashes: the same field names in the same
order as the TypeScript object literal, `null` for a policy without `validTo`. -/
def quantizationPolicyEntries (policy : QuantizationPolicy) : List (String × CanonicalValue) :=
  [("type", .string "QuantizationPolicy"),
    ("id", .string policy.id.value),
    ("version", .string policy.version.value),
    ("bookId", .string policy.bookId.value),
    ("functionalCommodityId", .string policy.functionalCommodityId.value),
    ("validFrom", .string policy.validFrom.value),
    ("validTo", match policy.validTo with
      | some date => .string date.value
      | none => .null),
    ("targetScale", .int policy.targetScale),
    ("roundingMode", .string policy.roundingMode.text),
    ("roundingAccountId", .string policy.roundingAccountId.value)]

/-- The record `hashQuantizationPolicy` hashes. -/
def canonicalQuantizationPolicyValue (policy : QuantizationPolicy) : CanonicalValue :=
  .record (quantizationPolicyEntries policy)

/-- `hashQuantizationPolicy`. -/
def hashQuantizationPolicy (policy : QuantizationPolicy) : ContentHash :=
  hashCanonical (canonicalQuantizationPolicyValue policy)

/-! ## `quantizeBalancedBookValues`: the model -/

/-- The `roundingPosting` of `BalancedQuantizationResult`, which has no name in the TypeScript. -/
structure RoundingPosting where
  accountId : AccountId
  bookValue : BookValue
  deriving DecidableEq, Repr, Inhabited

/-- `BalancedQuantizationResult`: the two dispositions, `quantized` and `rejected`. -/
inductive BalancedQuantizationResult where
  | quantized (bookValues : List BookValue) (roundingPosting : Option RoundingPosting)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- The diagnostic of the first rejection of `quantizeBalancedBookValues` (line 157). -/
def balancedScaleDiagnostic : SemanticDiagnostic :=
  diagnostic .invalid_exact_number "quantizationPolicy.targetScale"
    "Quantization scale exceeds the admitted exact-decimal representation"
    ["ACC-001", "ACC-003", "ACC-022"]

/-- The diagnostic of the second rejection of `quantizeBalancedBookValues` (line 165). -/
def balancedIsolationDiagnostic : SemanticDiagnostic :=
  diagnostic .book_isolation_violation "quantizationPolicy"
    "Quantization policy belongs to another book or commodity" ["ACC-002", "ACC-003", "ACC-026"]

/-- The diagnostic of the third rejection of `quantizeBalancedBookValues` (line 174). -/
def balancedImbalanceDiagnostic : SemanticDiagnostic :=
  diagnostic .journal_imbalance "exactValues" "Values must balance exactly before quantization"
    ["ACC-001", "ACC-003"]

/-- `exactValues.reduce((total, value) => total.add(value), start)` (line 169): the values are
added from the left, and the first addition that throws ends it. -/
def addExactValues (total : ExactRational) : List ExactRational → Except NumErr ExactRational
  | [] => .ok total
  | value :: rest =>
    match total.add value with
    | .error e => .error e
    | .ok next => addExactValues next rest

/-- `exactValues.map((value) => quantize(value, policy).amount)` (line 178): the values are
rounded from the left, and the first rounding that throws ends it. -/
def quantizeAmounts (rule : QuantizationRule) :
    List ExactRational → Except QuantizeErr (List ExactDecimal)
  | [] => .ok []
  | value :: rest =>
    match quantize value rule with
    | .error e => .error e
    | .ok quantizedValue =>
      match quantizeAmounts rule rest with
      | .error e => .error e
      | .ok amounts => .ok (quantizedValue.amount :: amounts)

/-- `quantized.reduce((total, amount) => total.add(amount.toRational()), start)` (lines 179 to
182). -/
def addAmounts (total : ExactRational) : List ExactDecimal → Except NumErr ExactRational
  | [] => .ok total
  | amount :: rest =>
    match amount.toRational with
    | .error e => .error e
    | .ok amountRational =>
      match total.add amountRational with
      | .error e => .error e
      | .ok next => addAmounts next rest

/-- `quantizeBalancedBookValues`. -/
def quantizeBalancedBookValues (exactValues : List ExactRational) (bookId : BookId)
    (functionalCommodityId : CommodityId) (policy : QuantizationPolicy) :
    Except QuantizeErr BalancedQuantizationResult :=
  if policy.targetScale < 0 ∨ policy.targetScale > maxDecimalScale then
    .ok (.rejected [balancedScaleDiagnostic])
  else if policy.bookId ≠ bookId ∨ policy.functionalCommodityId ≠ functionalCommodityId then
    .ok (.rejected [balancedIsolationDiagnostic])
  else
    match liftExact (addExactValues ExactRational.zero exactValues) with
    | .error e => .error e
    | .ok exactTotal =>
      if exactTotal.isZero = false then .ok (.rejected [balancedImbalanceDiagnostic])
      else
        match quantizeAmounts policy.rule exactValues with
        | .error e => .error e
        | .ok quantized =>
          match liftExact (addAmounts ExactRational.zero quantized) with
          | .error e => .error e
          | .ok quantizedTotal =>
            let bookValues : List BookValue :=
              quantized.map fun amount => ⟨amount, functionalCommodityId⟩
            if quantizedTotal.isZero = true then .ok (.quantized bookValues none)
            else
              match quantize quantizedTotal.negate policy.rule with
              | .error e => .error e
              | .ok rounding =>
                .ok (.quantized bookValues
                  (some ⟨policy.roundingAccountId, ⟨rounding.amount, functionalCommodityId⟩⟩))

/-! ## `quantizeCumulativePostedShare` over the full policy: the model -/

/-- `CumulativePostedShare`, with the policy it was computed under. -/
structure PolicyCumulativePostedShare where
  postedTotal : ExactDecimal
  beforeFraction : ExactRational
  afterFraction : ExactRational
  beforeTarget : ExactRational
  afterTarget : ExactRational
  beforeQuantization : QuantizedValue
  afterQuantization : QuantizedValue
  postedAmount : ExactDecimal
  policy : QuantizationPolicy
  deriving DecidableEq, Repr, Inhabited

/-- The share of `Quantization.lean` that a share with its policy carries: the same eight
values, and the rule of the policy. -/
def PolicyCumulativePostedShare.toShare (share : PolicyCumulativePostedShare) :
    CumulativePostedShare :=
  { postedTotal := share.postedTotal
    beforeFraction := share.beforeFraction
    afterFraction := share.afterFraction
    beforeTarget := share.beforeTarget
    afterTarget := share.afterTarget
    beforeQuantization := share.beforeQuantization
    afterQuantization := share.afterQuantization
    postedAmount := share.postedAmount
    rule := share.policy.rule }

/-- A share of `Quantization.lean` with the policy in place of its rule. -/
def CumulativePostedShare.withPolicy (share : CumulativePostedShare)
    (policy : QuantizationPolicy) : PolicyCumulativePostedShare :=
  { postedTotal := share.postedTotal
    beforeFraction := share.beforeFraction
    afterFraction := share.afterFraction
    beforeTarget := share.beforeTarget
    afterTarget := share.afterTarget
    beforeQuantization := share.beforeQuantization
    afterQuantization := share.afterQuantization
    postedAmount := share.postedAmount
    policy := policy }

/-- The diagnostic of the first rejection of `quantizeCumulativePostedShare` (line 76). -/
def shareInvalidDiagnostic : SemanticDiagnostic :=
  diagnostic .invalid_exact_number "cumulativePostedShare"
    "A posted share requires an admitted quantization policy, a nonnegative total, and ordered cumulative fractions from zero through one"
    ["ACC-001", "ACC-003", "ACC-039.5"]

/-- The diagnostic of the second rejection of `quantizeCumulativePostedShare` (line 82). -/
def shareTotalDiagnostic : SemanticDiagnostic :=
  diagnostic .invalid_exact_number "cumulativePostedShare.postedTotal"
    "The authenticated posted total must already be representable in the pinned policy; a new policy may not silently reround it"
    ["ACC-003", "ACC-011", "ACC-039.5"]

/-- The diagnostic the TypeScript gives for each of the two rejections. -/
def ShareRejection.diagnostic : ShareRejection → SemanticDiagnostic
  | .invalidShare => shareInvalidDiagnostic
  | .totalNotRepresentable => shareTotalDiagnostic

/-- The result of `quantizeCumulativePostedShare` when it does not throw: the two dispositions,
`quantized` and `rejected`. -/
inductive PolicyShareResult where
  | quantized (share : PolicyCumulativePostedShare)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- `quantizeCumulativePostedShare`, over the full policy: the arithmetic of `Quantization.lean`
on the policy's rule, each rejection as the list of its one diagnostic, and the policy carried
into the share. -/
def QuantizationPolicy.quantizeCumulativePostedShare (postedTotal : ExactDecimal)
    (beforeFraction afterFraction : ExactRational) (policy : QuantizationPolicy) :
    Except QuantizeErr PolicyShareResult :=
  match Rastrata.Kernel.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction
    policy.rule with
  | .error e => .error e
  | .ok (.rejected reason) => .ok (.rejected [reason.diagnostic])
  | .ok (.quantized share) => .ok (.quantized (share.withPolicy policy))

/-! ## Meaning -/

/-- The meaning of the rounding posting: its amount, or nothing when there is none. -/
def roundingPostingRat : Option RoundingPosting → ℚ
  | none => 0
  | some posting => posting.bookValue.amount.toRat

/-- The total of a list of exact values, as a number. -/
def exactTotalRat (values : List ExactRational) : ℚ := (values.map ExactRational.toRat).sum

/-- The total of a list of amounts, as a number. -/
def amountTotalRat (amounts : List ExactDecimal) : ℚ := (amounts.map ExactDecimal.toRat).sum

/-- The total of a list of book values, as a number. -/
def bookValueTotalRat (bookValues : List BookValue) : ℚ :=
  (bookValues.map fun bookValue => bookValue.amount.toRat).sum

/-! ## What the three loops return -/

/-- `liftExact` returns exactly when the operation of `numeric.ts` returned. -/
private theorem liftExact_eq_ok {α : Type} {result : Except NumErr α} {value : α}
    (h : liftExact result = .ok value) : result = .ok value := by
  cases result with
  | error code => cases h
  | ok v => cases h; rfl

/-- When the additions of the exact values all return, the result is the starting total plus
the total of the values. -/
theorem addExactValues_ok {values : List ExactRational} :
    ∀ {total result : ExactRational}, total.WF → (∀ value ∈ values, value.WF) →
      addExactValues total values = .ok result →
      result.WF ∧ result.toRat = total.toRat + exactTotalRat values := by
  induction values with
  | nil =>
    intro total result ht _ h
    cases h
    exact ⟨ht, by simp [exactTotalRat]⟩
  | cons value rest ih =>
    intro total result ht hv h
    simp only [addExactValues] at h
    split at h
    · cases h
    · rename_i next hnext
      obtain ⟨hnwf, hntr⟩ := ExactRational.add_ok ht (hv value (by simp)) hnext
      obtain ⟨hrwf, hrtr⟩ := ih hnwf (fun v hm => hv v (by simp [hm])) h
      refine ⟨hrwf, ?_⟩
      rw [hrtr, hntr]
      simp only [exactTotalRat, List.map_cons, List.sum_cons]
      ring

/-- When the roundings of the exact values all return, there is one amount a value, in the
same order, and each is the amount `quantize` gives for its value. -/
theorem quantizeAmounts_ok {rule : QuantizationRule} {values : List ExactRational} :
    ∀ {amounts : List ExactDecimal}, quantizeAmounts rule values = .ok amounts →
      List.Forall₂ (fun value amount => ∃ quantizedValue,
        quantize value rule = .ok quantizedValue ∧ quantizedValue.amount = amount)
        values amounts := by
  induction values with
  | nil =>
    intro amounts h
    cases h
    exact List.Forall₂.nil
  | cons value rest ih =>
    intro amounts h
    simp only [quantizeAmounts] at h
    split at h
    · cases h
    · rename_i quantizedValue hq
      split at h
      · cases h
      · rename_i tail htail
        cases h
        exact List.Forall₂.cons ⟨quantizedValue, hq, rfl⟩ (ih htail)

/-- When the additions of the amounts all return, the result is the starting total plus the
total of the amounts. -/
theorem addAmounts_ok {amounts : List ExactDecimal} :
    ∀ {total result : ExactRational}, total.WF → (∀ amount ∈ amounts, amount.WF) →
      addAmounts total amounts = .ok result →
      result.WF ∧ result.toRat = total.toRat + amountTotalRat amounts := by
  induction amounts with
  | nil =>
    intro total result ht _ h
    cases h
    exact ⟨ht, by simp [amountTotalRat]⟩
  | cons amount rest ih =>
    intro total result ht ha h
    simp only [addAmounts] at h
    split at h
    · cases h
    · rename_i amountRational har
      split at h
      · cases h
      · rename_i next hnext
        obtain ⟨harwf, hartr⟩ := ExactDecimal.toRational_ok (ha amount (by simp)) har
        obtain ⟨hnwf, hntr⟩ := ExactRational.add_ok ht harwf hnext
        obtain ⟨hrwf, hrtr⟩ := ih hnwf (fun a hm => ha a (by simp [hm])) h
        refine ⟨hrwf, ?_⟩
        rw [hrtr, hntr, hartr]
        simp only [amountTotalRat, List.map_cons, List.sum_cons]
        ring

/-! ## What `quantizeBalancedBookValues` returns -/

/-- What a result that was not rejected was computed from: every check passed, every step
returned, and there is a rounding posting exactly when the total of the amounts is not the
value zero. -/
theorem quantizeBalancedBookValues_quantized {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    ∃ exactTotal quantized quantizedTotal,
      0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
      policy.bookId = bookId ∧ policy.functionalCommodityId = functionalCommodityId ∧
      addExactValues ExactRational.zero exactValues = .ok exactTotal ∧
      exactTotal.isZero = true ∧
      quantizeAmounts policy.rule exactValues = .ok quantized ∧
      addAmounts ExactRational.zero quantized = .ok quantizedTotal ∧
      bookValues = quantized.map (fun amount => ⟨amount, functionalCommodityId⟩) ∧
      ((quantizedTotal.isZero = true ∧ roundingPosting = none) ∨
        (quantizedTotal.isZero = false ∧ ∃ rounding,
          quantize quantizedTotal.negate policy.rule = .ok rounding ∧
          roundingPosting =
            some ⟨policy.roundingAccountId, ⟨rounding.amount, functionalCommodityId⟩⟩)) := by
  unfold quantizeBalancedBookValues at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · cases h
        · split at h
          · cases h
          · split at h
            · cases h
            · rename_i hscale hbook _ exactTotal hexact hzero _ quantized hq _ quantizedTotal hqt
              simp only [not_or, not_lt, not_not] at hscale hbook
              have hz : exactTotal.isZero = true := (Bool.not_eq_false _).mp hzero
              split at h
              · rename_i hqz
                cases h
                exact ⟨exactTotal, quantized, quantizedTotal, hscale.1, hscale.2, hbook.1,
                  hbook.2, liftExact_eq_ok hexact, hz, hq, liftExact_eq_ok hqt, rfl,
                  Or.inl ⟨hqz, rfl⟩⟩
              · rename_i hqz
                split at h
                · cases h
                · rename_i rounding hr
                  cases h
                  exact ⟨exactTotal, quantized, quantizedTotal, hscale.1, hscale.2, hbook.1,
                    hbook.2, liftExact_eq_ok hexact, hz, hq, liftExact_eq_ok hqt, rfl,
                    Or.inr ⟨(Bool.not_eq_true _).mp hqz, rounding, hr, rfl⟩⟩

/-- An amount at the rule's scale is its coefficient times the rule's unit. -/
private theorem amount_eq_mul_unit {amount : ExactDecimal} {rule : QuantizationRule}
    (h : amount.scale = rule.targetScale) : amount.toRat = amount.coefficient * rule.unit := by
  unfold ExactDecimal.toRat QuantizationRule.unit
  rw [h]
  ring

/-- The total of amounts at the rule's scale is the total of their coefficients times the
rule's unit. -/
private theorem amountTotalRat_eq_mul_unit {rule : QuantizationRule} {amounts : List ExactDecimal}
    (h : ∀ amount ∈ amounts, amount.scale = rule.targetScale) :
    amountTotalRat amounts =
      ((amounts.map ExactDecimal.coefficient).sum : Int) * rule.unit := by
  induction amounts with
  | nil => simp [amountTotalRat]
  | cons amount rest ih =>
    have e := ih (fun a hm => h a (by simp [hm]))
    simp only [amountTotalRat, List.map_cons, List.sum_cons] at e ⊢
    rw [e, amount_eq_mul_unit (h amount (by simp))]
    push_cast
    ring

/-- The amounts rounded from constructible values are constructible and at the rule's scale. -/
private theorem amounts_wf {rule : QuantizationRule} {values : List ExactRational}
    {amounts : List ExactDecimal} (hv : ∀ value ∈ values, value.WF)
    (h : List.Forall₂ (fun value amount => ∃ quantizedValue,
      quantize value rule = .ok quantizedValue ∧ quantizedValue.amount = amount)
      values amounts) :
    ∀ amount ∈ amounts, amount.WF ∧ amount.scale = rule.targetScale := by
  induction h with
  | nil =>
    intro amount hm
    cases hm
  | @cons value amount values' amounts' hhead _ ih =>
    intro a hm
    rcases List.mem_cons.mp hm with rfl | hm'
    · obtain ⟨quantizedValue, hq, rfl⟩ := hhead
      obtain ⟨hwf, -, hs, -, -⟩ := quantize_ok (hv value (by simp)) hq
      exact ⟨hwf, hs⟩
    · exact ih (fun v hmv => hv v (by simp [hmv])) a hm'

/-- The total of the book values made from a list of amounts is the total of the amounts. -/
private theorem bookValueTotalRat_map (amounts : List ExactDecimal)
    (functionalCommodityId : CommodityId) :
    bookValueTotalRat (amounts.map fun amount => ⟨amount, functionalCommodityId⟩) =
      amountTotalRat amounts := by
  simp [bookValueTotalRat, amountTotalRat, Function.comp_def]

/-- A result that was not rejected, as numbers: the exact values add up to zero, the amounts
are the roundings of the values, and the rounding posting, when there is one, is exactly the
total of the amounts with its sign changed. -/
private theorem balanced_view {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    ∃ quantized : List ExactDecimal,
      bookValues = quantized.map (fun amount => ⟨amount, functionalCommodityId⟩) ∧
      List.Forall₂ (fun value amount => ∃ quantizedValue,
        quantize value policy.rule = .ok quantizedValue ∧ quantizedValue.amount = amount)
        exactValues quantized ∧
      exactTotalRat exactValues = 0 ∧
      (∀ amount ∈ quantized, amount.WF ∧ amount.scale = policy.targetScale) ∧
      ((amountTotalRat quantized = 0 ∧ roundingPosting = none) ∨
        (amountTotalRat quantized ≠ 0 ∧ ∃ rounding : ExactDecimal,
          rounding.WF ∧ rounding.scale = policy.targetScale ∧
          rounding.toRat = -amountTotalRat quantized ∧
          rounding.coefficient = -(quantized.map ExactDecimal.coefficient).sum ∧
          roundingPosting =
            some ⟨policy.roundingAccountId, ⟨rounding, functionalCommodityId⟩⟩)) := by
  obtain ⟨exactTotal, quantized, quantizedTotal, -, -, -, -, hexact, hzero, hq, hqt, hbv, hround⟩ :=
    quantizeBalancedBookValues_quantized h
  obtain ⟨hetwf, hettr⟩ := addExactValues_ok ExactRational.zero_wf hv hexact
  have hall := quantizeAmounts_ok hq
  have hawf := amounts_wf hv hall
  obtain ⟨hqtwf, hqttr⟩ := addAmounts_ok ExactRational.zero_wf (fun a hm => (hawf a hm).1) hqt
  rw [ExactRational.zero_toRat, zero_add] at hettr hqttr
  refine ⟨quantized, hbv, hall, ?_, hawf, ?_⟩
  · rw [← hettr]
    exact (ExactRational.isZero_iff hetwf).mp hzero
  · rcases hround with ⟨hz, hnone⟩ | ⟨hz, rounding, hr, hsome⟩
    · exact Or.inl ⟨by rw [← hqttr]; exact (ExactRational.isZero_iff hqtwf).mp hz, hnone⟩
    · right
      have hne : amountTotalRat quantized ≠ 0 := by
        rw [← hqttr]
        intro hc
        rw [(ExactRational.isZero_iff hqtwf).mpr hc] at hz
        cases hz
      have hnwf := ExactRational.negate_wf hqtwf
      obtain ⟨hrwf, -, hrs, -, -⟩ := quantize_ok hnwf hr
      have hunits := amountTotalRat_eq_mul_unit (rule := policy.rule) (fun a hm => (hawf a hm).2)
      obtain ⟨hc, hrt, -, -⟩ := quantize_representable hnwf hr
        (c := -(quantized.map ExactDecimal.coefficient).sum) (by
          rw [ExactRational.negate_toRat, hqttr, hunits]
          unfold QuantizationRule.unit
          push_cast
          ring)
      exact ⟨hne, rounding.amount, hrwf, hrs,
        by rw [hrt, ExactRational.negate_toRat, hqttr], hc, hsome⟩

/-! ## Law 1: what is returned balances -/

/-- Values are rounded only when they add up to exactly zero. -/
theorem quantizeBalancedBookValues_exact_total_zero {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    exactTotalRat exactValues = 0 := by
  obtain ⟨_, -, -, hzero, -, -⟩ := balanced_view hv h
  exact hzero

/-- The rounded book values and the rounding posting, when there is one, add up to exactly
zero. -/
theorem quantizeBalancedBookValues_balanced {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    bookValueTotalRat bookValues + roundingPostingRat roundingPosting = 0 := by
  obtain ⟨quantized, hbv, -, -, -, hround⟩ := balanced_view hv h
  rw [hbv, bookValueTotalRat_map]
  rcases hround with ⟨hz, hnone⟩ | ⟨-, rounding, -, -, hrt, -, hsome⟩
  · rw [hnone, hz]
    simp [roundingPostingRat]
  · rw [hsome]
    simp [roundingPostingRat, hrt]

/-- The total of what is returned, rounding posting included, is exactly the total of the
exact values. -/
theorem quantizeBalancedBookValues_total_eq_exact_total {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    bookValueTotalRat bookValues + roundingPostingRat roundingPosting =
      exactTotalRat exactValues := by
  rw [quantizeBalancedBookValues_balanced hv h, quantizeBalancedBookValues_exact_total_zero hv h]

/-- The rounding posting is exactly what rounding took away: the total of the exact values
less the total of the rounded book values. -/
theorem quantizeBalancedBookValues_rounding_eq_residual {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    roundingPostingRat roundingPosting =
      exactTotalRat exactValues - bookValueTotalRat bookValues := by
  have e := quantizeBalancedBookValues_total_eq_exact_total hv h
  linarith

/-! ## Law 2: each value, the rounding posting, and the order -/

/-- A relation that holds along two lists still holds when it is weakened for the members of
the first. -/
private theorem forall₂_imp_of_mem {α β : Type} {R S : α → β → Prop} {xs : List α}
    {ys : List β} (h : List.Forall₂ R xs ys) (himp : ∀ x ∈ xs, ∀ y, R x y → S x y) :
    List.Forall₂ S xs ys := by
  induction h with
  | nil => exact List.Forall₂.nil
  | @cons x y xs' ys' hhead _ ih =>
    exact List.Forall₂.cons (himp x (by simp) y hhead)
      (ih fun a hm b hr => himp a (by simp [hm]) b hr)

/-- There is one book value for each exact value, in the same order: the amount `quantize`
gives for that value, in the functional commodity that was asked for. -/
theorem quantizeBalancedBookValues_values {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    List.Forall₂ (fun value bookValue => ∃ quantizedValue,
      quantize value policy.rule = .ok quantizedValue ∧
        bookValue = ⟨quantizedValue.amount, functionalCommodityId⟩) exactValues bookValues := by
  obtain ⟨-, quantized, -, -, -, -, -, -, -, hq, -, hbv, -⟩ :=
    quantizeBalancedBookValues_quantized h
  rw [hbv, List.forall₂_map_right_iff]
  exact (quantizeAmounts_ok hq).imp fun value amount ⟨quantizedValue, hqv, ha⟩ =>
    ⟨quantizedValue, hqv, by rw [ha]⟩

/-- As many book values are returned as exact values were given. -/
theorem quantizeBalancedBookValues_length {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    bookValues.length = exactValues.length :=
  (quantizeBalancedBookValues_values h).length_eq.symm

/-- Every returned book value is in the policy's functional commodity, at the policy's scale,
and is a constructible amount. -/
theorem quantizeBalancedBookValues_book_value {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    ∀ bookValue ∈ bookValues,
      bookValue.functionalCommodityId = policy.functionalCommodityId ∧
        bookValue.amount.WF ∧ bookValue.amount.scale = policy.targetScale := by
  obtain ⟨-, -, -, -, -, -, hcommodity, -⟩ := quantizeBalancedBookValues_quantized h
  obtain ⟨quantized, hbv, -, -, hawf, -⟩ := balanced_view hv h
  intro bookValue hm
  rw [hbv] at hm
  obtain ⟨amount, ham, rfl⟩ := List.mem_map.mp hm
  exact ⟨hcommodity.symm, hawf amount ham⟩

/-- Each returned book value is less than one unit of the policy's scale away from its exact
value. -/
theorem quantizeBalancedBookValues_within_one_unit {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    List.Forall₂ (fun value bookValue =>
      |bookValue.amount.toRat - value.toRat| < policy.rule.unit) exactValues bookValues :=
  forall₂_imp_of_mem (quantizeBalancedBookValues_values h)
    fun value hm bookValue ⟨_, hq, hb⟩ => by
      rw [hb]
      exact quantize_within_one_unit (hv value hm) hq

/-- In the two half modes each returned book value is at most half a unit of the policy's
scale away from its exact value. -/
theorem quantizeBalancedBookValues_within_half_unit {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting))
    (hm : policy.roundingMode = .halfEven ∨ policy.roundingMode = .halfAwayFromZero) :
    List.Forall₂ (fun value bookValue =>
      |bookValue.amount.toRat - value.toRat| ≤ policy.rule.unit / 2) exactValues bookValues :=
  forall₂_imp_of_mem (quantizeBalancedBookValues_values h)
    fun value hmem bookValue ⟨_, hq, hb⟩ => by
      rw [hb]
      exact quantize_within_half_unit (hv value hmem) hq hm

/-- When each book value is at most a bound away from its exact value, the two totals are at
most as many bounds apart as there are values. -/
private theorem abs_total_sub_le {bound : ℚ} {values : List ExactRational}
    {bookValues : List BookValue}
    (h : List.Forall₂ (fun value bookValue => |bookValue.amount.toRat - value.toRat| ≤ bound)
      values bookValues) :
    |bookValueTotalRat bookValues - exactTotalRat values| ≤ values.length * bound := by
  induction h with
  | nil => simp [bookValueTotalRat, exactTotalRat]
  | @cons value bookValue values' bookValues' hhead _ ih =>
    simp only [bookValueTotalRat, exactTotalRat, List.map_cons, List.sum_cons,
      List.length_cons] at ih ⊢
    have b₁ := abs_le.mp hhead
    have b₂ := abs_le.mp ih
    push_cast
    exact abs_le.mpr ⟨by linarith [b₁.1, b₂.1], by linarith [b₁.2, b₂.2]⟩

/-- When each of one or more book values is less than a bound away from its exact value, the
two totals are less than as many bounds apart as there are values. -/
private theorem abs_total_sub_lt {bound : ℚ} {values : List ExactRational}
    {bookValues : List BookValue}
    (h : List.Forall₂ (fun value bookValue => |bookValue.amount.toRat - value.toRat| < bound)
      values bookValues) (hne : values ≠ []) :
    |bookValueTotalRat bookValues - exactTotalRat values| < values.length * bound := by
  cases h with
  | nil => exact absurd rfl hne
  | @cons value bookValue values' bookValues' hhead htail =>
    have ih := abs_total_sub_le (htail.imp fun _ _ hlt => hlt.le)
    simp only [bookValueTotalRat, exactTotalRat, List.map_cons, List.sum_cons,
      List.length_cons] at ih ⊢
    have b₁ := abs_lt.mp hhead
    have b₂ := abs_le.mp ih
    push_cast
    exact abs_lt.mpr ⟨by linarith [b₁.1, b₂.1], by linarith [b₁.2, b₂.2]⟩

/-- There is no rounding posting exactly when the rounded book values add up to zero. -/
theorem quantizeBalancedBookValues_rounding_none_iff {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    roundingPosting = none ↔ bookValueTotalRat bookValues = 0 := by
  obtain ⟨quantized, hbv, -, -, -, hround⟩ := balanced_view hv h
  rw [hbv, bookValueTotalRat_map]
  rcases hround with ⟨hz, hnone⟩ | ⟨hne, rounding, -, -, -, -, hsome⟩
  · exact ⟨fun _ => hz, fun _ => hnone⟩
  · rw [hsome]
    exact ⟨fun hc => (nomatch hc), fun hc => absurd hc hne⟩

/-- A rounding posting is in the policy's rounding account and functional commodity, at the
policy's scale, is not zero, and is exactly the total of the rounded book values with its sign
changed. -/
theorem quantizeBalancedBookValues_rounding_posting {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {posting : RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues (some posting))) :
    posting.accountId = policy.roundingAccountId ∧
      posting.bookValue.functionalCommodityId = policy.functionalCommodityId ∧
      posting.bookValue.amount.WF ∧ posting.bookValue.amount.scale = policy.targetScale ∧
      posting.bookValue.amount.toRat = -bookValueTotalRat bookValues ∧
      posting.bookValue.amount.toRat ≠ 0 := by
  obtain ⟨-, -, -, -, -, -, hcommodity, -⟩ := quantizeBalancedBookValues_quantized h
  obtain ⟨quantized, hbv, -, -, -, hround⟩ := balanced_view hv h
  rw [hbv, bookValueTotalRat_map]
  rcases hround with ⟨-, hnone⟩ | ⟨hne, rounding, hrwf, hrs, hrt, -, hsome⟩
  · cases hnone
  · cases hsome
    exact ⟨rfl, hcommodity.symm, hrwf, hrs, hrt, by
      show rounding.toRat ≠ 0
      rw [hrt]
      exact neg_ne_zero.mpr hne⟩

/-- The rounding posting is at most as many units of the policy's scale as there are
values. -/
theorem quantizeBalancedBookValues_rounding_le_units {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) :
    |roundingPostingRat roundingPosting| ≤ exactValues.length * policy.rule.unit := by
  have hb := abs_total_sub_le
    ((quantizeBalancedBookValues_within_one_unit hv h).imp fun _ _ hlt => hlt.le)
  rw [quantizeBalancedBookValues_rounding_eq_residual hv h, abs_sub_comm]
  exact hb

/-- In the two half modes the rounding posting is at most half as many units of the policy's
scale as there are values. -/
theorem quantizeBalancedBookValues_rounding_le_half_units {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting))
    (hm : policy.roundingMode = .halfEven ∨ policy.roundingMode = .halfAwayFromZero) :
    |roundingPostingRat roundingPosting| ≤ exactValues.length * (policy.rule.unit / 2) := by
  have hb := abs_total_sub_le (quantizeBalancedBookValues_within_half_unit hv h hm)
  rw [quantizeBalancedBookValues_rounding_eq_residual hv h, abs_sub_comm]
  exact hb

/-- The sharper bound: a rounding posting is a whole number of units of the policy's scale,
and at most one unit fewer than there are values. -/
theorem quantizeBalancedBookValues_rounding_le_pred_units {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {posting : RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues (some posting))) :
    posting.bookValue.amount.toRat = posting.bookValue.amount.coefficient * policy.rule.unit ∧
      |posting.bookValue.amount.coefficient| ≤ (exactValues.length : Int) - 1 ∧
      |posting.bookValue.amount.toRat| ≤ ((exactValues.length : ℚ) - 1) * policy.rule.unit := by
  obtain ⟨-, -, -, hs, hrt, hne⟩ := quantizeBalancedBookValues_rounding_posting hv h
  have hexact := quantizeBalancedBookValues_exact_total_zero hv h
  have hunit : posting.bookValue.amount.toRat =
      posting.bookValue.amount.coefficient * policy.rule.unit :=
    amount_eq_mul_unit (rule := policy.rule) hs
  have hnonempty : exactValues ≠ [] := by
    rintro rfl
    have hlen := quantizeBalancedBookValues_length h
    rw [List.length_nil, List.length_eq_zero_iff] at hlen
    rw [hlen] at hrt
    exact hne (by rw [hrt]; simp [bookValueTotalRat])
  have hlt := abs_total_sub_lt (quantizeBalancedBookValues_within_one_unit hv h) hnonempty
  rw [hexact, sub_zero, ← abs_neg, ← hrt, hunit, abs_mul,
    abs_of_pos policy.rule.unit_pos] at hlt
  have hq : |(posting.bookValue.amount.coefficient : ℚ)| < (exactValues.length : ℚ) :=
    lt_of_mul_lt_mul_right hlt policy.rule.unit_pos.le
  have hz : |posting.bookValue.amount.coefficient| < (exactValues.length : Int) := by
    exact_mod_cast hq
  have hle : |posting.bookValue.amount.coefficient| ≤ (exactValues.length : Int) - 1 := by
    omega
  refine ⟨hunit, hle, ?_⟩
  rw [hunit, abs_mul, abs_of_pos policy.rule.unit_pos]
  have hleq : |(posting.bookValue.amount.coefficient : ℚ)| ≤ (exactValues.length : ℚ) - 1 := by
    exact_mod_cast hle
  exact mul_le_mul_of_nonneg_right hleq policy.rule.unit_pos.le

/-- No value, or one value, never needs a rounding posting. -/
theorem quantizeBalancedBookValues_no_rounding_of_length_le_one
    {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {bookValues : List BookValue} {roundingPosting : Option RoundingPosting}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.quantized bookValues roundingPosting)) (hlen : exactValues.length ≤ 1) :
    roundingPosting = none := by
  cases roundingPosting with
  | none => rfl
  | some posting =>
    obtain ⟨-, -, -, -, -, hne⟩ := quantizeBalancedBookValues_rounding_posting hv h
    obtain ⟨hunit, hle, -⟩ := quantizeBalancedBookValues_rounding_le_pred_units hv h
    have hzero : posting.bookValue.amount.coefficient = 0 := by
      have hnn := abs_nonneg posting.bookValue.amount.coefficient
      have hl : (exactValues.length : Int) ≤ 1 := by exact_mod_cast hlen
      exact abs_eq_zero.mp (by omega)
    exact absurd (by rw [hunit, hzero]; simp) hne

/-- The sharper bound is reached. Rounded down at scale 0, the three values 2/3, 2/3 and -4/3
give 0, 0 and -2, so the rounding posting is 2: one unit fewer than there are values. -/
example : roundedCoefficient 2 3 .floor + roundedCoefficient 2 3 .floor +
    roundedCoefficient (-4) 3 .floor = -2 := by decide

/-- In a half mode the bound is reached to the whole unit. With half away from zero at scale 0,
the three values 1/2, 1/2 and -1 give 1, 1 and -1, so the rounding posting is -1. -/
example : roundedCoefficient 1 2 .halfAwayFromZero + roundedCoefficient 1 2 .halfAwayFromZero +
    roundedCoefficient (-1) 1 .halfAwayFromZero = 1 := by decide

/-! ## Law 3: every rejection is for a stated reason -/

/-- A policy whose scale is outside 0 to `maxDecimalScale` is rejected as an invalid exact
number, whatever else is wrong. -/
theorem quantizeBalancedBookValues_scale_rejected (exactValues : List ExactRational)
    (bookId : BookId) (functionalCommodityId : CommodityId) {policy : QuantizationPolicy}
    (hscale : policy.targetScale < 0 ∨ maxDecimalScale < policy.targetScale) :
    quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.rejected [balancedScaleDiagnostic]) := by
  unfold quantizeBalancedBookValues
  rw [ite_eq_left hscale]

/-- A policy with an admitted scale that belongs to another book or another commodity is
rejected as a book isolation violation, whatever the values are. -/
theorem quantizeBalancedBookValues_isolation_rejected (exactValues : List ExactRational)
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    (h0 : 0 ≤ policy.targetScale) (h1 : policy.targetScale ≤ maxDecimalScale)
    (hother : policy.bookId ≠ bookId ∨ policy.functionalCommodityId ≠ functionalCommodityId) :
    quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.rejected [balancedIsolationDiagnostic]) := by
  unfold quantizeBalancedBookValues
  rw [ite_eq_right (by omega), ite_eq_left hother]

/-- A policy for another book or another commodity is always rejected: for its scale when
that is not admitted, as a book isolation violation otherwise. -/
theorem quantizeBalancedBookValues_other_book_or_commodity (exactValues : List ExactRational)
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    (hother : policy.bookId ≠ bookId ∨ policy.functionalCommodityId ≠ functionalCommodityId) :
    quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
        .ok (.rejected [balancedScaleDiagnostic]) ∨
      quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
        .ok (.rejected [balancedIsolationDiagnostic]) := by
  by_cases hscale : policy.targetScale < 0 ∨ maxDecimalScale < policy.targetScale
  · exact Or.inl (quantizeBalancedBookValues_scale_rejected _ _ _ hscale)
  · exact Or.inr (quantizeBalancedBookValues_isolation_rejected _ (by omega) (by omega) hother)

/-- With an admitted scale and the policy of this book and commodity, values whose total was
computed and is not the value zero are rejected as a journal imbalance. -/
theorem quantizeBalancedBookValues_imbalance_rejected {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {exactTotal : ExactRational}
    (h0 : 0 ≤ policy.targetScale) (h1 : policy.targetScale ≤ maxDecimalScale)
    (hbook : policy.bookId = bookId)
    (hcommodity : policy.functionalCommodityId = functionalCommodityId)
    (htotal : addExactValues ExactRational.zero exactValues = .ok exactTotal)
    (hzero : exactTotal.isZero = false) :
    quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.rejected [balancedImbalanceDiagnostic]) := by
  unfold quantizeBalancedBookValues
  rw [ite_eq_right (by omega), ite_eq_right (by simp [hbook, hcommodity]), htotal]
  simp only [liftExact]
  rw [ite_eq_left hzero]

/-- Exactly when values are rejected, and with what: for the policy's scale; or, the scale
admitted, for a policy of another book or commodity; or, both passed, for a total that was
computed and is not the value zero; each time with the one diagnostic of that reason. -/
theorem quantizeBalancedBookValues_rejected_iff {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {diagnostics : List SemanticDiagnostic} :
    quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
        .ok (.rejected diagnostics) ↔
      ((policy.targetScale < 0 ∨ maxDecimalScale < policy.targetScale) ∧
        diagnostics = [balancedScaleDiagnostic]) ∨
      (0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
        (policy.bookId ≠ bookId ∨ policy.functionalCommodityId ≠ functionalCommodityId) ∧
        diagnostics = [balancedIsolationDiagnostic]) ∨
      (0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
        policy.bookId = bookId ∧ policy.functionalCommodityId = functionalCommodityId ∧
        (∃ exactTotal, addExactValues ExactRational.zero exactValues = .ok exactTotal ∧
          exactTotal.isZero = false) ∧
        diagnostics = [balancedImbalanceDiagnostic]) := by
  constructor
  · intro h
    unfold quantizeBalancedBookValues at h
    split at h
    · rename_i hscale
      cases h
      exact Or.inl ⟨hscale, rfl⟩
    · rename_i hscale
      have h0 : 0 ≤ policy.targetScale := by omega
      have h1 : policy.targetScale ≤ maxDecimalScale := by omega
      split at h
      · rename_i hother
        cases h
        exact Or.inr (Or.inl ⟨h0, h1, hother, rfl⟩)
      · rename_i hother
        simp only [not_or, not_not] at hother
        split at h
        · cases h
        · rename_i exactTotal hexact
          split at h
          · rename_i hzero
            cases h
            exact Or.inr (Or.inr ⟨h0, h1, hother.1, hother.2,
              ⟨exactTotal, liftExact_eq_ok hexact, hzero⟩, rfl⟩)
          · split at h
            · cases h
            · split at h
              · cases h
              · split at h
                · cases h
                · split at h <;> cases h
  · rintro (⟨hscale, rfl⟩ | ⟨h0, h1, hother, rfl⟩ | ⟨h0, h1, hbook, hcommodity, ⟨_, ht, hz⟩, rfl⟩)
    · exact quantizeBalancedBookValues_scale_rejected _ _ _ hscale
    · exact quantizeBalancedBookValues_isolation_rejected _ h0 h1 hother
    · exact quantizeBalancedBookValues_imbalance_rejected h0 h1 hbook hcommodity ht hz

/-- A rejection carries exactly one diagnostic, and it is one of the three. -/
theorem quantizeBalancedBookValues_rejected_diagnostic {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {diagnostics : List SemanticDiagnostic}
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
      .ok (.rejected diagnostics)) :
    diagnostics = [balancedScaleDiagnostic] ∨ diagnostics = [balancedIsolationDiagnostic] ∨
      diagnostics = [balancedImbalanceDiagnostic] := by
  rcases quantizeBalancedBookValues_rejected_iff.mp h with
    ⟨-, hd⟩ | ⟨-, -, -, hd⟩ | ⟨-, -, -, -, -, hd⟩
  · exact Or.inl hd
  · exact Or.inr (Or.inl hd)
  · exact Or.inr (Or.inr hd)

/-- Values are rejected as a journal imbalance exactly when the scale is admitted, the policy
is of this book and commodity, the total of the exact values was computed, and it is not
zero. -/
theorem quantizeBalancedBookValues_imbalance_iff {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    (hv : ∀ value ∈ exactValues, value.WF) :
    quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
        .ok (.rejected [balancedImbalanceDiagnostic]) ↔
      (0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
        policy.bookId = bookId ∧ policy.functionalCommodityId = functionalCommodityId ∧
        (∃ exactTotal, addExactValues ExactRational.zero exactValues = .ok exactTotal) ∧
        exactTotalRat exactValues ≠ 0) := by
  have hmeaning : ∀ exactTotal, addExactValues ExactRational.zero exactValues = .ok exactTotal →
      (exactTotal.isZero = false ↔ exactTotalRat exactValues ≠ 0) := by
    intro exactTotal ht
    obtain ⟨hwf, htr⟩ := addExactValues_ok ExactRational.zero_wf hv ht
    rw [ExactRational.zero_toRat, zero_add] at htr
    rw [← htr, ← Bool.not_eq_true, ExactRational.isZero_iff hwf]
  rw [quantizeBalancedBookValues_rejected_iff]
  constructor
  · rintro (⟨-, hd⟩ | ⟨-, -, -, hd⟩ | ⟨h0, h1, hbook, hcommodity, ⟨exactTotal, ht, hz⟩, -⟩)
    · exact absurd hd (by decide)
    · exact absurd hd (by decide)
    · exact ⟨h0, h1, hbook, hcommodity, ⟨exactTotal, ht⟩, (hmeaning exactTotal ht).mp hz⟩
  · rintro ⟨h0, h1, hbook, hcommodity, ⟨exactTotal, ht⟩, hne⟩
    exact Or.inr (Or.inr ⟨h0, h1, hbook, hcommodity,
      ⟨exactTotal, ht, (hmeaning exactTotal ht).mpr hne⟩, rfl⟩)

/-! ## When it throws instead -/

/-- `liftExact` fails exactly when the operation of `numeric.ts` failed, with its code. -/
private theorem liftExact_eq_error {α : Type} {result : Except NumErr α} {e : QuantizeErr}
    (h : liftExact result = .error e) : ∃ code, result = .error code ∧ e = .exactNumber code := by
  cases result with
  | error code => cases h; exact ⟨code, rfl, rfl⟩
  | ok v => cases h

/-- At an admitted scale `ExactDecimal.of` fails only for the size of the coefficient. -/
private theorem decimal_of_error {coefficient scale : Int} {code : NumErr} (h0 : 0 ≤ scale)
    (h1 : scale ≤ maxDecimalScale) (h : ExactDecimal.of coefficient scale = .error code) :
    code = .representationLimitExceeded := by
  have hlimit := (ExactDecimal.of_eq_limit_iff coefficient scale).mpr
  by_cases hw : withinMagnitude coefficient = true
  · rw [(ExactDecimal.of_eq_ok_iff coefficient scale ⟨coefficient, scale⟩).mpr
      ⟨h0, h1, hw, rfl⟩] at h
    cases h
  · rw [hlimit ⟨h0, h1, hw⟩] at h
    cases h
    rfl

/-- When rounding a constructible value at an admitted scale throws, it is for size. -/
theorem quantize_error {value : ExactRational} {rule : QuantizationRule} {e : QuantizeErr}
    (hv : value.WF) (h0 : 0 ≤ rule.targetScale) (h1 : rule.targetScale ≤ maxDecimalScale)
    (h : quantize value rule = .error e) : e = .exactNumber .representationLimitExceeded := by
  simp only [quantize] at h
  split at h
  · omega
  · split at h
    · rename_i _ e' hof
      cases h
      obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
      rw [decimal_of_error h0 h1 hcode]
    · rename_i _ amount hof
      obtain ⟨hawf, -, -⟩ := ExactDecimal.of_ok (liftExact_eq_ok hof)
      split at h
      · rename_i _ e' hto
        obtain ⟨code, hcode, -⟩ := liftExact_eq_error hto
        exact absurd hcode (ExactDecimal.toRational_ne_error hawf code)
      · rename_i _ amountRational hto
        obtain ⟨harwf, -⟩ := ExactDecimal.toRational_ok hawf (liftExact_eq_ok hto)
        split at h
        · rename_i _ e' hsub
          cases h
          obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hsub
          rcases ExactRational.subtract_ok_or_limit hv harwf with ⟨c, hc⟩ | hlimit
          · rw [hc] at hcode
            cases hcode
          · rw [hlimit] at hcode
            cases hcode
            rfl
        · cases h

/-- When adding up constructible exact values throws, it is for size. -/
theorem addExactValues_error {values : List ExactRational} :
    ∀ {total : ExactRational} {code : NumErr}, total.WF → (∀ value ∈ values, value.WF) →
      addExactValues total values = .error code → code = .representationLimitExceeded := by
  induction values with
  | nil =>
    intro total code _ _ h
    cases h
  | cons value rest ih =>
    intro total code ht hv h
    simp only [addExactValues] at h
    split at h
    · rename_i code' hadd
      cases h
      rcases ExactRational.add_ok_or_limit ht (hv value (by simp)) with ⟨c, hc⟩ | hlimit
      · rw [hc] at hadd
        cases hadd
      · rw [hlimit] at hadd
        cases hadd
        rfl
    · rename_i next hnext
      obtain ⟨hnwf, -⟩ := ExactRational.add_ok ht (hv value (by simp)) hnext
      exact ih hnwf (fun v hm => hv v (by simp [hm])) h

/-- When rounding a list of constructible values at an admitted scale throws, it is for
size. -/
theorem quantizeAmounts_error {rule : QuantizationRule} {values : List ExactRational}
    (h0 : 0 ≤ rule.targetScale) (h1 : rule.targetScale ≤ maxDecimalScale) :
    ∀ {e : QuantizeErr}, (∀ value ∈ values, value.WF) →
      quantizeAmounts rule values = .error e → e = .exactNumber .representationLimitExceeded := by
  induction values with
  | nil =>
    intro e _ h
    cases h
  | cons value rest ih =>
    intro e hv h
    simp only [quantizeAmounts] at h
    split at h
    · rename_i e' hq
      cases h
      exact quantize_error (hv value (by simp)) h0 h1 hq
    · split at h
      · rename_i e' hrest
        cases h
        exact ih (fun v hm => hv v (by simp [hm])) hrest
      · cases h

/-- When adding up constructible amounts throws, it is for size. -/
theorem addAmounts_error {amounts : List ExactDecimal} :
    ∀ {total : ExactRational} {code : NumErr}, total.WF → (∀ amount ∈ amounts, amount.WF) →
      addAmounts total amounts = .error code → code = .representationLimitExceeded := by
  induction amounts with
  | nil =>
    intro total code _ _ h
    cases h
  | cons amount rest ih =>
    intro total code ht ha h
    simp only [addAmounts] at h
    split at h
    · rename_i code' hto
      exact absurd hto (ExactDecimal.toRational_ne_error (ha amount (by simp)) code')
    · rename_i amountRational hto
      obtain ⟨harwf, -⟩ := ExactDecimal.toRational_ok (ha amount (by simp)) hto
      split at h
      · rename_i code' hadd
        cases h
        rcases ExactRational.add_ok_or_limit ht harwf with ⟨c, hc⟩ | hlimit
        · rw [hc] at hadd
          cases hadd
        · rw [hlimit] at hadd
          cases hadd
          rfl
      · rename_i next hnext
        obtain ⟨hnwf, -⟩ := ExactRational.add_ok ht harwf hnext
        exact ih hnwf (fun a hm => ha a (by simp [hm])) h

/-- When rounding constructible values to balance throws, the policy had passed both checks
and a number went beyond the size limit; it never throws for the scale. -/
theorem quantizeBalancedBookValues_error {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    {e : QuantizeErr} (hv : ∀ value ∈ exactValues, value.WF)
    (h : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy = .error e) :
    e = .exactNumber .representationLimitExceeded ∧
      0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
      policy.bookId = bookId ∧ policy.functionalCommodityId = functionalCommodityId := by
  unfold quantizeBalancedBookValues at h
  split at h
  · cases h
  · rename_i hscale
    have h0 : 0 ≤ policy.targetScale := by omega
    have h1 : policy.targetScale ≤ maxDecimalScale := by omega
    split at h
    · cases h
    · rename_i hother
      simp only [not_or, not_not] at hother
      refine ⟨?_, h0, h1, hother.1, hother.2⟩
      split at h
      · rename_i e' hexact
        cases h
        obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hexact
        rw [addExactValues_error ExactRational.zero_wf hv hcode]
      · split at h
        · cases h
        · split at h
          · rename_i e' hq
            cases h
            exact quantizeAmounts_error (rule := policy.rule) h0 h1 hv hq
          · rename_i quantized hq
            have hawf := amounts_wf hv (quantizeAmounts_ok hq)
            split at h
            · rename_i e' hqt
              cases h
              obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hqt
              rw [addAmounts_error ExactRational.zero_wf (fun a hm => (hawf a hm).1) hcode]
            · rename_i quantizedTotal hqt
              obtain ⟨hqtwf, -⟩ := addAmounts_ok ExactRational.zero_wf
                (fun a hm => (hawf a hm).1) (liftExact_eq_ok hqt)
              split at h
              · cases h
              · split at h
                · rename_i e' hr
                  cases h
                  exact quantize_error (rule := policy.rule) (ExactRational.negate_wf hqtwf)
                    h0 h1 hr
                · cases h

/-- Completeness: with an admitted scale and the policy of this book and commodity,
constructible values that add up to zero are rounded and returned, unless a number went beyond
the size limit on the way. -/
theorem quantizeBalancedBookValues_complete {exactValues : List ExactRational}
    {bookId : BookId} {functionalCommodityId : CommodityId} {policy : QuantizationPolicy}
    (hv : ∀ value ∈ exactValues, value.WF)
    (h0 : 0 ≤ policy.targetScale) (h1 : policy.targetScale ≤ maxDecimalScale)
    (hbook : policy.bookId = bookId)
    (hcommodity : policy.functionalCommodityId = functionalCommodityId)
    (hzero : exactTotalRat exactValues = 0) :
    (∃ bookValues roundingPosting,
        quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
          .ok (.quantized bookValues roundingPosting)) ∨
      quantizeBalancedBookValues exactValues bookId functionalCommodityId policy =
        .error (.exactNumber .representationLimitExceeded) := by
  cases hresult : quantizeBalancedBookValues exactValues bookId functionalCommodityId policy with
  | error e =>
    right
    rw [(quantizeBalancedBookValues_error hv hresult).1]
  | ok result =>
    cases result with
    | quantized bookValues roundingPosting => exact Or.inl ⟨bookValues, roundingPosting, rfl⟩
    | rejected diagnostics =>
      exfalso
      rcases quantizeBalancedBookValues_rejected_iff.mp hresult with
        ⟨hscale, -⟩ | ⟨-, -, hother, -⟩ | ⟨-, -, -, -, ⟨exactTotal, ht, hz⟩, -⟩
      · omega
      · rcases hother with hother | hother
        · exact hother hbook
        · exact hother hcommodity
      · obtain ⟨hwf, htr⟩ := addExactValues_ok ExactRational.zero_wf hv ht
        rw [ExactRational.zero_toRat, zero_add, hzero] at htr
        rw [(ExactRational.isZero_iff hwf).mpr htr] at hz
        cases hz

/-! ## Law 4: the hash of a policy -/

/-- Two rounding modes written the same are the same mode. -/
theorem RoundingMode.text_injective {a b : RoundingMode} (h : a.text = b.text) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The record that is hashed holds every field of the policy: two policies with the same
record are the same policy. -/
theorem canonicalQuantizationPolicyValue_injective {p q : QuantizationPolicy}
    (h : canonicalQuantizationPolicyValue p = canonicalQuantizationPolicyValue q) : p = q := by
  obtain ⟨⟨pid⟩, ⟨pversion⟩, ⟨pbook⟩, ⟨pcommodity⟩, ⟨pfrom⟩, pto, pscale, pmode, ⟨paccount⟩⟩ := p
  obtain ⟨⟨qid⟩, ⟨qversion⟩, ⟨qbook⟩, ⟨qcommodity⟩, ⟨qfrom⟩, qto, qscale, qmode, ⟨qaccount⟩⟩ := q
  simp only [canonicalQuantizationPolicyValue, quantizationPolicyEntries,
    CanonicalValue.record.injEq, List.cons.injEq,
    Prod.mk.injEq, CanonicalValue.string.injEq, CanonicalValue.int.injEq, true_and,
    and_true] at h
  obtain ⟨hid, hversion, hbook, hcommodity, hfrom, hto, hscale, hmode, haccount⟩ := h
  have hto' : pto = qto := by
    cases pto with
    | none =>
      cases qto with
      | none => rfl
      | some qdate => cases hto
    | some pdate =>
      cases qto with
      | none => cases hto
      | some qdate =>
        obtain ⟨pvalue⟩ := pdate
        obtain ⟨qvalue⟩ := qdate
        simp only [CanonicalValue.string.injEq] at hto
        rw [hto]
  rw [hid, hversion, hbook, hcommodity, hfrom, hto', hscale, RoundingMode.text_injective hmode,
    haccount]

/-- Entries that are the same up to the order inside nested records have the same keys in the
same order. -/
private theorem equivEntries_keys :
    ∀ {zs ys : List (String × CanonicalValue)}, CanonicalValue.EquivEntries zs ys →
      zs.map Prod.fst = ys.map Prod.fst
  | [], [], _ => rfl
  | [], _ :: _, h => by simp [CanonicalValue.EquivEntries] at h
  | _ :: _, [], h => by simp [CanonicalValue.EquivEntries] at h
  | (k₁, v₁) :: zs, (k₂, v₂) :: ys, h => by
    simp only [CanonicalValue.EquivEntries] at h
    rw [List.map_cons, List.map_cons, h.1, equivEntries_keys h.2.2]

/-- A reordering of entries with distinct keys that leaves the keys in the same order is no
reordering. -/
private theorem perm_eq_of_keys {xs zs : List (String × CanonicalValue)} (hp : xs.Perm zs)
    (hn : (xs.map Prod.fst).Nodup) (hk : xs.map Prod.fst = zs.map Prod.fst) : xs = zs := by
  induction xs generalizing zs with
  | nil => exact hp.nil_eq
  | cons x xs ih =>
    cases zs with
    | nil => simp at hk
    | cons z zs =>
      simp only [List.map_cons, List.cons.injEq] at hk
      have hz : z ∈ x :: xs := hp.symm.subset (by simp)
      have hxz : x = z := by
        rcases List.mem_cons.mp hz with hhead | htail
        · exact hhead.symm
        · exfalso
          have hmem : x.1 ∈ xs.map Prod.fst := by
            rw [hk.1]
            exact List.mem_map.mpr ⟨z, htail, rfl⟩
          exact (List.nodup_cons.mp hn).1 hmem
      subst hxz
      rw [ih (List.Perm.cons_inv hp) (List.nodup_cons.mp hn).2 hk.2]

/-- The keys of the hashed record, in the order of the TypeScript object literal. -/
private theorem quantizationPolicyEntries_keys (policy : QuantizationPolicy) :
    (quantizationPolicyEntries policy).map Prod.fst =
      ["type", "id", "version", "bookId", "functionalCommodityId", "validFrom", "validTo",
        "targetScale", "roundingMode", "roundingAccountId"] := rfl

/-- The hashed record has ten distinct keys and no nested record, so it is a value
`hashCanonical` is injective on. -/
theorem canonicalQuantizationPolicyValue_wf (policy : QuantizationPolicy) :
    (canonicalQuantizationPolicyValue policy).WF := by
  have hkeys : ((quantizationPolicyEntries policy).map Prod.fst).Nodup := by
    rw [quantizationPolicyEntries_keys]
    decide
  have hentries : CanonicalValue.WFEntries (quantizationPolicyEntries policy) := by
    unfold quantizationPolicyEntries
    cases policy.validTo <;> simp [CanonicalValue.WFEntries, CanonicalValue.WF]
  simpa only [canonicalQuantizationPolicyValue, CanonicalValue.WF] using And.intro hkeys hentries

/-- Two policies whose hashed records are the same up to the order of their keys are the same
policy. -/
private theorem eq_of_canonicalQuantizationPolicyValue_equiv {p q : QuantizationPolicy}
    (h : (canonicalQuantizationPolicyValue p).Equiv (canonicalQuantizationPolicyValue q)) :
    p = q := by
  simp only [canonicalQuantizationPolicyValue, CanonicalValue.Equiv] at h
  obtain ⟨zs, hperm, hentries⟩ := h
  have hkeys : (quantizationPolicyEntries p).map Prod.fst = zs.map Prod.fst := by
    rw [equivEntries_keys hentries, quantizationPolicyEntries_keys,
      quantizationPolicyEntries_keys]
  have hzs := perm_eq_of_keys hperm
    (by rw [quantizationPolicyEntries_keys]; decide) hkeys
  rw [← hzs] at hentries
  apply canonicalQuantizationPolicyValue_injective
  have hlist : quantizationPolicyEntries p = quantizationPolicyEntries q := by
    unfold quantizationPolicyEntries at hentries ⊢
    cases hp : p.validTo <;> cases hq : q.validTo <;>
      simp only [hp, hq, CanonicalValue.EquivEntries, CanonicalValue.Equiv, true_and,
        and_true, and_false, false_and] at hentries
    · obtain ⟨hid, hversion, hbook, hcommodity, hfrom, hscale, hmode, haccount⟩ := hentries
      rw [hid, hversion, hbook, hcommodity, hfrom, hscale, hmode, haccount]
    · obtain ⟨hid, hversion, hbook, hcommodity, hfrom, hto, hscale, hmode, haccount⟩ := hentries
      dsimp only
      rw [hid, hversion, hbook, hcommodity, hfrom, hto, hscale, hmode, haccount]
  rw [canonicalQuantizationPolicyValue, canonicalQuantizationPolicyValue, hlist]

/-- Two policies with the same hash are the same policy, or a SHA-256 collision is in hand. -/
theorem hashQuantizationPolicy_inj_or_collision {p q : QuantizationPolicy}
    (h : hashQuantizationPolicy p = hashQuantizationPolicy q) : p = q ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (canonicalQuantizationPolicyValue_wf p)
    (canonicalQuantizationPolicyValue_wf q) h with hequiv | hcollision
  · exact Or.inl (eq_of_canonicalQuantizationPolicyValue_equiv hequiv)
  · exact Or.inr hcollision

/-- The hash of a policy has the algorithm, the version and the digest form of every content
hash. -/
theorem hashQuantizationPolicy_wf (policy : QuantizationPolicy) :
    (hashQuantizationPolicy policy).WF :=
  hashCanonical_wf _

/-! ## `quantizeCumulativePostedShare` over the full policy is the one over its rule -/

/-- A share of the rule, given the policy and read back as a share of the rule, is the share
it was, when its rule is the policy's. -/
theorem CumulativePostedShare.toShare_withPolicy {share : CumulativePostedShare}
    {policy : QuantizationPolicy} (h : share.rule = policy.rule) :
    (share.withPolicy policy).toShare = share := by
  cases share
  cases h
  rfl

/-- A share over the full policy is returned exactly when the arithmetic over the policy's
rule returns a share: it is that share, with the policy. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {share : PolicyCumulativePostedShare} :
    policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
        .ok (.quantized share) ↔
      Rastrata.Kernel.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction
          policy.rule = .ok (.quantized share.toShare) ∧ share.policy = policy := by
  unfold QuantizationPolicy.quantizeCumulativePostedShare
  constructor
  · intro h
    split at h
    · cases h
    · cases h
    · rename_i ruleShare hrule
      cases h
      obtain ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, hr⟩ :=
        quantizeCumulativePostedShare_quantized hrule
      rw [CumulativePostedShare.toShare_withPolicy hr]
      exact ⟨hrule, rfl⟩
  · rintro ⟨hrule, hpolicy⟩
    rw [hrule]
    cases share
    cases hpolicy
    rfl

/-- A share over the full policy is rejected exactly when the arithmetic over the policy's
rule rejects it, and it carries the one diagnostic of that rejection. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_rejected_iff
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {diagnostics : List SemanticDiagnostic} :
    policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
        .ok (.rejected diagnostics) ↔
      ∃ reason, Rastrata.Kernel.quantizeCumulativePostedShare postedTotal beforeFraction
          afterFraction policy.rule = .ok (.rejected reason) ∧
        diagnostics = [reason.diagnostic] := by
  unfold QuantizationPolicy.quantizeCumulativePostedShare
  constructor
  · intro h
    split at h
    · cases h
    · rename_i reason hrule
      cases h
      exact ⟨reason, hrule, rfl⟩
    · cases h
  · rintro ⟨reason, hrule, rfl⟩
    rw [hrule]

/-- A share over the full policy throws exactly when the arithmetic over the policy's rule
throws, with the same error. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_error_iff
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {e : QuantizeErr} :
    policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction = .error e ↔
      Rastrata.Kernel.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction
        policy.rule = .error e := by
  unfold QuantizationPolicy.quantizeCumulativePostedShare
  constructor
  · intro h
    split at h
    · rename_i e' hrule
      cases h
      exact hrule
    · cases h
    · cases h
  · intro hrule
    rw [hrule]

/-! ## When a share is rejected, and with which diagnostic -/

/-- The first rejection of a share, exactly: the two conversions returned, and the scale is not
admitted, or the total or the first fraction is negative, or the fractions are out of order, or
the second is above one. -/
theorem quantizeCumulativePostedShare_invalidShare_iff {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule} :
    quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
        .ok (.rejected .invalidShare) ↔
      ∃ total one, postedTotal.toRational = .ok total ∧ ExactRational.of 1 1 = .ok one ∧
        (rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale ∨
          total.isNegative = true ∨ beforeFraction.isNegative = true ∨
          afterFraction.compare beforeFraction = .lt ∨ afterFraction.compare one = .gt) := by
  unfold quantizeCumulativePostedShare
  constructor
  · intro h
    split at h
    · cases h
    · rename_i total htotal
      split at h
      · cases h
      · rename_i one hone
        split at h
        · rename_i hcheck
          exact ⟨total, one, liftExact_eq_ok htotal, liftExact_eq_ok hone, hcheck⟩
        · split at h
          · cases h
          · split at h
            · cases h
            · split at h
              · cases h
              · split at h
                · cases h
                · split at h
                  · cases h
                  · split at h
                    · cases h
                    · split at h <;> cases h
  · rintro ⟨total, one, htotal, hone, hcheck⟩
    rw [htotal]
    simp only [liftExact]
    rw [hone]
    simp only []
    rw [ite_eq_left hcheck]

/-- The second rejection of a share, exactly: every test of the first rejection passed, the
total was rounded, and rounding it left something over. -/
theorem quantizeCumulativePostedShare_totalNotRepresentable_iff {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule} :
    quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
        .ok (.rejected .totalNotRepresentable) ↔
      ∃ total one normalizedTotal,
        postedTotal.toRational = .ok total ∧ ExactRational.of 1 1 = .ok one ∧
        ¬ (rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale ∨
          total.isNegative = true ∨ beforeFraction.isNegative = true ∨
          afterFraction.compare beforeFraction = .lt ∨ afterFraction.compare one = .gt) ∧
        quantize total rule = .ok normalizedTotal ∧
        normalizedTotal.residual.isZero = false := by
  unfold quantizeCumulativePostedShare
  constructor
  · intro h
    split at h
    · cases h
    · rename_i total htotal
      split at h
      · cases h
      · rename_i one hone
        split at h
        · cases h
        · rename_i hcheck
          split at h
          · cases h
          · rename_i normalizedTotal hnormalized
            split at h
            · rename_i hresidual
              exact ⟨total, one, normalizedTotal, liftExact_eq_ok htotal, liftExact_eq_ok hone,
                hcheck, hnormalized, hresidual⟩
            · split at h
              · cases h
              · split at h
                · cases h
                · split at h
                  · cases h
                  · split at h
                    · cases h
                    · split at h <;> cases h
  · rintro ⟨total, one, normalizedTotal, htotal, hone, hcheck, hnormalized, hresidual⟩
    rw [htotal]
    simp only [liftExact]
    rw [hone]
    simp only []
    rw [ite_eq_right hcheck, hnormalized]
    simp only []
    rw [ite_eq_left hresidual]

/-- The tests of the first rejection, as numbers. -/
private theorem share_check_iff {postedTotal : ExactDecimal}
    {beforeFraction afterFraction total one : ExactRational} {rule : QuantizationRule}
    (hT : postedTotal.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (htotal : postedTotal.toRational = .ok total) (hone : ExactRational.of 1 1 = .ok one) :
    (rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale ∨
        total.isNegative = true ∨ beforeFraction.isNegative = true ∨
        afterFraction.compare beforeFraction = .lt ∨ afterFraction.compare one = .gt) ↔
      (rule.targetScale < 0 ∨ maxDecimalScale < rule.targetScale ∨
        postedTotal.toRat < 0 ∨ beforeFraction.toRat < 0 ∨
        afterFraction.toRat < beforeFraction.toRat ∨ 1 < afterFraction.toRat) := by
  obtain ⟨htwf, httr⟩ := ExactDecimal.toRational_ok hT htotal
  obtain ⟨honewf, honetr, -⟩ := ExactRational.of_ok hone
  have hone1 : one.toRat = 1 := by
    rw [honetr]
    norm_num
  rw [ExactRational.isNegative_iff htwf, ExactRational.isNegative_iff hb,
    ExactRational.compare_lt_iff ha hb, ExactRational.compare_gt_iff ha honewf, httr, hone1]

/-- The whole number one is always made. -/
private theorem one_isOk : ∃ one, ExactRational.of 1 1 = .ok one :=
  (ExactRational.of_isOk_iff 1 1).mpr
    ⟨by decide, Or.inr ⟨withinMagnitude_one, withinMagnitude_one⟩⟩

/-- A share over the full policy is rejected with the first diagnostic exactly when the scale
is not admitted, or the total or the first fraction is negative, or the fractions are out of
order, or the second is above one. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_invalid_iff
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF) :
    policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
        .ok (.rejected [shareInvalidDiagnostic]) ↔
      (policy.targetScale < 0 ∨ maxDecimalScale < policy.targetScale ∨
        postedTotal.toRat < 0 ∨ beforeFraction.toRat < 0 ∨
        afterFraction.toRat < beforeFraction.toRat ∨ 1 < afterFraction.toRat) := by
  rw [QuantizationPolicy.quantizeCumulativePostedShare_rejected_iff]
  obtain ⟨total, htotal, -, -⟩ := ExactDecimal.toRational_isOk hT
  obtain ⟨one, hone⟩ := one_isOk
  have hcheck := share_check_iff (rule := policy.rule) hT hb ha htotal hone
  constructor
  · rintro ⟨reason, hrule, hd⟩
    cases reason with
    | totalNotRepresentable => exact absurd hd (by decide)
    | invalidShare =>
      obtain ⟨total', one', htotal', hone', hc⟩ :=
        quantizeCumulativePostedShare_invalidShare_iff.mp hrule
      rw [htotal] at htotal'
      rw [hone] at hone'
      cases htotal'
      cases hone'
      exact hcheck.mp hc
  · intro hc
    exact ⟨.invalidShare,
      quantizeCumulativePostedShare_invalidShare_iff.mpr ⟨total, one, htotal, hone, hcheck.mpr hc⟩,
      rfl⟩

/-- A share over the full policy is rejected with the second diagnostic exactly when every test
of the first passed, the total was rounded, and the total is not a whole number of units of
the policy's scale. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_total_iff
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF) :
    policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
        .ok (.rejected [shareTotalDiagnostic]) ↔
      (0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
        0 ≤ postedTotal.toRat ∧ 0 ≤ beforeFraction.toRat ∧
        beforeFraction.toRat ≤ afterFraction.toRat ∧ afterFraction.toRat ≤ 1 ∧
        (∃ total normalizedTotal, postedTotal.toRational = .ok total ∧
          quantize total policy.rule = .ok normalizedTotal) ∧
        ¬ ∃ c : Int, postedTotal.toRat = c / 10 ^ policy.targetScale.toNat) := by
  rw [QuantizationPolicy.quantizeCumulativePostedShare_rejected_iff]
  obtain ⟨total, htotal, htwf, httr⟩ := ExactDecimal.toRational_isOk hT
  obtain ⟨one, hone⟩ := one_isOk
  have hcheck := share_check_iff (rule := policy.rule) hT hb ha htotal hone
  constructor
  · rintro ⟨reason, hrule, hd⟩
    cases reason with
    | invalidShare => exact absurd hd (by decide)
    | totalNotRepresentable =>
      obtain ⟨total', one', normalizedTotal, htotal', hone', hc, hnormalized, hresidual⟩ :=
        quantizeCumulativePostedShare_totalNotRepresentable_iff.mp hrule
      rw [htotal] at htotal'
      rw [hone] at hone'
      cases htotal'
      cases hone'
      have hnot := mt hcheck.mpr hc
      simp only [not_or, not_lt] at hnot
      obtain ⟨h0, h1, c₁, c₂, c₃, c₄⟩ := hnot
      refine ⟨h0, h1, c₁, c₂, c₃, c₄, ⟨total, normalizedTotal, htotal, hnormalized⟩, ?_⟩
      rintro ⟨c, hc'⟩
      have hzero := (quantize_representable htwf hnormalized (c := c)
        (by rw [httr]; exact hc')).2.2.2
      rw [hzero] at hresidual
      exact absurd hresidual (by decide)
  · rintro ⟨h0, h1, c₁, c₂, c₃, c₄, ⟨total', normalizedTotal, htotal', hnormalized⟩, hnone⟩
    rw [htotal] at htotal'
    cases htotal'
    refine ⟨.totalNotRepresentable,
      quantizeCumulativePostedShare_totalNotRepresentable_iff.mpr
        ⟨total, one, normalizedTotal, htotal, hone, ?_, hnormalized, ?_⟩, rfl⟩
    · refine mt hcheck.mp ?_
      simp only [not_or, not_lt]
      exact ⟨h0, h1, c₁, c₂, c₃, c₄⟩
    · by_contra hres
      apply hnone
      obtain ⟨-, hreswf, hs, -, hrestr⟩ := quantize_ok htwf hnormalized
      have hz := (ExactRational.isZero_iff hreswf).mp ((Bool.not_eq_false _).mp hres)
      refine ⟨normalizedTotal.amount.coefficient, ?_⟩
      have hamount : normalizedTotal.amount.toRat = postedTotal.toRat := by
        rw [← httr]
        linarith
      rw [← hamount]
      unfold ExactDecimal.toRat
      rw [hs]
      rfl

/-- A rejected share carries exactly one diagnostic, and it is one of the two. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_rejected_diagnostic
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {diagnostics : List SemanticDiagnostic}
    (h : policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
      .ok (.rejected diagnostics)) :
    diagnostics = [shareInvalidDiagnostic] ∨ diagnostics = [shareTotalDiagnostic] := by
  obtain ⟨reason, -, hd⟩ := QuantizationPolicy.quantizeCumulativePostedShare_rejected_iff.mp h
  cases reason with
  | invalidShare => exact Or.inl hd
  | totalNotRepresentable => exact Or.inr hd

/-! ## The laws of a share, over the full policy -/

/-- A share carries the policy it was computed under, and the total it was given, as a
number. -/
theorem QuantizationPolicy.cumulativeShare_policy_and_total {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {share : PolicyCumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
      .ok (.quantized share)) :
    share.policy = policy ∧ share.postedTotal.toRat = postedTotal.toRat := by
  obtain ⟨hrule, hpolicy⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  exact ⟨hpolicy, cumulativeShare_postedTotal hT hb ha hrule⟩

/-- The posted amount of a share is never negative, and is at most one unit of the policy's
scale away from the exact share of the total. -/
theorem QuantizationPolicy.cumulativeShare_nonneg_and_within_one_unit
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {share : PolicyCumulativePostedShare} (hT : postedTotal.WF)
    (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
      .ok (.quantized share)) :
    0 ≤ share.postedAmount.toRat ∧
      |share.postedAmount.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * postedTotal.toRat| ≤
        policy.rule.unit := by
  obtain ⟨hrule, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  have hnonneg := cumulativeShare_nonneg hT hb ha hrule
  have hwithin := cumulativeShare_within_one_unit hT hb ha hrule
  exact ⟨hnonneg, hwithin⟩

/-- For cumulative fractions that start at zero and end at one, the posted amounts of the
successive shares under one policy add up to the posted total exactly. -/
theorem QuantizationPolicy.cumulativeShares_sum {postedTotal : ExactDecimal}
    {policy : QuantizationPolicy} (hT : postedTotal.WF) (fraction : Nat → ExactRational)
    (share : Nat → PolicyCumulativePostedShare) (n : Nat) (hf : ∀ i, i ≤ n → (fraction i).WF)
    (h0 : (fraction 0).toRat = 0) (h1 : (fraction n).toRat = 1)
    (h : ∀ i, i < n →
      policy.quantizeCumulativePostedShare postedTotal (fraction i) (fraction (i + 1)) =
        .ok (.quantized (share i))) :
    ((List.range n).map fun i => (share i).postedAmount.toRat).sum = postedTotal.toRat := by
  have hsum := Rastrata.Kernel.cumulativeShares_sum (rule := policy.rule) hT fraction
    (fun i => (share i).toShare) n hf h0 h1
    fun i hi => (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp (h i hi)).1
  exact hsum

/-! ## When a share throws instead -/

/-- When a share of constructible numbers throws, it is for size; it never throws for the
scale, which it rejects. -/
theorem quantizeCumulativePostedShare_error {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule} {e : QuantizeErr}
    (hT : postedTotal.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold quantizeCumulativePostedShare at h
  split at h
  · rename_i e' htotal
    obtain ⟨code, hcode, -⟩ := liftExact_eq_error htotal
    exact absurd hcode (ExactDecimal.toRational_ne_error hT code)
  · rename_i total htotal
    obtain ⟨htwf, -⟩ := ExactDecimal.toRational_ok hT (liftExact_eq_ok htotal)
    split at h
    · rename_i e' hone
      obtain ⟨code, hcode, -⟩ := liftExact_eq_error hone
      obtain ⟨one, hone'⟩ := one_isOk
      rw [hone'] at hcode
      cases hcode
    · split at h
      · cases h
      · rename_i hcheck
        have hc₁ := (not_or.mp hcheck).1
        have hc₂ := (not_or.mp (not_or.mp hcheck).2).1
        have h0 : 0 ≤ rule.targetScale := by omega
        have h1 : rule.targetScale ≤ maxDecimalScale := by omega
        have hmultiply : ∀ {fraction : ExactRational} {code : NumErr}, fraction.WF →
            total.multiply fraction = .error code → code = .representationLimitExceeded := by
          intro fraction code hf hm
          rcases ExactRational.multiply_ok_or_limit htwf hf with ⟨c, hc⟩ | hlimit
          · rw [hc] at hm
            cases hm
          · rw [hlimit] at hm
            cases hm
            rfl
        split at h
        · rename_i e' hq
          cases h
          exact quantize_error htwf h0 h1 hq
        · split at h
          · cases h
          · split at h
            · rename_i e' hm
              cases h
              obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hm
              rw [hmultiply hb hcode]
            · rename_i beforeTarget hbt
              obtain ⟨hbtwf, -⟩ := ExactRational.multiply_ok htwf hb (liftExact_eq_ok hbt)
              split at h
              · rename_i e' hm
                cases h
                obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hm
                rw [hmultiply ha hcode]
              · rename_i afterTarget hat
                obtain ⟨hatwf, -⟩ := ExactRational.multiply_ok htwf ha (liftExact_eq_ok hat)
                split at h
                · rename_i e' hq
                  cases h
                  exact quantize_error hbtwf h0 h1 hq
                · split at h
                  · rename_i e' hq
                    cases h
                    exact quantize_error hatwf h0 h1 hq
                  · split at h
                    · rename_i e' hof
                      cases h
                      obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
                      rw [decimal_of_error h0 h1 hcode]
                    · cases h

/-- Completeness: under a policy with an admitted scale, a total that is not negative and is a
whole number of units, with fractions in order between zero and one, gets its share, unless a
number went beyond the size limit on the way. -/
theorem QuantizationPolicy.quantizeCumulativePostedShare_complete
    {postedTotal : ExactDecimal} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF) (h0 : 0 ≤ policy.targetScale)
    (h1 : policy.targetScale ≤ maxDecimalScale) (c₁ : 0 ≤ postedTotal.toRat)
    (c₂ : 0 ≤ beforeFraction.toRat) (c₃ : beforeFraction.toRat ≤ afterFraction.toRat)
    (c₄ : afterFraction.toRat ≤ 1)
    (hunits : ∃ c : Int, postedTotal.toRat = c / 10 ^ policy.targetScale.toNat) :
    (∃ share, policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
        .ok (.quantized share)) ∨
      policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
        .error (.exactNumber .representationLimitExceeded) := by
  cases hresult :
      policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction with
  | error e =>
    right
    rw [quantizeCumulativePostedShare_error hT hb ha
      (QuantizationPolicy.quantizeCumulativePostedShare_error_iff.mp hresult)]
  | ok result =>
    cases result with
    | quantized share => exact Or.inl ⟨share, rfl⟩
    | rejected diagnostics =>
      exfalso
      rcases QuantizationPolicy.quantizeCumulativePostedShare_rejected_diagnostic hresult with
        hd | hd
      · rw [hd] at hresult
        rcases (QuantizationPolicy.quantizeCumulativePostedShare_invalid_iff hT hb ha).mp
          hresult with hc | hc | hc | hc | hc | hc
        · omega
        · omega
        · linarith
        · linarith
        · linarith
        · linarith
      · rw [hd] at hresult
        exact ((QuantizationPolicy.quantizeCumulativePostedShare_total_iff hT hb ha).mp
          hresult).2.2.2.2.2.2.2 hunits

/-! ## The rounding posting itself is never what throws -/

/-- Rounding a constructible value that is already a whole number of units of an admitted
scale, with a coefficient within the size limit, always returns. -/
theorem quantize_isOk_of_units {value : ExactRational} {rule : QuantizationRule} {c : Int}
    (hv : value.WF) (h0 : 0 ≤ rule.targetScale) (h1 : rule.targetScale ≤ maxDecimalScale)
    (hc : value.toRat = c / 10 ^ rule.targetScale.toNat) (hw : withinMagnitude c = true) :
    ∃ quantizedValue, quantize value rule = .ok quantizedValue := by
  have hk : roundedCoefficient (value.numerator * 10 ^ rule.targetScale.toNat)
      value.denominator rule.roundingMode = c := by
    have hr := roundedCoefficient_rounds (value.numerator * 10 ^ rule.targetScale.toNat)
      value.denominator hv.denominator_pos rule.roundingMode
    have e : ((value.numerator * 10 ^ rule.targetScale.toNat : Int) : ℚ) / value.denominator =
        (c : ℚ) := by
      have hx : value.toRat * 10 ^ rule.targetScale.toNat = c := by
        rw [hc]
        field_simp
      rw [← hx]
      unfold ExactRational.toRat
      push_cast
      ring
    rw [e] at hr
    exact hr.eq_of_int
  have hof : ExactDecimal.of c rule.targetScale = .ok ⟨c, rule.targetScale⟩ :=
    (ExactDecimal.of_eq_ok_iff _ _ _).mpr ⟨h0, h1, hw, rfl⟩
  obtain ⟨hawf, -, -⟩ := ExactDecimal.of_ok hof
  obtain ⟨amountRational, hto, harwf, hartr⟩ := ExactDecimal.toRational_isOk hawf
  have hsame : amountRational = value :=
    ExactRational.eq_of_toRat_eq harwf hv (by rw [hartr, hc]; rfl)
  simp only [quantize]
  rw [ite_eq_right (by omega), hk, hof]
  simp only [liftExact]
  rw [hto]
  simp only []
  rw [hsame, ExactRational.subtract_self hv]
  exact ⟨_, rfl⟩

/-- When each amount is at most a bound away from its exact value, the two totals are at most
as many bounds apart as there are values. -/
private theorem abs_amountTotal_sub_le {bound : ℚ} {values : List ExactRational}
    {amounts : List ExactDecimal}
    (h : List.Forall₂ (fun value amount => |amount.toRat - value.toRat| ≤ bound)
      values amounts) :
    |amountTotalRat amounts - exactTotalRat values| ≤ values.length * bound := by
  induction h with
  | nil => simp [amountTotalRat, exactTotalRat]
  | @cons value amount values' amounts' hhead _ ih =>
    simp only [amountTotalRat, exactTotalRat, List.map_cons, List.sum_cons,
      List.length_cons] at ih ⊢
    have b₁ := abs_le.mp hhead
    have b₂ := abs_le.mp ih
    push_cast
    exact abs_le.mpr ⟨by linarith [b₁.1, b₂.1], by linarith [b₁.2, b₂.2]⟩

/-- For a list shorter than the size limit, as every JavaScript array is: once the exact values
have been found to balance and their amounts have been added up, rounding the total with its
sign changed always returns, so the rounding posting is never the step that throws. -/
theorem quantizeBalancedBookValues_rounding_isOk {exactValues : List ExactRational}
    {rule : QuantizationRule} {exactTotal quantizedTotal : ExactRational}
    {quantized : List ExactDecimal} (hv : ∀ value ∈ exactValues, value.WF)
    (hlen : exactValues.length < 2 ^ maxExactIntegerBits)
    (h0 : 0 ≤ rule.targetScale) (h1 : rule.targetScale ≤ maxDecimalScale)
    (hexact : addExactValues ExactRational.zero exactValues = .ok exactTotal)
    (hzero : exactTotal.isZero = true)
    (hq : quantizeAmounts rule exactValues = .ok quantized)
    (hqt : addAmounts ExactRational.zero quantized = .ok quantizedTotal) :
    ∃ rounding, quantize quantizedTotal.negate rule = .ok rounding := by
  obtain ⟨hetwf, hettr⟩ := addExactValues_ok ExactRational.zero_wf hv hexact
  have hall := quantizeAmounts_ok hq
  have hawf := amounts_wf hv hall
  obtain ⟨hqtwf, hqttr⟩ := addAmounts_ok ExactRational.zero_wf (fun a hm => (hawf a hm).1) hqt
  rw [ExactRational.zero_toRat, zero_add] at hettr hqttr
  have hbalanced : exactTotalRat exactValues = 0 := by
    rw [← hettr]
    exact (ExactRational.isZero_iff hetwf).mp hzero
  have hunits := amountTotalRat_eq_mul_unit (rule := rule) (fun a hm => (hawf a hm).2)
  have hwithin : List.Forall₂ (fun (value : ExactRational) (amount : ExactDecimal) =>
      |amount.toRat - value.toRat| ≤ rule.unit) exactValues quantized := by
    refine forall₂_imp_of_mem hall ?_
    rintro value hm amount ⟨quantizedValue, hqv, rfl⟩
    exact (quantize_within_one_unit (hv value hm) hqv).le
  have hbound := abs_amountTotal_sub_le hwithin
  rw [hbalanced, sub_zero, hunits, abs_mul, abs_of_pos rule.unit_pos] at hbound
  have hcq : |(((quantized.map ExactDecimal.coefficient).sum : Int) : ℚ)| ≤
      (exactValues.length : ℚ) :=
    le_of_mul_le_mul_right hbound rule.unit_pos
  have hcz : |(quantized.map ExactDecimal.coefficient).sum| ≤ (exactValues.length : Int) := by
    exact_mod_cast hcq
  rw [Int.abs_eq_natAbs] at hcz
  have hnat : (quantized.map ExactDecimal.coefficient).sum.natAbs ≤ exactValues.length :=
    Int.ofNat_le.mp hcz
  have hw : withinMagnitude (-(quantized.map ExactDecimal.coefficient).sum) = true := by
    rw [withinMagnitude_neg, withinMagnitude_iff]
    exact Nat.lt_of_le_of_lt hnat hlen
  refine quantize_isOk_of_units (ExactRational.negate_wf hqtwf) h0 h1
    (c := -(quantized.map ExactDecimal.coefficient).sum) ?_ hw
  rw [ExactRational.negate_toRat, hqttr, hunits]
  unfold QuantizationRule.unit
  push_cast
  ring

/-! ## The identifier maker -/

/-- `quantizationPolicyId` accepts exactly the well-formed identifier texts and returns the
text unchanged. -/
theorem quantizationPolicyId_ok_iff (value : String) (id : QuantizationPolicyId) :
    quantizationPolicyId value = .ok id ↔ id.WF ∧ id.value = value :=
  identifier_ok_iff _ _ _

/-! ## What the TypeScript does that a caller may not expect

Each is the behaviour of `packages/kernel/src/quantization.ts`, kept by the model; the laws
above hold whenever the calls return.

- `quantizeBalancedBookValues` rejects values that do not add up to exactly zero (lines 169 to
  177, `journal_imbalance`), so the law "what is returned balances" needs no proviso, and
  "the total of what is returned is the total of the exact values" says zero on both sides.
- The scale is tested before the book (line 153 before line 161): a policy of another book or
  commodity whose scale is also not admitted is rejected as `invalid_exact_number` at
  `quantizationPolicy.targetScale`, not as `book_isolation_violation`
  (`quantizeBalancedBookValues_other_book_or_commodity`).
- It throws `representation_limit_exceeded`, and does not reject, when a number goes beyond the
  size limit in the total of the exact values (line 169), in a rounding (line 178, where the
  residual is computed although only the amount is kept) or in the total of the amounts
  (lines 179 to 182). It never throws for the scale (`quantizeBalancedBookValues_error`), and
  the rounding of the posting (line 187) is never the step that throws
  (`quantizeBalancedBookValues_rounding_isOk`).
- Because the running total is checked, the order of the values decides whether balanced
  values are accepted: at scale 0 the values 2^16383, 2^16383, -2^16383, -2^16383 throw, and
  the same four as 2^16383, -2^16383, 2^16383, -2^16383 are rounded and returned.
- A returned book value can be zero when its exact value is not: 1/1000 and -1/1000 at scale 2
  come back as 0.00 and 0.00 with no rounding posting.
- The rounding posting can be more than one unit: as many as one unit fewer than there are
  values (the examples after `quantizeBalancedBookValues_no_rounding_of_length_le_one`).
- Nothing here reads the policy's `validFrom`, `validTo` or `version`; they are only hashed.
- `hashQuantizationPolicy` covers every field of the policy
  (`canonicalQuantizationPolicyValue_injective`); a policy without `validTo` and one whose
  `validTo` is `undefined` are the same value in the model, as they hash the same.
-/

end Rastrata.Kernel

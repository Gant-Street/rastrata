/-
The oracle's side of the second wave (a): the validators of `journal.ts` and `policy.ts`
(`localDate`, `instant`, `isLeapYear`, `semanticVersion`, `instantMillis`), `quantization.ts`
(`roundedCoefficient`, `quantize`, `quantizeCumulativePostedShare`, `hashQuantizationPolicy`,
`quantizeBalancedBookValues`), `valuation.ts` (`valueWithObservation`) and the policy functions of
`policy.ts` (`selectBookingPolicy`, `canonicalPolicyValue`, `hashPolicySnapshot`,
`canonicalDerivationValue`), as they travel between the TypeScript test and the Lean model.

Everything on the wire is ASCII, as in `Oracle/Canonical.lean`, whose pieces are used here:

- a string is the lowercase hexadecimal of its UTF-16 code units, four digits a unit;
- an integer is a decimal string; a rational is `{"numerator","denominator"}` and a decimal is
  `{"coefficient","scale"}`, both of decimal strings (`Oracle/Numeric.lean`);
- an optional field is `null` or its value; a list is an array; a union of string literals is
  the literal itself as a plain ASCII string (`"halfEven"`, `"fifo"`, ...), and a value outside the
  union is a protocol error, because the model's type has no such value;
- a record is an object with the TypeScript's field names, written out in `decode*` and `j*` below;
- a result that is a union of two dispositions is `{"disposition":"quantized"|"resolved", ...}` or
  `{"disposition":"rejected","diagnostics":[...]}`;
- a diagnostic is `{"code":<ASCII>,"path":<string>,"message":<string>,"requirementIds":[<string>]}`;
- a canonical value is the tagged object of `Oracle/Canonical.lean` (`{"t":"record","v":[[key,
  value], ...]}` and so on), in the order the model built it.

An error is the answer `{"error": code}` with a code made here:

- an `ExactNumberError` is its own code (`invalid_rational`, `representation_limit_exceeded`, ...);
- the `RangeError` of `quantize` for a scale outside 0 to 1000 is `quantization_scale_out_of_range`;
- the `RangeError`s whose message holds the value are `invalid_local_date:<value>`,
  `invalid_supplied_instant:<value>` and `invalid_semantic_version:<value>`, the value in the wire
  form of a string, so the whole message is compared;
- the two `RangeError`s of `valueWithObservation` are `observation_after_effective_time` and
  `observation_does_not_connect`;
- a string with a lone surrogate, which a Lean `String` cannot hold, is
  `model_has_no_lone_surrogate`, as in `Oracle/Canonical.lean`.

Every name here is in `Oracle.Wave2a` but the two lists at the end (`wave2aSingle` and
`wave2aEntries`, in `Oracle`), and every table key starts with the TypeScript module's name
(`journal.`, `policy.`, `quantization.`, `valuation.`), so that this file cannot clash with another
oracle file.
-/
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Policy.Types
import Rastrata.Kernel.Quantization
import Rastrata.Kernel.QuantizationBalanced
import Rastrata.Kernel.Valuation
import Rastrata.Kernel.Policy
import Oracle.Dispatch
import Oracle.Numeric
import Oracle.Canonical

namespace Oracle.Wave2a

open Rastrata.Kernel

/-! ## Decoding -/

/-- A decoding step: a value, a malformed request, or a string a Lean `String` cannot hold. -/
abbrev Dec (α : Type) := Except DecodeErr α

private def lift {α : Type} (r : Except String α) : Dec α :=
  match r with
  | .ok a => .ok a
  | .error e => .error (.protocol e)

/-- The member `name` of an object. -/
def field (j : Lean.Json) (name : String) : Dec Lean.Json := lift (j.getObjVal? name)

/-- A string member, from its wire form. -/
def textField (j : Lean.Json) (name : String) : Dec String := do decodeText (← field j name)

/-- An optional string member: `null` or a string. -/
def optTextField (j : Lean.Json) (name : String) : Dec (Option String) := do
  let value ← field j name
  if value.isNull then pure none else pure (some (← decodeText value))

/-- A member decoded by the oracle's own instance for its type (numbers, integers, booleans). -/
def plainField {α : Type} [FromOracleJson α] (j : Lean.Json) (name : String) : Dec α := do
  lift (FromOracleJson.fromOracleJson (← field j name))

/-- A member that is an array, each element decoded by `f`. -/
def listField {α : Type} (f : Lean.Json → Dec α) (j : Lean.Json) (name : String) : Dec (List α) := do
  let arr ← lift ((← field j name).getArr?)
  let mut out : Array α := #[]
  for item in arr do
    out := out.push (← f item)
  pure out.toList

/-- A member that is an array of strings. -/
def textListField (j : Lean.Json) (name : String) : Dec (List String) :=
  listField decodeText j name

/-- A member that is a string literal of a union: the literal is looked up in `table`. -/
def literalField {α : Type} (what : String) (table : List (String × α)) (j : Lean.Json)
    (name : String) : Dec α := do
  let literal ← lift ((← field j name).getStr?)
  match table.lookup literal with
  | some value => pure value
  | none => throw (.protocol s!"unknown {what}: {literal}")

/-- A string literal of a union given as a bare value, not a member. -/
def literalValue {α : Type} (what : String) (table : List (String × α)) (j : Lean.Json) :
    Dec α := do
  let literal ← lift j.getStr?
  match table.lookup literal with
  | some value => pure value
  | none => throw (.protocol s!"unknown {what}: {literal}")

/-- Carry a decoding that found a lone surrogate to the entry as news, not as a fault. -/
def carried {α : Type} (r : Dec α) : Except String (Carried α) :=
  match r with
  | .ok a => .ok (.value a)
  | .error .loneSurrogate => .ok .loneSurrogate
  | .error (.protocol e) => .error e

/-- The error of an entry: the code the wire carries. -/
structure Err where
  code : String

instance : ToOracleError Err := ⟨Err.code⟩

/-- A JSON value as an entry's result. -/
instance : ToOracleJson Lean.Json := ⟨fun json => json⟩

/-- What every entry answers when an argument holds a lone surrogate. -/
def loneSurrogateErr : Err := ⟨"model_has_no_lone_surrogate"⟩

/-- The argument, or the error that stands for a lone surrogate in it. -/
def arrived {α : Type} (c : Carried α) : Except Err α :=
  match c with
  | .value a => .ok a
  | .loneSurrogate => .error loneSurrogateErr

/-! ## Encoding -/

/-- A string result, in the wire form of a string. -/
def jText (s : String) : Lean.Json := Lean.Json.str (stringToWire s)

/-- An integer result, a decimal string. -/
def jInt (n : Int) : Lean.Json := Lean.Json.str (toString n)

/-- An optional result: `null` or its encoding. -/
def jOpt {α : Type} (f : α → Lean.Json) : Option α → Lean.Json
  | none => Lean.Json.null
  | some a => f a

/-- A list result: an array. -/
def jList {α : Type} (f : α → Lean.Json) (xs : List α) : Lean.Json :=
  Lean.Json.arr (xs.toArray.map f)

/-- A record result. -/
def jObj (members : List (String × Lean.Json)) : Lean.Json := Lean.Json.mkObj members

def jRational (r : ExactRational) : Lean.Json := ToOracleJson.toOracleJson r

def jDecimal (d : ExactDecimal) : Lean.Json := ToOracleJson.toOracleJson d

/-- The code of an `ExactNumberError`. -/
def numErrCode (e : NumErr) : String := ToOracleError.toErrorCode e

/-! ## The validators: `journal.ts` and `policy.ts` -/

/-- The wire code of a `RangeError` of `localDate`, `instant` or `instantMillis`: its kind and the
text its message ends with. -/
def temporalErrCode : TemporalErr → String
  | .invalidLocalDate value => "invalid_local_date:" ++ stringToWire value
  | .invalidSuppliedInstant value => "invalid_supplied_instant:" ++ stringToWire value

/-- `localDate`. -/
def entryLocalDate (value : Carried String) : Except Err Text := do
  match Rastrata.Kernel.localDate (← arrived value) with
  | .ok date => pure ⟨date.value⟩
  | .error err => throw ⟨temporalErrCode err⟩

/-- `instant`. -/
def entryInstant (value : Carried String) : Except Err Text := do
  match Rastrata.Kernel.instant (← arrived value) with
  | .ok found => pure ⟨found.value⟩
  | .error err => throw ⟨temporalErrCode err⟩

/-- `isLeapYear`, on any year; the TypeScript reaches it through `localDate` with a year of four
digits. -/
def entryIsLeapYear (year : Nat) : Bool := Rastrata.Kernel.isLeapYear year

/-- `semanticVersion`. -/
def entrySemanticVersion (value : Carried String) : Except Err Text := do
  let text ← arrived value
  match Rastrata.Kernel.semanticVersion text with
  | .ok version => pure ⟨version.value⟩
  | .error (.invalidSemanticVersion shown) =>
    throw ⟨"invalid_semantic_version:" ++ stringToWire shown⟩

/-- `instantMillis`: the milliseconds `Date.parse` reads from a text, or the `RangeError`. -/
def entryInstantMillis (value : Carried String) : Except Err Int := do
  match Rastrata.Kernel.instantMillis ⟨← arrived value⟩ with
  | .ok millis => pure millis
  | .error err => throw ⟨temporalErrCode err⟩


/-! ## Rounding: `quantization.ts` -/

/-- The five rounding modes, by the TypeScript's literal. -/
def roundingModes : List (String × RoundingMode) :=
  [("halfEven", .halfEven), ("halfAwayFromZero", .halfAwayFromZero), ("towardZero", .towardZero),
    ("floor", .floor), ("ceiling", .ceiling)]

instance : FromOracleJson RoundingMode where
  fromOracleJson j := do
    let literal ← j.getStr?
    match roundingModes.lookup literal with
    | some mode => .ok mode
    | none => .error s!"unknown rounding mode: {literal}"

/-- A rule: `{"targetScale": <integer>, "roundingMode": <literal>}`. -/
instance : FromOracleJson QuantizationRule where
  fromOracleJson j := do
    let scale ← FromOracleJson.fromOracleJson (← j.getObjVal? "targetScale")
    let mode ← FromOracleJson.fromOracleJson (← j.getObjVal? "roundingMode")
    pure ⟨scale, mode⟩

/-- The code of an error of `quantize`: the `RangeError` for the scale, or an exact number's. -/
def quantizeErrCode : QuantizeErr → String
  | .scaleOutOfRange => "quantization_scale_out_of_range"
  | .exactNumber code => numErrCode code

def jQuantized (q : QuantizedValue) : Lean.Json :=
  jObj [("amount", jDecimal q.amount), ("residual", jRational q.residual)]

def jRule (rule : QuantizationRule) : Lean.Json :=
  jObj [("targetScale", jInt rule.targetScale), ("roundingMode", Lean.Json.str rule.roundingMode.text)]

/-- `roundedCoefficient`: reached by the TypeScript only through `quantize`. -/
def entryRoundedCoefficient (numerator denominator : Int) (mode : RoundingMode) : Int :=
  Rastrata.Kernel.roundedCoefficient numerator denominator mode

/-- `quantize`. -/
def entryQuantize (value : ExactRational) (rule : QuantizationRule) : Except Err Lean.Json :=
  match Rastrata.Kernel.quantize value rule with
  | .ok quantized => .ok (jQuantized quantized)
  | .error e => .error ⟨quantizeErrCode e⟩

/-- The reason of a rejection of `quantizeCumulativePostedShare`, by the path of its diagnostic. -/
def shareReason : ShareRejection → String
  | .invalidShare => "invalidShare"
  | .totalNotRepresentable => "totalNotRepresentable"

/-- A share of the rule's arithmetic. -/
def jShare (share : CumulativePostedShare) : Lean.Json :=
  jObj
    [ ("postedTotal", jDecimal share.postedTotal)
    , ("beforeFraction", jRational share.beforeFraction)
    , ("afterFraction", jRational share.afterFraction)
    , ("beforeTarget", jRational share.beforeTarget)
    , ("afterTarget", jRational share.afterTarget)
    , ("beforeQuantization", jQuantized share.beforeQuantization)
    , ("afterQuantization", jQuantized share.afterQuantization)
    , ("postedAmount", jDecimal share.postedAmount)
    , ("rule", jRule share.rule) ]

/-- `quantizeCumulativePostedShare` over the rule. -/
def entryShare (postedTotal : ExactDecimal) (beforeFraction afterFraction : ExactRational)
    (rule : QuantizationRule) : Except Err Lean.Json :=
  match Rastrata.Kernel.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction
      rule with
  | .error e => .error ⟨quantizeErrCode e⟩
  | .ok (.rejected reason) =>
    .ok (jObj [("disposition", Lean.Json.str "rejected"), ("reason", Lean.Json.str (shareReason reason))])
  | .ok (.quantized share) =>
    .ok (jObj [("disposition", Lean.Json.str "quantized"), ("share", jShare share)])

/-! ## Rounding that balances: the full policy -/

/-- A quantization policy: `{"id","version","bookId","functionalCommodityId","validFrom"` (strings),
`"validTo"` (a string or `null`), `"targetScale"` (an integer), `"roundingMode"` (a literal),
`"roundingAccountId"` (a string)`}`. -/
def decodePolicy (j : Lean.Json) : Dec QuantizationPolicy := do
  let validTo ← optTextField j "validTo"
  pure
    { id := ⟨← textField j "id"⟩
      version := ⟨← textField j "version"⟩
      bookId := ⟨← textField j "bookId"⟩
      functionalCommodityId := ⟨← textField j "functionalCommodityId"⟩
      validFrom := ⟨← textField j "validFrom"⟩
      validTo := validTo.map fun date => (⟨date⟩ : LocalDate)
      targetScale := ← plainField (α := Int) j "targetScale"
      roundingMode := ← plainField (α := RoundingMode) j "roundingMode"
      roundingAccountId := ⟨← textField j "roundingAccountId"⟩ }

instance : FromOracleJson (Carried QuantizationPolicy) where
  fromOracleJson j := carried (decodePolicy j)

def jQuantizationPolicy (policy : QuantizationPolicy) : Lean.Json :=
  jObj
    [ ("id", jText policy.id.value)
    , ("version", jText policy.version.value)
    , ("bookId", jText policy.bookId.value)
    , ("functionalCommodityId", jText policy.functionalCommodityId.value)
    , ("validFrom", jText policy.validFrom.value)
    , ("validTo", jOpt (fun date => jText date.value) policy.validTo)
    , ("targetScale", jInt policy.targetScale)
    , ("roundingMode", Lean.Json.str policy.roundingMode.text)
    , ("roundingAccountId", jText policy.roundingAccountId.value) ]

/-- The TypeScript's spelling of a diagnostic code. -/
def codeText : SemanticDiagnosticCode → String
  | .atomic_commit_failed => "atomic_commit_failed"
  | .command_identity_conflict => "command_identity_conflict"
  | .dependent_close_not_current => "dependent_close_not_current"
  | .fabricated_opening_journal => "fabricated_opening_journal"
  | .fiscal_period_admission => "fiscal_period_admission"
  | .immutable_book_identity => "immutable_book_identity"
  | .invalid_correction_topology => "invalid_correction_topology"
  | .canonical_identity_conflict => "canonical_identity_conflict"
  | .invalid_chart_or_account => "invalid_chart_or_account"
  | .invalid_dimension_selection => "invalid_dimension_selection"
  | .invalid_exact_number => "invalid_exact_number"
  | .invalid_journal_structure => "invalid_journal_structure"
  | .book_isolation_violation => "book_isolation_violation"
  | .lot_overallocation => "lot_overallocation"
  | .policy_ambiguity => "policy_ambiguity"
  | .projection_rebuild_mismatch => "projection_rebuild_mismatch"
  | .stale_book_revision => "stale_book_revision"
  | .ordered_history_violation => "ordered_history_violation"
  | .temporal_semantics_violation => "temporal_semantics_violation"
  | .transfer_policy_missing => "transfer_policy_missing"
  | .unresolved_accounting_input => "unresolved_accounting_input"
  | .monetary_type_mismatch => "monetary_type_mismatch"
  | .journal_imbalance => "journal_imbalance"
  | .inventory_cost_policy_incoherent => "inventory_cost_policy_incoherent"
  | .provisional_inventory_violation => "provisional_inventory_violation"
  | .inventory_value_adjustment_violation => "inventory_value_adjustment_violation"
  | .settlement_allocation_violation => "settlement_allocation_violation"
  | .accounting_basis_policy_incomplete => "accounting_basis_policy_incomplete"
  | .currency_remeasurement_violation => "currency_remeasurement_violation"
  | .allocation_schedule_violation => "allocation_schedule_violation"
  | .allocation_schedule_revision_violation => "allocation_schedule_revision_violation"
  | .tax_policy_ambiguity => "tax_policy_ambiguity"
  | .consolidation_input_violation => "consolidation_input_violation"
  | .external_accounting_authority => "external_accounting_authority"

/-- A diagnostic: code, path, message and requirement identifiers. -/
def jDiagnostic (d : SemanticDiagnostic) : Lean.Json :=
  jObj
    [ ("code", Lean.Json.str (codeText d.code))
    , ("path", jText d.path)
    , ("message", jText d.message)
    , ("requirementIds", jList jText d.requirementIds) ]

def jBookValue (value : BookValue) : Lean.Json :=
  jObj
    [ ("amount", jDecimal value.amount)
    , ("functionalCommodityId", jText value.functionalCommodityId.value) ]

def jRoundingPosting (posting : RoundingPosting) : Lean.Json :=
  jObj [("accountId", jText posting.accountId.value), ("bookValue", jBookValue posting.bookValue)]

def jBalanced : BalancedQuantizationResult → Lean.Json
  | .quantized bookValues posting =>
    jObj
      [ ("disposition", Lean.Json.str "quantized")
      , ("bookValues", jList jBookValue bookValues)
      , ("roundingPosting", jOpt jRoundingPosting posting) ]
  | .rejected diagnostics =>
    jObj
      [ ("disposition", Lean.Json.str "rejected")
      , ("diagnostics", jList jDiagnostic diagnostics) ]

/-- `hashQuantizationPolicy`. -/
def entryHashQuantizationPolicy (policy : Carried QuantizationPolicy) : Except Err ContentHash := do
  pure (Rastrata.Kernel.hashQuantizationPolicy (← arrived policy))

/-- `quantizeBalancedBookValues`. -/
def entryQuantizeBalanced (exactValues : List ExactRational) (bookId commodityId : Carried String)
    (policy : Carried QuantizationPolicy) : Except Err Lean.Json := do
  let book ← arrived bookId
  let commodity ← arrived commodityId
  let chosen ← arrived policy
  match Rastrata.Kernel.quantizeBalancedBookValues exactValues ⟨book⟩ ⟨commodity⟩ chosen with
  | .ok result => pure (jBalanced result)
  | .error e => throw ⟨quantizeErrCode e⟩

def jPolicyShare (share : PolicyCumulativePostedShare) : Lean.Json :=
  jObj
    [ ("postedTotal", jDecimal share.postedTotal)
    , ("beforeFraction", jRational share.beforeFraction)
    , ("afterFraction", jRational share.afterFraction)
    , ("beforeTarget", jRational share.beforeTarget)
    , ("afterTarget", jRational share.afterTarget)
    , ("beforeQuantization", jQuantized share.beforeQuantization)
    , ("afterQuantization", jQuantized share.afterQuantization)
    , ("postedAmount", jDecimal share.postedAmount)
    , ("policy", jQuantizationPolicy share.policy) ]

/-- `quantizeCumulativePostedShare` over the full policy. -/
def entryPolicyShare (postedTotal : ExactDecimal) (beforeFraction afterFraction : ExactRational)
    (policy : Carried QuantizationPolicy) : Except Err Lean.Json := do
  match Rastrata.Kernel.QuantizationPolicy.quantizeCumulativePostedShare postedTotal
      beforeFraction afterFraction (← arrived policy) with
  | .error e => throw ⟨quantizeErrCode e⟩
  | .ok (.rejected diagnostics) =>
    pure (jObj
      [ ("disposition", Lean.Json.str "rejected")
      , ("diagnostics", jList jDiagnostic diagnostics) ])
  | .ok (.quantized share) =>
    pure (jObj [("disposition", Lean.Json.str "quantized"), ("share", jPolicyShare share)])


/-! ## Valuation: `valuation.ts` -/

/-- The three kinds of a price observation, by the TypeScript's literal. -/
def priceKinds : List (String × PriceObservationKind) :=
  [("marketQuote", .marketQuote), ("officialRate", .officialRate),
    ("appraisedValue", .appraisedValue)]

/-- A quantity: `{"canonicalNumber"` (a rational), `"commodityId"` (a string), `"sourceNumber"`
(a decimal or `null`)`}`. -/
def decodeQuantity (j : Lean.Json) : Dec Quantity := do
  pure
    { canonicalNumber := ← plainField (α := ExactRational) j "canonicalNumber"
      commodityId := ⟨← textField j "commodityId"⟩
      sourceNumber := ← plainField (α := Option ExactDecimal) j "sourceNumber" }

instance : FromOracleJson (Carried Quantity) where
  fromOracleJson j := carried (decodeQuantity j)

/-- A price observation: `{"id","effectiveAt","observedAt"` (strings), `"kind"` (a literal),
`"rate"` (a rational), `"baseCommodityId","quoteCommodityId","evidenceId"` (strings)`}`. -/
def decodeObservation (j : Lean.Json) : Dec MarketPriceObservation := do
  pure
    { id := ⟨← textField j "id"⟩
      effectiveAt := ⟨← textField j "effectiveAt"⟩
      observedAt := ⟨← textField j "observedAt"⟩
      kind := ← literalField "price observation kind" priceKinds j "kind"
      rate := ← plainField (α := ExactRational) j "rate"
      baseCommodityId := ⟨← textField j "baseCommodityId"⟩
      quoteCommodityId := ⟨← textField j "quoteCommodityId"⟩
      evidenceId := ⟨← textField j "evidenceId"⟩ }

instance : FromOracleJson (Carried MarketPriceObservation) where
  fromOracleJson j := carried (decodeObservation j)

/-- The code of an error of `valueWithObservation`. -/
def valuationErrCode : ValuationErr → String
  | .observationAfterEffectiveTime => "observation_after_effective_time"
  | .observationDoesNotConnect => "observation_does_not_connect"
  | .exactNumber code => numErrCode code

def jMarketValue (value : MarketValue) : Lean.Json :=
  jObj
    [ ("exactAmount", jRational value.exactAmount)
    , ("reportingCommodityId", jText value.reportingCommodityId.value)
    , ("sourceObservationId", jText value.sourceObservationId.value)
    , ("usesInverse", Lean.Json.bool value.usesInverse)
    , ("effectiveAt", jText value.effectiveAt.value) ]

/-- `valueWithObservation`. -/
def entryValueWithObservation (quantity : Carried Quantity)
    (observation : Carried MarketPriceObservation) (effectiveAt : Carried String)
    (allowInverse : Bool) : Except Err Lean.Json := do
  let at_ ← arrived effectiveAt
  match Rastrata.Kernel.valueWithObservation (← arrived quantity) (← arrived observation)
      ⟨at_⟩ allowInverse with
  | .ok value => pure (jMarketValue value)
  | .error e => throw ⟨valuationErrCode e⟩

/-! ## Booking policy: `policy.ts` -/

def lotMethods : List (String × LotSelectionMethod) :=
  [("specificIdentification", .specificIdentification), ("fifo", .fifo), ("lifo", .lifo),
    ("hifo", .hifo), ("weightedAverage", .weightedAverage)]

def policyScopes : List (String × PolicyScope) :=
  [("account", .account), ("legalEntity", .legalEntity), ("jurisdictionPool", .jurisdictionPool)]

def capabilityStatuses : List (String × PolicyCapabilityStatus) :=
  [("supported", .supported), ("experimental", .experimental), ("unsupported", .unsupported)]

def derivationStates : List (String × DerivationState) :=
  [("proposed", .proposed), ("approved", .approved), ("rejected", .rejected),
    ("applied", .applied)]

/-- A list of identifiers of one kind, from an array of strings. -/
def idListField {Kind : String} (j : Lean.Json) (name : String) : Dec (List (Identifier Kind)) := do
  pure ((← textListField j name).map fun value => (⟨value⟩ : Identifier Kind))

/-- A policy capability: `{"id"` (a string), `"method","scope","status"` (literals),
`"implementationVersion"` (a string), `"verificationEvidenceIds"` (an array of strings)`}`. -/
def decodeCapability (j : Lean.Json) : Dec PolicyCapability := do
  pure
    { id := ⟨← textField j "id"⟩
      method := ← literalField "lot selection method" lotMethods j "method"
      scope := ← literalField "policy scope" policyScopes j "scope"
      status := ← literalField "capability status" capabilityStatuses j "status"
      implementationVersion := ⟨← textField j "implementationVersion"⟩
      verificationEvidenceIds := ← idListField (Kind := "SourceEvidence") j "verificationEvidenceIds" }

/-- A booking policy: `{"id","bookId","version","validFrom"` (strings), `"validTo"` (a string or
`null`), `"lotSelection","scope"` (literals), `"scopeKey"` (a string), `"requiredDimensionIds"`
(an array of strings), `"implementationVersion"` (a string), `"capability"` (a capability)`}`. -/
def decodeBookingPolicy (j : Lean.Json) : Dec BookingPolicy := do
  let validTo ← optTextField j "validTo"
  pure
    { id := ⟨← textField j "id"⟩
      bookId := ⟨← textField j "bookId"⟩
      version := ⟨← textField j "version"⟩
      validFrom := ⟨← textField j "validFrom"⟩
      validTo := validTo.map fun instant => (⟨instant⟩ : Instant)
      lotSelection := ← literalField "lot selection method" lotMethods j "lotSelection"
      scope := ← literalField "policy scope" policyScopes j "scope"
      scopeKey := ← textField j "scopeKey"
      requiredDimensionIds := ← idListField (Kind := "AccountingDimension") j "requiredDimensionIds"
      implementationVersion := ⟨← textField j "implementationVersion"⟩
      capability := ← decodeCapability (← field j "capability") }

instance : FromOracleJson (Carried BookingPolicy) where
  fromOracleJson j := carried (decodeBookingPolicy j)

instance : FromOracleJson (Carried (List BookingPolicy)) where
  fromOracleJson j := carried do
    let arr ← lift j.getArr?
    let mut out : Array BookingPolicy := #[]
    for item in arr do
      out := out.push (← decodeBookingPolicy item)
    pure out.toList

/-- The fact `selectBookingPolicy` is asked about: `{"bookId","governedAt","scopeKey"}`, strings. -/
def decodeFact (j : Lean.Json) : Dec GovernedFact := do
  pure
    { bookId := ⟨← textField j "bookId"⟩
      governedAt := ⟨← textField j "governedAt"⟩
      scopeKey := ← textField j "scopeKey" }

instance : FromOracleJson (Carried GovernedFact) where
  fromOracleJson j := carried (decodeFact j)

/-- A content hash: `{"algorithm","canonicalizationVersion","digest"}`, strings. -/
def decodeHash (j : Lean.Json) : Dec ContentHash := do
  pure
    { algorithm := ← textField j "algorithm"
      canonicalizationVersion := ← textField j "canonicalizationVersion"
      digest := ← textField j "digest" }

/-- An item of evidence: `{"id","sourceSystem","sourceRecordId","observedAt"` (strings),
`"contentHash"` (a content hash)`}`. -/
def decodeEvidence (j : Lean.Json) : Dec SourceEvidence := do
  pure
    { id := ⟨← textField j "id"⟩
      sourceSystem := ← textField j "sourceSystem"
      sourceRecordId := ← textField j "sourceRecordId"
      observedAt := ⟨← textField j "observedAt"⟩
      contentHash := ← decodeHash (← field j "contentHash") }

/-- A derivation record: `{"id","policyId","policyVersion","algorithmVersion"` (strings),
`"inputHash"` (a content hash), `"actorId"` (a string), `"state"` (a literal), `"recordedAt"` (a
string), `"evidence"` (an array of items of evidence)`}`. -/
def decodeDerivation (j : Lean.Json) : Dec DerivationRecord := do
  pure
    { id := ⟨← textField j "id"⟩
      policyId := ⟨← textField j "policyId"⟩
      policyVersion := ⟨← textField j "policyVersion"⟩
      algorithmVersion := ⟨← textField j "algorithmVersion"⟩
      inputHash := ← decodeHash (← field j "inputHash")
      actorId := ⟨← textField j "actorId"⟩
      state := ← literalField "derivation state" derivationStates j "state"
      recordedAt := ⟨← textField j "recordedAt"⟩
      evidence := ← listField decodeEvidence j "evidence" }

instance : FromOracleJson (Carried DerivationRecord) where
  fromOracleJson j := carried (decodeDerivation j)

def jCapability (capability : PolicyCapability) : Lean.Json :=
  jObj
    [ ("id", jText capability.id.value)
    , ("method", Lean.Json.str capability.method.text)
    , ("scope", Lean.Json.str capability.scope.text)
    , ("status", Lean.Json.str capability.status.text)
    , ("implementationVersion", jText capability.implementationVersion.value)
    , ("verificationEvidenceIds",
        jList (fun id => jText id.value) capability.verificationEvidenceIds) ]

def jBookingPolicy (policy : BookingPolicy) : Lean.Json :=
  jObj
    [ ("id", jText policy.id.value)
    , ("bookId", jText policy.bookId.value)
    , ("version", jText policy.version.value)
    , ("validFrom", jText policy.validFrom.value)
    , ("validTo", jOpt (fun instant => jText instant.value) policy.validTo)
    , ("lotSelection", Lean.Json.str policy.lotSelection.text)
    , ("scope", Lean.Json.str policy.scope.text)
    , ("scopeKey", jText policy.scopeKey)
    , ("requiredDimensionIds", jList (fun id => jText id.value) policy.requiredDimensionIds)
    , ("implementationVersion", jText policy.implementationVersion.value)
    , ("capability", jCapability policy.capability) ]

/-- The deepest canonical value the oracle writes. The policy values are four levels deep. -/
def maxEncodeDepth : Nat := 64

mutual
  /-- A canonical value, in the tagged wire form `Oracle/Canonical.lean` reads. -/
  def jValueAux : Nat → CanonicalValue → Lean.Json
    | 0, _ => Lean.Json.str "canonical value nested too deeply"
    | fuel + 1, value =>
      match value with
      | .null => jObj [("t", Lean.Json.str "null")]
      | .bool b => jObj [("t", Lean.Json.str "bool"), ("v", Lean.Json.bool b)]
      | .string s => jObj [("t", Lean.Json.str "string"), ("v", jText s)]
      | .int n => jObj [("t", Lean.Json.str "int"), ("v", jInt n)]
      | .bytes b => jObj [("t", Lean.Json.str "bytes"), ("v", Lean.Json.str (bytesToHexWire b))]
      | .array xs =>
        jObj [("t", Lean.Json.str "array"), ("v", Lean.Json.arr (jValuesAux fuel xs).toArray)]
      | .record entries =>
        jObj [("t", Lean.Json.str "record"), ("v", Lean.Json.arr (jEntriesAux fuel entries).toArray)]

  /-- The members of an array, in order. -/
  def jValuesAux : Nat → List CanonicalValue → List Lean.Json
    | _, [] => []
    | fuel, value :: rest => jValueAux fuel value :: jValuesAux fuel rest

  /-- The entries of a record, in the order they are held. -/
  def jEntriesAux : Nat → List (String × CanonicalValue) → List Lean.Json
    | _, [] => []
    | fuel, (key, value) :: rest =>
      Lean.Json.arr #[jText key, jValueAux fuel value] :: jEntriesAux fuel rest
end

def jValue (value : CanonicalValue) : Lean.Json := jValueAux maxEncodeDepth value

/-- `selectBookingPolicy`. -/
def entrySelectBookingPolicy (policies : Carried (List BookingPolicy))
    (fact : Carried GovernedFact) : Except Err Lean.Json := do
  match Rastrata.Kernel.selectBookingPolicy (← arrived policies) (← arrived fact) with
  | .ok (.resolved policy) =>
    pure (jObj [("disposition", Lean.Json.str "resolved"), ("policy", jBookingPolicy policy)])
  | .ok (.rejected diagnostics) =>
    pure (jObj
      [ ("disposition", Lean.Json.str "rejected")
      , ("diagnostics", jList jDiagnostic diagnostics) ])
  | .error err => throw ⟨temporalErrCode err⟩

/-- `canonicalPolicyValue`. -/
def entryCanonicalPolicyValue (policy : Carried BookingPolicy) : Except Err Lean.Json := do
  pure (jValue (Rastrata.Kernel.canonicalPolicyValue (← arrived policy)))

/-- `hashPolicySnapshot`. -/
def entryHashPolicySnapshot (policies : Carried (List BookingPolicy)) :
    Except Err ContentHash := do
  pure (Rastrata.Kernel.hashPolicySnapshot (← arrived policies))

/-- `canonicalDerivationValue`. -/
def entryCanonicalDerivationValue (derivation : Carried DerivationRecord) :
    Except Err Lean.Json := do
  pure (jValue (Rastrata.Kernel.canonicalDerivationValue (← arrived derivation)))

end Oracle.Wave2a

namespace Oracle

/-- The entries of this file, one for each function of the five modules. -/
def wave2aSingle : List (String × Handler) :=
  [ ("journal.localDate", fn1 Wave2a.entryLocalDate)
  , ("journal.instant", fn1 Wave2a.entryInstant)
  , ("journal.isLeapYear", fn1 Wave2a.entryIsLeapYear)
  , ("policy.semanticVersion", fn1 Wave2a.entrySemanticVersion)
  , ("policy.instantMillis", fn1 Wave2a.entryInstantMillis)
  , ("quantization.roundedCoefficient", fn3 Wave2a.entryRoundedCoefficient)
  , ("quantization.quantize", fn2 Wave2a.entryQuantize)
  , ("quantization.quantizeCumulativePostedShare", fn4 Wave2a.entryShare)
  , ("quantization.hashQuantizationPolicy", fn1 Wave2a.entryHashQuantizationPolicy)
  , ("quantization.quantizeBalancedBookValues", fn4 Wave2a.entryQuantizeBalanced)
  , ("quantization.policyQuantizeCumulativePostedShare", fn4 Wave2a.entryPolicyShare)
  , ("valuation.valueWithObservation", fn4 Wave2a.entryValueWithObservation)
  , ("policy.selectBookingPolicy", fn2 Wave2a.entrySelectBookingPolicy)
  , ("policy.canonicalPolicyValue", fn1 Wave2a.entryCanonicalPolicyValue)
  , ("policy.hashPolicySnapshot", fn1 Wave2a.entryHashPolicySnapshot)
  , ("policy.canonicalDerivationValue", fn1 Wave2a.entryCanonicalDerivationValue)
  ]

/-- This file's entries of the dispatch table. Each has a twin whose name ends in `.each`, which
takes one argument, a list of argument lists, and answers each in turn (`each`), so that a sweep of
ten thousand years is a few requests and not ten thousand. -/
def wave2aEntries : List (String × Handler) :=
  wave2aSingle ++ wave2aSingle.map fun (name, handler) => (name ++ ".each", each handler)

end Oracle

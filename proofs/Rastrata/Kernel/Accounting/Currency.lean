/-
Currency remeasurement: the Lean model of `packages/kernel/src/accounting.ts` lines 1496 to 1542
(`CurrencyRemeasurementRequest`, `CurrencyAccountingState`, `calculateCurrencyRemeasurement`) and its
laws. It imports `Accounting/Core/Model.lean` for the helpers it calls (`policyAt`,
`validAccountingDerivation`, `positive`, `drafted`, `accountingBodyHash`, `accountingSum`) and uses no
theorem of the other files of `Accounting/Core/`.

The model. `calculateCurrencyRemeasurement` does what the TypeScript does, with the same checks in the
same order, the same diagnostics (code, path, message and requirement identifiers in full) and
`Except` where the TypeScript throws. It is written as a dispatch (`policyAt` twice, the one test of line
1513, the policy's book, `reversalOf`) over two branches, `draftCurrencyReversal` (lines 1516 to 1530)
and `draftCurrencyResult` (lines 1531 to 1540); each builds its effect and its journal with named
helpers (`reversalEffectOf`, `reversalJournalOf`, `remeasurementResultOf`, `remeasurementJournalOf`,
`remeasurementPostings`, `reversalGainLossAccount`), which hold the object literals of the TypeScript
and which the laws are about. The optional fields of the hashed bodies are present exactly when the code
spreads them: `sourcePostingId`, `source` and `adjustmentEffectKey` (from `generatedEffectKey`) of a
result when the request has them, `originalEffectKey` of a reversal when the original has an
`adjustmentEffectKey`; `positionAccountId`, `denominationCommodityId`, `policy`, `classificationPolicy`
and `valuationPath` of a result, and `originalJournalId` of a reversal, always.

What the TypeScript throws and the model returns as `.error`: an `ExactNumberError` of `multiply` or
`subtract` (lines 1531 and 1532), and an `IdentityError` of `journalId` or `identifier` on the derived
identifiers `${id}-journal`, `${id}-position`, `${id}-gain-loss` (lines 1521, 1525 to 1527, 1536 to
1538). No other expression of the function throws.

What is assumed about JavaScript, and what is not modelled:

- `effectiveAt.slice(0, 10) !== effectiveOn` (line 1513) is modelled on UTF-16 code units, which is what
  JavaScript counts and compares: the first ten code units of `effectiveAt` (`instantDatePrefix`, through
  `stringToUTF16`) against all the code units of `effectiveOn`. This is exact for every Lean string.
- `observedAt > governedAt` (line 1513) compares the two strings by UTF-16 code unit (`jsStringLt`), as
  JavaScript `>` does on strings. It is not a comparison of times: see
  `observedAt_check_is_not_a_time_order` below.
- `Date.parse` inside `validAccountingDerivation` is `dateParse` of `Policy/Types.lean`, which answers for
  the texts `instant` accepts. The engines also read texts `instant` refuses (`"2026-01-01"`,
  `"Jan 1 2026"`), for which the model answers `none` and the TypeScript accepts the derivation; a
  `DerivationRecord` built through `instant` cannot hold such a text.
- `Object.freeze`, `immutableAccountingValue` and the identity of objects are not modelled.
- `isNFC (id ++ suffix)` is proved for ASCII identifiers (`ascii_isNFC`) and taken as a hypothesis, where
  it is needed, for other identifiers; the exact conditions for an identifier error are laws with no such
  hypothesis (`calculateCurrencyRemeasurement_identity_error_iff`).

How it was checked against the TypeScript: the real `calculateCurrencyRemeasurement` and this model were
run on the same 56 inputs (gains, losses, a zero difference, a fractional rate, every optional field present
and absent, a reversal of each kind of original, a reversal whose original recorded no policy, a reversal
under another current policy, each rejection, the size limit at the multiplication and at the subtraction,
identifiers that cannot be built, non-ASCII identifiers, and strings with characters beyond the Basic
Multilingual Plane in the dates), and the model's journals, effects and hashes were compared with the
TypeScript's by the digest of their canonical values, its rejections by diagnostic, and its errors by
kind: no input differs.

The laws, each a theorem below: what is drafted, exactly (`calculateCurrencyRemeasurement_result_iff`,
`calculateCurrencyRemeasurement_reversal_iff`); the journal balances
(`calculateCurrencyRemeasurement_journal_balances`, `calculateCurrencyRemeasurement_journal_sum`); the
difference is exact (`calculateCurrencyRemeasurement_difference`); the gain or loss account follows the
sign of the difference (`calculateCurrencyRemeasurement_gain_loss_account`); a reversal negates its
original, with the original's own policy accounts
(`calculateCurrencyRemeasurement_reversal_journal`,
`calculateCurrencyRemeasurement_reversal_effect`), and a remeasurement and its reversal net to zero
(`remeasurement_then_reversal_nets_to_zero`); the effects carry the hash of their body
(`calculateCurrencyRemeasurement_effect_hash`); every rejection with its diagnostic and the exact
condition (`calculateCurrencyRemeasurement_rejected_input_iff`, `..._rejected_policyBook_iff`,
`..._rejected_reversal_iff`); the exact conditions of every `.error`
(`calculateCurrencyRemeasurement_number_error_iff`, `..._identity_error_iff`, `..._error_cases`); the
difference of zero (`calculateCurrencyRemeasurement_zero_difference`); and that what is drafted is
constructible (`calculateCurrencyRemeasurement_wf`).
-/
import Rastrata.Prelude
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

/-! ## Types (`accounting.ts` lines 1496 to 1508) -/

/-- `CurrencyRemeasurementRequest` (`accounting.ts` line 1496). -/
structure CurrencyRemeasurementRequest where
  id : RemeasurementResultId
  policyId : PolicyId
  policyVersion : SemanticVersion
  classificationPolicyId : PolicyId
  classificationPolicyVersion : SemanticVersion
  governedAt : Instant
  kind : RemeasurementKind
  classification : MonetaryClassification
  sourcePostingId : Option PostingId
  source : Option CanonicalPostingReference
  generatedEffectKey : Option EffectKey
  effectiveOn : LocalDate
  denominationCommodityId : CommodityId
  denomination : ExactRational
  carryingBookValue : ExactRational
  valuationPath : CurrencyValuationPath
  positionAccountId : AccountId
  derivation : DerivationRecord
  reversalOf : Option RemeasurementResultId
  reversalId : Option RemeasurementReversalId
  deriving DecidableEq, Repr, Inhabited

/-- `CurrencyAccountingState` (`accounting.ts` line 1508). -/
structure CurrencyAccountingState where
  remeasurementResults : List RemeasurementResult
  remeasurementReversals : List RemeasurementReversal
  deriving DecidableEq, Repr, Inhabited

/-- The empty `CurrencyAccountingState`, matching the default parameter
`emptyAccountingCanonicalState()` (`accounting.ts` line 1509). -/
def emptyCurrencyAccountingState : CurrencyAccountingState where
  remeasurementResults := []
  remeasurementReversals := []

/-- Projecting a full `AccountingCanonicalState` to `CurrencyAccountingState`. -/
def AccountingCanonicalState.toCurrencyAccountingState (state : AccountingCanonicalState) :
    CurrencyAccountingState where
  remeasurementResults := state.remeasurementResults
  remeasurementReversals := state.remeasurementReversals

/-! ## Errors and diagnostics -/

/-- What `calculateCurrencyRemeasurement` throws: an `ExactNumberError` (`multiply` or `subtract`,
`accounting.ts` lines 1531 and 1532), or an `IdentityError` from `journalId` / `identifier` on the
derived journal and posting identifiers (`accounting.ts` lines 1521, 1525 to 1527, 1536 to 1538). -/
inductive CurrencyErr where
  | exactNumber (code : NumErr)
  | canonical (code : CanonicalErr)
  deriving DecidableEq, Repr, Inhabited

/-- Lift a `NumErr` into `CurrencyErr`. -/
def liftCurrencyNumErr {α : Type} : Except NumErr α → Except CurrencyErr α
  | .error e => .error (.exactNumber e)
  | .ok a => .ok a

/-- Lift a `CanonicalErr` into `CurrencyErr`. -/
def liftCurrencyCanonicalErr {α : Type} : Except CanonicalErr α → Except CurrencyErr α
  | .error e => .error (.canonical e)
  | .ok a => .ok a

/-- The diagnostic of the first rejection of `calculateCurrencyRemeasurement`
(`accounting.ts` line 1513). -/
def currencyInputDiagnostic : SemanticDiagnostic :=
  diagnostic .currency_remeasurement_violation "command.remeasurement"
    "Monetary classification, approved lineage, and a complete supplied dated valuation path are required"
    ["ACC-043.1", "ACC-043.2"]

/-- The diagnostic of the second rejection of `calculateCurrencyRemeasurement`
(`accounting.ts` line 1515). -/
def currencyPolicyBookDiagnostic : SemanticDiagnostic :=
  diagnostic .currency_remeasurement_violation "command.remeasurement.policy"
    "Currency policy belongs to another book" ["ACC-043.1"]

/-- The diagnostic of the third rejection of `calculateCurrencyRemeasurement`
(`accounting.ts` line 1519). -/
def currencyReversalDiagnostic : SemanticDiagnostic :=
  diagnostic .currency_remeasurement_violation "command.remeasurement.reversalOf"
    "An unrealized result may be explicitly reversed exactly once, whether or not its policy mandates reversal"
    ["ACC-043.4", "ACC-043.6"]

/-! ## `calculateCurrencyRemeasurement` (`accounting.ts` lines 1509 to 1541) -/

/-- `value.slice(0, 10)` on an `Instant` (`accounting.ts` line 1513), as the UTF-16 code units that
JavaScript compares: the first ten of them (all of them when there are fewer). -/
def instantDatePrefix (value : Instant) : List UInt16 := (stringToUTF16 value.value).take 10

/-- The matching rule of `MonetaryClassificationPolicy` when `classificationSelected` succeeded and
found exactly one rule for `positionAccountId` whose classification agrees with `expected`. -/
def classificationRuleValid (classificationPolicy : MonetaryClassificationPolicy)
    (positionAccountId : AccountId) (expected : MonetaryClassification) : Bool :=
  match classificationPolicy.rules.filter (fun rule => rule.accountId == positionAccountId) with
  | [rule] => rule.classification == expected
  | _ => false

/-- The two postings of a generated journal (lines 1526 and 1527, 1537 and 1538): the position
account takes `difference` and the gain or loss account takes `-difference`, each as units of the
functional commodity `commodityId` and as the same exact book value. -/
def remeasurementPostings (commodityId : CommodityId) (positionAccountId gainLossAccountId : AccountId)
    (positionId gainLossId : PostingId) (difference : ExactRational) : List ExactPreparedPosting :=
  [{ id := positionId
     accountId := positionAccountId
     units := difference
     unitsCommodityId := commodityId
     exactBookValue := difference
     costBasis := none },
   { id := gainLossId
     accountId := gainLossAccountId
     units := difference.negate
     unitsCommodityId := commodityId
     exactBookValue := difference.negate
     costBasis := none }]

/-- The account a reversal of `original` posts to (line 1527):
`originalGain ? (original.policy?.gainAccountId ?? policy.gainAccountId) :
(original.policy?.lossAccountId ?? policy.lossAccountId)`, where `originalGain` is that the original
difference is positive. The accounts of the policy the original recorded are used when it recorded
one, and those of the current policy when it did not. -/
def reversalGainLossAccount (policy : CurrencyPolicy) (original : RemeasurementResult) : AccountId :=
  let originalGain := original.difference.compare ExactRational.zero == .gt
  match original.policy with
  | some origPolicy => if originalGain then origPolicy.gainAccountId else origPolicy.lossAccountId
  | none => if originalGain then policy.gainAccountId else policy.lossAccountId

/-- The effect of a reversal (lines 1521 and 1522): the body, with `originalEffectKey` present
exactly when `original.adjustmentEffectKey` is, and its content hash,
`{...body, contentHash: accountingHash("RemeasurementReversal", body)}`. -/
def reversalEffectOf (request : CurrencyRemeasurementRequest) (original : RemeasurementResult)
    (reversalId : RemeasurementReversalId) (originalJournalId : JournalId) : RemeasurementReversal :=
  let body : RemeasurementReversal :=
    { id := reversalId
      originalResultId := original.id
      originalJournalId := some originalJournalId
      originalEffectKey := original.adjustmentEffectKey
      reversedOn := request.effectiveOn
      derivation := request.derivation
      contentHash := default }
  { body with contentHash := accountingBodyHash "RemeasurementReversal" body }

/-- The prepared journal of a reversal (lines 1523 to 1528): the original difference negated. -/
def reversalJournalOf (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (policy : CurrencyPolicy) (original : RemeasurementResult) (journalId' : JournalId)
    (positionId gainLossId : PostingId) : ExactPreparedJournal :=
  { requiredQuantizationPolicy := none
    id := journalId'
    kind := .reversing
    economicAt := request.governedAt
    accountingDate := request.effectiveOn
    recordedAt := request.governedAt
    narration := "Currency remeasurement reversal"
    postings := remeasurementPostings commodityId request.positionAccountId
      (reversalGainLossAccount policy original) positionId gainLossId original.difference.negate
    derivations := [request.derivation] }

/-- The reversal branch of `calculateCurrencyRemeasurement` (`accounting.ts` lines 1516 to 1530). -/
def draftCurrencyReversal (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (policy : CurrencyPolicy) (state : CurrencyAccountingState)
    (reversalOfId : RemeasurementResultId) : Except CurrencyErr AccountingCalculation :=
  match state.remeasurementResults.find? (fun item => item.id == reversalOfId) with
  | none => .ok (.rejected [currencyReversalDiagnostic])
  | some original =>
    if original.kind != .unrealized || request.reversalId.isNone ||
        state.remeasurementReversals.any (fun item => item.originalResultId == original.id) then
      .ok (.rejected [currencyReversalDiagnostic])
    else
      match request.reversalId with
      | none => .ok (.rejected [currencyReversalDiagnostic])
      | some revId =>
        match liftCurrencyCanonicalErr (journalId (original.id.value ++ "-journal")) with
        | .error e => .error e
        | .ok origJournalId =>
          match liftCurrencyCanonicalErr (journalId (revId.value ++ "-journal")) with
          | .error e => .error e
          | .ok revJournalId =>
            match liftCurrencyCanonicalErr (postingId (revId.value ++ "-position")) with
            | .error e => .error e
            | .ok posId =>
              match liftCurrencyCanonicalErr (postingId (revId.value ++ "-gain-loss")) with
              | .error e => .error e
              | .ok glId =>
                .ok (drafted
                  [reversalJournalOf commodityId request policy original revJournalId posId glId]
                  [.remeasurementReversal (reversalEffectOf request original revId origJournalId)])

/-- The effect of a remeasurement (lines 1533 and 1534): the body, with `sourcePostingId`, `source` and
`adjustmentEffectKey` present exactly when the request has `sourcePostingId`, `source` and
`generatedEffectKey`, and its content hash, `{...body, contentHash: accountingHash("RemeasurementResult",
body)}`. -/
def remeasurementResultOf (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (classificationPolicy : MonetaryClassificationPolicy) (measured difference : ExactRational) :
    RemeasurementResult :=
  let body : RemeasurementResult :=
    { id := request.id
      kind := request.kind
      sourcePostingId := request.sourcePostingId
      source := request.source
      positionAccountId := some request.positionAccountId
      denominationCommodityId := some request.denominationCommodityId
      effectiveOn := request.effectiveOn
      adjustmentEffectKey := request.generatedEffectKey
      carryingBookValue := request.carryingBookValue
      measuredBookValue := measured
      difference := difference
      valuationRate := request.valuationPath.rate
      policyId := policy.id
      policy := some policy
      classificationPolicy := some classificationPolicy
      valuationPath := some request.valuationPath
      derivation := request.derivation
      contentHash := default }
  { body with contentHash := accountingBodyHash "RemeasurementResult" body }

/-- The prepared journal of a remeasurement (lines 1535 to 1539): an adjustment for an unrealized
result and an ordinary journal for a realized one; the gain account when the difference is positive
and the loss account otherwise (a zero difference included). -/
def remeasurementJournalOf (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (policy : CurrencyPolicy) (difference : ExactRational) (journalId' : JournalId)
    (positionId gainLossId : PostingId) : ExactPreparedJournal :=
  let gain := difference.compare ExactRational.zero == .gt
  { requiredQuantizationPolicy := none
    id := journalId'
    kind := if request.kind == .unrealized then .adjustment else .ordinary
    economicAt := request.governedAt
    accountingDate := request.effectiveOn
    recordedAt := request.governedAt
    narration := request.kind.text ++ " currency remeasurement"
    postings := remeasurementPostings commodityId request.positionAccountId
      (if gain then policy.gainAccountId else policy.lossAccountId) positionId gainLossId difference
    derivations := [request.derivation] }

/-- The non-reversal branch of `calculateCurrencyRemeasurement` (`accounting.ts` lines 1531 to
1540). -/
def draftCurrencyResult (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (policy : CurrencyPolicy) (classificationPolicy : MonetaryClassificationPolicy) :
    Except CurrencyErr AccountingCalculation :=
  match liftCurrencyNumErr (request.denomination.multiply request.valuationPath.rate) with
  | .error e => .error e
  | .ok measured =>
    match liftCurrencyNumErr (measured.subtract request.carryingBookValue) with
    | .error e => .error e
    | .ok difference =>
      match liftCurrencyCanonicalErr (journalId (request.id.value ++ "-journal")) with
      | .error e => .error e
      | .ok jId =>
        match liftCurrencyCanonicalErr (postingId (request.id.value ++ "-position")) with
        | .error e => .error e
        | .ok posId =>
          match liftCurrencyCanonicalErr (postingId (request.id.value ++ "-gain-loss")) with
          | .error e => .error e
          | .ok glId =>
            .ok (drafted [remeasurementJournalOf commodityId request policy difference jId posId glId]
              [.remeasurementResult
                (remeasurementResultOf request policy classificationPolicy measured difference)])

/-- `calculateCurrencyRemeasurement` (`accounting.ts` line 1509). -/
def calculateCurrencyRemeasurement (policies : List AccountingPolicy) (bookId : BookId)
    (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (state : CurrencyAccountingState := emptyCurrencyAccountingState) :
    Except CurrencyErr AccountingCalculation :=
  let selected := policyAt CurrencyPolicy policies request.policyId request.policyVersion
    request.governedAt
  let classificationSelected := policyAt MonetaryClassificationPolicy policies
    request.classificationPolicyId request.classificationPolicyVersion request.governedAt
  match selected, classificationSelected with
  | .selected policy, .selected classificationPolicy =>
    if !validAccountingDerivation request.derivation ||
        !classificationRuleValid classificationPolicy request.positionAccountId
          request.classification ||
        request.classification != .monetary ||
        request.valuationPath.fromCommodityId != request.denominationCommodityId ||
        request.valuationPath.toCommodityId != commodityId ||
        instantDatePrefix request.valuationPath.effectiveAt !=
          stringToUTF16 request.effectiveOn.value ||
        jsStringLt request.governedAt.value request.valuationPath.observedAt.value ||
        request.valuationPath.evidenceIds.isEmpty ||
        !positive request.valuationPath.rate then
      .ok (.rejected [currencyInputDiagnostic])
    else if policy.bookId != bookId then
      .ok (.rejected [currencyPolicyBookDiagnostic])
    else
      match request.reversalOf with
      | some reversalOfId => draftCurrencyReversal commodityId request policy state reversalOfId
      | none => draftCurrencyResult commodityId request policy classificationPolicy
  | _, _ => .ok (.rejected [currencyInputDiagnostic])

/-! ## Meaning: constructible values and semantic conditions -/

/-- A constructible currency remeasurement request: every exact number in it is constructible and
every identifier in it is valid. -/
structure CurrencyRemeasurementRequest.WF (request : CurrencyRemeasurementRequest) : Prop where
  id : request.id.WF
  policyId : request.policyId.WF
  classificationPolicyId : request.classificationPolicyId.WF
  sourcePostingId : ∀ id, request.sourcePostingId = some id → id.WF
  source : ∀ source, request.source = some source → source.WF
  denominationCommodityId : request.denominationCommodityId.WF
  denomination : request.denomination.WF
  carryingBookValue : request.carryingBookValue.WF
  valuationPath : request.valuationPath.WF
  positionAccountId : request.positionAccountId.WF
  derivation : request.derivation.WF
  reversalOf : ∀ id, request.reversalOf = some id → id.WF
  reversalId : ∀ id, request.reversalId = some id → id.WF

/-- A currency accounting state every retained artifact of which is constructible. -/
structure CurrencyAccountingState.WF (state : CurrencyAccountingState) : Prop where
  remeasurementResults : ∀ result ∈ state.remeasurementResults, result.WF
  remeasurementReversals : ∀ reversal ∈ state.remeasurementReversals, reversal.WF

/-- The empty currency accounting state is constructible. -/
theorem emptyCurrencyAccountingState_wf : emptyCurrencyAccountingState.WF :=
  ⟨(fun _ h => by cases h), (fun _ h => by cases h)⟩

/-- A constructible full accounting state projects to a constructible currency accounting state. -/
theorem AccountingCanonicalState.WF.toCurrency {state : AccountingCanonicalState} (h : state.WF) :
    state.toCurrencyAccountingState.WF :=
  ⟨h.remeasurementResults, h.remeasurementReversals⟩

/-- The total of the exact book values of a list of prepared postings, as a rational number. -/
def preparedBookValueTotal (postings : List ExactPreparedPosting) : ℚ :=
  (postings.map (·.exactBookValue.toRat)).sum

/-- The total of the units of a list of prepared postings, as a rational number. -/
def preparedUnitsTotal (postings : List ExactPreparedPosting) : ℚ :=
  (postings.map (·.units.toRat)).sum

/-- What `policyAt` asks of a `CurrencyPolicy`, unpacked. -/
def CurrencyPolicySelected (policies : List AccountingPolicy) (id : PolicyId)
    (version : SemanticVersion) (at_ : Instant) (policy : CurrencyPolicy) : Prop :=
  policyAt CurrencyPolicy policies id version at_ = .selected policy

/-- What `policyAt` asks of a `MonetaryClassificationPolicy`, unpacked. -/
def ClassificationPolicySelected (policies : List AccountingPolicy) (id : PolicyId)
    (version : SemanticVersion) (at_ : Instant) (policy : MonetaryClassificationPolicy) :
    Prop :=
  policyAt MonetaryClassificationPolicy policies id version at_ = .selected policy

/-- The condition under which `calculateCurrencyRemeasurement` accepts the request inputs before
checking `policy.bookId` (`accounting.ts` lines 1510 to 1513). -/
structure CurrencyInputValid (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (classificationPolicy : MonetaryClassificationPolicy) : Prop where
  policy_selected :
    CurrencyPolicySelected policies request.policyId request.policyVersion request.governedAt policy
  classification_policy_selected :
    ClassificationPolicySelected policies request.classificationPolicyId
      request.classificationPolicyVersion request.governedAt classificationPolicy
  derivation_valid : validAccountingDerivation request.derivation = true
  unique_account_rule : ∃ rule,
    classificationPolicy.rules.filter (fun r => r.accountId == request.positionAccountId) =
      [rule] ∧ rule.classification = request.classification
  classification_monetary : request.classification = .monetary
  path_from : request.valuationPath.fromCommodityId = request.denominationCommodityId
  path_to : request.valuationPath.toCommodityId = commodityId
  path_effective_date :
    instantDatePrefix request.valuationPath.effectiveAt = stringToUTF16 request.effectiveOn.value
  path_observed_not_after :
    jsStringLt request.governedAt.value request.valuationPath.observedAt.value = false
  path_evidence_nonempty : request.valuationPath.evidenceIds ≠ []
  path_rate_positive : positive request.valuationPath.rate = true

/-- Existential form of `CurrencyInputValid`: there exist matching selected policies passing line
1513. -/
def CurrencyInputsAccepted (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) : Prop :=
  ∃ policy classificationPolicy,
    CurrencyInputValid policies commodityId request policy classificationPolicy

/-- The condition under which a reversal request (`request.reversalOf = some reversalOfId`) is
admitted (`accounting.ts` lines 1517 to 1520). -/
def ReversalAdmissible (state : CurrencyAccountingState) (reversalOfId : RemeasurementResultId)
    (reversalId : Option RemeasurementReversalId) : Prop :=
  ∃ original revId,
    state.remeasurementResults.find? (fun item => item.id == reversalOfId) = some original ∧
    original.kind = .unrealized ∧
    reversalId = some revId ∧
    ∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id

/-! ## Laws: derived identifiers and instant date prefixes -/

/-- Appending a nonempty non-whitespace non-control suffix to a well-formed identifier yields a
well-formed identifier whenever the concatenated text remains in Unicode NFC form. -/
theorem identifier_append_suffix_of_isNFC (Kind : String) {K : String} (id : Identifier K)
    (suf : String) (hid : id.WF) (hsuf_ne : suf ≠ "")
    (hsuf_clean : ∀ c ∈ suf.toList, isJsWhitespace c = false ∧ isControlChar c = false)
    (hnfc : isNFC (id.value ++ suf) = true) :
    identifier Kind (id.value ++ suf) = .ok ⟨id.value ++ suf⟩ ∧
      (⟨id.value ++ suf⟩ : Identifier Kind).WF := by
  have hne : id.value ++ suf ≠ "" := by
    intro h
    have := congrArg String.length h
    simp at this
    exact hid.nonempty this.1
  have hid_ne : id.value.toList ≠ [] := fun h =>
    hid.nonempty (by rw [← String.ofList_toList (s := id.value), h])
  have hsuf_list_ne : suf.toList ≠ [] := fun h =>
    hsuf_ne (by rw [← String.ofList_toList (s := suf), h])
  have hid_head : isJsWhitespace (id.value.toList.head hid_ne) = false :=
    ((jsTrim_eq_self_iff id.value hid.nonempty).mp hid.no_boundary_whitespace hid_ne).1
  have htrim : jsTrim (id.value ++ suf) = id.value ++ suf := by
    rw [jsTrim_eq_self_iff _ hne]
    intro hcat
    simp only [String.toList_append]
    rw [List.head_append_of_ne_nil hid_ne,
      List.getLast_append_of_ne_nil (by simp [hsuf_list_ne]) hsuf_list_ne]
    exact ⟨hid_head, (hsuf_clean _ (List.getLast_mem hsuf_list_ne)).1⟩
  have hctrl : ∀ c ∈ (id.value ++ suf).toList, isControlChar c = false := by
    intro c hc
    rw [String.toList_append, List.mem_append] at hc
    rcases hc with hc | hc
    · exact hid.no_control_chars c hc
    · exact (hsuf_clean c hc).2
  have hwf : (⟨id.value ++ suf⟩ : Identifier Kind).WF :=
    ⟨hne, htrim, hnfc, hctrl⟩
  exact ⟨(identifier_ok_iff Kind _ _).mpr ⟨hwf, rfl⟩, hwf⟩

/-- When an identifier is pure ASCII, appending `"-journal"`, `"-position"`, or `"-gain-loss"`
unconditionally yields a well-formed identifier. -/
theorem identifier_append_ascii (Kind : String) {K : String} (id : Identifier K) (suf : String)
    (hid : id.WF) (hascii : ∀ c ∈ id.value.toList, c.toNat < 128) (hsuf_ne : suf ≠ "")
    (hsuf_clean : ∀ c ∈ suf.toList,
      c.toNat < 128 ∧ isJsWhitespace c = false ∧ isControlChar c = false) :
    identifier Kind (id.value ++ suf) = .ok ⟨id.value ++ suf⟩ ∧
      (⟨id.value ++ suf⟩ : Identifier Kind).WF := by
  have hnfc : isNFC (id.value ++ suf) = true := by
    apply ascii_isNFC
    intro c hc
    rw [String.toList_append, List.mem_append] at hc
    rcases hc with hc | hc
    · exact hascii c hc
    · exact (hsuf_clean c hc).1
  exact identifier_append_suffix_of_isNFC Kind id suf hid hsuf_ne
    (fun c hc => ⟨(hsuf_clean c hc).2.1, (hsuf_clean c hc).2.2⟩) hnfc

/-- A `"-journal"` identifier suffix has no whitespace, control characters, or non-ASCII characters. -/
theorem suffix_journal_clean : ∀ c ∈ ("-journal").toList,
    c.toNat < 128 ∧ isJsWhitespace c = false ∧ isControlChar c = false := by
  intro c hc
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  cases hc

/-- A `"-position"` identifier suffix has no whitespace, control characters, or non-ASCII characters. -/
theorem suffix_position_clean : ∀ c ∈ ("-position").toList,
    c.toNat < 128 ∧ isJsWhitespace c = false ∧ isControlChar c = false := by
  intro c hc
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  cases hc

/-- A `"-gain-loss"` identifier suffix has no whitespace, control characters, or non-ASCII characters. -/
theorem suffix_gain_loss_clean : ∀ c ∈ ("-gain-loss").toList,
    c.toNat < 128 ∧ isJsWhitespace c = false ∧ isControlChar c = false := by
  intro c hc
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  rcases List.mem_cons.mp hc with rfl | hc
  · decide
  cases hc

/-- A digit character is one UTF-16 code unit. -/
private theorem charToUTF16_digitChar {n : Nat} (h : n < 10) :
    charToUTF16 (digitChar n) = [UInt16.ofNat (48 + n)] := by
  have h1 : 48 + n < 0x10000 := by omega
  simp [charToUTF16, digitChar_toNat h, h1]

/-- The ten characters of a date are ten UTF-16 code units. -/
private theorem date_chars_utf16_length (d : CalendarDate) :
    (d.chars.flatMap charToUTF16).length = 10 := by
  simp only [CalendarDate.chars, List.flatMap_cons, List.flatMap_nil, List.append_nil,
    charToUTF16_digitChar (Nat.mod_lt _ (by decide : 0 < 10))]
  simp [charToUTF16]

/-- For a well-formed `Instant`, `instantDatePrefix` is the code units of the `YYYY-MM-DD` date text
of its fields: so the check `effectiveAt.slice(0, 10) !== effectiveOn` of line 1513 passes exactly
when `effectiveOn` is that date. -/
theorem instantDatePrefix_of_wf {i : Instant} (h : i.WF) :
    instantDatePrefix i = stringToUTF16 i.toFields.date.format := by
  obtain ⟨hf, hfmt⟩ := h.toFields_spec
  unfold instantDatePrefix
  rw [← hfmt]
  simp only [InstantFields.format, InstantFields.chars, CalendarDate.format, stringToUTF16,
    String.toList_ofList, List.flatMap_append, List.cons_append, List.append_assoc]
  rw [List.take_append_of_le_length (by rw [date_chars_utf16_length]), List.take_of_length_le
    (by rw [date_chars_utf16_length])]

/-- The check `observedAt > governedAt` of line 1513 compares texts, not moments: an observation at 03:00 UTC, three hours after a governed time of 05:00+05:00 (midnight UTC), is not refused, and an observation at 01:00+05:00 (20:00 UTC the day before), before a governed time of midnight UTC, is refused. -/
theorem observedAt_check_is_not_a_time_order :
    jsStringLt "2026-01-31T05:00:00+05:00" "2026-01-31T03:00:00Z" = false ∧
      instantMillis ⟨"2026-01-31T03:00:00Z"⟩ = .ok 1769828400000 ∧
      instantMillis ⟨"2026-01-31T05:00:00+05:00"⟩ = .ok 1769817600000 ∧
      jsStringLt "2026-01-31T00:00:00Z" "2026-01-31T01:00:00+05:00" = true ∧
      instantMillis ⟨"2026-01-31T01:00:00+05:00"⟩ = .ok 1769803200000 ∧
      instantMillis ⟨"2026-01-31T00:00:00Z"⟩ = .ok 1769817600000 := by
  decide +kernel

/-! ## Laws: policy selection and input checks -/

/-- Any policy selected by `policyAt` comes from `policies`. -/
private theorem policyAt_mem {T : Type} [AccountingPolicyKind T]
    {policies : List AccountingPolicy} {id : PolicyId} {version : SemanticVersion} {at_ : Instant}
    {policy : T} (h : policyAt T policies id version at_ = .selected policy) :
    ∃ p ∈ policies, AccountingPolicyKind.ofPolicy? p = some policy := by
  unfold policyAt at h
  dsimp only at h
  cases hfilt : policies.filter (policyMatches (AccountingPolicyKind.kind T) id version at_) with
  | nil => simp [hfilt] at h
  | cons p rest =>
    cases rest with
    | cons _ _ => simp [hfilt] at h
    | nil =>
      rw [hfilt] at h
      by_cases hexec : policyExecutable (AccountingPolicyKind.kind T) p = true
      · simp only [hexec, ↓reduceIte] at h
        cases hof : (AccountingPolicyKind.ofPolicy? p : Option T) with
        | none => simp [hof] at h
        | some found =>
          simp only [hof, AccountingPolicySelection.selected.injEq] at h
          subst h
          have hmem : p ∈ policies.filter
              (policyMatches (AccountingPolicyKind.kind T) id version at_) := by
            rw [hfilt]; simp
          exact ⟨p, (List.mem_filter.mp hmem).1, hof⟩
      · simp [hexec] at h

/-- `policyAt` for `CurrencyPolicy` returns a policy from `policies`. -/
theorem policyAt_currency_mem {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {policy : CurrencyPolicy}
    (h : policyAt CurrencyPolicy policies id version at_ = .selected policy) :
    AccountingPolicy.currencyRemeasurement policy ∈ policies := by
  obtain ⟨p, hmem, hp⟩ := policyAt_mem h
  cases p <;> simp_all [AccountingPolicyKind.ofPolicy?]

/-- If every policy in `policies` is constructible, any `CurrencyPolicy` selected by `policyAt` is
constructible. -/
theorem policyAt_currency_wf {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {policy : CurrencyPolicy}
    (hw : ∀ p ∈ policies, p.WF)
    (h : policyAt CurrencyPolicy policies id version at_ = .selected policy) : policy.WF :=
  hw (.currencyRemeasurement policy) (policyAt_currency_mem h)

/-- `policyAt` for `MonetaryClassificationPolicy` returns a policy from `policies`. -/
theorem policyAt_classification_mem {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {policy : MonetaryClassificationPolicy}
    (h : policyAt MonetaryClassificationPolicy policies id version at_ = .selected policy) :
    AccountingPolicy.monetaryClassification policy ∈ policies := by
  obtain ⟨p, hmem, hp⟩ := policyAt_mem h
  cases p <;> simp_all [AccountingPolicyKind.ofPolicy?]

/-- If every policy in `policies` is constructible, any `MonetaryClassificationPolicy` selected by
`policyAt` is constructible. -/
theorem policyAt_classification_wf {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {policy : MonetaryClassificationPolicy}
    (hw : ∀ p ∈ policies, p.WF)
    (h : policyAt MonetaryClassificationPolicy policies id version at_ = .selected policy) :
    policy.WF :=
  hw (.monetaryClassification policy) (policyAt_classification_mem h)

/-- `classificationRuleValid` passes iff there is a unique rule for `positionAccountId` and its
classification equals `expected`. -/
theorem classificationRuleValid_iff (policy : MonetaryClassificationPolicy)
    (positionAccountId : AccountId) (expected : MonetaryClassification) :
    classificationRuleValid policy positionAccountId expected = true ↔
      ∃ rule, policy.rules.filter (fun r => r.accountId == positionAccountId) = [rule] ∧
        rule.classification = expected := by
  unfold classificationRuleValid
  cases hfilt : policy.rules.filter (fun r => r.accountId == positionAccountId) with
  | nil => simp
  | cons rule rest =>
    cases rest with
    | nil => simp
    | cons _ _ => simp

/-- The three diagnostics of `calculateCurrencyRemeasurement` are pairwise distinct. -/
theorem currencyDiagnostics_pairwise_ne :
    currencyInputDiagnostic ≠ currencyPolicyBookDiagnostic ∧
    currencyInputDiagnostic ≠ currencyReversalDiagnostic ∧
    currencyPolicyBookDiagnostic ≠ currencyReversalDiagnostic := by
  refine ⟨?_, ?_, ?_⟩ <;> intro h <;> have := congrArg SemanticDiagnostic.path h <;>
    simp [currencyInputDiagnostic, currencyPolicyBookDiagnostic, currencyReversalDiagnostic,
      diagnostic] at this

/-- When `CurrencyInputValid` holds, `calculateCurrencyRemeasurement` passes the first rejection
check and proceeds to the policy-book check. -/
theorem calculateCurrencyRemeasurement_of_inputValid {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {policy : CurrencyPolicy}
    {classificationPolicy : MonetaryClassificationPolicy}
    (hv : CurrencyInputValid policies commodityId request policy classificationPolicy) :
    calculateCurrencyRemeasurement policies bookId commodityId request state =
      if policy.bookId != bookId then .ok (.rejected [currencyPolicyBookDiagnostic])
      else
        match request.reversalOf with
        | some reversalOfId => draftCurrencyReversal commodityId request policy state reversalOfId
        | none => draftCurrencyResult commodityId request policy classificationPolicy := by
  unfold calculateCurrencyRemeasurement
  rw [hv.policy_selected, hv.classification_policy_selected]
  have hrule := (classificationRuleValid_iff classificationPolicy request.positionAccountId
      request.classification).mpr hv.unique_account_rule
  rw [hv.classification_monetary] at hrule
  have hev : request.valuationPath.evidenceIds.isEmpty = false :=
    List.isEmpty_eq_false_iff.mpr hv.path_evidence_nonempty
  simp only [hv.derivation_valid, hv.classification_monetary, hrule, hv.path_from, hv.path_to,
    hv.path_effective_date, hv.path_observed_not_after, hev, hv.path_rate_positive,
    Bool.not_true, bne_self_eq_false, Bool.or_false, Bool.false_eq_true, ↓reduceIte]

/-- If `calculateCurrencyRemeasurement` passes the first check, `CurrencyInputsAccepted` holds. -/
private theorem inputsAccepted_of_step1 {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState}
    (hne : calculateCurrencyRemeasurement policies bookId commodityId request state ≠
      .ok (.rejected [currencyInputDiagnostic])) :
    CurrencyInputsAccepted policies commodityId request := by
  unfold calculateCurrencyRemeasurement at hne
  cases hs : policyAt CurrencyPolicy policies request.policyId request.policyVersion
      request.governedAt with
  | rejected _ => simp [hs] at hne
  | selected policy =>
    cases hc : policyAt MonetaryClassificationPolicy policies request.classificationPolicyId
        request.classificationPolicyVersion request.governedAt with
    | rejected _ => simp [hs, hc] at hne
    | selected classificationPolicy =>
      simp only [hs, hc] at hne
      split at hne
      · exact absurd rfl hne
      · rename_i hfail
        simp only [Bool.or_eq_true, not_or] at hfail
        obtain ⟨⟨⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩, h7⟩, h8⟩, h9⟩ := hfail
        exact ⟨policy, classificationPolicy,
          ⟨hs, hc, by simpa using h1, (classificationRuleValid_iff _ _ _).mp (by simpa using h2),
            by simpa using h3, by simpa using h4, by simpa using h5, by simpa using h6,
            by simpa using h7, by simpa using h8, by simpa using h9⟩⟩

/-- `draftCurrencyResult` never rejects: it either throws an error or produces a draft. -/
theorem draftCurrencyResult_ne_rejected (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (classificationPolicy : MonetaryClassificationPolicy) (diags : List SemanticDiagnostic) :
    draftCurrencyResult commodityId request policy classificationPolicy ≠ .ok (.rejected diags) := by
  unfold draftCurrencyResult
  repeat (first | split |
    (intro h; simp only [Except.ok.injEq, drafted, immutableAccountingValue] at h; cases h) |
    (intro h; cases h))

/-- If `draftCurrencyReversal` rejects, its diagnostic list is `[currencyReversalDiagnostic]`. -/
theorem draftCurrencyReversal_rejected_eq {commodityId : CommodityId}
    {request : CurrencyRemeasurementRequest} {policy : CurrencyPolicy}
    {state : CurrencyAccountingState} {reversalOfId : RemeasurementResultId}
    {diags : List SemanticDiagnostic}
    (h : draftCurrencyReversal commodityId request policy state reversalOfId =
      .ok (.rejected diags)) :
    diags = [currencyReversalDiagnostic] := by
  unfold draftCurrencyReversal at h
  cases hfind : state.remeasurementResults.find? (fun item => item.id == reversalOfId) <;>
    simp only [hfind] at h
  · exact (AccountingCalculation.rejected.inj (Except.ok.inj h)).symm
  · split at h
    · exact (AccountingCalculation.rejected.inj (Except.ok.inj h)).symm
    · cases hrev : request.reversalId <;> simp only [hrev] at h
      · exact (AccountingCalculation.rejected.inj (Except.ok.inj h)).symm
      · repeat (first | split at h |
          (exfalso; simp only [Except.ok.injEq, drafted, immutableAccountingValue] at h; cases h) |
          (exfalso; cases h))

/-- A reversal draft is rejected with `currencyReversalDiagnostic` iff `ReversalAdmissible`
fails (`accounting.ts` lines 1517 to 1520). -/
theorem draftCurrencyReversal_rejected_iff (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (state : CurrencyAccountingState) (reversalOfId : RemeasurementResultId) :
    draftCurrencyReversal commodityId request policy state reversalOfId =
      .ok (.rejected [currencyReversalDiagnostic]) ↔
      ¬ ReversalAdmissible state reversalOfId request.reversalId := by
  constructor
  · intro h ⟨original, revId, hfind, hkind, hrev, hno⟩
    unfold draftCurrencyReversal at h
    have hany : state.remeasurementReversals.any
        (fun item => item.originalResultId == original.id) = false := by
      rw [List.any_eq_false]
      intro item hmem
      simp [hno item hmem]
    simp only [hfind, hkind, hrev, hany, bne_self_eq_false, Option.isNone_some,
      Bool.or_false, Bool.false_eq_true, ↓reduceIte] at h
    repeat (first | split at h | (simp [drafted, immutableAccountingValue] at h))
  · intro hna
    unfold draftCurrencyReversal
    cases hfind : state.remeasurementResults.find? (fun item => item.id == reversalOfId) with
    | none => rfl
    | some original =>
      by_cases hkind : original.kind = .unrealized
      · cases hrev : request.reversalId with
        | none => simp [hkind]
        | some revId =>
          cases hany : state.remeasurementReversals.any
              (fun item => item.originalResultId == original.id) with
          | true => simp [hkind, hany]
          | false =>
            exfalso
            apply hna
            refine ⟨original, revId, hfind, hkind, hrev, ?_⟩
            intro item hmem heq
            have hfalse := (List.any_eq_false.mp hany) item hmem
            simp [heq] at hfalse
      · have hne : (original.kind != .unrealized) = true := by simpa [bne_iff_ne] using hkind
        simp [hne]

/-- `calculateCurrencyRemeasurement` rejects with `currencyInputDiagnostic` iff
`CurrencyInputsAccepted` fails (`accounting.ts` lines 1510 to 1513). -/
theorem calculateCurrencyRemeasurement_rejected_input_iff (policies : List AccountingPolicy)
    (bookId : BookId) (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (state : CurrencyAccountingState) :
    calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.rejected [currencyInputDiagnostic]) ↔
      ¬ CurrencyInputsAccepted policies commodityId request := by
  constructor
  · intro h ⟨policy, cp, hv⟩
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [h] at hstep
    split at hstep
    · have := congrArg (fun x => match x with | .ok (.rejected ds) => ds | _ => []) hstep
      simp only at this
      exact currencyDiagnostics_pairwise_ne.1 (List.cons.inj this).1
    · cases hrev : request.reversalOf with
      | none =>
        rw [hrev] at hstep
        exact draftCurrencyResult_ne_rejected _ _ _ _ _ hstep.symm
      | some reversalOfId =>
        rw [hrev] at hstep
        have heq := draftCurrencyReversal_rejected_eq hstep.symm
        exact currencyDiagnostics_pairwise_ne.2.1 (List.cons.inj heq).1
  · intro hnot
    by_contra hne
    exact hnot (inputsAccepted_of_step1 hne)

/-- `calculateCurrencyRemeasurement` rejects with `currencyPolicyBookDiagnostic` iff the inputs
are accepted and the selected currency policy belongs to another book (`accounting.ts` line
1515). -/
theorem calculateCurrencyRemeasurement_rejected_policyBook_iff (policies : List AccountingPolicy)
    (bookId : BookId) (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (state : CurrencyAccountingState) :
    calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.rejected [currencyPolicyBookDiagnostic]) ↔
      ∃ policy cp,
        CurrencyInputValid policies commodityId request policy cp ∧ policy.bookId ≠ bookId := by
  constructor
  · intro h
    have hne : calculateCurrencyRemeasurement policies bookId commodityId request state ≠
        .ok (.rejected [currencyInputDiagnostic]) := by
      rw [h]
      intro hEq
      exact currencyDiagnostics_pairwise_ne.1.symm
        (List.cons.inj (AccountingCalculation.rejected.inj (Except.ok.inj hEq))).1
    obtain ⟨policy, cp, hv⟩ := inputsAccepted_of_step1 hne
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [h] at hstep
    split at hstep
    · rename_i hneBook
      exact ⟨policy, cp, hv, by simpa [bne_iff_ne] using hneBook⟩
    · cases hrev : request.reversalOf with
      | none =>
        rw [hrev] at hstep
        exact absurd hstep.symm (draftCurrencyResult_ne_rejected _ _ _ _ _)
      | some reversalOfId =>
        rw [hrev] at hstep
        have heq := draftCurrencyReversal_rejected_eq hstep.symm
        exact absurd (List.cons.inj heq).1 currencyDiagnostics_pairwise_ne.2.2
  · rintro ⟨policy, cp, hv, hneBook⟩
    rw [calculateCurrencyRemeasurement_of_inputValid hv]
    simp [hneBook]

/-- `calculateCurrencyRemeasurement` rejects with `currencyReversalDiagnostic` iff the inputs are
accepted, the currency policy matches `bookId`, a reversal is requested, and `ReversalAdmissible`
fails (`accounting.ts` lines 1516 to 1520). -/
theorem calculateCurrencyRemeasurement_rejected_reversal_iff (policies : List AccountingPolicy)
    (bookId : BookId) (commodityId : CommodityId) (request : CurrencyRemeasurementRequest)
    (state : CurrencyAccountingState) :
    calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.rejected [currencyReversalDiagnostic]) ↔
      ∃ policy cp reversalOfId,
        CurrencyInputValid policies commodityId request policy cp ∧
        policy.bookId = bookId ∧
        request.reversalOf = some reversalOfId ∧
        ¬ ReversalAdmissible state reversalOfId request.reversalId := by
  constructor
  · intro h
    have hne : calculateCurrencyRemeasurement policies bookId commodityId request state ≠
        .ok (.rejected [currencyInputDiagnostic]) := by
      rw [h]
      intro hEq
      exact currencyDiagnostics_pairwise_ne.2.1.symm
        (List.cons.inj (AccountingCalculation.rejected.inj (Except.ok.inj hEq))).1
    obtain ⟨policy, cp, hv⟩ := inputsAccepted_of_step1 hne
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [h] at hstep
    split at hstep
    · have hEq := List.cons.inj (AccountingCalculation.rejected.inj (Except.ok.inj hstep))
      exact absurd hEq.1 currencyDiagnostics_pairwise_ne.2.2.symm
    · cases hrev : request.reversalOf with
      | none =>
        rw [hrev] at hstep
        exact absurd hstep.symm (draftCurrencyResult_ne_rejected _ _ _ _ _)
      | some reversalOfId =>
        rw [hrev] at hstep
        have hrej := (draftCurrencyReversal_rejected_iff _ _ _ _ _).mp hstep.symm
        rename_i hbook
        exact ⟨policy, cp, reversalOfId, hv, by simpa [bne_iff_ne] using hbook, rfl, hrej⟩
  · rintro ⟨policy, cp, reversalOfId, hv, hbook, hrev, hnot⟩
    rw [calculateCurrencyRemeasurement_of_inputValid hv]
    simp [hbook, hrev]
    exact (draftCurrencyReversal_rejected_iff _ _ _ _ _).mpr hnot

/-- A reversal is refused iff the original does not exist, is not `unrealized`, has already been
reversed, or no `reversalId` is given (`accounting.ts` lines 1516 to 1520). -/
theorem calculateCurrencyRemeasurement_reversal_refused_iff {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {policy : CurrencyPolicy}
    {cp : MonetaryClassificationPolicy} {reversalOfId : RemeasurementResultId}
    (hv : CurrencyInputValid policies commodityId request policy cp)
    (hbook : policy.bookId = bookId) (hrev : request.reversalOf = some reversalOfId) :
    (∃ diags, calculateCurrencyRemeasurement policies bookId commodityId request state =
        .ok (.rejected diags)) ↔
      ¬ ReversalAdmissible state reversalOfId request.reversalId := by
  rw [calculateCurrencyRemeasurement_of_inputValid hv]
  simp only [hbook, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hrev]
  constructor
  · rintro ⟨diags, h⟩
    have heq := draftCurrencyReversal_rejected_eq h
    subst heq
    exact (draftCurrencyReversal_rejected_iff _ _ _ _ _).mp h
  · intro hnot
    exact ⟨[currencyReversalDiagnostic],
      (draftCurrencyReversal_rejected_iff _ _ _ _ _).mpr hnot⟩

private theorem find_result_eq_some_of_nodup (results : List RemeasurementResult)
    {reversalOfId : RemeasurementResultId} {original : RemeasurementResult}
    (hnodup : (results.map (·.id)).Nodup) (hmem : original ∈ results)
    (hid : original.id = reversalOfId) :
    results.find? (fun item => item.id == reversalOfId) = some original := by
  induction results with
  | nil => cases hmem
  | cons x xs ih =>
    simp only [List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and] at hnodup
    rcases List.mem_cons.mp hmem with hEq | hmemxs
    · subst hEq
      simp [List.find?, hid]
    · have hxne : x.id ≠ reversalOfId := by
        intro heq
        exact hnodup.1 original hmemxs (hid.trans heq.symm)
      have hbeq : (x.id == reversalOfId) = false := by simp [hxne]
      simp only [List.find?, hbeq]
      exact ih hnodup.2 hmemxs

/-- When stored result identifiers are unique, `ReversalAdmissible` says the original exists in
`state.remeasurementResults` with `id = reversalOfId`, `kind = .unrealized`, a `reversalId` is
given, and no reversal in `state.remeasurementReversals` references it. -/
theorem reversalAdmissible_iff_mem_of_nodup {state : CurrencyAccountingState}
    {reversalOfId : RemeasurementResultId} {reversalId : Option RemeasurementReversalId}
    (hnodup : (state.remeasurementResults.map (·.id)).Nodup) :
    ReversalAdmissible state reversalOfId reversalId ↔
      ∃ original revId,
        original ∈ state.remeasurementResults ∧
        original.id = reversalOfId ∧
        original.kind = .unrealized ∧
        reversalId = some revId ∧
        ∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id := by
  constructor
  · rintro ⟨original, revId, hfind, hkind, hrev, hno⟩
    have hmem := List.mem_of_find?_eq_some hfind
    have hid : original.id = reversalOfId := by
      simpa using List.find?_some hfind
    exact ⟨original, revId, hmem, hid, hkind, hrev, hno⟩
  · rintro ⟨original, revId, hmem, hid, hkind, hrev, hno⟩
    exact ⟨original, revId,
      find_result_eq_some_of_nodup state.remeasurementResults hnodup hmem hid,
      hkind, hrev, hno⟩

/-- Every rejection of `calculateCurrencyRemeasurement` returns one of the three exact diagnostic
singletons (`accounting.ts` lines 1513, 1515, and 1519). -/
theorem calculateCurrencyRemeasurement_rejected_cases {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {diags : List SemanticDiagnostic}
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.rejected diags)) :
    diags = [currencyInputDiagnostic] ∨
    diags = [currencyPolicyBookDiagnostic] ∨
    diags = [currencyReversalDiagnostic] := by
  by_cases h1 : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.rejected [currencyInputDiagnostic])
  · rw [h1] at h
    exact Or.inl (AccountingCalculation.rejected.inj (Except.ok.inj h)).symm
  · obtain ⟨policy, cp, hv⟩ := inputsAccepted_of_step1 h1
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [h] at hstep
    split at hstep
    · exact Or.inr (Or.inl (AccountingCalculation.rejected.inj (Except.ok.inj hstep)))
    · cases hrev : request.reversalOf with
      | none =>
        rw [hrev] at hstep
        exact absurd hstep.symm (draftCurrencyResult_ne_rejected _ _ _ _ _)
      | some reversalOfId =>
        rw [hrev] at hstep
        exact Or.inr (Or.inr (draftCurrencyReversal_rejected_eq hstep.symm))

/-! ## Laws: what is drafted -/

/-- A remeasurement is drafted exactly when the multiplication, the subtraction and the three derived
identifiers return, and then the draft is the one journal and the one result effect built from them
(`accounting.ts` lines 1531 to 1540). -/
theorem draftCurrencyResult_eq_draft_iff (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (cp : MonetaryClassificationPolicy) (d : AccountingDraft) :
    draftCurrencyResult commodityId request policy cp = .ok (.draft d) ↔
      ∃ measured difference jId posId glId,
        request.denomination.multiply request.valuationPath.rate = .ok measured ∧
        measured.subtract request.carryingBookValue = .ok difference ∧
        journalId (request.id.value ++ "-journal") = .ok jId ∧
        postingId (request.id.value ++ "-position") = .ok posId ∧
        postingId (request.id.value ++ "-gain-loss") = .ok glId ∧
        d = { journals :=
                [remeasurementJournalOf commodityId request policy difference jId posId glId]
              effects :=
                [.remeasurementResult (remeasurementResultOf request policy cp measured difference)] } := by
  constructor
  · intro h
    unfold draftCurrencyResult at h
    cases hm : request.denomination.multiply request.valuationPath.rate with
    | error e => simp [liftCurrencyNumErr, hm] at h
    | ok measured =>
      cases hs : measured.subtract request.carryingBookValue with
      | error e => simp [liftCurrencyNumErr, hm, hs] at h
      | ok difference =>
        cases hj : journalId (request.id.value ++ "-journal") with
        | error e => simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hm, hs, hj] at h
        | ok jId =>
          cases hp : postingId (request.id.value ++ "-position") with
          | error e => simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hm, hs, hj, hp] at h
          | ok posId =>
            cases hg : postingId (request.id.value ++ "-gain-loss") with
            | error e =>
              simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hm, hs, hj, hp, hg] at h
            | ok glId =>
              simp only [liftCurrencyNumErr, liftCurrencyCanonicalErr, hm, hs, hj, hp, hg, drafted,
                immutableAccountingValue, Except.ok.injEq, AccountingCalculation.draft.injEq] at h
              exact ⟨measured, difference, jId, posId, glId, rfl, hs, rfl, rfl, rfl, h.symm⟩
  · rintro ⟨measured, difference, jId, posId, glId, hm, hs, hj, hp, hg, rfl⟩
    unfold draftCurrencyResult
    simp only [liftCurrencyNumErr, liftCurrencyCanonicalErr, hm, hs, hj, hp, hg, drafted,
      immutableAccountingValue]

/-- The refusal test of line 1518 is false exactly when the original is `unrealized`, a reversal
identifier is given, and no retained reversal is of the original. -/
theorem reversalRefused_eq_false_iff (original : RemeasurementResult)
    (request : CurrencyRemeasurementRequest) (state : CurrencyAccountingState) :
    (original.kind != .unrealized || request.reversalId.isNone ||
        state.remeasurementReversals.any (fun item => item.originalResultId == original.id)) = false ↔
      original.kind = .unrealized ∧ (∃ revId, request.reversalId = some revId) ∧
        ∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id := by
  cases hrev : request.reversalId with
  | none => simp
  | some revId =>
    simp only [Option.isNone_some, Bool.or_false, Bool.or_eq_false_iff, bne_eq_false_iff_eq,
      List.any_eq_false, beq_iff_eq, Option.some.injEq, exists_eq', true_and]

/-- A reversal is drafted exactly when the original is found, is `unrealized`, a reversal identifier is
given, no retained reversal is of the original and the four derived identifiers return; and then the
draft is the one journal and the one reversal effect built from them (`accounting.ts` lines 1517 to
1529). -/
theorem draftCurrencyReversal_eq_draft_iff (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (state : CurrencyAccountingState) (reversalOfId : RemeasurementResultId)
    (d : AccountingDraft) :
    draftCurrencyReversal commodityId request policy state reversalOfId = .ok (.draft d) ↔
      ∃ original revId origJ revJ posId glId,
        state.remeasurementResults.find? (fun item => item.id == reversalOfId) = some original ∧
        original.kind = .unrealized ∧
        request.reversalId = some revId ∧
        (∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id) ∧
        journalId (original.id.value ++ "-journal") = .ok origJ ∧
        journalId (revId.value ++ "-journal") = .ok revJ ∧
        postingId (revId.value ++ "-position") = .ok posId ∧
        postingId (revId.value ++ "-gain-loss") = .ok glId ∧
        d = { journals := [reversalJournalOf commodityId request policy original revJ posId glId]
              effects := [.remeasurementReversal (reversalEffectOf request original revId origJ)] } := by
  constructor
  · intro h
    unfold draftCurrencyReversal at h
    cases hfind : state.remeasurementResults.find? (fun item => item.id == reversalOfId) with
    | none => simp [hfind] at h
    | some original =>
      simp only [hfind] at h
      by_cases hc : (original.kind != .unrealized || request.reversalId.isNone ||
          state.remeasurementReversals.any (fun item => item.originalResultId == original.id)) = true
      · simp [hc] at h
      · have hc' : (original.kind != .unrealized || request.reversalId.isNone ||
            state.remeasurementReversals.any
              (fun item => item.originalResultId == original.id)) = false :=
          Bool.eq_false_iff.mpr hc
        obtain ⟨hk, ⟨revId, hrev⟩, hno⟩ :=
          (reversalRefused_eq_false_iff original request state).mp hc'
        simp only [hc', Bool.false_eq_true, ↓reduceIte] at h
        simp only [hrev] at h
        cases hj1 : journalId (original.id.value ++ "-journal") with
        | error e => simp [liftCurrencyCanonicalErr, hj1] at h
        | ok origJ =>
          cases hj2 : journalId (revId.value ++ "-journal") with
          | error e => simp [liftCurrencyCanonicalErr, hj1, hj2] at h
          | ok revJ =>
            cases hp : postingId (revId.value ++ "-position") with
            | error e => simp [liftCurrencyCanonicalErr, hj1, hj2, hp] at h
            | ok posId =>
              cases hg : postingId (revId.value ++ "-gain-loss") with
              | error e => simp [liftCurrencyCanonicalErr, hj1, hj2, hp, hg] at h
              | ok glId =>
                simp only [liftCurrencyCanonicalErr, hj1, hj2, hp, hg, drafted,
                  immutableAccountingValue, Except.ok.injEq,
                  AccountingCalculation.draft.injEq] at h
                exact ⟨original, revId, origJ, revJ, posId, glId, rfl, hk, hrev, hno, hj1, hj2, hp,
                  hg, h.symm⟩
  · rintro ⟨original, revId, origJ, revJ, posId, glId, hfind, hk, hrev, hno, hj1, hj2, hp, hg, rfl⟩
    unfold draftCurrencyReversal
    have hc : (original.kind != .unrealized || request.reversalId.isNone ||
        state.remeasurementReversals.any
          (fun item => item.originalResultId == original.id)) = false :=
      (reversalRefused_eq_false_iff original request state).mpr ⟨hk, ⟨revId, hrev⟩, hno⟩
    simp only [hfind, hc, Bool.false_eq_true, ↓reduceIte]
    simp only [hrev, liftCurrencyCanonicalErr, hj1, hj2, hp, hg, drafted, immutableAccountingValue]

/-- A remeasurement (no `reversalOf`) is drafted exactly when the inputs are accepted, the selected
currency policy is of the book, and the non-reversal branch drafts it (`accounting.ts` lines 1510 to
1515 and 1531 to 1540): the conditions are those of the function and no others, and the draft is the
one journal and the one result effect built from the steps. -/
theorem calculateCurrencyRemeasurement_result_iff {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} (hnone : request.reversalOf = none) (d : AccountingDraft) :
    calculateCurrencyRemeasurement policies bookId commodityId request state = .ok (.draft d) ↔
      ∃ policy cp measured difference jId posId glId,
        CurrencyInputValid policies commodityId request policy cp ∧
        policy.bookId = bookId ∧
        request.denomination.multiply request.valuationPath.rate = .ok measured ∧
        measured.subtract request.carryingBookValue = .ok difference ∧
        journalId (request.id.value ++ "-journal") = .ok jId ∧
        postingId (request.id.value ++ "-position") = .ok posId ∧
        postingId (request.id.value ++ "-gain-loss") = .ok glId ∧
        d = { journals :=
                [remeasurementJournalOf commodityId request policy difference jId posId glId]
              effects :=
                [.remeasurementResult (remeasurementResultOf request policy cp measured difference)] } := by
  constructor
  · intro h
    have hne : calculateCurrencyRemeasurement policies bookId commodityId request state ≠
        .ok (.rejected [currencyInputDiagnostic]) := by
      rw [h]
      intro hh
      cases hh
    obtain ⟨policy, cp, hv⟩ := inputsAccepted_of_step1 hne
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [h] at hstep
    split at hstep
    · cases hstep
    · rename_i hbook
      rw [hnone] at hstep
      obtain ⟨measured, difference, jId, posId, glId, hm, hs, hj, hp, hg, hd⟩ :=
        (draftCurrencyResult_eq_draft_iff _ _ _ _ _).mp hstep.symm
      exact ⟨policy, cp, measured, difference, jId, posId, glId, hv,
        by simpa [bne_iff_ne] using hbook, hm, hs, hj, hp, hg, hd⟩
  · rintro ⟨policy, cp, measured, difference, jId, posId, glId, hv, hbook, hm, hs, hj, hp, hg, hd⟩
    rw [calculateCurrencyRemeasurement_of_inputValid hv]
    simp only [hbook, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hnone]
    exact (draftCurrencyResult_eq_draft_iff _ _ _ _ _).mpr
      ⟨measured, difference, jId, posId, glId, hm, hs, hj, hp, hg, hd⟩

/-- A reversal is drafted exactly when the inputs are accepted, the selected currency policy is of the
book and the reversal branch drafts it (`accounting.ts` lines 1510 to 1529): the original must be found
by `reversalOf`, be `unrealized`, have no retained reversal, a `reversalId` must be given, and the four
derived identifiers must return; the draft is then the one journal and the one reversal effect built
from them. -/
theorem calculateCurrencyRemeasurement_reversal_iff {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {reversalOfId : RemeasurementResultId}
    (hrev : request.reversalOf = some reversalOfId) (d : AccountingDraft) :
    calculateCurrencyRemeasurement policies bookId commodityId request state = .ok (.draft d) ↔
      ∃ policy cp original revId origJ revJ posId glId,
        CurrencyInputValid policies commodityId request policy cp ∧
        policy.bookId = bookId ∧
        state.remeasurementResults.find? (fun item => item.id == reversalOfId) = some original ∧
        original.kind = .unrealized ∧
        request.reversalId = some revId ∧
        (∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id) ∧
        journalId (original.id.value ++ "-journal") = .ok origJ ∧
        journalId (revId.value ++ "-journal") = .ok revJ ∧
        postingId (revId.value ++ "-position") = .ok posId ∧
        postingId (revId.value ++ "-gain-loss") = .ok glId ∧
        d = { journals := [reversalJournalOf commodityId request policy original revJ posId glId]
              effects := [.remeasurementReversal (reversalEffectOf request original revId origJ)] } := by
  constructor
  · intro h
    have hne : calculateCurrencyRemeasurement policies bookId commodityId request state ≠
        .ok (.rejected [currencyInputDiagnostic]) := by
      rw [h]
      intro hh
      cases hh
    obtain ⟨policy, cp, hv⟩ := inputsAccepted_of_step1 hne
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [h] at hstep
    split at hstep
    · cases hstep
    · rename_i hbook
      rw [hrev] at hstep
      obtain ⟨original, revId, origJ, revJ, posId, glId, hf, hk, hr, hno, hj1, hj2, hp, hg, hd⟩ :=
        (draftCurrencyReversal_eq_draft_iff _ _ _ _ _ _).mp hstep.symm
      exact ⟨policy, cp, original, revId, origJ, revJ, posId, glId, hv,
        by simpa [bne_iff_ne] using hbook, hf, hk, hr, hno, hj1, hj2, hp, hg, hd⟩
  · rintro ⟨policy, cp, original, revId, origJ, revJ, posId, glId, hv, hbook, hf, hk, hr, hno, hj1,
      hj2, hp, hg, hd⟩
    rw [calculateCurrencyRemeasurement_of_inputValid hv]
    simp only [hbook, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hrev]
    exact (draftCurrencyReversal_eq_draft_iff _ _ _ _ _ _).mpr
      ⟨original, revId, origJ, revJ, posId, glId, hf, hk, hr, hno, hj1, hj2, hp, hg, hd⟩

/-! ## Laws: the journals balance, and what each posting is -/

/-- The two postings of a generated journal have exact book values that add up to zero. -/
theorem remeasurementPostings_balance (commodityId : CommodityId)
    (positionAccountId gainLossAccountId : AccountId) (positionId gainLossId : PostingId)
    (difference : ExactRational) :
    preparedBookValueTotal (remeasurementPostings commodityId positionAccountId gainLossAccountId
      positionId gainLossId difference) = 0 := by
  simp [preparedBookValueTotal, remeasurementPostings, ExactRational.negate_toRat]

/-- The two postings of a generated journal have units that add up to zero. -/
theorem remeasurementPostings_units_balance (commodityId : CommodityId)
    (positionAccountId gainLossAccountId : AccountId) (positionId gainLossId : PostingId)
    (difference : ExactRational) :
    preparedUnitsTotal (remeasurementPostings commodityId positionAccountId gainLossAccountId
      positionId gainLossId difference) = 0 := by
  simp [preparedUnitsTotal, remeasurementPostings, ExactRational.negate_toRat]

/-- Each posting of a generated journal states its amount twice, once as units of the functional
commodity and once as the exact book value, and the two are the same number; it has no cost basis. -/
theorem remeasurementPostings_units_eq_book (commodityId : CommodityId)
    (positionAccountId gainLossAccountId : AccountId) (positionId gainLossId : PostingId)
    (difference : ExactRational) :
    ∀ posting ∈ remeasurementPostings commodityId positionAccountId gainLossAccountId positionId
      gainLossId difference,
      posting.units = posting.exactBookValue ∧ posting.unitsCommodityId = commodityId ∧
        posting.costBasis = none := by
  intro posting hp
  simp only [remeasurementPostings, List.mem_cons, List.not_mem_nil, or_false] at hp
  rcases hp with rfl | rfl <;> simp

/-- A constructible value added to zero is itself. -/
theorem zero_add_of_wf {d : ExactRational} (h : d.WF) : ExactRational.zero.add d = .ok d := by
  have h1 : ExactRational.zero.add d = ExactRational.of d.numerator d.denominator := by
    simp [ExactRational.add, ExactRational.zero]
  obtain ⟨r, hr⟩ := (ExactRational.of_isOk_iff d.numerator d.denominator).mpr
    ⟨h.denominator_pos, Or.inr ⟨h.numerator_within, h.denominator_within⟩⟩
  obtain ⟨hrwf, hrrat, -⟩ := ExactRational.of_ok hr
  have hrd : r = d := ExactRational.eq_of_toRat_eq hrwf h (by rw [hrrat]; rfl)
  rw [h1, hr, hrd]

/-- The kernel's own `sum` of the two exact book values of a generated journal never throws and is
exactly zero. -/
theorem accountingSum_difference_pair {difference : ExactRational} (h : difference.WF) :
    accountingSum [difference, difference.negate] = .ok ExactRational.zero := by
  have h0 : ExactRational.zero.add difference = .ok difference := zero_add_of_wf h
  have h1 : difference.add difference.negate = .ok ExactRational.zero :=
    ExactRational.subtract_self h
  simp [accountingSum, addExactValues, h0, h1]

/- What a posting carries. A prepared posting has `units`, a quantity of `unitsCommodityId`, and `exactBookValue`, its value in the functional
 commodity; this function posts only in the functional commodity (`unitsCommodityId = commodityId`), so the two are the same number, and
 there is no cost basis. The prepared journal is not yet a journal: the book quantizes it and runs journal admission on the result, so
 what holds at this layer is exact balance, which is what a balanced quantization starts from. -/
/-- Every journal the function drafts, for a remeasurement or for a reversal, has two postings whose exact book values add up to zero and whose units add up to zero, each posting stating one amount of the functional commodity as its units and as its exact book value. -/
theorem calculateCurrencyRemeasurement_journal_balances {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft}
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ journal, d.journals = [journal] ∧ journal.postings.length = 2 ∧
      preparedBookValueTotal journal.postings = 0 ∧ preparedUnitsTotal journal.postings = 0 ∧
      ∀ posting ∈ journal.postings, posting.units = posting.exactBookValue ∧
        posting.unitsCommodityId = commodityId ∧ posting.costBasis = none := by
  cases hrev : request.reversalOf with
  | none =>
    obtain ⟨policy, cp, measured, difference, jId, posId, glId, -, -, -, -, -, -, -, hd⟩ :=
      (calculateCurrencyRemeasurement_result_iff hrev d).mp h
    subst hd
    exact ⟨_, rfl, rfl, remeasurementPostings_balance _ _ _ _ _ _,
      remeasurementPostings_units_balance _ _ _ _ _ _,
      remeasurementPostings_units_eq_book _ _ _ _ _ _⟩
  | some rid =>
    obtain ⟨policy, cp, original, revId, origJ, revJ, posId, glId, -, -, -, -, -, -, -, -, -, -,
      hd⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d).mp h
    subst hd
    exact ⟨_, rfl, rfl, remeasurementPostings_balance _ _ _ _ _ _,
      remeasurementPostings_units_balance _ _ _ _ _ _,
      remeasurementPostings_units_eq_book _ _ _ _ _ _⟩

/-- The postings of every drafted journal are two constructible amounts that `sum` adds without
throwing to exactly zero: the journal balances in the kernel's own arithmetic, not only as
mathematics. -/
theorem calculateCurrencyRemeasurement_journal_sum {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft}
    (hreq : request.WF) (hstate : state.WF)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ journal, d.journals = [journal] ∧
      accountingSum (journal.postings.map (·.exactBookValue)) = .ok ExactRational.zero := by
  cases hrev : request.reversalOf with
  | none =>
    obtain ⟨policy, cp, measured, difference, jId, posId, glId, -, -, hm, hs, -, -, -, hd⟩ :=
      (calculateCurrencyRemeasurement_result_iff hrev d).mp h
    subst hd
    have hmw := (ExactRational.multiply_ok hreq.denomination hreq.valuationPath.rate hm).1
    have hdw := (ExactRational.subtract_ok hmw hreq.carryingBookValue hs).1
    exact ⟨_, rfl, accountingSum_difference_pair hdw⟩
  | some rid =>
    obtain ⟨policy, cp, original, revId, origJ, revJ, posId, glId, -, -, hf, -, -, -, -, -, -, -,
      hd⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d).mp h
    subst hd
    have hmem := List.mem_of_find?_eq_some hf
    have hdw := (hstate.remeasurementResults original hmem).difference
    have := accountingSum_difference_pair (ExactRational.negate_wf hdw)
    refine ⟨_, rfl, ?_⟩
    simpa [reversalJournalOf, remeasurementPostings] using this

/-! ## Laws: the numbers and the accounts of a remeasurement -/

/-- The numbers of a drafted remeasurement: both are constructible, and they mean the product and the
product less the carrying value. -/
theorem result_numbers {request : CurrencyRemeasurementRequest} (hreq : request.WF)
    {measured difference : ExactRational}
    (hm : request.denomination.multiply request.valuationPath.rate = .ok measured)
    (hs : measured.subtract request.carryingBookValue = .ok difference) :
    measured.WF ∧ difference.WF ∧
      measured.toRat = request.denomination.toRat * request.valuationPath.rate.toRat ∧
      difference.toRat = request.denomination.toRat * request.valuationPath.rate.toRat -
        request.carryingBookValue.toRat := by
  obtain ⟨hmw, hmr⟩ := ExactRational.multiply_ok hreq.denomination hreq.valuationPath.rate hm
  obtain ⟨hdw, hdr⟩ := ExactRational.subtract_ok hmw hreq.carryingBookValue hs
  exact ⟨hmw, hdw, hmr, by rw [hdr, hmr]⟩

/-- A constructible value is compared greater than zero exactly when it means a positive number. -/
theorem compare_zero_gt_iff {r : ExactRational} (h : r.WF) :
    (r.compare ExactRational.zero == .gt) = true ↔ 0 < r.toRat := by
  rw [beq_iff_eq, ExactRational.compare_gt_iff h ExactRational.zero_wf,
    ExactRational.zero_toRat]

/-- A choice made on `compare r zero == .gt` is a choice made on the sign of the number `r` means. -/
theorem ite_compare_zero_gt {α : Type} {r : ExactRational} (h : r.WF) (a b : α) :
    (if (r.compare ExactRational.zero == .gt) = true then a else b) =
      if 0 < r.toRat then a else b := by
  simp only [compare_zero_gt_iff h]

/-- A drafted remeasurement has a difference that is exactly the denomination times the rate less the carrying book value, as exact numbers, and its journal posts that difference to the position and its opposite to the gain or loss. -/
theorem calculateCurrencyRemeasurement_difference {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft} (hreq : request.WF)
    (hnone : request.reversalOf = none)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ journal effect, d = { journals := [journal], effects := [.remeasurementResult effect] } ∧
      effect.measuredBookValue.WF ∧ effect.difference.WF ∧
      effect.measuredBookValue.toRat = request.denomination.toRat * request.valuationPath.rate.toRat ∧
      effect.difference.toRat = request.denomination.toRat * request.valuationPath.rate.toRat -
        request.carryingBookValue.toRat ∧
      effect.carryingBookValue = request.carryingBookValue ∧
      effect.valuationRate = request.valuationPath.rate ∧
      journal.postings.map (·.exactBookValue) = [effect.difference, effect.difference.negate] := by
  obtain ⟨policy, cp, measured, difference, jId, posId, glId, -, -, hm, hs, -, -, -, hd⟩ :=
    (calculateCurrencyRemeasurement_result_iff hnone d).mp h
  obtain ⟨hmw, hdw, hmr, hdr⟩ := result_numbers hreq hm hs
  exact ⟨_, _, hd, hmw, hdw, hmr, hdr, rfl, rfl, rfl⟩

/-- The gain or loss posting of a drafted remeasurement is to the policy's gain account when the difference is positive and to its loss account otherwise, a difference of zero included, the other posting being to the request's position account. -/
theorem calculateCurrencyRemeasurement_gain_loss_account {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft} (hreq : request.WF)
    (hnone : request.reversalOf = none)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ policy cp journal effect,
      CurrencyInputValid policies commodityId request policy cp ∧
      d = { journals := [journal], effects := [.remeasurementResult effect] } ∧
      journal.postings.map (·.accountId) =
        [request.positionAccountId,
          if 0 < effect.difference.toRat then policy.gainAccountId else policy.lossAccountId] := by
  obtain ⟨policy, cp, measured, difference, jId, posId, glId, hv, -, hm, hs, -, -, -, hd⟩ :=
    (calculateCurrencyRemeasurement_result_iff hnone d).mp h
  obtain ⟨-, hdw, -, -⟩ := result_numbers hreq hm hs
  refine ⟨policy, cp, _, remeasurementResultOf request policy cp measured difference, hv, hd, ?_⟩
  simp only [remeasurementJournalOf, remeasurementPostings, List.map_cons, List.map_nil]
  rw [ite_compare_zero_gt hdw]
  rfl

/-- The journal of a drafted remeasurement is an adjustment for an unrealized result and an ordinary journal for a realized one, dated by the request's governed time and effective date, described by its kind and carrying its derivation. -/
theorem calculateCurrencyRemeasurement_result_journal {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft}
    (hnone : request.reversalOf = none)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ journal effect, d = { journals := [journal], effects := [.remeasurementResult effect] } ∧
      journal.requiredQuantizationPolicy = none ∧
      (request.kind = .unrealized → journal.kind = .adjustment) ∧
      (request.kind = .realized → journal.kind = .ordinary) ∧
      journal.economicAt = request.governedAt ∧ journal.recordedAt = request.governedAt ∧
      journal.accountingDate = request.effectiveOn ∧
      journal.narration = request.kind.text ++ " currency remeasurement" ∧
      journal.derivations = [request.derivation] := by
  obtain ⟨policy, cp, measured, difference, jId, posId, glId, -, -, -, -, -, -, -, hd⟩ :=
    (calculateCurrencyRemeasurement_result_iff hnone d).mp h
  refine ⟨_, _, hd, rfl, ?_, ?_, rfl, rfl, rfl, rfl, rfl⟩
  · intro hk
    simp [remeasurementJournalOf, hk]
  · intro hk
    simp [remeasurementJournalOf, hk]

/-! ## Laws: a reversal -/

/-- A reversal posts to the accounts of the policy the original recorded when it recorded one, and to
those of the current policy when it did not: the gain account when the original difference is positive
and the loss account otherwise. -/
theorem reversalGainLossAccount_eq {policy : CurrencyPolicy} {original : RemeasurementResult}
    (h : original.difference.WF) :
    reversalGainLossAccount policy original =
      match original.policy with
      | some origPolicy =>
        if 0 < original.difference.toRat then origPolicy.gainAccountId else origPolicy.lossAccountId
      | none => if 0 < original.difference.toRat then policy.gainAccountId else policy.lossAccountId := by
  unfold reversalGainLossAccount
  cases original.policy with
  | none => simp only [ite_compare_zero_gt h]
  | some origPolicy => simp only [ite_compare_zero_gt h]

/-- Negating twice gives the number back. -/
theorem negate_negate (r : ExactRational) : r.negate.negate = r := by
  simp [ExactRational.negate]

/- The reversal finds an original among the retained results that is `unrealized` and has no retained reversal, and drafts one `reversing`
 journal in the request's governed time and effective date, narrated "Currency remeasurement reversal" and carrying the request's derivation. -/
/-- A drafted reversal posts the original difference negated to the request's position account and the original difference to the gain or loss account of the policy the original recorded, or of the current policy when it recorded none. -/
theorem calculateCurrencyRemeasurement_reversal_journal {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {reversalOfId : RemeasurementResultId} {d : AccountingDraft}
    (hstate : state.WF) (hrev : request.reversalOf = some reversalOfId)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ policy cp original journal effect,
      CurrencyInputValid policies commodityId request policy cp ∧
      state.remeasurementResults.find? (fun item => item.id == reversalOfId) = some original ∧
      original.kind = .unrealized ∧
      d = { journals := [journal], effects := [.remeasurementReversal effect] } ∧
      journal.requiredQuantizationPolicy = none ∧ journal.kind = .reversing ∧
      journal.economicAt = request.governedAt ∧ journal.recordedAt = request.governedAt ∧
      journal.accountingDate = request.effectiveOn ∧
      journal.narration = "Currency remeasurement reversal" ∧
      journal.derivations = [request.derivation] ∧
      journal.postings.map (·.exactBookValue) = [original.difference.negate, original.difference] ∧
      journal.postings.map (·.accountId) =
        [request.positionAccountId,
          match original.policy with
          | some origPolicy =>
            if 0 < original.difference.toRat then origPolicy.gainAccountId
            else origPolicy.lossAccountId
          | none =>
            if 0 < original.difference.toRat then policy.gainAccountId else policy.lossAccountId] := by
  obtain ⟨policy, cp, original, revId, origJ, revJ, posId, glId, hv, -, hf, hk, -, -, -, -, -, -,
    hd⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d).mp h
  have hdw := (hstate.remeasurementResults original (List.mem_of_find?_eq_some hf)).difference
  refine ⟨policy, cp, original, _, _, hv, hf, hk, hd, rfl, rfl, rfl, rfl, rfl, rfl, rfl, ?_, ?_⟩
  · simp [reversalJournalOf, remeasurementPostings, negate_negate]
  · simp only [reversalJournalOf, remeasurementPostings, List.map_cons, List.map_nil,
      reversalGainLossAccount_eq hdw]

/-- The reversal effect names the original it reverses, the journal that original generated
(`${original.id}-journal`), and the original's effect key when it has one, and is dated as the request
says. -/
theorem calculateCurrencyRemeasurement_reversal_effect {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {reversalOfId : RemeasurementResultId} {d : AccountingDraft}
    (hrev : request.reversalOf = some reversalOfId)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ original journal effect, d = { journals := [journal], effects := [.remeasurementReversal effect] } ∧
      state.remeasurementResults.find? (fun item => item.id == reversalOfId) = some original ∧
      request.reversalId = some effect.id ∧
      effect.originalResultId = original.id ∧
      (∃ originalJournalId, effect.originalJournalId = some originalJournalId ∧
        originalJournalId.value = original.id.value ++ "-journal") ∧
      effect.originalEffectKey = original.adjustmentEffectKey ∧
      effect.reversedOn = request.effectiveOn ∧ effect.derivation = request.derivation := by
  obtain ⟨policy, cp, original, revId, origJ, revJ, posId, glId, -, -, hf, -, hr, -, hj1, -, -, -,
    hd⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d).mp h
  refine ⟨original, _, _, hd, hf, hr, rfl, ⟨origJ, rfl, ?_⟩, rfl, rfl, rfl⟩
  exact ((identifier_ok_iff _ _ _).mp hj1).2

/-- What a prepared journal posts to one account, as a number: the exact book values of its postings
to that account, added. -/
def accountNet (journal : ExactPreparedJournal) (account : AccountId) : ℚ :=
  ((journal.postings.filter (·.accountId == account)).map (·.exactBookValue.toRat)).sum

/-- Two generated journals, one posting an amount to the position and its opposite to the gain or loss
account and the other the opposite amounts to the same two accounts, net to zero in every account, even
when the two accounts are the same. -/
theorem accountNet_cancel (commodityId : CommodityId) (positionAccountId gainLossAccountId : AccountId)
    (positionId gainLossId positionId' gainLossId' : PostingId) (difference : ExactRational)
    (j₁ j₂ : ExactPreparedJournal)
    (h₁ : j₁.postings = remeasurementPostings commodityId positionAccountId gainLossAccountId
      positionId gainLossId difference)
    (h₂ : j₂.postings = remeasurementPostings commodityId positionAccountId gainLossAccountId
      positionId' gainLossId' difference.negate) (account : AccountId) :
    accountNet j₁ account + accountNet j₂ account = 0 := by
  simp only [accountNet, h₁, h₂, remeasurementPostings, List.filter_cons, List.filter_nil]
  by_cases hp : (positionAccountId == account) = true <;>
    by_cases hg : (gainLossAccountId == account) = true <;>
    simp [hp, hg, ExactRational.negate_toRat]

/- The function does not check that the reversal request's position account is the original's (`accounting.ts` line 1526 posts to
 `request.positionAccountId`); `book.ts` line 2104 does (`exactReversal` of the original journal), which is why the law assumes it. -/
/-- A remeasurement followed by the reversal of its result nets to zero in every account when the reversal request names the same position account, the gain or loss going back to the account of the policy the remeasurement recorded even when the reversal request selects another policy. -/
theorem remeasurement_then_reversal_nets_to_zero {policies₁ policies₂ : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request₁ request₂ : CurrencyRemeasurementRequest}
    {state₁ state₂ : CurrencyAccountingState} {d₁ d₂ : AccountingDraft} {result : RemeasurementResult}
    (hnone : request₁.reversalOf = none)
    (h₁ : calculateCurrencyRemeasurement policies₁ bookId commodityId request₁ state₁ =
      .ok (.draft d₁))
    (hres : d₁.effects = [.remeasurementResult result])
    (hrev : request₂.reversalOf = some result.id)
    (hfind : state₂.remeasurementResults.find? (fun item => item.id == result.id) = some result)
    (h₂ : calculateCurrencyRemeasurement policies₂ bookId commodityId request₂ state₂ =
      .ok (.draft d₂))
    (hpos : request₂.positionAccountId = request₁.positionAccountId) :
    ∃ journal₁ journal₂, d₁.journals = [journal₁] ∧ d₂.journals = [journal₂] ∧
      ∀ account, accountNet journal₁ account + accountNet journal₂ account = 0 := by
  obtain ⟨policy₁, cp₁, measured, difference, jId, posId, glId, -, -, -, -, -, -, -, hd₁⟩ :=
    (calculateCurrencyRemeasurement_result_iff hnone d₁).mp h₁
  obtain ⟨policy₂, cp₂, original, revId, origJ, revJ, posId₂, glId₂, -, -, hf, -, -, -, -, -, -, -,
    hd₂⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d₂).mp h₂
  have hres' : result = remeasurementResultOf request₁ policy₁ cp₁ measured difference := by
    rw [hd₁] at hres
    simp only [List.cons.injEq, AccountingEffect.remeasurementResult.injEq, and_true] at hres
    exact hres.symm
  have horig : original = result := by
    rw [hfind] at hf
    exact (Option.some.inj hf).symm
  subst hd₁ hd₂
  refine ⟨_, _, rfl, rfl, ?_⟩
  intro account
  refine accountNet_cancel commodityId request₁.positionAccountId
    (if (difference.compare ExactRational.zero == .gt) = true then policy₁.gainAccountId
      else policy₁.lossAccountId) posId glId posId₂ glId₂ difference _ _ rfl ?_ account
  subst horig
  subst hres'
  simp only [reversalJournalOf, hpos]
  rfl

/-! ## Laws: the hash of the effects -/

/-- The body of a remeasurement result does not read its content hash: the hash covers every other
field. -/
theorem RemeasurementResult.bodyValue_with_contentHash (a : RemeasurementResult)
    (hash : ContentHash) : bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash,
    RemeasurementResult.canonicalMembers, member, optMember]

/-- The body of a remeasurement reversal does not read its content hash: the hash covers every other
field. -/
theorem RemeasurementReversal.bodyValue_with_contentHash (a : RemeasurementReversal)
    (hash : ContentHash) : bodyValue { a with contentHash := hash } = bodyValue a := by
  simp [bodyValue, CanonicalObject.members, withoutContentHash,
    RemeasurementReversal.canonicalMembers, member, optMember]

/-- Putting into a result the hash of its body gives a result whose hash is the hash of its (whole)
body. -/
theorem RemeasurementResult.sealed_hash (body : RemeasurementResult) (type : String) :
    ({ body with contentHash := accountingBodyHash type body } : RemeasurementResult).contentHash =
      accountingBodyHash type
        ({ body with contentHash := accountingBodyHash type body } : RemeasurementResult) := by
  simp only [accountingBodyHash, RemeasurementResult.bodyValue_with_contentHash]

/-- Putting into a reversal the hash of its body gives a reversal whose hash is the hash of its
(whole) body. -/
theorem RemeasurementReversal.sealed_hash (body : RemeasurementReversal) (type : String) :
    ({ body with contentHash := accountingBodyHash type body } : RemeasurementReversal).contentHash =
      accountingBodyHash type
        ({ body with contentHash := accountingBodyHash type body } : RemeasurementReversal) := by
  simp only [accountingBodyHash, RemeasurementReversal.bodyValue_with_contentHash]

/-- A result effect carries the hash of its body: `accountingHash("RemeasurementResult", body)`. -/
theorem remeasurementResultOf_contentHash (request : CurrencyRemeasurementRequest)
    (policy : CurrencyPolicy) (cp : MonetaryClassificationPolicy) (measured difference : ExactRational) :
    (remeasurementResultOf request policy cp measured difference).contentHash =
      accountingBodyHash "RemeasurementResult"
        (remeasurementResultOf request policy cp measured difference) := by
  unfold remeasurementResultOf
  exact RemeasurementResult.sealed_hash _ _

/-- A reversal effect carries the hash of its body: `accountingHash("RemeasurementReversal", body)`. -/
theorem reversalEffectOf_contentHash (request : CurrencyRemeasurementRequest)
    (original : RemeasurementResult) (reversalId : RemeasurementReversalId)
    (originalJournalId : JournalId) :
    (reversalEffectOf request original reversalId originalJournalId).contentHash =
      accountingBodyHash "RemeasurementReversal"
        (reversalEffectOf request original reversalId originalJournalId) := by
  unfold reversalEffectOf
  exact RemeasurementReversal.sealed_hash _ _

/-- Each effect the function drafts carries the `accountingHash` of its type name and its body, every field but the hash, and the kernel's own check of it, `validateAccountingEffectHash`, returns `true`. -/
theorem calculateCurrencyRemeasurement_effect_hash {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft}
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    d.effects.length = 1 ∧ ∀ effect ∈ d.effects,
      effect.contentHash = accountingHash effect.typeName effect.bodyValue ∧
        validateAccountingEffectHash effect = .ok true := by
  cases hrev : request.reversalOf with
  | none =>
    obtain ⟨policy, cp, measured, difference, jId, posId, glId, -, -, -, -, -, -, -, hd⟩ :=
      (calculateCurrencyRemeasurement_result_iff hrev d).mp h
    subst hd
    refine ⟨rfl, ?_⟩
    intro effect hmem
    simp only [List.mem_singleton] at hmem
    subst hmem
    have e := remeasurementResultOf_contentHash request policy cp measured difference
    refine ⟨e, ?_⟩
    unfold validateAccountingEffectHash
    simp only [AccountingEffect.typeName, AccountingEffect.bodyValue, AccountingEffect.contentHash,
      e]
    simp [accountingBodyHash]
  | some rid =>
    obtain ⟨policy, cp, original, revId, origJ, revJ, posId, glId, -, -, -, -, -, -, -, -, -, -,
      hd⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d).mp h
    subst hd
    refine ⟨rfl, ?_⟩
    intro effect hmem
    simp only [List.mem_singleton] at hmem
    subst hmem
    have e := reversalEffectOf_contentHash request original revId origJ
    refine ⟨e, ?_⟩
    unfold validateAccountingEffectHash
    simp only [AccountingEffect.typeName, AccountingEffect.bodyValue, AccountingEffect.contentHash,
      e]
    simp [accountingBodyHash]

/-! ## Laws: errors -/

/-- The derived journal and posting identifiers built from `id` (`"-journal"`, `"-position"`,
`"-gain-loss"`) remain in Unicode NFC form. -/
def DerivedIdsNFC {K : String} (id : Identifier K) : Prop :=
  isNFC (id.value ++ "-journal") = true ∧
  isNFC (id.value ++ "-position") = true ∧
  isNFC (id.value ++ "-gain-loss") = true

/-- Every pure-ASCII identifier satisfies `DerivedIdsNFC`. -/
theorem derivedIdsNFC_of_ascii {K : String} {id : Identifier K}
    (hascii : ∀ c ∈ id.value.toList, c.toNat < 128) : DerivedIdsNFC id := by
  refine ⟨ascii_isNFC _ ?_, ascii_isNFC _ ?_, ascii_isNFC _ ?_⟩
  all_goals
    intro c hc
    rw [String.toList_append, List.mem_append] at hc
    rcases hc with hc | hc
    · exact hascii c hc
    · first
      | exact (suffix_journal_clean c hc).1
      | exact (suffix_position_clean c hc).1
      | exact (suffix_gain_loss_clean c hc).1

private theorem derived_ids_ok {K : String} {id : Identifier K} (hw : id.WF)
    (hnfc : DerivedIdsNFC id) :
    journalId (id.value ++ "-journal") = .ok ⟨id.value ++ "-journal"⟩ ∧
    (⟨id.value ++ "-journal"⟩ : JournalId).WF ∧
    postingId (id.value ++ "-position") = .ok ⟨id.value ++ "-position"⟩ ∧
    (⟨id.value ++ "-position"⟩ : PostingId).WF ∧
    postingId (id.value ++ "-gain-loss") = .ok ⟨id.value ++ "-gain-loss"⟩ ∧
    (⟨id.value ++ "-gain-loss"⟩ : PostingId).WF := by
  have h1 := identifier_append_suffix_of_isNFC "JournalTransaction" id "-journal" hw (by simp)
    (fun c hc => ⟨(suffix_journal_clean c hc).2.1, (suffix_journal_clean c hc).2.2⟩) hnfc.1
  have h2 := identifier_append_suffix_of_isNFC "Posting" id "-position" hw (by simp)
    (fun c hc => ⟨(suffix_position_clean c hc).2.1, (suffix_position_clean c hc).2.2⟩) hnfc.2.1
  have h3 := identifier_append_suffix_of_isNFC "Posting" id "-gain-loss" hw (by simp)
    (fun c hc => ⟨(suffix_gain_loss_clean c hc).2.1, (suffix_gain_loss_clean c hc).2.2⟩) hnfc.2.2
  exact ⟨h1.1, h1.2, h2.1, h2.2, h3.1, h3.2⟩

/-- The three identifiers a remeasurement derives from one identifier by template strings,
`${id}-journal`, `${id}-position` and `${id}-gain-loss`, are all valid. -/
abbrev DerivedIdsValid (id : String) : Prop :=
  (∃ j, journalId (id ++ "-journal") = .ok j) ∧ (∃ p, postingId (id ++ "-position") = .ok p) ∧
    ∃ g, postingId (id ++ "-gain-loss") = .ok g

/-- The identifiers a reversal derives: the journal of the original, and the three of the reversal. -/
abbrev ReversalIdsValid (original reversal : String) : Prop :=
  (∃ j, journalId (original ++ "-journal") = .ok j) ∧ DerivedIdsValid reversal

/-- An identifier that cannot be built is the identity conflict, whatever the text. -/
theorem identifier_error_eq {K s : String} {e : CanonicalErr} (h : identifier K s = .error e) :
    e = .canonicalIdentityConflict := by
  unfold identifier at h
  split_ifs at h <;> simp_all

/-- A remeasurement throws a size error exactly when the multiplication, or the subtraction after it,
does (`accounting.ts` lines 1531 and 1532). -/
theorem draftCurrencyResult_eq_number_error_iff (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (cp : MonetaryClassificationPolicy) (code : NumErr) :
    draftCurrencyResult commodityId request policy cp = .error (.exactNumber code) ↔
      request.denomination.multiply request.valuationPath.rate = .error code ∨
      ∃ measured, request.denomination.multiply request.valuationPath.rate = .ok measured ∧
        measured.subtract request.carryingBookValue = .error code := by
  unfold draftCurrencyResult
  cases hm : request.denomination.multiply request.valuationPath.rate with
  | error e => simp [liftCurrencyNumErr]
  | ok measured =>
    cases hs : measured.subtract request.carryingBookValue with
    | error e => simp [liftCurrencyNumErr, hs]
    | ok difference =>
      cases hj : journalId (request.id.value ++ "-journal") with
      | error e => simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hs]
      | ok j =>
        cases hp : postingId (request.id.value ++ "-position") with
        | error e => simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hs]
        | ok p =>
          cases hg : postingId (request.id.value ++ "-gain-loss") with
          | error e => simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hs]
          | ok g => simp [liftCurrencyNumErr, liftCurrencyCanonicalErr, hs, drafted,
              immutableAccountingValue]

/-- A remeasurement throws an identity error exactly when the multiplication and the subtraction return
and one of the three derived identifiers cannot be built; the error is the identity conflict
(`accounting.ts` lines 1536 to 1538). -/
theorem draftCurrencyResult_eq_canonical_error_iff (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (cp : MonetaryClassificationPolicy) (code : CanonicalErr) :
    draftCurrencyResult commodityId request policy cp = .error (.canonical code) ↔
      code = .canonicalIdentityConflict ∧ ∃ measured difference,
        request.denomination.multiply request.valuationPath.rate = .ok measured ∧
        measured.subtract request.carryingBookValue = .ok difference ∧
        ¬ DerivedIdsValid request.id.value := by
  constructor
  · intro h
    unfold draftCurrencyResult at h
    generalize hm : request.denomination.multiply request.valuationPath.rate = mres at h
    cases mres with
    | error e => simp [liftCurrencyNumErr] at h
    | ok measured =>
      simp only [liftCurrencyNumErr] at h
      generalize hs : measured.subtract request.carryingBookValue = sres at h
      cases sres with
      | error e => simp at h
      | ok difference =>
        have key : code = .canonicalIdentityConflict ∧ ¬ DerivedIdsValid request.id.value := by
          cases hj : journalId (request.id.value ++ "-journal") with
          | error e =>
            simp only [liftCurrencyCanonicalErr, hj, Except.error.injEq,
              CurrencyErr.canonical.injEq] at h
            subst h
            exact ⟨identifier_error_eq hj, fun hv => by
              obtain ⟨⟨j, hj'⟩, -, -⟩ := hv
              rw [hj] at hj'
              cases hj'⟩
          | ok j =>
            cases hp : postingId (request.id.value ++ "-position") with
            | error e =>
              simp only [liftCurrencyCanonicalErr, hj, hp, Except.error.injEq,
                CurrencyErr.canonical.injEq] at h
              subst h
              exact ⟨identifier_error_eq hp, fun hv => by
                obtain ⟨-, ⟨p, hp'⟩, -⟩ := hv
                rw [hp] at hp'
                cases hp'⟩
            | ok p =>
              cases hg : postingId (request.id.value ++ "-gain-loss") with
              | error e =>
                simp only [liftCurrencyCanonicalErr, hj, hp, hg, Except.error.injEq,
                  CurrencyErr.canonical.injEq] at h
                subst h
                exact ⟨identifier_error_eq hg, fun hv => by
                  obtain ⟨-, -, ⟨g, hg'⟩⟩ := hv
                  rw [hg] at hg'
                  cases hg'⟩
              | ok g =>
                simp [liftCurrencyCanonicalErr, hj, hp, hg, drafted, immutableAccountingValue] at h
        exact ⟨key.1, measured, difference, rfl, hs, key.2⟩
  · rintro ⟨rfl, measured, difference, hm, hs, hnot⟩
    unfold draftCurrencyResult
    simp only [liftCurrencyNumErr, hm, hs]
    cases hj : journalId (request.id.value ++ "-journal") with
    | error e =>
      have he := identifier_error_eq hj
      simp [liftCurrencyCanonicalErr, he]
    | ok j =>
      cases hp : postingId (request.id.value ++ "-position") with
      | error e =>
        have he := identifier_error_eq hp
        simp [liftCurrencyCanonicalErr, he]
      | ok p =>
        cases hg : postingId (request.id.value ++ "-gain-loss") with
        | error e =>
          have he := identifier_error_eq hg
          simp [liftCurrencyCanonicalErr, he]
        | ok g => exact absurd ⟨⟨j, hj⟩, ⟨p, hp⟩, ⟨g, hg⟩⟩ hnot

/-- A reversal never throws a size error: its only errors are identity errors. -/
theorem draftCurrencyReversal_ne_number_error (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (state : CurrencyAccountingState) (reversalOfId : RemeasurementResultId) (code : NumErr) :
    draftCurrencyReversal commodityId request policy state reversalOfId ≠
      .error (.exactNumber code) := by
  intro h
  unfold draftCurrencyReversal at h
  cases hfind : state.remeasurementResults.find? (fun item => item.id == reversalOfId) with
  | none => simp [hfind] at h
  | some original =>
    simp only [hfind] at h
    split at h
    · cases h
    · cases hrev : request.reversalId with
      | none => simp [hrev] at h
      | some revId =>
        simp only [hrev] at h
        cases hj1 : journalId (original.id.value ++ "-journal") with
        | error e => simp [liftCurrencyCanonicalErr, hj1] at h
        | ok o =>
          cases hj2 : journalId (revId.value ++ "-journal") with
          | error e => simp [liftCurrencyCanonicalErr, hj1, hj2] at h
          | ok r =>
            cases hp : postingId (revId.value ++ "-position") with
            | error e => simp [liftCurrencyCanonicalErr, hj1, hj2, hp] at h
            | ok p =>
              cases hg : postingId (revId.value ++ "-gain-loss") with
              | error e => simp [liftCurrencyCanonicalErr, hj1, hj2, hp, hg] at h
              | ok g => simp [liftCurrencyCanonicalErr, hj1, hj2, hp, hg, drafted,
                  immutableAccountingValue] at h

/-- A reversal throws an identity error exactly when the original is found, is `unrealized`, has no
retained reversal, a reversal identifier is given, and one of the four derived identifiers cannot be
built; the error is the identity conflict (`accounting.ts` lines 1521 and 1525 to 1527). -/
theorem draftCurrencyReversal_eq_canonical_error_iff (commodityId : CommodityId)
    (request : CurrencyRemeasurementRequest) (policy : CurrencyPolicy)
    (state : CurrencyAccountingState) (reversalOfId : RemeasurementResultId)
    (code : CanonicalErr) :
    draftCurrencyReversal commodityId request policy state reversalOfId =
        .error (.canonical code) ↔
      code = .canonicalIdentityConflict ∧ ∃ original revId,
        state.remeasurementResults.find? (fun item => item.id == reversalOfId) = some original ∧
        original.kind = .unrealized ∧ request.reversalId = some revId ∧
        (∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id) ∧
        ¬ ReversalIdsValid original.id.value revId.value := by
  constructor
  · intro h
    unfold draftCurrencyReversal at h
    cases hfind : state.remeasurementResults.find? (fun item => item.id == reversalOfId) with
    | none => simp [hfind] at h
    | some original =>
      simp only [hfind] at h
      by_cases hc : (original.kind != .unrealized || request.reversalId.isNone ||
          state.remeasurementReversals.any (fun item => item.originalResultId == original.id)) = true
      · simp [hc] at h
      · have hc' : (original.kind != .unrealized || request.reversalId.isNone ||
            state.remeasurementReversals.any
              (fun item => item.originalResultId == original.id)) = false :=
          Bool.eq_false_iff.mpr hc
        obtain ⟨hk, ⟨revId, hrev⟩, hno⟩ :=
          (reversalRefused_eq_false_iff original request state).mp hc'
        simp only [hc', Bool.false_eq_true, ↓reduceIte] at h
        simp only [hrev] at h
        have key : code = .canonicalIdentityConflict ∧
            ¬ ReversalIdsValid original.id.value revId.value := by
          cases hj1 : journalId (original.id.value ++ "-journal") with
          | error e =>
            simp only [liftCurrencyCanonicalErr, hj1, Except.error.injEq,
              CurrencyErr.canonical.injEq] at h
            subst h
            exact ⟨identifier_error_eq hj1, fun hv => by
              obtain ⟨⟨j, hj'⟩, -⟩ := hv
              rw [hj1] at hj'
              cases hj'⟩
          | ok o =>
            cases hj2 : journalId (revId.value ++ "-journal") with
            | error e =>
              simp only [liftCurrencyCanonicalErr, hj1, hj2, Except.error.injEq,
                CurrencyErr.canonical.injEq] at h
              subst h
              exact ⟨identifier_error_eq hj2, fun hv => by
                obtain ⟨-, ⟨j, hj'⟩, -⟩ := hv
                rw [hj2] at hj'
                cases hj'⟩
            | ok r =>
              cases hp : postingId (revId.value ++ "-position") with
              | error e =>
                simp only [liftCurrencyCanonicalErr, hj1, hj2, hp, Except.error.injEq,
                  CurrencyErr.canonical.injEq] at h
                subst h
                exact ⟨identifier_error_eq hp, fun hv => by
                  obtain ⟨-, -, ⟨p, hp'⟩, -⟩ := hv
                  rw [hp] at hp'
                  cases hp'⟩
              | ok p =>
                cases hg : postingId (revId.value ++ "-gain-loss") with
                | error e =>
                  simp only [liftCurrencyCanonicalErr, hj1, hj2, hp, hg, Except.error.injEq,
                    CurrencyErr.canonical.injEq] at h
                  subst h
                  exact ⟨identifier_error_eq hg, fun hv => by
                    obtain ⟨-, -, -, ⟨g, hg'⟩⟩ := hv
                    rw [hg] at hg'
                    cases hg'⟩
                | ok g =>
                  simp [liftCurrencyCanonicalErr, hj1, hj2, hp, hg, drafted,
                    immutableAccountingValue] at h
        exact ⟨key.1, original, revId, rfl, hk, hrev, hno, key.2⟩
  · rintro ⟨rfl, original, revId, hf, hk, hrev, hno, hnot⟩
    unfold draftCurrencyReversal
    have hc : (original.kind != .unrealized || request.reversalId.isNone ||
        state.remeasurementReversals.any
          (fun item => item.originalResultId == original.id)) = false :=
      (reversalRefused_eq_false_iff original request state).mpr ⟨hk, ⟨revId, hrev⟩, hno⟩
    simp only [hf, hc, Bool.false_eq_true, ↓reduceIte]
    simp only [hrev]
    cases hj1 : journalId (original.id.value ++ "-journal") with
    | error e =>
      have he := identifier_error_eq hj1
      simp [liftCurrencyCanonicalErr, he]
    | ok o =>
      cases hj2 : journalId (revId.value ++ "-journal") with
      | error e =>
        have he := identifier_error_eq hj2
        simp [liftCurrencyCanonicalErr, he]
      | ok r =>
        cases hp : postingId (revId.value ++ "-position") with
        | error e =>
          have he := identifier_error_eq hp
          simp [liftCurrencyCanonicalErr, he]
        | ok p =>
          cases hg : postingId (revId.value ++ "-gain-loss") with
          | error e =>
            have he := identifier_error_eq hg
            simp [liftCurrencyCanonicalErr, he]
          | ok g => exact absurd ⟨⟨o, hj1⟩, ⟨r, hj2⟩, ⟨p, hp⟩, ⟨g, hg⟩⟩ hnot

/-- The errors of a call are those of its branch, once the inputs are accepted and the selected
currency policy is of the book (`accounting.ts` lines 1510 to 1540). -/
theorem calculateCurrencyRemeasurement_eq_error_iff {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} (e : CurrencyErr) :
    calculateCurrencyRemeasurement policies bookId commodityId request state = .error e ↔
      ∃ policy cp, CurrencyInputValid policies commodityId request policy cp ∧
        policy.bookId = bookId ∧
        (match request.reversalOf with
          | some reversalOfId =>
            draftCurrencyReversal commodityId request policy state reversalOfId = .error e
          | none => draftCurrencyResult commodityId request policy cp = .error e) := by
  constructor
  · intro herr
    have hne : calculateCurrencyRemeasurement policies bookId commodityId request state ≠
        .ok (.rejected [currencyInputDiagnostic]) := by
      rw [herr]
      intro h
      cases h
    obtain ⟨policy, cp, hv⟩ := inputsAccepted_of_step1 hne
    have hstep := calculateCurrencyRemeasurement_of_inputValid (state := state) (bookId := bookId) hv
    rw [herr] at hstep
    split at hstep
    · cases hstep
    · rename_i hbook
      refine ⟨policy, cp, hv, by simpa [bne_iff_ne] using hbook, ?_⟩
      cases hrev : request.reversalOf with
      | none =>
        rw [hrev] at hstep
        exact hstep.symm
      | some reversalOfId =>
        rw [hrev] at hstep
        exact hstep.symm
  · rintro ⟨policy, cp, hv, hbook, hbranch⟩
    rw [calculateCurrencyRemeasurement_of_inputValid hv]
    simp only [hbook, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte]
    cases hrev : request.reversalOf with
    | none =>
      simp only [hrev] at hbranch
      exact hbranch
    | some reversalOfId =>
      simp only [hrev] at hbranch
      exact hbranch

/-- A call throws the size error exactly when the inputs are accepted, the policy is of the book, no reversal is asked for, and the multiplication of the denomination by the rate, or the subtraction of the carrying value from the product, exceeds the exact-number limit. -/
theorem calculateCurrencyRemeasurement_number_error_iff {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} (code : NumErr) :
    calculateCurrencyRemeasurement policies bookId commodityId request state =
        .error (.exactNumber code) ↔
      ∃ policy cp, CurrencyInputValid policies commodityId request policy cp ∧
        policy.bookId = bookId ∧ request.reversalOf = none ∧
        (request.denomination.multiply request.valuationPath.rate = .error code ∨
          ∃ measured, request.denomination.multiply request.valuationPath.rate = .ok measured ∧
            measured.subtract request.carryingBookValue = .error code) := by
  rw [calculateCurrencyRemeasurement_eq_error_iff]
  constructor
  · rintro ⟨policy, cp, hv, hbook, hbranch⟩
    cases hrev : request.reversalOf with
    | none =>
      simp only [hrev] at hbranch
      exact ⟨policy, cp, hv, hbook, rfl,
        (draftCurrencyResult_eq_number_error_iff _ _ _ _ _).mp hbranch⟩
    | some reversalOfId =>
      simp only [hrev] at hbranch
      exact absurd hbranch (draftCurrencyReversal_ne_number_error _ _ _ _ _ _)
  · rintro ⟨policy, cp, hv, hbook, hrev, harith⟩
    refine ⟨policy, cp, hv, hbook, ?_⟩
    simp only [hrev]
    exact (draftCurrencyResult_eq_number_error_iff _ _ _ _ _).mpr harith

/-- A call throws the identity conflict exactly when the inputs are accepted, the policy is of the book, and either a remeasurement's multiplication and subtraction return and one of `${id}-journal`, `${id}-position`, `${id}-gain-loss` is not a valid identifier, or a reversal is admissible and one of its four derived identifiers is not valid. -/
theorem calculateCurrencyRemeasurement_identity_error_iff {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} (code : CanonicalErr) :
    calculateCurrencyRemeasurement policies bookId commodityId request state =
        .error (.canonical code) ↔
      code = .canonicalIdentityConflict ∧ ∃ policy cp,
        CurrencyInputValid policies commodityId request policy cp ∧ policy.bookId = bookId ∧
        ((request.reversalOf = none ∧ ∃ measured difference,
            request.denomination.multiply request.valuationPath.rate = .ok measured ∧
            measured.subtract request.carryingBookValue = .ok difference ∧
            ¬ DerivedIdsValid request.id.value) ∨
          (∃ reversalOfId original revId, request.reversalOf = some reversalOfId ∧
            state.remeasurementResults.find? (fun item => item.id == reversalOfId) =
              some original ∧
            original.kind = .unrealized ∧ request.reversalId = some revId ∧
            (∀ item ∈ state.remeasurementReversals, item.originalResultId ≠ original.id) ∧
            ¬ ReversalIdsValid original.id.value revId.value)) := by
  rw [calculateCurrencyRemeasurement_eq_error_iff]
  constructor
  · rintro ⟨policy, cp, hv, hbook, hbranch⟩
    cases hrev : request.reversalOf with
    | none =>
      simp only [hrev] at hbranch
      obtain ⟨hcode, measured, difference, hm, hs, hnot⟩ :=
        (draftCurrencyResult_eq_canonical_error_iff _ _ _ _ _).mp hbranch
      exact ⟨hcode, policy, cp, hv, hbook, Or.inl ⟨rfl, measured, difference, hm, hs, hnot⟩⟩
    | some reversalOfId =>
      simp only [hrev] at hbranch
      obtain ⟨hcode, original, revId, hf, hk, hr, hno, hnot⟩ :=
        (draftCurrencyReversal_eq_canonical_error_iff _ _ _ _ _ _).mp hbranch
      exact ⟨hcode, policy, cp, hv, hbook,
        Or.inr ⟨reversalOfId, original, revId, rfl, hf, hk, hr, hno, hnot⟩⟩
  · rintro ⟨hcode, policy, cp, hv, hbook, hcase⟩
    refine ⟨policy, cp, hv, hbook, ?_⟩
    rcases hcase with ⟨hrev, measured, difference, hm, hs, hnot⟩ |
      ⟨reversalOfId, original, revId, hrev, hf, hk, hr, hno, hnot⟩
    · simp only [hrev]
      exact (draftCurrencyResult_eq_canonical_error_iff _ _ _ _ _).mpr
        ⟨hcode, measured, difference, hm, hs, hnot⟩
    · simp only [hrev]
      exact (draftCurrencyReversal_eq_canonical_error_iff _ _ _ _ _ _).mpr
        ⟨hcode, original, revId, hf, hk, hr, hno, hnot⟩

/-- For a constructible request, the only `.error` a call throws is the representation limit of the exact numbers or the identity conflict of an identifier that cannot be built. -/
theorem calculateCurrencyRemeasurement_error_cases {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {e : CurrencyErr} (hreq : request.WF)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state = .error e) :
    e = .exactNumber .representationLimitExceeded ∨ e = .canonical .canonicalIdentityConflict := by
  cases e with
  | exactNumber code =>
    left
    obtain ⟨policy, cp, -, -, -, harith⟩ :=
      (calculateCurrencyRemeasurement_number_error_iff code).mp h
    rcases harith with hm | ⟨measured, hm, hs⟩
    · rcases ExactRational.multiply_ok_or_limit hreq.denomination hreq.valuationPath.rate with
        ⟨c, hc⟩ | hlim
      · rw [hm] at hc
        cases hc
      · rw [hm] at hlim
        exact congrArg CurrencyErr.exactNumber (Except.error.inj hlim)
    · have hmw := (ExactRational.multiply_ok hreq.denomination hreq.valuationPath.rate hm).1
      rcases ExactRational.subtract_ok_or_limit hmw hreq.carryingBookValue with ⟨c, hc⟩ | hlim
      · rw [hs] at hc
        cases hc
      · rw [hs] at hlim
        exact congrArg CurrencyErr.exactNumber (Except.error.inj hlim)
  | canonical code =>
    right
    obtain ⟨hcode, -⟩ := (calculateCurrencyRemeasurement_identity_error_iff code).mp h
    rw [hcode]

/-- A constructible identifier whose derived identifiers stay in Unicode NFC derives three valid
identifiers. -/
theorem derivedIdsValid_of_nfc {K : String} {id : Identifier K} (hw : id.WF)
    (hnfc : DerivedIdsNFC id) : DerivedIdsValid id.value := by
  obtain ⟨h1, -, h3, -, h5, -⟩ := derived_ids_ok hw hnfc
  exact ⟨⟨_, h1⟩, ⟨_, h3⟩, ⟨_, h5⟩⟩

/-- For a constructible request and state whose identifiers keep their Unicode normal form when the
suffixes are appended (every ASCII identifier does: `calculateCurrencyRemeasurement_error_only_limit_ascii`),
the only `.error` a call can throw is the representation limit of the exact numbers. -/
theorem calculateCurrencyRemeasurement_error_only_limit {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {e : CurrencyErr} (hreq : request.WF) (hstate : state.WF)
    (hIdNFC : DerivedIdsNFC request.id)
    (hOrigNFC : ∀ r ∈ state.remeasurementResults, isNFC (r.id.value ++ "-journal") = true)
    (hRevNFC : ∀ id, request.reversalId = some id → DerivedIdsNFC id)
    (herr : calculateCurrencyRemeasurement policies bookId commodityId request state = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  rcases calculateCurrencyRemeasurement_error_cases hreq herr with h | h
  · exact h
  · exfalso
    subst h
    obtain ⟨-, policy, cp, hv, hbook, hcase⟩ :=
      (calculateCurrencyRemeasurement_identity_error_iff _).mp herr
    rcases hcase with ⟨-, measured, difference, -, -, hnot⟩ |
      ⟨reversalOfId, original, revId, hrev, hf, hk, hr, hno, hnot⟩
    · exact hnot (derivedIdsValid_of_nfc hreq.id hIdNFC)
    · have hmem := List.mem_of_find?_eq_some hf
      have horig : original.id.WF := (hstate.remeasurementResults original hmem).id
      have hj1 := identifier_append_suffix_of_isNFC "JournalTransaction" original.id "-journal"
        horig (by simp)
        (fun c hc => ⟨(suffix_journal_clean c hc).2.1, (suffix_journal_clean c hc).2.2⟩)
        (hOrigNFC original hmem)
      exact hnot ⟨⟨_, hj1.1⟩,
        derivedIdsValid_of_nfc (hreq.reversalId revId hr) (hRevNFC revId hr)⟩

/-- ASCII corollary: when the request's identifier, its reversal identifier and the identifiers of the
retained results are constructible and pure ASCII, the only `.error` a call can throw is the
representation limit of the exact numbers. -/
theorem calculateCurrencyRemeasurement_error_only_limit_ascii {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {e : CurrencyErr} (hreq : request.WF) (hstate : state.WF)
    (hIdAscii : ∀ c ∈ request.id.value.toList, c.toNat < 128)
    (hOrigAscii : ∀ r ∈ state.remeasurementResults, ∀ c ∈ r.id.value.toList, c.toNat < 128)
    (hRevAscii : ∀ id, request.reversalId = some id → ∀ c ∈ id.value.toList, c.toNat < 128)
    (herr : calculateCurrencyRemeasurement policies bookId commodityId request state = .error e) :
    e = .exactNumber .representationLimitExceeded :=
  calculateCurrencyRemeasurement_error_only_limit hreq hstate
    (derivedIdsNFC_of_ascii hIdAscii)
    (fun r hr => (derivedIdsNFC_of_ascii (hOrigAscii r hr)).1)
    (fun id hid => derivedIdsNFC_of_ascii (hRevAscii id hid)) herr

/-! ## Laws: a difference of zero -/

/- Such a draft cannot be booked: journal admission refuses a posting whose book value is zero (`journal.ts` line 757, "A canonical posting
 must have a nonzero book value", the `invalid_journal_structure` diagnostic at `.bookValue.amount`; `Journal/Admission.lean`), and
 `quantizeBalancedBookValues` turns a difference that is zero, or that rounds to zero at the policy's scale, into zero book values. -/
/-- Each posting of a drafted remeasurement is zero exactly when the difference is zero, so a difference of zero is drafted, to the loss account, as a journal of two zero postings. -/
theorem calculateCurrencyRemeasurement_zero_difference {policies : List AccountingPolicy}
    {bookId : BookId} {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {d : AccountingDraft} (hreq : request.WF)
    (hnone : request.reversalOf = none)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state =
      .ok (.draft d)) :
    ∃ journal effect, d = { journals := [journal], effects := [.remeasurementResult effect] } ∧
      ∀ posting ∈ journal.postings,
        (posting.exactBookValue.isZero = true ↔ effect.difference.toRat = 0) := by
  obtain ⟨policy, cp, measured, difference, jId, posId, glId, -, -, hm, hs, -, -, -, hd⟩ :=
    (calculateCurrencyRemeasurement_result_iff hnone d).mp h
  obtain ⟨-, hdw, -, -⟩ := result_numbers hreq hm hs
  refine ⟨_, remeasurementResultOf request policy cp measured difference, hd, ?_⟩
  intro posting hp
  simp only [remeasurementJournalOf, remeasurementPostings, List.mem_cons, List.not_mem_nil,
    or_false] at hp
  rcases hp with rfl | rfl
  · exact ExactRational.isZero_iff hdw
  · rw [ExactRational.isZero_iff (ExactRational.negate_wf hdw)]
    show difference.negate.toRat = 0 ↔ difference.toRat = 0
    rw [ExactRational.negate_toRat, neg_eq_zero]

/-! ## Laws: what is drafted is constructible -/

/-- The postings of a generated journal are constructible when their identifiers, accounts, commodity
and amount are. -/
theorem remeasurementPostings_wf {commodityId : CommodityId}
    {positionAccountId gainLossAccountId : AccountId} {positionId gainLossId : PostingId}
    {difference : ExactRational} (hc : commodityId.WF) (hpa : positionAccountId.WF)
    (hga : gainLossAccountId.WF) (hpid : positionId.WF) (hgid : gainLossId.WF)
    (hd : difference.WF) :
    ∀ posting ∈ remeasurementPostings commodityId positionAccountId gainLossAccountId positionId
      gainLossId difference, posting.WF := by
  intro posting hp
  simp only [remeasurementPostings, List.mem_cons, List.not_mem_nil, or_false] at hp
  rcases hp with rfl | rfl
  · exact ⟨hpid, hpa, hd, hc, hd, fun b hb => by cases hb⟩
  · exact ⟨hgid, hga, ExactRational.negate_wf hd, hc, ExactRational.negate_wf hd,
      fun b hb => by cases hb⟩

/-- The result effect of a remeasurement is constructible when the request, the policies, and the
numbers it holds are. -/
theorem remeasurementResultOf_wf {request : CurrencyRemeasurementRequest} {policy : CurrencyPolicy}
    {cp : MonetaryClassificationPolicy} {measured difference : ExactRational}
    (hreq : request.WF) (hpolicy : policy.WF) (hcp : cp.WF) (hm : measured.WF)
    (hd : difference.WF) : (remeasurementResultOf request policy cp measured difference).WF where
  id := hreq.id
  sourcePostingId := hreq.sourcePostingId
  source := hreq.source
  positionAccountId := fun id hid => by cases hid; exact hreq.positionAccountId
  denominationCommodityId := fun id hid => by cases hid; exact hreq.denominationCommodityId
  carryingBookValue := hreq.carryingBookValue
  measuredBookValue := hm
  difference := hd
  valuationRate := hreq.valuationPath.rate
  policyId := hpolicy.core.id
  policy := fun p hp => by cases hp; exact hpolicy
  classificationPolicy := fun p hp => by cases hp; exact hcp
  valuationPath := fun path hp => by cases hp; exact hreq.valuationPath
  derivation := hreq.derivation

/-- The reversal effect is constructible when the reversal identifier, the original and the derived
journal identifier are. -/
theorem reversalEffectOf_wf {request : CurrencyRemeasurementRequest} {original : RemeasurementResult}
    {revId : RemeasurementReversalId} {origJ : JournalId} (hreq : request.WF)
    (hrev : revId.WF) (horig : original.WF) (hj : origJ.WF) :
    (reversalEffectOf request original revId origJ).WF where
  id := hrev
  originalResultId := horig.id
  originalJournalId := fun id hid => by cases hid; exact hj
  derivation := hreq.derivation

/-- The account a reversal posts its gain or loss to is a valid identifier when the policy and the
original are constructible. -/
theorem reversalGainLossAccount_wf {policy : CurrencyPolicy} {original : RemeasurementResult}
    (hp : policy.WF) (ho : original.WF) : (reversalGainLossAccount policy original).WF := by
  unfold reversalGainLossAccount
  cases hpo : original.policy with
  | none =>
    simp only []
    split <;> first | exact hp.gainAccountId | exact hp.lossAccountId
  | some op =>
    have hop := ho.policy op hpo
    simp only []
    split <;> first | exact hop.gainAccountId | exact hop.lossAccountId

/-- **What is drafted is constructible.** A call on a constructible request and state, with
constructible policies and a valid functional commodity, returns a calculation whose journals,
identifiers and exact numbers are constructible. -/
theorem calculateCurrencyRemeasurement_wf {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : CurrencyRemeasurementRequest}
    {state : CurrencyAccountingState} {c : AccountingCalculation}
    (hpol : ∀ p ∈ policies, p.WF) (hcommodity : commodityId.WF) (hreq : request.WF)
    (hstate : state.WF)
    (h : calculateCurrencyRemeasurement policies bookId commodityId request state = .ok c) :
    c.WF := by
  cases c with
  | rejected ds => trivial
  | draft d =>
    show AccountingDraft.WF d
    cases hrev : request.reversalOf with
    | none =>
      obtain ⟨policy, cp, measured, difference, jId, posId, glId, hv, -, hm, hs, hj, hp, hg,
        hd⟩ := (calculateCurrencyRemeasurement_result_iff hrev d).mp h
      subst hd
      obtain ⟨hmw, hdw, -, -⟩ := result_numbers hreq hm hs
      have hpolwf := policyAt_currency_wf hpol hv.policy_selected
      have hcpwf := policyAt_classification_wf hpol hv.classification_policy_selected
      have hjw := ((identifier_ok_iff _ _ _).mp hj).1
      have hpw := ((identifier_ok_iff _ _ _).mp hp).1
      have hgw := ((identifier_ok_iff _ _ _).mp hg).1
      refine ⟨?_, ?_⟩
      · intro journal hjn
        simp only [List.mem_singleton] at hjn
        subst hjn
        refine ⟨(fun q hq => by cases hq), hjw, ?_, ?_⟩
        · refine remeasurementPostings_wf hcommodity hreq.positionAccountId ?_ hpw hgw hdw
          split <;> first | exact hpolwf.gainAccountId | exact hpolwf.lossAccountId
        · intro derivation hderiv
          have hd1 := List.mem_singleton.mp hderiv
          subst hd1
          exact hreq.derivation
      · intro effect heff
        simp only [List.mem_singleton] at heff
        subst heff
        exact remeasurementResultOf_wf hreq hpolwf hcpwf hmw hdw
    | some rid =>
      obtain ⟨policy, cp, original, revId, origJ, revJ, posId, glId, hv, -, hf, hk, hr, hno, hj1,
        hj2, hp, hg, hd⟩ := (calculateCurrencyRemeasurement_reversal_iff hrev d).mp h
      subst hd
      have horig := hstate.remeasurementResults original (List.mem_of_find?_eq_some hf)
      have hpolwf := policyAt_currency_wf hpol hv.policy_selected
      have hoj := ((identifier_ok_iff _ _ _).mp hj1).1
      have hrj := ((identifier_ok_iff _ _ _).mp hj2).1
      have hpw := ((identifier_ok_iff _ _ _).mp hp).1
      have hgw := ((identifier_ok_iff _ _ _).mp hg).1
      refine ⟨?_, ?_⟩
      · intro journal hjn
        simp only [List.mem_singleton] at hjn
        subst hjn
        refine ⟨(fun q hq => by cases hq), hrj, ?_, ?_⟩
        · exact remeasurementPostings_wf hcommodity hreq.positionAccountId
            (reversalGainLossAccount_wf hpolwf horig) hpw hgw (ExactRational.negate_wf horig.difference)
        · intro derivation hderiv
          have hd1 := List.mem_singleton.mp hderiv
          subst hd1
          exact hreq.derivation
      · intro effect heff
        simp only [List.mem_singleton] at heff
        subst heff
        exact reversalEffectOf_wf hreq (hreq.reversalId revId hr) horig hoj

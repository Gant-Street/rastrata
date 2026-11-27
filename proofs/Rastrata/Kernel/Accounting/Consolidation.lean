/-
Consolidation: the Lean model of `packages/kernel/src/accounting.ts` lines 2025 to 2164
(`ConsolidationValuationStep`, `ConsolidationValuationPath`, `ConsolidationSource`,
`ConsolidationElimination`, `ConsolidationRequest`, `compileConsolidation`) and the proofs of its laws.

Three layers, as everywhere in this project:

1. **Model.** The five consolidation input types and `compileConsolidation`, cut into one named
   piece for each stage of the TypeScript, in the order of the code, each with a doc comment that
   names its lines: `boundsInvalid` (2033), `derivationInvalid` (2034), `validateSources` (2035 to
   2047), `eliminationsInvalid` (2048 to 2052), `globalValuationInvalid` (2060), `resolveTarget` and
   `resolveTargetsLoop` (2061 to 2066, 2111 to 2117), `resolveRate` (`pathCandidate`,
   `collectCandidates`, `selectRate`, 2068 to 2110) and `resolveRatesLoop` (2118 to 2125),
   `compileSourceBalances`, `compileNciPostings`, `compileSource`, `compileSourcesLoop`,
   `compileEliminationsLoop` and `compileDraft` (2126 to 2163). `compileConsolidation_eq` says the
   function is the composition of them. Every check and every diagnostic (code, path, message,
   requirement identifiers) is as in the TypeScript, in the same order; `Except` carries what throws.
2. **Meaning.** `WF` for every input record (constructible exact numbers and valid identifiers), and
   the exact rational meaning (`ExactRational.toRat`) of every value the laws speak of.
3. **Laws.** Each is a theorem with a doc comment. Their hypotheses are only that the request is
   constructible (`ConsolidationRequest.WF`) and that the call returned what the law is about.
   - Balance: `compileConsolidation_balanced` (one journal whose exact book values add up to zero,
     and each source's postings on their own), `compileSource_spec`, `compileDraft_spec`;
     `not_rejected_unbalanced` (the rejection of line 2159 cannot happen).
   - Eliminations: `compileConsolidation_eliminations` (their postings are their amounts on their
     target accounts, they add up to zero, and on every account the compiled total is the sources'
     plus theirs); `rejected_eliminations_iff` says exactly what is checked of them.
   - Translation: `evalPathSteps_spec` (the rate of a path is the product of the factors of its
     steps, in order), `resolveRate_spec` and `RateFact`, `compileConsolidation_balance_postings`
     (every balance is posted at its translated amount), `translate_back` (along a path and back).
   - Mappings: `compileConsolidation_balance_postings` (the account is the target of the one
     mapping of the policy), `rejected_mappings_iff`, `mappingTarget_sortMappings`.
   - Order of the sources: `compileConsolidation_draft_perm` and `_iff` (a draft does not depend on
     it); `sourcesCheck_order_matters` and `ratesLoop_order_matters` (a rejection or an error does).
   - Hash: `compilationEffect_hash` (the content hash is the hash of the body, and the kernel's own
     `validateAccountingEffectHash` accepts it).
   - Rejections, one iff theorem for each reason: `rejected_bounds_iff`, `rejected_derivation_iff`,
     `rejected_sources_iff`, `rejected_eliminations_iff`, `rejected_valuationPolicy_iff`,
     `rejected_mappings_iff`, `rejected_duplicate_iff`, `rejected_translation_iff` with
     `resolveRate_sameCommodity_iff`, `resolveRate_missingRule_iff`,
     `resolveRate_targetMismatch_iff`, `resolveRate_ruleValuation_iff`, `resolveRate_noPath_iff` and
     `resolveRate_ambiguous_iff`; `compileConsolidation_draft_iff` for a draft.
   - Errors: `compileConsolidation_spec`, `compileConsolidation_error_limit` and
     `compileConsolidation_error` (the only `.error` is the size limit of exact numbers; for an
     identifier of the request that is not ASCII, also a derived identifier failing the NFC test of
     `identifier`, which this file cannot show impossible because the NFC helpers of
     `Canonical.lean` are private).

What is assumed about JavaScript, and what is not modelled:

- `Object.freeze`, `immutableAccountingValue`, and object identity (`!==` in the ambiguity check of
  `accounting.ts` line 2107) are not modelled; for `candidate !== best && !candidate.rate.equals(best.rate)`,
  `!best.rate.equals(best.rate)` is always `false`, so value-based checking is identical.
- `Array.prototype.sort` is stable and modelled via `List.mergeSort`; the comparators are total
  preorders (string order by UTF-16 code unit, numbers), so the two agree.
- `Map` and `Set` compare string keys by exact string equality (`==`); a `Map` is an association
  list in which `mapSet` prepends, which gives the same answers because a key always receives the
  same value.
- `JSON.stringify` on lists of strings (`coordinate`, `eliminationPostingIds`, `order`) is modelled
  character by character as ECMA-262 `QuoteJSONString` (`jsonStringifyStringList`, proved injective
  on Lean `String`s, which contain no lone UTF-16 surrogates).
- String comparisons (`<=`, `<`, `>`, `>=`, `compareCanonicalText`) compare UTF-16 code units via
  `jsStringLe`, `jsStringLt`, and `compareCanonicalText`.
- `path.effectiveAt.slice(0, 10) !== request.throughOn` (`accounting.ts` line 2085) compares the
  first 10 UTF-16 code units of `path.effectiveAt` against `request.throughOn`.
- Derived identifiers (`${request.id}-source-${ordinal}` and the four like it, `${request.id}-journal`)
  call `postingId` and `journalId`, which throw when the text is not a valid identifier
  (`derivedPostingId`). `DerivedIdsOk` is what the laws about errors assume of them.
- The unreachable arms (`resolvedRates.get(...)!` and `resolvedTargets.get(...)!` of lines 2135 and
  2138, `source.nonControllingInterestFairValue!` of line 2142, the empty list in `selectRate`) get
  defaults that no checked request reaches.

How the model was checked against the TypeScript: a one-off script built requests with the real
constructors, ran the real `compileConsolidation`, and ran this model on the same data; the two
agreed on every one of 1,656 inputs (every rejection, the size limit, and 950 drafts with their
posting identifiers, values, order and content hashes).
-/
import Rastrata.Prelude
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Accounting.Core.Canonical
import Rastrata.Kernel.Accounting.Core.Model
import Mathlib.Data.List.Perm.Basic

namespace Rastrata.Kernel

/-! ## Types (`accounting.ts` lines 2025 to 2029) -/

/-- `ConsolidationValuationStep` (`accounting.ts` line 2025). `evidenceIds` is `readonly string[]`. -/
structure ConsolidationValuationStep where
  fromCommodityId : CommodityId
  toCommodityId : CommodityId
  rate : ExactRational
  observedAt : Instant
  evidenceIds : List String
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationValuationPath` (`accounting.ts` line 2026). `id` is a plain string. -/
structure ConsolidationValuationPath where
  id : String
  effectiveAt : Instant
  steps : List ConsolidationValuationStep
  deriving DecidableEq, Repr, Inhabited

/-- The type of `ConsolidationSource.control` (`accounting.ts` line 2027). -/
inductive ConsolidationControl where
  | controlled
  | jointlyControlled
  | significantInfluence
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `ConsolidationControl`. -/
def ConsolidationControl.text : ConsolidationControl → String
  | .controlled => "controlled"
  | .jointlyControlled => "jointlyControlled"
  | .significantInfluence => "significantInfluence"

/-- The type of `ConsolidationSource.nonControllingInterestMethod` (`accounting.ts` line 2027). -/
inductive NonControllingInterestMethod where
  | proportionateNetAssets
  | fairValue
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `NonControllingInterestMethod`. -/
def NonControllingInterestMethod.text : NonControllingInterestMethod → String
  | .proportionateNetAssets => "proportionateNetAssets"
  | .fairValue => "fairValue"

/-- The type of `ConsolidationSource.balances[number].classification` (`accounting.ts` line 2027). -/
inductive ConsolidationBalanceClassification where
  | asset
  | liability
  | equity
  | income
  | expense
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `ConsolidationBalanceClassification`. -/
def ConsolidationBalanceClassification.text : ConsolidationBalanceClassification → String
  | .asset => "asset"
  | .liability => "liability"
  | .equity => "equity"
  | .income => "income"
  | .expense => "expense"

/-- The element type of `ConsolidationSource.balances`, unnamed in the TypeScript
(`accounting.ts` line 2027). -/
structure ConsolidationSourceBalance where
  sourceAccountId : AccountId
  unitsCommodityId : CommodityId
  classification : ConsolidationBalanceClassification
  amount : ExactRational
  valuationPaths : List ConsolidationValuationPath
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationSource` (`accounting.ts` line 2027). -/
structure ConsolidationSource where
  bookId : BookId
  revision : Int
  postingSequence : Int
  populationHash : ContentHash
  expectedRevision : Int
  expectedPostingSequence : Int
  expectedPopulationHash : ContentHash
  relationshipId : String
  relationshipValidFrom : Instant
  relationshipValidTo : Option Instant
  control : ConsolidationControl
  method : ConsolidationMethod
  ownershipShare : ExactRational
  votingShare : ExactRational
  nonControllingInterestMethod : Option NonControllingInterestMethod
  nonControllingInterestFairValue : Option ExactRational
  controlEvidenceIds : List String
  balances : List ConsolidationSourceBalance
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationElimination` (`accounting.ts` line 2028). -/
structure ConsolidationElimination where
  id : String
  sourceBookId : BookId
  sourceAccountId : AccountId
  targetAccountId : AccountId
  amount : ExactRational
  evidenceIds : List String
  sourcePostingIds : List PostingId
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationRequest` (`accounting.ts` line 2029). -/
structure ConsolidationRequest where
  id : ConsolidationCompilationId
  policyId : PolicyId
  policyVersion : SemanticVersion
  governedAt : Instant
  throughOn : LocalDate
  targetBookId : BookId
  sources : List ConsolidationSource
  eliminations : List ConsolidationElimination
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-! ## Meaning: constructible values (`WF`) -/

/-- A constructible valuation step: valid commodity identifiers and a constructible rate. -/
structure ConsolidationValuationStep.WF (step : ConsolidationValuationStep) : Prop where
  fromCommodityId : step.fromCommodityId.WF
  toCommodityId : step.toCommodityId.WF
  rate : step.rate.WF

/-- A constructible valuation path: every step is constructible. -/
structure ConsolidationValuationPath.WF (path : ConsolidationValuationPath) : Prop where
  steps : ∀ step ∈ path.steps, step.WF

/-- A constructible source balance: valid identifiers, constructible amount and valuation paths. -/
structure ConsolidationSourceBalance.WF (balance : ConsolidationSourceBalance) : Prop where
  sourceAccountId : balance.sourceAccountId.WF
  unitsCommodityId : balance.unitsCommodityId.WF
  amount : balance.amount.WF
  valuationPaths : ∀ path ∈ balance.valuationPaths, path.WF

/-- A constructible consolidation source: valid book identifier, constructible shares, optional fair
value, and balances. -/
structure ConsolidationSource.WF (source : ConsolidationSource) : Prop where
  bookId : source.bookId.WF
  ownershipShare : source.ownershipShare.WF
  votingShare : source.votingShare.WF
  nonControllingInterestFairValue :
    ∀ v, source.nonControllingInterestFairValue = some v → v.WF
  balances : ∀ balance ∈ source.balances, balance.WF

/-- A constructible consolidation elimination: valid identifiers and constructible amount. -/
structure ConsolidationElimination.WF (elimination : ConsolidationElimination) : Prop where
  sourceBookId : elimination.sourceBookId.WF
  sourceAccountId : elimination.sourceAccountId.WF
  targetAccountId : elimination.targetAccountId.WF
  amount : elimination.amount.WF
  sourcePostingIds : ∀ id ∈ elimination.sourcePostingIds, id.WF

/-- A constructible consolidation request: valid identifiers, constructible sources, eliminations,
and derivation. -/
structure ConsolidationRequest.WF (request : ConsolidationRequest) : Prop where
  id : request.id.WF
  policyId : request.policyId.WF
  targetBookId : request.targetBookId.WF
  sources : ∀ source ∈ request.sources, source.WF
  eliminations : ∀ elimination ∈ request.eliminations, elimination.WF
  derivation : request.derivation.WF

/-- Errors that `compileConsolidation` can throw: an `ExactNumberError` of `numeric.ts` or an
`IdentityError` of `canonical.ts`. -/
inductive ConsolidationErr where
  | exactNumber (code : NumErr)
  | canonical (code : CanonicalErr)
  deriving DecidableEq, Repr, Inhabited

namespace Consolidation

/-! ## Helpers (`accounting.ts` lines 2032, 2049 to 2058, 2085) -/

/-- Lift `Except NumErr` to `Except ConsolidationErr`. -/
def liftNum {α : Type} : Except NumErr α → Except ConsolidationErr α
  | .ok v => .ok v
  | .error e => .error (.exactNumber e)

/-- Lift `Except CanonicalErr` to `Except ConsolidationErr`. -/
def liftCanonical {α : Type} : Except CanonicalErr α → Except ConsolidationErr α
  | .ok v => .ok v
  | .error e => .error (.canonical e)

/-- `unit = ExactRational.of(1n, 1n)` (`accounting.ts` line 2032). -/
def rationalOne : ExactRational := ⟨1, 1⟩

/-- `ExactRational.toString` (`numeric.ts` line 203, called at `accounting.ts` line 2155). -/
def rationalToString (r : ExactRational) : String :=
  toString r.numerator ++ "/" ++ toString r.denominator

/-- Lowercase hex digit of a nibble `0..15`. -/
def lowerHexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

/-- Escape one character matching ECMA-262 `QuoteJSONString`. -/
def jsonEscapeChar (c : Char) : List Char :=
  let n := c.toNat
  if c == '"' then ['\\', '"']
  else if c == '\\' then ['\\', '\\']
  else if n == 0x08 then ['\\', 'b']
  else if n == 0x09 then ['\\', 't']
  else if n == 0x0a then ['\\', 'n']
  else if n == 0x0c then ['\\', 'f']
  else if n == 0x0d then ['\\', 'r']
  else if n < 0x20 then ['\\', 'u', '0', '0', lowerHexDigit (n / 16), lowerHexDigit (n % 16)]
  else [c]

/-- `JSON.stringify(value)` for a string. -/
def jsonQuoteString (s : String) : List Char :=
  '"' :: s.toList.flatMap jsonEscapeChar ++ ['"']

/-- `JSON.stringify(values)` for a list of strings (`accounting.ts` lines 2049, 2054, 2058). -/
def jsonStringifyStringList (values : List String) : String :=
  String.ofList ('[' :: List.intercalate [','] (values.map jsonQuoteString) ++ [']'])

/-- `coordinate(book, account)` (`accounting.ts` line 2054). -/
def coordinate (book : BookId) (account : AccountId) : String :=
  jsonStringifyStringList [book.value, account.value]

/-- `order(left, right)` (`accounting.ts` lines 2057 to 2058). -/
def tupleOrder (left right : List String) : Ordering :=
  match compareCanonicalText (String.intercalate ":" left) (String.intercalate ":" right) with
  | .eq => compareCanonicalText (jsonStringifyStringList left) (jsonStringifyStringList right)
  | ord => ord

/-- `Map.prototype.get` on an association list where `mapSet` prepends entries. -/
def mapGet {α : Type} (entries : List (String × α)) (key : String) : Option α :=
  (entries.find? (·.1 == key)).map (·.2)

/-- `Map.prototype.has` on an association list. -/
def mapHas {α : Type} (entries : List (String × α)) (key : String) : Bool :=
  entries.any (·.1 == key)

/-- `Map.prototype.set` on an association list: prepend so `mapGet` returns the latest value. -/
def mapSet {α : Type} (entries : List (String × α)) (key : String) (value : α) :
    List (String × α) :=
  (key, value) :: entries

/-- `text.slice(0, 10)`: the first ten UTF-16 code units of `text` (`accounting.ts` line 2085). -/
def jsSlicePrefix10 (text : String) : List UInt16 := (stringToUTF16 text).take 10

/-! ## Rejections and diagnostics (`accounting.ts` lines 2033 to 2159) -/

/-- Population bound rejection (`accounting.ts` line 2033). -/
def boundsRejection : AccountingCalculation :=
  reject .consolidation_input_violation "command.consolidation"
    "Consolidation population exceeds the executable bound" ["ACC-046.1"]

/-- Derivation lineage rejection (`accounting.ts` line 2034). -/
def derivationRejection : AccountingCalculation :=
  reject .consolidation_input_violation "command.consolidation.derivation"
    "Consolidation lineage must be approved and bound to the selected canonical policy version"
    ["ACC-046.1", "ACC-047.5"]

/-- Sources and policy rejection (`accounting.ts` line 2047). -/
def sourcesRejection : AccountingCalculation :=
  reject .consolidation_input_violation "command.consolidation.sources"
    "Consolidation requires fresh pinned noncircular populations and compatible evidenced relationships and ownership"
    ["ACC-046.1", "ACC-046.2", "ACC-046.3", "ACC-046.4", "ACC-046.7"]

/-- Eliminations rejection (`accounting.ts` line 2052). -/
def eliminationsRejection : AccountingCalculation :=
  reject .consolidation_input_violation "command.consolidation.eliminations"
    "Eliminations require unique matched source postings, evidence-declared target accounts, and an independently balanced exact set"
    ["ACC-046.5", "ACC-046.6"]

/-- Global valuation policy rejection (`accounting.ts` line 2060). -/
def valuationPolicyRejection : AccountingCalculation :=
  reject .consolidation_input_violation "command.consolidation.valuationPolicy"
    "The consolidation valuation policy must be effective and executable at the governed instant"
    ["ACC-046.4"]

/-- Missing or ambiguous account mapping diagnostic (`accounting.ts` line 2064). -/
def mappingsDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.mappings"
    "Every source balance must resolve to exactly one canonical policy account mapping"
    ["ACC-046.4"]

/-- Same-commodity balance with non-empty valuation paths diagnostic (`accounting.ts` line 2071). -/
def sameCommodityPathDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.translation"
    "Same-commodity balances must not present an unnecessary valuation path" ["ACC-046.4"]

/-- Missing or ambiguous translation rule diagnostic (`accounting.ts` line 2075). -/
def missingTranslationRuleDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.translation"
    "Every translated balance requires exactly one canonical translation rule effective through the consolidation date"
    ["ACC-046.4"]

/-- Translation rule target mismatch diagnostic (`accounting.ts` line 2078). -/
def ruleTargetMismatchDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.translation"
    "A translation rule target must agree with the canonical account mapping for its source account"
    ["ACC-046.4"]

/-- Rule valuation policy ineffective/incompatible diagnostic (`accounting.ts` line 2081). -/
def ruleValuationPolicyDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.translation"
    "The translation rule's valuation policy is not effective through the consolidation instant"
    ["ACC-046.4"]

/-- No admissible valuation path diagnostic (`accounting.ts` line 2102). -/
def noAdmissiblePathDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.translation"
    "No complete evidence-backed valuation path is admissible under the applicable rule and policy"
    ["ACC-046.4"]

/-- Ambiguous equally-preferred valuation paths diagnostic (`accounting.ts` line 2108). -/
def ambiguousPathRateDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.translation"
    "Equally preferred supplied valuation paths disagree on the exact rate" ["ACC-046.4"]

/-- Duplicate source account balance diagnostic (`accounting.ts` line 2121). -/
def duplicateSourceAccountDiagnostic : SemanticDiagnostic :=
  diagnostic .consolidation_input_violation "command.consolidation.sources"
    "Each source account may present only one balance per consolidation" ["ACC-046.2"]

/-- Unbalanced consolidation draft rejection (`accounting.ts` line 2159). -/
def unbalancedDraftRejection : AccountingCalculation :=
  reject .consolidation_input_violation "command.consolidation"
    "Consolidation draft is not balanced" ["ACC-046.6", "ACC-046.8"]

/-! ## Request, source, elimination, and mapping validation (`accounting.ts` lines 2033 to 2066, 2111 to 2117) -/

/-- Population bound check (`accounting.ts` line 2033). -/
def boundsInvalid (request : ConsolidationRequest) : Bool :=
  decide (request.sources.length > accountingLimits.maxConsolidationSources) ||
  decide (request.eliminations.length > accountingLimits.maxConsolidationEliminations)

/-- Derivation lineage check (`accounting.ts` line 2034). -/
def derivationInvalid (request : ConsolidationRequest) : Bool :=
  !validAccountingDerivation request.derivation ||
  request.derivation.policyId != request.policyId ||
  request.derivation.policyVersion != request.policyVersion

/-- Non-throwing validation checks for a single `ConsolidationSource` (`accounting.ts` lines 2036 to
2046, before `sum(source.balances)`). -/
def sourceHeaderInvalid (policy : ConsolidationPolicy) (targetBookId : BookId)
    (governedAt : Instant) (source : ConsolidationSource) : Bool :=
  source.bookId == targetBookId ||
  decide (source.revision ≤ 0) ||
  decide (source.postingSequence < 0) ||
  source.revision != source.expectedRevision ||
  source.postingSequence != source.expectedPostingSequence ||
  !contentHashEqual source.populationHash source.expectedPopulationHash ||
  source.controlEvidenceIds.isEmpty ||
  (jsTrim source.relationshipId).length == 0 ||
  jsStringLt governedAt.value source.relationshipValidFrom.value ||
  (match source.relationshipValidTo with
    | none => false
    | some vt => jsStringLe vt.value governedAt.value) ||
  source.ownershipShare.compare ExactRational.zero == .lt ||
  source.ownershipShare.compare rationalOne == .gt ||
  source.votingShare.compare ExactRational.zero == .lt ||
  source.votingShare.compare rationalOne == .gt ||
  (match source.control with
    | .controlled => source.method != .full
    | .significantInfluence => source.method != .equity
    | .jointlyControlled => source.method != .jointOperationShare) ||
  !policy.supportedMethods.contains source.method ||
  (source.method == .full && source.ownershipShare.compare rationalOne == .lt &&
    source.nonControllingInterestMethod.isNone) ||
  (source.method == .full && source.ownershipShare.equals rationalOne &&
    (source.nonControllingInterestMethod.isSome || source.nonControllingInterestFairValue.isSome)) ||
  (source.method != .full &&
    (source.nonControllingInterestMethod.isSome || source.nonControllingInterestFairValue.isSome)) ||
  (source.nonControllingInterestMethod == some .proportionateNetAssets &&
    source.nonControllingInterestFairValue.isSome) ||
  (source.nonControllingInterestMethod == some .fairValue &&
    (match source.nonControllingInterestFairValue with
      | none => true
      | some fv => positive fv)) ||
  source.balances.isEmpty ||
  decide (source.balances.length > accountingLimits.maxConsolidationBalancesPerSource)

/-- `request.sources.some(...)` (`accounting.ts` lines 2035 to 2046): checks sources left-to-right,
short-circuiting on the first invalid source and throwing if `sum(source.balances)` overflows. -/
def anySourceInvalid (policy : ConsolidationPolicy) (targetBookId : BookId)
    (governedAt : Instant) : List ConsolidationSource → Except ConsolidationErr Bool
  | [] => .ok false
  | source :: rest =>
    if sourceHeaderInvalid policy targetBookId governedAt source then .ok true
    else
      match liftNum (accountingSum (source.balances.map (·.amount))) with
      | .error e => .error e
      | .ok total =>
        if !total.isZero then .ok true
        else anySourceInvalid policy targetBookId governedAt rest

/-- The full check of `accounting.ts` lines 2035 to 2047: returns `.ok (some policy)` when valid,
`.ok none` when rejected, and `.error` when `sum(source.balances)` throws. -/
def validateSources (selected : AccountingPolicySelection ConsolidationPolicy)
    (request : ConsolidationRequest) : Except ConsolidationErr (Option ConsolidationPolicy) :=
  match selected with
  | .rejected _ => .ok none
  | .selected policy =>
    if request.sources.isEmpty ||
        !decide (request.sources.map (·.bookId)).Nodup ||
        !decide (request.sources.map (·.relationshipId)).Nodup then
      .ok none
    else
      match anySourceInvalid policy request.targetBookId request.governedAt request.sources with
      | .error e => .error e
      | .ok true => .ok none
      | .ok false => .ok (some policy)

/-- `JSON.stringify([item.sourceBookId, id])` across all eliminations (`accounting.ts` line 2049). -/
def eliminationPostingKeys (eliminations : List ConsolidationElimination) : List String :=
  eliminations.flatMap fun item =>
    item.sourcePostingIds.map fun id =>
      jsonStringifyStringList [item.sourceBookId.value, id.value]

/-- Check of `accounting.ts` lines 2048 to 2052: `true` when rejected. -/
def eliminationsInvalid (request : ConsolidationRequest) : Except ConsolidationErr Bool :=
  let sourceBookIds := request.sources.map (·.bookId)
  if !decide (request.eliminations.map (·.id)).Nodup ||
      !decide (eliminationPostingKeys request.eliminations).Nodup ||
      request.eliminations.any (fun item =>
        (jsTrim item.id).length == 0 ||
        !sourceBookIds.contains item.sourceBookId ||
        item.evidenceIds.isEmpty ||
        item.sourcePostingIds.isEmpty ||
        item.amount.isZero) then
    .ok true
  else
    match liftNum (accountingSum (request.eliminations.map (·.amount))) with
    | .error e => .error e
    | .ok total => .ok (!total.isZero)

/-- Check of `accounting.ts` line 2060: `true` when the global valuation policy is invalid. -/
def globalValuationInvalid (governedAt : Instant) (valPolicy : ConsolidationValuationPolicy) :
    Bool :=
  jsStringLt governedAt.value valPolicy.validFrom.value ||
  (match valPolicy.validTo with
    | none => false
    | some vt => jsStringLe vt.value governedAt.value) ||
  decide (valPolicy.maximumHops ≤ 0)

/-- Sort `policy.accountMappings` (`accounting.ts` line 2061). -/
def sortMappings (mappings : List ConsolidationAccountMapping) :
    List ConsolidationAccountMapping :=
  mappings.mergeSort fun left right =>
    jsStringLe
      ((left.sourceBookId.map (·.value)).getD "" ++ ":" ++ left.sourceAccountId.value)
      ((right.sourceBookId.map (·.value)).getD "" ++ ":" ++ right.sourceAccountId.value)

/-- Filter predicate inside `resolveTarget` (`accounting.ts` line 2063). -/
def mappingApplies (sourceBookId : BookId) (sourceAccountId : AccountId) (governedAt : Instant)
    (mapping : ConsolidationAccountMapping) : Bool :=
  mapping.sourceAccountId == sourceAccountId &&
  (mapping.sourceBookId.isNone || mapping.sourceBookId == some sourceBookId) &&
  jsStringLe mapping.validFrom.value governedAt.value &&
  (match mapping.validTo with
    | none => true
    | some vt => jsStringLt governedAt.value vt.value)

/-- `resolveTarget` (`accounting.ts` lines 2062 to 2066). -/
def resolveTarget (mappings : List ConsolidationAccountMapping) (governedAt : Instant)
    (sourceBookId : BookId) (sourceAccountId : AccountId) :
    Sum (List SemanticDiagnostic) AccountId :=
  match mappings.filter (mappingApplies sourceBookId sourceAccountId governedAt) with
  | [m] => .inr m.targetAccountId
  | _ => .inl [mappingsDiagnostic]

/-- The pairs `(source.bookId, balance)` that the two nested `for` loops of `accounting.ts` lines
2112 and 2119 visit, in the order of the loops: every balance of the first source, then of the
second, and so on. -/
def balancePairs (sources : List ConsolidationSource) :
    List (BookId × ConsolidationSourceBalance) :=
  sources.flatMap fun source => source.balances.map fun balance => (source.bookId, balance)

/-- The loop of `accounting.ts` lines 2111 to 2117 over `balancePairs`: each balance's account is
resolved, the first that does not resolve ends the loop with its diagnostics, and each target is
recorded under the balance's coordinate (`mapSet`). -/
def resolveTargetsLoop (mappings : List ConsolidationAccountMapping) (governedAt : Instant) :
    List (String × AccountId) → List (BookId × ConsolidationSourceBalance) →
      Sum (List SemanticDiagnostic) (List (String × AccountId))
  | entries, [] => .inr entries
  | entries, (book, balance) :: rest =>
    match resolveTarget mappings governedAt book balance.sourceAccountId with
    | .inl diags => .inl diags
    | .inr target =>
      resolveTargetsLoop mappings governedAt
        (mapSet entries (coordinate book balance.sourceAccountId) target) rest

/-! ## Rate resolution (`accounting.ts` lines 2068 to 2110, 2118 to 2125) -/

/-- Sort `policy.translationRules` (`accounting.ts` line 2068). -/
def sortRules (rules : List ConsolidationTranslationRule) :
    List ConsolidationTranslationRule :=
  rules.mergeSort fun left right =>
    tupleOrder
      [(left.sourceBookId.map (·.value)).getD "", left.sourceAccountId.value]
      [(right.sourceBookId.map (·.value)).getD "", right.sourceAccountId.value] != .gt

/-- Filter predicate inside `resolveRate` (`accounting.ts` line 2074). -/
def ruleApplies (sourceBookId : BookId) (sourceAccountId : AccountId) (governedAt : Instant)
    (rule : ConsolidationTranslationRule) : Bool :=
  rule.sourceAccountId == sourceAccountId &&
  (rule.sourceBookId.isNone || rule.sourceBookId == some sourceBookId) &&
  jsStringLe rule.validFrom.value governedAt.value &&
  (match rule.validTo with
    | none => true
    | some vt => jsStringLt governedAt.value vt.value)

/-- Compatibility and effectiveness check for a translation rule's valuation policy
(`accounting.ts` line 2080). -/
def ruleValuationInvalid (governedAt : Instant)
    (globalValuation valuation : ConsolidationValuationPolicy) : Bool :=
  jsStringLt governedAt.value valuation.validFrom.value ||
  (match valuation.validTo with
    | none => false
    | some vt => jsStringLe vt.value governedAt.value) ||
  decide (valuation.maximumHops ≤ 0) ||
  decide (valuation.maximumHops > globalValuation.maximumHops) ||
  (valuation.allowInverseObservation && !globalValuation.allowInverseObservation)

/-- Candidate path summary (`accounting.ts` line 2083). -/
structure PathCandidate where
  id : String
  effectiveAt : Instant
  rate : ExactRational
  hops : Nat
  direct : Bool
  deriving DecidableEq, Repr, Inhabited

/-- Walk the steps of one valuation path (`accounting.ts` lines 2091 to 2099), returning `none` if
the loop breaks (`admissible = false`) and `some (current, rate, usedInverse)` otherwise. -/
def evalPathSteps (governedAt : Instant) (allowInverse : Bool) :
    CommodityId → ExactRational → Bool → List CommodityId → List ConsolidationValuationStep →
      Except ConsolidationErr (Option (CommodityId × ExactRational × Bool))
  | current, rate, usedInverse, _, [] => .ok (some (current, rate, usedInverse))
  | current, rate, usedInverse, visited, step :: rest =>
    if step.evidenceIds.isEmpty || !positive step.rate ||
        jsStringLt governedAt.value step.observedAt.value then
      .ok none
    else if step.fromCommodityId == current then
      match liftNum (rate.multiply step.rate) with
      | .error e => .error e
      | .ok nextRate =>
        let next := step.toCommodityId
        if visited.contains next then .ok none
        else evalPathSteps governedAt allowInverse next nextRate usedInverse (next :: visited) rest
    else if allowInverse && step.toCommodityId == current &&
        step.fromCommodityId != step.toCommodityId then
      match liftNum (rate.divide step.rate) with
      | .error e => .error e
      | .ok nextRate =>
        let next := step.fromCommodityId
        if visited.contains next then .ok none
        else evalPathSteps governedAt allowInverse next nextRate true (next :: visited) rest
    else
      .ok none

/-- Path header filter (`accounting.ts` line 2085). -/
def pathHeaderAdmissible (governedAt : Instant) (throughOn : LocalDate) (maximumHops : Int)
    (path : ConsolidationValuationPath) : Bool :=
  (jsTrim path.id).length != 0 &&
  !path.steps.isEmpty &&
  decide ((path.steps.length : Int) ≤ maximumHops) &&
  jsStringLe path.effectiveAt.value governedAt.value &&
  jsSlicePrefix10 path.effectiveAt.value == stringToUTF16 throughOn.value

/-- One iteration of the loop of `accounting.ts` lines 2084 to 2101: the candidate a path makes, if it
makes one. The path must pass the header test of line 2085, its steps must be walked to the end
(lines 2086 to 2099, which may throw), and the walk must end in the commodity of the book (line 2100). -/
def pathCandidate (governedAt : Instant) (throughOn : LocalDate) (maximumHops : Int)
    (allowInverse : Bool) (fromCommodityId targetCommodityId : CommodityId)
    (path : ConsolidationValuationPath) : Except ConsolidationErr (Option PathCandidate) :=
  if !pathHeaderAdmissible governedAt throughOn maximumHops path then .ok none
  else
    match evalPathSteps governedAt allowInverse fromCommodityId rationalOne false
        [fromCommodityId] path.steps with
    | .error e => .error e
    | .ok none => .ok none
    | .ok (some (endCommodity, rate, usedInverse)) =>
      if endCommodity == targetCommodityId then
        .ok (some { id := path.id, effectiveAt := path.effectiveAt, rate,
                    hops := path.steps.length,
                    direct := decide (path.steps.length = 1) && !usedInverse })
      else .ok none

/-- The loop of `accounting.ts` lines 2084 to 2101: the candidates of the paths, in the order of the
paths; the first path that throws ends it. -/
def collectCandidates (governedAt : Instant) (throughOn : LocalDate) (maximumHops : Int)
    (allowInverse : Bool) (fromCommodityId targetCommodityId : CommodityId) :
    List ConsolidationValuationPath → Except ConsolidationErr (List PathCandidate)
  | [] => .ok []
  | path :: rest =>
    match pathCandidate governedAt throughOn maximumHops allowInverse fromCommodityId
        targetCommodityId path with
    | .error e => .error e
    | .ok candidate =>
      match collectCandidates governedAt throughOn maximumHops allowInverse fromCommodityId
          targetCommodityId rest with
      | .error e => .error e
      | .ok tail => .ok (candidate.toList ++ tail)

/-- Comparator for preferred valuation paths (`accounting.ts` line 2105): fewest hops, then latest
`effectiveAt` (as text), then smallest `id` (as text). -/
def compareCandidate (left right : PathCandidate) : Ordering :=
  if left.hops < right.hops then .lt
  else if right.hops < left.hops then .gt
  else
    match compareCanonicalText right.effectiveAt.value left.effectiveAt.value with
    | .eq => compareCanonicalText left.id right.id
    | ord => ord

/-- The choice of lines 2102 to 2109 among the admissible paths: none is the diagnostic of line 2102;
otherwise the direct ones are preferred when either policy asks for it and one exists (line 2104),
the preferred are ordered by `compareCandidate` (line 2105, a stable sort), the first is the best,
and the best is refused when another with the same hops and `effectiveAt` has another rate
(lines 2106 to 2108). -/
def selectRate (preferDirect : Bool) (candidates : List PathCandidate) :
    Sum (List SemanticDiagnostic) ExactRational :=
  if candidates.isEmpty then .inl [noAdmissiblePathDiagnostic]
  else
    let preferred :=
      if preferDirect && candidates.any (·.direct) then candidates.filter (·.direct)
      else candidates
    let sorted := preferred.mergeSort fun left right => compareCandidate left right != .gt
    match sorted with
    | [] => .inl [noAdmissiblePathDiagnostic]
    | best :: _ =>
      let ambiguous := sorted.any fun candidate =>
        candidate.hops == best.hops && candidate.effectiveAt == best.effectiveAt &&
        !candidate.rate.equals best.rate
      if ambiguous then .inl [ambiguousPathRateDiagnostic] else .inr best.rate

/-- The part of `resolveRate` after its one translation rule is found (`accounting.ts` lines 2076
to 2109): the rule's target must be the mapped target (line 2078), its valuation policy must be
effective and compatible (line 2080), and the rate is chosen among the admissible paths. -/
def resolveRateByRule (globalValuation : ConsolidationValuationPolicy) (governedAt : Instant)
    (throughOn : LocalDate) (commodityId : CommodityId)
    (resolvedTargets : List (String × AccountId)) (sourceBookId : BookId)
    (balance : ConsolidationSourceBalance) (rule : ConsolidationTranslationRule) :
    Except ConsolidationErr (Sum (List SemanticDiagnostic) ExactRational) :=
  let targeted := mapGet resolvedTargets (coordinate sourceBookId balance.sourceAccountId)
  if targeted != some rule.targetAccountId then .ok (.inl [ruleTargetMismatchDiagnostic])
  else
    let valuation := rule.valuationPolicy
    if ruleValuationInvalid governedAt globalValuation valuation then
      .ok (.inl [ruleValuationPolicyDiagnostic])
    else
      match collectCandidates governedAt throughOn valuation.maximumHops
          valuation.allowInverseObservation balance.unitsCommodityId commodityId
          balance.valuationPaths with
      | .error e => .error e
      | .ok candidates =>
        .ok (selectRate
          (globalValuation.preferDirectObservation || valuation.preferDirectObservation)
          candidates)

/-- `resolveRate` (`accounting.ts` lines 2069 to 2110). -/
def resolveRate (rules : List ConsolidationTranslationRule)
    (globalValuation : ConsolidationValuationPolicy) (governedAt : Instant)
    (throughOn : LocalDate) (commodityId : CommodityId)
    (resolvedTargets : List (String × AccountId)) (sourceBookId : BookId)
    (balance : ConsolidationSourceBalance) :
    Except ConsolidationErr (Sum (List SemanticDiagnostic) ExactRational) :=
  if balance.unitsCommodityId == commodityId then
    if !balance.valuationPaths.isEmpty then .ok (.inl [sameCommodityPathDiagnostic])
    else .ok (.inr rationalOne)
  else
    match rules.filter (ruleApplies sourceBookId balance.sourceAccountId governedAt) with
    | [rule] =>
      resolveRateByRule globalValuation governedAt throughOn commodityId resolvedTargets
        sourceBookId balance rule
    | _ => .ok (.inl [missingTranslationRuleDiagnostic])

/-- One iteration of the loop of `accounting.ts` lines 2118 to 2125: a coordinate already resolved is
the diagnostic of line 2121 (checked before the rate is resolved); otherwise the balance's rate is
resolved (which may throw) and recorded under its coordinate. -/
def rateStep (rules : List ConsolidationTranslationRule)
    (globalValuation : ConsolidationValuationPolicy) (governedAt : Instant)
    (throughOn : LocalDate) (commodityId : CommodityId)
    (resolvedTargets : List (String × AccountId)) (entries : List (String × ExactRational))
    (pair : BookId × ConsolidationSourceBalance) :
    Except ConsolidationErr (Sum (List SemanticDiagnostic) (List (String × ExactRational))) :=
  let rateKey := coordinate pair.1 pair.2.sourceAccountId
  if mapHas entries rateKey then .ok (.inl [duplicateSourceAccountDiagnostic])
  else
    match resolveRate rules globalValuation governedAt throughOn commodityId resolvedTargets
        pair.1 pair.2 with
    | .error e => .error e
    | .ok (.inl diags) => .ok (.inl diags)
    | .ok (.inr rate) => .ok (.inr (mapSet entries rateKey rate))

/-- The loop of `accounting.ts` lines 2118 to 2125 over `balancePairs`: the first balance whose
iteration (`rateStep`) rejects ends the loop with its diagnostics, and one that throws ends it with
the error. -/
def resolveRatesLoop (rules : List ConsolidationTranslationRule)
    (globalValuation : ConsolidationValuationPolicy) (governedAt : Instant)
    (throughOn : LocalDate) (commodityId : CommodityId)
    (resolvedTargets : List (String × AccountId)) :
    List (String × ExactRational) → List (BookId × ConsolidationSourceBalance) →
      Except ConsolidationErr (Sum (List SemanticDiagnostic) (List (String × ExactRational)))
  | entries, [] => .ok (.inr entries)
  | entries, pair :: rest =>
    match rateStep rules globalValuation governedAt throughOn commodityId resolvedTargets
        entries pair with
    | .error e => .error e
    | .ok (.inl diags) => .ok (.inl diags)
    | .ok (.inr nextEntries) =>
      resolveRatesLoop rules globalValuation governedAt throughOn commodityId resolvedTargets
        nextEntries rest

/-! ## Draft compilation (`accounting.ts` lines 2126 to 2163) -/

/-- Sort `request.sources` by `bookId` (`accounting.ts` line 2127). -/
def sortSources (sources : List ConsolidationSource) : List ConsolidationSource :=
  sources.mergeSort fun left right => jsStringLe left.bookId.value right.bookId.value

/-- Sort `source.balances` (`accounting.ts` line 2132). -/
def sortBalances (balances : List ConsolidationSourceBalance) :
    List ConsolidationSourceBalance :=
  balances.mergeSort fun left right =>
    tupleOrder
      [left.sourceAccountId.value, left.unitsCommodityId.value, left.classification.text]
      [right.sourceAccountId.value, right.unitsCommodityId.value, right.classification.text] != .gt

/-- Sort `request.eliminations` (`accounting.ts` line 2155). -/
def sortEliminations (eliminations : List ConsolidationElimination) :
    List ConsolidationElimination :=
  eliminations.mergeSort fun left right =>
    tupleOrder
      [left.sourceBookId.value, left.sourceAccountId.value, rationalToString left.amount]
      [right.sourceBookId.value, right.sourceAccountId.value, rationalToString right.amount] != .gt

/-- The rate recorded for a balance (`resolvedRates.get(coordinate(source.bookId, balance.sourceAccountId))!`,
`accounting.ts` line 2135); the default is never used for a request that passed the checks of lines
2118 to 2125. -/
def rateAt (resolvedRates : List (String × ExactRational)) (book : BookId)
    (balance : ConsolidationSourceBalance) : ExactRational :=
  (mapGet resolvedRates (coordinate book balance.sourceAccountId)).getD rationalOne

/-- The account recorded for a balance (`resolvedTargets.get(coordinate(source.bookId,
balance.sourceAccountId))!`, `accounting.ts` line 2138); the default is never used for a request that
passed the checks of lines 2111 to 2117. -/
def targetAt (resolvedTargets : List (String × AccountId)) (book : BookId)
    (balance : ConsolidationSourceBalance) : AccountId :=
  (mapGet resolvedTargets (coordinate book balance.sourceAccountId)).getD balance.sourceAccountId

/-- `identifier<"Posting">(`${request.id}-${tag}-${ordinal}`)`: the posting identifier the compilation
derives from its own identifier (`accounting.ts` lines 2138, 2145, 2147, 2152 and 2157); it throws
when the text is not a valid identifier. -/
def derivedPostingId (requestId : ConsolidationCompilationId) (tag : String) (ordinal : Nat) :
    Except ConsolidationErr PostingId :=
  liftCanonical (postingId (requestId.value ++ ("-" ++ tag ++ "-" ++ toString ordinal)))

/-- Compile the ordered balances of one source (`accounting.ts` lines 2133 to 2139), tracking the
posting ordinal and accumulated `translatedNetAssets`. -/
def compileSourceBalances (requestId : ConsolidationCompilationId) (commodityId : CommodityId)
    (resolvedTargets : List (String × AccountId)) (resolvedRates : List (String × ExactRational))
    (sourceBookId : BookId) (factor : ExactRational) :
    Nat → ExactRational → List ConsolidationSourceBalance →
      Except ConsolidationErr (Nat × ExactRational × List ExactPreparedPosting)
  | ordinal, netAssets, [] => .ok (ordinal, netAssets, [])
  | ordinal, netAssets, balance :: rest =>
    let nextOrdinal := ordinal + 1
    let rate := rateAt resolvedRates sourceBookId balance
    let targetAccount := targetAt resolvedTargets sourceBookId balance
    match liftNum (balance.amount.multiply rate) with
    | .error e => .error e
    | .ok translatedAmount =>
      match liftNum (translatedAmount.multiply factor) with
      | .error e => .error e
      | .ok amount =>
        let nextNetAssetsRes : Except ConsolidationErr ExactRational :=
          if balance.classification != .equity then liftNum (netAssets.add translatedAmount)
          else .ok netAssets
        match nextNetAssetsRes with
        | .error e => .error e
        | .ok nextNetAssets =>
          match derivedPostingId requestId "source" nextOrdinal with
          | .error e => .error e
          | .ok pid =>
            let posting : ExactPreparedPosting :=
              { id := pid, accountId := targetAccount, units := amount,
                unitsCommodityId := commodityId, exactBookValue := amount, costBasis := none }
            match compileSourceBalances requestId commodityId resolvedTargets resolvedRates
                sourceBookId factor nextOrdinal nextNetAssets rest with
            | .error e => .error e
            | .ok (endOrdinal, endNetAssets, tail) =>
              .ok (endOrdinal, endNetAssets, posting :: tail)

/-- Compute non-controlling interest postings for a partially owned full-consolidation source
(`accounting.ts` lines 2140 to 2148). -/
def compileNciPostings (requestId : ConsolidationCompilationId) (commodityId : CommodityId)
    (policy : ConsolidationPolicy) (source : ConsolidationSource) (ordinal : Nat)
    (translatedNetAssets : ExactRational) :
    Except ConsolidationErr (Nat × List ExactPreparedPosting) :=
  if source.method == .full && source.ownershipShare.compare rationalOne == .lt then
    let nciRes : Except ConsolidationErr ExactRational :=
      if source.nonControllingInterestMethod == some .fairValue then
        .ok (source.nonControllingInterestFairValue.getD ExactRational.zero)
      else
        match liftNum (rationalOne.subtract source.ownershipShare) with
        | .error e => .error e
        | .ok minorityShare => liftNum (translatedNetAssets.multiply minorityShare) |>.map (·.negate)
    match nciRes with
    | .error e => .error e
    | .ok nci =>
      let ordParent := ordinal + 1
      match derivedPostingId requestId "parent-equity" ordParent with
      | .error e => .error e
      | .ok pidParent =>
        let ordNci := ordParent + 1
        match derivedPostingId requestId "nci" ordNci with
        | .error e => .error e
        | .ok pidNci =>
          .ok (ordNci,
            [ { id := pidParent, accountId := policy.parentAttributableEquityAccountId,
                units := nci.negate, unitsCommodityId := commodityId,
                exactBookValue := nci.negate, costBasis := none },
              { id := pidNci, accountId := policy.nonControllingInterestAccountId,
                units := nci, unitsCommodityId := commodityId,
                exactBookValue := nci, costBasis := none } ])
  else .ok (ordinal, [])

/-- The factor of a source (`accounting.ts` line 2129): one for full consolidation, otherwise the
ownership share. -/
def sourceFactor (source : ConsolidationSource) : ExactRational :=
  if source.method == .full then rationalOne else source.ownershipShare

/-- Compile one ordered source into its postings and updated ordinal (`accounting.ts` lines 2128 to
2154). -/
def compileSource (requestId : ConsolidationCompilationId) (commodityId : CommodityId)
    (policy : ConsolidationPolicy) (resolvedTargets : List (String × AccountId))
    (resolvedRates : List (String × ExactRational)) (ordinal : Nat)
    (source : ConsolidationSource) :
    Except ConsolidationErr (Nat × List ExactPreparedPosting) :=
  let orderedBalances := sortBalances source.balances
  match compileSourceBalances requestId commodityId resolvedTargets resolvedRates source.bookId
      (sourceFactor source) ordinal ExactRational.zero orderedBalances with
  | .error e => .error e
  | .ok (ordAfterBalances, translatedNetAssets, balancePostings) =>
    match compileNciPostings requestId commodityId policy source ordAfterBalances
        translatedNetAssets with
    | .error e => .error e
    | .ok (ordAfterNci, nciPostings) =>
      let sourcePrePostings := balancePostings ++ nciPostings
      match liftNum (accountingSum (sourcePrePostings.map (·.exactBookValue))) with
      | .error e => .error e
      | .ok sourceTranslatedTotal =>
        if !sourceTranslatedTotal.isZero then
          let ordTrans := ordAfterNci + 1
          match derivedPostingId requestId "translation" ordTrans with
          | .error e => .error e
          | .ok pidTrans =>
            .ok (ordTrans,
              sourcePrePostings ++
                [ { id := pidTrans, accountId := policy.translationAdjustmentAccountId,
                    units := sourceTranslatedTotal.negate, unitsCommodityId := commodityId,
                    exactBookValue := sourceTranslatedTotal.negate, costBasis := none } ])
        else
          .ok (ordAfterNci, sourcePrePostings)

/-- Compile all ordered sources (`accounting.ts` lines 2128 to 2154). -/
def compileSourcesLoop (requestId : ConsolidationCompilationId) (commodityId : CommodityId)
    (policy : ConsolidationPolicy) (resolvedTargets : List (String × AccountId))
    (resolvedRates : List (String × ExactRational)) :
    Nat → List ConsolidationSource → Except ConsolidationErr (Nat × List ExactPreparedPosting)
  | ordinal, [] => .ok (ordinal, [])
  | ordinal, source :: rest =>
    match compileSource requestId commodityId policy resolvedTargets resolvedRates ordinal source with
    | .error e => .error e
    | .ok (nextOrdinal, headPostings) =>
      match compileSourcesLoop requestId commodityId policy resolvedTargets resolvedRates
          nextOrdinal rest with
      | .error e => .error e
      | .ok (endOrdinal, tailPostings) => .ok (endOrdinal, headPostings ++ tailPostings)

/-- Compile ordered eliminations (`accounting.ts` lines 2155 to 2158). -/
def compileEliminationsLoop (requestId : ConsolidationCompilationId) (commodityId : CommodityId) :
    Nat → List ConsolidationElimination → Except ConsolidationErr (List ExactPreparedPosting)
  | _, [] => .ok []
  | ordinal, elimination :: rest =>
    let nextOrdinal := ordinal + 1
    match derivedPostingId requestId "elimination" nextOrdinal with
    | .error e => .error e
    | .ok pid =>
      let posting : ExactPreparedPosting :=
        { id := pid, accountId := elimination.targetAccountId, units := elimination.amount,
          unitsCommodityId := commodityId, exactBookValue := elimination.amount, costBasis := none }
      match compileEliminationsLoop requestId commodityId nextOrdinal rest with
      | .error e => .error e
      | .ok tail => .ok (posting :: tail)

/-- The `body` of `accounting.ts` line 2160, which the effect's content hash covers: the request's
identifier, target book, policy, date, the population hashes of the sources in the order they are
compiled, and the derivation. Its `contentHash` is a placeholder that `bodyValue` leaves out. -/
def compilationBody (request : ConsolidationRequest) (policy : ConsolidationPolicy) :
    ConsolidationCompilation :=
  { id := request.id, bookId := request.targetBookId, policyId := policy.id,
    throughOn := request.throughOn,
    sourcePopulationHashes := (sortSources request.sources).map (·.populationHash),
    derivation := request.derivation, contentHash := default }

/-- The `effect` of `accounting.ts` line 2160: the body with its `contentHash`, which is
`accountingHash("ConsolidationCompilation", body)`. -/
def compilationEffect (request : ConsolidationRequest) (policy : ConsolidationPolicy) :
    ConsolidationCompilation :=
  { compilationBody request policy with
    contentHash := accountingBodyHash "ConsolidationCompilation" (compilationBody request policy) }

/-- The `journal` of `accounting.ts` line 2161 for the compiled postings and its identifier. -/
def compilationJournal (request : ConsolidationRequest) (journalId : JournalId)
    (postings : List ExactPreparedPosting) : ExactPreparedJournal :=
  { requiredQuantizationPolicy := none, id := journalId, kind := .adjustment,
    economicAt := request.governedAt, accountingDate := request.throughOn,
    recordedAt := request.governedAt, narration := "Consolidation compilation",
    postings, derivations := [request.derivation] }

/-- Final compilation and draft construction (`accounting.ts` lines 2126 to 2163): the sources in
the order of their books, then the eliminations in their order; the draft must balance (line 2159);
then the effect with its hash, and the journal, whose identifier may throw. -/
def compileDraft (commodityId : CommodityId) (request : ConsolidationRequest)
    (policy : ConsolidationPolicy) (resolvedTargets : List (String × AccountId))
    (resolvedRates : List (String × ExactRational)) :
    Except ConsolidationErr AccountingCalculation :=
  match compileSourcesLoop request.id commodityId policy resolvedTargets resolvedRates 0
      (sortSources request.sources) with
  | .error e => .error e
  | .ok (ordAfterSources, sourcePostings) =>
    match compileEliminationsLoop request.id commodityId ordAfterSources
        (sortEliminations request.eliminations) with
    | .error e => .error e
    | .ok elimPostings =>
      match liftNum (accountingSum ((sourcePostings ++ elimPostings).map (·.exactBookValue))) with
      | .error e => .error e
      | .ok total =>
        if !total.isZero then .ok unbalancedDraftRejection
        else
          match liftCanonical (journalId (request.id.value ++ "-journal")) with
          | .error e => .error e
          | .ok jid =>
            .ok (drafted [compilationJournal request jid (sourcePostings ++ elimPostings)]
              [.consolidationCompilation (compilationEffect request policy)])

end Consolidation

/-- `compileConsolidation` (`accounting.ts` line 2030). -/
def compileConsolidation (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) : Except ConsolidationErr AccountingCalculation :=
  let selected :=
    policyAt ConsolidationPolicy policies request.policyId request.policyVersion request.governedAt
  if Consolidation.boundsInvalid request then .ok Consolidation.boundsRejection
  else if Consolidation.derivationInvalid request then .ok Consolidation.derivationRejection
  else
    match Consolidation.validateSources selected request with
    | .error e => .error e
    | .ok none => .ok Consolidation.sourcesRejection
    | .ok (some policy) =>
      match Consolidation.eliminationsInvalid request with
      | .error e => .error e
      | .ok true => .ok Consolidation.eliminationsRejection
      | .ok false =>
        if Consolidation.globalValuationInvalid request.governedAt policy.valuationPolicy then
          .ok Consolidation.valuationPolicyRejection
        else
          match Consolidation.resolveTargetsLoop (Consolidation.sortMappings policy.accountMappings)
              request.governedAt [] (Consolidation.balancePairs request.sources) with
          | .inl diags => .ok (.rejected diags)
          | .inr resolvedTargets =>
            match Consolidation.resolveRatesLoop (Consolidation.sortRules policy.translationRules)
                policy.valuationPolicy request.governedAt request.throughOn commodityId
                resolvedTargets [] (Consolidation.balancePairs request.sources) with
            | .error e => .error e
            | .ok (.inl diags) => .ok (.rejected diags)
            | .ok (.inr resolvedRates) =>
              Consolidation.compileDraft commodityId request policy resolvedTargets resolvedRates

/-! ## Meaning and laws: helper lemmas -/

namespace Consolidation

/-- The number one is constructible. -/
theorem rationalOne_wf : rationalOne.WF :=
  ⟨by decide, by decide, withinMagnitude_one, withinMagnitude_one⟩

/-- The number one means one. -/
theorem rationalOne_toRat : rationalOne.toRat = 1 := by
  simp [rationalOne, ExactRational.toRat]

/-- A lifted result returns a value exactly when the exact-number operation did. -/
theorem liftNum_ok_iff {α : Type} {x : Except NumErr α} {v : α} :
    liftNum x = .ok v ↔ x = .ok v := by
  cases x <;> simp [liftNum]

/-- A lifted result throws exactly when the exact-number operation threw, with its code. -/
theorem liftNum_error_iff {α : Type} {x : Except NumErr α} {e : ConsolidationErr} :
    liftNum x = .error e ↔ ∃ code, x = .error code ∧ e = .exactNumber code := by
  cases x <;> simp [liftNum, eq_comm]

/-- A lifted result returns a value exactly when the identifier operation did. -/
theorem liftCanonical_ok_iff {α : Type} {x : Except CanonicalErr α} {v : α} :
    liftCanonical x = .ok v ↔ x = .ok v := by
  cases x <;> simp [liftCanonical]

/-- A lifted result throws exactly when the identifier operation threw, with its code. -/
theorem liftCanonical_error_iff {α : Type} {x : Except CanonicalErr α} {e : ConsolidationErr} :
    liftCanonical x = .error e ↔ ∃ code, x = .error code ∧ e = .canonical code := by
  cases x <;> simp [liftCanonical, eq_comm]

/-- A value equals itself. -/
theorem ExactRational_equals_refl (r : ExactRational) : r.equals r = true := by
  simp [ExactRational.equals]

/-- Adding up constructible values returns their total, which is constructible. -/
theorem accountingSum_ok {values : List ExactRational} {total : ExactRational} :
    (∀ v ∈ values, v.WF) → accountingSum values = .ok total →
      total.WF ∧ total.toRat = (values.map (·.toRat)).sum := by
  intro hw h
  obtain ⟨hwf, hrat⟩ := addExactValues_ok ExactRational.zero_wf hw h
  refine ⟨hwf, ?_⟩
  rw [hrat, ExactRational.zero_toRat, zero_add]
  rfl

/-- Adding up constructible values throws only for the size limit. -/
theorem accountingSum_error {values : List ExactRational} {code : NumErr} :
    (∀ v ∈ values, v.WF) → accountingSum values = .error code →
      code = .representationLimitExceeded :=
  addExactValues_error ExactRational.zero_wf

/-- Parse one lowercase hex digit. -/
private def unhexDigit (c : Char) : Option Nat :=
  if 48 ≤ c.toNat ∧ c.toNat ≤ 57 then some (c.toNat - 48)
  else if 97 ≤ c.toNat ∧ c.toNat ≤ 102 then some (c.toNat - 87)
  else none

/-- Reading back a written hex digit gives its value. -/
private theorem unhexDigit_lowerHexDigit {n : Nat} (hn : n < 16) :
    unhexDigit (lowerHexDigit n) = some n := by
  have h : ∀ k : Fin 16, unhexDigit (lowerHexDigit k.1) = some k.1 := by decide
  exact h ⟨n, hn⟩

/-- A character built from its own code is itself. -/
private theorem char_ofNat_eq_of_toNat {c : Char} {n : Nat} (hn : c.toNat = n) :
    Char.ofNat n = c := by
  rw [← hn, Char.ofNat_toNat]

/-- Decode the body of a JSON string up to its closing `"`. -/
private def jsonUnescapeBody : List Char → Option (List Char × List Char)
  | [] => none
  | '"' :: rest => some ([], rest)
  | '\\' :: '"' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => ('"' :: tail, after)
  | '\\' :: '\\' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => ('\\' :: tail, after)
  | '\\' :: 'b' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => (Char.ofNat 0x08 :: tail, after)
  | '\\' :: 't' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => (Char.ofNat 0x09 :: tail, after)
  | '\\' :: 'n' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => (Char.ofNat 0x0a :: tail, after)
  | '\\' :: 'f' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => (Char.ofNat 0x0c :: tail, after)
  | '\\' :: 'r' :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => (Char.ofNat 0x0d :: tail, after)
  | '\\' :: 'u' :: '0' :: '0' :: h1 :: h2 :: rest =>
    match unhexDigit h1, unhexDigit h2 with
    | some d1, some d2 =>
      (jsonUnescapeBody rest).map fun (tail, after) => (Char.ofNat (d1 * 16 + d2) :: tail, after)
    | _, _ => none
  | '\\' :: _ => none
  | c :: rest =>
    (jsonUnescapeBody rest).map fun (tail, after) => (c :: tail, after)

/-- Decoding one escaped character, followed by more text, gives the character and decodes the rest. -/
private theorem jsonUnescapeBody_step (c : Char) (rest : List Char) :
    jsonUnescapeBody (jsonEscapeChar c ++ rest) =
      (jsonUnescapeBody rest).map fun (tail, after) => (c :: tail, after) := by
  unfold jsonEscapeChar
  dsimp only
  split_ifs with h1 h2 h3 h4 h5 h6 h7 h8
  · have : c = '"' := beq_iff_eq.mp h1; subst this; rfl
  · have : c = '\\' := beq_iff_eq.mp h2; subst this; rfl
  · have hn : c.toNat = 0x08 := beq_iff_eq.mp h3
    simp only [List.cons_append, List.nil_append, jsonUnescapeBody]
    rw [char_ofNat_eq_of_toNat hn]
  · have hn : c.toNat = 0x09 := beq_iff_eq.mp h4
    simp only [List.cons_append, List.nil_append, jsonUnescapeBody]
    rw [char_ofNat_eq_of_toNat hn]
  · have hn : c.toNat = 0x0a := beq_iff_eq.mp h5
    simp only [List.cons_append, List.nil_append, jsonUnescapeBody]
    rw [char_ofNat_eq_of_toNat hn]
  · have hn : c.toNat = 0x0c := beq_iff_eq.mp h6
    simp only [List.cons_append, List.nil_append, jsonUnescapeBody]
    rw [char_ofNat_eq_of_toNat hn]
  · have hn : c.toNat = 0x0d := beq_iff_eq.mp h7
    simp only [List.cons_append, List.nil_append, jsonUnescapeBody]
    rw [char_ofNat_eq_of_toNat hn]
  · have hn1 : c.toNat / 16 < 16 := by omega
    have hn2 : c.toNat % 16 < 16 := by omega
    simp only [List.cons_append, List.nil_append, jsonUnescapeBody]
    rw [unhexDigit_lowerHexDigit hn1, unhexDigit_lowerHexDigit hn2]
    dsimp only
    have hc : c.toNat = c.toNat / 16 * 16 + c.toNat % 16 := by omega
    rw [char_ofNat_eq_of_toNat hc]
  · have hq : c ≠ '"' := fun heq => by simp [heq] at h1
    have hb : c ≠ '\\' := fun heq => by simp [heq] at h2
    simp only [List.cons_append, List.nil_append]
    conv_lhs => unfold jsonUnescapeBody
    split <;> simp_all

/-- Decoding an escaped text up to its closing quote gives the text and what follows. -/
private theorem jsonUnescapeBody_quote (cs tail : List Char) :
    jsonUnescapeBody (cs.flatMap jsonEscapeChar ++ '"' :: tail) = some (cs, tail) := by
  induction cs with
  | nil => simp [jsonUnescapeBody]
  | cons c rest ih =>
    simp only [List.flatMap_cons, List.append_assoc, jsonUnescapeBody_step, ih, Option.map_some]

/-- Decode a JSON-encoded list of strings (`[s1, s2, ...]`). -/
private def jsonDecodeTail : Nat → List Char → Option (List String)
  | 0, _ => none
  | _ + 1, [']'] => some []
  | fuel + 1, '"' :: rest =>
    match jsonUnescapeBody rest with
    | some (cs, [']']) => some [String.ofList cs]
    | some (cs, ',' :: after) => (jsonDecodeTail fuel after).map (String.ofList cs :: ·)
    | _ => none
  | _ + 1, _ => none

/-- Decoding a written list of strings gives the list. -/
private theorem jsonDecodeTail_intercalate (values : List String) (hne : values ≠ []) :
    ∀ fuel, values.length ≤ fuel →
      jsonDecodeTail fuel (List.intercalate [','] (values.map jsonQuoteString) ++ [']']) =
        some values := by
  induction values with
  | nil => exact absurd rfl hne
  | cons s rest ih =>
    intro fuel hfuel
    cases fuel with
    | zero => simp at hfuel
    | succ f =>
      cases rest with
      | nil =>
        simp [List.intercalate_singleton, jsonQuoteString,
          jsonDecodeTail, jsonUnescapeBody_quote, String.ofList_toList]
      | cons s2 rest2 =>
        have hne' : s2 :: rest2 ≠ [] := List.cons_ne_nil s2 rest2
        have hih := ih hne' f (by simp at hfuel; omega)
        simp only [List.map_cons, List.intercalate_cons_cons, List.append_assoc, jsonQuoteString,
          List.cons_append, jsonDecodeTail]
        rw [jsonUnescapeBody_quote]
        simp only [List.nil_append]
        simp only [List.map_cons, jsonQuoteString, List.cons_append] at hih
        rw [hih]
        simp [String.ofList_toList]

private def jsonDecodeStringList : List Char → Option (List String)
  | '[' :: rest => jsonDecodeTail (rest.length + 1) rest
  | _ => none

/-- A written list of strings is at least as long as the list. -/
private theorem length_intercalate_quote_ge (values : List String) :
    values.length ≤ (List.intercalate [','] (values.map jsonQuoteString) ++ [']']).length := by
  induction values with
  | nil => simp
  | cons s rest ih =>
    cases rest with
    | nil => simp [jsonQuoteString]
    | cons s2 rest2 =>
      simp only [List.map_cons, List.intercalate_cons_cons, List.length_append, List.length_cons,
        List.length_nil] at ih ⊢
      have hlen : 2 ≤ (jsonQuoteString s).length := by simp [jsonQuoteString]
      omega

/-- Decoding what `jsonStringifyStringList` wrote gives the list back. -/
private theorem jsonDecodeStringList_stringify (values : List String) :
    jsonDecodeStringList (jsonStringifyStringList values).toList = some values := by
  unfold jsonStringifyStringList
  rw [String.toList_ofList]
  cases values with
  | nil => rfl
  | cons s rest =>
    unfold jsonDecodeStringList
    exact jsonDecodeTail_intercalate (s :: rest) (List.cons_ne_nil s rest) _
      (Nat.le_trans (length_intercalate_quote_ge (s :: rest)) (Nat.le_succ _))

/-- Two lists of strings that are written the same are the same list. -/
theorem jsonStringifyStringList_injective {xs ys : List String}
    (h : jsonStringifyStringList xs = jsonStringifyStringList ys) : xs = ys := by
  have h1 := congrArg (fun s => jsonDecodeStringList s.toList) h
  rw [jsonDecodeStringList_stringify, jsonDecodeStringList_stringify] at h1
  exact Option.some.inj h1

/-- Two coordinates are equal only for the same book and the same account. -/
theorem coordinate_injective {b1 b2 : BookId} {a1 a2 : AccountId}
    (h : coordinate b1 a1 = coordinate b2 a2) : b1 = b2 ∧ a1 = a2 := by
  have hlist := jsonStringifyStringList_injective h
  simp only [List.cons.injEq, and_true] at hlist
  exact ⟨Identifier.eq_of_value_eq hlist.1, Identifier.eq_of_value_eq hlist.2⟩

/-! ## Ordering and sort invariance lemmas -/

theorem tupleOrder_eq_iff (a b : List String) : tupleOrder a b = .eq ↔ a = b := by
  unfold tupleOrder
  cases h1 : compareCanonicalText (String.intercalate ":" a) (String.intercalate ":" b) with
  | lt =>
    simp only [reduceCtorEq, false_iff]
    intro heq; subst heq
    have := (compareCanonicalText_eq_iff (String.intercalate ":" a) (String.intercalate ":" a)).mpr rfl
    rw [this] at h1; cases h1
  | gt =>
    simp only [reduceCtorEq, false_iff]
    intro heq; subst heq
    have := (compareCanonicalText_eq_iff (String.intercalate ":" a) (String.intercalate ":" a)).mpr rfl
    rw [this] at h1; cases h1
  | eq =>
    simp only [compareCanonicalText_eq_iff]
    exact ⟨fun h2 => jsonStringifyStringList_injective h2, fun h2 => h2 ▸ rfl⟩

/-- `tupleOrder` is below in one direction exactly when it is above in the other. -/
theorem tupleOrder_antisymm (a b : List String) :
    tupleOrder a b = .lt ↔ tupleOrder b a = .gt := by
  unfold tupleOrder
  cases h1 : compareCanonicalText (String.intercalate ":" a) (String.intercalate ":" b) with
  | lt =>
    have h1' := (compareCanonicalText_antisymm _ _).mp h1
    simp [h1']
  | gt =>
    have h1' := (compareCanonicalText_antisymm _ _).mpr h1
    simp [h1']
  | eq =>
    have h1eq := (compareCanonicalText_eq_iff _ _).mp h1
    have h1' : compareCanonicalText (String.intercalate ":" b) (String.intercalate ":" a) = .eq :=
      (compareCanonicalText_eq_iff _ _).mpr h1eq.symm
    simp only [h1']
    exact compareCanonicalText_antisymm _ _

/-- `tupleOrder` is transitive. -/
theorem tupleOrder_trans {a b c : List String}
    (hab : tupleOrder a b = .lt) (hbc : tupleOrder b c = .lt) :
    tupleOrder a c = .lt := by
  unfold tupleOrder at hab hbc ⊢
  cases h1 : compareCanonicalText (String.intercalate ":" a) (String.intercalate ":" b) <;>
    cases h2 : compareCanonicalText (String.intercalate ":" b) (String.intercalate ":" c)
  · simp [compareCanonicalText_trans _ _ _ h1 h2]
  · rw [(compareCanonicalText_eq_iff _ _).mp h2] at h1; simp [h1]
  · simp [h2] at hbc
  · rw [← (compareCanonicalText_eq_iff _ _).mp h1] at h2; simp [h2]
  · have h1eq := (compareCanonicalText_eq_iff _ _).mp h1
    have h2eq := (compareCanonicalText_eq_iff _ _).mp h2
    have h13 : compareCanonicalText (String.intercalate ":" a) (String.intercalate ":" c) = .eq :=
      (compareCanonicalText_eq_iff _ _).mpr (h1eq.trans h2eq)
    simp only [h1, h2] at hab hbc
    simp [h13, compareCanonicalText_trans _ _ _ hab hbc]
  · simp [h2] at hbc
  · simp [h1] at hab
  · simp [h1] at hab
  · simp [h1] at hab

/-- Of two tuples one is not after the other. -/
theorem tupleOrderLe_total (a b : List String) :
    ((tupleOrder a b != .gt) || (tupleOrder b a != .gt)) = true := by
  cases h : tupleOrder a b with
  | lt => simp
  | eq => simp
  | gt =>
    have := (tupleOrder_antisymm b a).mpr h
    simp [this]

/-- "Not after" on tuples is transitive. -/
theorem tupleOrderLe_trans {a b c : List String}
    (hab : (tupleOrder a b != .gt) = true) (hbc : (tupleOrder b c != .gt) = true) :
    (tupleOrder a c != .gt) = true := by
  cases h1 : tupleOrder a b with
  | gt => simp [h1] at hab
  | eq =>
    rw [(tupleOrder_eq_iff a b).mp h1]
    exact hbc
  | lt =>
    cases h2 : tupleOrder b c with
    | gt => simp [h2] at hbc
    | eq =>
      rw [← (tupleOrder_eq_iff b c).mp h2, h1]
      rfl
    | lt =>
      rw [tupleOrder_trans h1 h2]
      rfl

/-- Two tuples that are each not after the other are equal. -/
theorem tupleOrderLe_antisymm {a b : List String}
    (hab : (tupleOrder a b != .gt) = true) (hba : (tupleOrder b a != .gt) = true) :
    a = b := by
  cases h1 : tupleOrder a b with
  | gt => simp [h1] at hab
  | eq => exact (tupleOrder_eq_iff a b).mp h1
  | lt =>
    have := (tupleOrder_antisymm a b).mp h1
    simp [this] at hba

/-- Of two strings one is not after the other. -/
theorem jsStringLe_total (a b : String) : (jsStringLe a b || jsStringLe b a) = true := by
  unfold jsStringLe
  cases h : compareCanonicalText a b with
  | lt => simp
  | eq => simp
  | gt =>
    have := (compareCanonicalText_antisymm b a).mpr h
    simp [this]

/-- "Not after" on strings is transitive. -/
theorem jsStringLe_trans {a b c : String} (hab : jsStringLe a b = true)
    (hbc : jsStringLe b c = true) : jsStringLe a c = true := by
  unfold jsStringLe at *
  cases h1 : compareCanonicalText a b with
  | gt => simp [h1] at hab
  | eq => rw [(compareCanonicalText_eq_iff a b).mp h1]; exact hbc
  | lt =>
    cases h2 : compareCanonicalText b c with
    | gt => simp [h2] at hbc
    | eq => rw [← (compareCanonicalText_eq_iff b c).mp h2, h1]; rfl
    | lt => rw [compareCanonicalText_trans a b c h1 h2]; rfl

/-- Two strings that are each not after the other are equal. -/
theorem jsStringLe_antisymm {a b : String} (hab : jsStringLe a b = true)
    (hba : jsStringLe b a = true) : a = b := by
  unfold jsStringLe at *
  cases h1 : compareCanonicalText a b with
  | gt => simp [h1] at hab
  | eq => exact (compareCanonicalText_eq_iff a b).mp h1
  | lt =>
    have := (compareCanonicalText_antisymm a b).mp h1
    simp [this] at hba

/-- Sorting the sources keeps the same sources. -/
theorem sortSources_perm (sources : List ConsolidationSource) :
    (sortSources sources).Perm sources :=
  List.mergeSort_perm sources _

/-- A function that is distinct on a list without repeats separates its members. -/
theorem nodup_map_inj {α β : Type} {f : α → β} :
    ∀ {xs : List α}, (xs.map f).Nodup → ∀ a ∈ xs, ∀ b ∈ xs, f a = f b → a = b
  | [], _, _, ha, _, _, _ => by cases ha
  | x :: xs, hnd, a, ha, b, hb, heq => by
    simp only [List.map_cons, List.nodup_cons, List.mem_map] at hnd
    rcases List.mem_cons.mp ha with rfl | ha' <;> rcases List.mem_cons.mp hb with rfl | hb'
    · rfl
    · exact absurd ⟨b, hb', heq.symm⟩ hnd.1
    · exact absurd ⟨a, ha', heq⟩ hnd.1
    · exact nodup_map_inj hnd.2 a ha' b hb' heq

/-- Sources with distinct books are sorted the same whatever their order. -/
theorem sortSources_eq_of_perm {xs ys : List ConsolidationSource} (hp : xs.Perm ys)
    (hnodup : (xs.map (·.bookId)).Nodup) : sortSources xs = sortSources ys := by
  have htrans : ∀ a b c : ConsolidationSource, jsStringLe a.bookId.value b.bookId.value = true →
      jsStringLe b.bookId.value c.bookId.value = true →
      jsStringLe a.bookId.value c.bookId.value = true :=
    fun _ _ _ => jsStringLe_trans
  have htotal : ∀ a b : ConsolidationSource,
      (jsStringLe a.bookId.value b.bookId.value ||
        jsStringLe b.bookId.value a.bookId.value) = true :=
    fun a b => jsStringLe_total a.bookId.value b.bookId.value
  refine List.Perm.eq_of_pairwise ?_ (List.pairwise_mergeSort htrans htotal xs)
    (List.pairwise_mergeSort htrans htotal ys)
    ((sortSources_perm xs).trans (hp.trans (sortSources_perm ys).symm))
  intro a b ha _ hab hba
  have ha' : a ∈ xs := (sortSources_perm xs).subset ha
  have hb' : b ∈ ys := (sortSources_perm ys).subset (by assumption)
  have hb'' : b ∈ xs := hp.symm.subset hb'
  have heq : a.bookId = b.bookId := Identifier.eq_of_value_eq (jsStringLe_antisymm hab hba)
  exact nodup_map_inj hnodup a ha' b hb'' heq

/-- Sorting the balances keeps the same balances. -/
theorem sortBalances_perm (balances : List ConsolidationSourceBalance) :
    (sortBalances balances).Perm balances :=
  List.mergeSort_perm balances _

/-- Balances with distinct accounts are sorted the same whatever their order. -/
theorem sortBalances_eq_of_perm {xs ys : List ConsolidationSourceBalance} (hp : xs.Perm ys)
    (hnodup : (xs.map (·.sourceAccountId)).Nodup) : sortBalances xs = sortBalances ys := by
  have htrans : ∀ a b c : ConsolidationSourceBalance,
      (tupleOrder [a.sourceAccountId.value, a.unitsCommodityId.value, a.classification.text]
        [b.sourceAccountId.value, b.unitsCommodityId.value, b.classification.text] != .gt) = true →
      (tupleOrder [b.sourceAccountId.value, b.unitsCommodityId.value, b.classification.text]
        [c.sourceAccountId.value, c.unitsCommodityId.value, c.classification.text] != .gt) = true →
      (tupleOrder [a.sourceAccountId.value, a.unitsCommodityId.value, a.classification.text]
        [c.sourceAccountId.value, c.unitsCommodityId.value, c.classification.text] != .gt) = true :=
    fun _ _ _ => tupleOrderLe_trans
  have htotal : ∀ a b : ConsolidationSourceBalance,
      ((tupleOrder [a.sourceAccountId.value, a.unitsCommodityId.value, a.classification.text]
          [b.sourceAccountId.value, b.unitsCommodityId.value, b.classification.text] != .gt) ||
        (tupleOrder [b.sourceAccountId.value, b.unitsCommodityId.value, b.classification.text]
          [a.sourceAccountId.value, a.unitsCommodityId.value, a.classification.text] != .gt)) = true :=
    fun _ _ => tupleOrderLe_total _ _
  refine List.Perm.eq_of_pairwise ?_ (List.pairwise_mergeSort htrans htotal xs)
    (List.pairwise_mergeSort htrans htotal ys)
    ((sortBalances_perm xs).trans (hp.trans (sortBalances_perm ys).symm))
  intro a b ha hb hab hba
  have ha' : a ∈ xs := (sortBalances_perm xs).subset ha
  have hb' : b ∈ ys := (sortBalances_perm ys).subset hb
  have hb'' : b ∈ xs := hp.symm.subset hb'
  have hlist := tupleOrderLe_antisymm hab hba
  simp only [List.cons.injEq] at hlist
  have heq : a.sourceAccountId = b.sourceAccountId := Identifier.eq_of_value_eq hlist.1
  exact nodup_map_inj hnodup a ha' b hb'' heq

/-- Sorting the eliminations keeps the same eliminations. -/
theorem sortEliminations_perm (eliminations : List ConsolidationElimination) :
    (sortEliminations eliminations).Perm eliminations :=
  List.mergeSort_perm eliminations _

/-- Sorting the mappings keeps the same mappings. -/
theorem sortMappings_perm (mappings : List ConsolidationAccountMapping) :
    (sortMappings mappings).Perm mappings :=
  List.mergeSort_perm mappings _

/-- Sorting the rules keeps the same rules. -/
theorem sortRules_perm (rules : List ConsolidationTranslationRule) :
    (sortRules rules).Perm rules :=
  List.mergeSort_perm rules _

/-- A filter of a list has exactly one member exactly when the filter of a reordering has the same one. -/
private theorem perm_filter_singleton_iff {α : Type} {xs ys : List α} (hp : xs.Perm ys)
    (p : α → Bool) (x : α) : xs.filter p = [x] ↔ ys.filter p = [x] := by
  have hpf : (xs.filter p).Perm (ys.filter p) := hp.filter p
  constructor
  · intro h
    rw [h] at hpf
    exact (List.perm_singleton.mp hpf.symm)
  · intro h
    rw [h] at hpf
    exact List.perm_singleton.mp hpf

/-- The account a balance resolves to does not depend on the order of the mappings. -/
theorem resolveTarget_sortMappings (mappings : List ConsolidationAccountMapping)
    (governedAt : Instant) (sourceBookId : BookId) (sourceAccountId : AccountId) :
    resolveTarget (sortMappings mappings) governedAt sourceBookId sourceAccountId =
      resolveTarget mappings governedAt sourceBookId sourceAccountId := by
  unfold resolveTarget
  have hp := (sortMappings_perm mappings).filter (mappingApplies sourceBookId sourceAccountId governedAt)
  cases hs : (sortMappings mappings).filter (mappingApplies sourceBookId sourceAccountId governedAt) with
  | nil =>
    have hnil : mappings.filter (mappingApplies sourceBookId sourceAccountId governedAt) = [] :=
      (List.Perm.nil_eq (by rw [hs] at hp; exact hp)).symm
    simp [hnil]
  | cons a rest =>
    cases rest with
    | nil =>
      rw [hs] at hp
      have hm : mappings.filter (mappingApplies sourceBookId sourceAccountId governedAt) = [a] :=
        List.perm_singleton.mp hp.symm
      simp [hm]
    | cons b more =>
      have hlen := hp.length_eq
      rw [hs] at hlen
      cases hm : mappings.filter (mappingApplies sourceBookId sourceAccountId governedAt) with
      | nil => simp [hm] at hlen
      | cons c cs =>
        cases cs with
        | nil => simp [hm] at hlen
        | cons d ds => rfl

/-- The rate a balance resolves to does not depend on the order of the rules. -/
theorem resolveRate_sortRules (rules : List ConsolidationTranslationRule)
    (globalValuation : ConsolidationValuationPolicy) (governedAt : Instant)
    (throughOn : LocalDate) (commodityId : CommodityId)
    (resolvedTargets : List (String × AccountId)) (sourceBookId : BookId)
    (balance : ConsolidationSourceBalance) :
    resolveRate (sortRules rules) globalValuation governedAt throughOn commodityId
        resolvedTargets sourceBookId balance =
      resolveRate rules globalValuation governedAt throughOn commodityId
        resolvedTargets sourceBookId balance := by
  unfold resolveRate
  by_cases hc : (balance.unitsCommodityId == commodityId) = true
  · simp [hc]
  · have hcf : (balance.unitsCommodityId == commodityId) = false := Bool.eq_false_iff.mpr hc
    simp only [hcf, Bool.false_eq_true, ↓reduceIte]
    have hp := (sortRules_perm rules).filter (ruleApplies sourceBookId balance.sourceAccountId governedAt)
    cases hs : (sortRules rules).filter (ruleApplies sourceBookId balance.sourceAccountId governedAt) with
    | nil =>
      have hnil : rules.filter (ruleApplies sourceBookId balance.sourceAccountId governedAt) = [] :=
        (List.Perm.nil_eq (by rw [hs] at hp; exact hp)).symm
      simp [hnil]
    | cons r rest =>
      cases rest with
      | nil =>
        rw [hs] at hp
        have hm : rules.filter (ruleApplies sourceBookId balance.sourceAccountId governedAt) = [r] :=
          List.perm_singleton.mp hp.symm
        simp [hm]
      | cons r2 more =>
        have hlen := hp.length_eq
        rw [hs] at hlen
        cases hm : rules.filter (ruleApplies sourceBookId balance.sourceAccountId governedAt) with
        | nil => simp [hm] at hlen
        | cons a as =>
          cases as with
          | nil => simp [hm] at hlen
          | cons b bs => rfl

/-- A value just set is the value read. -/
theorem mapGet_mapSet_self {α : Type} (entries : List (String × α)) (k : String) (v : α) :
    mapGet (mapSet entries k v) k = some v := by
  simp [mapGet, mapSet]

/-- Setting a key leaves the value of any other key as it was. -/
theorem mapGet_mapSet_ne {α : Type} (entries : List (String × α)) {k k' : String} (v : α)
    (hne : k ≠ k') : mapGet (mapSet entries k v) k' = mapGet entries k' := by
  have hb : (k == k') = false := beq_false_of_ne hne
  simp [mapGet, mapSet, hb]

/-- A key is present after a set exactly when it is the key set or was present. -/
theorem mapHas_mapSet {α : Type} (entries : List (String × α)) (k k' : String) (v : α) :
    mapHas (mapSet entries k v) k' = (k == k' || mapHas entries k') := by
  simp [mapHas, mapSet]

/-- A key is present exactly when a read of it returns a value. -/
theorem mapHas_eq_isSome_mapGet {α : Type} (entries : List (String × α)) (key : String) :
    mapHas entries key = (mapGet entries key).isSome := by
  have hany : ∀ l : List (String × α),
      (l.any fun x => x.1 == key) = (List.find? (fun x => x.1 == key) l).isSome := by
    intro l
    rw [Bool.eq_iff_iff, List.any_eq_true, List.find?_isSome]
  unfold mapHas mapGet
  rw [Option.isSome_map]
  exact hany entries

/-- A natural number is written with at least one digit and only digits. -/
theorem nat_toString_spec (n : Nat) :
    (toString n).toList ≠ [] ∧
      ∀ c ∈ (toString n).toList, '0'.toNat ≤ c.toNat ∧ c.toNat ≤ '9'.toNat := by
  have hs : (toString n).toList = decimalChars n := by
    simp [toString, Nat.repr, decimalChars]
  have h0 : '0'.toNat = 48 := rfl
  have h9 : '9'.toNat = 57 := rfl
  rw [hs]
  rcases Nat.eq_zero_or_pos n with rfl | hpos
  · rw [decimalChars_of_lt (by decide)]
    refine ⟨by simp, ?_⟩
    intro c hc
    simp only [List.mem_singleton] at hc
    subst hc
    have := digitChar_toNat (n := 0) (by decide)
    omega
  · obtain ⟨c, rest, hc, hd, -, hr⟩ := decimalChars_pos hpos
    rw [hc]
    refine ⟨by simp, ?_⟩
    intro x hx
    have hx' : isAsciiDigit x = true := by
      rcases List.mem_cons.mp hx with rfl | hx
      · exact hd
      · exact hr x hx
    simp only [isAsciiDigit, decide_eq_true_eq] at hx'
    omega

/-- A non-empty ASCII string suffix without control characters whose last character is not JS
whitespace. -/
def SafeAsciiSuffix (suffix : String) : Prop :=
  suffix ≠ "" ∧
  (∀ c ∈ suffix.toList, c.toNat < 128) ∧
  (∀ c ∈ suffix.toList, isControlChar c = false) ∧
  (∀ c, suffix.toList.getLast? = some c → isJsWhitespace c = false)

/-- The suffix `-journal` is a safe ASCII suffix. -/
theorem safeAsciiSuffix_journal : SafeAsciiSuffix "-journal" := by
  refine ⟨by decide, ?_, ?_, ?_⟩
  · intro c hc; simp at hc; rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide
  · intro c hc; simp at hc; rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide
  · intro c hc
    have hl : "-journal".toList.getLast? = some 'l' := by decide
    rw [hl] at hc
    cases hc
    decide

/-- A safe ASCII prefix followed by a number is a safe ASCII suffix. -/
theorem safeAsciiSuffix_append_nat {pfx : String}
    (hpfx : ∀ c ∈ pfx.toList, c.toNat < 128 ∧ isControlChar c = false) (n : Nat) :
    SafeAsciiSuffix (pfx ++ toString n) := by
  obtain ⟨hne, hdigits⟩ := nat_toString_spec n
  have h0 : '0'.toNat = 48 := rfl
  have h9 : '9'.toNat = 57 := rfl
  have hlist : (pfx ++ toString n).toList = pfx.toList ++ (toString n).toList := by
    simp [String.toList_append]
  have hne_all : (pfx ++ toString n).toList ≠ [] := by
    rw [hlist]
    intro heq
    exact hne (List.append_eq_nil_iff.mp heq).2
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro heq
    apply hne_all
    rw [heq]
    rfl
  · intro c hc
    rw [hlist] at hc
    rcases List.mem_append.mp hc with h1 | h2
    · exact (hpfx c h1).1
    · have := hdigits c h2; omega
  · intro c hc
    rw [hlist] at hc
    rcases List.mem_append.mp hc with h1 | h2
    · exact (hpfx c h1).2
    · have hd := hdigits c h2
      simp only [isControlChar, decide_eq_false_iff_not, not_or]
      omega
  · intro c hc
    rw [hlist] at hc
    have hlast : (toString n).toList.getLast? = some ((toString n).toList.getLast hne) :=
      List.getLast?_eq_some_getLast hne
    rw [List.getLast?_append, hlast, Option.some_or] at hc
    have hceq : (toString n).toList.getLast hne = c := Option.some.inj hc
    have hd := hdigits _ (List.getLast_mem hne)
    rw [hceq] at hd
    have hws : ∀ k : Fin 10, isJsWhitespace (Char.ofNat ('0'.toNat + k.1)) = false := by decide
    have hfin : c.toNat - '0'.toNat < 10 := by omega
    have hcc : c = Char.ofNat ('0'.toNat + (c.toNat - '0'.toNat)) := by
      have : c.toNat = '0'.toNat + (c.toNat - '0'.toNat) := by omega
      exact (char_ofNat_eq_of_toNat this).symm
    rw [hcc]
    exact hws ⟨_, hfin⟩

/-- An identifier followed by a safe ASCII suffix is not empty, is not changed by `trim`, and has no control character. -/
theorem identifier_append_cond {id : ConsolidationCompilationId} {suffix : String}
    (hw : id.WF) (hsuf : SafeAsciiSuffix suffix) :
    (id.value ++ suffix) ≠ "" ∧
    jsTrim (id.value ++ suffix) = id.value ++ suffix ∧
    (∀ c ∈ (id.value ++ suffix).toList, isControlChar c = false) := by
  have hlist : (id.value ++ suffix).toList = id.value.toList ++ suffix.toList := by
    simp [String.toList_append]
  have hid_ne : id.value.toList ≠ [] := fun h =>
    hw.nonempty (by rw [← String.ofList_toList (s := id.value), h])
  have hsuf_ne : suffix.toList ≠ [] := fun h =>
    hsuf.1 (by rw [← String.ofList_toList (s := suffix), h])
  have hboth_ne : (id.value ++ suffix).toList ≠ [] := by
    rw [hlist]
    exact List.append_ne_nil_of_left_ne_nil hid_ne _
  have hne : (id.value ++ suffix) ≠ "" := fun h =>
    hboth_ne (by rw [h]; rfl)
  refine ⟨hne, ?_, ?_⟩
  · refine (jsTrim_eq_self_iff _ hne).mpr ?_
    intro hnn
    have htrim_id := (jsTrim_eq_self_iff _ hw.nonempty).mp hw.no_boundary_whitespace hid_ne
    have hhead : (id.value ++ suffix).toList.head hnn = id.value.toList.head hid_ne := by
      simp [hlist, List.head_append_of_ne_nil hid_ne]
    have hlast : (id.value ++ suffix).toList.getLast hnn = suffix.toList.getLast hsuf_ne := by
      have h1 : (id.value ++ suffix).toList.getLast hnn =
          (id.value.toList ++ suffix.toList).getLast (by rw [← hlist]; exact hnn) := by
        simp [hlist]
      rw [h1, List.getLast_append_of_ne_nil _ hsuf_ne]
    rw [hhead, hlast]
    refine ⟨htrim_id.1, hsuf.2.2.2 _ ?_⟩
    exact List.getLast?_eq_some_getLast hsuf_ne
  · intro c hc
    rw [hlist] at hc
    rcases List.mem_append.mp hc with h1 | h2
    · exact hw.no_control_chars c h1
    · exact hsuf.2.2.1 c h2

/-- An identifier followed by a safe ASCII suffix is accepted exactly when its NFC test passes. -/
theorem identifier_append_ok_iff {Kind : String} {id : ConsolidationCompilationId} {suffix : String}
    (hw : id.WF) (hsuf : SafeAsciiSuffix suffix) (out : Identifier Kind) :
    identifier Kind (id.value ++ suffix) = .ok out ↔
      isNFC (id.value ++ suffix) = true ∧ out.value = id.value ++ suffix := by
  obtain ⟨hne, htrim, hctrl⟩ := identifier_append_cond hw hsuf
  rw [identifier_ok_iff]
  constructor
  · rintro ⟨hout, heq⟩
    refine ⟨?_, heq⟩
    rw [← heq]
    exact hout.nfc
  · rintro ⟨hnfc, heq⟩
    refine ⟨⟨?_, ?_, ?_, ?_⟩, heq⟩ <;> rw [heq] <;> assumption

/-- An identifier followed by a safe ASCII suffix is refused exactly when its NFC test fails. -/
theorem identifier_append_error_iff {Kind : String} {id : ConsolidationCompilationId}
    {suffix : String} (hw : id.WF) (hsuf : SafeAsciiSuffix suffix) (e : CanonicalErr) :
    identifier Kind (id.value ++ suffix) = .error e ↔
      isNFC (id.value ++ suffix) = false ∧ e = .canonicalIdentityConflict := by
  obtain ⟨hne, htrim, hctrl⟩ := identifier_append_cond hw hsuf
  unfold identifier
  have hem : (id.value ++ suffix).isEmpty = false := by
    cases h : (id.value ++ suffix).isEmpty
    · rfl
    · exact absurd (String.isEmpty_iff.mp h) hne
  have htr : (jsTrim (id.value ++ suffix) != id.value ++ suffix) = false := by
    simp [htrim]
  have hct : (id.value ++ suffix).toList.any isControlChar = false := by
    rw [Bool.eq_false_iff]
    intro h
    obtain ⟨c, hc, hct⟩ := List.any_eq_true.mp h
    simp [hctrl c hc] at hct
  simp only [hem, htr, Bool.or_self, Bool.false_eq_true, ↓reduceIte, hct]
  by_cases hnfc : isNFC (id.value ++ suffix) = true
  · simp [hnfc]
  · have hnfcf : isNFC (id.value ++ suffix) = false := Bool.eq_false_iff.mpr hnfc
    simp [hnfcf, eq_comm]

/-- An ASCII identifier followed by a safe ASCII suffix is always accepted. -/
theorem identifier_append_ascii_ok {Kind : String} {id : ConsolidationCompilationId}
    {suffix : String} (hw : id.WF) (hsuf : SafeAsciiSuffix suffix)
    (hascii : ∀ c ∈ id.value.toList, c.toNat < 128) :
    ∃ out, identifier Kind (id.value ++ suffix) = .ok out ∧
      out.WF ∧ out.value = id.value ++ suffix := by
  have hnfc : isNFC (id.value ++ suffix) = true := by
    apply ascii_isNFC
    intro c hc
    have hlist : (id.value ++ suffix).toList = id.value.toList ++ suffix.toList := by
      simp [String.toList_append]
    rw [hlist] at hc
    rcases List.mem_append.mp hc with h1 | h2
    · exact hascii c h1
    · exact hsuf.2.1 c h2
  refine ⟨⟨id.value ++ suffix⟩, ?_, ?_, rfl⟩
  · exact (identifier_append_ok_iff hw hsuf ⟨id.value ++ suffix⟩).mpr ⟨hnfc, rfl⟩
  · exact ((identifier_ok_iff Kind (id.value ++ suffix) ⟨id.value ++ suffix⟩).mp
      ((identifier_append_ok_iff hw hsuf ⟨id.value ++ suffix⟩).mpr ⟨hnfc, rfl⟩)).1

/-! ## The laws -/

/-! ## A calculus for results that may throw -/

/-- `r` returns only values satisfying `P` and fails only with errors satisfying `E`. -/
def Spec {α : Type} (E : ConsolidationErr → Prop) (r : Except ConsolidationErr α)
    (P : α → Prop) : Prop :=
  (∀ v, r = .ok v → P v) ∧ (∀ e, r = .error e → E e)

/-- A result that goes on from a result that meets its law meets its law, when what follows does. -/
theorem Spec.bind {α β : Type} {E : ConsolidationErr → Prop} {r : Except ConsolidationErr α}
    {f : α → Except ConsolidationErr β} {P : α → Prop} {Q : β → Prop}
    (hr : Spec E r P) (hf : ∀ v, P v → Spec E (f v) Q) : Spec E (r.bind f) Q := by
  cases r with
  | error e =>
    refine ⟨fun v h => ?_, fun e' h => ?_⟩
    · cases h
    · cases h; exact hr.2 _ rfl
  | ok v => exact hf v (hr.1 v rfl)

/-- A value that meets the law returns a result that meets it. -/
theorem Spec.ok {α : Type} {E : ConsolidationErr → Prop} {P : α → Prop} {v : α} (h : P v) :
    Spec E (.ok v) P :=
  ⟨fun w hw => by cases hw; exact h, fun e he => by cases he⟩

/-- An admitted error returns a result that meets the law. -/
theorem Spec.err {α : Type} {E : ConsolidationErr → Prop} {P : α → Prop} {e : ConsolidationErr}
    (h : E e) : Spec E (.error e : Except ConsolidationErr α) P :=
  ⟨fun _ hw => (nomatch hw), fun _ he => by cases he; exact h⟩

/-- A result that meets a law meets any weaker one. -/
theorem Spec.mono {α : Type} {E : ConsolidationErr → Prop} {r : Except ConsolidationErr α}
    {P Q : α → Prop} (hr : Spec E r P) (h : ∀ v, P v → Q v) : Spec E r Q :=
  ⟨fun v hv => h v (hr.1 v hv), hr.2⟩

/-- A result whose errors are admitted by one set of errors is admitted by any larger set. -/
theorem Spec.mono_err {α : Type} {E E' : ConsolidationErr → Prop}
    {r : Except ConsolidationErr α} {P : α → Prop} (hr : Spec E r P) (h : ∀ e, E e → E' e) :
    Spec E' r P :=
  ⟨hr.1, fun e he => h e (hr.2 e he)⟩

/-- The error of the size limit. -/
def limitErr : ConsolidationErr := .exactNumber .representationLimitExceeded

section Numeric
variable {E : ConsolidationErr → Prop} (hE : E limitErr)
include hE

/-- Multiplying constructible values returns their exact product or throws only for the size limit. -/
theorem spec_mul {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    Spec E (liftNum (a.multiply b)) fun c => c.WF ∧ c.toRat = a.toRat * b.toRat := by
  refine ⟨fun v hv => ?_, fun e he => ?_⟩
  · exact ExactRational.multiply_ok ha hb (liftNum_ok_iff.mp hv)
  · obtain ⟨code, hcode, rfl⟩ := liftNum_error_iff.mp he
    rcases ExactRational.multiply_ok_or_limit ha hb with ⟨c, hc⟩ | hl
    · rw [hc] at hcode; cases hcode
    · rw [hl] at hcode; cases hcode; exact hE

/-- Adding constructible values returns their exact sum or throws only for the size limit. -/
theorem spec_add {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    Spec E (liftNum (a.add b)) fun c => c.WF ∧ c.toRat = a.toRat + b.toRat := by
  refine ⟨fun v hv => ?_, fun e he => ?_⟩
  · exact ExactRational.add_ok ha hb (liftNum_ok_iff.mp hv)
  · obtain ⟨code, hcode, rfl⟩ := liftNum_error_iff.mp he
    rcases ExactRational.add_ok_or_limit ha hb with ⟨c, hc⟩ | hl
    · rw [hc] at hcode; cases hcode
    · rw [hl] at hcode; cases hcode; exact hE

/-- Subtracting constructible values returns their exact difference or throws only for the size limit. -/
theorem spec_sub {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    Spec E (liftNum (a.subtract b)) fun c => c.WF ∧ c.toRat = a.toRat - b.toRat := by
  refine ⟨fun v hv => ?_, fun e he => ?_⟩
  · exact ExactRational.subtract_ok ha hb (liftNum_ok_iff.mp hv)
  · obtain ⟨code, hcode, rfl⟩ := liftNum_error_iff.mp he
    rcases ExactRational.subtract_ok_or_limit ha hb with ⟨c, hc⟩ | hl
    · rw [hc] at hcode; cases hcode
    · rw [hl] at hcode; cases hcode; exact hE

/-- Dividing by a nonzero constructible value returns the exact quotient or throws only for the size limit. -/
theorem spec_div {a b : ExactRational} (ha : a.WF) (hbw : b.WF) (hb : b.numerator ≠ 0) :
    Spec E (liftNum (a.divide b)) fun c => c.WF ∧ c.toRat = a.toRat / b.toRat := by
  refine ⟨fun v hv => ?_, fun e he => ?_⟩
  · obtain ⟨h1, -, h3⟩ := ExactRational.divide_ok ha hbw (liftNum_ok_iff.mp hv)
    exact ⟨h1, h3⟩
  · obtain ⟨code, hcode, rfl⟩ := liftNum_error_iff.mp he
    rcases ExactRational.divide_ok_or_error ha (b := b) with ⟨c, hc⟩ | ⟨h0, _⟩ | ⟨_, hl⟩
    · rw [hc] at hcode; cases hcode
    · exact absurd h0 hb
    · rw [hl] at hcode; cases hcode; exact hE

end Numeric

/-! ## Walking a valuation path -/

/-- The factor each step of a path contributes when the path is walked from `current`, in the order
of the steps (`accounting.ts` lines 2094 and 2095): a step whose `fromCommodityId` is where the walk
stands is read forward and contributes its rate; any other step is read inversely and contributes
one over its rate. -/
def stepFactors : CommodityId → List ConsolidationValuationStep → List ℚ
  | _, [] => []
  | current, step :: rest =>
    if step.fromCommodityId == current then
      step.rate.toRat :: stepFactors step.toCommodityId rest
    else (step.rate.toRat)⁻¹ :: stepFactors step.fromCommodityId rest

/-- The commodity a walk of a path from `current` ends in. -/
def walkEnd : CommodityId → List ConsolidationValuationStep → CommodityId
  | current, [] => current
  | current, step :: rest =>
    if step.fromCommodityId == current then walkEnd step.toCommodityId rest
    else walkEnd step.fromCommodityId rest

/-- Whether a walk of a path from `current` reads some step inversely. -/
def walkUsedInverse : CommodityId → List ConsolidationValuationStep → Bool
  | _, [] => false
  | current, step :: rest =>
    if step.fromCommodityId == current then walkUsedInverse step.toCommodityId rest else true

/-- What the loop of `accounting.ts` lines 2091 to 2099 accepts, as a statement about the steps: each
step has evidence, a positive rate and an observation not after the governed instant (line 2092);
it is read forward when it starts where the walk stands, and then the commodity it reaches has not
been visited; otherwise it is read inversely, which the policy must allow, and it must end where the
walk stands, be no loop, and reach a commodity not visited (lines 2094 to 2097). -/
def PathAdmissible (governedAt : Instant) (allowInverse : Bool) :
    CommodityId → List CommodityId → List ConsolidationValuationStep → Prop
  | _, _, [] => True
  | current, visited, step :: rest =>
    step.evidenceIds ≠ [] ∧ 0 < step.rate.numerator ∧
      jsStringLt governedAt.value step.observedAt.value = false ∧
    (if step.fromCommodityId = current then
      step.toCommodityId ∉ visited ∧
        PathAdmissible governedAt allowInverse step.toCommodityId
          (step.toCommodityId :: visited) rest
    else
      allowInverse = true ∧ step.toCommodityId = current ∧ step.fromCommodityId ≠ step.toCommodityId ∧
        step.fromCommodityId ∉ visited ∧
        PathAdmissible governedAt allowInverse step.fromCommodityId
          (step.fromCommodityId :: visited) rest)

/-- A value is positive exactly when its numerator is. -/
theorem positive_iff {r : ExactRational} : positive r = true ↔ 0 < r.numerator := by
  unfold positive
  rw [beq_iff_eq, ExactRational.compare_def]
  have h0 : ExactRational.zero.numerator = 0 := rfl
  have h1 : ExactRational.zero.denominator = 1 := rfl
  rw [h0, h1]
  simp only [mul_one, zero_mul, sub_zero, gt_iff_lt]
  split_ifs with ha hb
  · simp; omega
  · simp; omega
  · simp; omega

/-- The outcome of walking a path, as the laws state it: refused exactly when the steps are not
admissible; otherwise the commodity it ends in, its exact rate (the starting rate times the product
of the factors of the steps, in order) and whether it read a step inversely. -/
def PathOut (governedAt : Instant) (allowInverse : Bool)
    (steps : List ConsolidationValuationStep) (current : CommodityId) (rate : ExactRational)
    (used : Bool) (visited : List CommodityId) :
    Option (CommodityId × ExactRational × Bool) → Prop
  | none => ¬ PathAdmissible governedAt allowInverse current visited steps
  | some (c', r', u') =>
    PathAdmissible governedAt allowInverse current visited steps ∧ c' = walkEnd current steps ∧
      r'.WF ∧ r'.toRat = rate.toRat * (stepFactors current steps).prod ∧
      u' = (used || walkUsedInverse current steps)

/-- The walk of a path is refused exactly when its steps are not admissible, and otherwise ends where the steps lead with the exact product of their factors, or throws only for the size limit. -/
theorem evalPathSteps_spec {E : ConsolidationErr → Prop} (hE : E limitErr) (governedAt : Instant)
    (allowInverse : Bool) :
    ∀ (steps : List ConsolidationValuationStep) (current : CommodityId) (rate : ExactRational)
      (used : Bool) (visited : List CommodityId),
      (∀ s ∈ steps, s.WF) → rate.WF →
      Spec E (evalPathSteps governedAt allowInverse current rate used visited steps)
        (PathOut governedAt allowInverse steps current rate used visited) := by
  intro steps
  induction steps with
  | nil =>
    intro current rate used visited _ hr
    simp only [evalPathSteps]
    refine Spec.ok ?_
    simp [PathOut, PathAdmissible, walkEnd, stepFactors, walkUsedInverse, hr]
  | cons step rest ih =>
    intro current rate used visited hsteps hr
    have hsw : step.WF := hsteps step (by simp)
    have hrest : ∀ s ∈ rest, s.WF := fun s hs => hsteps s (by simp [hs])
    unfold evalPathSteps
    by_cases hbad : (step.evidenceIds.isEmpty || !positive step.rate ||
        jsStringLt governedAt.value step.observedAt.value) = true
    · simp only [hbad, ↓reduceIte]
      refine Spec.ok ?_
      simp only [PathOut, PathAdmissible]
      intro hadm
      simp only [Bool.or_eq_true, Bool.not_eq_true'] at hbad
      rcases hbad with (h | h) | h
      · exact hadm.1 (List.isEmpty_iff.mp h)
      · have := positive_iff.mpr hadm.2.1
        rw [h] at this; cases this
      · rw [hadm.2.2.1] at h; cases h
    · have hbf : (step.evidenceIds.isEmpty || !positive step.rate ||
          jsStringLt governedAt.value step.observedAt.value) = false := Bool.eq_false_iff.mpr hbad
      simp only [hbf, Bool.false_eq_true, ↓reduceIte]
      simp only [Bool.or_eq_false_iff, Bool.not_eq_false', List.isEmpty_eq_false_iff] at hbf
      obtain ⟨⟨hev, hpos⟩, hobs⟩ := hbf
      have hposn : 0 < step.rate.numerator := positive_iff.mp hpos
      have hbase : step.evidenceIds ≠ [] ∧ 0 < step.rate.numerator ∧
          jsStringLt governedAt.value step.observedAt.value = false := ⟨hev, hposn, hobs⟩
      by_cases hfwd : (step.fromCommodityId == current) = true
      · simp only [hfwd, ↓reduceIte]
        have hfe : step.fromCommodityId = current := beq_iff_eq.mp hfwd
        split
        · rename_i e heq
          exact Spec.err ((spec_mul hE hr hsw.rate).2 e heq)
        rename_i nextRate heq
        have hn := (spec_mul hE hr hsw.rate).1 nextRate heq
        by_cases hvis : visited.contains step.toCommodityId = true
        · simp only [hvis, ↓reduceIte]
          refine Spec.ok ?_
          simp only [PathOut, PathAdmissible, hfe, ↓reduceIte]
          intro hadm
          exact hadm.2.2.2.1 (List.contains_iff_mem.mp hvis)
        · have hvisf : visited.contains step.toCommodityId = false := Bool.eq_false_iff.mpr hvis
          simp only [hvisf, Bool.false_eq_true, ↓reduceIte]
          have hnotmem : step.toCommodityId ∉ visited := fun hm =>
            hvis (List.contains_iff_mem.mpr hm)
          refine Spec.mono (ih step.toCommodityId nextRate used (step.toCommodityId :: visited) hrest hn.1) ?_
          intro o ho
          cases o with
          | none =>
            simp only [PathOut] at ho ⊢
            intro hadm
            simp only [PathAdmissible, hfe, ↓reduceIte] at hadm
            exact ho hadm.2.2.2.2
          | some t =>
            obtain ⟨c', r', u'⟩ := t
            simp only [PathOut] at ho ⊢
            obtain ⟨hadm, hend, hwf, hval, hused⟩ := ho
            refine ⟨?_, ?_, hwf, ?_, ?_⟩
            · simp only [PathAdmissible, hfe, ↓reduceIte]
              exact ⟨hbase.1, hbase.2.1, hbase.2.2, hnotmem, hadm⟩
            · simp only [walkEnd, hfwd, ↓reduceIte]; exact hend
            · simp only [stepFactors, hfwd, ↓reduceIte, List.prod_cons]
              rw [hval, hn.2]; ring
            · simp only [walkUsedInverse, hfwd, ↓reduceIte]; exact hused
      · have hfwdf : (step.fromCommodityId == current) = false := Bool.eq_false_iff.mpr hfwd
        have hfne : step.fromCommodityId ≠ current := fun h => hfwd (beq_iff_eq.mpr h)
        simp only [hfwdf, Bool.false_eq_true, ↓reduceIte]
        by_cases hinv : (allowInverse && step.toCommodityId == current &&
            step.fromCommodityId != step.toCommodityId) = true
        · simp only [hinv, ↓reduceIte]
          simp only [Bool.and_eq_true, beq_iff_eq, bne_iff_ne, ne_eq] at hinv
          obtain ⟨⟨hai, hte⟩, hft⟩ := hinv
          have hnum : step.rate.numerator ≠ 0 := by omega
          split
          · rename_i e heq
            exact Spec.err ((spec_div hE hr hsw.rate hnum).2 e heq)
          rename_i nextRate heq
          have hn := (spec_div hE hr hsw.rate hnum).1 nextRate heq
          by_cases hvis : visited.contains step.fromCommodityId = true
          · simp only [hvis, ↓reduceIte]
            refine Spec.ok ?_
            simp only [PathOut, PathAdmissible, hfne, ↓reduceIte]
            intro hadm
            exact hadm.2.2.2.2.2.2.1 (List.contains_iff_mem.mp hvis)
          · have hvisf : visited.contains step.fromCommodityId = false := Bool.eq_false_iff.mpr hvis
            simp only [hvisf, Bool.false_eq_true, ↓reduceIte]
            have hnotmem : step.fromCommodityId ∉ visited := fun hm =>
              hvis (List.contains_iff_mem.mpr hm)
            refine Spec.mono (ih step.fromCommodityId nextRate true
              (step.fromCommodityId :: visited) hrest hn.1) ?_
            intro o ho
            cases o with
            | none =>
              simp only [PathOut] at ho ⊢
              intro hadm
              simp only [PathAdmissible, hfne, ↓reduceIte] at hadm
              exact ho hadm.2.2.2.2.2.2.2
            | some t =>
              obtain ⟨c', r', u'⟩ := t
              simp only [PathOut] at ho ⊢
              obtain ⟨hadm, hend, hwf, hval, hused⟩ := ho
              refine ⟨?_, ?_, hwf, ?_, ?_⟩
              · simp only [PathAdmissible, hfne, ↓reduceIte]
                exact ⟨hbase.1, hbase.2.1, hbase.2.2, hai, hte, hft, hnotmem, hadm⟩
              · simp only [walkEnd, hfwdf, Bool.false_eq_true, ↓reduceIte]; exact hend
              · simp only [stepFactors, hfwdf, Bool.false_eq_true, ↓reduceIte, List.prod_cons]
                rw [hval, hn.2, div_eq_mul_inv]; ring
              · simp only [walkUsedInverse, hfwdf, Bool.false_eq_true, ↓reduceIte, Bool.or_true]
                rw [hused]; simp
        · simp only [hinv, Bool.false_eq_true, ↓reduceIte]
          refine Spec.ok ?_
          simp only [PathOut, PathAdmissible, hfne, ↓reduceIte]
          intro hadm
          apply hinv
          simp only [Bool.and_eq_true, beq_iff_eq, bne_iff_ne, ne_eq]
          exact ⟨⟨hadm.2.2.2.1, hadm.2.2.2.2.1⟩, hadm.2.2.2.2.2.1⟩

/-! ## Candidates of a balance -/

/-- A path makes a candidate for a balance in `fromCommodityId` to be translated into
`targetCommodityId`: it passes the header test, its steps are admissible, and it ends in the target. -/
def MakesCandidate (governedAt : Instant) (throughOn : LocalDate) (maximumHops : Int)
    (allowInverse : Bool) (fromCommodityId targetCommodityId : CommodityId)
    (path : ConsolidationValuationPath) : Prop :=
  pathHeaderAdmissible governedAt throughOn maximumHops path = true ∧
    PathAdmissible governedAt allowInverse fromCommodityId [fromCommodityId] path.steps ∧
    walkEnd fromCommodityId path.steps = targetCommodityId

/-- `c` is the candidate the path makes: it carries the path's identity, instant and length, and its
rate is the exact product of the factors of the steps, in order. -/
def CandidateOf (governedAt : Instant) (throughOn : LocalDate) (maximumHops : Int)
    (allowInverse : Bool) (fromCommodityId targetCommodityId : CommodityId)
    (path : ConsolidationValuationPath) (c : PathCandidate) : Prop :=
  MakesCandidate governedAt throughOn maximumHops allowInverse fromCommodityId targetCommodityId path ∧
    c.id = path.id ∧ c.effectiveAt = path.effectiveAt ∧ c.hops = path.steps.length ∧
    c.rate.WF ∧ c.rate.toRat = (stepFactors fromCommodityId path.steps).prod ∧
    c.direct = (decide (path.steps.length = 1) && !walkUsedInverse fromCommodityId path.steps)

/-- A path makes a candidate exactly when it is admissible, and the candidate carries the exact product of its steps, or the walk throws only for the size limit. -/
theorem pathCandidate_spec {E : ConsolidationErr → Prop} (hE : E limitErr) (governedAt : Instant)
    (throughOn : LocalDate) (maximumHops : Int) (allowInverse : Bool)
    (fromCommodityId targetCommodityId : CommodityId) (path : ConsolidationValuationPath)
    (hpath : path.WF) :
    Spec E (pathCandidate governedAt throughOn maximumHops allowInverse fromCommodityId
        targetCommodityId path) fun o =>
      match o with
      | none => ¬ MakesCandidate governedAt throughOn maximumHops allowInverse fromCommodityId
          targetCommodityId path
      | some c => CandidateOf governedAt throughOn maximumHops allowInverse fromCommodityId
          targetCommodityId path c := by
  unfold pathCandidate
  by_cases hh : pathHeaderAdmissible governedAt throughOn maximumHops path = true
  · have hhf : (!pathHeaderAdmissible governedAt throughOn maximumHops path) = false := by
      simp [hh]
    simp only [hhf, Bool.false_eq_true, ↓reduceIte]
    have hspec := evalPathSteps_spec hE governedAt allowInverse path.steps fromCommodityId
      rationalOne false [fromCommodityId] hpath.steps rationalOne_wf
    split
    · rename_i e heq
      exact Spec.err (hspec.2 e heq)
    · rename_i heq
      refine Spec.ok ?_
      have := hspec.1 none heq
      simp only [PathOut] at this
      intro hm
      exact this hm.2.1
    · rename_i endCommodity rate usedInverse heq
      have hout := hspec.1 (some (endCommodity, rate, usedInverse)) heq
      simp only [PathOut] at hout
      obtain ⟨hadm, hend, hwf, hval, hused⟩ := hout
      by_cases hend2 : (endCommodity == targetCommodityId) = true
      · simp only [hend2, ↓reduceIte]
        refine Spec.ok ?_
        have he : endCommodity = targetCommodityId := beq_iff_eq.mp hend2
        refine ⟨⟨hh, hadm, by rw [← hend, he]⟩, rfl, rfl, rfl, hwf, ?_, ?_⟩
        · rw [hval, rationalOne_toRat, one_mul]
        · rw [hused]; simp
      · simp only [hend2, Bool.false_eq_true, ↓reduceIte]
        refine Spec.ok ?_
        intro hm
        apply hend2
        have := hm.2.2
        rw [← hend] at this
        simp [this]
  · have hhf : (!pathHeaderAdmissible governedAt throughOn maximumHops path) = true := by
      simpa using hh
    simp only [hhf, ↓reduceIte]
    refine Spec.ok ?_
    intro hm
    exact hh hm.1

/-- The candidates are those of the paths that make one, each with its path, or the loop throws only for the size limit. -/
theorem collectCandidates_spec {E : ConsolidationErr → Prop} (hE : E limitErr) (governedAt : Instant)
    (throughOn : LocalDate) (maximumHops : Int) (allowInverse : Bool)
    (fromCommodityId targetCommodityId : CommodityId) :
    ∀ (paths : List ConsolidationValuationPath), (∀ p ∈ paths, p.WF) →
      Spec E (collectCandidates governedAt throughOn maximumHops allowInverse fromCommodityId
          targetCommodityId paths) fun cs =>
        (∀ c ∈ cs, ∃ path ∈ paths, CandidateOf governedAt throughOn maximumHops allowInverse
          fromCommodityId targetCommodityId path c) ∧
        (cs = [] ↔ ∀ path ∈ paths, ¬ MakesCandidate governedAt throughOn maximumHops allowInverse
          fromCommodityId targetCommodityId path) := by
  intro paths
  induction paths with
  | nil =>
    intro _
    simp only [collectCandidates]
    exact Spec.ok ⟨fun c hc => by simp at hc, by simp⟩
  | cons path rest ih =>
    intro hw
    have hp : path.WF := hw path (by simp)
    have hr : ∀ p ∈ rest, p.WF := fun p hpm => hw p (by simp [hpm])
    unfold collectCandidates
    have hs1 := pathCandidate_spec hE governedAt throughOn maximumHops allowInverse
      fromCommodityId targetCommodityId path hp
    have hs2 := ih hr
    split
    · rename_i e heq
      exact Spec.err (hs1.2 e heq)
    · rename_i candidate heq
      have h1 := hs1.1 candidate heq
      split
      · rename_i e heq2
        exact Spec.err (hs2.2 e heq2)
      · rename_i tail heq2
        have h2 := hs2.1 tail heq2
        refine Spec.ok ⟨?_, ?_⟩
        · intro c hc
          rcases List.mem_append.mp hc with hc | hc
          · cases candidate with
            | none => simp at hc
            | some c0 =>
              simp at hc
              subst hc
              exact ⟨path, by simp, h1⟩
          · obtain ⟨p, hpm, hc2⟩ := h2.1 c hc
            exact ⟨p, by simp [hpm], hc2⟩
        · constructor
          · intro hnil
            have hnil' := List.append_eq_nil_iff.mp hnil
            intro p hpm
            rcases List.mem_cons.mp hpm with rfl | hpm
            · cases candidate with
              | none => simpa using h1
              | some c0 => simp at hnil'
            · exact (h2.2.mp hnil'.2) p hpm
          · intro hall
            have hnone : candidate = none := by
              cases candidate with
              | none => rfl
              | some c0 =>
                exfalso
                exact hall path (by simp) h1.1
            subst hnone
            simp only [Option.toList_none, List.nil_append]
            exact h2.2.mpr (fun p hpm => hall p (by simp [hpm]))

/-! ## Choosing the rate -/

/-- The candidates `selectRate` ranks: the direct ones when either policy prefers them and one
exists, else all (`accounting.ts` lines 2103 and 2104). -/
def preferredCandidates (preferDirect : Bool) (candidates : List PathCandidate) :
    List PathCandidate :=
  if preferDirect && candidates.any (·.direct) then candidates.filter (·.direct) else candidates

/-- The preferred candidates in the order of `compareCandidate` (line 2105, a stable sort). -/
def rankedCandidates (preferDirect : Bool) (candidates : List PathCandidate) :
    List PathCandidate :=
  (preferredCandidates preferDirect candidates).mergeSort fun left right =>
    compareCandidate left right != .gt

/-- `selectRate` unfolded: none, or the best of the ranked candidates unless another differs from it. -/
theorem selectRate_eq (pd : Bool) (cands : List PathCandidate) :
    selectRate pd cands =
      if cands.isEmpty then .inl [noAdmissiblePathDiagnostic]
      else match rankedCandidates pd cands with
        | [] => .inl [noAdmissiblePathDiagnostic]
        | best :: _ =>
          if (rankedCandidates pd cands).any (fun candidate =>
              candidate.hops == best.hops && candidate.effectiveAt == best.effectiveAt &&
                !candidate.rate.equals best.rate) = true
          then .inl [ambiguousPathRateDiagnostic] else .inr best.rate := rfl

/-- Preferring direct paths leaves a candidate when there was one. -/
theorem preferredCandidates_ne_nil {pd : Bool} {cands : List PathCandidate} (h : cands ≠ []) :
    preferredCandidates pd cands ≠ [] := by
  unfold preferredCandidates
  by_cases hc : (pd && cands.any (·.direct)) = true
  · simp only [hc, ↓reduceIte]
    simp only [Bool.and_eq_true] at hc
    obtain ⟨c, hcm, hcd⟩ := List.any_eq_true.mp hc.2
    intro hnil
    have : c ∈ cands.filter (·.direct) := List.mem_filter.mpr ⟨hcm, hcd⟩
    rw [hnil] at this
    cases this
  · simp only [hc, Bool.false_eq_true, ↓reduceIte]
    exact h

/-- A preferred candidate is a candidate. -/
theorem mem_preferredCandidates {pd : Bool} {cands : List PathCandidate} {c : PathCandidate}
    (h : c ∈ preferredCandidates pd cands) : c ∈ cands := by
  unfold preferredCandidates at h
  split at h
  · exact (List.mem_filter.mp h).1
  · exact h

/-- The ranking keeps the preferred candidates. -/
theorem mem_rankedCandidates {pd : Bool} {cands : List PathCandidate} {c : PathCandidate} :
    c ∈ rankedCandidates pd cands ↔ c ∈ preferredCandidates pd cands := by
  unfold rankedCandidates
  exact List.mem_mergeSort

/-- The ranking of a nonempty list of candidates is nonempty. -/
theorem rankedCandidates_ne_nil {pd : Bool} {cands : List PathCandidate} (h : cands ≠ []) :
    rankedCandidates pd cands ≠ [] := by
  intro hnil
  have hperm := List.mergeSort_perm (preferredCandidates pd cands)
    (fun left right => compareCandidate left right != .gt)
  unfold rankedCandidates at hnil
  rw [hnil] at hperm
  exact preferredCandidates_ne_nil h (List.perm_nil.mp hperm.symm)

/-- The ambiguity diagnostic is not the diagnostic of no admissible path. -/
theorem ambiguousDiag_ne_noAdmissible :
    ([ambiguousPathRateDiagnostic] : List SemanticDiagnostic) ≠ [noAdmissiblePathDiagnostic] := by
  simp [noAdmissiblePathDiagnostic, ambiguousPathRateDiagnostic, diagnostic]

/-- The one diagnostic of `selectRate` for no candidate: exactly when there is none. -/
theorem selectRate_noAdmissible_iff (pd : Bool) (cands : List PathCandidate) :
    selectRate pd cands = .inl [noAdmissiblePathDiagnostic] ↔ cands = [] := by
  rw [selectRate_eq]
  by_cases h : cands = []
  · subst h; simp
  · have hne : cands.isEmpty = false := by simpa using h
    simp only [hne, Bool.false_eq_true, ↓reduceIte]
    constructor
    · intro hs
      exfalso
      cases hr : rankedCandidates pd cands with
      | nil => exact rankedCandidates_ne_nil h hr
      | cons best rest =>
        rw [hr] at hs
        simp only at hs
        split at hs
        · exact ambiguousDiag_ne_noAdmissible (Sum.inl.inj hs)
        · cases hs
    · intro hc; exact absurd hc h

/-- The rate chosen is the rate of one of the candidates. -/
theorem selectRate_inr_mem {pd : Bool} {cands : List PathCandidate} {r : ExactRational}
    (h : selectRate pd cands = .inr r) : ∃ b ∈ cands, b.rate = r := by
  rw [selectRate_eq] at h
  split at h
  · cases h
  · cases hr : rankedCandidates pd cands with
    | nil => rw [hr] at h; simp at h
    | cons best rest =>
      rw [hr] at h
      simp only at h
      split at h
      · cases h
      · cases h
        have hm : best ∈ rankedCandidates pd cands := by rw [hr]; simp
        exact ⟨best, mem_preferredCandidates (mem_rankedCandidates.mp hm), rfl⟩

/-- Two constructible rates differ exactly when `equals` says so. -/
theorem rate_ne_iff {a b : ExactRational} : (!a.equals b) = true ↔ a ≠ b := by
  cases a; cases b
  simp [ExactRational.equals]
  tauto

/-- The ambiguity diagnostic of `selectRate`: exactly when there is a candidate, and in the ranking
the best has the same hops and `effectiveAt` as a candidate with another rate. -/
theorem selectRate_ambiguous_iff (pd : Bool) (cands : List PathCandidate) :
    selectRate pd cands = .inl [ambiguousPathRateDiagnostic] ↔
      cands ≠ [] ∧ ∃ best rest, rankedCandidates pd cands = best :: rest ∧
        ∃ c ∈ best :: rest, c.hops = best.hops ∧ c.effectiveAt = best.effectiveAt ∧
          c.rate ≠ best.rate := by
  constructor
  · intro hs
    rw [selectRate_eq] at hs
    by_cases h : cands = []
    · subst h; simp at hs
      exact absurd (congrArg (fun d => [d]) hs.symm) ambiguousDiag_ne_noAdmissible
    · have hne : cands.isEmpty = false := by simpa using h
      simp only [hne, Bool.false_eq_true, ↓reduceIte] at hs
      refine ⟨h, ?_⟩
      cases hr : rankedCandidates pd cands with
      | nil => exact absurd hr (rankedCandidates_ne_nil h)
      | cons best rest =>
        rw [hr] at hs
        simp only at hs
        split at hs
        · rename_i hamb
          obtain ⟨c, hcm, hc⟩ := List.any_eq_true.mp hamb
          simp only [Bool.and_eq_true, beq_iff_eq] at hc
          exact ⟨best, rest, rfl, c, hcm, hc.1.1, hc.1.2, rate_ne_iff.mp hc.2⟩
        · cases hs
  · rintro ⟨h, best, rest, hr, c, hcm, h1, h2, h3⟩
    rw [selectRate_eq]
    have hne : cands.isEmpty = false := by simpa using h
    simp only [hne, Bool.false_eq_true, ↓reduceIte]
    rw [hr]
    simp only
    have hany : ((best :: rest).any fun candidate =>
        candidate.hops == best.hops && candidate.effectiveAt == best.effectiveAt &&
          !candidate.rate.equals best.rate) = true :=
      List.any_eq_true.mpr ⟨c, hcm, by
        simp only [Bool.and_eq_true, beq_iff_eq, h1, h2, true_and]
        exact rate_ne_iff.mpr h3⟩
    simp only [hany, ↓reduceIte]

/-! ## The rate of a balance -/

theorem ite_of_not {α : Type} {c : Prop} [Decidable c] {a b : α} (h : ¬c) :
    (if c then a else b) = b := by simp [h]

/-- The rate chosen under a rule is the exact product of the factors of a path that makes a candidate, under a target and a valuation policy that are right, or the stage throws only for the size limit. -/
theorem resolveRateByRule_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (gv : ConsolidationValuationPolicy) (governedAt : Instant) (throughOn : LocalDate)
    (commodityId : CommodityId) (targets : List (String × AccountId)) (book : BookId)
    (balance : ConsolidationSourceBalance) (rule : ConsolidationTranslationRule)
    (hb : balance.WF) :
    Spec E (resolveRateByRule gv governedAt throughOn commodityId targets book balance rule)
      fun o => ∀ r, o = .inr r →
        r.WF ∧ mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
          ruleValuationInvalid governedAt gv rule.valuationPolicy = false ∧
          ∃ path ∈ balance.valuationPaths,
            MakesCandidate governedAt throughOn rule.valuationPolicy.maximumHops
              rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId path ∧
            r.toRat = (stepFactors balance.unitsCommodityId path.steps).prod := by
  unfold resolveRateByRule
  simp only
  by_cases hmis : (mapGet targets (coordinate book balance.sourceAccountId) !=
      some rule.targetAccountId) = true
  · simp only [hmis, ↓reduceIte]
    exact Spec.ok fun r hr => by cases hr
  · have hmisf : (mapGet targets (coordinate book balance.sourceAccountId) !=
        some rule.targetAccountId) = false := Bool.eq_false_iff.mpr hmis
    have htarget : mapGet targets (coordinate book balance.sourceAccountId) =
        some rule.targetAccountId := by simpa using hmisf
    rw [ite_of_not hmis]
    by_cases hinv : ruleValuationInvalid governedAt gv rule.valuationPolicy = true
    · simp only [hinv, ↓reduceIte]
      exact Spec.ok fun r hr => by cases hr
    · have hinvf : ruleValuationInvalid governedAt gv rule.valuationPolicy = false :=
        Bool.eq_false_iff.mpr hinv
      rw [ite_of_not hinv]
      have hspec := collectCandidates_spec hE governedAt throughOn rule.valuationPolicy.maximumHops
        rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId
        balance.valuationPaths hb.valuationPaths
      split
      · rename_i e heq
        exact Spec.err (hspec.2 e heq)
      · rename_i candidates heq
        have hc := hspec.1 candidates heq
        refine Spec.ok fun r hr => ?_
        obtain ⟨b, hbm, hbr⟩ := selectRate_inr_mem hr
        obtain ⟨path, hpm, hcand⟩ := hc.1 b hbm
        refine ⟨?_, htarget, hinvf, path, hpm, hcand.1, ?_⟩
        · rw [← hbr]; exact hcand.2.2.2.2.1
        · rw [← hbr]; exact hcand.2.2.2.2.2.1

/-- The rate of a balance is one, or the exact product of the factors of a path it presents under the one rule, or the stage throws only for the size limit. -/
theorem resolveRate_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (rules : List ConsolidationTranslationRule) (gv : ConsolidationValuationPolicy)
    (governedAt : Instant) (throughOn : LocalDate) (commodityId : CommodityId)
    (targets : List (String × AccountId)) (book : BookId) (balance : ConsolidationSourceBalance)
    (hb : balance.WF) :
    Spec E (resolveRate rules gv governedAt throughOn commodityId targets book balance)
      fun o => ∀ r, o = .inr r →
        r.WF ∧
        ((balance.unitsCommodityId = commodityId ∧ balance.valuationPaths = [] ∧
            r = rationalOne) ∨
          (balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
            rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
            mapGet targets (coordinate book balance.sourceAccountId) =
              some rule.targetAccountId ∧
            ruleValuationInvalid governedAt gv rule.valuationPolicy = false ∧
            ∃ path ∈ balance.valuationPaths,
              MakesCandidate governedAt throughOn rule.valuationPolicy.maximumHops
                rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId
                path ∧
              r.toRat = (stepFactors balance.unitsCommodityId path.steps).prod)) := by
  unfold resolveRate
  by_cases hc : (balance.unitsCommodityId == commodityId) = true
  · have hce : balance.unitsCommodityId = commodityId := beq_iff_eq.mp hc
    simp only [hc, ↓reduceIte]
    by_cases hp : (!balance.valuationPaths.isEmpty) = true
    · simp only [hp, ↓reduceIte]
      exact Spec.ok fun r hr => by cases hr
    · have hpf : balance.valuationPaths.isEmpty = true := by simpa using hp
      simp only [hp, Bool.false_eq_true, ↓reduceIte]
      refine Spec.ok fun r hr => ?_
      have := Sum.inr.inj hr
      subst this
      exact ⟨rationalOne_wf, Or.inl ⟨hce, List.isEmpty_iff.mp hpf, rfl⟩⟩
  · have hcf : (balance.unitsCommodityId == commodityId) = false := Bool.eq_false_iff.mpr hc
    have hne : balance.unitsCommodityId ≠ commodityId := fun h => hc (beq_iff_eq.mpr h)
    simp only [hcf, Bool.false_eq_true, ↓reduceIte]
    cases hf : rules.filter (ruleApplies book balance.sourceAccountId governedAt) with
    | nil => exact Spec.ok fun r hr => by cases hr
    | cons rule rest =>
      cases rest with
      | cons r2 rest2 => exact Spec.ok fun r hr => by cases hr
      | nil =>
        refine Spec.mono (resolveRateByRule_spec hE gv governedAt throughOn commodityId targets
          book balance rule hb) ?_
        intro o ho r hr
        obtain ⟨h1, h2, h3, path, hpm, hmk, hval⟩ := ho r hr
        exact ⟨h1, Or.inr ⟨hne, rule, rfl, h2, h3, path, hpm, hmk, hval⟩⟩

/-! ## Account mappings and the loop that resolves them -/

/-- The account a source balance is mapped to as the policy says: the target of the one mapping that
applies to the source book and account at the governed instant (`accounting.ts` lines 2063 to 2065);
none when no mapping applies or several do. -/
def mappingTarget (mappings : List ConsolidationAccountMapping) (governedAt : Instant)
    (book : BookId) (account : AccountId) : Option AccountId :=
  match mappings.filter (mappingApplies book account governedAt) with
  | [mapping] => some mapping.targetAccountId
  | _ => none

/-- A balance resolves to an account exactly when the policy has one mapping for it, whose target it is. -/
theorem resolveTarget_inr_iff (mappings : List ConsolidationAccountMapping) (governedAt : Instant)
    (book : BookId) (account : AccountId) (t : AccountId) :
    resolveTarget mappings governedAt book account = .inr t ↔
      mappingTarget mappings governedAt book account = some t := by
  unfold resolveTarget mappingTarget
  cases mappings.filter (mappingApplies book account governedAt) with
  | nil => simp
  | cons m rest => cases rest <;> simp

/-- A balance is refused exactly when the policy has no mapping or several for it. -/
theorem resolveTarget_inl_iff (mappings : List ConsolidationAccountMapping) (governedAt : Instant)
    (book : BookId) (account : AccountId) (d : List SemanticDiagnostic) :
    resolveTarget mappings governedAt book account = .inl d ↔
      mappingTarget mappings governedAt book account = none ∧ d = [mappingsDiagnostic] := by
  unfold resolveTarget mappingTarget
  cases mappings.filter (mappingApplies book account governedAt) with
  | nil => simp [eq_comm]
  | cons m rest => cases rest <;> simp [eq_comm]

/-- The mapped account does not depend on the order of the mappings. -/
theorem mappingTarget_sortMappings (mappings : List ConsolidationAccountMapping)
    (governedAt : Instant) (book : BookId) (account : AccountId) :
    mappingTarget (sortMappings mappings) governedAt book account =
      mappingTarget mappings governedAt book account := by
  cases h : mappingTarget mappings governedAt book account with
  | none =>
    cases h2 : mappingTarget (sortMappings mappings) governedAt book account with
    | none => rfl
    | some t =>
      have := (resolveTarget_inr_iff _ _ _ _ _).mpr h2
      rw [resolveTarget_sortMappings, resolveTarget_inr_iff, h] at this
      cases this
  | some t =>
    have := (resolveTarget_inr_iff _ _ _ _ _).mpr h
    rw [← resolveTarget_sortMappings, resolveTarget_inr_iff] at this
    exact this

/-- The coordinate a pair of the loops of lines 2112 and 2119 is recorded under. -/
def pairKey (pair : BookId × ConsolidationSourceBalance) : String :=
  coordinate pair.1 pair.2.sourceAccountId

/-- Two balance pairs with one coordinate are of the same book and account. -/
theorem pairKey_inj {p q : BookId × ConsolidationSourceBalance} (h : pairKey p = pairKey q) :
    p.1 = q.1 ∧ p.2.sourceAccountId = q.2.sourceAccountId :=
  coordinate_injective h

/-- A key that reads a value is present. -/
theorem mapHas_true_of_mapGet {α : Type} {entries : List (String × α)} {k : String} {v : α}
    (h : mapGet entries k = some v) : mapHas entries k = true := by
  rw [mapHas_eq_isSome_mapGet, h]; rfl

/-- A key that is present reads a value. -/
theorem mapGet_ne_none_of_mapHas {α : Type} {entries : List (String × α)} {k : String}
    (h : mapHas entries k = true) : ∃ v, mapGet entries k = some v := by
  rw [mapHas_eq_isSome_mapGet] at h
  cases hg : mapGet entries k with
  | none => rw [hg] at h; cases h
  | some v => exact ⟨v, rfl⟩

/-- What the loop of lines 2111 to 2117 leaves when it ends without a diagnostic: each balance's
coordinate maps to the target of the policy's mapping for its source book and account, and every
earlier entry stays. -/
theorem resolveTargetsLoop_inr (mappings : List ConsolidationAccountMapping) (governedAt : Instant) :
    ∀ (pairs : List (BookId × ConsolidationSourceBalance)) (entries es : List (String × AccountId)),
      (∀ k t, mapGet entries k = some t → ∃ b a, coordinate b a = k ∧
        mappingTarget mappings governedAt b a = some t) →
      resolveTargetsLoop mappings governedAt entries pairs = .inr es →
      (∀ k t, mapGet es k = some t → ∃ b a, coordinate b a = k ∧
        mappingTarget mappings governedAt b a = some t) ∧
      (∀ k, mapHas entries k = true → mapHas es k = true) ∧
      ∀ p ∈ pairs, ∃ t, mappingTarget mappings governedAt p.1 p.2.sourceAccountId = some t ∧
        mapGet es (pairKey p) = some t := by
  intro pairs
  induction pairs with
  | nil =>
    intro entries es hgood h
    simp only [resolveTargetsLoop, Sum.inr.injEq] at h
    subst h
    exact ⟨hgood, fun k hk => hk, fun p hp => by simp at hp⟩
  | cons p rest ih =>
    intro entries es hgood h
    obtain ⟨book, balance⟩ := p
    simp only [resolveTargetsLoop] at h
    split at h
    · cases h
    · rename_i target htarget
      have hmt := (resolveTarget_inr_iff _ _ _ _ _).mp htarget
      have hgood' : ∀ k t, mapGet (mapSet entries (coordinate book balance.sourceAccountId) target) k =
          some t → ∃ b a, coordinate b a = k ∧ mappingTarget mappings governedAt b a = some t := by
        intro k t hk
        by_cases hkk : coordinate book balance.sourceAccountId = k
        · subst hkk
          rw [mapGet_mapSet_self] at hk
          cases hk
          exact ⟨book, balance.sourceAccountId, rfl, hmt⟩
        · rw [mapGet_mapSet_ne _ _ hkk] at hk
          exact hgood k t hk
      obtain ⟨hg2, hmono, hall⟩ := ih _ es hgood' h
      refine ⟨hg2, ?_, ?_⟩
      · intro k hk
        apply hmono
        rw [mapHas_mapSet]; simp [hk]
      · intro q hq
        rcases List.mem_cons.mp hq with rfl | hq
        · refine ⟨target, hmt, ?_⟩
          have hhas : mapHas (mapSet entries (coordinate book balance.sourceAccountId) target)
              (coordinate book balance.sourceAccountId) = true := by
            rw [mapHas_mapSet]; simp
          obtain ⟨t', ht'⟩ := mapGet_ne_none_of_mapHas (hmono _ hhas)
          obtain ⟨b, a, hba, hmt'⟩ := hg2 _ t' ht'
          obtain ⟨hb, ha⟩ := coordinate_injective hba
          subst hb ha
          rw [hmt] at hmt'
          cases hmt'
          exact ht'
        · exact hall q hq

/-- The loop of lines 2111 to 2117 ends with diagnostics exactly when some balance has no one mapping,
and then the diagnostics are those of the missing mapping. -/
theorem resolveTargetsLoop_inl_iff (mappings : List ConsolidationAccountMapping)
    (governedAt : Instant) :
    ∀ (pairs : List (BookId × ConsolidationSourceBalance)) (entries : List (String × AccountId))
      (d : List SemanticDiagnostic),
      resolveTargetsLoop mappings governedAt entries pairs = .inl d ↔
        ∃ p ∈ pairs, mappingTarget mappings governedAt p.1 p.2.sourceAccountId = none ∧
          d = [mappingsDiagnostic] := by
  intro pairs
  induction pairs with
  | nil => intro entries d; simp [resolveTargetsLoop]
  | cons p rest ih =>
    intro entries d
    obtain ⟨book, balance⟩ := p
    simp only [resolveTargetsLoop]
    cases hr : resolveTarget mappings governedAt book balance.sourceAccountId with
    | inl diags =>
      have := (resolveTarget_inl_iff _ _ _ _ _).mp hr
      simp only [Sum.inl.injEq]
      constructor
      · intro hd
        exact ⟨(book, balance), by simp, this.1, hd ▸ this.2⟩
      · rintro ⟨q, hq, h1, h2⟩
        rw [h2]; exact this.2
    | inr target =>
      have hmt := (resolveTarget_inr_iff _ _ _ _ _).mp hr
      simp only
      rw [ih]
      constructor
      · rintro ⟨q, hq, h1, h2⟩
        exact ⟨q, List.mem_cons_of_mem _ hq, h1, h2⟩
      · rintro ⟨q, hq, h1, h2⟩
        rcases List.mem_cons.mp hq with rfl | hq
        · rw [hmt] at h1; cases h1
        · exact ⟨q, hq, h1, h2⟩

/-! ## The loop that resolves the rates -/

section Rates

variable (rules : List ConsolidationTranslationRule) (gv : ConsolidationValuationPolicy)
  (governedAt : Instant) (throughOn : LocalDate) (commodityId : CommodityId)
  (targets : List (String × AccountId))

/-- An iteration of the rates loop goes through exactly when the coordinate is new and the rate resolves, and it records that rate. -/
theorem rateStep_inr_iff (entries es' : List (String × ExactRational))
    (p : BookId × ConsolidationSourceBalance) :
    rateStep rules gv governedAt throughOn commodityId targets entries p = .ok (.inr es') ↔
      mapHas entries (pairKey p) = false ∧ ∃ r,
        resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 = .ok (.inr r) ∧
        es' = mapSet entries (pairKey p) r := by
  unfold rateStep
  by_cases hm : mapHas entries (coordinate p.1 p.2.sourceAccountId) = true
  · have hm' : mapHas entries (pairKey p) = true := hm
    simp only [hm, ↓reduceIte]
    constructor
    · intro h; cases h
    · rintro ⟨hf, -⟩; rw [hm'] at hf; cases hf
  · have hmf : mapHas entries (coordinate p.1 p.2.sourceAccountId) = false :=
      Bool.eq_false_iff.mpr hm
    rw [ite_of_not hm]
    cases hr : resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 with
    | error e => simp [hmf, pairKey]
    | ok o =>
      cases o with
      | inl d => simp [hmf, pairKey]
      | inr r =>
        simp only [Except.ok.injEq, Sum.inr.injEq]
        constructor
        · intro h; exact ⟨hmf, r, rfl, h.symm⟩
        · rintro ⟨-, r', hr', he⟩
          cases hr'
          exact he.symm

/-- An iteration of the rates loop is refused exactly when the coordinate is a duplicate or the rate resolves to diagnostics. -/
theorem rateStep_inl_iff (entries : List (String × ExactRational)) (d : List SemanticDiagnostic)
    (p : BookId × ConsolidationSourceBalance) :
    rateStep rules gv governedAt throughOn commodityId targets entries p = .ok (.inl d) ↔
      (mapHas entries (pairKey p) = true ∧ d = [duplicateSourceAccountDiagnostic]) ∨
      (mapHas entries (pairKey p) = false ∧
        resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 = .ok (.inl d)) := by
  unfold rateStep
  by_cases hm : mapHas entries (coordinate p.1 p.2.sourceAccountId) = true
  · have hm' : mapHas entries (pairKey p) = true := hm
    simp only [hm, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq, hm', true_and]
    constructor
    · intro h; exact Or.inl h.symm
    · rintro (h | ⟨h, -⟩)
      · exact h.symm
      · cases h
  · have hmf : mapHas entries (coordinate p.1 p.2.sourceAccountId) = false :=
      Bool.eq_false_iff.mpr hm
    have hmf' : mapHas entries (pairKey p) = false := hmf
    rw [ite_of_not hm]
    cases hr : resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 with
    | error e => simp [hmf']
    | ok o =>
      cases o with
      | inl d' => simp [hmf']
      | inr r => simp [hmf']

/-- An iteration of the rates loop throws exactly when the coordinate is new and the rate throws. -/
theorem rateStep_error_iff (entries : List (String × ExactRational)) (e : ConsolidationErr)
    (p : BookId × ConsolidationSourceBalance) :
    rateStep rules gv governedAt throughOn commodityId targets entries p = .error e ↔
      mapHas entries (pairKey p) = false ∧
        resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 = .error e := by
  unfold rateStep
  by_cases hm : mapHas entries (coordinate p.1 p.2.sourceAccountId) = true
  · have hm' : mapHas entries (pairKey p) = true := hm
    simp only [hm, ↓reduceIte, reduceCtorEq, false_iff, not_and]
    intro h; rw [hm'] at h; cases h
  · have hmf : mapHas entries (coordinate p.1 p.2.sourceAccountId) = false :=
      Bool.eq_false_iff.mpr hm
    have hmf' : mapHas entries (pairKey p) = false := hmf
    rw [ite_of_not hm]
    cases hr : resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 with
    | error e' => simp [hmf']
    | ok o => cases o <;> simp [hmf']

/-- What the loop of lines 2118 to 2125 leaves when it ends without a diagnostic: the coordinates are
all distinct and new, each balance's coordinate maps to its resolved rate, and every earlier entry
stays. -/
theorem resolveRatesLoop_inr :
    ∀ (pairs : List (BookId × ConsolidationSourceBalance)) (entries er : List (String × ExactRational)),
      resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pairs =
        .ok (.inr er) →
      (∀ k, mapHas entries k = true → mapGet er k = mapGet entries k) ∧
      (pairs.map pairKey).Nodup ∧ (∀ p ∈ pairs, mapHas entries (pairKey p) = false) ∧
      ∀ p ∈ pairs, ∃ r, resolveRate rules gv governedAt throughOn commodityId targets p.1 p.2 =
        .ok (.inr r) ∧ mapGet er (pairKey p) = some r := by
  intro pairs
  induction pairs with
  | nil =>
    intro entries er h
    simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at h
    subst h
    exact ⟨fun _ _ => rfl, List.nodup_nil, fun p hp => by simp at hp, fun p hp => by simp at hp⟩
  | cons p rest ih =>
    intro entries er h
    simp only [resolveRatesLoop] at h
    split at h
    · cases h
    · cases h
    · rename_i es' hstep
      obtain ⟨hfresh, r, hr, hes'⟩ := (rateStep_inr_iff rules gv governedAt throughOn commodityId
        targets entries es' p).mp hstep
      obtain ⟨ha, hb, hc, hd⟩ := ih es' er h
      subst hes'
      have hhas : mapHas (mapSet entries (pairKey p) r) (pairKey p) = true := by
        rw [mapHas_mapSet]; simp
      refine ⟨?_, ?_, ?_, ?_⟩
      · intro k hk
        have hk' : mapHas (mapSet entries (pairKey p) r) k = true := by
          rw [mapHas_mapSet]; simp [hk]
        rw [ha k hk']
        have hne : pairKey p ≠ k := fun hkk => by rw [hkk] at hfresh; rw [hfresh] at hk; cases hk
        exact mapGet_mapSet_ne _ _ hne
      · refine List.nodup_cons.mpr ⟨?_, hb⟩
        intro hmem
        obtain ⟨q, hq, hqk⟩ := List.mem_map.mp hmem
        have := hc q hq
        rw [hqk] at this
        rw [this] at hhas; cases hhas
      · intro q hq
        rcases List.mem_cons.mp hq with rfl | hq
        · exact hfresh
        · have := hc q hq
          rw [mapHas_mapSet] at this
          simp only [Bool.or_eq_false_iff] at this
          exact this.2
      · intro q hq
        rcases List.mem_cons.mp hq with rfl | hq
        · refine ⟨r, hr, ?_⟩
          rw [ha _ hhas, mapGet_mapSet_self]
        · exact hd q hq

/-- The rates loop over two lists is the loop over the first followed by the loop over the second. -/
theorem resolveRatesLoop_append (pre post : List (BookId × ConsolidationSourceBalance)) :
    ∀ (entries : List (String × ExactRational)),
      resolveRatesLoop rules gv governedAt throughOn commodityId targets entries (pre ++ post) =
        match resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pre with
        | .error e => .error e
        | .ok (.inl d) => .ok (.inl d)
        | .ok (.inr em) =>
          resolveRatesLoop rules gv governedAt throughOn commodityId targets em post := by
  induction pre with
  | nil => intro entries; simp [resolveRatesLoop]
  | cons p rest ih =>
    intro entries
    simp only [List.cons_append, resolveRatesLoop]
    cases rateStep rules gv governedAt throughOn commodityId targets entries p with
    | error e => rfl
    | ok o =>
      cases o with
      | inl d => rfl
      | inr es' => exact ih es'

/-- The loop ends with diagnostics exactly when, after some balances that go through, one balance
is a duplicate or does not resolve. -/
theorem resolveRatesLoop_inl_iff (pairs : List (BookId × ConsolidationSourceBalance))
    (entries : List (String × ExactRational)) (d : List SemanticDiagnostic) :
    resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pairs =
        .ok (.inl d) ↔
      ∃ pre p post em, pairs = pre ++ p :: post ∧
        resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pre =
          .ok (.inr em) ∧
        rateStep rules gv governedAt throughOn commodityId targets em p = .ok (.inl d) := by
  induction pairs generalizing entries with
  | nil => simp [resolveRatesLoop]
  | cons p rest ih =>
    simp only [resolveRatesLoop]
    cases hs : rateStep rules gv governedAt throughOn commodityId targets entries p with
    | error e =>
      simp only [reduceCtorEq, false_iff, not_exists, not_and]
      intro pre q post em hpq hpre hq
      cases pre with
      | nil =>
        simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at hpre
        subst hpre
        simp only [List.nil_append, List.cons.injEq] at hpq
        obtain ⟨rfl, -⟩ := hpq
        rw [hs] at hq; cases hq
      | cons q0 pre0 =>
        simp only [List.cons_append, List.cons.injEq] at hpq
        obtain ⟨rfl, -⟩ := hpq
        simp only [resolveRatesLoop] at hpre
        rw [hs] at hpre; cases hpre
    | ok o =>
      cases o with
      | inl d0 =>
        simp only [Except.ok.injEq, Sum.inl.injEq]
        constructor
        · intro h
          exact ⟨[], p, rest, entries, rfl, by simp [resolveRatesLoop], hs ▸ h ▸ rfl⟩
        · rintro ⟨pre, q, post, em, hpq, hpre, hq⟩
          cases pre with
          | nil =>
            simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at hpre
            subst hpre
            simp only [List.nil_append, List.cons.injEq] at hpq
            obtain ⟨rfl, -⟩ := hpq
            rw [hs] at hq
            exact Sum.inl.inj (Except.ok.inj hq)
          | cons q0 pre0 =>
            simp only [List.cons_append, List.cons.injEq] at hpq
            obtain ⟨rfl, -⟩ := hpq
            simp only [resolveRatesLoop] at hpre
            rw [hs] at hpre; cases hpre
      | inr es' =>
        simp only
        rw [ih]
        constructor
        · rintro ⟨pre, q, post, em, hpq, hpre, hq⟩
          exact ⟨p :: pre, q, post, em, by simp [hpq], by simp [resolveRatesLoop, hs, hpre], hq⟩
        · rintro ⟨pre, q, post, em, hpq, hpre, hq⟩
          cases pre with
          | nil =>
            simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at hpre
            subst hpre
            simp only [List.nil_append, List.cons.injEq] at hpq
            obtain ⟨rfl, -⟩ := hpq
            rw [hs] at hq; cases hq
          | cons q0 pre0 =>
            simp only [List.cons_append, List.cons.injEq] at hpq
            obtain ⟨rfl, hpq⟩ := hpq
            simp only [resolveRatesLoop, hs] at hpre
            exact ⟨pre0, q, post, em, hpq, hpre, hq⟩

/-- The loop throws exactly when, after some balances that go through, one balance's iteration
throws. -/
theorem resolveRatesLoop_error_iff (pairs : List (BookId × ConsolidationSourceBalance))
    (entries : List (String × ExactRational)) (e : ConsolidationErr) :
    resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pairs =
        .error e ↔
      ∃ pre p post em, pairs = pre ++ p :: post ∧
        resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pre =
          .ok (.inr em) ∧
        rateStep rules gv governedAt throughOn commodityId targets em p = .error e := by
  induction pairs generalizing entries with
  | nil => simp [resolveRatesLoop]
  | cons p rest ih =>
    simp only [resolveRatesLoop]
    cases hs : rateStep rules gv governedAt throughOn commodityId targets entries p with
    | error e0 =>
      simp only [Except.error.injEq]
      constructor
      · intro h
        exact ⟨[], p, rest, entries, rfl, by simp [resolveRatesLoop], hs ▸ h ▸ rfl⟩
      · rintro ⟨pre, q, post, em, hpq, hpre, hq⟩
        cases pre with
        | nil =>
          simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at hpre
          subst hpre
          simp only [List.nil_append, List.cons.injEq] at hpq
          obtain ⟨rfl, -⟩ := hpq
          rw [hs] at hq
          exact Except.error.inj hq
        | cons q0 pre0 =>
          simp only [List.cons_append, List.cons.injEq] at hpq
          obtain ⟨rfl, -⟩ := hpq
          simp only [resolveRatesLoop] at hpre
          rw [hs] at hpre; cases hpre
    | ok o =>
      cases o with
      | inl d0 =>
        simp only [reduceCtorEq, false_iff, not_exists, not_and]
        intro pre q post em hpq hpre hq
        cases pre with
        | nil =>
          simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at hpre
          subst hpre
          simp only [List.nil_append, List.cons.injEq] at hpq
          obtain ⟨rfl, -⟩ := hpq
          rw [hs] at hq; cases hq
        | cons q0 pre0 =>
          simp only [List.cons_append, List.cons.injEq] at hpq
          obtain ⟨rfl, -⟩ := hpq
          simp only [resolveRatesLoop] at hpre
          rw [hs] at hpre; cases hpre
      | inr es' =>
        simp only
        rw [ih]
        constructor
        · rintro ⟨pre, q, post, em, hpq, hpre, hq⟩
          exact ⟨p :: pre, q, post, em, by simp [hpq], by simp [resolveRatesLoop, hs, hpre], hq⟩
        · rintro ⟨pre, q, post, em, hpq, hpre, hq⟩
          cases pre with
          | nil =>
            simp only [resolveRatesLoop, Except.ok.injEq, Sum.inr.injEq] at hpre
            subst hpre
            simp only [List.nil_append, List.cons.injEq] at hpq
            obtain ⟨rfl, -⟩ := hpq
            rw [hs] at hq; cases hq
          | cons q0 pre0 =>
            simp only [List.cons_append, List.cons.injEq] at hpq
            obtain ⟨rfl, hpq⟩ := hpq
            simp only [resolveRatesLoop, hs] at hpre
            exact ⟨pre0, q, post, em, hpq, hpre, hq⟩

end Rates

/-! ## The identifiers the compilation derives -/

/-- The error of a derived identifier failing `identifier`'s tests. -/
def canonErr : ConsolidationErr := .canonical .canonicalIdentityConflict

/-- What the laws assume about the identifiers the compilation derives from its own identifier
(`accounting.ts` lines 2138 to 2161): either the set of admitted errors `E` includes the failure of
`identifier`'s tests, or the identifier is ASCII, so that appending ASCII text never fails them. -/
def DerivedIdsOk (E : ConsolidationErr → Prop) (id : ConsolidationCompilationId) : Prop :=
  E canonErr ∨ ∀ c ∈ id.value.toList, c.toNat < 128

/-- A refused identifier is refused with the identity conflict. -/
theorem identifier_error_eq {Kind : String} {s : String} {c : CanonicalErr}
    (h : identifier Kind s = .error c) : c = .canonicalIdentityConflict := by
  unfold identifier at h
  split_ifs at h <;> (cases h; rfl)

/-- A tag between hyphens and a number is a safe ASCII suffix. -/
theorem safeAsciiSuffix_tag (tag : String)
    (htag : ∀ c ∈ ("-" ++ tag ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false) (n : Nat) :
    SafeAsciiSuffix ("-" ++ tag ++ "-" ++ toString n) :=
  safeAsciiSuffix_append_nat htag n

/-- A derived posting identifier is built, or its failure is an admitted error. -/
theorem derivedPostingId_spec {E : ConsolidationErr → Prop} {requestId : ConsolidationCompilationId}
    (hw : requestId.WF) (hid : DerivedIdsOk E requestId) (tag : String) (n : Nat)
    (htag : ∀ c ∈ ("-" ++ tag ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false) :
    Spec E (derivedPostingId requestId tag n) fun _ => True := by
  refine ⟨fun _ _ => trivial, fun e he => ?_⟩
  unfold derivedPostingId postingId at he
  obtain ⟨code, hcode, rfl⟩ := liftCanonical_error_iff.mp he
  have hcode' := identifier_error_eq hcode
  subst hcode'
  rcases hid with h | hascii
  · exact h
  · exfalso
    obtain ⟨out, hout, -⟩ := identifier_append_ascii_ok (Kind := "Posting") hw
      (safeAsciiSuffix_tag tag htag n) hascii
    rw [hout] at hcode
    cases hcode

/-- The derived journal identifier is built, or its failure is an admitted error. -/
theorem derivedJournalId_spec {E : ConsolidationErr → Prop} {requestId : ConsolidationCompilationId}
    (hw : requestId.WF) (hid : DerivedIdsOk E requestId) :
    Spec E (liftCanonical (journalId (requestId.value ++ "-journal"))) fun _ => True := by
  refine ⟨fun _ _ => trivial, fun e he => ?_⟩
  unfold journalId at he
  obtain ⟨code, hcode, rfl⟩ := liftCanonical_error_iff.mp he
  have hcode' := identifier_error_eq hcode
  subst hcode'
  rcases hid with h | hascii
  · exact h
  · exfalso
    obtain ⟨out, hout, -⟩ := identifier_append_ascii_ok (Kind := "JournalTransaction") hw
      safeAsciiSuffix_journal hascii
    rw [hout] at hcode
    cases hcode

/-- The tag `source` is ASCII without control characters. -/
theorem tag_source :
    ∀ c ∈ ("-" ++ "source" ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false := by
  intro c hc
  simp at hc
  rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide
/-- The tag `parent-equity` is ASCII without control characters. -/
theorem tag_parent :
    ∀ c ∈ ("-" ++ "parent-equity" ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false := by
  intro c hc
  simp at hc
  rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
    decide
/-- The tag `nci` is ASCII without control characters. -/
theorem tag_nci :
    ∀ c ∈ ("-" ++ "nci" ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false := by
  intro c hc
  simp at hc
  rcases hc with rfl | rfl | rfl | rfl | rfl <;> decide
/-- The tag `translation` is ASCII without control characters. -/
theorem tag_translation :
    ∀ c ∈ ("-" ++ "translation" ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false := by
  intro c hc
  simp at hc
  rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide
/-- The tag `elimination` is ASCII without control characters. -/
theorem tag_elimination :
    ∀ c ∈ ("-" ++ "elimination" ++ "-").toList, c.toNat < 128 ∧ isControlChar c = false := by
  intro c hc
  simp at hc
  rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide

/-! ## The postings of one source's balances -/

theorem spec_netAssets {E : ConsolidationErr → Prop} (hE : E limitErr)
    (cls : ConsolidationBalanceClassification) {netAssets translated : ExactRational}
    (hn : netAssets.WF) (ht : translated.WF) :
    Spec E (if cls != .equity then liftNum (netAssets.add translated) else .ok netAssets)
      fun na => na.WF ∧ na.toRat = netAssets.toRat + (if cls != .equity then translated.toRat else 0) := by
  by_cases h : (cls != .equity) = true
  · simp only [h, ↓reduceIte]
    exact spec_add hE hn ht
  · simp only [h, Bool.false_eq_true, ↓reduceIte, add_zero]
    exact Spec.ok ⟨hn, rfl⟩

/-- The postings of a source's balances are each the amount times its rate times the factor, on its mapped account, and the net assets are the sum of the non-equity ones, or the stage throws only for an admitted error. -/
theorem compileSourceBalances_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    {requestId : ConsolidationCompilationId} (hw : requestId.WF) (hid : DerivedIdsOk E requestId)
    (commodityId : CommodityId) (T : List (String × AccountId)) (R : List (String × ExactRational))
    (book : BookId) {factor : ExactRational} (hf : factor.WF) :
    ∀ (balances : List ConsolidationSourceBalance) (ordinal : Nat) (netAssets : ExactRational),
      (∀ b ∈ balances, b.WF) → (∀ b ∈ balances, (rateAt R book b).WF) → netAssets.WF →
      Spec E (compileSourceBalances requestId commodityId T R book factor ordinal netAssets balances)
        fun out => out.1 = ordinal + balances.length ∧ out.2.1.WF ∧
          out.2.1.toRat = netAssets.toRat +
            ((balances.filter fun b => b.classification != .equity).map
              fun b => b.amount.toRat * (rateAt R book b).toRat).sum ∧
          out.2.2.map (fun p => p.exactBookValue.toRat) =
            balances.map (fun b => b.amount.toRat * (rateAt R book b).toRat * factor.toRat) ∧
          (∀ p ∈ out.2.2, p.exactBookValue.WF ∧ p.units = p.exactBookValue ∧
            p.unitsCommodityId = commodityId ∧ p.costBasis = none) ∧
          out.2.2.map (fun p => p.accountId) = balances.map (targetAt T book) := by
  intro balances
  induction balances with
  | nil =>
    intro ordinal netAssets _ _ hn
    simp only [compileSourceBalances]
    exact Spec.ok ⟨by simp, hn, by simp, by simp, by simp, by simp⟩
  | cons balance rest ih =>
    intro ordinal netAssets hb hrates hn
    have hb0 : balance.WF := hb balance (by simp)
    have hr0 : (rateAt R book balance).WF := hrates balance (by simp)
    have hbrest : ∀ b ∈ rest, b.WF := fun b hm => hb b (by simp [hm])
    have hrrest : ∀ b ∈ rest, (rateAt R book b).WF := fun b hm => hrates b (by simp [hm])
    unfold compileSourceBalances
    simp only
    split
    · rename_i e heq
      exact Spec.err ((spec_mul hE hb0.amount hr0).2 e heq)
    rename_i translatedAmount heq1
    have h1 := (spec_mul hE hb0.amount hr0).1 translatedAmount heq1
    split
    · rename_i e heq
      exact Spec.err ((spec_mul hE h1.1 hf).2 e heq)
    rename_i amount heq2
    have h2 := (spec_mul hE h1.1 hf).1 amount heq2
    split
    · rename_i e heq
      exact Spec.err ((spec_netAssets hE balance.classification hn h1.1).2 e heq)
    rename_i nextNetAssets heq3
    have h3 := (spec_netAssets hE balance.classification hn h1.1).1 nextNetAssets heq3
    split
    · rename_i e heq
      exact Spec.err ((derivedPostingId_spec hw hid "source" (ordinal + 1) tag_source).2 e heq)
    rename_i pid heq4
    split
    · rename_i e heq
      exact Spec.err ((ih (ordinal + 1) nextNetAssets hbrest hrrest h3.1).2 e heq)
    rename_i endOrdinal endNetAssets tail heq5
    obtain ⟨hp1, hp2, hp3, hp4, hp5, hp6⟩ := (ih (ordinal + 1) nextNetAssets hbrest hrrest h3.1).1
      _ heq5
    simp only at hp1 hp2 hp3 hp4 hp5 hp6
    refine Spec.ok ⟨?_, hp2, ?_, ?_, ?_, ?_⟩
    · simp only [List.length_cons]; omega
    · rw [hp3, h3.2, h1.2]
      by_cases hc : (balance.classification != ConsolidationBalanceClassification.equity) = true
      · simp only [hc, ↓reduceIte, List.filter_cons, List.map_cons, List.sum_cons]; ring
      · simp only [hc, Bool.false_eq_true, ↓reduceIte, List.filter_cons, add_zero]
    · simp only [List.map_cons, hp4, h2.2, h1.2]
    · intro p hp
      rcases List.mem_cons.mp hp with rfl | hp
      · exact ⟨h2.1, rfl, rfl, rfl⟩
      · exact hp5 p hp
    · simp only [List.map_cons, hp6]

/-- A condition that holds picks the first branch. -/
theorem ite_pos' {α : Type} {c : Prop} [Decidable c] {a b : α} (h : c) :
    (if c then a else b) = a := by simp [h]

/-! ## The non-controlling interest -/

theorem spec_mul_negate {E : ConsolidationErr → Prop} (hE : E limitErr) {a b : ExactRational}
    (ha : a.WF) (hb : b.WF) :
    Spec E ((liftNum (a.multiply b)).map ExactRational.negate)
      fun c => c.WF ∧ c.toRat = -(a.toRat * b.toRat) := by
  have hs := spec_mul hE ha hb
  cases h : liftNum (a.multiply b) with
  | error e => exact Spec.err (hs.2 e h)
  | ok c =>
    have hc := hs.1 c h
    exact Spec.ok ⟨ExactRational.negate_wf hc.1, by rw [ExactRational.negate_toRat, hc.2]⟩

/-- The postings of a partially owned full-consolidation source for its non-controlling interest
(`accounting.ts` lines 2140 to 2148): none unless the method is full and the ownership share is below
one; otherwise two postings, the parent's equity for the negative of the interest and the interest
itself, which are equal and opposite, the interest being the fair value of the source or the
negative of its translated net assets times the share outside the parent. -/
def NciOut (commodityId : CommodityId) (policy : ConsolidationPolicy) (source : ConsolidationSource)
    (ordinal : Nat) (translatedNetAssets : ExactRational) (out : Nat × List ExactPreparedPosting) :
    Prop :=
  ((source.method == .full && source.ownershipShare.compare rationalOne == .lt) = false →
      out = (ordinal, [])) ∧
  ((source.method == .full && source.ownershipShare.compare rationalOne == .lt) = true →
    out.1 = ordinal + 2 ∧ ∃ nci : ExactRational, nci.WF ∧
      nci.toRat = (if source.nonControllingInterestMethod == some .fairValue then
          (source.nonControllingInterestFairValue.getD ExactRational.zero).toRat
        else -(translatedNetAssets.toRat * (1 - source.ownershipShare.toRat))) ∧
      out.2.map (fun p => p.exactBookValue.toRat) = [-nci.toRat, nci.toRat] ∧
      out.2.map (fun p => p.accountId) =
        [policy.parentAttributableEquityAccountId, policy.nonControllingInterestAccountId] ∧
      ∀ p ∈ out.2, p.exactBookValue.WF ∧ p.units = p.exactBookValue ∧
        p.unitsCommodityId = commodityId ∧ p.costBasis = none)

/-- The postings for the non-controlling interest are none, or two equal and opposite ones for the stated interest, or the stage throws only for an admitted error. -/
theorem compileNciPostings_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    {requestId : ConsolidationCompilationId} (hw : requestId.WF) (hid : DerivedIdsOk E requestId)
    (commodityId : CommodityId) (policy : ConsolidationPolicy) (source : ConsolidationSource)
    (ordinal : Nat) {translatedNetAssets : ExactRational} (hsrc : source.WF)
    (hn : translatedNetAssets.WF) :
    Spec E (compileNciPostings requestId commodityId policy source ordinal translatedNetAssets)
      (NciOut commodityId policy source ordinal translatedNetAssets) := by
  unfold compileNciPostings
  by_cases hc : (source.method == .full && source.ownershipShare.compare rationalOne == .lt) = true
  · rw [ite_pos' hc]
    simp only
    -- the interest
    have hnci : Spec E (if source.nonControllingInterestMethod == some .fairValue then
        .ok (source.nonControllingInterestFairValue.getD ExactRational.zero)
        else match liftNum (rationalOne.subtract source.ownershipShare) with
          | .error e => .error e
          | .ok minorityShare =>
            (liftNum (translatedNetAssets.multiply minorityShare)).map ExactRational.negate)
        fun nci => nci.WF ∧ nci.toRat = (if source.nonControllingInterestMethod == some .fairValue then
          (source.nonControllingInterestFairValue.getD ExactRational.zero).toRat
          else -(translatedNetAssets.toRat * (1 - source.ownershipShare.toRat))) := by
      by_cases hfv : (source.nonControllingInterestMethod == some .fairValue) = true
      · rw [ite_pos' hfv, ite_pos' hfv]
        refine Spec.ok ?_
        cases hv : source.nonControllingInterestFairValue with
        | none => exact ⟨ExactRational.zero_wf, rfl⟩
        | some v => exact ⟨hsrc.nonControllingInterestFairValue v hv, rfl⟩
      · rw [ite_of_not hfv, ite_of_not hfv]
        have hs := spec_sub hE rationalOne_wf hsrc.ownershipShare
        split
        · rename_i e heq
          exact Spec.err (hs.2 e heq)
        · rename_i minorityShare heq
          have hm := hs.1 minorityShare heq
          refine Spec.mono (spec_mul_negate hE hn hm.1) ?_
          intro nci hnci
          refine ⟨hnci.1, ?_⟩
          rw [hnci.2, hm.2, rationalOne_toRat]
    split
    · rename_i e heq
      exact Spec.err (hnci.2 e heq)
    · rename_i nci heq
      have hn' := hnci.1 nci heq
      split
      · rename_i e heq2
        exact Spec.err ((derivedPostingId_spec hw hid "parent-equity" (ordinal + 1)
          tag_parent).2 e heq2)
      · rename_i pidParent heq2
        split
        · rename_i e heq3
          exact Spec.err ((derivedPostingId_spec hw hid "nci" (ordinal + 1 + 1) tag_nci).2 e heq3)
        · rename_i pidNci heq3
          refine Spec.ok ⟨fun h => ?_, fun _ => ⟨rfl, nci, hn'.1, hn'.2, ?_, ?_, ?_⟩⟩
          · rw [hc] at h; cases h
          · simp [ExactRational.negate_toRat]
          · rfl
          · intro p hp
            simp only [List.mem_cons, List.not_mem_nil, or_false] at hp
            rcases hp with rfl | rfl
            · exact ⟨ExactRational.negate_wf hn'.1, rfl, rfl, rfl⟩
            · exact ⟨hn'.1, rfl, rfl, rfl⟩
  · rw [ite_of_not hc]
    refine Spec.ok ⟨fun _ => rfl, fun h => absurd h hc⟩

/-- The factor of a constructible source is constructible. -/
theorem sourceFactor_wf {source : ConsolidationSource} (h : source.WF) : (sourceFactor source).WF := by
  unfold sourceFactor
  split
  · exact rationalOne_wf
  · exact h.ownershipShare

/-- The sum of constructible values returns their exact total or throws only for the size limit. -/
theorem spec_accountingSum {E : ConsolidationErr → Prop} (hE : E limitErr) {values : List ExactRational}
    (hw : ∀ v ∈ values, v.WF) :
    Spec E (liftNum (accountingSum values))
      fun t => t.WF ∧ t.toRat = (values.map ExactRational.toRat).sum := by
  refine ⟨fun v hv => accountingSum_ok hw (liftNum_ok_iff.mp hv), fun e he => ?_⟩
  obtain ⟨code, hcode, rfl⟩ := liftNum_error_iff.mp he
  rw [accountingSum_error hw hcode]
  exact hE

/-- What the postings of one source are (`accounting.ts` lines 2128 to 2154): the postings of its
balances in the order of `sortBalances`, each the amount times its rate times the factor, booked to
its mapped account; then the postings of the non-controlling interest; then, when what is posted so
far is not zero, one posting of the negative of it to the translation adjustment account. All of it
adds up to zero. -/
def SourceOut (commodityId : CommodityId) (policy : ConsolidationPolicy)
    (T : List (String × AccountId)) (R : List (String × ExactRational))
    (source : ConsolidationSource) (ordinal : Nat) (out : Nat × List ExactPreparedPosting) : Prop :=
  ∃ (bps nps tps : List ExactPreparedPosting) (translatedNetAssets : ExactRational) (ordN : Nat),
    out.2 = bps ++ nps ++ tps ∧ translatedNetAssets.WF ∧
    translatedNetAssets.toRat =
      (((sortBalances source.balances).filter fun b => b.classification != .equity).map
        fun b => b.amount.toRat * (rateAt R source.bookId b).toRat).sum ∧
    bps.map (fun p => p.exactBookValue.toRat) =
      (sortBalances source.balances).map
        (fun b => b.amount.toRat * (rateAt R source.bookId b).toRat * (sourceFactor source).toRat) ∧
    bps.map (fun p => p.accountId) = (sortBalances source.balances).map (targetAt T source.bookId) ∧
    NciOut commodityId policy source (ordinal + source.balances.length) translatedNetAssets
      (ordN, nps) ∧
    (tps = [] ∨ ∃ tr, tps = [tr] ∧ tr.accountId = policy.translationAdjustmentAccountId ∧
      tr.exactBookValue.toRat = -(((bps ++ nps).map fun p => p.exactBookValue.toRat).sum)) ∧
    (out.2.map fun p => p.exactBookValue.toRat).sum = 0 ∧
    ∀ p ∈ out.2, p.exactBookValue.WF ∧ p.units = p.exactBookValue ∧
      p.unitsCommodityId = commodityId ∧ p.costBasis = none

/-- The postings of one source are those of `SourceOut` and add up to zero, or the stage throws only for an admitted error. -/
theorem compileSource_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    {requestId : ConsolidationCompilationId} (hw : requestId.WF) (hid : DerivedIdsOk E requestId)
    (commodityId : CommodityId) (policy : ConsolidationPolicy) (T : List (String × AccountId))
    (R : List (String × ExactRational)) (ordinal : Nat) (source : ConsolidationSource)
    (hsrc : source.WF) (hR : ∀ b ∈ source.balances, (rateAt R source.bookId b).WF) :
    Spec E (compileSource requestId commodityId policy T R ordinal source)
      (SourceOut commodityId policy T R source ordinal) := by
  have hfac : (sourceFactor source).WF := sourceFactor_wf hsrc
  have hbal : ∀ b ∈ sortBalances source.balances, b.WF := fun b hb =>
    hsrc.balances b ((sortBalances_perm _).subset hb)
  have hrates : ∀ b ∈ sortBalances source.balances, (rateAt R source.bookId b).WF := fun b hb =>
    hR b ((sortBalances_perm _).subset hb)
  have hs1 := compileSourceBalances_spec hE hw hid commodityId T R source.bookId hfac
    (sortBalances source.balances) ordinal ExactRational.zero hbal hrates ExactRational.zero_wf
  unfold compileSource
  simp only
  change Spec E (match compileSourceBalances requestId commodityId T R source.bookId
      (sourceFactor source) ordinal ExactRational.zero (sortBalances source.balances) with
    | .error e => .error e
    | .ok (ordAfterBalances, translatedNetAssets, balancePostings) =>
      match compileNciPostings requestId commodityId policy source ordAfterBalances
          translatedNetAssets with
      | .error e => .error e
      | .ok (ordAfterNci, nciPostings) =>
        match liftNum (accountingSum
            ((balancePostings ++ nciPostings).map (·.exactBookValue))) with
        | .error e => .error e
        | .ok sourceTranslatedTotal =>
          if !sourceTranslatedTotal.isZero then
            match derivedPostingId requestId "translation" (ordAfterNci + 1) with
            | .error e => .error e
            | .ok pidTrans =>
              .ok (ordAfterNci + 1,
                (balancePostings ++ nciPostings) ++
                  [{ id := pidTrans, accountId := policy.translationAdjustmentAccountId,
                     units := sourceTranslatedTotal.negate, unitsCommodityId := commodityId,
                     exactBookValue := sourceTranslatedTotal.negate, costBasis := none }])
          else .ok (ordAfterNci, balancePostings ++ nciPostings))
    (SourceOut commodityId policy T R source ordinal)
  split
  · rename_i e heq
    exact Spec.err (hs1.2 e heq)
  rename_i ordB translatedNetAssets balancePostings heq1
  obtain ⟨hb1, hb2, hb3, hb4, hb5, hb6⟩ := hs1.1 _ heq1
  simp only at hb1 hb2 hb3 hb4 hb5 hb6
  have hordB : ordB = ordinal + source.balances.length := by
    rw [hb1, (sortBalances_perm source.balances).length_eq]
  have hs2 := compileNciPostings_spec hE hw hid commodityId policy source ordB hsrc hb2
  split
  · rename_i e heq
    exact Spec.err (hs2.2 e heq)
  rename_i ordN nciPostings heq2
  have h2 := hs2.1 _ heq2
  have hnciWF : ∀ p ∈ nciPostings, p.exactBookValue.WF ∧ p.units = p.exactBookValue ∧
      p.unitsCommodityId = commodityId ∧ p.costBasis = none := by
    by_cases hc : (source.method == .full && source.ownershipShare.compare rationalOne == .lt) = true
    · intro p hp
      obtain ⟨-, nci, -, -, -, -, hall⟩ := h2.2 hc
      exact hall p hp
    · have hf : (source.method == .full && source.ownershipShare.compare rationalOne == .lt) = false :=
        Bool.eq_false_iff.mpr hc
      have := h2.1 hf
      simp only [Prod.mk.injEq] at this
      intro p hp; rw [this.2] at hp; cases hp
  have hvals : ∀ v ∈ (balancePostings ++ nciPostings).map (·.exactBookValue), v.WF := by
    intro v hv
    obtain ⟨p, hp, rfl⟩ := List.mem_map.mp hv
    rcases List.mem_append.mp hp with hp | hp
    · exact (hb5 p hp).1
    · exact (hnciWF p hp).1
  have hs3 := spec_accountingSum hE hvals
  split
  · rename_i e heq
    exact Spec.err (hs3.2 e heq)
  rename_i total heq3
  have h3 := hs3.1 _ heq3
  have hsumeq : total.toRat = ((balancePostings ++ nciPostings).map fun p => p.exactBookValue.toRat).sum := by
    rw [h3.2, List.map_map]; rfl
  have hnciSum : (nciPostings.map fun p => p.exactBookValue.toRat).sum = 0 := by
    by_cases hc : (source.method == .full && source.ownershipShare.compare rationalOne == .lt) = true
    · obtain ⟨-, nci, -, -, hv, -⟩ := h2.2 hc
      rw [hv]; simp
    · have hf : (source.method == .full && source.ownershipShare.compare rationalOne == .lt) = false :=
        Bool.eq_false_iff.mpr hc
      have := h2.1 hf
      simp only [Prod.mk.injEq] at this
      rw [this.2]; simp
  have hb3' : translatedNetAssets.toRat =
      (((sortBalances source.balances).filter fun b => b.classification != .equity).map
        fun b => b.amount.toRat * (rateAt R source.bookId b).toRat).sum := by
    rw [hb3, ExactRational.zero_toRat, zero_add]
  have hnciOut : NciOut commodityId policy source (ordinal + source.balances.length)
      translatedNetAssets (ordN, nciPostings) := by
    rw [← hordB]; exact h2
  by_cases hz : (!total.isZero) = true
  · simp only [hz, ↓reduceIte]
    split
    · rename_i e heq
      exact Spec.err ((derivedPostingId_spec hw hid "translation" (ordN + 1) tag_translation).2 e heq)
    · rename_i pidTrans heq4
      refine Spec.ok ⟨balancePostings, nciPostings,
        [{ id := pidTrans, accountId := policy.translationAdjustmentAccountId,
           units := total.negate, unitsCommodityId := commodityId,
           exactBookValue := total.negate, costBasis := none }], translatedNetAssets, ordN,
        rfl, hb2, hb3', hb4, hb6, hnciOut, Or.inr ⟨_, rfl, rfl, ?_⟩, ?_, ?_⟩
      · simp only [ExactRational.negate_toRat, hsumeq]
      · simp only [List.map_append, List.sum_append, List.map_cons, List.map_nil, List.sum_cons,
          List.sum_nil, ExactRational.negate_toRat, add_zero]
        rw [List.map_append, List.sum_append] at hsumeq
        linarith
      · intro p hp
        simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hp
        rcases hp with (hp | hp) | rfl
        · exact hb5 p hp
        · exact hnciWF p hp
        · exact ⟨ExactRational.negate_wf h3.1, rfl, rfl, rfl⟩
  · have hz' : total.isZero = true := by simpa using hz
    simp only [hz, Bool.false_eq_true, ↓reduceIte]
    have hzero : total.toRat = 0 := (ExactRational.isZero_iff h3.1).mp hz'
    refine Spec.ok ⟨balancePostings, nciPostings, [], translatedNetAssets, ordN,
      (List.append_nil _).symm, hb2, hb3', hb4, hb6, hnciOut, Or.inl rfl, ?_, ?_⟩
    · rw [← hzero, hsumeq]
    · intro p hp
      simp only [List.mem_append] at hp
      rcases hp with hp | hp
      · exact hb5 p hp
      · exact hnciWF p hp

/-! ## All the sources, the eliminations and the draft -/

/-- What the postings of the sources are, in the order the loop of lines 2128 to 2154 takes them:
the postings of each source in turn (`SourceOut`), all of them adding up to zero. -/
def SourcesOut (commodityId : CommodityId) (policy : ConsolidationPolicy)
    (T : List (String × AccountId)) (R : List (String × ExactRational))
    (sources : List ConsolidationSource) (out : Nat × List ExactPreparedPosting) : Prop :=
  ∃ chunks : List (List ExactPreparedPosting),
    List.Forall₂ (fun s c => ∃ ord ord', SourceOut commodityId policy T R s ord (ord', c))
      sources chunks ∧
    out.2 = chunks.flatten ∧ (out.2.map fun p => p.exactBookValue.toRat).sum = 0 ∧
    ∀ p ∈ out.2, p.exactBookValue.WF ∧ p.units = p.exactBookValue ∧
      p.unitsCommodityId = commodityId ∧ p.costBasis = none

/-- The postings of the sources are those of each source in turn and add up to zero, or the loop throws only for an admitted error. -/
theorem compileSourcesLoop_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    {requestId : ConsolidationCompilationId} (hw : requestId.WF) (hid : DerivedIdsOk E requestId)
    (commodityId : CommodityId) (policy : ConsolidationPolicy) (T : List (String × AccountId))
    (R : List (String × ExactRational)) :
    ∀ (sources : List ConsolidationSource) (ordinal : Nat),
      (∀ s ∈ sources, s.WF) → (∀ s ∈ sources, ∀ b ∈ s.balances, (rateAt R s.bookId b).WF) →
      Spec E (compileSourcesLoop requestId commodityId policy T R ordinal sources)
        (SourcesOut commodityId policy T R sources) := by
  intro sources
  induction sources with
  | nil =>
    intro ordinal _ _
    simp only [compileSourcesLoop]
    exact Spec.ok ⟨[], List.Forall₂.nil, by simp, by simp, fun p hp => by simp at hp⟩
  | cons source rest ih =>
    intro ordinal hs hR
    have hs0 : source.WF := hs source (by simp)
    have hsrest : ∀ s ∈ rest, s.WF := fun s hm => hs s (by simp [hm])
    have hR0 : ∀ b ∈ source.balances, (rateAt R source.bookId b).WF := fun b hb =>
      hR source (by simp) b hb
    have hRrest : ∀ s ∈ rest, ∀ b ∈ s.balances, (rateAt R s.bookId b).WF := fun s hm b hb =>
      hR s (by simp [hm]) b hb
    unfold compileSourcesLoop
    split
    · rename_i e heq
      exact Spec.err ((compileSource_spec hE hw hid commodityId policy T R ordinal source hs0 hR0).2 e heq)
    · rename_i nextOrdinal headPostings heq1
      have h1 := (compileSource_spec hE hw hid commodityId policy T R ordinal source hs0 hR0).1
        _ heq1
      split
      · rename_i e heq
        exact Spec.err ((ih nextOrdinal hsrest hRrest).2 e heq)
      · rename_i endOrdinal tailPostings heq2
        obtain ⟨chunks, hch, hflat, hsum, hall⟩ := (ih nextOrdinal hsrest hRrest).1 _ heq2
        simp only at hflat hsum hall
        obtain ⟨bps, nps, tps, tna, ordN, hout, hna1, hna2, hb1, hb2, hnci, htr, hsum1, hall1⟩ := h1
        simp only at hout hsum1 hall1
        refine Spec.ok ⟨headPostings :: chunks, List.Forall₂.cons ⟨ordinal, nextOrdinal, ?_⟩ hch,
          ?_, ?_, ?_⟩
        · exact ⟨bps, nps, tps, tna, ordN, hout, hna1, hna2, hb1, hb2, hnci, htr, hsum1, hall1⟩
        · simp [hflat]
        · simp only [List.map_append, List.sum_append, hsum1, hsum, add_zero]
        · intro p hp
          rcases List.mem_append.mp hp with hp | hp
          · exact hall1 p hp
          · exact hall p hp

/-- What the postings of the eliminations are: one for each, in the order given, with the
elimination's amount and target account. -/
def ElimsOut (commodityId : CommodityId) (elims : List ConsolidationElimination)
    (ps : List ExactPreparedPosting) : Prop :=
  ps.map (fun p => p.exactBookValue) = elims.map (·.amount) ∧
  ps.map (fun p => p.accountId) = elims.map (·.targetAccountId) ∧
  ∀ p ∈ ps, p.units = p.exactBookValue ∧ p.unitsCommodityId = commodityId ∧ p.costBasis = none

/-- The postings of the eliminations are one for each with its amount and target, or the loop throws only for an admitted error. -/
theorem compileEliminationsLoop_spec {E : ConsolidationErr → Prop}
    {requestId : ConsolidationCompilationId} (hw : requestId.WF) (hid : DerivedIdsOk E requestId)
    (commodityId : CommodityId) :
    ∀ (elims : List ConsolidationElimination) (ordinal : Nat),
      Spec E (compileEliminationsLoop requestId commodityId ordinal elims)
        (ElimsOut commodityId elims) := by
  intro elims
  induction elims with
  | nil =>
    intro ordinal
    simp only [compileEliminationsLoop]
    exact Spec.ok ⟨by simp, by simp, fun p hp => by simp at hp⟩
  | cons elim rest ih =>
    intro ordinal
    unfold compileEliminationsLoop
    simp only
    split
    · rename_i e heq
      exact Spec.err ((derivedPostingId_spec hw hid "elimination" (ordinal + 1)
        tag_elimination).2 e heq)
    · rename_i pid heq1
      split
      · rename_i e heq
        exact Spec.err ((ih (ordinal + 1)).2 e heq)
      · rename_i tail heq2
        obtain ⟨h1, h2, h3⟩ := (ih (ordinal + 1)).1 _ heq2
        refine Spec.ok ⟨?_, ?_, ?_⟩
        · simp only [List.map_cons, h1]
        · simp only [List.map_cons, h2]
        · intro p hp
          rcases List.mem_cons.mp hp with rfl | hp
          · exact ⟨rfl, rfl, rfl⟩
          · exact h3 p hp

/-! ## The draft -/

/-- What the draft is (`accounting.ts` lines 2126 to 2163): the postings of the sources in the order
of their books (`SourcesOut`) and then of the eliminations in their order (`ElimsOut`) make the
posting of one adjustment journal dated the day it is through, whose exact book values add up to zero
(the sum returns, and it is zero); and one effect, the compilation with its hash. -/
def DraftOut (commodityId : CommodityId) (policy : ConsolidationPolicy)
    (T : List (String × AccountId)) (R : List (String × ExactRational))
    (request : ConsolidationRequest) (d : AccountingDraft) : Prop :=
  ∃ (chunks : List (List ExactPreparedPosting)) (elimPs : List ExactPreparedPosting)
    (jid : JournalId) (total : ExactRational),
    List.Forall₂ (fun s c => ∃ ord ord', SourceOut commodityId policy T R s ord (ord', c))
      (sortSources request.sources) chunks ∧
    ElimsOut commodityId (sortEliminations request.eliminations) elimPs ∧
    accountingSum ((chunks.flatten ++ elimPs).map fun p => p.exactBookValue) = .ok total ∧
    total.isZero = true ∧
    ((chunks.flatten ++ elimPs).map fun p => p.exactBookValue.toRat).sum = 0 ∧
    (∀ p ∈ chunks.flatten ++ elimPs, p.exactBookValue.WF ∧ p.units = p.exactBookValue ∧
      p.unitsCommodityId = commodityId ∧ p.costBasis = none) ∧
    d = { journals := [compilationJournal request jid (chunks.flatten ++ elimPs)],
          effects := [.consolidationCompilation (compilationEffect request policy)] }

/-- The draft is the one journal and effect of `DraftOut`, never an unbalanced rejection, or the stage throws only for an admitted error. -/
theorem compileDraft_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (commodityId : CommodityId) (request : ConsolidationRequest) (policy : ConsolidationPolicy)
    (T : List (String × AccountId)) (R : List (String × ExactRational))
    (hw : request.id.WF) (hid : DerivedIdsOk E request.id)
    (hsrc : ∀ s ∈ request.sources, s.WF)
    (hR : ∀ s ∈ request.sources, ∀ b ∈ s.balances, (rateAt R s.bookId b).WF)
    (hel : ∀ e ∈ request.eliminations, e.amount.WF)
    (hsum : (request.eliminations.map fun e => e.amount.toRat).sum = 0) :
    Spec E (compileDraft commodityId request policy T R)
      fun r => ∃ d, r = .draft d ∧ DraftOut commodityId policy T R request d := by
  have hsrc' : ∀ s ∈ sortSources request.sources, s.WF := fun s hm =>
    hsrc s ((sortSources_perm _).subset hm)
  have hR' : ∀ s ∈ sortSources request.sources, ∀ b ∈ s.balances, (rateAt R s.bookId b).WF :=
    fun s hm b hb => hR s ((sortSources_perm _).subset hm) b hb
  have hs1 := compileSourcesLoop_spec hE hw hid commodityId policy T R (sortSources request.sources)
    0 hsrc' hR'
  unfold compileDraft
  split
  · rename_i e heq
    exact Spec.err (hs1.2 e heq)
  rename_i ordAfterSources sourcePostings heq1
  obtain ⟨chunks, hch, hflat, hsum1, hall1⟩ := hs1.1 _ heq1
  simp only at hflat hsum1 hall1
  have he := compileEliminationsLoop_spec (E := E) hw hid commodityId
    (sortEliminations request.eliminations) ordAfterSources
  split
  · rename_i e heq
    exact Spec.err (he.2 e heq)
  rename_i elimPostings heq2
  obtain ⟨e1, e2, e3⟩ := he.1 _ heq2
  have hepsWF : ∀ p ∈ elimPostings, p.exactBookValue.WF := by
    intro p hp
    have hm : p.exactBookValue ∈ (sortEliminations request.eliminations).map (·.amount) := by
      rw [← e1]; exact List.mem_map.mpr ⟨p, hp, rfl⟩
    obtain ⟨el, hel', hamt⟩ := List.mem_map.mp hm
    rw [← hamt]
    exact hel el ((sortEliminations_perm _).subset hel')
  have hvals : ∀ v ∈ (sourcePostings ++ elimPostings).map (·.exactBookValue), v.WF := by
    intro v hv
    obtain ⟨p, hp, rfl⟩ := List.mem_map.mp hv
    rcases List.mem_append.mp hp with hp | hp
    · exact (hall1 p hp).1
    · exact hepsWF p hp
  have hs3 := spec_accountingSum hE hvals
  split
  · rename_i e heq
    exact Spec.err (hs3.2 e heq)
  rename_i total heq3
  have h3 := hs3.1 _ heq3
  have hepsSum : (elimPostings.map fun p => p.exactBookValue.toRat).sum = 0 := by
    have h1 : (elimPostings.map fun p => p.exactBookValue.toRat) =
        (sortEliminations request.eliminations).map fun e => e.amount.toRat := by
      have := congrArg (List.map ExactRational.toRat) e1
      simpa [List.map_map, Function.comp_def] using this
    rw [h1, ((sortEliminations_perm request.eliminations).map
      (fun e => e.amount.toRat)).sum_eq, hsum]
  have hzero : total.toRat = 0 := by
    rw [h3.2, List.map_map, List.map_append, List.sum_append]
    have : (sourcePostings.map (ExactRational.toRat ∘ fun x => x.exactBookValue)).sum = 0 := hsum1
    rw [this]
    have h2 : (elimPostings.map (ExactRational.toRat ∘ fun x => x.exactBookValue)).sum = 0 := hepsSum
    rw [h2]; simp
  have hz : total.isZero = true := (ExactRational.isZero_iff h3.1).mpr hzero
  simp only [hz, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
  split
  · rename_i e heq
    exact Spec.err ((derivedJournalId_spec hw hid).2 e heq)
  rename_i jid heq4
  subst hflat
  have hsumPs : ((chunks.flatten ++ elimPostings).map fun p => p.exactBookValue.toRat).sum = 0 := by
    rw [← hzero, h3.2, List.map_map]; rfl
  refine Spec.ok ⟨_, rfl, chunks, elimPostings, jid, total, hch, ⟨e1, e2, e3⟩,
    liftNum_ok_iff.mp heq3, hz, hsumPs, ?_, rfl⟩
  intro p hp
  rcases List.mem_append.mp hp with hp | hp
  · exact hall1 p hp
  · exact ⟨hepsWF p hp, (e3 p hp).1, (e3 p hp).2.1, (e3 p hp).2.2⟩

/-! ## The whole function as the composition of its stages -/

theorem reject_ne_draft (code : SemanticDiagnosticCode) (path message : String)
    (requirements : List String) (d : AccountingDraft) :
    reject code path message requirements ≠ AccountingCalculation.draft d := by
  intro h; unfold reject at h; cases h

/-- The rejection of the bounds is not a draft. -/
theorem boundsRejection_ne_draft (d : AccountingDraft) : boundsRejection ≠ .draft d :=
  reject_ne_draft _ _ _ _ _
/-- The rejection of the lineage is not a draft. -/
theorem derivationRejection_ne_draft (d : AccountingDraft) : derivationRejection ≠ .draft d :=
  reject_ne_draft _ _ _ _ _
/-- The rejection of the sources is not a draft. -/
theorem sourcesRejection_ne_draft (d : AccountingDraft) : sourcesRejection ≠ .draft d :=
  reject_ne_draft _ _ _ _ _
/-- The rejection of the eliminations is not a draft. -/
theorem eliminationsRejection_ne_draft (d : AccountingDraft) : eliminationsRejection ≠ .draft d :=
  reject_ne_draft _ _ _ _ _
/-- The rejection of the valuation policy is not a draft. -/
theorem valuationPolicyRejection_ne_draft (d : AccountingDraft) :
    valuationPolicyRejection ≠ .draft d :=
  reject_ne_draft _ _ _ _ _
/-- The rejection of an unbalanced draft is not a draft. -/
theorem unbalancedDraftRejection_ne_draft (d : AccountingDraft) :
    unbalancedDraftRejection ≠ .draft d :=
  reject_ne_draft _ _ _ _ _

/-- `compileConsolidation` is the composition of its stages, in the order of `accounting.ts`:
the bounds (line 2033), the derivation (2034), the policy and sources (2035 to 2047), the eliminations
(2048 to 2052), the valuation policy (2060), the targets of the account mappings (2111 to 2117), the
rates (2118 to 2125) and the draft (2126 to 2163); the first stage that rejects ends it, one that
throws ends it. -/
theorem compileConsolidation_eq (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request =
      if boundsInvalid request then .ok boundsRejection
      else if derivationInvalid request then .ok derivationRejection
      else match validateSources
          (policyAt ConsolidationPolicy policies request.policyId request.policyVersion
            request.governedAt) request with
        | .error e => .error e
        | .ok none => .ok sourcesRejection
        | .ok (some policy) =>
          match eliminationsInvalid request with
          | .error e => .error e
          | .ok true => .ok eliminationsRejection
          | .ok false =>
            if globalValuationInvalid request.governedAt policy.valuationPolicy then
              .ok valuationPolicyRejection
            else
              match resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
                  (balancePairs request.sources) with
              | .inl diags => .ok (.rejected diags)
              | .inr resolvedTargets =>
                match resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                    request.governedAt request.throughOn commodityId resolvedTargets []
                    (balancePairs request.sources) with
                | .error e => .error e
                | .ok (.inl diags) => .ok (.rejected diags)
                | .ok (.inr resolvedRates) =>
                  compileDraft commodityId request policy resolvedTargets resolvedRates := rfl

/-- What a draft that `compileConsolidation` returns went through: the policy was found, the sources
and the eliminations passed their checks, the valuation policy was effective, every balance's account
and rate resolved, and `compileDraft` made the draft. -/
def CompiledThrough (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) (policy : ConsolidationPolicy)
    (T : List (String × AccountId)) (R : List (String × ExactRational)) (d : AccountingDraft) : Prop :=
  policyAt ConsolidationPolicy policies request.policyId request.policyVersion request.governedAt =
      .selected policy ∧
    boundsInvalid request = false ∧ derivationInvalid request = false ∧
    validateSources (.selected policy) request = .ok (some policy) ∧
    eliminationsInvalid request = .ok false ∧
    globalValuationInvalid request.governedAt policy.valuationPolicy = false ∧
    resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
      (balancePairs request.sources) = .inr T ∧
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .ok (.inr R) ∧
    compileDraft commodityId request policy T R = .ok (.draft d)

/-- The sources check passes only for a policy that was selected, and returns that policy. -/
theorem validateSources_some {selected : AccountingPolicySelection ConsolidationPolicy}
    {request : ConsolidationRequest} {policy : ConsolidationPolicy}
    (h : validateSources selected request = .ok (some policy)) : selected = .selected policy := by
  unfold validateSources at h
  cases selected with
  | rejected ds => simp at h
  | selected p =>
    simp only at h
    split at h
    · cases h
    · split at h
      · cases h
      · cases h
      · cases h; rfl

/-- A draft that the function returns came through every stage. -/
theorem compileConsolidation_inv {policies : List AccountingPolicy} {commodityId : CommodityId}
    {request : ConsolidationRequest} {d : AccountingDraft}
    (h : compileConsolidation policies commodityId request = .ok (.draft d)) :
    ∃ policy T R, CompiledThrough policies commodityId request policy T R d := by
  rw [compileConsolidation_eq] at h
  by_cases hb : boundsInvalid request = true
  · rw [ite_pos' hb] at h
    exact absurd (Except.ok.inj h) (boundsRejection_ne_draft d)
  rw [ite_of_not hb] at h
  by_cases hd : derivationInvalid request = true
  · rw [ite_pos' hd] at h
    exact absurd (Except.ok.inj h) (derivationRejection_ne_draft d)
  rw [ite_of_not hd] at h
  cases hv : validateSources (policyAt ConsolidationPolicy policies request.policyId
      request.policyVersion request.governedAt) request with
  | error e => rw [hv] at h; cases h
  | ok o =>
    cases o with
    | none =>
      rw [hv] at h
      exact absurd (Except.ok.inj h) (sourcesRejection_ne_draft d)
    | some policy =>
      have hsel := validateSources_some hv
      rw [hv] at h
      simp only at h
      cases he : eliminationsInvalid request with
      | error e => rw [he] at h; cases h
      | ok b =>
        cases b with
        | true =>
          rw [he] at h
          exact absurd (Except.ok.inj h) (eliminationsRejection_ne_draft d)
        | false =>
          rw [he] at h
          simp only at h
          by_cases hg : globalValuationInvalid request.governedAt policy.valuationPolicy = true
          · rw [ite_pos' hg] at h
            exact absurd (Except.ok.inj h) (valuationPolicyRejection_ne_draft d)
          rw [ite_of_not hg] at h
          cases ht : resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
              (balancePairs request.sources) with
          | inl diags => rw [ht] at h; cases h
          | inr T =>
            rw [ht] at h
            simp only at h
            cases hr : resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                request.governedAt request.throughOn commodityId T [] (balancePairs request.sources) with
            | error e => rw [hr] at h; cases h
            | ok o2 =>
              cases o2 with
              | inl diags => rw [hr] at h; cases h
              | inr R =>
                rw [hr] at h
                simp only at h
                have hv' := hv
                rw [hsel] at hv'
                exact ⟨policy, T, R, hsel, Bool.eq_false_iff.mpr hb, Bool.eq_false_iff.mpr hd, hv', he,
                  Bool.eq_false_iff.mpr hg, ht, hr, h⟩

/-! ## What a draft says about the request -/

theorem eliminationsInvalid_false_sum {request : ConsolidationRequest}
    (h : eliminationsInvalid request = .ok false) :
    ∃ total, accountingSum (request.eliminations.map (·.amount)) = .ok total ∧
      total.isZero = true := by
  unfold eliminationsInvalid at h
  simp only at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i total heq
      refine ⟨total, liftNum_ok_iff.mp heq, ?_⟩
      have := Except.ok.inj h
      simpa using this

/-- A balance of a source is among the pairs of the sources. -/
theorem mem_balancePairs {sources : List ConsolidationSource} {s : ConsolidationSource}
    {b : ConsolidationSourceBalance} (hs : s ∈ sources) (hb : b ∈ s.balances) :
    (s.bookId, b) ∈ balancePairs sources := by
  unfold balancePairs
  exact List.mem_flatMap.mpr ⟨s, hs, List.mem_map.mpr ⟨b, hb, rfl⟩⟩

/-- The rates a successful loop left are well formed. -/
theorem rates_wf {rules : List ConsolidationTranslationRule} {gv : ConsolidationValuationPolicy}
    {governedAt : Instant} {throughOn : LocalDate} {commodityId : CommodityId}
    {T : List (String × AccountId)} {R : List (String × ExactRational)}
    {sources : List ConsolidationSource}
    (hres : resolveRatesLoop rules gv governedAt throughOn commodityId T []
      (balancePairs sources) = .ok (.inr R))
    (hsrc : ∀ s ∈ sources, s.WF) :
    ∀ s ∈ sources, ∀ b ∈ s.balances, ∃ r, resolveRate rules gv governedAt throughOn commodityId T
        s.bookId b = .ok (.inr r) ∧ rateAt R s.bookId b = r ∧ r.WF := by
  intro s hs b hb
  obtain ⟨-, -, -, hd⟩ := resolveRatesLoop_inr rules gv governedAt throughOn commodityId T
    (balancePairs sources) [] R hres
  obtain ⟨r, hr, hget⟩ := hd (s.bookId, b) (mem_balancePairs hs hb)
  refine ⟨r, hr, ?_, ?_⟩
  · unfold rateAt
    have : mapGet R (coordinate s.bookId b.sourceAccountId) = some r := hget
    rw [this]; rfl
  · have hbwf : b.WF := (hsrc s hs).balances b hb
    exact ((resolveRate_spec (E := fun _ => True) trivial rules gv governedAt throughOn
      commodityId T s.bookId b hbwf).1 (.inr r) hr r rfl).1

/-- A draft `compileConsolidation` returns for a constructible request went through every stage
(`CompiledThrough`), is the draft the stage `compileDraft` makes from what they left (`DraftOut`),
every balance's rate is the one `resolveRate` gave, and the amounts of the eliminations add up to
zero. -/
theorem compileConsolidation_draft {policies : List AccountingPolicy} {commodityId : CommodityId}
    {request : ConsolidationRequest} {d : AccountingDraft} (hreq : request.WF)
    (h : compileConsolidation policies commodityId request = .ok (.draft d)) :
    ∃ policy T R, CompiledThrough policies commodityId request policy T R d ∧
      DraftOut commodityId policy T R request d ∧
      (∀ s ∈ request.sources, ∀ b ∈ s.balances, ∃ r,
        resolveRate (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
          request.throughOn commodityId T s.bookId b = .ok (.inr r) ∧
        rateAt R s.bookId b = r ∧ r.WF) ∧
      (request.eliminations.map fun e => e.amount.toRat).sum = 0 := by
  obtain ⟨policy, T, R, hc⟩ := compileConsolidation_inv h
  have hc' := hc
  obtain ⟨-, -, -, -, he, -, -, hr, hd⟩ := hc'
  have hR := rates_wf hr hreq.sources
  have hsumE : (request.eliminations.map fun e => e.amount.toRat).sum = 0 := by
    obtain ⟨total, hs, hz⟩ := eliminationsInvalid_false_sum he
    have hw : ∀ v ∈ request.eliminations.map (·.amount), v.WF := by
      intro v hv
      obtain ⟨e, he', rfl⟩ := List.mem_map.mp hv
      exact (hreq.eliminations e he').amount
    obtain ⟨hw2, hrat⟩ := accountingSum_ok hw hs
    have := (ExactRational.isZero_iff hw2).mp hz
    rw [hrat] at this
    simpa [List.map_map, Function.comp_def] using this
  have hspec := compileDraft_spec (E := fun _ => True) trivial commodityId request policy T R
    hreq.id (Or.inl trivial) hreq.sources
    (fun s hs b hb => by
      obtain ⟨r, -, h1, h2⟩ := hR s hs b hb
      rw [h1]; exact h2)
    (fun e he' => (hreq.eliminations e he').amount) hsumE
  obtain ⟨d', hd', hdo⟩ := hspec.1 _ hd
  have : d' = d := (AccountingCalculation.draft.inj hd').symm
  subst this
  exact ⟨policy, T, R, hc, hdo, hR, hsumE⟩

/-! ## The laws about a compiled draft -/

/-- The statement the translation law makes about the rate of a balance: it is a constructible
number, and it is one (same commodity, no path presented) or the exact product of the factors of the
steps, in order, of an admissible path that the balance presents (`stepFactors`), under the one
translation rule that applies, whose target is the balance's mapped account and whose valuation
policy is effective. -/
def RateFact (rules : List ConsolidationTranslationRule) (gv : ConsolidationValuationPolicy)
    (governedAt : Instant) (throughOn : LocalDate) (commodityId : CommodityId)
    (targets : List (String × AccountId)) (book : BookId) (balance : ConsolidationSourceBalance)
    (r : ExactRational) : Prop :=
  r.WF ∧
    ((balance.unitsCommodityId = commodityId ∧ balance.valuationPaths = [] ∧ r = rationalOne) ∨
      (balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
        rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
        mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
        ruleValuationInvalid governedAt gv rule.valuationPolicy = false ∧
        ∃ path ∈ balance.valuationPaths,
          MakesCandidate governedAt throughOn rule.valuationPolicy.maximumHops
            rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId path ∧
          r.toRat = (stepFactors balance.unitsCommodityId path.steps).prod))

/-- A rate that `resolveRate` returns satisfies `RateFact`. -/
theorem rateFact_of_resolveRate {rules : List ConsolidationTranslationRule}
    {gv : ConsolidationValuationPolicy} {governedAt : Instant} {throughOn : LocalDate}
    {commodityId : CommodityId} {targets : List (String × AccountId)} {book : BookId}
    {balance : ConsolidationSourceBalance} {r : ExactRational} (hb : balance.WF)
    (h : resolveRate rules gv governedAt throughOn commodityId targets book balance =
      .ok (.inr r)) :
    RateFact rules gv governedAt throughOn commodityId targets book balance r :=
  (resolveRate_spec (E := fun _ => True) trivial rules gv governedAt throughOn commodityId targets
    book balance hb).1 (.inr r) h r rfl

/-- A member of the first list of two related lists is related to a member of the second. -/
theorem forall₂_exists_mem {α β : Type} {R : α → β → Prop} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ R l₁ l₂ → ∀ a ∈ l₁, ∃ b ∈ l₂, R a b
  | _, _, List.Forall₂.nil, a, ha => by simp at ha
  | _, _, List.Forall₂.cons hab hrest, a, ha => by
    rcases List.mem_cons.mp ha with rfl | ha
    · exact ⟨_, by simp, hab⟩
    · obtain ⟨b, hb, hr⟩ := forall₂_exists_mem hrest a ha
      exact ⟨b, by simp [hb], hr⟩

/-- A member of the second list of two related lists is related to a member of the first. -/
theorem forall₂_exists_mem_right {α β : Type} {R : α → β → Prop} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ R l₁ l₂ → ∀ b ∈ l₂, ∃ a ∈ l₁, R a b
  | _, _, List.Forall₂.nil, b, hb => by simp at hb
  | _, _, List.Forall₂.cons hab hrest, b, hb => by
    rcases List.mem_cons.mp hb with rfl | hb
    · exact ⟨_, by simp, hab⟩
    · obtain ⟨a, ha, hr⟩ := forall₂_exists_mem_right hrest b hb
      exact ⟨a, by simp [ha], hr⟩

/-- If two maps agree list for list, an element has a counterpart for each element of the other list. -/
theorem exists_of_maps {α β γ δ : Type} (u : α → γ) (f : β → γ) (v : α → δ) (g : β → δ) :
    ∀ (ys : List β) (xs : List α), xs.map u = ys.map f → xs.map v = ys.map g → ∀ y ∈ ys,
      ∃ x ∈ xs, u x = f y ∧ v x = g y
  | [], xs, _, _, y, hy => by simp at hy
  | y0 :: ys, [], h, _, _, _ => by simp at h
  | y0 :: ys, x0 :: xs, h1, h2, y, hy => by
    simp only [List.map_cons, List.cons.injEq] at h1 h2
    rcases List.mem_cons.mp hy with rfl | hy
    · exact ⟨x0, by simp, h1.1, h2.1⟩
    · obtain ⟨x, hx, hxu, hxv⟩ := exists_of_maps u f v g ys xs h1.2 h2.2 y hy
      exact ⟨x, by simp [hx], hxu, hxv⟩

/-- If two maps agree list for list, filtering by the second map gives the same values. -/
theorem filter_map_of_maps {α β γ δ : Type} [DecidableEq δ] (u : α → γ) (f : β → γ)
    (v : α → δ) (g : β → δ) (a : δ) :
    ∀ (ys : List β) (xs : List α), xs.map u = ys.map f → xs.map v = ys.map g →
      (xs.filter fun x => v x == a).map u = (ys.filter fun y => g y == a).map f
  | [], xs, h, _ => by
    have : xs = [] := List.map_eq_nil_iff.mp h
    subst this; simp
  | y0 :: ys, [], h, _ => by simp at h
  | y0 :: ys, x0 :: xs, h1, h2 => by
    simp only [List.map_cons, List.cons.injEq] at h1 h2
    have ih := filter_map_of_maps u f v g a ys xs h1.2 h2.2
    by_cases hc : (g y0 == a) = true
    · have hc' : (v x0 == a) = true := by rw [h2.1]; exact hc
      simp only [List.filter_cons, hc, hc', ↓reduceIte, List.map_cons, ih, h1.1]
    · have hcf : (g y0 == a) = false := Bool.eq_false_iff.mpr hc
      have hc' : (v x0 == a) = false := by rw [h2.1]; exact hcf
      simp only [List.filter_cons, hcf, hc', Bool.false_eq_true, ↓reduceIte, ih]

/-- Each compiled entry balances: the draft is one journal whose exact book values add up to zero (the
sum returns and is zero), as numbers and as the code computes it; and the postings of each source
add up to zero on their own. -/
theorem compileConsolidation_balanced {policies : List AccountingPolicy} {commodityId : CommodityId}
    {request : ConsolidationRequest} {d : AccountingDraft} (hreq : request.WF)
    (h : compileConsolidation policies commodityId request = .ok (.draft d)) :
    d.journals.length = 1 ∧
    (∀ j ∈ d.journals, ∃ total, accountingSum (j.postings.map fun p => p.exactBookValue) = .ok total ∧
      total.isZero = true ∧ (j.postings.map fun p => p.exactBookValue.toRat).sum = 0 ∧
      ∀ p ∈ j.postings, p.exactBookValue.WF) ∧
    ∃ chunks : List (List ExactPreparedPosting),
      (∀ c ∈ chunks, (c.map fun p => p.exactBookValue.toRat).sum = 0) ∧
      ∃ jid elimPs, d.journals = [compilationJournal request jid (chunks.flatten ++ elimPs)] := by
  obtain ⟨policy, T, R, -, hdo, -, -⟩ := compileConsolidation_draft hreq h
  obtain ⟨chunks, elimPs, jid, total, hch, -, hsum, hz, hsumPs, hall, hd⟩ := hdo
  subst hd
  refine ⟨rfl, ?_, chunks, ?_, jid, elimPs, rfl⟩
  · intro j hj
    simp only [List.mem_singleton] at hj
    subst hj
    exact ⟨total, hsum, hz, hsumPs, fun p hp => (hall p hp).1⟩
  · intro c hc
    obtain ⟨s, -, ord, ord', hout⟩ := forall₂_exists_mem_right hch c hc
    obtain ⟨-, -, -, -, -, -, -, -, -, -, -, -, hsum1, -⟩ := hout
    exact hsum1

/-- The exact book values of the postings of an account, added up. -/
def accountTotal (ps : List ExactPreparedPosting) (a : AccountId) : ℚ :=
  ((ps.filter fun p => p.accountId == a).map fun p => p.exactBookValue.toRat).sum

/-- The total of an account over two lists of postings is the sum of the totals. -/
theorem accountTotal_append (xs ys : List ExactPreparedPosting) (a : AccountId) :
    accountTotal (xs ++ ys) a = accountTotal xs a + accountTotal ys a := by
  simp [accountTotal, List.filter_append, List.map_append, List.sum_append]

/-- Eliminations net to zero, and they leave the totals of the sources as they are: the postings of
the eliminations are one for each, with its amount, on its target account; the amounts add up to
zero; the postings of the sources add up to zero; and on every account the compiled total is the
total of the sources plus the amounts of the eliminations that target it. -/
theorem compileConsolidation_eliminations {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {d : AccountingDraft}
    (hreq : request.WF) (h : compileConsolidation policies commodityId request = .ok (.draft d)) :
    ∃ (jid : JournalId) (sps eps : List ExactPreparedPosting),
      d.journals = [compilationJournal request jid (sps ++ eps)] ∧
      (sps.map fun p => p.exactBookValue.toRat).sum = 0 ∧
      (eps.map fun p => p.exactBookValue) = (sortEliminations request.eliminations).map (·.amount) ∧
      (eps.map fun p => p.accountId) =
        (sortEliminations request.eliminations).map (·.targetAccountId) ∧
      (request.eliminations.map fun e => e.amount.toRat).sum = 0 ∧
      ∀ a, accountTotal (sps ++ eps) a = accountTotal sps a +
        ((request.eliminations.filter fun e => e.targetAccountId == a).map
          fun e => e.amount.toRat).sum := by
  obtain ⟨policy, T, R, -, hdo, -, hsumE⟩ := compileConsolidation_draft hreq h
  obtain ⟨chunks, elimPs, jid, total, hch, ⟨e1, e2, e3⟩, hsum, hz, hsumPs, hall, hd⟩ := hdo
  subst hd
  have hmapsum : (elimPs.map fun p => p.exactBookValue.toRat) =
      (sortEliminations request.eliminations).map fun e => e.amount.toRat := by
    have := congrArg (List.map ExactRational.toRat) e1
    simpa [List.map_map, Function.comp_def] using this
  have hepsSum : (elimPs.map fun p => p.exactBookValue.toRat).sum = 0 := by
    rw [hmapsum, ((sortEliminations_perm request.eliminations).map
      (fun e => e.amount.toRat)).sum_eq, hsumE]
  refine ⟨jid, chunks.flatten, elimPs, rfl, ?_, e1, e2, hsumE, ?_⟩
  · rw [List.map_append, List.sum_append, hepsSum] at hsumPs
    linarith
  · intro a
    rw [accountTotal_append]
    congr 1
    unfold accountTotal
    rw [filter_map_of_maps (fun p : ExactPreparedPosting => p.exactBookValue.toRat)
      (fun e : ConsolidationElimination => e.amount.toRat) (fun p => p.accountId)
      (fun e => e.targetAccountId) a (sortEliminations request.eliminations) elimPs hmapsum
      (by simpa using e2)]
    exact (((sortEliminations_perm request.eliminations).filter
      (fun e => e.targetAccountId == a)).map (fun e => e.amount.toRat)).sum_eq

/-- Every balance of every source is posted on its mapped account for its translated amount: the
rate is the one of `RateFact`, the account is the target of the one mapping the policy has for the
source book and account, and the journal has a posting on that account whose exact book value is the
balance's amount times the rate times the factor of the source. -/
theorem compileConsolidation_balance_postings {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {d : AccountingDraft}
    (hreq : request.WF) (h : compileConsolidation policies commodityId request = .ok (.draft d)) :
    ∃ (policy : ConsolidationPolicy) (T : List (String × AccountId))
      (R : List (String × ExactRational)) (jid : JournalId) (ps : List ExactPreparedPosting),
      d.journals = [compilationJournal request jid ps] ∧
      ∀ s ∈ request.sources, ∀ b ∈ s.balances,
        RateFact policy.translationRules policy.valuationPolicy request.governedAt
          request.throughOn commodityId T s.bookId b (rateAt R s.bookId b) ∧
        mappingTarget policy.accountMappings request.governedAt s.bookId b.sourceAccountId =
          some (targetAt T s.bookId b) ∧
        ∃ p ∈ ps, p.accountId = targetAt T s.bookId b ∧
          p.exactBookValue.toRat =
            b.amount.toRat * (rateAt R s.bookId b).toRat * (sourceFactor s).toRat := by
  obtain ⟨policy, T, R, hc, hdo, hR, -⟩ := compileConsolidation_draft hreq h
  obtain ⟨chunks, elimPs, jid, total, hch, -, -, -, -, -, hd⟩ := hdo
  have hc' := hc
  obtain ⟨-, -, -, -, -, -, ht, -, -⟩ := hc'
  have hT := resolveTargetsLoop_inr (sortMappings policy.accountMappings) request.governedAt
    (balancePairs request.sources) [] T (fun k t hk => by simp [mapGet] at hk) ht
  subst hd
  refine ⟨policy, T, R, jid, chunks.flatten ++ elimPs, rfl, ?_⟩
  intro s hs b hb
  obtain ⟨r, hres, hrate, hwf⟩ := hR s hs b hb
  rw [resolveRate_sortRules] at hres
  have hbwf : b.WF := (hreq.sources s hs).balances b hb
  have hfact := rateFact_of_resolveRate hbwf hres
  rw [hrate]
  obtain ⟨t, hmt, hget⟩ := hT.2.2 (s.bookId, b) (mem_balancePairs hs hb)
  have htarget : targetAt T s.bookId b = t := by
    unfold targetAt
    have : mapGet T (coordinate s.bookId b.sourceAccountId) = some t := hget
    rw [this]; rfl
  refine ⟨hfact, ?_, ?_⟩
  · rw [htarget, ← mappingTarget_sortMappings]; exact hmt
  · obtain ⟨c, hcm, ord, ord', hout⟩ := forall₂_exists_mem hch s
      ((sortSources_perm request.sources).mem_iff.mpr hs)
    obtain ⟨bps, nps, tps, tna, ordN, hcout, -, -, hb1, hb2, -, -, -, -⟩ := hout
    simp only at hcout
    have hbs : b ∈ sortBalances s.balances := (sortBalances_perm _).mem_iff.mpr hb
    obtain ⟨p, hp, hp1, hp2⟩ := exists_of_maps
      (fun p : ExactPreparedPosting => p.exactBookValue.toRat)
      (fun b : ConsolidationSourceBalance =>
        b.amount.toRat * (rateAt R s.bookId b).toRat * (sourceFactor s).toRat)
      (fun p => p.accountId) (targetAt T s.bookId) (sortBalances s.balances) bps hb1 hb2 b hbs
    refine ⟨p, ?_, hp2, ?_⟩
    · apply List.mem_append_left
      exact List.mem_flatten.mpr ⟨c, hcm, by rw [hcout]; simp [hp]⟩
    · rw [hp1, hrate]

/-- The body of a compilation does not depend on its content hash. -/
theorem bodyValue_compilation (c : ConsolidationCompilation) (hash : ContentHash) :
    bodyValue { c with contentHash := hash } = bodyValue c := by
  simp [bodyValue, withoutContentHash, CanonicalObject.members,
    ConsolidationCompilation.canonicalMembers, member]

/-- The content hash of the compilation is the hash of its body: the effect carries
`accountingHash("ConsolidationCompilation", body)` for the body of its other fields, so the kernel's
own check of an effect's hash (`validateAccountingEffectHash`) accepts it, and its fields are the
request's. -/
theorem compilationEffect_hash (request : ConsolidationRequest) (policy : ConsolidationPolicy) :
    (compilationEffect request policy).contentHash =
        accountingHash "ConsolidationCompilation" (bodyValue (compilationEffect request policy)) ∧
      validateAccountingEffectHash
        (.consolidationCompilation (compilationEffect request policy)) = .ok true := by
  have hb : bodyValue (compilationEffect request policy) = bodyValue (compilationBody request policy) :=
    bodyValue_compilation _ _
  have hh : (compilationEffect request policy).contentHash =
      accountingHash "ConsolidationCompilation" (bodyValue (compilationEffect request policy)) := by
    rw [hb]; rfl
  refine ⟨hh, ?_⟩
  unfold validateAccountingEffectHash
  simp only [AccountingEffect.typeName, AccountingEffect.bodyValue, AccountingEffect.contentHash]
  rw [hh]
  simp

/-! ## The only error is the size limit -/

theorem anySourceInvalid_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (policy : ConsolidationPolicy) (target : BookId) (governedAt : Instant) :
    ∀ sources : List ConsolidationSource, (∀ s ∈ sources, s.WF) →
      Spec E (anySourceInvalid policy target governedAt sources) fun _ => True := by
  intro sources
  induction sources with
  | nil => intro _; exact Spec.ok trivial
  | cons s rest ih =>
    intro hw
    have hs : s.WF := hw s (by simp)
    have hrest : ∀ t ∈ rest, t.WF := fun t ht => hw t (by simp [ht])
    unfold anySourceInvalid
    by_cases hh : sourceHeaderInvalid policy target governedAt s = true
    · rw [ite_pos' hh]; exact Spec.ok trivial
    · rw [ite_of_not hh]
      have hamt : ∀ v ∈ s.balances.map (·.amount), v.WF := by
        intro v hv
        obtain ⟨b, hb, rfl⟩ := List.mem_map.mp hv
        exact (hs.balances b hb).amount
      have hsum := spec_accountingSum hE hamt
      split
      · rename_i e heq
        exact Spec.err (hsum.2 e heq)
      · rename_i total heq
        by_cases hz : (!total.isZero) = true
        · rw [ite_pos' hz]; exact Spec.ok trivial
        · rw [ite_of_not hz]; exact ih hrest

/-- The sources check returns or throws only for the size limit. -/
theorem validateSources_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (selected : AccountingPolicySelection ConsolidationPolicy) (request : ConsolidationRequest)
    (hsrc : ∀ s ∈ request.sources, s.WF) :
    Spec E (validateSources selected request) fun _ => True := by
  unfold validateSources
  cases selected with
  | rejected ds => exact Spec.ok trivial
  | selected policy =>
    simp only
    by_cases hc : (request.sources.isEmpty || !decide (request.sources.map (·.bookId)).Nodup ||
        !decide (request.sources.map (·.relationshipId)).Nodup) = true
    · rw [ite_pos' hc]; exact Spec.ok trivial
    · rw [ite_of_not hc]
      have hs := anySourceInvalid_spec hE policy request.targetBookId request.governedAt
        request.sources hsrc
      split
      · rename_i e heq
        exact Spec.err (hs.2 e heq)
      · exact Spec.ok trivial
      · exact Spec.ok trivial

/-- The eliminations check returns or throws only for the size limit. -/
theorem eliminationsInvalid_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (request : ConsolidationRequest) (hel : ∀ e ∈ request.eliminations, e.WF) :
    Spec E (eliminationsInvalid request) fun _ => True := by
  unfold eliminationsInvalid
  simp only
  by_cases hc : (!decide (request.eliminations.map (·.id)).Nodup ||
      !decide (eliminationPostingKeys request.eliminations).Nodup ||
      request.eliminations.any (fun item =>
        (jsTrim item.id).length == 0 ||
        !(request.sources.map (·.bookId)).contains item.sourceBookId ||
        item.evidenceIds.isEmpty || item.sourcePostingIds.isEmpty || item.amount.isZero)) = true
  · rw [ite_pos' hc]; exact Spec.ok trivial
  · rw [ite_of_not hc]
    have hamt : ∀ v ∈ request.eliminations.map (·.amount), v.WF := by
      intro v hv
      obtain ⟨e, he, rfl⟩ := List.mem_map.mp hv
      exact (hel e he).amount
    have hsum := spec_accountingSum hE hamt
    split
    · rename_i e heq
      exact Spec.err (hsum.2 e heq)
    · exact Spec.ok trivial

/-- An iteration of the rates loop returns or throws only for the size limit. -/
theorem rateStep_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (rules : List ConsolidationTranslationRule) (gv : ConsolidationValuationPolicy)
    (governedAt : Instant) (throughOn : LocalDate) (commodityId : CommodityId)
    (targets : List (String × AccountId)) (entries : List (String × ExactRational))
    (pair : BookId × ConsolidationSourceBalance) (hb : pair.2.WF) :
    Spec E (rateStep rules gv governedAt throughOn commodityId targets entries pair)
      fun _ => True := by
  unfold rateStep
  simp only
  by_cases hm : mapHas entries (coordinate pair.1 pair.2.sourceAccountId) = true
  · rw [ite_pos' hm]; exact Spec.ok trivial
  · rw [ite_of_not hm]
    have hs := resolveRate_spec hE rules gv governedAt throughOn commodityId targets pair.1 pair.2 hb
    split
    · rename_i e heq
      exact Spec.err (hs.2 e heq)
    · exact Spec.ok trivial
    · exact Spec.ok trivial

/-- The rates loop returns or throws only for the size limit. -/
theorem resolveRatesLoop_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (rules : List ConsolidationTranslationRule) (gv : ConsolidationValuationPolicy)
    (governedAt : Instant) (throughOn : LocalDate) (commodityId : CommodityId)
    (targets : List (String × AccountId)) :
    ∀ (pairs : List (BookId × ConsolidationSourceBalance)) (entries : List (String × ExactRational)),
      (∀ p ∈ pairs, p.2.WF) →
      Spec E (resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pairs)
        fun _ => True := by
  intro pairs
  induction pairs with
  | nil => intro entries _; exact Spec.ok trivial
  | cons p rest ih =>
    intro entries hw
    have hp : p.2.WF := hw p (by simp)
    have hrest : ∀ q ∈ rest, q.2.WF := fun q hq => hw q (by simp [hq])
    unfold resolveRatesLoop
    have hs := rateStep_spec hE rules gv governedAt throughOn commodityId targets entries p hp
    split
    · rename_i e heq
      exact Spec.err (hs.2 e heq)
    · exact Spec.ok trivial
    · rename_i es heq
      exact ih es hrest

/-- The balances of constructible sources are constructible. -/
theorem balancePairs_wf {sources : List ConsolidationSource} (hs : ∀ s ∈ sources, s.WF) :
    ∀ p ∈ balancePairs sources, p.2.WF := by
  intro p hp
  unfold balancePairs at hp
  obtain ⟨s, hsm, hpm⟩ := List.mem_flatMap.mp hp
  obtain ⟨b, hb, rfl⟩ := List.mem_map.mp hpm
  exact (hs s hsm).balances b hb

/-- What the stages up to the draft leave for it: every balance has a constructible rate, and the
amounts of the eliminations add up to zero. -/
theorem stage_facts {request : ConsolidationRequest} {policy : ConsolidationPolicy}
    {commodityId : CommodityId} {T : List (String × AccountId)} {R : List (String × ExactRational)}
    (hreq : request.WF) (he : eliminationsInvalid request = .ok false)
    (hr : resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
      request.governedAt request.throughOn commodityId T [] (balancePairs request.sources) =
      .ok (.inr R)) :
    (∀ s ∈ request.sources, ∀ b ∈ s.balances, ∃ r,
      resolveRate (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
        request.throughOn commodityId T s.bookId b = .ok (.inr r) ∧
      rateAt R s.bookId b = r ∧ r.WF) ∧
    (request.eliminations.map fun e => e.amount.toRat).sum = 0 := by
  refine ⟨rates_wf hr hreq.sources, ?_⟩
  obtain ⟨total, hs, hz⟩ := eliminationsInvalid_false_sum he
  have hw : ∀ v ∈ request.eliminations.map (·.amount), v.WF := by
    intro v hv
    obtain ⟨e, he', rfl⟩ := List.mem_map.mp hv
    exact (hreq.eliminations e he').amount
  obtain ⟨hw2, hrat⟩ := accountingSum_ok hw hs
  have := (ExactRational.isZero_iff hw2).mp hz
  rw [hrat] at this
  simpa [List.map_map, Function.comp_def] using this

/-- Whatever fails to be returned is thrown only as the size limit of exact numbers (or, for an
identifier of the request that is not ASCII, as a derived identifier failing its tests, which
`DerivedIdsOk` lets the admitted errors include). -/
theorem compileConsolidation_spec {E : ConsolidationErr → Prop} (hE : E limitErr)
    (policies : List AccountingPolicy) (commodityId : CommodityId) (request : ConsolidationRequest)
    (hreq : request.WF) (hid : DerivedIdsOk E request.id) :
    Spec E (compileConsolidation policies commodityId request) fun _ => True := by
  rw [compileConsolidation_eq]
  by_cases hb : boundsInvalid request = true
  · rw [ite_pos' hb]; exact Spec.ok trivial
  rw [ite_of_not hb]
  by_cases hd : derivationInvalid request = true
  · rw [ite_pos' hd]; exact Spec.ok trivial
  rw [ite_of_not hd]
  have hvs := validateSources_spec hE (policyAt ConsolidationPolicy policies request.policyId
    request.policyVersion request.governedAt) request hreq.sources
  split
  · rename_i e heq
    exact Spec.err (hvs.2 e heq)
  · exact Spec.ok trivial
  · rename_i policy hv
    have hes := eliminationsInvalid_spec hE request hreq.eliminations
    split
    · rename_i e heq
      exact Spec.err (hes.2 e heq)
    · exact Spec.ok trivial
    · rename_i he
      by_cases hg : globalValuationInvalid request.governedAt policy.valuationPolicy = true
      · rw [ite_pos' hg]; exact Spec.ok trivial
      rw [ite_of_not hg]
      split
      · exact Spec.ok trivial
      · rename_i T ht
        have hrs := resolveRatesLoop_spec hE (sortRules policy.translationRules)
          policy.valuationPolicy request.governedAt request.throughOn commodityId T
          (balancePairs request.sources) [] (balancePairs_wf hreq.sources)
        split
        · rename_i e heq
          exact Spec.err (hrs.2 e heq)
        · exact Spec.ok trivial
        · rename_i R hr
          obtain ⟨hR, hsumE⟩ := stage_facts hreq he hr
          refine Spec.mono (compileDraft_spec hE commodityId request policy T R hreq.id hid
            hreq.sources (fun s hs b hb => by
              obtain ⟨r, -, h1, h2⟩ := hR s hs b hb
              rw [h1]; exact h2)
            (fun e he' => (hreq.eliminations e he').amount) hsumE) ?_
          intro _ _; trivial

/-! ## Errors, and the stages one by one -/

/-- The only `.error` is the size limit of exact numbers, for a request whose identifier is ASCII
(every identifier the kernel builds), and for a constructible request. -/
theorem compileConsolidation_error_limit {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {e : ConsolidationErr}
    (hreq : request.WF) (hascii : ∀ c ∈ request.id.value.toList, c.toNat < 128)
    (h : compileConsolidation policies commodityId request = .error e) :
    e = .exactNumber .representationLimitExceeded :=
  (compileConsolidation_spec (E := fun e => e = limitErr) rfl policies commodityId request hreq
    (Or.inr hascii)).2 e h

/-- For any constructible request, an `.error` is the size limit of exact numbers, or a derived
identifier failing the tests of `identifier`, and the second only when the request's identifier is
not ASCII. -/
theorem compileConsolidation_error {policies : List AccountingPolicy} {commodityId : CommodityId}
    {request : ConsolidationRequest} {e : ConsolidationErr} (hreq : request.WF)
    (h : compileConsolidation policies commodityId request = .error e) :
    e = .exactNumber .representationLimitExceeded ∨
      (e = .canonical .canonicalIdentityConflict ∧ ∃ c ∈ request.id.value.toList, 128 ≤ c.toNat) := by
  by_cases hascii : ∀ c ∈ request.id.value.toList, c.toNat < 128
  · exact Or.inl (compileConsolidation_error_limit hreq hascii h)
  · have h2 := (compileConsolidation_spec (E := fun e => e = limitErr ∨ e = canonErr) (Or.inl rfl)
      policies commodityId request hreq (Or.inl (Or.inr rfl))).2 e h
    push Not at hascii
    rcases h2 with h2 | h2
    · exact Or.inl h2
    · exact Or.inr ⟨h2, hascii⟩

/-- The policy `compileConsolidation` selects (`accounting.ts` line 2031). -/
def selectedPolicy (policies : List AccountingPolicy) (request : ConsolidationRequest) :
    AccountingPolicySelection ConsolidationPolicy :=
  policyAt ConsolidationPolicy policies request.policyId request.policyVersion request.governedAt

/-- Every way `compileConsolidation` can end, with the conditions of the stages it went through, in
the order of the stages: the first stage that rejects or throws ends it. -/
theorem compileConsolidation_cases (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    (boundsInvalid request = true ∧
        compileConsolidation policies commodityId request = .ok boundsRejection) ∨
    (boundsInvalid request = false ∧ derivationInvalid request = true ∧
        compileConsolidation policies commodityId request = .ok derivationRejection) ∨
    (boundsInvalid request = false ∧ derivationInvalid request = false ∧
      ((validateSources (selectedPolicy policies request) request = .ok none ∧
          compileConsolidation policies commodityId request = .ok sourcesRejection) ∨
       (∃ e, validateSources (selectedPolicy policies request) request = .error e ∧
          compileConsolidation policies commodityId request = .error e) ∨
       ∃ policy, validateSources (selectedPolicy policies request) request = .ok (some policy) ∧
        ((eliminationsInvalid request = .ok true ∧
            compileConsolidation policies commodityId request = .ok eliminationsRejection) ∨
         (∃ e, eliminationsInvalid request = .error e ∧
            compileConsolidation policies commodityId request = .error e) ∨
         (eliminationsInvalid request = .ok false ∧
          ((globalValuationInvalid request.governedAt policy.valuationPolicy = true ∧
              compileConsolidation policies commodityId request = .ok valuationPolicyRejection) ∨
           (globalValuationInvalid request.governedAt policy.valuationPolicy = false ∧
            ((∃ diags, resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
                (balancePairs request.sources) = .inl diags ∧
                compileConsolidation policies commodityId request = .ok (.rejected diags)) ∨
             ∃ T, resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
                (balancePairs request.sources) = .inr T ∧
              ((∃ e, resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                  request.governedAt request.throughOn commodityId T []
                  (balancePairs request.sources) = .error e ∧
                  compileConsolidation policies commodityId request = .error e) ∨
               (∃ diags, resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                  request.governedAt request.throughOn commodityId T []
                  (balancePairs request.sources) = .ok (.inl diags) ∧
                  compileConsolidation policies commodityId request = .ok (.rejected diags)) ∨
               ∃ R, resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                  request.governedAt request.throughOn commodityId T []
                  (balancePairs request.sources) = .ok (.inr R) ∧
                  compileConsolidation policies commodityId request =
                    compileDraft commodityId request policy T R)))))))) := by
  have hceq := compileConsolidation_eq policies commodityId request
  by_cases hb : boundsInvalid request = true
  · exact Or.inl ⟨hb, by rw [hceq, ite_pos' hb]⟩
  have hbf : boundsInvalid request = false := Bool.eq_false_iff.mpr hb
  rw [ite_of_not hb] at hceq
  by_cases hd : derivationInvalid request = true
  · exact Or.inr (Or.inl ⟨hbf, hd, by rw [hceq, ite_pos' hd]⟩)
  have hdf : derivationInvalid request = false := Bool.eq_false_iff.mpr hd
  rw [ite_of_not hd] at hceq
  refine Or.inr (Or.inr ⟨hbf, hdf, ?_⟩)
  cases hv : validateSources (selectedPolicy policies request) request with
  | error e =>
    refine Or.inr (Or.inl ⟨e, rfl, ?_⟩)
    unfold selectedPolicy at hv
    rw [hv] at hceq
    exact hceq
  | ok o =>
    cases o with
    | none =>
      refine Or.inl ⟨rfl, ?_⟩
      unfold selectedPolicy at hv
      rw [hv] at hceq
      exact hceq
    | some policy =>
      refine Or.inr (Or.inr ⟨policy, rfl, ?_⟩)
      unfold selectedPolicy at hv
      rw [hv] at hceq
      simp only at hceq
      cases he : eliminationsInvalid request with
      | error e =>
        refine Or.inr (Or.inl ⟨e, rfl, ?_⟩)
        rw [he] at hceq
        exact hceq
      | ok b =>
        cases b with
        | true =>
          refine Or.inl ⟨rfl, ?_⟩
          rw [he] at hceq
          exact hceq
        | false =>
          refine Or.inr (Or.inr ⟨rfl, ?_⟩)
          rw [he] at hceq
          simp only at hceq
          by_cases hg : globalValuationInvalid request.governedAt policy.valuationPolicy = true
          · refine Or.inl ⟨hg, ?_⟩
            rw [hceq, ite_pos' hg]
          have hgf : globalValuationInvalid request.governedAt policy.valuationPolicy = false :=
            Bool.eq_false_iff.mpr hg
          refine Or.inr ⟨hgf, ?_⟩
          rw [ite_of_not hg] at hceq
          cases ht : resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
              (balancePairs request.sources) with
          | inl diags =>
            refine Or.inl ⟨diags, rfl, ?_⟩
            rw [ht] at hceq
            exact hceq
          | inr T =>
            refine Or.inr ⟨T, rfl, ?_⟩
            rw [ht] at hceq
            simp only at hceq
            cases hr : resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                request.governedAt request.throughOn commodityId T [] (balancePairs request.sources) with
            | error e =>
              refine Or.inl ⟨e, rfl, ?_⟩
              rw [hr] at hceq
              exact hceq
            | ok o2 =>
              cases o2 with
              | inl diags =>
                refine Or.inr (Or.inl ⟨diags, rfl, ?_⟩)
                rw [hr] at hceq
                exact hceq
              | inr R =>
                refine Or.inr (Or.inr ⟨R, rfl, ?_⟩)
                rw [hr] at hceq
                exact hceq

/-! ## Which diagnostics the loops give -/

/-- The diagnostics `resolveRate` and the loop around it can give. -/
def rateDiagnostics : List (List SemanticDiagnostic) :=
  [[duplicateSourceAccountDiagnostic], [sameCommodityPathDiagnostic],
    [missingTranslationRuleDiagnostic], [ruleTargetMismatchDiagnostic],
    [ruleValuationPolicyDiagnostic], [noAdmissiblePathDiagnostic], [ambiguousPathRateDiagnostic]]

/-- `selectRate` refuses only for no candidate or for an ambiguous rate. -/
theorem selectRate_inl_mem {pd : Bool} {cands : List PathCandidate} {d : List SemanticDiagnostic}
    (h : selectRate pd cands = .inl d) : d = [noAdmissiblePathDiagnostic] ∨
      d = [ambiguousPathRateDiagnostic] := by
  rw [selectRate_eq] at h
  split at h
  · exact Or.inl (Sum.inl.inj h).symm
  · cases hr : rankedCandidates pd cands with
    | nil => rw [hr] at h; exact Or.inl (Sum.inl.inj h).symm
    | cons best rest =>
      rw [hr] at h
      simp only at h
      split at h
      · exact Or.inr (Sum.inl.inj h).symm
      · cases h

/-- `resolveRate` refuses only with one of the diagnostics of the stage. -/
theorem resolveRate_inl_mem {rules : List ConsolidationTranslationRule}
    {gv : ConsolidationValuationPolicy} {governedAt : Instant} {throughOn : LocalDate}
    {commodityId : CommodityId} {targets : List (String × AccountId)} {book : BookId}
    {balance : ConsolidationSourceBalance} {d : List SemanticDiagnostic}
    (h : resolveRate rules gv governedAt throughOn commodityId targets book balance =
      .ok (.inl d)) : d ∈ rateDiagnostics.tail := by
  unfold resolveRate at h
  by_cases hc : (balance.unitsCommodityId == commodityId) = true
  · rw [ite_pos' hc] at h
    by_cases hp : (!balance.valuationPaths.isEmpty) = true
    · rw [ite_pos' hp] at h
      have := Sum.inl.inj (Except.ok.inj h)
      subst this; simp [rateDiagnostics]
    · rw [ite_of_not hp] at h; cases h
  · rw [ite_of_not hc] at h
    cases hf : rules.filter (ruleApplies book balance.sourceAccountId governedAt) with
    | nil =>
      rw [hf] at h
      have := Sum.inl.inj (Except.ok.inj h)
      subst this; simp [rateDiagnostics]
    | cons rule rest =>
      cases rest with
      | cons r2 rest2 =>
        rw [hf] at h
        have := Sum.inl.inj (Except.ok.inj h)
        subst this; simp [rateDiagnostics]
      | nil =>
        rw [hf] at h
        simp only at h
        unfold resolveRateByRule at h
        simp only at h
        by_cases h1 : (mapGet targets (coordinate book balance.sourceAccountId) !=
            some rule.targetAccountId) = true
        · rw [ite_pos' h1] at h
          have := Sum.inl.inj (Except.ok.inj h)
          subst this; simp [rateDiagnostics]
        · rw [ite_of_not h1] at h
          by_cases h2 : ruleValuationInvalid governedAt gv rule.valuationPolicy = true
          · rw [ite_pos' h2] at h
            have := Sum.inl.inj (Except.ok.inj h)
            subst this; simp [rateDiagnostics]
          · rw [ite_of_not h2] at h
            split at h
            · cases h
            · rename_i candidates _
              rcases selectRate_inl_mem (Except.ok.inj h) with h3 | h3
              · rw [h3]; simp [rateDiagnostics]
              · rw [h3]; simp [rateDiagnostics]

/-- The rates loop refuses only with one of the diagnostics of the stage. -/
theorem resolveRatesLoop_inl_mem {rules : List ConsolidationTranslationRule}
    {gv : ConsolidationValuationPolicy} {governedAt : Instant} {throughOn : LocalDate}
    {commodityId : CommodityId} {targets : List (String × AccountId)}
    {entries : List (String × ExactRational)} {pairs : List (BookId × ConsolidationSourceBalance)}
    {d : List SemanticDiagnostic}
    (h : resolveRatesLoop rules gv governedAt throughOn commodityId targets entries pairs =
      .ok (.inl d)) : d ∈ rateDiagnostics := by
  obtain ⟨pre, p, post, em, -, -, hstep⟩ := (resolveRatesLoop_inl_iff rules gv governedAt throughOn
    commodityId targets pairs entries d).mp h
  rcases (rateStep_inl_iff rules gv governedAt throughOn commodityId targets em d p).mp hstep with
    ⟨-, rfl⟩ | ⟨-, hres⟩
  · simp [rateDiagnostics]
  · exact List.mem_of_mem_tail (resolveRate_inl_mem hres)

/-! ## Each rejection, and the conditions it is given under -/

/-- The first two stages passed: the bounds and the derivation. -/
def PassedStart (request : ConsolidationRequest) : Prop :=
  boundsInvalid request = false ∧ derivationInvalid request = false

/-- The policy was found and the sources passed their checks. -/
def PassedSources (policies : List AccountingPolicy) (request : ConsolidationRequest)
    (policy : ConsolidationPolicy) : Prop :=
  PassedStart request ∧
    validateSources (selectedPolicy policies request) request = .ok (some policy)

/-- The eliminations passed their checks too. -/
def PassedEliminations (policies : List AccountingPolicy) (request : ConsolidationRequest)
    (policy : ConsolidationPolicy) : Prop :=
  PassedSources policies request policy ∧ eliminationsInvalid request = .ok false

/-- The valuation policy was effective too. -/
def PassedValuation (policies : List AccountingPolicy) (request : ConsolidationRequest)
    (policy : ConsolidationPolicy) : Prop :=
  PassedEliminations policies request policy ∧
    globalValuationInvalid request.governedAt policy.valuationPolicy = false

/-- Every balance's account resolved too. -/
def PassedTargets (policies : List AccountingPolicy) (request : ConsolidationRequest)
    (policy : ConsolidationPolicy) (T : List (String × AccountId)) : Prop :=
  PassedValuation policies request policy ∧
    resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
      (balancePairs request.sources) = .inr T

/-- Every way `compileConsolidation` can end, each with all the stage conditions that lead to it. -/
def Trace (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) : Prop :=
  let r := compileConsolidation policies commodityId request
  (boundsInvalid request = true ∧ r = .ok boundsRejection) ∨
  (boundsInvalid request = false ∧ derivationInvalid request = true ∧
    r = .ok derivationRejection) ∨
  (PassedStart request ∧ validateSources (selectedPolicy policies request) request = .ok none ∧
    r = .ok sourcesRejection) ∨
  (PassedStart request ∧ ∃ e, validateSources (selectedPolicy policies request) request = .error e ∧
    r = .error e) ∨
  (∃ policy, PassedSources policies request policy ∧ eliminationsInvalid request = .ok true ∧
    r = .ok eliminationsRejection) ∨
  (∃ policy, PassedSources policies request policy ∧ ∃ e, eliminationsInvalid request = .error e ∧
    r = .error e) ∨
  (∃ policy, PassedEliminations policies request policy ∧
    globalValuationInvalid request.governedAt policy.valuationPolicy = true ∧
    r = .ok valuationPolicyRejection) ∨
  (∃ policy, PassedValuation policies request policy ∧ ∃ diags,
    resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
      (balancePairs request.sources) = .inl diags ∧ r = .ok (.rejected diags)) ∨
  (∃ policy T, PassedTargets policies request policy T ∧ ∃ e,
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .error e ∧
    r = .error e) ∨
  (∃ policy T, PassedTargets policies request policy T ∧ ∃ diags,
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .ok (.inl diags) ∧
    r = .ok (.rejected diags)) ∨
  (∃ policy T R, PassedTargets policies request policy T ∧
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .ok (.inr R) ∧
    r = compileDraft commodityId request policy T R)

/-- Every way the function can end, with the conditions of the stages that lead to it. -/
theorem compileConsolidation_trace (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) : Trace policies commodityId request := by
  unfold Trace
  simp only
  rcases compileConsolidation_cases policies commodityId request with ⟨h1, h2⟩ |
    ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩
  · exact Or.inl ⟨h1, h2⟩
  · exact Or.inr (Or.inl ⟨h1, h2, h3⟩)
  · rcases h3 with ⟨h3, h4⟩ | ⟨e, h3, h4⟩ | ⟨policy, hv, h3⟩
    · exact Or.inr (Or.inr (Or.inl ⟨⟨h1, h2⟩, h3, h4⟩))
    · exact Or.inr (Or.inr (Or.inr (Or.inl ⟨⟨h1, h2⟩, e, h3, h4⟩)))
    · rcases h3 with ⟨h3, h4⟩ | ⟨e, h3, h4⟩ | ⟨he, h3⟩
      · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl ⟨policy, ⟨⟨h1, h2⟩, hv⟩, h3, h4⟩))))
      · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
          ⟨policy, ⟨⟨h1, h2⟩, hv⟩, e, h3, h4⟩)))))
      · rcases h3 with ⟨h3, h4⟩ | ⟨hg, h3⟩
        · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
            ⟨policy, ⟨⟨⟨h1, h2⟩, hv⟩, he⟩, h3, h4⟩))))))
        · rcases h3 with ⟨diags, h3, h4⟩ | ⟨T, ht, h3⟩
          · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
              ⟨policy, ⟨⟨⟨⟨h1, h2⟩, hv⟩, he⟩, hg⟩, diags, h3, h4⟩)))))))
          · rcases h3 with ⟨e, h3, h4⟩ | ⟨diags, h3, h4⟩ | ⟨R, h3, h4⟩
            · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
                ⟨policy, T, ⟨⟨⟨⟨⟨h1, h2⟩, hv⟩, he⟩, hg⟩, ht⟩, e, h3, h4⟩))))))))
            · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
                ⟨policy, T, ⟨⟨⟨⟨⟨h1, h2⟩, hv⟩, he⟩, hg⟩, ht⟩, diags, h3, h4⟩)))))))))
            · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
                ⟨policy, T, R, ⟨⟨⟨⟨⟨h1, h2⟩, hv⟩, he⟩, hg⟩, ht⟩, h3, h4⟩)))))))))

/-- `compileDraft` returns the unbalanced rejection or a draft. -/
theorem compileDraft_result {commodityId : CommodityId} {request : ConsolidationRequest}
    {policy : ConsolidationPolicy} {T : List (String × AccountId)}
    {R : List (String × ExactRational)} {X : AccountingCalculation}
    (h : compileDraft commodityId request policy T R = .ok X) :
    X = unbalancedDraftRejection ∨ ∃ d, X = .draft d := by
  unfold compileDraft at h
  split at h
  · cases h
  · rename_i ordAfterSources sourcePostings _
    split at h
    · cases h
    · rename_i elimPostings _
      split at h
      · cases h
      · rename_i total _
        by_cases hz : (!total.isZero) = true
        · rw [ite_pos' hz] at h
          exact Or.inl (Except.ok.inj h).symm
        · rw [ite_of_not hz] at h
          split at h
          · cases h
          · rename_i jid _
            exact Or.inr ⟨_, (Except.ok.inj h).symm⟩

/-- `Trace` with the diagnostics of the loops and the result of the last stage said. -/
def Trace' (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) : Prop :=
  let r := compileConsolidation policies commodityId request
  (boundsInvalid request = true ∧ r = .ok boundsRejection) ∨
  (boundsInvalid request = false ∧ derivationInvalid request = true ∧
    r = .ok derivationRejection) ∨
  (PassedStart request ∧ validateSources (selectedPolicy policies request) request = .ok none ∧
    r = .ok sourcesRejection) ∨
  (PassedStart request ∧ ∃ e, validateSources (selectedPolicy policies request) request = .error e ∧
    r = .error e) ∨
  (∃ policy, PassedSources policies request policy ∧ eliminationsInvalid request = .ok true ∧
    r = .ok eliminationsRejection) ∨
  (∃ policy, PassedSources policies request policy ∧ ∃ e, eliminationsInvalid request = .error e ∧
    r = .error e) ∨
  (∃ policy, PassedEliminations policies request policy ∧
    globalValuationInvalid request.governedAt policy.valuationPolicy = true ∧
    r = .ok valuationPolicyRejection) ∨
  (∃ policy, PassedValuation policies request policy ∧
    (∃ p ∈ balancePairs request.sources,
      mappingTarget policy.accountMappings request.governedAt p.1 p.2.sourceAccountId = none) ∧
    r = .ok (.rejected [mappingsDiagnostic])) ∨
  (∃ policy T, PassedTargets policies request policy T ∧ ∃ e,
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .error e ∧
    r = .error e) ∨
  (∃ policy T, PassedTargets policies request policy T ∧ ∃ diags, diags ∈ rateDiagnostics ∧
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .ok (.inl diags) ∧
    r = .ok (.rejected diags)) ∨
  (∃ policy T R, PassedTargets policies request policy T ∧
    resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy request.governedAt
      request.throughOn commodityId T [] (balancePairs request.sources) = .ok (.inr R) ∧
    r = compileDraft commodityId request policy T R ∧
    ((∃ e, r = .error e) ∨ r = .ok unbalancedDraftRejection ∨ ∃ d, r = .ok (.draft d)))

/-- The same ways, with the diagnostics of the loops and the result of the last stage said. -/
theorem compileConsolidation_trace' (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) : Trace' policies commodityId request := by
  have h := compileConsolidation_trace policies commodityId request
  unfold Trace at h
  unfold Trace'
  simp only at h ⊢
  rcases h with h | h | h | h | h | h | h | h | h | h | h
  · exact Or.inl h
  · exact Or.inr (Or.inl h)
  · exact Or.inr (Or.inr (Or.inl h))
  · exact Or.inr (Or.inr (Or.inr (Or.inl h)))
  · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl h))))
  · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl h)))))
  · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl h))))))
  · obtain ⟨policy, hp, diags, hl, hr⟩ := h
    obtain ⟨p, hpm, hmt, hd⟩ := (resolveTargetsLoop_inl_iff _ _ _ _ _).mp hl
    refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨policy, hp, ⟨p, hpm, (mappingTarget_sortMappings _ _ _ _) ▸ hmt⟩, ?_⟩)))))))
    rw [hr, hd]
  · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl h))))))))
  · obtain ⟨policy, T, hp, diags, hl, hr⟩ := h
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨policy, T, hp, diags, resolveRatesLoop_inl_mem hl, hl, hr⟩)))))))))
  · obtain ⟨policy, T, R, hp, hl, hr⟩ := h
    refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
      ⟨policy, T, R, hp, hl, hr, ?_⟩)))))))))
    cases hcd : compileDraft commodityId request policy T R with
    | error e => exact Or.inl ⟨e, by rw [hr, hcd]⟩
    | ok X =>
      rcases compileDraft_result hcd with h | ⟨d, hd⟩
      · exact Or.inr (Or.inl (by rw [hr, hcd, h]))
      · exact Or.inr (Or.inr ⟨d, by rw [hr, hcd, hd]⟩)

/-- Closes a leaf of `Trace'` that is not the reason asked about: two different results. -/
local macro "contra" : tactic => `(tactic| (exfalso; simp_all [boundsRejection, derivationRejection,
  sourcesRejection, eliminationsRejection, valuationPolicyRejection, unbalancedDraftRejection,
  mappingsDiagnostic, duplicateSourceAccountDiagnostic, sameCommodityPathDiagnostic,
  missingTranslationRuleDiagnostic, ruleTargetMismatchDiagnostic, ruleValuationPolicyDiagnostic,
  noAdmissiblePathDiagnostic, ambiguousPathRateDiagnostic, reject, diagnostic]; done))

/-- The diagnostics of the rates stage are none of the diagnostics of the other stages. -/
theorem rateDiag_ne {ds : List SemanticDiagnostic} (hD : ds ∈ rateDiagnostics) :
    AccountingCalculation.rejected ds ≠ boundsRejection ∧
    AccountingCalculation.rejected ds ≠ derivationRejection ∧
    AccountingCalculation.rejected ds ≠ sourcesRejection ∧
    AccountingCalculation.rejected ds ≠ eliminationsRejection ∧
    AccountingCalculation.rejected ds ≠ valuationPolicyRejection ∧
    AccountingCalculation.rejected ds ≠ unbalancedDraftRejection ∧
    ds ≠ [mappingsDiagnostic] := by
  simp only [rateDiagnostics, List.mem_cons, List.not_mem_nil, or_false] at hD
  rcases hD with rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
    simp [boundsRejection, derivationRejection, sourcesRejection, eliminationsRejection,
      valuationPolicyRejection, unbalancedDraftRejection, mappingsDiagnostic,
      duplicateSourceAccountDiagnostic, sameCommodityPathDiagnostic,
      missingTranslationRuleDiagnostic, ruleTargetMismatchDiagnostic,
      ruleValuationPolicyDiagnostic, noAdmissiblePathDiagnostic, ambiguousPathRateDiagnostic,
      reject, diagnostic]

/-- After the bounds and the derivation, the result is that of the policy and sources stage. -/
theorem compileConsolidation_after_start {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} (h : PassedStart request) :
    compileConsolidation policies commodityId request =
      match validateSources (selectedPolicy policies request) request with
      | .error e => .error e
      | .ok none => .ok sourcesRejection
      | .ok (some policy) =>
        match eliminationsInvalid request with
        | .error e => .error e
        | .ok true => .ok eliminationsRejection
        | .ok false =>
          if globalValuationInvalid request.governedAt policy.valuationPolicy then
            .ok valuationPolicyRejection
          else
            match resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
                (balancePairs request.sources) with
            | .inl diags => .ok (.rejected diags)
            | .inr resolvedTargets =>
              match resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                  request.governedAt request.throughOn commodityId resolvedTargets []
                  (balancePairs request.sources) with
              | .error e => .error e
              | .ok (.inl diags) => .ok (.rejected diags)
              | .ok (.inr resolvedRates) =>
                compileDraft commodityId request policy resolvedTargets resolvedRates := by
  obtain ⟨hb, hd⟩ := h
  rw [compileConsolidation_eq, ite_of_not (by simp [hb]), ite_of_not (by simp [hd])]
  rfl

/-- After the sources check, the result is that of the eliminations stage. -/
theorem compileConsolidation_after_sources {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {policy : ConsolidationPolicy}
    (h : PassedSources policies request policy) :
    compileConsolidation policies commodityId request =
      match eliminationsInvalid request with
      | .error e => .error e
      | .ok true => .ok eliminationsRejection
      | .ok false =>
        if globalValuationInvalid request.governedAt policy.valuationPolicy then
          .ok valuationPolicyRejection
        else
          match resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
              (balancePairs request.sources) with
          | .inl diags => .ok (.rejected diags)
          | .inr resolvedTargets =>
            match resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
                request.governedAt request.throughOn commodityId resolvedTargets []
                (balancePairs request.sources) with
            | .error e => .error e
            | .ok (.inl diags) => .ok (.rejected diags)
            | .ok (.inr resolvedRates) =>
              compileDraft commodityId request policy resolvedTargets resolvedRates := by
  obtain ⟨hs, hv⟩ := h
  rw [compileConsolidation_after_start hs, hv]

/-- After the eliminations check, the result is that of the valuation policy stage. -/
theorem compileConsolidation_after_eliminations {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {policy : ConsolidationPolicy}
    (h : PassedEliminations policies request policy) :
    compileConsolidation policies commodityId request =
      if globalValuationInvalid request.governedAt policy.valuationPolicy then
        .ok valuationPolicyRejection
      else
        match resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
            (balancePairs request.sources) with
        | .inl diags => .ok (.rejected diags)
        | .inr resolvedTargets =>
          match resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
              request.governedAt request.throughOn commodityId resolvedTargets []
              (balancePairs request.sources) with
          | .error e => .error e
          | .ok (.inl diags) => .ok (.rejected diags)
          | .ok (.inr resolvedRates) =>
            compileDraft commodityId request policy resolvedTargets resolvedRates := by
  obtain ⟨hs, he⟩ := h
  rw [compileConsolidation_after_sources hs, he]

/-- After the valuation policy check, the result is that of the account mappings stage. -/
theorem compileConsolidation_after_valuation {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {policy : ConsolidationPolicy}
    (h : PassedValuation policies request policy) :
    compileConsolidation policies commodityId request =
      match resolveTargetsLoop (sortMappings policy.accountMappings) request.governedAt []
          (balancePairs request.sources) with
      | .inl diags => .ok (.rejected diags)
      | .inr resolvedTargets =>
        match resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
            request.governedAt request.throughOn commodityId resolvedTargets []
            (balancePairs request.sources) with
        | .error e => .error e
        | .ok (.inl diags) => .ok (.rejected diags)
        | .ok (.inr resolvedRates) =>
          compileDraft commodityId request policy resolvedTargets resolvedRates := by
  obtain ⟨he, hg⟩ := h
  rw [compileConsolidation_after_eliminations he, ite_of_not (by simp [hg])]

/-- After the account mappings, the result is that of the rates stage. -/
theorem compileConsolidation_after_targets {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {policy : ConsolidationPolicy}
    {T : List (String × AccountId)} (h : PassedTargets policies request policy T) :
    compileConsolidation policies commodityId request =
      match resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
          request.governedAt request.throughOn commodityId T [] (balancePairs request.sources) with
      | .error e => .error e
      | .ok (.inl diags) => .ok (.rejected diags)
      | .ok (.inr resolvedRates) => compileDraft commodityId request policy T resolvedRates := by
  obtain ⟨hv, ht⟩ := h
  rw [compileConsolidation_after_valuation hv, ht]

/-- The request is rejected for the bounds (`accounting.ts` line 2033) exactly when they are
exceeded. -/
theorem rejected_bounds_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request = .ok boundsRejection ↔
      boundsInvalid request = true := by
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · exact c
    all_goals try contra
    · exact absurd (Except.ok.inj (v.symm.trans h)) (rateDiag_ne hds).1
  · intro hb
    rw [compileConsolidation_eq, ite_pos' hb]

/-- The request is rejected for its lineage (`accounting.ts` line 2034) exactly when the bounds
passed and the derivation is not approved, with evidence and a parsable instant, or is not bound to
the policy and version of the request. -/
theorem rejected_derivation_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request = .ok derivationRejection ↔
      boundsInvalid request = false ∧ derivationInvalid request = true := by
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · contra
    · exact ⟨c1, c2⟩
    all_goals try contra
    · exact absurd (Except.ok.inj (v.symm.trans h)) (rateDiag_ne hds).2.1
  · rintro ⟨hb, hd⟩
    rw [compileConsolidation_eq, ite_of_not (by simp [hb]), ite_pos' hd]

/-- The request is rejected for its policy or sources (`accounting.ts` lines 2035 to 2047) exactly
when the bounds and the lineage passed and `validateSources` rejects: no one executable policy was
found, or there is no source, or two sources share a book or a relationship, or a source fails
a check of its own or its balances do not add up to zero. -/
theorem rejected_sources_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request = .ok sourcesRejection ↔
      PassedStart request ∧ validateSources (selectedPolicy policies request) request = .ok none := by
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · contra
    · contra
    · exact ⟨c1, c2⟩
    all_goals try contra
    · exact absurd (Except.ok.inj (v.symm.trans h)) (rateDiag_ne hds).2.2.1
  · rintro ⟨hs, hv⟩
    rw [compileConsolidation_after_start hs, hv]

/-- The request is rejected for its eliminations (`accounting.ts` lines 2048 to 2052) exactly when
the sources passed and `eliminationsInvalid` rejects: two eliminations share an identifier or a source
posting, or one has no identifier, no source book among the sources, no evidence, no posting or a
zero amount, or the amounts do not add up to zero. -/
theorem rejected_eliminations_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request = .ok eliminationsRejection ↔
      ∃ policy, PassedSources policies request policy ∧ eliminationsInvalid request = .ok true := by
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · contra
    · contra
    · contra
    · contra
    · exact ⟨policy, c1, c2⟩
    all_goals try contra
    · exact absurd (Except.ok.inj (v.symm.trans h)) (rateDiag_ne hds).2.2.2.1
  · rintro ⟨policy, hs, he⟩
    rw [compileConsolidation_after_sources hs, he]

/-- The request is rejected for its valuation policy (`accounting.ts` line 2060) exactly when the
eliminations passed and the policy is not yet or no longer effective at the governed instant, or
allows no hop. -/
theorem rejected_valuationPolicy_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request = .ok valuationPolicyRejection ↔
      ∃ policy, PassedEliminations policies request policy ∧
        globalValuationInvalid request.governedAt policy.valuationPolicy = true := by
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · contra
    · contra
    · contra
    · contra
    · contra
    · contra
    · exact ⟨policy, c1, c2⟩
    all_goals try contra
    · exact absurd (Except.ok.inj (v.symm.trans h)) (rateDiag_ne hds).2.2.2.2.1
  · rintro ⟨policy, hs, hg⟩
    rw [compileConsolidation_after_eliminations hs, ite_pos' hg]

/-- The request is rejected because a source balance has no one account mapping (`accounting.ts` lines
2062 to 2066 and 2111 to 2117) exactly when the valuation policy passed and some balance has none or
several mappings that apply to its source book and account. -/
theorem rejected_mappings_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request = .ok (.rejected [mappingsDiagnostic]) ↔
      ∃ policy, PassedValuation policies request policy ∧
        ∃ p ∈ balancePairs request.sources,
          mappingTarget policy.accountMappings request.governedAt p.1 p.2.sourceAccountId =
            none := by
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · contra
    · contra
    · contra
    · contra
    · contra
    · contra
    · contra
    · exact ⟨policy, c1, c2⟩
    all_goals try contra
    · exact absurd (Except.ok.inj (v.symm.trans h)) (by
        intro heq; exact (rateDiag_ne hds).2.2.2.2.2.2 (AccountingCalculation.rejected.inj heq))
  · rintro ⟨policy, hs, p, hp, hnone⟩
    rw [compileConsolidation_after_valuation hs]
    have := (resolveTargetsLoop_inl_iff (sortMappings policy.accountMappings) request.governedAt
      (balancePairs request.sources) [] [mappingsDiagnostic]).mpr
      ⟨p, hp, (mappingTarget_sortMappings _ _ _ _).trans hnone, rfl⟩
    rw [this]

/-- The request is rejected with the diagnostics `ds` of the rates stage (`accounting.ts` lines
2068 to 2125) exactly when every earlier stage passed and the loop over the balances ends with them. -/
theorem rejected_rates_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) {ds : List SemanticDiagnostic} (hD : ds ∈ rateDiagnostics) :
    compileConsolidation policies commodityId request = .ok (.rejected ds) ↔
      ∃ policy T, PassedTargets policies request policy T ∧
        resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
          request.governedAt request.throughOn commodityId T [] (balancePairs request.sources) =
          .ok (.inl ds) := by
  obtain ⟨n1, n2, n3, n4, n5, n6, n7⟩ := rateDiag_ne hD
  constructor
  · intro h
    have t := compileConsolidation_trace' policies commodityId request
    unfold Trace' at t
    simp only at t
    rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
      ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds', hds', c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
    · rw [v] at h; exact absurd (Except.ok.inj h).symm n1
    · rw [v] at h; exact absurd (Except.ok.inj h).symm n2
    · rw [v] at h; exact absurd (Except.ok.inj h).symm n3
    · rw [v] at h; cases h
    · rw [v] at h; exact absurd (Except.ok.inj h).symm n4
    · rw [v] at h; cases h
    · rw [v] at h; exact absurd (Except.ok.inj h).symm n5
    · rw [v] at h
      exact absurd (AccountingCalculation.rejected.inj (Except.ok.inj h)).symm n7
    · rw [v] at h; cases h
    · have := AccountingCalculation.rejected.inj (Except.ok.inj (v.symm.trans h))
      subst this
      exact ⟨policy, T, c1, c2⟩
    · rcases hv with ⟨e, hv⟩ | hv | ⟨d, hv⟩
      · rw [hv] at h; cases h
      · rw [hv] at h; exact absurd (Except.ok.inj h).symm n6
      · rw [hv] at h; cases (Except.ok.inj h)
  · rintro ⟨policy, T, hp, hl⟩
    rw [compileConsolidation_after_targets hp, hl]

/-- The consolidation is never rejected because the draft does not balance (`accounting.ts` line
2159): once the stages before it passed, what is posted adds up to zero, and the draft is made or a
size limit is met. -/
theorem not_rejected_unbalanced (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) (hreq : request.WF) :
    compileConsolidation policies commodityId request ≠ .ok unbalancedDraftRejection := by
  intro h
  have t := compileConsolidation_trace' policies commodityId request
  unfold Trace' at t
  simp only at t
  rcases t with ⟨c, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, c2, v⟩ | ⟨c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
    ⟨policy, c1, e, c2, v⟩ | ⟨policy, c1, c2, v⟩ | ⟨policy, c1, c2, v⟩ |
    ⟨policy, T, c1, e, c2, v⟩ | ⟨policy, T, c1, ds, hds, c2, v⟩ | ⟨policy, T, R, c1, c2, c3, hv⟩
  all_goals try contra
  · exact absurd (Except.ok.inj (v.symm.trans h)) (rateDiag_ne hds).2.2.2.2.2.1
  · obtain ⟨⟨⟨⟨⟨hb, hd⟩, hv'⟩, he⟩, hg⟩, ht⟩ := c1
    have hdraft : compileDraft commodityId request policy T R = .ok unbalancedDraftRejection := by
      rw [← c3]; exact h
    obtain ⟨hR, hsumE⟩ := stage_facts hreq he c2
    have hspec := compileDraft_spec (E := fun _ => True) trivial commodityId request policy T R
      hreq.id (Or.inl trivial) hreq.sources
      (fun s hs b hb' => by
        obtain ⟨r, -, h1, h2⟩ := hR s hs b hb'
        rw [h1]; exact h2)
      (fun e he' => (hreq.eliminations e he').amount) hsumE
    obtain ⟨d, hd2, -⟩ := hspec.1 _ hdraft
    exact unbalancedDraftRejection_ne_draft d hd2

/-! ## Why a balance's rate is refused -/

section RateReasons

variable {rules : List ConsolidationTranslationRule} {gv : ConsolidationValuationPolicy}
  {governedAt : Instant} {throughOn : LocalDate} {commodityId : CommodityId}
  {targets : List (String × AccountId)} {book : BookId} {balance : ConsolidationSourceBalance}

/-- When `resolveRate` rejects a balance (`accounting.ts` lines 2069 to 2110), and with what: the
balance is in the book's commodity and presents a path; or it is not and the rules that apply are not
exactly one; or there is one rule, and its target is not the mapped account; or its valuation policy
is not effective or not compatible; or no path is admissible, or the equally preferred paths disagree
on the rate (`selectRate`). -/
theorem resolveRate_inl_iff {d : List SemanticDiagnostic} :
    resolveRate rules gv governedAt throughOn commodityId targets book balance = .ok (.inl d) ↔
      (balance.unitsCommodityId = commodityId ∧ balance.valuationPaths ≠ [] ∧
        d = [sameCommodityPathDiagnostic]) ∨
      (balance.unitsCommodityId ≠ commodityId ∧
        (rules.filter (ruleApplies book balance.sourceAccountId governedAt)).length ≠ 1 ∧
        d = [missingTranslationRuleDiagnostic]) ∨
      (balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
        rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
        ((mapGet targets (coordinate book balance.sourceAccountId) ≠ some rule.targetAccountId ∧
            d = [ruleTargetMismatchDiagnostic]) ∨
          (mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
            ruleValuationInvalid governedAt gv rule.valuationPolicy = true ∧
            d = [ruleValuationPolicyDiagnostic]) ∨
          (mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
            ruleValuationInvalid governedAt gv rule.valuationPolicy = false ∧ ∃ cs,
            collectCandidates governedAt throughOn rule.valuationPolicy.maximumHops
              rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId
              balance.valuationPaths = .ok cs ∧
            selectRate (gv.preferDirectObservation || rule.valuationPolicy.preferDirectObservation)
              cs = .inl d))) := by
  unfold resolveRate
  by_cases hc : (balance.unitsCommodityId == commodityId) = true
  · have hce : balance.unitsCommodityId = commodityId := beq_iff_eq.mp hc
    rw [ite_pos' hc]
    by_cases hp : (!balance.valuationPaths.isEmpty) = true
    · rw [ite_pos' hp]
      have hne : balance.valuationPaths ≠ [] := by
        intro h0; rw [h0] at hp; simp at hp
      simp only [Except.ok.injEq, Sum.inl.injEq]
      constructor
      · intro h; exact Or.inl ⟨hce, hne, h.symm⟩
      · rintro (⟨-, -, h⟩ | ⟨h, -⟩ | ⟨h, -⟩)
        · exact h.symm
        · exact absurd hce h
        · exact absurd hce h
    · rw [ite_of_not hp]
      have hemp : balance.valuationPaths = [] := by simpa using hp
      simp only [Except.ok.injEq, reduceCtorEq, false_iff]
      rintro (⟨-, h, -⟩ | ⟨h, -⟩ | ⟨h, -⟩)
      · exact h hemp
      · exact h hce
      · exact h hce
  · have hne : balance.unitsCommodityId ≠ commodityId := fun h => hc (beq_iff_eq.mpr h)
    rw [ite_of_not hc]
    cases hf : rules.filter (ruleApplies book balance.sourceAccountId governedAt) with
    | nil =>
      simp only [Except.ok.injEq, Sum.inl.injEq, List.length_nil]
      constructor
      · intro h; exact Or.inr (Or.inl ⟨hne, by simp, h.symm⟩)
      · rintro (⟨h, -⟩ | ⟨-, -, h⟩ | ⟨-, rule, h, -⟩)
        · exact absurd h hne
        · exact h.symm
        · cases h
    | cons rule rest =>
      cases rest with
      | cons r2 rest2 =>
        simp only [Except.ok.injEq, Sum.inl.injEq]
        constructor
        · intro h; exact Or.inr (Or.inl ⟨hne, by simp, h.symm⟩)
        · rintro (⟨h, -⟩ | ⟨-, -, h⟩ | ⟨-, rule', h, -⟩)
          · exact absurd h hne
          · exact h.symm
          · cases h
      | nil =>
        simp only
        unfold resolveRateByRule
        simp only
        by_cases h1 : (mapGet targets (coordinate book balance.sourceAccountId) !=
            some rule.targetAccountId) = true
        · rw [ite_pos' h1]
          have h1' : mapGet targets (coordinate book balance.sourceAccountId) ≠
              some rule.targetAccountId := by simpa using h1
          simp only [Except.ok.injEq, Sum.inl.injEq]
          constructor
          · intro h; exact Or.inr (Or.inr ⟨hne, rule, rfl, Or.inl ⟨h1', h.symm⟩⟩)
          · rintro (⟨h, -⟩ | ⟨-, h, -⟩ | ⟨-, rule', h, hh⟩)
            · exact absurd h hne
            · simp at h
            · have := List.cons.inj h
              obtain ⟨rfl, -⟩ := this
              rcases hh with ⟨-, h2⟩ | ⟨h2, -⟩ | ⟨h2, -⟩
              · exact h2.symm
              · exact absurd h2 h1'
              · exact absurd h2 h1'
        · rw [ite_of_not h1]
          have h1' : mapGet targets (coordinate book balance.sourceAccountId) =
              some rule.targetAccountId := by simpa using h1
          by_cases h2 : ruleValuationInvalid governedAt gv rule.valuationPolicy = true
          · rw [ite_pos' h2]
            simp only [Except.ok.injEq, Sum.inl.injEq]
            constructor
            · intro h; exact Or.inr (Or.inr ⟨hne, rule, rfl, Or.inr (Or.inl ⟨h1', h2, h.symm⟩)⟩)
            · rintro (⟨h, -⟩ | ⟨-, h, -⟩ | ⟨-, rule', h, hh⟩)
              · exact absurd h hne
              · simp at h
              · have := List.cons.inj h
                obtain ⟨rfl, -⟩ := this
                rcases hh with ⟨h3, -⟩ | ⟨-, -, h3⟩ | ⟨-, h3, -⟩
                · exact absurd h1' h3
                · exact h3.symm
                · rw [h2] at h3; cases h3
          · have h2' : ruleValuationInvalid governedAt gv rule.valuationPolicy = false :=
              Bool.eq_false_iff.mpr h2
            rw [ite_of_not h2]
            constructor
            · intro h
              split at h
              · cases h
              · rename_i cs hcs
                exact Or.inr (Or.inr ⟨hne, rule, rfl, Or.inr (Or.inr ⟨h1', h2', cs, hcs,
                  Except.ok.inj h⟩)⟩)
            · rintro (⟨h, -⟩ | ⟨-, h, -⟩ | ⟨-, rule', h, hh⟩)
              · exact absurd h hne
              · simp at h
              · have := List.cons.inj h
                obtain ⟨rfl, -⟩ := this
                rcases hh with ⟨h3, -⟩ | ⟨-, h3, -⟩ | ⟨-, -, cs, hcs, hsel⟩
                · exact absurd h1' h3
                · rw [h2'] at h3; cases h3
                · rw [hcs]
                  simp only
                  rw [hsel]

end RateReasons

section RateReasons

variable {rules : List ConsolidationTranslationRule} {gv : ConsolidationValuationPolicy}
  {governedAt : Instant} {throughOn : LocalDate} {commodityId : CommodityId}
  {targets : List (String × AccountId)} {book : BookId} {balance : ConsolidationSourceBalance}

/-- Closes a case where two different diagnostics are said to be the same. -/
local macro "dne" : tactic => `(tactic| (exfalso; simp_all [mappingsDiagnostic,
  duplicateSourceAccountDiagnostic, sameCommodityPathDiagnostic, missingTranslationRuleDiagnostic,
  ruleTargetMismatchDiagnostic, ruleValuationPolicyDiagnostic, noAdmissiblePathDiagnostic,
  ambiguousPathRateDiagnostic, diagnostic]; done))

/-- A balance is refused for presenting a path in the book's own commodity exactly when it is in that commodity and presents one. -/
theorem resolveRate_sameCommodity_iff :
    resolveRate rules gv governedAt throughOn commodityId targets book balance =
        .ok (.inl [sameCommodityPathDiagnostic]) ↔
      balance.unitsCommodityId = commodityId ∧ balance.valuationPaths ≠ [] := by
  rw [resolveRate_inl_iff]
  constructor
  · rintro (⟨h1, h2, -⟩ | ⟨-, -, h⟩ | ⟨-, rule, -, hh⟩)
    · exact ⟨h1, h2⟩
    · dne
    · rcases hh with ⟨-, h⟩ | ⟨-, -, h⟩ | ⟨-, -, cs, -, hsel⟩
      · dne
      · dne
      · rcases selectRate_inl_mem hsel with h | h <;> dne
  · rintro ⟨h1, h2⟩; exact Or.inl ⟨h1, h2, rfl⟩

/-- A balance is refused for its rule exactly when it needs a rate and the rules that apply are not exactly one. -/
theorem resolveRate_missingRule_iff :
    resolveRate rules gv governedAt throughOn commodityId targets book balance =
        .ok (.inl [missingTranslationRuleDiagnostic]) ↔
      balance.unitsCommodityId ≠ commodityId ∧
        (rules.filter (ruleApplies book balance.sourceAccountId governedAt)).length ≠ 1 := by
  rw [resolveRate_inl_iff]
  constructor
  · rintro (⟨-, -, h⟩ | ⟨h1, h2, -⟩ | ⟨-, rule, -, hh⟩)
    · dne
    · exact ⟨h1, h2⟩
    · rcases hh with ⟨-, h⟩ | ⟨-, -, h⟩ | ⟨-, -, cs, -, hsel⟩
      · dne
      · dne
      · rcases selectRate_inl_mem hsel with h | h <;> dne
  · rintro ⟨h1, h2⟩; exact Or.inr (Or.inl ⟨h1, h2, rfl⟩)

/-- A balance is refused for its rule's target exactly when the one rule that applies names another account than the mapped one. -/
theorem resolveRate_targetMismatch_iff :
    resolveRate rules gv governedAt throughOn commodityId targets book balance =
        .ok (.inl [ruleTargetMismatchDiagnostic]) ↔
      balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
        rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
        mapGet targets (coordinate book balance.sourceAccountId) ≠ some rule.targetAccountId := by
  rw [resolveRate_inl_iff]
  constructor
  · rintro (⟨-, -, h⟩ | ⟨-, -, h⟩ | ⟨h1, rule, hf, hh⟩)
    · dne
    · dne
    · rcases hh with ⟨h2, -⟩ | ⟨-, -, h⟩ | ⟨-, -, cs, -, hsel⟩
      · exact ⟨h1, rule, hf, h2⟩
      · dne
      · rcases selectRate_inl_mem hsel with h | h <;> dne
  · rintro ⟨h1, rule, hf, h2⟩; exact Or.inr (Or.inr ⟨h1, rule, hf, Or.inl ⟨h2, rfl⟩⟩)

/-- A balance is refused for its rule's valuation policy exactly when the one rule has the right target and a policy that is not effective or not compatible. -/
theorem resolveRate_ruleValuation_iff :
    resolveRate rules gv governedAt throughOn commodityId targets book balance =
        .ok (.inl [ruleValuationPolicyDiagnostic]) ↔
      balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
        rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
        mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
        ruleValuationInvalid governedAt gv rule.valuationPolicy = true := by
  rw [resolveRate_inl_iff]
  constructor
  · rintro (⟨-, -, h⟩ | ⟨-, -, h⟩ | ⟨h1, rule, hf, hh⟩)
    · dne
    · dne
    · rcases hh with ⟨-, h⟩ | ⟨h2, h3, -⟩ | ⟨-, -, cs, -, hsel⟩
      · dne
      · exact ⟨h1, rule, hf, h2, h3⟩
      · rcases selectRate_inl_mem hsel with h | h <;> dne
  · rintro ⟨h1, rule, hf, h2, h3⟩
    exact Or.inr (Or.inr ⟨h1, rule, hf, Or.inr (Or.inl ⟨h2, h3, rfl⟩)⟩)

/-- No path is admissible: the one rule applies, its target and valuation policy are right, no path
the balance presents makes a candidate, and no path throws. -/
theorem resolveRate_noPath_iff (hb : balance.WF) :
    resolveRate rules gv governedAt throughOn commodityId targets book balance =
        .ok (.inl [noAdmissiblePathDiagnostic]) ↔
      balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
        rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
        mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
        ruleValuationInvalid governedAt gv rule.valuationPolicy = false ∧
        (∃ cs, collectCandidates governedAt throughOn rule.valuationPolicy.maximumHops
          rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId
          balance.valuationPaths = .ok cs) ∧
        ∀ path ∈ balance.valuationPaths,
          ¬ MakesCandidate governedAt throughOn rule.valuationPolicy.maximumHops
            rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId path := by
  rw [resolveRate_inl_iff]
  constructor
  · rintro (⟨-, -, h⟩ | ⟨-, -, h⟩ | ⟨h1, rule, hf, hh⟩)
    · dne
    · dne
    · rcases hh with ⟨-, h⟩ | ⟨-, -, h⟩ | ⟨h2, h3, cs, hcs, hsel⟩
      · dne
      · dne
      · have hnil := (selectRate_noAdmissible_iff _ cs).mp hsel
        refine ⟨h1, rule, hf, h2, h3, ⟨cs, hcs⟩, ?_⟩
        have := ((collectCandidates_spec (E := fun _ => True) trivial governedAt throughOn
          rule.valuationPolicy.maximumHops rule.valuationPolicy.allowInverseObservation
          balance.unitsCommodityId commodityId balance.valuationPaths hb.valuationPaths).1 cs hcs).2
        exact this.mp hnil
  · rintro ⟨h1, rule, hf, h2, h3, ⟨cs, hcs⟩, hall⟩
    refine Or.inr (Or.inr ⟨h1, rule, hf, Or.inr (Or.inr ⟨h2, h3, cs, hcs, ?_⟩)⟩)
    have := ((collectCandidates_spec (E := fun _ => True) trivial governedAt throughOn
      rule.valuationPolicy.maximumHops rule.valuationPolicy.allowInverseObservation
      balance.unitsCommodityId commodityId balance.valuationPaths hb.valuationPaths).1 cs hcs).2
    exact (selectRate_noAdmissible_iff _ cs).mpr (this.mpr hall)

/-- The equally preferred paths disagree on the rate: the one rule applies, its target and valuation
policy are right, no path throws, there is a candidate, and in the ranking the best has the same hops
and `effectiveAt` as a candidate with another rate. -/
theorem resolveRate_ambiguous_iff :
    resolveRate rules gv governedAt throughOn commodityId targets book balance =
        .ok (.inl [ambiguousPathRateDiagnostic]) ↔
      balance.unitsCommodityId ≠ commodityId ∧ ∃ rule,
        rules.filter (ruleApplies book balance.sourceAccountId governedAt) = [rule] ∧
        mapGet targets (coordinate book balance.sourceAccountId) = some rule.targetAccountId ∧
        ruleValuationInvalid governedAt gv rule.valuationPolicy = false ∧
        ∃ cs, collectCandidates governedAt throughOn rule.valuationPolicy.maximumHops
            rule.valuationPolicy.allowInverseObservation balance.unitsCommodityId commodityId
            balance.valuationPaths = .ok cs ∧ cs ≠ [] ∧
          ∃ best rest, rankedCandidates
              (gv.preferDirectObservation || rule.valuationPolicy.preferDirectObservation) cs =
              best :: rest ∧
            ∃ c ∈ best :: rest, c.hops = best.hops ∧ c.effectiveAt = best.effectiveAt ∧
              c.rate ≠ best.rate := by
  rw [resolveRate_inl_iff]
  constructor
  · rintro (⟨-, -, h⟩ | ⟨-, -, h⟩ | ⟨h1, rule, hf, hh⟩)
    · dne
    · dne
    · rcases hh with ⟨-, h⟩ | ⟨-, -, h⟩ | ⟨h2, h3, cs, hcs, hsel⟩
      · dne
      · dne
      · exact ⟨h1, rule, hf, h2, h3, cs, hcs, (selectRate_ambiguous_iff _ cs).mp hsel⟩
  · rintro ⟨h1, rule, hf, h2, h3, cs, hcs, hamb⟩
    exact Or.inr (Or.inr ⟨h1, rule, hf, Or.inr (Or.inr ⟨h2, h3, cs, hcs,
      (selectRate_ambiguous_iff _ cs).mpr hamb⟩)⟩)

end RateReasons

/-- The request is rejected because a source account appears twice (`accounting.ts` line 2121)
exactly when every earlier stage passed and, in the loop over the balances, one comes after others
that went through and its coordinate is already resolved. -/
theorem rejected_duplicate_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) :
    compileConsolidation policies commodityId request =
        .ok (.rejected [duplicateSourceAccountDiagnostic]) ↔
      ∃ policy T, PassedTargets policies request policy T ∧
        ∃ pre p post em, balancePairs request.sources = pre ++ p :: post ∧
          resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
            request.governedAt request.throughOn commodityId T [] pre = .ok (.inr em) ∧
          mapHas em (pairKey p) = true := by
  rw [rejected_rates_iff policies commodityId request (by simp [rateDiagnostics])]
  constructor
  · rintro ⟨policy, T, hp, hl⟩
    obtain ⟨pre, p, post, em, hpp, hpre, hstep⟩ := (resolveRatesLoop_inl_iff _ _ _ _ _ _ _ _ _).mp hl
    rcases (rateStep_inl_iff _ _ _ _ _ _ _ _ _).mp hstep with ⟨h1, -⟩ | ⟨-, hres⟩
    · exact ⟨policy, T, hp, pre, p, post, em, hpp, hpre, h1⟩
    · have := resolveRate_inl_mem hres
      simp [rateDiagnostics, duplicateSourceAccountDiagnostic,
        sameCommodityPathDiagnostic, missingTranslationRuleDiagnostic,
        ruleTargetMismatchDiagnostic, ruleValuationPolicyDiagnostic,
        noAdmissiblePathDiagnostic, ambiguousPathRateDiagnostic, diagnostic] at this
  · rintro ⟨policy, T, hp, pre, p, post, em, hpp, hpre, h1⟩
    refine ⟨policy, T, hp, ?_⟩
    rw [resolveRatesLoop_inl_iff]
    exact ⟨pre, p, post, em, hpp, hpre, (rateStep_inl_iff _ _ _ _ _ _ _ _ _).mpr (Or.inl ⟨h1, rfl⟩)⟩

/-- The other reasons of the rates stage: every earlier stage passed and, in the loop over the
balances, one comes after others that went through, its coordinate is new, and `resolveRate`
refuses it with the diagnostics. -/
theorem rejected_translation_iff (policies : List AccountingPolicy) (commodityId : CommodityId)
    (request : ConsolidationRequest) {ds : List SemanticDiagnostic}
    (hD : ds ∈ rateDiagnostics.tail) :
    compileConsolidation policies commodityId request = .ok (.rejected ds) ↔
      ∃ policy T, PassedTargets policies request policy T ∧
        ∃ pre p post em, balancePairs request.sources = pre ++ p :: post ∧
          resolveRatesLoop (sortRules policy.translationRules) policy.valuationPolicy
            request.governedAt request.throughOn commodityId T [] pre = .ok (.inr em) ∧
          mapHas em (pairKey p) = false ∧
          resolveRate policy.translationRules policy.valuationPolicy request.governedAt
            request.throughOn commodityId T p.1 p.2 = .ok (.inl ds) := by
  rw [rejected_rates_iff policies commodityId request (List.mem_of_mem_tail hD)]
  constructor
  · rintro ⟨policy, T, hp, hl⟩
    obtain ⟨pre, p, post, em, hpp, hpre, hstep⟩ := (resolveRatesLoop_inl_iff _ _ _ _ _ _ _ _ _).mp hl
    rcases (rateStep_inl_iff _ _ _ _ _ _ _ _ _).mp hstep with ⟨-, rfl⟩ | ⟨h1, hres⟩
    · exfalso
      simp [rateDiagnostics, duplicateSourceAccountDiagnostic,
        sameCommodityPathDiagnostic, missingTranslationRuleDiagnostic,
        ruleTargetMismatchDiagnostic, ruleValuationPolicyDiagnostic,
        noAdmissiblePathDiagnostic, ambiguousPathRateDiagnostic, diagnostic] at hD
    · refine ⟨policy, T, hp, pre, p, post, em, hpp, hpre, h1, ?_⟩
      rw [← resolveRate_sortRules]; exact hres
  · rintro ⟨policy, T, hp, pre, p, post, em, hpp, hpre, h1, hres⟩
    refine ⟨policy, T, hp, ?_⟩
    rw [resolveRatesLoop_inl_iff]
    refine ⟨pre, p, post, em, hpp, hpre, (rateStep_inl_iff _ _ _ _ _ _ _ _ _).mpr (Or.inr ⟨h1, ?_⟩)⟩
    rw [resolveRate_sortRules]; exact hres

/-- The consolidation returns the draft `d` exactly when every stage passed and `compileDraft` made
it. -/
theorem compileConsolidation_draft_iff (policies : List AccountingPolicy)
    (commodityId : CommodityId) (request : ConsolidationRequest) (d : AccountingDraft) :
    compileConsolidation policies commodityId request = .ok (.draft d) ↔
      ∃ policy T R, CompiledThrough policies commodityId request policy T R d := by
  constructor
  · exact compileConsolidation_inv
  · rintro ⟨policy, T, R, hsel, hb, hd, hv, he, hg, ht, hr, hdraft⟩
    have hv' : validateSources (selectedPolicy policies request) request = .ok (some policy) := by
      unfold selectedPolicy; rw [hsel]; exact hv
    rw [compileConsolidation_after_targets (policy := policy) (T := T)
      ⟨⟨⟨⟨⟨hb, hd⟩, hv'⟩, he⟩, hg⟩, ht⟩, hr]
    exact hdraft

/-! ## The order of the sources -/

/-- A source passes the checks of `accounting.ts` lines 2036 to 2046: none of its own checks rejects
it, and its balances add up to zero. -/
def SourceOk (policy : ConsolidationPolicy) (targetBookId : BookId) (governedAt : Instant)
    (s : ConsolidationSource) : Prop :=
  sourceHeaderInvalid policy targetBookId governedAt s = false ∧
    ∃ total, accountingSum (s.balances.map (·.amount)) = .ok total ∧ total.isZero = true

/-- No source is rejected, and none throws, exactly when every source passes its checks. -/
theorem anySourceInvalid_false_iff (policy : ConsolidationPolicy) (targetBookId : BookId)
    (governedAt : Instant) :
    ∀ sources : List ConsolidationSource,
      anySourceInvalid policy targetBookId governedAt sources = .ok false ↔
        ∀ s ∈ sources, SourceOk policy targetBookId governedAt s := by
  intro sources
  induction sources with
  | nil => simp [anySourceInvalid]
  | cons s rest ih =>
    unfold anySourceInvalid
    by_cases hh : sourceHeaderInvalid policy targetBookId governedAt s = true
    · rw [ite_pos' hh]
      simp only [false_iff, Except.ok.injEq, Bool.true_eq_false]
      intro hall
      have := (hall s (by simp)).1
      rw [hh] at this; cases this
    · have hhf : sourceHeaderInvalid policy targetBookId governedAt s = false :=
        Bool.eq_false_iff.mpr hh
      rw [ite_of_not hh]
      cases hs : liftNum (accountingSum (s.balances.map (·.amount))) with
      | error e =>
        simp only [reduceCtorEq, false_iff]
        intro hall
        obtain ⟨-, total, htot, -⟩ := hall s (by simp)
        rw [liftNum_ok_iff.mpr htot] at hs; cases hs
      | ok total =>
        show (if (!total.isZero) = true then Except.ok true
          else anySourceInvalid policy targetBookId governedAt rest) = Except.ok false ↔
            ∀ t ∈ s :: rest, SourceOk policy targetBookId governedAt t
        by_cases hz : (!total.isZero) = true
        · rw [ite_pos' hz]
          simp only [Except.ok.injEq, Bool.true_eq_false, false_iff]
          intro hall
          obtain ⟨-, t2, ht2, hz2⟩ := hall s (by simp)
          have := liftNum_ok_iff.mp hs
          rw [this] at ht2
          cases ht2
          simp [hz2] at hz
        · rw [ite_of_not hz]
          have hz' : total.isZero = true := by simpa using hz
          rw [ih]
          constructor
          · intro hall t ht
            rcases List.mem_cons.mp ht with rfl | ht
            · exact ⟨hhf, total, liftNum_ok_iff.mp hs, hz'⟩
            · exact hall t ht
          · intro hall t ht
            exact hall t (List.mem_cons_of_mem _ ht)

/-- The sources check passes for the sources in any other order. -/
theorem validateSources_perm {policy : ConsolidationPolicy} {request request' : ConsolidationRequest}
    (hp : request'.sources.Perm request.sources) (ht : request'.targetBookId = request.targetBookId)
    (hg : request'.governedAt = request.governedAt)
    (h : validateSources (.selected policy) request = .ok (some policy)) :
    validateSources (.selected policy) request' = .ok (some policy) := by
  unfold validateSources at h ⊢
  simp only at h ⊢
  by_cases hc : (request.sources.isEmpty || !decide (request.sources.map (·.bookId)).Nodup ||
      !decide (request.sources.map (·.relationshipId)).Nodup) = true
  · rw [ite_pos' hc] at h; cases h
  rw [ite_of_not hc] at h
  have hc' : ¬ (request'.sources.isEmpty || !decide (request'.sources.map (·.bookId)).Nodup ||
      !decide (request'.sources.map (·.relationshipId)).Nodup) = true := by
    intro hc2
    apply hc
    simp only [Bool.or_eq_true, Bool.not_eq_true', decide_eq_false_iff_not] at hc2 ⊢
    rcases hc2 with (h1 | h1) | h1
    · left; left
      have := hp.length_eq
      rw [List.isEmpty_iff] at h1 ⊢
      rw [h1] at this; simpa using this.symm
    · left; right; intro hn; exact h1 ((hp.map _).nodup_iff.mpr hn)
    · right; intro hn; exact h1 ((hp.map _).nodup_iff.mpr hn)
  rw [ite_of_not hc']
  rw [ht, hg]
  cases hs : anySourceInvalid policy request.targetBookId request.governedAt request.sources with
  | error e => rw [hs] at h; cases h
  | ok b =>
    cases b with
    | true => rw [hs] at h; cases h
    | false =>
      have hall := (anySourceInvalid_false_iff _ _ _ _).mp hs
      have := (anySourceInvalid_false_iff policy request.targetBookId request.governedAt
        request'.sources).mpr (fun s hm => hall s (hp.subset hm))
      rw [this]

/-- The eliminations check does not depend on the order of the sources. -/
theorem eliminationsInvalid_perm {request request' : ConsolidationRequest}
    (hp : request'.sources.Perm request.sources) (he : request'.eliminations = request.eliminations) :
    eliminationsInvalid request' = eliminationsInvalid request := by
  have hc : ∀ x : BookId, ((request'.sources.map (·.bookId)).contains x) =
      ((request.sources.map (·.bookId)).contains x) := by
    intro x
    rw [Bool.eq_iff_iff]
    simp only [List.contains_iff_mem]
    exact (hp.map _).mem_iff
  unfold eliminationsInvalid
  simp only [he, hc]

/-- The pairs of reordered sources are the same pairs. -/
theorem mem_balancePairs_perm {sources sources' : List ConsolidationSource}
    (hp : sources'.Perm sources) (p : BookId × ConsolidationSourceBalance) :
    p ∈ balancePairs sources' ↔ p ∈ balancePairs sources := by
  unfold balancePairs
  exact (hp.flatMap_right _).mem_iff

/-- The pairs of reordered sources are a reordering of the pairs. -/
theorem balancePairs_perm {sources sources' : List ConsolidationSource}
    (hp : sources'.Perm sources) : (balancePairs sources').Perm (balancePairs sources) := by
  unfold balancePairs
  exact hp.flatMap_right _

/-- The account mappings resolve for the sources in any other order, to the same accounts. -/
theorem targetsLoop_perm {mappings : List ConsolidationAccountMapping} {governedAt : Instant}
    {sources sources' : List ConsolidationSource} (hp : sources'.Perm sources)
    {T : List (String × AccountId)}
    (h : resolveTargetsLoop mappings governedAt [] (balancePairs sources) = .inr T) :
    ∃ T', resolveTargetsLoop mappings governedAt [] (balancePairs sources') = .inr T' ∧
      ∀ s ∈ sources, ∀ b ∈ s.balances,
        mapGet T' (coordinate s.bookId b.sourceAccountId) =
          mapGet T (coordinate s.bookId b.sourceAccountId) := by
  have hgood : ∀ k t, mapGet ([] : List (String × AccountId)) k = some t → ∃ b a, coordinate b a = k ∧
      mappingTarget mappings governedAt b a = some t := by
    intro k t hk; simp [mapGet] at hk
  cases h' : resolveTargetsLoop mappings governedAt [] (balancePairs sources') with
  | inl d =>
    exfalso
    obtain ⟨p, hpm, hnone, -⟩ := (resolveTargetsLoop_inl_iff mappings governedAt _ _ _).mp h'
    have := (resolveTargetsLoop_inl_iff mappings governedAt (balancePairs sources) [] [mappingsDiagnostic]).mpr
      ⟨p, (mem_balancePairs_perm hp p).mp hpm, hnone, rfl⟩
    rw [this] at h; cases h
  | inr T' =>
    refine ⟨T', rfl, ?_⟩
    intro s hs b hb
    have hT := resolveTargetsLoop_inr mappings governedAt (balancePairs sources) [] T hgood h
    have hT' := resolveTargetsLoop_inr mappings governedAt (balancePairs sources') [] T' hgood h'
    obtain ⟨t, hmt, hget⟩ := hT.2.2 (s.bookId, b) (mem_balancePairs hs hb)
    obtain ⟨t', hmt', hget'⟩ := hT'.2.2 (s.bookId, b)
      ((mem_balancePairs_perm hp _).mpr (mem_balancePairs hs hb))
    have : t' = t := by rw [hmt] at hmt'; exact (Option.some.inj hmt').symm
    subst this
    exact hget'.trans hget.symm

/-- A rate depends on the map of accounts only through the entry of its own coordinate. -/
theorem resolveRate_congr {rules : List ConsolidationTranslationRule}
    {gv : ConsolidationValuationPolicy} {governedAt : Instant} {throughOn : LocalDate}
    {commodityId : CommodityId} {T T' : List (String × AccountId)} {book : BookId}
    {balance : ConsolidationSourceBalance}
    (h : mapGet T (coordinate book balance.sourceAccountId) =
      mapGet T' (coordinate book balance.sourceAccountId)) :
    resolveRate rules gv governedAt throughOn commodityId T book balance =
      resolveRate rules gv governedAt throughOn commodityId T' book balance := by
  simp only [resolveRate, resolveRateByRule, h]

/-- The rates loop goes through when the coordinates are distinct and new and each balance resolves. -/
theorem resolveRatesLoop_of_all {rules : List ConsolidationTranslationRule}
    {gv : ConsolidationValuationPolicy} {governedAt : Instant} {throughOn : LocalDate}
    {commodityId : CommodityId} {T : List (String × AccountId)} :
    ∀ (pairs : List (BookId × ConsolidationSourceBalance)) (entries : List (String × ExactRational)),
      (pairs.map pairKey).Nodup → (∀ p ∈ pairs, mapHas entries (pairKey p) = false) →
      (∀ p ∈ pairs, ∃ r, resolveRate rules gv governedAt throughOn commodityId T p.1 p.2 =
        .ok (.inr r)) →
      ∃ er, resolveRatesLoop rules gv governedAt throughOn commodityId T entries pairs =
        .ok (.inr er) := by
  intro pairs
  induction pairs with
  | nil => intro entries _ _ _; exact ⟨entries, rfl⟩
  | cons p rest ih =>
    intro entries hnd hfresh hres
    obtain ⟨r, hr⟩ := hres p (by simp)
    have hstep : rateStep rules gv governedAt throughOn commodityId T entries p =
        .ok (.inr (mapSet entries (pairKey p) r)) :=
      (rateStep_inr_iff rules gv governedAt throughOn commodityId T entries _ p).mpr
        ⟨hfresh p (by simp), r, hr, rfl⟩
    have hnd' := List.nodup_cons.mp hnd
    obtain ⟨er, her⟩ := ih (mapSet entries (pairKey p) r) hnd'.2
      (fun q hq => by
        rw [mapHas_mapSet]
        have hne : pairKey p ≠ pairKey q := fun heq => hnd'.1 (List.mem_map.mpr ⟨q, hq, heq.symm⟩)
        simp [beq_false_of_ne hne, hfresh q (List.mem_cons_of_mem _ hq)])
      (fun q hq => hres q (List.mem_cons_of_mem _ hq))
    exact ⟨er, by simp only [resolveRatesLoop, hstep]; exact her⟩

/-! ## What the compilation reads of the two maps -/

theorem compileSourceBalances_congr {requestId : ConsolidationCompilationId}
    {commodityId : CommodityId} {T T' : List (String × AccountId)}
    {R R' : List (String × ExactRational)} {book : BookId} {factor : ExactRational} :
    ∀ (balances : List ConsolidationSourceBalance) (ordinal : Nat) (netAssets : ExactRational),
      (∀ b ∈ balances, rateAt R book b = rateAt R' book b ∧ targetAt T book b = targetAt T' book b) →
      compileSourceBalances requestId commodityId T R book factor ordinal netAssets balances =
        compileSourceBalances requestId commodityId T' R' book factor ordinal netAssets balances := by
  intro balances
  induction balances with
  | nil => intro ordinal netAssets _; rfl
  | cons balance rest ih =>
    intro ordinal netAssets h
    obtain ⟨hr0, ht0⟩ := h balance (by simp)
    have ih' := fun o n => ih o n (fun b hb => h b (List.mem_cons_of_mem _ hb))
    simp only [compileSourceBalances, hr0, ht0, ih']

/-- The postings of a source depend on the two maps only through the entries of its balances. -/
theorem compileSource_congr {requestId : ConsolidationCompilationId} {commodityId : CommodityId}
    {policy : ConsolidationPolicy} {T T' : List (String × AccountId)}
    {R R' : List (String × ExactRational)} (ordinal : Nat) (source : ConsolidationSource)
    (h : ∀ b ∈ source.balances,
      rateAt R source.bookId b = rateAt R' source.bookId b ∧
        targetAt T source.bookId b = targetAt T' source.bookId b) :
    compileSource requestId commodityId policy T R ordinal source =
      compileSource requestId commodityId policy T' R' ordinal source := by
  have hbal := compileSourceBalances_congr (requestId := requestId) (commodityId := commodityId)
    (T := T) (T' := T') (R := R) (R' := R') (book := source.bookId) (factor := sourceFactor source)
    (sortBalances source.balances) ordinal ExactRational.zero
    (fun b hb => h b ((sortBalances_perm _).subset hb))
  simp only [compileSource, hbal]

/-- The postings of the sources depend on the two maps only through the entries of their balances. -/
theorem compileSourcesLoop_congr {requestId : ConsolidationCompilationId}
    {commodityId : CommodityId} {policy : ConsolidationPolicy} {T T' : List (String × AccountId)}
    {R R' : List (String × ExactRational)} :
    ∀ (sources : List ConsolidationSource) (ordinal : Nat),
      (∀ s ∈ sources, ∀ b ∈ s.balances,
        rateAt R s.bookId b = rateAt R' s.bookId b ∧ targetAt T s.bookId b = targetAt T' s.bookId b) →
      compileSourcesLoop requestId commodityId policy T R ordinal sources =
        compileSourcesLoop requestId commodityId policy T' R' ordinal sources := by
  intro sources
  induction sources with
  | nil => intro ordinal _; rfl
  | cons source rest ih =>
    intro ordinal h
    have hs := compileSource_congr (requestId := requestId) (commodityId := commodityId)
      (policy := policy) (T := T) (T' := T') (R := R) (R' := R') ordinal source
      (fun b hb => h source (by simp) b hb)
    have ih' := fun o => ih o (fun s hm b hb => h s (List.mem_cons_of_mem _ hm) b hb)
    simp only [compileSourcesLoop, hs, ih']

/-- The draft depends on the two maps only through the entries of the balances of the sources. -/
theorem compileDraft_congr {commodityId : CommodityId} {request : ConsolidationRequest}
    {policy : ConsolidationPolicy} {T T' : List (String × AccountId)}
    {R R' : List (String × ExactRational)}
    (h : ∀ s ∈ request.sources, ∀ b ∈ s.balances,
      rateAt R s.bookId b = rateAt R' s.bookId b ∧ targetAt T s.bookId b = targetAt T' s.bookId b) :
    compileDraft commodityId request policy T R = compileDraft commodityId request policy T' R' := by
  have hloop := compileSourcesLoop_congr (requestId := request.id) (commodityId := commodityId)
    (policy := policy) (T := T) (T' := T') (R := R) (R' := R') (sortSources request.sources) 0
    (fun s hs b hb => h s ((sortSources_perm _).subset hs) b hb)
  simp only [compileDraft, hloop]

/-- Sources that pass their checks have distinct books. -/
theorem validateSources_nodup {policy : ConsolidationPolicy} {request : ConsolidationRequest}
    (h : validateSources (.selected policy) request = .ok (some policy)) :
    (request.sources.map (·.bookId)).Nodup := by
  by_contra hn
  have hc : (request.sources.isEmpty || !decide (request.sources.map (·.bookId)).Nodup ||
      !decide (request.sources.map (·.relationshipId)).Nodup) = true := by
    simp [hn]
  unfold validateSources at h
  simp only at h
  rw [ite_pos' hc] at h
  cases h

/-- The result does not depend on the order of the sources, when the compilation succeeds: a draft
for a request is the same draft for the request with its sources in any other order. (The sources
are put in the order of their books; the balances of a source in the order of their accounts; the
eliminations stay in the order of the request, which is not an order the TypeScript fixes either.) -/
theorem compileConsolidation_draft_perm {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {ss : List ConsolidationSource}
    {d : AccountingDraft} (hp : ss.Perm request.sources)
    (h : compileConsolidation policies commodityId request = .ok (.draft d)) :
    compileConsolidation policies commodityId { request with sources := ss } = .ok (.draft d) := by
  obtain ⟨policy, T, R, hsel, hb, hd, hv, he, hg, ht, hr, hdraft⟩ :=
    (compileConsolidation_draft_iff _ _ _ _).mp h
  have hnodup := validateSources_nodup hv
  obtain ⟨T', ht', hlookT⟩ := targetsLoop_perm (sources' := ss) hp ht
  obtain ⟨-, hkeys, -, hres⟩ := resolveRatesLoop_inr (sortRules policy.translationRules)
    policy.valuationPolicy request.governedAt request.throughOn commodityId T
    (balancePairs request.sources) [] R hr
  have hkeys' : ((balancePairs ss).map pairKey).Nodup :=
    ((balancePairs_perm hp).map pairKey).nodup_iff.mpr hkeys
  have hall : ∀ p ∈ balancePairs ss, ∃ r, resolveRate (sortRules policy.translationRules)
      policy.valuationPolicy request.governedAt request.throughOn commodityId T' p.1 p.2 =
        .ok (.inr r) := by
    intro p hpm
    obtain ⟨r, hr1, -⟩ := hres p ((mem_balancePairs_perm hp p).mp hpm)
    refine ⟨r, ?_⟩
    obtain ⟨s, hs, hpm2⟩ := List.mem_flatMap.mp hpm
    obtain ⟨b, hb2, rfl⟩ := List.mem_map.mp hpm2
    rw [← resolveRate_congr (hlookT s (hp.subset hs) b hb2)] at hr1
    exact hr1
  obtain ⟨R', hr'⟩ := resolveRatesLoop_of_all (T := T') (balancePairs ss) [] hkeys'
    (fun p _ => by simp [mapHas]) hall
  obtain ⟨-, -, -, hres'⟩ := resolveRatesLoop_inr (sortRules policy.translationRules)
    policy.valuationPolicy request.governedAt request.throughOn commodityId T'
    (balancePairs ss) [] R' hr'
  have hlook : ∀ s ∈ request.sources, ∀ b ∈ s.balances,
      rateAt R' s.bookId b = rateAt R s.bookId b ∧ targetAt T' s.bookId b = targetAt T s.bookId b := by
    intro s hs b hb2
    refine ⟨?_, ?_⟩
    · obtain ⟨r, hr1, hg1⟩ := hres (s.bookId, b) (mem_balancePairs hs hb2)
      obtain ⟨r', hr2, hg2⟩ := hres' (s.bookId, b)
        ((mem_balancePairs_perm hp _).mpr (mem_balancePairs hs hb2))
      rw [← resolveRate_congr (hlookT s hs b hb2)] at hr1
      rw [hr1] at hr2
      have : r' = r := (Sum.inr.inj (Except.ok.inj hr2)).symm
      subst this
      unfold rateAt
      have h1 : mapGet R' (coordinate s.bookId b.sourceAccountId) = some r' := hg2
      have h2 : mapGet R (coordinate s.bookId b.sourceAccountId) = some r' := hg1
      rw [h1, h2]
    · unfold targetAt
      rw [hlookT s hs b hb2]
  have hs : sortSources ss = sortSources request.sources :=
    sortSources_eq_of_perm hp ((hp.map _).nodup_iff.mpr hnodup)
  have hloop := compileSourcesLoop_congr (requestId := request.id) (commodityId := commodityId)
    (policy := policy) (T := T') (T' := T) (R := R') (R' := R) (sortSources request.sources) 0
    (fun s hs' b hb2 => hlook s ((sortSources_perm _).subset hs') b hb2)
  have hcd : compileDraft commodityId { request with sources := ss } policy T' R' =
      compileDraft commodityId request policy T R := by
    simp only [compileDraft, compilationEffect, compilationBody, compilationJournal, hs, hloop]
  refine (compileConsolidation_draft_iff _ _ _ _).mpr ⟨policy, T', R', hsel, ?_, hd, ?_, ?_, hg,
    ht', hr', hcd.trans hdraft⟩
  · have : boundsInvalid { request with sources := ss } = boundsInvalid request := by
      simp only [boundsInvalid, hp.length_eq]
    rw [this]; exact hb
  · exact validateSources_perm (request := request) (request' := { request with sources := ss })
      hp rfl rfl hv
  · exact (eliminationsInvalid_perm (request := request)
      (request' := { request with sources := ss }) hp rfl).trans he

/-! ## Translating along a path and back -/

/-- The steps of a path form a chain read forward from `a` to `b`: each starts where the one before
ends. -/
def ForwardChain : CommodityId → List ConsolidationValuationStep → CommodityId → Prop
  | a, [], b => a = b
  | a, s :: rest, b => s.fromCommodityId = a ∧ ForwardChain s.toCommodityId rest b

/-- The factors of two paths walked one after the other are those of the first and then those of the second. -/
theorem stepFactors_append (steps₁ steps₂ : List ConsolidationValuationStep) :
    ∀ c : CommodityId, stepFactors c (steps₁ ++ steps₂) =
      stepFactors c steps₁ ++ stepFactors (walkEnd c steps₁) steps₂ := by
  induction steps₁ with
  | nil => intro c; simp [stepFactors, walkEnd]
  | cons s rest ih =>
    intro c
    by_cases h : (s.fromCommodityId == c) = true
    · simp [stepFactors, walkEnd, h, ih]
    · simp [stepFactors, walkEnd, h, ih]

/-- Walking two paths one after the other ends where the second ends from where the first ended. -/
theorem walkEnd_append (steps₁ steps₂ : List ConsolidationValuationStep) :
    ∀ c : CommodityId, walkEnd c (steps₁ ++ steps₂) = walkEnd (walkEnd c steps₁) steps₂ := by
  induction steps₁ with
  | nil => intro c; simp [walkEnd]
  | cons s rest ih =>
    intro c
    by_cases h : (s.fromCommodityId == c) = true
    · simp [walkEnd, h, ih]
    · simp [walkEnd, h, ih]

/-- A path read forward from `a` to `b` ends in `b`, and its factors are its rates. -/
theorem forwardChain_factors : ∀ (steps : List ConsolidationValuationStep) (a b : CommodityId),
    ForwardChain a steps b → walkEnd a steps = b ∧
      stepFactors a steps = steps.map (fun s => s.rate.toRat)
  | [], a, b, h => by simp only [ForwardChain] at h; simp [walkEnd, stepFactors, h]
  | s :: rest, a, b, h => by
    obtain ⟨h1, h2⟩ := h
    obtain ⟨e, f⟩ := forwardChain_factors rest s.toCommodityId b h2
    have hb : (s.fromCommodityId == a) = true := beq_iff_eq.mpr h1
    simp [walkEnd, stepFactors, hb, e, f]

/-- A path read forward from `a` to `b`, no step of which starts and ends in one commodity, read
backward from `b` with its steps in the other order, goes back to `a`, and its factors are the
reciprocals of the forward ones, in the other order. -/
theorem reverse_walk : ∀ (steps : List ConsolidationValuationStep) (a b : CommodityId),
    ForwardChain a steps b → (∀ s ∈ steps, s.fromCommodityId ≠ s.toCommodityId) →
      walkEnd b steps.reverse = a ∧
      stepFactors b steps.reverse = steps.reverse.map (fun s => (s.rate.toRat)⁻¹)
  | [], a, b, h, _ => by simp only [ForwardChain] at h; simp [walkEnd, stepFactors, h]
  | s :: rest, a, b, h, hne => by
    obtain ⟨h1, h2⟩ := h
    subst h1
    obtain ⟨e, f⟩ := reverse_walk rest s.toCommodityId b h2
      (fun t ht => hne t (List.mem_cons_of_mem _ ht))
    have hsne : s.fromCommodityId ≠ s.toCommodityId := hne s (by simp)
    have hn : (s.fromCommodityId == s.toCommodityId) = false := by simpa using hsne
    rw [List.reverse_cons, walkEnd_append, stepFactors_append, e, f]
    simp [walkEnd, stepFactors, hn]

/-- An admissible path read forward all the way is a chain whose steps start and end apart and have positive rates. -/
theorem forward_of_admissible {governedAt : Instant} {allowInverse : Bool} :
    ∀ (steps : List ConsolidationValuationStep) (cur : CommodityId) (visited : List CommodityId),
      cur ∈ visited → PathAdmissible governedAt allowInverse cur visited steps →
      walkUsedInverse cur steps = false →
      ForwardChain cur steps (walkEnd cur steps) ∧
        (∀ s ∈ steps, s.fromCommodityId ≠ s.toCommodityId) ∧
        (∀ s ∈ steps, 0 < s.rate.numerator)
  | [], cur, visited, _, _, _ => by simp [ForwardChain, walkEnd]
  | s :: rest, cur, visited, hcur, hadm, hused => by
    have hfwd : (s.fromCommodityId == cur) = true := by
      by_contra hn
      have hf : (s.fromCommodityId == cur) = false := Bool.eq_false_iff.mpr hn
      simp [walkUsedInverse, hf] at hused
    have hfe : s.fromCommodityId = cur := beq_iff_eq.mp hfwd
    simp only [PathAdmissible, hfe, ↓reduceIte] at hadm
    obtain ⟨hev, hpos, hobs, hnot, hrest⟩ := hadm
    have hused' : walkUsedInverse s.toCommodityId rest = false := by
      simpa [walkUsedInverse, hfwd] using hused
    obtain ⟨hc, hne, hpos'⟩ := forward_of_admissible rest s.toCommodityId
      (s.toCommodityId :: visited) (by simp) hrest hused'
    refine ⟨?_, ?_, ?_⟩
    · simp only [walkEnd, hfwd, ↓reduceIte, ForwardChain]
      exact ⟨hfe, hc⟩
    · intro t ht
      rcases List.mem_cons.mp ht with rfl | ht
      · intro heq
        apply hnot
        rw [← heq, hfe]; exact hcur
      · exact hne t ht
    · intro t ht
      rcases List.mem_cons.mp ht with rfl | ht
      · exact hpos
      · exact hpos' t ht

/-- Translating along a path and back along the inverse path gives the original: if a path is read
forward from `a` to `b` and the code accepts the same steps in the other order read from `b`
(inverse observation allowed), the walk ends in `a` and the two rates multiply to exactly one, so an
amount translated and translated back is the amount. -/
theorem translate_back {governedAt : Instant} {allowInverse : Bool} {a b : CommodityId}
    {steps : List ConsolidationValuationStep} {r : ExactRational}
    (hfwd : evalPathSteps governedAt allowInverse a rationalOne false [a] steps =
      .ok (some (b, r, false)))
    (hwf : ∀ s ∈ steps, s.WF) {a' : CommodityId} {r' : ExactRational} {u' : Bool}
    (hback : evalPathSteps governedAt true b rationalOne false [b] steps.reverse =
      .ok (some (a', r', u'))) :
    a' = a ∧ r.toRat * r'.toRat = 1 := by
  obtain ⟨hadm, hend, hrwf, hval, hused⟩ := (evalPathSteps_spec (E := fun _ => True) trivial
    governedAt allowInverse steps a rationalOne false [a] hwf rationalOne_wf).1 _ hfwd
  have hwf' : ∀ s ∈ steps.reverse, s.WF := fun s hs => hwf s (List.mem_reverse.mp hs)
  obtain ⟨-, hend', hr'wf, hval', -⟩ := (evalPathSteps_spec (E := fun _ => True) trivial
    governedAt true steps.reverse b rationalOne false [b] hwf' rationalOne_wf).1 _ hback
  have hu : walkUsedInverse a steps = false := by simpa using hused.symm
  obtain ⟨hc, hne, hpos⟩ := forward_of_admissible steps a [a] (by simp) hadm hu
  have hc' : ForwardChain a steps b := by rw [hend]; exact hc
  obtain ⟨-, hf⟩ := forwardChain_factors steps a b hc'
  obtain ⟨hre, hrf⟩ := reverse_walk steps a b hc' hne
  refine ⟨by rw [hend', hre], ?_⟩
  have hinv : ∀ l : List ConsolidationValuationStep,
      (l.map fun s => s.rate.toRat⁻¹).prod = ((l.map fun s => s.rate.toRat).prod)⁻¹ := by
    intro l
    induction l with
    | nil => simp
    | cons s t ih => simp only [List.map_cons, List.prod_cons, ih, mul_inv]
  rw [hval, hf, hval', hrf, rationalOne_toRat, one_mul, one_mul, List.map_reverse,
    List.prod_reverse, hinv]
  have hprodpos : ∀ l : List ConsolidationValuationStep, (∀ s ∈ l, s.WF) →
      (∀ s ∈ l, 0 < s.rate.numerator) → 0 < (l.map fun s => s.rate.toRat).prod := by
    intro l
    induction l with
    | nil => intro _ _; simp
    | cons s t ih =>
      intro hw hp
      have h1 : 0 < s.rate.toRat := by
        have hd := ExactRational.den_pos_rat (hw s (by simp)).rate
        have hn : (0 : ℚ) < (s.rate.numerator : ℚ) := by exact_mod_cast hp s (by simp)
        unfold ExactRational.toRat
        positivity
      have h2 := ih (fun u hu => hw u (List.mem_cons_of_mem _ hu))
        (fun u hu => hp u (List.mem_cons_of_mem _ hu))
      simp only [List.map_cons, List.prod_cons]
      exact mul_pos h1 h2
  have hprod : (steps.map (fun s => s.rate.toRat)).prod ≠ 0 :=
    ne_of_gt (hprodpos steps hwf hpos)
  exact mul_inv_cancel₀ hprod

/-- A draft for a request is the same draft for the request with its sources in any other order,
and conversely. -/
theorem compileConsolidation_draft_perm_iff {policies : List AccountingPolicy}
    {commodityId : CommodityId} {request : ConsolidationRequest} {ss : List ConsolidationSource}
    {d : AccountingDraft} (hp : ss.Perm request.sources) :
    compileConsolidation policies commodityId { request with sources := ss } = .ok (.draft d) ↔
      compileConsolidation policies commodityId request = .ok (.draft d) := by
  constructor
  · intro h
    have := compileConsolidation_draft_perm (request := { request with sources := ss })
      (ss := request.sources) hp.symm h
    simpa using this
  · exact compileConsolidation_draft_perm hp

/-- A witness that a rejection or an error depends on the order of the sources: one source that fails
its own checks and one that is not rejected by them but whose balances cannot be added (the size
limit) give a rejection in one order and the error in the other, because `.some` stops at the first
source that answers (`accounting.ts` line 2035). -/
theorem sourcesCheck_order_matters {policy : ConsolidationPolicy} {target : BookId}
    {governedAt : Instant} {a b : ConsolidationSource} {e : ConsolidationErr}
    (ha : sourceHeaderInvalid policy target governedAt a = true)
    (hb : sourceHeaderInvalid policy target governedAt b = false)
    (hbe : liftNum (accountingSum (b.balances.map (·.amount))) = .error e) :
    anySourceInvalid policy target governedAt [a, b] = .ok true ∧
      anySourceInvalid policy target governedAt [b, a] = .error e := by
  constructor
  · simp [anySourceInvalid, ha]
  · simp [anySourceInvalid, hb, hbe]

/-- A witness that the diagnostics depend on the order of the balances: two balances that are each
refused, with other diagnostics, are refused with the diagnostics of the first of them
(`accounting.ts` lines 2119 to 2125). -/
theorem ratesLoop_order_matters {rules : List ConsolidationTranslationRule}
    {gv : ConsolidationValuationPolicy} {governedAt : Instant} {throughOn : LocalDate}
    {commodityId : CommodityId} {T : List (String × AccountId)}
    {entries : List (String × ExactRational)} {p q : BookId × ConsolidationSourceBalance}
    {d₁ d₂ : List SemanticDiagnostic}
    (hp : rateStep rules gv governedAt throughOn commodityId T entries p = .ok (.inl d₁))
    (hq : rateStep rules gv governedAt throughOn commodityId T entries q = .ok (.inl d₂)) :
    resolveRatesLoop rules gv governedAt throughOn commodityId T entries [p, q] =
        .ok (.inl d₁) ∧
      resolveRatesLoop rules gv governedAt throughOn commodityId T entries [q, p] =
        .ok (.inl d₂) := by
  constructor
  · simp [resolveRatesLoop, hp]
  · simp [resolveRatesLoop, hq]

end Consolidation

end Rastrata.Kernel

/-
The vocabulary of accounting: the Lean model of the types of `packages/kernel/src/accounting.ts`
lines 33 to 680 and 1131 to 1165, with the functions of those lines that need nothing but the types,
`canonical.ts` and the canonical value of a posting: `accountingCapabilityAdmits`,
`accountingPolicyCombination`, `effectKey`, the identifier makers, `canonicalPostingReferenceBody`,
`createCanonicalPostingReference` and `validateCanonicalPostingReferenceHash`.

How a TypeScript type is written here:

- An `interface` is a `structure` with the same field names in the same order; an interface that
  `extends` another is a structure that `extends` the other. An optional field is an `Option`, a
  `readonly T[]` a `List T`, a `bigint` an `Int`.
- A union of string literals is an inductive with one constructor each, spelled as the literal,
  with `text` giving the literal back (what `canonicalize` writes when it hashes the field). A union
  written inline has no name in the TypeScript; it gets one here, and its doc comment says which
  field it is the type of. A literal with a hyphen (`"cumulative-posted-allocation-v1"`) is a
  constructor in camel case, and `text` spells it as the TypeScript does.
- A discriminated union is one inductive with one constructor a case; the discriminant (`kind`,
  `type`, `disposition`) is the constructor, and a function gives its string where the TypeScript
  reads it (`AccountingPolicy.kind`, `AccountingEffect.type`).
- `Omit<T, "contentHash">`, which the TypeScript uses as the type of what is hashed or requested,
  is a structure `TBody`, and `T` extends it with `contentHash`. This is done for every type the
  TypeScript writes `Omit<T, "contentHash">` of: `CanonicalPostingReference`,
  `ProvisionalInventoryLayer`, `OpenItem`, `Settlement`, `SettlementAllocation` (here), and
  `BookConfigurationSnapshot` and `AccountingReadSnapshot` (in the files that hold them); not for
  `AccountingPolicyArtifactCore`, whose `Omit` (line 79) is the open parameter type
  `Omit<...> & Record<string, unknown>` of `hashAccountingPolicyArtifact`, a function of
  `Accounting/Core.lean`.
- A branded string is a structure around a `String` (`Identifier Kind`, `EffectKey`).

Meaning: for every record that holds an exact number or an identifier, `WF` says that each exact
number in it is constructible (`ExactRational.WF`, `ExactDecimal.WF`) and each identifier is valid
(`Identifier.WF`), through every field, option and list. `WF` says nothing about instants, local
dates, semantic versions, effect keys, content hashes or plain strings: the kernel checks some of
those itself (`validAccountingDerivation` parses `recordedAt`, `calculateInventoryValueAdjustment`
trims `generatedEffectKey`, every hash is recomputed), and a law must prove those checks, not assume
them. A law that needs one adds it as its own hypothesis. `SourceEvidence.WF`,
`DerivationRecord.WF`, `QuantizationPolicy.WF` and `QuantizedValue.WF` are defined here, in their
own section, because no earlier file defines them.

What the TypeScript type says and the Lean type cannot:

- A JavaScript object may carry properties its type does not name, and `canonicalize` hashes every
  own property; a Lean structure has exactly its fields. The basis projection tests for two such
  properties (`"amount" in event`, `accounting.ts` line 1401); here that test always passes.
- `SettlementRequest` is an intersection with a union of three cases on `operation` and
  `appliedAt`; here it is one structure with both fields optional, and `SettlementRequest.Typed`
  says which combinations the union admits. `calculateSettlement` tests the combination at run
  time (line 1208), so the model keeps the combinations the type excludes and the test means
  something.
- `SettlementReadContext` is an object of six functions: a structure of functions, which has no
  `DecidableEq` or `Repr`.

Left to `Accounting/Core.lean`, because they need `canonicalize`, `accountingHash` or the helpers
of lines 682 to 865: `hashAccountingPolicyArtifact` (line 79) and `planAllocationPostings`
(line 527).
-/
import Rastrata.Prelude
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Journal.Admission
import Rastrata.Kernel.Policy.Types
import Rastrata.Kernel.Quantization
import Rastrata.Kernel.QuantizationBalanced
import Rastrata.Kernel.Lots

namespace Rastrata.Kernel

/-! ## Capabilities (`accounting.ts` lines 33 to 74) -/

/-- `AccountingFeature`. -/
inductive AccountingFeature where
  | inventoryCost
  | inventoryValueAdjustment
  | provisionalInventory
  | openItemSettlement
  | accountingBasis
  | monetaryClassification
  | currencyRemeasurement
  | allocationSchedule
  | taxDetermination
  | consolidation
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AccountingFeature`. -/
def AccountingFeature.text : AccountingFeature → String
  | .inventoryCost => "inventoryCost"
  | .inventoryValueAdjustment => "inventoryValueAdjustment"
  | .provisionalInventory => "provisionalInventory"
  | .openItemSettlement => "openItemSettlement"
  | .accountingBasis => "accountingBasis"
  | .monetaryClassification => "monetaryClassification"
  | .currencyRemeasurement => "currencyRemeasurement"
  | .allocationSchedule => "allocationSchedule"
  | .taxDetermination => "taxDetermination"
  | .consolidation => "consolidation"

/-- `AccountingCapabilityCombination`. The three axes are plain strings in the TypeScript. -/
structure AccountingCapabilityCombination where
  method : Option String
  frequency : Option String
  convention : Option String
  deriving DecidableEq, Repr, Inhabited

/-- The type of `AccountingCapability.status`. -/
inductive AccountingCapabilityStatus where
  | supported
  | experimental
  | unsupported
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AccountingCapabilityStatus`. -/
def AccountingCapabilityStatus.text : AccountingCapabilityStatus → String
  | .supported => "supported"
  | .experimental => "experimental"
  | .unsupported => "unsupported"

/-- `AccountingCapability`. -/
structure AccountingCapability where
  feature : AccountingFeature
  status : AccountingCapabilityStatus
  implementationVersion : SemanticVersion
  verificationEvidenceIds : List EvidenceId
  admittedCombinations : List AccountingCapabilityCombination
  deriving DecidableEq, Repr, Inhabited

/-- `accountingCapabilityAdmits` (`accounting.ts` line 58). An axis the admitted combination leaves
out admits anything; an axis it names must be named the same by the policy, so a policy that leaves
out an axis an admitted combination names is not admitted by it (`undefined === "x"` is false). -/
def accountingCapabilityAdmits (capability : AccountingCapability)
    (combination : AccountingCapabilityCombination) : Bool :=
  if capability.admittedCombinations.length = 0 then false
  else if combination.method = none ∧ combination.frequency = none ∧
      combination.convention = none then true
  else capability.admittedCombinations.any fun admitted =>
    (admitted.method = none || decide (combination.method = admitted.method)) &&
    (admitted.frequency = none || decide (combination.frequency = admitted.frequency)) &&
    (admitted.convention = none || decide (combination.convention = admitted.convention))

/-! ## Policies (`accounting.ts` lines 75 to 219) -/

/-- `AccountingPolicyArtifactCore`: what every artifact nested in a policy carries. -/
structure AccountingPolicyArtifactCore where
  id : PolicyId
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingPolicyCore` (not exported by the TypeScript): what every accounting policy
carries. -/
structure AccountingPolicyCore where
  id : PolicyId
  version : SemanticVersion
  bookId : BookId
  validFrom : Instant
  validTo : Option Instant
  algorithmVersion : SemanticVersion
  quantizationPolicy : QuantizationPolicy
  capability : AccountingCapability
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryCostMethod`. -/
inductive InventoryCostMethod where
  | specificIdentification
  | fifo
  | lifo
  | hifo
  | weightedAverage
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryCostMethod`. -/
def InventoryCostMethod.text : InventoryCostMethod → String
  | .specificIdentification => "specificIdentification"
  | .fifo => "fifo"
  | .lifo => "lifo"
  | .hifo => "hifo"
  | .weightedAverage => "weightedAverage"

/-- `InventoryPool`. -/
structure InventoryPool extends AccountingPolicyArtifactCore where
  accountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- The type of `InventoryCostPolicy.shortageTreatment`. -/
inductive InventoryShortageTreatment where
  | reject
  | provisionalNegative
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryShortageTreatment`. -/
def InventoryShortageTreatment.text : InventoryShortageTreatment → String
  | .reject => "reject"
  | .provisionalNegative => "provisionalNegative"

/-- The type of `InventoryCostPolicy.provisionalBasisMethod`. -/
inductive ProvisionalBasisMethod where
  | lastReceiptCost
  | movingAverage
  | standardCost
  | explicitRate
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `ProvisionalBasisMethod`. -/
def ProvisionalBasisMethod.text : ProvisionalBasisMethod → String
  | .lastReceiptCost => "lastReceiptCost"
  | .movingAverage => "movingAverage"
  | .standardCost => "standardCost"
  | .explicitRate => "explicitRate"

/-- `InventoryCostPolicy`. Its `kind` (`"inventoryCost"`) is the constructor of
`AccountingPolicy` that holds it. -/
structure InventoryCostPolicy extends AccountingPolicyCore where
  method : InventoryCostMethod
  pools : List InventoryPool
  shortageTreatment : InventoryShortageTreatment
  provisionalBasisMethod : Option ProvisionalBasisMethod
  provisionalRate : Option ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryValueAdjustmentKind`. -/
inductive InventoryValueAdjustmentKind where
  | directlyAttributableCost
  | purchaseRebate
  | productionOverhead
  | writeDown
  | writeDownReversal
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryValueAdjustmentKind`. -/
def InventoryValueAdjustmentKind.text : InventoryValueAdjustmentKind → String
  | .directlyAttributableCost => "directlyAttributableCost"
  | .purchaseRebate => "purchaseRebate"
  | .productionOverhead => "productionOverhead"
  | .writeDown => "writeDown"
  | .writeDownReversal => "writeDownReversal"

/-- `InventoryValueAdjustmentPolicy`; its `kind` is `"inventoryValueAdjustment"`. -/
structure InventoryValueAdjustmentPolicy extends AccountingPolicyCore where
  inventoryCostPolicyId : PolicyId
  inventoryCostPolicyVersion : SemanticVersion
  allowedKinds : List InventoryValueAdjustmentKind
  inventoryAccountId : AccountId
  recognizedCostAccountId : AccountId
  adjustmentAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- The type of `AccountingBasisRule.event` (`AccountingBasisRule["event"]`). -/
inductive AccountingBasisEvent where
  | recognition
  | settlement
  | creditApplication
  | writeOff
  | tax
  | inventoryCost
  | nonCash
  | rounding
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AccountingBasisEvent`. -/
def AccountingBasisEvent.text : AccountingBasisEvent → String
  | .recognition => "recognition"
  | .settlement => "settlement"
  | .creditApplication => "creditApplication"
  | .writeOff => "writeOff"
  | .tax => "tax"
  | .inventoryCost => "inventoryCost"
  | .nonCash => "nonCash"
  | .rounding => "rounding"

/-- The type of `AccountingBasisRule.treatment` (`AccountingBasisRule["treatment"]`). -/
inductive AccountingBasisTreatment where
  | recognizeAtAccountingDate
  | recognizeAtSettlement
  | allocateBySettlementRatio
  | carryThrough
  | exclude
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AccountingBasisTreatment`. -/
def AccountingBasisTreatment.text : AccountingBasisTreatment → String
  | .recognizeAtAccountingDate => "recognizeAtAccountingDate"
  | .recognizeAtSettlement => "recognizeAtSettlement"
  | .allocateBySettlementRatio => "allocateBySettlementRatio"
  | .carryThrough => "carryThrough"
  | .exclude => "exclude"

/-- `AccountingBasisRule`. -/
structure AccountingBasisRule extends AccountingPolicyArtifactCore where
  event : AccountingBasisEvent
  treatment : AccountingBasisTreatment
  deriving DecidableEq, Repr, Inhabited

/-- The type of `AccountingBasisPolicy.basis`, and of `BookFinancialIdentity.primaryBasis`
(`book.ts` line 172). -/
inductive AccountingBasis where
  | accrual
  | cash
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AccountingBasis`. -/
def AccountingBasis.text : AccountingBasis → String
  | .accrual => "accrual"
  | .cash => "cash"

/-- `AccountingBasisPolicy`; its `kind` is `"accountingBasis"`. -/
structure AccountingBasisPolicy extends AccountingPolicyCore where
  basis : AccountingBasis
  rules : List AccountingBasisRule
  deriving DecidableEq, Repr, Inhabited

/-- `CurrencyPolicy`; its `kind` is `"currencyRemeasurement"`. -/
structure CurrencyPolicy extends AccountingPolicyCore where
  reversalRequired : Bool
  gainAccountId : AccountId
  lossAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- The type of `MonetaryClassificationRule.classification`, and of
`CurrencyRemeasurementRequest.classification` (`accounting.ts` line 1498). -/
inductive MonetaryClassification where
  | monetary
  | nonMonetary
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `MonetaryClassification`. -/
def MonetaryClassification.text : MonetaryClassification → String
  | .monetary => "monetary"
  | .nonMonetary => "nonMonetary"

/-- `MonetaryClassificationRule`. -/
structure MonetaryClassificationRule extends AccountingPolicyArtifactCore where
  accountId : AccountId
  classification : MonetaryClassification
  deriving DecidableEq, Repr, Inhabited

/-- `MonetaryClassificationPolicy`; its `kind` is `"monetaryClassification"`. -/
structure MonetaryClassificationPolicy extends AccountingPolicyCore where
  rules : List MonetaryClassificationRule
  deriving DecidableEq, Repr, Inhabited

/-- The literal `"cumulative-posted-allocation-v1"`: the type of `AllocationPolicy.postingAlgorithm`
and of `AllocationPostingPlan.algorithmVersion`. -/
inductive AllocationPostingAlgorithm where
  | cumulativePostedAllocationV1
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AllocationPostingAlgorithm`. -/
def AllocationPostingAlgorithm.text : AllocationPostingAlgorithm → String
  | .cumulativePostedAllocationV1 => "cumulative-posted-allocation-v1"

/-- The type of `AllocationPolicy.method`. -/
inductive AllocationMethod where
  | straightLine
  | decliningBalance
  | unitsOfProduction
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AllocationMethod`. -/
def AllocationMethod.text : AllocationMethod → String
  | .straightLine => "straightLine"
  | .decliningBalance => "decliningBalance"
  | .unitsOfProduction => "unitsOfProduction"

/-- The type of `AllocationPolicy.frequency`. -/
inductive AllocationFrequency where
  | monthly
  | quarterly
  | annual
  | eventDriven
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AllocationFrequency`. -/
def AllocationFrequency.text : AllocationFrequency → String
  | .monthly => "monthly"
  | .quarterly => "quarterly"
  | .annual => "annual"
  | .eventDriven => "eventDriven"

/-- The type of `AllocationPolicy.convention`. -/
inductive AllocationConvention where
  | actualDays
  | fullPeriod
  | halfYear
  | midMonth
  | usageEvent
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AllocationConvention`. -/
def AllocationConvention.text : AllocationConvention → String
  | .actualDays => "actualDays"
  | .fullPeriod => "fullPeriod"
  | .halfYear => "halfYear"
  | .midMonth => "midMonth"
  | .usageEvent => "usageEvent"

/-- `AllocationPolicy`; its `kind` is `"allocationSchedule"`. The TypeScript writes
`postingAlgorithm` before `kind`; here the fields of `AccountingPolicyCore` come first, as for every
policy. -/
structure AllocationPolicy extends AccountingPolicyCore where
  postingAlgorithm : Option AllocationPostingAlgorithm
  method : AllocationMethod
  frequency : AllocationFrequency
  convention : AllocationConvention
  decliningRate : Option ExactRational
  expectedUsage : Option ExactRational
  allocationAccountId : AccountId
  contraAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- The type of `TaxPolicyComponent.inclusion`. -/
inductive TaxInclusion where
  | exclusive
  | inclusive
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `TaxInclusion`. -/
def TaxInclusion.text : TaxInclusion → String
  | .exclusive => "exclusive"
  | .inclusive => "inclusive"

/-- The type of `TaxPolicyComponent.treatment`. -/
inductive TaxTreatment where
  | outputTax
  | inputTax
  | reverseCharge
  | withholding
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `TaxTreatment`. -/
def TaxTreatment.text : TaxTreatment → String
  | .outputTax => "outputTax"
  | .inputTax => "inputTax"
  | .reverseCharge => "reverseCharge"
  | .withholding => "withholding"

/-- The type of `TaxPolicyComponent.recoverability`. -/
inductive TaxRecoverability where
  | recoverable
  | nonRecoverable
  | partiallyRecoverable
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `TaxRecoverability`. -/
def TaxRecoverability.text : TaxRecoverability → String
  | .recoverable => "recoverable"
  | .nonRecoverable => "nonRecoverable"
  | .partiallyRecoverable => "partiallyRecoverable"

/-- `TaxPolicyComponent`. -/
structure TaxPolicyComponent extends AccountingPolicyArtifactCore where
  rate : ExactRational
  inclusion : TaxInclusion
  treatment : TaxTreatment
  recoverability : TaxRecoverability
  recoverableShare : ExactRational
  compoundOrdinal : Int
  compoundsOn : List PolicyId
  liabilityAccountId : AccountId
  recoverableAccountId : Option AccountId
  nonRecoverableAccountId : Option AccountId
  deriving DecidableEq, Repr, Inhabited

/-- `TaxRoundingLevel`. -/
inductive TaxRoundingLevel where
  | lineLevel
  | documentLevel
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `TaxRoundingLevel`. -/
def TaxRoundingLevel.text : TaxRoundingLevel → String
  | .lineLevel => "lineLevel"
  | .documentLevel => "documentLevel"

/-- The literal `"structural-tax-groups-v1"`: the type of `TaxPolicy.groupingAlgorithm`. -/
inductive TaxGroupingAlgorithm where
  | structuralTaxGroupsV1
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `TaxGroupingAlgorithm`. -/
def TaxGroupingAlgorithm.text : TaxGroupingAlgorithm → String
  | .structuralTaxGroupsV1 => "structural-tax-groups-v1"

/-- `TaxPolicy`; its `kind` is `"taxDetermination"`. -/
structure TaxPolicy extends AccountingPolicyCore where
  taxCode : String
  jurisdiction : String
  roundingLevel : TaxRoundingLevel
  groupingAlgorithm : Option TaxGroupingAlgorithm
  components : List TaxPolicyComponent
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationAccountMapping`. -/
structure ConsolidationAccountMapping extends AccountingPolicyArtifactCore where
  sourceBookId : Option BookId
  sourceAccountId : AccountId
  targetAccountId : AccountId
  validFrom : Instant
  validTo : Option Instant
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationValuationPolicy`. It is not an artifact: it has an `id` but no `contentHash`. -/
structure ConsolidationValuationPolicy where
  id : PolicyId
  version : SemanticVersion
  validFrom : Instant
  validTo : Option Instant
  maximumHops : Int
  allowInverseObservation : Bool
  preferDirectObservation : Bool
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationTranslationRule`. -/
structure ConsolidationTranslationRule extends AccountingPolicyArtifactCore where
  sourceBookId : Option BookId
  sourceAccountId : AccountId
  targetAccountId : AccountId
  validFrom : Instant
  validTo : Option Instant
  valuationPolicy : ConsolidationValuationPolicy
  deriving DecidableEq, Repr, Inhabited

/-- The element type of `ConsolidationPolicy.supportedMethods`, and the type of
`ConsolidationSource.method` (`accounting.ts` line 2027). -/
inductive ConsolidationMethod where
  | full
  | equity
  | jointOperationShare
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `ConsolidationMethod`. -/
def ConsolidationMethod.text : ConsolidationMethod → String
  | .full => "full"
  | .equity => "equity"
  | .jointOperationShare => "jointOperationShare"

/-- `ConsolidationPolicy`; its `kind` is `"consolidation"`. -/
structure ConsolidationPolicy extends AccountingPolicyCore where
  supportedMethods : List ConsolidationMethod
  accountMappings : List ConsolidationAccountMapping
  translationRules : List ConsolidationTranslationRule
  valuationPolicy : ConsolidationValuationPolicy
  translationAdjustmentAccountId : AccountId
  parentAttributableEquityAccountId : AccountId
  nonControllingInterestAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingPolicy`: one constructor a `kind`, in the order of the TypeScript union, each holding
the policy of that kind. -/
inductive AccountingPolicy where
  | inventoryCost (policy : InventoryCostPolicy)
  | inventoryValueAdjustment (policy : InventoryValueAdjustmentPolicy)
  | accountingBasis (policy : AccountingBasisPolicy)
  | monetaryClassification (policy : MonetaryClassificationPolicy)
  | currencyRemeasurement (policy : CurrencyPolicy)
  | allocationSchedule (policy : AllocationPolicy)
  | taxDetermination (policy : TaxPolicy)
  | consolidation (policy : ConsolidationPolicy)
  deriving DecidableEq, Repr, Inhabited

namespace AccountingPolicy

/-- `policy.kind`, as the `AccountingFeature` of the same spelling (`policyAt` compares it with
`capability.feature`); its string is `policy.kind.text`. -/
def kind : AccountingPolicy → AccountingFeature
  | .inventoryCost _ => .inventoryCost
  | .inventoryValueAdjustment _ => .inventoryValueAdjustment
  | .accountingBasis _ => .accountingBasis
  | .monetaryClassification _ => .monetaryClassification
  | .currencyRemeasurement _ => .currencyRemeasurement
  | .allocationSchedule _ => .allocationSchedule
  | .taxDetermination _ => .taxDetermination
  | .consolidation _ => .consolidation

/-- The fields every policy carries (`AccountingPolicyCore`). -/
def core : AccountingPolicy → AccountingPolicyCore
  | .inventoryCost policy => policy.toAccountingPolicyCore
  | .inventoryValueAdjustment policy => policy.toAccountingPolicyCore
  | .accountingBasis policy => policy.toAccountingPolicyCore
  | .monetaryClassification policy => policy.toAccountingPolicyCore
  | .currencyRemeasurement policy => policy.toAccountingPolicyCore
  | .allocationSchedule policy => policy.toAccountingPolicyCore
  | .taxDetermination policy => policy.toAccountingPolicyCore
  | .consolidation policy => policy.toAccountingPolicyCore

/-- `policy.id`. -/
def id (policy : AccountingPolicy) : PolicyId := policy.core.id

/-- `policy.version`. -/
def version (policy : AccountingPolicy) : SemanticVersion := policy.core.version

/-- `policy.bookId`. -/
def bookId (policy : AccountingPolicy) : BookId := policy.core.bookId

/-- `policy.validFrom`. -/
def validFrom (policy : AccountingPolicy) : Instant := policy.core.validFrom

/-- `policy.validTo`. -/
def validTo (policy : AccountingPolicy) : Option Instant := policy.core.validTo

/-- `policy.algorithmVersion`. -/
def algorithmVersion (policy : AccountingPolicy) : SemanticVersion := policy.core.algorithmVersion

/-- `policy.quantizationPolicy`. -/
def quantizationPolicy (policy : AccountingPolicy) : QuantizationPolicy :=
  policy.core.quantizationPolicy

/-- `policy.capability`. -/
def capability (policy : AccountingPolicy) : AccountingCapability := policy.core.capability

end AccountingPolicy

/-- `accountingPolicyCombination` (`accounting.ts` line 67): the axes a policy declares, as the
strings the TypeScript compares. -/
def accountingPolicyCombination : AccountingPolicy → AccountingCapabilityCombination
  | .inventoryCost policy =>
    { method := some policy.method.text, frequency := none, convention := none }
  | .allocationSchedule policy =>
    { method := some policy.method.text, frequency := some policy.frequency.text,
      convention := some policy.convention.text }
  | .accountingBasis policy =>
    { method := some policy.basis.text, frequency := none, convention := none }
  | _ => { method := none, frequency := none, convention := none }

/-- `AccountingPolicySnapshot`. -/
structure AccountingPolicySnapshot where
  policies : List AccountingPolicy
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## Effect keys and canonical posting references (`accounting.ts` lines 221 to 286) -/

/-- `EffectKey`: a branded string. Built only by `effectKey`, as in the TypeScript. -/
structure EffectKey where
  value : String
  deriving DecidableEq, Repr, Inhabited

/-- The `RangeError` of `effectKey`: `Effect key must not be empty`. -/
inductive EffectKeyErr where
  | emptyEffectKey
  deriving DecidableEq, Repr, Inhabited

/-- `effectKey` (`accounting.ts` line 234). `value.trim().length === 0` counts UTF-16 code units
and the model counts characters; both are zero exactly when the trimmed text is empty. -/
def effectKey (value : String) : Except EffectKeyErr EffectKey :=
  if (jsTrim value).length = 0 then .error .emptyEffectKey else .ok ⟨value⟩

/-- What `effectKey` guarantees of the key it returns. It is not part of any record's `WF`:
`calculateInventoryValueAdjustment` tests it again (`accounting.ts` line 1063). -/
def EffectKey.WF (key : EffectKey) : Prop := jsTrim key.value ≠ ""

/-- `CanonicalPostingReferenceId`. -/
abbrev CanonicalPostingReferenceId := Identifier "CanonicalPostingReference"

/-- `canonicalPostingReferenceId` (`accounting.ts` line 239). -/
def canonicalPostingReferenceId (value : String) :
    Except CanonicalErr CanonicalPostingReferenceId :=
  identifier "CanonicalPostingReference" value

/-- `Omit<CanonicalPostingReference, "contentHash">`: what the content hash of a reference
covers. -/
structure CanonicalPostingReferenceBody where
  id : CanonicalPostingReferenceId
  bookId : BookId
  journalId : JournalId
  postingId : PostingId
  effectKey : EffectKey
  postingContentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `CanonicalPostingReference`. -/
structure CanonicalPostingReference extends CanonicalPostingReferenceBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `canonicalPostingReferenceBody` (`accounting.ts` line 243): every field of the body, the
posting's content hash as its three fields. -/
def canonicalPostingReferenceBody (value : CanonicalPostingReferenceBody) : CanonicalValue :=
  .record [
    ("id", .string value.id.value),
    ("bookId", .string value.bookId.value),
    ("journalId", .string value.journalId.value),
    ("postingId", .string value.postingId.value),
    ("effectKey", .string value.effectKey.value),
    ("postingContentHash", .record [
      ("algorithm", .string value.postingContentHash.algorithm),
      ("canonicalizationVersion", .string value.postingContentHash.canonicalizationVersion),
      ("digest", .string value.postingContentHash.digest)])]

/-- `createCanonicalPostingReference` (`accounting.ts` line 260). -/
def createCanonicalPostingReference (id : CanonicalPostingReferenceId) (bookId : BookId)
    (journalId : JournalId) (posting : Posting) (sourceEffectKey : EffectKey) :
    CanonicalPostingReference :=
  let body : CanonicalPostingReferenceBody :=
    { id, bookId, journalId, postingId := posting.id, effectKey := sourceEffectKey,
      postingContentHash := hashCanonical (canonicalPostingValue posting) }
  { toCanonicalPostingReferenceBody := body,
    contentHash := hashCanonical (canonicalPostingReferenceBody body) }

/-- `validateCanonicalPostingReferenceHash` (`accounting.ts` line 278): both hashes are of the
current algorithm and canonicalization, and the content hash is the hash of the body. The posting's
content hash is not recomputed (the posting is not at hand). -/
def validateCanonicalPostingReferenceHash (reference : CanonicalPostingReference) : Bool :=
  reference.postingContentHash.algorithm == contentHashAlgorithm &&
  reference.postingContentHash.canonicalizationVersion == canonicalizationVersion &&
  reference.contentHash.algorithm == contentHashAlgorithm &&
  reference.contentHash.canonicalizationVersion == canonicalizationVersion &&
  contentHashEquals reference.contentHash
    (hashCanonical (canonicalPostingReferenceBody reference.toCanonicalPostingReferenceBody))

/-! ## Prepared journals (`accounting.ts` lines 288 to 310) -/

/-- The type of `ExactPreparedPosting.costBasis`, unnamed in the TypeScript. -/
structure PreparedCostBasis where
  totalBasis : ExactRational
  basisCommodityId : CommodityId
  deriving DecidableEq, Repr, Inhabited

/-- `ExactPreparedPosting`. -/
structure ExactPreparedPosting where
  id : PostingId
  accountId : AccountId
  units : ExactRational
  unitsCommodityId : CommodityId
  exactBookValue : ExactRational
  costBasis : Option PreparedCostBasis
  deriving DecidableEq, Repr, Inhabited

/-- The type of `ExactPreparedJournal.kind`: three of the five `JournalKind`s. -/
inductive PreparedJournalKind where
  | ordinary
  | adjustment
  | reversing
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `PreparedJournalKind`. -/
def PreparedJournalKind.text : PreparedJournalKind → String
  | .ordinary => "ordinary"
  | .adjustment => "adjustment"
  | .reversing => "reversing"

/-- The `JournalKind` of the same spelling. -/
def PreparedJournalKind.toJournalKind : PreparedJournalKind → JournalKind
  | .ordinary => .ordinary
  | .adjustment => .adjustment
  | .reversing => .reversing

/-- `ExactPreparedJournal`. -/
structure ExactPreparedJournal where
  requiredQuantizationPolicy : Option QuantizationPolicy
  id : JournalId
  kind : PreparedJournalKind
  economicAt : Instant
  accountingDate : LocalDate
  recordedAt : Instant
  narration : String
  postings : List ExactPreparedPosting
  derivations : List DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-! ## Identifier types and their makers (`accounting.ts` lines 312 to 338) -/

/-- `ProvisionalInventoryLayerId`. -/
abbrev ProvisionalInventoryLayerId := Identifier "ProvisionalInventoryLayer"

/-- `InventoryRecostingId`. -/
abbrev InventoryRecostingId := Identifier "InventoryRecosting"

/-- `InventoryValueAdjustmentId`. -/
abbrev InventoryValueAdjustmentId := Identifier "InventoryValueAdjustment"

/-- `OpenItemId`. -/
abbrev OpenItemId := Identifier "OpenItem"

/-- `SettlementId`. -/
abbrev SettlementId := Identifier "Settlement"

/-- `SettlementAllocationId`. -/
abbrev SettlementAllocationId := Identifier "SettlementAllocation"

/-- `RemeasurementResultId`. -/
abbrev RemeasurementResultId := Identifier "RemeasurementResult"

/-- `RemeasurementReversalId`. -/
abbrev RemeasurementReversalId := Identifier "RemeasurementReversal"

/-- `AllocationScheduleId`. -/
abbrev AllocationScheduleId := Identifier "AllocationSchedule"

/-- `AllocationRecognitionId`. -/
abbrev AllocationRecognitionId := Identifier "AllocationRecognition"

/-- `AllocationScheduleRevisionId`. -/
abbrev AllocationScheduleRevisionId := Identifier "AllocationScheduleRevision"

/-- `TaxDeterminationId`. -/
abbrev TaxDeterminationId := Identifier "TaxDetermination"

/-- `ConsolidationCompilationId`. -/
abbrev ConsolidationCompilationId := Identifier "ConsolidationCompilation"

/-- `provisionalInventoryLayerId`. -/
def provisionalInventoryLayerId (value : String) :
    Except CanonicalErr ProvisionalInventoryLayerId :=
  identifier "ProvisionalInventoryLayer" value

/-- `inventoryRecostingId`. -/
def inventoryRecostingId (value : String) : Except CanonicalErr InventoryRecostingId :=
  identifier "InventoryRecosting" value

/-- `inventoryValueAdjustmentId`. -/
def inventoryValueAdjustmentId (value : String) : Except CanonicalErr InventoryValueAdjustmentId :=
  identifier "InventoryValueAdjustment" value

/-- `openItemId`. -/
def openItemId (value : String) : Except CanonicalErr OpenItemId := identifier "OpenItem" value

/-- `settlementId`. -/
def settlementId (value : String) : Except CanonicalErr SettlementId :=
  identifier "Settlement" value

/-- `settlementAllocationId`. -/
def settlementAllocationId (value : String) : Except CanonicalErr SettlementAllocationId :=
  identifier "SettlementAllocation" value

/-- `remeasurementResultId`. -/
def remeasurementResultId (value : String) : Except CanonicalErr RemeasurementResultId :=
  identifier "RemeasurementResult" value

/-- `remeasurementReversalId`. -/
def remeasurementReversalId (value : String) : Except CanonicalErr RemeasurementReversalId :=
  identifier "RemeasurementReversal" value

/-- `allocationScheduleId`. -/
def allocationScheduleId (value : String) : Except CanonicalErr AllocationScheduleId :=
  identifier "AllocationSchedule" value

/-- `allocationRecognitionId`. -/
def allocationRecognitionId (value : String) : Except CanonicalErr AllocationRecognitionId :=
  identifier "AllocationRecognition" value

/-- `allocationScheduleRevisionId`. -/
def allocationScheduleRevisionId (value : String) :
    Except CanonicalErr AllocationScheduleRevisionId :=
  identifier "AllocationScheduleRevision" value

/-- `taxDeterminationId`. -/
def taxDeterminationId (value : String) : Except CanonicalErr TaxDeterminationId :=
  identifier "TaxDetermination" value

/-- `consolidationCompilationId`. -/
def consolidationCompilationId (value : String) : Except CanonicalErr ConsolidationCompilationId :=
  identifier "ConsolidationCompilation" value

/-! ## Inventory (`accounting.ts` lines 340 to 402) -/

/-- `InventoryLayerInput`. Its `id` is a plain string, not an identifier. -/
structure InventoryLayerInput where
  id : String
  accountId : AccountId
  acquiredAt : Instant
  quantity : ExactRational
  totalBasis : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryAllocationResult`. -/
structure InventoryAllocationResult where
  layerId : String
  quantity : ExactRational
  basis : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<ProvisionalInventoryLayer, "contentHash">` (`accounting.ts` line 875). -/
structure ProvisionalInventoryLayerBody where
  id : ProvisionalInventoryLayerId
  bookId : BookId
  policyId : PolicyId
  policy : Option InventoryCostPolicy
  issueSource : Option CanonicalPostingReference
  /-- Deprecated in the TypeScript: use `issueSource`. -/
  issuePostingId : Option PostingId
  openedAt : Instant
  quantity : ExactRational
  provisionalBasis : ExactRational
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `ProvisionalInventoryLayer`. -/
structure ProvisionalInventoryLayer extends ProvisionalInventoryLayerBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryRecostingSource`. -/
structure InventoryRecostingSource where
  receiptId : String
  quantity : ExactRational
  totalBasis : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryRecosting`. -/
structure InventoryRecosting where
  id : InventoryRecostingId
  layerId : ProvisionalInventoryLayerId
  resolvedAt : Instant
  sources : List InventoryRecostingSource
  adjustment : ExactRational
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryValueAdjustmentAllocation`. -/
structure InventoryValueAdjustmentAllocation where
  ordinal : Int
  lotId : LotId
  holdingId : Option LotHoldingId
  remainingBasisChange : ExactRational
  recognizedCostChange : ExactRational
  remainingValuationAllowanceChange : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryValueAdjustment`. `evidence` is `DerivationRecord["evidence"]`. -/
structure InventoryValueAdjustment where
  id : InventoryValueAdjustmentId
  kind : InventoryValueAdjustmentKind
  effectiveOn : LocalDate
  generatedEffectKey : EffectKey
  bookId : BookId
  policy : InventoryValueAdjustmentPolicy
  exactSourceAmount : ExactRational
  allocations : List InventoryValueAdjustmentAllocation
  bookedAdjustment : QuantizedValue
  evidence : List SourceEvidence
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## Open items, settlements and remeasurement (`accounting.ts` lines 404 to 493) -/

/-- `SettlementScope`. `externalPartyId` is a plain string, not an identifier. -/
structure SettlementScope where
  externalPartyId : String
  controlAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- The type of `OpenItem.kind`. -/
inductive OpenItemKind where
  | receivable
  | payable
  | credit
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `OpenItemKind`. -/
def OpenItemKind.text : OpenItemKind → String
  | .receivable => "receivable"
  | .payable => "payable"
  | .credit => "credit"

/-- `Omit<OpenItem, "contentHash">` (`accounting.ts` line 1132). -/
structure OpenItemBody where
  id : OpenItemId
  bookId : BookId
  kind : OpenItemKind
  scope : SettlementScope
  recognitionSource : Option CanonicalPostingReference
  /-- Deprecated in the TypeScript: use `recognitionSource`. -/
  recognitionPostingId : Option PostingId
  recognizedOn : LocalDate
  denominationCommodityId : CommodityId
  denomination : ExactRational
  bookValue : ExactRational
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `OpenItem`. -/
structure OpenItem extends OpenItemBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The type of `Settlement.kind`. -/
inductive SettlementKind where
  | cash
  | creditApplication
  | writeOff
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `SettlementKind`. -/
def SettlementKind.text : SettlementKind → String
  | .cash => "cash"
  | .creditApplication => "creditApplication"
  | .writeOff => "writeOff"

/-- `Omit<Settlement, "contentHash">` (`accounting.ts` line 1144). -/
structure SettlementBody where
  id : SettlementId
  bookId : BookId
  kind : SettlementKind
  scope : SettlementScope
  settlementSource : Option CanonicalPostingReference
  /-- Deprecated in the TypeScript: use `settlementSource`. -/
  settlementPostingId : Option PostingId
  settledAt : Instant
  denominationCommodityId : CommodityId
  denomination : ExactRational
  bookValue : ExactRational
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `Settlement`. -/
structure Settlement extends SettlementBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The type of `SettlementAllocation.valuationPath` (unnamed, `accounting.ts` line 451) and of
`CurrencyRemeasurementRequest.valuationPath` (line 1501), which is
`RemeasurementResult.valuationPath`: the two are written separately in the TypeScript with the same
fields, so they are one type there. -/
structure CurrencyValuationPath where
  fromCommodityId : CommodityId
  toCommodityId : CommodityId
  effectiveAt : Instant
  observedAt : Instant
  rate : ExactRational
  evidenceIds : List EvidenceId
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<SettlementAllocation, "contentHash">` (`accounting.ts` line 1145). -/
structure SettlementAllocationBody where
  id : SettlementAllocationId
  openItemId : OpenItemId
  settlementId : SettlementId
  /-- Present for explicit later applications; absent in frozen legacy edges. -/
  appliedAt : Option Instant
  allocatedBookValue : ExactRational
  allocatedOpenQuantity : ExactRational
  allocatedSettlementQuantity : ExactRational
  allocatedOpenItemBookValue : Option ExactRational
  allocatedSettlementBookValue : Option ExactRational
  settlementMeasurement : Option QuantizedValue
  realizedExchangeDifference : Option QuantizedValue
  valuationPath : Option CurrencyValuationPath
  realizedExchangeEffectKey : Option EffectKey
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `SettlementAllocation`. -/
structure SettlementAllocation extends SettlementAllocationBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The type of `RemeasurementResult.kind`, and of `CurrencyRemeasurementRequest.kind`
(`accounting.ts` line 1498). -/
inductive RemeasurementKind where
  | realized
  | unrealized
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `RemeasurementKind`. -/
def RemeasurementKind.text : RemeasurementKind → String
  | .realized => "realized"
  | .unrealized => "unrealized"

/-- `RemeasurementResult`. -/
structure RemeasurementResult where
  id : RemeasurementResultId
  kind : RemeasurementKind
  sourcePostingId : Option PostingId
  source : Option CanonicalPostingReference
  positionAccountId : Option AccountId
  denominationCommodityId : Option CommodityId
  effectiveOn : LocalDate
  adjustmentEffectKey : Option EffectKey
  carryingBookValue : ExactRational
  measuredBookValue : ExactRational
  difference : ExactRational
  valuationRate : ExactRational
  policyId : PolicyId
  policy : Option CurrencyPolicy
  classificationPolicy : Option MonetaryClassificationPolicy
  valuationPath : Option CurrencyValuationPath
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `RemeasurementReversal`. -/
structure RemeasurementReversal where
  id : RemeasurementReversalId
  originalResultId : RemeasurementResultId
  originalJournalId : Option JournalId
  originalEffectKey : Option EffectKey
  reversedOn : LocalDate
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## Allocation schedules (`accounting.ts` lines 495 to 610; `planAllocationPostings`, lines 527
to 566, is in `Accounting/Core.lean`) -/

/-- `ScheduledAllocation`. -/
structure ScheduledAllocation where
  ordinal : Int
  accountingDate : LocalDate
  amount : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- The element type of `AllocationPostingPlan.installments`, unnamed in the TypeScript. -/
structure AllocationPostingInstallment where
  ordinal : Int
  accountingDate : LocalDate
  exactAmount : ExactRational
  cumulativeTarget : ExactRational
  cumulativeQuantization : QuantizedValue
  postedAmount : ExactDecimal
  exactToPostedDifference : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationPostingPlan`. Its `algorithmVersion` has one possible value. -/
structure AllocationPostingPlan where
  algorithmVersion : AllocationPostingAlgorithm
  exactSourceBasis : ExactRational
  exactResidualValue : ExactRational
  postedSourceBasis : ExactDecimal
  residualQuantization : QuantizedValue
  quantizationPolicy : QuantizationPolicy
  installments : List AllocationPostingInstallment
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationSchedule`. -/
structure AllocationSchedule where
  id : AllocationScheduleId
  bookId : BookId
  policyId : PolicyId
  policy : AllocationPolicy
  source : Option CanonicalPostingReference
  /-- Deprecated in the TypeScript: use `source`. -/
  sourcePostingId : Option PostingId
  sourceBasis : ExactRational
  residualValue : ExactRational
  installments : List ScheduledAllocation
  postingPlan : Option AllocationPostingPlan
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationRecognition`. -/
structure AllocationRecognition where
  id : AllocationRecognitionId
  scheduleId : AllocationScheduleId
  ordinal : Int
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationScheduleChangeKind`. -/
inductive AllocationScheduleChangeKind where
  | estimateChange
  | impairment
  | disposal
  | termination
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `AllocationScheduleChangeKind`. -/
def AllocationScheduleChangeKind.text : AllocationScheduleChangeKind → String
  | .estimateChange => "estimateChange"
  | .impairment => "impairment"
  | .disposal => "disposal"
  | .termination => "termination"

/-- `AllocationScheduleRevision`. `evidence` is `DerivationRecord["evidence"]`. -/
structure AllocationScheduleRevision where
  id : AllocationScheduleRevisionId
  kind : AllocationScheduleChangeKind
  effectiveOn : LocalDate
  generatedEffectKey : Option EffectKey
  originalScheduleId : AllocationScheduleId
  priorRecognitionIds : List AllocationRecognitionId
  recognizedToDate : ExactRational
  carryingAmountAtRevision : ExactRational
  postedRecognizedToDate : Option ExactRational
  postedCarryingAmountAtRevision : Option ExactRational
  revisedResidualValue : ExactRational
  exactAdjustmentAmount : Option ExactRational
  bookedAdjustment : Option QuantizedValue
  successorScheduleId : Option AllocationScheduleId
  policy : AllocationPolicy
  evidence : List SourceEvidence
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## Tax and consolidation (`accounting.ts` lines 612 to 641) -/

/-- `TaxComponentResult`. -/
structure TaxComponentResult where
  policyId : PolicyId
  exactTax : ExactRational
  quantization : QuantizedValue
  recoverable : ExactRational
  nonRecoverable : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `TaxDirection`. -/
inductive TaxDirection where
  | purchase
  | sale
  | purchaseCredit
  | saleCredit
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `TaxDirection`. -/
def TaxDirection.text : TaxDirection → String
  | .purchase => "purchase"
  | .sale => "sale"
  | .purchaseCredit => "purchaseCredit"
  | .saleCredit => "saleCredit"

/-- `TaxLineResult`. `lineId` is a plain string, not an identifier. -/
structure TaxLineResult where
  lineId : String
  policyId : PolicyId
  exclusiveBasis : ExactRational
  components : List TaxComponentResult
  deriving DecidableEq, Repr, Inhabited

/-- `TaxDetermination`. -/
structure TaxDetermination where
  id : TaxDeterminationId
  bookId : BookId
  taxPoint : Instant
  sourceTransactionId : JournalId
  direction : TaxDirection
  lines : List TaxLineResult
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `ConsolidationCompilation`. -/
structure ConsolidationCompilation where
  id : ConsolidationCompilationId
  bookId : BookId
  policyId : PolicyId
  throughOn : LocalDate
  sourcePopulationHashes : List ContentHash
  derivation : DerivationRecord
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## State, effects and calculations (`accounting.ts` lines 643 to 680) -/

/-- `AccountingCanonicalState`. -/
structure AccountingCanonicalState where
  provisionalInventoryLayers : List ProvisionalInventoryLayer
  inventoryRecostings : List InventoryRecosting
  inventoryValueAdjustments : List InventoryValueAdjustment
  openItems : List OpenItem
  settlements : List Settlement
  settlementAllocations : List SettlementAllocation
  remeasurementResults : List RemeasurementResult
  remeasurementReversals : List RemeasurementReversal
  allocationSchedules : List AllocationSchedule
  allocationRecognitions : List AllocationRecognition
  allocationScheduleRevisions : List AllocationScheduleRevision
  taxDeterminations : List TaxDetermination
  consolidationCompilations : List ConsolidationCompilation
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingEffect`: one constructor a `type`, in the order of the TypeScript union, each holding
its `value`. -/
inductive AccountingEffect where
  | provisionalInventoryLayer (value : ProvisionalInventoryLayer)
  | inventoryRecosting (value : InventoryRecosting)
  | inventoryValueAdjustment (value : InventoryValueAdjustment)
  | openItem (value : OpenItem)
  | settlement (value : Settlement)
  | settlementAllocation (value : SettlementAllocation)
  | remeasurementResult (value : RemeasurementResult)
  | remeasurementReversal (value : RemeasurementReversal)
  | allocationSchedule (value : AllocationSchedule)
  | allocationRecognition (value : AllocationRecognition)
  | allocationScheduleRevision (value : AllocationScheduleRevision)
  | taxDetermination (value : TaxDetermination)
  | consolidationCompilation (value : ConsolidationCompilation)
  deriving DecidableEq, Repr, Inhabited

/-- `effect.type`: the string literal of the effect's case. -/
def AccountingEffect.type : AccountingEffect → String
  | .provisionalInventoryLayer _ => "provisionalInventoryLayer"
  | .inventoryRecosting _ => "inventoryRecosting"
  | .inventoryValueAdjustment _ => "inventoryValueAdjustment"
  | .openItem _ => "openItem"
  | .settlement _ => "settlement"
  | .settlementAllocation _ => "settlementAllocation"
  | .remeasurementResult _ => "remeasurementResult"
  | .remeasurementReversal _ => "remeasurementReversal"
  | .allocationSchedule _ => "allocationSchedule"
  | .allocationRecognition _ => "allocationRecognition"
  | .allocationScheduleRevision _ => "allocationScheduleRevision"
  | .taxDetermination _ => "taxDetermination"
  | .consolidationCompilation _ => "consolidationCompilation"

/-- `AccountingDraft`. -/
structure AccountingDraft where
  journals : List ExactPreparedJournal
  effects : List AccountingEffect
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingCalculation`: the two dispositions, `draft` and `rejected`. -/
inductive AccountingCalculation where
  | draft (draft : AccountingDraft)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-! ## Open item and settlement requests (`accounting.ts` lines 1131 to 1165) -/

/-- `OpenItemRecognitionRequest`. -/
structure OpenItemRecognitionRequest where
  value : OpenItemBody
  deriving DecidableEq, Repr, Inhabited

/-- `SettlementRequestCore` (not exported by the TypeScript). -/
structure SettlementRequestCore where
  settlement : SettlementBody
  allocations : List SettlementAllocationBody
  /-- The quantization policy is retained with the settlement calculation so realized exchange
  residuals are reproducible. -/
  quantizationPolicy : Option QuantizationPolicy
  realizedExchangePolicyId : Option PolicyId
  realizedExchangePolicyVersion : Option SemanticVersion
  deriving DecidableEq, Repr, Inhabited

/-- The type of `SettlementRequest.operation` when it is present. -/
inductive SettlementOperation where
  | recognizeUnallocated
  | allocateExisting
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `SettlementOperation`. -/
def SettlementOperation.text : SettlementOperation → String
  | .recognizeUnallocated => "recognizeUnallocated"
  | .allocateExisting => "allocateExisting"

/-- `SettlementRequest`: the core with `operation` and `appliedAt` both optional. Which of their
combinations the TypeScript type admits is `SettlementRequest.Typed`; `calculateSettlement` tests it
at run time (`accounting.ts` line 1208), so the other combinations are kept here. An `operation`
that is none of the two strings, which line 1208 also rejects, cannot be written here. -/
structure SettlementRequest extends SettlementRequestCore where
  operation : Option SettlementOperation
  appliedAt : Option Instant
  deriving DecidableEq, Repr, Inhabited

/-- The three cases of the union in `SettlementRequest` (`accounting.ts` lines 1152 to 1154): no
operation and no application time; `recognizeUnallocated` and no application time; or
`allocateExisting` with an application time. -/
def SettlementRequest.Typed (request : SettlementRequest) : Prop :=
  (request.operation = none ∧ request.appliedAt = none) ∨
  (request.operation = some .recognizeUnallocated ∧ request.appliedAt = none) ∨
  (request.operation = some .allocateExisting ∧ request.appliedAt.isSome)

/-- `"present" | "absent"`: what `SettlementReadContext` answers about an identity. The
`TypeError` of `settlementIdentityPresent` (`accounting.ts` line 1197), for any other answer,
cannot happen here. -/
inductive IdentityObservation where
  | present
  | absent
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `IdentityObservation`. -/
def IdentityObservation.text : IdentityObservation → String
  | .present => "present"
  | .absent => "absent"

/-- The result type of `SettlementReadContext.allocatedFromSettlement` and `allocatedToOpenItem`,
unnamed in the TypeScript. -/
structure AllocatedTotal where
  bookValue : ExactRational
  quantity : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `SettlementReadContext`: six functions. `null` is `none`. The TypeScript tests
`existingSettlement` for `undefined` (`accounting.ts` line 1217), which its type excludes and which
cannot be written here. A structure of functions has no `DecidableEq` and no `Repr`. -/
structure SettlementReadContext where
  openItem : OpenItemId → Option OpenItem
  settlementIdentity : SettlementId → IdentityObservation
  allocationIdentity : SettlementAllocationId → IdentityObservation
  existingSettlement : SettlementId → Option Settlement
  allocatedFromSettlement : SettlementId → AllocatedTotal
  /-- Exact sum of all canonical prior allocations for this open item: its allocated carrying
  value and denomination quantity, not the payment's value. -/
  allocatedToOpenItem : OpenItemId → AllocatedTotal
  deriving Inhabited

/-! ## Meaning: constructible values of the types this file imports

No earlier file says what a constructible `SourceEvidence`, `DerivationRecord`,
`QuantizationPolicy` or `QuantizedValue` is; this section does, in the same terms as the rest of
the file: each exact number constructible and each identifier valid. -/

/-- An item of evidence whose identifier is valid. -/
structure SourceEvidence.WF (evidence : SourceEvidence) : Prop where
  id : evidence.id.WF

/-- A derivation whose identifiers are valid, those of its evidence included. -/
structure DerivationRecord.WF (derivation : DerivationRecord) : Prop where
  id : derivation.id.WF
  policyId : derivation.policyId.WF
  actorId : derivation.actorId.WF
  evidence : ∀ item ∈ derivation.evidence, item.WF

/-- A quantization policy whose identifiers are valid. Its scale is not an exact number and is not
constrained: `quantize` checks it. -/
structure QuantizationPolicy.WF (policy : QuantizationPolicy) : Prop where
  id : policy.id.WF
  bookId : policy.bookId.WF
  functionalCommodityId : policy.functionalCommodityId.WF
  roundingAccountId : policy.roundingAccountId.WF

/-- A quantized value whose amount and residual are constructible. -/
structure QuantizedValue.WF (value : QuantizedValue) : Prop where
  amount : value.amount.WF
  residual : value.residual.WF

/-! ## Meaning: constructible policies -/

/-- A capability whose evidence identifiers are valid. -/
structure AccountingCapability.WF (capability : AccountingCapability) : Prop where
  verificationEvidenceIds : ∀ id ∈ capability.verificationEvidenceIds, id.WF

/-- The fields every policy carries, constructible. -/
structure AccountingPolicyCore.WF (core : AccountingPolicyCore) : Prop where
  id : core.id.WF
  bookId : core.bookId.WF
  quantizationPolicy : core.quantizationPolicy.WF
  capability : core.capability.WF

/-- An inventory pool whose identifiers are valid. -/
structure InventoryPool.WF (pool : InventoryPool) : Prop where
  id : pool.id.WF
  accountId : pool.accountId.WF

/-- A constructible inventory cost policy. -/
structure InventoryCostPolicy.WF (policy : InventoryCostPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  pools : ∀ pool ∈ policy.pools, pool.WF
  provisionalRate : ∀ rate, policy.provisionalRate = some rate → rate.WF

/-- A constructible inventory value adjustment policy. -/
structure InventoryValueAdjustmentPolicy.WF (policy : InventoryValueAdjustmentPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  inventoryCostPolicyId : policy.inventoryCostPolicyId.WF
  inventoryAccountId : policy.inventoryAccountId.WF
  recognizedCostAccountId : policy.recognizedCostAccountId.WF
  adjustmentAccountId : policy.adjustmentAccountId.WF

/-- A basis rule whose identifier is valid. -/
structure AccountingBasisRule.WF (rule : AccountingBasisRule) : Prop where
  id : rule.id.WF

/-- A constructible accounting basis policy. -/
structure AccountingBasisPolicy.WF (policy : AccountingBasisPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  rules : ∀ rule ∈ policy.rules, rule.WF

/-- A constructible currency policy. -/
structure CurrencyPolicy.WF (policy : CurrencyPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  gainAccountId : policy.gainAccountId.WF
  lossAccountId : policy.lossAccountId.WF

/-- A classification rule whose identifiers are valid. -/
structure MonetaryClassificationRule.WF (rule : MonetaryClassificationRule) : Prop where
  id : rule.id.WF
  accountId : rule.accountId.WF

/-- A constructible monetary classification policy. -/
structure MonetaryClassificationPolicy.WF (policy : MonetaryClassificationPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  rules : ∀ rule ∈ policy.rules, rule.WF

/-- A constructible allocation policy. -/
structure AllocationPolicy.WF (policy : AllocationPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  decliningRate : ∀ rate, policy.decliningRate = some rate → rate.WF
  expectedUsage : ∀ usage, policy.expectedUsage = some usage → usage.WF
  allocationAccountId : policy.allocationAccountId.WF
  contraAccountId : policy.contraAccountId.WF

/-- A constructible tax component. -/
structure TaxPolicyComponent.WF (component : TaxPolicyComponent) : Prop where
  id : component.id.WF
  rate : component.rate.WF
  recoverableShare : component.recoverableShare.WF
  compoundsOn : ∀ id ∈ component.compoundsOn, id.WF
  liabilityAccountId : component.liabilityAccountId.WF
  recoverableAccountId : ∀ id, component.recoverableAccountId = some id → id.WF
  nonRecoverableAccountId : ∀ id, component.nonRecoverableAccountId = some id → id.WF

/-- A constructible tax policy. -/
structure TaxPolicy.WF (policy : TaxPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  components : ∀ component ∈ policy.components, component.WF

/-- An account mapping whose identifiers are valid. -/
structure ConsolidationAccountMapping.WF (mapping : ConsolidationAccountMapping) : Prop where
  id : mapping.id.WF
  sourceBookId : ∀ id, mapping.sourceBookId = some id → id.WF
  sourceAccountId : mapping.sourceAccountId.WF
  targetAccountId : mapping.targetAccountId.WF

/-- A valuation policy whose identifier is valid. -/
structure ConsolidationValuationPolicy.WF (policy : ConsolidationValuationPolicy) : Prop where
  id : policy.id.WF

/-- A translation rule whose identifiers are valid. -/
structure ConsolidationTranslationRule.WF (rule : ConsolidationTranslationRule) : Prop where
  id : rule.id.WF
  sourceBookId : ∀ id, rule.sourceBookId = some id → id.WF
  sourceAccountId : rule.sourceAccountId.WF
  targetAccountId : rule.targetAccountId.WF
  valuationPolicy : rule.valuationPolicy.WF

/-- A constructible consolidation policy. -/
structure ConsolidationPolicy.WF (policy : ConsolidationPolicy) : Prop where
  core : policy.toAccountingPolicyCore.WF
  accountMappings : ∀ mapping ∈ policy.accountMappings, mapping.WF
  translationRules : ∀ rule ∈ policy.translationRules, rule.WF
  valuationPolicy : policy.valuationPolicy.WF
  translationAdjustmentAccountId : policy.translationAdjustmentAccountId.WF
  parentAttributableEquityAccountId : policy.parentAttributableEquityAccountId.WF
  nonControllingInterestAccountId : policy.nonControllingInterestAccountId.WF

/-- A constructible accounting policy: the policy of its kind is. -/
def AccountingPolicy.WF : AccountingPolicy → Prop
  | .inventoryCost policy => policy.WF
  | .inventoryValueAdjustment policy => policy.WF
  | .accountingBasis policy => policy.WF
  | .monetaryClassification policy => policy.WF
  | .currencyRemeasurement policy => policy.WF
  | .allocationSchedule policy => policy.WF
  | .taxDetermination policy => policy.WF
  | .consolidation policy => policy.WF

/-- A snapshot whose policies are constructible. -/
structure AccountingPolicySnapshot.WF (snapshot : AccountingPolicySnapshot) : Prop where
  policies : ∀ policy ∈ snapshot.policies, policy.WF

/-! ## Meaning: constructible references, prepared journals and artifacts -/

/-- The body of a reference whose identifiers are valid. -/
structure CanonicalPostingReferenceBody.WF (body : CanonicalPostingReferenceBody) : Prop where
  id : body.id.WF
  bookId : body.bookId.WF
  journalId : body.journalId.WF
  postingId : body.postingId.WF

/-- A reference whose identifiers are valid. -/
def CanonicalPostingReference.WF (reference : CanonicalPostingReference) : Prop :=
  reference.toCanonicalPostingReferenceBody.WF

/-- A constructible cost basis of a prepared posting. -/
structure PreparedCostBasis.WF (basis : PreparedCostBasis) : Prop where
  totalBasis : basis.totalBasis.WF
  basisCommodityId : basis.basisCommodityId.WF

/-- A constructible prepared posting. -/
structure ExactPreparedPosting.WF (posting : ExactPreparedPosting) : Prop where
  id : posting.id.WF
  accountId : posting.accountId.WF
  units : posting.units.WF
  unitsCommodityId : posting.unitsCommodityId.WF
  exactBookValue : posting.exactBookValue.WF
  costBasis : ∀ basis, posting.costBasis = some basis → basis.WF

/-- A constructible prepared journal. -/
structure ExactPreparedJournal.WF (journal : ExactPreparedJournal) : Prop where
  requiredQuantizationPolicy : ∀ policy, journal.requiredQuantizationPolicy = some policy →
    policy.WF
  id : journal.id.WF
  postings : ∀ posting ∈ journal.postings, posting.WF
  derivations : ∀ derivation ∈ journal.derivations, derivation.WF

/-- A constructible inventory layer input. -/
structure InventoryLayerInput.WF (layer : InventoryLayerInput) : Prop where
  accountId : layer.accountId.WF
  quantity : layer.quantity.WF
  totalBasis : layer.totalBasis.WF

/-- A constructible inventory allocation result. -/
structure InventoryAllocationResult.WF (result : InventoryAllocationResult) : Prop where
  quantity : result.quantity.WF
  basis : result.basis.WF

/-- The body of a constructible provisional layer. -/
structure ProvisionalInventoryLayerBody.WF (layer : ProvisionalInventoryLayerBody) : Prop where
  id : layer.id.WF
  bookId : layer.bookId.WF
  policyId : layer.policyId.WF
  policy : ∀ policy, layer.policy = some policy → policy.WF
  issueSource : ∀ source, layer.issueSource = some source → source.WF
  issuePostingId : ∀ id, layer.issuePostingId = some id → id.WF
  quantity : layer.quantity.WF
  provisionalBasis : layer.provisionalBasis.WF
  derivation : layer.derivation.WF

/-- A constructible provisional layer. -/
def ProvisionalInventoryLayer.WF (layer : ProvisionalInventoryLayer) : Prop :=
  layer.toProvisionalInventoryLayerBody.WF

/-- A constructible recosting source. -/
structure InventoryRecostingSource.WF (source : InventoryRecostingSource) : Prop where
  quantity : source.quantity.WF
  totalBasis : source.totalBasis.WF

/-- A constructible recosting. -/
structure InventoryRecosting.WF (recosting : InventoryRecosting) : Prop where
  id : recosting.id.WF
  layerId : recosting.layerId.WF
  sources : ∀ source ∈ recosting.sources, source.WF
  adjustment : recosting.adjustment.WF
  derivation : recosting.derivation.WF

/-- A constructible allocation of a value adjustment. -/
structure InventoryValueAdjustmentAllocation.WF (allocation : InventoryValueAdjustmentAllocation) :
    Prop where
  lotId : allocation.lotId.WF
  holdingId : ∀ id, allocation.holdingId = some id → id.WF
  remainingBasisChange : allocation.remainingBasisChange.WF
  recognizedCostChange : allocation.recognizedCostChange.WF
  remainingValuationAllowanceChange : allocation.remainingValuationAllowanceChange.WF

/-- A constructible value adjustment. -/
structure InventoryValueAdjustment.WF (adjustment : InventoryValueAdjustment) : Prop where
  id : adjustment.id.WF
  bookId : adjustment.bookId.WF
  policy : adjustment.policy.WF
  exactSourceAmount : adjustment.exactSourceAmount.WF
  allocations : ∀ allocation ∈ adjustment.allocations, allocation.WF
  bookedAdjustment : adjustment.bookedAdjustment.WF
  evidence : ∀ item ∈ adjustment.evidence, item.WF
  derivation : adjustment.derivation.WF

/-- A settlement scope whose control account identifier is valid. -/
structure SettlementScope.WF (scope : SettlementScope) : Prop where
  controlAccountId : scope.controlAccountId.WF

/-- The body of a constructible open item. -/
structure OpenItemBody.WF (item : OpenItemBody) : Prop where
  id : item.id.WF
  bookId : item.bookId.WF
  scope : item.scope.WF
  recognitionSource : ∀ source, item.recognitionSource = some source → source.WF
  recognitionPostingId : ∀ id, item.recognitionPostingId = some id → id.WF
  denominationCommodityId : item.denominationCommodityId.WF
  denomination : item.denomination.WF
  bookValue : item.bookValue.WF
  derivation : item.derivation.WF

/-- A constructible open item. -/
def OpenItem.WF (item : OpenItem) : Prop := item.toOpenItemBody.WF

/-- The body of a constructible settlement. -/
structure SettlementBody.WF (settlement : SettlementBody) : Prop where
  id : settlement.id.WF
  bookId : settlement.bookId.WF
  scope : settlement.scope.WF
  settlementSource : ∀ source, settlement.settlementSource = some source → source.WF
  settlementPostingId : ∀ id, settlement.settlementPostingId = some id → id.WF
  denominationCommodityId : settlement.denominationCommodityId.WF
  denomination : settlement.denomination.WF
  bookValue : settlement.bookValue.WF
  derivation : settlement.derivation.WF

/-- A constructible settlement. -/
def Settlement.WF (settlement : Settlement) : Prop := settlement.toSettlementBody.WF

/-- A constructible valuation path. -/
structure CurrencyValuationPath.WF (path : CurrencyValuationPath) : Prop where
  fromCommodityId : path.fromCommodityId.WF
  toCommodityId : path.toCommodityId.WF
  rate : path.rate.WF
  evidenceIds : ∀ id ∈ path.evidenceIds, id.WF

/-- The body of a constructible settlement allocation. -/
structure SettlementAllocationBody.WF (allocation : SettlementAllocationBody) : Prop where
  id : allocation.id.WF
  openItemId : allocation.openItemId.WF
  settlementId : allocation.settlementId.WF
  allocatedBookValue : allocation.allocatedBookValue.WF
  allocatedOpenQuantity : allocation.allocatedOpenQuantity.WF
  allocatedSettlementQuantity : allocation.allocatedSettlementQuantity.WF
  allocatedOpenItemBookValue : ∀ value, allocation.allocatedOpenItemBookValue = some value →
    value.WF
  allocatedSettlementBookValue : ∀ value, allocation.allocatedSettlementBookValue = some value →
    value.WF
  settlementMeasurement : ∀ value, allocation.settlementMeasurement = some value → value.WF
  realizedExchangeDifference : ∀ value, allocation.realizedExchangeDifference = some value →
    value.WF
  valuationPath : ∀ path, allocation.valuationPath = some path → path.WF
  derivation : allocation.derivation.WF

/-- A constructible settlement allocation. -/
def SettlementAllocation.WF (allocation : SettlementAllocation) : Prop :=
  allocation.toSettlementAllocationBody.WF

/-- A constructible remeasurement result. -/
structure RemeasurementResult.WF (result : RemeasurementResult) : Prop where
  id : result.id.WF
  sourcePostingId : ∀ id, result.sourcePostingId = some id → id.WF
  source : ∀ source, result.source = some source → source.WF
  positionAccountId : ∀ id, result.positionAccountId = some id → id.WF
  denominationCommodityId : ∀ id, result.denominationCommodityId = some id → id.WF
  carryingBookValue : result.carryingBookValue.WF
  measuredBookValue : result.measuredBookValue.WF
  difference : result.difference.WF
  valuationRate : result.valuationRate.WF
  policyId : result.policyId.WF
  policy : ∀ policy, result.policy = some policy → policy.WF
  classificationPolicy : ∀ policy, result.classificationPolicy = some policy → policy.WF
  valuationPath : ∀ path, result.valuationPath = some path → path.WF
  derivation : result.derivation.WF

/-- A remeasurement reversal whose identifiers are valid. -/
structure RemeasurementReversal.WF (reversal : RemeasurementReversal) : Prop where
  id : reversal.id.WF
  originalResultId : reversal.originalResultId.WF
  originalJournalId : ∀ id, reversal.originalJournalId = some id → id.WF
  derivation : reversal.derivation.WF

/-- A constructible scheduled allocation. -/
structure ScheduledAllocation.WF (allocation : ScheduledAllocation) : Prop where
  amount : allocation.amount.WF

/-- A constructible installment of a posting plan. -/
structure AllocationPostingInstallment.WF (installment : AllocationPostingInstallment) : Prop where
  exactAmount : installment.exactAmount.WF
  cumulativeTarget : installment.cumulativeTarget.WF
  cumulativeQuantization : installment.cumulativeQuantization.WF
  postedAmount : installment.postedAmount.WF
  exactToPostedDifference : installment.exactToPostedDifference.WF

/-- A constructible posting plan. -/
structure AllocationPostingPlan.WF (plan : AllocationPostingPlan) : Prop where
  exactSourceBasis : plan.exactSourceBasis.WF
  exactResidualValue : plan.exactResidualValue.WF
  postedSourceBasis : plan.postedSourceBasis.WF
  residualQuantization : plan.residualQuantization.WF
  quantizationPolicy : plan.quantizationPolicy.WF
  installments : ∀ installment ∈ plan.installments, installment.WF

/-- A constructible allocation schedule. -/
structure AllocationSchedule.WF (schedule : AllocationSchedule) : Prop where
  id : schedule.id.WF
  bookId : schedule.bookId.WF
  policyId : schedule.policyId.WF
  policy : schedule.policy.WF
  source : ∀ source, schedule.source = some source → source.WF
  sourcePostingId : ∀ id, schedule.sourcePostingId = some id → id.WF
  sourceBasis : schedule.sourceBasis.WF
  residualValue : schedule.residualValue.WF
  installments : ∀ installment ∈ schedule.installments, installment.WF
  postingPlan : ∀ plan, schedule.postingPlan = some plan → plan.WF
  derivation : schedule.derivation.WF

/-- An allocation recognition whose identifiers are valid. -/
structure AllocationRecognition.WF (recognition : AllocationRecognition) : Prop where
  id : recognition.id.WF
  scheduleId : recognition.scheduleId.WF
  derivation : recognition.derivation.WF

/-- A constructible schedule revision. -/
structure AllocationScheduleRevision.WF (revision : AllocationScheduleRevision) : Prop where
  id : revision.id.WF
  originalScheduleId : revision.originalScheduleId.WF
  priorRecognitionIds : ∀ id ∈ revision.priorRecognitionIds, id.WF
  recognizedToDate : revision.recognizedToDate.WF
  carryingAmountAtRevision : revision.carryingAmountAtRevision.WF
  postedRecognizedToDate : ∀ value, revision.postedRecognizedToDate = some value → value.WF
  postedCarryingAmountAtRevision :
    ∀ value, revision.postedCarryingAmountAtRevision = some value → value.WF
  revisedResidualValue : revision.revisedResidualValue.WF
  exactAdjustmentAmount : ∀ value, revision.exactAdjustmentAmount = some value → value.WF
  bookedAdjustment : ∀ value, revision.bookedAdjustment = some value → value.WF
  successorScheduleId : ∀ id, revision.successorScheduleId = some id → id.WF
  policy : revision.policy.WF
  evidence : ∀ item ∈ revision.evidence, item.WF
  derivation : revision.derivation.WF

/-- A constructible tax component result. -/
structure TaxComponentResult.WF (result : TaxComponentResult) : Prop where
  policyId : result.policyId.WF
  exactTax : result.exactTax.WF
  quantization : result.quantization.WF
  recoverable : result.recoverable.WF
  nonRecoverable : result.nonRecoverable.WF

/-- A constructible tax line result. -/
structure TaxLineResult.WF (line : TaxLineResult) : Prop where
  policyId : line.policyId.WF
  exclusiveBasis : line.exclusiveBasis.WF
  components : ∀ component ∈ line.components, component.WF

/-- A constructible tax determination. -/
structure TaxDetermination.WF (determination : TaxDetermination) : Prop where
  id : determination.id.WF
  bookId : determination.bookId.WF
  sourceTransactionId : determination.sourceTransactionId.WF
  lines : ∀ line ∈ determination.lines, line.WF
  derivation : determination.derivation.WF

/-- A consolidation compilation whose identifiers are valid. -/
structure ConsolidationCompilation.WF (compilation : ConsolidationCompilation) : Prop where
  id : compilation.id.WF
  bookId : compilation.bookId.WF
  policyId : compilation.policyId.WF
  derivation : compilation.derivation.WF

/-- A state every artifact of which is constructible. -/
structure AccountingCanonicalState.WF (state : AccountingCanonicalState) : Prop where
  provisionalInventoryLayers : ∀ value ∈ state.provisionalInventoryLayers, value.WF
  inventoryRecostings : ∀ value ∈ state.inventoryRecostings, value.WF
  inventoryValueAdjustments : ∀ value ∈ state.inventoryValueAdjustments, value.WF
  openItems : ∀ value ∈ state.openItems, value.WF
  settlements : ∀ value ∈ state.settlements, value.WF
  settlementAllocations : ∀ value ∈ state.settlementAllocations, value.WF
  remeasurementResults : ∀ value ∈ state.remeasurementResults, value.WF
  remeasurementReversals : ∀ value ∈ state.remeasurementReversals, value.WF
  allocationSchedules : ∀ value ∈ state.allocationSchedules, value.WF
  allocationRecognitions : ∀ value ∈ state.allocationRecognitions, value.WF
  allocationScheduleRevisions : ∀ value ∈ state.allocationScheduleRevisions, value.WF
  taxDeterminations : ∀ value ∈ state.taxDeterminations, value.WF
  consolidationCompilations : ∀ value ∈ state.consolidationCompilations, value.WF

/-- A constructible effect: its value is. -/
def AccountingEffect.WF : AccountingEffect → Prop
  | .provisionalInventoryLayer value => value.WF
  | .inventoryRecosting value => value.WF
  | .inventoryValueAdjustment value => value.WF
  | .openItem value => value.WF
  | .settlement value => value.WF
  | .settlementAllocation value => value.WF
  | .remeasurementResult value => value.WF
  | .remeasurementReversal value => value.WF
  | .allocationSchedule value => value.WF
  | .allocationRecognition value => value.WF
  | .allocationScheduleRevision value => value.WF
  | .taxDetermination value => value.WF
  | .consolidationCompilation value => value.WF

/-- A draft whose journals and effects are constructible. -/
structure AccountingDraft.WF (draft : AccountingDraft) : Prop where
  journals : ∀ journal ∈ draft.journals, journal.WF
  effects : ∀ effect ∈ draft.effects, effect.WF

/-- A constructible calculation: a draft is constructible; a rejection holds no exact number and no
identifier. -/
def AccountingCalculation.WF : AccountingCalculation → Prop
  | .draft value => value.WF
  | .rejected _ => True

/-- A constructible request to recognize an open item. -/
structure OpenItemRecognitionRequest.WF (request : OpenItemRecognitionRequest) : Prop where
  value : request.value.WF

/-- The core of a constructible settlement request. -/
structure SettlementRequestCore.WF (request : SettlementRequestCore) : Prop where
  settlement : request.settlement.WF
  allocations : ∀ allocation ∈ request.allocations, allocation.WF
  quantizationPolicy : ∀ policy, request.quantizationPolicy = some policy → policy.WF
  realizedExchangePolicyId : ∀ id, request.realizedExchangePolicyId = some id → id.WF

/-- A constructible settlement request: its core is. `operation` and `appliedAt` hold no exact
number and no identifier; which combinations of them the type admits is `Typed`, not `WF`. -/
def SettlementRequest.WF (request : SettlementRequest) : Prop :=
  request.toSettlementRequestCore.WF

/-- A constructible pair of totals. -/
structure AllocatedTotal.WF (total : AllocatedTotal) : Prop where
  bookValue : total.bookValue.WF
  quantity : total.quantity.WF

/-- A read context every answer of which is constructible. -/
structure SettlementReadContext.WF (context : SettlementReadContext) : Prop where
  openItem : ∀ id item, context.openItem id = some item → item.WF
  existingSettlement : ∀ id settlement, context.existingSettlement id = some settlement →
    settlement.WF
  allocatedFromSettlement : ∀ id, (context.allocatedFromSettlement id).WF
  allocatedToOpenItem : ∀ id, (context.allocatedToOpenItem id).WF

end Rastrata.Kernel

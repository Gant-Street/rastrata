/-
`canonicalize` of `packages/kernel/src/accounting.ts` (line 688), `canonicalAccountingValue`
(line 702), `accountingHash` (line 713) and the two small writers beside them, `hashValue` and
`rationalValue` (lines 685 and 686), here `accountingHashValue` and `accountingRationalValue`.

How `canonicalize` is modelled. The TypeScript hashes any JavaScript value by walking it: `null`,
a boolean, a string, a `bigint` and a `Uint8Array` are themselves; an `ExactRational` is the record
`{ numerator, denominator }`; an array is the array of its members, each walked; any other object
is the record of its own enumerable properties in their order, each walked, a property whose value
is `undefined` left out; and anything else (a `number`, `undefined`, a function, a symbol) throws a
`TypeError`. Lean has no `unknown`, so the model is the class `Canonicalize`: for each type of the
kernel, the canonical value `canonicalize` produces on a value of that type.

- A branded string (`Identifier`, `SemanticVersion`, `Instant`, `LocalDate`, `EffectKey`) and a
  plain `string` are the string; a `bigint` (`Int`) is the integer; a `boolean` is the boolean; a
  union of string literals is its literal (`text`).
- `ExactRational` is `{ numerator, denominator }` (line 690). `ExactDecimal` is not an
  `ExactRational`; it is an object whose own properties are `coefficient` and `scale` (both
  `bigint`), so it is `{ coefficient, scale }`.
- `readonly T[]` is the array of the members' values.
- An `interface` is a record whose entries are its fields, named as the TypeScript names them, in
  the order the interface writes them (an interface that extends another: the other's fields
  first, as the Lean structure has them), an optional field that is absent left out. A member of a
  discriminated union carries its discriminant as a property, so a policy writes `kind` and an
  effect writes `type` (`AccountingPolicy.canonicalMembers`, `AccountingEffect`).
- No type of the kernel holds a `number` or a function, so the `TypeError` cannot happen here.

The order of a record's entries is the order of the interface; a JavaScript object built by a
spread (`{ ...body, contentHash }`) may list its properties in another order. No reader can tell:
every canonical value of this module is hashed or encoded, and the encoder sorts the entries of a
record by key (`canonicalEncode_record_perm`), so the model and the TypeScript produce the same
bytes. A JavaScript object may also carry properties its type does not name, which `canonicalize`
writes; a Lean structure has exactly its fields (`Accounting/Types.lean` says the same).

How it was checked against the TypeScript: `canonicalAccountingValue` was run under Bun on an
`InventoryCostPolicy` built by hand (with `validTo: undefined`, an admitted combination with
`method: undefined`, a pool, a rational rate), an `ExactDecimal`, an `ExactRational` that reduces,
a `QuantizedValue`, a content hash, nested arrays, the empty state and an effect; it printed the
records described above (the `undefined` members left out, `ExactRational.of(6n, 4n)` as
`{ numerator: 3n, denominator: 2n }`, `ExactDecimal.of(-1234n, 2n)` as
`{ coefficient: -1234n, scale: 2n }`), threw `TypeError` on a `number` and on `undefined`, and
`hashAccountingPolicy` agreed with `hashCanonical({ type: kind, value: canonicalAccountingValue })`.
The digests the model computes for the same values are compared with the TypeScript's in
`Accounting/Core/Examples.lean`, by `#guard`.

Laws: every canonical value of this file is well formed (no record repeats a key) and determines
the value it was written from (`LawfulCanonicalize`); so equal `accountingHash`es mean equal values
or a collision of SHA-256 is in hand (`accountingHash_inj_or_collision`).
-/
import Rastrata.Prelude
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Policy
import Rastrata.Kernel.QuantizationBalanced
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Book.BaseTypes
import Rastrata.Kernel.Accounting.BasisTypes

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false
set_option linter.unusedTactic false
set_option linter.unnecessarySeqFocus false
set_option linter.unreachableTactic false

/-! ## The class -/

/-- `canonicalize` (`accounting.ts` line 688) on a value of type `α`: the canonical value the
TypeScript writes for it. -/
class Canonicalize (α : Type) where
  /-- The canonical value of a value. -/
  canonicalize : α → CanonicalValue

export Canonicalize (canonicalize)

/-- A string is itself. -/
instance : Canonicalize String := ⟨.string⟩

/-- A `bigint` is itself. -/
instance : Canonicalize Int := ⟨.int⟩

/-- A boolean is itself. -/
instance : Canonicalize Bool := ⟨.bool⟩

/-- A value that is already canonical is itself: `canonicalize` copies it member by member. -/
instance : Canonicalize CanonicalValue := ⟨id⟩

/-- A branded identifier is its string. -/
instance {Kind : String} : Canonicalize (Identifier Kind) := ⟨fun id => .string id.value⟩

/-- A semantic version is its string. -/
instance : Canonicalize SemanticVersion := ⟨fun v => .string v.value⟩

/-- An instant is its string. -/
instance : Canonicalize Instant := ⟨fun v => .string v.value⟩

/-- A local date is its string. -/
instance : Canonicalize LocalDate := ⟨fun v => .string v.value⟩

/-- An effect key is its string. -/
instance : Canonicalize EffectKey := ⟨fun v => .string v.value⟩

/-- An array is the array of its members' canonical values (line 691). -/
instance {α : Type} [Canonicalize α] : Canonicalize (List α) :=
  ⟨fun values => .array (values.map canonicalize)⟩

/-! ## Objects -/

/-- A property of an object: its key, and its canonical value, `none` when it is `undefined`. -/
abbrev Member := String × Option CanonicalValue

/-- The entries `canonicalize` writes for an object (lines 692 to 696): its properties in order,
those whose value is `undefined` left out. -/
def objectEntries (members : List Member) : List (String × CanonicalValue) :=
  members.filterMap fun m => m.2.map fun value => (m.1, value)

/-- The record `canonicalize` writes for an object with these properties. -/
def object (members : List Member) : CanonicalValue := .record (objectEntries members)

/-- A property that is always present. -/
def member {α : Type} [Canonicalize α] (key : String) (value : α) : Member :=
  (key, some (canonicalize value))

/-- An optional property: absent (`undefined`) when the value is `none`. -/
def optMember {α : Type} [Canonicalize α] (key : String) (value : Option α) : Member :=
  (key, value.map canonicalize)

/-- A property whose value is a string literal: the discriminant of a union. -/
def literalMember (key value : String) : Member := (key, some (.string value))

/-- A type whose values are JavaScript objects: the properties `canonicalize` walks. -/
class CanonicalObject (α : Type) where
  /-- The properties of the object, in the order of its interface. -/
  members : α → List Member

/-- An object is the record of its properties. -/
instance (priority := low) {α : Type} [CanonicalObject α] : Canonicalize α :=
  ⟨fun value => object (CanonicalObject.members value)⟩

theorem canonicalize_object {α : Type} [CanonicalObject α] (value : α) :
    canonicalize value = object (CanonicalObject.members value) := rfl

/-! ## String literals -/

instance : Canonicalize AccountingFeature := ⟨fun v => .string v.text⟩
instance : Canonicalize AccountingCapabilityStatus := ⟨fun v => .string v.text⟩
instance : Canonicalize InventoryCostMethod := ⟨fun v => .string v.text⟩
instance : Canonicalize InventoryShortageTreatment := ⟨fun v => .string v.text⟩
instance : Canonicalize ProvisionalBasisMethod := ⟨fun v => .string v.text⟩
instance : Canonicalize InventoryValueAdjustmentKind := ⟨fun v => .string v.text⟩
instance : Canonicalize AccountingBasisEvent := ⟨fun v => .string v.text⟩
instance : Canonicalize AccountingBasisTreatment := ⟨fun v => .string v.text⟩
instance : Canonicalize AccountingBasis := ⟨fun v => .string v.text⟩
instance : Canonicalize MonetaryClassification := ⟨fun v => .string v.text⟩
instance : Canonicalize AllocationPostingAlgorithm := ⟨fun v => .string v.text⟩
instance : Canonicalize AllocationMethod := ⟨fun v => .string v.text⟩
instance : Canonicalize AllocationFrequency := ⟨fun v => .string v.text⟩
instance : Canonicalize AllocationConvention := ⟨fun v => .string v.text⟩
instance : Canonicalize TaxInclusion := ⟨fun v => .string v.text⟩
instance : Canonicalize TaxTreatment := ⟨fun v => .string v.text⟩
instance : Canonicalize TaxRecoverability := ⟨fun v => .string v.text⟩
instance : Canonicalize TaxRoundingLevel := ⟨fun v => .string v.text⟩
instance : Canonicalize TaxGroupingAlgorithm := ⟨fun v => .string v.text⟩
instance : Canonicalize ConsolidationMethod := ⟨fun v => .string v.text⟩
instance : Canonicalize RoundingMode := ⟨fun v => .string v.text⟩
instance : Canonicalize DerivationState := ⟨fun v => .string v.text⟩
instance : Canonicalize OpenItemKind := ⟨fun v => .string v.text⟩
instance : Canonicalize SettlementKind := ⟨fun v => .string v.text⟩
instance : Canonicalize RemeasurementKind := ⟨fun v => .string v.text⟩
instance : Canonicalize AllocationScheduleChangeKind := ⟨fun v => .string v.text⟩
instance : Canonicalize TaxDirection := ⟨fun v => .string v.text⟩
instance : Canonicalize PreparedJournalKind := ⟨fun v => .string v.text⟩
instance : Canonicalize SettlementOperation := ⟨fun v => .string v.text⟩

/-! ## Numbers and hashes -/

/-- `ExactRational.canonicalMembers`: `rationalValue` (line 686), which `canonicalize` uses for an
`ExactRational` (line 690). -/
def ExactRational.canonicalMembers (value : ExactRational) : List Member :=
  [member "numerator" value.numerator, member "denominator" value.denominator]

instance : CanonicalObject ExactRational := ⟨ExactRational.canonicalMembers⟩

/-- `rationalValue` of `accounting.ts` (line 686); `rationalValue` is already the name of the one of
`journal.ts`, which adds a `type`. -/
def accountingRationalValue (value : ExactRational) : CanonicalValue := canonicalize value

/-- An `ExactDecimal` is an object whose own properties are `coefficient` and `scale`. -/
def ExactDecimal.canonicalMembers (value : ExactDecimal) : List Member :=
  [member "coefficient" value.coefficient, member "scale" value.scale]

instance : CanonicalObject ExactDecimal := ⟨ExactDecimal.canonicalMembers⟩

/-- A content hash is the object `hashCanonical` returns: `algorithm`, `canonicalizationVersion`,
`digest`. -/
def ContentHash.canonicalMembers (hash : ContentHash) : List Member :=
  [member "algorithm" hash.algorithm, member "canonicalizationVersion" hash.canonicalizationVersion,
    member "digest" hash.digest]

instance : CanonicalObject ContentHash := ⟨ContentHash.canonicalMembers⟩

/-- `hashValue` of `accounting.ts` (line 685): the same three properties. -/
def accountingHashValue (hash : ContentHash) : CanonicalValue := canonicalize hash

/-- `QuantizedValue`. -/
def QuantizedValue.canonicalMembers (value : QuantizedValue) : List Member :=
  [member "amount" value.amount, member "residual" value.residual]

instance : CanonicalObject QuantizedValue := ⟨QuantizedValue.canonicalMembers⟩

/-! ## Policies -/

/-- `QuantizationPolicy`, walked by `canonicalize` (not `hashQuantizationPolicy`, which writes
`null` for an absent `validTo` and a `type`): `validTo` is left out when it is absent. -/
def QuantizationPolicy.canonicalMembers (policy : QuantizationPolicy) : List Member :=
  [member "id" policy.id, member "version" policy.version, member "bookId" policy.bookId,
    member "functionalCommodityId" policy.functionalCommodityId,
    member "validFrom" policy.validFrom, optMember "validTo" policy.validTo,
    member "targetScale" policy.targetScale, member "roundingMode" policy.roundingMode,
    member "roundingAccountId" policy.roundingAccountId]

instance : CanonicalObject QuantizationPolicy := ⟨QuantizationPolicy.canonicalMembers⟩

/-- `AccountingCapabilityCombination`: each axis left out when absent. -/
def AccountingCapabilityCombination.canonicalMembers (combination : AccountingCapabilityCombination) :
    List Member :=
  [optMember "method" combination.method, optMember "frequency" combination.frequency,
    optMember "convention" combination.convention]

instance : CanonicalObject AccountingCapabilityCombination :=
  ⟨AccountingCapabilityCombination.canonicalMembers⟩

/-- `AccountingCapability`. -/
def AccountingCapability.canonicalMembers (capability : AccountingCapability) : List Member :=
  [member "feature" capability.feature, member "status" capability.status,
    member "implementationVersion" capability.implementationVersion,
    member "verificationEvidenceIds" capability.verificationEvidenceIds,
    member "admittedCombinations" capability.admittedCombinations]

instance : CanonicalObject AccountingCapability := ⟨AccountingCapability.canonicalMembers⟩

/-- `AccountingPolicyArtifactCore`: the first two properties of every artifact. -/
def AccountingPolicyArtifactCore.canonicalMembers (core : AccountingPolicyArtifactCore) :
    List Member :=
  [member "id" core.id, member "contentHash" core.contentHash]

instance : CanonicalObject AccountingPolicyArtifactCore :=
  ⟨AccountingPolicyArtifactCore.canonicalMembers⟩

/-- `AccountingPolicyCore`: the first properties of every policy. -/
def AccountingPolicyCore.canonicalMembers (core : AccountingPolicyCore) : List Member :=
  [member "id" core.id, member "version" core.version, member "bookId" core.bookId,
    member "validFrom" core.validFrom, optMember "validTo" core.validTo,
    member "algorithmVersion" core.algorithmVersion,
    member "quantizationPolicy" core.quantizationPolicy, member "capability" core.capability]

instance : CanonicalObject AccountingPolicyCore := ⟨AccountingPolicyCore.canonicalMembers⟩

/-- `InventoryPool`. -/
def InventoryPool.canonicalMembers (pool : InventoryPool) : List Member :=
  pool.toAccountingPolicyArtifactCore.canonicalMembers ++ [member "accountId" pool.accountId]

instance : CanonicalObject InventoryPool := ⟨InventoryPool.canonicalMembers⟩

/-- `InventoryCostPolicy`, with its `kind`. -/
def InventoryCostPolicy.canonicalMembers (policy : InventoryCostPolicy) : List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "inventoryCost", member "method" policy.method,
      member "pools" policy.pools, member "shortageTreatment" policy.shortageTreatment,
      optMember "provisionalBasisMethod" policy.provisionalBasisMethod,
      optMember "provisionalRate" policy.provisionalRate]

instance : CanonicalObject InventoryCostPolicy := ⟨InventoryCostPolicy.canonicalMembers⟩

/-- `InventoryValueAdjustmentPolicy`, with its `kind`. -/
def InventoryValueAdjustmentPolicy.canonicalMembers (policy : InventoryValueAdjustmentPolicy) :
    List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "inventoryValueAdjustment",
      member "inventoryCostPolicyId" policy.inventoryCostPolicyId,
      member "inventoryCostPolicyVersion" policy.inventoryCostPolicyVersion,
      member "allowedKinds" policy.allowedKinds,
      member "inventoryAccountId" policy.inventoryAccountId,
      member "recognizedCostAccountId" policy.recognizedCostAccountId,
      member "adjustmentAccountId" policy.adjustmentAccountId]

instance : CanonicalObject InventoryValueAdjustmentPolicy :=
  ⟨InventoryValueAdjustmentPolicy.canonicalMembers⟩

/-- `AccountingBasisRule`. -/
def AccountingBasisRule.canonicalMembers (rule : AccountingBasisRule) : List Member :=
  rule.toAccountingPolicyArtifactCore.canonicalMembers ++
    [member "event" rule.event, member "treatment" rule.treatment]

instance : CanonicalObject AccountingBasisRule := ⟨AccountingBasisRule.canonicalMembers⟩

/-- `AccountingBasisPolicy`, with its `kind`. -/
def AccountingBasisPolicy.canonicalMembers (policy : AccountingBasisPolicy) : List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "accountingBasis", member "basis" policy.basis,
      member "rules" policy.rules]

instance : CanonicalObject AccountingBasisPolicy := ⟨AccountingBasisPolicy.canonicalMembers⟩

/-- `CurrencyPolicy`, with its `kind`. -/
def CurrencyPolicy.canonicalMembers (policy : CurrencyPolicy) : List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "currencyRemeasurement",
      member "reversalRequired" policy.reversalRequired,
      member "gainAccountId" policy.gainAccountId, member "lossAccountId" policy.lossAccountId]

instance : CanonicalObject CurrencyPolicy := ⟨CurrencyPolicy.canonicalMembers⟩

/-- `MonetaryClassificationRule`. -/
def MonetaryClassificationRule.canonicalMembers (rule : MonetaryClassificationRule) :
    List Member :=
  rule.toAccountingPolicyArtifactCore.canonicalMembers ++
    [member "accountId" rule.accountId, member "classification" rule.classification]

instance : CanonicalObject MonetaryClassificationRule :=
  ⟨MonetaryClassificationRule.canonicalMembers⟩

/-- `MonetaryClassificationPolicy`, with its `kind`. -/
def MonetaryClassificationPolicy.canonicalMembers (policy : MonetaryClassificationPolicy) :
    List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "monetaryClassification", member "rules" policy.rules]

instance : CanonicalObject MonetaryClassificationPolicy :=
  ⟨MonetaryClassificationPolicy.canonicalMembers⟩

/-- `AllocationPolicy`, with its `kind` (the TypeScript writes `postingAlgorithm` before `kind`). -/
def AllocationPolicy.canonicalMembers (policy : AllocationPolicy) : List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [optMember "postingAlgorithm" policy.postingAlgorithm,
      literalMember "kind" "allocationSchedule", member "method" policy.method,
      member "frequency" policy.frequency, member "convention" policy.convention,
      optMember "decliningRate" policy.decliningRate,
      optMember "expectedUsage" policy.expectedUsage,
      member "allocationAccountId" policy.allocationAccountId,
      member "contraAccountId" policy.contraAccountId]

instance : CanonicalObject AllocationPolicy := ⟨AllocationPolicy.canonicalMembers⟩

/-- `TaxPolicyComponent`. -/
def TaxPolicyComponent.canonicalMembers (component : TaxPolicyComponent) : List Member :=
  component.toAccountingPolicyArtifactCore.canonicalMembers ++
    [member "rate" component.rate, member "inclusion" component.inclusion,
      member "treatment" component.treatment, member "recoverability" component.recoverability,
      member "recoverableShare" component.recoverableShare,
      member "compoundOrdinal" component.compoundOrdinal,
      member "compoundsOn" component.compoundsOn,
      member "liabilityAccountId" component.liabilityAccountId,
      optMember "recoverableAccountId" component.recoverableAccountId,
      optMember "nonRecoverableAccountId" component.nonRecoverableAccountId]

instance : CanonicalObject TaxPolicyComponent := ⟨TaxPolicyComponent.canonicalMembers⟩

/-- `TaxPolicy`, with its `kind`. -/
def TaxPolicy.canonicalMembers (policy : TaxPolicy) : List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "taxDetermination", member "taxCode" policy.taxCode,
      member "jurisdiction" policy.jurisdiction, member "roundingLevel" policy.roundingLevel,
      optMember "groupingAlgorithm" policy.groupingAlgorithm,
      member "components" policy.components]

instance : CanonicalObject TaxPolicy := ⟨TaxPolicy.canonicalMembers⟩

/-- `ConsolidationAccountMapping`. -/
def ConsolidationAccountMapping.canonicalMembers (mapping : ConsolidationAccountMapping) :
    List Member :=
  mapping.toAccountingPolicyArtifactCore.canonicalMembers ++
    [optMember "sourceBookId" mapping.sourceBookId,
      member "sourceAccountId" mapping.sourceAccountId,
      member "targetAccountId" mapping.targetAccountId, member "validFrom" mapping.validFrom,
      optMember "validTo" mapping.validTo]

instance : CanonicalObject ConsolidationAccountMapping :=
  ⟨ConsolidationAccountMapping.canonicalMembers⟩

/-- `ConsolidationValuationPolicy`. -/
def ConsolidationValuationPolicy.canonicalMembers (policy : ConsolidationValuationPolicy) :
    List Member :=
  [member "id" policy.id, member "version" policy.version, member "validFrom" policy.validFrom,
    optMember "validTo" policy.validTo, member "maximumHops" policy.maximumHops,
    member "allowInverseObservation" policy.allowInverseObservation,
    member "preferDirectObservation" policy.preferDirectObservation]

instance : CanonicalObject ConsolidationValuationPolicy :=
  ⟨ConsolidationValuationPolicy.canonicalMembers⟩

/-- `ConsolidationTranslationRule`. -/
def ConsolidationTranslationRule.canonicalMembers (rule : ConsolidationTranslationRule) :
    List Member :=
  rule.toAccountingPolicyArtifactCore.canonicalMembers ++
    [optMember "sourceBookId" rule.sourceBookId, member "sourceAccountId" rule.sourceAccountId,
      member "targetAccountId" rule.targetAccountId, member "validFrom" rule.validFrom,
      optMember "validTo" rule.validTo, member "valuationPolicy" rule.valuationPolicy]

instance : CanonicalObject ConsolidationTranslationRule :=
  ⟨ConsolidationTranslationRule.canonicalMembers⟩

/-- `ConsolidationPolicy`, with its `kind`. -/
def ConsolidationPolicy.canonicalMembers (policy : ConsolidationPolicy) : List Member :=
  policy.toAccountingPolicyCore.canonicalMembers ++
    [literalMember "kind" "consolidation", member "supportedMethods" policy.supportedMethods,
      member "accountMappings" policy.accountMappings,
      member "translationRules" policy.translationRules,
      member "valuationPolicy" policy.valuationPolicy,
      member "translationAdjustmentAccountId" policy.translationAdjustmentAccountId,
      member "parentAttributableEquityAccountId" policy.parentAttributableEquityAccountId,
      member "nonControllingInterestAccountId" policy.nonControllingInterestAccountId]

instance : CanonicalObject ConsolidationPolicy := ⟨ConsolidationPolicy.canonicalMembers⟩

/-- An accounting policy is the object of its kind, which carries `kind`. -/
def AccountingPolicy.canonicalMembers : AccountingPolicy → List Member
  | .inventoryCost policy => policy.canonicalMembers
  | .inventoryValueAdjustment policy => policy.canonicalMembers
  | .accountingBasis policy => policy.canonicalMembers
  | .monetaryClassification policy => policy.canonicalMembers
  | .currencyRemeasurement policy => policy.canonicalMembers
  | .allocationSchedule policy => policy.canonicalMembers
  | .taxDetermination policy => policy.canonicalMembers
  | .consolidation policy => policy.canonicalMembers

instance : CanonicalObject AccountingPolicy := ⟨AccountingPolicy.canonicalMembers⟩

/-- `AccountingPolicySnapshot`. -/
def AccountingPolicySnapshot.canonicalMembers (snapshot : AccountingPolicySnapshot) :
    List Member :=
  [member "policies" snapshot.policies, member "contentHash" snapshot.contentHash]

instance : CanonicalObject AccountingPolicySnapshot := ⟨AccountingPolicySnapshot.canonicalMembers⟩

/-! ## Evidence, derivations and references -/

/-- `SourceEvidence`. -/
def SourceEvidence.canonicalMembers (evidence : SourceEvidence) : List Member :=
  [member "id" evidence.id, member "sourceSystem" evidence.sourceSystem,
    member "sourceRecordId" evidence.sourceRecordId, member "observedAt" evidence.observedAt,
    member "contentHash" evidence.contentHash]

instance : CanonicalObject SourceEvidence := ⟨SourceEvidence.canonicalMembers⟩

/-- `DerivationRecord`, walked by `canonicalize` (not `canonicalDerivationValue` of `policy.ts`,
which adds a `type` and sorts the evidence): the evidence in the order given. -/
def DerivationRecord.canonicalMembers (derivation : DerivationRecord) : List Member :=
  [member "id" derivation.id, member "policyId" derivation.policyId,
    member "policyVersion" derivation.policyVersion,
    member "algorithmVersion" derivation.algorithmVersion,
    member "inputHash" derivation.inputHash, member "actorId" derivation.actorId,
    member "state" derivation.state, member "recordedAt" derivation.recordedAt,
    member "evidence" derivation.evidence]

instance : CanonicalObject DerivationRecord := ⟨DerivationRecord.canonicalMembers⟩

/-- `Omit<CanonicalPostingReference, "contentHash">`. -/
def CanonicalPostingReferenceBody.canonicalMembers (body : CanonicalPostingReferenceBody) :
    List Member :=
  [member "id" body.id, member "bookId" body.bookId, member "journalId" body.journalId,
    member "postingId" body.postingId, member "effectKey" body.effectKey,
    member "postingContentHash" body.postingContentHash]

instance : CanonicalObject CanonicalPostingReferenceBody :=
  ⟨CanonicalPostingReferenceBody.canonicalMembers⟩

/-- `CanonicalPostingReference`. -/
def CanonicalPostingReference.canonicalMembers (reference : CanonicalPostingReference) :
    List Member :=
  reference.toCanonicalPostingReferenceBody.canonicalMembers ++
    [member "contentHash" reference.contentHash]

instance : CanonicalObject CanonicalPostingReference :=
  ⟨CanonicalPostingReference.canonicalMembers⟩

/-! ## Prepared journals and drafts -/

/-- `ExactPreparedPosting.costBasis`. -/
def PreparedCostBasis.canonicalMembers (basis : PreparedCostBasis) : List Member :=
  [member "totalBasis" basis.totalBasis, member "basisCommodityId" basis.basisCommodityId]

instance : CanonicalObject PreparedCostBasis := ⟨PreparedCostBasis.canonicalMembers⟩

/-- `ExactPreparedPosting`. -/
def ExactPreparedPosting.canonicalMembers (posting : ExactPreparedPosting) : List Member :=
  [member "id" posting.id, member "accountId" posting.accountId, member "units" posting.units,
    member "unitsCommodityId" posting.unitsCommodityId,
    member "exactBookValue" posting.exactBookValue, optMember "costBasis" posting.costBasis]

instance : CanonicalObject ExactPreparedPosting := ⟨ExactPreparedPosting.canonicalMembers⟩

/-- `ExactPreparedJournal`. -/
def ExactPreparedJournal.canonicalMembers (journal : ExactPreparedJournal) : List Member :=
  [optMember "requiredQuantizationPolicy" journal.requiredQuantizationPolicy,
    member "id" journal.id, member "kind" journal.kind, member "economicAt" journal.economicAt,
    member "accountingDate" journal.accountingDate, member "recordedAt" journal.recordedAt,
    member "narration" journal.narration, member "postings" journal.postings,
    member "derivations" journal.derivations]

instance : CanonicalObject ExactPreparedJournal := ⟨ExactPreparedJournal.canonicalMembers⟩

/-! ## Inventory -/

/-- `InventoryLayerInput`. -/
def InventoryLayerInput.canonicalMembers (layer : InventoryLayerInput) : List Member :=
  [member "id" layer.id, member "accountId" layer.accountId, member "acquiredAt" layer.acquiredAt,
    member "quantity" layer.quantity, member "totalBasis" layer.totalBasis]

instance : CanonicalObject InventoryLayerInput := ⟨InventoryLayerInput.canonicalMembers⟩

/-- `InventoryAllocationResult`. -/
def InventoryAllocationResult.canonicalMembers (result : InventoryAllocationResult) :
    List Member :=
  [member "layerId" result.layerId, member "quantity" result.quantity,
    member "basis" result.basis]

instance : CanonicalObject InventoryAllocationResult := ⟨InventoryAllocationResult.canonicalMembers⟩

/-- `Omit<ProvisionalInventoryLayer, "contentHash">`. -/
def ProvisionalInventoryLayerBody.canonicalMembers (layer : ProvisionalInventoryLayerBody) :
    List Member :=
  [member "id" layer.id, member "bookId" layer.bookId, member "policyId" layer.policyId,
    optMember "policy" layer.policy, optMember "issueSource" layer.issueSource,
    optMember "issuePostingId" layer.issuePostingId, member "openedAt" layer.openedAt,
    member "quantity" layer.quantity, member "provisionalBasis" layer.provisionalBasis,
    member "derivation" layer.derivation]

instance : CanonicalObject ProvisionalInventoryLayerBody :=
  ⟨ProvisionalInventoryLayerBody.canonicalMembers⟩

/-- `ProvisionalInventoryLayer`. -/
def ProvisionalInventoryLayer.canonicalMembers (layer : ProvisionalInventoryLayer) :
    List Member :=
  layer.toProvisionalInventoryLayerBody.canonicalMembers ++
    [member "contentHash" layer.contentHash]

instance : CanonicalObject ProvisionalInventoryLayer :=
  ⟨ProvisionalInventoryLayer.canonicalMembers⟩

/-- `InventoryRecostingSource`. -/
def InventoryRecostingSource.canonicalMembers (source : InventoryRecostingSource) :
    List Member :=
  [member "receiptId" source.receiptId, member "quantity" source.quantity,
    member "totalBasis" source.totalBasis]

instance : CanonicalObject InventoryRecostingSource := ⟨InventoryRecostingSource.canonicalMembers⟩

/-- `InventoryRecosting`. -/
def InventoryRecosting.canonicalMembers (recosting : InventoryRecosting) : List Member :=
  [member "id" recosting.id, member "layerId" recosting.layerId,
    member "resolvedAt" recosting.resolvedAt, member "sources" recosting.sources,
    member "adjustment" recosting.adjustment, member "derivation" recosting.derivation,
    member "contentHash" recosting.contentHash]

instance : CanonicalObject InventoryRecosting := ⟨InventoryRecosting.canonicalMembers⟩

/-- `InventoryValueAdjustmentAllocation`. -/
def InventoryValueAdjustmentAllocation.canonicalMembers
    (allocation : InventoryValueAdjustmentAllocation) : List Member :=
  [member "ordinal" allocation.ordinal, member "lotId" allocation.lotId,
    optMember "holdingId" allocation.holdingId,
    member "remainingBasisChange" allocation.remainingBasisChange,
    member "recognizedCostChange" allocation.recognizedCostChange,
    member "remainingValuationAllowanceChange" allocation.remainingValuationAllowanceChange]

instance : CanonicalObject InventoryValueAdjustmentAllocation :=
  ⟨InventoryValueAdjustmentAllocation.canonicalMembers⟩

/-- `InventoryValueAdjustment`. -/
def InventoryValueAdjustment.canonicalMembers (adjustment : InventoryValueAdjustment) :
    List Member :=
  [member "id" adjustment.id, member "kind" adjustment.kind,
    member "effectiveOn" adjustment.effectiveOn,
    member "generatedEffectKey" adjustment.generatedEffectKey,
    member "bookId" adjustment.bookId, member "policy" adjustment.policy,
    member "exactSourceAmount" adjustment.exactSourceAmount,
    member "allocations" adjustment.allocations,
    member "bookedAdjustment" adjustment.bookedAdjustment,
    member "evidence" adjustment.evidence, member "derivation" adjustment.derivation,
    member "contentHash" adjustment.contentHash]

instance : CanonicalObject InventoryValueAdjustment := ⟨InventoryValueAdjustment.canonicalMembers⟩

/-! ## Open items, settlements and remeasurement -/

/-- `SettlementScope`. -/
def SettlementScope.canonicalMembers (scope : SettlementScope) : List Member :=
  [member "externalPartyId" scope.externalPartyId,
    member "controlAccountId" scope.controlAccountId]

instance : CanonicalObject SettlementScope := ⟨SettlementScope.canonicalMembers⟩

/-- `Omit<OpenItem, "contentHash">`. -/
def OpenItemBody.canonicalMembers (item : OpenItemBody) : List Member :=
  [member "id" item.id, member "bookId" item.bookId, member "kind" item.kind,
    member "scope" item.scope, optMember "recognitionSource" item.recognitionSource,
    optMember "recognitionPostingId" item.recognitionPostingId,
    member "recognizedOn" item.recognizedOn,
    member "denominationCommodityId" item.denominationCommodityId,
    member "denomination" item.denomination, member "bookValue" item.bookValue,
    member "derivation" item.derivation]

instance : CanonicalObject OpenItemBody := ⟨OpenItemBody.canonicalMembers⟩

/-- `OpenItem`. -/
def OpenItem.canonicalMembers (item : OpenItem) : List Member :=
  item.toOpenItemBody.canonicalMembers ++ [member "contentHash" item.contentHash]

instance : CanonicalObject OpenItem := ⟨OpenItem.canonicalMembers⟩

/-- `Omit<Settlement, "contentHash">`. -/
def SettlementBody.canonicalMembers (settlement : SettlementBody) : List Member :=
  [member "id" settlement.id, member "bookId" settlement.bookId, member "kind" settlement.kind,
    member "scope" settlement.scope, optMember "settlementSource" settlement.settlementSource,
    optMember "settlementPostingId" settlement.settlementPostingId,
    member "settledAt" settlement.settledAt,
    member "denominationCommodityId" settlement.denominationCommodityId,
    member "denomination" settlement.denomination, member "bookValue" settlement.bookValue,
    member "derivation" settlement.derivation]

instance : CanonicalObject SettlementBody := ⟨SettlementBody.canonicalMembers⟩

/-- `Settlement`. -/
def Settlement.canonicalMembers (settlement : Settlement) : List Member :=
  settlement.toSettlementBody.canonicalMembers ++ [member "contentHash" settlement.contentHash]

instance : CanonicalObject Settlement := ⟨Settlement.canonicalMembers⟩

/-- `CurrencyValuationPath`. -/
def CurrencyValuationPath.canonicalMembers (path : CurrencyValuationPath) : List Member :=
  [member "fromCommodityId" path.fromCommodityId, member "toCommodityId" path.toCommodityId,
    member "effectiveAt" path.effectiveAt, member "observedAt" path.observedAt,
    member "rate" path.rate, member "evidenceIds" path.evidenceIds]

instance : CanonicalObject CurrencyValuationPath := ⟨CurrencyValuationPath.canonicalMembers⟩

/-- `Omit<SettlementAllocation, "contentHash">`. -/
def SettlementAllocationBody.canonicalMembers (allocation : SettlementAllocationBody) :
    List Member :=
  [member "id" allocation.id, member "openItemId" allocation.openItemId,
    member "settlementId" allocation.settlementId, optMember "appliedAt" allocation.appliedAt,
    member "allocatedBookValue" allocation.allocatedBookValue,
    member "allocatedOpenQuantity" allocation.allocatedOpenQuantity,
    member "allocatedSettlementQuantity" allocation.allocatedSettlementQuantity,
    optMember "allocatedOpenItemBookValue" allocation.allocatedOpenItemBookValue,
    optMember "allocatedSettlementBookValue" allocation.allocatedSettlementBookValue,
    optMember "settlementMeasurement" allocation.settlementMeasurement,
    optMember "realizedExchangeDifference" allocation.realizedExchangeDifference,
    optMember "valuationPath" allocation.valuationPath,
    optMember "realizedExchangeEffectKey" allocation.realizedExchangeEffectKey,
    member "derivation" allocation.derivation]

instance : CanonicalObject SettlementAllocationBody := ⟨SettlementAllocationBody.canonicalMembers⟩

/-- `SettlementAllocation`. -/
def SettlementAllocation.canonicalMembers (allocation : SettlementAllocation) : List Member :=
  allocation.toSettlementAllocationBody.canonicalMembers ++
    [member "contentHash" allocation.contentHash]

instance : CanonicalObject SettlementAllocation := ⟨SettlementAllocation.canonicalMembers⟩

/-- `RemeasurementResult`. -/
def RemeasurementResult.canonicalMembers (result : RemeasurementResult) : List Member :=
  [member "id" result.id, member "kind" result.kind,
    optMember "sourcePostingId" result.sourcePostingId, optMember "source" result.source,
    optMember "positionAccountId" result.positionAccountId,
    optMember "denominationCommodityId" result.denominationCommodityId,
    member "effectiveOn" result.effectiveOn,
    optMember "adjustmentEffectKey" result.adjustmentEffectKey,
    member "carryingBookValue" result.carryingBookValue,
    member "measuredBookValue" result.measuredBookValue, member "difference" result.difference,
    member "valuationRate" result.valuationRate, member "policyId" result.policyId,
    optMember "policy" result.policy, optMember "classificationPolicy" result.classificationPolicy,
    optMember "valuationPath" result.valuationPath, member "derivation" result.derivation,
    member "contentHash" result.contentHash]

instance : CanonicalObject RemeasurementResult := ⟨RemeasurementResult.canonicalMembers⟩

/-- `RemeasurementReversal`. -/
def RemeasurementReversal.canonicalMembers (reversal : RemeasurementReversal) : List Member :=
  [member "id" reversal.id, member "originalResultId" reversal.originalResultId,
    optMember "originalJournalId" reversal.originalJournalId,
    optMember "originalEffectKey" reversal.originalEffectKey,
    member "reversedOn" reversal.reversedOn, member "derivation" reversal.derivation,
    member "contentHash" reversal.contentHash]

instance : CanonicalObject RemeasurementReversal := ⟨RemeasurementReversal.canonicalMembers⟩

/-! ## Allocation schedules -/

/-- `ScheduledAllocation`. -/
def ScheduledAllocation.canonicalMembers (allocation : ScheduledAllocation) : List Member :=
  [member "ordinal" allocation.ordinal, member "accountingDate" allocation.accountingDate,
    member "amount" allocation.amount]

instance : CanonicalObject ScheduledAllocation := ⟨ScheduledAllocation.canonicalMembers⟩

/-- An installment of `AllocationPostingPlan`. -/
def AllocationPostingInstallment.canonicalMembers (installment : AllocationPostingInstallment) :
    List Member :=
  [member "ordinal" installment.ordinal, member "accountingDate" installment.accountingDate,
    member "exactAmount" installment.exactAmount,
    member "cumulativeTarget" installment.cumulativeTarget,
    member "cumulativeQuantization" installment.cumulativeQuantization,
    member "postedAmount" installment.postedAmount,
    member "exactToPostedDifference" installment.exactToPostedDifference]

instance : CanonicalObject AllocationPostingInstallment :=
  ⟨AllocationPostingInstallment.canonicalMembers⟩

/-- `AllocationPostingPlan`. -/
def AllocationPostingPlan.canonicalMembers (plan : AllocationPostingPlan) : List Member :=
  [member "algorithmVersion" plan.algorithmVersion,
    member "exactSourceBasis" plan.exactSourceBasis,
    member "exactResidualValue" plan.exactResidualValue,
    member "postedSourceBasis" plan.postedSourceBasis,
    member "residualQuantization" plan.residualQuantization,
    member "quantizationPolicy" plan.quantizationPolicy,
    member "installments" plan.installments, member "contentHash" plan.contentHash]

instance : CanonicalObject AllocationPostingPlan := ⟨AllocationPostingPlan.canonicalMembers⟩

/-- `AllocationSchedule`. -/
def AllocationSchedule.canonicalMembers (schedule : AllocationSchedule) : List Member :=
  [member "id" schedule.id, member "bookId" schedule.bookId, member "policyId" schedule.policyId,
    member "policy" schedule.policy, optMember "source" schedule.source,
    optMember "sourcePostingId" schedule.sourcePostingId,
    member "sourceBasis" schedule.sourceBasis, member "residualValue" schedule.residualValue,
    member "installments" schedule.installments, optMember "postingPlan" schedule.postingPlan,
    member "derivation" schedule.derivation, member "contentHash" schedule.contentHash]

instance : CanonicalObject AllocationSchedule := ⟨AllocationSchedule.canonicalMembers⟩

/-- `AllocationRecognition`. -/
def AllocationRecognition.canonicalMembers (recognition : AllocationRecognition) :
    List Member :=
  [member "id" recognition.id, member "scheduleId" recognition.scheduleId,
    member "ordinal" recognition.ordinal, member "derivation" recognition.derivation,
    member "contentHash" recognition.contentHash]

instance : CanonicalObject AllocationRecognition := ⟨AllocationRecognition.canonicalMembers⟩

/-- `AllocationScheduleRevision`. -/
def AllocationScheduleRevision.canonicalMembers (revision : AllocationScheduleRevision) :
    List Member :=
  [member "id" revision.id, member "kind" revision.kind,
    member "effectiveOn" revision.effectiveOn,
    optMember "generatedEffectKey" revision.generatedEffectKey,
    member "originalScheduleId" revision.originalScheduleId,
    member "priorRecognitionIds" revision.priorRecognitionIds,
    member "recognizedToDate" revision.recognizedToDate,
    member "carryingAmountAtRevision" revision.carryingAmountAtRevision,
    optMember "postedRecognizedToDate" revision.postedRecognizedToDate,
    optMember "postedCarryingAmountAtRevision" revision.postedCarryingAmountAtRevision,
    member "revisedResidualValue" revision.revisedResidualValue,
    optMember "exactAdjustmentAmount" revision.exactAdjustmentAmount,
    optMember "bookedAdjustment" revision.bookedAdjustment,
    optMember "successorScheduleId" revision.successorScheduleId,
    member "policy" revision.policy, member "evidence" revision.evidence,
    member "derivation" revision.derivation, member "contentHash" revision.contentHash]

instance : CanonicalObject AllocationScheduleRevision :=
  ⟨AllocationScheduleRevision.canonicalMembers⟩

/-! ## Tax and consolidation -/

/-- `TaxComponentResult`. -/
def TaxComponentResult.canonicalMembers (result : TaxComponentResult) : List Member :=
  [member "policyId" result.policyId, member "exactTax" result.exactTax,
    member "quantization" result.quantization, member "recoverable" result.recoverable,
    member "nonRecoverable" result.nonRecoverable]

instance : CanonicalObject TaxComponentResult := ⟨TaxComponentResult.canonicalMembers⟩

/-- `TaxLineResult`. -/
def TaxLineResult.canonicalMembers (line : TaxLineResult) : List Member :=
  [member "lineId" line.lineId, member "policyId" line.policyId,
    member "exclusiveBasis" line.exclusiveBasis, member "components" line.components]

instance : CanonicalObject TaxLineResult := ⟨TaxLineResult.canonicalMembers⟩

/-- `TaxDetermination`. -/
def TaxDetermination.canonicalMembers (determination : TaxDetermination) : List Member :=
  [member "id" determination.id, member "bookId" determination.bookId,
    member "taxPoint" determination.taxPoint,
    member "sourceTransactionId" determination.sourceTransactionId,
    member "direction" determination.direction, member "lines" determination.lines,
    member "derivation" determination.derivation,
    member "contentHash" determination.contentHash]

instance : CanonicalObject TaxDetermination := ⟨TaxDetermination.canonicalMembers⟩

/-- `ConsolidationCompilation`. -/
def ConsolidationCompilation.canonicalMembers (compilation : ConsolidationCompilation) :
    List Member :=
  [member "id" compilation.id, member "bookId" compilation.bookId,
    member "policyId" compilation.policyId, member "throughOn" compilation.throughOn,
    member "sourcePopulationHashes" compilation.sourcePopulationHashes,
    member "derivation" compilation.derivation, member "contentHash" compilation.contentHash]

instance : CanonicalObject ConsolidationCompilation := ⟨ConsolidationCompilation.canonicalMembers⟩

/-! ## State and effects -/

/-- `AccountingCanonicalState`: thirteen arrays. -/
def AccountingCanonicalState.canonicalMembers (state : AccountingCanonicalState) :
    List Member :=
  [member "provisionalInventoryLayers" state.provisionalInventoryLayers,
    member "inventoryRecostings" state.inventoryRecostings,
    member "inventoryValueAdjustments" state.inventoryValueAdjustments,
    member "openItems" state.openItems, member "settlements" state.settlements,
    member "settlementAllocations" state.settlementAllocations,
    member "remeasurementResults" state.remeasurementResults,
    member "remeasurementReversals" state.remeasurementReversals,
    member "allocationSchedules" state.allocationSchedules,
    member "allocationRecognitions" state.allocationRecognitions,
    member "allocationScheduleRevisions" state.allocationScheduleRevisions,
    member "taxDeterminations" state.taxDeterminations,
    member "consolidationCompilations" state.consolidationCompilations]

instance : CanonicalObject AccountingCanonicalState := ⟨AccountingCanonicalState.canonicalMembers⟩

/-- `canonicalize(effect.value)`: the canonical value of the value an effect holds. -/
def AccountingEffect.canonicalValue : AccountingEffect → CanonicalValue
  | .provisionalInventoryLayer value => canonicalize value
  | .inventoryRecosting value => canonicalize value
  | .inventoryValueAdjustment value => canonicalize value
  | .openItem value => canonicalize value
  | .settlement value => canonicalize value
  | .settlementAllocation value => canonicalize value
  | .remeasurementResult value => canonicalize value
  | .remeasurementReversal value => canonicalize value
  | .allocationSchedule value => canonicalize value
  | .allocationRecognition value => canonicalize value
  | .allocationScheduleRevision value => canonicalize value
  | .taxDetermination value => canonicalize value
  | .consolidationCompilation value => canonicalize value

/-- An effect is the object `{ type, value }`. -/
def AccountingEffect.canonicalMembers (effect : AccountingEffect) : List Member :=
  [literalMember "type" effect.type, ("value", some effect.canonicalValue)]

instance : CanonicalObject AccountingEffect := ⟨AccountingEffect.canonicalMembers⟩

/-- `AccountingDraft`. -/
def AccountingDraft.canonicalMembers (draft : AccountingDraft) : List Member :=
  [member "journals" draft.journals, member "effects" draft.effects]

instance : CanonicalObject AccountingDraft := ⟨AccountingDraft.canonicalMembers⟩

/-! ## Requests of `accounting.ts` lines 1131 to 1165 -/

/-- `OpenItemRecognitionRequest`. -/
def OpenItemRecognitionRequest.canonicalMembers (request : OpenItemRecognitionRequest) :
    List Member :=
  [member "value" request.value]

instance : CanonicalObject OpenItemRecognitionRequest :=
  ⟨OpenItemRecognitionRequest.canonicalMembers⟩

/-- `SettlementRequestCore`. -/
def SettlementRequestCore.canonicalMembers (request : SettlementRequestCore) : List Member :=
  [member "settlement" request.settlement, member "allocations" request.allocations,
    optMember "quantizationPolicy" request.quantizationPolicy,
    optMember "realizedExchangePolicyId" request.realizedExchangePolicyId,
    optMember "realizedExchangePolicyVersion" request.realizedExchangePolicyVersion]

instance : CanonicalObject SettlementRequestCore := ⟨SettlementRequestCore.canonicalMembers⟩

/-- `SettlementRequest`. -/
def SettlementRequest.canonicalMembers (request : SettlementRequest) : List Member :=
  request.toSettlementRequestCore.canonicalMembers ++
    [optMember "operation" request.operation, optMember "appliedAt" request.appliedAt]

instance : CanonicalObject SettlementRequest := ⟨SettlementRequest.canonicalMembers⟩

/-- `AllocatedTotal`. -/
def AllocatedTotal.canonicalMembers (total : AllocatedTotal) : List Member :=
  [member "bookValue" total.bookValue, member "quantity" total.quantity]

instance : CanonicalObject AllocatedTotal := ⟨AllocatedTotal.canonicalMembers⟩

/-! ## `canonicalAccountingValue` and `accountingHash` -/

/-- `canonicalAccountingValue` (line 702). -/
def canonicalAccountingValue {α : Type} [Canonicalize α] (value : α) : CanonicalValue :=
  canonicalize value

/-- `accountingHash` (line 713): the hash of the record `{ type, value }`. -/
def accountingHash {α : Type} [Canonicalize α] (type : String) (body : α) : ContentHash :=
  hashCanonical (.record [("type", .string type), ("value", canonicalize body)])

/-- `const { contentHash, ...body } = value` (lines 731 and 2205): the properties of an object but
its `contentHash`. -/
def withoutContentHash (members : List Member) : List Member :=
  members.filter fun m => m.1 != "contentHash"

/-- The canonical value of `body` in `const { contentHash, ...body } = value`. -/
def bodyValue {α : Type} [CanonicalObject α] (value : α) : CanonicalValue :=
  object (withoutContentHash (CanonicalObject.members value))

/-- `accountingHash(type, body)` of the body of a value: what its `contentHash` is meant to be. -/
def accountingBodyHash {α : Type} [CanonicalObject α] (type : String) (value : α) : ContentHash :=
  accountingHash type (bodyValue value)

/-! ## Meaning: a canonical value is well formed and determines its value -/

/-- Two optional canonical values that are both absent, or both present and equal up to the order
of record entries. -/
def OptEquiv : Option CanonicalValue → Option CanonicalValue → Prop
  | none, none => True
  | some a, some b => a.Equiv b
  | _, _ => False

/-- A type whose canonical values are well formed (no record repeats a key) and determine the
value: two values whose canonical values are equal up to the order of record entries are the same
value. -/
class LawfulCanonicalize (α : Type) [Canonicalize α] : Prop where
  /-- The canonical value of a value is well formed. -/
  wf : ∀ value : α, (canonicalize value).WF
  /-- The canonical value of a value determines it. -/
  inj : ∀ {a b : α}, (canonicalize a).Equiv (canonicalize b) → a = b

/-- Two values of a lawful type have the same canonical value exactly when they are the same. -/
theorem canonicalize_eq_iff {α : Type} [Canonicalize α] [LawfulCanonicalize α] (a b : α) :
    canonicalize a = canonicalize b ↔ a = b :=
  ⟨fun h => LawfulCanonicalize.inj (h ▸ CanonicalValue.Equiv_refl _), fun h => h ▸ rfl⟩

/-- The keys of the entries of an object are among its properties' keys, in order. -/
theorem objectEntries_keys_sublist (members : List Member) :
    ((objectEntries members).map Prod.fst).Sublist (members.map Prod.fst) := by
  induction members with
  | nil => exact List.Sublist.slnil
  | cons m rest ih =>
    obtain ⟨key, value⟩ := m
    cases value with
    | none => simpa [objectEntries] using ih.cons key
    | some v => simpa [objectEntries] using ih.cons_cons key

/-- An object with distinct property keys has distinct entry keys. -/
theorem objectEntries_keys_nodup {members : List Member} (h : (members.map Prod.fst).Nodup) :
    ((objectEntries members).map Prod.fst).Nodup :=
  (objectEntries_keys_sublist members).nodup h

/-- The canonical value of an object, with its keys distinct and every present value well formed,
is well formed. -/
theorem object_wf {members : List Member} (hkeys : (members.map Prod.fst).Nodup)
    (hvalues : ∀ m ∈ members, ∀ value, m.2 = some value → value.WF) : (object members).WF := by
  refine ⟨objectEntries_keys_nodup hkeys, ?_⟩
  clear hkeys
  induction members with
  | nil => trivial
  | cons m rest ih =>
    obtain ⟨key, value⟩ := m
    have hrest := ih fun m hm => hvalues m (List.mem_cons_of_mem _ hm)
    cases value with
    | none => simpa [objectEntries] using hrest
    | some v =>
      have hv := hvalues (key, some v) (by simp) v rfl
      simp only [objectEntries, List.filterMap_cons, Option.map_some] at hrest ⊢
      exact ⟨hv, hrest⟩

/-- The value under a key in a list of entries: the first entry with that key. -/
def entryAt {α : Type} (key : String) : List (String × α) → Option α
  | [] => none
  | (k, v) :: rest => if k = key then some v else entryAt key rest

/-- A key that no entry has finds nothing. -/
theorem entryAt_eq_none {α : Type} {key : String} :
    ∀ {entries : List (String × α)}, key ∉ entries.map Prod.fst → entryAt key entries = none
  | [], _ => rfl
  | (k, v) :: rest, h => by
    simp only [List.map_cons, List.mem_cons, not_or] at h
    simp only [entryAt, Ne.symm h.1, ite_false]
    exact entryAt_eq_none h.2

/-- Rearranging entries with distinct keys finds the same value under every key. -/
theorem entryAt_perm {α : Type} {key : String} {xs ys : List (String × α)} (hp : xs.Perm ys)
    (hnodup : (xs.map Prod.fst).Nodup) : entryAt key xs = entryAt key ys := by
  induction hp with
  | nil => rfl
  | cons x _ ih =>
    obtain ⟨k, v⟩ := x
    simp only [List.map_cons, List.nodup_cons] at hnodup
    simp only [entryAt, ih hnodup.2]
  | swap x y l =>
    obtain ⟨kx, vx⟩ := x
    obtain ⟨ky, vy⟩ := y
    simp only [List.map_cons, List.nodup_cons, List.mem_cons, not_or] at hnodup
    simp only [entryAt]
    by_cases h1 : ky = key <;> by_cases h2 : kx = key
    · exact absurd (h1.trans h2.symm) hnodup.1.1
    all_goals simp [h1, h2]
  | trans h₁ _ ih₁ ih₂ =>
    rw [ih₁ hnodup, ih₂ ((h₁.map Prod.fst).nodup_iff.mp hnodup)]

/-- Entries that are equal one by one, up to the order of record entries, find values that are so
under every key. -/
theorem optEquiv_entryAt {key : String} :
    ∀ {xs ys : List (String × CanonicalValue)}, CanonicalValue.EquivEntries xs ys →
      OptEquiv (entryAt key xs) (entryAt key ys)
  | [], [], _ => trivial
  | [], _ :: _, h => by simp [CanonicalValue.EquivEntries] at h
  | _ :: _, [], h => by simp [CanonicalValue.EquivEntries] at h
  | (k₁, v₁) :: xs, (k₂, v₂) :: ys, h => by
    obtain ⟨hk, hv, hrest⟩ := h
    subst hk
    simp only [entryAt]
    split
    · exact hv
    · exact optEquiv_entryAt hrest

/-- The value an object's record has under a key is the property's value under it. -/
theorem entryAt_objectEntries {key : String} :
    ∀ {members : List Member}, (members.map Prod.fst).Nodup →
      entryAt key (objectEntries members) = (entryAt key members).bind id
  | [], _ => rfl
  | (k, none) :: rest, h => by
    simp only [List.map_cons, List.nodup_cons] at h
    simp only [objectEntries, List.filterMap_cons, Option.map_none] at ⊢
    rw [show List.filterMap (fun m : Member => m.2.map fun value => (m.1, value)) rest =
      objectEntries rest from rfl, entryAt_objectEntries h.2]
    simp only [entryAt]
    split
    · next hk => subst hk; rw [entryAt_eq_none h.1]; rfl
    · rfl
  | (k, some v) :: rest, h => by
    simp only [List.map_cons, List.nodup_cons] at h
    simp only [objectEntries, List.filterMap_cons, Option.map_some, entryAt]
    split
    · rfl
    · exact entryAt_objectEntries h.2

/-- Two lists of properties with the same distinct keys in the same order, whose values under every
key are both absent or both present and equal up to the order of record entries, are so property
by property. -/
theorem forall₂_of_entryAt :
    ∀ {members₁ members₂ : List Member}, members₁.map Prod.fst = members₂.map Prod.fst →
      (members₁.map Prod.fst).Nodup →
      (∀ key, OptEquiv ((entryAt key members₁).bind id) ((entryAt key members₂).bind id)) →
      List.Forall₂ (fun m₁ m₂ => OptEquiv m₁.2 m₂.2) members₁ members₂
  | [], [], _, _, _ => List.Forall₂.nil
  | [], _ :: _, hkeys, _, _ => by simp at hkeys
  | _ :: _, [], hkeys, _, _ => by simp at hkeys
  | (k₁, o₁) :: r₁, (k₂, o₂) :: r₂, hkeys, hnodup, h => by
    simp only [List.map_cons, List.cons.injEq] at hkeys
    obtain ⟨hk, hrest⟩ := hkeys
    subst hk
    simp only [List.map_cons, List.nodup_cons] at hnodup
    refine List.Forall₂.cons ?_ (forall₂_of_entryAt hrest hnodup.2 fun key => ?_)
    · have := h k₁
      simp only [entryAt, ite_true, Option.bind_some, id] at this
      exact this
    · by_cases hkey : k₁ = key
      · subst hkey
        rw [entryAt_eq_none hnodup.1, entryAt_eq_none (hrest ▸ hnodup.1)]
        trivial
      · have := h key
        simp only [entryAt, hkey, ite_false] at this
        exact this

/-- Two objects with the same keys, in the same order and distinct, whose records are equal up to
the order of entries: property by property, both absent or both present and equal up to that
order. -/
theorem object_equiv_forall₂ {members₁ members₂ : List Member}
    (hkeys : members₁.map Prod.fst = members₂.map Prod.fst)
    (hnodup : (members₁.map Prod.fst).Nodup)
    (h : (object members₁).Equiv (object members₂)) :
    List.Forall₂ (fun m₁ m₂ => OptEquiv m₁.2 m₂.2) members₁ members₂ := by
  refine forall₂_of_entryAt hkeys hnodup fun key => ?_
  obtain ⟨zs, hperm, hentries⟩ := h
  have := optEquiv_entryAt (key := key) hentries
  rw [← entryAt_perm hperm (objectEntries_keys_nodup hnodup), entryAt_objectEntries hnodup,
    entryAt_objectEntries (hkeys ▸ hnodup)] at this
  exact this

/-! ### The steps every instance below takes -/

/-- A property with a value present that is the canonical value of a lawful value: the two
properties agree exactly when the values are the same. -/
theorem optEquiv_some_canonicalize_iff {α : Type} [Canonicalize α] [LawfulCanonicalize α]
    (x y : α) : OptEquiv (some (canonicalize x)) (some (canonicalize y)) ↔ x = y :=
  ⟨fun h => LawfulCanonicalize.inj h, fun h => h ▸ CanonicalValue.Equiv_refl _⟩

/-- An optional property of a lawful type: the two agree exactly when the options are the same. -/
theorem optEquiv_map_canonicalize_iff {α : Type} [Canonicalize α] [LawfulCanonicalize α]
    (x y : Option α) : OptEquiv (x.map canonicalize) (y.map canonicalize) ↔ x = y := by
  cases x <;> cases y <;> simp [OptEquiv, optEquiv_some_canonicalize_iff] <;>
    exact ⟨fun h => LawfulCanonicalize.inj h, fun h => h ▸ CanonicalValue.Equiv_refl _⟩

/-- A literal property agrees with itself. -/
theorem optEquiv_literal_iff (text : String) :
    OptEquiv (some (.string text)) (some (.string text)) ↔ True := by
  simp [OptEquiv, CanonicalValue.Equiv]

/-- A property whose value, when present, is well formed. -/
def MemberWF (m : Member) : Prop := ∀ value, m.2 = some value → value.WF

theorem member_wf {α : Type} [Canonicalize α] [LawfulCanonicalize α] (key : String) (x : α) :
    MemberWF (member key x) := by
  intro value h
  cases h
  exact LawfulCanonicalize.wf x

theorem optMember_wf {α : Type} [Canonicalize α] [LawfulCanonicalize α] (key : String)
    (x : Option α) : MemberWF (optMember key x) := by
  intro value h
  cases x with
  | none => cases h
  | some x => cases h; exact LawfulCanonicalize.wf x

theorem literalMember_wf (key text : String) : MemberWF (literalMember key text) := by
  intro value h
  cases h
  trivial

/-- `object_wf` with each property's well-formedness stated as `MemberWF`. -/
theorem object_wf_of {members : List Member} (hkeys : (members.map Prod.fst).Nodup)
    (hvalues : ∀ m ∈ members, MemberWF m) : (object members).WF :=
  object_wf hkeys hvalues

/-- The canonical value of a string literal of a type determines the literal when `text` does. -/
theorem lawful_of_text {α : Type} [Canonicalize α] (text : α → String)
    (hc : ∀ a, canonicalize a = .string (text a)) (hinj : ∀ a b, text a = text b → a = b) :
    LawfulCanonicalize α where
  wf a := by rw [hc]; trivial
  inj {a b} h := by
    rw [hc, hc] at h
    exact hinj a b h

/-! ### Strings, numbers and lists -/

instance : LawfulCanonicalize String := ⟨fun _ => trivial, fun h => h⟩
instance : LawfulCanonicalize Int := ⟨fun _ => trivial, fun h => h⟩
instance : LawfulCanonicalize Bool := ⟨fun _ => trivial, fun h => h⟩

instance : LawfulCanonicalize SemanticVersion :=
  ⟨fun _ => trivial, fun {a b} h => by cases a; cases b; exact congrArg _ h⟩
instance : LawfulCanonicalize Instant :=
  ⟨fun _ => trivial, fun {a b} h => by cases a; cases b; exact congrArg _ h⟩
instance : LawfulCanonicalize LocalDate :=
  ⟨fun _ => trivial, fun {a b} h => by cases a; cases b; exact congrArg _ h⟩
instance : LawfulCanonicalize EffectKey :=
  ⟨fun _ => trivial, fun {a b} h => by cases a; cases b; exact congrArg _ h⟩
instance {Kind : String} : LawfulCanonicalize (Identifier Kind) :=
  ⟨fun _ => trivial, fun {a b} h => by cases a; cases b; exact congrArg _ h⟩

instance {α : Type} [Canonicalize α] [LawfulCanonicalize α] : LawfulCanonicalize (List α) where
  wf values := by
    show CanonicalValue.WFList (values.map canonicalize)
    induction values with
    | nil => trivial
    | cons value rest ih => exact ⟨LawfulCanonicalize.wf value, ih⟩
  inj {a b} h := by
    change CanonicalValue.EquivList (a.map canonicalize) (b.map canonicalize) at h
    induction a generalizing b with
    | nil =>
      cases b with
      | nil => rfl
      | cons _ _ => exact h.elim
    | cons x xs ih =>
      cases b with
      | nil => exact h.elim
      | cons y ys => rw [LawfulCanonicalize.inj h.1, ih h.2]

/-! ### String literals -/

instance : LawfulCanonicalize AccountingFeature :=
  lawful_of_text AccountingFeature.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AccountingCapabilityStatus :=
  lawful_of_text AccountingCapabilityStatus.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize InventoryCostMethod :=
  lawful_of_text InventoryCostMethod.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize InventoryShortageTreatment :=
  lawful_of_text InventoryShortageTreatment.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize ProvisionalBasisMethod :=
  lawful_of_text ProvisionalBasisMethod.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize InventoryValueAdjustmentKind :=
  lawful_of_text InventoryValueAdjustmentKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AccountingBasisEvent :=
  lawful_of_text AccountingBasisEvent.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AccountingBasisTreatment :=
  lawful_of_text AccountingBasisTreatment.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AccountingBasis :=
  lawful_of_text AccountingBasis.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize MonetaryClassification :=
  lawful_of_text MonetaryClassification.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AllocationPostingAlgorithm :=
  lawful_of_text AllocationPostingAlgorithm.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AllocationMethod :=
  lawful_of_text AllocationMethod.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AllocationFrequency :=
  lawful_of_text AllocationFrequency.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AllocationConvention :=
  lawful_of_text AllocationConvention.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize TaxInclusion :=
  lawful_of_text TaxInclusion.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize TaxTreatment :=
  lawful_of_text TaxTreatment.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize TaxRecoverability :=
  lawful_of_text TaxRecoverability.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize TaxRoundingLevel :=
  lawful_of_text TaxRoundingLevel.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize TaxGroupingAlgorithm :=
  lawful_of_text TaxGroupingAlgorithm.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize ConsolidationMethod :=
  lawful_of_text ConsolidationMethod.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize RoundingMode :=
  lawful_of_text RoundingMode.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize DerivationState :=
  lawful_of_text DerivationState.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize OpenItemKind :=
  lawful_of_text OpenItemKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize SettlementKind :=
  lawful_of_text SettlementKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize RemeasurementKind :=
  lawful_of_text RemeasurementKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize AllocationScheduleChangeKind :=
  lawful_of_text AllocationScheduleChangeKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize TaxDirection :=
  lawful_of_text TaxDirection.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize PreparedJournalKind :=
  lawful_of_text PreparedJournalKind.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)
instance : LawfulCanonicalize SettlementOperation :=
  lawful_of_text SettlementOperation.text (fun _ => rfl) fun a b h => by
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-! ### Objects -/

attribute [ext] ExactRational

instance : LawfulCanonicalize ExactRational where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ExactRational.canonicalMembers, member, optMember, literalMember])
    (by simp only [ExactRational.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ExactRational.canonicalMembers, member, optMember, literalMember]) h
    simp only [ExactRational.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ExactRational.ext_iff.mpr this

attribute [ext] ExactDecimal

instance : LawfulCanonicalize ExactDecimal where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ExactDecimal.canonicalMembers, member, optMember, literalMember])
    (by simp only [ExactDecimal.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ExactDecimal.canonicalMembers, member, optMember, literalMember]) h
    simp only [ExactDecimal.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ExactDecimal.ext_iff.mpr this

attribute [ext] ContentHash

instance : LawfulCanonicalize ContentHash where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ContentHash.canonicalMembers, member, optMember, literalMember])
    (by simp only [ContentHash.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ContentHash.canonicalMembers, member, optMember, literalMember]) h
    simp only [ContentHash.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ContentHash.ext_iff.mpr this

attribute [ext] QuantizedValue

instance : LawfulCanonicalize QuantizedValue where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [QuantizedValue.canonicalMembers, member, optMember, literalMember])
    (by simp only [QuantizedValue.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [QuantizedValue.canonicalMembers, member, optMember, literalMember]) h
    simp only [QuantizedValue.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact QuantizedValue.ext_iff.mpr this

attribute [ext] QuantizationPolicy

instance : LawfulCanonicalize QuantizationPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [QuantizationPolicy.canonicalMembers, member, optMember, literalMember])
    (by simp only [QuantizationPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [QuantizationPolicy.canonicalMembers, member, optMember, literalMember]) h
    simp only [QuantizationPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact QuantizationPolicy.ext_iff.mpr this

attribute [ext] AccountingCapabilityCombination

instance : LawfulCanonicalize AccountingCapabilityCombination where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingCapabilityCombination.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingCapabilityCombination.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingCapabilityCombination.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingCapabilityCombination.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingCapabilityCombination.ext_iff.mpr this

attribute [ext] AccountingCapability

instance : LawfulCanonicalize AccountingCapability where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingCapability.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingCapability.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingCapability.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingCapability.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingCapability.ext_iff.mpr this

attribute [ext] AccountingPolicyArtifactCore

instance : LawfulCanonicalize AccountingPolicyArtifactCore where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingPolicyArtifactCore.ext_iff.mpr this

attribute [ext] AccountingPolicyCore

instance : LawfulCanonicalize AccountingPolicyCore where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingPolicyCore.ext_iff.mpr this

attribute [ext] InventoryPool

instance : LawfulCanonicalize InventoryPool where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryPool.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryPool.ext_iff.mpr this

attribute [ext] InventoryCostPolicy

instance : LawfulCanonicalize InventoryCostPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryCostPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryCostPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryCostPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryCostPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryCostPolicy.ext_iff.mpr this

attribute [ext] InventoryValueAdjustmentPolicy

instance : LawfulCanonicalize InventoryValueAdjustmentPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryValueAdjustmentPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryValueAdjustmentPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryValueAdjustmentPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryValueAdjustmentPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryValueAdjustmentPolicy.ext_iff.mpr this

attribute [ext] AccountingBasisRule

instance : LawfulCanonicalize AccountingBasisRule where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingBasisRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingBasisRule.ext_iff.mpr this

attribute [ext] AccountingBasisPolicy

instance : LawfulCanonicalize AccountingBasisPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingBasisPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingBasisPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingBasisPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingBasisPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingBasisPolicy.ext_iff.mpr this

attribute [ext] CurrencyPolicy

instance : LawfulCanonicalize CurrencyPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [CurrencyPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [CurrencyPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [CurrencyPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [CurrencyPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact CurrencyPolicy.ext_iff.mpr this

attribute [ext] MonetaryClassificationRule

instance : LawfulCanonicalize MonetaryClassificationRule where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [MonetaryClassificationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact MonetaryClassificationRule.ext_iff.mpr this

attribute [ext] MonetaryClassificationPolicy

instance : LawfulCanonicalize MonetaryClassificationPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [MonetaryClassificationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [MonetaryClassificationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [MonetaryClassificationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [MonetaryClassificationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact MonetaryClassificationPolicy.ext_iff.mpr this

attribute [ext] AllocationPolicy

instance : LawfulCanonicalize AllocationPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AllocationPolicy.ext_iff.mpr this

attribute [ext] TaxPolicyComponent

instance : LawfulCanonicalize TaxPolicyComponent where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [TaxPolicyComponent.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact TaxPolicyComponent.ext_iff.mpr this

attribute [ext] TaxPolicy

instance : LawfulCanonicalize TaxPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [TaxPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [TaxPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [TaxPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [TaxPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact TaxPolicy.ext_iff.mpr this

attribute [ext] ConsolidationAccountMapping

instance : LawfulCanonicalize ConsolidationAccountMapping where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [ConsolidationAccountMapping.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ConsolidationAccountMapping.ext_iff.mpr this

attribute [ext] ConsolidationValuationPolicy

instance : LawfulCanonicalize ConsolidationValuationPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ConsolidationValuationPolicy.canonicalMembers, member, optMember, literalMember])
    (by simp only [ConsolidationValuationPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ConsolidationValuationPolicy.canonicalMembers, member, optMember, literalMember]) h
    simp only [ConsolidationValuationPolicy.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ConsolidationValuationPolicy.ext_iff.mpr this

attribute [ext] ConsolidationTranslationRule

instance : LawfulCanonicalize ConsolidationTranslationRule where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [ConsolidationTranslationRule.canonicalMembers, AccountingPolicyArtifactCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ConsolidationTranslationRule.ext_iff.mpr this

attribute [ext] ConsolidationPolicy

instance : LawfulCanonicalize ConsolidationPolicy where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ConsolidationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [ConsolidationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ConsolidationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [ConsolidationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ConsolidationPolicy.ext_iff.mpr this

/-- The `kind` property of a policy is its kind. -/
theorem AccountingPolicy.entryAt_kind (policy : AccountingPolicy) :
    entryAt "kind" policy.canonicalMembers = some (some (.string policy.kind.text)) := by
  cases policy <;>
    simp [AccountingPolicy.canonicalMembers, InventoryCostPolicy.canonicalMembers,
      InventoryValueAdjustmentPolicy.canonicalMembers, AccountingBasisPolicy.canonicalMembers,
      CurrencyPolicy.canonicalMembers, MonetaryClassificationPolicy.canonicalMembers,
      AllocationPolicy.canonicalMembers, TaxPolicy.canonicalMembers,
      ConsolidationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member,
      optMember, literalMember, entryAt, AccountingPolicy.kind, AccountingFeature.text]

/-- The properties of a policy have distinct keys. -/
theorem AccountingPolicy.canonicalMembers_nodup (policy : AccountingPolicy) :
    (policy.canonicalMembers.map Prod.fst).Nodup := by
  cases policy <;>
    simp [AccountingPolicy.canonicalMembers, InventoryCostPolicy.canonicalMembers,
      InventoryValueAdjustmentPolicy.canonicalMembers, AccountingBasisPolicy.canonicalMembers,
      CurrencyPolicy.canonicalMembers, MonetaryClassificationPolicy.canonicalMembers,
      AllocationPolicy.canonicalMembers, TaxPolicy.canonicalMembers,
      ConsolidationPolicy.canonicalMembers, AccountingPolicyCore.canonicalMembers, member,
      optMember, literalMember]

/-- Two objects with distinct keys whose records are equal up to the order of entries have, under
every key, values that are both absent or both present and equal up to that order. -/
theorem object_equiv_entryAt {members₁ members₂ : List Member}
    (hnodup₁ : (members₁.map Prod.fst).Nodup) (hnodup₂ : (members₂.map Prod.fst).Nodup)
    (h : (object members₁).Equiv (object members₂)) (key : String) :
    OptEquiv ((entryAt key members₁).bind id) ((entryAt key members₂).bind id) := by
  obtain ⟨zs, hperm, hentries⟩ := h
  have := optEquiv_entryAt (key := key) hentries
  rw [← entryAt_perm hperm (objectEntries_keys_nodup hnodup₁), entryAt_objectEntries hnodup₁,
    entryAt_objectEntries hnodup₂] at this
  exact this

theorem AccountingFeature.text_injective {a b : AccountingFeature} (h : a.text = b.text) :
    a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

instance : LawfulCanonicalize AccountingPolicy where
  wf policy := by
    cases policy with
    | inventoryCost p => exact LawfulCanonicalize.wf p
    | inventoryValueAdjustment p => exact LawfulCanonicalize.wf p
    | accountingBasis p => exact LawfulCanonicalize.wf p
    | monetaryClassification p => exact LawfulCanonicalize.wf p
    | currencyRemeasurement p => exact LawfulCanonicalize.wf p
    | allocationSchedule p => exact LawfulCanonicalize.wf p
    | taxDetermination p => exact LawfulCanonicalize.wf p
    | consolidation p => exact LawfulCanonicalize.wf p
  inj {a b} h := by
    have hkind := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) a.canonicalMembers_nodup b.canonicalMembers_nodup h "kind"
    rw [a.entryAt_kind, b.entryAt_kind] at hkind
    have hk : a.kind = b.kind := AccountingFeature.text_injective hkind
    cases a <;> cases b <;> simp only [AccountingPolicy.kind, reduceCtorEq] at hk <;>
      exact congrArg _ (LawfulCanonicalize.inj h)

attribute [ext] AccountingPolicySnapshot

instance : LawfulCanonicalize AccountingPolicySnapshot where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingPolicySnapshot.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingPolicySnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingPolicySnapshot.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingPolicySnapshot.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingPolicySnapshot.ext_iff.mpr this

attribute [ext] SourceEvidence

instance : LawfulCanonicalize SourceEvidence where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SourceEvidence.canonicalMembers, member, optMember, literalMember])
    (by simp only [SourceEvidence.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SourceEvidence.canonicalMembers, member, optMember, literalMember]) h
    simp only [SourceEvidence.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SourceEvidence.ext_iff.mpr this

attribute [ext] DerivationRecord

instance : LawfulCanonicalize DerivationRecord where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [DerivationRecord.canonicalMembers, member, optMember, literalMember])
    (by simp only [DerivationRecord.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [DerivationRecord.canonicalMembers, member, optMember, literalMember]) h
    simp only [DerivationRecord.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact DerivationRecord.ext_iff.mpr this

attribute [ext] CanonicalPostingReferenceBody

instance : LawfulCanonicalize CanonicalPostingReferenceBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [CanonicalPostingReferenceBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [CanonicalPostingReferenceBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [CanonicalPostingReferenceBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [CanonicalPostingReferenceBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact CanonicalPostingReferenceBody.ext_iff.mpr this

attribute [ext] CanonicalPostingReference

instance : LawfulCanonicalize CanonicalPostingReference where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [CanonicalPostingReference.canonicalMembers, CanonicalPostingReferenceBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [CanonicalPostingReference.canonicalMembers, CanonicalPostingReferenceBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [CanonicalPostingReference.canonicalMembers, CanonicalPostingReferenceBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [CanonicalPostingReference.canonicalMembers, CanonicalPostingReferenceBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact CanonicalPostingReference.ext_iff.mpr this

attribute [ext] PreparedCostBasis

instance : LawfulCanonicalize PreparedCostBasis where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [PreparedCostBasis.canonicalMembers, member, optMember, literalMember])
    (by simp only [PreparedCostBasis.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [PreparedCostBasis.canonicalMembers, member, optMember, literalMember]) h
    simp only [PreparedCostBasis.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact PreparedCostBasis.ext_iff.mpr this

attribute [ext] ExactPreparedPosting

instance : LawfulCanonicalize ExactPreparedPosting where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ExactPreparedPosting.canonicalMembers, member, optMember, literalMember])
    (by simp only [ExactPreparedPosting.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ExactPreparedPosting.canonicalMembers, member, optMember, literalMember]) h
    simp only [ExactPreparedPosting.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ExactPreparedPosting.ext_iff.mpr this

attribute [ext] ExactPreparedJournal

instance : LawfulCanonicalize ExactPreparedJournal where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ExactPreparedJournal.canonicalMembers, member, optMember, literalMember])
    (by simp only [ExactPreparedJournal.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ExactPreparedJournal.canonicalMembers, member, optMember, literalMember]) h
    simp only [ExactPreparedJournal.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ExactPreparedJournal.ext_iff.mpr this

attribute [ext] InventoryLayerInput

instance : LawfulCanonicalize InventoryLayerInput where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryLayerInput.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryLayerInput.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryLayerInput.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryLayerInput.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryLayerInput.ext_iff.mpr this

attribute [ext] InventoryAllocationResult

instance : LawfulCanonicalize InventoryAllocationResult where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryAllocationResult.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryAllocationResult.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryAllocationResult.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryAllocationResult.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryAllocationResult.ext_iff.mpr this

attribute [ext] ProvisionalInventoryLayerBody

instance : LawfulCanonicalize ProvisionalInventoryLayerBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ProvisionalInventoryLayerBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [ProvisionalInventoryLayerBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ProvisionalInventoryLayerBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [ProvisionalInventoryLayerBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ProvisionalInventoryLayerBody.ext_iff.mpr this

attribute [ext] ProvisionalInventoryLayer

instance : LawfulCanonicalize ProvisionalInventoryLayer where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [ProvisionalInventoryLayer.canonicalMembers, ProvisionalInventoryLayerBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ProvisionalInventoryLayer.ext_iff.mpr this

attribute [ext] InventoryRecostingSource

instance : LawfulCanonicalize InventoryRecostingSource where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryRecostingSource.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryRecostingSource.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryRecostingSource.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryRecostingSource.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryRecostingSource.ext_iff.mpr this

attribute [ext] InventoryRecosting

instance : LawfulCanonicalize InventoryRecosting where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryRecosting.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryRecosting.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryRecosting.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryRecosting.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryRecosting.ext_iff.mpr this

attribute [ext] InventoryValueAdjustmentAllocation

instance : LawfulCanonicalize InventoryValueAdjustmentAllocation where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryValueAdjustmentAllocation.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryValueAdjustmentAllocation.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryValueAdjustmentAllocation.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryValueAdjustmentAllocation.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryValueAdjustmentAllocation.ext_iff.mpr this

attribute [ext] InventoryValueAdjustment

instance : LawfulCanonicalize InventoryValueAdjustment where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [InventoryValueAdjustment.canonicalMembers, member, optMember, literalMember])
    (by simp only [InventoryValueAdjustment.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [InventoryValueAdjustment.canonicalMembers, member, optMember, literalMember]) h
    simp only [InventoryValueAdjustment.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact InventoryValueAdjustment.ext_iff.mpr this

attribute [ext] SettlementScope

instance : LawfulCanonicalize SettlementScope where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SettlementScope.canonicalMembers, member, optMember, literalMember])
    (by simp only [SettlementScope.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SettlementScope.canonicalMembers, member, optMember, literalMember]) h
    simp only [SettlementScope.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SettlementScope.ext_iff.mpr this

attribute [ext] OpenItemBody

instance : LawfulCanonicalize OpenItemBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [OpenItemBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [OpenItemBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [OpenItemBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [OpenItemBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact OpenItemBody.ext_iff.mpr this

attribute [ext] OpenItem

instance : LawfulCanonicalize OpenItem where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [OpenItem.canonicalMembers, OpenItemBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact OpenItem.ext_iff.mpr this

attribute [ext] SettlementBody

instance : LawfulCanonicalize SettlementBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SettlementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [SettlementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SettlementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [SettlementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SettlementBody.ext_iff.mpr this

attribute [ext] Settlement

instance : LawfulCanonicalize Settlement where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [Settlement.canonicalMembers, SettlementBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [Settlement.canonicalMembers, SettlementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [Settlement.canonicalMembers, SettlementBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [Settlement.canonicalMembers, SettlementBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact Settlement.ext_iff.mpr this

attribute [ext] CurrencyValuationPath

instance : LawfulCanonicalize CurrencyValuationPath where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [CurrencyValuationPath.canonicalMembers, member, optMember, literalMember])
    (by simp only [CurrencyValuationPath.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [CurrencyValuationPath.canonicalMembers, member, optMember, literalMember]) h
    simp only [CurrencyValuationPath.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact CurrencyValuationPath.ext_iff.mpr this

attribute [ext] SettlementAllocationBody

instance : LawfulCanonicalize SettlementAllocationBody where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SettlementAllocationBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [SettlementAllocationBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SettlementAllocationBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [SettlementAllocationBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SettlementAllocationBody.ext_iff.mpr this

attribute [ext] SettlementAllocation

instance : LawfulCanonicalize SettlementAllocation where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, member, optMember, literalMember])
    (by simp only [SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, member, optMember, literalMember]) h
    simp only [SettlementAllocation.canonicalMembers, SettlementAllocationBody.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SettlementAllocation.ext_iff.mpr this

attribute [ext] RemeasurementResult

instance : LawfulCanonicalize RemeasurementResult where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [RemeasurementResult.canonicalMembers, member, optMember, literalMember])
    (by simp only [RemeasurementResult.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [RemeasurementResult.canonicalMembers, member, optMember, literalMember]) h
    simp only [RemeasurementResult.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact RemeasurementResult.ext_iff.mpr this

attribute [ext] RemeasurementReversal

instance : LawfulCanonicalize RemeasurementReversal where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [RemeasurementReversal.canonicalMembers, member, optMember, literalMember])
    (by simp only [RemeasurementReversal.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [RemeasurementReversal.canonicalMembers, member, optMember, literalMember]) h
    simp only [RemeasurementReversal.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact RemeasurementReversal.ext_iff.mpr this

attribute [ext] ScheduledAllocation

instance : LawfulCanonicalize ScheduledAllocation where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ScheduledAllocation.canonicalMembers, member, optMember, literalMember])
    (by simp only [ScheduledAllocation.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ScheduledAllocation.canonicalMembers, member, optMember, literalMember]) h
    simp only [ScheduledAllocation.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ScheduledAllocation.ext_iff.mpr this

attribute [ext] AllocationPostingInstallment

instance : LawfulCanonicalize AllocationPostingInstallment where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocationPostingInstallment.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocationPostingInstallment.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocationPostingInstallment.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocationPostingInstallment.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AllocationPostingInstallment.ext_iff.mpr this

attribute [ext] AllocationPostingPlan

instance : LawfulCanonicalize AllocationPostingPlan where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocationPostingPlan.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocationPostingPlan.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocationPostingPlan.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocationPostingPlan.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    have hversion : ∀ x y : AllocationPostingAlgorithm, x = y := by
      intro x y; cases x; cases y; rfl
    exact AllocationPostingPlan.ext_iff.mpr ⟨hversion _ _, this⟩

attribute [ext] AllocationSchedule

instance : LawfulCanonicalize AllocationSchedule where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocationSchedule.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocationSchedule.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocationSchedule.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocationSchedule.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AllocationSchedule.ext_iff.mpr this

attribute [ext] AllocationRecognition

instance : LawfulCanonicalize AllocationRecognition where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocationRecognition.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocationRecognition.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocationRecognition.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocationRecognition.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AllocationRecognition.ext_iff.mpr this

attribute [ext] AllocationScheduleRevision

instance : LawfulCanonicalize AllocationScheduleRevision where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocationScheduleRevision.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocationScheduleRevision.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocationScheduleRevision.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocationScheduleRevision.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AllocationScheduleRevision.ext_iff.mpr this

attribute [ext] TaxComponentResult

instance : LawfulCanonicalize TaxComponentResult where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [TaxComponentResult.canonicalMembers, member, optMember, literalMember])
    (by simp only [TaxComponentResult.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [TaxComponentResult.canonicalMembers, member, optMember, literalMember]) h
    simp only [TaxComponentResult.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact TaxComponentResult.ext_iff.mpr this

attribute [ext] TaxLineResult

instance : LawfulCanonicalize TaxLineResult where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [TaxLineResult.canonicalMembers, member, optMember, literalMember])
    (by simp only [TaxLineResult.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [TaxLineResult.canonicalMembers, member, optMember, literalMember]) h
    simp only [TaxLineResult.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact TaxLineResult.ext_iff.mpr this

attribute [ext] TaxDetermination

instance : LawfulCanonicalize TaxDetermination where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [TaxDetermination.canonicalMembers, member, optMember, literalMember])
    (by simp only [TaxDetermination.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [TaxDetermination.canonicalMembers, member, optMember, literalMember]) h
    simp only [TaxDetermination.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact TaxDetermination.ext_iff.mpr this

attribute [ext] ConsolidationCompilation

instance : LawfulCanonicalize ConsolidationCompilation where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [ConsolidationCompilation.canonicalMembers, member, optMember, literalMember])
    (by simp only [ConsolidationCompilation.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [ConsolidationCompilation.canonicalMembers, member, optMember, literalMember]) h
    simp only [ConsolidationCompilation.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact ConsolidationCompilation.ext_iff.mpr this

attribute [ext] AccountingCanonicalState

instance : LawfulCanonicalize AccountingCanonicalState where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingCanonicalState.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingCanonicalState.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingCanonicalState.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingCanonicalState.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingCanonicalState.ext_iff.mpr this

instance : LawfulCanonicalize AccountingEffect where
  wf effect := by
    refine object_wf_of (members := effect.canonicalMembers) (by simp [AccountingEffect.canonicalMembers, literalMember]) ?_
    simp only [AccountingEffect.canonicalMembers, List.forall_mem_cons, List.not_mem_nil,
      literalMember_wf, IsEmpty.forall_iff, implies_true, and_true, true_and]
    intro value hv
    cases hv
    cases effect <;> exact LawfulCanonicalize.wf _
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingEffect.canonicalMembers, literalMember]) h
    simp only [AccountingEffect.canonicalMembers, literalMember, List.forall₂_cons,
      List.forall₂_nil_left_iff, and_true] at this
    obtain ⟨htype, hvalue⟩ := this
    have htype : a.type = b.type := htype
    cases a <;> cases b <;> (try simp [AccountingEffect.type] at htype) <;>
      exact congrArg _ (LawfulCanonicalize.inj hvalue)

attribute [ext] AccountingDraft

instance : LawfulCanonicalize AccountingDraft where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AccountingDraft.canonicalMembers, member, optMember, literalMember])
    (by simp only [AccountingDraft.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AccountingDraft.canonicalMembers, member, optMember, literalMember]) h
    simp only [AccountingDraft.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AccountingDraft.ext_iff.mpr this

attribute [ext] OpenItemRecognitionRequest

instance : LawfulCanonicalize OpenItemRecognitionRequest where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [OpenItemRecognitionRequest.canonicalMembers, member, optMember, literalMember])
    (by simp only [OpenItemRecognitionRequest.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [OpenItemRecognitionRequest.canonicalMembers, member, optMember, literalMember]) h
    simp only [OpenItemRecognitionRequest.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact OpenItemRecognitionRequest.ext_iff.mpr this

attribute [ext] SettlementRequestCore

instance : LawfulCanonicalize SettlementRequestCore where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SettlementRequestCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [SettlementRequestCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SettlementRequestCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [SettlementRequestCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SettlementRequestCore.ext_iff.mpr this

attribute [ext] SettlementRequest

instance : LawfulCanonicalize SettlementRequest where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [SettlementRequest.canonicalMembers, SettlementRequestCore.canonicalMembers, member, optMember, literalMember])
    (by simp only [SettlementRequest.canonicalMembers, SettlementRequestCore.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [SettlementRequest.canonicalMembers, SettlementRequestCore.canonicalMembers, member, optMember, literalMember]) h
    simp only [SettlementRequest.canonicalMembers, SettlementRequestCore.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact SettlementRequest.ext_iff.mpr this

attribute [ext] AllocatedTotal

instance : LawfulCanonicalize AllocatedTotal where
  wf value := object_wf_of (members := value.canonicalMembers)
    (by simp [AllocatedTotal.canonicalMembers, member, optMember, literalMember])
    (by simp only [AllocatedTotal.canonicalMembers, List.cons_append, List.nil_append, List.forall_mem_cons,
          List.not_mem_nil, member_wf, optMember_wf, literalMember_wf, IsEmpty.forall_iff,
          implies_true, and_self])
  inj {a b} h := by
    have := object_equiv_forall₂ (members₁ := a.canonicalMembers) (members₂ := b.canonicalMembers)
      rfl (by simp [AllocatedTotal.canonicalMembers, member, optMember, literalMember]) h
    simp only [AllocatedTotal.canonicalMembers, List.cons_append, List.nil_append, List.forall₂_cons, member, optMember,
      literalMember, optEquiv_some_canonicalize_iff, optEquiv_map_canonicalize_iff,
      optEquiv_literal_iff, List.forall₂_nil_left_iff, true_and, and_true] at this
    exact AllocatedTotal.ext_iff.mpr this


/-! ## `accountingHash` determines what it hashes -/

/-- The record `accountingHash` hashes is well formed. -/
theorem accountingHash_value_wf {α : Type} [Canonicalize α] [LawfulCanonicalize α] (type : String)
    (body : α) :
    (CanonicalValue.record [("type", .string type), ("value", canonicalize body)]).WF :=
  ⟨by simp, trivial, LawfulCanonicalize.wf body, trivial⟩

/-- Two `accountingHash`es are equal only for the same type name and the same value, or a
collision of SHA-256 is in hand. -/
theorem accountingHash_inj_or_collision {α : Type} [Canonicalize α] [LawfulCanonicalize α]
    {type₁ type₂ : String} {a b : α} (h : accountingHash type₁ a = accountingHash type₂ b) :
    (type₁ = type₂ ∧ a = b) ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (accountingHash_value_wf type₁ a)
    (accountingHash_value_wf type₂ b) h with hequiv | hcollision
  · left
    have := object_equiv_forall₂
      (members₁ := [("type", some (.string type₁)), ("value", some (canonicalize a))])
      (members₂ := [("type", some (.string type₂)), ("value", some (canonicalize b))])
      rfl (by simp) hequiv
    simp only [List.forall₂_cons, List.forall₂_nil_left_iff, and_true,
      optEquiv_some_canonicalize_iff] at this
    exact ⟨this.1, this.2⟩
  · exact Or.inr hcollision

/-- Equal `accountingHash`es of the same type name: the same value, or a collision. -/
theorem accountingHash_eq_iff_or_collision {α : Type} [Canonicalize α] [LawfulCanonicalize α]
    (type : String) (a b : α) :
    accountingHash type a = accountingHash type b → a = b ∨ HashCollision := fun h =>
  (accountingHash_inj_or_collision h).imp (fun h => h.2) id

end Rastrata.Kernel

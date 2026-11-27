/-
The helpers of `packages/kernel/src/accounting.ts`: lines 75 to 85 (`hashAccountingPolicyArtifact`),
503 to 567 (`planAllocationPostings` and its types), 682 to 865 (`sum`, `positive`,
`immutableAccountingValue`, `ACCOUNTING_LIMITS`, the artifact and snapshot hashes,
`createAccountingPolicySnapshot`, `emptyAccountingCanonicalState`, `applyAccountingEffect`,
`reject`, `drafted`, `validAccountingDerivation`, `rejectExternalAccountingAuthority`,
`supportsInventoryValueAdjustmentAlgorithm`, `usesStructuralTaxGrouping`, `policyAt`) and 2165 to
2233 (`contentHashEqual`, the canonical values of effects and state, `validateAccountingEffectHash`,
`accountingEffectExists`, `validateAccountingEffectAdmission`,
`validateAccountingEffectIdentities`); with `CUMULATIVE_ALLOCATION_ALGORITHM_VERSION`,
`usesCumulativeAllocation` and `allocationPlanIsValid` (lines 1555 to 1574), which `policyAt` and
`validateAccountingEffectHash` call and which are therefore here rather than in
`Accounting/Schedules.lean`.

Every definition mirrors one TypeScript member, named in its doc comment, with the same checks in
the same order; a diagnostic carries its code, path, message and requirement identifiers in full.
Where the TypeScript throws, the model returns `.error`.

Where the model differs from the TypeScript in form:

- `Object.freeze` and `immutableAccountingValue` (a frozen copy) are not modelled:
  `immutableAccountingValue` is the identity.
- `policyAt<T>` returns `T | readonly SemanticDiagnostic[]`, and its callers tell the two apart with
  `Array.isArray`; here it returns an `AccountingPolicySelection T`, and the kind `T["kind"]` that the caller
  passes is the kind of the class `AccountingPolicyKind T`. `isAccountingDiagnostics` (line 2168),
  the same `Array.isArray` test, is the constructor of the result and is not a function here.
- `validateAccountingEffectIdentities` throws a `TypeError` when the identity callback answers
  neither `"present"` nor `"absent"`; the callback here answers an `IdentityObservation`, which has
  no third value, so that test always passes.
- `validAccountingDerivation` reads `Date.parse` through `dateParse` of `Policy/Types.lean`, which
  answers for the texts `instant` accepts (the engines' answer there is a finite number) and `none`
  for every other text: the engines read some of those (a bare date) and the model does not.
- `policyAt` compares instants as texts, as the TypeScript does (`policy.validFrom <= at`), by
  UTF-16 code unit (`jsStringLe`, `jsStringLt`).
-/
import Rastrata.Kernel.Accounting.Core.Canonical

namespace Rastrata.Kernel

/-! ## Helpers (`accounting.ts` lines 682 to 686 and 704) -/

/-- `sum` (line 683): the values added from the left, from zero; the first addition that throws ends
it. -/
def accountingSum (values : List ExactRational) : Except NumErr ExactRational :=
  addExactValues ExactRational.zero values

/-- `positive` (line 684). -/
def positive (value : ExactRational) : Bool := value.compare ExactRational.zero == .gt

/-- `immutableAccountingValue` (line 704): a frozen copy, which is the value itself here. -/
def immutableAccountingValue {α : Type} (value : α) : α := value

/-! ## `ACCOUNTING_LIMITS` (line 718) -/

/-- The type of `ACCOUNTING_LIMITS`. -/
structure AccountingLimits where
  maxTaxLines : Nat
  maxScheduleInstallments : Nat
  maxUsageEvents : Nat
  maxConsolidationSources : Nat
  maxConsolidationBalancesPerSource : Nat
  maxConsolidationEliminations : Nat
  maxSettlementAllocations : Nat
  maxInventoryLayers : Nat
  maxRecostingSources : Nat
  maxBasisEvents : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `ACCOUNTING_LIMITS` (line 718): hard resource bounds. -/
def accountingLimits : AccountingLimits where
  maxTaxLines := 100
  maxScheduleInstallments := 1200
  maxUsageEvents := 1200
  maxConsolidationSources := 1000
  maxConsolidationBalancesPerSource := 10000
  maxConsolidationEliminations := 10000
  maxSettlementAllocations := 10000
  maxInventoryLayers := 10000
  maxRecostingSources := 10000
  maxBasisEvents := 10000

/-! ## Artifacts of a policy (lines 79 and 730 to 760) -/

/-- `hashAccountingPolicyArtifact` (line 79): `accountingHash(type, artifact)`, where the artifact
is what the caller passes (the TypeScript asks for an object without its `contentHash`; any value
with a canonical value can be passed here, as any object can there). -/
def hashAccountingPolicyArtifact {α : Type} [Canonicalize α] (type : String) (artifact : α) :
    ContentHash :=
  accountingHash type artifact

/-- A value that carries a `contentHash`: the artifacts of a policy, the values of effects, a
posting plan and a posting reference. -/
class HasContentHash (α : Type) where
  /-- The `contentHash` a value carries. -/
  contentHash : α → ContentHash

instance : HasContentHash InventoryPool := ⟨(·.contentHash)⟩
instance : HasContentHash AccountingBasisRule := ⟨(·.contentHash)⟩
instance : HasContentHash MonetaryClassificationRule := ⟨(·.contentHash)⟩
instance : HasContentHash TaxPolicyComponent := ⟨(·.contentHash)⟩
instance : HasContentHash ConsolidationAccountMapping := ⟨(·.contentHash)⟩
instance : HasContentHash ConsolidationTranslationRule := ⟨(·.contentHash)⟩
instance : HasContentHash CanonicalPostingReference := ⟨(·.contentHash)⟩
instance : HasContentHash ProvisionalInventoryLayer := ⟨(·.contentHash)⟩
instance : HasContentHash InventoryRecosting := ⟨(·.contentHash)⟩
instance : HasContentHash InventoryValueAdjustment := ⟨(·.contentHash)⟩
instance : HasContentHash OpenItem := ⟨(·.contentHash)⟩
instance : HasContentHash Settlement := ⟨(·.contentHash)⟩
instance : HasContentHash SettlementAllocation := ⟨(·.contentHash)⟩
instance : HasContentHash RemeasurementResult := ⟨(·.contentHash)⟩
instance : HasContentHash RemeasurementReversal := ⟨(·.contentHash)⟩
instance : HasContentHash AllocationPostingPlan := ⟨(·.contentHash)⟩
instance : HasContentHash AllocationSchedule := ⟨(·.contentHash)⟩
instance : HasContentHash AllocationRecognition := ⟨(·.contentHash)⟩
instance : HasContentHash AllocationScheduleRevision := ⟨(·.contentHash)⟩
instance : HasContentHash TaxDetermination := ⟨(·.contentHash)⟩
instance : HasContentHash ConsolidationCompilation := ⟨(·.contentHash)⟩

/-- `artifactHashDigest` (line 738): `accountingHash(type, body)`. The body is the canonical value
of the object without its `contentHash`, which `canonicalize` leaves as it is. -/
def artifactHashDigest (type : String) (body : CanonicalValue) : ContentHash :=
  accountingHash type body

/-- `artifactHashValidDigest` (line 734): the recomputed hash and the carried hash agree in their
three fields. -/
def artifactHashValidDigest (type : String) (body : CanonicalValue) (contentHash : ContentHash) :
    Bool :=
  let recomputed := artifactHashDigest type body
  recomputed.algorithm == contentHash.algorithm &&
    recomputed.canonicalizationVersion == contentHash.canonicalizationVersion &&
    recomputed.digest == contentHash.digest

/-- `artifactHashValid` (line 730): `const { contentHash, ...body } = artifact`, then the hash of
the body against the carried hash. -/
def artifactHashValid {α : Type} [CanonicalObject α] [HasContentHash α] (type : String)
    (artifact : α) : Bool :=
  artifactHashValidDigest type (bodyValue artifact) (HasContentHash.contentHash artifact)

/-- The test `verifyAccountingPolicyArtifacts` makes of one policy (lines 743 to 760): every
artifact the policy's kind nests carries a reproducible hash. -/
def AccountingPolicy.artifactsVerified : AccountingPolicy → Bool
  | .inventoryCost policy => policy.pools.all (artifactHashValid "InventoryPool")
  | .accountingBasis policy => policy.rules.all (artifactHashValid "AccountingBasisRule")
  | .monetaryClassification policy =>
    policy.rules.all (artifactHashValid "MonetaryClassificationRule")
  | .taxDetermination policy => policy.components.all (artifactHashValid "TaxPolicyComponent")
  | .consolidation policy =>
    policy.accountMappings.all (artifactHashValid "ConsolidationAccountMapping") &&
      policy.translationRules.all (artifactHashValid "ConsolidationTranslationRule")
  | .currencyRemeasurement _ => true
  | .inventoryValueAdjustment _ => true
  | .allocationSchedule _ => true

/-- `verifyAccountingPolicyArtifacts` (line 741): the loop returns `false` at the first policy that
fails, and `true` after the last; nothing else happens in it, so it answers whether every policy
passes. -/
def verifyAccountingPolicyArtifacts (policies : List AccountingPolicy) : Bool :=
  policies.all AccountingPolicy.artifactsVerified

/-! ## Policy hashes and the snapshot (lines 762 to 782) -/

/-- `hashAccountingPolicy` (line 769): `accountingHash(policy.kind, policy)`. -/
def hashAccountingPolicy (policy : AccountingPolicy) : ContentHash :=
  accountingHash policy.kind.text policy

/-- The text `hashAccountingPolicySnapshot` sorts a policy by (line 763):
`${kind}:${id}:${version}`. -/
def accountingPolicySortKey (policy : AccountingPolicy) : String :=
  policy.kind.text ++ ":" ++ policy.id.value ++ ":" ++ policy.version.value

/-- `[...policies].sort((a, b) => compareCanonicalText(key(a), key(b)))` (lines 762 and 763): a
stable sort by the key, in UTF-16 code unit order. -/
def sortAccountingPolicies (policies : List AccountingPolicy) : List AccountingPolicy :=
  policies.mergeSort fun a b => jsStringLe (accountingPolicySortKey a) (accountingPolicySortKey b)

/-- The record `hashAccountingPolicySnapshot` hashes (lines 760 to 765). -/
def accountingPolicySnapshotValue (policies : List AccountingPolicy) : CanonicalValue :=
  .record [("type", .string "AccountingPolicySnapshot"),
    ("policyHashes", .array ((sortAccountingPolicies policies).map fun policy =>
      accountingHashValue (hashAccountingPolicy policy)))]

/-- `hashAccountingPolicySnapshot` (line 759). -/
def hashAccountingPolicySnapshot (policies : List AccountingPolicy) : ContentHash :=
  hashCanonical (accountingPolicySnapshotValue policies)

/-- The `TypeError` of `createAccountingPolicySnapshot` (line 780): `Accounting policy artifacts
must carry reproducible content hashes`. -/
inductive AccountingPolicySnapshotErr where
  | artifactsNotReproducible
  deriving DecidableEq, Repr, Inhabited

/-- `createAccountingPolicySnapshot` (line 778). -/
def createAccountingPolicySnapshot (policies : List AccountingPolicy) :
    Except AccountingPolicySnapshotErr AccountingPolicySnapshot :=
  let frozen := immutableAccountingValue policies
  if !verifyAccountingPolicyArtifacts frozen then .error .artifactsNotReproducible
  else .ok { policies := frozen, contentHash := hashAccountingPolicySnapshot frozen }

/-! ## State and effects (lines 784 to 812) -/

/-- `emptyAccountingCanonicalState` (line 784). -/
def emptyAccountingCanonicalState : AccountingCanonicalState where
  provisionalInventoryLayers := []
  inventoryRecostings := []
  inventoryValueAdjustments := []
  openItems := []
  settlements := []
  settlementAllocations := []
  remeasurementResults := []
  remeasurementReversals := []
  allocationSchedules := []
  allocationRecognitions := []
  allocationScheduleRevisions := []
  taxDeterminations := []
  consolidationCompilations := []

/-- `applyAccountingEffect` (line 795): the effect's value is appended to the collection its type
names. -/
def applyAccountingEffect (state : AccountingCanonicalState) :
    AccountingEffect → AccountingCanonicalState
  | .provisionalInventoryLayer value =>
    { state with provisionalInventoryLayers := state.provisionalInventoryLayers ++ [value] }
  | .inventoryRecosting value =>
    { state with inventoryRecostings := state.inventoryRecostings ++ [value] }
  | .inventoryValueAdjustment value =>
    { state with inventoryValueAdjustments := state.inventoryValueAdjustments ++ [value] }
  | .openItem value => { state with openItems := state.openItems ++ [value] }
  | .settlement value => { state with settlements := state.settlements ++ [value] }
  | .settlementAllocation value =>
    { state with settlementAllocations := state.settlementAllocations ++ [value] }
  | .remeasurementResult value =>
    { state with remeasurementResults := state.remeasurementResults ++ [value] }
  | .remeasurementReversal value =>
    { state with remeasurementReversals := state.remeasurementReversals ++ [value] }
  | .allocationSchedule value =>
    { state with allocationSchedules := state.allocationSchedules ++ [value] }
  | .allocationRecognition value =>
    { state with allocationRecognitions := state.allocationRecognitions ++ [value] }
  | .allocationScheduleRevision value =>
    { state with allocationScheduleRevisions := state.allocationScheduleRevisions ++ [value] }
  | .taxDetermination value =>
    { state with taxDeterminations := state.taxDeterminations ++ [value] }
  | .consolidationCompilation value =>
    { state with consolidationCompilations := state.consolidationCompilations ++ [value] }

/-- `reject` (line 813): a rejection with one diagnostic. -/
def reject (code : SemanticDiagnosticCode) (path message : String) (requirements : List String) :
    AccountingCalculation :=
  .rejected [diagnostic code path message requirements]

/-- `drafted` (line 817): a draft of these journals and effects (`immutableAccountingValue` is the
identity here). -/
def drafted (journals : List ExactPreparedJournal) (effects : List AccountingEffect) :
    AccountingCalculation :=
  immutableAccountingValue (.draft { journals, effects })

/-! ## Derivations, external authority and algorithm versions (lines 821 to 838) -/

/-- `validAccountingDerivation` (line 821): approved, with evidence, and `recordedAt` read by
`Date.parse` as a finite number. -/
def validAccountingDerivation (derivation : DerivationRecord) : Bool :=
  derivation.state == .approved && decide (derivation.evidence.length > 0) &&
    (dateParse derivation.recordedAt.value).isSome

/-- `ExternalAccountingAuthorityAttempt` (line 825). -/
inductive ExternalAccountingAuthorityAttempt where
  | journalFactory
  | policySelection
  | bookOrderAssignment
  | commitIntentFactory
  | directPersistence
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `ExternalAccountingAuthorityAttempt`. -/
def ExternalAccountingAuthorityAttempt.text : ExternalAccountingAuthorityAttempt → String
  | .journalFactory => "journalFactory"
  | .policySelection => "policySelection"
  | .bookOrderAssignment => "bookOrderAssignment"
  | .commitIntentFactory => "commitIntentFactory"
  | .directPersistence => "directPersistence"

/-- The record `requirements` of `rejectExternalAccountingAuthority` (lines 828 to 834). -/
def ExternalAccountingAuthorityAttempt.requirements :
    ExternalAccountingAuthorityAttempt → List String
  | .journalFactory => ["ACC-047.1", "ACC-047.5"]
  | .policySelection => ["ACC-047.5"]
  | .bookOrderAssignment => ["ACC-047.3", "ACC-047.5"]
  | .commitIntentFactory => ["ACC-047.2"]
  | .directPersistence => ["ACC-047.4"]

/-- `rejectExternalAccountingAuthority` (line 827). -/
def rejectExternalAccountingAuthority (attempt : ExternalAccountingAuthorityAttempt) :
    List SemanticDiagnostic :=
  [diagnostic .external_accounting_authority ("external." ++ attempt.text)
    "External workflows may submit evidence and typed commands, but may not exercise canonical accounting authority"
    attempt.requirements]

/-- `INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION` (line 838). -/
def inventoryValueAdjustmentAlgorithmVersion : SemanticVersion := ⟨"1.0.2"⟩

/-- `supportsInventoryValueAdjustmentAlgorithm` (line 840). -/
def supportsInventoryValueAdjustmentAlgorithm (version : SemanticVersion) : Bool :=
  version.value == "1.0.0" || version.value == "1.0.1" ||
    version == inventoryValueAdjustmentAlgorithmVersion

/-- `usesStructuralTaxGrouping` (line 846). -/
def usesStructuralTaxGrouping (policy : TaxPolicy) : Bool :=
  policy.groupingAlgorithm == some .structuralTaxGroupsV1 && policy.algorithmVersion.value == "1.1.0"

/-- `CUMULATIVE_ALLOCATION_ALGORITHM_VERSION` (line 1555). -/
def cumulativeAllocationAlgorithmVersion : SemanticVersion := ⟨"1.1.0"⟩

/-- `usesCumulativeAllocation` (line 1556). -/
def usesCumulativeAllocation (policy : AllocationPolicy) : Bool :=
  policy.postingAlgorithm == some .cumulativePostedAllocationV1 &&
    policy.algorithmVersion == cumulativeAllocationAlgorithmVersion

/-! ## `policyAt` (line 850) -/

/-- A policy type `policyAt` can select: its `kind`, and the policy of that kind in an
`AccountingPolicy`. -/
class AccountingPolicyKind (T : Type) where
  /-- `T["kind"]`. -/
  kind : AccountingFeature
  /-- The policy of type `T`, when the policy is of this kind. -/
  ofPolicy? : AccountingPolicy → Option T

instance : AccountingPolicyKind InventoryCostPolicy :=
  ⟨.inventoryCost, fun | .inventoryCost policy => some policy | _ => none⟩
instance : AccountingPolicyKind InventoryValueAdjustmentPolicy :=
  ⟨.inventoryValueAdjustment, fun | .inventoryValueAdjustment policy => some policy | _ => none⟩
instance : AccountingPolicyKind AccountingBasisPolicy :=
  ⟨.accountingBasis, fun | .accountingBasis policy => some policy | _ => none⟩
instance : AccountingPolicyKind MonetaryClassificationPolicy :=
  ⟨.monetaryClassification, fun | .monetaryClassification policy => some policy | _ => none⟩
instance : AccountingPolicyKind CurrencyPolicy :=
  ⟨.currencyRemeasurement, fun | .currencyRemeasurement policy => some policy | _ => none⟩
instance : AccountingPolicyKind AllocationPolicy :=
  ⟨.allocationSchedule, fun | .allocationSchedule policy => some policy | _ => none⟩
instance : AccountingPolicyKind TaxPolicy :=
  ⟨.taxDetermination, fun | .taxDetermination policy => some policy | _ => none⟩
instance : AccountingPolicyKind ConsolidationPolicy :=
  ⟨.consolidation, fun | .consolidation policy => some policy | _ => none⟩

/-- The filter of `policyAt` (line 851): the policy's kind, identifier and version, and the instant
within its validity, compared as texts. -/
def policyMatches (kind : AccountingFeature) (id : PolicyId) (version : SemanticVersion)
    (at_ : Instant) (policy : AccountingPolicy) : Bool :=
  policy.kind == kind && policy.id == id && policy.version == version &&
    jsStringLe policy.validFrom.value at_.value &&
    (match policy.validTo with
      | none => true
      | some validTo => jsStringLt at_.value validTo.value)

/-- The test of the one matching policy (line 853), every clause of it in the TypeScript's order:
the capability is for this kind, supported, of the policy's algorithm version, with evidence, and
admits the policy's combination; an inventory value adjustment policy names an algorithm version
the kernel supports; an allocation policy that names a posting algorithm uses the cumulative one. -/
def policyExecutable (kind : AccountingFeature) (selected : AccountingPolicy) : Bool :=
  selected.capability.feature == kind && selected.capability.status == .supported &&
    selected.capability.implementationVersion == selected.algorithmVersion &&
    selected.capability.verificationEvidenceIds.length != 0 &&
    accountingCapabilityAdmits selected.capability (accountingPolicyCombination selected) &&
    !(selected.kind == .inventoryValueAdjustment &&
      !supportsInventoryValueAdjustmentAlgorithm selected.algorithmVersion) &&
    !(match selected with
      | .allocationSchedule policy => policy.postingAlgorithm.isSome && !usesCumulativeAllocation policy
      | _ => false)

/-- The diagnostic of `policyAt` (line 854). -/
def policyAtDiagnostic (kind : AccountingFeature) : SemanticDiagnostic :=
  diagnostic (if kind = .inventoryCost then .inventory_cost_policy_incoherent
    else .unresolved_accounting_input) "command.policy"
    "Exactly one applicable policy with matching executable capability evidence is required"
    ["ACC-039.1", "ACC-047.5"]

/-- The result of `policyAt`: the selected policy, or the diagnostics. -/
inductive AccountingPolicySelection (T : Type) where
  | selected (policy : T)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- `policyAt<T>(policies, kind, id, version, at)` (line 850). The policy that passes is of the kind
the filter asked for, so `ofPolicy?` finds it (`policyAt_selected`); the `none` branch, the
TypeScript's unchecked cast, is never taken. -/
def policyAt (T : Type) [AccountingPolicyKind T] (policies : List AccountingPolicy) (id : PolicyId)
    (version : SemanticVersion) (at_ : Instant) : AccountingPolicySelection T :=
  let kind := AccountingPolicyKind.kind T
  match policies.filter (policyMatches kind id version at_) with
  | [selected] =>
    if policyExecutable kind selected then
      match AccountingPolicyKind.ofPolicy? selected with
      | some policy => .selected policy
      | none => .rejected [policyAtDiagnostic kind]
    else .rejected [policyAtDiagnostic kind]
  | _ => .rejected [policyAtDiagnostic kind]

/-! ## `planAllocationPostings` (lines 527 to 567) -/

/-- The argument of `planAllocationPostings`, unnamed in the TypeScript. -/
structure AllocationPostingPlanInput where
  exactSourceBasis : ExactRational
  exactResidualValue : ExactRational
  postedSourceBasis : ExactDecimal
  quantizationPolicy : QuantizationPolicy
  installments : List ScheduledAllocation
  deriving DecidableEq, Repr, Inhabited

/-- The result of `planAllocationPostings`: `planned` with a plan, or `rejected`. -/
inductive AllocationPostingPlanResult where
  | planned (plan : AllocationPostingPlan)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- The one diagnostic of `planAllocationPostings` (lines 548 to 552). -/
def allocationPlanDiagnostic : SemanticDiagnostic :=
  diagnostic .allocation_schedule_violation "schedule.postingPlan"
    "A bounded ordered exact schedule, nonnegative conserving bases, and representable posted carrying basis are required; a zero exact schedule with a posted remainder requires explicit settlement"
    ["ACC-044.3", "ACC-044.4", "ACC-044.6"]

/-- `input.installments.some((item, index) => ...)` (line 545), from the installment at `index`,
the one before it at `previous`: an ordinal that is not `index + 1`, a negative amount, or an
accounting date not after the previous one (compared as texts). -/
def scheduleMisordered : Nat → Option LocalDate → List ScheduledAllocation → Bool
  | _, _, [] => false
  | index, previous, item :: rest =>
    (item.ordinal != ((index + 1 : Nat) : Int)) || item.amount.isNegative ||
      (match previous with
        | some date => jsStringLe item.accountingDate.value date.value
        | none => false) ||
      scheduleMisordered (index + 1) (some item.accountingDate) rest

/-- The condition of lines 543 to 547, evaluated as `||` does, from the left, stopping at the first
that holds; `quantize` and `sum` may throw only if they are reached. `true` rejects. -/
def planRejects (input : AllocationPostingPlanInput) (policy : QuantizationPolicy)
    (postedBasis exactAllocable postedAllocable : ExactRational) : Except QuantizeErr Bool :=
  if input.installments.length == 0 ||
      decide (input.installments.length > accountingLimits.maxScheduleInstallments) ||
      input.exactSourceBasis.isNegative || input.exactResidualValue.isNegative ||
      exactAllocable.isNegative || postedBasis.isNegative || postedAllocable.isNegative then
    .ok true
  else
    match quantize postedBasis policy.rule with
    | .error e => .error e
    | .ok normalized =>
      if !normalized.residual.isZero then .ok true
      else if scheduleMisordered 0 none input.installments then .ok true
      else
        match liftExact (accountingSum (input.installments.map (·.amount))) with
        | .error e => .error e
        | .ok total =>
          if !total.equals exactAllocable then .ok true
          else .ok (exactAllocable.isZero && !postedAllocable.isZero)

/-- `postedAllocable.multiply(cumulativeExact).divide(exactAllocable)`, or zero when the exact
allocable basis is zero (line 557). -/
def cumulativeTargetOf (exactAllocable postedAllocable cumulativeExact : ExactRational) :
    Except NumErr ExactRational :=
  if exactAllocable.isZero then .ok ExactRational.zero
  else
    match postedAllocable.multiply cumulativeExact with
    | .error e => .error e
    | .ok product => product.divide exactAllocable

/-- `input.installments.map(...)` (lines 555 to 563), with `cumulativeExact` and
`previousPostedCoefficient` carried from one installment to the next. -/
def planInstallments (policy : QuantizationPolicy) (exactAllocable postedAllocable : ExactRational) :
    ExactRational → Int → List ScheduledAllocation →
      Except QuantizeErr (List AllocationPostingInstallment)
  | _, _, [] => .ok []
  | cumulativeExact, previousPostedCoefficient, item :: rest =>
    match liftExact (cumulativeExact.add item.amount) with
    | .error e => .error e
    | .ok cumulative =>
      match liftExact (cumulativeTargetOf exactAllocable postedAllocable cumulative) with
      | .error e => .error e
      | .ok cumulativeTarget =>
        match quantize cumulativeTarget policy.rule with
        | .error e => .error e
        | .ok cumulativeQuantization =>
          match liftExact (ExactDecimal.of
              (cumulativeQuantization.amount.coefficient - previousPostedCoefficient)
              policy.targetScale) with
          | .error e => .error e
          | .ok postedAmount =>
            match liftExact postedAmount.toRational with
            | .error e => .error e
            | .ok postedRational =>
              match liftExact (item.amount.subtract postedRational) with
              | .error e => .error e
              | .ok difference =>
                match planInstallments policy exactAllocable postedAllocable cumulative
                    cumulativeQuantization.amount.coefficient rest with
                | .error e => .error e
                | .ok installments =>
                  let installment : AllocationPostingInstallment :=
                    { ordinal := item.ordinal, accountingDate := item.accountingDate,
                      exactAmount := item.amount, cumulativeTarget := cumulativeTarget,
                      cumulativeQuantization := cumulativeQuantization,
                      postedAmount := postedAmount, exactToPostedDifference := difference }
                  .ok (installment :: installments)

/-- `planAllocationPostings` (line 527). The plan's `contentHash` is
`accountingHash("AllocationPostingPlan", body)` of the plan without it. -/
def planAllocationPostings (input : AllocationPostingPlanInput) :
    Except QuantizeErr AllocationPostingPlanResult :=
  let policy := immutableAccountingValue input.quantizationPolicy
  match quantize input.exactResidualValue policy.rule with
  | .error e => .error e
  | .ok residualQuantization =>
    match liftExact input.postedSourceBasis.toRational with
    | .error e => .error e
    | .ok postedBasis =>
      match liftExact (input.exactSourceBasis.subtract input.exactResidualValue) with
      | .error e => .error e
      | .ok exactAllocable =>
        match liftExact residualQuantization.amount.toRational with
        | .error e => .error e
        | .ok residualAmount =>
          match liftExact (postedBasis.subtract residualAmount) with
          | .error e => .error e
          | .ok postedAllocable =>
            match planRejects input policy postedBasis exactAllocable postedAllocable with
            | .error e => .error e
            | .ok true => .ok (.rejected [allocationPlanDiagnostic])
            | .ok false =>
              match planInstallments policy exactAllocable postedAllocable ExactRational.zero 0
                  input.installments with
              | .error e => .error e
              | .ok installments =>
                let body : AllocationPostingPlan :=
                  { algorithmVersion := .cumulativePostedAllocationV1,
                    exactSourceBasis := input.exactSourceBasis,
                    exactResidualValue := input.exactResidualValue,
                    postedSourceBasis := input.postedSourceBasis, residualQuantization,
                    quantizationPolicy := policy, installments, contentHash := default }
                .ok (.planned { body with
                  contentHash := accountingBodyHash "AllocationPostingPlan" body })

/-- `allocationPlanIsValid` (line 1562): a legacy schedule carries no plan; a schedule with a
posting algorithm uses the cumulative one, two distinct accounts, a posted basis that is exactly
representable, and carries the plan `planAllocationPostings` recomputes, compared by the
`accountingHash` of the whole plan. -/
def allocationPlanIsValid (schedule : AllocationSchedule) : Except QuantizeErr Bool :=
  if schedule.policy.postingAlgorithm = none then .ok schedule.postingPlan.isNone
  else if !usesCumulativeAllocation schedule.policy ||
      schedule.policy.allocationAccountId == schedule.policy.contraAccountId then .ok false
  else
    match quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule with
    | .error e => .error e
    | .ok source =>
      if !source.residual.isZero then .ok false
      else
        match schedule.postingPlan with
        | none => .ok false
        | some postingPlan =>
          match planAllocationPostings
              { exactSourceBasis := schedule.sourceBasis,
                exactResidualValue := schedule.residualValue, postedSourceBasis := source.amount,
                quantizationPolicy := schedule.policy.quantizationPolicy,
                installments := schedule.installments } with
          | .error e => .error e
          | .ok (.rejected _) => .ok false
          | .ok (.planned plan) =>
            .ok (contentHashEquals (accountingHash "AllocationPostingPlanValue" postingPlan)
              (accountingHash "AllocationPostingPlanValue" plan))

/-! ## Effects: identity, hashes and admission (lines 2165 to 2233) -/

/-- `contentHashEqual` (line 2165): the same three comparisons as `contentHashEquals`. -/
def contentHashEqual (left right : ContentHash) : Bool := contentHashEquals left right

/-- `effect.value.id`, as a string. -/
def AccountingEffect.id : AccountingEffect → String
  | .provisionalInventoryLayer value => value.id.value
  | .inventoryRecosting value => value.id.value
  | .inventoryValueAdjustment value => value.id.value
  | .openItem value => value.id.value
  | .settlement value => value.id.value
  | .settlementAllocation value => value.id.value
  | .remeasurementResult value => value.id.value
  | .remeasurementReversal value => value.id.value
  | .allocationSchedule value => value.id.value
  | .allocationRecognition value => value.id.value
  | .allocationScheduleRevision value => value.id.value
  | .taxDetermination value => value.id.value
  | .consolidationCompilation value => value.id.value

/-- `effect.value.contentHash`. -/
def AccountingEffect.contentHash : AccountingEffect → ContentHash
  | .provisionalInventoryLayer value => value.contentHash
  | .inventoryRecosting value => value.contentHash
  | .inventoryValueAdjustment value => value.contentHash
  | .openItem value => value.contentHash
  | .settlement value => value.contentHash
  | .settlementAllocation value => value.contentHash
  | .remeasurementResult value => value.contentHash
  | .remeasurementReversal value => value.contentHash
  | .allocationSchedule value => value.contentHash
  | .allocationRecognition value => value.contentHash
  | .allocationScheduleRevision value => value.contentHash
  | .taxDetermination value => value.contentHash
  | .consolidationCompilation value => value.contentHash

/-- The canonical value of `body` in `const { contentHash, ...body } = effect.value` (line 2205). -/
def AccountingEffect.bodyValue : AccountingEffect → CanonicalValue
  | .provisionalInventoryLayer value => Rastrata.Kernel.bodyValue value
  | .inventoryRecosting value => Rastrata.Kernel.bodyValue value
  | .inventoryValueAdjustment value => Rastrata.Kernel.bodyValue value
  | .openItem value => Rastrata.Kernel.bodyValue value
  | .settlement value => Rastrata.Kernel.bodyValue value
  | .settlementAllocation value => Rastrata.Kernel.bodyValue value
  | .remeasurementResult value => Rastrata.Kernel.bodyValue value
  | .remeasurementReversal value => Rastrata.Kernel.bodyValue value
  | .allocationSchedule value => Rastrata.Kernel.bodyValue value
  | .allocationRecognition value => Rastrata.Kernel.bodyValue value
  | .allocationScheduleRevision value => Rastrata.Kernel.bodyValue value
  | .taxDetermination value => Rastrata.Kernel.bodyValue value
  | .consolidationCompilation value => Rastrata.Kernel.bodyValue value

/-- `effect.type[0]!.toUpperCase() + effect.type.slice(1)` (line 2206): the type with its first
letter in capitals (`AccountingEffect.typeName_eq_capitalize`). -/
def AccountingEffect.typeName : AccountingEffect → String
  | .provisionalInventoryLayer _ => "ProvisionalInventoryLayer"
  | .inventoryRecosting _ => "InventoryRecosting"
  | .inventoryValueAdjustment _ => "InventoryValueAdjustment"
  | .openItem _ => "OpenItem"
  | .settlement _ => "Settlement"
  | .settlementAllocation _ => "SettlementAllocation"
  | .remeasurementResult _ => "RemeasurementResult"
  | .remeasurementReversal _ => "RemeasurementReversal"
  | .allocationSchedule _ => "AllocationSchedule"
  | .allocationRecognition _ => "AllocationRecognition"
  | .allocationScheduleRevision _ => "AllocationScheduleRevision"
  | .taxDetermination _ => "TaxDetermination"
  | .consolidationCompilation _ => "ConsolidationCompilation"

/-- The book an effect is scoped to (line 2228): its own `bookId` for the seven types that carry
one, none for the six that do not (the caller's book stands in for those). -/
def AccountingEffect.scopedBookId : AccountingEffect → Option BookId
  | .provisionalInventoryLayer value => some value.bookId
  | .inventoryValueAdjustment value => some value.bookId
  | .openItem value => some value.bookId
  | .settlement value => some value.bookId
  | .allocationSchedule value => some value.bookId
  | .taxDetermination value => some value.bookId
  | .consolidationCompilation value => some value.bookId
  | .inventoryRecosting _ => none
  | .settlementAllocation _ => none
  | .remeasurementResult _ => none
  | .remeasurementReversal _ => none
  | .allocationRecognition _ => none
  | .allocationScheduleRevision _ => none

/-- `canonicalAccountingEffectValue` (line 2172): `{ type, value: canonicalize(effect.value) }`. -/
def canonicalAccountingEffectValue (effect : AccountingEffect) : CanonicalValue :=
  .record [("type", .string effect.type), ("value", effect.canonicalValue)]

/-- `canonicalAccountingStateValue` (line 2176). -/
def canonicalAccountingStateValue (state : AccountingCanonicalState) : CanonicalValue :=
  canonicalize state

/-- The test of line 2203 for a schedule revision: a revision under the cumulative algorithm
carries both posted amounts, and any other carries neither. `true` fails the hash check. -/
def revisionPostedAmountsInconsistent (revision : AllocationScheduleRevision) : Bool :=
  if usesCumulativeAllocation revision.policy then
    revision.postedRecognizedToDate.isNone || revision.postedCarryingAmountAtRevision.isNone
  else
    revision.postedRecognizedToDate.isSome || revision.postedCarryingAmountAtRevision.isSome

/-- `validateAccountingEffectHash` (line 2200). -/
def validateAccountingEffectHash (effect : AccountingEffect) : Except QuantizeErr Bool :=
  let planValid : Except QuantizeErr Bool :=
    match effect with
    | .allocationSchedule schedule => allocationPlanIsValid schedule
    | _ => .ok true
  match planValid with
  | .error e => .error e
  | .ok false => .ok false
  | .ok true =>
    let revisionInvalid : Bool :=
      match effect with
      | .allocationScheduleRevision revision => revisionPostedAmountsInconsistent revision
      | _ => false
    if revisionInvalid then .ok false
    else
      let recomputed := accountingHash effect.typeName effect.bodyValue
      .ok (recomputed.algorithm == effect.contentHash.algorithm &&
        recomputed.canonicalizationVersion == effect.contentHash.canonicalizationVersion &&
        recomputed.digest == effect.contentHash.digest)

/-- The identifiers of the collection of `state` that `accountingEffectExists` searches for an
effect of this type (lines 2214 to 2228). -/
def AccountingCanonicalState.familyIds (state : AccountingCanonicalState) :
    AccountingEffect → List String
  | .provisionalInventoryLayer _ => state.provisionalInventoryLayers.map (·.id.value)
  | .inventoryRecosting _ => state.inventoryRecostings.map (·.id.value)
  | .inventoryValueAdjustment _ => state.inventoryValueAdjustments.map (·.id.value)
  | .openItem _ => state.openItems.map (·.id.value)
  | .settlement _ => state.settlements.map (·.id.value)
  | .settlementAllocation _ => state.settlementAllocations.map (·.id.value)
  | .remeasurementResult _ => state.remeasurementResults.map (·.id.value)
  | .remeasurementReversal _ => state.remeasurementReversals.map (·.id.value)
  | .allocationSchedule _ => state.allocationSchedules.map (·.id.value)
  | .allocationRecognition _ => state.allocationRecognitions.map (·.id.value)
  | .allocationScheduleRevision _ => state.allocationScheduleRevisions.map (·.id.value)
  | .taxDetermination _ => state.taxDeterminations.map (·.id.value)
  | .consolidationCompilation _ => state.consolidationCompilations.map (·.id.value)

/-- `accountingEffectExists` (line 2212): a member of the collection the effect's type names has
the effect's identifier. -/
def accountingEffectExists (state : AccountingCanonicalState) (effect : AccountingEffect) : Bool :=
  (state.familyIds effect).any (· == effect.id)

/-- The key of the set `identities` (line 2240): `${effect.type}:${effect.value.id}`. -/
def AccountingEffect.identityKey (effect : AccountingEffect) : String :=
  effect.type ++ ":" ++ effect.id

/-- The diagnostic of `validateAccountingEffectIdentities` for the effect at `index`
(line 2244). -/
def effectIdentityDiagnostic (index : Nat) : SemanticDiagnostic :=
  diagnostic .canonical_identity_conflict ("accountingDraft.effects[" ++ toString index ++ "]")
    "Accounting effect identity, book scope, or complete content hash is invalid"
    ["ACC-038", "ACC-047.2", "ACC-047.5"]

/-- Whether the effect is flagged (line 2244): its identity is present (an earlier effect of the
batch has its key, or the callback answers `"present"`), or it is scoped to another book, or its
hash does not check; the hash is checked only if neither of the first two holds. -/
def effectIdentityFlagged (bookId : BookId) (identity : AccountingEffect → IdentityObservation)
    (seen : List String) (effect : AccountingEffect) : Except QuantizeErr Bool :=
  let observed : IdentityObservation :=
    if seen.contains effect.identityKey then .present else identity effect
  if observed == .present || (effect.scopedBookId.getD bookId) != bookId then .ok true
  else
    match validateAccountingEffectHash effect with
    | .error e => .error e
    | .ok valid => .ok !valid

/-- The loop of `validateAccountingEffectIdentities` (lines 2237 to 2246) from the effect at
`index`, with the keys `seen` so far. -/
def validateAccountingEffectIdentitiesFrom (bookId : BookId)
    (identity : AccountingEffect → IdentityObservation) :
    Nat → List String → List AccountingEffect → Except QuantizeErr (List SemanticDiagnostic)
  | _, _, [] => .ok []
  | index, seen, effect :: rest =>
    match effectIdentityFlagged bookId identity seen effect with
    | .error e => .error e
    | .ok flagged =>
      match validateAccountingEffectIdentitiesFrom bookId identity (index + 1)
          (seen ++ [effect.identityKey]) rest with
      | .error e => .error e
      | .ok diagnostics =>
        .ok (if flagged then effectIdentityDiagnostic index :: diagnostics else diagnostics)

/-- `validateAccountingEffectIdentities` (line 2233). -/
def validateAccountingEffectIdentities (effects : List AccountingEffect) (bookId : BookId)
    (identity : AccountingEffect → IdentityObservation) :
    Except QuantizeErr (List SemanticDiagnostic) :=
  validateAccountingEffectIdentitiesFrom bookId identity 0 [] effects

/-- `validateAccountingEffectAdmission` (line 2229). -/
def validateAccountingEffectAdmission (state : AccountingCanonicalState)
    (effects : List AccountingEffect) (bookId : BookId) :
    Except QuantizeErr (List SemanticDiagnostic) :=
  validateAccountingEffectIdentities effects bookId fun effect =>
    if accountingEffectExists state effect then .present else .absent

end Rastrata.Kernel

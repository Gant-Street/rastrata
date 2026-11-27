/-
The vocabulary of the owned-inventory command: the Lean model of the types of
`packages/kernel/src/owned-inventory-command.ts` lines 15 to 113. Lines 1 to 14 are imports; the
functions from line 115 on (`failure`, `scopeKey`, `prepareOwnedInventoryAccounting`) are not here.

The types are written as in `Accounting/Types.lean` and `InventoryOwnership/Types.lean`: same field
names in the same order, an optional field an `Option`, a `readonly T[]` a `List T`, a `bigint` an
`Int`, a union of string literals an inductive with `text`, a discriminated union an inductive with
one constructor a case. `Identifier<"InventoryOperation">`, written inline in the TypeScript, is
named `InventoryOperationId`; `Identifier<"FiscalPeriod">` is `FiscalPeriodId` of
`Book/BaseTypes.lean`; `ResolvedTransaction` of `policy.ts` is `ResolvedTransaction
QuantizationPolicy` of `Policy.lean`, which derives no instances, so `DecidableEq`, `Repr` and
`Inhabited` are derived for it here.

Meaning: `WF` as in those files, each exact number constructible and each identifier valid, through
every field, option and list; the booking policies use `BookingPolicy.WF` of `Policy.lean` as it
stands (which also asks that their instants and versions be well formed), as
`BookConfigurationSnapshotBody.WF` does. `PolicyApplication.WF` and `ResolvedTransaction.WF` are
defined here because no earlier file defines them.

What the TypeScript type says and the Lean type cannot:

- `OwnedInventoryAccountingContext` is an object with four methods besides its fields, each a
  trusted callback that "throws, never becomes false/absence" on unknown evidence. Here they are
  pure functions whose answer is `Except InventoryOwnershipReadError`, as the reads of
  `InventoryOwnershipReadContext`: two calls with the same arguments answer the same. A structure of
  functions has no `DecidableEq` and no `Repr`.
- `identityPresence` answers `"present" | "absent"` and `managedMoneyScope` `"managed" |
  "unmanaged"`; the TypeScript tests at run time that the answer is one of the two and throws
  otherwise (lines 186 and 479). Here the answer has one of the two values, so the test always
  passes.
- An optional property may be absent or present with the value `undefined`; `Option` has one
  `none`, here the absent property.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Policy
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Book.BaseTypes
import Rastrata.Kernel.InventoryOwnership.Types

namespace Rastrata.Kernel

/-! ## Instances for an imported type -/

deriving instance DecidableEq, Repr, Inhabited for ResolvedTransaction

/-! ## References, coordinates and posting links (`owned-inventory-command.ts` lines 15 to 30) -/

/-- `Identifier<"InventoryOperation">`, written inline in the TypeScript. -/
abbrev InventoryOperationId := Identifier "InventoryOperation"

/-- `OwnedInventoryPolicyReference`: `policyId`, `policyVersion` and `policyContentHash`, the same
fields as `InventoryPostedAnchor["inventoryPolicy"]`, and the TypeScript passes one where the other
is asked (`owned-inventory-command.ts` lines 256, 264, 285, 293, 406 and 420), so they are one type
here: `InventoryPostedAnchorPolicy`, with its `WF`. -/
abbrev OwnedInventoryPolicyReference := InventoryPostedAnchorPolicy

/-- `OwnedInventoryCoordinateInput`. -/
structure OwnedInventoryCoordinateInput where
  accountId : AccountId
  unitsCommodityId : CommodityId
  dimensionMemberIds : List DimensionMemberId
  bookingPolicy : OwnedInventoryPolicyReference
  deriving DecidableEq, Repr, Inhabited

/-- `OwnedInventoryPostingLink`. -/
structure OwnedInventoryPostingLink where
  journalOrdinal : Int
  postingId : PostingId
  referenceId : CanonicalPostingReferenceId
  deriving DecidableEq, Repr, Inhabited

/-! ## Operation inputs (`owned-inventory-command.ts` lines 31 to 72)

`OwnedInventoryOperationInput` is `OwnedInventoryOperationCore & (acquisition | issue | transfer |
adopt)`: a union discriminated by `kind` whose four cases have no names in the TypeScript. Each case
is named here as a structure that extends the core. -/

/-- `OwnedInventoryOperationCore` (not exported): what every operation input carries. -/
structure OwnedInventoryOperationCore where
  ordinal : Int
  id : InventoryOperationId
  coordinate : OwnedInventoryCoordinateInput
  inventoryPolicy : OwnedInventoryPolicyReference
  derivation : DerivationRecord
  postingLink : Option OwnedInventoryPostingLink
  deriving DecidableEq, Repr, Inhabited

/-- `OwnedInventoryTransferEntryInput`. -/
structure OwnedInventoryTransferEntryInput where
  holdingId : LotHoldingId
  allocationId : LotAllocationId
  transferOutMovementId : InventoryPostedMovementId
  destinationAnchorId : InventoryPostedAnchorId
  destinationMovementId : InventoryPostedMovementId
  destinationHoldingId : LotHoldingId
  destinationLotId : LotId
  evidence : List SourceEvidence
  deriving DecidableEq, Repr, Inhabited

/-- `OwnedInventoryAdoptionEntryInput`. -/
structure OwnedInventoryAdoptionEntryInput where
  anchorId : InventoryPostedAnchorId
  movementId : InventoryPostedMovementId
  holdingId : LotHoldingId
  evidence : List SourceEvidence
  historicalPostings : List CanonicalPostingReference
  deriving DecidableEq, Repr, Inhabited

/-- The `"acquisition"` case of `OwnedInventoryOperationInput` (line 57). -/
structure OwnedInventoryAcquisitionInput extends OwnedInventoryOperationCore where
  entries : List InventoryPostedAcquisitionEntry
  deriving DecidableEq, Repr, Inhabited

/-- The `"issue"` case of `OwnedInventoryOperationInput` (line 58). `specificHoldingIds` are plain
strings; `identities` is `InventoryOwnershipSelectionRequest["identities"]`. -/
structure OwnedInventoryIssueInput extends OwnedInventoryOperationCore where
  quantity : ExactRational
  specificHoldingIds : Option (List String)
  identities : List InventoryOwnershipSelectionIdentity
  deriving DecidableEq, Repr, Inhabited

/-- The `"transfer"` case of `OwnedInventoryOperationInput` (line 60). `specificHoldingIds` are
plain strings. -/
structure OwnedInventoryTransferInput extends OwnedInventoryOperationCore where
  destinationCoordinate : OwnedInventoryCoordinateInput
  destinationInventoryPolicy : OwnedInventoryPolicyReference
  quantity : ExactRational
  specificHoldingIds : Option (List String)
  destinationPostingLink : Option OwnedInventoryPostingLink
  entries : List OwnedInventoryTransferEntryInput
  deriving DecidableEq, Repr, Inhabited

/-- The `"adopt"` case of `OwnedInventoryOperationInput` (line 68). -/
structure OwnedInventoryAdoptionInput extends OwnedInventoryOperationCore where
  entries : List OwnedInventoryAdoptionEntryInput
  postedBalance : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `OwnedInventoryOperationInput`: one constructor a `kind`, in the TypeScript's order. -/
inductive OwnedInventoryOperationInput where
  | acquisition (operation : OwnedInventoryAcquisitionInput)
  | issue (operation : OwnedInventoryIssueInput)
  | transfer (operation : OwnedInventoryTransferInput)
  | adopt (operation : OwnedInventoryAdoptionInput)
  deriving DecidableEq, Repr, Inhabited

namespace OwnedInventoryOperationInput

/-- `operation.kind`, the string the TypeScript compares. -/
def kind : OwnedInventoryOperationInput → String
  | .acquisition _ => "acquisition"
  | .issue _ => "issue"
  | .transfer _ => "transfer"
  | .adopt _ => "adopt"

/-- The fields every case carries (`OwnedInventoryOperationCore`). -/
def core : OwnedInventoryOperationInput → OwnedInventoryOperationCore
  | .acquisition operation => operation.toOwnedInventoryOperationCore
  | .issue operation => operation.toOwnedInventoryOperationCore
  | .transfer operation => operation.toOwnedInventoryOperationCore
  | .adopt operation => operation.toOwnedInventoryOperationCore

/-- `operation.ordinal`. -/
def ordinal (operation : OwnedInventoryOperationInput) : Int := operation.core.ordinal

/-- `operation.id`. -/
def id (operation : OwnedInventoryOperationInput) : InventoryOperationId := operation.core.id

/-- `operation.coordinate`. -/
def coordinate (operation : OwnedInventoryOperationInput) : OwnedInventoryCoordinateInput :=
  operation.core.coordinate

/-- `operation.inventoryPolicy`. -/
def inventoryPolicy (operation : OwnedInventoryOperationInput) : OwnedInventoryPolicyReference :=
  operation.core.inventoryPolicy

/-- `operation.derivation`. -/
def derivation (operation : OwnedInventoryOperationInput) : DerivationRecord :=
  operation.core.derivation

/-- `operation.postingLink`. -/
def postingLink (operation : OwnedInventoryOperationInput) : Option OwnedInventoryPostingLink :=
  operation.core.postingLink

end OwnedInventoryOperationInput

/-! ## The request, scopes and the accounting context (`owned-inventory-command.ts` lines 73 to
113) -/

/-- `OwnedInventoryTransactionRequest`. `algorithm` is a plain string, which
`prepareOwnedInventoryAccounting` compares with `"cumulativePostedInventoryV1"` (line 141). -/
structure OwnedInventoryTransactionRequest where
  algorithm : String
  algorithmVersion : SemanticVersion
  accountingDate : LocalDate
  governedAt : Instant
  fiscalPeriodId : FiscalPeriodId
  operations : List OwnedInventoryOperationInput
  resolvedJournals : List (ResolvedTransaction QuantizationPolicy)
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryMoneyScope`. -/
structure InventoryMoneyScope where
  bookId : BookId
  accountId : AccountId
  functionalCommodityId : CommodityId
  dimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `OwnedInventoryIdentityKind`. -/
inductive OwnedInventoryIdentityKind where
  | operation
  | lot
  | holding
  | anchor
  | movement
  | allocation
  | postingReference
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `OwnedInventoryIdentityKind`. -/
def OwnedInventoryIdentityKind.text : OwnedInventoryIdentityKind → String
  | .operation => "operation"
  | .lot => "lot"
  | .holding => "holding"
  | .anchor => "anchor"
  | .movement => "movement"
  | .allocation => "allocation"
  | .postingReference => "postingReference"

/-- `"managed" | "unmanaged"`: the answer of `OwnedInventoryAccountingContext.managedMoneyScope`. -/
inductive InventoryMoneyScopeStatus where
  | managed
  | unmanaged
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryMoneyScopeStatus`. -/
def InventoryMoneyScopeStatus.text : InventoryMoneyScopeStatus → String
  | .managed => "managed"
  | .unmanaged => "unmanaged"

/-- `OwnedInventoryAccountingContext`: trusted internal inputs after complete command,
configuration, opening, period and journal admission; not an external command API. The four
methods are functions whose answer is `Except InventoryOwnershipReadError` (a callback that throws
is `.error`); `identityPresence` answers an `IdentityObservation` (`"present" | "absent"`, of
`Accounting/Types.lean`), `readPool` a list of `InventoryOwnershipPoolRow`. A structure of functions
has no `DecidableEq` and no `Repr`. -/
structure OwnedInventoryAccountingContext extends InventoryReductionEffectContext where
  functionalCommodityId : CommodityId
  ownerId : String
  admissionSnapshot : JournalAdmissionSnapshot
  bookingPolicies : List BookingPolicy
  accountingPolicies : List AccountingPolicy
  quantizationPolicies : List QuantizationPolicy
  journals : List BookedJournal
  ownership : InventoryOwnershipReadContext
  /-- Version 1.2.0 reads the complete active pool (nonzero quantity); prior versions include
  depleted rows for their unchanged historical work bounds. Permanent identity conflicts remain
  independent of selection membership. -/
  readPool : InventoryCostPolicy → CommodityId →
    Except InventoryOwnershipReadError (List InventoryOwnershipPoolRow)
  identityPresence : OwnedInventoryIdentityKind → String →
    Except InventoryOwnershipReadError IdentityObservation
  managedMoneyScope : InventoryMoneyScope →
    Except InventoryOwnershipReadError InventoryMoneyScopeStatus
  latestMovementDate : LotHoldingId → Except InventoryOwnershipReadError LocalDate
  deriving Inhabited

/-! ## Meaning: constructible values of the types this file imports -/

/-- A policy application whose identifiers are valid. Its `scopeKey` is a plain string. -/
structure PolicyApplication.WF (application : PolicyApplication) : Prop where
  postingId : application.postingId.WF
  policyId : application.policyId.WF

/-- A constructible resolved transaction: the journal's exact numbers constructible and its
identifiers valid, as `BookedJournal.WF` asks, and the rest of the record constructible. -/
structure ResolvedTransaction.WF (transaction : ResolvedTransaction QuantizationPolicy) : Prop where
  journal : transaction.journal.WF
  journalIdentifiers : transaction.journal.IdentifiersWF
  policyApplications : ∀ application ∈ transaction.policyApplications, application.WF
  quantizationPolicy : transaction.quantizationPolicy.WF
  exactBookValues : ∀ value ∈ transaction.exactBookValues, value.WF
  derivations : ∀ derivation ∈ transaction.derivations, derivation.WF

/-! ## Meaning: constructible inputs, requests and contexts -/

/-- A coordinate input whose identifiers are valid. -/
structure OwnedInventoryCoordinateInput.WF (coordinate : OwnedInventoryCoordinateInput) : Prop where
  accountId : coordinate.accountId.WF
  unitsCommodityId : coordinate.unitsCommodityId.WF
  dimensionMemberIds : ∀ id ∈ coordinate.dimensionMemberIds, id.WF
  bookingPolicy : coordinate.bookingPolicy.WF

/-- A posting link whose identifiers are valid. -/
structure OwnedInventoryPostingLink.WF (link : OwnedInventoryPostingLink) : Prop where
  postingId : link.postingId.WF
  referenceId : link.referenceId.WF

/-- The core of a constructible operation input. -/
structure OwnedInventoryOperationCore.WF (core : OwnedInventoryOperationCore) : Prop where
  id : core.id.WF
  coordinate : core.coordinate.WF
  inventoryPolicy : core.inventoryPolicy.WF
  derivation : core.derivation.WF
  postingLink : ∀ link, core.postingLink = some link → link.WF

/-- A transfer entry input whose identifiers are valid. -/
structure OwnedInventoryTransferEntryInput.WF (entry : OwnedInventoryTransferEntryInput) :
    Prop where
  holdingId : entry.holdingId.WF
  allocationId : entry.allocationId.WF
  transferOutMovementId : entry.transferOutMovementId.WF
  destinationAnchorId : entry.destinationAnchorId.WF
  destinationMovementId : entry.destinationMovementId.WF
  destinationHoldingId : entry.destinationHoldingId.WF
  destinationLotId : entry.destinationLotId.WF
  evidence : ∀ item ∈ entry.evidence, item.WF

/-- An adoption entry input whose identifiers are valid. -/
structure OwnedInventoryAdoptionEntryInput.WF (entry : OwnedInventoryAdoptionEntryInput) :
    Prop where
  anchorId : entry.anchorId.WF
  movementId : entry.movementId.WF
  holdingId : entry.holdingId.WF
  evidence : ∀ item ∈ entry.evidence, item.WF
  historicalPostings : ∀ posting ∈ entry.historicalPostings, posting.WF

/-- A constructible acquisition input. -/
structure OwnedInventoryAcquisitionInput.WF (operation : OwnedInventoryAcquisitionInput) :
    Prop where
  core : operation.toOwnedInventoryOperationCore.WF
  entries : ∀ entry ∈ operation.entries, entry.WF

/-- A constructible issue input. -/
structure OwnedInventoryIssueInput.WF (operation : OwnedInventoryIssueInput) : Prop where
  core : operation.toOwnedInventoryOperationCore.WF
  quantity : operation.quantity.WF
  identities : ∀ identity ∈ operation.identities, identity.WF

/-- A constructible transfer input. -/
structure OwnedInventoryTransferInput.WF (operation : OwnedInventoryTransferInput) : Prop where
  core : operation.toOwnedInventoryOperationCore.WF
  destinationCoordinate : operation.destinationCoordinate.WF
  destinationInventoryPolicy : operation.destinationInventoryPolicy.WF
  quantity : operation.quantity.WF
  destinationPostingLink : ∀ link, operation.destinationPostingLink = some link → link.WF
  entries : ∀ entry ∈ operation.entries, entry.WF

/-- A constructible adoption input. -/
structure OwnedInventoryAdoptionInput.WF (operation : OwnedInventoryAdoptionInput) : Prop where
  core : operation.toOwnedInventoryOperationCore.WF
  entries : ∀ entry ∈ operation.entries, entry.WF
  postedBalance : operation.postedBalance.WF

/-- A constructible operation input: the record of its case is. -/
def OwnedInventoryOperationInput.WF : OwnedInventoryOperationInput → Prop
  | .acquisition operation => operation.WF
  | .issue operation => operation.WF
  | .transfer operation => operation.WF
  | .adopt operation => operation.WF

/-- A constructible request. -/
structure OwnedInventoryTransactionRequest.WF (request : OwnedInventoryTransactionRequest) :
    Prop where
  fiscalPeriodId : request.fiscalPeriodId.WF
  operations : ∀ operation ∈ request.operations, operation.WF
  resolvedJournals : ∀ transaction ∈ request.resolvedJournals, transaction.WF

/-- A money scope whose identifiers are valid. -/
structure InventoryMoneyScope.WF (scope : InventoryMoneyScope) : Prop where
  bookId : scope.bookId.WF
  accountId : scope.accountId.WF
  functionalCommodityId : scope.functionalCommodityId.WF
  dimensionMemberIds : ∀ id ∈ scope.dimensionMemberIds, id.WF

/-- A context every field and every answer of which is constructible. -/
structure OwnedInventoryAccountingContext.WF (context : OwnedInventoryAccountingContext) :
    Prop where
  effectContext : context.toInventoryReductionEffectContext.WF
  functionalCommodityId : context.functionalCommodityId.WF
  admissionSnapshot : context.admissionSnapshot.WF
  bookingPolicies : ∀ policy ∈ context.bookingPolicies, policy.WF
  accountingPolicies : ∀ policy ∈ context.accountingPolicies, policy.WF
  quantizationPolicies : ∀ policy ∈ context.quantizationPolicies, policy.WF
  journals : ∀ booked ∈ context.journals, booked.WF
  ownership : context.ownership.WF
  readPool : ∀ policy commodity rows, context.readPool policy commodity = .ok rows →
    ∀ row ∈ rows, row.WF

end Rastrata.Kernel

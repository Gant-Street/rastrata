/-
`canonicalize` (`packages/kernel/src/accounting.ts` line 688) of the values the read snapshot and the
basis projection hold: the journal vocabulary (`Quantity`, `BookValue`, `TransactionPrice`,
`CostBasis`, `Posting`, `JournalTransaction`, the admission snapshot and its members), the policy
vocabulary (`PolicyCapability`, `BookingPolicy`), the book vocabulary (`FiscalPeriod`,
`BookConfigurationSnapshot`, `BookedJournal`) and the basis vocabulary of `Accounting/BasisTypes.lean`.
`Accounting/Core/Canonical.lean` models `canonicalize` for the types of `Accounting/Types.lean` only;
it is read here as it stands and is not edited, and this file follows its conventions to the letter
(see the header of that file): an `interface` is the record of its fields, an optional field that is
absent is left out, a union of string literals is its literal, a `bigint` is the integer, an array is
the array of its members.

The one object that is not an interface is `requiredDimensionIdsByPosting`, a
`Readonly<Record<string, readonly DimensionId[]>>`: the record of its own properties, each an array
(`requiredDimensionIdsByPostingValue`). A JavaScript object has distinct keys; the model keeps the
list of pairs the vocabulary gives it (`Journal/Types.lean`), which may repeat a key, so the laws
that need the canonical value to determine its value say that the keys are distinct
(`JournalAdmissionSnapshot.KeysDistinct`).
-/
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

/-! ## String literals the vocabulary lacks -/

/-- The string literal of an `AccountRole`. -/
def AccountRole.canonicalText : AccountRole → String
  | .asset => "asset"
  | .liability => "liability"
  | .equity => "equity"
  | .income => "income"
  | .expense => "expense"
  | .gain => "gain"
  | .unrealizedGain => "unrealizedGain"

/-- The string literal of a `NormalSide`. -/
def NormalSide.canonicalText : NormalSide → String
  | .debit => "debit"
  | .credit => "credit"

instance : Canonicalize JournalKind := ⟨fun v => .string v.text⟩
instance : Canonicalize AccountRole := ⟨fun v => .string v.canonicalText⟩
instance : Canonicalize NormalSide := ⟨fun v => .string v.canonicalText⟩
instance : Canonicalize FiscalPeriodKind := ⟨fun v => .string v.text⟩
instance : Canonicalize LotSelectionMethod := ⟨fun v => .string v.text⟩
instance : Canonicalize PolicyScope := ⟨fun v => .string v.text⟩
instance : Canonicalize PolicyCapabilityStatus := ⟨fun v => .string v.text⟩
instance : Canonicalize BookExecutionProfile := ⟨fun v => .string v.text⟩
instance : Canonicalize BookStateCommitmentProfile := ⟨fun v => .string v.text⟩

/-! ## The journal vocabulary (`journal.ts` lines 95 to 196) -/

/-- `Quantity`. -/
def Quantity.canonicalMembers (quantity : Quantity) : List Member :=
  [member "canonicalNumber" quantity.canonicalNumber, member "commodityId" quantity.commodityId,
    optMember "sourceNumber" quantity.sourceNumber]

instance : CanonicalObject Quantity := ⟨Quantity.canonicalMembers⟩

/-- `BookValue`. -/
def BookValue.canonicalMembers (value : BookValue) : List Member :=
  [member "amount" value.amount, member "functionalCommodityId" value.functionalCommodityId]

instance : CanonicalObject BookValue := ⟨BookValue.canonicalMembers⟩

/-- `TransactionPrice`. -/
def TransactionPrice.canonicalMembers (price : TransactionPrice) : List Member :=
  [member "unitRate" price.unitRate, member "baseCommodityId" price.baseCommodityId,
    member "quoteCommodityId" price.quoteCommodityId]

instance : CanonicalObject TransactionPrice := ⟨TransactionPrice.canonicalMembers⟩

/-- `CostBasis`. -/
def CostBasis.canonicalMembers (basis : CostBasis) : List Member :=
  [member "totalBasis" basis.totalBasis, member "basisCommodityId" basis.basisCommodityId,
    optMember "sourceTotalBasis" basis.sourceTotalBasis]

instance : CanonicalObject CostBasis := ⟨CostBasis.canonicalMembers⟩

/-- `Posting`, walked by `canonicalize` (not `canonicalPostingValue` of `journal.ts`, which adds
`type`s, writes `null` for an absent field and sorts the dimension members): every field in the order
given, an absent optional field left out. -/
def Posting.canonicalMembers (posting : Posting) : List Member :=
  [member "id" posting.id, member "ordinal" posting.ordinal, member "accountId" posting.accountId,
    member "units" posting.units, member "bookValue" posting.bookValue,
    optMember "transactionPrice" posting.transactionPrice,
    optMember "costBasis" posting.costBasis,
    member "dimensionMemberIds" posting.dimensionMemberIds]

instance : CanonicalObject Posting := ⟨Posting.canonicalMembers⟩

/-- `JournalTransaction`, walked by `canonicalize` (not `canonicalJournalValue` of `journal.ts`, which
sorts the postings): the postings in the order given. -/
def JournalTransaction.canonicalMembers (journal : JournalTransaction) : List Member :=
  [member "id" journal.id, member "kind" journal.kind, member "bookId" journal.bookId,
    member "functionalCommodityId" journal.functionalCommodityId,
    member "economicAt" journal.economicAt, member "accountingDate" journal.accountingDate,
    optMember "settledAt" journal.settledAt, member "recordedAt" journal.recordedAt,
    member "narration" journal.narration, member "postings" journal.postings]

instance : CanonicalObject JournalTransaction := ⟨JournalTransaction.canonicalMembers⟩

/-- `AccountSnapshot`. -/
def AccountSnapshot.canonicalMembers (account : AccountSnapshot) : List Member :=
  [member "id" account.id, member "bookId" account.bookId, member "code" account.code,
    member "name" account.name, member "role" account.role, member "normalSide" account.normalSide,
    member "postingAllowed" account.postingAllowed, member "openedOn" account.openedOn,
    optMember "closedOn" account.closedOn, optMember "parentId" account.parentId,
    member "allowedCommodityIds" account.allowedCommodityIds]

instance : CanonicalObject AccountSnapshot := ⟨AccountSnapshot.canonicalMembers⟩

/-- `AccountingDimensionSnapshot`. -/
def AccountingDimensionSnapshot.canonicalMembers (dimension : AccountingDimensionSnapshot) :
    List Member :=
  [member "id" dimension.id, member "bookId" dimension.bookId, member "code" dimension.code,
    member "name" dimension.name, member "openedOn" dimension.openedOn,
    optMember "closedOn" dimension.closedOn]

instance : CanonicalObject AccountingDimensionSnapshot :=
  ⟨AccountingDimensionSnapshot.canonicalMembers⟩

/-- `DimensionMemberSnapshot`. -/
def DimensionMemberSnapshot.canonicalMembers (member' : DimensionMemberSnapshot) : List Member :=
  [member "id" member'.id, member "dimensionId" member'.dimensionId, member "code" member'.code,
    member "name" member'.name, member "openedOn" member'.openedOn,
    optMember "closedOn" member'.closedOn, optMember "parentId" member'.parentId]

instance : CanonicalObject DimensionMemberSnapshot := ⟨DimensionMemberSnapshot.canonicalMembers⟩

/-- The record `canonicalize` writes for `requiredDimensionIdsByPosting`
(`Readonly<Record<string, readonly DimensionId[]>>`): its own properties, each an array of
identifiers. -/
def requiredDimensionIdsByPostingValue (entries : List (String × List DimensionId)) :
    CanonicalValue :=
  .record (entries.map fun entry => (entry.1, canonicalize entry.2))

/-- `JournalAdmissionSnapshot`. (`member` is written in full: `JournalAdmissionSnapshot.member` is the
lookup of `Journal/Admission.lean`.) -/
def JournalAdmissionSnapshot.canonicalMembers (snapshot : JournalAdmissionSnapshot) :
    List Member :=
  [Rastrata.Kernel.member "bookId" snapshot.bookId,
    Rastrata.Kernel.member "functionalCommodityId" snapshot.functionalCommodityId,
    Rastrata.Kernel.member "accounts" snapshot.accounts,
    Rastrata.Kernel.member "dimensions" snapshot.dimensions,
    Rastrata.Kernel.member "dimensionMembers" snapshot.dimensionMembers,
    Rastrata.Kernel.member "requiredDimensionIds" snapshot.requiredDimensionIds,
    ("requiredDimensionIdsByPosting",
      snapshot.requiredDimensionIdsByPosting.map requiredDimensionIdsByPostingValue)]

instance : CanonicalObject JournalAdmissionSnapshot := ⟨JournalAdmissionSnapshot.canonicalMembers⟩

/-! ## The policy and book vocabulary (`policy.ts` lines 46 to 79, `book.ts` lines 177 to 245) -/

/-- `PolicyCapability`. -/
def PolicyCapability.canonicalMembers (capability : PolicyCapability) : List Member :=
  [member "id" capability.id, member "method" capability.method, member "scope" capability.scope,
    member "status" capability.status,
    member "implementationVersion" capability.implementationVersion,
    member "verificationEvidenceIds" capability.verificationEvidenceIds]

instance : CanonicalObject PolicyCapability := ⟨PolicyCapability.canonicalMembers⟩

/-- `BookingPolicy`. -/
def BookingPolicy.canonicalMembers (policy : BookingPolicy) : List Member :=
  [member "id" policy.id, member "bookId" policy.bookId, member "version" policy.version,
    member "validFrom" policy.validFrom, optMember "validTo" policy.validTo,
    member "lotSelection" policy.lotSelection, member "scope" policy.scope,
    member "scopeKey" policy.scopeKey, member "requiredDimensionIds" policy.requiredDimensionIds,
    member "implementationVersion" policy.implementationVersion,
    member "capability" policy.capability]

instance : CanonicalObject BookingPolicy := ⟨BookingPolicy.canonicalMembers⟩

/-- `FiscalPeriod`. -/
def FiscalPeriod.canonicalMembers (period : FiscalPeriod) : List Member :=
  [member "id" period.id, member "calendarId" period.calendarId,
    member "fiscalYear" period.fiscalYear, member "sequence" period.sequence,
    member "label" period.label, member "kind" period.kind, member "startsOn" period.startsOn,
    member "endsOn" period.endsOn]

instance : CanonicalObject FiscalPeriod := ⟨FiscalPeriod.canonicalMembers⟩

/-- `BookConfigurationSnapshot`. -/
def BookConfigurationSnapshot.canonicalMembers (snapshot : BookConfigurationSnapshot) :
    List Member :=
  [member "revision" snapshot.revision, member "effectiveAt" snapshot.effectiveAt,
    optMember "executionProfile" snapshot.executionProfile,
    optMember "stateCommitmentProfile" snapshot.stateCommitmentProfile,
    member "periods" snapshot.periods, member "admissionSnapshot" snapshot.admissionSnapshot,
    member "policies" snapshot.policies,
    member "quantizationPolicies" snapshot.quantizationPolicies,
    member "accountingPolicySnapshot" snapshot.accountingPolicySnapshot,
    member "contentHash" snapshot.contentHash]

instance : CanonicalObject BookConfigurationSnapshot := ⟨BookConfigurationSnapshot.canonicalMembers⟩

/-- `BookedJournal`. `effectKey` is a plain string there. -/
def BookedJournal.canonicalMembers (booked : BookedJournal) : List Member :=
  [member "journal" booked.journal, member "commandId" booked.commandId,
    member "effectKey" booked.effectKey, member "bookRevision" booked.bookRevision,
    member "postingSequence" booked.postingSequence,
    member "fiscalPeriodId" booked.fiscalPeriodId,
    member "policySnapshotHash" booked.policySnapshotHash,
    member "quantizationPolicySnapshotHash" booked.quantizationPolicySnapshotHash,
    member "canonicalHash" booked.canonicalHash, member "derivations" booked.derivations]

instance : CanonicalObject BookedJournal := ⟨BookedJournal.canonicalMembers⟩

/-! ## The basis vocabulary (`accounting.ts` lines 1282 to 1327) -/

/-- `BasisSourceEvent`. `id` is a plain string; an absent optional field is left out. -/
def BasisSourceEvent.canonicalMembers (event : BasisSourceEvent) : List Member :=
  [member "id" event.id, member "event" event.event, member "accountingDate" event.accountingDate,
    member "source" event.source, member "sourcePosting" event.sourcePosting,
    optMember "openItemId" event.openItemId, optMember "settlementId" event.settlementId,
    optMember "settlementAllocationIds" event.settlementAllocationIds]

instance : CanonicalObject BasisSourceEvent := ⟨BasisSourceEvent.canonicalMembers⟩

/-- `AccountingBasisProjectionEntry`, with the deprecated `amount`. -/
def AccountingBasisProjectionEntry.canonicalMembers (entry : AccountingBasisProjectionEntry) :
    List Member :=
  [member "ordinal" entry.ordinal, member "sourceId" entry.sourceId,
    member "treatment" entry.treatment,
    member "includedExactAmount" entry.includedExactAmount,
    member "excludedExactAmount" entry.excludedExactAmount,
    optMember "recognizedAmount" entry.recognizedAmount,
    member "settlementAllocationIds" entry.settlementAllocationIds,
    member "amount" entry.amount]

instance : CanonicalObject AccountingBasisProjectionEntry :=
  ⟨AccountingBasisProjectionEntry.canonicalMembers⟩

/-- `AccountingBasisReconciliation`. -/
def AccountingBasisReconciliation.canonicalMembers (reconciliation : AccountingBasisReconciliation) :
    List Member :=
  [member "sourceExactTotal" reconciliation.sourceExactTotal,
    member "includedExactTotal" reconciliation.includedExactTotal,
    member "excludedExactTotal" reconciliation.excludedExactTotal,
    member "projectedExactTotal" reconciliation.projectedExactTotal,
    member "projectedBookValueTotal" reconciliation.projectedBookValueTotal,
    member "quantizationResidualTotal" reconciliation.quantizationResidualTotal,
    member "contentHash" reconciliation.contentHash]

instance : CanonicalObject AccountingBasisReconciliation :=
  ⟨AccountingBasisReconciliation.canonicalMembers⟩

/-- `AccountingReadSnapshot`, every field. -/
def AccountingReadSnapshot.canonicalMembers (snapshot : AccountingReadSnapshot) : List Member :=
  [member "throughBookRevision" snapshot.throughBookRevision,
    member "throughPostingSequence" snapshot.throughPostingSequence,
    member "policyEffectiveAt" snapshot.policyEffectiveAt,
    member "bookStateHash" snapshot.bookStateHash,
    member "reportPopulationHash" snapshot.reportPopulationHash,
    member "sourcePopulationHash" snapshot.sourcePopulationHash,
    member "configurationSnapshot" snapshot.configurationSnapshot,
    member "journals" snapshot.journals, member "accountingState" snapshot.accountingState,
    member "sourcePostingPopulation" snapshot.sourcePostingPopulation,
    member "sourceEvents" snapshot.sourceEvents, member "contentHash" snapshot.contentHash]

instance : CanonicalObject AccountingReadSnapshot := ⟨AccountingReadSnapshot.canonicalMembers⟩

/-- `AccountingBasisProjection`. -/
def AccountingBasisProjection.canonicalMembers (projection : AccountingBasisProjection) :
    List Member :=
  [member "policyId" projection.policyId,
    member "sourcePopulationHash" projection.sourcePopulationHash,
    member "entries" projection.entries, member "reconciliation" projection.reconciliation,
    member "sourceSnapshot" projection.sourceSnapshot,
    member "contentHash" projection.contentHash]

instance : CanonicalObject AccountingBasisProjection := ⟨AccountingBasisProjection.canonicalMembers⟩

end Rastrata.Kernel

/-
The vocabulary of the basis projection: the Lean model of the types of
`packages/kernel/src/accounting.ts` lines 1282 to 1328 (`BasisSourceEvent`,
`AccountingReadSnapshot`, `AccountingBasisProjectionEntry`, `AccountingBasisReconciliation`,
`AccountingBasisProjection`, `BasisProjectionResult`). They mention `BookConfigurationSnapshot` and
`BookedJournal` of `book.ts`, so they are here, after `Book/BaseTypes.lean`, and not in
`Accounting/Types.lean`. The hash functions from line 1329 on are `Accounting/Basis.lean`'s.

The types are written as in `Accounting/Types.lean`. The TypeScript writes two `Omit`s of the read
snapshot: `Omit<AccountingReadSnapshot, "contentHash" | "reportPopulationHash">` (line 1352, what
`hashAccountingReadPopulation` hashes) is `AccountingReadPopulation`;
`Omit<AccountingReadSnapshot, "contentHash">` (line 1336, what `hashAccountingReadSnapshot` hashes)
is `AccountingReadSnapshotBody`, which extends it with `reportPopulationHash`; and
`AccountingReadSnapshot` extends that with `contentHash`. The fields are in the TypeScript's order
except `reportPopulationHash`, which the TypeScript writes between `bookStateHash` and
`sourcePopulationHash`; the order of fields is not read by the hashes (`canonicalize` writes a
record, whose entries the encoder sorts).

What the TypeScript type says and the Lean type cannot: `projectAccountingBasis` rejects a source
event that carries a property `amount` or `settlementRatio` (line 1401), which `BasisSourceEvent`
does not have; a Lean `BasisSourceEvent` has no such property, so that test always passes here.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Journal.Admission
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Book.BaseTypes

namespace Rastrata.Kernel

/-! ## The types (`accounting.ts` lines 1282 to 1328) -/

/-- `BasisSourceEvent`. `id` is a plain string, not an identifier; `event` is
`AccountingBasisRule["event"]`. -/
structure BasisSourceEvent where
  id : String
  event : AccountingBasisEvent
  accountingDate : LocalDate
  source : CanonicalPostingReference
  sourcePosting : Posting
  openItemId : Option OpenItemId
  settlementId : Option SettlementId
  settlementAllocationIds : Option (List SettlementAllocationId)
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<AccountingReadSnapshot, "contentHash" | "reportPopulationHash">` (`accounting.ts`
line 1352). -/
structure AccountingReadPopulation where
  throughBookRevision : Int
  throughPostingSequence : Int
  policyEffectiveAt : Instant
  bookStateHash : ContentHash
  sourcePopulationHash : ContentHash
  configurationSnapshot : BookConfigurationSnapshot
  journals : List BookedJournal
  accountingState : AccountingCanonicalState
  /-- Exact report population; every member must have exactly one typed source event. -/
  sourcePostingPopulation : List CanonicalPostingReference
  sourceEvents : List BasisSourceEvent
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<AccountingReadSnapshot, "contentHash">` (`accounting.ts` line 1336). -/
structure AccountingReadSnapshotBody extends AccountingReadPopulation where
  reportPopulationHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingReadSnapshot`. -/
structure AccountingReadSnapshot extends AccountingReadSnapshotBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingBasisProjectionEntry`. `sourceId` is a plain string; `treatment` is
`AccountingBasisRule["treatment"]`. -/
structure AccountingBasisProjectionEntry where
  ordinal : Int
  sourceId : String
  treatment : AccountingBasisTreatment
  includedExactAmount : ExactRational
  excludedExactAmount : ExactRational
  recognizedAmount : Option QuantizedValue
  settlementAllocationIds : List SettlementAllocationId
  /-- Deprecated in the TypeScript: use `includedExactAmount` and `recognizedAmount`. -/
  amount : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingBasisReconciliation`. -/
structure AccountingBasisReconciliation where
  sourceExactTotal : ExactRational
  includedExactTotal : ExactRational
  excludedExactTotal : ExactRational
  projectedExactTotal : ExactRational
  projectedBookValueTotal : ExactRational
  quantizationResidualTotal : ExactRational
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `AccountingBasisProjection`. -/
structure AccountingBasisProjection where
  policyId : PolicyId
  sourcePopulationHash : ContentHash
  entries : List AccountingBasisProjectionEntry
  reconciliation : AccountingBasisReconciliation
  sourceSnapshot : AccountingReadSnapshot
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `BasisProjectionResult`: the two dispositions, `projected` and `rejected`. -/
inductive BasisProjectionResult where
  | projected (projection : AccountingBasisProjection)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-! ## Meaning: constructible values, as in `Accounting/Types.lean` -/

/-- A constructible source event: its reference's identifiers valid, its posting's exact numbers
constructible and identifiers valid, and its own identifiers valid. -/
structure BasisSourceEvent.WF (event : BasisSourceEvent) : Prop where
  source : event.source.WF
  sourcePosting : event.sourcePosting.WF
  sourcePostingIdentifiers : event.sourcePosting.IdentifiersWF
  openItemId : ∀ id, event.openItemId = some id → id.WF
  settlementId : ∀ id, event.settlementId = some id → id.WF
  settlementAllocationIds : ∀ ids, event.settlementAllocationIds = some ids → ∀ id ∈ ids, id.WF

/-- A constructible read population. -/
structure AccountingReadPopulation.WF (population : AccountingReadPopulation) : Prop where
  configurationSnapshot : population.configurationSnapshot.WF
  journals : ∀ journal ∈ population.journals, journal.WF
  accountingState : population.accountingState.WF
  sourcePostingPopulation : ∀ reference ∈ population.sourcePostingPopulation, reference.WF
  sourceEvents : ∀ event ∈ population.sourceEvents, event.WF

/-- The body of a constructible read snapshot: its population is. -/
def AccountingReadSnapshotBody.WF (snapshot : AccountingReadSnapshotBody) : Prop :=
  snapshot.toAccountingReadPopulation.WF

/-- A constructible read snapshot: its population is. -/
def AccountingReadSnapshot.WF (snapshot : AccountingReadSnapshot) : Prop :=
  snapshot.toAccountingReadSnapshotBody.WF

/-- A constructible projection entry. -/
structure AccountingBasisProjectionEntry.WF (entry : AccountingBasisProjectionEntry) : Prop where
  includedExactAmount : entry.includedExactAmount.WF
  excludedExactAmount : entry.excludedExactAmount.WF
  recognizedAmount : ∀ value, entry.recognizedAmount = some value → value.WF
  settlementAllocationIds : ∀ id ∈ entry.settlementAllocationIds, id.WF
  amount : entry.amount.WF

/-- A constructible reconciliation. -/
structure AccountingBasisReconciliation.WF (reconciliation : AccountingBasisReconciliation) :
    Prop where
  sourceExactTotal : reconciliation.sourceExactTotal.WF
  includedExactTotal : reconciliation.includedExactTotal.WF
  excludedExactTotal : reconciliation.excludedExactTotal.WF
  projectedExactTotal : reconciliation.projectedExactTotal.WF
  projectedBookValueTotal : reconciliation.projectedBookValueTotal.WF
  quantizationResidualTotal : reconciliation.quantizationResidualTotal.WF

/-- A constructible projection. -/
structure AccountingBasisProjection.WF (projection : AccountingBasisProjection) : Prop where
  policyId : projection.policyId.WF
  entries : ∀ entry ∈ projection.entries, entry.WF
  reconciliation : projection.reconciliation.WF
  sourceSnapshot : projection.sourceSnapshot.WF

/-- A constructible projection result: a projection is constructible; a rejection holds no exact
number and no identifier. -/
def BasisProjectionResult.WF : BasisProjectionResult → Prop
  | .projected value => value.WF
  | .rejected _ => True

end Rastrata.Kernel

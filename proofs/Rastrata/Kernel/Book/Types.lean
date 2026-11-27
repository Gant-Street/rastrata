/-
The vocabulary of a book's commands and history: the Lean model of the types of
`packages/kernel/src/book.ts` lines 272 to 676 (`CorrectionLink`, `BookedLotAllocation`,
`LotOperation`, `LotStateEffect`, `LotChangesEffect`, `ClosePackage`, `PeriodTransition`,
`BookEffect`, `RevisionRecord`, `BookState`, `CommandCore` and the eighteen commands,
`UnsealedBookCommand`, `BookCommand`, `BookCommitIntent`, `RetainedCommandResult`,
`BookProtocolState`, `BookCommandResult`, `AtomicBookCommit`, `Evaluation`), with the two functions
of those lines that need nothing but the types: `inventoryDisposalSelectionMatches` (line 315) and
`applyLotChanges` (line 345).

Not here: `createAccountingReadSnapshot` (lines 248 to 270), which needs the hashes of
`Accounting/Basis/Model.lean`; `hashLotChanges` (line 342), which hashes the canonical values
`lotValue` and `holdingValue` of lines 888 and 901 and is `Book/Hashing.lean`'s with them; and
everything from line 678 on.

The types are written as in `Accounting/Types.lean`:

- An `interface` is a `structure` with the same field names in the same order; an interface that
  `extends` another is a structure that `extends` the other. An optional field is an `Option`, a
  `readonly T[]` a `List T`, a `bigint` an `Int`, `null` is `none`.
- A union of string literals is an inductive with one constructor each, spelled as the literal,
  with `text` giving the literal back; a union written inline gets a name here, and its doc comment
  says which field it is the type of.
- A discriminated union is one inductive with one constructor a case; the discriminant (`type`,
  `disposition`) is the constructor, not a field, and a function gives its string where the
  TypeScript reads it (`LotOperation.type`, `BookEffect.type`, `UnsealedBookCommand.type`,
  `BookCommand.type`, `Evaluation.disposition`). A case the TypeScript writes inline gets a
  structure named here (`LotAcquireOperation`, `BookActivationEffect`, ...); a case with one field
  is a constructor with that field. A command interface's `type` is likewise its constructor of
  `UnsealedBookCommand`, so the command structures have no `type` field.
- `BookEffect` is the nine cases the TypeScript writes and `| AccountingEffect`, which spreads the
  thirteen accounting effects into the union: here one constructor, `accounting`, holding the
  `AccountingEffect`, and `BookEffect.type` gives the accounting effect's own `type`, so every book
  effect has the string the TypeScript compares.
- `BookCommand` is `UnsealedBookCommand & { readonly inputHash: ContentHash }`. A structure cannot
  extend an inductive, so it is the structure of the command (`toUnsealedBookCommand`, the name
  `extends` would give) and `inputHash`, with `BookCommand.type`, `BookCommand.id` and the other
  fields of `CommandCore` read through it.
- `Omit<BookState, "contentHash">` (`HashableBookState`, line 806) is `BookStateBody`, and
  `BookState` extends it with `contentHash`, which is therefore its last field here.
- `ResolvedTransaction` of `policy.ts` is `ResolvedTransaction QuantizationPolicy` of
  `Policy.lean`, whose instances `OwnedInventoryCommand/Types.lean` derives. An indexed access type
  is the type it names: `ResolvedTransaction["derivations"][number]` is `DerivationRecord`,
  `JournalTransaction["postings"][number]["accountId"]` is `AccountId`,
  `ProvisionalInventoryLayer["id"]` is `ProvisionalInventoryLayerId`, `InventoryCostPolicy["method"]`
  is `InventoryCostMethod`.
- The TypeScript declares a type before the type that holds it in three places; Lean needs the
  held type first: `GeneratedPostingDimensionSelection` comes before
  `GeneratedAccountingCommandCore`, and `RevisionRecord` and `BookState` (which hold commands) after
  the commands.

`BookState.journals`, `BookState.revisions` and `BookProtocolState.retainedResults` are lists. The
TypeScript keeps them as append-only history views (`book-history.ts`: `journalsOf`, `revisionsOf`,
`retainedLogOf`), and `BookHistory.lean` proves that such a view is a list: `Log.toList` is the
list of its elements, oldest first, and `Log.append_toList` says that appending to it appends to
the list and changes nothing before. That is the bridge: here they are the lists themselves, and
`applyEffects` appends to them as `Log.append_toList` says.

Meaning: `WF` as in `Accounting/Types.lean`, each exact number constructible and each identifier
valid, through every field, option and list; it says nothing about instants, local dates, versions,
content hashes or plain strings, which the kernel checks itself, and a law that needs one adds it
as its own hypothesis. A lot, holding or allocation inside a record is constructible when both its
`WF` and its `IdentifiersWF` hold. `LotSelection.IdentifiersWF`, `TransferPolicy.WF`,
`LotAllocationIdentity.WF` and `DestinationHoldingIdentity.WF` are defined here because no earlier
file defines them. `CorrectionLink` and `BookCommandResult` hold no exact number and no identifier
(the journal identifiers of a correction are plain strings), so they have no `WF`. Every structure
derives `DecidableEq`, `Repr` and `Inhabited`; none here holds a function.

What the global theorems are proved through: `JournalAdmitted` (a booked journal that
`admitJournal` admitted, with the hash it carries), `AllJournalsAdmitted` of a list of effects and
`BookState.AllJournalsAdmitted` of a state.

What the TypeScript type says and the Lean type cannot:

- An optional property may be absent or present with the value `undefined`, and `in` tells the
  two apart: `"generatedPostingDimensionSelections" in command` (lines 1844 and 2040). `Option` has
  one `none`, here the absent property.
- A JavaScript object may carry properties its type does not name. `"request" in command`
  (line 996), `"lotOperations" in command` (line 4485) and `"generatedPostingDimensionSelections"
  in command` test for one; here a command has a property exactly when the type of its case
  declares it.
- A field whose type is one literal cannot hold another value, so a `switch` on a command's or an
  effect's `type` always meets one of its cases.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Journal.Admission
import Rastrata.Kernel.Policy
import Rastrata.Kernel.Lots
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Book.BaseTypes
import Rastrata.Kernel.InventoryOwnership.Types
import Rastrata.Kernel.OwnedInventoryCommand.Types
import Rastrata.Kernel.Accounting.Inventory.Model
import Rastrata.Kernel.Accounting.Schedules.Model
import Rastrata.Kernel.Accounting.Currency
import Rastrata.Kernel.Accounting.Tax
import Rastrata.Kernel.Accounting.Consolidation

namespace Rastrata.Kernel

/-! ## Corrections and lot operations (`book.ts` lines 272 to 325) -/

/-- `"reversal" | "supersession"`: the type of `CorrectionLink.kind` and of
`CorrectJournalCommand.correctionKind` (line 484), written twice in the TypeScript with the same
two literals, so one type here. -/
inductive CorrectionKind where
  | reversal
  | supersession
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `CorrectionKind`. -/
def CorrectionKind.text : CorrectionKind → String
  | .reversal => "reversal"
  | .supersession => "supersession"

/-- `CorrectionLink`. Both journal identifiers are plain strings, not `JournalId`s. -/
structure CorrectionLink where
  kind : CorrectionKind
  originalJournalId : String
  correctionJournalId : String
  deriving DecidableEq, Repr, Inhabited

/-- The type of `BookedLotAllocation.kind`. -/
inductive BookedLotAllocationKind where
  | disposal
  | transfer
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookedLotAllocationKind`. -/
def BookedLotAllocationKind.text : BookedLotAllocationKind → String
  | .disposal => "disposal"
  | .transfer => "transfer"

/-- `BookedLotAllocation`. -/
structure BookedLotAllocation where
  allocation : LotAllocation
  journalPostingId : PostingId
  kind : BookedLotAllocationKind
  deriving DecidableEq, Repr, Inhabited

/-- The `"acquire"` case of `LotOperation` (line 285), unnamed in the TypeScript. -/
structure LotAcquireOperation where
  lot : Lot
  holding : LotHolding
  journalPostingId : PostingId
  deriving DecidableEq, Repr, Inhabited

/-- The `"dispose"` case of `LotOperation` (line 291), unnamed in the TypeScript. `derivation` is
`ResolvedTransaction["derivations"][number]`. -/
structure LotDisposeOperation where
  holdingIds : List LotHoldingId
  requestedQuantity : ExactRational
  selection : LotSelection
  derivation : DerivationRecord
  identities : List LotAllocationIdentity
  journalPostingId : PostingId
  deriving DecidableEq, Repr, Inhabited

/-- The `"transfer"` case of `LotOperation` (line 300), unnamed in the TypeScript.
`destinationAccountId` is `JournalTransaction["postings"][number]["accountId"]`; `derivation` is
`ResolvedTransaction["derivations"][number]`. -/
structure LotTransferOperation where
  sourceHoldingIds : List LotHoldingId
  destinationAccountId : AccountId
  requestedQuantity : ExactRational
  selection : LotSelection
  policies : List TransferPolicy
  governedAt : Instant
  derivation : DerivationRecord
  allocationIdentities : List LotAllocationIdentity
  destinationIdentities : List DestinationHoldingIdentity
  sourcePostingId : PostingId
  destinationPostingId : PostingId
  deriving DecidableEq, Repr, Inhabited

/-- `LotOperation`: one constructor a `type`, in the order of the TypeScript union. -/
inductive LotOperation where
  | acquire (operation : LotAcquireOperation)
  | dispose (operation : LotDisposeOperation)
  | transfer (operation : LotTransferOperation)
  deriving DecidableEq, Repr, Inhabited

/-- `operation.type`: the string literal of the operation's case. -/
def LotOperation.type : LotOperation → String
  | .acquire _ => "acquire"
  | .dispose _ => "dispose"
  | .transfer _ => "transfer"

/-- `inventoryDisposalSelectionMatches` (`book.ts` line 315). `selection.method === method`
compares the two literals, `LotSelectionMethod` and `InventoryCostMethod` here, by their text. A
selection whose method is `"specificIdentification"` is the case that holds the allocations, so the
`||` reads them only there; `layerId` is a plain string and is compared with the holding
identifier's text. -/
def inventoryDisposalSelectionMatches (selection : LotSelection) (method : InventoryCostMethod)
    (allocations : List InventoryAllocationResult) : Bool :=
  selection.method.text == method.text &&
    (match selection with
     | .specificIdentification selected =>
       selected.length == allocations.length &&
         selected.all fun item => allocations.any fun allocation =>
           allocation.layerId == item.holdingId.value && allocation.quantity.equals item.quantity
     | _ => true)

/-! ## Lot effects (`book.ts` lines 327 to 349) -/

/-- `LotStateEffect`. -/
structure LotStateEffect where
  lots : List Lot
  holdings : List LotHolding
  allocations : List BookedLotAllocation
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `LotChangesEffect`: owned command 1.2.0, immutable new lots and after-images of touched
holdings. Unmentioned lots, holdings and legacy allocations are preserved. Ownership source and
identity validation is required before this projection is admissible. -/
structure LotChangesEffect where
  lots : List Lot
  holdings : List LotHolding
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `{ lots, holdings }`: what `applyLotChanges` returns, unnamed in the TypeScript. -/
structure AppliedLotChanges where
  lots : List Lot
  holdings : List LotHolding
  deriving DecidableEq, Repr, Inhabited

namespace Book

/-- `Map.prototype.set` on the map of holdings by identifier of `applyLotChanges`, kept as its
entries in insertion order: a key already there keeps its place and takes the new holding, a new
key goes to the end. -/
def lotHoldingMapSet (entries : List (LotHoldingId × LotHolding)) (holding : LotHolding) :
    List (LotHoldingId × LotHolding) :=
  if entries.any (fun entry => entry.1 == holding.id) then
    entries.map fun entry => if entry.1 == holding.id then (holding.id, holding) else entry
  else entries ++ [(holding.id, holding)]

end Book

/-- `applyLotChanges` (`book.ts` line 345). `new Map(holdings.map(...))` sets each holding in
order (a repeated identifier keeps its first place and its last holding), the loop sets each
changed holding, and `[...updated.values()]` lists the values in insertion order. -/
def applyLotChanges (lots : List Lot) (holdings : List LotHolding) (changes : LotChangesEffect) :
    AppliedLotChanges :=
  let initial := holdings.foldl Book.lotHoldingMapSet []
  let updated := changes.holdings.foldl Book.lotHoldingMapSet initial
  { lots := lots ++ changes.lots, holdings := updated.map (·.2) }

/-! ## Closing and reopening periods (`book.ts` lines 351 to 379) -/

/-- `ClosePackage`. `closingJournalId` is a plain string, not a `JournalId`. -/
structure ClosePackage where
  id : ClosePackageId
  periodId : FiscalPeriodId
  cycle : Int
  throughBookRevision : Int
  throughPostingSequence : Int
  ledgerHash : ContentHash
  chartHash : ContentHash
  bookingPolicySnapshotHash : ContentHash
  quantizationPolicySnapshotHash : ContentHash
  reportPopulationHash : ContentHash
  reportingPolicySnapshotHash : ContentHash
  configurationRevision : Int
  configurationSnapshotHash : ContentHash
  configurationSnapshot : BookConfigurationSnapshot
  bookStateSnapshotHash : ContentHash
  closingJournalId : Option String
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The type of `PeriodTransition.kind`. -/
inductive PeriodTransitionKind where
  | close
  | reopen
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `PeriodTransitionKind`. -/
def PeriodTransitionKind.text : PeriodTransitionKind → String
  | .close => "close"
  | .reopen => "reopen"

/-- `PeriodTransition`. -/
structure PeriodTransition where
  periodId : FiscalPeriodId
  kind : PeriodTransitionKind
  reason : String
  bookRevision : Int
  recordedAt : Instant
  supersededCloseIds : List ClosePackageId
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## Effects (`book.ts` lines 381 to 411) -/

/-- The `"activation"` case of `BookEffect` (line 382), unnamed in the TypeScript. -/
structure BookActivationEffect where
  boundary : OpeningBoundary
  financialIdentityHash : ContentHash
  configurationHash : ContentHash
  configurationSnapshot : BookConfigurationSnapshot
  deriving DecidableEq, Repr, Inhabited

/-- The `"configuration"` case of `BookEffect` (line 389), unnamed in the TypeScript. -/
structure BookConfigurationEffect where
  expectedConfigurationRevision : Int
  nextConfigurationRevision : Int
  previousConfigurationHash : ContentHash
  effectiveOn : LocalDate
  periods : List FiscalPeriod
  admissionSnapshot : JournalAdmissionSnapshot
  policies : List BookingPolicy
  quantizationPolicies : List QuantizationPolicy
  accountingPolicySnapshot : AccountingPolicySnapshot
  previousConfigurationSnapshot : BookConfigurationSnapshot
  resultingConfigurationSnapshot : BookConfigurationSnapshot
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `BookEffect`: one constructor a `type` of the nine the TypeScript writes, in its order, each
holding the fields of its case (a case with one field holds that field, under its name); and the
tenth, `accounting`, for `| AccountingEffect`, which spreads the thirteen accounting effects into
the union. They are one constructor here, holding the accounting effect, so that every function on
`AccountingEffect` applies to it; `BookEffect.type` gives the accounting effect's own `type`, so a
book effect has the same thirteen strings the TypeScript compares (`effect.type ===
"openItem"`). No accounting effect's `type` is one of the nine. -/
inductive BookEffect where
  | activation (effect : BookActivationEffect)
  | configuration (effect : BookConfigurationEffect)
  | journal (booked : BookedJournal)
  | lotState (lotState : LotStateEffect)
  | lotChanges (changes : LotChangesEffect)
  | inventoryOwnership (value : InventoryOwnershipEffect)
  | correction (link : CorrectionLink)
  | periodTransition (transition : PeriodTransition)
  | closePackage (closePackage : ClosePackage)
  | accounting (effect : AccountingEffect)
  deriving DecidableEq, Repr, Inhabited

/-- `effect.type`: the string literal of the effect's case; for an accounting effect, its own
`type`. -/
def BookEffect.type : BookEffect → String
  | .activation _ => "activation"
  | .configuration _ => "configuration"
  | .journal _ => "journal"
  | .lotState _ => "lotState"
  | .lotChanges _ => "lotChanges"
  | .inventoryOwnership _ => "inventoryOwnership"
  | .correction _ => "correction"
  | .periodTransition _ => "periodTransition"
  | .closePackage _ => "closePackage"
  | .accounting effect => effect.type

/-! ## Commands (`book.ts` lines 455 to 518) -/

/-- `CommandCore` (not exported by the TypeScript): what every command carries. -/
structure CommandCore where
  id : CommandId
  protocolVersion : SemanticVersion
  bookId : BookId
  expectedBookRevision : Int
  issuedAt : Instant
  completedAt : Instant
  committedAt : Instant
  actorId : ActorId
  deriving DecidableEq, Repr, Inhabited

/-- The type of `ActivateBookCommand.mode`. -/
inductive BookActivationMode where
  | newZeroBalance
  | migration
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookActivationMode`. -/
def BookActivationMode.text : BookActivationMode → String
  | .newZeroBalance => "newZeroBalance"
  | .migration => "migration"

/-- `ActivateBookCommand`; its `type` is `"activateBook"`. -/
structure ActivateBookCommand extends CommandCore where
  mode : BookActivationMode
  boundaryId : OpeningBoundaryId
  firstAccountingDate : LocalDate
  opening : Option (ResolvedTransaction QuantizationPolicy)
  lotOperations : Option (List LotOperation)
  deriving DecidableEq, Repr, Inhabited

/-- `PostJournalCommand`; its `type` is `"postJournal"`. -/
structure PostJournalCommand extends CommandCore where
  resolved : ResolvedTransaction QuantizationPolicy
  fiscalPeriodId : Option FiscalPeriodId
  lotOperations : Option (List LotOperation)
  deriving DecidableEq, Repr, Inhabited

/-- `CorrectJournalCommand`; its `type` is `"correctJournal"`. `originalJournalId` is a plain
string, not a `JournalId`. -/
structure CorrectJournalCommand extends CommandCore where
  correctionKind : CorrectionKind
  originalJournalId : String
  resolved : ResolvedTransaction QuantizationPolicy
  fiscalPeriodId : Option FiscalPeriodId
  lotOperations : Option (List LotOperation)
  deriving DecidableEq, Repr, Inhabited

/-- `ClosePeriodCommand`; its `type` is `"closePeriod"`. -/
structure ClosePeriodCommand extends CommandCore where
  periodId : FiscalPeriodId
  closePackageId : ClosePackageId
  reason : String
  reportPopulationHash : ContentHash
  reportingPolicySnapshotHash : ContentHash
  closing : Option (ResolvedTransaction QuantizationPolicy)
  deriving DecidableEq, Repr, Inhabited

/-- `ReopenPeriodCommand`; its `type` is `"reopenPeriod"`. -/
structure ReopenPeriodCommand extends CommandCore where
  periodId : FiscalPeriodId
  reason : String
  reversal : Option (ResolvedTransaction QuantizationPolicy)
  deriving DecidableEq, Repr, Inhabited

/-- `ReplaceConfigurationCommand`; its `type` is `"replaceConfiguration"`. -/
structure ReplaceConfigurationCommand extends CommandCore where
  expectedConfigurationRevision : Int
  effectiveOn : LocalDate
  periods : List FiscalPeriod
  admissionSnapshot : JournalAdmissionSnapshot
  policies : List BookingPolicy
  quantizationPolicies : List QuantizationPolicy
  accountingPolicies : List AccountingPolicy
  executionProfileAdoption : Option ExecutionProfileAdoption
  deriving DecidableEq, Repr, Inhabited

/-! ## Commands that generate accounting (`book.ts` lines 520 to 601) -/

/-- `GeneratedPostingDimensionSelection`. It is declared after `GeneratedAccountingCommandCore` in
the TypeScript, which holds it, so it comes first here. `effectKey` is a plain string, not an
`EffectKey`. -/
structure GeneratedPostingDimensionSelection where
  effectKey : String
  postingOrdinal : Int
  dimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `GeneratedAccountingCommandCore` (not exported by the TypeScript). -/
structure GeneratedAccountingCommandCore extends CommandCore where
  fiscalPeriodId : Option FiscalPeriodId
  generatedPostingDimensionSelections : Option (List GeneratedPostingDimensionSelection)
  deriving DecidableEq, Repr, Inhabited

/-- `PostInventoryTransactionCommand`; its `type` is `"postInventoryTransaction"`. The two account
identifiers are `JournalTransaction["postings"][number]["accountId"]`, `provisionalLayerId` is
`ProvisionalInventoryLayer["id"]` and `derivation` is `ResolvedTransaction["derivations"][number]`. -/
structure PostInventoryTransactionCommand extends GeneratedAccountingCommandCore where
  request : InventoryCostRequest
  inventoryAccountId : AccountId
  costAccountId : AccountId
  inventoryCommodityId : CommodityId
  provisionalLayerId : Option ProvisionalInventoryLayerId
  derivation : DerivationRecord
  lotOperations : Option (List LotOperation)
  deriving DecidableEq, Repr, Inhabited

/-- `PostOwnedInventoryTransactionCommand`; its `type` is `"postOwnedInventoryTransaction"`. It
extends `CommandCore`, not `GeneratedAccountingCommandCore`. -/
structure PostOwnedInventoryTransactionCommand extends CommandCore where
  request : OwnedInventoryTransactionRequest
  deriving DecidableEq, Repr, Inhabited

/-- `RecostProvisionalInventoryCommand`; its `type` is `"recostProvisionalInventory"`. -/
structure RecostProvisionalInventoryCommand extends GeneratedAccountingCommandCore where
  request : RecostInventoryRequest
  inventoryAccountId : AccountId
  adjustmentAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- `AdjustInventoryValueCommand`; its `type` is `"adjustInventoryValue"`. -/
structure AdjustInventoryValueCommand extends GeneratedAccountingCommandCore where
  request : InventoryValueAdjustmentRequest
  deriving DecidableEq, Repr, Inhabited

/-- `RecognizeOpenItemCommand`; its `type` is `"recognizeOpenItem"`. -/
structure RecognizeOpenItemCommand extends GeneratedAccountingCommandCore where
  request : OpenItemRecognitionRequest
  resolved : ResolvedTransaction QuantizationPolicy
  deriving DecidableEq, Repr, Inhabited

/-- `ApplySettlementCommand`; its `type` is `"applySettlement"`. -/
structure ApplySettlementCommand extends GeneratedAccountingCommandCore where
  request : SettlementRequest
  resolved : List (ResolvedTransaction QuantizationPolicy)
  deriving DecidableEq, Repr, Inhabited

/-- `PostCurrencyRemeasurementCommand`; its `type` is `"postCurrencyRemeasurement"`. -/
structure PostCurrencyRemeasurementCommand extends GeneratedAccountingCommandCore where
  request : CurrencyRemeasurementRequest
  deriving DecidableEq, Repr, Inhabited

/-- `CreateAllocationScheduleCommand`; its `type` is `"createAllocationSchedule"`. -/
structure CreateAllocationScheduleCommand extends GeneratedAccountingCommandCore where
  request : AllocationScheduleRequest
  deriving DecidableEq, Repr, Inhabited

/-- `RecognizeScheduledAllocationCommand`; its `type` is `"recognizeScheduledAllocation"`. -/
structure RecognizeScheduledAllocationCommand extends GeneratedAccountingCommandCore where
  request : AllocationRecognitionRequest
  deriving DecidableEq, Repr, Inhabited

/-- `ReviseAllocationScheduleCommand`; its `type` is `"reviseAllocationSchedule"`. -/
structure ReviseAllocationScheduleCommand extends GeneratedAccountingCommandCore where
  request : AllocationScheduleRevisionRequest
  /-- Optional resolved disposal completion, committed atomically with the adjustment. -/
  disposalJournal : Option (ResolvedTransaction QuantizationPolicy)
  deriving DecidableEq, Repr, Inhabited

/-- `PostTaxedTransactionCommand`; its `type` is `"postTaxedTransaction"`. -/
structure PostTaxedTransactionCommand extends GeneratedAccountingCommandCore where
  request : TaxRequest
  deriving DecidableEq, Repr, Inhabited

/-- `CompileConsolidationCommand`; its `type` is `"compileConsolidation"`. -/
structure CompileConsolidationCommand extends GeneratedAccountingCommandCore where
  request : ConsolidationRequest
  deriving DecidableEq, Repr, Inhabited

/-! ## The union of commands and the sealed command (`book.ts` lines 603 to 623) -/

/-- `UnsealedBookCommand`: one constructor a `type`, in the order of the TypeScript union, each
holding the command of that type. -/
inductive UnsealedBookCommand where
  | activateBook (command : ActivateBookCommand)
  | postJournal (command : PostJournalCommand)
  | correctJournal (command : CorrectJournalCommand)
  | closePeriod (command : ClosePeriodCommand)
  | reopenPeriod (command : ReopenPeriodCommand)
  | replaceConfiguration (command : ReplaceConfigurationCommand)
  | postInventoryTransaction (command : PostInventoryTransactionCommand)
  | postOwnedInventoryTransaction (command : PostOwnedInventoryTransactionCommand)
  | recostProvisionalInventory (command : RecostProvisionalInventoryCommand)
  | adjustInventoryValue (command : AdjustInventoryValueCommand)
  | recognizeOpenItem (command : RecognizeOpenItemCommand)
  | applySettlement (command : ApplySettlementCommand)
  | postCurrencyRemeasurement (command : PostCurrencyRemeasurementCommand)
  | createAllocationSchedule (command : CreateAllocationScheduleCommand)
  | recognizeScheduledAllocation (command : RecognizeScheduledAllocationCommand)
  | reviseAllocationSchedule (command : ReviseAllocationScheduleCommand)
  | postTaxedTransaction (command : PostTaxedTransactionCommand)
  | compileConsolidation (command : CompileConsolidationCommand)
  deriving DecidableEq, Repr, Inhabited

namespace UnsealedBookCommand

/-- `command.type`: the string literal of the command's case. -/
def type : UnsealedBookCommand → String
  | .activateBook _ => "activateBook"
  | .postJournal _ => "postJournal"
  | .correctJournal _ => "correctJournal"
  | .closePeriod _ => "closePeriod"
  | .reopenPeriod _ => "reopenPeriod"
  | .replaceConfiguration _ => "replaceConfiguration"
  | .postInventoryTransaction _ => "postInventoryTransaction"
  | .postOwnedInventoryTransaction _ => "postOwnedInventoryTransaction"
  | .recostProvisionalInventory _ => "recostProvisionalInventory"
  | .adjustInventoryValue _ => "adjustInventoryValue"
  | .recognizeOpenItem _ => "recognizeOpenItem"
  | .applySettlement _ => "applySettlement"
  | .postCurrencyRemeasurement _ => "postCurrencyRemeasurement"
  | .createAllocationSchedule _ => "createAllocationSchedule"
  | .recognizeScheduledAllocation _ => "recognizeScheduledAllocation"
  | .reviseAllocationSchedule _ => "reviseAllocationSchedule"
  | .postTaxedTransaction _ => "postTaxedTransaction"
  | .compileConsolidation _ => "compileConsolidation"

/-- The fields every command carries (`CommandCore`). -/
def core : UnsealedBookCommand → CommandCore
  | .activateBook command => command.toCommandCore
  | .postJournal command => command.toCommandCore
  | .correctJournal command => command.toCommandCore
  | .closePeriod command => command.toCommandCore
  | .reopenPeriod command => command.toCommandCore
  | .replaceConfiguration command => command.toCommandCore
  | .postInventoryTransaction command => command.toCommandCore
  | .postOwnedInventoryTransaction command => command.toCommandCore
  | .recostProvisionalInventory command => command.toCommandCore
  | .adjustInventoryValue command => command.toCommandCore
  | .recognizeOpenItem command => command.toCommandCore
  | .applySettlement command => command.toCommandCore
  | .postCurrencyRemeasurement command => command.toCommandCore
  | .createAllocationSchedule command => command.toCommandCore
  | .recognizeScheduledAllocation command => command.toCommandCore
  | .reviseAllocationSchedule command => command.toCommandCore
  | .postTaxedTransaction command => command.toCommandCore
  | .compileConsolidation command => command.toCommandCore

/-- `command.id`. -/
def id (command : UnsealedBookCommand) : CommandId := command.core.id

/-- `command.protocolVersion`. -/
def protocolVersion (command : UnsealedBookCommand) : SemanticVersion :=
  command.core.protocolVersion

/-- `command.bookId`. -/
def bookId (command : UnsealedBookCommand) : BookId := command.core.bookId

/-- `command.expectedBookRevision`. -/
def expectedBookRevision (command : UnsealedBookCommand) : Int := command.core.expectedBookRevision

/-- `command.issuedAt`. -/
def issuedAt (command : UnsealedBookCommand) : Instant := command.core.issuedAt

/-- `command.completedAt`. -/
def completedAt (command : UnsealedBookCommand) : Instant := command.core.completedAt

/-- `command.committedAt`. -/
def committedAt (command : UnsealedBookCommand) : Instant := command.core.committedAt

/-- `command.actorId`. -/
def actorId (command : UnsealedBookCommand) : ActorId := command.core.actorId

end UnsealedBookCommand

/-- `BookCommand`, `UnsealedBookCommand & { readonly inputHash: ContentHash }`: a command with the
hash of its input. A Lean structure cannot extend an inductive, so the command is the field
`toUnsealedBookCommand`, the name `extends` would give it, and the functions below read through
it as the TypeScript reads the intersection's members. -/
structure BookCommand where
  toUnsealedBookCommand : UnsealedBookCommand
  inputHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

namespace BookCommand

/-- `command.type`. -/
def type (command : BookCommand) : String := command.toUnsealedBookCommand.type

/-- The fields every command carries (`CommandCore`). -/
def core (command : BookCommand) : CommandCore := command.toUnsealedBookCommand.core

/-- `command.id`. -/
def id (command : BookCommand) : CommandId := command.core.id

/-- `command.protocolVersion`. -/
def protocolVersion (command : BookCommand) : SemanticVersion := command.core.protocolVersion

/-- `command.bookId`. -/
def bookId (command : BookCommand) : BookId := command.core.bookId

/-- `command.expectedBookRevision`. -/
def expectedBookRevision (command : BookCommand) : Int := command.core.expectedBookRevision

/-- `command.issuedAt`. -/
def issuedAt (command : BookCommand) : Instant := command.core.issuedAt

/-- `command.completedAt`. -/
def completedAt (command : BookCommand) : Instant := command.core.completedAt

/-- `command.committedAt`. -/
def committedAt (command : BookCommand) : Instant := command.core.committedAt

/-- `command.actorId`. -/
def actorId (command : BookCommand) : ActorId := command.core.actorId

end BookCommand

/-! ## Revisions and the state of a book (`book.ts` lines 413 to 453)

`RevisionRecord` holds a `BookCommand` and `BookState` holds revisions, so the two come after the
commands here, where the TypeScript declares them before. -/

/-- `RevisionRecord`. `previousHash` is `null` for the first revision: `none` here. -/
structure RevisionRecord where
  bookId : BookId
  bookRevision : Int
  previousHash : Option ContentHash
  effectsHash : ContentHash
  chainHash : ContentHash
  committedAt : Instant
  command : BookCommand
  effects : List BookEffect
  deriving DecidableEq, Repr, Inhabited

/-- The type of `BookState.status`. -/
inductive BookStatus where
  | configuring
  | «open»
  | closed
  | archived
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookStatus`. -/
def BookStatus.text : BookStatus → String
  | .configuring => "configuring"
  | .«open» => "open"
  | .closed => "closed"
  | .archived => "archived"

/-- `Omit<BookState, "contentHash">`, which the TypeScript names `HashableBookState` (`book.ts`
line 806): what the content hash of a state is computed from. `contentHash`, third in the
TypeScript, is therefore the last field of `BookState` here; no hash reads the order of fields
(`canonicalize` sorts the keys). -/
structure BookStateBody where
  identity : BookFinancialIdentity
  financialIdentityHash : ContentHash
  status : BookStatus
  bookRevision : Int
  latestPostingSequence : Int
  configurationRevision : Int
  configurationHash : ContentHash
  configurationSnapshots : List BookConfigurationSnapshot
  activeConfigurationSnapshot : BookConfigurationSnapshot
  openingBoundary : Option OpeningBoundary
  periods : List FiscalPeriod
  admissionSnapshot : JournalAdmissionSnapshot
  policies : List BookingPolicy
  quantizationPolicies : List QuantizationPolicy
  accountingPolicySnapshot : AccountingPolicySnapshot
  accountingState : AccountingCanonicalState
  lots : List Lot
  lotHoldings : List LotHolding
  lotAllocations : List BookedLotAllocation
  /-- Present only after explicit owned-inventory commands. A materialized view of revision
  effects, not independent authority or an implicit legacy upgrade. -/
  inventoryOwnershipEffects : Option (List InventoryOwnershipEffect)
  journals : List BookedJournal
  corrections : List CorrectionLink
  periodTransitions : List PeriodTransition
  closePackages : List ClosePackage
  revisions : List RevisionRecord
  deriving DecidableEq, Repr, Inhabited

/-- `BookState`. `journals` and `revisions` are lists: see the head of this file. -/
structure BookState extends BookStateBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## The protocol: intents, retained results and outcomes (`book.ts` lines 625 to 676) -/

/-- `BookCommitIntent`. -/
structure BookCommitIntent where
  command : BookCommand
  expectedBookRevision : Int
  nextBookRevision : Int
  resultingPostingSequence : Int
  expectedConfigurationRevision : Int
  nextConfigurationRevision : Int
  resultingConfigurationHash : ContentHash
  effects : List BookEffect
  canonicalHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The type of `RetainedCommandResult.outcome`. -/
inductive RetainedCommandOutcome where
  | committed
  | rejected
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `RetainedCommandOutcome`. -/
def RetainedCommandOutcome.text : RetainedCommandOutcome → String
  | .committed => "committed"
  | .rejected => "rejected"

/-- `RetainedCommandResult`. -/
structure RetainedCommandResult where
  command : BookCommand
  commandId : CommandId
  inputHash : ContentHash
  outcome : RetainedCommandOutcome
  observedBookRevision : Int
  resultHash : ContentHash
  completedAt : Instant
  diagnostics : List SemanticDiagnostic
  commitIntentHash : Option ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `BookProtocolState`. `retainedResults` is a list: see the head of this file. -/
structure BookProtocolState where
  retainedResults : List RetainedCommandResult
  deriving DecidableEq, Repr, Inhabited

/-- The type of `BookCommandResult.disposition`. -/
inductive BookCommandDisposition where
  | committed
  | rejected
  | replayed
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookCommandDisposition`. -/
def BookCommandDisposition.text : BookCommandDisposition → String
  | .committed => "committed"
  | .rejected => "rejected"
  | .replayed => "replayed"

/-- `BookCommandResult`. -/
structure BookCommandResult where
  disposition : BookCommandDisposition
  observedBookRevision : Int
  resultHash : ContentHash
  diagnostics : List SemanticDiagnostic
  completedAt : Instant
  committedAt : Option Instant
  deriving DecidableEq, Repr, Inhabited

/-- `AtomicBookCommit`. -/
structure AtomicBookCommit where
  state : BookState
  protocol : BookProtocolState
  result : BookCommandResult
  intent : Option BookCommitIntent
  committedAt : Option Instant
  deriving DecidableEq, Repr, Inhabited

/-- `Evaluation` (not exported by the TypeScript): the two dispositions, `ready` with the intent to
commit and `finished` with the result and, optionally, the result to retain. -/
inductive Evaluation where
  | ready (intent : BookCommitIntent)
  | finished (result : BookCommandResult) (retained : Option RetainedCommandResult)
  deriving DecidableEq, Repr, Inhabited

/-- `evaluation.disposition`: the string literal of the evaluation's case. -/
def Evaluation.disposition : Evaluation → String
  | .ready _ => "ready"
  | .finished _ _ => "finished"

/-! ## Meaning: constructible values of the types this file imports

`Lots.lean` says when a selection's quantities are constructible (`LotSelection.WF`) and nothing
about the identifiers of a selection, a transfer policy or the two identity records; this section
says the rest, in the same terms. -/

/-- A selection whose named holdings have valid identifiers. -/
def LotSelection.IdentifiersWF : LotSelection → Prop
  | .specificIdentification allocations => ∀ item ∈ allocations, item.holdingId.WF
  | _ => True

/-- A transfer policy whose identifiers are valid. -/
structure TransferPolicy.WF (policy : TransferPolicy) : Prop where
  id : policy.id.WF
  bookId : policy.bookId.WF
  sourceAccountId : policy.sourceAccountId.WF
  destinationAccountId : policy.destinationAccountId.WF

/-- An allocation identity whose identifiers are valid. -/
structure LotAllocationIdentity.WF (identity : LotAllocationIdentity) : Prop where
  holdingId : identity.holdingId.WF
  allocationId : identity.allocationId.WF

/-- A destination identity whose identifiers are valid. -/
structure DestinationHoldingIdentity.WF (identity : DestinationHoldingIdentity) : Prop where
  sourceHoldingId : identity.sourceHoldingId.WF
  destinationHoldingId : identity.destinationHoldingId.WF

/-! ## Meaning: constructible lot operations and effects

A lot, holding or allocation inside a record is constructible when both its `WF` (its numbers) and
its `IdentifiersWF` hold, as in `InventoryOwnership/Types.lean`. -/

/-- A constructible booked allocation. -/
structure BookedLotAllocation.WF (booked : BookedLotAllocation) : Prop where
  allocation : booked.allocation.WF
  allocationIdentifiers : booked.allocation.IdentifiersWF
  journalPostingId : booked.journalPostingId.WF

/-- A constructible acquisition. -/
structure LotAcquireOperation.WF (operation : LotAcquireOperation) : Prop where
  lot : operation.lot.WF
  lotIdentifiers : operation.lot.IdentifiersWF
  holding : operation.holding.WF
  holdingIdentifiers : operation.holding.IdentifiersWF
  journalPostingId : operation.journalPostingId.WF

/-- A constructible disposal. -/
structure LotDisposeOperation.WF (operation : LotDisposeOperation) : Prop where
  holdingIds : ∀ id ∈ operation.holdingIds, id.WF
  requestedQuantity : operation.requestedQuantity.WF
  selection : operation.selection.WF
  selectionIdentifiers : operation.selection.IdentifiersWF
  derivation : operation.derivation.WF
  identities : ∀ identity ∈ operation.identities, identity.WF
  journalPostingId : operation.journalPostingId.WF

/-- A constructible transfer. -/
structure LotTransferOperation.WF (operation : LotTransferOperation) : Prop where
  sourceHoldingIds : ∀ id ∈ operation.sourceHoldingIds, id.WF
  destinationAccountId : operation.destinationAccountId.WF
  requestedQuantity : operation.requestedQuantity.WF
  selection : operation.selection.WF
  selectionIdentifiers : operation.selection.IdentifiersWF
  policies : ∀ policy ∈ operation.policies, policy.WF
  derivation : operation.derivation.WF
  allocationIdentities : ∀ identity ∈ operation.allocationIdentities, identity.WF
  destinationIdentities : ∀ identity ∈ operation.destinationIdentities, identity.WF
  sourcePostingId : operation.sourcePostingId.WF
  destinationPostingId : operation.destinationPostingId.WF

/-- A constructible lot operation: the record of its case is. -/
def LotOperation.WF : LotOperation → Prop
  | .acquire operation => operation.WF
  | .dispose operation => operation.WF
  | .transfer operation => operation.WF

/-- A constructible lot state effect. -/
structure LotStateEffect.WF (effect : LotStateEffect) : Prop where
  lots : ∀ lot ∈ effect.lots, lot.WF ∧ lot.IdentifiersWF
  holdings : ∀ holding ∈ effect.holdings, holding.WF ∧ holding.IdentifiersWF
  allocations : ∀ booked ∈ effect.allocations, booked.WF

/-- A constructible lot changes effect. -/
structure LotChangesEffect.WF (effect : LotChangesEffect) : Prop where
  lots : ∀ lot ∈ effect.lots, lot.WF ∧ lot.IdentifiersWF
  holdings : ∀ holding ∈ effect.holdings, holding.WF ∧ holding.IdentifiersWF

/-- Constructible lots and holdings after changes. -/
structure AppliedLotChanges.WF (applied : AppliedLotChanges) : Prop where
  lots : ∀ lot ∈ applied.lots, lot.WF ∧ lot.IdentifiersWF
  holdings : ∀ holding ∈ applied.holdings, holding.WF ∧ holding.IdentifiersWF

/-- A constructible close package. -/
structure ClosePackage.WF (closePackage : ClosePackage) : Prop where
  id : closePackage.id.WF
  periodId : closePackage.periodId.WF
  configurationSnapshot : closePackage.configurationSnapshot.WF

/-- A period transition whose identifiers are valid. -/
structure PeriodTransition.WF (transition : PeriodTransition) : Prop where
  periodId : transition.periodId.WF
  supersededCloseIds : ∀ id ∈ transition.supersededCloseIds, id.WF

/-- A constructible activation effect. -/
structure BookActivationEffect.WF (effect : BookActivationEffect) : Prop where
  boundary : effect.boundary.WF
  configurationSnapshot : effect.configurationSnapshot.WF

/-- A constructible configuration effect. -/
structure BookConfigurationEffect.WF (effect : BookConfigurationEffect) : Prop where
  periods : ∀ period ∈ effect.periods, period.WF
  admissionSnapshot : effect.admissionSnapshot.WF
  policies : ∀ policy ∈ effect.policies, policy.WF
  quantizationPolicies : ∀ policy ∈ effect.quantizationPolicies, policy.WF
  accountingPolicySnapshot : effect.accountingPolicySnapshot.WF
  previousConfigurationSnapshot : effect.previousConfigurationSnapshot.WF
  resultingConfigurationSnapshot : effect.resultingConfigurationSnapshot.WF

/-- A constructible book effect: the record of its case is. A correction link holds no exact
number and no identifier (its journal identifiers are plain strings). -/
def BookEffect.WF : BookEffect → Prop
  | .activation effect => effect.WF
  | .configuration effect => effect.WF
  | .journal booked => booked.WF
  | .lotState effect => effect.WF
  | .lotChanges changes => changes.WF
  | .inventoryOwnership value => value.WF
  | .correction _ => True
  | .periodTransition transition => transition.WF
  | .closePackage package => package.WF
  | .accounting effect => effect.WF

/-! ## Meaning: constructible commands -/

/-- The fields every command carries, with valid identifiers. -/
structure CommandCore.WF (core : CommandCore) : Prop where
  id : core.id.WF
  bookId : core.bookId.WF
  actorId : core.actorId.WF

/-- A constructible activation command. -/
structure ActivateBookCommand.WF (command : ActivateBookCommand) : Prop where
  core : command.toCommandCore.WF
  boundaryId : command.boundaryId.WF
  opening : ∀ transaction, command.opening = some transaction → transaction.WF
  lotOperations : ∀ operations, command.lotOperations = some operations →
    ∀ operation ∈ operations, operation.WF

/-- A constructible posting command. -/
structure PostJournalCommand.WF (command : PostJournalCommand) : Prop where
  core : command.toCommandCore.WF
  resolved : command.resolved.WF
  fiscalPeriodId : ∀ id, command.fiscalPeriodId = some id → id.WF
  lotOperations : ∀ operations, command.lotOperations = some operations →
    ∀ operation ∈ operations, operation.WF

/-- A constructible correction command. -/
structure CorrectJournalCommand.WF (command : CorrectJournalCommand) : Prop where
  core : command.toCommandCore.WF
  resolved : command.resolved.WF
  fiscalPeriodId : ∀ id, command.fiscalPeriodId = some id → id.WF
  lotOperations : ∀ operations, command.lotOperations = some operations →
    ∀ operation ∈ operations, operation.WF

/-- A constructible close command. -/
structure ClosePeriodCommand.WF (command : ClosePeriodCommand) : Prop where
  core : command.toCommandCore.WF
  periodId : command.periodId.WF
  closePackageId : command.closePackageId.WF
  closing : ∀ transaction, command.closing = some transaction → transaction.WF

/-- A constructible reopen command. -/
structure ReopenPeriodCommand.WF (command : ReopenPeriodCommand) : Prop where
  core : command.toCommandCore.WF
  periodId : command.periodId.WF
  reversal : ∀ transaction, command.reversal = some transaction → transaction.WF

/-- A constructible configuration command. -/
structure ReplaceConfigurationCommand.WF (command : ReplaceConfigurationCommand) : Prop where
  core : command.toCommandCore.WF
  periods : ∀ period ∈ command.periods, period.WF
  admissionSnapshot : command.admissionSnapshot.WF
  policies : ∀ policy ∈ command.policies, policy.WF
  quantizationPolicies : ∀ policy ∈ command.quantizationPolicies, policy.WF
  accountingPolicies : ∀ policy ∈ command.accountingPolicies, policy.WF
  executionProfileAdoption : ∀ adoption, command.executionProfileAdoption = some adoption →
    adoption.WF

/-- A dimension selection whose member identifiers are valid. Its `effectKey` is a plain
string. -/
structure GeneratedPostingDimensionSelection.WF (selection : GeneratedPostingDimensionSelection) :
    Prop where
  dimensionMemberIds : ∀ id ∈ selection.dimensionMemberIds, id.WF

/-- The fields every command that generates accounting carries, constructible. -/
structure GeneratedAccountingCommandCore.WF (generated : GeneratedAccountingCommandCore) :
    Prop where
  core : generated.toCommandCore.WF
  fiscalPeriodId : ∀ id, generated.fiscalPeriodId = some id → id.WF
  generatedPostingDimensionSelections :
    ∀ selections, generated.generatedPostingDimensionSelections = some selections →
      ∀ selection ∈ selections, selection.WF

/-- A constructible inventory command. -/
structure PostInventoryTransactionCommand.WF (command : PostInventoryTransactionCommand) :
    Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF
  inventoryAccountId : command.inventoryAccountId.WF
  costAccountId : command.costAccountId.WF
  inventoryCommodityId : command.inventoryCommodityId.WF
  provisionalLayerId : ∀ id, command.provisionalLayerId = some id → id.WF
  derivation : command.derivation.WF
  lotOperations : ∀ operations, command.lotOperations = some operations →
    ∀ operation ∈ operations, operation.WF

/-- A constructible owned-inventory command. -/
structure PostOwnedInventoryTransactionCommand.WF (command : PostOwnedInventoryTransactionCommand) :
    Prop where
  core : command.toCommandCore.WF
  request : command.request.WF

/-- A constructible recosting command. -/
structure RecostProvisionalInventoryCommand.WF (command : RecostProvisionalInventoryCommand) :
    Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF
  inventoryAccountId : command.inventoryAccountId.WF
  adjustmentAccountId : command.adjustmentAccountId.WF

/-- A constructible value adjustment command. -/
structure AdjustInventoryValueCommand.WF (command : AdjustInventoryValueCommand) : Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF

/-- A constructible open item command. -/
structure RecognizeOpenItemCommand.WF (command : RecognizeOpenItemCommand) : Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF
  resolved : command.resolved.WF

/-- A constructible settlement command. -/
structure ApplySettlementCommand.WF (command : ApplySettlementCommand) : Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF
  resolved : ∀ transaction ∈ command.resolved, transaction.WF

/-- A constructible remeasurement command. -/
structure PostCurrencyRemeasurementCommand.WF (command : PostCurrencyRemeasurementCommand) :
    Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF

/-- A constructible schedule creation command. -/
structure CreateAllocationScheduleCommand.WF (command : CreateAllocationScheduleCommand) :
    Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF

/-- A constructible scheduled recognition command. -/
structure RecognizeScheduledAllocationCommand.WF (command : RecognizeScheduledAllocationCommand) :
    Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF

/-- A constructible schedule revision command. -/
structure ReviseAllocationScheduleCommand.WF (command : ReviseAllocationScheduleCommand) :
    Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF
  disposalJournal : ∀ transaction, command.disposalJournal = some transaction → transaction.WF

/-- A constructible taxed posting command. -/
structure PostTaxedTransactionCommand.WF (command : PostTaxedTransactionCommand) : Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF

/-- A constructible consolidation command. -/
structure CompileConsolidationCommand.WF (command : CompileConsolidationCommand) : Prop where
  generated : command.toGeneratedAccountingCommandCore.WF
  request : command.request.WF

/-- A constructible command: the command of its type is. -/
def UnsealedBookCommand.WF : UnsealedBookCommand → Prop
  | .activateBook command => command.WF
  | .postJournal command => command.WF
  | .correctJournal command => command.WF
  | .closePeriod command => command.WF
  | .reopenPeriod command => command.WF
  | .replaceConfiguration command => command.WF
  | .postInventoryTransaction command => command.WF
  | .postOwnedInventoryTransaction command => command.WF
  | .recostProvisionalInventory command => command.WF
  | .adjustInventoryValue command => command.WF
  | .recognizeOpenItem command => command.WF
  | .applySettlement command => command.WF
  | .postCurrencyRemeasurement command => command.WF
  | .createAllocationSchedule command => command.WF
  | .recognizeScheduledAllocation command => command.WF
  | .reviseAllocationSchedule command => command.WF
  | .postTaxedTransaction command => command.WF
  | .compileConsolidation command => command.WF

/-- A constructible sealed command: the command is; `inputHash` is a content hash, which `WF` does
not constrain. -/
def BookCommand.WF (command : BookCommand) : Prop := command.toUnsealedBookCommand.WF

/-! ## Meaning: constructible revisions, states and protocol records -/

/-- A constructible revision: its book identifier valid, its command and every effect
constructible. -/
structure RevisionRecord.WF (revision : RevisionRecord) : Prop where
  bookId : revision.bookId.WF
  command : revision.command.WF
  effects : ∀ effect ∈ revision.effects, effect.WF

/-- The body of a constructible state. Its correction links hold no exact number and no
identifier. -/
structure BookStateBody.WF (state : BookStateBody) : Prop where
  identity : state.identity.WF
  configurationSnapshots : ∀ snapshot ∈ state.configurationSnapshots, snapshot.WF
  activeConfigurationSnapshot : state.activeConfigurationSnapshot.WF
  openingBoundary : ∀ boundary, state.openingBoundary = some boundary → boundary.WF
  periods : ∀ period ∈ state.periods, period.WF
  admissionSnapshot : state.admissionSnapshot.WF
  policies : ∀ policy ∈ state.policies, policy.WF
  quantizationPolicies : ∀ policy ∈ state.quantizationPolicies, policy.WF
  accountingPolicySnapshot : state.accountingPolicySnapshot.WF
  accountingState : state.accountingState.WF
  lots : ∀ lot ∈ state.lots, lot.WF ∧ lot.IdentifiersWF
  lotHoldings : ∀ holding ∈ state.lotHoldings, holding.WF ∧ holding.IdentifiersWF
  lotAllocations : ∀ booked ∈ state.lotAllocations, booked.WF
  inventoryOwnershipEffects : ∀ effects, state.inventoryOwnershipEffects = some effects →
    ∀ effect ∈ effects, effect.WF
  journals : ∀ booked ∈ state.journals, booked.WF
  periodTransitions : ∀ transition ∈ state.periodTransitions, transition.WF
  closePackages : ∀ package ∈ state.closePackages, package.WF
  revisions : ∀ revision ∈ state.revisions, revision.WF

/-- A constructible state: its body is. -/
def BookState.WF (state : BookState) : Prop := state.toBookStateBody.WF

/-- A constructible intent: its command and every effect are. -/
structure BookCommitIntent.WF (intent : BookCommitIntent) : Prop where
  command : intent.command.WF
  effects : ∀ effect ∈ intent.effects, effect.WF

/-- A constructible retained result. Its diagnostics hold no exact number and no identifier. -/
structure RetainedCommandResult.WF (retained : RetainedCommandResult) : Prop where
  command : retained.command.WF
  commandId : retained.commandId.WF

/-- A protocol state every retained result of which is constructible. -/
structure BookProtocolState.WF (protocol : BookProtocolState) : Prop where
  retainedResults : ∀ retained ∈ protocol.retainedResults, retained.WF

/-- A constructible atomic commit: its state, protocol state and intent are. A `BookCommandResult`
holds no exact number and no identifier, so it has no `WF`. -/
structure AtomicBookCommit.WF (commit : AtomicBookCommit) : Prop where
  state : commit.state.WF
  protocol : commit.protocol.WF
  intent : ∀ intent, commit.intent = some intent → intent.WF

/-- A constructible evaluation: the intent of a ready one is; the retained result of a finished
one, when there is one, is. -/
def Evaluation.WF : Evaluation → Prop
  | .ready intent => intent.WF
  | .finished _ retained => ∀ value, retained = some value → value.WF

/-! ## Meaning: journals that journal admission admitted

What the theorem that every booked journal balances (`Book/Theorems.lean`) is proved through: each
module that produces effects proves `AllJournalsAdmitted` of what it produces, and
`admitted_journal_balances` (`Journal/Admission.lean`) turns an admitted journal into a balanced
one. -/

/-- A booked journal that journal admission admitted, under some admission snapshot, with the
canonical hash the record carries. -/
def JournalAdmitted (booked : BookedJournal) : Prop :=
  ∃ snapshot, admitJournal snapshot booked.journal = .ok (.admitted booked.canonicalHash)

/-- Every `journal` effect of the list carries a journal that journal admission admitted. -/
def AllJournalsAdmitted (effects : List BookEffect) : Prop :=
  ∀ effect ∈ effects, ∀ booked, effect = .journal booked → JournalAdmitted booked

/-- Every journal a book holds was admitted by journal admission. -/
def BookState.AllJournalsAdmitted (state : BookState) : Prop :=
  ∀ booked ∈ state.journals, JournalAdmitted booked

/-- No effects carry no unadmitted journal. -/
theorem AllJournalsAdmitted.nil : AllJournalsAdmitted [] := by
  intro effect h
  simp at h

/-- Two lists of effects carry only admitted journals exactly when each does. -/
theorem allJournalsAdmitted_append (left right : List BookEffect) :
    AllJournalsAdmitted (left ++ right) ↔ AllJournalsAdmitted left ∧ AllJournalsAdmitted right := by
  unfold AllJournalsAdmitted
  constructor
  · intro h
    exact ⟨fun effect he => h effect (List.mem_append_left right he),
      fun effect he => h effect (List.mem_append_right left he)⟩
  · rintro ⟨hl, hr⟩ effect he
    rcases List.mem_append.mp he with he | he
    · exact hl effect he
    · exact hr effect he

/-- An effect that is not a journal adds no journal to check. -/
theorem allJournalsAdmitted_cons (effect : BookEffect) (rest : List BookEffect) :
    AllJournalsAdmitted (effect :: rest) ↔
      (∀ booked, effect = .journal booked → JournalAdmitted booked) ∧ AllJournalsAdmitted rest := by
  unfold AllJournalsAdmitted
  constructor
  · intro h
    exact ⟨h effect List.mem_cons_self, fun other ho => h other (List.mem_cons_of_mem _ ho)⟩
  · rintro ⟨hhead, hrest⟩ other ho
    rcases List.mem_cons.mp ho with rfl | ho
    · exact hhead
    · exact hrest other ho

end Rastrata.Kernel

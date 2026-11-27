/-
The vocabulary of inventory ownership: the Lean model of the types of
`packages/kernel/src/inventory-ownership.ts` (lines 10 to 107, 236 to 360, 544 to 576, 776 to 800,
876 to 935, 1002 to 1135 and 1445 to 1455), with the one function of the file that needs nothing
but the types, `isInventoryPostedReductionMovement` (line 1493).

The types are written as in `Accounting/Types.lean`:

- An `interface` is a `structure` with the same field names in the same order; an interface that
  `extends` another is a structure that `extends` the other. An optional field is an `Option`, a
  `readonly T[]` a `List T`, a `bigint` an `Int`.
- A union of string literals is an inductive with one constructor each, spelled as the literal,
  with `text` giving the literal back. A union written inline has no name in the TypeScript; it
  gets one here, and its doc comment says which field it is the type of.
- A discriminated union is one inductive with one constructor a case; a field whose type is one
  literal (`monetaryKind: "journalLinked"`, `kind: "acquisition"`, `disposition: "rejected"`) is
  the constructor that holds the record, not a field of it, and a function gives its string where
  the TypeScript reads it.
- `Omit<T, "contentHash">`, the type of what a hash covers, is a structure `TBody`, and `T` extends
  it with `contentHash`; `contentHash` therefore comes last here wherever the TypeScript writes it
  earlier. The order of fields is not seen by any hash: `canonicalize` sorts the keys
  (`canonical.ts` line 238).
- A branded string is a structure around a `String` (`Identifier Kind`). The TypeScript writes
  `Identifier<"InventoryPostedAnchor">` and `Identifier<"InventoryPostedMovement">` inline; they are
  named `InventoryPostedAnchorId` and `InventoryPostedMovementId` here. `Identifier<"BookCommand">`
  and `Identifier<"FiscalPeriod">` are `CommandId` and `FiscalPeriodId` of `Book/BaseTypes.lean`,
  the same types.
- `CumulativePostedShare` of the TypeScript, which carries its full `QuantizationPolicy`, is
  `PolicyCumulativePostedShare` of `QuantizationBalanced.lean`.

Meaning: for every record that holds an exact number or an identifier, `WF` says that each exact
number in it is constructible and each identifier is valid, through every field, option and list,
as in `Accounting/Types.lean`; like there, it says nothing about effect keys, content hashes,
versions, dates or plain strings, which the kernel checks itself, and a law that needs one adds it
as its own hypothesis. `PolicyCumulativePostedShare.WF`, `Lot.WF` and the `IdentifiersWF` of `Lot`,
`LotHolding` and `LotAllocation` (whose `WF` in `Lots.lean` is about their numbers only) are defined
here because no earlier file defines them; a holding, lot or allocation inside a record of this
file is constructible when both its `WF` and its `IdentifiersWF` hold, as `BookedJournal.WF` asks
of its journal.

What the TypeScript type says and the Lean type cannot:

- An optional property may be absent or present with the value `undefined`, and the TypeScript tells
  the two apart: `Object.hasOwn(anchor, "postedValue")` (line 128) and
  `Object.hasOwn(movement, "posting")` (lines 1514 and 1538). `Option` has one `none`; here it is
  the absent property. A JavaScript object may also carry properties its type does not name, which
  `canonicalize` hashes; a Lean structure has exactly its fields.
- An interface that `extends` another and narrows a field cannot be a Lean structure that extends
  it: `InventoryPostedAnchorReference`, `InventoryPostedPositionReference` and
  `InventoryPostedMovementReference` (narrowed `id`) and `InventoryReductionOwnershipEffect`
  (narrowed movements and `newAnchors: readonly []`) write their fields again, with a
  `to…` function for the widening. `readonly []` is a list with `Typed` saying it is empty.
- A field whose type is one literal cannot hold another value, so these run-time tests always pass
  here: `algorithm` (lines 153 and 1474), the reduction `kind` (lines 476, 1226 and 1500), the
  acquisition `kind` (line 1522), the `monetaryKind` of a movement in a list typed by it (lines
  1515, 1540, 1573, 1574, 1659 and 1660), and the `default` of `validateInventoryOwnershipArtifact`
  (line 1675).
- `InventoryOwnershipReadContext` is an object of methods that may keep state and throw. Here it
  is a structure of pure functions, each read `Except` an error: two calls with the same argument
  answer the same, and `bookId` and `bookRevision` cannot change between calls.

Left to the later files of the module plan, because they need hashing, `canonicalAccountingValue`
or the checks of the kernel: `reject`, `fullHash`, `referenceValid`, `precedes`,
`postedAnchorVersionValid`, `hashInventoryPostedAnchor`, `hashInventoryPostedPosition`,
`prepareInventoryPostedReduction`, `hashInventoryPostedReductionMovement`,
`hashInventoryPostedAcquisitionMovement`, `prepareInventoryPostedAcquisitionGroup` and
`prepareInventoryPostedReductionGroup` (`InventoryOwnership/Reduction.lean`);
`prepareInventoryPostedTransferGroup` and `prepareInventoryPostedAdoptionGroup` (`…/Transfer.lean`);
`hashInventoryReductionOwnershipEffect`, `hashInventoryOwnershipEffect`,
`resolveInventoryOwnershipSources`, `prepareInventoryOwnershipSelection` and the four
`prepareInventory…Effect…` functions (`…/Effects.lean`); `sameOwnershipValue`, the `ownership…Valid`
predicates and `validateInventoryOwnershipArtifact` (`…/Validation.lean`). The result types those
functions write inline (`{ disposition: "prepared"; group: … } | OwnershipRejection` and the like)
belong with them; only `ReductionResult` (line 107) has a name and is here.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Journal.Admission
import Rastrata.Kernel.Policy.Types
import Rastrata.Kernel.Policy
import Rastrata.Kernel.Quantization
import Rastrata.Kernel.QuantizationBalanced
import Rastrata.Kernel.Lots
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Book.BaseTypes
import Rastrata.Kernel.InventoryPostedValues

namespace Rastrata.Kernel

/-! ## Identifiers and literal types -/

/-- `Identifier<"InventoryPostedAnchor">`, written inline in the TypeScript (and as
`InventoryPostedAnchor["id"]`). -/
abbrev InventoryPostedAnchorId := Identifier "InventoryPostedAnchor"

/-- `Identifier<"InventoryPostedMovement">`, written inline in the TypeScript (and as
`InventoryPostedPosition["originMovementId"]`). -/
abbrev InventoryPostedMovementId := Identifier "InventoryPostedMovement"

/-- The literal `"cumulativePostedInventoryV1"`: the type of `InventoryPostedAnchor.algorithm`. -/
inductive InventoryPostedAnchorAlgorithm where
  | cumulativePostedInventoryV1
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryPostedAnchorAlgorithm`. -/
def InventoryPostedAnchorAlgorithm.text : InventoryPostedAnchorAlgorithm → String
  | .cumulativePostedInventoryV1 => "cumulativePostedInventoryV1"

/-- `"journalLinked" | "quantityOnly"`: the type of `InventoryPostedReduction.monetaryKind`, and the
discriminant of the reduction and acquisition movements. -/
inductive InventoryPostedMonetaryKind where
  | journalLinked
  | quantityOnly
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryPostedMonetaryKind`. -/
def InventoryPostedMonetaryKind.text : InventoryPostedMonetaryKind → String
  | .journalLinked => "journalLinked"
  | .quantityOnly => "quantityOnly"

/-- `"disposal" | "transferOut"`: the type of `InventoryPostedReductionMovementBody.kind` and
`InventoryPostedReductionGroupContext.kind` (so of `InventoryReductionOperation.kind`). -/
inductive InventoryPostedReductionKind where
  | disposal
  | transferOut
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryPostedReductionKind`. -/
def InventoryPostedReductionKind.text : InventoryPostedReductionKind → String
  | .disposal => "disposal"
  | .transferOut => "transferOut"

/-- `"acquisition" | "transferIn" | "legacyAdoption"`: the type of
`InventoryPostedAcquisitionMovementBody.kind`. -/
inductive InventoryPostedAcquisitionKind where
  | acquisition
  | transferIn
  | legacyAdoption
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryPostedAcquisitionKind`. -/
def InventoryPostedAcquisitionKind.text : InventoryPostedAcquisitionKind → String
  | .acquisition => "acquisition"
  | .transferIn => "transferIn"
  | .legacyAdoption => "legacyAdoption"

/-! ## Coordinates and references (`inventory-ownership.ts` lines 10 to 37) -/

/-- `InventoryPostedCoordinate`. -/
structure InventoryPostedCoordinate where
  bookId : BookId
  holdingId : LotHoldingId
  lotId : LotId
  accountId : AccountId
  unitsCommodityId : CommodityId
  functionalCommodityId : CommodityId
  dimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedArtifactReference`. Its `id` is a plain string. No field of any type of this
file has this type: it is the parameter type of `referenceValid` (line 119), which the three
references below are passed to through their `toInventoryPostedArtifactReference`. -/
structure InventoryPostedArtifactReference where
  id : String
  contentHash : ContentHash
  bookId : BookId
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAnchorReference`, which extends `InventoryPostedArtifactReference` and narrows
its `id` to an anchor identifier. A Lean structure cannot narrow the type of a field it extends, so
the fields are written again with the narrowed `id`, and
`toInventoryPostedArtifactReference` is the widening the TypeScript does silently. -/
structure InventoryPostedAnchorReference where
  id : InventoryPostedAnchorId
  contentHash : ContentHash
  bookId : BookId
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedPositionReference`: the fields of `InventoryPostedArtifactReference`, `id`
narrowed to a holding identifier (see `InventoryPostedAnchorReference`). -/
structure InventoryPostedPositionReference where
  id : LotHoldingId
  contentHash : ContentHash
  bookId : BookId
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedMovementReference`: the fields of `InventoryPostedArtifactReference`, `id`
narrowed to a movement identifier (see `InventoryPostedAnchorReference`). -/
structure InventoryPostedMovementReference where
  id : InventoryPostedMovementId
  contentHash : ContentHash
  bookId : BookId
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- An anchor reference as an `InventoryPostedArtifactReference`: the same fields, the identifier
as its string. -/
def InventoryPostedAnchorReference.toInventoryPostedArtifactReference
    (reference : InventoryPostedAnchorReference) : InventoryPostedArtifactReference :=
  { id := reference.id.value, contentHash := reference.contentHash, bookId := reference.bookId,
    effectKey := reference.effectKey, artifactOrdinal := reference.artifactOrdinal,
    bookRevision := reference.bookRevision }

/-- A position reference as an `InventoryPostedArtifactReference`. -/
def InventoryPostedPositionReference.toInventoryPostedArtifactReference
    (reference : InventoryPostedPositionReference) : InventoryPostedArtifactReference :=
  { id := reference.id.value, contentHash := reference.contentHash, bookId := reference.bookId,
    effectKey := reference.effectKey, artifactOrdinal := reference.artifactOrdinal,
    bookRevision := reference.bookRevision }

/-- A movement reference as an `InventoryPostedArtifactReference`. -/
def InventoryPostedMovementReference.toInventoryPostedArtifactReference
    (reference : InventoryPostedMovementReference) : InventoryPostedArtifactReference :=
  { id := reference.id.value, contentHash := reference.contentHash, bookId := reference.bookId,
    effectKey := reference.effectKey, artifactOrdinal := reference.artifactOrdinal,
    bookRevision := reference.bookRevision }

/-! ## Positions and origins (`inventory-ownership.ts` lines 55 and 63 to 80) -/

/-- The type of `InventoryPostedAnchor.inventoryPolicy`, unnamed in the TypeScript, which writes it
again as `InventoryPostedAnchor["inventoryPolicy"]`. -/
structure InventoryPostedAnchorPolicy where
  policyId : PolicyId
  policyVersion : SemanticVersion
  policyContentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<InventoryPostedPosition, "contentHash">` (line 87): what the content hash of a position
covers. -/
structure InventoryPostedPositionBody where
  holdingId : LotHoldingId
  consumedQuantity : ExactRational
  consumedPosted : ExactDecimal
  anchor : InventoryPostedAnchorReference
  originMovementId : InventoryPostedMovementId
  originEffectKey : EffectKey
  originArtifactOrdinal : Int
  originBookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedPosition`. The TypeScript writes `contentHash` fourth. -/
structure InventoryPostedPosition extends InventoryPostedPositionBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-! ## Anchors and reductions (`inventory-ownership.ts` lines 39 to 61 and 92 to 107) -/

/-- `Omit<InventoryPostedAnchor, "contentHash">` (line 82): what the content hash of an anchor
covers. -/
structure InventoryPostedAnchorBody where
  id : InventoryPostedAnchorId
  algorithm : InventoryPostedAnchorAlgorithm
  algorithmVersion : SemanticVersion
  quantity : ExactRational
  postedBudget : ExactDecimal
  /-- Explicit 1.1.0 component-bearing artifacts only; absent in old bytes. -/
  postedValue : Option InventoryPostedValueBudget
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  coordinate : InventoryPostedCoordinate
  inventoryPolicy : InventoryPostedAnchorPolicy
  quantizationPolicy : QuantizationPolicy
  predecessorPosition : Option InventoryPostedPositionReference
  sourcePostings : List CanonicalPostingReference
  incomingMovements : List InventoryPostedMovementReference
  evidence : List SourceEvidence
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAnchor`: a supplied historical artifact, not authority to create or adopt an
anchor. The TypeScript writes `contentHash` after `bookRevision`. Its test that `algorithm` is
`"cumulativePostedInventoryV1"` (lines 153 and 1474) always passes for a value of
`InventoryPostedAnchorAlgorithm`. -/
structure InventoryPostedAnchor extends InventoryPostedAnchorBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedReductionOrigin`. -/
structure InventoryPostedReductionOrigin where
  movementId : InventoryPostedMovementId
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- `OwnershipRejection` (line 106, not exported): `{ disposition: "rejected"; diagnostics }`. Its
`disposition` has one value; it is the constructor `rejected` of every result that can be a
rejection. -/
structure OwnershipRejection where
  diagnostics : List SemanticDiagnostic
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedReduction`: a classification for later command assembly, not an admitted
movement or effect. -/
structure InventoryPostedReduction where
  monetaryKind : InventoryPostedMonetaryKind
  postedAmount : ExactDecimal
  beforePosition : InventoryPostedPositionReference
  afterPosition : InventoryPostedPosition
  afterHolding : LotHolding
  allocation : LotAllocation
  reductionProof : PolicyCumulativePostedShare
  /-- Positive posted reduction less positive exact economic carrying allocation. -/
  postedMinusEconomic : ExactRational
  postedValue : Option InventoryPostedValueAllocation
  deriving DecidableEq, Repr, Inhabited

/-- `ReductionResult` (line 107, not exported): the two dispositions, `prepared` and `rejected`. -/
inductive ReductionResult where
  | prepared (reduction : InventoryPostedReduction)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

/-! ## Journal sources and group contexts (`inventory-ownership.ts` lines 281 to 299 and 1002) -/

/-- `InventoryReductionJournalSource`. `effectKey` is a plain string, not an `EffectKey`. -/
structure InventoryReductionJournalSource where
  journal : JournalTransaction
  commandId : CommandId
  effectKey : String
  bookRevision : Int
  fiscalPeriodId : FiscalPeriodId
  canonicalHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The type of the third parameter of `prepareInventoryPostedReductionGroup` (line 465), unnamed in
the TypeScript: an actual posting of a journal source and the identifier of the reference to it.
The third parameter of `prepareInventoryPostedAcquisitionGroup` (line 361) and the two links of
`prepareInventoryPostedTransferGroup` (lines 580 and 581) have this type too, so it is the type of
`InventoryReductionOperation.journalLink`, `InventoryAcquisitionOperation.journalLink` and both
links of `InventoryTransferOperation`. -/
structure InventoryPostedJournalLink where
  source : InventoryReductionJournalSource
  postingId : PostingId
  referenceId : CanonicalPostingReferenceId
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryReductionEffectContext` (line 1002):
`Omit<InventoryPostedReductionGroupContext, "kind" | "firstArtifactOrdinal">`. It comes first here
because the group contexts are built on it. -/
structure InventoryReductionEffectContext where
  bookId : BookId
  commandId : CommandId
  effectKey : EffectKey
  bookRevision : Int
  accountingDate : LocalDate
  fiscalPeriodId : FiscalPeriodId
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<InventoryPostedReductionGroupContext, "kind">`, unnamed in the TypeScript, which
`InventoryPostedAcquisitionContext` extends (line 338): the effect context and the ordinal of the
group's first artifact. -/
structure InventoryPostedGroupContext extends InventoryReductionEffectContext where
  firstArtifactOrdinal : Int
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedReductionGroupContext`. The TypeScript writes `kind` third and
`firstArtifactOrdinal` sixth. Its test that `kind` is one of the two (line 476) always passes for a
value of `InventoryPostedReductionKind`. -/
structure InventoryPostedReductionGroupContext extends InventoryPostedGroupContext where
  kind : InventoryPostedReductionKind
  deriving DecidableEq, Repr, Inhabited

/-! ## Reduction movements (`inventory-ownership.ts` lines 236 to 266)

The union `InventoryPostedReductionMovement` is discriminated by `monetaryKind`: one constructor a
case, each holding its record without the literal field. -/

/-- `InventoryPostedReductionMovementBody` (not exported): what the two cases share. It is also
`Omit<QuantityOnlyInventoryReductionMovement, "contentHash">`, whose other fields are the literal
`monetaryKind` and `posting?: never`. -/
structure InventoryPostedReductionMovementBody where
  id : InventoryPostedMovementId
  kind : InventoryPostedReductionKind
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  accountingDate : LocalDate
  fiscalPeriodId : FiscalPeriodId
  coordinate : InventoryPostedCoordinate
  postedAmount : ExactDecimal
  beforePosition : InventoryPostedPositionReference
  afterPosition : InventoryPostedPosition
  quantityAllocation : LotAllocation
  reductionProof : PolicyCumulativePostedShare
  incomingSources : List InventoryPostedMovementReference
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<JournalLinkedInventoryReductionMovement, "contentHash">` (line 266): the body and the
posting. -/
structure JournalLinkedInventoryReductionMovementBody
    extends InventoryPostedReductionMovementBody where
  posting : CanonicalPostingReference
  deriving DecidableEq, Repr, Inhabited

/-- `JournalLinkedInventoryReductionMovement`; its `monetaryKind` is `"journalLinked"`. -/
structure JournalLinkedInventoryReductionMovement
    extends JournalLinkedInventoryReductionMovementBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `QuantityOnlyInventoryReductionMovement`; its `monetaryKind` is `"quantityOnly"` and it has no
`posting`. -/
structure QuantityOnlyInventoryReductionMovement extends InventoryPostedReductionMovementBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedReductionMovement`: one constructor a `monetaryKind`. -/
inductive InventoryPostedReductionMovement where
  | journalLinked (movement : JournalLinkedInventoryReductionMovement)
  | quantityOnly (movement : QuantityOnlyInventoryReductionMovement)
  deriving DecidableEq, Repr, Inhabited

/-- `MovementHashInput` (line 266, not exported): what the content hash of a reduction movement
covers, one constructor a `monetaryKind`. The TypeScript adds `contentHash?`, which the hash
leaves out (line 269); here a movement is hashed through
`InventoryPostedReductionMovement.hashInput`. -/
inductive MovementHashInput where
  | journalLinked (body : JournalLinkedInventoryReductionMovementBody)
  | quantityOnly (body : InventoryPostedReductionMovementBody)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryPostedReductionMovement

/-- The fields both cases carry. -/
def body : InventoryPostedReductionMovement → InventoryPostedReductionMovementBody
  | .journalLinked movement => movement.toInventoryPostedReductionMovementBody
  | .quantityOnly movement => movement.toInventoryPostedReductionMovementBody

/-- `movement.monetaryKind`; its string is `movement.monetaryKind.text`. -/
def monetaryKind : InventoryPostedReductionMovement → InventoryPostedMonetaryKind
  | .journalLinked _ => .journalLinked
  | .quantityOnly _ => .quantityOnly

/-- `movement.posting`: the posting of a journal-linked movement; a quantity-only movement has
none. -/
def posting : InventoryPostedReductionMovement → Option CanonicalPostingReference
  | .journalLinked movement => some movement.posting
  | .quantityOnly _ => none

/-- `movement.contentHash`. -/
def contentHash : InventoryPostedReductionMovement → ContentHash
  | .journalLinked movement => movement.contentHash
  | .quantityOnly movement => movement.contentHash

/-- The movement without its `contentHash`: what `hashInventoryPostedReductionMovement` covers. -/
def hashInput : InventoryPostedReductionMovement → MovementHashInput
  | .journalLinked movement => .journalLinked movement.toJournalLinkedInventoryReductionMovementBody
  | .quantityOnly movement => .quantityOnly movement.toInventoryPostedReductionMovementBody

/-- `movement.id`. -/
def id (movement : InventoryPostedReductionMovement) : InventoryPostedMovementId := movement.body.id

/-- `movement.kind`. -/
def kind (movement : InventoryPostedReductionMovement) : InventoryPostedReductionKind :=
  movement.body.kind

/-- `movement.effectKey`. -/
def effectKey (movement : InventoryPostedReductionMovement) : EffectKey := movement.body.effectKey

/-- `movement.artifactOrdinal`. -/
def artifactOrdinal (movement : InventoryPostedReductionMovement) : Int :=
  movement.body.artifactOrdinal

/-- `movement.bookRevision`. -/
def bookRevision (movement : InventoryPostedReductionMovement) : Int := movement.body.bookRevision

/-- `movement.accountingDate`. -/
def accountingDate (movement : InventoryPostedReductionMovement) : LocalDate :=
  movement.body.accountingDate

/-- `movement.fiscalPeriodId`. -/
def fiscalPeriodId (movement : InventoryPostedReductionMovement) : FiscalPeriodId :=
  movement.body.fiscalPeriodId

/-- `movement.coordinate`. -/
def coordinate (movement : InventoryPostedReductionMovement) : InventoryPostedCoordinate :=
  movement.body.coordinate

/-- `movement.postedAmount`. -/
def postedAmount (movement : InventoryPostedReductionMovement) : ExactDecimal :=
  movement.body.postedAmount

/-- `movement.beforePosition`. -/
def beforePosition (movement : InventoryPostedReductionMovement) :
    InventoryPostedPositionReference :=
  movement.body.beforePosition

/-- `movement.afterPosition`. -/
def afterPosition (movement : InventoryPostedReductionMovement) : InventoryPostedPosition :=
  movement.body.afterPosition

/-- `movement.quantityAllocation`. -/
def quantityAllocation (movement : InventoryPostedReductionMovement) : LotAllocation :=
  movement.body.quantityAllocation

/-- `movement.reductionProof`. -/
def reductionProof (movement : InventoryPostedReductionMovement) : PolicyCumulativePostedShare :=
  movement.body.reductionProof

/-- `movement.incomingSources`. -/
def incomingSources (movement : InventoryPostedReductionMovement) :
    List InventoryPostedMovementReference :=
  movement.body.incomingSources

end InventoryPostedReductionMovement

/-- `InventoryPostedReductionEntry`. -/
structure InventoryPostedReductionEntry where
  movementId : InventoryPostedMovementId
  anchor : InventoryPostedAnchor
  position : InventoryPostedPosition
  holding : LotHolding
  allocation : LotAllocation
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedReductionSource` (line 901):
`Pick<InventoryPostedReductionEntry, "anchor" | "position" | "holding">`. -/
structure InventoryPostedReductionSource where
  anchor : InventoryPostedAnchor
  position : InventoryPostedPosition
  holding : LotHolding
  deriving DecidableEq, Repr, Inhabited

/-- An entry as an `InventoryPostedReductionSource`: the three fields it picks. -/
def InventoryPostedReductionEntry.toInventoryPostedReductionSource
    (entry : InventoryPostedReductionEntry) : InventoryPostedReductionSource :=
  { anchor := entry.anchor, position := entry.position, holding := entry.holding }

/-- `InventoryPostedReductionGroup`. -/
structure InventoryPostedReductionGroup where
  movements : List InventoryPostedReductionMovement
  afterHoldings : List LotHolding
  postedAmount : ExactRational
  quantity : ExactRational
  historicalBasis : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-! ## Acquisition movements (`inventory-ownership.ts` lines 309 to 327)

`InventoryPostedAcquisitionMovement` is `InventoryPostedAcquisitionMovementBody & (journal-linked |
quantity-only) & { contentHash }`: a union discriminated by `monetaryKind` whose two cases have no
names in the TypeScript. They are named here as the reduction cases are. -/

/-- `InventoryPostedAcquisitionMovementBody` (not exported): what the two cases share. It is also
the quantity-only case without its `contentHash`. -/
structure InventoryPostedAcquisitionMovementBody where
  id : InventoryPostedMovementId
  kind : InventoryPostedAcquisitionKind
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  accountingDate : LocalDate
  fiscalPeriodId : FiscalPeriodId
  coordinate : InventoryPostedCoordinate
  postedAmount : ExactDecimal
  afterPosition : InventoryPostedPosition
  acquisitionProof : PolicyCumulativePostedShare
  incomingSources : List InventoryPostedMovementReference
  deriving DecidableEq, Repr, Inhabited

/-- The journal-linked case of `InventoryPostedAcquisitionMovement` without its `contentHash`: the
body and the posting. -/
structure JournalLinkedInventoryAcquisitionMovementBody
    extends InventoryPostedAcquisitionMovementBody where
  posting : CanonicalPostingReference
  deriving DecidableEq, Repr, Inhabited

/-- The journal-linked case of `InventoryPostedAcquisitionMovement` (line 324); its `monetaryKind`
is `"journalLinked"`. -/
structure JournalLinkedInventoryAcquisitionMovement
    extends JournalLinkedInventoryAcquisitionMovementBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- The quantity-only case of `InventoryPostedAcquisitionMovement` (line 325); its `monetaryKind`
is `"quantityOnly"` and it has no `posting`. -/
structure QuantityOnlyInventoryAcquisitionMovement extends InventoryPostedAcquisitionMovementBody
    where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAcquisitionMovement`: one constructor a `monetaryKind`. -/
inductive InventoryPostedAcquisitionMovement where
  | journalLinked (movement : JournalLinkedInventoryAcquisitionMovement)
  | quantityOnly (movement : QuantityOnlyInventoryAcquisitionMovement)
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<InventoryPostedAcquisitionMovement, "contentHash">` (line 327), one constructor a
`monetaryKind`. The name `…Body` is the TypeScript's own `InventoryPostedAcquisitionMovementBody`.
`Omit` does not distribute over a union, so the TypeScript type of this parameter is one record
whose `monetaryKind` is either literal and whose `posting` is optional in both; every caller passes
one of the two cases, which is what this type admits. -/
inductive InventoryPostedAcquisitionMovementHashInput where
  | journalLinked (body : JournalLinkedInventoryAcquisitionMovementBody)
  | quantityOnly (body : InventoryPostedAcquisitionMovementBody)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryPostedAcquisitionMovement

/-- The fields both cases carry. -/
def body : InventoryPostedAcquisitionMovement → InventoryPostedAcquisitionMovementBody
  | .journalLinked movement => movement.toInventoryPostedAcquisitionMovementBody
  | .quantityOnly movement => movement.toInventoryPostedAcquisitionMovementBody

/-- `movement.monetaryKind`; its string is `movement.monetaryKind.text`. -/
def monetaryKind : InventoryPostedAcquisitionMovement → InventoryPostedMonetaryKind
  | .journalLinked _ => .journalLinked
  | .quantityOnly _ => .quantityOnly

/-- `movement.posting`: the posting of a journal-linked movement; a quantity-only movement has
none. -/
def posting : InventoryPostedAcquisitionMovement → Option CanonicalPostingReference
  | .journalLinked movement => some movement.posting
  | .quantityOnly _ => none

/-- `movement.contentHash`. -/
def contentHash : InventoryPostedAcquisitionMovement → ContentHash
  | .journalLinked movement => movement.contentHash
  | .quantityOnly movement => movement.contentHash

/-- The movement without its `contentHash`: what `hashInventoryPostedAcquisitionMovement`
covers. -/
def hashInput : InventoryPostedAcquisitionMovement → InventoryPostedAcquisitionMovementHashInput
  | .journalLinked movement =>
    .journalLinked movement.toJournalLinkedInventoryAcquisitionMovementBody
  | .quantityOnly movement => .quantityOnly movement.toInventoryPostedAcquisitionMovementBody

/-- `movement.id`. -/
def id (movement : InventoryPostedAcquisitionMovement) : InventoryPostedMovementId :=
  movement.body.id

/-- `movement.kind`. -/
def kind (movement : InventoryPostedAcquisitionMovement) : InventoryPostedAcquisitionKind :=
  movement.body.kind

/-- `movement.effectKey`. -/
def effectKey (movement : InventoryPostedAcquisitionMovement) : EffectKey :=
  movement.body.effectKey

/-- `movement.artifactOrdinal`. -/
def artifactOrdinal (movement : InventoryPostedAcquisitionMovement) : Int :=
  movement.body.artifactOrdinal

/-- `movement.bookRevision`. -/
def bookRevision (movement : InventoryPostedAcquisitionMovement) : Int :=
  movement.body.bookRevision

/-- `movement.accountingDate`. -/
def accountingDate (movement : InventoryPostedAcquisitionMovement) : LocalDate :=
  movement.body.accountingDate

/-- `movement.fiscalPeriodId`. -/
def fiscalPeriodId (movement : InventoryPostedAcquisitionMovement) : FiscalPeriodId :=
  movement.body.fiscalPeriodId

/-- `movement.coordinate`. -/
def coordinate (movement : InventoryPostedAcquisitionMovement) : InventoryPostedCoordinate :=
  movement.body.coordinate

/-- `movement.postedAmount`. -/
def postedAmount (movement : InventoryPostedAcquisitionMovement) : ExactDecimal :=
  movement.body.postedAmount

/-- `movement.afterPosition`. -/
def afterPosition (movement : InventoryPostedAcquisitionMovement) : InventoryPostedPosition :=
  movement.body.afterPosition

/-- `movement.acquisitionProof`. -/
def acquisitionProof (movement : InventoryPostedAcquisitionMovement) :
    PolicyCumulativePostedShare :=
  movement.body.acquisitionProof

/-- `movement.incomingSources`. -/
def incomingSources (movement : InventoryPostedAcquisitionMovement) :
    List InventoryPostedMovementReference :=
  movement.body.incomingSources

end InventoryPostedAcquisitionMovement

/-! ## Entries, contexts and groups of acquisition, adoption and transfer (`inventory-ownership.ts`
lines 331 to 349, 544 to 572, 776 to 795 and 1106 to 1126) -/

/-- `InventoryPostedAcquisitionEntry`. -/
structure InventoryPostedAcquisitionEntry where
  anchorId : InventoryPostedAnchorId
  movementId : InventoryPostedMovementId
  lot : Lot
  holding : LotHolding
  evidence : List SourceEvidence
  deriving DecidableEq, Repr, Inhabited

/-- `Pick<InventoryPostedAcquisitionContext, "inventoryPolicy" | "quantizationPolicy" |
"dimensionMemberIds">`, unnamed in the TypeScript: what an acquisition or an adoption operation
carries of its context (lines 1106 and 1126; the adoption context has the same three fields). -/
structure InventoryPostedAcquisitionTerms where
  inventoryPolicy : InventoryPostedAnchorPolicy
  quantizationPolicy : QuantizationPolicy
  dimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAcquisitionContext`: `Omit<InventoryPostedReductionGroupContext, "kind">` and
the three fields of `InventoryPostedAcquisitionTerms`. -/
structure InventoryPostedAcquisitionContext extends InventoryPostedGroupContext,
    InventoryPostedAcquisitionTerms
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAcquisitionGroup`. -/
structure InventoryPostedAcquisitionGroup where
  anchors : List InventoryPostedAnchor
  movements : List InventoryPostedAcquisitionMovement
  lots : List Lot
  holdings : List LotHolding
  postedAmount : ExactDecimal
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAdoptionEntry`. -/
structure InventoryPostedAdoptionEntry where
  anchorId : InventoryPostedAnchorId
  movementId : InventoryPostedMovementId
  holding : LotHolding
  evidence : List SourceEvidence
  historicalPostings : List CanonicalPostingReference
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAdoptionContext`. The TypeScript declares `firstArtifactOrdinal: bigint` again
(line 785), a field `InventoryPostedAcquisitionContext` already has with the same type; so it adds
nothing here. -/
structure InventoryPostedAdoptionContext extends InventoryPostedAcquisitionContext
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedAdoptionGroup`. -/
structure InventoryPostedAdoptionGroup where
  anchors : List InventoryPostedAnchor
  movements : List InventoryPostedAcquisitionMovement
  holdings : List LotHolding
  positions : List InventoryPostedPosition
  adoptedPostedBalance : ExactDecimal
  adoptedQuantity : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `Pick<InventoryPostedTransferGroupContext, "destinationInventoryPolicy" |
"destinationQuantizationPolicy" | "destinationDimensionMemberIds">`, unnamed in the TypeScript:
what a transfer operation carries of its context (line 1120). -/
structure InventoryPostedTransferDestinationTerms where
  destinationInventoryPolicy : InventoryPostedAnchorPolicy
  destinationQuantizationPolicy : QuantizationPolicy
  destinationDimensionMemberIds : List DimensionMemberId
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedTransferGroupContext`: `InventoryReductionEffectContext`, `firstArtifactOrdinal`
(here through `InventoryPostedGroupContext`, which is exactly those) and the three fields of
`InventoryPostedTransferDestinationTerms`, in the TypeScript's order. -/
structure InventoryPostedTransferGroupContext extends InventoryPostedGroupContext,
    InventoryPostedTransferDestinationTerms
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedTransferEntry`. -/
structure InventoryPostedTransferEntry where
  source : InventoryPostedReductionSource
  allocation : LotAllocation
  transferOutMovementId : InventoryPostedMovementId
  destinationAnchorId : InventoryPostedAnchorId
  destinationMovementId : InventoryPostedMovementId
  destinationHolding : LotHolding
  destinationLot : Lot
  evidence : List SourceEvidence
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedTransferGroup`. -/
structure InventoryPostedTransferGroup where
  transferOutMovements : List InventoryPostedReductionMovement
  destinationAnchors : List InventoryPostedAnchor
  destinationMovements : List InventoryPostedAcquisitionMovement
  destinationLots : List Lot
  destinationHoldings : List LotHolding
  afterSourceHoldings : List LotHolding
  afterSourcePositions : List InventoryPostedPosition
  transferredPostedAmount : ExactDecimal
  transferredQuantity : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryPostedPositionOrigin`. -/
structure InventoryPostedPositionOrigin where
  bookId : BookId
  movementId : InventoryPostedMovementId
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-! ## Movements and effects (`inventory-ownership.ts` lines 876 to 890 and 1493) -/

/-- `InventoryPostedMovement`: a reduction movement or an acquisition movement. The two are told
apart by `kind`, whose values for the two are disjoint (`isInventoryPostedReductionMovement`). -/
inductive InventoryPostedMovement where
  | reduction (movement : InventoryPostedReductionMovement)
  | acquisition (movement : InventoryPostedAcquisitionMovement)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryPostedMovement

/-- `movement.kind`, the string the TypeScript compares. -/
def kind : InventoryPostedMovement → String
  | .reduction movement => movement.kind.text
  | .acquisition movement => movement.kind.text

/-- `movement.monetaryKind`. -/
def monetaryKind : InventoryPostedMovement → InventoryPostedMonetaryKind
  | .reduction movement => movement.monetaryKind
  | .acquisition movement => movement.monetaryKind

/-- `movement.posting`. -/
def posting : InventoryPostedMovement → Option CanonicalPostingReference
  | .reduction movement => movement.posting
  | .acquisition movement => movement.posting

/-- `movement.contentHash`. -/
def contentHash : InventoryPostedMovement → ContentHash
  | .reduction movement => movement.contentHash
  | .acquisition movement => movement.contentHash

/-- `movement.id`. -/
def id : InventoryPostedMovement → InventoryPostedMovementId
  | .reduction movement => movement.id
  | .acquisition movement => movement.id

/-- `movement.effectKey`. -/
def effectKey : InventoryPostedMovement → EffectKey
  | .reduction movement => movement.effectKey
  | .acquisition movement => movement.effectKey

/-- `movement.artifactOrdinal`. -/
def artifactOrdinal : InventoryPostedMovement → Int
  | .reduction movement => movement.artifactOrdinal
  | .acquisition movement => movement.artifactOrdinal

/-- `movement.bookRevision`. -/
def bookRevision : InventoryPostedMovement → Int
  | .reduction movement => movement.bookRevision
  | .acquisition movement => movement.bookRevision

/-- `movement.accountingDate`. -/
def accountingDate : InventoryPostedMovement → LocalDate
  | .reduction movement => movement.accountingDate
  | .acquisition movement => movement.accountingDate

/-- `movement.fiscalPeriodId`. -/
def fiscalPeriodId : InventoryPostedMovement → FiscalPeriodId
  | .reduction movement => movement.fiscalPeriodId
  | .acquisition movement => movement.fiscalPeriodId

/-- `movement.coordinate`. -/
def coordinate : InventoryPostedMovement → InventoryPostedCoordinate
  | .reduction movement => movement.coordinate
  | .acquisition movement => movement.coordinate

/-- `movement.postedAmount`. -/
def postedAmount : InventoryPostedMovement → ExactDecimal
  | .reduction movement => movement.postedAmount
  | .acquisition movement => movement.postedAmount

/-- `movement.afterPosition`. -/
def afterPosition : InventoryPostedMovement → InventoryPostedPosition
  | .reduction movement => movement.afterPosition
  | .acquisition movement => movement.afterPosition

/-- `movement.incomingSources`. -/
def incomingSources : InventoryPostedMovement → List InventoryPostedMovementReference
  | .reduction movement => movement.incomingSources
  | .acquisition movement => movement.incomingSources

end InventoryPostedMovement

/-- `isInventoryPostedReductionMovement` (line 1493): the movement's `kind` is `"disposal"` or
`"transferOut"`. -/
def isInventoryPostedReductionMovement (movement : InventoryPostedMovement) : Bool :=
  movement.kind == "disposal" || movement.kind == "transferOut"

/-- `Extract<InventoryPostedMovement, { readonly monetaryKind: "journalLinked" }>` (line 882): the
journal-linked case of either kind of movement. -/
inductive JournalLinkedInventoryPostedMovement where
  | reduction (movement : JournalLinkedInventoryReductionMovement)
  | acquisition (movement : JournalLinkedInventoryAcquisitionMovement)
  deriving DecidableEq, Repr, Inhabited

/-- `Extract<InventoryPostedMovement, { readonly monetaryKind: "quantityOnly" }>` (line 883): the
quantity-only case of either kind of movement. -/
inductive QuantityOnlyInventoryPostedMovement where
  | reduction (movement : QuantityOnlyInventoryReductionMovement)
  | acquisition (movement : QuantityOnlyInventoryAcquisitionMovement)
  deriving DecidableEq, Repr, Inhabited

/-- A journal-linked movement as an `InventoryPostedMovement`. -/
def JournalLinkedInventoryPostedMovement.toInventoryPostedMovement :
    JournalLinkedInventoryPostedMovement → InventoryPostedMovement
  | .reduction movement => .reduction (.journalLinked movement)
  | .acquisition movement => .acquisition (.journalLinked movement)

/-- A quantity-only movement as an `InventoryPostedMovement`. -/
def QuantityOnlyInventoryPostedMovement.toInventoryPostedMovement :
    QuantityOnlyInventoryPostedMovement → InventoryPostedMovement
  | .reduction movement => .reduction (.quantityOnly movement)
  | .acquisition movement => .acquisition (.quantityOnly movement)

/-- `Omit<InventoryOwnershipEffect, "contentHash">` (line 896): what the content hash of an
effect covers. -/
structure InventoryOwnershipEffectBody where
  effectKey : EffectKey
  bookRevision : Int
  newAnchors : List InventoryPostedAnchor
  journalLinkedMovements : List JournalLinkedInventoryPostedMovement
  quantityOnlyMovements : List QuantityOnlyInventoryPostedMovement
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryOwnershipEffect`. The TypeScript writes `contentHash` third. -/
structure InventoryOwnershipEffect extends InventoryOwnershipEffectBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<InventoryReductionOwnershipEffect, "contentHash">` (line 892). See
`InventoryReductionOwnershipEffect`. -/
structure InventoryReductionOwnershipEffectBody where
  effectKey : EffectKey
  bookRevision : Int
  newAnchors : List InventoryPostedAnchor
  journalLinkedMovements : List JournalLinkedInventoryReductionMovement
  quantityOnlyMovements : List QuantityOnlyInventoryReductionMovement
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryReductionOwnershipEffect`, which extends `InventoryOwnershipEffect` and narrows three
of its fields: the movements to reduction movements and `newAnchors` to `readonly []`, the empty
tuple. A Lean structure cannot narrow a field it extends, so the fields are written again, and
`toInventoryOwnershipEffect` is the widening the TypeScript does silently. `newAnchors` stays a
list: `ownershipReductionEffectValid` tests its length at run time (line 1546), and `Typed` says
what the TypeScript type admits. -/
structure InventoryReductionOwnershipEffect extends InventoryReductionOwnershipEffectBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- What the type `readonly []` of `newAnchors` admits: no anchor. -/
def InventoryReductionOwnershipEffectBody.Typed (body : InventoryReductionOwnershipEffectBody) :
    Prop :=
  body.newAnchors = []

/-- What the type `readonly []` of `newAnchors` admits: no anchor. -/
def InventoryReductionOwnershipEffect.Typed (effect : InventoryReductionOwnershipEffect) : Prop :=
  effect.toInventoryReductionOwnershipEffectBody.Typed

/-- The body of a reduction effect as the body of an ownership effect: each movement as the
journal-linked or quantity-only movement it is. -/
def InventoryReductionOwnershipEffectBody.toInventoryOwnershipEffectBody
    (body : InventoryReductionOwnershipEffectBody) : InventoryOwnershipEffectBody :=
  { effectKey := body.effectKey, bookRevision := body.bookRevision, newAnchors := body.newAnchors,
    journalLinkedMovements := body.journalLinkedMovements.map .reduction,
    quantityOnlyMovements := body.quantityOnlyMovements.map .reduction }

/-- A reduction effect as an ownership effect, with the same content hash. -/
def InventoryReductionOwnershipEffect.toInventoryOwnershipEffect
    (effect : InventoryReductionOwnershipEffect) : InventoryOwnershipEffect :=
  { toInventoryOwnershipEffectBody :=
      effect.toInventoryReductionOwnershipEffectBody.toInventoryOwnershipEffectBody,
    contentHash := effect.contentHash }

/-! ## The read context (`inventory-ownership.ts` lines 910 to 927) -/

/-- What a read of an `InventoryOwnershipReadContext` throws. The TypeScript leaves it to the
storage ("Missing/corrupt storage or invalidation throws"); the model keeps a message. -/
structure InventoryOwnershipReadError where
  message : String
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryOwnershipReadContext`: a trusted internal read capability, never a client-supplied
payload. `undefined` is `none`; a read that throws is `.error`. The model is a pure snapshot: every
call with the same argument answers the same, and `bookId` and `bookRevision` cannot change between
two calls, so the scope test of `guard` (lines 946 and 1198) always passes here. A structure of
functions has no `DecidableEq` and no `Repr`. -/
structure InventoryOwnershipReadContext where
  bookId : BookId
  bookRevision : Int
  assertCurrent : Unit → Except InventoryOwnershipReadError Unit
  readCurrentHolding : LotHoldingId → Except InventoryOwnershipReadError (Option LotHolding)
  readCurrentPosition :
    LotHoldingId → Except InventoryOwnershipReadError (Option InventoryPostedPosition)
  readAnchor : InventoryPostedAnchorReference →
    Except InventoryOwnershipReadError (Option InventoryPostedAnchor)
  readPositionAfterImage : InventoryPostedPositionOrigin →
    Except InventoryOwnershipReadError (Option InventoryPostedPosition)
  deriving Inhabited

/-! ## Operations and selection (`inventory-ownership.ts` lines 1003 to 1131) -/

/-- `Pick<InventoryPostedReductionEntry, "movementId" | "allocation">`, unnamed in the TypeScript:
the element type of `InventoryReductionOperation.allocations` and of
`InventoryOwnershipSelection.allocations` (`InventoryReductionOperation["allocations"]`). -/
structure InventoryReductionOperationAllocation where
  movementId : InventoryPostedMovementId
  allocation : LotAllocation
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryReductionOperation`. Its `kind` is a field: the operation is a reduction of either
kind. -/
structure InventoryReductionOperation where
  kind : InventoryPostedReductionKind
  allocations : List InventoryReductionOperationAllocation
  journalLink : Option InventoryPostedJournalLink
  deriving DecidableEq, Repr, Inhabited

/-- `Omit<InventoryCostRequest, "layers">`. `InventoryCostRequest` (`accounting.ts` line 866) is
not modelled by any file yet; it belongs with `calculateInventoryCost` to
`Accounting/Inventory.lean`, so this file does not take its name. -/
structure InventoryCostRequestWithoutLayers where
  policyId : PolicyId
  policyVersion : SemanticVersion
  governedAt : Instant
  quantity : ExactRational
  specificLayerIds : Option (List String)
  deriving DecidableEq, Repr, Inhabited

/-- The element type of `InventoryOwnershipSelectionRequest.identities`, unnamed in the
TypeScript. -/
structure InventoryOwnershipSelectionIdentity where
  holdingId : LotHoldingId
  allocationId : LotAllocationId
  movementId : InventoryPostedMovementId
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryOwnershipSelectionRequest`. -/
structure InventoryOwnershipSelectionRequest extends InventoryCostRequestWithoutLayers where
  inventoryCommodityId : CommodityId
  derivation : DerivationRecord
  identities : List InventoryOwnershipSelectionIdentity
  deriving DecidableEq, Repr, Inhabited

/-- `{ readonly holding: LotHolding; readonly lot: Lot }`, unnamed in the TypeScript: the element
type of the `canonicalPool` parameter of `prepareInventoryOwnershipSelection` (line 1035), and of
what `OwnedInventoryAccountingContext.readPool` answers (`owned-inventory-command.ts` line 109,
which writes `lot` first). -/
structure InventoryOwnershipPoolRow where
  holding : LotHolding
  lot : Lot
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryOwnershipSelection`. -/
structure InventoryOwnershipSelection where
  inventoryPolicy : InventoryPostedAnchorPolicy
  allocations : List InventoryReductionOperationAllocation
  ordinaryQuantity : ExactRational
  ordinaryBasis : ExactRational
  ordinaryValuationAllowance : ExactRational
  ordinaryCarryingAmount : ExactRational
  provisionalQuantity : ExactRational
  provisionalBasis : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryAcquisitionOperation`; its `kind` is `"acquisition"`. -/
structure InventoryAcquisitionOperation extends InventoryPostedAcquisitionTerms where
  entries : List InventoryPostedAcquisitionEntry
  journalLink : Option InventoryPostedJournalLink
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryTransferOperationEntry`. -/
structure InventoryTransferOperationEntry where
  allocation : LotAllocation
  transferOutMovementId : InventoryPostedMovementId
  destinationAnchorId : InventoryPostedAnchorId
  destinationMovementId : InventoryPostedMovementId
  destinationHolding : LotHolding
  destinationLot : Lot
  evidence : List SourceEvidence
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryTransferOperation`; its `kind` is `"transfer"`. -/
structure InventoryTransferOperation extends InventoryPostedTransferDestinationTerms where
  entries : List InventoryTransferOperationEntry
  sourceJournalLink : Option InventoryPostedJournalLink
  destinationJournalLink : Option InventoryPostedJournalLink
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryAdoptionOperation`; its `kind` is `"adopt"`. -/
structure InventoryAdoptionOperation extends InventoryPostedAcquisitionTerms where
  entries : List InventoryPostedAdoptionEntry
  postedBalance : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryOwnershipOperation`: one constructor a case of the union, in the TypeScript's order.
The union is discriminated by `kind`; the reduction case has two kinds (`"disposal"`,
`"transferOut"`), held in its record, and each other case has one. -/
inductive InventoryOwnershipOperation where
  | reduction (operation : InventoryReductionOperation)
  | acquisition (operation : InventoryAcquisitionOperation)
  | transfer (operation : InventoryTransferOperation)
  | adopt (operation : InventoryAdoptionOperation)
  deriving DecidableEq, Repr, Inhabited

/-- `operation.kind`, the string the TypeScript compares (lines 1164 and 1250). -/
def InventoryOwnershipOperation.kind : InventoryOwnershipOperation → String
  | .reduction operation => operation.kind.text
  | .acquisition _ => "acquisition"
  | .transfer _ => "transfer"
  | .adopt _ => "adopt"

/-! ## Artifact kinds (`inventory-ownership.ts` lines 1445 to 1453) -/

/-- `InventoryOwnershipArtifactKind`: `keyof InventoryOwnershipArtifactTypes`. -/
inductive InventoryOwnershipArtifactKind where
  | anchor
  | position
  | reductionMovement
  | acquisitionMovement
  | reductionEffect
  | ownershipEffect
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of an `InventoryOwnershipArtifactKind`. -/
def InventoryOwnershipArtifactKind.text : InventoryOwnershipArtifactKind → String
  | .anchor => "anchor"
  | .position => "position"
  | .reductionMovement => "reductionMovement"
  | .acquisitionMovement => "acquisitionMovement"
  | .reductionEffect => "reductionEffect"
  | .ownershipEffect => "ownershipEffect"

/-- `InventoryOwnershipArtifactTypes[K]`. The interface `InventoryOwnershipArtifactTypes` holds no
value: the TypeScript uses it only as a map from a kind to the type of its artifact
(`validateInventoryOwnershipArtifact`, line 1667), which is what it is here. -/
def InventoryOwnershipArtifactTypes : InventoryOwnershipArtifactKind → Type
  | .anchor => InventoryPostedAnchor
  | .position => InventoryPostedPosition
  | .reductionMovement => InventoryPostedReductionMovement
  | .acquisitionMovement => InventoryPostedAcquisitionMovement
  | .reductionEffect => InventoryReductionOwnershipEffect
  | .ownershipEffect => InventoryOwnershipEffect

/-! ## Meaning: constructible values of the types this file imports

No earlier file says what a constructible `PolicyCumulativePostedShare` or `Lot` is, and
`LotHolding.WF` and `LotAllocation.WF` of `Lots.lean` say that their numbers are constructible and
nothing about their identifiers. This section says the rest, in the same terms. -/

/-- A share every exact number of which is constructible, computed under a policy whose identifiers
are valid. -/
structure PolicyCumulativePostedShare.WF (share : PolicyCumulativePostedShare) : Prop where
  postedTotal : share.postedTotal.WF
  beforeFraction : share.beforeFraction.WF
  afterFraction : share.afterFraction.WF
  beforeTarget : share.beforeTarget.WF
  afterTarget : share.afterTarget.WF
  beforeQuantization : share.beforeQuantization.WF
  afterQuantization : share.afterQuantization.WF
  postedAmount : share.postedAmount.WF
  policy : share.policy.WF

/-- A lot whose two amounts are numbers the TypeScript can construct. -/
structure Lot.WF (lot : Lot) : Prop where
  acquisitionQuantity : lot.acquisitionQuantity.WF
  acquisitionTotalBasis : lot.acquisitionTotalBasis.WF

/-- A lot whose identifiers are valid. Its `evidenceIds` are plain strings. -/
structure Lot.IdentifiersWF (lot : Lot) : Prop where
  id : lot.id.WF
  bookId : lot.bookId.WF
  commodityId : lot.commodityId.WF
  basisCommodityId : lot.basisCommodityId.WF

/-- A holding whose identifiers are valid. -/
structure LotHolding.IdentifiersWF (holding : LotHolding) : Prop where
  id : holding.id.WF
  bookId : holding.bookId.WF
  lotId : holding.lotId.WF
  accountId : holding.accountId.WF
  commodityId : holding.commodityId.WF
  basisCommodityId : holding.basisCommodityId.WF

/-- An allocation whose identifiers are valid, those of its derivation included. -/
structure LotAllocation.IdentifiersWF (allocation : LotAllocation) : Prop where
  id : allocation.id.WF
  holdingId : allocation.holdingId.WF
  lotId : allocation.lotId.WF
  derivation : allocation.derivation.WF

/-! ## Meaning: constructible coordinates, references, positions and contexts -/

/-- A coordinate whose identifiers are valid. -/
structure InventoryPostedCoordinate.WF (coordinate : InventoryPostedCoordinate) : Prop where
  bookId : coordinate.bookId.WF
  holdingId : coordinate.holdingId.WF
  lotId : coordinate.lotId.WF
  accountId : coordinate.accountId.WF
  unitsCommodityId : coordinate.unitsCommodityId.WF
  functionalCommodityId : coordinate.functionalCommodityId.WF
  dimensionMemberIds : ∀ id ∈ coordinate.dimensionMemberIds, id.WF

/-- A reference whose book identifier is valid; its `id` is a plain string. -/
structure InventoryPostedArtifactReference.WF (reference : InventoryPostedArtifactReference) :
    Prop where
  bookId : reference.bookId.WF

/-- An anchor reference whose identifiers are valid. -/
structure InventoryPostedAnchorReference.WF (reference : InventoryPostedAnchorReference) :
    Prop where
  id : reference.id.WF
  bookId : reference.bookId.WF

/-- A position reference whose identifiers are valid. -/
structure InventoryPostedPositionReference.WF (reference : InventoryPostedPositionReference) :
    Prop where
  id : reference.id.WF
  bookId : reference.bookId.WF

/-- A movement reference whose identifiers are valid. -/
structure InventoryPostedMovementReference.WF (reference : InventoryPostedMovementReference) :
    Prop where
  id : reference.id.WF
  bookId : reference.bookId.WF

/-- An anchor's policy whose identifier is valid. -/
structure InventoryPostedAnchorPolicy.WF (policy : InventoryPostedAnchorPolicy) : Prop where
  policyId : policy.policyId.WF

/-- The body of a constructible position. -/
structure InventoryPostedPositionBody.WF (position : InventoryPostedPositionBody) : Prop where
  holdingId : position.holdingId.WF
  consumedQuantity : position.consumedQuantity.WF
  consumedPosted : position.consumedPosted.WF
  anchor : position.anchor.WF
  originMovementId : position.originMovementId.WF

/-- A constructible position. -/
def InventoryPostedPosition.WF (position : InventoryPostedPosition) : Prop :=
  position.toInventoryPostedPositionBody.WF

/-- An origin whose movement identifier is valid. -/
structure InventoryPostedReductionOrigin.WF (origin : InventoryPostedReductionOrigin) : Prop where
  movementId : origin.movementId.WF

/-- A constructible journal source: the journal's exact numbers constructible
(`JournalTransaction.WF`) and its identifiers valid, and the identifiers of the record valid. -/
structure InventoryReductionJournalSource.WF (source : InventoryReductionJournalSource) : Prop where
  journal : source.journal.WF
  journalIdentifiers : source.journal.IdentifiersWF
  commandId : source.commandId.WF
  fiscalPeriodId : source.fiscalPeriodId.WF

/-- A constructible journal link. -/
structure InventoryPostedJournalLink.WF (link : InventoryPostedJournalLink) : Prop where
  source : link.source.WF
  postingId : link.postingId.WF
  referenceId : link.referenceId.WF

/-- An effect context whose identifiers are valid. -/
structure InventoryReductionEffectContext.WF (context : InventoryReductionEffectContext) :
    Prop where
  bookId : context.bookId.WF
  commandId : context.commandId.WF
  fiscalPeriodId : context.fiscalPeriodId.WF

/-- A group context whose identifiers are valid. -/
def InventoryPostedGroupContext.WF (context : InventoryPostedGroupContext) : Prop :=
  context.toInventoryReductionEffectContext.WF

/-- A reduction group context whose identifiers are valid. -/
def InventoryPostedReductionGroupContext.WF (context : InventoryPostedReductionGroupContext) :
    Prop :=
  context.toInventoryPostedGroupContext.WF

/-! ## Meaning: constructible movements and groups -/

/-- The body of a constructible reduction movement. -/
structure InventoryPostedReductionMovementBody.WF (body : InventoryPostedReductionMovementBody) :
    Prop where
  id : body.id.WF
  fiscalPeriodId : body.fiscalPeriodId.WF
  coordinate : body.coordinate.WF
  postedAmount : body.postedAmount.WF
  beforePosition : body.beforePosition.WF
  afterPosition : body.afterPosition.WF
  quantityAllocation : body.quantityAllocation.WF
  quantityAllocationIdentifiers : body.quantityAllocation.IdentifiersWF
  reductionProof : body.reductionProof.WF
  incomingSources : ∀ source ∈ body.incomingSources, source.WF

/-- The body of a constructible journal-linked reduction movement. -/
structure JournalLinkedInventoryReductionMovementBody.WF
    (movement : JournalLinkedInventoryReductionMovementBody) : Prop where
  body : movement.toInventoryPostedReductionMovementBody.WF
  posting : movement.posting.WF

/-- A constructible journal-linked reduction movement. -/
def JournalLinkedInventoryReductionMovement.WF
    (movement : JournalLinkedInventoryReductionMovement) : Prop :=
  movement.toJournalLinkedInventoryReductionMovementBody.WF

/-- A constructible quantity-only reduction movement. -/
def QuantityOnlyInventoryReductionMovement.WF (movement : QuantityOnlyInventoryReductionMovement) :
    Prop :=
  movement.toInventoryPostedReductionMovementBody.WF

/-- A constructible reduction movement: the record of its case is. -/
def InventoryPostedReductionMovement.WF : InventoryPostedReductionMovement → Prop
  | .journalLinked movement => movement.WF
  | .quantityOnly movement => movement.WF

/-- A constructible input of the hash of a reduction movement. -/
def MovementHashInput.WF : MovementHashInput → Prop
  | .journalLinked body => body.WF
  | .quantityOnly body => body.WF

/-- A constructible reduction group. -/
structure InventoryPostedReductionGroup.WF (group : InventoryPostedReductionGroup) : Prop where
  movements : ∀ movement ∈ group.movements, movement.WF
  afterHoldings : ∀ holding ∈ group.afterHoldings, holding.WF ∧ holding.IdentifiersWF
  postedAmount : group.postedAmount.WF
  quantity : group.quantity.WF
  historicalBasis : group.historicalBasis.WF

/-- The body of a constructible acquisition movement. -/
structure InventoryPostedAcquisitionMovementBody.WF
    (body : InventoryPostedAcquisitionMovementBody) : Prop where
  id : body.id.WF
  fiscalPeriodId : body.fiscalPeriodId.WF
  coordinate : body.coordinate.WF
  postedAmount : body.postedAmount.WF
  afterPosition : body.afterPosition.WF
  acquisitionProof : body.acquisitionProof.WF
  incomingSources : ∀ source ∈ body.incomingSources, source.WF

/-- The body of a constructible journal-linked acquisition movement. -/
structure JournalLinkedInventoryAcquisitionMovementBody.WF
    (movement : JournalLinkedInventoryAcquisitionMovementBody) : Prop where
  body : movement.toInventoryPostedAcquisitionMovementBody.WF
  posting : movement.posting.WF

/-- A constructible journal-linked acquisition movement. -/
def JournalLinkedInventoryAcquisitionMovement.WF
    (movement : JournalLinkedInventoryAcquisitionMovement) : Prop :=
  movement.toJournalLinkedInventoryAcquisitionMovementBody.WF

/-- A constructible quantity-only acquisition movement. -/
def QuantityOnlyInventoryAcquisitionMovement.WF
    (movement : QuantityOnlyInventoryAcquisitionMovement) : Prop :=
  movement.toInventoryPostedAcquisitionMovementBody.WF

/-- A constructible acquisition movement: the record of its case is. -/
def InventoryPostedAcquisitionMovement.WF : InventoryPostedAcquisitionMovement → Prop
  | .journalLinked movement => movement.WF
  | .quantityOnly movement => movement.WF

/-- A constructible input of the hash of an acquisition movement. -/
def InventoryPostedAcquisitionMovementHashInput.WF :
    InventoryPostedAcquisitionMovementHashInput → Prop
  | .journalLinked body => body.WF
  | .quantityOnly body => body.WF

/-! ## Meaning: constructible entries, contexts and operations -/

/-- A constructible acquisition entry. -/
structure InventoryPostedAcquisitionEntry.WF (entry : InventoryPostedAcquisitionEntry) : Prop where
  anchorId : entry.anchorId.WF
  movementId : entry.movementId.WF
  lot : entry.lot.WF
  lotIdentifiers : entry.lot.IdentifiersWF
  holding : entry.holding.WF
  holdingIdentifiers : entry.holding.IdentifiersWF
  evidence : ∀ item ∈ entry.evidence, item.WF

/-- The three acquisition fields of a context, constructible. -/
structure InventoryPostedAcquisitionTerms.WF (terms : InventoryPostedAcquisitionTerms) : Prop where
  inventoryPolicy : terms.inventoryPolicy.WF
  quantizationPolicy : terms.quantizationPolicy.WF
  dimensionMemberIds : ∀ id ∈ terms.dimensionMemberIds, id.WF

/-- A constructible acquisition context. -/
structure InventoryPostedAcquisitionContext.WF (context : InventoryPostedAcquisitionContext) :
    Prop where
  group : context.toInventoryPostedGroupContext.WF
  terms : context.toInventoryPostedAcquisitionTerms.WF

/-- A constructible adoption entry. -/
structure InventoryPostedAdoptionEntry.WF (entry : InventoryPostedAdoptionEntry) : Prop where
  anchorId : entry.anchorId.WF
  movementId : entry.movementId.WF
  holding : entry.holding.WF
  holdingIdentifiers : entry.holding.IdentifiersWF
  evidence : ∀ item ∈ entry.evidence, item.WF
  historicalPostings : ∀ posting ∈ entry.historicalPostings, posting.WF

/-- A constructible adoption context. -/
def InventoryPostedAdoptionContext.WF (context : InventoryPostedAdoptionContext) : Prop :=
  context.toInventoryPostedAcquisitionContext.WF

/-- The three destination fields of a transfer context, constructible. -/
structure InventoryPostedTransferDestinationTerms.WF
    (terms : InventoryPostedTransferDestinationTerms) : Prop where
  destinationInventoryPolicy : terms.destinationInventoryPolicy.WF
  destinationQuantizationPolicy : terms.destinationQuantizationPolicy.WF
  destinationDimensionMemberIds : ∀ id ∈ terms.destinationDimensionMemberIds, id.WF

/-- A constructible transfer group context. -/
structure InventoryPostedTransferGroupContext.WF (context : InventoryPostedTransferGroupContext) :
    Prop where
  group : context.toInventoryPostedGroupContext.WF
  terms : context.toInventoryPostedTransferDestinationTerms.WF

/-- A position origin whose identifiers are valid. -/
structure InventoryPostedPositionOrigin.WF (origin : InventoryPostedPositionOrigin) : Prop where
  bookId : origin.bookId.WF
  movementId : origin.movementId.WF

/-- A constructible allocation of a reduction operation. -/
structure InventoryReductionOperationAllocation.WF (item : InventoryReductionOperationAllocation) :
    Prop where
  movementId : item.movementId.WF
  allocation : item.allocation.WF
  allocationIdentifiers : item.allocation.IdentifiersWF

/-- A constructible reduction operation. -/
structure InventoryReductionOperation.WF (operation : InventoryReductionOperation) : Prop where
  allocations : ∀ item ∈ operation.allocations, item.WF
  journalLink : ∀ link, operation.journalLink = some link → link.WF

/-- A constructible cost request without layers. Its `specificLayerIds` are plain strings. -/
structure InventoryCostRequestWithoutLayers.WF (request : InventoryCostRequestWithoutLayers) :
    Prop where
  policyId : request.policyId.WF
  quantity : request.quantity.WF

/-- A selection identity whose identifiers are valid. -/
structure InventoryOwnershipSelectionIdentity.WF (identity : InventoryOwnershipSelectionIdentity) :
    Prop where
  holdingId : identity.holdingId.WF
  allocationId : identity.allocationId.WF
  movementId : identity.movementId.WF

/-- A constructible selection request. -/
structure InventoryOwnershipSelectionRequest.WF (request : InventoryOwnershipSelectionRequest) :
    Prop where
  core : request.toInventoryCostRequestWithoutLayers.WF
  inventoryCommodityId : request.inventoryCommodityId.WF
  derivation : request.derivation.WF
  identities : ∀ identity ∈ request.identities, identity.WF

/-- A constructible row of a canonical pool. -/
structure InventoryOwnershipPoolRow.WF (row : InventoryOwnershipPoolRow) : Prop where
  holding : row.holding.WF
  holdingIdentifiers : row.holding.IdentifiersWF
  lot : row.lot.WF
  lotIdentifiers : row.lot.IdentifiersWF

/-- A constructible selection. -/
structure InventoryOwnershipSelection.WF (selection : InventoryOwnershipSelection) : Prop where
  inventoryPolicy : selection.inventoryPolicy.WF
  allocations : ∀ item ∈ selection.allocations, item.WF
  ordinaryQuantity : selection.ordinaryQuantity.WF
  ordinaryBasis : selection.ordinaryBasis.WF
  ordinaryValuationAllowance : selection.ordinaryValuationAllowance.WF
  ordinaryCarryingAmount : selection.ordinaryCarryingAmount.WF
  provisionalQuantity : selection.provisionalQuantity.WF
  provisionalBasis : selection.provisionalBasis.WF

/-- A constructible acquisition operation. -/
structure InventoryAcquisitionOperation.WF (operation : InventoryAcquisitionOperation) : Prop where
  terms : operation.toInventoryPostedAcquisitionTerms.WF
  entries : ∀ entry ∈ operation.entries, entry.WF
  journalLink : ∀ link, operation.journalLink = some link → link.WF

/-- A constructible entry of a transfer operation. -/
structure InventoryTransferOperationEntry.WF (entry : InventoryTransferOperationEntry) : Prop where
  allocation : entry.allocation.WF
  allocationIdentifiers : entry.allocation.IdentifiersWF
  transferOutMovementId : entry.transferOutMovementId.WF
  destinationAnchorId : entry.destinationAnchorId.WF
  destinationMovementId : entry.destinationMovementId.WF
  destinationHolding : entry.destinationHolding.WF
  destinationHoldingIdentifiers : entry.destinationHolding.IdentifiersWF
  destinationLot : entry.destinationLot.WF
  destinationLotIdentifiers : entry.destinationLot.IdentifiersWF
  evidence : ∀ item ∈ entry.evidence, item.WF

/-- A constructible transfer operation. -/
structure InventoryTransferOperation.WF (operation : InventoryTransferOperation) : Prop where
  terms : operation.toInventoryPostedTransferDestinationTerms.WF
  entries : ∀ entry ∈ operation.entries, entry.WF
  sourceJournalLink : ∀ link, operation.sourceJournalLink = some link → link.WF
  destinationJournalLink : ∀ link, operation.destinationJournalLink = some link → link.WF

/-- A constructible adoption operation. -/
structure InventoryAdoptionOperation.WF (operation : InventoryAdoptionOperation) : Prop where
  terms : operation.toInventoryPostedAcquisitionTerms.WF
  entries : ∀ entry ∈ operation.entries, entry.WF
  postedBalance : operation.postedBalance.WF

/-- A constructible operation: the record of its case is. -/
def InventoryOwnershipOperation.WF : InventoryOwnershipOperation → Prop
  | .reduction operation => operation.WF
  | .acquisition operation => operation.WF
  | .transfer operation => operation.WF
  | .adopt operation => operation.WF

/-! ## Meaning: constructible anchors, reductions, groups and effects -/

/-- The body of a constructible anchor. -/
structure InventoryPostedAnchorBody.WF (anchor : InventoryPostedAnchorBody) : Prop where
  id : anchor.id.WF
  quantity : anchor.quantity.WF
  postedBudget : anchor.postedBudget.WF
  postedValue : ∀ value, anchor.postedValue = some value → value.WF
  coordinate : anchor.coordinate.WF
  inventoryPolicy : anchor.inventoryPolicy.WF
  quantizationPolicy : anchor.quantizationPolicy.WF
  predecessorPosition : ∀ reference, anchor.predecessorPosition = some reference → reference.WF
  sourcePostings : ∀ posting ∈ anchor.sourcePostings, posting.WF
  incomingMovements : ∀ reference ∈ anchor.incomingMovements, reference.WF
  evidence : ∀ item ∈ anchor.evidence, item.WF

/-- A constructible anchor. -/
def InventoryPostedAnchor.WF (anchor : InventoryPostedAnchor) : Prop :=
  anchor.toInventoryPostedAnchorBody.WF

/-- A constructible reduction. Its `postedValue`, an `InventoryPostedValueAllocation` (of
`InventoryPostedValues.lean`, which defines no `WF` for it), has its four amounts and its two
shares constructible. -/
structure InventoryPostedReduction.WF (reduction : InventoryPostedReduction) : Prop where
  postedAmount : reduction.postedAmount.WF
  beforePosition : reduction.beforePosition.WF
  afterPosition : reduction.afterPosition.WF
  afterHolding : reduction.afterHolding.WF
  afterHoldingIdentifiers : reduction.afterHolding.IdentifiersWF
  allocation : reduction.allocation.WF
  allocationIdentifiers : reduction.allocation.IdentifiersWF
  reductionProof : reduction.reductionProof.WF
  postedMinusEconomic : reduction.postedMinusEconomic.WF
  postedValue : ∀ value, reduction.postedValue = some value →
    value.consumed.WF ∧ value.remaining.WF ∧ value.carryingConsumed.WF ∧
      value.carryingRemaining.WF ∧ value.allowanceProof.WF ∧ value.carryingProof.WF

/-- A constructible result: a prepared reduction is constructible; a rejection holds no exact
number and no identifier. -/
def ReductionResult.WF : ReductionResult → Prop
  | .prepared reduction => reduction.WF
  | .rejected _ => True

/-- A constructible reduction entry. -/
structure InventoryPostedReductionEntry.WF (entry : InventoryPostedReductionEntry) : Prop where
  movementId : entry.movementId.WF
  anchor : entry.anchor.WF
  position : entry.position.WF
  holding : entry.holding.WF
  holdingIdentifiers : entry.holding.IdentifiersWF
  allocation : entry.allocation.WF
  allocationIdentifiers : entry.allocation.IdentifiersWF

/-- A constructible reduction source. -/
structure InventoryPostedReductionSource.WF (source : InventoryPostedReductionSource) : Prop where
  anchor : source.anchor.WF
  position : source.position.WF
  holding : source.holding.WF
  holdingIdentifiers : source.holding.IdentifiersWF

/-- A constructible acquisition group. -/
structure InventoryPostedAcquisitionGroup.WF (group : InventoryPostedAcquisitionGroup) : Prop where
  anchors : ∀ anchor ∈ group.anchors, anchor.WF
  movements : ∀ movement ∈ group.movements, movement.WF
  lots : ∀ lot ∈ group.lots, lot.WF ∧ lot.IdentifiersWF
  holdings : ∀ holding ∈ group.holdings, holding.WF ∧ holding.IdentifiersWF
  postedAmount : group.postedAmount.WF

/-- A constructible adoption group. -/
structure InventoryPostedAdoptionGroup.WF (group : InventoryPostedAdoptionGroup) : Prop where
  anchors : ∀ anchor ∈ group.anchors, anchor.WF
  movements : ∀ movement ∈ group.movements, movement.WF
  holdings : ∀ holding ∈ group.holdings, holding.WF ∧ holding.IdentifiersWF
  positions : ∀ position ∈ group.positions, position.WF
  adoptedPostedBalance : group.adoptedPostedBalance.WF
  adoptedQuantity : group.adoptedQuantity.WF

/-- A constructible transfer entry. -/
structure InventoryPostedTransferEntry.WF (entry : InventoryPostedTransferEntry) : Prop where
  source : entry.source.WF
  allocation : entry.allocation.WF
  allocationIdentifiers : entry.allocation.IdentifiersWF
  transferOutMovementId : entry.transferOutMovementId.WF
  destinationAnchorId : entry.destinationAnchorId.WF
  destinationMovementId : entry.destinationMovementId.WF
  destinationHolding : entry.destinationHolding.WF
  destinationHoldingIdentifiers : entry.destinationHolding.IdentifiersWF
  destinationLot : entry.destinationLot.WF
  destinationLotIdentifiers : entry.destinationLot.IdentifiersWF
  evidence : ∀ item ∈ entry.evidence, item.WF

/-- A constructible transfer group. -/
structure InventoryPostedTransferGroup.WF (group : InventoryPostedTransferGroup) : Prop where
  transferOutMovements : ∀ movement ∈ group.transferOutMovements, movement.WF
  destinationAnchors : ∀ anchor ∈ group.destinationAnchors, anchor.WF
  destinationMovements : ∀ movement ∈ group.destinationMovements, movement.WF
  destinationLots : ∀ lot ∈ group.destinationLots, lot.WF ∧ lot.IdentifiersWF
  destinationHoldings : ∀ holding ∈ group.destinationHoldings, holding.WF ∧ holding.IdentifiersWF
  afterSourceHoldings : ∀ holding ∈ group.afterSourceHoldings, holding.WF ∧ holding.IdentifiersWF
  afterSourcePositions : ∀ position ∈ group.afterSourcePositions, position.WF
  transferredPostedAmount : group.transferredPostedAmount.WF
  transferredQuantity : group.transferredQuantity.WF

/-- A constructible movement: the movement of its case is. -/
def InventoryPostedMovement.WF : InventoryPostedMovement → Prop
  | .reduction movement => movement.WF
  | .acquisition movement => movement.WF

/-- A constructible journal-linked movement. -/
def JournalLinkedInventoryPostedMovement.WF : JournalLinkedInventoryPostedMovement → Prop
  | .reduction movement => movement.WF
  | .acquisition movement => movement.WF

/-- A constructible quantity-only movement. -/
def QuantityOnlyInventoryPostedMovement.WF : QuantityOnlyInventoryPostedMovement → Prop
  | .reduction movement => movement.WF
  | .acquisition movement => movement.WF

/-- The body of a constructible ownership effect. -/
structure InventoryOwnershipEffectBody.WF (effect : InventoryOwnershipEffectBody) : Prop where
  newAnchors : ∀ anchor ∈ effect.newAnchors, anchor.WF
  journalLinkedMovements : ∀ movement ∈ effect.journalLinkedMovements, movement.WF
  quantityOnlyMovements : ∀ movement ∈ effect.quantityOnlyMovements, movement.WF

/-- A constructible ownership effect. -/
def InventoryOwnershipEffect.WF (effect : InventoryOwnershipEffect) : Prop :=
  effect.toInventoryOwnershipEffectBody.WF

/-- The body of a constructible reduction effect. Whether `newAnchors` is empty is `Typed`, not
`WF`. -/
structure InventoryReductionOwnershipEffectBody.WF
    (effect : InventoryReductionOwnershipEffectBody) : Prop where
  newAnchors : ∀ anchor ∈ effect.newAnchors, anchor.WF
  journalLinkedMovements : ∀ movement ∈ effect.journalLinkedMovements, movement.WF
  quantityOnlyMovements : ∀ movement ∈ effect.quantityOnlyMovements, movement.WF

/-- A constructible reduction effect. -/
def InventoryReductionOwnershipEffect.WF (effect : InventoryReductionOwnershipEffect) : Prop :=
  effect.toInventoryReductionOwnershipEffectBody.WF

/-- A read context every answer of which is constructible. -/
structure InventoryOwnershipReadContext.WF (reader : InventoryOwnershipReadContext) : Prop where
  bookId : reader.bookId.WF
  readCurrentHolding : ∀ id holding, reader.readCurrentHolding id = .ok (some holding) →
    holding.WF ∧ holding.IdentifiersWF
  readCurrentPosition : ∀ id position, reader.readCurrentPosition id = .ok (some position) →
    position.WF
  readAnchor : ∀ reference anchor, reader.readAnchor reference = .ok (some anchor) → anchor.WF
  readPositionAfterImage : ∀ origin position,
    reader.readPositionAfterImage origin = .ok (some position) → position.WF

/-- A constructible artifact of the given kind. -/
def InventoryOwnershipArtifactTypes.WF :
    (kind : InventoryOwnershipArtifactKind) → InventoryOwnershipArtifactTypes kind → Prop
  | .anchor, artifact => InventoryPostedAnchor.WF artifact
  | .position, artifact => InventoryPostedPosition.WF artifact
  | .reductionMovement, artifact => InventoryPostedReductionMovement.WF artifact
  | .acquisitionMovement, artifact => InventoryPostedAcquisitionMovement.WF artifact
  | .reductionEffect, artifact => InventoryReductionOwnershipEffect.WF artifact
  | .ownershipEffect, artifact => InventoryOwnershipEffect.WF artifact

end Rastrata.Kernel

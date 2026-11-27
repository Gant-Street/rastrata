/-
The vocabulary of a book: the Lean model of `packages/kernel/src/book.ts` lines 138 to 245 (the
identifier types and their makers, `BOOK_COMMAND_PROTOCOL_VERSION`, `BookFinancialIdentity`,
`FiscalPeriod`, `OpeningBoundary`, the execution and state commitment profiles,
`ExecutionProfileAdoption`, `BookConfigurationSnapshot` and `BookedJournal`). Lines 1 to 137 of
`book.ts` are imports. Nothing from `createAccountingReadSnapshot` (line 248) on is here.

`book.ts` imports `accounting.ts`, and `accounting.ts` imports the types `BookConfigurationSnapshot`
and `BookedJournal` from `book.ts`. Lean allows no cycle, so this file imports
`Accounting/Types.lean` (which needs nothing of `book.ts`), and the accounting types that mention
these two (`AccountingReadSnapshot` and the basis projection) are in `Accounting/BasisTypes.lean`,
which imports this file.

The types are written as in `Accounting/Types.lean`: same field names in the same order, an
optional field an `Option`, a `bigint` an `Int`, a union of string literals an inductive with
`text`, and `Omit<BookConfigurationSnapshot, "contentHash">` (`book.ts` line 773) the structure
`BookConfigurationSnapshotBody`, which `BookConfigurationSnapshot` extends. A TypeScript constant in
capitals is a Lean definition in camel case, as in the rest of the model
(`CANONICALIZATION_VERSION` is `canonicalizationVersion`).

Meaning: `WF` as in `Accounting/Types.lean`, each exact number constructible and each identifier
valid. `BookedJournal` holds a `JournalTransaction` and the snapshot a `JournalAdmissionSnapshot`,
whose identifiers no earlier file constrains; `Posting.IdentifiersWF`,
`JournalTransaction.IdentifiersWF` and the `WF` of the admission snapshot and its three kinds of
member are defined here for them. The booking policies of a snapshot use `BookingPolicy.WF` of
`Policy.lean` as it stands, which also asks that their instants and versions be well formed.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Journal.Admission
import Rastrata.Kernel.Policy.Types
import Rastrata.Kernel.Policy
import Rastrata.Kernel.QuantizationBalanced
import Rastrata.Kernel.Accounting.Types

namespace Rastrata.Kernel

/-! ## Identifier types and their makers (`book.ts` lines 138 to 163) -/

/-- `CommandId`. -/
abbrev CommandId := Identifier "BookCommand"

/-- `ActorId`; `DerivationRecord.actorId` has this type. -/
abbrev ActorId := Identifier "Actor"

/-- `FiscalCalendarId`. -/
abbrev FiscalCalendarId := Identifier "FiscalCalendar"

/-- `FiscalPeriodId`. -/
abbrev FiscalPeriodId := Identifier "FiscalPeriod"

/-- `OpeningBoundaryId`. -/
abbrev OpeningBoundaryId := Identifier "OpeningBoundary"

/-- `ClosePackageId`. -/
abbrev ClosePackageId := Identifier "ClosePackage"

/-- `BOOK_COMMAND_PROTOCOL_VERSION` (`book.ts` line 144). -/
def bookCommandProtocolVersion : SemanticVersion := ⟨"1.0.0"⟩

/-- `commandId` (`book.ts` line 146). -/
def commandId (value : String) : Except CanonicalErr CommandId := identifier "BookCommand" value

/-- `actorId` (`book.ts` line 149). -/
def actorId (value : String) : Except CanonicalErr ActorId := identifier "Actor" value

/-- `fiscalCalendarId` (`book.ts` line 152). -/
def fiscalCalendarId (value : String) : Except CanonicalErr FiscalCalendarId :=
  identifier "FiscalCalendar" value

/-- `fiscalPeriodId` (`book.ts` line 155). -/
def fiscalPeriodId (value : String) : Except CanonicalErr FiscalPeriodId :=
  identifier "FiscalPeriod" value

/-- `openingBoundaryId` (`book.ts` line 158). -/
def openingBoundaryId (value : String) : Except CanonicalErr OpeningBoundaryId :=
  identifier "OpeningBoundary" value

/-- `closePackageId` (`book.ts` line 161). -/
def closePackageId (value : String) : Except CanonicalErr ClosePackageId :=
  identifier "ClosePackage" value

/-! ## The financial identity and fiscal periods (`book.ts` lines 165 to 186) -/

/-- The type of `BookFinancialIdentity.ownerKind`. -/
inductive BookOwnerKind where
  | legalEntity
  | entityGroup
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookOwnerKind`. -/
def BookOwnerKind.text : BookOwnerKind → String
  | .legalEntity => "legalEntity"
  | .entityGroup => "entityGroup"

/-- The type of `BookFinancialIdentity.kind`. -/
inductive BookKind where
  | operational
  | tax
  | consolidation
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookKind`. -/
def BookKind.text : BookKind → String
  | .operational => "operational"
  | .tax => "tax"
  | .consolidation => "consolidation"

/-- `BookFinancialIdentity`. `code` and `accountingTimeZone` are plain strings. -/
structure BookFinancialIdentity where
  bookId : BookId
  code : String
  ownerId : Identifier "BookOwner"
  ownerKind : BookOwnerKind
  kind : BookKind
  functionalCommodityId : CommodityId
  primaryBasis : AccountingBasis
  fiscalCalendarId : FiscalCalendarId
  accountingTimeZone : String
  deriving DecidableEq, Repr, Inhabited

/-- The type of `FiscalPeriod.kind`. -/
inductive FiscalPeriodKind where
  | regular
  | adjustment
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `FiscalPeriodKind`. -/
def FiscalPeriodKind.text : FiscalPeriodKind → String
  | .regular => "regular"
  | .adjustment => "adjustment"

/-- `FiscalPeriod`. -/
structure FiscalPeriod where
  id : FiscalPeriodId
  calendarId : FiscalCalendarId
  fiscalYear : Int
  sequence : Int
  label : String
  kind : FiscalPeriodKind
  startsOn : LocalDate
  endsOn : LocalDate
  deriving DecidableEq, Repr, Inhabited

/-! ## Execution and state commitment profiles (`book.ts` lines 197 to 219) -/

/-- `STRUCTURAL_SOURCE_IDENTITY_PROFILE` (`book.ts` line 199). Explicit semantics, distinct from
wire codecs and accounting policies. Absence retains legacy bytes and behavior; adoption requires a
recorded transition. -/
def structuralSourceIdentityProfile : String := "structural-source-identity-v1"

/-- `BookExecutionProfile`, `typeof STRUCTURAL_SOURCE_IDENTITY_PROFILE`: one possible value. -/
inductive BookExecutionProfile where
  | structuralSourceIdentityV1
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookExecutionProfile`. -/
def BookExecutionProfile.text : BookExecutionProfile → String
  | .structuralSourceIdentityV1 => structuralSourceIdentityProfile

/-- The type of `BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS`, unnamed in the TypeScript. -/
structure BookExecutionProfileAdoptionLimits where
  maxReasonCodePoints : Nat
  maxEvidenceIds : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS` (`book.ts` line 201). -/
def bookExecutionProfileAdoptionLimits : BookExecutionProfileAdoptionLimits :=
  { maxReasonCodePoints := 4096, maxEvidenceIds := 64 }

/-- `CHAIN_HEAD_STATE_COMMITMENT_PROFILE` (`book.ts` line 208). It selects what
`BookState.contentHash` commits to; absence retains the legacy complete-population preimage. It is
selected at genesis and hash-bound by the configuration snapshot, and a book keeps it. -/
def chainHeadStateCommitmentProfile : String := "chain-head-state-commitment-v1"

/-- `BookStateCommitmentProfile`, `typeof CHAIN_HEAD_STATE_COMMITMENT_PROFILE`: one possible
value. -/
inductive BookStateCommitmentProfile where
  | chainHeadStateCommitmentV1
  deriving DecidableEq, Repr, Inhabited

/-- The string literal of a `BookStateCommitmentProfile`. -/
def BookStateCommitmentProfile.text : BookStateCommitmentProfile → String
  | .chainHeadStateCommitmentV1 => chainHeadStateCommitmentProfile

/-- `ExecutionProfileAdoption`. `from` and `to` are keywords of Lean, so the two fields are
written `«from»` and `«to»`. They are plain strings: requested names permit unsupported strings to
receive durable rejections, while a committed configuration still uses the closed
`BookExecutionProfile`. -/
structure ExecutionProfileAdoption where
  «from» : String
  «to» : String
  expectedConfigurationHash : ContentHash
  reason : String
  evidenceIds : List EvidenceId
  deriving DecidableEq, Repr, Inhabited

/-! ## The configuration snapshot, the opening boundary and a booked journal (`book.ts` lines 188
to 195 and 221 to 245) -/

/-- `Omit<BookConfigurationSnapshot, "contentHash">` (`book.ts` line 773). -/
structure BookConfigurationSnapshotBody where
  revision : Int
  effectiveAt : Instant
  executionProfile : Option BookExecutionProfile
  stateCommitmentProfile : Option BookStateCommitmentProfile
  periods : List FiscalPeriod
  admissionSnapshot : JournalAdmissionSnapshot
  policies : List BookingPolicy
  quantizationPolicies : List QuantizationPolicy
  accountingPolicySnapshot : AccountingPolicySnapshot
  deriving DecidableEq, Repr, Inhabited

/-- `BookConfigurationSnapshot`. -/
structure BookConfigurationSnapshot extends BookConfigurationSnapshotBody where
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `OpeningBoundary`. It is declared before `BookConfigurationSnapshot` in the TypeScript and holds
one, so it comes after it here. `openingJournalId` is a plain string, not a `JournalId`. -/
structure OpeningBoundary where
  id : OpeningBoundaryId
  firstAccountingDate : LocalDate
  activatedAt : Instant
  openingJournalId : Option String
  configurationSnapshot : BookConfigurationSnapshot
  contentHash : ContentHash
  deriving DecidableEq, Repr, Inhabited

/-- `BookedJournal`. `effectKey` is a plain string, not an `EffectKey`; `derivations` is
`ResolvedTransaction["derivations"]`. -/
structure BookedJournal where
  journal : JournalTransaction
  commandId : CommandId
  effectKey : String
  bookRevision : Int
  postingSequence : Int
  fiscalPeriodId : FiscalPeriodId
  policySnapshotHash : ContentHash
  quantizationPolicySnapshotHash : ContentHash
  canonicalHash : ContentHash
  derivations : List DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-! ## Meaning: valid identifiers of the journal vocabulary

`Posting.WF` and `JournalTransaction.WF` (`Journal/Admission.lean`) say that the exact numbers of a
posting or a journal are constructible, and nothing about its identifiers; these say the rest. -/

/-- A posting whose identifiers are valid. -/
structure Posting.IdentifiersWF (posting : Posting) : Prop where
  id : posting.id.WF
  accountId : posting.accountId.WF
  unitsCommodityId : posting.units.commodityId.WF
  functionalCommodityId : posting.bookValue.functionalCommodityId.WF
  transactionPrice : ∀ price, posting.transactionPrice = some price →
    price.baseCommodityId.WF ∧ price.quoteCommodityId.WF
  costBasis : ∀ basis, posting.costBasis = some basis → basis.basisCommodityId.WF
  dimensionMemberIds : ∀ id ∈ posting.dimensionMemberIds, id.WF

/-- A journal whose identifiers are valid, those of its postings included. -/
structure JournalTransaction.IdentifiersWF (journal : JournalTransaction) : Prop where
  id : journal.id.WF
  bookId : journal.bookId.WF
  functionalCommodityId : journal.functionalCommodityId.WF
  postings : ∀ posting ∈ journal.postings, posting.IdentifiersWF

/-- An account of the chart whose identifiers are valid. -/
structure AccountSnapshot.WF (account : AccountSnapshot) : Prop where
  id : account.id.WF
  bookId : account.bookId.WF
  parentId : ∀ id, account.parentId = some id → id.WF
  allowedCommodityIds : ∀ id ∈ account.allowedCommodityIds, id.WF

/-- A dimension whose identifiers are valid. -/
structure AccountingDimensionSnapshot.WF (dimension : AccountingDimensionSnapshot) : Prop where
  id : dimension.id.WF
  bookId : dimension.bookId.WF

/-- A dimension member whose identifiers are valid. -/
structure DimensionMemberSnapshot.WF (member : DimensionMemberSnapshot) : Prop where
  id : member.id.WF
  dimensionId : member.dimensionId.WF
  parentId : ∀ id, member.parentId = some id → id.WF

/-- An admission snapshot whose identifiers are valid. The keys of
`requiredDimensionIdsByPosting` are plain strings in the TypeScript (`Record<string, ...>`), so only
its values are constrained. -/
structure JournalAdmissionSnapshot.WF (snapshot : JournalAdmissionSnapshot) : Prop where
  bookId : snapshot.bookId.WF
  functionalCommodityId : snapshot.functionalCommodityId.WF
  accounts : ∀ account ∈ snapshot.accounts, account.WF
  dimensions : ∀ dimension ∈ snapshot.dimensions, dimension.WF
  dimensionMembers : ∀ member ∈ snapshot.dimensionMembers, member.WF
  requiredDimensionIds : ∀ id ∈ snapshot.requiredDimensionIds, id.WF
  requiredDimensionIdsByPosting :
    ∀ entries, snapshot.requiredDimensionIdsByPosting = some entries →
      ∀ entry ∈ entries, ∀ id ∈ entry.2, id.WF

/-! ## Meaning: constructible book values -/

/-- A financial identity whose identifiers are valid. -/
structure BookFinancialIdentity.WF (identity : BookFinancialIdentity) : Prop where
  bookId : identity.bookId.WF
  ownerId : identity.ownerId.WF
  functionalCommodityId : identity.functionalCommodityId.WF
  fiscalCalendarId : identity.fiscalCalendarId.WF

/-- A fiscal period whose identifiers are valid. -/
structure FiscalPeriod.WF (period : FiscalPeriod) : Prop where
  id : period.id.WF
  calendarId : period.calendarId.WF

/-- An adoption whose evidence identifiers are valid. -/
structure ExecutionProfileAdoption.WF (adoption : ExecutionProfileAdoption) : Prop where
  evidenceIds : ∀ id ∈ adoption.evidenceIds, id.WF

/-- The body of a constructible configuration snapshot. -/
structure BookConfigurationSnapshotBody.WF (snapshot : BookConfigurationSnapshotBody) : Prop where
  periods : ∀ period ∈ snapshot.periods, period.WF
  admissionSnapshot : snapshot.admissionSnapshot.WF
  policies : ∀ policy ∈ snapshot.policies, policy.WF
  quantizationPolicies : ∀ policy ∈ snapshot.quantizationPolicies, policy.WF
  accountingPolicySnapshot : snapshot.accountingPolicySnapshot.WF

/-- A constructible configuration snapshot. -/
def BookConfigurationSnapshot.WF (snapshot : BookConfigurationSnapshot) : Prop :=
  snapshot.toBookConfigurationSnapshotBody.WF

/-- A constructible opening boundary. -/
structure OpeningBoundary.WF (boundary : OpeningBoundary) : Prop where
  id : boundary.id.WF
  configurationSnapshot : boundary.configurationSnapshot.WF

/-- A constructible booked journal: the journal's exact numbers constructible
(`JournalTransaction.WF`) and its identifiers valid, and the identifiers of the record valid. -/
structure BookedJournal.WF (booked : BookedJournal) : Prop where
  journal : booked.journal.WF
  journalIdentifiers : booked.journal.IdentifiersWF
  commandId : booked.commandId.WF
  fiscalPeriodId : booked.fiscalPeriodId.WF
  derivations : ∀ derivation ∈ booked.derivations, derivation.WF

end Rastrata.Kernel

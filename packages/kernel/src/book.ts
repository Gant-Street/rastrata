import {
  compareCanonicalText,
  CANONICALIZATION_VERSION,
  CONTENT_HASH_ALGORITHM,
  contentHashEquals,
  hashCanonical,
  hashCanonicalSequenceField,
  identifier,
  type CanonicalValue,
  type ContentHash,
  type Identifier,
} from "./canonical.ts";
import {
  adoptJournals,
  adoptLists,
  appendFrozen,
  journalLogOf,
  journalsOf,
  latestRevisionRecord,
  retainedLogOf,
  revisionLogOf,
  revisionsOf,
  withRetainedResult,
} from "./book-history.ts";
import { markVerifiedSnapshot, verifiedOr } from "./verified-snapshots.ts";
import { isKnownIanaTimeZone } from "./iana-timezones.ts";
import { prepareOwnedInventoryAccounting, type OwnedInventoryAccountingContext, type OwnedInventoryTransactionRequest, type OwnedInventoryIdentityKind, type InventoryMoneyScope } from "./owned-inventory-command.ts";
import { validateInventoryOwnershipArtifact, isInventoryPostedReductionMovement, type InventoryOwnershipEffect, type InventoryPostedMovement } from "./inventory-ownership.ts";
import {
  admitJournal,
  canonicalJournalValue,
  canonicalPostingValue,
  compareInstants,
  diagnostic,
  localDate,
  type BookId,
  type AccountId,
  type CommodityId,
  type DimensionMemberId,
  type Instant,
  type JournalAdmissionSnapshot,
  type JournalTransaction,
  type LocalDate,
  type PostingId,
  type SemanticDiagnostic,
} from "./journal.ts";
import {
  canonicalDerivationValue,
  canonicalPolicyValue,
  hashPolicySnapshot,
  resolveJournal,
  selectBookingPolicy,
  type BookingPolicy,
  type ResolvedTransaction,
  type SemanticVersion,
} from "./policy.ts";
import { hashQuantizationPolicy, quantize, quantizeBalancedBookValues, type QuantizationPolicy } from "./quantization.ts";
import {
  allocateLots,
  transferLots,
  type DestinationHoldingIdentity,
  type Lot,
  type LotAllocation,
  type LotAllocationIdentity,
  type LotHolding,
  type LotHoldingId,
  type LotSelection,
  type TransferPolicy,
} from "./lots.ts";
import { ExactRational } from "./numeric.ts";
import {
  accountingCapabilityAdmits,
  accountingPolicyCombination,
  calculateCurrencyRemeasurement,
  calculateInventoryCost,
  calculateInventoryValueAdjustment,
  calculateInventoryRecosting,
  canonicalAccountingEffectValue,
  canonicalAccountingStateValue,
  canonicalAccountingValue,
  compileConsolidation,
  createCanonicalPostingReference,
  createAccountingPolicySnapshot,
  hashAccountingBasisSourcePopulation,
  hashAccountingReadPopulation,
  hashAccountingReadSnapshot,
  createProvisionalInventoryLayerEffect,
  createAllocationSchedule,
  determineTax,
  emptyAccountingCanonicalState,
  immutableAccountingValue,
  calculateOpenItem,
  recognizeScheduledAllocation,
  reviseAllocationSchedule,
  calculateSettlement,
  settlementReadContext,
  type SettlementReadContext,
  applyAccountingEffect,
  applyInventoryValueAdjustmentToHoldings,
  validateAccountingEffectHash,
  validateAccountingEffectAdmission,
  validateAccountingEffectIdentities,
  validAccountingDerivation,
  validateCanonicalPostingReferenceHash,
  supportsInventoryValueAdjustmentAlgorithm,
  usesStructuralTaxGrouping,
  usesCumulativeAllocation,
  type AccountingCanonicalState,
  type AccountingCalculation,
  type AccountingEffect,
  type AllocationAccountingState,
  accountingEffectExists,
  type AccountingPolicy,
  type AccountingPolicySnapshot,
  type AccountingReadSnapshot,
  type BasisSourceEvent,
  type CanonicalPostingReference,
  type AllocationRecognitionRequest,
  type AllocationScheduleRevisionRequest,
  type AllocationScheduleRequest,
  type ConsolidationRequest,
  type CurrencyPolicy,
  type CurrencyAccountingState,
  type CurrencyRemeasurementRequest,
  type RemeasurementResult,
  type ExactPreparedJournal,
  type InventoryCostPolicy,
  type InventoryCostRequest,
  type InventoryLayerInput,
  type InventoryValueAdjustmentRequest,
  type InventoryAllocationResult,
  type OpenItemRecognitionRequest,
  type ProvisionalInventoryLayer,
  type RecostInventoryRequest,
  type SettlementRequest,
  type TaxRequest,
} from "./accounting.ts";

export type CommandId = Identifier<"BookCommand">;
export type ActorId = Identifier<"Actor">;
export type FiscalCalendarId = Identifier<"FiscalCalendar">;
export type FiscalPeriodId = Identifier<"FiscalPeriod">;
export type OpeningBoundaryId = Identifier<"OpeningBoundary">;
export type ClosePackageId = Identifier<"ClosePackage">;
export const BOOK_COMMAND_PROTOCOL_VERSION = "1.0.0" as SemanticVersion;

export function commandId(value: string): CommandId {
  return identifier<"BookCommand">(value);
}
export function actorId(value: string): ActorId {
  return identifier<"Actor">(value);
}
export function fiscalCalendarId(value: string): FiscalCalendarId {
  return identifier<"FiscalCalendar">(value);
}
export function fiscalPeriodId(value: string): FiscalPeriodId {
  return identifier<"FiscalPeriod">(value);
}
export function openingBoundaryId(value: string): OpeningBoundaryId {
  return identifier<"OpeningBoundary">(value);
}
export function closePackageId(value: string): ClosePackageId {
  return identifier<"ClosePackage">(value);
}

export interface BookFinancialIdentity {
  readonly bookId: BookId;
  readonly code: string;
  readonly ownerId: Identifier<"BookOwner">;
  readonly ownerKind: "legalEntity" | "entityGroup";
  readonly kind: "operational" | "tax" | "consolidation";
  readonly functionalCommodityId: CommodityId;
  readonly primaryBasis: "accrual" | "cash";
  readonly fiscalCalendarId: FiscalCalendarId;
  readonly accountingTimeZone: string;
}

export interface FiscalPeriod {
  readonly id: FiscalPeriodId;
  readonly calendarId: FiscalCalendarId;
  readonly fiscalYear: bigint;
  readonly sequence: bigint;
  readonly label: string;
  readonly kind: "regular" | "adjustment";
  readonly startsOn: LocalDate;
  readonly endsOn: LocalDate;
}

export interface OpeningBoundary {
  readonly id: OpeningBoundaryId;
  readonly firstAccountingDate: LocalDate;
  readonly activatedAt: Instant;
  readonly openingJournalId?: string;
  readonly configurationSnapshot: BookConfigurationSnapshot;
  readonly contentHash: ContentHash;
}

/** Explicit semantics, distinct from wire codecs and accounting policies.
 * Absence retains legacy bytes and behavior; adoption requires a recorded transition. */
export const STRUCTURAL_SOURCE_IDENTITY_PROFILE = "structural-source-identity-v1";
export type BookExecutionProfile = typeof STRUCTURAL_SOURCE_IDENTITY_PROFILE;
export const BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS = Object.freeze({ maxReasonCodePoints: 4096, maxEvidenceIds: 64 });

/** Selects what BookState.contentHash commits to. Absence retains the legacy
 * complete-population preimage and its bytes. Like the execution profile it is
 * selected at genesis and hash-bound by the configuration snapshot, but it is a
 * separate field so the two compose. There is no adoption or removal transition:
 * a book keeps the commitment it was created with. */
export const CHAIN_HEAD_STATE_COMMITMENT_PROFILE = "chain-head-state-commitment-v1";
export type BookStateCommitmentProfile = typeof CHAIN_HEAD_STATE_COMMITMENT_PROFILE;

export interface ExecutionProfileAdoption {
  /** Requested names permit unsupported strings to receive durable rejections.
   * A committed configuration still uses the closed BookExecutionProfile enum. */
  readonly from: string;
  readonly to: string;
  readonly expectedConfigurationHash: ContentHash;
  readonly reason: string;
  readonly evidenceIds: readonly Identifier<"SourceEvidence">[];
}

export interface BookConfigurationSnapshot {
  readonly revision: bigint;
  readonly effectiveAt: Instant;
  readonly executionProfile?: BookExecutionProfile;
  readonly stateCommitmentProfile?: BookStateCommitmentProfile;
  readonly periods: readonly FiscalPeriod[];
  readonly admissionSnapshot: JournalAdmissionSnapshot;
  readonly policies: readonly BookingPolicy[];
  readonly quantizationPolicies: readonly QuantizationPolicy[];
  readonly accountingPolicySnapshot: AccountingPolicySnapshot;
  readonly contentHash: ContentHash;
}

export interface BookedJournal {
  readonly journal: JournalTransaction;
  readonly commandId: CommandId;
  readonly effectKey: string;
  readonly bookRevision: bigint;
  readonly postingSequence: bigint;
  readonly fiscalPeriodId: FiscalPeriodId;
  readonly policySnapshotHash: ContentHash;
  readonly quantizationPolicySnapshotHash: ContentHash;
  readonly canonicalHash: ContentHash;
  readonly derivations: ResolvedTransaction["derivations"];
}

/** Builds the only complete, immutable input admitted by the accounting-basis compiler. */
export function createAccountingReadSnapshot(
  state: BookState,
  policyEffectiveAt: Instant,
  sourcePostingPopulation: readonly CanonicalPostingReference[],
  sourceEvents: readonly BasisSourceEvent[],
): AccountingReadSnapshot {
  const sourcePopulationHash = hashAccountingBasisSourcePopulation(sourceEvents);
  const populationBody = Object.freeze({
    throughBookRevision: state.bookRevision,
    throughPostingSequence: state.latestPostingSequence,
    policyEffectiveAt,
    bookStateHash: state.contentHash,
    sourcePopulationHash,
    configurationSnapshot: state.activeConfigurationSnapshot,
    journals: state.journals,
    accountingState: state.accountingState,
    sourcePostingPopulation: Object.freeze([...sourcePostingPopulation]),
    sourceEvents: Object.freeze([...sourceEvents]),
  });
  const reportPopulationHash = hashAccountingReadPopulation(populationBody);
  const snapshotBody = Object.freeze({ ...populationBody, reportPopulationHash });
  return immutableAccountingValue({ ...snapshotBody, contentHash: hashAccountingReadSnapshot(snapshotBody) });
}

export interface CorrectionLink {
  readonly kind: "reversal" | "supersession";
  readonly originalJournalId: string;
  readonly correctionJournalId: string;
}

export interface BookedLotAllocation {
  readonly allocation: LotAllocation;
  readonly journalPostingId: PostingId;
  readonly kind: "disposal" | "transfer";
}

export type LotOperation =
  | {
      readonly type: "acquire";
      readonly lot: Lot;
      readonly holding: LotHolding;
      readonly journalPostingId: PostingId;
    }
  | {
      readonly type: "dispose";
      readonly holdingIds: readonly LotHoldingId[];
      readonly requestedQuantity: ExactRational;
      readonly selection: LotSelection;
      readonly derivation: ResolvedTransaction["derivations"][number];
      readonly identities: readonly LotAllocationIdentity[];
      readonly journalPostingId: PostingId;
    }
  | {
      readonly type: "transfer";
      readonly sourceHoldingIds: readonly LotHoldingId[];
      readonly destinationAccountId: JournalTransaction["postings"][number]["accountId"];
      readonly requestedQuantity: ExactRational;
      readonly selection: LotSelection;
      readonly policies: readonly TransferPolicy[];
      readonly governedAt: Instant;
      readonly derivation: ResolvedTransaction["derivations"][number];
      readonly allocationIdentities: readonly LotAllocationIdentity[];
      readonly destinationIdentities: readonly DestinationHoldingIdentity[];
      readonly sourcePostingId: PostingId;
      readonly destinationPostingId: PostingId;
    };

export function inventoryDisposalSelectionMatches(
  selection: LotSelection,
  method: InventoryCostPolicy["method"],
  allocations: readonly InventoryAllocationResult[],
): boolean {
  return selection.method === method && (
    selection.method !== "specificIdentification" ||
    selection.allocations.length === allocations.length &&
    selection.allocations.every((selected) => allocations.some((allocation) => allocation.layerId === selected.holdingId && allocation.quantity.equals(selected.quantity)))
  );
}

export interface LotStateEffect {
  readonly lots: readonly Lot[];
  readonly holdings: readonly LotHolding[];
  readonly allocations: readonly BookedLotAllocation[];
  readonly contentHash: ContentHash;
}

/** Owned command 1.2.0: immutable new lots and after-images of touched holdings.
 * Unmentioned lots, holdings and legacy allocations are preserved. Ownership
 * source/identity validation is required before this projection is admissible. */
export interface LotChangesEffect {
  readonly lots: readonly Lot[];
  readonly holdings: readonly LotHolding[];
  readonly contentHash: ContentHash;
}
export function hashLotChanges(lots: readonly Lot[], holdings: readonly LotHolding[]): ContentHash {
  return hashCanonical({ type: "LotChanges", lots: lots.map(lotValue), holdings: holdings.map(holdingValue) });
}
function applyLotChanges(lots: readonly Lot[], holdings: readonly LotHolding[], changes: LotChangesEffect) {
  const updated = new Map(holdings.map(holding => [holding.id, holding]));
  for (const holding of changes.holdings) updated.set(holding.id, holding);
  return { lots: Object.freeze([...lots, ...changes.lots]), holdings: Object.freeze([...updated.values()]) };
}

export interface ClosePackage {
  readonly id: ClosePackageId;
  readonly periodId: FiscalPeriodId;
  readonly cycle: bigint;
  readonly throughBookRevision: bigint;
  readonly throughPostingSequence: bigint;
  readonly ledgerHash: ContentHash;
  readonly chartHash: ContentHash;
  readonly bookingPolicySnapshotHash: ContentHash;
  readonly quantizationPolicySnapshotHash: ContentHash;
  readonly reportPopulationHash: ContentHash;
  readonly reportingPolicySnapshotHash: ContentHash;
  readonly configurationRevision: bigint;
  readonly configurationSnapshotHash: ContentHash;
  readonly configurationSnapshot: BookConfigurationSnapshot;
  readonly bookStateSnapshotHash: ContentHash;
  readonly closingJournalId?: string;
  readonly contentHash: ContentHash;
}

export interface PeriodTransition {
  readonly periodId: FiscalPeriodId;
  readonly kind: "close" | "reopen";
  readonly reason: string;
  readonly bookRevision: bigint;
  readonly recordedAt: Instant;
  readonly supersededCloseIds: readonly ClosePackageId[];
  readonly contentHash: ContentHash;
}

export type BookEffect =
  | {
      readonly type: "activation";
      readonly boundary: OpeningBoundary;
      readonly financialIdentityHash: ContentHash;
      readonly configurationHash: ContentHash;
      readonly configurationSnapshot: BookConfigurationSnapshot;
    }
  | {
      readonly type: "configuration";
      readonly expectedConfigurationRevision: bigint;
      readonly nextConfigurationRevision: bigint;
      readonly previousConfigurationHash: ContentHash;
      readonly effectiveOn: LocalDate;
      readonly periods: readonly FiscalPeriod[];
      readonly admissionSnapshot: JournalAdmissionSnapshot;
      readonly policies: readonly BookingPolicy[];
      readonly quantizationPolicies: readonly QuantizationPolicy[];
      readonly accountingPolicySnapshot: AccountingPolicySnapshot;
      readonly previousConfigurationSnapshot: BookConfigurationSnapshot;
      readonly resultingConfigurationSnapshot: BookConfigurationSnapshot;
      readonly contentHash: ContentHash;
    }
  | { readonly type: "journal"; readonly booked: BookedJournal }
  | { readonly type: "lotState"; readonly lotState: LotStateEffect }
  | { readonly type: "lotChanges"; readonly changes: LotChangesEffect }
  | { readonly type: "inventoryOwnership"; readonly value: InventoryOwnershipEffect }
  | { readonly type: "correction"; readonly link: CorrectionLink }
  | { readonly type: "periodTransition"; readonly transition: PeriodTransition }
  | { readonly type: "closePackage"; readonly closePackage: ClosePackage }
  | AccountingEffect;

export interface RevisionRecord {
  readonly bookId: BookId;
  readonly bookRevision: bigint;
  readonly previousHash: ContentHash | null;
  readonly effectsHash: ContentHash;
  readonly chainHash: ContentHash;
  readonly committedAt: Instant;
  readonly command: BookCommand;
  readonly effects: readonly BookEffect[];
}

export interface BookState {
  readonly identity: BookFinancialIdentity;
  readonly financialIdentityHash: ContentHash;
  readonly contentHash: ContentHash;
  readonly status: "configuring" | "open" | "closed" | "archived";
  readonly bookRevision: bigint;
  readonly latestPostingSequence: bigint;
  readonly configurationRevision: bigint;
  readonly configurationHash: ContentHash;
  readonly configurationSnapshots: readonly BookConfigurationSnapshot[];
  readonly activeConfigurationSnapshot: BookConfigurationSnapshot;
  readonly openingBoundary?: OpeningBoundary;
  readonly periods: readonly FiscalPeriod[];
  readonly admissionSnapshot: JournalAdmissionSnapshot;
  readonly policies: readonly BookingPolicy[];
  readonly quantizationPolicies: readonly QuantizationPolicy[];
  readonly accountingPolicySnapshot: AccountingPolicySnapshot;
  readonly accountingState: AccountingCanonicalState;
  readonly lots: readonly Lot[];
  readonly lotHoldings: readonly LotHolding[];
  readonly lotAllocations: readonly BookedLotAllocation[];
  /** Present only after explicit owned-inventory commands. A materialized view
   * of revision effects, not independent authority or an implicit legacy upgrade. */
  readonly inventoryOwnershipEffects?: readonly InventoryOwnershipEffect[];
  readonly journals: readonly BookedJournal[];
  readonly corrections: readonly CorrectionLink[];
  readonly periodTransitions: readonly PeriodTransition[];
  readonly closePackages: readonly ClosePackage[];
  readonly revisions: readonly RevisionRecord[];
}

interface CommandCore {
  readonly id: CommandId;
  readonly protocolVersion: SemanticVersion;
  readonly bookId: BookId;
  readonly expectedBookRevision: bigint;
  readonly issuedAt: Instant;
  readonly completedAt: Instant;
  readonly committedAt: Instant;
  readonly actorId: ActorId;
}

export interface ActivateBookCommand extends CommandCore {
  readonly type: "activateBook";
  readonly mode: "newZeroBalance" | "migration";
  readonly boundaryId: OpeningBoundaryId;
  readonly firstAccountingDate: LocalDate;
  readonly opening?: ResolvedTransaction;
  readonly lotOperations?: readonly LotOperation[];
}

export interface PostJournalCommand extends CommandCore {
  readonly type: "postJournal";
  readonly resolved: ResolvedTransaction;
  readonly fiscalPeriodId?: FiscalPeriodId;
  readonly lotOperations?: readonly LotOperation[];
}

export interface CorrectJournalCommand extends CommandCore {
  readonly type: "correctJournal";
  readonly correctionKind: "reversal" | "supersession";
  readonly originalJournalId: string;
  readonly resolved: ResolvedTransaction;
  readonly fiscalPeriodId?: FiscalPeriodId;
  readonly lotOperations?: readonly LotOperation[];
}

export interface ClosePeriodCommand extends CommandCore {
  readonly type: "closePeriod";
  readonly periodId: FiscalPeriodId;
  readonly closePackageId: ClosePackageId;
  readonly reason: string;
  readonly reportPopulationHash: ContentHash;
  readonly reportingPolicySnapshotHash: ContentHash;
  readonly closing?: ResolvedTransaction;
}

export interface ReopenPeriodCommand extends CommandCore {
  readonly type: "reopenPeriod";
  readonly periodId: FiscalPeriodId;
  readonly reason: string;
  readonly reversal?: ResolvedTransaction;
}

export interface ReplaceConfigurationCommand extends CommandCore {
  readonly type: "replaceConfiguration";
  readonly expectedConfigurationRevision: bigint;
  readonly effectiveOn: LocalDate;
  readonly periods: readonly FiscalPeriod[];
  readonly admissionSnapshot: JournalAdmissionSnapshot;
  readonly policies: readonly BookingPolicy[];
  readonly quantizationPolicies: readonly QuantizationPolicy[];
  readonly accountingPolicies: readonly AccountingPolicy[];
  readonly executionProfileAdoption?: ExecutionProfileAdoption;
}

interface GeneratedAccountingCommandCore extends CommandCore {
  readonly fiscalPeriodId?: FiscalPeriodId;
  readonly generatedPostingDimensionSelections?: readonly GeneratedPostingDimensionSelection[];
}

export interface GeneratedPostingDimensionSelection {
  readonly effectKey: string;
  readonly postingOrdinal: bigint;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
}

export interface PostInventoryTransactionCommand extends GeneratedAccountingCommandCore {
  readonly type: "postInventoryTransaction";
  readonly request: InventoryCostRequest;
  readonly inventoryAccountId: JournalTransaction["postings"][number]["accountId"];
  readonly costAccountId: JournalTransaction["postings"][number]["accountId"];
  readonly inventoryCommodityId: CommodityId;
  readonly provisionalLayerId?: ProvisionalInventoryLayer["id"];
  readonly derivation: ResolvedTransaction["derivations"][number];
  readonly lotOperations?: readonly LotOperation[];
}

export interface PostOwnedInventoryTransactionCommand extends CommandCore {
  readonly type: "postOwnedInventoryTransaction";
  readonly request: OwnedInventoryTransactionRequest;
}

export interface RecostProvisionalInventoryCommand extends GeneratedAccountingCommandCore {
  readonly type: "recostProvisionalInventory";
  readonly request: RecostInventoryRequest;
  readonly inventoryAccountId: JournalTransaction["postings"][number]["accountId"];
  readonly adjustmentAccountId: JournalTransaction["postings"][number]["accountId"];
}

export interface AdjustInventoryValueCommand extends GeneratedAccountingCommandCore {
  readonly type: "adjustInventoryValue";
  readonly request: InventoryValueAdjustmentRequest;
}

export interface RecognizeOpenItemCommand extends GeneratedAccountingCommandCore {
  readonly type: "recognizeOpenItem";
  readonly request: OpenItemRecognitionRequest;
  readonly resolved: ResolvedTransaction;
}

export interface ApplySettlementCommand extends GeneratedAccountingCommandCore {
  readonly type: "applySettlement";
  readonly request: SettlementRequest;
  readonly resolved: readonly ResolvedTransaction[];
}

export interface PostCurrencyRemeasurementCommand extends GeneratedAccountingCommandCore {
  readonly type: "postCurrencyRemeasurement";
  readonly request: CurrencyRemeasurementRequest;
}

export interface CreateAllocationScheduleCommand extends GeneratedAccountingCommandCore {
  readonly type: "createAllocationSchedule";
  readonly request: AllocationScheduleRequest;
}

export interface RecognizeScheduledAllocationCommand extends GeneratedAccountingCommandCore {
  readonly type: "recognizeScheduledAllocation";
  readonly request: AllocationRecognitionRequest;
}

export interface ReviseAllocationScheduleCommand extends GeneratedAccountingCommandCore {
  readonly type: "reviseAllocationSchedule";
  readonly request: AllocationScheduleRevisionRequest;
  /** Optional resolved disposal completion, committed atomically with the adjustment. */
  readonly disposalJournal?: ResolvedTransaction;
}

export interface PostTaxedTransactionCommand extends GeneratedAccountingCommandCore {
  readonly type: "postTaxedTransaction";
  readonly request: TaxRequest;
}

export interface CompileConsolidationCommand extends GeneratedAccountingCommandCore {
  readonly type: "compileConsolidation";
  readonly request: ConsolidationRequest;
}

export type UnsealedBookCommand =
  | ActivateBookCommand
  | PostJournalCommand
  | CorrectJournalCommand
  | ClosePeriodCommand
  | ReopenPeriodCommand
  | ReplaceConfigurationCommand
  | PostInventoryTransactionCommand
  | PostOwnedInventoryTransactionCommand
  | RecostProvisionalInventoryCommand
  | AdjustInventoryValueCommand
  | RecognizeOpenItemCommand
  | ApplySettlementCommand
  | PostCurrencyRemeasurementCommand
  | CreateAllocationScheduleCommand
  | RecognizeScheduledAllocationCommand
  | ReviseAllocationScheduleCommand
  | PostTaxedTransactionCommand
  | CompileConsolidationCommand;

export type BookCommand = UnsealedBookCommand & { readonly inputHash: ContentHash };

export interface BookCommitIntent {
  readonly command: BookCommand;
  readonly expectedBookRevision: bigint;
  readonly nextBookRevision: bigint;
  readonly resultingPostingSequence: bigint;
  readonly expectedConfigurationRevision: bigint;
  readonly nextConfigurationRevision: bigint;
  readonly resultingConfigurationHash: ContentHash;
  readonly effects: readonly BookEffect[];
  readonly canonicalHash: ContentHash;
}

export interface RetainedCommandResult {
  readonly command: BookCommand;
  readonly commandId: CommandId;
  readonly inputHash: ContentHash;
  readonly outcome: "committed" | "rejected";
  readonly observedBookRevision: bigint;
  readonly resultHash: ContentHash;
  readonly completedAt: Instant;
  readonly diagnostics: readonly SemanticDiagnostic[];
  readonly commitIntentHash?: ContentHash;
}

export interface BookProtocolState {
  readonly retainedResults: readonly RetainedCommandResult[];
}

export interface BookCommandResult {
  readonly disposition: "committed" | "rejected" | "replayed";
  readonly observedBookRevision: bigint;
  readonly resultHash: ContentHash;
  readonly diagnostics: readonly SemanticDiagnostic[];
  readonly completedAt: Instant;
  readonly committedAt?: Instant;
}

export interface AtomicBookCommit {
  readonly state: BookState;
  readonly protocol: BookProtocolState;
  readonly result: BookCommandResult;
  readonly intent?: BookCommitIntent;
  readonly committedAt?: Instant;
}

type Evaluation =
  | { readonly disposition: "ready"; readonly intent: BookCommitIntent }
  | {
      readonly disposition: "finished";
      readonly result: BookCommandResult;
      readonly retained?: RetainedCommandResult;
    };

function hashValue(hash: ContentHash): CanonicalValue {
  return {
    algorithm: hash.algorithm,
    canonicalizationVersion: hash.canonicalizationVersion,
    digest: hash.digest,
  };
}

function identityValue(identity: BookFinancialIdentity): CanonicalValue {
  return {
    type: "BookFinancialIdentity",
    bookId: identity.bookId,
    code: identity.code,
    ownerId: identity.ownerId,
    ownerKind: identity.ownerKind,
    kind: identity.kind,
    functionalCommodityId: identity.functionalCommodityId,
    primaryBasis: identity.primaryBasis,
    fiscalCalendarId: identity.fiscalCalendarId,
    accountingTimeZone: identity.accountingTimeZone,
  };
}

export function hashFinancialIdentity(identity: BookFinancialIdentity): ContentHash {
  return hashCanonical(identityValue(identity));
}

function immutableAdmissionSnapshot(snapshot: JournalAdmissionSnapshot): JournalAdmissionSnapshot {
  const requiredDimensionIdsByPosting = snapshot.requiredDimensionIdsByPosting === undefined
    ? undefined
    : Object.freeze(Object.fromEntries(
        Object.entries(snapshot.requiredDimensionIdsByPosting).map(([postingId, dimensionIds]) => [postingId, Object.freeze([...dimensionIds])]),
      ));
  return Object.freeze({
    ...snapshot,
    accounts: Object.freeze(snapshot.accounts.map((account) => Object.freeze({
      ...account,
      allowedCommodityIds: Object.freeze([...account.allowedCommodityIds]),
    }))),
    dimensions: Object.freeze(snapshot.dimensions.map((dimension) => Object.freeze({ ...dimension }))),
    dimensionMembers: Object.freeze(snapshot.dimensionMembers.map((member) => Object.freeze({ ...member }))),
    requiredDimensionIds: Object.freeze([...snapshot.requiredDimensionIds]),
    ...(requiredDimensionIdsByPosting === undefined ? {} : { requiredDimensionIdsByPosting }),
  });
}

function immutablePolicy(policy: BookingPolicy): BookingPolicy {
  return Object.freeze({
    ...policy,
    requiredDimensionIds: Object.freeze([...policy.requiredDimensionIds]),
    capability: Object.freeze({
      ...policy.capability,
      verificationEvidenceIds: Object.freeze([...policy.capability.verificationEvidenceIds]),
    }),
  });
}

function hashPeriods(periods: readonly FiscalPeriod[]): ContentHash {
  return hashCanonical({
    type: "FiscalPeriodSnapshot",
    periods: [...periods]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((period) => ({ ...period })),
  });
}

function hashQuantizationPolicies(policies: readonly QuantizationPolicy[]): ContentHash {
  return hashCanonical({
    type: "QuantizationPolicySnapshot",
    policyHashes: [...policies]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((policy) => hashValue(hashQuantizationPolicy(policy))),
  });
}

export function hashBookConfiguration(
  periods: readonly FiscalPeriod[],
  admissionSnapshot: JournalAdmissionSnapshot,
  policies: readonly BookingPolicy[],
  quantizationPolicies: readonly QuantizationPolicy[],
  accountingPolicies: readonly AccountingPolicy[] = [],
): ContentHash {
  const accountingPolicySnapshot = createAccountingPolicySnapshot(accountingPolicies);
  return hashCanonical({
    type: "BookConfiguration",
    periodsHash: hashValue(hashPeriods(periods)),
    chartHash: hashValue(hashChart(admissionSnapshot)),
    bookingPolicySnapshotHash: hashValue(hashPolicySnapshot(policies)),
    quantizationPolicySnapshotHashes: [...quantizationPolicies]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((policy) => hashValue(hashQuantizationPolicy(policy))),
    accountingPolicySnapshotHash: hashValue(accountingPolicySnapshot.contentHash),
  });
}

export function hashBookConfigurationSnapshot(snapshot: Omit<BookConfigurationSnapshot, "contentHash"> | BookConfigurationSnapshot): ContentHash {
  return hashCanonical({
    type: "BookConfigurationSnapshot",
    revision: snapshot.revision,
    effectiveAt: snapshot.effectiveAt,
    ...(snapshot.executionProfile === undefined ? {} : { executionProfile: snapshot.executionProfile }),
    ...(snapshot.stateCommitmentProfile === undefined ? {} : { stateCommitmentProfile: snapshot.stateCommitmentProfile }),
    configurationContentHash: hashValue(hashBookConfiguration(
      snapshot.periods,
      snapshot.admissionSnapshot,
      snapshot.policies,
      snapshot.quantizationPolicies,
      snapshot.accountingPolicySnapshot.policies,
    )),
    accountingPolicySnapshotHash: hashValue(snapshot.accountingPolicySnapshot.contentHash),
  });
}

function createBookConfigurationSnapshot(
  revision: bigint,
  effectiveAt: Instant,
  periods: readonly FiscalPeriod[],
  admissionSnapshot: JournalAdmissionSnapshot,
  policies: readonly BookingPolicy[],
  quantizationPolicies: readonly QuantizationPolicy[],
  accountingPolicySnapshot: AccountingPolicySnapshot,
  executionProfile?: BookExecutionProfile,
  stateCommitmentProfile?: BookStateCommitmentProfile,
): BookConfigurationSnapshot {
  const body = Object.freeze({ revision, effectiveAt, periods, admissionSnapshot, policies, quantizationPolicies, accountingPolicySnapshot, ...(executionProfile === undefined ? {} : { executionProfile }), ...(stateCommitmentProfile === undefined ? {} : { stateCommitmentProfile }) });
  return Object.freeze({ ...body, contentHash: hashBookConfigurationSnapshot(body) });
}

type HashableBookState = Omit<BookState, "contentHash">;

/** The commitment of a book that selected CHAIN_HEAD_STATE_COMMITMENT_PROFILE. It names the
 * scalars and the head of the revision chain, whose hash already covers every effect ever
 * committed, so its cost does not depend on the history. Every collection the legacy preimage
 * lists is materialized from those effects, and validateBookState proves that equality
 * whenever a state enters the kernel from outside. */
function hashChainHeadStateCommitment(state: HashableBookState | BookState): ContentHash {
  const revisions = revisionsOf(state);
  const head = revisions.at(-1);
  return hashCanonical({
    type: "BookStateChainHeadCommitment",
    profile: CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
    identityHash: hashValue(state.financialIdentityHash),
    status: state.status,
    bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision,
    configurationHash: hashValue(state.configurationHash),
    activeConfigurationSnapshotHash: hashValue(state.activeConfigurationSnapshot.contentHash),
    openingBoundaryHash: state.openingBoundary === undefined ? null : hashValue(state.openingBoundary.contentHash),
    revisionCount: BigInt(revisions.length),
    revisionChainHash: head === undefined ? null : hashValue(head.chainHash),
  });
}

/** The content hash of a state under the preimage its configuration selected. */
export function hashBookState(state: HashableBookState | BookState): ContentHash {
  if (state.activeConfigurationSnapshot.stateCommitmentProfile === CHAIN_HEAD_STATE_COMMITMENT_PROFILE) return hashChainHeadStateCommitment(state);
  return hashCanonical({
    type: "BookStateSnapshot",
    identityHash: hashValue(state.financialIdentityHash),
    status: state.status,
    bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision,
    configurationHash: hashValue(state.configurationHash),
    configurationSnapshotHashes: state.configurationSnapshots.map((snapshot) => hashValue(snapshot.contentHash)),
    activeConfigurationSnapshotHash: hashValue(state.activeConfigurationSnapshot.contentHash),
    openingBoundaryHash: state.openingBoundary === undefined ? null : hashValue(state.openingBoundary.contentHash),
    periodSnapshotHash: hashValue(hashPeriods(state.periods)),
    chartSnapshotHash: hashValue(hashChart(state.admissionSnapshot)),
    policySnapshotHash: hashValue(hashPolicySnapshot(state.policies)),
    quantizationPolicySnapshotHashes: state.quantizationPolicies.map((policy) => hashValue(hashQuantizationPolicy(policy))),
    accountingPolicySnapshotHash: hashValue(state.accountingPolicySnapshot.contentHash),
    accountingState: canonicalAccountingStateValue(state.accountingState),
    lots: state.lots.map(lotValue),
    lotHoldings: state.lotHoldings.map(holdingValue),
    lotAllocations: state.lotAllocations.map(allocationValue),
    ...(state.inventoryOwnershipEffects === undefined ? {} : { inventoryOwnershipEffects: canonicalAccountingValue(state.inventoryOwnershipEffects) }),
    journalEffects: journalsOf(state).map((booked) => canonicalBookEffectValue({ type: "journal", booked })),
    corrections: state.corrections.map((link) => ({ ...link })),
    periodTransitionHashes: state.periodTransitions.map((transition) => hashValue(transition.contentHash)),
    closePackageHashes: state.closePackages.map((closePackage) => hashValue(closePackage.contentHash)),
    revisionCount: BigInt(revisionsOf(state).length),
    revisionChainHash: latestRevisionRecord(state) === undefined ? null : hashValue(latestRevisionRecord(state)!.chainHash),
  });
}

function resolvedValue(resolved: ResolvedTransaction): CanonicalValue {
  return {
    journal: canonicalJournalValue(resolved.journal),
    policyApplications: [...resolved.policyApplications]
      .sort((left, right) => compareCanonicalText(left.postingId, right.postingId))
      .map((application) => ({ ...application })),
    policySnapshotHash: hashValue(resolved.policySnapshotHash),
    quantizationPolicySnapshotHash: hashValue(resolved.quantizationPolicySnapshotHash),
    quantizationPolicyHash: hashValue(hashQuantizationPolicy(resolved.quantizationPolicy)),
    exactBookValues: resolved.exactBookValues.map((value) => ({
      numerator: value.numerator,
      denominator: value.denominator,
    })),
    derivations: [...resolved.derivations]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map(canonicalDerivationValue),
  };
}

function rationalValue(value: ExactRational | undefined): CanonicalValue {
  return value === undefined ? { missing: true } : { numerator: value.numerator, denominator: value.denominator };
}

function lotValue(lot: Lot): CanonicalValue {
  return {
    id: lot.id,
    bookId: lot.bookId,
    commodityId: lot.commodityId,
    acquiredAt: lot.acquiredAt,
    acquisitionQuantity: rationalValue(lot.acquisitionQuantity),
    acquisitionTotalBasis: rationalValue(lot.acquisitionTotalBasis),
    basisCommodityId: lot.basisCommodityId,
    evidenceIds: [...lot.evidenceIds].sort(),
  };
}

function holdingValue(holding: LotHolding): CanonicalValue {
  return {
    id: holding.id,
    bookId: holding.bookId,
    lotId: holding.lotId,
    accountId: holding.accountId,
    commodityId: holding.commodityId,
    basisCommodityId: holding.basisCommodityId,
    remainingQuantity: rationalValue(holding.remainingQuantity),
    remainingTotalBasis: rationalValue(holding.remainingTotalBasis),
    remainingValuationAllowance: rationalValue(holding.remainingValuationAllowance),
    remainingCarryingAmount: rationalValue(holding.remainingCarryingAmount),
  };
}

function allocationValue(booked: BookedLotAllocation): CanonicalValue {
  return {
    id: booked.allocation.id,
    holdingId: booked.allocation.holdingId,
    lotId: booked.allocation.lotId,
    allocatedQuantity: rationalValue(booked.allocation.allocatedQuantity),
    allocatedTotalBasis: rationalValue(booked.allocation.allocatedTotalBasis),
    allocatedValuationAllowance: rationalValue(booked.allocation.allocatedValuationAllowance),
    allocatedCarryingAmount: rationalValue(booked.allocation.allocatedCarryingAmount),
    derivation: canonicalDerivationValue(booked.allocation.derivation),
    journalPostingId: booked.journalPostingId,
    kind: booked.kind,
  };
}

function selectionValue(selection: LotSelection): CanonicalValue {
  return selection.method === "specificIdentification"
    ? {
        method: selection.method,
        allocations: [...selection.allocations]
          .sort((left, right) => compareCanonicalText(left.holdingId, right.holdingId))
          .map((item) => ({ holdingId: item.holdingId, quantity: rationalValue(item.quantity) })),
      }
    : { method: selection.method };
}

function lotOperationValue(operation: LotOperation): CanonicalValue {
  if (operation.type === "acquire") {
    return { type: operation.type, lot: lotValue(operation.lot), holding: holdingValue(operation.holding), journalPostingId: operation.journalPostingId };
  }
  const common = {
    type: operation.type,
    requestedQuantity: rationalValue(operation.requestedQuantity),
    selection: selectionValue(operation.selection),
    derivation: canonicalDerivationValue(operation.derivation),
  };
  if (operation.type === "dispose") {
    return {
      ...common,
      holdingIds: [...operation.holdingIds].sort(),
      identities: [...operation.identities].sort((left, right) => compareCanonicalText(left.holdingId, right.holdingId))
        .map((identity) => ({ holdingId: identity.holdingId, allocationId: identity.allocationId })),
      journalPostingId: operation.journalPostingId,
    };
  }
  return {
    ...common,
    sourceHoldingIds: [...operation.sourceHoldingIds].sort(),
    destinationAccountId: operation.destinationAccountId,
    policies: [...operation.policies].sort((left, right) => compareCanonicalText(left.id, right.id)).map((policy) => ({
      id: policy.id,
      version: policy.version,
      bookId: policy.bookId,
      sourceAccountId: policy.sourceAccountId,
      destinationAccountId: policy.destinationAccountId,
      validFrom: policy.validFrom,
      validTo: policy.validTo ?? null,
      treatment: policy.treatment,
    })),
    governedAt: operation.governedAt,
    allocationIdentities: [...operation.allocationIdentities].sort((left, right) => compareCanonicalText(left.holdingId, right.holdingId))
      .map((identity) => ({ holdingId: identity.holdingId, allocationId: identity.allocationId })),
    destinationIdentities: [...operation.destinationIdentities].sort((left, right) => compareCanonicalText(left.sourceHoldingId, right.sourceHoldingId))
      .map((identity) => ({ sourceHoldingId: identity.sourceHoldingId, destinationHoldingId: identity.destinationHoldingId })),
    sourcePostingId: operation.sourcePostingId,
    destinationPostingId: operation.destinationPostingId,
  };
}

function commandValue(command: UnsealedBookCommand): CanonicalValue {
  const common = {
    id: command.id,
    protocolVersion: command.protocolVersion,
    bookId: command.bookId,
    expectedBookRevision: command.expectedBookRevision,
    issuedAt: command.issuedAt,
    completedAt: command.completedAt,
    committedAt: command.committedAt,
    actorId: command.actorId,
  };
  const generatedDimensions = "request" in command && command.type !== "postOwnedInventoryTransaction"
    ? [...(command.generatedPostingDimensionSelections ?? [])]
        .sort((left, right) => compareCanonicalText(left.effectKey, right.effectKey) || Number(left.postingOrdinal - right.postingOrdinal))
        .map((selection) => ({
          effectKey: selection.effectKey,
          postingOrdinal: selection.postingOrdinal,
          dimensionMemberIds: [...selection.dimensionMemberIds].sort(),
        }))
    : undefined;
  switch (command.type) {
    case "activateBook":
      return {
        type: command.type,
        ...common,
        mode: command.mode,
        boundaryId: command.boundaryId,
        firstAccountingDate: command.firstAccountingDate,
        opening: command.opening === undefined ? null : resolvedValue(command.opening),
        lotOperations: (command.lotOperations ?? []).map(lotOperationValue),
      };
    case "postJournal":
      return {
        type: command.type,
        ...common,
        resolved: resolvedValue(command.resolved),
        fiscalPeriodId: command.fiscalPeriodId ?? null,
        lotOperations: (command.lotOperations ?? []).map(lotOperationValue),
      };
    case "correctJournal":
      return {
        type: command.type,
        ...common,
        correctionKind: command.correctionKind,
        originalJournalId: command.originalJournalId,
        resolved: resolvedValue(command.resolved),
        fiscalPeriodId: command.fiscalPeriodId ?? null,
        lotOperations: (command.lotOperations ?? []).map(lotOperationValue),
      };
    case "closePeriod":
      return {
        type: command.type,
        ...common,
        periodId: command.periodId,
        closePackageId: command.closePackageId,
        reason: command.reason,
        reportPopulationHash: hashValue(command.reportPopulationHash),
        reportingPolicySnapshotHash: hashValue(command.reportingPolicySnapshotHash),
        closing: command.closing === undefined ? null : resolvedValue(command.closing),
      };
    case "reopenPeriod":
      return {
        type: command.type,
        ...common,
        periodId: command.periodId,
        reason: command.reason,
        reversal: command.reversal === undefined ? null : resolvedValue(command.reversal),
      };
    case "replaceConfiguration":
      return {
        type: command.type,
        ...common,
        effectiveOn: command.effectiveOn,
        expectedConfigurationRevision: command.expectedConfigurationRevision,
        configurationHash: hashValue(hashBookConfiguration(command.periods, command.admissionSnapshot, command.policies, command.quantizationPolicies, command.accountingPolicies)),
        ...(command.executionProfileAdoption === undefined ? {} : { executionProfileAdoption: canonicalAccountingValue(command.executionProfileAdoption) }),
      };
    case "postInventoryTransaction":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), inventoryAccountId: command.inventoryAccountId, costAccountId: command.costAccountId, inventoryCommodityId: command.inventoryCommodityId, provisionalLayerId: command.provisionalLayerId ?? null, derivation: canonicalDerivationValue(command.derivation), lotOperations: (command.lotOperations ?? []).map(lotOperationValue), fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions! };
    case "postOwnedInventoryTransaction":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request) };
    case "recostProvisionalInventory":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), inventoryAccountId: command.inventoryAccountId, adjustmentAccountId: command.adjustmentAccountId, fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions! };
    case "adjustInventoryValue":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions! };
    case "recognizeOpenItem":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), resolved: resolvedValue(command.resolved), fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions! };
    case "applySettlement":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), resolved: command.resolved.map(resolvedValue), fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions! };
    case "postCurrencyRemeasurement":
    case "createAllocationSchedule":
    case "recognizeScheduledAllocation":
    case "postTaxedTransaction":
    case "compileConsolidation":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions! };
    case "reviseAllocationSchedule":
      return { type: command.type, ...common, request: canonicalAccountingValue(command.request), fiscalPeriodId: command.fiscalPeriodId ?? null, generatedPostingDimensionSelections: generatedDimensions!, ...(command.disposalJournal === undefined ? {} : { disposalJournal: resolvedValue(command.disposalJournal) }) };
  }
}

export function commandInputHash(command: UnsealedBookCommand): ContentHash {
  return hashCanonical(commandValue(command));
}

export function sealCommand<T extends UnsealedBookCommand>(command: T): T & { readonly inputHash: ContentHash } {
  return Object.freeze({ ...command, inputHash: commandInputHash(command) }) as unknown as T & {
    readonly inputHash: ContentHash;
  };
}

export function createBookState(
  identity: BookFinancialIdentity,
  periods: readonly FiscalPeriod[],
  admissionSnapshot: JournalAdmissionSnapshot,
  policies: readonly BookingPolicy[],
  quantizationPolicies: readonly QuantizationPolicy[],
  accountingPolicies: readonly AccountingPolicy[],
  configuredAt: Instant,
  executionProfile?: BookExecutionProfile,
  stateCommitmentProfile?: BookStateCommitmentProfile,
): BookState {
  if (executionProfile !== undefined && executionProfile !== STRUCTURAL_SOURCE_IDENTITY_PROFILE) throw new TypeError("Unsupported book execution profile");
  if (stateCommitmentProfile !== undefined && stateCommitmentProfile !== CHAIN_HEAD_STATE_COMMITMENT_PROFILE) throw new TypeError("Unsupported book state commitment profile");
  const immutableAdmission = immutableAdmissionSnapshot(admissionSnapshot);
  const immutablePolicies = Object.freeze(policies.map(immutablePolicy));
  const immutableQuantizationPolicies = Object.freeze(quantizationPolicies.map((policy) => Object.freeze({ ...policy })));
  const immutablePeriods = Object.freeze(periods.map((period) => Object.freeze({ ...period })));
  const accountingPolicySnapshot = createAccountingPolicySnapshot(accountingPolicies);
  const activeConfigurationSnapshot = createBookConfigurationSnapshot(0n, configuredAt, immutablePeriods, immutableAdmission, immutablePolicies, immutableQuantizationPolicies, accountingPolicySnapshot, executionProfile, stateCommitmentProfile);
  // Every part of this snapshot was frozen above and its hash computed over exactly these parts.
  markVerifiedSnapshot(activeConfigurationSnapshot);
  const configurationHash = activeConfigurationSnapshot.contentHash;
  const stateWithoutHash: HashableBookState = {
    identity: Object.freeze({ ...identity }),
    financialIdentityHash: hashFinancialIdentity(identity),
    status: "configuring",
    bookRevision: 0n,
    latestPostingSequence: 0n,
    configurationRevision: 0n,
    configurationHash,
    configurationSnapshots: Object.freeze([activeConfigurationSnapshot]),
    activeConfigurationSnapshot,
    periods: immutablePeriods,
    admissionSnapshot: immutableAdmission,
    policies: immutablePolicies,
    quantizationPolicies: immutableQuantizationPolicies,
    accountingPolicySnapshot,
    accountingState: emptyAccountingCanonicalState(),
    lots: Object.freeze([]),
    lotHoldings: Object.freeze([]),
    lotAllocations: Object.freeze([]),
    journals: Object.freeze([]),
    corrections: Object.freeze([]),
    periodTransitions: Object.freeze([]),
    closePackages: Object.freeze([]),
    revisions: Object.freeze([]),
  };
  return Object.freeze({ ...stateWithoutHash, contentHash: hashBookState(stateWithoutHash) });
}

export function createBookProtocolState(): BookProtocolState {
  return Object.freeze({ retainedResults: Object.freeze([]) });
}

export function commandTimelineIsValid(issuedAt: Instant, completedAt: Instant, committedAt: Instant, previousCommittedAt?: Instant): boolean {
  return Date.parse(issuedAt) <= Date.parse(completedAt) &&
    Date.parse(completedAt) <= Date.parse(committedAt) &&
    (previousCommittedAt === undefined || Date.parse(previousCommittedAt) <= Date.parse(committedAt));
}

function periodIsClosed(state: BookState, periodId: FiscalPeriodId): boolean {
  let closed = false;
  for (const transition of state.periodTransitions) {
    if (transition.periodId === periodId) closed = transition.kind === "close";
  }
  return closed;
}

function closeIsCurrent(state: BookState, closeId: ClosePackageId): boolean {
  return !state.periodTransitions.some(
    (transition) => transition.kind === "reopen" && transition.supersededCloseIds.includes(closeId),
  );
}

function validatePeriods(state: Pick<BookState, "identity" | "periods">): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const ids = new Set<string>();
  const regular = state.periods
    .filter((period) => period.kind === "regular")
    .sort((left, right) => compareCanonicalText(left.startsOn, right.startsOn) || compareCanonicalText(left.id, right.id));
  // The period objects that carry each sequence, so that "another period has this sequence" is a lookup and
  // not a search of every period for every period (which made each command cost the square of the calendar).
  const sequenceOwners = new Map<bigint, Set<FiscalPeriod>>();
  for (const period of state.periods) {
    const owners = sequenceOwners.get(period.sequence);
    if (owners === undefined) sequenceOwners.set(period.sequence, new Set([period]));
    else owners.add(period);
  }
  for (const [index, period] of state.periods.entries()) {
    if (ids.has(period.id) || period.calendarId !== state.identity.fiscalCalendarId) {
      diagnostics.push(
        diagnostic(
          "fiscal_period_admission",
          `periods[${index}]`,
          "Period identity is duplicated or belongs to another fiscal calendar",
          ["ACC-027", "ACC-029", "ACC-038"],
        ),
      );
    }
    ids.add(period.id);
    if (period.startsOn > period.endsOn) {
      diagnostics.push(
        diagnostic(
          "fiscal_period_admission",
          `periods[${index}]`,
          "Fiscal period ends before it starts",
          ["ACC-013", "ACC-029"],
        ),
      );
    }
    if (period.sequence <= 0n || (period.sequence === period.sequence && sequenceOwners.get(period.sequence)!.size > 1)) {
      diagnostics.push(
        diagnostic(
          "fiscal_period_admission",
          `periods[${index}].sequence`,
          "Fiscal period sequences must be positive and unique within the calendar",
          ["ACC-029", "ACC-038"],
        ),
      );
    }
  }
  // The regular periods are ordered by start, so the ones that start no later than a period ends follow it
  // without a gap; reading on from it and stopping at the first that starts later finds every overlap.
  for (const [index, left] of regular.entries()) {
    for (let next = index + 1; next < regular.length && regular[next]!.startsOn <= left.endsOn; next += 1) {
      diagnostics.push(
        diagnostic(
          "fiscal_period_admission",
          "periods",
          `Regular periods ${left.id} and ${regular[next]!.id} overlap`,
          ["ACC-029"],
        ),
      );
    }
  }
  for (const [index, current] of regular.slice(1).entries()) {
    const previous = regular[index]!;
    const expectedStart = new Date(Date.parse(`${previous.endsOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (current.startsOn !== expectedStart) {
      diagnostics.push(
        diagnostic(
          "fiscal_period_admission",
          "periods",
          `Regular periods ${previous.id} and ${current.id} are not gap-free`,
          ["ACC-029"],
        ),
      );
    }
  }
  return diagnostics;
}

export type BookConfigurationReadContext = Pick<BookState, "identity" | "periods" | "admissionSnapshot" | "policies" | "quantizationPolicies" | "accountingPolicySnapshot">;

/** Chart/calendar/policy semantics only. No execution-profile selection, snapshot
 * authenticity, state integrity, command admission or publication is established. */
export function validateBookConfiguration(state: BookConfigurationReadContext): readonly SemanticDiagnostic[] {
  return Object.freeze([...validatePeriods(state), ...validateConfiguration(state)]);
}

function configurationProfileTransitionIsValid(previous: BookConfigurationSnapshot, next: string | undefined, adoption?: ExecutionProfileAdoption): boolean {
  if (adoption === undefined) return next === previous.executionProfile;
  try {
    return previous.executionProfile === undefined && adoption.from === "legacy" &&
      adoption.to === STRUCTURAL_SOURCE_IDENTITY_PROFILE && next === adoption.to &&
      contentHashEquals(adoption.expectedConfigurationHash, previous.contentHash) &&
      typeof adoption.reason === "string" && adoption.reason.trim().length > 0 &&
      adoption.reason.length <= BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS.maxReasonCodePoints * 2 &&
      [...adoption.reason].length <= BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS.maxReasonCodePoints &&
      Array.isArray(adoption.evidenceIds) && adoption.evidenceIds.length > 0 &&
      adoption.evidenceIds.length <= BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS.maxEvidenceIds &&
      new Set(adoption.evidenceIds).size === adoption.evidenceIds.length &&
      adoption.evidenceIds.every((id) => identifier(id) === id);
  } catch { return false; }
}

function validateBookExecutionProfile(state: BookState, trusted = false): readonly SemanticDiagnostic[] {
  const active = state.activeConfigurationSnapshot;
  const profile = active.executionProfile;
  // Admission may reuse the verification of a snapshot object the kernel itself verified and
  // froze (see verified-snapshots.ts); restoring a state never does and recomputes every hash.
  const hashMatches = (snapshot: BookConfigurationSnapshot) => {
    const rehash = () => contentHashEquals(hashBookConfigurationSnapshot(snapshot), snapshot.contentHash);
    return trusted ? verifiedOr(snapshot, rehash) : rehash();
  };
  let valid = false;
  try {
    valid = (profile === undefined || profile === STRUCTURAL_SOURCE_IDENTITY_PROFILE) &&
      state.configurationSnapshots.length > 0 &&
      contentHashEquals(state.configurationHash, active.contentHash) &&
      hashMatches(active) &&
      contentHashEquals(state.configurationSnapshots.at(-1)!.contentHash, active.contentHash) &&
      state.configurationSnapshots.every((snapshot, index) => {
        if (snapshot.revision !== BigInt(index) ||
          (snapshot.executionProfile !== undefined && snapshot.executionProfile !== STRUCTURAL_SOURCE_IDENTITY_PROFILE) ||
          !hashMatches(snapshot)) return false;
        const previous = state.configurationSnapshots[index - 1];
        if (previous === undefined || previous.executionProfile === snapshot.executionProfile) return true;
        // The index only narrows to the revisions that name this configuration revision; the test is unchanged.
        const origins = revisionLogOf(state).all("configuration", String(previous.revision)).filter((revision) => revision.command.type === "replaceConfiguration" &&
          revision.command.expectedConfigurationRevision === previous.revision);
        const origin = origins[0];
        if (origins.length !== 1 || origin?.command.type !== "replaceConfiguration" ||
          !contentHashEquals(commandInputHash(origin.command), origin.command.inputHash) ||
          !configurationProfileTransitionIsValid(previous, snapshot.executionProfile, origin.command.executionProfileAdoption)) return false;
        const effect = origin.effects[0];
        return origin.effects.length === 1 && effect?.type === "configuration" &&
          contentHashEquals(effect.previousConfigurationHash, previous.contentHash) &&
          contentHashEquals(effect.resultingConfigurationSnapshot.contentHash, snapshot.contentHash) &&
          contentHashEquals(effect.contentHash, snapshot.contentHash);
      });
  } catch { valid = false; }
  return valid ? Object.freeze([]) : Object.freeze([diagnostic(
    "ordered_history_violation", "state.executionProfile",
    "Book execution profile must be supported, hash-bound and selected by genesis or an explicit monotonic configuration transition",
    ["ACC-014", "ACC-031", "ACC-034", "ACC-038"],
  )]);
}

/** The state commitment profile is chosen by the genesis snapshot and never changes: every
 * retained snapshot and the active one carry the same supported marker, or none carries one. The
 * marker is part of each snapshot's hash, which validateBookExecutionProfile checks first. */
function validateBookStateCommitmentProfile(state: BookState): readonly SemanticDiagnostic[] {
  let valid = false;
  try {
    const selected = state.configurationSnapshots[0]?.stateCommitmentProfile;
    valid = (selected === undefined || selected === CHAIN_HEAD_STATE_COMMITMENT_PROFILE) &&
      state.activeConfigurationSnapshot.stateCommitmentProfile === selected &&
      state.configurationSnapshots.every((snapshot) => snapshot.stateCommitmentProfile === selected);
  } catch { valid = false; }
  return valid ? Object.freeze([]) : Object.freeze([diagnostic(
    "ordered_history_violation", "state.stateCommitmentProfile",
    "Book state commitment profile must be supported, hash-bound and selected by genesis; it cannot be adopted, changed or removed later",
    ["ACC-014", "ACC-031", "ACC-034", "ACC-038"],
  )]);
}

/** Both profile selections, in the order admission and restoration report them. The commitment
 * profile is judged only once the execution profile and every snapshot hash are sound. */
function validateBookProfileSelection(state: BookState, trusted = false): readonly SemanticDiagnostic[] {
  const execution = validateBookExecutionProfile(state, trusted);
  return execution.length > 0 ? execution : validateBookStateCommitmentProfile(state);
}

/** O(1) coherence of a chain-head state, the part of its admission that the commitment alone does
 * not give: the counters agree with the collection lengths and the head revision, and the latest
 * journal is the one the revision that booked it records. The commitment names the counters and
 * the head, not the collections, so this is what ties the visible journal list back to the chain. */
function chainHeadStateIsCoherent(state: BookState): boolean {
  const revisions = revisionsOf(state);
  const journals = journalsOf(state);
  const head = revisions.at(-1);
  if (
    state.bookRevision !== BigInt(revisions.length) ||
    (head !== undefined && head.bookRevision !== state.bookRevision) ||
    state.latestPostingSequence !== BigInt(journals.length) ||
    BigInt(state.configurationSnapshots.length) !== state.configurationRevision + 1n
  ) return false;
  const latest = journals.at(-1);
  if (latest === undefined) return true;
  // Revisions are gap-free from 1, so the revision that booked a journal sits at its own index.
  const booking = revisions.at(Number(latest.bookRevision) - 1);
  const recorded = booking?.effects.filter(isJournalEffect).at(-1);
  return latest.postingSequence === state.latestPostingSequence &&
    booking?.bookRevision === latest.bookRevision && recorded !== undefined &&
    (recorded.booked === latest || contentHashEquals(
      hashCanonical(canonicalBookEffectValue({ type: "journal", booked: latest })),
      hashCanonical(canonicalBookEffectValue(recorded)),
    ));
}

/** The state-hash step of admission. A book without the profile re-derives its complete
 * population hash, exactly as before. A book with it answers in time independent of its history. */
function validateStateHashAtAdmission(state: BookState): readonly SemanticDiagnostic[] {
  let profiled = false;
  try { profiled = state.activeConfigurationSnapshot.stateCommitmentProfile === CHAIN_HEAD_STATE_COMMITMENT_PROFILE; } catch { profiled = false; }
  if (profiled) {
    let coherent = false;
    try { coherent = chainHeadStateIsCoherent(state); } catch { coherent = false; }
    if (!coherent) return Object.freeze([diagnostic(
      "ordered_history_violation", "state",
      "Book state counters, head revision or latest journal do not match its revision chain",
      ["ACC-031", "ACC-034", "ACC-038"],
    )]);
  }
  let stateHash: ContentHash | undefined;
  try { stateHash = hashBookState(state); } catch { stateHash = undefined; }
  if (stateHash !== undefined && contentHashEquals(stateHash, state.contentHash)) return Object.freeze([]);
  return Object.freeze([diagnostic(
    "ordered_history_violation", "state.contentHash",
    profiled
      ? "Book state does not reproduce its chain-head content hash"
      : "Book state does not reproduce its complete canonical content hash",
    ["ACC-031", "ACC-034", "ACC-038"],
  )]);
}

/** A chain-head commitment names only the active snapshot, so the retained snapshot list is proven
 * against the chain here: after the genesis snapshot (which the first configuration effect pins by
 * hash in the revision loop of validateBookState) it must hold, in order, exactly what each
 * configuration effect produced. The legacy preimage covered this list; without this check a
 * profiled book would not. */
function validateRetainedConfigurationSnapshots(state: BookState): readonly SemanticDiagnostic[] {
  let valid = true;
  try {
    if (state.activeConfigurationSnapshot.stateCommitmentProfile === CHAIN_HEAD_STATE_COMMITMENT_PROFILE) {
      const changes = state.revisions.flatMap((revision) => revision.effects)
        .filter((effect): effect is Extract<BookEffect, { readonly type: "configuration" }> => effect.type === "configuration");
      valid = changes.length + 1 === state.configurationSnapshots.length &&
        changes.every((effect, index) => contentHashEquals(effect.contentHash, state.configurationSnapshots[index + 1]!.contentHash));
    }
  } catch { valid = false; }
  return valid ? Object.freeze([]) : Object.freeze([diagnostic(
    "ordered_history_violation", "state.configurationSnapshots",
    "Retained configuration snapshots do not match the configuration effects of the revision chain",
    ["ACC-014", "ACC-031", "ACC-034", "ACC-038"],
  )]);
}

function validateConfiguration(state: BookConfigurationReadContext): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  if (state.admissionSnapshot.accounts.length === 0 || state.policies.length === 0 || state.quantizationPolicies.length === 0 || state.periods.length === 0) {
    diagnostics.push(
      diagnostic(
        "unresolved_accounting_input",
        "state.configuration",
        "Activation requires at least one account, one booking policy, one quantization policy, and one fiscal period",
        ["ACC-005", "ACC-011", "ACC-014", "ACC-029"],
      ),
    );
  }
  const quantizationIdentities = new Set<string>();
  for (const [index, quantization] of state.quantizationPolicies.entries()) {
    const key = `${quantization.id}@${quantization.version}`;
    if (
      quantizationIdentities.has(key) ||
      quantization.bookId !== state.identity.bookId ||
      quantization.functionalCommodityId !== state.identity.functionalCommodityId ||
      (quantization.validTo !== undefined && quantization.validFrom >= quantization.validTo) ||
      !state.admissionSnapshot.accounts.some((account) => account.id === quantization.roundingAccountId)
    ) {
      diagnostics.push(diagnostic("policy_ambiguity", `quantizationPolicies[${index}]`, "Quantization policy identity, scope, interval, or rounding account is invalid", ["ACC-003", "ACC-011", "ACC-013", "ACC-026", "ACC-038"]));
    }
    quantizationIdentities.add(key);
  }
  const policyContent = new Map<string, string>();
  for (const [index, policy] of state.policies.entries()) {
    const key = `${policy.id}@${policy.version}`;
    const content = JSON.stringify(canonicalPolicyValue(policy));
    if (policy.validTo !== undefined && compareInstants(policy.validFrom, policy.validTo) >= 0) {
      diagnostics.push(diagnostic("policy_ambiguity", `policies[${index}].validTo`, "Policy validity interval is empty or reversed", ["ACC-011", "ACC-013"]));
    }
    const existing = policyContent.get(key);
    if (existing !== undefined && existing !== content) {
      diagnostics.push(diagnostic("canonical_identity_conflict", `policies[${index}]`, `Policy identity ${key} has conflicting complete content`, ["ACC-011", "ACC-038"]));
    } else if (existing !== undefined) {
      diagnostics.push(diagnostic("canonical_identity_conflict", `policies[${index}]`, `Policy identity ${key} is duplicated`, ["ACC-011", "ACC-038"]));
    }
    policyContent.set(key, content);
  }
  const accountingIdentities = new Set<string>();
  try {
    if (!contentHashEquals(createAccountingPolicySnapshot(state.accountingPolicySnapshot.policies).contentHash, state.accountingPolicySnapshot.contentHash)) {
      diagnostics.push(diagnostic("ordered_history_violation", "accountingPolicySnapshot.contentHash", "Accounting policy snapshot hash does not reproduce its complete policies", ["ACC-047.1", "ACC-047.3"]));
    }
  } catch {
    diagnostics.push(diagnostic("policy_ambiguity", "accountingPolicySnapshot", "Accounting policy artifacts must carry their modeled identities and reproducible content hashes", ["ACC-047.1", "ACC-047.3"]));
  }
  for (const [index, policy] of state.accountingPolicySnapshot.policies.entries()) {
    const key = `${policy.kind}:${policy.id}@${policy.version}`;
    const quantizationMatches = state.quantizationPolicies.filter((candidate) =>
      candidate.id === policy.quantizationPolicy.id &&
      candidate.version === policy.quantizationPolicy.version &&
      candidate.bookId === state.identity.bookId &&
      candidate.functionalCommodityId === state.identity.functionalCommodityId,
    );
    const quantizationMatchesPolicy = quantizationMatches.length === 1;
    const linkedInventoryMatches = policy.kind === "inventoryValueAdjustment"
      ? state.accountingPolicySnapshot.policies.filter((candidate): candidate is InventoryCostPolicy =>
        candidate.kind === "inventoryCost" && candidate.id === policy.inventoryCostPolicyId && candidate.version === policy.inventoryCostPolicyVersion &&
        compareInstants(candidate.validFrom, policy.validFrom) <= 0 && (candidate.validTo === undefined || compareInstants(policy.validFrom, candidate.validTo) < 0),
      ).length === 1
      : true;
    if (
      accountingIdentities.has(key) || policy.bookId !== state.identity.bookId ||
      policy.capability.feature !== policy.kind || policy.capability.status !== "supported" ||
      policy.capability.implementationVersion !== policy.algorithmVersion || policy.capability.verificationEvidenceIds.length === 0 ||
      policy.quantizationPolicy.bookId !== state.identity.bookId || policy.quantizationPolicy.functionalCommodityId !== state.identity.functionalCommodityId ||
      !quantizationMatchesPolicy || !linkedInventoryMatches ||
      (policy.validTo !== undefined && compareInstants(policy.validFrom, policy.validTo) >= 0) || !accountingPolicyCapabilityIsExecutable(policy)
    ) diagnostics.push(diagnostic("policy_ambiguity", `accountingPolicySnapshot.policies[${index}]`, "Accounting policy identity, scope, capability, validity, or quantization is incomplete", ["ACC-039.1", "ACC-047.1", "ACC-047.5"]));
    accountingIdentities.add(key);
  }
  if (!isKnownIanaTimeZone(state.identity.accountingTimeZone)) {
    diagnostics.push(diagnostic("immutable_book_identity", "state.identity.accountingTimeZone", "Accounting timezone is not an IANA time-zone identifier in the pinned tzdata table", ["ACC-013", "ACC-027"]));
  }
  return diagnostics;
}

export function accountingPolicyCapabilityIsExecutable(policy: AccountingPolicy): boolean {
  const admitted = accountingCapabilityAdmits(policy.capability, accountingPolicyCombination(policy));
  switch (policy.kind) {
    case "inventoryCost":
      return admitted && policy.pools.length > 0 && new Set(policy.pools.map((pool) => pool.accountId)).size === policy.pools.length && new Set(policy.pools.map((pool) => pool.id)).size === policy.pools.length &&
        (policy.shortageTreatment === "reject"
          ? policy.provisionalBasisMethod === undefined && policy.provisionalRate === undefined
          : policy.provisionalBasisMethod !== undefined && (policy.provisionalBasisMethod === "lastReceiptCost" || policy.provisionalBasisMethod === "movingAverage" || policy.provisionalRate !== undefined && !policy.provisionalRate.isNegative() && !policy.provisionalRate.isZero()));
    case "inventoryValueAdjustment":
      return admitted && supportsInventoryValueAdjustmentAlgorithm(policy.algorithmVersion) && policy.allowedKinds.length > 0 && new Set(policy.allowedKinds).size === policy.allowedKinds.length &&
        policy.allowedKinds.every((kind) => ["directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"].includes(kind)) &&
        policy.inventoryAccountId !== policy.recognizedCostAccountId &&
        policy.inventoryAccountId !== policy.adjustmentAccountId &&
        policy.recognizedCostAccountId !== policy.adjustmentAccountId;
    case "accountingBasis":
      return admitted && policy.rules.length > 0 && new Set(policy.rules.map((rule) => rule.event)).size === policy.rules.length && new Set(policy.rules.map((rule) => rule.id)).size === policy.rules.length;
    case "monetaryClassification":
      return admitted && policy.rules.length > 0 && new Set(policy.rules.map((rule) => rule.accountId)).size === policy.rules.length;
    case "currencyRemeasurement":
      return admitted && policy.gainAccountId !== policy.lossAccountId;
    case "allocationSchedule":
      return admitted && (policy.postingAlgorithm === undefined || usesCumulativeAllocation(policy) && policy.allocationAccountId !== policy.contraAccountId) && (
        policy.method === "unitsOfProduction"
          ? policy.frequency === "eventDriven" && policy.convention === "usageEvent" && policy.expectedUsage !== undefined && !policy.expectedUsage.isNegative() && !policy.expectedUsage.isZero()
          : (policy.frequency === "monthly" || policy.frequency === "quarterly" || policy.frequency === "annual") && policy.convention === "fullPeriod" && (policy.method === "straightLine" || policy.decliningRate !== undefined && !policy.decliningRate.isNegative() && !policy.decliningRate.isZero() && policy.decliningRate.compare(ExactRational.of(1n, 1n)) <= 0)
      );
    case "taxDetermination":
      return (
        admitted &&
        (policy.groupingAlgorithm === undefined || usesStructuralTaxGrouping(policy)) &&
        (policy.roundingLevel === "lineLevel" || policy.roundingLevel === "documentLevel") &&
        policy.taxCode.trim().length > 0 &&
        policy.jurisdiction.trim().length > 0 &&
        policy.components.length > 0 &&
        new Set(policy.components.map((component) => component.id)).size === policy.components.length
      );
    case "consolidation":
      return policy.supportedMethods.length > 0 && new Set(policy.supportedMethods).size === policy.supportedMethods.length && policy.supportedMethods.every((method) => accountingCapabilityAdmits(policy.capability, { method })) && policy.accountMappings.length > 0 && policy.translationRules.length > 0 && policy.valuationPolicy.maximumHops > 0n;
  }
}

export function resolveRecostingPeriod(periods: readonly FiscalPeriod[], recostingDate: LocalDate, explicitPeriodId?: FiscalPeriodId): FiscalPeriod | undefined {
  return explicitPeriodId === undefined
    ? periods.find((period) => period.kind === "regular" && period.startsOn <= recostingDate && recostingDate <= period.endsOn)
    : periods.find((period) => period.id === explicitPeriodId && period.startsOn <= recostingDate && recostingDate <= period.endsOn);
}

/** Complete period configuration and closure results at one book head.
 * These are mathematical inputs, not storage or authorization proofs. */
export interface BookAccountingPeriodReadContext {
  /** Complete, previously validated same-book fiscal-period catalog. */
  readonly periods: readonly FiscalPeriod[];
  periodStatus(id: FiscalPeriodId): "open" | "closed";
}

/** Complete configuration and explicit lookup results for ONE journal's
 * admission. The ledger must authenticate their complete populations and keep
 * its live read context through publication. No command/protocol admission is implied. */
export interface BookJournalReadContext extends Pick<BookState, "identity" | "admissionSnapshot" | "policies" | "quantizationPolicies">, BookAccountingPeriodReadContext {
  journalIdentity(id: JournalTransaction["id"]): "present" | "absent";
  postingIdentity(id: PostingId): "present" | "absent";
  /** Optional batched equivalent of postingIdentity, for generated journals.
   * Every requested identity must have an explicit observation at the same head. */
  // The optional journal permits batching related money-scope reads; it does
  // not authorize postings or replace the required identity observations.
  readPostingIdentities?(ids: readonly PostingId[], journal?: JournalTransaction): ReadonlyMap<PostingId, "present" | "absent">;
}

function journalIdentityPresent(value: unknown): boolean {
  if (value !== "present" && value !== "absent") throw new TypeError("Incomplete journal identity evidence");
  return value === "present";
}

/** Shared fiscal-period selection, independent of journal existence or value.
 * The caller supplies a complete validated same-book catalog, a validated date,
 * and authenticated closure facts at its pinned head. This is not command,
 * opening-boundary, account/dimension, correction or publication admission.
 * allowClosed is only a semantic mode for separately governed commands, never
 * authorization supplied by an external request. Legacy diagnostic text/paths
 * remain unchanged so existing journal rejection receipts remain reproducible. */
export function resolveBookAccountingPeriod(
  state: BookAccountingPeriodReadContext,
  activity: Pick<JournalTransaction, "accountingDate" | "kind">,
  explicitPeriodId: FiscalPeriodId | undefined,
  allowClosed: boolean,
): FiscalPeriod | SemanticDiagnostic {
  const regular = state.periods.filter(
    (period) =>
      period.kind === "regular" &&
      period.startsOn <= activity.accountingDate &&
      activity.accountingDate <= period.endsOn,
  );
  if (regular.length !== 1) {
    return diagnostic(
      "fiscal_period_admission",
      "journal.accountingDate",
      `Accounting date must resolve to exactly one regular fiscal period; found ${regular.length}`,
      ["ACC-029"],
    );
  }
  let selected = regular[0];
  if (selected === undefined) throw new Error("Regular period cardinality changed");
  if (explicitPeriodId !== undefined) {
    const explicit = state.periods.find((period) => period.id === explicitPeriodId);
    if (
      explicit === undefined ||
      explicit.startsOn > activity.accountingDate ||
      explicit.endsOn < activity.accountingDate ||
      (explicit.kind === "adjustment" && activity.kind !== "adjustment" && activity.kind !== "closing")
    ) {
      return diagnostic(
        "fiscal_period_admission",
        "fiscalPeriodId",
        "Explicit fiscal period does not admit this journal date and kind",
        ["ACC-029"],
      );
    }
    selected = explicit;
  }
  const status = allowClosed ? "open" : state.periodStatus(selected.id);
  if (status !== "open" && status !== "closed") throw new TypeError("Incomplete period closure evidence");
  if (status === "closed") {
    return diagnostic(
      "fiscal_period_admission",
      "fiscalPeriodId",
      `Fiscal period ${selected.id} is closed`,
      ["ACC-029", "ACC-032"],
    );
  }
  return selected;
}

/** Exact legacy LedgerCutoff commitment, with constant buffering. The caller
 * supplies the complete journal population in posting-sequence order from one
 * admitted snapshot. Gaps, duplicates and malformed hashes are storage failures,
 * never zero balances or a different accepted close package. */
export function hashBookLedgerCutoff(
  bookId: BookId, bookRevision: bigint, postingSequence: bigint,
  journals: Iterable<Pick<BookedJournal, "postingSequence" | "canonicalHash">>,
): ContentHash {
  function* hashes(): Iterable<CanonicalValue> {
    let expected = 1n;
    for (const journal of journals) {
      if (journal.postingSequence !== expected || journal.canonicalHash.algorithm !== CONTENT_HASH_ALGORITHM ||
        journal.canonicalHash.canonicalizationVersion !== CANONICALIZATION_VERSION || !/^[0-9a-f]{64}$/.test(journal.canonicalHash.digest))
        throw new TypeError("Incomplete or corrupt ledger cutoff population");
      expected++;
      yield hashValue(journal.canonicalHash);
    }
  }
  return hashCanonicalSequenceField({ type: "LedgerCutoff", bookId, bookRevision, postingSequence },
    "journalHashes", postingSequence, hashes());
}

function hashChart(snapshot: JournalAdmissionSnapshot): ContentHash {
  return hashCanonical({
    type: "ChartSnapshot",
    bookId: snapshot.bookId,
    functionalCommodityId: snapshot.functionalCommodityId,
    accounts: [...snapshot.accounts]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((account) => ({
        id: account.id,
        bookId: account.bookId,
        code: account.code,
        name: account.name,
        role: account.role,
        normalSide: account.normalSide,
        postingAllowed: account.postingAllowed,
        openedOn: account.openedOn,
        closedOn: account.closedOn ?? null,
        parentId: account.parentId ?? null,
        allowedCommodityIds: [...account.allowedCommodityIds].sort(),
      })),
    dimensions: [...snapshot.dimensions]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((dimension) => ({
        id: dimension.id,
        bookId: dimension.bookId,
        code: dimension.code,
        name: dimension.name,
        openedOn: dimension.openedOn,
        closedOn: dimension.closedOn ?? null,
      })),
    members: [...snapshot.dimensionMembers]
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((member) => ({
        id: member.id,
        dimensionId: member.dimensionId,
        code: member.code,
        name: member.name,
        openedOn: member.openedOn,
        closedOn: member.closedOn ?? null,
        parentId: member.parentId ?? null,
      })),
    requiredDimensionIds: [...snapshot.requiredDimensionIds].sort(),
    requiredDimensionIdsByPosting: snapshot.requiredDimensionIdsByPosting === undefined
      ? null
      : Object.entries(snapshot.requiredDimensionIdsByPosting)
          .sort(([left], [right]) => compareCanonicalText(left, right))
          .map(([postingId, dimensionIds]) => ({ postingId, dimensionIds: [...dimensionIds].sort() })),
  });
}

function admissionForPolicy(state: Pick<BookJournalReadContext, "identity" | "admissionSnapshot" | "policies" | "quantizationPolicies">, resolved: ResolvedTransaction): JournalAdmissionSnapshot | SemanticDiagnostic {
  const selected: BookingPolicy[] = [];
  const requiredDimensionIdsByPosting: Record<string, JournalAdmissionSnapshot["requiredDimensionIds"]> = {};
  for (const application of resolved.policyApplications) {
    const policyResolution = selectBookingPolicy(state.policies, {
      bookId: state.identity.bookId,
      governedAt: resolved.journal.economicAt,
      scopeKey: application.scopeKey,
    });
    if (policyResolution.disposition === "rejected") return policyResolution.diagnostics[0]!;
    if (policyResolution.policy.id !== application.policyId || policyResolution.policy.version !== application.policyVersion) {
      return diagnostic("policy_ambiguity", "resolved.policyApplications", "Resolved policy application does not match canonical state policy identity", ["ACC-007", "ACC-011", "ACC-038"]);
    }
    if (!selected.some((policy) => policy.id === policyResolution.policy.id && policy.version === policyResolution.policy.version)) selected.push(policyResolution.policy);
    requiredDimensionIdsByPosting[application.postingId] = policyResolution.policy.requiredDimensionIds;
  }
  const expected = hashPolicySnapshot(selected);
  if (!contentHashEquals(expected, resolved.policySnapshotHash)) {
    return diagnostic(
      "policy_ambiguity",
      "resolved.policySnapshotHash",
      "Resolved transaction does not carry the applicable complete policy snapshot hash",
      ["ACC-005", "ACC-011", "ACC-017"],
    );
  }
  const expectedQuantization = hashQuantizationPolicy(resolved.quantizationPolicy);
  const applicableQuantization = state.quantizationPolicies.filter((policy) =>
    policy.id === resolved.quantizationPolicy.id &&
    policy.version === resolved.quantizationPolicy.version &&
    policy.validFrom <= resolved.journal.accountingDate &&
    (policy.validTo === undefined || resolved.journal.accountingDate < policy.validTo)
  );
  if (
    applicableQuantization.length !== 1 ||
    !contentHashEquals(hashQuantizationPolicy(applicableQuantization[0]!), expectedQuantization) ||
    !contentHashEquals(expectedQuantization, resolved.quantizationPolicySnapshotHash) ||
    resolved.quantizationPolicy.bookId !== state.identity.bookId ||
    resolved.quantizationPolicy.functionalCommodityId !== state.identity.functionalCommodityId
  ) {
    return diagnostic(
      "policy_ambiguity",
      "resolved.quantizationPolicySnapshotHash",
      "Resolved transaction does not carry one applicable complete quantization policy snapshot",
      ["ACC-003", "ACC-005", "ACC-011", "ACC-026"],
    );
  }
  return Object.freeze({
    ...state.admissionSnapshot,
    requiredDimensionIds: Object.freeze([]),
    requiredDimensionIdsByPosting: Object.freeze(requiredDimensionIdsByPosting),
  });
}

function immutableJournal(journal: JournalTransaction): JournalTransaction {
  return Object.freeze({
    ...journal,
    postings: Object.freeze(
      journal.postings.map((posting) =>
        Object.freeze({
          ...posting,
          units: Object.freeze({ ...posting.units }),
          bookValue: Object.freeze({ ...posting.bookValue }),
          ...(posting.transactionPrice === undefined
            ? {}
            : { transactionPrice: Object.freeze({ ...posting.transactionPrice }) }),
          ...(posting.costBasis === undefined
            ? {}
            : { costBasis: Object.freeze({ ...posting.costBasis }) }),
          dimensionMemberIds: Object.freeze([...posting.dimensionMemberIds]),
        }),
      ),
    ),
  });
}

function immutableDerivations(
  derivations: ResolvedTransaction["derivations"],
): ResolvedTransaction["derivations"] {
  return Object.freeze(
    derivations.map((derivation) =>
      Object.freeze({
        ...derivation,
        inputHash: Object.freeze({ ...derivation.inputHash }),
        evidence: Object.freeze(
          derivation.evidence.map((evidence) =>
            Object.freeze({
              ...evidence,
              contentHash: Object.freeze({ ...evidence.contentHash }),
            }),
          ),
        ),
      }),
    ),
  );
}

function immutableResolved(resolved: ResolvedTransaction): ResolvedTransaction {
  return Object.freeze({
    journal: immutableJournal(resolved.journal),
    policyApplications: Object.freeze(resolved.policyApplications.map((application) => Object.freeze({ ...application }))),
    policySnapshotHash: Object.freeze({ ...resolved.policySnapshotHash }),
    quantizationPolicy: Object.freeze({ ...resolved.quantizationPolicy }),
    quantizationPolicySnapshotHash: Object.freeze({ ...resolved.quantizationPolicySnapshotHash }),
    exactBookValues: Object.freeze([...resolved.exactBookValues]),
    derivations: immutableDerivations(resolved.derivations),
  });
}

function immutableLotOperations(operations: readonly LotOperation[] | undefined): readonly LotOperation[] {
  return Object.freeze((operations ?? []).map((operation) => {
    if (operation.type === "acquire") {
      return Object.freeze({
        ...operation,
        lot: Object.freeze({ ...operation.lot, evidenceIds: Object.freeze([...operation.lot.evidenceIds]) }),
        holding: Object.freeze({ ...operation.holding }),
      });
    }
    if (operation.type === "dispose") {
      return Object.freeze({
        ...operation,
        holdingIds: Object.freeze([...operation.holdingIds]),
        selection: operation.selection.method === "specificIdentification"
          ? Object.freeze({ ...operation.selection, allocations: Object.freeze([...operation.selection.allocations]) })
          : Object.freeze({ ...operation.selection }),
        derivation: immutableDerivations([operation.derivation])[0]!,
        identities: Object.freeze(operation.identities.map((identity) => Object.freeze({ ...identity }))),
      });
    }
    return Object.freeze({
      ...operation,
      sourceHoldingIds: Object.freeze([...operation.sourceHoldingIds]),
      selection: operation.selection.method === "specificIdentification"
        ? Object.freeze({ ...operation.selection, allocations: Object.freeze([...operation.selection.allocations]) })
        : Object.freeze({ ...operation.selection }),
      policies: Object.freeze(operation.policies.map((policy) => Object.freeze({ ...policy }))),
      derivation: immutableDerivations([operation.derivation])[0]!,
      allocationIdentities: Object.freeze(operation.allocationIdentities.map((identity) => Object.freeze({ ...identity }))),
      destinationIdentities: Object.freeze(operation.destinationIdentities.map((identity) => Object.freeze({ ...identity }))),
    });
  }));
}

function immutableCommand(command: BookCommand): BookCommand {
  const common = {
    ...command,
    inputHash: Object.freeze({ ...command.inputHash }),
    ...("generatedPostingDimensionSelections" in command ? {
      generatedPostingDimensionSelections: Object.freeze((command.generatedPostingDimensionSelections ?? []).map((selection) => Object.freeze({
        ...selection,
        dimensionMemberIds: Object.freeze([...selection.dimensionMemberIds]),
      }))),
    } : {}),
  };
  switch (command.type) {
    case "activateBook":
      return Object.freeze({
        ...common,
        ...(command.opening === undefined ? {} : { opening: immutableResolved(command.opening) }),
        lotOperations: immutableLotOperations(command.lotOperations),
      }) as BookCommand;
    case "postJournal":
    case "correctJournal":
      return Object.freeze({ ...common, resolved: immutableResolved(command.resolved), lotOperations: immutableLotOperations(command.lotOperations) }) as BookCommand;
    case "closePeriod":
      return Object.freeze({
        ...common,
        reportPopulationHash: Object.freeze({ ...command.reportPopulationHash }),
        reportingPolicySnapshotHash: Object.freeze({ ...command.reportingPolicySnapshotHash }),
        ...(command.closing === undefined ? {} : { closing: immutableResolved(command.closing) }),
      }) as BookCommand;
    case "reopenPeriod":
      return Object.freeze({
        ...common,
        ...(command.reversal === undefined ? {} : { reversal: immutableResolved(command.reversal) }),
      }) as BookCommand;
    case "replaceConfiguration":
      return Object.freeze({
        ...common,
        periods: Object.freeze(command.periods.map((period) => Object.freeze({ ...period }))),
        admissionSnapshot: immutableAdmissionSnapshot(command.admissionSnapshot),
        policies: Object.freeze(command.policies.map(immutablePolicy)),
        quantizationPolicies: Object.freeze(command.quantizationPolicies.map((policy) => Object.freeze({ ...policy }))),
        accountingPolicies: immutableAccountingValue(command.accountingPolicies),
      }) as BookCommand;
    case "postInventoryTransaction":
      return Object.freeze({ ...common, request: immutableAccountingValue(command.request), derivation: immutableAccountingValue(command.derivation), lotOperations: immutableLotOperations(command.lotOperations) }) as BookCommand;
    case "recostProvisionalInventory":
    case "adjustInventoryValue":
    case "postOwnedInventoryTransaction":
    case "postCurrencyRemeasurement":
    case "createAllocationSchedule":
    case "recognizeScheduledAllocation":
    case "postTaxedTransaction":
    case "compileConsolidation":
      return Object.freeze({ ...common, request: immutableAccountingValue(command.request) }) as BookCommand;
    case "reviseAllocationSchedule":
      return Object.freeze({ ...common, request: immutableAccountingValue(command.request), ...(command.disposalJournal === undefined ? {} : { disposalJournal: immutableResolved(command.disposalJournal) }) }) as BookCommand;
    case "recognizeOpenItem":
      return Object.freeze({ ...common, request: immutableAccountingValue(command.request), resolved: immutableResolved(command.resolved) }) as BookCommand;
    case "applySettlement":
      return Object.freeze({ ...common, request: immutableAccountingValue(command.request), resolved: Object.freeze(command.resolved.map(immutableResolved)) }) as BookCommand;
  }
}

function inventoryCostJournalDraft(
  state: BookState,
  command: PostInventoryTransactionCommand,
  cost: Extract<ReturnType<typeof calculateInventoryCost>, { disposition: "costed" }>,
): ExactPreparedJournal {
  const ordinaryValuationAllowance = cost.allocations.reduce((total, allocation) => {
    // Layer identity and quantity come from the complete canonical population
    // already compared above, not from a caller-supplied carrying-value total.
    const holding = state.lotHoldings.find((holding) => holding.id === allocation.layerId)!;
    return total.add(holding.remainingValuationAllowance.multiply(allocation.quantity).divide(holding.remainingQuantity));
  }, ExactRational.zero());
  const ordinaryCarryingAmount = cost.ordinaryBasis.add(ordinaryValuationAllowance);
  const totalCarryingAmount = ordinaryCarryingAmount.add(cost.provisionalBasis);
  const inventoryPostingId = identifier<"Posting">(`${command.id}-inventory`);
  const provisionalPostingId = identifier<"Posting">(`${command.id}-provisional-inventory`);
  const ordinaryQuantity = command.request.quantity.subtract(cost.provisionalQuantity);
  const inventoryPostings = [
    ...(!ordinaryQuantity.isZero() ? [Object.freeze({ id: inventoryPostingId, accountId: command.inventoryAccountId, units: ordinaryQuantity.negate(), unitsCommodityId: command.inventoryCommodityId, exactBookValue: ordinaryCarryingAmount.negate(), costBasis: Object.freeze({ totalBasis: cost.ordinaryBasis.negate(), basisCommodityId: state.identity.functionalCommodityId }) })] : []),
    ...(!cost.provisionalQuantity.isZero() ? [Object.freeze({ id: provisionalPostingId, accountId: command.inventoryAccountId, units: cost.provisionalQuantity.negate(), unitsCommodityId: command.inventoryCommodityId, exactBookValue: cost.provisionalBasis.negate() })] : []),
  ];
  const journalDraft: ExactPreparedJournal = Object.freeze({
    id: identifier<"JournalTransaction">(`${command.id}-journal`), kind: "ordinary", economicAt: command.request.governedAt,
    accountingDate: command.request.governedAt.slice(0, 10) as LocalDate, recordedAt: command.issuedAt,
    narration: "Inventory cost recognition", derivations: Object.freeze([command.derivation]), postings: Object.freeze([
      Object.freeze({ id: identifier<"Posting">(`${command.id}-cost`), accountId: command.costAccountId, units: command.request.quantity, unitsCommodityId: command.inventoryCommodityId, exactBookValue: totalCarryingAmount }),
      ...inventoryPostings,
    ]),
  });
  return journalDraft;
}

function resolvePreparedJournal(
  state: Pick<BookJournalReadContext, "identity" | "quantizationPolicies" | "admissionSnapshot" | "policies">,
  prepared: ExactPreparedJournal,
  journalEffectKey: string,
  selections: readonly GeneratedPostingDimensionSelection[],
): ResolvedTransaction | readonly SemanticDiagnostic[] {
  const quantizationPolicies = state.quantizationPolicies.filter((policy) =>
    policy.validFrom <= prepared.accountingDate && (policy.validTo === undefined || prepared.accountingDate < policy.validTo)
  );
  if (quantizationPolicies.length !== 1) {
    return Object.freeze([diagnostic("policy_ambiguity", "accountingDraft.quantizationPolicy", "Generated journal must resolve exactly one quantization policy", ["ACC-003", "ACC-047.5"])]);
  }
  const quantizationPolicy = quantizationPolicies[0]!;
  if (prepared.requiredQuantizationPolicy !== undefined && !contentHashEquals(hashQuantizationPolicy(prepared.requiredQuantizationPolicy), hashQuantizationPolicy(quantizationPolicy))) {
    return Object.freeze([diagnostic("policy_ambiguity", "accountingDraft.quantizationPolicy", "The retained cumulative schedule quantization policy must match exactly; policy changes may not silently reround planned amounts", ["ACC-044.3", "ACC-044.6"])]);
  }
  const exactValues = prepared.postings.map((posting) => posting.exactBookValue);
  const quantized = quantizeBalancedBookValues(exactValues, state.identity.bookId, state.identity.functionalCommodityId, quantizationPolicy);
  if (quantized.disposition === "rejected") return quantized.diagnostics;
  const expectedPostingCount = prepared.postings.length + (quantized.roundingPosting === undefined ? 0 : 1);
  const requiresDimensions = state.admissionSnapshot.requiredDimensionIds.length > 0 || Object.values(state.admissionSnapshot.requiredDimensionIdsByPosting ?? {}).some((required) => required.length > 0);
  const applicableSelections = selections.filter((selection) => selection.effectKey === journalEffectKey);
  const effectiveSelections = requiresDimensions || applicableSelections.length > 0
    ? applicableSelections
    : Array.from({ length: expectedPostingCount }, (_, index) => ({ effectKey: journalEffectKey, postingOrdinal: BigInt(index + 1), dimensionMemberIds: Object.freeze([]) }));
  if (
    effectiveSelections.length !== expectedPostingCount ||
    new Set(effectiveSelections.map((selection) => selection.postingOrdinal.toString())).size !== effectiveSelections.length ||
    effectiveSelections.some((selection) => selection.postingOrdinal < 1n || selection.postingOrdinal > BigInt(expectedPostingCount))
  ) {
    return Object.freeze([diagnostic(
      "invalid_dimension_selection",
      "command.generatedPostingDimensionSelections",
      "Every generated posting requires exactly one explicit effect-key and ordinal dimension selection, with no duplicates or omissions",
      ["ACC-017", "ACC-037", "ACC-047.2"],
    )]);
  }
  const dimensionsAt = (ordinal: bigint): readonly DimensionMemberId[] => effectiveSelections.find((selection) => selection.postingOrdinal === ordinal)!.dimensionMemberIds;
  const postings: JournalTransaction["postings"][number][] = prepared.postings.map((posting, index) => Object.freeze({
    id: posting.id,
    ordinal: BigInt(index + 1),
    accountId: posting.accountId,
    units: Object.freeze({ canonicalNumber: posting.units, commodityId: posting.unitsCommodityId }),
    bookValue: quantized.bookValues[index]!,
    ...(posting.costBasis === undefined ? {} : { costBasis: Object.freeze({ ...posting.costBasis }) }),
    dimensionMemberIds: Object.freeze([...dimensionsAt(BigInt(index + 1))]),
  }));
  if (quantized.roundingPosting !== undefined) {
    const amount = quantized.roundingPosting.bookValue.amount.toRational();
    postings.push(Object.freeze({
      id: identifier<"Posting">(`${prepared.id}-rounding`),
      ordinal: BigInt(postings.length + 1),
      accountId: quantized.roundingPosting.accountId,
      units: Object.freeze({ canonicalNumber: amount, commodityId: state.identity.functionalCommodityId }),
      bookValue: quantized.roundingPosting.bookValue,
      dimensionMemberIds: Object.freeze([...dimensionsAt(BigInt(postings.length + 1))]),
    }));
  }
  const journal: JournalTransaction = Object.freeze({
    id: prepared.id,
    kind: prepared.kind,
    bookId: state.identity.bookId,
    functionalCommodityId: state.identity.functionalCommodityId,
    economicAt: prepared.economicAt,
    accountingDate: prepared.accountingDate,
    recordedAt: prepared.recordedAt,
    narration: prepared.narration,
    postings: Object.freeze(postings),
  });
  const scopes = journal.postings.map((posting) => {
    const owner = selectBookingPolicy(state.policies, { bookId: state.identity.bookId, governedAt: journal.economicAt, scopeKey: state.identity.ownerId });
    return { postingId: posting.id, scopeKey: owner.disposition === "resolved" ? state.identity.ownerId : posting.accountId };
  });
  const resolved = resolveJournal(journal, state.policies, scopes, quantizationPolicy, exactValues, []);
  if ("journal" in resolved) return Object.freeze({ ...resolved, derivations: immutableDerivations(prepared.derivations) });
  return resolved;
}

function prepareAccountingCalculation(
  state: BookState,
  command: BookCommand,
  calculation: AccountingCalculation,
  explicitPeriodId: FiscalPeriodId | undefined,
  nextRevision: bigint,
): { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const effectDiagnostics = validateAccountingEffectAdmission(state.accountingState, calculation.draft.effects, state.identity.bookId);
  if (effectDiagnostics.length > 0) return effectDiagnostics;
  const journals = prepareGeneratedAccountingJournals({ ...journalReadContext(state), latestPostingSequence: state.latestPostingSequence }, command, calculation.draft.journals, explicitPeriodId, nextRevision);
  if (!("effects" in journals)) return journals;
  const effects = [...journals.effects, ...calculation.draft.effects];
  const sourceDiagnostics = validateAccountingSourceClosure(state, effects, command);
  if (sourceDiagnostics.length > 0) return sourceDiagnostics;
  return Object.freeze({ effects: Object.freeze(effects), sequence: journals.sequence });
}

/** Shared generated-journal compilation. Candidate identities include earlier
 * journals in this intent; storage observations are always from its one pinned head. */
function prepareGeneratedAccountingJournals(
  state: BookJournalReadContext & Pick<BookState, "latestPostingSequence">,
  command: BookCommand, drafts: readonly ExactPreparedJournal[],
  explicitPeriodId: FiscalPeriodId | undefined, nextRevision: bigint,
): { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
  const effects: BookEffect[] = [];
  const journalIds = new Set<string>();
  const postingIds = new Set<PostingId>();
  let sequence = state.latestPostingSequence;
  const dimensionSelections = "generatedPostingDimensionSelections" in command
    ? command.generatedPostingDimensionSelections ?? []
    : [];
  const expectedEffectKeys = new Set(drafts.map((_, index) => `${command.id}:journal:${index}`));
  const unusedSelection = dimensionSelections.find((selection) => !expectedEffectKeys.has(selection.effectKey));
  if (unusedSelection !== undefined) return Object.freeze([diagnostic(
    "invalid_dimension_selection",
    "command.generatedPostingDimensionSelections",
    "Generated posting dimension selections must resolve to a journal produced by this command",
    ["ACC-017", "ACC-037", "ACC-047.2"],
  )]);
  for (const [index, journalDraft] of drafts.entries()) {
    const resolved = resolvePreparedJournal(state, journalDraft, `${command.id}:journal:${index}`, dimensionSelections);
    if (!("journal" in resolved)) return resolved;
    sequence += 1n;
    const booked = prepareBookJournal({ ...state,
      ...(state.readPostingIdentities === undefined ? {} : { readPostingIdentities: (ids: readonly PostingId[], journal?: JournalTransaction) => {
        const observed = state.readPostingIdentities!(ids, journal);
        return new Map(ids.map((id) => [id, postingIds.has(id) ? "present" as const : observed.get(id)!]));
      } }),
      journalIdentity: (id) => journalIds.has(id) ? "present" : state.journalIdentity(id),
      postingIdentity: (id) => postingIds.has(id) ? "present" : state.postingIdentity(id),
    }, command, resolved, explicitPeriodId, nextRevision, sequence, false, index);
    if (!("journal" in booked)) return booked;
    journalIds.add(booked.journal.id);
    for (const posting of booked.journal.postings) postingIds.add(posting.id);
    effects.push({ type: "journal", booked });
  }
  return Object.freeze({ effects: Object.freeze(effects), sequence });
}

export interface BookCurrencyContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "accountingPolicySnapshot"> {
  readonly executionProfile: BookConfigurationSnapshot["executionProfile"];
  readonly currencyState: CurrencyAccountingState;
  accountingIdentity(effect: AccountingEffect): "present" | "absent";
  sourceJournals(reference: CanonicalPostingReference): readonly BookedJournal[];
  /** Complete allocated magnitudes for this monetary posting, on either side. */
  allocatedSource(reference: CanonicalPostingReference): { readonly bookValue: ExactRational; readonly quantity: ExactRational };
  sourceRemeasurement(reference: CanonicalPostingReference): "active" | "none";
  originalJournal(id: JournalTransaction["id"]): BookedJournal | null;
}

/** One implementation of currency mathematics, source authority, generated journal
 * admission and exact reversal. Every context observation is pinned to one revision. */
export function prepareBookCurrencyRemeasurement(state: BookCurrencyContext, command: BookCommand & PostCurrencyRemeasurementCommand):
  { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
  const calculation = calculateCurrencyRemeasurement(state.accountingPolicySnapshot.policies, state.identity.bookId, state.identity.functionalCommodityId, command.request, state.currencyState);
  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const diagnostics = validateAccountingEffectIdentities(calculation.draft.effects, state.identity.bookId, (effect) => state.accountingIdentity(effect));
  if (diagnostics.length > 0) return diagnostics;
  const prepared = prepareGeneratedAccountingJournals(state, command, calculation.draft.journals, command.fiscalPeriodId, state.bookRevision + 1n);
  if (!("effects" in prepared)) return prepared;
  const effects = [...prepared.effects, ...calculation.draft.effects];
  const sourceDiagnostics = effects.flatMap((effect, index) => effect.type === "remeasurementResult" ? validateRemeasurementSource(state, effects, effect, index) : []);
  if (sourceDiagnostics.length > 0) return sourceDiagnostics;
  const journalEffect = prepared.effects.find(isJournalEffect);
  const resultEffect = calculation.draft.effects.find((effect): effect is Extract<AccountingEffect, { readonly type: "remeasurementResult" }> => effect.type === "remeasurementResult");
  const reversalEffect = calculation.draft.effects.find((effect): effect is Extract<AccountingEffect, { readonly type: "remeasurementReversal" }> => effect.type === "remeasurementReversal");
  if (journalEffect === undefined) return [diagnostic("currency_remeasurement_violation", "command", "Currency remeasurement must retain its generated journal", ["ACC-043.5", "ACC-047.2"])];
  if (resultEffect !== undefined && resultEffect.value.adjustmentEffectKey !== undefined && resultEffect.value.adjustmentEffectKey !== journalEffect.booked.effectKey) return [diagnostic("currency_remeasurement_violation", "command.request.generatedEffectKey", "Remeasurement result must bind its generated journal effect key exactly", ["ACC-043.5", "ACC-047.2"])];
  if (reversalEffect !== undefined) {
    const original = state.currencyState.remeasurementResults.find((item) => item.id === reversalEffect.value.originalResultId);
    const originalJournal = original === undefined ? null : state.originalJournal(identifier<"JournalTransaction">(`${original.id}-journal`));
    if (original === undefined || originalJournal === null || reversalEffect.value.originalJournalId !== originalJournal.journal.id || (reversalEffect.value.originalEffectKey !== undefined && reversalEffect.value.originalEffectKey !== originalJournal.effectKey) || !exactReversal(originalJournal.journal, journalEffect.booked.journal))
      return [diagnostic("currency_remeasurement_violation", "command.request.reversalOf", "Remeasurement reversal must negate the exact retained original generated journal, including accounts, dimensions, and amounts", ["ACC-043.4", "ACC-043.6", "ACC-047.2"])];
  }
  return Object.freeze({ effects: Object.freeze(effects), sequence: prepared.sequence });
}


export interface BookTaxContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "accountingPolicySnapshot"> {
  taxIdentity(id: string): "present" | "absent";
}

export interface BookConsolidationContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "accountingPolicySnapshot"> {
  compilationIdentity(id: string): "present" | "absent";
}

/** Source populations are supplied immutable cross-book observations. The shared
 * calculator validates their pins, policy mapping, translation and eliminations;
 * storage proves target-book identity and atomically publishes this compilation. */
export function prepareBookConsolidation(state: BookConsolidationContext, command: BookCommand & CompileConsolidationCommand) {
  const calculation = compileConsolidation(state.accountingPolicySnapshot.policies, state.identity.functionalCommodityId, command.request);
  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const diagnostics = validateAccountingEffectIdentities(calculation.draft.effects, state.identity.bookId, effect => state.compilationIdentity(effect.value.id));
  if (diagnostics.length > 0) return diagnostics;
  const journals = prepareGeneratedAccountingJournals(state, command, calculation.draft.journals, command.fiscalPeriodId, state.bookRevision + 1n);
  if (!("effects" in journals)) return journals;
  return Object.freeze({ effects: Object.freeze([...journals.effects, ...calculation.draft.effects]), sequence: journals.sequence });
}

/** Tax owns its same-command source journal; it has no historical posting-source
 * dependency. Common admission and managed inventory protection remain mandatory. */
export function prepareBookTaxTransaction(state: BookTaxContext, command: BookCommand & PostTaxedTransactionCommand) {
  const calculation = determineTax(state.accountingPolicySnapshot.policies, state.identity.bookId, state.identity.functionalCommodityId, command.request);
  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const diagnostics = validateAccountingEffectIdentities(calculation.draft.effects, state.identity.bookId, (effect) => state.taxIdentity(effect.value.id));
  if (diagnostics.length > 0) return diagnostics;
  const journals = prepareGeneratedAccountingJournals(state, command, calculation.draft.journals, command.fiscalPeriodId, state.bookRevision + 1n);
  if (!("effects" in journals)) return journals;
  return Object.freeze({ effects: Object.freeze([...journals.effects, ...calculation.draft.effects]), sequence: journals.sequence });
}


export interface BookOpenItemContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence"> {
  readonly executionProfile: BookConfigurationSnapshot["executionProfile"];
  openItemIdentity(id: OpenItemRecognitionRequest["value"]["id"]): "present" | "absent";
  financialSourceOwner(reference: CanonicalPostingReference): "present" | "absent";
  /** Complete retained candidates in publication order, including legacy aliases. */
  sourceJournals(reference: CanonicalPostingReference): readonly BookedJournal[];
}

export function prepareBookOpenItem(state: BookOpenItemContext, command: BookCommand & RecognizeOpenItemCommand):
  { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
  if (command.request.value.bookId !== state.identity.bookId) return [diagnostic("settlement_allocation_violation", "command.request.value.bookId", "Open item belongs to another book", ["ACC-041.1", "ACC-041.2"])];
  const calculation = calculateOpenItem(() => state.openItemIdentity(command.request.value.id), command.request);
  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const booked = prepareBookJournal(state, command, command.resolved, command.fiscalPeriodId,
    state.bookRevision + 1n, state.latestPostingSequence + 1n, false);
  if (!("journal" in booked)) return booked;
  const effects: readonly BookEffect[] = Object.freeze([{ type: "journal", booked }, ...calculation.draft.effects]);
  const source = command.request.value.recognitionSource;
  const diagnostics = validateOpenItemSource(state.identity.bookId, state.executionProfile,
    source === undefined ? [booked] : [...state.sourceJournals(source), booked],
    command.request.value, 1, (reference) => state.financialSourceOwner(reference));
  if (diagnostics.length > 0) return diagnostics;
  return Object.freeze({ effects, sequence: booked.postingSequence });
}

export interface BookSettlementContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "accountingPolicySnapshot">,
  Pick<BookOpenItemContext, "executionProfile" | "financialSourceOwner" | "sourceJournals"> {
  readonly settlement: SettlementReadContext;
  sourceRemeasurement(reference: CanonicalPostingReference): "active" | "none";
}

/** Shared payment conservation, source authority, journal admission and realized
 * exchange calculation. Every read belongs to one pinned accounting revision. */
export function prepareBookSettlement(state: BookSettlementContext, command: BookCommand & ApplySettlementCommand):
  { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
  if (command.request.settlement.bookId !== state.identity.bookId) return [diagnostic("settlement_allocation_violation", "command.request.settlement.bookId", "Settlement belongs to another book", ["ACC-041.1", "ACC-041.2"])];
  const appliedAt = command.request.operation === "allocateExisting" ? command.request.appliedAt : command.request.settlement.settledAt;
  if (command.request.operation !== undefined && (!Number.isFinite(Date.parse(appliedAt)) || compareInstants(appliedAt, command.issuedAt) > 0 ||
    command.request.operation === "allocateExisting" && command.resolved.length !== 0))
    return [diagnostic("settlement_allocation_violation", "command.settlement.application", "Explicit application time must not be future-issued; existing payments do not create new supplied journals", ["ACC-041.3", "ACC-041.6"])];
  const settlementDate = appliedAt.slice(0, 10) as LocalDate;
  // Allocating a preposted payment can change accounting without a new journal.
  // Its effective date must pass the same period gate as journal-backed changes.
  const period = resolveBookAccountingPeriod(state, { accountingDate: settlementDate, kind: "ordinary" }, command.fiscalPeriodId, false);
  if ("code" in period) return [period];
  const quantizationMatches = state.quantizationPolicies.filter((policy) => policy.validFrom <= settlementDate && (policy.validTo === undefined || settlementDate < policy.validTo));
  if (quantizationMatches.length !== 1) return [diagnostic("policy_ambiguity", "command.request.settlement", "Settlement requires exactly one effective quantization policy", ["ACC-003", "ACC-041.5"])];
  const calculation = calculateSettlement(state.settlement, { ...command.request, quantizationPolicy: quantizationMatches[0]! });
  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const nextRevision = state.bookRevision + 1n;
  const effects: BookEffect[] = [];
  const journalIds = new Set<string>();
  const postingIds = new Set<PostingId>();
  const journalContext: BookJournalReadContext = {
    ...state,
    journalIdentity: (id) => journalIds.has(id) ? "present" : state.journalIdentity(id),
    postingIdentity: (id) => postingIds.has(id) ? "present" : state.postingIdentity(id),
    ...(state.readPostingIdentities === undefined ? {} : { readPostingIdentities: (ids: readonly PostingId[], journal?: JournalTransaction) => {
      const observed = state.readPostingIdentities!(ids, journal);
      return new Map(ids.map((id) => [id, postingIds.has(id) ? "present" : observed.get(id)!]));
    } }),
  };
  let sequence = state.latestPostingSequence;
  for (const [index, resolved] of command.resolved.entries()) {
    sequence += 1n;
    const booked = prepareBookJournal(journalContext, command, resolved, command.fiscalPeriodId, nextRevision, sequence, false, index);
    if (!("journal" in booked)) return booked;
    journalIds.add(booked.journal.id);
    for (const posting of booked.journal.postings) postingIds.add(posting.id);
    effects.push({ type: "journal", booked });
  }
  const allocations = calculation.draft.effects.filter((effect): effect is Extract<AccountingEffect, { readonly type: "settlementAllocation" }> => effect.type === "settlementAllocation").map((effect) => effect.value);
  const sourceDiagnostics = [...effects, ...calculation.draft.effects].flatMap((effect, index, all) => validateSettlementSource(state, all, effect, index));
  if (sourceDiagnostics.length > 0) return sourceDiagnostics;
  // An unallocated recognition has no exchange calculation or generated edge.
  if (command.request.operation === "recognizeUnallocated") return Object.freeze({ effects: Object.freeze([...effects, ...calculation.draft.effects]), sequence });
  const settlementPosting = resolveSettlementPosting(state, effects, command.request.settlement.settlementSource!)!;
  const direction = ExactRational.of(settlementPosting.bookValue.amount.toRational().isNegative() ? 1n : -1n, 1n);
  const differences = allocations.map((allocation) => (allocation.allocatedSettlementBookValue ?? allocation.allocatedBookValue).subtract(allocation.allocatedOpenItemBookValue ?? allocation.allocatedBookValue).multiply(direction));
  const gains = differences.reduce((total, difference) => difference.isNegative() ? total : total.add(difference), ExactRational.zero());
  const losses = differences.reduce((total, difference) => difference.isNegative() ? total.subtract(difference) : total, ExactRational.zero());
  const realizedDifference = gains.subtract(losses);
  if (!gains.isZero() || !losses.isZero()) {
    const expectedEffectKey = `${command.id}:journal:${command.resolved.length}`;
    if (allocations.some((allocation, index) => !differences[index]!.isZero() && allocation.realizedExchangeEffectKey !== expectedEffectKey)) return [diagnostic("settlement_allocation_violation", "command.request.allocations.realizedExchangeEffectKey", "Every nonzero realized exchange difference must name the generated same-command journal effect", ["ACC-041.5", "ACC-041.6", "ACC-047.2"])];
    const policyMatches = state.accountingPolicySnapshot.policies.filter((policy): policy is CurrencyPolicy => policy.kind === "currencyRemeasurement" && policy.bookId === state.identity.bookId && compareInstants(policy.validFrom, appliedAt) <= 0 && (policy.validTo === undefined || compareInstants(appliedAt, policy.validTo) < 0) && (command.request.realizedExchangePolicyId === undefined || policy.id === command.request.realizedExchangePolicyId) && (command.request.realizedExchangePolicyVersion === undefined || policy.version === command.request.realizedExchangePolicyVersion));
    if (policyMatches.length !== 1) return [diagnostic("currency_remeasurement_violation", "command.request.realizedExchangePolicy", "A realized exchange difference requires one explicitly selected effective currency policy", ["ACC-041.5", "ACC-043.1", "ACC-047.5"])];
    const policy = policyMatches[0]!;
    const controlAccountId = command.request.settlement.scope.controlAccountId;
    const fxDraft: ExactPreparedJournal = Object.freeze({
      id: identifier<"JournalTransaction">(`${command.id}-realized-exchange-journal`), kind: "ordinary", economicAt: appliedAt, accountingDate: settlementDate, recordedAt: command.issuedAt, narration: "Realized foreign-exchange difference", derivations: Object.freeze([command.request.settlement.derivation]), postings: Object.freeze([
        ...(!realizedDifference.isZero() ? [Object.freeze({ id: identifier<"Posting">(`${command.id}-realized-position`), accountId: controlAccountId, units: realizedDifference, unitsCommodityId: state.identity.functionalCommodityId, exactBookValue: realizedDifference })] : []),
        ...(!gains.isZero() ? [Object.freeze({ id: identifier<"Posting">(`${command.id}-${losses.isZero() ? "realized-gain-loss" : "realized-gain"}`), accountId: policy.gainAccountId, units: gains.negate(), unitsCommodityId: state.identity.functionalCommodityId, exactBookValue: gains.negate() })] : []),
        ...(!losses.isZero() ? [Object.freeze({ id: identifier<"Posting">(`${command.id}-${gains.isZero() ? "realized-gain-loss" : "realized-loss"}`), accountId: policy.lossAccountId, units: losses, unitsCommodityId: state.identity.functionalCommodityId, exactBookValue: losses })] : []),
      ]),
    });
    const resolvedFx = resolvePreparedJournal(state, fxDraft, expectedEffectKey, command.generatedPostingDimensionSelections ?? []);
    if (!("journal" in resolvedFx)) return resolvedFx;
    sequence += 1n;
    const bookedFx = prepareBookJournal(journalContext, command, resolvedFx, command.fiscalPeriodId, nextRevision, sequence, false, command.resolved.length);
    if (!("journal" in bookedFx)) return bookedFx;
    effects.push({ type: "journal", booked: bookedFx });
  }
  effects.push(...calculation.draft.effects);
  return Object.freeze({ effects: Object.freeze(effects), sequence });
}

export type BookAllocationCommand = BookCommand & (CreateAllocationScheduleCommand | RecognizeScheduledAllocationCommand | ReviseAllocationScheduleCommand);
export interface BookAllocationContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "accountingPolicySnapshot"> {
  readonly accountingState: AllocationAccountingState;
  accountingIdentity(effect: AccountingEffect): "present" | "absent";
  resolveSource(reference: CanonicalPostingReference): JournalTransaction["postings"][number] | undefined;
}

/** Shared allocation lifecycle admission. The adapter supplies complete selected
 * schedule history, global conflicting identities, and canonical posting sources. */
export function prepareBookAllocation(state: BookAllocationContext, command: BookAllocationCommand):
  { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
      if (command.type === "reviseAllocationSchedule" && command.disposalJournal !== undefined && command.request.kind !== "disposal") {
        return [diagnostic("allocation_schedule_revision_violation", "command.disposalJournal", "Only a disposal revision may include a completion journal", ["ACC-044.6"])];
      }

  const calculation = command.type === "createAllocationSchedule"
          ? createAllocationSchedule(state.accountingPolicySnapshot.policies, state.identity.bookId, command.request)
          : command.type === "recognizeScheduledAllocation"
            ? recognizeScheduledAllocation(state.accountingPolicySnapshot.policies, state.accountingState, state.identity.functionalCommodityId, command.request)
            : reviseAllocationSchedule(state.accountingPolicySnapshot.policies, state.accountingState, state.identity.bookId, state.identity.functionalCommodityId, command.request);
      if (command.type === "reviseAllocationSchedule" && calculation.disposition === "draft") {
        const expectedEffectKey = calculation.draft.journals.length === 1 ? `${command.id}:journal:0` : undefined;
        if (command.request.generatedEffectKey !== expectedEffectKey) return [diagnostic("allocation_schedule_revision_violation", "command.request.generatedEffectKey", "Schedule revision adjustment lineage must exactly match its real same-command journal effect", ["ACC-044.4", "ACC-044.6", "ACC-047.2"])];
      }

  if (calculation.disposition === "rejected") return calculation.diagnostics;
  const identities = validateAccountingEffectIdentities(calculation.draft.effects, state.identity.bookId, state.accountingIdentity);
  if (identities.length > 0) return identities;
  const journals = prepareGeneratedAccountingJournals(state, command, calculation.draft.journals, command.fiscalPeriodId, state.bookRevision + 1n);
  if (!("effects" in journals)) return journals;
  const prepared = { effects: [...journals.effects, ...calculation.draft.effects], sequence: journals.sequence };
  const diagnostics = [...validateAllocationPostingPlan(state, prepared.effects, command)];
  for (const [index, effect] of prepared.effects.entries())
    if (effect.type === "allocationSchedule")
      diagnostics.push(...validateAllocationSource(state.accountingState, prepared.effects, effect, index, state.resolveSource));
  if (diagnostics.length > 0) return Object.freeze(diagnostics);
      if (command.type === "reviseAllocationSchedule" && command.disposalJournal !== undefined) {
        const revision = prepared.effects.find((effect) => effect.type === "allocationScheduleRevision") as Extract<BookEffect, { readonly type: "allocationScheduleRevision" }>;
        const adjustment = prepared.effects.find(isJournalEffect);
        const clearingAccount = revision.value.policy.allocationAccountId;
        const clearing = adjustment === undefined ? [] : adjustment.booked.journal.postings.filter((posting) => posting.accountId === clearingAccount);
        const completion = command.disposalJournal.journal.postings.filter((posting) => posting.accountId === clearingAccount);
        const totalValue = (postings: readonly JournalTransaction["postings"][number][]) => postings.reduce((total, posting) => total.add(posting.bookValue.amount.toRational()), ExactRational.zero());
        const totalUnits = (postings: readonly JournalTransaction["postings"][number][]) => postings.reduce((total, posting) => total.add(posting.units.canonicalNumber), ExactRational.zero());
        if (command.disposalJournal.journal.accountingDate !== command.request.effectiveOn ||
          clearingAccount === revision.value.policy.contraAccountId || (adjustment === undefined ? completion.length !== 0 : completion.length === 0) ||
          completion.some((posting) => posting.units.commodityId !== state.identity.functionalCommodityId) ||
          !totalValue(clearing).add(totalValue(completion)).isZero() || !totalUnits(clearing).add(totalUnits(completion)).isZero()) {
          return [diagnostic("allocation_schedule_revision_violation", "command.disposalJournal", "Disposal completion must share the disposal date and exactly clear its generated carrying-value adjustment", ["ACC-044.6", "ACC-047.2"])];
        }
        const preceding = adjustment === undefined ? [] : [adjustment.booked];
        const postingIds = new Set(preceding.flatMap((item) => item.journal.postings.map((posting) => posting.id)));
        const booked = prepareBookJournal({ ...state,
          journalIdentity: (id) => preceding.some((item) => item.journal.id === id) ? "present" : state.journalIdentity(id),
          postingIdentity: (id) => postingIds.has(id) ? "present" : state.postingIdentity(id),
          ...(state.readPostingIdentities === undefined ? {} : { readPostingIdentities: (ids: readonly PostingId[], journal?: JournalTransaction) => {
            const observed = state.readPostingIdentities!(ids, journal);
            return new Map(ids.map((id) => [id, postingIds.has(id) ? "present" as const : observed.get(id)!]));
          } }),
        }, command, command.disposalJournal, command.fiscalPeriodId, state.bookRevision + 1n, prepared.sequence + 1n, false, preceding.length);
        if (!("journal" in booked)) return booked;
        return { effects: [...prepared.effects, { type: "journal" as const, booked }], sequence: prepared.sequence + 1n };
      }

  return prepared;
}

function validateAllocationPostingPlan(
  state: Pick<BookAllocationContext, "identity" | "accountingPolicySnapshot" | "accountingState">,
  effects: readonly BookEffect[], command: BookCommand,
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const fail = (path: string, message: string, requirements: readonly string[]) => diagnostics.push(
    diagnostic("unresolved_accounting_input", path, message, requirements),
  );
  const cumulativeCommand = command.type === "recognizeScheduledAllocation"
    ? state.accountingState.allocationSchedules.some((item) => item.id === command.request.scheduleId && usesCumulativeAllocation(item.policy))
    : command.type === "reviseAllocationSchedule" && state.accountingPolicySnapshot.policies.some((policy) => policy.kind === "allocationSchedule" && policy.id === command.request.policyId && policy.version === command.request.policyVersion && usesCumulativeAllocation(policy));
  if (cumulativeCommand) {
    const expected = command.type === "recognizeScheduledAllocation"
      ? recognizeScheduledAllocation(state.accountingPolicySnapshot.policies, state.accountingState, state.identity.functionalCommodityId, command.request)
      : reviseAllocationSchedule(state.accountingPolicySnapshot.policies, state.accountingState, state.identity.bookId, state.identity.functionalCommodityId, (command as Extract<BookCommand, { type: "reviseAllocationSchedule" }>).request);
    if (expected.disposition === "rejected" || expected.draft.effects.some((item) => !effects.some((candidate) => isAccountingEffect(candidate) && contentHashEquals(
      hashCanonical(canonicalAccountingEffectValue(item)), hashCanonical(canonicalAccountingEffectValue(candidate))))) ||
      expected.draft.journals.some((draft) => {
        const booked = effects.filter(isJournalEffect).find((item) => item.booked.journal.id === draft.id)?.booked;
        return booked === undefined || booked.journal.accountingDate !== draft.accountingDate ||
          !contentHashEquals(booked.quantizationPolicySnapshotHash, hashQuantizationPolicy(draft.requiredQuantizationPolicy!)) ||
          booked.journal.postings.length !== draft.postings.length || draft.postings.some((posting, index) => {
            const actual = booked.journal.postings[index]!;
            return actual.id !== posting.id || actual.accountId !== posting.accountId ||
              actual.units.commodityId !== posting.unitsCommodityId || !actual.units.canonicalNumber.equals(posting.units) ||
              !actual.bookValue.amount.toRational().equals(posting.exactBookValue);
          });
      })) fail("intent.effects.allocationPostingPlan", "Cumulative lifecycle effects and their actual posted journals must reconcile to the retained plan and complete prior recognition state", ["ACC-044.3", "ACC-044.4", "ACC-044.6"]);
  }

  return diagnostics;
}
function validateAllocationSource(
  accountingState: AllocationAccountingState, effects: readonly BookEffect[],
  effect: Extract<BookEffect, { readonly type: "allocationSchedule" }>, index: number,
  resolveSource: BookAllocationContext["resolveSource"],
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const fail = (path: string, message: string, requirements: readonly string[]) => diagnostics.push(
    diagnostic("unresolved_accounting_input", path, message, requirements),
  );
      const posting = effect.value.source === undefined ? undefined : resolveSource(effect.value.source);
      const directSourceMatches = posting !== undefined && effect.value.source !== undefined && posting.bookValue.amount.toRational().abs().equals(effect.value.sourceBasis.abs());
      // A prospective successor schedule intentionally changes its source basis
      // to the carrying amount after the revision. Its canonical source remains
      // the original posting, so close the chain through the immutable revision
      // rather than pretending the original posting changed.
      const successorRevisionEffect = effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "allocationScheduleRevision" }> =>
        candidate.type === "allocationScheduleRevision" && candidate.value.successorScheduleId === effect.value.id,
      );
      // Successor schedules and their immutable revision are one atomic command
      // topology. A persisted-revision fallback would admit a successor in a
      // later command, weakening source closure and the compare-and-swap unit.
      const successorRevision = successorRevisionEffect?.value;
      const originalSchedule = successorRevision === undefined
        ? undefined
        : accountingState.allocationSchedules.find((schedule) => schedule.id === successorRevision.originalScheduleId);
      const successorSourceMatches = !directSourceMatches && successorRevision !== undefined && originalSchedule !== undefined &&
        originalSchedule.source !== undefined && effect.value.source !== undefined &&
        contentHashEquals(originalSchedule.source.contentHash, effect.value.source.contentHash) &&
        posting !== undefined && (originalSchedule.postingPlan !== undefined || posting.bookValue.amount.toRational().abs().equals(originalSchedule.sourceBasis.abs())) &&
        effect.value.sourceBasis.equals((successorRevision.postedCarryingAmountAtRevision ?? successorRevision.carryingAmountAtRevision).add(
          successorRevision.postedCarryingAmountAtRevision === undefined ? successorRevision.exactAdjustmentAmount ?? ExactRational.zero() : successorRevision.bookedAdjustment?.amount.toRational() ?? ExactRational.zero()));
      if ((!directSourceMatches && !successorSourceMatches) || effect.value.source === undefined) {
        fail(`intent.effects[${index}].source`, "Allocation schedule must resolve one canonical same-book posting whose exact booked basis equals the scheduled source basis", ["ACC-011", "ACC-017", "ACC-026", "ACC-038", "ACC-044.1"]);
      }

  return diagnostics;
}

export function resolveCanonicalPosting(
  state: BookState,
  prepared: readonly BookEffect[],
  reference: CanonicalPostingReference,
): JournalTransaction["postings"][number] | undefined {
  return resolveCanonicalPostingCandidates(state.identity.bookId, state.activeConfigurationSnapshot.executionProfile,
    [...state.journals, ...prepared.filter(isJournalEffect).map((effect) => effect.booked)], reference);
}

/** Candidates must exhaust the reference's possible source identities in canonical
 * publication order. Structural profiles need the exact journal; legacy profiles
 * require every journal/effect tuple with the same delimiter-joined key. */
export function resolveCanonicalPostingCandidates(
  bookId: BookId, executionProfile: BookConfigurationSnapshot["executionProfile"],
  journals: readonly BookedJournal[], reference: CanonicalPostingReference,
): JournalTransaction["postings"][number] | undefined {
  if (!validateCanonicalPostingReferenceHash(reference) || reference.bookId !== bookId) return undefined;
  const candidateJournals = [...new Map([
    ...journals,
  ].map((booked) => [executionProfile === STRUCTURAL_SOURCE_IDENTITY_PROFILE
    ? JSON.stringify([booked.journal.bookId, booked.journal.id, booked.effectKey])
    : `${booked.journal.id}:${booked.effectKey}`, booked] as const)).values()].filter((booked) =>
    booked.journal.bookId === reference.bookId &&
    booked.journal.id === reference.journalId &&
    booked.effectKey === reference.effectKey
  );
  if (candidateJournals.length !== 1) return undefined;
  const postings = candidateJournals[0]!.journal.postings.filter((posting) => posting.id === reference.postingId);
  const posting = postings.length === 1 ? postings[0] : undefined;
  return posting !== undefined && contentHashEquals(hashCanonical(canonicalPostingValue(posting)), reference.postingContentHash)
    ? posting
    : undefined;
}

function hasActiveSourceRemeasurement(state: BookState, source: CanonicalPostingReference): boolean {
  return state.accountingState.remeasurementResults.some((result) => result.kind === "unrealized" && result.source !== undefined &&
    canonicalPostingSourceIdentity(result.source) === canonicalPostingSourceIdentity(source) &&
    !state.accountingState.remeasurementReversals.some((reversal) => reversal.originalResultId === result.id));
}

/** A reference's own ID is not ownership of its posting. Financial source
 * authority always uses the complete raw tuple, never a delimiter-joined alias. */
export function canonicalPostingSourceIdentity(source: CanonicalPostingReference): string {
  return JSON.stringify([source.bookId, source.journalId, source.effectKey, source.postingId]);
}

function financialSourceOwner(state: AccountingCanonicalState, source: CanonicalPostingReference): "present" | "absent" {
  const key = canonicalPostingSourceIdentity(source);
  return state.openItems.some((item) => item.recognitionSource !== undefined && canonicalPostingSourceIdentity(item.recognitionSource) === key) ||
    state.settlements.some((item) => item.settlementSource !== undefined && canonicalPostingSourceIdentity(item.settlementSource) === key) ? "present" : "absent";
}

function validateOpenItemSource(bookId: BookId, profile: BookConfigurationSnapshot["executionProfile"],
  journals: readonly BookedJournal[], value: OpenItemRecognitionRequest["value"], index: number,
  owner: BookOpenItemContext["financialSourceOwner"]): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const source = value.recognitionSource;
  const posting = source === undefined ? undefined : resolveCanonicalPostingCandidates(bookId, profile, journals, source);
  if (source !== undefined) {
    const observation = owner(source);
    if (observation !== "present" && observation !== "absent") throw new TypeError("Incomplete financial source ownership evidence");
    if (observation === "present") diagnostics.push(diagnostic("unresolved_accounting_input", `intent.effects[${index}].recognitionSource`,
      "Canonical control posting already has a financial source owner", ["ACC-038", "ACC-041.1"]));
  }
  if (posting === undefined || source === undefined || posting.accountId !== value.scope.controlAccountId || posting.units.commodityId !== value.denominationCommodityId ||
    !posting.units.canonicalNumber.abs().equals(value.denomination.abs()) || !posting.bookValue.amount.toRational().abs().equals(value.bookValue.abs()) ||
    !journals.some((booked) => booked.journal.id === source.journalId && booked.journal.accountingDate === value.recognizedOn)) {
    diagnostics.push(diagnostic("unresolved_accounting_input", `intent.effects[${index}].recognitionSource`,
      "Open item must reconcile exactly to one canonical control-account posting, denomination, book value, and recognition date", ["ACC-011", "ACC-017", "ACC-026", "ACC-038", "ACC-041.1"]));
  }
  return Object.freeze(diagnostics);
}

type SettlementSourceContext = Pick<BookSettlementContext, "identity" | "executionProfile" | "settlement" | "financialSourceOwner" | "sourceJournals" | "sourceRemeasurement">;
function settlementSourceContext(state: BookState): SettlementSourceContext {
  return {
    identity: state.identity, executionProfile: state.activeConfigurationSnapshot.executionProfile,
    settlement: settlementReadContext(state.accountingState), sourceJournals: () => state.journals,
    financialSourceOwner: (source) => financialSourceOwner(state.accountingState, source),
    sourceRemeasurement: (source) => hasActiveSourceRemeasurement(state, source) ? "active" : "none",
  };
}
function settlementSourceJournals(state: SettlementSourceContext, effects: readonly BookEffect[], source: CanonicalPostingReference) {
  return [...state.sourceJournals(source), ...effects.filter(isJournalEffect).map((item) => item.booked)];
}
function resolveSettlementPosting(state: SettlementSourceContext, effects: readonly BookEffect[], source: CanonicalPostingReference) {
  return resolveCanonicalPostingCandidates(state.identity.bookId, state.executionProfile, settlementSourceJournals(state, effects, source), source);
}
function validateSettlementSource(state: SettlementSourceContext, effects: readonly BookEffect[], effect: BookEffect, index: number): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const fail = (path: string, message: string, requirements: readonly string[]) =>
    diagnostics.push(diagnostic("unresolved_accounting_input", path, message, requirements));
  if (effect.type === "settlement") {
      const settlementSource = effect.value.settlementSource;
      const posting = settlementSource === undefined ? undefined : resolveSettlementPosting(state, effects, settlementSource);
      if (settlementSource !== undefined) {
        const owner = state.financialSourceOwner(settlementSource);
        if (owner !== "present" && owner !== "absent") throw new TypeError("Incomplete financial source ownership evidence");
        if (owner === "present") fail(`intent.effects[${index}].settlementSource`, "Canonical control posting already has a financial source owner", ["ACC-038", "ACC-041.1", "ACC-041.4"]);
      }
      if (posting === undefined || settlementSource === undefined || posting.accountId !== effect.value.scope.controlAccountId || posting.units.commodityId !== effect.value.denominationCommodityId ||
        !posting.units.canonicalNumber.abs().equals(effect.value.denomination.abs()) || !posting.bookValue.amount.toRational().abs().equals(effect.value.bookValue.abs()) ||
        !settlementSourceJournals(state, effects, settlementSource).some((booked) => booked.journal.id === settlementSource.journalId && booked.journal.accountingDate === effect.value.settledAt.slice(0, 10))) {
        fail(`intent.effects[${index}].settlementSource`, "Settlement must reconcile exactly to one canonical control-account posting, denomination, book value, and settlement date", ["ACC-011", "ACC-017", "ACC-026", "ACC-038", "ACC-041.1", "ACC-041.3"]);
      }
    } else if (effect.type === "settlementAllocation") {
      const open = state.settlement.openItem(effect.value.openItemId);
      const settlement = effects.find((item): item is Extract<AccountingEffect, { readonly type: "settlement" }> => item.type === "settlement" && item.value.id === effect.value.settlementId)?.value ??
        (effect.value.appliedAt === undefined ? undefined : state.settlement.existingSettlement(effect.value.settlementId) ?? undefined);
      const recognized = open?.recognitionSource === undefined ? undefined : resolveSettlementPosting(state, effects, open.recognitionSource);
      const settled = settlement?.settlementSource === undefined ? undefined : resolveSettlementPosting(state, effects, settlement.settlementSource);
      if (recognized === undefined || settled === undefined || recognized.bookValue.amount.toRational().isNegative() === settled.bookValue.amount.toRational().isNegative()) {
        fail(`intent.effects[${index}].settlementDirection`, "Settlement must reduce the canonical open-item control posting, not increase a balance with the same sign", ["ACC-041.2", "ACC-041.4", "ACC-041.6"]);
      }
      if (open?.recognitionSource !== undefined) {
        const measured = state.sourceRemeasurement(open.recognitionSource);
        if (measured !== "active" && measured !== "none") throw new TypeError("Incomplete source remeasurement evidence");
        if (measured === "active") fail(`intent.effects[${index}].remeasurement`, "Reverse the source's active unrealized remeasurement before settling its original carrying basis", ["ACC-041.6", "ACC-043.4", "ACC-043.5"]);
      }
      if (settlement?.settlementSource !== undefined) {
        const measured = state.sourceRemeasurement(settlement.settlementSource);
        if (measured !== "active" && measured !== "none") throw new TypeError("Incomplete source remeasurement evidence");
        if (measured === "active") fail(`intent.effects[${index}].remeasurement`, "Reverse the payment source's active remeasurement before allocating its original carrying basis", ["ACC-041.6", "ACC-043.4", "ACC-043.5"]);
      }

  }
  return diagnostics;
}

type CurrencySourceFacts = Pick<BookCurrencyContext, "identity" | "executionProfile" | "sourceJournals" | "allocatedSource" | "sourceRemeasurement">;
function currencySourceFacts(state: BookState): CurrencySourceFacts {
  return {
    identity: state.identity, executionProfile: state.activeConfigurationSnapshot.executionProfile,
    sourceJournals: () => state.journals,
    sourceRemeasurement: (source) => hasActiveSourceRemeasurement(state, source) ? "active" : "none",
    allocatedSource: (source) => {
      const key = canonicalPostingSourceIdentity(source);
      const openIds = new Set(state.accountingState.openItems.filter((item) => item.recognitionSource !== undefined &&
        canonicalPostingSourceIdentity(item.recognitionSource) === key).map((item) => item.id));
      const payments = new Map(state.accountingState.settlements.filter((item) => item.settlementSource !== undefined &&
        canonicalPostingSourceIdentity(item.settlementSource) === key).map((item) => [item.id, item]));
      let bookValue = ExactRational.zero(), quantity = ExactRational.zero();
      for (const allocation of state.accountingState.settlementAllocations) {
        if (openIds.has(allocation.openItemId)) {
          bookValue = bookValue.add(allocation.allocatedOpenItemBookValue ?? allocation.allocatedBookValue);
          quantity = quantity.add(allocation.allocatedOpenQuantity);
        }
        const payment = payments.get(allocation.settlementId);
        if (payment !== undefined) {
          bookValue = bookValue.add(allocation.allocatedSettlementBookValue ??
            payment.bookValue.abs().multiply(allocation.allocatedSettlementQuantity).divide(payment.denomination.abs()));
          quantity = quantity.add(allocation.allocatedSettlementQuantity);
        }
      }
      return { bookValue, quantity };
    },
  };
}

function validateRemeasurementSource(state: CurrencySourceFacts, effects: readonly BookEffect[],
  effect: Extract<AccountingEffect, { readonly type: "remeasurementResult" }>, index: number): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const source = effect.value.source;
  const posting = source === undefined ? undefined : resolveCanonicalPostingCandidates(state.identity.bookId, state.executionProfile,
    [...state.sourceJournals(source), ...effects.filter(isJournalEffect).map((effect) => effect.booked)], source);
  let sourceValue = posting?.bookValue.amount.toRational();
  let sourceQuantity = posting?.units.canonicalNumber;
  if (source !== undefined && posting !== undefined) {
    const allocated = state.allocatedSource(source);
    if (!(allocated?.bookValue instanceof ExactRational) || !(allocated.quantity instanceof ExactRational) ||
      allocated.bookValue.isNegative() || allocated.quantity.isNegative()) throw new TypeError("Incomplete allocated monetary source evidence");
    sourceValue = sourceValue!.subtract(allocated.bookValue.multiply(ExactRational.of(posting.bookValue.amount.toRational().isNegative() ? -1n : 1n, 1n)));
    sourceQuantity = sourceQuantity!.subtract(allocated.quantity.multiply(ExactRational.of(posting.units.canonicalNumber.isNegative() ? -1n : 1n, 1n)));
    const active = state.sourceRemeasurement(source);
    if (active !== "active" && active !== "none") throw new TypeError("Incomplete source remeasurement evidence");
    if (active === "active") diagnostics.push(diagnostic("unresolved_accounting_input", `intent.effects[${index}].remeasurement`,
      "Reverse the source's active unrealized remeasurement before measuring its remaining original carrying basis again", ["ACC-043.4", "ACC-043.5"]));
  }
  const classificationRule = effect.value.classificationPolicy === undefined || effect.value.positionAccountId === undefined
    ? undefined : effect.value.classificationPolicy.rules.find((rule) => rule.accountId === effect.value.positionAccountId);
  const classificationMatches = effect.value.classificationPolicy === undefined ? true
    : classificationRule !== undefined && classificationRule.classification === "monetary" &&
      effect.value.classificationPolicy.capability.feature === "monetaryClassification" && effect.value.classificationPolicy.capability.status === "supported";
  if (posting === undefined || source === undefined || (effect.value.positionAccountId !== undefined && posting.accountId !== effect.value.positionAccountId) ||
    (effect.value.denominationCommodityId !== undefined && posting.units.commodityId !== effect.value.denominationCommodityId) ||
    sourceValue === undefined || !sourceValue.equals(effect.value.carryingBookValue) ||
    !sourceQuantity!.multiply(effect.value.valuationRate).equals(effect.value.measuredBookValue) || !classificationMatches)
    diagnostics.push(diagnostic("unresolved_accounting_input", `intent.effects[${index}].source`,
      "Currency remeasurement must resolve one canonical monetary posting whose carrying value and policy classification are exact",
      ["ACC-011", "ACC-017", "ACC-026", "ACC-038", "ACC-043.1"]));
  return Object.freeze(diagnostics);
}


function validateAccountingSourceClosure(state: BookState, effects: readonly BookEffect[], command: BookCommand): readonly SemanticDiagnostic[] {
  let settlementInputs: SettlementSourceContext | undefined;
  const diagnostics: SemanticDiagnostic[] = [];
  // Only an open item needs every journal; copying them for each command was O(history).
  const availableJournals = () => [
    ...state.journals,
    ...effects.filter(isJournalEffect).map((item) => item.booked),
  ];
  const fail = (path: string, message: string, requirements: readonly string[]) => diagnostics.push(
    diagnostic("unresolved_accounting_input", path, message, requirements),
  );
  diagnostics.push(...validateAllocationPostingPlan(state, effects, command));
  for (const [index, effect] of effects.entries()) {
    if (effect.type === "provisionalInventoryLayer") {
      const posting = effect.value.issueSource === undefined ? undefined : resolveCanonicalPosting(state, effects, effect.value.issueSource);
      const expectedBookValue = effect.value.policy === undefined ? undefined : quantize(effect.value.provisionalBasis.negate(), effect.value.policy.quantizationPolicy).amount;
      if (posting === undefined || effect.value.issueSource === undefined || effect.value.policy === undefined || expectedBookValue === undefined || posting.accountId !== effect.value.policy.pools.find((pool) => pool.accountId === posting.accountId)?.accountId ||
        posting.units.canonicalNumber.compare(effect.value.quantity.negate()) !== 0 || !posting.bookValue.amount.toRational().equals(expectedBookValue.toRational())) {
        fail(`intent.effects[${index}].issueSource`, "Provisional inventory must resolve its exact same-book generated issue posting, policy pool, quantity, and quantized provisional basis", ["ACC-017", "ACC-026", "ACC-038", "ACC-040.2"]);
      }
    } else if (effect.type === "openItem") {
      diagnostics.push(...validateOpenItemSource(state.identity.bookId, state.activeConfigurationSnapshot.executionProfile,
        availableJournals(), effect.value, index, (source) => financialSourceOwner(state.accountingState, source)));
    } else if (effect.type === "settlement" || effect.type === "settlementAllocation") {
      settlementInputs ??= settlementSourceContext(state);
      diagnostics.push(...validateSettlementSource(settlementInputs, effects, effect, index));
    } else if (effect.type === "allocationSchedule") {
      diagnostics.push(...validateAllocationSource(state.accountingState, effects, effect, index,
        (reference) => resolveCanonicalPosting(state, effects, reference)));
    } else if (effect.type === "remeasurementResult") {
      diagnostics.push(...validateRemeasurementSource(currencySourceFacts(state), effects, effect, index));
    }
  }
  return Object.freeze(diagnostics);
}

function journalReadContext(state: BookState): BookJournalReadContext {
  const journals = journalLogOf(state);
  return {
    identity: state.identity, periods: state.periods, admissionSnapshot: state.admissionSnapshot,
    policies: state.policies, quantizationPolicies: state.quantizationPolicies,
    journalIdentity: (id) => journals.has("journal", id) ? "present" : "absent",
    postingIdentity: (id) => journals.has("posting", id) ? "present" : "absent",
    periodStatus: (id) => periodIsClosed(state, id) ? "closed" : "open",
  };
}

/** Ordinary-journal topology and admission shared by full-state and current-state
 * execution. Common command admission, managed-inventory scope protection and
 * optional lot operations remain separate; this does not authorize publication. */
export function prepareOrdinaryBookJournal(
  state: BookJournalReadContext & Pick<BookState, "status" | "openingBoundary" | "bookRevision" | "latestPostingSequence">,
  command: BookCommand & PostJournalCommand,
): BookedJournal | readonly SemanticDiagnostic[] {
  if (state.status !== "open" || state.openingBoundary === undefined) {
    return Object.freeze([diagnostic("unresolved_accounting_input", "state.openingBoundary", "Ordinary posting requires an activated opening boundary", ["ACC-005", "ACC-028"])]);
  }
  if (command.resolved.journal.accountingDate < state.openingBoundary.firstAccountingDate) {
    return Object.freeze([diagnostic("fiscal_period_admission", "journal.accountingDate", "Journal precedes the immutable opening boundary", ["ACC-028", "ACC-029"])]);
  }
  if (command.resolved.journal.kind !== "ordinary" && command.resolved.journal.kind !== "adjustment") {
    return Object.freeze([diagnostic("invalid_journal_structure", "command.resolved.journal.kind", "Opening, reversing, and closing journals require their dedicated command topology", ["ACC-004", "ACC-018", "ACC-028", "ACC-032"])]);
  }
  return prepareBookJournal(state, command, command.resolved, command.fiscalPeriodId,
    state.bookRevision + 1n, state.latestPostingSequence + 1n, false);
}

/** Shared journal admission primitive for full-state and indexed read adapters.
 * Unresolved lookups throw; missing evidence is never unused identity/open period.
 * Callers overlay pending SAME-COMMAND identities in their complete lookup inputs.
 * This does not validate command chronology, opening status/boundary, global FX,
 * corrections, lot/accounting source closure, intent topology or publication CAS. */
export function prepareBookJournal(
  state: BookJournalReadContext,
  command: Pick<BookCommand, "id" | "bookId">,
  resolved: ResolvedTransaction,
  explicitPeriodId: FiscalPeriodId | undefined,
  revision: bigint,
  sequence: bigint,
  allowClosedPeriod: boolean,
  effectIndex = 0,
): BookedJournal | readonly SemanticDiagnostic[] {
  if (resolved.journal.bookId !== command.bookId) {
    return Object.freeze([
      diagnostic("book_isolation_violation", "resolved.journal.bookId", "Journal belongs to another book", ["ACC-026"]),
    ]);
  }
  const admission = admissionForPolicy(state, resolved);
  if ("code" in admission) return Object.freeze([admission]);
  const journal = immutableJournal(resolved.journal);
  if (journalIdentityPresent(state.journalIdentity(journal.id))) {
    return Object.freeze([
      diagnostic("canonical_identity_conflict", "resolved.journal.id", `Journal identifier ${journal.id} was already assigned in this book`, ["ACC-004", "ACC-038"]),
    ]);
  }
  const observedPostings = state.readPostingIdentities?.(journal.postings.map((posting) => posting.id), journal);
  const reusedPosting = journal.postings.find((posting) => journalIdentityPresent(
    state.readPostingIdentities === undefined ? state.postingIdentity(posting.id) : observedPostings?.get(posting.id),
  ));
  if (reusedPosting !== undefined) {
    return Object.freeze([
      diagnostic("canonical_identity_conflict", "resolved.journal.postings", `Posting identifier ${reusedPosting.id} was already assigned in this book`, ["ACC-018", "ACC-038"]),
    ]);
  }
  const admitted = admitJournal(admission, journal);
  if (admitted.disposition === "rejected") return admitted.diagnostics;
  const period = resolveBookAccountingPeriod(state, journal, explicitPeriodId, allowClosedPeriod);
  if ("code" in period) return Object.freeze([period]);
  return Object.freeze({
    journal,
    commandId: command.id,
    effectKey: `${command.id}:journal:${effectIndex}`,
    bookRevision: revision,
    postingSequence: sequence,
    fiscalPeriodId: period.id,
    policySnapshotHash: Object.freeze({ ...resolved.policySnapshotHash }),
    quantizationPolicySnapshotHash: Object.freeze({ ...resolved.quantizationPolicySnapshotHash }),
    canonicalHash: admitted.canonicalHash,
    derivations: immutableDerivations(resolved.derivations),
  });
}

function exactReversal(original: JournalTransaction, correction: JournalTransaction): boolean {
  if (original.postings.length !== correction.postings.length) return false;
  const left = [...original.postings].sort((a, b) => Number(a.ordinal - b.ordinal));
  const right = [...correction.postings].sort((a, b) => Number(a.ordinal - b.ordinal));
  return left.every((posting, index) => {
    const other = right[index];
    if (other === undefined) return false;
    const priceEqual =
      posting.transactionPrice === undefined
        ? other.transactionPrice === undefined
        : other.transactionPrice !== undefined &&
          posting.transactionPrice.unitRate.equals(other.transactionPrice.unitRate) &&
          posting.transactionPrice.baseCommodityId === other.transactionPrice.baseCommodityId &&
          posting.transactionPrice.quoteCommodityId === other.transactionPrice.quoteCommodityId;
    const basisEqual =
      posting.costBasis === undefined
        ? other.costBasis === undefined
        : other.costBasis !== undefined &&
          posting.costBasis.totalBasis.negate().equals(other.costBasis.totalBasis) &&
          posting.costBasis.basisCommodityId === other.costBasis.basisCommodityId;
    return (
      posting.accountId === other.accountId &&
      posting.units.commodityId === other.units.commodityId &&
      posting.units.canonicalNumber.negate().equals(other.units.canonicalNumber) &&
      posting.bookValue.amount.toRational().negate().equals(other.bookValue.amount.toRational()) &&
      posting.bookValue.functionalCommodityId === other.bookValue.functionalCommodityId &&
      priceEqual &&
      basisEqual &&
      [...posting.dimensionMemberIds].sort().join("\u0000") === [...other.dimensionMemberIds].sort().join("\u0000")
    );
  });
}

function hashLotState(
  lots: readonly Lot[],
  holdings: readonly LotHolding[],
  allocations: readonly BookedLotAllocation[],
): ContentHash {
  return hashCanonical({
    type: "LotState",
    lots: lots.map(lotValue),
    holdings: holdings.map(holdingValue),
    allocations: allocations.map(allocationValue),
  });
}

function isDefinedHolding(holding: LotHolding | undefined): holding is LotHolding {
  return holding !== undefined;
}

function isJournalEffect(effect: BookEffect): effect is Extract<BookEffect, { readonly type: "journal" }> {
  return effect.type === "journal";
}

function isAccountingEffect(effect: BookEffect): effect is AccountingEffect {
  return ["provisionalInventoryLayer", "inventoryRecosting", "inventoryValueAdjustment", "openItem", "settlement", "settlementAllocation", "remeasurementResult", "remeasurementReversal", "allocationSchedule", "allocationRecognition", "allocationScheduleRevision", "taxDetermination", "consolidationCompilation"].includes(effect.type);
}

function prepareLotState(
  state: BookState,
  journal: JournalTransaction,
  operations: readonly LotOperation[] | undefined,
): LotStateEffect | readonly SemanticDiagnostic[] | undefined {
  if (operations === undefined || operations.length === 0) return undefined;
  const lots = [...state.lots];
  let holdings = [...state.lotHoldings];
  const allocations = [...state.lotAllocations];
  const postingById = new Map(journal.postings.map((posting) => [posting.id, posting] as const));
  const usedLotPostingIds = new Set<PostingId>();
  for (const [index, operation] of operations.entries()) {
    const linkedPostingIds = operation.type === "transfer" ? [operation.sourcePostingId, operation.destinationPostingId] : [operation.journalPostingId];
    if (new Set(linkedPostingIds).size !== linkedPostingIds.length || linkedPostingIds.some((id) => usedLotPostingIds.has(id))) {
      return Object.freeze([diagnostic("lot_overallocation", `lotOperations[${index}]`, "Each lot-operation posting must be linked exactly once within a journal", ["ACC-009", "ACC-010", "ACC-021"])]);
    }
    for (const id of linkedPostingIds) usedLotPostingIds.add(id);
    if (operation.type === "acquire") {
      const posting = postingById.get(operation.journalPostingId);
      const lot = operation.lot;
      const holding = operation.holding;
      if (
        posting === undefined || posting.units.canonicalNumber.isNegative() || posting.units.canonicalNumber.isZero() ||
        posting.costBasis === undefined ||
        lot.bookId !== state.identity.bookId || holding.bookId !== state.identity.bookId ||
        holding.lotId !== lot.id || holding.accountId !== posting.accountId ||
        lot.commodityId !== posting.units.commodityId || holding.commodityId !== lot.commodityId ||
        lot.basisCommodityId !== posting.costBasis.basisCommodityId || holding.basisCommodityId !== lot.basisCommodityId ||
        !lot.acquisitionQuantity.equals(posting.units.canonicalNumber) ||
        !lot.acquisitionTotalBasis.equals(posting.costBasis.totalBasis) ||
        !holding.remainingQuantity.equals(lot.acquisitionQuantity) ||
        !holding.remainingTotalBasis.equals(lot.acquisitionTotalBasis) ||
        holding.remainingCarryingAmount.isNegative() || holding.remainingValuationAllowance.compare(ExactRational.zero()) > 0 ||
        !holding.remainingCarryingAmount.equals(holding.remainingTotalBasis.add(holding.remainingValuationAllowance)) ||
        lot.evidenceIds.length === 0 || lot.acquisitionQuantity.isZero() || lot.acquisitionQuantity.isNegative() || lot.acquisitionTotalBasis.isNegative() ||
        lots.some((item) => item.id === lot.id) || holdings.some((item) => item.id === holding.id)
      ) {
        return Object.freeze([diagnostic("canonical_identity_conflict", `lotOperations[${index}]`, "Lot acquisition must link one new stable lot and holding to the matching positive canonical posting", ["ACC-008", "ACC-009", "ACC-017", "ACC-021", "ACC-026", "ACC-038"])]);
      }
      lots.push(Object.freeze({ ...lot, evidenceIds: Object.freeze([...lot.evidenceIds]) }));
      holdings.push(Object.freeze({ ...holding }));
      continue;
    }
    if (operation.type === "dispose") {
      const posting = postingById.get(operation.journalPostingId);
      const selected = operation.holdingIds.map((id) => holdings.find((holding) => holding.id === id)).filter(isDefinedHolding);
      if (
        posting === undefined || !posting.units.canonicalNumber.isNegative() ||
        !posting.units.canonicalNumber.negate().equals(operation.requestedQuantity) ||
        selected.length !== operation.holdingIds.length ||
        selected.some((holding) => holding.bookId !== state.identity.bookId || holding.accountId !== posting.accountId || holding.commodityId !== posting.units.commodityId || (posting.costBasis !== undefined && holding.basisCommodityId !== posting.costBasis.basisCommodityId))
      ) {
        return Object.freeze([diagnostic("lot_overallocation", `lotOperations[${index}]`, "Lot disposal must resolve every stable holding and match one reducing posting quantity", ["ACC-008", "ACC-009", "ACC-018", "ACC-021"])]);
      }
      const result = allocateLots(selected, lots, operation.requestedQuantity, operation.selection, operation.derivation, operation.identities);
      if (result.disposition === "rejected") return result.diagnostics;
      const totalBasis = result.allocations.reduce((total, allocation) => total.add(allocation.allocatedTotalBasis), operation.requestedQuantity.subtract(operation.requestedQuantity));
      if (posting.costBasis === undefined || !posting.costBasis.totalBasis.negate().equals(totalBasis)) {
        return Object.freeze([diagnostic("lot_overallocation", `lotOperations[${index}].journalPostingId`, "Disposal posting cost basis must exactly negate allocated authoritative total basis", ["ACC-004", "ACC-009", "ACC-023"])]);
      }
      const replacements = new Map(result.holdings.map((holding) => [holding.id, holding] as const));
      holdings = holdings.map((holding) => replacements.get(holding.id) ?? holding);
      for (const allocation of result.allocations) {
        if (allocations.some((item) => item.allocation.id === allocation.id)) {
          return Object.freeze([diagnostic("canonical_identity_conflict", `lotOperations[${index}].identities`, "Lot allocation identity was already assigned", ["ACC-008", "ACC-038"])]);
        }
        allocations.push(Object.freeze({ allocation, journalPostingId: posting.id, kind: "disposal" }));
      }
      continue;
    }
    const sourcePost = postingById.get(operation.sourcePostingId);
    const destinationPost = postingById.get(operation.destinationPostingId);
    const source = operation.sourceHoldingIds.map((id) => holdings.find((holding) => holding.id === id)).filter(isDefinedHolding);
    if (
      sourcePost === undefined || destinationPost === undefined ||
      !sourcePost.units.canonicalNumber.isNegative() || destinationPost.units.canonicalNumber.isNegative() || destinationPost.units.canonicalNumber.isZero() ||
      !sourcePost.units.canonicalNumber.negate().equals(operation.requestedQuantity) ||
      !destinationPost.units.canonicalNumber.equals(operation.requestedQuantity) ||
      source.length !== operation.sourceHoldingIds.length || destinationPost.accountId !== operation.destinationAccountId ||
      source.some((holding) => holding.bookId !== state.identity.bookId || holding.accountId !== sourcePost.accountId || holding.commodityId !== sourcePost.units.commodityId || holding.commodityId !== destinationPost.units.commodityId || (sourcePost.costBasis !== undefined && holding.basisCommodityId !== sourcePost.costBasis.basisCommodityId) || (destinationPost.costBasis !== undefined && holding.basisCommodityId !== destinationPost.costBasis.basisCommodityId))
    ) {
      return Object.freeze([diagnostic("lot_overallocation", `lotOperations[${index}]`, "Lot transfer must resolve its holdings and match explicit source and destination posting quantities", ["ACC-009", "ACC-010", "ACC-018", "ACC-021"])]);
    }
    const destination = holdings.filter((holding) => holding.accountId === operation.destinationAccountId);
    const result = transferLots(source, destination, lots, operation.requestedQuantity, operation.selection, operation.policies, operation.governedAt, operation.destinationAccountId, operation.derivation, operation.allocationIdentities, operation.destinationIdentities);
    if (result.disposition !== "transferred") {
      return result.disposition === "rejected"
        ? result.diagnostics
        : Object.freeze([diagnostic("transfer_policy_missing", `lotOperations[${index}].policies`, "Disposal-and-reacquisition transfers require explicit acquisition and disposal operations", ["ACC-007", "ACC-010", "ACC-011"])]);
    }
    const priorDestinationIds = new Set(destination.map((holding) => holding.id));
    const transferredBasis = result.allocations.reduce((total, allocation) => total.add(allocation.allocatedTotalBasis), ExactRational.zero());
    if ((sourcePost.costBasis !== undefined && !sourcePost.costBasis.totalBasis.negate().equals(transferredBasis)) || (destinationPost.costBasis !== undefined && !destinationPost.costBasis.totalBasis.equals(transferredBasis))) {
      return Object.freeze([diagnostic("lot_overallocation", `lotOperations[${index}]`, "Supplied transfer posting cost basis must exactly match allocated authoritative basis with the corresponding sign", ["ACC-004", "ACC-009", "ACC-010", "ACC-023"])]);
    }
    if (result.destinationHoldings.some((holding) => !priorDestinationIds.has(holding.id) && holdings.some((prior) => prior.id === holding.id))) {
      return Object.freeze([diagnostic("canonical_identity_conflict", `lotOperations[${index}].destinationIdentities`, "A new destination holding identifier was already assigned elsewhere in this book", ["ACC-008", "ACC-010", "ACC-038"])]);
    }
    const replacements = new Map([...result.sourceHoldings, ...result.destinationHoldings].map((holding) => [holding.id, holding] as const));
    holdings = holdings.map((holding) => replacements.get(holding.id) ?? holding);
    for (const destinationHolding of result.destinationHoldings) {
      if (!holdings.some((holding) => holding.id === destinationHolding.id)) holdings.push(destinationHolding);
    }
    for (const allocation of result.allocations) {
      if (allocations.some((item) => item.allocation.id === allocation.id)) {
        return Object.freeze([diagnostic("canonical_identity_conflict", `lotOperations[${index}].allocationIdentities`, "Lot allocation identity was already assigned", ["ACC-008", "ACC-038"])]);
      }
      allocations.push(Object.freeze({ allocation, journalPostingId: sourcePost.id, kind: "transfer" }));
    }
  }
  // Keep existing lot-validation diagnostics and their precedence intact. These
  // additional checks run only after that complete local transition succeeds;
  // no partially prepared holdings have been published.
  for (const [index, operation] of operations.entries()) {
    if (operation.type === "transfer") {
      const source = postingById.get(operation.sourcePostingId)!.bookValue.amount.toRational();
      const destination = postingById.get(operation.destinationPostingId)!.bookValue.amount.toRational();
      if (source.compare(ExactRational.zero()) > 0 || destination.isNegative() || !source.add(destination).isZero()) {
        return Object.freeze([diagnostic("lot_overallocation", `lotOperations[${index}]`, "Continuity transfer posted values must have reducing source and increasing destination signs and sum exactly to zero", ["ACC-009", "ACC-010", "ACC-018", "ACC-021"])]);
      }
    } else {
      const amount = postingById.get(operation.journalPostingId)!.bookValue.amount.toRational();
      if (operation.type === "acquire" ? amount.isNegative() : amount.compare(ExactRational.zero()) > 0) {
        return Object.freeze([diagnostic(operation.type === "acquire" ? "canonical_identity_conflict" : "lot_overallocation", `lotOperations[${index}]`, "Ordinary acquisition and disposal posted values must follow the corresponding inventory increase or reduction direction", ["ACC-009", "ACC-018", "ACC-021"])]);
      }
    }
  }
  const immutableLots = Object.freeze(lots);
  const immutableHoldings = Object.freeze(holdings);
  const immutableAllocations = Object.freeze(allocations);
  return Object.freeze({
    lots: immutableLots,
    holdings: immutableHoldings,
    allocations: immutableAllocations,
    contentHash: hashLotState(immutableLots, immutableHoldings, immutableAllocations),
  });
}

function ownedMovements(state: Pick<BookState, "inventoryOwnershipEffects">): readonly InventoryPostedMovement[] {
  return (state.inventoryOwnershipEffects ?? []).flatMap((effect) => [...effect.journalLinkedMovements, ...effect.quantityOnlyMovements])
    .sort((a, b) => a.bookRevision === b.bookRevision ? Number(a.artifactOrdinal - b.artifactOrdinal) : Number(a.bookRevision - b.bookRevision));
}

function inventoryMoneyScopeKey(scope: InventoryMoneyScope): string {
  return JSON.stringify([scope.bookId, scope.accountId, scope.functionalCommodityId, [...scope.dimensionMemberIds].sort(compareCanonicalText)]);
}

function validateInventoryScopeChanges(state: BookState, command: BookCommand, effects: readonly BookEffect[]): readonly SemanticDiagnostic[] {
  if (state.inventoryOwnershipEffects === undefined || command.type === "postOwnedInventoryTransaction") return Object.freeze([]);
  const movements = ownedMovements(state);
  const ownedAllocations = new Set(movements.filter(isInventoryPostedReductionMovement).map((movement) => movement.quantityAllocation.id));
  if (effects.some((effect) => effect.type === "lotState" && effect.lotState.allocations.some((allocation) => ownedAllocations.has(allocation.allocation.id)))) {
    return Object.freeze([diagnostic("canonical_identity_conflict", "command.inventoryOwnership.allocationIdentity", "A legacy allocation cannot reuse a permanent ownership allocation identity, including in another account", ["ACC-038", "ACC-039.9"])]);
  }
  const scopes = new Set(movements.map((movement) => inventoryMoneyScopeKey(movement.coordinate)));
  const holdings = new Set(movements.map((movement) => movement.coordinate.holdingId));
  const sourceJournals = new Set((state.inventoryOwnershipEffects ?? []).flatMap((effect) => effect.newAnchors.flatMap((anchor) => anchor.sourcePostings.map((source) => source.journalId))));
  for (const movement of movements) if (movement.monetaryKind === "journalLinked") sourceJournals.add(movement.posting.journalId);
  const touchesJournal = effects.some((effect) => effect.type === "journal" && effect.booked.journal.postings.some((posting) => scopes.has(inventoryMoneyScopeKey({
    bookId: state.identity.bookId, accountId: posting.accountId, functionalCommodityId: state.identity.functionalCommodityId, dimensionMemberIds: posting.dimensionMemberIds,
  }))));
  const touchesHolding = effects.some((effect) => effect.type === "lotState" && [...holdings].some((id) => {
    const before = state.lotHoldings.find((holding) => holding.id === id), after = effect.lotState.holdings.find((holding) => holding.id === id);
    return before === undefined || after === undefined || !contentHashEquals(hashCanonical(holdingValue(before)), hashCanonical(holdingValue(after)));
  }));
  if (touchesJournal || touchesHolding || command.type === "correctJournal" && sourceJournals.has(command.originalJournalId as JournalTransaction["id"])) {
    return Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.inventoryOwnership", "Managed inventory postings, holdings and source corrections require an explicit ownership transition", ["ACC-039.7", "ACC-039.8", "ACC-039.9"])]);
  }
  return Object.freeze([]);
}

/** Trusted original-source context for shared owned-command preparation.
 * Storage authenticates these facts; neither a caller payload nor a partial
 * reconstruction of BookState is an authority for them. */
export interface BookOwnedInventoryReadContext extends BookJournalReadContext,
  Pick<BookState, "status" | "bookRevision" | "latestPostingSequence" | "openingBoundary" | "accountingPolicySnapshot">,
  Pick<OwnedInventoryAccountingContext, "ownership" | "readPool" | "identityPresence" | "managedMoneyScope" | "latestMovementDate"> {
  readonly executionProfile: BookConfigurationSnapshot["executionProfile"];
  hasLiveUnownedStock(accounts: ReadonlySet<AccountId>): boolean;
  postedMoneyBalance(scope: InventoryMoneyScope): ExactRational;
}
export interface PreparedBookOwnedInventory {
  readonly journals: readonly BookedJournal[];
  readonly ownership: InventoryOwnershipEffect;
  readonly newLots: readonly Lot[];
  readonly afterHoldings: readonly LotHolding[];
  readonly sequence: bigint;
}
/** Command-local effects only; the caller must complete common admission and
 * prepareBookOwnedInventory at one authenticated head before publishing them. */
export function ownedInventoryChangeEffects(prepared: PreparedBookOwnedInventory): readonly BookEffect[] {
  return immutableAccountingValue([
    ...prepared.journals.map((booked): BookEffect => ({ type: "journal", booked })),
    { type: "inventoryOwnership", value: prepared.ownership },
    { type: "lotChanges", changes: { lots: prepared.newLots, holdings: prepared.afterHoldings,
      contentHash: hashLotChanges(prepared.newLots, prepared.afterHoldings) } },
  ]);
}
/** Shared command-specific preparation, after protocol, financial identity,
 * configuration, expected revision and global admission. No whole-state arrays
 * or hash are needed here. Trusted callbacks describe one authenticated head;
 * unavailable evidence throws. This creates neither an intent nor a receipt.
 * Older command versions still materialize their unchanged whole lotState effect;
 * version 1.2.0 emits command-local lot changes in both execution paths. */
export function prepareBookOwnedInventory(state: BookOwnedInventoryReadContext, command: BookCommand & PostOwnedInventoryTransactionCommand):
  PreparedBookOwnedInventory | readonly SemanticDiagnostic[] {
  const book = state.identity.bookId, revision = state.bookRevision;
  const guard = () => {
    state.ownership.assertCurrent();
    if (state.identity.bookId !== book || state.bookRevision !== revision || state.ownership.bookId !== book || state.ownership.bookRevision !== revision)
      throw new TypeError("Owned inventory preparation scope changed");
  };
  guard();
  try { return prepareOwnedInventoryFromReads(state, immutableCommand(command) as BookCommand & PostOwnedInventoryTransactionCommand); }
  finally { guard(); }
}

function prepareOwnedInventoryFromReads(state: BookOwnedInventoryReadContext, command: BookCommand & PostOwnedInventoryTransactionCommand):
  PreparedBookOwnedInventory | readonly SemanticDiagnostic[] {
  if (state.executionProfile !== STRUCTURAL_SOURCE_IDENTITY_PROFILE) {
    return Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.request.algorithm", "Owned inventory requires explicit structural source identity before admission", ["ACC-038", "ACC-039.9"])]);
  }
  if (state.status !== "open" || state.openingBoundary === undefined || command.request.accountingDate < state.openingBoundary.firstAccountingDate) {
    return Object.freeze([diagnostic("fiscal_period_admission", "command.request.accountingDate", "Owned inventory requires an activated open book and an admitted opening date", ["ACC-028", "ACC-029", "ACC-039.8"])]);
  }
  // Matching caller-supplied balances and reference hashes is not a proof of
  // complete historical ownership. Keep the prospective codec readable, but do
  // not publish adoption until authenticated migration admission exists.
  if (command.request.operations.some((operation) => operation.kind === "adopt")) {
    return Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.request.adoption", "Legacy inventory adoption requires verified historical ownership and is not yet supported", ["ACC-039.7", "ACC-039.9"])]);
  }
  const period = resolveBookAccountingPeriod(state,
    { accountingDate: command.request.accountingDate, kind: "adjustment" }, command.request.fiscalPeriodId, false);
  if ("code" in period) return Object.freeze([period]);
  const journals: BookedJournal[] = [];
  let sequence = state.latestPostingSequence;
  for (const [index, resolved] of command.request.resolvedJournals.entries()) {
    const booked = prepareBookJournal({ ...state,
      journalIdentity: (id) => journals.some((entry) => entry.journal.id === id) ? "present" : state.journalIdentity(id),
      postingIdentity: (id) => journals.some((entry) => entry.journal.postings.some((posting) => posting.id === id)) ? "present" : state.postingIdentity(id),
    }, command, resolved, period.id, state.bookRevision + 1n, sequence + 1n, false, index);
    if (!("journal" in booked)) return booked;
    journals.push(booked); sequence += 1n;
  }
  const incomingCoordinates = command.request.operations.flatMap((operation) =>
    operation.kind === "acquisition" ? [operation.coordinate] : operation.kind === "transfer" ? [operation.destinationCoordinate] : []);
  const acquisitionAccounts = new Set(incomingCoordinates.map((coordinate) => coordinate.accountId));
  const unowned = state.hasLiveUnownedStock(acquisitionAccounts);
  if (typeof unowned !== "boolean") throw new TypeError("Incomplete unowned inventory evidence");
  if (unowned) return Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.request.operations", "Existing unowned stock requires verified adoption before this account can accept new owned acquisitions", ["ACC-039.9"])]);
  const newScopes = new Map<string, InventoryMoneyScope>();
  for (const coordinate of incomingCoordinates) {
    const scope = { bookId: state.identity.bookId, functionalCommodityId: state.identity.functionalCommodityId,
      accountId: coordinate.accountId, dimensionMemberIds: coordinate.dimensionMemberIds };
    newScopes.set(inventoryMoneyScopeKey(scope), scope);
  }
  let nonzeroOpening = false;
  for (const scope of newScopes.values()) {
    const status = state.managedMoneyScope(scope);
    if (status !== "managed" && status !== "unmanaged") throw new TypeError("Incomplete managed inventory scope evidence");
    if (status === "unmanaged" && !state.postedMoneyBalance(scope).isZero()) nonzeroOpening = true;
  }
  if (nonzeroOpening) return Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.request.ownershipOpeningBalance", "A newly managed inventory money scope must start at zero or undergo verified adoption of its complete existing posted balance", ["ACC-039.7", "ACC-039.9"])]);
  const prepared = prepareOwnedInventoryAccounting({
    bookId: state.identity.bookId, commandId: command.id, effectKey: `${command.id}:ownership:0` as InventoryOwnershipEffect["effectKey"], bookRevision: state.bookRevision + 1n,
    accountingDate: command.request.accountingDate, fiscalPeriodId: period.id, functionalCommodityId: state.identity.functionalCommodityId, ownerId: state.identity.ownerId,
    admissionSnapshot: state.admissionSnapshot, bookingPolicies: state.policies, accountingPolicies: state.accountingPolicySnapshot.policies, quantizationPolicies: state.quantizationPolicies, journals,
    ownership: state.ownership, readPool: (policy, commodity) => state.readPool(policy, commodity),
    identityPresence: (kind, id) => state.identityPresence(kind, id), managedMoneyScope: (scope) => state.managedMoneyScope(scope),
    latestMovementDate: (id) => state.latestMovementDate(id),
  }, command.request);
  if (prepared.disposition === "rejected") return prepared.diagnostics;
  return Object.freeze({ journals: Object.freeze(journals), ownership: prepared.effect,
    newLots: prepared.newLots, afterHoldings: prepared.afterHoldings, sequence });
}

function prepareOwnedInventoryCommandEffects(state: BookState, command: BookCommand & PostOwnedInventoryTransactionCommand):
  { readonly effects: readonly BookEffect[]; readonly sequence: bigint } | readonly SemanticDiagnostic[] {
  const movements = ownedMovements(state), anchors = (state.inventoryOwnershipEffects ?? []).flatMap((effect) => effect.newAnchors);
  const current = new Map(movements.map((movement) => [movement.coordinate.holdingId, movement]));
  const identities: Record<OwnedInventoryIdentityKind, Set<string>> = {
    operation: new Set(), lot: new Set(state.lots.map((lot) => lot.id)), holding: new Set(state.lotHoldings.map((holding) => holding.id)),
    anchor: new Set(anchors.map((anchor) => anchor.id)), movement: new Set(movements.map((movement) => movement.id)),
    allocation: new Set(state.lotAllocations.map((allocation) => allocation.allocation.id)), postingReference: new Set(),
  };
  for (const movement of movements) {
    if (isInventoryPostedReductionMovement(movement)) identities.allocation.add(movement.quantityAllocation.id);
    if (movement.monetaryKind === "journalLinked") identities.postingReference.add(movement.posting.id);
  }
  for (const anchor of anchors) for (const source of anchor.sourcePostings) identities.postingReference.add(source.id);
  for (const revision of state.revisions) if (revision.command.type === "postOwnedInventoryTransaction") {
    for (const operation of revision.command.request.operations) identities.operation.add(operation.id);
  }
  // Closed canonical accounting records may refer to the same source more than
  // once. Collect their stable reference identities without mistaking that reuse
  // for permission to assign a new journal source to an existing identity.
  const pending: unknown[] = [state.accountingState], seen = new Set<object>();
  while (pending.length !== 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if ("postingContentHash" in value && "postingId" in value && "journalId" in value && "id" in value && typeof value.id === "string") identities.postingReference.add(value.id);
    pending.push(...Object.values(value));
  }
  const managed = new Set(movements.map((movement) => inventoryMoneyScopeKey(movement.coordinate)));
  const openingBalances = new Map(command.request.operations.flatMap((operation) =>
    operation.kind === "acquisition" ? [operation.coordinate] : operation.kind === "transfer" ? [operation.destinationCoordinate] : [])
    .map((coordinate) => [inventoryMoneyScopeKey({ bookId: state.identity.bookId, functionalCommodityId: state.identity.functionalCommodityId,
      accountId: coordinate.accountId, dimensionMemberIds: coordinate.dimensionMemberIds }), ExactRational.zero()]));
  let balancesRead = false;
  const journals = journalLogOf(state);
  const prepared = prepareBookOwnedInventory({
    ...state, executionProfile: state.activeConfigurationSnapshot.executionProfile,
    journalIdentity: (id) => journals.has("journal", id) ? "present" : "absent",
    postingIdentity: (id) => journals.has("posting", id) ? "present" : "absent",
    periodStatus: (id) => periodIsClosed(state, id) ? "closed" : "open",
    hasLiveUnownedStock: (accounts) => state.lotHoldings.some((holding) => accounts.has(holding.accountId) && !holding.remainingQuantity.isZero() && !current.has(holding.id)),
    postedMoneyBalance: (scope) => {
      if (!balancesRead) {
        for (const booked of state.journals) for (const posting of booked.journal.postings) {
          const key = inventoryMoneyScopeKey({ bookId: state.identity.bookId, functionalCommodityId: state.identity.functionalCommodityId,
            accountId: posting.accountId, dimensionMemberIds: posting.dimensionMemberIds });
          const balance = openingBalances.get(key);
          if (balance !== undefined && !managed.has(key)) openingBalances.set(key, balance.add(posting.bookValue.amount.toRational()));
        }
        balancesRead = true;
      }
      return openingBalances.get(inventoryMoneyScopeKey(scope))!;
    },
    ownership: {
      bookId: state.identity.bookId, bookRevision: state.bookRevision, assertCurrent() { /* Immutable in-memory book value; storage adapters must pin a physical head. */ },
      readCurrentHolding: (id) => state.lotHoldings.find((holding) => holding.id === id),
      readCurrentPosition: (id) => current.get(id)?.afterPosition,
      readAnchor: (reference) => anchors.find((anchor) => anchor.id === reference.id && anchor.effectKey === reference.effectKey && anchor.artifactOrdinal === reference.artifactOrdinal && anchor.bookRevision === reference.bookRevision && contentHashEquals(anchor.contentHash, reference.contentHash)),
      readPositionAfterImage: (origin) => movements.find((movement) => movement.id === origin.movementId && movement.effectKey === origin.effectKey && movement.artifactOrdinal === origin.artifactOrdinal && movement.bookRevision === origin.bookRevision)?.afterPosition,
    },
    readPool: (policy, commodity) => state.lotHoldings.filter((holding) =>
      (command.request.algorithmVersion !== "1.2.0" || !holding.remainingQuantity.isZero()) &&
      holding.commodityId === commodity && policy.pools.some((pool) => pool.accountId === holding.accountId)).map((holding) => {
      const lot = state.lots.find((item) => item.id === holding.lotId);
      if (lot === undefined) throw new Error("Canonical inventory holding has no source lot");
      return { holding, lot };
    }),
    identityPresence: (kind, id) => identities[kind].has(id) ? "present" : "absent",
    managedMoneyScope: (scope) => managed.has(inventoryMoneyScopeKey(scope)) ? "managed" : "unmanaged",
    latestMovementDate: (id) => {
      const movement = current.get(id);
      if (movement === undefined) throw new Error("Canonical inventory position has no movement origin");
      return movement.accountingDate;
    },
  }, command);
  if (!("journals" in prepared)) return prepared;
  if (command.request.algorithmVersion === "1.2.0")
    return Object.freeze({ effects: ownedInventoryChangeEffects(prepared), sequence: prepared.sequence });
  const replacements = new Map(prepared.afterHoldings.map((holding) => [holding.id, holding]));
  const lots = Object.freeze([...state.lots, ...prepared.newLots]);
  const holdings = Object.freeze([...state.lotHoldings.map((holding) => replacements.get(holding.id) ?? holding), ...prepared.afterHoldings.filter((holding) => !identities.holding.has(holding.id))]);
  const lotState: LotStateEffect = { lots, holdings, allocations: state.lotAllocations, contentHash: hashLotState(lots, holdings, state.lotAllocations) };
  return Object.freeze({ effects: Object.freeze([
    ...prepared.journals.map((booked): BookEffect => ({ type: "journal", booked })),
    { type: "inventoryOwnership" as const, value: prepared.ownership }, { type: "lotState" as const, lotState },
  ]), sequence: prepared.sequence });
}

export function canonicalBookEffectValue(effect: BookEffect): CanonicalValue {
  switch (effect.type) {
    case "lotChanges": return { type: effect.type, lots: effect.changes.lots.map(lotValue),
      holdings: effect.changes.holdings.map(holdingValue), contentHash: hashValue(effect.changes.contentHash) };
    case "inventoryOwnership": return { type: effect.type, value: canonicalAccountingValue(effect.value) };
    case "activation": return {
      type: effect.type,
      boundary: {
        id: effect.boundary.id,
        firstAccountingDate: effect.boundary.firstAccountingDate,
        activatedAt: effect.boundary.activatedAt,
        openingJournalId: effect.boundary.openingJournalId ?? null,
        contentHash: hashValue(effect.boundary.contentHash),
      },
      financialIdentityHash: hashValue(effect.financialIdentityHash),
      configurationHash: hashValue(effect.configurationHash),
      configurationSnapshotHash: hashValue(effect.configurationSnapshot.contentHash),
    };
    case "configuration": return {
      type: effect.type,
      expectedConfigurationRevision: effect.expectedConfigurationRevision,
      nextConfigurationRevision: effect.nextConfigurationRevision,
      previousConfigurationHash: hashValue(effect.previousConfigurationHash),
      effectiveOn: effect.effectiveOn,
      configurationHash: hashValue(effect.contentHash),
      periodsHash: hashValue(hashPeriods(effect.periods)),
      chartHash: hashValue(hashChart(effect.admissionSnapshot)),
      policyHash: hashValue(hashPolicySnapshot(effect.policies)),
      quantizationPolicyHashes: effect.quantizationPolicies.map((policy) => hashValue(hashQuantizationPolicy(policy))),
      accountingPolicySnapshotHash: hashValue(effect.accountingPolicySnapshot.contentHash),
      previousConfigurationSnapshotHash: hashValue(effect.previousConfigurationSnapshot.contentHash),
      resultingConfigurationSnapshotHash: hashValue(effect.resultingConfigurationSnapshot.contentHash),
    };
    case "journal": return {
      type: effect.type,
      journal: canonicalJournalValue(effect.booked.journal),
      commandId: effect.booked.commandId,
      effectKey: effect.booked.effectKey,
      bookRevision: effect.booked.bookRevision,
      postingSequence: effect.booked.postingSequence,
      fiscalPeriodId: effect.booked.fiscalPeriodId,
      policySnapshotHash: hashValue(effect.booked.policySnapshotHash),
      quantizationPolicySnapshotHash: hashValue(effect.booked.quantizationPolicySnapshotHash),
      canonicalHash: hashValue(effect.booked.canonicalHash),
      derivations: effect.booked.derivations.map(canonicalDerivationValue),
    };
    case "lotState": return {
      type: effect.type,
      lots: effect.lotState.lots.map(lotValue),
      holdings: effect.lotState.holdings.map(holdingValue),
      allocations: effect.lotState.allocations.map(allocationValue),
      contentHash: hashValue(effect.lotState.contentHash),
    };
    case "correction": return { type: effect.type, ...effect.link };
    case "periodTransition": return {
      type: effect.type,
      transition: {
        periodId: effect.transition.periodId,
        kind: effect.transition.kind,
        reason: effect.transition.reason,
        bookRevision: effect.transition.bookRevision,
        recordedAt: effect.transition.recordedAt,
        supersededCloseIds: [...effect.transition.supersededCloseIds].sort(),
        contentHash: hashValue(effect.transition.contentHash),
      },
    };
    case "closePackage": return {
      type: effect.type,
      closePackage: {
        id: effect.closePackage.id,
        periodId: effect.closePackage.periodId,
        cycle: effect.closePackage.cycle,
        throughBookRevision: effect.closePackage.throughBookRevision,
        throughPostingSequence: effect.closePackage.throughPostingSequence,
        ledgerHash: hashValue(effect.closePackage.ledgerHash),
        chartHash: hashValue(effect.closePackage.chartHash),
        bookingPolicySnapshotHash: hashValue(effect.closePackage.bookingPolicySnapshotHash),
        quantizationPolicySnapshotHash: hashValue(effect.closePackage.quantizationPolicySnapshotHash),
        reportPopulationHash: hashValue(effect.closePackage.reportPopulationHash),
        reportingPolicySnapshotHash: hashValue(effect.closePackage.reportingPolicySnapshotHash),
        configurationRevision: effect.closePackage.configurationRevision,
        configurationSnapshotHash: hashValue(effect.closePackage.configurationSnapshotHash),
        configurationSnapshotContentHash: hashValue(effect.closePackage.configurationSnapshot.contentHash),
        bookStateSnapshotHash: hashValue(effect.closePackage.bookStateSnapshotHash),
        closingJournalId: effect.closePackage.closingJournalId ?? null,
        contentHash: hashValue(effect.closePackage.contentHash),
      },
    };
    case "provisionalInventoryLayer":
    case "inventoryRecosting":
    case "inventoryValueAdjustment":
    case "openItem":
    case "settlement":
    case "settlementAllocation":
    case "remeasurementResult":
    case "remeasurementReversal":
    case "allocationSchedule":
    case "allocationRecognition":
    case "allocationScheduleRevision":
    case "taxDetermination":
    case "consolidationCompilation":
      return canonicalAccountingEffectValue(effect);
  }
}

/** Exact original-result commitment only, not evaluation or retention authority.
 * Exporting the existing function preserves its historical preimage unchanged. */
export { resultHash as hashBookCommandResult };
function resultHash(
  command: BookCommand,
  outcome: "committed" | "rejected",
  revision: bigint,
  diagnostics: readonly SemanticDiagnostic[],
  completedAt: Instant,
  committedAt?: Instant,
): ContentHash {
  return hashCanonical({
    type: "BookCommandResult",
    commandInputHash: hashValue(command.inputHash),
    outcome,
    revision,
    completedAt,
    committedAt: committedAt ?? null,
    diagnostics: diagnostics.map((item) => ({
      code: item.code,
      path: item.path,
      message: item.message,
      requirementIds: [...item.requirementIds],
    })),
  });
}

export { rejectEvaluation as rejectBookCommand };
function rejectEvaluation(
  state: Pick<BookState, "bookRevision">,
  command: BookCommand,
  diagnostics: readonly SemanticDiagnostic[],
  retain: boolean,
): Extract<Evaluation, { disposition: "finished" }> {
  const retainedCommand = immutableCommand(command);
  const hash = resultHash(retainedCommand, "rejected", state.bookRevision, diagnostics, command.completedAt);
  const result = Object.freeze({
    disposition: "rejected" as const,
    observedBookRevision: state.bookRevision,
    resultHash: hash,
    diagnostics: Object.freeze([...diagnostics]),
    completedAt: command.completedAt,
  });
  return Object.freeze({
    disposition: "finished",
    result,
    ...(retain
      ? {
          retained: Object.freeze({
            command: retainedCommand,
            commandId: command.id,
            inputHash: retainedCommand.inputHash,
            outcome: "rejected" as const,
            observedBookRevision: state.bookRevision,
            resultHash: hash,
            completedAt: command.completedAt,
            diagnostics: result.diagnostics,
          }),
        }
      : {}),
  });
}

/** Canonical commitment calculation only; supplied context is not admission or
 * proof that the intent was evaluated, committed, or retained. */
export function hashCommitIntent(
  command: BookCommand,
  expectedBookRevision: bigint,
  nextBookRevision: bigint,
  resultingPostingSequence: bigint,
  expectedConfigurationRevision: bigint,
  nextConfigurationRevision: bigint,
  resultingConfigurationHash: ContentHash,
  effects: readonly BookEffect[],
): ContentHash {
  return hashCanonical({
    type: "BookCommitIntent",
    commandInputHash: hashValue(command.inputHash),
    expectedBookRevision,
    nextBookRevision,
    resultingPostingSequence,
    expectedConfigurationRevision,
    nextConfigurationRevision,
    resultingConfigurationHash: hashValue(resultingConfigurationHash),
    effects: effects.map(canonicalBookEffectValue),
  });
}

function makeIntent(state: BookState, command: BookCommand, effects: readonly BookEffect[], sequence: bigint): Evaluation {
  const ownershipDiagnostics = validateInventoryScopeChanges(state, command, effects);
  if (ownershipDiagnostics.length > 0) return rejectEvaluation(state, command, ownershipDiagnostics, true);
  return prepareBookIntent(state, command, effects, sequence);
}

/** Canonical intent construction from separately admitted effects. Not a public
 * commit operation: effect topology, read completeness and durability are caller
 * obligations. Shared by legacy and transaction-scoped execution. */
export function prepareBookIntent(
  state: Pick<BookState, "bookRevision" | "configurationRevision" | "configurationHash">,
  command: BookCommand, effects: readonly BookEffect[], sequence: bigint,
): Extract<Evaluation, { disposition: "ready" }> {
  const retainedCommand = immutableCommand(command);
  const nextRevision = state.bookRevision + 1n;
  const configuration = effects.find((effect) => effect.type === "configuration");
  const nextConfigurationRevision = configuration?.type === "configuration" ? configuration.nextConfigurationRevision : state.configurationRevision;
  const resultingConfigurationHash = configuration?.type === "configuration" ? configuration.contentHash : state.configurationHash;
  const canonicalHash = hashCommitIntent(
    retainedCommand,
    state.bookRevision,
    nextRevision,
    sequence,
    state.configurationRevision,
    nextConfigurationRevision,
    resultingConfigurationHash,
    effects,
  );
  return Object.freeze({
    disposition: "ready",
    intent: Object.freeze({
      command: retainedCommand,
      expectedBookRevision: state.bookRevision,
      nextBookRevision: nextRevision,
      resultingPostingSequence: sequence,
      expectedConfigurationRevision: state.configurationRevision,
      nextConfigurationRevision,
      resultingConfigurationHash,
      effects: immutableAccountingValue(effects),
      canonicalHash,
    }),
  });
}

/** Mathematical protocol inputs, not storage evidence. Null is explicit proven
 * absence; unresolved reads throw. The ledger authenticates both lookups at one
 * live head. Retained lookup occurs before hashing; financial chronology is read
 * only for a fresh, correctly hashed, same-book, supported-protocol command. */
export interface BookCommandProtocolContext {
  readonly identity: Pick<BookState["identity"], "bookId">;
  readonly bookRevision: bigint;
  retainedCommand(id: CommandId): RetainedCommandResult | null;
  previousFinancialCommit(): Instant | null;
}

export type BookCommandProtocolEvaluation =
  | Extract<Evaluation, { disposition: "finished" }>
  | { readonly disposition: "continue" };

/** Shared retry/input/scope/protocol/timeline prefix. Continue is NOT accounting
 * admission and finished is NOT a durable receipt: the complete evaluator and
 * serialized owner retain all state integrity and atomic publication duties. */
export function evaluateBookCommandProtocol(
  state: BookCommandProtocolContext,
  command: BookCommand,
): BookCommandProtocolEvaluation {
  const retained = state.retainedCommand(command.id);
  if (retained !== null && (typeof retained !== "object" || retained.commandId !== command.id || retained.command?.id !== command.id || retained.command.bookId !== state.identity.bookId)) {
    throw new TypeError("Incomplete or mismatched retained command evidence");
  }
  const recomputed = commandInputHash(command);
  if (retained !== null) {
    if (!contentHashEquals(retained.inputHash, recomputed) || !contentHashEquals(command.inputHash, recomputed)) {
      return rejectEvaluation(
        state,
        command,
        [diagnostic("command_identity_conflict", "command.inputHash", "Retained command ID was submitted with different canonical content", ["ACC-030", "ACC-038"])],
        false,
      );
    }
    return Object.freeze({
      disposition: "finished",
      result: Object.freeze({
        disposition: "replayed" as const,
        observedBookRevision: retained.observedBookRevision,
        resultHash: Object.freeze({ ...retained.resultHash }),
        diagnostics: immutableAccountingValue(retained.diagnostics),
        completedAt: retained.completedAt,
        ...(retained.outcome === "committed" ? { committedAt: retained.command.committedAt } : {}),
      }),
    });
  }
  if (!contentHashEquals(command.inputHash, recomputed)) {
    return rejectEvaluation(
      state,
      command,
      [diagnostic("command_identity_conflict", "command.inputHash", "Supplied input hash does not cover the complete canonical command", ["ACC-030", "ACC-038"])],
      false,
    );
  }
  // Admission failures must not create retained entries that violate the
  // durable protocol's canonical-command or same-book invariants.
  if (command.bookId !== state.identity.bookId) {
    return rejectEvaluation(state, command, [diagnostic("book_isolation_violation", "command.bookId", "Command and state belong to different books", ["ACC-026"])], false);
  }
  if (command.protocolVersion !== BOOK_COMMAND_PROTOCOL_VERSION) {
    return rejectEvaluation(
      state,
      command,
      [diagnostic("unresolved_accounting_input", "command.protocolVersion", `Unsupported book command protocol version ${command.protocolVersion}`, ["ACC-005", "ACC-030"])],
      true,
    );
  }
  const previousCommittedAt = state.previousFinancialCommit();
  if (previousCommittedAt !== null && (typeof previousCommittedAt !== "string" || !Number.isFinite(Date.parse(previousCommittedAt)))) throw new TypeError("Incomplete financial chronology evidence");
  if (!commandTimelineIsValid(command.issuedAt, command.completedAt, command.committedAt, previousCommittedAt ?? undefined)) {
    return rejectEvaluation(
      state,
      command,
      [diagnostic("temporal_semantics_violation", "command", "Command issue, completion, and commit times must be supplied in chronological order", ["ACC-006", "ACC-013", "ACC-021"])],
      true,
    );
  }
  return Object.freeze({ disposition: "continue" });
}

/** Identity semantics only, before full-state integrity and configuration checks.
 * The callback supplies the first canonical activation's identity hash or explicit
 * absence; it must include authenticated activation history, not today's rehash.
 * Unresolved evidence throws. An empty diagnostic set is not command admission. */
export function validateBookFinancialIdentity(
  state: Pick<BookState, "identity" | "financialIdentityHash" | "admissionSnapshot">,
  activationIdentity: () => ContentHash | null,
): readonly SemanticDiagnostic[] {
  if (state.admissionSnapshot.bookId !== state.identity.bookId) {
    return Object.freeze([diagnostic("book_isolation_violation", "command.bookId", "Command and state belong to different books", ["ACC-026"])]);
  }
  if (
    state.identity.code.length === 0 ||
    state.identity.code.trim() !== state.identity.code ||
    state.identity.accountingTimeZone.length === 0 ||
    state.admissionSnapshot.functionalCommodityId !== state.identity.functionalCommodityId
  ) {
    return Object.freeze([diagnostic("immutable_book_identity", "state.identity", "Book financial identity is incomplete or conflicts with its canonical chart snapshot", ["ACC-026", "ACC-027", "ACC-038"])]);
  }
  if (!contentHashEquals(hashFinancialIdentity(state.identity), state.financialIdentityHash)) {
    return Object.freeze([diagnostic("immutable_book_identity", "state.identity", "Activated book financial identity changed in place", ["ACC-027"])]);
  }
  const pinnedIdentityHash = activationIdentity();
  if (pinnedIdentityHash !== null && (typeof pinnedIdentityHash !== "object" || typeof pinnedIdentityHash.algorithm !== "string" || typeof pinnedIdentityHash.canonicalizationVersion !== "string" || typeof pinnedIdentityHash.digest !== "string")) throw new TypeError("Incomplete activation identity evidence");
  if (pinnedIdentityHash !== null && !contentHashEquals(pinnedIdentityHash, state.financialIdentityHash)) {
    return Object.freeze([diagnostic("immutable_book_identity", "state.financialIdentityHash", "Book identity no longer matches the identity pinned by activation history", ["ACC-027", "ACC-031"])]);
  }
  return Object.freeze([]);
}

export type RemeasurementAdmissionCandidate = Pick<RemeasurementResult, "id" | "kind" | "effectiveOn" | "policyId">;

/** Exact complete-population comparison only. The caller authenticates both the
 * selected policy and every canonical layer; an empty/partial caller array is
 * not proof of absence. Sorting never mutates supplied or canonical inputs. */
export function inventoryCostLayersMatch(canonical: readonly InventoryLayerInput[], supplied: readonly InventoryLayerInput[]): boolean {
  const left = [...canonical].sort((a, b) => compareCanonicalText(a.id, b.id));
  const right = [...supplied].sort((a, b) => compareCanonicalText(a.id, b.id));
  return left.length === right.length && left.every((layer, index) => {
    const other = right[index];
    return other !== undefined && other.id === layer.id && other.accountId === layer.accountId && other.acquiredAt === layer.acquiredAt && other.quantity.equals(layer.quantity) && other.totalBasis.equals(layer.totalBasis);
  });
}

/** Current-policy/date/explicit-reversal predicate only. The caller still proves
 * policy selection and absence of a canonical reversal over complete populations. */
export function requiresRemeasurementReversal(command: BookCommand, result: RemeasurementAdmissionCandidate, policy: AccountingPolicy | undefined): boolean {
  // Reversals must be able to discharge multiple overdue positions one at a
  // time. The command preparer still validates the exact retained target and
  // reversal journal; this exception cannot admit an ordinary measurement.
  const reversing = command.type === "postCurrencyRemeasurement" && command.request.reversalOf !== undefined;
  return result.kind === "unrealized" && result.effectiveOn < command.issuedAt.slice(0, 10) &&
    policy?.kind === "currencyRemeasurement" && policy.id === result.policyId && policy.reversalRequired && !reversing;
}

/** Book-wide semantic guards, after configuration admission and before dispatch.
 * The callback resolves the first due, unreversed result in canonical order, or
 * explicit absence, for THIS command. Completeness/source authentication remain
 * the caller's duty; no state-integrity or publication authority is conferred. */
export function validateBookGlobalAdmission(
  state: Pick<BookState, "status" | "openingBoundary">,
  command: Pick<BookCommand, "type">,
  overdueRemeasurement: () => RemeasurementAdmissionCandidate | null,
): readonly SemanticDiagnostic[] {
  const specializedAccountingCommand = command.type === "postOwnedInventoryTransaction" || command.type === "postInventoryTransaction" || command.type === "recostProvisionalInventory" || command.type === "adjustInventoryValue" || command.type === "recognizeOpenItem" || command.type === "applySettlement" || command.type === "postCurrencyRemeasurement" || command.type === "createAllocationSchedule" || command.type === "recognizeScheduledAllocation" || command.type === "reviseAllocationSchedule" || command.type === "postTaxedTransaction" || command.type === "compileConsolidation";
  if (specializedAccountingCommand && (state.status !== "open" || state.openingBoundary === undefined)) {
    return Object.freeze([diagnostic("unresolved_accounting_input", "state.openingBoundary", "Specialized accounting commands require an activated open book", ["ACC-028", "ACC-047.1", "ACC-047.5"])]);
  }
  const overdue = overdueRemeasurement();
  if (overdue !== null && (typeof overdue !== "object" || overdue.kind !== "unrealized" || typeof overdue.id !== "string" || typeof overdue.effectiveOn !== "string" || typeof overdue.policyId !== "string")) throw new TypeError("Incomplete overdue remeasurement evidence");
  if (overdue !== null) return Object.freeze([diagnostic("currency_remeasurement_violation", "state.accountingState.remeasurementResults", "A required prior-period unrealized remeasurement reversal is missing", ["ACC-043.5"])]);
  return Object.freeze([]);
}

/** The first activation effect in revision order. The first revision that has one is found by
 * scanning only that far (and remembering it), which is what flattening every revision's effects and
 * taking the first match returned. */
function firstActivation(state: Pick<BookState, "revisions">) {
  const revision = revisionLogOf(state).firstWhere("activation", (item) => item.effects.some((effect) => effect.type === "activation"));
  return revision?.effects.find((effect) => effect.type === "activation");
}

function activationIdentityHash(state: Pick<BookState, "revisions">): ContentHash | null {
  return firstActivation(state)?.financialIdentityHash ?? null;
}

/** Complete common admission in canonical diagnostic/retry order. Continue only
 * permits command-specific preparation; it is neither a commit intent nor a
 * durable result. This bridge deliberately requires the COMPLETE canonical state
 * and protocol: profile history and the full-state hash cannot be proved from a
 * sparse header or a caller-supplied digest. Storage authenticates and pins both. */
export function evaluateBookCommandAdmission(
  state: BookState,
  protocol: BookProtocolState,
  command: BookCommand,
): BookCommandProtocolEvaluation {
  const admission = evaluateBookCommandProtocol({
    identity: state.identity, bookRevision: state.bookRevision,
    retainedCommand: (id) => retainedLogOf(protocol).first("command", id) ?? null,
    previousFinancialCommit: () => latestRevisionRecord(state)?.committedAt ?? null,
  }, command);
  if (admission.disposition === "finished") return admission;
  const identityDiagnostics = validateBookFinancialIdentity(state, () => activationIdentityHash(state));
  if (identityDiagnostics.length > 0) return rejectEvaluation(state, command, identityDiagnostics, true);
  const profileDiagnostics = validateBookProfileSelection(state, true);
  if (profileDiagnostics.length > 0) return rejectEvaluation(state, command, profileDiagnostics, true);
  const stateHashDiagnostics = validateStateHashAtAdmission(state);
  if (stateHashDiagnostics.length > 0) return rejectEvaluation(state, command, stateHashDiagnostics, true);
  if (command.expectedBookRevision !== state.bookRevision) {
    return rejectEvaluation(state, command, [diagnostic("stale_book_revision", "command.expectedBookRevision", "Command was evaluated against a stale book revision", ["ACC-021", "ACC-031"])], true);
  }

  const configurationDiagnostics = validateBookConfiguration(state);
  if (configurationDiagnostics.length > 0) return rejectEvaluation(state, command, configurationDiagnostics, true);
  const globalDiagnostics = validateBookGlobalAdmission(state, command, () => state.accountingState.remeasurementResults.find((result) => {
    const policy = state.accountingPolicySnapshot.policies.find((candidate) => candidate.kind === "currencyRemeasurement" && candidate.id === result.policyId);
    return requiresRemeasurementReversal(command, result, policy) && !state.accountingState.remeasurementReversals.some((reversal) => reversal.originalResultId === result.id);
  }) ?? null);
  if (globalDiagnostics.length > 0) return rejectEvaluation(state, command, globalDiagnostics, true);
  return Object.freeze({ disposition: "continue" });
}

export function evaluateBookCommand(
  state: BookState,
  protocol: BookProtocolState,
  command: BookCommand,
): Evaluation {
  const admission = evaluateBookCommandAdmission(state, protocol, command);
  if (admission.disposition === "finished") return admission;
  const nextRevision = state.bookRevision + 1n;

  switch (command.type) {
    case "activateBook": {
      if (state.status !== "configuring" || state.openingBoundary !== undefined) {
        return rejectEvaluation(state, command, [diagnostic("fabricated_opening_journal", "command", "Book already has an immutable opening boundary", ["ACC-028"])], true);
      }
      if ((command.mode === "newZeroBalance") !== (command.opening === undefined)) {
        return rejectEvaluation(state, command, [diagnostic("fabricated_opening_journal", "command.opening", "A zero-balance book has no opening journal and a migration must have exactly one", ["ACC-028"])], true);
      }
      if (command.opening === undefined && (command.lotOperations?.length ?? 0) > 0) {
        return rejectEvaluation(state, command, [diagnostic("unresolved_accounting_input", "command.lotOperations", "Lot operations require a canonical journal", ["ACC-005", "ACC-018", "ACC-021"])], true);
      }
      const effects: BookEffect[] = [];
      let sequence = state.latestPostingSequence;
      if (command.opening !== undefined) {
        if (command.opening.journal.kind !== "opening" || command.opening.journal.accountingDate !== command.firstAccountingDate) {
          return rejectEvaluation(state, command, [diagnostic("fabricated_opening_journal", "command.opening", "Migration opening journal must be typed opening at the boundary date", ["ACC-028", "ACC-029"])], true);
        }
        sequence += 1n;
        const booked = prepareBookJournal(journalReadContext(state), command, command.opening, undefined, nextRevision, sequence, false);
        if (!("journal" in booked)) return rejectEvaluation(state, command, booked, true);
        effects.push({ type: "journal", booked });
        const lotState = prepareLotState(state, booked.journal, command.lotOperations);
        if (Array.isArray(lotState)) return rejectEvaluation(state, command, lotState, true);
        if (lotState !== undefined) effects.push({ type: "lotState", lotState: lotState as LotStateEffect });
      }
      const boundaryHash = hashCanonical({
        type: "OpeningBoundary",
        id: command.boundaryId,
        firstAccountingDate: command.firstAccountingDate,
        activatedAt: command.issuedAt,
        openingJournalId: command.opening?.journal.id ?? null,
        configurationSnapshotHash: hashValue(state.activeConfigurationSnapshot.contentHash),
      });
      effects.unshift({
        type: "activation",
        boundary: Object.freeze({
          id: command.boundaryId,
          firstAccountingDate: command.firstAccountingDate,
          activatedAt: command.issuedAt,
          ...(command.opening === undefined ? {} : { openingJournalId: command.opening.journal.id }),
          configurationSnapshot: state.activeConfigurationSnapshot,
          contentHash: boundaryHash,
        }),
        financialIdentityHash: state.financialIdentityHash,
        configurationHash: state.configurationHash,
        configurationSnapshot: state.activeConfigurationSnapshot,
      });
      return makeIntent(state, command, effects, sequence);
    }
    case "postJournal": {
      const sequence = state.latestPostingSequence + 1n;
      const booked = prepareOrdinaryBookJournal({ ...journalReadContext(state), status: state.status,
        ...(state.openingBoundary === undefined ? {} : { openingBoundary: state.openingBoundary }), bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence }, command);
      if (!("journal" in booked)) return rejectEvaluation(state, command, booked, true);
      const effects: BookEffect[] = [{ type: "journal", booked }];
      const lotState = prepareLotState(state, booked.journal, command.lotOperations);
      if (Array.isArray(lotState)) return rejectEvaluation(state, command, lotState, true);
      if (lotState !== undefined) effects.push({ type: "lotState", lotState: lotState as LotStateEffect });
      return makeIntent(state, command, effects, sequence);
    }
    case "postOwnedInventoryTransaction": {
      const prepared = prepareOwnedInventoryCommandEffects(state, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "postInventoryTransaction": {
      if (!validAccountingDerivation(command.derivation) || command.derivation.policyId !== command.request.policyId || command.derivation.policyVersion !== command.request.policyVersion) return rejectEvaluation(state, command, [diagnostic("inventory_cost_policy_incoherent", "command.derivation", "Inventory derivation must be approved and identify the selected policy version", ["ACC-039.1", "ACC-039.6"])], true);
      const inventoryPolicy = state.accountingPolicySnapshot.policies.find((policy): policy is InventoryCostPolicy => policy.kind === "inventoryCost" && policy.id === command.request.policyId && policy.version === command.request.policyVersion);
      const canonicalLayers = inventoryPolicy === undefined ? [] : state.lotHoldings
        .filter((holding) => inventoryPolicy !== undefined && inventoryPolicy.pools.some((pool) => pool.accountId === holding.accountId) && holding.commodityId === command.inventoryCommodityId && !holding.remainingQuantity.isZero())
        .map((holding) => {
          const lot = state.lots.find((candidate) => candidate.id === holding.lotId);
          return lot === undefined ? undefined : { id: holding.id, accountId: holding.accountId, acquiredAt: lot.acquiredAt, quantity: holding.remainingQuantity, totalBasis: holding.remainingTotalBasis };
        })
        .filter((layer): layer is NonNullable<typeof layer> => layer !== undefined);
      const canonicalPoolMatches = inventoryPolicy !== undefined && inventoryCostLayersMatch(canonicalLayers, command.request.layers);
      if (!canonicalPoolMatches) return rejectEvaluation(state, command, [diagnostic("inventory_cost_policy_incoherent", "command.request.layers", "Inventory costing must reproduce the complete canonical lot-holding population for the selected pool", ["ACC-039.2", "ACC-039.4", "ACC-039.5", "ACC-047.5"])], true);
      const cost = calculateInventoryCost(state.accountingPolicySnapshot.policies, state.identity.bookId, command.request);
      if (cost.disposition === "rejected") return rejectEvaluation(state, command, cost.diagnostics, true);
      const inventoryPostingId = identifier<"Posting">(`${command.id}-inventory`);
      const provisionalPostingId = identifier<"Posting">(`${command.id}-provisional-inventory`);
      const ordinaryQuantity = command.request.quantity.subtract(cost.provisionalQuantity);
      const disposeOperations = (command.lotOperations ?? []).filter((operation): operation is Extract<LotOperation, { readonly type: "dispose" }> => operation.type === "dispose");
      const expectedHoldingIds = cost.allocations.map((allocation) => allocation.layerId).sort();
      const dispose = disposeOperations[0];
      const selectionMatches = dispose !== undefined && inventoryDisposalSelectionMatches(dispose.selection, inventoryPolicy.method, cost.allocations);
      if (ordinaryQuantity.isZero()
        ? (command.lotOperations?.length ?? 0) !== 0
        : (command.lotOperations?.length !== 1 || disposeOperations.length !== 1 || dispose === undefined || dispose.journalPostingId !== inventoryPostingId || !dispose.requestedQuantity.equals(ordinaryQuantity) || !selectionMatches || [...dispose.holdingIds].sort().join("\u0000") !== expectedHoldingIds.join("\u0000") || dispose.identities.length !== cost.allocations.length)
      ) return rejectEvaluation(state, command, [diagnostic("inventory_cost_policy_incoherent", "command.lotOperations", "Ordinary inventory cost must be one canonical disposal matching the selected method, holdings, quantities, and stable allocation identities", ["ACC-039.3", "ACC-039.4", "ACC-039.5", "ACC-039.6"])], true);
      const journalDraft = inventoryCostJournalDraft(state, command, cost);
      if (!cost.provisionalQuantity.isZero() && command.provisionalLayerId === undefined) return rejectEvaluation(state, command, [diagnostic("provisional_inventory_violation", "command.provisionalLayerId", "A provisional shortage requires stable layer identity", ["ACC-040.2", "ACC-040.6"])], true);
      const calculation: AccountingCalculation = Object.freeze({ disposition: "draft", draft: Object.freeze({ journals: Object.freeze([journalDraft]), effects: Object.freeze([]) }) });
      const prepared = prepareAccountingCalculation(state, command, calculation, command.fiscalPeriodId, nextRevision);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      const journalEffect = prepared.effects.find((effect) => effect.type === "journal");
      if (journalEffect?.type !== "journal") throw new Error("Inventory calculator omitted its canonical journal");
      const accountingEffects: AccountingEffect[] = [];
      if (!cost.provisionalQuantity.isZero()) {
        const issuePosting = journalEffect.booked.journal.postings.find((posting) => posting.id === provisionalPostingId);
        if (issuePosting === undefined || command.provisionalLayerId === undefined) throw new Error("Provisional inventory journal omitted its issue posting");
        accountingEffects.push(createProvisionalInventoryLayerEffect({
          id: command.provisionalLayerId,
          bookId: state.identity.bookId,
          policyId: inventoryPolicy.id,
          policy: inventoryPolicy,
          issueSource: createCanonicalPostingReference(identifier<"CanonicalPostingReference">(`${command.provisionalLayerId}-issue-source`), state.identity.bookId, journalEffect.booked.journal.id, issuePosting, journalEffect.booked.effectKey as never),
          openedAt: command.request.governedAt,
          quantity: cost.provisionalQuantity,
          provisionalBasis: cost.provisionalBasis,
          derivation: command.derivation,
        }));
      }
      const lotState = prepareLotState(state, journalEffect.booked.journal, command.lotOperations);
      if (Array.isArray(lotState)) return rejectEvaluation(state, command, lotState, true);
      const sourceDiagnostics = validateAccountingSourceClosure(state, Object.freeze([...prepared.effects, ...accountingEffects]), command);
      if (sourceDiagnostics.length > 0) return rejectEvaluation(state, command, sourceDiagnostics, true);
      const effects: readonly BookEffect[] = Object.freeze([
        ...prepared.effects,
        ...accountingEffects,
        ...(lotState === undefined ? [] : [{ type: "lotState" as const, lotState: lotState as LotStateEffect }]),
      ]);
      return makeIntent(state, command, effects, prepared.sequence);
    }
    case "recostProvisionalInventory": {
      const recostingDate = command.request.resolvedAt.slice(0, 10) as LocalDate;
      const matchingPeriods = state.periods.filter((period) => period.kind === "regular" && period.startsOn <= recostingDate && recostingDate <= period.endsOn);
      const selectedPeriod = resolveRecostingPeriod(state.periods, recostingDate, command.fiscalPeriodId);
      if (matchingPeriods.length !== 1 || selectedPeriod === undefined || periodIsClosed(state, selectedPeriod.id)) return rejectEvaluation(state, command, [diagnostic("provisional_inventory_violation", "command.recosting.resolvedAt", "Recosting must enter an admissible open fiscal population or follow an explicit reopen", ["ACC-040.5"])], true);
      const calculation = calculateInventoryRecosting(state.accountingState, command.request);
      if (calculation.disposition === "rejected") return rejectEvaluation(state, command, calculation.diagnostics, true);
      const recosting = calculation.draft.effects.find((effect) => effect.type === "inventoryRecosting");
      if (recosting?.type !== "inventoryRecosting") throw new Error("Recosting calculator omitted its canonical effect");
      const journals: ExactPreparedJournal[] = [];
      if (!recosting.value.adjustment.isZero()) {
        journals.push(Object.freeze({ id: identifier<"JournalTransaction">(`${command.id}-journal`), kind: "adjustment", economicAt: command.request.resolvedAt, accountingDate: command.request.resolvedAt.slice(0, 10) as LocalDate, recordedAt: command.issuedAt, narration: "Provisional inventory recosting", derivations: Object.freeze([command.request.derivation]), postings: Object.freeze([
          Object.freeze({ id: identifier<"Posting">(`${command.id}-adjustment`), accountId: command.adjustmentAccountId, units: recosting.value.adjustment, unitsCommodityId: state.identity.functionalCommodityId, exactBookValue: recosting.value.adjustment }),
          Object.freeze({ id: identifier<"Posting">(`${command.id}-inventory`), accountId: command.inventoryAccountId, units: recosting.value.adjustment.negate(), unitsCommodityId: state.identity.functionalCommodityId, exactBookValue: recosting.value.adjustment.negate() }),
        ]) }));
      }
      const prepared = prepareAccountingCalculation(state, command, Object.freeze({ disposition: "draft", draft: Object.freeze({ journals: Object.freeze(journals), effects: calculation.draft.effects }) }), command.fiscalPeriodId, nextRevision);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "adjustInventoryValue": {
      if (command.request.generatedEffectKey !== `${command.id}:journal:0`) {
        return rejectEvaluation(state, command, [diagnostic("inventory_value_adjustment_violation", "command.request.generatedEffectKey", "Inventory adjustment lineage must name the real journal effect generated by this command", ["ACC-039.4", "ACC-047.2"])], true);
      }
      const calculation = calculateInventoryValueAdjustment(
        state.accountingPolicySnapshot.policies,
        state.identity.bookId,
        state.identity.functionalCommodityId,
        state.lots,
        state.lotHoldings,
        command.request,
      );
      if (calculation.disposition === "rejected") return rejectEvaluation(state, command, calculation.diagnostics, true);
      const prepared = prepareAccountingCalculation(state, command, calculation, command.fiscalPeriodId, nextRevision);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      const adjustment = calculation.draft.effects.find((effect) => effect.type === "inventoryValueAdjustment");
      if (adjustment?.type !== "inventoryValueAdjustment") throw new Error("Inventory value calculator omitted its canonical effect");
      const holdings = applyInventoryValueAdjustmentToHoldings(state.lotHoldings, adjustment.value.allocations);
      const lotState: LotStateEffect = Object.freeze({
        lots: state.lots,
        holdings,
        allocations: state.lotAllocations,
        contentHash: hashLotState(state.lots, holdings, state.lotAllocations),
      });
      return makeIntent(state, command, Object.freeze([...prepared.effects, { type: "lotState", lotState }]), prepared.sequence);
    }
    case "recognizeOpenItem": {
      const prepared = prepareBookOpenItem({ ...journalReadContext(state), bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence, executionProfile: state.activeConfigurationSnapshot.executionProfile,
        openItemIdentity: (id) => state.accountingState.openItems.some((item) => item.id === id) ? "present" : "absent",
        sourceJournals: () => state.journals,
        financialSourceOwner: (source) => financialSourceOwner(state.accountingState, source),
      }, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "applySettlement": {
      const prepared = prepareBookSettlement({ ...journalReadContext(state), ...settlementSourceContext(state),
        bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
        accountingPolicySnapshot: state.accountingPolicySnapshot }, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "postTaxedTransaction": {
      const prepared = prepareBookTaxTransaction({ ...journalReadContext(state), bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence, accountingPolicySnapshot: state.accountingPolicySnapshot,
        taxIdentity: (id) => state.accountingState.taxDeterminations.some((value) => value.id === id) ? "present" : "absent",
      }, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "createAllocationSchedule":
    case "recognizeScheduledAllocation":
    case "reviseAllocationSchedule": {
      const prepared = prepareBookAllocation({ ...journalReadContext(state), bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence, accountingPolicySnapshot: state.accountingPolicySnapshot,
        accountingState: state.accountingState,
        accountingIdentity: (effect) => accountingEffectExists(state.accountingState, effect) ? "present" : "absent",
        resolveSource: (reference) => resolveCanonicalPosting(state, [], reference),
      }, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "postCurrencyRemeasurement": {
      const prepared = prepareBookCurrencyRemeasurement({ ...journalReadContext(state), ...currencySourceFacts(state),
        bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
        accountingPolicySnapshot: state.accountingPolicySnapshot, currencyState: state.accountingState,
        accountingIdentity: (effect) => accountingEffectExists(state.accountingState, effect) ? "present" : "absent",
        originalJournal: (id) => journalLogOf(state).first("journal", id) ?? null,
      }, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "compileConsolidation": {
      const prepared = prepareBookConsolidation({ ...journalReadContext(state), bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence, accountingPolicySnapshot: state.accountingPolicySnapshot,
        compilationIdentity: id => state.accountingState.consolidationCompilations.some(value => value.id === id) ? "present" : "absent",
      }, command);
      if (!("effects" in prepared)) return rejectEvaluation(state, command, prepared, true);
      return makeIntent(state, command, prepared.effects, prepared.sequence);
    }
    case "correctJournal": {
      const prepared = prepareBookCorrection({...journalReadContext(state), bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence,
        originalJournal: journalLogOf(state).first("journal", command.originalJournalId) ?? null,
        alreadyCorrected: state.corrections.some((link) => link.originalJournalId === command.originalJournalId),
        currencySource: isCurrencyJournal(state.accountingState, command.originalJournalId),
      }, command);
      if (!("booked" in prepared)) return rejectEvaluation(state, command, prepared, true);
      const {booked, link} = prepared;
      const effects: BookEffect[] = [{type:"journal",booked},{type:"correction",link}];
      const lotState = prepareLotState(state, booked.journal, command.lotOperations);
      if (Array.isArray(lotState)) return rejectEvaluation(state, command, lotState, true);
      if (lotState !== undefined) effects.push({type:"lotState",lotState:lotState as LotStateEffect});
      return makeIntent(state, command, effects, booked.postingSequence);
    }
    case "closePeriod": {
      const prepared = prepareBookClose({
        ...journalReadContext(state), bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
        configurationRevision: state.configurationRevision, configurationHash: state.configurationHash,
        activeConfigurationSnapshot: state.activeConfigurationSnapshot,
        previousCloseCount: BigInt(state.closePackages.filter((item) => item.periodId === command.periodId).length),
        bookStateSnapshotHash: latestRevisionRecord(state)?.chainHash ?? state.contentHash,
        closePackageIdentity: (id) => state.closePackages.some((item) => item.id === id) ? "present" : "absent",
        journals: () => [...state.journals].sort((left, right) => Number(left.postingSequence - right.postingSequence)),
      }, command);
      if (prepared.disposition === "finished") return prepared;
      const ownershipDiagnostics = validateInventoryScopeChanges(state, command, prepared.intent.effects);
      return ownershipDiagnostics.length ? rejectEvaluation(state, command, ownershipDiagnostics, true) : prepared;
    }
    case "reopenPeriod": {
      const prepared = prepareFullBookReopen(state, command);
      if (prepared.disposition === "finished") return prepared;
      const ownershipDiagnostics = validateInventoryScopeChanges(state, command, prepared.intent.effects);
      return ownershipDiagnostics.length ? rejectEvaluation(state, command, ownershipDiagnostics, true) : prepared;
    }
    case "replaceConfiguration":
      // Configuration preparation emits only a configuration effect: it cannot
      // alter journal postings, lot holdings or inventory ownership allocations.
      return prepareBookConfigurationChange(
        {
          ...state,
          latestAccountingDate: latestBookAccountingDate(state),
        },
        command,
      );
  }
}

/** Complete snapshot inputs for period lifecycle preparation. Ordinary saves
 * never load these populations. Common protocol/global/managed-source admission
 * and actual durable publication remain the caller's obligations. */
export interface BookCloseContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "configurationRevision" | "configurationHash" | "activeConfigurationSnapshot"> {
  readonly previousCloseCount: bigint;
  readonly bookStateSnapshotHash: ContentHash;
  closePackageIdentity(id: ClosePackageId): "present" | "absent";
  journals(): Iterable<Pick<BookedJournal, "postingSequence" | "canonicalHash">>;
}
export interface BookReopenContext extends BookJournalReadContext,
  Pick<BookState, "bookRevision" | "latestPostingSequence" | "configurationRevision" | "configurationHash"> {
  readonly currentClosePackages: readonly ClosePackage[];
  journal(id: string): BookedJournal | null;
}
function currentPeriodIsClosed(state: BookAccountingPeriodReadContext, id: FiscalPeriodId): boolean {
  const status = state.periodStatus(id);
  if (status !== "open" && status !== "closed") throw new TypeError("Incomplete period closure evidence");
  return status === "closed";
}
export function prepareBookClose(state: BookCloseContext, command: BookCommand & ClosePeriodCommand): Evaluation {
  if (typeof state.previousCloseCount !== "bigint" || state.previousCloseCount < 0n)
    throw new TypeError("Incomplete close cycle evidence");
  const nextRevision = state.bookRevision + 1n;

  const period = state.periods.find((item) => item.id === command.periodId);
  if (
    period === undefined ||
    currentPeriodIsClosed(state, period.id) ||
    journalIdentityPresent(state.closePackageIdentity(command.closePackageId))
  ) {
    return rejectEvaluation(state, command, [diagnostic("fiscal_period_admission", "command.periodId", "Close requires one currently open fiscal period", ["ACC-029", "ACC-032"])], true);
  }
  const effects: BookEffect[] = [];
  let sequence = state.latestPostingSequence;
  if (command.closing !== undefined) {
    if (command.closing.journal.kind !== "closing") {
      return rejectEvaluation(state, command, [diagnostic("fiscal_period_admission", "command.closing", "Close journal must have closing kind", ["ACC-029", "ACC-032"])], true);
    }
    sequence += 1n;
    const booked = prepareBookJournal(state, command, command.closing, command.periodId, nextRevision, sequence, false);
    if (!("journal" in booked)) return rejectEvaluation(state, command, booked, true);
    effects.push({ type: "journal", booked });
  }
  const cycle = state.previousCloseCount + 1n;
  const closingJournals = effects
    .filter(isJournalEffect)
    .map((effect) => effect.booked);
  const ledgerHash = hashBookLedgerCutoff(state.identity.bookId, nextRevision, sequence, (function* () { yield* state.journals(); yield* closingJournals; })());
  const policyHash = hashPolicySnapshot(state.policies);
  const quantizationPolicyHash = hashQuantizationPolicies(state.quantizationPolicies);
  const chartHash = hashChart(state.admissionSnapshot);
  const closeHash = hashCanonical({
    type: "ClosePackage",
    id: command.closePackageId,
    periodId: period.id,
    cycle,
    throughBookRevision: nextRevision,
    throughPostingSequence: sequence,
    ledgerHash: hashValue(ledgerHash),
    chartHash: hashValue(chartHash),
    policyHash: hashValue(policyHash),
    quantizationPolicyHash: hashValue(quantizationPolicyHash),
    reportPopulationHash: hashValue(command.reportPopulationHash),
    reportingPolicySnapshotHash: hashValue(command.reportingPolicySnapshotHash),
    configurationRevision: state.configurationRevision,
    configurationSnapshotHash: hashValue(state.configurationHash),
    configurationSnapshotContentHash: hashValue(state.activeConfigurationSnapshot.contentHash),
    bookStateSnapshotHash: hashValue(state.bookStateSnapshotHash),
    closingJournalId: command.closing?.journal.id ?? null,
  });
  const closePackage: ClosePackage = Object.freeze({
    id: command.closePackageId,
    periodId: period.id,
    cycle,
    throughBookRevision: nextRevision,
    throughPostingSequence: sequence,
    ledgerHash,
    chartHash,
    bookingPolicySnapshotHash: policyHash,
    quantizationPolicySnapshotHash: quantizationPolicyHash,
    reportPopulationHash: command.reportPopulationHash,
    reportingPolicySnapshotHash: command.reportingPolicySnapshotHash,
    configurationRevision: state.configurationRevision,
    configurationSnapshotHash: state.configurationHash,
    configurationSnapshot: state.activeConfigurationSnapshot,
    bookStateSnapshotHash: state.bookStateSnapshotHash,
    ...(command.closing === undefined ? {} : { closingJournalId: command.closing.journal.id }),
    contentHash: closeHash,
  });
  const transitionHash = hashCanonical({ type: "PeriodTransition", periodId: period.id, kind: "close", reason: command.reason, revision: nextRevision, recordedAt: command.issuedAt });
  const transition: PeriodTransition = Object.freeze({ periodId: period.id, kind: "close", reason: command.reason, bookRevision: nextRevision, recordedAt: command.issuedAt, supersededCloseIds: Object.freeze([]), contentHash: transitionHash });
  effects.push({ type: "closePackage", closePackage }, { type: "periodTransition", transition });
  return prepareBookIntent(state, command, effects, sequence);
}
function prepareFullBookReopen(state: BookState, command: BookCommand & ReopenPeriodCommand): Evaluation {
  return prepareBookReopen({
    ...journalReadContext(state), bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision, configurationHash: state.configurationHash,
    currentClosePackages: state.closePackages.filter((item) => closeIsCurrent(state, item.id)),
    journal: (id) => journalLogOf(state).first("journal", id) ?? null,
  }, command);
}

export function prepareBookReopen(state: BookReopenContext, command: BookCommand & ReopenPeriodCommand): Evaluation {
  const nextRevision = state.bookRevision + 1n;

  const period = state.periods.find((item) => item.id === command.periodId);
  if (period === undefined || !currentPeriodIsClosed(state, period.id)) {
    return rejectEvaluation(state, command, [diagnostic("fiscal_period_admission", "command.periodId", "Reopen requires one currently closed period", ["ACC-029", "ACC-032"])], true);
  }
  const dependentCloses = state.currentClosePackages
    .filter((item) => {
      const closePeriod = state.periods.find((candidate) => candidate.id === item.periodId);
      return closePeriod !== undefined && closePeriod.endsOn >= period.endsOn;
    });
  // This command can reverse only its target period's closing journal. Never
  // supersede another period's monetary close and discard its reversal source.
  if (dependentCloses.some((item) => item.periodId !== period.id && item.closingJournalId !== undefined)) {
    return rejectEvaluation(state, command, [diagnostic("invalid_correction_topology", "command.periodId",
      "Reopen dependent periods with closing journals before this period", ["ACC-004", "ACC-029", "ACC-032"])], true);
  }
  const supersededCloseIds = dependentCloses.map((item) => item.id);
  const currentTargetClose = [...state.currentClosePackages]
    .reverse()
    .find((item) => item.periodId === period.id);
  const closingJournal = currentTargetClose?.closingJournalId === undefined
    ? undefined
    : state.journal(currentTargetClose.closingJournalId) ?? undefined;
  if (currentTargetClose?.closingJournalId !== undefined && (closingJournal === undefined ||
    closingJournal.journal.id !== currentTargetClose.closingJournalId || closingJournal.journal.bookId !== state.identity.bookId))
    throw new TypeError("Missing or inconsistent retained closing journal");
  if ((closingJournal === undefined) !== (command.reversal === undefined)) {
    return rejectEvaluation(
      state,
      command,
      [diagnostic("invalid_correction_topology", "command.reversal", "Reopening a close with a closing journal requires exactly one supplied reversal; otherwise no reversal is admitted", ["ACC-004", "ACC-032"])],
      true,
    );
  }
  const effects: BookEffect[] = [];
  let sequence = state.latestPostingSequence;
  if (closingJournal !== undefined && command.reversal !== undefined) {
    if (
      command.reversal.journal.kind !== "reversing" ||
      command.reversal.derivations.length === 0 ||
      !exactReversal(closingJournal.journal, command.reversal.journal)
    ) {
      return rejectEvaluation(
        state,
        command,
        [diagnostic("invalid_correction_topology", "command.reversal", "Close reversal must exactly negate the retained closing journal with lineage", ["ACC-004", "ACC-017", "ACC-032"])],
        true,
      );
    }
    sequence += 1n;
    const booked = prepareBookJournal(state, command, command.reversal, closingJournal.fiscalPeriodId, nextRevision, sequence, true);
    if (!("journal" in booked)) return rejectEvaluation(state, command, booked, true);
    effects.push(
      { type: "journal", booked },
      {
        type: "correction",
        link: Object.freeze({
          kind: "reversal",
          originalJournalId: closingJournal.journal.id,
          correctionJournalId: booked.journal.id,
        }),
      },
    );
  }
  const transitionHash = hashCanonical({ type: "PeriodTransition", periodId: period.id, kind: "reopen", reason: command.reason, revision: nextRevision, recordedAt: command.issuedAt, supersededCloseIds: [...supersededCloseIds].sort() });
  const transition: PeriodTransition = Object.freeze({ periodId: period.id, kind: "reopen", reason: command.reason, bookRevision: nextRevision, recordedAt: command.issuedAt, supersededCloseIds: Object.freeze(supersededCloseIds), contentHash: transitionHash });
  effects.push({ type: "periodTransition", transition });
  return prepareBookIntent(state, command, effects, sequence);
}

/** Complete current inputs for prospective configuration evolution. The maximum
 * journal date includes every canonical journal, including corrected ones.
 * Null means the authenticated journal population is empty, never unknown. */
export interface BookConfigurationChangeContext extends Pick<
  BookState,
  | "identity"
  | "bookRevision"
  | "latestPostingSequence"
  | "configurationRevision"
  | "configurationHash"
  | "activeConfigurationSnapshot"
> {
  readonly latestAccountingDate: LocalDate | null;
}
/** Shared configuration admission and exact intent construction. Common protocol,
 * current-state integrity, global admission and atomic storage remain caller duties. */
export function prepareBookConfigurationChange(
  state: BookConfigurationChangeContext,
  command: BookCommand & ReplaceConfigurationCommand,
): Evaluation {
  if (
    state.latestAccountingDate !== null &&
    (typeof state.latestAccountingDate !== "string" ||
      localDate(state.latestAccountingDate) !== state.latestAccountingDate)
  )
    throw new TypeError("Incomplete latest accounting date evidence");

  if (command.expectedConfigurationRevision !== state.configurationRevision) {
    return rejectEvaluation(
      state,
      command,
      [
        diagnostic(
          "stale_book_revision",
          "command.expectedConfigurationRevision",
          "Configuration command was evaluated against a stale configuration revision",
          ["ACC-047.2", "ACC-047.3"],
        ),
      ],
      true,
    );
  }
  const requestedProfile =
    command.executionProfileAdoption?.to ?? state.activeConfigurationSnapshot.executionProfile;
  if (
    !configurationProfileTransitionIsValid(
      state.activeConfigurationSnapshot,
      requestedProfile,
      command.executionProfileAdoption,
    )
  ) {
    return rejectEvaluation(
      state,
      command,
      [
        diagnostic(
          "unresolved_accounting_input",
          "command.executionProfileAdoption",
          "Execution profile adoption requires the supported forward transition, exact previous configuration hash, reason and bounded distinct evidence",
          ["ACC-014", "ACC-031", "ACC-038", "ACC-047.2"],
        ),
      ],
      true,
    );
  }
  const nextExecutionProfile =
    command.executionProfileAdoption === undefined
      ? state.activeConfigurationSnapshot.executionProfile
      : STRUCTURAL_SOURCE_IDENTITY_PROFILE;
  const latestAccountingDate = state.latestAccountingDate;
  if (latestAccountingDate !== null && command.effectiveOn <= latestAccountingDate) {
    return rejectEvaluation(
      state,
      command,
      [
        diagnostic(
          "fiscal_period_admission",
          "command.effectiveOn",
          "Configuration evolution must be prospective relative to canonical journals",
          ["ACC-013", "ACC-014", "ACC-029", "ACC-031"],
        ),
      ],
      true,
    );
  }
  const admissionSnapshot = immutableAdmissionSnapshot(command.admissionSnapshot);
  const policies = Object.freeze(command.policies.map(immutablePolicy));
  const quantizationPolicies = Object.freeze(
    command.quantizationPolicies.map((policy) => Object.freeze({ ...policy })),
  );
  const accountingPolicySnapshot = createAccountingPolicySnapshot(command.accountingPolicies);
  const configuredPeriods = Object.freeze(
    command.periods.map((period) => Object.freeze({ ...period })),
  );
  const candidate: BookConfigurationReadContext = Object.freeze({
    ...state,
    periods: configuredPeriods,
    admissionSnapshot,
    policies,
    quantizationPolicies,
    accountingPolicySnapshot,
  });
  const diagnostics = validateBookConfiguration(candidate);
  if (diagnostics.length > 0) return rejectEvaluation(state, command, diagnostics, true);
  const resultingConfigurationSnapshot = createBookConfigurationSnapshot(
    state.configurationRevision + 1n,
    command.issuedAt,
    configuredPeriods,
    admissionSnapshot,
    policies,
    quantizationPolicies,
    accountingPolicySnapshot,
    nextExecutionProfile,
    state.activeConfigurationSnapshot.stateCommitmentProfile,
  );
  const contentHash = resultingConfigurationSnapshot.contentHash;
  return prepareBookIntent(
    state,
    command,
    [
      {
        type: "configuration",
        expectedConfigurationRevision: state.configurationRevision,
        nextConfigurationRevision: state.configurationRevision + 1n,
        previousConfigurationHash: state.configurationHash,
        effectiveOn: command.effectiveOn,
        periods: configuredPeriods,
        admissionSnapshot,
        policies,
        quantizationPolicies,
        accountingPolicySnapshot,
        previousConfigurationSnapshot: state.activeConfigurationSnapshot,
        resultingConfigurationSnapshot,
        contentHash,
      },
    ],
    state.latestPostingSequence,
  );
}

export interface BookCorrectionContext
  extends BookJournalReadContext,
    Pick<BookState, "bookRevision" | "latestPostingSequence"> {
  readonly originalJournal: BookedJournal | null;
  readonly alreadyCorrected: boolean;
  readonly currencySource: boolean;
}
function isCurrencyJournal(state: CurrencyAccountingState, journalId: string): boolean {
  return state.remeasurementResults.some(result => `${result.id}-journal` === journalId) ||
    state.remeasurementReversals.some(reversal => `${reversal.id}-journal` === journalId);
}
/** Original journal, correction identity and period state are complete observations
 * from the same transaction. Lot and inventory ownership admission are separate. */
export function prepareBookCorrection(
  state: BookCorrectionContext,
  command: BookCommand & CorrectJournalCommand,
):
  | { readonly booked: BookedJournal; readonly link: CorrectionLink }
  | readonly SemanticDiagnostic[] {
  if (
    typeof state.alreadyCorrected !== "boolean" || typeof state.currencySource !== "boolean" ||
    state.originalJournal === undefined ||
    (state.originalJournal !== null &&
      state.originalJournal.journal.id !== command.originalJournalId)
  )
    throw new TypeError("Incomplete original journal correction evidence");

  const original = state.originalJournal;
  if (state.currencySource) return Object.freeze([diagnostic("invalid_correction_topology", "command.originalJournalId",
    "Currency journals must use the linked remeasurement lifecycle; a generic correction would leave result and reversal state unchanged",
    ["ACC-004", "ACC-043.5", "ACC-047.2"])]);
  if (
    original === null ||
    original.journal.bookId !== state.identity.bookId ||
    state.alreadyCorrected ||
    command.resolved.derivations.length === 0
  ) {
    return Object.freeze([
      diagnostic(
        "invalid_correction_topology",
        "command.originalJournalId",
        "Correction must resolve one same-book, not-yet-corrected journal and retain lineage",
        ["ACC-004", "ACC-017", "ACC-026"],
      ),
    ]);
  }
  const status = state.periodStatus(original.fiscalPeriodId);
  if (status !== "open" && status !== "closed")
    throw new TypeError("Incomplete period closure evidence");
  if (status === "closed") {
    return Object.freeze([
      diagnostic(
        "fiscal_period_admission",
        "command.originalJournalId",
        "A journal in a closed population cannot be corrected until its period is explicitly reopened",
        ["ACC-004", "ACC-029", "ACC-032"],
      ),
    ]);
  }
  if (
    command.correctionKind === "reversal" &&
    !exactReversal(original.journal, command.resolved.journal)
  ) {
    return Object.freeze([
      diagnostic(
        "invalid_correction_topology",
        "command.resolved",
        "A reversal must exactly negate units, book values, prices, basis, dimensions, and accounts",
        ["ACC-004"],
      ),
    ]);
  }
  if (
    (command.correctionKind === "reversal" && command.resolved.journal.kind !== "reversing") ||
    (command.correctionKind === "supersession" &&
      command.resolved.journal.kind !== "ordinary" &&
      command.resolved.journal.kind !== "adjustment")
  ) {
    return Object.freeze([
      diagnostic(
        "invalid_correction_topology",
        "command.resolved.journal.kind",
        "Correction kind and journal kind do not agree",
        ["ACC-004", "ACC-018"],
      ),
    ]);
  }
  const sequence = state.latestPostingSequence + 1n;
  const booked = prepareBookJournal(
    state,
    command,
    command.resolved,
    command.fiscalPeriodId,
    state.bookRevision + 1n,
    sequence,
    false,
  );
  if (!("journal" in booked)) return booked;
  const link: CorrectionLink = Object.freeze({
    kind: command.correctionKind,
    originalJournalId: command.originalJournalId,
    correctionJournalId: command.resolved.journal.id,
  });

  return Object.freeze({ booked, link });
}

function applyEffects(
  state: BookState,
  intent: Pick<BookCommitIntent, "effects" | "nextBookRevision" | "resultingPostingSequence">,
  revision: RevisionRecord,
  configurationVerified = false,
): BookState {
  let inventoryOwnershipEffects = state.inventoryOwnershipEffects;
  let status = state.status;
  let openingBoundary = state.openingBoundary;
  let periods = state.periods;
  let admissionSnapshot = state.admissionSnapshot;
  let policies = state.policies;
  let quantizationPolicies = state.quantizationPolicies;
  let accountingPolicySnapshot = state.accountingPolicySnapshot;
  let accountingState = state.accountingState;
  let configurationRevision = state.configurationRevision;
  let configurationHash = state.configurationHash;
  let configurationSnapshots = state.configurationSnapshots;
  let activeConfigurationSnapshot = state.activeConfigurationSnapshot;
  let lots = state.lots;
  let lotHoldings = state.lotHoldings;
  let lotAllocations = state.lotAllocations;
  const journals: BookedJournal[] = [];
  const corrections: CorrectionLink[] = [];
  const transitions: PeriodTransition[] = [];
  const closes: ClosePackage[] = [];
  for (const effect of intent.effects) {
    switch (effect.type) {
      case "activation": openingBoundary = effect.boundary; status = "open"; break;
      case "configuration":
        periods = effect.periods;
        admissionSnapshot = effect.admissionSnapshot;
        policies = effect.policies;
        quantizationPolicies = effect.quantizationPolicies;
        accountingPolicySnapshot = effect.accountingPolicySnapshot;
        configurationRevision = effect.nextConfigurationRevision;
        configurationHash = effect.contentHash;
        configurationSnapshots = Object.freeze([...configurationSnapshots, effect.resultingConfigurationSnapshot]);
        activeConfigurationSnapshot = effect.resultingConfigurationSnapshot;
        // The kernel rebuilt this effect from the command and froze it; vouch for the snapshot only once its hash is recomputed.
        if (configurationVerified || contentHashEquals(hashBookConfigurationSnapshot(activeConfigurationSnapshot), activeConfigurationSnapshot.contentHash)) markVerifiedSnapshot(activeConfigurationSnapshot);
        break;
      case "journal": journals.push(effect.booked); break;
      case "inventoryOwnership": inventoryOwnershipEffects = Object.freeze([...(inventoryOwnershipEffects ?? []), effect.value]); break;
      case "lotChanges": {
        const changed = applyLotChanges(lots, lotHoldings, effect.changes);
        lots = changed.lots;
        lotHoldings = changed.holdings;
        break;
      }
      case "lotState":
        lots = effect.lotState.lots;
        lotHoldings = effect.lotState.holdings;
        lotAllocations = effect.lotState.allocations;
        break;
      case "correction": corrections.push(effect.link); break;
      case "closePackage": closes.push(effect.closePackage); break;
      case "periodTransition":
        transitions.push(effect.transition);
        break;
      case "provisionalInventoryLayer":
      case "inventoryRecosting":
      case "inventoryValueAdjustment":
      case "openItem":
      case "settlement":
      case "settlementAllocation":
      case "remeasurementResult":
      case "remeasurementReversal":
      case "allocationSchedule":
      case "allocationRecognition":
      case "allocationScheduleRevision":
      case "taxDetermination":
      case "consolidationCompilation": accountingState = applyAccountingEffect(accountingState, effect); break;
    }
  }
  // The next state, in the property order of the one before it. Its journals and revisions are not
  // copied and frozen here: they are views over the same append-only history (see book-history.ts)
  // and become frozen arrays when somebody reads them. The small lists that rarely change are
  // reused when they do not.
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(state)) {
    if (key !== "contentHash") next[key] = key === "journals" || key === "revisions" ? undefined : (state as unknown as Record<string, unknown>)[key];
  }
  if (inventoryOwnershipEffects !== undefined) next.inventoryOwnershipEffects = inventoryOwnershipEffects;
  next.status = status;
  next.bookRevision = intent.nextBookRevision;
  next.latestPostingSequence = intent.resultingPostingSequence;
  next.configurationRevision = configurationRevision;
  next.configurationHash = configurationHash;
  next.configurationSnapshots = configurationSnapshots;
  next.activeConfigurationSnapshot = activeConfigurationSnapshot;
  if (openingBoundary !== undefined) next.openingBoundary = openingBoundary;
  next.periods = periods;
  next.admissionSnapshot = admissionSnapshot;
  next.policies = policies;
  next.quantizationPolicies = quantizationPolicies;
  next.accountingPolicySnapshot = accountingPolicySnapshot;
  next.accountingState = accountingState;
  next.lots = lots;
  next.lotHoldings = lotHoldings;
  next.lotAllocations = lotAllocations;
  next.corrections = appendFrozen(state.corrections, corrections);
  next.periodTransitions = appendFrozen(state.periodTransitions, transitions);
  next.closePackages = appendFrozen(state.closePackages, closes);
  adoptLists(next, journalLogOf(state).append(journals), revisionLogOf(state).append([revision]));
  next.contentHash = hashBookState(next as unknown as HashableBookState);
  return Object.freeze(next) as unknown as BookState;
}

function validateIntentEffects(intent: BookCommitIntent): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  for (const [index, effect] of intent.effects.entries()) {
    if (effect.type === "journal") {
      const expectedJournalHash = hashCanonical(canonicalJournalValue(effect.booked.journal));
      if (
        !contentHashEquals(expectedJournalHash, effect.booked.canonicalHash) ||
        effect.booked.commandId !== intent.command.id ||
        effect.booked.bookRevision !== intent.nextBookRevision
      ) {
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}]`, "Journal effect identity or complete canonical hash is invalid", ["ACC-021", "ACC-031", "ACC-038"]));
      }
    } else if (effect.type === "inventoryOwnership") {
      if (effect.value.bookRevision !== intent.nextBookRevision || effect.value.effectKey !== `${intent.command.id}:ownership:0` || !validateInventoryOwnershipArtifact("ownershipEffect", effect.value)) {
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}].inventoryOwnership`, "Ownership effect origin, intrinsic structure or full content hash is invalid", ["ACC-039.7", "ACC-039.8", "ACC-039.9"]));
      }
    } else if (effect.type === "lotChanges") {
      if (!contentHashEquals(hashLotChanges(effect.changes.lots, effect.changes.holdings), effect.changes.contentHash))
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}].lotChanges`, "Lot changes content hash is invalid", ["ACC-009", "ACC-021", "ACC-031", "ACC-038"]));
    } else if (effect.type === "lotState") {
      const expected = hashLotState(effect.lotState.lots, effect.lotState.holdings, effect.lotState.allocations);
      if (!contentHashEquals(expected, effect.lotState.contentHash)) {
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}].lotState`, "Lot state complete content hash is invalid", ["ACC-009", "ACC-021", "ACC-031", "ACC-038"]));
      }
    } else if (effect.type === "activation") {
      const expected = hashCanonical({
        type: "OpeningBoundary",
        id: effect.boundary.id,
        firstAccountingDate: effect.boundary.firstAccountingDate,
        activatedAt: effect.boundary.activatedAt,
        openingJournalId: effect.boundary.openingJournalId ?? null,
        configurationSnapshotHash: hashValue(effect.boundary.configurationSnapshot.contentHash),
      });
      if (!contentHashEquals(expected, effect.boundary.contentHash) || !contentHashEquals(effect.configurationHash, effect.configurationSnapshot.contentHash) || !contentHashEquals(effect.boundary.configurationSnapshot.contentHash, effect.configurationSnapshot.contentHash) || !contentHashEquals(hashBookConfigurationSnapshot(effect.configurationSnapshot), effect.configurationSnapshot.contentHash)) {
        diagnostics.push(diagnostic("canonical_identity_conflict", `intent.effects[${index}].boundary.contentHash`, "Opening boundary content hash is invalid", ["ACC-028", "ACC-038"]));
      }
    } else if (effect.type === "configuration") {
      const expected = hashBookConfigurationSnapshot(effect.resultingConfigurationSnapshot);
      if (!contentHashEquals(expected, effect.contentHash) || !contentHashEquals(effect.previousConfigurationHash, effect.previousConfigurationSnapshot.contentHash) || effect.resultingConfigurationSnapshot.revision !== effect.nextConfigurationRevision || effect.previousConfigurationSnapshot.revision !== effect.expectedConfigurationRevision || effect.expectedConfigurationRevision !== intent.expectedConfigurationRevision || effect.nextConfigurationRevision !== intent.nextConfigurationRevision || !contentHashEquals(effect.accountingPolicySnapshot.contentHash, createAccountingPolicySnapshot(effect.accountingPolicySnapshot.policies).contentHash)) {
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}].configuration`, "Configuration effect complete content hash is invalid", ["ACC-014", "ACC-031", "ACC-038"]));
      }
    } else if (effect.type === "periodTransition") {
      const expected = hashCanonical({
        type: "PeriodTransition",
        periodId: effect.transition.periodId,
        kind: effect.transition.kind,
        reason: effect.transition.reason,
        revision: effect.transition.bookRevision,
        recordedAt: effect.transition.recordedAt,
        ...(effect.transition.kind === "reopen"
          ? { supersededCloseIds: [...effect.transition.supersededCloseIds].sort() }
          : {}),
      });
      if (!contentHashEquals(expected, effect.transition.contentHash) || effect.transition.bookRevision !== intent.nextBookRevision) {
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}].transition`, "Period transition content hash or revision is invalid", ["ACC-031", "ACC-032", "ACC-038"]));
      }
    } else if (effect.type === "closePackage") {
      const item = effect.closePackage;
      const expected = hashCanonical({
        type: "ClosePackage",
        id: item.id,
        periodId: item.periodId,
        cycle: item.cycle,
        throughBookRevision: item.throughBookRevision,
        throughPostingSequence: item.throughPostingSequence,
        ledgerHash: hashValue(item.ledgerHash),
        chartHash: hashValue(item.chartHash),
        policyHash: hashValue(item.bookingPolicySnapshotHash),
        quantizationPolicyHash: hashValue(item.quantizationPolicySnapshotHash),
        reportPopulationHash: hashValue(item.reportPopulationHash),
        reportingPolicySnapshotHash: hashValue(item.reportingPolicySnapshotHash),
        configurationRevision: item.configurationRevision,
        configurationSnapshotHash: hashValue(item.configurationSnapshotHash),
        configurationSnapshotContentHash: hashValue(item.configurationSnapshot.contentHash),
        bookStateSnapshotHash: hashValue(item.bookStateSnapshotHash),
        closingJournalId: item.closingJournalId ?? null,
      });
      if (!contentHashEquals(expected, item.contentHash) || item.throughBookRevision !== intent.nextBookRevision || !contentHashEquals(item.configurationSnapshotHash, item.configurationSnapshot.contentHash) || !contentHashEquals(hashBookConfigurationSnapshot(item.configurationSnapshot), item.configurationSnapshot.contentHash)) {
        diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}].closePackage`, "Close package complete content hash or revision is invalid", ["ACC-031", "ACC-032", "ACC-038"]));
      }
    } else if (isAccountingEffect(effect) && validateAccountingEffectHash(effect) === false) {
      diagnostics.push(diagnostic("ordered_history_violation", `intent.effects[${index}]`, "Accounting effect complete content hash is invalid", ["ACC-047.4", "ACC-047.6"]));
    }
  }
  return Object.freeze(diagnostics);
}

function latestBookAccountingDate(state: BookState): LocalDate | null {
  return [...state.journals.map(booked => booked.journal.accountingDate),
    ...ownedMovements(state).map(movement => movement.accountingDate),
    ...state.accountingState.settlementAllocations.flatMap(allocation => allocation.appliedAt === undefined ? [] : [allocation.appliedAt.slice(0, 10) as LocalDate])].sort().at(-1) ?? null;
}

export function validateBookEffectTopology(state: BookState, intent: BookCommitIntent): readonly SemanticDiagnostic[] {
  const ownershipDiagnostics = validateInventoryScopeChanges(state, intent.command, intent.effects);
  if (ownershipDiagnostics.length > 0) return ownershipDiagnostics;
  const command = intent.command;
  const hasLots = "lotOperations" in command && (command.lotOperations?.length ?? 0) > 0;
  const expectedTypes = (() => {
    switch (command.type) {
      case "activateBook": return ["activation", ...(command.opening === undefined ? [] : ["journal", ...(hasLots ? ["lotState"] : [])])];
      case "postJournal": return ["journal", ...(hasLots ? ["lotState"] : [])];
      case "correctJournal": return ["journal", "correction", ...(hasLots ? ["lotState"] : [])];
      case "closePeriod": return [...(command.closing === undefined ? [] : ["journal"]), "closePackage", "periodTransition"];
      case "reopenPeriod": return [...(command.reversal === undefined ? [] : ["journal", "correction"]), "periodTransition"];
      case "replaceConfiguration": return ["configuration"];
      case "postInventoryTransaction": return ["journal", ...(command.provisionalLayerId === undefined ? [] : ["provisionalInventoryLayer"]), ...(hasLots ? ["lotState"] : [])];
      case "postOwnedInventoryTransaction": return [...command.request.resolvedJournals.map(() => "journal"), "inventoryOwnership", command.request.algorithmVersion === "1.2.0" ? "lotChanges" : "lotState"];
      case "recostProvisionalInventory": {
        const effect = intent.effects.find((item) => item.type === "inventoryRecosting");
        return [...(effect?.type === "inventoryRecosting" && !effect.value.adjustment.isZero() ? ["journal"] : []), "inventoryRecosting"];
      }
      case "adjustInventoryValue": return ["journal", "inventoryValueAdjustment", "lotState"];
      case "recognizeOpenItem": return ["journal", "openItem"];
      case "applySettlement": return [...command.resolved.map(() => "journal"), ...(intent.effects.filter(isJournalEffect).length > command.resolved.length ? ["journal"] : []), ...(command.request.operation === "allocateExisting" ? [] : ["settlement"]), ...command.request.allocations.map(() => "settlementAllocation")];
      case "postCurrencyRemeasurement": return ["journal", command.request.reversalOf === undefined ? "remeasurementResult" : "remeasurementReversal"];
      case "createAllocationSchedule": return ["allocationSchedule"];
      case "recognizeScheduledAllocation": return ["journal", "allocationRecognition"];
      case "reviseAllocationSchedule": {
        const revision = intent.effects.find((effect) => effect.type === "allocationScheduleRevision");
        const hasAdjustment = revision?.type === "allocationScheduleRevision" && revision.value.exactAdjustmentAmount !== undefined;
        const hasSuccessor = revision?.type === "allocationScheduleRevision" && revision.value.successorScheduleId !== undefined;
        return [...(hasAdjustment ? ["journal"] : []), "allocationScheduleRevision", ...(hasSuccessor ? ["allocationSchedule"] : []), ...(command.disposalJournal === undefined ? [] : ["journal"])];
      }
      case "postTaxedTransaction": return ["journal", "taxDetermination"];
      case "compileConsolidation": return ["journal", "consolidationCompilation"];
    }
  })();
  let valid = intent.effects.map((effect) => effect.type).join("\u0000") === expectedTypes.join("\u0000");
  const journalEffect = intent.effects.find(isJournalEffect);
  const journalEffects = intent.effects.filter(isJournalEffect);
  valid = valid && journalEffects.every((effect, index) => effect.booked.effectKey === `${command.id}:journal:${index}`);
  const commandJournal: ResolvedTransaction | undefined = (() => {
    switch (command.type) {
      case "activateBook": return command.opening;
      case "postJournal":
      case "correctJournal": return command.resolved;
      case "closePeriod": return command.closing;
      case "reopenPeriod": return command.reversal;
      default: return undefined;
    }
  })();
  if (commandJournal !== undefined && journalEffect !== undefined) {
    valid = valid &&
      journalEffect.booked.journal.id === commandJournal.journal.id &&
      journalEffect.booked.effectKey === `${command.id}:journal:0` &&
      contentHashEquals(journalEffect.booked.canonicalHash, hashCanonical(canonicalJournalValue(commandJournal.journal)));
  }
  if (hasLots && journalEffect !== undefined) {
    const expected = prepareLotState(state, journalEffect.booked.journal, command.lotOperations);
    const effect = intent.effects.find((candidate) => candidate.type === "lotState");
    valid = valid && !Array.isArray(expected) && expected !== undefined && effect?.type === "lotState" &&
      contentHashEquals((expected as LotStateEffect).contentHash, effect.lotState.contentHash);
  }
  switch (command.type) {
    case "postOwnedInventoryTransaction": {
      const expected = prepareOwnedInventoryCommandEffects(state, command);
      valid = valid && "effects" in expected && expected.sequence === intent.resultingPostingSequence &&
        contentHashEquals(hashCanonical(expected.effects.map(canonicalBookEffectValue)), hashCanonical(intent.effects.map(canonicalBookEffectValue)));
      break;
    }
    case "activateBook": {
      const effect = intent.effects[0];
      valid = valid && effect?.type === "activation" &&
        effect.boundary.id === command.boundaryId &&
        effect.boundary.firstAccountingDate === command.firstAccountingDate &&
        effect.boundary.activatedAt === command.issuedAt &&
        effect.boundary.openingJournalId === command.opening?.journal.id &&
        contentHashEquals(effect.configurationSnapshot.contentHash, state.activeConfigurationSnapshot.contentHash);
      break;
    }
    case "correctJournal": {
      const effect = intent.effects.find((candidate) => candidate.type === "correction");
      valid = valid && !isCurrencyJournal(state.accountingState, command.originalJournalId) && effect?.type === "correction" &&
        effect.link.kind === command.correctionKind &&
        effect.link.originalJournalId === command.originalJournalId &&
        effect.link.correctionJournalId === command.resolved.journal.id;
      break;
    }
    case "closePeriod": {
      const close = intent.effects.find((effect) => effect.type === "closePackage");
      const transition = intent.effects.find((effect) => effect.type === "periodTransition");
      valid = valid && close?.type === "closePackage" && transition?.type === "periodTransition" &&
        close.closePackage.id === command.closePackageId && close.closePackage.periodId === command.periodId &&
        close.closePackage.throughBookRevision === intent.nextBookRevision &&
        close.closePackage.throughPostingSequence === intent.resultingPostingSequence &&
        close.closePackage.closingJournalId === command.closing?.journal.id &&
        contentHashEquals(close.closePackage.reportPopulationHash, command.reportPopulationHash) &&
        contentHashEquals(close.closePackage.reportingPolicySnapshotHash, command.reportingPolicySnapshotHash) &&
        close.closePackage.configurationRevision === state.configurationRevision &&
        contentHashEquals(close.closePackage.configurationSnapshotHash, state.configurationHash) &&
        contentHashEquals(close.closePackage.configurationSnapshot.contentHash, state.activeConfigurationSnapshot.contentHash) &&
        contentHashEquals(close.closePackage.bookStateSnapshotHash, state.revisions.find((revision) => revision.bookRevision === command.expectedBookRevision)?.chainHash ?? state.contentHash) &&
        transition.transition.kind === "close" && transition.transition.periodId === command.periodId &&
        transition.transition.reason === command.reason && transition.transition.recordedAt === command.issuedAt;
      break;
    }
    case "reopenPeriod": {
      const prepared = prepareFullBookReopen(state, command);
      valid = valid && prepared.disposition === "ready" &&
        contentHashEquals(hashCanonical(prepared.intent.effects.map(canonicalBookEffectValue)), hashCanonical(intent.effects.map(canonicalBookEffectValue)));
      break;
    }
    case "replaceConfiguration": {
      const effect = intent.effects[0];
      const latestDate = latestBookAccountingDate(state);
      valid = valid && effect?.type === "configuration" && effect.effectiveOn === command.effectiveOn &&
        (latestDate === null || command.effectiveOn > latestDate) &&
        effect.expectedConfigurationRevision === state.configurationRevision && effect.nextConfigurationRevision === state.configurationRevision + 1n &&
        contentHashEquals(effect.previousConfigurationHash, state.configurationHash) &&
        effect.resultingConfigurationSnapshot.effectiveAt === command.issuedAt &&
        configurationProfileTransitionIsValid(state.activeConfigurationSnapshot, effect.resultingConfigurationSnapshot.executionProfile, command.executionProfileAdoption) &&
        effect.resultingConfigurationSnapshot.stateCommitmentProfile === state.activeConfigurationSnapshot.stateCommitmentProfile &&
        contentHashEquals(effect.previousConfigurationSnapshot.contentHash, state.activeConfigurationSnapshot.contentHash) &&
        contentHashEquals(effect.contentHash, hashBookConfigurationSnapshot(effect.resultingConfigurationSnapshot));
      break;
    }
    case "recognizeOpenItem": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "openItem" }> => candidate.type === "openItem");
      valid = valid && journalEffect?.booked.journal.id === command.resolved.journal.id && effect?.value.id === command.request.value.id;
      break;
    }
    case "applySettlement": {
      const settlement = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "settlement" }> => candidate.type === "settlement");
      const allocations = intent.effects.filter((candidate): candidate is Extract<BookEffect, { readonly type: "settlementAllocation" }> => candidate.type === "settlementAllocation");
      valid = valid && journalEffects.length >= command.resolved.length && journalEffects.slice(0, command.resolved.length).every((effect, index) => effect.booked.journal.id === command.resolved[index]?.journal.id) &&
        (command.request.operation === "allocateExisting" ? settlement === undefined : settlement?.value.id === command.request.settlement.id) && allocations.length === command.request.allocations.length &&
        allocations.every((effect, index) => effect.value.id === command.request.allocations[index]?.id && effect.value.settlementId === command.request.settlement.id);
      if (valid) {
        const expected = prepareBookSettlement({ ...journalReadContext(state), ...settlementSourceContext(state), bookRevision: state.bookRevision,
          latestPostingSequence: state.latestPostingSequence, accountingPolicySnapshot: state.accountingPolicySnapshot }, command);
        valid = "effects" in expected && contentHashEquals(hashCanonical(expected.effects.map(canonicalBookEffectValue)), hashCanonical(intent.effects.map(canonicalBookEffectValue)));
      }
      break;
    }
    case "postInventoryTransaction": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "provisionalInventoryLayer" }> => candidate.type === "provisionalInventoryLayer");
      valid = valid && (command.provisionalLayerId === undefined ? effect === undefined : effect?.value.id === command.provisionalLayerId);
      const cost = calculateInventoryCost(state.accountingPolicySnapshot.policies, state.identity.bookId, command.request);
      if (cost.disposition === "rejected" || cost.allocations.some((allocation) => !state.lotHoldings.some((holding) => holding.id === allocation.layerId && !holding.remainingQuantity.isZero()))) valid = false;
      else {
        const resolved = resolvePreparedJournal(state, inventoryCostJournalDraft(state, command, cost), `${command.id}:journal:0`, command.generatedPostingDimensionSelections ?? []);
        valid = valid && !Array.isArray(resolved) && journalEffect !== undefined &&
          contentHashEquals(hashCanonical(canonicalJournalValue((resolved as ResolvedTransaction).journal)), journalEffect.booked.canonicalHash) &&
          contentHashEquals((resolved as ResolvedTransaction).quantizationPolicySnapshotHash, journalEffect.booked.quantizationPolicySnapshotHash);
      }
      break;
    }
    case "recostProvisionalInventory": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "inventoryRecosting" }> => candidate.type === "inventoryRecosting");
      valid = valid && effect?.value.id === command.request.id && effect.value.layerId === command.request.layerId;
      break;
    }
    case "adjustInventoryValue": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "inventoryValueAdjustment" }> => candidate.type === "inventoryValueAdjustment");
      const lotEffect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "lotState" }> => candidate.type === "lotState");
      const expectedHoldings = effect === undefined ? undefined : applyInventoryValueAdjustmentToHoldings(state.lotHoldings, effect.value.allocations);
      valid = valid && journalEffect?.booked.journal.id === `${command.request.id}-journal` && effect?.value.id === command.request.id &&
        effect.value.generatedEffectKey === journalEffect?.booked.effectKey && lotEffect !== undefined && expectedHoldings !== undefined &&
        contentHashEquals(lotEffect.lotState.contentHash, hashLotState(state.lots, expectedHoldings, state.lotAllocations));
      break;
    }
    case "postCurrencyRemeasurement": {
      const result = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "remeasurementResult" }> => candidate.type === "remeasurementResult");
      const reversal = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "remeasurementReversal" }> => candidate.type === "remeasurementReversal");
      valid = valid && journalEffect?.booked.journal.id === `${command.request.reversalOf === undefined ? command.request.id : command.request.reversalId}-journal` &&
        (command.request.reversalOf === undefined ? result?.value.id === command.request.id && result.value.adjustmentEffectKey === journalEffect?.booked.effectKey : reversal !== undefined && reversal.value.id === command.request.reversalId && reversal.value.originalResultId === command.request.reversalOf);
      break;
    }
    case "createAllocationSchedule": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "allocationSchedule" }> => candidate.type === "allocationSchedule");
      valid = valid && effect?.value.id === command.request.id && effect.value.policyId === command.request.policyId;
      break;
    }
    case "recognizeScheduledAllocation": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "allocationRecognition" }> => candidate.type === "allocationRecognition");
      valid = valid && journalEffect?.booked.journal.id === `${command.request.id}-journal` && effect?.value.id === command.request.id && effect.value.scheduleId === command.request.scheduleId && effect.value.ordinal === command.request.ordinal;
      break;
    }
    case "reviseAllocationSchedule": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "allocationScheduleRevision" }> => candidate.type === "allocationScheduleRevision");
      const successor = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "allocationSchedule" }> => candidate.type === "allocationSchedule");
      valid = valid && effect?.value.id === command.request.id && effect.value.originalScheduleId === command.request.originalScheduleId &&
        (effect.value.successorScheduleId === undefined ? successor === undefined : successor?.value.id === effect.value.successorScheduleId) &&
        (effect.value.exactAdjustmentAmount === undefined ? journalEffects.length === (command.disposalJournal === undefined ? 0 : 1) : journalEffect?.booked.journal.id === `${command.request.id}-journal` && effect.value.generatedEffectKey === journalEffect.booked.effectKey);
      if (command.disposalJournal !== undefined) {
        valid = valid && command.request.kind === "disposal" && journalEffects.length === (effect?.value.exactAdjustmentAmount === undefined ? 1 : 2) &&
          contentHashEquals(journalEffects.at(-1)!.booked.canonicalHash, hashCanonical(canonicalJournalValue(command.disposalJournal.journal)));
      }
      break;
    }
    case "postTaxedTransaction": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "taxDetermination" }> => candidate.type === "taxDetermination");
      valid = valid && journalEffect?.booked.journal.id === command.request.sourceTransactionId && effect?.value.id === command.request.id && effect.value.sourceTransactionId === command.request.sourceTransactionId;
      break;
    }
    case "compileConsolidation": {
      const effect = intent.effects.find((candidate): candidate is Extract<BookEffect, { readonly type: "consolidationCompilation" }> => candidate.type === "consolidationCompilation");
      valid = valid && journalEffect?.booked.journal.id === `${command.request.id}-journal` && effect?.value.id === command.request.id && effect.value.policyId === command.request.policyId;
      break;
    }
    case "postJournal": break;
  }
  return valid
    ? Object.freeze([])
    : Object.freeze([diagnostic("ordered_history_violation", "intent.effects", "Revision effects do not match the command's canonical effect topology", ["ACC-004", "ACC-021", "ACC-031", "ACC-032", "ACC-038"])]);
}

export function validateBookState(state: BookState): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [...validateBookProfileSelection(state), ...validateRetainedConfigurationSnapshots(state)];
  if (!contentHashEquals(hashFinancialIdentity(state.identity), state.financialIdentityHash)) {
    diagnostics.push(diagnostic("immutable_book_identity", "state.financialIdentityHash", "Restored financial identity hash is invalid", ["ACC-027", "ACC-034", "ACC-038"]));
  }
  let previousHash: ContentHash | null = null;
  let expectedRevision = 1n;
  let restoredPostingSequence = 0n;
  let restoredConfigurationRevision = 0n;
  let restoredConfigurationSnapshot = state.configurationSnapshots[0] ?? state.activeConfigurationSnapshot;
  let restoredConfigurationHash = restoredConfigurationSnapshot.contentHash;
  let restoredConfigurationSnapshots: readonly BookConfigurationSnapshot[] = Object.freeze([restoredConfigurationSnapshot]);
  let previousCommittedAt: Instant | undefined;
  const revisionCommandIds = new Set<string>();
  diagnostics.push(...validateConfiguration(state));
  let restoredLots: readonly Lot[] = Object.freeze([]);
  let restoredHoldings: readonly LotHolding[] = Object.freeze([]);
  let restoredAllocations: readonly BookedLotAllocation[] = Object.freeze([]);
  // The journals restored so far are a view over one growing store (see book-history.ts), not a
  // frozen copy per journal; they become an array only for the checks that read them as one.
  let restoredJournals = journalLogOf({ journals: Object.freeze([]) });
  let restoredAccountingState = emptyAccountingCanonicalState();
  let restoredOwnership: readonly InventoryOwnershipEffect[] | undefined;
  const { inventoryOwnershipEffects: _futureOwnership, ...restorationBase } = state;
  const restoredAt = (fields: object): BookState => {
    const view = { ...fields };
    adoptJournals(view, restoredJournals);
    return Object.freeze(view) as unknown as BookState;
  };
  for (const [index, revision] of state.revisions.entries()) {
    const postingSequenceBeforeRevision = restoredPostingSequence;
    const expectedConfigurationRevision = restoredConfigurationRevision;
    const expectedConfigurationHash = restoredConfigurationHash;
    const effectsHash = hashCanonical({ type: "RevisionEffects", effects: revision.effects.map(canonicalBookEffectValue) });
    const chainHash = hashCanonical({
      type: "RevisionChain",
      bookId: state.identity.bookId,
      revision: revision.bookRevision,
      previousHash: previousHash === null ? null : hashValue(previousHash),
      effectsHash: hashValue(effectsHash),
    });
    if (
      revision.bookId !== state.identity.bookId ||
      revision.bookRevision !== expectedRevision ||
      revision.command.bookId !== state.identity.bookId ||
      revision.command.expectedBookRevision !== revision.bookRevision - 1n ||
      revision.command.protocolVersion !== BOOK_COMMAND_PROTOCOL_VERSION ||
      revision.command.committedAt !== revision.committedAt ||
      revisionCommandIds.has(revision.command.id) ||
      !Number.isFinite(Date.parse(revision.command.issuedAt)) ||
      !Number.isFinite(Date.parse(revision.command.completedAt)) ||
      !Number.isFinite(Date.parse(revision.command.committedAt)) ||
      !commandTimelineIsValid(revision.command.issuedAt, revision.command.completedAt, revision.command.committedAt, previousCommittedAt) ||
      !contentHashEquals(commandInputHash(revision.command), revision.command.inputHash) ||
      !contentHashEquals(revision.effectsHash, effectsHash) ||
      !contentHashEquals(revision.chainHash, chainHash) ||
      (previousHash === null ? revision.previousHash !== null : revision.previousHash === null || !contentHashEquals(previousHash, revision.previousHash))
    ) {
      diagnostics.push(diagnostic("ordered_history_violation", `state.revisions[${index}]`, "Restored revision chain is not complete, gap-free, and canonical", ["ACC-031", "ACC-034", "ACC-038"]));
    }
    const accountingStateBeforeRevision = restoredAccountingState;
    for (const effect of revision.effects) {
      if (effect.type === "journal") {
        restoredPostingSequence += 1n;
        restoredJournals = restoredJournals.append([effect.booked]);
        if (effect.booked.postingSequence !== restoredPostingSequence) {
          diagnostics.push(diagnostic("ordered_history_violation", `state.revisions[${index}].effects`, "Restored journal effects do not consume a gap-free global posting sequence", ["ACC-021", "ACC-031", "ACC-034"]));
        }
      }
      if (effect.type === "configuration") {
        if (effect.expectedConfigurationRevision !== expectedConfigurationRevision || effect.nextConfigurationRevision !== expectedConfigurationRevision + 1n || !contentHashEquals(effect.previousConfigurationHash, restoredConfigurationHash)) {
          diagnostics.push(diagnostic("ordered_history_violation", `state.revisions[${index}].effects`, "Configuration history is not gap-free or does not pin both sides of its transition", ["ACC-047.2", "ACC-047.3", "ACC-047.4"]));
        }
        restoredConfigurationRevision = effect.nextConfigurationRevision;
        restoredConfigurationHash = effect.contentHash;
        restoredConfigurationSnapshot = effect.resultingConfigurationSnapshot;
        restoredConfigurationSnapshots = Object.freeze([...restoredConfigurationSnapshots, effect.resultingConfigurationSnapshot]);
      }
      if (isAccountingEffect(effect)) {
        diagnostics.push(...validateAccountingEffectAdmission(restoredAccountingState, [effect], state.identity.bookId));
        restoredAccountingState = applyAccountingEffect(restoredAccountingState, effect);
      }
    }
    const syntheticIntent: BookCommitIntent = {
      command: revision.command,
      expectedBookRevision: revision.bookRevision - 1n,
      nextBookRevision: revision.bookRevision,
      resultingPostingSequence: restoredPostingSequence,
      expectedConfigurationRevision,
      nextConfigurationRevision: restoredConfigurationRevision,
      resultingConfigurationHash: restoredConfigurationHash,
      effects: revision.effects,
      canonicalHash: hashCanonical({ type: "restoration-validation-placeholder" }),
    };
    const restorationFields = {
      ...restorationBase,
      ...(restoredOwnership === undefined ? {} : { inventoryOwnershipEffects: restoredOwnership }),
      periods: restoredConfigurationSnapshot.periods,
      admissionSnapshot: restoredConfigurationSnapshot.admissionSnapshot,
      policies: restoredConfigurationSnapshot.policies,
      quantizationPolicies: restoredConfigurationSnapshot.quantizationPolicies,
      accountingPolicySnapshot: restoredConfigurationSnapshot.accountingPolicySnapshot,
      accountingState: restoredAccountingState,
      configurationRevision: expectedConfigurationRevision,
      configurationHash: expectedConfigurationHash,
      configurationSnapshots: restoredConfigurationSnapshots,
      activeConfigurationSnapshot: revision.effects.find((effect) => effect.type === "configuration")?.type === "configuration"
        ? (revision.effects.find((effect) => effect.type === "configuration") as Extract<BookEffect, { readonly type: "configuration" }>).previousConfigurationSnapshot
        : restoredConfigurationSnapshots.at(-1)!,
      lots: restoredLots,
      lotHoldings: restoredHoldings,
      lotAllocations: restoredAllocations,
    };
    const restorationState = restoredAt(restorationFields);
    const topologyState = revision.command.type === "reopenPeriod" || revision.command.type === "postOwnedInventoryTransaction" || revision.command.type === "applySettlement" ? {
      ...restorationFields, bookRevision: revision.bookRevision - 1n, latestPostingSequence: postingSequenceBeforeRevision,
      journals: restoredJournals.filter((booked) => booked.bookRevision < revision.bookRevision),
      revisions: state.revisions.slice(0, index),
      accountingState: accountingStateBeforeRevision,
      periodTransitions: state.periodTransitions.filter((transition) => transition.bookRevision < revision.bookRevision),
      closePackages: state.closePackages.filter((close) => close.throughBookRevision < revision.bookRevision),
    } : restorationState;
    diagnostics.push(...validateIntentEffects(syntheticIntent), ...validateBookEffectTopology(topologyState, syntheticIntent), ...validateAccountingSourceClosure(restoredAt({ ...restorationFields, accountingState: accountingStateBeforeRevision }), revision.effects, revision.command));
    for (const effect of revision.effects) if (effect.type === "inventoryOwnership") restoredOwnership = Object.freeze([...(restoredOwnership ?? []), effect.value]);
    const restoredLotEffect = revision.effects.find((effect) => effect.type === "lotState");
    if (restoredLotEffect?.type === "lotState") {
      restoredLots = restoredLotEffect.lotState.lots;
      restoredHoldings = restoredLotEffect.lotState.holdings;
      restoredAllocations = restoredLotEffect.lotState.allocations;
    }
    const restoredChanges = revision.effects.find((effect) => effect.type === "lotChanges");
    if (restoredChanges?.type === "lotChanges") {
      const changed = applyLotChanges(restoredLots, restoredHoldings, restoredChanges.changes);
      restoredLots = changed.lots;
      restoredHoldings = changed.holdings;
    }
    revisionCommandIds.add(revision.command.id);
    previousCommittedAt = revision.committedAt;
    previousHash = revision.chainHash;
    expectedRevision += 1n;
  }
  if ((state.inventoryOwnershipEffects === undefined) !== (restoredOwnership === undefined) ||
    !contentHashEquals(hashCanonical(canonicalAccountingValue(state.inventoryOwnershipEffects ?? null)), hashCanonical(canonicalAccountingValue(restoredOwnership ?? null)))) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.inventoryOwnershipEffects", "Ownership projection must exactly reproduce immutable revision effects without implicit legacy adoption", ["ACC-039.7", "ACC-039.9"]));
  }
  if (state.bookRevision !== BigInt(state.revisions.length) || state.latestPostingSequence !== BigInt(state.journals.length)) {
    diagnostics.push(diagnostic("ordered_history_violation", "state", "Restored book and posting sequences are not gap-free", ["ACC-031", "ACC-034"]));
  }
  if (state.configurationRevision !== restoredConfigurationRevision || !contentHashEquals(state.configurationHash, restoredConfigurationHash)) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.configurationRevision", "Restored configuration revision and hash do not match revision effects", ["ACC-047.2", "ACC-047.4"]));
  }
  if (!contentHashEquals(hashCanonical(canonicalAccountingStateValue(state.accountingState)), hashCanonical(canonicalAccountingStateValue(restoredAccountingState)))) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.accountingState", "Derived accounting lifecycle state does not reproduce immutable accounting effects", ["ACC-041.4", "ACC-044.5", "ACC-047.4", "ACC-047.6"]));
  }
  if (!contentHashEquals(hashBookState(state), state.contentHash)) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.contentHash", "Restored state complete content hash is invalid", ["ACC-031", "ACC-034", "ACC-038"]));
  }
  const effects = state.revisions.flatMap((revision) => revision.effects);
  const activationEffects = effects.filter((effect): effect is Extract<BookEffect, { readonly type: "activation" }> => effect.type === "activation");
  const configurationEffects = effects.filter((effect): effect is Extract<BookEffect, { readonly type: "configuration" }> => effect.type === "configuration");
  const journalEffects = effects.filter((effect): effect is Extract<BookEffect, { readonly type: "journal" }> => effect.type === "journal");
  const correctionEffects = effects.filter((effect): effect is Extract<BookEffect, { readonly type: "correction" }> => effect.type === "correction");
  const transitionEffects = effects.filter((effect): effect is Extract<BookEffect, { readonly type: "periodTransition" }> => effect.type === "periodTransition");
  const closeEffects = effects.filter((effect): effect is Extract<BookEffect, { readonly type: "closePackage" }> => effect.type === "closePackage");
  const materializedHash = (items: readonly BookEffect[]) => hashCanonical({ type: "MaterializedEffects", effects: items.map(canonicalBookEffectValue) });
  const stateJournalEffects: readonly BookEffect[] = state.journals.map((booked) => ({ type: "journal", booked }));
  const stateCorrectionEffects: readonly BookEffect[] = state.corrections.map((link) => ({ type: "correction", link }));
  const stateTransitionEffects: readonly BookEffect[] = state.periodTransitions.map((transition) => ({ type: "periodTransition", transition }));
  const stateCloseEffects: readonly BookEffect[] = state.closePackages.map((closePackage) => ({ type: "closePackage", closePackage }));
  if (
    !contentHashEquals(materializedHash(journalEffects), materializedHash(stateJournalEffects)) ||
    !contentHashEquals(materializedHash(correctionEffects), materializedHash(stateCorrectionEffects)) ||
    !contentHashEquals(materializedHash(transitionEffects), materializedHash(stateTransitionEffects)) ||
    !contentHashEquals(materializedHash(closeEffects), materializedHash(stateCloseEffects)) ||
    state.journals.some((booked, index) => booked.postingSequence !== BigInt(index + 1))
  ) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.materializedEffects", "Restored journals, corrections, periods, or closes do not exactly materialize the ordered revision effects", ["ACC-021", "ACC-031", "ACC-034", "ACC-038"]));
  }
  const activation = activationEffects[0];
  if (
    activationEffects.length > 1 ||
    (activation === undefined) !== (state.openingBoundary === undefined) ||
    (activation === undefined ? state.status !== "configuring" : state.status !== "open" || !contentHashEquals(activation.boundary.contentHash, state.openingBoundary!.contentHash) || !contentHashEquals(activation.financialIdentityHash, state.financialIdentityHash))
  ) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.openingBoundary", "Restored activation status and boundary do not exactly materialize activation history", ["ACC-027", "ACC-028", "ACC-031", "ACC-034"]));
  }
  const latestConfiguration = configurationEffects.at(-1);
  const expectedConfigurationSnapshot = latestConfiguration?.resultingConfigurationSnapshot ?? activation?.configurationSnapshot ?? state.configurationSnapshots[0];
  let activeContentHash: ContentHash | undefined;
  let retainedActiveContentHash: ContentHash | undefined;
  let snapshotChainValid = true;
  try {
    activeContentHash = hashBookConfiguration(state.periods, state.admissionSnapshot, state.policies, state.quantizationPolicies, state.accountingPolicySnapshot.policies);
    retainedActiveContentHash = hashBookConfiguration(state.activeConfigurationSnapshot.periods, state.activeConfigurationSnapshot.admissionSnapshot, state.activeConfigurationSnapshot.policies, state.activeConfigurationSnapshot.quantizationPolicies, state.activeConfigurationSnapshot.accountingPolicySnapshot.policies);
    snapshotChainValid = state.configurationSnapshots.every((snapshot, index) => snapshot.revision === BigInt(index) && contentHashEquals(hashBookConfigurationSnapshot(snapshot), snapshot.contentHash));
  } catch {
    diagnostics.push(diagnostic("policy_ambiguity", "state.configuration", "Configuration contains an invalid policy artifact and cannot be reconstructed", ["ACC-014", "ACC-034", "ACC-038"]));
    snapshotChainValid = false;
  }
  if (expectedConfigurationSnapshot === undefined || !snapshotChainValid || activeContentHash === undefined || retainedActiveContentHash === undefined || !contentHashEquals(activeContentHash, retainedActiveContentHash) || state.activeConfigurationSnapshot.revision !== state.configurationRevision || !contentHashEquals(expectedConfigurationSnapshot.contentHash, state.activeConfigurationSnapshot.contentHash) || !contentHashEquals(expectedConfigurationSnapshot.contentHash, state.configurationHash) || !contentHashEquals(hashBookConfigurationSnapshot(state.activeConfigurationSnapshot), state.activeConfigurationSnapshot.contentHash) || BigInt(state.configurationSnapshots.length) !== state.configurationRevision + 1n) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.configuration", "Restored configuration does not match the latest revisioned configuration snapshot", ["ACC-014", "ACC-031", "ACC-034", "ACC-038"]));
  }
  const restoredLotHash = hashLotState(state.lots, state.lotHoldings, state.lotAllocations);
  if (!contentHashEquals(hashLotState(restoredLots, restoredHoldings, restoredAllocations), restoredLotHash)) {
    diagnostics.push(diagnostic("ordered_history_violation", "state.lotState", "Restored lot state does not match the latest atomic lot effect", ["ACC-009", "ACC-021", "ACC-031", "ACC-034"]));
  }
  return Object.freeze(diagnostics);
}

export function validateBookProtocol(
  state: BookState,
  protocol: BookProtocolState,
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const commandIds = new Set<string>();
  const revisions = state.revisions;
  const retainedResults = protocol.retainedResults;
  // One pass over the revisions answers what each retained result used to search, flatten and replay
  // the chain for: which revision a command made (the first with that identifier), and where the
  // posting sequence and configuration stood after the revisions up to it. `after[count]` is that
  // standing once `count` revisions have been read from the start. The old replay read revisions in
  // order and stopped at the first whose number exceeded its target's; `reached` finds that count.
  const firstRevisionOf = new Map<string, number>();
  const committedCommandIds = new Set<string>();
  const after: { sequence: bigint; next: bigint; expected: bigint; hash: ContentHash }[] = [{
    sequence: 0n, next: 0n, expected: 0n,
    hash: firstActivation(state)?.configurationHash ?? state.configurationHash,
  }];
  const highestBookRevision: bigint[] = [];
  for (const [position, candidate] of revisions.entries()) {
    if (!firstRevisionOf.has(candidate.command.id)) firstRevisionOf.set(candidate.command.id, position);
    const before = after[position]!;
    const standing = { sequence: before.sequence, next: before.next, expected: before.next, hash: before.hash };
    for (const effect of candidate.effects) {
      if (effect.type === "journal") standing.sequence = effect.booked.postingSequence;
      if (effect.type === "configuration") { standing.next = effect.nextConfigurationRevision; standing.hash = effect.contentHash; }
    }
    after.push(standing);
    const highest = highestBookRevision[position - 1];
    highestBookRevision.push(highest !== undefined && highest > candidate.bookRevision ? highest : candidate.bookRevision);
  }
  for (const retained of retainedResults) if (retained.outcome === "committed") committedCommandIds.add(retained.commandId);
  const reached = (bookRevision: bigint): number => {
    let low = 0, high = highestBookRevision.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (highestBookRevision[middle]! > bookRevision) high = middle; else low = middle + 1;
    }
    return low;
  };
  for (const [index, retained] of retainedResults.entries()) {
    const path = `protocol.retainedResults[${index}]`;
    const position = firstRevisionOf.get(retained.commandId);
    const revision = position === undefined ? undefined : revisions[position];
    const standing = revision === undefined ? undefined : after[reached(revision.bookRevision)]!;
    const expectedIntentHash = revision === undefined || standing === undefined
      ? undefined
      : hashCommitIntent(revision.command, revision.bookRevision - 1n, revision.bookRevision, standing.sequence, standing.expected, standing.next, standing.hash, revision.effects);
    const expectedResultHash = resultHash(
      retained.command,
      retained.outcome,
      retained.observedBookRevision,
      retained.diagnostics,
      retained.completedAt,
      retained.outcome === "committed" ? retained.command.committedAt : undefined,
    );
    if (
      commandIds.has(retained.commandId) ||
      retained.commandId !== retained.command.id ||
      retained.command.bookId !== state.identity.bookId ||
      retained.completedAt !== retained.command.completedAt ||
      retained.observedBookRevision > state.bookRevision ||
      !contentHashEquals(commandInputHash(retained.command), retained.command.inputHash) ||
      !contentHashEquals(retained.inputHash, retained.command.inputHash) ||
      !contentHashEquals(expectedResultHash, retained.resultHash) ||
      (retained.outcome === "committed"
        ? retained.diagnostics.length !== 0 || revision === undefined || retained.commitIntentHash === undefined || expectedIntentHash === undefined || !contentHashEquals(retained.commitIntentHash, expectedIntentHash) || retained.observedBookRevision !== revision.bookRevision
        : retained.diagnostics.length === 0 || revision !== undefined || retained.commitIntentHash !== undefined)
    ) {
      diagnostics.push(diagnostic("ordered_history_violation", path, "Retained command result does not exactly match its command, result hash, and committed revision", ["ACC-021", "ACC-030", "ACC-031", "ACC-034", "ACC-038"]));
    }
    commandIds.add(retained.commandId);
  }
  for (const revision of revisions) {
    if (!committedCommandIds.has(revision.command.id)) {
      diagnostics.push(diagnostic("ordered_history_violation", "protocol.retainedResults", `Committed revision ${revision.bookRevision} has no retained command result`, ["ACC-021", "ACC-030", "ACC-031", "ACC-034"]));
    }
  }
  return Object.freeze(diagnostics);
}

export function commitBookIntent(
  state: BookState,
  protocol: BookProtocolState,
  intent: BookCommitIntent,
): AtomicBookCommit {
  const authoritativeEvaluation = evaluateBookCommand(state, protocol, intent.command);
  const recomputedIntentHash = hashCommitIntent(
    intent.command,
    intent.expectedBookRevision,
    intent.nextBookRevision,
    intent.resultingPostingSequence,
    intent.expectedConfigurationRevision,
    intent.nextConfigurationRevision,
    intent.resultingConfigurationHash,
    intent.effects,
  );
  const effectDiagnostics = [...validateIntentEffects(intent), ...validateBookEffectTopology(state, intent)];
  const configurationEffect = intent.effects.find((effect) => effect.type === "configuration");
  const expectedNextConfigurationRevision = configurationEffect?.type === "configuration" ? state.configurationRevision + 1n : state.configurationRevision;
  const expectedResultingConfigurationHash = configurationEffect?.type === "configuration" ? configurationEffect.contentHash : state.configurationHash;
  if (
    intent.expectedBookRevision !== state.bookRevision ||
    intent.nextBookRevision !== state.bookRevision + 1n ||
    intent.expectedConfigurationRevision !== state.configurationRevision ||
    intent.nextConfigurationRevision !== expectedNextConfigurationRevision ||
    !contentHashEquals(intent.resultingConfigurationHash, expectedResultingConfigurationHash) ||
    !contentHashEquals(intent.canonicalHash, recomputedIntentHash) ||
    authoritativeEvaluation.disposition !== "ready" || !contentHashEquals(intent.canonicalHash, authoritativeEvaluation.intent.canonicalHash) ||
    effectDiagnostics.length > 0
  ) {
    const diagnosticItem = effectDiagnostics[0] ?? diagnostic("atomic_commit_failed", "intent.expectedBookRevision", "Atomic commit compare-and-swap failed", ["ACC-021", "ACC-031"]);
    const evaluation = rejectEvaluation(state, intent.command, [diagnosticItem], false);
    if (evaluation.disposition !== "finished") throw new Error("Atomic failure did not finish");
    return Object.freeze({ state, protocol, result: evaluation.result });
  }
  // Equality proves content, not ownership. Retain the freshly reconstructed,
  // immutable intent so callers cannot change canonical history after commit.
  intent = authoritativeEvaluation.intent;
  const records = prepareBookCommitRecords({
    bookId: state.identity.bookId,
    bookRevision: state.bookRevision,
    previousRevision: latestRevisionRecord(state) ?? null,
  }, intent);
  const nextState = applyEffects(state, intent, records.revision);
  return Object.freeze({
    state: nextState,
    protocol: withRetainedResult(protocol, records.retained),
    intent,
    committedAt: intent.command.committedAt,
    result: records.result,
  });
}

/** Exact mathematical inputs for the next immutable revision/receipt records.
 * Previous revision is a source-authenticated financial revision, not the most
 * recent retained outcome (which may be rejected). No historical array is needed.
 * This context does not authenticate itself or certify accounting admission. */
export interface BookCommitRecordContext {
  readonly bookId: BookId;
  readonly bookRevision: bigint;
  readonly previousRevision: Pick<RevisionRecord, "bookId" | "bookRevision" | "chainHash"> | null;
}

export interface BookCommitRecords {
  readonly revision: RevisionRecord;
  readonly retained: RetainedCommandResult;
  readonly result: BookCommandResult;
}

/** Construct records for a separately evaluated, topology-verified intent. This
 * is NOT a commit API: the caller still verifies the complete read context,
 * reevaluates untrusted intents, applies all effects, computes the canonical state
 * commitment and performs full-head/fence CAS plus durable publication. An intent
 * with a valid hash can still be economically inadmissible. Legacy commit uses
 * this same constructor after its unchanged authoritative evaluation/validation.
 * Cost still depends on command/effect size; legacy lotState effects themselves
 * can carry whole populations. This extraction does not make those deltas sparse. */
export function prepareBookCommitRecords(context: BookCommitRecordContext, supplied: BookCommitIntent): BookCommitRecords {
  const previous = context.previousRevision;
  if (
    typeof context.bookRevision !== "bigint" || context.bookRevision < 0n ||
    context.bookId !== supplied.command.bookId ||
    supplied.expectedBookRevision !== context.bookRevision ||
    supplied.nextBookRevision !== context.bookRevision + 1n ||
    (context.bookRevision === 0n ? previous !== null : (
      previous == null || previous.bookId !== context.bookId || previous.bookRevision !== context.bookRevision ||
      previous.chainHash?.algorithm !== CONTENT_HASH_ALGORITHM ||
      previous.chainHash.canonicalizationVersion !== CANONICALIZATION_VERSION ||
      typeof previous.chainHash.digest !== "string" || !/^[0-9a-f]{64}$/.test(previous.chainHash.digest)
    ))
  ) throw new TypeError("Incomplete or inconsistent commit record context");
  if (
    !contentHashEquals(commandInputHash(supplied.command), supplied.command.inputHash) ||
    !contentHashEquals(hashCommitIntent(supplied.command, supplied.expectedBookRevision,
      supplied.nextBookRevision, supplied.resultingPostingSequence,
      supplied.expectedConfigurationRevision, supplied.nextConfigurationRevision,
      supplied.resultingConfigurationHash, supplied.effects), supplied.canonicalHash)
  ) throw new TypeError("Commit record intent content mismatch");
  const intent = immutableAccountingValue({ ...supplied, command: immutableCommand(supplied.command) });
  const effectsHash = hashCanonical({ type: "RevisionEffects", effects: intent.effects.map(canonicalBookEffectValue) });
  const previousHash = immutableAccountingValue(previous?.chainHash ?? null);
  const chainHash = hashCanonical({
    type: "RevisionChain",
    bookId: context.bookId,
    revision: intent.nextBookRevision,
    previousHash: previousHash === null ? null : hashValue(previousHash),
    effectsHash: hashValue(effectsHash),
  });
  const revision: RevisionRecord = Object.freeze({
    bookId: context.bookId,
    bookRevision: intent.nextBookRevision,
    previousHash,
    effectsHash,
    chainHash,
    committedAt: intent.command.committedAt,
    command: intent.command,
    effects: intent.effects,
  });
  const hash = resultHash(
    intent.command,
    "committed",
    intent.nextBookRevision,
    [],
    intent.command.completedAt,
    intent.command.committedAt,
  );
  const retained: RetainedCommandResult = Object.freeze({
    command: intent.command,
    commandId: intent.command.id,
    inputHash: intent.command.inputHash,
    outcome: "committed",
    observedBookRevision: intent.nextBookRevision,
    resultHash: hash,
    completedAt: intent.command.completedAt,
    diagnostics: Object.freeze([]),
    commitIntentHash: intent.canonicalHash,
  });
  return Object.freeze({
    revision,
    retained,
    result: Object.freeze({
      disposition: "committed",
      observedBookRevision: intent.nextBookRevision,
      resultHash: hash,
      diagnostics: Object.freeze([]),
      completedAt: intent.command.completedAt,
      committedAt: intent.command.committedAt,
    }),
  });
}

export function executeBookCommand(
  state: BookState,
  protocol: BookProtocolState,
  command: BookCommand,
): AtomicBookCommit {
  const evaluation = evaluateBookCommand(state, protocol, command);
  if (evaluation.disposition === "ready") return commitBookIntent(state, protocol, evaluation.intent);
  if (evaluation.retained === undefined) return Object.freeze({ state, protocol, result: evaluation.result });
  return Object.freeze({
    state,
    protocol: withRetainedResult(protocol, evaluation.retained),
    result: evaluation.result,
  });
}

// ---------------------------------------------------------------------------------------------
// Applying what a book has recorded, without evaluating it again.

/** The result of applying a recorded revision: the book after it, or why the record does not follow the
 * book it was offered to. */
export type RecordedRevisionApplication =
  | { readonly disposition: "applied"; readonly state: BookState }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

/** What a ledger stored of one command: the command, the result it first returned and, when it
 * committed, the revision it made. The shape of `BookOutcomePayload` in the codec. */
export interface RecordedOutcome {
  readonly command: BookCommand;
  readonly originalResult: Omit<BookCommandResult, "disposition"> & { readonly disposition: "committed" | "rejected" };
  readonly revision: RevisionRecord | null;
}

/** The result of applying a recorded outcome: the book and its protocol after it, or why the record
 * does not follow them. */
export type RecordedOutcomeApplication =
  | { readonly disposition: "applied"; readonly state: BookState; readonly protocol: BookProtocolState }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

const RECORDED_REQUIREMENTS = Object.freeze(["ACC-021", "ACC-031", "ACC-034", "ACC-038"]);
const NO_RETAINED_DIAGNOSTICS: readonly SemanticDiagnostic[] = Object.freeze([]);

function recordedRefusal(path: string, message: string): readonly SemanticDiagnostic[] {
  return Object.freeze([diagnostic("ordered_history_violation", path, message, RECORDED_REQUIREMENTS)]);
}

type RecordedStep =
  | { readonly applied: true; readonly state: BookState; readonly postingSequence: bigint }
  | { readonly applied: false; readonly diagnostics: readonly SemanticDiagnostic[] };

function recordedStep(state: BookState, revision: RevisionRecord): RecordedStep {
  const refuse = (path: string, message: string): RecordedStep => ({ applied: false, diagnostics: recordedRefusal(path, message) });
  try {
    if (state.activeConfigurationSnapshot.stateCommitmentProfile !== CHAIN_HEAD_STATE_COMMITMENT_PROFILE)
      return refuse("state.stateCommitmentProfile", "A recorded revision is applied only to a book with the chain-head state commitment");
    if (!Object.isFrozen(revision) || !Object.isFrozen(revision.effects) || !Object.isFrozen(revision.command))
      return refuse("revision", "A recorded revision must be an immutable record");
    const command = revision.command;
    const head = latestRevisionRecord(state);
    if (
      revision.bookId !== state.identity.bookId || command.bookId !== state.identity.bookId ||
      revision.bookRevision !== state.bookRevision + 1n || command.expectedBookRevision !== state.bookRevision ||
      revision.committedAt !== command.committedAt ||
      !commandTimelineIsValid(command.issuedAt, command.completedAt, command.committedAt, head?.committedAt)
    ) return refuse("revision.bookRevision", "Recorded revision is not the next revision of this book");
    if (head === undefined ? revision.previousHash !== null : revision.previousHash === null || !contentHashEquals(revision.previousHash, head.chainHash))
      return refuse("revision.previousHash", "Recorded revision does not link to the latest chain hash of the book");
    // The chain hash is re-derived from the recorded effects hash and not from the effects: the hash of
    // the effects themselves is what a full verification re-checks.
    if (!contentHashEquals(revision.chainHash, hashCanonical({
      type: "RevisionChain",
      bookId: state.identity.bookId,
      revision: revision.bookRevision,
      previousHash: head === undefined ? null : hashValue(head.chainHash),
      effectsHash: hashValue(revision.effectsHash),
    }))) return refuse("revision.chainHash", "Recorded revision's chain hash is not the hash of its link and its effects hash");
    let sequence = state.latestPostingSequence;
    let configurationRevision = state.configurationRevision;
    let configurationHash = state.configurationHash;
    let status = state.status;
    for (const effect of revision.effects) {
      if (effect.type === "journal") {
        sequence += 1n;
        if (effect.booked.postingSequence !== sequence || effect.booked.bookRevision !== revision.bookRevision || effect.booked.commandId !== command.id)
          return refuse("revision.effects", "Recorded journals do not continue the posting sequence of the book");
      } else if (effect.type === "configuration") {
        const snapshot = effect.resultingConfigurationSnapshot;
        if (
          effect.expectedConfigurationRevision !== configurationRevision || effect.nextConfigurationRevision !== configurationRevision + 1n ||
          !contentHashEquals(effect.previousConfigurationHash, configurationHash) ||
          snapshot.revision !== effect.nextConfigurationRevision || snapshot.stateCommitmentProfile !== CHAIN_HEAD_STATE_COMMITMENT_PROFILE ||
          !contentHashEquals(effect.contentHash, snapshot.contentHash) ||
          !contentHashEquals(hashBookConfigurationSnapshot(snapshot), snapshot.contentHash)
        ) return refuse("revision.effects", "Recorded configuration change does not continue the configuration chain of the book");
        configurationRevision = effect.nextConfigurationRevision;
        configurationHash = effect.contentHash;
      } else if (effect.type === "activation") {
        if (status !== "configuring" || !contentHashEquals(effect.financialIdentityHash, state.financialIdentityHash))
          return refuse("revision.effects", "Recorded activation does not belong to this unactivated book");
        status = "open";
      }
    }
    // Every configuration snapshot the revision carries was just hashed above.
    const next = applyEffects(state, { effects: revision.effects, nextBookRevision: revision.bookRevision, resultingPostingSequence: sequence }, revision, true);
    return { applied: true, state: next, postingSequence: sequence };
  } catch {
    return refuse("revision", "Recorded revision could not be read");
  }
}

/** The book after one revision it recorded, applied without evaluating the command that made it again.
 *
 * `executeBookCommand` re-derives a revision from a command: it re-admits the command, rebuilds every
 * effect, hashes them and compares. A book whose revisions are already stored under a hash chain (a
 * ledger, a log) can instead apply the stored effects to the state, which is what this does, through the
 * same `applyEffects` a commit uses: the state it returns is the one `executeBookCommand` returns for
 * the command that made the revision (same state hash, journals, revisions, configuration snapshots,
 * periods, corrections, closes, lots and accounting state), provided the record is what that command
 * made. That proviso is the trust: this function does NOT re-evaluate the command, does NOT recompute
 * the hash of the effects or of any journal, and so accepts a record whose effects were altered and
 * nothing else. Re-execution (`executeBookCommand` against the stored command, comparing the result with
 * the record) and `validateBookState` remain the independent check, for a verifier to run.
 *
 * What it does check costs the size of the revision and not the length of the history: that the book
 * carries the chain-head state commitment (a book without it hashes its whole population at every step,
 * so there is nothing to save; it is refused), that the record is immutable, belongs to the book and is
 * its next revision with a command that expected exactly that, that it links to the book's latest chain
 * hash and that its chain hash is the hash of that link and its recorded effects hash, that its journals
 * continue the posting sequence, that a configuration change continues the configuration chain with a
 * snapshot that hashes to what it claims and keeps the commitment profile, and that an activation
 * belongs to an unactivated book. `state` must be a book the kernel built or validated (it is not
 * re-validated here); `revision` must be an immutable record such as the codec decodes. */
export function applyRecordedRevision(state: BookState, revision: RevisionRecord): RecordedRevisionApplication {
  const step = recordedStep(state, revision);
  return step.applied
    ? Object.freeze({ disposition: "applied", state: step.state })
    : Object.freeze({ disposition: "rejected", diagnostics: step.diagnostics });
}

/** The book and its protocol after one outcome its ledger stored, without evaluating the command again:
 * the revision, if the command committed, applied as `applyRecordedRevision` does, and the retained
 * command result `executeBookCommand` would have retained (a committed revision's or a rejection's)
 * added to the protocol, so a later command with the same identifier is answered "replayed", as after a
 * full replay. A committed result keeps its `commitIntentHash`, the hash of the revision's effects as an
 * intent, as a property computed on first read and then kept: no evaluation reads it, and computing it
 * for every revision would cost about as much as the hash of the effects itself. The outcome must be an
 * immutable record such as the codec decodes. A book without the chain-head commitment, a command
 * identifier the protocol already retains, a rejection that does not observe the book's revision, and
 * a committed result that is not the revision's are refused, besides everything
 * `applyRecordedRevision` refuses. */
export function applyRecordedOutcome(
  state: BookState,
  protocol: BookProtocolState,
  outcome: RecordedOutcome,
): RecordedOutcomeApplication {
  const refuse = (path: string, message: string): RecordedOutcomeApplication =>
    Object.freeze({ disposition: "rejected", diagnostics: recordedRefusal(path, message) });
  try {
    const { command, originalResult: result, revision } = outcome;
    if (state.activeConfigurationSnapshot.stateCommitmentProfile !== CHAIN_HEAD_STATE_COMMITMENT_PROFILE)
      return refuse("state.stateCommitmentProfile", "A recorded outcome is applied only to a book with the chain-head state commitment");
    if (
      !Object.isFrozen(command) || !Object.isFrozen(result) || !Object.isFrozen(result.diagnostics) ||
      command.bookId !== state.identity.bookId || retainedLogOf(protocol).has("command", command.id)
    ) return refuse("outcome.command", "A recorded outcome must be immutable and carry a command of this book that the protocol has not retained");
    if (result.disposition === "rejected") {
      if (revision !== null || result.observedBookRevision !== state.bookRevision || result.completedAt !== command.completedAt || result.diagnostics.length === 0)
        return refuse("outcome.originalResult", "A recorded rejection must observe the book's revision, carry diagnostics and no revision");
      return Object.freeze({
        disposition: "applied",
        state,
        protocol: withRetainedResult(protocol, Object.freeze({
          command,
          commandId: command.id,
          inputHash: command.inputHash,
          outcome: "rejected" as const,
          observedBookRevision: result.observedBookRevision,
          resultHash: result.resultHash,
          completedAt: command.completedAt,
          diagnostics: result.diagnostics,
        })),
      });
    }
    if (
      result.disposition !== "committed" || revision === null || revision.command.id !== command.id ||
      !contentHashEquals(revision.command.inputHash, command.inputHash) || result.observedBookRevision !== revision.bookRevision ||
      result.completedAt !== command.completedAt
    ) return refuse("outcome.revision", "A recorded commit must carry the revision that its command made");
    const expectedConfigurationRevision = state.configurationRevision;
    const expectedConfigurationHash = state.configurationHash;
    const step = recordedStep(state, revision);
    if (!step.applied) return Object.freeze({ disposition: "rejected", diagnostics: step.diagnostics });
    let intentHash: ContentHash | undefined;
    const retained = {
      command: revision.command,
      commandId: command.id,
      inputHash: command.inputHash,
      outcome: "committed" as const,
      observedBookRevision: revision.bookRevision,
      resultHash: result.resultHash,
      completedAt: command.completedAt,
      diagnostics: NO_RETAINED_DIAGNOSTICS,
    };
    Object.defineProperty(retained, "commitIntentHash", {
      enumerable: true,
      get: () => {
        const configuration = revision.effects.find((effect) => effect.type === "configuration");
        return (intentHash ??= hashCommitIntent(
          revision.command, revision.bookRevision - 1n, revision.bookRevision, step.postingSequence, expectedConfigurationRevision,
          configuration?.type === "configuration" ? configuration.nextConfigurationRevision : expectedConfigurationRevision,
          configuration?.type === "configuration" ? configuration.contentHash : expectedConfigurationHash,
          revision.effects,
        ));
      },
    });
    return Object.freeze({
      disposition: "applied",
      state: step.state,
      protocol: withRetainedResult(protocol, Object.freeze(retained) as RetainedCommandResult),
    });
  } catch {
    return refuse("outcome", "A recorded outcome could not be read");
  }
}

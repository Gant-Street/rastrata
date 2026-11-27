/**
 * Reviewed semantic links from SysML requirements to concrete kernel exports.
 *
 * These are live function/class references, not source-text matches. The trace
 * gate verifies each reference is the named export of the declared module and
 * that every non-boundary SysML requirement has an exact binding.
 */
import {
  ExactDecimal,
  ExactRational,
  admitJournal,
  allocateLots,
  applyAccountingEffect,
  applySettlement,
  prepareBookSettlement,
  prepareBookCurrencyRemeasurement,
  prepareBookCorrection,
  prepareBookConsolidation,
  prepareBookReopen,
  requiresRemeasurementReversal,
  calculateInventoryValueAdjustment,
  calculateCurrencyRemeasurement,
  calculateInventoryCost,
  calculateInventoryRecosting,
  canonicalEncode,
  commitBookIntent,
  compileConsolidation,
  createAccountingPolicySnapshot,
  createAccountingReadSnapshot,
  createAllocationSchedule,
  createBookState,
  createProvisionalInventoryLayerEffect,
  decodeDurableBook,
  determineTax,
  encodeDurableBook,
  evaluateBookCommand,
  executeBookCommand,
  hashBookConfiguration,
  hashAccountingBasisSourcePopulation,
  hashAccountingReadPopulation,
  hashAccountingReadSnapshot,
  hashBookState,
  hashCanonical,
  hashFinancialIdentity,
  instant,
  localDate,
  projectAccountingBasis,
  quantizeBalancedBookValues,
  rebuildAccountBalanceProjection,
  recognizeOpenItem,
  recognizeScheduledAllocation,
  rejectExternalAccountingAuthority,
  reviseAllocationSchedule,
  resolveJournal,
  resolveCanonicalPostingCandidates,
  canonicalPostingSourceIdentity,
  resolveBookAccountingPeriod,
  resolveRecostingPeriod,
  selectBookingPolicy,
  transferLots,
  validateAccountingEffectAdmission,
  validateAccountingEffectHash,
  validateCanonicalPostingReferenceHash,
  validateBookEffectTopology,
  validateBookProtocol,
  validateBookState,
  validateBookFinancialIdentity,
  valueWithObservation,
  verifyProjectionCheckpoint,
  allocateInventoryPostedValue,
  decodeInventoryOwnershipArtifact,
  encodeInventoryOwnershipArtifact,
  prepareBookOwnedInventory,
  prepareInventoryOwnershipEffect,
  prepareInventoryPostedAdoptionGroup,
  prepareInventoryPostedReduction,
  prepareInventoryPostedTransferGroup,
  prepareOwnedInventoryAccounting,
  resolveInventoryOwnershipSources,
  validateInventoryOwnershipArtifact,
} from "../src/index.ts";

export interface SemanticImplementationBinding {
  readonly module: `packages/kernel/src/${string}.ts`;
  readonly implementation: Function;
}

const binding = (module: SemanticImplementationBinding["module"], implementation: Function): SemanticImplementationBinding =>
  Object.freeze({ module, implementation });

const numeric = binding("packages/kernel/src/numeric.ts", ExactRational);
const decimal = binding("packages/kernel/src/numeric.ts", ExactDecimal);
const journal = binding("packages/kernel/src/journal.ts", admitJournal);
const policy = binding("packages/kernel/src/policy.ts", selectBookingPolicy);
const resolve = binding("packages/kernel/src/policy.ts", resolveJournal);
const lots = binding("packages/kernel/src/lots.ts", allocateLots);
const transfer = binding("packages/kernel/src/lots.ts", transferLots);
const valuation = binding("packages/kernel/src/valuation.ts", valueWithObservation);
const canonical = binding("packages/kernel/src/canonical.ts", canonicalEncode);
const hash = binding("packages/kernel/src/canonical.ts", hashCanonical);
const quantization = binding("packages/kernel/src/quantization.ts", quantizeBalancedBookValues);
const projection = binding("packages/kernel/src/projection.ts", rebuildAccountBalanceProjection);
const checkpoint = binding("packages/kernel/src/projection.ts", verifyProjectionCheckpoint);
const evaluate = binding("packages/kernel/src/book.ts", evaluateBookCommand);
const execute = binding("packages/kernel/src/book.ts", executeBookCommand);
const commit = binding("packages/kernel/src/book.ts", commitBookIntent);
const topology = binding("packages/kernel/src/book.ts", validateBookEffectTopology);
const reopenAdmission = binding("packages/kernel/src/book.ts", prepareBookReopen);
const state = binding("packages/kernel/src/book.ts", validateBookState);
const protocol = binding("packages/kernel/src/book.ts", validateBookProtocol);
const createBook = binding("packages/kernel/src/book.ts", createBookState);
const financialIdentity = binding("packages/kernel/src/book.ts", hashFinancialIdentity);
const configuration = binding("packages/kernel/src/book.ts", hashBookConfiguration);
const bookHash = binding("packages/kernel/src/book.ts", hashBookState);
const recostingPeriod = binding("packages/kernel/src/book.ts", resolveRecostingPeriod);
const accountingPeriod = binding("packages/kernel/src/book.ts", resolveBookAccountingPeriod);
const durableEncode = binding("packages/kernel/src/codec.ts", encodeDurableBook);
const durableDecode = binding("packages/kernel/src/codec.ts", decodeDurableBook);
const accountingSnapshot = binding("packages/kernel/src/accounting.ts", createAccountingPolicySnapshot);
const completeReadSnapshot = binding("packages/kernel/src/book.ts", createAccountingReadSnapshot);
const inventory = binding("packages/kernel/src/accounting.ts", calculateInventoryCost);
const provisional = binding("packages/kernel/src/accounting.ts", createProvisionalInventoryLayerEffect);
const recost = binding("packages/kernel/src/accounting.ts", calculateInventoryRecosting);
const valueAdjustment = binding("packages/kernel/src/accounting.ts", calculateInventoryValueAdjustment);
const accountingAdmission = binding("packages/kernel/src/accounting.ts", validateAccountingEffectAdmission);
const accountingEffectHash = binding("packages/kernel/src/accounting.ts", validateAccountingEffectHash);
const accountingLifecycle = binding("packages/kernel/src/accounting.ts", applyAccountingEffect);
const postingReference = binding("packages/kernel/src/accounting.ts", validateCanonicalPostingReferenceHash);
const openItem = binding("packages/kernel/src/accounting.ts", recognizeOpenItem);
const settlement = binding("packages/kernel/src/accounting.ts", applySettlement);
const settlementAdmission = binding("packages/kernel/src/book.ts", prepareBookSettlement);
const basis = binding("packages/kernel/src/accounting.ts", projectAccountingBasis);
const basisPopulation = binding("packages/kernel/src/accounting.ts", hashAccountingBasisSourcePopulation);
const completeBasisPopulation = binding("packages/kernel/src/accounting.ts", hashAccountingReadPopulation);
const basisSnapshot = binding("packages/kernel/src/accounting.ts", hashAccountingReadSnapshot);
const remeasurement = binding("packages/kernel/src/accounting.ts", calculateCurrencyRemeasurement);
const currencyAdmission = binding("packages/kernel/src/book.ts", prepareBookCurrencyRemeasurement);
const correctionAdmission = binding("packages/kernel/src/book.ts", prepareBookCorrection);
const requiredReversal = binding("packages/kernel/src/book.ts", requiresRemeasurementReversal);
const schedule = binding("packages/kernel/src/accounting.ts", createAllocationSchedule);
const recognition = binding("packages/kernel/src/accounting.ts", recognizeScheduledAllocation);
const scheduleRevision = binding("packages/kernel/src/accounting.ts", reviseAllocationSchedule);
const tax = binding("packages/kernel/src/accounting.ts", determineTax);
const consolidation = binding("packages/kernel/src/accounting.ts", compileConsolidation);
const consolidationAdmission = binding("packages/kernel/src/book.ts", prepareBookConsolidation);
const externalAuthority = binding("packages/kernel/src/accounting.ts", rejectExternalAccountingAuthority);
const date = binding("packages/kernel/src/journal.ts", localDate);
const timestamp = binding("packages/kernel/src/journal.ts", instant);
const ownershipEffect = binding("packages/kernel/src/inventory-ownership.ts", prepareInventoryOwnershipEffect);
const reduction = binding("packages/kernel/src/inventory-ownership.ts", prepareInventoryPostedReduction);
const ownershipSources = binding("packages/kernel/src/inventory-ownership.ts", resolveInventoryOwnershipSources);
const allocatedPostedValue = binding("packages/kernel/src/inventory-posted-values.ts", allocateInventoryPostedValue);
const ownedInventoryAccounting = binding("packages/kernel/src/owned-inventory-command.ts", prepareOwnedInventoryAccounting);
const bookOwnedInventory = binding("packages/kernel/src/book.ts", prepareBookOwnedInventory);
const ownershipArtifactValidate = binding("packages/kernel/src/inventory-ownership.ts", validateInventoryOwnershipArtifact);
const ownershipArtifactEncode = binding("packages/kernel/src/codec.ts", encodeInventoryOwnershipArtifact);
const ownershipArtifactDecode = binding("packages/kernel/src/codec.ts", decodeInventoryOwnershipArtifact);
const adoptionGroup = binding("packages/kernel/src/inventory-ownership.ts", prepareInventoryPostedAdoptionGroup);
const transferGroup = binding("packages/kernel/src/inventory-ownership.ts", prepareInventoryPostedTransferGroup);

export const KERNEL_REQUIREMENT_BINDINGS: Readonly<Record<string, readonly SemanticImplementationBinding[]>> = Object.freeze({
  "ACC-001": [numeric, decimal],
  "ACC-002": [journal],
  "ACC-003": [quantization],
  "ACC-004": [correctionAdmission, evaluate, commit],
  "ACC-005": [policy, resolve],
  "ACC-006": [policy],
  "ACC-007": [policy],
  "ACC-008": [lots],
  "ACC-009": [transfer, evaluate],
  "ACC-010": [transfer, evaluate],
  "ACC-011": [valuation],
  "ACC-012": [valuation],
  "ACC-013": [date, timestamp],
  "ACC-014": [projection],
  "ACC-017": [resolve],
  "ACC-018": [journal],
  "ACC-019": [canonical, hash],
  "ACC-021": [commit, topology, bookHash],
  "ACC-022": [projection],
  "ACC-023": [checkpoint],
  "ACC-026": [journal],
  "ACC-027": [createBook, financialIdentity],
  "ACC-028": [evaluate],
  "ACC-029": [evaluate, accountingPeriod],
  "ACC-030": [execute, protocol],
  "ACC-031": [commit, topology, bookHash, state],
  "ACC-032": [topology, reopenAdmission],
  "ACC-034": [durableEncode, durableDecode, state, protocol],
  "ACC-037": [configuration, accountingSnapshot],
  "ACC-038": [canonical, hash, postingReference,
    binding("packages/kernel/src/book.ts", resolveCanonicalPostingCandidates),
    binding("packages/kernel/src/book.ts", canonicalPostingSourceIdentity),
    binding("packages/kernel/src/book.ts", validateBookFinancialIdentity),
    evaluate, commit, topology, durableDecode],

  "ACC-039": [inventory, valueAdjustment],
  "ACC-039.1": [inventory, valueAdjustment],
  "ACC-039.2": [inventory, valueAdjustment, postingReference],
  "ACC-039.3": [inventory, valueAdjustment],
  "ACC-039.4": [valueAdjustment, accountingLifecycle],
  "ACC-039.5": [valueAdjustment],
  "ACC-039.6": [valueAdjustment, evaluate, topology],
  "ACC-039.7": [ownershipEffect, reduction, ownershipSources, allocatedPostedValue],
  "ACC-039.8": [bookOwnedInventory, ownedInventoryAccounting, evaluate, commit],
  "ACC-039.9": [ownershipArtifactValidate, ownershipArtifactEncode, ownershipArtifactDecode, adoptionGroup, transferGroup],

  "ACC-040": [inventory, recost],
  "ACC-040.1": [inventory],
  "ACC-040.2": [provisional, inventory],
  "ACC-040.3": [recost],
  "ACC-040.4": [recost, accountingAdmission, state],
  "ACC-040.5": [recostingPeriod, evaluate],

  "ACC-041": [openItem, settlement, settlementAdmission],
  "ACC-041.1": [openItem, settlement, settlementAdmission, postingReference, evaluate],
  "ACC-041.2": [settlement],
  "ACC-041.3": [settlement, settlementAdmission, accountingPeriod, topology],
  "ACC-041.4": [settlement, accountingAdmission, accountingLifecycle],
  "ACC-041.5": [settlement, settlementAdmission],
  "ACC-041.6": [settlementAdmission, evaluate, topology],

  "ACC-042": [basis, completeReadSnapshot, basisSnapshot],
  "ACC-042.1": [basis, completeReadSnapshot, basisSnapshot, basisPopulation, completeBasisPopulation],
  "ACC-042.2": [basis, completeReadSnapshot, basisSnapshot, basisPopulation, completeBasisPopulation, postingReference, settlement],
  "ACC-042.3": [basis],
  "ACC-042.4": [basis, completeReadSnapshot, basisSnapshot, basisPopulation, completeBasisPopulation],
  "ACC-042.5": [basis],
  "ACC-042.6": [basis],

  "ACC-043": [remeasurement],
  "ACC-043.1": [remeasurement, currencyAdmission, evaluate, state],
  "ACC-043.2": [remeasurement, valuation],
  "ACC-043.3": [remeasurement, settlementAdmission],
  "ACC-043.4": [remeasurement, currencyAdmission, evaluate, settlementAdmission, state],
  "ACC-043.5": [remeasurement, currencyAdmission, requiredReversal, correctionAdmission, evaluate, state],
  "ACC-043.6": [remeasurement, accountingAdmission, accountingEffectHash],

  "ACC-044": [schedule, recognition, scheduleRevision],
  "ACC-044.1": [schedule],
  "ACC-044.2": [schedule],
  "ACC-044.3": [schedule],
  "ACC-044.4": [recognition, scheduleRevision],
  "ACC-044.5": [recognition, scheduleRevision, accountingAdmission, accountingLifecycle],
  "ACC-044.6": [scheduleRevision, evaluate, commit, topology, durableEncode, durableDecode],

  "ACC-045": [tax],
  "ACC-045.1": [tax],
  "ACC-045.2": [tax],
  "ACC-045.3": [tax],
  "ACC-045.4": [tax],
  "ACC-045.5": [tax],
  "ACC-045.6": [tax, evaluate, topology],
  "ACC-045.7": [tax, externalAuthority],

  "ACC-046": [consolidation],
  "ACC-046.1": [consolidation],
  "ACC-046.2": [consolidation],
  "ACC-046.3": [consolidation],
  "ACC-046.4": [consolidation, valuation],
  "ACC-046.5": [consolidation],
  "ACC-046.6": [consolidation, consolidationAdmission],
  "ACC-046.7": [consolidation, consolidationAdmission, evaluate],
  "ACC-046.8": [consolidation, consolidationAdmission, accountingAdmission],

  "ACC-047": [execute, externalAuthority],
  "ACC-047.1": [journal, externalAuthority],
  "ACC-047.2": [evaluate, topology, postingReference, externalAuthority],
  "ACC-047.3": [commit, externalAuthority],
  "ACC-047.4": [state, protocol, accountingEffectHash, externalAuthority],
  "ACC-047.5": [policy, accountingSnapshot, externalAuthority],
});

export const BOUNDARY_REQUIREMENT_DISPOSITIONS: Readonly<Record<string, string>> = Object.freeze({
  "ACC-015": "Balance assertions are immutable Ring C proof evidence and cannot mutate canonical postings.",
  "ACC-016": "The many-to-many reconciliation graph is a Ring C proof projection outside canonical posting authority.",
  "ACC-020": "Canonical interchange adapter fidelity and operational import/export orchestration belong at a Ring D boundary; imported facts still enter through kernel commands.",
  "ACC-025": "Release traceability is a governance and verification boundary over executable kernel evidence; it does not create accounting state or authority.",
  "ACC-024": "Complete valuation-path provenance is a Ring C proof service; the kernel valuation primitive does not make the proof projection canonical state.",
  "ACC-033": "Full reproducible financial reports are Ring C proof projections over kernel populations and reporting-policy snapshots.",
  "ACC-035": "Cross-book orchestration is a Ring D saga boundary; each book remains independently authoritative.",
  "ACC-036": "Storage portability is a Ring D quality constraint verified by adapters and deployment implementations.",
});

export const DESIGN_PENDING_REQUIREMENT_DISPOSITIONS: Readonly<Record<string, string>> = Object.freeze({});

import { contentHashEquals, hashCanonical, identifier, type ContentHash } from "./canonical.ts";
import {
  validateBookProtocol,
  validateBookState,
  hashFinancialIdentity,
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  type BookProtocolState,
  type BookState,
  type BookCommand,
  type BookCommandResult,
  type RevisionRecord,
} from "./book.ts";
import { ExactDecimal, ExactRational } from "./numeric.ts";
import { instant, localDate } from "./journal.ts";
import { markVerifiedSnapshot } from "./verified-snapshots.ts";
import { semanticVersion } from "./policy.ts";
import { validateInventoryOwnershipArtifact, type InventoryOwnershipArtifactKind, type InventoryOwnershipArtifactTypes } from "./inventory-ownership.ts";

export const DURABLE_BOOK_CODEC_VERSION = "rastrata-book-aggregate-v1" as const;
export const BOOK_OUTCOME_CODEC_VERSION = "rastrata-book-outcome-v1" as const;
/** A command-only transport: callers never supply an authoritative result/effect. */
export const BOOK_COMMAND_CODEC_VERSION = "rastrata-book-command-v1" as const;
/** A typed subtree of the existing durable codec, not a new accounting profile. */
export const BOOK_ROW_CODEC_VERSION = "rastrata-book-row-v1" as const;
/** Scalar header encoding for an explicitly different indexed representation.
 * Never substitute its commitment for the legacy BookState.contentHash. */
export const BOOK_STATE_HEADER_CODEC_VERSION = "rastrata-book-state-header-v1" as const;
/** Standalone artifact envelope; only an admitted owned command establishes ownership. */
export const INVENTORY_OWNERSHIP_CODEC_VERSION = "rastrata-inventory-ownership-artifact-v1" as const;
const MAX_OUTCOME_BYTES = 1024 * 1024;
const MAX_DURABLE_BYTES = 16 * 1024 * 1024;
const MAX_DURABLE_DEPTH = 128;
const MAX_DURABLE_COLLECTION = 10_000;

type EncodedNode =
  | readonly ["n"]
  | readonly ["b", boolean]
  | readonly ["s", string]
  | readonly ["i", string]
  | readonly ["x", string]
  | readonly ["d", string, string]
  | readonly ["r", string, string]
  | readonly ["a", readonly EncodedNode[]]
  | readonly ["o", readonly (readonly [string, EncodedNode])[]];

export interface DurableBookAggregate {
  readonly state: BookState;
  readonly protocol: BookProtocolState;
}
export type BookStateHeader = Pick<BookState, "identity" | "financialIdentityHash" | "status" | "bookRevision" | "latestPostingSequence" | "configurationRevision" | "configurationHash">;
export type BookStateHeaderDecodeResult =
  | { readonly disposition: "decoded"; readonly header: BookStateHeader }
  | { readonly disposition: "rejected"; readonly message: string };
export interface BookOutcomePayload {
  readonly command: BookCommand;
  readonly originalResult: Omit<BookCommandResult, "disposition"> & { readonly disposition: "committed" | "rejected" };
  readonly revision: RevisionRecord | null;
}
export type BookOutcomeDecodeResult =
  | { readonly disposition: "decoded"; readonly payload: BookOutcomePayload }
  | { readonly disposition: "rejected"; readonly message: string };
export type BookCommandDecodeResult =
  | { readonly disposition: "decoded"; readonly command: BookCommand }
  | { readonly disposition: "rejected"; readonly message: string };

export type DurableDecodeResult =
  | { readonly disposition: "decoded"; readonly aggregate: DurableBookAggregate }
  | { readonly disposition: "rejected"; readonly message: string };

type ArrayKeys<T> = { [K in keyof T]-?: T[K] extends readonly unknown[] ? K : never }[keyof T];
type StateRowKey = Exclude<ArrayKeys<BookState>, "periods" | "policies" | "quantizationPolicies">;
export type BookRowTypes = {
  [K in StateRowKey as `state.${K}`]: BookState[K] extends readonly (infer R)[] ? R : never;
} & {
  "state.openingBoundary": NonNullable<BookState["openingBoundary"]>;
} & {
  [K in keyof BookState["accountingState"] as `state.accountingState.${K}`]: BookState["accountingState"][K][number];
} & {
  [K in ArrayKeys<BookProtocolState> as `protocol.${K}`]: BookProtocolState[K][number];
};
export type BookRowCollection = keyof BookRowTypes;
export type BookRowDecodeResult<C extends BookRowCollection> =
  | { readonly disposition: "decoded"; readonly collection: C; readonly row: BookRowTypes[C] }
  | { readonly disposition: "rejected"; readonly message: string };
export type InventoryOwnershipDecodeResult<K extends InventoryOwnershipArtifactKind> =
  | { readonly disposition: "decoded"; readonly kind: K; readonly artifact: InventoryOwnershipArtifactTypes[K] }
  | { readonly disposition: "rejected"; readonly message: string };

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new TypeError("Durable byte string is not lowercase hexadecimal");
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function encodeNode(value: unknown, ancestors: WeakSet<object>, depth: number): EncodedNode {
  if (depth > MAX_DURABLE_DEPTH) throw new RangeError("Durable aggregate exceeds the maximum nesting depth");
  if (value === null) return ["n"];
  if (typeof value === "boolean") return ["b", value];
  if (typeof value === "string") return ["s", value];
  if (typeof value === "bigint") return ["i", value.toString()];
  if (value instanceof Uint8Array) return ["x", bytesToHex(value)];
  if (value instanceof ExactDecimal) return ["d", value.coefficient.toString(), value.scale.toString()];
  if (value instanceof ExactRational) return ["r", value.numerator.toString(), value.denominator.toString()];
  if (typeof value !== "object" || value === undefined) throw new TypeError(`Unsupported durable value: ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Durable aggregate must be acyclic");
  ancestors.add(value);
  let encoded: EncodedNode;
  if (Array.isArray(value)) {
    if (value.length > MAX_DURABLE_COLLECTION) throw new RangeError("Durable array exceeds the collection limit");
    encoded = ["a", value.map((member) => encodeNode(member, ancestors, depth + 1))];
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Durable records must be plain objects");
    const entries = Object.entries(value);
    if (entries.length > MAX_DURABLE_COLLECTION) throw new RangeError("Durable record exceeds the collection limit");
    encoded = ["o", entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, member]) => [key, encodeNode(member, ancestors, depth + 1)] as const)];
  }
  ancestors.delete(value);
  return encoded;
}

function requireNode(value: unknown, depth: number): EncodedNode {
  if (depth > MAX_DURABLE_DEPTH || !Array.isArray(value) || typeof value[0] !== "string") {
    throw new TypeError("Invalid durable node");
  }
  return value as unknown as EncodedNode;
}

function decodeNode(encodedValue: unknown, depth: number): unknown {
  const node = requireNode(encodedValue, depth);
  switch (node[0]) {
    case "n": if (node.length === 1) return null; break;
    case "b": if (node.length === 2 && typeof node[1] === "boolean") return node[1]; break;
    case "s": if (node.length === 2 && typeof node[1] === "string") return node[1]; break;
    case "i": if (node.length === 2 && typeof node[1] === "string" && /^-?(?:0|[1-9]\d*)$/.test(node[1])) return BigInt(node[1]); break;
    case "x": if (node.length === 2 && typeof node[1] === "string") return hexToBytes(node[1]); break;
    case "d": if (node.length === 3 && typeof node[1] === "string" && typeof node[2] === "string") return ExactDecimal.of(BigInt(node[1]), BigInt(node[2])); break;
    case "r": if (node.length === 3 && typeof node[1] === "string" && typeof node[2] === "string") return ExactRational.of(BigInt(node[1]), BigInt(node[2])); break;
    case "a":
      if (node.length === 2 && Array.isArray(node[1]) && node[1].length <= MAX_DURABLE_COLLECTION) {
        return node[1].map((member) => decodeNode(member, depth + 1));
      }
      break;
    case "o":
      if (node.length === 2 && Array.isArray(node[1]) && node[1].length <= MAX_DURABLE_COLLECTION) {
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        const keys = new Set<string>();
        for (const entry of node[1]) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || keys.has(entry[0])) {
            throw new TypeError("Durable record keys must be unique strings");
          }
          keys.add(entry[0]);
          result[entry[0]] = decodeNode(entry[1], depth + 1);
        }
        return result;
      }
      break;
  }
  throw new TypeError("Malformed durable node");
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const member of Object.values(value)) deepFreeze(member, seen);
  Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type DurableScalar = "string" | "boolean" | "bigint" | "bytes" | "decimal" | "rational";
type DurableShape = {
  readonly array?: DurableShape;
  readonly dictionary?: DurableShape;
  readonly nullable?: DurableShape;
  readonly opaque?: true;
  readonly required?: Readonly<Record<string, DurableShape>>;
  readonly refine?: (value: string) => boolean;
  readonly scalar?: DurableScalar;
  readonly optional?: Readonly<Record<string, DurableShape>>;
  readonly tag?: string;
  readonly variants?: Readonly<Record<string, DurableShape>>;
};

const scalar: DurableShape = { scalar: "string" };
const booleanScalar: DurableShape = { scalar: "boolean" };
const bigintScalar: DurableShape = { scalar: "bigint" };
const decimalScalar: DurableShape = { scalar: "decimal" };
const rationalScalar: DurableShape = { scalar: "rational" };
function refinedString(refine: (value: string) => boolean): DurableShape {
  return { scalar: "string", refine };
}
const oneOf = (...values: readonly string[]): DurableShape => refinedString((value) => values.includes(value));
function validates(constructor: (value: string) => unknown): (value: string) => boolean {
  return (value) => {
    try { constructor(value); return true; } catch { return false; }
  };
}
const identifierScalar = refinedString(validates((value) => identifier(value)));
const localDateScalar = refinedString(validates(localDate));
const instantScalar = refinedString(validates(instant));
const versionScalar = refinedString(validates(semanticVersion));
const hashAlgorithmScalar = refinedString((value) => value === "sha256");
const canonicalVersionScalar = refinedString((value) => value === "rastrata-canonical-v1");
const hashDigestScalar = refinedString((value) => /^[0-9a-f]{64}$/.test(value));
const opaque: DurableShape = { opaque: true };
const array = (member: DurableShape): DurableShape => ({ array: member });
const dictionary = (member: DurableShape): DurableShape => ({ dictionary: member });
const nullable = (member: DurableShape): DurableShape => ({ nullable: member });
const record = (required: Readonly<Record<string, DurableShape>>, optional: Readonly<Record<string, DurableShape>> = {}): DurableShape => ({ required, optional });
const variant = (tag: string, variants: Readonly<Record<string, DurableShape>>): DurableShape => ({ tag, variants });
const hashShape = record({ algorithm: hashAlgorithmScalar, canonicalizationVersion: canonicalVersionScalar, digest: hashDigestScalar });
const evidenceShape = record({ id: identifierScalar, sourceSystem: scalar, sourceRecordId: scalar, observedAt: instantScalar, contentHash: hashShape });
const derivationShape = record({ id: identifierScalar, policyId: identifierScalar, policyVersion: versionScalar, algorithmVersion: versionScalar, inputHash: hashShape, actorId: identifierScalar, state: oneOf("proposed", "approved", "rejected", "applied"), recordedAt: instantScalar, evidence: array(evidenceShape) });
const quantityShape = record({ canonicalNumber: rationalScalar, commodityId: identifierScalar }, { sourceNumber: decimalScalar });
const bookValueShape = record({ amount: decimalScalar, functionalCommodityId: identifierScalar });
const priceShape = record({ unitRate: rationalScalar, baseCommodityId: identifierScalar, quoteCommodityId: identifierScalar });
const basisShape = record({ totalBasis: rationalScalar, basisCommodityId: identifierScalar }, { sourceTotalBasis: decimalScalar });
const postingShape = record({ id: identifierScalar, ordinal: bigintScalar, accountId: identifierScalar, units: quantityShape, bookValue: bookValueShape, dimensionMemberIds: array(identifierScalar) }, { transactionPrice: priceShape, costBasis: basisShape });
const journalShape = record({ id: identifierScalar, kind: oneOf("opening", "ordinary", "adjustment", "reversing", "closing"), bookId: identifierScalar, functionalCommodityId: identifierScalar, economicAt: instantScalar, accountingDate: localDateScalar, recordedAt: instantScalar, narration: scalar, postings: array(postingShape) }, { settledAt: instantScalar });
const applicationShape = record({ postingId: identifierScalar, scopeKey: scalar, policyId: identifierScalar, policyVersion: versionScalar });
const lotSelectionScalar = oneOf("specificIdentification", "fifo", "lifo", "hifo", "weightedAverage");
const policyScopeScalar = oneOf("account", "legalEntity", "jurisdictionPool");
const capabilityShape = record({ id: identifierScalar, method: lotSelectionScalar, scope: policyScopeScalar, status: oneOf("supported", "experimental", "unsupported"), implementationVersion: versionScalar, verificationEvidenceIds: array(identifierScalar) });
const policyShape = record({ id: identifierScalar, bookId: identifierScalar, version: versionScalar, validFrom: instantScalar, lotSelection: lotSelectionScalar, scope: policyScopeScalar, scopeKey: scalar, requiredDimensionIds: array(identifierScalar), implementationVersion: versionScalar, capability: capabilityShape }, { validTo: instantScalar });
const quantizationShape = record({ id: identifierScalar, version: versionScalar, bookId: identifierScalar, functionalCommodityId: identifierScalar, validFrom: localDateScalar, targetScale: bigintScalar, roundingMode: oneOf("halfEven", "halfAwayFromZero", "towardZero", "floor", "ceiling"), roundingAccountId: identifierScalar }, { validTo: localDateScalar });
const accountingCapabilityShape = record({ feature: oneOf("inventoryCost", "inventoryValueAdjustment", "provisionalInventory", "openItemSettlement", "accountingBasis", "monetaryClassification", "currencyRemeasurement", "allocationSchedule", "taxDetermination", "consolidation"), status: oneOf("supported", "experimental", "unsupported"), implementationVersion: versionScalar, verificationEvidenceIds: array(identifierScalar), admittedCombinations: array(record({}, { method: scalar, frequency: scalar, convention: scalar })) });
const consolidationValuationPolicyShape = record({ id: identifierScalar, version: versionScalar, validFrom: instantScalar, maximumHops: bigintScalar, allowInverseObservation: booleanScalar, preferDirectObservation: booleanScalar }, { validTo: instantScalar });
const accountingPolicyCore = { id: identifierScalar, version: versionScalar, bookId: identifierScalar, validFrom: instantScalar, algorithmVersion: versionScalar, quantizationPolicy: quantizationShape, capability: accountingCapabilityShape };
const accountingPolicyOptional = { validTo: instantScalar };
const accountingPolicyShape = variant("kind", {
  inventoryCost: record({ ...accountingPolicyCore, kind: scalar, method: oneOf("specificIdentification", "fifo", "lifo", "hifo", "weightedAverage"), pools: array(record({ id: identifierScalar, accountId: identifierScalar, contentHash: hashShape })), shortageTreatment: oneOf("reject", "provisionalNegative") }, { ...accountingPolicyOptional, provisionalBasisMethod: oneOf("lastReceiptCost", "movingAverage", "standardCost", "explicitRate"), provisionalRate: rationalScalar }),
  inventoryValueAdjustment: record({ ...accountingPolicyCore, kind: scalar, inventoryCostPolicyId: identifierScalar, inventoryCostPolicyVersion: versionScalar, allowedKinds: array(oneOf("directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal")), inventoryAccountId: identifierScalar, recognizedCostAccountId: identifierScalar, adjustmentAccountId: identifierScalar }, accountingPolicyOptional),
  accountingBasis: record({ ...accountingPolicyCore, kind: scalar, basis: oneOf("accrual", "cash"), rules: array(record({ id: identifierScalar, event: oneOf("recognition", "settlement", "creditApplication", "writeOff", "tax", "inventoryCost", "nonCash", "rounding"), treatment: oneOf("recognizeAtAccountingDate", "recognizeAtSettlement", "allocateBySettlementRatio", "carryThrough", "exclude"), contentHash: hashShape })) }, accountingPolicyOptional),
  monetaryClassification: record({ ...accountingPolicyCore, kind: scalar, rules: array(record({ id: identifierScalar, accountId: identifierScalar, classification: oneOf("monetary", "nonMonetary"), contentHash: hashShape })) }, accountingPolicyOptional),
  currencyRemeasurement: record({ ...accountingPolicyCore, kind: scalar, reversalRequired: booleanScalar, gainAccountId: identifierScalar, lossAccountId: identifierScalar }, accountingPolicyOptional),
  allocationSchedule: record({ ...accountingPolicyCore, kind: scalar, method: oneOf("straightLine", "decliningBalance", "unitsOfProduction"), frequency: oneOf("monthly", "quarterly", "annual", "eventDriven"), convention: oneOf("actualDays", "fullPeriod", "halfYear", "midMonth", "usageEvent"), allocationAccountId: identifierScalar, contraAccountId: identifierScalar }, { ...accountingPolicyOptional, decliningRate: rationalScalar, expectedUsage: rationalScalar, postingAlgorithm: oneOf("cumulative-posted-allocation-v1") }),
  taxDetermination: record({ ...accountingPolicyCore, kind: scalar, taxCode: scalar, jurisdiction: scalar, roundingLevel: oneOf("lineLevel", "documentLevel"), components: array(record({ id: identifierScalar, rate: rationalScalar, inclusion: oneOf("exclusive", "inclusive"), treatment: oneOf("outputTax", "inputTax", "reverseCharge", "withholding"), recoverability: oneOf("recoverable", "nonRecoverable", "partiallyRecoverable"), recoverableShare: rationalScalar, compoundOrdinal: bigintScalar, compoundsOn: array(identifierScalar), liabilityAccountId: identifierScalar, contentHash: hashShape }, { recoverableAccountId: identifierScalar, nonRecoverableAccountId: identifierScalar })) }, { ...accountingPolicyOptional, groupingAlgorithm: oneOf("structural-tax-groups-v1") }),
  consolidation: record({ ...accountingPolicyCore, kind: scalar, supportedMethods: array(oneOf("full", "equity", "jointOperationShare")), accountMappings: array(record({ id: identifierScalar, sourceAccountId: identifierScalar, targetAccountId: identifierScalar, validFrom: instantScalar, contentHash: hashShape }, { sourceBookId: identifierScalar, validTo: instantScalar })), translationRules: array(record({ id: identifierScalar, sourceAccountId: identifierScalar, targetAccountId: identifierScalar, validFrom: instantScalar, valuationPolicy: consolidationValuationPolicyShape, contentHash: hashShape }, { sourceBookId: identifierScalar, validTo: instantScalar })), valuationPolicy: consolidationValuationPolicyShape, translationAdjustmentAccountId: identifierScalar, parentAttributableEquityAccountId: identifierScalar, nonControllingInterestAccountId: identifierScalar }, accountingPolicyOptional),
});
const accountingPolicySnapshotShape = record({ policies: array(accountingPolicyShape), contentHash: hashShape });
const resolvedShape = record({ journal: journalShape, policyApplications: array(applicationShape), policySnapshotHash: hashShape, quantizationPolicy: quantizationShape, quantizationPolicySnapshotHash: hashShape, exactBookValues: array(rationalScalar), derivations: array(derivationShape) });
const accountShape = record({ id: identifierScalar, bookId: identifierScalar, code: scalar, name: scalar, role: oneOf("asset", "liability", "equity", "income", "expense", "gain", "unrealizedGain"), normalSide: oneOf("debit", "credit"), postingAllowed: booleanScalar, openedOn: localDateScalar, allowedCommodityIds: array(identifierScalar) }, { closedOn: localDateScalar, parentId: identifierScalar });
const dimensionShape = record({ id: identifierScalar, bookId: identifierScalar, code: scalar, name: scalar, openedOn: localDateScalar }, { closedOn: localDateScalar });
const memberShape = record({ id: identifierScalar, dimensionId: identifierScalar, code: scalar, name: scalar, openedOn: localDateScalar }, { closedOn: localDateScalar, parentId: identifierScalar });
const admissionShape = record({ bookId: identifierScalar, functionalCommodityId: identifierScalar, accounts: array(accountShape), dimensions: array(dimensionShape), dimensionMembers: array(memberShape), requiredDimensionIds: array(identifierScalar) }, { requiredDimensionIdsByPosting: dictionary(array(identifierScalar)) });
const periodShape = record({ id: identifierScalar, calendarId: identifierScalar, fiscalYear: bigintScalar, sequence: bigintScalar, label: scalar, kind: oneOf("regular", "adjustment"), startsOn: localDateScalar, endsOn: localDateScalar });
const lotShape = record({ id: identifierScalar, bookId: identifierScalar, commodityId: identifierScalar, acquiredAt: instantScalar, acquisitionQuantity: rationalScalar, acquisitionTotalBasis: rationalScalar, basisCommodityId: identifierScalar, evidenceIds: array(identifierScalar) });
const holdingShape = record({ id: identifierScalar, bookId: identifierScalar, lotId: identifierScalar, accountId: identifierScalar, commodityId: identifierScalar, basisCommodityId: identifierScalar, remainingQuantity: rationalScalar, remainingTotalBasis: rationalScalar, remainingValuationAllowance: rationalScalar, remainingCarryingAmount: rationalScalar });
const allocationShape = record({ id: identifierScalar, holdingId: identifierScalar, lotId: identifierScalar, allocatedQuantity: rationalScalar, allocatedTotalBasis: rationalScalar, allocatedValuationAllowance: rationalScalar, allocatedCarryingAmount: rationalScalar, derivation: derivationShape });
const bookedAllocationShape = record({ allocation: allocationShape, journalPostingId: identifierScalar, kind: oneOf("disposal", "transfer") });
const specificShape = record({ method: scalar, allocations: array(record({ holdingId: identifierScalar, quantity: rationalScalar })) });
const selectionShape = variant("method", { specificIdentification: specificShape, fifo: record({ method: scalar }), lifo: record({ method: scalar }), hifo: record({ method: scalar }), weightedAverage: record({ method: scalar }) });
const allocationIdentityShape = record({ holdingId: identifierScalar, allocationId: identifierScalar });
const destinationIdentityShape = record({ sourceHoldingId: identifierScalar, destinationHoldingId: identifierScalar });
const transferPolicyShape = record({ id: identifierScalar, version: versionScalar, bookId: identifierScalar, sourceAccountId: identifierScalar, destinationAccountId: identifierScalar, validFrom: instantScalar, treatment: oneOf("continuity", "disposalAndReacquisition") }, { validTo: instantScalar });
const lotOperationShape = variant("type", {
  acquire: record({ type: scalar, lot: lotShape, holding: holdingShape, journalPostingId: identifierScalar }),
  dispose: record({ type: scalar, holdingIds: array(identifierScalar), requestedQuantity: rationalScalar, selection: selectionShape, derivation: derivationShape, identities: array(allocationIdentityShape), journalPostingId: identifierScalar }),
  transfer: record({ type: scalar, sourceHoldingIds: array(identifierScalar), destinationAccountId: identifierScalar, requestedQuantity: rationalScalar, selection: selectionShape, policies: array(transferPolicyShape), governedAt: instantScalar, derivation: derivationShape, allocationIdentities: array(allocationIdentityShape), destinationIdentities: array(destinationIdentityShape), sourcePostingId: identifierScalar, destinationPostingId: identifierScalar }),
});
const inventoryLayerInputShape = record({ id: scalar, accountId: identifierScalar, acquiredAt: instantScalar, quantity: rationalScalar, totalBasis: rationalScalar });
const inventoryRequestShape = record({ policyId: identifierScalar, policyVersion: versionScalar, governedAt: instantScalar, quantity: rationalScalar, layers: array(inventoryLayerInputShape) }, { specificLayerIds: array(scalar) });
const recostSourceShape = record({ receiptId: scalar, quantity: rationalScalar, totalBasis: rationalScalar });
const recostRequestShape = record({ id: identifierScalar, layerId: identifierScalar, resolvedAt: instantScalar, sources: array(recostSourceShape), derivation: derivationShape });
const inventoryValueAdjustmentAllocationShape = record({ ordinal: bigintScalar, lotId: identifierScalar, remainingBasisChange: rationalScalar, recognizedCostChange: rationalScalar, remainingValuationAllowanceChange: rationalScalar }, { holdingId: identifierScalar });
const inventoryValueAdjustmentRequestShape = record({ id: identifierScalar, kind: oneOf("directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"), effectiveOn: localDateScalar, policyEffectiveAt: instantScalar, policyId: identifierScalar, policyVersion: versionScalar, generatedEffectKey: scalar, exactSourceAmount: rationalScalar, allocations: array(inventoryValueAdjustmentAllocationShape), evidence: array(evidenceShape), derivation: derivationShape });
const settlementScopeShape = record({ externalPartyId: scalar, controlAccountId: identifierScalar });
const canonicalPostingReferenceShape = record({ id: identifierScalar, bookId: identifierScalar, journalId: identifierScalar, postingId: identifierScalar, effectKey: scalar, postingContentHash: hashShape, contentHash: hashShape });
const openItemBodyShape = record({ id: identifierScalar, bookId: identifierScalar, kind: oneOf("receivable", "payable", "credit"), scope: settlementScopeShape, recognitionSource: canonicalPostingReferenceShape, recognizedOn: localDateScalar, denominationCommodityId: identifierScalar, denomination: rationalScalar, bookValue: rationalScalar, derivation: derivationShape });
const openItemRequestShape = record({ value: openItemBodyShape });
const settlementBodyShape = record({ id: identifierScalar, bookId: identifierScalar, kind: oneOf("cash", "creditApplication", "writeOff"), scope: settlementScopeShape, settlementSource: canonicalPostingReferenceShape, settledAt: instantScalar, denominationCommodityId: identifierScalar, denomination: rationalScalar, bookValue: rationalScalar, derivation: derivationShape });
const valuationPathShape = record({ fromCommodityId: identifierScalar, toCommodityId: identifierScalar, effectiveAt: instantScalar, observedAt: instantScalar, rate: rationalScalar, evidenceIds: array(identifierScalar) });
const quantizedValueShape = record({ amount: decimalScalar, residual: rationalScalar });
const ownershipCoordinateShape = record({ bookId: identifierScalar, holdingId: identifierScalar, lotId: identifierScalar, accountId: identifierScalar, unitsCommodityId: identifierScalar, functionalCommodityId: identifierScalar, dimensionMemberIds: array(identifierScalar) });
const ownershipReferenceShape = record({ id: identifierScalar, contentHash: hashShape, bookId: identifierScalar, effectKey: identifierScalar, artifactOrdinal: bigintScalar, bookRevision: bigintScalar });
const ownershipAnchorShape = record({ id: identifierScalar, algorithm: oneOf("cumulativePostedInventoryV1"), algorithmVersion: oneOf("1.0.0", "1.1.0"), quantity: rationalScalar, postedBudget: decimalScalar,
  effectKey: identifierScalar, artifactOrdinal: bigintScalar, bookRevision: bigintScalar, contentHash: hashShape, coordinate: ownershipCoordinateShape,
  inventoryPolicy: record({ policyId: identifierScalar, policyVersion: versionScalar, policyContentHash: hashShape }), quantizationPolicy: quantizationShape,
  sourcePostings: array(canonicalPostingReferenceShape), incomingMovements: array(ownershipReferenceShape), evidence: array(evidenceShape),
}, { predecessorPosition: ownershipReferenceShape, postedValue: record({ basis: decimalScalar, allowance: decimalScalar }) });
const ownershipPositionShape = record({ holdingId: identifierScalar, consumedQuantity: rationalScalar, consumedPosted: decimalScalar, contentHash: hashShape, anchor: ownershipReferenceShape,
  originMovementId: identifierScalar, originEffectKey: identifierScalar, originArtifactOrdinal: bigintScalar, originBookRevision: bigintScalar });
const cumulativePostedShareShape = record({ postedTotal: decimalScalar, beforeFraction: rationalScalar, afterFraction: rationalScalar, beforeTarget: rationalScalar, afterTarget: rationalScalar,
  beforeQuantization: quantizedValueShape, afterQuantization: quantizedValueShape, postedAmount: decimalScalar, policy: quantizationShape });
const ownershipMovementBodyShape = { id: identifierScalar, kind: oneOf("disposal", "transferOut"), effectKey: identifierScalar, artifactOrdinal: bigintScalar, bookRevision: bigintScalar,
  accountingDate: localDateScalar, fiscalPeriodId: identifierScalar, coordinate: ownershipCoordinateShape, postedAmount: decimalScalar, beforePosition: ownershipReferenceShape,
  afterPosition: ownershipPositionShape, quantityAllocation: allocationShape, reductionProof: cumulativePostedShareShape, incomingSources: array(ownershipReferenceShape), contentHash: hashShape };
const moneyReductionShape = record({ ...ownershipMovementBodyShape, monetaryKind: oneOf("journalLinked"), posting: canonicalPostingReferenceShape });
const quantityReductionShape = record({ ...ownershipMovementBodyShape, monetaryKind: oneOf("quantityOnly") });
const acquisitionMovementBodyShape = { id: identifierScalar, kind: oneOf("acquisition", "transferIn", "legacyAdoption"), effectKey: identifierScalar, artifactOrdinal: bigintScalar, bookRevision: bigintScalar,
  accountingDate: localDateScalar, fiscalPeriodId: identifierScalar, coordinate: ownershipCoordinateShape, postedAmount: decimalScalar,
  afterPosition: ownershipPositionShape, acquisitionProof: cumulativePostedShareShape, incomingSources: array(ownershipReferenceShape), contentHash: hashShape };
const moneyAcquisitionShape = record({ ...acquisitionMovementBodyShape, monetaryKind: oneOf("journalLinked"), posting: canonicalPostingReferenceShape });
const quantityAcquisitionShape = record({ ...acquisitionMovementBodyShape, monetaryKind: oneOf("quantityOnly") });
const ownershipArtifactShapes = Object.freeze({
  anchor: ownershipAnchorShape,
  position: ownershipPositionShape,
  reductionMovement: variant("monetaryKind", { journalLinked: moneyReductionShape, quantityOnly: quantityReductionShape }),
  acquisitionMovement: variant("monetaryKind", {
    journalLinked: moneyAcquisitionShape,
    quantityOnly: quantityAcquisitionShape,
  }),
  reductionEffect: record({ effectKey: identifierScalar, bookRevision: bigintScalar, contentHash: hashShape, newAnchors: array(ownershipAnchorShape),
    journalLinkedMovements: array(moneyReductionShape), quantityOnlyMovements: array(quantityReductionShape) }),
  ownershipEffect: record({ effectKey: identifierScalar, bookRevision: bigintScalar, contentHash: hashShape, newAnchors: array(ownershipAnchorShape),
    journalLinkedMovements: array(variant("kind", { acquisition: moneyAcquisitionShape, transferIn: moneyAcquisitionShape, disposal: moneyReductionShape, transferOut: moneyReductionShape })),
    quantityOnlyMovements: array(variant("kind", { acquisition: quantityAcquisitionShape, transferIn: quantityAcquisitionShape, legacyAdoption: quantityAcquisitionShape, disposal: quantityReductionShape, transferOut: quantityReductionShape })) }),
} satisfies Record<InventoryOwnershipArtifactKind, DurableShape>);
const settlementAllocationBodyShape = record({ id: identifierScalar, openItemId: identifierScalar, settlementId: identifierScalar, allocatedBookValue: rationalScalar, allocatedOpenQuantity: rationalScalar, allocatedSettlementQuantity: rationalScalar, derivation: derivationShape }, { appliedAt: instantScalar, realizedExchangeEffectKey: scalar, allocatedOpenItemBookValue: rationalScalar, allocatedSettlementBookValue: rationalScalar, settlementMeasurement: quantizedValueShape, realizedExchangeDifference: quantizedValueShape, valuationPath: valuationPathShape });
const settlementRequestShape = record({ settlement: settlementBodyShape, allocations: array(settlementAllocationBodyShape) }, { operation: oneOf("recognizeUnallocated", "allocateExisting"), appliedAt: instantScalar, realizedExchangePolicyId: identifierScalar, realizedExchangePolicyVersion: versionScalar, quantizationPolicy: quantizationShape });
const remeasurementRequestShape = record({ id: identifierScalar, policyId: identifierScalar, policyVersion: versionScalar, classificationPolicyId: identifierScalar, classificationPolicyVersion: versionScalar, governedAt: instantScalar, kind: oneOf("realized", "unrealized"), classification: oneOf("monetary", "nonMonetary"), source: canonicalPostingReferenceShape, effectiveOn: localDateScalar, denominationCommodityId: identifierScalar, denomination: rationalScalar, carryingBookValue: rationalScalar, valuationPath: valuationPathShape, positionAccountId: identifierScalar, derivation: derivationShape }, { sourcePostingId: identifierScalar, generatedEffectKey: scalar, reversalOf: identifierScalar, reversalId: identifierScalar });
const allocationScheduleRequestShape = record({ id: identifierScalar, policyId: identifierScalar, policyVersion: versionScalar, governedAt: instantScalar, source: canonicalPostingReferenceShape, sourceBasis: rationalScalar, residualValue: rationalScalar, startsOn: localDateScalar, endsOn: localDateScalar, derivation: derivationShape }, { usage: array(record({ date: localDateScalar, value: rationalScalar })) });
const allocationRecognitionRequestShape = record({ id: identifierScalar, scheduleId: identifierScalar, ordinal: bigintScalar, governedAt: instantScalar, derivation: derivationShape });
const allocationScheduleRevisionRequestShape = record({ id: identifierScalar, kind: oneOf("estimateChange", "impairment", "disposal", "termination"), effectiveOn: localDateScalar, policyEffectiveAt: instantScalar, originalScheduleId: identifierScalar, priorRecognitionIds: array(identifierScalar), policyId: identifierScalar, policyVersion: versionScalar, revisedResidualValue: rationalScalar, evidence: array(evidenceShape), derivation: derivationShape }, { generatedEffectKey: scalar, exactAdjustmentAmount: rationalScalar, successorScheduleId: identifierScalar, revisedEndsOn: localDateScalar, revisedUsage: array(record({ date: localDateScalar, value: rationalScalar })) });
const taxableLineShape = record({ lineId: scalar, sourcePostingId: identifierScalar, counterpartyPostingId: identifierScalar, policyId: identifierScalar, policyVersion: versionScalar, statedAmount: rationalScalar, amountIncludesTax: booleanScalar, sourceAccountId: identifierScalar, payableAccountId: identifierScalar });
const taxRequestShape = record({ id: identifierScalar, sourceTransactionId: identifierScalar, governedAt: instantScalar, direction: oneOf("purchase", "sale", "purchaseCredit", "saleCredit"), lines: array(taxableLineShape), derivation: derivationShape });
const consolidationValuationStepShape = record({ fromCommodityId: identifierScalar, toCommodityId: identifierScalar, rate: rationalScalar, observedAt: instantScalar, evidenceIds: array(scalar) });
const consolidationValuationPathShape = record({ id: scalar, effectiveAt: instantScalar, steps: array(consolidationValuationStepShape) });
const consolidationBalanceShape = record({ sourceAccountId: identifierScalar, unitsCommodityId: identifierScalar, classification: oneOf("asset", "liability", "equity", "income", "expense"), amount: rationalScalar, valuationPaths: array(consolidationValuationPathShape) });
const consolidationSourceShape = record({ bookId: identifierScalar, revision: bigintScalar, postingSequence: bigintScalar, populationHash: hashShape, expectedRevision: bigintScalar, expectedPostingSequence: bigintScalar, expectedPopulationHash: hashShape, relationshipId: scalar, relationshipValidFrom: instantScalar, control: oneOf("controlled", "jointlyControlled", "significantInfluence"), method: oneOf("full", "equity", "jointOperationShare"), ownershipShare: rationalScalar, votingShare: rationalScalar, controlEvidenceIds: array(scalar), balances: array(consolidationBalanceShape) }, { relationshipValidTo: instantScalar, nonControllingInterestMethod: oneOf("proportionateNetAssets", "fairValue"), nonControllingInterestFairValue: rationalScalar });
const consolidationRequestShape = record({ id: identifierScalar, policyId: identifierScalar, policyVersion: versionScalar, governedAt: instantScalar, throughOn: localDateScalar, targetBookId: identifierScalar, sources: array(consolidationSourceShape), eliminations: array(record({ id: scalar, sourceBookId: identifierScalar, sourceAccountId: identifierScalar, targetAccountId: identifierScalar, amount: rationalScalar, evidenceIds: array(scalar), sourcePostingIds: array(identifierScalar) })), derivation: derivationShape });
const commandCore = { id: identifierScalar, type: scalar, protocolVersion: versionScalar, bookId: identifierScalar, expectedBookRevision: bigintScalar, issuedAt: instantScalar, completedAt: instantScalar, committedAt: instantScalar, actorId: identifierScalar, inputHash: hashShape };
const generatedDimensionSelectionShape = record({ effectKey: scalar, postingOrdinal: bigintScalar, dimensionMemberIds: array(identifierScalar) });
const generatedCommandOptional = { fiscalPeriodId: identifierScalar, generatedPostingDimensionSelections: array(generatedDimensionSelectionShape) };
const ownedPolicyReferenceShape = record({ policyId: identifierScalar, policyVersion: versionScalar, policyContentHash: hashShape });
const ownedCoordinateInputShape = record({ accountId: identifierScalar, unitsCommodityId: identifierScalar, dimensionMemberIds: array(identifierScalar), bookingPolicy: ownedPolicyReferenceShape });
const ownedPostingLinkShape = record({ journalOrdinal: bigintScalar, postingId: identifierScalar, referenceId: identifierScalar });
const transferIdentityShape = record({ holdingId: identifierScalar, allocationId: identifierScalar, transferOutMovementId: identifierScalar, destinationAnchorId: identifierScalar, destinationMovementId: identifierScalar, destinationHoldingId: identifierScalar, destinationLotId: identifierScalar, evidence: array(evidenceShape) });
const adoptEntryShape = record({ holdingId: identifierScalar, anchorId: identifierScalar, movementId: identifierScalar, evidence: array(evidenceShape), historicalPostings: array(canonicalPostingReferenceShape) });
const ownedOperationCore = { ordinal: bigintScalar, id: identifierScalar, coordinate: ownedCoordinateInputShape, inventoryPolicy: ownedPolicyReferenceShape, derivation: derivationShape };
const ownedOperationShape = variant("kind", {
  acquisition: record({ ...ownedOperationCore, kind: scalar, entries: array(record({ anchorId: identifierScalar, movementId: identifierScalar, lot: lotShape, holding: holdingShape, evidence: array(evidenceShape) })) }, { postingLink: ownedPostingLinkShape }),
  issue: record({ ...ownedOperationCore, kind: scalar, quantity: rationalScalar, identities: array(record({ holdingId: identifierScalar, allocationId: identifierScalar, movementId: identifierScalar })) }, { postingLink: ownedPostingLinkShape, specificHoldingIds: array(identifierScalar) }),
  transfer: record({ ...ownedOperationCore, kind: scalar, quantity: rationalScalar, destinationCoordinate: ownedCoordinateInputShape, destinationInventoryPolicy: ownedPolicyReferenceShape, entries: array(transferIdentityShape) }, { postingLink: ownedPostingLinkShape, destinationPostingLink: ownedPostingLinkShape, specificHoldingIds: array(identifierScalar) }),
  adopt: record({ ...ownedOperationCore, kind: scalar, entries: array(adoptEntryShape), postedBalance: rationalScalar }, { postingLink: ownedPostingLinkShape }),
});
const ownedInventoryRequestShape = record({ algorithm: scalar, algorithmVersion: versionScalar, accountingDate: localDateScalar, governedAt: instantScalar, fiscalPeriodId: identifierScalar, operations: array(ownedOperationShape), resolvedJournals: array(resolvedShape) });
const commandShape = variant("type", {
  postOwnedInventoryTransaction: record({ ...commandCore, request: ownedInventoryRequestShape }),
  activateBook: record({ ...commandCore, mode: oneOf("newZeroBalance", "migration"), boundaryId: identifierScalar, firstAccountingDate: localDateScalar }, { opening: resolvedShape, lotOperations: array(lotOperationShape) }),
  postJournal: record({ ...commandCore, resolved: resolvedShape }, { fiscalPeriodId: identifierScalar, lotOperations: array(lotOperationShape) }),
  correctJournal: record({ ...commandCore, correctionKind: oneOf("reversal", "supersession"), originalJournalId: identifierScalar, resolved: resolvedShape }, { fiscalPeriodId: identifierScalar, lotOperations: array(lotOperationShape) }),
  closePeriod: record({ ...commandCore, periodId: identifierScalar, closePackageId: identifierScalar, reason: scalar, reportPopulationHash: hashShape, reportingPolicySnapshotHash: hashShape }, { closing: resolvedShape }),
  reopenPeriod: record({ ...commandCore, periodId: identifierScalar, reason: scalar }, { reversal: resolvedShape }),
  replaceConfiguration: record({ ...commandCore, expectedConfigurationRevision: bigintScalar, effectiveOn: localDateScalar, periods: array(periodShape), admissionSnapshot: admissionShape, policies: array(policyShape), quantizationPolicies: array(quantizationShape), accountingPolicies: array(accountingPolicyShape) }, { executionProfileAdoption: record({ from: scalar, to: scalar, expectedConfigurationHash: hashShape, reason: scalar, evidenceIds: array(identifierScalar) }) }),
  postInventoryTransaction: record({ ...commandCore, request: inventoryRequestShape, inventoryAccountId: identifierScalar, costAccountId: identifierScalar, inventoryCommodityId: identifierScalar, derivation: derivationShape }, { ...generatedCommandOptional, provisionalLayerId: identifierScalar, lotOperations: array(lotOperationShape) }),
  recostProvisionalInventory: record({ ...commandCore, request: recostRequestShape, inventoryAccountId: identifierScalar, adjustmentAccountId: identifierScalar }, generatedCommandOptional),
  adjustInventoryValue: record({ ...commandCore, request: inventoryValueAdjustmentRequestShape }, generatedCommandOptional),
  recognizeOpenItem: record({ ...commandCore, request: openItemRequestShape, resolved: resolvedShape }, generatedCommandOptional),
  applySettlement: record({ ...commandCore, request: settlementRequestShape, resolved: array(resolvedShape) }, generatedCommandOptional),
  postCurrencyRemeasurement: record({ ...commandCore, request: remeasurementRequestShape }, generatedCommandOptional),
  createAllocationSchedule: record({ ...commandCore, request: allocationScheduleRequestShape }, generatedCommandOptional),
  recognizeScheduledAllocation: record({ ...commandCore, request: allocationRecognitionRequestShape }, generatedCommandOptional),
  reviseAllocationSchedule: record({ ...commandCore, request: allocationScheduleRevisionRequestShape }, { ...generatedCommandOptional, disposalJournal: resolvedShape }),
  postTaxedTransaction: record({ ...commandCore, request: taxRequestShape }, generatedCommandOptional),
  compileConsolidation: record({ ...commandCore, request: consolidationRequestShape }, generatedCommandOptional),
});
const configurationSnapshotShape = record({ revision: bigintScalar, effectiveAt: instantScalar, periods: array(periodShape), admissionSnapshot: admissionShape, policies: array(policyShape), quantizationPolicies: array(quantizationShape), accountingPolicySnapshot: accountingPolicySnapshotShape, contentHash: hashShape }, { executionProfile: oneOf(STRUCTURAL_SOURCE_IDENTITY_PROFILE), stateCommitmentProfile: oneOf(CHAIN_HEAD_STATE_COMMITMENT_PROFILE) });
const boundaryShape = record({ id: identifierScalar, firstAccountingDate: localDateScalar, activatedAt: instantScalar, configurationSnapshot: configurationSnapshotShape, contentHash: hashShape }, { openingJournalId: identifierScalar });
const bookedJournalShape = record({ journal: journalShape, commandId: identifierScalar, effectKey: scalar, bookRevision: bigintScalar, postingSequence: bigintScalar, fiscalPeriodId: identifierScalar, policySnapshotHash: hashShape, quantizationPolicySnapshotHash: hashShape, canonicalHash: hashShape, derivations: array(derivationShape) });
const lotStateShape = record({ lots: array(lotShape), holdings: array(holdingShape), allocations: array(bookedAllocationShape), contentHash: hashShape });
const correctionShape = record({ kind: oneOf("reversal", "supersession"), originalJournalId: identifierScalar, correctionJournalId: identifierScalar });
const transitionShape = record({ periodId: identifierScalar, kind: oneOf("close", "reopen"), reason: scalar, bookRevision: bigintScalar, recordedAt: instantScalar, supersededCloseIds: array(identifierScalar), contentHash: hashShape });
const closeShape = record({ id: identifierScalar, periodId: identifierScalar, cycle: bigintScalar, throughBookRevision: bigintScalar, throughPostingSequence: bigintScalar, ledgerHash: hashShape, chartHash: hashShape, bookingPolicySnapshotHash: hashShape, quantizationPolicySnapshotHash: hashShape, reportPopulationHash: hashShape, reportingPolicySnapshotHash: hashShape, configurationRevision: bigintScalar, configurationSnapshotHash: hashShape, configurationSnapshot: configurationSnapshotShape, bookStateSnapshotHash: hashShape, contentHash: hashShape }, { closingJournalId: identifierScalar });
const provisionalLayerShape = record({ id: identifierScalar, bookId: identifierScalar, policyId: identifierScalar, policy: accountingPolicyShape, issueSource: canonicalPostingReferenceShape, openedAt: instantScalar, quantity: rationalScalar, provisionalBasis: rationalScalar, derivation: derivationShape, contentHash: hashShape });
const recostingShape = record({ id: identifierScalar, layerId: identifierScalar, resolvedAt: instantScalar, sources: array(recostSourceShape), adjustment: rationalScalar, derivation: derivationShape, contentHash: hashShape });
const inventoryValueAdjustmentShape = record({ id: identifierScalar, kind: oneOf("directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"), effectiveOn: localDateScalar, generatedEffectKey: scalar, bookId: identifierScalar, policy: accountingPolicyShape, exactSourceAmount: rationalScalar, allocations: array(inventoryValueAdjustmentAllocationShape), bookedAdjustment: record({ amount: decimalScalar, residual: rationalScalar }), evidence: array(evidenceShape), derivation: derivationShape, contentHash: hashShape });
const openItemShape = record({ id: identifierScalar, bookId: identifierScalar, kind: oneOf("receivable", "payable", "credit"), scope: settlementScopeShape, recognitionSource: canonicalPostingReferenceShape, recognizedOn: localDateScalar, denominationCommodityId: identifierScalar, denomination: rationalScalar, bookValue: rationalScalar, derivation: derivationShape, contentHash: hashShape });
const settlementShape = record({ id: identifierScalar, bookId: identifierScalar, kind: oneOf("cash", "creditApplication", "writeOff"), scope: settlementScopeShape, settlementSource: canonicalPostingReferenceShape, settledAt: instantScalar, denominationCommodityId: identifierScalar, denomination: rationalScalar, bookValue: rationalScalar, derivation: derivationShape, contentHash: hashShape });
const settlementAllocationShape = record({ id: identifierScalar, openItemId: identifierScalar, settlementId: identifierScalar, allocatedBookValue: rationalScalar, allocatedOpenQuantity: rationalScalar, allocatedSettlementQuantity: rationalScalar, derivation: derivationShape, contentHash: hashShape }, { appliedAt: instantScalar, realizedExchangeEffectKey: scalar, allocatedOpenItemBookValue: rationalScalar, allocatedSettlementBookValue: rationalScalar, settlementMeasurement: quantizedValueShape, realizedExchangeDifference: quantizedValueShape, valuationPath: valuationPathShape });
const remeasurementResultShape = record({ id: identifierScalar, kind: oneOf("realized", "unrealized"), effectiveOn: localDateScalar, carryingBookValue: rationalScalar, measuredBookValue: rationalScalar, difference: rationalScalar, valuationRate: rationalScalar, policyId: identifierScalar, policy: accountingPolicyShape, classificationPolicy: accountingPolicyShape, valuationPath: valuationPathShape, positionAccountId: identifierScalar, denominationCommodityId: identifierScalar, derivation: derivationShape, contentHash: hashShape }, { sourcePostingId: identifierScalar, source: canonicalPostingReferenceShape, adjustmentEffectKey: scalar });
const remeasurementReversalShape = record({ id: identifierScalar, originalResultId: identifierScalar, originalJournalId: identifierScalar, reversedOn: localDateScalar, derivation: derivationShape, contentHash: hashShape }, { originalEffectKey: scalar });
const installmentShape = record({ ordinal: bigintScalar, accountingDate: localDateScalar, amount: rationalScalar });
const allocationPostingPlanShape = record({
  algorithmVersion: oneOf("cumulative-posted-allocation-v1"), exactSourceBasis: rationalScalar,
  exactResidualValue: rationalScalar, postedSourceBasis: decimalScalar,
  residualQuantization: record({ amount: decimalScalar, residual: rationalScalar }),
  quantizationPolicy: quantizationShape, contentHash: hashShape,
  installments: array(record({ ordinal: bigintScalar, accountingDate: localDateScalar,
    exactAmount: rationalScalar, cumulativeTarget: rationalScalar,
    cumulativeQuantization: record({ amount: decimalScalar, residual: rationalScalar }),
    postedAmount: decimalScalar, exactToPostedDifference: rationalScalar })),
});
const allocationScheduleShape = record({ id: identifierScalar, bookId: identifierScalar, policyId: identifierScalar, policy: accountingPolicyShape, source: canonicalPostingReferenceShape, sourceBasis: rationalScalar, residualValue: rationalScalar, installments: array(installmentShape), derivation: derivationShape, contentHash: hashShape }, { postingPlan: allocationPostingPlanShape });
const allocationRecognitionShape = record({ id: identifierScalar, scheduleId: identifierScalar, ordinal: bigintScalar, derivation: derivationShape, contentHash: hashShape });
const allocationScheduleRevisionShape = record({ id: identifierScalar, kind: oneOf("estimateChange", "impairment", "disposal", "termination"), effectiveOn: localDateScalar, originalScheduleId: identifierScalar, priorRecognitionIds: array(identifierScalar), recognizedToDate: rationalScalar, carryingAmountAtRevision: rationalScalar, revisedResidualValue: rationalScalar, policy: accountingPolicyShape, evidence: array(evidenceShape), derivation: derivationShape, contentHash: hashShape }, { generatedEffectKey: scalar, exactAdjustmentAmount: rationalScalar, bookedAdjustment: record({ amount: decimalScalar, residual: rationalScalar }), successorScheduleId: identifierScalar, postedRecognizedToDate: rationalScalar, postedCarryingAmountAtRevision: rationalScalar });
const taxComponentResultShape = record({ policyId: identifierScalar, exactTax: rationalScalar, quantization: record({ amount: decimalScalar, residual: rationalScalar }), recoverable: rationalScalar, nonRecoverable: rationalScalar });
const taxDeterminationShape = record({ id: identifierScalar, bookId: identifierScalar, taxPoint: instantScalar, sourceTransactionId: identifierScalar, direction: oneOf("purchase", "sale", "purchaseCredit", "saleCredit"), lines: array(record({ lineId: scalar, policyId: identifierScalar, exclusiveBasis: rationalScalar, components: array(taxComponentResultShape) })), derivation: derivationShape, contentHash: hashShape });
const consolidationCompilationShape = record({ id: identifierScalar, bookId: identifierScalar, policyId: identifierScalar, throughOn: localDateScalar, sourcePopulationHashes: array(hashShape), derivation: derivationShape, contentHash: hashShape });
const effectShape = variant("type", {
  inventoryOwnership: record({ type: scalar, value: ownershipArtifactShapes.ownershipEffect }),
  activation: record({ type: scalar, boundary: boundaryShape, financialIdentityHash: hashShape, configurationHash: hashShape, configurationSnapshot: configurationSnapshotShape }),
  configuration: record({ type: scalar, expectedConfigurationRevision: bigintScalar, nextConfigurationRevision: bigintScalar, previousConfigurationHash: hashShape, effectiveOn: localDateScalar, periods: array(periodShape), admissionSnapshot: admissionShape, policies: array(policyShape), quantizationPolicies: array(quantizationShape), accountingPolicySnapshot: accountingPolicySnapshotShape, previousConfigurationSnapshot: configurationSnapshotShape, resultingConfigurationSnapshot: configurationSnapshotShape, contentHash: hashShape }),
  journal: record({ type: scalar, booked: bookedJournalShape }),
  lotState: record({ type: scalar, lotState: lotStateShape }),
  lotChanges: record({ type: scalar, changes: record({ lots: array(lotShape), holdings: array(holdingShape), contentHash: hashShape }) }),
  correction: record({ type: scalar, link: correctionShape }),
  periodTransition: record({ type: scalar, transition: transitionShape }),
  closePackage: record({ type: scalar, closePackage: closeShape }),
  provisionalInventoryLayer: record({ type: scalar, value: provisionalLayerShape }),
  inventoryRecosting: record({ type: scalar, value: recostingShape }),
  inventoryValueAdjustment: record({ type: scalar, value: inventoryValueAdjustmentShape }),
  openItem: record({ type: scalar, value: openItemShape }),
  settlement: record({ type: scalar, value: settlementShape }),
  settlementAllocation: record({ type: scalar, value: settlementAllocationShape }),
  remeasurementResult: record({ type: scalar, value: remeasurementResultShape }),
  remeasurementReversal: record({ type: scalar, value: remeasurementReversalShape }),
  allocationSchedule: record({ type: scalar, value: allocationScheduleShape }),
  allocationRecognition: record({ type: scalar, value: allocationRecognitionShape }),
  allocationScheduleRevision: record({ type: scalar, value: allocationScheduleRevisionShape }),
  taxDetermination: record({ type: scalar, value: taxDeterminationShape }),
  consolidationCompilation: record({ type: scalar, value: consolidationCompilationShape }),
});
const revisionShape = record({ bookId: identifierScalar, bookRevision: bigintScalar, previousHash: nullable(hashShape), effectsHash: hashShape, chainHash: hashShape, committedAt: instantScalar, command: commandShape, effects: array(effectShape) });
const identityShape = record({ bookId: identifierScalar, code: scalar, ownerId: identifierScalar, ownerKind: oneOf("legalEntity", "entityGroup"), kind: oneOf("operational", "tax", "consolidation"), functionalCommodityId: identifierScalar, primaryBasis: oneOf("accrual", "cash"), fiscalCalendarId: identifierScalar, accountingTimeZone: scalar });
const stateHeaderShape = record({
  identity: identityShape, financialIdentityHash: hashShape,
  status: oneOf("configuring", "open", "closed", "archived"),
  bookRevision: bigintScalar, latestPostingSequence: bigintScalar,
  configurationRevision: bigintScalar, configurationHash: hashShape,
} satisfies Record<keyof BookStateHeader, DurableShape>);
const accountingStateShape = record({ provisionalInventoryLayers: array(provisionalLayerShape), inventoryRecostings: array(recostingShape), inventoryValueAdjustments: array(inventoryValueAdjustmentShape), openItems: array(openItemShape), settlements: array(settlementShape), settlementAllocations: array(settlementAllocationShape), remeasurementResults: array(remeasurementResultShape), remeasurementReversals: array(remeasurementReversalShape), allocationSchedules: array(allocationScheduleShape), allocationRecognitions: array(allocationRecognitionShape), allocationScheduleRevisions: array(allocationScheduleRevisionShape), taxDeterminations: array(taxDeterminationShape), consolidationCompilations: array(consolidationCompilationShape) });
const stateShape = record({ identity: identityShape, financialIdentityHash: hashShape, contentHash: hashShape, status: oneOf("configuring", "open", "closed", "archived"), bookRevision: bigintScalar, latestPostingSequence: bigintScalar, configurationRevision: bigintScalar, configurationHash: hashShape, configurationSnapshots: array(configurationSnapshotShape), activeConfigurationSnapshot: configurationSnapshotShape, periods: array(periodShape), admissionSnapshot: admissionShape, policies: array(policyShape), quantizationPolicies: array(quantizationShape), accountingPolicySnapshot: accountingPolicySnapshotShape, accountingState: accountingStateShape, lots: array(lotShape), lotHoldings: array(holdingShape), lotAllocations: array(bookedAllocationShape), journals: array(bookedJournalShape), corrections: array(correctionShape), periodTransitions: array(transitionShape), closePackages: array(closeShape), revisions: array(revisionShape) }, { openingBoundary: boundaryShape, inventoryOwnershipEffects: array(ownershipArtifactShapes.ownershipEffect) });
const diagnosticShape = record({ code: scalar, path: scalar, message: scalar, requirementIds: array(scalar) });
const originalResultShape = record({ disposition: oneOf("committed", "rejected"), observedBookRevision: bigintScalar, resultHash: hashShape, diagnostics: array(diagnosticShape), completedAt: instantScalar }, { committedAt: instantScalar });
const outcomeShape = record({ command: commandShape, originalResult: originalResultShape, revision: nullable(revisionShape) });
const retainedShape = record({ command: commandShape, commandId: identifierScalar, inputHash: hashShape, outcome: oneOf("committed", "rejected"), observedBookRevision: bigintScalar, resultHash: hashShape, completedAt: instantScalar, diagnostics: array(diagnosticShape) }, { commitIntentHash: hashShape });
const aggregateShape = record({ state: stateShape, protocol: record({ retainedResults: array(retainedShape) }) });

const rowShapes = Object.freeze({
  "state.configurationSnapshots": configurationSnapshotShape,
  "state.openingBoundary": boundaryShape,
  "state.lots": lotShape,
  "state.lotHoldings": holdingShape,
  "state.lotAllocations": bookedAllocationShape,
  "state.journals": bookedJournalShape,
  "state.corrections": correctionShape,
  "state.periodTransitions": transitionShape,
  "state.closePackages": closeShape,
  "state.revisions": revisionShape,
  "state.accountingState.provisionalInventoryLayers": provisionalLayerShape,
  "state.accountingState.inventoryRecostings": recostingShape,
  "state.accountingState.inventoryValueAdjustments": inventoryValueAdjustmentShape,
  "state.accountingState.openItems": openItemShape,
  "state.accountingState.settlements": settlementShape,
  "state.accountingState.settlementAllocations": settlementAllocationShape,
  "state.accountingState.remeasurementResults": remeasurementResultShape,
  "state.accountingState.remeasurementReversals": remeasurementReversalShape,
  "state.accountingState.allocationSchedules": allocationScheduleShape,
  "state.accountingState.allocationRecognitions": allocationRecognitionShape,
  "state.accountingState.allocationScheduleRevisions": allocationScheduleRevisionShape,
  "state.accountingState.taxDeterminations": taxDeterminationShape,
  "state.accountingState.consolidationCompilations": consolidationCompilationShape,
  "protocol.retainedResults": retainedShape,
} satisfies Record<BookRowCollection, DurableShape>);
// Prevent a row key from accidentally using another valid collection's schema.
// The aggregate codec remains the single schema authority for these subtrees.
for (const [collection, expected] of Object.entries(rowShapes)) {
  let shape: DurableShape | undefined = aggregateShape;
  for (const part of collection.split(".")) shape = shape?.required?.[part] ?? shape?.optional?.[part];
  if ((shape?.array ?? shape) !== expected) throw new Error(`Durable row schema diverges from aggregate: ${collection}`);
}
export const BOOK_ROW_COLLECTIONS: readonly BookRowCollection[] = Object.freeze(Object.keys(rowShapes) as BookRowCollection[]);

export function isBookRowCollection(value: unknown): value is BookRowCollection {
  return typeof value === "string" && Object.hasOwn(rowShapes, value);
}

/** Exact closed scalar encoding only. Collections, current-configuration aliases,
 * opening boundary and source authenticity must be established separately by the
 * complete indexed catalog/evaluator. This is not a sparse legacy BookState. */
export function encodeBookStateHeader(header: BookStateHeader): string {
  inspectShape(header, stateHeaderShape, "stateHeader");
  for (const counter of [header.bookRevision, header.latestPostingSequence, header.configurationRevision]) {
    if (counter < 0n || counter.toString().length > 64) throw new RangeError("State header counter is outside the canonical range");
  }
  if (header.configurationRevision > header.bookRevision || !contentHashEquals(hashFinancialIdentity(header.identity), header.financialIdentityHash))
    throw new TypeError("State header identity or configuration revision is inconsistent");
  const encoded = JSON.stringify(encodeNode(header, new WeakSet<object>(), 0));
  if (new TextEncoder().encode(encoded).byteLength > 65_536) throw new RangeError("State header exceeds the byte limit");
  return encoded;
}

export function decodeBookStateHeader(encoded: string): BookStateHeaderDecodeResult {
  try {
    if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > 65_536) throw new RangeError("State header exceeds the byte limit");
    const header = decodeNode(JSON.parse(encoded), 0) as BookStateHeader;
    if (encodeBookStateHeader(header) !== encoded) throw new TypeError("State header encoding is not canonical");
    deepFreeze(header);
    return Object.freeze({ disposition: "decoded", header });
  } catch (error) {
    return Object.freeze({ disposition: "rejected", message: error instanceof Error ? error.message : "Unknown state header decode failure" });
  }
}

/** Trusted typed encoding of a canonical durable subtree. No new monetary or
 * object encoding and no outer envelope: the enclosing row commitment binds it. */
export function encodeBookRow<C extends BookRowCollection>(collection: C, row: BookRowTypes[C]): string {
  if (!isBookRowCollection(collection)) throw new TypeError("Unknown durable book row collection");
  inspectShape(row, rowShapes[collection], collection);
  const encoded = JSON.stringify(encodeNode(row, new WeakSet<object>(), 0));
  if (new TextEncoder().encode(encoded).byteLength > MAX_DURABLE_BYTES) throw new RangeError("Durable row exceeds the byte limit");
  return encoded;
}

/** Shape and canonical-byte decoding only, NOT source authentication, standalone
 * content-hash validation, cross-row closure, or accounting admission. Callers
 * must authenticate collection/ordinal/bytes under an owner-issued pinned view. */
export function decodeBookRow<C extends BookRowCollection>(collection: C, encoded: string): BookRowDecodeResult<C> {
  try {
    if (!isBookRowCollection(collection)) throw new TypeError("Unknown durable book row collection");
    if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > MAX_DURABLE_BYTES) throw new RangeError("Durable row exceeds the byte limit");
    const row = decodeNode(JSON.parse(encoded), 0);
    inspectShape(row, rowShapes[collection], collection);
    if (JSON.stringify(encodeNode(row, new WeakSet<object>(), 0)) !== encoded) throw new TypeError("Durable row encoding is not canonical");
    deepFreeze(row);
    return Object.freeze({ disposition: "decoded", collection, row: row as BookRowTypes[C] });
  } catch (error) {
    return Object.freeze({ disposition: "rejected", message: error instanceof Error ? error.message : "Unknown durable row decode failure" });
  }
}

function inspectShape(value: unknown, shape: DurableShape, path: string): void {
  if (shape.scalar !== undefined) {
    const matches = shape.scalar === "string" ? typeof value === "string"
      : shape.scalar === "boolean" ? typeof value === "boolean"
      : shape.scalar === "bigint" ? typeof value === "bigint"
      : shape.scalar === "bytes" ? value instanceof Uint8Array
      : shape.scalar === "decimal" ? value instanceof ExactDecimal
      : value instanceof ExactRational;
    if (matches && (shape.refine === undefined || typeof value === "string" && shape.refine(value))) return;
    throw new TypeError(`${path} must be a durable ${shape.scalar}`);
  }
  if (shape.opaque === true) return;
  if (shape.nullable !== undefined) {
    if (value !== null) inspectShape(value, shape.nullable, path);
    return;
  }
  if (shape.array !== undefined) {
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
    for (let index = 0; index < value.length; index += 1) inspectShape(value[index], shape.array, `${path}[${index}]`);
    return;
  }
  if (shape.dictionary !== undefined) {
    if (!isRecord(value)) throw new TypeError(`${path} must be a record`);
    for (const [key, member] of Object.entries(value)) inspectShape(member, shape.dictionary, `${path}.${key}`);
    return;
  }
  if (!isRecord(value)) throw new TypeError(`${path} must be a record`);
  if (shape.tag !== undefined && shape.variants !== undefined) {
    const choice = value[shape.tag];
    if (typeof choice !== "string" || !Object.hasOwn(shape.variants, choice)) throw new TypeError(`${path}.${shape.tag} is not admitted`);
    inspectShape(value, shape.variants[choice]!, path);
    return;
  }
  const required = shape.required ?? {};
  const optional = shape.optional ?? {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) throw new TypeError(`${path}.${key} is not admitted by durable schema ${DURABLE_BOOK_CODEC_VERSION}`);
  }
  for (const [key, child] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required by durable schema ${DURABLE_BOOK_CODEC_VERSION}`);
    inspectShape(value[key], child, `${path}.${key}`);
  }
  for (const [key, child] of Object.entries(optional)) {
    if (Object.hasOwn(value, key)) inspectShape(value[key], child, `${path}.${key}`);
  }
}

function inspectAggregate(value: unknown): asserts value is DurableBookAggregate {
  inspectShape(value, aggregateShape, "aggregate");
}

/** Validate the durable command schema after the service has bounded and copied
 * input. This is not a raw-input parser, canonical-hash check, or accounting admission. */
export function assertBookCommandShape(command: BookCommand): void {
  inspectShape(command, commandShape, "command");
}

function hashValue(hash: ContentHash): { readonly algorithm: string; readonly canonicalizationVersion: string; readonly digest: string } {
  return { algorithm: hash.algorithm, canonicalizationVersion: hash.canonicalizationVersion, digest: hash.digest };
}

export function encodeDurableBook(aggregate: DurableBookAggregate): string {
  const body = encodeNode(aggregate, new WeakSet<object>(), 0);
  const payload = JSON.stringify(body);
  const checksum = hashCanonical({ type: DURABLE_BOOK_CODEC_VERSION, payload });
  const encoded = JSON.stringify({ version: DURABLE_BOOK_CODEC_VERSION, checksum: hashValue(checksum), body });
  if (new TextEncoder().encode(encoded).byteLength > MAX_DURABLE_BYTES) throw new RangeError("Durable aggregate exceeds the byte limit");
  return encoded;
}

export function decodeDurableBook(encoded: string): DurableDecodeResult {
  try {
    if (new TextEncoder().encode(encoded).byteLength > MAX_DURABLE_BYTES) throw new RangeError("Durable aggregate exceeds the byte limit");
    const envelope: unknown = JSON.parse(encoded);
    if (!isRecord(envelope) || envelope.version !== DURABLE_BOOK_CODEC_VERSION || !isRecord(envelope.checksum) || !("body" in envelope)) {
      throw new TypeError("Unsupported durable aggregate envelope");
    }
    inspectShape(envelope, record({ version: scalar, checksum: hashShape, body: opaque }), "envelope");
    const payload = JSON.stringify(envelope.body);
    const expected = hashCanonical({ type: DURABLE_BOOK_CODEC_VERSION, payload });
    const supplied = envelope.checksum as unknown as ContentHash;
    if (!contentHashEquals(expected, supplied)) throw new TypeError("Durable aggregate checksum does not match its content");
    const decoded = decodeNode(envelope.body, 0);
    inspectAggregate(decoded);
    const aggregate = decoded;
    const diagnostics = validateBookState(aggregate.state);
    if (diagnostics.length > 0) throw new TypeError(diagnostics.map((item) => item.message).join("; "));
    const protocolDiagnostics = validateBookProtocol(aggregate.state, aggregate.protocol);
    if (protocolDiagnostics.length > 0) throw new TypeError(protocolDiagnostics.map((item) => item.message).join("; "));
    deepFreeze(aggregate);
    // validateBookState recomputed every snapshot hash and the aggregate is now immutable: later
    // admissions need not recompute them (see verified-snapshots.ts).
    markVerifiedSnapshot(aggregate.state.activeConfigurationSnapshot);
    for (const snapshot of aggregate.state.configurationSnapshots) markVerifiedSnapshot(snapshot);
    return Object.freeze({ disposition: "decoded", aggregate });
  } catch (error) {
    return Object.freeze({ disposition: "rejected", message: error instanceof Error ? error.message : "Unknown durable decode failure" });
  }
}

function inspectOutcome(value: unknown): asserts value is BookOutcomePayload {
  inspectShape(value, outcomeShape, "outcome");
  const payload = value as BookOutcomePayload;
  const { command, originalResult: result, revision } = payload;
  if (result.observedBookRevision < 0n || result.completedAt !== command.completedAt) throw new TypeError("Outcome result does not match its command context");
  if (result.disposition === "committed") {
    if (revision === null || result.committedAt !== command.committedAt || revision.committedAt !== result.committedAt || revision.bookId !== command.bookId || revision.bookRevision !== result.observedBookRevision) throw new TypeError("Committed outcome requires its exact revision context");
    if (JSON.stringify(encodeNode(command, new WeakSet<object>(), 0)) !== JSON.stringify(encodeNode(revision.command, new WeakSet<object>(), 0))) throw new TypeError("Outcome and revision commands differ");
  } else if (revision !== null || Object.hasOwn(result, "committedAt")) throw new TypeError("Rejected outcome cannot contain a financial revision or commit time");
}

/** Command subtree of the existing exact-value codec. Framing and schema are
 * checked here; hash validity, authority and accounting admission remain with
 * EvaluateBookCommand. No result or proposed effect is accepted in this envelope. */
export function encodeBookCommand(command: BookCommand): string {
  const body = encodeNode(command, new WeakSet<object>(), 0);
  assertBookCommandShape(command);
  const checksum = hashCanonical({ type: BOOK_COMMAND_CODEC_VERSION, payload: JSON.stringify(body) });
  const encoded = JSON.stringify({ version: BOOK_COMMAND_CODEC_VERSION, checksum: hashValue(checksum), body });
  if (new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Book command exceeds the byte limit");
  return encoded;
}

export function decodeBookCommand(encoded: string): BookCommandDecodeResult {
  try {
    if (typeof encoded !== "string" || encoded.length > MAX_OUTCOME_BYTES || new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Book command exceeds the byte limit");
    const envelope: unknown = JSON.parse(encoded);
    inspectShape(envelope, record({ version: oneOf(BOOK_COMMAND_CODEC_VERSION), checksum: hashShape, body: opaque }), "commandEnvelope");
    const wrapped = envelope as { version: string; checksum: ContentHash; body: unknown };
    const checksum = hashCanonical({ type: BOOK_COMMAND_CODEC_VERSION, payload: JSON.stringify(wrapped.body) });
    if (!contentHashEquals(checksum, wrapped.checksum)) throw new TypeError("Book command checksum mismatch");
    const command = decodeNode(wrapped.body, 0) as BookCommand;
    assertBookCommandShape(command);
    if (encodeBookCommand(command) !== encoded) throw new TypeError("Noncanonical book command encoding");
    deepFreeze(command);
    return Object.freeze({ disposition: "decoded", command });
  } catch {
    return Object.freeze({ disposition: "rejected", message: "Invalid book command encoding" });
  }
}

/** Versioned single-outcome transport using the SAME exact value and command/effect
 * shapes as the aggregate codec. This is not accounting admission or replay proof.
 * Legacy lot-state effects remain whole snapshots; this does not make them sparse. */
export function encodeBookOutcome(payload: BookOutcomePayload): string {
  inspectOutcome(payload);
  const body = encodeNode(payload, new WeakSet<object>(), 0);
  const checksum = hashCanonical({ type: BOOK_OUTCOME_CODEC_VERSION, payload: JSON.stringify(body) });
  const encoded = JSON.stringify({ version: BOOK_OUTCOME_CODEC_VERSION, checksum: hashValue(checksum), body });
  if (new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Book outcome exceeds the byte limit");
  return encoded;
}

/** Decoding establishes exact framing/shape/context only. A ledger must reexecute
 * the command at the authenticated prior state and compare the entire payload
 * before accepting an outcome as canonical accounting evidence. */
export function decodeBookOutcome(encoded: string): BookOutcomeDecodeResult {
  try {
    if (encoded.length > MAX_OUTCOME_BYTES || new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Book outcome exceeds the byte limit");
    const envelope: unknown = JSON.parse(encoded);
    inspectShape(envelope, record({ version: oneOf(BOOK_OUTCOME_CODEC_VERSION), checksum: hashShape, body: opaque }), "outcomeEnvelope");
    const wrapped = envelope as { version: string; checksum: ContentHash; body: unknown };
    const expected = hashCanonical({ type: BOOK_OUTCOME_CODEC_VERSION, payload: JSON.stringify(wrapped.body) });
    if (!contentHashEquals(expected, wrapped.checksum)) throw new TypeError("Book outcome checksum does not match its content");
    const decoded = decodeNode(wrapped.body, 0);
    inspectOutcome(decoded);
    if (encodeBookOutcome(decoded) !== encoded) throw new TypeError("Book outcome encoding is not canonical");
    deepFreeze(decoded);
    return Object.freeze({ disposition: "decoded", payload: decoded });
  } catch (error) {
    return Object.freeze({ disposition: "rejected", message: error instanceof Error ? error.message : "Unknown outcome decode failure" });
  }
}

/** `decodeBookOutcome` for an outcome that a ledger stored under its own hash chain, whose bytes that chain
 * already authenticates. It checks everything the canonical decode checks (the size bound, the envelope, the
 * checksum of the body, the closed schema and the consistency of the command, the result and the revision)
 * except the last step: that the text is exactly the canonical encoding of what it decodes. That step
 * encodes the whole outcome a second time, which is about a third of the cost of reading it. A text that
 * decodes but is not canonical (other whitespace, other member order in the envelope) is accepted here and
 * rejected by `decodeBookOutcome`. Use it where the same bytes are compared with a canonical encoding some
 * other way (a replay that re-executes the command and compares the encoding of its result with the text
 * does) or where a trusted apply of the stored revisions has accepted that trust; the canonical decode is
 * the default everywhere else. */
export function decodeStoredBookOutcome(encoded: string): BookOutcomeDecodeResult {
  try {
    if (encoded.length > MAX_OUTCOME_BYTES || new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Book outcome exceeds the byte limit");
    const envelope: unknown = JSON.parse(encoded);
    inspectShape(envelope, record({ version: oneOf(BOOK_OUTCOME_CODEC_VERSION), checksum: hashShape, body: opaque }), "outcomeEnvelope");
    const wrapped = envelope as { version: string; checksum: ContentHash; body: unknown };
    const expected = hashCanonical({ type: BOOK_OUTCOME_CODEC_VERSION, payload: JSON.stringify(wrapped.body) });
    if (!contentHashEquals(expected, wrapped.checksum)) throw new TypeError("Book outcome checksum does not match its content");
    const decoded = decodeNode(wrapped.body, 0);
    inspectOutcome(decoded);
    deepFreeze(decoded);
    return Object.freeze({ disposition: "decoded", payload: decoded });
  } catch (error) {
    return Object.freeze({ disposition: "rejected", message: error instanceof Error ? error.message : "Unknown outcome decode failure" });
  }
}

function inspectOwnershipArtifact<K extends InventoryOwnershipArtifactKind>(kind: K, artifact: unknown): asserts artifact is InventoryOwnershipArtifactTypes[K] {
  inspectShape(artifact, ownershipArtifactShapes[kind], `inventoryOwnership.${kind}`);
  if (!validateInventoryOwnershipArtifact(kind, artifact as InventoryOwnershipArtifactTypes[K])) {
    throw new TypeError("Inventory ownership artifact violates intrinsic structure or content hashes");
  }
}

/** Versioned, bounded artifact transport sharing the durable exact-value encoding.
 * Decoding this envelope alone neither admits a command nor registers an indexed row. */
export function encodeInventoryOwnershipArtifact<K extends InventoryOwnershipArtifactKind>(kind: K, artifact: InventoryOwnershipArtifactTypes[K]): string {
  if (!Object.hasOwn(ownershipArtifactShapes, kind)) throw new TypeError("Unknown inventory ownership artifact kind");
  const body = encodeNode(artifact, new WeakSet<object>(), 0);
  const payload = JSON.stringify(body);
  if (payload.length > MAX_OUTCOME_BYTES || new TextEncoder().encode(payload).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Inventory ownership artifact exceeds the byte limit");
  // Validate the actual copied value that will be serialized, not a second read
  // of the caller's object. Raw transport decoding is always bounded first.
  inspectOwnershipArtifact(kind, decodeNode(body, 0));
  const checksum = hashCanonical({ type: INVENTORY_OWNERSHIP_CODEC_VERSION, kind, payload });
  const encoded = JSON.stringify({ version: INVENTORY_OWNERSHIP_CODEC_VERSION, kind, checksum: hashValue(checksum), body });
  if (new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Inventory ownership artifact exceeds the byte limit");
  return encoded;
}

/** Canonical bytes, strict shape and source-free intrinsic integrity only.
 * Referenced anchors/postings/positions still need authenticated source resolution
 * and command replay. A valid packet is not proof of currentness or authority. */
export function decodeInventoryOwnershipArtifact<K extends InventoryOwnershipArtifactKind>(kind: K, encoded: string): InventoryOwnershipDecodeResult<K> {
  try {
    if (!Object.hasOwn(ownershipArtifactShapes, kind)) throw new TypeError("Unknown inventory ownership artifact kind");
    if (typeof encoded !== "string") throw new TypeError("Inventory ownership artifact must be text");
    if (encoded.length > MAX_OUTCOME_BYTES || new TextEncoder().encode(encoded).byteLength > MAX_OUTCOME_BYTES) throw new RangeError("Inventory ownership artifact exceeds the byte limit");
    const envelope: unknown = JSON.parse(encoded);
    inspectShape(envelope, record({ version: oneOf(INVENTORY_OWNERSHIP_CODEC_VERSION), kind: oneOf(kind), checksum: hashShape, body: opaque }), "inventoryOwnershipEnvelope");
    const wrapped = envelope as { version: string; kind: K; checksum: ContentHash; body: unknown };
    const expected = hashCanonical({ type: INVENTORY_OWNERSHIP_CODEC_VERSION, kind, payload: JSON.stringify(wrapped.body) });
    if (!contentHashEquals(expected, wrapped.checksum)) throw new TypeError("Inventory ownership artifact checksum does not match its content");
    const artifact = decodeNode(wrapped.body, 0);
    inspectOwnershipArtifact(kind, artifact);
    if (encodeInventoryOwnershipArtifact(kind, artifact) !== encoded) throw new TypeError("Inventory ownership artifact encoding is not canonical");
    deepFreeze(artifact);
    return Object.freeze({ disposition: "decoded", kind, artifact });
  } catch (error) {
    return Object.freeze({ disposition: "rejected", message: error instanceof Error ? error.message : "Unknown inventory ownership decode failure" });
  }
}

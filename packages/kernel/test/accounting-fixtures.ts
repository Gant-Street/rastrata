import {
  ExactDecimal,
  ExactRational,
  accountId,
  canonicalPostingReferenceId,
  createCanonicalPostingReference,
  derivationId,
  evidenceId,
  effectKey,
  hashAccountingPolicyArtifact,
  hashCanonical,
  instant,
  journalId,
  policyId,
  postingId,
  semanticVersion,
  type AccountingCapability,
  type AccountId,
  type AccountingCapabilityCombination,
  type AccountingFeature,
  type AccountingPolicyArtifactCore,
  type ConsolidationAccountMapping,
  type ConsolidationElimination,
  type ConsolidationSource,
  type ConsolidationTranslationRule,
  type DerivationRecord,
  type EvidenceId,
  type InventoryPool,
  type TaxableLine,
  type TaxDeterminationId,
  type TaxDirection,
  type TaxPolicyComponent,
  type Instant,
  type CanonicalPostingReference,
  type CommodityId,
} from "../src/index.ts";
import { IDS, quantizationPolicy } from "./fixtures.ts";

const one = ExactRational.of(1n, 1n);
const evidence = Object.freeze({ id: evidenceId("accounting-evidence"), sourceSystem: "test", sourceRecordId: "record", observedAt: instant("2026-01-01T00:00:00Z"), contentHash: hashCanonical({ evidence: "accounting" }) });
export const accountingDerivation: DerivationRecord = Object.freeze({ id: derivationId("accounting-derivation"), policyId: policyId("policy-main"), policyVersion: semanticVersion("1.0.0"), algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ input: "accounting" }), actorId: IDS.actor, state: "approved" as const, recordedAt: instant("2026-01-01T00:00:00Z"), evidence: Object.freeze([evidence]) });
export const accountingEvidenceId: EvidenceId = evidence.id;
export { policyId };
export const accountingOne = one;

export const account = (value: string) => accountId(`account-${value}`);

export function sourceReference(
  id: string,
  overrides: {
    readonly accountId?: AccountId;
    readonly commodityId?: CommodityId;
    readonly quantity?: ExactRational;
    readonly bookValue?: ExactRational;
    readonly sourceEffectKey?: string;
    readonly sourceJournalId?: string;
  } = {},
): CanonicalPostingReference {
  const quantity = overrides.quantity ?? ExactRational.of(100n, 1n);
  const bookValue = overrides.bookValue ?? quantity;
  if (bookValue.denominator !== 1n) throw new Error("sourceReference test helper requires an integral book value");
  const posting = Object.freeze({
    id: postingId(`${id}-posting`),
    ordinal: 1n,
    accountId: overrides.accountId ?? account("source"),
    units: Object.freeze({ canonicalNumber: quantity, commodityId: overrides.commodityId ?? IDS.usd }),
    bookValue: Object.freeze({ amount: ExactDecimal.of(bookValue.numerator, 0n), functionalCommodityId: IDS.usd }),
    dimensionMemberIds: Object.freeze([]),
  });
  return createCanonicalPostingReference(
    canonicalPostingReferenceId(`${id}-reference`),
    IDS.book,
    journalId(overrides.sourceJournalId ?? `${id}-journal`),
    posting,
    effectKey(overrides.sourceEffectKey ?? `${id}-command:journal:0`),
  );
}

export function capability(feature: AccountingFeature, method: string, combinations: readonly AccountingCapabilityCombination[] = [{ method }]): AccountingCapability {
  return Object.freeze({ feature, status: "supported" as const, implementationVersion: semanticVersion("1.0.0"), verificationEvidenceIds: Object.freeze([evidence.id]), admittedCombinations: Object.freeze(combinations) });
}

function artifact<T extends Omit<AccountingPolicyArtifactCore, "contentHash"> & Record<string, unknown>>(type: string, body: T): T & AccountingPolicyArtifactCore {
  return Object.freeze({ ...body, contentHash: hashAccountingPolicyArtifact(type, body) });
}

export function pool(id: string, accountIdValue: string): InventoryPool {
  return artifact("InventoryPool", { id: policyId(id), accountId: account(accountIdValue) });
}
export function basisRule(id: string, event: "recognition" | "settlement" | "creditApplication" | "writeOff" | "tax" | "inventoryCost" | "nonCash" | "rounding", treatment: "recognizeAtAccountingDate" | "recognizeAtSettlement" | "allocateBySettlementRatio" | "carryThrough" | "exclude") {
  return artifact("AccountingBasisRule", { id: policyId(id), event, treatment });
}
export function classificationRule(id: string, accountIdValue: string, classification: "monetary" | "nonMonetary") {
  return artifact("MonetaryClassificationRule", { id: policyId(id), accountId: account(accountIdValue), classification });
}
export function taxComponent(id: string, overrides: Partial<Omit<TaxPolicyComponent, "id" | "contentHash">> = {}): TaxPolicyComponent {
  return artifact("TaxPolicyComponent", {
    id: policyId(id),
    rate: ExactRational.of(1n, 10n),
    inclusion: "exclusive" as const,
    treatment: "inputTax" as const,
    recoverability: "recoverable" as const,
    recoverableShare: one,
    compoundOrdinal: 1n,
    compoundsOn: Object.freeze([]),
    liabilityAccountId: account("tax-payable"),
    ...overrides,
  });
}
export function consolidationMapping(id: string, sourceAccountId: string, targetAccountId: string, sourceBookId?: string, overrides: Partial<Omit<ConsolidationAccountMapping, "id" | "contentHash" | "sourceAccountId" | "targetAccountId" | "sourceBookId">> = {}): ConsolidationAccountMapping {
  return artifact("ConsolidationAccountMapping", { id: policyId(id), ...(sourceBookId === undefined ? {} : { sourceBookId: sourceBookId as never }), sourceAccountId: account(sourceAccountId), targetAccountId: account(targetAccountId), validFrom: instant("2020-01-01T00:00:00Z"), ...overrides });
}
export function consolidationValuationPolicy(id: string, overrides: Partial<Exclude<ConsolidationTranslationRule["valuationPolicy"], undefined>> = {}): ConsolidationTranslationRule["valuationPolicy"] {
  return Object.freeze({
    id: policyId(id), version: semanticVersion("1.0.0"), validFrom: instant("2020-01-01T00:00:00Z"),
    maximumHops: 1n, allowInverseObservation: false, preferDirectObservation: true, ...overrides,
  });
}
export function translationRule(id: string, sourceAccountId: string, targetAccountId: string, sourceBookId?: string, overrides: Partial<Omit<ConsolidationTranslationRule, "id" | "contentHash" | "sourceAccountId" | "targetAccountId" | "sourceBookId">> = {}): ConsolidationTranslationRule {
  const body = {
      id: policyId(id),
      ...(sourceBookId === undefined ? {} : { sourceBookId: sourceBookId as never }),
      sourceAccountId: account(sourceAccountId),
      targetAccountId: account(targetAccountId),
      validFrom: instant("2020-01-01T00:00:00Z"),
      valuationPolicy: consolidationValuationPolicy(`${id}-valuation`),
      ...overrides,
  };
  return Object.freeze({ ...body, contentHash: hashAccountingPolicyArtifact("ConsolidationTranslationRule", body) });
}
export function taxableLine(id: string, overrides: Partial<Omit<TaxableLine, "lineId">> = {}): TaxableLine {
  return Object.freeze({
    lineId: id,
    sourcePostingId: postingId(`${id}-source-posting`),
    counterpartyPostingId: postingId(`${id}-counterparty-posting`),
    policyId: policyId("tax"),
    policyVersion: semanticVersion("1.0.0"),
    statedAmount: ExactRational.of(100n, 1n),
    amountIncludesTax: false,
    sourceAccountId: account("expense"),
    payableAccountId: account("ap"),
    ...overrides,
  });
}
export function taxRequest(id: string, lines: readonly TaxableLine[], overrides: { governedAt?: Instant; direction?: TaxDirection; sourceTransactionId?: string } = {}) {
  return Object.freeze({
    id: id as TaxDeterminationId,
    sourceTransactionId: journalId(overrides.sourceTransactionId ?? `${id}-source`),
    governedAt: instant("2026-01-15T14:00:00Z"),
    direction: overrides.direction ?? "purchase",
    lines,
    derivation: accountingDerivation,
  });
}
export function consolidationSource(bookId: string, balances: readonly { readonly sourceAccountId: string; readonly classification: "asset" | "liability" | "equity" | "income" | "expense"; readonly amount: ExactRational; readonly observedRate?: ExactRational }[], overrides: { ownershipShare?: ExactRational; method?: ConsolidationSource["method"]; control?: ConsolidationSource["control"]; populationHash?: ReturnType<typeof hashCanonical>; votingShare?: ExactRational } = {}): ConsolidationSource {
  const populationHash = overrides.populationHash ?? hashCanonical({ source: bookId });
  return Object.freeze({
    bookId: bookId as never,
    revision: 1n,
    postingSequence: 1n,
    populationHash,
    expectedRevision: 1n,
    expectedPostingSequence: 1n,
    expectedPopulationHash: populationHash,
    relationshipId: `relationship-${bookId}`,
    relationshipValidFrom: instant("2020-01-01T00:00:00Z"),
    control: overrides.control ?? "controlled",
    method: overrides.method ?? "full",
    ownershipShare: overrides.ownershipShare ?? one,
    votingShare: overrides.votingShare ?? overrides.ownershipShare ?? one,
    controlEvidenceIds: Object.freeze(["control"]),
    balances: Object.freeze(balances.map((balance) => Object.freeze({
      sourceAccountId: account(balance.sourceAccountId),
      unitsCommodityId: balance.observedRate === undefined ? IDS.usd : ("commodity-EUR" as never),
      classification: balance.classification,
      amount: balance.amount,
      valuationPaths: balance.observedRate === undefined ? Object.freeze([]) : Object.freeze([{ id: `path-${bookId}-${balance.sourceAccountId}`, effectiveAt: instant("2026-01-31T00:00:00Z"), steps: Object.freeze([{ fromCommodityId: "commodity-EUR" as never, toCommodityId: IDS.usd, rate: balance.observedRate, observedAt: instant("2026-01-30T00:00:00Z"), evidenceIds: Object.freeze(["valuation-evidence"]) }]) }]),
    }))),
  });
}
export function consolidationElimination(sourceBookId: string, sourceAccountId: string, amount: ExactRational, targetAccountId = sourceAccountId, suffix = sourceAccountId): ConsolidationElimination {
  return Object.freeze({ id: `elimination-${sourceBookId}-${suffix}`, sourceBookId: sourceBookId as never, sourceAccountId: account(sourceAccountId), targetAccountId: account(targetAccountId), amount, evidenceIds: Object.freeze(["match"]), sourcePostingIds: Object.freeze([postingId(`matched-${sourceBookId}-${suffix}`)]) });
}

export { quantizationPolicy as accountingPolicyQuantization };

import {
  ExactRational,
  commodityId,
  hashCanonical,
  instant,
  localDate,
  policyId,
  semanticVersion,
  type ConsolidationPolicy,
  type ConsolidationSource,
  type ConsolidationValuationPath,
} from "../src/index.ts";
import { IDS, quantizationPolicy } from "./fixtures.ts";
import { account, accountingDerivation, capability, consolidationMapping, consolidationValuationPolicy, translationRule } from "./accounting-fixtures.ts";

const one = ExactRational.of(1n, 1n);
export const valuationPolicy = (id: string, overrides: Partial<ConsolidationPolicy["valuationPolicy"]> = {}) => consolidationValuationPolicy(id, { maximumHops: 2n, allowInverseObservation: true, preferDirectObservation: true, ...overrides });
export const consolidationPolicy = (overrides: Partial<ConsolidationPolicy> = {}): ConsolidationPolicy => Object.freeze({
  id: policyId("vp-consolidation"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
  algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("consolidation", "full"), kind: "consolidation", supportedMethods: Object.freeze(["full"] as const),
  valuationPolicy: valuationPolicy("vp-global"), accountMappings: Object.freeze([consolidationMapping("vp-map-cash", "CASH", "CASH"), consolidationMapping("vp-map-equity", "EQUITY", "EQUITY")]),
  translationRules: Object.freeze([translationRule("vp-rule-cash", "CASH", "CASH"), translationRule("vp-rule-equity", "EQUITY", "EQUITY")].map((rule) => Object.freeze({ ...rule, valuationPolicy: valuationPolicy(`${rule.id}-valuation`) }))),
  translationAdjustmentAccountId: account("TRANSLATION"), parentAttributableEquityAccountId: account("EQUITY"), nonControllingInterestAccountId: account("NCI"), ...overrides,
}) as ConsolidationPolicy;
export const step = (from: string, to: string, numerator: bigint, denominator: bigint, observedAt = "2026-12-30T00:00:00Z") => Object.freeze({ fromCommodityId: commodityId(from), toCommodityId: commodityId(to), rate: ExactRational.of(numerator, denominator), observedAt: instant(observedAt), evidenceIds: Object.freeze(["valuation-evidence"]) });
export const path = (id: string, steps: ConsolidationValuationPath["steps"], effectiveAt = "2026-12-31T00:00:00Z"): ConsolidationValuationPath => Object.freeze({ id, effectiveAt: instant(effectiveAt), steps: Object.freeze(steps) });
export const directPath = (id: string, numerator = 11n, denominator = 10n) => path(id, [step("EUR", "USD", numerator, denominator)]);
export const source = (paths: readonly ConsolidationValuationPath[], overrides: Partial<ConsolidationSource> = {}): ConsolidationSource => {
  const populationHash = hashCanonical({ vp: "source" });
  return Object.freeze({
    bookId: "vp-book" as never, revision: 1n, postingSequence: 1n, populationHash, expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: populationHash,
    relationshipId: "vp-control", relationshipValidFrom: instant("2020-01-01T00:00:00Z"), control: "controlled", method: "full", ownershipShare: one, votingShare: one,
    controlEvidenceIds: Object.freeze(["control-evidence"]), balances: Object.freeze([
      { sourceAccountId: account("CASH"), unitsCommodityId: commodityId("EUR"), classification: "asset" as const, amount: ExactRational.of(100n, 1n), valuationPaths: paths },
      { sourceAccountId: account("EQUITY"), unitsCommodityId: commodityId("EUR"), classification: "equity" as const, amount: ExactRational.of(-100n, 1n), valuationPaths: paths },
    ]), ...overrides,
  }) as ConsolidationSource;
};
export const request = (policy: ConsolidationPolicy, sourceValue: ConsolidationSource, id = "vp-compilation") => Object.freeze({
  id: id as never, policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: IDS.book,
  sources: Object.freeze([sourceValue]), eliminations: Object.freeze([]), derivation: Object.freeze({ ...accountingDerivation, policyId: policy.id, policyVersion: policy.version }),
});

import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  accountId,
  calculateInventoryCost,
  compileConsolidation,
  createAllocationSchedule,
  instant,
  localDate,
  determineTax,
  evidenceId,
  hashCanonical,
  policyId,
  semanticVersion,
  validAccountingDerivation,
  type DerivationRecord,
  type ConsolidationPolicy,
  type InventoryCostPolicy,
} from "../src/index.ts";
import { identifier } from "../src/canonical.ts";
import { IDS, quantizationPolicy } from "./fixtures.ts";
import { account, accountingDerivation, capability, consolidationMapping, taxComponent, translationRule } from "./accounting-fixtures.ts";
import { consolidationPolicy, directPath, path, request, source, step, valuationPolicy } from "./consolidation-boundary-fixtures.ts";


const one = ExactRational.of(1n, 1n);
const policy = (overrides: Partial<InventoryCostPolicy> = {}): InventoryCostPolicy => {
  const method = overrides.method ?? "fifo";
  return Object.freeze({
    id: policyId(`boundary-inventory-${method}-${JSON.stringify(Object.keys(overrides))}`), version: semanticVersion("1.0.0"), bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy,
    capability: capability("inventoryCost", method), kind: "inventoryCost", method,
    pools: Object.freeze([pool("boundary-pool", "INVENTORY")]), shortageTreatment: "reject", ...overrides,
  }) as InventoryCostPolicy;
};
function pool(id: string, accountIdValue: string) {
  return { id: policyId(id), accountId: accountId(`account-${accountIdValue}`), contentHash: hashCanonical({ pool: id }) };
}
const layer = (id: string, acquiredAt: string, quantity: bigint, totalBasisCents: bigint) => ({
  id, accountId: account("INVENTORY"), acquiredAt: instant(acquiredAt), quantity: ExactRational.of(quantity, 1n), totalBasis: ExactRational.of(totalBasisCents, 1n),
});
const derivationWith = (overrides: Partial<DerivationRecord> = {}): DerivationRecord => Object.freeze({
  id: identifier<"DerivationRecord">("boundary-derivation"), policyId: policyId("policy-main"), policyVersion: semanticVersion("1.0.0"),
  algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ input: "boundary" }), actorId: IDS.actor,
  state: "approved" as const, recordedAt: instant("2026-01-01T00:00:00Z"), evidence: Object.freeze([evidence]), ...overrides,
});
const evidence = Object.freeze({ id: evidenceId("boundary-evidence"), sourceSystem: "boundary", sourceRecordId: "r", observedAt: instant("2026-01-01T00:00:00Z"), contentHash: hashCanonical({ evidence: "boundary" }) });

describe("kernel boundary adversaries (mutation gate companions)", () => {
  test("validAccountingDerivation fails closed on every degraded lineage field", () => {
    const valid = derivationWith();
    expect(validAccountingDerivation(valid)).toBeTrue();
    expect(validAccountingDerivation(derivationWith({ evidence: Object.freeze([]) }))).toBeFalse();
    expect(validAccountingDerivation(derivationWith({ state: "drafted" as never }))).toBeFalse();
    expect(validAccountingDerivation(derivationWith({ recordedAt: instant("2026-01-01T00:00:00Z"), evidence: Object.freeze([]) }))).toBeFalse();
    expect(validAccountingDerivation(derivationWith({ recordedAt: "not-a-date" as never }))).toBeFalse();
  });

  test("policy applicability includes the exact validFrom instant and excludes validTo", () => {
    const layers = [layer("L1", "2026-01-01T00:00:00Z", 1n, 100n)];
    const boundaryPolicy = policy({ validFrom: instant("2026-01-15T00:00:00Z"), validTo: instant("2026-01-16T00:00:00Z") });
    expect(calculateInventoryCost([boundaryPolicy], IDS.book, { policyId: boundaryPolicy.id, policyVersion: boundaryPolicy.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers }).disposition).toBe("costed");
    expect(calculateInventoryCost([boundaryPolicy], IDS.book, { policyId: boundaryPolicy.id, policyVersion: boundaryPolicy.version, governedAt: instant("2026-01-16T00:00:00Z"), quantity: one, layers }).disposition).toBe("rejected");
  });

  test("inventory costing consumes the exact requested quantity at the available boundary", () => {
    const layers = [layer("L1", "2026-01-01T00:00:00Z", 10n, 1_000n), layer("L2", "2026-01-02T00:00:00Z", 10n, 1_400n)];
    const atBoundary = calculateInventoryCost([policy()], IDS.book, { policyId: policy().id, policyVersion: policy().version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(20n, 1n), layers });
    expect(atBoundary.disposition).toBe("costed");
    if (atBoundary.disposition === "costed") {
      expect(atBoundary.provisionalQuantity.isZero()).toBeTrue();
      expect(atBoundary.ordinaryBasis.equals(ExactRational.of(2_400n, 1n))).toBeTrue();
    }
  });

  test("specific identification honors the exact selected order, not pool ordering", () => {
    const specific = policy({ method: "specificIdentification" });
    const layers = [layer("LOT-1", "2026-01-01T00:00:00Z", 10n, 1_000n), layer("LOT-2", "2026-01-02T00:00:00Z", 10n, 1_400n)];
    const result = calculateInventoryCost([specific], IDS.book, { policyId: specific.id, policyVersion: specific.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(12n, 1n), layers, specificLayerIds: ["LOT-2", "LOT-1"] });
    expect(result.disposition).toBe("costed");
    if (result.disposition === "costed") {
      expect(result.allocations[0]?.layerId).toBe("LOT-2");
      expect(result.allocations[0]?.basis.equals(ExactRational.of(1_400n, 1n))).toBeTrue();
      expect(result.ordinaryBasis.equals(ExactRational.of(1_600n, 1n))).toBeTrue();
    }
  });

  test("moving average and last receipt provisional bases are exact and tie-broken deterministically", () => {
    const layers = [layer("B", "2026-01-01T00:00:00Z", 4n, 800n), layer("A", "2026-01-01T00:00:00Z", 2n, 1_000n)];
    const moving = policy({ method: "weightedAverage", shortageTreatment: "provisionalNegative", provisionalBasisMethod: "movingAverage" });
    const movingResult = calculateInventoryCost([moving], IDS.book, { policyId: moving.id, policyVersion: moving.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(7n, 1n), layers });
    expect(movingResult.disposition).toBe("costed");
    if (movingResult.disposition === "costed") {
      expect(movingResult.provisionalBasis.equals(ExactRational.of(300n, 1n))).toBeTrue();
    }
    const lastReceipt = policy({ method: "weightedAverage", shortageTreatment: "provisionalNegative", provisionalBasisMethod: "lastReceiptCost" });
    const lastResult = calculateInventoryCost([lastReceipt], IDS.book, { policyId: lastReceipt.id, policyVersion: lastReceipt.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(7n, 1n), layers });
    expect(lastResult.disposition).toBe("costed");
    if (lastResult.disposition === "costed") {
      expect(lastResult.provisionalBasis.equals(ExactRational.of(500n, 1n))).toBeTrue();
      const permuted = calculateInventoryCost([lastReceipt], IDS.book, { policyId: lastReceipt.id, policyVersion: lastReceipt.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(7n, 1n), layers: [...layers].reverse() });
      expect(permuted.disposition === "costed" && permuted.provisionalBasis.equals(lastResult.provisionalBasis)).toBeTrue();
    }
  });

  test("enforces the executable inventory population bound exactly", () => {
    const limit = 10_000;
    const atLimit = Array.from({ length: limit }, (_, index) => layer(`L${index}`, "2026-01-01T00:00:00Z", 1n, 1n));
    const overLimit = [...atLimit, layer("L-EXTRA", "2026-01-01T00:00:00Z", 1n, 1n)];
    const policyAtLimit = policy();
    expect(calculateInventoryCost([policyAtLimit], IDS.book, { policyId: policyAtLimit.id, policyVersion: policyAtLimit.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: atLimit }).disposition).toBe("costed");
    expect(calculateInventoryCost([policyAtLimit], IDS.book, { policyId: policyAtLimit.id, policyVersion: policyAtLimit.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: overLimit }).disposition).toBe("rejected");
  });
});

describe("specific-identification population scoping", () => {
  test("available quantity is the selected population, not the whole pool", () => {
    const specific = policy({ method: "specificIdentification", shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: ExactRational.of(100n, 1n) });
    const layers = [layer("LOT-1", "2026-01-01T00:00:00Z", 1n, 100n), layer("LOT-2", "2026-01-02T00:00:00Z", 1n, 200n)];
    const result = calculateInventoryCost([specific], IDS.book, { policyId: specific.id, policyVersion: specific.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(5n, 1n), layers, specificLayerIds: ["LOT-1"] });
    expect(result.disposition).toBe("costed");
    if (result.disposition === "costed") {
      expect(result.ordinaryBasis.equals(ExactRational.of(100n, 1n))).toBeTrue();
      expect(result.provisionalQuantity.equals(ExactRational.of(4n, 1n))).toBeTrue();
      expect(result.provisionalBasis.equals(ExactRational.of(400n, 1n))).toBeTrue();
    }
  });
});

describe("executable resource bounds are exact", () => {
  test("tax lines admit exactly maxTaxLines and reject beyond", () => {
    const tax = { id: policyId("boundary-tax"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("taxDetermination", "compound"), kind: "taxDetermination" as const, taxCode: "B", jurisdiction: "B", roundingLevel: "lineLevel" as const, components: Object.freeze([taxComponent("B-1", { recoverableAccountId: account("INPUT-TAX") })]) };
    const buildLines = (count: number) => Array.from({ length: count }, (_, index) => ({ lineId: `L${index}`, sourcePostingId: identifier<"Posting">(`L${index}-source`), counterpartyPostingId: identifier<"Posting">(`L${index}-counter`), policyId: tax.id, policyVersion: tax.version, statedAmount: ExactRational.of(100n, 1n), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }));
    const atLimit = determineTax([tax], IDS.book, IDS.usd, { id: identifier<"TaxDetermination">("B-AT"), sourceTransactionId: identifier<"JournalTransaction">("B-AT-SOURCE"), governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase", lines: buildLines(100), derivation: accountingDerivation });
    expect(atLimit.disposition).toBe("draft");
    const over = determineTax([tax], IDS.book, IDS.usd, { id: identifier<"TaxDetermination">("B-OVER"), sourceTransactionId: identifier<"JournalTransaction">("B-OVER-SOURCE"), governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase", lines: buildLines(101), derivation: accountingDerivation });
    expect(over.disposition).toBe("rejected");
  });

  test("allocation schedules admit exactly maxScheduleInstallments", () => {
    const allocation = { id: policyId("boundary-allocation"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("allocationSchedule", "straightLine"), kind: "allocationSchedule" as const, method: "straightLine" as const, frequency: "monthly" as const, convention: "fullPeriod" as const, allocationAccountId: account("ALLOCATION"), contraAccountId: account("CONTRA") };
    const atLimit = createAllocationSchedule([allocation], IDS.book, { id: identifier<"AllocationSchedule">("B-SCH"), policyId: allocation.id, policyVersion: allocation.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: identifier<"Posting">("B-SCH-SOURCE"), sourceBasis: ExactRational.of(1_200n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2125-12-31"), derivation: accountingDerivation });
    expect(atLimit.disposition).toBe("draft");
    const over = createAllocationSchedule([allocation], IDS.book, { id: identifier<"AllocationSchedule">("B-SCH2"), policyId: allocation.id, policyVersion: allocation.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: identifier<"Posting">("B-SCH2-SOURCE"), sourceBasis: ExactRational.of(1_200n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2126-01-31"), derivation: accountingDerivation });
    expect(over.disposition).toBe("rejected");
  });
});

describe("consolidation policy, valuation, relationship, and elimination adversaries", () => {
  test("selects an exact direct path and composes an evidence-backed two-hop path", () => {
    const policy = consolidationPolicy();
    for (const [sourceValue, expected] of [[source([directPath("direct")]), ExactRational.of(110n, 1n)], [source([path("two-hop", [step("EUR", "GBP", 4n, 5n), step("GBP", "USD", 5n, 4n)])]), ExactRational.of(100n, 1n)]] as const) {
      const result = compileConsolidation([policy], IDS.usd, request(policy, sourceValue));
      expect(result.disposition).toBe("draft");
      if (result.disposition === "draft") expect(result.draft.journals[0]!.postings.find((posting) => posting.accountId === account("CASH"))?.exactBookValue.equals(expected)).toBeTrue();
    }
  });

  test("prefers a direct path but falls back to an allowed inverse when no direct path exists", () => {
    const policy = consolidationPolicy();
    const inverse = path("inverse", [step("USD", "EUR", 10n, 11n)]);
    const preferred = compileConsolidation([policy], IDS.usd, request(policy, source([inverse, directPath("direct")])));
    const fallback = compileConsolidation([policy], IDS.usd, request(policy, source([inverse]), "vp-inverse"));
    expect(preferred.disposition).toBe("draft");
    expect(fallback.disposition).toBe("draft");
    if (preferred.disposition === "draft") expect(preferred.draft.journals[0]!.postings.find((posting) => posting.accountId === account("CASH"))?.exactBookValue.equals(ExactRational.of(110n, 1n))).toBeTrue();

    const distinguishable = compileConsolidation([policy], IDS.usd, request(policy, source([
      path("a-inverse", [step("USD", "EUR", 2n, 1n)]), directPath("z-direct"),
    ]), "vp-direct-distinguishable"));
    expect(distinguishable.disposition).toBe("draft");
    if (distinguishable.disposition === "draft") expect(distinguishable.draft.journals[0]!.postings.find((posting) => posting.accountId === account("CASH"))?.exactBookValue.equals(ExactRational.of(110n, 1n))).toBeTrue();
  });

  test("rejects future observations, expired relationships, disconnected paths, and contradictory equally preferred rates", () => {
    const policy = consolidationPolicy();
    const hostile = [
      source([path("future", [step("EUR", "USD", 11n, 10n, "2030-01-01T00:00:00Z")])]),
      source([directPath("direct")], { relationshipValidTo: instant("2026-01-01T00:00:00Z") }),
      source([path("disconnected", [step("GBP", "USD", 1n, 1n)])]),
      source([directPath("rate-a", 11n, 10n), directPath("rate-b", 6n, 5n)]),
    ];
    for (const [index, sourceValue] of hostile.entries()) expect(compileConsolidation([policy], IDS.usd, request(policy, sourceValue, `vp-hostile-${index}`)).disposition).toBe("rejected");
  });

  test("admits exact source and relationship endpoints and every compatible control method", () => {
    const governedAt = instant("2026-12-31T23:59:59Z");
    const fullPolicy = consolidationPolicy();
    const endpointSource = source([path("observed-at", [step("EUR", "USD", 11n, 10n, governedAt)])], {
      postingSequence: 0n, expectedPostingSequence: 0n, relationshipValidFrom: governedAt,
    });
    expect(compileConsolidation([fullPolicy], IDS.usd, request(fullPolicy, endpointSource, "vp-source-endpoints")).disposition).toBe("draft");
    expect(compileConsolidation([fullPolicy], IDS.usd, request(fullPolicy, { ...endpointSource, revision: 0n, expectedRevision: 0n }, "vp-zero-revision")).disposition).toBe("rejected");
    expect(compileConsolidation([fullPolicy], IDS.usd, request(fullPolicy, { ...endpointSource, relationshipValidTo: governedAt }, "vp-relationship-valid-to")).disposition).toBe("rejected");

    const allMethods = consolidationPolicy({ supportedMethods: Object.freeze(["full", "equity", "jointOperationShare"] as const) });
    const cases = [
      source([directPath("full")]),
      source([directPath("equity")], { control: "significantInfluence", method: "equity", ownershipShare: ExactRational.zero(), votingShare: ExactRational.zero() }),
      source([directPath("joint")], { control: "jointlyControlled", method: "jointOperationShare", ownershipShare: one, votingShare: one }),
    ];
    for (const [index, sourceValue] of cases.entries()) expect(compileConsolidation([allMethods], IDS.usd, request(allMethods, sourceValue, `vp-method-${index}`)).disposition).toBe("draft");
  });

  test("enforces global valuation endpoints and rejects repeated-commodity paths", () => {
    const governedAt = instant("2026-12-31T23:59:59Z");
    const exact = consolidationPolicy({
      valuationPolicy: valuationPolicy("global-exact", { validFrom: governedAt, maximumHops: 1n }),
      translationRules: Object.freeze([
        translationRule("global-exact-cash", "CASH", "CASH", undefined, { valuationPolicy: valuationPolicy("global-exact-cash-vp", { maximumHops: 1n }) }),
        translationRule("global-exact-equity", "EQUITY", "EQUITY", undefined, { valuationPolicy: valuationPolicy("global-exact-equity-vp", { maximumHops: 1n }) }),
      ]),
    });
    expect(compileConsolidation([exact], IDS.usd, request(exact, source([directPath("global-exact")]), "vp-global-exact")).disposition).toBe("draft");
    const zeroHops = consolidationPolicy({ valuationPolicy: valuationPolicy("global-zero", { maximumHops: 0n }) });
    const sameCommoditySource = source([], { balances: Object.freeze([
      { sourceAccountId: account("CASH"), unitsCommodityId: IDS.usd, classification: "asset", amount: ExactRational.of(100n, 1n), valuationPaths: Object.freeze([]) },
      { sourceAccountId: account("EQUITY"), unitsCommodityId: IDS.usd, classification: "equity", amount: ExactRational.of(-100n, 1n), valuationPaths: Object.freeze([]) },
    ]) });
    expect(compileConsolidation([zeroHops], IDS.usd, request(zeroHops, sameCommoditySource, "vp-global-zero")).disposition).toBe("rejected");
    const expiresAt = consolidationPolicy({ valuationPolicy: valuationPolicy("global-expiry", { validTo: governedAt }) });
    expect(compileConsolidation([expiresAt], IDS.usd, request(expiresAt, source([directPath("global-expiry")]), "vp-global-expiry")).disposition).toBe("rejected");
    const repeated = path("repeated-target", [step("EUR", "USD", 1n, 1n), step("USD", "GBP", 1n, 1n), step("GBP", "USD", 1n, 1n)]);
    const repeatedPolicy = consolidationPolicy({
      valuationPolicy: valuationPolicy("global-repeated", { maximumHops: 3n }),
      translationRules: Object.freeze([
        translationRule("repeated-cash", "CASH", "CASH", undefined, { valuationPolicy: valuationPolicy("repeated-cash-vp", { maximumHops: 3n }) }),
        translationRule("repeated-equity", "EQUITY", "EQUITY", undefined, { valuationPolicy: valuationPolicy("repeated-equity-vp", { maximumHops: 3n }) }),
      ]),
    });
    expect(compileConsolidation([repeatedPolicy], IDS.usd, request(repeatedPolicy, source([repeated]), "vp-repeated-target")).disposition).toBe("rejected");
  });

  test("admits mapping and translation-rule validFrom and excludes validTo exactly", () => {
    const governedAt = instant("2026-12-31T23:59:59Z");
    const mappings = Object.freeze([
      consolidationMapping("exact-map-cash", "CASH", "CASH", "vp-book", { validFrom: governedAt }),
      consolidationMapping("exact-map-equity", "EQUITY", "EQUITY", "vp-book", { validFrom: governedAt }),
    ]);
    const rules = Object.freeze([
      translationRule("exact-rule-cash", "CASH", "CASH", "vp-book", { validFrom: governedAt, valuationPolicy: valuationPolicy("exact-rule-cash-vp", { validFrom: governedAt, maximumHops: 1n }) }),
      translationRule("exact-rule-equity", "EQUITY", "EQUITY", "vp-book", { validFrom: governedAt, valuationPolicy: valuationPolicy("exact-rule-equity-vp", { validFrom: governedAt, maximumHops: 1n }) }),
    ]);
    const exact = consolidationPolicy({ accountMappings: mappings, translationRules: rules });
    expect(compileConsolidation([exact], IDS.usd, request(exact, source([directPath("scoped-exact")]), "vp-scoped-exact")).disposition).toBe("draft");

    const expiredMapping = consolidationPolicy({ accountMappings: Object.freeze([
      consolidationMapping("expired-map-cash", "CASH", "CASH", "vp-book", { validTo: governedAt }),
      consolidationMapping("expired-map-equity", "EQUITY", "EQUITY", "vp-book", { validTo: governedAt }),
    ]) });
    expect(compileConsolidation([expiredMapping], IDS.usd, request(expiredMapping, source([directPath("expired-map")]), "vp-expired-map")).disposition).toBe("rejected");

    const expiredRule = consolidationPolicy({ translationRules: Object.freeze([
      translationRule("expired-rule-cash", "CASH", "CASH", undefined, { validTo: governedAt }),
      translationRule("expired-rule-equity", "EQUITY", "EQUITY", undefined, { validTo: governedAt }),
    ]) });
    expect(compileConsolidation([expiredRule], IDS.usd, request(expiredRule, source([directPath("expired-rule")]), "vp-expired-rule")).disposition).toBe("rejected");
  });

  test("enforces per-rule valuation endpoints and inverse authority", () => {
    const governedAt = instant("2026-12-31T23:59:59Z");
    const exactRules = Object.freeze([
      translationRule("rule-endpoint-cash", "CASH", "CASH", undefined, { valuationPolicy: valuationPolicy("rule-endpoint-cash-vp", { validFrom: governedAt, maximumHops: 1n }) }),
      translationRule("rule-endpoint-equity", "EQUITY", "EQUITY", undefined, { valuationPolicy: valuationPolicy("rule-endpoint-equity-vp", { validFrom: governedAt, maximumHops: 1n }) }),
    ]);
    const exact = consolidationPolicy({ translationRules: exactRules });
    expect(compileConsolidation([exact], IDS.usd, request(exact, source([directPath("rule-endpoint")]), "vp-rule-endpoint")).disposition).toBe("draft");

    const expiredRules = Object.freeze([
      translationRule("rule-expired-cash", "CASH", "CASH", undefined, { valuationPolicy: valuationPolicy("rule-expired-cash-vp", { validTo: governedAt }) }),
      translationRule("rule-expired-equity", "EQUITY", "EQUITY", undefined, { valuationPolicy: valuationPolicy("rule-expired-equity-vp", { validTo: governedAt }) }),
    ]);
    const expired = consolidationPolicy({ translationRules: expiredRules });
    expect(compileConsolidation([expired], IDS.usd, request(expired, source([directPath("rule-expired")]), "vp-rule-expired")).disposition).toBe("rejected");

    const zeroHopRules = Object.freeze([
      translationRule("rule-zero-cash", "CASH", "CASH", undefined, { valuationPolicy: valuationPolicy("rule-zero-cash-vp", { maximumHops: 0n }) }),
      translationRule("rule-zero-equity", "EQUITY", "EQUITY", undefined, { valuationPolicy: valuationPolicy("rule-zero-equity-vp", { maximumHops: 0n }) }),
    ]);
    const zeroHop = consolidationPolicy({ translationRules: zeroHopRules });
    const zeroHopResult = compileConsolidation([zeroHop], IDS.usd, request(zeroHop, source([directPath("rule-zero")]), "vp-rule-zero"));
    expect(zeroHopResult.disposition).toBe("rejected");
    if (zeroHopResult.disposition !== "rejected") throw new Error("Zero-hop rule admitted");
    expect(zeroHopResult.diagnostics[0]!.message).toBe("The translation rule's valuation policy is not effective through the consolidation instant");

    const noGlobalInverse = consolidationPolicy({
      valuationPolicy: valuationPolicy("global-no-inverse", { allowInverseObservation: false }),
      translationRules: Object.freeze([
        translationRule("inverse-cash", "CASH", "CASH", undefined, { valuationPolicy: valuationPolicy("inverse-cash-vp", { allowInverseObservation: true }) }),
        translationRule("inverse-equity", "EQUITY", "EQUITY", undefined, { valuationPolicy: valuationPolicy("inverse-equity-vp", { allowInverseObservation: true }) }),
      ]),
    });
    expect(compileConsolidation([noGlobalInverse], IDS.usd, request(noGlobalInverse, source([path("inverse", [step("USD", "EUR", 10n, 11n)])]), "vp-inverse-authority")).disposition).toBe("rejected");
  });

  test("enforces policy, mapping, rule, and derivation validity windows and identities", () => {
    const base = consolidationPolicy();
    const invalidPolicies: ConsolidationPolicy[] = [
      Object.freeze({ ...base, valuationPolicy: { ...base.valuationPolicy, validFrom: instant("2030-01-01T00:00:00Z") } }),
      Object.freeze({ ...base, accountMappings: base.accountMappings.map((mapping) => ({ ...mapping, validTo: instant("2026-01-01T00:00:00Z") })) }),
      Object.freeze({ ...base, translationRules: base.translationRules.map((rule) => ({ ...rule, validTo: instant("2026-01-01T00:00:00Z") })) }),
      Object.freeze({ ...base, translationRules: base.translationRules.map((rule, index) => index === 0 ? { ...rule, targetAccountId: account("OTHER") } : rule) }),
      Object.freeze({ ...base, translationRules: base.translationRules.map((rule) => ({ ...rule, valuationPolicy: { ...rule.valuationPolicy, maximumHops: 3n } })) }),
    ];
    for (const [index, policy] of invalidPolicies.entries()) expect(compileConsolidation([policy], IDS.usd, request(policy, source([directPath("direct")]), `vp-policy-${index}`)).disposition).toBe("rejected");
    const mismatched = { ...request(base, source([directPath("direct")]), "vp-lineage"), derivation: accountingDerivation };
    expect(compileConsolidation([base], IDS.usd, mismatched).disposition).toBe("rejected");
  });

  test("posts a balanced elimination set to evidence-declared target accounts and rejects unmatched or reused evidence", () => {
    const policy = consolidationPolicy();
    const baseRequest = request(policy, source([directPath("direct")]), "vp-elimination");
    const eliminations = [
      { id: "elim-ar", sourceBookId: "vp-book" as never, sourceAccountId: account("INTERCO-AR"), targetAccountId: account("GROUP-AR"), amount: ExactRational.of(-10n, 1n), evidenceIds: ["match"], sourcePostingIds: [identifier<"Posting">("source-ar")] },
      { id: "elim-ap", sourceBookId: "vp-book" as never, sourceAccountId: account("INTERCO-AP"), targetAccountId: account("GROUP-AP"), amount: ExactRational.of(10n, 1n), evidenceIds: ["match"], sourcePostingIds: [identifier<"Posting">("source-ap")] },
    ];
    const admitted = compileConsolidation([policy], IDS.usd, { ...baseRequest, eliminations });
    expect(admitted.disposition).toBe("draft");
    if (admitted.disposition === "draft") {
      expect(admitted.draft.journals[0]!.postings.some((posting) => posting.accountId === account("GROUP-AR") && posting.exactBookValue.equals(ExactRational.of(-10n, 1n)))).toBeTrue();
      expect(admitted.draft.journals[0]!.postings.some((posting) => posting.accountId === account("GROUP-AP") && posting.exactBookValue.equals(ExactRational.of(10n, 1n)))).toBeTrue();
    }
    expect(compileConsolidation([policy], IDS.usd, { ...baseRequest, eliminations: [eliminations[0]!] }).disposition).toBe("rejected");
    expect(compileConsolidation([policy], IDS.usd, { ...baseRequest, eliminations: [eliminations[0]!, { ...eliminations[1]!, sourcePostingIds: eliminations[0]!.sourcePostingIds }] }).disposition).toBe("rejected");
  });
});

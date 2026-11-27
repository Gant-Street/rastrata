import { expect, spyOn, test } from "bun:test";
import * as accountingRuntime from "../src/accounting.ts";
import {
  ExactDecimal as D, ExactRational as R, identifier, effectKey, semanticVersion, lotHoldingId, lotId, lotAllocationId,
  hashCanonical, canonicalAccountingValue, hashInventoryPostedAnchor, hashInventoryPostedPosition, prepareInventoryPostedReduction,
  bookId, commodityId, accountId, policyId, dimensionMemberId, ACCOUNTING_LIMITS,
  evidenceId,
  createCanonicalPostingReference, canonicalPostingReferenceId,
  prepareInventoryPostedReductionGroup, hashInventoryPostedReductionMovement, canonicalJournalValue,
  quantizeCumulativePostedShare,
  prepareInventoryReductionEffect, hashInventoryReductionOwnershipEffect,
  resolveInventoryOwnershipSources, prepareInventoryReductionEffectFromReadContext, immutableAccountingValue,
  prepareInventoryPostedAcquisitionGroup, hashInventoryPostedAcquisitionMovement,
  prepareInventoryPostedTransferGroup, prepareInventoryPostedAdoptionGroup,
  prepareInventoryOwnershipEffect, prepareInventoryOwnershipEffectFromReadContext, hashInventoryOwnershipEffect,
  prepareInventoryOwnershipSelection, hashAccountingPolicy, hashAccountingPolicySnapshot,
  encodeInventoryOwnershipArtifact, decodeInventoryOwnershipArtifact, validateInventoryOwnershipArtifact, INVENTORY_OWNERSHIP_CODEC_VERSION, encodeDurableBook, decodeDurableBook, decodeBookOutcome, decodeBookRow,
  executeBookCommand, sealCommand, commandId, instant, localDate, fiscalPeriodId, postingId,
  createBookState, dimensionId,
  type InventoryPostedAnchor, type InventoryPostedPosition, type InventoryPostedReductionOrigin,
  type InventoryPostedMovementReference, type LotHolding, type LotAllocation, type RoundingMode, type ContentHash,
  type InventoryPostedReductionEntry, type InventoryPostedReductionGroupContext, type InventoryReductionJournalSource,
  type InventoryReductionOperation, type InventoryPostedReductionSource, type JournalTransaction,
  type InventoryOwnershipArtifactKind, type InventoryOwnershipArtifactTypes, type InventoryPostedReductionMovement, type InventoryReductionOwnershipEffect,
  type InventoryOwnershipReadContext, type InventoryPostedPositionOrigin,
  type InventoryPostedAcquisitionEntry, type InventoryPostedAcquisitionContext, type InventoryPostedAcquisitionMovement,
  type InventoryPostedTransferEntry, type InventoryPostedTransferGroupContext,
  type InventoryPostedAdoptionEntry, type InventoryPostedAdoptionContext,
  type InventoryOwnershipOperation, type InventoryOwnershipEffect, type Lot,
  type InventoryCostPolicy, type InventoryOwnershipSelectionRequest,
  type InventoryPostedValueBudget,
} from "../src/index.ts";
import { IDS, quantizationPolicy, journal, freshState, resolved } from "./fixtures.ts";
import { accountingDerivation, capability, pool } from "./accounting-fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

const r = (n: bigint, d = 1n) => R.of(n, d);
function example(posted = "8.00", quantity = r(3n), basis = r(10n), allowance = r(-2n), roundingMode: RoundingMode = "halfEven") {
  const sourceJournal = journal("ownership-source");
  const sourcePosting = { ...sourceJournal.postings[0]!, bookValue: { amount: D.parse(posted), functionalCommodityId: IDS.usd } };
  const holding: LotHolding = { id: lotHoldingId("ownership-holding"), lotId: lotId("ownership-lot"), bookId: IDS.book, accountId: IDS.cash,
    commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: quantity, remainingTotalBasis: basis,
    remainingValuationAllowance: allowance, remainingCarryingAmount: basis.add(allowance) };
  const body: Omit<InventoryPostedAnchor, "contentHash"> = {
    id: identifier<"InventoryPostedAnchor">("anchor"), algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.0.0"),
    quantity, postedBudget: D.parse(posted), effectKey: effectKey("acquisition:ownership:0"), artifactOrdinal: 1n, bookRevision: 1n,
    coordinate: { bookId: holding.bookId, holdingId: holding.id, lotId: holding.lotId, accountId: holding.accountId,
      unitsCommodityId: holding.commodityId, functionalCommodityId: holding.basisCommodityId, dimensionMemberIds: [] },
    inventoryPolicy: { policyId: accountingDerivation.policyId, policyVersion: accountingDerivation.policyVersion, policyContentHash: hashCanonical({ policy: "inventory" }) },
    quantizationPolicy: { ...quantizationPolicy, roundingMode }, sourcePostings: D.parse(posted).isZero() ? [] : [createCanonicalPostingReference(canonicalPostingReferenceId("acquisition-source"), IDS.book, sourceJournal.id, sourcePosting, effectKey("source:journal:0"))],
    incomingMovements: [], evidence: accountingDerivation.evidence,
  };
  const anchor: InventoryPostedAnchor = { ...body, contentHash: hashInventoryPostedAnchor(body) };
  const positionBody: Omit<InventoryPostedPosition, "contentHash"> = {
    holdingId: holding.id, consumedQuantity: R.zero(), consumedPosted: D.parse("0.00"),
    anchor: { id: anchor.id, contentHash: anchor.contentHash, bookId: IDS.book, effectKey: anchor.effectKey, artifactOrdinal: anchor.artifactOrdinal, bookRevision: anchor.bookRevision },
    originMovementId: identifier<"InventoryPostedMovement">("acquisition"), originEffectKey: anchor.effectKey, originArtifactOrdinal: 2n, originBookRevision: 1n,
  };
  const position: InventoryPostedPosition = { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) };
  const allocation: LotAllocation = { id: lotAllocationId("allocation"), holdingId: holding.id, lotId: holding.lotId,
    allocatedQuantity: r(1n), allocatedTotalBasis: basis.divide(quantity), allocatedValuationAllowance: allowance.divide(quantity),
    allocatedCarryingAmount: basis.add(allowance).divide(quantity), derivation: accountingDerivation };
  const origin: InventoryPostedReductionOrigin = { movementId: identifier<"InventoryPostedMovement">("disposal"), effectKey: effectKey("disposal:ownership:0"), artifactOrdinal: 1n, bookRevision: 2n };
  return { anchor, position, holding, allocation, origin };
}
type Example = ReturnType<typeof example>;

function componentExample(posted = "8.00", basis = "10.00", allowance = "-2.00", quantity = r(3n)): Example {
  const f = example(posted, quantity, D.parse(basis).toRational(), D.parse(allowance).toRational());
  return rehashAnchor({ ...f, holding: { ...f.holding, commodityId: inventoryUnits } }, {
    algorithmVersion: semanticVersion("1.1.0"), postedValue: { basis: D.parse(basis), allowance: D.parse(allowance) },
    coordinate: { ...f.anchor.coordinate, unitsCommodityId: inventoryUnits },
  });
}

test("component-bearing anchor codec is explicit and reductions retain exact posted components", () => {
  const f = componentExample();
  const decoded = decodeInventoryOwnershipArtifact("anchor", encodeInventoryOwnershipArtifact("anchor", f.anchor));
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error("Expected component anchor");
  expect(decoded.artifact).toEqual(f.anchor);
  const result = prepare(f);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Expected component reduction");
  expect(result.reduction.postedValue?.consumed).toEqual({ basis: D.parse("3.34"), allowance: D.parse("-0.67") });
  expect(result.reduction.postedValue?.remaining).toEqual({ basis: D.parse("6.66"), allowance: D.parse("-1.33") });
  expect(result.reduction.postedAmount.toString()).toBe("-2.67");
  for (const patch of [
    { algorithmVersion: semanticVersion("1.0.0") },
    { algorithmVersion: semanticVersion("1.2.0") },
    { postedValue: undefined },
    { postedValue: { basis: D.parse("-10.00"), allowance: D.parse("-2.00") } },
    { postedValue: { basis: D.parse("11.00"), allowance: D.parse("-2.00") } },
  ]) {
    const invalid = rehashAnchor(f, patch);
    expect(prepare(invalid).disposition).toBe("rejected");
    expect(validateInventoryOwnershipArtifact("anchor", invalid.anchor)).toBe(false);
  }
  const old = example();
  expect(decodeInventoryOwnershipArtifact("anchor", encodeInventoryOwnershipArtifact("anchor", old.anchor)).disposition).toBe("decoded");
  expect(Object.hasOwn(old.anchor, "postedValue")).toBe(false);
  expect(prepare(old).disposition).toBe("prepared");
});

test("written-down transfer preserves posted and economic allowance without destination rerounding", () => {
  function input(f: Example) {
    const allocation = f.allocation;
    const destinationHolding: LotHolding = { ...f.holding, id: lotHoldingId("component-destination"), lotId: lotId("component-destination-lot"), accountId: IDS.revenue,
      remainingQuantity: allocation.allocatedQuantity, remainingTotalBasis: allocation.allocatedTotalBasis,
      remainingValuationAllowance: allocation.allocatedValuationAllowance, remainingCarryingAmount: allocation.allocatedCarryingAmount };
    const destinationLot: Lot = { id: destinationHolding.lotId, bookId: IDS.book, commodityId: inventoryUnits, basisCommodityId: IDS.usd,
      acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: destinationHolding.remainingQuantity,
      acquisitionTotalBasis: destinationHolding.remainingTotalBasis, evidenceIds: accountingDerivation.evidence.map((e) => e.id) };
    const entry: InventoryPostedTransferEntry = { source: f, allocation, destinationHolding, destinationLot, evidence: accountingDerivation.evidence,
      transferOutMovementId: identifier<"InventoryPostedMovement">("component-out"), destinationMovementId: identifier<"InventoryPostedMovement">("component-in"),
      destinationAnchorId: identifier<"InventoryPostedAnchor">("component-destination-anchor") };
    const context: InventoryPostedTransferGroupContext = { ...groupContext, effectKey: effectKey("component-transfer:ownership:0"),
      destinationInventoryPolicy: f.anchor.inventoryPolicy, destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: [] };
    return { entry, context };
  }
  const f = componentExample(), { entry, context } = input(f);
  const links = actualTransferJournal("2.67", r(1n), r(10n, 3n));
  const result = prepareInventoryPostedTransferGroup(context, [entry], links.sourceLink, links.destLink);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error(JSON.stringify(result.diagnostics));
  const anchor = result.group.destinationAnchors[0]!;
  expect(anchor.algorithmVersion).toBe(semanticVersion("1.1.0"));
  expect(anchor.postedValue).toEqual({ basis: D.parse("3.34"), allowance: D.parse("-0.67") });
  expect(anchor.postedBudget.toString()).toBe("2.67");
  expect(result.group.destinationHoldings[0]!.remainingValuationAllowance.toString()).toBe("-2/3");
  expect(decodeInventoryOwnershipArtifact("anchor", encodeInventoryOwnershipArtifact("anchor", anchor)).disposition).toBe("decoded");
  expect(prepareInventoryPostedTransferGroup(context, [{ ...entry, destinationHolding: { ...entry.destinationHolding, remainingValuationAllowance: R.zero() } }], links.sourceLink, links.destLink).disposition).toBe("rejected");
  const zero = input(componentExample("0.00", "0.01", "-0.01", r(1n)));
  const free = prepareInventoryPostedTransferGroup(zero.context, [zero.entry]);
  expect(free.disposition).toBe("prepared");
  if (free.disposition !== "prepared") throw new Error(JSON.stringify(free.diagnostics));
  expect(free.group.destinationAnchors[0]!.postedValue).toEqual({ basis: D.parse("0.01"), allowance: D.parse("-0.01") });
  expect(free.group.destinationMovements[0]!.monetaryKind).toBe("quantityOnly");
  const coarse = prepareInventoryPostedTransferGroup({ ...zero.context, destinationQuantizationPolicy: { ...quantizationPolicy, targetScale: 0n } }, [zero.entry]);
  expect(coarse.disposition).toBe("rejected");
  // The net zero is representable; rejection is specifically about its hidden
  // cent-denominated basis/allowance, which must not silently disappear.
});

type AnchorPatch = Partial<Omit<InventoryPostedAnchor, "postedValue">> & {
  postedValue?: InventoryPostedValueBudget | undefined;
};

const prepare = (f: Example) => prepareInventoryPostedReduction(f.anchor, f.position, f.holding, f.allocation, f.origin);
const rehashPosition = (f: Example, patch: Partial<InventoryPostedPosition>): Example => {
  const body = { ...f.position, ...patch };
  return { ...f, position: { ...body, contentHash: hashInventoryPostedPosition(body) } };
};
function rehashAnchor(f: Example, patch: AnchorPatch): Example {
  const body = { ...f.anchor, ...patch };
  if (patch.postedValue === undefined && "postedValue" in patch) {
    delete (body as { postedValue?: unknown }).postedValue;
  }
  const anchor: InventoryPostedAnchor = { ...body, contentHash: hashInventoryPostedAnchor(body as unknown as InventoryPostedAnchor) } as unknown as InventoryPostedAnchor;
  return rehashPosition({ ...f, anchor }, { anchor: { id: anchor.id, contentHash: anchor.contentHash, bookId: anchor.coordinate.bookId, effectKey: anchor.effectKey, artifactOrdinal: anchor.artifactOrdinal, bookRevision: anchor.bookRevision } });
}
function rejected(f: Example, path: string) {
  const before = hashCanonical(canonicalAccountingValue(f));
  const result = prepare(f);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Invalid ownership admitted");
  expect(result.diagnostics[0]?.path).toBe(path);
  expect(hashCanonical(canonicalAccountingValue(f))).toEqual(before);
}

// This exercises the production reduction planner, not command publication or
// source authenticity. The prospective profile is still disabled in BookCommand.
test("ownership reduction preserves exact written-down cost and telescopes actual posted money", () => {
  let f = example();
  const amounts: string[] = [], differences: string[] = [];
  for (let i = 0; i < 3; i++) {
    const before = hashCanonical(canonicalAccountingValue(f));
    const result = prepare(f);
    expect(result.disposition).toBe("prepared");
    if (result.disposition !== "prepared") throw new Error("Valid ownership rejected");
    const reduction = result.reduction;
    amounts.push(reduction.postedAmount.toString());
    differences.push(reduction.postedMinusEconomic.toString());
    expect(reduction.monetaryKind).toBe("journalLinked");
    expect(reduction.allocation.allocatedTotalBasis.equals(r(10n, 3n))).toBeTrue();
    expect(reduction.allocation.allocatedValuationAllowance.equals(r(-2n, 3n))).toBeTrue();
    expect(reduction.allocation.allocatedCarryingAmount.equals(r(8n, 3n))).toBeTrue();
    expect(reduction.beforePosition.contentHash).toEqual(f.position.contentHash);
    expect(reduction.afterPosition.anchor.contentHash).toEqual(f.anchor.contentHash);
    expect(reduction.afterPosition.contentHash).toEqual(hashInventoryPostedPosition(reduction.afterPosition));
    expect(hashCanonical(canonicalAccountingValue(f))).toEqual(before);
    expect(prepare(f)).toEqual(result);
    f = { ...f, holding: reduction.afterHolding, position: reduction.afterPosition,
      origin: { ...f.origin, movementId: identifier<"InventoryPostedMovement">(`disposal-${i + 1}`), bookRevision: f.origin.bookRevision + 1n } };
  }
  expect(amounts).toEqual(["-2.67", "-2.66", "-2.67"]);
  expect(differences).toEqual(["1/300", "-1/150", "1/300"]);
  expect(f.holding.remainingQuantity.isZero()).toBeTrue();
  expect(f.holding.remainingTotalBasis.isZero()).toBeTrue();
  expect(f.holding.remainingValuationAllowance.isZero()).toBeTrue();
  expect(f.holding.remainingCarryingAmount.isZero()).toBeTrue();
  expect(f.position.consumedPosted.toString()).toBe("8.00");
  rejected(f, "inventoryOwnership.quantity");
});

test("penny, free and directed-rounding reductions retain quantity-only terminal positions", () => {
  for (const [total, economic, mode, expected] of [
    ["0.01", r(1n, 100n), "halfEven", ["0.00", "-0.01", "0.00"]],
    ["0.00", R.zero(), "halfEven", ["0.00", "0.00", "0.00"]],
    ["0.01", r(1n, 100n), "ceiling", ["-0.01", "0.00", "0.00"]],
    ["0.01", r(1n, 100n), "floor", ["0.00", "0.00", "-0.01"]],
  ] as const) {
    let f = example(total, r(3n), economic, R.zero(), mode);
    const amounts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = prepare(f);
      if (result.disposition !== "prepared") throw new Error("Valid tiny reduction rejected");
      const reduction = result.reduction;
      amounts.push(reduction.postedAmount.toString());
      expect(reduction.monetaryKind).toBe(reduction.postedAmount.isZero() ? "quantityOnly" : "journalLinked");
      expect(Object.keys(reduction)).not.toContain("journal");
      expect(Object.keys(reduction)).not.toContain("posting");
      expect(reduction.afterHolding.remainingQuantity.equals(r(BigInt(2 - i)))).toBeTrue();
      f = { ...f, holding: reduction.afterHolding, position: reduction.afterPosition,
        origin: { ...f.origin, movementId: identifier<"InventoryPostedMovement">(`tiny-${i}`), bookRevision: f.origin.bookRevision + 1n } };
    }
    expect(amounts).toEqual([...expected]);
    expect(f.position.consumedPosted.toString()).toBe(total);
    expect(f.position.anchor.id).toBe(f.anchor.id);
    expect(f.anchor.quantity.equals(r(3n))).toBeTrue();
  }
});

test("ownership hashes bind complete content and the after-image uses an acyclic origin locator", () => {
  const f = example();
  for (const mutation of [
    { algorithm: "sha512" }, { canonicalizationVersion: "v2" }, { digest: "0".repeat(64) },
  ]) {
    rejected({ ...f, anchor: { ...f.anchor, contentHash: { ...f.anchor.contentHash, ...mutation } as ContentHash } }, "inventoryOwnership.hash");
    rejected({ ...f, position: { ...f.position, contentHash: { ...f.position.contentHash, ...mutation } as ContentHash } }, "inventoryOwnership.hash");
  }
  rejected(rehashAnchor(f, { algorithmVersion: semanticVersion("2.0.0") }), "inventoryOwnership.hash");
  rejected(rehashAnchor(f, { algorithm: "other" as InventoryPostedAnchor["algorithm"] }), "inventoryOwnership.hash");
  expect(hashInventoryPostedAnchor({ ...f.anchor, quantity: r(4n) })).not.toEqual(f.anchor.contentHash);
  expect(hashInventoryPostedPosition({ ...f.position, originMovementId: identifier<"InventoryPostedMovement">("different") })).not.toEqual(f.position.contentHash);
  const result = prepare(f);
  if (result.disposition !== "prepared") throw new Error("Valid reduction rejected");
  expect(Object.keys(result.reduction.afterPosition).sort()).toEqual(["holdingId", "consumedQuantity", "consumedPosted", "contentHash", "anchor", "originMovementId", "originEffectKey", "originArtifactOrdinal", "originBookRevision"].sort());
  expect(result.reduction.afterPosition.originMovementId).toBe(f.origin.movementId);
});

test("rehashing cannot detach ownership from its exact anchor or make forward origins admissible", () => {
  const f = example();
  for (const patch of [
    { id: identifier<"InventoryPostedAnchor">("wrong") }, { contentHash: hashCanonical({ wrong: true }) },
    { bookId: bookId("foreign") }, { effectKey: effectKey("other") }, { artifactOrdinal: 2n }, { bookRevision: 2n },
  ]) rejected(rehashPosition(f, { anchor: { ...f.position.anchor, ...patch } }), "inventoryOwnership.lineage");
  for (const patch of [
    { bookRevision: 0n }, { artifactOrdinal: 0n }, { effectKey: "" as InventoryPostedReductionOrigin["effectKey"] },
    { movementId: "" as InventoryPostedReductionOrigin["movementId"] }, { movementId: f.position.originMovementId },
    { bookRevision: 1n }, { bookRevision: 1n, effectKey: f.position.originEffectKey, artifactOrdinal: 2n },
  ]) rejected({ ...f, origin: { ...f.origin, ...patch } }, "inventoryOwnership.lineage");
  for (const patch of [{ originArtifactOrdinal: 1n }, { originArtifactOrdinal: 0n }, { originBookRevision: 0n }, { originMovementId: "" as InventoryPostedPosition["originMovementId"] }]) {
    rejected(rehashPosition(f, patch), "inventoryOwnership.lineage");
  }
  for (const patch of [{ artifactOrdinal: 0n }, { bookRevision: 0n }]) rejected(rehashAnchor(f, patch), "inventoryOwnership.lineage");
  const sameCommand = prepare({ ...f, origin: { ...f.origin, bookRevision: 1n, effectKey: f.anchor.effectKey, artifactOrdinal: 3n } });
  expect(sameCommand.disposition).toBe("prepared");
});

test("source references reject duplicates, foreign or forward artifacts and unsupported full hashes", () => {
  const f = example();
  const incoming: InventoryPostedMovementReference = { id: identifier<"InventoryPostedMovement">("incoming"), bookId: IDS.book, contentHash: hashCanonical({ incoming: true }), effectKey: f.anchor.effectKey, artifactOrdinal: 1n, bookRevision: 1n };
  const later = rehashPosition(rehashAnchor(f, { artifactOrdinal: 2n, incomingMovements: [incoming] }), { originArtifactOrdinal: 3n });
  expect(prepare(later).disposition).toBe("prepared");
  expect(prepare(rehashAnchor(later, { predecessorPosition: { ...incoming, id: f.holding.id } })).disposition).toBe("prepared");
  for (const patch of [
    { incomingMovements: [incoming, incoming] }, { incomingMovements: [{ ...incoming, bookId: bookId("foreign") }] },
    { incomingMovements: [{ ...incoming, artifactOrdinal: 2n }] }, { incomingMovements: [{ ...incoming, bookRevision: 3n }] },
    { incomingMovements: [{ ...incoming, id: "" as InventoryPostedMovementReference["id"] }] },
    { sourcePostings: [f.anchor.sourcePostings[0]!, f.anchor.sourcePostings[0]!] },
    { sourcePostings: [{ ...f.anchor.sourcePostings[0]!, bookId: bookId("foreign") }] },
    { sourcePostings: [{ ...f.anchor.sourcePostings[0]!, contentHash: hashCanonical({ wrong: true }) }] },
    { evidence: [accountingDerivation.evidence[0]!, accountingDerivation.evidence[0]!] },
    { sourcePostings: [], incomingMovements: [], evidence: [] },
  ]) rejected(rehashAnchor(later, patch), "inventoryOwnership.sources");
  for (const mutation of [{ algorithm: "sha512" }, { canonicalizationVersion: "v2" }, { digest: "not-a-hash" }]) {
    const invalid = { ...incoming.contentHash, ...mutation } as ContentHash;
    rejected(rehashAnchor(later, { incomingMovements: [{ ...incoming, contentHash: invalid }] }), "inventoryOwnership.sources");
    rejected(rehashAnchor(f, { evidence: [{ ...accountingDerivation.evidence[0]!, contentHash: invalid }] }), "inventoryOwnership.sources");
    rejected(rehashAnchor(f, { inventoryPolicy: { ...f.anchor.inventoryPolicy, policyContentHash: invalid } }), "inventoryOwnership.lineage");
  }
});

test("ownership rejects coordinate and dimension substitution without erasing currency units", () => {
  const f = example();
  for (const patch of [
    { holdingId: lotHoldingId("other") }, { lotId: lotId("other") }, { accountId: accountId("other") },
    { bookId: bookId("other") }, { unitsCommodityId: commodityId("other") }, { functionalCommodityId: commodityId("EUR") },
    { dimensionMemberIds: [dimensionMemberId("z"), dimensionMemberId("a")] }, { dimensionMemberIds: [dimensionMemberId("a"), dimensionMemberId("a")] },
  ]) {
    const changed = rehashAnchor(f, { coordinate: { ...f.anchor.coordinate, ...patch } });
    // A foreign book also makes the retained source reference foreign; test that
    // earlier structural source failure instead of hiding it with a broad oracle.
    rejected(changed, "bookId" in patch ? "inventoryOwnership.sources" : "inventoryOwnership.coordinate");
  }
  rejected(rehashPosition(f, { holdingId: lotHoldingId("other") }), "inventoryOwnership.coordinate");
  for (const patch of [{ bookId: bookId("other") }, { functionalCommodityId: commodityId("other") }]) {
    rejected(rehashAnchor(f, { quantizationPolicy: { ...f.anchor.quantizationPolicy, ...patch } }), "inventoryOwnership.coordinate");
  }
  expect(prepare(rehashAnchor(f, { coordinate: { ...f.anchor.coordinate, dimensionMemberIds: [dimensionMemberId("a"), dimensionMemberId("z")] } })).disposition).toBe("prepared");
});

test("exact holding quantities, cumulative posted consumption and economic allocations are jointly enforced", () => {
  const f = example();
  for (const quantity of [R.zero(), r(-1n)]) rejected(rehashAnchor(f, { quantity }), "inventoryOwnership.quantity");
  for (const consumedQuantity of [r(-1n), r(4n), r(1n)]) rejected(rehashPosition(f, { consumedQuantity }), "inventoryOwnership.quantity");
  for (const quantity of [R.zero(), r(-1n), r(4n)]) rejected({ ...f, allocation: { ...f.allocation, allocatedQuantity: quantity } }, "inventoryOwnership.quantity");
  for (const patch of [{ holdingId: lotHoldingId("other") }, { lotId: lotId("other") }]) rejected({ ...f, allocation: { ...f.allocation, ...patch } }, "inventoryOwnership.quantity");
  for (const value of [D.parse("-0.01"), D.parse("0.01"), D.parse("8.00")]) rejected(rehashPosition(f, { consumedPosted: value }), "inventoryOwnership.consumedPosted");
  for (const key of ["allocatedTotalBasis", "allocatedValuationAllowance", "allocatedCarryingAmount"] as const) {
    rejected({ ...f, allocation: { ...f.allocation, [key]: f.allocation[key].add(r(1n)) } }, "inventoryOwnership.allocation");
  }
  for (const patch of [
    { remainingTotalBasis: r(-1n) }, { remainingValuationAllowance: r(1n) }, { remainingCarryingAmount: r(-1n) }, { remainingCarryingAmount: r(9n) },
  ]) rejected({ ...f, holding: { ...f.holding, ...patch } }, "inventoryOwnership.allocation");
  // Decimal representation does not change the cumulative money equation.
  expect(prepare(rehashPosition(f, { consumedPosted: D.parse("0.000") })).disposition).toBe("prepared");
});

test("posted budgets cannot be silently rerounded or admitted under an unsupported quantizer", () => {
  const f = example();
  for (const total of ["-0.01", "8.001"]) {
    rejected(rehashAnchor(f, { postedBudget: D.parse(total) }), total.startsWith("-") ? "cumulativePostedShare" : "cumulativePostedShare.postedTotal");
  }
  for (const patch of [{ targetScale: -1n }, { targetScale: 1001n }, { roundingMode: "unknown" as RoundingMode }]) {
    rejected(rehashAnchor(f, { quantizationPolicy: { ...f.anchor.quantizationPolicy, ...patch } }), "cumulativePostedShare");
  }
});

test("per-artifact population limits fail before hashing and reductions own all output data", () => {
  const f = example();
  const over = ACCOUNTING_LIMITS.maxInventoryLayers + 1;
  for (const field of ["sourcePostings", "incomingMovements", "evidence"] as const) {
    // No rehash: the resource guard must precede hash traversal.
    const result = prepare({ ...f, anchor: { ...f.anchor, [field]: new Array(over) } });
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Oversized anchor admitted");
    expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.anchor");
  }
  const tooManyDimensions = prepare({ ...f, anchor: { ...f.anchor, coordinate: { ...f.anchor.coordinate, dimensionMemberIds: new Array(over) } } });
  expect(tooManyDimensions.disposition).toBe("rejected");
  const mutableDerivation = { ...f.allocation.derivation, inputHash: { ...f.allocation.derivation.inputHash } };
  const mutablePosition = { ...f.position, anchor: { ...f.position.anchor, contentHash: { ...f.position.anchor.contentHash } } };
  const result = prepare({ ...f, position: mutablePosition, allocation: { ...f.allocation, derivation: mutableDerivation } });
  if (result.disposition !== "prepared") throw new Error("Valid mutable input rejected");
  const hash = hashCanonical(canonicalAccountingValue(result));
  mutableDerivation.inputHash.digest = "f".repeat(64);
  mutablePosition.anchor.contentHash.digest = "e".repeat(64);
  expect(hashCanonical(canonicalAccountingValue(result))).toEqual(hash);
  for (const value of [result, result.reduction, result.reduction.afterHolding, result.reduction.afterPosition, result.reduction.afterPosition.anchor, result.reduction.beforePosition.contentHash, result.reduction.allocation.derivation, result.reduction.reductionProof.policy]) expect(Object.isFrozen(value)).toBeTrue();
});

test("the combined source-population cap admits its exact boundary and refuses one additional reference", () => {
  const f = example();
  const evidence = Array.from({ length: ACCOUNTING_LIMITS.maxInventoryLayers - 1 }, (_, i) => ({ ...accountingDerivation.evidence[0]!, id: evidenceId(`evidence-${i}`) }));
  const atLimit = rehashAnchor(f, { evidence });
  expect(atLimit.anchor.evidence.length + atLimit.anchor.sourcePostings.length).toBe(ACCOUNTING_LIMITS.maxInventoryLayers);
  expect(prepare(atLimit).disposition).toBe("prepared");
  // Each separate array still fits; only the complete fan-in exceeds the bound.
  const overLimit = { ...atLimit, anchor: { ...atLimit.anchor, evidence: [...evidence, { ...accountingDerivation.evidence[0]!, id: evidenceId("one-too-many") }] } };
  const result = prepare(overLimit);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Combined source overflow admitted");
  expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.anchor");
});

test("unequal ownership reductions conserve every posted coefficient under all five rounding modes", () => {
  // Independent positive-integer rounding oracle: no production quantizer is
  // used for the expected cumulative coefficient or adjacent posted differences.
  function rounded(n: bigint, d: bigint, mode: RoundingMode): bigint {
    const q = n / d, remainder = n % d;
    if (remainder === 0n || mode === "floor" || mode === "towardZero") return q;
    if (mode === "ceiling") return q + 1n;
    if (2n * remainder < d) return q;
    if (2n * remainder > d || mode === "halfAwayFromZero" || q % 2n !== 0n) return q + 1n;
    return q;
  }
  for (const mode of ["halfEven", "halfAwayFromZero", "towardZero", "floor", "ceiling"] as const) {
    for (const scale of [0n, 2n, 4n]) {
      for (const budget of [0n, 1n, 7n, 1000n]) {
        const quantity = r(10n), originalBasis = r(25n, 17n), originalAllowance = r(-6n, 17n);
        let f = example(D.of(budget, scale).toString(), quantity, originalBasis, originalAllowance, mode);
        f = rehashAnchor(f, { quantizationPolicy: { ...f.anchor.quantizationPolicy, targetScale: scale } });
        let consumed = 0n, posted = 0n, economic = R.zero();
        for (const [i, part] of [1n, 2n, 2n, 5n].entries()) {
          const allocatedBasis = originalBasis.multiply(r(part, 10n)), allocatedAllowance = originalAllowance.multiply(r(part, 10n));
          f = { ...f, allocation: { ...f.allocation, id: lotAllocationId(`allocation-${i}`), allocatedQuantity: r(part), allocatedTotalBasis: allocatedBasis,
            allocatedValuationAllowance: allocatedAllowance, allocatedCarryingAmount: allocatedBasis.add(allocatedAllowance) } };
          const result = prepare(f);
          expect(result.disposition).toBe("prepared");
          if (result.disposition !== "prepared") throw new Error("Valid unequal reduction rejected");
          consumed += part;
          const expected = rounded(budget * consumed, 10n, mode);
          expect(result.reduction.postedAmount.coefficient).toBe(posted - expected);
          expect(result.reduction.postedAmount.scale).toBe(scale);
          expect(result.reduction.afterPosition.consumedPosted.coefficient).toBe(expected);
          expect(result.reduction.afterPosition.consumedQuantity.equals(r(consumed))).toBeTrue();
          expect(result.reduction.afterHolding.remainingQuantity.equals(r(10n - consumed))).toBeTrue();
          expect(result.reduction.monetaryKind).toBe(expected === posted ? "quantityOnly" : "journalLinked");
          expect(result.reduction.postedMinusEconomic.equals(D.of(expected - posted, scale).toRational().subtract(allocatedBasis.add(allocatedAllowance)))).toBeTrue();
          posted = expected;
          economic = economic.add(result.reduction.allocation.allocatedCarryingAmount);
          f = { ...f, position: result.reduction.afterPosition, holding: result.reduction.afterHolding,
            origin: { ...f.origin, movementId: identifier<"InventoryPostedMovement">(`unequal-${i}`), bookRevision: f.origin.bookRevision + 1n } };
        }
        expect(posted).toBe(budget);
        expect(economic.equals(originalBasis.add(originalAllowance))).toBeTrue();
        expect(f.holding.remainingTotalBasis.isZero()).toBeTrue();
        expect(f.holding.remainingValuationAllowance.isZero()).toBeTrue();
        expect(f.holding.remainingCarryingAmount.isZero()).toBeTrue();
      }
    }
  }
});

const groupContext: InventoryPostedReductionGroupContext = {
  bookId: IDS.book, commandId: commandId("group-command"), kind: "disposal", effectKey: effectKey("group-command:inventoryOwnership:0"),
  bookRevision: 2n, firstArtifactOrdinal: 1n, accountingDate: localDate("2026-01-15"), fiscalPeriodId: IDS.period1,
};
const inventoryUnits = commodityId("ITEM");
function groupEntry(value: string, index: number): InventoryPostedReductionEntry {
  const exact = D.parse(value).toRational();
  let f = example(value, r(3n), exact, R.zero());
  const holdingId = lotHoldingId(`holding-${index}`), lotIdentity = lotId(`lot-${index}`);
  f = { ...f, holding: { ...f.holding, id: holdingId, lotId: lotIdentity, commodityId: inventoryUnits }, allocation: { ...f.allocation, id: lotAllocationId(`allocation-${index}`), holdingId, lotId: lotIdentity } };
  const history = journal(`ownership-history-${index}`);
  const historicalPosting = { ...history.postings[0]!, units: { canonicalNumber: r(3n), commodityId: inventoryUnits }, bookValue: { amount: D.parse(value), functionalCommodityId: IDS.usd } };
  f = rehashAnchor(f, { id: identifier<"InventoryPostedAnchor">(`anchor-${index}`), artifactOrdinal: BigInt(2 * index + 1),
    coordinate: { ...f.anchor.coordinate, holdingId, lotId: lotIdentity, unitsCommodityId: inventoryUnits },
    sourcePostings: D.parse(value).isZero() ? [] : [createCanonicalPostingReference(canonicalPostingReferenceId(`ownership-history-${index}`), IDS.book, history.id, historicalPosting, effectKey(`ownership-history:journal:${index}`))] });
  f = rehashPosition(f, { holdingId, originMovementId: identifier<"InventoryPostedMovement">(`acquisition-${index}`), originArtifactOrdinal: BigInt(2 * index + 2) });
  return { anchor: f.anchor, position: f.position, holding: f.holding, allocation: f.allocation, movementId: identifier<"InventoryPostedMovement">(`reduction-${index}`) };
}
function actualGroupJournal(amount: string, quantity: R, basis: R, dimensionNames: readonly string[] = []) {
  // The money journal is admitted by the actual canonical command evaluator.
  // Historical ownership inputs above are prospective fixtures, not a claim
  // that those anchors already exist in this book or were durably authenticated.
  const base = journal("group-journal");
  const value = D.parse(amount);
  const inventory = { ...base.postings[0]!, units: { canonicalNumber: quantity.negate(), commodityId: inventoryUnits },
    bookValue: { amount: D.of(-value.coefficient, value.scale), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: basis.negate(), basisCommodityId: IDS.usd }, dimensionMemberIds: dimensionNames.map(dimensionMemberId) };
  const cost = { ...base.postings[1]!, units: { canonicalNumber: quantity, commodityId: inventoryUnits }, bookValue: { amount: value, functionalCommodityId: IDS.usd } };
  const source = admittedGroupSource({ ...base, postings: [inventory, cost] }, dimensionNames);
  return { source, postingId: inventory.id, referenceId: canonicalPostingReferenceId("group-inventory-source") };
}
function actualTransferJournal(amount: string, quantity: R, basis: R, sourceDims: readonly string[] = [], destDims: readonly string[] = []) {
  const base = journal("transfer-group-journal");
  const value = D.parse(amount);
  const sourcePosting = {
    ...base.postings[0]!,
    accountId: IDS.cash,
    units: { canonicalNumber: quantity.negate(), commodityId: inventoryUnits },
    bookValue: { amount: D.of(-value.coefficient, value.scale), functionalCommodityId: IDS.usd },
    costBasis: { totalBasis: basis.negate(), basisCommodityId: IDS.usd },
    dimensionMemberIds: sourceDims.map(dimensionMemberId),
  };
  const destPosting = {
    ...base.postings[1]!,
    accountId: IDS.revenue,
    units: { canonicalNumber: quantity, commodityId: inventoryUnits },
    bookValue: { amount: value, functionalCommodityId: IDS.usd },
    costBasis: { totalBasis: basis, basisCommodityId: IDS.usd },
    dimensionMemberIds: destDims.map(dimensionMemberId),
  };
  const source = admittedGroupSource({ ...base, postings: [sourcePosting, destPosting] }, [...new Set([...sourceDims, ...destDims])]);
  return {
    sourceLink: { source, postingId: sourcePosting.id, referenceId: canonicalPostingReferenceId("transfer-src-source") },
    destLink: { source, postingId: destPosting.id, referenceId: canonicalPostingReferenceId("transfer-dest-source") },
  };
}
function admittedGroupSource(value: JournalTransaction, dimensionNames: readonly string[] = []) {
  return admittedGroupExecution(value, dimensionNames).state.journals[0]!;
}
function admittedGroupExecution(value: JournalTransaction, dimensionNames: readonly string[] = []) {
  const initial = freshState();
  const state = createBookState(initial.state.identity, initial.state.periods, {
    ...initial.state.admissionSnapshot,
    accounts: initial.state.admissionSnapshot.accounts.map((account) => ({ ...account, allowedCommodityIds: [...account.allowedCommodityIds, inventoryUnits] })),
    dimensions: dimensionNames.map((name) => ({ id: dimensionId(`dimension-${name}`), bookId: IDS.book, code: name, name, openedOn: localDate("2020-01-01") })),
    dimensionMembers: dimensionNames.map((name) => ({ id: dimensionMemberId(name), dimensionId: dimensionId(`dimension-${name}`), code: name, name, openedOn: localDate("2020-01-01") })),
  }, initial.state.policies, initial.state.quantizationPolicies, [], instant("2020-01-01T00:00:00Z"));
  const activated = executeBookCommand(state, initial.protocol, activationCommand());
  const command = sealCommand({ id: groupContext.commandId, type: "postJournal" as const, bookId: IDS.book, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"), expectedBookRevision: 1n,
    issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"), resolved: resolved(value) });
  const committed = executeBookCommand(activated.state, activated.protocol, command);
  expect(committed.result.disposition).toBe("committed");
  if (committed.result.disposition !== "committed") throw new Error("Source journal must really be admitted");
  return committed;
}
function groupRejected(context: InventoryPostedReductionGroupContext, entries: readonly InventoryPostedReductionEntry[], link: Parameters<typeof prepareInventoryPostedReductionGroup>[2], path: string) {
  const before = hashCanonical(canonicalAccountingValue({ context, entries, link }));
  const result = prepareInventoryPostedReductionGroup(context, entries, link);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Invalid reduction group admitted");
  expect(result.diagnostics[0]?.path).toBe(path);
  expect(hashCanonical(canonicalAccountingValue({ context, entries, link }))).toEqual(before);
}

test("canonical money-bearing movements share a real posting only with complete amount, units and basis attribution", () => {
  const entries = [groupEntry("8.00", 0), groupEntry("8.00", 1)];
  const link = actualGroupJournal("5.34", r(2n), r(16n, 3n));
  const result = prepareInventoryPostedReductionGroup(groupContext, entries, link);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Valid money group rejected");
  expect(result.group.postedAmount.toString()).toBe("-267/50");
  expect(result.group.quantity.toString()).toBe("2/1");
  expect(result.group.historicalBasis.toString()).toBe("16/3");
  expect(result.group.movements.length).toBe(2);
  for (const [index, movement] of result.group.movements.entries()) {
    expect(movement.monetaryKind).toBe("journalLinked");
    if (movement.monetaryKind !== "journalLinked") throw new Error("Money requires a real reference");
    expect(movement.postedAmount.toString()).toBe("-2.67");
    expect(movement.posting).toEqual(createCanonicalPostingReference(link.referenceId, IDS.book, link.source.journal.id, link.source.journal.postings[0]!, effectKey(link.source.effectKey)));
    expect(movement.artifactOrdinal).toBe(BigInt(index + 1));
    expect(movement.afterPosition.originArtifactOrdinal).toBe(movement.artifactOrdinal);
    expect(movement.afterPosition.originMovementId).toBe(movement.id);
    expect(movement.contentHash).toEqual(hashInventoryPostedReductionMovement(movement));
    expect(movement.quantityAllocation.allocatedQuantity.toString()).toBe("1/1");
    expect(result.group.afterHoldings[index]!.remainingQuantity.toString()).toBe("2/1");
  }
  expect(prepareInventoryPostedReductionGroup(groupContext, entries, link)).toEqual(result);
  expect(prepareInventoryPostedReductionGroup(groupContext, [...entries].reverse(), link)).toEqual(result);
  const transferred = prepareInventoryPostedReductionGroup({ ...groupContext, kind: "transferOut" }, entries, link);
  if (transferred.disposition !== "prepared") throw new Error("Valid source transfer group rejected");
  expect(transferred.group.movements[0]!.contentHash).not.toEqual(result.group.movements[0]!.contentHash);
  expect(transferred.group.movements[0]!.kind).toBe("transferOut");
});

test("mixed groups include zero-money quantity and basis without fabricating a posting reference on that movement", () => {
  const entries = [groupEntry("0.01", 0), groupEntry("0.02", 1)];
  const link = actualGroupJournal("0.01", r(2n), r(1n, 100n));
  const result = prepareInventoryPostedReductionGroup(groupContext, entries, link);
  if (result.disposition !== "prepared") throw new Error("Valid mixed group rejected");
  expect(result.group.movements.map((m) => m.monetaryKind)).toEqual(["quantityOnly", "journalLinked"]);
  const zero = result.group.movements[0]!, money = result.group.movements[1]!;
  expect(zero.postedAmount.toString()).toBe("0.00");
  expect(Object.hasOwn(zero, "posting")).toBeFalse();
  expect(zero.quantityAllocation.allocatedQuantity.toString()).toBe("1/1");
  expect(zero.quantityAllocation.allocatedTotalBasis.toString()).toBe("1/300");
  expect(money.postedAmount.toString()).toBe("-0.01");
  expect(result.group.historicalBasis.toString()).toBe("1/100");
  expect(result.group.quantity.toString()).toBe("2/1");
  expect(result.group.afterHoldings.map((holding) => holding.remainingQuantity.toString())).toEqual(["2/1", "2/1"]);
  // Omitting zero-valued physical/basis shares is not valid attribution even
  // though the actual money and the individual money-bearing share still agree.
  for (const patch of [{ units: { canonicalNumber: r(-1n), commodityId: inventoryUnits } }, { costBasis: { totalBasis: r(-1n, 150n), basisCommodityId: IDS.usd } }]) {
    const changedJournal = { ...link.source.journal, postings: link.source.journal.postings.map((p) => p.id === link.postingId ? { ...p, ...patch } : p) };
    groupRejected(groupContext, entries, { ...link, source: { ...link.source, journal: changedJournal, canonicalHash: hashCanonical(canonicalJournalValue(changedJournal)) } }, "inventoryOwnership.postingAttribution");
  }
});

test("an all-zero group produces only quantity movements and forbids any supplied posting link", () => {
  const entries = [groupEntry("0.01", 0), groupEntry("0.01", 1)];
  const result = prepareInventoryPostedReductionGroup(groupContext, entries);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Valid quantity group rejected");
  expect(result.group.postedAmount.isZero()).toBeTrue();
  expect(result.group.quantity.toString()).toBe("2/1");
  expect(result.group.movements.every((movement) => movement.monetaryKind === "quantityOnly" && !Object.hasOwn(movement, "posting"))).toBeTrue();
  const link = actualGroupJournal("0.01", r(2n), r(1n, 150n));
  groupRejected(groupContext, entries, link, "inventoryOwnership.posting");
  groupRejected(groupContext, [groupEntry("8.00", 0)], undefined, "inventoryOwnership.posting");
});

test("group admission rejects duplicate identities, malformed origins and incompatible coordinates before returning any movements", () => {
  const entries = [groupEntry("0.01", 0), groupEntry("0.01", 1)], first = entries[0]!, second = entries[1]!;
  groupRejected(groupContext, [], undefined, "inventoryOwnership.group");
  for (const patch of [{ kind: "acquisition" as InventoryPostedReductionGroupContext["kind"] }, { bookRevision: 0n }, { firstArtifactOrdinal: 0n }, { effectKey: "" as InventoryPostedReductionGroupContext["effectKey"] }, { commandId: "" as InventoryPostedReductionGroupContext["commandId"] }]) {
    groupRejected({ ...groupContext, ...patch }, entries, undefined, "inventoryOwnership.groupIdentity");
  }
  for (const patch of [{ holding: first.holding }, { anchor: first.anchor }, { allocation: first.allocation }, { movementId: first.movementId }]) {
    groupRejected(groupContext, [first, { ...second, ...patch }], undefined, "inventoryOwnership.groupIdentity");
  }
  for (const patch of [{ bookId: bookId("foreign") }, { accountId: accountId("other") }, { unitsCommodityId: commodityId("other") }, { functionalCommodityId: commodityId("EUR") },
    { dimensionMemberIds: [dimensionMemberId("a")] }]) {
    groupRejected(groupContext, [first, { ...second, anchor: { ...second.anchor, coordinate: { ...second.anchor.coordinate, ...patch } } }], undefined, "inventoryOwnership.groupCoordinate");
  }
  groupRejected(groupContext, [first, { ...second, allocation: { ...second.allocation, allocatedQuantity: r(4n) } }], undefined, "inventoryOwnership.quantity");
});

test("journal linkage rejects forged context, hashes, missing postings and mismatched exact inventory coordinates", () => {
  const entries = [groupEntry("8.00", 0)], link = actualGroupJournal("2.67", r(1n), r(8n, 3n));
  for (const patch of [{ commandId: commandId("other") }, { bookRevision: 3n }, { fiscalPeriodId: fiscalPeriodId("other") }, { effectKey: "" }, { effectKey: groupContext.effectKey }, { canonicalHash: hashCanonical({ wrong: true }) }]) {
    groupRejected(groupContext, entries, { ...link, source: { ...link.source, ...patch } }, "inventoryOwnership.journalSource");
  }
  for (const patch of [{ bookId: bookId("foreign") }, { functionalCommodityId: commodityId("EUR") }, { accountingDate: localDate("2026-01-16") }]) {
    const changed = { ...link.source.journal, ...patch };
    groupRejected(groupContext, entries, { ...link, source: { ...link.source, journal: changed, canonicalHash: hashCanonical(canonicalJournalValue(changed)) } }, "inventoryOwnership.journalSource");
  }
  groupRejected(groupContext, entries, { ...link, postingId: postingId("absent") }, "inventoryOwnership.posting");
  const duplicate = { ...link.source.journal, postings: [...link.source.journal.postings, link.source.journal.postings[0]!] };
  groupRejected(groupContext, entries, { ...link, source: { ...link.source, journal: duplicate, canonicalHash: hashCanonical(canonicalJournalValue(duplicate)) } }, "inventoryOwnership.posting");
  const actual = link.source.journal.postings[0]!;
  for (const patch of [
    { accountId: accountId("other") }, { units: { ...actual.units, commodityId: commodityId("other") } },
    { bookValue: { ...actual.bookValue, functionalCommodityId: commodityId("other") } }, { dimensionMemberIds: [dimensionMemberId("a")] },
    { bookValue: { ...actual.bookValue, amount: D.parse("-2.66") } }, { bookValue: { ...actual.bookValue, amount: D.parse("2.67") } },
    { units: { ...actual.units, canonicalNumber: r(-2n) } }, { costBasis: { ...actual.costBasis!, basisCommodityId: commodityId("other") } },
    { costBasis: { ...actual.costBasis!, totalBasis: r(-1n) } },
  ]) {
    const changed = { ...link.source.journal, postings: [{ ...actual, ...patch }, link.source.journal.postings[1]!] };
    groupRejected(groupContext, entries, { ...link, source: { ...link.source, journal: changed, canonicalHash: hashCanonical(canonicalJournalValue(changed)) } }, "inventoryOwnership.postingAttribution");
  }
  const { costBasis: _costBasis, ...withoutBasis } = actual;
  const missingBasis = { ...link.source.journal, postings: [withoutBasis, link.source.journal.postings[1]!] };
  groupRejected(groupContext, entries, { ...link, source: { ...link.source, journal: missingBasis, canonicalHash: hashCanonical(canonicalJournalValue(missingBasis)) } }, "inventoryOwnership.postingAttribution");
});

test("reduction groups bound total source work and own their full canonical movement data", () => {
  const entry = groupEntry("8.00", 0), link = actualGroupJournal("2.67", r(1n), r(8n, 3n));
  for (const [entries, source] of [
    [new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1), undefined],
    [[entry], { ...link, source: { ...link.source, journal: { ...link.source.journal, postings: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) } } }],
  ] as const) {
    const result = prepareInventoryPostedReductionGroup(groupContext, entries, source);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Oversized group admitted");
    expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.group");
  }
  const halfCap = Array.from({ length: ACCOUNTING_LIMITS.maxInventoryLayers / 2 }, () => accountingDerivation.evidence[0]!);
  const two = [entry, groupEntry("8.00", 1)].map((value) => ({ ...value, anchor: { ...value.anchor, evidence: halfCap } }));
  groupRejected(groupContext, two, undefined, "inventoryOwnership.group");
  const mutableSource: InventoryReductionJournalSource = { ...link.source, journal: { ...link.source.journal, postings: link.source.journal.postings.map((p) => ({ ...p, dimensionMemberIds: [...p.dimensionMemberIds] })) } };
  const result = prepareInventoryPostedReductionGroup(groupContext, [entry], { ...link, source: mutableSource });
  if (result.disposition !== "prepared") throw new Error("Valid group rejected");
  const fingerprint = hashCanonical(canonicalAccountingValue(result));
  (mutableSource.journal.postings[0]!.dimensionMemberIds as ReturnType<typeof dimensionMemberId>[]).push(dimensionMemberId("later-mutation"));
  expect(hashCanonical(canonicalAccountingValue(result))).toEqual(fingerprint);
  const movement = result.group.movements[0]!;
  if (movement.monetaryKind !== "journalLinked") throw new Error("Expected money-bearing movement");
  for (const object of [result.group, result.group.movements, movement, movement.posting, movement.posting.contentHash, movement.coordinate.dimensionMemberIds, movement.quantityAllocation.derivation, movement.reductionProof.policy]) expect(Object.isFrozen(object)).toBeTrue();
});

test("canonical movement groups preserve admitted dimension sets and reject same-length substitutions", () => {
  function dimensions(entry: InventoryPostedReductionEntry, names: readonly string[]) {
    const anchorBody = { ...entry.anchor, coordinate: { ...entry.anchor.coordinate, dimensionMemberIds: names.map(dimensionMemberId) } };
    const anchor = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
    const positionBody = { ...entry.position, anchor: { ...entry.position.anchor, contentHash: anchor.contentHash } };
    return { ...entry, anchor, position: { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) } };
  }
  const entries = [dimensions(groupEntry("0.01", 0), ["a", "z"]), dimensions(groupEntry("0.02", 1), ["a", "z"])];
  // Journal admission retains a dimension SET; presentation order is not a
  // different accounting coordinate. Ownership stores canonical member order.
  const link = actualGroupJournal("0.01", r(2n), r(1n, 100n), ["z", "a"]);
  const result = prepareInventoryPostedReductionGroup(groupContext, entries, link);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Admitted dimensions rejected");
  expect(result.group.movements.map((movement) => movement.coordinate.dimensionMemberIds)).toEqual([[dimensionMemberId("a"), dimensionMemberId("z")], [dimensionMemberId("a"), dimensionMemberId("z")]]);
  groupRejected(groupContext, [entries[0]!, dimensions(entries[1]!, ["a", "y"])], link, "inventoryOwnership.groupCoordinate");
  const changedJournal = { ...link.source.journal, postings: link.source.journal.postings.map((p) => p.id === link.postingId ? { ...p, dimensionMemberIds: [dimensionMemberId("a"), dimensionMemberId("y")] } : p) };
  groupRejected(groupContext, entries, { ...link, source: { ...link.source, journal: changedJournal, canonicalHash: hashCanonical(canonicalJournalValue(changedJournal)) } }, "inventoryOwnership.postingAttribution");
});

function actualEffectJournal(amounts: readonly string[], basis = r(8n, 3n)) {
  const base = journal("effect-journal");
  const postings = amounts.flatMap((amount, i) => {
    const value = D.parse(amount);
    return [
      { ...base.postings[0]!, id: postingId(`effect-inventory-${i}`), ordinal: BigInt(2 * i + 1), units: { canonicalNumber: r(-1n), commodityId: inventoryUnits },
        bookValue: { amount: D.of(-value.coefficient, value.scale), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: basis.negate(), basisCommodityId: IDS.usd } },
      { ...base.postings[1]!, id: postingId(`effect-cost-${i}`), ordinal: BigInt(2 * i + 2), units: { canonicalNumber: r(1n), commodityId: inventoryUnits },
        bookValue: { amount: value, functionalCommodityId: IDS.usd } },
    ];
  });
  const source = admittedGroupSource({ ...base, postings });
  return amounts.map((_, i) => ({ source, postingId: postingId(`effect-inventory-${i}`), referenceId: canonicalPostingReferenceId(`effect-reference-${i}`) }));
}
function reductionOperation(entry: InventoryPostedReductionEntry, index: number, journalLink?: InventoryReductionOperation["journalLink"]): InventoryReductionOperation {
  return { kind: "disposal", allocations: [{ movementId: identifier<"InventoryPostedMovement">(`effect-movement-${index}`), allocation: { ...entry.allocation, id: lotAllocationId(`effect-allocation-${index}`) } }], ...(journalLink === undefined ? {} : { journalLink }) };
}
function originalSource(entry: InventoryPostedReductionEntry): InventoryPostedReductionSource {
  return { anchor: entry.anchor, position: entry.position, holding: entry.holding };
}
function effectRejected(sources: readonly InventoryPostedReductionSource[], operations: readonly InventoryReductionOperation[], path: string) {
  const before = hashCanonical(canonicalAccountingValue({ sources, operations }));
  const result = prepareInventoryReductionEffect(groupContext, sources, operations);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Invalid ownership effect admitted");
  expect(result.diagnostics[0]?.path).toBe(path);
  expect(Object.hasOwn(result, "effect")).toBeFalse();
  expect(hashCanonical(canonicalAccountingValue({ sources, operations }))).toEqual(before);
}

test("one reduction effect uses internal after-images across repeated consumption of the same holding", () => {
  const entry = groupEntry("8.00", 0), sources = [originalSource(entry)], links = actualEffectJournal(["2.67", "2.66", "2.67"]);
  const operations = links.map((link, index) => reductionOperation(entry, index, link));
  const result = prepareInventoryReductionEffect(groupContext, sources, operations);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Valid repeated reduction rejected");
  const movements = result.effect.journalLinkedMovements;
  expect(movements.map((movement) => movement.postedAmount.toString())).toEqual(["-2.67", "-2.66", "-2.67"]);
  expect(movements.map((movement) => movement.artifactOrdinal)).toEqual([1n, 2n, 3n]);
  expect(movements[0]!.beforePosition.contentHash).toEqual(entry.position.contentHash);
  expect(movements[1]!.beforePosition.contentHash).toEqual(movements[0]!.afterPosition.contentHash);
  expect(movements[2]!.beforePosition.contentHash).toEqual(movements[1]!.afterPosition.contentHash);
  expect(movements[1]!.beforePosition.bookRevision).toBe(groupContext.bookRevision);
  expect(result.afterHoldings[0]!.remainingQuantity.isZero()).toBeTrue();
  expect(result.afterHoldings[0]!.remainingCarryingAmount.isZero()).toBeTrue();
  expect(result.afterPositions[0]!.consumedPosted.toString()).toBe("8.00");
  expect(result.effect.quantityOnlyMovements).toEqual([]);
  expect(result.effect.newAnchors).toEqual([]);
  expect(result.effect.contentHash).toEqual(hashInventoryReductionOwnershipEffect(result.effect));
  expect(prepareInventoryReductionEffect(groupContext, sources, operations)).toEqual(result);
  // A stale-original-state implementation would accept these independently
  // rounded amounts. The effect must reject rather than post 8.01 in total.
  const independentlyRounded = actualEffectJournal(["2.67", "2.67", "2.67"]);
  effectRejected(sources, independentlyRounded.map((link, i) => reductionOperation(entry, i, link)), "inventoryOwnership.postingAttribution");
});

test("a penny effect retains quantity-only steps on both sides of its single money movement", () => {
  const entry = groupEntry("0.01", 0), sources = [originalSource(entry)];
  const link = actualEffectJournal(["0.01"], r(1n, 300n))[0]!;
  const operations = [reductionOperation(entry, 0), reductionOperation(entry, 1, link), reductionOperation(entry, 2)];
  const result = prepareInventoryReductionEffect(groupContext, sources, operations);
  if (result.disposition !== "prepared") throw new Error("Valid penny effect rejected");
  expect(result.effect.journalLinkedMovements.map((movement) => movement.artifactOrdinal)).toEqual([2n]);
  expect(result.effect.quantityOnlyMovements.map((movement) => movement.artifactOrdinal)).toEqual([1n, 3n]);
  const ordered = [...result.effect.journalLinkedMovements, ...result.effect.quantityOnlyMovements].sort((a, b) => Number(a.artifactOrdinal - b.artifactOrdinal));
  expect(ordered.map((movement) => movement.postedAmount.toString())).toEqual(["0.00", "-0.01", "0.00"]);
  expect(ordered[1]!.beforePosition.contentHash).toEqual(ordered[0]!.afterPosition.contentHash);
  expect(ordered[2]!.beforePosition.contentHash).toEqual(ordered[1]!.afterPosition.contentHash);
  expect(result.effect.quantityOnlyMovements.every((movement) => !Object.hasOwn(movement, "posting"))).toBeTrue();
  expect(result.afterHoldings[0]!.remainingQuantity.isZero()).toBeTrue();
  expect(result.afterPositions[0]!.consumedPosted.toString()).toBe("0.01");
  const free = groupEntry("0.00", 1);
  const freeResult = prepareInventoryReductionEffect(groupContext, [originalSource(free)], [reductionOperation(free, 0), reductionOperation(free, 1), reductionOperation(free, 2)]);
  if (freeResult.disposition !== "prepared") throw new Error("Valid free-quantity effect rejected");
  expect(freeResult.effect.journalLinkedMovements).toEqual([]);
  expect(freeResult.effect.quantityOnlyMovements.length).toBe(3);
  expect(freeResult.afterHoldings[0]!.remainingQuantity.isZero()).toBeTrue();
});

test("whole-effect source and posting ownership cannot be reused to spend one journal posting twice", () => {
  const a = groupEntry("8.00", 0), b = groupEntry("8.00", 1), sources = [originalSource(a), originalSource(b)];
  const links = actualEffectJournal(["2.67", "2.67"]);
  // Each isolated group would fit the same 2.67 posting; jointly claiming it is
  // invalid even when reference IDs differ and every local equation is correct.
  effectRejected(sources, [reductionOperation(a, 0, links[0]), reductionOperation(b, 1, { ...links[0]!, referenceId: links[1]!.referenceId })], "inventoryOwnership.effectPostingIdentity");
  effectRejected(sources, [reductionOperation(a, 0, links[0]), reductionOperation(b, 1, { ...links[1]!, referenceId: links[0]!.referenceId })], "inventoryOwnership.effectPostingIdentity");
  const operations = [reductionOperation(a, 0, links[0]), reductionOperation(b, 1, links[1])];
  const valid = prepareInventoryReductionEffect(groupContext, sources, operations);
  if (valid.disposition !== "prepared") throw new Error("Valid independent groups rejected");
  expect(valid.afterHoldings.map((holding) => holding.id)).toEqual([a.holding.id, b.holding.id]);
  expect(prepareInventoryReductionEffect(groupContext, [...sources].reverse(), operations)).toEqual(valid);
  const reordered = prepareInventoryReductionEffect(groupContext, sources, [...operations].reverse());
  if (reordered.disposition !== "prepared") throw new Error("Independent reordered groups rejected");
  expect(reordered.effect.contentHash).not.toEqual(valid.effect.contentHash);
  expect(reordered.afterHoldings).toEqual(valid.afterHoldings);
});

test("effect-level identities and initial sources fail closed before any partial candidate escapes", () => {
  const a = groupEntry("0.01", 0), b = groupEntry("0.01", 1), source = originalSource(a), operation = reductionOperation(a, 0);
  effectRejected([], [operation], "inventoryOwnership.effect");
  effectRejected([source], [], "inventoryOwnership.effect");
  effectRejected([source], [{ ...operation, allocations: [] }], "inventoryOwnership.effect");
  effectRejected([source, source], [operation], "inventoryOwnership.effectSource");
  effectRejected([source, { ...originalSource(b), anchor: a.anchor }], [operation], "inventoryOwnership.effectSource");
  effectRejected([source, { ...originalSource(b), position: { ...b.position, originMovementId: a.position.originMovementId } }], [operation], "inventoryOwnership.effectSource");
  for (const patch of [
    { holding: { ...a.holding, bookId: bookId("foreign") } }, { position: { ...a.position, holdingId: b.holding.id } },
    { anchor: { ...a.anchor, coordinate: { ...a.anchor.coordinate, holdingId: b.holding.id } } },
    { anchor: { ...a.anchor, bookRevision: 2n } }, { position: { ...a.position, originBookRevision: 2n } },
  ]) effectRejected([{ ...source, ...patch }], [operation], "inventoryOwnership.effectSource");
  effectRejected([source, originalSource(b)], [operation], "inventoryOwnership.effectSource");
  effectRejected([source], [reductionOperation(b, 0)], "inventoryOwnership.effectSource");
  const second = reductionOperation(a, 1);
  effectRejected([source], [operation, { ...second, allocations: [{ ...second.allocations[0]!, allocation: operation.allocations[0]!.allocation }] }], "inventoryOwnership.effectIdentity");
  effectRejected([source], [operation, { ...second, allocations: [{ ...second.allocations[0]!, movementId: operation.allocations[0]!.movementId }] }], "inventoryOwnership.effectIdentity");
  effectRejected([source], [{ ...operation, allocations: [{ ...operation.allocations[0]!, movementId: a.position.originMovementId }] }], "inventoryOwnership.effectIdentity");
  // The first zero-money step is valid; failure of the later quantity overdraw
  // still returns only diagnostics and never mutates the caller's before rows.
  effectRejected([source], [operation, { ...second, allocations: [{ ...second.allocations[0]!, allocation: { ...second.allocations[0]!.allocation, allocatedQuantity: r(3n) } }] }], "inventoryOwnership.quantity");
});

test("one journal identity and effect locator must keep the same source throughout the effect", () => {
  const a = groupEntry("8.00", 0), b = groupEntry("8.00", 1), sources = [originalSource(a), originalSource(b)], links = actualEffectJournal(["2.67", "2.67"]);
  const first = reductionOperation(a, 0, links[0]), link = links[1]!;
  const renamed = { ...link.source.journal, narration: "Changed between operation reads" };
  effectRejected(sources, [first, reductionOperation(b, 1, { ...link, source: { ...link.source, journal: renamed, canonicalHash: hashCanonical(canonicalJournalValue(renamed)) } })], "inventoryOwnership.effectJournalSource");
  effectRejected(sources, [first, reductionOperation(b, 1, { ...link, source: { ...link.source, effectKey: "another-journal-effect" } })], "inventoryOwnership.effectJournalSource");
  const aliased = { ...link.source.journal, id: journal("another-journal").id };
  effectRejected(sources, [first, reductionOperation(b, 1, { ...link, source: { ...link.source, journal: aliased, canonicalHash: hashCanonical(canonicalJournalValue(aliased)) } })], "inventoryOwnership.effectJournalSource");
});

test("complete-effect bounds include original rows, repeated verification and all journal traversals", () => {
  const a = groupEntry("0.01", 0), source = originalSource(a), operation = reductionOperation(a, 0), cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  for (const [sources, operations] of [
    [new Array(cap + 1), [operation]], [[source], new Array(cap + 1)], [[source], [{ ...operation, allocations: new Array(cap + 1) }]],
  ] as const) {
    const result = prepareInventoryReductionEffect(groupContext, sources, operations);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Oversized effect admitted");
    expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.effect");
  }
  for (const patch of [{ bookRevision: 0n }, { commandId: "" as typeof groupContext.commandId }, { effectKey: "" as typeof groupContext.effectKey }]) {
    const result = prepareInventoryReductionEffect({ ...groupContext, ...patch }, [source], [operation]);
    expect(result.disposition).toBe("rejected");
  }
  const overflowSource = { ...source, anchor: { ...source.anchor, evidence: new Array(cap + 1) } };
  const result = prepareInventoryReductionEffect(groupContext, [overflowSource], [operation]);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Oversized original source admitted");
  expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.effect");
  const links = actualEffectJournal(["0.01"], r(1n, 300n));
  const oversizedJournal = { ...links[0]!, source: { ...links[0]!.source, journal: { ...links[0]!.source.journal, postings: new Array(cap + 1) } } };
  const journalResult = prepareInventoryReductionEffect(groupContext, [source], [reductionOperation(a, 0, oversizedJournal)]);
  expect(journalResult.disposition).toBe("rejected");
  // First operation verifies a valid large anchor. Reusing it must count that
  // work again, even though the original-source map contains only one row.
  const evidence = Array.from({ length: cap / 2 }, (_, i) => ({ ...accountingDerivation.evidence[0]!, id: evidenceId(`repeat-${i}`) }));
  const anchorBody = { ...a.anchor, evidence }, anchor = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
  const positionBody = { ...a.position, anchor: { ...a.position.anchor, contentHash: anchor.contentHash } };
  const largeSource = { ...source, anchor, position: { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) } };
  effectRejected([largeSource], [operation, reductionOperation(a, 1, links[0])], "inventoryOwnership.effect");
  const exactAnchorBody = { ...a.anchor, evidence: evidence.slice(1) };
  const exactAnchor = { ...exactAnchorBody, contentHash: hashInventoryPostedAnchor(exactAnchorBody) };
  const exactPosition = { ...a.position, anchor: { ...a.position.anchor, contentHash: exactAnchor.contentHash } };
  const exactSource = { ...source, anchor: exactAnchor, position: { ...exactPosition, contentHash: hashInventoryPostedPosition(exactPosition) } };
  const exact = prepareInventoryReductionEffect(groupContext, [exactSource], [operation, reductionOperation(a, 1, links[0])]);
  expect(exact.disposition).toBe("prepared");
  if (exact.disposition !== "prepared") throw new Error("Exact repeated-verification cap rejected");
  expect(exact.effect.quantityOnlyMovements[0]!.postedAmount.toString()).toBe("0.00");
  expect(exact.effect.journalLinkedMovements[0]!.postedAmount.toString()).toBe("-0.01");
  expect(exact.afterPositions[0]!.consumedQuantity.toString()).toBe("2/1");
});

test("the complete reduction effect owns immutable history and hashes both monetary and quantity-only records", () => {
  const entry = groupEntry("0.01", 0);
  const mutableInputHash = { ...entry.allocation.derivation.inputHash };
  const allocation = { ...entry.allocation, derivation: { ...entry.allocation.derivation, inputHash: mutableInputHash } };
  const mutableEntry = { ...entry, allocation };
  const link = actualEffectJournal(["0.01"], r(1n, 300n))[0]!;
  const operations = [reductionOperation(mutableEntry, 0), reductionOperation(mutableEntry, 1, link), reductionOperation(mutableEntry, 2)];
  const result = prepareInventoryReductionEffect(groupContext, [originalSource(entry)], operations);
  if (result.disposition !== "prepared") throw new Error("Valid complete effect rejected");
  const fingerprint = hashCanonical(canonicalAccountingValue(result));
  mutableInputHash.digest = "f".repeat(64);
  expect(hashCanonical(canonicalAccountingValue(result))).toEqual(fingerprint);
  for (const value of [result, result.effect, result.effect.newAnchors, result.effect.journalLinkedMovements, result.effect.quantityOnlyMovements,
    result.effect.quantityOnlyMovements[0]!.quantityAllocation.derivation.inputHash, result.afterHoldings, result.afterHoldings[0], result.afterPositions, result.afterPositions[0]]) {
    expect(Object.isFrozen(value)).toBeTrue();
  }
  for (const patch of [{ effectKey: effectKey("other") }, { bookRevision: 3n }, { journalLinkedMovements: [] }, { quantityOnlyMovements: [] }]) {
    expect(hashInventoryReductionOwnershipEffect({ ...result.effect, ...patch })).not.toEqual(result.effect.contentHash);
  }
});

function codecEffect() {
  const entry = groupEntry("0.01", 0), link = actualEffectJournal(["0.01"], r(1n, 300n))[0]!;
  const result = prepareInventoryReductionEffect(groupContext, [originalSource(entry)], [reductionOperation(entry, 0), reductionOperation(entry, 1, link), reductionOperation(entry, 2)]);
  if (result.disposition !== "prepared") throw new Error("Codec fixture must come from the real effect constructor");
  return { entry, effect: result.effect, position: result.afterPositions[0]! };
}

// A trusted read-contract double with independent current rows and immutable
// historical after-images. This is NOT a deployed storage membership proof.
function ownershipReader(sources: readonly InventoryPostedReductionSource[]) {
  const history = immutableAccountingValue(sources), events: string[] = [];
  const originKey = (origin: InventoryPostedPositionOrigin) => `${origin.bookId}|${origin.bookRevision}|${origin.effectKey}|${origin.artifactOrdinal}|${origin.movementId}`;
  const origins = new Map(history.map(({ position: p, holding: h }) => [originKey({ bookId: h.bookId, bookRevision: p.originBookRevision,
    effectKey: p.originEffectKey, artifactOrdinal: p.originArtifactOrdinal, movementId: p.originMovementId }), p]));
  const reader: InventoryOwnershipReadContext = {
    bookId: IDS.book, bookRevision: 1n,
    assertCurrent() { events.push("guard"); },
    readCurrentHolding(id) { events.push(`holding:${id}`); return sources.find((source) => source.holding.id === id)?.holding; },
    readCurrentPosition(id) { events.push(`position:${id}`); return sources.find((source) => source.position.holdingId === id)?.position; },
    readAnchor(reference) { events.push(`anchor:${reference.id}`); return history.find((source) => source.anchor.id === reference.id)?.anchor; },
    readPositionAfterImage(origin) { events.push(`origin:${origin.movementId}`); return origins.get(originKey(origin)); },
  };
  return { reader, events };
}

function acquisitionEntry(index: number, basis = r(1n, 300n), allowance = r(0n)): InventoryPostedAcquisitionEntry {
  const f = groupEntry("0.01", index);
  const holding = { ...f.holding, remainingTotalBasis: basis, remainingValuationAllowance: allowance, remainingCarryingAmount: basis.add(allowance) };
  return { anchorId: f.anchor.id, movementId: f.position.originMovementId, holding, evidence: f.anchor.evidence,
    lot: { id: holding.lotId, bookId: holding.bookId, commodityId: holding.commodityId, basisCommodityId: holding.basisCommodityId,
      acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: holding.remainingQuantity, acquisitionTotalBasis: basis,
      evidenceIds: f.anchor.evidence.map((e) => e.id) } };
}
function acquisitionContext(): InventoryPostedAcquisitionContext {
  const f = groupEntry("0.01", 0);
  return { ...groupContext, inventoryPolicy: f.anchor.inventoryPolicy, quantizationPolicy, dimensionMemberIds: [] };
}

test("ownership primitive boundaries preserve first revision, canonical dimensions and zero-quantity rejection", () => {
  const entry = acquisitionEntry(0, r(0n)), context = acquisitionContext();
  for (const dimensionMemberIds of [[dimensionMemberId("a")], [dimensionMemberId("a"), dimensionMemberId("b")]]) {
    const result = prepareInventoryPostedAcquisitionGroup({ ...context, bookRevision: 1n, dimensionMemberIds }, [entry]);
    expect(result.disposition).toBe("prepared");
    if (result.disposition !== "prepared") throw new Error("First-revision free stock rejected");
    expect(result.group.anchors[0]!.bookRevision).toBe(1n);
    expect(result.group.movements[0]!.postedAmount.toString()).toBe("0.00");
  }
  expect(prepareInventoryPostedAcquisitionGroup(context, [{ ...entry,
    lot: { ...entry.lot, acquisitionQuantity: r(0n) }, holding: { ...entry.holding, remainingQuantity: r(0n) },
  }]).disposition).toBe("rejected");
  const adoption = { ...entry, historicalPostings: [] };
  expect(prepareInventoryPostedAdoptionGroup({ ...context, bookRevision: 1n }, [adoption], r(0n)).disposition).toBe("prepared");
  expect(prepareInventoryPostedAdoptionGroup(context, [{ ...adoption, holding: { ...entry.holding, remainingQuantity: r(0n) } }], r(0n)).disposition).toBe("rejected");
  for (const dimensionMemberIds of [[dimensionMemberId("a"), dimensionMemberId("a")], [dimensionMemberId("b"), dimensionMemberId("a")]]) {
    expect(prepareInventoryPostedAcquisitionGroup({ ...context, dimensionMemberIds }, [entry]).disposition).toBe("rejected");
    expect(prepareInventoryPostedAdoptionGroup({ ...context, dimensionMemberIds }, [adoption], r(0n)).disposition).toBe("rejected");
  }
  for (const patch of [{ bookRevision: 0n }, { firstArtifactOrdinal: 0n }]) {
    ownershipDiagnostic(prepareInventoryPostedAcquisitionGroup({ ...context, ...patch }, [entry]), "inventoryOwnership.acquisitionIdentity");
    ownershipDiagnostic(prepareInventoryPostedAdoptionGroup({ ...context, ...patch }, [adoption], r(0n)), "inventoryOwnership.adoptionIdentity");
  }
  const source = example();
  const badReference = { ...source.position.anchor, id: identifier<"InventoryPostedMovement">("incoming"), effectKey: "" as typeof source.anchor.effectKey };
  rejected(rehashAnchor(source, { bookRevision: 2n, incomingMovements: [badReference] }), "inventoryOwnership.lineage");
  const anchor = { ...source.anchor, incomingMovements: [badReference], bookRevision: 2n };
  expect(validateInventoryOwnershipArtifact("anchor", { ...anchor, contentHash: hashInventoryPostedAnchor(anchor) })).toBe(false);
  for (const patch of [{ originMovementId: "" as InventoryPostedPosition["originMovementId"] }, { originEffectKey: "" as typeof source.anchor.effectKey }]) {
    const position = { ...source.position, originBookRevision: 2n, ...patch };
    expect(validateInventoryOwnershipArtifact("position", { ...position, contentHash: hashInventoryPostedPosition(position) })).toBe(false);
  }
});

test("standalone ownership integrity enforces zero revision and exact dimension and evidence caps", () => {
  const f = example(), cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  const dimensions = Array.from({ length: cap }, (_, i) => dimensionMemberId(`d${String(i).padStart(5, "0")}`));
  const atLimit = rehashAnchor(f, { coordinate: { ...f.anchor.coordinate, dimensionMemberIds: dimensions } });
  const prepared = prepare(atLimit);
  expect(prepared.disposition).toBe("prepared");
  if (prepared.disposition !== "prepared") throw new Error("Exact dimension cap rejected");
  expect(prepared.reduction.postedAmount.toString()).toBe("-2.67");
  expect(validateInventoryOwnershipArtifact("anchor", atLimit.anchor)).toBe(true);
  const evidence = Array.from({ length: cap }, (_, i) => ({ ...f.anchor.evidence[0]!, id: evidenceId(`e${i}`) }));
  const sourceLimit = rehashAnchor(f, { sourcePostings: [], evidence });
  expect(validateInventoryOwnershipArtifact("anchor", sourceLimit.anchor)).toBe(true);
  const zeroRevision = rehashAnchor(f, { bookRevision: 0n, sourcePostings: [], evidence: f.anchor.evidence });
  expect(validateInventoryOwnershipArtifact("anchor", zeroRevision.anchor)).toBe(false);
  const repeated = rehashAnchor(f, { coordinate: { ...f.anchor.coordinate, dimensionMemberIds: [dimensionMemberId("a"), dimensionMemberId("a")] } });
  expect(validateInventoryOwnershipArtifact("anchor", repeated.anchor)).toBe(false);
});

test("standalone acquisition integrity cannot label a zero-money movement journal-linked", () => {
  const result = prepareInventoryPostedAcquisitionGroup(acquisitionContext(), [acquisitionEntry(0, r(0n))]);
  if (result.disposition !== "prepared") throw new Error("Free acquisition rejected");
  const original = result.group.movements[0]!;
  const fake = { ...original, monetaryKind: "journalLinked" as const, posting: groupEntry("1.00", 0).anchor.sourcePostings[0]! };
  expect(validateInventoryOwnershipArtifact("acquisitionMovement", { ...fake, contentHash: hashInventoryPostedAcquisitionMovement(fake) })).toBe(false);
});

test("same-revision reductions require strictly later ordinals and positive allocation progress", () => {
  const source = groupEntry("0.00", 0);
  const context = { ...groupContext, bookRevision: 1n, effectKey: source.position.originEffectKey, firstArtifactOrdinal: 3n };
  const result = prepareInventoryPostedReductionGroup(context, [source]);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Ordered same-revision reduction rejected");
  const movement = result.group.movements[0]!;
  expect(movement.bookRevision).toBe(1n);
  expect(movement.artifactOrdinal).toBe(3n);
  expect(validateInventoryOwnershipArtifact("reductionMovement", movement)).toBe(true);
  const zeroQuantity = sealedMovement({ ...movement, quantityAllocation: { ...movement.quantityAllocation, allocatedQuantity: r(0n) },
    afterPosition: { ...movement.afterPosition, consumedQuantity: r(0n) } });
  expect(validateInventoryOwnershipArtifact("reductionMovement", zeroQuantity)).toBe(false);
  const zeroProgress = quantizeCumulativePostedShare(D.parse("0.00"), r(0n), r(0n), quantizationPolicy);
  if (zeroProgress.disposition !== "quantized") throw new Error("Zero arithmetic share rejected");
  const stalled = sealedMovement({ ...movement, reductionProof: zeroProgress.share });
  expect(validateInventoryOwnershipArtifact("reductionMovement", stalled)).toBe(false);
  const transfer = freeTransferBoundaryFixture();
  const transferred = prepareInventoryPostedTransferGroup({ ...transfer.context, ...context }, [transfer.entry]);
  expect(transferred.disposition).toBe("prepared");
  if (transferred.disposition !== "prepared") throw new Error("Ordered same-revision transfer rejected");
  expect(transferred.group.destinationMovements[0]!.artifactOrdinal).toBe(5n);
  // Standalone movements are valid in this command, but a reduction-only effect
  // cannot invent that same-command source instead of supplying its creation.
  if (movement.monetaryKind !== "quantityOnly") throw new Error("Free reduction created a posting");
  const effect = { effectKey: context.effectKey, bookRevision: 1n, newAnchors: [] as const,
    journalLinkedMovements: [], quantityOnlyMovements: [movement] };
  expect(validateInventoryOwnershipArtifact("reductionEffect", { ...effect, contentHash: hashInventoryReductionOwnershipEffect(effect) })).toBe(false);
});

test("ownership selection uses a half-open policy validity interval", () => {
  const f = ownershipCostFixture("fifo");
  const start = f.request.governedAt, end = instant("2026-01-16T12:00:00Z");
  const policy = { ...f.policy, validFrom: start, validTo: end };
  const atStart = prepareInventoryOwnershipSelection([policy], IDS.book, f.canonicalPool, f.request);
  expect(atStart.disposition).toBe("selected");
  if (atStart.disposition !== "selected") throw new Error("Policy start is inclusive");
  expect(atStart.selection.ordinaryQuantity.toString()).toBe("3/1");
  expect(atStart.selection.ordinaryBasis.toString()).toBe("6/1");
  ownershipDiagnostic(prepareInventoryOwnershipSelection([policy], IDS.book, f.canonicalPool, { ...f.request, governedAt: end }), "inventoryOwnership.selectionPolicy");
});

// Isolate each inclusive resource guard with a later, deliberately invalid
// identity. These cases prove diagnostic ordering, not admission of bad stock.
function ownershipDiagnostic(result: { readonly disposition: string; readonly diagnostics?: readonly { readonly path: string; readonly message: string }[] }, path: string, message?: string) {
  expect(result.disposition).toBe("rejected");
  expect(result.diagnostics?.[0]?.path).toBe(path);
  if (message !== undefined) expect(result.diagnostics?.[0]?.message).toBe(message);
}

function freeTransferBoundaryFixture(source = groupEntry("0.00", 0)) {
  const created = acquisitionEntry(1, r(0n));
  const destinationHolding = { ...created.holding, accountId: IDS.revenue, remainingQuantity: source.allocation.allocatedQuantity,
    remainingTotalBasis: source.allocation.allocatedTotalBasis, remainingValuationAllowance: source.allocation.allocatedValuationAllowance,
    remainingCarryingAmount: source.allocation.allocatedCarryingAmount };
  const entry: InventoryPostedTransferEntry = { source, allocation: source.allocation,
    transferOutMovementId: source.movementId, destinationAnchorId: created.anchorId, destinationMovementId: created.movementId,
    destinationHolding, destinationLot: { ...created.lot, acquisitionQuantity: source.allocation.allocatedQuantity, acquisitionTotalBasis: source.allocation.allocatedTotalBasis }, evidence: created.evidence };
  const context: InventoryPostedTransferGroupContext = { ...groupContext, destinationInventoryPolicy: source.anchor.inventoryPolicy,
    destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: [] };
  return { source, entry, context };
}

test("effect integrity refuses invented same-command source anchors and before-images", () => {
  const f = codecEffect(), original = f.effect.quantityOnlyMovements[1]!;
  for (const field of ["anchor", "before"] as const) {
    const holdingId = lotHoldingId("uncreated-holding");
    const afterPosition = { ...original.afterPosition, holdingId, anchor: { ...original.afterPosition.anchor,
      id: identifier<"InventoryPostedAnchor">("uncreated-anchor"),
      ...(field === "anchor" ? { bookRevision: f.effect.bookRevision, effectKey: f.effect.effectKey, artifactOrdinal: 1n } : {}) } };
    const detached = sealedMovement({ ...original, coordinate: { ...original.coordinate, holdingId }, afterPosition,
      quantityAllocation: { ...original.quantityAllocation, holdingId },
      beforePosition: { ...original.beforePosition, id: holdingId,
        ...(field === "before" ? { bookRevision: f.effect.bookRevision, effectKey: f.effect.effectKey, artifactOrdinal: 2n } : { bookRevision: 1n }) } });
    // A local movement can be coherent without proving that its sources exist.
    expect(validateInventoryOwnershipArtifact("reductionMovement", detached)).toBe(true);
    if (detached.monetaryKind !== "quantityOnly") throw new Error("Expected quantity movement");
    const effect = { ...f.effect, quantityOnlyMovements: [f.effect.quantityOnlyMovements[0]!, detached] };
    const sealed = { ...effect, contentHash: hashInventoryReductionOwnershipEffect(effect) };
    expect(validateInventoryOwnershipArtifact("reductionEffect", sealed)).toBe(false);
    expect(validateInventoryOwnershipArtifact("ownershipEffect", sealed)).toBe(false);
  }
});

test("complete transfer effects retain posted basis and allowance without applying acquisition-only restrictions", () => {
  const source = componentExample(), transfer = freeTransferBoundaryFixture({ ...source, movementId: source.origin.movementId });
  const links = actualTransferJournal("2.67", r(1n), r(10n, 3n));
  const operation: Extract<InventoryOwnershipOperation, { kind: "transfer" }> = { kind: "transfer", entries: [transfer.entry],
    destinationInventoryPolicy: transfer.context.destinationInventoryPolicy, destinationQuantizationPolicy: quantizationPolicy,
    destinationDimensionMemberIds: [], sourceJournalLink: links.sourceLink, destinationJournalLink: links.destLink };
  const result = prepareInventoryOwnershipEffect(groupContext, [source], [operation]);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Written-down ownership transfer rejected");
  expect(result.effect.newAnchors[0]!.postedValue).toEqual({ basis: D.parse("3.34"), allowance: D.parse("-0.67") });
  expect(result.effect.journalLinkedMovements.map((m) => m.postedAmount.toString())).toEqual(["-2.67", "2.67"]);
  expect(validateInventoryOwnershipArtifact("ownershipEffect", result.effect)).toBe(true);
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", result.effect)).disposition).toBe("decoded");
});

test("repeated transfers count the exact original-source work at the inclusive effect cap", () => {
  const raw = groupEntry("0.00", 0), cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  const body = { ...raw.anchor, evidence: Array.from({ length: cap / 2 }, (_, i) => ({ ...raw.anchor.evidence[0]!, id: evidenceId(`transfer-${i}`) })) };
  const anchor = { ...body, contentHash: hashInventoryPostedAnchor(body) };
  const positionBody = { ...raw.position, anchor: { ...raw.position.anchor, contentHash: anchor.contentHash } };
  const source = { ...raw, anchor, position: { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) } };
  const f = freeTransferBoundaryFixture(source);
  const second: InventoryPostedTransferEntry = { ...f.entry, allocation: { ...f.entry.allocation, id: lotAllocationId("second-transfer") },
    transferOutMovementId: identifier<"InventoryPostedMovement">("second-out"), destinationMovementId: identifier<"InventoryPostedMovement">("second-in"),
    destinationAnchorId: identifier<"InventoryPostedAnchor">("second-anchor"),
    destinationHolding: { ...f.entry.destinationHolding, id: lotHoldingId("second-holding"), lotId: lotId("second-lot") },
    destinationLot: { ...f.entry.destinationLot, id: lotId("second-lot") } };
  const operations: InventoryOwnershipOperation[] = [f.entry, second].map((entry) => ({ kind: "transfer", entries: [entry],
    destinationInventoryPolicy: f.context.destinationInventoryPolicy, destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: [] }));
  const result = prepareInventoryOwnershipEffect(groupContext, [source], operations);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Exact transfer source-work cap rejected");
  expect(result.effect.quantityOnlyMovements.map((m) => m.kind)).toEqual(["transferOut", "transferIn", "transferOut", "transferIn"]);
  expect(result.afterHoldings.find((h) => h.id === source.holding.id)!.remainingQuantity.toString()).toBe("1/1");
});

test("transfer primitive checks origin and dimension boundaries independently of its reductions", () => {
  const { entry, context } = freeTransferBoundaryFixture();
  const result = prepareInventoryPostedTransferGroup({ ...context, destinationDimensionMemberIds: [dimensionMemberId("a")] }, [entry]);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Free transfer rejected");
  expect(result.group.transferredQuantity.toString()).toBe("1/1");
  expect(result.group.transferredPostedAmount.toString()).toBe("0.00");
  for (const patch of [{ bookRevision: 0n }, { firstArtifactOrdinal: 0n }, { destinationDimensionMemberIds: [dimensionMemberId("a"), dimensionMemberId("a")] }]) {
    ownershipDiagnostic(prepareInventoryPostedTransferGroup({ ...context, ...patch }, [entry]), "inventoryOwnership.groupIdentity");
  }
  // Revision one is valid at the group identity layer, but cannot consume
  // this fixture's revision-one source; the exact lineage guard must reject it.
  ownershipDiagnostic(prepareInventoryPostedTransferGroup({ ...context, bookRevision: 1n }, [entry]), "inventoryOwnership.lineage");
});

test("transfer resource guards admit their exact cap before later identity errors", () => {
  const { entry, context } = freeTransferBoundaryFixture(), cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  const invalidContext = { ...context, commandId: "" as typeof context.commandId };
  const empty = { ...entry, evidence: [], source: { ...entry.source, anchor: { ...entry.source.anchor, evidence: [], sourcePostings: [] } } };
  ownershipDiagnostic(prepareInventoryPostedTransferGroup(invalidContext, Array.from({ length: cap }, () => empty)), "inventoryOwnership.groupIdentity");
  const evidence = Array.from({ length: cap - 1 }, () => entry.evidence[0]!);
  ownershipDiagnostic(prepareInventoryPostedTransferGroup(invalidContext, [{ ...entry, evidence }]), "inventoryOwnership.groupIdentity");
  const link = actualGroupJournal("1.00", r(1n), r(1n));
  const boundedLink = { ...link, source: { ...link.source, journal: { ...link.source.journal, postings: Array.from({ length: cap }, () => link.source.journal.postings[0]!) } } };
  ownershipDiagnostic(prepareInventoryPostedTransferGroup(invalidContext, [entry], boundedLink), "inventoryOwnership.groupIdentity");
  ownershipDiagnostic(prepareInventoryPostedTransferGroup(invalidContext, [entry], undefined, boundedLink), "inventoryOwnership.groupIdentity");
});

test("effect and read-context population caps preserve their distinct diagnostic stages", () => {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers, source = groupEntry("0.00", 0), reader = ownershipReader([source]).reader;
  const empty: InventoryReductionOperation = { kind: "disposal", allocations: [] };
  const manyOperations = Array.from({ length: cap }, () => empty);
  const allocationMessage = "The complete effect's allocation and journal-source work must fit the operation bounds";
  ownershipDiagnostic(prepareInventoryReductionEffect(groupContext, [source], manyOperations), "inventoryOwnership.effect", allocationMessage);
  ownershipDiagnostic(prepareInventoryOwnershipEffect(groupContext, [source], manyOperations), "inventoryOwnership.effect", allocationMessage);
  ownershipDiagnostic(prepareInventoryOwnershipEffectFromReadContext(reader, groupContext, manyOperations), "inventoryOwnership.readSet", "Candidate allocation and journal populations exceed the read-work bound");
  const repeatedSources = Array.from({ length: cap }, () => source), operation = reductionOperation(source, 0);
  ownershipDiagnostic(prepareInventoryReductionEffect(groupContext, repeatedSources, [operation]), "inventoryOwnership.effectSource");
  ownershipDiagnostic(prepareInventoryOwnershipEffect(groupContext, repeatedSources, [operation]), "inventoryOwnership.effectSource");
  const repeatedAllocations = { ...operation, allocations: Array.from({ length: cap }, () => operation.allocations[0]!) };
  ownershipDiagnostic(prepareInventoryOwnershipEffect(groupContext, [source], [repeatedAllocations]), "inventoryOwnership.effectIdentity");
  ownershipDiagnostic(prepareInventoryOwnershipEffectFromReadContext(reader, groupContext, [repeatedAllocations]), "inventoryOwnership.effectIdentity");
  const evidence = Array.from({ length: cap }, () => source.anchor.evidence[0]!);
  const largeSource = { ...source, anchor: { ...source.anchor, evidence } };
  ownershipDiagnostic(prepareInventoryOwnershipEffect(groupContext, [largeSource], [operation]), "inventoryOwnership.hash");
  ownershipDiagnostic(resolveInventoryOwnershipSources({ ...reader, readAnchor: () => largeSource.anchor }, [source.holding.id]), "inventoryOwnership.anchorSource");
  const foreignSource = { ...largeSource, holding: { ...source.holding, bookId: bookId("foreign") } };
  ownershipDiagnostic(prepareInventoryOwnershipEffect(groupContext, [foreignSource], [operation]), "inventoryOwnership.effectSource");
  const link = actualGroupJournal("1.00", r(1n), r(1n));
  const boundedLink = { ...link, source: { ...link.source, journal: { ...link.source.journal, postings: Array.from({ length: cap }, () => link.source.journal.postings[0]!) } } };
  ownershipDiagnostic(prepareInventoryOwnershipEffect(groupContext, [foreignSource], [{ ...operation, journalLink: boundedLink }]), "inventoryOwnership.effectSource");
});

test("acquisition transfer and adoption source work caps stay inclusive in both preparation paths", () => {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers, base = acquisitionEntry(0, r(0n)), context = acquisitionContext();
  const evidence = Array.from({ length: cap - 1 }, () => base.evidence[0]!);
  const acquire: Extract<InventoryOwnershipOperation, { kind: "acquisition" }> = { kind: "acquisition", entries: [{ ...base, evidence }],
    inventoryPolicy: context.inventoryPolicy, quantizationPolicy, dimensionMemberIds: [] };
  const reader = ownershipReader([]).reader;
  for (const run of [
    (ops: readonly InventoryOwnershipOperation[]) => prepareInventoryOwnershipEffect(groupContext, [], ops),
    (ops: readonly InventoryOwnershipOperation[]) => prepareInventoryOwnershipEffectFromReadContext(reader, groupContext, ops),
  ]) {
    ownershipDiagnostic(run([acquire]), "inventoryOwnership.acquisitionSource");
    const adopt: Extract<InventoryOwnershipOperation, { kind: "adopt" }> = { kind: "adopt", entries: [{ ...base, evidence: [...evidence, base.evidence[0]!], historicalPostings: [] }],
      inventoryPolicy: context.inventoryPolicy, quantizationPolicy, dimensionMemberIds: [], postedBalance: r(0n) };
    ownershipDiagnostic(run([adopt]), "inventoryOwnership.adoptionSource");
    const transfer = freeTransferBoundaryFixture();
    const entry = { ...transfer.entry, evidence, destinationHolding: { ...transfer.entry.destinationHolding, id: transfer.source.holding.id } };
    const operation: Extract<InventoryOwnershipOperation, { kind: "transfer" }> = { kind: "transfer", entries: [entry],
      destinationInventoryPolicy: context.inventoryPolicy, destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: [] };
    ownershipDiagnostic(run([operation]), "inventoryOwnership.effectSource");
  }
  const free = { ...acquire, entries: [base] };
  const first = prepareInventoryOwnershipEffect({ ...groupContext, bookRevision: 1n }, [], [free]);
  expect(first.disposition).toBe("prepared");
  if (first.disposition !== "prepared") throw new Error("First-revision ownership effect rejected");
  expect(first.effect.bookRevision).toBe(1n);
  expect(validateInventoryOwnershipArtifact("ownershipEffect", first.effect)).toBe(true);
  ownershipDiagnostic(prepareInventoryOwnershipEffect({ ...groupContext, bookRevision: 0n }, [], [free]), "inventoryOwnership.effect");
});

test("ownership acquisition and adoption resource caps are inclusive before source validation", () => {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers, context = acquisitionContext(), entry = acquisitionEntry(0, r(0n));
  const dimensions = Array.from({ length: cap }, () => dimensionMemberId("duplicate"));
  ownershipDiagnostic(prepareInventoryPostedAcquisitionGroup({ ...context, dimensionMemberIds: dimensions }, [entry]), "inventoryOwnership.acquisitionIdentity");
  ownershipDiagnostic(prepareInventoryPostedAdoptionGroup({ ...context, dimensionMemberIds: dimensions }, [{ ...entry, historicalPostings: [] }], r(0n)), "inventoryOwnership.adoptionIdentity");
  const evidence = Array.from({ length: cap }, () => entry.evidence[0]!);
  ownershipDiagnostic(prepareInventoryPostedAcquisitionGroup(context, [{ ...entry, evidence, lot: { ...entry.lot, evidenceIds: [] } }]), "inventoryOwnership.acquisitionSource");
  ownershipDiagnostic(prepareInventoryPostedAdoptionGroup(context, [{ ...entry, evidence, historicalPostings: [] }], r(0n)), "inventoryOwnership.adoptionSource");
  const emptyEvidence = { ...entry, evidence: [], lot: { ...entry.lot, evidenceIds: [] } };
  ownershipDiagnostic(prepareInventoryPostedAcquisitionGroup(context, Array.from({ length: cap }, () => emptyEvidence)), "inventoryOwnership.acquisitionIdentity");
  ownershipDiagnostic(prepareInventoryPostedAdoptionGroup(context, Array.from({ length: cap }, () => ({ ...emptyEvidence, historicalPostings: [] })), r(0n)), "inventoryOwnership.adoptionIdentity");
  const link = actualGroupJournal("1.00", r(1n), r(1n));
  const atLimitLink = { ...link, source: { ...link.source, journal: { ...link.source.journal, postings: Array.from({ length: cap }, () => link.source.journal.postings[0]!) } } };
  ownershipDiagnostic(prepareInventoryPostedAcquisitionGroup({ ...context, commandId: "" as typeof context.commandId }, [entry], atLimitLink), "inventoryOwnership.acquisitionIdentity");
  const reduction = groupEntry("0.00", 0);
  ownershipDiagnostic(prepareInventoryPostedReductionGroup({ ...groupContext, commandId: "" as typeof context.commandId }, [reduction], atLimitLink), "inventoryOwnership.groupIdentity");
  ownershipDiagnostic(prepareInventoryPostedReductionGroup(groupContext, Array.from({ length: cap }, () => ({ ...reduction, anchor: { ...reduction.anchor, evidence: [], sourcePostings: [] } }))), "inventoryOwnership.groupIdentity");
  ownershipDiagnostic(prepareInventoryPostedReductionGroup({ ...groupContext, commandId: "" as typeof context.commandId }, [{ ...reduction, anchor: { ...reduction.anchor, evidence, sourcePostings: [] } }]), "inventoryOwnership.groupIdentity");
});

test("selection and source-read caps do not reject their exact boundary", () => {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers, f = ownershipCostFixture();
  const invalidRequest = { ...f.request, policyId: policyId("absent") };
  const invoke = (policies = [f.policy], rows = f.canonicalPool, request = invalidRequest) => prepareInventoryOwnershipSelection(policies, IDS.book, rows, request);
  for (const result of [
    invoke(Array.from({ length: cap }, () => f.policy)),
    invoke([f.policy], Array.from({ length: cap }, () => f.canonicalPool[0]!)),
    invoke([f.policy], [], { ...invalidRequest, identities: Array.from({ length: cap }, () => f.request.identities[0]!) }),
    invoke([f.policy], [], { ...invalidRequest, derivation: { ...f.request.derivation, evidence: Array.from({ length: cap }, () => f.request.derivation.evidence[0]!) } }),
    invoke([f.policy], [], { ...invalidRequest, specificLayerIds: Array.from({ length: cap }, () => "holding-0") }),
  ]) ownershipDiagnostic(result, "inventoryOwnership.selectionPolicy");
  const manyPools = { ...f.policy, pools: Array.from({ length: cap }, () => f.policy.pools[0]!) };
  // Duplicate pool artifacts remain structurally valid here; the invalid row
  // must therefore reach the canonical pool guard, not the population guard.
  const badRow = { ...f.canonicalPool[0]!, holding: { ...f.canonicalPool[0]!.holding, bookId: bookId("foreign") } };
  ownershipDiagnostic(prepareInventoryOwnershipSelection([manyPools], IDS.book, [badRow], f.request), "inventoryOwnership.selectionPool");
  ownershipDiagnostic(prepareInventoryOwnershipSelection([f.policy], IDS.book, [{ ...badRow, lot: { ...badRow.lot, evidenceIds: Array.from({ length: cap }, () => evidenceId("e")) } }], f.request), "inventoryOwnership.selectionPool");
  const reader = ownershipReader([]).reader;
  ownershipDiagnostic(resolveInventoryOwnershipSources(reader, Array.from({ length: cap }, (_, i) => lotHoldingId(`missing-${i}`))), "inventoryOwnership.currentSource");
});

function ownershipCostFixture(method: InventoryCostPolicy["method"] = "weightedAverage") {
  const entries = [acquisitionEntry(0, r(6n), r(-3n)), acquisitionEntry(1, r(12n), r(-3n))].map((e, i) => ({ ...e, lot: { ...e.lot, acquiredAt: instant(`2026-01-0${i + 1}T12:00:00Z`) } }));
  const policy: InventoryCostPolicy = { kind: "inventoryCost", id: accountingDerivation.policyId, version: accountingDerivation.policyVersion, bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy,
    capability: capability("inventoryCost", method), method, pools: [pool("ownership-cost-pool", "cash")], shortageTreatment: "reject" };
  const ids = method === "weightedAverage" ? [0, 1] : method === "fifo" ? [0] : [1];
  const request: InventoryOwnershipSelectionRequest = { policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T12:00:00Z"),
    quantity: r(3n), inventoryCommodityId: inventoryUnits, derivation: accountingDerivation,
    identities: ids.map((i) => ({ holdingId: entries[i]!.holding.id, allocationId: lotAllocationId(`selected-${i}`), movementId: identifier<"InventoryPostedMovement">(`selected-${i}`) })),
    ...(method === "specificIdentification" ? { specificLayerIds: [entries[1]!.holding.id] } : {}) };
  return { entries, canonicalPool: entries.map((e) => ({ holding: e.holding, lot: e.lot })), policy, request };
}

test("ownership selection derives all five costing methods from canonical source quantities and economic balances", () => {
  for (const method of ["fifo", "lifo", "hifo", "specificIdentification", "weightedAverage"] as const) {
    const f = ownershipCostFixture(method);
    const result = prepareInventoryOwnershipSelection([f.policy], IDS.book, [...f.canonicalPool].reverse(), f.request);
    expect(result.disposition).toBe("selected");
    if (result.disposition !== "selected") throw new Error("Supported costing selection rejected");
    expect(prepareInventoryOwnershipSelection([f.policy], IDS.book, f.canonicalPool, f.request)).toEqual(result);
    const selection = result.selection;
    const expected = method === "weightedAverage" ? [["holding-0", "3/2", "3/1", "-3/2", "3/2"], ["holding-1", "3/2", "6/1", "-3/2", "9/2"]]
      : method === "fifo" ? [["holding-0", "3/1", "6/1", "-3/1", "3/1"]] : [["holding-1", "3/1", "12/1", "-3/1", "9/1"]];
    expect(selection.allocations.map(({ allocation: a }) => [a.holdingId, a.allocatedQuantity.toString(), a.allocatedTotalBasis.toString(), a.allocatedValuationAllowance.toString(), a.allocatedCarryingAmount.toString()])).toEqual(expected);
    expect(selection.ordinaryQuantity.equals(r(3n))).toBeTrue();
    expect(selection.ordinaryBasis.toString()).toBe(method === "weightedAverage" ? "9/1" : method === "fifo" ? "6/1" : "12/1");
    expect(selection.inventoryPolicy.policyContentHash).toEqual(hashAccountingPolicy(f.policy));
    expect(hashAccountingPolicy(f.policy)).toEqual(hashCanonical({ type: "inventoryCost", value: canonicalAccountingValue(f.policy) }));
    expect(hashAccountingPolicySnapshot([f.policy])).toEqual(hashCanonical({ type: "AccountingPolicySnapshot", policyHashes: [{ ...hashAccountingPolicy(f.policy) }] }));
    expect(Object.isFrozen(selection.allocations[0]!.allocation.derivation.evidence)).toBeTrue();
  }
});

test("policy-selected allocations feed mixed posted ownership without averaging individual historical basis", () => {
  const f = ownershipCostFixture();
  const selected = prepareInventoryOwnershipSelection([f.policy], IDS.book, f.canonicalPool, f.request);
  if (selected.disposition !== "selected") throw new Error("Selection required");
  const debit = actualGroupJournal("-12.00", r(-6n), r(-18n)), credit = actualGroupJournal("6.00", r(3n), r(9n));
  const base = journal("selected-ownership"), postings = [...debit.source.journal.postings, ...credit.source.journal.postings].map((p, i) => ({ ...p, id: postingId(`selection-post-${i}`), ordinal: BigInt(i + 1) }));
  const source = admittedGroupSource({ ...base, postings });
  const result = prepareInventoryOwnershipEffect(groupContext, [], [{ kind: "acquisition", entries: f.entries,
    inventoryPolicy: selected.selection.inventoryPolicy, quantizationPolicy, dimensionMemberIds: [],
    journalLink: { source, postingId: postings[0]!.id, referenceId: canonicalPostingReferenceId("selected-acquisition") } },
  { kind: "disposal", allocations: selected.selection.allocations,
    journalLink: { source, postingId: postings[2]!.id, referenceId: canonicalPostingReferenceId("selected-disposal") } }]);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Computed selection cannot build ownership");
  expect(result.effect.newAnchors.map((a) => a.postedBudget.toString())).toEqual(["3.00", "9.00"]);
  expect(result.afterPositions.map((p) => p.consumedPosted.toString())).toEqual(["1.50", "4.50"]);
  expect(result.afterHoldings.map((h) => [h.remainingTotalBasis.toString(), h.remainingValuationAllowance.toString(), h.remainingCarryingAmount.toString()])).toEqual([["3/1", "-3/2", "3/2"], ["6/1", "-3/2", "9/2"]]);
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", result.effect)).disposition).toBe("decoded");
});

test("ownership selection rejects policy, canonical pool and stable-identity substitutions", () => {
  const f = ownershipCostFixture();
  const rejectedSelection = (policies = [f.policy], sources = f.canonicalPool, request = f.request) => {
    const before = hashCanonical(canonicalAccountingValue({ policies, sources, request }));
    const result = prepareInventoryOwnershipSelection(policies, IDS.book, sources, request);
    expect(result.disposition).toBe("rejected");
    expect(Object.hasOwn(result, "selection")).toBeFalse();
    expect(hashCanonical(canonicalAccountingValue({ policies, sources, request }))).toEqual(before);
  };
  rejectedSelection([]);
  rejectedSelection([f.policy, f.policy]);
  for (const patch of [{ validTo: f.request.governedAt }, { bookId: bookId("foreign") }, { algorithmVersion: semanticVersion("99.0.0") },
    { capability: { ...f.policy.capability, admittedCombinations: [{ method: "fifo" }] } },
    { pools: [{ ...f.policy.pools[0]!, contentHash: hashCanonical({ forged: true }) }] }]) rejectedSelection([{ ...f.policy, ...patch }]);
  for (const patch of [{ derivation: { ...f.request.derivation, state: "proposed" as const } },
    { derivation: { ...f.request.derivation, inputHash: { ...f.request.derivation.inputHash, algorithm: "sha512" } as never } },
    { identities: [] }, { identities: [f.request.identities[0]!, f.request.identities[0]!] },
    { identities: [{ ...f.request.identities[0]!, holdingId: lotHoldingId("invented") }, f.request.identities[1]!] },
    { quantity: r(7n) }]) rejectedSelection([f.policy], f.canonicalPool, { ...f.request, ...patch });
  rejectedSelection([f.policy], [f.canonicalPool[0]!, f.canonicalPool[0]!]);
  for (const patch of [{ accountId: accountId("outside") }, { commodityId: commodityId("foreign") }, { remainingQuantity: r(-1n) },
    { remainingValuationAllowance: r(1n) }, { remainingCarryingAmount: r(1n) }]) {
    rejectedSelection([f.policy], [{ ...f.canonicalPool[0]!, holding: { ...f.canonicalPool[0]!.holding, ...patch } }, f.canonicalPool[1]!]);
  }
  const conflicting = { ...f.canonicalPool[1]!, holding: { ...f.canonicalPool[1]!.holding, lotId: f.canonicalPool[0]!.lot.id },
    lot: { ...f.canonicalPool[1]!.lot, id: f.canonicalPool[0]!.lot.id } };
  rejectedSelection([f.policy], [f.canonicalPool[0]!, conflicting]);
  expect(prepareInventoryOwnershipSelection(new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1), IDS.book, [], f.request).disposition).toBe("rejected");
  expect(prepareInventoryOwnershipSelection([f.policy], IDS.book, [{ ...f.canonicalPool[0]!, lot: { ...f.canonicalPool[0]!.lot, evidenceIds: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) } }], f.request).disposition).toBe("rejected");
});

test("free/depleted pool rows and explicit provisional remainders are not lost during ownership selection", () => {
  const f = ownershipCostFixture("fifo"), free = acquisitionEntry(0, r(0n)), depleted = acquisitionEntry(1, r(0n));
  const canonicalPool = [{ holding: free.holding, lot: free.lot }, { holding: { ...depleted.holding, remainingQuantity: r(0n) }, lot: depleted.lot }];
  const selected = prepareInventoryOwnershipSelection([f.policy], IDS.book, canonicalPool, f.request);
  expect(selected.disposition).toBe("selected");
  if (selected.disposition !== "selected") throw new Error("Free pool rejected");
  expect(selected.selection.ordinaryCarryingAmount.isZero()).toBeTrue();
  expect(selected.selection.allocations[0]!.allocation.allocatedQuantity.equals(r(3n))).toBeTrue();
  const policy: InventoryCostPolicy = { ...f.policy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: r(2n) };
  const partial = prepareInventoryOwnershipSelection([policy], IDS.book, canonicalPool, { ...f.request, quantity: r(5n) });
  if (partial.disposition !== "selected") throw new Error("Governed provisional remainder rejected");
  expect([partial.selection.ordinaryQuantity, partial.selection.provisionalQuantity, partial.selection.provisionalBasis]).toEqual([r(3n), r(2n), r(4n)]);
  const allProvisional = prepareInventoryOwnershipSelection([policy], IDS.book, [], { ...f.request, quantity: r(5n), identities: [] });
  if (allProvisional.disposition !== "selected") throw new Error("Wholly provisional selection rejected");
  expect(allProvisional.selection.allocations).toEqual([]);
  expect(allProvisional.selection.provisionalBasis.equals(r(10n))).toBeTrue();
});

test("ownership selection's conservation check refuses a faulty costing dependency", () => {
  const f = ownershipCostFixture("fifo");
  // Fault injection, not an executable business fixture or a mutation score.
  const spy = spyOn(accountingRuntime, "calculateInventoryCost").mockReturnValue({ disposition: "costed",
    allocations: [{ layerId: f.canonicalPool[0]!.holding.id, quantity: r(3n), basis: r(999n) }], ordinaryBasis: r(999n), provisionalQuantity: r(0n), provisionalBasis: r(0n) });
  try {
    const result = prepareInventoryOwnershipSelection([f.policy], IDS.book, f.canonicalPool, f.request);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Faulty economics escaped");
    expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.selectionConservation");
    expect(Object.hasOwn(result, "selection")).toBeFalse();
  } finally { spy.mockRestore(); }
  expect(prepareInventoryOwnershipSelection([f.policy], IDS.book, f.canonicalPool, f.request).disposition).toBe("selected");
});

function mixedOwnershipFixture() {
  const entries = [acquisitionEntry(0), acquisitionEntry(1), acquisitionEntry(2)];
  const debit = actualGroupJournal("-0.01", r(-9n), r(-1n, 100n));
  const credit = actualGroupJournal("0.01", r(9n), r(1n, 100n));
  const base = journal("mixed-ownership");
  const postings = [...debit.source.journal.postings, ...credit.source.journal.postings].map((p, i) => ({ ...p, id: postingId(`mixed-post-${i}`), ordinal: BigInt(i + 1) }));
  const source = admittedGroupSource({ ...base, postings });
  const acquire: Extract<InventoryOwnershipOperation, { kind: "acquisition" }> = { kind: "acquisition", entries,
    inventoryPolicy: acquisitionContext().inventoryPolicy, quantizationPolicy, dimensionMemberIds: [],
    journalLink: { source, postingId: postings[0]!.id, referenceId: canonicalPostingReferenceId("mixed-debit") } };
  const reduce: InventoryReductionOperation = { kind: "disposal", allocations: entries.map((entry, i) => ({ movementId: identifier<"InventoryPostedMovement">(`mixed-reduction-${i}`),
    allocation: { id: lotAllocationId(`mixed-allocation-${i}`), holdingId: entry.holding.id, lotId: entry.lot.id, allocatedQuantity: entry.holding.remainingQuantity,
      allocatedTotalBasis: entry.holding.remainingTotalBasis, allocatedValuationAllowance: entry.holding.remainingValuationAllowance,
      allocatedCarryingAmount: entry.holding.remainingCarryingAmount, derivation: accountingDerivation } })),
    journalLink: { source, postingId: postings[2]!.id, referenceId: canonicalPostingReferenceId("mixed-credit") } };
  return { entries, acquire, reduce, operations: [acquire, reduce] as readonly InventoryOwnershipOperation[] };
}

function mixedRejected(sources: readonly InventoryPostedReductionSource[], operations: readonly InventoryOwnershipOperation[], path?: string) {
  const before = hashCanonical(canonicalAccountingValue({ sources, operations }));
  const result = prepareInventoryOwnershipEffect(groupContext, sources, operations);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Invalid mixed effect prepared");
  if (path !== undefined) expect(result.diagnostics[0]?.path).toBe(path);
  expect(Object.hasOwn(result, "effect")).toBeFalse();
  expect(Object.hasOwn(result, "newLots")).toBeFalse();
  expect(hashCanonical(canonicalAccountingValue({ sources, operations }))).toEqual(before);
}

test("one complete ownership effect acquires and depletes new holdings through internally computed origins", () => {
  const f = mixedOwnershipFixture(), result = prepareInventoryOwnershipEffect(groupContext, [], f.operations);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Mixed ownership lifecycle rejected");
  const effect = result.effect;
  expect(effect.newAnchors.map((a) => a.artifactOrdinal)).toEqual([1n, 2n, 3n]);
  expect(effect.journalLinkedMovements.map((m) => [m.kind, m.artifactOrdinal, m.postedAmount.toString()])).toEqual([["acquisition", 5n, "0.01"], ["disposal", 8n, "-0.01"]]);
  expect(effect.quantityOnlyMovements.map((m) => m.artifactOrdinal)).toEqual([4n, 6n, 7n, 9n]);
  expect(result.newLots).toEqual(f.entries.map((e) => e.lot));
  expect(result.afterHoldings.every((h) => h.remainingQuantity.isZero() && h.remainingTotalBasis.isZero() && h.remainingValuationAllowance.isZero() && h.remainingCarryingAmount.isZero())).toBeTrue();
  const movements = [...effect.journalLinkedMovements, ...effect.quantityOnlyMovements];
  for (const movement of movements) if (movement.kind === "disposal") {
    const origin = movements.find((m) => m.kind === "acquisition" && m.coordinate.holdingId === movement.coordinate.holdingId)!;
    expect(movement.beforePosition.contentHash).toEqual(origin.afterPosition.contentHash);
    expect(movement.beforePosition.artifactOrdinal).toBe(origin.artifactOrdinal);
    expect(movement.afterPosition.anchor.bookRevision).toBe(groupContext.bookRevision);
  }
  expect(prepareInventoryOwnershipEffect(groupContext, [], [{ ...f.acquire, entries: [...f.entries].reverse() }, f.reduce])).toEqual(result);
  const bytes = encodeInventoryOwnershipArtifact("ownershipEffect", effect);
  const decoded = decodeInventoryOwnershipArtifact("ownershipEffect", bytes);
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(decoded.artifact).toEqual(effect);
  expect(Object.isFrozen(decoded.artifact.newAnchors[0]!.quantizationPolicy)).toBeTrue();
  expect(decodeInventoryOwnershipArtifact("reductionEffect", bytes).disposition).toBe("rejected");
  expect(decodeDurableBook(bytes).disposition).toBe("rejected");
  expect(hashInventoryOwnershipEffect(effect)).toEqual(effect.contentHash);
});

test("mixed ownership enforces creation order, whole-effect identities and discard on late failure", () => {
  const f = mixedOwnershipFixture();
  mixedRejected([], [f.reduce, f.acquire], "inventoryOwnership.effectSource");
  mixedRejected([], [f.acquire, f.reduce, { kind: f.reduce.kind, allocations: f.reduce.allocations.map((a) => ({ ...a,
    movementId: identifier<"InventoryPostedMovement">(`late-${a.movementId}`), allocation: { ...a.allocation, id: lotAllocationId(`late-${a.allocation.id}`) } })) }]);
  mixedRejected([], [f.acquire, { ...f.reduce, allocations: [{ ...f.reduce.allocations[0]!, movementId: f.entries[0]!.movementId }, ...f.reduce.allocations.slice(1)] }], "inventoryOwnership.effectIdentity");
  const reused = { ...f.acquire, entries: f.entries.map((e) => ({ ...e, movementId: identifier<"InventoryPostedMovement">(`second-${e.movementId}`) })) };
  mixedRejected([], [f.acquire, reused], "inventoryOwnership.effectIdentity");
  mixedRejected([originalSource(groupEntry("0.01", 0))], f.operations, "inventoryOwnership.effectIdentity");
  mixedRejected([originalSource(groupEntry("0.01", 99))], f.operations, "inventoryOwnership.effectSource");
  mixedRejected([], [f.acquire, { ...f.reduce, journalLink: f.acquire.journalLink! }], "inventoryOwnership.effectPostingIdentity");
  mixedRejected([], [f.acquire, { ...f.reduce, journalLink: { ...f.reduce.journalLink!, referenceId: f.acquire.journalLink!.referenceId } }], "inventoryOwnership.effectPostingIdentity");
  mixedRejected([], [f.acquire, { ...f.reduce, journalLink: { ...f.reduce.journalLink!, source: { ...f.reduce.journalLink!.source, commandId: commandId("changed-source") } } }], "inventoryOwnership.effectJournalSource");
  const narrow = prepareInventoryReductionEffect(groupContext, [originalSource(groupEntry("0.01", 99))], [f.acquire as never]);
  expect(narrow.disposition).toBe("rejected");
  expect(Object.hasOwn(narrow, "effect")).toBeFalse();
  const unsupported = { ...f.acquire, quantizationPolicy: { ...quantizationPolicy, roundingMode: "unknown" as RoundingMode } };
  mixedRejected([], [unsupported]);
  expect(prepareInventoryOwnershipEffect(groupContext, [], [{ ...f.acquire, entries: [{ ...f.entries[0]!, evidence: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) }] }]).disposition).toBe("rejected");
});

test("general ownership effects preserve reduction-only hashes and retain all-zero acquisition lifecycles", () => {
  const entry = groupEntry("0.01", 0), operations = [reductionOperation(entry, 0)];
  const reduced = prepareInventoryReductionEffect(groupContext, [originalSource(entry)], operations);
  const general = prepareInventoryOwnershipEffect(groupContext, [originalSource(entry)], operations);
  if (reduced.disposition !== "prepared" || general.disposition !== "prepared") throw new Error("Equivalent reductions required");
  expect(general.effect).toEqual(reduced.effect);
  expect(general.newLots).toEqual([]);
  expect(hashInventoryOwnershipEffect(general.effect)).toEqual(hashInventoryReductionOwnershipEffect(reduced.effect));
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", general.effect)).disposition).toBe("decoded");
  const f = mixedOwnershipFixture(), free = acquisitionEntry(0, r(0n));
  const { journalLink: _journalLink, ...withoutPosting } = f.acquire;
  const acquire = { ...withoutPosting, entries: [free] };
  const allocation = { ...f.reduce.allocations[0]!, allocation: { ...f.reduce.allocations[0]!.allocation, allocatedTotalBasis: r(0n), allocatedCarryingAmount: r(0n) } };
  const allZero = prepareInventoryOwnershipEffect(groupContext, [], [acquire, { kind: "disposal", allocations: [allocation] }]);
  expect(allZero.disposition).toBe("prepared");
  if (allZero.disposition !== "prepared") throw new Error("Free mixed lifecycle rejected");
  expect(allZero.effect.journalLinkedMovements).toEqual([]);
  expect(allZero.effect.quantityOnlyMovements.map((m) => m.artifactOrdinal)).toEqual([2n, 3n]);
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", allZero.effect)).disposition).toBe("decoded");
});

test("mixed effect transport rejects rehashed gaps, orphan anchors and detached same-command positions", () => {
  const f = mixedOwnershipFixture(), result = prepareInventoryOwnershipEffect(groupContext, [], f.operations);
  if (result.disposition !== "prepared") throw new Error("Valid mixed fixture required");
  const effect = result.effect;
  const invalid = (patch: Partial<InventoryOwnershipEffect>) => {
    const changed = { ...effect, ...patch };
    codecRejected("ownershipEffect", { ...changed, contentHash: hashInventoryOwnershipEffect(changed) });
  };
  invalid({ newAnchors: [] });
  invalid({ newAnchors: [...effect.newAnchors].reverse() });
  invalid({ newAnchors: [effect.newAnchors[0]!, effect.newAnchors[0]!, effect.newAnchors[2]!] });
  invalid({ journalLinkedMovements: [...effect.journalLinkedMovements].reverse() });
  invalid({ quantityOnlyMovements: effect.quantityOnlyMovements.slice(1) });
  invalid({ bookRevision: 3n });
  const acquisition = effect.journalLinkedMovements[0]!;
  if (acquisition.kind !== "acquisition") throw new Error("Acquisition expected");
  const consumed = { ...acquisition.afterPosition, consumedQuantity: r(1n) };
  const changedAcquisition = { ...acquisition, afterPosition: { ...consumed, contentHash: hashInventoryPostedPosition(consumed) } };
  invalid({ journalLinkedMovements: [{ ...changedAcquisition, contentHash: hashInventoryPostedAcquisitionMovement(changedAcquisition) }, effect.journalLinkedMovements[1]!] });
  const reduction = effect.journalLinkedMovements[1]!;
  if (reduction.kind !== "disposal") throw new Error("Reduction expected");
  const changedReduction = { ...reduction, beforePosition: { ...reduction.beforePosition, contentHash: hashCanonical({ differentOrigin: true }) } };
  invalid({ journalLinkedMovements: [acquisition, { ...changedReduction, contentHash: hashInventoryPostedReductionMovement(changedReduction) }] });
  const anchor = { ...effect.newAnchors[0]!, postedBudget: D.parse("0.01") };
  invalid({ newAnchors: [{ ...anchor, contentHash: hashInventoryPostedAnchor(anchor) }, ...effect.newAnchors.slice(1)] });
});

test("mixed read-context evaluation resolves external originals only and never reads same-command stand-ins", () => {
  const f = mixedOwnershipFixture(), { reader, events } = ownershipReader([]);
  const result = prepareInventoryOwnershipEffectFromReadContext(reader, groupContext, f.operations);
  expect(result).toEqual(prepareInventoryOwnershipEffect(groupContext, [], f.operations));
  expect(events.filter((event) => event !== "guard")).toEqual([]);
  const narrow = prepareInventoryReductionEffectFromReadContext(reader, groupContext, [f.acquire as never]);
  expect(narrow.disposition).toBe("rejected");
  expect(Object.hasOwn(narrow, "effect")).toBeFalse();
  expect(() => prepareInventoryReductionEffectFromReadContext({ ...reader, assertCurrent() { throw new Error("expired before preflight"); } }, groupContext,
    new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1))).toThrow("expired before preflight");
  let guards = 0;
  expect(() => prepareInventoryOwnershipEffectFromReadContext({ ...reader, assertCurrent() { if (++guards === 3) throw new Error("mixed head expired"); } }, groupContext, f.operations)).toThrow("mixed head expired");
  const reversed = prepareInventoryOwnershipEffectFromReadContext(reader, groupContext, [f.reduce, f.acquire]);
  expect(reversed.disposition).toBe("rejected");
  if (reversed.disposition !== "rejected") throw new Error("Future creation used as existing source");
  expect(reversed.diagnostics[0]?.path).toBe("inventoryOwnership.currentSource");

  const existing = groupEntry("0.00", 99), fresh = acquisitionEntry(0, r(0n));
  const { journalLink: _link, ...noJournal } = f.acquire;
  const acquire = { ...noJournal, entries: [fresh] };
  const consumeNew: InventoryReductionOperation = { kind: "disposal", allocations: [{ movementId: identifier<"InventoryPostedMovement">("fresh-disposal"),
    allocation: { ...f.reduce.allocations[0]!.allocation, allocatedTotalBasis: r(0n), allocatedCarryingAmount: r(0n) } }] };
  const operations: readonly InventoryOwnershipOperation[] = [acquire, reductionOperation(existing, 0), consumeNew];
  const scoped = ownershipReader([originalSource(existing)]);
  const mixed = prepareInventoryOwnershipEffectFromReadContext(scoped.reader, groupContext, operations);
  expect(mixed.disposition).toBe("prepared");
  if (mixed.disposition !== "prepared") throw new Error("Existing and new sources must combine");
  expect(scoped.events.filter((event) => event.startsWith("holding:"))).toEqual([`holding:${existing.holding.id}`]);
  expect(mixed.afterHoldings.map((h) => h.remainingQuantity)).toEqual([r(0n), r(2n)]);
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", mixed.effect)).disposition).toBe("decoded");
  const before = scoped.events.length;
  const oversized = prepareInventoryOwnershipEffectFromReadContext(scoped.reader, groupContext, [{ ...acquire, entries: [{ ...fresh, evidence: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) }] }]);
  expect(oversized.disposition).toBe("rejected");
  expect(scoped.events.slice(before)).toEqual(["guard"]);
  const partial = { ...consumeNew.allocations[0]!, allocation: { ...consumeNew.allocations[0]!.allocation, allocatedQuantity: r(1n) } };
  const sequential = prepareInventoryOwnershipEffect(groupContext, [], [acquire, ...[0, 1, 2].map((i): InventoryReductionOperation => ({ kind: "disposal", allocations: [{
    movementId: identifier<"InventoryPostedMovement">(`step-${i}`), allocation: { ...partial.allocation, id: lotAllocationId(`step-${i}`) },
  }] }))]);
  if (sequential.disposition !== "prepared") throw new Error("Successive new-position reductions rejected");
  expect(sequential.effect.quantityOnlyMovements.map((m) => m.afterPosition.consumedQuantity)).toEqual([r(0n), r(1n), r(2n), r(3n)]);
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", sequential.effect)).disposition).toBe("decoded");
});
function acquisitionRejected(entries: readonly InventoryPostedAcquisitionEntry[], link?: Parameters<typeof prepareInventoryPostedAcquisitionGroup>[2], context = acquisitionContext()) {
  const before = hashCanonical(canonicalAccountingValue({ entries, link, context }));
  const result = prepareInventoryPostedAcquisitionGroup(context, entries, link);
  expect(result.disposition).toBe("rejected");
  expect(Object.hasOwn(result, "group")).toBeFalse();
  expect(hashCanonical(canonicalAccountingValue({ entries, link, context }))).toEqual(before);
}

test("complete acquisition attribution creates first anchors and mixed origin movements from a real admitted posting", () => {
  const entries = [acquisitionEntry(0), acquisitionEntry(1), acquisitionEntry(2)], context = acquisitionContext();
  const link = actualGroupJournal("-0.01", r(-9n), r(-1n, 100n));
  const result = prepareInventoryPostedAcquisitionGroup(context, [...entries].reverse(), link);
  expect(result.disposition).toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Valid acquisition rejected");
  expect(prepareInventoryPostedAcquisitionGroup(context, entries, link)).toEqual(result);
  expect(result.group.anchors.map((a) => a.postedBudget.toString())).toEqual(["0.00", "0.01", "0.00"]);
  expect(result.group.anchors.map((a) => a.artifactOrdinal)).toEqual([1n, 2n, 3n]);
  expect(result.group.movements.map((m) => m.artifactOrdinal)).toEqual([4n, 5n, 6n]);
  expect(result.group.movements.map((m) => m.monetaryKind)).toEqual(["quantityOnly", "journalLinked", "quantityOnly"]);
  expect(result.group.anchors.reduce((s, a) => s.add(a.postedBudget.toRational()), r(0n)).equals(link.source.journal.postings[0]!.bookValue.amount.toRational())).toBeTrue();
  for (const [i, movement] of result.group.movements.entries()) {
    expect(movement.afterPosition.anchor.contentHash).toEqual(result.group.anchors[i]!.contentHash);
    expect(movement.afterPosition.consumedQuantity.equals(r(0n))).toBeTrue();
    expect(movement.afterPosition.consumedPosted.isZero()).toBeTrue();
    expect(Object.hasOwn(movement, "posting")).toBe(i === 1);
    expect(Object.isFrozen(movement.acquisitionProof.policy)).toBeTrue();
    const decoded = decodeInventoryOwnershipArtifact("acquisitionMovement", encodeInventoryOwnershipArtifact("acquisitionMovement", movement));
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    expect(decoded.artifact).toEqual(movement);
    expect(decodeInventoryOwnershipArtifact("reductionMovement", encodeInventoryOwnershipArtifact("acquisitionMovement", movement)).disposition).toBe("rejected");
  }
  // The real newly constructed origin after-images now satisfy the source read
  // contract. Their durable publication/authentication is still future work.
  const sources = result.group.anchors.map((anchor, i) => ({ anchor, position: result.group.movements[i]!.afterPosition, holding: result.group.holdings[i]! }));
  const reader = { ...ownershipReader(sources).reader, bookRevision: 2n };
  const selected = resolveInventoryOwnershipSources(reader, entries.map((e) => e.holding.id));
  expect(selected.disposition).toBe("resolved");
  const allocations = sources.map((s, i) => ({ movementId: identifier<"InventoryPostedMovement">(`issue-new-${i}`),
    allocation: { id: lotAllocationId(`issue-new-${i}`), holdingId: s.holding.id, lotId: s.holding.lotId,
      allocatedQuantity: s.holding.remainingQuantity, allocatedTotalBasis: s.holding.remainingTotalBasis,
      allocatedValuationAllowance: s.holding.remainingValuationAllowance, allocatedCarryingAmount: s.holding.remainingCarryingAmount, derivation: accountingDerivation } }));
  const credit = actualGroupJournal("0.01", r(9n), r(1n, 100n));
  const acquiredBook = admittedGroupExecution(link.source.journal);
  const creditBase = journal("lifecycle-credit");
  const creditJournal = { ...credit.source.journal, id: creditBase.id, postings: credit.source.journal.postings.map((p, i) => ({ ...p, id: creditBase.postings[i]!.id })) };
  const nextCommand = sealCommand({ id: commandId("next-command"), type: "postJournal" as const, bookId: IDS.book, actorId: IDS.actor,
    protocolVersion: semanticVersion("1.0.0"), expectedBookRevision: 2n, issuedAt: instant("2026-01-15T15:00:00Z"),
    completedAt: instant("2026-01-15T15:00:01Z"), committedAt: instant("2026-01-15T15:00:02Z"), resolved: resolved(creditJournal) });
  const issuedBook = executeBookCommand(acquiredBook.state, acquiredBook.protocol, nextCommand);
  expect(issuedBook.result.disposition).toBe("committed");
  if (issuedBook.result.disposition !== "committed") throw new Error("Lifecycle credit journal must really commit at revision 3");
  const actualCredit = issuedBook.state.journals[1]!;
  const nextContext = { ...groupContext, commandId: nextCommand.id, bookRevision: 3n, effectKey: effectKey("next:ownership") };
  const issue = prepareInventoryReductionEffectFromReadContext(reader, nextContext, [{ kind: "disposal", allocations,
    journalLink: { source: actualCredit, postingId: actualCredit.journal.postings[0]!.id, referenceId: credit.referenceId } }]);
  expect(issue.disposition).toBe("prepared");
  if (issue.disposition !== "prepared") throw new Error("New acquisition budgets could not be consumed");
  expect(issue.afterHoldings.every((h) => h.remainingQuantity.isZero() && h.remainingCarryingAmount.isZero())).toBeTrue();
  expect(issue.effect.journalLinkedMovements[0]!.postedAmount.toString()).toBe("-0.01");
});

test("free and rounded-zero acquisitions retain explicit evidence without a fabricated journal", () => {
  for (const entries of [[acquisitionEntry(0, r(0n)), acquisitionEntry(1, r(0n))], [acquisitionEntry(0, r(1n, 1000n))], [acquisitionEntry(0, r(8n), r(-8n))]]) {
    const result = prepareInventoryPostedAcquisitionGroup(acquisitionContext(), entries);
    expect(result.disposition).toBe("prepared");
    if (result.disposition !== "prepared") throw new Error("Valid quantity-only acquisition rejected");
    expect(result.group.postedAmount.isZero()).toBeTrue();
    for (const [i, m] of result.group.movements.entries()) {
      expect(m.monetaryKind).toBe("quantityOnly");
      expect(Object.hasOwn(m, "posting")).toBeFalse();
      expect(result.group.anchors[i]!.sourcePostings).toEqual([]);
      expect(result.group.anchors[i]!.evidence).toEqual(entries[i]!.evidence);
      expect(decodeInventoryOwnershipArtifact("anchor", encodeInventoryOwnershipArtifact("anchor", result.group.anchors[i]!)).disposition).toBe("decoded");
      expect(decodeInventoryOwnershipArtifact("acquisitionMovement", encodeInventoryOwnershipArtifact("acquisitionMovement", m)).disposition).toBe("decoded");
    }
  }
  acquisitionRejected([acquisitionEntry(0, r(1n))]);
  const zero = acquisitionEntry(0, r(0n));
  acquisitionRejected([{ ...zero, evidence: [] }]);
});

test("acquisition attribution follows cumulative carrying weights under every supported rounding mode", () => {
  const entries = [acquisitionEntry(0, r(1n, 600n)), acquisitionEntry(1, r(1n, 300n)), acquisitionEntry(2, r(1n, 200n))];
  const link = actualGroupJournal("-0.01", r(-9n), r(-1n, 100n));
  // Independent cent-coefficient answers at cumulative fractions 1/6, 1/2, 1.
  const cases: readonly [RoundingMode, readonly bigint[]][] = [
    ["halfEven", [0n, 0n, 1n]], ["halfAwayFromZero", [0n, 1n, 0n]],
    ["towardZero", [0n, 0n, 1n]], ["floor", [0n, 0n, 1n]], ["ceiling", [1n, 0n, 0n]],
  ];
  for (const [roundingMode, expected] of cases) {
    const context = { ...acquisitionContext(), quantizationPolicy: { ...quantizationPolicy, roundingMode } };
    const result = prepareInventoryPostedAcquisitionGroup(context, entries, link);
    expect(result.disposition).toBe("prepared");
    if (result.disposition !== "prepared") throw new Error("Supported acquisition quantizer rejected");
    expect(result.group.anchors.map((a) => a.postedBudget.coefficient)).toEqual([...expected]);
    expect(result.group.anchors.reduce((sum, a) => sum + a.postedBudget.coefficient, 0n)).toBe(1n);
  }
  const mixed = [acquisitionEntry(0, r(0n)), acquisitionEntry(1, r(1n, 100n))];
  const mixedLink = actualGroupJournal("-0.01", r(-6n), r(-1n, 100n));
  const result = prepareInventoryPostedAcquisitionGroup(acquisitionContext(), mixed, mixedLink);
  if (result.disposition !== "prepared") throw new Error("Zero carrying-weight member rejected");
  expect(result.group.anchors.map((a) => a.postedBudget.coefficient)).toEqual([0n, 1n]);
  expect(result.group.movements[0]!.acquisitionProof.beforeFraction.equals(result.group.movements[0]!.acquisitionProof.afterFraction)).toBeTrue();
  expect(decodeInventoryOwnershipArtifact("acquisitionMovement", encodeInventoryOwnershipArtifact("acquisitionMovement", result.group.movements[0]!)).disposition).toBe("decoded");
  acquisitionRejected([acquisitionEntry(0, r(0n))], actualGroupJournal("-0.01", r(-3n), r(0n)));
});

test("acquisition groups reject identity, evidence, economic and source-posting substitutions atomically", () => {
  const entry = acquisitionEntry(0, r(8n)), context = acquisitionContext(), link = actualGroupJournal("-8.00", r(-3n), r(-8n));
  for (const entries of [[], [entry, entry], [{ ...entry, anchorId: "" as typeof entry.anchorId }],
    [{ ...entry, holding: { ...entry.holding, remainingQuantity: r(2n) } }],
    [{ ...entry, holding: { ...entry.holding, remainingCarryingAmount: r(-1n) } }],
    [{ ...entry, holding: { ...entry.holding, remainingValuationAllowance: r(1n) } }],
    [{ ...entry, lot: { ...entry.lot, evidenceIds: ["invented"] } }], [{ ...entry, evidence: [entry.evidence[0]!, entry.evidence[0]!] }]]) acquisitionRejected(entries, link);
  for (const patch of [{ bookRevision: 0n }, { firstArtifactOrdinal: 0n }, { dimensionMemberIds: [dimensionMemberId("z"), dimensionMemberId("a")] },
    { inventoryPolicy: { ...context.inventoryPolicy, policyContentHash: hashCanonical({ wrong: true }), policyId: "" as typeof context.inventoryPolicy.policyId } },
    { quantizationPolicy: { ...quantizationPolicy, roundingMode: "unknown" as RoundingMode } }]) acquisitionRejected([entry], link, { ...context, ...patch });
  for (const patch of [{ bookRevision: 3n }, { commandId: commandId("other") }, { canonicalHash: hashCanonical({ forged: true }) },
    { effectKey: context.effectKey }, { fiscalPeriodId: fiscalPeriodId("other") }]) acquisitionRejected([entry], { ...link, source: { ...link.source, ...patch } });
  acquisitionRejected([entry], { ...link, postingId: postingId("missing") });
  for (const patch of [{ bookValue: { amount: D.parse("-8.00"), functionalCommodityId: IDS.usd } },
    { bookValue: { amount: D.parse("0.00"), functionalCommodityId: IDS.usd } },
    { bookValue: { amount: D.parse("8.001"), functionalCommodityId: IDS.usd } },
    { units: { commodityId: inventoryUnits, canonicalNumber: r(4n) } }, { costBasis: { basisCommodityId: IDS.usd, totalBasis: r(7n) } }]) {
    const j = { ...link.source.journal, postings: [{ ...link.source.journal.postings[0]!, ...patch }, link.source.journal.postings[1]!] };
    acquisitionRejected([entry], { ...link, source: { ...link.source, journal: j, canonicalHash: hashCanonical(canonicalJournalValue(j)) } });
  }
  const oversized = prepareInventoryPostedAcquisitionGroup(context, new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1));
  expect(oversized.disposition).toBe("rejected");
  expect(prepareInventoryPostedAcquisitionGroup(context, [{ ...entry, evidence: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) }]).disposition).toBe("rejected");
});

test("acquisition movement transport rejects rehashed consumption, origin, proof and monetary-variant lies", () => {
  const entry = acquisitionEntry(0, r(8n)), link = actualGroupJournal("-8.00", r(-3n), r(-8n));
  const result = prepareInventoryPostedAcquisitionGroup(acquisitionContext(), [entry], link);
  if (result.disposition !== "prepared") throw new Error("Valid acquisition required");
  const m = result.group.movements[0]!;
  for (const patch of [{ postedAmount: D.parse("7.99") }, { afterPosition: { ...m.afterPosition, consumedQuantity: r(1n) } },
    { afterPosition: { ...m.afterPosition, originArtifactOrdinal: 3n } }, { acquisitionProof: { ...m.acquisitionProof, afterTarget: r(9n) } },
    { acquisitionProof: { ...m.acquisitionProof, afterFraction: r(2n) } }, { acquisitionProof: { ...m.acquisitionProof, policy: { ...quantizationPolicy, bookId: bookId("other") } } }]) {
    const body = { ...m, ...patch }, position = { ...body.afterPosition, contentHash: hashInventoryPostedPosition(body.afterPosition) };
    const movement = { ...body, afterPosition: position } as InventoryPostedAcquisitionMovement;
    codecRejected("acquisitionMovement", { ...movement, contentHash: hashInventoryPostedAcquisitionMovement(movement) });
  }
  codecRejected("acquisitionMovement", { ...m, beforePosition: m.afterPosition.anchor });
  codecRejected("acquisitionMovement", { ...m, kind: "transferIn" });
  const forged = { ...m, monetaryKind: "quantityOnly" as const };
  codecRejected("acquisitionMovement", { ...forged, contentHash: hashInventoryPostedAcquisitionMovement(forged) });
  const fingerprint = hashCanonical(canonicalAccountingValue(result));
  (entry.holding as { remainingQuantity: R }).remainingQuantity = r(99n);
  expect(hashCanonical(canonicalAccountingValue(result))).toEqual(fingerprint);
});

function sourceRejected(reader: InventoryOwnershipReadContext, ids: readonly LotHolding["id"][], path: string) {
  const result = resolveInventoryOwnershipSources(reader, ids);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Invalid ownership sources resolved");
  expect(result.diagnostics[0]?.path).toBe(path);
  expect(Object.hasOwn(result, "sources")).toBeFalse();
}

test("ownership source resolution binds current projections to exact anchors and independent immutable origin after-images", () => {
  const a = groupEntry("8.00", 0), b = groupEntry("0.00", 1), sources = [originalSource(a), originalSource(b)];
  const { reader, events } = ownershipReader(sources);
  const result = resolveInventoryOwnershipSources(reader, [b.holding.id, a.holding.id]);
  expect(result.disposition).toBe("resolved");
  if (result.disposition !== "resolved") throw new Error("Valid original sources rejected");
  expect(result.sources).toEqual(sources);
  expect(events.filter((event) => event.startsWith("holding:"))).toEqual([`holding:${a.holding.id}`, `holding:${b.holding.id}`]);
  expect(events.filter((event) => event.startsWith("origin:"))).toHaveLength(2);
  for (const value of [result.sources, result.sources[0], result.sources[0]!.anchor.coordinate, result.sources[0]!.position.anchor]) expect(Object.isFrozen(value)).toBeTrue();
  const fingerprint = hashCanonical(canonicalAccountingValue(result));
  (a.holding as { remainingQuantity: R }).remainingQuantity = r(99n);
  expect(hashCanonical(canonicalAccountingValue(result))).toEqual(fingerprint);
});

test("source resolution rejects rehashed projection lies that standalone transport accepts", () => {
  const f = groupEntry("8.00", 0), source = originalSource(f), { reader } = ownershipReader([source]);
  const projected = (patch: Partial<InventoryPostedPosition>) => {
    const body = { ...f.position, ...patch };
    return { ...body, contentHash: hashInventoryPostedPosition(body) };
  };
  for (const patch of [{ consumedPosted: D.parse("100.00") }, { originMovementId: identifier<"InventoryPostedMovement">("invented") },
    { consumedQuantity: r(1n), consumedPosted: D.parse("2.67") }]) {
    const fake = projected(patch);
    expect(decodeInventoryOwnershipArtifact("position", encodeInventoryOwnershipArtifact("position", fake)).disposition).toBe("decoded");
    sourceRejected({ ...reader, readCurrentPosition: () => fake }, [f.holding.id], "inventoryOwnership.positionOrigin");
  }
  const anchorBody = { ...f.anchor, postedBudget: D.parse("7.00") }, substitute = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
  sourceRejected({ ...reader, readAnchor: () => substitute }, [f.holding.id], "inventoryOwnership.anchorSource");
  sourceRejected({ ...reader, readPositionAfterImage: () => ({ ...f.position, originMovementId: identifier<"InventoryPostedMovement">("wrong") }) }, [f.holding.id], "inventoryOwnership.positionOrigin");
  sourceRejected({ ...reader, readCurrentHolding: () => undefined }, [f.holding.id], "inventoryOwnership.currentSource");
  sourceRejected({ ...reader, readCurrentPosition: () => undefined }, [f.holding.id], "inventoryOwnership.currentSource");
  sourceRejected({ ...reader, readAnchor: () => undefined }, [f.holding.id], "inventoryOwnership.anchorSource");
  sourceRejected({ ...reader, readPositionAfterImage: () => undefined }, [f.holding.id], "inventoryOwnership.positionOrigin");
});

test("resolved positions include depleted inventory but enforce exact quantity, economic and cumulative posted balances", () => {
  const f = groupEntry("8.00", 0);
  const terminalBody = { ...f.position, consumedQuantity: r(3n), consumedPosted: D.parse("8.00") };
  const terminal = { ...terminalBody, contentHash: hashInventoryPostedPosition(terminalBody) };
  const depleted = { ...originalSource(f), position: terminal, holding: { ...f.holding, remainingQuantity: r(0n), remainingTotalBasis: r(0n), remainingCarryingAmount: r(0n) } };
  expect(resolveInventoryOwnershipSources(ownershipReader([depleted]).reader, [f.holding.id]).disposition).toBe("resolved");
  for (const patch of [{ consumedQuantity: r(4n) }, { consumedPosted: D.parse("7.99") }]) {
    const body = { ...terminal, ...patch };
    sourceRejected(ownershipReader([{ ...depleted, position: { ...body, contentHash: hashInventoryPostedPosition(body) } }]).reader, [f.holding.id], "inventoryOwnership.positionBalance");
  }
  for (const patch of [{ remainingQuantity: r(1n) }, { remainingTotalBasis: r(-1n) }, { remainingValuationAllowance: r(1n) },
    { remainingCarryingAmount: r(-1n) }, { remainingCarryingAmount: r(1n) }, { remainingTotalBasis: r(8n), remainingValuationAllowance: r(-8n) }]) {
    sourceRejected(ownershipReader([{ ...depleted, holding: { ...depleted.holding, ...patch } }]).reader, [f.holding.id], "inventoryOwnership.positionBalance");
  }
  const { reader } = ownershipReader([originalSource(f)]);
  sourceRejected({ ...reader, readCurrentHolding: () => ({ ...f.holding, bookId: bookId("foreign") }) }, [f.holding.id], "inventoryOwnership.currentSource");
  sourceRejected({ ...reader, readCurrentHolding: () => ({ ...f.holding, accountId: accountId("foreign") }) }, [f.holding.id], "inventoryOwnership.anchorSource");
});

test("ownership source reads are bounded and propagate storage or head invalidation instead of producing retained rejections", () => {
  const f = groupEntry("8.00", 0), { reader } = ownershipReader([originalSource(f)]), id = f.holding.id;
  for (const ids of [[], [id, id], ["" as typeof id], new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1).fill(id)]) sourceRejected(reader, ids, "inventoryOwnership.readSet");
  sourceRejected({ ...reader, bookRevision: 0n }, [id], "inventoryOwnership.readSet");
  sourceRejected({ ...reader, readAnchor: () => ({ ...f.anchor, evidence: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) }) }, [id], "inventoryOwnership.readSet");
  for (const method of ["readCurrentHolding", "readCurrentPosition", "readAnchor", "readPositionAfterImage"] as const) {
    const failure = new Error(`storage:${method}`);
    expect(() => resolveInventoryOwnershipSources({ ...reader, [method]: () => { throw failure; } }, [id])).toThrow(failure);
    let invalid = false;
    const poisoned = { ...reader, assertCurrent() { if (invalid) throw new Error("pinned outcome head changed"); },
      [method]: (...args: never[]) => { const value = (reader[method] as (...args: never[]) => unknown)(...args); invalid = true; return value; } };
    expect(() => resolveInventoryOwnershipSources(poisoned as InventoryOwnershipReadContext, [id])).toThrow("pinned outcome head changed");
  }
  const mutable = { ...reader, bookRevision: 1n, readCurrentHolding() { mutable.bookRevision = 2n; return f.holding; } };
  expect(() => resolveInventoryOwnershipSources(mutable, [id])).toThrow("read scope changed");
  let guards = 0;
  expect(() => resolveInventoryOwnershipSources({ ...reader, assertCurrent() { if (++guards === 7) throw new Error("final guard"); } }, [id])).toThrow("final guard");
});

test("read-context reduction preparation resolves each original once and preserves sequential effect output", () => {
  const a = groupEntry("0.01", 0), link = actualEffectJournal(["0.01"], r(1n, 300n))[0]!;
  const operations = [reductionOperation(a, 0), reductionOperation(a, 1, link), reductionOperation(a, 2)];
  const { reader, events } = ownershipReader([originalSource(a)]);
  const result = prepareInventoryReductionEffectFromReadContext(reader, groupContext, operations);
  expect(result).toEqual(prepareInventoryReductionEffect(groupContext, [originalSource(a)], operations));
  if (result.disposition !== "prepared") throw new Error("Read-context candidate rejected");
  expect(result.effect.quantityOnlyMovements.map((m) => m.artifactOrdinal)).toEqual([1n, 3n]);
  expect(result.afterHoldings[0]!.remainingQuantity.equals(r(0n))).toBeTrue();
  expect(events.filter((event) => event.startsWith("holding:"))).toHaveLength(1);
  expect(events.filter((event) => event.startsWith("origin:"))).toHaveLength(1);
  for (const context of [{ ...groupContext, bookRevision: 3n }, { ...groupContext, bookId: bookId("other") }]) {
    expect(prepareInventoryReductionEffectFromReadContext(reader, context, operations).disposition).toBe("rejected");
  }
  for (const ops of [[], new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1), [{ ...operations[0]!, allocations: [] }],
    [{ ...operations[0]!, allocations: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) }]]) {
    expect(prepareInventoryReductionEffectFromReadContext(reader, groupContext, ops).disposition).toBe("rejected");
  }
  expect(prepareInventoryReductionEffectFromReadContext({ ...reader, readCurrentPosition: () => undefined }, groupContext, operations).disposition).toBe("rejected");
  let count = 0;
  expect(() => prepareInventoryReductionEffectFromReadContext({ ...reader, assertCurrent() { if (++count === 10) throw new Error("publication head expired"); } }, groupContext, operations)).toThrow("publication head expired");
  count = 0;
  const changedScope = { ...reader, bookRevision: 1n, assertCurrent() { if (++count === 10) changedScope.bookRevision = 2n; } };
  expect(() => prepareInventoryReductionEffectFromReadContext(changedScope, groupContext, operations)).toThrow("read scope changed");
  count = 0;
  const changedBeforeResolution = { ...reader, bookRevision: 1n, assertCurrent() { if (++count === 2) changedBeforeResolution.bookRevision = 2n; }, readCurrentPosition: () => undefined };
  expect(() => prepareInventoryReductionEffectFromReadContext(changedBeforeResolution, groupContext, operations)).toThrow("read scope changed");
  // Resolving sources must not permit an I/O callback to replace the candidate.
  const mutableOperations = [...operations];
  const snapshotResult = prepareInventoryReductionEffectFromReadContext({ ...reader, readCurrentHolding(id) {
    mutableOperations.splice(0, mutableOperations.length);
    return reader.readCurrentHolding(id);
  } }, groupContext, mutableOperations);
  expect(snapshotResult).toEqual(result);
  expect(mutableOperations).toHaveLength(0);
});

test("read-context preflight preserves the constructor's separate allocation and journal population limits", () => {
  const a = groupEntry("0.01", 0), link = actualEffectJournal(["0.01"], r(1n, 300n))[0]!;
  const { reader, events } = ownershipReader([originalSource(a)]);
  const boundedLink = { ...link, source: { ...link.source, journal: { ...link.source.journal,
    postings: new Array(ACCOUNTING_LIMITS.maxInventoryLayers).fill(link.source.journal.postings[0]!) } } };
  // The missing position deliberately stops before journal semantic admission.
  // One allocation plus a full journal population fits the two separate caps;
  // it must reach source resolution rather than invent a smaller combined cap.
  const result = prepareInventoryReductionEffectFromReadContext({ ...reader, readCurrentPosition: () => undefined }, groupContext, [reductionOperation(a, 0, boundedLink)]);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Missing position admitted");
  expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.currentSource");
  expect(events.filter((event) => event.startsWith("holding:"))).toHaveLength(1);
  const excessive = { ...boundedLink, source: { ...boundedLink.source, journal: { ...boundedLink.source.journal, postings: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1) } } };
  const oversized = prepareInventoryReductionEffectFromReadContext(reader, groupContext, [reductionOperation(a, 0, excessive)]);
  expect(oversized.disposition).toBe("rejected");
  if (oversized.disposition !== "rejected") throw new Error("Oversized journal admitted");
  expect(oversized.diagnostics[0]?.path).toBe("inventoryOwnership.readSet");
  expect(events.filter((event) => event.startsWith("holding:"))).toHaveLength(1);
});
// Borrow only the established raw tagged-value serializer to construct hostile
// packets; the cast is NOT a valid aggregate or a way to bypass production decode.
function ownershipPacket(kind: InventoryOwnershipArtifactKind, artifact: unknown) {
  const body = JSON.parse(encodeDurableBook(artifact as never)).body;
  return ownershipFrame(kind, body);
}
function ownershipFrame(kind: InventoryOwnershipArtifactKind, body: unknown): string {
  return JSON.stringify({ version: INVENTORY_OWNERSHIP_CODEC_VERSION, kind,
    checksum: hashCanonical({ type: INVENTORY_OWNERSHIP_CODEC_VERSION, kind, payload: JSON.stringify(body) }), body });
}
function sealedMovement(movement: InventoryPostedReductionMovement): InventoryPostedReductionMovement {
  const value = { ...movement, afterPosition: { ...movement.afterPosition, contentHash: hashInventoryPostedPosition(movement.afterPosition) } };
  return { ...value, contentHash: hashInventoryPostedReductionMovement(value) };
}
function codecRejected(kind: InventoryOwnershipArtifactKind, value: unknown) {
  const result = decodeInventoryOwnershipArtifact(kind, ownershipPacket(kind, value));
  expect(result.disposition).toBe("rejected");
  expect(Object.hasOwn(result, "artifact")).toBeFalse();
}

for (const unicode of [false, true]) test(`ownership encoder checks intrinsic corruption at the exact ${unicode ? "UTF-8" : "ASCII"} payload limit`, () => {
  const base = example().anchor;
  const candidate = (sourceRecordId: string) => ({ ...base, evidence: [{ ...base.evidence[0]!, sourceRecordId }] });
  const payload = (artifact: InventoryPostedAnchor) => JSON.stringify(JSON.parse(encodeDurableBook(artifact as never)).body);
  const cap = 1024 * 1024, padding = cap - new TextEncoder().encode(payload(candidate(""))).byteLength;
  const text = unicode ? "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2) : "x".repeat(padding);
  const corrupt = candidate(text); // Deliberately leave the old anchor hash.
  expect(new TextEncoder().encode(payload(corrupt)).byteLength).toBe(cap);
  expect(payload(corrupt).length).toBe(unicode ? cap - Math.floor(padding / 2) : cap);
  // At the inclusive payload bound, intrinsic validation runs before framing.
  // An oversized final envelope is not proof that these two guards are equivalent.
  expect(() => encodeInventoryOwnershipArtifact("anchor", corrupt)).toThrow(TypeError);
  expect(() => encodeInventoryOwnershipArtifact("anchor", corrupt)).toThrow("intrinsic structure or content hashes");
});

test("ownership artifact transport round-trips exact classes and immutable mixed effects without enabling old codecs", () => {
  const f = codecEffect();
  const artifacts: Pick<InventoryOwnershipArtifactTypes, "anchor" | "position" | "reductionMovement" | "reductionEffect"> = { anchor: f.entry.anchor, position: f.position, reductionMovement: f.effect.quantityOnlyMovements[0]!, reductionEffect: f.effect };
  for (const kind of Object.keys(artifacts) as (keyof typeof artifacts)[]) {
    const bytes = encodeInventoryOwnershipArtifact(kind, artifacts[kind]);
    const decoded = decodeInventoryOwnershipArtifact(kind, bytes);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    expect(decoded.artifact).toEqual(artifacts[kind]);
    expect(encodeInventoryOwnershipArtifact(kind, decoded.artifact)).toBe(bytes);
    expect(Object.isFrozen(decoded.artifact)).toBeTrue();
    expect(validateInventoryOwnershipArtifact(kind, decoded.artifact)).toBeTrue();
    expect(decodeDurableBook(bytes).disposition).toBe("rejected");
    expect(decodeBookOutcome(bytes).disposition).toBe("rejected");
    expect(decodeBookRow("state.lotHoldings", JSON.stringify(JSON.parse(bytes).body)).disposition).toBe("rejected");
  }
  const money = decodeInventoryOwnershipArtifact("reductionMovement", encodeInventoryOwnershipArtifact("reductionMovement", f.effect.journalLinkedMovements[0]!));
  if (money.disposition !== "decoded") throw new Error(money.message);
  expect(money.artifact.postedAmount instanceof D).toBeTrue();
  expect(money.artifact.quantityAllocation.allocatedQuantity instanceof R).toBeTrue();
  expect(money.artifact.quantityAllocation.allocatedQuantity.equals(r(1n))).toBeTrue();
  expect(money.artifact.afterPosition.consumedPosted.toString()).toBe("0.01");
  const zero = decodeInventoryOwnershipArtifact("reductionMovement", encodeInventoryOwnershipArtifact("reductionMovement", f.effect.quantityOnlyMovements[1]!));
  if (zero.disposition !== "decoded") throw new Error(zero.message);
  expect(Object.hasOwn(zero.artifact, "posting")).toBeFalse();
});

test("anchor transport checks predecessor and incoming reference ordering without claiming source authentication", () => {
  const f = codecEffect();
  const incoming = { id: identifier<"InventoryPostedMovement">("incoming"), contentHash: f.effect.quantityOnlyMovements[0]!.contentHash,
    bookId: IDS.book, effectKey: effectKey("successor"), artifactOrdinal: 1n, bookRevision: 3n };
  const predecessor = { id: f.position.holdingId, contentHash: f.position.contentHash, bookId: IDS.book,
    effectKey: f.position.originEffectKey, artifactOrdinal: f.position.originArtifactOrdinal, bookRevision: f.position.originBookRevision };
  const body = { ...f.entry.anchor, effectKey: effectKey("successor"), artifactOrdinal: 2n, bookRevision: 3n,
    coordinate: { ...f.entry.anchor.coordinate, dimensionMemberIds: [dimensionMemberId("a"), dimensionMemberId("z")] },
    predecessorPosition: predecessor, incomingMovements: [incoming] };
  const anchor = { ...body, contentHash: hashInventoryPostedAnchor(body) };
  const decoded = decodeInventoryOwnershipArtifact("anchor", encodeInventoryOwnershipArtifact("anchor", anchor));
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(decoded.artifact.incomingMovements).toEqual([incoming]);
  expect(decoded.artifact.predecessorPosition).toEqual(predecessor);
  expect(Object.isFrozen(decoded.artifact.incomingMovements[0])).toBeTrue();
  for (const patch of [
    { incomingMovements: [incoming, incoming] },
    { incomingMovements: [{ ...incoming, artifactOrdinal: 2n }] },
    { incomingMovements: [{ ...incoming, bookId: bookId("foreign") }] },
    { predecessorPosition: { ...predecessor, bookRevision: 4n } },
    { evidence: [anchor.evidence[0]!, anchor.evidence[0]!] },
  ]) {
    const changed = { ...anchor, ...patch };
    codecRejected("anchor", { ...changed, contentHash: hashInventoryPostedAnchor(changed) });
  }
});

test("strict ownership schemas reject unknown fields, wrong families and fabricated zero-movement posting references", () => {
  const f = codecEffect(), zero = f.effect.quantityOnlyMovements[0]!, money = f.effect.journalLinkedMovements[0]!;
  for (const value of [{ ...zero, posting: money.posting }, { ...zero, monetaryKind: "unknown" }, { ...zero, kind: "acquisition" },
    { ...zero, afterPosition: { ...zero.afterPosition, originMovementHash: zero.contentHash } },
    { ...zero, accountingDate: "2026-02-30" }, { ...zero, extra: true }]) codecRejected("reductionMovement", value);
  codecRejected("anchor", { ...f.entry.anchor, coordinate: { ...f.entry.anchor.coordinate, extra: true } });
  codecRejected("anchor", { ...f.entry.anchor, inventoryPolicy: { ...f.entry.anchor.inventoryPolicy, policyContentHash: { ...f.entry.anchor.inventoryPolicy.policyContentHash, algorithm: "sha512" } } });
  codecRejected("position", { ...f.position, originBookRevision: "2" });
  const { originEffectKey: _originEffectKey, ...missing } = f.position;
  codecRejected("position", missing);
  const bytes = encodeInventoryOwnershipArtifact("anchor", f.entry.anchor);
  expect(decodeInventoryOwnershipArtifact("position", bytes).disposition).toBe("rejected");
  for (const patch of [{ version: "future-version" }, { extra: 1 }, { checksum: hashCanonical({ wrong: true }) }]) {
    expect(decodeInventoryOwnershipArtifact("anchor", JSON.stringify({ ...JSON.parse(bytes), ...patch })).disposition).toBe("rejected");
  }
  expect(() => encodeInventoryOwnershipArtifact("unknown" as never, f.entry.anchor as never)).toThrow("Unknown inventory ownership artifact kind");
  expect(decodeInventoryOwnershipArtifact("__proto__" as never, bytes).disposition).toBe("rejected");
  expect(validateInventoryOwnershipArtifact("unknown" as never, f.entry.anchor as never)).toBeFalse();
});

test("rehashed ownership packets must satisfy local signs, references and cumulative arithmetic", () => {
  const f = codecEffect(), zero = f.effect.quantityOnlyMovements[0]!, money = f.effect.journalLinkedMovements[0]!;
  for (const patch of [{ quantity: r(0n) }, { artifactOrdinal: 0n }, { postedBudget: D.parse("-0.01") }, { postedBudget: D.parse("0.001") },
    { sourcePostings: [], incomingMovements: [], evidence: [] }, { sourcePostings: [f.entry.anchor.sourcePostings[0]!, f.entry.anchor.sourcePostings[0]!] },
    { coordinate: { ...f.entry.anchor.coordinate, dimensionMemberIds: [dimensionMemberId("z"), dimensionMemberId("a")] } }]) {
    const value = { ...f.entry.anchor, ...patch };
    codecRejected("anchor", { ...value, contentHash: hashInventoryPostedAnchor(value) });
  }
  for (const patch of [{ consumedQuantity: r(-1n) }, { consumedPosted: D.parse("-0.01") }, { originArtifactOrdinal: 0n }, { anchor: { ...f.position.anchor, bookRevision: f.position.originBookRevision + 1n } }]) {
    const value = { ...f.position, ...patch };
    codecRejected("position", { ...value, contentHash: hashInventoryPostedPosition(value) });
  }
  for (const patch of [{ postedAmount: D.parse("0.01") }, { afterPosition: { ...zero.afterPosition, originMovementId: identifier<"InventoryPostedMovement">("other") } },
    { quantityAllocation: { ...zero.quantityAllocation, allocatedCarryingAmount: r(1n) } },
    { reductionProof: { ...zero.reductionProof, afterTarget: r(1n) } },
    { reductionProof: { ...zero.reductionProof, postedTotal: D.parse("0.001") } },
    { afterPosition: { ...zero.afterPosition, consumedQuantity: r(2n) } },
    { afterPosition: { ...zero.afterPosition, consumedPosted: D.parse("0.01") } },
    { incomingSources: [{ id: identifier<"InventoryPostedMovement">("unexpected"), contentHash: zero.contentHash, bookId: IDS.book, effectKey: effectKey("before"), artifactOrdinal: 1n, bookRevision: 1n }] }]) {
    codecRejected("reductionMovement", sealedMovement({ ...zero, ...patch }));
  }
  codecRejected("reductionMovement", sealedMovement({ ...money, postedAmount: D.parse("0.01") }));
  codecRejected("reductionMovement", sealedMovement({ ...money, posting: { ...money.posting, contentHash: hashCanonical({ bad: true }) } }));
  codecRejected("position", { ...f.position, contentHash: hashCanonical({ wrong: true }) });
  // Standalone positions cannot prove the referenced anchor's quantity/budget.
  // This packet is structurally coherent, but fails when the real anchor is used.
  const detached = { ...f.entry.position, consumedPosted: D.parse("100.00") };
  const detachedPosition = { ...detached, contentHash: hashInventoryPostedPosition(detached) };
  expect(decodeInventoryOwnershipArtifact("position", encodeInventoryOwnershipArtifact("position", detachedPosition)).disposition).toBe("decoded");
  expect(prepareInventoryPostedReduction(f.entry.anchor, detachedPosition, f.entry.holding, f.entry.allocation, { ...groupContext, movementId: identifier<"InventoryPostedMovement">("detached"), artifactOrdinal: 1n }).disposition).toBe("rejected");
});

test("ownership effect decoding verifies internal after-image links and ordinal populations after all hashes are recomputed", () => {
  const f = codecEffect();
  for (const patch of [{ newAnchors: [f.entry.anchor] }, { journalLinkedMovements: [], quantityOnlyMovements: [] },
    { quantityOnlyMovements: [...f.effect.quantityOnlyMovements].reverse() }, { bookRevision: 3n },
    { quantityOnlyMovements: [f.effect.quantityOnlyMovements[0]!, f.effect.quantityOnlyMovements[0]!] }]) {
    const value = { ...f.effect, ...patch } as InventoryReductionOwnershipEffect;
    codecRejected("reductionEffect", { ...value, contentHash: hashInventoryReductionOwnershipEffect(value) });
  }
  const money = f.effect.journalLinkedMovements[0]!;
  const changed = sealedMovement({ ...money, beforePosition: { ...money.beforePosition, contentHash: hashCanonical({ forgedPrior: true }) } });
  const body = { ...f.effect, journalLinkedMovements: [changed as typeof money] };
  codecRejected("reductionEffect", { ...body, contentHash: hashInventoryReductionOwnershipEffect(body) });
  // Relabeling an external predecessor can produce a locally coherent packet.
  // Only authenticated source lookup/replay can detect the false locator.
  const omitted = sealedMovement({ ...money, artifactOrdinal: 1n, afterPosition: { ...money.afterPosition, originArtifactOrdinal: 1n }, beforePosition: { ...money.beforePosition, effectKey: effectKey("other-operation"), bookRevision: 1n } });
  const partial = { ...f.effect, journalLinkedMovements: [omitted as typeof money], quantityOnlyMovements: [] };
  // Hash/frame inspection still cannot prove complete operation membership from
  // a packet alone. The command replay gate remains necessary beyond this codec.
  const packet = ownershipPacket("reductionEffect", { ...partial, contentHash: hashInventoryReductionOwnershipEffect(partial) });
  const decoded = decodeInventoryOwnershipArtifact("reductionEffect", packet);
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(decoded.artifact.contentHash).not.toEqual(f.effect.contentHash);
  expect(decoded.artifact.journalLinkedMovements[0]!.beforePosition).not.toEqual(money.beforePosition);
});

test("ownership bytes reject aliases, duplicate fields, excess nesting, malformed exact tags and size overflow", () => {
  const f = codecEffect(), bytes = encodeInventoryOwnershipArtifact("position", f.entry.position);
  const envelope = JSON.parse(bytes);
  const field = (body: any, name: string): any => body[1].find((entry: any) => entry[0] === name)[1];
  for (const token of [["d", "+0", "2"], ["d", "00", "2"], ["r", "0", "2"]]) {
    const body = JSON.parse(JSON.stringify(envelope.body));
    const target = field(body, token[0] === "r" ? "consumedQuantity" : "consumedPosted");
    target.splice(0, target.length, ...token);
    expect(decodeInventoryOwnershipArtifact("position", ownershipFrame("position", body)).disposition).toBe("rejected");
  }
  for (const wire of [` ${bytes}`, `${bytes}\n`, bytes.replace('{"version":', `{"version":"${INVENTORY_OWNERSHIP_CODEC_VERSION}","version":`)]) {
    expect(decodeInventoryOwnershipArtifact("position", wire).disposition).toBe("rejected");
  }
  const duplicate = JSON.parse(JSON.stringify(envelope.body));
  duplicate[1].push(duplicate[1][0]);
  expect(decodeInventoryOwnershipArtifact("position", ownershipFrame("position", duplicate)).disposition).toBe("rejected");
  for (const malformed of [["i", 1], ["r", "x", "1"], ["a", new Array(10_001).fill(["n"])], ["unknown"]]) {
    expect(decodeInventoryOwnershipArtifact("position", ownershipFrame("position", malformed)).disposition).toBe("rejected");
  }
  let deep: unknown = ["n"];
  for (let i = 0; i < 140; i++) deep = ["a", [deep]];
  expect(decodeInventoryOwnershipArtifact("position", ownershipFrame("position", deep)).disposition).toBe("rejected");
  for (const tooBig of [" ".repeat(1024 * 1024 + 1), "é".repeat(600_000)]) expect(decodeInventoryOwnershipArtifact("position", tooBig).disposition).toBe("rejected");
  expect(decodeInventoryOwnershipArtifact("position", null as never).disposition).toBe("rejected");
  const badKind = { [Symbol.toPrimitive]() { throw "non-error-kind"; } };
  expect(decodeInventoryOwnershipArtifact(badKind as never, bytes)).toEqual({ disposition: "rejected", message: "Unknown inventory ownership decode failure" });
  const huge = { ...f.entry.anchor, evidence: [{ ...accountingDerivation.evidence[0]!, sourceRecordId: "x".repeat(1024 * 1024) }] };
  expect(() => encodeInventoryOwnershipArtifact("anchor", huge)).toThrow("exceeds the byte limit");
  const baseAnchor = (pad: string) => {
    const unhashed = {
      ...f.entry.anchor,
      evidence: [{ ...f.entry.anchor.evidence[0]!, sourceRecordId: `s${pad}` }],
    };
    return { ...unhashed, contentHash: hashInventoryPostedAnchor(unhashed) };
  };
  const baseEncoded = encodeInventoryOwnershipArtifact("anchor", baseAnchor(""));
  const overhead = new TextEncoder().encode(baseEncoded).byteLength;
  const boundaryAnchor = baseAnchor("x".repeat(1_048_576 - overhead));
  const boundaryEncoded = encodeInventoryOwnershipArtifact("anchor", boundaryAnchor);
  expect(new TextEncoder().encode(boundaryEncoded).byteLength).toBe(1_048_576);
  expect(decodeInventoryOwnershipArtifact("anchor", boundaryEncoded).disposition).toBe("decoded");
});

test("multi-source transfers conserve each posted budget across canonical ordering and dimensions", () => {
  const dimensions = [dimensionMemberId("department")];
  const entries: InventoryPostedTransferEntry[] = ["8.00", "0.02"].map((amount, index) => {
    const f = groupEntry(amount, index);
    const anchorBody = { ...f.anchor, coordinate: { ...f.anchor.coordinate, dimensionMemberIds: dimensions } };
    const anchor = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
    const positionBody = { ...f.position, anchor: { ...f.position.anchor, contentHash: anchor.contentHash } };
    const position = { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) };
    const destinationLot: Lot = {
      id: lotId(`multi-dest-lot-${index}`), bookId: IDS.book, commodityId: inventoryUnits,
      basisCommodityId: IDS.usd, acquiredAt: instant("2026-01-15T12:00:00Z"),
      acquisitionQuantity: f.allocation.allocatedQuantity, acquisitionTotalBasis: f.allocation.allocatedTotalBasis,
      evidenceIds: accountingDerivation.evidence.map((e) => e.id),
    };
    return {
      source: { anchor, position, holding: f.holding }, allocation: f.allocation,
      transferOutMovementId: identifier<"InventoryPostedMovement">(`multi-out-${index}`),
      destinationAnchorId: identifier<"InventoryPostedAnchor">(`multi-anchor-${index}`),
      destinationMovementId: identifier<"InventoryPostedMovement">(`multi-in-${index}`),
      destinationLot,
      destinationHolding: { ...f.holding, id: lotHoldingId(`multi-dest-holding-${index}`), lotId: destinationLot.id,
        accountId: IDS.revenue, remainingQuantity: f.allocation.allocatedQuantity,
        remainingTotalBasis: f.allocation.allocatedTotalBasis, remainingValuationAllowance: R.zero(),
        remainingCarryingAmount: f.allocation.allocatedTotalBasis },
      evidence: accountingDerivation.evidence,
    };
  });
  const context: InventoryPostedTransferGroupContext = {
    ...groupContext, effectKey: effectKey("multi-transfer:ownership:0"),
    destinationInventoryPolicy: entries[0]!.source.anchor.inventoryPolicy,
    destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: dimensions,
  };
  const links = actualTransferJournal("2.68", r(2n), r(401n, 150n), ["department"], ["department"]);
  const prepared = prepareInventoryPostedTransferGroup(context, entries, links.sourceLink, links.destLink);
  expect(prepared.disposition).toBe("prepared");
  if (prepared.disposition !== "prepared") throw new Error(JSON.stringify(prepared.diagnostics));
  expect(prepared.group.destinationAnchors.map((a) => a.postedBudget.toString())).toEqual(["2.67", "0.01"]);
  expect(prepared.group.transferredPostedAmount.toString()).toBe("2.68");
  expect(prepared.group.transferredQuantity.equals(r(2n))).toBeTrue();
  expect(prepareInventoryPostedTransferGroup(context, [...entries].reverse(), links.sourceLink, links.destLink)).toEqual(prepared);
  for (const movement of prepared.group.destinationMovements)
    expect(decodeInventoryOwnershipArtifact("acquisitionMovement", encodeInventoryOwnershipArtifact("acquisitionMovement", movement)).disposition).toBe("decoded");
  const empty = prepareInventoryPostedTransferGroup(context, []);
  expect(empty.disposition).toBe("rejected");
  if (empty.disposition === "rejected") expect(empty.diagnostics[0]?.path).toBe("inventoryOwnership.group");
});

test("ACC-039.7: prepareInventoryPostedTransferGroup derives destination anchor directly from source reduction proof without rerounding", () => {
  const f = groupEntry("8.00", 0);
  const destAccount = IDS.revenue;
  const destLotId = lotId("dest-lot");
  const destLot: Lot = {
    id: destLotId,
    bookId: IDS.book,
    commodityId: inventoryUnits,
    basisCommodityId: IDS.usd,
    acquiredAt: instant("2026-01-15T12:00:00Z"),
    acquisitionQuantity: f.allocation.allocatedQuantity,
    acquisitionTotalBasis: f.allocation.allocatedTotalBasis,
    evidenceIds: [accountingDerivation.evidence[0]!.id],
  };
  const destHolding: LotHolding = {
    id: lotHoldingId("dest-holding"),
    lotId: destLotId,
    bookId: IDS.book,
    accountId: destAccount,
    commodityId: inventoryUnits,
    basisCommodityId: IDS.usd,
    remainingQuantity: f.allocation.allocatedQuantity,
    remainingTotalBasis: f.allocation.allocatedTotalBasis,
    remainingValuationAllowance: R.zero(),
    remainingCarryingAmount: f.allocation.allocatedTotalBasis,
  };

  const context: InventoryPostedTransferGroupContext = {
    bookId: IDS.book,
    commandId: groupContext.commandId,
    effectKey: effectKey("transfer:ownership:0"),
    bookRevision: 2n,
    firstArtifactOrdinal: 10n,
    accountingDate: localDate("2026-01-15"),
    fiscalPeriodId: IDS.period1,
    destinationInventoryPolicy: {
      policyId: accountingDerivation.policyId,
      policyVersion: accountingDerivation.policyVersion,
      policyContentHash: hashCanonical({ policy: "dest-inventory" }),
    },
    destinationQuantizationPolicy: quantizationPolicy,
    destinationDimensionMemberIds: [],
  };

  const entry: InventoryPostedTransferEntry = {
    source: { anchor: f.anchor, position: f.position, holding: f.holding },
    allocation: f.allocation,
    transferOutMovementId: identifier<"InventoryPostedMovement">("xfer-out-mov"),
    destinationAnchorId: identifier<"InventoryPostedAnchor">("dest-anchor"),
    destinationMovementId: identifier<"InventoryPostedMovement">("dest-in-mov"),
    destinationHolding: destHolding,
    destinationLot: destLot,
    evidence: accountingDerivation.evidence,
  };

  // 1. Rejection: Money-bearing transfer without journal links fails closed
  const missingRes = prepareInventoryPostedTransferGroup(context, [entry]);
  expect(missingRes.disposition).toBe("rejected");
  if (missingRes.disposition === "rejected") {
    expect(missingRes.diagnostics[0]?.path).toBe("inventoryOwnership.posting");
  }

  // 2. Valid money-bearing transfer with journal links
  // f has posted 8.00 for quantity 3, allocating 1 gives posted share 2.67 and basis 8/3
  const links = actualTransferJournal("2.67", r(1n), r(8n, 3n));
  const res = prepareInventoryPostedTransferGroup(context, [entry], links.sourceLink, links.destLink);
  expect(res.disposition).toBe("prepared");
  if (res.disposition !== "prepared") throw new Error("Expected transfer group to prepare");

  const group = res.group;
  expect(group.transferOutMovements).toHaveLength(1);
  expect(group.destinationAnchors).toHaveLength(1);
  expect(group.destinationMovements).toHaveLength(1);

  // Ordinals strictly ordered: transferOut (10n), destination anchor (11n), destination movement (12n)
  expect(group.transferOutMovements[0]!.artifactOrdinal).toBe(10n);
  expect(group.destinationAnchors[0]!.artifactOrdinal).toBe(11n);
  expect(group.destinationMovements[0]!.artifactOrdinal).toBe(12n);

  // Destination anchor takes budget directly from source reduction proof without rerounding
  const transferOut = group.transferOutMovements[0]!;
  const destAnchor = group.destinationAnchors[0]!;
  const destMovement = group.destinationMovements[0]!;

  expect(destAnchor.postedBudget).toEqual(transferOut.reductionProof.postedAmount);
  expect(destAnchor.incomingMovements).toHaveLength(1);
  expect(destAnchor.incomingMovements[0]!.id).toBe(transferOut.id);
  expect(destAnchor.predecessorPosition?.id).toBe(f.position.holdingId);

  expect(destMovement.kind).toBe("transferIn");
  expect(destMovement.incomingSources).toHaveLength(1);
  expect(destMovement.incomingSources[0]!.id).toBe(transferOut.id);

  // Artifact validation
  expect(validateInventoryOwnershipArtifact("anchor", destAnchor)).toBeTrue();
  expect(validateInventoryOwnershipArtifact("position", destMovement.afterPosition)).toBeTrue();
  expect(validateInventoryOwnershipArtifact("reductionMovement", transferOut)).toBeTrue();
  expect(validateInventoryOwnershipArtifact("acquisitionMovement", destMovement)).toBeTrue();

  // Rejection: Mismatched destination basis violates exact conservation
  const badDestHolding = { ...destHolding, remainingTotalBasis: r(99n) };
  const badEntry = { ...entry, destinationHolding: badDestHolding };
  const badRes = prepareInventoryPostedTransferGroup(context, [badEntry], links.sourceLink, links.destLink);
  expect(badRes.disposition).toBe("rejected");
  if (badRes.disposition === "rejected") {
    expect(badRes.diagnostics[0]?.path).toBe("inventoryOwnership.transferDestination");
  }
});

test("ACC-039.8: zero-money transfer and adoption emit quantity-only movements without dummy postings", () => {
  // Setup free/zero-money stock
  const f = example("0.00", r(2n), r(0n), r(0n));
  const destLotId = lotId("free-dest-lot");
  const destLot: Lot = {
    id: destLotId, bookId: IDS.book, commodityId: IDS.usd, basisCommodityId: IDS.usd,
    acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: f.allocation.allocatedQuantity,
    acquisitionTotalBasis: R.zero(), evidenceIds: [accountingDerivation.evidence[0]!.id],
  };
  const destHolding: LotHolding = {
    id: lotHoldingId("free-dest-holding"), lotId: destLotId, bookId: IDS.book, accountId: accountId("free-warehouse"),
    commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: f.allocation.allocatedQuantity,
    remainingTotalBasis: R.zero(), remainingValuationAllowance: R.zero(), remainingCarryingAmount: R.zero(),
  };
  const context: InventoryPostedTransferGroupContext = {
    bookId: IDS.book, commandId: commandId("free-transfer"), effectKey: effectKey("free-transfer:ownership:0"),
    bookRevision: 2n, firstArtifactOrdinal: 1n, accountingDate: localDate("2026-01-15"), fiscalPeriodId: IDS.period1,
    destinationInventoryPolicy: { policyId: accountingDerivation.policyId, policyVersion: accountingDerivation.policyVersion, policyContentHash: hashCanonical({ policy: "free" }) },
    destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: [],
  };
  const entry: InventoryPostedTransferEntry = {
    source: { anchor: f.anchor, position: f.position, holding: f.holding },
    allocation: { ...f.allocation, allocatedTotalBasis: R.zero(), allocatedCarryingAmount: R.zero(), allocatedValuationAllowance: R.zero() },
    transferOutMovementId: identifier<"InventoryPostedMovement">("free-out"),
    destinationAnchorId: identifier<"InventoryPostedAnchor">("free-dest-anchor"),
    destinationMovementId: identifier<"InventoryPostedMovement">("free-dest-mov"),
    destinationHolding: destHolding, destinationLot: destLot, evidence: accountingDerivation.evidence,
  };

  const res = prepareInventoryPostedTransferGroup(context, [entry]);
  expect(res.disposition).toBe("prepared");
  if (res.disposition !== "prepared") throw new Error("Expected zero transfer to prepare");

  // Verify both movements are quantityOnly without posting
  const outMov = res.group.transferOutMovements[0]!;
  const inMov = res.group.destinationMovements[0]!;
  expect(outMov.monetaryKind).toBe("quantityOnly");
  expect("posting" in outMov).toBeFalse();
  expect(outMov.postedAmount.isZero()).toBeTrue();

  expect(inMov.monetaryKind).toBe("quantityOnly");
  expect("posting" in inMov).toBeFalse();
  expect(inMov.postedAmount.isZero()).toBeTrue();
});

test("prospective adoption arithmetic matches supplied carrying balances without proving canonical adoption authority", () => {
  const holding: LotHolding = {
    id: lotHoldingId("legacy-holding-1"),
    lotId: lotId("legacy-lot-1"),
    bookId: IDS.book,
    accountId: IDS.cash,
    commodityId: IDS.usd,
    basisCommodityId: IDS.usd,
    remainingQuantity: r(10n),
    remainingTotalBasis: r(100n),
    remainingValuationAllowance: R.zero(),
    remainingCarryingAmount: r(100n),
  };

  const context: InventoryPostedAdoptionContext = {
    bookId: IDS.book,
    commandId: commandId("adopt-command"),
    effectKey: effectKey("adopt:ownership:0"),
    bookRevision: 2n,
    firstArtifactOrdinal: 1n,
    accountingDate: localDate("2026-01-15"),
    fiscalPeriodId: IDS.period1,
    inventoryPolicy: {
      policyId: accountingDerivation.policyId,
      policyVersion: accountingDerivation.policyVersion,
      policyContentHash: hashCanonical({ policy: "adopt" }),
    },
    quantizationPolicy,
    dimensionMemberIds: [],
  };

  const entry: InventoryPostedAdoptionEntry = {
    anchorId: identifier<"InventoryPostedAnchor">("adopt-anchor-1"),
    movementId: identifier<"InventoryPostedMovement">("adopt-mov-1"),
    holding,
    evidence: accountingDerivation.evidence,
    historicalPostings: [],
  };

  const empty = prepareInventoryPostedAdoptionGroup(context, [], r(0n));
  expect(empty.disposition).toBe("rejected");
  if (empty.disposition === "rejected") expect(empty.diagnostics[0]?.path).toBe("inventoryOwnership.adoption");
  const another = { ...entry, anchorId: identifier<"InventoryPostedAnchor">("adopt-anchor-2"),
    movementId: identifier<"InventoryPostedMovement">("adopt-mov-2"),
    holding: { ...holding, id: lotHoldingId("legacy-holding-2"), lotId: lotId("legacy-lot-2") } };
  const pair = prepareInventoryPostedAdoptionGroup({ ...context, dimensionMemberIds: [dimensionMemberId("department")] }, [another, entry], r(200n));
  expect(pair.disposition).toBe("prepared");
  if (pair.disposition !== "prepared") throw new Error(JSON.stringify(pair.diagnostics));
  expect(pair.group.anchors.map((a) => a.coordinate.holdingId)).toEqual([holding.id, another.holding.id]);
  expect(pair.group.anchors.map((a) => a.postedBudget.toString())).toEqual(["100.00", "100.00"]);
  expect(pair.group.adoptedQuantity.equals(r(20n))).toBeTrue();

  // 1. Success: postedBalance matches remainingCarryingAmount exactly (100)
  const prepared = prepareInventoryPostedAdoptionGroup(context, [entry], r(100n));
  expect(prepared.disposition).toBe("prepared");
  if (prepared.disposition !== "prepared") throw new Error("Expected adoption to prepare");

  expect(prepared.group.anchors).toHaveLength(1);
  expect(prepared.group.movements).toHaveLength(1);
  expect(prepared.group.positions).toHaveLength(1);

  const anchor = prepared.group.anchors[0]!;
  const movement = prepared.group.movements[0]!;
  const position = prepared.group.positions[0]!;

  // Anchor preserves historical posted budget
  expect(anchor.postedBudget.toString()).toBe("100.00");
  expect(anchor.incomingMovements).toHaveLength(0);

  // Movement is quantityOnly: postedAmount is 0, no journal posting
  expect(movement.kind).toBe("legacyAdoption");
  expect(movement.monetaryKind).toBe("quantityOnly");
  expect("posting" in movement).toBeFalse();
  expect(movement.postedAmount.isZero()).toBeTrue();
  expect(movement.incomingSources).toHaveLength(0);

  // Position starts fresh with 0 consumed
  expect(position.consumedQuantity.isZero()).toBeTrue();
  expect(position.consumedPosted.isZero()).toBeTrue();

  expect(validateInventoryOwnershipArtifact("anchor", anchor)).toBeTrue();
  expect(validateInventoryOwnershipArtifact("position", position)).toBeTrue();
  expect(validateInventoryOwnershipArtifact("acquisitionMovement", movement)).toBeTrue();

  // 2. Rejection: posted balance does not match carrying amount
  const mismatched = prepareInventoryPostedAdoptionGroup(context, [entry], r(95n));
  expect(mismatched.disposition).toBe("rejected");
  if (mismatched.disposition === "rejected") {
    expect(mismatched.diagnostics[0]?.path).toBe("inventoryOwnership.adoptionBalance");
  }

  // A posted balance is already authoritative money, not a proposal to round.
  for (const postedBalance of [r(99999n, 1000n), r(100001n, 1000n)]) {
    const roundedMismatch = prepareInventoryPostedAdoptionGroup(context, [entry], postedBalance);
    expect(roundedMismatch.disposition).toBe("rejected");
    if (roundedMismatch.disposition !== "rejected") throw new Error("Adoption silently rounded a historical balance");
    expect(roundedMismatch.diagnostics[0]?.path).toBe("inventoryOwnership.adoptionBalance");
  }

  // Arithmetic equality alone does not make an invalid valuation allowance valid.
  for (const invalidHolding of [
    { ...holding, remainingValuationAllowance: r(10n), remainingCarryingAmount: r(110n) },
    { ...holding, remainingValuationAllowance: r(-110n), remainingCarryingAmount: r(-10n) },
  ]) {
    const invalid = prepareInventoryPostedAdoptionGroup(context, [{ ...entry, holding: invalidHolding }], invalidHolding.remainingCarryingAmount);
    expect(invalid.disposition).toBe("rejected");
    if (invalid.disposition !== "rejected") throw new Error("Adoption accepted invalid holding economics");
    expect(invalid.diagnostics[0]?.path).toBe("inventoryOwnership.adoptionSource");
  }

  // 3. Rejection: negative carrying amount fails closed
  const negativeHolding = { ...holding, remainingCarryingAmount: r(-10n) };
  const negEntry = { ...entry, holding: negativeHolding };
  const negRes = prepareInventoryPostedAdoptionGroup(context, [negEntry], r(-10n));
  expect(negRes.disposition).toBe("rejected");
  if (negRes.disposition === "rejected") {
    expect(negRes.diagnostics[0]?.path).toBe("inventoryOwnership.adoptionSource");
  }
});

test("prepareInventoryPostedTransferGroup rejects duplicate identities, mismatched coordinate and invalid journals", () => {
  const f = groupEntry("8.00", 0);
  const destAccount = IDS.revenue;
  const destLot: Lot = {
    id: lotId("dest-lot-edge"), bookId: IDS.book, commodityId: inventoryUnits, basisCommodityId: IDS.usd,
    acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: f.allocation.allocatedQuantity,
    acquisitionTotalBasis: f.allocation.allocatedTotalBasis, evidenceIds: [accountingDerivation.evidence[0]!.id],
  };
  const destHolding: LotHolding = {
    id: lotHoldingId("dest-holding-edge"), lotId: destLot.id, bookId: IDS.book, accountId: destAccount,
    commodityId: inventoryUnits, basisCommodityId: IDS.usd, remainingQuantity: f.allocation.allocatedQuantity,
    remainingTotalBasis: f.allocation.allocatedTotalBasis, remainingValuationAllowance: R.zero(),
    remainingCarryingAmount: f.allocation.allocatedTotalBasis,
  };
  const context: InventoryPostedTransferGroupContext = {
    bookId: IDS.book, commandId: groupContext.commandId, effectKey: effectKey("transfer:edge:0"),
    bookRevision: 2n, firstArtifactOrdinal: 10n, accountingDate: localDate("2026-01-15"), fiscalPeriodId: IDS.period1,
    destinationInventoryPolicy: { policyId: accountingDerivation.policyId, policyVersion: accountingDerivation.policyVersion, policyContentHash: hashCanonical({ policy: "dest-inventory" }) },
    destinationQuantizationPolicy: quantizationPolicy, destinationDimensionMemberIds: [],
  };
  const entry: InventoryPostedTransferEntry = {
    source: { anchor: f.anchor, position: f.position, holding: f.holding },
    allocation: f.allocation, transferOutMovementId: identifier<"InventoryPostedMovement">("xfer-out-mov-edge"),
    destinationAnchorId: identifier<"InventoryPostedAnchor">("dest-anchor-edge"),
    destinationMovementId: identifier<"InventoryPostedMovement">("dest-in-mov-edge"),
    destinationHolding: destHolding, destinationLot: destLot, evidence: accountingDerivation.evidence,
  };
  const links = actualTransferJournal("2.67", r(1n), r(8n, 3n));

  // Line 585: Duplicate destination anchor ID in entries
  const dupEntries = [entry, { ...entry, transferOutMovementId: identifier<"InventoryPostedMovement">("xfer-out-2"), destinationMovementId: identifier<"InventoryPostedMovement">("dest-in-2") }];
  const dupRes = prepareInventoryPostedTransferGroup(context, dupEntries, links.sourceLink, links.destLink);
  expect(dupRes.disposition).toBe("rejected");
  if (dupRes.disposition === "rejected") expect(dupRes.diagnostics[0]?.path).toBe("inventoryOwnership.groupIdentity");

  // Line 596: Mismatched source coordinate
  const diffBookAnchor = { ...f.anchor, coordinate: { ...f.anchor.coordinate, bookId: bookId("other-book") } };
  const diffCoordEntry: InventoryPostedTransferEntry = {
    ...entry,
    source: {
      ...entry.source,
      anchor: { ...diffBookAnchor, contentHash: hashInventoryPostedAnchor(diffBookAnchor) },
    },
  };
  const diffCoordRes = prepareInventoryPostedTransferGroup(context, [diffCoordEntry], links.sourceLink, links.destLink);
  expect(diffCoordRes.disposition).toBe("rejected");
  if (diffCoordRes.disposition === "rejected") expect(diffCoordRes.diagnostics[0]?.path).toBe("inventoryOwnership.groupCoordinate");

  // Line 632: Bad source journal (wrong bookRevision)
  const badSourceLink = { ...links.sourceLink, source: { ...links.sourceLink.source, bookRevision: 99n } };
  const badSrcRes = prepareInventoryPostedTransferGroup(context, [entry], badSourceLink, links.destLink);
  expect(badSrcRes.disposition).toBe("rejected");
  if (badSrcRes.disposition === "rejected") expect(badSrcRes.diagnostics[0]?.path).toBe("inventoryOwnership.journalSource");

  // Line 642: Source posting attribution mismatch (wrong bookValue amount)
  const wrongSourceLink = actualTransferJournal("1.00", r(1n), r(8n, 3n)).sourceLink;
  const wrongAttrRes = prepareInventoryPostedTransferGroup(context, [entry], wrongSourceLink, links.destLink);
  expect(wrongAttrRes.disposition).toBe("rejected");
  if (wrongAttrRes.disposition === "rejected") expect(wrongAttrRes.diagnostics[0]?.path).toBe("inventoryOwnership.postingAttribution");

  // Line 656: Bad destination journal (wrong bookRevision)
  const badDestLink = { ...links.destLink, source: { ...links.destLink.source, bookRevision: 99n } };
  const badDstRes = prepareInventoryPostedTransferGroup(context, [entry], links.sourceLink, badDestLink);
  expect(badDstRes.disposition).toBe("rejected");
  if (badDstRes.disposition === "rejected") expect(badDstRes.diagnostics[0]?.path).toBe("inventoryOwnership.journalSource");

  // Line 666: Destination posting attribution mismatch (wrong amount)
  const badDestAttrLink = { ...links.destLink, postingId: links.sourceLink.postingId };
  const badDstAttrRes = prepareInventoryPostedTransferGroup(context, [entry], links.sourceLink, badDestAttrLink);
  expect(badDstAttrRes.disposition).toBe("rejected");
  if (badDstAttrRes.disposition === "rejected") expect(badDstAttrRes.diagnostics[0]?.path).toBe("inventoryOwnership.postingAttribution");
});

test("prepareInventoryPostedAdoptionGroup rejects duplicate identities and invalid context", () => {
  const holding: LotHolding = {
    id: lotHoldingId("adopt-edge-holding"), lotId: lotId("adopt-edge-lot"), bookId: IDS.book, accountId: IDS.cash,
    commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: r(10n), remainingTotalBasis: r(100n),
    remainingValuationAllowance: R.zero(), remainingCarryingAmount: r(100n),
  };
  const context: InventoryPostedAdoptionContext = {
    bookId: IDS.book, commandId: commandId("adopt-edge-cmd"), effectKey: effectKey("adopt:edge:0"),
    bookRevision: 2n, firstArtifactOrdinal: 1n, accountingDate: localDate("2026-01-15"), fiscalPeriodId: IDS.period1,
    inventoryPolicy: { policyId: accountingDerivation.policyId, policyVersion: accountingDerivation.policyVersion, policyContentHash: hashCanonical({ policy: "adopt" }) },
    quantizationPolicy, dimensionMemberIds: [],
  };
  const entry: InventoryPostedAdoptionEntry = {
    anchorId: identifier<"InventoryPostedAnchor">("adopt-anchor-edge"),
    movementId: identifier<"InventoryPostedMovement">("adopt-mov-edge"),
    holding, evidence: accountingDerivation.evidence, historicalPostings: [],
  };

  // Line 790: duplicate anchorId in entries
  const dupEntries = [entry, { ...entry, holding: { ...holding, id: lotHoldingId("adopt-holding-2") } }];
  const res = prepareInventoryPostedAdoptionGroup(context, dupEntries, r(200n));
  expect(res.disposition).toBe("rejected");
  if (res.disposition === "rejected") expect(res.diagnostics[0]?.path).toBe("inventoryOwnership.adoptionIdentity");
});

test("prepareInventoryOwnershipEffect and prepareInventoryOwnershipEffectFromReadContext support transfer and adopt operations with full artifact validation", () => {
  // Set up an unowned holding to adopt
  const adoptHolding: LotHolding = {
    id: lotHoldingId("effect-adopt-holding"), lotId: lotId("effect-adopt-lot"), bookId: IDS.book, accountId: IDS.cash,
    commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: r(5n), remainingTotalBasis: r(50n),
    remainingValuationAllowance: R.zero(), remainingCarryingAmount: r(50n),
  };
  const adoptEntry: InventoryPostedAdoptionEntry = {
    anchorId: identifier<"InventoryPostedAnchor">("effect-adopt-anchor"),
    movementId: identifier<"InventoryPostedMovement">("effect-adopt-mov"),
    holding: adoptHolding, evidence: accountingDerivation.evidence, historicalPostings: [],
  };
  const adoptOp: Extract<InventoryOwnershipOperation, { kind: "adopt" }> = {
    kind: "adopt", entries: [adoptEntry], inventoryPolicy: acquisitionContext().inventoryPolicy,
    quantizationPolicy, dimensionMemberIds: [], postedBalance: r(50n),
  };

  // Set up an acquisition of zero-money stock to transfer
  const acqEntry = acquisitionEntry(0, R.zero(), R.zero());
  const acquireOp: Extract<InventoryOwnershipOperation, { kind: "acquisition" }> = {
    kind: "acquisition", entries: [acqEntry], inventoryPolicy: acquisitionContext().inventoryPolicy,
    quantizationPolicy, dimensionMemberIds: [],
  };

  // Set up a zero-money transfer operation sourcing from that acquisition
  const destLot: Lot = {
    id: lotId("effect-xfer-dest-lot"), bookId: IDS.book, commodityId: inventoryUnits, basisCommodityId: IDS.usd,
    acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: r(1n), acquisitionTotalBasis: R.zero(),
    evidenceIds: [accountingDerivation.evidence[0]!.id],
  };
  const destHolding: LotHolding = {
    id: lotHoldingId("effect-xfer-dest-holding"), lotId: destLot.id, bookId: IDS.book, accountId: accountId("dest-wh"),
    commodityId: inventoryUnits, basisCommodityId: IDS.usd, remainingQuantity: r(1n), remainingTotalBasis: R.zero(),
    remainingValuationAllowance: R.zero(), remainingCarryingAmount: R.zero(),
  };
  const xferAllocation: LotAllocation = {
    id: lotAllocationId("effect-xfer-alloc"), holdingId: acqEntry.holding.id, lotId: acqEntry.lot.id,
    allocatedQuantity: r(1n), allocatedTotalBasis: R.zero(), allocatedValuationAllowance: R.zero(),
    allocatedCarryingAmount: R.zero(), derivation: accountingDerivation,
  };
  const xferEntry = {
    allocation: xferAllocation,
    transferOutMovementId: identifier<"InventoryPostedMovement">("effect-xfer-out-mov"),
    destinationAnchorId: identifier<"InventoryPostedAnchor">("effect-xfer-dest-anchor"),
    destinationMovementId: identifier<"InventoryPostedMovement">("effect-xfer-dest-mov"),
    destinationHolding: destHolding,
    destinationLot: destLot,
    evidence: accountingDerivation.evidence,
  };
  const transferOp: Extract<InventoryOwnershipOperation, { kind: "transfer" }> = {
    kind: "transfer", entries: [xferEntry],
    destinationInventoryPolicy: acquisitionContext().inventoryPolicy,
    destinationQuantizationPolicy: quantizationPolicy,
    destinationDimensionMemberIds: [],
  };

  const operations: readonly InventoryOwnershipOperation[] = [acquireOp, transferOp, adoptOp];

  // 1. prepareInventoryOwnershipEffect
  const res = prepareInventoryOwnershipEffect(groupContext, [], operations);
  expect(res.disposition).toBe("prepared");
  if (res.disposition !== "prepared") throw new Error("Expected effect to prepare");

  const effect = res.effect;
  expect(effect.newAnchors.length).toBe(3); // acquire anchor, transfer dest anchor, adopt anchor
  expect(effect.quantityOnlyMovements.length).toBe(4); // acquire mov, transferOut, transferIn, adopt mov

  // 2. validateInventoryOwnershipArtifact on effect
  expect(validateInventoryOwnershipArtifact("ownershipEffect", effect)).toBeTrue();

  // 3. prepareInventoryOwnershipEffectFromReadContext with transfer and adopt
  const reader: InventoryOwnershipReadContext = {
    bookId: IDS.book, bookRevision: groupContext.bookRevision - 1n, assertCurrent() {},
    readCurrentHolding() { return undefined; },
    readCurrentPosition() { return undefined; },
    readAnchor() { return undefined; },
    readPositionAfterImage() { return undefined; },
  };
  const rcResult = prepareInventoryOwnershipEffectFromReadContext(reader, groupContext, operations);
  expect(rcResult.disposition).toBe("prepared");

  // 4. Negative controls on ownershipEffectValid:
  // Corrupt legacyAdoption to have monetaryKind = "journalLinked"
  const badAdoptMov = { ...effect.quantityOnlyMovements.find((m) => m.kind === "legacyAdoption")!, monetaryKind: "journalLinked" as const };
  const badEffect1 = { ...effect, journalLinkedMovements: [badAdoptMov as never], quantityOnlyMovements: effect.quantityOnlyMovements.filter((m) => m.kind !== "legacyAdoption") };
  expect(validateInventoryOwnershipArtifact("ownershipEffect", { ...badEffect1, contentHash: hashInventoryOwnershipEffect(badEffect1) })).toBeFalse();

  // Corrupt transferIn movement to have empty incomingSources
  const badXferInMov = { ...effect.quantityOnlyMovements.find((m) => m.kind === "transferIn")!, incomingSources: [] };
  const badEffect2 = { ...effect, quantityOnlyMovements: effect.quantityOnlyMovements.map((m) => m.kind === "transferIn" ? badXferInMov : m) };
  expect(validateInventoryOwnershipArtifact("ownershipEffect", { ...badEffect2, contentHash: hashInventoryOwnershipEffect(badEffect2) })).toBeFalse();

  // Corrupt destination anchor to have empty incomingMovements
  const badDestAnchor = { ...effect.newAnchors.find((a) => a.predecessorPosition !== undefined)!, incomingMovements: [] };
  const badEffect3 = { ...effect, newAnchors: effect.newAnchors.map((a) => a.predecessorPosition !== undefined ? badDestAnchor : a) };
  expect(validateInventoryOwnershipArtifact("ownershipEffect", { ...badEffect3, contentHash: hashInventoryOwnershipEffect(badEffect3) })).toBeFalse();

  // 5. Line 1615: Unrecognized movement kind in ownershipEffectValid
  const corruptMov = { ...effect.quantityOnlyMovements[0]!, kind: "unknownKind" as any };
  const badEffect4 = { ...effect, quantityOnlyMovements: [corruptMov, ...effect.quantityOnlyMovements.slice(1)] };
  expect(validateInventoryOwnershipArtifact("ownershipEffect", { ...badEffect4, contentHash: hashInventoryOwnershipEffect(badEffect4) })).toBeFalse();

  // 6. Line 1278: Duplicate identity in transfer operation for prepareInventoryOwnershipEffect
  const dupXferEntry = { ...xferEntry, destinationMovementId: acqEntry.movementId };
  const dupXferOp: Extract<InventoryOwnershipOperation, { kind: "transfer" }> = {
    ...transferOp, entries: [dupXferEntry],
  };
  const dupXferRes = prepareInventoryOwnershipEffect(groupContext, [], [acquireOp, dupXferOp]);
  expect(dupXferRes.disposition).toBe("rejected");
  if (dupXferRes.disposition === "rejected") {
    expect(dupXferRes.diagnostics[0]?.path).toBe("inventoryOwnership.effectIdentity");
  }

  // 7. Line 1287: Duplicate identity in adopt operation for prepareInventoryOwnershipEffect
  const dupAdoptEntry: InventoryPostedAdoptionEntry = {
    ...adoptEntry, movementId: acqEntry.movementId,
  };
  const dupAdoptOp: Extract<InventoryOwnershipOperation, { kind: "adopt" }> = {
    ...adoptOp, entries: [dupAdoptEntry],
  };
  const dupAdoptRes = prepareInventoryOwnershipEffect(groupContext, [], [acquireOp, dupAdoptOp]);
  expect(dupAdoptRes.disposition).toBe("rejected");
  if (dupAdoptRes.disposition === "rejected") {
    expect(dupAdoptRes.diagnostics[0]?.path).toBe("inventoryOwnership.effectIdentity");
  }

  // 8. Line 1195: Non-reduction operation kind rejected in prepareInventoryReductionEffect
  const invalidReductionRes = prepareInventoryReductionEffect(groupContext, [originalSource(groupEntry("0.01", 99))], [{ kind: "acquisition", entries: [] } as never]);
  expect(invalidReductionRes.disposition).toBe("rejected");
  if (invalidReductionRes.disposition === "rejected") {
    expect(invalidReductionRes.diagnostics[0]?.path).toBe("inventoryOwnership.groupIdentity");
  }

  // 9. Line 803-804: prepareInventoryPostedAdoptionGroup with historical postings references
  const rawJ = journal("adopt-historical-source");
  const histPost = rawJ.postings[0]!;
  const histRef = createCanonicalPostingReference(canonicalPostingReferenceId("hist-ref-1"), IDS.book, rawJ.id, histPost, effectKey("hist:0"));
  const adoptWithHistEntry: InventoryPostedAdoptionEntry = {
    ...adoptEntry,
    anchorId: identifier<"InventoryPostedAnchor">("adopt-with-hist-anchor"),
    movementId: identifier<"InventoryPostedMovement">("adopt-with-hist-mov"),
    historicalPostings: [histRef],
  };
  const adoptWithHistContext: InventoryPostedAdoptionContext = {
    ...groupContext,
    firstArtifactOrdinal: 1n,
    inventoryPolicy: acquisitionContext().inventoryPolicy,
    quantizationPolicy,
    dimensionMemberIds: [],
  };
  const adoptWithHistRes = prepareInventoryPostedAdoptionGroup(adoptWithHistContext, [adoptWithHistEntry], r(50n));
  expect(adoptWithHistRes.disposition).toBe("prepared");
});

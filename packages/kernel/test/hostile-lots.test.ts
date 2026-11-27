import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  accountId,
  allocateLots,
  derivationId,
  evidenceId,
  hashCanonical,
  instant,
  lotAllocationId,
  lotHoldingId,
  lotId,
  policyId,
  semanticVersion,
  transferLots,
  type DerivationRecord,
  type Lot,
  type LotHolding,
  type LotSelection,
  type TransferPolicy,
} from "../src/index.ts";
import { IDS, policy } from "./fixtures.ts";

const derivation: DerivationRecord = Object.freeze({
  id: derivationId("hostile-lot-derivation"), policyId: policy.id, policyVersion: policy.version,
  algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ hostile: "lots" }), actorId: IDS.actor,
  state: "approved", recordedAt: instant("2026-01-01T00:00:00Z"),
  evidence: Object.freeze([{ id: evidenceId("hostile-lot-evidence"), sourceSystem: "test", sourceRecordId: "lots",
    observedAt: instant("2026-01-01T00:00:00Z"), contentHash: hashCanonical({ evidence: "lots" }) }]),
});

function makeLot(id: string, acquiredAt = "2025-01-01T00:00:00Z", quantity = ExactRational.of(3n, 1n), basis = ExactRational.of(100n, 1n)): Lot {
  return Object.freeze({ id: lotId(id), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant(acquiredAt),
    acquisitionQuantity: quantity, acquisitionTotalBasis: basis, basisCommodityId: IDS.usd,
    evidenceIds: Object.freeze([derivation.evidence[0]!.id]) });
}

function makeHolding(lot: Lot, id: string, account = IDS.cash, quantity = lot.acquisitionQuantity, basis = lot.acquisitionTotalBasis): LotHolding {
  return Object.freeze({ id: lotHoldingId(id), bookId: lot.bookId, lotId: lot.id, accountId: account,
    commodityId: lot.commodityId, basisCommodityId: lot.basisCommodityId,
    remainingQuantity: quantity, remainingTotalBasis: basis,
    remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: basis });
}

const lotA = makeLot("lot-a", "2025-01-01T00:00:00Z", ExactRational.of(2n, 1n), ExactRational.of(20n, 1n));
const lotB = makeLot("lot-b", "2025-02-01T00:00:00Z", ExactRational.of(2n, 1n), ExactRational.of(40n, 1n));
const holdingA = makeHolding(lotA, "holding-a");
const holdingB = makeHolding(lotB, "holding-b");
const identities = [
  { holdingId: holdingA.id, allocationId: lotAllocationId("allocation-a") },
  { holdingId: holdingB.id, allocationId: lotAllocationId("allocation-b") },
];

function allocate(holdings: readonly LotHolding[], lots: readonly Lot[], quantity: ExactRational, selection: LotSelection, ids = identities) {
  return allocateLots(holdings, lots, quantity, selection, derivation, ids);
}

describe("hostile lot selection and transfer", () => {
  test("rejects malformed holdings, requests, lot identity, and specific selections", () => {
    const missingAmounts = { ...holdingA, remainingQuantity: undefined } as unknown as LotHolding;
    expect(allocate([missingAmounts], [lotA], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    const inconsistentCarrying = { ...holdingA, remainingCarryingAmount: ExactRational.of(999n, 1n) };
    expect(allocate([inconsistentCarrying], [lotA], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA, holdingA], [lotA], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([{ ...holdingA, remainingQuantity: ExactRational.of(-1n, 1n) }], [lotA], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([{ ...holdingA, remainingQuantity: ExactRational.zero() }], [lotA], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.zero(), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(-1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA, lotA], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(1n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: holdingA.id, quantity: ExactRational.of(1n, 2n) }, { holdingId: holdingA.id, quantity: ExactRational.of(1n, 2n) },
    ] }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(1n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: holdingA.id, quantity: ExactRational.zero() },
    ] }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(1n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: holdingA.id, quantity: ExactRational.of(2n, 1n) },
    ] }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(1n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("missing"), quantity: ExactRational.of(1n, 1n) },
    ] }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(3n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: holdingA.id, quantity: ExactRational.of(3n, 1n) },
    ] }).disposition).toBe("rejected");
  });

  test("rejects unresolved or mixed lots and explicit identity failures", () => {
    expect(allocate([holdingA], [], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA], [{ ...lotA, evidenceIds: [] }], ExactRational.of(1n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    const other = makeHolding(lotB, "holding-other", IDS.cash);
    expect(allocate([holdingA, { ...other, bookId: ("other-book" as typeof IDS.book) }], [lotA, { ...lotB, bookId: ("other-book" as typeof IDS.book) }], ExactRational.of(3n, 1n), { method: "fifo" }).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(1n, 1n), { method: "fifo" }, []).disposition).toBe("rejected");
    expect(allocate([holdingA, holdingB], [lotA, lotB], ExactRational.of(3n, 1n), { method: "fifo" }, [
      { holdingId: holdingA.id, allocationId: lotAllocationId("same") },
      { holdingId: holdingB.id, allocationId: lotAllocationId("same") },
    ]).disposition).toBe("rejected");
    expect(allocate([holdingA], [lotA], ExactRational.of(3n, 1n), { method: "fifo" }).disposition).toBe("rejected");
  });

  test("deterministically exercises FIFO, LIFO, HIFO, ties, full depletion, and zero holdings", () => {
    const expectedOrder = { fifo: [holdingA.id, holdingB.id], lifo: [holdingB.id, holdingA.id], hifo: [holdingB.id, holdingA.id] } as const;
    for (const method of ["fifo", "lifo", "hifo"] as const) {
      const result = allocate([holdingA, holdingB], [lotA, lotB], ExactRational.of(3n, 1n), { method });
      expect(result.disposition).toBe("allocated");
      if (result.disposition === "allocated") expect(result.allocations.map((allocation) => allocation.holdingId)).toEqual([...expectedOrder[method]]);
    }
    const tiedLot = makeLot("lot-c", lotA.acquiredAt, ExactRational.of(1n, 1n), ExactRational.of(10n, 1n));
    const tiedHolding = makeHolding(tiedLot, "holding-c");
    const tie = allocate([tiedHolding, holdingA], [tiedLot, lotA], ExactRational.of(1n, 1n), { method: "hifo" }, [
      ...identities, { holdingId: tiedHolding.id, allocationId: lotAllocationId("allocation-c") },
    ]);
    expect(tie.disposition).toBe("allocated");
    if (tie.disposition === "allocated") expect(tie.allocations[0]?.holdingId).toBe(holdingA.id);
    const fifoTie = allocate([tiedHolding, holdingA], [tiedLot, lotA], ExactRational.of(1n, 1n), { method: "fifo" }, [
      ...identities, { holdingId: tiedHolding.id, allocationId: lotAllocationId("allocation-c-fifo") },
    ]);
    expect(fifoTie.disposition).toBe("allocated");
    if (fifoTie.disposition === "allocated") expect(fifoTie.allocations[0]?.holdingId).toBe(holdingA.id);
    const weighted = allocate([holdingB, holdingA], [lotB, lotA], ExactRational.of(2n, 1n), { method: "weightedAverage" });
    expect(weighted.disposition).toBe("allocated");
    if (weighted.disposition === "allocated") {
      expect(weighted.allocations.map((allocation) => allocation.holdingId)).toEqual([holdingA.id, holdingB.id]);
      expect(weighted.allocations.every((allocation) => allocation.allocatedQuantity.equals(ExactRational.of(1n, 1n)))).toBeTrue();
    }
    const depleted = makeHolding(lotA, "holding-zero", IDS.cash, ExactRational.zero(), ExactRational.zero());
    expect(allocate([depleted, holdingA], [lotA], ExactRational.of(1n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: depleted.id, quantity: ExactRational.of(1n, 1n) },
    ] }, [{ holdingId: depleted.id, allocationId: lotAllocationId("zero") }]).disposition).toBe("rejected");
    expect(allocate([holdingA, holdingB], [lotA, lotB], ExactRational.of(3n, 1n), { method: "specificIdentification", allocations: [
      { holdingId: holdingB.id, quantity: ExactRational.of(1n, 1n) },
      { holdingId: holdingA.id, quantity: ExactRational.of(2n, 1n) },
    ] }, identities).disposition).toBe("allocated");
  });

  test("covers every transfer policy and destination topology", () => {
    const destinationAccount = IDS.revenue;
    const continuity: TransferPolicy = { id: policyId("continuity"), version: semanticVersion("1.0.0"), bookId: IDS.book,
      sourceAccountId: IDS.cash, destinationAccountId: destinationAccount,
      validFrom: instant("2020-01-01T00:00:00Z"), validTo: instant("2030-01-01T00:00:00Z"), treatment: "continuity" };
    const transfer = (
      source: readonly LotHolding[] = [holdingA],
      destination: readonly LotHolding[] = [],
      selectedPolicies: readonly TransferPolicy[] = [continuity],
      quantity = ExactRational.of(1n, 1n),
      allocationIds = [{ holdingId: holdingA.id, allocationId: lotAllocationId("transfer-a") }],
      destinationIds = [{ sourceHoldingId: holdingA.id, destinationHoldingId: lotHoldingId("destination-a") }],
      governedAt = instant("2026-01-01T00:00:00Z"),
    ) => transferLots(source, destination, [lotA], quantity, { method: "fifo" }, selectedPolicies,
      governedAt, destinationAccount, derivation, allocationIds, destinationIds);
    expect(transfer([]).disposition).toBe("rejected");
    expect(transfer([{ ...holdingA }, { ...holdingB, accountId: accountId("other-source") }]).disposition).toBe("rejected");
    expect(transfer([holdingA], [], []).disposition).toBe("rejected");
    expect(transfer([holdingA], [], [continuity, { ...continuity, id: policyId("continuity-2") }]).disposition).toBe("rejected");
    expect(transfer([holdingA], [], [{ ...continuity, treatment: "disposalAndReacquisition" }]).disposition).toBe("requiresDisposalAndReacquisition");
    expect(transfer([holdingA], [], [continuity], ExactRational.of(3n, 1n)).disposition).toBe("rejected");
    const invalidDestination = makeHolding(lotA, "invalid-destination", IDS.cash);
    expect(transfer([holdingA], [invalidDestination]).disposition).toBe("rejected");
    const destination = makeHolding(lotA, "destination-existing", destinationAccount, ExactRational.of(1n, 1n), ExactRational.of(10n, 1n));
    expect(transfer([holdingA], [destination, destination]).disposition).toBe("rejected");
    expect(transfer([holdingA], [], [continuity], ExactRational.of(1n, 1n), undefined, []).disposition).toBe("rejected");
    const collidingDestination = { ...makeHolding(lotB, "destination-a", destinationAccount), lotId: lotB.id };
    expect(transfer([holdingA], [collidingDestination]).disposition).toBe("rejected");
    const merged = transfer([holdingA], [destination]);
    expect(merged.disposition).toBe("transferred");
    if (merged.disposition === "transferred") {
      expect(merged.destinationHoldings).toHaveLength(1);
      expect(merged.destinationHoldings[0]?.remainingQuantity.equals(ExactRational.of(2n, 1n))).toBeTrue();
    }
    expect(transfer([holdingA], [], [continuity], ExactRational.of(1n, 1n), undefined, undefined, continuity.validFrom).disposition).toBe("transferred");
    expect(transfer([holdingA], [], [continuity], ExactRational.of(1n, 1n), undefined, undefined, continuity.validTo!).disposition).toBe("rejected");
    expect(transfer().disposition).toBe("transferred");
  });

  test("rejects an otherwise valid mixed-book allocation at the population boundary", () => {
    const otherLot = { ...lotB, bookId: ("other-book" as typeof IDS.book) };
    const otherHolding = { ...holdingB, bookId: otherLot.bookId };
    const result = allocate([holdingA, otherHolding], [lotA, otherLot], ExactRational.of(3n, 1n), { method: "fifo" }, [
      identities[0]!, { holdingId: otherHolding.id, allocationId: identities[1]!.allocationId },
    ]);
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") expect(result.diagnostics[0]?.path).toBe("holdings");
  });
});

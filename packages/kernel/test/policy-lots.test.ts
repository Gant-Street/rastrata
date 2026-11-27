import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  allocateLots,
  derivationId,
  evidenceId,
  hashCanonical,
  instant,
  lotAllocationId,
  lotHoldingId,
  lotId,
  policyId,
  priceObservationId,
  resolveJournal,
  selectBookingPolicy,
  semanticVersion,
  transferLots,
  valueWithObservation,
  type DerivationRecord,
  type Lot,
  type LotHolding,
  type TransferPolicy,
} from "../src/index.ts";
import { IDS, journal, policy, quantizationPolicy } from "./fixtures.ts";

function exactValues(value: ReturnType<typeof journal>): readonly ExactRational[] {
  return value.postings.map((posting) => posting.bookValue.amount.toRational());
}

const evidence = Object.freeze({
  id: evidenceId("evidence-1"),
  sourceSystem: "fixture",
  sourceRecordId: "source-1",
  observedAt: instant("2026-01-15T11:00:00Z"),
  contentHash: hashCanonical({ source: "immutable" }),
});

const derivation: DerivationRecord = Object.freeze({
  id: derivationId("derivation-1"),
  policyId: policy.id,
  policyVersion: policy.version,
  algorithmVersion: semanticVersion("1.0.0"),
  inputHash: hashCanonical({ complete: "input" }),
  actorId: IDS.actor,
  state: "approved",
  recordedAt: instant("2026-01-15T13:00:00Z"),
  evidence: Object.freeze([evidence]),
});

const lot: Lot = Object.freeze({
  id: lotId("lot-stable-1"),
  bookId: IDS.book,
  commodityId: IDS.usd,
  acquiredAt: instant("2025-01-01T00:00:00Z"),
  acquisitionQuantity: ExactRational.of(3n, 1n),
  acquisitionTotalBasis: ExactRational.of(100n, 1n),
  basisCommodityId: IDS.usd,
  evidenceIds: Object.freeze([evidence.id]),
});

const holding: LotHolding = Object.freeze({
  id: lotHoldingId("holding-source-1"),
  bookId: IDS.book,
  lotId: lot.id,
  accountId: IDS.cash,
  commodityId: IDS.usd,
  basisCommodityId: IDS.usd,
  remainingQuantity: ExactRational.of(3n, 1n),
  remainingTotalBasis: ExactRational.of(100n, 1n),
  remainingValuationAllowance: ExactRational.zero(),
  remainingCarryingAmount: ExactRational.of(100n, 1n),
});

describe("policy and provenance", () => {
  test("resolves exactly one policy at economic time and pins its version (V03)", () => {
    const selected = selectBookingPolicy([policy], {
      bookId: IDS.book,
      governedAt: instant("2026-01-15T12:00:00Z"),
      scopeKey: IDS.owner,
    });
    expect(selected.disposition).toBe("resolved");

    const value = journal("policy-journal");
    const resolved = resolveJournal(value, [policy], IDS.owner, quantizationPolicy, exactValues(value), [derivation]);
    expect(Array.isArray(resolved)).toBeFalse();
    if ("journal" in resolved) {
      expect(resolved.derivations[0]?.inputHash.digest).toBe(derivation.inputHash.digest);
      expect(resolved.derivations[0]?.evidence[0]?.id).toBe(evidence.id);
    }
  });

  test("fails closed when policy applicability overlaps (ACC-007, I05)", () => {
    const overlapping = Object.freeze({ ...policy, id: policyId("policy-overlap") });
    const result = selectBookingPolicy([policy, overlapping], {
      bookId: IDS.book,
      governedAt: instant("2026-01-15T12:00:00Z"),
      scopeKey: IDS.owner,
    });
    expect(result.disposition).toBe("rejected");
  });

  test("treats booking policy validity as an inclusive start and exclusive end", () => {
    const bounded = Object.freeze({ ...policy, validFrom: instant("2026-01-15T12:00:00Z"), validTo: instant("2026-01-15T13:00:00Z") });
    expect(selectBookingPolicy([bounded], { bookId: IDS.book, governedAt: bounded.validFrom, scopeKey: IDS.owner }).disposition).toBe("resolved");
    expect(selectBookingPolicy([bounded], { bookId: IDS.book, governedAt: bounded.validTo, scopeKey: IDS.owner }).disposition).toBe("rejected");
  });

  test("does not treat declared but unverified policy vocabulary as supported", () => {
    const unsupported = Object.freeze({
      ...policy,
      lotSelection: "weightedAverage" as const,
      capability: Object.freeze({
        ...policy.capability,
        method: "weightedAverage" as const,
        status: "unsupported" as const,
      }),
    });
    const result = selectBookingPolicy([unsupported], {
      bookId: IDS.book,
      governedAt: instant("2026-01-15T12:00:00Z"),
      scopeKey: IDS.owner,
    });
    expect(result.disposition).toBe("rejected");
  });

  test("uses economic time for booking policy rather than recording time (I11)", () => {
    const laterPolicy = Object.freeze({
      ...policy,
      validFrom: instant("2026-01-16T00:00:00Z"),
    });
    const recordedLater = Object.freeze({
      ...journal("time-separation"),
      recordedAt: instant("2026-01-17T00:00:00Z"),
    });
    const result = resolveJournal(recordedLater, [laterPolicy], IDS.owner, quantizationPolicy, exactValues(recordedLater));
    expect(Array.isArray(result)).toBeTrue();
  });

  test("rejects unapproved or evidence-free derivations (ACC-017)", () => {
    const invalid = Object.freeze({ ...derivation, state: "proposed" as const, evidence: Object.freeze([]) });
    const value = journal("bad-derivation");
    const result = resolveJournal(value, [policy], IDS.owner, quantizationPolicy, exactValues(value), [invalid]);
    expect(Array.isArray(result)).toBeTrue();
  });
});

describe("lot identity and conservation", () => {
  test("allocates exact authoritative total basis without per-unit feedback (V04)", () => {
    const result = allocateLots(
      [holding],
      [lot],
      ExactRational.of(1n, 1n),
      { method: "specificIdentification", allocations: [{ holdingId: holding.id, quantity: ExactRational.of(1n, 1n) }] },
      derivation,
      [{ holdingId: holding.id, allocationId: lotAllocationId("allocation-1") }],
    );
    expect(result.disposition).toBe("allocated");
    if (result.disposition === "allocated") {
      expect(result.allocations[0]?.allocatedTotalBasis.equals(ExactRational.of(100n, 3n))).toBeTrue();
      expect(result.holdings[0]?.remainingTotalBasis.equals(ExactRational.of(200n, 3n))).toBeTrue();
      expect(
        result.allocations[0]?.allocatedTotalBasis.add(result.holdings[0]!.remainingTotalBasis).equals(ExactRational.of(100n, 1n)),
      ).toBeTrue();
    }
  });

  test("rejects over-allocation before changing holdings (I08)", () => {
    const result = allocateLots(
      [holding],
      [lot],
      ExactRational.of(4n, 1n),
      { method: "fifo" },
      derivation,
      [{ holdingId: holding.id, allocationId: lotAllocationId("allocation-over") }],
    );
    expect(result.disposition).toBe("rejected");
    expect(holding.remainingQuantity.equals(ExactRational.of(3n, 1n))).toBeTrue();
  });

  test("preserves lot identity, quantity, and basis across a continuity transfer (ACC-010)", () => {
    const transferPolicy: TransferPolicy = Object.freeze({
      id: policyId("transfer-policy"),
      version: semanticVersion("1.0.0"),
      bookId: IDS.book,
      sourceAccountId: IDS.cash,
      destinationAccountId: IDS.revenue,
      validFrom: instant("2020-01-01T00:00:00Z"),
      treatment: "continuity",
    });
    const result = transferLots(
      [holding],
      [],
      [lot],
      ExactRational.of(1n, 1n),
      { method: "fifo" },
      [transferPolicy],
      instant("2026-01-15T12:00:00Z"),
      IDS.revenue,
      derivation,
      [{ holdingId: holding.id, allocationId: lotAllocationId("transfer-allocation") }],
      [{ sourceHoldingId: holding.id, destinationHoldingId: lotHoldingId("holding-destination") }],
    );
    expect(result.disposition).toBe("transferred");
    if (result.disposition === "transferred") {
      expect(result.destinationHoldings[0]?.lotId).toBe(lot.id);
      const quantity = result.sourceHoldings[0]!.remainingQuantity.add(result.destinationHoldings[0]!.remainingQuantity);
      const basis = result.sourceHoldings[0]!.remainingTotalBasis.add(result.destinationHoldings[0]!.remainingTotalBasis);
      expect(quantity.equals(holding.remainingQuantity)).toBeTrue();
      expect(basis.equals(holding.remainingTotalBasis)).toBeTrue();
    }
  });

  test("requires one explicit boundary policy (I09)", () => {
    const result = transferLots(
      [holding], [], [lot], ExactRational.of(1n, 1n), { method: "fifo" }, [],
      instant("2026-01-15T12:00:00Z"), IDS.revenue, derivation,
      [{ holdingId: holding.id, allocationId: lotAllocationId("unused-a") }],
      [{ sourceHoldingId: holding.id, destinationHoldingId: lotHoldingId("unused-h") }],
    );
    expect(result.disposition).toBe("rejected");
  });
});

test("market valuation is a distinct result and leaves booked semantics untouched (V06)", () => {
  const booked = journal("valuation-source");
  const before = booked.postings[0]?.bookValue.amount.toString();
  const value = valueWithObservation(
    booked.postings[0]!.units,
    Object.freeze({
      id: priceObservationId("price-1"),
      effectiveAt: instant("2026-01-15T11:00:00Z"),
      observedAt: instant("2026-01-15T11:01:00Z"),
      kind: "marketQuote",
      rate: ExactRational.of(3n, 2n),
      baseCommodityId: IDS.usd,
      quoteCommodityId: IDS.usd,
      evidenceId: evidence.id,
    }),
    instant("2026-01-15T12:00:00Z"),
    false,
  );
  expect(value.exactAmount.equals(ExactRational.of(150n, 1n))).toBeTrue();
  expect(booked.postings[0]?.bookValue.amount.toString()).toBe(before);
});

test("valuation rejects future or disconnected observations and supports an explicit inverse", () => {
  const quantity = journal("valuation-branches").postings[0]!.units;
  const observation = Object.freeze({
    id: priceObservationId("inverse-price"), effectiveAt: instant("2026-01-15T11:00:00Z"),
    observedAt: instant("2026-01-15T11:01:00Z"), kind: "officialRate" as const,
    rate: ExactRational.of(2n, 1n), baseCommodityId: IDS.revenue as unknown as typeof IDS.usd,
    quoteCommodityId: IDS.usd, evidenceId: evidence.id,
  });
  expect(valueWithObservation(quantity, observation, instant("2026-01-15T12:00:00Z"), true).usesInverse).toBeTrue();
  expect(valueWithObservation(quantity, { ...observation, effectiveAt: instant("2026-01-15T12:00:00Z") }, instant("2026-01-15T12:00:00Z"), true).usesInverse).toBeTrue();
  expect(() => valueWithObservation(quantity, { ...observation, effectiveAt: instant("2026-01-16T00:00:00Z") }, instant("2026-01-15T12:00:00Z"), true)).toThrow();
  expect(() => valueWithObservation(quantity, observation, instant("2026-01-15T12:00:00Z"), false)).toThrow();
});

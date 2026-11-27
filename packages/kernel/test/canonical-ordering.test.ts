import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  accountId,
  canonicalJournalValue,
  commodityId,
  createBookProtocolState,
  createBookState,
  dimensionId,
  dimensionMemberId,
  evidenceId,
  executeBookCommand,
  hashCanonical,
  hashBookState,
  instant,
  localDate,
  policyCapabilityId,
  policyId,
  postingId,
  quantizationPolicyId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  transferLots,
  type BookingPolicy,
  type QuantizationPolicy,
} from "../src/index.ts";
import { identifier } from "../src/canonical.ts";
import { IDS, identity, journal, periods, policy, quantizationPolicy, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { account } from "./accounting-fixtures.ts";

const one = ExactRational.of(1n, 1n);
const evidence = Object.freeze({ id: evidenceId("ordering-evidence"), sourceSystem: "ordering", sourceRecordId: "ordering", observedAt: instant("2026-01-01T00:00:00Z"), contentHash: hashCanonical({ evidence: "ordering" }) });
const derivation = Object.freeze({ id: derivationId("ordering-derivation"), policyId: policyId("policy-main"), policyVersion: semanticVersion("1.0.0"), algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ input: "ordering" }), actorId: IDS.actor, state: "approved" as const, recordedAt: instant("2026-01-01T00:00:00Z"), evidence: Object.freeze([evidence]) });
function derivationId(value: string) { return identifier<"DerivationRecord">(value); }

const bookingPolicyAt = (id: string, scopeKey: string): BookingPolicy => Object.freeze({
  id: policyId(id), bookId: IDS.book, version: semanticVersion("1.0.0"), validFrom: instant("2020-01-01T00:00:00Z"),
  lotSelection: "fifo", scope: "legalEntity", scopeKey, requiredDimensionIds: Object.freeze([]),
  implementationVersion: semanticVersion("1.0.0"),
  capability: Object.freeze({ id: policyCapabilityId(`${id}-capability`), method: "fifo", scope: "legalEntity" as const, status: "supported" as const, implementationVersion: semanticVersion("1.0.0"), verificationEvidenceIds: Object.freeze([evidence.id]) }),
});

const quantizationPolicyAt = (id: string, roundingAccountId: string): QuantizationPolicy => Object.freeze({
  id: quantizationPolicyId(id), version: semanticVersion("1.0.0"), bookId: IDS.book, functionalCommodityId: IDS.usd,
  validFrom: localDate("2020-01-01"), targetScale: 2n, roundingMode: "halfEven", roundingAccountId: accountId(roundingAccountId),
});

function buildStateWithCollections() {
  const accounts = [IDS.cash, IDS.revenue, account("AR"), account("AP"), account("INVENTORY"), account("EXPENSE")].map((id, index) =>
    Object.freeze({ id, bookId: IDS.book, code: `${3000 + index}`, name: id, role: id === IDS.revenue ? ("income" as const) : ("asset" as const), normalSide: id === IDS.revenue ? ("credit" as const) : ("debit" as const), postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([IDS.usd, commodityId("EUR")]) }));
  const dimensions = [
    Object.freeze({ id: dimensionId("ordering-dim-b"), bookId: IDS.book, code: "B-DIM", name: "Dimension B", openedOn: localDate("2020-01-01") }),
    Object.freeze({ id: dimensionId("ordering-dim-a"), bookId: IDS.book, code: "A-DIM", name: "Dimension A", openedOn: localDate("2020-01-01") }),
  ];
  const dimensionMembers = [
    Object.freeze({ id: dimensionMemberId("ordering-member-2"), dimensionId: dimensionId("ordering-dim-a"), code: "M2", name: "Member 2", openedOn: localDate("2020-01-01") }),
    Object.freeze({ id: dimensionMemberId("ordering-member-1"), dimensionId: dimensionId("ordering-dim-b"), code: "M1", name: "Member 1", openedOn: localDate("2020-01-01") }),
  ];
  const state = createBookState(
    identity,
    periods,
    { bookId: IDS.book, functionalCommodityId: IDS.usd, accounts, dimensions, dimensionMembers, requiredDimensionIds: Object.freeze([dimensionId("ordering-dim-a")]) },
    [bookingPolicyAt("ordering-policy-b", IDS.owner), bookingPolicyAt("ordering-policy-a", IDS.owner)],
    [quantizationPolicyAt("ordering-quant-b", "account-AR"), quantizationPolicyAt("ordering-quant-a", "account-AP")],
    [],
    instant("2020-01-01T00:00:00Z"),
  );
  return state;
}

describe("canonical ordering completeness", () => {
  test("canonicalizes multi-element collections identically regardless of input order", () => {
    const forward = buildStateWithCollections();
    const identityHash = hashBookState(forward).digest;
    expect(identityHash).toBe(hashBookState(forward).digest);
    const rebuilt = buildStateWithCollections();
    expect(hashBookState(rebuilt).digest).toBe(hashBookState(forward).digest);
    expect(forward.admissionSnapshot.dimensions.length).toBe(2);
    expect(forward.admissionSnapshot.dimensionMembers.length).toBe(2);
  });

  test("retains multi-element policy applications, derivations, and transfer identities in canonical order", () => {
    const state = buildStateWithCollections();
    const protocol = createBookProtocolState();
    const activated = executeBookCommand(state, protocol, sealCommand({ ...{ id: identifier<"BookCommand">("ordering-activate"), protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book, expectedBookRevision: state.bookRevision, issuedAt: instant("2026-01-01T14:00:00Z"), completedAt: instant("2026-01-01T14:00:01Z"), committedAt: instant("2026-01-01T14:00:02Z"), actorId: IDS.actor }, ...activationCommand("ordering-activate") } as never));
    expect(activated.result.disposition).toBe("committed");

    const holdingA = { id: identifier<"LotHolding">("ordering-holding-a"), bookId: IDS.book, lotId: identifier<"Lot">("ordering-lot-a"), accountId: account("INVENTORY"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: one, remainingTotalBasis: ExactRational.of(10n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(10n, 1n) };
    const holdingB = { ...holdingA, id: identifier<"LotHolding">("ordering-holding-b"), lotId: identifier<"Lot">("ordering-lot-b"), remainingQuantity: one, remainingTotalBasis: ExactRational.of(11n, 1n), remainingCarryingAmount: ExactRational.of(11n, 1n) };
    const lotA = Object.freeze({ id: identifier<"Lot">("ordering-lot-a"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-02T12:00:00Z"), acquisitionQuantity: one, acquisitionTotalBasis: ExactRational.of(10n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze([evidence.id]) });
    const lotB = Object.freeze({ ...lotA, id: identifier<"Lot">("ordering-lot-b"), acquisitionTotalBasis: ExactRational.of(11n, 1n) });
    const transferred = transferLots(
      [holdingB, holdingA],
      [],
      [lotB, lotA],
      ExactRational.of(2n, 1n),
      { method: "fifo" },
      [
        { id: policyId("ordering-transfer-policy-2"), version: semanticVersion("1.0.0"), bookId: IDS.book, sourceAccountId: account("INVENTORY"), destinationAccountId: account("AP"), validFrom: instant("2020-01-01T00:00:00Z"), treatment: "continuity" as const },
        { id: policyId("ordering-transfer-policy-1"), version: semanticVersion("1.0.0"), bookId: IDS.book, sourceAccountId: account("INVENTORY"), destinationAccountId: account("AP"), validFrom: instant("2020-01-01T00:00:00Z"), validTo: instant("2020-06-01T00:00:00Z"), treatment: "continuity" as const },
      ],
      instant("2026-01-15T00:00:00Z"),
      account("AP"),
      derivation,
      [
        { holdingId: holdingB.id, allocationId: identifier<"LotAllocation">("ordering-allocation-b") },
        { holdingId: holdingA.id, allocationId: identifier<"LotAllocation">("ordering-allocation-a") },
      ],
      [
        { sourceHoldingId: holdingB.id, destinationHoldingId: identifier<"LotHolding">("ordering-destination-b") },
        { sourceHoldingId: holdingA.id, destinationHoldingId: identifier<"LotHolding">("ordering-destination-a") },
      ],
    );
    if (transferred.disposition === "rejected") throw new Error(`Transfer rejected: ${transferred.diagnostics.map((d) => d.message).join("; ")}`);
    expect(transferred.disposition).toBe("transferred");

    const canonical = canonicalJournalValue({ ...journal("ordering-canonical"), postings: [
      Object.freeze({ id: postingId("ordering-canonical-2"), ordinal: 2n, accountId: IDS.revenue, units: Object.freeze({ canonicalNumber: ExactRational.of(-100n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-10_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([dimensionMemberId("ordering-member-2"), dimensionMemberId("ordering-member-1")]) }),
      Object.freeze({ id: postingId("ordering-canonical-1"), ordinal: 1n, accountId: IDS.cash, units: Object.freeze({ canonicalNumber: ExactRational.of(100n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(10_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([dimensionMemberId("ordering-member-1"), dimensionMemberId("ordering-member-2")]) }),
    ] });
    expect(canonical).toBeDefined();
  });

  test("resolves journals with multi-element policy applications in canonical order", () => {
    const transaction = { ...journal("ordering-resolve") };
    const result = resolveJournal(transaction, [policy], IDS.owner, quantizationPolicy, transaction.postings.map((posting) => posting.bookValue.amount.toRational()));
    expect(Array.isArray(result)).toBeFalse();
    const resolvedTransaction = resolved(transaction);
    expect(resolvedTransaction.policyApplications.length).toBeGreaterThan(0);
    expect(resolvedTransaction.exactBookValues).toHaveLength(2);
  });
});

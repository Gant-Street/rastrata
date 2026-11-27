import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  canonicalDerivationValue,
  derivationId,
  evidenceId,
  hashCanonical,
  hashPolicySnapshot,
  instant,
  journalId,
  policyId,
  postingId,
  resolveJournal,
  semanticVersion,
  selectBookingPolicy,
  type BookingPolicy,
  type DerivationRecord,
  type JournalTransaction,
} from "../src/index.ts";
import { IDS, journal, policy, quantizationPolicy } from "./fixtures.ts";

const evidence = Object.freeze({ id: evidenceId("policy-hostile-evidence"), sourceSystem: "test", sourceRecordId: "one",
  observedAt: instant("2026-01-01T00:00:00Z"), contentHash: hashCanonical({ evidence: 1n }) });

function derivation(overrides: Partial<DerivationRecord> = {}): DerivationRecord {
  return Object.freeze({ id: derivationId("policy-hostile-derivation"), policyId: policy.id, policyVersion: policy.version,
    algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ input: 1n }), actorId: IDS.actor,
    state: "approved", recordedAt: instant("2026-01-01T00:00:00Z"), evidence: Object.freeze([evidence]), ...overrides });
}

describe("hostile policy, provenance, and quantization resolution", () => {
  test("never resolves ambiguous posting ordinals into a successful quantized transaction", () => {
    const value = journal("duplicate-ordinal");
    const ambiguous = { ...value, postings: value.postings.map((p) => ({ ...p, ordinal: 1n })) };
    for (const candidate of [ambiguous, { ...ambiguous, postings: [...ambiguous.postings].reverse() }]) {
      const result = resolveJournal(candidate, [policy], IDS.owner, quantizationPolicy, candidate.postings.map((p) => p.bookValue.amount.toRational()));
      expect(result).toEqual([{ code: "invalid_journal_structure", path: "journal.postings",
        message: "Posting ordinals must be unique before resolving their quantized values", requirementIds: ["ACC-018", "ACC-019"] }]);
    }
    // Uniqueness is the contract: ordinals need not be contiguous or one-based.
    const sparse = { ...value, postings: value.postings.map((p, i) => ({ ...p, ordinal: BigInt(i * 10) })) };
    expect(Array.isArray(resolveJournal(sparse, [policy], IDS.owner, quantizationPolicy, sparse.postings.map((p) => p.bookValue.amount.toRational())))).toBe(false);
  });

  test("validates semantic versions, policy ordering, and supplied instants", () => {
    expect(() => semanticVersion("01.0.0")).toThrow();
    const later = { ...policy, id: policyId("z-policy") };
    const earlier = { ...policy, id: policyId("a-policy") };
    expect(hashPolicySnapshot([later, earlier]).digest).toBe(hashPolicySnapshot([earlier, later]).digest);
    const sameIdentityDifferentContent = { ...policy, requiredDimensionIds: ["different-dimension" as never] };
    expect(hashPolicySnapshot([policy, sameIdentityDifferentContent]).digest).toBe(hashPolicySnapshot([sameIdentityDifferentContent, policy]).digest);
    expect(() => selectBookingPolicy([policy], { bookId: IDS.book, governedAt: "invalid" as ReturnType<typeof instant>, scopeKey: IDS.owner })).toThrow();
  });

  test("rejects incomplete per-posting scope and mismatched account policy", () => {
    const value = journal("posting-scope");
    expect(Array.isArray(resolveJournal(value, [policy], [], quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeTrue();
    const accountPolicy: BookingPolicy = { ...policy, id: policyId("account-policy"), scope: "account", scopeKey: IDS.revenue,
      capability: { ...policy.capability, scope: "account" } };
    const applications = value.postings.map((posting) => ({ postingId: posting.id, scopeKey: IDS.revenue }));
    expect(Array.isArray(resolveJournal(value, [accountPolicy], applications, quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeTrue();
    const cashPolicy: BookingPolicy = { ...accountPolicy, id: policyId("cash-account-policy"), scopeKey: IDS.cash };
    const revenuePolicy: BookingPolicy = { ...accountPolicy, id: policyId("revenue-account-policy"), scopeKey: IDS.revenue };
    const exactApplications = value.postings.map((posting) => ({ postingId: posting.id, scopeKey: posting.accountId }));
    const admitted = resolveJournal(value, [cashPolicy, revenuePolicy], exactApplications, quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational()));
    expect(Array.isArray(admitted)).toBeFalse();
    if ("journal" in admitted) expect(admitted.policyApplications.map((application) => application.postingId)).toEqual(value.postings.map((posting) => posting.id));
    const foreignApplications = [exactApplications[0]!, { ...exactApplications[1]!, postingId: postingId("foreign-posting") }];
    expect(Array.isArray(resolveJournal(value, [cashPolicy, revenuePolicy], foreignApplications, quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeTrue();
  });

  test("rejects conflicting complete policy identity selected across postings", () => {
    const value = journal("conflicting-policy");
    const left: BookingPolicy = { ...policy, scopeKey: "left" };
    const right: BookingPolicy = { ...policy, scopeKey: "right", requiredDimensionIds: [] };
    const applications = [
      { postingId: value.postings[0]!.id, scopeKey: "left" },
      { postingId: value.postings[1]!.id, scopeKey: "right" },
    ];
    expect(Array.isArray(resolveJournal(value, [left, right], applications, quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeTrue();
  });

  test("rejects inapplicable and internally imbalanced quantization inputs", () => {
    const value = journal("bad-quant-policy");
    expect(Array.isArray(resolveJournal(value, [policy], IDS.owner,
      { ...quantizationPolicy, validFrom: "2027-01-01" as typeof quantizationPolicy.validFrom },
      value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeTrue();
    expect(Array.isArray(resolveJournal(value, [policy], IDS.owner, quantizationPolicy,
      [ExactRational.of(1n, 1n), ExactRational.of(-2n, 1n)]))).toBeTrue();
    expect(Array.isArray(resolveJournal(value, [policy], IDS.owner,
      { ...quantizationPolicy, validFrom: value.accountingDate }, value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeFalse();
    expect(Array.isArray(resolveJournal(value, [policy], IDS.owner,
      { ...quantizationPolicy, validTo: value.accountingDate }, value.postings.map((posting) => posting.bookValue.amount.toRational())))).toBeTrue();
  });

  test("proves and checks the explicit rounding posting", () => {
    const values = [ExactRational.of(1n, 3n), ExactRational.of(1n, 3n), ExactRational.of(-2n, 3n)];
    const amounts = [ExactDecimal.of(33n, 2n), ExactDecimal.of(33n, 2n), ExactDecimal.of(-67n, 2n), ExactDecimal.of(1n, 2n)];
    const rounded: JournalTransaction = Object.freeze({
      ...journal("rounding-proof"), id: journalId("rounding-proof"),
      postings: Object.freeze(amounts.map((amount, index) => Object.freeze({
        id: postingId(`rounding-${index}`), ordinal: BigInt(index + 1),
        accountId: index === 3 ? quantizationPolicy.roundingAccountId : index % 2 === 0 ? IDS.cash : IDS.revenue,
        units: Object.freeze({ canonicalNumber: ExactRational.of(amount.coefficient, 100n), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount, functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]),
      }))),
    });
    expect(Array.isArray(resolveJournal(rounded, [policy], IDS.owner, quantizationPolicy, values))).toBeFalse();
    const wrongRounding = { ...rounded, postings: rounded.postings.map((posting, index) => index === 3 ? { ...posting, accountId: IDS.revenue } : posting) };
    expect(Array.isArray(resolveJournal(wrongRounding, [policy], IDS.owner, quantizationPolicy, values))).toBeTrue();
  });

  test("rejects derivation policy and full evidence identity conflicts", () => {
    const value = journal("evidence-conflict");
    const wrong = derivation({ policyId: policyId("wrong-policy") });
    const conflictingEvidence = { ...evidence, sourceRecordId: "different" };
    const second = derivation({ id: derivationId("second"), evidence: [conflictingEvidence] });
    expect(Array.isArray(resolveJournal(value, [policy], IDS.owner, quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational()), [wrong, second]))).toBeTrue();
    const secondEvidence = { ...evidence, id: evidenceId("policy-hostile-evidence-second") };
    expect(canonicalDerivationValue(derivation({ evidence: [secondEvidence, evidence] }))).toBeDefined();
    const validFirst = derivation({ id: derivationId("valid-first") });
    const validConflict = derivation({ id: derivationId("valid-conflict"), evidence: [{ ...evidence, sourceRecordId: "conflicting-record" }] });
    expect(Array.isArray(resolveJournal(value, [policy], IDS.owner, quantizationPolicy,
      value.postings.map((posting) => posting.bookValue.amount.toRational()), [validFirst, validConflict]))).toBeTrue();
  });
});

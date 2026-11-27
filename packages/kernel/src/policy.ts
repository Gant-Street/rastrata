import {
  compareCanonicalText,
  hashCanonical,
  identifier,
  type CanonicalValue,
  type ContentHash,
  type Identifier,
} from "./canonical.ts";
import {
  diagnostic,
  type BookId,
  type DimensionId,
  type Instant,
  type JournalTransaction,
  type SemanticDiagnostic,
} from "./journal.ts";
import {
  hashQuantizationPolicy,
  quantizeBalancedBookValues,
  type QuantizationPolicy,
} from "./quantization.ts";
import { ExactRational } from "./numeric.ts";

export type PolicyId = Identifier<"BookingPolicy">;
export type EvidenceId = Identifier<"SourceEvidence">;
export type DerivationId = Identifier<"DerivationRecord">;
export type PolicyCapabilityId = Identifier<"PolicyCapability">;

export const policyId = (value: string): PolicyId => identifier<"BookingPolicy">(value);
export const evidenceId = (value: string): EvidenceId => identifier<"SourceEvidence">(value);
export const derivationId = (value: string): DerivationId =>
  identifier<"DerivationRecord">(value);
export const policyCapabilityId = (value: string): PolicyCapabilityId =>
  identifier<"PolicyCapability">(value);

declare const semanticVersionBrand: unique symbol;
export type SemanticVersion = string & { readonly [semanticVersionBrand]: "SemanticVersion" };

export function semanticVersion(value: string): SemanticVersion {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new RangeError(`Invalid semantic version: ${value}`);
  }
  return value as SemanticVersion;
}

export interface SourceEvidence {
  readonly id: EvidenceId;
  readonly sourceSystem: string;
  readonly sourceRecordId: string;
  readonly observedAt: Instant;
  readonly contentHash: ContentHash;
}

export type LotSelectionMethod =
  | "specificIdentification"
  | "fifo"
  | "lifo"
  | "hifo"
  | "weightedAverage";
export type PolicyScope = "account" | "legalEntity" | "jurisdictionPool";

export interface PolicyCapability {
  readonly id: PolicyCapabilityId;
  readonly method: LotSelectionMethod;
  readonly scope: PolicyScope;
  readonly status: "supported" | "experimental" | "unsupported";
  readonly implementationVersion: SemanticVersion;
  readonly verificationEvidenceIds: readonly EvidenceId[];
}

export interface BookingPolicy {
  readonly id: PolicyId;
  readonly bookId: BookId;
  readonly version: SemanticVersion;
  readonly validFrom: Instant;
  readonly validTo?: Instant;
  readonly lotSelection: LotSelectionMethod;
  readonly scope: PolicyScope;
  readonly scopeKey: string;
  readonly requiredDimensionIds: readonly DimensionId[];
  readonly implementationVersion: SemanticVersion;
  readonly capability: PolicyCapability;
}

export interface DerivationRecord {
  readonly id: DerivationId;
  readonly policyId: PolicyId;
  readonly policyVersion: SemanticVersion;
  readonly algorithmVersion: SemanticVersion;
  readonly inputHash: ContentHash;
  readonly actorId: Identifier<"Actor">;
  readonly state: "proposed" | "approved" | "rejected" | "applied";
  readonly recordedAt: Instant;
  readonly evidence: readonly SourceEvidence[];
}

export interface ResolvedTransaction {
  readonly journal: JournalTransaction;
  readonly policyApplications: readonly {
    readonly postingId: JournalTransaction["postings"][number]["id"];
    readonly scopeKey: string;
    readonly policyId: PolicyId;
    readonly policyVersion: SemanticVersion;
  }[];
  readonly policySnapshotHash: ContentHash;
  readonly quantizationPolicy: QuantizationPolicy;
  readonly quantizationPolicySnapshotHash: ContentHash;
  readonly exactBookValues: readonly ExactRational[];
  readonly derivations: readonly DerivationRecord[];
}

export type PolicyResolution =
  | { readonly disposition: "resolved"; readonly policy: BookingPolicy }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

function instantMillis(value: Instant): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new RangeError(`Invalid supplied instant: ${value}`);
  return millis;
}

export function selectBookingPolicy(
  policies: readonly BookingPolicy[],
  fact: { readonly bookId: BookId; readonly governedAt: Instant; readonly scopeKey: string },
): PolicyResolution {
  const at = instantMillis(fact.governedAt);
  const matches = policies.filter(
    (policy) =>
      policy.bookId === fact.bookId &&
      policy.scopeKey === fact.scopeKey &&
      instantMillis(policy.validFrom) <= at &&
      (policy.validTo === undefined || at < instantMillis(policy.validTo)),
  );
  if (matches.length !== 1) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic(
          "policy_ambiguity",
          "policies",
          `Expected exactly one applicable policy at the governed economic time; found ${matches.length}`,
          ["ACC-007", "ACC-011", "ACC-013"],
        ),
      ]),
    });
  }
  const policy = matches[0];
  if (policy === undefined) throw new Error("Policy cardinality changed during resolution");
  if (
    policy.capability.status !== "supported" ||
    policy.capability.method !== policy.lotSelection ||
    policy.capability.scope !== policy.scope ||
    policy.capability.implementationVersion !== policy.implementationVersion ||
    policy.capability.verificationEvidenceIds.length === 0
  ) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic(
          "policy_ambiguity",
          "policies.capability",
          "Applicable policy does not have matching supported executable capability evidence",
          ["ACC-007", "ACC-011"],
        ),
      ]),
    });
  }
  return Object.freeze({ disposition: "resolved", policy });
}

export function canonicalPolicyValue(policy: BookingPolicy): CanonicalValue {
  return {
    type: "BookingPolicy",
    id: policy.id,
    bookId: policy.bookId,
    version: policy.version,
    validFrom: policy.validFrom,
    validTo: policy.validTo ?? null,
    lotSelection: policy.lotSelection,
    scope: policy.scope,
    scopeKey: policy.scopeKey,
    requiredDimensionIds: [...policy.requiredDimensionIds].sort(),
    implementationVersion: policy.implementationVersion,
    capability: {
      id: policy.capability.id,
      method: policy.capability.method,
      scope: policy.capability.scope,
      status: policy.capability.status,
      implementationVersion: policy.capability.implementationVersion,
      verificationEvidenceIds: [...policy.capability.verificationEvidenceIds].sort(),
    },
  };
}

export function hashPolicySnapshot(policies: readonly BookingPolicy[]): ContentHash {
  return hashCanonical({
    type: "BookingPolicySnapshot",
    policies: [...policies]
      .sort((left, right) => compareCanonicalText(`${left.id}@${left.version}:${hashCanonical(canonicalPolicyValue(left)).digest}`, `${right.id}@${right.version}:${hashCanonical(canonicalPolicyValue(right)).digest}`))
      .map(canonicalPolicyValue),
  });
}

export function canonicalDerivationValue(derivation: DerivationRecord): CanonicalValue {
  return {
    type: "DerivationRecord",
    id: derivation.id,
    policyId: derivation.policyId,
    policyVersion: derivation.policyVersion,
    algorithmVersion: derivation.algorithmVersion,
    inputHash: {
      algorithm: derivation.inputHash.algorithm,
      canonicalizationVersion: derivation.inputHash.canonicalizationVersion,
      digest: derivation.inputHash.digest,
    },
    actorId: derivation.actorId,
    state: derivation.state,
    recordedAt: derivation.recordedAt,
    evidence: [...derivation.evidence]
      .sort((left, right) => compareCanonicalText(`${left.id}:${hashCanonical({ id: left.id, sourceSystem: left.sourceSystem, sourceRecordId: left.sourceRecordId, observedAt: left.observedAt, contentHash: { algorithm: left.contentHash.algorithm, canonicalizationVersion: left.contentHash.canonicalizationVersion, digest: left.contentHash.digest } }).digest}`, `${right.id}:${hashCanonical({ id: right.id, sourceSystem: right.sourceSystem, sourceRecordId: right.sourceRecordId, observedAt: right.observedAt, contentHash: { algorithm: right.contentHash.algorithm, canonicalizationVersion: right.contentHash.canonicalizationVersion, digest: right.contentHash.digest } }).digest}`))
      .map((evidence) => ({
        id: evidence.id,
        sourceSystem: evidence.sourceSystem,
        sourceRecordId: evidence.sourceRecordId,
        observedAt: evidence.observedAt,
        contentHash: {
          algorithm: evidence.contentHash.algorithm,
          canonicalizationVersion: evidence.contentHash.canonicalizationVersion,
          digest: evidence.contentHash.digest,
        },
      })),
  };
}

export function resolveJournal(
  journal: JournalTransaction,
  policies: readonly BookingPolicy[],
  governedScope: string | readonly { readonly postingId: JournalTransaction["postings"][number]["id"]; readonly scopeKey: string }[],
  quantizationPolicy: QuantizationPolicy,
  exactBookValues: readonly ExactRational[],
  derivations: readonly DerivationRecord[] = [],
): ResolvedTransaction | readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const suppliedApplications = typeof governedScope === "string"
    ? journal.postings.map((posting) => ({ postingId: posting.id, scopeKey: governedScope }))
    : [...governedScope];
  if (
    suppliedApplications.length !== journal.postings.length ||
    new Set(suppliedApplications.map((application) => application.postingId)).size !== journal.postings.length ||
    journal.postings.some((posting) => !suppliedApplications.some((application) => application.postingId === posting.id))
  ) {
    return Object.freeze([
      diagnostic("policy_ambiguity", "governedScope", "Policy scope must resolve exactly once for every canonical posting", ["ACC-007", "ACC-011", "ACC-018", "ACC-038"]),
    ]);
  }
  const selectedPolicies: BookingPolicy[] = [];
  const policyApplications: ResolvedTransaction["policyApplications"][number][] = [];
  for (const application of suppliedApplications) {
    const resolution = selectBookingPolicy(policies, {
      bookId: journal.bookId,
      governedAt: journal.economicAt,
      scopeKey: application.scopeKey,
    });
    if (resolution.disposition === "rejected") diagnostics.push(...resolution.diagnostics);
    else {
      const posting = journal.postings.find((candidate) => candidate.id === application.postingId)!;
      if (resolution.policy.scope === "account" && resolution.policy.scopeKey !== posting.accountId) {
        diagnostics.push(diagnostic("policy_ambiguity", "governedScope", "Account-scoped policy must govern the posting account identity", ["ACC-007", "ACC-011", "ACC-026"]));
      }
      selectedPolicies.push(resolution.policy);
      policyApplications.push({
        postingId: application.postingId,
        scopeKey: application.scopeKey,
        policyId: resolution.policy.id,
        policyVersion: resolution.policy.version,
      });
    }
  }
  if (diagnostics.length > 0) return Object.freeze(diagnostics);
  const selectedByIdentity = new Map<string, BookingPolicy>();
  for (const selected of selectedPolicies) {
    const key = `${selected.id}@${selected.version}`;
    const existing = selectedByIdentity.get(key);
    if (existing !== undefined && JSON.stringify(canonicalPolicyValue(existing)) !== JSON.stringify(canonicalPolicyValue(selected))) {
      return Object.freeze([diagnostic("canonical_identity_conflict", "policies", `Policy identity ${key} has conflicting complete content`, ["ACC-011", "ACC-038"])]);
    }
    selectedByIdentity.set(key, selected);
  }
  const uniquePolicies = [...selectedByIdentity.values()];
  if (
    quantizationPolicy.bookId !== journal.bookId ||
    quantizationPolicy.functionalCommodityId !== journal.functionalCommodityId ||
    quantizationPolicy.validFrom > journal.accountingDate ||
    (quantizationPolicy.validTo !== undefined && journal.accountingDate >= quantizationPolicy.validTo)
  ) {
    diagnostics.push(
      diagnostic(
        "policy_ambiguity",
        "quantizationPolicy",
        "Quantization policy is not applicable to this book, commodity, and accounting date",
        ["ACC-003", "ACC-011", "ACC-013", "ACC-026"],
      ),
    );
  } else {
    const quantized = quantizeBalancedBookValues(
      exactBookValues,
      journal.bookId,
      journal.functionalCommodityId,
      quantizationPolicy,
    );
    if (quantized.disposition === "rejected") {
      diagnostics.push(...quantized.diagnostics);
    } else {
      const ordered = [...journal.postings].sort((left, right) =>
        left.ordinal < right.ordinal ? -1 : left.ordinal > right.ordinal ? 1 : 0
      );
      if (new Set(ordered.map((posting) => posting.ordinal)).size !== ordered.length) {
        return Object.freeze([diagnostic("invalid_journal_structure", "journal.postings", "Posting ordinals must be unique before resolving their quantized values", ["ACC-018", "ACC-019"])]);
      }
      const expectedCount = quantized.bookValues.length + (quantized.roundingPosting === undefined ? 0 : 1);
      const valuesMatch = ordered.length === expectedCount && quantized.bookValues.every((bookValue, index) => {
        const posting = ordered[index];
        return posting !== undefined &&
          posting.bookValue.functionalCommodityId === bookValue.functionalCommodityId &&
          posting.bookValue.amount.toRational().equals(bookValue.amount.toRational());
      });
      const rounding = quantized.roundingPosting;
      const roundingMatches = rounding === undefined || (() => {
        const posting = ordered[ordered.length - 1];
        return posting !== undefined && posting.accountId === rounding.accountId &&
          posting.bookValue.functionalCommodityId === rounding.bookValue.functionalCommodityId &&
          posting.bookValue.amount.toRational().equals(rounding.bookValue.amount.toRational());
      })();
      if (!valuesMatch || !roundingMatches) {
        diagnostics.push(
          diagnostic(
            "journal_imbalance",
            "journal.postings",
            "Booked values and any rounding posting do not reproduce the pinned quantization policy",
            ["ACC-003", "ACC-005", "ACC-011"],
          ),
        );
      }
    }
  }
  const evidenceHashes = new Map<string, string>();
  for (const [index, derivation] of derivations.entries()) {
    if (!uniquePolicies.some((selected) => derivation.policyId === selected.id && derivation.policyVersion === selected.version)) {
      diagnostics.push(
        diagnostic(
          "policy_ambiguity",
          `derivations[${index}].policyId`,
          "Derivation does not identify the policy selected for the governed economic time",
          ["ACC-011", "ACC-017"],
        ),
      );
    }
    if (derivation.evidence.length === 0 || derivation.state !== "approved") {
      diagnostics.push(
        diagnostic(
          "unresolved_accounting_input",
          `derivations[${index}]`,
          "A canonical derivation must be approved and retain at least one evidence item",
          ["ACC-005", "ACC-017"],
        ),
      );
    }
    for (const evidence of derivation.evidence) {
      const canonicalEvidence = JSON.stringify({
        id: evidence.id,
        sourceSystem: evidence.sourceSystem,
        sourceRecordId: evidence.sourceRecordId,
        observedAt: evidence.observedAt,
        contentHash: evidence.contentHash,
      });
      const retainedContent = evidenceHashes.get(evidence.id);
      if (retainedContent !== undefined && retainedContent !== canonicalEvidence) {
        diagnostics.push(
          diagnostic(
            "canonical_identity_conflict",
            `derivations[${index}].evidence`,
            `Evidence identifier ${evidence.id} resolves to conflicting content`,
            ["ACC-017", "ACC-038"],
          ),
        );
      }
      evidenceHashes.set(evidence.id, canonicalEvidence);
    }
  }
  if (diagnostics.length > 0) return Object.freeze(diagnostics);

  return Object.freeze({
    journal,
    policyApplications: Object.freeze(policyApplications),
    policySnapshotHash: hashPolicySnapshot(uniquePolicies),
    quantizationPolicy: Object.freeze({ ...quantizationPolicy }),
    quantizationPolicySnapshotHash: hashQuantizationPolicy(quantizationPolicy),
    exactBookValues: Object.freeze([...exactBookValues]),
    derivations: Object.freeze([...derivations]),
  });
}

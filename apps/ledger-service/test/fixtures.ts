import {
  ExactDecimal,
  ExactRational,
  accountId,
  actorId,
  bookId,
  commandId,
  commodityId,
  createBookProtocolState,
  createBookState,
  evidenceId,
  fiscalCalendarId,
  fiscalPeriodId,
  identifier,
  instant,
  journalId,
  localDate,
  openingBoundaryId,
  policyCapabilityId,
  policyId,
  postingId,
  quantizationPolicyId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  type BookingPolicy,
  type QuantizationPolicy,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import {
  BOOK_ACCESS_TOKEN_TYPE,
  NATIVE_INCIDENT_TOKEN_TYPE,
  NATIVE_RECOVERY_TOKEN_TYPE,
  type CompleteBookScope,
  type NativeRecoveryEvidence,
} from "@rastrata/ledger";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const BOOK = bookId("service-book"),
  CASH = accountId("cash"),
  INCOME = accountId("income");
const USD = commodityId("USD"),
  OWNER = identifier<"BookOwner">("company");
const CALENDAR = fiscalCalendarId("calendar"),
  VERSION = semanticVersion("1.0.0");
const policy: BookingPolicy = {
  id: policyId("booking"),
  bookId: BOOK,
  version: VERSION,
  validFrom: instant("2020-01-01T00:00:00Z"),
  lotSelection: "specificIdentification",
  scope: "legalEntity",
  scopeKey: OWNER,
  requiredDimensionIds: [],
  implementationVersion: VERSION,
  capability: {
    id: policyCapabilityId("specific"),
    method: "specificIdentification",
    scope: "legalEntity",
    status: "supported",
    implementationVersion: VERSION,
    verificationEvidenceIds: [evidenceId("fixture")],
  },
};
const quantization: QuantizationPolicy = {
  id: quantizationPolicyId("quantization"),
  bookId: BOOK,
  version: VERSION,
  functionalCommodityId: USD,
  validFrom: localDate("2020-01-01"),
  targetScale: 2n,
  roundingMode: "halfEven",
  roundingAccountId: CASH,
};
export function genesis() {
  return {
    state: createBookState(
      {
        bookId: BOOK,
        code: "BOOK",
        ownerId: OWNER,
        ownerKind: "legalEntity",
        kind: "operational",
        functionalCommodityId: USD,
        primaryBasis: "accrual",
        fiscalCalendarId: CALENDAR,
        accountingTimeZone: "UTC",
      },
      [
        {
          id: fiscalPeriodId("january"),
          calendarId: CALENDAR,
          fiscalYear: 2026n,
          sequence: 1n,
          label: "January",
          kind: "regular",
          startsOn: localDate("2026-01-01"),
          endsOn: localDate("2026-01-31"),
        },
      ],
      {
        bookId: BOOK,
        functionalCommodityId: USD,
        accounts: [
          {
            id: CASH,
            bookId: BOOK,
            code: "1000",
            name: "Cash",
            role: "asset",
            normalSide: "debit",
            postingAllowed: true,
            openedOn: localDate("2020-01-01"),
            allowedCommodityIds: [],
          },
          {
            id: INCOME,
            bookId: BOOK,
            code: "4000",
            name: "Income",
            role: "income",
            normalSide: "credit",
            postingAllowed: true,
            openedOn: localDate("2020-01-01"),
            allowedCommodityIds: [],
          },
        ],
        dimensions: [],
        dimensionMembers: [],
        requiredDimensionIds: [],
      },
      [policy],
      [quantization],
      [],
      instant("2020-01-01T00:00:00Z"),
    ),
    protocol: createBookProtocolState(),
  };
}
export function activation() {
  return sealCommand({
    id: commandId("activate"),
    type: "activateBook",
    protocolVersion: VERSION,
    bookId: BOOK,
    expectedBookRevision: 0n,
    actorId: actorId("actor"),
    issuedAt: instant("2026-01-01T00:00:00Z"),
    completedAt: instant("2026-01-01T00:00:01Z"),
    committedAt: instant("2026-01-01T00:00:02Z"),
    mode: "newZeroBalance",
    boundaryId: openingBoundaryId("opening"),
    firstAccountingDate: localDate("2026-01-01"),
  });
}
export function posting(id = "post", revision = 1n) {
  const journal = {
    id: journalId(id),
    kind: "ordinary" as const,
    bookId: BOOK,
    functionalCommodityId: USD,
    economicAt: instant("2026-01-15T12:00:00Z"),
    accountingDate: localDate("2026-01-15"),
    recordedAt: instant("2026-01-15T13:00:00Z"),
    narration: id,
    postings: [CASH, INCOME].map((account, index) => ({
      id: postingId(`${id}-${index}`),
      ordinal: BigInt(index),
      accountId: account,
      units: { canonicalNumber: ExactRational.of(index ? -100n : 100n, 1n), commodityId: USD },
      bookValue: {
        amount: ExactDecimal.of(index ? -10000n : 10000n, 2n),
        functionalCommodityId: USD,
      },
      dimensionMemberIds: [],
    })),
  };
  const resolved = resolveJournal(
    journal,
    [policy],
    OWNER,
    quantization,
    journal.postings.map((p) => p.bookValue.amount.toRational()),
  );
  if (Array.isArray(resolved)) throw new Error("Invalid test journal");
  return sealCommand({
    id: commandId(id),
    type: "postJournal",
    protocolVersion: VERSION,
    bookId: BOOK,
    expectedBookRevision: revision,
    actorId: actorId("actor"),
    issuedAt: instant("2026-01-15T14:00:00Z"),
    completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"),
    resolved: resolved as ResolvedTransaction,
  });
}
export async function issuer(keyId = "test") {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const configuration = {
    issuer: "https://app.rastrata.test",
    audience: "ledger-test",
    publicKeys: {
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: keyId, alg: "ES256", use: "sig" }],
    },
  };
  const signRecovery = async (type: string, claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    return `Bearer ${await new SignJWT({
      iss: configuration.issuer,
      aud: configuration.audience,
      sub: "actor",
      iat: now,
      nbf: now,
      exp: now + 300,
      ...claims,
    })
      .setProtectedHeader({ typ: type, alg: "ES256", kid: keyId })
      .sign(keys.privateKey)}`;
  };
  return {
    configuration,
    incident: (
      scope: CompleteBookScope,
      catalogHash: string,
      requestId: string,
      claims: Record<string, unknown> = {},
    ) =>
      signRecovery(NATIVE_INCIDENT_TOKEN_TYPE, { scope, catalogHash, jti: requestId, ...claims }),
    recovery: (
      evidence: NativeRecoveryEvidence,
      quarantinedCatalogHash: string,
      claims: Record<string, unknown> = {},
    ) =>
      signRecovery(NATIVE_RECOVERY_TOKEN_TYPE, {
        evidence,
        quarantinedCatalogHash,
        jti: evidence.requestId,
        ...claims,
      }),
    token: async (scope: CompleteBookScope, claims: Record<string, unknown> = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return `Bearer ${await new SignJWT({
        scope,
        iss: configuration.issuer,
        aud: configuration.audience,
        sub: "actor",
        iat: now,
        nbf: now,
        exp: now + 300,
        authorizationRevision: "0",
        writerFence: "0",
        permissions: ["read", "execute", "provision", "maintain"],
        ...claims,
      })
        .setProtectedHeader({ typ: BOOK_ACCESS_TOKEN_TYPE, alg: "ES256", kid: keyId })
        .sign(keys.privateKey)}`;
    },
  };
}

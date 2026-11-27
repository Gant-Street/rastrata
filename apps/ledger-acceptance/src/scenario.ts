// Fixed synthetic data only. This is deliberately not an application command decoder.
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
  type BookCommand,
  type QuantizationPolicy,
  type ResolvedTransaction,
} from "@rastrata/kernel";

export const TENANT = "synthetic-development-only";
export const BOOK = bookId("synthetic-smoke-v1");
const USD = commodityId("USD");
const OWNER = identifier<"BookOwner">("synthetic-company");
const CASH = accountId("cash");
const INCOME = accountId("income");
const CALENDAR = fiscalCalendarId("calendar");
const VERSION = semanticVersion("1.0.0");
const POLICY: BookingPolicy = {
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
    verificationEvidenceIds: [evidenceId("synthetic-smoke")],
  },
};
const QUANTIZATION: QuantizationPolicy = {
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
        code: "SYNTHETIC",
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
            name: "Synthetic Cash",
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
            name: "Synthetic Income",
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
      [POLICY],
      [QUANTIZATION],
      [],
      instant("2020-01-01T00:00:00Z"),
    ),
    protocol: createBookProtocolState(),
  };
}

export function activation(): BookCommand {
  return sealCommand({
    id: commandId("activate"),
    type: "activateBook",
    protocolVersion: VERSION,
    bookId: BOOK,
    expectedBookRevision: 0n,
    actorId: actorId("synthetic-runner"),
    issuedAt: instant("2026-01-01T00:00:00Z"),
    completedAt: instant("2026-01-01T00:00:01Z"),
    committedAt: instant("2026-01-01T00:00:02Z"),
    mode: "newZeroBalance",
    boundaryId: openingBoundaryId("opening"),
    firstAccountingDate: localDate("2026-01-01"),
  });
}

export function posting(balanced: boolean): BookCommand {
  return prepareSyntheticPosting(
    balanced,
    balanced ? "synthetic-sale" : "synthetic-unbalanced",
    balanced ? 1n : 2n,
  );
}

/** One additional fixed command for a genuine single-save remote observation. */
export function nativeSave(): BookCommand {
  return prepareSyntheticPosting(true, "synthetic-followup", 2n);
}

function prepareSyntheticPosting(balanced: boolean, id: string, revision: bigint): BookCommand {
  const journal = {
    id: journalId(id),
    kind: "ordinary" as const,
    bookId: BOOK,
    functionalCommodityId: USD,
    economicAt: instant("2026-01-15T12:00:00Z"),
    accountingDate: localDate("2026-01-15"),
    recordedAt: instant("2026-01-15T13:00:00Z"),
    narration: "Synthetic development sale, not real books",
    postings: [CASH, INCOME].map((account, index) => {
      const amount = index === 0 ? 100n : -100n;
      return {
        id: postingId(`${id}-${index}`),
        ordinal: BigInt(index),
        accountId: account,
        units: { canonicalNumber: ExactRational.of(amount, 1n), commodityId: USD },
        bookValue: { amount: ExactDecimal.of(amount * 100n, 2n), functionalCommodityId: USD },
        dimensionMemberIds: [],
      };
    }),
  };
  const resolved = resolveJournal(
    journal,
    [POLICY],
    OWNER,
    QUANTIZATION,
    journal.postings.map((p) => p.bookValue.amount.toRational()),
  );
  if (Array.isArray(resolved)) throw new Error("Synthetic journal failed to resolve");
  const transaction = resolved as ResolvedTransaction;
  return sealCommand({
    id: commandId(id),
    type: "postJournal",
    protocolVersion: VERSION,
    bookId: BOOK,
    expectedBookRevision: revision,
    actorId: actorId("synthetic-runner"),
    issuedAt: instant("2026-01-15T14:00:00Z"),
    completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"),
    resolved: balanced
      ? transaction
      : {
          ...transaction,
          journal: {
            ...journal,
            postings: journal.postings.map((p, i) =>
              i === 0
                ? p
                : {
                    ...p,
                    bookValue: { ...p.bookValue, amount: ExactDecimal.of(-9900n, 2n) },
                  },
            ),
          },
        },
  });
}

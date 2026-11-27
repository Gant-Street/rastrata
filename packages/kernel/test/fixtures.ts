import {
  ExactDecimal,
  ExactRational,
  accountId,
  actorId,
  bookId,
  closePackageId,
  commodityId,
  createCanonicalPostingReference,
  canonicalPostingReferenceId,
  effectKey,
  createBookProtocolState,
  createBookState,
  fiscalCalendarId,
  fiscalPeriodId,
  evidenceId,
  hashCanonical,
  instant,
  journalId,
  localDate,
  openingBoundaryId,
  policyId,
  policyCapabilityId,
  quantizationPolicyId,
  postingId,
  resolveJournal,
  semanticVersion,
  type BookFinancialIdentity,
  type BookProtocolState,
  type BookState,
  type BookingPolicy,
  type FiscalPeriod,
  type JournalTransaction,
  type CanonicalPostingReference,
  type ResolvedTransaction,
  type QuantizationPolicy,
} from "../src/index.ts";
import { identifier } from "../src/canonical.ts";

export const IDS = Object.freeze({
  book: bookId("book-main"),
  usd: commodityId("USD"),
  owner: identifier<"BookOwner">("owner-main"),
  actor: actorId("actor-main"),
  calendar: fiscalCalendarId("calendar-main"),
  cash: accountId("account-cash"),
  revenue: accountId("account-revenue"),
  period1: fiscalPeriodId("period-2026-01"),
  period2: fiscalPeriodId("period-2026-02"),
  boundary: openingBoundaryId("opening-main"),
});

export const identity: BookFinancialIdentity = Object.freeze({
  bookId: IDS.book,
  code: "MAIN",
  ownerId: IDS.owner,
  ownerKind: "legalEntity",
  kind: "operational",
  functionalCommodityId: IDS.usd,
  primaryBasis: "accrual",
  fiscalCalendarId: IDS.calendar,
  accountingTimeZone: "America/Denver",
});

export const periods: readonly FiscalPeriod[] = Object.freeze([
  Object.freeze({
    id: IDS.period1,
    calendarId: IDS.calendar,
    fiscalYear: 2026n,
    sequence: 1n,
    label: "January 2026",
    kind: "regular" as const,
    startsOn: localDate("2026-01-01"),
    endsOn: localDate("2026-01-31"),
  }),
  Object.freeze({
    id: IDS.period2,
    calendarId: IDS.calendar,
    fiscalYear: 2026n,
    sequence: 2n,
    label: "February 2026",
    kind: "regular" as const,
    startsOn: localDate("2026-02-01"),
    endsOn: localDate("2026-02-28"),
  }),
]);

export const policy: BookingPolicy = Object.freeze({
  id: policyId("policy-main"),
  bookId: IDS.book,
  version: semanticVersion("1.0.0"),
  validFrom: instant("2020-01-01T00:00:00Z"),
  lotSelection: "specificIdentification",
  scope: "legalEntity",
  scopeKey: IDS.owner,
  requiredDimensionIds: Object.freeze([]),
  implementationVersion: semanticVersion("1.0.0"),
  capability: Object.freeze({
    id: policyCapabilityId("capability-specific-legal-entity"),
    method: "specificIdentification",
    scope: "legalEntity",
    status: "supported",
    implementationVersion: semanticVersion("1.0.0"),
    verificationEvidenceIds: Object.freeze([evidenceId("kernel-fixture-v04")]),
  }),
});

export const quantizationPolicy: QuantizationPolicy = Object.freeze({
  id: quantizationPolicyId("quantization-usd"),
  version: semanticVersion("1.0.0"),
  bookId: IDS.book,
  functionalCommodityId: IDS.usd,
  validFrom: localDate("2020-01-01"),
  targetScale: 2n,
  roundingMode: "halfEven",
  roundingAccountId: IDS.cash,
});

export function freshState(customPeriods: readonly FiscalPeriod[] = periods): {
  readonly state: BookState;
  readonly protocol: BookProtocolState;
} {
  return {
    state: createBookState(
      identity,
      customPeriods,
      Object.freeze({
        bookId: IDS.book,
        functionalCommodityId: IDS.usd,
        accounts: Object.freeze([
          Object.freeze({
            id: IDS.cash,
            bookId: IDS.book,
            code: "1000",
            name: "Cash",
            role: "asset",
            normalSide: "debit",
            postingAllowed: true,
            openedOn: localDate("2020-01-01"),
            allowedCommodityIds: Object.freeze([]),
          }),
          Object.freeze({
            id: IDS.revenue,
            bookId: IDS.book,
            code: "4000",
            name: "Revenue",
            role: "income",
            normalSide: "credit",
            postingAllowed: true,
            openedOn: localDate("2020-01-01"),
            allowedCommodityIds: Object.freeze([]),
          }),
        ]),
        dimensions: Object.freeze([]),
        dimensionMembers: Object.freeze([]),
        requiredDimensionIds: Object.freeze([]),
      }),
      [policy],
      [quantizationPolicy],
      [],
      instant("2020-01-01T00:00:00Z"),
    ),
    protocol: createBookProtocolState(),
  };
}

export function journal(
  id: string,
  date = "2026-01-15",
  kind: JournalTransaction["kind"] = "ordinary",
  reverse = false,
): JournalTransaction {
  const sign = reverse ? -1n : 1n;
  return Object.freeze({
    id: journalId(id),
    kind,
    bookId: IDS.book,
    functionalCommodityId: IDS.usd,
    economicAt: instant(`${date}T12:00:00Z`),
    accountingDate: localDate(date),
    recordedAt: instant(`${date}T13:00:00Z`),
    narration: `Journal ${id}`,
    postings: Object.freeze([
      Object.freeze({
        id: postingId(`${id}-debit`),
        ordinal: 1n,
        accountId: IDS.cash,
        units: Object.freeze({ canonicalNumber: ExactRational.of(100n * sign, 1n), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount: ExactDecimal.of(10_000n * sign, 2n), functionalCommodityId: IDS.usd }),
        dimensionMemberIds: Object.freeze([]),
      }),
      Object.freeze({
        id: postingId(`${id}-credit`),
        ordinal: 2n,
        accountId: IDS.revenue,
        units: Object.freeze({ canonicalNumber: ExactRational.of(-100n * sign, 1n), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount: ExactDecimal.of(-10_000n * sign, 2n), functionalCommodityId: IDS.usd }),
        dimensionMemberIds: Object.freeze([]),
      }),
    ]),
  });
}

export function resolved(value: JournalTransaction): ResolvedTransaction {
  const result = resolveJournal(
    value,
    [policy],
    IDS.owner,
    quantizationPolicy,
    value.postings.map((posting) => posting.bookValue.amount.toRational()),
  );
  if (Array.isArray(result)) throw new Error(result.map((item) => item.message).join("; "));
  return result as ResolvedTransaction;
}

export function postingReference(
  value: JournalTransaction,
  sourceEffectKey: string,
  postingOrdinal = 1n,
): CanonicalPostingReference {
  const posting = value.postings.find((candidate) => candidate.ordinal === postingOrdinal);
  if (posting === undefined) throw new Error(`Posting ordinal ${postingOrdinal} does not exist in ${value.id}`);
  return createCanonicalPostingReference(
    canonicalPostingReferenceId(`${value.id}-${posting.id}-${sourceEffectKey}`),
    value.bookId,
    value.id,
    posting,
    effectKey(sourceEffectKey),
  );
}

export const reportHash = hashCanonical({ fixture: "report-population" });
export const reportPolicyHash = hashCanonical({ fixture: "report-policy" });
export { closePackageId };

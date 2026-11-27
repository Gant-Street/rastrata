import {
  ExactDecimal,
  ExactRational,
  accountId,
  actorId,
  bookId,
  commandId,
  closePackageId,
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
  derivationId,
  openItemId,
  createCanonicalPostingReference,
  canonicalPostingReferenceId,
  effectKey,
  type RecognizeOpenItemCommand,
  type ApplySettlementCommand,
  settlementId,
  settlementAllocationId,
  type OpenItemId,
  hashCanonical,
  semanticVersion,
  type BookingPolicy,
  type BookCommand,
  type QuantizationPolicy,
  type ResolvedTransaction,
  type BookState,
  type BookedJournal,
  type ClosePeriodCommand,
  type ReopenPeriodCommand,
} from "@rastrata/kernel";

export const BOOK = bookId("ledger-test-book");
const USD = commodityId("USD");
const OWNER = identifier<"BookOwner">("company");
export const CASH = accountId("cash");
export const INCOME = accountId("income");
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
    verificationEvidenceIds: [evidenceId("test")],
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

export function genesis(cashName = "Cash") {
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
            name: cashName,
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
      [POLICY],
      [QUANTIZATION],
      [],
      instant("2020-01-01T00:00:00Z"),
    ),
    protocol: createBookProtocolState(),
  };
}

export function chartGenesis(accounts: number) {
  if (!Number.isInteger(accounts) || accounts < 2) throw new Error("Invalid chart size");
  const base = genesis();
  const state = base.state;
  const template = state.admissionSnapshot.accounts[0];
  if (!template) throw new Error("Missing template account");
  return {
    ...base,
    state: createBookState(
      state.identity,
      state.periods,
      {
        ...state.admissionSnapshot,
        accounts: [
          ...state.admissionSnapshot.accounts,
          ...Array.from({ length: accounts - 2 }, (_, i) => ({
            ...template,
            id: accountId(`unused-${i}`),
            code: String(10000 + i),
            name: `Unused account ${i}`,
          })),
        ],
      },
      state.policies,
      state.quantizationPolicies,
      [],
      instant("2020-01-01T00:00:00Z"),
    ),
  };
}

export function activation(): BookCommand {
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

export function posting(
  id = "post",
  revision = 1n,
  balanced = true,
  narration = id,
  accountingDate = localDate("2026-01-15"),
): BookCommand {
  const journal = {
    id: journalId(id),
    kind: "ordinary" as const,
    bookId: BOOK,
    functionalCommodityId: USD,
    economicAt: instant("2026-01-15T12:00:00Z"),
    accountingDate,
    recordedAt: instant("2026-01-15T13:00:00Z"),
    narration,
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
  if (Array.isArray(resolved)) throw new Error("Fixture must resolve");
  const transaction = resolved as ResolvedTransaction;
  const submitted = balanced
    ? transaction
    : {
        ...transaction,
        journal: {
          ...journal,
          postings: journal.postings.map((p, i) =>
            i === 0
              ? p
              : { ...p, bookValue: { ...p.bookValue, amount: ExactDecimal.of(-9900n, 2n) } },
          ),
        },
      };
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
    resolved: submitted,
  });
}

export function openItemRecognition(
  id: string,
  revision: bigint,
): BookCommand & RecognizeOpenItemCommand {
  const command = posting(id, revision);
  if (command.type !== "postJournal") throw new Error("Expected journal fixture");
  const journal = command.resolved.journal;
  const source = journal.postings[0];
  if (source === undefined) throw new Error("Expected control posting fixture");
  return sealCommand({
    ...command,
    type: "recognizeOpenItem",
    request: {
      value: {
        id: openItemId(id),
        bookId: BOOK,
        kind: "receivable",
        scope: { externalPartyId: "customer", controlAccountId: CASH },
        recognizedOn: journal.accountingDate,
        denominationCommodityId: USD,
        denomination: ExactRational.of(100n, 1n),
        bookValue: ExactRational.of(100n, 1n),
        recognitionSource: createCanonicalPostingReference(
          canonicalPostingReferenceId(id),
          BOOK,
          journal.id,
          source,
          effectKey(`${id}:journal:0`),
        ),
        derivation: {
          id: derivationId(id),
          policyId: POLICY.id,
          policyVersion: VERSION,
          state: "approved",
          recordedAt: command.issuedAt,
          algorithmVersion: VERSION,
          actorId: command.actorId,
          inputHash: hashCanonical({ invoice: id }),
          evidence: [
            {
              id: evidenceId(id),
              sourceSystem: "ledger-test",
              sourceRecordId: id,
              observedAt: journal.economicAt,
              contentHash: hashCanonical({ invoice: id }),
            },
          ],
        },
      },
    },
  });
}

export function settlementPayment(
  id: string,
  revision: bigint,
  allocations: readonly { readonly openItemId: OpenItemId; readonly amount: bigint }[],
): BookCommand & ApplySettlementCommand {
  const seed = openItemRecognition(id, revision);
  const amount = allocations.reduce((sum, item) => sum + item.amount, 0n);
  const journal = {
    ...seed.resolved.journal,
    postings: seed.resolved.journal.postings.map((posting, index) => {
      const signed = index === 0 ? -amount : amount;
      return {
        ...posting,
        units: { ...posting.units, canonicalNumber: ExactRational.of(signed, 1n) },
        bookValue: { ...posting.bookValue, amount: ExactDecimal.of(signed * 100n, 2n) },
      };
    }),
  };
  const payment = resolveJournal(
    journal,
    [POLICY],
    OWNER,
    QUANTIZATION,
    journal.postings.map((posting) => posting.bookValue.amount.toRational()),
  );
  if (!("journal" in payment)) throw new Error("Expected resolved payment fixture");
  const source = payment.journal.postings[0];
  if (source === undefined) throw new Error("Expected payment control posting");
  return sealCommand({
    ...seed,
    type: "applySettlement",
    id: commandId(id),
    expectedBookRevision: revision,
    issuedAt: seed.issuedAt,
    completedAt: seed.completedAt,
    committedAt: seed.committedAt,
    resolved: [payment],
    request: {
      settlement: {
        id: settlementId(id),
        bookId: BOOK,
        kind: "cash",
        scope: seed.request.value.scope,
        settlementSource: createCanonicalPostingReference(
          canonicalPostingReferenceId(id),
          BOOK,
          journal.id,
          source,
          effectKey(`${id}:journal:0`),
        ),
        settledAt: journal.economicAt,
        denominationCommodityId: USD,
        denomination: ExactRational.of(amount, 1n),
        bookValue: ExactRational.of(amount, 1n),
        derivation: seed.request.value.derivation,
      },
      allocations: allocations.map((item, index) => ({
        id: settlementAllocationId(`${id}-${index}`),
        settlementId: settlementId(id),
        openItemId: item.openItemId,
        allocatedBookValue: ExactRational.of(item.amount, 1n),
        allocatedOpenQuantity: ExactRational.of(item.amount, 1n),
        allocatedSettlementQuantity: ExactRational.of(item.amount, 1n),
        derivation: seed.request.value.derivation,
      })),
    },
  });
}

export function unallocatedPayment(
  id: string,
  revision: bigint,
  amount = 100n,
): BookCommand & ApplySettlementCommand {
  const seed = settlementPayment(id, revision, [
    { openItemId: openItemId("unallocated-placeholder"), amount },
  ]);
  return sealCommand({
    ...seed,
    request: {
      operation: "recognizeUnallocated",
      settlement: seed.request.settlement,
      allocations: [],
    },
  });
}

export function applyExistingPayment(
  payment: BookCommand & ApplySettlementCommand,
  id: string,
  revision: bigint,
  allocations: readonly { readonly openItemId: OpenItemId; readonly amount: bigint }[],
  at = "2026-01-21T14:00:00Z",
): BookCommand & ApplySettlementCommand {
  const seed = settlementPayment(id, revision, allocations);
  return sealCommand({
    ...seed,
    issuedAt: instant(at),
    completedAt: instant(at),
    committedAt: instant(at),
    resolved: [],
    request: {
      operation: "allocateExisting",
      appliedAt: instant(at),
      settlement: payment.request.settlement,
      allocations: seed.request.allocations.map((allocation) => ({
        ...allocation,
        settlementId: payment.request.settlement.id,
      })),
    },
  });
}

export function configuration(state: BookState, id = "configuration"): BookCommand {
  return sealCommand({
    id: commandId(id),
    type: "replaceConfiguration",
    protocolVersion: VERSION,
    bookId: BOOK,
    expectedBookRevision: state.bookRevision,
    expectedConfigurationRevision: state.configurationRevision,
    actorId: actorId("actor"),
    issuedAt: instant("2026-01-15T14:00:00Z"),
    completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"),
    effectiveOn: localDate("2026-01-16"),
    periods: state.periods,
    admissionSnapshot: state.admissionSnapshot,
    policies: state.policies,
    quantizationPolicies: state.quantizationPolicies,
    accountingPolicies: state.accountingPolicySnapshot.policies,
  });
}

export function closing(
  id: string,
  revision: bigint,
  withJournal = false,
): BookCommand & ClosePeriodCommand {
  const source = posting(`${id}-journal`, revision);
  if (source.type !== "postJournal") throw new Error("Expected posting fixture");
  return sealCommand({
    type: "closePeriod",
    id: commandId(id),
    bookId: BOOK,
    actorId: source.actorId,
    protocolVersion: VERSION,
    expectedBookRevision: revision,
    issuedAt: source.issuedAt,
    completedAt: source.completedAt,
    committedAt: source.committedAt,
    periodId: fiscalPeriodId("january"),
    closePackageId: closePackageId(id),
    reason: "Reviewed period",
    reportPopulationHash: hashCanonical({ report: id }),
    reportingPolicySnapshotHash: hashCanonical({ reportPolicy: "test" }),
    ...(withJournal
      ? {
          closing: {
            ...source.resolved,
            journal: { ...source.resolved.journal, kind: "closing" as const },
          },
        }
      : {}),
  });
}

export function reopening(
  id: string,
  revision: bigint,
  original?: BookedJournal,
): BookCommand & ReopenPeriodCommand {
  const source =
    original === undefined
      ? posting(id, revision)
      : correction(original, `${id}-journal`, revision);
  if (source.type !== "postJournal" && source.type !== "correctJournal")
    throw new Error("Expected journal fixture");
  return sealCommand({
    type: "reopenPeriod",
    id: commandId(id),
    bookId: BOOK,
    actorId: source.actorId,
    protocolVersion: VERSION,
    expectedBookRevision: revision,
    issuedAt: source.issuedAt,
    completedAt: source.completedAt,
    committedAt: source.committedAt,
    periodId: fiscalPeriodId("january"),
    reason: "Authorized correction window",
    ...(original === undefined ? {} : { reversal: source.resolved }),
  });
}

export function correction(original: BookedJournal, id = "correction", revision = 2n): BookCommand {
  const journal = {
    ...original.journal,
    id: journalId(id),
    kind: "reversing" as const,
    postings: original.journal.postings.map((p, index) => ({
      ...p,
      id: postingId(`${id}-${index}`),
      units: { ...p.units, canonicalNumber: p.units.canonicalNumber.negate() },
      bookValue: {
        ...p.bookValue,
        amount: ExactDecimal.of(-p.bookValue.amount.coefficient, p.bookValue.amount.scale),
      },
    })),
  };
  const resolved = resolveJournal(
    journal,
    [POLICY],
    OWNER,
    QUANTIZATION,
    journal.postings.map((p) => p.bookValue.amount.toRational()),
  );
  if (!("journal" in resolved)) throw new Error("Correction fixture must resolve");
  return sealCommand({
    id: commandId(id),
    type: "correctJournal",
    protocolVersion: VERSION,
    bookId: BOOK,
    expectedBookRevision: revision,
    actorId: actorId("actor"),
    originalJournalId: original.journal.id,
    correctionKind: "reversal",
    issuedAt: instant("2026-01-15T14:00:00Z"),
    completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"),
    resolved: {
      ...resolved,
      derivations: [
        {
          id: derivationId(`${id}-lineage`),
          policyId: POLICY.id,
          policyVersion: POLICY.version,
          algorithmVersion: VERSION,
          inputHash: hashCanonical({ original: original.journal.id }),
          actorId: actorId("actor"),
          state: "approved",
          recordedAt: instant("2026-01-15T13:00:00Z"),
          evidence: [
            {
              id: evidenceId(`${id}-evidence`),
              sourceSystem: "manual-review",
              sourceRecordId: original.journal.id,
              observedAt: instant("2026-01-15T12:00:00Z"),
              contentHash: original.canonicalHash,
            },
          ],
        },
      ],
    },
  });
}

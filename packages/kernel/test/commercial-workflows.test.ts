import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  accountId,
  allocationRecognitionId,
  allocationScheduleId,
  allocationScheduleRevisionId,
  commandId,
  closePackageId,
  commitBookIntent,
  evaluateBookCommand,
  validateBookEffectTopology,
  createBookProtocolState,
  createBookState,
  derivationId,
  evidenceId,
  executeBookCommand,
  evaluateCurrentBookCommand,
  accountingEffectExists,
  canonicalPostingSourceIdentity,
  settlementReadContext,
  resolveCanonicalPosting,
  type CurrentBookContext,
  fiscalPeriodId,
  hashCanonical,
  instant,
  journalId,
  localDate,
  openItemId,
  policyId,
  postingId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  settlementAllocationId,
  settlementId,
  type AccountId,
  type AllocationPolicy,
  type AtomicBookCommit,
  type BookCommand,
  type BookState,
  type FiscalPeriod,
  type JournalTransaction,
  type QuantizationPolicy,
  type ResolvedTransaction,
} from "../src/index.ts";
import { decodeDurableBook, encodeDurableBook } from "../src/codec.ts";
import { IDS, identity, policy, postingReference, quantizationPolicy } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { capability } from "./accounting-fixtures.ts";

const acct = (name: string): AccountId => accountId(`workflow-${name}`);
const A = Object.freeze({
  cash: acct("cash"),
  ar: acct("ar"),
  revenue: acct("revenue"),
  fee: acct("payment-fee-expense"),
  discount: acct("sales-discount"),
  deposit: acct("customer-deposit-liability"),
  machinery: acct("machinery-asset"),
  deprecExp: acct("depreciation-expense"),
  accumDeprec: acct("accumulated-depreciation"),
  disposalClearing: acct("asset-disposal-clearing"),
  gain: acct("gain-on-disposal"),
  loss: acct("loss-on-disposal"),
  ap: acct("ap"),
});

const workflowAccounts = Object.freeze([
  Object.freeze({ id: A.cash, bookId: IDS.book, code: "1010", name: "Cash", role: "asset" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.ar, bookId: IDS.book, code: "1200", name: "Accounts Receivable", role: "asset" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.revenue, bookId: IDS.book, code: "4000", name: "Revenue", role: "income" as const, normalSide: "credit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.fee, bookId: IDS.book, code: "6100", name: "Payment Processing Fees", role: "expense" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.discount, bookId: IDS.book, code: "4100", name: "Sales Discounts", role: "income" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.deposit, bookId: IDS.book, code: "2100", name: "Customer Deposits", role: "liability" as const, normalSide: "credit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.machinery, bookId: IDS.book, code: "1500", name: "Machinery", role: "asset" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.deprecExp, bookId: IDS.book, code: "6200", name: "Depreciation Expense", role: "expense" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.accumDeprec, bookId: IDS.book, code: "1590", name: "Accumulated Depreciation", role: "asset" as const, normalSide: "credit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.disposalClearing, bookId: IDS.book, code: "1599", name: "Asset Disposal Clearing", role: "asset" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.gain, bookId: IDS.book, code: "4900", name: "Gain on Disposal", role: "income" as const, normalSide: "credit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.loss, bookId: IDS.book, code: "6900", name: "Loss on Disposal", role: "expense" as const, normalSide: "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
  Object.freeze({ id: A.ap, bookId: IDS.book, code: "2000", name: "Accounts Payable", role: "liability" as const, normalSide: "credit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }),
]);

const evidence = Object.freeze({
  id: evidenceId("workflow-evidence"),
  sourceSystem: "commercial-test",
  sourceRecordId: "doc-1",
  observedAt: instant("2026-01-01T00:00:00Z"),
  contentHash: hashCanonical({ workflow: "commercial" }),
});

const derivation = Object.freeze({
  id: derivationId("workflow-derivation"),
  policyId: policy.id,
  policyVersion: policy.version,
  algorithmVersion: semanticVersion("1.0.0"),
  inputHash: hashCanonical({ derivation: "commercial-workflows" }),
  actorId: IDS.actor,
  state: "approved" as const,
  recordedAt: instant("2026-01-01T00:00:00Z"),
  evidence: Object.freeze([evidence]),
});

const bookQuantizationPolicy: QuantizationPolicy = Object.freeze({
  ...quantizationPolicy,
  roundingAccountId: A.cash,
});

const deprecPolicy: AllocationPolicy = Object.freeze({
  id: policyId("workflow-allocation-deprec"),
  version: semanticVersion("1.0.0"),
  bookId: IDS.book,
  validFrom: instant("2020-01-01T00:00:00Z"),
  algorithmVersion: semanticVersion("1.0.0"),
  quantizationPolicy: bookQuantizationPolicy,
  capability: capability("allocationSchedule", "straightLine"),
  kind: "allocationSchedule",
  method: "straightLine",
  frequency: "monthly",
  convention: "fullPeriod",
  allocationAccountId: A.deprecExp,
  contraAccountId: A.accumDeprec,
});

const disposalPolicy: AllocationPolicy = Object.freeze({
  id: policyId("workflow-allocation-disposal"),
  version: semanticVersion("1.0.0"),
  bookId: IDS.book,
  validFrom: instant("2020-01-01T00:00:00Z"),
  algorithmVersion: semanticVersion("1.0.0"),
  quantizationPolicy: bookQuantizationPolicy,
  capability: capability("allocationSchedule", "straightLine"),
  kind: "allocationSchedule",
  method: "straightLine",
  frequency: "monthly",
  convention: "fullPeriod",
  allocationAccountId: A.disposalClearing,
  contraAccountId: A.accumDeprec,
});

const calendarPeriods: readonly FiscalPeriod[] = Object.freeze(
  Array.from({ length: 12 }, (_, i) => {
    const month = (i + 1).toString().padStart(2, "0");
    const lastDay = i === 1 ? "28" : [3, 5, 8, 10].includes(i) ? "30" : "31";
    return Object.freeze({
      id: fiscalPeriodId(`period-2026-${month}`),
      calendarId: IDS.calendar,
      fiscalYear: 2026n,
      sequence: BigInt(i + 1),
      label: `2026-${month}`,
      kind: "regular" as const,
      startsOn: localDate(`2026-${month}-01`),
      endsOn: localDate(`2026-${month}-${lastDay}`),
    });
  }),
);

function createWorkflowBook(customPeriods: readonly FiscalPeriod[] = calendarPeriods): { state: BookState; protocol: ReturnType<typeof createBookProtocolState> } {
  const state = createBookState(
    identity,
    customPeriods,
    Object.freeze({
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      accounts: workflowAccounts,
      dimensions: Object.freeze([]),
      dimensionMembers: Object.freeze([]),
      requiredDimensionIds: Object.freeze([]),
    }),
    [policy],
    [bookQuantizationPolicy],
    [deprecPolicy, disposalPolicy],
    instant("2020-01-01T00:00:00Z"),
  );
  return { state, protocol: createBookProtocolState() };
}

function times(at = "2026-01-15T14:00:00Z") {
  const ms = Date.parse(at);
  return {
    issuedAt: instant(at),
    completedAt: instant(new Date(ms + 1_000).toISOString()),
    committedAt: instant(new Date(ms + 2_000).toISOString()),
  };
}

function coreCmd(state: BookState, id: string, at?: string) {
  return {
    id: commandId(id),
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision: state.bookRevision,
    ...times(at),
    actorId: IDS.actor,
  };
}

function run(current: AtomicBookCommit, command: BookCommand): AtomicBookCommit {
  const next = executeBookCommand(current.state, current.protocol, command);
  expect(next.result.disposition, `${command.type}:${next.result.diagnostics[0]?.message ?? ""}`).toBe("committed");
  if (command.type === "createAllocationSchedule" || command.type === "recognizeScheduledAllocation" || command.type === "reviseAllocationSchedule" || command.type === "recognizeOpenItem" || command.type === "applySettlement") {
    const { state, protocol } = current;
    const activation = state.revisions.flatMap((revision) => revision.effects).find((effect) => effect.type === "activation");
    expect(state.accountingState.remeasurementResults).toHaveLength(0);
    expect(state.inventoryOwnershipEffects ?? []).toHaveLength(0);
    const financialSourceOwner: NonNullable<CurrentBookContext["openItemFacts"]>["financialSourceOwner"] = (source) =>
      [...state.accountingState.openItems.map((item) => item.recognitionSource), ...state.accountingState.settlements.map((item) => item.settlementSource)]
        .some((item) => item !== undefined && canonicalPostingSourceIdentity(item) === canonicalPostingSourceIdentity(source)) ? "present" : "absent";
    const context: CurrentBookContext = {
      header: { identity: state.identity, financialIdentityHash: state.financialIdentityHash, status: state.status,
        bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
        configurationRevision: state.configurationRevision, configurationHash: state.configurationHash },
      configuration: state.activeConfigurationSnapshot, opening: state.openingBoundary ?? null,
      activationIdentity: activation?.financialIdentityHash ?? null, previousRevision: state.revisions.at(-1) ?? null,
      retainedCommand: (id) => protocol.retainedResults.find((item) => item.commandId === id) ?? null,
      journalIdentity: (id) => state.journals.some((item) => item.journal.id === id) ? "present" : "absent",
      postingIdentity: (id) => state.journals.some((item) => item.journal.postings.some((posting) => posting.id === id)) ? "present" : "absent",
      readPostingIdentities: (ids) => new Map(ids.map((id) => [id, state.journals.some((item) => item.journal.postings.some((posting) => posting.id === id)) ? "present" : "absent"])),
      periodStatus: (id) => state.periodTransitions.filter((item) => item.periodId === id).at(-1)?.kind === "close" ? "closed" : "open",
      overdueRemeasurement: () => null, managedMoneyScope: () => "unmanaged",
      settlementFacts: { settlement: settlementReadContext(state.accountingState), financialSourceOwner,
        sourceJournals: () => state.journals, sourceRemeasurement: () => "none" },
      openItemFacts: {
        openItemIdentity: (id) => state.accountingState.openItems.some((item) => item.id === id) ? "present" : "absent",
        sourceJournals: () => state.journals,
        financialSourceOwner,
      },
      allocationFacts: { accountingState: state.accountingState,
        accountingIdentity: (effect) => accountingEffectExists(state.accountingState, effect) ? "present" : "absent",
        resolveSource: (reference) => resolveCanonicalPosting(state, [], reference) },
    };
    const actual = evaluateCurrentBookCommand(context, command);
    expect(actual.result).toEqual(next.result);
    expect(actual.effects).toEqual(next.intent?.effects);
    expect(actual.revision).toEqual(next.state.revisions.at(-1));
    if (command.type === "applySettlement") {
      const { settlementFacts, ...missing } = context;
      expect(() => evaluateCurrentBookCommand(missing, command)).toThrow("Missing current settlement evidence");
      expect(() => evaluateCurrentBookCommand({ ...context, settlementFacts: { ...settlementFacts!, financialSourceOwner: () => undefined as never } }, command)).toThrow("Incomplete financial source ownership evidence");
      expect(() => evaluateCurrentBookCommand({ ...context, settlementFacts: { ...settlementFacts!, sourceRemeasurement: () => undefined as never } }, command)).toThrow("Incomplete source remeasurement evidence");
      expect(evaluateCurrentBookCommand({ ...context, settlementFacts: { ...settlementFacts!, financialSourceOwner: () => "present" } }, command).result.disposition).toBe("rejected");
      if (command.resolved.length === 1) {
        const original = command.resolved[0]!.journal;
        for (const duplicate of [false, true]) {
          const additional = resolveJournalWithPolicy({ ...original, id: journalId(`${command.id}-additional`),
            postings: original.postings.map((posting, index) => ({ ...posting,
              id: duplicate ? posting.id : postingId(`${command.id}-additional-${index}`) })) });
          const candidate = sealCommand({ ...command, resolved: [...command.resolved, additional] });
          const expected = executeBookCommand(state, protocol, candidate);
          const actual = evaluateCurrentBookCommand(context, candidate);
          expect(expected.result.disposition).toBe(duplicate ? "rejected" : "committed");
          expect(actual.result).toEqual(expected.result);
          expect(actual.effects).toEqual(expected.intent?.effects);
        }
      }
    } else if (command.type === "recognizeOpenItem") {
      const { openItemFacts, ...missing } = context;
      expect(() => evaluateCurrentBookCommand(missing, command)).toThrow("Missing current open-item source evidence");
      expect(() => evaluateCurrentBookCommand({ ...context, openItemFacts: { ...openItemFacts!, financialSourceOwner: () => undefined as never } }, command)).toThrow("Incomplete financial source ownership evidence");
      expect(evaluateCurrentBookCommand({ ...context, openItemFacts: { ...openItemFacts!, openItemIdentity: () => "present" } }, command).result.disposition).toBe("rejected");
    } else {
      const { allocationFacts, ...missing } = context;
      expect(() => evaluateCurrentBookCommand(missing, command)).toThrow("Missing current allocation lifecycle evidence");
      expect(evaluateCurrentBookCommand({ ...context, allocationFacts: { ...allocationFacts!, accountingIdentity: () => "present" } }, command).result.disposition).toBe("rejected");
    }
    if (actual.journal !== undefined)
      expect(evaluateCurrentBookCommand({ ...context, managedMoneyScope: () => "managed" }, command).result.diagnostics[0]?.code).toBe("inventory_cost_policy_incoherent");
  }
  return next;
}

function resolveJournalWithPolicy(j: JournalTransaction): ResolvedTransaction {
  const result = resolveJournal(
    j,
    [policy],
    IDS.owner,
    bookQuantizationPolicy,
    j.postings.map((p) => p.bookValue.amount.toRational()),
  );
  if (Array.isArray(result)) throw new Error(result.map((d) => d.message).join("; "));
  return result as ResolvedTransaction;
}

function verifyDurableRoundTripAndReplay(finalCommit: AtomicBookCommit, initialFreshState: BookState) {
  // 1. Serialization round-trip verification: encode & decode
  const encoded = encodeDurableBook({ state: finalCommit.state, protocol: finalCommit.protocol });
  const decoded = decodeDurableBook(encoded);
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(decoded.aggregate.state.bookRevision).toBe(finalCommit.state.bookRevision);
  expect(decoded.aggregate.state.latestPostingSequence).toBe(finalCommit.state.latestPostingSequence);
  expect(decoded.aggregate.state.contentHash.digest).toEqual(finalCommit.state.contentHash.digest);

  // 2. Full deterministic replay from genesis initialFreshState
  let replayCommit: AtomicBookCommit | undefined;
  for (const rev of finalCommit.state.revisions) {
    if (replayCommit === undefined) {
      replayCommit = executeBookCommand(initialFreshState, createBookProtocolState(), rev.command);
    } else {
      replayCommit = executeBookCommand(replayCommit.state, replayCommit.protocol, rev.command);
    }
    expect(replayCommit.result.disposition).toBe("committed");
  }
  if (!replayCommit) throw new Error("Expected at least one revision to replay");
  expect(replayCommit.state.bookRevision).toBe(finalCommit.state.bookRevision);
  expect(replayCommit.state.latestPostingSequence).toBe(finalCommit.state.latestPostingSequence);
  expect(replayCommit.state.contentHash.digest).toEqual(finalCommit.state.contentHash.digest);
}

function verifyRejectionPersistenceAndReplay(rejectCommit: AtomicBookCommit, rejectedCommand: BookCommand) {
  // 1. Persist the post-rejection aggregate (verifying encode/decode round-trip preserves protocol.retainedResults)
  const encoded = encodeDurableBook({ state: rejectCommit.state, protocol: rejectCommit.protocol });
  const decoded = decodeDurableBook(encoded);
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);

  // 2. Verify that the retained rejection outcome exists in the restored protocol state
  expect(
    decoded.aggregate.protocol.retainedResults.some(
      (r) => r.commandId === rejectedCommand.id && r.outcome === "rejected",
    ),
  ).toBeTrue();

  // 3. Retry the rejected command against the restored state & protocol
  const retried = executeBookCommand(decoded.aggregate.state, decoded.aggregate.protocol, rejectedCommand);
  expect(retried.result.disposition).toBe("replayed");
  expect(retried.result.diagnostics).toEqual(rejectCommit.result.diagnostics);
  expect(retried.state.bookRevision).toBe(rejectCommit.state.bookRevision);
  expect(retried.state.contentHash.digest).toEqual(rejectCommit.state.contentHash.digest);
}

describe("commercial accounting workflows", () => {
  test("workflow 1: payment fee splitting lifecycle (Dr Cash $971, Dr Fees $29, Cr Receivables $1,000)", () => {
    const { state: initialState, protocol } = createWorkflowBook();
    let current = executeBookCommand(initialState, protocol, activationCommand("wf1-activate"));

    // Step 1: Issue Invoice ($1,000) -> Dr AR $1,000, Cr Revenue $1,000
    const invoiceJournal: JournalTransaction = Object.freeze({
      id: journalId("wf1-invoice-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-10T10:00:00Z"),
      accountingDate: localDate("2026-01-10"),
      recordedAt: instant("2026-01-10T10:00:00Z"),
      narration: "Invoice #1001 for professional services",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf1-inv-ar"),
          ordinal: 1n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(1000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(100_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf1-inv-rev"),
          ordinal: 2n,
          accountId: A.revenue,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-1000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-100_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const invoiceOpenSource = postingReference(invoiceJournal, "wf1-open-command:journal:0", 1n);
    const invoiceOpenItem = {
      id: openItemId("wf1-receivable-item"),
      bookId: IDS.book,
      kind: "receivable" as const,
      scope: { externalPartyId: "CLIENT-CORP", controlAccountId: A.ar },
      recognitionSource: invoiceOpenSource,
      recognizedOn: localDate("2026-01-10"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(1000n, 1n),
      bookValue: ExactRational.of(1000n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf1-open-command", "2026-01-10T11:00:00Z"),
      type: "recognizeOpenItem" as const,
      request: { value: invoiceOpenItem },
      resolved: resolveJournalWithPolicy(invoiceJournal),
    }));

    // Step 2: Payment Receipt with Fee Deduction ($971 cash, $29 fee, $1,000 AR settled)
    const paymentJournal: JournalTransaction = Object.freeze({
      id: journalId("wf1-payment-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-15T14:00:00Z"),
      accountingDate: localDate("2026-01-15"),
      recordedAt: instant("2026-01-15T14:00:00Z"),
      narration: "Online payment receipt for Invoice #1001 less processor fees",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf1-pay-cash"),
          ordinal: 1n,
          accountId: A.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(971n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(97_100n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf1-pay-fee"),
          ordinal: 2n,
          accountId: A.fee,
          units: Object.freeze({ canonicalNumber: ExactRational.of(29n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(2_900n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf1-pay-ar"),
          ordinal: 3n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-1000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-100_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const settlementSource = postingReference(paymentJournal, "wf1-settlement-command:journal:0", 3n);
    const paymentSettlement = {
      id: settlementId("wf1-payment-settlement"),
      bookId: IDS.book,
      kind: "cash" as const,
      scope: invoiceOpenItem.scope,
      settlementSource,
      settledAt: instant("2026-01-15T14:00:00Z"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(1000n, 1n),
      bookValue: ExactRational.of(1000n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf1-settlement-command", "2026-01-15T15:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: paymentSettlement,
        allocations: [{
          id: settlementAllocationId("wf1-settlement-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: paymentSettlement.id,
          allocatedBookValue: ExactRational.of(1000n, 1n),
          allocatedOpenQuantity: ExactRational.of(1000n, 1n),
          allocatedSettlementQuantity: ExactRational.of(1000n, 1n),
          derivation,
        }],
      },
      resolved: [resolveJournalWithPolicy(paymentJournal)],
    }));

    // Verify balances in current state
    const postings = current.state.journals.flatMap((j) => j.journal.postings);
    const accountBalances = new Map<AccountId, ExactRational>();
    for (const p of postings) {
      const prior = accountBalances.get(p.accountId) ?? ExactRational.zero();
      accountBalances.set(p.accountId, prior.add(p.bookValue.amount.toRational()));
    }
    expect(accountBalances.get(A.cash)?.equals(ExactRational.of(971n, 1n))).toBeTrue();
    expect(accountBalances.get(A.fee)?.equals(ExactRational.of(29n, 1n))).toBeTrue();
    expect(accountBalances.get(A.ar)?.isZero()).toBeTrue();
    expect(accountBalances.get(A.revenue)?.equals(ExactRational.of(-1000n, 1n))).toBeTrue();

    // Step 3: Rejection Atomicity — Attempting to over-settle the closed open item
    const preRejectRevision = current.state.bookRevision;
    const preRejectSequence = current.state.latestPostingSequence;
    const overSettleCmd = sealCommand({
      ...coreCmd(current.state, "wf1-over-settle-command", "2026-01-16T10:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: { ...paymentSettlement, id: settlementId("wf1-extra-settlement") },
        allocations: [{
          id: settlementAllocationId("wf1-extra-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: settlementId("wf1-extra-settlement"),
          allocatedBookValue: ExactRational.of(50n, 1n),
          allocatedOpenQuantity: ExactRational.of(50n, 1n),
          allocatedSettlementQuantity: ExactRational.of(50n, 1n),
          derivation,
        }],
      },
      resolved: [resolveJournalWithPolicy(paymentJournal)],
    });
    const rejectResult = executeBookCommand(current.state, current.protocol, overSettleCmd);
    expect(rejectResult.result.disposition).toBe("rejected");
    expect(rejectResult.result.diagnostics[0]?.code).toBe("settlement_allocation_violation");
    // State and revisions must be completely unmodified in the returned state
    expect(rejectResult.state.bookRevision).toBe(preRejectRevision);
    expect(rejectResult.state.latestPostingSequence).toBe(preRejectSequence);
    expect(rejectResult.state.contentHash.digest).toEqual(current.state.contentHash.digest);
    expect(rejectResult.protocol.retainedResults.some((r) => r.commandId === overSettleCmd.id && r.outcome === "rejected")).toBeTrue();
    verifyRejectionPersistenceAndReplay(rejectResult, overSettleCmd);

    // Step 4: Deterministic Replay
    verifyDurableRoundTripAndReplay(current, initialState);
  });

  test("workflow 2: early payment cash discounts (2/10 net 30 lifecycle)", () => {
    const { state: initialState, protocol } = createWorkflowBook();
    let current = executeBookCommand(initialState, protocol, activationCommand("wf2-activate"));

    // Step 1: Issue Invoice for $1,000 on terms 2/10 net 30
    const invoiceJournal: JournalTransaction = Object.freeze({
      id: journalId("wf2-invoice-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-05T09:00:00Z"),
      accountingDate: localDate("2026-01-05"),
      recordedAt: instant("2026-01-05T09:00:00Z"),
      narration: "Invoice #1002 terms 2/10 net 30",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf2-inv-ar"),
          ordinal: 1n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(1000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(100_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf2-inv-rev"),
          ordinal: 2n,
          accountId: A.revenue,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-1000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-100_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const openSource = postingReference(invoiceJournal, "wf2-open-command:journal:0", 1n);
    const invoiceOpenItem = {
      id: openItemId("wf2-receivable-item"),
      bookId: IDS.book,
      kind: "receivable" as const,
      scope: { externalPartyId: "DISCOUNT-BUYER", controlAccountId: A.ar },
      recognitionSource: openSource,
      recognizedOn: localDate("2026-01-05"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(1000n, 1n),
      bookValue: ExactRational.of(1000n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf2-open-command", "2026-01-05T10:00:00Z"),
      type: "recognizeOpenItem" as const,
      request: { value: invoiceOpenItem },
      resolved: resolveJournalWithPolicy(invoiceJournal),
    }));

    // Step 2: Customer pays within 10 days, taking $20 discount and paying $980 cash
    // Journal: Dr Cash $980, Dr Sales Discounts $20, Cr AR $1,000
    const receiptWithDiscountJournal: JournalTransaction = Object.freeze({
      id: journalId("wf2-discount-receipt-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-12T11:00:00Z"),
      accountingDate: localDate("2026-01-12"),
      recordedAt: instant("2026-01-12T11:00:00Z"),
      narration: "Payment for Invoice #1002 taking 2% early cash discount",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf2-disc-cash"),
          ordinal: 1n,
          accountId: A.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(980n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(98_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf2-disc-discount"),
          ordinal: 2n,
          accountId: A.discount,
          units: Object.freeze({ canonicalNumber: ExactRational.of(20n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(2_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf2-disc-ar"),
          ordinal: 3n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-1000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-100_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const discountSettlementSource = postingReference(receiptWithDiscountJournal, "wf2-discount-settlement:journal:0", 3n);
    const discountSettlement = {
      id: settlementId("wf2-discount-settlement-record"),
      bookId: IDS.book,
      kind: "cash" as const,
      scope: invoiceOpenItem.scope,
      settlementSource: discountSettlementSource,
      settledAt: instant("2026-01-12T11:00:00Z"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(1000n, 1n),
      bookValue: ExactRational.of(1000n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf2-discount-settlement", "2026-01-12T12:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: discountSettlement,
        allocations: [{
          id: settlementAllocationId("wf2-discount-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: discountSettlement.id,
          allocatedBookValue: ExactRational.of(1000n, 1n),
          allocatedOpenQuantity: ExactRational.of(1000n, 1n),
          allocatedSettlementQuantity: ExactRational.of(1000n, 1n),
          derivation,
        }],
      },
      resolved: [resolveJournalWithPolicy(receiptWithDiscountJournal)],
    }));

    // Verify balances
    const postings = current.state.journals.flatMap((j) => j.journal.postings);
    const balances = new Map<AccountId, ExactRational>();
    for (const p of postings) {
      balances.set(p.accountId, (balances.get(p.accountId) ?? ExactRational.zero()).add(p.bookValue.amount.toRational()));
    }
    expect(balances.get(A.cash)?.equals(ExactRational.of(980n, 1n))).toBeTrue();
    expect(balances.get(A.discount)?.equals(ExactRational.of(20n, 1n))).toBeTrue();
    expect(balances.get(A.ar)?.isZero()).toBeTrue();
    expect(balances.get(A.revenue)?.equals(ExactRational.of(-1000n, 1n))).toBeTrue();

    // Step 3: Rejection Atomicity
    const overAllocCmd = sealCommand({
      ...coreCmd(current.state, "wf2-over-alloc-cmd", "2026-01-13T10:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: { ...discountSettlement, id: settlementId("wf2-extra-settlement") },
        allocations: [{
          id: settlementAllocationId("wf2-extra-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: settlementId("wf2-extra-settlement"),
          allocatedBookValue: ExactRational.of(1n, 1n),
          allocatedOpenQuantity: ExactRational.of(1n, 1n),
          allocatedSettlementQuantity: ExactRational.of(1n, 1n),
          derivation,
        }],
      },
      resolved: [resolveJournalWithPolicy(receiptWithDiscountJournal)],
    });
    const revBefore = current.state.bookRevision;
    const overAllocResult = executeBookCommand(current.state, current.protocol, overAllocCmd);
    expect(overAllocResult.result.disposition).toBe("rejected");
    expect(overAllocResult.state.bookRevision).toBe(revBefore);
    expect(overAllocResult.state.contentHash.digest).toEqual(current.state.contentHash.digest);
    expect(overAllocResult.protocol.retainedResults.some((r) => r.commandId === overAllocCmd.id && r.outcome === "rejected")).toBeTrue();
    verifyRejectionPersistenceAndReplay(overAllocResult, overAllocCmd);

    // Step 4: Deterministic Replay
    verifyDurableRoundTripAndReplay(current, initialState);
  });

  test("workflow 3: customer deposits / unearned revenue lifecycle", () => {
    const { state: initialState, protocol } = createWorkflowBook();
    let current = executeBookCommand(initialState, protocol, activationCommand("wf3-activate"));

    // Step 1: Receive customer advance deposit of $500 -> Dr Cash $500, Cr Customer Deposits $500
    const depositJournal: JournalTransaction = Object.freeze({
      id: journalId("wf3-deposit-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-02T10:00:00Z"),
      accountingDate: localDate("2026-01-02"),
      recordedAt: instant("2026-01-02T10:00:00Z"),
      narration: "Advance deposit received for future order",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf3-dep-cash"),
          ordinal: 1n,
          accountId: A.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(500n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(50_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf3-dep-liability"),
          ordinal: 2n,
          accountId: A.deposit,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-500n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-50_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const depositSource = postingReference(depositJournal, "wf3-dep-open-cmd:journal:0", 2n);
    const depositOpenItem = {
      id: openItemId("wf3-deposit-payable-item"),
      bookId: IDS.book,
      kind: "payable" as const,
      scope: { externalPartyId: "RETAINER-CLIENT", controlAccountId: A.deposit },
      recognitionSource: depositSource,
      recognizedOn: localDate("2026-01-02"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(500n, 1n),
      bookValue: ExactRational.of(500n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf3-dep-open-cmd", "2026-01-02T11:00:00Z"),
      type: "recognizeOpenItem" as const,
      request: { value: depositOpenItem },
      resolved: resolveJournalWithPolicy(depositJournal),
    }));

    // Step 2: Render services and issue invoice for $800 -> Dr AR $800, Cr Revenue $800
    const invoiceJournal: JournalTransaction = Object.freeze({
      id: journalId("wf3-invoice-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-20T10:00:00Z"),
      accountingDate: localDate("2026-01-20"),
      recordedAt: instant("2026-01-20T10:00:00Z"),
      narration: "Invoice #1003 for completed services",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf3-inv-ar"),
          ordinal: 1n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(800n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(80_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf3-inv-rev"),
          ordinal: 2n,
          accountId: A.revenue,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-800n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-80_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const invoiceSource = postingReference(invoiceJournal, "wf3-inv-open-cmd:journal:0", 1n);
    const invoiceOpenItem = {
      id: openItemId("wf3-invoice-receivable-item"),
      bookId: IDS.book,
      kind: "receivable" as const,
      scope: { externalPartyId: "RETAINER-CLIENT", controlAccountId: A.ar },
      recognitionSource: invoiceSource,
      recognizedOn: localDate("2026-01-20"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(800n, 1n),
      bookValue: ExactRational.of(800n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf3-inv-open-cmd", "2026-01-20T11:00:00Z"),
      type: "recognizeOpenItem" as const,
      request: { value: invoiceOpenItem },
      resolved: resolveJournalWithPolicy(invoiceJournal),
    }));

    // Step 3: Apply the $500 deposit against the $800 invoice
    // Journal: Dr Customer Deposits $500, Cr Accounts Receivable $500
    const applyDepositJournal: JournalTransaction = Object.freeze({
      id: journalId("wf3-apply-deposit-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-20T12:00:00Z"),
      accountingDate: localDate("2026-01-20"),
      recordedAt: instant("2026-01-20T12:00:00Z"),
      narration: "Application of $500 advance deposit to Invoice #1003",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf3-apply-dep-debit"),
          ordinal: 1n,
          accountId: A.deposit,
          units: Object.freeze({ canonicalNumber: ExactRational.of(500n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(50_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf3-apply-ar-credit"),
          ordinal: 2n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-500n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-50_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    // Settle both sides:
    // Side A: Settle deposit payable open item using the Dr Customer Deposits posting
    const depositSettlement = {
      id: settlementId("wf3-deposit-offset-settlement"),
      bookId: IDS.book,
      kind: "creditApplication" as const,
      scope: depositOpenItem.scope,
      settlementSource: postingReference(applyDepositJournal, "wf3-apply-deposit-cmd:journal:0", 1n),
      settledAt: instant("2026-01-20T12:00:00Z"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(500n, 1n),
      bookValue: ExactRational.of(500n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf3-apply-deposit-cmd", "2026-01-20T13:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: depositSettlement,
        allocations: [{
          id: settlementAllocationId("wf3-deposit-offset-edge"),
          openItemId: depositOpenItem.id,
          settlementId: depositSettlement.id,
          allocatedBookValue: ExactRational.of(500n, 1n),
          allocatedOpenQuantity: ExactRational.of(500n, 1n),
          allocatedSettlementQuantity: ExactRational.of(500n, 1n),
          derivation,
        }],
      },
      resolved: [resolveJournalWithPolicy(applyDepositJournal)],
    }));

    // Side B: Settle the invoice receivable open item partially ($500 allocated of $800)
    const invoicePartialSettlement = {
      id: settlementId("wf3-invoice-partial-settlement"),
      bookId: IDS.book,
      kind: "creditApplication" as const,
      scope: invoiceOpenItem.scope,
      settlementSource: postingReference(applyDepositJournal, "wf3-apply-deposit-cmd:journal:0", 2n),
      settledAt: instant("2026-01-20T12:00:00Z"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(500n, 1n),
      bookValue: ExactRational.of(500n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf3-apply-inv-settlement-cmd", "2026-01-20T14:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: invoicePartialSettlement,
        allocations: [{
          id: settlementAllocationId("wf3-invoice-deposit-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: invoicePartialSettlement.id,
          allocatedBookValue: ExactRational.of(500n, 1n),
          allocatedOpenQuantity: ExactRational.of(500n, 1n),
          allocatedSettlementQuantity: ExactRational.of(500n, 1n),
          derivation,
        }],
      },
      resolved: [], // applyDepositJournal was already posted in previous step
    }));

    // Step 4: Customer pays remaining $300 balance in cash
    // Journal: Dr Cash $300, Cr AR $300
    const finalPaymentJournal: JournalTransaction = Object.freeze({
      id: journalId("wf3-final-payment-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-28T10:00:00Z"),
      accountingDate: localDate("2026-01-28"),
      recordedAt: instant("2026-01-28T10:00:00Z"),
      narration: "Final cash payment for remaining Invoice #1003 balance",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf3-fin-cash"),
          ordinal: 1n,
          accountId: A.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(300n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(30_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf3-fin-ar"),
          ordinal: 2n,
          accountId: A.ar,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-300n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-30_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    const finalSettlement = {
      id: settlementId("wf3-final-cash-settlement"),
      bookId: IDS.book,
      kind: "cash" as const,
      scope: invoiceOpenItem.scope,
      settlementSource: postingReference(finalPaymentJournal, "wf3-final-pay-cmd:journal:0", 2n),
      settledAt: instant("2026-01-28T10:00:00Z"),
      denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(300n, 1n),
      bookValue: ExactRational.of(300n, 1n),
      derivation,
    };

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf3-final-pay-cmd", "2026-01-28T11:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: finalSettlement,
        allocations: [{
          id: settlementAllocationId("wf3-final-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: finalSettlement.id,
          allocatedBookValue: ExactRational.of(300n, 1n),
          allocatedOpenQuantity: ExactRational.of(300n, 1n),
          allocatedSettlementQuantity: ExactRational.of(300n, 1n),
          derivation,
        }],
      },
      resolved: [resolveJournalWithPolicy(finalPaymentJournal)],
    }));

    // Verify final balances across all accounts
    const postings = current.state.journals.flatMap((j) => j.journal.postings);
    const balances = new Map<AccountId, ExactRational>();
    for (const p of postings) {
      balances.set(p.accountId, (balances.get(p.accountId) ?? ExactRational.zero()).add(p.bookValue.amount.toRational()));
    }
    // Net cash: 500 (deposit) + 300 (final) = 800
    expect(balances.get(A.cash)?.equals(ExactRational.of(800n, 1n))).toBeTrue();
    // Revenue: 800
    expect(balances.get(A.revenue)?.equals(ExactRational.of(-800n, 1n))).toBeTrue();
    // Deposit liability: 500 - 500 = 0
    expect(balances.get(A.deposit)?.isZero()).toBeTrue();
    // AR: 800 - 500 - 300 = 0
    expect(balances.get(A.ar)?.isZero()).toBeTrue();

    // Step 5: Rejection Atomicity — Extra settlement on closed invoice open item
    const extraAllocCmd = sealCommand({
      ...coreCmd(current.state, "wf3-extra-alloc-cmd", "2026-01-29T10:00:00Z"),
      type: "applySettlement" as const,
      request: {
        settlement: { ...finalSettlement, id: settlementId("wf3-invalid-settlement") },
        allocations: [{
          id: settlementAllocationId("wf3-invalid-edge"),
          openItemId: invoiceOpenItem.id,
          settlementId: settlementId("wf3-invalid-settlement"),
          allocatedBookValue: ExactRational.of(10n, 1n),
          allocatedOpenQuantity: ExactRational.of(10n, 1n),
          allocatedSettlementQuantity: ExactRational.of(10n, 1n),
          derivation,
        }],
      },
      resolved: [],
    });
    const revPre = current.state.bookRevision;
    const extraAllocResult = executeBookCommand(current.state, current.protocol, extraAllocCmd);
    expect(extraAllocResult.result.disposition).toBe("rejected");
    expect(extraAllocResult.state.bookRevision).toBe(revPre);
    expect(extraAllocResult.state.contentHash.digest).toEqual(current.state.contentHash.digest);
    expect(extraAllocResult.protocol.retainedResults.some((r) => r.commandId === extraAllocCmd.id && r.outcome === "rejected")).toBeTrue();
    verifyRejectionPersistenceAndReplay(extraAllocResult, extraAllocCmd);

    // Step 6: Deterministic Round-Trip and Replay
    verifyDurableRoundTripAndReplay(current, initialState);
  });

  test("ACC-044.6: atomic allocated-asset disposal, gain/loss, full depreciation, rejection and replay", () => {
    const { state: initialState, protocol } = createWorkflowBook();
    let current = executeBookCommand(initialState, protocol, activationCommand("wf4-activate"));

    // Step 1: Acquire Machinery for $12,000 on 2026-01-01 -> Dr Machinery $12,000, Cr Cash $12,000
    const acquisitionJournal: JournalTransaction = Object.freeze({
      id: journalId("wf4-acquisition-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-01T10:00:00Z"),
      accountingDate: localDate("2026-01-01"),
      recordedAt: instant("2026-01-01T10:00:00Z"),
      narration: "Acquisition of manufacturing machinery",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf4-acq-asset"),
          ordinal: 1n,
          accountId: A.machinery,
          units: Object.freeze({ canonicalNumber: ExactRational.of(12_000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(1_200_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf4-acq-cash"),
          ordinal: 2n,
          accountId: A.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-12_000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-1_200_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-acq-cmd", "2026-01-01T11:00:00Z"),
      type: "postJournal" as const,
      resolved: resolveJournalWithPolicy(acquisitionJournal),
    }));

    // Step 2: Create 12-month straight-line depreciation schedule ($1,000/month, residual 0)
    const scheduleId = allocationScheduleId("wf4-machinery-deprec-schedule");
    const sourceRef = postingReference(acquisitionJournal, "wf4-acq-cmd:journal:0", 1n);
    const scheduleDerivation = Object.freeze({ ...derivation, policyId: deprecPolicy.id, policyVersion: deprecPolicy.version });

    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-create-schedule-cmd", "2026-01-01T12:00:00Z"),
      type: "createAllocationSchedule" as const,
      request: {
        id: scheduleId,
        policyId: deprecPolicy.id,
        policyVersion: deprecPolicy.version,
        governedAt: instant("2026-01-01T12:00:00Z"),
        source: sourceRef,
        sourceBasis: ExactRational.of(12_000n, 1n),
        residualValue: ExactRational.zero(),
        startsOn: localDate("2026-01-01"),
        endsOn: localDate("2026-12-31"),
        derivation: scheduleDerivation,
      },
    }));

    // Step 3: Recognize Month 1 depreciation (January 2026) -> Dr Deprec Exp $1,000, Cr Accum Deprec $1,000
    const rec1Id = allocationRecognitionId("wf4-rec-m1");
    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-rec-m1-cmd", "2026-01-31T15:00:00Z"),
      type: "recognizeScheduledAllocation" as const,
      request: {
        id: rec1Id,
        scheduleId,
        ordinal: 1n,
        governedAt: instant("2026-01-31T15:00:00Z"),
        derivation: scheduleDerivation,
      },
    }));

    for (const kind of ["estimateChange", "impairment"] as const) {
      const id = `wf4-missing-prior-${kind}`;
      const command = sealCommand({ ...coreCmd(current.state, id, "2026-03-01T10:00:00Z"), type: "reviseAllocationSchedule" as const, request: {
        id: allocationScheduleRevisionId(id), kind, effectiveOn: localDate("2026-03-01"), policyEffectiveAt: instant("2026-03-01T10:00:00Z"), originalScheduleId: scheduleId, priorRecognitionIds: [rec1Id], policyId: deprecPolicy.id, policyVersion: deprecPolicy.version, revisedResidualValue: ExactRational.zero(), successorScheduleId: allocationScheduleId(`${id}-successor`), revisedEndsOn: localDate("2026-12-31"), ...(kind === "impairment" ? { exactAdjustmentAmount: ExactRational.of(-100n, 1n), generatedEffectKey: `${id}:journal:0` as never } : {}), evidence: scheduleDerivation.evidence, derivation: scheduleDerivation,
      } });
      const rejected = executeBookCommand(current.state, current.protocol, command);
      expect(rejected.result.disposition).toBe("rejected");
      expect(rejected.result.diagnostics[0]?.path).toBe("command.scheduleRevision.priorRecognitionIds");
      expect(rejected.state.contentHash).toEqual(current.state.contentHash);
      verifyRejectionPersistenceAndReplay(rejected, command);
    }

    // Step 4: Recognize Month 2 depreciation (February 2026) -> Dr Deprec Exp $1,000, Cr Accum Deprec $1,000
    const rec2Id = allocationRecognitionId("wf4-rec-m2");
    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-rec-m2-cmd", "2026-02-28T15:00:00Z"),
      type: "recognizeScheduledAllocation" as const,
      request: {
        id: rec2Id,
        scheduleId,
        ordinal: 2n,
        governedAt: instant("2026-02-28T15:00:00Z"),
        derivation: scheduleDerivation,
      },
    }));

    // Step 5: Prospective revision of schedule on 2026-03-01
    const successorScheduleId = allocationScheduleId("wf4-successor-schedule");
    const revisionId = allocationScheduleRevisionId("wf4-revision-m3");
    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-revise-schedule-cmd", "2026-03-01T10:00:00Z"),
      type: "reviseAllocationSchedule" as const,
      request: {
        id: revisionId,
        kind: "estimateChange" as const,
        effectiveOn: localDate("2026-03-01"),
        policyEffectiveAt: instant("2026-03-01T10:00:00Z"),
        originalScheduleId: scheduleId,
        priorRecognitionIds: [rec1Id, rec2Id],
        policyId: deprecPolicy.id,
        policyVersion: deprecPolicy.version,
        revisedResidualValue: ExactRational.zero(),
        successorScheduleId,
        revisedEndsOn: localDate("2026-12-31"),
        evidence: scheduleDerivation.evidence,
        derivation: scheduleDerivation,
      },
    }));

    // Recognize Month 3 from the revised successor schedule
    const rec3Id = allocationRecognitionId("wf4-rec-m3");
    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-rec-m3-cmd", "2026-03-31T15:00:00Z"),
      type: "recognizeScheduledAllocation" as const,
      request: {
        id: rec3Id,
        scheduleId: successorScheduleId,
        ordinal: 1n,
        governedAt: instant("2026-03-31T15:00:00Z"),
        derivation: scheduleDerivation,
      },
    }));

    // The schedule's terminal revision and both journals are one atomic operation.
    const termDerivation = Object.freeze({
      ...derivation, policyId: disposalPolicy.id, policyVersion: disposalPolicy.version,
    });
    const termRevisionId = allocationScheduleRevisionId("wf4-term-revision");
    const disposalRequest = {
      id: termRevisionId,
      kind: "disposal" as const,
      effectiveOn: localDate("2026-03-31"),
      policyEffectiveAt: instant("2026-03-31T17:00:00Z"),
      originalScheduleId: successorScheduleId,
      priorRecognitionIds: [rec3Id],
      policyId: disposalPolicy.id,
      policyVersion: disposalPolicy.version,
      revisedResidualValue: ExactRational.zero(),
      exactAdjustmentAmount: ExactRational.of(-9000n, 1n),
      generatedEffectKey: "wf4-disp-cmd:journal:0" as never,
      evidence: termDerivation.evidence,
      derivation: termDerivation,
    };

    // 6b: Disposal derecognition journal:
    // Derecognize Machinery ($12,000 credit)
    // Derecognize Accumulated Depreciation ($12,000 debit: $3,000 prior + $9,000 termination adjustment)
    // Clear Asset Disposal Clearing ($9,000 credit, clearing the suspense account)
    // Record Cash received ($9,500 debit)
    // Record Gain on Disposal ($500 credit)
    const disposalJournal: JournalTransaction = Object.freeze({
      id: journalId("wf4-disposal-journal"),
      kind: "ordinary",
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant("2026-03-31T16:00:00Z"),
      accountingDate: localDate("2026-03-31"),
      recordedAt: instant("2026-03-31T16:00:00Z"),
      narration: "Sale and derecognition of manufacturing machinery with gain",
      postings: Object.freeze([
        Object.freeze({
          id: postingId("wf4-disp-cash"),
          ordinal: 1n,
          accountId: A.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(9500n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(950_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf4-disp-accum-deprec"),
          ordinal: 2n,
          accountId: A.accumDeprec,
          units: Object.freeze({ canonicalNumber: ExactRational.of(12000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(1_200_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf4-disp-asset-cost"),
          ordinal: 3n,
          accountId: A.machinery,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-12000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-1_200_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf4-disp-clearing"),
          ordinal: 4n,
          accountId: A.disposalClearing,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-9000n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-900_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId("wf4-disp-gain"),
          ordinal: 5n,
          accountId: A.gain,
          units: Object.freeze({ canonicalNumber: ExactRational.of(-500n, 1n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-50_000n, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });

    // Guard Check: Stale disposal command must reject without mutating state,
    // and its rejection diagnostics must be durably verifiable.
    const staleDisposalCmd = sealCommand({
      ...coreCmd(current.state, "wf4-stale-disp-cmd", "2026-03-31T16:30:00Z"),
      expectedBookRevision: current.state.bookRevision - 1n,
      type: "reviseAllocationSchedule" as const,
      request: disposalRequest,
      disposalJournal: resolveJournalWithPolicy(disposalJournal),
    });
    const revPreStale = current.state.bookRevision;
    const staleResult = executeBookCommand(current.state, current.protocol, staleDisposalCmd);
    expect(staleResult.result.disposition).toBe("rejected");
    expect(staleResult.state.bookRevision).toBe(revPreStale);
    expect(staleResult.state.contentHash.digest).toEqual(current.state.contentHash.digest);
    verifyRejectionPersistenceAndReplay(staleResult, staleDisposalCmd);

    const disposalCommand = (id: string, completion = resolveJournalWithPolicy(disposalJournal), request = disposalRequest) => sealCommand({
      ...coreCmd(current.state, id, "2026-03-31T17:00:00Z"),
      type: "reviseAllocationSchedule" as const,
      request: { ...request, generatedEffectKey: `${id}:journal:0` as never },
      disposalJournal: completion,
    });
    const assertDisposalRejected = (command: BookCommand) => {
      const rejected = executeBookCommand(current.state, current.protocol, command);
      expect(rejected.result.disposition).toBe("rejected");
      expect(rejected.state).toBe(current.state);
      expect(rejected.state.accountingState.allocationScheduleRevisions.some((revision) => revision.id === termRevisionId)).toBeFalse();
      verifyRejectionPersistenceAndReplay(rejected, command);
    };
    assertDisposalRejected(disposalCommand("bad-disposal-kind", undefined, { ...disposalRequest, kind: "termination" as never }));
    const resolvedDisposal = resolveJournalWithPolicy(disposalJournal);
    assertDisposalRejected(disposalCommand("bad-disposal-date", {
      ...resolvedDisposal, journal: { ...disposalJournal, accountingDate: localDate("2026-04-01") },
    }));
    for (const variant of ["missing-clearing", "wrong-value", "wrong-units", "wrong-commodity", "duplicate-id", "unbalanced", "unknown-account"] as const) {
      const journal: JournalTransaction = {
        ...disposalJournal,
        id: variant === "duplicate-id" ? journalId(`${termRevisionId}-journal`) : disposalJournal.id,
        postings: disposalJournal.postings.map((posting, index) => {
          if (index === 3) {
            if (variant === "missing-clearing") return { ...posting, accountId: A.loss };
            if (variant === "wrong-value") return { ...posting, bookValue: { ...posting.bookValue, amount: ExactDecimal.of(-899_900n, 2n) } };
            if (variant === "wrong-units") return { ...posting, units: { ...posting.units, canonicalNumber: ExactRational.of(-8999n, 1n) } };
            if (variant === "wrong-commodity") return { ...posting, units: { ...posting.units, commodityId: "EUR" as never } };
          }
          if (index === 0 && variant === "unbalanced") return { ...posting, bookValue: { ...posting.bookValue, amount: ExactDecimal.of(950_001n, 2n) } };
          if (index === 0 && variant === "unknown-account") return { ...posting, accountId: accountId("unconfigured-proceeds-account") };
          return posting;
        }),
      };
      assertDisposalRejected(disposalCommand(`bad-disposal-${variant}`, { ...resolvedDisposal, journal }));
    }

    // A competing period close invalidates the WHOLE disposal, not only its second half.
    const preview = evaluateBookCommand(current.state, current.protocol, disposalCommand("racing-disposal"));
    expect(preview.disposition).toBe("ready");
    const closed = executeBookCommand(current.state, current.protocol, sealCommand({
      ...coreCmd(current.state, "close-before-disposal", "2026-04-01T10:00:00Z"),
      type: "closePeriod" as const, periodId: fiscalPeriodId("period-2026-03"),
      closePackageId: closePackageId("close-before-disposal"), reason: "Close wins the race",
      reportPopulationHash: hashCanonical({ reports: "disposal-race" }),
      reportingPolicySnapshotHash: hashCanonical({ policy: "disposal-race" }),
    }));
    expect(closed.result.disposition).toBe("committed");
    if (preview.disposition !== "ready") throw new Error("Expected disposal intent");
    expect(validateBookEffectTopology(current.state, { ...preview.intent, effects: preview.intent.effects.slice(0, -1) }).length).toBeGreaterThan(0);
    const substituted = { ...preview.intent, command: disposalCommand("racing-disposal", {
      ...resolvedDisposal, journal: { ...disposalJournal, narration: "Different disposal content" },
    }) };
    expect(validateBookEffectTopology(current.state, substituted).length).toBeGreaterThan(0);
    const lostRace = commitBookIntent(closed.state, closed.protocol, preview.intent);
    expect(lostRace.result.disposition).toBe("rejected");
    expect(lostRace.state).toBe(closed.state);
    expect(lostRace.state.accountingState.allocationScheduleRevisions.some((revision) => revision.id === termRevisionId)).toBeFalse();
    const closedDisposal = executeBookCommand(closed.state, closed.protocol, sealCommand({
      ...disposalCommand("closed-disposal"), ...times("2026-04-01T10:01:00Z"), expectedBookRevision: closed.state.bookRevision,
    }));
    expect(closedDisposal.result.disposition).toBe("rejected");
    expect(closedDisposal.result.diagnostics.some((item) => item.code === "fiscal_period_admission")).toBeTrue();
    expect(closedDisposal.state).toBe(closed.state);

    // Gain, break-even, loss, and zero-proceeds disposal all conserve book value.
    for (const proceeds of [9500n, 9000n, 8500n, 0n]) {
      const completion: JournalTransaction = { ...disposalJournal, postings: disposalJournal.postings.map((posting, index) => {
        const amount = index === 0 ? proceeds : index === 4 ? 9000n - proceeds : undefined;
        return amount === undefined ? posting : { ...posting,
          accountId: index === 4 && proceeds < 9000n ? A.loss : posting.accountId,
          units: { ...posting.units, canonicalNumber: ExactRational.of(amount, 1n) },
          bookValue: { ...posting.bookValue, amount: ExactDecimal.of(amount * 100n, 2n) },
        };
      }).filter((posting) => !posting.bookValue.amount.toRational().isZero()) };
      const branch = run(current, disposalCommand(`disposal-proceeds-${proceeds}`, resolveJournalWithPolicy(completion)));
      expect(branch.state.bookRevision).toBe(current.state.bookRevision + 1n);
      verifyDurableRoundTripAndReplay(branch, initialState);
    }

    // A fully depreciated asset still has gross cost/contra balances to derecognize.
    const lateDisposal = run(current, sealCommand({
      ...disposalCommand("late-disposal", resolveJournalWithPolicy({ ...disposalJournal,
        accountingDate: localDate("2026-05-31"), economicAt: instant("2026-05-31T16:00:00Z"), recordedAt: instant("2026-05-31T16:00:00Z"),
      }), { ...disposalRequest, effectiveOn: localDate("2026-05-31"), policyEffectiveAt: instant("2026-05-31T17:00:00Z") }),
      ...times("2026-05-31T17:00:00Z"),
    }));
    const backdatedRecognition = executeBookCommand(lateDisposal.state, lateDisposal.protocol, sealCommand({
      ...coreCmd(lateDisposal.state, "backdated-after-disposal", "2026-06-01T10:00:00Z"), type: "recognizeScheduledAllocation" as const,
      request: { id: allocationRecognitionId("backdated-after-disposal"), scheduleId: successorScheduleId, ordinal: 2n,
        governedAt: instant("2026-06-01T10:00:00Z"), derivation: scheduleDerivation },
    }));
    expect(backdatedRecognition.result.disposition).toBe("rejected");
    expect(backdatedRecognition.result.diagnostics[0]?.code).toBe("allocation_schedule_violation");
    expect(backdatedRecognition.state).toBe(lateDisposal.state);

    // Fully depreciated disposal needs no zero-valued adjustment journal.
    let fullyAllocated = current;
    const successor = current.state.accountingState.allocationSchedules.find((item) => item.id === successorScheduleId)!;
    for (const installment of successor.installments.slice(1)) {
      const at = `${installment.accountingDate}T15:00:00Z`;
      fullyAllocated = run(fullyAllocated, sealCommand({
        ...coreCmd(fullyAllocated.state, `fully-allocated-${installment.ordinal}`, at), type: "recognizeScheduledAllocation" as const,
        request: { id: allocationRecognitionId(`fully-allocated-${installment.ordinal}`), scheduleId: successorScheduleId,
          ordinal: installment.ordinal, governedAt: instant(at), derivation: scheduleDerivation },
      }));
    }
    const fullyAllocatedJournal: JournalTransaction = { ...disposalJournal,
      accountingDate: localDate("2026-12-31"), economicAt: instant("2026-12-31T16:00:00Z"), recordedAt: instant("2026-12-31T16:00:00Z"),
      postings: disposalJournal.postings.filter((posting) => posting.accountId !== A.disposalClearing).map((posting) => posting.accountId !== A.cash ? posting : {
        ...posting, units: { ...posting.units, canonicalNumber: ExactRational.of(500n, 1n) },
        bookValue: { ...posting.bookValue, amount: ExactDecimal.of(50_000n, 2n) },
      }),
    };
    const { exactAdjustmentAmount: _adjustment, generatedEffectKey: _effectKey, ...zeroCarryingRequest } = disposalRequest;
    const fullyDisposed = run(fullyAllocated, sealCommand({
      ...coreCmd(fullyAllocated.state, "fully-depreciated-disposal", "2026-12-31T17:00:00Z"), type: "reviseAllocationSchedule" as const,
      request: { ...zeroCarryingRequest,
        effectiveOn: localDate("2026-12-31"), policyEffectiveAt: instant("2026-12-31T17:00:00Z"),
        priorRecognitionIds: fullyAllocated.state.accountingState.allocationRecognitions.filter((item) => item.scheduleId === successorScheduleId).map((item) => item.id),
      }, disposalJournal: resolveJournalWithPolicy(fullyAllocatedJournal),
    }));
    expect(fullyDisposed.state.latestPostingSequence).toBe(fullyAllocated.state.latestPostingSequence + 1n);
    verifyDurableRoundTripAndReplay(fullyDisposed, initialState);

    const beforeDisposal = current;
    current = run(current, sealCommand({
      ...coreCmd(current.state, "wf4-disp-cmd", "2026-03-31T17:00:00Z"),
      type: "reviseAllocationSchedule" as const,
      request: disposalRequest,
      disposalJournal: resolveJournalWithPolicy(disposalJournal),
    }));
    expect(current.state.bookRevision).toBe(beforeDisposal.state.bookRevision + 1n);
    expect(current.state.latestPostingSequence).toBe(beforeDisposal.state.latestPostingSequence + 2n);
    expect(current.state.journals.slice(-2).every((booked) => booked.bookRevision === current.state.bookRevision)).toBeTrue();
    const repeated = executeBookCommand(current.state, current.protocol, current.state.revisions.at(-1)!.command);
    expect(repeated.result.disposition).toBe("replayed");
    expect(repeated.state).toBe(current.state);

    // Verify final balances across all asset lifecycle accounts
    const postings = current.state.journals.flatMap((j) => j.journal.postings);
    const balances = new Map<AccountId, ExactRational>();
    for (const p of postings) {
      balances.set(p.accountId, (balances.get(p.accountId) ?? ExactRational.zero()).add(p.bookValue.amount.toRational()));
    }
    // Asset cost cleared to zero: 12000 - 12000 = 0
    expect(balances.get(A.machinery)?.isZero()).toBeTrue();
    // Accumulated depreciation cleared to zero: -1000 - 1000 - 1000 - 9000 + 12000 = 0
    expect(balances.get(A.accumDeprec)?.isZero()).toBeTrue();
    // Disposal clearing cleared to zero: 9000 - 9000 = 0
    expect(balances.get(A.disposalClearing)?.isZero()).toBeTrue();
    // Total cash net outflow: -12000 + 9500 = -2500
    expect(balances.get(A.cash)?.equals(ExactRational.of(-2500n, 1n))).toBeTrue();
    // Depreciation expense remains strictly $3,000 (1000 + 1000 + 1000)
    expect(balances.get(A.deprecExp)?.equals(ExactRational.of(3000n, 1n))).toBeTrue();
    // Gain on disposal: 500 credit
    expect(balances.get(A.gain)?.equals(ExactRational.of(-500n, 1n))).toBeTrue();

    // Step 7: Rejection Atomicity
    // 7a: Attempting recognition on the terminated successor schedule must reject
    const invalidRecCmd = sealCommand({
      ...coreCmd(current.state, "wf4-invalid-rec-cmd", "2026-04-30T10:00:00Z"),
      type: "recognizeScheduledAllocation" as const,
      request: {
        id: allocationRecognitionId("wf4-invalid-rec"),
        scheduleId: successorScheduleId,
        ordinal: 2n,
        governedAt: instant("2026-04-30T10:00:00Z"),
        derivation: scheduleDerivation,
      },
    });
    const revPre = current.state.bookRevision;
    const invalidRecResult = executeBookCommand(current.state, current.protocol, invalidRecCmd);
    expect(invalidRecResult.result.disposition).toBe("rejected");
    expect(invalidRecResult.result.diagnostics.some((d) => d.code === "allocation_schedule_violation")).toBeTrue();
    expect(invalidRecResult.state.bookRevision).toBe(revPre);
    expect(invalidRecResult.state.contentHash.digest).toEqual(current.state.contentHash.digest);
    expect(invalidRecResult.protocol.retainedResults.some((r) => r.commandId === invalidRecCmd.id && r.outcome === "rejected")).toBeTrue();
    verifyRejectionPersistenceAndReplay(invalidRecResult, invalidRecCmd);

    // 7b: Attempting duplicate recognition on the old schedule must also reject
    const duplicateRecCmd = sealCommand({
      ...coreCmd(current.state, "wf4-dup-rec-cmd", "2026-04-01T10:00:00Z"),
      type: "recognizeScheduledAllocation" as const,
      request: {
        id: allocationRecognitionId("wf4-dup-rec"),
        scheduleId,
        ordinal: 1n,
        governedAt: instant("2026-04-01T10:00:00Z"),
        derivation: scheduleDerivation,
      },
    });
    const dupRecResult = executeBookCommand(current.state, current.protocol, duplicateRecCmd);
    expect(dupRecResult.result.disposition).toBe("rejected");
    expect(dupRecResult.state.bookRevision).toBe(revPre);
    expect(dupRecResult.state.contentHash.digest).toEqual(current.state.contentHash.digest);
    expect(dupRecResult.protocol.retainedResults.some((r) => r.commandId === duplicateRecCmd.id && r.outcome === "rejected")).toBeTrue();
    verifyRejectionPersistenceAndReplay(dupRecResult, duplicateRecCmd);

    // Step 8: Deterministic Round-Trip and Replay
    verifyDurableRoundTripAndReplay(current, initialState);
  });
});

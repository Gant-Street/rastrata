import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  ExactDecimal,
  allocationScheduleId,
  applyAccountingEffect,
  applySettlement,
  calculateInventoryRecosting,
  compileConsolidation,
  canonicalJournalValue,
  createAccountingReadSnapshot,
  createBookState,
  createAllocationSchedule,
  createProvisionalInventoryLayerEffect,
  emptyAccountingCanonicalState,
  hashCanonical,
  instant,
  inventoryRecostingId,
  localDate,
  openItemId,
  policyId,
  postingId,
  projectAccountingBasis,
  provisionalInventoryLayerId,
  recognizeOpenItem,
  semanticVersion,
  settlementAllocationId,
  settlementId,
  type AccountingBasisPolicy,
  type AllocationPolicy,
  type ConsolidationSource,
  type BookState,
  type JournalTransaction,
} from "../src/index.ts";
import { IDS, identity, periods, policy, postingReference, quantizationPolicy, resolved } from "./fixtures.ts";
import {
  account,
  accountingDerivation,
  accountingOne as one,
  basisRule,
  capability,
  consolidationMapping,
} from "./accounting-fixtures.ts";
import {
  consolidationPolicy,
  directPath,
  request as consolidationRequest,
  source as consolidationSource,
} from "./consolidation-boundary-fixtures.ts";

const tenThousand = ExactRational.of(10_000n, 1n);

describe("accounting command resource bounds", () => {
  test("admits exactly the recosting-source limit", () => {
    const derivation = Object.freeze({ ...accountingDerivation, policyId: policyId("recost-policy") });
    const layer = createProvisionalInventoryLayerEffect({
      id: provisionalInventoryLayerId("RECOST-LIMIT-LAYER"), bookId: IDS.book, policyId: derivation.policyId,
      issuePostingId: postingId("RECOST-LIMIT-ISSUE"), openedAt: instant("2026-01-01T00:00:00Z"),
      quantity: tenThousand, provisionalBasis: tenThousand, derivation,
    });
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), layer);
    const sources = Array.from({ length: 10_000 }, (_, index) => Object.freeze({ receiptId: `receipt-${index}`, quantity: one, totalBasis: one }));
    expect(calculateInventoryRecosting(state, { id: inventoryRecostingId("RECOST-AT-LIMIT"), layerId: layer.value.id, resolvedAt: instant("2026-01-31T00:00:00Z"), sources, derivation }).disposition).toBe("draft");
  });

  test("admits exactly the settlement-allocation limit", () => {
    const scope = Object.freeze({ externalPartyId: "BOUNDARY-PARTY", controlAccountId: account("BOUNDARY-AR") });
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: {
      id: openItemId("OPEN-AT-LIMIT"), bookId: IDS.book, kind: "receivable", scope,
      recognitionPostingId: postingId("OPEN-AT-LIMIT-POSTING"), recognizedOn: localDate("2026-01-01"),
      denominationCommodityId: IDS.usd, denomination: tenThousand, bookValue: tenThousand, derivation: accountingDerivation,
    } });
    expect(opened.disposition).toBe("draft");
    if (opened.disposition !== "draft") return;
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    const settlement = Object.freeze({
      id: settlementId("SETTLEMENT-AT-LIMIT"), bookId: IDS.book, kind: "cash" as const, scope,
      settlementPostingId: postingId("SETTLEMENT-AT-LIMIT-POSTING"), settledAt: instant("2026-01-31T00:00:00Z"),
      denominationCommodityId: IDS.usd, denomination: tenThousand, bookValue: tenThousand, derivation: accountingDerivation,
    });
    const allocations = Array.from({ length: 10_000 }, (_, index) => Object.freeze({
      id: settlementAllocationId(`allocation-${index}`), openItemId: openItemId("OPEN-AT-LIMIT"), settlementId: settlement.id,
      allocatedBookValue: one, allocatedOpenQuantity: one, allocatedSettlementQuantity: one, derivation: accountingDerivation,
    }));
    expect(applySettlement(state, { settlement, allocations }).disposition).toBe("draft");
  });

  test("admits exactly the accounting-basis event limit", () => {
    const basis: AccountingBasisPolicy = Object.freeze({
      id: policyId("BASIS-AT-LIMIT"), version: semanticVersion("1.0.0"), bookId: IDS.book,
      validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy,
      capability: capability("accountingBasis", "accrual"), kind: "accountingBasis", basis: "accrual",
      rules: Object.freeze([basisRule("BASIS-LIMIT-RULE", "recognition", "carryThrough")]),
    });
    const sourcePostings = Array.from({ length: 10_000 }, (_, index) => Object.freeze({
      id: postingId(`basis-${index}`), ordinal: BigInt(index + 1), accountId: IDS.cash,
      units: Object.freeze({ canonicalNumber: one, commodityId: IDS.usd }),
      bookValue: Object.freeze({ amount: ExactDecimal.of(100n, 2n), functionalCommodityId: IDS.usd }),
      dimensionMemberIds: Object.freeze([]),
    }));
    const offset = Object.freeze({ id: postingId("basis-limit-offset"), ordinal: 10_001n, accountId: IDS.revenue, units: Object.freeze({ canonicalNumber: ExactRational.of(-10_000n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-1_000_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) });
    const transaction = Object.freeze({ id: "basis-limit-journal" as never, kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd, economicAt: instant("2026-01-01T00:00:00Z"), accountingDate: localDate("2026-01-01"), recordedAt: instant("2026-01-01T00:00:00Z"), narration: "Basis event limit", postings: Object.freeze([...sourcePostings, offset]) }) as JournalTransaction;
    const effectKey = "basis-limit:journal:0";
    const base = createBookState(identity, periods, { bookId: IDS.book, functionalCommodityId: IDS.usd, accounts: [{ id: IDS.cash, bookId: IDS.book, code: "1000", name: "Cash", role: "asset", normalSide: "debit", postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: [] }, { id: IDS.revenue, bookId: IDS.book, code: "4000", name: "Revenue", role: "income", normalSide: "credit", postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: [] }], dimensions: [], dimensionMembers: [], requiredDimensionIds: [] }, [policy], [quantizationPolicy], [basis], instant("2020-01-01T00:00:00Z"));
    const resolvedTransaction = resolved(transaction);
    const booked = Object.freeze({ journal: transaction, commandId: "basis-limit-command" as never, effectKey, bookRevision: 0n, postingSequence: 1n, fiscalPeriodId: periods[0]!.id, policySnapshotHash: resolvedTransaction.policySnapshotHash, quantizationPolicySnapshotHash: resolvedTransaction.quantizationPolicySnapshotHash, canonicalHash: hashCanonical(canonicalJournalValue(transaction)), derivations: Object.freeze([]) });
    const state = Object.freeze({ ...base, journals: Object.freeze([booked]), latestPostingSequence: 1n }) as BookState;
    const events = sourcePostings.map((posting, index) => Object.freeze({ id: `basis-${index}`, event: "recognition" as const, accountingDate: transaction.accountingDate, source: postingReference(transaction, effectKey, BigInt(index + 1)), sourcePosting: posting }));
    const snapshot = createAccountingReadSnapshot(state, instant("2026-01-01T00:00:00Z"), events.map((event) => event.source), events);
    expect(projectAccountingBasis([basis], basis.id, basis.version, snapshot).disposition).toBe("projected");
  }, 30_000); // Exact 10,000-event boundary; allow shared-CPU validation runs.

  test("admits exactly the usage-event limit", () => {
    const usagePolicy: AllocationPolicy = Object.freeze({
      id: policyId("USAGE-AT-LIMIT"), version: semanticVersion("1.0.0"), bookId: IDS.book,
      validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy,
      capability: capability("allocationSchedule", "unitsOfProduction"), kind: "allocationSchedule", method: "unitsOfProduction",
      frequency: "eventDriven", convention: "usageEvent", expectedUsage: ExactRational.of(1_200n, 1n),
      allocationAccountId: account("USAGE-EXPENSE"), contraAccountId: account("USAGE-CONTRA"),
    });
    const usage = Array.from({ length: 1_200 }, (_, index) => {
      const year = 2026 + Math.floor(index / 12); const month = index % 12 + 1;
      return Object.freeze({ date: localDate(`${year}-${month.toString().padStart(2, "0")}-01`), value: one });
    });
    const result = createAllocationSchedule([usagePolicy], IDS.book, {
      id: allocationScheduleId("USAGE-SCHEDULE-AT-LIMIT"), policyId: usagePolicy.id, policyVersion: usagePolicy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("USAGE-SOURCE-AT-LIMIT"),
      sourceBasis: ExactRational.of(1_200n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2125-12-01"), usage, derivation: accountingDerivation,
    });
    expect(result.disposition).toBe("draft");
    if (result.disposition === "draft" && result.draft.effects[0]?.type === "allocationSchedule") expect(result.draft.effects[0].value.installments).toHaveLength(1_200);
  });

  test("admits exactly the consolidation-source and elimination limits", () => {
    const policy = consolidationPolicy();
    const sources = Array.from({ length: 1_000 }, (_, index) => {
      const populationHash = hashCanonical({ source: index.toString() });
      return consolidationSource([directPath(`source-path-${index}`)], {
        bookId: `source-book-${index}` as never, relationshipId: `relationship-${index}`,
        populationHash, expectedPopulationHash: populationHash,
      });
    });
    expect(compileConsolidation([policy], IDS.usd, { ...consolidationRequest(policy, sources[0]!), id: "SOURCES-AT-LIMIT" as never, sources }).disposition).toBe("draft");

    const baseRequest = consolidationRequest(policy, consolidationSource([directPath("elimination-path")]), "ELIMINATIONS-AT-LIMIT");
    const eliminations = Array.from({ length: 10_000 }, (_, index) => Object.freeze({
      id: `elimination-${index}`, sourceBookId: baseRequest.sources[0]!.bookId,
      sourceAccountId: account(`ELIMINATION-SOURCE-${index}`), targetAccountId: account(`ELIMINATION-TARGET-${index}`),
      amount: index % 2 === 0 ? one : one.negate(), evidenceIds: Object.freeze([`elimination-evidence-${index}`]),
      sourcePostingIds: Object.freeze([postingId(`elimination-source-posting-${index}`)]),
    }));
    expect(compileConsolidation([policy], IDS.usd, { ...baseRequest, eliminations }).disposition).toBe("draft");
  });

  test("admits exactly the per-source consolidation-balance limit", () => {
    const mappings = Array.from({ length: 10_000 }, (_, index) => consolidationMapping(`BALANCE-MAPPING-${index}`, `BALANCE-SOURCE-${index}`, `BALANCE-TARGET-${index}`));
    const policy = consolidationPolicy({ accountMappings: Object.freeze(mappings) });
    const populationHash = hashCanonical({ source: "balance-limit" });
    const balances = Array.from({ length: 10_000 }, (_, index) => Object.freeze({
      sourceAccountId: account(`BALANCE-SOURCE-${index}`), unitsCommodityId: IDS.usd,
      classification: (index % 2 === 0 ? "asset" : "equity") as "asset" | "equity",
      amount: index % 2 === 0 ? one : one.negate(), valuationPaths: Object.freeze([]),
    }));
    const source: ConsolidationSource = Object.freeze({
      ...consolidationSource([]), populationHash, expectedPopulationHash: populationHash, balances: Object.freeze(balances),
    });
    expect(compileConsolidation([policy], IDS.usd, consolidationRequest(policy, source, "BALANCES-AT-LIMIT")).disposition).toBe("draft");
  });
});

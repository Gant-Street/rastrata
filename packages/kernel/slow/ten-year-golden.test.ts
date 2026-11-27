import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  createBookProtocolState,
  createBookState,
  decodeDurableBook,
  encodeDurableBook,
  validateBookState,
  executeBookCommand,
  hashBookState,
  identifier,
  instant,
  journalId,
  localDate,
  postingId,
  consolidationCompilationId,
  sealCommand,
  semanticVersion,
  type BookProtocolState,
  type BookState,
  type FiscalPeriod,
  type JournalTransaction,
  type AccountingPolicy,
} from "../src/index.ts";
import { capability, consolidationMapping, consolidationValuationPolicy, policyId, pool, taxComponent, translationRule } from "../test/accounting-fixtures.ts";
import { hashCanonical } from "../src/canonical.ts";
import { IDS, identity, policy, postingReference, quantizationPolicy, resolved } from "../test/fixtures.ts";
import { activationCommand } from "../test/protocol-fixtures.ts";
import { account, accountingDerivation } from "../test/accounting-fixtures.ts";

const YEARS = 10;
const MONTHS_PER_YEAR = 12;

function buildFiscalPeriods(): FiscalPeriod[] {
  const allPeriods: FiscalPeriod[] = [];
  for (let year = 0; year < YEARS; year += 1) {
    for (let month = 0; month < MONTHS_PER_YEAR; month += 1) {
      const monthNumber = month + 1;
      const yearNumber = 2026 + year;
      const lastDay = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
      allPeriods.push(Object.freeze({
        id: identifier<"FiscalPeriod">(`golden-${yearNumber}-${String(monthNumber).padStart(2, "0")}`),
        calendarId: IDS.calendar,
        fiscalYear: BigInt(yearNumber),
        sequence: BigInt(year * MONTHS_PER_YEAR + month + 1),
        label: `${yearNumber}-${String(monthNumber).padStart(2, "0")}`,
        kind: "regular" as const,
        startsOn: localDate(`${yearNumber}-${String(monthNumber).padStart(2, "0")}-01`),
        endsOn: localDate(`${yearNumber}-${String(monthNumber).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`),
      }));
    }
  }
  return allPeriods;
}

function goldenAccountingPolicies(): AccountingPolicy[] {
  const tax: AccountingPolicy = Object.freeze({
    id: policyId("golden-tax"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("taxDetermination", "compound"),
    kind: "taxDetermination" as const, taxCode: "VAT", jurisdiction: "TEST", roundingLevel: "lineLevel" as const,
    components: Object.freeze([taxComponent("GOLDEN-TAX", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("TAX-PAYABLE"), recoverableAccountId: account("INPUT-TAX") })]),
  });
  const inventory: AccountingPolicy = Object.freeze({
    id: policyId("golden-inventory"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("inventoryCost", "fifo"),
    kind: "inventoryCost" as const, method: "fifo" as const, pools: Object.freeze([pool("golden-inventory-pool", "INVENTORY")]),
    shortageTreatment: "reject" as const,
  });
  const allocation: AccountingPolicy = Object.freeze({
    id: policyId("golden-allocation"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("allocationSchedule", "straightLine"),
    kind: "allocationSchedule" as const, method: "straightLine" as const, frequency: "monthly" as const, convention: "fullPeriod" as const,
    allocationAccountId: account("ALLOCATION"), contraAccountId: account("CONTRA"),
  });
  const consolidation: AccountingPolicy = Object.freeze({
    id: policyId("golden-consolidation"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("consolidation", "full"),
    kind: "consolidation" as const, supportedMethods: Object.freeze(["full"] as const),
    accountMappings: Object.freeze([consolidationMapping("golden-map-cash", "SOURCE-CASH", "GROUP-CASH"), consolidationMapping("golden-map-equity", "SOURCE-EQUITY", "GROUP-EQUITY")]),
    translationRules: Object.freeze([translationRule("golden-translate-cash", "SOURCE-CASH", "GROUP-CASH"), translationRule("golden-translate-equity", "SOURCE-EQUITY", "GROUP-EQUITY")]),
    valuationPolicy: consolidationValuationPolicy("golden-consolidation-valuation"),
    translationAdjustmentAccountId: account("GROUP-CTA"), parentAttributableEquityAccountId: account("GROUP-EQUITY"), nonControllingInterestAccountId: account("GROUP-NCI"),
  });
  return [tax, allocation, inventory, consolidation];
}

function buildBook(): { state: BookState; protocol: BookProtocolState } {
  const state = createBookState(identity, buildFiscalPeriods(), {
    bookId: IDS.book, functionalCommodityId: IDS.usd,
    accounts: [IDS.cash, IDS.revenue, account("EXPENSE"), account("AP"), account("TAX-PAYABLE"), account("INPUT-TAX"), account("ALLOCATION"), account("CONTRA"), account("INVENTORY"), account("COGS"), account("GROUP-CASH"), account("GROUP-EQUITY"), account("GROUP-CTA"), account("GROUP-NCI")].map((id, index) =>
      Object.freeze({ id, bookId: IDS.book, code: `${6000 + index}`, name: id, role: id === IDS.revenue ? ("income" as const) : ("asset" as const), normalSide: id === IDS.revenue ? ("credit" as const) : ("debit" as const), postingAllowed: true, openedOn: localDate("2026-01-01"), allowedCommodityIds: Object.freeze([]) })),
    dimensions: Object.freeze([]), dimensionMembers: Object.freeze([]), requiredDimensionIds: Object.freeze([]),
  }, [policy], [quantizationPolicy], goldenAccountingPolicies(), instant("2026-01-01T00:00:00Z"));
  const active = executeBookCommand(state, createBookProtocolState(), sealCommand({
    ...coreCommand(state, "golden-activate", "2026-01-01T14:00:00Z"), ...activationCommand("golden-activate"),
  } as never));
  if (active.result.disposition !== "committed") throw new Error(`Activation failed: ${active.result.diagnostics[0]?.message}`);
  return { state: active.state, protocol: active.protocol };
}

function coreCommand(state: BookState, id: string, at: string) {
  return { id: identifier<"BookCommand">(id), protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book, expectedBookRevision: state.bookRevision, issuedAt: instant(at), completedAt: instant(at), committedAt: instant(at), actorId: IDS.actor };
}

function run(state: BookState, protocol: BookProtocolState, command: ReturnType<typeof sealCommand>): AtomicCommit {
  const result = executeBookCommand(state, protocol, command as never);
  if (result.result.disposition !== "committed") throw new Error(`${String((command as never as { id: string }).id)} rejected: ${result.result.diagnostics[0]?.message}`);
  return result as AtomicCommit;
}
type AtomicCommit = ReturnType<typeof executeBookCommand>;

function monthJournal(monthIndex: number, kind: "revenue" | "expense", day: number): JournalTransaction {
  const year = 2026 + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const monthText = String(month).padStart(2, "0");
  const date = `${year}-${monthText}-${String(day).padStart(2, "0")}`;
  const amount = (kind === "revenue" ? 1_000 + monthIndex : 250 + (monthIndex % 7) * 10);
  const debitAccount = kind === "revenue" ? IDS.cash : account("EXPENSE");
  const creditAccount = kind === "revenue" ? IDS.revenue : IDS.cash;
  return Object.freeze({
    id: journalId(`golden-${kind}-${year}-${monthText}-${day}`), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
    economicAt: instant(`${date}T12:00:00Z`), accountingDate: localDate(date), recordedAt: instant(`${date}T13:00:00Z`), narration: `Golden ${kind}`,
    postings: Object.freeze([
      Object.freeze({ id: postingId(`golden-${kind}-${date}-debit`), ordinal: 1n, accountId: debitAccount, units: Object.freeze({ canonicalNumber: ExactRational.of(BigInt(amount), 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(BigInt(amount) * 100n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: postingId(`golden-${kind}-${date}-credit`), ordinal: 2n, accountId: creditAccount, units: Object.freeze({ canonicalNumber: ExactRational.of(-BigInt(amount), 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-BigInt(amount) * 100n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]),
  });
}

describe("ten-year golden book operation", () => {
  const runDecade = (): { state: BookState; protocol: BookProtocolState; journals: number; closes: number; corrections: number } => {
    let { state, protocol } = buildBook();
    const journalHistory: JournalTransaction[] = [];
    let commandOrdinal = 0;

    for (let monthIndex = 0; monthIndex < YEARS * MONTHS_PER_YEAR; monthIndex += 1) {
      const year = 2026 + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;

      for (const kind of ["revenue", "expense"] as const) {
        commandOrdinal += 1;
        const transaction = monthJournal(monthIndex, kind, 5 + (kind === "expense" ? 1 : 0));
        journalHistory.push(transaction);
        const posted = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-cmd-${commandOrdinal}`, `${date(year, month, kind === "revenue" ? 5 : 6)}T14:00:00Z`),
          type: "postJournal" as const, resolved: resolved(transaction),
        } as never));
        state = posted.state;
        protocol = posted.protocol;
      }

      if (month % 3 === 0) {
        commandOrdinal += 1;
        const taxCommit = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-tax-cmd-${commandOrdinal}`, `${date(year, month, 20)}T14:00:00Z`),
          type: "postTaxedTransaction" as const,
          request: {
            id: identifier<"TaxDetermination">(`golden-tax-${year}-${month}`), sourceTransactionId: identifier<"JournalTransaction">(`golden-tax-${year}-${month}-source`),
            governedAt: instant(`${date(year, month, 20)}T12:00:00Z`), direction: "purchase" as const,
            lines: Object.freeze([
              { lineId: `LINE-A-${year}-${month}`, sourcePostingId: identifier<"Posting">(`golden-tax-${year}-${month}-p1`), counterpartyPostingId: identifier<"Posting">(`golden-tax-${year}-${month}-p2`), policyId: policyId("golden-tax"), policyVersion: semanticVersion("1.0.0"), statedAmount: ExactRational.of(100n, 1n), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") },
              { lineId: `LINE-B-${year}-${month}`, sourcePostingId: identifier<"Posting">(`golden-tax-${year}-${month}-p3`), counterpartyPostingId: identifier<"Posting">(`golden-tax-${year}-${month}-p4`), policyId: policyId("golden-tax"), policyVersion: semanticVersion("1.0.0"), statedAmount: ExactRational.of(50n, 1n), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") },
            ]),
            derivation: accountingDerivation,
          },
        } as never));
        state = taxCommit.state;
        protocol = taxCommit.protocol;
      }

      if (month === 6) {
        commandOrdinal += 1;
        const original = journalHistory[journalHistory.length - 1]!;
        const reversal = Object.freeze({ ...original, id: journalId(`golden-reversal-${year}`), kind: "reversing" as const, postings: Object.freeze(original.postings.map((posting, postingOrdinal) => Object.freeze({ ...posting, id: postingId(`golden-reversal-${year}-p${postingOrdinal + 1}`), units: Object.freeze({ canonicalNumber: posting.units.canonicalNumber.negate(), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: posting.bookValue.amount.negate(), functionalCommodityId: IDS.usd }) }))) });
        const corrected = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-cmd-${commandOrdinal}`, `${date(year, 6, 30)}T14:00:00Z`),
          type: "correctJournal" as const, correctionKind: "reversal" as const, originalJournalId: original.id,
          resolved: Object.freeze({ ...resolved(reversal), derivations: Object.freeze([accountingDerivation]) }),
        } as never));
        state = corrected.state;
        protocol = corrected.protocol;
      }

      if (month === 6) {
        // Annual pre-payment allocation schedule (recognitions follow in their own months).
        const prepayment = Object.freeze({
          id: journalId(`golden-allocation-source-${year}`), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
          economicAt: instant(`${date(year, 6, 30)}T10:00:00Z`), accountingDate: localDate(`${year}-06-30`), recordedAt: instant(`${date(year, 6, 30)}T11:00:00Z`), narration: `Golden annual prepayment ${year}`,
          postings: Object.freeze([
            Object.freeze({ id: postingId(`golden-allocation-${year}-source`), ordinal: 1n, accountId: account("ALLOCATION"), units: Object.freeze({ canonicalNumber: ExactRational.of(120n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(12_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
            Object.freeze({ id: postingId(`golden-allocation-${year}-payable`), ordinal: 2n, accountId: account("AP"), units: Object.freeze({ canonicalNumber: ExactRational.of(-120n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-12_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
          ]),
        });
        const prepaymentCommandId = `golden-allocation-source-cmd-${year}`;
        const prepaymentCommitted = run(state, protocol, sealCommand({
          ...coreCommand(state, prepaymentCommandId, `${date(year, 6, 30)}T15:00:00Z`),
          type: "postJournal" as const, resolved: resolved(prepayment),
        } as never));
        state = prepaymentCommitted.state;
        protocol = prepaymentCommitted.protocol;
        const allocationScheduleCommitted = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-allocation-${year}`, `${date(year, 6, 30)}T16:00:00Z`),
          type: "createAllocationSchedule" as const,
          request: {
            id: identifier<"AllocationSchedule">(`golden-schedule-${year}`), policyId: policyId("golden-allocation"), policyVersion: semanticVersion("1.0.0"),
            governedAt: instant(`${date(year, 6, 30)}T15:00:00Z`), source: postingReference(prepayment, `${prepaymentCommandId}:journal:0`),
            sourceBasis: ExactRational.of(120n, 1n), residualValue: ExactRational.zero(),
            startsOn: localDate(`${year}-07-01`), endsOn: localDate(`${year}-12-31`), derivation: accountingDerivation,
          },
        } as never));
        state = allocationScheduleCommitted.state;
        protocol = allocationScheduleCommitted.protocol;
      }
      if (month === 8) {
        // Two differently priced layers make FIFO observable: issue all 6 older units
        // and 2 of the 4 newer units, leaving exactly 2 units / $30 of the newer lot.
        const firstAcquirePosting = identifier<"Posting">(`golden-inventory-${year}-acquire-first`);
        const secondAcquirePosting = identifier<"Posting">(`golden-inventory-${year}-acquire-second`);
        const firstLotId = identifier<"Lot">(`golden-lot-${year}-first`);
        const secondLotId = identifier<"Lot">(`golden-lot-${year}-second`);
        const firstHoldingId = identifier<"LotHolding">(`golden-holding-${year}-first`);
        const secondHoldingId = identifier<"LotHolding">(`golden-holding-${year}-second`);
        const acquisition = Object.freeze({
          id: journalId(`golden-inventory-acquire-${year}`), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
          economicAt: instant(`${date(year, 8, 10)}T12:00:00Z`), accountingDate: localDate(`${year}-08-10`), recordedAt: instant(`${date(year, 8, 10)}T13:00:00Z`), narration: `Golden inventory acquire ${year}`,
          postings: Object.freeze([
            Object.freeze({ id: firstAcquirePosting, ordinal: 1n, accountId: account("INVENTORY"), units: Object.freeze({ canonicalNumber: ExactRational.of(6n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(600n, 1n), functionalCommodityId: IDS.usd }), costBasis: Object.freeze({ totalBasis: ExactRational.of(60n, 1n), basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
            Object.freeze({ id: secondAcquirePosting, ordinal: 2n, accountId: account("INVENTORY"), units: Object.freeze({ canonicalNumber: ExactRational.of(4n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(600n, 1n), functionalCommodityId: IDS.usd }), costBasis: Object.freeze({ totalBasis: ExactRational.of(60n, 1n), basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
            Object.freeze({ id: identifier<"Posting">(`golden-inventory-${year}-ap`), ordinal: 3n, accountId: account("AP"), units: Object.freeze({ canonicalNumber: ExactRational.of(-120n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-1_200n, 1n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
          ]),
        });
        const acquire = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-inventory-acquire-cmd-${year}`, `${date(year, 8, 10)}T14:00:00Z`),
          type: "postJournal" as const, resolved: resolved(acquisition),
          lotOperations: [
            { type: "acquire", journalPostingId: firstAcquirePosting, lot: { id: firstLotId, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant(`${date(year, 8, 10)}T12:00:00Z`), acquisitionQuantity: ExactRational.of(6n, 1n), acquisitionTotalBasis: ExactRational.of(60n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) }, holding: { id: firstHoldingId, bookId: IDS.book, lotId: firstLotId, accountId: account("INVENTORY"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(6n, 1n), remainingTotalBasis: ExactRational.of(60n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(60n, 1n) } },
            { type: "acquire", journalPostingId: secondAcquirePosting, lot: { id: secondLotId, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant(`${date(year, 8, 12)}T12:00:00Z`), acquisitionQuantity: ExactRational.of(4n, 1n), acquisitionTotalBasis: ExactRational.of(60n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) }, holding: { id: secondHoldingId, bookId: IDS.book, lotId: secondLotId, accountId: account("INVENTORY"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(4n, 1n), remainingTotalBasis: ExactRational.of(60n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(60n, 1n) } },
          ],
        } as never));
        state = acquire.state;
        protocol = acquire.protocol;
        const inventoryDerivation = Object.freeze({ ...accountingDerivation, policyId: policyId("golden-inventory"), policyVersion: semanticVersion("1.0.0") });
        const inventoryLayers = state.lotHoldings.filter((holding) => !holding.remainingQuantity.isZero()).map((holding) => {
          const lot = state.lots.find((candidate) => candidate.id === holding.lotId)!;
          return { id: holding.id, accountId: holding.accountId, acquiredAt: lot.acquiredAt, quantity: holding.remainingQuantity, totalBasis: holding.remainingTotalBasis };
        });
        const fifoHoldings = [...inventoryLayers].sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.id.localeCompare(right.id));
        const selectedHoldingIds: Array<typeof firstHoldingId> = [];
        let quantityToSelect = ExactRational.of(8n, 1n);
        for (const layer of fifoHoldings) {
          if (quantityToSelect.isZero()) break;
          selectedHoldingIds.push(layer.id);
          quantityToSelect = quantityToSelect.subtract(layer.quantity.compare(quantityToSelect) < 0 ? layer.quantity : quantityToSelect);
        }
        const issue = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-inventory-issue-cmd-${year}`, `${date(year, 8, 20)}T14:00:00Z`),
          type: "postInventoryTransaction" as const,
          request: { policyId: policyId("golden-inventory"), policyVersion: semanticVersion("1.0.0"), governedAt: instant(`${date(year, 8, 20)}T12:00:00Z`), quantity: ExactRational.of(8n, 1n), layers: inventoryLayers },
          inventoryAccountId: account("INVENTORY"), costAccountId: account("COGS"), inventoryCommodityId: IDS.usd,
          derivation: inventoryDerivation,
          lotOperations: [{ type: "dispose", holdingIds: selectedHoldingIds, requestedQuantity: ExactRational.of(8n, 1n), selection: { method: "fifo" }, derivation: inventoryDerivation, identities: selectedHoldingIds.map((holdingId, index) => ({ holdingId, allocationId: identifier<"LotAllocation">(`golden-allocation-${year}-${index + 1}`) })), journalPostingId: identifier<"Posting">(`golden-inventory-issue-cmd-${year}-inventory`) }],
        } as never));
        state = issue.state;
        protocol = issue.protocol;
      }

      if (month >= 7) {
        const ordinal = BigInt(month - 6);
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const recognition = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-allocation-rec-${year}-${ordinal}`, `${date(year, month, lastDay)}T14:00:00Z`),
          type: "recognizeScheduledAllocation" as const,
          request: {
            id: identifier<"AllocationRecognition">(`golden-schedule-rec-${year}-${ordinal}`), scheduleId: identifier<"AllocationSchedule">(`golden-schedule-${year}`),
            ordinal, governedAt: instant(`${date(year, month, lastDay)}T12:00:00Z`), derivation: accountingDerivation,
          },
        } as never));
        state = recognition.state;
        protocol = recognition.protocol;
      }

      if (month === 12) {
        const sourcePopulationHash = hashCanonical({ source: `golden-source-${year}`, revision: 12n, postingSequence: 24n });
        const consolidationDerivation = Object.freeze({ ...accountingDerivation, policyId: policyId("golden-consolidation"), policyVersion: semanticVersion("1.0.0") });
        const consolidated = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-consolidation-cmd-${year}`, `${year}-12-31T20:00:00Z`),
          type: "compileConsolidation" as const,
          request: {
            id: consolidationCompilationId(`golden-consolidation-${year}`), policyId: policyId("golden-consolidation"), policyVersion: semanticVersion("1.0.0"),
            governedAt: instant(`${year}-12-31T19:00:00Z`), throughOn: localDate(`${year}-12-31`), targetBookId: IDS.book,
            sources: Object.freeze([{
              bookId: identifier<"Book">(`golden-source-${year}`), revision: 12n, postingSequence: 24n, populationHash: sourcePopulationHash,
              expectedRevision: 12n, expectedPostingSequence: 24n, expectedPopulationHash: sourcePopulationHash,
              relationshipId: `golden-control-${year}`, relationshipValidFrom: instant(`${year}-01-01T00:00:00Z`), control: "controlled" as const, method: "full" as const,
              ownershipShare: ExactRational.of(1n, 1n), votingShare: ExactRational.of(1n, 1n), controlEvidenceIds: Object.freeze([`golden-control-evidence-${year}`]),
              balances: Object.freeze([
                { sourceAccountId: account("SOURCE-CASH"), unitsCommodityId: IDS.usd, classification: "asset" as const, amount: ExactRational.of(BigInt(10_000 + year), 1n), valuationPaths: Object.freeze([]) },
                { sourceAccountId: account("SOURCE-EQUITY"), unitsCommodityId: IDS.usd, classification: "equity" as const, amount: ExactRational.of(BigInt(-(10_000 + year)), 1n), valuationPaths: Object.freeze([]) },
              ]),
            }]), eliminations: Object.freeze([]), derivation: consolidationDerivation,
          },
        } as never));
        state = consolidated.state;
        protocol = consolidated.protocol;

        commandOrdinal += 1;
        const periodId = identifier<"FiscalPeriod">(`golden-${year}-12`);
        const closed = run(state, protocol, sealCommand({
          ...coreCommand(state, `golden-close-${year}`, `${year}-12-31T23:00:00Z`),
          type: "closePeriod" as const, periodId, closePackageId: identifier<"ClosePackage">(`golden-close-package-${year}`),
          reason: `Annual close ${year}`, reportPopulationHash: hashCanonical({ year: String(year) }), reportingPolicySnapshotHash: hashCanonical({ policy: String(year) }),
        } as never));
        state = closed.state;
        protocol = closed.protocol;
      }
    }
    return { state, protocol, journals: state.journals.length, closes: state.periodTransitions.filter((transition) => transition.kind === "close").length, corrections: state.corrections.length };
  };

  test("runs a decade of monthly cycles, closes, corrections, and replays identically", () => {
    const first = runDecade();
    expect(first.journals).toBe(YEARS * MONTHS_PER_YEAR * 2 + YEARS + YEARS * 4 + YEARS * 6 + YEARS * 2 + YEARS + YEARS); // ordinary + reversals + tax + schedule sources/recognitions + inventory + consolidation
    expect(first.journals === 0 || first.state.journals.every((booked, index) => booked.postingSequence === BigInt(index + 1))).toBeTrue();
    expect(first.state.journals.every((booked) => booked.journal.postings.reduce((total, posting) => total.add(posting.bookValue.amount.toRational()), ExactRational.zero()).isZero())).toBeTrue();
    expect(first.closes).toBe(YEARS);
    expect(first.corrections).toBe(YEARS);
    expect(first.state.accountingState.taxDeterminations).toHaveLength(YEARS * 4);
    expect(first.state.accountingState.allocationSchedules).toHaveLength(YEARS);
    expect(first.state.accountingState.allocationRecognitions).toHaveLength(YEARS * 6);
    expect(first.state.accountingState.consolidationCompilations).toHaveLength(YEARS);
    expect(first.state.accountingState.allocationSchedules.every((schedule) => schedule.installments.length === 6 && schedule.installments.reduce((total, installment) => total.add(installment.amount), ExactRational.zero()).equals(schedule.sourceBasis.subtract(schedule.residualValue)))).toBeTrue();
    expect(first.state.lots).toHaveLength(YEARS * 2);
    expect(first.state.lotAllocations.length).toBeGreaterThanOrEqual(YEARS * 2);
    expect(first.state.lotAllocations.reduce((total, allocation) => total.add(allocation.allocation.allocatedQuantity), ExactRational.zero()).equals(ExactRational.of(BigInt(YEARS * 8), 1n))).toBeTrue();
    expect(first.state.lotAllocations.reduce((total, allocation) => total.add(allocation.allocation.allocatedTotalBasis), ExactRational.zero()).equals(ExactRational.of(960n, 1n))).toBeTrue();
    const firstYearAllocations = first.state.lotAllocations.filter((allocation) => allocation.allocation.id.startsWith("golden-allocation-2026-"));
    expect(firstYearAllocations.map((allocation) => allocation.allocation.allocatedQuantity.toString())).toEqual(["6/1", "2/1"]);
    expect(firstYearAllocations.map((allocation) => allocation.allocation.allocatedTotalBasis.toString())).toEqual(["60/1", "30/1"]);
    const remaining = first.state.lotHoldings.filter((holding) => !holding.remainingQuantity.isZero());
    expect(remaining.reduce((total, holding) => total.add(holding.remainingQuantity), ExactRational.zero()).equals(ExactRational.of(20n, 1n))).toBeTrue();
    expect(remaining.reduce((total, holding) => total.add(holding.remainingTotalBasis), ExactRational.zero()).equals(ExactRational.of(240n, 1n))).toBeTrue();

    const second = runDecade();
    expect(hashBookState(second.state).digest).toBe(hashBookState(first.state).digest);

    expect(validateBookState(first.state)).toEqual([]);
    const decoded = decodeDurableBook(encodeDurableBook({ state: first.state, protocol: first.protocol }));
    expect(decoded.disposition, decoded.disposition === "rejected" ? decoded.message : "").toBe("decoded");
  }, 240_000);
});

function date(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
